/**
 * YAML Rule Parser for ast-grep
 *
 * Parses simplified YAML rule files for structural code analysis.
 * Supports pattern matching, kind matching, and structured conditions
 * (has/any/all/not/regex).
 *
 * Features:
 * - Mtime caching for bundled rules; content/path caching for project rules
 * - Severity filtering (error-only for blocking mode)
 * - Complexity scoring for performance optimization
 * - Overly broad pattern detection
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "../../deps/js-yaml.js";
import { BoundedLruCache } from "../../bounded-cache.js";
import { compareOrdinal } from "../../string-utils.js";

// --- Types ---

export interface YamlRuleCondition {
	kind?: string;
	// `pattern` accepts both a string shorthand (`foo($A)`) and the rich form
	// (`{context, selector}`), which is the canonical ast-grep way to match a
	// specific node kind inside a syntactic context. The napi engine and the
	// CLI both accept the object form, but it must be guarded in any helper
	// that calls string methods on `pattern`.
	pattern?: string | YamlRichPattern;
	regex?: string;
	has?: YamlRuleCondition;
	any?: YamlRuleCondition[];
	all?: YamlRuleCondition[];
	not?: YamlRuleCondition;
	// Relational/structural conditions — all handled natively by napi's engine.
	// `has`/`inside` default to direct child/parent (`stopBy: neighbor`); set
	// `stopBy: end` for a recursive descendant/ancestor search.
	inside?: YamlRuleCondition;
	follows?: YamlRuleCondition;
	precedes?: YamlRuleCondition;
	stopBy?: unknown;
	field?: string;
	nthChild?: unknown;
}

export interface YamlRule {
	id: string;
	language?: string;
	severity?: string;
	message?: string;
	note?: string;
	fix?: string;
	metadata?: { weight?: number; category?: string };
	rule?: YamlRuleCondition;
	constraints?: Record<string, { regex?: string }>;
	// Reusable named matchers referenced from `rule`/`constraints` via
	// `matches: <name>`. Standard ast-grep YAML syntax
	// (https://ast-grep.github.io/guide/rule-config/utility-rule.html);
	// napi's native `findAll` accepts the same top-level `utils` key
	// (`NapiConfig.utils: Record<string, Rule>`) so this parses straight
	// through unchanged. Without it, `matches: <name>` can't resolve and the
	// rule silently produces zero matches (#663).
	utils?: Record<string, YamlRuleCondition>;
	/**
	 * Skip this rule on files whose path (relative to the project root,
	 * forward-slashed) matches any of these glob patterns — e.g. a
	 * `scripts` directory glob plus a `logger.ts` basename glob for a
	 * debug-output rule that's expected to fire in CLI entry points and the
	 * logging sink itself (#965). Mirrors the tree-sitter query loader's
	 * `ignore_paths` field (`clients/tree-sitter-query-loader.ts`) — same
	 * shape/matching, kept as a separate opt-in per-rule field rather than a
	 * blanket path exclusion so most rules are unaffected.
	 */
	ignores?: string[];
}

interface CachedRules {
	rules: YamlRule[];
	files: RuleFileStamp[];
	/** `Date.now()` at the last metadata stat sweep (#2262 round 2). */
	checkedAtMs: number;
}

interface RuleFileStamp {
	path: string;
	mtimeMs: number;
	size: number;
}

interface ContentCachedRules {
	rules: YamlRule[];
	signature: string;
}

// Rich pattern form: match a specific AST kind from a contextual snippet.
// https://ast-grep.github.io/reference/rule.html#pattern-object
export interface YamlRichPattern {
	context?: string;
	selector?: string;
	strictness?: string;
}

// --- Constants ---

/** Overly broad patterns that match everything (cause false positive explosions) */
const OVERLY_BROAD_PATTERNS = ["$NAME", "$FIELD", "$_", "$X", "$VAR", "$EXPR"];

/** Maximum complexity score for rules in blockingOnly mode */
export const MAX_BLOCKING_RULE_COMPLEXITY = 8;

/**
 * `getCachedRules` re-stats a rule directory's files at most once per this
 * window (#2262 round 2). `scanner.ts:235` calls `loadYamlRules` per file
 * scanned; a full metadata sweep (readdir + stat every rule file) on every
 * warmed call measured 250x master's per-call cost on a mid-size catalog.
 * Same value and same shape as `file-utils.ts`'s
 * `PROJECT_IGNORE_FRESHNESS_CADENCE_MS` (#2159/#2071): 2s is the accepted
 * staleness bound for a rule tree pi-lens itself did not just write.
 */
export const RULES_CACHE_FRESHNESS_CADENCE_MS = 2_000;

// --- Caches ---

const rulesCache = new BoundedLruCache<string, CachedRules>(64);
const blockingRulesCache = new BoundedLruCache<string, CachedRules>(64);
const contentRulesCache = new BoundedLruCache<string, ContentCachedRules>(64);
const contentBlockingRulesCache = new BoundedLruCache<
	string,
	ContentCachedRules
>(64);

// --- Public API ---

export function loadYamlRules(
	ruleDir: string,
	severityFilter?: "error",
): YamlRule[] {
	return getCachedRules(ruleDir, severityFilter);
}

function findYamlRuleFiles(ruleDir: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs
			.readdirSync(ruleDir, { withFileTypes: true })
			// Ordinal (code-unit), not locale, comparison: this order feeds the
			// index-aligned file-stamp identity compared in `getCachedRules` and
			// the hash input order in `loadYamlRulesFresh`. `localeCompare` can
			// order the same file set differently across locales/processes,
			// which would desync the two and mint spurious cache misses or
			// (worse) content-hash collisions across differently-ordered runs.
			// Same reasoning as `rule-cache.ts`'s `computeRuleHash` (#2155/#2165).
			.sort((a, b) => compareOrdinal(a.name, b.name));
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(ruleDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...findYamlRuleFiles(full));
		} else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
			files.push(full);
		}
	}
	return files;
}

function loadYamlRuleFiles(
	files: string[],
	severityFilter?: "error",
): YamlRule[] {
	const rules: YamlRule[] = [];
	for (const file of files) {
		let content: string;
		try {
			content = fs.readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		const documents = content.split(/^---\s*$/m).filter((doc) => doc.trim());
		for (const document of documents) {
			const rule = parseSimpleYaml(document.trim());
			if (!rule?.id) continue;
			if (severityFilter && rule.severity !== severityFilter) continue;
			rules.push(rule);
		}
	}
	return rules;
}

export function loadYamlRulesUncached(
	ruleDir: string,
	severityFilter?: "error",
): YamlRule[] {
	return loadYamlRuleFiles(findYamlRuleFiles(ruleDir), severityFilter);
}

/** Content/path-aware cache used for mutable project-owned rule trees. */
export function loadYamlRulesFresh(
	ruleDir: string,
	severityFilter?: "error",
): YamlRule[] {
	const files = findYamlRuleFiles(ruleDir);
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(path.relative(ruleDir, file));
		hash.update("\0");
		try {
			hash.update(fs.readFileSync(file));
		} catch {
			hash.update("missing");
		}
		hash.update("\0");
	}
	const signature = hash.digest("hex");
	const cache =
		severityFilter === "error" ? contentBlockingRulesCache : contentRulesCache;
	const cached = cache.get(ruleDir);
	if (cached?.signature === signature) return cached.rules;
	const rules = loadYamlRuleFiles(files, severityFilter);
	cache.set(ruleDir, { rules, signature });
	return rules;
}

function getCachedRules(ruleDir: string, severityFilter?: "error"): YamlRule[] {
	if (!fs.existsSync(ruleDir)) {
		return [];
	}

	const cache = severityFilter === "error" ? blockingRulesCache : rulesCache;
	const cached = cache.get(ruleDir);
	const now = Date.now();
	if (cached && now - cached.checkedAtMs < RULES_CACHE_FRESHNESS_CADENCE_MS) {
		// Inside the cadence window: no stat sweep at all. `getCachedRules` is
		// the bundled-catalog path only (project rules route through
		// `loadYamlRulesFresh` — see `ast-grep-napi.ts`'s route split), and
		// `scanner.ts:235` calls it once per scanned file, so a per-call
		// `readdirSync`+`statSync*N` sweep is the hot-path cost this window
		// exists to remove.
		return cached.rules;
	}

	const files = findYamlRuleFiles(ruleDir);
	const fileStamps = files.flatMap((file): RuleFileStamp[] => {
		try {
			const stat = fs.statSync(file);
			return [{ path: file, mtimeMs: stat.mtimeMs, size: stat.size }];
		} catch {
			return [];
		}
	});
	const metadataMatches =
		cached?.files.length === fileStamps.length &&
		cached.files.every(
			(file, index) =>
				file.path === fileStamps[index].path &&
				file.mtimeMs === fileStamps[index].mtimeMs &&
				file.size === fileStamps[index].size,
		);
	if (cached && metadataMatches) {
		// Nothing drifted. Re-arm the window from *now* regardless — otherwise
		// the next call re-stats immediately instead of waiting a full cadence
		// (the #2260/#2071 "checkedAtMs must re-arm on every check, not only on
		// a miss" lesson).
		cached.checkedAtMs = now;
		return cached.rules;
	}

	const rules = loadYamlRuleFiles(files, severityFilter);
	cache.set(ruleDir, { rules, files: fileStamps, checkedAtMs: now });
	return rules;
}

export function isOverlyBroadPattern(
	pattern: string | YamlRichPattern | undefined,
): boolean {
	// The rich pattern form ({context, selector, ...}) is structured and never a
	// single-metavar trap; only string patterns can be overly-broad literals.
	if (!pattern) return false;
	if (typeof pattern !== "string") return false;
	if (OVERLY_BROAD_PATTERNS.includes(pattern.trim())) return true;
	return /^\$[A-Z_]+$/i.test(pattern.trim());
}

export function isStructuredRule(rule: YamlRule): boolean {
	if (!rule.rule) return false;
	// The rich pattern form ({context, selector, …}) is itself a structured
	// match — it specifies a context snippet plus the AST node to pick out.
	// Without recognizing it as structure, an otherwise-rich rule with only
	// `pattern: {context, selector}` and no other combinators would be wrongly
	// classified as "unstructured single-metavar" and dropped by the runner.
	const hasRichPattern =
		typeof rule.rule.pattern === "object" && rule.rule.pattern !== null;
	return !!(
		hasRichPattern ||
		rule.rule.has ||
		rule.rule.any ||
		rule.rule.all ||
		rule.rule.not ||
		rule.rule.regex
	);
}

export function calculateRuleComplexity(
	condition: YamlRuleCondition | undefined,
): number {
	if (!condition) return 0;

	let score = 0;
	if (condition.has) score += 3;
	if (condition.not) score += 2;
	if (condition.regex) score += 2;
	if (condition.any) score += condition.any.length * 2;
	if (condition.all) score += condition.all.length * 3;

	if (condition.has) score += calculateRuleComplexity(condition.has);
	if (condition.not) score += calculateRuleComplexity(condition.not);
	if (condition.any) {
		for (const sub of condition.any) score += calculateRuleComplexity(sub);
	}
	if (condition.all) {
		for (const sub of condition.all) score += calculateRuleComplexity(sub);
	}

	return score;
}

// --- YAML Parser ---

/**
 * Parse a single YAML rule document into a {@link YamlRule}.
 *
 * Uses `js-yaml` so the full ast-grep rule grammar — nested `any`/`all`/`has`,
 * `field`/`inside`/`stopBy`, and metavariable `constraints` — survives intact and
 * can be handed straight to napi's native engine. (The former hand-rolled parser
 * flattened nested structures and dropped constraints, which is why those rules
 * had to be skipped; see #206.) A malformed document returns `null` rather than
 * throwing, so callers skip just that rule.
 */
export function parseSimpleYaml(content: string): YamlRule | null {
	let parsed: unknown;
	try {
		parsed = yaml.load(content);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const rule = parsed as YamlRule;
	return rule.id ? rule : null;
}
