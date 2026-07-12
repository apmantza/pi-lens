/**
 * Symbol extraction via tree-sitter queries
 * Extracts definitions and references from source files
 */

import * as path from "node:path";
import { loadWebTreeSitter } from "./deps/web-tree-sitter.js";
import type { Symbol, SymbolKind, SymbolRef } from "./symbol-types.js";
import type { TreeSitterClient } from "./tree-sitter-client.js";

// Tree-sitter query patterns for symbol extraction
const SYMBOL_QUERIES: Record<string, { defs: string; refs: string }> = {
	typescript: {
		defs: `
      ;; Function declarations: function foo(params) { }
      (function_declaration
        name: (identifier) @funcName
        parameters: (formal_parameters) @funcParams
        body: (statement_block) @funcBody) @funcDef
      
      ;; Arrow functions: const foo = (params) => { }
      (variable_declarator
        name: (identifier) @arrowName
        value: (arrow_function
          parameters: (formal_parameters) @arrowParams
          body: (_) @arrowBody)) @arrowDef
      
      ;; Class declarations: class Foo { }
      (class_declaration
        name: (type_identifier) @className) @classDef
      
      ;; Method definitions: class Foo { bar() { } }
      (method_definition
        name: (property_identifier) @methodName
        parameters: (formal_parameters) @methodParams) @methodDef
      
      ;; Interface declarations: interface Foo { }
      (interface_declaration
        name: (type_identifier) @interfaceName) @interfaceDef
      
      ;; Type alias: type Foo = ...
      (type_alias_declaration
        name: (type_identifier) @typeName) @typeDef
    `,
		refs: `
      ;; Function/method calls: foo() or obj.bar()
      (call_expression
        function: (identifier) @callIdent) @callRef
      
      (call_expression
        function: (member_expression
          object: (_)
          property: (property_identifier) @callMethod)) @callMethodRef
      
      ;; New expressions: new Foo()
      (new_expression
        constructor: (identifier) @newIdent) @newRef
      
      ;; Type references: type T = Foo
      (type_identifier) @typeIdent
    `,
	},
	python: {
		defs: `
      ;; Function definitions: def foo(params):
      (function_definition
        name: (identifier) @funcName
        parameters: (parameters) @funcParams) @funcDef
      
      ;; Class definitions: class Foo:
      (class_definition
        name: (identifier) @className) @classDef
      
      ;; Method definitions (within class)
      (class_definition
        body: (block
          (function_definition
            name: (identifier) @methodName
            parameters: (parameters) @methodParams) @methodDef))
    `,
		refs: `
      ;; Function calls: foo() or obj.bar()
      (call
        function: (identifier) @callIdent) @callRef
      
      (call
        function: (attribute
          object: (_)
          attribute: (identifier) @callMethod)) @callMethodRef
    `,
	},
	rust: {
		defs: `
      ;; Function definitions: fn foo(params) { }
      (function_item
        name: (identifier) @funcName
        parameters: (parameters) @funcParams) @funcDef
      
      ;; Struct definitions: struct Foo { }
      (struct_item
        name: (type_identifier) @structName) @structDef
      
      ;; Impl blocks: impl Foo { fn bar() { } }
      (impl_item
        type: (type_identifier) @implType
        body: (declaration_list
          (function_item
            name: (identifier) @implMethodName) @implMethodDef))
    `,
		refs: `
      ;; Function calls: foo() or obj.bar()
      (call_expression
        function: (identifier) @callIdent) @callRef
      
      (call_expression
        function: (field_expression
          value: (_)
          field: (field_identifier) @callField)) @callFieldRef
    `,
	},
	go: {
		defs: `
      (function_declaration
        name: (identifier) @funcName
        parameters: (parameter_list) @funcParams) @funcDef

      (method_declaration
        name: (field_identifier) @methodName
        parameters: (parameter_list) @methodParams) @methodDef

      (type_spec
        name: (type_identifier) @typeName) @typeDef
    `,
		refs: `
      (call_expression
        function: (identifier) @callIdent) @callRef

      (call_expression
        function: (selector_expression
          field: (field_identifier) @callMethod)) @callMethodRef
    `,
	},
	ruby: {
		defs: `
      (method
        name: (identifier) @methodName) @methodDef

      (singleton_method
        name: (identifier) @methodName) @methodDef

      (class
        name: (constant) @className) @classDef

      (module
        name: (constant) @moduleName) @moduleDef
    `,
		refs: `
      (call
        method: (identifier) @callIdent) @callRef

      (call
        method: (constant) @typeIdent) @typeRef
    `,
	},
	c: {
		defs: `
      (function_definition
        declarator: (function_declarator
          declarator: (identifier) @funcName
          parameters: (parameter_list) @funcParams)) @funcDef

      (type_definition
        declarator: (type_identifier) @typeName) @typeDef

      (struct_specifier
        name: (type_identifier) @typeName) @typeDef

      (enum_specifier
        name: (type_identifier) @typeName) @typeDef
    `,
		refs: `
      (call_expression
        function: (identifier) @callIdent) @callRef

      (call_expression
        function: (field_expression
          field: (field_identifier) @callField)) @callFieldRef

      (type_identifier) @typeIdent
    `,
	},
	cpp: {
		defs: `
      (function_definition
        declarator: (function_declarator
          declarator: (identifier) @funcName
          parameters: (parameter_list) @funcParams)) @funcDef

      (class_specifier
        name: (type_identifier) @className) @classDef

      (struct_specifier
        name: (type_identifier) @className) @classDef

      (type_definition
        declarator: (type_identifier) @typeName) @typeDef
    `,
		refs: `
      (call_expression
        function: (identifier) @callIdent) @callRef

      (call_expression
        function: (field_expression
          field: (field_identifier) @callField)) @callFieldRef

      (type_identifier) @typeIdent
    `,
	},
	java: {
		defs: `
      (method_declaration
        name: (identifier) @methodName
        parameters: (formal_parameters) @methodParams) @methodDef

      (class_declaration
        name: (identifier) @className) @classDef

      (interface_declaration
        name: (identifier) @interfaceName) @interfaceDef

      (constructor_declaration
        name: (identifier) @funcName
        parameters: (formal_parameters) @funcParams) @funcDef

      (enum_declaration
        name: (identifier) @className) @classDef
    `,
		refs: `
      (method_invocation
        name: (identifier) @callMethod) @callRef

      (object_creation_expression
        type: (type_identifier) @newIdent) @newRef

      (type_identifier) @typeIdent
    `,
	},
	kotlin: {
		// #251: class_declaration's name is type_identifier; the old extra
		// `(class_declaration (simple_identifier) @className)` was a bad pattern that
		// failed query compilation (taking the whole language down). Call refs use
		// no field name in the shipped grammar (the old `calleeExpression:` field
		// also failed to compile).
		defs: `
      (function_declaration
        (simple_identifier) @funcName) @funcDef

      (class_declaration
        (type_identifier) @className) @classDef

      (object_declaration
        (type_identifier) @className) @classDef
    `,
		refs: `
      (call_expression
        (simple_identifier) @callIdent) @callRef

      (user_type (type_identifier) @typeIdent)
    `,
	},
	dart: {
		// #251: function_signature/class_definition take their name/params as direct
		// children in the shipped grammar — the old `name:`/`parameters:` fields did
		// not exist and failed query compilation. method bodies' inner
		// function_signature also matches @funcDef (methods surface as functions).
		defs: `
      (function_signature
        (identifier) @funcName
        (formal_parameter_list) @funcParams) @funcDef

      (class_definition
        (identifier) @className) @classDef
    `,
		refs: `
      (type_identifier) @typeIdent
    `,
	},
	elixir: {
		defs: `
      (call
        target: (identifier) @_kw
        (arguments
          (call
            target: (identifier) @funcName
            (arguments) @funcParams) @funcDef)
        (#match? @_kw "^def[pm]?$"))

      (call
        target: (identifier) @_kw
        (arguments (alias) @moduleName) @moduleDef
        (#match? @_kw "^defmodule$"))
    `,
		refs: `
      (call
        target: (identifier) @callIdent) @callRef

      (alias) @typeIdent
    `,
	},
	csharp: {
		defs: `
      (method_declaration
        name: (identifier) @methodName
        parameters: (parameter_list) @methodParams) @methodDef

      (class_declaration
        name: (identifier) @className) @classDef

      (struct_declaration
        name: (identifier) @className) @classDef

      (interface_declaration
        name: (identifier) @interfaceName) @interfaceDef

      (constructor_declaration
        name: (identifier) @funcName
        parameters: (parameter_list) @funcParams) @funcDef

      (enum_declaration
        name: (identifier) @className) @classDef
    `,
		refs: `
      (invocation_expression
        function: (identifier) @callIdent) @callRef

      (invocation_expression
        function: (member_access_expression
          name: (identifier) @callMethod)) @callMethodRef

      (object_creation_expression
        type: (identifier) @newIdent) @newRef
    `,
	},
	php: {
		defs: `
      (function_definition
        name: (name) @funcName
        parameters: (formal_parameters) @funcParams) @funcDef

      (method_declaration
        name: (name) @methodName
        parameters: (formal_parameters) @methodParams) @methodDef

      (class_declaration
        name: (name) @className) @classDef

      (interface_declaration
        name: (name) @interfaceName) @interfaceDef

      (trait_declaration
        name: (name) @className) @classDef
    `,
		refs: `
      (function_call_expression
        function: (name) @callIdent) @callRef

      (member_call_expression
        name: (name) @callMethod) @callMethodRef

      (object_creation_expression
        (name) @newIdent) @newRef
    `,
	},
	swift: {
		defs: `
      (function_declaration
        (simple_identifier) @funcName) @funcDef

      (class_declaration
        (type_identifier) @className) @classDef

      (protocol_declaration
        (type_identifier) @interfaceName) @interfaceDef
    `,
		refs: `
      (call_expression
        (simple_identifier) @callIdent) @callRef

      (navigation_expression
        (simple_identifier) @callMethod) @callMethodRef

      (type_identifier) @typeIdent
    `,
	},
	lua: {
		// #255: pulled from @tree-sitter-grammars/tree-sitter-lua (the aggregator's
		// build corrupts once a 2nd grammar loads). That grammar names function defs
		// `function_declaration` — the name is either a direct (identifier) (global /
		// `local function`) or a (dot_index_expression) for `function M.run`. Calls
		// are `function_call` with an (identifier) or (dot_index_expression) callee.
		defs: `
      (function_declaration
        (identifier) @funcName) @funcDef

      (function_declaration
        (dot_index_expression) @funcName) @funcDef
    `,
		refs: `
      (function_call (identifier) @callIdent) @callRef

      (function_call (dot_index_expression) @callIdent) @callRef
    `,
	},
	ocaml: {
		// #251: let_binding holds value_name as a direct child (no `pattern:` /
		// value_pattern wrapper), and module_binding's module_name is a direct child
		// (no `name:` field) — the old patterns failed query compilation.
		defs: `
      (value_definition
        (let_binding (value_name) @funcName)) @funcDef

      (module_definition
        (module_binding (module_name) @moduleName)) @moduleDef
    `,
		refs: `
      (application_expression
        (value_path (value_name) @callIdent)) @callRef

      (value_path (value_name) @callIdent) @callRef
    `,
	},
	zig: {
		defs: `
      (function_declaration
        (identifier) @funcName) @funcDef
    `,
		// #251: the old `field_access` node name doesn't exist in this grammar and
		// failed to compile; call_expression refs are valid.
		refs: `
      (call_expression
        (identifier) @callIdent) @callRef
    `,
	},
	bash: {
		defs: `
      (function_definition
        name: (word) @funcName) @funcDef
    `,
		refs: `
      (command
        name: (command_name (word) @callIdent)) @callRef
    `,
	},
};

// The tsx grammar (downloaded as tree-sitter-tsx.wasm) shares TypeScript's node
// types — function_declaration, arrow_function, class_declaration,
// method_definition, interface_declaration, type_alias_declaration — so the
// TypeScript queries apply unchanged. Registering it lets .tsx/.jsx parse with
// the JSX-aware grammar instead of erroring under the plain TS grammar, matching
// symbol-extraction coverage to the grammar set we actually ship.
SYMBOL_QUERIES.tsx = SYMBOL_QUERIES.typescript;

// Per-language import-source extraction (#249). Optional and independent of
// SYMBOL_QUERIES: a language without an entry simply yields no imports (its
// symbols still extract). Each query captures the import source text as
// @importSource. typescript/tsx (#301) and c/cpp (#302) ARE present so the COLD
// module_report path (which runs this extractor directly) sees their imports; the
// WARM review graph still sources jsts imports from the TS compiler
// (importFactProvider) and cxx #include edges from its own line-regex path, and
// neither reaches this query, so there's no double-count.
//
// Call/builtin-based languages (ruby/zig/elixir/bash) express imports as
// ordinary function/macro calls, so their queries use a `#match?` predicate to
// keep only the import call out of every call in the file. web-tree-sitter 0.25's
// `Query.matches()` DOES apply these predicates (probed on the shipped grammars):
// an unpredicated ruby `require` query over-matches `puts`/`foo`, the predicated
// one returns only the require args.
const IMPORT_QUERIES: Record<string, string> = {
	// ESM import + re-export source strings; `source:` is a (string) on both the
	// typescript and tsx grammars (validated). parseImportMatch strips the quotes.
	// CJS `require(...)` is intentionally out of scope — the cold path's dominant
	// case is ESM, and the warm graph already covers require via the TS compiler.
	typescript: `
      (import_statement source: (string) @importSource)
      (export_statement source: (string) @importSource)
    `,
	tsx: `
      (import_statement source: (string) @importSource)
      (export_statement source: (string) @importSource)
    `,
	// #include "foo.h" (string_literal) and #include <stdio.h> (system_lib_string)
	// on both the c and cpp grammars (validated). parseImportMatch strips the quotes
	// from the local form; the system form keeps its <> so the resolver/bucketer can
	// tell a system header from a local include.
	c: `
      (preproc_include path: (string_literal) @importSource)
      (preproc_include path: (system_lib_string) @importSource)
    `,
	cpp: `
      (preproc_include path: (string_literal) @importSource)
      (preproc_include path: (system_lib_string) @importSource)
    `,
	python: `
      (import_statement name: (dotted_name) @importSource)
      (import_statement name: (aliased_import name: (dotted_name) @importSource))
      (import_from_statement module_name: (dotted_name) @importSource)
      (import_from_statement module_name: (relative_import) @importSource)
    `,
	go: `(import_spec path: (interpreted_string_literal) @importSource)`,
	rust: `(use_declaration argument: (_) @importSource)`,
	java: `(import_declaration (scoped_identifier) @importSource)`,
	kotlin: `(import_header (identifier) @importSource)`,
	csharp: `
      (using_directive (identifier) @importSource)
      (using_directive (qualified_name) @importSource)
    `,
	swift: `(import_declaration (identifier) @importSource)`,
	php: `(namespace_use_clause (name) @importSource)`,
	ocaml: `(open_module (module_path) @importSource)`,
	dart: `(import_specification (configurable_uri (uri (string_literal) @importSource)))`,
	// local x = require("mod.a") — a plain function call, not a statement. The
	// pulled @tree-sitter-grammars grammar (#255) names it function_call.
	lua: `
      (function_call
        (identifier) @_m
        (arguments (string) @importSource)
        (#match? @_m "^require$"))
    `,
	// require "x" / require_relative "x" — covers both via the "^require" prefix.
	ruby: `
      (call
        method: (identifier) @_m
        (argument_list (string (string_content) @importSource))
        (#match? @_m "^require"))
    `,
	// @import("std") — a builtin call, not a statement.
	zig: `
      (builtin_function (builtin_identifier) @_m
        (arguments (string (string_content) @importSource))
        (#match? @_m "^@import$"))
    `,
	// import/alias/require/use Foo — macro calls; excludes defmodule and friends.
	elixir: `
      (call target: (identifier) @_m
        (arguments (alias) @importSource)
        (#match? @_m "^(import|alias|require|use)$"))
    `,
	// source ./x.sh and . ./x.sh — the two POSIX file-include builtins.
	bash: `
      (command (command_name (word) @_m)
        (word) @importSource
        (#match? @_m "^(source|\\.)$"))
    `,
};

export interface ImportRef {
	/** Raw import source (quotes/whitespace stripped), e.g. "os.path", "fmt". */
	source: string;
	/** 1-based line of the import. */
	line: number;
}

export interface ExtractedSymbols {
	symbols: Symbol[];
	refs: SymbolRef[];
	imports: ImportRef[];
}

// biome-ignore lint/suspicious/noExplicitAny: tree-sitter match type
function parseImportMatch(match: any): ImportRef | null {
	for (const capture of match.captures) {
		if (capture.name !== "importSource") continue;
		const raw = String(capture.node.text ?? "").trim();
		const source = raw.replace(/^["'`]+|["'`]+$/g, "");
		if (!source) continue;
		return { source, line: capture.node.startPosition.row + 1 };
	}
	return null;
}

export class TreeSitterSymbolExtractor {
	private languageId: string;
	private client: TreeSitterClient;
	// biome-ignore lint/suspicious/noExplicitAny: Query type from web-tree-sitter
	private defQuery: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: Query type from web-tree-sitter
	private refQuery: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: Query type from web-tree-sitter
	private importQuery: any = null;

	constructor(languageId: string, client: TreeSitterClient) {
		this.languageId = languageId;
		this.client = client;
	}

	async init(): Promise<boolean> {
		try {
			// Get language from client
			const language = this.client.getLanguage(this.languageId);
			if (!language) return false;

			const { Query } = await loadWebTreeSitter();
			// Compile each query INDEPENDENTLY: a single malformed query — e.g. a
			// grammar update that breaks the symbol `defs` pattern (a cross-language
			// smoke test caught exactly this for kotlin) — must not disable the
			// others. A language with a broken symbol query can still yield imports,
			// and vice versa; the extractor degrades partially, not to nothing.
			const queries = SYMBOL_QUERIES[this.languageId];
			if (queries) {
				this.defQuery = this.compileQuery(
					Query,
					language,
					queries.defs,
					"defs",
				);
				this.refQuery = this.compileQuery(
					Query,
					language,
					queries.refs,
					"refs",
				);
			}
			const importQuerySrc = IMPORT_QUERIES[this.languageId];
			if (importQuerySrc) {
				this.importQuery = this.compileQuery(
					Query,
					language,
					importQuerySrc,
					"imports",
				);
			}
			return Boolean(this.defQuery || this.importQuery);
		} catch (err) {
			console.error(
				`[symbol-extractor] Failed to init ${this.languageId}:`,
				err,
			);
			return false;
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter Query/Language types
	private compileQuery(Query: any, language: any, src: string, label: string) {
		try {
			return new Query(language, src);
		} catch (err) {
			console.error(
				`[symbol-extractor] ${this.languageId} ${label} query failed: ${(err as Error).message}`,
			);
			return null;
		}
	}

	/**
	 * Extract symbols from a parsed tree-sitter tree
	 */
	extract(
		// biome-ignore lint/suspicious/noExplicitAny: Tree type
		tree: any,
		filePath: string,
		content: string,
	): ExtractedSymbols {
		const symbols: Symbol[] = [];
		const refs: SymbolRef[] = [];

		const relativePath = path.relative(process.cwd(), filePath);

		// Extract definitions (guarded — a language's defs query may have failed to
		// compile while its imports query succeeded, or vice versa).
		if (this.defQuery) {
			for (const match of this.defQuery.matches(tree.rootNode)) {
				const symbol = this.parseDefMatch(match, relativePath, content);
				if (symbol) symbols.push(symbol);
			}
		}

		// Extract references
		if (this.refQuery) {
			for (const match of this.refQuery.matches(tree.rootNode)) {
				const ref = this.parseRefMatch(match, relativePath);
				if (ref) refs.push(ref);
			}
		}

		// Extract imports (optional — only for languages with an IMPORT_QUERIES entry)
		const imports: ImportRef[] = [];
		if (this.importQuery) {
			for (const match of this.importQuery.matches(tree.rootNode)) {
				const ref = parseImportMatch(match);
				if (ref) imports.push(ref);
			}
		}

		return { symbols, refs, imports };
	}

	// biome-ignore lint/suspicious/noExplicitAny: Match type
	private parseDefMatch(
		match: any,
		filePath: string,
		content: string,
	): Symbol | null {
		const captures: Record<string, { text: string; node: unknown }> = {};

		for (const capture of match.captures) {
			captures[capture.name] = {
				text: capture.node.text,
				// biome-ignore lint/suspicious/noExplicitAny: Node type
				node: capture.node as any,
			};
		}

		// Determine kind and name
		let name: string | undefined;
		let kind: SymbolKind | undefined;
		let params: string | undefined;
		let defNode:
			| {
					startPosition: { row: number; column: number };
					endPosition: { row: number; column: number };
			  }
			| undefined;

		if (captures.funcName) {
			name = captures.funcName.text;
			kind = "function";
			params = captures.funcParams?.text;
			// biome-ignore lint/suspicious/noExplicitAny: Node type
			defNode = captures.funcDef?.node as any;
		} else if (captures.arrowName) {
			name = captures.arrowName.text;
			kind = "function";
			params = captures.arrowParams?.text;
			// biome-ignore lint/suspicious/noExplicitAny: Node type
			defNode = captures.arrowDef?.node as any;
		} else if (captures.className) {
			name = captures.className.text;
			kind = "class";
			// biome-ignore lint/suspicious/noExplicitAny: Node type
			defNode = captures.classDef?.node as any;
		} else if (captures.methodName) {
			name = captures.methodName.text;
			kind = "method";
			params = captures.methodParams?.text;
			// biome-ignore lint/suspicious/noExplicitAny: Node type
			defNode = captures.methodDef?.node as any;
		} else if (captures.interfaceName) {
			name = captures.interfaceName.text;
			kind = "interface";
			// biome-ignore lint/suspicious/noExplicitAny: Node type
			defNode = captures.interfaceDef?.node as any;
		} else if (captures.typeName) {
			name = captures.typeName.text;
			kind = "type";
			// biome-ignore lint/suspicious/noExplicitAny: Node type
			defNode = captures.typeDef?.node as any;
		} else if (captures.moduleName) {
			name = captures.moduleName.text;
			kind = "class";
			defNode = captures.moduleDef?.node as any;
		}

		if (!name || !kind || !defNode) return null;

		// Check if exported (basic heuristic: has export keyword before it)
		const isExported = this.isExported(defNode, content);
		const signature = params ? this.extractSignature(params, kind) : undefined;
		// Scope/visibility signals (additive; the review graph ignores them).
		// `local`: nearest enclosing scope is a function body (#259).
		// `visibility`: a TS/JS access modifier or #-private name (#258).
		const local = this.isFunctionLocal(defNode);
		const visibility =
			kind === "method" ? this.detectVisibility(defNode, name) : undefined;
		const decorators = this.extractDecorators(defNode);
		const isAsync =
			(kind === "function" || kind === "method") && this.isAsyncDecl(defNode);
		const docInfo = this.extractDocCommentInfo(defNode);

		return {
			id: `${filePath}:${name}`,
			name,
			kind,
			filePath,
			line: defNode.startPosition.row + 1,
			endLine: defNode.endPosition.row + 1,
			column: defNode.startPosition.column + 1,
			signature,
			isExported,
			...(local ? { local: true } : {}),
			...(visibility ? { visibility } : {}),
			...(decorators.length > 0 ? { decorators } : {}),
			...(isAsync ? { isAsync: true } : {}),
			...(docInfo ? { doc: docInfo.text, docStartLine: docInfo.startLine } : {}),
		};
	}

	// Comment node kinds across grammars that use tree-sitter's conventional
	// name. Line/block comments (`//`, `/* */`, `/** */`, `#`) all parse to a
	// single "comment" node type in every grammar checked (JS/TS, Python, Go,
	// Rust, Java, Kotlin, C#, C/C++, Ruby, PHP, Swift, Lua) — no per-grammar
	// query needed, unlike decorators/annotations which vary by node shape.
	private static readonly COMMENT_NODE_KIND = "comment";

	/**
	 * First sentence/line of the doc comment immediately preceding a declaration,
	 * whitespace-collapsed and capped ~120 chars — the highest-signal token for an
	 * agent deciding which symbol to read (#512). Structural, not per-language:
	 * walks contiguous preceding-sibling `comment` nodes (same traversal shape as
	 * `extractDecorators`), stopping at the nearest non-comment/non-decorator named
	 * sibling, and takes the LAST contiguous comment block (the one directly above
	 * the declaration — an earlier unrelated comment separated by blank lines still
	 * parses as a preceding sibling, but a real gap makes it not "attached").
	 * JSDoc/TSDoc block comments strip the leading/trailing block markers and
	 * per-line `*` gutters; plain `//`/`#` line comments strip the marker only.
	 * Returns undefined when no comment is directly attached. Returns both the
	 * summarized text (`doc`) and the 1-based start line of the attached comment
	 * block (`docStartLine`, #523) — readSymbol extends its returned range to that
	 * line so an agent reading a symbol sees its contract, not just its body.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter node
	private extractDocCommentInfo(
		declNode: any,
	): { text: string; startLine: number } | undefined {
		const isComment = (n: any): boolean =>
			!!n && n.type === TreeSitterSymbolExtractor.COMMENT_NODE_KIND;
		const isDeco = (n: any) =>
			!!n && TreeSitterSymbolExtractor.DECORATOR_NODE_KINDS.has(n.type);
		// web-tree-sitter materializes a NEW node object on every `.children`/
		// `.parent` access (no stable identity), so siblings must be located by
		// START POSITION, never by reference (`===`) — same reasoning as
		// `startIndex` comparisons in `extractDecorators`.
		const samePos = (a: any, b: any) =>
			a?.startPosition?.row === b?.startPosition?.row &&
			a?.startPosition?.column === b?.startPosition?.column;
		const sameStartRow = (a: any, b: any) =>
			a?.startPosition?.row === b?.startPosition?.row;

		// `export function foo() {}` wraps the declaration in an `export_statement`
		// (JS/TS) / `export_declaration` node that starts on the SAME LINE as the
		// declaration (earlier column — the `export` keyword) — the doc comment
		// sits before the wrapper, not before the inner declaration. Walk up
		// through same-line wrappers (mirrors `hasExportModifier`'s upward walk
		// for the same shape) so the comment search anchors on the outermost node
		// that actually starts the line.
		let node = declNode;
		for (let hops = 0; hops < 4; hops++) {
			const parent = node.parent;
			if (!parent || !sameStartRow(parent, node)) break;
			node = parent;
		}

		const siblings: any[] = node.parent?.children ?? [];
		const idx = siblings.findIndex((s) => samePos(s, node));
		if (idx <= 0) return undefined;

		// Walk backwards from the declaration, skipping decorators/annotations
		// (Python/TS often have `@decorator` between the doc comment and the def),
		// collecting a contiguous run of comment nodes with no other named node
		// (and no blank-line gap) in between. `boundaryRow` is the start row of
		// the closest already-accepted neighbor (the declaration itself, or the
		// decorator block above it) — a candidate comment separated from THAT
		// row by a blank line is rejected even when it's the only candidate.
		let cursor = idx - 1;
		while (cursor >= 0 && isDeco(siblings[cursor])) cursor--;
		let boundaryRow: number | undefined = node.startPosition?.row;
		let end = -1; // inclusive end index of the accepted comment run
		let start = -1; // inclusive start index of the accepted comment run
		while (cursor >= 0 && isComment(siblings[cursor])) {
			const candidate = siblings[cursor];
			const gapRows =
				boundaryRow !== undefined && typeof candidate.endPosition?.row === "number"
					? boundaryRow - candidate.endPosition.row
					: 0;
			if (gapRows > 1) break; // separated by a blank line — not attached
			if (end < 0) end = cursor;
			start = cursor;
			boundaryRow = candidate.startPosition?.row;
			cursor--;
		}
		if (start < 0 || end < 0) return undefined;

		const raw = siblings
			.slice(start, end + 1)
			.map((n) => String(n.text ?? ""))
			.join("\n");
		const text = this.summarizeDocComment(raw);
		if (!text) return undefined;
		const startLine = (siblings[start].startPosition?.row ?? 0) + 1;
		return { text, startLine };
	}

	private static readonly DOC_MAX_CHARS = 120;

	/** Strip comment markers, take the first sentence (or first line if no
	 * sentence terminator), collapse whitespace, cap at ~120 chars. */
	private summarizeDocComment(raw: string): string | undefined {
		const cleaned = raw
			.replace(/^\s*\/\*\*?/, "")
			.replace(/\*\/\s*$/, "")
			.split(/\r?\n/)
			.map((line) => line.replace(/^\s*(\*|\/\/\/?|#)\s?/, "").trimEnd())
			.filter((line) => line.trim().length > 0)
			.join(" ")
			.trim();
		if (!cleaned) return undefined;

		// First sentence: up to the first `. ` / `! ` / `? ` followed by a capital
		// or end-of-string, else the whole cleaned text.
		const sentenceMatch = cleaned.match(/^.*?[.!?](?:\s|$)/);
		let first = (sentenceMatch ? sentenceMatch[0] : cleaned).trim();
		first = first.replace(/\s+/g, " ");
		if (first.length > TreeSitterSymbolExtractor.DOC_MAX_CHARS) {
			first = `${first.slice(0, TreeSitterSymbolExtractor.DOC_MAX_CHARS - 1).trimEnd()}…`;
		}
		return first || undefined;
	}

	/**
	 * Structural async/suspend detection: an `async` keyword node (Python/JS/TS
	 * have it as a direct child of the declaration) or `async`/`suspend` inside a
	 * `*modifiers*` container (Rust `function_modifiers`, Kotlin/Java/C#
	 * `modifiers`). Conservative — a grammar that spells it differently just
	 * yields false (no false positives).
	 */
	// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter node
	private isAsyncDecl(node: any): boolean {
		const isAsyncTok = (n: any): boolean =>
			!!n &&
			(n.type === "async" ||
				n.type === "suspend" ||
				(/modifier/.test(String(n.type)) &&
					/^(?:async|suspend)$/.test(String(n.text ?? "").trim())));
		for (const child of node.children ?? []) {
			if (isAsyncTok(child)) return true;
			if (/modifiers/.test(String(child?.type))) {
				for (const gc of child.children ?? []) {
					if (isAsyncTok(gc)) return true;
				}
			}
		}
		return false;
	}

	// Decorator/attribute/annotation node kinds across grammars. Python/TS/JS use
	// `decorator`; Rust `attribute_item`; Java/Kotlin/C# `marker_annotation` /
	// `annotation` (often nested inside a `modifiers` container).
	private static readonly DECORATOR_NODE_KINDS = new Set([
		"decorator",
		"attribute_item",
		"marker_annotation",
		"annotation",
	]);
	// Containers that hold annotations as children (Java/Kotlin `modifiers`).
	private static readonly MODIFIERS_CONTAINER_KINDS = new Set(["modifiers"]);

	/**
	 * Decorators/attributes/annotations attached to a declaration node, in source
	 * order. Structural (tree-sitter), not text heuristics, so it handles the three
	 * placement shapes seen across grammars:
	 *   - preceding siblings: Python (`decorated_definition` children), Rust
	 *     (`attribute_item`), TS methods (`decorator`);
	 *   - own children: TS class decorators;
	 *   - nested in a `modifiers` container: Java/Kotlin/C# annotations.
	 * Languages without these node kinds simply yield none.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter node
	private extractDecorators(node: any): string[] {
		const isDeco = (n: any) =>
			!!n && TreeSitterSymbolExtractor.DECORATOR_NODE_KINDS.has(n.type);
		const text = (n: any): string => {
			const first = String(n?.text ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
			return first.length > 120 ? `${first.slice(0, 117)}…` : first;
		};
		const out: string[] = [];

		// (1) Contiguous decorator siblings immediately before the declaration.
		// Children are in source order, so collect decorators and reset on any
		// other NAMED sibling — leaving only the block directly above `node`.
		for (const sib of node.parent?.children ?? []) {
			if (sib.startIndex >= node.startIndex) break; // preceding only
			if (isDeco(sib)) out.push(text(sib));
			else if (sib.isNamed) out.length = 0;
		}

		// (2) Own leading children: TS class decorators, or annotations nested in a
		// `modifiers` container (Java/Kotlin).
		for (const child of node.children ?? []) {
			if (isDeco(child)) out.push(text(child));
			else if (TreeSitterSymbolExtractor.MODIFIERS_CONTAINER_KINDS.has(child?.type)) {
				for (const gc of child.children ?? []) {
					if (isDeco(gc)) out.push(text(gc));
				}
			}
		}

		return [...new Set(out.filter(Boolean))].slice(0, 8);
	}

	// biome-ignore lint/suspicious/noExplicitAny: Match type
	private parseRefMatch(match: any, filePath: string): SymbolRef | null {
		let name: string | undefined;
		let refNode: { startPosition: { row: number; column: number } } | undefined;

		for (const capture of match.captures) {
			if (
				capture.name.endsWith("Ident") ||
				capture.name.endsWith("Method") ||
				capture.name.endsWith("Field")
			) {
				name = capture.node.text;
				// biome-ignore lint/suspicious/noExplicitAny: Node type
				refNode = capture.node as any;
			}
			if (capture.name.endsWith("Ref") && !refNode) {
				// biome-ignore lint/suspicious/noExplicitAny: Node type
				refNode = capture.node as any;
			}
		}

		if (!name || !refNode) return null;

		return {
			symbolId: `${filePath}:${name}`, // Will be resolved later
			filePath,
			line: refNode.startPosition.row + 1,
			column: refNode.startPosition.column + 1,
		};
	}

	// biome-ignore lint/suspicious/noExplicitAny: Node type
	private isExported(node: any, content: string): boolean {
		// A symbol is exported only at module scope. Anchor the keyword at the
		// START of the declaration line (so `const exportName = …`, or "export"
		// inside a comment, doesn't count), and require the AST walk to reach an
		// export statement WITHOUT crossing a function body.
		const lines = content.split("\n");
		const lineIdx = node.startPosition.row;
		const line = lines[lineIdx] || "";
		return /^\s*export\b/.test(line) || this.hasExportModifier(node, content);
	}

	// biome-ignore lint/suspicious/noExplicitAny: Node type
	private hasExportModifier(node: any, _content: string): boolean {
		// Walk up to an export statement, but bail the moment we cross a function
		// or block body (`statement_block`): a symbol nested inside an exported
		// function is a LOCAL, not a module export (the #256 false-API bug). Class
		// members stay exported — they live in a `class_body`, not a
		// `statement_block`, on the path to the enclosing export.
		let current = node.parent;
		while (current) {
			if (current.type === "statement_block") return false;
			if (
				current.type === "export_statement" ||
				current.type === "export_declaration"
			) {
				return true;
			}
			current = current.parent;
		}
		return false;
	}

	// biome-ignore lint/suspicious/noExplicitAny: Node type
	private isFunctionLocal(node: any): boolean {
		// A symbol is function-local when its nearest enclosing scope is a
		// function/block body (`statement_block`) — the same boundary the export
		// walk treats as "not a module export" (#256). Class members live in a
		// `class_body`, module-level declarations reach the program root, so neither
		// is local. TS/JS-shaped: other grammars don't use `statement_block`, so
		// `local` simply stays false there (#259, scoped to where it's detectable).
		let current = node.parent;
		while (current) {
			if (current.type === "statement_block") return true;
			current = current.parent;
		}
		return false;
	}

	// biome-ignore lint/suspicious/noExplicitAny: Node type
	private detectVisibility(
		node: any,
		nameText: string,
	): "private" | "protected" | undefined {
		// #-prefixed names are hard-private (works even if a grammar surfaces the
		// name as a private_property_identifier).
		if (nameText.startsWith("#")) return "private";
		// TS `private`/`protected`/`public foo()` carry an `accessibility_modifier`
		// child on the method node. The node type is TS-specific, so this is inert
		// for grammars without it (no faked visibility — #258).
		for (const child of node?.children ?? []) {
			if (child?.type === "accessibility_modifier") {
				if (child.text === "private") return "private";
				if (child.text === "protected") return "protected";
				return undefined; // explicit public
			}
		}
		return undefined;
	}

	private extractSignature(
		paramsText: string,
		kind: SymbolKind,
	): string | undefined {
		if (kind === "function" || kind === "method") {
			// Clean up params: remove comments, normalize whitespace
			return paramsText
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "")
				.replace(/\s+/g, " ")
				.trim();
		}
		return undefined;
	}
}
