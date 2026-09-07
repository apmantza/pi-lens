/**
 * Codebase mental model — issue #155.
 *
 * Builds a compact structural summary of the codebase from the call graph:
 * top-N symbols by in-degree centrality, each with signature, calls, and
 * calledBy lists. Persisted to cache; never injected into agent context
 * until validated across several real sessions.
 *
 * This is intentionally internal-only. The one agent-facing surface is a
 * single dbg log line at session-start so quality can be assessed via
 * ~/.pi-lens/sessionstart.log before any agent exposure.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "./file-utils.js";
import { writeFileAtomic } from "./atomic-write.js";
import { parseSymbolKey } from "./call-graph.js";
import type { CallGraphCacheIdentity } from "./call-graph.js";
import { detectFileRole } from "./file-role.js";
import { isExternalOrVendorFile } from "./path-utils.js";
import { isBuildArtifact } from "./source-filter.js";
import type { FunctionCallGraph, SymbolKey } from "./call-graph.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ModelEntry {
	/** Relative file path. */
	file: string;
	/** Symbol name. */
	name: string;
	/** Approximate structural kind inferred from the symbol key. */
	kind: "function" | "method" | "class" | "unknown";
	/** Outgoing call names — top 10 by frequency. */
	calls: string[];
	/** Incoming caller names — top 10 by frequency. */
	calledBy: string[];
	/** Weighted in-degree (from call graph). */
	inDegree: number;
	/** Estimated token cost of this entry (~chars / 4). */
	tokens: number;
}

export interface CodebaseModel {
	version: typeof CODEBASE_MODEL_VERSION;
	/** Canonical review graph identity of the call graph this model projects. */
	reviewGraphVersion: string;
	reviewGraphSignature: string;
	generatedAt: string;
	totalSymbols: number;
	totalFiles: number;
	entries: ModelEntry[];
	totalTokens: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_CODEBASE_MODEL_TOKEN_BUDGET = 1500;
const MAX_CALLS_PER_SYMBOL = 10;
const MIN_IN_DEGREE = 0.5; // skip symbols with low centrality (avoids noise)

/** Persisted model schema version. Bump when the persisted shape changes. */
export const CODEBASE_MODEL_VERSION = 1;

// ── Builder ───────────────────────────────────────────────────────────────────

function inferKind(symbolKey: SymbolKey): ModelEntry["kind"] {
	const parsed = parseSymbolKey(symbolKey);
	if (parsed.kind === "class") return "class";
	if (parsed.kind === "method" || parsed.symbolName?.includes("."))
		return "method";
	return /^[A-Z]/.test(parsed.symbolName ?? "") ? "class" : "function";
}

function estimateTokens(entry: Omit<ModelEntry, "tokens">): number {
	const text = [
		entry.name,
		entry.file,
		entry.calls.join(","),
		entry.calledBy.join(","),
	].join(" ");
	return Math.ceil(text.length / 4) + 5; // +5 for structural overhead
}

/**
 * Build a codebase mental model from a function-level call graph.
 *
 * Selection: rank all symbols by weighted in-degree, then fill a token budget
 * from the top. Symbols below MIN_IN_DEGREE are skipped to avoid noise.
 *
 * @param graph   The session's FunctionCallGraph (must have inDegree populated).
 * @param cwd     Project root — used to compute relative file paths.
 * @param budget  Maximum total token budget (default 1500).
 */
export function buildCodebaseModel(
	graph: FunctionCallGraph,
	cwd: string,
	budget = DEFAULT_CODEBASE_MODEL_TOKEN_BUDGET,
	identity?: CallGraphCacheIdentity,
): CodebaseModel {
	// Standalone callers may build an unpersisted projection without the
	// review-graph coordinator. Persisted/session models pass the canonical
	// review-graph identity explicitly; this fallback is only a local call-graph
	// identity for builder-only use.
	const modelIdentity = identity ?? {
		reviewGraphVersion: graph.builtAt || "call-graph-unknown",
		reviewGraphSignature: graph.builtAt || "call-graph-unknown",
	};
	// Sort all callee keys by in-degree descending
	const ranked = [...graph.inDegree.entries()]
		.filter(([, score]) => score >= MIN_IN_DEGREE)
		.sort(([, a], [, b]) => b - a);

	const entries: ModelEntry[] = [];
	let totalTokens = 0;
	const seenNames = new Set<string>();

	for (const [calleeKey, inDegree] of ranked) {
		if (totalTokens >= budget) break;

		const parsedCallee = parseSymbolKey(calleeKey);
		const name = parsedCallee.symbolName ?? calleeKey;
		const filePath = parsedCallee.filePath;

		// Keep this projection aligned with the shared file-role policy. The
		// call graph is derived from the canonical review graph, so the model
		// carries that graph's identity rather than inventing a second freshness
		// policy.
		const fileRole = detectFileRole(filePath);
		if (
			fileRole === "test" ||
			fileRole === "generated" ||
			isExternalOrVendorFile(filePath, cwd) ||
			isBuildArtifact(filePath)
		) {
			continue;
		}

		// Deduplicate by name when the same function appears in multiple files
		if (seenNames.has(name)) continue;
		seenNames.add(name);

		const calls = [...(graph.callees.get(calleeKey) ?? new Set())]
			.map((k) => parseSymbolKey(k).symbolName ?? k)
			.filter(Boolean)
			.slice(0, MAX_CALLS_PER_SYMBOL);

		const calledBy = [...(graph.callers.get(calleeKey) ?? new Set())]
			.map((k) => parseSymbolKey(k).symbolName ?? k)
			.filter((n) => !n.startsWith("file:"))
			.slice(0, MAX_CALLS_PER_SYMBOL);

		const file = filePath
			? path.relative(cwd, filePath).replace(/\\/g, "/")
			: "unknown";

		const draft: Omit<ModelEntry, "tokens"> = {
			file,
			name,
			kind: inferKind(calleeKey),
			calls,
			calledBy,
			inDegree,
		};
		const tokens = estimateTokens(draft);

		if (totalTokens + tokens > budget) continue;

		entries.push({ ...draft, tokens });
		totalTokens += tokens;
	}

	const allFiles = new Set(
		[...graph.callers.keys(), ...graph.callees.keys()]
			.map((k) => parseSymbolKey(k).filePath)
			.filter(Boolean),
	);

	return {
		version: CODEBASE_MODEL_VERSION,
		reviewGraphVersion: modelIdentity.reviewGraphVersion,
		reviewGraphSignature: modelIdentity.reviewGraphSignature,
		generatedAt: new Date().toISOString(),
		totalSymbols: graph.inDegree.size,
		totalFiles: allFiles.size,
		entries,
		totalTokens,
	};
}

// ── Persistence ───────────────────────────────────────────────────────────────

function cacheFilePath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", "codebase-model.json");
}

function metaFilePath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", "codebase-model.meta.json");
}

export function saveCodebaseModel(cwd: string, model: CodebaseModel): void {
	const cacheFile = cacheFilePath(cwd);
	try {
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		writeFileAtomic(cacheFile, JSON.stringify(model));
		writeFileAtomic(
			metaFilePath(cwd),
			JSON.stringify({
				savedAt: new Date().toISOString(),
				entryCount: model.entries.length,
				totalTokens: model.totalTokens,
			}),
		);
	} catch {
		// Non-fatal — next session rebuilds.
	}
}

/** Load only a model matching the canonical identity it was derived from. */
export function loadCodebaseModel(
	cwd: string,
	expectedIdentity: CallGraphCacheIdentity,
): CodebaseModel | undefined {
	try {
		const raw = JSON.parse(
			fs.readFileSync(cacheFilePath(cwd), "utf-8"),
		) as Partial<CodebaseModel>;
		if (
			raw.version !== CODEBASE_MODEL_VERSION ||
			typeof raw.reviewGraphVersion !== "string" ||
			raw.reviewGraphVersion.length === 0 ||
			typeof raw.reviewGraphSignature !== "string" ||
			raw.reviewGraphSignature.length === 0 ||
			typeof raw.generatedAt !== "string" ||
			!Array.isArray(raw.entries)
		)
			return undefined;
		if (
			raw.reviewGraphVersion !== expectedIdentity.reviewGraphVersion ||
			raw.reviewGraphSignature !== expectedIdentity.reviewGraphSignature
		)
			return undefined;
		return raw as CodebaseModel;
	} catch {
		return undefined;
	}
}
