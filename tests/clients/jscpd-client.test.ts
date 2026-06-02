import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync: vi.fn(async () => ({
		error: null,
		status: 0,
		stdout: "",
		stderr: "",
	})),
}));

describe("jscpd-client", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();
	});

	it("scans when source exists in nested directories", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-");
		try {
			const srcFile = path.join(tmpDir, "src", "feature", "index.ts");
			fs.mkdirSync(path.dirname(srcFile), { recursive: true });
			fs.writeFileSync(srcFile, "export const x = 1;\n");

			const client = new JscpdClient(false) as unknown as {
				scan: (
					cwd: string,
					minLines: number,
					minTokens: number,
					isTsProject: boolean,
				) => Promise<unknown>;
				available: boolean;
			};
			client.available = true;

			await client.scan(tmpDir, 5, 50, true);

			expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalled();
			const args =
				vi.mocked(safeSpawnMod.safeSpawnAsync).mock.calls[0]?.[1] ?? [];
			const ignoreIndex = args.indexOf("--ignore");
			expect(ignoreIndex).toBeGreaterThan(-1);
			const ignorePattern = String(args[ignoreIndex + 1] ?? "");
			expect(ignorePattern).toContain("**/.turbo/**");
			expect(ignorePattern).toContain("**/.cache/**");
			expect(ignorePattern).toContain("**/*.js");
		} finally {
			cleanup();
		}
	});

	it("does not scan when only excluded directories contain source files", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-");
		try {
			const excludedFile = path.join(tmpDir, "node_modules", "pkg", "index.ts");
			fs.mkdirSync(path.dirname(excludedFile), { recursive: true });
			fs.writeFileSync(excludedFile, "export const x = 1;\n");

			const client = new JscpdClient(false) as unknown as {
				scan: (
					cwd: string,
					minLines: number,
					minTokens: number,
					isTsProject: boolean,
				) => Promise<{
					success: boolean;
					clones: unknown[];
				}>;
				available: boolean;
			};
			client.available = true;

			const result = await client.scan(tmpDir, 5, 50, true);

			expect(result.success).toBe(true);
			expect(result.clones).toEqual([]);
			expect(safeSpawnMod.safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("does not scan when no source files exist", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-");
		try {
			fs.writeFileSync(path.join(tmpDir, "README.md"), "hello\n");

			const client = new JscpdClient(false) as unknown as {
				scan: (
					cwd: string,
					minLines: number,
					minTokens: number,
					isTsProject: boolean,
				) => Promise<{
					success: boolean;
					clones: unknown[];
				}>;
				available: boolean;
			};
			client.available = true;

			const result = await client.scan(tmpDir, 5, 50, true);

			expect(result.success).toBe(true);
			expect(result.clones).toEqual([]);
			expect(safeSpawnMod.safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	// #126 — language gate expanded beyond JS/TS

	for (const lang of [
		{ name: "Python", file: "main.py", body: "x = 1\n" },
		{ name: "Go", file: "main.go", body: "package main\n" },
		{ name: "Rust", file: "lib.rs", body: "pub fn x() {}\n" },
		{ name: "Java", file: "App.java", body: "class App {}\n" },
		{ name: "Ruby", file: "main.rb", body: "x = 1\n" },
		{ name: "PHP", file: "main.php", body: "<?php $x = 1;\n" },
		{ name: "Kotlin", file: "App.kt", body: "fun main() {}\n" },
		{ name: "Swift", file: "App.swift", body: "let x = 1\n" },
		{ name: "C++", file: "main.cpp", body: "int main() {}\n" },
		{ name: "C#", file: "App.cs", body: "class App {}\n" },
	]) {
		it(`scans when only ${lang.name} source files exist (#126)`, async () => {
			const { JscpdClient } = await import("../../clients/jscpd-client.js");
			const safeSpawnMod = await import("../../clients/safe-spawn.js");

			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-");
			try {
				const srcFile = path.join(tmpDir, "src", lang.file);
				fs.mkdirSync(path.dirname(srcFile), { recursive: true });
				fs.writeFileSync(srcFile, lang.body);

				const client = new JscpdClient(false) as unknown as {
					scan: (
						cwd: string,
						minLines: number,
						minTokens: number,
						isTsProject: boolean,
					) => Promise<unknown>;
					available: boolean;
				};
				client.available = true;

				await client.scan(tmpDir, 5, 50, false);

				// Pre-#126 these projects bailed at `hasSourceFilesRecursive`
				// without ever invoking jscpd. Confirm the spawn now happens.
				expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalled();
			} finally {
				cleanup();
			}
		});
	}

	it("does NOT scan languages without a jscpd tokenizer (e.g. Gleam, Zig, Fish)", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-");
		try {
			// Three deliberately unsupported extensions — extension regex must
			// keep these out so we never spawn jscpd on a project it can't
			// tokenize. If this test starts failing, the regex was widened
			// past what jscpd supports.
			fs.writeFileSync(path.join(tmpDir, "main.gleam"), "pub fn main() {}\n");
			fs.writeFileSync(path.join(tmpDir, "main.zig"), "const x = 1;\n");
			fs.writeFileSync(path.join(tmpDir, "main.fish"), "echo hi\n");

			const client = new JscpdClient(false) as unknown as {
				scan: (
					cwd: string,
					minLines: number,
					minTokens: number,
					isTsProject: boolean,
				) => Promise<{ success: boolean; clones: unknown[] }>;
				available: boolean;
			};
			client.available = true;

			const result = await client.scan(tmpDir, 5, 50, false);

			expect(result.success).toBe(true);
			expect(result.clones).toEqual([]);
			expect(safeSpawnMod.safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	it("excludes **/*.js and **/*.jsx from the ignore pattern when isTsProject=true (closes dist/-as-duplicate latent bug, #126)", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-");
		try {
			const tsFile = path.join(tmpDir, "src", "feature.ts");
			fs.mkdirSync(path.dirname(tsFile), { recursive: true });
			fs.writeFileSync(tsFile, "export const x = 1;\n");
			// Simulate a compiled artifact under dist/
			const compiledFile = path.join(tmpDir, "dist", "feature.js");
			fs.mkdirSync(path.dirname(compiledFile), { recursive: true });
			fs.writeFileSync(compiledFile, "exports.x = 1;\n");

			const client = new JscpdClient(false) as unknown as {
				scan: (
					cwd: string,
					minLines: number,
					minTokens: number,
					isTsProject: boolean,
				) => Promise<unknown>;
				available: boolean;
			};
			client.available = true;

			await client.scan(tmpDir, 5, 50, true);

			const args =
				vi.mocked(safeSpawnMod.safeSpawnAsync).mock.calls[0]?.[1] ?? [];
			const ignoreIndex = args.indexOf("--ignore");
			// Split the comma-separated pattern list and check exact membership
			// so e.g. `**/*.json` doesn't false-positive a `**/*.js` substring
			// search.
			const patterns = String(args[ignoreIndex + 1] ?? "").split(",");
			expect(patterns).toContain("**/*.js");
			expect(patterns).toContain("**/*.jsx");
		} finally {
			cleanup();
		}
	});

	it("does NOT exclude **/*.js when isTsProject=false (preserves pre-#126 behaviour for non-TS repos)", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-");
		try {
			const srcFile = path.join(tmpDir, "src", "lib.js");
			fs.mkdirSync(path.dirname(srcFile), { recursive: true });
			fs.writeFileSync(srcFile, "exports.x = 1;\n");

			const client = new JscpdClient(false) as unknown as {
				scan: (
					cwd: string,
					minLines: number,
					minTokens: number,
					isTsProject: boolean,
				) => Promise<unknown>;
				available: boolean;
			};
			client.available = true;

			await client.scan(tmpDir, 5, 50, false);

			const args =
				vi.mocked(safeSpawnMod.safeSpawnAsync).mock.calls[0]?.[1] ?? [];
			const ignoreIndex = args.indexOf("--ignore");
			const patterns = String(args[ignoreIndex + 1] ?? "").split(",");
			expect(patterns).not.toContain("**/*.js");
			expect(patterns).not.toContain("**/*.jsx");
		} finally {
			cleanup();
		}
	});
});
