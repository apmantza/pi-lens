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
import {
	appendProjectChange,
	type ProjectSequenceIndex,
	readLatestProjectSequence,
} from "../../clients/project-changes.js";
import { getDegradationSummary } from "../../clients/degradation-ledger.js";
import { HOOK_WALL_BUDGET_MS } from "../../clients/hook-budgets.js";
import {
	_resetProjectSnapshotParseCacheForTests,
	buildProjectSnapshotFromRuntime,
	getProjectSnapshotLegacyPath,
	isProjectSnapshotFresh,
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
	waitForProjectSnapshotPersistsForTests,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { _resetSubagentModeForTests } from "../../clients/subagent-mode.js";
import {
	createTempFile,
	setupTestEnvironment,
	useTrackedTempDirs,
} from "./test-utils.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { waitFor } from "./interleaving-kit.js";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";
import { observeTimerRelease } from "../support/timer-release.js";

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

import { handleSessionStart } from "../../clients/runtime-session.js";
import { resetLSPConfigStateForTests } from "../../clients/lsp/config.js";
import { pinFixtureHome } from "./test-utils.js";

// Session start and the warmup queue project-snapshot body writes that can
// recreate a fixture root after its `env.cleanup()`; the drain lets them land.
useTrackedTempDirs("pi-lens-seq-budget-");

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

/**
 * One real macrotask turn. Fake timers own `setTimeout` in the widened-budget
 * cell, so a `waitFor` there yields on this, never on the default delay.
 */
const yieldTick = () => new Promise<void>((resolve) => setImmediate(resolve));

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

	beforeEach(async () => {
		// The real config loader walks up from the session cwd to HOME (#4709);
		// a pinned fixture HOME keeps that read off the maintainer's home.
		pinFixtureHome("runtime-session-sequence-read-budget");
		await installLspServiceDouble();
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
		resetLSPConfigStateForTests();
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
				logEntries: 9,
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
			expect(seedSpy).toHaveBeenCalledWith(0, new Map(), undefined);

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
				expect(seedSpy).toHaveBeenCalledWith(42, slowResult.fileSeqByPath, 9);
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
				logEntries: 4,
			};
			readLatestProjectSequenceAsyncSpy.mockResolvedValue(fastResult);

			const runtime = new RuntimeCoordinator();
			const seedSpy = spyOnSeed(runtime);

			await handleSessionStart(makeDeps(cwd, runtime));

			expect(seedSpy).toHaveBeenCalledWith(3, fastResult.fileSeqByPath, 4);
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

	// Shape 4 (#1097): the sequence read's budget timer is released when the read
	// lands first. A hand-rolled copy that leaves it armed keeps a REF'd tail on a
	// one-shot `pi --print` process for the rest of the budget.
	it("releases the sequence read's budget timer once a healthy read lands", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-release-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS = "1234";
		const observer = observeTimerRelease(1234);
		try {
			const cwd = makeProject(env);
			readLatestProjectSequenceAsyncSpy.mockResolvedValue({
				projectSeq: 3,
				fileSeqByPath: new Map([["/some/other.ts", 1]]),
				logEntries: 4,
			});
			await handleSessionStart(makeDeps(cwd, new RuntimeCoordinator()));
			expect(observer.armed()).toHaveLength(1);
			expect(observer.unreleased()).toEqual([]);
		} finally {
			observer.restore();
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

	it("skips the body parse for an incomplete snapshot at the current seq, from its meta alone (#3511, #947)", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-incomplete-meta-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			saveProjectSnapshot(cwd, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: cwd,
				generatedAt: new Date().toISOString(),
				seq: 3,
				incomplete: true,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [],
			});
			readLatestProjectSequenceAsyncSpy.mockResolvedValue({
				projectSeq: 3,
				fileSeqByPath: new Map(),
			});

			await handleSessionStart(makeDeps(cwd, new RuntimeCoordinator()));

			expect(logLatencySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_snapshot_load",
					metadata: expect.objectContaining({
						fresh: false,
						skippedStale: true,
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it.each([
		["written by this process", false],
		["read back from disk", true],
	])(
		"does NOT retroactively hydrate from an incomplete snapshot at the confirmed seq, %s (#3511)",
		async (_source, fromDisk) => {
			// Saved at the seq the late read will confirm, but by a runtime that
			// missed a sibling's logged edit: never fresh.
			await runRetroHydrate({
				prefix: "pi-lens-seq-budget-retro-incomplete-",
				snapshot: { incomplete: true },
				fromDisk,
				lateRead: { projectSeq: 0, fileSeqByPath: new Map() },
				check: (runtime) => {
					expect(runtime.cachedExports.get("x")).toBeUndefined();
					expect(runtime.projectRulesScan.hasCustomRules).toBe(false);
				},
			});
		},
	);

	it.each([
		["written by this process", false, 0, false],
		["read back from disk", true, 0, false],
		["written by this process", false, 2, true],
		["read back from disk", true, 2, true],
	])(
		"retro hydrate at the confirmed seq with an unlocked entry at log position 1, %s (from disk: %s), snapshot folded %s entries, hydrated: %s (#3511 review round 2)",
		async (_source, fromDisk, logEntries, hydrated) => {
			await runRetroHydrate({
				prefix: "pi-lens-seq-budget-retro-unlocked-",
				snapshot: { logEntries },
				fromDisk,
				// The late read: the snapshot's seq, and an unlocked entry first in
				// the log, which only a snapshot that folded it can vouch for.
				lateRead: {
					projectSeq: 0,
					fileSeqByPath: new Map(),
					logEntries: 2,
					unlockedThrough: 1,
				},
				check: (runtime, exportedFile) => {
					expect(runtime.cachedExports.get("x")).toBe(
						hydrated ? exportedFile : undefined,
					);
				},
			});
		},
	);

	// Recurrence guarded: quick and full session_start each carried a private
	// ~60-line copy of the sequence-read -> freshness -> snapshot-load ->
	// hydrate step (jscpd, 87 duplicated lines) and now share
	// `readSequenceAndHydrateFreshSnapshot`. A drift between the copies (a
	// record, the cold-sentinel freshness seq, the hydrate) must red in the
	// mode that lost it; each cell drives the real `handleSessionStart` in one
	// mode through the seam.
	describe.each(["quick", "full"] as const)(
		"%s mode drives the shared sequence/snapshot step",
		(mode) => {
			const exportedPath = (cwd: string) => path.join(cwd, "index.ts");
			const saveSnapshotAt = (cwd: string, seq: number) =>
				saveProjectSnapshot(cwd, {
					version: PROJECT_SNAPSHOT_VERSION,
					projectRoot: cwd,
					generatedAt: new Date().toISOString(),
					seq,
					files: {},
					symbols: {},
					reverseDeps: {},
					cachedExports: [["x", exportedPath(cwd)]],
					projectRulesScan: { hasCustomRules: true, rules: [] },
				});
			const phaseRecord = (phase: string) =>
				logLatencySpy.mock.calls
					.map((call) => call[0] as { phase?: string; metadata?: object })
					.find((record) => record.phase === phase);

			it("a healthy read confirming a fresh snapshot hydrates the runtime and records both phases", async () => {
				process.env.PI_LENS_STARTUP_MODE = mode;
				const env = setupTestEnvironment(`pi-lens-seq-seam-fresh-${mode}-`);
				process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
				try {
					const cwd = makeProject(env);
					// Seq 3 is not the cold sentinel (0). The snapshot is fresh only when
					// the returned sequence reaches the freshness check: a fallback that
					// ignores it checks 0 against this snapshot and rejects it (#4977
					// review, Sourcery: a seq-0 pair passes either way).
					saveSnapshotAt(cwd, 3);
					readLatestProjectSequenceAsyncSpy.mockResolvedValue({
						projectSeq: 3,
						fileSeqByPath: new Map(),
						logEntries: 0,
					});
					const runtime = new RuntimeCoordinator();

					await handleSessionStart(makeDeps(cwd, runtime));

					expect(runtime.cachedExports.get("x")).toBe(exportedPath(cwd));
					expect(phaseRecord("session_start_sequence_read")?.metadata).toEqual(
						expect.objectContaining({ timedOut: false, entries: 0 }),
					);
					expect(phaseRecord("session_start_snapshot_load")?.metadata).toEqual(
						expect.objectContaining({ fresh: true, seq: 3 }),
					);
				} finally {
					env.cleanup();
				}
			});

			it("a stalled read never trusts the snapshot at session start, and records the unknown sequence (quick mode then hydrates late, #1785)", async () => {
				process.env.PI_LENS_STARTUP_MODE = mode;
				const env = setupTestEnvironment(`pi-lens-seq-seam-stall-${mode}-`);
				process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
				try {
					const cwd = makeProject(env);
					saveSnapshotAt(cwd, 0);
					const slow = deferred<ProjectSequenceIndex>();
					readLatestProjectSequenceAsyncSpy.mockImplementation(
						() => slow.promise,
					);
					const runtime = new RuntimeCoordinator();
					const dbgLines: string[] = [];

					await handleSessionStart(
						makeDeps(cwd, runtime, {
							dbg: (msg: string) => dbgLines.push(msg),
						}),
					);

					// The seq-0 snapshot would match the cold sentinel; the unknown
					// freshness seq keeps it from hydrating (#1168 finding 2).
					expect(runtime.cachedExports.get("x")).toBeUndefined();
					expect(phaseRecord("session_start_sequence_read")?.metadata).toEqual(
						expect.objectContaining({ timedOut: true }),
					);
					expect(phaseRecord("session_start_snapshot_load")?.metadata).toEqual(
						expect.objectContaining({ fresh: false, sequenceUnknown: true }),
					);
					expect(
						getDegradationSummary().find(
							(group) => group.kind === "snapshot-sequence-read-timeout",
						)?.count,
					).toBeGreaterThanOrEqual(1);

					// The late read lands. Only quick mode wires the retroactive
					// hydration (#1785); full mode passes no hook because its cold path
					// computes this state itself (the rescan below the shared step), so a
					// late fill from disk is unwanted there. The absence is observable:
					// the hook emits the "hydrating ... late" line always, and fills
					// `cachedExports` whenever the snapshot on disk still carries them
					// (mutation M4, #4977 review F2: wiring the hook into full mode reds
					// this cell).
					slow.resolve({ projectSeq: 0, fileSeqByPath: new Map() });
					// The session's own `.then` on this promise was registered first,
					// so this continuation runs after the deferred hydration.
					await slow.promise;
					const lateHydrationLine = dbgLines.some((line) =>
						line.includes("hydrating cachedExports/projectRulesScan late"),
					);
					if (mode === "quick") {
						expect(runtime.cachedExports.get("x")).toBe(exportedPath(cwd));
						expect(lateHydrationLine).toBe(true);
					} else {
						expect(runtime.cachedExports.get("x")).toBeUndefined();
						expect(lateHydrationLine).toBe(false);
					}
				} finally {
					env.cleanup();
				}
			});

			// Recurrence guarded: the step's one await of `readSequenceWithBudget`
			// sat unbounded on a hook path (hook-await-bounds census, #4977 review)
			// and its own race is capped only by an env-overridable budget, so a
			// widened budget stalled `session_start` past the hook's wall budget.
			// The race's own budget is now capped at the wall budget, so the arm
			// that owns the recovery (the deferred reseed and the #1785 late
			// hydration) is the one that fires. The first fix wrapped the await in
			// `bounded()` alone, which abandoned the read and silently dropped that
			// recovery (#4977 review F1: `runtime.projectSeq` stayed 0 once the read
			// landed with seq 2).
			it(
				"a read the widened sequence budget cannot cut is capped at the session_start wall budget, takes the unknown-sequence path, and still reseeds when it lands",
				async () => {
					process.env.PI_LENS_STARTUP_MODE = mode;
					// 2e9 ms: far above the 5s hook budget, below the 2^31 timer clamp.
					process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS = "2000000000";
					const env = setupTestEnvironment(`pi-lens-seq-seam-wall-${mode}-`);
					process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
					vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
					try {
						const cwd = makeProject(env);
						saveSnapshotAt(cwd, 0);
						const slow = deferred<ProjectSequenceIndex>();
						readLatestProjectSequenceAsyncSpy.mockImplementation(
							() => slow.promise,
						);
						const runtime = new RuntimeCoordinator();

						let settled = false;
						void handleSessionStart(makeDeps(cwd, runtime)).then(() => {
							settled = true;
						});
						// The sequence read is reached synchronously, so the clock advances on
						// the first yield after the call. The wait ends on `settled` under a
						// real-clock deadline, never on a count of event-loop turns (shape 86).
						await waitFor(() => settled, Boolean, {
							yieldControl: async () => {
								await yieldTick();
								if (readLatestProjectSequenceAsyncSpy.mock.calls.length > 0) {
									await vi.advanceTimersByTimeAsync(
										HOOK_WALL_BUDGET_MS.session_start,
									);
								}
							},
							timeoutMs: 5_000,
						});

						expect(runtime.cachedExports.get("x")).toBeUndefined();
						expect(runtime.projectSeq).toBe(0);
						expect(
							phaseRecord("session_start_sequence_read")?.metadata,
						).toEqual(expect.objectContaining({ timedOut: true, entries: 0 }));
						expect(
							phaseRecord("session_start_snapshot_load")?.metadata,
						).toEqual(
							expect.objectContaining({ fresh: false, sequenceUnknown: true }),
						);
						// The inner arm owns the wait, so the outer `bounded()` never fires
						// first and writes no degradation row (#4977 review F4). Narrowing
						// the outer bound to 1000 writes one on every stalled start while the
						// recovery still runs, so only this line reds that mutant.
						expect(
							getDegradationSummary()
								.find((group) => group.kind === "hook-await-exceeded")
								?.latestReasons.map((row) => row.subject) ?? [],
						).not.toContain("session_start:readSequenceWithBudget");

						// The read lands after the wall: the recovery still runs.
						slow.resolve({
							projectSeq: 2,
							fileSeqByPath: new Map([["/some/file.ts", 2]]),
							logEntries: 2,
						});
						await waitFor(
							() => runtime.projectSeq,
							(seq) => seq === 2,
							{
								yieldControl: yieldTick,
								timeoutMs: 2_000,
							},
						);
						expect(
							phaseRecord("session_start_sequence_read_deferred_reseed")
								?.metadata,
						).toEqual(expect.objectContaining({ deferred: true, entries: 1 }));
					} finally {
						vi.useRealTimers();
						env.cleanup();
					}
				},
				scaledTestTimeout(15_000),
			);
		},
	);

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
			expect(seedSpy).toHaveBeenCalledWith(0, new Map(), undefined);
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
			expect(seedSpy).toHaveBeenCalledWith(0, new Map(), undefined);
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

			// The guard must not reseed over the bump — no clobber. Since #3511
			// review B2 it folds the late read in instead of dropping it: the
			// seq only rises, and every file keeps its highest seq.
			expect(seedSpy).not.toHaveBeenCalled();
			expect(logLatencySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "session_start_sequence_read_deferred_reseed",
					metadata: expect.objectContaining({ merged: true }),
				}),
			);
			// The in-window bump survives completely untouched.
			expect(runtime.getFileSeq(editedFile)).toBe(1);
			expect(runtime.getFileSeq("/some/other-file.ts")).toBe(7);
			expect(runtime.projectSeq).toBe(42);
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #3511 review B2: a timed-out read seeds projectSeq 0 with an empty view.
	 * The first logged in-window edit then finds the log above it, so the
	 * runtime marks its view incomplete. The late read must fold in and clear
	 * that mark when it covers everything the edit missed; before, the reseed
	 * was skipped once projectSeq > 0 and the mark held for the session.
	 */
	function logEntries(cwd: string, seqs: number[]): void {
		for (const seq of seqs) {
			appendProjectChange(cwd, {
				seq,
				timestamp: new Date(0).toISOString(),
				sessionId: "earlier",
				turnIndex: 0,
				source: "agent-write",
				filePath: path.join(cwd, `f${seq}.ts`),
				fileSeq: 1,
			});
		}
	}

	async function settleDeferredRead(): Promise<void> {
		for (let i = 0; i < 20; i++) await Promise.resolve();
	}

	/**
	 * The retro-hydrate replay (#3511): save a snapshot at the seq the late
	 * read will confirm, optionally drop the in-process copy so the narrow
	 * loader parses disk, start a session whose sequence read is still
	 * pending, then land that read and hand the runtime to `check`.
	 */
	async function runRetroHydrate(args: {
		prefix: string;
		snapshot: { incomplete?: true; logEntries?: number };
		fromDisk: boolean;
		lateRead: ProjectSequenceIndex;
		check: (runtime: RuntimeCoordinator, exportedFile: string) => void;
	}): Promise<void> {
		const env = setupTestEnvironment(args.prefix);
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			const exportedFile = path.join(cwd, "index.ts");
			saveProjectSnapshot(cwd, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: cwd,
				generatedAt: new Date().toISOString(),
				seq: 0,
				...args.snapshot,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [["x", exportedFile]],
				projectRulesScan: { hasCustomRules: true, rules: [] },
			});
			if (args.fromDisk) {
				// A fresh process: no in-process copy, the narrow loader parses disk.
				await waitForProjectSnapshotPersistsForTests();
				_resetProjectSnapshotParseCacheForTests();
			}

			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			await handleSessionStart(makeDeps(cwd, runtime));
			slow.resolve(args.lateRead);
			await settleDeferredRead();
			args.check(runtime, exportedFile);
		} finally {
			env.cleanup();
		}
	}

	it("clears an in-window edit's incomplete mark once the late sequence read covers what it missed (#3511 review B2)", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-merge-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			logEntries(cwd, [1, 2, 3, 4, 5]);
			const before = readLatestProjectSequence(cwd);
			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			await handleSessionStart(makeDeps(cwd, runtime));
			expect(runtime.projectSeq).toBe(0);
			runtime.recordProjectMutation({
				filePath: path.join(cwd, "index.ts"),
				source: "agent-write",
				cwd,
			});
			expect(runtime.projectSeq).toBe(6);
			expect(runtime.viewMissesLoggedEntries).toBe(true);

			slow.resolve(before);
			await settleDeferredRead();

			expect(runtime.viewMissesLoggedEntries).toBe(false);
			expect(runtime.projectSeq).toBe(6);
			const snapshot = buildProjectSnapshotFromRuntime({ cwd, runtime });
			// The merge carries the late read's fold point (review round 2).
			expect(snapshot.logEntries).toBe(5);
			expect(
				isProjectSnapshotFresh(
					snapshot,
					readLatestProjectSequence(cwd).projectSeq,
				),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the incomplete mark when the late sequence read predates an entry the edit missed (#3511 review B2)", async () => {
		const env = setupTestEnvironment("pi-lens-seq-budget-merge-old-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			logEntries(cwd, [1, 2, 3, 4, 5]);
			const before = readLatestProjectSequence(cwd);
			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			await handleSessionStart(makeDeps(cwd, runtime));
			// A sibling logs seq 6 after the read, before our in-window edit.
			logEntries(cwd, [6]);
			runtime.recordProjectMutation({
				filePath: path.join(cwd, "index.ts"),
				source: "agent-write",
				cwd,
			});
			expect(runtime.projectSeq).toBe(7);

			slow.resolve(before);
			await settleDeferredRead();

			expect(runtime.viewMissesLoggedEntries).toBe(true);
			expect(runtime.projectSeq).toBe(7);
			expect(buildProjectSnapshotFromRuntime({ cwd, runtime }).incomplete).toBe(
				true,
			);
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

	// RECURRENCE GUARDED: #4911. The snapshot root's home ceiling compared
	// spellings, so with a HOME or a cwd spelled through a link the nearest
	// marker at the home became the snapshot root: the session read (and
	// later wrote) the whole home's project state. The read is the observable:
	// its root argument is the snapshot root `session_start` chose. Both
	// directions, each with a real directory link and the real `os.homedir()`.
	it.each([["home-link"], ["root-link"]] as const)(
		"keeps the snapshot root at the cwd when the %s spelling puts the nearest marker at the home (#4911)",
		async (kind) => {
			const env = setupTestEnvironment("pi-lens-seq-budget-home-link-");
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			const pin = pinFixtureHome("runtime-session-4911");
			try {
				fs.mkdirSync(path.join(pin.home, ".git"), { recursive: true });
				fs.mkdirSync(path.join(pin.home, "proj"), { recursive: true });
				const link = path.join(env.tmpDir, "link");
				fs.symlinkSync(pin.home, link, "junction");
				if (kind === "home-link") {
					vi.stubEnv("HOME", link);
					vi.stubEnv("USERPROFILE", link);
				}
				const cwd = path.join(kind === "root-link" ? link : pin.home, "proj");
				readLatestProjectSequenceAsyncSpy.mockResolvedValue({
					projectSeq: 0,
					fileSeqByPath: new Map(),
					logEntries: 0,
				});

				await handleSessionStart(makeDeps(cwd, new RuntimeCoordinator()));

				const roots = new Set(
					readLatestProjectSequenceAsyncSpy.mock.calls.map((call) => call[0]),
				);
				expect([...roots]).toEqual([cwd]);
			} finally {
				vi.unstubAllEnvs();
				pin.restore();
				env.cleanup();
			}
		},
	);
});
