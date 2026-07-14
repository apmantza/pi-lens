import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { createTempFile, setupTestEnvironment } from "../../test-utils.js";

const RULES_DIR = path.join(process.cwd(), "rules", "ast-grep-rules", "rules");

// Regression coverage for #663: the ast-grep NAPI fallback runner's native
// `findAll` config only ever passed `{ rule, constraints }`, silently
// dropping a rule's top-level `utils:` block (reusable named matchers
// referenced via `matches: <name>` inside `rule`/`constraints` — standard
// ast-grep YAML syntax). With `utils` dropped, `matches: <name>` can't
// resolve, so `findAll` either throws (swallowed by the runner's
// `try { ... } catch { matches = []; }`) or returns zero matches. Net
// effect: a rule using `utils:` produced zero diagnostics, silently.
//
// 5 shipped rules declare `utils:`:
//   no-dupe-class-members, no-dupe-keys, no-dupe-keys-js,
//   rust-2024-let-chain-candidate, unnecessary-react-hook
//
// Three of the five (no-dupe-keys / no-dupe-keys-js / no-dupe-class-members)
// run through the runner's full front door unblocked by any other gate, so
// those are exercised via the real `runner.run()` path (same helper style
// as ast-grep-sonar-rules.test.ts). `no-dupe-class-members` used to be
// listed in the runner's TREE_SITTER_OVERLAP skip-set (skipped in favor of
// the tree-sitter runner), which #660 removed as its own separate fix —
// this rule is verified end to end through the real runner now that that
// gate is gone.
//
// The remaining two hit UNRELATED pre-existing gates inside the same
// runner before the utils fix would ever matter:
//   - unnecessary-react-hook is `language: Tsx`, and the runner's language
//     filter only passes through "typescript"/"javascript" rule tags
//   - rust-2024-let-chain-candidate is `language: Rust`; the @ast-grep/napi
//     build this repo ships doesn't even expose a Rust parser (its `Lang`
//     enum is Html/JavaScript/Tsx/Css/TypeScript only) — Rust rules run via
//     the ast-grep CLI/LSP only, already covered by
//     ast-grep-catalog-rules.test.ts's CLI-based fixtures.
// Those two are instead verified directly against napi's native engine —
// parsing the ACTUAL shipped rule YAML and calling the real `findAll` with
// the same `{ rule, constraints, utils }` shape the fixed
// `ast-grep-napi.ts` now builds — which isolates the utils-passthrough
// fix from those unrelated gates while still exercising the real NAPI
// engine end to end.

const cleanups: Array<() => void> = [];
afterAll(() => {
	for (const c of cleanups) c();
});

async function rulesFiredOn(
	code: string,
	sampleFile = "sample.ts",
): Promise<Set<string>> {
	const env = setupTestEnvironment("pi-lens-utils-block-sg-");
	cleanups.push(env.cleanup);
	const filePath = createTempFile(env.tmpDir, sampleFile, code);
	const mod = await import(
		"../../../../clients/dispatch/runners/ast-grep-napi.js"
	);
	const runner = mod.default;
	const ctx = {
		filePath,
		cwd: env.tmpDir,
		kind: "jsts",
		fileRole: "source",
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: true,
		blockingOnly: false,
		facts: new FactStore(),
		// napi is the fallback now (the ast-grep LSP supersedes it when its
		// binary is available); simulate the binary absent so this runner's
		// rule matching actually executes.
		hasTool: async (cmd: string) => cmd !== "ast-grep",
		log: () => {},
	};
	const result = await runner.run(ctx as never);
	return new Set(
		result.diagnostics
			.map((d) => d.rule)
			.filter((r): r is string => typeof r === "string"),
	);
}

describe("ast-grep NAPI utils: block passthrough (#663)", () => {
	describe("via the real runner front door (unblocked by any other gate)", () => {
		it("no-dupe-keys fires on a real duplicate key", async () => {
			expect(
				await rulesFiredOn("const o = { a: 1, a: 2 };\n"),
			).toContain("no-dupe-keys");
		});
		it("no-dupe-keys does not fire on distinct keys", async () => {
			expect(
				await rulesFiredOn("const o = { a: 1, b: 2 };\n"),
			).not.toContain("no-dupe-keys");
		});
		it("no-dupe-keys fires on a duplicate key/method pair", async () => {
			expect(
				await rulesFiredOn('const o = { a: 1, a() {} };\n'),
			).toContain("no-dupe-keys");
		});

		it("no-dupe-keys-js fires on a real duplicate key", async () => {
			expect(
				await rulesFiredOn("const o = { a: 1, a: 2 };\n", "sample.js"),
			).toContain("no-dupe-keys-js");
		});
		it("no-dupe-keys-js does not fire on distinct keys", async () => {
			expect(
				await rulesFiredOn("const o = { a: 1, b: 2 };\n", "sample.js"),
			).not.toContain("no-dupe-keys-js");
		});

		// #660 removed the TREE_SITTER_OVERLAP skip-set that used to gate
		// no-dupe-class-members out of this runner entirely, so it's now
		// reachable end to end through the real runner front door — the
		// same fixture cases as rules/ast-grep-rules/rule-tests/
		// no-dupe-class-members-test.yml's invalid: / valid: entries.
		it("no-dupe-class-members fires on a duplicate method", async () => {
			expect(
				await rulesFiredOn("class A { foo() {} foo() {} }\n"),
			).toContain("no-dupe-class-members");
		});
		it("no-dupe-class-members fires on a duplicate field", async () => {
			expect(
				await rulesFiredOn("class A { foo = 1; foo = 2; }\n"),
			).toContain("no-dupe-class-members");
		});
		it("no-dupe-class-members does not fire on distinct members", async () => {
			expect(
				await rulesFiredOn("class A { foo() {} bar() {} }\n"),
			).not.toContain("no-dupe-class-members");
		});
		it("no-dupe-class-members does not fire on a getter/setter pair", async () => {
			expect(
				await rulesFiredOn("class A { get x() {} set x(v) {} }\n"),
			).not.toContain("no-dupe-class-members");
		});
	});

	describe("via napi's native engine directly (rules gated by unrelated filters)", () => {
		// Mirrors the fixed construction in ast-grep-napi.ts's
		// evaluateAstGrepRules: `{ rule, constraints?, utils? }` fed straight
		// to napi's native findAll.
		function nativeConfigFor(rule: {
			rule?: unknown;
			constraints?: unknown;
			utils?: unknown;
		}): Record<string, unknown> {
			const cfg: Record<string, unknown> = { rule: rule.rule };
			if (rule.constraints) cfg.constraints = rule.constraints;
			if (rule.utils) cfg.utils = rule.utils;
			return cfg;
		}

		it("unnecessary-react-hook fires on a use*-named function that calls no hook", async () => {
			const { loadAstGrepNapi } = await import(
				"../../../../clients/deps/ast-grep-napi.js"
			);
			const { loadYamlRulesUncached } = await import(
				"../../../../clients/dispatch/runners/yaml-rule-parser.js"
			);
			const sg = await loadAstGrepNapi();
			const rules = loadYamlRulesUncached(RULES_DIR);
			const rule = rules.find((r) => r.id === "unnecessary-react-hook");
			expect(rule, "unnecessary-react-hook rule not found").toBeTruthy();
			expect(rule?.utils, "rule should parse a utils: block").toBeTruthy();
			const cfg = nativeConfigFor(rule as never);

			const invalid = sg.tsx
				.parse("function usePlain() { return 42; }\n")
				.root();
			expect(invalid.findAll(cfg as never).length).toBeGreaterThan(0);

			const valid = sg.tsx
				.parse("function useRealHook() { useEffect(() => {}); }\n")
				.root();
			expect(valid.findAll(cfg as never).length).toBe(0);
		});

		it("rust-2024-let-chain-candidate's utils: block survives YAML parsing (napi in this build has no Rust parser; behavior covered by the CLI-based catalog tests)", async () => {
			const { loadYamlRulesUncached } = await import(
				"../../../../clients/dispatch/runners/yaml-rule-parser.js"
			);
			const rules = loadYamlRulesUncached(RULES_DIR);
			const rule = rules.find(
				(r) => r.id === "rust-2024-let-chain-candidate",
			);
			expect(rule, "rust-2024-let-chain-candidate rule not found").toBeTruthy();
			expect(
				rule?.utils && Object.keys(rule.utils).length > 0,
				"rule should parse a non-empty utils: block",
			).toBeTruthy();
		});
	});
});
