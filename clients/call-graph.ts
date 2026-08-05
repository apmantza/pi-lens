/**
 * Cross-file call graph — Sections 1, 2 & 3 of issue #154.
 *
 * Builds a bidirectional function-level call graph by resolving symbol
 * references across files. Provides BFS impact analysis with severity tiers.
 * Uses the Symbol/SymbolRef data produced by TreeSitterSymbolExtractor and
 * persists the result under the canonical review-graph identity; freshness is
 * owned exclusively by the review-graph snapshot.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "./file-utils.js";
import { parseSymbolKey as parseCanonicalSymbolKey } from "./review-graph/symbol-id.js";
import { normalizeMapKey, toProjectRelativePath } from "./path-utils.js";
import type {
	Symbol,
	SymbolRef,
	SymbolResolution,
} from "./symbol-types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Unique key for a symbol: `normalizedFilePath:symbolName` */
export type SymbolKey = string;

export type CallGraphResolution = SymbolResolution;
export type CallGraphEvidenceKind = "calls" | "references" | "mixed";

export interface CallGraphEvidenceCoverage {
	/** Number of raw evidence records, including records folded into duplicates. */
	totalEvidence: number;
	callsEvidence: number;
	referencesEvidence: number;
	eligibleEvidence: number;
	resolvedEvidence: number;
	unresolvedEvidence: number;
	typeOnlyEvidence: number;
	unsupportedEvidence: number;
	/** Resolved same-file evidence intentionally omitted from this cross-file projection. */
	sameFileEvidence: number;
	/** Raw evidence records beyond the first for each logical caller→callee edge. */
	duplicateEvidence: number;
	/** False for capped/in-progress graphs or incomplete extractor queries. */
	complete: boolean;
	/** Per-language evidence/query coverage, when supplied by the graph adapter. */
	languages?: Record<string, "complete" | "partial" | "unavailable">;
}

export interface ResolvedCallEdge {
	callerFile: string;
	/** Name of the enclosing function/method in the caller file, if found. */
	callerSymbol?: string;
	callerKey: SymbolKey;
	callerKind?: string;
	callerLine?: number;
	callerColumn?: number;
	calleeFile: string;
	calleeSymbol: string;
	calleeKey: SymbolKey;
	calleeKind?: string;
	calleeLine?: number;
	calleeColumn?: number;
	/** Evidence source; `mixed` means duplicate logical evidence from both paths. */
	evidenceKind?: CallGraphEvidenceKind;
	resolution?: CallGraphResolution;
	/** Number of raw evidence records folded into this deduplicated adjacency edge. */
	evidenceCount?: number;
	/**
	 * 1.0 / candidateCount — discounts edges where the callee name is
	 * ambiguous (multiple defs with the same name in the project).
	 */
	weight: number;
}

export interface FunctionCallGraph {
	/** caller symbolKey → Set of callee symbolKeys */
	callees: Map<SymbolKey, Set<SymbolKey>>;
	/** callee symbolKey → Set of caller symbolKeys */
	callers: Map<SymbolKey, Set<SymbolKey>>;
	/** Resolved logical edges; duplicate evidence is represented by evidenceCount. */
	edges: ResolvedCallEdge[];
	/** Weighted in-degree for ranking (higher = more-called, more central) */
	inDegree: Map<SymbolKey, number>;
	unresolvedRefs: number;
	totalRefs: number;
	coverage?: CallGraphEvidenceCoverage;
	builtAt: string;
}

// ── Serialisable form for disk persistence ────────────────────────────────────

export interface CallGraphCacheIdentity {
	reviewGraphVersion: string;
	reviewGraphSignature: string;
}

interface PersistedCallGraph {
	version: 5;
	builtAt: string;
	/** The canonical review graph this projection was derived from. */
	reviewGraphVersion?: string;
	reviewGraphSignature?: string;
	edges: ResolvedCallEdge[];
	callees: [SymbolKey, SymbolKey[]][];
	callers: [SymbolKey, SymbolKey[]][];
	inDegree: [SymbolKey, number][];
	/** Added after the first cache format; optional for legacy snapshots. */
	totalRefs?: number;
	unresolvedRefs?: number;
	coverage?: CallGraphEvidenceCoverage;
}

const CACHE_VERSION = 5;

// ── Section 3: BFS impact analysis ───────────────────────────────────────────

export type ImpactSeverity = "WillBreak" | "MayBreak" | "Review";

export interface ImpactResult {
	/** The affected symbol key. */
	symbolKey: SymbolKey;
	/** BFS depth from the changed symbol (1 = direct caller). */
	depth: number;
	/** Severity tier based on depth. */
	severity: ImpactSeverity;
}

function severityForDepth(depth: number): ImpactSeverity {
	if (depth === 1) return "WillBreak";
	if (depth === 2) return "MayBreak";
	return "Review";
}

/**
 * BFS upstream through the callers map from `startKey`.
 *
 * Returns all symbols that would be affected if `startKey` changes,
 * classified by severity:
 *   depth 1 → WillBreak (direct callers)
 *   depth 2 → MayBreak  (callers of callers)
 *   depth 3+ → Review   (transitive)
 *
 * @param maxDepth  Limit traversal depth (default 3 — Review tier cutoff).
 * @param minWeight Only follow edges with weight ≥ this threshold (default 0.1).
 *                  Filters out highly ambiguous name resolutions.
 */
export function impact(
	graph: FunctionCallGraph,
	startKey: SymbolKey,
	maxDepth = 3,
	minWeight = 0.1,
): ImpactResult[] {
	const results: ImpactResult[] = [];
	const visited = new Set<SymbolKey>([startKey]);
	const queue: Array<{ key: SymbolKey; depth: number }> = [{ key: startKey, depth: 0 }];

	// Build a weight lookup from edges for filtering
	const edgeWeightMap = new Map<string, number>();
	for (const edge of graph.edges) {
		const edgeKey = `${edge.calleeKey}→${edge.callerKey}`;
		const existing = edgeWeightMap.get(edgeKey) ?? 0;
		edgeWeightMap.set(edgeKey, Math.max(existing, edge.weight));
	}

	while (queue.length > 0) {
		const item = queue.shift()!;
		if (item.depth >= maxDepth) continue;

		const directCallers = graph.callers.get(item.key);
		if (!directCallers) continue;

		for (const callerKey of directCallers) {
			if (visited.has(callerKey)) continue;

			// Check edge weight — skip highly ambiguous resolutions
			const edgeKey = `${item.key}→${callerKey}`;
			const weight = edgeWeightMap.get(edgeKey) ?? 1.0;
			if (weight < minWeight) continue;

			visited.add(callerKey);
			const depth = item.depth + 1;
			results.push({ symbolKey: callerKey, depth, severity: severityForDepth(depth) });
			queue.push({ key: callerKey, depth });
		}
	}

	// Sort by depth then symbolKey for stable output
	return results.sort((a, b) => a.depth - b.depth || a.symbolKey.localeCompare(b.symbolKey));
}

/**
 * Splits a `SymbolKey` into its file and symbol-name parts. Two shapes exist
 * (see `buildCallGraph` above): the normal `"filePath:symbolName"` form, and
 * the file-level fallback `"file:filePath"` used when no enclosing symbol was
 * found for a call site (module-level code). Splitting at the LAST colon
 * (rather than a naive `split(":")`) means a Windows drive letter in
 * `filePath` (`C:\...`) is never mistaken for the name/file separator; the
 * `"file:"` fallback is matched as a literal prefix first so it isn't
 * misparsed by the same last-colon rule.
 */
export function parseSymbolKey(key: SymbolKey, knownFilePath?: string): {
	filePath: string;
	symbolName?: string;
	kind?: string;
	line?: number;
} {
	return parseCanonicalSymbolKey(key, knownFilePath);
}

/**
 * Format an impact result set as a compact human-readable summary.
 * Example: "handleToolResult (WillBreak) → handleAgentEnd (MayBreak) → 3 Review callers"
 */
export function formatImpact(results: ImpactResult[], projectRoot: string): string {
	if (results.length === 0) return "";

	const willBreak = results.filter((r) => r.severity === "WillBreak");
	const mayBreak = results.filter((r) => r.severity === "MayBreak");
	const review = results.filter((r) => r.severity === "Review");

	const parts: string[] = [];

	const label = (r: ImpactResult) => {
		const parsed = parseSymbolKey(r.symbolKey);
		const name = parsed.symbolName ?? r.symbolKey;
		const file = toProjectRelativePath(parsed.filePath, projectRoot);
		return file ? `${name} (${file})` : name;
	};

	if (willBreak.length > 0) {
		parts.push(willBreak.slice(0, 3).map((r) => `${label(r)} ⚠ WillBreak`).join(", "));
	}
	if (mayBreak.length > 0) {
		parts.push(mayBreak.slice(0, 2).map((r) => `${label(r)} MayBreak`).join(", "));
	}
	if (review.length > 0) {
		parts.push(`${review.length} Review caller${review.length === 1 ? "" : "s"}`);
	}

	return parts.join(" → ");
}

// ── Stdlib / builtin noise filter ─────────────────────────────────────────────

/**
 * Common stdlib / builtin names that appear in call sites but never resolve
 * to project-defined symbols. Filtering them cuts noise significantly.
 */
const STDLIB_NAMES = new Set([
	// JS/TS
	"console", "Math", "Object", "Array", "String", "Number", "Boolean",
	"Promise", "Error", "Map", "Set", "WeakMap", "WeakSet", "JSON", "Date",
	"RegExp", "Symbol", "BigInt", "parseInt", "parseFloat", "isNaN",
	"isFinite", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
	"fetch", "URL", "URLSearchParams", "Buffer", "process", "require",
	// Python
	"print", "len", "range", "list", "dict", "str", "int", "float", "bool",
	"open", "isinstance", "issubclass", "type", "super", "hasattr", "getattr",
	"setattr", "enumerate", "zip", "map", "filter", "sorted", "reversed",
	// Go
	"fmt", "log", "os", "io", "err", "make", "append", "len", "cap", "copy",
	"close", "delete", "panic", "recover", "new",
	// Rust
	"println", "eprintln", "print", "eprint", "vec", "Some", "None", "Ok", "Err",
	"Box", "Rc", "Arc", "String", "Vec", "HashMap", "HashSet", "format",
	// Java/Kotlin
	"System", "println", "toString", "equals", "hashCode", "Objects",
	// Generic
	"new", "this", "self", "super", "nil", "null", "undefined", "true", "false",
]);

// ── Core resolution ────────────────────────────────────────────────────────────

/**
 * Build def index: symbol name → list of SymbolKeys that define it.
 * Exported symbols and all symbols are indexed; the ambiguity weight
 * discounts edges when many files define the same name.
 */
function buildDefIndex(
	allSymbols: Map<string, Symbol[]>,
): { byName: Map<string, SymbolKey[]>; byId: Map<SymbolKey, Symbol> } {
	const byName = new Map<string, SymbolKey[]>();
	const byId = new Map<SymbolKey, Symbol>();
	for (const [, symbols] of allSymbols) {
		for (const sym of symbols) {
			if (!sym.name || !sym.id) continue;
			const key: SymbolKey = sym.id;
			byId.set(key, sym);
			const existing = byName.get(sym.name) ?? [];
			if (!existing.includes(key)) existing.push(key);
			byName.set(sym.name, existing);
		}
	}
	return { byName, byId };
}

/**
 * Find the enclosing function/method for a ref at `refLine`. A symbol with
 * an end line is eligible only while the reference is inside its inclusive
 * source range; symbols without an end line retain the conservative start-line
 * fallback. Returns undefined when no symbol encloses the reference so callers
 * can use the file-level module key.
 */
function findEnclosingSymbol(
	symbols: Symbol[],
	refLine: number,
): Symbol | undefined {
	let best: Symbol | undefined;
	for (const sym of symbols) {
		if (
			sym.line <= refLine &&
			(sym.endLine === undefined || refLine <= sym.endLine) &&
			(sym.kind === "function" || sym.kind === "method")
		) {
			if (!best || sym.line > best.line) best = sym;
		}
	}
	return best;
}

/**
 * Build the function-level call graph from normalized review-graph evidence.
 *
 * The adapter supplies canonical target ids for graph evidence. Such evidence
 * is accepted only when it points at a concrete symbol and has a non-ambiguous
 * resolution. The old name-only path remains for legacy SymbolRef callers, but
 * it is deliberately not used by the review-graph adapter (#1070).
 */
export function buildCallGraph(
	allSymbols: Map<string, Symbol[]>,
	allRefs: Map<string, SymbolRef[]>,
	inputCoverage?: CallGraphEvidenceCoverage,
): FunctionCallGraph {
	const defIndex = buildDefIndex(allSymbols);
	const callees = new Map<SymbolKey, Set<SymbolKey>>();
	const callers = new Map<SymbolKey, Set<SymbolKey>>();
	const inDegree = new Map<SymbolKey, number>();
	const edgeByPair = new Map<string, ResolvedCallEdge>();
	let unresolvedRefs = 0;
	let totalRefs = 0;
	const hasInputCoverage = inputCoverage !== undefined;
	const coverage: CallGraphEvidenceCoverage = inputCoverage
		? { ...inputCoverage }
		: {
				totalEvidence: 0,
				callsEvidence: 0,
				referencesEvidence: 0,
				eligibleEvidence: 0,
				resolvedEvidence: 0,
				unresolvedEvidence: 0,
				typeOnlyEvidence: 0,
				unsupportedEvidence: 0,
				sameFileEvidence: 0,
				duplicateEvidence: 0,
				complete: false,
			 };

	for (const [callerFile, refs] of allRefs) {
		const callerSymbols = allSymbols.get(callerFile) ?? [];
		for (const ref of refs) {
			totalRefs++;
			if (!hasInputCoverage) {
				// Legacy callers do not carry an evidenceKind, but each ref is still
				// raw call-graph evidence and must contribute to coverage totals.
				coverage.totalEvidence++;
				if (ref.evidenceKind === "references" || ref.referenceKind === "type") coverage.referencesEvidence++;
				else coverage.callsEvidence++;
			}
			if (ref.referenceKind === "type") {
				if (!hasInputCoverage) coverage.typeOnlyEvidence++;
				continue;
			}
			if (ref.evidenceKind && ref.referenceKind !== "call") {
				if (!hasInputCoverage) coverage.unsupportedEvidence++;
				continue;
			}

			const candidates: Array<{
				callee: Symbol;
				resolution: SymbolResolution;
				candidateCount: number;
			}> = [];
			if (ref.targetId) {
				// Canonical graph identity is authoritative. Never recover a name by
				// splitting an id: symbol ids contain kind and line components.
				const callee = defIndex.byId.get(ref.targetId);
				if (!callee || ref.resolution === "name-only" || ref.resolution === "unresolved") {
					if (!hasInputCoverage) {
						unresolvedRefs++;
						coverage.unresolvedEvidence++;
					}
					continue;
				}
				candidates.push({
					callee,
					resolution: ref.resolution ?? "exact",
					candidateCount: 1,
				});
			} else {
				// Compatibility for pre-#1070 callers that supplied only name refs.
				// There is no typed/import evidence to select one definition, so retain
				// every cross-file candidate and discount each edge. Picking [0] made
				// graph iteration order decide which caller was reported.
				const refName = ref.symbolName ?? parseSymbolKey(ref.symbolId, callerFile).symbolName ?? "";
				if (STDLIB_NAMES.has(refName) || !refName) {
					if (!hasInputCoverage) coverage.unsupportedEvidence++;
					continue;
				}
				const defs = defIndex.byName.get(refName);
				if (!defs || defs.length === 0) {
					if (!hasInputCoverage) {
						unresolvedRefs++;
						coverage.unresolvedEvidence++;
					}
					continue;
				}
				const crossFileDefs = defs
					.map((id) => defIndex.byId.get(id))
					.filter((candidate): candidate is Symbol =>
						candidate !== undefined && candidate.filePath !== callerFile,
					);
				if (crossFileDefs.length === 0) {
					if (!hasInputCoverage) coverage.unsupportedEvidence++;
					continue;
				}
				const resolution: SymbolResolution = crossFileDefs.length === 1 ? "exact" : "name-only";
				for (const callee of crossFileDefs) {
					candidates.push({ callee, resolution, candidateCount: crossFileDefs.length });
				}
			}

			if (ref.evidenceKind && candidates.some(({ resolution }) => resolution === "name-only")) {
				if (!hasInputCoverage) {
					unresolvedRefs++;
					coverage.unresolvedEvidence++;
				}
				continue;
			}
			const caller = ref.callerSymbolId
				? defIndex.byId.get(ref.callerSymbolId)
				: undefined;
			const enclosing = caller ?? findEnclosingSymbol(callerSymbols, ref.line);
			const callerKey: SymbolKey = enclosing?.id ?? `file:${callerFile}`;
			let producedEdge = false;
			let duplicateRef = false;
			for (const { callee, resolution, candidateCount } of candidates) {
				if (normalizeMapKey(callee.filePath) === normalizeMapKey(callerFile)) {
					// This projection is intentionally cross-file-only. A canonical
					// same-file target is resolved by the source graph, but is represented
					// by an explicit coverage category rather than as unsupported evidence.
					// That keeps the projection contract while allowing complete coverage
					// to gate user-facing cross-file impact honestly.
					coverage.sameFileEvidence++;
					if (hasInputCoverage) {
						coverage.eligibleEvidence--;
						coverage.resolvedEvidence--;
					}
					continue;
				}
				producedEdge = true;
				const pairKey = `${callerKey}\u0000${callee.id}`;
				const existing = edgeByPair.get(pairKey);
				if (existing) {
					existing.evidenceCount = (existing.evidenceCount ?? 1) + 1;
					existing.evidenceKind = existing.evidenceKind === ref.evidenceKind
						? existing.evidenceKind
						: "mixed";
					// Duplicate evidence is a property of the logical pair, not of
					// whether the producer happened to tag the record. Keep the edge,
					// coverage, and centrality views consistent for legacy refs too.
					duplicateRef = true;
					continue;
				}

				const weight = ref.evidenceKind ? 1 : 1 / Math.max(1, candidateCount);
				const edge: ResolvedCallEdge = {
					callerFile,
					callerSymbol: enclosing?.name,
					callerKey,
					callerKind: enclosing?.kind,
					callerLine: enclosing?.line,
					callerColumn: enclosing?.column,
					calleeFile: callee.filePath,
					calleeSymbol: callee.name,
					calleeKey: callee.id,
					calleeKind: callee.kind,
					calleeLine: callee.line,
					calleeColumn: callee.column,
					evidenceKind: ref.evidenceKind,
					resolution,
					evidenceCount: 1,
					weight,
				};
				edgeByPair.set(pairKey, edge);

				const callerCallees = callees.get(callerKey) ?? new Set<SymbolKey>();
				callerCallees.add(callee.id);
				callees.set(callerKey, callerCallees);
				const calleeCallers = callers.get(callee.id) ?? new Set<SymbolKey>();
				calleeCallers.add(callerKey);
				callers.set(callee.id, calleeCallers);
				inDegree.set(callee.id, (inDegree.get(callee.id) ?? 0) + weight);
			}
			if (!hasInputCoverage && producedEdge) {
				// Legacy name-only ambiguity can fan one raw record out to several
				// weighted edges. Coverage remains a count of raw records, so account
				// for eligibility and duplicates once per reference, not once per
				// candidate edge.
				coverage.eligibleEvidence++;
				coverage.resolvedEvidence++;
				if (duplicateRef) coverage.duplicateEvidence++;
			}
			if (hasInputCoverage && producedEdge && duplicateRef) coverage.duplicateEvidence++;
		}
	}

	// With adapter-supplied coverage, totalRefs is the raw evidence count. Some
	// raw records (for example an external node with no caller file) cannot be
	// represented in allRefs, but they must not disappear from accounting.
	if (hasInputCoverage) totalRefs = coverage.totalEvidence;
	const languagesKnownComplete = Object.values(coverage.languages ?? {}).every(
		(status) => status === "complete",
	);
	coverage.complete = coverage.complete && hasInputCoverage &&
		coverage.unsupportedEvidence === 0 && languagesKnownComplete &&
		(allSymbols.size > 0 || coverage.totalEvidence > 0);

	return {
		callees,
		callers,
		inDegree,
		edges: [...edgeByPair.values()],
		unresolvedRefs: hasInputCoverage ? coverage.unresolvedEvidence : unresolvedRefs,
		totalRefs,
		coverage,
		builtAt: new Date().toISOString(),
	};
}

// ── Persistence ────────────────────────────────────────────────────────────────

function cacheFilePath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", "call-graph.json");
}

function metaFilePath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "cache", "call-graph.meta.json");
}

/**
 * Persist a call-graph projection. Current callers pass the canonical
 * review-graph identity. There is deliberately no independent file/mtime
 * freshness argument: callers must use the review graph's canonical identity.
 */
export function saveCallGraph(
	cwd: string,
	graph: FunctionCallGraph,
	identity: CallGraphCacheIdentity,
): void;
export function saveCallGraph(
	cwd: string,
	graph: FunctionCallGraph,
	identity: CallGraphCacheIdentity,
): void {
	const cacheFile = cacheFilePath(cwd);
	const metaFile = metaFilePath(cwd);
	try {
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		const persisted: PersistedCallGraph = {
			version: CACHE_VERSION,
			builtAt: graph.builtAt,
			...(identity ? {
				reviewGraphVersion: identity.reviewGraphVersion,
				reviewGraphSignature: identity.reviewGraphSignature,
			} : {}),
			edges: graph.edges,
			callees: [...graph.callees.entries()].map(([k, v]) => [k, [...v]]),
			callers: [...graph.callers.entries()].map(([k, v]) => [k, [...v]]),
			inDegree: [...graph.inDegree.entries()],
			totalRefs: graph.totalRefs,
			unresolvedRefs: graph.unresolvedRefs,
			coverage: graph.coverage,
		};
		fs.writeFileSync(cacheFile, JSON.stringify(persisted), "utf-8");
		fs.writeFileSync(
			metaFile,
			JSON.stringify({ savedAt: new Date().toISOString(), edgeCount: graph.edges.length }),
			"utf-8",
		);
	} catch {
		// Non-fatal — next session rebuilds from scratch.
	}
}

function inferLegacyCoverage(edges: ResolvedCallEdge[]): CallGraphEvidenceCoverage {
	let weightedTotalEvidence = 0;
	let weightedReferencesEvidence = 0;
	let weightedDuplicateEvidence = 0;
	for (const edge of edges) {
		const count = Number.isFinite(edge.evidenceCount) && (edge.evidenceCount ?? 0) > 0
			? Math.floor(edge.evidenceCount as number)
			: 1;
		const weight = Number.isFinite(edge.weight) && edge.weight >= 0 ? edge.weight : 1;
		weightedTotalEvidence += count * weight;
		weightedDuplicateEvidence += Math.max(0, count - 1) * weight;
		if (edge.evidenceKind === "references") weightedReferencesEvidence += count * weight;
	}
	const totalEvidence = Math.max(0, Math.round(weightedTotalEvidence));
	const referencesEvidence = Math.max(0, Math.round(weightedReferencesEvidence));
	const duplicateEvidence = Math.max(0, Math.round(weightedDuplicateEvidence));
	return {
		totalEvidence,
		callsEvidence: totalEvidence - referencesEvidence,
		referencesEvidence,
		eligibleEvidence: totalEvidence,
		resolvedEvidence: totalEvidence,
		unresolvedEvidence: 0,
		typeOnlyEvidence: 0,
		unsupportedEvidence: 0,
		sameFileEvidence: 0,
		duplicateEvidence,
		// A legacy graph can still be queried, but it cannot prove that the old
		// extractor covered every source/reference kind.
		complete: false,
	};
}

function loadCoverage(
	rawCoverage: Partial<CallGraphEvidenceCoverage> | undefined,
	edges: ResolvedCallEdge[],
): CallGraphEvidenceCoverage {
	const inferred = inferLegacyCoverage(edges);
	return rawCoverage
		? {
				...inferred,
				...rawCoverage,
			}
		: inferred;
}

function finiteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function countsMatch(left: number, right: number): boolean {
	return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function validatePersistedCallGraph(
	raw: PersistedCallGraph,
	coverage: CallGraphEvidenceCoverage,
): boolean {
	const nonEmptyString = (value: unknown): value is string =>
		typeof value === "string" && value.trim().length > 0;
	const enumValue = <T extends string>(value: unknown, values: readonly T[]): value is T =>
		typeof value === "string" && values.includes(value as T);
	const edgeKinds = ["calls", "references", "mixed"] as const;
	const resolutions = ["exact", "import", "receiver-type", "name-only", "unresolved"] as const;
	if (!raw || raw.version !== CACHE_VERSION || !nonEmptyString(raw.builtAt)) return false;
	if (!nonEmptyString(raw.reviewGraphVersion) || !nonEmptyString(raw.reviewGraphSignature)) return false;
	if (raw.coverage !== undefined &&
		(!raw.coverage || typeof raw.coverage !== "object" || Array.isArray(raw.coverage))) return false;
	if (!Array.isArray(raw.edges) || !Array.isArray(raw.callees) || !Array.isArray(raw.callers) || !Array.isArray(raw.inDegree)) return false;
	const coverageValues = [
		coverage.totalEvidence,
		coverage.callsEvidence,
		coverage.referencesEvidence,
		coverage.eligibleEvidence,
		coverage.resolvedEvidence,
		coverage.unresolvedEvidence,
		coverage.typeOnlyEvidence,
		coverage.unsupportedEvidence,
		coverage.sameFileEvidence,
		coverage.duplicateEvidence,
	];
	if (typeof coverage.complete !== "boolean" || coverageValues.some((value) => !finiteCount(value))) return false;
	if (coverage.languages !== undefined &&
		(!coverage.languages || typeof coverage.languages !== "object" || Array.isArray(coverage.languages) ||
		Object.entries(coverage.languages).some(([language, status]) =>
			!nonEmptyString(language) || !enumValue(status, ["complete", "partial", "unavailable"] as const)))) return false;
	if (coverage.callsEvidence + coverage.referencesEvidence !== coverage.totalEvidence) return false;
	if (coverage.resolvedEvidence > coverage.eligibleEvidence) return false;
	if (coverage.eligibleEvidence !== coverage.resolvedEvidence) return false;
	if (coverage.resolvedEvidence + coverage.unresolvedEvidence + coverage.typeOnlyEvidence + coverage.unsupportedEvidence + coverage.sameFileEvidence !== coverage.totalEvidence) return false;
	if (coverage.complete && coverage.unsupportedEvidence > 0) return false;
	if (coverage.complete && Object.values(coverage.languages ?? {}).some((status) => status !== "complete")) return false;

	const expectedCallees = new Map<string, Set<string>>();
	const expectedCallers = new Map<string, Set<string>>();
	const expectedInDegree = new Map<string, number>();
	const pairKeys = new Set<string>();
	let weightedEdgeEvidence = 0;
	let weightedDuplicateEvidence = 0;
	for (const edge of raw.edges) {
		if (!edge || typeof edge !== "object" || !nonEmptyString(edge.callerKey) || !nonEmptyString(edge.calleeKey) ||
			!nonEmptyString(edge.callerFile) || !nonEmptyString(edge.calleeFile) ||
			!nonEmptyString(edge.calleeSymbol) || typeof edge.weight !== "number" || !Number.isFinite(edge.weight) || edge.weight <= 0 || edge.weight > 1) return false;
		if (edge.callerSymbol !== undefined && !nonEmptyString(edge.callerSymbol)) return false;
		if (edge.callerKind !== undefined && !nonEmptyString(edge.callerKind)) return false;
		if (edge.calleeKind !== undefined && !nonEmptyString(edge.calleeKind)) return false;
		if (edge.evidenceKind !== undefined && !enumValue(edge.evidenceKind, edgeKinds)) return false;
		if (edge.resolution !== undefined && !enumValue(edge.resolution, resolutions)) return false;
		if (edge.evidenceCount !== undefined && (!finiteCount(edge.evidenceCount) || edge.evidenceCount < 1)) return false;
		const evidenceCount = edge.evidenceCount ?? 1;
		const callerIdentity = parseCanonicalSymbolKey(edge.callerKey, edge.callerFile);
		const calleeIdentity = parseCanonicalSymbolKey(edge.calleeKey, edge.calleeFile);
		if (normalizeMapKey(callerIdentity.filePath) !== normalizeMapKey(edge.callerFile) ||
			normalizeMapKey(calleeIdentity.filePath) !== normalizeMapKey(edge.calleeFile) ||
			(calleeIdentity.symbolName !== undefined && calleeIdentity.symbolName !== edge.calleeSymbol) ||
			(callerIdentity.symbolName !== undefined && edge.callerSymbol !== undefined && callerIdentity.symbolName !== edge.callerSymbol)) return false;
		const pair = `${edge.callerKey}\u0000${edge.calleeKey}`;
		if (pairKeys.has(pair)) return false;
		pairKeys.add(pair);
		// Ambiguous legacy name-only evidence may fan one raw record out to
		// multiple weighted edges. Weight the persisted evidence back to raw
		// records so semantic validation agrees with coverage accounting.
		weightedEdgeEvidence += evidenceCount * edge.weight;
		weightedDuplicateEvidence += (evidenceCount - 1) * edge.weight;
		const callees = expectedCallees.get(edge.callerKey) ?? new Set<string>();
		callees.add(edge.calleeKey);
		expectedCallees.set(edge.callerKey, callees);
		const callers = expectedCallers.get(edge.calleeKey) ?? new Set<string>();
		callers.add(edge.callerKey);
		expectedCallers.set(edge.calleeKey, callers);
		expectedInDegree.set(edge.calleeKey, (expectedInDegree.get(edge.calleeKey) ?? 0) + edge.weight);
	}
	if (!countsMatch(weightedEdgeEvidence, coverage.resolvedEvidence)) return false;
	if (!countsMatch(weightedDuplicateEvidence, coverage.duplicateEvidence)) return false;
	if (!countsMatch(
		coverage.totalEvidence,
		weightedEdgeEvidence + coverage.unresolvedEvidence + coverage.typeOnlyEvidence + coverage.unsupportedEvidence + coverage.sameFileEvidence,
	)) return false;
	if (raw.totalRefs !== undefined && !finiteCount(raw.totalRefs)) return false;
	if (raw.unresolvedRefs !== undefined && !finiteCount(raw.unresolvedRefs)) return false;
	if (raw.totalRefs !== undefined && raw.totalRefs !== coverage.totalEvidence) return false;
	if (raw.unresolvedRefs !== undefined && raw.unresolvedRefs !== coverage.unresolvedEvidence) return false;

	const readAdjacency = (entries: unknown): Map<string, Set<string>> | undefined => {
		const result = new Map<string, Set<string>>();
		if (!Array.isArray(entries)) return undefined;
		for (const entry of entries) {
			if (!Array.isArray(entry) || !nonEmptyString(entry[0]) || !Array.isArray(entry[1]) || entry[1].some((key) => !nonEmptyString(key))) return undefined;
			const keys = entry[1] as string[];
			if (new Set(keys).size !== keys.length || result.has(entry[0])) return undefined;
			result.set(entry[0], new Set(keys));
		}
		return result;
	};
	const actualCallees = readAdjacency(raw.callees);
	const actualCallers = readAdjacency(raw.callers);
	if (!actualCallees || !actualCallers || actualCallees.size !== expectedCallees.size || actualCallers.size !== expectedCallers.size) return false;
	const sameSets = (actual: Map<string, Set<string>>, expected: Map<string, Set<string>>): boolean => {
		for (const [key, values] of expected) {
			const got = actual.get(key);
			if (!got || got.size !== values.size || [...values].some((value) => !got.has(value))) return false;
		}
		return true;
	};
	if (!sameSets(actualCallees, expectedCallees) || !sameSets(actualCallers, expectedCallers)) return false;
	const actualInDegree = new Map<string, number>();
	for (const entry of raw.inDegree) {
		if (!Array.isArray(entry) || !nonEmptyString(entry[0]) || typeof entry[1] !== "number" || !Number.isFinite(entry[1]) || entry[1] < 0 || actualInDegree.has(entry[0])) return false;
		actualInDegree.set(entry[0], entry[1]);
	}
	if (actualInDegree.size !== expectedInDegree.size) return false;
	for (const [key, value] of expectedInDegree) {
		if (actualInDegree.get(key) !== value) return false;
	}
	return true;
}

/**
 * Load the persisted call graph from disk.
 * Returns undefined if the cache is missing, version-mismatched, or corrupt.
 */
export function loadCallGraph(
	cwd: string,
	expectedIdentity?: CallGraphCacheIdentity,
): {
	graph: FunctionCallGraph;
	identity: CallGraphCacheIdentity;
} | undefined {
	const cacheFile = cacheFilePath(cwd);
	try {
		const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as PersistedCallGraph;
		if (raw.version !== CACHE_VERSION) return undefined;
		if (typeof raw.reviewGraphVersion !== "string" || typeof raw.reviewGraphSignature !== "string") return undefined;
		const identity: CallGraphCacheIdentity = {
			reviewGraphVersion: raw.reviewGraphVersion,
			reviewGraphSignature: raw.reviewGraphSignature,
		};
		if (expectedIdentity && (identity.reviewGraphVersion !== expectedIdentity.reviewGraphVersion ||
			identity.reviewGraphSignature !== expectedIdentity.reviewGraphSignature)) return undefined;

		const coverage = loadCoverage(raw.coverage, raw.edges);
		if (!validatePersistedCallGraph(raw, coverage)) return undefined;
		return {
			graph: {
				callees: new Map(raw.callees.map(([k, v]) => [k, new Set(v)])),
				callers: new Map(raw.callers.map(([k, v]) => [k, new Set(v)])),
				inDegree: new Map(raw.inDegree),
				edges: raw.edges,
				unresolvedRefs: raw.unresolvedRefs ?? coverage.unresolvedEvidence,
				totalRefs: raw.totalRefs ?? coverage.totalEvidence,
				coverage,
				builtAt: raw.builtAt,
			},
			identity,
		};
	} catch {
		return undefined;
	}
}

