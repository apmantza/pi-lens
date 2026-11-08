/**
 * Regression tests for #1154 — the quick-mode background warmup scheduled at
 * session_start kept a one-shot `pi -p`/`--print` process alive (the
 * referenced-handle retention class of #1097/#1110/#1148/#1149, and the located
 * #1122 hypothesis-A concern: post-settle work that starts resources with no
 * one-shot teardown).
 *
 * Two defects, two fixes:
 *   1. The +2s warmup `setTimeout` was NOT `.unref()`'d, so the pending timer
 *      alone held the loop for the whole delay. Fix: unref it.
 *   2. The warmup async work (LSP-prewarm children + a language-profile source
 *      walk) ran even in print mode, where it is pure waste AND outlives settle
 *      with no session_shutdown abort. Fix: skip the warmup entirely in print
 *      mode (`isPrintMode`); an interactive process's first session (also quick
 *      mode, but NOT print) still warms.
 *
 * The gate test FAILS on pre-fix code (warmup fires in print mode → phases
 * logged) and PASSES once gated. The unref test FAILS pre-fix (the warmup timer
 * is never unref'd) and PASSES once unref'd. The characterization test pins that
 * an interactive (non-print) quick-mode first session still warms.
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { waitForProjectSnapshotPersistsForTests } from "../../clients/project-snapshot.js";
import { _resetSubagentModeForTests } from "../../clients/subagent-mode.js";
import {
	cleanupTestEnvironmentsDrained,
	createTempFile,
	setupTestEnvironment,
} from "./test-utils.js";

const touchFileSpy = vi.hoisted(() => vi.fn());
const logLatencySpy = vi.hoisted(() => vi.fn());

vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency: logLatencySpy };
});

import { handleSessionStart } from "../../clients/runtime-session.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { resetLSPConfigStateForTests } from "../../clients/lsp/config.js";
import { pinFixtureHome } from "./test-utils.js";

function makeDeps(ctxCwd: string, overrides: Record<string, unknown> = {}) {
	return withResidentBootstrap({
		ctxCwd,
		getFlag: () => false,
		notify: vi.fn(),
		dbg: () => {},
		log: () => {},
		runtime: new RuntimeCoordinator(),
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

describe("quick-mode warmup one-shot retention (#1154)", () => {
	const globals = globalThis as unknown as {
		__piLensFirstSessionDone?: boolean;
		__piLensWarmupScheduled?: boolean;
	};
	let prevFirst: boolean | undefined;
	let prevWarmup: boolean | undefined;
	let prevDelay: string | undefined;
	let prevStartupMode: string | undefined;
	let previousDataDir: string | undefined;
	let prevArgv: string[];

	beforeEach(async () => {
		// The real config loader walks up from the session cwd to HOME (#4709);
		// a pinned fixture HOME keeps that read off the maintainer's home.
		pinFixtureHome("runtime-session-warmup-oneshot");
		await installLspServiceDouble({
			touchFile: touchFileSpy,
			supportsLSP: (file: string) => file.endsWith(".ts"),
		});
		prevFirst = globals.__piLensFirstSessionDone;
		prevWarmup = globals.__piLensWarmupScheduled;
		prevDelay = process.env.PI_LENS_WARMUP_DELAY_MS;
		prevStartupMode = process.env.PI_LENS_STARTUP_MODE;
		previousDataDir = process.env.PILENS_DATA_DIR;
		prevArgv = process.argv;
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
		resetLSPConfigStateForTests();
		globals.__piLensFirstSessionDone = prevFirst;
		globals.__piLensWarmupScheduled = prevWarmup;
		if (prevDelay === undefined) delete process.env.PI_LENS_WARMUP_DELAY_MS;
		else process.env.PI_LENS_WARMUP_DELAY_MS = prevDelay;
		if (prevStartupMode === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prevStartupMode;
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		process.argv = prevArgv;
		vi.restoreAllMocks();
		_resetSubagentModeForTests();
	});

	const cleanupWarmupOneshotTemps = async () => {
		// Warmup persists the runtime snapshot after its latency record; drain
		// that worker before the final macrotask sweep removes this family's roots.
		await cleanupTestEnvironmentsDrained("pi-lens-warmup-oneshot-", {
			beforeDrain: waitForProjectSnapshotPersistsForTests,
		});
	};

	afterEach(cleanupWarmupOneshotTemps);
	afterAll(cleanupWarmupOneshotTemps);

	it("does NOT schedule/run the warmup in print mode (`-p`/`--print`) — the one-shot retention fix", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-oneshot-print-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		// Simulate a one-shot print invocation. resolveStartupMode() forces quick
		// mode for this, exactly as it does for a real `pi -p`.
		process.argv = [...prevArgv, "--print"];
		try {
			const cwd = makeWarmableProject(env);
			await handleSessionStart(makeDeps(cwd));

			// Give a generous window for a (pre-fix) warmup with delay=1ms to fire
			// and log its phases. Post-fix nothing is scheduled at all.
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Pre-fix these phases are logged and a dominant LSP warm touchFile
			// fires; post-fix none of the warmup runs.
			expect(logLatencySpy).not.toHaveBeenCalledWith(
				expect.objectContaining({ phase: "warmup_total" }),
			);
			expect(logLatencySpy).not.toHaveBeenCalledWith(
				expect.objectContaining({ phase: "warmup_scan_context" }),
			);
			expect(
				touchFileSpy.mock.calls.some(
					([, , opts]) =>
						(opts as { source?: string })?.source === "startup-warm-dominant",
				),
			).toBe(false);
			// The warmup guard is left unset so no future session in this process
			// is blocked from warming.
			expect(globals.__piLensWarmupScheduled).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("`.unref()`'s the warmup timer when it IS scheduled (interactive first session) — the ref'd-handle fix", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-oneshot-unref-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		// A distinctive, large delay lets us pick the warmup timer out of the
		// other session-start timers by its delay arg, and guarantees its async
		// body never fires during the test (so we assert only the unref).
		const WARMUP_DELAY = 987654;
		process.env.PI_LENS_WARMUP_DELAY_MS = String(WARMUP_DELAY);
		// NOT print mode → interactive first-session quick warmup IS scheduled.
		process.argv = prevArgv.filter((a) => a !== "--print" && a !== "-p");

		const realSetTimeout = globalThis.setTimeout;
		const unrefedWarmupTimers: NodeJS.Timeout[] = [];
		const scheduledWarmupTimers: NodeJS.Timeout[] = [];
		const setTimeoutSpy = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation(((fn: () => void, ms?: number) => {
				const timer = realSetTimeout(fn, ms) as NodeJS.Timeout;
				if (ms === WARMUP_DELAY) {
					scheduledWarmupTimers.push(timer);
					const origUnref = timer.unref.bind(timer);
					timer.unref = () => {
						unrefedWarmupTimers.push(timer);
						return origUnref();
					};
				}
				return timer;
			}) as unknown as typeof setTimeout);

		try {
			const cwd = makeWarmableProject(env);
			await handleSessionStart(makeDeps(cwd));

			// The warmup timer was scheduled...
			expect(scheduledWarmupTimers.length).toBe(1);
			// ...and it was unref'd (pre-fix: zero — the exact ref'd handle that
			// held a one-shot process alive for the warmup delay).
			expect(unrefedWarmupTimers.length).toBe(1);
		} finally {
			for (const t of scheduledWarmupTimers) clearTimeout(t);
			setTimeoutSpy.mockRestore();
			env.cleanup();
		}
	});

	it("still warms in an interactive (non-print) quick-mode first session — characterization", async () => {
		const env = setupTestEnvironment("pi-lens-warmup-oneshot-interactive-");
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		// Interactive first session: quick mode, but NOT a print one-shot.
		process.argv = prevArgv.filter((a) => a !== "--print" && a !== "-p");
		try {
			const cwd = makeWarmableProject(env);
			await handleSessionStart(makeDeps(cwd));

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
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// #5419 warmup row: the warmup timer's delay is the PI_LENS_WARMUP_DELAY_MS
	// read (a fraction floors, a non-numeric value takes the 2000 ms default). A
	// reader that returned its default for every value would arm 2000 ms for the
	// fractional case, and a `Number(raw)` reader armed NaN (a 1 ms timer) for "abc".
	describe("warmup timer delay reads PI_LENS_WARMUP_DELAY_MS (#5419)", () => {
		const armWarmupAndCollectDelays = async (
			value: string,
			armedValue: number,
		) => {
			const env = setupTestEnvironment("pi-lens-warmup-oneshot-delay-");
			process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
			process.env.PI_LENS_WARMUP_DELAY_MS = value;
			process.argv = prevArgv.filter((a) => a !== "--print" && a !== "-p");
			const realSetTimeout = globalThis.setTimeout;
			const delays: unknown[] = [];
			const scheduled: NodeJS.Timeout[] = [];
			const setTimeoutSpy = vi
				.spyOn(globalThis, "setTimeout")
				.mockImplementation(((fn: () => void, ms?: number) => {
					const timer = realSetTimeout(fn, ms) as NodeJS.Timeout;
					delays.push(ms);
					if (ms === armedValue) scheduled.push(timer);
					return timer;
				}) as unknown as typeof setTimeout);
			try {
				await handleSessionStart(makeDeps(makeWarmableProject(env)));
				return { delays, scheduled };
			} finally {
				for (const t of scheduled) clearTimeout(t);
				setTimeoutSpy.mockRestore();
				env.cleanup();
			}
		};

		it("arms the warmup at the floored value of a fractional delay", async () => {
			// A distinctive large value keeps the warmup body from firing during the test.
			const { delays, scheduled } = await armWarmupAndCollectDelays(
				"123457.9",
				123457,
			);
			expect(delays).toContain(123457);
			expect(scheduled).toHaveLength(1);
		});

		it("arms the 2000 ms default for a non-numeric value, never a NaN or 1 ms timer", async () => {
			const { delays } = await armWarmupAndCollectDelays("abc", 2000);
			expect(delays).toContain(2000);
			expect(
				delays.filter(
					(ms) => typeof ms === "number" && (Number.isNaN(ms) || ms < 2),
				),
			).toEqual([]);
		});
	});
});
