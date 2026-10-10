/**
 * #2523: the per-hook budget table states a CONTRACT, so what is tested here
 * is the contract's shape, not the literals. Re-typing the numbers into an
 * assertion would make this a change-detector that fails whenever a budget is
 * deliberately tuned, while catching none of the ways the table can actually
 * be wrong.
 */

import { describe, expect, it } from "vitest";
import {
	HOOK_BUDGET_KEYS,
	HOOK_WALL_BUDGET_MS,
	type HookBudgetKey,
	isHookBudgetKey,
} from "../../clients/hook-budgets.js";

/** Hooks #2523's contract says may not await at ALL. */
const NO_AWAIT_HOOKS: HookBudgetKey[] = [
	"turn_start",
	"session_shutdown",
	"context",
	"session_before_fork",
];

describe("#2523 per-hook wall budgets", () => {
	it("declares a finite, non-negative budget for every hook family", () => {
		expect(HOOK_BUDGET_KEYS.length).toBeGreaterThanOrEqual(10);
		for (const key of HOOK_BUDGET_KEYS) {
			const budget = HOOK_WALL_BUDGET_MS[key];
			expect(Number.isFinite(budget), `${key} budget is not finite`).toBe(true);
			expect(budget, `${key} budget is negative`).toBeGreaterThanOrEqual(0);
		}
	});

	it("keeps the `may not await` hooks at zero", () => {
		for (const key of NO_AWAIT_HOOKS) {
			expect(HOOK_WALL_BUDGET_MS[key], `${key} must not await`).toBe(0);
		}
	});

	it("keeps the quit-only shutdown amendment distinct from replacement shutdown", () => {
		expect(HOOK_WALL_BUDGET_MS.session_shutdown).toBe(0);
		expect(HOOK_WALL_BUDGET_MS.session_shutdown_quit).toBeGreaterThan(0);
	});

	it("lets only the edit path block the host longer than a read-only one", () => {
		// The contract's one substantive ordering claim: an edit is the only
		// thing the host may legitimately be made to wait on, so every other
		// budget is smaller than the edit budget, and the read-only tool_result
		// budget — the hook that fires for Read/Grep/Glob/Bash — is the
		// smallest non-zero one.
		const edit = HOOK_WALL_BUDGET_MS.tool_result_edit;
		const readOnly = HOOK_WALL_BUDGET_MS.tool_result_read_only;
		expect(readOnly).toBeGreaterThan(0);
		expect(readOnly).toBeLessThan(edit);
		for (const key of HOOK_BUDGET_KEYS) {
			expect(
				HOOK_WALL_BUDGET_MS[key],
				`${key} may not outlast the edit budget`,
			).toBeLessThanOrEqual(edit);
			const budget = HOOK_WALL_BUDGET_MS[key];
			if (budget > 0) expect(budget).toBeGreaterThanOrEqual(readOnly);
		}
	});

	it("is frozen, and answers `is this a declared hook` for a sweep", () => {
		expect(Object.isFrozen(HOOK_WALL_BUDGET_MS)).toBe(true);
		expect(isHookBudgetKey("turn_end")).toBe(true);
		expect(isHookBudgetKey("off-hook")).toBe(false);
		// `Object.hasOwn`, never `in`: a key named `toString` or `constructor`
		// must not answer true off the prototype chain (#1755 review F1).
		expect(isHookBudgetKey("toString")).toBe(false);
		expect(isHookBudgetKey("constructor")).toBe(false);
	});
});
