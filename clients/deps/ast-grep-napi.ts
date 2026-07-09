/**
 * Centralized LAZY accessor for `@ast-grep/napi` (a native addon — loaded on
 * demand, never at module-eval). See ./typescript.ts for the rationale.
 * Types are re-exported; the module itself is fetched via `loadAstGrepNapi()`.
 *
 * Resolved to an absolute path via `createRequire` before importing (the same
 * idiom as `tree-sitter-client.ts`): an absolute-path dynamic import works under
 * pi's bundled host, a bare specifier does not. Bare import kept as a fallback.
 */
import { createRequire } from "node:module";

export type * from "@ast-grep/napi";

export type AstGrepNapi = typeof import("@ast-grep/napi");

const _require = createRequire(import.meta.url);

export function loadAstGrepNapi(): Promise<AstGrepNapi> {
	try {
		return import(_require.resolve("@ast-grep/napi")) as Promise<AstGrepNapi>;
	} catch {
		return import("@ast-grep/napi");
	}
}
