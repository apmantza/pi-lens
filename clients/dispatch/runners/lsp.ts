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
 * Replaces language-specific runners (pyright, etc.) with a single
 * unified runner that delegates to the LSP service.
 */

import { getLSPService } from "../../lsp/index.js";
import { RUNTIME_CONFIG } from "../../runtime-config.js";
import { PRIORITY } from "../priorities.js";
import { resolveRunnerPath } from "../runner-context.js";
import type {
	Diagnostic,
	DispatchContext,
	RunnerDefinition,
	RunnerResult,
} from "../types.js";
import { convertLspDiagnostics } from "../utils/lsp-diagnostics.js";
import {
	enabledAuxiliaryLspServerIds,
	findAuxiliaryProfileForSource,
} from "../auxiliary-lsp.js";
import { readFileContent } from "./utils.js";

const LSP_MAX_FILE_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const LSP_MAX_FILE_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;
const LSP_SPAWN_BUDGET_MS = RUNTIME_CONFIG.pipeline.lspSpawnBudgetMs;

// Diagnostics-wait cap for the dispatch lsp-runner. Bounded so a slow LSP
// (typescript-language-server on large monorepos has been observed >7 s)
// can't dominate the per-edit pipeline budget. Diagnostics that arrive
// after the cap still land in the client's cache and surface on the
// next edit. Overridable via PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS.
const LSP_DIAGNOSTICS_WAIT_MS = 2500;
const MAX_CODE_ACTION_LOOKUPS = 6;
const MAX_CODE_ACTION_TITLES = 3;

function normalizeActionTitle(title: string): string {
	return title.replace(/\s+/g, " ").trim();
}

function buildCodeActionSuggestion(
	actions: import("../../lsp/client.js").LSPCodeAction[],
): string | undefined {
	if (!actions.length) return undefined;
	const quickFixes = actions.filter((action) =>
		action.kind?.startsWith("quickfix"),
	);
	if (!quickFixes.length) return undefined;

	const titles = Array.from(
		new Set(
			quickFixes
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
		"html",
		"docker",
		"php",
		"powershell",
		"prisma",
		"csharp",
		"fsharp",
		"java",
		"kotlin",
		"swift",
		"dart",
		"lua",
		"zig",
		"haskell",
		"elixir",
		"gleam",
		"ocaml",
		"clojure",
		"terraform",
		"nix",
		"toml",
	],
	priority: PRIORITY.LSP_PRIMARY,
	enabledByDefault: true,

	async run(ctx: DispatchContext): Promise<RunnerResult> {
		const diagnosticPath = resolveRunnerPath(ctx.cwd, ctx.filePath);
		// Only run if LSP is not disabled via --no-lsp
		if (ctx.pi.getFlag("no-lsp")) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		const lspService = getLSPService();

		// Fast capability check only — actual client creation happens when we
		// open the file below.
		if (!lspService.supportsLSP(ctx.filePath)) {
			return { status: "skipped", diagnostics: [], semantic: "none" };
		}

		// Always sync current file content before reading diagnostics so dispatch
		// does not operate on stale LSP snapshots.
		let lspDiags: import("../../lsp/client.js").LSPDiagnostic[] = [];
		let serverFailed = false;
		// touchFile resolves to `undefined` when no LSP client was ready (a cold
		// spawn that didn't complete in the budget, or LSP unavailable for this
		// file) — distinct from `[]`, which means the server replied with zero.
		let lspClientReady = true;
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

		// Cross-cutting auxiliary scanners (opengrep, …) attach alongside the
		// primary language server when enabled — collected on the with-auxiliary
		// path so their warm diagnostics merge into this same result.
		const auxiliaryServerIds = enabledAuxiliaryLspServerIds((f) =>
			ctx.pi.getFlag(f),
		);
		try {
			const touched = await lspService.touchFile(ctx.filePath, content, {
				diagnostics: "document",
				collectDiagnostics: true,
				clientScope: auxiliaryServerIds.length > 0 ? "with-auxiliary" : "primary",
				auxiliaryServerIds,
				maxClientWaitMs: LSP_SPAWN_BUDGET_MS,
				maxDiagnosticsWaitMs: LSP_DIAGNOSTICS_WAIT_MS,
				source: "dispatch-lsp-runner",
			});
			if (touched === undefined) {
				lspClientReady = false;
			} else {
				lspDiags = touched;
			}
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
				failureKind: "server_error",
				failureMessage: failureReason.slice(0, 200),
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

		if (!lspClientReady) {
			// No answer from the LSP — reporting "succeeded with 0 diagnostics"
			// would read as a clean bill of health when we simply didn't get a
			// reply. Report "skipped" so the coverage notice can flag the gap and
			// the next edit re-checks once the server has warmed; any diagnostics
			// published late still land in the client cache and surface then.
			return { status: "skipped", diagnostics: [], semantic: "none" };
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
		const validLspDiags = lspDiags.filter(
			(d) => d.range?.start?.line !== undefined,
		);
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

		const diagnostics: Diagnostic[] = convertLspDiagnostics(
			validLspDiags,
			diagnosticPath,
			{ fixSuggestionByIndex },
		);

		// convertLspDiagnostics maps validLspDiags 1:1, so re-tag any
		// auxiliary-sourced diagnostics (opengrep emits source "Semgrep", …) with
		// their tool id + semantic policy — language-server diagnostics keep "lsp".
		// blockingAllowed is per-workspace (e.g. curated repo rules), computed once.
		const blockingAllowedByProfile = new Map<unknown, boolean>();
		// Diagnostics dropped by the tool's NATIVE inline suppression (e.g. opengrep
		// `# nosemgrep`, #441). Read the file content lazily — only once, and only if
		// some auxiliary profile can suppress.
		const suppressedIndices = new Set<number>();
		let auxFileContent: string | undefined;
		let auxFileContentRead = false;
		const getAuxFileContent = (): string | undefined => {
			if (!auxFileContentRead) {
				auxFileContent = readFileContent(diagnosticPath);
				auxFileContentRead = true;
			}
			return auxFileContent;
		};
		for (let i = 0; i < diagnostics.length; i++) {
			const profile = findAuxiliaryProfileForSource(validLspDiags[i]?.source);
			if (!profile) continue;
			if (profile.isSuppressed) {
				const content = getAuxFileContent();
				if (content && profile.isSuppressed(validLspDiags[i], content)) {
					suppressedIndices.add(i);
					continue;
				}
			}
			let blockingAllowed = blockingAllowedByProfile.get(profile);
			if (blockingAllowed === undefined) {
				blockingAllowed = profile.allowBlocking?.(ctx.cwd) ?? false;
				blockingAllowedByProfile.set(profile, blockingAllowed);
			}
			const d = diagnostics[i];
			d.tool = profile.tool;
			d.semantic = profile.semantic(validLspDiags[i], { blockingAllowed });
			if (d.semantic !== "blocking" && d.severity === "error") {
				d.severity = "warning";
			}
			const defectClass = profile.defectClass?.(validLspDiags[i]);
			if (defectClass) d.defectClass = defectClass;
		}
		const keptDiagnostics = suppressedIndices.size
			? diagnostics.filter((_, i) => !suppressedIndices.has(i))
			: diagnostics;

		const hasErrors = keptDiagnostics.some((d) => d.semantic === "blocking");
		const resultSemantic = hasErrors
			? "blocking"
			: keptDiagnostics.length > 0
				? "warning"
				: "none";

		return {
			status: hasErrors ? "failed" : "succeeded",
			// "failed" here means the file has blocking type errors — the check ran
			// fine. Tag it so the smell analyzer doesn't read it as a runner crash.
			failureKind: hasErrors ? "blocking_diagnostics" : undefined,
			diagnostics: keptDiagnostics,
			semantic: resultSemantic,
		};
	},
};

export default lspRunner;
