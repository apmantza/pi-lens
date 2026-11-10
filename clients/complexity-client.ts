/**
 * Complexity Metrics Client for pi-lens
 *
 * File-level code metrics over the shared tree-sitter client (#402 — no
 * `typescript` compiler dependency). The per-function numbers and the
 * per-language node tables come from `clients/metrics/function-metrics.ts`
 * (#5086).
 *
 * Tracks: max nesting depth, function length, cyclomatic + cognitive complexity,
 * maintainability index (Halstead-free), LOC/comments, code entropy, and AI-slop
 * indicators. These are silent metrics surfaced in the session summary.
 */

import { createSubsystemLogger } from "./extension-log.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	measureFile,
	MAX_MEASURED_BYTES,
	type NamedFunctionMetrics,
} from "./metrics/function-metrics.js";
import {
	withTreeSitterRoot,
	type ComplexityLanguageId,
	isComplexityLanguageId,
	isComplexitySupportedFile,
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
	/** Per-function metrics used by advisory reports and model diagnostics. */
	functions: FunctionMetrics[];
	/**
	 * `measureFile`'s own rows, keyed (#5087): a file's first-touch complexity
	 * baseline is taken from them, so the first touch measures the file once.
	 * Undefined above MAX_MEASURED_BYTES; aggregate metrics still run.
	 */
	measuredFunctions: readonly NamedFunctionMetrics[] | undefined;
}

export interface FunctionMetrics {
	name: string;
	line: number;
	length: number;
	/** Zero-based: the decision points alone, McCabe minus one (#2697). */
	cyclomatic: number;
	cognitive: number;
	nestingDepth: number;
}

const COMMENT_TYPES = new Set(["comment", "line_comment", "block_comment"]);

// --- Metric helpers ---

/** JS/TS and Python spell it `try_statement`; Go and Rust have none. */
function countTryCatch(root: TsNode): number {
	let count = 0;
	walk(root, (n) => {
		if (n.type === "try_statement") count++;
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
		this.log = verbose ? createSubsystemLogger("complexity") : () => {};
	}

	/** True if the file's grammar has a complexity node mapping.
	 *
	 * Delegates to the module-free predicate in `tree-sitter-shared.ts`: the
	 * same question is asked by `handleToolCallImpl` BEFORE the analyzer
	 * bootstrap is loaded (#2467), and two copies of it would be two answers. */
	isSupportedFile(filePath: string): boolean {
		return isComplexitySupportedFile(filePath);
	}

	/** Analyze complexity metrics for a file (null if unsupported / unparseable). */
	async analyzeFile(filePath: string): Promise<FileComplexity | null> {
		const absolutePath = path.resolve(filePath);
		const languageId = resolveTreeSitterLanguage(absolutePath);
		if (!languageId || !isComplexityLanguageId(languageId)) return null;

		let content: string;
		try {
			if (!fs.existsSync(absolutePath)) return null;
			content = fs.readFileSync(absolutePath, "utf-8");
		} catch (err) {
			this.log(`Read error for ${filePath}: ${(err as Error).message}`);
			return null;
		}

		try {
			const parsed = await withTreeSitterRoot(
				absolutePath,
				content,
				(root) => this.computeMetrics(absolutePath, content, root, languageId),
				"complexity",
			);
			return parsed.parsed ? parsed.value : null;
		} catch (err) {
			this.log(`Analysis error for ${filePath}: ${(err as Error).message}`);
			return null;
		}
	}

	private computeMetrics(
		absolutePath: string,
		content: string,
		root: TsNode,
		languageId: ComplexityLanguageId,
	): FileComplexity {
		const { codeLines, commentLines } = countLines(content, root);
		const keyFunctions =
			Buffer.byteLength(content, "utf-8") <= MAX_MEASURED_BYTES;
		const file = measureFile(root, languageId, keyFunctions);
		const functions: FunctionMetrics[] = file.functions.map((f) => ({
			name: f.name,
			line: f.line,
			length: f.length,
			cyclomatic: f.cyclomatic - 1,
			cognitive: f.cognitive,
			nestingDepth: f.nesting,
		}));
		const funcStats = this.aggregateFunctionStats(functions);

		return {
			filePath: path.relative(process.cwd(), absolutePath),
			maxNestingDepth: file.nesting,
			avgFunctionLength: funcStats.avgLength,
			maxFunctionLength: funcStats.maxLength,
			functionCount: functions.length,
			cyclomaticComplexity: funcStats.avgCyclomatic,
			maxCyclomaticComplexity: funcStats.maxCyclomatic,
			cognitiveComplexity: file.cognitive,
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
			maxParamsInFunction: Math.max(
				0,
				...file.functions.map((f) => f.parameters),
			),
			aiCommentPatterns: countAICommentPatterns(content),
			singleUseFunctions: countSingleUseFunctions(functions),
			tryCatchCount: countTryCatch(root),
			functions,
			measuredFunctions: keyFunctions ? file.functions : undefined,
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
