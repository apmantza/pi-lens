/**
 * #775 — a `too-many-source-files` / `too-many-entries` startup-scan verdict
 * silently skipped the warm pipeline (heavy scans, TODO scan, dominant-
 * language LSP pre-warm) with only a debug-log line, unlike the slow-FS probe
 * which fires a visible notify (`runtime-session.ts` around the
 * `slowFsVerdict.slow` check). These tests drive the real `handleSessionStart`
 * full-mode path with a pre-seeded startup-scan verdict (same technique as
 * `runtime-session-scan-cache.test.ts`) and assert:
 *   - an over-budget verdict fires the warm-skip notify exactly once per
 *     session, naming the entry-budget override when the reason is
 *     `too-many-entries`;
 *   - a normal (small, `canWarmCaches: true`) project never fires it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildProjectSnapshotFromRuntime,
	saveProjectSnapshot,
} from "../../clients/project-snapshot.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
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

import { handleSessionStart } from "../../clients/runtime-session.js";

function setStartupMode(mode: "full" | "quick"): () => void {
	const prev = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = mode;
	return () => {
		if (prev === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prev;
	};
}

function makeDeps(ctxCwd: string, notify: (msg: string, level: string) => void) {
	return {
		ctxCwd,
		getFlag: () => false,
		notify,
		dbg: () => {},
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

describe("warm-pipeline size-skip notify (#775)", () => {
	let restoreStartupMode: () => void;
	let previousDataDir: string | undefined;

	beforeEach(() => {
		restoreStartupMode = setStartupMode("full");
		previousDataDir = process.env.PILENS_DATA_DIR;
	});

	afterEach(() => {
		restoreStartupMode();
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
	});

	it("fires the warm-skip notify once, naming the entry-budget override, for a too-many-entries verdict", async () => {
		const env = setupTestEnvironment("pi-lens-warm-skip-notify-entries-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });

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
					reason: "too-many-entries",
					computedAt: Date.now(),
				},
			});
			saveProjectSnapshot(cwd, seedSnapshot);

			const notifications: Array<{ msg: string; level: string }> = [];
			await handleSessionStart(
				makeDeps(cwd, (msg, level) => notifications.push({ msg, level })),
			);

			const warmSkipNotices = notifications.filter((n) =>
				n.msg.includes("Project-size limits disabled background warm scans"),
			);
			expect(warmSkipNotices).toHaveLength(1);
			expect(warmSkipNotices[0].level).toBe("warning");
			expect(warmSkipNotices[0].msg).toContain(
				"PI_LENS_STARTUP_SCAN_MAX_ENTRIES",
			);
		} finally {
			env.cleanup();
		}
	});

	it("fires the warm-skip notify once for a too-many-source-files verdict (no override to name)", async () => {
		const env = setupTestEnvironment("pi-lens-warm-skip-notify-files-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });

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

			const notifications: Array<{ msg: string; level: string }> = [];
			await handleSessionStart(
				makeDeps(cwd, (msg, level) => notifications.push({ msg, level })),
			);

			const warmSkipNotices = notifications.filter((n) =>
				n.msg.includes("Project-size limits disabled background warm scans"),
			);
			expect(warmSkipNotices).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("never fires the warm-skip notify for a small project that warms normally", async () => {
		const env = setupTestEnvironment("pi-lens-warm-skip-notify-small-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			fs.mkdirSync(path.join(env.tmpDir, "project", ".git"), {
				recursive: true,
			});
			const cwd = path.join(env.tmpDir, "project");
			createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");

			const notifications: Array<{ msg: string; level: string }> = [];
			await handleSessionStart(
				makeDeps(cwd, (msg, level) => notifications.push({ msg, level })),
			);

			const warmSkipNotices = notifications.filter((n) =>
				n.msg.includes("Project-size limits disabled background warm scans"),
			);
			expect(warmSkipNotices).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});
});
