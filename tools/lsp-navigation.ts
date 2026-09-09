/**
 * lsp_navigation tool definition
 *
 * Extracted from index.ts for maintainability.
 */

import * as nodeFs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "../clients/deps/typebox.js";
import { logLatency } from "../clients/latency-logger.js";
import {
	newLspMutationCorrelationId,
	recordLspMutationOutcome,
	type LspMutationContext,
} from "../clients/lsp-mutation.js";
import type { LSPCallHierarchyItem } from "../clients/lsp/client.js";
import { uriToPath } from "../clients/path-utils.js";
import { escapeRegExp } from "../clients/string-utils.js";
import { isRecordableProjectPath } from "../clients/file-utils.js";
import { compactRenderResult } from "./render-compact.js";
import {
	applyWorkspaceEdit,
	summarizeWorkspaceEdit,
} from "../clients/lsp/edits.js";
import {
	getLSPService,
	type LSPWorkspaceScopeAttribution,
} from "../clients/lsp/index.js";
import type { SearchReadLocation } from "../clients/search-read-registration.js";
import { buildLspNavigationEnvelope } from "./lsp-structured-output.js";
import { SYMBOL_KIND_NAMES } from "../clients/lsp-document-symbols.js";

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

const NAVIGABLE_SYMBOL_KINDS = new Set([
	5, // Class
	6, // Method
	8, // Field
	11, // Interface
	12, // Function
	13, // Variable
	22, // EnumMember
	23, // Struct
]);

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

function symbolKindLabel(kind: number | undefined): string {
	// Single source of truth for LSP SymbolKind names (#883 doctrine; the
	// Sonar-flagged duplicate table lived here). Navigation keeps its own
	// "symbol" fallback for unknown kinds instead of the lsp-symbol-<n> form.
	return kind == null ? "symbol" : (SYMBOL_KIND_NAMES[kind] ?? "symbol");
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
	start?: { line?: unknown; character?: unknown };
	end?: { line?: unknown; character?: unknown };
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
		codeActionResolve: boolean;
		rename: boolean;
		willRenameFiles: boolean;
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
		["codeAction/resolve", (s) => !!s.operationSupport.codeActionResolve],
		["workspace/willRenameFiles", (s) => !!s.operationSupport.willRenameFiles],
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
			"filesystem rename; preflight support shown above",
		],
	];

	const lines: string[] = [];
	for (const snapshot of snapshots) {
		const label = filePath
			? `${snapshot.serverId} (${path.basename(filePath)})`
			: `${snapshot.serverId} (${snapshot.root})`;
		lines.push(label);
		for (const [name, supported, note] of rows) {
			const suffix = note ? ` (${note})` : "";
			lines.push(`  ${name} ${supported(snapshot) ? "✓" : "✗"}${suffix}`);
		}
		const commands = snapshot.advertisedCommands ?? [];
		lines.push(
			`  executeCommand ${commands.length > 0 ? "✓" : "✗"} (${commands.length} advertised command(s)` +
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
		// #2598: `touchFile` is defined unconditionally on the real `LSPService`
		// (clients/lsp/index.ts), so the former `typeof … === "function"` hedge
		// and its `openFile` arm were reachable only from a partial test double
		// (AGENTS.md shape 7). Nothing here reads the result — a touch that
		// resolves no clients is already the no-op this helper wants.
		await lspService.touchFile(filePath, fileContent, {
			diagnostics: waitForDiagnostics ? "document" : "none",
			source: "lsp_navigation",
			clientScope: waitForDiagnostics ? "all" : "primary",
		});
	} catch {
		/* LSP server may not be ready yet — proceed anyway */
	}
}

export function createLspNavigationTool(
	/**
	 * Resolves a flag, optionally scoped to a call's `cwd` (#792). Callers that
	 * need per-request project config (e.g. the MCP host, which has no single
	 * "current project root" the way an in-pi session does) can rebuild their
	 * flag resolver against `cwd` instead of whatever directory the tool was
	 * constructed in; callers that only have a single fixed project root (e.g.
	 * pi's own `getLensFlag`) may ignore the second argument.
	 */
	getFlag: (name: string, cwd?: string) => boolean | string | undefined,
	mutationDeps?: Pick<
		LspMutationContext,
		"runtime" | "cacheManager" | "readGuard" | "dbg"
	>,
) {
	return {
		name: "lsp_navigation" as const,
		label: "LSP Navigate",
		description:
			'Navigate source with language-server operations such as definition, references, hover, and rename. Example: use `{operation: "references", path: "src/app.ts", line: 12}`.',
		promptSnippet: "Navigate definitions and references with LSP",
		renderResult: compactRenderResult<{
			operation?: string;
			resultCount?: number;
			supported?: boolean;
			emptyReason?: string;
		}>(({ details, args, isError, text }) => {
			const op =
				details?.operation ??
				(typeof args.operation === "string" ? args.operation : "lsp");
			if (isError || details?.supported === false) {
				return `lsp_navigation ${op} — ${details?.emptyReason ?? text.split("\n")[0] ?? "unavailable"}`;
			}
			const n = details?.resultCount ?? 0;
			if (n === 0) {
				return `lsp_navigation ${op} — ${details?.emptyReason ?? "no results"}`;
			}
			return `lsp_navigation ${op} — ${n} result${n === 1 ? "" : "s"}`;
		}),
		parameters: Type.Object({
			operation: Type.String({
				description:
					"LSP operation to perform. Valid values: " +
					VALID_OPERATIONS.join(", "),
			}),
			path: Type.Optional(
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
			let mutationContext: LspMutationContext | undefined;
			let requestedApply = false;
			const workspaceScopeAttribution: LSPWorkspaceScopeAttribution = {};

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
				if (
					payload.isError &&
					requestedApply &&
					mutationContext &&
					["rename", "rename_file", "executeCommand"].includes(meta.operation)
				) {
					recordLspMutationOutcome(mutationContext, "failed");
				}
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
						...(Object.keys(workspaceScopeAttribution).length > 0
							? { workspaceScopeAttribution }
							: {}),
					},
				});

				const text = payload.content[0]?.text ?? "";
				const envelope = buildLspNavigationEnvelope({
					operation: meta.operation,
					filePath: meta.filePath,
					failureKind: meta.failureKind,
					resultCount: meta.resultCount,
					text,
					isError: payload.isError,
					details: payload.details,
				});

				return {
					...payload,
					content: [
						{
							type: "text" as const,
							// Compact JSON: omit indentation. Saves ~50% on rename / workspace-edits payloads
							// while keeping the envelope machine-parseable. Tests use JSON.parse so
							// they are agnostic to whitespace.
							text: JSON.stringify(envelope),
						},
					],
					details: {
						...payload.details,
						failureKind: meta.failureKind,
					},
				};
			};

			if (getFlag("no-lsp", ctx.cwd)) {
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
				path: rawPath,
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
				path?: string;
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
			requestedApply = apply === true;
			if (
				requestedApply &&
				["rename", "rename_file", "executeCommand"].includes(operation)
			) {
				const cwd = ctx.cwd || ".";
				// Name the specific LSP operation in the receipt rather than a
				// generic "lsp-edit" tag, so a rename's change-log entry reads
				// differently from an executeCommand-solicited edit (#2450).
				const mutationSource =
					operation === "executeCommand" ? "lsp-execute-command" : "lsp-rename";
				mutationContext = {
					cwd,
					correlationId: newLspMutationCorrelationId(_toolCallId),
					tool: `lsp_navigation:${operation}`,
					source: mutationSource,
					...mutationDeps,
					readGuard: getFlag("no-read-guard", cwd)
						? undefined
						: mutationDeps?.readGuard,
					// #2450 review round 2 (F4)/round 3 (F2, F4): the SAME gate
					// `registerMutationBridge` applies internally in `index.ts`, so
					// this directly-threaded path and the bridge fallback
					// (`clients/lsp-mutation.ts`, reached when `mutationDeps` is
					// absent/partial — e.g. the MCP server) agree on which files
					// count as project source, rather than the direct path
					// recording an ignored/vendor write the fallback would drop.
					// `no-read-guard` is intentionally NOT checked here (round 3
					// F2): it gates only the read-guard stamp above, the same
					// canonical split `clients/runtime-tool-result.ts` applies
					// (`:1120`, `:1485`) — bookkeeping (turn-state / receipts)
					// still runs under `--no-read-guard`. Judge against the
					// project root, not the request `cwd` (round 3 F4): a
					// sub-package `cwd` must not read a sibling-package rename as
					// external.
					isRecordable: (filePath: string): boolean => {
						return isRecordableProjectPath(
							filePath,
							mutationDeps?.runtime?.projectRoot ?? cwd,
						);
					},
				};
			}

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
								text: `path is required for ${operation}`,
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
				const snapshots = rawPath
					? await lspService.getCapabilitySnapshots(filePath)
					: await lspService.getCapabilitySnapshots(
							undefined,
							workspaceScopeAttribution,
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
				const wsDiagSupport = rawPath
					? await lspService.getWorkspaceDiagnosticsSupport(filePath)
					: await lspService.getWorkspaceDiagnosticsSupport(
							undefined,
							workspaceScopeAttribution,
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
						pull: "Note: path mode requests pull diagnostics for this file and returns the aggregated result",
						"push-only":
							"Note: server is push-only; result depends on published diagnostics for this file",
					};
					const note =
						noteMap[diagnosticsMode] ??
						"Note: workspace diagnostics mode unknown (no active capability snapshot)";
					const resultCount = diagnostics.length;
					return finalize(
						{
							content: [
								{
									type: "text" as const,
									text: `${note}\n${JSON.stringify(result)}`,
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
					pull: "Note: tracked diagnostics snapshot from active clients. Provide path to force file-level diagnostics collection",
				};
				const note =
					noteMap2[diagnosticsMode] ??
					"Note: workspace diagnostics mode unknown (no active capability snapshot)";
				return finalize(
					{
						content: [
							{
								type: "text" as const,
								text: `${note}\n${JSON.stringify(result)}`,
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
								text: `path must be a source file, got directory: ${filePath}. Pass a source file path, or omit path for workspace-level operations.`,
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

			const runWorkspaceSymbolOperation = async (): Promise<SymbolNode[]> => {
				const support = rawPath
					? await lspService.getOperationSupport(filePath)
					: await lspService.getOperationSupport(
							undefined,
							workspaceScopeAttribution,
						);
				supported = operationSupportStatus(operation, support);
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
					const raw = rawPath
						? await lspService.workspaceSymbol(query ?? "", filePath)
						: await lspService.workspaceSymbol(
								query ?? "",
								undefined,
								workspaceScopeAttribution,
							);
					const filtered = (Array.isArray(raw) ? raw : [raw]).filter(
						(s) =>
							typeof s === "object" &&
							s !== null &&
							(!s.kind || NAVIGABLE_SYMBOL_KINDS.has(s.kind)),
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
			};

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
						return runWorkspaceSymbolOperation();
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
						const applied = await applyWorkspaceEdit(edit, ctx.cwd || ".", {
							mutationContext,
						});
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
								...(mutationContext ? { mutationContext } : {}),
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
						const advertised = rawPath
							? await lspService.getAdvertisedCommands(filePath)
							: await lspService.getAdvertisedCommands(
									undefined,
									workspaceScopeAttribution,
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
						return rawPath
							? lspService.executeCommand(
									filePath,
									command,
									commandArguments,
									mutationContext,
								)
							: lspService.executeCommand(
									undefined,
									command,
									commandArguments,
									mutationContext,
									workspaceScopeAttribution,
								);
					}
					case "incomingCalls": {
						if (!callHierarchyItem) {
							throw new Error(
								"__BADINPUT__ callHierarchyItem parameter required for incomingCalls",
							);
						}
						// #1803 fix-round F1: needsFilePath is false for call-hierarchy
						// traversal (the operand is callHierarchyItem, not path), so the
						// shared needsFilePath pre-check at line ~1319 never runs for
						// this operation — LSPService.incomingCalls' own capability gate
						// (clients/lsp/index.ts) returns a bare [], which this tool layer
						// cannot distinguish from "supported server, zero callers found".
						// Pre-check here, keyed off the item's own uri (the file the
						// resolved server is scoped to), mirrors
						// runWorkspaceSymbolOperation's supported-check above: throwing
						// __UNSUPPORTED__ routes through the catch block below into the
						// same discriminated isError:true/emptyReason:"unsupported" shape
						// every other capability-gated operation already reports.
						supported = operationSupportStatus(
							operation,
							await lspService.getOperationSupport(
								uriToPath(callHierarchyItem.uri),
							),
						);
						if (supported === false) {
							throw new Error(
								"__UNSUPPORTED__ Active LSP server does not advertise support for incomingCalls",
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
						// #1803 fix-round F1: same pre-check as incomingCalls above.
						supported = operationSupportStatus(
							operation,
							await lspService.getOperationSupport(
								uriToPath(callHierarchyItem.uri),
							),
						);
						if (supported === false) {
							throw new Error(
								"__UNSUPPORTED__ Active LSP server does not advertise support for outgoingCalls",
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
				if (
					mutationContext &&
					requestedApply &&
					!mutationContext.summaryEmitted
				) {
					const outcome =
						operation === "rename_file" &&
						result &&
						typeof result === "object" &&
						"applied" in result &&
						(result as { applied?: unknown }).applied === false
							? "failed"
							: operation === "executeCommand" &&
								  result &&
								  typeof result === "object" &&
								  "executed" in result &&
								  (result as { executed?: unknown }).executed === false
								? "failed"
								: "skipped";
					recordLspMutationOutcome(mutationContext, outcome);
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
				: JSON.stringify(result);
			if (isEmpty && operation === "workspaceSymbol" && !rawPath) {
				output +=
					"\nHint: provide path to scope workspaceSymbol to the active language server/root.";
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
