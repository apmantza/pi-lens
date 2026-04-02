/**
 * ast-grep NAPI runner for dispatch system
 *
 * Uses @ast-grep/napi for programmatic parsing instead of CLI.
 * Handles TypeScript/JavaScript/CSS/HTML files with YAML rule support.
 *
 * Replaces CLI-based runners for faster performance (100x speedup).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import {
	calculateRuleComplexity,
	hasUnsupportedConditions,
	isOverlyBroadPattern,
	isStructuredRule,
	loadYamlRules,
	MAX_BLOCKING_RULE_COMPLEXITY,
	type YamlRule,
	type YamlRuleCondition,
} from "./yaml-rule-parser.js";

// Lazy load the napi package
let sg: typeof import("@ast-grep/napi") | undefined;
let sgLoadAttempted = false;

async function loadSg(): Promise<typeof import("@ast-grep/napi") | undefined> {
	if (sg) return sg;
	if (sgLoadAttempted) return undefined; // Don't retry if already failed
	sgLoadAttempted = true;
	try {
		sg = await import("@ast-grep/napi");
		return sg;
	} catch {
		return undefined;
	}
}

// Supported extensions for NAPI
const SUPPORTED_EXTS = [".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".htm"];

/** Maximum matches per rule to prevent excessive false positives */
const MAX_MATCHES_PER_RULE = 10;

/** Maximum total diagnostics per file to prevent output spam */
const MAX_TOTAL_DIAGNOSTICS = 50;

/** Rules already covered by tree-sitter runner (priority 14, runs first) */
const TREE_SITTER_OVERLAP = new Set([
	"constructor-super",
	"empty-catch",
	"long-parameter-list",
	"nested-ternary",
	"no-dupe-class-members",
]);

/** Maximum AST depth to traverse to prevent stack overflow on deeply nested files */
const MAX_AST_DEPTH = 50;

/** Maximum recursion depth for structured rule execution */
const MAX_RULE_DEPTH = 5;

function canHandle(filePath: string): boolean {
	return SUPPORTED_EXTS.includes(path.extname(filePath).toLowerCase());
}

function getLang(filePath: string, sgModule: typeof import("@ast-grep/napi")) {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".ts":
			return sgModule.ts;
		case ".tsx":
			return sgModule.tsx;
		case ".js":
		case ".jsx":
			return sgModule.js;
		case ".css":
			return sgModule.css;
		case ".html":
		case ".htm":
			return sgModule.html;
		default:
			return undefined;
	}
}

/**
 * Check if a single node matches a condition (without searching descendants).
 * In ast-grep semantics:
 * - pattern/kind/regex: check the node itself
 * - all: node must match ALL sub-conditions
 * - any: node must match at least ONE sub-condition
 * - not: node must NOT match the sub-condition
 * - has: node must have a DESCENDANT matching the sub-condition
 */
function nodeMatchesCondition(
	node: any,
	condition: YamlRuleCondition,
	depth = 0,
): boolean {
	if (depth > MAX_RULE_DEPTH) return false;

	// Check kind constraint
	if (condition.kind && node.kind() !== condition.kind) return false;

	// Check pattern constraint (node itself must match)
	if (condition.pattern) {
		try {
			const matches = node.findAll(condition.pattern);
			// Check if the node itself is among the matches (same start position)
			const nodeRange = node.range();
			let selfMatch = false;
			for (const m of matches) {
				const mr = (m as any).range();
				if (
					mr.start.line === nodeRange.start.line &&
					mr.start.column === nodeRange.start.column &&
					mr.end.line === nodeRange.end.line &&
					mr.end.column === nodeRange.end.column
				) {
					selfMatch = true;
					break;
				}
			}
			if (!selfMatch) return false;
		} catch {
			return false;
		}
	}

	// Check regex constraint
	if (condition.regex) {
		try {
			const text = node.text();
			if (!new RegExp(condition.regex).test(text)) return false;
		} catch {
			return false;
		}
	}

	// Check has (descendant must match)
	if (condition.has) {
		const descendants = findMatchingNodes(node, condition.has, depth + 1);
		if (descendants.length === 0) return false;
	}

	// Check not (node must NOT match this condition)
	if (condition.not) {
		if (nodeMatchesCondition(node, condition.not, depth + 1)) return false;
	}

	// Check all (node must match ALL sub-conditions)
	if (condition.all) {
		for (const sub of condition.all) {
			if (!nodeMatchesCondition(node, sub, depth + 1)) return false;
		}
	}

	// Check any (node must match at least one sub-condition)
	if (condition.any) {
		let anyMatch = false;
		for (const sub of condition.any) {
			if (nodeMatchesCondition(node, sub, depth + 1)) {
				anyMatch = true;
				break;
			}
		}
		if (!anyMatch) return false;
	}

	return true;
}

/**
 * Find all nodes in the tree that match a condition.
 * This is the "search" function - traverses the tree and checks each node.
 */
function findMatchingNodes(
	rootNode: any,
	condition: YamlRuleCondition,
	depth = 0,
): unknown[] {
	if (depth > MAX_RULE_DEPTH) return [];

	const matches: unknown[] = [];

	// Optimization: if the condition has a kind, only check nodes of that kind
	// If it has a pattern, use findAll for initial candidates
	let candidates: unknown[];

	if (condition.pattern && !condition.all && !condition.any) {
		// Use findAll for pattern-only conditions (fast path)
		try {
			candidates = rootNode.findAll(condition.pattern);
		} catch {
			return [];
		}
	} else if (condition.kind && !condition.all && !condition.any) {
		// Use findByKind for kind-only conditions (fast path)
		candidates = findByKind(rootNode, condition.kind, 0);
	} else if (condition.all) {
		// For `all`, find the narrowest sub-condition to generate candidates
		candidates = getCandidatesForAll(rootNode, condition.all);
	} else if (condition.any) {
		// For `any`, union candidates from all sub-conditions
		const seen = new Set<string>();
		candidates = [];
		for (const sub of condition.any) {
			const subMatches = findMatchingNodes(rootNode, sub, depth + 1);
			for (const m of subMatches) {
				const r = (m as any).range();
				const key = `${r.start.line}:${r.start.column}`;
				if (!seen.has(key)) {
					seen.add(key);
					candidates.push(m);
				}
			}
		}
	} else {
		// Fallback: traverse all nodes
		candidates = getAllNodes(rootNode, 0);
	}

	for (const candidate of candidates) {
		if (nodeMatchesCondition(candidate, condition, depth)) {
			matches.push(candidate);
		}
	}

	return matches;
}

/**
 * For an `all` condition, find the narrowest sub-condition to generate
 * initial candidates. This avoids scanning all nodes when one sub-condition
 * has a specific kind or pattern.
 */
function getCandidatesForAll(
	rootNode: any,
	subs: YamlRuleCondition[],
): unknown[] {
	// Prefer kind-based narrowing first, then pattern-based
	for (const sub of subs) {
		if (sub.kind) {
			return findByKind(rootNode, sub.kind, 0);
		}
	}
	for (const sub of subs) {
		if (sub.pattern) {
			try {
				return rootNode.findAll(sub.pattern);
			} catch {}
		}
	}
	// No narrowing possible, scan all
	return getAllNodes(rootNode, 0);
}

/**
 * Legacy wrapper - execute a structured rule using the new two-phase approach.
 */
function executeStructuredRule(
	rootNode: any,
	condition: YamlRuleCondition,
	matches: unknown[] = [],
	depth = 0,
): unknown[] {
	return findMatchingNodes(rootNode, condition, depth);
}

/**
 * Find all nodes of a specific kind with depth limit
 */
function findByKind(node: any, kind: string, currentDepth: number): unknown[] {
	if (currentDepth > MAX_AST_DEPTH) return [];
	const results: unknown[] = [];
	if (node.kind() === kind) results.push(node);
	for (const child of node.children()) {
		results.push(...findByKind(child, kind, currentDepth + 1));
	}
	return results;
}

/**
 * Get all nodes with depth limit to prevent stack overflow
 */
function getAllNodes(node: any, currentDepth: number): unknown[] {
	if (currentDepth > MAX_AST_DEPTH) return [];
	const results = [node];
	for (const child of node.children()) {
		results.push(...getAllNodes(child, currentDepth + 1));
	}
	return results;
}

// --- Runner Definition ---

const astGrepNapiRunner: RunnerDefinition = {
	id: "ast-grep-napi",
	appliesTo: ["jsts"],
	priority: 15,
	enabledByDefault: true,
	skipTestFiles: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		if (!canHandle(ctx.filePath)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const sgModule = await loadSg();
		if (!sgModule) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		if (!fs.existsSync(ctx.filePath)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const lang = getLang(ctx.filePath, sgModule);
		if (!lang) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const stats = fs.statSync(ctx.filePath);
		if (stats.size > 1024 * 1024) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let content: string;
		try {
			content = fs.readFileSync(ctx.filePath, "utf-8");
		} catch {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let root: import("@ast-grep/napi").SgRoot;
		try {
			root = lang.parse(content);
		} catch {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		let rootNode: any;
		try {
			rootNode = root.root();
		} catch {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const diagnostics: Diagnostic[] = [];

		const ruleDirs = [
			path.join(process.cwd(), "rules/ast-grep-rules/rules"),
			path.join(process.cwd(), "rules/ast-grep-rules"),
		];

		for (const ruleDir of ruleDirs) {
			let rules: YamlRule[];
			try {
				rules = loadYamlRules(ruleDir, ctx.blockingOnly ? "error" : undefined);
			} catch {
				continue;
			}

			for (const rule of rules) {
				// Skip rules already handled by tree-sitter runner (priority 14)
				if (TREE_SITTER_OVERLAP.has(rule.id)) continue;

				// Skip rules using conditions we can't execute (inside, follows,
				// precedes, stopBy, field, nthChild, constraints). Running these
				// with only partial condition evaluation causes false positives.
				if (hasUnsupportedConditions(rule)) continue;

				// Skip rules whose top-level pattern is overly broad ($NAME, $X, etc.)
				// without additional structural constraints to narrow matches.
				if (
					rule.rule &&
					isOverlyBroadPattern(rule.rule.pattern) &&
					!isStructuredRule(rule)
				) {
					continue;
				}

				const lang = rule.language?.toLowerCase();
				if (lang && lang !== "typescript" && lang !== "javascript") {
					continue;
				}

				if (ctx.blockingOnly && rule.rule) {
					const complexity = calculateRuleComplexity(rule.rule);
					if (complexity > MAX_BLOCKING_RULE_COMPLEXITY) {
						continue;
					}
				}

				try {
					let matches: unknown[] = [];

					if (isStructuredRule(rule) && rule.rule) {
						matches = executeStructuredRule(rootNode, rule.rule, []);
					} else if (rule.rule?.pattern || rule.rule?.kind) {
						const pattern = rule.rule.pattern || rule.rule.kind;
						if (pattern) {
							try {
								matches = rootNode.findAll(pattern);
							} catch {
								if (rule.rule.kind) {
									matches = findByKind(rootNode, rule.rule.kind, 0);
								}
							}
						}
					}

					const limitedMatches = matches.slice(0, MAX_MATCHES_PER_RULE);

					for (const match of limitedMatches) {
						if (diagnostics.length >= MAX_TOTAL_DIAGNOSTICS) break;

						const node = match as {
							range(): { start: { line: number; column: number } };
						};
						const range = node.range();
						const severity = rule.severity === "error" ? "error" : "warning";

						diagnostics.push({
							id: `ast-grep-napi-${range.start.line}-${rule.id}`,
							message: `[${rule.metadata?.category || "slop"}] ${rule.message || rule.id}`,
							filePath: ctx.filePath,
							line: range.start.line + 1,
							column: range.start.column + 1,
							severity,
							semantic: severity === "error" ? "blocking" : "warning",
							tool: "ast-grep-napi",
							rule: rule.id,
							fixable: false,
						});
					}

					if (diagnostics.length >= MAX_TOTAL_DIAGNOSTICS) break;
				} catch {
					// Rule failed, skip
				}
			}
		}

		const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
		return {
			status: "succeeded",
			diagnostics,
			semantic: hasBlocking
				? "blocking"
				: diagnostics.length > 0
					? "warning"
					: ("none" as const),
		};
	},
};

export default astGrepNapiRunner;
