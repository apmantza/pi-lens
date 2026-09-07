import { fileURLToPath, pathToFileURL } from "node:url";

type LspToolName = "lsp_navigation" | "lsp_diagnostics";

type LspToolStatus =
	| "success"
	| "empty"
	| "unsupported"
	| "bad_input"
	| "no_server"
	| "lsp_disabled"
	| "filepath_is_directory"
	| "tracked_snapshot"
	| "error";

type LspToolLocation = {
	uri?: string;
	filePath: string;
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
};

export type LspToolEnvelope = {
	tool: LspToolName;
	operation?: string;
	ok: boolean;
	status: LspToolStatus;
	filePath?: string;
	resultCount: number;
	result?: unknown;
	diagnostics?: unknown;
	locations?: LspToolLocation[];
	notes?: string[];
	hints?: string[];
	errors?: string[];
	metadata?: Record<string, unknown>;
};

type RangeLike = {
	start?: { line?: unknown; character?: unknown };
	end?: { line?: unknown; character?: unknown };
};

type ParsedTextPayload = {
	result?: unknown;
	notes: string[];
	hints: string[];
	errors: string[];
};

export type BuildLspNavigationEnvelopeOptions = {
	operation: string;
	filePath?: string;
	failureKind: string;
	resultCount: number;
	text?: string;
	isError?: boolean;
	details?: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function lspStatusFromFailureKind(failureKind: string): LspToolStatus {
	if (failureKind === "success" || failureKind === "fallback_success") {
		return "success";
	}
	if (failureKind === "empty_result") return "empty";
	if (failureKind === "unsupported") return "unsupported";
	if (
		failureKind === "bad_input" ||
		failureKind === "invalid_operation" ||
		failureKind === "missing_file_path"
	) {
		return "bad_input";
	}
	if (failureKind === "no_server") return "no_server";
	if (failureKind === "lsp_disabled") return "lsp_disabled";
	if (failureKind === "filepath_is_directory") return "filepath_is_directory";
	if (failureKind === "tracked_snapshot") return "tracked_snapshot";
	return "error";
}

function lspToolLocationFromUriRange(
	uri: unknown,
	range: unknown,
): LspToolLocation | undefined {
	if (typeof uri !== "string" || !uri.startsWith("file:")) return undefined;
	const rangeLike = asRecord(range) as RangeLike | undefined;
	const startLine = finiteNumber(rangeLike?.start?.line);
	const startCharacter = finiteNumber(rangeLike?.start?.character);
	const endLine = finiteNumber(rangeLike?.end?.line);
	const endCharacter = finiteNumber(rangeLike?.end?.character);
	if (
		startLine === undefined ||
		startCharacter === undefined ||
		endLine === undefined ||
		endCharacter === undefined
	) {
		return undefined;
	}
	try {
		return {
			uri,
			filePath: fileURLToPath(uri),
			// LLM-facing coordinates: 1-based, matching editor/tool params.
			range: {
				start: {
					line: Math.floor(startLine) + 1,
					character: Math.floor(startCharacter) + 1,
				},
				end: {
					line: Math.floor(endLine) + 1,
					character: Math.floor(endCharacter) + 1,
				},
			},
		};
	} catch {
		return undefined;
	}
}

function lspToolLocationFromFileRange(
	filePath: string,
	range: unknown,
): LspToolLocation | undefined {
	if (!filePath || filePath === "(workspace)") return undefined;
	const rangeLike = asRecord(range) as RangeLike | undefined;
	const startLine = finiteNumber(rangeLike?.start?.line);
	const startCharacter = finiteNumber(rangeLike?.start?.character);
	const endLine = finiteNumber(rangeLike?.end?.line);
	const endCharacter = finiteNumber(rangeLike?.end?.character);
	if (
		startLine === undefined ||
		startCharacter === undefined ||
		endLine === undefined ||
		endCharacter === undefined
	) {
		return undefined;
	}
	return {
		uri: pathToFileURL(filePath).href,
		filePath,
		range: {
			start: {
				line: Math.floor(startLine) + 1,
				character: Math.floor(startCharacter) + 1,
			},
			end: {
				line: Math.floor(endLine) + 1,
				character: Math.floor(endCharacter) + 1,
			},
		},
	};
}

function pushToolLocation(
	out: LspToolLocation[],
	uri: unknown,
	range: unknown,
): void {
	const loc = lspToolLocationFromUriRange(uri, range);
	if (loc) out.push(loc);
}

function collectLocationSummaries(
	result: unknown,
	filePath: string,
): LspToolLocation[] {
	const out: LspToolLocation[] = [];
	for (const entry of Array.isArray(result) ? result : [result]) {
		const record = asRecord(entry);
		if (!record) continue;
		pushToolLocation(out, record.uri, record.range);
		pushToolLocation(
			out,
			record.targetUri,
			record.targetSelectionRange ?? record.targetRange,
		);
		if (!record.uri && !record.targetUri) {
			const local = lspToolLocationFromFileRange(filePath, record.range);
			let alreadyIncluded = false;
			for (const loc of out) {
				if (loc.uri === local?.uri) {
					alreadyIncluded = true;
					break;
				}
			}
			if (local && !alreadyIncluded) out.push(local);
		}
	}
	return out;
}

function collectWorkspaceSymbolLocationSummaries(
	result: unknown,
): LspToolLocation[] {
	const out: LspToolLocation[] = [];
	for (const entry of Array.isArray(result) ? result : [result]) {
		const symbol = asRecord(entry);
		const location = asRecord(symbol?.location);
		if (!location) continue;
		pushToolLocation(out, location.uri, location.range);
		pushToolLocation(
			out,
			location.targetUri,
			location.targetSelectionRange ?? location.targetRange,
		);
	}
	return out;
}

function collectCallHierarchyLocationSummaries(
	result: unknown,
	operation: "incomingCalls" | "outgoingCalls",
): LspToolLocation[] {
	const out: LspToolLocation[] = [];
	for (const entry of Array.isArray(result) ? result : [result]) {
		const record = asRecord(entry);
		const item = asRecord(
			operation === "incomingCalls" ? record?.from : record?.to,
		);
		pushToolLocation(out, item?.uri, item?.selectionRange ?? item?.range);
	}
	return out;
}

function collectLspToolLocationsForOperation(
	operation: string,
	result: unknown,
	filePath: string,
): LspToolLocation[] {
	if (
		[
			"definition",
			"typeDefinition",
			"declaration",
			"references",
			"implementation",
			"prepareCallHierarchy",
		].includes(operation)
	) {
		return collectLocationSummaries(result, filePath);
	}
	if (operation === "workspaceSymbol") {
		return collectWorkspaceSymbolLocationSummaries(result);
	}
	if (operation === "documentSymbol" || operation === "findSymbol") {
		return collectLocationSummaries(result, filePath);
	}
	if (operation === "incomingCalls" || operation === "outgoingCalls") {
		return collectCallHierarchyLocationSummaries(result, operation);
	}
	return [];
}

function parseBalancedJsonPrefix(
	text: string,
): { value: unknown; rest: string } | undefined {
	const trimmed = text.trim();
	const start = trimmed.search(/[[{]/);
	if (start < 0) return undefined;
	const open = trimmed[start];
	const close = open === "[" ? "]" : "}";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < trimmed.length; i += 1) {
		const ch = trimmed[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === open) depth += 1;
		if (ch === close) depth -= 1;
		if (depth === 0) {
			try {
				return {
					value: JSON.parse(trimmed.slice(start, i + 1)),
					rest: trimmed.slice(i + 1).trim(),
				};
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

function parseLspNavigationTextPayload(text: string): ParsedTextPayload {
	const notes: string[] = [];
	const hints: string[] = [];
	const errors: string[] = [];
	const trimmed = text.trim();
	if (!trimmed) return { notes, hints, errors };
	try {
		return { result: JSON.parse(trimmed), notes, hints, errors };
	} catch {
		// Continue with note/hint extraction and balanced-prefix parsing.
	}

	const lines = trimmed.split(/\r?\n/);
	let jsonCandidate = trimmed;
	if (/^Note:/i.test(lines[0] ?? "") && lines.length > 1) {
		notes.push((lines.shift() ?? "").replace(/^Note:\s*/i, ""));
		jsonCandidate = lines.join("\n").trim();
	}
	const parsed = parseBalancedJsonPrefix(jsonCandidate);
	if (parsed) {
		for (const entry of parsed.rest.split(/\r?\n/)) {
			const line = entry.trim();
			if (!line) continue;
			if (/^Hint:/i.test(line)) hints.push(line.replace(/^Hint:\s*/i, ""));
			else if (/^Note:/i.test(line)) notes.push(line.replace(/^Note:\s*/i, ""));
			else notes.push(line);
		}
		return { result: parsed.value, notes, hints, errors };
	}
	for (const entry of lines) {
		const line = entry.trim();
		if (!line) continue;
		if (/^Hint:/i.test(line)) hints.push(line.replace(/^Hint:\s*/i, ""));
		else if (/^Note:/i.test(line)) notes.push(line.replace(/^Note:\s*/i, ""));
		else if (/^LSP error:/i.test(line)) errors.push(line);
		else notes.push(line);
	}
	return { notes, hints, errors };
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) {
		if (value[key] === undefined) delete value[key];
	}
	return value;
}

export function buildLspNavigationEnvelope(
	options: BuildLspNavigationEnvelopeOptions,
): LspToolEnvelope {
	const parsed = parseLspNavigationTextPayload(options.text ?? "");
	const status = lspStatusFromFailureKind(options.failureKind);
	const result = parsed.result;
	const notes = [...parsed.notes];
	const hints = [...parsed.hints];
	const errors = [...parsed.errors];
	if (options.isError && errors.length === 0 && (options.text ?? "").trim()) {
		errors.push((options.text ?? "").trim());
	}
	const locations = collectLspToolLocationsForOperation(
		options.operation,
		result,
		options.filePath ?? "",
	);
	return withoutUndefined({
		tool: "lsp_navigation" as const,
		operation: options.operation,
		ok: !options.isError,
		status,
		filePath: options.filePath,
		resultCount: options.resultCount,
		result,
		locations: locations.length > 0 ? locations : undefined,
		notes: notes.length > 0 ? notes : undefined,
		hints: hints.length > 0 ? hints : undefined,
		errors: errors.length > 0 ? errors : undefined,
		metadata: options.details,
	});
}
