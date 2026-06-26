/**
 * Centralized LAZY accessor for `web-tree-sitter` (wasm — loaded on demand). See
 * ./typescript.ts for the rationale. Types are re-exported; the module itself is
 * fetched via `loadWebTreeSitter()`.
 */
export type * from "web-tree-sitter";

export type WebTreeSitter = typeof import("web-tree-sitter");

export function loadWebTreeSitter(): Promise<WebTreeSitter> {
	return import("web-tree-sitter");
}
