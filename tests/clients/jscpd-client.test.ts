import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gatedPromise } from "../support/fault-injection.js";
import { setupTestEnvironment } from "./test-utils.js";

const ensureTool = vi.fn();
const findNodeToolBinary = vi.fn();

vi.mock("../../clients/installer/index.js", () => ({
	// #2140: the probe resolver asks the installer for a release-managed
	// binary (`~/.pi-lens/bin`) before falling back to PATH. Undefined is
	// "no managed install", which is what these tests already assumed.
	findManagedToolBinary: vi.fn(async () => undefined),
	ensureTool,
	// #1612: resolveAvailableOrInstallUnshared reads these on the install-
	// success path to derive honest evidence rather than asserting "succeeded".
	getInstallAttempt: vi.fn(() => undefined),
	// #1636: read alongside getInstallAttempt for the compensating row's
	// `resolved` tag. Undefined falls back to "cache".
	getLastEnsureResolutionSource: vi.fn(() => undefined),
	getToolInstallStrategy: vi.fn(() => undefined),
	resetPathWalkMemo: vi.fn(),
	// Seam probes route through this on cached hits (#1203); default spawnable.
	isSpawnableCommand: vi.fn(async () => true),
}));
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findNodeToolBinary,
}));

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync: vi.fn(async () => ({
		error: undefined,
		status: 0,
		stdout: "",
		stderr: "",
	})),
}));

describe("jscpd-client", () => {
	beforeEach(async () => {
		const safeSpawnMod = await import("../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			error: undefined,
			status: 0,
			stdout: "",
			stderr: "",
		});
		ensureTool.mockReset();
		findNodeToolBinary.mockReset();
		const helpers =
			await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		helpers.resetDispatchAvailabilityState();
		findNodeToolBinary.mockResolvedValue(null);
	});

	it("uses the managed executable after PATH installation", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-managed-");
		// Must be fully qualified under the HOST's semantics (`isFullyQualified`
		// in clients/path-utils.ts), not just POSIX-absolute — on win32 a
		// leading "/" alone is ambient-drive-relative, not fully qualified, so
		// a bare "/fake/managed/jscpd" silently fails the client's
		// `isFullyQualified(resolved)` gate and the client falls through to
		// npx instead of the managed path (#1491).
		const managed =
			process.platform === "win32"
				? String.raw`C:\fake\managed\jscpd.exe`
				: "/fake/managed/jscpd";
		try {
			fs.writeFileSync(path.join(tmpDir, "src.ts"), "const x = 1;\n");
			ensureTool.mockResolvedValue(managed);
			vi.mocked(safeSpawnMod.safeSpawnAsync)
				.mockResolvedValueOnce({
					error: Object.assign(new Error("not found"), { code: "ENOENT" }),
					failure: "spawn",
					spawnFailure: { kind: "tool-not-found" } as never,
					status: 1,
					stdout: "",
					stderr: "",
				})
				.mockResolvedValue({
					error: undefined,
					status: 0,
					stdout: "",
					stderr: "",
				});
			const result = await new JscpdClient().scan(tmpDir);
			expect(result.success).toBe(true);
			expect(vi.mocked(safeSpawnMod.safeSpawnAsync).mock.calls[1]?.[0]).toBe(
				managed,
			);
		} finally {
			cleanup();
		}
	});

	it("suppresses failed installs until the session resets", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");
		vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
			error: Object.assign(new Error("not found"), { code: "ENOENT" }),
			failure: "spawn",
			spawnFailure: { kind: "tool-not-found" } as never,
			status: 1,
			stdout: "",
			stderr: "",
		});
		const client = new JscpdClient();
		expect(await client.ensureAvailable()).toBe(false);
		expect(ensureTool).toHaveBeenCalledTimes(1);
		await client.ensureAvailable();
		expect(ensureTool).toHaveBeenCalledTimes(1);
		const helpers =
			await import("../../clients/dispatch/runners/utils/runner-helpers.js");
		helpers.resetDispatchAvailabilityState();
		ensureTool.mockResolvedValue("jscpd");
		expect(await client.ensureAvailable()).toBe(true);
		expect(ensureTool).toHaveBeenCalledTimes(2);
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
				ensureAvailable: () => Promise<boolean>;
			};
			await client.ensureAvailable();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
				error: undefined,
				status: 0,
				stdout: "",
				stderr: "",
			});

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

	it("reports a nonzero exit with no report file as errored, never clean (#1736 sweep)", async () => {
		// jscpd (verified live, 3.5.10) writes NO report file both when it's
		// genuinely clean (exit 0) and when it crashes (nonzero exit, uncaught
		// exception). The missing-file check alone can't tell those apart --
		// the fix must also look at the exit status.
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-crash-");
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
				) => Promise<{ success: boolean; clones: unknown[] }>;
				ensureAvailable: () => Promise<boolean>;
			};
			await client.ensureAvailable();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValue({
				error: undefined,
				status: 1,
				stdout: "",
				stderr: "Error: ENOENT: no such file or directory\n",
			});

			const result = await client.scan(tmpDir, 5, 50, true);

			expect(result.success).toBe(false);
			expect(result.clones).toHaveLength(0);
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
				ensureAvailable: () => Promise<boolean>;
			};
			await client.ensureAvailable();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();

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
				ensureAvailable: () => Promise<boolean>;
			};
			await client.ensureAvailable();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();

			const result = await client.scan(tmpDir, 5, 50, true);

			expect(result.success).toBe(true);
			expect(result.clones).toEqual([]);
			expect(safeSpawnMod.safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	// #747/#250 — internal root contract: belt-and-braces refusal so a future
	// caller that doesn't guard the root can't spawn a whole-$HOME jscpd walk.
	it("refuses to scan a root at/above the home directory without spawning (#747)", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-");
		try {
			const srcFile = path.join(tmpDir, "src", "index.ts");
			fs.mkdirSync(path.dirname(srcFile), { recursive: true });
			fs.writeFileSync(srcFile, "export const x = 1;\n");

			const client = new JscpdClient(false) as unknown as {
				scan: (
					cwd: string,
					minLines: number,
					minTokens: number,
					isTsProject: boolean,
					options?: { homeDir?: string },
				) => Promise<{ success: boolean; clones: unknown[] }>;
				ensureAvailable: () => Promise<boolean>;
			};
			await client.ensureAvailable();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();

			// cwd IS the home directory.
			const result = await client.scan(tmpDir, 5, 50, true, {
				homeDir: tmpDir,
			});

			expect(result.success).toBe(false);
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
					ensureAvailable: () => Promise<boolean>;
				};
				await client.ensureAvailable();
				vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();

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
				ensureAvailable: () => Promise<boolean>;
			};
			await client.ensureAvailable();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();

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
				ensureAvailable: () => Promise<boolean>;
			};
			await client.ensureAvailable();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();

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

	// #1731 discipline A: jscpd discovers `.jscpd.json` unaided, but
	// `--min-lines`/`--min-tokens`/`--ignore` on the CLI override whatever it
	// sets — passing them unconditionally silently discarded a project's own
	// thresholds and ignore list.
	it("omits --min-lines/--min-tokens/--ignore when the project ships .jscpd.json (#1731)", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const safeSpawnMod = await import("../../clients/safe-spawn.js");

		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-config-");
		try {
			const srcFile = path.join(tmpDir, "src", "feature.ts");
			fs.mkdirSync(path.dirname(srcFile), { recursive: true });
			fs.writeFileSync(srcFile, "export const x = 1;\n");
			fs.writeFileSync(
				path.join(tmpDir, ".jscpd.json"),
				JSON.stringify({
					minLines: 10,
					minTokens: 100,
					ignore: ["**/vendor/**"],
				}),
			);

			const client = new JscpdClient(false) as unknown as {
				scan: (
					cwd: string,
					minLines: number,
					minTokens: number,
					isTsProject: boolean,
				) => Promise<unknown>;
				ensureAvailable: () => Promise<boolean>;
			};
			await client.ensureAvailable();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();

			await client.scan(tmpDir, 5, 50, true);

			const args =
				vi.mocked(safeSpawnMod.safeSpawnAsync).mock.calls[0]?.[1] ?? [];
			expect(args).not.toContain("--min-lines");
			expect(args).not.toContain("--min-tokens");
			expect(args).not.toContain("--ignore");
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
				ensureAvailable: () => Promise<boolean>;
			};
			await client.ensureAvailable();
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();

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

/**
 * In-flight ABA release (#1968, kit-driven white-box probe — sibling of
 * dead-code-client's/knip-client's bare-`.finally` release, same shape).
 *
 * The race needs a SECOND WRITER replacing the map entry mid-flight — the
 * public API alone cannot produce it (single set site; microtask FIFO orders
 * every observer after A's cleanup). The test simulates that writer directly.
 * Red on the pre-fix bare `.finally` delete: A's cleanup evicted B and the
 * third caller started a duplicate scan.
 */
describe("jscpd-client in-flight ABA release (#1968)", () => {
	const tick = () => new Promise((resolve) => setImmediate(resolve));

	interface Internals {
		ensureAvailable: () => Promise<boolean>;
		hasSourceFilesRecursive: (dir: string) => boolean;
		runScan: (
			cwd: string,
			minLines: number,
			minTokens: number,
			isTsProject: boolean,
		) => Promise<unknown>;
		inFlight: Map<string, Promise<unknown>>;
	}

	it("a late-settling scan does not evict its mid-flight successor", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-aba-");
		try {
			const client = new JscpdClient(false);
			const internals = client as unknown as Internals;
			vi.spyOn(internals, "ensureAvailable").mockResolvedValue(true);
			vi.spyOn(internals, "hasSourceFilesRecursive").mockReturnValue(true);

			const gateA = gatedPromise<unknown>();
			let scanCalls = 0;
			vi.spyOn(internals, "runScan").mockImplementation(() => {
				scanCalls += 1;
				return scanCalls === 1
					? gateA.promise
					: gatedPromise<unknown>().promise;
			});

			void client.scan(tmpDir, 5, 50, false); // scan A in flight
			await tick();
			expect(internals.inFlight.size).toBe(1);
			const key = [...internals.inFlight.keys()][0]!;

			// B replaces the entry under the same key while A is still in flight.
			const successor = gatedPromise<unknown>();
			internals.inFlight.set(key, successor.promise);

			gateA.resolve({}); // A settles late
			await tick();
			await tick();

			// B's entry survived A's cleanup...
			expect(internals.inFlight.get(key)).toBe(successor.promise);
			// ...and a third caller SHARES B instead of starting a duplicate scan.
			void client.scan(tmpDir, 5, 50, false);
			await tick();
			expect(scanCalls).toBe(1);

			successor.resolve({});
		} finally {
			cleanup();
		}
	});

	// Mutation-proof companion: pins that a normal, uncontested settlement
	// still empties the slot, so a mutant that makes the identity guard
	// permanently `false` (never releases) reds here.
	it("a normally-settling scan still cleans up its own entry", async () => {
		const { JscpdClient } = await import("../../clients/jscpd-client.js");
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-jscpd-clean-");
		try {
			const client = new JscpdClient(false);
			const internals = client as unknown as Internals;
			vi.spyOn(internals, "ensureAvailable").mockResolvedValue(true);
			vi.spyOn(internals, "hasSourceFilesRecursive").mockReturnValue(true);
			vi.spyOn(internals, "runScan").mockResolvedValue({});

			await client.scan(tmpDir, 5, 50, false);
			await tick();
			expect(internals.inFlight.size).toBe(0);
		} finally {
			cleanup();
		}
	});
});
