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
import {
	LSP_SERVERS,
	resolveLspServerCwd,
} from "../../../clients/lsp/server.js";
import { realpathOrResolve } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

const tmpDirs: string[] = [];

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir && fs.existsSync(dir)) {
			removeTempDirSync(dir);
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
		expect(path.resolve(root as string).replace(/\\/g, "/")).toContain(
			"/.pi/agent/extensions/",
		);
	});
});

function writeAgentTsconfig(agentDir: string, name = "tsconfig.json"): void {
	fs.writeFileSync(
		path.join(agentDir, name),
		JSON.stringify({
			compilerOptions: { types: ["node"] },
			include: ["extensions/**/*.ts"],
		}),
	);
}

// #5335: an explicit `~/.pi/agent/tsconfig.json` is the user opting the
// extensions into one TypeScript project. The #123 fallback treated it like
// pi's own generic `package.json` and rooted every extension at its own
// directory, so the user's `types`/`paths` never reached the server.
describe("TypeScriptRoot — explicit agent-level tsconfig (#5335)", () => {
	const rootOf = async (file: string): Promise<string | undefined> => {
		const root = await getTypeScriptServer().root(file);
		return root && realpathOrResolve(root);
	};

	it("roots an extension with no project of its own at the agent tsconfig", async () => {
		const { extFile, agentDir } = makeFakeExtensionsTree({
			parentPackageJson: true,
			extensionPackageJson: false,
		});
		writeAgentTsconfig(agentDir);
		expect(await rootOf(extFile)).toBe(realpathOrResolve(agentDir));
	});

	it("does not need pi's package.json beside the agent tsconfig", async () => {
		const { extFile, agentDir } = makeFakeExtensionsTree({
			parentPackageJson: false,
			extensionPackageJson: false,
		});
		writeAgentTsconfig(agentDir);
		expect(await rootOf(extFile)).toBe(realpathOrResolve(agentDir));
	});

	it("keeps an extension-local package.json as the root over the agent tsconfig", async () => {
		const { extFile, extDir, agentDir } = makeFakeExtensionsTree({
			parentPackageJson: true,
			extensionPackageJson: true,
		});
		writeAgentTsconfig(agentDir);
		expect(await rootOf(extFile)).toBe(realpathOrResolve(extDir));
	});

	it("keeps an extension-local tsconfig as the root over the agent tsconfig", async () => {
		const { extFile, extDir, agentDir } = makeFakeExtensionsTree({
			parentPackageJson: true,
			extensionPackageJson: false,
		});
		writeAgentTsconfig(agentDir);
		writeAgentTsconfig(extDir);
		expect(await rootOf(extFile)).toBe(realpathOrResolve(extDir));
	});

	// RECURRENCE GUARDED: #123. The agent-level package.json alone must keep
	// the per-file scope, or every extension lands in one workspace.
	it("keeps the per-file fallback when the agent has only a package.json", async () => {
		const { extFile } = makeFakeExtensionsTree({
			parentPackageJson: true,
			extensionPackageJson: false,
		});
		expect(await rootOf(extFile)).toBe(
			realpathOrResolve(path.dirname(extFile)),
		);
	});

	it("skips a loose extension file when neither the extension nor the agent has a project", async () => {
		const { extFile } = makeFakeExtensionsTree({
			parentPackageJson: false,
			extensionPackageJson: false,
		});
		expect(await rootOf(extFile)).toBeUndefined();
	});

	// RECURRENCE GUARDED: an unbounded parent walk adopting a home project. Only
	// the parent of the extensions root is read; `~/.pi/tsconfig.json` and a
	// `~/tsconfig.json` above it never become the root.
	it("never adopts a tsconfig above the agent directory", async () => {
		const { extFile, agentDir } = makeFakeExtensionsTree({
			parentPackageJson: false,
			extensionPackageJson: false,
		});
		writeAgentTsconfig(path.dirname(agentDir));
		writeAgentTsconfig(path.dirname(path.dirname(agentDir)));
		expect(await rootOf(extFile)).toBeUndefined();
	});

	it("keeps the per-file fallback when only a tsconfig above the agent exists next to the agent package.json", async () => {
		const { extFile, agentDir } = makeFakeExtensionsTree({
			parentPackageJson: true,
			extensionPackageJson: false,
		});
		writeAgentTsconfig(path.dirname(agentDir));
		expect(await rootOf(extFile)).toBe(
			realpathOrResolve(path.dirname(extFile)),
		);
	});

	// RECURRENCE GUARDED: #1412 M3. tsserver associates jsconfig.json with JS
	// files only, so an agent jsconfig must not root a TypeScript file: it keeps
	// the #123 per-file fallback, which any agent marker already earned.
	it("roots a JavaScript extension file at an agent jsconfig but not a TypeScript one", async () => {
		const { extFile, agentDir } = makeFakeExtensionsTree({
			parentPackageJson: false,
			extensionPackageJson: false,
		});
		writeAgentTsconfig(agentDir, "jsconfig.json");
		const jsFile = path.join(path.dirname(extFile), "index.js");
		fs.writeFileSync(jsFile, "export const y = 1;\n");
		expect(await rootOf(extFile)).toBe(
			realpathOrResolve(path.dirname(extFile)),
		);
		expect(await rootOf(jsFile)).toBe(realpathOrResolve(agentDir));
	});

	// The decision rides the spelled path: `extensions/myext` is linked to a
	// checkout outside the agent directory and has no project marker. The agent
	// tsconfig governs the spelling the user opens, and the checkout's parent
	// project (`code/package.json`) is still never adopted (#4689).
	it("roots a linked extension with no project at the agent tsconfig, not at the checkout's parent", async (ctx) => {
		const { agentDir, extDir } = makeFakeExtensionsTree({
			parentPackageJson: true,
			extensionPackageJson: false,
		});
		writeAgentTsconfig(agentDir);
		const code = path.join(path.dirname(path.dirname(agentDir)), "code");
		const checkout = path.join(code, "myext");
		fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
		fs.writeFileSync(path.join(code, "package.json"), "{}\n");
		fs.writeFileSync(path.join(checkout, "src", "x.ts"), "export {};\n");
		fs.rmSync(extDir, { recursive: true });
		try {
			fs.symlinkSync(checkout, extDir, "dir");
		} catch (err) {
			return ctx.skip(`cannot create symlinks here: ${String(err)}`);
		}
		const file = path.join(extDir, "src", "x.ts");
		expect(await rootOf(file)).toBe(realpathOrResolve(agentDir));
	});

	// `~/.pi` kept in a dotfiles checkout and linked into home (#4689): the
	// root is the agent directory's identity, like the extension-local walk.
	it("returns the agent directory's identity when ~/.pi is a link", async (ctx) => {
		const { agentDir } = makeFakeExtensionsTree({
			parentPackageJson: false,
			extensionPackageJson: false,
		});
		const base = path.dirname(path.dirname(agentDir));
		const dotfiles = path.join(base, "dotfiles");
		fs.mkdirSync(dotfiles, { recursive: true });
		fs.renameSync(path.join(base, ".pi"), path.join(dotfiles, "pi"));
		try {
			fs.symlinkSync(path.join(dotfiles, "pi"), path.join(base, ".pi"), "dir");
		} catch (err) {
			return ctx.skip(`cannot create symlinks here: ${String(err)}`);
		}
		writeAgentTsconfig(path.join(dotfiles, "pi", "agent"));
		const file = path.join(
			base,
			".pi",
			"agent",
			"extensions",
			"myext",
			"src",
			"index.ts",
		);
		// Unfolded on purpose: the root is the identity, not the spelling.
		expect(await getTypeScriptServer().root(file)).toBe(
			realpathOrResolve(path.join(dotfiles, "pi", "agent")),
		);
	});

	// The root is a candidate only: a session whose cwd is the extension keeps
	// the cwd as the ceiling, exactly as for an extension-local root.
	it("leaves the session cwd as the ceiling for the agent tsconfig root", async () => {
		const { extFile, extDir, agentDir } = makeFakeExtensionsTree({
			parentPackageJson: false,
			extensionPackageJson: false,
		});
		writeAgentTsconfig(agentDir);
		const cwd = await resolveLspServerCwd(
			getTypeScriptServer(),
			extFile,
			extDir,
		);
		expect(cwd && realpathOrResolve(cwd)).toBe(realpathOrResolve(extDir));
	});
});
