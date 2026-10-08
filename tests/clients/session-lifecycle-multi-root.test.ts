/**
 * #2129: root identity participates in session-start classification.
 *
 * The defect these cover: a subagent temp worktree announced a session_start
 * in a DIFFERENT directory while the registered primary's ctx was already
 * disposed. The pre-fix classifier saw only `hasPrior`/`priorCtxActive`/
 * `sameSessionId`, called it a sequential replacement, re-registered the temp
 * root as the process primary, and ran the full session_start body — resetting
 * the host's warm LSP fleet and re-running the whole async battery per temp
 * root over unchanged content.
 *
 * The pure classifier is exercised through the FULL state space the fix
 * enumerates: {same root, different root, root unknown} x {prior active,
 * inactive, inconclusive} x {same, different session id}.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_resetSessionLifecycleForTests,
	explainSessionStart,
	explainSessionStartGuarded,
	decideSessionStart,
	getActivePrimaryRoot,
	getSecondarySessionCount,
	noteSessionShutdown,
	registerPrimarySession,
	releasePrimarySession,
} from "../../clients/session-lifecycle.js";

const PRIMARY_ROOT = "/repo/plegma";
const TEMP_ROOT = "/tmp/pi-agent-733f1108-worktree";

function activeCtx(): unknown {
	return { isIdle: () => false };
}

/** A ctx the SDK has invalidated — the exact shape a temp-worktree session
 *  start arrives behind, per the #2129 forensics. */
function staleCtx(): unknown {
	return {
		isIdle: () => {
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
		},
	};
}

/** Probe returns `undefined` — inconclusive. */
function unprobeableCtx(): unknown {
	return {};
}

describe("explainSessionStart state space (#2129)", () => {
	afterEach(() => {
		_resetSessionLifecycleForTests();
	});

	const priorCtxActiveCases: Array<[string, boolean | undefined]> = [
		["prior active", true],
		["prior inactive", false],
		["probe inconclusive", undefined],
	];

	describe("different root (sameRoot: false)", () => {
		for (const [label, priorCtxActive] of priorCtxActiveCases) {
			it(`${label}, different session id -> never steals the full start`, () => {
				const verdict = explainSessionStart({
					hasPrior: true,
					priorCtxActive,
					sameSessionId: false,
					sameRoot: false,
				}).classification;
				expect(verdict).not.toBe("sequential-replacement");
				expect(verdict).not.toBe("primary");
			});
		}

		it("prior inactive + different id -> secondary-root (the defect case)", () => {
			expect(
				explainSessionStart({
					hasPrior: true,
					priorCtxActive: false,
					sameSessionId: false,
					sameRoot: false,
				}).classification,
			).toBe("secondary-root");
		});

		it("probe inconclusive + different id -> secondary-root", () => {
			expect(
				explainSessionStart({
					hasPrior: true,
					priorCtxActive: undefined,
					sameSessionId: false,
					sameRoot: false,
				}).classification,
			).toBe("secondary-root");
		});

		it("a LIVE sibling still reports the more specific concurrent-secondary", () => {
			expect(
				explainSessionStart({
					hasPrior: true,
					priorCtxActive: true,
					sameSessionId: false,
					sameRoot: false,
				}).classification,
			).toBe("concurrent-secondary");
		});

		it("same session id still wins — a resume re-announcing itself is sequential", () => {
			expect(
				explainSessionStart({
					hasPrior: true,
					priorCtxActive: false,
					sameSessionId: true,
					sameRoot: false,
				}).classification,
			).toBe("sequential-replacement");
		});
	});

	describe("same root (sameRoot: true) — behavior is unchanged from pre-#2129", () => {
		it("prior inactive -> sequential-replacement (full start still runs)", () => {
			expect(
				explainSessionStart({
					hasPrior: true,
					priorCtxActive: false,
					sameSessionId: false,
					sameRoot: true,
				}).classification,
			).toBe("sequential-replacement");
		});

		it("probe inconclusive -> sequential-replacement (fail-safe preserved)", () => {
			expect(
				explainSessionStart({
					hasPrior: true,
					priorCtxActive: undefined,
					sameSessionId: false,
					sameRoot: true,
				}).classification,
			).toBe("sequential-replacement");
		});

		it("prior active -> concurrent-secondary", () => {
			expect(
				explainSessionStart({
					hasPrior: true,
					priorCtxActive: true,
					sameSessionId: false,
					sameRoot: true,
				}).classification,
			).toBe("concurrent-secondary");
		});
	});

	describe("root unknown (sameRoot: undefined) — never changes a verdict", () => {
		for (const [label, priorCtxActive] of priorCtxActiveCases) {
			it(`${label}: matches the verdict with no root input at all`, () => {
				const withUnknownRoot = explainSessionStart({
					hasPrior: true,
					priorCtxActive,
					sameSessionId: false,
					sameRoot: undefined,
				}).classification;
				const withoutRootField = explainSessionStart({
					hasPrior: true,
					priorCtxActive,
					sameSessionId: false,
				}).classification;
				expect(withUnknownRoot).toBe(withoutRootField);
				expect(withUnknownRoot).not.toBe("secondary-root");
			});
		}
	});

	it("no prior -> primary regardless of root", () => {
		expect(
			explainSessionStart({
				hasPrior: false,
				priorCtxActive: undefined,
				sameSessionId: false,
				sameRoot: false,
			}).classification,
		).toBe("primary");
	});
});

describe("decideSessionStart root identity (#2129)", () => {
	afterEach(() => {
		_resetSessionLifecycleForTests();
		vi.unstubAllEnvs();
	});

	it("a temp worktree behind a disposed primary does NOT run the full start", () => {
		// Host's real session registers first.
		const first = decideSessionStart(staleCtx(), "session-real", PRIMARY_ROOT);
		expect(first.classification).toBe("primary");
		expect(first.runFullSessionStart).toBe(true);

		// Subagent temp worktree, different id, primary ctx now stale.
		const second = decideSessionStart(staleCtx(), "session-temp-1", TEMP_ROOT);
		expect(second.classification).toBe("secondary-root");
		expect(second.runFullSessionStart).toBe(false);
		expect(second.sameRoot).toBe(false);
		expect(second.secondaryCount).toBe(1);
	});

	it("the declined temp root does not steal the primary registration", () => {
		decideSessionStart(staleCtx(), "session-real", PRIMARY_ROOT);
		decideSessionStart(staleCtx(), "session-temp-1", TEMP_ROOT);
		expect(getActivePrimaryRoot()).toContain("plegma");
		expect(getActivePrimaryRoot()).not.toContain("pi-agent-733f1108");
	});

	it("two concurrent temp roots both decline — one full start for the host", () => {
		const decisions = [
			decideSessionStart(staleCtx(), "session-real", PRIMARY_ROOT),
			decideSessionStart(staleCtx(), "session-temp-1", TEMP_ROOT),
			decideSessionStart(
				staleCtx(),
				"session-temp-2",
				"/tmp/pi-agent-0aee5e2f-worktree",
			),
		];
		// Duplicate-work criterion: exactly ONE start runs the battery that
		// rebuilds the word index, however many roots arrive.
		expect(decisions.filter((d) => d.runFullSessionStart)).toHaveLength(1);
		expect(getSecondarySessionCount()).toBe(2);
	});

	it("a same-root sequential replacement still runs the full start", () => {
		decideSessionStart(staleCtx(), "session-a", PRIMARY_ROOT);
		const next = decideSessionStart(staleCtx(), "session-b", PRIMARY_ROOT);
		expect(next.classification).toBe("sequential-replacement");
		expect(next.runFullSessionStart).toBe(true);
		expect(next.sameRoot).toBe(true);
	});

	it("a start with no root recorded for the primary falls back to today's behavior", () => {
		// Primary registered WITHOUT a root (an SDK that hands no cwd).
		registerPrimarySession(staleCtx(), "session-a");
		const next = decideSessionStart(staleCtx(), "session-b", TEMP_ROOT);
		expect(next.sameRoot).toBeUndefined();
		expect(next.classification).toBe("sequential-replacement");
		expect(next.runFullSessionStart).toBe(true);
	});

	it("a start carrying no cwd falls back to today's behavior", () => {
		decideSessionStart(staleCtx(), "session-a", PRIMARY_ROOT);
		const next = decideSessionStart(staleCtx(), "session-b", undefined);
		expect(next.sameRoot).toBeUndefined();
		expect(next.runFullSessionStart).toBe(true);
	});

	it("a re-registration without a root keeps the recorded primary root", () => {
		// Mutation guard: if registerPrimarySession overwrote activeRoot with
		// `undefined`, every later sameRoot read would go unknown and the
		// pre-fix "any root may steal primary" behavior would come back.
		decideSessionStart(staleCtx(), "session-a", PRIMARY_ROOT);
		registerPrimarySession(staleCtx(), "session-a2");
		expect(getActivePrimaryRoot()).toContain("plegma");
		const temp = decideSessionStart(staleCtx(), "session-temp", TEMP_ROOT);
		expect(temp.runFullSessionStart).toBe(false);
	});

	it("a live sibling in a different root is still concurrent-secondary", () => {
		const live = activeCtx();
		registerPrimarySession(live, "session-real", PRIMARY_ROOT);
		const sibling = decideSessionStart(activeCtx(), "session-sub", TEMP_ROOT);
		expect(sibling.classification).toBe("concurrent-secondary");
		expect(sibling.runFullSessionStart).toBe(false);
	});

	it("an unprobeable primary ctx in the same root still runs the full start", () => {
		registerPrimarySession(unprobeableCtx(), "session-a", PRIMARY_ROOT);
		const next = decideSessionStart(staleCtx(), "session-b", PRIMARY_ROOT);
		expect(next.runFullSessionStart).toBe(true);
	});

	it("the kill switch disables the root decline with the rest of the guard", () => {
		vi.stubEnv("PI_LENS_CONCURRENT_SESSION_GUARD", "0");
		expect(
			explainSessionStartGuarded({
				hasPrior: true,
				priorCtxActive: false,
				sameSessionId: false,
				sameRoot: false,
			}).classification,
		).toBe("sequential-replacement");
	});

	it("root comparison survives separator and case spelling differences", () => {
		// Catalog shape 1: two spellings of ONE root must not read as two roots,
		// or a legitimate same-root replacement would be declined.
		const cwd = process.cwd();
		decideSessionStart(staleCtx(), "session-a", cwd);
		const same = decideSessionStart(
			staleCtx(),
			"session-b",
			cwd.replace(/\//g, "\\"),
		);
		expect(same.sameRoot).toBe(true);
		expect(same.runFullSessionStart).toBe(true);
	});

	it("the decision carries the root inputs it consulted, for the bind record", () => {
		decideSessionStart(staleCtx(), "session-real", PRIMARY_ROOT);
		const declined = decideSessionStart(staleCtx(), "session-temp", TEMP_ROOT);
		expect(declined.sameRoot).toBe(false);
		expect(declined.primaryRoot).toContain("plegma");
	});

	it("primaryRoot is the DECISION-time value, not what this call wrote", () => {
		// Review F5. On a full start the registration overwrites `activeRoot`, so
		// reporting it afterwards would echo this call's own input and the record
		// could never show a root CHANGE.
		const first = decideSessionStart(staleCtx(), "session-a", PRIMARY_ROOT);
		expect(first.primaryRoot).toBeUndefined();
		// A same-root replacement reports the root it compared against.
		const second = decideSessionStart(staleCtx(), "session-b", PRIMARY_ROOT);
		expect(second.primaryRoot).toContain("plegma");
	});
});

describe("releasePrimarySession (#2129 review F3)", () => {
	afterEach(() => {
		_resetSessionLifecycleForTests();
	});

	it("re-arms the process: a new root becomes primary after a release", () => {
		// Without the release, root identity turns a stale registration into a
		// permanent decline — root B never becomes primary, never runs the
		// battery.
		decideSessionStart(staleCtx(), "session-a", PRIMARY_ROOT);
		releasePrimarySession();
		expect(getActivePrimaryRoot()).toBeUndefined();

		const next = decideSessionStart(staleCtx(), "session-b", TEMP_ROOT);
		expect(next.classification).toBe("primary");
		expect(next.runFullSessionStart).toBe(true);
		expect(getActivePrimaryRoot()).toContain("pi-agent-733f1108");
	});

	it("without a release the same sequence declines forever", () => {
		// The complement, so the test above cannot pass for an unrelated reason.
		decideSessionStart(staleCtx(), "session-a", PRIMARY_ROOT);
		for (const id of ["session-b", "session-c", "session-d"]) {
			expect(decideSessionStart(staleCtx(), id, TEMP_ROOT).classification).toBe(
				"secondary-root",
			);
		}
	});

	it("clears the secondary count with the registration", () => {
		decideSessionStart(staleCtx(), "session-a", PRIMARY_ROOT);
		decideSessionStart(staleCtx(), "session-b", TEMP_ROOT);
		expect(getSecondarySessionCount()).toBe(1);
		releasePrimarySession();
		expect(getSecondarySessionCount()).toBe(0);
	});
});

/**
 * #2146 round-1 verification residual, closed here (#2130).
 *
 * `noteSessionShutdown` gained a root discriminator, and its docstring asserts
 * the root check sits BELOW the id-unknown guard — the #472 fix, which says a
 * session whose id is unreadable must still tear itself down. No test pinned
 * that order: the reviewer hoisted the root check above the guard and 128 tests
 * stayed green. The exposure is concrete. A primary whose
 * `sessionManager.getSessionId()` read fails, running in a directory that is
 * not the registered primary's, would classify `secondary`, return before
 * shared teardown, and leak its LSP fleet on every clean exit.
 */
describe("noteSessionShutdown guard ORDER (#2146 residual)", () => {
	afterEach(() => {
		_resetSessionLifecycleForTests();
	});

	it("an unreadable session id tears down even from a different root", () => {
		registerPrimarySession(staleCtx(), "session-a", PRIMARY_ROOT);
		// Positively a different root, and the primary's ctx is dead — the two
		// inputs the root branch acts on. The unknown id must still win.
		expect(noteSessionShutdown(staleCtx(), undefined, TEMP_ROOT)).toBe(
			"primary",
		);
	});

	it("an unreadable PRIMARY id tears down even from a different root", () => {
		// The mirror case: the registration itself carries no id, so "different
		// session" is equally unestablishable from the other side.
		registerPrimarySession(staleCtx(), undefined, PRIMARY_ROOT);
		expect(noteSessionShutdown(staleCtx(), "session-b", TEMP_ROOT)).toBe(
			"primary",
		);
	});

	it("with BOTH ids known, a different root still classifies secondary", () => {
		// The complement, so the two cases above cannot pass because the root
		// branch stopped working altogether.
		registerPrimarySession(staleCtx(), "session-a", PRIMARY_ROOT);
		expect(noteSessionShutdown(staleCtx(), "session-b", TEMP_ROOT)).toBe(
			"secondary",
		);
	});
});
