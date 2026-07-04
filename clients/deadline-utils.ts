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
		s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
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
	options: { ms?: number; deadlineAt?: number; onTimeout?: "reject"; onReject?: "propagate" },
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

	// Past deadline / non-positive budget: settle immediately, no timer.
	if (ms <= 0) {
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
