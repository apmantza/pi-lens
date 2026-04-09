/**
 * Tree-sitter Structural Analysis Runner
 *
 * Executes all loaded tree-sitter query files from rules/tree-sitter-queries/
 * for fast AST-based pattern matching.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { RuleCache } from "../../cache/rule-cache.js";
import { getSourceFiles } from "../../scan-utils.js";
import { TreeSitterClient } from "../../tree-sitter-client.js";
import { logTreeSitter } from "../../tree-sitter-logger.js";
import { classifyDefect } from "../diagnostic-taxonomy.js";
import {
	queryLoader,
	type TreeSitterQuery,
} from "../../tree-sitter-query-loader.js";
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
const entitySnapshotByFile = new Map<string, Map<string, string>>();
const blastFileCache = new Map<string, { expiresAt: number; files: string[] }>();
const blastCooldownByFile = new Map<string, number>();
const BLAST_CACHE_TTL_MS = 30_000;
const MAX_BLAST_FILES = 300;
const MAX_BLAST_ENTITIES = 8;
const BLAST_MAX_FILE_BYTES = 128 * 1024;
const BLAST_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const BLAST_MAX_ELAPSED_MS = 120;
const BLAST_COOLDOWN_MS = 5_000;

interface EntityQueryDef {
	id: string;
	kind: string;
	query: string;
}

const ENTITY_QUERIES: Partial<Record<string, EntityQueryDef[]>> = {
	typescript: [
		{
			id: "entity-ts-function",
			kind: "function",
			query: "(function_declaration name: (identifier) @NAME)",
		},
		{
			id: "entity-ts-class",
			kind: "class",
			query: "(class_declaration name: (type_identifier) @NAME)",
		},
		{
			id: "entity-ts-method",
			kind: "method",
			query: "(method_definition name: (property_identifier) @NAME)",
		},
	],
	javascript: [
		{
			id: "entity-js-function",
			kind: "function",
			query: "(function_declaration name: (identifier) @NAME)",
		},
		{
			id: "entity-js-class",
			kind: "class",
			query: "(class_declaration name: (identifier) @NAME)",
		},
		{
			id: "entity-js-method",
			kind: "method",
			query: "(method_definition name: (property_identifier) @NAME)",
		},
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
	],
	ruby: [
		{
			id: "entity-rb-method",
			kind: "method",
			query: "(method name: (identifier) @NAME)",
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
};

function escapeRegex(name: string): string {
	return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function diffEntitySnapshot(
	prev: Map<string, string> | undefined,
	next: Map<string, string>,
): { added: string[]; removed: string[]; modified: string[] } {
	if (!prev) {
		return { added: [...next.keys()], removed: [], modified: [] };
	}

	const added: string[] = [];
	const removed: string[] = [];
	const modified: string[] = [];

	for (const [key, value] of next.entries()) {
		if (!prev.has(key)) {
			added.push(key);
			continue;
		}
		if (prev.get(key) !== value) {
			modified.push(key);
		}
	}

	for (const key of prev.keys()) {
		if (!next.has(key)) {
			removed.push(key);
		}
	}

	return { added, removed, modified };
}

function getBlastFiles(cwd: string): string[] {
	const now = Date.now();
	const cached = blastFileCache.get(cwd);
	if (cached && cached.expiresAt > now) return cached.files;

	const files = getSourceFiles(cwd).slice(0, MAX_BLAST_FILES);
	blastFileCache.set(cwd, { files, expiresAt: now + BLAST_CACHE_TTL_MS });
	return files;
}

function computeBlastRadius(
	entityNames: string[],
	filePath: string,
	cwd: string,
): {
	entities: Array<{ entity: string; dependentFiles: number; references: number }>;
	scannedFiles: number;
	scannedBytes: number;
	totalCandidates: number;
	truncated: boolean;
	elapsedMs: number;
} {
	const startedAt = Date.now();
	const limited = entityNames.slice(0, MAX_BLAST_ENTITIES);
	if (limited.length === 0) {
		return {
			entities: [],
			scannedFiles: 0,
			scannedBytes: 0,
			totalCandidates: 0,
			truncated: false,
			elapsedMs: 0,
		};
	}

	const regexByEntity = new Map(
		limited.map((name) => [name, new RegExp(`\\b${escapeRegex(name)}\\b`, "g")]),
	);
	const files = getBlastFiles(cwd);
	const stats = new Map(
		limited.map((name) => [name, { dependentFiles: 0, references: 0 }]),
	);
	let scannedFiles = 0;
	let scannedBytes = 0;
	let truncated = false;

	for (const candidate of files) {
		if (Date.now() - startedAt > BLAST_MAX_ELAPSED_MS) {
			truncated = true;
			break;
		}

		if (path.resolve(candidate) === path.resolve(filePath)) continue;
		let size = 0;
		try {
			size = fs.statSync(candidate).size;
		} catch {
			continue;
		}
		if (size > BLAST_MAX_FILE_BYTES) continue;
		if (scannedBytes + size > BLAST_MAX_TOTAL_BYTES) {
			truncated = true;
			break;
		}

		let content = "";
		try {
			content = fs.readFileSync(candidate, "utf-8");
		} catch {
			continue;
		}
		scannedFiles += 1;
		scannedBytes += size;

		for (const [name, regex] of regexByEntity.entries()) {
			const matches = content.match(regex);
			if (!matches || matches.length === 0) continue;
			const current = stats.get(name);
			if (!current) continue;
			current.dependentFiles += 1;
			current.references += matches.length;
		}
	}

	const entities = limited
		.map((name) => ({ entity: name, ...stats.get(name)! }))
		.sort((a, b) => b.dependentFiles - a.dependentFiles)
		.slice(0, 5);

	return {
		entities,
		scannedFiles,
		scannedBytes,
		totalCandidates: files.length,
		truncated,
		elapsedMs: Date.now() - startedAt,
	};
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

function getSharedClient(): TreeSitterClient {
	if (!_sharedClient) {
		_sharedClient = new TreeSitterClient();
	}
	return _sharedClient;
}

const treeSitterRunner: RunnerDefinition = {
	id: "tree-sitter",
	appliesTo: ["jsts", "python", "go", "rust", "ruby"],
	priority: 14, // Between oxlint (12) and ast-grep-napi (15)
	enabledByDefault: true,
	skipTestFiles: false, // Run on test files too (structural issues matter there)

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Use singleton client — WASM must never be re-initialized after first call
		const client = getSharedClient();
		logTreeSitter({ phase: "runner_start", filePath: ctx.filePath });
		if (!client.isAvailable()) {
			logTreeSitter({
				phase: "runner_skip",
				filePath: ctx.filePath,
				reason: "client_unavailable",
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
		const ext = filePath.slice(filePath.lastIndexOf("."));
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
		};
		const languageId = EXT_TO_LANG[ext];
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

		// Get all rule files for this language (use ctx.cwd for project root)
		const rulesDir = path.join(
			ctx.cwd,
			"rules",
			"tree-sitter-queries",
			languageId,
		);
		const ruleFiles: string[] = [];
		if (fs.existsSync(rulesDir)) {
			ruleFiles.push(
				...fs
					.readdirSync(rulesDir)
					.filter((f) => f.endsWith(".yml"))
					.map((f) => path.join(rulesDir, f)),
			);
		}

		// Try cache
		const cached = cache.get(ruleFiles);
		let cacheHit = false;
		if (cached) {
			// Use cached queries
			cacheHit = true;
			languageQueries = cached.queries.map(
				(q) =>
					({
						...q,
						has_fix: false,
						filePath: "",
					}) as TreeSitterQuery,
			);
		} else {
			// Load from disk
			await queryLoader.loadQueries(ctx.cwd);

			const allQueries = queryLoader.getAllQueries();
			languageQueries = allQueries.filter(
				(q) =>
					q.language === languageId ||
					(languageId === "javascript" && q.language === "typescript"),
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

		const effectiveQueries = ctx.blockingOnly
			? languageQueries.filter(
					(q) =>
						q.inline_tier !== "review" &&
						(q.severity === "error" ||
							q.inline_tier === "blocking" ||
							SILENT_ERROR_QUERY_IDS.has(q.id)),
				)
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

		const diagnostics: Diagnostic[] = [];

		// Run each query against the file
		for (const query of effectiveQueries) {
			try {
				const matches = await client.runQueryOnFile(query, filePath, languageId, {
					maxResults: 10,
				});

				for (const match of matches) {
					// Get line/column from match (already 0-indexed from tree-sitter)
					const line = match.line;
					const column = match.column;

					if (
						ctx.blockingOnly &&
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

					diagnostics.push({
						id: `tree-sitter:${query.id}:${line}`,
						message: query.message,
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
						fixable: query.has_fix,
						fixSuggestion: suggestion,
					});
				}
			} catch (err) {
				// Individual query failure shouldn't stop other queries
				console.error(`[tree-sitter] Query ${query.id} failed:`, err);
				logTreeSitter({
					phase: "query_error",
					filePath,
					languageId,
					queryId: query.id,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		if (diagnostics.length === 0) {
			try {
				const snapshot = await extractEntitySnapshot(client, filePath, languageId);
				const prev = entitySnapshotByFile.get(filePath);
				const diff = diffEntitySnapshot(prev, snapshot);
				entitySnapshotByFile.set(filePath, snapshot);
				const changedEntityKeys = [...diff.added, ...diff.modified, ...diff.removed];
				const changedNames = [...new Set(changedEntityKeys.map((k) => k.split(":")[1]).filter(Boolean))];

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
						const blastRadius = computeBlastRadius(changedNames, filePath, ctx.cwd);
						logTreeSitter({
							phase: "blast_radius",
							filePath,
							languageId,
							metadata: {
								entities: blastRadius.entities,
								scannedFiles: blastRadius.scannedFiles,
								scannedBytes: blastRadius.scannedBytes,
								totalCandidates: blastRadius.totalCandidates,
								truncated: blastRadius.truncated,
								elapsedMs: blastRadius.elapsedMs,
							},
						});
					}
				}
			} catch {}

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
			const snapshot = await extractEntitySnapshot(client, filePath, languageId);
			const prev = entitySnapshotByFile.get(filePath);
			const diff = diffEntitySnapshot(prev, snapshot);
			entitySnapshotByFile.set(filePath, snapshot);
			const changedEntityKeys = [
				...diff.added,
				...diff.modified,
				...diff.removed,
			];
			const changedNames = [
				...new Set(changedEntityKeys.map((k) => k.split(":")[1]).filter(Boolean)),
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
					const blastRadius = computeBlastRadius(changedNames, filePath, ctx.cwd);
					logTreeSitter({
						phase: "blast_radius",
						filePath,
						languageId,
						metadata: {
							entities: blastRadius.entities,
							scannedFiles: blastRadius.scannedFiles,
							scannedBytes: blastRadius.scannedBytes,
							totalCandidates: blastRadius.totalCandidates,
							truncated: blastRadius.truncated,
							elapsedMs: blastRadius.elapsedMs,
						},
					});
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
