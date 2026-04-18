/**
 * Symbol extraction via tree-sitter queries
 * Extracts definitions and references from source files
 */

import * as path from "node:path";
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
};

export interface ExtractedSymbols {
	symbols: Symbol[];
	refs: SymbolRef[];
}

export class TreeSitterSymbolExtractor {
	private languageId: string;
	private client: TreeSitterClient;
	// biome-ignore lint/suspicious/noExplicitAny: Query type from web-tree-sitter
	private defQuery: any;
	// biome-ignore lint/suspicious/noExplicitAny: Query type from web-tree-sitter
	private refQuery: any;

	constructor(languageId: string, client: TreeSitterClient) {
		this.languageId = languageId;
		this.client = client;
	}

	async init(): Promise<boolean> {
		try {
			// Get language from client
			const language = this.client.getLanguage(this.languageId);
			if (!language) return false;

			const { Query } = await import("web-tree-sitter");
			const queries = SYMBOL_QUERIES[this.languageId];
			if (!queries) return false;

			// biome-ignore lint/suspicious/noExplicitAny: Language type
			this.defQuery = new Query(language as any, queries.defs);
			// biome-ignore lint/suspicious/noExplicitAny: Language type
			this.refQuery = new Query(language as any, queries.refs);
			return true;
		} catch (err) {
			console.error(
				`[symbol-extractor] Failed to init ${this.languageId}:`,
				err,
			);
			return false;
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

		// Extract definitions
		const defMatches = this.defQuery.matches(tree.rootNode);
		for (const match of defMatches) {
			const symbol = this.parseDefMatch(match, relativePath, content);
			if (symbol) symbols.push(symbol);
		}

		// Extract references
		const refMatches = this.refQuery.matches(tree.rootNode);
		for (const match of refMatches) {
			const ref = this.parseRefMatch(match, relativePath);
			if (ref) refs.push(ref);
		}

		return { symbols, refs };
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
		let defNode: { startPosition: { row: number; column: number } } | undefined;

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

		return {
			id: `${filePath}:${name}`,
			name,
			kind,
			filePath,
			line: defNode.startPosition.row + 1,
			column: defNode.startPosition.column + 1,
			signature,
			isExported,
		};
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
		// Simple heuristic: check for "export" keyword before the node
		const lines = content.split("\n");
		const lineIdx = node.startPosition.row;
		const line = lines[lineIdx] || "";
		return line.includes("export") || this.hasExportModifier(node, content);
	}

	// biome-ignore lint/suspicious/noExplicitAny: Node type
	private hasExportModifier(_node: any, _content: string): boolean {
		// TODO: Implement proper export modifier detection
		// For now, use simple line-based check
		return false;
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
