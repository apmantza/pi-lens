/**
 * Regression tests for #1785's review round finding F1 (HIGH, "Probe D"
 * shape): quick mode's own cold-start warmup (`PI_LENS_WARMUP_DELAY_MS`,
 * default 2000ms) can fire and save a snapshot built from the LIVE runtime
 * — which, while this same session_start's sequence read is still stalled
 * past its budget, has empty `cachedExports` — while the deferred
 * retroactive-hydration fix from the first #1785 round is still waiting on
 * that same stalled read. A naive re-load from disk at that point would read
 * the warmup's EMPTIED body, not the good one that existed when the stall
 * began — `isProjectSnapshotFresh` still says "fresh" (same seq 0, since
 * nothing bumped it), so it "hydrates" nothing while claiming success.
 *
 * Round 4 (F5 residual) replaced the earlier synchronous-capture fix (rounds
 * 1-3: read the snapshot BEFORE arming the warmup timer, at real cost on the
 * interactive hot path) with design (a): quick mode's warmup ALREADY loads
 * the on-disk snapshot for its own purposes (`cachedSnapshot`, reused for the
 * `startupScan` verdict cache) strictly BEFORE its own possible save. The
 * warmup now publishes that already-loaded read (narrowed to exports+rules)
 * into `warmupOwnSnapshotRead`, a variable local to the
 * `handleSessionStart` call — never module-scope (#1785 F6) — for
 * `retroactivelyHydrateAfterDeferredSequence` to reuse at zero marginal cost.
 * See that function's doc comment in `clients/runtime-session.ts` for the
 * full design and why it has no race window of its own (a read-before-write
 * invariant of the warmup's own code, not a timing bet).
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSequenceIndex } from "../../clients/project-changes.js";
import {
	loadProjectSnapshot,
	loadProjectSnapshotExportsAndRules,
	PROJECT_SNAPSHOT_VERSION,
	saveProjectSnapshot,
	type ProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { _resetSubagentModeForTests } from "../../clients/subagent-mode.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const readLatestProjectSequenceAsyncSpy = vi.hoisted(() => vi.fn());
const loadProjectSnapshotExportsAndRulesCallTimesMs = vi.hoisted(
	() => [] as number[],
);

vi.mock("../../clients/project-changes.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/project-changes.js")>();
	return {
		...actual,
		readLatestProjectSequenceAsync: readLatestProjectSequenceAsyncSpy,
	};
});

// #1785 F5 residual (review round 4): records WHEN (relative to
// `handleSessionStart`'s synchronous return) `loadProjectSnapshotExportsAndRules`
// is called, so a test can prove the narrow loader is never invoked
// synchronously on the interactive hot path — only later, from the warmup
// body or the deferred sequence-read continuation, both off that path.
// Wraps the REAL implementation (never replaces it) so every other test in
// this file still exercises real disk reads.
vi.mock("../../clients/project-snapshot.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/project-snapshot.js")>();
	return {
		...actual,
		loadProjectSnapshotExportsAndRules: (cwd: string) => {
			loadProjectSnapshotExportsAndRulesCallTimesMs.push(Date.now());
			return actual.loadProjectSnapshotExportsAndRules(cwd);
		},
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

function makeDeps(ctxCwd: string, runtime: RuntimeCoordinator) {
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
	}) as any;
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

describe("#1785 review round F1 — retroactive hydration survives a warmup save mid-stall", () => {
	const globals = globalThis as unknown as {
		__piLensFirstSessionDone?: boolean;
		__piLensWarmupScheduled?: boolean;
	};
	let prevArgv: string[];
	let prevStartupMode: string | undefined;
	let prevBudget: string | undefined;
	let prevWarmupDelay: string | undefined;
	let prevColdStart: string | undefined;
	let prevDataDir: string | undefined;
	let prevFirst: boolean | undefined;
	let prevWarmup: boolean | undefined;

	beforeEach(() => {
		prevArgv = process.argv;
		prevStartupMode = process.env.PI_LENS_STARTUP_MODE;
		prevBudget = process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS;
		prevWarmupDelay = process.env.PI_LENS_WARMUP_DELAY_MS;
		prevColdStart = process.env.PI_LENS_COLD_START_QUICK;
		prevDataDir = process.env.PILENS_DATA_DIR;
		prevFirst = globals.__piLensFirstSessionDone;
		prevWarmup = globals.__piLensWarmupScheduled;
		// Opposite of the #1162 sequence-read-budget suite's convention: THIS
		// suite needs the warmup to actually arm and fire.
		globals.__piLensFirstSessionDone = false;
		globals.__piLensWarmupScheduled = false;
		process.env.PI_LENS_STARTUP_MODE = "quick";
		process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS = "20";
		process.env.PI_LENS_WARMUP_DELAY_MS = "5";
		delete process.env.PI_LENS_COLD_START_QUICK;
		process.argv = prevArgv.filter((a) => a !== "--print" && a !== "-p");
		readLatestProjectSequenceAsyncSpy.mockReset();
		loadProjectSnapshotExportsAndRulesCallTimesMs.length = 0;
		_resetSubagentModeForTests();
	});

	afterEach(() => {
		process.argv = prevArgv;
		if (prevStartupMode === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prevStartupMode;
		if (prevBudget === undefined)
			delete process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS;
		else process.env.PI_LENS_SEQUENCE_READ_BUDGET_MS = prevBudget;
		if (prevWarmupDelay === undefined)
			delete process.env.PI_LENS_WARMUP_DELAY_MS;
		else process.env.PI_LENS_WARMUP_DELAY_MS = prevWarmupDelay;
		if (prevColdStart === undefined)
			delete process.env.PI_LENS_COLD_START_QUICK;
		else process.env.PI_LENS_COLD_START_QUICK = prevColdStart;
		if (prevDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = prevDataDir;
		globals.__piLensFirstSessionDone = prevFirst;
		globals.__piLensWarmupScheduled = prevWarmup;
		vi.restoreAllMocks();
		_resetSubagentModeForTests();
	});

	it("hydrates from the warmup's own already-loaded read, not the emptied disk body it later saves mid-stall (probe D2)", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-race-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
			createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");
			const goodExportPath = path.join(cwd, "index.ts");
			// `cwd` itself is the resolved snapshot root: `.git` right inside it
			// makes `findNearestProjectRoot` return `cwd` unchanged (mirrors the
			// #1162 sibling suite's `makeProject` + direct-`cwd` snapshot usage).
			const snapshotRoot = cwd;

			// The good, pre-session snapshot — what a prior session persisted.
			// Deliberately no `startupScan`, so the warmup below is forced to
			// recompute and re-save rather than reuse a cached verdict.
			saveProjectSnapshot(snapshotRoot, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: snapshotRoot,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [["good", goodExportPath]],
				projectRulesScan: { hasCustomRules: true, rules: [] },
			} satisfies ProjectSnapshot);

			// Stall the sequence read for the whole test — it never resolves
			// until this test explicitly does so below.
			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			await handleSessionStart(makeDeps(cwd, runtime));

			// Synchronous return: the read hasn't settled, so the freshness gate
			// correctly refuses to hydrate yet.
			expect(runtime.cachedExports.get("good")).toBeUndefined();

			// Let the REAL warmup timer (armed for 5ms) fire and complete its
			// save — proving the on-disk snapshot really is overwritten with an
			// empty `cachedExports` (built from the still-cold live runtime)
			// before the stalled sequence read ever resolves. This is the exact
			// interleaving #1785's review round named: the warmup's save landing
			// INSIDE the stall window this fix targets.
			await vi.waitFor(
				() => {
					const onDisk = loadProjectSnapshot(snapshotRoot);
					expect(onDisk?.cachedExports).toEqual([]);
				},
				{ timeout: 5000, interval: 10 },
			);

			// NOW the stalled read resolves — confirming (correctly) that
			// nothing changed since the ORIGINAL good snapshot (seq 0, matching
			// an empty change log).
			slow.resolve({ projectSeq: 0, fileSeqByPath: new Map() });

			await vi.waitFor(
				() => {
					expect(runtime.cachedExports.get("good")).toBe(goodExportPath);
				},
				{ timeout: 5000, interval: 10 },
			);

			// #1785 F5: the retroactive-hydration path can no longer touch
			// wordIndex at all (the narrow capture never carries one) — so once
			// the warmup's OWN word-index build finishes for real, it must
			// survive untouched. This is now guaranteed by construction (no
			// wordIndex parameter exists to clobber it with), but the assertion
			// stays as an end-to-end insurance policy against a future change
			// re-wiring the capture back onto the full loader.
			await vi.waitFor(
				() => {
					expect(runtime.wordIndex).not.toBeNull();
				},
				{ timeout: 5000, interval: 10 },
			);
		} finally {
			env.cleanup();
		}
	});

	// #1785 F5 residual (review round 4): design (a)'s own race window — the
	// warmup's published read can predate a REAL project change that the
	// deferred sequence read later reports. Unlike rounds 1-3's design, this
	// is not a bug to defend against with a snapshot-identity check: the
	// EXISTING freshness comparison (`snapshot.seq !== latestSeq.projectSeq`)
	// already declines correctly whenever the published value's seq doesn't
	// match the real, authoritative answer — proven here explicitly against
	// the NEW published-value code path (the sibling case for the disk-reload
	// fallback path is already covered by
	// `runtime-session-sequence-read-budget.test.ts`'s
	// "does NOT retroactively hydrate when stale" test).
	it("declines late hydration when a real project change lands after the warmup's own read (race window, correctly declined)", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-race-stale-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
			createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");
			const goodExportPath = path.join(cwd, "index.ts");
			const snapshotRoot = cwd;

			saveProjectSnapshot(snapshotRoot, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: snapshotRoot,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [["good", goodExportPath]],
				projectRulesScan: { hasCustomRules: true, rules: [] },
			} satisfies ProjectSnapshot);

			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			await handleSessionStart(makeDeps(cwd, runtime));
			expect(runtime.cachedExports.get("good")).toBeUndefined();

			// Let the warmup's own read (and, incidentally, its save) land —
			// this is the moment `warmupOwnSnapshotRead` gets published, still
			// carrying the OLD seq 0.
			await vi.waitFor(
				() => {
					const onDisk = loadProjectSnapshot(snapshotRoot);
					expect(onDisk?.cachedExports).toEqual([]);
				},
				{ timeout: 5000, interval: 10 },
			);

			// The stalled read NOW resolves — but reports that the REAL project
			// sequence has moved to 5 (an edit landed elsewhere, unrelated to the
			// warmup's read/save of the snapshot file). The published value's
			// seq (0) no longer matches reality.
			slow.resolve({ projectSeq: 5, fileSeqByPath: new Map() });

			// Give the deferred continuation a generous window to run (or, per
			// the freshness check, to observe the mismatch and correctly decline).
			await new Promise((resolve) => setTimeout(resolve, 200));

			expect(runtime.cachedExports.get("good")).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	// #1785 F5 residual (review round 4): the earlier fix (rounds 1-3) called
	// `loadProjectSnapshotExportsAndRules` SYNCHRONOUSLY, on the interactive
	// `handleSessionStart` hot path, to capture the pre-warmup snapshot before
	// arming the timer. Round 4 removes that call entirely — the warmup body
	// reuses its OWN pre-existing snapshot read instead. This proves the
	// removal directly: the loader must never be called before
	// `handleSessionStart` has already returned.
	it("never calls the narrow loader synchronously — only from the warmup body or the deferred continuation, both off the hot path", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-race-nohotpath-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
			createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");
			const snapshotRoot = cwd;

			saveProjectSnapshot(snapshotRoot, {
				version: PROJECT_SNAPSHOT_VERSION,
				projectRoot: snapshotRoot,
				generatedAt: new Date().toISOString(),
				seq: 0,
				files: {},
				symbols: {},
				reverseDeps: {},
				cachedExports: [["good", path.join(cwd, "index.ts")]],
				projectRulesScan: { hasCustomRules: true, rules: [] },
			} satisfies ProjectSnapshot);

			const slow = deferred<ProjectSequenceIndex>();
			readLatestProjectSequenceAsyncSpy.mockImplementation(() => slow.promise);

			const runtime = new RuntimeCoordinator();
			const beforeReturn = Date.now();
			await handleSessionStart(makeDeps(cwd, runtime));
			const afterReturn = Date.now();

			// Every recorded call must have happened AT OR AFTER the moment
			// handleSessionStart returned — none during its synchronous body.
			for (const t of loadProjectSnapshotExportsAndRulesCallTimesMs) {
				expect(t).toBeGreaterThanOrEqual(afterReturn);
			}
			expect(afterReturn).toBeGreaterThanOrEqual(beforeReturn);

			// #1785 F8 (review round 5): the loop above proves nothing on its own
			// when the array is empty — it just never executes its body. Prove
			// the recorder seam is actually live (not a renamed/dead export that
			// would leave the array permanently empty and the loop permanently
			// vacuous) by calling the loader directly, once, and checking the
			// array grew.
			const countBeforeDirectCall =
				loadProjectSnapshotExportsAndRulesCallTimesMs.length;
			loadProjectSnapshotExportsAndRules(snapshotRoot);
			expect(loadProjectSnapshotExportsAndRulesCallTimesMs.length).toBe(
				countBeforeDirectCall + 1,
			);

			slow.resolve({ projectSeq: 0, fileSeqByPath: new Map() });
			await new Promise((resolve) => setTimeout(resolve, 200));
		} finally {
			env.cleanup();
		}
	});
});
