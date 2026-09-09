/**
 * #947 (commit 1) — the dominant-language LSP pre-warm was gated on
 * `allowBootstrapTasks` (full startup mode only), but the
 * first-session-of-process heuristic forces quick mode, so the pre-warm
 * NEVER ran in practice (82 quick vs 0 full starts in 31k dogfood log
 * lines) and every session's first edit paid a cold LSP spawn. The
 * pre-warm now runs inside the quick-mode +2s background warmup pass.
 *
 * These tests drive the real `handleSessionStart` quick-mode path with a
 * near-zero warmup delay and assert:
 *   - the warmup fires the dominant-language pre-warm (touchFile with
 *     source "startup-warm-dominant") and logs a `warmup_lsp_prewarm`
 *     phase record;
 *   - it fires exactly ONCE per process (the `__piLensWarmupScheduled`
 *     guard), so a later session start does not re-warm — this is also
 *     what protects concurrent secondaries, which never reach
 *     `handleSessionStart` at all (the #473 guard in index.ts) and
 *     therefore never schedule a warmup of their own;
 *   - subagent light-mode sessions skip the pre-warm (#449);
 *   - the no-lsp flag skips the pre-warm.
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { _resetSubagentModeForTests } from "../../clients/subagent-mode.js";
import {
	_resetWarmAttachForTests,
	_setWarmAttachForTests,
} from "../../clients/warm-attach.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

const touchFileSpy = vi.hoisted(() => vi.fn());
const logLatencySpy = vi.hoisted(() => vi.fn());

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

import { handleSessionStart } from "../../clients/runtime-session.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

function makeDeps(ctxCwd: string, overrides: Record<string, unknown> = {}) {
	return withResidentBootstrap({
		ctxCwd,
		getFlag: () => false,
		notify: vi.fn(),
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
		ensureTool: vi.fn(async () => null),
		cleanStaleTsBuildInfo: () => [],
		resetDispatchBaselines: () => {},
		resetLSPService: () => {},
		...overrides,
	}) as any;
}

function makeWarmableProject(env: { tmpDir: string }): string {
	const cwd = path.join(env.tmpDir, "project");
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	createTempFile(env.tmpDir, "project/index.ts", "export const x = 1;\n");
	return cwd;
}

describe("quick-mode warmup LSP pre-warm (#947)", () => {
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
		delete process.env.PI_SUBAGENT_CHILD;
		_resetSubagentModeForTests();
	});

	it("fires the dominant-language pre-warm from the warmup pass, with a phase record", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-prewarm-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeWarmableProject(env);
			await handleSessionStart(makeDeps(cwd));

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
			expect(touchFileSpy.mock.calls[0][0]).toMatch(/index\.ts$/);
			expect(logLatencySpy).toHaveBeenCalledWith(
				expect.objectContaining({ phase: "warmup_lsp_prewarm" }),
			);
			expect(logLatencySpy).toHaveBeenCalledWith(
				expect.objectContaining({ phase: "warmup_total" }),
			);
		} finally {
			env.cleanup();
		}
	});

	it("fires exactly once per process — a second session start does not re-warm", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-prewarm-once-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeWarmableProject(env);
			await handleSessionStart(makeDeps(cwd));
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
			const callsAfterFirstWarm = touchFileSpy.mock.calls.length;

			// A subsequent session start (e.g. /new, or a concurrent secondary
			// that somehow reached the handler) must NOT schedule another
			// warmup — __piLensWarmupScheduled stays set for the process.
			// Pin the second start to quick mode explicitly so the full-mode
			// path's own (correct, pre-existing) pre-warm doesn't confound
			// the assertion — this test guards the WARMUP firing once.
			process.env.PI_LENS_STARTUP_MODE = "quick";
			await handleSessionStart(makeDeps(cwd));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(touchFileSpy.mock.calls.length).toBe(callsAfterFirstWarm);
		} finally {
			env.cleanup();
		}
	});

	it("skips the pre-warm in a subagent light-mode session (#449)", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-prewarm-subagent-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		process.env.PI_SUBAGENT_CHILD = "1";
		_resetSubagentModeForTests();
		try {
			const cwd = makeWarmableProject(env);
			await handleSessionStart(makeDeps(cwd));

			// Wait for the warmup pass to complete (warmup_total is logged in
			// the finally, after the pre-warm step), then assert no dominant
			// warm happened.
			await vi.waitFor(
				() => {
					expect(logLatencySpy).toHaveBeenCalledWith(
						expect.objectContaining({ phase: "warmup_total" }),
					);
				},
				{ timeout: 10_000 },
			);
			expect(
				touchFileSpy.mock.calls.some(
					([, , opts]) =>
						(opts as { source?: string })?.source === "startup-warm-dominant",
				),
			).toBe(false);
			expect(logLatencySpy).not.toHaveBeenCalledWith(
				expect.objectContaining({ phase: "warmup_lsp_prewarm" }),
			);
		} finally {
			env.cleanup();
		}
	});

	it("skips the pre-warm when attached to a warm incumbent (#822 review: untested path)", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-prewarm-attach-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeWarmableProject(env);
			_setWarmAttachForTests(cwd, process.pid + 1);
			const dbgLog: string[] = [];
			await handleSessionStart(
				makeDeps(cwd, { dbg: (msg: string) => dbgLog.push(msg) }),
			);

			await vi.waitFor(
				() => {
					expect(logLatencySpy).toHaveBeenCalledWith(
						expect.objectContaining({ phase: "warmup_total" }),
					);
				},
				{ timeout: 10_000 },
			);
			expect(
				touchFileSpy.mock.calls.some(
					([, , opts]) =>
						(opts as { source?: string })?.source === "startup-warm-dominant",
				),
			).toBe(false);
			expect(logLatencySpy).not.toHaveBeenCalledWith(
				expect.objectContaining({ phase: "warmup_lsp_prewarm" }),
			);
			expect(dbgLog).toContainEqual(
				expect.stringContaining(
					"warmup: skipping LSP pre-warm (attached to incumbent)",
				),
			);
		} finally {
			_resetWarmAttachForTests();
			env.cleanup();
		}
	});

	it("skips language-profile/word-index/pre-warm entirely when canWarmCaches is false (#957 review: untested path)", async () => {
		const dbgLog: string[] = [];
		// A home-dir root resolves canWarmCaches=false (#296) without needing to
		// touch/mock the startup-scan internals.
		await handleSessionStart(
			makeDeps(os.homedir(), { dbg: (msg: string) => dbgLog.push(msg) }),
		);

		await vi.waitFor(
			() => {
				expect(dbgLog).toContainEqual(
					expect.stringContaining(
						"warmup: skipping language-profile (canWarm=false",
					),
				);
			},
			{ timeout: 10_000 },
		);
		// The scan-context phase still runs (that's what produced the
		// canWarmCaches=false verdict), but nothing downstream of the guard
		// does: no language-profile/word-index work, no LSP pre-warm.
		expect(logLatencySpy).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "warmup_scan_context" }),
		);
		expect(logLatencySpy).not.toHaveBeenCalledWith(
			expect.objectContaining({ phase: "warmup_language_profile" }),
		);
		expect(logLatencySpy).not.toHaveBeenCalledWith(
			expect.objectContaining({ phase: "warmup_word_index" }),
		);
		expect(logLatencySpy).not.toHaveBeenCalledWith(
			expect.objectContaining({ phase: "warmup_lsp_prewarm" }),
		);
		expect(
			touchFileSpy.mock.calls.some(
				([, , opts]) =>
					(opts as { source?: string })?.source === "startup-warm-dominant",
			),
		).toBe(false);
	});

	it("skips the pre-warm when the no-lsp flag is set", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-prewarm-nolsp-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const cwd = makeWarmableProject(env);
			await handleSessionStart(
				makeDeps(cwd, { getFlag: (name: string) => name === "no-lsp" }),
			);

			await vi.waitFor(
				() => {
					expect(logLatencySpy).toHaveBeenCalledWith(
						expect.objectContaining({ phase: "warmup_total" }),
					);
				},
				{ timeout: 10_000 },
			);
			expect(
				touchFileSpy.mock.calls.some(
					([, , opts]) =>
						(opts as { source?: string })?.source === "startup-warm-dominant",
				),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});
});
