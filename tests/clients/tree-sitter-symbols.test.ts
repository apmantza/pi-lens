/**
 * Symbol-extraction smoke test (#251) — one case per SYMBOL_QUERIES grammar.
 *
 * For every supported language, parse a fixture with the SHIPPED tree-sitter
 * WASM and assert a known symbol extracts. Guards against the failure this test
 * was born from: symbol `defs`/`refs` queries silently breaking against a
 * grammar (kotlin/php/ocaml/dart/lua all had malformed queries → zero symbol
 * nodes in the review graph, surfaced only because nothing asserted extraction).
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	grammarBlockReason,
	LANGUAGE_TO_GRAMMAR,
} from "../../clients/grammar-source.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import type { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { TreeSitterSymbolExtractor } from "../../clients/tree-sitter-symbol-extractor.js";
import { readSymbol } from "../../clients/module-report.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

interface SymbolCase {
	file: string;
	src: string;
	expect: string[];
}

// languageId here is the SYMBOL_QUERIES / tree-sitter grammar key.
const CASES: Record<string, SymbolCase> = {
	typescript: {
		file: "a.ts",
		src: "export function foo(){}\nclass C{}\n",
		expect: ["foo", "C"],
	},
	// #887: the javascript grammar lacks the TS type-level node types, so it has
	// its own SYMBOL_QUERIES entry (typescript's fails to compile against it).
	// A class name is a plain (identifier) here, not a (type_identifier).
	javascript: {
		file: "a.js",
		src: "export function foo(){}\nconst bar = () => 1;\nclass C{}\n",
		expect: ["foo", "bar", "C"],
	},
	python: { file: "a.py", src: "def go():\n    pass\n", expect: ["go"] },
	rust: { file: "a.rs", src: "fn foo() {}\n", expect: ["foo"] },
	go: { file: "a.go", src: "package m\nfunc foo() {}\n", expect: ["foo"] },
	ruby: { file: "a.rb", src: "def foo\nend\n", expect: ["foo"] },
	c: { file: "a.c", src: "int foo() { return 0; }\n", expect: ["foo"] },
	cpp: { file: "a.cpp", src: "int foo() { return 0; }\n", expect: ["foo"] },
	java: { file: "A.java", src: "class A { void foo() {} }\n", expect: ["foo"] },
	csharp: {
		file: "A.cs",
		src: "class A { void Foo() {} }\n",
		expect: ["Foo"],
	},
	swift: { file: "a.swift", src: "func foo() {}\n", expect: ["foo"] },
	kotlin: {
		file: "A.kt",
		src: "fun foo() {}\nclass Bar {}\n",
		expect: ["foo", "Bar"],
	},
	dart: { file: "a.dart", src: "int foo() => 1;\n", expect: ["foo"] },
	php: { file: "a.php", src: "<?php\nfunction foo() {}\n", expect: ["foo"] },
	ocaml: { file: "a.ml", src: "let foo x = x\n", expect: ["foo"] },
	lua: {
		// @tree-sitter-grammars build (#255): function_declaration with a plain
		// identifier (global / `local function`) or a dot_index_expression name.
		file: "a.lua",
		src: "function foo() end\nfunction M.run() end\nlocal function util() end\n",
		expect: ["foo", "util"],
	},
	zig: { file: "a.zig", src: "fn foo() void {}\n", expect: ["foo"] },
	bash: { file: "a.sh", src: "foo() { :; }\n", expect: ["foo"] },
	elixir: { file: "a.ex", src: "defmodule M do\nend\n", expect: ["M"] },
	// #1522: `#Definition` → type, plain field → property, `let` → variable.
	cue: {
		file: "a.cue",
		src: "package a\n\n#Service: {\n\tname: string\n}\n\nlet helper = 1\n",
		expect: ["#Service", "name", "helper"],
	},
	// #5235: class, constructor, method and a field closure from the vendored
	// dekobon grammar.
	groovy: {
		file: "A.groovy",
		src: "class A {\n    def run = { x -> x }\n    A() { }\n    void foo() { }\n}\n",
		expect: ["A", "run", "foo"],
	},
};

let client: TreeSitterClient;
beforeAll(async () => {
	client = getSharedTreeSitterClient()!;
	await client.init();
});

describe("TreeSitterSymbolExtractor abort handling", () => {
	it("stops query compilation after a WASM abort", () => {
		const reportWasmAbort = vi.fn(() => true);
		const client = { reportWasmAbort } as unknown as TreeSitterClient;
		const extractor = new TreeSitterSymbolExtractor("typescript", client);
		const compileQuery = (
			extractor as unknown as {
				compileQuery: (
					Query: new () => never,
					language: unknown,
					src: string,
					label: string,
				) => unknown;
			}
		).compileQuery.bind(extractor);
		class AbortingQuery {
			constructor() {
				throw new Error("Aborted()");
			}
		}

		expect(() =>
			compileQuery(AbortingQuery as never, {}, "(x)", "defs"),
		).toThrow("Aborted()");
		expect(reportWasmAbort).toHaveBeenCalledTimes(1);
	});
});

describe("export-scope correctness (#256) — module exports vs function locals", () => {
	async function extract(src: string) {
		const env = setupTestEnvironment("pi-lens-export-scope-");
		try {
			const fp = createTempFile(env.tmpDir, "a.ts", src);
			const tree = await client.parseFile(fp, "typescript");
			const extractor = new TreeSitterSymbolExtractor("typescript", client);
			await extractor.init();
			return extractor.extract(tree!, fp, src).symbols;
		} finally {
			env.cleanup();
		}
	}

	it("does NOT mark a function-local declaration as exported", async () => {
		// The #256 false-API bug: `log` lived inside an exported function and the
		// ancestor walk reached the function's own `export` → wrongly exported.
		const symbols = await extract(
			[
				"export function readSymbol(): void {",
				"  const log = (n: number) => n + 1;",
				"  log(1);",
				"}",
			].join("\n"),
		);
		const log = symbols.find((s) => s.name === "log");
		expect(log).toBeDefined();
		expect(log?.isExported).toBe(false);
		const fn = symbols.find((s) => s.name === "readSymbol");
		expect(fn?.isExported).toBe(true);
	});

	it("keeps members of an exported class exported, but not method-locals", async () => {
		const symbols = await extract(
			[
				"export class Service {",
				"  run(): number {",
				"    const helper = () => 2;",
				"    return helper();",
				"  }",
				"}",
			].join("\n"),
		);
		expect(symbols.find((s) => s.name === "run")?.isExported).toBe(true);
		expect(symbols.find((s) => s.name === "helper")?.isExported).toBe(false);
	});

	it("does not export members of a non-exported class", async () => {
		const symbols = await extract("class Internal {\n  go(): void {}\n}\n");
		expect(symbols.find((s) => s.name === "go")?.isExported).toBe(false);
	});

	it("does not treat a mid-line 'export' substring as an export (anchored keyword)", async () => {
		// Pre-#256, `line.includes("export")` flagged any declaration whose line
		// merely contained the substring (here, a trailing comment).
		const symbols = await extract("function helper() {} // not an export\n");
		expect(symbols.find((s) => s.name === "helper")?.isExported).toBe(false);
	});
});

describe("member visibility (#258) + function-local detection (#259)", () => {
	async function extract(src: string) {
		const env = setupTestEnvironment("pi-lens-visibility-");
		try {
			const fp = createTempFile(env.tmpDir, "a.ts", src);
			const tree = await client.parseFile(fp, "typescript");
			const extractor = new TreeSitterSymbolExtractor("typescript", client);
			await extractor.init();
			return extractor.extract(tree!, fp, src).symbols;
		} finally {
			env.cleanup();
		}
	}

	it("tags private/protected members and leaves public members untagged (#258)", async () => {
		const symbols = await extract(
			[
				"export class Service {",
				"  pub(): void {}",
				"  private secret(): void {}",
				"  protected guarded(): void {}",
				"}",
			].join("\n"),
		);
		expect(symbols.find((s) => s.name === "pub")?.visibility).toBeUndefined();
		expect(symbols.find((s) => s.name === "secret")?.visibility).toBe(
			"private",
		);
		expect(symbols.find((s) => s.name === "guarded")?.visibility).toBe(
			"protected",
		);
		// Visibility is membership metadata, not an export change — the members of
		// an exported class stay isExported (the #256 contract is unchanged).
		expect(symbols.find((s) => s.name === "secret")?.isExported).toBe(true);
	});

	it("does not tag visibility for languages without a real modifier", async () => {
		// Python `_name` is a convention, not a modifier — must NOT be faked.
		const env = setupTestEnvironment("pi-lens-visibility-py-");
		try {
			const src = "class C:\n    def _internal(self):\n        pass\n";
			const fp = createTempFile(env.tmpDir, "a.py", src);
			const tree = await client.parseFile(fp, "python");
			const extractor = new TreeSitterSymbolExtractor("python", client);
			await extractor.init();
			const symbols = extractor.extract(tree!, fp, src).symbols;
			expect(
				symbols.find((s) => s.name === "_internal")?.visibility,
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("marks a nested const/arrow as function-local, not module structure (#259)", async () => {
		const symbols = await extract(
			[
				"export function outer(): number {",
				"  const inner = (n: number) => n + 1;",
				"  return inner(1);",
				"}",
			].join("\n"),
		);
		expect(symbols.find((s) => s.name === "inner")?.local).toBe(true);
		// The module-level function itself is not local.
		expect(symbols.find((s) => s.name === "outer")?.local).toBeFalsy();
	});

	it("does not mark class members or top-level declarations as local (#259)", async () => {
		const symbols = await extract(
			[
				"export class Service {",
				"  run(): void {}",
				"}",
				"export function top(): void {}",
			].join("\n"),
		);
		expect(symbols.find((s) => s.name === "run")?.local).toBeFalsy();
		expect(symbols.find((s) => s.name === "top")?.local).toBeFalsy();
	});
});

describe("tree-sitter symbol extraction (#251) — per supported grammar", () => {
	for (const [lang, c] of Object.entries(CASES)) {
		// A grammar blocked on this runtime (e.g. swift on Node >= 24, #432) is
		// intentionally never loaded — skip rather than fail the extraction smoke.
		const blocked = Boolean(grammarBlockReason(LANGUAGE_TO_GRAMMAR[lang]));
		it.skipIf(blocked)(`extracts symbols for ${lang}`, async () => {
			const env = setupTestEnvironment(`pi-lens-sym-${lang}-`);
			try {
				const fp = createTempFile(env.tmpDir, c.file, c.src);
				const tree = await client.parseFile(fp, lang);
				expect(tree).toBeTruthy();
				const extractor = new TreeSitterSymbolExtractor(lang, client);
				expect(await extractor.init()).toBe(true);
				const names = extractor
					.extract(tree, fp, c.src)
					.symbols.map((s) => s.name);
				expect(names.length).toBeGreaterThan(0);
				for (const expected of c.expect) {
					expect(names).toContain(expected);
				}
			} finally {
				env.cleanup();
			}
		});
	}
});

describe("decorator walk stops at a named sibling (#4368 r2 L2)", () => {
	// Recurrence: #4368 r2 L2 (mutant S9: the decorator walk never stops at a
	// named sibling). `#[outer]` decorates `first`, and the named `first` item
	// sits between it and `target`; the walk must stop at `first`, so `target`
	// gets no decorator. A walk that runs past `first` would attach `#[outer]`
	// to `target`. The positive control proves the fixture is decorated.
	it("does not collect a decorator above a named non-decorator sibling", async () => {
		const env = setupTestEnvironment("pi-lens-4368-deco-walk-");
		try {
			const src = "#[outer]\nfn first() {}\nfn target() {}\n";
			const fp = createTempFile(env.tmpDir, "walk.rs", src);
			const tree = await client.parseFile(fp, "rust");
			const extractor = new TreeSitterSymbolExtractor("rust", client);
			await extractor.init();
			const symbols = extractor.extract(tree!, fp, src).symbols;
			expect(symbols.find((s) => s.name === "first")?.decorators).toEqual([
				"#[outer]",
			]);
			expect(
				symbols.find((s) => s.name === "target")?.decorators,
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

describe("Python docstrings fill Symbol.doc (#4948)", () => {
	// Recurrence: #4948. Python documents a def or class with the first string
	// statement of its body, so a docstring-only symbol had no `doc` and the
	// outline lost its contract. The trap the guard prevents: a docstring start
	// line must never become `docStartLine`; readSymbol extends its range to
	// `docStartLine`, so a start line inside the body would cut the signature
	// off the returned source.
	async function extractPy(src: string) {
		const env = setupTestEnvironment("pi-lens-4948-py-doc-");
		try {
			const fp = createTempFile(env.tmpDir, "a.py", src);
			const tree = await client.parseFile(fp, "python");
			const extractor = new TreeSitterSymbolExtractor("python", client);
			await extractor.init();
			return extractor.extract(tree!, fp, src).symbols;
		} finally {
			env.cleanup();
		}
	}
	const docOf = (syms: { name: string; doc?: string }[], name: string) =>
		syms.find((s) => s.name === name)?.doc;

	it("extracts the first sentence of a multi-line docstring", async () => {
		const syms = await extractPy(
			'def go(a):\n    \"\"\"Return the go thing.\n\n    More text.\n    \"\"\"\n    return a\n',
		);
		expect(docOf(syms, "go")).toBe("Return the go thing.");
	});

	it("extracts class and method docstrings", async () => {
		const syms = await extractPy(
			"class K:\n    \"\"\"Class doc.\"\"\"\n    def m(self):\n        '''Method doc.'''\n        return 1\n",
		);
		expect(docOf(syms, "K")).toBe("Class doc.");
		expect(docOf(syms, "m")).toBe("Method doc.");
	});

	it("handles r, u and one-line string docstrings", async () => {
		const syms = await extractPy(
			[
				'def a():\n    r\"\"\"Raw doc.\"\"\"\n',
				'def b():\n    u\"\"\"Uni doc.\"\"\"\n',
				'def c():\n    "One line."\n',
			].join("\n"),
		);
		expect(docOf(syms, "a")).toBe("Raw doc.");
		expect(docOf(syms, "b")).toBe("Uni doc.");
		expect(docOf(syms, "c")).toBe("One line.");
	});

	it("gives no doc when the first statement is not a bare string", async () => {
		const syms = await extractPy(
			[
				'def a():\n    x = "s"\n    return x\n',
				'def b():\n    return "s"\n',
				// A string AFTER other code is a no-op expression, not a docstring
				// (mutation: drop the first-statement check).
				'def c():\n    x = 1\n    "Late string."\n    return x\n',
				// f and b prefixes are not docstrings.
				'def d():\n    f"Fstring."\n',
			].join("\n"),
		);
		for (const n of ["a", "b", "c", "d"])
			expect(docOf(syms, n)).toBeUndefined();
	});

	it("leaves docStartLine undefined and readSymbol starts at the def", async () => {
		const env = setupTestEnvironment("pi-lens-4948-py-read-");
		try {
			const src = 'x = 1\n\ndef go(a):\n    """Return a."""\n    return a\n';
			createTempFile(env.tmpDir, "a.py", src);
			const syms = await extractPy(src);
			const go = syms.find((s) => s.name === "go");
			expect(go?.doc).toBe("Return a.");
			expect(go?.docStartLine).toBeUndefined();
			const read = await readSymbol("a.py", "go", env.tmpDir);
			expect(read.found).toBe(true);
			expect(read.startLine).toBe(go?.line);
			expect(read.source?.startsWith("def go(a):")).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("falls back to a # comment, and the docstring wins when both exist", async () => {
		const syms = await extractPy(
			[
				"# Comment only.\ndef a():\n    pass\n",
				'# Comment loses.\ndef b():\n    """Docstring wins."""\n',
			].join("\n"),
		);
		const a = syms.find((s) => s.name === "a");
		expect(a?.doc).toBe("Comment only.");
		expect(a?.docStartLine).toBeDefined();
		const b = syms.find((s) => s.name === "b");
		expect(b?.doc).toBe("Docstring wins.");
		expect(b?.docStartLine).toBeUndefined();
	});

	it("caps a long first sentence at 120 characters with an ellipsis", async () => {
		const syms = await extractPy(
			`def a():\n    "Abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb."\n`,
		);
		const doc = docOf(syms, "a");
		expect(doc?.length).toBe(120);
		expect(doc?.endsWith("…")).toBe(true);
	});

	it("falls back to the # comment when the docstring is blank", async () => {
		// Recurrence: #4951 F3. `if (text)` is what keeps a comment doc when the
		// docstring summarizes to nothing; neutering it dropped the comment doc.
		const syms = await extractPy(
			'# Above comment.\ndef go():\n    \"\"\"   \"\"\"\n',
		);
		const go = syms.find((s) => s.name === "go");
		expect(go?.doc).toBe("Above comment.");
		expect(go?.docStartLine).toBeDefined();
	});

	it("reads concatenated and parenthesized docstrings", async () => {
		// Recurrence: #4951 F5. Both are valid Python docstrings and were dropped.
		const syms = await extractPy(
			[
				'def a():\n    "Part one. " "Part two."\n',
				'def b():\n    ("Paren doc.")\n',
				// One f-string part makes the concatenation an f-string: no doc.
				'def c():\n    "Plain. " f"Fmt."\n',
			].join("\n"),
		);
		expect(docOf(syms, "a")).toBe("Part one.");
		expect(docOf(syms, "b")).toBe("Paren doc.");
		expect(docOf(syms, "c")).toBeUndefined();
	});

	it("reads a docstring that follows a # comment inside the body", async () => {
		// Recurrence: #4951 F4 / Sourcery thread 1: Python block comments are
		// extras, not named children, so the docstring is still the first one.
		const syms = await extractPy(
			'def a():\n    # inner comment\n    \"\"\"Doc after comment.\"\"\"\n',
		);
		expect(docOf(syms, "a")).toBe("Doc after comment.");
	});

	it("does not read a bare string in another grammar's function_definition", async () => {
		// Recurrence: #4951 F1. `function_definition` is PHP's node too; keying on
		// node types alone gave a PHP function a docstring doc.
		const env = setupTestEnvironment("pi-lens-4951-php-");
		try {
			const src = "<?php\nfunction f() {\n  'Php single quoted doc';\n}\n";
			const fp = createTempFile(env.tmpDir, "a.php", src);
			const tree = await client.parseFile(fp, "php");
			const extractor = new TreeSitterSymbolExtractor("php", client);
			await extractor.init();
			const f = extractor
				.extract(tree!, fp, src)
				.symbols.find((s) => s.name === "f");
			expect(f).toBeDefined();
			expect(f?.doc).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

// #5559: the neighbour cascade asks the language server at the symbol's
// identifier, never at the declaration start. rust-analyzer 1.100.0 answers 0
// references at the `pub` of `pub fn alpha` and 6 at `alpha`, so public Rust
// symbols got no neighbours. `line`/`column` stay the declaration start (they
// feed symbol ids and outline ranges); `nameLine`/`nameColumn` are the
// identifier. Recurrence this prevents: a grammar's definition query that
// captures the identifier at a different node than the one the position is
// read from, or a new language whose modifier-prefixed declaration regresses.
interface PositionCase {
	file: string;
	/** Modifier-prefixed declarations: the declaration start is not the name. */
	src: string;
	names: string[];
}
const POSITION_CASES: Record<string, PositionCase> = {
	rust: {
		file: "a.rs",
		src: "pub fn alpha() {}\npub(crate) async fn beta() {}\nimpl S {\n    pub fn area(&self) {}\n}\n",
		names: ["alpha", "beta", "area"],
	},
	go: {
		file: "a.go",
		src: "package m\nfunc Alpha() {}\nfunc (s S) Area() int { return 1 }\n",
		names: ["Alpha", "Area"],
	},
	python: {
		file: "a.py",
		src: "async def beta():\n    pass\nclass S:\n    def area(self):\n        pass\n",
		names: ["beta", "S", "area"],
	},
	// The annotation puts the declaration start on the line above the name.
	java: {
		file: "A.java",
		src: 'public class A {\n    @Override\n    public String toString() { return ""; }\n    private static int alpha() { return 1; }\n}\n',
		names: ["A", "toString", "alpha"],
	},
	c: {
		file: "a.c",
		src: "static int alpha(void) { return 1; }\nint beta(int x) { return x; }\n",
		names: ["alpha", "beta"],
	},
	cpp: {
		file: "a.cpp",
		src: "static inline int alpha() { return 1; }\nclass S { public: int area() { return 1; } };\n",
		names: ["alpha", "S"],
	},
	typescript: {
		file: "a.ts",
		src: "export async function beta() {}\nexport class S {\n  public async area() {}\n}\n",
		names: ["beta", "S", "area"],
	},
	ruby: {
		file: "a.rb",
		src: "def alpha\nend\nclass S\n  def area\n  end\nend\n",
		names: ["alpha", "S", "area"],
	},
	kotlin: {
		file: "A.kt",
		src: "private fun beta() = 2\nclass S { public fun area() = 1 }\n",
		names: ["beta", "S", "area"],
	},
	dart: {
		file: "a.dart",
		src: "int alpha() { return 1; }\nclass S { int area() { return 1; } }\n",
		names: ["alpha", "S", "area"],
	},
	csharp: {
		file: "A.cs",
		src: "public class S {\n    public static int Alpha() { return 1; }\n}\n",
		names: ["S", "Alpha"],
	},
	php: {
		file: "a.php",
		src: "<?php\nclass S {\n    public static function area() { return 1; }\n}\nfunction alpha() {}\n",
		names: ["S", "area", "alpha"],
	},
	swift: {
		file: "a.swift",
		src: "public func beta() -> Int { 2 }\nstruct S { func area() -> Int { 1 } }\n",
		names: ["beta", "S", "area"],
	},
	lua: {
		file: "a.lua",
		src: "local function beta() return 2 end\nfunction alpha() return 1 end\n",
		names: ["beta", "alpha"],
	},
	ocaml: {
		file: "a.ml",
		src: "let rec beta x = x\nlet alpha x = x + 1\n",
		names: ["beta", "alpha"],
	},
	zig: {
		file: "a.zig",
		src: "pub fn alpha() i32 { return 1; }\nfn beta() i32 { return 2; }\n",
		names: ["alpha", "beta"],
	},
	bash: {
		file: "a.sh",
		src: "function beta {\n  echo 2\n}\nalpha() {\n  echo 1\n}\n",
		names: ["beta", "alpha"],
	},
	elixir: {
		file: "a.ex",
		src: "defmodule Shape do\nend\n",
		names: ["Shape"],
	},
	groovy: {
		file: "A.groovy",
		src: "class A {\n    public void foo() { }\n}\n",
		names: ["A", "foo"],
	},
};

describe("symbol identifier position (#5559) — per supported grammar", () => {
	for (const [lang, c] of Object.entries(POSITION_CASES)) {
		const blocked = Boolean(grammarBlockReason(LANGUAGE_TO_GRAMMAR[lang]));
		it.skipIf(blocked)(
			`nameLine/nameColumn land on the identifier for ${lang}`,
			async () => {
				const env = setupTestEnvironment(`pi-lens-sympos-${lang}-`);
				try {
					const fp = createTempFile(env.tmpDir, c.file, c.src);
					const tree = await client.parseFile(fp, lang);
					const extractor = new TreeSitterSymbolExtractor(lang, client);
					expect(await extractor.init()).toBe(true);
					const symbols = extractor.extract(tree, fp, c.src).symbols;
					const lines = c.src.split("\n");
					for (const name of c.names) {
						const sym = symbols.find((s) => s.name === name);
						expect(sym, `${lang}: ${name} extracted`).toBeDefined();
						expect(sym?.nameLine, `${lang}: ${name} nameLine`).toBeDefined();
						expect(
							lines[(sym?.nameLine ?? 0) - 1]?.startsWith(
								name,
								(sym?.nameColumn ?? 0) - 1,
							),
							`${lang}: ${name} at ${sym?.nameLine}:${sym?.nameColumn}`,
						).toBe(true);
					}
				} finally {
					env.cleanup();
				}
			},
		);
	}

	it("keeps line/column at the declaration start beside the identifier (rust pub fn, java annotation)", async () => {
		const env = setupTestEnvironment("pi-lens-sympos-decl-");
		try {
			const rust = createTempFile(env.tmpDir, "a.rs", "pub fn alpha() {}\n");
			const rustTree = await client.parseFile(rust, "rust");
			const rustX = new TreeSitterSymbolExtractor("rust", client);
			await rustX.init();
			const alpha = rustX
				.extract(rustTree, rust, "pub fn alpha() {}\n")
				.symbols.find((s) => s.name === "alpha");
			expect([alpha?.line, alpha?.column]).toEqual([1, 1]);
			expect([alpha?.nameLine, alpha?.nameColumn]).toEqual([1, 8]);

			const javaSrc =
				'class A {\n    @Override\n    public String toString() { return ""; }\n}\n';
			const java = createTempFile(env.tmpDir, "A.java", javaSrc);
			const javaTree = await client.parseFile(java, "java");
			const javaX = new TreeSitterSymbolExtractor("java", client);
			await javaX.init();
			const toStr = javaX
				.extract(javaTree, java, javaSrc)
				.symbols.find((s) => s.name === "toString");
			expect([toStr?.line, toStr?.column]).toEqual([2, 5]);
			expect([toStr?.nameLine, toStr?.nameColumn]).toEqual([3, 19]);
		} finally {
			env.cleanup();
		}
	});
});
