/**
 * Generalized debounced-persist coalescing scheduler (#348 phase 2), factored
 * out of the review graph's #260 circuit-breaker so a second warm cache
 * (the word index) doesn't grow a parallel copy of the same discipline:
 *   1. Coalesce: a burst of edits schedules ONE write after a quiet window,
 *      instead of one write per edit.
 *   2. Best-effort teardown flush: a process-exit hook flushes any pending
 *      writes synchronously so a debounced payload is never silently lost.
 *
 * What stayed OUT of this module (left to each caller, deliberately not
 * generalized): the actual serialize+write. The review graph writes its own
 * cache file (tmp+rename, size-cap check, git-stamp) while the word index
 * merges into the shared project-snapshot file via `saveProjectSnapshot`
 * (preserving unrelated fields, honoring the seq-laundering guard). Those
 * writers are different enough (different files, different merge semantics)
 * that forcing them through one write function would either leak
 * graph-specific concerns into the snapshot path or vice versa. The
 * scheduler only owns "when", never "how".
 */

export interface DebounceScheduler<T> {
	/** Replace the pending payload for `key` and (re)schedule its flush. */
	schedule(key: string, payload: T): void;
	/** Force-flush a pending payload for `key`, if any (test hook). */
	flush(key: string): void;
	/** Force-flush every pending payload (test hook / process-exit hook). */
	flushAll(): void;
}

/**
 * Build a debounce scheduler over `write(key, payload)`. `debounceMs()` is
 * read fresh on every schedule call (not captured once) so a test that
 * flips its env override mid-run takes effect immediately, same as the
 * graph's `graphPersistDebounceMs()`.
 */
export function createDebounceScheduler<T>(args: {
	write: (key: string, payload: T) => void;
	debounceMs: () => number;
}): DebounceScheduler<T> {
	const { write, debounceMs } = args;
	const pending = new Map<string, T>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	function flush(key: string): void {
		const payload = pending.get(key);
		if (payload === undefined) return;
		pending.delete(key);
		const timer = timers.get(key);
		if (timer) {
			clearTimeout(timer);
			timers.delete(key);
		}
		write(key, payload);
	}

	function flushAll(): void {
		for (const key of [...pending.keys()]) flush(key);
	}

	function schedule(key: string, payload: T): void {
		pending.set(key, payload);
		const debounce = debounceMs();
		const existing = timers.get(key);
		if (existing) clearTimeout(existing);
		if (debounce === 0) {
			flush(key);
			return;
		}
		const timer = setTimeout(() => flush(key), debounce);
		// Don't keep the event loop alive solely for a debounced write.
		if (typeof timer.unref === "function") timer.unref();
		timers.set(key, timer);
	}

	return { schedule, flush, flushAll };
}
