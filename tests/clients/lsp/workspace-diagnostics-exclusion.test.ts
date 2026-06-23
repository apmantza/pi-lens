/**
 * Exclusion + cap guards for the LSP workspace-diagnostics file walk (#243, #250).
 *
 * The walk (`runWorkspaceDiagnostics` → `collectWorkspaceDiagnosticFiles`) used to
 * filter directories through its own hardcoded skip-dir set, which silently
 * dropped a project's `.pi-lens.json` `"ignore": [...]` patterns and diverged
 * from the canonical `isExcludedDirName` list — the root cause of "excludes
 * don't work" reports (#243). It also had no file cap, so a misrooted run could
 * enumerate an entire home tree (#250). These tests lock in:
 *   - default dependency/build dirs are excluded (via isExcludedDirName)
 *   - project `.pi-lens.json` ignore patterns are honored
 *   - the walk is hard-capped
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __collectWorkspaceDiagnosticFilesForTest } from "../../../clients/lsp/index.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-wsdiag-exclude-"));
	// Anchor the ignore matcher's git-root resolution AT tmpDir so the walk is
	// deterministic regardless of whether the OS tmpdir happens to sit under a
	// stray `.git` ancestor (the `TMPDIR=/var/tmp` gotcha from PR #299).
	fs.mkdirSync(path.join(tmpDir, ".git"));
	resetProjectLensConfigCache();
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	resetProjectLensConfigCache();
});

function write(rel: string, body = "export const x = 1;\n"): void {
	const full = path.join(tmpDir, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, body);
}

function relUnix(files: string[]): string[] {
	return files.map((f) => path.relative(tmpDir, f).replace(/\\/g, "/"));
}

describe("LSP workspace-diagnostics exclusion (#243)", () => {
	it("excludes default dependency/build dirs via the canonical list", async () => {
		write("src/real.ts");
		write("node_modules/dep/index.ts");
		write("dist/out.ts");

		const rel = relUnix(await __collectWorkspaceDiagnosticFilesForTest(tmpDir));
		expect(rel).toContain("src/real.ts");
		expect(rel.some((f) => f.includes("node_modules/"))).toBe(false);
		expect(rel.some((f) => f.startsWith("dist/"))).toBe(false);
	});

	it("excludes agent runtime and vendored source dirs via the canonical list", async () => {
		write("src/real.ts");
		for (const dir of [
			".claude/worktrees/session",
			".codex",
			".pi/agent",
			".agents",
			".worktrees/branch",
			".pi-lens/cache",
			"vendor/lib",
			"third_party/lib",
			"third-party/lib",
		]) {
			write(`${dir}/ignored.ts`);
		}

		const rel = relUnix(await __collectWorkspaceDiagnosticFilesForTest(tmpDir));
		expect(rel).toContain("src/real.ts");
		for (const prefix of [
			".claude/",
			".codex/",
			".pi/",
			".agents/",
			".worktrees/",
			".pi-lens/",
			"vendor/",
			"third_party/",
			"third-party/",
		]) {
			expect(rel.some((f) => f.startsWith(prefix))).toBe(false);
		}
	});

	it("honors .pi-lens.json ignore patterns (the #243 fix)", async () => {
		fs.writeFileSync(
			path.join(tmpDir, ".pi-lens.json"),
			JSON.stringify({ ignore: ["generated/**", "noise.ts"] }),
		);
		write("src/real.ts");
		write("generated/out.ts");
		write("noise.ts");

		const rel = relUnix(await __collectWorkspaceDiagnosticFilesForTest(tmpDir));
		expect(rel).toContain("src/real.ts");
		expect(rel.some((f) => f.startsWith("generated/"))).toBe(false);
		expect(rel).not.toContain("noise.ts");
	});

	it("honors .gitignore patterns too", async () => {
		fs.writeFileSync(path.join(tmpDir, ".gitignore"), "gitignored/\n");
		write("src/real.ts");
		write("gitignored/x.ts");

		const rel = relUnix(await __collectWorkspaceDiagnosticFilesForTest(tmpDir));
		expect(rel).toContain("src/real.ts");
		expect(rel.some((f) => f.startsWith("gitignored/"))).toBe(false);
	});
});

describe("LSP workspace-diagnostics cap (#250)", () => {
	it("stops at maxFiles", async () => {
		for (let i = 0; i < 30; i++) write(`src/f${i}.ts`);

		const uncapped = await __collectWorkspaceDiagnosticFilesForTest(tmpDir);
		expect(uncapped.length).toBeGreaterThan(5);

		const capped = await __collectWorkspaceDiagnosticFilesForTest(tmpDir, 5);
		expect(capped.length).toBe(5);
	});
});
