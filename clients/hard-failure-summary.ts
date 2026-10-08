/**
 * Whether a scanner run died to its own timeout or a kill (#1467): the one
 * rule every back-off reads. A pure leaf, so `runtime-turn.ts` can import it
 * without pulling a client's awaits into the hook-await one-hop pin set.
 *
 * Readers (#3872 r3): `KnipClient` stamps a root when its scan settles,
 * turn_end's knip lane skips a root whose cached row failed this way, and the
 * dead-code lane does the same for its own rows. They must agree: a wording
 * one of them misses brings back a heavyweight scan every turn.
 */
export function isHardFailureSummary(summary: string): boolean {
	return /(timed out|killed|SIGTERM|SIGKILL|SIGABRT)/i.test(summary);
}

/**
 * How long a root whose scan died to a timeout or a kill is skipped (#1467,
 * #4117): a client stamps it where the scan settles, so a scan turn_end
 * abandoned at its budget still leaves the failure the next turns must see.
 */
export const HARD_FAILURE_BACKOFF_MS = 30 * 60 * 1000;

/**
 * The per-root back-off both heavyweight scan clients keep (knip, vulture),
 * one implementation: `settle` where a scan settles, `recent` where turn_end
 * decides whether to start another, `clear` at a session boundary.
 */
export class HardFailureStamps {
	private readonly stamps = new Map<string, { at: number; summary: string }>();

	/** A success lifts the root's stamp; a timeout or kill sets it. */
	settle(key: string, result: { success: boolean; summary: string }): void {
		if (result.success) this.stamps.delete(key);
		else if (isHardFailureSummary(result.summary)) {
			this.stamps.set(key, { at: Date.now(), summary: result.summary });
		}
	}

	/** The summary of the root's last timeout or kill while it is recent; `null` otherwise. */
	recent(key: string): string | null {
		const stamp = this.stamps.get(key);
		if (!stamp) return null;
		if (Date.now() - stamp.at > HARD_FAILURE_BACKOFF_MS) {
			this.stamps.delete(key);
			return null;
		}
		return stamp.summary;
	}

	clear(): void {
		this.stamps.clear();
	}
}
