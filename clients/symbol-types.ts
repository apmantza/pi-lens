/**
 * Symbol types for pi-lens
 * Shared between SymbolService and runners
 */

export type SymbolKind =
	| "function"
	| "class"
	| "variable"
	| "interface"
	| "type"
	| "method"
	| "property";

export interface Symbol {
	id: string; // filePath:name:kind (unique identifier)
	name: string;
	kind: SymbolKind;
	filePath: string;
	line: number;
	/** 1-based last line of the definition (inclusive). Drives module-report
	 * read ranges and the read-guard's `enclosingSymbol` coverage. */
	endLine?: number;
	column: number;
	signature?: string; // For functions: "(a: T, b: U) => R"
	isExported: boolean;
	/**
	 * Access visibility when the language exposes a REAL, detectable modifier
	 * (TS/JS `private`/`protected`/`#`). Undefined = public or not applicable —
	 * never faked for convention-only languages (Python `_name`, Go casing).
	 * module-report routes private/protected members of an exported class to
	 * `internal` rather than the public `api` (#258).
	 */
	visibility?: "private" | "protected";
	/**
	 * True when the symbol is declared inside a function/block body (a
	 * function-local), as opposed to a module-level declaration or a class
	 * member. module-report drops locals from its outline (#259); the review
	 * graph keeps the full symbol set regardless, so its edges are unaffected.
	 */
	local?: boolean;
	doc?: string; // JSDoc comment if available
	/**
	 * 1-based start line of the attached doc-comment block that `doc` was
	 * summarized from (same attachment computation — position-based, blank-line-
	 * gap aware). Undefined when no doc comment is attached. Lets a body reader
	 * (readSymbol) extend its returned range to include the comment (#523) without
	 * re-deriving attachment.
	 */
	docStartLine?: number;
	/**
	 * Decorators / attributes / annotations attached to the declaration, in source
	 * order (e.g. `@app.get("/x")`, `#[tokio::main]`, `@Override`). Tells an agent
	 * a symbol's ROLE (route/test/fixture/entrypoint) without reading its body.
	 * Language-uniform over the tree-sitter declaration node; omitted when none.
	 */
	decorators?: string[];
	/**
	 * True when the declaration is an async/suspend function or method — a
	 * concurrency boundary where await points and lifecycle bugs live. Detected
	 * structurally (an `async` keyword node, or `async`/`suspend` in a modifiers
	 * container); conservative, so it's false-negative-safe for grammars that
	 * spell it differently. Omitted when false.
	 */
	isAsync?: boolean;
}

export interface SymbolRef {
	symbolId: string; // Reference to which symbol (by id)
	filePath: string;
	line: number;
	column: number;
	context?: string; // Surrounding line for context
}

export interface SymbolIndex {
	version: string;
	createdAt: string;
	symbols: Map<string, Symbol>; // symbolId -> Symbol
	refs: Map<string, SymbolRef[]>; // symbolId -> references
	byFile: Map<string, string[]>; // filePath -> symbolIds in that file
}

export interface CallEdge {
	caller: string; // symbolId of caller
	callerFile: string;
	callerLine: number;
	callerColumn: number;
	callee: string; // symbolId or external name
	calleeResolved: boolean; // true if callee is in project symbols
}

export interface CallGraph {
	edges: CallEdge[];
	adjacency: Map<string, string[]>; // caller symbolId -> callees
	reverse: Map<string, string[]>; // callee symbolId -> callers
	cycles: string[][]; // Detected circular call chains
	orphans: string[]; // Symbols defined but never called
	entryPoints: string[]; // Symbols called but never defined (exports, main)
}

// Serializable versions for JSON storage
export interface SerializableSymbolIndex {
	version: string;
	createdAt: string;
	symbols: [string, Symbol][];
	refs: [string, SymbolRef[]][];
	byFile: [string, string[]][];
}

export interface SerializableCallGraph {
	edges: CallEdge[];
	adjacency: [string, string[]][];
	reverse: [string, string[]][];
	cycles: string[][];
	orphans: string[];
	entryPoints: string[];
}
