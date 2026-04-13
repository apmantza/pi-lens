/**
 * Similarity Runner: Detect semantic code reuse opportunities
 *
 * Uses Amain's 57×72 state matrix algorithm to find similar functions.
 * Integrated into dispatch flow as a warning (non-blocking) suggestion.
 */

import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import { NativeRustCoreClient } from "../../native-rust-client.js";
import { collectSourceFiles } from "../../source-filter.js";
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
import { PRIORITY } from "../priorities.js";

// Singleton Rust client — initialised once, reused across runner invocations.
const rustClient = new NativeRustCoreClient();

/** Feature flag: set to false to force the pure-TypeScript path. */
const USE_RUST = true;

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
	SIMILARITY_THRESHOLD: 0.96, // align with booboo: stricter to reduce boilerplate false positives
	MIN_TRANSITIONS: 40, // stronger signal floor for structural comparisons
	MIN_FUNCTION_LINES: 8, // Ignore tiny helpers/wrappers
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
		.replace(/[_\-]+/g, " ")
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length >= 3);
}

export function hasMeaningfulNameOverlap(sourceName: string, targetName: string): boolean {
	const source = new Set(tokenizeFunctionName(sourceName));
	const target = new Set(tokenizeFunctionName(targetName));
	const shared = [...source].filter((token) => target.has(token));
	if (shared.length === 0) return false;

	const specificShared = shared.filter((token) => !GENERIC_NAME_TOKENS.has(token));
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

		// Find project root and load index
		const projectRoot = await findProjectRoot(filePath);
		if (!projectRoot) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// ── Rust fast-path ─────────────────────────────────────────────────────
		// Try Rust for file scanning + similarity detection. If the Rust binary
		// is available, use it. On any failure, fall through to the pure-TS path.
		if (USE_RUST && rustClient.isAvailable()) {
			try {
				const rustResult = await runWithRust(
					filePath,
					projectRoot,
					CONFIG.SIMILARITY_THRESHOLD,
					CONFIG.MAX_SUGGESTIONS,
				);
				if (rustResult !== null) return rustResult;
			} catch {
				// Fall through to TypeScript implementation.
			}
		}
		// ── TypeScript fallback ─────────────────────────────────────────────────

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

				const maxTransitions = Math.max(func.transitionCount, match.targetTransitionCount);
				const minTransitions = Math.min(func.transitionCount, match.targetTransitionCount);
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
	sourceFile: ts.SourceFile,
	_fullContent: string,
): ExtractedFunction[] {
	const functions: ExtractedFunction[] = [];

	function visit(node: ts.Node) {
		// Function declarations
		if (ts.isFunctionDeclaration(node) && node.name) {
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
// Rust fast-path
// ============================================================================

/**
 * Run similarity detection via the Rust binary.
 *
 * Flow:
 * 1. Scan project files with Rust (respects .gitignore, much faster than glob).
 * 2. Build the Rust index (persisted to .pi-lens/rust-index.json).
 * 3. Query similarity for the current file.
 * 4. Convert matches to Diagnostics.
 *
 * Returns `null` if the Rust path cannot produce results (no matches is still
 * a valid result — returned as an empty-diagnostic RunnerResult).
 */
async function runWithRust(
	filePath: string,
	projectRoot: string,
	threshold: number,
	maxSuggestions: number,
): Promise<RunnerResult | null> {
	// 1. Scan project files.
	const scanned = await rustClient.scanProject(projectRoot, [".ts", ".tsx"]);
	if (scanned.length === 0) return null;

	const relativeFiles = scanned.map((e) =>
		path.relative(projectRoot, e.path).replace(/\\/g, "/"),
	);

	// 2. Build index (saves to .pi-lens/rust-index.json).
	await rustClient.buildIndex(projectRoot, relativeFiles);

	// 3. Find similarities for the current file.
	const matches = await rustClient.findSimilarities(
		projectRoot,
		filePath,
		threshold,
	);

	if (matches.length === 0) {
		return { status: "succeeded", diagnostics: [], semantic: "none" };
	}

	// 4. Convert to Diagnostics.
	const diagnostics: Diagnostic[] = [];
	const seenTargets = new Map<string, number>();
	for (const m of matches.slice(0, maxSuggestions)) {
			const similarityPct = Math.round(m.similarity * 100);
			// source_id / target_id format: "path/to/file.ts::funcName@line"
			const parseId = (id: string): { file: string; name: string; line: number } => {
				const m = id.match(/^(.*)::([^@]+)@(\d+)$/);
				if (!m) return { file: id, name: "?", line: 1 };
				return {
					file: m[1].replace(/\\/g, "/"),
					name: m[2],
					line: Number.parseInt(m[3], 10) || 1,
				};
			};
			const source = parseId(m.source_id);
			const target = parseId(m.target_id);
			if (!hasMeaningfulNameOverlap(source.name, target.name)) {
				continue;
			}
			const targetKey = `${target.name}@${target.file}:${target.line}`;
			const seenForTarget = seenTargets.get(targetKey) ?? 0;
			if (seenForTarget >= CONFIG.MAX_PER_TARGET_NAME) {
				continue;
			}
			seenTargets.set(targetKey, seenForTarget + 1);
			const resolvedTarget = path.isAbsolute(target.file)
				? target.file
				: path.join(projectRoot, target.file);
			if (!nodeFs.existsSync(resolvedTarget)) {
				continue;
			}
			diagnostics.push({
				id: `similarity-rust-${m.source_id}-${m.target_id}`,
				tool: "similarity",
				filePath,
				line: source.line,
				column: 1,
				message: `Function '${source.name}' has ${similarityPct}% similarity to '${target.name}()' at ${target.file}:${target.line}. Consider reusing it if behavior is equivalent.`,
				severity: "warning" as const,
				semantic: "warning" as const,
			});
	}

	return {
		status: "succeeded",
		diagnostics,
		semantic: diagnostics.length > 0 ? "warning" : "none",
	};
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
