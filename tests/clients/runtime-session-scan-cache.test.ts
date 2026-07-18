/**
 * #699 — `resolveStartupScanContextAsync()` re-walked the entire project on
 * EVERY `pi` process start even when the outcome (`canWarmCaches=false`,
 * reason `too-many-source-files`) is immediately discarded, because nothing
 * persisted that verdict. These tests drive the real `handleSessionStart`
 * full-mode path (the one that reaches `resolveStartupScanContext`
 * synchronously — see clients/runtime-session.ts around the
 * `startupScanSource` computation) and assert:
 *   - a fresh persisted verdict is reused WITHOUT calling
 *     `resolveStartupScanContext` again (the walk is actually skipped, not
 *     just cheap the second time);
 *   - an expired verdict triggers a fresh walk (TTL recovery);
 *   - the freshly computed verdict gets persisted for the next process,
 *     regardless of canWarmCaches outcome;
 *   - a corrupt cache file fails open (still resolves, doesn't throw).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildProjectSnapshotFromRuntime,
	getProjectSnapshotPath,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { _resetStartupScanVerdictTtlForTests } from "../../clients/startup-scan.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/lsp/config.js", () => ({
	loadLSPConfig: vi.fn().mockResolvedValue({}),
	initLSPConfig: vi.fn().mockResolvedValue(undefined),
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(() => ({
		touchFile: vi.fn().mockResolvedValue(undefined),
		supportsLSP: () => false,
	})),
}));

const resolveStartupScanContextSpy = vi.hoisted(() => vi.fn());

vi.mock("../../clients/startup-scan.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/startup-scan.js")>();
	resolveStartupScanContextSpy.mockImplementation(actual.resolveStartupScanContext);
	return {
		...actual,
		resolveStartupScanContext: resolveStartupScanContextSpy,
	};
});

import { handleSessionStart } from "../../clients/runtime-session.js";

function setStartupMode(mode: "full" | "quick"): () => void {
	const prev = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = mode;
	return () => {
		if (prev === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prev;
	};
}

function makeDeps(ctxCwd: string, dbg: (msg: string) => void = () => {}) {
	return {
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
		biomeClient: { isAvailable: () => false, ensureAvailable: async () => false },
		ruffClient: { isAvailable: () => false, ensureAvailable: async () => false },
		knipClient: { isAvailable: () => false, ensureAvailable: async () => false },
		jscpdClient: { isAvailable: () => false, ensureAvailable: async () => false },
		depChecker: { isAvailable: () => false, ensureAvailable: async () => false },
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
	} as any;
}

describe("startup-scan verdict cache in session_start (#699)", () => {
	let restoreStartupMode: () => void;
	let previousDataDir: string | undefined;

	beforeEach(() => {
		restoreStartupMode = setStartupMode("full");
		previousDataDir = process.env.PILENS_DATA_DIR;
		resolveStartupScanContextSpy.mockClear();
		_resetStartupScanVerdictTtlForTests();
	});

	afterEach(() => {
		restoreStartupMode();
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		_resetStartupScanVerdictTtlForTests();
	});

	it("computes and persists the verdict on a cold snapshot, then reuses it on the next call without re-walking", async () => {
		const env = setupTestEnvironment("pi-lens-scan-cache-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			fs.mkdirSync(path.join(env.tmpDir, "project", ".git"), {
				recursive: true,
			});
			const cwd = path.join(env.tmpDir, "project");
			createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");

			await handleSessionStart(makeDeps(cwd));
			expect(resolveStartupScanContextSpy).toHaveBeenCalledTimes(1);

			const snapshotPath = getProjectSnapshotPath(cwd);
			expect(fs.existsSync(snapshotPath)).toBe(true);
			const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
			expect(snapshot.startupScan).toBeDefined();
			expect(snapshot.startupScan.canWarmCaches).toBe(true);
			expect(typeof snapshot.startupScan.computedAt).toBe("number");

			// Second full session_start against the same (unchanged) project: the
			// persisted verdict is fresh — resolveStartupScanContext must NOT be
			// called again.
			resolveStartupScanContextSpy.mockClear();
			const dbgLog: string[] = [];
			await handleSessionStart(makeDeps(cwd, (msg) => dbgLog.push(msg)));
			expect(resolveStartupScanContextSpy).not.toHaveBeenCalled();
			expect(dbgLog).toContainEqual(
				expect.stringContaining("session_start scan-context source=snapshot"),
			);
		} finally {
			env.cleanup();
		}
	});

	it("persists a negative (too-many-source-files) verdict and reuses it within the TTL", async () => {
		const env = setupTestEnvironment("pi-lens-scan-cache-neg-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		process.env.PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS = "60000";
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });

			// Pre-seed a fresh negative verdict directly into the snapshot the way
			// a prior process would have (avoids creating 2000+ real files here).
			const seedRuntime = new RuntimeCoordinator();
			seedRuntime.seedProjectSequence(0);
			const seedSnapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime: seedRuntime,
				startupScan: {
					cwd,
					scanRoot: cwd,
					projectRoot: cwd,
					canWarmCaches: false,
					reason: "too-many-source-files",
					sourceFileCount: 5000,
					computedAt: Date.now(),
				},
			});
			saveProjectSnapshot(cwd, seedSnapshot);

			await handleSessionStart(makeDeps(cwd));
			expect(resolveStartupScanContextSpy).not.toHaveBeenCalled();
		} finally {
			delete process.env.PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS;
			env.cleanup();
		}
	});

	it("re-walks once the persisted negative verdict has expired past its TTL", async () => {
		const env = setupTestEnvironment("pi-lens-scan-cache-expired-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		process.env.PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS = "1000";
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
			createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");

			const seedRuntime = new RuntimeCoordinator();
			seedRuntime.seedProjectSequence(0);
			const seedSnapshot = buildProjectSnapshotFromRuntime({
				cwd,
				runtime: seedRuntime,
				startupScan: {
					cwd,
					scanRoot: cwd,
					projectRoot: cwd,
					canWarmCaches: false,
					reason: "too-many-source-files",
					sourceFileCount: 5000,
					computedAt: Date.now() - 10_000, // well past the 1s TTL
				},
			});
			saveProjectSnapshot(cwd, seedSnapshot);

			await handleSessionStart(makeDeps(cwd));
			expect(resolveStartupScanContextSpy).toHaveBeenCalledTimes(1);
		} finally {
			delete process.env.PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS;
			env.cleanup();
		}
	});

	it("fails open (re-walks, does not throw) when project-snapshot.json is corrupt", async () => {
		const env = setupTestEnvironment("pi-lens-scan-cache-corrupt-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
			createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");

			const snapshotPath = getProjectSnapshotPath(cwd);
			fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
			fs.writeFileSync(snapshotPath, "{ not valid json");

			await expect(handleSessionStart(makeDeps(cwd))).resolves.not.toThrow();
			expect(resolveStartupScanContextSpy).toHaveBeenCalledTimes(1);
		} finally {
			env.cleanup();
		}
	});
});
