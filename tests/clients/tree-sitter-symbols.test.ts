/**
 * Symbol-extraction smoke test (#251) — one case per SYMBOL_QUERIES grammar.
 *
 * For every supported language, parse a fixture with the SHIPPED tree-sitter
 * WASM and assert a known symbol extracts. Guards against the failure this test
 * was born from: symbol `defs`/`refs` queries silently breaking against a
 * grammar (kotlin/php/ocaml/dart/lua all had malformed queries → zero symbol
 * nodes in the review graph, surfaced only because nothing asserted extraction).
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
	grammarBlockReason,
	LANGUAGE_TO_GRAMMAR,
} from "../../clients/grammar-source.js";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { TreeSitterSymbolExtractor } from "../../clients/tree-sitter-symbol-extractor.js";
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
	kotlin: { file: "A.kt", src: "fun foo() {}\nclass Bar {}\n", expect: ["foo", "Bar"] },
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
};

let client: TreeSitterClient;
beforeAll(async () => {
	client = new TreeSitterClient();
	await client.init();
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
			expect(symbols.find((s) => s.name === "_internal")?.visibility).toBeUndefined();
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
