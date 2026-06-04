/**
 * Tree-sitter Structural Analysis Runner
 *
 * Executes all loaded tree-sitter query files from rules/tree-sitter-queries/
 * for fast AST-based pattern matching.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { RuleCache } from "../../cache/rule-cache.js";
import { resolvePackagePath } from "../../package-root.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
	recordEntitySnapshotDiff,
} from "../../review-graph/service.js";
import { TreeSitterClient } from "../../tree-sitter-client.js";
import { logTreeSitter } from "../../tree-sitter-logger.js";
import {
	isDisabledQueryFilePath,
	queryLoader,
	type TreeSitterQuery,
} from "../../tree-sitter-query-loader.js";
import { classifyDefect } from "../diagnostic-taxonomy.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

// Module-level singleton: web-tree-sitter WASM must only be initialized once per process.
// Creating a new TreeSitterClient() on every write resets TRANSFER_BUFFER (a module-level
// WASM pointer) — concurrent writes race on _ts_init() and corrupt shared WASM state → crash.
let _sharedClient: TreeSitterClient | null = null;
// Once the wasm runtime aborts, the entire module-level wasm heap is corrupted — no
// recovery is possible within this process. Flag it and skip all further tree-sitter work
// rather than re-invoking the dead runtime (which prints "Aborted()" on every call and
// leaks memory on each retry).
let _wasmAborted = false;
const blastCooldownByFile = new Map<string, number>();
const BLAST_COOLDOWN_MS = 5_000;

function runBlastRadiusInBackground(
	cwd: string,
	filePath: string,
	languageId: string,
	facts: DispatchContext["facts"],
): void {
	// Fire-and-forget: graph construction is expensive (~3s) and is enrichment-only.
	// Running it in background keeps the dispatch result fast.
	void (async () => {
		try {
			const graph = await buildOrUpdateGraph(cwd, [filePath], facts);
			const impact = computeImpactCascade(graph, filePath);
			logTreeSitter({
				phase: "blast_radius",
				filePath,
				languageId,
				metadata: {
					changedSymbols: impact.changedSymbols,
					neighborFiles: impact.neighborFiles,
					directImporters: impact.directImporters,
					directCallers: impact.directCallers,
					riskFlags: impact.riskFlags,
				},
			});
		} catch {
			/* best-effort enrichment */
		}
	})();
}

interface EntityQueryDef {
	id: string;
	kind: string;
	query: string;
}

// Queries that are identical across TypeScript and JavaScript grammars.
const JSTS_SHARED_ENTITY_QUERIES: EntityQueryDef[] = [
	{
		id: "entity-jsts-function",
		kind: "function",
		query: "(function_declaration name: (identifier) @NAME)",
	},
	{
		id: "entity-jsts-method",
		kind: "method",
		query: "(method_definition name: (property_identifier) @NAME)",
	},
	{
		id: "entity-jsts-arrow",
		kind: "function",
		query:
			"(lexical_declaration (variable_declarator name: (identifier) @NAME value: [(arrow_function) (function_expression)]))",
	},
];

// TypeScript-only structural types — no JS equivalents in the grammar.
const TS_STRUCTURAL_ENTITY_QUERIES: EntityQueryDef[] = [
	{
		id: "entity-ts-interface",
		kind: "interface",
		query: "(interface_declaration name: (type_identifier) @NAME)",
	},
	{
		id: "entity-ts-type",
		kind: "type",
		query: "(type_alias_declaration name: (type_identifier) @NAME)",
	},
	{
		id: "entity-ts-enum",
		kind: "enum",
		query: "(enum_declaration name: (identifier) @NAME)",
	},
];

const ENTITY_QUERIES: Partial<Record<string, EntityQueryDef[]>> = {
	typescript: [
		// class name node differs between TS (type_identifier) and JS (identifier)
		{
			id: "entity-ts-class",
			kind: "class",
			query: "(class_declaration name: (type_identifier) @NAME)",
		},
		...JSTS_SHARED_ENTITY_QUERIES,
		...TS_STRUCTURAL_ENTITY_QUERIES,
	],
	javascript: [
		{
			id: "entity-js-class",
			kind: "class",
			query: "(class_declaration name: (identifier) @NAME)",
		},
		...JSTS_SHARED_ENTITY_QUERIES,
	],
	python: [
		{
			id: "entity-py-function",
			kind: "function",
			query: "(function_definition name: (identifier) @NAME)",
		},
		{
			id: "entity-py-class",
			kind: "class",
			query: "(class_definition name: (identifier) @NAME)",
		},
	],
	go: [
		{
			id: "entity-go-function",
			kind: "function",
			query: "(function_declaration name: (identifier) @NAME)",
		},
		{
			id: "entity-go-method",
			kind: "method",
			query: "(method_declaration name: (field_identifier) @NAME)",
		},
		{
			id: "entity-go-type",
			kind: "type",
			query: "(type_spec name: (type_identifier) @NAME)",
		},
	],
	rust: [
		{
			id: "entity-rs-function",
			kind: "function",
			query: "(function_item name: (identifier) @NAME)",
		},
		{
			id: "entity-rs-struct",
			kind: "struct",
			query: "(struct_item name: (type_identifier) @NAME)",
		},
		{
			id: "entity-rs-enum",
			kind: "enum",
			query: "(enum_item name: (type_identifier) @NAME)",
		},
		// trait changes break all implementors — critical for blast-radius
		{
			id: "entity-rs-trait",
			kind: "trait",
			query: "(trait_item name: (type_identifier) @NAME)",
		},
		{
			id: "entity-rs-type",
			kind: "type",
			query: "(type_item name: (type_identifier) @NAME)",
		},
	],
	ruby: [
		{
			id: "entity-rb-method",
			kind: "method",
			query: "(method name: (identifier) @NAME)",
		},
		// singleton methods (def self.foo) — class-level, miss changes without this
		{
			id: "entity-rb-singleton-method",
			kind: "method",
			query: "(singleton_method name: (identifier) @NAME)",
		},
		{
			id: "entity-rb-class",
			kind: "class",
			query: "(class name: (constant) @NAME)",
		},
		{
			id: "entity-rb-module",
			kind: "module",
			query: "(module name: (constant) @NAME)",
		},
	],
	c: [
		{
			id: "entity-c-function",
			kind: "function",
			query:
				"(function_definition declarator: (function_declarator declarator: (identifier) @NAME))",
		},
		{
			id: "entity-c-typedef",
			kind: "type",
			query: "(type_definition declarator: (type_identifier) @NAME)",
		},
		{
			id: "entity-c-struct",
			kind: "struct",
			query: "(struct_specifier name: (type_identifier) @NAME)",
		},
		{
			id: "entity-c-enum",
			kind: "enum",
			query: "(enum_specifier name: (type_identifier) @NAME)",
		},
	],
	cpp: [
		{
			id: "entity-cpp-function",
			kind: "function",
			query:
				"(function_definition declarator: (function_declarator declarator: (identifier) @NAME))",
		},
		{
			id: "entity-cpp-class",
			kind: "class",
			query: "(class_specifier name: (type_identifier) @NAME)",
		},
		{
			id: "entity-cpp-struct",
			kind: "struct",
			query: "(struct_specifier name: (type_identifier) @NAME)",
		},
		{
			id: "entity-cpp-namespace",
			kind: "namespace",
			query: "(namespace_definition name: (namespace_identifier) @NAME)",
		},
	],
};

async function extractEntitySnapshot(
	client: TreeSitterClient,
	filePath: string,
	languageId: string,
): Promise<Map<string, string>> {
	const defs = ENTITY_QUERIES[languageId] ?? [];
	const snapshot = new Map<string, string>();

	for (const def of defs) {
		const matches = await client.runQueryOnFile(
			{
				id: def.id,
				name: def.id,
				severity: "info",
				category: "entity",
				language: languageId,
				message: "",
				query: def.query,
				metavars: ["NAME"],
				has_fix: false,
				filePath: "",
			},
			filePath,
			languageId,
			{ maxResults: 200 },
		);

		for (const match of matches) {
			const name = match.captures.NAME?.trim();
			if (!name) continue;
			const key = `${def.kind}:${name}`;
			snapshot.set(key, `${match.line}:${match.matchedText.slice(0, 400)}`);
		}
	}

	return snapshot;
}

const SILENT_ERROR_QUERY_IDS = new Set([
	"empty-catch",
	"python-empty-except",
	"ruby-empty-rescue",
	"go-bare-error",
	"no-discarded-error",
]);

function defaultFixSuggestion(defectClass: string, ruleId: string): string {
	if (defectClass === "silent-error") {
		return "Handle the error path explicitly: add logging/telemetry and rethrow or return a typed error result.";
	}
	if (defectClass === "secrets") {
		return "Move secret material to environment/secret manager and read it at runtime.";
	}
	if (defectClass === "injection") {
		return "Replace dynamic execution/string interpolation with parameterized or allowlisted operations.";
	}
	if (defectClass === "async-misuse") {
		return "Restructure async flow to handle errors and sequencing deterministically (await/try-catch or explicit concurrency control).";
	}
	if (ruleId.includes("unwrap")) {
		return "Replace unwrap() with explicit error handling (match/if-let) or propagate with ?.";
	}
	return "Refactor this pattern to a safer, explicit form matching project conventions.";
}

function isLineInModifiedRanges(
	line: number,
	ranges: ReadonlyArray<{ start: number; end: number }> | undefined,
): boolean {
	if (!ranges || ranges.length === 0) return true;
	return ranges.some((r) => line >= r.start && line <= r.end);
}

function getSharedClient(): TreeSitterClient | null {
	if (_wasmAborted) return null;
	if (!_sharedClient) {
		_sharedClient = new TreeSitterClient();
	}
	return _sharedClient;
}

/**
 * Calculate total lines changed in modified ranges.
 * Used to skip expensive entity extraction for trivial changes.
 */
function getTotalLinesChanged(
	ranges: ReadonlyArray<{ start: number; end: number }> | undefined,
): number {
	if (!ranges || ranges.length === 0) return 0;
	return ranges.reduce((total, r) => total + (r.end - r.start + 1), 0);
}

/** Threshold: skip entity extraction for changes under 5 lines */
const ENTITY_EXTRACTION_LINE_THRESHOLD = 5;

function resolveTreeSitterLanguage(filePath: string): string | undefined {
	const ext = path.extname(filePath).toLowerCase();
	const EXT_TO_LANG: Record<string, string> = {
		".ts": "typescript",
		".mts": "typescript",
		".cts": "typescript",
		".tsx": "tsx",
		".js": "javascript",
		".mjs": "javascript",
		".cjs": "javascript",
		".jsx": "javascript",
		".py": "python",
		".go": "go",
		".rs": "rust",
		".rb": "ruby",
		".c": "c",
		".h": "c",
		".cc": "cpp",
		".cpp": "cpp",
		".cxx": "cpp",
		".c++": "cpp",
		".hh": "cpp",
		".hpp": "cpp",
		".hxx": "cpp",
		".inl": "cpp",
		".ipp": "cpp",
		".tpp": "cpp",
		".txx": "cpp",
		".cu": "cpp",
		".hip": "cpp",
		".cs": "csharp",
		".php": "php",
		".phtml": "php",
		".php3": "php",
		".php4": "php",
		".php5": "php",
		".css": "css",
	};
	return EXT_TO_LANG[ext];
}

const treeSitterRunner: RunnerDefinition = {
	id: "tree-sitter",
	appliesTo: ["jsts", "python", "go", "rust", "ruby", "cxx", "csharp", "php", "css"],
	priority: PRIORITY.STRUCTURAL_ANALYSIS,
	enabledByDefault: true,
	skipTestFiles: false, // Run on test files too (structural issues matter there)

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Use singleton client — WASM must never be re-initialized after first call
		const client = getSharedClient();
		logTreeSitter({ phase: "runner_start", filePath: ctx.filePath });
		if (!client || !client.isAvailable()) {
			logTreeSitter({
				phase: "runner_skip",
				filePath: ctx.filePath,
				reason: _wasmAborted ? "wasm_aborted" : "client_unavailable",
				status: "skipped",
			});
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const initialized = await client.init();
		if (!initialized) {
			logTreeSitter({
				phase: "runner_skip",
				filePath: ctx.filePath,
				reason: "client_init_failed",
				status: "skipped",
			});
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Determine language from file extension
		const filePath = ctx.filePath;
		const ext = path.extname(filePath).toLowerCase();
		const languageId = resolveTreeSitterLanguage(filePath);
		if (!languageId) {
			logTreeSitter({
				phase: "runner_skip",
				filePath: ctx.filePath,
				reason: `unsupported_extension:${ext}`,
				status: "skipped",
			});
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Try cache first, fall back to loading from disk
		let languageQueries: TreeSitterQuery[] = [];
		const cache = new RuleCache(languageId, ctx.cwd);

		// Get all rule files for this language — project-local AND pi-lens built-ins.
		// Both sets must be in the hash so the cache is invalidated when either changes.
		const rulesDir = path.join(
			ctx.cwd,
			"rules",
			"tree-sitter-queries",
			languageId,
		);
		const builtinRulesDir = resolvePackagePath(
			import.meta.url,
			"rules",
			"tree-sitter-queries",
			languageId,
		);
		const ruleFileSet = new Set<string>();
		for (const dir of [rulesDir, builtinRulesDir]) {
			if (fs.existsSync(dir)) {
				for (const f of fs.readdirSync(dir)) {
					if (f.endsWith(".yml")) ruleFileSet.add(path.join(dir, f));
				}
			}
		}
		const ruleFiles = [...ruleFileSet];

		// Try cache
		const cached = cache.get(ruleFiles);
		let cacheHit = false;
		if (cached) {
			// Use cached queries
			cacheHit = true;
			languageQueries = cached.queries
				.map(
					(q) =>
						({
							...q,
							has_fix: q.has_fix ?? false,
							filePath: q.filePath ?? "",
						}) as TreeSitterQuery,
				)
				.filter((q) => !isDisabledQueryFilePath(q.filePath));
		} else {
			// Load from disk
			await queryLoader.loadQueries(ctx.cwd);

			languageQueries = queryLoader.getQueriesForLanguage(languageId);
			if (languageId === "javascript") {
				// JavaScript files also match TypeScript rules (shared grammar)
				const tsQueries = queryLoader.getQueriesForLanguage("typescript");
				languageQueries = [...languageQueries, ...tsQueries];
			}

			// Save to cache
			cache.set(
				ruleFiles,
				languageQueries.map((q) => ({
					id: q.id,
					name: q.name,
					severity: q.severity,
					language: q.language,
					message: q.message,
					query: q.query,
					metavars: q.metavars,
					post_filter: q.post_filter,
					post_filter_params: q.post_filter_params,
					defect_class: q.defect_class,
					inline_tier: q.inline_tier,
					has_fix: q.has_fix,
					filePath: q.filePath,
				})),
			);
		}

		if (languageQueries.length === 0) {
			logTreeSitter({
				phase: "runner_complete",
				filePath,
				languageId,
				status: "succeeded",
				diagnostics: 0,
				blocking: 0,
				queryCount: 0,
				effectiveQueryCount: 0,
			});
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Run all queries regardless of blockingOnly — warning-tier results are logged
		// for diagnostic history but filtered from agent output by the dispatcher.
		// Only skip "review" tier queries on write (too noisy / expensive).
		const effectiveQueries = ctx.blockingOnly
			? languageQueries.filter((q) => q.inline_tier !== "review")
			: languageQueries;

		logTreeSitter({
			phase: "queries_loaded",
			filePath,
			languageId,
			queryCount: languageQueries.length,
			effectiveQueryCount: effectiveQueries.length,
			cacheHit,
			metadata: { blockingOnly: !!ctx.blockingOnly },
		});

		const contentFromFacts = ctx.facts.getFileFact<string | null>(
			filePath,
			"file.content",
		);
		const contentOverride =
			contentFromFacts !== undefined && contentFromFacts !== null
				? contentFromFacts
				: undefined;

		// Run queries in parallel with concurrency limit for optimal performance
		const CONCURRENCY_LIMIT = 6;
		const queryResults: Diagnostic[][] = [];

		for (let i = 0; i < effectiveQueries.length; i += CONCURRENCY_LIMIT) {
			// Yield the event loop between batches so already-resolved promises from
			// other parallel groups (LSP, eslint skip, etc.) can drain. Each wasm query
			// batch is synchronous CPU work that would otherwise pin the event loop for
			// the full runner duration, making other runners' latency measurements wrong.
			if (i > 0) await new Promise<void>((r) => setImmediate(r));
			const batch = effectiveQueries.slice(i, i + CONCURRENCY_LIMIT);
			const batchResults = await Promise.all(
				batch.map(async (query) => {
					const queryDiagnostics: Diagnostic[] = [];
					try {
						const matches = await client.runQueryOnFile(
							query,
							filePath,
							languageId,
							{ maxResults: 10 },
							contentOverride,
						);

						for (const match of matches) {
							// Get line/column from match (already 0-indexed from tree-sitter)
							const line = match.line;
							const column = match.column;

							// Modified-ranges gate only applies to blocking-tier diagnostics.
							// Warning-tier diagnostics always flow through for logging.
							const isSeverityBlocking =
								query.severity === "error" ||
								query.inline_tier === "blocking" ||
								SILENT_ERROR_QUERY_IDS.has(query.id);
							if (
								ctx.blockingOnly &&
								isSeverityBlocking &&
								!isLineInModifiedRanges(line + 1, ctx.modifiedRanges)
							) {
								continue;
							}

							// Map severity to semantic
							const semantic =
								query.severity === "error"
									? "blocking"
									: query.severity === "warning"
										? "warning"
										: "none";
							const defectClass =
								(query.defect_class as any) ??
								classifyDefect(query.id, "tree-sitter", query.message);
							const suggestion =
								query.has_fix && query.fix_action
									? `${query.fix_action} this statement`
									: semantic === "blocking"
										? defaultFixSuggestion(defectClass, query.id)
										: undefined;

							const hasSuggestedFix = !!query.has_fix;
							queryDiagnostics.push({
								id: `tree-sitter:${query.id}:${line}`,
								message: query.message.replace(
									/\{\{(\w+)\}\}/g,
									(_, name) => match.captures[name]?.trim() ?? `{{${name}}}`,
								),
								filePath,
								line: line + 1, // 1-indexed
								column: column + 1, // 1-indexed
								severity: query.severity,
								semantic,
								tool: "tree-sitter",
								rule: query.id,
								defectClass,
								// Surface fix intent to agent — tree-sitter never auto-applies;
								// linters (biome/ruff/eslint) own the autofix phase.
								fixable: hasSuggestedFix,
								autoFixAvailable: false,
								fixKind: hasSuggestedFix ? "suggestion" : undefined,
								fixSuggestion: suggestion,
								matchedText: match.matchedText || undefined,
								astNodeType: match.nodeType || undefined,
							});
						}
					} catch (err) {
						// pi-lens-ignore: missing-error-propagation — per-query resilience loop, intentional
						const msg = err instanceof Error ? err.message : String(err);
						// Emscripten abort() corrupts the entire module-level wasm heap.
						// Poison the singleton so no further queries attempt to use the dead runtime.
						if (msg.includes("Aborted") || msg.includes("abort()")) {
							_wasmAborted = true;
							_sharedClient = null;
							logTreeSitter({
								phase: "query_error",
								filePath,
								languageId,
								queryId: query.id,
								error: "wasm_aborted_fatal",
							});
						} else {
							console.error(`[tree-sitter] Query ${query.id} failed:`, err);
							logTreeSitter({
								phase: "query_error",
								filePath,
								languageId,
								queryId: query.id,
								error: msg,
							});
						}
					}
					return queryDiagnostics;
				}),
			);
			queryResults.push(...batchResults);
		}

		// Flatten all query results into final diagnostics array
		const diagnostics: Diagnostic[] = queryResults.flat();

		// Skip expensive entity extraction for trivial changes (< 5 lines)
		// This avoids ~500-800ms overhead for small edits like single-line fixes
		const totalLinesChanged = getTotalLinesChanged(ctx.modifiedRanges);
		const skipEntityExtraction =
			totalLinesChanged < ENTITY_EXTRACTION_LINE_THRESHOLD;

		if (diagnostics.length === 0 && !skipEntityExtraction) {
			try {
				const snapshot = await extractEntitySnapshot(
					client,
					filePath,
					languageId,
				);
				const diff = recordEntitySnapshotDiff(ctx.facts, filePath, snapshot);
				const changedEntityKeys = [
					...diff.added,
					...diff.modified,
					...diff.removed,
				];

				if (changedEntityKeys.length > 0) {
					logTreeSitter({
						phase: "entity_diff",
						filePath,
						languageId,
						metadata: {
							added: diff.added,
							modified: diff.modified,
							removed: diff.removed,
							totalChanged: changedEntityKeys.length,
						},
					});

					const lastBlast = blastCooldownByFile.get(filePath) ?? 0;
					if (Date.now() - lastBlast < BLAST_COOLDOWN_MS) {
						logTreeSitter({
							phase: "blast_radius",
							filePath,
							languageId,
							metadata: { skipped: "cooldown", cooldownMs: BLAST_COOLDOWN_MS },
						});
					} else {
						blastCooldownByFile.set(filePath, Date.now());
						runBlastRadiusInBackground(
							ctx.cwd,
							filePath,
							languageId,
							ctx.facts,
						);
					}
				}
			} catch {
				/* entity snapshot / blast-radius enrichment is best-effort */
			}

			logTreeSitter({
				phase: "runner_complete",
				filePath,
				languageId,
				status: "succeeded",
				diagnostics: 0,
				blocking: 0,
				queryCount: languageQueries.length,
				effectiveQueryCount: effectiveQueries.length,
			});
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		// Check if any blocking issues
		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
		const blockingCount = diagnostics.filter(
			(d) => d.semantic === "blocking",
		).length;
		try {
			const snapshot = await extractEntitySnapshot(
				client,
				filePath,
				languageId,
			);
			const diff = recordEntitySnapshotDiff(ctx.facts, filePath, snapshot);
			const changedEntityKeys = [
				...diff.added,
				...diff.modified,
				...diff.removed,
			];

			if (changedEntityKeys.length > 0) {
				logTreeSitter({
					phase: "entity_diff",
					filePath,
					languageId,
					metadata: {
						added: diff.added,
						modified: diff.modified,
						removed: diff.removed,
						totalChanged: changedEntityKeys.length,
					},
				});

				const lastBlast = blastCooldownByFile.get(filePath) ?? 0;
				if (Date.now() - lastBlast < BLAST_COOLDOWN_MS) {
					logTreeSitter({
						phase: "blast_radius",
						filePath,
						languageId,
						metadata: { skipped: "cooldown", cooldownMs: BLAST_COOLDOWN_MS },
					});
				} else {
					blastCooldownByFile.set(filePath, Date.now());
					runBlastRadiusInBackground(ctx.cwd, filePath, languageId, ctx.facts);
				}
			}
		} catch {
			// best-effort experimental telemetry only
		}

		logTreeSitter({
			phase: "runner_complete",
			filePath,
			languageId,
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics: diagnostics.length,
			blocking: blockingCount,
			queryCount: languageQueries.length,
			effectiveQueryCount: effectiveQueries.length,
		});

		return {
			status: hasBlocking ? "failed" : "succeeded",
			diagnostics,
			semantic: hasBlocking ? "blocking" : "warning",
		};
	},
};

export default treeSitterRunner;
