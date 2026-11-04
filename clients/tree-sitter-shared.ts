/**
 * Shared TreeSitterClient singleton + ext→language resolver.
 *
 * web-tree-sitter's WASM runtime is module-level — one per process. TRANSFER_BUFFER
 * and _ts_init are global, so every subsystem MUST share a single TreeSitterClient:
 * separate clients race on init and corrupt the shared WASM heap. This module is
 * that single seam — read expansion, the dispatch tree-sitter runner, project scanner,
 * module-report, review-graph, and fact providers all obtain their client here, so a
 * file parsed by one is reused by the others while its content version remains resident.
 *
 * Once the WASM runtime aborts (Emscripten abort()), the heap is corrupted with no
 * in-process recovery. markTreeSitterWasmAborted() poisons the singleton so EVERY
 * consumer skips further tree-sitter work (previously only the runner tracked this,
 * while the other subsystems kept calling the dead runtime).
 */
import { notifyUserDegradation } from "./user-notify.js";
import * as path from "node:path";
import {
	type ParsedTreeOutcome,
	TreeSitterClient,
} from "./tree-sitter-client.js";
import { EXTENSION_TO_GRAMMAR } from "./language-registry.js";
import { logTreeSitter } from "./tree-sitter-logger.js";

let _shared: TreeSitterClient | null = null;
let _wasmAborted = false;
let _wasmAbortedAt: string | undefined;

export interface TreeSitterRuntimeStatus {
	available: boolean;
	wasmAborted: boolean;
	recovery: "restart_required" | "not_required";
	abortedAt?: string;
}

/** The process-wide TreeSitterClient, or null once the WASM runtime has aborted. */
export function getSharedTreeSitterClient(): TreeSitterClient | null {
	if (_wasmAborted) return null;
	_shared ??= new TreeSitterClient(false, markTreeSitterWasmAborted);
	return _shared;
}

export function isTreeSitterWasmAborted(): boolean {
	return _wasmAborted;
}

/**
 * Re-arm the singleton's web-tree-sitter load latch for a new session
 * (#1592 review round 2 F2 — the same shape as #1567/#1575's
 * `resetAstGrepNapiLoadState()`). A no-op if the singleton hasn't been
 * created yet, or if the WASM runtime already aborted (that case is
 * process-lifetime by design, see `markTreeSitterWasmAborted` above — a
 * session boundary is not a process restart, so it stays poisoned).
 */
export function resetTreeSitterClientLoadState(): void {
	_shared?.resetLoadStateForSession();
}

/** Machine-readable process-wide runtime health for status/reporting surfaces. */
export function getTreeSitterRuntimeStatus(): TreeSitterRuntimeStatus {
	return {
		available: !_wasmAborted,
		wasmAborted: _wasmAborted,
		recovery: _wasmAborted ? "restart_required" : "not_required",
		...(_wasmAbortedAt ? { abortedAt: _wasmAbortedAt } : {}),
	};
}

/**
 * Poison the singleton after an unrecoverable Emscripten abort() — the module-level
 * WASM heap is corrupted, so no client can be used again this process.
 */
export function markTreeSitterWasmAborted(): void {
	if (_wasmAborted) return;
	_wasmAborted = true;
	_wasmAbortedAt = new Date().toISOString();
	_shared = null;
	// HUMAN-audience: structural analysis is dead for the rest of the process
	// and only a restart recovers it. Reaches the user through the HOST's
	// render path (#1333); the machine-readable record is the logTreeSitter
	// `runtime_abort` entry below.
	notifyUserDegradation(
		"pi-lens: tree-sitter WASM runtime aborted; structural analysis is disabled " +
			"for this process. Restart the pi-lens extension/MCP server to recover.",
		"error",
	);
	logTreeSitter({
		phase: "runtime_abort",
		filePath: process.cwd(),
		status: "degraded",
		reason: "wasm_aborted_restart_required",
		metadata: { abortedAt: _wasmAbortedAt },
	});
}

/** Test-only: reset the singleton + abort flag. */
export function _resetSharedTreeSitterClientForTests(): void {
	_shared = null;
	_wasmAborted = false;
	_wasmAbortedAt = undefined;
}

// Grammar selection by extension — projected from the canonical language
// registry (language-registry.ts, #2424), which is now THE ext→grammar
// authority. `.tsx` → the tsx grammar (parses JSX); `.jsx` → the javascript
// grammar. The project scanner (project-diagnostics/scanner.ts), read expansion
// (read-expansion.ts) and module-report (`tsLangForFile`, #887) all project the
// same registry column, so none of them can drift from this one: before #2424
// the scanner spread this map and layered java/kotlin on top while read
// expansion kept a hand-copied near-copy of it.
// `Readonly` because the projection is `Object.freeze`d at the source, and the
// mutable `Record` type let a caller type-check a write that would throw at
// runtime (#2424 review, S4).
export const EXT_TO_LANG: Readonly<Record<string, string>> =
	EXTENSION_TO_GRAMMAR;

/** Resolve a tree-sitter grammar/language id from a file path's extension. */
export function resolveTreeSitterLanguage(
	filePath: string,
): string | undefined {
	return EXT_TO_LANG[path.extname(filePath).toLowerCase()];
}

/**
 * The grammars `clients/metrics/function-metrics.ts` has a table for.
 *
 * Lives HERE, beside the ext→grammar resolver, because the question "can this
 * path produce a complexity baseline?" has to be answerable WITHOUT loading
 * the analyzer graph (#2467): `clients/runtime-tool-call.ts` asks it on every
 * tool call to decide whether the analyzer-module load is worth starting, and
 * the client that owns the answer is behind that very load.
 *
 * It is not a second extension table — the extension half still comes from the
 * one canonical registry through {@link resolveTreeSitterLanguage}. It is the
 * language-id half, and the metrics `TABLES` satisfy
 * `Record<ComplexityLanguageId, …>`, so adding a grammar there without adding
 * it here (or the reverse) is a COMPILE error rather than a predicate that
 * quietly drifts from the tables it is supposed to mirror.
 */
export const COMPLEXITY_LANGUAGE_IDS = [
	"typescript",
	"tsx",
	"javascript",
	"python",
	"go",
	"rust",
] as const;

/** One of {@link COMPLEXITY_LANGUAGE_IDS}. */
export type ComplexityLanguageId = (typeof COMPLEXITY_LANGUAGE_IDS)[number];

/** Narrow a resolved grammar id to one complexity can analyze. */
export function isComplexityLanguageId(
	languageId: string,
): languageId is ComplexityLanguageId {
	return (COMPLEXITY_LANGUAGE_IDS as readonly string[]).includes(languageId);
}

/**
 * Can a complexity baseline be produced for this path? Pure, synchronous, and
 * free of every analyzer module — the guard `handleToolCallImpl` needs above
 * its demand on the bootstrap seam. `ComplexityClient.isSupportedFile`
 * delegates to it, so there is exactly one answer.
 */
export function isComplexitySupportedFile(filePath: string): boolean {
	const languageId = resolveTreeSitterLanguage(filePath);
	return languageId !== undefined && isComplexityLanguageId(languageId);
}

// --- Generic node-walk utilities (shared by the fact extractors and the
//     complexity client — anything that consumes a parsed tree) ---

// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter node (see tree-sitter-client.ts)
export type TsNode = any;

export async function withTreeSitterRoot<T>(
	filePath: string,
	content: string,
	consume: (root: TsNode) => T,
	/** The consumer's own trap identity (#3678 F4): callers here consume
	 * differently, so they must not share one. */
	caller: string,
): Promise<ParsedTreeOutcome<T>> {
	const languageId = resolveTreeSitterLanguage(filePath);
	const client = getSharedTreeSitterClient();
	if (!languageId || !client || !(await client.init()))
		return { parsed: false };
	return client.withParsedTree(
		filePath,
		languageId,
		content,
		(tree) => consume(tree.rootNode as TsNode),
		caller,
	);
}

export function childrenOfType(node: TsNode, type: string): TsNode[] {
	return (node.children ?? []).filter((c: TsNode) => c && c.type === type);
}

export function firstChildOfType(
	node: TsNode,
	type: string,
): TsNode | undefined {
	return (node.children ?? []).find((c: TsNode) => c && c.type === type);
}

/** Depth-first walk, calling `visit` on every node (pre-order = source order). */
export function walk(node: TsNode, visit: (n: TsNode) => void): void {
	visit(node);
	for (const child of node.children ?? []) {
		if (child) walk(child, visit);
	}
}
