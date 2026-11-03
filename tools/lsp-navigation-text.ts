/**
 * Neovim-style text rendering for `lsp_navigation`'s default view.
 *
 * The tool's default `content` is the text a Neovim LSP user sees, not the raw
 * LSP JSON:
 *
 *   - a location list (definition / references / implementation / call
 *     hierarchy) prints one `path:line:col` entry per hit, the quickfix and
 *     picker shape `vim.lsp.util.locations_to_items` produces;
 *   - `hover` prints its markdown, `signatureHelp` the active signature;
 *   - `documentSymbol` / `findSymbol` print an indented `start-end kind name`
 *     tree, the same compact shape `ast_grep_outline` uses;
 *   - `workspaceDiagnostics` prints `path:line:col: severity: message`, the
 *     `vim.diagnostic.toqflist` line;
 *   - a rename prints the edit summary it computed.
 *
 * `view:"json"` keeps the structured envelope (`tools/lsp-structured-output.ts`)
 * reachable and byte-identical to the pre-text default. Every renderer here
 * returns `undefined` when it cannot read a structured value, and the caller
 * then falls back to the tool's own text (an error, a note, or the capabilities
 * table).
 *
 * Display paths are project-relative through `displayFilePath`, one resolver per
 * project root, and decode URIs through `uriToDiskPath` (never `uriToPath`,
 * whose `realpath` is map-key normalization and would pay filesystem I/O per
 * location). An executed command's value is the one exception: its payload is
 * the server's arbitrary value, so it renders as compact single-line JSON.
 */

import { BoundedFifoMap } from "../clients/bounded-cache.js";
import { SYMBOL_KIND_NAMES } from "../clients/lsp-document-symbols.js";
import {
	createProjectRelativePathResolver,
	uriToDiskPath,
} from "../clients/path-utils.js";
import { lspNavigationTextSurround } from "./lsp-structured-output.js";

type Rec = Record<string, unknown>;

/** LSP `DiagnosticSeverity` (1..4) as the lowercase word Neovim prints. */
const SEVERITY_LABELS: Record<number, string> = {
	1: "error",
	2: "warning",
	3: "information",
	4: "hint",
};

function rec(value: unknown): Rec | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Rec)
		: undefined;
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function stringArray(value: unknown): string[] {
	return arr(value).filter(
		(entry): entry is string => typeof entry === "string",
	);
}

function kindLabel(kind: unknown): string {
	const value = num(kind);
	// Navigation keeps a plain "symbol" fallback for an unknown kind rather than
	// the `lsp-symbol-<n>` form the diagnostics path uses.
	return value === undefined
		? "symbol"
		: (SYMBOL_KIND_NAMES[value] ?? "symbol");
}

/**
 * One relative-path resolver per project root, capped so a process that outlives
 * many sessions cannot accumulate them. A location list asks for hundreds of
 * display paths against one root, and the outside-root retry canonicalizes that
 * root per call without this (#1449 measurement: 500 locations, half outside
 * the root, 7.46 ms -> 5.05 ms per render).
 */
const ROOT_RESOLVER_LIMIT = 8;
const rootResolvers = new BoundedFifoMap<
	string,
	ReturnType<typeof createProjectRelativePathResolver>
>(ROOT_RESOLVER_LIMIT);

function displayFilePath(filePath: string, cwd: string): string {
	let resolveDisplay = rootResolvers.get(cwd);
	if (!resolveDisplay) {
		resolveDisplay = createProjectRelativePathResolver(cwd);
		rootResolvers.set(cwd, resolveDisplay);
	}
	return resolveDisplay(filePath) || filePath;
}

function displayPath(uri: string, cwd: string): string {
	return displayFilePath(uriToDiskPath(uri), cwd);
}

/** LSP positions are 0-based; the rendered line is the 1-based one Neovim shows. */
function startOf(
	range: unknown,
): { line: number; character: number } | undefined {
	const start = rec(rec(range)?.start);
	const line = num(start?.line);
	if (line === undefined) return undefined;
	return { line: line + 1, character: (num(start?.character) ?? 0) + 1 };
}

function endLine(range: unknown): number | undefined {
	const end = rec(rec(range)?.end);
	const line = num(end?.line);
	return line === undefined ? undefined : line + 1;
}

function locationLine(
	uri: string,
	range: unknown,
	cwd: string,
): string | undefined {
	const start = startOf(range);
	if (!start) return undefined;
	return `${displayPath(uri, cwd)}:${start.line}:${start.character}`;
}

/** A symbol/entry carrying `uri`+`range`, `location`, or `targetUri`+`targetRange`. */
function symbolLine(entry: Rec, cwd: string): string | undefined {
	const location = rec(entry.location);
	const uri = str(entry.uri) ?? str(location?.uri) ?? str(entry.targetUri);
	const range =
		rec(location?.range) ??
		rec(entry.selectionRange) ??
		rec(entry.range) ??
		rec(entry.targetSelectionRange) ??
		rec(entry.targetRange);
	if (!uri || !range) return undefined;
	const line = locationLine(uri, range, cwd);
	if (!line) return undefined;
	const name = str(entry.name);
	return name ? `${line}  ${kindLabel(entry.kind)} ${name}` : line;
}

function renderLocations(result: unknown, cwd: string): string | undefined {
	const items = Array.isArray(result) ? result : result == null ? [] : [result];
	const lines: string[] = [];
	for (const item of items) {
		const entry = rec(item);
		if (!entry) continue;
		const uri = str(entry.uri) ?? str(entry.targetUri);
		const range =
			rec(entry.targetSelectionRange) ??
			rec(entry.targetRange) ??
			rec(entry.range);
		if (!uri || !range) continue;
		const line = locationLine(uri, range, cwd);
		if (line) lines.push(line);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function renderSymbolList(result: unknown, cwd: string): string | undefined {
	const lines: string[] = [];
	for (const item of arr(result)) {
		const entry = rec(item);
		if (!entry) continue;
		const line = symbolLine(entry, cwd);
		if (line) lines.push(line);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * A call-hierarchy entry: the symbol line, then one indented line per call site
 * in `fromRanges` (`CallHierarchyIncomingCall`/`OutgoingCall`), which a symbol
 * line alone dropped.
 *
 * The ranges carry no uri of their own. An incoming range is a call site in
 * `from`'s file; an outgoing one is a call site in the file the caller asked
 * about, which `callSiteUri` names — `to` is where the call goes, not where it
 * is written.
 */
function renderCalls(
	result: unknown,
	cwd: string,
	side: "from" | "to",
	callSiteUri: string | undefined,
): string | undefined {
	const lines: string[] = [];
	for (const item of arr(result)) {
		const entry = rec(item);
		const symbol = rec(entry?.[side]);
		if (!symbol) continue;
		const line = symbolLine(symbol, cwd);
		if (!line) continue;
		lines.push(line);
		const siteUri = side === "from" ? str(symbol.uri) : callSiteUri;
		if (!siteUri) continue;
		for (const range of arr(entry?.fromRanges)) {
			const site = locationLine(siteUri, range, cwd);
			if (site) lines.push(`  ${site}`);
		}
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function renderDocumentSymbols(
	result: unknown,
	filePath: string,
	cwd: string,
): string | undefined {
	const items = arr(result);
	if (items.length === 0) return undefined;
	const header = displayFilePath(filePath, cwd);
	const lines: string[] = [header];
	const visit = (entries: unknown[], depth: number): void => {
		for (const item of entries) {
			const entry = rec(item);
			if (!entry) continue;
			const range = rec(entry.range) ?? rec(rec(entry.location)?.range);
			const start = startOf(range);
			const end = endLine(range);
			const name = str(entry.name) ?? "";
			const label = start
				? `${start.line}-${end ?? start.line} ${kindLabel(entry.kind)} ${name}`
				: `${kindLabel(entry.kind)} ${name}`;
			lines.push(`${"  ".repeat(depth + 1)}${label}`.trimEnd());
			const children = arr(entry.children);
			if (children.length > 0) visit(children, depth + 1);
		}
	};
	visit(items, 0);
	return lines.length > 1 ? lines.join("\n") : undefined;
}

function renderFindSymbols(
	result: unknown,
	filePath: string,
	cwd: string,
): string | undefined {
	const items = arr(result);
	if (items.length === 0) return undefined;
	const header = displayFilePath(filePath, cwd);
	const lines: string[] = [header];
	for (const item of items) {
		const entry = rec(item);
		if (!entry) continue;
		const depth = num(entry.depth) ?? 1;
		const line = num(entry.line);
		const character = num(entry.character) ?? 1;
		const where =
			line === undefined ? header : `${header}:${line}:${character}`;
		const kind = str(entry.kind) ?? kindLabel(entry.kindCode);
		const name = str(entry.name) ?? "";
		lines.push(`${"  ".repeat(depth)}${where}  ${kind} ${name}`.trimEnd());
	}
	return lines.length > 1 ? lines.join("\n") : undefined;
}

function markupText(contents: unknown): string | undefined {
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) {
		const parts = contents
			.map((entry) => markupText(entry))
			.filter((part): part is string => Boolean(part));
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	}
	const entry = rec(contents);
	const value = str(entry?.value);
	return value;
}

function renderHover(result: unknown): string | undefined {
	const text = markupText(rec(result)?.contents);
	const trimmed = text?.trim();
	return trimmed ? trimmed : undefined;
}

function renderSignatureHelp(result: unknown): string | undefined {
	const entry = rec(result);
	if (!entry) return undefined;
	const signatures = arr(entry.signatures);
	if (signatures.length === 0) return undefined;
	const activeIndex = num(entry.activeSignature) ?? 0;
	const active = rec(signatures[activeIndex]) ?? rec(signatures[0]);
	if (!active) return undefined;
	const lines: string[] = [];
	const label = str(active.label);
	if (label) lines.push(label);
	const documentation = markupText(active.documentation)?.trim();
	if (documentation) lines.push(documentation);
	const activeParameter = num(entry.activeParameter);
	arr(active.parameters).forEach((parameter, index) => {
		const parameterLabel = str(rec(parameter)?.label);
		if (!parameterLabel) return;
		lines.push(`${index === activeParameter ? "→" : " "} ${parameterLabel}`);
	});
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function renderCodeActions(result: unknown): string | undefined {
	const lines: string[] = [];
	for (const item of arr(result)) {
		const entry = rec(item);
		if (!entry) continue;
		const title = str(entry.title);
		if (!title) continue;
		const kind = str(entry.kind);
		lines.push(kind ? `${kind}  ${title}` : title);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function renderAppliedEdit(entry: Rec, cwd: string): string | undefined {
	const descriptions = stringArray(entry.descriptions);
	const files = stringArray(entry.files);
	const total = num(entry.appliedOperationTotal) ?? num(entry.operationTotal);
	const lines: string[] = [];
	if (total !== undefined) {
		const across =
			files.length > 0
				? ` across ${files.length} file${files.length === 1 ? "" : "s"}`
				: "";
		lines.push(`Applied ${total} edit${total === 1 ? "" : "s"}${across}:`);
	} else {
		lines.push("Applied:");
	}
	if (descriptions.length > 0) {
		for (const description of descriptions) lines.push(`  ${description}`);
	} else {
		for (const file of files) {
			lines.push(`  ${displayFilePath(file, cwd)}`);
		}
	}
	return lines.length > 1 ? lines.join("\n") : undefined;
}

function renderRename(result: unknown, cwd: string): string | undefined {
	const entry = rec(result);
	if (!entry) return undefined;
	if (entry.applied !== true) {
		const summary = stringArray(entry.summary);
		const lines = summary.length > 0 ? summary : ["Rename preview"];
		lines.push("Preview only — pass apply:true to write the edits.");
		return lines.join("\n");
	}
	return renderAppliedEdit(entry, cwd);
}

/** `workspace/willRenameFiles` and `didRenameFiles` failures, one line each. */
function renameFailureLines(entry: Rec): string[] {
	const lines: string[] = [];
	for (const failure of [
		...arr(entry.willRenameFailures),
		...arr(entry.didRenameFailures),
	]) {
		const row = rec(failure);
		const serverId = str(row?.serverId);
		const message = str(row?.error);
		if (!serverId || !message) continue;
		const disposition = str(row?.disposition);
		lines.push(
			`  ${serverId}: ${message}${disposition ? ` (${disposition})` : ""}`,
		);
	}
	return lines;
}

function renderRenameFile(result: unknown, cwd: string): string | undefined {
	const entry = rec(result);
	if (!entry) return undefined;
	const summary = stringArray(entry.summary);
	const failures = renameFailureLines(entry);
	// #3734 r3 F5: a failing root is reported, not swallowed by the re-render.
	const report = (lines: string[]): string =>
		failures.length > 0
			? [...lines, "Server errors:", ...failures].join("\n")
			: lines.join("\n");
	if (entry.applied === true) {
		if (summary.length > 0) return report(summary);
		return report([renderAppliedEdit(entry, cwd) ?? "Applied."]);
	}
	return report([
		...(summary.length > 0 ? summary : ["File rename preview"]),
		"Preview only — pass apply:true to rename.",
	]);
}

function renderExecuteCommand(result: unknown): string | undefined {
	if (typeof result === "string") return result.trim() || undefined;
	const entry = rec(result);
	if (!entry) return undefined;
	if (entry.dryRun === true || entry.executed === false) {
		const command = str(entry.command) ?? "command";
		const lines = [
			`${command}: ${entry.advertised === true ? "advertised" : "NOT advertised"}`,
		];
		const note = str(entry.note);
		if (note) lines.push(note);
		return lines.join("\n");
	}
	// An executed command returns the server's arbitrary value, which no line
	// shape can read, so it renders as compact single-line JSON and nothing else.
	return JSON.stringify(result);
}

function diagnosticCode(code: unknown): string | undefined {
	if (typeof code === "string" || typeof code === "number") return String(code);
	return undefined;
}

function renderWorkspaceDiagnostics(
	result: unknown,
	cwd: string,
): string | undefined {
	const lines: string[] = [];
	for (const item of arr(result)) {
		const file = rec(item);
		if (!file) continue;
		const filePath = str(file.filePath) ?? "";
		const where = displayFilePath(filePath, cwd);
		for (const diagnostic of arr(file.diagnostics)) {
			const entry = rec(diagnostic);
			if (!entry) continue;
			const start = startOf(entry.range);
			const severity =
				SEVERITY_LABELS[num(entry.severity) ?? 0] ?? "diagnostic";
			const message = (str(entry.message) ?? "").replace(/\s+/g, " ").trim();
			const code = diagnosticCode(entry.code);
			const location = start
				? `${where}:${start.line}:${start.character}`
				: where;
			lines.push(
				`${location}: ${severity}${code ? ` [${code}]` : ""}: ${message}`,
			);
		}
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function renderBody(options: {
	operation: string;
	result: unknown;
	filePath: string;
	cwd: string;
	/** The uri of the call-hierarchy item the caller asked about. */
	callSiteUri?: string;
}): string | undefined {
	switch (options.operation) {
		case "definition":
		case "typeDefinition":
		case "declaration":
		case "references":
		case "implementation":
			return renderLocations(options.result, options.cwd);
		case "prepareCallHierarchy":
			return renderSymbolList(options.result, options.cwd);
		case "incomingCalls":
			return renderCalls(options.result, options.cwd, "from", undefined);
		case "outgoingCalls":
			return renderCalls(
				options.result,
				options.cwd,
				"to",
				options.callSiteUri,
			);
		case "documentSymbol":
			return renderDocumentSymbols(
				options.result,
				options.filePath,
				options.cwd,
			);
		case "findSymbol":
			return renderFindSymbols(options.result, options.filePath, options.cwd);
		case "workspaceSymbol":
			return renderSymbolList(options.result, options.cwd);
		case "hover":
			return renderHover(options.result);
		case "signatureHelp":
			return renderSignatureHelp(options.result);
		case "codeAction":
			return renderCodeActions(options.result);
		case "rename":
			return renderRename(options.result, options.cwd);
		case "rename_file":
			return renderRenameFile(options.result, options.cwd);
		case "executeCommand":
			return renderExecuteCommand(options.result);
		case "workspaceDiagnostics":
			return renderWorkspaceDiagnostics(options.result, options.cwd);
		default:
			return undefined;
	}
}

/**
 * Render a result as text, then re-attach the payload's own lines around it in
 * their original order: a leading `Note:` before the body, a trailing
 * `Note:`/`Hint:`/`LSP error:` after it. A result the renderer cannot read (an
 * error message, a note, the capabilities table) falls back to `text`.
 */
export function renderLspNavigationText(options: {
	operation: string;
	result: unknown;
	filePath: string;
	cwd: string;
	callSiteUri?: string;
	text: string;
}): string {
	const body = renderBody(options);
	if (body === undefined || body.length === 0) return options.text;
	const { leading, trailing } = lspNavigationTextSurround(options.text);
	return [...leading, body, ...trailing].join("\n\n");
}
