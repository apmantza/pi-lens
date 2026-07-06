/**
 * Shared TreeSitterClient singleton + ext→language resolver.
 *
 * web-tree-sitter's WASM runtime is module-level — one per process. TRANSFER_BUFFER
 * and _ts_init are global, so every subsystem MUST share a single TreeSitterClient:
 * separate clients race on init and corrupt the shared WASM heap. This module is
 * that single seam — the dispatch tree-sitter runner, project scanner, module-report,
 * review-graph, and fact providers all obtain their client here, so a file parsed by
 * one is served from the shared tree cache for the others (one parse per write).
 *
 * Once the WASM runtime aborts (Emscripten abort()), the heap is corrupted with no
 * in-process recovery. markTreeSitterWasmAborted() poisons the singleton so EVERY
 * consumer skips further tree-sitter work (previously only the runner tracked this,
 * while the other subsystems kept calling the dead runtime).
 */
import * as path from "node:path";
import { TreeSitterClient } from "./tree-sitter-client.js";

let _shared: TreeSitterClient | null = null;
let _wasmAborted = false;

/** The process-wide TreeSitterClient, or null once the WASM runtime has aborted. */
export function getSharedTreeSitterClient(): TreeSitterClient | null {
	if (_wasmAborted) return null;
	_shared ??= new TreeSitterClient();
	return _shared;
}

export function isTreeSitterWasmAborted(): boolean {
	return _wasmAborted;
}

/**
 * Poison the singleton after an unrecoverable Emscripten abort() — the module-level
 * WASM heap is corrupted, so no client can be used again this process.
 */
export function markTreeSitterWasmAborted(): void {
	_wasmAborted = true;
	_shared = null;
}

/** Test-only: reset the singleton + abort flag. */
export function _resetSharedTreeSitterClientForTests(): void {
	_shared = null;
	_wasmAborted = false;
}

// Grammar selection by extension. `.tsx` → the tsx grammar (parses JSX); `.jsx` →
// the javascript grammar. NOTE: the project scanner keeps its OWN ext→lang map
// because its query lookup is keyed by language id (it maps `.tsx`→typescript to
// reuse typescript queries) — do not fold that one in without re-keying its queries.
const EXT_TO_LANG: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".rb": "ruby",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".c++": "cpp",
	".hh": "cpp",
	".hpp": "cpp",
	".hxx": "cpp",
	".inl": "cpp",
	".ipp": "cpp",
	".tpp": "cpp",
	".txx": "cpp",
	".cu": "cpp",
	".hip": "cpp",
	".cs": "csharp",
	".php": "php",
	".phtml": "php",
	".php3": "php",
	".php4": "php",
	".php5": "php",
	".css": "css",
};

/** Resolve a tree-sitter grammar/language id from a file path's extension. */
export function resolveTreeSitterLanguage(filePath: string): string | undefined {
	return EXT_TO_LANG[path.extname(filePath).toLowerCase()];
}
