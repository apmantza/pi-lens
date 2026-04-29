/**
 * Similarity Runner: Detect semantic code reuse opportunities
 *
 * Uses Amain's 57×72 state matrix algorithm to find similar functions.
 * Integrated into dispatch flow as a warning (non-blocking) suggestion.
 */

import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	buildProjectIndex,
	findSimilarFunctions,
	loadIndex,
	type ProjectIndex,
} from "../../project-index.js";
import { collectSourceFiles } from "../../source-filter.js";
import { buildStateMatrix, countTransitions } from "../../state-matrix.js";
import { PRIORITY } from "../priorities.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

type TypeScriptModule = typeof import("typescript");
let tsModulePromise: Promise<TypeScriptModule | null> | undefined;

async function loadTypeScript(): Promise<TypeScriptModule | null> {
	if (!tsModulePromise) {
		tsModulePromise = import("typescript").catch(() => null);
	}
	return tsModulePromise;
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
	SIMILARITY_THRESHOLD: 0.98, // align with booboo: stricter to reduce boilerplate false positives
	MIN_TRANSITIONS: 40, // stronger signal floor for structural comparisons
	MIN_FUNCTION_LINES: 8, // Ignore tiny helpers/wrappers
	MIN_FILE_CHARS: 140, // Skip tiny/trivial files early
	MAX_FILE_LINES: 2000, // Skip very large files (data files, generated code) to avoid OOM
	MAX_TRANSITION_RATIO: 1.8, // Skip pairs with highly mismatched complexity/size
	MAX_SUGGESTIONS: 3, // Max 3 suggestions per file
	MAX_PER_TARGET_NAME: 1, // Avoid one-to-many spam for the same target utility
};

const GENERIC_NAME_TOKENS = new Set([
	"get",
	"set",
	"create",
	"build",
	"make",
	"run",
	"do",
	"handle",
	"process",
	"check",
	"load",
	"save",
	"fetch",
	"update",
	"register",
	"init",
	"compute",
	"calc",
	"helper",
	"util",
	"function",
]);

export function tokenizeFunctionName(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length >= 3);
}

export function hasMeaningfulNameOverlap(
	sourceName: string,
	targetName: string,
): boolean {
	const source = new Set(tokenizeFunctionName(sourceName));
	const target = new Set(tokenizeFunctionName(targetName));
	const shared = [...source].filter((token) => target.has(token));
	if (shared.length === 0) return false;

	const specificShared = shared.filter(
		(token) => !GENERIC_NAME_TOKENS.has(token),
	);
	if (specificShared.length > 0) return true;

	// Fallback: allow overlap if there are at least two shared generic tokens.
	return shared.length >= 2;
}

// ============================================================================
// Runner Implementation
// ============================================================================

const similarityRunner: RunnerDefinition = {
	id: "similarity",
	appliesTo: ["jsts"], // TypeScript/JavaScript only for MVP
	priority: PRIORITY.SIMILARITY,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const { filePath } = ctx;

		// Only check TypeScript files
		if (!filePath.match(/\.tsx?$/)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Load file content
		const content = await fs.readFile(filePath, "utf-8").catch(() => null);
		if (!content) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const lineCount = content.split(/\r?\n/).length;
		if (lineCount > CONFIG.MAX_FILE_LINES) {
			console.error(
				`[runner:similarity] skipped ${filePath} — file exceeds ${CONFIG.MAX_FILE_LINES} lines (${lineCount} lines)`,
			);
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}
		if (
			content.trim().length < CONFIG.MIN_FILE_CHARS ||
			lineCount < CONFIG.MIN_FUNCTION_LINES + 2 ||
			!/(\bfunction\b|=>)/.test(content)
		) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Skip for small edits — a new function needs at least MIN_FUNCTION_LINES
		// lines to be worth checking; tiny changes can't introduce a meaningful duplicate
		if (ctx.modifiedRanges) {
			const totalLinesChanged = ctx.modifiedRanges.reduce(
				(sum, r) => sum + (r.end - r.start + 1),
				0,
			);
			if (totalLinesChanged < CONFIG.MIN_FUNCTION_LINES) {
				return { status: "skipped", diagnostics: [], semantic: "none" };
			}
		}

		// Find project root and load index
		const projectRoot = await findProjectRoot(filePath);
		if (!projectRoot) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const cachedIndex = await loadCachedIndex(projectRoot);
		if (!cachedIndex || cachedIndex.entries.size === 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const ts = await loadTypeScript();
		if (!ts) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const index = cachedIndex;

		// Parse the file
		const sourceFile = ts.createSourceFile(
			filePath,
			content,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);

		// Extract functions and check for similarities
		const newFunctions = extractFunctions(ts, sourceFile, content);

		const diagnostics: Diagnostic[] = [];
		const seenTargets = new Map<string, number>();

		for (const func of newFunctions) {
			// Guardrail: Skip tiny functions
			if (
				func.transitionCount < CONFIG.MIN_TRANSITIONS ||
				func.lineCount < CONFIG.MIN_FUNCTION_LINES
			) {
				continue;
			}

			// Find similar functions in index
			const matches = findSimilarFunctions(
				func.matrix,
				index,
				CONFIG.SIMILARITY_THRESHOLD,
				CONFIG.MAX_SUGGESTIONS,
			);

			// Create diagnostic for each match
			for (const match of matches) {
				if (match.targetTransitionCount < CONFIG.MIN_TRANSITIONS) {
					continue;
				}

				const maxTransitions = Math.max(
					func.transitionCount,
					match.targetTransitionCount,
				);
				const minTransitions = Math.min(
					func.transitionCount,
					match.targetTransitionCount,
				);
				if (minTransitions <= 0) continue;
				if (maxTransitions / minTransitions > CONFIG.MAX_TRANSITION_RATIO) {
					continue;
				}

				if (!hasMeaningfulNameOverlap(func.name, match.targetName)) {
					continue;
				}

				const targetKey = `${match.targetName}@${match.targetLocation}`;
				const seenForTarget = seenTargets.get(targetKey) ?? 0;
				if (seenForTarget >= CONFIG.MAX_PER_TARGET_NAME) {
					continue;
				}
				seenTargets.set(targetKey, seenForTarget + 1);

				const targetPath = extractLocationPath(match.targetLocation);
				if (targetPath) {
					const resolvedTarget = path.isAbsolute(targetPath)
						? targetPath
						: path.join(projectRoot, targetPath);
					if (!nodeFs.existsSync(resolvedTarget)) {
						continue;
					}
				}

				// Skip if it's the same function (self-match by path/name)
				if (
					match.targetId ===
					`${path.relative(projectRoot, filePath)}:${func.name}`
				) {
					continue;
				}

				diagnostics.push({
					id: `similarity-${func.name}-${match.targetId}`,
					tool: "similarity",
					filePath,
					line: func.line,
					column: func.column,
					message: buildSuggestionMessage(func, match),
					severity: "warning", // 🟡 Not blocking
					semantic: "warning",
				});
			}
		}

		// Return limited number of suggestions
		const limitedResults = diagnostics.slice(0, CONFIG.MAX_SUGGESTIONS);

		if (limitedResults.length === 0) {
			return { status: "succeeded", diagnostics: [], semantic: "none" };
		}

		return {
			status: "succeeded",
			diagnostics: limitedResults,
			semantic: "warning",
		};
	},
};

// ============================================================================
// Function Extraction
// ============================================================================

export interface ExtractedFunction {
	name: string;
	line: number;
	column: number;
	lineCount: number;
	matrix: number[][];
	transitionCount: number;
	signature: string;
}

export function extractFunctions(
	tsModule: TypeScriptModule,
	sourceFile: import("typescript").SourceFile,
	_fullContent: string,
): ExtractedFunction[] {
	const functions: ExtractedFunction[] = [];

	function visit(node: import("typescript").Node) {
		// Function declarations
		if (tsModule.isFunctionDeclaration(node) && node.name) {
			const startPos = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile),
			);
			const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
			const funcCode = getNodeText(node, sourceFile);
			const matrix = buildStateMatrix(funcCode);
			const transitionCount = countTransitions(matrix);

			functions.push({
				name: node.name.text,
				line: startPos.line + 1, // 1-indexed
				column: startPos.character + 1, // 1-indexed
				lineCount: Math.max(1, endPos.line - startPos.line + 1),
				matrix,
				transitionCount,
				signature: getSignature(tsModule, node),
			});
		}

		// Arrow functions assigned to const
		if (tsModule.isVariableStatement(node)) {
			extractArrowFunctions(tsModule, node, functions, sourceFile);
		}

		tsModule.forEachChild(node, visit);
	}

	visit(sourceFile);
	return functions;
}

function extractArrowFunctions(
	tsModule: TypeScriptModule,
	node: import("typescript").VariableStatement,
	functions: ExtractedFunction[],
	sourceFile: import("typescript").SourceFile,
): void {
	for (const decl of node.declarationList.declarations) {
		if (!tsModule.isIdentifier(decl.name) || !decl.initializer) {
			continue;
		}

		const func = decl.initializer;
		if (
			!tsModule.isArrowFunction(func) &&
			!tsModule.isFunctionExpression(func)
		) {
			continue;
		}

		const startPos = sourceFile.getLineAndCharacterOfPosition(
			node.getStart(sourceFile),
		);
		const endPos = sourceFile.getLineAndCharacterOfPosition(func.getEnd());
		const funcCode = getNodeText(func, sourceFile);
		const matrix = buildStateMatrix(funcCode);
		const transitionCount = countTransitions(matrix);

		functions.push({
			name: decl.name.text,
			line: startPos.line + 1,
			column: startPos.character + 1,
			lineCount: Math.max(1, endPos.line - startPos.line + 1),
			matrix,
			transitionCount,
			signature: getArrowSignature(tsModule, func),
		});
	}
}

function getNodeText(
	node: import("typescript").Node,
	sourceFile: import("typescript").SourceFile,
): string {
	return sourceFile.text.substring(node.getStart(sourceFile), node.getEnd());
}

function getSignature(
	tsModule: TypeScriptModule,
	node: import("typescript").FunctionDeclaration,
): string {
	const params = node.parameters
		.map((p) => (tsModule.isIdentifier(p.name) ? p.name.text : "param"))
		.join(", ");
	return `(${params})`;
}

function getArrowSignature(
	tsModule: TypeScriptModule,
	node:
		| import("typescript").ArrowFunction
		| import("typescript").FunctionExpression,
): string {
	const params = node.parameters
		.map((p) => (tsModule.isIdentifier(p.name) ? p.name.text : "param"))
		.join(", ");
	return `(${params})`;
}

// ============================================================================
// Message Building
// ============================================================================

function buildSuggestionMessage(
	func: ExtractedFunction,
	match: {
		targetId: string;
		targetName: string;
		targetLocation: string;
		similarity: number;
	},
): string {
	const similarityPct = Math.round(match.similarity * 100);
	const location = String(match.targetLocation || "").replace(/\\/g, "/");
	const name = match.targetName;

	return `Function '${func.name}' has ${similarityPct}% similarity to '${name}()' at ${location}. Consider reusing it if behavior is equivalent.`;
}

function extractLocationPath(location: string): string {
	const m = location.match(/^(.*):\d+$/);
	if (m?.[1]) return m[1];
	return location;
}

// ============================================================================
// Index Management
// ============================================================================

const indexCache = new Map<string, ProjectIndex>();

async function findProjectRoot(filePath: string): Promise<string | null> {
	let dir = path.dirname(filePath);
	while (dir !== path.dirname(dir)) {
		try {
			await fs.access(path.join(dir, "package.json"));
			return dir;
		} catch {
			dir = path.dirname(dir);
		}
	}
	return null;
}

async function loadOrBuildIndex(
	projectRoot: string,
): Promise<ProjectIndex | null> {
	// Check cache
	const cached = indexCache.get(projectRoot);
	if (cached) {
		return cached;
	}

	// Try to load existing index
	const existing = await loadIndex(projectRoot);
	if (existing) {
		indexCache.set(projectRoot, existing);
		return existing;
	}

	// Build new index
	const absoluteFiles = collectSourceFiles(projectRoot, {
		extensions: [".ts"],
	}).filter((filePath) => {
		const normalized = filePath.replace(/\\/g, "/");
		return (
			!normalized.endsWith(".test.ts") &&
			!normalized.endsWith(".spec.ts") &&
			!normalized.endsWith(".poc.test.ts")
		);
	});

	if (absoluteFiles.length === 0) {
		return null;
	}

	const index = await buildProjectIndex(projectRoot, absoluteFiles);

	indexCache.set(projectRoot, index);
	return index;
}

async function loadCachedIndex(
	projectRoot: string,
): Promise<ProjectIndex | null> {
	const cached = indexCache.get(projectRoot);
	if (cached) {
		return cached;
	}

	const existing = await loadIndex(projectRoot);
	if (!existing) {
		return null;
	}

	indexCache.set(projectRoot, existing);
	return existing;
}

// ============================================================================
// Testing Helper
// ============================================================================

export async function buildIndexForTesting(
	projectRoot: string,
): Promise<ProjectIndex> {
	const index = await loadOrBuildIndex(projectRoot);
	if (!index) {
		throw new Error("Failed to build index");
	}
	return index;
}

export { CONFIG };
export default similarityRunner;
