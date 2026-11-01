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
import { endMockSessions } from "./support/mock-session-teardown.js";
import { createPiMock, makeCtx, STALE_CTX_MESSAGE } from "./support/pi-mock.js";
import {
	fauxAssistantMessage,
	fauxText,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";
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

/**
 * The active primary root, resolved through the filesystem so a lane whose tmp
 * root is a symlink (macOS `/var`, a Windows short name) still compares equal to
 * the path the case passed. Throws rather than comparing `undefined`, so a
 * missing registration can never read as a passing identity.
 */
function realPathOfActivePrimaryRoot(): string {
	const root = getActivePrimaryRoot();
	if (root === undefined) throw new Error("no active primary root");
	return fs.realpathSync(root);
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

/** The tier-2 fixture two of the cases below run real sessions under. */
const fixture = piSessionFixture();

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
		// #5146: end the case's sessions before the registry settles and roots go.
		await endMockSessions();
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
		// CLASS: `unproducible-payload` — this input (a prior ctx invalidated with
		// no delivered shutdown) is not one pi 1.3.0 produces: `teardownCurrent`
		// awaits `session_shutdown` before `dispose()` invalidates the ctx. It
		// stays here because the WIRING claim is what it pins (index.ts hands
		// `priorCtxActive === false` to the classifier and still declines); the
		// unit test in `tests/clients/session-lifecycle-multi-root.test.ts`
		// (`a temp worktree behind a disposed primary does NOT run the full
		// start`) proves the decision only, and `tests/index-4632-s5-session-
		// identity.test.ts` proves the live-primary input, not this one (#4703
		// R2 F6).
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

		// #4704: while S1 is live the reload is not the process's last leave and
		// removes nothing. S1's hold drops with the entry once pi has invalidated
		// S1 with no shutdown (its runner disposed it), which makes the reload
		// the last live leave; the late shutdown below is that dropped holder's.
		invalidate(firstCtx);
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

	it("the primary's shutdown re-arms the process for a new root (#2129 F3)", async () => {
		// Review F3, the process-lifetime-latch shape. Root identity made a
		// stale activeRoot decisive: without an explicit release at the primary's
		// shutdown, every later start in a different root would classify
		// secondary-root FOREVER — never primary, never a full start.
		//
		// Tier 2 (#4632): two REAL pi sessions, each at its own project root
		// under this file's fixture. The session identity the assertions read is
		// the id pi's own session manager minted, and the release below is pi's
		// own `session_shutdown` reaching the loaded copy.
		//
		// The two roots' LAST segments differ (`root-primary` / `root-next`) and
		// each assertion names its own root: the directory names the pre-tier-2
		// case used both ended in `/proj`, which made a `toContain(basename)`
		// hold for either session (#4664 F5).
		const firstCwd = path.join(fixture.root, "root-primary", "proj");
		const first = await startPiSession({
			root: fixture.root,
			cwd: firstCwd,
			responses: [fauxAssistantMessage(fauxText("ready"))],
		});
		expect(getActiveSessionId()).toBe(
			first.session.sessionManager.getSessionId(),
		);
		expect(getSecondarySessionCount()).toBe(0);
		expect(realPathOfActivePrimaryRoot()).toBe(fs.realpathSync(firstCwd));

		await first.dispose();
		expect(getActivePrimaryRoot()).toBeUndefined();

		// A brand new session in a DIFFERENT root must take over as primary.
		const nextCwd = path.join(fixture.root, "root-next", "proj");
		const next = await startPiSession({
			root: fixture.root,
			cwd: nextCwd,
			responses: [fauxAssistantMessage(fauxText("ready"))],
		});
		expect(getSecondarySessionCount()).toBe(0);
		expect(realPathOfActivePrimaryRoot()).toBe(fs.realpathSync(nextCwd));
		expect(getActiveSessionId()).toBe(
			next.session.sessionManager.getSessionId(),
		);
		await next.dispose();
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
		// Tier 2 (#4913 L3): two REAL pi sessions at one project root under this
		// file's fixture. The first session's ctx is invalidated by pi's own
		// `extensionRunner.invalidate()` (the dead-prior state the classification
		// wiring file drives too), so the second start is a same-root replacement.
		const cwd = path.join(fixture.root, "same-root", "proj");
		const first = await startPiSession({
			root: fixture.root,
			cwd,
			responses: [fauxAssistantMessage(fauxText("first"))],
		});
		first.session.extensionRunner.invalidate();
		const second = await startPiSession({
			root: fixture.root,
			cwd,
			responses: [fauxAssistantMessage(fauxText("second"))],
		});

		// Same root: today's behavior is unchanged — the replacement is primary.
		expect(getSecondarySessionCount()).toBe(0);
		expect(realPathOfActivePrimaryRoot()).toBe(fs.realpathSync(cwd));
		expect(getActiveSessionId()).toBe(
			second.session.sessionManager.getSessionId(),
		);
	}, 30_000);
});
