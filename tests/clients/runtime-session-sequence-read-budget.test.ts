/**
 * Regression tests for #1162 — `session_start_sequence_read` was a
 * synchronous, UNBOUNDED blocking read (`fs.readFileSync`) on the
 * session_start critical path. Normally ~2ms, but under host I/O pressure it
 * balloons with no escape hatch (2125ms observed in production latency.log).
 *
 * A `setTimeout`/`Promise.race` timeout can never preempt a *synchronous*
 * read — the thread only returns to the event loop once the OS call
 * returns — so the fix switches the read to `fs.promises.readFile`
 * (`readLatestProjectSequenceAsync`), which genuinely yields, and races it
 * against a budget (`readSequenceWithBudget` in `clients/runtime-session.ts`,
 * default 250ms, overridable via `PI_LENS_SEQUENCE_READ_BUDGET_MS` for
 * tests). On timeout, session_start proceeds immediately with a safe
 * cold-start sequence (`{ projectSeq: 0, fileSeqByPath: empty }` — this only
 * gates snapshot freshness, never correctness) and the real read keeps
 * running in the background, re-seeding the runtime once it resolves.
 *
 * These tests inject a controllable slow read (a stubbed
 * `readLatestProjectSequenceAsync` that resolves only when the test tells
 * it to) instead of a real wall-clock sleep, per #1024's OS-agnostic
 * discipline — no flaky timing assumptions, and it proves the bound holds
 * even when the underlying read has not yet returned at all. The "healthy
 * path" test proves the fast case is unaffected. The cold-start/deferred-
 * reseed tests FAIL on pre-fix code: pre-fix, `handleSessionStart` calls the
 * SYNC `readLatestProjectSequence` against the real filesystem — it ignores
 * this test's async mock entirely (so it also returns quickly, just with the
 * wrong un-bounded-by-design result) and never produces a `timedOut` metadata
 * flag or a cold-start/deferred-reseed sequence, which is what these tests
 * actually assert on.
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSequenceIndex } from "../../clients/project-changes.js";
import { getDegradationSummary } from "../../clients/degradation-ledger.js";
import {
	getProjectSnapshotLegacyPath,
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { _resetSubagentModeForTests } from "../../clients/subagent-mode.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const logLatencySpy = vi.hoisted(() => vi.fn());
const readLatestProjectSequenceAsyncSpy = vi.hoisted(() => vi.fn());

vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency: logLatencySpy };
});

vi.mock("../../clients/project-changes.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/project-changes.js")>();
	return {
		...actual,
		readLatestProjectSequenceAsync: readLatestProjectSequenceAsyncSpy,
	};
});

vi.mock("../../clients/lsp/config.js", () => ({
	loadLSPConfig: vi.fn().mockResolvedValue({}),
	initLSPConfig: vi.fn().mockResolvedValue(undefined),
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(() => makeLspServiceDouble()),
}));

import { handleSessionStart } from "../../clients/runtime-session.js";

function makeDeps(
	ctxCwd: string,
	runtime: RuntimeCoordinator,
	overrides: Record<string, unknown> = {},
) {
	return withResidentBootstrap({
		ctxCwd,
		getFlag: () => false,
		notify: vi.fn(),
		dbg: () => {},
		log: () => {},
		runtime,
		metricsClient: { reset: () => {} },
		cacheManager: { writeCache: () => {}, readCache: () => null },
		todoScanner: { scanDirectory: () => ({ items: [] }) },
		astGrepClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
			scanExports: async () => new Map(),
		},
		biomeClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		ruffClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		knipClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		jscpdClient: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		depChecker: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		testRunnerClient: {
			detectRunner: () => null,
			runTestFile: () => ({ failed: 0, error: false }),
		},
		goClient: { isGoAvailableAsync: async () => false },
		rustClient: { isAvailableAsync: async () => false },
		ensureTool: vi.fn(async () => null),
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
		...overrides,
	}) as any;
}

function makeProject(env: { tmpDir: string }): string {
	const cwd = path.join(env.tmpDir, "project");
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");
	return cwd;
}

/** A deferred promise the test controls the settle timing of. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function spyOnSeed(runtime: RuntimeCoordinator): ReturnType<typeof vi.fn> {
	const seedSpy = vi.fn();
	const original = runtime.seedProjectSequence.bind(runtime);
	runtime.seedProjectSequence = ((...args: [number, Map<string, number>?]) => {
		seedSpy(...args);
		return (original as (...a: typeof args) => void)(...args);
	}) as typeof runtime.seedProjectSequence;
	return seedSpy;
}

describe("#1162 — bounded session_start sequence read", () => {
	const globals = globalThis as unknown as {
		__piLensFirstSessionDone?: boolean;
		__piLensWarmupScheduled?: boolean;
	};
	let prevArgv: string[];
	let prevStartupMode: string | undefined;
	let prevBudget: string | undefined;
	let prevDelay: string | undefined;
	let prevDataDir: string | undefined;
	let prevFirst: boolean | undefined;
	let prevWarmup: boolean | undefined;

	beforeEach(() => {
		prevArgv = process.argv;
		prevStartupMode = process.env.PI_LENS_STARTUP_MODE;
		prevBudget = process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS;
		prevDelay = process.env.PI_LENS_WARMUP_DELAY_MS;
		prevDataDir = process.env.PILENS_DATA_DIR;
		prevFirst = globals.__piLensFirstSessionDone;
		prevWarmup = globals.__piLensWarmupScheduled;
		// Avoid the unrelated first-session quick-warmup heuristic (#1154)
		// firing background work that would confuse these assertions.
		globals.__piLensFirstSessionDone = true;
		globals.__piLensWarmupScheduled = true;
		process.env.PI_LENS_STARTUP_MODE = "quick";
		process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS = "30";
		process.argv = prevArgv.filter((a) => a !== "--print" && a !== "-p");
		logLatencySpy.mockClear();
		readLatestProjectSequenceAsyncSpy.mockReset();
		_resetSubagentModeForTests();
	});

	afterEach(() => {
		process.argv = prevArgv;
		if (prevStartupMode === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prevStartupMode;
		if (prevBudget === undefined)
			delete process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS;
		else process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS = prevBudget;
		if (prevDelay === undefined) delete process.env.PI_LENS_WARMUP_DELAY_MS;
		else process.env.PI_LENS_WARMUP_DELAY_MS = prevDelay;
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		globals.__piLensFirstSessionDone = prevFirst;
		globals.__piLensWarmupScheduled = prevWarmup;
		vi.restoreAllMocks();
		_resetSubagentModeForTests();
	});

	it("returns within budget and falls back to cold-start when the sequence read stalls, then reseeds in the background once it resolves", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-slow-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			const slowResult: ProjectSequenceIndex = {
				projectSeq: 42,
				fileSeqByPath: new Map([["/some/file.ts", 7]]),
			};
			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			const seedSpy = spyOnSeed(runtime);

			const startedAt = Date.now();
			await handleSessionStart(makeDeps(cwd, runtime));
			const elapsed = Date.now() - startedAt;

			// Bounded: session_start returned even though the injected read has
			// NOT resolved yet. This line alone does NOT distinguish pre-/post-fix
			// (pre-fix code calls the SYNC `readLatestProjectSequence` against the
			// real filesystem, ignores this mock entirely, and also returns fast —
			// it just returns the wrong, un-bounded-by-design result). The real
			// pre-fix failures are below: the missing `timedOut` metadata flag and
			// the absent cold-start/deferred-reseed behavior, which only the
			// bounded-async path produces. Generous slack above the 30ms budget
			// absorbs CI scheduling jitter while staying far below any real
			// host-pressure stall.
			expect(elapsed).toBeLessThan(2000);

			// Cold-start fallback: seeded with the safe empty sentinel.
			expect(seedSpy).toHaveBeenCalledWith(0, new Map());

			// Never silent (shape 10): the latency line distinguishes the
			// fallback from a healthy read.
			expect(logLatencySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_sequence_read",
					metadata: expect.objectContaining({ timedOut: true }),
				}),
			);

			// Now let the slow read resolve and confirm the deferred reseed runs.
			seedSpy.mockClear();
			logLatencySpy.mockClear();
			slow.resolve(slowResult);
			await vi.waitFor(() => {
				expect(seedSpy).toHaveBeenCalledWith(42, slowResult.fileSeqByPath);
			});
			expect(logLatencySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_sequence_read_deferred_reseed",
					metadata: expect.objectContaining({ deferred: true, entries: 1 }),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("seeds normally on a healthy (fast) read — no fallback", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-fast-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			const fastResult: ProjectSequenceIndex = {
				projectSeq: 3,
				fileSeqByPath: new Map([["/some/other.ts", 1]]),
			};
			readLatestProjectSequenceAsyncSpy.mockResolvedValue(fastResult);

			const runtime = new RuntimeCoordinator();
			const seedSpy = spyOnSeed(runtime);

			await handleSessionStart(makeDeps(cwd, runtime));

			expect(seedSpy).toHaveBeenCalledWith(3, fastResult.fileSeqByPath);
			expect(logLatencySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_sequence_read",
					metadata: expect.objectContaining({ timedOut: false }),
				}),
			);
			// Healthy path never falls back — no deferred-reseed phase logged.
			expect(logLatencySpy).not.toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_sequence_read_deferred_reseed",
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("retroactively hydrates cachedExports/projectRulesScan once the deferred sequence read confirms the snapshot was fresh (#1785)", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-retro-hydrate-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			const exportedFile = path.join(cwd, "index.ts");
			// A snapshot saved with NO changes since (seq 0, matching an empty
			// change log) — the real answer once the stalled read resolves will
			// confirm it was fresh all along.
			saveProjectSnapshot(cwd, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: cwd,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [["x", exportedFile]],
				projectRulesScan: { hasCustomRules: true, rules: [] },
			});

			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			await handleSessionStart(makeDeps(cwd, runtime));

			// Synchronous return: the read hasn't settled yet, so the freshness
			// gate correctly refuses to trust the snapshot (#1785's reported
			// symptom — cachedExports.get(...) is undefined right after
			// handleSessionStart, even though the snapshot really was current).
			expect(runtime.cachedExports.get("x")).toBeUndefined();
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "snapshot-sequence-read-timeout",
				)?.count,
			).toBeGreaterThanOrEqual(1);

			// The stalled read resolves and confirms: no changes since the
			// snapshot (projectSeq 0, matching its own seq). This is a
			// deterministic completion signal, not a sleep — the fix hydrates
			// once THIS promise settles, whenever that turns out to be.
			slow.resolve({ projectSeq: 0, fileSeqByPath: new Map() });
			await vi.waitFor(() => {
				expect(runtime.cachedExports.get("x")).toBe(exportedFile);
			});
			expect(runtime.projectRulesScan.hasCustomRules).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("does NOT retroactively hydrate when the deferred read reveals the snapshot is actually stale (#1785 guard is not vacuous)", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-retro-stale-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			const exportedFile = path.join(cwd, "index.ts");
			// Saved at seq 0, but the real log (revealed once the stalled read
			// resolves) has since moved to seq 5 — a genuinely stale snapshot.
			saveProjectSnapshot(cwd, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: cwd,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [["x", exportedFile]],
				projectRulesScan: { hasCustomRules: true, rules: [] },
			});

			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			await handleSessionStart(makeDeps(cwd, runtime));
			expect(runtime.cachedExports.get("x")).toBeUndefined();

			slow.resolve({ projectSeq: 5, fileSeqByPath: new Map() });
			// Give the deferred continuation a generous window to run (or, per
			// the guard, to observe the mismatch and correctly skip hydration).
			await new Promise((resolve) => setTimeout(resolve, 150));

			expect(runtime.cachedExports.get("x")).toBeUndefined();
			expect(runtime.projectRulesScan.hasCustomRules).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("does NOT reseed in the background for a one-shot `pi --print` invocation (shape 4 screen)", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-print-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		process.argv = [...prevArgv, "--print"];
		try {
			const cwd = makeProject(env);
			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			const seedSpy = spyOnSeed(runtime);

			await handleSessionStart(makeDeps(cwd, runtime));
			expect(seedSpy).toHaveBeenCalledWith(0, new Map());
			seedSpy.mockClear();
			logLatencySpy.mockClear();

			slow.resolve({ projectSeq: 99, fileSeqByPath: new Map() });
			// Give the (would-be) background continuation a generous window to
			// run if it were going to — post-fix it must not, since a one-shot
			// print process has no future session in this process to benefit.
			await new Promise((resolve) => setTimeout(resolve, 150));

			expect(seedSpy).not.toHaveBeenCalled();
			expect(logLatencySpy).not.toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_sequence_read_deferred_reseed",
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("does NOT clobber an in-window edit's bumped fileSeq — same-session advancement guard (review follow-up P3, closes #1168 finding 1)", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-advance-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			const seedSpy = spyOnSeed(runtime);

			await handleSessionStart(makeDeps(cwd, runtime));
			// Cold-start fallback, as in the slow-read test above.
			expect(seedSpy).toHaveBeenCalledWith(0, new Map());
			expect(runtime.projectSeq).toBe(0);

			// Simulate an agent edit landing IN the stall window: AFTER the cold
			// seed (session_start already returned) but BEFORE the deferred read
			// resolves.
			const editedFile = path.join(cwd, "index.ts");
			const bump = runtime.bumpFileSeq(editedFile);
			expect(bump.projectSeq).toBe(1);
			expect(runtime.getFileSeq(editedFile)).toBe(1);

			seedSpy.mockClear();
			logLatencySpy.mockClear();

			// The stalled read now resolves with a snapshot of the world from
			// BEFORE the edit above — reseeding with it would erase the bump.
			slow.resolve({
				projectSeq: 42,
				fileSeqByPath: new Map([["/some/other-file.ts", 7]]),
			});
			// Give the deferred continuation a generous window to run (or, per
			// the fix, to observe the advancement and skip).
			await new Promise((resolve) => setTimeout(resolve, 150));

			// The guard must have skipped the reseed entirely — no clobber.
			expect(seedSpy).not.toHaveBeenCalled();
			expect(logLatencySpy).not.toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_sequence_read_deferred_reseed",
				}),
			);
			// The in-window bump survives completely untouched.
			expect(runtime.getFileSeq(editedFile)).toBe(1);
			expect(runtime.projectSeq).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("treats a seq-0 persisted snapshot as STALE (never fresh) when the read times out — cold-sentinel aliasing guard (review follow-up P3, closes #1168 finding 2)", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-seq0-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);

			// A project's real first-ever snapshot: legitimately persisted at
			// seq === 0, before any change was ever logged. The timed-out read's
			// cold sentinel is ALSO projectSeq 0 — this is exactly the collision
			// #1168's review caught.
			const legacyPath = getProjectSnapshotLegacyPath(cwd);
			fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
			fs.writeFileSync(
				legacyPath,
				JSON.stringify({
					version: PROJECT_SNAPSHOT_VERSION,
					projectRoot: cwd,
					generatedAt: new Date().toISOString(),
					seq: 0,
					files: {},
					symbols: {},
					reverseDeps: {},
					cachedExports: [],
				}),
			);

			// The on-disk change log has since moved past seq 0 (a non-empty
			// log), but the read never returns within the budget — this test
			// only needs the timeout to fire, so the read is left pending.
			readLatestProjectSequenceAsyncSpy.mockImplementation(
				() => new Promise<ProjectSequenceIndex>(() => {}),
			);

			const runtime = new RuntimeCoordinator();
			await handleSessionStart(makeDeps(cwd, runtime));

			expect(logLatencySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_snapshot_load",
					metadata: expect.objectContaining({
						fresh: false,
						seq: 0,
						sequenceUnknown: true,
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});
});
