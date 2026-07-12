/**
 * Generic "only proceed if this token is >= the last-seen token for this
 * key" guard, for per-key caches fed by concurrent, possibly-out-of-order
 * writers.
 *
 * Same race class as #555 (`clients/lsp/client.ts`'s `isSupersededPush`
 * guard on `publishDiagnostics`): pi-lens deliberately allows concurrent
 * pipeline runs for the SAME file across DIFFERENT same-turn edits (dedupe
 * key is `filePath + contentHash`, not just `filePath` — see
 * `clients/runtime-tool-result.ts`). If an OLDER edit's pipeline is slower
 * than a NEWER edit's pipeline, the older edit's write can land after the
 * newer one and silently overwrite it — a per-key cache with no ordering
 * check serves the stale result as "current" until some later write (if
 * any) corrects it.
 *
 * This module extracts that guard shape into a small, reusable, non-
 * diagnostics-specific primitive so a second (or third) call site with the
 * same race doesn't need to re-derive or duplicate the check. `clients/lsp/
 * client.ts`'s already-merged #555 fix is inline and deliberately left
 * alone — this is additive, for new call sites (starting with
 * `clients/widget-state.ts`'s `recordDiagnostics`).
 *
 * A `undefined` token means "no ordering information available" — the write
 * is always allowed through and does not update the last-seen token (mirrors
 * the existing, deliberate version-less-server tradeoff in the LSP client:
 * callers that can't supply an ordering token aren't penalized).
 */
export class WriteOrderingGuard<K, T extends number = number> {
	private readonly lastSeen = new Map<K, T>();

	/**
	 * Returns `true` if a write with `token` for `key` should proceed, and
	 * `false` if it's superseded (a write with a higher token for the same
	 * key was already recorded) and should be dropped.
	 *
	 * On `true` with a defined `token`, records it as the new last-seen value
	 * for `key` — including on a tie (a write whose token matches the last
	 * recorded one is not superseded, and re-recording the same token is a
	 * no-op either way). The very first write for a key always proceeds
	 * (nothing to compare against yet).
	 */
	shouldWrite(key: K, token: T | undefined): boolean {
		if (token === undefined) return true;
		const last = this.lastSeen.get(key);
		if (last !== undefined && token < last) return false;
		this.lastSeen.set(key, token);
		return true;
	}

	/** Drop tracked ordering state for `key` (e.g. on cache eviction). */
	delete(key: K): void {
		this.lastSeen.delete(key);
	}

	/** Drop all tracked ordering state. */
	clear(): void {
		this.lastSeen.clear();
	}
}
