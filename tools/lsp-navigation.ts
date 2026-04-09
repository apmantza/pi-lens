/**
 * lsp_navigation tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import * as nodeFs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { LSPCallHierarchyItem } from "../clients/lsp/client.js";
import { getLSPService } from "../clients/lsp/index.js";

function operationSupportStatus(
	operation: string,
	support: import("../clients/lsp/client.js").LSPOperationSupport | null,
): boolean | null {
	if (!support) return null;
	if (operation === "definition") return support.definition;
	if (operation === "references") return support.references;
	if (operation === "hover") return support.hover;
	if (operation === "signatureHelp") return support.signatureHelp;
	if (operation === "documentSymbol") return support.documentSymbol;
	if (operation === "workspaceSymbol") return support.workspaceSymbol;
	if (operation === "codeAction") return support.codeAction;
	if (operation === "rename") return support.rename;
	if (operation === "implementation") return support.implementation;
	if (
		operation === "prepareCallHierarchy" ||
		operation === "incomingCalls" ||
		operation === "outgoingCalls"
	)
		return support.callHierarchy;
	return null;
}

function emptyReasonForOperation(operation: string): string {
	if (operation === "signatureHelp") return "position-sensitive-or-no-signature";
	if (operation === "codeAction") return "no-applicable-actions";
	if (operation === "rename") return "no-rename-edits-or-symbol-not-renamable";
	if (operation === "workspaceSymbol")
		return "no-matching-symbols-or-server-index-unavailable";
	if (operation === "incomingCalls" || operation === "outgoingCalls")
		return "no-call-hierarchy-results";
	return "no-results";
}

export function createLspNavigationTool(
	getFlag: (name: string) => boolean | string | undefined,
) {
	return {
		name: "lsp_navigation" as const,
		label: "LSP Navigate",
		description:
			"Navigate code using LSP (Language Server Protocol). Requires --lens-lsp flag.\n" +
			"Operations:\n" +
			"- definition: Jump to where a symbol is defined\n" +
			"- references: Find all usages of a symbol\n" +
			"- hover: Get type/doc info at a position\n" +
			"- signatureHelp: Show callable signatures at cursor\n" +
			"- documentSymbol: List all symbols (functions/classes/vars) in a file\n" +
			"- workspaceSymbol: Search symbols across the whole project\n" +
			"- codeAction: Find available quick fixes/refactors at a range\n" +
			"- rename: Compute workspace edits for renaming a symbol\n" +
			"- implementation: Jump to interface implementations\n" +
			"- prepareCallHierarchy: Get callable item at position (for incoming/outgoing)\n" +
			"- incomingCalls: Find all functions/methods that CALL this function\n" +
			"- outgoingCalls: Find all functions/methods CALLED by this function\n" +
			"- workspaceDiagnostics: List all diagnostics tracked by active LSP clients\n\n" +
			"Line and character are 1-based (as shown in editors).",
		promptSnippet:
			"Use lsp_navigation to find definitions, references, and hover info via LSP",
		parameters: Type.Object({
			operation: Type.Union(
				[
					Type.Literal("definition"),
					Type.Literal("references"),
					Type.Literal("hover"),
					Type.Literal("signatureHelp"),
					Type.Literal("documentSymbol"),
					Type.Literal("workspaceSymbol"),
					Type.Literal("codeAction"),
					Type.Literal("rename"),
					Type.Literal("implementation"),
					Type.Literal("prepareCallHierarchy"),
					Type.Literal("incomingCalls"),
					Type.Literal("outgoingCalls"),
					Type.Literal("workspaceDiagnostics"),
				],
				{ description: "LSP operation to perform" },
			),
			filePath: Type.Optional(
				Type.String({
					description:
						"Absolute or relative file path. Required for file-scoped operations; optional for workspaceSymbol/workspaceDiagnostics.",
				}),
			),
			line: Type.Optional(
				Type.Number({
					description:
						"Line number (1-based). Required for definition/references/hover/implementation",
				}),
			),
			character: Type.Optional(
				Type.Number({
					description:
						"Character offset (1-based). Required for definition/references/hover/implementation",
				}),
			),
			endLine: Type.Optional(
				Type.Number({
					description:
						"End line (1-based). Optional; used by codeAction range.",
				}),
			),
			endCharacter: Type.Optional(
				Type.Number({
					description:
						"End character (1-based). Optional; used by codeAction range.",
				}),
			),
			newName: Type.Optional(
				Type.String({
					description: "Required for rename operation.",
				}),
			),
			query: Type.Optional(
				Type.String({
					description: "Symbol name to search. Used by workspaceSymbol",
				}),
			),
			callHierarchyItem: Type.Optional(
				Type.Object(
					{
						name: Type.String(),
						kind: Type.Number(),
						uri: Type.String(),
						range: Type.Object({
							start: Type.Object({
								line: Type.Number(),
								character: Type.Number(),
							}),
							end: Type.Object({
								line: Type.Number(),
								character: Type.Number(),
							}),
						}),
						selectionRange: Type.Object({
							start: Type.Object({
								line: Type.Number(),
								character: Type.Number(),
							}),
							end: Type.Object({
								line: Type.Number(),
								character: Type.Number(),
							}),
						}),
					},
					{
						description:
							"Call hierarchy item. Required for incomingCalls/outgoingCalls",
					},
				),
			),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			let supported: boolean | null = null;
			let diagnosticsMode: "pull" | "push-only" | "unknown" = "unknown";

			if (!getFlag("lens-lsp") || getFlag("no-lsp")) {
				return {
					content: [
						{
							type: "text" as const,
							text: "lsp_navigation requires LSP to be enabled. Use --lens-lsp (default) and ensure --no-lsp is not set.",
						},
					],
					isError: true,
					details: {},
				};
			}

			const {
				operation,
				filePath: rawPath,
				line,
				character,
				endLine,
				endCharacter,
				newName,
				query,
			} = params as {
				operation: string;
				filePath?: string;
				line?: number;
				character?: number;
				endLine?: number;
				endCharacter?: number;
				newName?: string;
				query?: string;
			};

			const needsFilePath =
				operation !== "workspaceDiagnostics" && operation !== "workspaceSymbol";
			if (needsFilePath && (!rawPath || rawPath.trim().length === 0)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `filePath is required for ${operation}`,
						},
					],
					isError: true,
					details: {},
				};
			}

			const filePath = rawPath
				? path.isAbsolute(rawPath)
					? rawPath
					: path.resolve(ctx.cwd || ".", rawPath)
				: "";

			const lspService = getLSPService();
			if (operation === "workspaceDiagnostics") {
				const allDiagnostics = await lspService.getAllDiagnostics();
				const wsDiagSupport = await lspService.getWorkspaceDiagnosticsSupport();
				diagnosticsMode = wsDiagSupport?.mode ?? "unknown";
				const result = Array.from(allDiagnostics.entries()).map(
					([trackedFile, diags]) => ({
						filePath: trackedFile,
						diagnostics: diags,
						count: diags.length,
					}),
				);
				const note =
					diagnosticsMode === "push-only"
						? "Note: push-only tracked diagnostics snapshot (not full workspace pull diagnostics)."
						: diagnosticsMode === "pull"
							? "Note: server advertises workspace pull diagnostics support."
							: "Note: workspace diagnostics mode unknown (no active capability snapshot).";
				return {
					content: [
						{
							type: "text" as const,
							text: `${note}\n${JSON.stringify(result, null, 2)}`,
						},
					],
					details: {
						operation,
						resultCount: result.length,
						diagnosticsMode,
						coverage: "tracked-open-files",
					},
				};
			}

			const hasLSP = filePath ? await lspService.hasLSP(filePath) : false;
			if (needsFilePath && !hasLSP) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No LSP server available for ${path.basename(filePath)}. Check that the language server is installed.`,
						},
					],
					isError: true,
					details: {},
				};
			}

			if (needsFilePath) {
				const support = await lspService.getOperationSupport(filePath);
				supported = operationSupportStatus(operation, support);
				if (supported === false) {
					return {
						content: [
							{
								type: "text" as const,
								text: `LSP server for ${path.basename(filePath)} does not advertise support for ${operation}`,
							},
						],
						isError: true,
						details: { operation, supported: false, emptyReason: "unsupported" },
					};
				}

				// Ensure file is open in LSP before querying
				let fileContent: string | undefined;
				try {
					fileContent = nodeFs.readFileSync(filePath, "utf-8");
				} catch {
					/* ignore */
				}
				if (fileContent) {
					try {
						await lspService.openFile(filePath, fileContent);
					} catch {
						/* LSP server may not be ready yet — proceed anyway */
					}
				}
			}

			// Convert 1-based editor coords to 0-based LSP coords
			const lspLine = (line ?? 1) - 1;
			const lspChar = (character ?? 1) - 1;
			const lspEndLine = (endLine ?? line ?? 1) - 1;
			const lspEndChar = (endCharacter ?? character ?? 1) - 1;

			let result: unknown;
			try {
					switch (operation) {
					case "definition":
						result = await lspService.definition(filePath, lspLine, lspChar);
						break;
					case "references":
						result = await lspService.references(filePath, lspLine, lspChar);
						break;
					case "hover":
						result = await lspService.hover(filePath, lspLine, lspChar);
						break;
					case "signatureHelp":
						result = await lspService.signatureHelp(filePath, lspLine, lspChar);
						break;
					case "documentSymbol":
						result = await lspService.documentSymbol(filePath);
						break;
					case "workspaceSymbol":
						supported = operationSupportStatus(
							operation,
							await lspService.getOperationSupport(),
						);
						if (supported === false) {
							return {
								content: [
									{
										type: "text" as const,
										text: "Active LSP server does not advertise support for workspaceSymbol",
									},
								],
								isError: true,
								details: {
									operation,
									supported: false,
									emptyReason: "unsupported",
								},
							};
						}
						if (!query || query.trim().length === 0) {
							return {
								content: [
									{
										type: "text" as const,
										text: "query parameter required for workspaceSymbol",
									},
								],
								isError: true,
								details: {},
							};
						}
						result = await lspService.workspaceSymbol(query ?? "");
						break;
					case "codeAction":
						result = await lspService.codeAction(
							filePath,
							lspLine,
							lspChar,
							lspEndLine,
							lspEndChar,
						);
						break;
					case "rename":
						if (!newName || newName.trim().length === 0) {
							return {
								content: [
									{
										type: "text" as const,
										text: "newName parameter required for rename",
									},
								],
								isError: true,
								details: {},
							};
						}
						result = await lspService.rename(filePath, lspLine, lspChar, newName);
						break;
					case "implementation":
						result = await lspService.implementation(filePath, lspLine, lspChar);
						break;
					case "prepareCallHierarchy":
						result = await lspService.prepareCallHierarchy(
							filePath,
							lspLine,
							lspChar,
						);
						break;
					case "incomingCalls": {
						const callItem = (
							params as { callHierarchyItem?: LSPCallHierarchyItem }
						).callHierarchyItem;
						if (!callItem) {
							return {
								content: [
									{
										type: "text" as const,
										text: "callHierarchyItem parameter required for incomingCalls",
									},
								],
								isError: true,
								details: {},
							};
						}
						result = await lspService.incomingCalls(callItem);
						break;
					}
					case "outgoingCalls": {
						const callItem = (
							params as { callHierarchyItem?: LSPCallHierarchyItem }
						).callHierarchyItem;
						if (!callItem) {
							return {
								content: [
									{
										type: "text" as const,
										text: "callHierarchyItem parameter required for outgoingCalls",
									},
								],
								isError: true,
								details: {},
							};
						}
						result = await lspService.outgoingCalls(callItem);
						break;
					}
					default:
						result = [];
				}
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `LSP error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: {},
				};
			}

			const isEmpty = !result || (Array.isArray(result) && result.length === 0);
			const output = isEmpty
				? `No results for ${operation} at ${path.basename(filePath)}${line ? `:${line}:${character}` : ""}`
				: JSON.stringify(result, null, 2);

			return {
				content: [{ type: "text" as const, text: output }],
				details: {
					operation,
					supported,
					emptyReason: isEmpty ? emptyReasonForOperation(operation) : undefined,
					resultCount: Array.isArray(result) ? result.length : result ? 1 : 0,
				},
			};
		},
	};
}
