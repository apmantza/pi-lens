/**
 * #1197 review finding 2 — a word-index build that is superseded mid-warmup
 * must not take the rest of the quick-mode warmup pass down with it.
 *
 * `buildWordIndexAsync` (the cooperative builder #1197 introduced) THROWS
 * "word index build superseded" when the session generation moves while it is
 * running. `buildOrRefreshWordIndex` is awaited from the warmup pass OUTSIDE any
 * per-step try/catch, so before the fix that throw skipped everything after it —
 * most importantly the #947 dominant-language LSP pre-warm, silently undoing
 * that fix for exactly the long-warmup sessions it was written for (the #1197
 * evidence shows a 223 s warmup). Master's synchronous `buildWordIndex` never
 * threw; supersession was a graceful `return`, and this restores that.
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { _resetSubagentModeForTests } from "../../clients/subagent-mode.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const touchFileSpy = vi.hoisted(() => vi.fn());
const logLatencySpy = vi.hoisted(() => vi.fn());
// Set by the test to the runtime whose generation the "concurrent session_start"
// should bump, from inside the build the warmup is awaiting.
const supersede = vi.hoisted(() => ({
	run: undefined as undefined | (() => void),
}));

vi.mock("../../clients/lsp/config.js", () => ({
	loadLSPConfig: vi.fn().mockResolvedValue({}),
	initLSPConfig: vi.fn().mockResolvedValue(undefined),
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(() =>
		makeLspServiceDouble({
			touchFile: touchFileSpy,
			supportsLSP: (file: string) => file.endsWith(".ts"),
		}),
	),
}));

vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency: logLatencySpy };
});

vi.mock("../../clients/word-index.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/word-index.js")>();
	return {
		...actual,
		// Stand in for "a newer session_start landed while this build was running":
		// bump the generation, then fail the way the real builder fails.
		buildWordIndexAsync: vi.fn(async () => {
			supersede.run?.();
			throw new Error("word index build superseded");
		}),
	};
});

import { handleSessionStart } from "../../clients/runtime-session.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

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
		// biome-ignore lint/suspicious/noExplicitAny: test double for the deps bag
	}) as any;
}

describe("quick-mode warmup survives a superseded word-index build (#1197)", () => {
	const globals = globalThis as unknown as {
		__piLensFirstSessionDone?: boolean;
		__piLensWarmupScheduled?: boolean;
	};
	let prevFirst: boolean | undefined;
	let prevWarmup: boolean | undefined;
	let prevDelay: string | undefined;
	let prevStartupMode: string | undefined;
	let previousDataDir: string | undefined;

	beforeEach(() => {
		prevFirst = globals.__piLensFirstSessionDone;
		prevWarmup = globals.__piLensWarmupScheduled;
		prevDelay = process.env.PI_LENS_WARMUP_DELAY_MS;
		prevStartupMode = process.env.PI_LENS_STARTUP_MODE;
		previousDataDir = process.env.PILENS_DATA_DIR;
		globals.__piLensFirstSessionDone = false;
		globals.__piLensWarmupScheduled = false;
		process.env.PI_LENS_WARMUP_DELAY_MS = "1";
		delete process.env.PI_LENS_STARTUP_MODE;
		touchFileSpy.mockClear();
		touchFileSpy.mockResolvedValue(undefined);
		logLatencySpy.mockClear();
		supersede.run = undefined;
		_resetSubagentModeForTests();
	});

	afterEach(() => {
		globals.__piLensFirstSessionDone = prevFirst;
		globals.__piLensWarmupScheduled = prevWarmup;
		if (prevDelay === undefined) delete process.env.PI_LENS_WARMUP_DELAY_MS;
		else process.env.PI_LENS_WARMUP_DELAY_MS = prevDelay;
		if (prevStartupMode === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prevStartupMode;
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		supersede.run = undefined;
		_resetSubagentModeForTests();
	});

	it("still runs the #947 LSP pre-warm when the build is superseded mid-warmup", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-superseded-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = path.join(env.tmpDir, "project");
			fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
			createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");
			const runtime = new RuntimeCoordinator();
			supersede.run = () => runtime.resetForSession();

			await handleSessionStart(makeDeps(cwd, runtime));

			await vi.waitFor(
				() => {
					expect(
						touchFileSpy.mock.calls.some(
							([, , opts]) =>
								(opts as { source?: string })?.source ===
								"startup-warm-dominant",
						),
					).toBe(true);
				},
				{ timeout: 10_000 },
			);
			// The whole pass completed: the pre-warm phase ran and the one-shot
			// guard was NOT reset by an escaping error.
			expect(logLatencySpy).toHaveBeenCalledWith(
				expect.objectContaining({ phase: "warmup_lsp_prewarm" }),
			);
			expect(globals.__piLensWarmupScheduled).toBe(true);
			// And the supersession is still reported as a completed word-index step
			// rather than vanishing — with no metadata, since nothing was published.
			expect(logLatencySpy).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "warmup_word_index",
					metadata: undefined,
				}),
			);
		} finally {
			env.cleanup();
		}
	});
});
