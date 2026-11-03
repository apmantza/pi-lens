/**
 * Neovim-style text rendering for `lsp_navigation`'s default view.
 *
 * The tool's default `content` is the text a Neovim LSP user sees, not the raw
 * LSP JSON:
 *
 *   - a location list (definition / references / implementation / call
 *     hierarchy) prints one `path:line:col` entry per hit, the quickfix and
 *     picker shape `vim.lsp.util.locations_to_items` produces;
 *   - `prepareCallHierarchy` prints the symbol line, then that item verbatim as
 *     `callHierarchyItem: <json>`, which the traversal calls take back;
 *   - `hover` prints its markdown, `signatureHelp` the active signature;
 *   - `documentSymbol` / `findSymbol` print an indented `start-end kind name`
 *     tree, the same compact shape `ast_grep_outline` uses;
 *   - `workspaceDiagnostics` prints `path:line:col: severity: message`, the
 *     `vim.diagnostic.toqflist` line, under a `path (scanned 5m ago)` header
 *     when the snapshot stamped that file's age;
 *   - a rename prints the edit summary it computed.
 *
 * `view:"json"` keeps the structured envelope (`tools/lsp-structured-output.ts`)
 * reachable and byte-identical to the pre-text default. Every renderer here
 * returns `undefined` when it cannot read a structured value, and the caller
 * then falls back to the tool's own text (an error, a note, or the capabilities
 * table).
 *
 * Display paths are project-relative through one resolver built per render call
 * (`createDisplay`), and decode URIs through `uriToDiskPath` (never `uriToPath`,
 * whose `realpath` is map-key normalization and would pay filesystem I/O per
 * location). An executed command's value is the one exception: its payload is
 * the server's arbitrary value, so it renders as compact single-line JSON.
 */

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
 * The display seam one render reads: project-relative file paths and decoded
 * URIs for one project root.
 *
 * The resolver is built per render call, so a root is still canonicalized once
 * for a whole location list (500 locations, half outside the root, 7.46 ms ->
 * 5.05 ms per render, #1449) while nothing outlives the request: a module-level
 * per-root map retained one resolver per project a long-lived process had ever
 * rendered (defect shape 51, #5224 review G6).
 */
type Display = {
	file(filePath: string): string;
	uri(uri: string): string;
};

function createDisplay(cwd: string): Display {
	const resolveDisplay = createProjectRelativePathResolver(cwd);
	const file = (filePath: string): string =>
		resolveDisplay(filePath) || filePath;
	return { file, uri: (uri: string) => file(uriToDiskPath(uri)) };
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
	display: Display,
): string | undefined {
	const start = startOf(range);
	if (!start) return undefined;
	return `${display.uri(uri)}:${start.line}:${start.character}`;
}

/** A symbol/entry carrying `uri`+`range`, `location`, or `targetUri`+`targetRange`. */
function symbolLine(entry: Rec, display: Display): string | undefined {
	const location = rec(entry.location);
	const uri = str(entry.uri) ?? str(location?.uri) ?? str(entry.targetUri);
	const range =
		rec(location?.range) ??
		rec(entry.selectionRange) ??
		rec(entry.range) ??
		rec(entry.targetSelectionRange) ??
		rec(entry.targetRange);
	if (!uri || !range) return undefined;
	const line = locationLine(uri, range, display);
	if (!line) return undefined;
	const name = str(entry.name);
	return name ? `${line}  ${kindLabel(entry.kind)} ${name}` : line;
}

function renderLocations(
	result: unknown,
	display: Display,
): string | undefined {
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
		const line = locationLine(uri, range, display);
		if (line) lines.push(line);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function renderSymbolList(
	result: unknown,
	display: Display,
): string | undefined {
	const lines: string[] = [];
	for (const item of arr(result)) {
		const entry = rec(item);
		if (!entry) continue;
		const line = symbolLine(entry, display);
		if (line) lines.push(line);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * A `prepareCallHierarchy` answer: the symbol line, then the item itself as one
 * `callHierarchyItem: <json>` line.
 *
 * The traversal operations take that item back verbatim, both ranges and the
 * server's own `data`, so a symbol line alone left the caller nothing to pass
 * and forced a second prepare (#5224 review G1). The JSON is the item
 * unchanged, which is exactly what the parameter accepts.
 */
function renderCallHierarchyPreparation(
	result: unknown,
	display: Display,
): string | undefined {
	const lines: string[] = [];
	for (const item of arr(result)) {
		const entry = rec(item);
		if (!entry) continue;
		const line = symbolLine(entry, display);
		if (!line) continue;
		lines.push(line, `callHierarchyItem: ${JSON.stringify(entry)}`);
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
	display: Display,
	side: "from" | "to",
	callSiteUri: string | undefined,
): string | undefined {
	const lines: string[] = [];
	for (const item of arr(result)) {
		const entry = rec(item);
		const symbol = rec(entry?.[side]);
		if (!symbol) continue;
		const line = symbolLine(symbol, display);
		if (!line) continue;
		lines.push(line);
		const siteUri = side === "from" ? str(symbol.uri) : callSiteUri;
		if (!siteUri) continue;
		for (const range of arr(entry?.fromRanges)) {
			const site = locationLine(siteUri, range, display);
			if (site) lines.push(`  ${site}`);
		}
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function renderDocumentSymbols(
	result: unknown,
	filePath: string,
	display: Display,
): string | undefined {
	const items = arr(result);
	if (items.length === 0) return undefined;
	const header = display.file(filePath);
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
	display: Display,
): string | undefined {
	const items = arr(result);
	if (items.length === 0) return undefined;
	const header = display.file(filePath);
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
	if (value === undefined) return undefined;
	// A `MarkedString` snippet carries its language, which a bare `value` read
	// dropped so `{ language, value }` hover rendered as prose (#5224 review G7).
	const language = str(entry?.language);
	return language ? `\`\`\`${language}\n${value}\n\`\`\`` : value;
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

function renderAppliedEdit(entry: Rec, display: Display): string | undefined {
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
			lines.push(`  ${display.file(file)}`);
		}
	}
	return lines.length > 1 ? lines.join("\n") : undefined;
}

function renderRename(result: unknown, display: Display): string | undefined {
	const entry = rec(result);
	if (!entry) return undefined;
	if (entry.applied !== true) {
		const summary = stringArray(entry.summary);
		const lines = summary.length > 0 ? summary : ["Rename preview"];
		lines.push("Preview only — pass apply:true to write the edits.");
		return lines.join("\n");
	}
	return renderAppliedEdit(entry, display);
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

function renderRenameFile(
	result: unknown,
	display: Display,
): string | undefined {
	const entry = rec(result);
	if (!entry) return undefined;
	const summary = stringArray(entry.summary);
	const descriptions = stringArray(entry.descriptions);
	const failures = renameFailureLines(entry);
	// A conflicting edit the server dropped is a partial rename the answer has to
	// name, or the completed summary reads as a full one (#5224 review G4).
	const dropped = num(entry.droppedConflicts) ?? 0;
	// #3734 r3 F5: a failing root is reported, not swallowed by the re-render.
	const report = (lines: string[]): string => {
		const out = [...lines];
		if (failures.length > 0) out.push("Server errors:", ...failures);
		if (dropped > 0)
			out.push(
				`Warning: ${dropped} conflicting edit${dropped === 1 ? "" : "s"} dropped.`,
			);
		return out.join("\n");
	};
	if (entry.applied !== true) {
		return report([
			...(summary.length > 0 ? summary : ["File rename preview"]),
			"Preview only — pass apply:true to rename.",
		]);
	}
	// `descriptions` is built from the edits that landed, while `summary` is built
	// before the write, so the completed list is the applied record (#5224 G3).
	const applied = renderAppliedEdit(entry, display);
	if (descriptions.length > 0 && applied) return report([applied]);
	if (summary.length > 0) return report(summary);
	return report([applied ?? "Applied."]);
}

/** A client `reason` that names a timeout, whose edits may still be landing. */
const TIMED_OUT_COMMAND_REASON = /\btimed out\b/i;

function renderExecuteCommand(result: unknown): string | undefined {
	// A bare string is the server's value, so it renders as JSON: `trim()` would
	// strip its quotes, keep its newlines, and turn "" into undefined (#5224 CR2).
	if (typeof result === "string") return JSON.stringify(result);
	const entry = rec(result);
	if (!entry) return undefined;
	// Dry run: the tool reports advertisement status and runs nothing.
	if (entry.dryRun === true) {
		const command = str(entry.command) ?? "command";
		const lines = [
			`${command}: ${entry.advertised === true ? "advertised" : "NOT advertised"}`,
		];
		const note = str(entry.note);
		if (note) lines.push(note);
		return lines.join("\n");
	}
	// A client that refused or timed out answers `executed:false` with a `reason`;
	// reading that as a dry run printed the advertisement line instead of the
	// failure, and a timeout may still be writing server-side (#5224 review G2).
	if (entry.executed === false) {
		const reason = str(entry.reason);
		const lines = [`Not executed: ${reason ?? "no reason reported"}`];
		if (reason && TIMED_OUT_COMMAND_REASON.test(reason)) {
			lines.push(
				"Warning: the command timed out; the server may still be changing files.",
			);
		}
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
	display: Display,
): string | undefined {
	const lines: string[] = [];
	for (const item of arr(result)) {
		const file = rec(item);
		if (!file) continue;
		const filePath = str(file.filePath) ?? "";
		const where = display.file(filePath);
		const diagnostics = arr(file.diagnostics);
		if (diagnostics.length === 0) continue;
		// The path-less snapshot replays what each client last published and stamps
		// each file's age; only the envelope carried it, so a replayed row read as
		// current (#1634, #5224 review G5/CR1).
		const lag = str(file.lag);
		if (lag) lines.push(`${where} (${lag})`);
		for (const diagnostic of diagnostics) {
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
	display: Display;
	/** The uri of the call-hierarchy item the caller asked about. */
	callSiteUri?: string;
}): string | undefined {
	switch (options.operation) {
		case "definition":
		case "typeDefinition":
		case "declaration":
		case "references":
		case "implementation":
			return renderLocations(options.result, options.display);
		case "prepareCallHierarchy":
			return renderCallHierarchyPreparation(options.result, options.display);
		case "incomingCalls":
			return renderCalls(options.result, options.display, "from", undefined);
		case "outgoingCalls":
			return renderCalls(
				options.result,
				options.display,
				"to",
				options.callSiteUri,
			);
		case "documentSymbol":
			return renderDocumentSymbols(
				options.result,
				options.filePath,
				options.display,
			);
		case "findSymbol":
			return renderFindSymbols(
				options.result,
				options.filePath,
				options.display,
			);
		case "workspaceSymbol":
			return renderSymbolList(options.result, options.display);
		case "hover":
			return renderHover(options.result);
		case "signatureHelp":
			return renderSignatureHelp(options.result);
		case "codeAction":
			return renderCodeActions(options.result);
		case "rename":
			return renderRename(options.result, options.display);
		case "rename_file":
			return renderRenameFile(options.result, options.display);
		case "executeCommand":
			return renderExecuteCommand(options.result);
		case "workspaceDiagnostics":
			return renderWorkspaceDiagnostics(options.result, options.display);
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
	const body = renderBody({ ...options, display: createDisplay(options.cwd) });
	if (body === undefined || body.length === 0) return options.text;
	const { leading, trailing } = lspNavigationTextSurround(options.text);
	return [...leading, body, ...trailing].join("\n\n");
}
