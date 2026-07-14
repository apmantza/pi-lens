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
}

interface CachedRules {
	rules: YamlRule[];
	mtime: number;
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
export const OVERLY_BROAD_PATTERNS = [
	"$NAME",
	"$FIELD",
	"$_",
	"$X",
	"$VAR",
	"$EXPR",
];

/** Maximum complexity score for rules in blockingOnly mode */
export const MAX_BLOCKING_RULE_COMPLEXITY = 8;

// --- Caches ---

const rulesCache = new Map<string, CachedRules>();
const blockingRulesCache = new Map<string, CachedRules>();
const contentRulesCache = new Map<string, ContentCachedRules>();
const contentBlockingRulesCache = new Map<string, ContentCachedRules>();

// --- Public API ---

export function clearRulesCache(): void {
	rulesCache.clear();
	blockingRulesCache.clear();
	contentRulesCache.clear();
	contentBlockingRulesCache.clear();
}

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
			.sort((a, b) => a.name.localeCompare(b.name));
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
		severityFilter === "error"
			? contentBlockingRulesCache
			: contentRulesCache;
	const cached = cache.get(ruleDir);
	if (cached?.signature === signature) return cached.rules;
	const rules = loadYamlRuleFiles(files, severityFilter);
	cache.set(ruleDir, { rules, signature });
	return rules;
}

export function getCachedRules(
	ruleDir: string,
	severityFilter?: "error",
): YamlRule[] {
	if (!fs.existsSync(ruleDir)) {
		return [];
	}

	let currentMtime = 0;
	try {
		currentMtime = fs.statSync(ruleDir).mtimeMs;
	} catch {
		return [];
	}

	const cache = severityFilter === "error" ? blockingRulesCache : rulesCache;
	const cached = cache.get(ruleDir);
	if (cached && cached.mtime === currentMtime) {
		return cached.rules;
	}

	const rules = loadYamlRulesUncached(ruleDir, severityFilter);
	cache.set(ruleDir, { rules, mtime: currentMtime });
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

export function isValidCondition(
	condition: YamlRuleCondition | undefined,
): boolean {
	if (!condition) return false;
	if (condition.all !== undefined && condition.all.length === 0) return false;
	if (condition.any !== undefined && condition.any.length === 0) return false;
	if (isOverlyBroadPattern(condition.pattern)) return false;
	return true;
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
