/**
 * Project Index: Cache of state matrices for all utilities in the project
 *
 * Builds and maintains an index of exported functions for similarity detection.
 * Stores 57×72 state matrices keyed by function location.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import {
	buildStateMatrixFromFile,
	calculateSimilarity,
	countTransitions,
} from "./state-matrix.js";

// ============================================================================
// Types
// ============================================================================

export interface IndexEntry {
	id: string; // "utils/date.ts:formatDate"
	filePath: string; // Absolute path
	functionName: string; // "formatDate"
	signature: string; // "(date: Date, format: string) => string"
	matrix: number[][]; // 57×72 state matrix
	transitionCount: number; // For guardrail filtering
	lastModified: number; // mtime for cache invalidation
	exports: string[]; // All exports from file
}

export interface SimilarityMatch {
	targetId: string; // "utils/date.ts:formatDate"
	targetName: string; // "formatDate"
	targetLocation: string; // "utils/date.ts:42"
	similarity: number; // 0-100%
	signature: string; // Target function signature
	targetTransitionCount: number;
}

export interface ProjectIndex {
	version: string;
	createdAt: string;
	entries: Map<string, IndexEntry>; // key: id
}

// ============================================================================
// Index Builder
// ============================================================================

/**
 * Build project index by scanning TypeScript files
 */
export async function buildProjectIndex(
	projectRoot: string,
	filePaths: string[],
): Promise<ProjectIndex> {
	const entries = new Map<string, IndexEntry>();

	for (const filePath of filePaths) {
		if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) {
			continue;
		}

		try {
			const fileEntries = await indexFile(projectRoot, filePath);
			for (const entry of fileEntries) {
				entries.set(entry.id, entry);
			}
		} catch (error) {
			// pi-lens-ignore: missing-error-propagation — per-file indexing failure, skip unparseable files
			console.error(`Failed to index ${filePath}:`, error);
		}
	}

	return {
		version: "1.0",
		createdAt: new Date().toISOString(),
		entries,
	};
}

/**
 * Index a single TypeScript file
 */
async function indexFile(
	projectRoot: string,
	filePath: string,
): Promise<IndexEntry[]> {
	const entries: IndexEntry[] = [];
	const content = await fs.readFile(filePath, "utf-8");
	const stats = await fs.stat(filePath);

	const sourceFile = ts.createSourceFile(
		filePath,
		content,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	const relativePath = path.relative(projectRoot, filePath);
	const exports: string[] = [];

	// Find all exported functions
	function visit(node: ts.Node) {
		// Track all exports for reference
		if (ts.isExportDeclaration(node) || hasExportModifier(node)) {
			const name = getExportName(node);
			if (name) exports.push(name);
		}

		// Extract function declarations
		if (ts.isFunctionDeclaration(node) && node.name) {
			const functionName = node.name.text;
			const _isExported = hasExportModifier(node);

			// For now, index all named functions (we can filter to exports only later)
			const id = `${relativePath}:${functionName}`;

			// Build matrix just for this function's AST subtree
			const matrix = buildFunctionMatrix(node, sourceFile);
			const transitionCount = countTransitions(matrix);

			// Skip trivial functions (<20 transitions)
			if (transitionCount >= 20) {
				entries.push({
					id,
					filePath: relativePath,
					functionName,
					signature: getFunctionSignature(node),
					matrix,
					transitionCount,
					lastModified: stats.mtimeMs,
					exports,
				});
			}
		}

		// Arrow functions assigned to variables (const fn = () => {})
		if (ts.isVariableStatement(node)) {
			extractArrowFunctions(
				node,
				entries,
				relativePath,
				sourceFile,
				stats,
				exports,
			);
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return entries;
}

/**
 * Extract arrow functions and function expressions from variable declarations
 */
function extractArrowFunctions(
	node: ts.VariableStatement,
	entries: IndexEntry[],
	relativePath: string,
	sourceFile: ts.SourceFile,
	stats: { mtimeMs: number },
	exports: string[],
): void {
	for (const decl of node.declarationList.declarations) {
		if (!ts.isIdentifier(decl.name) || !decl.initializer) {
			continue;
		}

		const func = decl.initializer;
		if (!ts.isArrowFunction(func) && !ts.isFunctionExpression(func)) {
			continue;
		}

		const functionName = decl.name.text;
		const id = `${relativePath}:${functionName}`;

		const matrix = buildFunctionMatrix(func, sourceFile);
		const transitionCount = countTransitions(matrix);

		// Skip trivial functions (<20 transitions)
		if (transitionCount < 20) {
			continue;
		}

		entries.push({
			id,
			filePath: relativePath,
			functionName,
			signature: getArrowFunctionSignature(func),
			matrix,
			transitionCount,
			lastModified: stats.mtimeMs,
			exports,
		});
	}
}

/**
 * Build state matrix for a specific function node
 */
function buildFunctionMatrix(
	functionNode:
		| ts.FunctionDeclaration
		| ts.ArrowFunction
		| ts.FunctionExpression,
	sourceFile: ts.SourceFile,
): number[][] {
	// Extract just the function's code as text
	const start = functionNode.getStart(sourceFile);
	const end = functionNode.getEnd();
	const functionCode = sourceFile.text.substring(start, end);

	// Build matrix for just this function
	const funcSourceFile = ts.createSourceFile(
		"func.ts",
		functionCode,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	return buildStateMatrixFromFile(funcSourceFile);
}

// ============================================================================
// Utilities
// ============================================================================

function hasExportModifier(node: ts.Node): boolean {
	const modifiers = (node as ts.HasModifiers).modifiers;
	if (!modifiers) return false;
	return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function getExportName(node: ts.Node): string | null {
	if (ts.isFunctionDeclaration(node) && node.name) {
		return node.name.text;
	}
	if (ts.isVariableStatement(node)) {
		const decl = node.declarationList.declarations[0];
		if (ts.isIdentifier(decl.name)) {
			return decl.name.text;
		}
	}
	return null;
}

function getFunctionSignature(node: ts.FunctionDeclaration): string {
	const params = node.parameters
		.map((p) => {
			const name = ts.isIdentifier(p.name) ? p.name.text : "param";
			const type = p.type ? `:${sourceFileToString(p.type)}` : "";
			return `${name}${type}`;
		})
		.join(", ");

	const returnType = node.type ? ` => ${sourceFileToString(node.type)}` : "";
	return `(${params})${returnType}`;
}

function getArrowFunctionSignature(
	node: ts.ArrowFunction | ts.FunctionExpression,
): string {
	const params = node.parameters
		.map((p) => {
			const name = ts.isIdentifier(p.name) ? p.name.text : "param";
			const type = p.type ? `:${sourceFileToString(p.type)}` : "";
			return `${name}${type}`;
		})
		.join(", ");

	const returnType = node.type ? ` => ${sourceFileToString(node.type)}` : "";
	return `(${params})${returnType}`;
}

function sourceFileToString(node: ts.Node): string {
	// Simple stringify - just get the text
	const tempFile = ts.createSourceFile("temp.ts", "", ts.ScriptTarget.Latest);
	const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
	return printer.printNode(ts.EmitHint.Unspecified, node, tempFile).trim();
}

// ============================================================================
// Similarity Queries
// ============================================================================

/**
 * Find similar functions in the index
 */
export function findSimilarFunctions(
	matrix: number[][],
	index: ProjectIndex,
	threshold = 0.75,
	maxResults = 3,
): SimilarityMatch[] {
	const matches: SimilarityMatch[] = [];

	for (const entry of index.entries.values()) {
		const similarity = calculateSimilarity(matrix, entry.matrix);

		if (similarity >= threshold) {
			matches.push({
				targetId: entry.id,
				targetName: entry.functionName,
				targetLocation: `${entry.filePath}:1`, // TODO: get actual line
				similarity,
				signature: entry.signature,
				targetTransitionCount: entry.transitionCount,
			});
		}
	}

	// Sort by similarity descending, take top N
	return matches
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, maxResults);
}

// ============================================================================
// Persistence
// ============================================================================

const INDEX_FILE = ".pi-lens/index.json";

/**
 * Save index to disk
 */
export async function saveIndex(
	index: ProjectIndex,
	projectRoot: string,
): Promise<void> {
	const indexPath = path.join(projectRoot, INDEX_FILE);
	await fs.mkdir(path.dirname(indexPath), { recursive: true });

	// Convert Map to array for JSON serialization
	const serialized = {
		version: index.version,
		createdAt: index.createdAt,
		entries: Array.from(index.entries.entries()),
	};

	await fs.writeFile(indexPath, JSON.stringify(serialized, null, 2));
}

/**
 * Load index from disk
 */
export async function loadIndex(
	projectRoot: string,
): Promise<ProjectIndex | null> {
	const indexPath = path.join(projectRoot, INDEX_FILE);

	try {
		const data = await fs.readFile(indexPath, "utf-8");
		const parsed = JSON.parse(data);

		return {
			version: parsed.version,
			createdAt: parsed.createdAt,
			entries: new Map(parsed.entries),
		};
	} catch {
		return null;
	}
}

/**
 * Check if index exists and is fresh (<24 hours old)
 */
export async function isIndexFresh(projectRoot: string): Promise<boolean> {
	const index = await loadIndex(projectRoot);
	if (!index) return false;

	const createdAt = new Date(index.createdAt).getTime();
	const age = Date.now() - createdAt;
	const maxAge = 24 * 60 * 60 * 1000; // 24 hours

	return age < maxAge;
}
