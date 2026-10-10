import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { setProjectTrustState } from "../../clients/project-trust.js";
import { getToolEnvironment } from "../../clients/installer/index.js";
import {
	KnipClient,
	readOverridePinnedPackageNames,
	type KnipResult,
} from "../../clients/knip-client.js";
import { gatedPromise } from "../support/fault-injection.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync: vi.fn(async () => ({
		error: null,
		status: 0,
		stdout: "",
		stderr: "",
	})),
}));

describe("knip-client", () => {
	// The suite asserts the project `.bin` is prepended to the child PATH and
	// that a local knip resolves; the trust gate itself is witnessed in
	// `project-local-bin-trust.test.ts`.
	beforeEach(() => setProjectTrustState("trusted"));

	it("runAnalyze() passes --cache and a --cache-location under getProjectDataDir", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-cache-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');

			const safeSpawnMod = await import("../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockClear();

			const client = new KnipClient(false) as unknown as {
				runAnalyze: (d: string) => Promise<unknown>;
			};

			await client.runAnalyze(tmpDir);

			expect(safeSpawnMod.safeSpawnAsync).toHaveBeenCalled();
			const [command, args, spawnOptions] =
				vi.mocked(safeSpawnMod.safeSpawnAsync).mock.calls[0] ?? [];
			expect(command).toBe("knip");
			expect(args).toContain("--cache");
			expect(spawnOptions?.cwd).toBe(tmpDir);

			// Control-flow coverage for #1199: runAnalyze() must construct the
			// exact child environment before calling safeSpawnAsync. The project
			// .bin is first, while the installer-provided managed entries remain
			// present behind it for Windows PATH/PATHEXT resolution.
			const separator = process.platform === "win32" ? ";" : ":";
			const projectBin = path.join(tmpDir, "node_modules", ".bin");
			const childPath =
				spawnOptions?.env?.PATH ?? spawnOptions?.env?.Path ?? "";
			const childPathEntries = childPath.split(separator);
			const managedPath = (await getToolEnvironment()).PATH ?? "";
			const managedEntries = managedPath.split(separator);
			expect(childPathEntries[0]).toBe(projectBin);
			for (const managedEntry of managedEntries.slice(0, 2)) {
				expect(childPathEntries).toContain(managedEntry);
			}
			if (process.platform === "win32") {
				expect(spawnOptions?.env?.Path).toBe(spawnOptions?.env?.PATH);
			}

			const cacheLocationIndex = (args as string[]).indexOf("--cache-location");
			expect(cacheLocationIndex).toBeGreaterThan(-1);

			const expectedCacheLocation = path.join(
				getProjectDataDir(tmpDir),
				"cache",
				"knip",
			);
			expect((args as string[])[cacheLocationIndex + 1]).toBe(
				expectedCacheLocation,
			);

			// Pre-created eagerly (knip's own auto-mkdir for --cache-location is
			// unreliable on Windows — see comment in runAnalyze()).
			expect(fs.existsSync(expectedCacheLocation)).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("prunes knip's glob cache before every run, keeping module caches (#1630)", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-globcache-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');

			const cacheLocation = path.join(
				getProjectDataDir(tmpDir),
				"cache",
				"knip",
			);
			fs.mkdirSync(cacheLocation, { recursive: true });

			// knip's on-disk cache layout: one glob cache plus the module/plugin
			// caches that carry nearly all of the speed win.
			const globCache = path.join(cacheLocation, "glob-6.4.1.cache");
			const gitignoreCache = path.join(cacheLocation, "gitignore-6.4.1.cache");
			const rootCache = path.join(cacheLocation, "root--6.4.1");
			const pluginsCache = path.join(cacheLocation, "plugins--6.4.1");
			for (const file of [globCache, gitignoreCache, rootCache, pluginsCache]) {
				fs.writeFileSync(file, "stale");
			}

			const safeSpawnMod = await import("../../clients/safe-spawn.js");
			// The prune must land BEFORE knip starts, not after it finishes —
			// otherwise the very run being fixed still reads the stale glob.
			let globCacheExistedAtSpawn = true;
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockImplementationOnce(
				async () => {
					globCacheExistedAtSpawn = fs.existsSync(globCache);
					return { status: 0, stdout: "", stderr: "" };
				},
			);

			const client = new KnipClient(false) as unknown as {
				runAnalyze: (d: string) => Promise<unknown>;
			};
			await client.runAnalyze(tmpDir);

			expect(globCacheExistedAtSpawn).toBe(false);
			expect(fs.existsSync(globCache)).toBe(false);
			// Everything else survives: the glob cache is the only one that goes
			// stale on a consumer-side import change.
			expect(fs.existsSync(rootCache)).toBe(true);
			expect(fs.existsSync(pluginsCache)).toBe(true);
			expect(fs.existsSync(gitignoreCache)).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("resolves project root from nested directory", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');
			const nested = path.join(tmpDir, "src", "feature");
			fs.mkdirSync(nested, { recursive: true });

			const client = new KnipClient(false) as unknown as {
				resolveProjectRoot: (startDir: string) => string | null;
			};

			expect(client.resolveProjectRoot(nested)).toBe(tmpDir);
		} finally {
			cleanup();
		}
	});

	it("does not resolve package markers at or above home", () => {
		const tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-knip-home-ceiling-"),
		);
		try {
			const ancestor = path.join(tmpRoot, "ancestor");
			const home = path.join(ancestor, "home");
			const nested = path.join(home, "empty-folder");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(
				path.join(ancestor, "package.json"),
				'{"name":"parent"}',
			);

			const client = new KnipClient(false) as unknown as {
				resolveProjectRoot: (
					startDir: string,
					homeDir?: string,
				) => string | null;
			};

			expect(client.resolveProjectRoot(nested, home)).toBeNull();
		} finally {
			removeTempDirSync(tmpRoot);
		}
	});

	it("does not resolve a package marker at the home dir itself", () => {
		const tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-knip-home-marker-"),
		);
		try {
			const home = path.join(tmpRoot, "home");
			fs.mkdirSync(home, { recursive: true });
			fs.writeFileSync(path.join(home, "package.json"), '{"name":"home"}');

			const client = new KnipClient(false) as unknown as {
				resolveProjectRoot: (
					startDir: string,
					homeDir?: string,
				) => string | null;
			};

			expect(client.resolveProjectRoot(home, home)).toBeNull();
		} finally {
			removeTempDirSync(tmpRoot);
		}
	});

	it("does not walk past a VCS boundary to a parent package.json", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-boundary-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"parent"}');
			const repoRoot = path.join(tmpDir, "unity-repo");
			const nested = path.join(repoRoot, "Assets", "Scripts");
			fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
			fs.mkdirSync(nested, { recursive: true });

			const client = new KnipClient(false) as unknown as {
				resolveProjectRoot: (startDir: string) => string | null;
			};

			expect(client.resolveProjectRoot(nested)).toBeNull();
		} finally {
			cleanup();
		}
	});

	it("returns null when no project markers exist up the tree", () => {
		// Regression: previously fell back to startDir, causing knip to scan
		// arbitrary directories like $HOME when run from a bare cwd.
		const tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-knip-none-"),
		);
		try {
			const nested = path.join(tmpRoot, "deep", "nowhere");
			fs.mkdirSync(nested, { recursive: true });

			const client = new KnipClient(false) as unknown as {
				resolveProjectRoot: (startDir: string) => string | null;
			};

			// No package.json anywhere from `nested` up to filesystem root of tmp.
			// Real filesystem root may have a marker, so we can't assert null on an
			// unbounded walk — but we CAN assert it doesn't return the startDir
			// (the old buggy fallback).
			const resolved = client.resolveProjectRoot(nested);
			expect(resolved).not.toBe(nested);
		} finally {
			removeTempDirSync(tmpRoot);
		}
	});

	it("analyze() short-circuits when no project root is found", async () => {
		// Regression: previously knip was spawned with cwd=$HOME and recursed
		// through every sibling project, causing CPU/memory spikes.
		const tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-knip-skip-"),
		);
		try {
			const client = new KnipClient(false) as unknown as {
				resolveProjectRoot: (s: string) => string | null;
				ensureAvailable: () => Promise<boolean>;
				runAnalyze: (d: string) => Promise<unknown>;
				analyze: (cwd?: string) => Promise<{
					success: boolean;
					issues: unknown[];
					summary: string;
				}>;
			};

			// Pretend knip is installed so we reach the project-root check.
			vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
			// Force project-root resolution to fail.
			vi.spyOn(client, "resolveProjectRoot").mockReturnValue(null);
			const runSpy = vi.spyOn(client, "runAnalyze");

			const result = await client.analyze(tmpRoot);

			expect(result.success).toBe(true);
			expect(result.issues).toHaveLength(0);
			expect(result.summary).toMatch(/skipped|no project/i);
			expect(runSpy).not.toHaveBeenCalled();
		} finally {
			removeTempDirSync(tmpRoot);
			vi.restoreAllMocks();
		}
	});

	it("analyze() skips before probing knip when stopped by repo boundary", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-knip-boundary-skip-",
		);
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"parent"}');
			const repoRoot = path.join(tmpDir, "unity-repo");
			const nested = path.join(repoRoot, "Assets", "Scripts");
			fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
			fs.mkdirSync(nested, { recursive: true });

			const client = new KnipClient(false) as unknown as {
				ensureAvailable: () => Promise<boolean>;
				runAnalyze: (d: string) => Promise<unknown>;
				analyze: (cwd?: string) => Promise<{
					success: boolean;
					issues: unknown[];
					summary: string;
				}>;
			};

			const ensureSpy = vi.spyOn(client, "ensureAvailable");
			const runSpy = vi.spyOn(client, "runAnalyze");
			const result = await client.analyze(nested);

			expect(result.success).toBe(true);
			expect(result.summary).toMatch(/skipped|no project/i);
			expect(ensureSpy).not.toHaveBeenCalled();
			expect(runSpy).not.toHaveBeenCalled();
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});

	it("analyze() returns a Promise (non-blocking)", async () => {
		// Regression: analyze() used to be sync (spawnSync), blocking the event
		// loop. The TypeScript signature alone doesn't enforce this at runtime,
		// so we check that the returned value is actually a Promise.
		const client = new KnipClient(false);
		const ret = client.analyze("/definitely/not/a/project/path/for/tests");
		expect(ret).toBeInstanceOf(Promise);
		// Await so we don't leave a pending spawn behind.
		await ret;
	});

	it("de-dupes concurrent analyze() calls for the same project root", async () => {
		// Regression: back-to-back turn_end events (or turn_end during a
		// session_start scan) could spawn two `knip` processes against
		// the same tree. Two concurrent knip runs pegged both CPU cores to
		// 100% and caused the TUI freezes this PR is fixing.
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-dedupe-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');

			const client = new KnipClient(false) as unknown as {
				ensureAvailable: () => Promise<boolean>;
				runAnalyze: (d: string) => Promise<{
					success: boolean;
					issues: unknown[];
					summary: string;
				}>;
				analyze: (cwd?: string) => Promise<unknown>;
			};

			vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);

			type RunResolver = (v: {
				success: boolean;
				issues: unknown[];
				unusedExports: unknown[];
				unusedFiles: unknown[];
				unusedDeps: unknown[];
				unlistedDeps: unknown[];
				summary: string;
			}) => void;
			let resolveRun: RunResolver | null = null;
			let runCalls = 0;
			const runSpy = vi.spyOn(client, "runAnalyze").mockImplementation(
				() =>
					new Promise((res) => {
						runCalls++;
						resolveRun = res as unknown as RunResolver;
					}),
			);

			const first = client.analyze(tmpDir);
			const second = client.analyze(tmpDir);

			// Let microtasks settle so both analyze() calls reach runAnalyze check.
			await Promise.resolve();
			await Promise.resolve();

			expect(runCalls).toBe(1);
			expect(runSpy).toHaveBeenCalledTimes(1);

			// Resolve the single in-flight run with the same result for both.
			const payload = {
				success: true,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "ok",
			};
			(resolveRun as RunResolver | null)?.(payload);

			const [a, b] = await Promise.all([first, second]);
			expect(a).toBe(b);

			// A subsequent call AFTER the first completes should spawn a new run.
			resolveRun = null;
			runCalls = 0;
			const third = client.analyze(tmpDir);
			await Promise.resolve();
			await Promise.resolve();
			expect(runCalls).toBe(1);
			(resolveRun as RunResolver | null)?.(payload);
			await third;
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});

	it.each([
		{ name: "changed sequence", nextSeq: 8, reset: false },
		{ name: "session reset", nextSeq: 7, reset: true },
	])("re-executes after $name", async ({ nextSeq, reset }) => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-knip-memo-change-",
		);
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');
			const client = new KnipClient(false);
			vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
			const result = {
				success: true,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "ok",
			};
			const run = vi
				.spyOn(
					client as unknown as {
						runAnalyze: (dir: string) => Promise<unknown>;
					},
					"runAnalyze",
				)
				.mockResolvedValue(result);

			await client.analyze(tmpDir, [], { projectSeq: 7 });
			if (reset) client.resetSessionState();
			await client.analyze(tmpDir, [], { projectSeq: nextSeq });

			expect(run).toHaveBeenCalledTimes(2);
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});

	it("serves unchanged project content from cache without spawning", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-memo-");
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');
			const client = new KnipClient(false);
			vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
			const run = vi
				.spyOn(
					client as unknown as {
						runAnalyze: (dir: string) => Promise<unknown>;
					},
					"runAnalyze",
				)
				.mockResolvedValue({
					success: true,
					issues: [],
					unusedExports: [],
					unusedFiles: [],
					unusedDeps: [],
					unlistedDeps: [],
					summary: "ok",
				});

			const first = await client.analyze(tmpDir, [], { projectSeq: 7 });
			const cached = await client.analyze(tmpDir, [], { projectSeq: 7 });

			expect(run).toHaveBeenCalledTimes(1);
			expect(first.execution).toBe("executed");
			expect(cached.execution).toBe("cache");
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});

	it("invalidates the memo when an external package change does not advance projectSeq", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-knip-memo-external-",
		);
		try {
			const packagePath = path.join(tmpDir, "package.json");
			fs.writeFileSync(packagePath, '{"name":"demo"}');
			const client = new KnipClient(false);
			vi.spyOn(client, "ensureAvailable").mockResolvedValue(true);
			const run = vi
				.spyOn(
					client as unknown as {
						runAnalyze: (dir: string) => Promise<unknown>;
					},
					"runAnalyze",
				)
				.mockResolvedValue({
					success: true,
					issues: [],
					unusedExports: [],
					unusedFiles: [],
					unusedDeps: [],
					unlistedDeps: [],
					summary: "ok",
				});

			await client.analyze(tmpDir, [], { projectSeq: 7 });
			fs.writeFileSync(packagePath, '{"name":"demo","version":"2"}');
			const refreshed = await client.analyze(tmpDir, [], { projectSeq: 7 });

			expect(run).toHaveBeenCalledTimes(2);
			expect(refreshed.execution).toBe("executed");
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});

	it("parses fallback flat issue array format", () => {
		const client = new KnipClient(false) as unknown as {
			parseOutput: (output: string) => {
				success: boolean;
				issues: Array<{ type: string; name: string; file?: string }>;
				unlistedDeps: Array<{ type: string; name: string }>;
			};
		};

		const result = client.parseOutput(
			JSON.stringify([
				{
					type: "unlisted",
					name: "@acme/pkg",
					file: "src/main.ts",
					line: 12,
				},
			]),
		);

		expect(result.success).toBe(true);
		expect(result.issues).toHaveLength(1);
		expect(result.unlistedDeps).toHaveLength(1);
		expect(result.unlistedDeps[0].name).toBe("@acme/pkg");
	});

	it("readOverridePinnedPackageNames collects overrides/resolutions/pnpm.overrides keys (#968)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-knip-overrides-");
		try {
			fs.writeFileSync(
				path.join(tmpDir, "package.json"),
				JSON.stringify({
					name: "demo",
					overrides: { "brace-expansion": "^2.0.0" },
					resolutions: { protobufjs: "^7.6.5" },
					pnpm: { overrides: { "nested-pkg": { "sub-pkg": "^1.0.0" } } },
				}),
			);

			const names = readOverridePinnedPackageNames(tmpDir);
			expect(names.has("brace-expansion")).toBe(true);
			expect(names.has("protobufjs")).toBe(true);
			expect(names.has("nested-pkg")).toBe(true);
			expect(names.has("sub-pkg")).toBe(true);
			expect(names.has("unrelated-pkg")).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("readOverridePinnedPackageNames degrades to an empty set on missing/malformed package.json", () => {
		const tmpRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-knip-overrides-missing-"),
		);
		try {
			expect(readOverridePinnedPackageNames(tmpRoot).size).toBe(0);
		} finally {
			removeTempDirSync(tmpRoot);
		}
	});

	it("does not report an unused devDependency that's also an overrides-only security pin (#968)", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-knip-overrides-e2e-",
		);
		try {
			fs.writeFileSync(
				path.join(tmpDir, "package.json"),
				JSON.stringify({
					name: "demo",
					overrides: { "brace-expansion": "^2.0.0" },
					devDependencies: {
						"brace-expansion": "^2.0.0",
						"real-unused": "^1.0.0",
					},
				}),
			);

			const safeSpawnMod = await import("../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
				error: null,
				status: 0,
				stdout: JSON.stringify({
					issues: [
						{
							file: "package.json",
							devDependencies: [
								{ name: "brace-expansion" },
								{ name: "real-unused" },
							],
						},
					],
				}),
				stderr: "",
			} as never);

			const client = new KnipClient(false) as unknown as {
				runAnalyze: (d: string) => Promise<{
					unusedDeps: Array<{ name: string; type: string }>;
					issues: unknown[];
				}>;
			};
			const result = await client.runAnalyze(tmpDir);

			// The overrides-pinned dep is dropped; a genuinely unused devDependency
			// with no overrides entry still gets reported.
			expect(result.unusedDeps.map((d) => d.name)).toEqual(["real-unused"]);
			expect(result.issues).toHaveLength(1);
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});

	it("reports a nonzero exit with empty stdout as errored, never clean (#1736)", async () => {
		// The reviewer's exact fixture from #1732's review: a broken project
		// knip shim that writes to stderr and exits 1 with no stdout at all.
		// Empirically (knip 6.4.1), a genuinely clean run ALWAYS prints
		// `{"issues":[]}` on exit 0 — empty stdout only pairs with a nonzero
		// exit, so this combination is unambiguous evidence of a failed run.
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-knip-broken-shim-",
		);
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');

			const safeSpawnMod = await import("../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: "",
				stderr: "knip: command not found in this shim\n",
			} as never);

			const client = new KnipClient(false) as unknown as {
				runAnalyze: (d: string) => Promise<{
					success: boolean;
					summary: string;
					issues: unknown[];
				}>;
			};
			const result = await client.runAnalyze(tmpDir);

			expect(result.success).toBe(false);
			expect(result.summary).not.toMatch(/no issues found/i);
			expect(result.issues).toHaveLength(0);
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});

	it('still reports a genuine clean run (exit 0, {"issues":[]}) as clean (#1736)', async () => {
		// Inversion check (the #1700 lesson): prove the discriminator doesn't
		// misclassify a REAL clean run. knip 6.4.1 verified live: exit 0 always
		// prints `{"issues":[]}`, never truly empty stdout.
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-knip-genuine-clean-",
		);
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');

			const safeSpawnMod = await import("../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
				error: null,
				status: 0,
				stdout: '{"issues":[]}',
				stderr: "",
			} as never);

			const client = new KnipClient(false) as unknown as {
				runAnalyze: (
					d: string,
				) => Promise<{ success: boolean; issues: unknown[] }>;
			};
			const result = await client.runAnalyze(tmpDir);

			expect(result.success).toBe(true);
			expect(result.issues).toHaveLength(0);
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});

	it("still parses a genuine findings run that exits nonzero (knip exits 1 when it finds issues) (#1736)", async () => {
		const { tmpDir, cleanup } = setupTestEnvironment(
			"pi-lens-knip-genuine-findings-",
		);
		try {
			fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"demo"}');

			const safeSpawnMod = await import("../../clients/safe-spawn.js");
			vi.mocked(safeSpawnMod.safeSpawnAsync).mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					issues: [
						{ file: "unused-file.js", files: [{ name: "unused-file.js" }] },
					],
				}),
				stderr: "",
			} as never);

			const client = new KnipClient(false) as unknown as {
				runAnalyze: (
					d: string,
				) => Promise<{ success: boolean; issues: unknown[] }>;
			};
			const result = await client.runAnalyze(tmpDir);

			expect(result.success).toBe(true);
			expect(result.issues).toHaveLength(1);
		} finally {
			cleanup();
			vi.restoreAllMocks();
		}
	});

	it("routes enumMembers into unusedExports (grouped format)", () => {
		// NOTE: knip 6.x has no `classMembers` issue type (requesting it makes knip
		// exit 2), so the only member-level type we include/parse is enumMembers.
		const client = new KnipClient(false) as unknown as {
			parseOutput: (output: string) => {
				success: boolean;
				unusedExports: Array<{ type: string; name: string }>;
			};
		};

		const result = client.parseOutput(
			JSON.stringify({
				issues: [
					{
						file: "src/widget.ts",
						exports: [{ name: "OldHelper" }],
						enumMembers: [{ name: "Color.Mauve" }],
					},
				],
			}),
		);

		expect(result.success).toBe(true);
		const byName = new Map(result.unusedExports.map((e) => [e.name, e.type]));
		expect(byName.get("OldHelper")).toBe("export");
		expect(byName.get("Color.Mauve")).toBe("enumMember");
		expect(result.unusedExports).toHaveLength(2);
	});
});

/**
 * In-flight ABA release (#1968, kit-driven white-box probe). Same mechanism as
 * the dead-code twin: the second writer is simulated directly because public
 * API alone cannot interleave it. Red on the pre-fix bare `.finally` delete.
 */
describe("in-flight ABA release (#1968)", () => {
	const tick = () => new Promise((resolve) => setImmediate(resolve));

	interface Internals {
		resolveProjectRoot: (cwd?: string) => string | null;
		ensureAvailable: () => Promise<boolean>;
		runAnalyze: (key: string) => Promise<KnipResult>;
		inFlight: Map<string, Promise<KnipResult>>;
	}

	function emptyResult(): KnipResult {
		return {
			success: true,
			issues: [],
			unusedExports: [],
			unusedFiles: [],
			unusedDeps: [],
			unlistedDeps: [],
			summary: "",
		};
	}

	it("a late-settling build does not evict its mid-flight successor", async () => {
		const client = new KnipClient(false);
		const internals = client as unknown as Internals;
		vi.spyOn(internals, "resolveProjectRoot").mockReturnValue("/probe-root");
		vi.spyOn(internals, "ensureAvailable").mockResolvedValue(true);
		const gateA = gatedPromise<KnipResult>();
		let analyzeCalls = 0;
		vi.spyOn(internals, "runAnalyze").mockImplementation(() => {
			analyzeCalls += 1;
			return analyzeCalls === 1
				? gateA.promise
				: gatedPromise<KnipResult>().promise;
		});

		void client.analyze("/probe-root"); // build A in flight
		await tick();
		expect(internals.inFlight.size).toBe(1);
		const key = [...internals.inFlight.keys()][0]!;

		const successor = gatedPromise<KnipResult>();
		internals.inFlight.set(key, successor.promise);

		gateA.resolve(emptyResult());
		await tick();
		await tick();

		expect(internals.inFlight.get(key)).toBe(successor.promise);
		void client.analyze("/probe-root");
		await tick();
		// Only build A ever ran: B was registered by the simulated second
		// writer, and the third caller shared it instead of starting a build.
		expect(analyzeCalls).toBe(1);

		successor.resolve(emptyResult());
	});

	it("a normally-settling build still cleans up its own entry", async () => {
		const client = new KnipClient(false);
		const internals = client as unknown as Internals;
		vi.spyOn(internals, "resolveProjectRoot").mockReturnValue("/probe-root");
		vi.spyOn(internals, "ensureAvailable").mockResolvedValue(true);
		vi.spyOn(internals, "runAnalyze").mockResolvedValue(emptyResult());

		await client.analyze("/probe-root");
		await tick();
		expect(internals.inFlight.size).toBe(0);
	});
});
