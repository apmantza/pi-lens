/**
 * Tree-sitter Structural Search Client for pi-lens
 *
 * Inspired by pi-lsp-extension's search-engine.ts and pattern-compiler.ts
 * Provides AST-aware structural search with metavariable capture.
 *
 * Uses web-tree-sitter (WASM) for parsing - no native compilation needed.
 *
 * Pattern syntax:
 *   $NAME    - Matches any single AST node, captures as NAME
 *   $$$NAME  - Matches zero or more sibling nodes (variadic)
 *
 * Example:
 *   "console.log($MSG)" matches any console.log call, captures argument as MSG
 *   "function $NAME($$$PARAMS) { $BODY }" matches function declarations
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isExcludedDirName } from "./file-utils.js";
import { resolvePackagePath } from "./package-root.js";
import { TreeCache } from "./tree-sitter-cache.js";
import { TreeSitterNavigator } from "./tree-sitter-navigator.js";
import {
	type TreeSitterQuery,
	TreeSitterQueryLoader,
} from "./tree-sitter-query-loader.js";

// --- Type Declarations (local, no import needed) ---

// biome-ignore lint/suspicious/noExplicitAny: Language from web-tree-sitter
type TreeSitterLanguage = any;

interface TreeSitterTree {
	rootNode: TreeSitterNode;
}

interface TreeSitterNode {
	type: string;
	text: string;
	children: TreeSitterNode[];
	isNamed: boolean;
	childCount: number;
	startPosition: { row: number; column: number };
	startIndex: number;
	endIndex: number;
}

interface TreeSitterParserInstance {
	setLanguage: (lang: TreeSitterLanguage) => void;
	parse: (content: string) => TreeSitterTree;
}

// biome-ignore lint/suspicious/noExplicitAny: Module type
const _LanguageLoader: any = null;

// --- WASM Grammar Mapping ---

const LANGUAGE_TO_GRAMMAR: Record<string, string> = {
	typescript: "tree-sitter-typescript.wasm",
	tsx: "tree-sitter-tsx.wasm",
	javascript: "tree-sitter-javascript.wasm",
	python: "tree-sitter-python.wasm",
	rust: "tree-sitter-rust.wasm",
	go: "tree-sitter-go.wasm",
	java: "tree-sitter-java.wasm",
	c: "tree-sitter-c.wasm",
	cpp: "tree-sitter-cpp.wasm",
	ruby: "tree-sitter-ruby.wasm",
};

// --- Types ---

export interface StructuralMatch {
	file: string;
	line: number;
	column: number;
	matchedText: string;
	captures: Record<string, string>;
}

export interface SearchPattern {
	pattern: string;
	language: string;
	metavars: string[];
}

// --- Parser Manager ---

export class TreeSitterClient {
	private initialized = false;
	private initPromise: Promise<boolean> | null = null;
	private languages: Map<string, TreeSitterLanguage> = new Map();
	private parsers: Map<string, TreeSitterParserInstance> = new Map();
	private treeCache: TreeCache;
	private navigator = new TreeSitterNavigator();
	private grammarsDir: string;
	// biome-ignore lint/suspicious/noExplicitAny: Optional dependency loaded dynamically
	private ParserClass: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: Language loader from module
	private LanguageLoader: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: Compiled query cache by language+pattern hash
	private queryCache = new Map<string, any>();
	private queryLoader = new TreeSitterQueryLoader();
	private verbose: boolean;

	constructor(verbose = false) {
		this.grammarsDir = this.findGrammarsDir();
		this.verbose = verbose;
		this.treeCache = new TreeCache(50, verbose);
	}

	/** Debug logging helper */
	private dbg(msg: string): void {
		if (this.verbose) {
			console.error(`[tree-sitter] ${msg}`);
		}
	}

	/** Find tree-sitter grammar directory */
	private findGrammarsDir(): string {
		const pkgGrammars = resolvePackagePath(
			import.meta.url,
			"node_modules",
			"web-tree-sitter",
			"grammars",
		);
		const downloadedGrammars = [
			path.join(process.cwd(), "node_modules", "web-tree-sitter", "grammars"),
			pkgGrammars,
		];

		for (const dir of downloadedGrammars) {
			if (
				fs.existsSync(dir) &&
				fs.existsSync(path.join(dir, "tree-sitter-typescript.wasm"))
			) {
				return dir;
			}
		}

		const candidates: string[] = [
			path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out"),
			resolvePackagePath(
				import.meta.url,
				"node_modules",
				"tree-sitter-wasms",
				"out",
			),
		];

		for (const dir of candidates) {
			if (fs.existsSync(dir)) return dir;
		}

		return pkgGrammars;
	}

	/** Initialize tree-sitter WASM runtime */
	async init(): Promise<boolean> {
		if (this.initialized) return true;
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			try {
				const mod = await import("web-tree-sitter");
				// biome-ignore lint/suspicious/noExplicitAny: Dynamic import of optional dependency
				const ParserClass = mod.Parser || mod.default || mod;
				if (!ParserClass || typeof ParserClass.init !== "function") {
					this.dbg("Parser class not found or missing init method");
					return false;
				}

				// biome-ignore lint/suspicious/noExplicitAny: Parser class type
				this.ParserClass = ParserClass as any;
				// Store Language loader from module (not from Parser)
				this.LanguageLoader = mod.Language;

				// Log what we're trying to load
				const wasmPath = resolvePackagePath(
					import.meta.url,
					"node_modules",
					"web-tree-sitter",
					"tree-sitter.wasm",
				);
				this.dbg(
					`Looking for WASM at: ${wasmPath}, exists: ${fs.existsSync(wasmPath)}`,
				);

				await ParserClass.init({
					locateFile: (scriptName: string) => {
						const fullPath = resolvePackagePath(
							import.meta.url,
							"node_modules",
							"web-tree-sitter",
							scriptName,
						);
						this.dbg(`locateFile: ${scriptName} -> ${fullPath}`);
						return fullPath;
					},
				});
				this.initialized = true;
				return true;
			} catch (err) {
				this.dbg(`Init error: ${err}`);
				return false;
			} finally {
				this.initPromise = null;
			}
		})();

		return this.initPromise;
	}

	/** Load language grammar */
	private async loadLanguage(
		languageId: string,
	): Promise<TreeSitterLanguage | null> {
		this.dbg(`Loading language: ${languageId}`);

		if (this.languages.has(languageId)) {
			this.dbg(`Language ${languageId} already loaded`);
			return this.languages.get(languageId)!;
		}

		if (!this.ParserClass) {
			this.dbg(`ParserClass not initialized`);
			return null;
		}

		const grammarFile = LANGUAGE_TO_GRAMMAR[languageId];
		if (!grammarFile) {
			this.dbg(`No grammar file for ${languageId}`);
			return null;
		}

		const grammarPath = path.join(this.grammarsDir, grammarFile);
		this.dbg(
			`Grammar path: ${grammarPath}, exists: ${fs.existsSync(grammarPath)}`,
		);

		if (!fs.existsSync(grammarPath)) {
			this.dbg(`Grammar file not found: ${grammarPath}`);
			return null;
		}

		try {
			if (!this.LanguageLoader?.load) {
				this.dbg(`LanguageLoader.load not available`);
				return null;
			}
			this.dbg(`Calling Language.load...`);
			const language = await this.LanguageLoader.load(grammarPath);
			this.dbg(`Language loaded: ${language?.name || "unknown"}`);
			if (language) {
				this.languages.set(languageId, language);
			}
			return language;
		} catch (err) {
			this.dbg(`Language load error: ${err}`);
			return null;
		}
	}

	/** Get or create parser for a language */
	private async getParser(
		languageId: string,
	): Promise<TreeSitterParserInstance | null> {
		if (this.parsers.has(languageId)) {
			return this.parsers.get(languageId)!;
		}

		const language = await this.loadLanguage(languageId);
		if (!language || !this.ParserClass) return null;

		const parser = new this.ParserClass();
		parser.setLanguage(language);
		this.parsers.set(languageId, parser);
		return parser;
	}

	/** Parse a file and return the AST tree */
	async parseFile(
		filePath: string,
		languageId: string,
	): Promise<TreeSitterTree | null> {
		this.dbg(`Parsing ${filePath} with language ${languageId}`);
		const parser = await this.getParser(languageId);
		if (!parser) {
			this.dbg(`Failed to get parser for ${languageId}`);
			return null;
		}

		try {
			const content = fs.readFileSync(filePath, "utf-8");
			this.dbg(`File content length: ${content.length}`);

			// Check cache first
			const cachedTree = this.treeCache.get(filePath, content, languageId);
			if (cachedTree) {
				this.dbg(`Using cached tree for ${filePath}`);
				return cachedTree;
			}

			// Parse and cache
			const tree = parser.parse(content);
			this.dbg(`Parsed, root node type: ${tree.rootNode.type}`);

			// Cache the tree
			this.treeCache.set(filePath, content, languageId, tree);

			return tree;
		} catch (err) {
			this.dbg(`Parse error: ${err}`);
			return null;
		}
	}

	/**
	 * Detect and extract injected content from template literals
	 * Used for security analysis (SQL injection, unsafe regex, etc.)
	 */
	extractInjections(
		filePath: string,
		content: string,
	): Array<{
		type: "sql" | "css" | "html" | "gql" | "regex";
		content: string;
		line: number;
		column: number;
	}> {
		const injections: Array<{
			type: "sql" | "css" | "html" | "gql" | "regex";
			content: string;
			line: number;
			column: number;
		}> = [];

		// Pattern: sql`SELECT * FROM users` or query`...`
		const sqlPattern = /\b(sql|query|execute)\s*`([^`]+)`/gi;
		let match: RegExpExecArray | null;
		while ((match = sqlPattern.exec(content)) !== null) {
			const lines = content.slice(0, match.index).split("\n");
			injections.push({
				type: "sql",
				content: match[2],
				line: lines.length,
				column: lines[lines.length - 1].length,
			});
		}

		// Pattern: styled.div`color: red;` or css`...`
		const cssPattern = /\b(styled(?:\.\w+)?|css)\s*`([^`]+)`/gi;
		while ((match = cssPattern.exec(content)) !== null) {
			const lines = content.slice(0, match.index).split("\n");
			injections.push({
				type: "css",
				content: match[2],
				line: lines.length,
				column: lines[lines.length - 1].length,
			});
		}

		// Pattern: new RegExp(`pattern`)
		const regexPattern = /new\s+RegExp\s*\(\s*`([^`]+)`/gi;
		while ((match = regexPattern.exec(content)) !== null) {
			const lines = content.slice(0, match.index).split("\n");
			injections.push({
				type: "regex",
				content: match[1],
				line: lines.length,
				column: lines[lines.length - 1].length,
			});
		}

		this.dbg(`Found ${injections.length} injections in ${filePath}`);
		return injections;
	}

	/** Check if tree-sitter is available (grammars installed) */
	isAvailable(): boolean {
		return fs.existsSync(this.grammarsDir);
	}

	/** Check if specific language is supported */
	async isLanguageSupported(languageId: string): Promise<boolean> {
		if (!this.initialized) await this.init();
		const language = await this.loadLanguage(languageId);
		return language !== null;
	}

	/** Get loaded language for symbol extraction */
	getLanguage(languageId: string): TreeSitterLanguage | null {
		return this.languages.get(languageId) || null;
	}

	// --- Structural Search ---

	/**
	 * Search for a structural pattern in files
	 *
	 * @param pattern - Pattern with metavariables (e.g., "console.log($MSG)")
	 * @param languageId - Language ID (typescript, python, etc.)
	 * @param rootDir - Directory to search
	 * @param options - Search options
	 * @returns Array of matches with captures
	 */
	async structuralSearch(
		pattern: string,
		languageId: string,
		rootDir: string,
		options: {
			maxResults?: number;
			fileFilter?: (path: string) => boolean;
		} = {},
	): Promise<StructuralMatch[]> {
		if (!this.initialized) {
			const ok = await this.init();
			if (!ok) return [];
		}

		try {
			await this.queryLoader.loadQueries(rootDir);
		} catch (err) {
			this.dbg(`Failed to load queries for ${rootDir}: ${err}`);
		}

		// Compile pattern into tree-sitter query
		this.dbg(`Compiling pattern: ${pattern.slice(0, 50)}...`);
		const compiled = await this.compileQuery(pattern, languageId);
		if (!compiled) {
			this.dbg(`Pattern compilation failed`);
			return [];
		}
		this.dbg(`Pattern compiled, metavars: ${compiled.metavars.join(", ")}`);

		// Collect source files
		const files = this.collectFiles(rootDir, languageId, options.fileFilter);
		this.dbg(`Scanning ${files.length} files...`);

		const matches: StructuralMatch[] = [];
		const maxResults = options.maxResults ?? 50;

		for (const file of files) {
			if (matches.length >= maxResults) break;

			const fileMatches = await this.searchFileWithQuery(
				file,
				compiled.query,
				compiled.metavars,
				languageId,
				pattern,
				compiled.postFilter,
				compiled.postFilterParams,
			);
			matches.push(...fileMatches);
		}

		return matches.slice(0, maxResults);
	}

	/**
	 * Run a preloaded query definition against a single file.
	 *
	 * Optimized for dispatch runner usage to avoid per-query directory scans.
	 */
	async runQueryOnFile(
		queryDef: TreeSitterQuery,
		filePath: string,
		languageId: string,
		options: { maxResults?: number } = {},
	): Promise<StructuralMatch[]> {
		if (!this.initialized) {
			const ok = await this.init();
			if (!ok) return [];
		}

		const compiled = await this.compileRawQuery(
			queryDef.id,
			queryDef.query,
			queryDef.metavars,
			queryDef.language || languageId,
			queryDef.post_filter,
			queryDef.post_filter_params,
		);
		if (!compiled) return [];

		const matches = await this.searchFileWithQuery(
			filePath,
			compiled.query,
			compiled.metavars,
			languageId,
			queryDef.id,
			compiled.postFilter,
			compiled.postFilterParams,
		);

		const maxResults = options.maxResults ?? 50;
		return matches.slice(0, maxResults);
	}

	/**
	 * Convert pattern to tree-sitter query
	 * First tries to load from query files, then falls back to inline patterns
	 */
	private patternToQuery(
		pattern: string,
		languageId: string,
	): {
		query: string;
		metavars: string[];
		postFilter?: string;
		// biome-ignore lint/suspicious/noExplicitAny: Post filter params
		postFilterParams?: any;
		queryDef?: TreeSitterQuery;
	} {
		// Try to find matching query from loaded files
		const loadedQuery = this.queryLoader.findMatchingQuery(pattern, languageId);

		if (loadedQuery) {
			this.dbg(`Using loaded query: ${loadedQuery.id}`);
			return {
				query: loadedQuery.query,
				metavars: loadedQuery.metavars,
				postFilter: loadedQuery.post_filter,
				postFilterParams: loadedQuery.post_filter_params,
				queryDef: loadedQuery,
			};
		}

		// Fallback to inline patterns
		return this.getInlinePattern(pattern);
	}

	/**
	 * Inline patterns as fallback when no query file matches
	 */
	private getInlinePattern(pattern: string): {
		query: string;
		metavars: string[];
		postFilter?: string;
		// biome-ignore lint/suspicious/noExplicitAny: Post filter params
		postFilterParams?: any;
	} {
		// Pattern: async function $NAME($$$PARAMS) { $BODY }
		if (pattern.includes("async function") && pattern.includes("$NAME")) {
			return {
				query: `(function_declaration
					"async"
					name: (identifier) @NAME
					parameters: (formal_parameters) @PARAMS
					body: (statement_block) @BODY)`,
				metavars: ["NAME", "PARAMS", "BODY"],
			};
		}

		// Pattern: console.$METHOD($MSG)
		if (pattern.includes("console")) {
			return {
				query: `(call_expression
					function: (member_expression
						object: (identifier) @OBJ (#eq? @OBJ "console")
						property: (property_identifier) @METHOD)
					arguments: (arguments) @ARGS)`,
				metavars: ["OBJ", "METHOD", "ARGS"],
			};
		}

		// Pattern: function $NAME($$$PARAMS) { $BODY } - match long parameter lists
		if (pattern.includes("function $NAME") && pattern.includes("PARAMS")) {
			return {
				query: `(function_declaration
					name: (identifier) @NAME
					parameters: (formal_parameters) @PARAMS
					body: (statement_block) @BODY)`,
				metavars: ["NAME", "PARAMS", "BODY"],
				postFilter: "count_params",
				postFilterParams: { min_params: 6 },
			};
		}

		// Pattern: promise chains with .then().catch().then() - 3+ levels
		if (pattern.includes(".then") && pattern.includes(".catch")) {
			return {
				query: `(call_expression
					function: (member_expression
						object: (call_expression
							function: (member_expression
								object: (call_expression
									function: (member_expression
										property: (property_identifier) @M1)
									arguments: (arguments))
								property: (property_identifier) @M2)
							arguments: (arguments))
						property: (property_identifier) @M3)
					arguments: (arguments))
					(#match? @M1 "^(then|catch)$")
					(#match? @M2 "^(then|catch)$")
					(#match? @M3 "^(then|catch)$")`,
				metavars: ["M1", "M2", "M3"],
			};
		}

		// Fallback: try to create a simple identifier capture
		const simpleMatch = pattern.match(/\$([A-Z_][A-Z0-9_]*)/);
		if (simpleMatch) {
			const name = simpleMatch[1];
			return {
				query: `(identifier) @${name}`,
				metavars: [name],
			};
		}

		// If we can't convert, return empty to trigger fallback
		return { query: "", metavars: [] };
	}

	/**
	 * Inject native tree-sitter predicates into S-expression query
	 * This moves text filtering to WASM for better performance
	 */
	/** Generate cache key for compiled query */
	private getQueryCacheKey(pattern: string, languageId: string): string {
		// Simple hash for the query string
		let hash = 0;
		for (let i = 0; i < pattern.length; i++) {
			const char = pattern.charCodeAt(i);
			hash = ((hash << 5) - hash + char) | 0;
		}
		return `${languageId}:${hash.toString(36)}`;
	}

	/** Compile a pattern into a tree-sitter Query with caching */
	private async compileQuery(
		pattern: string,
		languageId: string,
	): Promise<{
		query: any;
		metavars: string[];
		postFilter?: string;
		postFilterParams?: unknown;
	} | null> {
		const cacheKey = this.getQueryCacheKey(pattern, languageId);

		// Check cache first
		if (this.queryCache.has(cacheKey)) {
			this.dbg(`Query cache hit: ${cacheKey}`);
			return this.queryCache.get(cacheKey);
		}

		const language = await this.loadLanguage(languageId);
		if (!language) {
			this.dbg(`Could not load language ${languageId}`);
			return null;
		}

		const {
			query: queryStr,
			metavars,
			postFilter,
			postFilterParams,
		} = this.patternToQuery(pattern, languageId);
		this.dbg(`Query string: ${queryStr.slice(0, 100)}...`);

		try {
			// biome-ignore lint/suspicious/noExplicitAny: Query constructor
			const Query = (await import("web-tree-sitter")).Query;
			// biome-ignore lint/suspicious/noExplicitAny: Language type compatibility
			const query = new Query(language as any, queryStr);
			this.dbg(`Query compiled with ${query.patternCount} patterns`);

			const result = { query, metavars, postFilter, postFilterParams };
			// Cache the compiled query
			this.queryCache.set(cacheKey, result);
			return result;
		} catch (err) {
			this.dbg(`Query compilation failed: ${err}`);
			return null;
		}
	}

	/** Compile a raw tree-sitter query string with caching */
	private async compileRawQuery(
		queryId: string,
		queryStr: string,
		metavars: string[],
		languageId: string,
		postFilter?: string,
		postFilterParams?: unknown,
	): Promise<{
		query: any;
		metavars: string[];
		postFilter?: string;
		postFilterParams?: unknown;
	} | null> {
		const cacheKey = this.getQueryCacheKey(`raw:${queryId}:${queryStr}`, languageId);

		if (this.queryCache.has(cacheKey)) {
			return this.queryCache.get(cacheKey);
		}

		const language = await this.loadLanguage(languageId);
		if (!language) return null;

		try {
			// biome-ignore lint/suspicious/noExplicitAny: Query constructor from web-tree-sitter
			const Query = (await import("web-tree-sitter")).Query;
			// biome-ignore lint/suspicious/noExplicitAny: Language type compatibility
			const query = new Query(language as any, queryStr);
			const result = { query, metavars, postFilter, postFilterParams };
			this.queryCache.set(cacheKey, result);
			return result;
		} catch (err) {
			this.dbg(`Raw query compilation failed (${queryId}): ${err}`);
			return null;
		}
	}

	/** Search a single file using tree-sitter Query */
	private async searchFileWithQuery(
		filePath: string,
		// biome-ignore lint/suspicious/noExplicitAny: Query type from web-tree-sitter
		query: any,
		metavars: string[],
		languageId: string,
		_originalPattern?: string,
		postFilter?: string,
		// biome-ignore lint/suspicious/noExplicitAny: Post filter params
		postFilterParams?: any,
	): Promise<StructuralMatch[]> {
		const tree = await this.parseFile(filePath, languageId);
		if (!tree) return [];

		const matches: StructuralMatch[] = [];

		try {
			// Use tree-sitter's native query matching
			const queryMatches = query.matches(tree.rootNode);

			for (const match of queryMatches) {
				const captures: Record<string, TreeSitterNode> = {};

				// Extract captured metavariables (store nodes, not just text)
				for (const capture of match.captures) {
					const name = capture.name;
					const node = capture.node;
					if (metavars.includes(name)) {
						captures[name] = node;
					}
				}

				// Apply post-filters if specified
				if (postFilter === "count_params") {
					const paramsNode = captures.PARAMS;
					if (paramsNode) {
						// biome-ignore lint/suspicious/noExplicitAny: Count parameter nodes
						const paramCount = paramsNode.children.filter(
							(c: any) =>
								c.type === "required_parameter" ||
								c.type === "optional_parameter",
						).length;
						const minParams = postFilterParams?.min_params || 6;
						if (paramCount < minParams) continue;
					}
				}

				if (postFilter === "empty_body") {
					const bodyNode = captures.BODY;
					if (bodyNode) {
						// Check if body has meaningful statements (not just comments/braces)
						// biome-ignore lint/suspicious/noExplicitAny: Check for meaningful statements
						const meaningfulStatements = bodyNode.children.filter(
							(c: any) =>
								c.isNamed &&
								c.type !== "comment" &&
								c.type !== "line_comment" &&
								c.type !== "block_comment",
						);
						if (meaningfulStatements.length > 0) continue;
					}
				}

				if (postFilter === "bare_except_only") {
					const clauseNode = captures.CLAUSE;
					if (clauseNode) {
						// Check if this is a bare except (no identifier after except)
						// biome-ignore lint/suspicious/noExplicitAny: Check for identifier
						const hasIdentifier = clauseNode.children.some(
							(c: any) => c.isNamed && c.type === "identifier",
						);
						if (hasIdentifier) continue; // Skip if has identifier (not bare)
					}
				}

				if (postFilter === "has_mixed_async") {
					const bodyNode = captures.BODY;
					if (bodyNode) {
						const bodyText = bodyNode.text;
						// Check if body contains both await AND (.then() or .catch())
						const hasAwait = bodyText.includes("await");
						const hasPromiseChain = /\.\s*(then|catch)\s*\(/.test(bodyText);
						if (!hasAwait || !hasPromiseChain) continue; // Skip if not mixed
					}
				}

				if (postFilter === "no_super_call") {
					const bodyNode = captures.BODY;
					if (bodyNode) {
						// Check if body contains actual super() call (not in comments)
						const bodyText = bodyNode.text;
						// Match super() or super.method() but not // super() in comments
						const superCallRegex = /(?<!\/\/.*)super\s*\(/;
						const hasSuperCall = superCallRegex.test(bodyText);
						if (hasSuperCall) continue; // Skip if has super() - this is the GOOD case
					}
				}

				// Scope-aware: keep only matches inside test blocks
				if (postFilter === "in_test_block") {
					const capturesArray = Object.values(captures);
					if (capturesArray.length > 0 && capturesArray[0]) {
						if (!this.navigator.isInTestBlock(capturesArray[0])) continue;
					}
				}

				// Structural: keep only matches NOT inside a try/catch (or begin/rescue in Ruby)
				if (postFilter === "not_in_try_catch") {
					const capturesArray = Object.values(captures);
					if (capturesArray.length > 0 && capturesArray[0]) {
						if (this.navigator.isInTryCatch(capturesArray[0])) continue;
					}
				}

				// Structural: keep only matches that ARE inside a try/catch (or begin/rescue)
				if (postFilter === "in_try_catch") {
					const capturesArray = Object.values(captures);
					if (capturesArray.length > 0 && capturesArray[0]) {
						if (!this.navigator.isInTryCatch(capturesArray[0])) continue;
					}
				}

				// Scope-aware: keep only matches outside test blocks
				if (postFilter === "not_in_test_block") {
					const capturesArray = Object.values(captures);
					if (capturesArray.length > 0 && capturesArray[0]) {
						if (this.navigator.isInTestBlock(capturesArray[0])) continue;
					}
				}

				// Structural: NAME capture must equal PARAM capture (actual shadowing check)
				if (postFilter === "name_matches_param") {
					const nameNode = captures.NAME;
					const paramNode = captures.PARAM;
					if (!nameNode || !paramNode) continue;
					if (nameNode.text !== paramNode.text) continue;
				}

				// Scope: skip matches inside any function/method definition
				if (postFilter === "not_in_function") {
					const first = Object.values(captures)[0];
					if (
						first &&
						this.navigator.isInside(first, [
							"function_definition",
							"function_declaration",
							"method_definition",
							"arrow_function",
						])
					)
						continue;
				}

				// Security: variable name must match secret naming patterns
				if (postFilter === "check_secret_pattern") {
					const varName = (captures.VARNAME?.text ?? "").toLowerCase();
					const secretPatterns = [
						/api[_-]?key/,
						/api[_-]?secret/,
						/password/,
						/passwd/,
						/secret/,
						/token/,
						/auth/,
						/private[_-]?key/,
						/access[_-]?token/,
						/credentials/,
						/aws[_-]?secret/,
						/github[_-]?token/,
						/private[_-]?key/,
						/client[_-]?secret/,
					];
					if (!secretPatterns.some((p) => p.test(varName))) continue;
				}

				// Go: only keep bare-return-call matches when enclosing function returns error.
				if (postFilter === "returns_error") {
					const first = Object.values(captures)[0];
					if (!first) continue;
					const funcNode = this.navigator.findParent(first, [
						"function_declaration",
						"method_declaration",
					]);
					if (!funcNode) continue;

					const fnText = String(funcNode.text ?? "");
					const signature = fnText.split("{", 1)[0]?.trim() ?? "";
					const returnPartMatch = signature.match(
						/func\s*(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*\([^)]*\)\s*(.*)$/s,
					);
					const returnPart = returnPartMatch?.[1]?.trim() ?? "";
					const returnsError = returnPart.length > 0 && /\berror\b/.test(returnPart);
					if (!returnsError) continue;
				}

				// Python: except body that only contains pass (effectively empty)
				if (postFilter === "python_empty_except") {
					const bodyNode = captures.BODY;
					if (bodyNode) {
						// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node
						const realStmts = bodyNode.children.filter(
							(c: any) =>
								c.isNamed &&
								c.type !== "pass_statement" &&
								c.type !== "comment",
						);
						if (realStmts.length > 0) continue; // has real statements
					}
				}

				// Ruby: rescue body with no meaningful statements
				if (postFilter === "ruby_empty_rescue") {
					const bodyNode = captures.BODY;
					if (bodyNode) {
						// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node
						const realStmts = bodyNode.children.filter(
							(c: any) =>
								c.isNamed &&
								!["comment", "nil", "nil_literal"].includes(c.type),
						);
						if (realStmts.length > 0) continue;
					}
				}

				// TS security/concurrency: strict sink filtering (query predicates are not reliable in this runtime)
				if (postFilter === "ts_command_injection_sink") {
					const mod = captures.MOD?.text ?? "";
					const fn = captures.FN?.text ?? "";
					if (mod !== "child_process") continue;
					if (!/^(exec|execSync)$/.test(fn)) continue;
				}

				if (postFilter === "ts_ssrf_sink") {
					const fn = captures.FN?.text ?? "";
					const obj = captures.OBJ?.text ?? "";
					const allowedFns = new Set([
						"fetch",
						"request",
						"get",
						"post",
						"put",
						"patch",
						"delete",
					]);
					if (!allowedFns.has(fn)) continue;

					if (!obj) {
						if (fn !== "fetch") continue;
					} else {
						const allowedObjs = new Set([
							"axios",
							"http",
							"https",
							"got",
							"request",
							"superagent",
							"undici",
						]);
						if (!allowedObjs.has(obj)) continue;
					}
				}

				if (postFilter === "ts_weak_hash_algorithm") {
					const fn = captures.FN?.text ?? "";
					const alg = captures.ALG?.text ?? "";
					if (fn !== "createHash") continue;
					if (!/^(md5|sha1)$/i.test(alg)) continue;
				}

				if (postFilter === "ts_insecure_random_source") {
					const obj = captures.OBJ?.text ?? "";
					const fn = captures.FN?.text ?? "";
					if (obj !== "Math" || fn !== "random") continue;
				}

				if (postFilter === "ts_detached_async_call") {
					const fn = captures.FN?.text ?? "";
					if (!/(Async$|fetch$|request$)/.test(fn)) {
						continue;
					}
				}

				if (postFilter === "py_command_injection_sink") {
					const mod = captures.MOD?.text ?? "";
					const fn = captures.FN?.text ?? "";
					const kw = captures.KW?.text ?? "";
					const isOs = mod === "os" && /^(system|popen)$/.test(fn);
					const isSubprocess =
						mod === "subprocess" &&
						/^(run|Popen|call|check_output|check_call)$/.test(fn) &&
						kw === "shell";
					if (!isOs && !isSubprocess) continue;
				}

				if (postFilter === "go_command_injection_sink") {
					const pkg = captures.PKG?.text ?? "";
					const fn = captures.FN?.text ?? "";
					const shell = captures.SHELL?.text ?? "";
					const flag = captures.FLAG?.text ?? "";
					if (pkg !== "exec") continue;
					if (!/^(Command|CommandContext)$/.test(fn)) continue;
					if (!/^"(sh|bash|zsh|cmd|powershell|pwsh)"$/.test(shell)) continue;
					if (!/^"(-c|\/c)"$/.test(flag)) continue;
				}

				if (postFilter === "ruby_command_injection_sink") {
					const fn = captures.FN?.text ?? "";
					if (!/^(system|exec|spawn|popen|capture3|capture2|capture2e)$/.test(fn)) {
						continue;
					}
				}

				if (postFilter === "py_ssrf_sink") {
					const mod = captures.MOD?.text ?? "";
					const fn = captures.FN?.text ?? "";
					if (mod !== "requests") continue;
					if (!/^(get|post|put|patch|delete|request|head|options)$/.test(fn))
						continue;
				}

				if (postFilter === "py_path_traversal_sink") {
					const fn = captures.FN?.text ?? "";
					if (
						!/^(open|read_text|read_bytes|write_text|write_bytes|remove|unlink|rmdir)$/.test(
							fn,
						)
					)
						continue;
				}

				if (postFilter === "go_path_traversal_sink") {
					const pkg = captures.PKG?.text ?? "";
					const fn = captures.FN?.text ?? "";
					if (!/^(os|ioutil)$/.test(pkg)) continue;
					if (!/^(Open|OpenFile|ReadFile|WriteFile|Create|Remove|RemoveAll)$/.test(fn))
						continue;
				}

				if (postFilter === "py_sql_injection_sink") {
					const fn = captures.FN?.text ?? "";
					if (!/^(execute|executemany|query|raw)$/.test(fn)) continue;
				}

				if (postFilter === "go_sql_injection_sink") {
					const dbFn = captures.DBFN?.text ?? "";
					const fmtPkg = captures.FMTPKG?.text ?? "";
					const fmtFn = captures.FMTFN?.text ?? "";
					if (!/^(Query|QueryContext|QueryRow|QueryRowContext|Exec|ExecContext)$/.test(dbFn))
						continue;
					if (fmtPkg !== "fmt" || fmtFn !== "Sprintf") continue;
				}

				if (postFilter === "py_insecure_deserialization_sink") {
					const mod = captures.MOD?.text ?? "";
					const fn = captures.FN?.text ?? "";
					if (!/^(pickle|yaml)$/.test(mod)) continue;
					if (!/^(load|loads|unsafe_load)$/.test(fn)) continue;
				}

				if (postFilter === "ruby_insecure_deserialization_sink") {
					const mod = captures.MOD?.text ?? "";
					const fn = captures.FN?.text ?? "";
					if (!/^(Marshal|YAML|Psych)$/.test(mod)) continue;
					if (!/^(load|unsafe_load)$/.test(fn)) continue;
				}

				// Use first capture for position info
				if (match.captures.length > 0) {
					const firstNode = match.captures[0].node;
					// Convert captures to text for the result
					const textCaptures: Record<string, string> = {};
					for (const [name, node] of Object.entries(captures)) {
						textCaptures[name] = (node as TreeSitterNode).text;
					}
					matches.push({
						file: filePath,
						line: firstNode.startPosition.row + 1,
						column: firstNode.startPosition.column + 1,
						matchedText: firstNode.text,
						captures: textCaptures,
					});
				}
			}

			if (matches.length > 0) {
				this.dbg(
					`Found ${matches.length} matches in ${path.basename(filePath)}`,
				);
			}
		} catch (err) {
			this.dbg(`Query matching error: ${err}`);
		}

		return matches;
	}

	/** Collect source files for a language */
	private collectFiles(
		dir: string,
		languageId: string,
		fileFilter?: (path: string) => boolean,
	): string[] {
		const files: string[] = [];
		const extensions = this.getExtensionsForLanguage(languageId);

		const scan = (d: string) => {
			try {
				const entries = fs.readdirSync(d, { withFileTypes: true });
				for (const entry of entries) {
					const full = path.join(d, entry.name);
					if (entry.isDirectory()) {
						if (isExcludedDirName(entry.name)) continue;
						scan(full);
					} else if (extensions.some((ext) => entry.name.endsWith(ext))) {
						if (!fileFilter || fileFilter(full)) {
							files.push(full);
						}
					}
				}
			} catch {}
		};

		scan(dir);
		return files;
	}

	/** Get file extensions for a language */
	private getExtensionsForLanguage(languageId: string): string[] {
		const mapping: Record<string, string[]> = {
			typescript: [".ts", ".mts", ".cts"],
			tsx: [".tsx"],
			javascript: [".js", ".mjs", ".cjs"],
			python: [".py"],
			rust: [".rs"],
			go: [".go"],
			java: [".java"],
			c: [".c", ".h"],
			cpp: [".cpp", ".hpp", ".cc", ".hh"],
			ruby: [".rb"],
		};
		return mapping[languageId] || [];
	}
}

// --- Pattern Node Types ---

type PatternNode =
	| {
			kind: "literal";
			nodeType: string;
			text?: string;
			children: PatternNode[];
	  }
	| { kind: "single"; name: string }
	| { kind: "variadic"; name: string };

// --- Simplified Pattern Search (regex fallback) ---

/**
 * Fallback structural search using regex when tree-sitter unavailable
 * Less accurate but works without WASM dependencies
 */
export function regexStructuralSearch(
	pattern: string,
	files: string[],
	options: { maxResults?: number } = {},
): StructuralMatch[] {
	const matches: StructuralMatch[] = [];
	const maxResults = options.maxResults ?? 50;

	// Extract pattern structure for regex
	// "console.log($MSG)" -> /console\.log\(([^)]+)\)/
	const regexPattern = pattern
		.replace(/\./g, "\\.")
		.replace(/\$\$\$[A-Z_][A-Z0-9_]*/g, "(.*?)") // variadic - non-greedy
		.replace(/\$[A-Z_][A-Z0-9_]*/g, "([^,)]+)"); // single - capture group

	try {
		const regex = new RegExp(regexPattern, "g");

		for (const file of files) {
			if (matches.length >= maxResults) break;

			try {
				const content = fs.readFileSync(file, "utf-8");
				const lines = content.split("\n");

				for (let i = 0; i < lines.length; i++) {
					regex.lastIndex = 0;
					const match = regex.exec(lines[i]);
					if (match) {
						const captures: Record<string, string> = {};
						// Extract captures
						for (let j = 1; j < match.length; j++) {
							captures[`$${j}`] = match[j];
						}

						matches.push({
							file,
							line: i + 1,
							column: match.index + 1,
							matchedText: match[0],
							captures,
						});

						if (matches.length >= maxResults) break;
					}
				}
			} catch {}
		}
	} catch {
		// Invalid regex
	}

	return matches;
}
