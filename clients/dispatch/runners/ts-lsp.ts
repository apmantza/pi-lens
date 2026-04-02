/**
 * TypeScript LSP runner for dispatch system
 *
 * Uses the new LSP client architecture (Phase 3) when --lens-lsp is enabled.
 * Falls back to built-in TypeScriptClient for backward compatibility.
 *
 * @deprecated The built-in TypeScriptClient is deprecated. Use --lens-lsp for full LSP support.
 */

import { getLSPService } from "../../lsp/index.js";
import { TypeScriptClient } from "../../typescript-client.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { readFileContent } from "./utils.js";

const tsLspRunner: RunnerDefinition = {
	id: "ts-lsp",
	appliesTo: ["jsts"],
	priority: 5,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		// Only check TypeScript files
		if (!ctx.filePath.match(/\.tsx?$/)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// When --lens-lsp is active, the `lsp` runner (priority 4) already
		// handles TypeScript via the LSP service. Skip to avoid duplicate work.
		if (ctx.pi.getFlag("lens-lsp")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// DEPRECATED: Fall back to built-in TypeScriptClient
		// This path is deprecated and will be removed in a future release
		return runWithBuiltinClient(ctx);
	},
};

/**
 * Run with new LSP client (Phase 3)
 */
async function runWithLSPClient(ctx: DispatchContext): Promise<RunnerResult> {
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
			id: `ts-lsp:${d.code ?? "unknown"}:${d.range.start.line}`,
			message: d.message,
			filePath: ctx.filePath,
			line: d.range.start.line + 1,
			column: d.range.start.character + 1,
			severity:
				d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
			semantic: d.severity === 1 ? "blocking" : "warning",
			tool: "ts-lsp",
			code: String(d.code ?? ""),
		}));

	return {
		status: "failed",
		diagnostics,
		semantic: "blocking",
	};
}

/**
 * Run with deprecated built-in TypeScriptClient
 * @deprecated Use runWithLSPClient instead
 */
async function runWithBuiltinClient(
	ctx: DispatchContext,
): Promise<RunnerResult> {
	const tsClient = new TypeScriptClient();

	const content = readFileContent(ctx.filePath);
	if (!content) {
		return { status: "skipped", diagnostics: [], semantic: "none" };
	}
	tsClient.updateFile(ctx.filePath, content);

	const diags = tsClient.getDiagnostics(ctx.filePath);

	if (diags.length === 0) {
		return { status: "succeeded", diagnostics: [], semantic: "none" };
	}

	// Get code fixes for all errors
	const allFixes = tsClient.getAllCodeFixes(ctx.filePath);

	// Convert to diagnostics
	const diagnostics: Diagnostic[] = [];

	// The built-in client returns Diagnostic with { range: { start: { line, character } } }
	for (const d of diags) {
		// Safely access nested properties
		if (!d.range?.start) continue;

		const line = d.range.start.line;
		const character = d.range.start.character ?? 0;
		const severity =
			d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
		const semantic = d.severity === 1 ? "blocking" : "warning";

		// Find fixes for this line
		const lineFixes = allFixes.get(line);
		const fixDescription = lineFixes?.[0]?.description;

		diagnostics.push({
			id: `ts:${d.code}:${line}`,
			message: fixDescription
				? `${d.message} [💡 ${fixDescription}]`
				: d.message,
			filePath: ctx.filePath,
			line: line + 1,
			column: character + 1,
			severity,
			semantic,
			tool: "ts-lsp",
			fixable: !!lineFixes && lineFixes.length > 0,
			fixSuggestion: fixDescription,
		});
	}

	return {
		status: "failed",
		diagnostics,
		semantic: "blocking",
	};
}

export default tsLspRunner;
