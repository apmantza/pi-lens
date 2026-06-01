/**
 * Regression test for #123:
 * TypeScript LSP silently fails for files under `.pi/agent/extensions/` when
 * the nearest project marker walking up sits OUTSIDE the extensions directory
 * (e.g. a higher-up `~/.pi/agent/package.json` from pi itself).
 *
 * Before the fix, TypeScriptRoot returned `undefined` in that case and the
 * LSP service never spawned a server. After the fix it must return a valid
 * directory so the LSP starts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LSP_SERVERS } from "../../../clients/lsp/server.js";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir && fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

function makeFakeExtensionsTree(opts: {
	parentPackageJson: boolean;
	extensionPackageJson: boolean;
}): { extFile: string; extDir: string; agentDir: string } {
	// Build .../<tmp>/.pi/agent/extensions/myext/src/index.ts inside a tmp dir
	// so we don't touch the user's real ~/.pi/agent/extensions.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ext-root-"));
	tmpDirs.push(tmp);
	const agentDir = path.join(tmp, ".pi", "agent");
	const extensionsDir = path.join(agentDir, "extensions");
	const extDir = path.join(extensionsDir, "myext");
	const srcDir = path.join(extDir, "src");
	fs.mkdirSync(srcDir, { recursive: true });
	const extFile = path.join(srcDir, "index.ts");
	fs.writeFileSync(extFile, "export const x = 1;\n");
	if (opts.parentPackageJson) {
		fs.writeFileSync(
			path.join(agentDir, "package.json"),
			'{"name":"pi-agent"}',
		);
	}
	if (opts.extensionPackageJson) {
		fs.writeFileSync(
			path.join(extDir, "package.json"),
			'{"name":"my-extension"}',
		);
	}
	return { extFile, extDir, agentDir };
}

function getTypeScriptServer() {
	const server = LSP_SERVERS.find((s) => s.id === "typescript");
	if (!server) throw new Error("typescript server not found in LSP_SERVERS");
	return server;
}

describe("TypeScriptRoot — extension files (#123)", () => {
	it("uses the extension's own directory when its package.json is present", async () => {
		const { extFile, extDir } = makeFakeExtensionsTree({
			parentPackageJson: false,
			extensionPackageJson: true,
		});
		const root = await getTypeScriptServer().root(extFile);
		// Resolve both paths for case-insensitive Windows comparison.
		expect(root && path.resolve(root)).toBe(path.resolve(extDir));
	});

	it("never returns undefined for extension files, even when the only package.json is above the extensions boundary", async () => {
		// The bug case: package.json exists at ~/.pi/agent/ (pi itself), but
		// not inside the extension. The unbounded walk found .pi/agent and
		// the outer "must be under extensionRootKey" check then rejected it,
		// producing undefined → no LSP. Now the bounded walk fails to find
		// a marker inside the extension and falls back to the file's dir.
		const { extFile } = makeFakeExtensionsTree({
			parentPackageJson: true,
			extensionPackageJson: false,
		});
		const root = await getTypeScriptServer().root(extFile);
		expect(root).toBeDefined();
		// The chosen root must NOT escape the extensions boundary — i.e. it
		// must contain `.pi/agent/extensions/` somewhere in its path so the
		// LSP doesn't workspace-scan all of pi.
		expect(
			path.resolve(root as string).replace(/\\/g, "/"),
		).toContain("/.pi/agent/extensions/");
	});
});
