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
import { RUNTIME_CONFIG } from "../../runtime-config.js";
import { resolveRunnerPath } from "../runner-context.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { readFileContent } from "./utils.js";

const LSP_MAX_FILE_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const LSP_MAX_FILE_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;
const MAX_CODE_ACTION_LOOKUPS = 6;
const MAX_CODE_ACTION_TITLES = 3;

function normalizeActionTitle(title: string): string {
	return title.replace(/\s+/g, " ").trim();
}

function buildCodeActionSuggestion(
	actions: import("../../lsp/client.js").LSPCodeAction[],
): string | undefined {
	if (!actions.length) return undefined;

	const quickFixFirst = [...actions].sort((a, b) => {
		const aQuick = a.kind?.startsWith("quickfix") ? 0 : 1;
		const bQuick = b.kind?.startsWith("quickfix") ? 0 : 1;
		return aQuick - bQuick;
	});

	const titles = Array.from(
		new Set(
			quickFixFirst
				.map((action) => normalizeActionTitle(action.title))
				.filter((title) => title.length > 0),
		),
	).slice(0, MAX_CODE_ACTION_TITLES);

	if (!titles.length) return undefined;
	return `LSP quick fixes: ${titles.join("; ")}`;
}

const lspRunner: RunnerDefinition = {
	id: "lsp",
	appliesTo: [
		"jsts",
		"python",
		"go",
		"rust",
		"ruby",
		"cxx",
		"cmake",
		"shell",
		"json",
		"markdown",
		"css",
		"yaml",
	],
	priority: 4, // Run before everything (even ts-lsp was priority 5)
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const diagnosticPath = resolveRunnerPath(ctx.cwd, ctx.filePath);
		// Only run if --lens-lsp flag is enabled
		if (!ctx.pi.getFlag("lens-lsp") || !!ctx.pi.getFlag("no-lsp")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const lspService = getLSPService();

		// Check if we have LSP available for this file
		const hasLSP = await lspService.hasLSP(ctx.filePath);
		if (!hasLSP) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Always sync current file content before reading diagnostics so dispatch
		// does not operate on stale LSP snapshots.
		let lspDiags: import("../../lsp/client.js").LSPDiagnostic[] = [];
		let serverFailed = false;
		let failureReason = "";
		const content = readFileContent(ctx.filePath);
		if (!content) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const sizeBytes = Buffer.byteLength(content, "utf-8");
		const lineCount = content.split("\n").length;
		if (sizeBytes > LSP_MAX_FILE_BYTES || lineCount > LSP_MAX_FILE_LINES) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		try {
			await lspService.openFile(ctx.filePath, content);
			// getDiagnostics() internally waits for published diagnostics.
			lspDiags = await lspService.getDiagnostics(ctx.filePath);
		} catch (err) {
			serverFailed = true;
			failureReason = err instanceof Error ? err.message : String(err);
			if (
				failureReason.includes("spawn") ||
				failureReason.includes("exited") ||
				failureReason.includes("connection") ||
				failureReason.includes("JSON RPC")
			) {
				console.error(
					`[lsp-runner] LSP server failed for ${diagnosticPath}: ${failureReason}`,
				);
			}
		}

		if (serverFailed) {
			return {
				status: "failed",
				diagnostics: [
					{
						id: `lsp:server-error:0`,
						message: `LSP server failed: ${failureReason}`,
						filePath: diagnosticPath,
						line: 1,
						column: 1,
						severity: "error",
						semantic: "warning", // Don't block - fallback to other runners
						tool: "lsp",
					},
				],
				semantic: "warning",
			};
		}

		if (lspDiags.length === 0) {
			return {
				status: "succeeded",
				diagnostics: [],
				semantic: "none",
				rawOutput: "no-diagnostics",
			};
		}

		// Convert LSP diagnostics to our format
		// Defensive: filter out malformed diagnostics that may lack range
		const validLspDiags = lspDiags.filter((d) => d.range?.start?.line !== undefined);
		const fixSuggestionByIndex = new Map<number, string>();

		const blockingDiagIndexes = validLspDiags
			.map((d, idx) => ({ d, idx }))
			.filter(({ d }) => d.severity === 1)
			.slice(0, MAX_CODE_ACTION_LOOKUPS);

		for (const { d, idx } of blockingDiagIndexes) {
			try {
				const start = d.range.start;
				const end = d.range.end ?? d.range.start;
				const actions = await lspService.codeAction(
					ctx.filePath,
					start.line,
					start.character,
					end.line,
					end.character,
				);
				const suggestion = buildCodeActionSuggestion(actions);
				if (suggestion) {
					fixSuggestionByIndex.set(idx, suggestion);
				}
			} catch {
				// Best-effort enrichment only; base diagnostics remain authoritative.
			}
		}

		const diagnostics: Diagnostic[] = validLspDiags.map((d, idx) => ({
				id: `lsp:${d.code ?? "unknown"}:${d.range.start.line}`,
				message: d.message,
				filePath: diagnosticPath,
				line: d.range.start.line + 1,
				column: d.range.start.character + 1,
				severity:
					d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
				semantic:
					d.severity === 1
						? "blocking"
						: d.severity === 2
							? "warning"
							: "none",
				tool: "lsp",
				code: String(d.code ?? ""),
				fixable: fixSuggestionByIndex.has(idx),
				fixSuggestion: fixSuggestionByIndex.get(idx),
			}));

		const hasErrors = diagnostics.some((d) => d.semantic === "blocking");

		return {
			status: hasErrors ? "failed" : "succeeded",
			diagnostics,
			semantic: hasErrors
				? "blocking"
				: diagnostics.length > 0
					? "warning"
					: "none",
		};
	},
};

export default lspRunner;
