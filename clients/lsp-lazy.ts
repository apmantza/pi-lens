/** Shared lazy LSP service seam (#1394). */
import { createLazyImport } from "./lazy-import.js";

type LspModule = typeof import("./lsp/capabilities.js");
// Keep this import behind the async loader's boundary. `lsp/index.ts` imports
// warm-attach, while capabilities imports the completed LSP implementation;
// exposing the literal to the static graph recreates that initialization cycle.
const LSP_CAPABILITIES_MODULE = ["./lsp", "capabilities.js"].join("/");
const lazyLsp = createLazyImport<LspModule>(
	() => import(LSP_CAPABILITIES_MODULE),
);

export function warmLspService(): Promise<LspModule> {
	return lazyLsp.get();
}

export function loadLspService(): Promise<LspModule> {
	return warmLspService();
}
