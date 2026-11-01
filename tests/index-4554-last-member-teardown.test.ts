// flake-shape: in-process-mock — two activations share one process; each asserts its OWN module-level `resetLSPService` spy (the r7 cell reads the first activation's spy after the second has booted), and the singleton lifecycle holds one `beforeReset` at a time, so the seam cannot tell the activations apart; the stand-in never spawns a language server, so no child process and no real wire take part.
/**
 * #4554 witness: the shared session teardown belongs to the LAST live session
 * of one pi-lens activation, not to the role that activation recorded last.
 *
 * Reproduced shape (one extension activation, which is the double's shape, not
 * the host's: pi's loader caches the factory and calls it per load, so two
 * live sessions are two activations, #4704): `session_start` runs for M, then
 * S1, S2, S3 — same root, M live, so M is `primary` and each S is
 * `concurrent-secondary`. `index.ts`'s `ownedSessionRole` is last-write-wins,
 * so after S1's start it holds `concurrent-secondary` and EVERY later
 * shutdown, M's included, took the local-only branch: `cancelLSPIdleReset`,
 * `resetLSPService`, `deregisterInstance` and `releasePrimarySession` never
 * ran for the process. The process therefore kept its `instances.json` entry
 * and its stale primary registration forever.
 *
 * The observables are independent effects of that skipped teardown, not the
 * stored role: the process's primary registration (`getActiveSessionId`), the
 * process's registry entry (`readInstanceRegistry`/`getInstanceRoots`), the
 * LSP-fleet reset call, and the one bounded record the last-member teardown
 * leaves when it runs on behalf of a session classified secondary.
 *
 * The cells below are the state table: main last, main before the last
 * secondary, a non-last leave, one sequential replacement, one separate
 * activation, and one different-root start.
 */

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
import {
	_resetSessionLifecycleForTests,
	getActiveSessionId,
	getSecondarySessionCount,
} from "../clients/session-lifecycle.js";
import {
	_settleRegistryMutationsForTests,
	deregisterInstance,
	getInstanceRoots,
	readInstanceRegistry,
} from "../clients/instance-registry.js";
import { _resetProcessSingletonsForTests } from "../clients/process-singletons.js";
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx, STALE_CTX_MESSAGE } from "./support/pi-mock.js";
import { makeLspServiceDouble } from "./support/lsp-service-double.js";
import { aliveServerHolder } from "./support/lsp-status-repaint.js";
import {
	cleanupTestEnvironmentsDrained,
	drainBackgroundWritesForTests,
	setupTestEnvironment,
} from "./clients/test-utils.js";

/** The phase record the last-member teardown leaves when it runs for a
 *  session whose own classification is secondary (#4554). */
const LAST_MEMBER_PHASE = "session_teardown_last_member";

const TMP_PREFIX = "pi-lens-4554-";
// A literal timeout, not a shared constant: `it(title, fn, <identifier>)` reads
// to tests/support/sweep-kit.ts's callOptions as an unread options object, so
// every cell here would count as not-live and no pin could cite it (#4393).

let env: ReturnType<typeof setupTestEnvironment>;
let root: string;
let project: string;
let previousStartupMode: string | undefined;
let previousDataDir: string | undefined;
let previousHome: string | undefined;
let previousTestMode: string | undefined;

/**
 * Boot one extension activation against a fresh pi mock. `resetLSPService` is
 * the LSP-fleet seam `index.ts` calls at session_start and at the shared
 * teardown, so a case can tell the two apart by `reason`.
 */
async function bootActivation(): Promise<{
	pi: ReturnType<typeof createPiMock>;
	resetLSPService: ReturnType<typeof vi.fn>;
}> {
	const { resetLSPService, overrides } = aliveServerHolder();
	vi.doMock("../clients/lsp/capabilities.js", () => ({
		getLSPService: () => makeLspServiceDouble(overrides),
		resetLSPService,
	}));
	const { default: registerExtension } = await import("../index.js");
	const pi = createPiMock();
	registerExtension(pi.asExtensionAPI());
	return { pi, resetLSPService };
}

function start(
	pi: ReturnType<typeof createPiMock>,
	ctx: unknown,
	reason = "startup",
): Promise<unknown> {
	return pi.emit("session_start", { type: "session_start", reason }, ctx);
}

function shutdown(
	pi: ReturnType<typeof createPiMock>,
	ctx: unknown,
	event: Record<string, unknown> = { type: "session_shutdown", reason: "quit" },
): Promise<unknown> {
	return pi.emit("session_shutdown", event, ctx);
}

/** Teardown calls the shared branch makes: `processExiting` only appears
 *  there, never at a session_start's own reset. */
function teardownResets(resetLSPService: ReturnType<typeof vi.fn>): unknown[] {
	return resetLSPService.mock.calls
		.map(([options]) => options)
		.filter(
			(options) => (options as { processExiting?: boolean })?.processExiting,
		);
}

/** The resets a full session_start made: the shared teardown's carry
 *  `processExiting` instead. */
function sessionStartResets(
	resetLSPService: ReturnType<typeof vi.fn>,
): unknown[] {
	return resetLSPService.mock.calls
		.map(([options]) => options)
		.filter(
			(options) => (options as { reason?: string })?.reason === "session_start",
		);
}

/** The latency sink the activation under test writes to, and the lines it holds.
 *
 *  Resolved AFTER the activation boots, never at module load. `beforeEach`
 *  pins `PI_LENS_HOME` (#3042/#3050) and the logger binds its path when the
 *  module loads, so a top-level import would read the run-shared home's file
 *  while the fresh activation wrote the pinned one (shape 14/67). */
async function latencySink(): Promise<{
	clear: () => void;
	flush: () => Promise<unknown>;
	lines: () => Promise<string[]>;
}> {
	const mod = await import("../clients/latency-logger.js");
	return {
		clear: () => mod.clearLatencyLog(),
		flush: () => mod.flushLatencyLog(),
		// Shape 67: the drain sits inside the reading helper, and no await sits
		// between it and the read.
		lines: async () => {
			await mod.flushLatencyLog();
			try {
				return fs.readFileSync(mod.getLatencyLogPath(), "utf8").split("\n");
			} catch {
				return [];
			}
		},
	};
}

type LatencySink = Awaited<ReturnType<typeof latencySink>>;

/** Rows this sink holds, parsed, skipping any truncated tail line. */
async function sinkRows(
	sink: LatencySink,
): Promise<Array<{ phase?: string; metadata?: unknown }>> {
	return (await sink.lines()).flatMap((line) => {
		try {
			return [JSON.parse(line) as { phase?: string; metadata?: unknown }];
		} catch {
			return [];
		}
	});
}

/** The scoped rows of the last-member teardown record. */
async function teardownRowsIn(
	sink: LatencySink,
): Promise<Array<{ metadata?: unknown }>> {
	return (await sinkRows(sink)).filter(
		(row) => row.phase === LAST_MEMBER_PHASE,
	) as Array<{ metadata?: unknown }>;
}

/**
 * The sidecar record `saveSessionState` writes. Declared from an import TYPE,
 * never from the body's dynamic import: a signature cannot see a name that
 * exists only inside the function body (Greptile #4563 r6).
 */
type SessionSidecar = Awaited<
	ReturnType<
		typeof import("../clients/session-state-store.js").loadSessionState
	>
>;

/**
 * Read a session sidecar once its fire-and-forget write lands. The writer is
 * `saveSessionState` (unowned by any drained writer registry), so the wait is a
 * bounded run of event-loop turns, never a wall-clock sleep.
 */
async function sidecarFor(
	cwd: string,
	sessionId: string,
): Promise<SessionSidecar> {
	const { loadSessionState } =
		await import("../clients/session-state-store.js");
	for (let turn = 0; turn < 50; turn += 1) {
		const state = await loadSessionState(cwd, sessionId);
		if (state !== undefined) return state;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	return undefined;
}

/** The rows that record a departing scope being retired at a shutdown. */
async function shutdownScopeRows(sink: LatencySink): Promise<unknown[]> {
	return (await sinkRows(sink)).filter(
		(row) =>
			row.phase === "session_scope_transition" &&
			(row.metadata as { transition?: string })?.transition === "shutdown",
	);
}

/** The roots this process's registry entry currently holds. */
async function rootsForThisPid(): Promise<string[]> {
	const entry = (await readInstanceRegistry()).find(
		(candidate) => candidate.pid === process.pid,
	);
	return entry ? getInstanceRoots(entry) : [];
}

async function settleRegistryWrites(): Promise<void> {
	await _settleRegistryMutationsForTests();
}

beforeEach(async () => {
	vi.resetModules();
	vi.clearAllMocks();
	_resetProcessSingletonsForTests();
	_resetSessionLifecycleForTests();
	env = setupTestEnvironment(TMP_PREFIX);
	root = env.tmpDir;
	project = path.join(root, "project");
	fs.mkdirSync(path.join(project, ".git"), { recursive: true });
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	previousStartupMode = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = "quick";
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(root, "data");
	// #3042/#3050: the instance registry lives under the machine-global
	// PI_LENS_HOME, so pin it here rather than reach the run-shared one.
	previousHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_HOME = path.join(root, "home");
	// The registry entry is keyed by pid: drain a previous case's
	// fire-and-forget writes, then start from no entry of our own.
	await new Promise<void>((resolve) => setImmediate(resolve));
	await settleRegistryWrites();
	deregisterInstance();
	await settleRegistryWrites();
});

afterEach(async () => {
	try {
		// #5146: end the case's sessions first, then settle what they wrote.
		await endMockSessions();
		await drainBackgroundWritesForTests();
		await settleRegistryWrites();
		deregisterInstance();
		await settleRegistryWrites();
	} finally {
		vi.doUnmock("../clients/lsp/capabilities.js");
		vi.restoreAllMocks();
		_resetSessionLifecycleForTests();
		if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previousTestMode;
		if (previousStartupMode === undefined)
			delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = previousStartupMode;
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		env.cleanup();
	}
});

afterAll(async () => {
	await cleanupTestEnvironmentsDrained(TMP_PREFIX);
});

describe("#4554 one activation, four live sessions", () => {
	it("r5 reconciles the superseded primary on sequential admission", async () => {
		// Greptile F1: a stale primary without a delivered shutdown stranded the replacement.
		const { pi, resetLSPService } = await bootActivation();
		const first = makeCtx({ cwd: project, sessionId: "old" });
		await start(pi, first);
		Object.defineProperty(first, "isIdle", {
			get() {
				throw new Error(STALE_CTX_MESSAGE);
			},
		});
		const replacement = makeCtx({ cwd: project, sessionId: "replacement" });
		await start(pi, replacement, "new");
		expect(getActiveSessionId()).toBe("replacement");
		await shutdown(pi, replacement);
		expect(teardownResets(resetLSPService)).toHaveLength(1);
		expect(getActiveSessionId()).toBeUndefined();
	}, 45_000);

	it("r5 old activation cannot tear down a reloaded primary with the same id", async () => {
		// Greptile F2: past ownership in A must not destroy B's servers/registration.
		const a = await bootActivation();
		const primary = makeCtx({ cwd: project, sessionId: "m" });
		const sibling = makeCtx({ cwd: project, sessionId: "s" });
		await start(a.pi, primary);
		await start(a.pi, sibling);
		await shutdown(a.pi, primary, { reason: "reload" });
		vi.resetModules();
		const b = await bootActivation();
		const reloaded = makeCtx({ cwd: project, sessionId: "m" });
		await start(b.pi, reloaded, "reload");
		await shutdown(a.pi, sibling);
		expect(teardownResets(a.resetLSPService)).toHaveLength(0);
		expect(getActiveSessionId()).toBe("m");
		await settleRegistryWrites();
		expect(await rootsForThisPid()).toContain(project);
		await shutdown(b.pi, reloaded);
		expect(teardownResets(b.resetLSPService)).toHaveLength(1);
	}, 45_000);

	it("r7 a sibling left behind by a reload into another activation tears the shared infra down last", async () => {
		// #4704, the mirror order of the r5 case above: the reloaded primary
		// leaves while the old activation's sibling is live, so the process's
		// last live session is that sibling. The reloaded primary's own leave
		// releases its registration; the sibling's leave tears the infra down.
		const a = await bootActivation();
		const primary = makeCtx({ cwd: project, sessionId: "m" });
		const sibling = makeCtx({ cwd: project, sessionId: "s" });
		await start(a.pi, primary);
		await start(a.pi, sibling);
		await shutdown(a.pi, primary, { reason: "reload" });
		vi.resetModules();
		const b = await bootActivation();
		const reloaded = makeCtx({ cwd: project, sessionId: "m" });
		await start(b.pi, reloaded, "reload");

		await shutdown(b.pi, reloaded);
		// The sibling on the other activation is live: the shared infra stays
		// under it, and only the departing holder's registration goes.
		expect(teardownResets(b.resetLSPService)).toHaveLength(0);
		expect(getActiveSessionId()).toBeUndefined();
		await settleRegistryWrites();
		expect(await rootsForThisPid()).toContain(project);

		await shutdown(a.pi, sibling);
		expect(teardownResets(a.resetLSPService)).toHaveLength(1);
		expect(getActiveSessionId()).toBeUndefined();
		await settleRegistryWrites();
		expect(await rootsForThisPid()).not.toContain(project);
	}, 45_000);

	it.each([true, false])(
		"r5 reload hands off the departing primary scope (secondary leaves first: %s)",
		async (secondaryLeavesFirst) => {
			// Greptile F3: the last-started secondary scope replaced M's reload snapshot.
			const { pi } = await bootActivation();
			const { defineSessionStore, takeHandoff, startKey } =
				await import("../clients/session-scope.js");
			defineSessionStore({
				name: "r5-scope-witness",
				policy: {
					startup: "none",
					new: "none",
					resume: "none",
					fork: "adopt",
					reload: "adopt",
				},
				snapshot: (scope) => scope.role,
				restore() {},
				reason: "Distinguish the real scope snapshotted by shutdown.",
			});
			const primary = makeCtx({ cwd: project, sessionId: "m" });
			const sibling = makeCtx({ cwd: project, sessionId: "s" });
			await start(pi, primary);
			await start(pi, sibling);
			if (secondaryLeavesFirst) await shutdown(pi, sibling);
			await shutdown(pi, primary, { reason: "reload" });
			const stores = takeHandoff(
				"reload",
				startKey(undefined, primary.sessionManager),
			);
			expect(stores?.["r5-scope-witness"]).toBe("primary");
			if (!secondaryLeavesFirst) await shutdown(pi, sibling);
		},
		45_000,
	);

	it("r5 retires the departing scope when its handoff snapshot throws", async () => {
		// #3611 finally must still cover the F3 handoff moved for per-member scope selection.
		const { pi } = await bootActivation();
		const { defineSessionStore } = await import("../clients/session-scope.js");
		let snapshotScope:
			| import("../clients/session-scope.js").SessionScope
			| undefined;
		defineSessionStore({
			name: "r5-throwing-snapshot",
			policy: {
				startup: "none",
				new: "none",
				resume: "none",
				fork: "adopt",
				reload: "adopt",
			},
			snapshot(scope) {
				snapshotScope = scope;
				throw new Error("r5 snapshot fault");
			},
			restore() {},
			reason: "Pin retirement around the moved primary handoff.",
		});
		const primary = makeCtx({ cwd: project, sessionId: "throwing-primary" });
		await start(pi, primary);
		await expect(shutdown(pi, primary, { reason: "reload" })).rejects.toThrow(
			"r5 snapshot fault",
		);
		expect(snapshotScope?.retiredBy()).toBe("reload");
	}, 45_000);

	it("r5 last secondary clears its turn partition and retains its cache label", async () => {
		// Greptile F4: shared teardown used to bypass the last member's own cleanup.
		process.env.PI_LENS_TEST_MODE = "0";
		const { pi } = await bootActivation();
		const { CacheManager } = await import("../clients/cache-manager.js");
		const { RuntimeCoordinator } =
			await import("../clients/runtime-coordinator.js");
		const turnSpy = vi.spyOn(RuntimeCoordinator.prototype, "beginTurn");
		const { logCacheUsage } = await import("../clients/cache-observability.js");
		const sink = await latencySink();
		const primary = makeCtx({ cwd: project, sessionId: "m" });
		const sibling = makeCtx({ cwd: project, sessionId: "s" });
		await start(pi, primary);
		await start(pi, sibling);
		await shutdown(pi, primary);
		// The secondary does work after the primary leaves: its partition must
		// be removed by its OWN shutdown, not by the earlier primary reset.
		await pi.emit("turn_start", { type: "turn_start" }, sibling);
		const coordinator = turnSpy.mock.contexts[0];
		if (!(coordinator instanceof RuntimeCoordinator))
			throw new Error("turn_start did not reach the real coordinator");
		const key = coordinator.turnKey("s");
		expect(coordinator.isLiveTurnKey(key)).toBe(true);
		const manager = new CacheManager();
		manager.ensureSecondaryTurnStatePartition(project, "s");
		expect(manager.readTurnState(project, "s").sessionId).toBe("s");
		logCacheUsage(
			{
				role: "assistant",
				provider: "anthropic",
				model: "claude-opus-4",
				usage: { input: 100, output: 10, cacheRead: 800, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 0,
			},
			undefined,
			{ sessionId: "s", sessionRole: "concurrent-secondary", turnIndex: 0 },
		);
		await shutdown(pi, sibling);
		expect(manager.readTurnState(project).sessions?.s).toBeUndefined();
		expect(coordinator.isLiveTurnKey(key)).toBe(false);
		const summaries = (await sinkRows(sink)).filter(
			(row) => row.phase === "cache_usage_summary",
		);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.metadata).toMatchObject({
			sessionRole: "concurrent-secondary",
			usageRecords: 1,
		});
	}, 45_000);

	it("runs the shared teardown once when the last session to leave is a secondary", async () => {
		const { pi, resetLSPService } = await bootActivation();
		const primary = makeCtx({ cwd: project, sessionId: "m-primary" });
		const s1 = makeCtx({ cwd: project, sessionId: "s1" });
		const s2 = makeCtx({ cwd: project, sessionId: "s2" });
		const s3 = makeCtx({ cwd: project, sessionId: "s3" });
		await start(pi, primary);
		for (const ctx of [s1, s2, s3]) await start(pi, ctx);
		await settleRegistryWrites();

		// main before the last secondary.
		await shutdown(pi, s1);
		expect(getSecondarySessionCount()).toBe(2);
		await shutdown(pi, primary);
		// The primary's leave must not have torn the shared infra down while
		// members were still live. #4704: it does release its own registration
		// (#2129 F3), which zeroes the observability counter by design (see
		// `releasePrimarySession`).
		expect(teardownResets(resetLSPService)).toHaveLength(0);
		expect(getActiveSessionId()).toBeUndefined();
		expect(getSecondarySessionCount()).toBe(0);
		await shutdown(pi, s2);
		expect(getSecondarySessionCount()).toBe(0);
		expect(await rootsForThisPid()).toContain(project);

		await shutdown(pi, s3);

		expect(getActiveSessionId()).toBeUndefined();
		await settleRegistryWrites();
		expect(await rootsForThisPid()).not.toContain(project);
		expect(teardownResets(resetLSPService)).toHaveLength(1);
	}, 45_000);

	it("never releases a sibling's registry root when the primary leaves first", async () => {
		const otherRoot = path.join(root, "sibling-project");
		fs.mkdirSync(path.join(otherRoot, ".git"), { recursive: true });
		const { pi } = await bootActivation();
		const primary = makeCtx({ cwd: project, sessionId: "m-primary" });
		// A different root is what makes this declined start take a hold of its
		// own in the registry entry (#2130).
		const sibling = makeCtx({ cwd: otherRoot, sessionId: "s-other-root" });
		await start(pi, primary);
		await start(pi, sibling);
		await settleRegistryWrites();
		expect(await rootsForThisPid()).toEqual(
			expect.arrayContaining([project, otherRoot]),
		);

		// The local-only branch now also serves a PRIMARY that leaves before its
		// siblings, and that branch's scoped deregistration is the secondary's
		// own hold: the primary must not end a hold a live sibling still needs.
		await shutdown(pi, primary);
		await settleRegistryWrites();
		expect(await rootsForThisPid()).toEqual(
			expect.arrayContaining([project, otherRoot]),
		);

		await shutdown(pi, sibling);
		await settleRegistryWrites();
		expect(await rootsForThisPid()).not.toContain(otherRoot);
	}, 45_000);

	it("records the one teardown a session classified secondary ran for", async () => {
		// Shape 67: flush the sink this record's own writer owns, then read the
		// file. The bounded in-memory phase ring (5 rows) cannot prove the
		// write landed, and the shared branch's own rows follow this one.
		process.env.PI_LENS_TEST_MODE = "0";

		// main last: the shared teardown ran for the primary, so no row.
		const first = await bootActivation();
		const firstSink = await latencySink();
		firstSink.clear();
		await firstSink.flush();
		const primary = makeCtx({ cwd: project, sessionId: "m-primary" });
		const sibling = makeCtx({ cwd: project, sessionId: "s1" });
		await start(first.pi, primary);
		await start(first.pi, sibling);
		await shutdown(first.pi, sibling);
		await shutdown(first.pi, primary);
		await firstSink.flush();
		expect(await teardownRowsIn(firstSink)).toHaveLength(0);

		// main before the last secondary: the one shared teardown ran for s1.
		vi.resetModules();
		const second = await bootActivation();
		const sink = await latencySink();
		sink.clear();
		await sink.flush();
		const primary2 = makeCtx({ cwd: project, sessionId: "m-second" });
		const sibling2 = makeCtx({ cwd: project, sessionId: "s2-second" });
		await start(second.pi, primary2);
		await start(second.pi, sibling2);
		await shutdown(second.pi, primary2);
		await shutdown(second.pi, sibling2);

		await sink.flush();
		const rows = await teardownRowsIn(sink);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.metadata).toMatchObject({
			sessionId: "s2-second",
			classification: "secondary",
		});

		// #3611's scope retires once, at the LAST member's leave: a non-last
		// leave leaves it current for the members behind it.
		expect(await shutdownScopeRows(sink)).toHaveLength(1);
	}, 45_000);

	it("counts a re-delivered session_start as one member, not two", async () => {
		// pi re-delivers `session_start` for one session (the same shape
		// `clients/session-scope.ts` admits once by event identity). A second
		// membership row for that id would keep the activation alive after its
		// only session left, and the shared teardown would never run.
		const { pi, resetLSPService } = await bootActivation();
		const primary = makeCtx({ cwd: project, sessionId: "m-primary" });
		await start(pi, primary);
		await start(pi, primary);
		const sibling = makeCtx({ cwd: project, sessionId: "s-duplicate" });
		await start(pi, sibling);
		await start(pi, sibling);
		await settleRegistryWrites();
		expect(await rootsForThisPid()).toContain(project);

		await shutdown(pi, primary);
		expect(teardownResets(resetLSPService)).toHaveLength(0);
		await shutdown(pi, sibling);

		expect(teardownResets(resetLSPService)).toHaveLength(1);
		expect(getActiveSessionId()).toBeUndefined();
		await settleRegistryWrites();
		expect(await rootsForThisPid()).not.toContain(project);
	}, 45_000);

	it("labels the primary's own cache summary primary when it leaves before a sibling", async () => {
		// The local-only branch now also serves a PRIMARY that leaves while a
		// sibling is still live, so its per-session records must carry that
		// session's real role, never the literal this branch used while only a
		// secondary could reach it.
		process.env.PI_LENS_TEST_MODE = "0";
		const { pi } = await bootActivation();
		const sink = await latencySink();
		sink.clear();
		await sink.flush();
		// Imported AFTER the activation booted: `vi.resetModules()` above gives
		// index.js a fresh cache-observability instance, so a top-level import
		// would be a second copy whose attribution map the shutdown never reads.
		const { logCacheUsage } = await import("../clients/cache-observability.js");
		const primary = makeCtx({ cwd: project, sessionId: "m-primary" });
		const sibling = makeCtx({ cwd: project, sessionId: "s1" });
		await start(pi, primary);
		await start(pi, sibling);
		// One usage record on the production seam, so the shutdown's summary
		// has something to emit.
		logCacheUsage(
			{
				role: "assistant",
				provider: "anthropic",
				model: "claude-opus-4",
				usage: { input: 100, output: 10, cacheRead: 800, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 0,
			},
			undefined,
			{ sessionId: "m-primary", turnIndex: 0 },
		);

		await shutdown(pi, primary);
		await sink.flush();
		const summaries = (await sinkRows(sink)).filter(
			(row) => row.phase === "cache_usage_summary",
		);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.metadata).toMatchObject({
			sessionRole: "primary",
			usageRecords: 1,
		});
	}, 45_000);

	it("r6 a superseded primary's delayed shutdown never tears down its replacement", async () => {
		// #4554 r6: r5's admission reconciliation removes the superseded primary
		// from membership, so its later shutdown is UNMATCHED — and the unmatched
		// branch answered `isLast: true` even with the replacement still live. The
		// owner test then passed for the REPLACEMENT's context, so the shared LSP
		// fleet and the registry entry were torn down under a live session, and
		// the `finally` retired that live session's scope.
		process.env.PI_LENS_TEST_MODE = "0";
		const { pi, resetLSPService } = await bootActivation();
		const sink = await latencySink();
		sink.clear();
		await sink.flush();
		const primary = makeCtx({ cwd: project, sessionId: "old" });
		await start(pi, primary);
		// pi disposes the replaced ctx before it delivers that ctx's delayed
		// shutdown, which is what makes the replacement a full admission.
		Object.defineProperty(primary, "isIdle", {
			get() {
				throw new Error(STALE_CTX_MESSAGE);
			},
		});
		const replacement = makeCtx({ cwd: project, sessionId: "replacement" });
		await start(pi, replacement, "new");
		expect(getActiveSessionId()).toBe("replacement");
		await settleRegistryWrites();

		await shutdown(pi, primary, { type: "session_shutdown", reason: "reload" });

		// No shared teardown: the replacement is still a live member.
		expect(teardownResets(resetLSPService)).toHaveLength(0);
		expect(getActiveSessionId()).toBe("replacement");
		await settleRegistryWrites();
		expect(await rootsForThisPid()).toContain(project);
		// The replacement's own live scope is not retired by its predecessor.
		await sink.flush();
		expect(await shutdownScopeRows(sink)).toHaveLength(0);
		// A leave this activation cannot place has no scope of its own, so it
		// writes no sidecar for the id it arrived with.
		expect(await sidecarFor(project, "old")).toBeUndefined();

		// The replacement still owns the teardown when it really is the last leave.
		await shutdown(pi, replacement, {
			type: "session_shutdown",
			reason: "quit",
		});
		expect(teardownResets(resetLSPService)).toHaveLength(1);
		expect(getActiveSessionId()).toBeUndefined();
		await settleRegistryWrites();
		expect(await rootsForThisPid()).not.toContain(project);
	}, 45_000);

	it("r6 an unknown-id shutdown leaves a live member's activation alone", async () => {
		// The same derivation from the other side: a shutdown this activation
		// never recorded (an unreadable or foreign id) is not the LAST leave while
		// a member it did record is still live, so it must not tear the shared
		// infra down on the fail-safe path.
		process.env.PI_LENS_TEST_MODE = "0";
		const { pi, resetLSPService } = await bootActivation();
		const sink = await latencySink();
		sink.clear();
		await sink.flush();
		const primary = makeCtx({ cwd: project, sessionId: "m-primary" });
		await start(pi, primary);
		await settleRegistryWrites();

		const ghost = makeCtx({ cwd: project, sessionId: "ghost" });
		await shutdown(pi, ghost);

		expect(teardownResets(resetLSPService)).toHaveLength(0);
		expect(getActiveSessionId()).toBe("m-primary");
		await settleRegistryWrites();
		expect(await rootsForThisPid()).toContain(project);
		await sink.flush();
		expect(await shutdownScopeRows(sink)).toHaveLength(0);

		await shutdown(pi, primary);
		expect(teardownResets(resetLSPService)).toHaveLength(1);
		expect(getActiveSessionId()).toBeUndefined();
	}, 45_000);

	it("r6 a departing primary's sidecar is saved under its own id, not the replacement's", async () => {
		// Greptile #4563 r6 F2: r5 made the primary handoff run for a NON-LAST
		// leave, and that branch saved the departing scope under
		// `runtime.telemetrySessionId` — the module-level coordinator's identity,
		// which a second activation's full admission had already renamed to its
		// replacement. The departing primary's stores landed in the replacement's
		// sidecar file.
		const { defineSessionStore } = await import("../clients/session-scope.js");
		defineSessionStore({
			name: "r6-sidecar-witness",
			policy: {
				startup: "none",
				new: "none",
				resume: "none",
				fork: "none",
				reload: "none",
			},
			snapshot: (scope) => scope.role,
			restore() {},
			reason: "Name the scope a shutdown sidecar was written from.",
		});
		const a = await bootActivation();
		const primary = makeCtx({ cwd: project, sessionId: "m" });
		const sibling = makeCtx({ cwd: project, sessionId: "s" });
		await start(a.pi, primary);
		await start(a.pi, sibling);
		// pi disposes the old ctx before the host admits its replacement.
		Object.defineProperty(primary, "isIdle", {
			get() {
				throw new Error(STALE_CTX_MESSAGE);
			},
		});
		// A second activation in the SAME module instance: `index.ts`'s `runtime`
		// is module scope, so its telemetry identity is process-wide and this
		// start renames it.
		const b = await bootActivation();
		const replacement = makeCtx({ cwd: project, sessionId: "r" });
		await start(b.pi, replacement, "new");
		expect(getActiveSessionId()).toBe("r");

		await shutdown(a.pi, primary, {
			type: "session_shutdown",
			reason: "reload",
		});

		// The live secondary still holds the activation open: no shared teardown.
		expect(teardownResets(a.resetLSPService)).toHaveLength(0);
		expect(getActiveSessionId()).toBe("r");
		// The replacement's file was never named by this leave...
		expect(await sidecarFor(project, "r")).toBeUndefined();
		// ...and the departing primary's own sidecar carries its own scope.
		const own = await sidecarFor(project, "m");
		expect(own?.sessionId).toBe("m");
		expect(own?.stores["r6-sidecar-witness"]).toBe("primary");
		// The sibling can still leave normally afterwards.
		await shutdown(a.pi, sibling);
		expect(teardownResets(a.resetLSPService)).toHaveLength(0);
	}, 45_000);
	it("keeps the shared infra up while a sibling's liveness probe is inconclusive", async () => {
		// Review F3 on #4708 (R12): only pi's own stale-context error proves a
		// session ended. A probe that throws anything else is no proof, so the
		// sibling still counts as live: reading it as dead tore the shared
		// infra down under a session that may still be running turns.
		const { pi, resetLSPService } = await bootActivation();
		const primary = makeCtx({ cwd: project, sessionId: "m-primary" });
		const sibling = makeCtx({ cwd: project, sessionId: "s-inconclusive" });
		await start(pi, primary);
		await start(pi, sibling);
		Object.defineProperty(sibling, "isIdle", {
			get() {
				throw new Error("host probe failed");
			},
		});

		await shutdown(pi, primary);

		expect(teardownResets(resetLSPService)).toHaveLength(0);
		await settleRegistryWrites();
		expect(await rootsForThisPid()).toContain(project);
		await shutdown(pi, sibling);
		expect(teardownResets(resetLSPService)).toHaveLength(1);
	}, 45_000);

	it("retires the departing scope at the last live leave past a member pi disposed", async () => {
		// Review F5 on #4708: the activation's own last-member read counted a
		// member pi had disposed without a shutdown, while the process read did
		// not. The teardown ran, but the departing scope was never retired.
		process.env.PI_LENS_TEST_MODE = "0";
		const { pi, resetLSPService } = await bootActivation();
		const sink = await latencySink();
		sink.clear();
		await sink.flush();
		const primary = makeCtx({ cwd: project, sessionId: "m-disposed" });
		const sibling = makeCtx({ cwd: project, sessionId: "s-last" });
		await start(pi, primary);
		await start(pi, sibling);
		Object.defineProperty(primary, "isIdle", {
			get() {
				throw new Error(STALE_CTX_MESSAGE);
			},
		});

		await shutdown(pi, sibling);

		expect(teardownResets(resetLSPService)).toHaveLength(1);
		await sink.flush();
		expect(await shutdownScopeRows(sink)).toHaveLength(1);
	}, 45_000);

	it("releases the registration a re-announced member's admission took at that member's leave", async () => {
		// Review F3 on #4708 (R15): the registration is keyed by the context
		// its admission used. A member re-announced with a new context, and
		// admitted on it, must leave holding that context; with the old one
		// its leave kept a dead registration while another session lived,
		// which declines a successor in another root (#2129).
		const { pi, resetLSPService } = await bootActivation();
		const primary = makeCtx({ cwd: project, sessionId: "m-first" });
		const sibling = makeCtx({ cwd: project, sessionId: "s-reannounced" });
		const other = makeCtx({ cwd: project, sessionId: "t-live" });
		await start(pi, primary);
		await start(pi, sibling);
		await start(pi, other);
		await shutdown(pi, primary);
		expect(getActiveSessionId()).toBeUndefined();
		const reannounced = makeCtx({ cwd: project, sessionId: "s-reannounced" });
		await start(pi, reannounced);
		expect(getActiveSessionId()).toBe("s-reannounced");

		await shutdown(pi, reannounced);

		expect(getActiveSessionId()).toBeUndefined();
		expect(teardownResets(resetLSPService)).toHaveLength(0);
		await shutdown(pi, other);
		expect(teardownResets(resetLSPService)).toHaveLength(1);
	}, 45_000);
	it("keeps the LSP fleet at a full start while another session in the process is live", async () => {
		// #4704 review F1 on #4708: the primary's leave now releases its
		// registration while a sibling lives, so its successor runs a full
		// start. That start's LSP reset would kill the fleet the live sibling
		// still drives. A start with no other live session still resets it.
		const { pi, resetLSPService } = await bootActivation();
		const primary = makeCtx({ cwd: project, sessionId: "m-replaced" });
		const sibling = makeCtx({ cwd: project, sessionId: "s-driving" });
		await start(pi, primary);
		expect(sessionStartResets(resetLSPService)).toHaveLength(1);
		await start(pi, sibling);
		await shutdown(pi, primary, { type: "session_shutdown", reason: "new" });
		expect(getActiveSessionId()).toBeUndefined();

		const successor = makeCtx({ cwd: project, sessionId: "r-successor" });
		await start(pi, successor, "new");

		expect(getActiveSessionId()).toBe("r-successor");
		expect(sessionStartResets(resetLSPService)).toHaveLength(1);
		expect(teardownResets(resetLSPService)).toHaveLength(0);
		await shutdown(pi, sibling);
		await shutdown(pi, successor);
		expect(teardownResets(resetLSPService)).toHaveLength(1);
	}, 45_000);
});

/**
 * #4965 verify V1: the session-id lookup (`clients/session-scope.ts`) is a
 * process-wide index, so a key a session never gives back holds that
 * session's scope and its cells for the life of the process. Before this, an
 * activation released a key only when its LAST live member left, so a
 * sibling that left first, or a primary that left before its sibling, stayed
 * reachable by id after its session ended. Each case drives the production
 * handlers and reads the index the stores read.
 *
 * While a sibling is live the departed member's key goes and its scope
 * stays: the coordinator's scope runs every member's coordinator work, and
 * `turn_start` hands each member's turn the activation's last-started scope
 * (index.ts `turnStartScope`), whose late dead-code scan a retired scope
 * drops as `session-ended` (clients/runtime-turn.ts). So each case also
 * pins that the departed member's scope is still live.
 */
describe("#4965 a session's id lookup ends with its session", () => {
	it("unbinds a sibling that leaves before the primary at its own leave", async () => {
		const { pi } = await bootActivation();
		const primary = makeCtx({ cwd: project, sessionId: "m-stays" });
		const sibling = makeCtx({ cwd: project, sessionId: "s-leaves-first" });
		await start(pi, primary);
		await start(pi, sibling);
		const { scopeOfSession } = await import("../clients/session-scope.js");
		const leaverScope = scopeOfSession("s-leaves-first");
		expect(leaverScope?.isLive()).toBe(true);

		await shutdown(pi, sibling);

		expect(scopeOfSession("s-leaves-first")).toBeUndefined();
		expect(leaverScope?.isLive()).toBe(true);
		expect(scopeOfSession("m-stays")?.isLive()).toBe(true);
		await shutdown(pi, primary);
		expect(scopeOfSession("m-stays")).toBeUndefined();
	}, 45_000);

	it("unbinds a primary that leaves before its sibling at its own leave", async () => {
		const { pi } = await bootActivation();
		const primary = makeCtx({ cwd: project, sessionId: "m-leaves-first" });
		const sibling = makeCtx({ cwd: project, sessionId: "s-stays" });
		await start(pi, primary);
		await start(pi, sibling);
		const { scopeOfSession } = await import("../clients/session-scope.js");
		const coordinatorScope = scopeOfSession("m-leaves-first");

		await shutdown(pi, primary);

		expect(scopeOfSession("m-leaves-first")).toBeUndefined();
		expect(coordinatorScope?.isLive()).toBe(true);
		expect(scopeOfSession("s-stays")?.isLive()).toBe(true);
		await shutdown(pi, sibling);
		expect(scopeOfSession("s-stays")).toBeUndefined();
	}, 45_000);

	it("unbinds a member pi disposed beside a live sibling at the next start", async () => {
		const { pi } = await bootActivation();
		const primary = makeCtx({ cwd: project, sessionId: "m-live" });
		const disposed = makeCtx({ cwd: project, sessionId: "s-disposed" });
		await start(pi, primary);
		await start(pi, disposed);
		const { scopeOfSession } = await import("../clients/session-scope.js");
		const disposedScope = scopeOfSession("s-disposed");
		Object.defineProperty(disposed, "isIdle", {
			get() {
				throw new Error(STALE_CTX_MESSAGE);
			},
		});

		const next = makeCtx({ cwd: project, sessionId: "s-next" });
		await start(pi, next);

		expect(scopeOfSession("s-disposed")).toBeUndefined();
		expect({
			disposed: disposedScope?.isLive(),
			primary: scopeOfSession("m-live")?.isLive(),
			next: scopeOfSession("s-next")?.isLive(),
		}).toEqual({ disposed: true, primary: true, next: true });
		await shutdown(pi, next);
		await shutdown(pi, primary);
	}, 45_000);
});
