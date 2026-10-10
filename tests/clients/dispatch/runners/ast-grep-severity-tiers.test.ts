// #1777: the dispatch path must carry a rule's YAML severity through to
// `Diagnostic.severity` for all four tiers (error/warning/hint/info). Before
// the fix, `clients/dispatch/runners/ast-grep-napi.ts` collapsed
// warning/hint/info to "warning", so the hint tier the #1727 anti-slop rules
// were designed around did not exist downstream.
//
// The blocking gate is deliberately NOT widened: only `error` maps to semantic
// "blocking"; hint and info stay non-blocking exactly like warning.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	dispatchForFile,
	RunnerRegistry,
} from "../../../../clients/dispatch/dispatcher.js";
import astGrepNapiRunner from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import type { Diagnostic } from "../../../../clients/dispatch/types.js";
import {
	makeRealRunnerEnv,
	napiFallbackHasTool,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

vi.mock("../../../../clients/lsp/wait-policy/index.js", () => ({
	resolveAstGrepNativeExe: () => undefined,
}));

/** One project rule per tier, each matching a distinct, unambiguous call. */
const TIER_RULES: Array<{ id: string; severity: string; call: string }> = [
	{ id: "sev1777-error-tier", severity: "error", call: "tierError" },
	{ id: "sev1777-warning-tier", severity: "warning", call: "tierWarning" },
	{ id: "sev1777-hint-tier", severity: "hint", call: "tierHint" },
	{ id: "sev1777-info-tier", severity: "info", call: "tierInfo" },
];

let env: RealRunnerEnv;

beforeAll(() => {
	env = makeRealRunnerEnv({ hasTool: napiFallbackHasTool });
	const rulesDir = path.join(env.cwd, "rules", "ast-grep-rules", "rules");
	fs.mkdirSync(rulesDir, { recursive: true });
	for (const rule of TIER_RULES) {
		fs.writeFileSync(
			path.join(rulesDir, `${rule.id}.yml`),
			[
				`id: ${rule.id}`,
				"language: typescript",
				`severity: ${rule.severity}`,
				`message: ${rule.id} fired`,
				"rule:",
				`  pattern: ${rule.call}($ARG)`,
				"",
			].join("\n"),
			"utf8",
		);
	}
});

afterAll(() => env.cleanup());

const FIXTURE = TIER_RULES.map((rule) => `${rule.call}(1);`).join("\n");

async function runTiers(): Promise<Map<string, Diagnostic>> {
	const { ctx } = env.addFile("src/tiers.ts", `${FIXTURE}\n`);
	const result = await astGrepNapiRunner.run(ctx);
	const byRule = new Map<string, Diagnostic>();
	for (const diagnostic of result.diagnostics) {
		if (diagnostic.rule && !byRule.has(diagnostic.rule)) {
			byRule.set(diagnostic.rule, diagnostic);
		}
	}
	return byRule;
}

describe("ast-grep-napi preserves all four rule severity tiers (#1777)", () => {
	it("fires every tier rule, so the tier assertions are not vacuous", async () => {
		const byRule = await runTiers();
		expect(TIER_RULES.map((rule) => byRule.has(rule.id))).toEqual([
			true,
			true,
			true,
			true,
		]);
	});

	// Mutation guard: reinstating the `=== "error" ? "error" : "warning"`
	// collapse reds the hint and info cases here, one assertion per tier.
	it.each(TIER_RULES)(
		"carries $severity through to Diagnostic.severity",
		async (rule) => {
			const byRule = await runTiers();
			expect(byRule.get(rule.id)?.severity).toBe(rule.severity);
		},
	);

	it("keeps the blocking gate on error alone", async () => {
		const byRule = await runTiers();
		expect(byRule.get("sev1777-error-tier")?.semantic).toBe("blocking");
		for (const rule of TIER_RULES.filter((r) => r.severity !== "error")) {
			expect(byRule.get(rule.id)?.semantic).toBe("warning");
		}
	});

	it("gives only the error tier a default fix suggestion", async () => {
		// `fixSuggestion` falls back to a generated suggestion for blocking
		// diagnostics only. Widening "blocking" to hint/info would light this up.
		const byRule = await runTiers();
		for (const rule of TIER_RULES.filter((r) => r.severity !== "error")) {
			expect(byRule.get(rule.id)?.fixSuggestion).toBeUndefined();
		}
	});

	it("keeps throw Error style findings non-blocking through dispatch (#4240)", async () => {
		const registry = new RunnerRegistry();
		registry.register(astGrepNapiRunner);
		const projectRoot = path.resolve(process.cwd());

		for (const [extension, rule] of [
			["ts", "throw-new-error"],
			["js", "throw-new-error-js"],
		] as const) {
			const { ctx } = env.addFile(
				`throw-error.${extension}`,
				'export function a() { throw Error("x"); }\n',
				{ projectRoot },
			);
			const result = await dispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: [astGrepNapiRunner.id] }],
				registry,
			);
			const finding = result.diagnostics.find(
				(diagnostic) => diagnostic.rule === rule,
			);
			expect(finding).toMatchObject({
				rule,
				severity: "warning",
				semantic: "warning",
			});
		}
	});
});
