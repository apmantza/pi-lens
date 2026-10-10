/**
 * #3662: a subagent that binds between the primary's replacement
 * `session_shutdown` and its successor's `session_start` must not take the
 * primary slot, and must not demote the real successor.
 *
 * The recurrence these guard: `releasePrimarySession()` (#2129 F3) leaves the
 * process with no registered primary for the whole replacement gap, so a gap
 * `startup` start classified `primary`, registered itself, and the reloaded
 * primary's own start then probed a live foreign ctx and classified
 * `concurrent-secondary` — skipping the full `handleSessionStart`.
 *
 * Everything here drives the real `decideSessionStart`/`releasePrimarySession`
 * pair that `index.ts` calls; nothing is mocked. The start and shutdown
 * reasons are pi 0.85.1's own vocabulary (`SessionStartEvent.reason` /
 * `SessionShutdownEvent.reason`, `core/extensions/types.d.ts`): every
 * replacement shutdown (`reload`, `new`, `resume`, `fork`) is followed by a
 * start carrying the same reason (`core/agent-session-runtime.js`,
 * `core/agent-session.js` `reload()`), and `startup` is only a runtime's first
 * bind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { _seedProcessSingletonCellForTests } from "../../clients/process-singletons.js";
import {
	_resetSessionLifecycleForTests,
	decideSessionStart,
	getActiveSessionId,
	getSecondarySessionCount,
	namedSuccessorReason,
	noteSessionShutdown,
	releasePrimarySession,
	expiredSuccessorReason,
	SUCCESSOR_HANDOFF_TTL_MS,
	SUCCESSOR_PENDING_TTL_MS,
} from "../../clients/session-lifecycle.js";

const REPO = "/repo/host";
const TEMP_ROOT = "/tmp/subagent-wt";

function liveCtx(): unknown {
	return { isIdle: () => true };
}

function successorPendingReasons(): Array<{
	subject: string;
	reason: string;
}> {
	return (
		getDegradationSummary().find(
			(group) => group.kind === "session-successor-pending",
		)?.latestReasons ?? []
	);
}

/** The primary starts, then shuts down for `reason` (pi releases it). */
function primaryShutsDown(reason: string | undefined): void {
	const first = decideSessionStart(liveCtx(), "host-session", REPO, "startup");
	expect(first.classification).toBe("primary");
	releasePrimarySession(reason);
}

describe("successor-pending gap (#3662)", () => {
	beforeEach(() => {
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});
	afterEach(() => {
		vi.useRealTimers();
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});

	for (const root of [REPO, TEMP_ROOT]) {
		it(`a gap subagent in ${root} declines and the reloaded primary runs the full start`, () => {
			primaryShutsDown("reload");

			const gap = decideSessionStart(liveCtx(), "subagent", root, "startup");
			expect(gap.classification).toBe("concurrent-secondary");
			expect(gap.runFullSessionStart).toBe(false);
			expect(getActiveSessionId()).toBeUndefined();

			const successor = decideSessionStart(
				liveCtx(),
				"host-session",
				REPO,
				"reload",
			);
			expect(successor.classification).toBe("primary");
			expect(successor.runFullSessionStart).toBe(true);
			expect(getActiveSessionId()).toBe("host-session");
		});
	}

	for (const reason of ["new", "resume", "fork"]) {
		it(`the ${reason} successor with a new session id is primary after a gap subagent`, () => {
			primaryShutsDown(reason);
			decideSessionStart(liveCtx(), "subagent", REPO, "startup");

			const successor = decideSessionStart(
				liveCtx(),
				`${reason}-session`,
				REPO,
				reason,
			);
			expect(successor.classification).toBe("primary");
			expect(getActiveSessionId()).toBe(`${reason}-session`);
		});
	}

	it("a quit leaves nothing pending: the next startup is primary", () => {
		// #2129 F3 re-arm: without it a later root would decline forever.
		primaryShutsDown("quit");
		const next = decideSessionStart(liveCtx(), "later", TEMP_ROOT, "startup");
		expect(next.classification).toBe("primary");
		expect(getActiveSessionId()).toBe("later");
	});

	it("a shutdown with no reason leaves nothing pending", () => {
		primaryShutsDown(undefined);
		const next = decideSessionStart(liveCtx(), "later", TEMP_ROOT, "startup");
		expect(next.classification).toBe("primary");
	});

	it("a gap start with no reason fails safe to primary", () => {
		primaryShutsDown("reload");
		const next = decideSessionStart(liveCtx(), "host-session", REPO, undefined);
		expect(next.classification).toBe("primary");
	});

	it("the gap decline records one successor-pending degradation", () => {
		primaryShutsDown("reload");
		decideSessionStart(liveCtx(), "subagent-1", REPO, "startup");
		decideSessionStart(liveCtx(), "subagent-2", TEMP_ROOT, "startup");
		expect(getSecondarySessionCount()).toBe(2);
		expect(successorPendingReasons().map((entry) => entry.subject)).toEqual([
			"declined",
		]);
	});

	it("a live-sibling decline after the successor registered is not a gap decline", () => {
		// The marker is only read while no primary is registered; a subagent
		// beside the live successor must not be reported as a gap decline.
		primaryShutsDown("reload");
		decideSessionStart(liveCtx(), "host-session", REPO, "reload");
		const sibling = decideSessionStart(liveCtx(), "subagent", REPO, "startup");
		expect(sibling.classification).toBe("concurrent-secondary");
		expect(successorPendingReasons()).toEqual([]);
	});

	it("a marker exactly as old as the bound has expired", () => {
		// Pins the bound's edge: the marker declines strictly inside the
		// window, so an off-by-one `<=` would keep declining at the bound.
		vi.useFakeTimers();
		primaryShutsDown("reload");
		vi.advanceTimersByTime(SUCCESSOR_PENDING_TTL_MS);
		const atBound = decideSessionStart(liveCtx(), "at-bound", REPO, "startup");
		expect(atBound.classification).toBe("primary");
	});

	it("with the guard off a gap startup is primary, as before #3662", () => {
		// I5: PI_LENS_CONCURRENT_SESSION_GUARD=0 restores pre-guard behavior
		// for the whole guard, including the successor-pending decline.
		process.env.PI_LENS_CONCURRENT_SESSION_GUARD = "0";
		try {
			primaryShutsDown("reload");
			const gap = decideSessionStart(liveCtx(), "subagent", REPO, "startup");
			expect(gap.classification).toBe("primary");
			expect(gap.runFullSessionStart).toBe(true);
		} finally {
			delete process.env.PI_LENS_CONCURRENT_SESSION_GUARD;
		}
	});

	it("a marker older than the bound expires: the late startup is primary", () => {
		// A replacement whose successor never starts (pi `reload()` with no
		// bindings, a host without `rebindSession`) must not decline every
		// later start for the process lifetime (catalog shape 17).
		vi.useFakeTimers();
		primaryShutsDown("new");

		vi.advanceTimersByTime(SUCCESSOR_PENDING_TTL_MS - 1);
		expect(
			decideSessionStart(liveCtx(), "inside", REPO, "startup").classification,
		).toBe("concurrent-secondary");

		vi.advanceTimersByTime(2);
		const late = decideSessionStart(liveCtx(), "late", REPO, "startup");
		expect(late.classification).toBe("primary");
		expect(getActiveSessionId()).toBe("late");
		expect(successorPendingReasons().map((entry) => entry.subject)).toEqual([
			"declined",
			"expired",
		]);
	});
});

/**
 * #3855: #3668's row 17. A subagent's own replacement in the primary's gap
 * carries a non-`startup` reason, so #3668 took it for the successor: it
 * registered, and the real successor probed its live ctx and was demoted. The
 * recurrences these guard: a gap start that is not the successor the primary's
 * shutdown named classified primary, or the named successor declined (no
 * primary at all).
 */
describe("only the named successor is primary in the gap (#3855)", () => {
	beforeEach(() => {
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});
	afterEach(() => {
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});

	/** The primary starts, then shuts down for `reason`, naming `key`. */
	function primaryNames(
		reason: string,
		key: string | number | undefined,
	): void {
		decideSessionStart(liveCtx(), "host-session", REPO, "startup");
		releasePrimarySession(reason, key);
	}

	const start = (reason: string | undefined, key?: string | number) =>
		decideSessionStart(liveCtx(), `start-${String(key)}`, REPO, reason, key)
			.classification;

	for (const [reason, key] of [
		["reload", "/s/host.jsonl"],
		["reload", 7],
		["fork", "/s/fork.jsonl"],
		["new", "/s/new.jsonl"],
		["resume", "/s/resumed.jsonl"],
		["new", undefined],
	] as const) {
		it(`declines every other gap start and keeps the named ${reason} successor (${String(key)}) primary`, () => {
			primaryNames(reason, key);

			// A subagent's own replacement of each kind, with its own key or none.
			expect(start("reload", "/s/sub.jsonl")).toBe("concurrent-secondary");
			expect(start("fork", 99)).toBe("concurrent-secondary");
			expect(start("resume", "/s/sub.jsonl")).toBe("concurrent-secondary");
			if (key !== undefined)
				expect(start("new", undefined)).toBe("concurrent-secondary");
			expect(start("startup", key)).toBe("concurrent-secondary");
			expect(getActiveSessionId()).toBeUndefined();

			expect(start(reason, key)).toBe("primary");
			expect(successorPendingReasons().map((entry) => entry.subject)).toEqual([
				"not-the-successor",
				"declined",
			]);
		});
	}

	it("declines a key-less start of the named reason against a ticket name (verify r2 PR8)", () => {
		// An SDK subagent's first bind with reason `reload` in an in-memory
		// primary's /reload gap: pi hands only the real successor the manager
		// the stash bound, so a fresh session carries no key.
		primaryNames("reload", 7);
		expect(start("reload", undefined)).toBe("concurrent-secondary");
		expect(start("reload", 7)).toBe("primary");
	});

	it("never lets a key-less start pass for a successor named by its file", () => {
		primaryNames("reload", "/s/host.jsonl");
		expect(start("reload", undefined)).toBe("concurrent-secondary");
		expect(start("reload", "/s/host.jsonl")).toBe("primary");
	});

	it("lets a start with no reason fail safe to primary in a named gap (#3662 F8)", () => {
		primaryNames("reload", "/s/host.jsonl");
		expect(start(undefined, "/s/sub.jsonl")).toBe("primary");
	});

	it("keeps #3662's rule for a marker that a build without the name rewrote", () => {
		// The older build's release rewrote the marker and left this build's
		// earlier name behind: the name is stale, so only `startup` declines.
		const now = Date.now();
		_seedProcessSingletonCellForTests(
			"session-lifecycle.primary-registration",
			{
				schema: "pi-lens.process-singletons",
				version: 1,
				value: {
					activeCtx: undefined,
					activeSessionId: undefined,
					activeRoot: undefined,
					secondarySessionCount: 0,
					successorPendingSince: now,
					successorNamed: {
						since: now - 1,
						reason: "reload",
						key: "/s/old.jsonl",
					},
				},
			},
		);
		expect(start("startup", undefined)).toBe("concurrent-secondary");
		expect(start("reload", "/s/sub.jsonl")).toBe("primary");
	});

	it("names nothing after a quit: a subagent's own reload is primary (#2129 F3)", () => {
		primaryNames("quit", undefined);
		expect(start("reload", "/s/sub.jsonl")).toBe("primary");
		expect(successorPendingReasons()).toEqual([]);
	});

	it("records no gap decline for a subagent's own reload beside a live primary", () => {
		decideSessionStart(liveCtx(), "host-session", REPO, "startup");
		expect(start("reload", "/s/sub.jsonl")).toBe("concurrent-secondary");
		expect(successorPendingReasons()).toEqual([]);
	});

	it("with the guard off a subagent's own reload in the gap is primary, as before #3662", () => {
		process.env.PI_LENS_CONCURRENT_SESSION_GUARD = "0";
		try {
			primaryNames("reload", "/s/host.jsonl");
			expect(start("reload", "/s/sub.jsonl")).toBe("primary");
		} finally {
			delete process.env.PI_LENS_CONCURRENT_SESSION_GUARD;
		}
	});
});

/**
 * #4106 (V7 of #3855): an activation whose session_start never ran (its own
 * /reload landed before pi-lens's start handler) shuts down with no recorded
 * role. With no primary registered it failed safe to primary, so a gap
 * subagent's activation renamed the primary's gap and its own successor took
 * the slot. The recurrences: that shutdown classified primary in a named gap
 * it is not the successor of, or the named successor's own role-less
 * shutdown classified secondary (no primary would remain).
 */
describe("a role-less shutdown in a named gap (#4106)", () => {
	beforeEach(() => {
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});
	afterEach(() => {
		vi.useRealTimers();
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});

	function primaryNames(reason: string, key: string | number | undefined) {
		decideSessionStart(liveCtx(), "host-session", REPO, "startup");
		releasePrimarySession(reason, key);
	}
	const shutdown = (key: string | number | undefined) =>
		noteSessionShutdown(liveCtx(), `roleless-${String(key)}`, REPO, key);

	for (const [reason, named] of [
		["reload", 7],
		["reload", "/s/host.jsonl"],
		["fork", "/s/fork.jsonl"],
		["new", "/s/new.jsonl"],
	] as const) {
		it(`is a secondary's unless it carries the named key (${reason}, ${String(named)})`, () => {
			primaryNames(reason, named);

			expect(shutdown(undefined)).toBe("secondary");
			expect(shutdown(99)).toBe("secondary");
			expect(shutdown("/s/sub.jsonl")).toBe("secondary");
			expect(shutdown(named)).toBe("primary");
			expect(successorPendingReasons().map((entry) => entry.subject)).toEqual([
				"roleless-shutdown",
			]);
		});
	}

	it("is the primary's for a key of none in an in-memory /new gap (residual R3)", () => {
		primaryNames("new", undefined);
		expect(shutdown(undefined)).toBe("primary");
	});

	it("keeps the fail-safe where nothing is named: after a quit, or with no reason", () => {
		primaryNames("quit", undefined);
		expect(shutdown(99)).toBe("primary");
		_resetSessionLifecycleForTests();
		decideSessionStart(liveCtx(), "host-session", REPO, "startup");
		releasePrimarySession(undefined, 7);
		expect(shutdown(99)).toBe("primary");
		expect(successorPendingReasons()).toEqual([]);
	});

	it("keeps the fail-safe once the marker expired", () => {
		vi.useFakeTimers();
		primaryNames("reload", 7);
		vi.advanceTimersByTime(SUCCESSOR_PENDING_TTL_MS);
		expect(shutdown(99)).toBe("primary");
	});

	it("keeps the fail-safe for a marker a build without the name rewrote", () => {
		const now = Date.now();
		_seedProcessSingletonCellForTests(
			"session-lifecycle.primary-registration",
			{
				schema: "pi-lens.process-singletons",
				version: 1,
				value: {
					activeCtx: undefined,
					activeSessionId: undefined,
					activeRoot: undefined,
					secondarySessionCount: 0,
					successorPendingSince: now,
					successorNamed: { since: now - 1, reason: "reload", key: 7 },
				},
			},
		);
		expect(shutdown(99)).toBe("primary");
	});

	it("leaves a shutdown beside a registered primary to the id and probe rules", () => {
		decideSessionStart(liveCtx(), "host-session", REPO, "startup");
		// Same id as the registered primary: primary, whatever key it carries.
		expect(noteSessionShutdown(liveCtx(), "host-session", REPO, 99)).toBe(
			"primary",
		);
		// Another id beside a live primary: secondary, as before #4106.
		expect(noteSessionShutdown(liveCtx(), "other", REPO, 7)).toBe("secondary");
		expect(successorPendingReasons()).toEqual([]);
	});
});

/**
 * #4113: a start interrupted before pi-lens's handler ran never saw its own
 * reason, so its shutdown reads the reason the gap names. The recurrence it
 * pins: a name read past its marker (expired, or from a build without the
 * name) would forward a stale slot to the next start.
 */
describe("the start a pending gap names (#4113)", () => {
	beforeEach(() => {
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});
	afterEach(() => {
		vi.useRealTimers();
		_resetSessionLifecycleForTests();
		resetDegradationLedger();
	});

	it("is the named reason while the marker is pending", () => {
		decideSessionStart(liveCtx(), "host-session", REPO, "startup");
		releasePrimarySession("fork", "/s/fork.jsonl");
		expect(namedSuccessorReason()).toBe("fork");
	});

	it("retires an expired marker at the fixed hand-off window", () => {
		// #4253 recurrence: an old marker must not authorize a same-file slot
		// forever after its normal successor-pending window has elapsed.
		vi.useFakeTimers();
		decideSessionStart(liveCtx(), "host-session", REPO, "startup");
		releasePrimarySession("fork", "/s/fork.jsonl");

		vi.advanceTimersByTime(SUCCESSOR_HANDOFF_TTL_MS - 1);
		expect(expiredSuccessorReason()).toBe("fork");

		vi.advanceTimersByTime(1);
		expect(expiredSuccessorReason()).toBeUndefined();
		expect(expiredSuccessorReason()).toBeUndefined();
	});

	it("only honors the pending TTL override inside Vitest", () => {
		// #4253-2 recurrence: PI_LENS_TEST_MODE=0 is user-settable, so it must
		// not make the real-pi child accept a production TTL override.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const previousMode = process.env.PI_LENS_TEST_MODE;
		const previousOverride = process.env.PI_LENS_TEST_SUCCESSOR_PENDING_TTL_MS;
		const previousVitest = process.env.VITEST;
		try {
			process.env.PI_LENS_TEST_MODE = "0";
			process.env.PI_LENS_TEST_SUCCESSOR_PENDING_TTL_MS = "0";
			delete process.env.VITEST;
			decideSessionStart(liveCtx(), "host-session", REPO, "startup");
			releasePrimarySession("fork", "/s/fork.jsonl");
			expect(expiredSuccessorReason()).toBeUndefined();
			vi.advanceTimersByTime(SUCCESSOR_PENDING_TTL_MS);
			expect(expiredSuccessorReason()).toBe("fork");

			_resetSessionLifecycleForTests();
			process.env.VITEST = "1";
			decideSessionStart(liveCtx(), "host-session", REPO, "startup");
			releasePrimarySession("fork", "/s/fork.jsonl");
			expect(expiredSuccessorReason()).toBe("fork");
		} finally {
			if (previousMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousMode;
			if (previousOverride === undefined)
				delete process.env.PI_LENS_TEST_SUCCESSOR_PENDING_TTL_MS;
			else process.env.PI_LENS_TEST_SUCCESSOR_PENDING_TTL_MS = previousOverride;
			if (previousVitest === undefined) delete process.env.VITEST;
			else process.env.VITEST = previousVitest;
		}
	});

	it("is none once the named successor registered", () => {
		decideSessionStart(liveCtx(), "host-session", REPO, "startup");
		releasePrimarySession("reload", 7);
		decideSessionStart(liveCtx(), "host-session", REPO, "reload", 7);
		expect(namedSuccessorReason()).toBeUndefined();
	});

	it("is none where nothing is named, or once the marker expired", () => {
		expect(namedSuccessorReason()).toBeUndefined();
		decideSessionStart(liveCtx(), "host-session", REPO, "startup");
		releasePrimarySession("quit");
		expect(namedSuccessorReason()).toBeUndefined();
		_resetSessionLifecycleForTests();
		vi.useFakeTimers();
		decideSessionStart(liveCtx(), "host-session", REPO, "startup");
		releasePrimarySession("reload", 7);
		vi.advanceTimersByTime(SUCCESSOR_PENDING_TTL_MS);
		expect(namedSuccessorReason()).toBeUndefined();
	});

	it("is none for a marker a build without the name rewrote", () => {
		const now = Date.now();
		_seedProcessSingletonCellForTests(
			"session-lifecycle.primary-registration",
			{
				schema: "pi-lens.process-singletons",
				version: 1,
				value: {
					activeCtx: undefined,
					activeSessionId: undefined,
					activeRoot: undefined,
					secondarySessionCount: 0,
					successorPendingSince: now,
					successorNamed: { since: now - 1, reason: "fork", key: 7 },
				},
			},
		);
		expect(namedSuccessorReason()).toBeUndefined();
	});
});
