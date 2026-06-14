import { afterAll, describe, expect, it } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { createTempFile, setupTestEnvironment } from "../../test-utils.js";

// Integration test: runs the REAL ast-grep-napi runner against fixtures so the
// actual shipped YAML rules (loaded from rules/ast-grep-rules/rules) execute
// through the production matching path. Intentionally does NOT mock @ast-grep/napi
// or loadYamlRules.

const cleanups: Array<() => void> = [];
afterAll(() => {
	for (const c of cleanups) c();
});

async function rulesFiredOn(
	code: string,
	flags: Record<string, unknown> = {},
): Promise<Set<string>> {
	const env = setupTestEnvironment("pi-lens-sonar-sg-");
	cleanups.push(env.cleanup);
	const filePath = createTempFile(env.tmpDir, "sample.ts", code);
	const mod = await import(
		"../../../../clients/dispatch/runners/ast-grep-napi.js"
	);
	const runner = mod.default;
	const ctx = {
		filePath,
		cwd: env.tmpDir,
		kind: "jsts",
		fileRole: "source",
		pi: { getFlag: (name: string) => flags[name] },
		autofix: false,
		deltaMode: true,
		blockingOnly: false,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
	const result = await runner.run(ctx as never);
	return new Set(
		result.diagnostics
			.map((d) => d.rule)
			.filter((r): r is string => typeof r === "string"),
	);
}

describe("ast-grep Sonar gap rules (integration via real runner)", () => {
	describe("no-sort-without-comparator (S2871)", () => {
		it("flags .sort() with no compare function", async () => {
			expect(await rulesFiredOn("const r = arr.sort();\n")).toContain(
				"no-sort-without-comparator",
			);
		});
		it("flags .toSorted() with no compare function", async () => {
			expect(await rulesFiredOn("const r = list.toSorted();\n")).toContain(
				"no-sort-without-comparator",
			);
		});
		it("does not flag .sort() with a comparator", async () => {
			expect(
				await rulesFiredOn("const r = arr.sort((a, b) => a - b);\n"),
			).not.toContain("no-sort-without-comparator");
		});
	});

	describe("no-octal-literal (S1314)", () => {
		it("flags a leading-zero octal literal", async () => {
			expect(await rulesFiredOn("const x = 0123;\n")).toContain(
				"no-octal-literal",
			);
		});
		it("does not flag hex / decimal / float / 0o literals", async () => {
			const fired = await rulesFiredOn(
				"const a = 0x1f; const b = 100; const c = 0.5; const d = 0o17;\n",
			);
			expect(fired).not.toContain("no-octal-literal");
		});
	});

	describe("no-mutable-export (S6861)", () => {
		it("flags export let", async () => {
			expect(await rulesFiredOn("export let counter = 0;\n")).toContain(
				"no-mutable-export",
			);
		});
		it("flags export var", async () => {
			expect(await rulesFiredOn("export var counter = 0;\n")).toContain(
				"no-mutable-export",
			);
		});
		it("does not flag export const", async () => {
			expect(await rulesFiredOn("export const counter = 0;\n")).not.toContain(
				"no-mutable-export",
			);
		});
	});

	describe("switch-without-default (S131)", () => {
		it("flags a switch with no default clause", async () => {
			expect(
				await rulesFiredOn("switch (v) { case 1: doA(); break; }\n"),
			).toContain("switch-without-default");
		});
		it("does not flag a switch that has a default clause", async () => {
			expect(
				await rulesFiredOn(
					"switch (v) { case 1: doA(); break; default: doB(); }\n",
				),
			).not.toContain("switch-without-default");
		});
	});

	// Regression: tree-sitter parses BOTH `for...in` and `for...of` as
	// `for_in_statement`, so the rule must constrain to the `in` operator or it
	// false-positives on every (recommended) `for...of`.
	describe("ts-in-operator-loop (for...in vs for...of)", () => {
		it("flags a real for...in loop", async () => {
			expect(
				await rulesFiredOn("for (const k in obj) { use(k); }\n"),
			).toContain("ts-in-operator-loop");
		});
		it("does NOT flag a for...of loop", async () => {
			expect(
				await rulesFiredOn("for (const v of arr) { use(v); }\n"),
			).not.toContain("ts-in-operator-loop");
		});
	});

	// #206: no-constant-condition was rewritten from a `field`/nested rule (which
	// the hand-rolled YAML parser mangled → napi rejected → legacy fallback
	// sprayed false positives) to a flat pattern any-list that both engines run.
	describe("no-constant-condition (flat pattern rewrite)", () => {
		it("flags if (true) and if (false)", async () => {
			const fired = await rulesFiredOn(
				"if (true) { a(); }\nif (false) { b(); }\n",
			);
			expect(fired).toContain("no-constant-condition");
		});
		it("flags a constant ternary", async () => {
			expect(await rulesFiredOn("const x = false ? a : b;\n")).toContain(
				"no-constant-condition",
			);
		});
		it("does NOT flag a real condition or an idiomatic while (true)", async () => {
			const fired = await rulesFiredOn(
				"if (cond) { a(); }\nwhile (true) { loop(); }\nconst y = cond ? a : b;\n",
			);
			expect(fired).not.toContain("no-constant-condition");
		});
		it("does NOT spray on import lines (the #206 fallback regression)", async () => {
			const fired = await rulesFiredOn(
				'import { foo } from "./bar.js";\nconst x = 1;\nexport const y = "z";\n',
			);
			expect(fired).not.toContain("no-constant-condition");
		});
	});

	// #206: the runner now matches every rule through napi's native engine, fed by
	// a faithful js-yaml parse (no hand-rolled interpreter, no flag). These assert
	// the migration's correctness contract: relational rules behave per their
	// `stopBy`, and rules that were dead under the old engine now fire.
	describe("native engine (#206 migration)", () => {
		it("flags for...in but not for...of", async () => {
			expect(await rulesFiredOn("for (const k in obj) { use(k); }\n")).toContain(
				"ts-in-operator-loop",
			);
			expect(
				await rulesFiredOn("for (const v of arr) { use(v); }\n"),
			).not.toContain("ts-in-operator-loop");
		});

		describe("nested-ternary (has stopBy: end, no self-match)", () => {
			it("flags a chained ternary", async () => {
				expect(await rulesFiredOn("const x = a ? b : c ? d : e;\n")).toContain(
					"nested-ternary-js",
				);
			});
			it("flags a parenthesized nested ternary (needs stopBy: end)", async () => {
				expect(
					await rulesFiredOn("const x = a ? (b ? c : d) : e;\n"),
				).toContain("nested-ternary-js");
			});
			it("does NOT flag a single ternary (the has self-match bug)", async () => {
				expect(await rulesFiredOn("const x = a ? b : c;\n")).not.toContain(
					"nested-ternary-js",
				);
			});
		});

		describe("switch-without-default (not: has, stopBy: end)", () => {
			it("flags a switch with no default", async () => {
				expect(
					await rulesFiredOn("switch (v) { case 1: a(); break; }\n"),
				).toContain("switch-without-default");
			});
			it("does NOT flag a switch WITH a default (nested under switch_body)", async () => {
				expect(
					await rulesFiredOn(
						"switch (v) { case 1: a(); break; default: b(); }\n",
					),
				).not.toContain("switch-without-default");
			});
		});

		describe("relational rules rewritten for napi (were dead under the old engine)", () => {
			it("ts-object-hasown-check flags obj.hasOwnProperty(k)", async () => {
				expect(
					await rulesFiredOn("if (obj.hasOwnProperty(k)) {}\n"),
				).toContain("ts-object-hasown-check");
			});
			it("ts-unnecessary-else-return flags if-return + else", async () => {
				expect(
					await rulesFiredOn(
						"function f(){ if (c) { return 1; } else { return 2; } }\n",
					),
				).toContain("ts-unnecessary-else-return");
			});
			it("redundant-state flags const-then-return (follows, immediate sibling)", async () => {
				expect(
					await rulesFiredOn("function f(){ const x = compute(); return x; }\n"),
				).toContain("redundant-state");
			});
		});
	});
});
