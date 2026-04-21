/**
 * lsp_navigation tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import * as nodeFs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@sinclair/typebox";
import type { LSPCallHierarchyItem } from "../clients/lsp/client.js";
import { getLSPService } from "../clients/lsp/index.js";
import { logLatency } from "../clients/latency-logger.js";

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

function tokenAtPosition(
	content: string,
	line1: number,
	char1: number,
): string | undefined {
	const lines = content.split(/\r?\n/);
	const line = lines[line1 - 1];
	if (!line) return undefined;
	const chars = [...line];
	const idx = Math.max(0, Math.min(chars.length - 1, char1 - 1));
	const isWord = (ch: string | undefined) =>
		!!ch && /[A-Za-z0-9_?!]/.test(ch);

	let left = idx;
	let right = idx;
	if (!isWord(chars[idx]) && isWord(chars[idx + 1])) {
		left = idx + 1;
		right = idx + 1;
	}
	while (left > 0 && isWord(chars[left - 1])) left -= 1;
	while (right < chars.length - 1 && isWord(chars[right + 1])) right += 1;
	const token = chars.slice(left, right + 1).join("").trim();
	return token.length > 0 ? token : undefined;
}

type SymbolNode = {
	name?: string;
	location?: { uri: string; range: Record<string, unknown> };
	range?: Record<string, unknown>;
	children?: SymbolNode[];
};

function flattenSymbols(symbols: SymbolNode[]): SymbolNode[] {
	const all: SymbolNode[] = [];
	for (const symbol of symbols) {
		all.push(symbol);
		if (symbol.children && symbol.children.length > 0) {
			all.push(...flattenSymbols(symbol.children));
		}
	}
	return all;
}

function pickLocalSymbolLocation(
	symbols: SymbolNode[],
	token: string,
	filePath: string,
): Array<{ uri: string; range: Record<string, unknown> }> {
	const flat = flattenSymbols(symbols).filter(
		(symbol) => symbol.name === token,
	);
	if (flat.length === 0) return [];
	const uri = pathToFileURL(filePath).href;
	return flat
		.map((symbol) => {
			if (symbol.location?.uri && symbol.location.range) {
				return { uri: symbol.location.uri, range: symbol.location.range };
			}
			if (symbol.range) {
				return { uri, range: symbol.range };
			}
			return undefined;
		})
		.filter((entry): entry is { uri: string; range: Record<string, unknown> } =>
			Boolean(entry),
		);
}

function classifyCodeActions(
	actions: Array<{ kind?: string }> | undefined,
): { quickfix: number; refactor: number; other: number } {
	if (!actions || actions.length === 0) return { quickfix: 0, refactor: 0, other: 0 };
	let quickfix = 0;
	let refactor = 0;
	let other = 0;
	for (const action of actions) {
		const kind = action.kind ?? "";
		if (kind.startsWith("quickfix")) quickfix += 1;
		else if (kind.startsWith("refactor")) refactor += 1;
		else other += 1;
	}
	return { quickfix, refactor, other };
}

async function openFileBestEffort(
	lspService: ReturnType<typeof getLSPService>,
	filePath: string,
	waitForDiagnostics = false,
): Promise<void> {
	let fileContent: string | undefined;
	try {
		fileContent = nodeFs.readFileSync(filePath, "utf-8");
	} catch {
		return;
	}
	if (!fileContent) return;
	try {
		if (typeof lspService.touchFile === "function") {
			await lspService.touchFile(filePath, fileContent, waitForDiagnostics);
		} else {
			await lspService.openFile(filePath, fileContent);
		}
	} catch {
		/* LSP server may not be ready yet — proceed anyway */
	}
}

export function createLspNavigationTool(
	getFlag: (name: string) => boolean | string | undefined,
) {
	return {
		name: "lsp_navigation" as const,
		label: "LSP Navigate",
			description:
			"Navigate code using LSP (Language Server Protocol). LSP is enabled by default; disable with --no-lsp.\n" +
			"Operations:\n" +
			"- definition: Jump to where a symbol is defined\n" +
			"- references: Find all usages of a symbol\n" +
			"- hover: Get type/doc info at a position\n" +
			"- signatureHelp: Show callable signatures at cursor\n" +
			"- documentSymbol: List all symbols (functions/classes/vars) in a file\n" +
			"- workspaceSymbol: Search symbols across the whole project (best with filePath context)\n" +
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
					description:
						"Symbol name to search. Used by workspaceSymbol (best with filePath for active project context).",
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
			const startedAt = Date.now();
			let supported: boolean | null = null;
			let diagnosticsMode: "pull" | "push-only" | "unknown" = "unknown";

			const finalize = (
				payload: {
					content: Array<{ type: "text"; text: string }>;
					isError?: boolean;
					details?: Record<string, unknown>;
				},
				meta: {
					operation: string;
					filePath: string;
					failureKind: string;
					resultCount: number;
				},
			) => {
				const normalizedFilePath = meta.filePath.replace(/\\/g, "/");
				logLatency({
					type: "phase",
					phase: "lsp_navigation_result",
					filePath: normalizedFilePath,
					durationMs: Date.now() - startedAt,
					metadata: {
						operation: meta.operation,
						failureKind: meta.failureKind,
						resultCount: meta.resultCount,
						supported,
						diagnosticsMode,
					},
				});

				return {
					...payload,
					details: {
						...(payload.details ?? {}),
						failureKind: meta.failureKind,
					},
				};
			};

			if (getFlag("no-lsp")) {
				return finalize(
					{
					content: [
						{
							type: "text" as const,
							text: "lsp_navigation requires LSP to be enabled. Remove --no-lsp to use LSP navigation.",
						},
					],
					isError: true,
					},
					{
						operation: "precheck",
						filePath: "(workspace)",
						failureKind: "lsp_disabled",
						resultCount: 0,
					},
				);
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

			const isCallHierarchyTraversal =
				operation === "incomingCalls" || operation === "outgoingCalls";
			const needsFilePath =
				operation !== "workspaceDiagnostics" &&
				operation !== "workspaceSymbol" &&
				!isCallHierarchyTraversal;
			if (needsFilePath && (!rawPath || rawPath.trim().length === 0)) {
				return finalize(
					{
					content: [
						{
							type: "text" as const,
							text: `filePath is required for ${operation}`,
						},
					],
					isError: true,
					},
					{
						operation,
						filePath: "(workspace)",
						failureKind: "missing_file_path",
						resultCount: 0,
					},
				);
			}

			const filePath = rawPath
				? path.isAbsolute(rawPath)
					? rawPath
					: path.resolve(ctx.cwd || ".", rawPath)
				: "";

			const lspService = getLSPService();
			if (operation === "workspaceDiagnostics") {
				const wsDiagSupport = await lspService.getWorkspaceDiagnosticsSupport(
					rawPath ? filePath : undefined,
				);
				diagnosticsMode = wsDiagSupport?.mode ?? "unknown";

				if (rawPath) {
					const hasLSP = await lspService.hasLSP(filePath);
					if (!hasLSP) {
						return finalize(
							{
								content: [
									{
										type: "text" as const,
										text: `No LSP server available for ${path.basename(filePath)}. Check that the language server is installed.`,
									},
								],
								isError: true,
							},
							{
								operation,
								filePath,
								failureKind: "no_server",
								resultCount: 0,
							},
						);
					}

					await openFileBestEffort(lspService, filePath, true);
					const diagnostics = await lspService.getDiagnostics(filePath);
					const result = [
						{
							filePath,
							diagnostics,
							count: diagnostics.length,
						},
					];
					const note =
						diagnosticsMode === "pull"
							? "Note: filePath mode requests pull diagnostics for this file and returns the aggregated result."
							: diagnosticsMode === "push-only"
								? "Note: server is push-only; result depends on published diagnostics for this file."
								: "Note: workspace diagnostics mode unknown (no active capability snapshot).";
					const resultCount = diagnostics.length;
					return finalize(
						{
							content: [
								{
									type: "text" as const,
									text: `${note}\n${JSON.stringify(result, null, 2)}`,
								},
							],
							details: {
								operation,
								resultCount,
								diagnosticsMode,
								coverage: "requested-file",
							},
						},
						{
							operation,
							filePath,
							failureKind: resultCount === 0 ? "empty_result" : "success",
							resultCount,
						},
					);
				}

				const allDiagnostics = await lspService.getAllDiagnostics();
				const result = Array.from(allDiagnostics.entries()).map(([trackedFile, diags]) => ({
					filePath: trackedFile,
					diagnostics: diags,
					count: diags.length,
				}));
				const note =
					diagnosticsMode === "push-only"
						? "Note: push-only tracked diagnostics snapshot (not full workspace pull diagnostics)."
						: diagnosticsMode === "pull"
							? "Note: tracked diagnostics snapshot from active clients. Provide filePath to force file-level diagnostics collection."
							: "Note: workspace diagnostics mode unknown (no active capability snapshot).";
				return finalize(
					{
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
					},
					{
						operation,
						filePath: rawPath ? filePath : "(workspace)",
						failureKind:
							diagnosticsMode === "push-only"
								? "tracked_snapshot"
								: "success",
						resultCount: result.length,
					},
				);
			}

			const hasLSP = filePath ? await lspService.hasLSP(filePath) : false;
			if (needsFilePath && !hasLSP) {
				return finalize(
					{
					content: [
						{
							type: "text" as const,
							text: `No LSP server available for ${path.basename(filePath)}. Check that the language server is installed.`,
						},
					],
					isError: true,
					},
					{
						operation,
						filePath,
						failureKind: "no_server",
						resultCount: 0,
					},
				);
			}

			if (needsFilePath) {
				const support = await lspService.getOperationSupport(filePath);
				supported = operationSupportStatus(operation, support);
				if (supported === false) {
					return finalize(
						{
						content: [
							{
								type: "text" as const,
								text: `LSP server for ${path.basename(filePath)} does not advertise support for ${operation}`,
							},
						],
						isError: true,
						details: { operation, supported: false, emptyReason: "unsupported" },
						},
						{ operation, filePath, failureKind: "unsupported", resultCount: 0 },
					);
				}

				await openFileBestEffort(lspService, filePath);
			}

			// Convert 1-based editor coords to 0-based LSP coords
			const lspLine = (line ?? 1) - 1;
			const lspChar = (character ?? 1) - 1;
			const lspEndLine = (endLine ?? line ?? 1) - 1;
			const lspEndChar = (endCharacter ?? character ?? 1) - 1;

			const runOperation = async (): Promise<unknown> => {
				switch (operation) {
					case "definition":
						return lspService.definition(filePath, lspLine, lspChar);
					case "references":
						return lspService.references(filePath, lspLine, lspChar);
					case "hover":
						return lspService.hover(filePath, lspLine, lspChar);
					case "signatureHelp":
						return lspService.signatureHelp(filePath, lspLine, lspChar);
					case "documentSymbol":
						return lspService.documentSymbol(filePath);
					case "workspaceSymbol":
						supported = operationSupportStatus(
							operation,
							await lspService.getOperationSupport(rawPath ? filePath : undefined),
						);
						if (supported === false) {
							throw new Error(
								"__UNSUPPORTED__ Active LSP server does not advertise support for workspaceSymbol",
							);
						}
						if (!query || query.trim().length === 0) {
							throw new Error("__BADINPUT__ query parameter required for workspaceSymbol");
						}
						if (rawPath) {
							await openFileBestEffort(lspService, filePath);
						}
						try {
							return await lspService.workspaceSymbol(
								query ?? "",
								rawPath ? filePath : undefined,
							);
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							if (rawPath && /No Project/i.test(msg)) {
								await openFileBestEffort(lspService, filePath);
								await new Promise((resolve) => setTimeout(resolve, 120));
								return lspService.workspaceSymbol(query ?? "", filePath);
							}
							throw err;
						}
					case "codeAction":
						return lspService.codeAction(
							filePath,
							lspLine,
							lspChar,
							lspEndLine,
							lspEndChar,
						);
					case "rename":
						if (!newName || newName.trim().length === 0) {
							throw new Error("__BADINPUT__ newName parameter required for rename");
						}
						return lspService.rename(filePath, lspLine, lspChar, newName);
					case "implementation":
						return lspService.implementation(filePath, lspLine, lspChar);
					case "prepareCallHierarchy":
						return lspService.prepareCallHierarchy(filePath, lspLine, lspChar);
					case "incomingCalls": {
						const callItem = (
							params as { callHierarchyItem?: LSPCallHierarchyItem }
						).callHierarchyItem;
						if (!callItem) {
							throw new Error(
								"__BADINPUT__ callHierarchyItem parameter required for incomingCalls",
							);
						}
						return lspService.incomingCalls(callItem);
					}
					case "outgoingCalls": {
						const callItem = (
							params as { callHierarchyItem?: LSPCallHierarchyItem }
						).callHierarchyItem;
						if (!callItem) {
							throw new Error(
								"__BADINPUT__ callHierarchyItem parameter required for outgoingCalls",
							);
						}
						return lspService.outgoingCalls(callItem);
					}
					default:
						return [];
				}
			};

			let result: unknown;
			let usedDocumentSymbolFallback = false;
			try {
				result = await runOperation();
				const isEmptyInitial =
					!result || (Array.isArray(result) && result.length === 0);
				const shouldRetryOnEmpty =
					isEmptyInitial &&
					needsFilePath &&
					[
						"definition",
						"references",
						"hover",
						"signatureHelp",
						"workspaceSymbol",
						"codeAction",
						"rename",
						"implementation",
					].includes(operation);
				if (shouldRetryOnEmpty) {
					await openFileBestEffort(lspService, filePath, true);
					result = await runOperation();
				}

				const stillEmpty =
					!result || (Array.isArray(result) && result.length === 0);
				if (
					stillEmpty &&
					needsFilePath &&
					(operation === "definition" || operation === "workspaceSymbol")
				) {
					const content = nodeFs.readFileSync(filePath, "utf-8");
					const token =
						operation === "workspaceSymbol"
							? (query?.trim() || undefined)
							: line && character
								? tokenAtPosition(content, line, character)
								: undefined;
					if (token) {
						const docSymbols = (await lspService.documentSymbol(filePath)) as SymbolNode[];
						const locations = pickLocalSymbolLocation(docSymbols, token, filePath);
						if (locations.length > 0) {
							result = locations;
							usedDocumentSymbolFallback = true;
						}
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.startsWith("__UNSUPPORTED__ ")) {
					return finalize(
						{
						content: [{ type: "text" as const, text: msg.replace("__UNSUPPORTED__ ", "") }],
						isError: true,
						details: { operation, supported: false, emptyReason: "unsupported" },
						},
						{ operation, filePath, failureKind: "unsupported", resultCount: 0 },
					);
				}
				if (msg.startsWith("__BADINPUT__ ")) {
					return finalize(
						{
						content: [{ type: "text" as const, text: msg.replace("__BADINPUT__ ", "") }],
						isError: true,
						details: {},
						},
						{ operation, filePath, failureKind: "bad_input", resultCount: 0 },
					);
				}
				return finalize(
					{
					content: [
						{
							type: "text" as const,
							text: `LSP error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: {},
					},
					{ operation, filePath, failureKind: "lsp_error", resultCount: 0 },
				);
			}

			const isEmpty = !result || (Array.isArray(result) && result.length === 0);
			let output = isEmpty
				? `No results for ${operation} at ${path.basename(filePath)}${line ? `:${line}:${character}` : ""}`
				: JSON.stringify(result, null, 2);
			if (isEmpty && operation === "workspaceSymbol" && !rawPath) {
				output +=
					"\nHint: provide filePath to scope workspaceSymbol to the active language server/root.";
			}
			if (usedDocumentSymbolFallback) {
				output += "\nNote: served from documentSymbol fallback due to empty primary result.";
			}
			if (
				operation === "references" &&
				Array.isArray(result) &&
				result.length <= 2
			) {
				output +=
					"\nHint: references from usage sites can be partial; retry from the symbol definition for broader cross-file results.";
			}
			const actionStats =
				operation === "codeAction" && Array.isArray(result)
					? classifyCodeActions(result as Array<{ kind?: string }>)
					: null;
			if (operation === "codeAction" && actionStats) {
				if (actionStats.quickfix === 0 && actionStats.refactor > 0) {
					output +=
						"\nNote: no diagnostic quick fixes returned; refactor-only actions available.";
				}
			}

			const resultCount = Array.isArray(result) ? result.length : result ? 1 : 0;
			return finalize(
				{
					content: [{ type: "text" as const, text: output }],
					details: {
						operation,
						supported,
						emptyReason: isEmpty ? emptyReasonForOperation(operation) : undefined,
						codeActionKinds: actionStats ?? undefined,
						resultCount,
					},
				},
				{
					operation,
					filePath: rawPath ? filePath : "(workspace)",
					failureKind: isEmpty
						? "empty_result"
						: usedDocumentSymbolFallback
							? "fallback_success"
							: "success",
					resultCount,
				},
			);
		},
	};
}
