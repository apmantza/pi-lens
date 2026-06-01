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
