/**
 * YAML Rule Parser for ast-grep
 *
 * Parses simplified YAML rule files for structural code analysis.
 * Supports pattern matching, kind matching, and structured conditions
 * (has/any/all/not/regex).
 *
 * Features:
 * - Caching with mtime-based invalidation
 * - Severity filtering (error-only for blocking mode)
 * - Complexity scoring for performance optimization
 * - Overly broad pattern detection
 */

import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";

// --- Types ---

export interface YamlRuleCondition {
	kind?: string;
	pattern?: string;
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
}

interface CachedRules {
	rules: YamlRule[];
	mtime: number;
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

// --- Public API ---

export function clearRulesCache(): void {
	rulesCache.clear();
	blockingRulesCache.clear();
}

export function loadYamlRules(
	ruleDir: string,
	severityFilter?: "error",
): YamlRule[] {
	return getCachedRules(ruleDir, severityFilter);
}

export function loadYamlRulesUncached(
	ruleDir: string,
	severityFilter?: "error",
): YamlRule[] {
	const rules: YamlRule[] = [];
	if (!fs.existsSync(ruleDir)) return rules;

	const files = fs.readdirSync(ruleDir).filter((f) => f.endsWith(".yml"));

	for (const file of files) {
		let content: string;
		try {
			content = fs.readFileSync(path.join(ruleDir, file), "utf-8");
		} catch {
			continue; // unreadable file
		}
		const documents = content.split(/^---$/m).filter((d) => d.trim());

		// Parse each document independently so one malformed rule (e.g. an
		// unquoted YAML-special scalar) skips only itself, not the whole file —
		// slop-patterns.yml packs many rules into a single file.
		for (const doc of documents) {
			const rule = parseSimpleYaml(doc.trim());
			if (rule?.id) {
				if (severityFilter && rule.severity !== severityFilter) {
					continue;
				}
				rules.push(rule);
			}
		}
	}

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

export function isOverlyBroadPattern(pattern: string | undefined): boolean {
	if (!pattern) return false;
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
	return !!(
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
