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
 * Execute a structured rule using manual AST traversal
 */
function executeStructuredRule(
	rootNode: any,
	condition: YamlRuleCondition,
	matches: unknown[] = [],
	depth = 0,
): unknown[] {
	if (depth > MAX_RULE_DEPTH) return matches;

	let candidates: unknown[] = [];

	if (condition.pattern) {
		try {
			candidates = rootNode.findAll(condition.pattern);
		} catch {
			return matches;
		}
	} else if (condition.kind) {
		candidates = findByKind(rootNode, condition.kind, 0);
	} else {
		candidates = getAllNodes(rootNode, 0);
	}

	for (const candidate of candidates) {
		const node = candidate as {
			text(): string;
			kind(): string;
			children(): unknown[];
		};
		let matchesCondition = true;

		if (condition.has && matchesCondition) {
			const subMatches = executeStructuredRule(
				node,
				condition.has,
				[],
				depth + 1,
			);
			if (subMatches.length === 0) matchesCondition = false;
		}

		if (condition.not && matchesCondition) {
			const subMatches = executeStructuredRule(
				node,
				condition.not,
				[],
				depth + 1,
			);
			if (subMatches.length > 0) matchesCondition = false;
		}

		if (condition.any && matchesCondition) {
			let anyMatches = false;
			for (const subCondition of condition.any) {
				const subMatches = executeStructuredRule(
					node,
					subCondition,
					[],
					depth + 1,
				);
				if (subMatches.length > 0) {
					anyMatches = true;
					break;
				}
			}
			if (!anyMatches) matchesCondition = false;
		}

		if (condition.all && matchesCondition) {
			for (const subCondition of condition.all) {
				const subMatches = executeStructuredRule(
					node,
					subCondition,
					[],
					depth + 1,
				);
				if (subMatches.length === 0) {
					matchesCondition = false;
					break;
				}
			}
		}

		if (condition.regex && matchesCondition) {
			try {
				const text = node.text();
				const regex = new RegExp(condition.regex);
				if (!regex.test(text)) matchesCondition = false;
			} catch {
				matchesCondition = false;
			}
		}

		if (matchesCondition) {
			matches.push(node);
		}
	}

	return matches;
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
						const weight = rule.metadata?.weight || 3;
						const severity = weight >= 4 ? "error" : "warning";

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

		return {
			status: "succeeded",
			diagnostics,
			semantic: diagnostics.length > 0 ? "warning" : ("none" as const),
		};
	},
};

export default astGrepNapiRunner;
