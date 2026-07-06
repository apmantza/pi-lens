/**
 * Complexity Metrics Client for pi-lens
 *
 * Language-agnostic AST-based code complexity metrics, computed over the shared
 * tree-sitter client (#402 — no `typescript` compiler dependency). Supported
 * grammars are keyed in LANGUAGE_NODES (JS/TS, Python, Go, Rust today; adding a
 * language is one table entry).
 *
 * Tracks: max nesting depth, function length, cyclomatic + cognitive complexity,
 * maintainability index (Halstead-free), LOC/comments, code entropy, and AI-slop
 * indicators. These are silent metrics surfaced in the session summary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	firstChildOfType,
	parseTreeSitterRoot,
	resolveTreeSitterLanguage,
	type TsNode,
	walk,
} from "./tree-sitter-shared.js";

// --- Types ---

export interface FileComplexity {
	filePath: string;
	maxNestingDepth: number;
	avgFunctionLength: number;
	maxFunctionLength: number;
	functionCount: number;
	cyclomaticComplexity: number; // Average across functions
	maxCyclomaticComplexity: number; // Most complex function
	cognitiveComplexity: number;
	maintainabilityIndex: number; // 0-100
	linesOfCode: number;
	commentLines: number;
	codeEntropy: number; // Shannon entropy in bits
	// AI slop indicators
	maxParamsInFunction: number;
	aiCommentPatterns: number;
	singleUseFunctions: number;
	tryCatchCount: number;
}

export interface FunctionMetrics {
	name: string;
	line: number;
	length: number;
	cyclomatic: number;
	cognitive: number;
	nestingDepth: number;
}

// --- Per-language node categories ---

interface LangNodes {
	/** Function/method/lambda nodes. */
	functionLike: Set<string>;
	/** Control structures that increase nesting depth. */
	nesting: Set<string>;
	/** Decision points that add +1 cyclomatic (if/loops/case/ternary). */
	decision: Set<string>;
	/** Structures that add cognitive complexity (nesting-weighted). */
	cognitive: Set<string>;
	/** Node types that ARE a logical operator (e.g. Python `boolean_operator`). */
	logicalOpNodes: Set<string>;
	/** Operator child types inside a `binary_expression` (&& || ??). */
	logicalBinaryOps: Set<string>;
	/** Node type for a try/catch block, if the language has one. */
	tryNode?: string;
	/** Child node types to read a function's name from (in priority order). */
	nameChildTypes: string[];
}

// JS/TS/JSX share one grammar shape.
const JSTS: LangNodes = {
	functionLike: new Set([
		"function_declaration",
		"method_definition",
		"function_expression",
		"arrow_function",
		"generator_function",
		"generator_function_declaration",
	]),
	nesting: new Set([
		"if_statement",
		"while_statement",
		"for_statement",
		"for_in_statement",
		"switch_statement",
		"function_declaration",
		"function_expression",
		"arrow_function",
		"method_definition",
		"class_declaration",
		"try_statement",
		"catch_clause",
	]),
	decision: new Set([
		"if_statement",
		"while_statement",
		"for_statement",
		"for_in_statement",
		"switch_case",
		"ternary_expression",
	]),
	cognitive: new Set([
		"if_statement",
		"while_statement",
		"for_statement",
		"for_in_statement",
		"switch_statement",
		"switch_case",
		"ternary_expression",
		"catch_clause",
	]),
	logicalOpNodes: new Set(),
	logicalBinaryOps: new Set(["&&", "||", "??"]),
	tryNode: "try_statement",
	nameChildTypes: ["identifier", "property_identifier"],
};

const PYTHON: LangNodes = {
	functionLike: new Set(["function_definition", "lambda"]),
	nesting: new Set([
		"if_statement",
		"for_statement",
		"while_statement",
		"match_statement",
		"function_definition",
		"class_definition",
		"try_statement",
		"except_clause",
		"elif_clause",
	]),
	decision: new Set([
		"if_statement",
		"elif_clause",
		"for_statement",
		"while_statement",
		"case_clause",
		"conditional_expression",
	]),
	cognitive: new Set([
		"if_statement",
		"elif_clause",
		"for_statement",
		"while_statement",
		"match_statement",
		"case_clause",
		"conditional_expression",
		"except_clause",
	]),
	logicalOpNodes: new Set(["boolean_operator"]),
	logicalBinaryOps: new Set(),
	tryNode: "try_statement",
	nameChildTypes: ["identifier"],
};

const GO: LangNodes = {
	functionLike: new Set([
		"function_declaration",
		"method_declaration",
		"func_literal",
	]),
	nesting: new Set([
		"if_statement",
		"for_statement",
		"expression_switch_statement",
		"type_switch_statement",
		"select_statement",
		"function_declaration",
		"method_declaration",
	]),
	decision: new Set([
		"if_statement",
		"for_statement",
		"expression_case",
		"type_case",
		"communication_case",
	]),
	cognitive: new Set([
		"if_statement",
		"for_statement",
		"expression_switch_statement",
		"type_switch_statement",
		"select_statement",
		"expression_case",
		"type_case",
		"communication_case",
	]),
	logicalOpNodes: new Set(),
	logicalBinaryOps: new Set(["&&", "||"]),
	tryNode: undefined, // Go has no try/catch (error returns)
	nameChildTypes: ["identifier", "field_identifier"],
};

const RUST: LangNodes = {
	functionLike: new Set(["function_item", "closure_expression"]),
	nesting: new Set([
		"if_expression",
		"while_expression",
		"for_expression",
		"loop_expression",
		"match_expression",
		"function_item",
	]),
	decision: new Set([
		"if_expression",
		"while_expression",
		"for_expression",
		"loop_expression",
		"match_arm",
	]),
	cognitive: new Set([
		"if_expression",
		"while_expression",
		"for_expression",
		"loop_expression",
		"match_expression",
		"match_arm",
	]),
	logicalOpNodes: new Set(),
	logicalBinaryOps: new Set(["&&", "||"]),
	tryNode: undefined, // Rust uses Result/? — no try/catch
	nameChildTypes: ["identifier"],
};

const LANGUAGE_NODES: Record<string, LangNodes> = {
	typescript: JSTS,
	tsx: JSTS,
	javascript: JSTS,
	python: PYTHON,
	go: GO,
	rust: RUST,
};

const COMMENT_TYPES = new Set(["comment", "line_comment", "block_comment"]);

// --- Metric helpers (module-level, node-config-driven) ---

function isLogicalOp(node: TsNode, nodes: LangNodes): boolean {
	if (nodes.logicalOpNodes.has(node.type)) return true;
	if (nodes.logicalBinaryOps.size > 0 && node.type === "binary_expression") {
		return (node.children ?? []).some(
			(c: TsNode) => c && nodes.logicalBinaryOps.has(c.type),
		);
	}
	return false;
}

/** Cyclomatic contribution of a subtree: decision points + logical operators. */
function subtreeCyclomatic(root: TsNode, nodes: LangNodes): number {
	let cc = 0;
	walk(root, (n) => {
		if (nodes.decision.has(n.type)) cc++;
		if (isLogicalOp(n, nodes)) cc++;
	});
	return cc;
}

/** Cognitive complexity (SonarSource-style: base + nesting penalty). */
function subtreeCognitive(node: TsNode, nesting: number, nodes: LangNodes): number {
	let complexity = 0;
	if (nodes.cognitive.has(node.type)) complexity += 1 + nesting;
	// Labeled break/continue add complexity.
	if (
		(node.type === "break_statement" || node.type === "continue_statement") &&
		(node.children ?? []).some(
			(c: TsNode) =>
				c &&
				(c.type === "statement_identifier" ||
					c.type === "identifier" ||
					c.type === "label_name" ||
					c.type === "label"),
		)
	) {
		complexity += 1 + nesting;
	}
	if (isLogicalOp(node, nodes)) complexity += 1;
	const childNesting = nodes.nesting.has(node.type) ? nesting + 1 : nesting;
	for (const child of node.children ?? []) {
		if (child) complexity += subtreeCognitive(child, childNesting, nodes);
	}
	return complexity;
}

function subtreeMaxNesting(
	node: TsNode,
	currentDepth: number,
	nodes: LangNodes,
): number {
	let maxDepth = currentDepth;
	if (nodes.nesting.has(node.type)) {
		currentDepth++;
		maxDepth = Math.max(maxDepth, currentDepth);
	}
	for (const child of node.children ?? []) {
		if (child) {
			maxDepth = Math.max(maxDepth, subtreeMaxNesting(child, currentDepth, nodes));
		}
	}
	return maxDepth;
}

function functionName(fnNode: TsNode, nodes: LangNodes): string | undefined {
	for (const t of nodes.nameChildTypes) {
		const id = firstChildOfType(fnNode, t);
		if (id) return id.text;
	}
	return undefined;
}

function collectFunctionMetrics(root: TsNode, nodes: LangNodes): FunctionMetrics[] {
	const functions: FunctionMetrics[] = [];
	const visit = (node: TsNode, nestingLevel: number): void => {
		if (nodes.functionLike.has(node.type)) {
			const startLine = node.startPosition.row;
			const endLine = node.endPosition.row;
			functions.push({
				name: functionName(node, nodes) ?? `<anonymous@L${startLine + 1}>`,
				line: startLine + 1,
				length: endLine - startLine + 1,
				cyclomatic: subtreeCyclomatic(node, nodes),
				cognitive: subtreeCognitive(node, nestingLevel, nodes),
				nestingDepth: subtreeMaxNesting(node, 0, nodes),
			});
		}
		const newNesting = nodes.nesting.has(node.type)
			? nestingLevel + 1
			: nestingLevel;
		for (const child of node.children ?? []) {
			if (child) visit(child, newNesting);
		}
	};
	visit(root, 0);
	return functions;
}

function countTryCatch(root: TsNode, nodes: LangNodes): number {
	if (!nodes.tryNode) return 0;
	let count = 0;
	walk(root, (n) => {
		if (n.type === nodes.tryNode) count++;
	});
	return count;
}

function countLines(
	content: string,
	root: TsNode,
): { codeLines: number; commentLines: number } {
	const lines = content.split(/\r?\n/);
	const commentLineSet = new Set<number>();
	walk(root, (n) => {
		if (COMMENT_TYPES.has(n.type)) {
			for (let l = n.startPosition.row; l <= n.endPosition.row; l++) {
				commentLineSet.add(l);
			}
		}
	});
	const codeLines = lines.filter((line, i) => {
		if (line.trim().length === 0) return false;
		if (!commentLineSet.has(i)) return true;
		// Line has a comment — keep it only if code remains after stripping it.
		const stripped = line
			.replace(/\/\/.*$/, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/#.*$/, "")
			.trim();
		return stripped.length > 0;
	}).length;
	return { codeLines, commentLines: commentLineSet.size };
}

const AI_COMMENT_PATTERNS = [
	/(?:🔍|✅|📝|🔧|🐛|⚠️|🚀|💡|🎯|📌|🏷️|🔑|🏗️|🧪|🗑️|🔄|♻️|📋|🔖|📊|💬|🔥|💎|⭐|🌟|🎨|🛠️)/u,
	/(?:\/\/|#)\s*(Initialize|Setup|Clean up|Create|Define|Check if|Handle|Process|Validate|Return|Get|Set|Add|Remove|Update|Fetch)\b/i,
	/(?:\/\/|#)\s*(This function|This method|This code|Here we|Now we)\b/i,
	/\/\*\*?\s*(Overview|Summary|Description|Example|Usage)\s*\*?\//i,
];

function countAICommentPatterns(sourceText: string): number {
	let count = 0;
	for (const line of sourceText.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (
			trimmed.startsWith("//") ||
			trimmed.startsWith("/*") ||
			trimmed.startsWith("*") ||
			trimmed.startsWith("#")
		) {
			for (const pattern of AI_COMMENT_PATTERNS) {
				if (pattern.test(line)) {
					count++;
					break;
				}
			}
		}
	}
	return count;
}

function calculateCodeEntropy(sourceText: string): number {
	const tokens = sourceText
		.replace(/\/\/.*/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/["'`][^"'`]*["'`]/g, "STR")
		.replace(/\b\d+(\.\d+)?\b/g, "NUM")
		.split(/[\s\n\r\t,;:()[\]{}=<>!&|+\-*/%^~?]+/)
		.filter((t) => t.length > 0);
	if (tokens.length === 0) return 0;
	const freq = new Map<string, number>();
	for (const token of tokens) freq.set(token, (freq.get(token) || 0) + 1);
	let entropy = 0;
	for (const count of freq.values()) {
		const p = count / tokens.length;
		if (p > 0) entropy -= p * Math.log2(p);
	}
	return entropy;
}

/**
 * Maintainability index, Halstead-free variant:
 * MI = max(0, (171 - 0.23·Cyclomatic - 16.2·ln(LOC)) · 100/171) + comment bonus.
 */
function calculateMaintainabilityIndex(
	cyclomatic: number,
	loc: number,
	comments: number,
): number {
	if (loc === 0) return 100;
	const lnLOC = Math.log(loc);
	let mi = ((171 - 0.23 * cyclomatic - 16.2 * lnLOC) * 100) / 171;
	const commentBonus = Math.min(10, (comments / loc) * 50);
	mi += commentBonus;
	return Math.max(0, Math.min(100, mi));
}

function calculateMaxParams(functions: FunctionMetrics[]): number {
	// Estimate from average function length (kept from the original heuristic).
	return Math.min(
		10,
		Math.max(
			2,
			Math.round(
				functions.reduce((a, f) => a + f.length, 0) /
					Math.max(1, functions.length) /
					5,
			),
		),
	);
}

function countSingleUseFunctions(functions: FunctionMetrics[]): number {
	return functions.filter(
		(f) =>
			f.length < 10 &&
			f.cyclomatic <= 2 &&
			/^(get|set|check|is|has|validate|format|parse|convert|create|make)/i.test(
				f.name,
			),
	).length;
}

// --- Client ---

export class ComplexityClient {
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[complexity] ${msg}`)
			: () => {};
	}

	/** True if the file's grammar has a complexity node mapping. */
	isSupportedFile(filePath: string): boolean {
		const languageId = resolveTreeSitterLanguage(filePath);
		return Boolean(languageId && languageId in LANGUAGE_NODES);
	}

	/** Analyze complexity metrics for a file (null if unsupported / unparseable). */
	async analyzeFile(filePath: string): Promise<FileComplexity | null> {
		const absolutePath = path.resolve(filePath);
		const languageId = resolveTreeSitterLanguage(absolutePath);
		const nodes = languageId ? LANGUAGE_NODES[languageId] : undefined;
		if (!nodes) return null;

		let content: string;
		let root: TsNode | null;
		try {
			if (!fs.existsSync(absolutePath)) return null;
			content = fs.readFileSync(absolutePath, "utf-8");
			root = await parseTreeSitterRoot(absolutePath, content);
		} catch (err) {
			this.log(`Read/parse error for ${filePath}: ${(err as Error).message}`);
			return null;
		}
		if (!root) return null;

		try {
			return this.computeMetrics(absolutePath, content, root, nodes);
		} catch (err) {
			this.log(`Analysis error for ${filePath}: ${(err as Error).message}`);
			return null;
		}
	}

	private computeMetrics(
		absolutePath: string,
		content: string,
		root: TsNode,
		nodes: LangNodes,
	): FileComplexity {
		const { codeLines, commentLines } = countLines(content, root);
		const functions = collectFunctionMetrics(root, nodes);
		const maxNestingDepth = subtreeMaxNesting(root, 0, nodes);
		const cognitive = subtreeCognitive(root, 0, nodes);
		const funcStats = this.aggregateFunctionStats(functions);

		return {
			filePath: path.relative(process.cwd(), absolutePath),
			maxNestingDepth,
			avgFunctionLength: funcStats.avgLength,
			maxFunctionLength: funcStats.maxLength,
			functionCount: functions.length,
			cyclomaticComplexity: funcStats.avgCyclomatic,
			maxCyclomaticComplexity: funcStats.maxCyclomatic,
			cognitiveComplexity: cognitive,
			maintainabilityIndex:
				Math.round(
					calculateMaintainabilityIndex(
						funcStats.avgCyclomatic,
						codeLines,
						commentLines,
					) * 10,
				) / 10,
			linesOfCode: codeLines,
			commentLines,
			codeEntropy: Math.round(calculateCodeEntropy(content) * 100) / 100,
			maxParamsInFunction: calculateMaxParams(functions),
			aiCommentPatterns: countAICommentPatterns(content),
			singleUseFunctions: countSingleUseFunctions(functions),
			tryCatchCount: countTryCatch(root, nodes),
		};
	}

	private aggregateFunctionStats(functions: FunctionMetrics[]): {
		avgLength: number;
		maxLength: number;
		avgCyclomatic: number;
		maxCyclomatic: number;
	} {
		if (functions.length === 0) {
			return { avgLength: 0, maxLength: 0, avgCyclomatic: 1, maxCyclomatic: 1 };
		}
		const lengths = functions.map((f) => f.length);
		const cyclomatics = functions.map((f) => f.cyclomatic);
		const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
		return {
			avgLength: Math.round(sum(lengths) / lengths.length),
			maxLength: Math.max(...lengths),
			avgCyclomatic: Math.max(
				1,
				Math.round(sum(cyclomatics) / cyclomatics.length),
			),
			maxCyclomatic: Math.max(1, Math.max(...cyclomatics)),
		};
	}
}
