import fs from "node:fs/promises";
import type { BigIntStats, Stats } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import {
	isUnderDir,
	normalizeEphemeralMapKey,
	normalizeMapKey,
	pathsEqual,
	uriToDiskPath,
	uriToPath,
} from "./path-utils.js";
import {
	convertCharacterOffset,
	lineTextAt,
	type PositionEncoding,
} from "./position-encoding.js";
import { recordLspMutation, type LspMutationContext } from "../lsp-mutation.js";
import {
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
} from "../host-edit-normalize.js";

export interface LSPPosition {
	line: number;
	character: number;
}

export interface LSPRange {
	start: LSPPosition;
	end: LSPPosition;
}

export interface LSPTextEdit {
	range: LSPRange;
	newText: string;
}

interface TextDocumentEdit {
	textDocument: { uri: string; version?: number | null };
	edits: unknown[];
}

interface ResourceOptions {
	overwrite?: boolean;
	ignoreIfExists?: boolean;
	ignoreIfNotExists?: boolean;
	recursive?: boolean;
}

interface CreateFileOp {
	kind: "create";
	uri: string;
	options?: ResourceOptions;
}

interface RenameFileOp {
	kind: "rename";
	oldUri: string;
	newUri: string;
	options?: ResourceOptions;
}

interface DeleteFileOp {
	kind: "delete";
	uri: string;
	options?: ResourceOptions;
}

export interface AppliedWorkspaceFileDetail {
	filePath: string;
	range?: { start: number; end: number };
	importsChanged?: boolean;
}

export interface AppliedWorkspaceEdit {
	descriptions: string[];
	files: string[];
	/** Total logical operations, including text edits and resource operations. */
	operationTotal: number;
	/** Number of logical operations that actually reached disk. */
	appliedOperationTotal: number;
	/** Bounded samples; totals above remain explicit in the result. */
	appliedOperationIndexes: number[];
	operationCounts: {
		textEdits: number;
		create: number;
		rename: number;
		delete: number;
	};
	fileDetails: AppliedWorkspaceFileDetail[];
}

export interface ApplyWorkspaceEditOptions {
	/** The encoding used by the server that produced these positions. */
	positionEncoding?: PositionEncoding;
	/** Current client-side LSP document versions, keyed by normalized path. */
	documentVersions?: ReadonlyMap<string, number>;
	/** Optional shared bookkeeping for a mutation initiated by pi-lens. */
	mutationContext?: LspMutationContext;
	/** Rename flows use one outer bookkeeping record after their resource rename. */
	observe?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is LSPPosition {
	return (
		isRecord(value) &&
		Number.isFinite(value.line) &&
		Number.isInteger(value.line) &&
		(value.line as number) >= 0 &&
		Number.isFinite(value.character) &&
		Number.isInteger(value.character) &&
		(value.character as number) >= 0
	);
}

function comparePosition(a: LSPPosition, b: LSPPosition): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function isRange(value: unknown): value is LSPRange {
	if (!isRecord(value) || !isPosition(value.start) || !isPosition(value.end)) {
		return false;
	}
	return comparePosition(value.start, value.end) <= 0;
}

function isTextEdit(value: unknown): value is LSPTextEdit {
	return (
		isRecord(value) && isRange(value.range) && typeof value.newText === "string"
	);
}

function parseTextEdits(value: unknown, context: string): LSPTextEdit[] {
	if (!Array.isArray(value))
		throw new Error(`${context}.edits must be an array`);
	if (!value.every(isTextEdit))
		throw new Error(`malformed text edit in ${context}`);
	return value;
}

function parseVersion(
	value: unknown,
	context: string,
): number | null | undefined {
	if (value === undefined || value === null) return value;
	if (
		!Number.isFinite(value) ||
		!Number.isInteger(value) ||
		(value as number) < 0
	) {
		throw new Error(`${context}.version must be a nonnegative integer or null`);
	}
	return value as number;
}

function parseResourceOptions(
	value: unknown,
	kind: string,
): ResourceOptions | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error(`${kind}.options must be an object`);
	const allowed = new Set(
		kind === "delete"
			? ["ignoreIfNotExists", "recursive"]
			: ["overwrite", "ignoreIfExists"],
	);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key) || typeof value[key] !== "boolean") {
			throw new Error(`invalid ${kind}.options.${key}`);
		}
	}
	if (value.overwrite === true && value.ignoreIfExists === true) {
		throw new Error(`${kind} cannot set both overwrite and ignoreIfExists`);
	}
	if (kind !== "delete" && value.ignoreIfNotExists !== undefined) {
		throw new Error(`${kind} does not support ignoreIfNotExists`);
	}
	if (kind === "delete" && value.overwrite !== undefined) {
		throw new Error(`delete does not support overwrite`);
	}
	return value as ResourceOptions;
}

function parseTextDocumentEdit(
	value: unknown,
	context: string,
): TextDocumentEdit | null {
	if (!isRecord(value) || !isRecord(value.textDocument)) return null;
	if (typeof value.textDocument.uri !== "string") {
		throw new Error(`${context}.textDocument.uri must be a string`);
	}
	const version = parseVersion(
		value.textDocument.version,
		`${context}.textDocument`,
	);
	return {
		textDocument: { uri: value.textDocument.uri, version },
		edits: parseTextEdits(value.edits, context),
	};
}

function parseWorkspaceEdit(edit: {
	changes?: Record<string, unknown[]>;
	documentChanges?: unknown[];
}): void {
	if (!isRecord(edit)) throw new Error("workspace edit must be an object");
	if (edit.changes !== undefined) {
		if (!isRecord(edit.changes))
			throw new Error("workspace edit changes must be an object");
		for (const [uri, edits] of Object.entries(edit.changes)) {
			if (typeof uri !== "string")
				throw new Error("workspace edit URI must be a string");
			parseTextEdits(edits, `changes[${uri}]`);
		}
	}
	if (
		edit.documentChanges !== undefined &&
		!Array.isArray(edit.documentChanges)
	) {
		throw new Error("workspace edit documentChanges must be an array");
	}
	for (const [index, change] of (edit.documentChanges ?? []).entries()) {
		const text = parseTextDocumentEdit(change, `documentChanges[${index}]`);
		if (text) continue;
		if (!isRecord(change) || typeof change.kind !== "string") {
			throw new Error(`malformed documentChanges[${index}]`);
		}
		switch (change.kind) {
			case "create":
				if (typeof change.uri !== "string")
					throw new Error("create.uri must be a string");
				parseResourceOptions(change.options, "create");
				break;
			case "rename":
				if (
					typeof change.oldUri !== "string" ||
					typeof change.newUri !== "string"
				) {
					throw new Error("rename requires oldUri and newUri strings");
				}
				parseResourceOptions(change.options, "rename");
				break;
			case "delete":
				if (typeof change.uri !== "string")
					throw new Error("delete.uri must be a string");
				parseResourceOptions(change.options, "delete");
				break;
			default:
				throw new Error(
					`unsupported workspace resource operation: ${change.kind}`,
				);
		}
	}
}

function formatRange(range: LSPRange): string {
	return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

export function rangesOverlap(a: LSPRange, b: LSPRange): boolean {
	return (
		comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0
	);
}

function positionsEqual(a: LSPPosition, b: LSPPosition): boolean {
	return a.line === b.line && a.character === b.character;
}

function isEmptyRange(range: LSPRange): boolean {
	return positionsEqual(range.start, range.end);
}

/**
 * Order edits for reverse-application to a string: latest position first, so an
 * earlier splice never shifts a not-yet-applied edit's offsets. Ties break to
 * match LSP insertion semantics:
 *   - same start, larger END first → a replace anchored at position P applies
 *     before a zero-width insert at P, so the insert lands at the (post-replace)
 *     boundary instead of being clobbered — and the result no longer depends on
 *     listing order (P3-1, insert-at-replace-boundary);
 *   - same start AND end (e.g. several zero-width inserts at one point) → later
 *     ARRAY index first, so applying in this reverse order reproduces the edits'
 *     original array order (the #1066 same-position-insert invariant).
 *
 * This ordering is NOT idempotent for the same-range tie (re-sorting flips the
 * array index), so it MUST be applied exactly once, at the string-write site,
 * over array-order input. `normalizeTextEditsForContent` deliberately returns
 * edits in array order (never pre-sorted) so this single sort is the only pass.
 */
function sortEditsForApplication(edits: LSPTextEdit[]): LSPTextEdit[] {
	return edits
		.map((edit, index) => ({ edit, index }))
		.sort((a, b) => {
			const startDelta = comparePosition(
				b.edit.range.start,
				a.edit.range.start,
			);
			if (startDelta !== 0) return startDelta;
			const endDelta = comparePosition(b.edit.range.end, a.edit.range.end);
			if (endDelta !== 0) return endDelta;
			return b.index - a.index;
		})
		.map(({ edit }) => edit);
}

/**
 * Deduplicate exact non-empty duplicate edits and reject genuinely overlapping
 * ranges, returning the survivors in their ORIGINAL ARRAY ORDER. Zero-width
 * inserts are never deduplicated (their multiplicity is meaningful). Overlap is
 * checked on a position-sorted copy so the check is order-independent, but the
 * returned order is preserved for the single downstream application sort.
 */
function validateTextEdits(edits: LSPTextEdit[]): LSPTextEdit[] {
	const unique: LSPTextEdit[] = [];
	const seen = new Set<string>();
	for (const edit of edits) {
		if (!isEmptyRange(edit.range)) {
			const key = textEditKey("", edit);
			if (seen.has(key)) continue;
			seen.add(key);
		}
		unique.push(edit);
	}
	const ordered = sortEditsForApplication(unique);
	for (let index = 0; index < ordered.length - 1; index++) {
		const later = ordered[index]?.range;
		const earlier = ordered[index + 1]?.range;
		if (later && earlier && comparePosition(earlier.end, later.start) > 0) {
			throw new Error(
				`overlapping LSP edits: ${formatRange(earlier)} conflicts with ${formatRange(later)}`,
			);
		}
	}
	return unique;
}

function utf16Position(
	content: string,
	position: LSPPosition,
	encoding: PositionEncoding,
): LSPPosition {
	const line = lineTextAt(content, position.line);
	const wireLength = convertCharacterOffset(encoding, line, line.length);
	// `lineTextAt` splits on `\n` only and keeps a trailing `\r`, so the "real"
	// (spec) end of line content is BEFORE that `\r`, not after it. Clamp to
	// that boundary rather than `line.length`/`wireLength`, which include the
	// `\r`. `\r` is exactly one code unit in every encoding, so the clamped
	// wire length is always `wireLength - 1` when a `\r` is present.
	const hasTrailingCR = line.endsWith("\r");
	const clampedLength = hasTrailingCR ? line.length - 1 : line.length;
	const clampedWireLength = hasTrailingCR ? wireLength - 1 : wireLength;
	if (position.character > clampedWireLength) {
		// LSP 3.17: a character past the end of the line defaults to the line
		// length. Clamp to the UTF-16 line length rather than throwing (whole-line
		// and whole-document sentinel ranges rely on this) — landing the position
		// at the CRLF boundary, not between `\r` and `\n`. Otherwise the whole-line
		// sentinel replace `(0,0)-(0,999)` would eat the `\r` and a char-past-EOL
		// insert would land mid-CRLF (P2-1 corruption on Windows repos).
		//
		// This also covers a caller-supplied position that is NOT past the line's
		// full (with-`\r`) length but still lands strictly between `\r` and `\n`
		// (i.e. `position.character === wireLength` when a `\r` is present): that
		// position is `> clampedWireLength` too, since `clampedWireLength ===
		// wireLength - 1`, so it clamps to the same CRLF-safe boundary instead of
		// slipping through as an "in-bounds" position (#1147 P3-5, general class
		// beyond #1120's strict past-EOL clamp).
		return { line: position.line, character: clampedLength };
	}
	if (encoding === "utf-16") return position;
	// Find the UTF-16 offset whose encoded prefix has exactly this length. This
	// rejects offsets in the middle of a UTF-8 sequence or UTF-16 surrogate pair.
	for (let offset = 0; offset <= line.length; offset++) {
		// A UTF-32 position cannot split a UTF-16 surrogate pair.
		if (encoding === "utf-32" && offset > 0 && offset < line.length) {
			const previous = line.charCodeAt(offset - 1);
			const current = line.charCodeAt(offset);
			if (
				previous >= 0xd800 &&
				previous <= 0xdbff &&
				current >= 0xdc00 &&
				current <= 0xdfff
			)
				continue;
		}
		if (convertCharacterOffset(encoding, line, offset) === position.character) {
			return { line: position.line, character: offset };
		}
	}
	throw new Error(
		`text edit character ${position.character} is not a ${encoding} boundary`,
	);
}

function normalizeTextEditsForContent(
	content: string,
	edits: LSPTextEdit[],
	encoding: PositionEncoding,
): LSPTextEdit[] {
	const lines = content.split("\n");
	const lastLine = Math.max(0, lines.length - 1);
	// The target file's dominant EOL style, detected the same way the host edit
	// tool does (first-occurrence-wins). Every `newText` is normalized to this
	// style below so a server-supplied bare `\n` can never be spliced verbatim
	// into a CRLF file and produce mixed line endings — the LSP workspace-edit
	// apply path now shares the exact contract the host-edit path already
	// enforces via `host-edit-normalize.ts` (#1147 P3-5, general class). A no-op
	// for LF files: `restoreLineEndings` is the identity when `ending === "\n"`.
	const ending = detectLineEnding(content);
	const clamp = (position: LSPPosition): LSPPosition => {
		// LSP 3.17: a line past the end of the document defaults to the end of the
		// document (last line, its length). Clamp rather than throw so a large
		// sentinel end position — e.g. the (0,0)-(9999,0) whole-document replace
		// idiom — resolves to a real range instead of failing.
		if (position.line >= lines.length) {
			return { line: lastLine, character: (lines[lastLine] ?? "").length };
		}
		return utf16Position(content, position, encoding);
	};
	const converted = edits.map((edit) => {
		const start = clamp(edit.range.start);
		const end = clamp(edit.range.end);
		if (comparePosition(start, end) > 0)
			throw new Error("text edit range is out of order");
		return {
			...edit,
			range: { start, end },
			newText: restoreLineEndings(normalizeToLF(edit.newText), ending),
		};
	});
	// Return array order (validated, deduped); the single application-ordering
	// sort happens once at the string-write site in applyTextEditsToString.
	return validateTextEdits(converted);
}

export function applyTextEditsToString(
	content: string,
	edits: LSPTextEdit[],
	positionEncoding: PositionEncoding = "utf-16",
): string {
	const lines = content.split("\n");
	// normalizeTextEditsForContent returns array order; sort for reverse
	// application exactly once, here, at the single string-write site.
	const normalized = sortEditsForApplication(
		normalizeTextEditsForContent(content, edits, positionEncoding),
	);
	for (const edit of normalized) {
		const { start, end } = edit.range;
		if (start.line === end.line) {
			const line = lines[start.line] ?? "";
			lines[start.line] =
				line.slice(0, start.character) +
				edit.newText +
				line.slice(end.character);
			continue;
		}
		const startLine = lines[start.line] ?? "";
		const endLine = lines[end.line] ?? "";
		const replacement =
			startLine.slice(0, start.character) +
			edit.newText +
			endLine.slice(end.character);
		lines.splice(
			start.line,
			end.line - start.line + 1,
			...replacement.split("\n"),
		);
	}
	return lines.join("\n");
}

export async function normalizeWorkspaceEditToUtf16(
	edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] },
	positionEncoding: PositionEncoding,
	cwd: string,
): Promise<{
	changes?: Record<string, unknown[]>;
	documentChanges?: unknown[];
}> {
	parseWorkspaceEdit(edit);
	if (positionEncoding === "utf-16") return edit;

	// Use the same ordered planner and virtual resource/content model as the
	// eventual apply. This is important for edits such as rename(oldDir, newDir)
	// followed by a text edit at newDir/file.ts: the destination is not on disk
	// yet, but its content is available through the virtual move.
	const planned = planWorkspaceEdit(edit, true);
	const prepared = await preflightWorkspaceEdit(planned, cwd, {
		positionEncoding,
	});
	const normalizedByOrigin = new Map<string, LSPTextEdit[]>();
	for (const op of planned) {
		if (op.kind !== "text") continue;
		for (const origin of op.origins ?? []) {
			normalizedByOrigin.set(
				textEditOriginKey(origin),
				prepared.textByOrigin.get(textEditOriginKey(origin)) ?? [],
			);
		}
	}

	const changes: Record<string, unknown[]> = {};
	for (const uri of Object.keys(edit.changes ?? {})) {
		changes[uri] =
			normalizedByOrigin.get(
				textEditOriginKey({ kind: "changes", uri, edits: [] }),
			) ?? [];
	}
	const documentChanges: unknown[] = [];
	for (const [index, change] of (edit.documentChanges ?? []).entries()) {
		const text = parseTextDocumentEdit(change, `documentChanges[${index}]`);
		if (!text) {
			documentChanges.push(change);
			continue;
		}
		documentChanges.push({
			...(change as Record<string, unknown>),
			edits:
				normalizedByOrigin.get(
					textEditOriginKey({ kind: "documentChanges", index, edits: [] }),
				) ?? [],
		});
	}
	return {
		...(edit.changes !== undefined ? { changes } : {}),
		...(edit.documentChanges !== undefined ? { documentChanges } : {}),
	};
}

export function flattenWorkspaceTextEdits(edit: {
	changes?: Record<string, unknown[]>;
	documentChanges?: unknown[];
}): Map<string, LSPTextEdit[]> {
	parseWorkspaceEdit(edit);
	const buckets = new Map<string, { uri: string; edits: LSPTextEdit[] }>();
	const push = (uri: string, edits: unknown[]) => {
		const textEdits = parseTextEdits(edits, uri);
		if (textEdits.length === 0) return;
		const key = pathIndexKey(uri);
		const existing = buckets.get(key);
		if (existing) existing.edits.push(...textEdits);
		else buckets.set(key, { uri, edits: [...textEdits] });
	};
	for (const [uri, edits] of Object.entries(edit.changes ?? {}))
		push(uri, edits);
	for (const change of edit.documentChanges ?? []) {
		const text = parseTextDocumentEdit(change, "documentChanges");
		if (text) push(text.textDocument.uri, text.edits);
	}
	return new Map([...buckets.values()].map(({ uri, edits }) => [uri, edits]));
}

function textEditKey(uri: string, edit: LSPTextEdit): string {
	return [
		pathIndexKey(uri),
		edit.range.start.line,
		edit.range.start.character,
		edit.range.end.line,
		edit.range.end.character,
		edit.newText,
	].join(":");
}

export interface MergeWorkspaceEditsResult {
	edit: { changes: Record<string, LSPTextEdit[]> };
	droppedConflicts: number;
	inputEditCount: number;
	serverIds: string[];
}

export function mergeWorkspaceTextEditsByPriority(
	entries: Array<{
		serverId: string;
		edit:
			| { changes?: Record<string, unknown[]>; documentChanges?: unknown[] }
			| null
			| undefined;
	}>,
): MergeWorkspaceEditsResult {
	const merged = new Map<string, { uri: string; edits: LSPTextEdit[] }>();
	// Exact-duplicate dedup is a CROSS-SERVER concern only: two servers proposing
	// the identical non-empty replace should collapse to one. Zero-width inserts
	// are never deduplicated here — same as `validateTextEdits` on the normal
	// apply path — because their multiplicity is meaningful: a single server can
	// legitimately emit several identical zero-width inserts at one position
	// (e.g. `willRenameFiles` producing "QQ" twice for an "aQQbc" edit), and
	// deduping on exact key alone would silently drop the duplicate within that
	// one server's own edit, contradicting the invariant documented above
	// `validateTextEdits`.
	const seenExact = new Set<string>();
	let droppedConflicts = 0;
	let inputEditCount = 0;
	const serverIds: string[] = [];
	for (const entry of entries) {
		serverIds.push(entry.serverId);
		if (!entry.edit) continue;
		for (const [uri, edits] of flattenWorkspaceTextEdits(entry.edit)) {
			const key = pathIndexKey(uri);
			const bucket = merged.get(key) ?? { uri, edits: [] };
			const kept = bucket.edits;
			for (const edit of edits) {
				inputEditCount += 1;
				const exactKey = isEmptyRange(edit.range)
					? undefined
					: textEditKey(uri, edit);
				if (exactKey !== undefined && seenExact.has(exactKey)) continue;
				if (
					kept.some((existing) => rangesOverlap(existing.range, edit.range))
				) {
					droppedConflicts += 1;
					continue;
				}
				if (exactKey !== undefined) seenExact.add(exactKey);
				kept.push(edit);
			}
			if (kept.length > 0) merged.set(key, bucket);
		}
	}
	const changes: Record<string, LSPTextEdit[]> = {};
	for (const { uri, edits } of merged.values()) changes[uri] = edits;
	return { edit: { changes }, droppedConflicts, inputEditCount, serverIds };
}

type TextEditOrigin =
	| { kind: "changes"; uri: string; edits: LSPTextEdit[] }
	| { kind: "documentChanges"; index: number; edits: LSPTextEdit[] };

type WorkspaceEditOp =
	| {
			kind: "text";
			uri: string;
			edits: LSPTextEdit[];
			version?: number | null;
			origins?: TextEditOrigin[];
	  }
	| CreateFileOp
	| RenameFileOp
	| DeleteFileOp;

function pathIndexKey(uri: string): string {
	// uriToPath already resolves the path through normalizeFilePath, including
	// realpath canonicalization for existing files. Re-canonicalizing that
	// result with normalizeMapKey made every planner lookup perform a second
	// synchronous filesystem walk; this index is call-scoped, so the cheap fold
	// is sufficient after the first canonicalization.
	return normalizeEphemeralMapKey(uriToPath(uri));
}

function textEditOriginKey(origin: TextEditOrigin): string {
	// This is an input-container identity, not a filesystem/resource key. Keep
	// the original URI spelling so two equivalent `changes` keys cannot overwrite
	// each other's normalized output while the planner still coalesces them.
	return origin.kind === "changes"
		? `changes:${origin.uri}`
		: `documentChanges:${origin.index}`;
}

function parseResource(change: Record<string, unknown>): WorkspaceEditOp {
	const kind = change.kind;
	if (kind === "create")
		return {
			kind,
			uri: change.uri as string,
			options: parseResourceOptions(change.options, kind),
		};
	if (kind === "rename")
		return {
			kind,
			oldUri: change.oldUri as string,
			newUri: change.newUri as string,
			options: parseResourceOptions(change.options, kind),
		};
	if (kind === "delete")
		return {
			kind,
			uri: change.uri as string,
			options: parseResourceOptions(change.options, kind),
		};
	throw new Error(`unsupported workspace resource operation: ${String(kind)}`);
}

function planWorkspaceEdit(
	edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] },
	trackOrigins = false,
): WorkspaceEditOp[] {
	parseWorkspaceEdit(edit);
	const ops: WorkspaceEditOp[] = [];
	const pending = new Map<
		string,
		{
			uri: string;
			edits: LSPTextEdit[];
			version?: number | null;
			origins?: TextEditOrigin[];
		}
	>();
	const descendants = new Map<string, Set<string>>();
	const indexedAncestors = new Map<string, string[]>();
	const seenResources = new Set<string>();
	const pathKeys = new Map<string, string>();
	const indexKey = (uri: string): string => {
		const cached = pathKeys.get(uri);
		if (cached !== undefined) return cached;
		const key = pathIndexKey(uri);
		pathKeys.set(uri, key);
		return key;
	};
	const addIndex = (key: string): void => {
		const ancestors: string[] = [];
		let current = key;
		// `key` is a normalized URI index key, not an on-disk directory. The
		// index intentionally uses the key's own separator/root semantics, so
		// walkUpDirs (which resolves through the host filesystem) is not suitable.
		while (true) {
			const set = descendants.get(current) ?? new Set<string>();
			set.add(key);
			descendants.set(current, set);
			ancestors.push(current);
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
		indexedAncestors.set(key, ancestors);
	};
	const removeIndex = (key: string): void => {
		for (const ancestor of indexedAncestors.get(key) ?? [])
			descendants.get(ancestor)?.delete(key);
		indexedAncestors.delete(key);
	};
	const queue = (
		uri: string,
		edits: LSPTextEdit[],
		version: number | null | undefined,
		origin?: TextEditOrigin,
	): void => {
		const key = indexKey(uri);
		const existing = pending.get(key);
		if (existing) {
			// Per LSP 3.17, `version: null` means "don't check" — it is not itself a
			// version to conflict against. Only two DIFFERENT numeric versions for the
			// same URI are a genuine conflict; a numeric version is authoritative and
			// adopted over a `null`/`undefined` counterpart from another edit container
			// for the same document, so the later preflight version check (which only
			// fires for numeric `op.version`) still validates it.
			const existingNumeric =
				typeof existing.version === "number" ? existing.version : undefined;
			const incomingNumeric = typeof version === "number" ? version : undefined;
			if (
				existingNumeric !== undefined &&
				incomingNumeric !== undefined &&
				existingNumeric !== incomingNumeric
			) {
				throw new Error(`conflicting text document versions for ${uri}`);
			}
			existing.edits.push(...edits);
			if (origin) (existing.origins ??= []).push(origin);
			if (existingNumeric === undefined && incomingNumeric !== undefined)
				existing.version = version;
			return;
		}
		if (origin) {
			pending.set(key, { uri, edits: [...edits], version, origins: [origin] });
		} else {
			pending.set(key, { uri, edits: [...edits], version });
		}
		addIndex(key);
	};
	const flushUri = (uri: string): void => {
		const key = indexKey(uri);
		const item = pending.get(key);
		if (!item) return;
		pending.delete(key);
		removeIndex(key);
		if (item.origins) {
			ops.push({
				kind: "text",
				uri: item.uri,
				edits: item.edits,
				version: item.version,
				origins: item.origins,
			});
		} else {
			ops.push({
				kind: "text",
				uri: item.uri,
				edits: item.edits,
				version: item.version,
			});
		}
	};
	const flushSubtree = (uri: string): void => {
		const key = indexKey(uri);
		// flushUri -> removeIndex deletes `candidate` from this very Set (`key`
		// is one of `candidate`'s ancestors by construction). No defensive copy
		// needed: Set iterators reflect deletions safely — deleting the current
		// or a not-yet-visited entry during iteration removes it from the
		// remaining traversal without skipping or duplicating any other member
		// (verified: https://tc39.es/ecma262/#sec-set.prototype.values, same
		// guarantee already relied on for the Map iteration below and at
		// clients/lsp/client.ts / clients/persist-debounce.ts /
		// clients/review-graph/builder.ts). Nothing adds to `descendants`
		// during this loop (only `addIndex` does, and it isn't called here).
		for (const candidate of descendants.get(key) ?? []) {
			const item = pending.get(candidate);
			if (item) flushUri(item.uri);
		}
	};
	for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
		const parsed = parseTextEdits(edits, `changes[${uri}]`);
		queue(
			uri,
			parsed,
			undefined,
			trackOrigins ? { kind: "changes", uri, edits: parsed } : undefined,
		);
	}
	for (const [index, change] of (edit.documentChanges ?? []).entries()) {
		const text = parseTextDocumentEdit(change, `documentChanges[${index}]`);
		if (text) {
			queue(
				text.textDocument.uri,
				text.edits as LSPTextEdit[],
				text.textDocument.version,
				trackOrigins
					? {
							kind: "documentChanges",
							index,
							edits: text.edits as LSPTextEdit[],
						}
					: undefined,
			);
			continue;
		}
		const resource = parseResource(change as Record<string, unknown>);
		const resourceKey =
			resource.kind === "rename"
				? `rename:${indexKey(resource.oldUri)}:${indexKey(resource.newUri)}`
				: `${resource.kind}:${indexKey(resource.uri)}`;
		if (seenResources.has(resourceKey))
			throw new Error(`duplicate workspace resource operation: ${resourceKey}`);
		seenResources.add(resourceKey);
		if (resource.kind === "create") flushUri(resource.uri);
		else if (resource.kind === "rename") {
			flushSubtree(resource.oldUri);
			flushSubtree(resource.newUri);
		} else flushSubtree(resource.uri);
		ops.push(resource);
	}
	// flushUri deletes from `pending` — the same Map being iterated here — but
	// Map iterators reflect deletions safely (see flushSubtree above), so no
	// defensive copy is needed.
	for (const item of pending.values()) flushUri(item.uri);
	return ops;
}

/** Test-only planning probe used by the scaled occupancy regression. */
export function __planWorkspaceEditForTest(edit: {
	changes?: Record<string, unknown[]>;
	documentChanges?: unknown[];
}): number {
	return planWorkspaceEdit(edit).length;
}

function relativeToCwd(filePath: string, cwd: string): string {
	const rel = path.relative(cwd, filePath) || path.basename(filePath);
	return rel.replace(/\\/g, "/");
}

// Matches an import declaration or a re-export-from declaration — the two
// statement shapes that actually change a module's dependency edges. Also
// matches a bare `from "..."` continuation line WITHOUT a leading `import`/
// `export`, so a formatter-wrapped multiline import
//   import {
//     foo,
//   } from "./old";
// still flags its specifier line as import-relevant even though line 1
// ("import {") doesn't itself contain the module path. Fail-safe direction:
// this can over-match a non-import line that happens to contain `from "..."`
// (e.g. a string literal), but that only risks over-reporting `importsChanged`
// (the safe direction — master's prior /^import\s/m heuristic over-invalidated
// too), never under-reporting a real specifier change.
const IMPORT_RELEVANT_LINE =
	/^\s*import\b|^\s*export\s[^;]*\bfrom\s|\bfrom\s+['"]/;

/**
 * A stable signature of the import/re-export-from lines in `text`, order-
 * preserved. Used to detect whether a text edit actually changed the file's
 * import graph (P3-6) rather than merely landing in a file that HAS imports —
 * `fileDetails[].importsChanged` gates expensive downstream dependency-graph
 * re-checks (see `cache-manager.ts`'s `importsChanged` filter and
 * `lsp-mutation.ts`'s `addModifiedRange`), so over-reporting "changed" on
 * every edit to an already-import-bearing file defeats that gate. This is a
 * LINE-signature heuristic, not a parse: a multiline import whose specifier
 * ("from" line) is untouched but whose bound-name list changes on an
 * interior line (e.g. renaming one of several named imports without
 * touching the `import {`/`} from "..."` lines) is not detected — narrower
 * than a full import-statement diff, but still strictly safer than the prior
 * "file merely contains any import" heuristic. Known pre-existing gaps
 * (unaddressed here, same as before): dynamic `import(...)` calls and
 * `require(...)` are not import-relevant lines by this heuristic.
 */
function importsSignature(text: string): string {
	return text
		.split("\n")
		.filter((line) => IMPORT_RELEVANT_LINE.test(line))
		.join("\n");
}

export function summarizeWorkspaceEdit(
	edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] },
	cwd: string,
): string[] {
	const lines: string[] = [];
	for (const [uri, edits] of flattenWorkspaceTextEdits(edit))
		lines.push(
			`Apply ${edits.length} edit(s) to ${relativeToCwd(uriToPath(uri), cwd)}`,
		);
	for (const change of edit.documentChanges ?? []) {
		if (!isRecord(change) || typeof change.kind !== "string") continue;
		if (change.kind === "create" && typeof change.uri === "string")
			lines.push(`Create ${relativeToCwd(uriToPath(change.uri), cwd)}`);
		else if (
			change.kind === "rename" &&
			typeof change.oldUri === "string" &&
			typeof change.newUri === "string"
		)
			lines.push(
				`Rename ${relativeToCwd(uriToPath(change.oldUri), cwd)} → ${relativeToCwd(uriToPath(change.newUri), cwd)}`,
			);
		else if (change.kind === "delete" && typeof change.uri === "string")
			lines.push(`Delete ${relativeToCwd(uriToPath(change.uri), cwd)}`);
	}
	return lines;
}

type VirtualFile = { exists: boolean; directory: boolean; content?: string };

async function lstatOrMissing(filePath: string): Promise<Stats | undefined> {
	try {
		return await fs.lstat(filePath);
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return undefined;
		throw err;
	}
}

/**
 * True when two `lstat` results denote the SAME on-disk entry. Requires a
 * matching `dev` AND a matching, NONZERO `ino`. The nonzero guard is
 * load-bearing: ino-less filesystems (FAT32/exFAT, some SMB redirectors,
 * VirtualBox shared folders) report `ino: 0` for every entry via libuv, so
 * without it two DISTINCT files would compare `(dev, 0) === (dev, 0)` and a
 * rename would be misclassified as a case-only alias and silently clobber the
 * destination. Comparing the BigInt fields (from `lstat({ bigint: true })`)
 * also avoids the double-precision loss on NTFS 64-bit file IDs >= 2^53 that a
 * `number` `ino` would suffer (which could false-equal distinct files).
 * Anything that is not a confident same-entry match returns false → the caller
 * falls back to the destination-exists check (fail-closed). Exported for direct
 * unit coverage of the ino-0 guard.
 */
export function isSameFsIdentity(
	a: { dev: bigint; ino: bigint },
	b: { dev: bigint; ino: bigint },
): boolean {
	return a.dev === b.dev && a.ino !== 0n && b.ino !== 0n && a.ino === b.ino;
}

async function bigintLstatOrMissing(
	filePath: string,
): Promise<BigIntStats | undefined> {
	try {
		return await fs.lstat(filePath, { bigint: true });
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return undefined;
		throw err;
	}
}

/**
 * True when two paths name the SAME on-disk entry — how a case-only rename on a
 * case-insensitive FS is told apart from a genuine destination conflict without
 * branching on `process.platform`. `lstat` (not `stat`) so a symlink is compared
 * as itself, consistent with the rest of the preflight's symlink policy. See
 * `isSameFsIdentity` for the dev/ino identity rules (and the ino-0 fail-closed
 * guard for ino-less filesystems).
 */
async function isSameFsEntry(a: string, b: string): Promise<boolean> {
	const [statA, statB] = await Promise.all([
		bigintLstatOrMissing(a),
		bigintLstatOrMissing(b),
	]);
	return Boolean(statA && statB && isSameFsIdentity(statA, statB));
}

async function assertParentIsUsable(
	filePath: string,
	stateFor: (filePath: string) => Promise<VirtualFile>,
): Promise<void> {
	let current = path.dirname(filePath);
	while (true) {
		const known = await stateFor(current);
		if (known.exists) {
			if (!known.directory)
				throw new Error(`resource parent is not a directory: ${current}`);
			return;
		}
		const parent = path.dirname(current);
		if (parent === current)
			throw new Error(`resource parent does not exist: ${filePath}`);
		current = parent;
	}
}

async function resolveExistingAncestor(filePath: string): Promise<string> {
	let current = path.resolve(filePath);
	const tail: string[] = [];
	while (true) {
		try {
			const resolved = await fs.realpath(current);
			return path.join(resolved, ...tail.reverse());
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
			const parent = path.dirname(current);
			if (parent === current) throw err;
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

async function createWorkspaceUriConfiner(
	cwd: string,
): Promise<(uri: string) => Promise<string>> {
	const root = await resolveExistingAncestor(cwd);
	return async (uri: string): Promise<string> => {
		let filePath = "";
		try {
			const parsed = new URL(uri);
			if (
				parsed.protocol !== "file:" ||
				(parsed.host !== "" && parsed.hostname !== "localhost")
			)
				throw new Error("URI must be a local file URI");
			filePath = uriToPath(uri);
		} catch (err) {
			throw new Error(
				`invalid workspace edit URI ${uri}: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err },
			);
		}
		if (!path.isAbsolute(filePath))
			throw new Error(`workspace edit path escapes workspace: ${uri}`);
		const resolved = await resolveExistingAncestor(filePath);
		if (!isUnderDir(resolved, root))
			throw new Error(`workspace edit path escapes workspace: ${uri}`);
		return filePath;
	};
}

/** Validate a resource-only workspace edit without applying any mutation. */
export async function validateWorkspaceEdit(
	edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] },
	cwd: string,
): Promise<void> {
	const planned = planWorkspaceEdit(edit);
	await preflightWorkspaceEdit(planned, cwd, {});
}

async function preflightWorkspaceEdit(
	planned: WorkspaceEditOp[],
	cwd: string,
	options: ApplyWorkspaceEditOptions,
): Promise<{
	text: Map<WorkspaceEditOp, LSPTextEdit[]>;
	textByOrigin: Map<string, LSPTextEdit[]>;
	ignored: Set<WorkspaceEditOp>;
}> {
	const confine = await createWorkspaceUriConfiner(cwd);
	const virtual = new Map<string, VirtualFile>();
	// State for a path that `resolveVirtualPath` cannot resolve to a physical
	// address — i.e. a path CURRENTLY vacated by an earlier rename in this same
	// edit (its "from" address, still shadowed by an active virtual move) — but
	// which a later `create` op in the same ordered edit re-establishes at that
	// exact address. Keyed on the raw (unresolved) query path because there is
	// no physical path to key `virtual` on. Consulted only when `resolveVirtualPath`
	// returns undefined, so it never shadows a real physical/virtual-move address.
	const virtualOverrides = new Map<string, VirtualFile>();
	const virtualMoves: Array<{
		from: string;
		to: string;
		directory: boolean;
	}> = [];
	const virtualTombstones: Array<{ path: string; directory: boolean }> = [];
	const text = new Map<WorkspaceEditOp, LSPTextEdit[]>();
	const textByOrigin = new Map<string, LSPTextEdit[]>();
	const ignored = new Set<WorkspaceEditOp>();
	const resolveVirtualPath = (filePath: string): string | undefined => {
		let resolved = filePath;
		for (let index = virtualMoves.length - 1; index >= 0; index--) {
			const move = virtualMoves[index];
			if (
				isUnderDir(resolved, move.to) &&
				(move.directory || pathsEqual(resolved, move.to))
			) {
				const suffix = path.relative(move.to, resolved);
				resolved = suffix ? path.join(move.from, suffix) : move.from;
				continue;
			}
			if (
				isUnderDir(resolved, move.from) &&
				(move.directory || pathsEqual(resolved, move.from))
			) {
				return undefined;
			}
		}
		return resolved;
	};
	const isTombstoned = (filePath: string): boolean =>
		virtualTombstones.some(
			(tombstone) =>
				pathsEqual(filePath, tombstone.path) ||
				(tombstone.directory && isUnderDir(filePath, tombstone.path)),
		);
	const clearTombstonesUnder = (filePath: string): void => {
		for (let index = virtualTombstones.length - 1; index >= 0; index--) {
			const tombstone = virtualTombstones[index];
			if (
				pathsEqual(tombstone.path, filePath) ||
				isUnderDir(tombstone.path, filePath)
			) {
				virtualTombstones.splice(index, 1);
			}
		}
	};
	const stateFor = async (filePath: string): Promise<VirtualFile> => {
		if (isTombstoned(filePath)) return { exists: false, directory: false };
		const physicalPath = resolveVirtualPath(filePath);
		if (!physicalPath) {
			return (
				virtualOverrides.get(normalizeMapKey(filePath)) ?? {
					exists: false,
					directory: false,
				}
			);
		}
		const key = normalizeMapKey(physicalPath);
		const known = virtual.get(key);
		if (known) return known;
		const stat = await lstatOrMissing(physicalPath);
		const value = {
			exists: Boolean(stat),
			directory: stat?.isDirectory() ?? false,
		};
		virtual.set(key, value);
		return value;
	};
	const contentFor = async (
		filePath: string,
		state: VirtualFile,
	): Promise<string> => {
		if (!state.exists || state.directory)
			throw new Error(`text edit target is not a file: ${filePath}`);
		if (state.content !== undefined) return state.content;
		const physicalPath = resolveVirtualPath(filePath);
		if (!physicalPath)
			throw new Error(`text edit target does not exist: ${filePath}`);
		const content = await fs.readFile(physicalPath, "utf-8");
		state.content = content;
		return content;
	};
	for (const op of planned) {
		if (op.kind === "text") {
			const filePath = await confine(op.uri);
			const state = await stateFor(filePath);
			if (op.version !== undefined && op.version !== null) {
				const current = options.documentVersions?.get(
					normalizeMapKey(filePath),
				);
				if (current === undefined || current !== op.version)
					throw new Error(
						`stale text document version for ${filePath}: expected ${op.version}, current ${current ?? "unknown"}`,
					);
			}
			const content = await contentFor(filePath, state);
			const encoding = options.positionEncoding ?? "utf-16";
			const normalized = normalizeTextEditsForContent(
				content,
				op.edits,
				encoding,
			);
			text.set(op, normalized);

			// Keep the normalized edits attached to their original LSP containers.
			// A planner operation can combine `changes` with a documentChanges text
			// edit for the same URI, so the combined validation above remains the
			// authority while this assignment preserves version/resource ordering.
			for (const origin of op.origins ?? []) {
				// Origins are already validated together above, but must retain
				// multiplicity: identical zero-width insertions are meaningful and
				// must not be deduplicated while restoring the original containers.
				textByOrigin.set(
					textEditOriginKey(origin),
					normalizeTextEditsForContent(content, origin.edits, encoding),
				);
			}
			state.content = applyTextEditsToString(content, normalized);
			continue;
		}
		if (op.kind === "create") {
			const filePath = await confine(op.uri);
			const state = await stateFor(filePath);
			await assertParentIsUsable(filePath, stateFor);
			if (state.exists) {
				if (op.options?.ignoreIfExists) {
					ignored.add(op);
					continue;
				}
				if (!op.options?.overwrite || state.directory)
					throw new Error(`create target already exists: ${filePath}`);
				state.content = "";
			} else {
				clearTombstonesUnder(filePath);
				state.exists = true;
				state.directory = false;
				state.content = "";
				const physicalPath = resolveVirtualPath(filePath);
				if (physicalPath) virtual.set(normalizeMapKey(physicalPath), state);
				// `resolveVirtualPath` returns undefined for a path currently shadowed
				// by an earlier rename's vacated "from" address in this same ordered
				// edit (P3-3): the created state has nowhere physical to live, so it
				// must be recorded in the override overlay keyed on the raw query path
				// instead — otherwise a later op addressing this exact path (e.g. a
				// text edit) would see it as still-vacated/nonexistent.
				else virtualOverrides.set(normalizeMapKey(filePath), state);
			}
			continue;
		}
		if (op.kind === "rename") {
			const oldPath = await confine(op.oldUri);
			const newPath = await confine(op.newUri);
			// "Must differ" is a property of the on-disk target, not the case-folded
			// map key. A case-only rename (foo.txt → Foo.txt) is a legitimate refactor
			// whose decoded paths differ even though they collapse to a single key on a
			// case-insensitive filesystem — so compare the decoded disk paths here, and
			// treat a same-key-different-case pair as a real rename below.
			const oldDisk = uriToDiskPath(op.oldUri);
			const newDisk = uriToDiskPath(op.newUri);
			if (
				path.resolve(oldDisk).replace(/\\/g, "/") ===
				path.resolve(newDisk).replace(/\\/g, "/")
			) {
				throw new Error("rename source and destination must differ");
			}
			const source = await stateFor(oldPath);
			if (!source.exists)
				throw new Error(`rename source does not exist: ${oldPath}`);
			// Captured BEFORE this rename's own `virtualMoves`/override mutations
			// below, so it reflects how `source` was actually resolved: `true` when
			// `oldPath` is itself shadowed by an earlier rename in this edit and the
			// state came from the `virtualOverrides` overlay (P3-3) rather than a
			// physically-addressable entry.
			const sourceFromOverride = resolveVirtualPath(oldPath) === undefined;
			await assertParentIsUsable(newPath, stateFor);
			const destination = await stateFor(newPath);
			if (destination.exists) {
				// Decide "already exists" by on-disk IDENTITY, not a platform-keyed path
				// fold. A case-only (or otherwise-aliased) rename whose destination
				// resolves to the SAME FS entry as the source is a legitimate refactor,
				// not a conflict — detected here on ANY case-insensitive FS (win32, macOS
				// APFS/HFS+), per the #1024 "probe the FS, don't branch on platform"
				// lesson. Conversely, on a case-SENSITIVE FS where both spellings are
				// distinct real files, this stays a genuine conflict (closing the inverse
				// silent-clobber edge that a win32-only fold left open).
				//
				// P3-8: when the source exists only VIRTUALLY (e.g. created earlier in
				// this same ordered edit and never yet written to disk), `isSameFsEntry`
				// lstats disk and finds nothing there, so it can never recognize a
				// case-only alias for a not-yet-physical file. `stateFor` keys the
				// `virtual`/override maps on the SAME case-folded identity used for
				// physical aliasing, so if `destination` and `source` resolved to the
				// identical cached VirtualFile object, they are — by construction of
				// that keying — the same virtual entry (a case-insensitive-FS alias);
				// checked as a fast, disk-free first branch before falling back to the
				// physical probe (which remains untouched for genuinely-physical paths).
				const aliasesSource =
					destination === source || (await isSameFsEntry(oldDisk, newDisk));
				if (!aliasesSource) {
					if (op.options?.ignoreIfExists) {
						ignored.add(op);
						continue;
					}
					if (!op.options?.overwrite)
						throw new Error(`rename destination already exists: ${newPath}`);
				}
			}
			clearTombstonesUnder(newPath);
			if (!source.directory) await contentFor(oldPath, source);
			if (sourceFromOverride) {
				// P3 (round-2 review): a purely virtual entry (created earlier in this
				// same edit at a path vacated by an even earlier rename) has no
				// physical address for a `virtualMoves` shadow to resolve against —
				// `resolveVirtualPath` walks that list by PHYSICAL path chasing, which
				// cannot represent "this virtual entry moved again." Pushing a move
				// here would leave the stale `virtualOverrides[oldPath]` entry
				// claiming `exists: true` forever (a later `create(oldPath)` would be
				// falsely rejected, and reads of the new address wouldn't reliably
				// find it either). Instead, migrate the state object directly: drop
				// the stale key and re-key it under the destination, placing it back
				// in `virtual` (physically addressable) or `virtualOverrides` (still
				// shadowed) depending on whether the destination itself currently
				// resolves to a physical path.
				virtualOverrides.delete(normalizeMapKey(oldPath));
				const destinationPhysicalPath = resolveVirtualPath(newPath);
				if (destinationPhysicalPath)
					virtual.set(normalizeMapKey(destinationPhysicalPath), source);
				else virtualOverrides.set(normalizeMapKey(newPath), source);
			} else {
				// Keep descendants lazy: a later text edit under a renamed directory
				// resolves through this virtual move to the original physical path.
				// This preserves ordered workspace-edit semantics without walking the
				// entire subtree during preflight.
				virtualMoves.push({
					from: oldPath,
					to: newPath,
					directory: source.directory,
				});
			}
			continue;
		}
		const filePath = await confine(op.uri);
		const state = await stateFor(filePath);
		if (!state.exists) {
			if (op.options?.ignoreIfNotExists) ignored.add(op);
			else throw new Error(`delete target does not exist: ${filePath}`);
		} else {
			if (state.directory && !op.options?.recursive)
				throw new Error(`delete directory requires recursive: ${filePath}`);
			state.exists = false;
			state.content = undefined;
			virtualTombstones.push({ path: filePath, directory: state.directory });
		}
	}
	return { text, textByOrigin, ignored };
}

/**
 * Applies a workspace edit. All URI, shape, version, resource-precondition and
 * text-bound checks happen in preflight before the first write. Once preflight
 * succeeds, an unexpected filesystem failure may still leave earlier mutations
 * applied; this is intentionally the existing no-rollback boundary.
 */
export async function applyWorkspaceEdit(
	edit: { changes?: Record<string, unknown[]>; documentChanges?: unknown[] },
	cwd: string,
	options: ApplyWorkspaceEditOptions = {},
): Promise<AppliedWorkspaceEdit> {
	const descriptions: string[] = [];
	const touchedFiles = new Set<string>();
	const fileDetails: AppliedWorkspaceFileDetail[] = [];
	const appliedOperationIndexes: number[] = [];
	let appliedOperationTotal = 0;
	let operationIndex = 0;
	const operationCounts = { textEdits: 0, create: 0, rename: 0, delete: 0 };
	const planned = planWorkspaceEdit(edit);
	let operationTotal = 0;
	let prepared: Awaited<ReturnType<typeof preflightWorkspaceEdit>>;
	const operationSize = (op: WorkspaceEditOp): number =>
		op.kind === "text" ? (prepared.text.get(op)?.length ?? 0) : 1;
	const markApplied = (op: WorkspaceEditOp): void => {
		const count = operationSize(op);
		for (let index = 0; index < count; index++) {
			if (appliedOperationIndexes.length < 100) {
				appliedOperationIndexes.push(operationIndex + index);
			}
		}
		appliedOperationTotal += count;
		operationIndex += count;
	};
	const skipOperation = (op: WorkspaceEditOp): void => {
		operationIndex += operationSize(op);
	};
	const makeResult = (): AppliedWorkspaceEdit => ({
		descriptions,
		files: [...touchedFiles],
		operationTotal,
		appliedOperationTotal,
		appliedOperationIndexes,
		operationCounts,
		fileDetails,
	});
	try {
		prepared = await preflightWorkspaceEdit(planned, cwd, options);
		for (const op of planned) {
			const size = operationSize(op);
			if (op.kind === "text") operationCounts.textEdits += size;
			else operationCounts[op.kind]++;
			operationTotal += size;
		}
		for (const op of planned) {
			if (prepared.ignored.has(op)) {
				skipOperation(op);
				continue;
			}
			if (op.kind === "text") {
				// Report/key on the normalized path (forward-slash, realpath-canonical),
				// but read/write the decoded on-disk path so the URI's casing is honored
				// on win32 (see uriToDiskPath).
				const filePath = uriToPath(op.uri);
				const diskPath = uriToDiskPath(op.uri);
				const edits = prepared.text.get(op) ?? [];
				if (edits.length === 0) {
					skipOperation(op);
					continue;
				}
				const content = await fs.readFile(diskPath, "utf-8");
				const updated = applyTextEditsToString(content, edits, "utf-16");
				await fs.writeFile(diskPath, updated, "utf-8");
				const start = Math.min(
					...edits.map((item) => item.range.start.line + 1),
				);
				const end = Math.max(...edits.map((item) => item.range.end.line + 1));
				touchedFiles.add(filePath);
				fileDetails.push({
					filePath,
					range: { start, end },
					importsChanged:
						importsSignature(content) !== importsSignature(updated),
				});
				markApplied(op);
				descriptions.push(
					`Applied ${edits.length} edit(s) to ${relativeToCwd(filePath, cwd)}`,
				);
			} else if (op.kind === "create") {
				// Create on the decoded path so `NewFile.txt` is not lowercased on win32;
				// report/key on the normalized path.
				const filePath = uriToPath(op.uri);
				const diskPath = uriToDiskPath(op.uri);
				await fs.mkdir(path.dirname(diskPath), { recursive: true });
				if (op.options?.overwrite) await fs.writeFile(diskPath, "", "utf-8");
				else await fs.writeFile(diskPath, "", { flag: "wx" });
				touchedFiles.add(filePath);
				fileDetails.push({
					filePath,
					range: { start: 1, end: 1 },
					importsChanged: false,
				});
				markApplied(op);
				descriptions.push(`Created ${relativeToCwd(filePath, cwd)}`);
			} else if (op.kind === "rename") {
				// Rename on the decoded paths so the destination casing is honored (and a
				// case-only rename actually changes the name); report on normalized paths.
				const oldPath = uriToPath(op.oldUri);
				const newPath = uriToPath(op.newUri);
				const oldDisk = uriToDiskPath(op.oldUri);
				const newDisk = uriToDiskPath(op.newUri);
				await fs.mkdir(path.dirname(newDisk), { recursive: true });
				if (op.options?.overwrite)
					await fs.rm(newDisk, { recursive: true, force: true });
				await fs.rename(oldDisk, newDisk);
				touchedFiles.add(oldPath);
				touchedFiles.add(newPath);
				fileDetails.push(
					{
						filePath: oldPath,
						range: { start: 1, end: 1 },
						importsChanged: true,
					},
					{
						filePath: newPath,
						range: { start: 1, end: 1 },
						importsChanged: true,
					},
				);
				markApplied(op);
				descriptions.push(
					`Renamed ${relativeToCwd(oldPath, cwd)} → ${relativeToCwd(newPath, cwd)}`,
				);
			} else {
				const filePath = uriToPath(op.uri);
				const diskPath = uriToDiskPath(op.uri);
				await fs.rm(diskPath, {
					recursive: op.options?.recursive === true,
					force: false,
				});
				touchedFiles.add(filePath);
				fileDetails.push({
					filePath,
					range: { start: 1, end: 1 },
					importsChanged: true,
				});
				markApplied(op);
				descriptions.push(`Deleted ${relativeToCwd(filePath, cwd)}`);
			}
		}
	} catch (err) {
		const partial = makeResult();
		if (options.mutationContext && options.observe !== false) {
			recordLspMutation(options.mutationContext, {
				results: [partial],
				status: "failed",
			});
		}
		const already = [...touchedFiles];
		if (already.length > 0) {
			const alreadyList = already
				.map((f) => `  • ${relativeToCwd(f, cwd)}`)
				.join("\n");
			const failure = new Error(
				`Workspace edit failed mid-application — ${already.length} file(s) already written, no rollback performed:\n${alreadyList}\nCause: ${err instanceof Error ? err.message : String(err)}`,
			) as Error & { appliedWorkspaceEdit?: AppliedWorkspaceEdit };
			failure.appliedWorkspaceEdit = partial;
			throw failure;
		}
		throw err;
	}
	const applied = makeResult();
	if (options.mutationContext && options.observe !== false) {
		recordLspMutation(options.mutationContext, {
			results: [applied],
			status: appliedOperationTotal > 0 ? "success" : "skipped",
		});
	}
	return applied;
}
