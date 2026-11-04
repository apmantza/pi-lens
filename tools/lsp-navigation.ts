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
import {
	isLspRequestTimeoutError,
	type LspRequestTimeoutError,
} from "../clients/lsp/request-timeout-error.js";
import {
	resolveHostToolPath,
	toPosix,
	uriToPath,
} from "../clients/path-utils.js";
import { escapeRegExp } from "../clients/string-utils.js";
import { isRecordableProjectPath } from "../clients/file-utils.js";
import {
	compactRenderResult,
	JSON_CELL_DETAILS_KEY,
} from "./render-compact.js";
import {
	applyWorkspaceEdit,
	captureRenameExpectedContent,
	summarizeWorkspaceEdit,
} from "../clients/lsp/edits.js";
import { configDisabledAuxiliaryLspServerIds } from "../clients/dispatch/auxiliary-lsp.js";
import { readFileContent } from "../clients/dispatch/runners/utils.js";
import {
	PRIMARY_UNAVAILABLE_CAUSE,
	primaryUnavailableCause,
} from "../clients/lsp/diagnostic-binding.js";
import {
	getLSPService,
	type LSPWorkspaceScopeAttribution,
} from "../clients/lsp/capabilities.js";
import type { SearchReadLocation } from "../clients/search-read-registration.js";
import { buildLspNavigationEnvelope } from "./lsp-structured-output.js";
import {
	renderLspNavigationText,
	symbolKindLabel,
} from "./lsp-navigation-text.js";
import {
	applyProbeFindingPolicy,
	describePrimaryUnavailable,
	mergeWithheld,
	withheldCompileNote,
	type PythonCompileWithheld,
} from "./lsp-diagnostics.js";
import {
	dispositionSuppressedLine,
	formatCacheAgeLabel,
} from "../clients/finding-delivery-gate.js";
import { disabledPrimaries } from "../clients/lsp/session-roots.js";
import {
	detectPythonTargetVersion,
	isJediCompileVerdict,
	PYTHON_DECLARATION_CONCURRENCY,
} from "../clients/python-environment.js";
import { mapWithConcurrency } from "../clients/map-with-concurrency.js";
import { readFilePath } from "./shared.js";
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

/** Why `value` is not an LSP `Range`, as a field-path suffix, or undefined. */
function rangeProblem(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return " must be a range object";
	for (const end of ["start", "end"] as const) {
		const position = (value as Record<string, unknown>)[end];
		if (!position || typeof position !== "object")
			return `.${end} must be a position object`;
		for (const axis of ["line", "character"] as const) {
			if (typeof (position as Record<string, unknown>)[axis] !== "number")
				return `.${end}.${axis} must be a number`;
		}
	}
	return undefined;
}

/**
 * #4687: the schema carries `callHierarchyItem` as an opaque object, so the
 * shape the LSP `CallHierarchyItem` requires is checked here, before any server
 * call, on pi and on MCP alike (MCP never validates a schema). Fails closed: a
 * missing or malformed field is named; extra fields (`detail`, `tags`, `data`)
 * pass through unchanged, since a server may need `data` back.
 */
function checkCallHierarchyItem(
	value: unknown,
): { item: LSPCallHierarchyItem } | { problem: string } {
	if (value === undefined || value === null)
		return { problem: "callHierarchyItem parameter required" };
	if (typeof value !== "object" || Array.isArray(value))
		return {
			problem:
				"callHierarchyItem must be the object prepareCallHierarchy returned",
		};
	const item = value as Record<string, unknown>;
	for (const [field, type] of [
		["name", "string"],
		["kind", "number"],
		["uri", "string"],
	] as const) {
		if (typeof item[field] !== type)
			return { problem: `callHierarchyItem.${field} must be a ${type}` };
	}
	for (const field of ["range", "selectionRange"] as const) {
		const problem = rangeProblem(item[field]);
		if (problem) return { problem: `callHierarchyItem.${field}${problem}` };
	}
	return { item: value as LSPCallHierarchyItem };
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

/**
 * #4403: why no language server answered a file operation on a file the
 * service has no client for, from the operator's `lsp.disabledServers`. A
 * primary turned off is not a missing install, and a disabled owner whose
 * fallback did not answer is still the denial (round 4, N1).
 */
function noServerAnsweredText(filePath: string): string {
	const { disabledServerIds, fallbackServerIds } = disabledPrimaries(filePath);
	const cause = primaryUnavailableCause(
		[...fallbackServerIds, ...disabledServerIds],
		disabledServerIds,
		fallbackServerIds,
	);
	const who =
		disabledServerIds.length > 0
			? `Primary LSP (${disabledServerIds.join(", ")}) did not answer`
			: "no language server answered";
	return `No LSP server available for ${path.basename(filePath)}: ${who} (${PRIMARY_UNAVAILABLE_CAUSE[cause]}).`;
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
	// #4323: auxiliaries the operator's configuration turns off; never acquired.
	excludeServerIds?: ReadonlySet<string>,
): Promise<string | undefined> {
	let fileContent: string | undefined;
	try {
		fileContent = nodeFs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
	// #3601: an empty file is still content a caller can hold the edit to; the
	// read is returned and the touch below is skipped exactly as before.
	if (fileContent === "") return "";
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
			...(excludeServerIds !== undefined && { excludeServerIds }),
		});
	} catch {
		/* LSP server may not be ready yet — proceed anyway */
	}
	return fileContent;
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
	> & {
		/**
		 * #4942: the guard of the session that makes the call. `readGuard` is
		 * the one captured at activation (the coordinator's), kept for hosts
		 * with no session lookup; a concurrent secondary's write must not
		 * credit it.
		 */
		readGuardFor?: (
			sessionId: string | undefined,
		) => LspMutationContext["readGuard"];
	},
) {
	return {
		name: "lsp_navigation" as const,
		label: "LSP Navigate",
		description:
			'Navigate source with language-server operations such as definition, references, hover, and rename. Returns Neovim-style TEXT by default (path:line:col locations, symbol trees, diagnostics); pass view:"json" for the structured envelope. Example: use `{operation: "references", path: "src/app.ts", line: 12}`.',
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
				enum: [...VALID_OPERATIONS],
				description: "LSP operation.",
			}),
			path: Type.Optional(
				Type.String({
					description: "Target file path.",
				}),
			),
			file: Type.Optional(Type.String({ description: "Alias for `path`." })),
			filePath: Type.Optional(
				Type.String({ description: "Alias for `path`." }),
			),
			line: Type.Optional(
				Type.Number({
					description: "1-based line number.",
				}),
			),
			character: Type.Optional(
				Type.Number({
					description: "1-based character offset.",
				}),
			),
			symbol: Type.Optional(
				Type.String({
					description: "Symbol for automatic character resolution.",
				}),
			),
			endLine: Type.Optional(
				Type.Number({
					description: "1-based range end line.",
				}),
			),
			endCharacter: Type.Optional(
				Type.Number({
					description: "1-based range end character.",
				}),
			),
			newName: Type.Optional(
				Type.String({
					description: "New symbol name.",
				}),
			),
			newFilePath: Type.Optional(
				Type.String({
					description: "New file path.",
				}),
			),
			apply: Type.Optional(
				Type.Boolean({
					description: "Apply a mutation instead of previewing it.",
				}),
			),
			command: Type.Optional(
				Type.String({
					description: "Server command identifier.",
				}),
			),
			commandArguments: Type.Optional(
				Type.Array(Type.Unknown(), {
					description: "Arguments for the server command.",
				}),
			),
			query: Type.Optional(
				Type.String({
					description: "Symbol search query.",
				}),
			),
			kinds: Type.Optional(
				Type.Array(Type.String(), {
					description: "Symbol-kind filters.",
				}),
			),
			exactMatch: Type.Optional(
				Type.Boolean({
					description: "Require an exact symbol match.",
				}),
			),
			topLevelOnly: Type.Optional(
				Type.Boolean({
					description: "Exclude nested symbols.",
				}),
			),
			maxResults: Type.Optional(
				Type.Number({
					description: "Maximum symbol matches.",
				}),
			),
			// #4687: opaque on the wire (the nested schema was 817 bytes per
			// request); `checkCallHierarchyItem` checks the shape at execute.
			callHierarchyItem: Type.Optional(
				Type.Object(
					{},
					{
						description:
							"An item prepareCallHierarchy returned, passed back unchanged.",
					},
				),
			),
			view: Type.Optional(
				Type.String({
					// Plain string, no enum: "json" is the JSON hatch; anything else is text.
					description:
						'Output format. "json" returns the structured envelope (machine-readable, byte-identical to the pre-text default); any other value (or omitting view) returns the default Neovim-style TEXT rendering (path:line:col locations, symbol trees, diagnostics).',
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: {
				cwd?: string;
				sessionManager?: { getSessionId?: () => string };
			},
		) {
			// #3763: before the first await, so the rename's bookkeeping drops
			// once this session is replaced (`context.session`, #3576).
			const session = mutationDeps?.runtime?.captureSessionGeneration?.();
			const startedAt = Date.now();
			let supported: boolean | null = null;
			// #4403 round 5 (V5): `getOperationSupport` found no client for the
			// file, after trying to start one.
			let noFileClient = false;
			let diagnosticsMode: "pull" | "push-only" | "unknown" = "unknown";
			let columnResolution: SymbolColumnResolution | undefined;
			// #3601: the content the rename's pre-flight `openFileBestEffort` read,
			// held as the expected content for the rename's own target file.
			let openedFileContent: string | undefined;
			// #3601: when the rename request was last sent; a touched file whose
			// send changed, or (unopened) whose mtime is, at or after it is refused
			// (see the capture).
			let renameRequestedAtMs = 0;
			let mutationContext: LspMutationContext | undefined;
			let requestedApply = false;
			const workspaceScopeAttribution: LSPWorkspaceScopeAttribution = {};

			const finalize = (
				unreported: {
					content: Array<{ type: "text"; text: string }>;
					isError?: boolean;
					details?: Record<string, unknown>;
				},
				meta: {
					operation: string;
					filePath: string;
					failureKind: string;
					resultCount: number;
					result?: unknown;
					callSiteUri?: string;
				},
			): typeof payload & {
				details: typeof unreported.details & {
					failureKind: string;
				};
			} => {
				// #5248: the files the apply wrote and the mutation bridge accepted,
				// for `handleToolResult`'s dispatch feed. A failed, skipped or
				// dry-run call accepted none, so it reports none.
				const payload =
					mutationContext?.acceptedFiles &&
					mutationContext.acceptedFiles.length > 0
						? {
								...unreported,
								details: {
									...unreported.details,
									appliedFiles: [...mutationContext.acceptedFiles],
								},
							}
						: unreported;
				if (
					payload.isError &&
					requestedApply &&
					mutationContext &&
					["rename", "rename_file", "executeCommand"].includes(meta.operation)
				) {
					recordLspMutationOutcome(mutationContext, "failed");
				}
				const normalizedFilePath = toPosix(meta.filePath);
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
				if (params.view === "json") {
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
							// #5159: a JSON cell keeps block 0 parseable; a stale advisory
							// rides a trailing block instead of joining the envelope.
							[JSON_CELL_DETAILS_KEY]: true,
						},
					};
				}
				// Default text cell: Neovim-style lines rendered from the typed result. A
				// result the renderer cannot read (an error, a note, the capabilities table)
				// keeps the payload's own text.
				return {
					...payload,
					content: [
						{
							type: "text" as const,
							text: renderLspNavigationText({
								operation: meta.operation,
								result: meta.result,
								filePath: meta.filePath,
								cwd: ctx.cwd || ".",
								...(meta.callSiteUri === undefined
									? {}
									: { callSiteUri: meta.callSiteUri }),
								text,
							}),
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

			// #5041: `path` is canonical; `file` and `filePath` stay accepted, so a
			// caller written against either spelling reaches the same file. A
			// conflicting pair, a non-string or a blank value is refused rather than
			// guessed at.
			const pathRead = readFilePath(params);
			if (pathRead.refusal) {
				return finalize(
					{
						content: [{ type: "text" as const, text: pathRead.refusal }],
						isError: true,
					},
					{
						operation: String(params.operation ?? "lsp"),
						filePath: "(workspace)",
						failureKind: "invalid_path",
						resultCount: 0,
					},
				);
			}
			if (pathRead.path) params = { ...params, path: pathRead.path };

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
					sessionId: ctx.sessionManager?.getSessionId?.(),
					correlationId: newLspMutationCorrelationId(_toolCallId),
					acceptedFiles: [],
					// #4187 R4-1: the call whose `tool_call` licensed the paths it
					// named; the workspace edit's other files (a rename's importers)
					// are unlicensed, so they end an authorship instead of advancing it.
					toolCallId: _toolCallId,
					tool: `lsp_navigation:${operation}`,
					source: mutationSource,
					...mutationDeps,
					session,
					readGuard: getFlag("no-read-guard", cwd)
						? undefined
						: (mutationDeps?.readGuardFor?.(
								ctx.sessionManager?.getSessionId?.(),
							) ?? mutationDeps?.readGuard),
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

			// #4577 M2: `path` is a host-supplied tool path, so it resolves
			// through the shared host resolver (`~`/`~/` expansion, `file://`,
			// `@` prefix, unicode spaces). The bare join pinned `~/x` under the
			// cwd — a path that cannot exist — and the LSP then answered for a
			// document nothing had opened (#4576).
			const filePath = rawPath
				? resolveHostToolPath(rawPath, ctx.cwd || ".")
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
				const policyCwd = ctx.cwd || process.cwd();
				const wsDiagSupport = rawPath
					? await lspService.getWorkspaceDiagnosticsSupport(filePath)
					: await lspService.getWorkspaceDiagnosticsSupport(
							undefined,
							workspaceScopeAttribution,
						);
				diagnosticsMode = wsDiagSupport?.mode ?? "unknown";

				if (rawPath && !filePathIsDirectory) {
					// #4403: a file whose primary the operator disabled has a
					// language server; it is turned off, which the read below
					// reports as the cause instead of "not installed".
					const hasLSP =
						lspService.supportsLSP(filePath) ||
						disabledPrimaries(filePath).disabledServerIds.length > 0;
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

					// #4323: an explicit diagnostics read leaves an auxiliary the
					// operator turned off unstarted, as `lsp_diagnostics` does.
					const excludeServerIds = configDisabledAuxiliaryLspServerIds((name) =>
						getFlag(name, ctx.cwd),
					);
					// #4532 gap 13: the same forced drift sweep `lsp_diagnostics` runs, so
					// a held file changed outside pi is re-pushed before this read.
					await lspService.sweepDocumentDrift({ force: true, full: true });
					// #1634: the content the diagnostics below answer for is the
					// content the policy's inline and strict-anchor checks read.
					const openedContent = await openFileBestEffort(
						lspService,
						filePath,
						true,
						excludeServerIds,
					);
					// #1634: the same finding policy (stored dispositions, `.pi-lens.json`
					// rule policy, inline `pi-lens-ignore`) the `lens_diagnostics
					// source=lsp` probe applies to the same server answer.
					// #4638: the project's declared Python syntax level, so jedi's own
					// `compile` verdict cannot outrank it on this route either.
					const pythonCompileTarget = await detectPythonTargetVersion(filePath);
					const policy = applyProbeFindingPolicy(
						filePath,
						await lspService.getDiagnostics(
							filePath,
							undefined,
							excludeServerIds,
						),
						policyCwd,
						openedContent,
						"all",
						"lsp_navigation",
						pythonCompileTarget,
					);
					const diagnostics = policy.kept;
					const diagnosticsTimedOut =
						lspService.getDiagnosticsHealth(filePath)?.failureKind ===
						"timeout";
					const diagnosticsPartialTimeout =
						lspService.getDiagnosticsHealth(filePath)?.partialTimeout === true;
					const suppressedLine = dispositionSuppressedLine(policy.suppressed);
					// #4638 r3 (N2): a row the declaration withheld is named on this route
					// too, so an empty answer cannot read as "no findings published".
					const withheldLine = withheldCompileNote(policy.withheld);
					// #4403: #4322's rule on this route. When no language server
					// answered, the read's health record names it, and an empty
					// answer is not 0 diagnostics.
					const primaryUnavailable = describePrimaryUnavailable(
						undefined,
						lspService.getDiagnosticsHealth(filePath),
					)?.text;
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
					const unavailableNote = primaryUnavailable
						? `\nNote: ${primaryUnavailable}`
						: "";
					const suppressedNote = suppressedLine
						? `\nNote: ${suppressedLine}`
						: "";
					const withheldNote = withheldLine ? `\nNote: ${withheldLine}` : "";
					const timedOutNote =
						diagnosticsTimedOut || diagnosticsPartialTimeout
							? `\nNote: LSP diagnostics timed out for ${filePath}`
							: "";
					return finalize(
						{
							content: [
								{
									type: "text" as const,
									text: `${note}\n${JSON.stringify(result)}${timedOutNote}${unavailableNote}${suppressedNote}${withheldNote}`,
								},
							],
							...(diagnosticsTimedOut && resultCount === 0
								? { isError: true }
								: {}),
							details: {
								operation,
								resultCount,
								diagnosticsMode,
								coverage: "requested-file",
								...(policy.suppressed > 0 && {
									dispositionSuppressed: policy.suppressed,
								}),
								...(policy.withheld && {
									withheldCompile: policy.withheld,
								}),
								...(primaryUnavailable !== undefined && {
									unconfirmed: true,
									primaryUnavailable,
								}),
							},
						},
						{
							operation,
							filePath,
							failureKind:
								diagnosticsTimedOut && resultCount === 0
									? "timeout"
									: resultCount === 0
										? "empty_result"
										: "success",
							resultCount,
							result,
						},
					);
				}

				// #4323: the snapshot starts no server, but an auxiliary the
				// operator turned off may still be running; leave its rows out.
				const allDiagnostics = await lspService.getAllDiagnostics(
					configDisabledAuxiliaryLspServerIds((name) => getFlag(name, ctx.cwd)),
				);
				// #1634: a tracked snapshot replays what each client last published,
				// so every row passes the same finding policy as the path read and
				// carries its age: nothing here re-checks the file.
				// #4638 review (F10): only a file carrying a python-jedi `compile` row
				// can be outranked, so only those pay for the declaration walk, and the
				// reads go through the shared bounded pool instead of one unbounded
				// Promise.all over the whole snapshot.
				const compileVerdictFiles: string[] = [];
				for (const [trackedFile, entry] of allDiagnostics) {
					if (entry.diags.some(isJediCompileVerdict)) {
						compileVerdictFiles.push(trackedFile);
					}
				}
				const compileVerdictTargets = await mapWithConcurrency(
					compileVerdictFiles,
					PYTHON_DECLARATION_CONCURRENCY,
					async (trackedFile) => ({
						trackedFile,
						target: await detectPythonTargetVersion(trackedFile),
					}),
				);
				const pythonCompileTargets = new Map(
					compileVerdictTargets.map(
						(entry) => [entry.trackedFile, entry.target] as const,
					),
				);
				let snapshotSuppressed = 0;
				const snapshotWithheldEntries: Array<
					PythonCompileWithheld | undefined
				> = [];
				const result = Array.from(allDiagnostics.entries()).map(
					([trackedFile, { diags, ts }]) => {
						let kept = diags;
						if (diags.length > 0) {
							const policy = applyProbeFindingPolicy(
								trackedFile,
								diags,
								policyCwd,
								readFileContent(trackedFile),
								"all",
								"lsp_navigation",
								pythonCompileTargets.get(trackedFile),
							);
							snapshotSuppressed += policy.suppressed;
							// #4638 review (F10): the snapshot is model-facing too, so a
							// withheld row is named on its text rather than left to the ledger.
							snapshotWithheldEntries.push(policy.withheld);
							kept = policy.kept;
						}
						return {
							filePath: trackedFile,
							diagnostics: kept,
							count: kept.length,
							lag: formatCacheAgeLabel(ts),
						};
					},
				);
				const snapshotSuppressedLine =
					dispositionSuppressedLine(snapshotSuppressed);
				const snapshotWithheld = mergeWithheld(snapshotWithheldEntries);
				const snapshotWithheldLine = withheldCompileNote(snapshotWithheld);
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
								text: `${note}\n${JSON.stringify(result)}${snapshotSuppressedLine ? `\nNote: ${snapshotSuppressedLine}` : ""}${snapshotWithheldLine ? `\nNote: ${snapshotWithheldLine}` : ""}`,
							},
						],
						details: {
							operation,
							resultCount: result.length,
							diagnosticsMode,
							coverage: "tracked-open-files",
							...(snapshotSuppressed > 0 && {
								dispositionSuppressed: snapshotSuppressed,
							}),
							...(snapshotWithheld && {
								withheldCompile: snapshotWithheld,
							}),
						},
					},
					{
						operation,
						filePath: rawPath ? filePath : "(workspace)",
						failureKind:
							diagnosticsMode === "push-only" ? "tracked_snapshot" : "success",
						resultCount: result.length,
						result,
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
				// #4403 round 4 (N4): the same check as the workspaceDiagnostics
				// gate above. A primary the operator turned off is not a missing
				// install, so the advice would send the reader the wrong way.
				return finalize(
					{
						content: [
							{
								type: "text" as const,
								text:
									disabledPrimaries(filePath).disabledServerIds.length > 0
										? noServerAnsweredText(filePath)
										: `No LSP server available for ${path.basename(filePath)}. Check that the language server is installed.`,
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
				noFileClient = support === null;
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

				openedFileContent = await openFileBestEffort(lspService, filePath);
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
						renameRequestedAtMs = Date.now();
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
							// #3601: the server computed this edit from the bytes each touched
							// file held when it answered. A file that changed in between is
							// refused inside pi's queue, before any write, so the edit never
							// lands on text it was not computed for.
							expectedContent: captureRenameExpectedContent(
								edit,
								ctx.cwd || ".",
								renameRequestedAtMs,
								(filePath: string, atCwd: string) =>
									lspService.getTrackedContent(filePath, atCwd),
								openedFileContent === undefined
									? undefined
									: { filePath, content: openedFileContent },
							),
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
						// #4578: the destination is a WRITE target, so it resolves through
						// the same host-path seam pi's own write tool uses — `~` expands to
						// `$HOME`, a leading `@` mention prefix drops, and pi's unicode
						// space class folds (defect shape 74: a bare `path.resolve(cwd,
						// `~/x`)` names `<cwd>/~/x`, a path that cannot exist).
						const resolvedNewFilePath = resolveHostToolPath(
							newFilePath,
							ctx.cwd || ".",
						);
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
						const checked = checkCallHierarchyItem(callHierarchyItem);
						if ("problem" in checked) {
							throw new Error(
								`__BADINPUT__ ${checked.problem} for incomingCalls`,
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
							await lspService.getOperationSupport(uriToPath(checked.item.uri)),
						);
						if (supported === false) {
							throw new Error(
								"__UNSUPPORTED__ Active LSP server does not advertise support for incomingCalls",
							);
						}
						return lspService.incomingCalls(checked.item);
					}
					case "outgoingCalls": {
						const checked = checkCallHierarchyItem(callHierarchyItem);
						if ("problem" in checked) {
							throw new Error(
								`__BADINPUT__ ${checked.problem} for outgoingCalls`,
							);
						}
						// #1803 fix-round F1: same pre-check as incomingCalls above.
						supported = operationSupportStatus(
							operation,
							await lspService.getOperationSupport(uriToPath(checked.item.uri)),
						);
						if (supported === false) {
							throw new Error(
								"__UNSUPPORTED__ Active LSP server does not advertise support for outgoingCalls",
							);
						}
						return lspService.outgoingCalls(checked.item);
					}
					default:
						return [];
				}
			};

			let result: unknown;
			let usedDocumentSymbolFallback = false;
			let definitionTimeout: LspRequestTimeoutError | undefined;
			try {
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
						openedFileContent = await openFileBestEffort(
							lspService,
							filePath,
							true,
						);
						result = await runOperation();
					}
				} catch (err) {
					if (
						needsFilePath &&
						operation === "definition" &&
						isLspRequestTimeoutError(err)
					) {
						definitionTimeout = err;
					} else {
						throw err;
					}
				}

				const stillEmpty =
					!result || (Array.isArray(result) && result.length === 0);
				try {
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
					throw definitionTimeout ?? err;
				}
				if (definitionTimeout && !usedDocumentSymbolFallback)
					throw definitionTimeout;

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
				if (isLspRequestTimeoutError(err)) {
					return finalize(
						{
							content: [{ type: "text" as const, text: err.message }],
							isError: true,
							details: {
								method: err.method,
								timeoutMs: err.timeoutMs,
								elapsedMs: err.elapsedMs,
							},
						},
						{ operation, filePath, failureKind: "timeout", resultCount: 0 },
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
			// #4403 round 5 (V5): with no client for the file (a missing binary,
			// a disabled primary while an auxiliary serves the file, a disabled
			// owner whose fallback is missing), an empty answer came from no
			// language server. `hover` returns null for both cases, so the
			// empty answer here is no_server, not "No results".
			if (isEmpty && noFileClient) {
				return finalize(
					{
						content: [
							{ type: "text" as const, text: noServerAnsweredText(filePath) },
						],
						isError: true,
					},
					{ operation, filePath, failureKind: "no_server", resultCount: 0 },
				);
			}
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
				output += definitionTimeout
					? "\nNote: served from documentSymbol fallback; definition timed out."
					: "\nNote: served from documentSymbol fallback due to empty primary result.";
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
							? definitionTimeout
								? "fallback_after_timeout"
								: "fallback_success"
							: "success",
					resultCount,
					result,
					// Outgoing call sites are written in the item the caller asked
					// about, whose uri the result does not carry.
					...(isCallHierarchyTraversal && callHierarchyItem
						? { callSiteUri: callHierarchyItem.uri }
						: {}),
				},
			);
		},
	};
}
