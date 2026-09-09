/**
 * Tree-sitter Query Loader
 *
 * Loads tree-sitter queries from YAML files in rules/tree-sitter-queries/
 * and provides them to the TreeSitterClient.
 */

import { logTreeSitterDiagnostic } from "./tree-sitter-logger.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type BundledResourceHealth,
	classifyBundledResourceDir,
	reportBundledResourceDirHealth,
} from "./bundled-resource-health.js";
import { getDegradationLedgerGeneration } from "./degradation-ledger.js";
import { resolvePackagePath } from "./package-root.js";

/**
 * The bundled `rules/tree-sitter-queries` root — the ONE spelling of this
 * path, imported by `clients/cache/rule-cache.ts` (re-exported there as
 * `BUNDLED_RULES_ROOT`, #2636 review F4) rather than computed a second time,
 * so the "one ledger row, not two" claim for `tree-sitter-queries-dir-missing`
 * rests on reference equality, not merely two independently-resolved strings
 * that happen to match.
 */
export const BUNDLED_QUERIES_ROOT = resolvePackagePath(
	import.meta.url,
	"rules",
	"tree-sitter-queries",
);

let cachedBundledQueriesRootHealth: BundledResourceHealth | undefined;
let cachedBundledQueriesRootHealthGeneration: number | undefined;

/**
 * #2636 review F6/round-2 F3: memoized, but keyed on the degradation
 * ledger's OWN generation counter (bumped by `resetDegradationLedger`, wired
 * into `handleSessionStart`) rather than "compute once, forever" — round 1's
 * version overclaimed that the underlying fact "cannot change mid-process
 * any more than the package's own install location can", but a managed
 * extension cache RELOCATING a live install mid-process is exactly the
 * failure #2587/#2626 investigated: a permanently-cached "absent" verdict
 * from the FIRST probe would never notice the directory coming back (or
 * disappearing later), the same silent-zero shape this issue exists to end.
 * Re-probing once per SESSION (not once per call) is the right middle
 * ground: a real, measured `readdirSync` cost (4.2 µs) is paid once per
 * session rather than on every dispatched file — same generation-keyed
 * pattern `clients/ast-grep-client.ts`'s `ensureRulesHealthReported` uses
 * for its own per-instance re-check.
 */
export function getBundledQueriesRootHealth(): BundledResourceHealth {
	const generation = getDegradationLedgerGeneration();
	if (
		cachedBundledQueriesRootHealth === undefined ||
		cachedBundledQueriesRootHealthGeneration !== generation
	) {
		cachedBundledQueriesRootHealthGeneration = generation;
		cachedBundledQueriesRootHealth =
			classifyBundledResourceDir(BUNDLED_QUERIES_ROOT);
	}
	return cachedBundledQueriesRootHealth;
}

/** Test-only: clear the memo so a scenario can simulate a different install layout. */
export function _resetBundledQueriesRootHealthForTests(): void {
	cachedBundledQueriesRootHealth = undefined;
	cachedBundledQueriesRootHealthGeneration = undefined;
}

export function isDisabledQueryDirectoryName(name: string): boolean {
	return name.endsWith("-disabled");
}

export function getQueryLanguageKey(directoryName: string): string {
	return isDisabledQueryDirectoryName(directoryName)
		? directoryName.slice(0, -"-disabled".length)
		: directoryName;
}

/**
 * Languages that inherit the typescript rule set on top of their own.
 *
 * ONLY `tsx`: verified rule-for-rule identical on the same source parsed under
 * both grammars (console-statement 16/16, ts-path-traversal 277/277, …), which
 * makes sense — tsx IS typescript plus JSX. `javascript` is deliberately NOT
 * here. It looks like it should be, and the merge existed for years, but the
 * queries were compiled against the typescript grammar and run against
 * javascript trees, so they matched nothing and nobody noticed. Compiled
 * correctly they misfire: JS parameters are bare `(identifier)` where
 * typescript has `required_parameter`, so `duplicate-function-arg` alone
 * reports 59 phantom duplicates across 60 files. Re-enabling it needs the
 * typescript rules validated against the javascript grammar first.
 */
const TYPESCRIPT_RULE_HEIRS = new Set(["tsx"]);

/**
 * The rule-source languages whose directories make up the effective rule set
 * for a file parsed as `languageId`. This is the SINGLE SOURCE OF TRUTH for
 * rule-set composition: `queriesForLanguage` (selection) and
 * `ruleFilesForLanguage` (the RuleCache fingerprint, #878) both derive from
 * it, so the cache key can never drift from the rules the runner actually runs.
 */
export function ruleSourceLanguages(languageId: string): string[] {
	return TYPESCRIPT_RULE_HEIRS.has(languageId)
		? [languageId, "typescript"]
		: [languageId];
}

/**
 * Every rule file contributing to the effective rule set for `languageId`,
 * from BOTH the project's own `rules/tree-sitter-queries/` tree and the
 * bundled built-ins, across every rule-source language.
 *
 * The dispatch runner hashes this list into the RuleCache key. Fingerprinting
 * only the language's OWN directory missed inherited rule sets — tsx runs the
 * typescript rules too, so editing a typescript rule never invalidated the tsx
 * cache and stale compiled rules kept firing until the process restarted or a
 * tsx rule happened to change (#878).
 */
export function ruleFilesForLanguage(
	languageId: string,
	rootDir = process.cwd(),
): string[] {
	const resolvedRoot = path.resolve(rootDir);
	const files = new Set<string>();
	for (const lang of ruleSourceLanguages(languageId)) {
		for (const dir of [
			path.join(resolvedRoot, "rules", "tree-sitter-queries", lang),
			path.join(BUNDLED_QUERIES_ROOT, lang),
		]) {
			if (!fs.existsSync(dir)) continue;
			for (const f of fs.readdirSync(dir)) {
				if (f.endsWith(".yml")) files.add(path.join(dir, f));
			}
		}
	}
	// #2636 (review F2): a language resolving zero files here is NORMAL when
	// nobody has authored bundled/project queries for it — seven REACHABLE
	// grammars have none by design: bash, dart, elixir, lua, ocaml, swift, zig
	// (`.sh`/`.bash`, `.dart`, `.ex`/`.exs`, `.lua`, `.ml`/`.mli`, `.swift`,
	// `.zig` — see `language-registry.ts`'s `EXTENSION_TO_GRAMMAR`). cobol and
	// plsql are NOT in that registry at all — only their `-disabled` query
	// directories exist — so `ruleFilesForLanguage` never actually resolves
	// those two languageIds in production; they are not examples of this
	// case. A BUG looks identical from an empty `files` set alone: the
	// bundled root itself relocated out from under the package (same
	// managed-cache-relocation shape #2626 fixed for skills/). Only pay for
	// the extra classification in this COLD branch (never on the common,
	// non-empty path), key it on the shared ROOT rather than this call's
	// `languageId` (every language hitting an actually-missing root collapses
	// into the SAME ledger row instead of one per language), and only RECORD
	// when the root is actually unhealthy — one of the seven by-design-empty
	// languages is touched routinely (any `.sh`/`.lua` edit).
	//
	// #2636 review round 2, F2: NO separate phase/latency row here (unlike
	// the ast-grep/skills sibling sites, which log one PER CONSTRUCTION or
	// PER REQUEST — a bounded cardinality). This branch runs on EVERY
	// dispatched file while the root stays broken (AGENTS.md's "no raw
	// per-occurrence log for repeats"): 200 touches of a by-design-empty
	// language against a broken root would otherwise write 200 raw
	// `latency.log` rows. `reportBundledResourceDirHealth`'s
	// `incrementDegradationCount` already answers "did this run" AND "how
	// many times" in a BOUNDED way — one row per session at count 1, then
	// only at power-of-two milestones (1, 2, 4, 8, … so 200 occurrences write
	// exactly 8 durable rows) — so a second, unbounded record here would add
	// nothing the ledger row lacks.
	if (files.size === 0) {
		const health = getBundledQueriesRootHealth();
		if (health.status !== "healthy") {
			reportBundledResourceDirHealth(
				"tree-sitter-queries-dir-missing",
				BUNDLED_QUERIES_ROOT,
				health,
				"bundled tree-sitter query rules",
			);
		}
	}
	return [...files];
}

/**
 * The rule set that applies to a file parsed as `languageId`, in a stable order.
 *
 * Excludes `<language>-disabled/` rules. `getQueriesForLanguage` filtered these
 * for the per-edit runner, but the project scanner read the raw loader map and
 * ran them anyway — 1,936 of a scan's 2,590 tree-sitter findings came from
 * rules somebody had explicitly switched off.
 */
export function queriesForLanguage(
	queries: Map<string, TreeSitterQuery[]>,
	languageId: string,
): TreeSitterQuery[] {
	const enabled = (langId: string): TreeSitterQuery[] =>
		(queries.get(langId) ?? []).filter(
			(q) => !isDisabledQueryFilePath(q.filePath),
		);
	return ruleSourceLanguages(languageId).flatMap((langId) => enabled(langId));
}

/**
 * Drop a trailing ` # comment` from an unquoted YAML scalar. Quoted values keep
 * their `#` (a message may legitimately contain one), matching YAML's rule that
 * a comment only starts after whitespace outside quotes.
 */
function stripInlineComment(value: string): string {
	if (value.startsWith('"') || value.startsWith("'")) return value;
	return value.replace(/\s+#.*$/, "").trim();
}

export function isDisabledQueryFilePath(filePath: string): boolean {
	const normalized = filePath.replaceAll("\\", "/");
	const parts = normalized.split("/").filter(Boolean);
	const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
	return isDisabledQueryDirectoryName(parent);
}

export interface TreeSitterQuery {
	id: string;
	name: string;
	severity: "error" | "warning" | "info";
	category: string;
	language: string;
	message: string;
	description?: string;
	query: string;
	metavars: string[];
	post_filter?: string;
	post_filter_params?: Record<string, unknown>;
	/**
	 * Native tree-sitter predicates for filtering (#eq?, #match?)
	 * These run in WASM and are faster than post-filters
	 */
	predicates?: Array<{
		type: "eq" | "match" | "any-of";
		var: string;
		value: string | string[];
	}>;
	tags?: string[];
	cwe?: string[];
	owasp?: string[];
	confidence?: "low" | "medium" | "high";
	defect_class?: string;
	inline_tier?: "blocking" | "warning" | "review";
	/**
	 * Skip this rule on test files (isTestFile). For advisories that are noise in
	 * tests — e.g. `python-assert-production`: `assert` is the idiomatic test
	 * assertion, so firing there just trains users to ignore the rule (#440).
	 * The tree-sitter runner otherwise runs on test files (structural issues
	 * matter there), so this is a deliberate per-rule carve-out.
	 */
	skip_test_files?: boolean;
	/**
	 * Skip this rule on files whose path (relative to the project root,
	 * forward-slashed) matches any of these glob patterns — e.g. a
	 * `scripts` directory glob plus a `logger.ts` basename glob for a
	 * debug-output rule that's expected to fire in CLI entry points and the
	 * logging sink itself (#965). Same shape/matching as the ast-grep YAML
	 * rule `ignores` field (`clients/dispatch/runners/yaml-rule-parser.ts`)
	 * — kept as a separate opt-in field (not reusing `skip_test_files`'s
	 * boolean) since "is a test file" and "is a CLI script / logger" are
	 * unrelated axes a rule may need independently.
	 */
	ignore_paths?: string[];
	has_fix: boolean;
	fix_action?: string;
	examples?: {
		bad?: string;
		good?: string;
	};
	filePath: string;
}

export class TreeSitterQueryLoader {
	private queries: Map<string, TreeSitterQuery[]> = new Map();
	private loaded = false;
	private loadedRoot: string | null = null;
	private verbose: boolean;

	constructor(verbose = false) {
		this.verbose = verbose;
	}

	/** Debug logging helper */
	private dbg(msg: string): void {
		if (this.verbose) {
			// #1333: verbose gate preserved, sink moved to tree-sitter.log.
			logTreeSitterDiagnostic({
				subsystem: "query-loader",
				level: "debug",
				message: msg,
			});
		}
	}

	/**
	 * Load all queries from the rules/tree-sitter-queries directory.
	 *
	 * Returns the in-memory memo when the same root was already loaded.
	 * `force: true` re-reads from disk even then — the memo has no notion of
	 * rule-file mtimes, so a caller that KNOWS the files changed (the dispatch
	 * runner's RuleCache-miss path: a miss means the rule-file fingerprint
	 * moved) must force, or it gets the pre-edit rules back and persists them
	 * under the fresh fingerprint (#878).
	 */
	async loadQueries(
		rootDir = process.cwd(),
		options: { force?: boolean } = {},
	): Promise<Map<string, TreeSitterQuery[]>> {
		const resolvedRoot = path.resolve(rootDir);
		if (!options.force && this.loaded && this.loadedRoot === resolvedRoot) {
			return this.queries;
		}

		this.queries.clear();
		this.loaded = false;

		// Load from user's project rules AND package built-in rules (coexist)
		const queryDirs = [
			...new Set([
				path.join(resolvedRoot, "rules", "tree-sitter-queries"),
				resolvePackagePath(import.meta.url, "rules", "tree-sitter-queries"),
			]),
		];

		for (const queriesDir of queryDirs) {
			if (!fs.existsSync(queriesDir)) {
				this.dbg(`Queries directory not found: ${queriesDir}`);
				continue;
			}

			const languageDirs = fs
				.readdirSync(queriesDir, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name);

			for (const lang of languageDirs) {
				const langDir = path.join(queriesDir, lang);
				const languageKey = getQueryLanguageKey(lang);
				const queryFiles = fs
					.readdirSync(langDir)
					.filter((f) => f.endsWith(".yml"));

				const langQueries = this.queries.get(languageKey) ?? [];

				for (const file of queryFiles) {
					const filePath = path.join(langDir, file);
					const query = this.parseQueryFile(filePath, languageKey);
					if (query) {
						langQueries.push(query);
					}
				}

				if (langQueries.length > 0) {
					this.queries.set(languageKey, langQueries);
					this.dbg(`Loaded ${langQueries.length} queries for ${languageKey}`);
				}
			}
		}

		this.loaded = true;
		this.loadedRoot = resolvedRoot;
		return this.queries;
	}

	/**
	 * Parse a single YAML query file
	 */
	private parseQueryFile(
		filePath: string,
		language: string,
	): TreeSitterQuery | null {
		try {
			const content = fs.readFileSync(filePath, "utf-8");

			// Simple YAML parsing (extract key: value pairs)
			const parsed = this.parseYaml(content);

			if (!parsed.id || !parsed.query) {
				this.dbg(`Invalid query file: ${filePath}`);
				return null;
			}

			return {
				id: String(parsed.id),
				name: String(parsed.name || parsed.id),
				severity: this.parseSeverity(parsed.severity),
				category: String(parsed.category || "general"),
				language: String(parsed.language || language),
				message: String(parsed.message || `Pattern: ${parsed.id}`),
				description: parsed.description
					? String(parsed.description)
					: undefined,
				query:
					this.extractMultilineValue(content, "query") || String(parsed.query),
				metavars: Array.isArray(parsed.metavars)
					? parsed.metavars.map(String)
					: this.extractMetavars(String(parsed.query)),
				post_filter: parsed.post_filter
					? String(parsed.post_filter)
					: undefined,
				// biome-ignore lint/suspicious/noExplicitAny: Post filter params
				post_filter_params: parsed.post_filter_params as any,
				defect_class: parsed.defect_class
					? String(parsed.defect_class)
					: undefined,
				inline_tier: parsed.inline_tier
					? (String(parsed.inline_tier) as "blocking" | "warning" | "review")
					: undefined,
				skip_test_files: parsed.skip_test_files === true,
				ignore_paths: Array.isArray(parsed.ignore_paths)
					? parsed.ignore_paths.map(String)
					: undefined,
				// Parse predicates if present
				predicates: Array.isArray(parsed.predicates)
					? parsed.predicates.map((p: any) => ({
							type: p.type,
							var: p.var,
							value: p.value,
						}))
					: undefined,
				tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : undefined,
				cwe: Array.isArray(parsed.cwe) ? parsed.cwe.map(String) : undefined,
				owasp: Array.isArray(parsed.owasp)
					? parsed.owasp.map(String)
					: undefined,
				confidence: parsed.confidence
					? (String(parsed.confidence) as "low" | "medium" | "high")
					: undefined,
				has_fix: parsed.has_fix === true || parsed.has_fix === "true",
				fix_action: parsed.fix_action ? String(parsed.fix_action) : undefined,
				filePath,
			};
		} catch (err) {
			this.dbg(`Failed to parse ${filePath}: ${err}`);
			return null;
		}
	}

	/**
	 * Simple YAML parser for our query files
	 */
	private parseYaml(
		content: string,
	): Record<string, string | string[] | boolean> {
		const result: Record<string, string | string[] | boolean> = {};
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const match = line.match(/^([a-z_]+):\s*(.*)$/);
			if (match) {
				const key = match[1];
				// Strip a trailing YAML comment (` # …`) on unquoted scalars, as the
				// array-item branch below already does. Without this, a rule written
				// `post_filter: not_in_test_block  # skip test blocks` carried the
				// whole comment as the filter NAME, so the filter never resolved and
				// the rule reported unfiltered matches.
				let value: string | string[] | boolean = stripInlineComment(
					match[2].trim(),
				);

				// Handle arrays inline: metavars: [A, B, C]
				if (value.startsWith("[") && value.endsWith("]")) {
					value = value
						.slice(1, -1)
						.split(",")
						.map((s) => s.trim().replace(/^["']|["']$/g, ""));
				}
				// Handle multi-line arrays: metavars:\n  - A\n  - B
				// and nested objects: post_filter_params:\n  KEY: "value"
				else if (value === "") {
					const arrayItems: string[] = [];
					const nestedObj: Record<string, string> = {};
					const baseIndent = line.match(/^(\s*)/)?.[0].length || 0;

					for (let j = i + 1; j < lines.length; j++) {
						const nextLine = lines[j];
						const nextIndent = nextLine.match(/^(\s*)/)?.[0].length || 0;

						// Stop if we hit a line with same or less indent (new key)
						if (
							nextIndent <= baseIndent &&
							nextLine.trim() !== "" &&
							nextLine.match(/^\S/)
						) {
							break;
						}

						// Check if it's an array item
						const itemMatch = nextLine.match(/^\s+-\s*(.+)$/);
						if (itemMatch) {
							const item = itemMatch[1].trim().replace(/\s*#.*$/, "");
							if (item) arrayItems.push(item);
							continue;
						}

						// Check if it's a nested key: value pair
						const nestedMatch = nextLine.match(/^\s+(\w+):\s*(.+)$/);
						if (nestedMatch) {
							let nv = nestedMatch[2].trim();
							if (
								(nv.startsWith('"') && nv.endsWith('"')) ||
								(nv.startsWith("'") && nv.endsWith("'"))
							) {
								nv = nv.slice(1, -1);
							}
							nestedObj[nestedMatch[1]] = nv;
						}
					}

					if (arrayItems.length > 0) {
						value = arrayItems;
					} else if (Object.keys(nestedObj).length > 0) {
						// biome-ignore lint/suspicious/noExplicitAny: nested object from YAML
						(result as any)[key] = nestedObj;
						continue;
					}
				}
				// Handle booleans
				else if (value === "true") value = true;
				else if (value === "false") value = false;
				// Strip quotes from strings
				else if (value.startsWith('"') && value.endsWith('"')) {
					value = value.slice(1, -1);
				}

				result[key] = value;
			}
		}

		return result;
	}

	/**
	 * Extract a multiline value (like query) from YAML
	 */
	private extractMultilineValue(content: string, key: string): string | null {
		const lines = content.split("\n");
		let startLine = -1;
		let startIndent = 0;

		const keyPrefix = `${key}:`;

		// Find the key line
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trimStart();
			if (trimmed.startsWith(keyPrefix)) {
				startLine = i;
				startIndent = lines[i].length - trimmed.length;
				const afterKey = trimmed.slice(keyPrefix.length).trim();
				// If there's content on the same line (not just |), return it
				if (afterKey && afterKey !== "|") return afterKey;
				break;
			}
		}

		if (startLine === -1) return null;

		// Collect all lines until we hit a new key with same or less indent
		const valueLines: string[] = [];
		for (let i = startLine + 1; i < lines.length; i++) {
			const line = lines[i];

			// Track empty lines
			if (!line.trim()) {
				valueLines.push("");
				continue;
			}

			// Check indent
			const indentMatch = line.match(/^(\s*)/);
			const indent = indentMatch ? indentMatch[1].length : 0;
			const trimmed = line.trim();

			// Stop at a new top-level key (same or less indent than the key).
			if (indent <= startIndent && trimmed.match(/^[a-z_]+:/)) {
				break;
			}

			// A comment at or below the key's indent is a document-level comment
			// that follows the block, not part of it — stop. Block-scalar content
			// (including native tree-sitter predicate lines `#eq?`/`#match?`) is
			// always MORE indented than the key, so those are preserved. Without
			// this, a stray `# …` line between a `query: |` block and the next key
			// was appended to the query and made it fail to compile (mixed-async).
			if (trimmed.startsWith("#") && indent <= startIndent) {
				break;
			}

			// Skip YAML comment lines for most keys, but preserve native
			// tree-sitter predicate lines in query blocks (#eq?, #match?, ...).
			if (trimmed.startsWith("#") && key !== "query") continue;

			// This is part of the multiline value
			valueLines.push(line);
		}

		// Strip the common minimum indent (relative to startIndent).
		// YAML's `|` block scalar preserves content with consistent
		// indentation; we want to remove the leading whitespace that
		// was used for YAML formatting.
		// biome-ignore lint/suspicious/noExplicitAny: line iteration
		const nonEmpty = valueLines.filter((l: string) => l.trim().length > 0);
		if (nonEmpty.length > 0) {
			const minExtraIndent = Math.min(
				...nonEmpty.map((l: string) => {
					const m = l.match(/^(\s*)/);
					return (m?.[1].length ?? 0) - startIndent;
				}),
			);
			for (let i = 0; i < valueLines.length; i++) {
				if (valueLines[i].trim().length === 0) continue; // leave blank lines alone
				valueLines[i] = valueLines[i].slice(
					startIndent + Math.max(0, minExtraIndent),
				);
			}
		}

		// Clean up - remove trailing empty lines
		while (valueLines.length > 0 && !valueLines[valueLines.length - 1].trim()) {
			valueLines.pop();
		}

		return valueLines.length > 0 ? valueLines.join("\n") : null;
	}

	/**
	 * Parse severity string to valid type
	 */
	private parseSeverity(value: unknown): "error" | "warning" | "info" {
		if (value === "error") return "error";
		if (value === "warning") return "warning";
		if (value === "info") return "info";
		return "warning"; // default
	}

	/**
	 * Extract @VAR patterns from query string
	 */
	private extractMetavars(query: string): string[] {
		const matches = query.match(/@([A-Z_][A-Z0-9_]*)/g);
		if (!matches) return [];
		return [...new Set(matches.map((m) => m.slice(1)))];
	}

	/**
	 * Get queries for a specific language
	 */
	getQueriesForLanguage(language: string): TreeSitterQuery[] {
		const all = this.queries.get(language) || [];
		// Exclude queries from <language>-disabled/ directories.
		// Disabled rules are loaded (needed by tests via getAllQueries)
		// but excluded from production dispatch.
		return all.filter((q) => !isDisabledQueryFilePath(q.filePath));
	}

	/**
	 * Get a specific query by ID
	 */
	getQueryById(id: string): TreeSitterQuery | undefined {
		for (const langQueries of this.queries.values()) {
			const query = langQueries.find((q) => q.id === id);
			if (query) return query;
		}
		return undefined;
	}

	/**
	 * Find matching query for a pattern string
	 */
	findMatchingQuery(
		pattern: string,
		language: string,
	): TreeSitterQuery | undefined {
		const langQueries = this.getQueriesForLanguage(language);

		// Check for pattern keywords
		for (const query of langQueries) {
			// Match by ID
			if (pattern.includes(query.id)) return query;

			// Match by keywords in pattern
			switch (query.id) {
				case "empty-catch":
					if (pattern.includes("empty-catch") || pattern.includes("catch {}"))
						return query;
					break;
				case "debugger-statement":
					if (pattern.includes("debugger")) return query;
					break;
				case "await-in-loop":
					if (pattern.includes("await-in-loop") || pattern.includes("await"))
						return query;
					break;
				case "hardcoded-secrets":
					if (
						pattern.includes("hardcoded") ||
						pattern.includes("api_key") ||
						pattern.includes("password")
					)
						return query;
					break;
				case "dangerously-set-inner-html":
					if (pattern.includes("dangerously") || pattern.includes("innerHTML"))
						return query;
					break;
				case "nested-ternary":
					if (pattern.includes("ternary") || pattern.includes("? :"))
						return query;
					break;
				case "no-eval":
					if (pattern.includes("eval") && !pattern.includes("console"))
						return query;
					break;
				case "deep-promise-chain":
					if (pattern.includes(".then") && pattern.includes(".catch"))
						return query;
					break;
				case "console-statement":
					if (pattern.includes("console") && !pattern.includes("test"))
						return query;
					break;
				case "long-parameter-list":
					if (pattern.includes("PARAMS")) return query;
					break;
				// Python queries
				case "bare-except":
					if (pattern.includes("bare-except") || pattern.includes("except:"))
						return query;
					break;
				case "mutable-default-arg":
					if (pattern.includes("mutable") || pattern.includes("default"))
						return query;
					break;
				case "wildcard-import":
					if (pattern.includes("wildcard") || pattern.includes("import *"))
						return query;
					break;
				case "eval-exec":
					if (pattern.includes("eval") || pattern.includes("exec"))
						return query;
					break;
				case "is-vs-equals":
					if (pattern.includes("is") || pattern.includes("equals"))
						return query;
					break;
				case "unreachable-except":
					if (pattern.includes("unreachable") || pattern.includes("except"))
						return query;
					break;
			}
		}

		return undefined;
	}

	/**
	 * Get all loaded queries
	 */
	getAllQueries(): TreeSitterQuery[] {
		const all: TreeSitterQuery[] = [];
		for (const queries of this.queries.values()) {
			all.push(...queries);
		}
		return all;
	}

	/**
	 * Reload queries from disk
	 */
	async reload(): Promise<void> {
		this.queries.clear();
		this.loaded = false;
		await this.loadQueries();
	}
}

// Singleton instance
export const queryLoader = new TreeSitterQueryLoader();
