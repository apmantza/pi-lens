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

// --- Types ---

export interface YamlRuleCondition {
	kind?: string;
	pattern?: string;
	regex?: string;
	has?: YamlRuleCondition;
	any?: YamlRuleCondition[];
	all?: YamlRuleCondition[];
	not?: YamlRuleCondition;
}

export interface YamlRule {
	id: string;
	language?: string;
	severity?: string;
	message?: string;
	metadata?: { weight?: number; category?: string };
	rule?: YamlRuleCondition;
}

interface CachedRules {
	rules: YamlRule[];
	mtime: number;
}

// Internal type for YAML parsing (allows dynamic property access)
interface YamlNode {
	[key: string]: unknown;
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
		try {
			const content = fs.readFileSync(path.join(ruleDir, file), "utf-8");
			const documents = content.split(/^---$/m).filter((d) => d.trim());

			for (const doc of documents) {
				const rule = parseSimpleYaml(doc.trim());
				if (rule?.id) {
					if (severityFilter && rule.severity !== severityFilter) {
						continue;
					}
					rules.push(rule);
				}
			}
		} catch {
			// Skip invalid files
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

function getIndent(line: string): number {
	let count = 0;
	for (const char of line) {
		if (char === " ") count++;
		else if (char === "\t") count += 2;
		else break;
	}
	return count;
}

function stripQuotes(value: string): string {
	let s = value;
	while (s.startsWith('"') && s.endsWith('"') && s.length > 1)
		s = s.slice(1, -1);
	while (s.startsWith("'") && s.endsWith("'") && s.length > 1)
		s = s.slice(1, -1);
	return s;
}

export function parseSimpleYaml(content: string): YamlRule | null {
	const lines = content.split("\n");
	const rule: YamlRule = { id: "", metadata: {} };
	const stack: Array<{ name: string; indent: number; obj: YamlNode }> = [];
	let multilineBuffer: string[] = [];
	let multilineKey = "";

	const currentObj = (): YamlNode =>
		stack.length === 0
			? (rule as unknown as YamlNode)
			: stack[stack.length - 1].obj;

	const flushMultiline = () => {
		if (!multilineKey || multilineBuffer.length === 0) return;
		const value = multilineBuffer.join("\n");
		const obj = currentObj();
		if (multilineKey === "pattern") obj.pattern = value;
		else if (multilineKey === "message")
			(rule as unknown as YamlNode).message = value;
		multilineKey = "";
		multilineBuffer = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#") || trimmed === "---") continue;

		const indent = getIndent(line);

		while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
			stack.pop();
		}

		if (line.startsWith(" ") && !trimmed.includes(":") && multilineKey) {
			multilineBuffer.push(trimmed);
			continue;
		}

		flushMultiline();

		const colonIdx = trimmed.indexOf(":");
		const key = colonIdx > 0 ? trimmed.substring(0, colonIdx).trim() : trimmed;
		const value = colonIdx > 0 ? trimmed.substring(colonIdx + 1).trim() : "";

		if (key === "id") {
			rule.id = stripQuotes(value);
		} else if (key === "language") {
			rule.language = value;
		} else if (key === "severity") {
			rule.severity = value;
		} else if (key === "message") {
			value === "|"
				? (multilineKey = "message")
				: (rule.message = stripQuotes(value));
		} else if (key === "metadata") {
			rule.metadata = {};
			stack.push({ name: "metadata", indent, obj: rule.metadata as YamlNode });
		} else if (key === "rule") {
			rule.rule = {};
			stack.push({ name: "rule", indent, obj: rule.rule as YamlNode });
		} else if (stack.length > 0) {
			const obj = currentObj();
			const section = stack[stack.length - 1].name;

			if (key === "weight" && section === "metadata") {
				if (!rule.metadata) rule.metadata = {};
				rule.metadata.weight = parseInt(value, 10) || 3;
			} else if (key === "category" && section === "metadata") {
				if (!rule.metadata) rule.metadata = {};
				rule.metadata.category = stripQuotes(value);
			} else if (key === "pattern") {
				value === "|"
					? (multilineKey = "pattern")
					: (obj.pattern = stripQuotes(value));
			} else if (key === "kind") {
				obj.kind = value;
			} else if (key === "regex") {
				obj.regex = stripQuotes(value);
			} else if (key === "has" || key === "not") {
				obj[key] = {} as YamlRuleCondition;
				stack.push({ name: key, indent, obj: obj[key] as YamlNode });
			} else if (key === "any" || key === "all") {
				if (!obj[key]) obj[key] = [];
				const list = obj[key] as YamlRuleCondition[];

				let j = i + 1;
				while (j < lines.length) {
					const nextLine = lines[j];
					const nextTrimmed = nextLine.trim();
					if (!nextTrimmed || nextTrimmed.startsWith("#")) {
						j++;
						continue;
					}
					const nextIndent = getIndent(nextLine);
					if (nextIndent <= indent) break;

					if (nextTrimmed.startsWith("- ")) {
						const item: YamlRuleCondition = {};
						list.push(item);
						stack.push({
							name: key,
							indent: nextIndent,
							obj: item as YamlNode,
						});

						const itemContent = nextTrimmed.substring(2);
						if (itemContent.includes(":")) {
							const [itemKey, itemVal] = itemContent.split(":", 2);
							if (itemKey.trim() === "pattern") {
								item.pattern = stripQuotes(itemVal.trim());
							} else if (itemKey.trim() === "kind") {
								item.kind = itemVal.trim();
							}
						} else if (itemContent) {
							item.pattern = stripQuotes(itemContent);
						}
					}
					j++;
				}
			}
		}
	}

	flushMultiline();
	return rule.id ? rule : null;
}
