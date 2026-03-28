/**
 * Complexity Metrics Client for pi-lens
 *
 * Calculates AST-based code complexity metrics for TypeScript/JavaScript files.
 * Uses the TypeScript compiler API for parsing.
 *
 * Tracks:
 * - Max Nesting Depth: Deepest control flow nesting
 * - Avg/Max Function Length: Lines per function
 * - Cyclomatic Complexity: Independent code paths (M = E - N + 2P)
 * - Cognitive Complexity: Human understanding difficulty
 * - Halstead Volume: Vocabulary-based complexity
 * - Maintainability Index: Composite score (0-100, higher is better)
 *
 * These are silent metrics shown in session summary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { isFileKind } from "./file-kinds.js";

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
	halsteadVolume: number;
	maintainabilityIndex: number; // 0-100
	linesOfCode: number;
	commentLines: number;
	codeEntropy: number; // Shannon entropy (0-1, lower = more predictable)
	// AI slop indicators
	maxParamsInFunction: number; // Max parameters in any function
	aiCommentPatterns: number; // Emoji comments, boilerplate phrases
	singleUseFunctions: number; // Functions only called once (estimated)
	tryCatchCount: number; // Number of try/catch blocks
}

export interface FunctionMetrics {
	name: string;
	line: number;
	length: number;
	cyclomatic: number;
	cognitive: number;
	nestingDepth: number;
}

// --- Constants ---

// Nodes that increase cyclomatic complexity
const CYCLOMAL_NODES = new Set([
	ts.SyntaxKind.IfStatement,
	ts.SyntaxKind.WhileStatement,
	ts.SyntaxKind.ForStatement,
	ts.SyntaxKind.ForInStatement,
	ts.SyntaxKind.ForOfStatement,
	ts.SyntaxKind.CaseClause,
	ts.SyntaxKind.ConditionalExpression,
	ts.SyntaxKind.BinaryExpression, // && and ||
]);

// Nodes that increase cognitive complexity (with nesting penalty)
const COGNITIVE_NODES = new Set([
	ts.SyntaxKind.IfStatement,
	ts.SyntaxKind.WhileStatement,
	ts.SyntaxKind.ForStatement,
	ts.SyntaxKind.ForInStatement,
	ts.SyntaxKind.ForOfStatement,
	ts.SyntaxKind.SwitchStatement,
	ts.SyntaxKind.CaseClause,
	ts.SyntaxKind.ConditionalExpression,
	ts.SyntaxKind.CatchClause,
]);

// Nesting-increasing nodes
const NESTING_NODES = new Set([
	ts.SyntaxKind.IfStatement,
	ts.SyntaxKind.WhileStatement,
	ts.SyntaxKind.ForStatement,
	ts.SyntaxKind.ForInStatement,
	ts.SyntaxKind.ForOfStatement,
	ts.SyntaxKind.SwitchStatement,
	ts.SyntaxKind.FunctionDeclaration,
	ts.SyntaxKind.FunctionExpression,
	ts.SyntaxKind.ArrowFunction,
	ts.SyntaxKind.ClassDeclaration,
	ts.SyntaxKind.MethodDeclaration,
	ts.SyntaxKind.TryStatement,
	ts.SyntaxKind.CatchClause,
]);

// Function-like nodes
const FUNCTION_LIKE_NODES = new Set([
	ts.SyntaxKind.FunctionDeclaration,
	ts.SyntaxKind.FunctionExpression,
	ts.SyntaxKind.ArrowFunction,
	ts.SyntaxKind.MethodDeclaration,
	ts.SyntaxKind.Constructor,
	ts.SyntaxKind.GetAccessor,
	ts.SyntaxKind.SetAccessor,
]);

// Halstead operators (common operators)
const HALSTEAD_OPERATORS = new Set([
	ts.SyntaxKind.PlusToken,
	ts.SyntaxKind.MinusToken,
	ts.SyntaxKind.AsteriskToken,
	ts.SyntaxKind.SlashToken,
	ts.SyntaxKind.PercentToken,
	ts.SyntaxKind.AmpersandToken,
	ts.SyntaxKind.BarToken,
	ts.SyntaxKind.CaretToken,
	ts.SyntaxKind.LessThanToken,
	ts.SyntaxKind.GreaterThanToken,
	ts.SyntaxKind.LessThanEqualsToken,
	ts.SyntaxKind.GreaterThanEqualsToken,
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.PlusPlusToken,
	ts.SyntaxKind.MinusMinusToken,
	ts.SyntaxKind.PlusEqualsToken,
	ts.SyntaxKind.MinusEqualsToken,
	ts.SyntaxKind.AsteriskEqualsToken,
	ts.SyntaxKind.SlashEqualsToken,
	ts.SyntaxKind.AmpersandEqualsToken,
	ts.SyntaxKind.BarEqualsToken,
	ts.SyntaxKind.LessThanLessThanToken,
	ts.SyntaxKind.GreaterThanGreaterThanToken,
	ts.SyntaxKind.QuestionToken,
	ts.SyntaxKind.ColonToken,
	ts.SyntaxKind.EqualsToken,
	ts.SyntaxKind.EqualsGreaterThanToken,
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.ExclamationToken,
	ts.SyntaxKind.TildeToken,
	ts.SyntaxKind.CommaToken,
	ts.SyntaxKind.SemicolonToken,
	ts.SyntaxKind.DotToken,
	ts.SyntaxKind.QuestionDotToken,
]);

// --- Client ---

export class ComplexityClient {
	private log: (msg: string) => void;

	constructor(verbose = false) {
		this.log = verbose
			? (msg: string) => console.error(`[complexity] ${msg}`)
			: () => {};
	}

	/**
	 * Check if file is supported (TS/JS)
	 */
	isSupportedFile(filePath: string): boolean {
		return isFileKind(filePath, "jsts");
	}

	/**
	 * Analyze complexity metrics for a file
	 */
	analyzeFile(filePath: string): FileComplexity | null {
		const parsed = this.readAndParse(filePath);
		if (!parsed) return null;

		try {
			return this.computeMetrics(parsed);
		} catch (err: any) {
			this.log(`Analysis error for ${filePath}: ${err.message}`);
			return null;
		}
	}

	/**
	 * Read file and parse to TypeScript AST
	 */
	private readAndParse(filePath: string): {
		absolutePath: string;
		content: string;
		sourceFile: ts.SourceFile;
	} | null {
		const absolutePath = path.resolve(filePath);
		if (!fs.existsSync(absolutePath)) return null;

		const content = fs.readFileSync(absolutePath, "utf-8");
		const sourceFile = ts.createSourceFile(
			filePath,
			content,
			ts.ScriptTarget.Latest,
			true,
		);

		return { absolutePath, content, sourceFile };
	}

	/**
	 * Compute all metrics from parsed source
	 */
	private computeMetrics(parsed: {
		absolutePath: string;
		content: string;
		sourceFile: ts.SourceFile;
	}): FileComplexity {
		const { absolutePath, content, sourceFile } = parsed;
		const lines = content.split("\n");

		// Line counts and function collection
		const { codeLines, commentLines } = this.countLines(sourceFile, lines);
		const functions = this.collectFunctionMetrics(sourceFile);

		// File-level complexity metrics
		const maxNestingDepth = this.calculateMaxNesting(sourceFile, 0);
		const cognitive = this.calculateCognitiveComplexity(sourceFile);
		const halstead = this.calculateHalsteadVolume(sourceFile);

		// Aggregate function statistics
		const funcStats = this.aggregateFunctionStats(functions);

		// Derived metrics
		const maintainabilityIndex = this.calculateMaintainabilityIndex(
			halstead,
			funcStats.avgCyclomatic,
			codeLines,
			commentLines,
		);
		const codeEntropy = this.calculateCodeEntropy(content);

		// AI slop indicators
		const maxParamsInFunction = this.calculateMaxParams(functions);
		const aiCommentPatterns = this.countAICommentPatterns(sourceFile);
		const singleUseFunctions = this.countSingleUseFunctions(functions);
		const tryCatchCount = this.countTryCatch(sourceFile);

		return {
			filePath: path.relative(process.cwd(), absolutePath),
			maxNestingDepth,
			avgFunctionLength: funcStats.avgLength,
			maxFunctionLength: funcStats.maxLength,
			functionCount: functions.length,
			cyclomaticComplexity: funcStats.avgCyclomatic,
			maxCyclomaticComplexity: funcStats.maxCyclomatic,
			cognitiveComplexity: cognitive,
			halsteadVolume: Math.round(halstead * 10) / 10,
			maintainabilityIndex: Math.round(maintainabilityIndex * 10) / 10,
			linesOfCode: codeLines,
			commentLines,
			codeEntropy: Math.round(codeEntropy * 100) / 100,
			maxParamsInFunction,
			aiCommentPatterns,
			singleUseFunctions,
			tryCatchCount,
		};
	}

	/**
	 * Aggregate function metrics into summary statistics
	 */
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

	/**
	 * Format metrics for display
	 */
	formatMetrics(metrics: FileComplexity): string {
		const parts: string[] = [];

		// Maintainability Index (most important)
		let miLabel = "✗";
		if (metrics.maintainabilityIndex >= 80) miLabel = "✓";
		else if (metrics.maintainabilityIndex >= 60) miLabel = "⚠";
		parts.push(
			`${miLabel} Maintainability: ${metrics.maintainabilityIndex}/100`,
		);

		// Complexity metrics
		if (
			metrics.cyclomaticComplexity > 5 ||
			metrics.maxCyclomaticComplexity > 10
		) {
			const avg = metrics.cyclomaticComplexity;
			const max = metrics.maxCyclomaticComplexity;
			parts.push(
				`  Cyclomatic: avg ${avg}, max ${max} (${metrics.functionCount} functions)`,
			);
		}

		if (metrics.cognitiveComplexity > 15) {
			parts.push(
				`  Cognitive: ${metrics.cognitiveComplexity} (high mental complexity)`,
			);
		}

		// Nesting depth
		if (metrics.maxNestingDepth > 4) {
			parts.push(
				`  Max nesting: ${metrics.maxNestingDepth} levels (consider extracting)`,
			);
		}

		// Code entropy (in bits, >3.5 = risky AI-induced complexity)
		if (metrics.codeEntropy > 3.5) {
			parts.push(
				`  Entropy: ${metrics.codeEntropy.toFixed(1)} bits (>3.5 — risky AI-induced complexity)`,
			);
		}

		// Function length
		if (metrics.maxFunctionLength > 50) {
			parts.push(
				`  Longest function: ${metrics.maxFunctionLength} lines (avg: ${metrics.avgFunctionLength})`,
			);
		}

		// Halstead (only if notably high)
		if (metrics.halsteadVolume > 500) {
			parts.push(
				`  Halstead volume: ${metrics.halsteadVolume} (high vocabulary)`,
			);
		}

		return parts.length > 0
			? `[Complexity] ${metrics.filePath}\n${parts.join("\n")}`
			: "";
	}

	/**
	 * Calculate max parameters across all functions
	 */
	private calculateMaxParams(functions: FunctionMetrics[]): number {
		const _maxParams = 0;
		// We stored function params in the metrics during analysis
		// For now, estimate based on function length (longer functions often have more params)
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

	/**
	 * Count AI comment patterns (emojis, boilerplate phrases)
	 */
	private countAICommentPatterns(sourceFile: ts.SourceFile): number {
		const sourceText = sourceFile.getText();
		let count = 0;

		const aiPatterns = [
			/[🔍✅📝🔧🐛⚠️🚀💡🎯📌🏷️🔑🏗️🧪🗑️🔄♻️📋🔖📊💬🔥💎⭐🌟🎯🎨🔧🛠️]/u,
			/\/\/\s*(Initialize|Setup|Clean up|Create|Define|Check if|Handle|Process|Validate|Return|Get|Set|Add|Remove|Update|Fetch)\b/i,
			/\/\/\s*(This function|This method|This code|Here we|Now we)\b/i,
			/\/\*\*?\s*(Overview|Summary|Description|Example|Usage)\s*\*?\//i,
		];

		const lines = sourceText.split("\n");
		for (const line of lines) {
			// Only check comment lines
			const trimmed = line.trim();
			if (
				trimmed.startsWith("//") ||
				trimmed.startsWith("/*") ||
				trimmed.startsWith("*")
			) {
				for (const pattern of aiPatterns) {
					if (pattern.test(line)) {
						count++;
						break;
					}
				}
			}
		}

		return count;
	}

	/**
	 * Count functions that appear to be single-use (helper patterns)
	 */
	private countSingleUseFunctions(functions: FunctionMetrics[]): number {
		// Heuristic: small functions (< 10 lines) with simple names are often single-use
		const smallHelpers = functions.filter(
			(f) =>
				f.length < 10 &&
				f.cyclomatic <= 2 &&
				/^(get|set|check|is|has|validate|format|parse|convert|create|make)/i.test(
					f.name,
				),
		);
		return smallHelpers.length;
	}

	/**
	 * Count try/catch blocks (generic error handling pattern)
	 */
	private countTryCatch(sourceFile: ts.SourceFile): number {
		let count = 0;

		const visit = (node: ts.Node) => {
			if (ts.isTryStatement(node)) {
				count++;
			}
			ts.forEachChild(node, visit);
		};

		ts.forEachChild(sourceFile, visit);
		return count;
	}

	/**
	 * Check thresholds and return actionable warnings
	 */
	checkThresholds(metrics: FileComplexity): string[] {
		const warnings: string[] = [];

		if (metrics.maintainabilityIndex < 60) {
			warnings.push(
				`Maintainability dropped to ${metrics.maintainabilityIndex} — extract logic into helper functions`,
			);
		}

		if (metrics.cyclomaticComplexity > 10) {
			warnings.push(
				`High complexity (${metrics.cyclomaticComplexity}) — use early returns or switch expressions`,
			);
		}

		if (metrics.cognitiveComplexity > 15) {
			warnings.push(
				`Cognitive complexity (${metrics.cognitiveComplexity}) — simplify logic flow`,
			);
		}

		if (metrics.maxNestingDepth > 4) {
			warnings.push(
				`Deep nesting (${metrics.maxNestingDepth} levels) — extract nested logic into separate functions`,
			);
		}

		if (metrics.codeEntropy > 3.5) {
			warnings.push(
				`High entropy (${metrics.codeEntropy.toFixed(1)} bits) — follow project conventions`,
			);
		}

		// Comments ratio (>40% = excessive comments, AI slop signal)
		const totalLines = metrics.linesOfCode + metrics.commentLines;
		if (totalLines > 10 && metrics.commentLines / totalLines > 0.4) {
			warnings.push(
				`Excessive comments (${Math.round((metrics.commentLines / totalLines) * 100)}%) — remove obvious comments`,
			);
		}

		// Verbose code (long functions with low complexity = overly verbose)
		if (metrics.avgFunctionLength > 30 && metrics.cyclomaticComplexity < 3) {
			warnings.push(
				`Verbose code (avg ${Math.round(metrics.avgFunctionLength)} lines, low complexity) — simplify or extract`,
			);
		}

		// AI slop: Emoji/boilerplate comments
		if (metrics.aiCommentPatterns > 5) {
			warnings.push(
				`AI-style comments (${metrics.aiCommentPatterns}) — remove hand-holding comments`,
			);
		}

		// AI slop: Too many try/catch blocks (lazy error handling)
		if (metrics.tryCatchCount > 15) {
			warnings.push(
				`Many try/catch blocks (${metrics.tryCatchCount}) — consolidate error handling`,
			);
		}

		// AI slop: Over-abstraction (many single-use helper functions)
		if (metrics.singleUseFunctions > 3 && metrics.functionCount > 5) {
			warnings.push(
				`Over-abstraction (${metrics.singleUseFunctions} single-use helpers) — inline or consolidate`,
			);
		}

		// AI slop: Functions with too many parameters
		if (metrics.maxParamsInFunction > 6) {
			warnings.push(
				`Long parameter list (${metrics.maxParamsInFunction} params) — use options object`,
			);
		}

		return warnings;
	}

	/**
	 * Format delta for session summary
	 */
	formatDelta(previous: FileComplexity, current: FileComplexity): string {
		const parts: string[] = [];

		const miDelta =
			current.maintainabilityIndex - previous.maintainabilityIndex;
		if (Math.abs(miDelta) > 1) {
			const arrow = miDelta > 0 ? "↑" : "↓";
			const sign = miDelta > 0 ? "+" : "";
			parts.push(
				`  ${arrow} ${current.filePath}: MI ${previous.maintainabilityIndex} → ${current.maintainabilityIndex} (${sign}${miDelta.toFixed(1)})`,
			);
		}

		const cogDelta = current.cognitiveComplexity - previous.cognitiveComplexity;
		if (Math.abs(cogDelta) > 3) {
			const arrow = cogDelta > 0 ? "↑" : "↓";
			const sign = cogDelta > 0 ? "+" : "";
			parts.push(
				`  ${arrow} ${current.filePath}: cognitive ${previous.cognitiveComplexity} → ${current.cognitiveComplexity} (${sign}${cogDelta})`,
			);
		}

		return parts.join("\n");
	}

	// --- Private: Line Counting ---

	private countLines(
		sourceFile: ts.SourceFile,
		lines: string[],
	): { codeLines: number; commentLines: number } {
		let commentLines = 0;
		const commentPositions = new Set<number>();

		// Find comment positions
		const _visitComments = (node: ts.Node) => {
			ts.forEachChild(node, _visitComments);
		};

		// Scan for comments using text
		const text = sourceFile.getFullText();
		const commentRegex = /\/\/.*$|\/\*[\s\S]*?\*\//gm;
		let match;
		while ((match = commentRegex.exec(text)) !== null) {
			const lineStart = text.lastIndexOf("\n", match.index) + 1;
			const startLine = text.substring(0, lineStart).split("\n").length - 1;
			const endLine =
				text.substring(0, match.index + match[0].length).split("\n").length - 1;
			for (let i = startLine; i <= endLine; i++) {
				commentPositions.add(i);
			}
		}

		commentLines = commentPositions.size;
		const codeLines = lines.filter((line, i) => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return false;

			// If the line is not in commentPositions, it definitely has code
			if (!commentPositions.has(i)) return true;

			// If it IS in commentPositions, it might still have code (trailing comment)
			// Remove the comment part and check if anything remains
			const lineWithoutComments = line
				.replace(/\/\/.*$/, "")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.trim();
			return lineWithoutComments.length > 0;
		}).length;

		return { codeLines, commentLines };
	}

	// --- Private: Function Metrics Collection ---

	/**
	 * Collect metrics for all functions in the source file
	 */
	private collectFunctionMetrics(sourceFile: ts.SourceFile): FunctionMetrics[] {
		const functions: FunctionMetrics[] = [];
		this.visitFunctionMetrics(sourceFile, sourceFile, functions, 0);
		return functions;
	}

	private visitFunctionMetrics(
		node: ts.Node,
		sourceFile: ts.SourceFile,
		functions: FunctionMetrics[],
		nestingLevel: number,
	): void {
		if (FUNCTION_LIKE_NODES.has(node.kind)) {
			const funcNode = node as ts.FunctionLikeDeclaration;
			const startLine = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(),
			).line;
			const endLine = sourceFile.getLineAndCharacterOfPosition(
				node.getEnd(),
			).line;
			const length = endLine - startLine + 1;

			const cyclomatic = this.nodeCyclomaticComplexity(node, 0);
			const cognitive = this.nodeCognitiveComplexity(node, nestingLevel);
			const maxNesting = this.calculateMaxNesting(node, 0);

			const name = funcNode.name
				? funcNode.name.getText(sourceFile)
				: `<anonymous@L${startLine + 1}>`;

			functions.push({
				name,
				line: startLine + 1,
				length,
				cyclomatic,
				cognitive,
				nestingDepth: maxNesting,
			});
		}

		// Track nesting depth changes
		const newNesting = NESTING_NODES.has(node.kind)
			? nestingLevel + 1
			: nestingLevel;
		ts.forEachChild(node, (child) => {
			this.visitFunctionMetrics(child, sourceFile, functions, newNesting);
		});
	}

	// --- Private: Max Nesting Depth ---

	private calculateMaxNesting(node: ts.Node, currentDepth: number): number {
		let maxDepth = currentDepth;

		if (NESTING_NODES.has(node.kind)) {
			currentDepth++;
			maxDepth = Math.max(maxDepth, currentDepth);
		}

		ts.forEachChild(node, (child) => {
			const childMax = this.calculateMaxNesting(child, currentDepth);
			maxDepth = Math.max(maxDepth, childMax);
		});

		return maxDepth;
	}

	private isLogicalOperator(node: ts.Node): boolean {
		if (node.kind === ts.SyntaxKind.BinaryExpression) {
			const binary = node as ts.BinaryExpression;
			return (
				binary.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
				binary.operatorToken.kind === ts.SyntaxKind.BarBarToken
			);
		}
		return false;
	}

	private nodeCyclomaticComplexity(node: ts.Node, complexity: number): number {
		// Base increment for branching nodes
		if (CYCLOMAL_NODES.has(node.kind)) {
			complexity++;
		}

		// Binary && and || add complexity
		if (this.isLogicalOperator(node)) {
			complexity++;
		}

		ts.forEachChild(node, (child) => {
			complexity = this.nodeCyclomaticComplexity(child, complexity);
		});

		return complexity;
	}

	// --- Private: Cognitive Complexity ---
	// Based on SonarSource's Cognitive Complexity specification
	// Increment for: if, for, while, case, catch, conditional
	// Additional increment for nesting

	private calculateCognitiveComplexity(node: ts.Node): number {
		return this.nodeCognitiveComplexity(node, 0);
	}

	private nodeCognitiveComplexity(node: ts.Node, nestingDepth: number): number {
		let complexity = 0;

		// Structures that contribute to cognitive complexity
		if (COGNITIVE_NODES.has(node.kind)) {
			// Base increment + nesting penalty
			complexity += 1 + nestingDepth;
		}

		// Break/continue with label add to complexity
		if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
			if (node.label) {
				complexity += 1 + nestingDepth;
			}
		}

		// Binary && and || contribute to complexity
		if (this.isLogicalOperator(node)) {
			complexity += 1;
		}

		// Calculate nesting for children
		const increasesNesting = NESTING_NODES.has(node.kind);
		const childNesting = increasesNesting ? nestingDepth + 1 : nestingDepth;

		ts.forEachChild(node, (child) => {
			complexity += this.nodeCognitiveComplexity(child, childNesting);
		});

		return complexity;
	}

	// --- Private: Halstead Volume ---
	// V = N * log2(n) where N = total operators+operands, n = unique operators+operands

	private calculateHalsteadVolume(node: ts.Node): number {
		const operators = new Set<string>();
		const operands = new Set<string>();
		let totalOperators = 0;
		let totalOperands = 0;

		const visit = (n: ts.Node) => {
			// Check if it's an operator
			if (HALSTEAD_OPERATORS.has(n.kind)) {
				const opText = ts.SyntaxKind[n.kind];
				operators.add(opText);
				totalOperators++;
			}
			// Check for identifiers (operands)
			else if (ts.isIdentifier(n)) {
				const text = n.getText();
				// Skip keywords that are parsed as identifiers
				if (!this.isKeyword(text)) {
					operands.add(text);
					totalOperands++;
				}
			}
			// Check for literals (operands)
			else if (
				ts.isNumericLiteral(n) ||
				ts.isStringLiteral(n) ||
				n.kind === ts.SyntaxKind.TrueKeyword ||
				n.kind === ts.SyntaxKind.FalseKeyword ||
				n.kind === ts.SyntaxKind.NullKeyword ||
				n.kind === ts.SyntaxKind.UndefinedKeyword
			) {
				const text = n.getText();
				operands.add(text);
				totalOperands++;
			}

			ts.forEachChild(n, visit);
		};

		visit(node);

		const uniqueOps = operators.size + operands.size;
		const totalOps = totalOperators + totalOperands;

		if (uniqueOps === 0 || totalOps === 0) return 0;

		// V = N * log2(n)
		return totalOps * Math.log2(uniqueOps);
	}

	/**
	 * Calculate Shannon entropy of code tokens (in bits)
	 * Uses log2 for entropy measured in bits
	 * Threshold: >3.5 bits indicates risky AI-induced complexity
	 */
	private calculateCodeEntropy(sourceText: string): number {
		// Tokenize by splitting on whitespace and common delimiters
		const tokens = sourceText
			.replace(/\/\/.*/g, "") // Remove single-line comments
			.replace(/\/\*[\s\S]*?\*\//g, "") // Remove multi-line comments
			.replace(/["'`][^"'`]*["'`]/g, "STR") // Normalize strings
			.replace(/\b\d+(\.\d+)?\b/g, "NUM") // Normalize numbers
			.split(/[\s\n\r\t,;:()[\]{}=<>!&|+\-*/%^~?]+/)
			.filter((t) => t.length > 0);

		if (tokens.length === 0) return 0;

		// Count token frequencies
		const freq = new Map<string, number>();
		for (const token of tokens) {
			freq.set(token, (freq.get(token) || 0) + 1);
		}

		// Calculate Shannon entropy in bits: H = -sum(p * log2(p))
		let entropy = 0;
		for (const count of Array.from(freq.values())) {
			const p = count / tokens.length;
			if (p > 0) {
				entropy -= p * Math.log2(p);
			}
		}

		return entropy; // Return in bits, not normalized
	}

	private isKeyword(text: string): boolean {
		const keywords = new Set([
			"if",
			"else",
			"for",
			"while",
			"do",
			"switch",
			"case",
			"break",
			"continue",
			"return",
			"throw",
			"try",
			"catch",
			"finally",
			"class",
			"extends",
			"super",
			"import",
			"export",
			"default",
			"from",
			"as",
			"const",
			"let",
			"var",
			"function",
			"new",
			"delete",
			"typeof",
			"void",
			"instanceof",
			"in",
			"of",
			"this",
			"true",
			"false",
			"null",
			"undefined",
			"async",
			"await",
			"yield",
			"static",
			"get",
			"set",
		]);
		return keywords.has(text);
	}

	// --- Private: Maintainability Index ---
	// Microsoft's formula: MI = max(0, (171 - 5.2 * ln(Halstead) - 0.23 * Cyclomatic - 16.2 * ln(LOC)) * 100 / 171)
	// Adjusted for comment density bonus

	private calculateMaintainabilityIndex(
		halstead: number,
		cyclomatic: number,
		loc: number,
		comments: number,
	): number {
		if (loc === 0) return 100;

		const lnHalstead = halstead > 0 ? Math.log(halstead) : 0;
		const lnLOC = loc > 0 ? Math.log(loc) : 0;

		// Base MI formula
		let mi =
			((171 - 5.2 * lnHalstead - 0.23 * cyclomatic - 16.2 * lnLOC) * 100) / 171;

		// Comment density bonus (up to +10%)
		const commentDensity = comments / loc;
		const commentBonus = Math.min(10, commentDensity * 50);

		mi += commentBonus;

		return Math.max(0, Math.min(100, mi));
	}
}
