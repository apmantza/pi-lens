/**
 * #4815: the deferred startup scans resolve the analyzer clients across an
 * `await` (`demandBootstrapDeps`, #2467), then read `deps.getFlag` /
 * `deps.notify`. A reload that lands during that await makes those reads throw
 * the host's stale-ctx error; the fire-and-forget IIFE had no catch, so the
 * throw became an unhandled rejection (CI run 40123430679, job 120959715165:
 * Vitest failed a shard with every test green; a real Node host can exit).
 *
 * Production chain: the real `handleSessionStart`, the real
 * `RuntimeCoordinator`, the real scan scheduler. Doubled: the host ctx
 * (`getFlag` throws the SDK's own stale message once "reloaded") and the
 * bootstrap seam's `request`, held open so the reload can land inside the
 * await.
 */

import { withResidentBootstrap } from "../support/bootstrap-access.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { _resetSubagentModeForTests } from "../../clients/subagent-mode.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { resetLSPConfigStateForTests } from "../../clients/lsp/config.js";
import {
	getProjectSnapshotPersistErrorForTests,
	getProjectSnapshotPersistStateForTests,
	setProjectSnapshotPromotionSeamForTests,
} from "../../clients/project-snapshot.js";
import { suspendAt, waitFor } from "./interleaving-kit.js";
import { withEnv } from "../support/with-env.js";
import {
	drainBackgroundWritesForTests,
	pinFixtureHome,
	setupTestEnvironment,
} from "./test-utils.js";

/** The pi SDK's own `assertActive()` message after a session replacement. */
const SDK_STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. " +
	"Do not use a captured pi or command ctx after ctx.newSession(), " +
	"ctx.fork(), ctx.switchSession(), or ctx.reload().";

/** A bootstrap demand the test releases by hand. */
function gatedBootstrap() {
	let release!: (clients: Record<string, unknown> | null) => void;
	const gate = new Promise<Record<string, unknown> | null>((resolve) => {
		release = resolve;
	});
	return { gate, release };
}

function makeDeps(
	ctxCwd: string,
	runtime: RuntimeCoordinator,
	hooks: {
		getFlag: (name: string) => boolean | string | undefined;
		notify: (message: string, level?: string) => void;
		scanFile: () => unknown[];
		writeCache: (key: string) => void;
		demand: () => Promise<Record<string, unknown> | null>;
	},
) {
	const deps = withResidentBootstrap({
		ctxCwd,
		getFlag: hooks.getFlag,
		notify: hooks.notify,
		dbg: () => {},
		log: () => {},
		runtime,
		cacheManager: {
			writeCache: hooks.writeCache,
			readCache: () => null,
		},
		todoScanner: {
			scanDirectory: () => ({ items: [] }),
			scanFile: hooks.scanFile,
		},
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
	});
	// Hold the scans' analyzer demand open, then answer with the resident
	// clients the fixture already carries (what the production seam does once
	// the load lands).
	const resident = deps.bootstrap;
	deps.bootstrap = {
		peek: () => resident.peek(),
		request: async (reason: string) => {
			if (reason !== "session-start-scans") return resident.request(reason);
			await hooks.demand();
			return resident.request(reason);
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: test double for the deps bag
	return deps as any;
}

describe("session replaced during the analyzer bootstrap await (#4815)", () => {
	const globals = globalThis as unknown as {
		__piLensFirstSessionDone?: boolean;
		__piLensWarmupScheduled?: boolean;
	};
	let prevFirst: boolean | undefined;
	let prevStartupMode: string | undefined;
	let restoreDataDir: () => void;
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(async () => {
		pinFixtureHome("runtime-session-stale-ctx-scans-4815");
		await installLspServiceDouble({ supportsLSP: () => false });
		prevFirst = globals.__piLensFirstSessionDone;
		prevStartupMode = process.env.PI_LENS_STARTUP_MODE;
		globals.__piLensFirstSessionDone = true;
		process.env.PI_LENS_STARTUP_MODE = "full";
		resetDegradationLedger();
		_resetSubagentModeForTests();
		env = setupTestEnvironment("pi-lens-stale-ctx-scans-4815-");
		restoreDataDir = withEnv({
			PILENS_DATA_DIR: path.join(env.tmpDir, "data"),
		});
	});

	afterEach(async () => {
		resetLSPConfigStateForTests();
		globals.__piLensFirstSessionDone = prevFirst;
		if (prevStartupMode === undefined) delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = prevStartupMode;
		_resetSubagentModeForTests();
		await teardownFixture();
	});

	/**
	 * Remove the fixture root. The session start queues a project-snapshot
	 * persist that outlives the test, and its write recreates the root when it
	 * lands after the removal (#4958). Order matters in both directions:
	 *  1. wait for this fixture's persist to land, on the event with a
	 *     real-clock deadline that throws (the drain below stops at a silent
	 *     2 s cap and swallows hook errors, so it cannot be the only wait);
	 *  2. drain the other background writers;
	 *  3. restore `PILENS_DATA_DIR`, only now: the persist resolves the meta
	 *     path from the live env when it lands, so an earlier restore sends it
	 *     to a directory that does not exist (ENOENT, a recorded persist
	 *     failure);
	 *  4. remove the root.
	 * Every test's afterEach and the regression case below run this one
	 * function; the restore is idempotent.
	 */
	async function teardownFixture(timeoutMs?: number): Promise<void> {
		await waitFor(
			() =>
				getProjectSnapshotPersistStateForTests(
					path.join(env.tmpDir, "project"),
				),
			(state) => !state.active && !state.queued,
			{ timeoutMs },
		);
		await drainBackgroundWritesForTests();
		restoreDataDir();
		env.cleanup();
	}

	function project(): string {
		const cwd = path.join(env.tmpDir, "project");
		fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "index.ts"), "export const x = 1;\n");
		fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"p"}');
		fs.writeFileSync(path.join(cwd, "tsconfig.json"), "{}");
		return cwd;
	}

	/** Let every macrotask the deferred path can schedule run. */
	async function drain(): Promise<void> {
		for (let i = 0; i < 6; i++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}

	function staleGroup() {
		return getDegradationSummary().find(
			(group) => group.kind === "extension-ctx-stale",
		);
	}

	/**
	 * Start a session, hold the scans' bootstrap demand open, replace the
	 * session, and release the demand. `reads` names the host reads that throw
	 * the stale message once the session is replaced.
	 */
	async function reloadDuringBootstrap(reads: {
		flag: boolean;
		notify: boolean;
	}) {
		const cwd = project();
		const runtime = new RuntimeCoordinator();
		let replaced = false;
		const demand = gatedBootstrap();
		const scanFile = vi.fn((): unknown[] => []);
		const writeCache = vi.fn((_key: string) => {});
		const notify = vi.fn((_message: string) => {
			if (replaced && reads.notify) throw new Error(SDK_STALE_MESSAGE);
		});
		const getFlag = (name: string): boolean | string | undefined => {
			if (replaced && reads.flag) throw new Error(SDK_STALE_MESSAGE);
			return name === "lens-lsp";
		};
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await handleSessionStart(
				makeDeps(cwd, runtime, {
					getFlag,
					notify,
					scanFile,
					writeCache,
					demand: () => demand.gate,
				}),
			);
			// The reload lands while the scans still wait on the analyzers.
			replaced = true;
			runtime.resetForSession();
			demand.release(null);
			await drain();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		return { cwd, unhandled, scanFile, writeCache, notify };
	}

	it("leaves no unhandled rejection when the flag read meets the stale ctx", async () => {
		const { unhandled } = await reloadDuringBootstrap({
			flag: true,
			notify: false,
		});
		expect(unhandled).toEqual([]);
	});

	it("skips the replaced session's scans and records one bounded extension-ctx-stale", async () => {
		const { unhandled, scanFile, writeCache } = await reloadDuringBootstrap({
			flag: true,
			notify: false,
		});
		expect(unhandled).toEqual([]);
		expect(scanFile).not.toHaveBeenCalled();
		expect(writeCache).not.toHaveBeenCalledWith("todo-baseline");
		const group = staleGroup();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe("session-start-scans");
	});

	it("is also quiet when only the subagent-skip notify is stale", async () => {
		// `deps.notify` is the scan body's other post-await ctx read; it fires
		// only on the skip path a pi-subagents child takes (#449).
		const prevChild = process.env.PI_SUBAGENT_CHILD;
		process.env.PI_SUBAGENT_CHILD = "1";
		_resetSubagentModeForTests();
		try {
			const { unhandled, notify } = await reloadDuringBootstrap({
				flag: false,
				notify: true,
			});
			expect(
				notify.mock.calls.some(([m]) => /Skipped background/.test(m)),
			).toBe(true);
			expect(unhandled).toEqual([]);
		} finally {
			if (prevChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
			else process.env.PI_SUBAGENT_CHILD = prevChild;
			_resetSubagentModeForTests();
		}
	});

	it("keeps a NON-stale failure in the scheduler loud instead of absorbing it", async () => {
		// The guard classifies by message only; a pi-lens bug must stay visible.
		const cwd = project();
		const runtime = new RuntimeCoordinator();
		let broken = false;
		const demand = gatedBootstrap();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		// Vitest's own listener would also fail the run; take it out for the
		// duration so this case asserts the escape itself.
		const vitestListeners = process.listeners("unhandledRejection");
		for (const listener of vitestListeners) {
			if (listener !== onUnhandled) process.off("unhandledRejection", listener);
		}
		try {
			await handleSessionStart(
				makeDeps(cwd, runtime, {
					getFlag: (name) => {
						if (broken) throw new Error("boom: not a stale ctx");
						return name === "lens-lsp";
					},
					notify: () => {},
					scanFile: () => [],
					writeCache: () => {},
					demand: () => demand.gate,
				}),
			);
			broken = true;
			demand.release(null);
			await drain();
		} finally {
			process.off("unhandledRejection", onUnhandled);
			for (const listener of vitestListeners) {
				if (listener !== onUnhandled)
					process.on("unhandledRejection", listener);
			}
		}
		expect(unhandled.map((reason) => String(reason))).toEqual([
			"Error: boom: not a stale ctx",
		]);
		expect(staleGroup()).toBeUndefined();
	});

	it("still schedules the scans for a live session (the guard is not a blanket skip)", async () => {
		const cwd = project();
		const runtime = new RuntimeCoordinator();
		let todoBaselineWritten!: () => void;
		const written = new Promise<void>((resolve) => {
			todoBaselineWritten = resolve;
		});
		const writeCache = vi.fn((key: string) => {
			if (key === "todo-baseline") todoBaselineWritten();
		});
		const demand = gatedBootstrap();
		await handleSessionStart(
			makeDeps(cwd, runtime, {
				getFlag: (name) => name === "lens-lsp",
				notify: () => {},
				scanFile: () => [],
				writeCache,
				demand: () => demand.gate,
			}),
		);
		demand.release(null);
		// The live session's own TODO scan is the proof the scans were scheduled.
		await written;
		expect(staleGroup()).toBeUndefined();
	});

	it("leaves no fixture root and no failed persist once the session-start snapshot write has landed (#4958)", async () => {
		// The writer is the project-snapshot persist the session start queues. Its
		// worker thread writes the stage file under the root (clients/gzip-stage-write.ts,
		// a recursive mkdir), and the main thread promotes it with a lock mkdir
		// (clients/project-snapshot.ts promoteSnapshotBody). Either recreates
		// `env.tmpDir` when it lands after the removal, and its meta write resolves
		// `PILENS_DATA_DIR` when it lands, not when it was queued. The promotion
		// seam parks the persist in flight until the test releases it, so the
		// order is controlled instead of timed.
		const errorBefore = getProjectSnapshotPersistErrorForTests();
		const seam = vi.fn(async () => {});
		const gate = suspendAt(seam);
		setProjectSnapshotPromotionSeamForTests(seam);
		try {
			const { cwd } = await reloadDuringBootstrap({
				flag: true,
				notify: false,
			});
			await gate.admitted;
			// Parked at the seam: the persist is in flight, deterministically.
			expect(getProjectSnapshotPersistStateForTests(cwd).active).toBe(true);
			let tornDown = false;
			const tearingDown = teardownFixture().then(() => {
				tornDown = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			// Teardown must be parked on the persist, root untouched.
			expect(tornDown).toBe(false);
			expect(fs.existsSync(env.tmpDir)).toBe(true);
			gate.release();
			await tearingDown;
			expect(fs.existsSync(env.tmpDir)).toBe(false);
			expect(getProjectSnapshotPersistErrorForTests()).toBe(errorBefore);
		} finally {
			setProjectSnapshotPromotionSeamForTests(undefined);
			gate.restore();
		}
	});

	it("fails the teardown loudly when the snapshot persist never lands (#4958)", async () => {
		// Recurrence: the shared drain stops at a silent 2 s cap and swallows hook
		// errors, so a persist still in flight let the root removal run and the
		// write recreate the root (the thread on #4969 r2). The fixture's own
		// wait ends on the event or a real-clock deadline, and the deadline throws.
		const seam = vi.fn(async () => {});
		const gate = suspendAt(seam);
		setProjectSnapshotPromotionSeamForTests(seam);
		try {
			await reloadDuringBootstrap({ flag: true, notify: false });
			await gate.admitted;
			await expect(teardownFixture(150)).rejects.toThrow(/waitFor exhausted/);
			// The parked persist must have kept the root: nothing removed it.
			expect(fs.existsSync(env.tmpDir)).toBe(true);
		} finally {
			setProjectSnapshotPromotionSeamForTests(undefined);
			gate.restore();
		}
	});
});
