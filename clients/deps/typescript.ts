/**
 * Centralized accessor for the `typescript` dependency.
 *
 * Third-party deps are imported in EXACTLY ONE place (this folder) and consumed
 * via the accessor — never imported bare elsewhere (enforced by
 * tests/clients/deps-centralization.test.ts). This gives each external dep a
 * single, wrappable resolution surface: the #285/#335 failure point, the
 * degrade/diagnostics seam, and the bundling boundary are all one module.
 *
 * `ts` re-exports the whole namespace, so callers keep using `ts.SyntaxKind`,
 * `ts.Node`, etc. — just from here. (typescript uses `export =`, hence the
 * import-then-export form rather than `export * as`.)
 */
import * as ts from "typescript";

export { ts };
