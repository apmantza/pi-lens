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
import { beforeAll, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	buildOrUpdateGraph,
	flushReviewGraphPersistsForTests,
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
			"}",
			"class P { public void p() {} }",
			"public interface I { void im(); private void pm() {} }",
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
			P: false,
			p: false,
			I: true,
			im: true,
			pm: false,
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
			"  public interface I { void im(); }",
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
			S: true,
			sm: true,
			E: true,
		},
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
		} finally {
			flushReviewGraphPersistsForTests();
			await waitForReviewGraphPersistsForTests();
			env.cleanup();
		}
	});
});
