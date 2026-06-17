/**
 * lsp_navigation tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import * as nodeFs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import { logLatency } from "../clients/latency-logger.js";
import type { LSPCallHierarchyItem } from "../clients/lsp/client.js";
import {
	applyWorkspaceEdit,
	summarizeWorkspaceEdit,
} from "../clients/lsp/edits.js";
import { getLSPService } from "../clients/lsp/index.js";
import type { SearchReadLocation } from "../clients/search-read-registration.js";

const VALID_OPERATIONS = [
	"definition",
	"typeDefinition",
	"declaration",
	"references",
	"hover",
	"signatureHelp",
	"documentSymbol",
	"findSymbol",
	"workspaceSymbol",
	"codeAction",
	"rename",
	"rename_file",
	"implementation",
	"prepareCallHierarchy",
	"incomingCalls",
	"outgoingCalls",
	"executeCommand",
	"workspaceDiagnostics",
	"capabilities",
] as const;

type LspNavigationOperation = (typeof VALID_OPERATIONS)[number];

function normalizeOperation(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim().replace(/^["']+|["']+$/g, "");
}

function isValidOperation(value: string): value is LspNavigationOperation {
	return (VALID_OPERATIONS as readonly string[]).includes(value);
}

function operationSupportStatus(
	operation: LspNavigationOperation,
	support: import("../clients/lsp/client.js").LSPOperationSupport | null,
): boolean | null {
	if (!support) return null;
	if (operation === "definition") return support.definition;
	if (operation === "typeDefinition") return support.typeDefinition;
	if (operation === "declaration") return support.declaration;
	if (operation === "references") return support.references;
	if (operation === "hover") return support.hover;
	if (operation === "signatureHelp") return support.signatureHelp;
	if (operation === "documentSymbol" || operation === "findSymbol")
		return support.documentSymbol;
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

function emptyReasonForOperation(operation: LspNavigationOperation): string {
	if (operation === "signatureHelp")
		return "position-sensitive-or-no-signature";
	if (operation === "codeAction") return "no-applicable-actions";
	if (operation === "rename") return "no-rename-edits-or-symbol-not-renamable";
	if (operation === "rename_file") return "no-file-rename-result";
	if (operation === "findSymbol") return "no-matching-symbols";
	if (operation === "workspaceSymbol")
		return "no-matching-symbols-or-server-index-unavailable";
	if (operation === "capabilities") return "no-active-lsp-servers";
	if (operation === "executeCommand") return "command-returned-no-result";
	if (operation === "incomingCalls" || operation === "outgoingCalls")
		return "no-call-hierarchy-results";
	return "no-results";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type SymbolColumnResolution = {
	character: number;
	requestedSymbol?: string;
	baseSymbol?: string;
	requestedOccurrence?: number;
	usedOccurrence?: number;
	strategy: "explicit" | "word-boundary" | "case-insensitive" | "fallback";
	debug?: string;
};

function parseSymbolSelector(symbol: string): {
	baseSymbol: string;
	occurrence: number;
	debug?: string;
} {
	const trimmed = symbol.trim();
	const match = /^([^#]*)(?:#(-?\d+))?$/.exec(trimmed);
	const baseSymbol = (match?.[1] ?? trimmed).trim();
	const rawOccurrence = match?.[2];
	if (!rawOccurrence) return { baseSymbol, occurrence: 1 };
	const occurrence = Number.parseInt(rawOccurrence, 10);
	if (!Number.isFinite(occurrence) || occurrence < 1) {
		return {
			baseSymbol,
			occurrence: 1,
			debug: `invalid occurrence selector #${rawOccurrence}; using #1`,
		};
	}
	return { baseSymbol, occurrence };
}

function findNthMatch(
	lineText: string,
	regex: RegExp,
	occurrence: number,
): RegExpExecArray | null {
	let seen = 0;
	regex.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(lineText)) !== null) {
		seen += 1;
		if (seen === occurrence) return match;
		if (match[0].length === 0) regex.lastIndex += 1;
	}
	return null;
}

function firstNonWhitespaceCharacter(lineText: string): number {
	const match = /\S/.exec(lineText);
	return (match?.index ?? 0) + 1;
}

function resolveSymbolColumn(
	content: string,
	line1: number,
	character: number | undefined,
	symbol: string | undefined,
): SymbolColumnResolution {
	if (typeof character === "number" && character > 0) {
		return { character, strategy: "explicit" };
	}

	const lineText = content.split(/\r?\n/)[line1 - 1] ?? "";
	if (!symbol || symbol.trim().length === 0) {
		return {
			character: 1,
			strategy: "fallback",
			debug: "character omitted and no symbol supplied; using column 1",
		};
	}

	const { baseSymbol, occurrence, debug } = parseSymbolSelector(symbol);
	if (!baseSymbol) {
		return {
			character: firstNonWhitespaceCharacter(lineText),
			requestedSymbol: symbol,
			baseSymbol,
			requestedOccurrence: occurrence,
			usedOccurrence: 1,
			strategy: "fallback",
			debug:
				debug ?? "empty symbol selector; using first non-whitespace column",
		};
	}

	const pattern = `\\b${escapeRegExp(baseSymbol)}\\b`;
	const exactRegex = new RegExp(pattern, "g");
	const exact = findNthMatch(lineText, exactRegex, occurrence);
	if (exact) {
		return {
			character: exact.index + 1,
			requestedSymbol: symbol,
			baseSymbol,
			requestedOccurrence: occurrence,
			usedOccurrence: occurrence,
			strategy: "word-boundary",
			debug,
		};
	}

	const firstExact = findNthMatch(lineText, exactRegex, 1);
	if (firstExact && occurrence !== 1) {
		return {
			character: firstExact.index + 1,
			requestedSymbol: symbol,
			baseSymbol,
			requestedOccurrence: occurrence,
			usedOccurrence: 1,
			strategy: "word-boundary",
			debug: `${debug ? `${debug}; ` : ""}occurrence #${occurrence} not found; using #1`,
		};
	}

	const insensitiveRegex = new RegExp(pattern, "gi");
	const insensitive = findNthMatch(lineText, insensitiveRegex, occurrence);
	if (insensitive) {
		return {
			character: insensitive.index + 1,
			requestedSymbol: symbol,
			baseSymbol,
			requestedOccurrence: occurrence,
			usedOccurrence: occurrence,
			strategy: "case-insensitive",
			debug:
				debug ?? "exact-case symbol not found; used case-insensitive match",
		};
	}

	const firstInsensitive = findNthMatch(lineText, insensitiveRegex, 1);
	if (firstInsensitive && occurrence !== 1) {
		return {
			character: firstInsensitive.index + 1,
			requestedSymbol: symbol,
			baseSymbol,
			requestedOccurrence: occurrence,
			usedOccurrence: 1,
			strategy: "case-insensitive",
			debug: `${debug ? `${debug}; ` : ""}occurrence #${occurrence} not found case-insensitively; using #1`,
		};
	}

	return {
		character: firstNonWhitespaceCharacter(lineText),
		requestedSymbol: symbol,
		baseSymbol,
		requestedOccurrence: occurrence,
		usedOccurrence: 1,
		strategy: "fallback",
		debug: `${debug ? `${debug}; ` : ""}symbol not found on line; using first non-whitespace column`,
	};
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
	const isWord = (ch: string | undefined) => !!ch && /[A-Za-z0-9_?!]/.test(ch);

	let left = idx;
	let right = idx;
	if (!isWord(chars[idx]) && isWord(chars[idx + 1])) {
		left = idx + 1;
		right = idx + 1;
	}
	while (left > 0 && isWord(chars[left - 1])) left -= 1;
	while (right < chars.length - 1 && isWord(chars[right + 1])) right += 1;
	const token = chars
		.slice(left, right + 1)
		.join("")
		.trim();
	return token.length > 0 ? token : undefined;
}

type SymbolNode = {
	name?: string;
	kind?: number;
	detail?: string;
	location?: { uri: string; range: Record<string, unknown> };
	range?: Record<string, unknown>;
	selectionRange?: Record<string, unknown>;
	children?: SymbolNode[];
};

type SymbolMatch = {
	name: string;
	kind: string;
	kindCode?: number;
	detail?: string;
	line?: number;
	character?: number;
	depth: number;
	location?: { uri: string; range: Record<string, unknown> };
	range?: Record<string, unknown>;
};

const SYMBOL_KIND_LABELS: Record<number, string> = {
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enumMember",
	23: "struct",
	24: "event",
	25: "operator",
	26: "typeParameter",
};

function symbolKindLabel(kind: number | undefined): string {
	return kind == null ? "symbol" : (SYMBOL_KIND_LABELS[kind] ?? "symbol");
}

function rangeStart(range: Record<string, unknown> | undefined): {
	line?: number;
	character?: number;
} {
	const start = range?.start as
		| { line?: unknown; character?: unknown }
		| undefined;
	return {
		line: typeof start?.line === "number" ? start.line + 1 : undefined,
		character:
			typeof start?.character === "number" ? start.character + 1 : undefined,
	};
}

function findSymbolMatches(
	symbols: SymbolNode[],
	query: string,
	options: {
		maxResults: number;
		topLevelOnly: boolean;
		exactMatch: boolean;
		kinds: Set<string>;
	},
): SymbolMatch[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return [];
	const matches: SymbolMatch[] = [];

	const matchesText = (symbol: SymbolNode): boolean => {
		const values = [symbol.name, symbol.detail]
			.filter((value): value is string => Boolean(value))
			.map((value) => value.trim().toLowerCase());
		return options.exactMatch
			? values.some((value) => value === normalizedQuery)
			: values.some((value) => value.includes(normalizedQuery));
	};

	const matchesKind = (symbol: SymbolNode): boolean => {
		if (options.kinds.size === 0) return true;
		return options.kinds.has(symbolKindLabel(symbol.kind).toLowerCase());
	};

	const visit = (entries: SymbolNode[], depth: number): void => {
		for (const symbol of entries) {
			if (symbol.name && matchesText(symbol) && matchesKind(symbol)) {
				const preferredRange = symbol.selectionRange ?? symbol.range;
				const start = rangeStart(preferredRange);
				matches.push({
					name: symbol.name,
					kind: symbolKindLabel(symbol.kind),
					kindCode: symbol.kind,
					detail: symbol.detail,
					line: start.line,
					character: start.character,
					depth,
					location: symbol.location,
					range: preferredRange,
				});
				if (matches.length >= options.maxResults) return;
			}
			if (!options.topLevelOnly && symbol.children?.length) {
				visit(symbol.children, depth + 1);
				if (matches.length >= options.maxResults) return;
			}
		}
	};

	visit(symbols, 1);
	return matches;
}

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

function workspaceSymbolDedupeKey(symbol: SymbolNode): string {
	const location = symbol.location;
	const start = rangeStart(
		location?.range ?? symbol.range ?? symbol.selectionRange,
	);
	return [
		symbol.name ?? "",
		symbol.detail ?? "",
		symbol.kind ?? "",
		location?.uri ?? "",
		start.line ?? "",
		start.character ?? "",
	].join(":");
}

function dedupeWorkspaceSymbols<T extends SymbolNode>(symbols: T[]): T[] {
	const out: T[] = [];
	const seen = new Set<string>();
	for (const symbol of symbols) {
		const key = workspaceSymbolDedupeKey(symbol);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(symbol);
	}
	return out;
}

type RangeLike = {
	start?: { line?: unknown };
	end?: { line?: unknown };
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function searchReadFromUriRange(
	uri: unknown,
	range: unknown,
): SearchReadLocation | undefined {
	if (typeof uri !== "string" || !uri.startsWith("file:")) return undefined;
	const rangeLike = asRecord(range) as RangeLike | undefined;
	const startLine = rangeLike?.start?.line;
	if (typeof startLine !== "number" || !Number.isFinite(startLine)) {
		return undefined;
	}
	const endLine = rangeLike?.end?.line;
	try {
		return {
			file: fileURLToPath(uri),
			startLine: Math.max(1, Math.floor(startLine) + 1),
			endLine:
				typeof endLine === "number" && Number.isFinite(endLine)
					? Math.max(1, Math.floor(endLine) + 1)
					: undefined,
		};
	} catch {
		return undefined;
	}
}

function pushSearchRead(
	out: SearchReadLocation[],
	uri: unknown,
	range: unknown,
): void {
	const loc = searchReadFromUriRange(uri, range);
	if (loc) out.push(loc);
}

function collectLocationSearchReads(result: unknown): SearchReadLocation[] {
	const out: SearchReadLocation[] = [];
	for (const entry of Array.isArray(result) ? result : [result]) {
		const record = asRecord(entry);
		if (!record) continue;
		pushSearchRead(out, record.uri, record.range);
		pushSearchRead(
			out,
			record.targetUri,
			record.targetSelectionRange ?? record.targetRange,
		);
	}
	return out;
}

function collectWorkspaceSymbolSearchReads(
	result: unknown,
): SearchReadLocation[] {
	const out: SearchReadLocation[] = [];
	for (const entry of Array.isArray(result) ? result : [result]) {
		const symbol = asRecord(entry);
		const location = asRecord(symbol?.location);
		if (!location) continue;
		pushSearchRead(out, location.uri, location.range);
		pushSearchRead(
			out,
			location.targetUri,
			location.targetSelectionRange ?? location.targetRange,
		);
	}
	return out;
}

function collectCallHierarchySearchReads(
	result: unknown,
	operation: "incomingCalls" | "outgoingCalls",
	callHierarchyItem: LSPCallHierarchyItem | undefined,
): SearchReadLocation[] {
	const out: SearchReadLocation[] = [];
	for (const entry of Array.isArray(result) ? result : [result]) {
		const record = asRecord(entry);
		if (!record) continue;
		const item = asRecord(
			operation === "incomingCalls" ? record.from : record.to,
		);
		pushSearchRead(out, item?.uri, item?.selectionRange ?? item?.range);
		const rangeUri =
			operation === "incomingCalls" ? item?.uri : callHierarchyItem?.uri;
		const fromRanges = record.fromRanges;
		if (Array.isArray(fromRanges)) {
			for (const range of fromRanges) pushSearchRead(out, rangeUri, range);
		}
	}
	return out;
}

function collectSearchReadsForOperation(
	operation: LspNavigationOperation,
	result: unknown,
	callHierarchyItem?: LSPCallHierarchyItem,
): SearchReadLocation[] {
	if (
		[
			"definition",
			"typeDefinition",
			"declaration",
			"references",
			"implementation",
		].includes(operation)
	) {
		return collectLocationSearchReads(result);
	}
	if (operation === "workspaceSymbol") {
		return collectWorkspaceSymbolSearchReads(result);
	}
	if (operation === "incomingCalls" || operation === "outgoingCalls") {
		return collectCallHierarchySearchReads(
			result,
			operation,
			callHierarchyItem,
		);
	}
	return [];
}

type CapabilitySnapshot = {
	serverId: string;
	root: string;
	operationSupport: {
		definition: boolean;
		typeDefinition: boolean;
		declaration: boolean;
		references: boolean;
		hover: boolean;
		signatureHelp: boolean;
		documentSymbol: boolean;
		workspaceSymbol: boolean;
		codeAction: boolean;
		rename: boolean;
		implementation: boolean;
		callHierarchy: boolean;
	};
	workspaceDiagnosticsSupport: { advertised?: boolean; mode?: string };
	advertisedCommands?: string[];
};

function formatCapabilities(
	snapshots: CapabilitySnapshot[],
	filePath?: string,
): string {
	if (snapshots.length === 0) {
		return filePath
			? `No active LSP server for ${path.basename(filePath)}. Open/touch the file first or run another LSP operation to start the server.`
			: "No active LSP servers in this session.";
	}

	const rows: Array<
		[string, (snapshot: CapabilitySnapshot) => boolean, string?]
	> = [
		["definition", (s) => !!s.operationSupport.definition],
		["typeDefinition", (s) => !!s.operationSupport.typeDefinition],
		["declaration", (s) => !!s.operationSupport.declaration],
		["references", (s) => !!s.operationSupport.references],
		["hover", (s) => !!s.operationSupport.hover],
		["rename", (s) => !!s.operationSupport.rename],
		["codeAction", (s) => !!s.operationSupport.codeAction],
		["workspaceSymbol", (s) => !!s.operationSupport.workspaceSymbol],
		["implementation", (s) => !!s.operationSupport.implementation],
		["signatureHelp", (s) => !!s.operationSupport.signatureHelp],
		["incomingCalls", (s) => !!s.operationSupport.callHierarchy],
		["outgoingCalls", (s) => !!s.operationSupport.callHierarchy],
		[
			"workspaceDiagnostics",
			(s) => s.workspaceDiagnosticsSupport.mode === "pull",
			"pull diagnostics",
		],
		[
			"rename_file",
			() => true,
			"willRenameFiles/didRenameFiles helper available",
		],
	];

	const lines: string[] = [];
	for (const snapshot of snapshots) {
		const label = filePath
			? `${snapshot.serverId} (${path.basename(filePath)})`
			: `${snapshot.serverId} (${snapshot.root})`;
		lines.push(label);
		for (const [name, supported, note] of rows) {
			const suffix = note ? `  (${note})` : "";
			lines.push(
				`  ${name.padEnd(22)} ${supported(snapshot) ? "✓" : "✗"}${suffix}`,
			);
		}
		const commands = snapshot.advertisedCommands ?? [];
		lines.push(
			`  ${"executeCommand".padEnd(22)} ${commands.length > 0 ? "✓" : "✗"}` +
				`  (${commands.length} advertised command(s)` +
				(commands.length > 0 ? `: ${commands.slice(0, 20).join(", ")}` : "") +
				")",
		);
	}
	return lines.join("\n");
}

function classifyCodeActions(actions: Array<{ kind?: string }> | undefined): {
	quickfix: number;
	refactor: number;
	other: number;
} {
	if (!actions || actions.length === 0)
		return { quickfix: 0, refactor: 0, other: 0 };
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
			await lspService.touchFile(filePath, fileContent, {
				diagnostics: waitForDiagnostics ? "document" : "none",
				source: "lsp_navigation",
				clientScope: waitForDiagnostics ? "all" : "primary",
			});
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
			"- typeDefinition: Jump to the definition of a symbol's TYPE (e.g. the class/interface of a variable)\n" +
			"- declaration: Jump to a symbol's declaration (e.g. an extern/forward decl, distinct from its definition)\n" +
			"- references: Find all usages of a symbol\n" +
			"- hover: Get type/doc info at a position\n" +
			"- signatureHelp: Show callable signatures at cursor\n" +
			"- documentSymbol: List all symbols (functions/classes/vars) in a file\n" +
			"- findSymbol: Search document symbols in a file by name/detail with optional kind/top-level/exact filters\n" +
			"- workspaceSymbol: Search symbols across the whole project (best with filePath context)\n" +
			"- codeAction: Find available quick fixes/refactors at a range\n" +
			"- rename: Compute or apply workspace edits for renaming a symbol\n" +
			"- rename_file: Preview/apply LSP-aware source file rename notifications\n" +
			"- implementation: Jump to interface implementations\n" +
			"- prepareCallHierarchy: Get callable item at position (for incoming/outgoing)\n" +
			"- incomingCalls: Find all functions/methods that CALL this function\n" +
			"- outgoingCalls: Find all functions/methods CALLED by this function\n" +
			"- executeCommand: Run a server-advertised command via workspace/executeCommand. HARDENED: allowlisted to commands the server advertised; dry-run by default (reports whether advertised) — set apply:true to actually run. Pass command (+ optional commandArguments).\n" +
			"- workspaceDiagnostics: List all diagnostics tracked by active LSP clients\n" +
			"- capabilities: Show cached operation support for active LSP servers\n\n" +
			"Line and character are 1-based (as shown in editors). For position-based operations, prefer passing symbol when you know the line but not the exact character; character can be omitted or -1 and pi-lens will resolve the symbol column. Use symbol#N for repeated symbols on the same line (1-based occurrence).",
		promptSnippet:
			"Use lsp_navigation to find definitions, references, and hover info via LSP",
		parameters: Type.Object({
			operation: Type.String({
				description:
					"LSP operation to perform. Valid values: " +
					VALID_OPERATIONS.join(", "),
			}),
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
						"Character offset (1-based). Optional when symbol is provided; use -1 to force symbol-column resolution.",
				}),
			),
			symbol: Type.Optional(
				Type.String({
					description:
						"Symbol name on the target line for automatic character resolution. Use symbol#N to select the Nth occurrence on the line.",
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
			newFilePath: Type.Optional(
				Type.String({
					description: "Required for rename_file operation.",
				}),
			),
			apply: Type.Optional(
				Type.Boolean({
					description:
						"rename/executeCommand: apply for real. rename defaults to preview; executeCommand defaults to a dry-run that only reports whether the command is advertised — set apply:true to actually run it.",
				}),
			),
			command: Type.Optional(
				Type.String({
					description:
						"executeCommand only: the server command id to run. Must be one the server advertised (see the capabilities operation).",
				}),
			),
			commandArguments: Type.Optional(
				Type.Array(Type.Unknown(), {
					description:
						"executeCommand only: arguments array passed to workspace/executeCommand.",
				}),
			),
			query: Type.Optional(
				Type.String({
					description:
						"Symbol name to search. Used by workspaceSymbol and findSymbol.",
				}),
			),
			kinds: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"findSymbol only: restrict matches to symbol kind labels such as function, class, method, variable, interface.",
				}),
			),
			exactMatch: Type.Optional(
				Type.Boolean({
					description:
						"findSymbol only: match whole symbol names/details exactly instead of substring matching.",
				}),
			),
			topLevelOnly: Type.Optional(
				Type.Boolean({
					description: "findSymbol only: do not search nested child symbols.",
				}),
			),
			maxResults: Type.Optional(
				Type.Number({
					description:
						"findSymbol only: maximum matches to return. Default 20.",
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
			let columnResolution: SymbolColumnResolution | undefined;

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
			): typeof payload & {
				details: typeof payload.details & {
					failureKind: string;
				};
			} => {
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
						columnResolution,
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
				operation: rawOperation,
				filePath: rawPath,
				line,
				character,
				symbol,
				endLine,
				endCharacter,
				newName,
				newFilePath,
				apply,
				command,
				commandArguments,
				query,
				kinds,
				exactMatch,
				topLevelOnly,
				maxResults,
				callHierarchyItem,
			} = params as {
				operation: string;
				filePath?: string;
				line?: number;
				character?: number;
				symbol?: string;
				endLine?: number;
				endCharacter?: number;
				newName?: string;
				newFilePath?: string;
				apply?: boolean;
				command?: string;
				commandArguments?: unknown[];
				query?: string;
				kinds?: string[];
				exactMatch?: boolean;
				topLevelOnly?: boolean;
				maxResults?: number;
				callHierarchyItem?: LSPCallHierarchyItem;
			};
			const normalizedOperation = normalizeOperation(rawOperation);
			if (!isValidOperation(normalizedOperation)) {
				return finalize(
					{
						content: [
							{
								type: "text" as const,
								text:
									`Unknown lsp_navigation operation "${normalizedOperation || String(rawOperation ?? "") || ""}". ` +
									`Valid operations: ${VALID_OPERATIONS.join(", ")}`,
							},
						],
						isError: true,
						details: {
							rawOperation,
							normalizedOperation,
							validOperations: VALID_OPERATIONS,
						},
					},
					{
						operation: normalizedOperation || "invalid",
						filePath: "(workspace)",
						failureKind: "invalid_operation",
						resultCount: 0,
					},
				);
			}
			const operation = normalizedOperation;

			const isCallHierarchyTraversal =
				operation === "incomingCalls" || operation === "outgoingCalls";
			const needsFilePath =
				operation !== "workspaceDiagnostics" &&
				operation !== "workspaceSymbol" &&
				operation !== "executeCommand" &&
				operation !== "capabilities" &&
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

			let filePathIsDirectory = false;
			if (filePath) {
				try {
					filePathIsDirectory = nodeFs.statSync(filePath).isDirectory();
				} catch {
					// non-existent path — existing error paths handle this
				}
			}

			const lspService = getLSPService();
			if (operation === "capabilities") {
				const snapshots = await lspService.getCapabilitySnapshots(
					rawPath ? filePath : undefined,
				);
				const output = formatCapabilities(
					snapshots,
					rawPath ? filePath : undefined,
				);
				return finalize(
					{
						content: [{ type: "text" as const, text: output }],
						details: {
							operation,
							resultCount: snapshots.length,
							servers: snapshots.map((snapshot) => snapshot.serverId),
						},
					},
					{
						operation,
						filePath: rawPath ? filePath : "(workspace)",
						failureKind: snapshots.length === 0 ? "empty_result" : "success",
						resultCount: snapshots.length,
					},
				);
			}

			if (operation === "workspaceDiagnostics") {
				const wsDiagSupport = await lspService.getWorkspaceDiagnosticsSupport(
					rawPath ? filePath : undefined,
				);
				diagnosticsMode = wsDiagSupport?.mode ?? "unknown";

				if (rawPath && !filePathIsDirectory) {
					const hasLSP = lspService.supportsLSP(filePath);
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
					const noteMap: Record<string, string> = {
						pull: "Note: filePath mode requests pull diagnostics for this file and returns the aggregated result.",
						"push-only":
							"Note: server is push-only; result depends on published diagnostics for this file.",
					};
					const note =
						noteMap[diagnosticsMode] ??
						"Note: workspace diagnostics mode unknown (no active capability snapshot).";
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
				const result = Array.from(allDiagnostics.entries()).map(
					([trackedFile, { diags }]) => ({
						filePath: trackedFile,
						diagnostics: diags,
						count: diags.length,
					}),
				);
				const noteMap2: Record<string, string> = {
					"push-only":
						"Note: push-only tracked diagnostics snapshot (not full workspace pull diagnostics).",
					pull: "Note: tracked diagnostics snapshot from active clients. Provide filePath to force file-level diagnostics collection.",
				};
				const note =
					noteMap2[diagnosticsMode] ??
					"Note: workspace diagnostics mode unknown (no active capability snapshot).";
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
							diagnosticsMode === "push-only" ? "tracked_snapshot" : "success",
						resultCount: result.length,
					},
				);
			}

			if (needsFilePath && filePathIsDirectory) {
				return finalize(
					{
						content: [
							{
								type: "text" as const,
								text: `filePath must be a source file, got directory: ${filePath}. Pass a source file path, or omit filePath for workspace-level operations.`,
							},
						],
						isError: true,
					},
					{
						operation,
						filePath,
						failureKind: "filepath_is_directory",
						resultCount: 0,
					},
				);
			}

			const hasLSP = filePath ? lspService.supportsLSP(filePath) : false;
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
							details: {
								operation,
								supported: false,
								emptyReason: "unsupported",
							},
						},
						{ operation, filePath, failureKind: "unsupported", resultCount: 0 },
					);
				}

				await openFileBestEffort(lspService, filePath);
			}

			// Convert 1-based editor coords to 0-based LSP coords.
			const lspLine = (line ?? 1) - 1;
			const needsPosition = [
				"definition",
				"typeDefinition",
				"declaration",
				"references",
				"hover",
				"signatureHelp",
				"codeAction",
				"rename",
				"implementation",
				"prepareCallHierarchy",
			].includes(operation);
			const resolvedCharacter =
				needsPosition && filePath
					? resolveSymbolColumn(
							nodeFs.existsSync(filePath)
								? nodeFs.readFileSync(filePath, "utf-8")
								: "",
							line ?? 1,
							character,
							symbol,
						)
					: ({
							character: character ?? 1,
							strategy: "explicit",
						} satisfies SymbolColumnResolution);
			columnResolution = resolvedCharacter;
			const lspChar = resolvedCharacter.character - 1;
			const lspEndLine = (endLine ?? line ?? 1) - 1;
			const lspEndChar = (endCharacter ?? resolvedCharacter.character) - 1;

			const runOperation = async (): Promise<unknown> => {
				switch (operation) {
					case "definition":
						return lspService.definition(filePath, lspLine, lspChar);
					case "typeDefinition":
						return lspService.typeDefinition(filePath, lspLine, lspChar);
					case "declaration":
						return lspService.declaration(filePath, lspLine, lspChar);
					case "references":
						return lspService.references(filePath, lspLine, lspChar);
					case "hover":
						return lspService.hover(filePath, lspLine, lspChar);
					case "signatureHelp":
						return lspService.signatureHelp(filePath, lspLine, lspChar);
					case "documentSymbol":
						return lspService.documentSymbol(filePath);
					case "findSymbol": {
						if (!query || query.trim().length === 0) {
							throw new Error(
								"__BADINPUT__ query parameter required for findSymbol",
							);
						}
						const symbols = (await lspService.documentSymbol(
							filePath,
						)) as SymbolNode[];
						return findSymbolMatches(symbols, query, {
							maxResults: Math.max(1, Math.min(100, maxResults ?? 20)),
							topLevelOnly: topLevelOnly ?? false,
							exactMatch: exactMatch ?? false,
							kinds: new Set(
								(kinds ?? [])
									.map((kind) => kind.trim().toLowerCase())
									.filter(Boolean),
							),
						});
					}
					case "workspaceSymbol":
						supported = operationSupportStatus(
							operation,
							await lspService.getOperationSupport(
								rawPath ? filePath : undefined,
							),
						);
						if (supported === false) {
							throw new Error(
								"__UNSUPPORTED__ Active LSP server does not advertise support for workspaceSymbol",
							);
						}
						if (!query || query.trim().length === 0) {
							throw new Error(
								"__BADINPUT__ query parameter required for workspaceSymbol",
							);
						}
						if (rawPath) {
							await openFileBestEffort(lspService, filePath);
						}
						try {
							const raw = await lspService.workspaceSymbol(
								query ?? "",
								rawPath ? filePath : undefined,
							);
							// Filter to navigable symbol kinds and cap results to save context tokens
							const NAVIGABLE_KINDS = new Set([
								5, // Class
								6, // Method
								8, // Field
								11, // Interface
								12, // Function
								13, // Variable
								22, // EnumMember
								23, // Struct
							]);
							const filtered = (Array.isArray(raw) ? raw : [raw]).filter(
								(s) =>
									typeof s === "object" &&
									s !== null &&
									(!s.kind || NAVIGABLE_KINDS.has(s.kind)),
							) as SymbolNode[];
							return dedupeWorkspaceSymbols(filtered).slice(0, 15);
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							if (rawPath && /No Project/i.test(msg)) {
								await openFileBestEffort(lspService, filePath);
								await new Promise((resolve) => setTimeout(resolve, 120));
								const retryRaw = await lspService.workspaceSymbol(
									query ?? "",
									filePath,
								);
								const retrySymbols = (
									Array.isArray(retryRaw) ? retryRaw : [retryRaw]
								).filter(
									(s) => typeof s === "object" && s !== null,
								) as SymbolNode[];
								return dedupeWorkspaceSymbols(retrySymbols);
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
					case "rename": {
						if (!newName || newName.trim().length === 0) {
							throw new Error(
								"__BADINPUT__ newName parameter required for rename",
							);
						}
						const edit = await lspService.rename(
							filePath,
							lspLine,
							lspChar,
							newName,
						);
						if (!edit) return null;
						if (!apply) {
							return {
								applied: false,
								summary: summarizeWorkspaceEdit(edit, ctx.cwd || "."),
								edit,
							};
						}
						const applied = await applyWorkspaceEdit(edit, ctx.cwd || ".");
						for (const touchedFile of applied.files) {
							try {
								await openFileBestEffort(lspService, touchedFile, false);
							} catch {
								// Best-effort LSP resync only; disk edit already succeeded.
							}
						}
						return { applied: true, ...applied };
					}
					case "rename_file": {
						if (!newFilePath || newFilePath.trim().length === 0) {
							throw new Error(
								"__BADINPUT__ newFilePath parameter required for rename_file",
							);
						}
						const resolvedNewFilePath = path.isAbsolute(newFilePath)
							? newFilePath
							: path.resolve(ctx.cwd || ".", newFilePath);
						const result = await lspService.renameFile(
							filePath,
							resolvedNewFilePath,
							{
								cwd: ctx.cwd || ".",
								apply: apply ?? false,
							},
						);
						if (result.applied) {
							for (const touchedFile of result.files ?? []) {
								try {
									await openFileBestEffort(lspService, touchedFile, false);
								} catch {
									// Best-effort LSP resync only; disk edit already succeeded.
								}
							}
						}
						return result;
					}
					case "implementation":
						return lspService.implementation(filePath, lspLine, lspChar);
					case "prepareCallHierarchy":
						return lspService.prepareCallHierarchy(filePath, lspLine, lspChar);
					case "executeCommand": {
						if (!command || command.trim().length === 0) {
							throw new Error(
								"__BADINPUT__ command parameter required for executeCommand",
							);
						}
						const advertised = await lspService.getAdvertisedCommands(
							rawPath ? filePath : undefined,
						);
						const isAdvertised = advertised.includes(command);
						// Dry-run by default: report advertisement status without running.
						// Mutation only on explicit apply:true (and the client re-checks
						// the allowlist — defense in depth).
						if (apply !== true) {
							return {
								executed: false,
								dryRun: true,
								command,
								advertised: isAdvertised,
								advertisedCommands: advertised,
								note: isAdvertised
									? "Command is advertised. Re-run with apply:true to execute."
									: "Command is NOT advertised by the active server; execution would be refused.",
							};
						}
						if (!isAdvertised) {
							throw new Error(
								`__UNSUPPORTED__ command "${command}" is not advertised by the active LSP server (advertised: ${advertised.join(", ") || "none"})`,
							);
						}
						return lspService.executeCommand(
							rawPath ? filePath : undefined,
							command,
							commandArguments,
						);
					}
					case "incomingCalls": {
						if (!callHierarchyItem) {
							throw new Error(
								"__BADINPUT__ callHierarchyItem parameter required for incomingCalls",
							);
						}
						return lspService.incomingCalls(callHierarchyItem);
					}
					case "outgoingCalls": {
						if (!callHierarchyItem) {
							throw new Error(
								"__BADINPUT__ callHierarchyItem parameter required for outgoingCalls",
							);
						}
						return lspService.outgoingCalls(callHierarchyItem);
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
						"typeDefinition",
						"declaration",
						"references",
						"hover",
						"signatureHelp",
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
				if (stillEmpty && needsFilePath && operation === "definition") {
					const content = nodeFs.readFileSync(filePath, "utf-8");
					const token =
						line && character
							? tokenAtPosition(content, line, character)
							: undefined;
					if (token) {
						const docSymbols = (await lspService.documentSymbol(
							filePath,
						)) as SymbolNode[];
						const locations = pickLocalSymbolLocation(
							docSymbols,
							token,
							filePath,
						);
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
							content: [
								{
									type: "text" as const,
									text: msg.replace("__UNSUPPORTED__ ", ""),
								},
							],
							isError: true,
							details: {
								operation,
								supported: false,
								emptyReason: "unsupported",
							},
						},
						{ operation, filePath, failureKind: "unsupported", resultCount: 0 },
					);
				}
				if (msg.startsWith("__BADINPUT__ ")) {
					return finalize(
						{
							content: [
								{
									type: "text" as const,
									text: msg.replace("__BADINPUT__ ", ""),
								},
							],
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
			const fileCtx = filePath ? " at " + path.basename(filePath) : "";
			const lineCtx = line ? ":" + line + ":" + character : "";
			let output = isEmpty
				? "No results for " + operation + fileCtx + lineCtx
				: JSON.stringify(result, null, 2);
			if (isEmpty && operation === "workspaceSymbol" && !rawPath) {
				output +=
					"\nHint: provide filePath to scope workspaceSymbol to the active language server/root.";
			}
			if (usedDocumentSymbolFallback) {
				output +=
					"\nNote: served from documentSymbol fallback due to empty primary result.";
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

			const resultCount = Array.isArray(result)
				? result.length
				: result
					? 1
					: 0;
			const searchReads = collectSearchReadsForOperation(
				operation,
				result,
				callHierarchyItem,
			);
			return finalize(
				{
					content: [{ type: "text" as const, text: output }],
					details: {
						operation,
						supported,
						searchReads: searchReads.length > 0 ? searchReads : undefined,
						emptyReason: isEmpty
							? emptyReasonForOperation(operation)
							: undefined,
						codeActionKinds: actionStats ?? undefined,
						columnResolution:
							columnResolution?.strategy === "explicit"
								? undefined
								: columnResolution,
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
