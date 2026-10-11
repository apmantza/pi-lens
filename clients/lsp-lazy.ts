/** Shared lazy LSP service seam (#1394). */
import { createLazyImport } from "./lazy-import.js";

type LspModule = typeof import("./lsp/capabilities.js");
// The specifier must stay a string literal: esbuild inlines only literal
// dynamic imports, and the published package has no dist/lsp/ tree for a
// computed one to load (#4314). tests/packaging.test.ts pins this on the bundle.
const lazyLsp = createLazyImport<LspModule>(
	() => import("./lsp/capabilities.js"),
);

export function warmLspService(): Promise<LspModule> {
	return lazyLsp.get();
}

export function loadLspService(): Promise<LspModule> {
	return warmLspService();
}
