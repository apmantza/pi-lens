/**
 * Centralized LAZY accessor for `@ast-grep/napi` (a native addon — loaded on
 * demand, never at module-eval). See ./typescript.ts for the rationale.
 * Types are re-exported; the module itself is fetched via `loadAstGrepNapi()`.
 */
export type * from "@ast-grep/napi";

export type AstGrepNapi = typeof import("@ast-grep/napi");

export function loadAstGrepNapi(): Promise<AstGrepNapi> {
	return import("@ast-grep/napi");
}
