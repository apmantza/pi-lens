/**
 * Environment / config input helpers.
 *
 * Small, dependency-free utilities used by logger modules and runtime tuning
 * knobs to keep duplicated env-handling expressions in a single place.
 */

/**
 * True when pi-lens should suppress side-effecting log writes — e.g. inside
 * the vitest test runner, or when callers explicitly set `PI_LENS_TEST_MODE=1`.
 *
 * Resolution:
 *   - `PI_LENS_TEST_MODE === "1"` → true (explicit opt-in)
 *   - `VITEST` set and `PI_LENS_TEST_MODE !== "0"` → true (vitest default, with explicit opt-out)
 *   - otherwise false
 *
 * Replaces the boolean previously duplicated verbatim in ~10 logger modules.
 */
export function isTestMode(): boolean {
	if (process.env.PI_LENS_TEST_MODE === "1") return true;
	if (process.env.VITEST && process.env.PI_LENS_TEST_MODE !== "0") return true;
	return false;
}

/**
 * Coerce an arbitrary input to a non-negative finite number, or 0 otherwise.
 *
 * Use this to gate config / env values before they flow into `Math.max` /
 * `Math.min` / `setTimeout`. `Number(undefined)` is `NaN`, and a single NaN
 * argument makes `Math.max` return NaN, which `setTimeout` silently treats
 * as 0 — see the runner-timeout-floor regression caught in PR #109.
 *
 * @example
 * ```ts
 * const floor = Math.max(
 *   toPositiveFinite(process.env.PI_LENS_KNOB_MS),
 *   toPositiveFinite(loadedConfig?.knobMs),
 *   0,
 * );
 * ```
 */
export function toPositiveFinite(value: unknown): number {
	const num = typeof value === "number" ? value : Number(value);
	return Number.isFinite(num) && num > 0 ? num : 0;
}

/**
 * Factory for the lazy-memoized "positive-finite-number env override, else a
 * default" getter pattern repeated across `startup-scan.ts` (#699, #758) and
 * originally documented as house style in `runtime-config.ts` / `slow-fs.ts` /
 * `subagent-mode.ts` (#763).
 *
 * `get()` reads `process.env[envName]` through {@link toPositiveFinite} the
 * first time it's called, memoizes the result (or `fallback` when the env var
 * is unset/non-finite/non-positive), and returns the memo on every subsequent
 * call. `_resetForTests()` clears the memo so a test can flip the env var and
 * observe a fresh read (matching the existing `_resetForTests` convention).
 *
 * Deliberately does NOT touch `process.env` until `get()` is first called —
 * that's the entire point of the lazy pattern: importing a module must never
 * have a side effect on process env at load time.
 *
 * @example
 * ```ts
 * const _ttl = lazyEnvNumber("PI_LENS_STARTUP_SCAN_VERDICT_TTL_MS", DEFAULT_TTL_MS);
 * export const getStartupScanVerdictTtlMs = _ttl.get;
 * export const _resetStartupScanVerdictTtlForTests = _ttl._resetForTests;
 * ```
 */
export function lazyEnvNumber(
	envName: string,
	fallback: number,
): { get(): number; _resetForTests(): void } {
	let memo: number | undefined;
	return {
		get(): number {
			if (memo !== undefined) return memo;
			const envValue = toPositiveFinite(process.env[envName]);
			memo = envValue > 0 ? envValue : fallback;
			return memo;
		},
		_resetForTests(): void {
			memo = undefined;
		},
	};
}
