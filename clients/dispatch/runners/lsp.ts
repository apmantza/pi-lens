/**
 * Unified LSP Runner for pi-lens
 *
 * Handles type checking for ALL LSP-supported languages:
 * - TypeScript/JavaScript (typescript-language-server)
 * - Python (pyright/pylsp)
 * - Go (gopls)
 * - Rust (rust-analyzer)
 * - Ruby, PHP, C#, Java, Kotlin, Swift, Dart, etc.
 *
 * Replaces language-specific runners (ts-lsp, pyright) with a single
 * unified runner that delegates to the LSP service.
 */

import { getLSPService } from "../../lsp/index.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { readFileContent } from "./utils.js";

const lspRunner: RunnerDefinition = {
	id: "lsp",
	appliesTo: ["jsts", "python", "go", "rust"], // Core LSP languages
	priority: 4, // Run before everything (even ts-lsp was priority 5)
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Only run if --lens-lsp flag is enabled
		if (!ctx.pi.getFlag("lens-lsp")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const lspService = getLSPService();

		// Check if we have LSP available for this file
		const hasLSP = await lspService.hasLSP(ctx.filePath);
		if (!hasLSP) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Read file content
		const content = readFileContent(ctx.filePath);
		if (!content) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Open file in LSP and get diagnostics
		await lspService.openFile(ctx.filePath, content);
		// getDiagnostics() internally calls waitForDiagnostics() with bus
		// subscription + 150ms debounce + 3s timeout
		const lspDiags = await lspService.getDiagnostics(ctx.filePath);

		// Convert LSP diagnostics to our format
		// Defensive: filter out malformed diagnostics that may lack range
		const diagnostics: Diagnostic[] = lspDiags
			.filter((d) => d.range?.start?.line !== undefined)
			.map((d) => ({
				id: `lsp:${d.code ?? "unknown"}:${d.range.start.line}`,
				message: d.message,
				filePath: ctx.filePath,
				line: d.range.start.line + 1,
				column: d.range.start.character + 1,
				severity:
					d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
				semantic: d.severity === 1 ? "blocking" : "warning",
				tool: "lsp",
				code: String(d.code ?? ""),
			}));

		const hasErrors = diagnostics.some((d) => d.semantic === "blocking");

		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors ? "blocking" : "warning",
		};
	},
};

export default lspRunner;
