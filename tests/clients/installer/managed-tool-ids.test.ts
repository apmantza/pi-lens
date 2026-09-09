import { describe, expect, it, vi } from "vitest";

vi.unmock("../../../clients/installer/index.js");

const MANAGED_LSP_TOOL_IDS = [
	"pyright",
	"jedi-language-server",
	"deno",
	"rust-analyzer",
	"intelephense",
	"bash-language-server",
	"dockerfile-language-server-nodejs",
	"yaml-language-server",
	"vscode-json-language-server",
	"vscode-html-languageserver-bin",
	"@prisma/language-server",
	"@vue/language-server",
	"svelte-language-server",
	"vscode-css-languageserver",
] as const;

describe("installer managed tool coverage", () => {
	it("has installer definitions for all managed LSP tool IDs", async () => {
		const { isKnownToolId } =
			await import("../../../clients/installer/index.js");
		const missing = MANAGED_LSP_TOOL_IDS.filter(
			(toolId) => !isKnownToolId(toolId),
		);
		expect(missing).toEqual([]);
	});

	it("pins the managed classic TypeScript compiler below TypeScript 7", async () => {
		const { TOOLS } = await import("../../../clients/installer/index.js");
		const typescript = TOOLS.find((tool) => tool.id === "typescript");
		expect(typescript?.packageName).toBe("typescript@5.9.3");
	});

	it("pins the managed typescript-language-server below its own EBADENGINE floor (#2633)", async () => {
		// 6.0.0 (the unpinned "latest") declares engines.node >=22.22.2, above
		// the pi host's own floor (pi-lens declares its own engines.node at
		// pi's floor and must never require more than pi does) — an unpinned
		// packageName here resolves latest at install time and prints
		// EBADENGINE on every pi host's supported Node. 5.3.0's own floor is
		// engines.node >=20.
		const { TOOLS } = await import("../../../clients/installer/index.js");
		const tsls = TOOLS.find((tool) => tool.id === "typescript-language-server");
		expect(tsls?.packageName).toBe("typescript-language-server@5.3.0");
	});

	it("points vscode-css-languageserver at a package that is actually published (#2638)", async () => {
		// The bare package `vscode-css-languageserver` was unpublished from npm
		// on 2021-07-22 (E404) — the id must resolve through
		// `vscode-langservers-extracted` instead, the SAME package the
		// `vscode-json-language-server` entry already installs (it bundles
		// json/css/html/eslint/markdown; see the `isLspTransportRequiredError`
		// doc comment in clients/installer/index.ts).
		const { TOOLS } = await import("../../../clients/installer/index.js");
		const css = TOOLS.find((tool) => tool.id === "vscode-css-languageserver");
		expect(css?.packageName).toBe("vscode-langservers-extracted");
		expect(css?.binaryName).toBe("vscode-css-language-server");
	});

	it("points vscode-html-languageserver-bin at a package whose bin actually matches (#2638 review)", async () => {
		// The bare package `vscode-html-languageserver-bin` resolves on npm
		// (unlike vscode-css-languageserver's E404) but hasn't been republished
		// since 2018 and its own `bin` is named `html-languageserver`, not
		// `vscode-html-language-server` — the SAME defect class as the css
		// entry, just a different failure (a bin-name mismatch instead of a
		// dead package), caught by the same registry-resolve sweep. The HTML
		// server ships today inside `vscode-langservers-extracted`, the same
		// family the css/json entries already use.
		const { TOOLS } = await import("../../../clients/installer/index.js");
		const html = TOOLS.find(
			(tool) => tool.id === "vscode-html-languageserver-bin",
		);
		expect(html?.packageName).toBe("vscode-langservers-extracted");
		expect(html?.binaryName).toBe("vscode-html-language-server");
	});
});
