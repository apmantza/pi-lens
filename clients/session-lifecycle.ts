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
}

/**
 * PURE classifier — no I/O, no throws, fully unit-testable in isolation.
 *
 * Branches (fail-safe order matters):
 *  1. No prior primary registered → `primary` (first session_start this
 *     process has seen; zero behavior change for the single-session case).
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
export function classifySessionStart(
	input: ClassifySessionStartInput,
): SessionStartClassification {
	const { hasPrior, priorCtxActive, sameSessionId, sameRoot } = input;

	if (!hasPrior) return "primary";
	if (sameSessionId) return "sequential-replacement";
	if (priorCtxActive === true) return "concurrent-secondary";
	if (sameRoot === false) return "secondary-root";
	if (priorCtxActive === false) return "sequential-replacement";
	// priorCtxActive === undefined: inconclusive probe — fail-safe.
	return "sequential-replacement";
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
 * and during that window no primary is registered, so every arriving start
 * classifies `primary` and re-registers — which zeroes the count anyway —
 * instead of emitting a bind record. `decrementSecondarySessionCount` clamps at
 * zero, so a late secondary's shutdown cannot underflow it. Documented rather
 * than changed, because a count that outlived the registration it is scoped to
 * would disagree with `getActivePrimaryRoot()` in the same record.
 */
export function releasePrimarySession(): void {
	const s = state();
	s.activeCtx = undefined;
	s.activeSessionId = undefined;
	s.activeRoot = undefined;
	s.secondarySessionCount = 0;
}

/** Register a concurrently-bound secondary (subagent) session. Does not
 * touch the primary's ctx/session id. */
export function registerSecondarySession(): void {
	state().secondarySessionCount += 1;
}

export type SessionShutdownClassification = "primary" | "secondary";

/**
 * Classifies a `session_shutdown` firing the same fail-safe way as
 * `classifySessionStart`: it is `secondary` ONLY when a DIFFERENT primary is
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
): SessionShutdownClassification {
	const s = state();
	if (ctx !== undefined && ctx === s.activeCtx) {
		return "primary";
	}
	if (s.activeCtx === undefined && s.activeSessionId === undefined) {
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
 * Read-only counterpart to {@link classifySessionStart}, usable from ANY
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
export function classifySessionStartGuarded(
	input: ClassifySessionStartInput,
): SessionStartClassification {
	if (!guardEnabled())
		return input.hasPrior ? "sequential-replacement" : "primary";
	return classifySessionStart(input);
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
): SessionStartGuardDecision {
	const s = state();
	const hasPrior = s.activeCtx !== undefined || s.activeSessionId !== undefined;
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
	// `classifySessionStart`'s fail-safe note.
	const incomingRoot = normalizeRootForCompare(root);
	const sameRoot =
		hasPrior && s.activeRoot !== undefined && incomingRoot !== undefined
			? s.activeRoot === incomingRoot
			: undefined;

	// #2129 review F5: capture the primary root BEFORE any registration mutates
	// it, so the reported value is genuinely the decision-time input the
	// classifier consulted rather than the value this call just wrote.
	const primaryRootAtDecision = s.activeRoot;

	const classification = classifySessionStartGuarded({
		hasPrior,
		priorCtxActive,
		sameSessionId,
		sameRoot,
	});

	if (
		classification === "concurrent-secondary" ||
		classification === "secondary-root"
	) {
		registerSecondarySession();
		return {
			classification,
			runFullSessionStart: false,
			secondaryCount: s.secondarySessionCount,
			sameRoot,
			primaryRoot: primaryRootAtDecision,
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
	};
}
