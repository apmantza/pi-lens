// Generic bounded-retry-with-backoff loop, factored out so
// scripts/resolve-newest-in-range-host.mjs (`npm view`, capturing JSON) and
// scripts/npm-retry.mjs (`npm ci`/`npm install`, passthrough stdio) share ONE
// retry/backoff CONTROL FLOW instead of two hand-copied loops — the same
// attempts/backoff shape scripts/audit-prod-deps.mjs (#2579) established for
// the production-dependency audit step (#2613 review S3a).
//
// `sleep` is an injected dependency (not `node:timers/promises` called
// directly) so a test can pass an instant no-op sleep and prove the retry
// COUNT/short-circuit behavior without a single real wall-clock wait —
// keeping this file's own flake-shape footprint at zero.

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @template T
 * @param {(attempt: number) => Promise<{ ok: true, value: T } | { ok: false, reason: string, retryable?: boolean }>} attemptFn
 * @param {{ attempts?: number, backoffMs?: number[], sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<{ ok: true, value: T, attempt: number } | { ok: false, reasons: string[] }>}
 */
export async function retryWithBackoff(attemptFn, opts = {}) {
	const attempts = opts.attempts ?? 3;
	const backoffMs = opts.backoffMs ?? [0, 5_000, 15_000];
	const sleep = opts.sleep ?? defaultSleep;

	const reasons = [];
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (backoffMs[attempt]) await sleep(backoffMs[attempt]);
		const result = await attemptFn(attempt);
		if (result.ok) return { ok: true, value: result.value, attempt };
		reasons.push(result.reason);
		if (result.retryable === false) break;
	}
	return { ok: false, reasons };
}
