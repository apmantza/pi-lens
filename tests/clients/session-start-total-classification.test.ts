/**
 * #2129 observability. `decideSessionStart` already classifies every start
 * before `handleSessionStart` runs (a declined start returns before this
 * handler is ever called — see `tests/clients/session-lifecycle-multi-root.
 * test.ts` and `tests/index-multi-root-session-start.test.ts`). Until now,
 * that classification only reached `latency.log` via `concurrent_session_
 * bind`, which fires for the DECLINED side only. A reader of `session_start_
 * total` — the record `mode` (quick/full) lives on — had no way to see the
 * root-identity input the classification consulted for the start that
 * actually ran.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import type { SessionStartRootTelemetry } from "../../clients/runtime-session.js";
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

function makeDeps(ctxCwd: string, overrides: Record<string, unknown> = {}) {
	return {
		ctxCwd,
		getFlag: () => false,
		notify: () => {},
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
		ensureTool: async () => null,
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
		...overrides,
	} as any;
}

type SessionStartTotalMetadata = {
	mode: "full" | "minimal" | "quick";
	classification?: string;
	sameRoot: SessionStartRootTelemetry;
};

function sessionStartTotals(): Array<{
	phase: "session_start_total";
	metadata: SessionStartTotalMetadata;
}> {
	const text = fs.existsSync(getLatencyLogPath())
		? fs.readFileSync(getLatencyLogPath(), "utf8")
		: "";
	return text
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { phase?: string; metadata?: unknown })
		.filter((entry) => entry.phase === "session_start_total")
		.map((entry) => {
			const metadata = entry.metadata;
			if (!metadata || typeof metadata !== "object") {
				throw new Error("session_start_total metadata is missing");
			}
			const typed = metadata as Partial<SessionStartTotalMetadata>;
			if (
				typed.sameRoot !== true &&
				typed.sameRoot !== false &&
				typed.sameRoot !== "unknown"
			) {
				throw new Error(
					"session_start_total sameRoot is not an explicit bounded value",
				);
			}
			return {
				phase: "session_start_total" as const,
				metadata: metadata as SessionStartTotalMetadata,
			};
		});
}

describe("session_start_total carries the classification decision (#2129)", () => {
	let restoreStartupMode: (() => void) | undefined;
	let previousTestMode: string | undefined;

	beforeEach(async () => {
		previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		clearLatencyLog();
		await flushLatencyLog();
	});

	afterEach(async () => {
		await flushLatencyLog();
		if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previousTestMode;
		restoreStartupMode?.();
		restoreStartupMode = undefined;
		previousTestMode = undefined;
	});

	it("quick mode: logs classification and sameRoot alongside mode", async () => {
		restoreStartupMode = setStartupMode("quick");
		const env = setupTestEnvironment("pi-lens-session-start-total-quick-");
		const globals = globalThis as unknown as {
			__piLensWarmupScheduled?: boolean;
		};
		const previousWarmup = globals.__piLensWarmupScheduled;
		globals.__piLensWarmupScheduled = true;
		try {
			await handleSessionStart(
				makeDeps(env.tmpDir, {
					sessionStartClassification: "sequential-replacement",
					sessionStartSameRoot: true,
				}),
			);
			await flushLatencyLog();
			expect(sessionStartTotals()[0]?.metadata).toEqual({
				mode: "quick",
				classification: "sequential-replacement",
				sameRoot: true,
			});
		} finally {
			globals.__piLensWarmupScheduled = previousWarmup;
			env.cleanup();
		}
	});

	it("full mode: logs classification and sameRoot alongside mode", async () => {
		restoreStartupMode = setStartupMode("full");
		const env = setupTestEnvironment("pi-lens-session-start-total-full-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
			createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");

			await handleSessionStart(
				makeDeps(cwd, {
					sessionStartClassification: "primary",
					sessionStartSameRoot: undefined,
				}),
			);
			await flushLatencyLog();
			expect(sessionStartTotals()[0]?.metadata).toEqual({
				mode: "full",
				classification: "primary",
				sameRoot: "unknown",
			});
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("a caller that supplies no classification changes nothing (back-compat)", async () => {
		restoreStartupMode = setStartupMode("quick");
		const env = setupTestEnvironment("pi-lens-session-start-total-omit-");
		const globals = globalThis as unknown as {
			__piLensWarmupScheduled?: boolean;
		};
		const previousWarmup = globals.__piLensWarmupScheduled;
		globals.__piLensWarmupScheduled = true;
		try {
			await handleSessionStart(makeDeps(env.tmpDir));
			await flushLatencyLog();
			expect(sessionStartTotals()[0]?.metadata).toEqual({
				mode: "quick",
				sameRoot: "unknown",
			});
		} finally {
			globals.__piLensWarmupScheduled = previousWarmup;
			env.cleanup();
		}
	});
});
