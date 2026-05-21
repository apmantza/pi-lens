/**
 * Measures pi-lens startup overhead by asserting the self-reported
 * "session_start total: Xms" value that handleSessionStart() emits via dbg.
 *
 * We assert the number pi-lens itself logs — the same figure visible in
 * production session logs — rather than raw wall-clock time of the test.
 * Background tasks (scans, tool probes) fire-and-forget and are not counted.
 *
 * These are regression guards, not tight perf benchmarks. If they start
 * flaking, bump the budget — but investigate first, because a 2× regression
 * usually means something synchronous crept onto the hot path.
 */

import * as os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const QUICK_MODE_BUDGET_MS = 100;
const FULL_MODE_BUDGET_MS = 500;

/** Extract the self-reported ms from "session_start total: Xms ..." dbg lines. */
function extractReportedMs(dbgCalls: string[]): number | null {
	for (const msg of dbgCalls) {
		const m = /session_start total:\s*(\d+)ms/.exec(msg);
		if (m) return Number(m[1]);
	}
	return null;
}

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
		getFlag: (_name: string) => false,
		notify: () => {},
		dbg,
		log: () => {},
		runtime: {
			sessionGeneration: 1,
			isCurrentSession: () => true,
			markStartupScanInFlight: () => {},
			clearStartupScanInFlight: () => {},
			complexityBaselines: new Map(),
			resetForSession: () => {},
			projectRoot: "",
			projectRulesScan: { hasCustomRules: false, rules: [] },
			cachedExports: new Map(),
			cachedProjectIndex: null,
			errorDebtBaseline: { testsPassed: true, buildPassed: true },
		},
		metricsClient: { reset: () => {} },
		cacheManager: {
			writeCache: () => {},
			readCache: () => null,
		},
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
		typeCoverageClient: { isAvailable: () => false },
		depChecker: {
			isAvailable: () => false,
			ensureAvailable: async () => false,
		},
		testRunnerClient: {
			detectRunner: () => ({ runner: "vitest", config: null }),
			runTestFile: () => ({ failed: 1, error: false }),
		},
		goClient: { isGoAvailable: () => false },
		rustClient: { isAvailable: () => false },
		ensureTool: async () => null,
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
	} as any;
}

afterEach(() => {
	delete process.env.PI_LENS_STARTUP_MODE;
});

describe("startup overhead — interactive path regression guard", () => {
	it(`quick mode self-reports within ${QUICK_MODE_BUDGET_MS}ms`, async () => {
		const env = setupTestEnvironment("pi-lens-overhead-quick-");
		const restoreMode = setStartupMode("quick");
		const dbgLog: string[] = [];

		try {
			await handleSessionStart(makeDeps(env.tmpDir, (msg) => dbgLog.push(msg)));

			const reported = extractReportedMs(dbgLog);
			expect(reported).not.toBeNull();
			expect(reported).toBeLessThan(QUICK_MODE_BUDGET_MS);
		} finally {
			env.cleanup();
			restoreMode();
		}
	});

	it("home-directory full mode does not source-scan the home tree", async () => {
		const restoreMode = setStartupMode("full");
		const dbgLog: string[] = [];

		try {
			await handleSessionStart(
				makeDeps(os.homedir(), (msg) => dbgLog.push(msg)),
			);

			const reported = extractReportedMs(dbgLog);
			expect(reported).not.toBeNull();
			expect(reported).toBeLessThan(FULL_MODE_BUDGET_MS);
			expect(dbgLog).toContainEqual(
				expect.stringContaining("warmCaches=false, reason=home-dir"),
			);
		} finally {
			restoreMode();
		}
	});

	it(`full mode self-reports within ${FULL_MODE_BUDGET_MS}ms`, async () => {
		const env = setupTestEnvironment("pi-lens-overhead-full-");
		const restoreMode = setStartupMode("full");
		const dbgLog: string[] = [];

		createTempFile(
			env.tmpDir,
			"package.json",
			JSON.stringify({ name: "test-project", type: "module" }),
		);
		createTempFile(env.tmpDir, "src/index.ts", "export const x = 1;\n");

		try {
			await handleSessionStart(makeDeps(env.tmpDir, (msg) => dbgLog.push(msg)));

			const reported = extractReportedMs(dbgLog);
			expect(reported).not.toBeNull();
			expect(reported).toBeLessThan(FULL_MODE_BUDGET_MS);
		} finally {
			env.cleanup();
			restoreMode();
		}
	});
});
