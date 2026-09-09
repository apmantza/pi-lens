/**
 * One implementation of the "race a promise against a timer" pattern that had
 * drifted into three near-identical copies (#366): `withTimeout` (clients/lsp),
 * `withBudget` (read-expansion), and `withinRemaining` (module-report-lsp).
 *
 * The differences between them were real — timeout can *reject* or *resolve
 * undefined*, and the raced promise's own rejection can *propagate* or be
 * *swallowed* — so they are kept as named adapters over one core. Consolidating
 * fixes two latent bugs the copies had: `withBudget` did not suppress the loser
 * promise's late rejection (an unhandled rejection if the timer won first), and
 * `withinRemaining` never cleared its timer.
 */

import { recordDegradationOnce } from "./degradation-ledger.js";
import type { LedgerHookKey } from "./hook-budgets.js";

/**
 * Combine multiple abort signals into one that aborts when ANY of them does.
 * Returns the single signal unchanged when only one is live, and `undefined`
 * when none are — so callers can pass it straight through. Used so a tool honors
 * both its tool-call `signal` positional and the turn-wired `ctx.signal` (Escape),
 * and to fold in a wall-clock ceiling via `AbortSignal.timeout`.
 */
export function combineAbortSignals(
	...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
	const live = signals.filter((s): s is AbortSignal => s !== undefined);
	if (live.length <= 1) return live[0];
	if (typeof AbortSignal.any === "function") return AbortSignal.any(live);
	const controller = new AbortController();
	for (const s of live) {
		if (s.aborted) {
			controller.abort((s as AbortSignal & { reason?: unknown }).reason);
			break;
		}
		s.addEventListener("abort", () => controller.abort(s.reason), {
			once: true,
		});
	}
	return controller.signal;
}

export interface DeadlineOptions {
	/** Duration budget in ms. Provide this OR `deadlineAt`. */
	ms?: number;
	/** Absolute deadline (`Date.now()`-based). Provide this OR `ms`. */
	deadlineAt?: number;
	/**
	 * What happens when the timer wins first:
	 *  - `"reject"` (default): reject with `Error("Timeout after <ms>ms")`.
	 *  - `"undefined"`: resolve to `undefined`.
	 */
	onTimeout?: "reject" | "undefined";
	/**
	 * What happens if `promise` itself rejects:
	 *  - `"propagate"` (default): rethrow the rejection.
	 *  - `"undefined"`: swallow it and resolve to `undefined`.
	 */
	onReject?: "propagate" | "undefined";
}

// reject-on-timeout + propagate-rejection can never yield `undefined`, so it
// keeps the precise `Promise<T>` return; any undefined-producing mode is `T | undefined`.
export function withDeadline<T>(
	promise: Promise<T>,
	options: {
		ms?: number;
		deadlineAt?: number;
		onTimeout?: "reject";
		onReject?: "propagate";
	},
): Promise<T>;
export function withDeadline<T>(
	promise: Promise<T>,
	options: DeadlineOptions,
): Promise<T | undefined>;
export function withDeadline<T>(
	promise: Promise<T>,
	options: DeadlineOptions,
): Promise<T | undefined> {
	const onTimeout = options.onTimeout ?? "reject";
	const onReject = options.onReject ?? "propagate";
	const ms =
		options.ms ??
		(options.deadlineAt !== undefined ? options.deadlineAt - Date.now() : 0);

	// Past deadline / non-positive budget: settle immediately, no timer. This
	// branch returns before the race below ever runs, so — same reason as the
	// loser-leg catch a few lines down — `promise` needs its own no-op catch
	// here too: without it, a `promise` that eventually rejects (the caller
	// already invoked it; this function only decides how long to wait on it)
	// surfaces as an unhandled rejection instead of being silently superseded
	// by the immediate timeout/undefined settlement.
	if (ms <= 0) {
		promise.catch(() => {});
		return onTimeout === "undefined"
			? Promise.resolve(undefined)
			: Promise.reject(new Error(`Timeout after ${Math.max(0, ms)}ms`));
	}

	// Base promise with rejection handled per `onReject`. In propagate mode we
	// still attach a no-op catch so that if the timer wins the race, the loser
	// promise's later rejection does not surface as an unhandled rejection.
	const base: Promise<T | undefined> =
		onReject === "undefined" ? promise.catch(() => undefined) : promise;
	if (onReject === "propagate") promise.catch(() => {});

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<T | undefined>((resolve, reject) => {
		timer = setTimeout(() => {
			if (onTimeout === "undefined") resolve(undefined);
			else reject(new Error(`Timeout after ${ms}ms`));
		}, ms);
	});

	return Promise.race([base, timeoutPromise]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/**
 * Resolve `promise`, or reject with `Error("Timeout after <ms>ms")` once
 * `timeoutMs` elapses. The raced promise's own rejection propagates.
 */
export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	return withDeadline(promise, { ms: timeoutMs });
}

/**
 * Resolve `promise`, or `undefined` once `budgetMs` elapses (a non-positive
 * budget resolves `undefined` immediately). The raced promise's own rejection
 * propagates.
 */
export function withBudget<T>(
	promise: Promise<T>,
	budgetMs: number,
): Promise<T | undefined> {
	return withDeadline(promise, { ms: budgetMs, onTimeout: "undefined" });
}

/**
 * Resolve `promise`, or `undefined` once the shared `deadlineAt` passes (a past
 * deadline resolves `undefined` immediately). The raced promise's own rejection
 * is swallowed to `undefined`.
 */
export function withinRemaining<T>(
	promise: Promise<T>,
	deadlineAt: number,
): Promise<T | undefined> {
	return withDeadline(promise, {
		deadlineAt,
		onTimeout: "undefined",
		onReject: "undefined",
	});
}

/**
 * The abort half of a bound, as a value the race can settle on. A symbol, not
 * `undefined`, so `bounded` can tell "the signal fired" from "the awaited work
 * genuinely resolved `undefined`" — the distinction AGENTS.md defect shape 10
 * (silencing counted as fixing) exists to protect.
 */
const BOUND_ABORTED: unique symbol = Symbol("pi-lens/bounded/aborted");

/**
 * Which bound abandoned the await — the three `abandonedError`
 * (`clients/bootstrap.ts`) already distinguishes, kept identical so
 * {@link bounded} is a true SUPERSET of that helper rather than a fourth
 * dialect. They have opposite remedies, and only one of them is a defect:
 *
 * - `"deadline"` — the work was too slow for the hook's wall budget. The hook
 *   shipped a partial answer. Raise the budget, move the work off-hook, or fix
 *   what wedged. Recorded as `hook-await-exceeded` (warning tier).
 * - `"caller-abort"` — the hook's own `ctx.signal` fired: Escape, a cancelled
 *   turn. A deliberate USER action, nothing degraded, nothing to act on.
 *   Recorded NOWHERE.
 * - `"shutdown"` — the session is tearing down. Abandoning in-flight work is
 *   what teardown is for. Recorded as `hook-await-abandoned`, informational.
 */
type BoundCause = "deadline" | "caller-abort" | "shutdown";

/** Everything {@link bounded} needs. Both bounds are REQUIRED — see below. */
export interface BoundedOptions {
	/**
	 * Wall-clock budget in ms. NOT optional: a deadline-only call is the exact
	 * defect this helper exists to make unrepresentable, so the type refuses it.
	 * Read the number from `HOOK_WALL_BUDGET_MS` (`clients/hook-budgets.ts`)
	 * rather than inventing a per-call literal.
	 */
	ms: number;
	/**
	 * The HOOK's abort signal — `ctx.signal`, threaded down through the deps
	 * object, never `getAmbientAbortSignal()`.
	 *
	 * A REQUIRED property whose type admits `undefined`, which is a deliberate
	 * pair of decisions, not a half-measure:
	 *
	 * - Required, so `bounded(p, { ms, hook, label })` stays a COMPILE error
	 *   (TypeScript demands the key be written even when its type includes
	 *   `undefined`). A wall-clock-only bound leaves Escape unable to release
	 *   the hook, which is precisely what #2523's probe measured
	 *   (`still-blocked after 30011ms` with the ambient abort fired at t=2s),
	 *   so a call that never mentions a signal cannot type-check.
	 * - Admitting `undefined`, because several real seams hold an OPTIONAL
	 *   `AbortSignal | undefined` — `clients/bootstrap.ts`'s
	 *   `SessionBootstrapAccess.request` takes none ON PURPOSE (#1394: a
	 *   `session_start` can land mid-turn, and binding the outgoing turn's
	 *   signal cancelled every startup scan with no retry), and
	 *   `clients/observed-mutation.ts` / `clients/pipeline.ts` /
	 *   `clients/actionable-warnings.ts` have one on every production path but
	 *   an optional parameter in the type. This helper already treats a missing
	 *   signal as one that never aborts (`signal?.` below); admitting it in the
	 *   type is what stops each of those seams from spelling that same fallback
	 *   for itself. #2557 review F2: a `NEVER_ABORTED` sentinel constant did
	 *   exactly that, adding a SECOND concept for behaviour this helper already
	 *   had — a net-count regression on an issue whose whole point is that one
	 *   bound primitive replaces the private copies.
	 *
	 * Writing `signal: x` where `x` may be `undefined` is therefore legal and
	 * greppable rather than clever. It is also ENUMERATED: every shipped
	 * `bounded()` call site is registered in `tests/config/hook-await-bounds.
	 * test.ts` with the provenance of its signal, so the set of seams running
	 * on a possibly-single bound cannot grow without someone writing down why.
	 */
	signal: AbortSignal | undefined;
	/**
	 * Optional TEARDOWN signal — the seam's own session-shutdown controller,
	 * not a turn signal. Supplying it is what lets a caller whose work is not
	 * turn-scoped still satisfy both bounds without binding a turn signal that
	 * would cancel it for the wrong reason, exactly as
	 * `clients/bootstrap.ts#ensureBootstrapClients` threads
	 * `bootstrapShutdownController.signal` today.
	 *
	 * Optional because it is a THIRD bound, not half of the required pair: a
	 * hook that has no teardown signal to offer still has both of its own.
	 */
	shutdownSignal?: AbortSignal;
	/**
	 * Hook family this await runs under, e.g. `"turn_end"`. Half of the ledger
	 * key.
	 *
	 * Typed, not a free string: the subject this builds (`<hook>:<label>`) is
	 * read against `HOOK_WALL_BUDGET_MS`, so a value that names something other
	 * than a hook — a demand reason, a caller name — produces a row nothing can
	 * join on (#2557 review F7). Put the caller's own identity in {@link label}.
	 */
	hook: LedgerHookKey;
	/** What is being awaited, e.g. `"sweepInlineBlockerFreshness"`. */
	label: string;
}

/**
 * Await `promise` under BOTH bounds a hook needs: a wall-clock budget AND the
 * hook's own abort signal (#2523 AC2).
 *
 * ## Why the type refuses one bound
 *
 * Every bound in this codebase lived at a LEAF — a spawn timeout, an LSP wait
 * — so a dependency that wedged before reaching the leaf was unreachable by
 * all of them, and `wrapSessionEventHandler` adds neither. The two halves fail
 * differently and neither substitutes for the other: a deadline alone means
 * Escape cannot release the hook (measured: still blocked 30s after the abort
 * fired), and a signal alone means a dependency that wedges without anyone
 * pressing Escape never returns at all (measured: 400s, the harness ceiling).
 * `ms` and `signal` are therefore both non-optional properties, so
 * `bounded(p, { ms: 500, hook, label })` is a COMPILE error, not a review
 * catch. `tests/clients/bounded-hook-await.test.ts` pins that with
 * `@ts-expect-error`: weaken either property and those directives become
 * unused, which `tsc` reports as TS2578.
 *
 * ## Semantics
 *
 * - Resolves to the promise's value when it settles inside both bounds.
 * - Resolves to `undefined` when the budget elapses OR a signal aborts,
 *   whichever comes first — and firing a signal settles IMMEDIATELY, it
 *   never waits the remaining deadline out.
 * - Rejections propagate: this helper decides how LONG to wait, never what an
 *   error means. Once a bound has fired, a later rejection from the
 *   superseded promise is suppressed (a no-op catch is attached to the work
 *   up front) so it cannot surface as an unhandled rejection.
 *
 * ## What reaches the ledger, and what deliberately does not
 *
 * Which bound fired decides this, via {@link BoundCause}. Only the DEADLINE
 * records `hook-await-exceeded` — ONE rising-edge row per (hook, label) via
 * `recordDegradationOnce`, naming the hook, the await, the budget, the actual
 * elapsed ms and the cause. Bounded by construction: a hook that blows its
 * budget on every turn of a long session writes one ledger row, not one per
 * turn. Promote it to `incrementDegradationCount` if slice 2 finds the exact
 * tally is needed.
 *
 * A `"caller-abort"` records NOTHING. The caller's signal is the user pressing
 * Escape or a turn being cancelled — a deliberate action, not a degraded
 * environment. `clients/bootstrap.ts` already carries this lesson at its
 * `if (unavailableReason !== "aborted")` guard: writing a cancel to the ledger
 * made it indistinguishable from an unhealthy analyzer graph in
 * `pilens_health`. This helper is meant to become THE bound primitive at
 * ~187 call sites, so recording a cancel here would ship that inversion
 * everywhere at once.
 *
 * A `"shutdown"` records `hook-await-abandoned`, which is in
 * `INFORMATIONAL_DEGRADATION_KINDS` — teardown abandoning in-flight work is
 * the design, so it is a tally rather than a `⚠`.
 *
 * `undefined` therefore means "no answer inside the bound" and must never be
 * read as an empty/clean ANSWER (defect shape 10, and the #240 lesson that a
 * failed diagnostic pull is not a clean file). The caller decides what the
 * absence means; the ledger row is what makes it visible either way.
 *
 * The promise is not cancelled — nothing here can cancel work already
 * started. It is abandoned, with the abandonment recorded. Work that must not
 * outlive its hook needs the signal threaded INTO it as well (#2523 slice 2's
 * `TurnEndDeps`/`AgentEndDeps`/`SessionStartDeps` change); wrapping the await
 * bounds the HOOK, not the work.
 */
export async function bounded<T>(
	promise: Promise<T>,
	options: BoundedOptions,
): Promise<T | undefined> {
	const { signal, shutdownSignal, hook, label } = options;
	// A non-finite budget settles immediately rather than throwing. The type
	// forbids it, but a JS caller (or a `@ts-expect-error` probe) can still
	// hand one over, and `setTimeout(fn, NaN)` would fire on the next tick
	// with a warning — a helper whose whole job is keeping a hook from blowing
	// up must not itself misbehave inside one. Same
	// `Number.isFinite`-before-`Math.max` gate the runtime-config readers use.
	const ms = Number.isFinite(options.ms) ? Math.max(0, options.ms) : 0;
	const startedAt = Date.now();

	// Late rejection from work a bound has already abandoned must not surface
	// as an unhandled rejection. Attached to the BOXED promise, which is what
	// the race below actually subscribes to; the caller still sees a rejection
	// that arrives inside the bounds, because `Promise.race` attaches its own
	// handler to the same promise.
	const boxed = promise.then((value) => ({ value }) as const);
	void boxed.catch(() => {});

	// ONE timer and ONE listener per source signal, all released in `finally`
	// (#2530 review F2/F4).
	//
	// The round-1 implementation folded the wall clock in as
	// `AbortSignal.timeout(ms)` and combined it through `AbortSignal.any`,
	// then ALSO passed `ms` to `withDeadline` — two timers for one budget, and
	// a composite signal per call. `AbortSignal.any` does not add a listener
	// to its sources: it appends the composite to an internal dependant list
	// on each of them, which lives as long as the SOURCE does. The hook signal
	// outlives one await by a whole turn, so 20 000 successful `bounded()`
	// calls on one hook signal left 20 000 entries on it, and the `finally`'s
	// `removeEventListener` — aimed at the throwaway composite — removed
	// nothing from the source. Listening on the sources directly is what makes
	// the cleanup reach the thing that outlives the call.
	let cause: BoundCause | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onCallerAbort: (() => void) | undefined;
	let onShutdownAbort: (() => void) | undefined;

	const abandoned = new Promise<typeof BOUND_ABORTED>((resolve) => {
		// `abandonedError`'s precedence, unchanged: the caller's own signal
		// first, then teardown, then the clock. A turn cancelled while the
		// session also happens to be tearing down is still a cancel.
		const fire = (reason: BoundCause) => {
			cause ??= reason;
			resolve(BOUND_ABORTED);
		};
		// `signal?.` — a missing signal is treated as one that never aborts.
		// The KEY is required (so a call that never mentions a signal does not
		// compile), but its type admits `undefined` because several seams
		// genuinely hold `AbortSignal | undefined` — see `BoundedOptions.signal`
		// for which ones and why. This branch is what lets them pass it straight
		// through instead of each spelling its own never-aborting stand-in
		// (#2557 review F2), and it is also what keeps a JS caller, or a
		// `@ts-expect-error` probe, from making a helper whose whole job is
		// keeping a hook from blowing up throw `Cannot read properties of
		// undefined` (#2530 round 3 F5).
		if (signal?.aborted) return fire("caller-abort");
		if (shutdownSignal?.aborted) return fire("shutdown");
		// A zero budget ("this hook may not await at all") is a bound that has
		// already elapsed, not a timer to arm.
		if (ms <= 0) return fire("deadline");
		timer = setTimeout(() => fire("deadline"), ms);
		// Never hold the event loop open past the hook this bounds.
		timer.unref?.();
		onCallerAbort = () => fire("caller-abort");
		signal?.addEventListener("abort", onCallerAbort, { once: true });
		if (shutdownSignal) {
			onShutdownAbort = () => fire("shutdown");
			shutdownSignal.addEventListener("abort", onShutdownAbort, {
				once: true,
			});
		}
	});

	try {
		// The value is boxed so a promise that legitimately resolves
		// `undefined` stays distinguishable from a bound firing (defect shape
		// 10: a silenced answer must not read as a clean one).
		const settled = await Promise.race([boxed, abandoned]);
		if (settled !== BOUND_ABORTED) return settled.value;

		const elapsedMs = Date.now() - startedAt;
		const fired = cause ?? "deadline";
		// A caller's own abort is Escape or a cancelled turn — deliberate, not
		// a degradation, and deliberately absent from the ledger.
		if (fired === "deadline" || fired === "shutdown") {
			recordDegradationOnce({
				kind:
					fired === "deadline" ? "hook-await-exceeded" : "hook-await-abandoned",
				subject: `${hook}:${label}`,
				reason:
					fired === "deadline"
						? `exceeded ${ms}ms budget after ${elapsedMs}ms`
						: `abandoned after ${elapsedMs}ms: session is shutting down (budget ${ms}ms)`,
				metadata: { hook, label, budgetMs: ms, elapsedMs, cause: fired },
			});
		}
		return undefined;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onCallerAbort) signal?.removeEventListener("abort", onCallerAbort);
		if (onShutdownAbort) {
			shutdownSignal?.removeEventListener("abort", onShutdownAbort);
		}
	}
}
