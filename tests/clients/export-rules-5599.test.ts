/**
 * Per-language export rules (#5599). Every cell runs a fixture through the real
 * TreeSitterSymbolExtractor with the shipped wasm grammar and asserts the
 * `isExported` answer per symbol: true (exported), false (the rule decided not)
 * or "unknown" (undefined: no rule can decide, which must never read as false).
 *
 * Recurrence: `isExported` admitted only a line starting with `export` or an
 * `export_statement` ancestor, so on clap v4.6.7 the review graph marked 0 of
 * 1944 symbols exported and an edit to a `pub fn` never raised "exported symbol
 * changed".
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	moduleReport,
	renderCompactModuleReport,
} from "../../clients/module-report.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	extractSymbolsAndRefsFromGraph,
	flushReviewGraphPersistsForTests,
	getCachedReviewGraph,
	isReviewGraphMigrationNeeded,
	REVIEW_GRAPH_VERSION,
	waitForReviewGraphPersistsForTests,
} from "../../clients/review-graph/builder.js";
import { computeImpactCascade } from "../../clients/review-graph/query.js";
import {
	grammarBlockReason,
	LANGUAGE_TO_GRAMMAR,
} from "../../clients/grammar-source.js";
import type { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { TreeSitterSymbolExtractor } from "../../clients/tree-sitter-symbol-extractor.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

type Answer = boolean | "unknown";

interface Cell {
	file: string;
	src: string;
	/** symbol name -> expected answer */
	exported: Record<string, Answer>;
	kinds?: Record<string, string>;
}

const CELLS: Record<string, Cell> = {
	rust: {
		file: "a.rs",
		src: [
			"pub fn a() {}",
			"pub(crate) fn b() {}",
			"fn c() {}",
			"pub(super) fn s() {}",
			"pub enum E { X }",
			"pub trait T { fn d(&self) {} fn e(&self); }",
			"pub const K: u32 = 1;",
			"pub type Al = u32;",
			"pub mod m { pub fn inner() {} }",
			"mod hidden { pub fn h() {} }",
			"pub(crate) mod crate_mod { pub fn cm() {} }",
			"struct S;",
			"impl S { pub fn meth(&self) {} fn priv_meth(&self) {} }",
			"impl Tr for S { fn tm(&self) {} type Output = u32; }",
			"fn outer() { pub fn nested() {} const L: u32 = 2; }",
			"trait Hidden { fn hd(&self) {} }",
		].join("\n"),
		exported: {
			a: true,
			b: false,
			c: false,
			s: false,
			E: true,
			T: true,
			d: true,
			K: true,
			Al: true,
			m: true,
			inner: true,
			h: false,
			hidden: false,
			crate_mod: false,
			cm: false,
			S: false,
			meth: true,
			priv_meth: false,
			tm: "unknown",
			Output: "unknown",
			outer: false,
			nested: false,
			L: false,
			Hidden: false,
			hd: false,
		},
		kinds: {
			a: "function",
			E: "class",
			S: "class",
			T: "interface",
			K: "variable",
			Al: "type",
			m: "class",
		},
	},
	go: {
		file: "a.go",
		src: [
			"package m",
			"func Foo() {}",
			"func foo() {}",
			"func (r R) Bar() {}",
			"func (r R) baz() {}",
			"type T struct{}",
			"type t struct{}",
			"func x() { type Loc struct{} }",
			// Non-ASCII: go/ast.IsExported uses unicode.IsUpper, so `Éa` is exported
			// and `éa` is not. An ASCII-only `[A-Z]` test answers false for both.
			"func Éa() {}",
			"func éa() {}",
		].join("\n"),
		exported: {
			Foo: true,
			foo: false,
			Bar: true,
			baz: false,
			T: true,
			t: false,
			x: false,
			Loc: false,
			Éa: true,
			éa: false,
		},
	},
	java: {
		file: "Outer.java",
		src: [
			"public class Outer {",
			"  public void pubm() {}",
			"  void pkgm() {}",
			"  private void privm() {}",
			"  protected void protm() {}",
			"  public enum E { X }",
			"  static class N { public void n() {} }",
			"  void loc() { class L { public void l() {} } }",
			// An anonymous class has no enclosing class_declaration of its own, so
			// only the function-body boundary keeps its public method local.
			'  public Object anon() { return new Object() { public String toString() { return ""; } }; }',
			"}",
			"class P { public void p() {} }",
			"public interface I { void im(); private void pm() {} }",
			// A type nested in an annotation type is implicitly public, like an
			// interface member (annotation elements themselves are not extracted).
			"public @interface Ann { class AnnInner { public void am() {} } }",
		].join("\n"),
		exported: {
			Outer: true,
			pubm: true,
			pkgm: false,
			privm: false,
			protm: false,
			E: true,
			N: false,
			n: false,
			L: false,
			l: false,
			anon: true,
			toString: false,
			P: false,
			p: false,
			I: true,
			im: true,
			pm: false,
			AnnInner: true,
			am: true,
		},
	},
	kotlin: {
		file: "A.kt",
		src: [
			"fun a() {}",
			"private fun b() {}",
			"internal fun c() {}",
			"public fun d() {}",
			"class K { fun m() {} private fun pm() {} protected fun q() {} }",
			"private class PK { fun pkm() {} }",
			"fun outer() { fun inner() {} }",
			"object O { fun om() {} }",
		].join("\n"),
		exported: {
			a: true,
			b: false,
			c: false,
			d: true,
			K: true,
			m: true,
			pm: false,
			q: false,
			PK: false,
			pkm: false,
			outer: true,
			inner: false,
			O: true,
			om: true,
		},
	},
	csharp: {
		file: "A.cs",
		src: [
			"namespace N {",
			"  public class A {",
			"    public void a() {}",
			"    void b() {}",
			"    private void c() {}",
			"    internal void d() {}",
			"    protected void e() {}",
			"  }",
			"  class P { public void p() {} }",
			"  public interface I { void im(); internal void hid() {} protected void pro() {} private void pri() {} public void pub() {} }",
			"  public struct S { public void sm() {} }",
			"  public enum E { X }",
			"}",
		].join("\n"),
		exported: {
			A: true,
			a: true,
			b: false,
			c: false,
			d: false,
			e: false,
			P: false,
			p: false,
			I: true,
			im: true,
			// An explicit non-public modifier on an interface member is honoured;
			// an unmodified member is public (C# 8+).
			hid: false,
			pro: false,
			pri: false,
			pub: true,
			S: true,
			sm: true,
			E: true,
		},
	},
	// The JS/TS `export` rule is unchanged: exported is true or false, never
	// unknown, on all three grammars that share it.
	typescript: {
		file: "a.ts",
		src: "export function foo() {}\nfunction bar() {}\n",
		exported: { foo: true, bar: false },
	},
	tsx: {
		file: "a.tsx",
		src: "export function foo() {}\nfunction bar() {}\n",
		exported: { foo: true, bar: false },
	},
	javascript: {
		file: "a.js",
		src: "export function foo() {}\nfunction bar() {}\n",
		exported: { foo: true, bar: false },
	},
	// No visibility keyword or modifier on the declaration node: the answer is
	// "unknown", never false (#5599 acceptance 2).
	python: {
		file: "a.py",
		src: "def go():\n    pass\n\ndef _hidden():\n    pass\n\nclass C:\n    def m(self):\n        pass\n",
		exported: { go: "unknown", _hidden: "unknown", C: "unknown", m: "unknown" },
	},
	ruby: {
		file: "a.rb",
		src: "def foo\nend\n\nclass K\n  def bar\n  end\nend\n",
		exported: { foo: "unknown", K: "unknown", bar: "unknown" },
	},
	c: {
		file: "a.c",
		src: "int foo() { return 0; }\nstatic int bar() { return 1; }\n",
		exported: { foo: "unknown", bar: "unknown" },
	},
};

let client: TreeSitterClient;
beforeAll(async () => {
	client = getSharedTreeSitterClient()!;
	await client.init();
});

describe("per-language export rules through the real extractor (#5599)", () => {
	for (const [lang, cell] of Object.entries(CELLS)) {
		const blocked = Boolean(grammarBlockReason(LANGUAGE_TO_GRAMMAR[lang]));
		it.skipIf(blocked)(`${lang}: isExported per symbol`, async () => {
			const env = setupTestEnvironment(`pi-lens-export-${lang}-`);
			try {
				const fp = createTempFile(env.tmpDir, cell.file, cell.src);
				const tree = await client.parseFile(fp, lang);
				const extractor = new TreeSitterSymbolExtractor(lang, client);
				expect(await extractor.init()).toBe(true);
				const symbols = extractor.extract(tree, fp, cell.src).symbols;
				const answers: Record<string, Answer> = {};
				for (const name of Object.keys(cell.exported)) {
					const sym = symbols.find((s) => s.name === name);
					expect(sym, `symbol ${name} extracted`).toBeDefined();
					answers[name] =
						sym?.isExported === undefined ? "unknown" : sym.isExported;
				}
				expect(answers).toEqual(cell.exported);
				for (const [name, kind] of Object.entries(cell.kinds ?? {})) {
					expect(symbols.find((s) => s.name === name)?.kind, name).toBe(kind);
				}
			} finally {
				env.cleanup();
			}
		});
	}
});

describe("the review graph carries the rule's answer to its readers (#5599)", () => {
	it("raises 'exported symbol changed' for a pub fn, not for a private or unknown one", async () => {
		const env = setupTestEnvironment("pi-lens-export-graph-");
		try {
			createTempFile(env.tmpDir, "pubs.rs", "pub fn alpha() {}\n");
			createTempFile(env.tmpDir, "privs.rs", "pub(crate) fn beta() {}\n");
			createTempFile(env.tmpDir, "mod.py", "def gamma():\n    pass\n");
			const graph = await buildOrUpdateGraph(env.tmpDir, [], new FactStore());
			const node = (name: string) =>
				[...graph.nodes.values()].find(
					(n) => n.kind === "symbol" && n.symbolName === name,
				);
			const flagsOf = (name: string) => {
				const filePath = node(name)?.filePath;
				expect(filePath, `${name} in graph`).toBeDefined();
				return computeImpactCascade(graph, filePath as string).riskFlags;
			};
			expect(node("alpha")?.exported).toBe(true);
			expect(node("beta")?.exported).toBe(false);
			// Unknown stays unknown in the node: absent, not false.
			expect(node("gamma")?.exported).toBeUndefined();
			expect(flagsOf("alpha")).toContain("exported symbol changed");
			expect(flagsOf("beta")).not.toContain("exported symbol changed");
			expect(flagsOf("gamma")).not.toContain("exported symbol changed");
			// The call-graph view of the node keeps unknown unknown too: reading it
			// as `node.exported === true` made every no-rule symbol "not exported".
			const gamma = extractSymbolsAndRefsFromGraph(graph)
				.allSymbols.get(node("gamma")?.filePath as string)
				?.find((s) => s.name === "gamma");
			expect(gamma, "gamma in the call-graph symbols").toBeDefined();
			expect(gamma?.isExported).toBeUndefined();
		} finally {
			flushReviewGraphPersistsForTests();
			await waitForReviewGraphPersistsForTests();
			env.cleanup();
		}
	});
});

describe("module_report keeps unknown visibility unknown (#5599)", () => {
	// Recurrence: acceptance 2 held for the graph node only. module_report read
	// `sym.isExported || node.exported` as a boolean, so a Python file rendered
	// "N symbols, 0 exported" with every symbol under INTERNAL.
	it("a no-rule language has no API/INTERNAL split and no export count", async () => {
		const env = setupTestEnvironment("pi-lens-export-modreport-py-");
		try {
			const file = createTempFile(
				env.tmpDir,
				"sample.py",
				"def public_api():\n    pass\n\ndef _private():\n    pass\n",
			);
			const report = await moduleReport(file, env.tmpDir);
			expect(report.available).toBe(true);
			expect(report.api).toEqual([]);
			expect(report.internal).toEqual([]);
			expect(report.unclassified?.map((e) => e.name).sort()).toEqual([
				"_private",
				"public_api",
			]);
			expect(report.unclassified?.every((e) => e.exported === undefined)).toBe(
				true,
			);
			expect(report.summary.exports).toBeUndefined();
			expect(report.summary.symbols).toBe(2);
			const text = renderCompactModuleReport(report);
			expect(text.split("\n")[0]).toContain("2 symbols");
			expect(text.split("\n")[0]).not.toContain("exported");
			expect(text).not.toContain("INTERNAL:");
			expect(text).not.toContain("API:\n");
			expect(text).toContain("SYMBOLS (visibility unknown):");
			expect(text).toContain("public_api");
		} finally {
			clearReviewGraphWorkspaceCache();
			env.cleanup();
		}
	});

	it("a rule language still splits: pub fn is API, private fn is INTERNAL, count is real", async () => {
		const env = setupTestEnvironment("pi-lens-export-modreport-rs-");
		try {
			const file = createTempFile(
				env.tmpDir,
				"lib.rs",
				"pub fn open() {}\nfn hidden() {}\n",
			);
			const report = await moduleReport(file, env.tmpDir);
			expect(report.api.map((e) => e.name)).toEqual(["open"]);
			expect(report.internal.map((e) => e.name)).toEqual(["hidden"]);
			expect(report.unclassified).toBeUndefined();
			expect(report.summary.exports).toBe(1);
			expect(renderCompactModuleReport(report).split("\n")[0]).toContain(
				"1 exported",
			);
		} finally {
			clearReviewGraphWorkspaceCache();
			env.cleanup();
		}
	});
});

describe("a graph persisted before #5599 is not reused (#5599)", () => {
	// Recurrence: a v8 snapshot written by the old extractor has no enum/trait
	// nodes and every non-JS symbol `exported:false`. Loading it under the new
	// extractor serves those stale answers for every unchanged file, so the
	// version is bumped and the v8 snapshot must read as needing migration.
	it("a v8 snapshot is stale and getCachedReviewGraph refuses it", async () => {
		const env = setupTestEnvironment("pi-lens-export-v8-");
		try {
			expect(REVIEW_GRAPH_VERSION).not.toBe("v8");
			const cacheDir = path.join(getProjectDataDir(env.tmpDir), "cache");
			fs.mkdirSync(cacheDir, { recursive: true });
			fs.writeFileSync(
				path.join(cacheDir, "review-graph.json"),
				JSON.stringify({
					version: "v8",
					builtAt: "x",
					signature: "s",
					nodes: [
						[
							"a.rs:alpha:function:1",
							{
								id: "a.rs:alpha:function:1",
								kind: "symbol",
								language: "rust",
								filePath: "a.rs",
								symbolName: "alpha",
								symbolKind: "function",
								exported: false,
							},
						],
					],
					edges: [],
				}),
			);
			expect(isReviewGraphMigrationNeeded(env.tmpDir)).toBe(true);
			expect(getCachedReviewGraph(env.tmpDir)).toBeUndefined();
		} finally {
			clearReviewGraphWorkspaceCache();
			env.cleanup();
		}
	});
});
