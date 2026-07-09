/**
 * Centralized LAZY accessor for `web-tree-sitter` (wasm — loaded on demand). See
 * ./typescript.ts for the rationale. Types are re-exported; the module itself is
 * fetched via `loadWebTreeSitter()`.
 *
 * Resolved to an absolute path via `createRequire` before importing (the same
 * idiom as `tree-sitter-client.ts`): an absolute-path dynamic import works under
 * pi's bundled host, a bare specifier does not. The `exports` map has no bare
 * `require` entry, so the ESM entry subpath is resolved explicitly; bare import
 * kept as a fallback.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type * from "web-tree-sitter";

export type WebTreeSitter = typeof import("web-tree-sitter");

const _require = createRequire(import.meta.url);

export function loadWebTreeSitter(): Promise<WebTreeSitter> {
	try {
		const entry = _require.resolve("web-tree-sitter/tree-sitter.js");
		return import(pathToFileURL(entry).href) as Promise<WebTreeSitter>;
	} catch {
		return import("web-tree-sitter");
	}
}
