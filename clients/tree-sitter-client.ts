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
import { createRequire } from "node:module";
import * as path from "node:path";
import { loadWebTreeSitter } from "./deps/web-tree-sitter.js";
import { getProjectIgnoreMatcher, isExcludedDirName } from "./file-utils.js";
import {
	downloadGrammar,
	grammarBlockReason,
	LANGUAGE_TO_GRAMMAR,
} from "./grammar-source.js";
import { resolvePackagePath } from "./package-root.js";

const _require = createRequire(import.meta.url);

import { TreeCache } from "./tree-sitter-cache.js";
import { TreeSitterNavigator } from "./tree-sitter-navigator.js";
import {
	type TreeSitterQuery,
	TreeSitterQueryLoader,
} from "./tree-sitter-query-loader.js";

// Hard cap on a single structural-search file walk. Bounds a misrooted scan so
// it can't enumerate an unbounded tree synchronously before result collection
// short-circuits (#262).
const TREE_SITTER_MAX_SCAN_FILES = 20_000;

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
	parent?: TreeSitterNode | null;
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

// --- Types ---

export interface StructuralMatch {
	file: string;
	line: number;
	column: number;
	matchedText: string;
	/** Tree-sitter node type of the first capture (e.g. "call_expression") */
	nodeType?: string;
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
	/** In-flight/settled lazy grammar fetches, keyed by wasm filename. */
	private grammarEnsurePromises = new Map<string, Promise<boolean>>();
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
			console.error(`[tree-sitter] ${msg}`); // pi-lens-ignore: console-statement — intentional verbose logger
		}
	}

	/**
	 * Resolve a web-tree-sitter asset path using multiple strategies:
	 * 1. Node module resolution via createRequire (handles hoisted installs — issue #20)
	 * 2. Package-root walk from import.meta.url (handles on-the-fly TS compilation by pi)
	 * 3. process.cwd() fallback
	 */
	private resolveWebTreeSitterAsset(asset: string): string | undefined {
		// Strategy 1: Node module resolution (hoisted installs, pnpm workspaces)
		try {
			const resolved = _require.resolve(`web-tree-sitter/${asset}`);
			if (fs.existsSync(resolved)) return resolved;
		} catch {
			/* fall through */
		}

		// Strategy 2: Walk up from this module to find package.json, then into node_modules.
		// This is required when pi compiles TS on-the-fly to a temp directory —
		// createRequire(import.meta.url) resolves from the temp dir and can't find
		// web-tree-sitter, but the package root (where package.json lives) still has
		// the correct node_modules layout.
		try {
			const candidate = resolvePackagePath(
				import.meta.url,
				"node_modules",
				"web-tree-sitter",
				asset,
			);
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			/* fall through */
		}

		// Strategy 3: cwd fallback
		const cwdCandidate = path.join(
			process.cwd(),
			"node_modules",
			"web-tree-sitter",
			asset,
		);
		if (fs.existsSync(cwdCandidate)) return cwdCandidate;

		return undefined;
	}

	/**
	 * The `grammars/` dir bundled inside the pi-lens package (the core grammars
	 * shipped in the tarball, so common languages parse offline on every package
	 * manager). Resolved from the package root; cached. Absent in a source
	 * checkout where `prepare` hasn't populated it.
	 */
	private _bundledGrammarsDir?: string;
	private bundledGrammarsDir(): string | undefined {
		// Cache only a positive hit; keep re-checking until it exists (prepare may
		// not have populated it yet at first probe).
		if (this._bundledGrammarsDir) return this._bundledGrammarsDir;
		try {
			const dir = resolvePackagePath(import.meta.url, "grammars");
			if (fs.existsSync(dir)) this._bundledGrammarsDir = dir;
			return this._bundledGrammarsDir;
		} catch {
			return undefined;
		}
	}

	/**
	 * All directories that may hold grammar wasms, in precedence order: the
	 * bundled core dir, the resolved `this.grammarsDir`, and the web-tree-sitter
	 * grammars dir (the lazy-fetch write target). Deduped.
	 */
	private grammarSourceDirs(): string[] {
		const dirs: string[] = [];
		const push = (d: string | undefined): void => {
			if (d && !dirs.includes(d)) dirs.push(d);
		};
		push(this.bundledGrammarsDir());
		push(this.grammarsDir || undefined);
		push(this.resolveWebTreeSitterAsset("grammars"));
		return dirs;
	}

	/** Absolute path to `grammarFile` across all source dirs, else undefined. */
	private resolveGrammarFile(grammarFile: string): string | undefined {
		for (const dir of this.grammarSourceDirs()) {
			const candidate = path.join(dir, grammarFile);
			if (fs.existsSync(candidate)) return candidate;
		}
		return undefined;
	}

	/** Find tree-sitter grammar directory */
	private findGrammarsDir(): string {
		const grammarsDir = this.resolveWebTreeSitterAsset("grammars");
		if (
			grammarsDir &&
			fs.existsSync(path.join(grammarsDir, "tree-sitter-typescript.wasm"))
		) {
			return grammarsDir;
		}

		// Fallback: a real `tree-sitter-wasms` package, if the user installed one
		// (it is not a pi-lens dependency — grammars ship bundled / lazy-fetched).
		try {
			const wasmsOut = path.join(
				path.dirname(_require.resolve("tree-sitter-wasms/package.json")),
				"out",
			);
			if (fs.existsSync(wasmsOut)) return wasmsOut;
		} catch {
			/* fall through */
		}

		const cwdWasms = path.join(
			process.cwd(),
			"node_modules",
			"tree-sitter-wasms",
			"out",
		);
		if (fs.existsSync(cwdWasms)) return cwdWasms;

		return "";
	}

	/**
	 * The directory where grammars SHOULD live (web-tree-sitter/grammars),
	 * whether or not it exists yet — so we can create + populate it when the
	 * postinstall download was skipped (pnpm/bun). Returns undefined if
	 * web-tree-sitter itself can't be located.
	 */
	private grammarsWriteDir(): string | undefined {
		try {
			let dir = path.dirname(_require.resolve("web-tree-sitter"));
			while (
				path.basename(dir) !== "web-tree-sitter" &&
				dir !== path.dirname(dir)
			) {
				dir = path.dirname(dir);
			}
			if (path.basename(dir) === "web-tree-sitter") {
				return path.join(dir, "grammars");
			}
		} catch {
			/* fall through */
		}
		return undefined;
	}

	/**
	 * Ensure a single grammar wasm is on disk, fetching it at runtime if the
	 * postinstall didn't (pnpm/bun skip lifecycle scripts — the documented
	 * build-scripts gap). Idempotent and de-duplicated per file. Best-effort:
	 * a failed fetch (e.g. offline) degrades to "grammar unavailable", never
	 * throws.
	 */
	private async ensureGrammar(grammarFile: string): Promise<boolean> {
		if (this.resolveGrammarFile(grammarFile)) {
			return true;
		}
		const inflight = this.grammarEnsurePromises.get(grammarFile);
		if (inflight) return inflight;

		const task = (async (): Promise<boolean> => {
			const dir =
				this.grammarsDir && fs.existsSync(this.grammarsDir)
					? this.grammarsDir
					: this.grammarsWriteDir();
			if (!dir) return false;
			// Reuse the shared single-file downloader (same CDN/source as the
			// postinstall) — see clients/grammar-source.ts.
			const ok = await downloadGrammar(dir, grammarFile);
			if (ok) {
				if (!this.grammarsDir) this.grammarsDir = dir;
				console.error(
					`[pi-lens] fetched missing tree-sitter grammar ${grammarFile} at runtime (install scripts were skipped by the package manager)`,
				);
			} else {
				// Surface the degradation once per grammar (the promise cache dedupes)
				// instead of failing silently — otherwise pnpm/bun users offline get
				// no signal that a language's tree-sitter features are unavailable.
				console.error(
					`[pi-lens] tree-sitter grammar '${grammarFile}' is unavailable — ` +
						`symbol search, module reports and structural rules for this language will be degraded. ` +
						`The package manager skipped install scripts and the runtime download failed (offline or CDN unreachable). ` +
						`Fix: reinstall with a manager that runs postinstall, allow its build scripts ` +
						`(pnpm approve-builds / bun trustedDependencies), or restore network access.`,
				);
			}
			return ok;
		})();
		this.grammarEnsurePromises.set(grammarFile, task);
		return task;
	}

	/** Initialize tree-sitter WASM runtime */
	async init(): Promise<boolean> {
		if (this.initialized) return true;
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			try {
				const mod = await loadWebTreeSitter();
				// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter module shape varies (Parser direct / default-wrapped)
				const anyMod = mod as any;
				const ParserClass = anyMod.Parser || anyMod.default || anyMod;
				if (!ParserClass || typeof ParserClass.init !== "function") {
					this.dbg("Parser class not found or missing init method");
					return false;
				}

				// biome-ignore lint/suspicious/noExplicitAny: Parser class type
				this.ParserClass = ParserClass as any;
				// Store Language loader from module (not from Parser)
				this.LanguageLoader = mod.Language;

				// Resolve WASM path using same multi-strategy helper (hoisted installs +
				// on-the-fly compilation by pi).
				const wasmPath = this.resolveWebTreeSitterAsset("tree-sitter.wasm");
				if (!wasmPath) {
					this.dbg("Could not resolve tree-sitter.wasm");
					return false;
				}
				const wasmDir = path.dirname(wasmPath);
				this.dbg(
					`Looking for WASM at: ${wasmPath}, exists: ${fs.existsSync(wasmPath)}`,
				);

				await ParserClass.init({
					locateFile: (scriptName: string) => {
						const fullPath = path.join(wasmDir, scriptName);
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

		// A grammar that fatally crashes this runtime (uncatchable V8 abort) must
		// never be loaded — skip it and degrade to "unavailable" (#423/#432). The
		// grammar-health nightly is what decides membership of BLOCKED_GRAMMARS.
		const blockReason = grammarBlockReason(grammarFile);
		if (blockReason) {
			this.dbg(`Grammar ${grammarFile} blocked on this runtime — ${blockReason}`);
			return null;
		}

		// Look across the bundled core `grammars/` dir and the postinstall/lazy
		// dir. Lazily fetch only if the grammar is in neither (pnpm/bun skip
		// postinstall; the long-tail grammars aren't bundled). Only the language
		// actually being parsed is fetched.
		let grammarPath = this.resolveGrammarFile(grammarFile);
		if (!grammarPath) {
			if (await this.ensureGrammar(grammarFile)) {
				grammarPath = this.resolveGrammarFile(grammarFile);
			}
		}
		this.dbg(
			`Grammar path: ${grammarPath}, exists: ${grammarPath && fs.existsSync(grammarPath)}`,
		);

		if (!grammarPath || !fs.existsSync(grammarPath)) {
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
		contentOverride?: string,
	): Promise<TreeSitterTree | null> {
		this.dbg(`Parsing ${filePath} with language ${languageId}`);
		const parser = await this.getParser(languageId);
		if (!parser) {
			this.dbg(`Failed to get parser for ${languageId}`);
			return null;
		}

		try {
			const content = contentOverride ?? fs.readFileSync(filePath, "utf-8");
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

	/** Check if tree-sitter is available (a core grammar resolves somewhere). */
	isAvailable(): boolean {
		// Available if the core TS grammar resolves in ANY source dir — the bundled
		// `grammars/` counts even when web-tree-sitter/grammars is empty (no
		// postinstall on pnpm/bun, or a fresh CI checkout).
		if (this.resolveGrammarFile("tree-sitter-typescript.wasm")) return true;
		// Re-evaluate the legacy dir in case grammars were installed after start.
		const dir = this.findGrammarsDir();
		this.grammarsDir = dir;
		return !!dir && fs.existsSync(dir);
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
		contentOverride?: string,
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
			contentOverride,
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
			hash = ((hash << 5) - hash + char) | 0; // NOSONAR: intentional 32-bit truncation for hash stability, not float→int conversion
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
			const Query = (await loadWebTreeSitter()).Query;
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
		const cacheKey = this.getQueryCacheKey(
			`raw:${queryId}:${queryStr}`,
			languageId,
		);

		if (this.queryCache.has(cacheKey)) {
			return this.queryCache.get(cacheKey);
		}

		const language = await this.loadLanguage(languageId);
		if (!language) return null;

		try {
			// biome-ignore lint/suspicious/noExplicitAny: Query constructor from web-tree-sitter
			const Query = (await loadWebTreeSitter()).Query;
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

	private hasChildToken(node: TreeSitterNode, token: string): boolean {
		return node.children?.some(
			(child) => child.type === token || child.text === token,
		);
	}

	private containsYieldInFunctionBody(
		node: TreeSitterNode,
		root: TreeSitterNode = node,
	): boolean {
		for (const child of node.children ?? []) {
			if (child.type === "yield") return true;
			if (
				child !== root &&
				["function_definition", "class_definition", "lambda"].includes(
					child.type,
				)
			) {
				continue;
			}
			if (this.containsYieldInFunctionBody(child, root)) return true;
		}
		return false;
	}

	private isLikelySqlAlchemyReceiver(text: string): boolean {
		const tail = text.split(".").pop() ?? text;
		return new Set([
			"session",
			"db_session",
			"async_session",
			"sync_session",
		]).has(tail.toLowerCase());
	}

	private isSafeSqlAlchemyExpressionCall(node: TreeSitterNode): boolean {
		if (node.type !== "call") return false;
		const callee = node.children?.[0]?.text ?? "";
		const expression = node.text;
		return ["select", "insert", "update", "delete"].some(
			(name) => callee === name || expression.startsWith(`${name}(`),
		);
	}

	/**
	 * Post-filter predicate: returns true if the match should be kept, false to skip.
	 * Each branch is an independent filter identified by name — flat dispatch, no nesting.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: postFilterParams is untyped per-filter config
	private applyPostFilter(
		postFilter: string,
		postFilterParams: any,
		captures: Record<string, TreeSitterNode>,
	): boolean {
		/**
		 * Extract the list of declared slot names from a class_definition's
		 * `__slots__` assignment. Returns:
		 *   - `null` if the class has no `__slots__` declaration
		 *   - an array of slot names (strings) otherwise
		 *
		 * Handles both common shapes:
		 *   - string tuple/list: `__slots__ = ("a", "b")` or `['a', 'b']`
		 *   - single string:     `__slots__ = "a"` (Python's quirky single-slot form)
		 *   - parent inheritance: returns null (we don't follow MRO)
		 */
		function extractSlots(classNode: any): string[] | null {
			const classText = classNode.text ?? "";
			if (!classText.includes("__slots__")) return null;
			// biome-ignore lint/suspicious/noExplicitAny: AST iteration
			const body = classNode.children?.find((c: any) => c.type === "block");
			if (!body) return null;
			const slots: string[] = [];
			// biome-ignore lint/suspicious/noExplicitAny: AST iteration
			for (const stmt of body.children ?? []) {
				if (stmt.type !== "expression_statement") continue;
				// biome-ignore lint/suspicious/noExplicitAny: AST traversal
				const assignment = stmt.children?.find((c: any) => c.type === "assignment");
				if (!assignment) continue;
				// biome-ignore lint/suspicious/noExplicitAny: LHS check
				// LHS text may include a leading whitespace token from the AST
				// (tree-sitter separates the space before the LHS identifier).
				const lhsText = (assignment.children?.[0]?.text ?? "").trim();
				if (lhsText !== "__slots__") continue;
				// biome-ignore lint/suspicious/noExplicitAny: RHS extraction
				// children layout: [LHS identifier, `=` operator, RHS expression]
				const rhs = assignment.children?.[2];
				if (!rhs) continue;
				if (rhs.type === "string") {
					// __slots__ = "a" — single string form (Python quirk)
					const s = (rhs.text ?? "").replace(/^["']|["']$/g, "");
					if (s) slots.push(s);
				} else if (rhs.type === "tuple" || rhs.type === "list") {
					// biome-ignore lint/suspicious/noExplicitAny: list element extraction
					for (const el of rhs.children ?? []) {
						if (!el.isNamed) continue; // skip "," punctuation
						if (el.type === "string") {
							slots.push((el.text ?? "").replace(/^["']|["']$/g, ""));
						}
					}
				}
				break; // first __slots__ wins
			}
			return slots;
		}

		switch (postFilter) {
			case "is_generator_with_valued_return": {
				const returnNode = captures.RETURN;
				const functionNode =
					captures.FUNCTION ??
					(returnNode
						? this.navigator.findParent(returnNode, ["function_definition"])
						: undefined);
				if (!functionNode) return false;
				// In the Python grammar, `async def` is also a function_definition with
				// an anonymous `async` child. Coroutines may return values normally;
				// only synchronous generator functions should be flagged.
				if (this.hasChildToken(functionNode, "async")) return false;
				return this.containsYieldInFunctionBody(functionNode);
			}
			case "count_params": {
				const paramsNode = captures.PARAMS;
				if (!paramsNode) return true;
				// Count only truly required params — exclude:
				//   • optional_parameter nodes (foo?: T) if the grammar uses that type
				//   • required_parameter nodes that have a "?" child (same semantic,
				//     different grammar version — web-tree-sitter-typescript collapses
				//     both into required_parameter with a "?" token child)
				//   • params with a default value (text contains "=")
				// biome-ignore lint/suspicious/noExplicitAny: Count parameter nodes
				const paramCount = paramsNode.children.filter((c: any) => {
					if (c.type !== "required_parameter") return false;
					if (c.text.includes("=")) return false;
					// biome-ignore lint/suspicious/noExplicitAny: child node check
					if (c.children?.some((ch: any) => ch.text === "?")) return false;
					return true;
				}).length;
				return paramCount >= (postFilterParams?.min_params ?? 6);
			}
			case "empty_body": {
				const bodyNode = captures.BODY;
				if (!bodyNode) return true;
				// biome-ignore lint/suspicious/noExplicitAny: Check for meaningful statements
				const meaningful = bodyNode.children.filter(
					(c: any) =>
						c.isNamed &&
						c.type !== "comment" &&
						c.type !== "line_comment" &&
						c.type !== "block_comment",
				);
				return meaningful.length === 0;
			}
			case "bare_except_only": {
				const clauseNode = captures.CLAUSE;
				if (!clauseNode) return true;
				// A typed `except` clause has a named child for the exception
				// spec — one of: identifier (e.g. `except ValueError`),
				// tuple (e.g. `except (E, F)`), or as_pattern (e.g. `except E as e`).
				// Bare `except:` has NO named children (just the `except` keyword,
				// the `:` colon, and the body block).
				// biome-ignore lint/suspicious/noExplicitAny: AST iteration
				const hasExceptionSpec = clauseNode.children.some((c: any) => {
					if (!c.isNamed) return false;
					return (
						c.type === "identifier" ||
						c.type === "tuple" ||
						c.type === "as_pattern" ||
						c.type === "parenthesized_expression"
					);
				});
				// Fire ONLY when bare (no exception spec)
				return !hasExceptionSpec;
			}
			case "eq_mod_fn": {
				// Workaround for web-tree-sitter not auto-applying #eq? predicates
				// on the structural pattern of a query that has predicates. The
				// query captures @MOD, @FN but the predicates aren't enforced
				// (see evaluatePredicates in clients/tree-sitter-client.ts).
				// This filter re-applies the #eq? checks at post_filter time.
				const mod = captures.MOD?.text ?? "";
				const fn = captures.FN?.text ?? "";
				return mod === "threading" && fn === "Thread";
			}
			case "regex_first_arg_identifier": {
				// Workaround for web-tree-sitter not auto-applying #eq?/#match?
				// predicates on the structural pattern (see evaluatePredicates).
				// This post_filter re-applies both predicate checks AND
				// the first-argument check:
				// 1. MOD must be "re"  (would-be #eq? @MOD "re")
				// 2. FUNC must match the regex method pattern (#match? @FUNC ...)
				// 3. First arg must be an identifier (dynamic pattern)
				//    String literals (r"...", "...") are safe static patterns.
				const mod = captures.MOD?.text ?? "";
				if (mod !== "re") return false;
				const func = captures.FUNC?.text ?? "";
				if (!/^(compile|match|search|fullmatch|findall|finditer|sub|subn|split)$/.test(func)) {
					return false;
				}
				const argsNode = captures.ARGS;
				if (!argsNode) return false;
				// biome-ignore lint/suspicious/noExplicitAny: AST iteration
				const firstNamed = (argsNode.children ?? []).find((c: any) => c.isNamed);
				if (!firstNamed) return false;
				return firstNamed.type === "identifier";
			}
			case "open_mode_invalid": {
				const modeNode = captures.MODE;
				if (!modeNode) return false;
				// Python's open() mode accepts: r, w, a, x (basic), b/t/+ (suffix).
				// Strip surrounding quotes from the string literal text.
				const text = modeNode.text ?? "";
				const stripped = text.replace(/^["']|["']$/g, "");
				// Skip empty mode (defaults to 'r')
				if (stripped.length === 0) return false;
				// Skip single-char modes (r/w/a/x — always valid)
				if (stripped.length === 1) return false;
				// Must contain only valid characters
				if (!/^[rwxabt+]+$/.test(stripped)) return true;
				// Multi-char must be exactly: basic + optional (b|t) + optional +
				// Examples valid: "rb", "rb+", "r+", "ab", "rt"
				// Examples invalid: "rwb", "rrr", "rw", "rbb" (no + between r and w is invalid)
				// The "rw" case (basic mode followed by another basic mode without +) is invalid
				// Allow: [basic][bt]?[+]
				const validShape = /^[rwax][bt]?\+?$/;
				if (!validShape.test(stripped)) return true;
				return false;
			}
			case "status_204_with_value_return": {
				const funcNode = captures.FUNC;
				const valNode = captures.VAL;
				if (!funcNode || !valNode) return false;
				// Only fire if status_code=204
				if (Number(valNode.text ?? 0) !== 204) return false;
				// Walk the function subtree looking for return_statement nodes.
				// Manual BFS because web-tree-sitter doesn't expose
				// descendantsOfType directly.
				// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node iteration
				const queue: any[] = [funcNode];
				while (queue.length > 0) {
					const node = queue.shift();
					if (node.type === "return_statement") {
						// Has a value child (not just the `return` keyword)
						// biome-ignore lint/suspicious/noExplicitAny: child check
						const hasValue = node.children.some(
							(c: any) =>
								c.isNamed && c.type !== "comment",
						);
						if (hasValue) return true;
					}
					// biome-ignore lint/suspicious/noExplicitAny: child queue
					if (node.children) queue.push(...node.children);
				}
				return false;
			}
			case "has_mixed_async": {
				const bodyNode = captures.BODY;
				if (!bodyNode) return true;
				const bodyText = bodyNode.text;
				return (
					bodyText.includes("await") && /\.\s*(then|catch)\s*\(/.test(bodyText)
				);
			}
			case "format_arity_mismatch": {
				const formatNode = captures.FORMAT;
				const argsNode = captures.ARGS;
				if (!formatNode || !argsNode) return false;
				// Strip quotes from format string
				const fmtText = (formatNode.text ?? "").replace(/^["']|["']$/g, "");
				// Don't strip a leading "%" — the format string's contents are
				// intact after stripping only the surrounding quotes. The original
				// code stripped the first "%" thinking it was the operator, but
				// the operator is a separate binary_operator node, not part of
				// the string literal's text.
				const fmt = fmtText;
				// Count placeholders: %s, %d, %f, %(name)s, %i, etc.
				// The simple %s/%d style: each %X counts as 1
				// The %(name)s style: counts as 1 with name
				// The %% escape: doesn't count
				let placeholderCount = 0;
				let namedKeys: string[] = [];
				// biome-ignore lint/suspicious/noExplicitAny: regex match
				const positionalRegex = /%(?:\([^)]+\))?[#0\- +]*\d*(?:\.\d+)?[hlL]?[diouxXeEfFgGcrs%]/g;
				// biome-ignore lint/suspicious/noExplicitAny: regex match
				const positionalMatches = fmt.match(positionalRegex) ?? [];
				for (const m of positionalMatches) {
					if (m === "%%") continue;
					placeholderCount++;
					// biome-ignore lint/suspicious/noExplicitAny: capture group
					const namedMatch = m.match(/^%\(([^)]+)\)/);
					if (namedMatch) namedKeys.push(namedMatch[1]);
				}
				// If format uses named placeholders, RHS should be a dict
				if (namedKeys.length > 0) {
					// Check if dict contains all named keys
					if (argsNode.type === "dictionary") {
						// biome-ignore lint/suspicious/noExplicitAny: AST iteration
						const dictKeys: string[] = [];
						for (const child of argsNode.children ?? []) {
							// biome-ignore lint/suspicious/noExplicitAny: child check
							if (child.type === "pair" && child.children?.[0]) {
								// biome-ignore lint/suspicious/noExplicitAny: child text
								// Strip quotes — child is a string literal node,
								// text includes the surrounding "...".
								dictKeys.push(
									(child.children[0].text ?? "").replace(/^["']|["']$/g, ""),
								);
							}
						}
						const missing = namedKeys.filter((k) => !dictKeys.includes(k));
						return missing.length > 0;
					}
					// Format uses named but RHS isn't a dict — definitely wrong
					return true;
				}
				// Positional: count tuple args
				if (argsNode.type === "tuple") {
					const argCount = (argsNode.children ?? []).filter((c: any) => c.isNamed).length;
					if (argCount !== placeholderCount) return true;
				}
				return false;
			}
			case "aws_policy_public": {
				const policyNode = captures.POLICY;
				if (!policyNode) return false;
				const text = policyNode.text ?? "";
				// Match patterns indicating public access
				const patterns = [
					/"Principal"\s*:\s*"\*"/,  // direct wildcard
					/"Principal"\s*:\s*\{\s*"AWS"\s*:\s*"\*"\s*\}/,  // AWS wildcard
					/"Effect"\s*:\s*"Allow"[\s\S]*?"Action"\s*:\s*"\*"[\s\S]*?"Resource"\s*:\s*"\*"/,  // full admin
					/"Principal"\s*:\s*"\*"/,
				];
				return patterns.some((p) => p.test(text));
			}
			case "slots_attribute_mismatch": {
				const selfNode = captures.SELF;
				const attrNode = captures.ATTR;
				const methodNode = captures.METHOD;
				if (!selfNode || !attrNode || !methodNode) return false;
				// Only consider self.X = (not other.X)
				if (selfNode.text !== "self") return false;
				const attrName = attrNode.text ?? "";
				// Find parent class_definition
				// biome-ignore lint/suspicious/noExplicitAny: AST navigation
				let parent = methodNode.parent;
				while (parent && parent.type !== "class_definition") {
					parent = parent.parent;
				}
				if (!parent) return false;
				// Parse the class's __slots__ list and check if attrName is in it.
				// Fires ONLY when self.X = ... assigns to an attribute NOT in __slots__
				// (a real S8494 violation — the assignment will raise AttributeError).
				const slots = extractSlots(parent);
				// null = no __slots__ declared in this class. [] = __slots__ declared
				// but we couldn't parse it (treat as null to avoid FPs on inner-class
				// parent walks where the parent text mentions __slots__ but the
				// direct children don't contain the assignment).
				if (slots === null || slots.length === 0) return false;
				return !slots.includes(attrName);
			}
			case "special_method_arity": {
				const nameNode = captures.NAME;
				const paramsNode = captures.PARAMS;
				if (!nameNode || !paramsNode) return false;
				const name = nameNode.text ?? "";
				// Expected arities: {method_name: expected_arg_count}
				// (excluding `self`/`cls` which is always 1)
				const expected: Record<string, number> = {
					__del__: 0,
					__repr__: 0,
					__str__: 0,
					__hash__: 0,
					__bool__: 0,
					__len__: 0,
					__eq__: 1,
					__lt__: 1,
					__le__: 1,
					__gt__: 1,
					__ge__: 1,
					__ne__: 1,
				};
				const expectedCount = expected[name];
				if (expectedCount === undefined) return false; // not in our list
				// Count required params (excluding defaults)
				// biome-ignore lint/suspicious/noExplicitAny: AST iteration
				const paramCount = (paramsNode.children ?? []).filter((c: any) => {
					if (c.type !== "identifier" && c.type !== "typed_parameter") return false;
					if (c.text.includes("=")) return false;
					return true;
				}).length;
				// Expected total = expectedCount + 1 (for self/cls)
				return paramCount !== expectedCount + 1;
			}
			case "no_super_call": {
				const bodyNode = captures.BODY;
				if (!bodyNode) return true;
				return !/(?<!\/\/.*)super\s*\(/.test(bodyNode.text);
			}
			case "in_test_block": {
				const first = Object.values(captures)[0];
				return !!first && this.navigator.isInTestBlock(first);
			}
			case "not_in_test_block": {
				const first = Object.values(captures)[0];
				return !first || !this.navigator.isInTestBlock(first);
			}
			case "not_in_try_catch": {
				const first = Object.values(captures)[0];
				return !first || !this.navigator.isInTryCatch(first);
			}
			case "in_try_catch": {
				const first = Object.values(captures)[0];
				return !!first && this.navigator.isInTryCatch(first);
			}
			case "name_matches_param": {
				const nameNode = captures.NAME;
				const paramNode = captures.PARAM;
				return !!nameNode && !!paramNode && nameNode.text === paramNode.text;
			}
			case "not_in_function": {
				const first = Object.values(captures)[0];
				return (
					!first ||
					!this.navigator.isInside(first, [
						"function_definition",
						"function_declaration",
						"method_definition",
						"arrow_function",
					])
				);
			}
			case "check_secret_pattern": {
				const varName = (captures.VARNAME?.text ?? "");
				const varNameLower = varName.toLowerCase();
				// Skip UPPER_CASE constants — they're module-level constants
				// (e.g. `GITHUB_TYPE_FOR_PERSONAL_API_KEY = "..."`), not secrets.
				// A constant has no lowercase letters in its name.
				if (varName === varName.toUpperCase() && /[A-Z]/.test(varName)) {
					return false;
				}
				return [
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
					/client[_-]?secret/,
				].some((p) => p.test(varNameLower));
			}
			case "returns_error": {
				const first = Object.values(captures)[0];
				if (!first) return false;
				const funcNode = this.navigator.findParent(first, [
					"function_declaration",
					"method_declaration",
				]);
				if (!funcNode) return false;
				const signature =
					String(funcNode.text ?? "")
						.split("{", 1)[0]
						?.trim() ?? "";
				const returnPart =
					signature
						.match(
							/func\s*(?:\([^)]*\)\s*)?[A-Za-z_]\w*\s*\([^)]*\)\s*(.*)$/s,
						)?.[1]
						?.trim() ?? "";
				return returnPart.length > 0 && /\berror\b/.test(returnPart);
			}
			case "python_empty_except": {
				const bodyNode = captures.BODY;
				if (!bodyNode) return true;
				// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node
				return !bodyNode.children.some(
					(c: any) =>
						c.isNamed && c.type !== "pass_statement" && c.type !== "comment",
				);
			}
			case "ruby_empty_rescue": {
				const bodyNode = captures.BODY;
				if (!bodyNode) return true;
				// biome-ignore lint/suspicious/noExplicitAny: tree-sitter node
				return !bodyNode.children.some(
					(c: any) =>
						c.isNamed && !["comment", "nil", "nil_literal"].includes(c.type),
				);
			}
			case "ts_command_injection_sink":
				return (
					captures.MOD?.text === "child_process" &&
					/^(exec|execSync)$/.test(captures.FN?.text ?? "")
				);
			case "ts_ssrf_sink": {
				const fn = captures.FN?.text ?? "";
				const obj = captures.OBJ?.text ?? "";
				const urlText = captures.URL?.text ?? "";
				const allowedFns = new Set([
					"fetch",
					"request",
					"get",
					"post",
					"put",
					"patch",
					"delete",
				]);
				if (!allowedFns.has(fn)) return false;
				// Only flag when the URL argument looks like it could carry external
				// input: member expressions (req.url, ctx.query.x) or identifiers
				// whose names suggest user/external provenance. Plain generic names
				// like `url` or `path` in internal download utilities produce too
				// many false positives — those need data-flow analysis to resolve.
				const looksLikeExternalInput =
					urlText.includes(".") ||
					/user|external|remote|input|target|webhook|callback|redirect|untrusted|arbitrary/i.test(
						urlText,
					);
				if (!looksLikeExternalInput) return false;
				if (!obj) return fn === "fetch";
				return new Set([
					"axios",
					"http",
					"https",
					"got",
					"request",
					"superagent",
					"undici",
				]).has(obj);
			}
			case "ts_weak_hash_algorithm":
				return (
					captures.FN?.text === "createHash" &&
					/^(md5|sha1)$/i.test(captures.ALG?.text ?? "")
				);
			case "ts_insecure_random_source": {
				if (captures.OBJ?.text !== "Math" || captures.FN?.text !== "random")
					return false;
				// Only flag when assigned to a security-sensitive variable name
				const varName = captures.VAR?.text ?? "";
				return /token|secret|password|key|nonce|salt|csrf|auth|session|credential|hash|otp|pin/i.test(
					varName,
				);
			}
			case "ts_detached_async_call":
				return /(Async$|fetch$|request$)/.test(captures.FN?.text ?? "");
			case "incomplete_assertion": {
				const expectNode = captures.EXPECT;
				if (!expectNode) return false;
				const CHAI_PROPERTY_ASSERTIONS = new Set([
					"true",
					"false",
					"null",
					"undefined",
					"empty",
					"NaN",
					"finite",
					"exist",
					"arguments",
					"extensible",
					"sealed",
					"frozen",
					"locked",
				]);
				// The expect identifier is inside a call_expression. Walk up past that
				// call_expression to the container that determines if it's a complete
				// assertion or an incomplete one.
				let current: TreeSitterNode | null | undefined = expectNode.parent;
				if (!current) return false;
				current = current.parent; // skip the expect(...) call_expression
				if (!current) return false;
				// Bare expect(foo); or return expect(foo);
				if (
					current.type === "expression_statement" ||
					current.type === "return_statement"
				)
					return true;
				let lastPropertyName: string | null = null;
				while (current && current.type === "member_expression") {
					const propNode = current.children?.find(
						(c: any) => c.type === "property_identifier",
					);
					if (propNode) lastPropertyName = propNode.text;
					const parent: TreeSitterNode | null | undefined = current.parent;
					if (!parent) return false;
					if (
						parent.type === "expression_statement" ||
						parent.type === "return_statement"
					) {
						if (
							lastPropertyName &&
							CHAI_PROPERTY_ASSERTIONS.has(lastPropertyName)
						)
							return false;
						return true;
					}
					if (parent.type === "call_expression") return false;
					current = parent;
				}
				return false;
			}
			case "py_command_injection_sink": {
				const mod = captures.MOD?.text ?? "";
				const fn = captures.FN?.text ?? "";
				const kw = captures.KW?.text ?? "";
				return (
					(mod === "os" && /^(system|popen)$/.test(fn)) ||
					(mod === "subprocess" &&
						/^(run|Popen|call|check_output|check_call)$/.test(fn) &&
						kw === "shell")
				);
			}
			case "go_command_injection_sink":
				return (
					captures.PKG?.text === "exec" &&
					/^(Command|CommandContext)$/.test(captures.FN?.text ?? "") &&
					/^"(sh|bash|zsh|cmd|powershell|pwsh)"$/.test(
						captures.SHELL?.text ?? "",
					) &&
					/^"(-c|\/c)"$/.test(captures.FLAG?.text ?? "")
				);
			case "ruby_command_injection_sink":
				return /^(system|exec|spawn|popen|capture3|capture2|capture2e)$/.test(
					captures.FN?.text ?? "",
				);
			case "py_ssrf_sink":
				return (
					captures.MOD?.text === "requests" &&
					/^(get|post|put|patch|delete|request|head|options)$/.test(
						captures.FN?.text ?? "",
					)
				);
			case "py_path_traversal_sink":
				return /^(open|read_text|read_bytes|write_text|write_bytes|remove|unlink|rmdir)$/.test(
					captures.FN?.text ?? "",
				);
			case "go_path_traversal_sink":
				return (
					/^(os|ioutil)$/.test(captures.PKG?.text ?? "") &&
					/^(Open|OpenFile|ReadFile|WriteFile|Create|Remove|RemoveAll)$/.test(
						captures.FN?.text ?? "",
					)
				);
			case "py_sql_injection_sink": {
				const fn = captures.FN?.text ?? "";
				if (!new Set(["execute", "executemany", "query", "raw"]).has(fn)) {
					return false;
				}

				const sqlNode = captures.SQL;
				const receiver = captures.OBJ?.text ?? "";

				// SQLAlchemy ORM sessions execute expression objects, not raw SQL
				// strings. `session.execute(stmt)` and `session.execute(select(...))`
				// are parameterized by construction and were too noisy as blockers.
				if (fn === "execute" && this.isLikelySqlAlchemyReceiver(receiver)) {
					return false;
				}
				if (sqlNode && this.isSafeSqlAlchemyExpressionCall(sqlNode)) {
					return false;
				}

				return true;
			}
			case "go_sql_injection_sink":
				return (
					/^(Query|QueryContext|QueryRow|QueryRowContext|Exec|ExecContext)$/.test(
						captures.DBFN?.text ?? "",
					) &&
					captures.FMTPKG?.text === "fmt" &&
					captures.FMTFN?.text === "Sprintf"
				);
			case "py_insecure_deserialization_sink":
				return (
					/^(pickle|yaml)$/.test(captures.MOD?.text ?? "") &&
					/^(load|loads|unsafe_load)$/.test(captures.FN?.text ?? "")
				);
			case "ruby_insecure_deserialization_sink":
				return (
					/^(Marshal|YAML|Psych)$/.test(captures.MOD?.text ?? "") &&
					/^(load|unsafe_load)$/.test(captures.FN?.text ?? "")
				);
			case "match_captures": {
				// Generic filter: each key in postFilterParams is a capture name,
				// value is a regex string. All must match.
				for (const [captureName, pattern] of Object.entries(
					postFilterParams ?? {},
				)) {
					const node = captures[captureName];
					if (!node) return false;
					if (!new RegExp(pattern as string).test(node.text)) return false;
				}
				return true;
			}
			case "case_range_single_value": {
				const start = captures.START?.text ?? "";
				const end = captures.END?.text ?? "";
				return start === end;
			}
			case "goto_jumps_backward": {
				const label = captures.LABEL;
				const gotoNode = captures.GOTO;
				if (!label || !gotoNode) return false;
				return label.startIndex < gotoNode.startIndex;
			}
			case "goto_targets_inner_block": {
				const target = captures.TARGET;
				if (!target) return false;
				// A goto targets an inner block if its label is inside a
				// compound_statement that is nested inside another compound_statement.
				let depth = 0;
				let node: TreeSitterNode | null | undefined = target.parent;
				while (node) {
					if (node.type === "compound_statement") depth++;
					node = node.parent;
				}
				return depth >= 2;
			}
			case "c_memset_sensitive_arg": {
				const callNode = captures.CALL;
				if (!callNode || callNode.type !== "call_expression") return false;
				// Find the first argument in the argument_list
				const argList = callNode.children?.find(
					(c: any) => c.type === "argument_list",
				);
				if (!argList) return false;
				// First named child after the opening paren is the first arg
				const firstArg = argList.children?.find((c: any) => c.isNamed);
				if (!firstArg) return false;
				const argName = firstArg.text ?? "";
				return /password|secret|key|token|credential|auth|private|passwd|pin|salt|nonce|iv|seed/i.test(
					argName,
				);
			}
			case "c_stdlib_name": {
				const name = captures.NAME?.text ?? "";
				const STDLIB_NAMES = new Set([
					"malloc",
					"calloc",
					"realloc",
					"free",
					"alloca",
					"printf",
					"fprintf",
					"sprintf",
					"snprintf",
					"vprintf",
					"vfprintf",
					"vsprintf",
					"vsnprintf",
					"scanf",
					"fscanf",
					"sscanf",
					"vscanf",
					"vfscanf",
					"vsscanf",
					"strcpy",
					"strncpy",
					"strcat",
					"strncat",
					"strcmp",
					"strncmp",
					"strlen",
					"strchr",
					"strrchr",
					"strstr",
					"strerror",
					"memcpy",
					"memmove",
					"memset",
					"memcmp",
					"memchr",
					"fopen",
					"fclose",
					"fread",
					"fwrite",
					"fgets",
					"fputs",
					"getc",
					"putc",
					"getchar",
					"putchar",
					"exit",
					"abort",
					"assert",
					"errno",
					"abs",
					"labs",
					"llabs",
					"div",
					"ldiv",
					"lldiv",
					"atoi",
					"atol",
					"atoll",
					"strtol",
					"strtoll",
					"strtoul",
					"strtoull",
					"strtod",
					"strtof",
					"strtold",
					"qsort",
					"bsearch",
					"time",
					"clock",
					"difftime",
					"mktime",
					"strftime",
					"getenv",
					"setenv",
					"putenv",
					"system",
					"isalpha",
					"isdigit",
					"isalnum",
					"isspace",
					"isupper",
					"islower",
					"toupper",
					"tolower",
					"sizeof",
					"offsetof",
					"NULL",
					"EXIT_SUCCESS",
					"EXIT_FAILURE",
				]);
				return STDLIB_NAMES.has(name);
			}
			case "c_octal_literal": {
				const num = captures.NUM?.text ?? "";
				return /^0[0-7]+$/.test(num);
			}
			case "c_noreturn_attr": {
				const attr = captures.ATTR?.text ?? "";
				return attr === "noreturn";
			}
			case "c_label_in_switch": {
				const stmt = captures.STMT;
				if (!stmt) return false;
				let node: TreeSitterNode | null | undefined = stmt.parent;
				while (node) {
					if (node.type === "switch_statement") return true;
					node = node.parent;
				}
				return false;
			}
			default:
				return true;
		}
	}

	/**
	 * Evaluate text predicates (#match?, #eq?) for a query match.
	 * web-tree-sitter stores these as compiled functions in query.textPredicates[patternIndex]
	 * and does NOT apply them automatically via .matches().
	 */
	// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter types
	private evaluatePredicates(query: any, match: any): boolean {
		const predicates: Array<(captures: unknown) => boolean> =
			query.textPredicates?.[match.patternIndex] ?? [];
		return predicates.every((fn) => fn(match.captures));
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
		contentOverride?: string,
	): Promise<StructuralMatch[]> {
		const tree = await this.parseFile(filePath, languageId, contentOverride);
		if (!tree) return [];

		const matches: StructuralMatch[] = [];

		try {
			const queryMatches = query.matches(tree.rootNode);

			for (const match of queryMatches) {
				const captures: Record<string, TreeSitterNode> = {};

				for (const capture of match.captures) {
					if (metavars.includes(capture.name)) {
						captures[capture.name] = capture.node;
					}
				}

				// Evaluate #match? and #eq? predicates that web-tree-sitter doesn't enforce automatically
				if (!this.evaluatePredicates(query, match)) {
					continue;
				}

				if (
					postFilter &&
					!this.applyPostFilter(postFilter, postFilterParams, captures)
				) {
					continue;
				}

				if (match.captures.length > 0) {
					const firstNode = match.captures[0].node;
					const textCaptures: Record<string, string> = {};
					for (const [name, node] of Object.entries(captures)) {
						textCaptures[name] = (node as TreeSitterNode).text;
					}
					matches.push({
						file: filePath,
						line: firstNode.startPosition.row + 1,
						column: firstNode.startPosition.column + 1,
						matchedText: firstNode.text,
						nodeType: firstNode.type as string | undefined,
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
		const rootDir = path.resolve(dir);
		const ignoreMatcher = getProjectIgnoreMatcher(rootDir);

		// Hard cap on the walk itself (not just result collection). The per-file
		// `maxResults` break upstream only stops gathering matches *after* the walk
		// has already enumerated the whole tree — so a misrooted structuralSearch
		// would still synchronously read every directory. Bound the walk (#262).
		const scan = (d: string) => {
			if (files.length >= TREE_SITTER_MAX_SCAN_FILES) return;
			try {
				const entries = fs.readdirSync(d, { withFileTypes: true });
				for (const entry of entries) {
					if (files.length >= TREE_SITTER_MAX_SCAN_FILES) return;
					const full = path.join(d, entry.name);
					if (entry.isDirectory()) {
						if (isExcludedDirName(entry.name)) continue;
						if (ignoreMatcher.isIgnored(full, true)) continue;
						scan(full);
					} else if (extensions.some((ext) => entry.name.endsWith(ext))) {
						if (ignoreMatcher.isIgnored(full, false)) continue;
						if (!fileFilter || fileFilter(full)) {
							files.push(full);
						}
					}
				}
			} catch {}
		};

		scan(rootDir);
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
			kotlin: [".kt", ".kts"],
			dart: [".dart"],
			c: [".c", ".h"],
			cpp: [".cpp", ".hpp", ".cc", ".hh"],
			elixir: [".ex", ".exs"],
			ruby: [".rb"],
		};
		return mapping[languageId] || [];
	}
}

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
		.replace(/\\/g, "\\\\")
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
