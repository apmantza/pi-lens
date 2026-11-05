import type { FactRule } from "./fact-provider-types.js";
import type { Diagnostic, DispatchContext } from "./types.js";

const rules: FactRule[] = [];

export function registerRule(r: FactRule): void {
	rules.push(r);
}

export function clearRules(): void {
	rules.length = 0;
}

/** Read the live rule registry: the array `evaluateRules` walks. */
export function listRules(): readonly FactRule[] {
	return rules;
}

export function evaluateRules(ctx: DispatchContext): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const rule of rules) {
		if (!rule.appliesTo(ctx)) continue;
		const results = rule.evaluate(ctx, ctx.facts);
		diagnostics.push(...results);
	}
	return diagnostics;
}
