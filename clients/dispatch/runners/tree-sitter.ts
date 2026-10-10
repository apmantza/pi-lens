/**
 * Tree-sitter Structural Analysis Runner
 *
 * Executes all loaded tree-sitter query files from rules/tree-sitter-queries/
 * for fast AST-based pattern matching.
 */

import * as path from "node:path";
import { RuleCache } from "../../cache/rule-cache.js";
import { isRuleIgnoredForPath } from "../rule-ignores.js";
import { ruleIgnoredForPath } from "../rule-policy.js";
import { isTestFile } from "../../file-utils.js";
import {
	buildOrUpdateGraph,
	computeImpactCascade,
	recordEntitySnapshotDiff,
} from "../../review-graph/service.js";
import {
	classifyTreeSitterWasmError,
	type TreeSitterClient,
} from "../../tree-sitter-client.js";
import {
	getSharedTreeSitterClient,
	isTreeSitterWasmAborted,
	markTreeSitterWasmAborted,
	resolveTreeSitterLanguage,
} from "../../tree-sitter-shared.js";
import { logTreeSitter } from "../../tree-sitter-logger.js";
import {
	isDisabledQueryFilePath,
	queriesForLanguage,
	queryLoader,
	ruleFilesForLanguage,
	ruleSourceLanguages,
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
import { findingsResult } from "../types.js";

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
			const impact = computeImpactCascade(graph, filePath, cwd);
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
	contentOverride?: string,
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
			// Parse the same buffer content the diagnostics phase used (#885).
			// Without this, unsaved buffers snapshot stale disk content and
			// thrash the parse-cache entry the rule walk just populated.
			contentOverride,
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

const treeSitterRunner: RunnerDefinition = {
	id: "tree-sitter",
	appliesTo: [
		"jsts",
		"python",
		"go",
		"rust",
		"ruby",
		"cxx",
		"csharp",
		"php",
		"css",
	],
	priority: PRIORITY.STRUCTURAL_ANALYSIS,
	skipTestFiles: false, // Run on test files too (structural issues matter there)

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Use singleton client — WASM must never be re-initialized after first call
		const client = getSharedTreeSitterClient();
		logTreeSitter({ phase: "runner_start", filePath: ctx.filePath });
		if (!client || !client.isAvailable()) {
			logTreeSitter({
				phase: "runner_skip",
				filePath: ctx.filePath,
				reason: isTreeSitterWasmAborted()
					? "wasm_aborted"
					: "client_unavailable",
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

		// Fingerprint EVERY rule file the effective rule set for this language is
		// built from — project-local AND bundled built-ins, across all rule-source
		// languages (tsx also runs the typescript rules; #878). The loader owns
		// that composition so this can't drift from `queriesForLanguage`.
		const ruleFiles = ruleFilesForLanguage(languageId, ctx.cwd);

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
			// A miss means the rule-file fingerprint moved (or no cache yet), so the
			// loader's in-memory memo may hold the PRE-edit rules — without `force`
			// it would hand those back and cache.set below would persist stale rules
			// under the fresh fingerprint, poisoning every future process (#878).
			await queryLoader.loadQueries(ctx.cwd, { force: true });

			// The effective rule set is composed by the loader (tsx also runs the
			// typescript rules; javascript deliberately does not — see
			// ruleSourceLanguages in tree-sitter-query-loader.ts).
			languageQueries = queriesForLanguage(
				new Map(
					ruleSourceLanguages(languageId).map((lang) => [
						lang,
						queryLoader.getQueriesForLanguage(lang),
					]),
				),
				languageId,
			);

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
					skip_test_files: q.skip_test_files,
					ignore_paths: q.ignore_paths,
					has_fix: q.has_fix,
					fix_action: q.fix_action,
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
		// Per-rule test-file carve-out (#440): rules that are noise in tests (e.g.
		// python-assert-production — `assert` is the idiomatic test assertion) opt
		// out via `skip_test_files` while the runner otherwise runs on test files.
		const fileIsTest = isTestFile(filePath);
		// Per-rule path carve-out (#965): a rule that's noise on CLI scripts or a
		// project's own logging sink (e.g. no-console-except-error firing inside
		// scripts/** or lib/logger.ts) opts out via `ignore_paths`, the same way
		// `skip_test_files` opts a rule out of test files above.
		const ignoreRoot = ctx.projectRoot ?? ctx.cwd;
		const effectiveQueries = (
			ctx.blockingOnly
				? languageQueries.filter((q) => q.inline_tier !== "review")
				: languageQueries
		).filter(
			(q) =>
				!(fileIsTest && q.skip_test_files) &&
				!isRuleIgnoredForPath(filePath, ignoreRoot, q.ignore_paths) &&
				!ruleIgnoredForPath(q.id, filePath, ignoreRoot, ctx.rulePolicy),
		);

		logTreeSitter({
			phase: "queries_loaded",
			filePath,
			languageId,
			queryCount: languageQueries.length,
			effectiveQueryCount: effectiveQueries.length,
			cacheHit,
			metadata: { blockingOnly: !!ctx.blockingOnly },
		});
		if (effectiveQueries.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		const contentFromFacts = ctx.facts.getFileFact<string | null>(
			filePath,
			"file.content",
		);
		const contentOverride =
			contentFromFacts !== undefined && contentFromFacts !== null
				? contentFromFacts
				: undefined;

		// ONE tree walk for the whole effective rule set, not one per rule (#888).
		// The per-rule loop re-walked the tree ~30-40 times per edit; the work is
		// synchronous WASM, so the concurrency-limit batching only chunked CPU work
		// without parallelizing anything. runQueriesOnFile concatenates the patterns
		// in rule order and maps each match back to its owning rule, so the per-rule
		// maxResults(10) cap, metavars, predicates and post-filters still apply and
		// results stay grouped in rule order. The post-match gating below (modified
		// ranges, severity mapping) is unchanged.
		const diagnostics: Diagnostic[] = [];
		try {
			const found = await client.runQueriesOnFile(
				effectiveQueries,
				filePath,
				languageId,
				{ maxResults: 10 },
				contentOverride,
			);

			for (const { queryDef: query, match } of found) {
				// match.line/column are already 1-indexed — the client emits
				// startPosition.row + 1 (tree-sitter-client searchFileWithQuery).
				const { line, column } = match;

				// Modified-ranges gate only applies to blocking-tier diagnostics.
				// Warning-tier diagnostics always flow through for logging.
				const isSeverityBlocking =
					query.severity === "error" ||
					query.inline_tier === "blocking" ||
					SILENT_ERROR_QUERY_IDS.has(query.id);
				if (
					ctx.blockingOnly &&
					isSeverityBlocking &&
					!isLineInModifiedRanges(line, ctx.modifiedRanges)
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
				diagnostics.push({
					id: `tree-sitter:${query.id}:${line}`,
					message: query.message.replace(
						/\{\{(\w+)\}\}/g,
						(_, name) => match.captures[name]?.trim() ?? `{{${name}}}`,
					),
					filePath,
					line,
					column,
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
			// pi-lens-ignore: missing-error-propagation — per-dispatch resilience, intentional
			const msg = err instanceof Error ? err.message : String(err);
			// Emscripten abort() corrupts the entire module-level wasm heap.
			// Poison the singleton so no further queries attempt to use the dead runtime.
			if (classifyTreeSitterWasmError(err) === "abort") {
				markTreeSitterWasmAborted();
				logTreeSitter({
					phase: "query_error",
					filePath,
					languageId,
					error: "wasm_aborted_fatal",
					metadata: { queryIds: effectiveQueries.map((q) => q.id) },
				});
			} else {
				// #1333: the logTreeSitter call below already carries this failure to
				// tree-sitter.log — the console.error was a duplicate RAW write into
				// pi's frame, not a second destination. Sink kept, write dropped.
				logTreeSitter({
					phase: "query_error",
					filePath,
					languageId,
					error: msg,
					metadata: { queryIds: effectiveQueries.map((q) => q.id) },
				});
			}
		}

		// Skip expensive entity extraction for trivial changes (< 5 lines).
		// Before #885 this threshold only guarded the zero-diagnostics early
		// return below; a second extractEntitySnapshot block ran UNCONDITIONALLY
		// after it, so small edits (skipEntityExtraction=true) still paid the
		// ~500-800ms snapshot cost on every dispatch. One guarded block now
		// serves both paths.
		// Absent/empty modifiedRanges means "whole file" (full-file dispatches,
		// fresh writes — see isLineInModifiedRanges above), never "trivial edit":
		// entity extraction must run in that case.
		const totalLinesChanged = getTotalLinesChanged(ctx.modifiedRanges);
		const skipEntityExtraction =
			ctx.modifiedRanges != null &&
			ctx.modifiedRanges.length > 0 &&
			totalLinesChanged < ENTITY_EXTRACTION_LINE_THRESHOLD;

		if (!skipEntityExtraction) {
			try {
				const snapshot = await extractEntitySnapshot(
					client,
					filePath,
					languageId,
					contentOverride,
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
		}

		if (diagnostics.length === 0) {
			// #3409: zero diagnostics because the language's GRAMMAR never loaded is
			// not a clean file, and `runQueriesOnFile` returns [] for both. The
			// honest discriminator, once the run has already demanded the language,
			// is the client's own loaded-language map: a grammar that could not be
			// resolved, fetched, or decoded is absent from it. Reported through this
			// runner's existing "the analysis did not run" arm (the same
			// `runner_skip` + `status: "skipped"` shape as client-unavailable,
			// init-failed and unsupported-extension) instead of as a pass with
			// nothing found — which is what made a degraded language on a compiled
			// host indistinguishable from a clean file in `runner_complete`.
			//
			// The abort term keeps a mid-run WASM abort (#402, its own
			// `runtime_abort` record) from being misreported as a missing grammar.
			if (!isTreeSitterWasmAborted() && !client.getLanguage(languageId)) {
				logTreeSitter({
					phase: "runner_skip",
					filePath,
					languageId,
					reason: "grammar_unavailable",
					status: "skipped",
				});
				return { status: "skipped", diagnostics: [], semantic: "none" };
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

		return findingsResult(diagnostics, {
			status: hasBlocking ? "failed" : "succeeded",
			semantic: hasBlocking ? "blocking" : "warning",
		});
	},
};

export default treeSitterRunner;
