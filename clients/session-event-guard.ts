/**
 * One home for "this event arrived on a ctx the SDK already invalidated"
 * (#1925).
 *
 * pi invalidates a captured extension ctx when the session is replaced —
 * `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, `ctx.reload()`.
 * Every accessor on that ctx then throws from the SDK's `assertActive()`
 * (`core/extensions/loader.js` in the installed
 * `@earendil-works/pi-coding-agent`). An event already queued when the swap
 * happens still reaches pi-lens, carrying the dead ctx, and the first
 * unguarded `ctx.signal` / `ctx.ui` / `ctx.cwd` read throws.
 *
 * That throw does not escape into pi's loop. `ExtensionRunner.emit` wraps every
 * handler call in a try/catch and routes the error to `emitError`
 * (`core/extensions/runner.js:586-606` in the installed SDK), so the throw
 * surfaces as an extension error report against pi-lens. The report names the
 * wrong cause. It reads as a pi-lens handler bug when the real event is a
 * benign race with a session swap, it says nothing about which handler keeps
 * losing, and it counts nothing. This wrapper converts that noisy misattributed
 * error into a counted, bounded, attributable skip.
 *
 * #1924 fixed that for `agent_settled` with an inline try/catch. #1925 found
 * four more handlers with the same shape. Five inline copies of one policy is
 * the parallel-state defect AGENTS.md names, so the policy lives here instead.
 * `agent_settled` is a consumer of this path, not a special case.
 *
 * ## What this module actually covers
 *
 * Not every `pi.on` registration in `index.ts` goes through here, and the doc
 * used to read as if they all did. Seven do today:
 *
 * - {@link wrapSessionEventHandler} — `tool_result`, `turn_start`,
 *   `agent_end`, `turn_end`, `agent_settled` (#1925) and `session_start`
 *   (#1929). All six return nothing, so a skipped event resolving to
 *   `undefined` is exactly their own early-exit value.
 * - {@link wrapSessionEventHandlerWithResult} — `context` (#1929), which must
 *   hand the host back a message list on the live path.
 *
 * Five registrations stay unwrapped on purpose: `resources_discover`,
 * `session_before_fork`, `tool_call`, `session_shutdown`, and `message_end`.
 * `tests/clients/session-event-guard-sweep.test.ts` is the source of truth for
 * that split. It scans every registration in `index.ts` and reds unless the
 * handler is wrapped or carries a written reason, so this paragraph can go
 * stale but the contract cannot.
 *
 * The wrapper does three things and nothing else:
 *
 * 1. **Probes once, before dispatch.** {@link probeCtxActive} answers `false`
 *    only when an `assertActive()`-wrapped accessor threw the SDK's own stale
 *    message. `undefined` (no ctx, unexpected shape, unrecognised throw) is
 *    inconclusive and always dispatches — never guess a session dead.
 * 2. **Still classifies a stale throw that races in mid-handler.** The probe
 *    is a point-in-time read; the swap can land between the probe and the
 *    handler's own first ctx read, and for an async handler it can land at any
 *    await. Both the synchronous throw and the rejected promise are
 *    classified by {@link isStaleExtensionCtxError}.
 * 3. **Makes the skip visible.** One bounded record and one ledger kind for
 *    the whole class, keyed by the event name so aggregation still answers
 *    WHICH handler is being skipped. A silent guard and a guard that never
 *    fires read identically from a log, which is exactly how vacuous guards
 *    survive review.
 *
 * Anything that is NOT the SDK's stale-ctx error propagates unchanged. The
 * wrapper narrows nothing else: a handler bug must stay as loud as it was.
 */

import { emitBounded } from "./bounded-telemetry.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { bounded } from "./deadline-utils.js";
import { HOOK_WALL_BUDGET_MS, type HookBudgetKey } from "./hook-budgets.js";
import { probeCtxActive } from "./session-lifecycle.js";
import { runWithTurnContext } from "./turn-context.js";

function stableSessionId(ctx: unknown): string | undefined {
	try {
		return (
			ctx as
				| { sessionManager?: { getSessionId?: () => string } }
				| null
				| undefined
		)?.sessionManager?.getSessionId?.();
	} catch {
		recordDegradationOnce({
			kind: "turn-context-identity-fallback",
			subject: "session-event-guard",
			reason:
				"stable session identity resolution failed; using detached turn context",
		});
		return undefined;
	}
}

/**
 * The pi SDK invalidates a captured `pi`/command ctx after a session
 * replacement or reload; every later `pi.*` call then throws with this
 * signature. Matched by MESSAGE — not by `===` against a captured instance —
 * so a fire-and-forget task that races a session swap can recognise the benign
 * stale-ctx throw and degrade to a no-op. Substring-matched on the stable
 * "stale after session replacement or reload" phrase so it survives incidental
 * wording changes around it.
 *
 * Deliberately a NARROWER match than {@link probeCtxActive}'s (which accepts
 * the shorter "stale after session replacement", the message
 * `ExtensionRunner.invalidate()` uses for its own probe path). Widening this
 * one is a behavior change: it decides which throws get swallowed.
 */
export function isStaleExtensionCtxError(err: unknown): boolean {
	return (
		err instanceof Error &&
		err.message.includes("stale after session replacement or reload")
	);
}

/** Where the staleness was detected, for the record's metadata. */
type StaleDetectionPoint = "pre-dispatch" | "mid-handler";

/**
 * Record one skipped session event. Bounded per event name: the ledger counts
 * every occurrence exactly, and only the first per event name this session
 * also writes the detailed `latency.log` row, so a replaced session whose
 * queue drains a hundred stale events cannot storm the log.
 */
function recordStaleSkip(
	eventName: string,
	detectedAt: StaleDetectionPoint,
): void {
	emitBounded(
		"session_event_stale_ctx_skip",
		eventName,
		{
			durationMs: 0,
			metadata: { event: eventName, detectedAt },
		},
		{
			ledgerKind: "extension-ctx-stale",
			risingEdgePer: "identity",
			reason: `${eventName} skipped: extension ctx is stale (${detectedAt})`,
		},
	);
}

export interface SessionEventGuardOptions {
	/** pi-lens's debug sink, so a skip is also visible in a dogfood trace. */
	dbg?: (message: string) => void;
	/** Hook budget; a function is used for read-only versus edit tool_result. */
	budgetKey?:
		| HookBudgetKey
		| ((event: unknown, ctx: unknown) => HookBudgetKey | undefined);
	/** Keep a floating fire-and-forget rejection from terminating the host. */
	// Only surfaceHandlerCrash honors this option; event wrappers ignore it.
	rethrow?: boolean;
}

/**
 * The one policy for "a pi hook handler threw and production swallows it"
 * (#2884).
 *
 * Nine catch sites in `index.ts` absorb a crashed handler so a pi-lens bug
 * can never take down the host's session. Each of them used to write only
 * `dbg(...)`, and `dbg` writes nothing under vitest — so a crashed handler was
 * indistinguishable from a completed one. #2859 is what that costs: fourteen
 * `session_start` awaits in `tests/index-integration.test.ts` rejected into
 * one of those catches, every assertion after them was vacuous, and the file
 * stayed green. #2866 closed the hole for `session_start` with an inline
 * `if (process.env.VITEST) throw`; this function is that guard folded into one
 * place so the remaining eight cannot drift from it.
 *
 * Two things happen on every crash, in this order:
 *
 * 1. **The production record.** One bounded `hook-handler-crash` row per
 *    handler per session (`recordDegradationOnce`), so a handler that crashes
 *    on every turn leaves one durable row and an exact ledger tally instead of
 *    a silent no-op. It is written BEFORE the rethrow, so a test can assert the
 *    production observability the runner path would otherwise hide.
 * 2. **The runner rethrow.** Under vitest the crash is rethrown, so the test
 *    whose `await` caused it fails with the real error instead of resolving.
 *    In production nothing is rethrown and the caller's swallow stands.
 *
 * Deliberately `process.env.VITEST` and not `isTestMode()` (kept from #2859):
 * the question is whether a TEST is awaiting this handler, and the #2815 R7
 * case runs under vitest with `PI_LENS_TEST_MODE=0`.
 *
 * The stale-ctx class is NOT this function's business. Callers that classify
 * it (`session_start`, `agent_end`, `turn_end`, the `agent_settled` drain)
 * rethrow `isStaleExtensionCtxError` themselves BEFORE calling in, so a benign
 * session swap keeps its own single record and never lands here as a crash.
 * The quiet-window site is intentionally the exception to the test-runner
 * rethrow: it is fire-and-forget, so a rethrow would be an unhandled rejection
 * that can terminate the pi host before its caller can observe the failure.
 */
export function surfaceHandlerCrash(
	handler: string,
	err: unknown,
	options: SessionEventGuardOptions = {},
): void {
	try {
		options.dbg?.(`${handler} crashed: ${err}`);
		options.dbg?.(
			`${handler} crash stack: ${(err as Error | undefined)?.stack}`,
		);
	} catch {
		// A debug sink must never decide whether a crash is recorded.
	}
	recordDegradationOnce({
		kind: "hook-handler-crash",
		subject: handler,
		reason: `${handler} handler crashed and was swallowed: ${String(err)}`,
	});
	if (process.env.VITEST && options.rethrow !== false) throw err;
}

/** A pi event handler, in the shape `pi.on` delivers. */
type SessionEventHandler = (event: never, ctx: never) => unknown;

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof (value as { then?: unknown } | null | undefined)?.then === "function"
	);
}

/**
 * The one policy. Both public wrappers are this function with a different
 * stale-path value, so the probe point, the classification, and the record can
 * never drift apart between a void handler and a value-returning one.
 */
function guardSessionEvent<E, C, R>(
	eventName: string,
	handler: (event: E, ctx: C) => R,
	onStaleResult: (event: E) => Awaited<R>,
	options: SessionEventGuardOptions,
): (event: E, ctx: C) => R {
	const defaultBudgetKey = (eventName: string): HookBudgetKey | undefined => {
		if (eventName === "tool_result") return "tool_result_edit";
		if (
			eventName === "session_start" ||
			eventName === "turn_end" ||
			eventName === "agent_end" ||
			eventName === "agent_settled"
		)
			return eventName;
		return undefined;
	};
	const skip = (event: E, detectedAt: StaleDetectionPoint): Awaited<R> => {
		recordStaleSkip(eventName, detectedAt);
		try {
			options.dbg?.(
				`${eventName} skipped: extension ctx is stale after session replacement or reload`,
			);
		} catch {
			// A debug sink must never decide whether an event is handled.
		}
		return onStaleResult(event);
	};

	return (event: E, ctx: C): R => {
		// `false` is the only confirmed verdict. `undefined` means the probe
		// could not tell, and an inconclusive probe must dispatch.
		if (probeCtxActive(ctx) === false)
			// SAFETY: `R` is the handler's declared return type, which is either a
			// plain value or a promise of one. `skip` yields `Awaited<R>`, the
			// settled form. TypeScript cannot see that a host awaiting an `R` is
			// equally satisfied by the settled value, but every `pi.on` caller
			// either awaits the result or ignores it, so both forms behave the
			// same at the call site. The same reasoning covers the two casts
			// below.
			return skip(event, "pre-dispatch") as unknown as R;
		try {
			let signal: AbortSignal | undefined;
			try {
				signal = (ctx as { signal?: AbortSignal } | undefined)?.signal;
			} catch (err) {
				if (isStaleExtensionCtxError(err))
					return Promise.resolve(skip(event, "mid-handler")) as R;
				// The signal read moved out of each handler's own try/catch and
				// into the guard (#2523 hook budgets), so a ctx whose `signal`
				// accessor throws for a NON-stale reason is a crashed handler and
				// must leave the same record — and the same test-runner rethrow —
				// the handler's catch used to (#2884). In production
				// `surfaceHandlerCrash` swallows and the event resolves to its no-op
				// value. That parity holds for the handlers whose own catch did
				// this work (`session_start`, `agent_end`, `turn_end`, and the
				// `agent_settled` drain): `tool_result` has no catch (its
				// `try` only clears the ambient signal in `finally`), and the
				// `context` handler never reads `signal`, so for those two a
				// non-stale throw reached the host on master and is now
				// absorbed into a no-op plus one ledger row instead (#2939 F5).
				// #2939 F4: `options.rethrow` is NOT forwarded here. No wrapper
				// call site passes it (only the fire-and-forget `quiet_window`
				// direct call does), so the spread was dead plumbing — the
				// option's doc ("only surfaceHandlerCrash honors it") holds.
				surfaceHandlerCrash(eventName, err, {
					...(options.dbg === undefined ? {} : { dbg: options.dbg }),
				});
				return Promise.resolve(onStaleResult(event)) as R;
			}
			const result = runWithTurnContext(stableSessionId(ctx), () =>
				handler(event, ctx),
			);
			if (isThenable(result)) {
				const recovered = Promise.resolve(result).catch((err: unknown) => {
					if (isStaleExtensionCtxError(err)) return skip(event, "mid-handler");
					throw err;
				});
				const budget =
					typeof options.budgetKey === "function"
						? options.budgetKey(event, ctx)
						: (options.budgetKey ?? defaultBudgetKey(eventName));
				if (budget === undefined) return recovered as R;
				return bounded(recovered, {
					ms: HOOK_WALL_BUDGET_MS[budget],
					// The settled drain must observe an aborted signal and requeue
					// before its promise is released; its own workers read the same
					// signal and remain bounded at their seams.
					signal: budget === "agent_settled" ? undefined : signal,
					hook: budget,
					label: "registered-handler",
				}) as R;
			}
			return result;
		} catch (err) {
			if (isStaleExtensionCtxError(err))
				// SAFETY: a synchronous handler's `R` is already its settled form,
				// so `Awaited<R>` and `R` coincide here — see the note above.
				return skip(event, "mid-handler") as R;
			throw err;
		}
	};
}

/**
 * Wrap one `pi.on` handler so a stale ctx becomes an observable no-op instead
 * of a throw into the host.
 *
 * The returned function keeps the handler's own signature and its return
 * value, so a wrapped registration is a drop-in for the bare one. A skipped
 * event resolves to `undefined`, which is what every handler wrapped this way
 * already returns on its early-exit paths.
 *
 * Use {@link wrapSessionEventHandlerWithResult} when `undefined` is NOT the
 * handler's own no-op value.
 */
export function wrapSessionEventHandler<H extends SessionEventHandler>(
	eventName: string,
	handler: H,
	options: SessionEventGuardOptions = {},
): H {
	return guardSessionEvent<never, never, unknown>(
		eventName,
		handler,
		() => undefined,
		options,
	) as H;
}

export interface SessionEventResultGuardOptions<
	E,
	R,
> extends SessionEventGuardOptions {
	/**
	 * The value the host receives when the event is skipped. It takes the
	 * EVENT, never the ctx: the ctx is the thing that just proved dead, and
	 * reading it here would throw inside the guard that exists to absorb that
	 * throw.
	 *
	 * State the value deliberately per event. `context` returns `undefined`,
	 * pi's "this extension contributed nothing" answer, so the host keeps its
	 * own message list untouched — never a partially built injection.
	 */
	onStaleResult: (event: E) => Awaited<R>;
}

/**
 * {@link wrapSessionEventHandler} for a handler whose return value the host
 * consumes (#1929).
 *
 * The live path returns exactly what the handler returned. The stale path
 * returns `onStaleResult(event)` instead of assuming `undefined`, so a handler
 * whose no-op value is something else does not get one silently substituted.
 * Probe, classification, and the bounded record are identical to the void
 * wrapper's — they are the same function underneath.
 */
export function wrapSessionEventHandlerWithResult<E, C, R>(
	eventName: string,
	handler: (event: E, ctx: C) => R,
	options: SessionEventResultGuardOptions<E, R>,
): (event: E, ctx: C) => R {
	return guardSessionEvent(eventName, handler, options.onStaleResult, options);
}
