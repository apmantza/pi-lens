/**
 * Tests for the project-level rule policy matcher
 * (`clients/dispatch/rule-policy.ts`). Disable wins over select; rule ids
 * normalize the same way the inline suppression parser and dedup normalizer
 * do (`ast-grep:` prefix and `-js` suffix stripped). Returning the same
 * canonical form across the three surfaces keeps a single user-facing
 * `no-eval` entry from drifting across `inline-suppressions`, `disable`,
 * and dedup.
 */
import { describe, expect, it } from "vitest";
import {
	applyRulePolicy,
	evaluateRulePolicy,
	rulePolicyMapFromConfig,
} from "../../../clients/dispatch/rule-policy.js";

describe("rule-policy.matchesRule", () => {
	it("drops a normal rule id", () => {
		const policyMap = { "no-eval": { disable: ["no-eval"] } };
		expect(evaluateRulePolicy("no-eval", policyMap)).toEqual({ dropped: true });
	});

	it("drops a normalized rule id (ast-grep: prefix, -js suffix)", () => {
		const policyMap = { "no-eval": { disable: ["no-eval"] } };
		// A user lists `no-eval` once under disable; the LSP/napi variants
		// (`ast-grep:no-eval`, `no-eval-js`) must also be filtered.
		expect(evaluateRulePolicy("ast-grep:no-eval", policyMap)).toEqual({
			dropped: true,
		});
		expect(evaluateRulePolicy("no-eval-js", policyMap)).toEqual({
			dropped: true,
		});
	});

	it("drops when the entry list normalizes to the rule", () => {
		// User lists the LSP-prefixed form in `disable`; the bare id still
		// matches via normalization.
		const policyMap = { "no-eval": { disable: ["ast-grep:no-eval"] } };
		expect(evaluateRulePolicy("no-eval", policyMap)).toEqual({ dropped: true });
	});

	it("drops a shuck LSP diagnostic by its native code and by the rendered spelling (#3968)", () => {
		// The shuck LSP renders rule `shuck:C006`; a user disabling the native
		// code reaches it via the shared normalization (the rendered spelling
		// matches raw, the bare code matches normalized).
		const policyMap = { zot: { disable: ["C006"] } };
		expect(evaluateRulePolicy("shuck:C006", policyMap)).toEqual({
			dropped: true,
		});
		expect(evaluateRulePolicy("C006", policyMap)).toEqual({ dropped: true });
	});

	it("does NOT drop a different rule", () => {
		const policyMap = { "no-eval": { disable: ["no-eval"] } };
		expect(evaluateRulePolicy("no-debugger", policyMap)).toEqual({
			dropped: false,
		});
	});

	it("does NOT drop a rule that is absent from every disable list", () => {
		// Neither the key nor the list names `no-eval`. Matching is list-based,
		// so the unrelated `unused-vars` key is irrelevant either way.
		const policyMap = { "unused-vars": { disable: ["no-unused-vars"] } };
		expect(evaluateRulePolicy("no-eval", policyMap)).toEqual({
			dropped: false,
		});
	});

	it("keeps a rule with no policy (empty policyMap)", () => {
		expect(evaluateRulePolicy("no-eval", undefined)).toEqual({
			dropped: false,
		});
		expect(evaluateRulePolicy("no-eval", {})).toEqual({ dropped: false });
	});

	it("does not match a partial rule id (substring)", () => {
		// `no-eval-fallback` is NOT the same rule as `no-eval` — the matcher
		// must be exact, not substring containment.
		const policyMap = { "no-eval": { disable: ["no-eval"] } };
		expect(evaluateRulePolicy("no-eval-fallback", policyMap)).toEqual({
			dropped: false,
		});
	});
});

describe("rule-policy.select", () => {
	it("drops when no entry matches in select", () => {
		const policyMap = { "no-eval": { select: ["no-debugger"] } };
		expect(evaluateRulePolicy("no-eval", policyMap)).toEqual({ dropped: true });
	});

	it("keeps when an entry matches in select", () => {
		const policyMap = { "no-eval": { select: ["no-eval", "no-debugger"] } };
		expect(evaluateRulePolicy("no-eval", policyMap)).toEqual({
			dropped: false,
		});
	});

	it("matches normalized rule ids in select", () => {
		const policyMap = { "no-eval": { select: ["no-eval"] } };
		expect(evaluateRulePolicy("no-eval-js", policyMap)).toEqual({
			dropped: false,
		});
	});

	it("treats an empty select list as 'no restriction' (does NOT drop)", () => {
		// No `select` entries at all → no allowlist filter → keep everything.
		const policyMap = { "no-eval": { select: [] } };
		expect(evaluateRulePolicy("no-eval", policyMap)).toEqual({
			dropped: false,
		});
	});
});

describe("rule-policy.-js suffix conflation (documented, not a bug)", () => {
	it("a disable naming the stem also drops a distinct rule literally named '<stem>-js'", () => {
		// `prefer` and `prefer-js` are two different rules, but both normalize
		// to "prefer". Disabling the stem catches the -js-suffixed rule too —
		// deliberate side effect of the shared napi/LSP-variant normalization,
		// documented in rule-id-normalize.ts and docs/globalconfig.md.
		const policyMap = { prefer: { disable: ["prefer"] } };
		expect(evaluateRulePolicy("prefer-js", policyMap)).toEqual({
			dropped: true,
		});
	});

	it("a select naming the stem also keeps a distinct rule literally named '<stem>-js'", () => {
		const policyMap = { prefer: { select: ["prefer"] } };
		expect(evaluateRulePolicy("prefer-js", policyMap)).toEqual({
			dropped: false,
		});
	});

	it("a disable naming the -js-suffixed rule also drops the unrelated stem rule (conflation is symmetric)", () => {
		const policyMap = { prefer: { disable: ["prefer-js"] } };
		expect(evaluateRulePolicy("prefer", policyMap)).toEqual({ dropped: true });
	});

	it("an exactly-spelled -js entry still matches its own rule", () => {
		// The conflation above is one-way noise, not a hole: listing the -js id
		// verbatim still drops the rule that carries that exact id.
		const policyMap = { prefer: { disable: ["prefer-js"] } };
		expect(evaluateRulePolicy("prefer-js", policyMap)).toEqual({
			dropped: true,
		});
	});
});

describe("rule-policy.disable-wins-select", () => {
	it("drops a rule on both disable and select lists", () => {
		// Explicit exclusion overrides explicit inclusion.
		const policyMap = {
			"no-eval": { disable: ["no-eval"], select: ["no-eval"] },
		};
		expect(evaluateRulePolicy("no-eval", policyMap)).toEqual({ dropped: true });
	});

	it("drops a rule with disable match even if select has a non-matching entry", () => {
		const policyMap = {
			"no-eval": { disable: ["no-eval"], select: ["no-debugger"] },
		};
		expect(evaluateRulePolicy("no-eval", policyMap)).toEqual({ dropped: true });
	});
});

describe("rule-policy.project-wide matching", () => {
	it("a grouping key's disable list drops rules that don't share its name", () => {
		// The outer key ("security") is a label only — it does not gate which
		// rules the disable list under it can match.
		const policyMap = {
			security: { disable: ["no-eval", "no-new-func"] },
		};
		expect(evaluateRulePolicy("no-eval", policyMap)).toEqual({ dropped: true });
		expect(evaluateRulePolicy("no-new-func", policyMap)).toEqual({
			dropped: true,
		});
		expect(evaluateRulePolicy("no-debugger", policyMap)).toEqual({
			dropped: false,
		});
	});

	it("a select list under an unrelated key restricts every rule project-wide", () => {
		const policyMap = {
			"my-rule-set": { select: ["rule-a", "rule-b"] },
		};
		expect(evaluateRulePolicy("rule-a", policyMap)).toEqual({ dropped: false });
		expect(evaluateRulePolicy("rule-b", policyMap)).toEqual({ dropped: false });
		expect(evaluateRulePolicy("rule-c", policyMap)).toEqual({ dropped: true });
	});

	it("a select list does not drop a diagnostic that carries no rule id", () => {
		// `Diagnostic.id` is a dedup key (`eslint:unknown:12`), not a rule id, so
		// a rule-less finding must not be measured against the allowlist — an
		// eslint parse error is blocking and has no ruleId.
		const diagnostics = [
			{ rule: "rule-a" },
			{ id: "eslint:unknown:12" },
			{ rule: "rule-c" },
		];
		const policyMap = { "my-rule-set": { select: ["rule-a"] } };
		const result = applyRulePolicy(diagnostics, policyMap, {
			root: "/project",
			filePath: "/project/a.ts",
		});
		expect(result).toEqual([{ rule: "rule-a" }, { id: "eslint:unknown:12" }]);
	});

	it("disable wins across keys regardless of insertion order", () => {
		const policyMap = {
			a: { select: ["no-eval"] },
			b: { disable: ["no-eval"] },
		};
		expect(evaluateRulePolicy("no-eval", policyMap)).toEqual({ dropped: true });

		const reversed = {
			b: { disable: ["no-eval"] },
			a: { select: ["no-eval"] },
		};
		expect(evaluateRulePolicy("no-eval", reversed)).toEqual({ dropped: true });
	});
});

describe("rule-policy.applyRulePolicy", () => {
	it("drops matching diagnostics", () => {
		const diagnostics = [
			{ rule: "no-eval" },
			{ rule: "no-debugger" },
			{ rule: "ast-grep:no-eval" },
		];
		const policyMap = { "no-eval": { disable: ["no-eval"] } };
		const result = applyRulePolicy(diagnostics, policyMap, {
			root: "/project",
			filePath: "/project/a.ts",
		});
		expect(result.map((d) => d.rule)).toEqual(["no-debugger"]);
	});

	it("keeps diagnostics without a recognizable rule id", () => {
		const diagnostics = [
			{ rule: "no-eval" }, // rule matches disable list → dropped
			{ id: "anonymous" }, // no rule or code, has id — kept untouched
			{}, // no rule or code at all — kept untouched
		];
		const policyMap = { "no-eval": { disable: ["no-eval"] } };
		const result = applyRulePolicy(diagnostics, policyMap, {
			root: "/project",
			filePath: "/project/a.ts",
		});
		expect(result).toHaveLength(2);
		// The first element should be the id-only diagnostic (no rule or code).
		expect(result[0]).toEqual({ id: "anonymous" });
		expect(result[1]).toEqual({});
	});

	it("uses a code-only diagnostic as its policy key", () => {
		const diagnostics = [{ code: "no-eval" }, { code: "no-debugger" }];
		const policyMap = { "no-eval": { disable: ["no-eval"] } };
		const result = applyRulePolicy(diagnostics, policyMap, {
			root: "/project",
			filePath: "/project/a.ts",
		});
		expect(result).toEqual([{ code: "no-debugger" }]);
	});

	it("returns the same array reference when no policy applies", () => {
		// Fast-path: no entries with disable/select → no-op identity.
		const diagnostics = [{ rule: "no-eval" }, { rule: "no-debugger" }];
		const policyMap = { "high-complexity": { threshold: 25 } };
		const result = applyRulePolicy(diagnostics, policyMap, {
			root: "/project",
			filePath: "/project/a.ts",
		});
		expect(result).toBe(diagnostics);
	});

	it("returns the same array when policyMap is undefined", () => {
		const diagnostics = [{ rule: "no-eval" }];
		const result = applyRulePolicy(diagnostics, undefined, {
			root: "/project",
			filePath: "/project/a.ts",
		});
		expect(result).toBe(diagnostics);
	});

	it("applies the policy through a mixed map with the threshold-only entry first", () => {
		// `rulePolicyMapFromConfig` always strips threshold-only entries before
		// calling `applyRulePolicy`, but the function also gets raw config maps
		// directly. The `hasFilter` scan must not stop at the first (threshold-
		// only) entry and wrongly treat the whole map as filter-free.
		const diagnostics = [{ rule: "no-eval" }, { rule: "no-debugger" }];
		const policyMap = {
			"high-complexity": { threshold: 25 },
			"no-eval": { disable: ["no-eval"] },
		};
		const result = applyRulePolicy(diagnostics, policyMap, {
			root: "/project",
			filePath: "/project/a.ts",
		});
		expect(result.map((d) => d.rule)).toEqual(["no-debugger"]);
	});

	it("applies the policy through a mixed map with the policy entry first", () => {
		const diagnostics = [{ rule: "no-eval" }, { rule: "no-debugger" }];
		const policyMap = {
			"no-eval": { disable: ["no-eval"] },
			"high-complexity": { threshold: 25 },
		};
		const result = applyRulePolicy(diagnostics, policyMap, {
			root: "/project",
			filePath: "/project/a.ts",
		});
		expect(result.map((d) => d.rule)).toEqual(["no-debugger"]);
	});

	it("disabling one rule does not affect rules absent from the list", () => {
		const diagnostics = [
			{ rule: "no-eval" },
			{ rule: "no-debugger" },
			{ rule: "no-alert" },
		];
		const policyMap = { "no-eval": { disable: ["no-eval"] } };
		const result = applyRulePolicy(diagnostics, policyMap, {
			root: "/project",
			filePath: "/project/a.ts",
		});
		expect(result.map((d) => d.rule)).toEqual(["no-debugger", "no-alert"]);
	});
});

describe("rule-policy.rulePolicyMapFromConfig", () => {
	it("returns undefined when no rules have policy fields", () => {
		// Threshold-only entries are excluded — no filter work, so the
		// hot path returns undefined to bail out early.
		expect(
			rulePolicyMapFromConfig({
				"high-complexity": { threshold: 25 },
				"high-fan-out": { threshold: 30 },
			}),
		).toBeUndefined();
	});

	it("returns undefined when rules is undefined", () => {
		expect(rulePolicyMapFromConfig(undefined)).toBeUndefined();
	});

	it("includes policy entries only", () => {
		const map = rulePolicyMapFromConfig({
			"high-complexity": { threshold: 25 },
			"no-eval": { disable: ["no-eval"] },
		});
		expect(map).toBeDefined();
		expect(Object.keys(map!)).toEqual(["no-eval"]);
		expect(map!["no-eval"]).toEqual({ disable: ["no-eval"] });
	});

	it("preserves both disable and select on a single entry", () => {
		const map = rulePolicyMapFromConfig({
			"no-eval": { disable: ["no-eval"], select: ["no-eval"] },
		});
		expect(map).toEqual({
			"no-eval": { disable: ["no-eval"], select: ["no-eval"] },
		});
	});
});
