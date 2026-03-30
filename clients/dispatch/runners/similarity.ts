/**
 * Similarity Runner: Detect semantic code reuse opportunities
 *
 * Uses Amain's 57×72 state matrix algorithm to find similar functions.
 * Integrated into dispatch flow as a warning (non-blocking) suggestion.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import { EXCLUDED_DIRS } from "../../file-utils.js";
import {
	buildProjectIndex,
	findSimilarFunctions,
	loadIndex,
	type ProjectIndex,
} from "../../project-index.js";
import { buildStateMatrix, countTransitions } from "../../state-matrix.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
	SIMILARITY_THRESHOLD: 0.75, // 75% minimum similarity
	MIN_TRANSITIONS: 20, // Skip functions with <20 AST transitions
	MAX_SUGGESTIONS: 3, // Max 3 suggestions per file
	USAGE_THRESHOLD: 2, // Only suggest utilities with 2+ uses (placeholder)
};

// ============================================================================
// Runner Implementation
// ============================================================================

const similarityRunner: RunnerDefinition = {
	id: "similarity",
	appliesTo: ["jsts"], // TypeScript/JavaScript only for MVP
	priority: 35, // After ts-lsp, before ast-grep
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

		// Find project root and load index
		const projectRoot = await findProjectRoot(filePath);
		if (!projectRoot) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const index = await loadOrBuildIndex(projectRoot);
		if (!index || index.entries.size === 0) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Parse the file
		const sourceFile = ts.createSourceFile(
			filePath,
			content,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);

		// Extract functions and check for similarities
		const newFunctions = extractFunctions(sourceFile, content);

		const diagnostics: Diagnostic[] = [];

		for (const func of newFunctions) {
			// Guardrail: Skip tiny functions
			if (func.transitionCount < CONFIG.MIN_TRANSITIONS) {
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

interface ExtractedFunction {
	name: string;
	line: number;
	column: number;
	matrix: number[][];
	transitionCount: number;
	signature: string;
}

function extractFunctions(
	sourceFile: ts.SourceFile,
	_fullContent: string,
): ExtractedFunction[] {
	const functions: ExtractedFunction[] = [];

	function visit(node: ts.Node) {
		// Function declarations
		if (ts.isFunctionDeclaration(node) && node.name) {
			const { line, character } = sourceFile.getLineAndCharacterOfPosition(
				node.getStart(sourceFile),
			);
			const funcCode = getNodeText(node, sourceFile);
			const matrix = buildStateMatrix(funcCode);
			const transitionCount = countTransitions(matrix);

			functions.push({
				name: node.name.text,
				line: line + 1, // 1-indexed
				column: character + 1, // 1-indexed
				matrix,
				transitionCount,
				signature: getSignature(node),
			});
		}

		// Arrow functions assigned to const
		if (ts.isVariableStatement(node)) {
			extractArrowFunctions(node, functions, sourceFile);
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return functions;
}

function extractArrowFunctions(
	node: ts.VariableStatement,
	functions: ExtractedFunction[],
	sourceFile: ts.SourceFile,
): void {
	for (const decl of node.declarationList.declarations) {
		if (!ts.isIdentifier(decl.name) || !decl.initializer) {
			continue;
		}

		const func = decl.initializer;
		if (!ts.isArrowFunction(func) && !ts.isFunctionExpression(func)) {
			continue;
		}

		const { line, character } = sourceFile.getLineAndCharacterOfPosition(
			node.getStart(sourceFile),
		);
		const funcCode = getNodeText(func, sourceFile);
		const matrix = buildStateMatrix(funcCode);
		const transitionCount = countTransitions(matrix);

		functions.push({
			name: decl.name.text,
			line: line + 1,
			column: character + 1,
			matrix,
			transitionCount,
			signature: getArrowSignature(func),
		});
	}
}

function getNodeText(node: ts.Node, sourceFile: ts.SourceFile): string {
	return sourceFile.text.substring(node.getStart(sourceFile), node.getEnd());
}

function getSignature(node: ts.FunctionDeclaration): string {
	const params = node.parameters
		.map((p) => (ts.isIdentifier(p.name) ? p.name.text : "param"))
		.join(", ");
	return `(${params})`;
}

function getArrowSignature(
	node: ts.ArrowFunction | ts.FunctionExpression,
): string {
	const params = node.parameters
		.map((p) => (ts.isIdentifier(p.name) ? p.name.text : "param"))
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
	const parts = match.targetId.split(":");
	const file = parts[0];
	const name = parts[1] || match.targetName;
	const location = `${file}:1`; // TODO: get actual line

	return `Function '${func.name}' has ${similarityPct}% similarity to existing utility '${name}()' in ${location}. Consider reusing the existing utility.`;
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
	const { glob } = await import("glob");
	// Build ignore patterns from centralized EXCLUDED_DIRS
	const ignorePatterns = [
		...EXCLUDED_DIRS.map((d) => `**/${d}/**`),
		"**/*.test.ts",
		"**/*.spec.ts",
		"**/*.poc.test.ts",
	];
	const files = await glob("**/*.ts", {
		cwd: projectRoot,
		ignore: ignorePatterns,
	});

	if (files.length === 0) {
		return null;
	}

	const absoluteFiles = files.map((f) => path.join(projectRoot, f));
	const index = await buildProjectIndex(projectRoot, absoluteFiles);

	indexCache.set(projectRoot, index);
	return index;
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
