/**
 * Opaque-mutation recovery (#2000 phase 2) — real-filesystem tests: actual
 * stat walks over temp trees and real diffs. This file pins the SEAM contract
 * only; handler wiring coverage (real node -e / python -c child writes through
 * handleToolCall/handleToolResult) is PR-B scope and NOT covered here.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { execFileSync, execSync } from "../support/git-fixture-env.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The synthetic-write dispatch runs the full per-edit pipeline; point it at
// a resolved verdict instead of spawning real linters over a bare temp repo
// (same seam the runtime-tool-result suite mocks).
vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn().mockResolvedValue({
		output: "✓ no blockers",
		hasBlockers: false,
		isError: false,
		fileModified: false,
	}),
}));

// #2081: wraps the real implementation by default (every other test in this
// file exercises the genuine scan), but lets one test below override a single
// call to pin the opaque_mutation_status_pair_unknown emission without
// fabricating a real, undocumented git porcelain pair.
vi.mock("../../clients/opaque-mutation-scan.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../clients/opaque-mutation-scan.js")
		>();
	return {
		...actual,
		recoverOpaqueChangesViaGit: vi.fn(actual.recoverOpaqueChangesViaGit),
	};
});

import { handleToolCall } from "../../clients/runtime-tool-call.js";
import {
	handleToolResult,
	isFailedGitIntegrationCommand,
} from "../../clients/runtime-tool-result.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { CacheManager } from "../../clients/cache-manager.js";
import { getProjectChangeLogPath } from "../../clients/project-changes.js";
import { flushLatencyLog } from "../../clients/latency-logger.js";
import { getGlobalPiLensDir } from "../../clients/file-utils.js";
import type { ProjectChangeEntry } from "../../clients/project-changes.js";

import {
	captureFileStats,
	diffFileStats,
	OpaqueBaselineStore,
	OPAQUE_SCAN_MAX_FILES,
	recoverOpaqueChangesViaGit,
} from "../../clients/opaque-mutation-scan.js";
import { extractWrittenPathsFromCommand } from "../../clients/bash-file-access.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { removeTempDirSync } from "./test-utils.js";

let tmpDir = "";

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-opaque-scan-"));
	fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
});

afterEach(() => {
	removeTempDirSync(tmpDir);
});

describe("captureFileStats", () => {
	it("can force an unknown capture verdict for absent-evidence tests", async () => {
		expect(
			await captureFileStats(tmpDir, { forcedUnknownReason: "walk-failed" }),
		).toMatchObject({ unknownReason: "walk-failed" });
	});

	it("snapshots existing project sources with normalized keys", async () => {
		const file = path.join(tmpDir, "src", "a.ts");
		fs.writeFileSync(file, "const x = 1;\n", "utf8");
		const outcome = await captureFileStats(tmpDir);
		expect(outcome.unknownReason).toBeUndefined();
		expect(outcome.snapshot?.has(normalizeMapKey(file))).toBe(true);
		const entry = outcome.snapshot?.get(normalizeMapKey(file));
		expect(entry?.size).toBe("const x = 1;\n".length);
		expect(typeof entry?.mtimeMs).toBe("number");
	});

	it("reports file-cap-exceeded rather than an unbounded walk", async () => {
		for (let i = 0; i < OPAQUE_SCAN_MAX_FILES + 10; i++) {
			fs.writeFileSync(path.join(tmpDir, `f${i}.ts`), "x", "utf8");
		}
		const outcome = await captureFileStats(tmpDir);
		expect(outcome.unknownReason).toBe("file-cap-exceeded");
		expect(outcome.scannedCount).toBeGreaterThan(OPAQUE_SCAN_MAX_FILES);
	});
});

describe("diffFileStats", () => {
	it("detects modified, added — not deleted or unchanged", async () => {
		const modifiedPath = path.join(tmpDir, "m.ts");
		const unchangedPath = path.join(tmpDir, "u.ts");
		fs.writeFileSync(modifiedPath, "v1", "utf8");
		fs.writeFileSync(unchangedPath, "same", "utf8");
		const before = await captureFileStats(tmpDir);

		// Real child-process-style mutation: rewrite + add.
		fs.writeFileSync(modifiedPath, "v2-longer", "utf8");
		const addedPath = path.join(tmpDir, "added.ts");
		fs.writeFileSync(addedPath, "new", "utf8");
		fs.rmSync(unchangedPath);
		const after = await captureFileStats(tmpDir);

		const changed = diffFileStats(
			before.snapshot ?? new Map(),
			after.snapshot ?? new Map(),
		);
		const keys = changed.map((k) => k);
		expect(keys).toContain(normalizeMapKey(modifiedPath));
		expect(keys).toContain(normalizeMapKey(addedPath));
		expect(keys).not.toContain(normalizeMapKey(unchangedPath));
	});

	it("treats an absent baseline entry as created content", () => {
		const addedPath = normalizeMapKey(path.join(tmpDir, "created.ts"));
		const before = new Map();
		const after = new Map([[addedPath, { mtimeMs: 1, size: 1 }]]);
		expect(diffFileStats(before, after)).toEqual([addedPath]);
	});

	it("keeps touch and cp creation candidates in the recognized population", () => {
		expect(
			extractWrittenPathsFromCommand("touch newfile.ts", tmpDir),
		).toContain(path.join(tmpDir, "newfile.ts"));
		expect(
			extractWrittenPathsFromCommand("cp src/a.ts newdest.ts", tmpDir),
		).toContain(path.join(tmpDir, "newdest.ts"));
	});
});

describe("content-hash confirm on the stat-diff path (#2000)", () => {
	it("detects a same-tick same-size rewrite via hashes, red-first vs mtime+size", async () => {
		// The COLLISION, constructed deterministically: pin a known whole-ms
		// mtime via utimes on BOTH sides (before AND after the rewrite), so
		// mtime+size identity sees NO change on every platform/filesystem -
		// restoring a captured sub-ms timestamp is NOT portable (Linux CI red).
		const file = path.join(tmpDir, "collision.ts");
		const pinned = new Date(Date.now() - 5_000);
		fs.writeFileSync(file, "AAAA\n", "utf8");
		fs.utimesSync(file, pinned, pinned);
		const before = await captureFileStats(tmpDir, { withHashes: true });
		const beforeEntry = before.snapshot?.get(normalizeMapKey(file));
		expect(beforeEntry?.hash).toBeDefined();

		fs.writeFileSync(file, "BBBB\n", "utf8");
		fs.utimesSync(file, pinned, pinned);

		// Without hashes: the collision is invisible (documents the old hole).
		const plainAfter = await captureFileStats(tmpDir);
		expect(
			diffFileStats(
				before.snapshot ?? new Map(),
				plainAfter.snapshot ?? new Map(),
			),
		).toEqual([]);

		// With hashes: content confirm catches it.
		const hashedAfter = await captureFileStats(tmpDir, { withHashes: true });
		expect(
			diffFileStats(
				before.snapshot ?? new Map(),
				hashedAfter.snapshot ?? new Map(),
			),
		).toContain(normalizeMapKey(file));
	});

	it("degrades to mtime+size when the hash budget is exhausted", async () => {
		const big = path.join(tmpDir, "big.ts");
		fs.writeFileSync(big, "x".repeat(16), "utf8"); // budget below forces skip
		// Re-import with a tiny budget by capturing with default (no hashes)
		// semantics: entries simply carry no hash and diff falls back.
		const before = await captureFileStats(tmpDir);
		const after = await captureFileStats(tmpDir);
		expect(
			diffFileStats(before.snapshot ?? new Map(), after.snapshot ?? new Map()),
		).toEqual([]);
	});
});

describe("OpaqueBaselineStore", () => {
	it("one slot per cwd: take consumes, replacement evicts with a count", () => {
		const store = new OpaqueBaselineStore();
		store.record("/p", { startedAt: 1, strategy: "git" });
		store.record("/p", { startedAt: 2, strategy: "git" });
		expect(store.evictionCount).toBe(1);
		const taken = store.take("/p");
		expect(taken?.startedAt).toBe(2);
		expect(store.take("/p")).toBeUndefined();
	});
});

describe("recoverOpaqueChangesViaGit (real git repo)", () => {
	let repoDir = "";

	beforeEach(() => {
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-opaque-git-"));
		execSync("git init -q", { cwd: repoDir });
		execSync("git config user.email t@t.local", { cwd: repoDir });
		execSync("git config user.name t", { cwd: repoDir });
		fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(repoDir, "src", "base.ts"), "base\n", "utf8");
		execSync("git add -A && git commit -qm base", { cwd: repoDir });
	});

	afterEach(() => {
		removeTempDirSync(repoDir);
	});

	function nodeScriptFile(script: string): string {
		const file = path.join(repoDir, `.opaque-child-${Date.now()}.cjs`);
		fs.writeFileSync(file, script, "utf8");
		return file;
	}

	function writeViaNodeChild(target: string, content: string): void {
		const scriptFile = nodeScriptFile(
			`require('fs').writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(content)});`,
		);
		try {
			execSync(`node "${scriptFile}"`, { cwd: repoDir });
		} finally {
			fs.rmSync(scriptFile, { force: true });
		}
	}

	it("reports modified and added files inside the mtime window", async () => {
		const startedAt = Date.now();
		writeViaNodeChild(path.join(repoDir, "src", "base.ts"), "modified\n");
		writeViaNodeChild(path.join(repoDir, "src", "new.ts"), "added\n");
		const outcome = await recoverOpaqueChangesViaGit(repoDir, startedAt);
		expect(outcome.verdict).toBe("recovered");
		expect(outcome.paths).toContain(
			normalizeMapKey(path.join(repoDir, "src", "base.ts")),
		);
		expect(outcome.paths).toContain(
			normalizeMapKey(path.join(repoDir, "src", "new.ts")),
		);
	});

	it("recovers a fresh intent-to-add entry from git add -N", async () => {
		const intentPath = path.join(repoDir, "src", "intent.ts");
		const startedAt = Date.now();
		fs.writeFileSync(intentPath, "intent\n", "utf8");
		execSync("git add -N -- src/intent.ts", { cwd: repoDir });

		const rawStatus = execFileSync("git", ["status", "--porcelain", "-z"], {
			cwd: repoDir,
			encoding: "utf8",
		});
		expect(rawStatus).toBe(" A src/intent.ts\0");

		await expect(
			recoverOpaqueChangesViaGit(repoDir, startedAt),
		).resolves.toEqual({
			verdict: "recovered",
			paths: [normalizeMapKey(intentPath)],
			scannedCount: 1,
		});
	});

	it("excludes files last written BEFORE the window floor", async () => {
		// A pre-existing dirty file from long before the command started.
		fs.writeFileSync(path.join(repoDir, "src", "base.ts"), "early\n", "utf8");
		// A window that opens far in the future excludes everything on disk.
		const outcome = await recoverOpaqueChangesViaGit(
			repoDir,
			Date.now() + 10_000,
		);
		expect(outcome.verdict).toBe("recovered");
		expect(outcome.paths).toEqual([]);
	});

	it(
		"excludes clean incoming index paths after a conflicted merge",
		{ timeout: 20_000 },
		async () => {
			const imported = path.join(repoDir, "src", "imported.ts");
			const added = path.join(repoDir, "src", "added.ts");
			const conflict = path.join(repoDir, "src", "base.ts");
			execSync("git checkout -qb incoming", { cwd: repoDir });
			fs.writeFileSync(imported, "imported\n", "utf8");
			fs.writeFileSync(added, "added\n", "utf8");
			fs.writeFileSync(conflict, "incoming\n", "utf8");
			execSync("git add -A && git commit -qm incoming", { cwd: repoDir });
			execSync("git checkout -q master", { cwd: repoDir });
			fs.writeFileSync(conflict, "local\n", "utf8");
			execSync("git add -A && git commit -qm local", { cwd: repoDir });

			const startedAt = Date.now();
			expect(() => execSync("git merge incoming", { cwd: repoDir })).toThrow();
			const worktreeSide = path.join(repoDir, "src", "worktree-side.ts");
			fs.writeFileSync(worktreeSide, "worktree side\n", "utf8");

			const outcome = await recoverOpaqueChangesViaGit(repoDir, startedAt, {
				excludeIndexOnlyWhenUnmerged: true,
			});
			expect(outcome.verdict).toBe("recovered");
			expect(outcome.paths).toEqual(
				expect.arrayContaining([
					normalizeMapKey(conflict),
					normalizeMapKey(worktreeSide),
				]),
			);
			expect(outcome.paths).not.toContain(normalizeMapKey(imported));
			expect(outcome.paths).not.toContain(normalizeMapKey(added));
			expect(outcome.excludedIncomingCount).toBe(2);
		},
	);

	// #2081: excludedIncomingCount must count only entries the mtime window
	// would otherwise have dispatched. A clean-index entry that predates the
	// window (a long-lived staged change untouched by this integration) was
	// never going to be reported, so dropping it is not suppression and must
	// not inflate the count.
	it(
		"does not count a clean incoming path outside the mtime window as excluded",
		{ timeout: 20_000 },
		async () => {
			const imported = path.join(repoDir, "src", "imported.ts");
			const conflict = path.join(repoDir, "src", "base.ts");
			execSync("git checkout -qb incoming", { cwd: repoDir });
			fs.writeFileSync(imported, "imported\n", "utf8");
			fs.writeFileSync(conflict, "incoming\n", "utf8");
			execSync("git add -A && git commit -qm incoming", { cwd: repoDir });
			execSync("git checkout -q master", { cwd: repoDir });
			fs.writeFileSync(conflict, "local\n", "utf8");
			execSync("git add -A && git commit -qm local", { cwd: repoDir });

			const startedAt = Date.now();
			expect(() => execSync("git merge incoming", { cwd: repoDir })).toThrow();
			// Checkout during the merge stamps a fresh mtime on imported.ts. Push
			// it back before the window floor to model a long-lived staged change
			// the merge did not itself write.
			const old = new Date(startedAt - 10_000);
			fs.utimesSync(imported, old, old);

			const outcome = await recoverOpaqueChangesViaGit(repoDir, startedAt, {
				excludeIndexOnlyWhenUnmerged: true,
			});
			expect(outcome.verdict).toBe("recovered");
			expect(outcome.paths).not.toContain(normalizeMapKey(imported));
			expect(outcome.excludedIncomingCount).toBeUndefined();
		},
	);

	// #2060 F5: the worry was that `python gen.py && git add -A && git merge
	// origin/main` loses gen.py's output, because staged agent work looks
	// exactly like a clean incoming entry. Real git closes that gap for us:
	// merge, rebase, cherry-pick and revert all REFUSE to start against a dirty
	// index ("your local changes would be overwritten by merge"), so they leave
	// no unmerged entry, the filter stays inert, and the staged file is
	// recovered normally. This test pins that reasoning to observed behavior —
	// if a future change fires the filter without unmerged entries, it reds.
	it(
		"keeps agent work staged before a merge that refused to start",
		{ timeout: 20_000 },
		async () => {
			const generated = path.join(repoDir, "src", "generated.ts");
			const conflict = path.join(repoDir, "src", "base.ts");
			execSync("git checkout -qb incoming", { cwd: repoDir });
			fs.writeFileSync(conflict, "incoming\n", "utf8");
			execSync("git add -A && git commit -qm incoming", { cwd: repoDir });
			execSync("git checkout -q master", { cwd: repoDir });
			fs.writeFileSync(conflict, "local\n", "utf8");
			execSync("git add -A && git commit -qm local", { cwd: repoDir });

			const startedAt = Date.now();
			fs.writeFileSync(generated, "generated\n", "utf8");
			execSync("git add -- src/generated.ts", { cwd: repoDir });
			expect(() => execSync("git merge incoming", { cwd: repoDir })).toThrow();
			// The refusal is the mechanism under test: no unmerged entry exists.
			expect(
				execFileSync("git", ["status", "--porcelain"], {
					cwd: repoDir,
					encoding: "utf8",
				}),
			).not.toMatch(/^(?:U.|.U|DD|AA)/m);

			const outcome = await recoverOpaqueChangesViaGit(repoDir, startedAt, {
				excludeIndexOnlyWhenUnmerged: true,
			});
			expect(outcome.verdict).toBe("recovered");
			expect(outcome.paths).toContain(normalizeMapKey(generated));
			expect(outcome.excludedIncomingCount).toBeUndefined();
		},
	);

	// #2060 F3: `git stash pop` also leaves `M ` index-only entries beside a
	// conflict, but that content is the agent's own stashed work, not another
	// branch's. Excluding it would destroy exactly what recovery exists to
	// capture, so stash stays out of the integration family.
	it(
		"keeps clean index entries from a conflicted stash pop",
		{ timeout: 20_000 },
		async () => {
			const conflict = path.join(repoDir, "src", "base.ts");
			const stashed = path.join(repoDir, "src", "stashed.ts");
			fs.writeFileSync(stashed, "committed\n", "utf8");
			execSync("git add -A && git commit -qm second", { cwd: repoDir });
			fs.writeFileSync(conflict, "stashed\n", "utf8");
			fs.writeFileSync(stashed, "stashed\n", "utf8");
			execSync("git stash -q", { cwd: repoDir });
			fs.writeFileSync(conflict, "local\n", "utf8");
			execSync("git commit -qam local", { cwd: repoDir });

			const startedAt = Date.now();
			expect(() => execSync("git stash pop", { cwd: repoDir })).toThrow();
			// Option OFF, matching what the subcommand set decides for stash.
			const outcome = await recoverOpaqueChangesViaGit(repoDir, startedAt);
			expect(outcome.verdict).toBe("recovered");
			expect(outcome.paths).toContain(normalizeMapKey(stashed));
			expect(outcome.paths).toContain(normalizeMapKey(conflict));
		},
	);

	it(
		"end-to-end: node child write is recovered as opaque-script in the change log",
		{ timeout: 15_000 },
		async () => {
			const previousDataDir = process.env.PILENS_DATA_DIR;
			process.env.PILENS_DATA_DIR = path.join(repoDir, "data");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = repoDir;
			runtime.setTelemetryIdentity({ sessionId: "opaque-e2e" });
			try {
				const target = path.join(repoDir, "src", "generated.ts");
				const command = nodeScriptFile(
					`require('fs').writeFileSync(${JSON.stringify(target)}, 'generated by child\\n');`,
				);
				await handleToolCall({
					event: { toolName: "bash", input: { command } },
					ctx: { cwd: repoDir },
					lensEnabled: true,
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					ensureLSPConfigInitialized: async () => {},
					updateLspStatus: () => {},
					resetLSPService: () => {},
				} as Parameters<typeof handleToolCall>[0]);
				try {
					execSync(`node "${command}"`, { cwd: repoDir });
				} finally {
					fs.rmSync(command, { force: true });
				}
				await handleToolResult({
					event: {
						toolName: "bash",
						input: { command },
						content: [{ type: "text", text: "done" }],
					},
					getFlag: () => false,
					dbg: () => {},
					runtime,
					cacheManager: new CacheManager(false),
					biomeClient: {},
					ruffClient: {},
					testRunnerClient: {},
					metricsClient: {},
					resetLSPService: () => {},
					agentBehaviorRecord: () => [],
					formatBehaviorWarnings: () => "",
				} as unknown as Parameters<typeof handleToolResult>[0]);

				const lines = fs
					.readFileSync(getProjectChangeLogPath(repoDir), "utf8")
					.split("\n")
					.filter((l) => l.trim());
				const entries = lines.map((l) => JSON.parse(l) as ProjectChangeEntry);
				const recovered = entries.filter((e) => e.source === "opaque-script");
				expect(recovered.length).toBeGreaterThanOrEqual(1);
				expect(recovered.some((e) => e.filePath.endsWith("generated.ts"))).toBe(
					true,
				);

				// Dispatch really ran for the recovered file - the synthetic write
				// re-enters the full per-edit pipeline (runPipeline), same as any
				// native or recognized write. Assert it, don't assume it.
				const { runPipeline } = await import("../../clients/pipeline.js");
				const dispatchedPaths = vi
					.mocked(runPipeline)
					.mock.calls.map((call) => String(call[0]?.filePath));
				expect(dispatchedPaths.some((p) => p.endsWith("generated.ts"))).toBe(
					true,
				);
			} finally {
				if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
				else process.env.PILENS_DATA_DIR = previousDataDir;
			}
		},
	);
});

describe("partial-recognition recovery (#2000 PR-B)", () => {
	let repoDir = "";

	function depsFor(
		runtime: RuntimeCoordinator,
		command: string,
		isError?: boolean,
	) {
		return {
			event: {
				toolName: "bash",
				input: { command },
				content: [{ type: "text", text: "out" }],
				...(isError ? { isError: true } : {}),
			},
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			biomeClient: {},
			ruffClient: {},
			testRunnerClient: {},
			metricsClient: {},
			resetLSPService: () => {},
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as unknown as Parameters<typeof handleToolResult>[0];
	}

	function callDeps(runtime: RuntimeCoordinator, command: string) {
		return {
			event: { toolName: "bash", input: { command } },
			ctx: { cwd: repoDir },
			lensEnabled: true,
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			ensureLSPConfigInitialized: async () => {},
			updateLspStatus: () => {},
			resetLSPService: () => {},
		} as Parameters<typeof handleToolCall>[0];
	}

	function nodeScriptFile(script: string): string {
		const file = path.join(repoDir, `.opaque-child-${Date.now()}.cjs`);
		fs.writeFileSync(file, script, "utf8");
		// Written BEFORE the baseline by construction - backdate it out of the
		// recovery window so only the child's own writes are attributed.
		const past = new Date(Date.now() - 5000);
		fs.utimesSync(file, past, past);
		return file;
	}

	function readChangeLog(): ProjectChangeEntry[] {
		const logPath = getProjectChangeLogPath(repoDir);
		if (!fs.existsSync(logPath)) return [];
		return fs
			.readFileSync(logPath, "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l) as ProjectChangeEntry);
	}

	beforeEach(() => {
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-opaque-partial-"));
		execSync("git init -q", { cwd: repoDir });
		process.env.PILENS_DATA_DIR = path.join(repoDir, "data");
	});

	afterEach(() => {
		delete process.env.PILENS_DATA_DIR;
		removeTempDirSync(repoDir);
	});

	it("mixed command: redirect once as agent-write, internal write as opaque-script", async () => {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = repoDir;
		runtime.setTelemetryIdentity({ sessionId: "partial-a" });
		const redirectTarget = path.join(repoDir, "redirected-out.txt");
		const internalFile = path.join(repoDir, "internal-write.txt");
		const scriptFile = nodeScriptFile(
			`require('fs').writeFileSync(${JSON.stringify(redirectTarget)}, 'redirected');require('fs').writeFileSync(${JSON.stringify(internalFile)}, 'internal');`,
		);
		try {
			// Redirect is RECOGNIZED by the extractor; the internal write is not.
			const command = `node "${scriptFile}" > "${redirectTarget}"`;
			await handleToolCall(callDeps(runtime, command));
			execSync(`node "${scriptFile}"`, { cwd: repoDir });
			await handleToolResult(depsFor(runtime, command));

			const sources = readChangeLog().reduce(
				(acc, e) => {
					acc[path.basename(e.filePath)] = e.source;
					return acc;
				},
				{} as Record<string, string>,
			);
			expect(sources["redirected-out.txt"]).toBe("agent-write");
			expect(sources["internal-write.txt"]).toBe("opaque-script");
		} finally {
			fs.rmSync(scriptFile, { force: true });
		}
	});

	it("recognized-only command without baseline emits explicit coverage-unknown", async () => {
		// latency.log writes are guarded by PI_LENS_TEST_MODE; scope the opt-out
		// to this one assertion (#1742 sanctioned pattern).
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = repoDir;
		runtime.setTelemetryIdentity({ sessionId: "partial-b" });
		try {
			const outTarget = path.join(repoDir, "echo-out.txt");
			const command = `node -e "" > "${outTarget}"`;
			// No handleToolCall baseline on purpose.
			// Delta assertion: latency.log is append-only and shared, so assert
			// on the LINES THIS RUN ADDED - a plain toContain would stay green
			// forever after the first ever emission (review round-2 P2).
			const latencyPath = path.join(getGlobalPiLensDir(), "latency.log");
			const beforeLines = new Set(
				fs.existsSync(latencyPath)
					? fs.readFileSync(latencyPath, "utf8").split("\n")
					: [],
			);
			await handleToolResult(depsFor(runtime, command));
			await flushLatencyLog();
			const appended = fs
				.readFileSync(latencyPath, "utf8")
				.split("\n")
				.filter((l) => l.trim() && !beforeLines.has(l));
			expect(
				appended.some((l) => l.includes("partial-recognition-no-baseline")),
			).toBe(true);
		} finally {
			if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousTestMode;
		}
	});

	// #2060 F6: the coverage-unknown record used to require at least one
	// recognized path, so a fully opaque command whose git probe failed recorded
	// nothing at all — the exact shape whose coverage is least knowable.
	it(
		"emits coverage-unknown when a fully opaque command's git probe fails",
		{ timeout: 20_000 },
		async () => {
			const previousTestMode = process.env.PI_LENS_TEST_MODE;
			process.env.PI_LENS_TEST_MODE = "0";
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = repoDir;
			runtime.setTelemetryIdentity({ sessionId: "partial-d" });
			try {
				const scriptFile = nodeScriptFile("");
				const command = `node "${scriptFile}"`;
				expect(extractWrittenPathsFromCommand(command, repoDir)).toEqual([]);
				await handleToolCall(callDeps(runtime, command));
				// Break the probe AFTER the baseline: git status now exits nonzero.
				fs.writeFileSync(path.join(repoDir, ".git", "index"), "corrupt");

				const latencyPath = path.join(getGlobalPiLensDir(), "latency.log");
				const beforeLines = new Set(
					fs.existsSync(latencyPath)
						? fs.readFileSync(latencyPath, "utf8").split("\n")
						: [],
				);
				await handleToolResult(depsFor(runtime, command));
				await flushLatencyLog();
				const appended = fs
					.readFileSync(latencyPath, "utf8")
					.split("\n")
					.filter((l) => l.trim() && !beforeLines.has(l));
				expect(
					appended.some(
						(l) =>
							l.includes("opaque_mutation_coverage_unknown") &&
							l.includes("git-failed"),
					),
					appended.join("\n"),
				).toBe(true);
			} finally {
				if (previousTestMode === undefined)
					delete process.env.PI_LENS_TEST_MODE;
				else process.env.PI_LENS_TEST_MODE = previousTestMode;
			}
		},
	);

	it("failed mixed command attributes BOTH writes as opaque-script (failure atomicity)", async () => {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = repoDir;
		runtime.setTelemetryIdentity({ sessionId: "partial-c" });
		const redirectTarget = path.join(repoDir, "failed-redirect.txt");
		const internalFile = path.join(repoDir, "failed-internal.txt");
		const scriptFile = nodeScriptFile(
			`require('fs').writeFileSync(${JSON.stringify(redirectTarget)}, 'r');require('fs').writeFileSync(${JSON.stringify(internalFile)}, 'i');`,
		);
		try {
			const command = `node "${scriptFile}" > "${redirectTarget}"`;
			await handleToolCall(callDeps(runtime, command));
			// Writes land BEFORE the failure surfaces (isError=true).
			execSync(`node "${scriptFile}"`, { cwd: repoDir });
			await handleToolResult(depsFor(runtime, command, true));

			const opaqueFiles = readChangeLog()
				.filter((e) => e.source === "opaque-script")
				.map((e) => path.basename(e.filePath))
				.sort();
			expect(opaqueFiles).toEqual([
				"failed-internal.txt",
				"failed-redirect.txt",
			]);
		} finally {
			fs.rmSync(scriptFile, { force: true });
		}
	});
});

// #2060 F3: the family, with a verdict per member. A table so that adding or
// dropping a subcommand cannot be a silent edit — every member is pinned here,
// including the ones deliberately left OUT and why.
describe("git integration command family", () => {
	it.each([
		["git merge origin/main", true],
		["git rebase origin/main", true],
		["git cherry-pick abc123", true],
		["git pull --no-rebase origin main", true],
		["git revert --no-edit HEAD", true],
		["git am --3way patch.mbox", true],
		// OUT: the incoming content is the agent's own work.
		["git stash pop", false],
		["git stash apply", false],
		["git checkout -m other", false],
		["git apply -3 fix.patch", false],
		// OUT: not integrations at all.
		["git status --porcelain", false],
		["git commit -am wip", false],
		["python gen.py", false],
	])("classifies %j as integration=%s", (command, expected) => {
		expect(isFailedGitIntegrationCommand(command, true)).toBe(expected);
	});

	it("stays inert unless the command actually failed", () => {
		expect(isFailedGitIntegrationCommand("git merge origin/main", false)).toBe(
			false,
		);
		expect(
			isFailedGitIntegrationCommand("git merge origin/main", undefined),
		).toBe(false);
	});

	it("reads past git's value-taking global options", () => {
		expect(isFailedGitIntegrationCommand("git -C /repo merge main", true)).toBe(
			true,
		);
		expect(
			isFailedGitIntegrationCommand("git -c core.x=1 cherry-pick abc", true),
		).toBe(true);
	});
});

describe("failed Git integration recovery dispatch", () => {
	let repoDir = "";

	beforeEach(() => {
		repoDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-opaque-integration-"),
		);
		execSync("git init -q", { cwd: repoDir });
		execSync("git config user.email t@t.local", { cwd: repoDir });
		execSync("git config user.name t", { cwd: repoDir });
		fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(repoDir, "src", "conflict.ts"), "base\n");
		fs.writeFileSync(path.join(repoDir, "src", "imported.ts"), "base\n");
		execSync("git add -A && git commit -qm base", { cwd: repoDir });
	});

	afterEach(() => removeTempDirSync(repoDir));

	function integrationRuntime(sessionId: string): RuntimeCoordinator {
		const runtime = new RuntimeCoordinator();
		runtime.projectRoot = repoDir;
		runtime.setTelemetryIdentity({ sessionId });
		return runtime;
	}

	function callDepsFor(runtime: RuntimeCoordinator, command: string) {
		return {
			event: { toolName: "bash", input: { command } },
			ctx: { cwd: repoDir },
			lensEnabled: true,
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			ensureLSPConfigInitialized: async () => {},
			updateLspStatus: () => {},
			resetLSPService: () => {},
		} as Parameters<typeof handleToolCall>[0];
	}

	function resultDepsFor(runtime: RuntimeCoordinator, command: string) {
		return {
			event: {
				toolName: "bash",
				isError: true,
				input: { command },
				content: [{ type: "text", text: "merge conflict" }],
			},
			getFlag: () => false,
			dbg: () => {},
			runtime,
			cacheManager: new CacheManager(false),
			biomeClient: {},
			ruffClient: {},
			testRunnerClient: {},
			metricsClient: {},
			resetLSPService: () => {},
			agentBehaviorRecord: () => [],
			formatBehaviorWarnings: () => "",
		} as unknown as Parameters<typeof handleToolResult>[0];
	}

	it(
		"does not synthesize dispatches for clean incoming merge paths",
		{ timeout: 30_000 },
		async () => {
			const conflict = path.join(repoDir, "src", "conflict.ts");
			const imported = path.join(repoDir, "src", "imported.ts");
			const added = path.join(repoDir, "src", "added.ts");
			execSync("git checkout -qb incoming", { cwd: repoDir });
			fs.writeFileSync(conflict, "incoming\n");
			fs.writeFileSync(imported, "incoming\n");
			fs.writeFileSync(added, "added\n");
			execSync("git add -A && git commit -qm incoming", { cwd: repoDir });
			execSync("git checkout -q master", { cwd: repoDir });
			fs.writeFileSync(conflict, "local\n");
			execSync("git add -A && git commit -qm local", { cwd: repoDir });

			const runtime = integrationRuntime("failed-integration");
			const command = "git merge incoming";
			const { runPipeline } = await import("../../clients/pipeline.js");
			vi.mocked(runPipeline).mockClear();

			await handleToolCall(callDepsFor(runtime, command));
			expect(() => execSync(command, { cwd: repoDir })).toThrow();
			const worktreeSide = path.join(repoDir, "src", "worktree-side.ts");
			fs.writeFileSync(worktreeSide, "worktree side\n");
			await handleToolResult(resultDepsFor(runtime, command));

			const dispatched = vi
				.mocked(runPipeline)
				.mock.calls.map(([ctx]) => String(ctx?.filePath));
			// Compare on normalized keys: dispatch filePaths are normalizeMapKey
			// forms, so raw path.join strings only match on POSIX (catalog shape 2).
			expect(dispatched).toEqual(
				expect.arrayContaining([
					normalizeMapKey(conflict),
					normalizeMapKey(worktreeSide),
				]),
			);
			expect(dispatched).not.toContain(normalizeMapKey(imported));
			expect(dispatched).not.toContain(normalizeMapKey(added));
		},
	);

	// #2060 F3: `git pull` is `git fetch` plus `git merge`, so a conflicted pull
	// leaves the same unmerged index plus clean incoming entries. The original
	// subcommand set covered merge/rebase/cherry-pick only, so a pull still
	// dispatched every incoming file.
	it(
		"does not synthesize dispatches after a conflicted git pull",
		{ timeout: 30_000 },
		async () => {
			const conflict = path.join(repoDir, "src", "conflict.ts");
			const imported = path.join(repoDir, "src", "imported.ts");
			const originDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-opaque-origin-"),
			);
			try {
				execSync(`git clone -q "${repoDir}" "${originDir}"`);
				execSync("git config user.email t@t.local", { cwd: originDir });
				execSync("git config user.name t", { cwd: originDir });
				fs.writeFileSync(
					path.join(originDir, "src", "conflict.ts"),
					"remote\n",
				);
				fs.writeFileSync(
					path.join(originDir, "src", "imported.ts"),
					"remote\n",
				);
				execSync("git add -A && git commit -qm remote", { cwd: originDir });

				fs.writeFileSync(conflict, "local\n");
				execSync("git add -A && git commit -qm local", { cwd: repoDir });
				const branch = execSync("git rev-parse --abbrev-ref HEAD", {
					cwd: repoDir,
					encoding: "utf8",
				}).trim();

				const runtime = integrationRuntime("failed-pull");
				const command = `git pull --no-rebase "${originDir}" ${branch}`;
				const { runPipeline } = await import("../../clients/pipeline.js");
				vi.mocked(runPipeline).mockClear();

				await handleToolCall(callDepsFor(runtime, command));
				expect(() => execSync(command, { cwd: repoDir })).toThrow();
				await handleToolResult(resultDepsFor(runtime, command));

				const dispatched = vi
					.mocked(runPipeline)
					.mock.calls.map(([ctx]) => String(ctx?.filePath));
				expect(dispatched).toContain(normalizeMapKey(conflict));
				expect(dispatched).not.toContain(normalizeMapKey(imported));
			} finally {
				removeTempDirSync(originDir);
			}
		},
	);

	// #2060 F7: over-exclusion is silent by construction — the dropped files
	// simply never appear. This record is the only production evidence that the
	// filter ran and how much it removed.
	it(
		"records how many incoming paths the filter excluded",
		{ timeout: 30_000 },
		async () => {
			const previousTestMode = process.env.PI_LENS_TEST_MODE;
			process.env.PI_LENS_TEST_MODE = "0";
			try {
				const conflict = path.join(repoDir, "src", "conflict.ts");
				execSync("git checkout -qb incoming", { cwd: repoDir });
				fs.writeFileSync(conflict, "incoming\n");
				fs.writeFileSync(
					path.join(repoDir, "src", "imported.ts"),
					"incoming\n",
				);
				fs.writeFileSync(path.join(repoDir, "src", "added.ts"), "added\n");
				execSync("git add -A && git commit -qm incoming", { cwd: repoDir });
				execSync("git checkout -q master", { cwd: repoDir });
				fs.writeFileSync(conflict, "local\n");
				execSync("git add -A && git commit -qm local", { cwd: repoDir });

				const runtime = integrationRuntime("failed-integration-telemetry");
				const command = "git merge incoming";
				const latencyPath = path.join(getGlobalPiLensDir(), "latency.log");
				const beforeLines = new Set(
					fs.existsSync(latencyPath)
						? fs.readFileSync(latencyPath, "utf8").split("\n")
						: [],
				);

				await handleToolCall(callDepsFor(runtime, command));
				expect(() => execSync(command, { cwd: repoDir })).toThrow();
				await handleToolResult(resultDepsFor(runtime, command));
				await flushLatencyLog();

				const appended = fs
					.readFileSync(latencyPath, "utf8")
					.split("\n")
					.filter((l) => l.trim() && !beforeLines.has(l));
				const record = appended.find((l) =>
					l.includes("opaque_mutation_incoming_excluded"),
				);
				expect(record, appended.join("\n")).toBeDefined();
				expect(record).toContain("excluded:2");
			} finally {
				if (previousTestMode === undefined)
					delete process.env.PI_LENS_TEST_MODE;
				else process.env.PI_LENS_TEST_MODE = previousTestMode;
			}
		},
	);

	// #2081: the excluded-count record above proves one of the two new latency
	// records fires; this pins the other. A real, undocumented-but-well-formed
	// porcelain pair is not reproducible through real git, so this overrides
	// one call of the scan seam directly - the assertion is still on the
	// production callsite (clients/runtime-tool-result.ts) and its logLatency
	// call, so renaming the phase string reds this exactly as it reds the
	// excluded-count test above.
	it(
		"records how many status pairs were kept as unknown",
		{ timeout: 30_000 },
		async () => {
			const previousTestMode = process.env.PI_LENS_TEST_MODE;
			process.env.PI_LENS_TEST_MODE = "0";
			try {
				vi.mocked(recoverOpaqueChangesViaGit).mockResolvedValueOnce({
					verdict: "recovered",
					paths: [],
					scannedCount: 0,
					unknownStatusCount: 2,
				});

				const runtime = integrationRuntime("failed-integration-unknown-pair");
				const command = "git merge incoming";
				const latencyPath = path.join(getGlobalPiLensDir(), "latency.log");
				const beforeLines = new Set(
					fs.existsSync(latencyPath)
						? fs.readFileSync(latencyPath, "utf8").split("\n")
						: [],
				);

				await handleToolCall(callDepsFor(runtime, command));
				await handleToolResult(resultDepsFor(runtime, command));
				await flushLatencyLog();

				const appended = fs
					.readFileSync(latencyPath, "utf8")
					.split("\n")
					.filter((l) => l.trim() && !beforeLines.has(l));
				const record = appended.find((l) =>
					l.includes("opaque_mutation_status_pair_unknown"),
				);
				expect(record, appended.join("\n")).toBeDefined();
				expect(record).toContain("kept:2");
			} finally {
				if (previousTestMode === undefined)
					delete process.env.PI_LENS_TEST_MODE;
				else process.env.PI_LENS_TEST_MODE = previousTestMode;
			}
		},
	);
});
