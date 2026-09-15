/**
 * oxfmt on a file its own config ignores (#1844 review F1).
 *
 * `oxfmtFormatter.detect` returns true as soon as an oxfmt config exists
 * anywhere above the file, and `oxfmtFormatter.extensions` spreads the whole of
 * `OXFMT_SUPPORTED_EXTENSIONS` — .md, .json, .yaml, .css and the rest. So in any
 * project whose oxfmt config carries `ignorePatterns`, pi-lens selects oxfmt for
 * files oxfmt then refuses to touch.
 *
 * Given nothing to do, oxfmt 0.64.0 exits 2 with "Expected at least one target
 * file. All matched files may have been excluded by ignore rules." Under the
 * #1337 strict default, `formatFile` reads that as a formatting failure and the
 * user sees an error on every edit to an ignored file.
 *
 * This is the same class as the biome case pinned in
 * `formatter-exit-code-posture.test.ts` ("passes --no-errors-on-unmatched on
 * every biome command path"), and it takes the same shape of fix: oxfmt's
 * `--no-error-on-unmatched-pattern` turns the empty target set into a clean
 * exit 0 while leaving every other nonzero exit strict.
 *
 * The tests below run the REAL oxfmt binary from node_modules, so they pin the
 * tool's contract and not a mock of it. A future oxfmt that changes either
 * behavior reds here rather than in production.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	formatFile,
	getFormattersForFile,
	oxfmtFormatter,
} from "../../../clients/formatters.js";
import { setupTestEnvironment } from "../test-utils.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);
const OXFMT_BIN = path.join(REPO_ROOT, "node_modules", "oxfmt", "bin", "oxfmt");

/**
 * Fail loudly rather than skip. oxfmt is a devDependency of this repository, so
 * an absent binary means the install is broken, and a silently-skipped test
 * would let the regression back in unseen.
 */
function requireOxfmtBinary(): string {
	if (!fs.existsSync(OXFMT_BIN)) {
		throw new Error(
			`oxfmt binary not found at ${OXFMT_BIN}. It is a devDependency; run npm install.`,
		);
	}
	return OXFMT_BIN;
}

/**
 * Plant a node_modules/.bin/oxfmt in the temp project that re-execs the real
 * binary. `findInNodeModules` walks up from the file's directory, so this is
 * what makes `resolveCommand` pick the local branch deterministically instead
 * of depending on whatever `oxfmt` happens to be on PATH.
 */
function plantLocalOxfmt(projectDir: string): void {
	const bin = requireOxfmtBinary();
	const binDir = path.join(projectDir, "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(
		path.join(binDir, "oxfmt"),
		`#!/bin/sh\nexec node ${JSON.stringify(bin)} "$@"\n`,
		{ mode: 0o755 },
	);
	// findInNodeModules prefers the .cmd on win32.
	fs.writeFileSync(
		path.join(binDir, "oxfmt.cmd"),
		`@ECHO off\r\nnode "${bin}" %*\r\n`,
	);
}

function writeProject(projectDir: string): void {
	// #3005 fixture recurrence: real formatter behavior must be tested after
	// independent project agreement, not short-circuited as unavailable.
	fs.writeFileSync(
		path.join(projectDir, "package.json"),
		JSON.stringify({ devDependencies: { oxfmt: "0.66.0" } }),
	);
	fs.writeFileSync(
		path.join(projectDir, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: { "": {}, "node_modules/oxfmt": { version: "0.66.0" } },
		}),
	);
	fs.writeFileSync(
		path.join(projectDir, ".oxfmtrc.json"),
		JSON.stringify({ useTabs: true, ignorePatterns: ["**/*.md"] }),
	);
	plantLocalOxfmt(projectDir);
}

describe("oxfmt on an ignored file is a no-op, not a failure (#1844 F1)", () => {
	it("the real oxfmt exits 2 on an ignored path and 0 with --no-error-on-unmatched-pattern", () => {
		const bin = requireOxfmtBinary();
		const env = setupTestEnvironment("pi-lens-oxfmt-ignored-contract-");
		try {
			writeProject(env.tmpDir);
			const target = path.join(env.tmpDir, "README.md");
			fs.writeFileSync(target, "#  Title\n");

			// Without the flag: exit 2, and the message names the ignore rules.
			let status = 0;
			let stderr = "";
			try {
				execFileSync(process.execPath, [bin, target], {
					cwd: env.tmpDir,
					encoding: "utf-8",
				});
			} catch (err) {
				const e = err as { status?: number; stderr?: string };
				status = e.status ?? 0;
				stderr = e.stderr ?? "";
			}
			expect(status).toBe(2);
			expect(stderr).toContain("Expected at least one target file");
			expect(stderr).toContain("excluded by ignore rules");

			// With the flag: clean exit, file untouched.
			const before = fs.readFileSync(target, "utf-8");
			execFileSync(
				process.execPath,
				[bin, "--no-error-on-unmatched-pattern", target],
				{ cwd: env.tmpDir, encoding: "utf-8" },
			);
			expect(fs.readFileSync(target, "utf-8")).toBe(before);
		} finally {
			env.cleanup();
		}
	});

	// THE RED-PROOF. Pre-fix this returns { success: false, error: "Expected at
	// least one target file..." } because resolveCommand omitted the flag.
	it("formatFile reports a clean no-op for a file the oxfmt config ignores", async () => {
		const env = setupTestEnvironment("pi-lens-oxfmt-ignored-seam-");
		try {
			writeProject(env.tmpDir);
			const target = path.join(env.tmpDir, "README.md");
			const before = "#  Title\n";
			fs.writeFileSync(target, before);

			// Through the production selection seam, not a hand-picked definition:
			// this also pins that oxfmt really is offered for an ignored .md.
			const formatters = await getFormattersForFile(target, env.tmpDir);
			expect(formatters.map((f) => f.name)).toContain("oxfmt");

			const result = await formatFile(target, oxfmtFormatter);

			expect(result.error).toBeUndefined();
			expect(result.success).toBe(true);
			expect(result.changed).toBe(false);
			// The file is genuinely untouched, so "no-op" is not a story told
			// about a rewrite that happened anyway.
			expect(fs.readFileSync(target, "utf-8")).toBe(before);
		} finally {
			env.cleanup();
		}
	});

	// MUTATION GUARD. Deleting the flag from any resolveCommand branch must red
	// something; this is that something, and it is independent of whether the
	// binary is installed.
	it("every oxfmt command path carries the flag, ahead of the file path", async () => {
		expect(oxfmtFormatter.command).toContain("--no-error-on-unmatched-pattern");

		const env = setupTestEnvironment("pi-lens-oxfmt-cmd-shape-");
		try {
			writeProject(env.tmpDir);
			const target = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(target, "const a = 1;\n");

			const resolved = await oxfmtFormatter.resolveCommand?.(
				target,
				env.tmpDir,
			);
			expect(Array.isArray(resolved)).toBe(true);
			const args = resolved as string[];
			expect(args).toContain("--no-error-on-unmatched-pattern");
			expect(args.indexOf("--no-error-on-unmatched-pattern")).toBeLessThan(
				args.indexOf(target),
			);
		} finally {
			env.cleanup();
		}
	});

	// The local-node_modules branch is the one the tests above exercise, because
	// `plantLocalOxfmt` makes `findInNodeModules` win. This covers the OTHER
	// runtime branch, oxfmt found on PATH, which a mutation that strips the flag
	// from only that line would otherwise slip past.
	it("carries the flag on the PATH-resolved branch too", async () => {
		const bin = requireOxfmtBinary();
		const env = setupTestEnvironment("pi-lens-oxfmt-which-");
		const originalPath = process.env.PATH;
		try {
			// No node_modules in this project, so resolveCommand must fall through
			// findInNodeModules to which().
			const shimDir = path.join(env.tmpDir, "shim");
			fs.mkdirSync(shimDir, { recursive: true });
			fs.writeFileSync(
				path.join(shimDir, "oxfmt"),
				`#!/bin/sh\nexec node ${JSON.stringify(bin)} "$@"\n`,
				{ mode: 0o755 },
			);
			fs.writeFileSync(
				path.join(shimDir, "oxfmt.cmd"),
				`@ECHO off\r\nnode "${bin}" %*\r\n`,
			);
			process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;

			// which() memoizes per process, so take a fresh module instance rather
			// than inherit a latch another test already filled in.
			vi.resetModules();
			const fresh = await import("../../../clients/formatters.js");

			const target = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(target, "const a = 1;\n");

			const resolved = await fresh.oxfmtFormatter.resolveCommand?.(
				target,
				env.tmpDir,
			);
			expect(Array.isArray(resolved)).toBe(true);
			const args = resolved as string[];
			expect(args[0]).not.toContain("node_modules");
			expect(args).toContain("--no-error-on-unmatched-pattern");
			expect(args.indexOf("--no-error-on-unmatched-pattern")).toBeLessThan(
				args.indexOf(target),
			);
		} finally {
			process.env.PATH = originalPath;
			vi.resetModules();
			env.cleanup();
		}
	});

	// The flag must not become a blanket amnesty. A real oxfmt failure — a file
	// it cannot parse — still exits 2 WITH the flag, so the #1337 strict posture
	// survives for everything except an empty target set.
	it("keeps the strict posture: a parse error still fails with the flag set", async () => {
		const env = setupTestEnvironment("pi-lens-oxfmt-strict-");
		try {
			writeProject(env.tmpDir);
			const target = path.join(env.tmpDir, "broken.ts");
			fs.writeFileSync(target, "const x = = = ;\n");

			const result = await formatFile(target, oxfmtFormatter);

			expect(result.success).toBe(false);
			expect(result.changed).toBe(false);
			expect(result.error).toBeTruthy();
		} finally {
			env.cleanup();
		}
	});

	// A file oxfmt DOES handle must still be rewritten. Without this, "the flag
	// makes everything exit 0" would pass the three tests above.
	it("still formats a file the config does not ignore", async () => {
		const env = setupTestEnvironment("pi-lens-oxfmt-still-formats-");
		try {
			writeProject(env.tmpDir);
			const target = path.join(env.tmpDir, "messy.ts");
			fs.writeFileSync(target, "const   y={a:1}\n");

			const result = await formatFile(target, oxfmtFormatter);

			expect(result.success).toBe(true);
			expect(result.changed).toBe(true);
			expect(fs.readFileSync(target, "utf-8")).toBe("const y = { a: 1 };\n");
		} finally {
			env.cleanup();
		}
	});
});
