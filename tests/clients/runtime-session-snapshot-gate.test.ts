/**
 * #947 (commit 2) — meta-first staleness gate. Both interactive session-start
 * paths used to sync-parse the whole `project-snapshot.json` body (110-130ms
 * at 40MB, ~0.5s at the observed 112MB) BEFORE checking freshness — wasted
 * work in the ~71% of sessions where the snapshot turns out stale. The gate
 * reads the tiny `project-snapshot.meta.json` sidecar first and skips the
 * body parse when the meta's seq/version already proves the body stale.
 *
 * These tests drive the real `handleSessionStart` quick/full paths and
 * assert, via a `readJsonCache` spy keyed on the file path:
 *   - fresh meta (seq match)   → body parsed, runtime hydrated, no flag;
 *   - stale meta (seq mismatch) → body NOT parsed, `skippedStale: true` on
 *     the #952 `session_start_snapshot_load` record, no hydration;
 *   - incompatible meta version → body NOT parsed (version is part of the
 *     freshness contract);
 *   - missing meta (legacy)    → body parsed exactly as before (fail-open);
 *   - the full-mode path carries the same gate + record flag.
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetProjectSnapshotParseCacheForTests,
	buildProjectSnapshotFromRuntime,
	getProjectSnapshotMetaPath,
	getProjectSnapshotPath,
	getSnapshotBodyReadCountForTests,
	resetSnapshotBodyReadCountForTests,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

const readJsonCacheSpy = vi.hoisted(() => vi.fn());
const logLatencySpy = vi.hoisted(() => vi.fn());

vi.mock("../../clients/json-cache-read.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/json-cache-read.js")>();
	readJsonCacheSpy.mockImplementation(actual.readJsonCache);
	return { ...actual, readJsonCache: readJsonCacheSpy };
});

vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency: logLatencySpy };
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

function makeDeps(ctxCwd: string, dbg: (msg: string) => void = () => {}) {
	return withResidentBootstrap({
		ctxCwd,
		getFlag: () => false,
		notify: vi.fn(),
		dbg,
		log: () => {},
		runtime: new RuntimeCoordinator(),
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

function makeProject(env: { tmpDir: string }): string {
	const cwd = path.join(env.tmpDir, "project");
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");
	return cwd;
}

/** Seed a snapshot at `seq` carrying one export, via the real save path. */
function seedSnapshot(cwd: string, seq: number): void {
	const seedRuntime = new RuntimeCoordinator();
	seedRuntime.seedProjectSequence(seq);
	seedRuntime.cachedExports.set("makeThing", path.join(cwd, "src", "a.ts"));
	saveProjectSnapshot(
		cwd,
		buildProjectSnapshotFromRuntime({ cwd, runtime: seedRuntime }),
	);
}

function snapshotBodyReads(): number {
	// #958: the body is gzip and read via gunzip+JSON.parse (bypassing
	// readJsonCache), so body parses are counted through the dedicated hook
	// rather than the readJsonCache spy (which still tracks the tiny meta reads).
	return getSnapshotBodyReadCountForTests();
}

function snapshotMetaReads(): number {
	return readJsonCacheSpy.mock.calls.filter(([p]) =>
		String(p).endsWith("project-snapshot.meta.json"),
	).length;
}

function snapshotLoadRecord(): Record<string, unknown> | undefined {
	const call = logLatencySpy.mock.calls.find(
		([entry]) => entry.phase === "session_start_snapshot_load",
	);
	return call?.[0]?.metadata as Record<string, unknown> | undefined;
}

async function assertMissReasonInMode(
	mode: "quick" | "full",
	reason: string,
	prepare: (cwd: string) => void,
): Promise<void> {
	const env = setupTestEnvironment(`pi-lens-meta-gate-${mode}-${reason}-`);
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	process.env.PI_LENS_STARTUP_MODE = mode;
	const dbgLog: string[] = [];
	try {
		const cwd = makeProject(env);
		prepare(cwd);
		await handleSessionStart(makeDeps(cwd, (msg) => dbgLog.push(msg)));
		expect(snapshotLoadRecord()).toMatchObject({
			fresh: false,
			reason,
		});
		expect(dbgLog).toContainEqual(`project_snapshot: miss reason=${reason}`);
	} finally {
		env.cleanup();
	}
}

describe("session_start snapshot meta-gate (#947)", () => {
	const globals = globalThis as unknown as {
		__piLensFirstSessionDone?: boolean;
		__piLensWarmupScheduled?: boolean;
	};
	let prevFirst: boolean | undefined;
	let prevWarmup: boolean | undefined;
	let prevStartupMode: string | undefined;
	let previousDataDir: string | undefined;

	beforeEach(() => {
		prevFirst = globals.__piLensFirstSessionDone;
		prevWarmup = globals.__piLensWarmupScheduled;
		prevStartupMode = process.env.PI_LENS_STARTUP_MODE;
		previousDataDir = process.env.PILENS_DATA_DIR;
		// Deterministic quick mode, warmup timer suppressed.
		globals.__piLensFirstSessionDone = true;
		globals.__piLensWarmupScheduled = true;
		process.env.PI_LENS_STARTUP_MODE = "quick";
		// #958: force the synchronous body writer so `seedSnapshot` lands the gz
		// body on disk before session start reads it (the worker offload is
		// covered by project-snapshot.test.ts).
		process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC = "1";
		readJsonCacheSpy.mockClear();
		logLatencySpy.mockClear();
		resetSnapshotBodyReadCountForTests();
		// Simulate a fresh process: the in-process parse cache (#947 commit 3)
		// must not serve these assertions — session start should parse a body
		// written by a PREVIOUS process.
		_resetProjectSnapshotParseCacheForTests();
	});

	afterEach(() => {
		globals.__piLensFirstSessionDone = prevFirst;
		globals.__piLensWarmupScheduled = prevWarmup;
		if (prevStartupMode === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prevStartupMode;
		delete process.env.PI_LENS_SNAPSHOT_PERSIST_SYNC;
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
	});

	it("fresh meta (seq match) → body parsed and runtime hydrated, no skippedStale flag", async () => {
		const env = setupTestEnvironment("pi-lens-meta-gate-fresh-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			// Fresh RuntimeCoordinator with no change log → effectiveSeq 0.
			seedSnapshot(cwd, 0);
			// Drop the cache entry the seed's own save primed — a real session
			// start parses a body written by another process.
			_resetProjectSnapshotParseCacheForTests();

			const deps = makeDeps(cwd);
			await handleSessionStart(deps);

			expect(snapshotMetaReads()).toBeGreaterThan(0);
			expect(snapshotBodyReads()).toBeGreaterThan(0);
			expect(deps.runtime.cachedExports.get("makeThing")).toBe(
				path.join(cwd, "src", "a.ts"),
			);
			expect(snapshotLoadRecord()).toMatchObject({ fresh: true, seq: 0 });
			expect(snapshotLoadRecord()?.skippedStale).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("stale meta (seq mismatch) → body NOT parsed, record carries skippedStale:true", async () => {
		const env = setupTestEnvironment("pi-lens-meta-gate-stale-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		const dbgLog: string[] = [];
		try {
			const cwd = makeProject(env);
			// Snapshot saved at seq 5, but this session's effectiveSeq is 0 →
			// the meta alone proves the body stale.
			seedSnapshot(cwd, 5);

			const deps = makeDeps(cwd, (msg) => dbgLog.push(msg));
			await handleSessionStart(deps);

			expect(snapshotMetaReads()).toBeGreaterThan(0);
			expect(snapshotBodyReads()).toBe(0);
			expect(deps.runtime.cachedExports.size).toBe(0);
			expect(snapshotLoadRecord()).toMatchObject({
				fresh: false,
				skippedStale: true,
				reason: "stale-meta-gate",
			});
			expect(dbgLog).toContainEqual(
				expect.stringContaining("project_snapshot: meta gate stale"),
			);
			expect(dbgLog).toContainEqual(
				"project_snapshot: miss reason=stale-meta-gate",
			);
		} finally {
			env.cleanup();
		}
	});

	it("incompatible meta version → body NOT parsed (version is part of freshness)", async () => {
		const env = setupTestEnvironment("pi-lens-meta-gate-version-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			seedSnapshot(cwd, 0);
			// Rewrite the sidecar with a future version — seq matches, but the
			// body schema is incompatible, so it must not be parsed.
			fs.writeFileSync(
				getProjectSnapshotMetaPath(cwd),
				JSON.stringify({
					timestamp: new Date().toISOString(),
					version: 999,
					seq: 0,
				}),
			);

			const deps = makeDeps(cwd);
			await handleSessionStart(deps);

			expect(snapshotBodyReads()).toBe(0);
			expect(deps.runtime.cachedExports.size).toBe(0);
			expect(snapshotLoadRecord()?.skippedStale).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("missing meta (legacy install) → body parsed exactly as before (fail-open)", async () => {
		const env = setupTestEnvironment("pi-lens-meta-gate-legacy-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeProject(env);
			seedSnapshot(cwd, 0);
			_resetProjectSnapshotParseCacheForTests();
			fs.unlinkSync(getProjectSnapshotMetaPath(cwd));

			const deps = makeDeps(cwd);
			await handleSessionStart(deps);

			expect(snapshotBodyReads()).toBeGreaterThan(0);
			expect(deps.runtime.cachedExports.get("makeThing")).toBe(
				path.join(cwd, "src", "a.ts"),
			);
			expect(snapshotLoadRecord()).toMatchObject({ fresh: true });
			expect(snapshotLoadRecord()?.skippedStale).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("full-mode path carries the same gate and record flag", async () => {
		const env = setupTestEnvironment("pi-lens-meta-gate-full-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		process.env.PI_LENS_STARTUP_MODE = "full";
		const dbgLog: string[] = [];
		try {
			const cwd = makeProject(env);
			seedSnapshot(cwd, 5); // stale vs effectiveSeq 0

			const deps = makeDeps(cwd, (msg) => dbgLog.push(msg));
			await handleSessionStart(deps);

			// (Full mode later re-parses the body inside
			// saveRuntimeProjectSnapshot's merge — only the gate's own record is
			// asserted here.)
			expect(snapshotLoadRecord()).toMatchObject({
				fresh: false,
				skippedStale: true,
				reason: "stale-meta-gate",
			});
			expect(dbgLog).toContainEqual(
				"project_snapshot: miss reason=stale-meta-gate",
			);
			expect(fs.existsSync(getProjectSnapshotPath(cwd))).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it.each(["quick", "full"] as const)(
		"%s mode classifies a missing body on both delivery surfaces",
		async (mode) => {
			await assertMissReasonInMode(mode, "missing", () => {});
		},
	);

	it.each(["quick", "full"] as const)(
		"%s mode classifies a corrupt present body on both delivery surfaces",
		async (mode) => {
			await assertMissReasonInMode(mode, "invalid-body", (cwd) => {
				const bodyPath = getProjectSnapshotPath(cwd);
				fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
				fs.writeFileSync(bodyPath, "not a gzip project snapshot");
			});
		},
	);

	it.each(["quick", "full"] as const)(
		"%s mode classifies a parsed different-sequence body on both delivery surfaces",
		async (mode) => {
			await assertMissReasonInMode(mode, "stale(seq=5, current=0)", (cwd) => {
				seedSnapshot(cwd, 5);
				const metaPath = getProjectSnapshotMetaPath(cwd);
				const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
					seq: number;
					sequenceIndex?: { projectSeq?: number };
				};
				meta.seq = 0;
				if (meta.sequenceIndex) meta.sequenceIndex.projectSeq = 0;
				fs.writeFileSync(metaPath, JSON.stringify(meta));
			});
		},
	);
});
