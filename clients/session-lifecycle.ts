/**
 * Concurrent-session guard (#473).
 *
 * In-process subagent extensions (tintinweb/pi-subagents-style: a fresh
 * `AgentSession` built and `bindExtensions()`-ed inside the SAME Node process
 * as the parent pi session) reuse pi's process-global extension-loader cache,
 * so the subagent's `session_start` re-invokes pi-lens's SAME module-scope
 * singletons the parent is still using. Left unguarded, `handleSessionStart`
 * destructively resets shared state (`resetLSPService({fast:true})` kills
 * every live LSP client; `runtime.resetForSession()` bumps the session
 * generation, silently orphaning the parent's in-flight continuations gated
 * on `isCurrentSession`) while the parent is mid-turn.
 *
 * pi's own SDK contract only invalidates a captured ctx for SEQUENTIAL
 * session replacement (`newSession`/`fork`/`switchSession`/`reload` —
 * `ExtensionRunner.invalidate()`, called from `core/agent-session.js` on
 * dispose). A concurrently-live sibling session's bind invalidates nothing.
 * That asymmetry — is the PRIOR ctx still active or not — is the reliable,
 * empirically-verified discriminator this module implements.
 *
 * Fail-safe direction is non-negotiable: whenever classification is
 * uncertain, this module falls back to today's behavior (treat as a
 * sequential replacement, i.e. run the full reset). It only suppresses the
 * reset on POSITIVE evidence that a live sibling primary session exists.
 *
 * Kill switch: `PI_LENS_CONCURRENT_SESSION_GUARD=0` disables the guard
 * entirely — every session_start classifies as if sequential (today's
 * behavior), matching the lazy-env-read house style (see
 * `subagent-mode.ts` / `runtime-config.ts`).
 */

import { recordDegradationOnce } from "./degradation-ledger.js";
import { normalizeFilePath } from "./path-utils.js";
import { getProcessSingleton } from "./process-singletons.js";

/**
 * PROCESS-scope state, not module-scope (#2146).
 *
 * The premise this guard rests on is "the process has exactly one registration
 * of the primary session". Module scope did NOT deliver that: pi evaluates the
 * pi-lens module graph up to nine times in one process (source vs compiled
 * graphs, in-process subagent binds), so every evaluation used to get its own
 * empty registration. `hasPrior` then read `false` on evaluation 2, a subagent
 * temp root classified `primary`, and the whole #473/#2129/#2133 guard was
 * unreachable — correct code behind a violated precondition.
 *
 * Keying on `globalThis` restores the precondition. Every accessor below reads
 * through {@link state}, so there is one registration per PROCESS regardless of
 * how many times the module is evaluated.
 */
interface SessionLifecycleState {
	activeCtx: unknown | undefined;
	activeSessionId: string | undefined;
	activeRoot: string | undefined;
	secondarySessionCount: number;
	/**
	 * #3662: when a primary replacement shutdown released the registration
	 * (`Date.now()`), until the next release rewrites it. Read only while no
	 * primary is registered. Additive: a cell from a build without it reads
	 * `undefined` (nothing pending, today's behavior), so the version stays 1;
	 * a bump would make two builds in one process discard each other's
	 * registration on every read.
	 */
	successorPendingSince?: number | undefined;
	/**
	 * #3855: the start that release named as its successor: pi's shutdown
	 * reason and the `startKey` its successor will compute (`undefined` when pi
	 * links nothing, an in-memory `/new`). Trusted only while `since` equals
	 * `successorPendingSince`, so a marker that a build without this field
	 * rewrote falls back to #3662's rule. Additive, like the marker.
	 */
	successorNamed?:
		| { since: number; reason: string; key: string | number | undefined }
		| undefined;
}

const SESSION_LIFECYCLE_FAMILY = "session-lifecycle.primary-registration";
/** Bump when {@link SessionLifecycleState}'s shape changes. */
const SESSION_LIFECYCLE_VERSION = 1;

function state(): SessionLifecycleState {
	return getProcessSingleton(
		SESSION_LIFECYCLE_FAMILY,
		SESSION_LIFECYCLE_VERSION,
		() => ({
			activeCtx: undefined,
			activeSessionId: undefined,
			activeRoot: undefined,
			secondarySessionCount: 0,
		}),
	);
}

/**
 * #3662: how long a replacement shutdown's successor-pending marker declines
 * `startup` starts. pi's replacement gap is one awaited sequence (teardown,
 * `createRuntime`, rebind, `session_start`), so a marker older than this means
 * the successor is not coming (pi `reload()` with no bindings, a host without
 * `rebindSession`) and starts classify exactly as they did before #3662.
 */
export const SUCCESSOR_PENDING_TTL_MS = 60_000;

/**
 * How long an expired successor may still authorize forwarding its interrupted
 * hand-off. A user can plausibly return to a fork/reload successor within a
 * day; after that, retaining the marker and its slot would make ancient state
 * look current forever.
 */
export const SUCCESSOR_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The real-pi lifecycle lane cannot install Vitest's clock in its child
 * process. Keep the production default fixed, while allowing that hermetic
 * lane to shrink the wait through its explicitly test-only environment knob.
 * `VITEST` is required because `PI_LENS_TEST_MODE=0` is user-settable.
 */
function successorPendingTtlMs(): number {
	const raw = process.env.PI_LENS_TEST_SUCCESSOR_PENDING_TTL_MS;
	if (
		process.env.VITEST &&
		process.env.PI_LENS_TEST_MODE === "0" &&
		raw !== undefined
	) {
		const value = Number(raw);
		if (Number.isFinite(value) && value >= 0) return value;
	}
	return SUCCESSOR_PENDING_TTL_MS;
}

/** The stable id of the currently registered primary session, if known. */
export function getActiveSessionId(): string | undefined {
	return state().activeSessionId;
}

/**
 * The normalized project root of the currently registered primary session
 * (#2129), or `undefined` when no primary has registered a root yet.
 *
 * This is the process's answer to "which directory does pi-lens actually
 * serve", and it is what `memory_sample` carries as its root discriminator
 * (#2130) so a record from a multi-root host is attributable.
 */
export function getActivePrimaryRoot(): string | undefined {
	return state().activeRoot;
}

export type SessionStartClassification =
	| "primary"
	| "sequential-replacement"
	| "concurrent-secondary"
	| "secondary-root";

export interface ClassifySessionStartInput {
	/** Whether a primary session was already registered in this process. */
	hasPrior: boolean;
	/**
	 * Result of probing the prior primary's ctx via {@link probeCtxActive}:
	 * `true` = still active, `false` = confirmed invalidated (stale-ctx
	 * throw), `undefined` = probe inconclusive (ctx shape unexpected /
	 * accessor missing / prior ctx unavailable to probe).
	 */
	priorCtxActive: boolean | undefined;
	/** Whether this session_start carries the SAME stable session id as the
	 * registered primary (e.g. resume/reload re-announcing itself). */
	sameSessionId: boolean;
	/**
	 * #2129. Root identity relative to the registered primary's project root:
	 * `true` = same root, `false` = POSITIVELY a different root, `undefined` =
	 * unknown (no root recorded for the primary, or this start carries no cwd).
	 *
	 * `undefined` must never on its own change a verdict — the module's
	 * fail-safe direction (see the header) means only positive evidence of a
	 * DIFFERENT root may suppress a full session start.
	 */
	sameRoot?: boolean | undefined;
	/**
	 * #3662: no primary is registered because a primary replacement shut down,
	 * its successor has not started yet, and this start is not that successor
	 * (#3855: its reason and key differ from the ones the shutdown named; a
	 * `startup` start never matches). Only consulted when `hasPrior` is false.
	 */
	successorPending?: boolean;
}

/**
 * Which input decided a classification (#3873 O6): the branch of
 * {@link explainSessionStart} that returned, so a `primary` /
 * `sequential-replacement` row says whether a prior primary, a dead ctx or an
 * inconclusive probe led to it.
 */
export type ClassificationBasis =
	| "no-prior-primary"
	| "successor-pending"
	| "same-session"
	| "prior-ctx-live"
	| "root-differs"
	| "prior-ctx-dead"
	| "prior-ctx-unknown"
	| "guard-disabled";

/**
 * PURE classifier — no I/O, no throws, fully unit-testable in isolation.
 *
 * Branches (fail-safe order matters):
 *  1. No prior primary registered → `primary` (first session_start this
 *     process has seen; zero behavior change for the single-session case),
 *     unless `successorPending` → `concurrent-secondary` (#3662: a subagent
 *     binding in a replacement gap must not take the slot the successor is
 *     about to claim, or the successor would probe its live ctx and decline;
 *     #3855: only the start the shutdown named is that successor).
 *  2. Prior exists, same stable session id → `sequential-replacement` (the
 *     same session re-announcing itself, e.g. resume/reload paths — must
 *     keep today's behavior, NOT be mistaken for a sibling).
 *  3. Prior exists, `priorCtxActive === false` (confirmed invalidated) →
 *     `sequential-replacement` (the prior really was replaced/disposed —
 *     this IS the sequential case pi's own contract covers).
 *  4. Prior exists, `priorCtxActive === true`, different session id →
 *     `concurrent-secondary` (positive evidence of a live sibling).
 *  5. Prior exists, different session id, `sameRoot === false` (positive
 *     evidence of a DIFFERENT project root) → `secondary-root` (#2129).
 *  6. Prior exists, `priorCtxActive === undefined` (probe inconclusive) →
 *     `sequential-replacement` (fail toward today's behavior).
 *
 * WHY ROOT IDENTITY IS AN INPUT AT ALL (#2129). Branch 3 alone made a subagent
 * temp worktree — a session_start in a DIFFERENT directory, arriving after the
 * host's real session had already been disposed or had an unprobeable ctx —
 * classify as a sequential replacement. It then re-registered itself as the
 * process's primary and ran the full session_start body: `resetLSPService`
 * killed the host's warm LSP fleet, and the whole async battery (opengrep,
 * word-index rebuild, review-graph build) re-ran per temp root over content
 * that had not changed. Two temp roots in one host cost ~50s of opengrep and
 * ~53s of word-index rebuild EACH, and drove host RSS from 290MB to 1.1GB in
 * four minutes.
 *
 * A start in a different root is therefore never allowed to steal primary. It
 * is a `secondary-root`, which the caller treats exactly like a
 * `concurrent-secondary`: skip the destructive resets and the expensive
 * battery, leave the registered primary's ctx/session id/root untouched. The
 * root still gets served — `initLSPConfig` registers session roots lazily,
 * per file (`clients/lsp/session-roots.ts`), not from this handler.
 *
 * Ordering note: the root check sits BELOW the `priorCtxActive === true`
 * branch so a live sibling still reports the more specific
 * `concurrent-secondary`, and it deliberately fires even when
 * `priorCtxActive === false`. "The prior ctx was invalidated" is exactly the
 * state a temp-worktree start arrives in, so deferring to it would restore the
 * defect.
 *
 * Accepted trade-off: an in-process SEQUENTIAL replacement that genuinely
 * moves to a new directory (a host that switches sessions across cwds within
 * one process) now takes the reduced path instead of a full start. It keeps
 * working — the LSP still attaches per file — but skips the startup battery
 * for the new root until a same-root start re-registers. `sameRoot` is only
 * ever `false` on positive evidence, and
 * `PI_LENS_CONCURRENT_SESSION_GUARD=0` disables this branch with the rest of
 * the guard.
 */
/** The one implementation of the branch order above; it names the branch taken (#3873). */
export function explainSessionStart(input: ClassifySessionStartInput): {
	classification: SessionStartClassification;
	basis: ClassificationBasis;
} {
	const {
		hasPrior,
		priorCtxActive,
		sameSessionId,
		sameRoot,
		successorPending,
	} = input;

	if (!hasPrior)
		return successorPending
			? { classification: "concurrent-secondary", basis: "successor-pending" }
			: { classification: "primary", basis: "no-prior-primary" };
	if (sameSessionId)
		return { classification: "sequential-replacement", basis: "same-session" };
	if (priorCtxActive === true)
		return { classification: "concurrent-secondary", basis: "prior-ctx-live" };
	if (sameRoot === false)
		return { classification: "secondary-root", basis: "root-differs" };
	if (priorCtxActive === false)
		return {
			classification: "sequential-replacement",
			basis: "prior-ctx-dead",
		};
	// priorCtxActive === undefined: inconclusive probe — fail-safe.
	return {
		classification: "sequential-replacement",
		basis: "prior-ctx-unknown",
	};
}

/** Lazy env read (house style) — never memoized, so tests can flip it
 * mid-run via `process.env` without a reset hook. */
function guardEnabled(): boolean {
	return process.env.PI_LENS_CONCURRENT_SESSION_GUARD !== "0";
}

/**
 * Impure probe: exercises a cheap, side-effect-free ctx accessor that the
 * SDK's `ExtensionRunner.createContext()` wraps with `assertActive()`.
 *
 * Chosen accessor: `ctx.isIdle` (a bound method reading `runner.isIdleFn()`,
 * i.e. pure process/session state — no mutation, no I/O). It is wrapped the
 * same way every other guarded getter/method on the context is (`ui`,
 * `cwd`, `mode`, `signal`, `sessionManager`, ...): `assertActive()` runs
 * first and throws the SDK's stale-ctx error, matching the message fragment
 * `"stale after session replacement"`
 * (`ExtensionRunner.invalidate()`'s default message,
 * `core/extensions/runner.js` in the installed
 * `@earendil-works/pi-coding-agent` SDK dist). `isIdle` was picked over the
 * plain getters (`cwd`, `mode`, `hasUI`) only for readability at call sites
 * that already branch on idle state elsewhere in pi-lens; any of the other
 * assertActive()-wrapped accessors would work identically for this probe.
 *
 * Returns:
 *  - `true`  — the accessor call returned normally (ctx still active).
 *  - `false` — the accessor threw, and the message matches the known
 *    stale-ctx fragment (ctx confirmed invalidated by the SDK).
 *  - `undefined` — ctx has an unexpected shape (accessor missing / not a
 *    function), or the accessor threw something that does NOT look like the
 *    SDK's stale-ctx error (never assume — treat as inconclusive).
 *
 * Never throws out of this function; every branch is wrapped.
 */
export function probeCtxActive(ctx: unknown): boolean | undefined {
	try {
		const candidate = ctx as { isIdle?: unknown } | null | undefined;
		if (
			candidate === null ||
			candidate === undefined ||
			typeof candidate.isIdle !== "function"
		) {
			return undefined;
		}
		(candidate.isIdle as () => unknown)();
		return true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("stale after session replacement")) {
			return false;
		}
		// Threw, but not the SDK's known stale-ctx error — don't guess.
		return undefined;
	}
}

/** Register the current session as the process's primary. Called for both
 * `primary` and `sequential-replacement` classifications — a sequential
 * replacement re-registers itself as the (new) primary, matching today's
 * one-active-session-at-a-time behavior. */
export function registerPrimarySession(
	ctx: unknown,
	sessionId: string | undefined,
	root?: string | undefined,
): void {
	const s = state();
	s.activeCtx = ctx;
	s.activeSessionId = sessionId;
	// #2129: a re-registration that carries NO root must not erase a root the
	// previous primary did record — losing it would make every later start's
	// `sameRoot` read `undefined` (unknown) and silently restore the pre-fix
	// "any root may steal primary" behavior.
	if (root !== undefined) s.activeRoot = normalizeRootForCompare(root);
	s.secondarySessionCount = 0;
}

/**
 * Normalize a project root for identity comparison (#2129).
 *
 * Uses `normalizeFilePath` — the SAME comparator `registerInstance`
 * (`clients/instance-registry.ts:213`) writes roots with — so drive-letter
 * case, separators, and symlinked temp dirs cannot make two spellings of one
 * root look like two roots (catalog shape 1). Never throws: an unresolvable
 * path degrades to `undefined`, which reads as "root unknown" and leaves the
 * classification exactly where it was before this input existed.
 */
function normalizeRootForCompare(root: string | undefined): string | undefined {
	if (typeof root !== "string" || root.length === 0) return undefined;
	try {
		return normalizeFilePath(root);
	} catch {
		return undefined;
	}
}

/**
 * Release the primary registration when the primary session itself shuts down
 * (#2129 review F3).
 *
 * WHY THIS EXISTS. Before root identity was an input, a stale `activeCtx` left
 * behind by a departed primary was benign: the next start probed it, got
 * `false` (dead ctx), and classified `sequential-replacement`, so it took over
 * as the new primary. Root identity made that stale state DECISIVE — a start in
 * a different root behind a dead-but-still-registered primary now classifies
 * `secondary-root` and declines. Without an explicit release, root A's primary
 * ending would mean every later start in root B declines FOREVER: never
 * primary, never a full start, no re-arm.
 *
 * This is the catalog's process-lifetime-latch shape (state that must re-arm at
 * a session boundary must not outlive it). `session_shutdown`'s primary path is
 * that boundary. Deliberately NOT called on a secondary's shutdown — that path
 * returns before the shared teardown precisely because the primary is still
 * live.
 *
 * A concurrent secondary that outlives the primary now classifies `primary` on
 * its later emissions rather than `concurrent-secondary`. That is the fail-safe
 * direction this module has always taken (run the handler), and it is correct
 * here: with the primary gone there is no live sibling to protect.
 *
 * WHAT PROTECTS A SURVIVING SECONDARY (#2130 round 2, remainder N3/F3). Not the
 * count zeroed below, and not this module-level classification at all: it is the
 * per-activation `ownedSessionRole` closure in `index.ts`. Each activation
 * records the role IT was classified as at its own session_start and consults
 * that at its own shutdown, so a secondary whose primary has already released
 * still takes the secondary teardown path.
 *
 * `secondarySessionCount` is therefore an OBSERVABILITY counter, not a guard.
 * Zeroing it here under-reports for the window between the primary's release
 * and the next primary's registration. That is real and accepted: the only
 * reader is `concurrent_session_bind.metadata.secondaryCount` in `latency.log`,
 * and during that window no primary is registered, so an arriving start either
 * classifies `primary` and re-registers — which zeroes the count anyway — or,
 * inside a replacement gap (#3662), declines and counts up from zero until the
 * successor registers and zeroes it. `decrementSecondarySessionCount` clamps at
 * zero, so a late secondary's shutdown cannot underflow it. Documented rather
 * than changed, because a count that outlived the registration it is scoped to
 * would disagree with `getActivePrimaryRoot()` in the same record.
 */
export function releasePrimarySession(
	shutdownReason?: string,
	/** #3855: the `startKey` of the successor this shutdown names
	 *  (`successorStartKey` in `clients/session-scope.ts`). */
	successorKey?: string | number,
): void {
	const s = state();
	s.activeCtx = undefined;
	s.activeSessionId = undefined;
	s.activeRoot = undefined;
	s.secondarySessionCount = 0;
	// #3662: every pi shutdown reason except `quit` is followed by a start of
	// the same reason (pi 0.85.1 `agent-session-runtime.js`, `reload()`), so the
	// next primary is that successor. `quit` and a missing reason promise no
	// successor and keep the #2129 F3 re-arm above.
	const pending = shutdownReason !== undefined && shutdownReason !== "quit";
	const since = Date.now();
	s.successorPendingSince = pending ? since : undefined;
	// #3855: name the successor, so no other start in the gap can take its slot.
	s.successorNamed = pending
		? { since, reason: shutdownReason, key: successorKey }
		: undefined;
}

/** Register a concurrently-bound secondary (subagent) session. Does not
 * touch the primary's ctx/session id. */
export function registerSecondarySession(): void {
	state().secondarySessionCount += 1;
}

export type SessionShutdownClassification = "primary" | "secondary";

/**
 * Classifies a `session_shutdown` firing the same fail-safe way as
 * `explainSessionStart`: it is `secondary` ONLY when a DIFFERENT primary is
 * registered (positively identified — ctx identity differs AND session ids
 * are both known and differ) and that primary's ctx still probes active
 * (positive evidence the shutting-down session is a live sibling, not the
 * real parent exiting). Any inconclusive signal — no primary registered,
 * same ctx object, same session id, EITHER session id unknown, or the
 * primary's ctx probe returning `undefined`/`false` — classifies as
 * `primary` so today's full-teardown behavior is preserved.
 *
 * The id-unknown guard matters: without it, a single ordinary session whose
 * `sessionManager.getSessionId()` is unavailable (SDK drift) would register
 * with `sessionId === undefined`, then at its OWN shutdown the same-id check
 * couldn't fire, the probe of its own (still-live — pi invalidates on
 * replacement, not shutdown) ctx would return true, and its teardown would
 * be skipped on EVERY clean exit — leaking the LSP fleet (the #472 orphan
 * class). Trade-off accepted: a REAL secondary that also has unknown ids
 * now classifies `primary` (conservative miss — its teardown runs and hurts
 * the parent, same as pre-#473 behavior), because uncertainty must never
 * classify `secondary`.
 *
 * ROOT IDENTITY (#2146 review F1). The probe-based branch above is the only
 * evidence this function had, and it is exactly the evidence that is missing in
 * the state #2146 describes: the host's ctx is already invalidated, which is
 * WHY `secondary-root` fires on the start side. A subagent's teardown therefore
 * read "the primary's ctx is dead, so I must be the primary", and index.ts's
 * primary path called `releasePrimarySession()` and wiped the SHARED process
 * registration. The decline then survived exactly one subagent: the next one
 * classified `primary` and ran the full battery.
 *
 * So this function takes the same root discriminator `decideSessionStart` has,
 * with the same rule and the same fail-safe direction. A shutdown whose root is
 * POSITIVELY different from the registered primary's root is a `secondary`,
 * even when the primary's ctx probes `false` or `undefined` — deferring to the
 * dead-ctx branch is what restored the defect. `undefined` on either side means
 * "root unknown" and changes no verdict.
 *
 * Ordering: the root check sits BELOW the id-unknown guard, not above it. That
 * guard is the #472 fix — a session with an unreadable session id must still
 * tear itself down — and a root comparison cannot establish "different session"
 * when the ids that identify sessions are unavailable.
 */
export function noteSessionShutdown(
	// Load-bearing: ctx OBJECT IDENTITY is the definitive discriminator when
	// available — if the shutting-down handler's ctx IS the registered
	// primary's ctx, this is the primary regardless of session-id reads.
	// (Note: pi's ExtensionRunner.emit() builds a FRESH ctx object per emit,
	// so identity match is not expected with today's SDK — this check is
	// defense-in-depth for SDK versions/paths that reuse a ctx.)
	ctx: unknown,
	sessionId: string | undefined,
	/** This session's own project root (`ctx.cwd`), when readable. `undefined`
	 *  means "root unknown" and never on its own changes a verdict. */
	root?: string | undefined,
	/** #4106: this session's `startKey` (`clients/session-scope.ts`). */
	key?: string | number,
): SessionShutdownClassification {
	const s = state();
	if (ctx !== undefined && ctx === s.activeCtx) {
		return "primary";
	}
	if (s.activeCtx === undefined && s.activeSessionId === undefined) {
		// #4106: no primary is registered because a replacement named its
		// successor. Only that successor's activation can carry the named key
		// (its manager is the one the name was derived from); an activation
		// whose start never ran on any other manager is a secondary's, and must
		// not rename the gap. An unnamed or expired gap keeps the fail-safe.
		const named = namedSuccessorOf(s);
		if (named !== undefined && key !== named.key && successorStillPending(s)) {
			recordDegradationOnce({
				kind: "session-successor-pending",
				subject: "roleless-shutdown",
				reason:
					"a session_shutdown whose session_start never ran arrived in a primary replacement gap with a key the gap does not name; classified secondary, so the gap keeps its name",
			});
			return "secondary";
		}
		return "primary";
	}
	if (sessionId !== undefined && sessionId === s.activeSessionId) {
		return "primary";
	}
	// Uncertainty guard: if EITHER side's session id is unknown we cannot
	// positively establish "different session", so never classify secondary.
	if (sessionId === undefined || s.activeSessionId === undefined) {
		return "primary";
	}
	const primaryStillActive = probeCtxActive(s.activeCtx);
	if (primaryStillActive === true) {
		return "secondary";
	}
	// #2146 F1: positive evidence of a DIFFERENT root, in a session positively
	// identified as not the primary. Deliberately below the probe-true branch
	// (a live sibling is already answered) and deliberately ABOVE the
	// dead-ctx fail-safe, because a dead primary ctx is precisely the state a
	// subagent teardown arrives in.
	const shutdownRoot = normalizeRootForCompare(root);
	if (
		s.activeRoot !== undefined &&
		shutdownRoot !== undefined &&
		s.activeRoot !== shutdownRoot
	) {
		return "secondary";
	}
	// primaryStillActive is false or undefined: fail-safe to primary.
	return "primary";
}

/**
 * Read-only counterpart to {@link explainSessionStart}, usable from ANY
 * event handler (agent_end, turn_end, ...) rather than only session_start.
 * Unlike `decideSessionStart` this never mutates the module-scope
 * registration — repeated calls across a session's many agent_end/turn_end
 * firings are side-effect-free.
 *
 * Same fail-safe direction as the rest of this module: only returns
 * `"concurrent-secondary"` on POSITIVE evidence — a different, KNOWN session
 * id than the registered primary's, AND the registered primary's ctx still
 * probes active (i.e. a live sibling, not a primary that simply never
 * re-registered). Every uncertain case (no primary registered yet, same ctx
 * object, same session id, either id unknown, or the primary's probe isn't
 * affirmatively `true`) classifies as `"primary"` so today's behavior (run
 * the handler) is preserved. #791: used to skip the deferred-format flush at
 * `agent_end` for a concurrent secondary's own firing, mirroring how
 * `decideSessionStart` already skips `handleSessionStart`.
 */
export function classifyCurrentSessionEmission(
	ctx: unknown,
	sessionId: string | undefined,
): "primary" | "concurrent-secondary" {
	if (!guardEnabled()) return "primary";
	const s = state();
	if (s.activeCtx === undefined && s.activeSessionId === undefined)
		return "primary";
	if (ctx !== undefined && ctx === s.activeCtx) return "primary";
	if (sessionId !== undefined && sessionId === s.activeSessionId)
		return "primary";
	// Uncertainty guard: if EITHER side's session id is unknown we cannot
	// positively establish "different session", so never classify secondary.
	if (sessionId === undefined || s.activeSessionId === undefined)
		return "primary";
	const primaryStillActive = probeCtxActive(s.activeCtx);
	if (primaryStillActive === true) return "concurrent-secondary";
	return "primary";
}

export function getSecondarySessionCount(): number {
	return state().secondarySessionCount;
}

export function decrementSecondarySessionCount(): void {
	const s = state();
	if (s.secondarySessionCount > 0) s.secondarySessionCount -= 1;
}

/**
 * Guard-aware wrapper used by callers (index.ts) so the kill switch lives in
 * one place: when disabled, always report `sequential-replacement` (i.e.
 * behave exactly as if this module didn't exist).
 */
export function explainSessionStartGuarded(input: ClassifySessionStartInput): {
	classification: SessionStartClassification;
	basis: ClassificationBasis;
} {
	if (!guardEnabled())
		return {
			classification: input.hasPrior ? "sequential-replacement" : "primary",
			basis: "guard-disabled",
		};
	return explainSessionStart(input);
}

/** Test-only: clears all module-scope state (house style — see
 * `_resetSubagentModeForTests` / `slow-fs.ts`). */
export function _resetSessionLifecycleForTests(): void {
	// Resets the PROCESS state, not a module-local copy: a reset that cleared
	// only module scope would leave the real registration behind and make every
	// suite that relies on isolation pass vacuously (#2146, catalog shape 7).
	const s = state();
	s.activeCtx = undefined;
	s.activeSessionId = undefined;
	s.activeRoot = undefined;
	s.secondarySessionCount = 0;
	s.successorPendingSince = undefined;
	s.successorNamed = undefined;
}

export interface SessionStartGuardDecision {
	classification: SessionStartClassification;
	/** True iff the caller should proceed with `handleSessionStart` + the
	 * rest of today's session_start body exactly as before. False means a
	 * concurrent secondary was detected — the caller must skip
	 * `handleSessionStart` (and `updateRuntimeIdentityFromEvent`) entirely. */
	runFullSessionStart: boolean;
	secondaryCount: number;
	/**
	 * #2129 observability: the root-identity input the classification actually
	 * consulted, so a log reader can tell "the root check ran and said same
	 * root" from "the root check had nothing to compare". Mirrors
	 * {@link ClassifySessionStartInput.sameRoot}.
	 */
	sameRoot: boolean | undefined;
	/** The registered primary's normalized root at decision time, if any. */
	primaryRoot: string | undefined;
	/** #3873 O6: the branch of the classifier that decided. */
	basis: ClassificationBasis;
	/**
	 * #3873 O6: ms since a primary replacement's shutdown left its successor
	 * marker (`undefined`: no marker), whether or not it has expired.
	 */
	gapMs: number | undefined;
	/**
	 * #3873 O6: this start against the successor the marker named: `none` (no
	 * marker), `unnamed` (a marker without a name), `named` (this start's reason
	 * and key are the named ones) or `not-named`.
	 */
	lineageMatch: "none" | "unnamed" | "named" | "not-named";
}

/**
 * Single entry point `index.ts`'s `session_start` handler delegates to, so
 * the classify → probe → register decision is unit-testable independent of
 * the SDK's `pi.on("session_start", ...)` wiring (which cannot be invoked
 * directly in tests).
 *
 * `ctx` is whatever the SDK handed the handler (only ever probed via
 * {@link probeCtxActive}, never dereferenced otherwise, so passing a plain
 * fake object in tests is safe). `sessionId` is the STABLE session id
 * (`ctx.sessionManager.getSessionId()`), which may be `undefined`.
 */
export function decideSessionStart(
	ctx: unknown,
	sessionId: string | undefined,
	root?: string | undefined,
	/** #3662: this start's `event.reason`. pi sends `startup` only for a
	 *  runtime's first bind, never for a replacement's successor. */
	reason?: string | undefined,
	/** #3855: this start's `startKey` (`clients/session-scope.ts`). */
	key?: string | number,
): SessionStartGuardDecision {
	const s = state();
	const hasPrior = s.activeCtx !== undefined || s.activeSessionId !== undefined;
	// #3855: in a replacement gap only the start the shutdown named, by reason
	// and key, is the successor. A start with no reason fails safe to primary
	// (#3662 F8); a marker without a name keeps #3662's rule.
	const named = namedSuccessorOf(s);
	// Observe expiry even when the named successor is the first later start:
	// it remains primary, but the bounded degradation must disclose that the
	// marker crossed its TTL before this start arrived.
	if (!hasPrior && s.successorPendingSince !== undefined)
		successorStillPending(s);
	const notTheSuccessor =
		named === undefined
			? reason === "startup"
			: reason !== undefined && (reason !== named.reason || key !== named.key);
	const successorPending =
		!hasPrior && notTheSuccessor && successorStillPending(s);
	const priorCtxActive = hasPrior ? probeCtxActive(s.activeCtx) : undefined;
	// ctx OBJECT IDENTITY: if the SDK ever hands the SAME ctx object to a
	// repeated session_start, that is by definition the same session
	// re-announcing itself — sequential, never concurrent. (Not expected with
	// today's SDK — ExtensionRunner.emit() builds a fresh ctx per emit — but
	// identity is the one signal that can't false-positive, so honor it.)
	const sameCtx = hasPrior && ctx !== undefined && ctx === s.activeCtx;
	const sameSessionId =
		sameCtx ||
		(hasPrior && sessionId !== undefined && sessionId === s.activeSessionId);

	// #2129: compare THIS start's cwd against the registered primary's root.
	// `undefined` on either side means "unknown", never "different" — see
	// `explainSessionStart`'s fail-safe note.
	const incomingRoot = normalizeRootForCompare(root);
	const sameRoot =
		hasPrior && s.activeRoot !== undefined && incomingRoot !== undefined
			? s.activeRoot === incomingRoot
			: undefined;

	// #2129 review F5: capture the primary root BEFORE any registration mutates
	// it, so the reported value is genuinely the decision-time input the
	// classifier consulted rather than the value this call just wrote.
	const primaryRootAtDecision = s.activeRoot;

	const { classification, basis } = explainSessionStartGuarded({
		hasPrior,
		priorCtxActive,
		sameSessionId,
		sameRoot,
		successorPending,
	});
	const gapMs =
		s.successorPendingSince === undefined
			? undefined
			: Date.now() - s.successorPendingSince;
	const lineageMatch =
		s.successorPendingSince === undefined
			? "none"
			: named === undefined
				? "unnamed"
				: reason === named.reason && key === named.key
					? "named"
					: "not-named";

	if (
		classification === "concurrent-secondary" ||
		classification === "secondary-root"
	) {
		if (successorPending) {
			const startup = reason === "startup";
			recordDegradationOnce({
				kind: "session-successor-pending",
				subject: startup ? "declined" : "not-the-successor",
				reason: startup
					? "a startup session_start arrived after a primary replacement shutdown and before its successor; declined as concurrent-secondary"
					: `a ${reason} session_start in a primary replacement gap is not the successor that shutdown named; declined as concurrent-secondary`,
			});
		}
		registerSecondarySession();
		return {
			classification,
			runFullSessionStart: false,
			secondaryCount: s.secondarySessionCount,
			sameRoot,
			primaryRoot: primaryRootAtDecision,
			basis,
			gapMs,
			lineageMatch,
		};
	}

	// "primary" or "sequential-replacement": register as the (new) primary
	// and proceed exactly as today.
	registerPrimarySession(ctx, sessionId, root);
	return {
		classification,
		runFullSessionStart: true,
		secondaryCount: s.secondarySessionCount,
		sameRoot,
		primaryRoot: primaryRootAtDecision,
		basis,
		gapMs,
		lineageMatch,
	};
}

/**
 * #4113: in a primary replacement gap (no primary registered, the marker
 * pending), the start reason its shutdown named. A start interrupted before
 * pi-lens's handler ran never saw its own reason; when #4106 classifies its
 * shutdown primary it carries the named key, so it is that start.
 */
export function namedSuccessorReason(): string | undefined {
	const s = state();
	if (s.activeCtx !== undefined || s.activeSessionId !== undefined)
		return undefined;
	const named = namedSuccessorOf(s);
	return named !== undefined && successorStillPending(s)
		? named.reason
		: undefined;
}

/**
 * The replacement successor named by an expired marker, for the role-less
 * shutdown of that successor's interrupted start. The marker no longer
 * declines unrelated starts after expiry, but its identity still authorizes
 * forwarding the existing activation slot to the successor's reload.
 */
export function expiredSuccessorReason(): string | undefined {
	const s = state();
	if (s.activeCtx !== undefined || s.activeSessionId !== undefined)
		return undefined;
	const named = namedSuccessorOf(s);
	if (named === undefined || successorStillPending(s)) return undefined;
	if (
		s.successorPendingSince !== undefined &&
		Date.now() - s.successorPendingSince >= SUCCESSOR_HANDOFF_TTL_MS
	) {
		s.successorPendingSince = undefined;
		s.successorNamed = undefined;
		return undefined;
	}
	return named.reason;
}

/** #3855: the successor the pending replacement named, when this build's
 *  release wrote it with the marker it stands beside. */
function namedSuccessorOf(
	s: SessionLifecycleState,
): { reason: string; key: string | number | undefined } | undefined {
	return s.successorNamed?.since === s.successorPendingSince
		? s.successorNamed
		: undefined;
}

/** #3662: whether a replacement shutdown's marker is younger than the bound.
 *  An expired marker records once and stops declining. */
function successorStillPending(s: SessionLifecycleState): boolean {
	if (s.successorPendingSince === undefined) return false;
	const ttlMs = successorPendingTtlMs();
	if (Date.now() - s.successorPendingSince < ttlMs) {
		return true;
	}
	recordDegradationOnce({
		kind: "session-successor-pending",
		subject: "expired",
		reason: `no successor session_start within ${ttlMs}ms of a primary replacement shutdown; a startup start classifies primary again`,
	});
	return false;
}
