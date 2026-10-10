/**
 * #2129 wiring: index.ts's `session_start` handler passes the START'S OWN
 * PROJECT ROOT into `decideSessionStart`.
 *
 * The unit tests in `tests/clients/session-lifecycle-multi-root.test.ts` prove
 * the classifier. They cannot prove the caller supplies the root — drop the
 * argument at the call site and every one of them still passes. This file
 * drives the real handler through the pi mock, so a call site that stops
 * reading `ctx.cwd` reds here.
 *
 * The observable is `getSecondarySessionCount()`: a start that is declined
 * increments it, and a start that steals the primary does not.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../index.js";
import {
	_resetSessionLifecycleForTests,
	getActivePrimaryRoot,
	getActiveSessionId,
	getSecondarySessionCount,
} from "../clients/session-lifecycle.js";
import {
	_settleRegistryMutationsForTests,
	deregisterInstance,
	getInstanceRoots,
	readInstanceRegistry,
	registerInstance,
} from "../clients/instance-registry.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx, STALE_CTX_MESSAGE } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

/** Make an already-emitted ctx read as invalidated, the way the SDK does after
 *  a session replacement — the state a subagent temp worktree's session_start
 *  actually arrives in. */
function invalidate(ctx: unknown): void {
	Object.defineProperty(ctx as object, "isIdle", {
		configurable: true,
		get() {
			throw new Error(STALE_CTX_MESSAGE);
		},
	});
}

/**
 * Let the fire-and-forget registry writes the session_start handler queues
 * reach disk. They all share one serialization tail inside
 * `clients/instance-registry.ts`, so queuing a no-op registration and awaiting
 * it drains everything queued before it — no sleep, no polling.
 */
async function settleRegistryWrites(): Promise<void> {
	await _settleRegistryMutationsForTests();
}

/** The roots this process's registry entry currently holds. */
async function rootsForThisPid(): Promise<string[]> {
	const entry = (await readInstanceRegistry()).find(
		(candidate) => candidate.pid === process.pid,
	);
	return entry ? getInstanceRoots(entry) : [];
}

const testRegistryHome = path.join(
	process.cwd(),
	".probe-home",
	"index-multi-root-session-start",
);
const workerHome = process.env.PI_LENS_HOME;

describe("session_start keys on the project root (#2129 wiring)", () => {
	let hostRoot: string;
	let tempWorktree: string;
	let previousHome: string | undefined;

	beforeEach(async () => {
		previousHome = process.env.PI_LENS_HOME;
		fs.mkdirSync(path.dirname(testRegistryHome), { recursive: true });
		removeTempDirSync(testRegistryHome);
		fs.mkdirSync(testRegistryHome, { recursive: true });
		process.env.PI_LENS_HOME = testRegistryHome;
		_resetSessionLifecycleForTests();
		// The registry entry is keyed by pid. Drain first: a previous test's
		// fire-and-forget writes would otherwise land AFTER this deregistration
		// and resurrect its roots inside this test.
		await new Promise<void>((resolve) => setImmediate(resolve));
		await settleRegistryWrites();
		deregisterInstance();
		await settleRegistryWrites();
		hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-host-root-"));
		tempWorktree = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-pi-agent-worktree-"),
		);
	});

	afterEach(async () => {
		_resetSessionLifecycleForTests();
		await settleRegistryWrites();
		deregisterInstance();
		await settleRegistryWrites();
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		removeTempDirSync(hostRoot);
		removeTempDirSync(tempWorktree);
	});

	it("declines a temp worktree's start behind a disposed primary", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		const hostCtx = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
		await pi.emit("session_start", makeSessionStartEvent(), hostCtx);
		expect(getSecondarySessionCount()).toBe(0);
		expect(getActivePrimaryRoot()).toContain(path.basename(hostRoot));

		// The host's session is replaced; its ctx goes stale. A subagent then
		// binds a session in a temp worktree.
		invalidate(hostCtx);
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tempWorktree, sessionId: "subagent-session" }),
		);

		// Declined, and the host's root is still the process's primary.
		expect(getSecondarySessionCount()).toBe(1);
		expect(getActivePrimaryRoot()).toContain(path.basename(hostRoot));
		expect(getActivePrimaryRoot()).not.toContain(path.basename(tempWorktree));
	}, 30_000);

	/**
	 * Two extension instances in one process — the real concurrent-secondary
	 * shape (#473). `ownedSessionRole` is per-instance closure state, so a
	 * secondary needs its own `extension()` call; the module-scope lifecycle
	 * state they share is exactly the seam the guard reads.
	 *
	 * The host's roots are registered by hand so the entry's contents are
	 * exact and independent of whichever writes the handler's fire-and-forget
	 * path happens to queue. A root in `hostRoots` is the host's own (#3849):
	 * no secondary's shutdown may remove it.
	 */
	async function bindSecondaryIn(cwd: string, hostRoots: string[] = []) {
		const host = createPiMock();
		extension(host.asExtensionAPI());
		const hostCtx = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
		await host.emit("session_start", makeSessionStartEvent(), hostCtx);
		await registerInstance(hostRoot);
		for (const root of hostRoots) await registerInstance(root);
		await settleRegistryWrites();

		const secondary = createPiMock();
		extension(secondary.asExtensionAPI());
		await secondary.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd, sessionId: "sibling-session" }),
		);
		expect(getSecondarySessionCount()).toBe(1);
		await settleRegistryWrites();
		return secondary;
	}

	it("a secondary's shutdown drops only its OWN root (#2130)", async () => {
		const secondary = await bindSecondaryIn(tempWorktree);
		expect(await rootsForThisPid()).toHaveLength(2);

		await secondary.emit(
			"session_shutdown",
			{},
			makeCtx({ cwd: tempWorktree, sessionId: "sibling-session" }),
		);
		// The removal is queued on the registry tail and uses async fs (#3618),
		// so it lands after the shutdown handler returns: join it first.
		await settleRegistryWrites();

		const roots = await rootsForThisPid();
		expect(roots).toHaveLength(1);
		expect(roots[0]).toContain(path.basename(hostRoot));
	}, 30_000);

	it("a secondary sharing the host's root drops nothing (#2130)", async () => {
		// The scoped deregistration is positively-different-root only. A
		// secondary in the SAME directory that dropped it would delete the
		// registry root the host is still working in.
		const secondary = await bindSecondaryIn(hostRoot, [tempWorktree]);

		await secondary.emit(
			"session_shutdown",
			{},
			makeCtx({ cwd: hostRoot, sessionId: "sibling-session" }),
		);
		// Without the join, a wrongly queued removal would land after this read
		// and the assertion below could not fail (#3703).
		await settleRegistryWrites();

		expect(await rootsForThisPid()).toHaveLength(2);
	}, 30_000);

	it("does not count a root from the worker registry (#2130)", async () => {
		if (!workerHome) throw new Error("Vitest did not provide PI_LENS_HOME");
		const previousHome = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = workerHome;
		try {
			await registerInstance("/foreign-worker-root");
			await settleRegistryWrites();
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			expect(await rootsForThisPid()).toEqual([]);
		} finally {
			process.env.PI_LENS_HOME = workerHome;
			await settleRegistryWrites();
			deregisterInstance();
			await settleRegistryWrites();
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
		}
	}, 30_000);

	it("a declined temp root still registers itself in instances.json (#2130)", async () => {
		// Review F2. `registerInstance` lives in the FULL-start body, below the
		// secondary gate, so a declined start never reaches it. Without a
		// lightweight root add, the temp root would be absent from the registry
		// entirely — the shared-checkout guard and warm attach would know less
		// about it than before #2130, and deregisterInstanceRoot would have
		// nothing to remove.
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		const hostCtx = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
		await pi.emit("session_start", makeSessionStartEvent(), hostCtx);
		await settleRegistryWrites();
		expect(await rootsForThisPid()).toHaveLength(1);

		invalidate(hostCtx);
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tempWorktree, sessionId: "subagent-session" }),
		);
		await settleRegistryWrites();

		const roots = await rootsForThisPid();
		expect(roots).toHaveLength(2);
		expect(roots[1]).toContain(path.basename(tempWorktree));
		// Still pinned: a declined start must never become the advertised root.
		expect(roots[0]).toContain(path.basename(hostRoot));
	}, 30_000);

	it("a reload-gap session cannot free two live secondary holders (#3849 F2)", async () => {
		const first = createPiMock();
		extension(first.asExtensionAPI());
		const hostCtx = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
		await first.emit("session_start", makeSessionStartEvent(), hostCtx);
		await first.emit("session_shutdown", { reason: "reload" }, hostCtx);
		invalidate(hostCtx);

		const gap = createPiMock();
		extension(gap.asExtensionAPI());
		const gapCtx = makeCtx({ cwd: tempWorktree, sessionId: "gap-session" });
		await gap.emit("session_start", makeSessionStartEvent(), gapCtx);

		const reloaded = createPiMock();
		extension(reloaded.asExtensionAPI());
		await reloaded.emit(
			"session_start",
			makeSessionStartEvent({ reason: "reload" }),
			makeCtx({ cwd: hostRoot, sessionId: "host-session" }),
		);

		const holder1 = createPiMock();
		extension(holder1.asExtensionAPI());
		await holder1.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tempWorktree, sessionId: "holder-1" }),
		);
		const holder2 = createPiMock();
		extension(holder2.asExtensionAPI());
		await holder2.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tempWorktree, sessionId: "holder-2" }),
		);
		await settleRegistryWrites();

		await gap.emit("session_shutdown", {}, gapCtx);
		await settleRegistryWrites();
		expect(await rootsForThisPid()).toContain(path.resolve(tempWorktree));

		await holder1.emit(
			"session_shutdown",
			{},
			makeCtx({ cwd: tempWorktree, sessionId: "holder-1" }),
		);
		await settleRegistryWrites();
		expect(await rootsForThisPid()).toContain(path.resolve(tempWorktree));

		await holder2.emit(
			"session_shutdown",
			{},
			makeCtx({ cwd: tempWorktree, sessionId: "holder-2" }),
		);
		await settleRegistryWrites();
		expect(await rootsForThisPid()).not.toContain(path.resolve(tempWorktree));
	}, 30_000);

	it("a holder whose hold a primary reload dropped cannot free a later holder's root (#3849)", async () => {
		// Round-2 verify R2-2: S1 holds T, the primary's reload removes the
		// whole entry, the reloaded primary re-registers, S2 adds T, then S1
		// shuts down. S1's hold ended with the entry, so its shutdown must not
		// take S2's. Recurrence: an anonymous per-root count let S1 consume the
		// count S2's add had just written.
		const host = createPiMock();
		extension(host.asExtensionAPI());
		const hostCtx = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
		await host.emit("session_start", makeSessionStartEvent(), hostCtx);

		const first = createPiMock();
		extension(first.asExtensionAPI());
		const firstCtx = makeCtx({ cwd: tempWorktree, sessionId: "holder-1" });
		await first.emit("session_start", makeSessionStartEvent(), firstCtx);
		await settleRegistryWrites();
		expect(await rootsForThisPid()).toContain(path.resolve(tempWorktree));

		await host.emit("session_shutdown", { reason: "reload" }, hostCtx);
		invalidate(hostCtx);
		const reloaded = createPiMock();
		extension(reloaded.asExtensionAPI());
		await reloaded.emit(
			"session_start",
			makeSessionStartEvent({ reason: "reload" }),
			makeCtx({ cwd: hostRoot, sessionId: "host-session" }),
		);
		await settleRegistryWrites();
		expect(await rootsForThisPid()).not.toContain(path.resolve(tempWorktree));

		const second = createPiMock();
		extension(second.asExtensionAPI());
		const secondCtx = makeCtx({ cwd: tempWorktree, sessionId: "holder-2" });
		await second.emit("session_start", makeSessionStartEvent(), secondCtx);
		await settleRegistryWrites();

		await first.emit("session_shutdown", {}, firstCtx);
		await settleRegistryWrites();
		expect(await rootsForThisPid()).toContain(path.resolve(tempWorktree));

		await second.emit("session_shutdown", {}, secondCtx);
		await settleRegistryWrites();
		expect(await rootsForThisPid()).not.toContain(path.resolve(tempWorktree));
	}, 30_000);

	it("a declined SAME-root start adds nothing to the set (#2130)", async () => {
		// The root add runs for any readable cwd; `mergeInstanceRoots`'s dedupe
		// is what makes a same-root bind a no-op, not a second gate at the call
		// site. This pins the outcome; the dedupe itself is pinned in
		// tests/clients/instance-registry-multi-root.test.ts.
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		const hostCtx = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
		await pi.emit("session_start", makeSessionStartEvent(), hostCtx);

		const secondary = createPiMock();
		extension(secondary.asExtensionAPI());
		await secondary.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: hostRoot, sessionId: "sibling-session" }),
		);
		await settleRegistryWrites();

		expect(await rootsForThisPid()).toHaveLength(1);
	}, 30_000);

	it("the primary's shutdown re-arms the process for a new root (#2129 F3)", async () => {
		// Review F3, the process-lifetime-latch shape. Root identity made a
		// stale activeRoot decisive: without an explicit release at the primary's
		// shutdown, every later start in a different root would classify
		// secondary-root FOREVER — never primary, never a full start.
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		const hostCtx = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
		await pi.emit("session_start", makeSessionStartEvent(), hostCtx);
		await pi.emit("session_shutdown", {}, hostCtx);
		expect(getActivePrimaryRoot()).toBeUndefined();

		// A brand new session in a DIFFERENT root must take over as primary.
		const next = createPiMock();
		extension(next.asExtensionAPI());
		await next.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: tempWorktree, sessionId: "next-session" }),
		);

		expect(getSecondarySessionCount()).toBe(0);
		expect(getActivePrimaryRoot()).toContain(path.basename(tempWorktree));
	}, 30_000);

	for (const gapRoot of ["host", "temp"] as const) {
		it(`a ${gapRoot}-root subagent in the reload gap does not demote the primary (#3662)`, async () => {
			// The release above (#2129 F3) leaves no registered primary between a
			// replacement shutdown and its successor's start. A subagent binding in
			// that gap used to register as primary, so the reloaded session's own
			// start probed a live foreign ctx, classified concurrent-secondary and
			// skipped handleSessionStart.
			const pi = createPiMock();
			extension(pi.asExtensionAPI());
			const hostCtx = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
			await pi.emit("session_start", makeSessionStartEvent(), hostCtx);
			// pi `reload()`: session_shutdown{reason:"reload"}, then invalidate.
			await pi.emit("session_shutdown", { reason: "reload" }, hostCtx);
			invalidate(hostCtx);

			const subagent = createPiMock();
			extension(subagent.asExtensionAPI());
			const subagentCtx = makeCtx({
				cwd: gapRoot === "host" ? hostRoot : tempWorktree,
				sessionId: "subagent-session",
			});
			await subagent.emit(
				"session_start",
				makeSessionStartEvent(),
				subagentCtx,
			);
			expect(getActiveSessionId()).toBeUndefined();
			expect(getSecondarySessionCount()).toBe(1);

			// The factory re-runs on reload; the same session announces itself.
			const reloaded = createPiMock();
			extension(reloaded.asExtensionAPI());
			await reloaded.emit(
				"session_start",
				makeSessionStartEvent({ reason: "reload" }),
				makeCtx({ cwd: hostRoot, sessionId: "host-session" }),
			);
			expect(getActiveSessionId()).toBe("host-session");
			expect(getActivePrimaryRoot()).toContain(path.basename(hostRoot));

			// The gap subagent owns a secondary role: its shutdown must not
			// release the successor's registration.
			await subagent.emit("session_shutdown", {}, subagentCtx);
			expect(getActiveSessionId()).toBe("host-session");
		}, 30_000);
	}

	it("still runs a same-root replacement as the primary", async () => {
		const pi = createPiMock();
		extension(pi.asExtensionAPI());

		const first = makeCtx({ cwd: hostRoot, sessionId: "host-session" });
		await pi.emit("session_start", makeSessionStartEvent(), first);
		invalidate(first);
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: hostRoot, sessionId: "host-session-2" }),
		);

		// Same root: today's behavior is unchanged — the replacement is primary.
		expect(getSecondarySessionCount()).toBe(0);
		expect(getActivePrimaryRoot()).toContain(path.basename(hostRoot));
	}, 30_000);
});
