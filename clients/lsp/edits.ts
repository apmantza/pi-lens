import fs from "node:fs/promises";
import path from "node:path";
import { uriToPath } from "./path-utils.js";
import {
	recordLspMutation,
	type LspMutationContext,
} from "../lsp-mutation.js";

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
	textDocument: { uri: string };
	edits: unknown[];
}

interface CreateFileOp {
	kind: "create";
	uri: string;
}

interface RenameFileOp {
	kind: "rename";
	oldUri: string;
	newUri: string;
}

interface DeleteFileOp {
	kind: "delete";
	uri: string;
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

function isPosition(value: unknown): value is LSPPosition {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { line?: unknown }).line === "number" &&
		typeof (value as { character?: unknown }).character === "number"
	);
}

function isRange(value: unknown): value is LSPRange {
	return (
		typeof value === "object" &&
		value !== null &&
		isPosition((value as { start?: unknown }).start) &&
		isPosition((value as { end?: unknown }).end)
	);
}

function isTextEdit(value: unknown): value is LSPTextEdit {
	return (
		typeof value === "object" &&
		value !== null &&
		isRange((value as { range?: unknown }).range) &&
		typeof (value as { newText?: unknown }).newText === "string"
	);
}

function isTextDocumentEdit(value: unknown): value is TextDocumentEdit {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { textDocument?: { uri?: unknown } }).textDocument?.uri ===
			"string" &&
		Array.isArray((value as { edits?: unknown }).edits)
	);
}

function comparePosition(a: LSPPosition, b: LSPPosition): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function formatRange(range: LSPRange): string {
	return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

export function rangesOverlap(a: LSPRange, b: LSPRange): boolean {
	return (
		comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0
	);
}

export function applyTextEditsToString(
	content: string,
	edits: LSPTextEdit[],
): string {
	const sortedEdits = [...edits].sort((a, b) => {
		const lineDelta = b.range.start.line - a.range.start.line;
		return lineDelta !== 0
			? lineDelta
			: b.range.start.character - a.range.start.character;
	});

	for (let index = 0; index < sortedEdits.length - 1; index++) {
		const later = sortedEdits[index]?.range;
		const earlier = sortedEdits[index + 1]?.range;
		if (later && earlier && comparePosition(earlier.end, later.start) > 0) {
			throw new Error(
				`overlapping LSP edits: ${formatRange(earlier)} conflicts with ${formatRange(later)}`,
			);
		}
	}

	const lines = content.split("\n");
	for (const edit of sortedEdits) {
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

export function flattenWorkspaceTextEdits(edit: {
	changes?: Record<string, unknown[]>;
	documentChanges?: unknown[];
}): Map<string, LSPTextEdit[]> {
	const out = new Map<string, LSPTextEdit[]>();
	const push = (uri: string, edits: unknown[]) => {
		const textEdits = edits.filter(isTextEdit);
		if (textEdits.length === 0) return;
		const existing = out.get(uri);
		if (existing) existing.push(...textEdits);
		else out.set(uri, [...textEdits]);
	};

	for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
		push(uri, edits);
	}

	for (const change of edit.documentChanges ?? []) {
		if (isTextDocumentEdit(change)) {
			push(change.textDocument.uri, change.edits);
		}
	}

	return out;
}

function textEditKey(uri: string, edit: LSPTextEdit): string {
	return [
		uri,
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
	const merged = new Map<string, LSPTextEdit[]>();
	const seenExact = new Set<string>();
	let droppedConflicts = 0;
	let inputEditCount = 0;
	const serverIds: string[] = [];

	for (const entry of entries) {
		serverIds.push(entry.serverId);
		if (!entry.edit) continue;
		for (const [uri, edits] of flattenWorkspaceTextEdits(entry.edit)) {
			const kept = merged.get(uri) ?? [];
			for (const edit of edits) {
				inputEditCount += 1;
				const exactKey = textEditKey(uri, edit);
				if (seenExact.has(exactKey)) continue;
				if (
					kept.some((existing) => rangesOverlap(existing.range, edit.range))
				) {
					droppedConflicts += 1;
					continue;
				}
				seenExact.add(exactKey);
				kept.push(edit);
			}
			if (kept.length > 0) merged.set(uri, kept);
		}
	}

	const changes: Record<string, LSPTextEdit[]> = {};
	for (const [uri, edits] of merged) {
		changes[uri] = edits;
	}
	return { edit: { changes }, droppedConflicts, inputEditCount, serverIds };
}

function relativeToCwd(filePath: string, cwd: string): string {
	const rel = path.relative(cwd, filePath) || path.basename(filePath);
	return rel.replace(/\\/g, "/");
}

export function summarizeWorkspaceEdit(
	edit: {
		changes?: Record<string, unknown[]>;
		documentChanges?: unknown[];
	},
	cwd: string,
): string[] {
	const lines: string[] = [];
	const textEditsByUri = flattenWorkspaceTextEdits(edit);
	for (const [uri, edits] of textEditsByUri) {
		lines.push(
			`Apply ${edits.length} edit(s) to ${relativeToCwd(uriToPath(uri), cwd)}`,
		);
	}
	for (const change of edit.documentChanges ?? []) {
		if (typeof change !== "object" || change === null || !("kind" in change))
			continue;
		const kind = (change as { kind?: unknown }).kind;
		if (kind === "create" && typeof (change as CreateFileOp).uri === "string") {
			lines.push(
				`Create ${relativeToCwd(uriToPath((change as CreateFileOp).uri), cwd)}`,
			);
		} else if (
			kind === "rename" &&
			typeof (change as RenameFileOp).oldUri === "string" &&
			typeof (change as RenameFileOp).newUri === "string"
		) {
			lines.push(
				`Rename ${relativeToCwd(uriToPath((change as RenameFileOp).oldUri), cwd)} → ${relativeToCwd(uriToPath((change as RenameFileOp).newUri), cwd)}`,
			);
		} else if (
			kind === "delete" &&
			typeof (change as DeleteFileOp).uri === "string"
		) {
			lines.push(
				`Delete ${relativeToCwd(uriToPath((change as DeleteFileOp).uri), cwd)}`,
			);
		}
	}
	return lines;
}

export async function applyWorkspaceEdit(
	edit: {
		changes?: Record<string, unknown[]>;
		documentChanges?: unknown[];
	},
	cwd: string,
	options: { mutationContext?: LspMutationContext; observe?: boolean } = {},
): Promise<AppliedWorkspaceEdit> {
	const descriptions: string[] = [];
	const touchedFiles = new Set<string>();
	const fileDetails: AppliedWorkspaceFileDetail[] = [];
	const appliedOperationIndexes: number[] = [];
	let appliedOperationTotal = 0;
	let operationIndex = 0;
	const operationCounts = { textEdits: 0, create: 0, rename: 0, delete: 0 };
	const textEditsByUri = flattenWorkspaceTextEdits(edit);
	for (const edits of Object.values(edit.changes ?? {})) {
		operationCounts.textEdits += edits.filter(isTextEdit).length;
	}
	for (const change of edit.documentChanges ?? []) {
		if (isTextDocumentEdit(change)) {
			operationCounts.textEdits += change.edits.filter(isTextEdit).length;
		} else if (typeof change === "object" && change !== null && "kind" in change) {
			const kind = (change as { kind?: unknown }).kind;
			if (kind === "create") operationCounts.create++;
			if (kind === "rename") operationCounts.rename++;
			if (kind === "delete") operationCounts.delete++;
		}
	}
	const operationTotal =
		operationCounts.textEdits +
		operationCounts.create +
		operationCounts.rename +
		operationCounts.delete;
	const markApplied = (count = 1): void => {
		for (let index = 0; index < count; index++) {
			if (appliedOperationIndexes.length < 100)
				appliedOperationIndexes.push(operationIndex + index);
		}
		appliedOperationTotal += count;
		operationIndex += count;
	};

	try {
		for (const [uri, edits] of textEditsByUri) {
			const filePath = uriToPath(uri);
			const content = await fs.readFile(filePath, "utf-8");
			const updated = applyTextEditsToString(content, edits);
			await fs.writeFile(filePath, updated, "utf-8");
			const start = Math.min(...edits.map((edit) => edit.range.start.line + 1));
			const end = Math.max(...edits.map((edit) => edit.range.end.line + 1));
			touchedFiles.add(filePath);
			fileDetails.push({
				filePath,
				range: { start, end },
				importsChanged: /^import\s/m.test(updated),
			});
			markApplied(edits.length);
			descriptions.push(
				`Applied ${edits.length} edit(s) to ${relativeToCwd(filePath, cwd)}`,
			);
		}

		for (const change of edit.documentChanges ?? []) {
			if (isTextDocumentEdit(change)) {
				// These edits were already applied through `changes`-style grouping
				// only when the URI was present there; documentChanges-only text edits
				// are applied here to preserve the existing path.
				const uri = change.textDocument.uri;
				if (textEditsByUri.has(uri)) continue;
				const edits = change.edits.filter(isTextEdit);
				if (edits.length === 0) continue;
				const filePath = uriToPath(uri);
				const content = await fs.readFile(filePath, "utf-8");
				const updated = applyTextEditsToString(content, edits);
				await fs.writeFile(filePath, updated, "utf-8");
				const start = Math.min(...edits.map((edit) => edit.range.start.line + 1));
				const end = Math.max(...edits.map((edit) => edit.range.end.line + 1));
				touchedFiles.add(filePath);
				fileDetails.push({ filePath, range: { start, end }, importsChanged: /^import\s/m.test(updated) });
				markApplied(edits.length);
				continue;
			}
			if (typeof change !== "object" || change === null || !("kind" in change))
				continue;
			const kind = (change as { kind?: unknown }).kind;
			if (
				kind === "create" &&
				typeof (change as CreateFileOp).uri === "string"
			) {
				const filePath = uriToPath((change as CreateFileOp).uri);
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				await fs
					.writeFile(filePath, "", { flag: "wx" })
					.catch(async (err: unknown) => {
						if ((err as { code?: string }).code !== "EEXIST") throw err;
					});
				touchedFiles.add(filePath);
				fileDetails.push({ filePath, range: { start: 1, end: 1 }, importsChanged: false });
				markApplied();
				descriptions.push(`Created ${relativeToCwd(filePath, cwd)}`);
			} else if (
				kind === "rename" &&
				typeof (change as RenameFileOp).oldUri === "string" &&
				typeof (change as RenameFileOp).newUri === "string"
			) {
				const oldPath = uriToPath((change as RenameFileOp).oldUri);
				const newPath = uriToPath((change as RenameFileOp).newUri);
				await fs.mkdir(path.dirname(newPath), { recursive: true });
				await fs.rename(oldPath, newPath);
				touchedFiles.add(oldPath);
				touchedFiles.add(newPath);
				fileDetails.push(
					{ filePath: oldPath, range: { start: 1, end: 1 }, importsChanged: true },
					{ filePath: newPath, range: { start: 1, end: 1 }, importsChanged: true },
				);
				markApplied();
				descriptions.push(
					`Renamed ${relativeToCwd(oldPath, cwd)} → ${relativeToCwd(newPath, cwd)}`,
				);
			} else if (
				kind === "delete" &&
				typeof (change as DeleteFileOp).uri === "string"
			) {
				const filePath = uriToPath((change as DeleteFileOp).uri);
				await fs.rm(filePath, { recursive: true, force: true });
				touchedFiles.add(filePath);
				fileDetails.push({ filePath, range: { start: 1, end: 1 }, importsChanged: true });
				markApplied();
				descriptions.push(`Deleted ${relativeToCwd(filePath, cwd)}`);
			}
		}
	} catch (err) {
		const partial: AppliedWorkspaceEdit = {
			descriptions,
			files: [...touchedFiles],
			operationTotal,
			appliedOperationTotal,
			appliedOperationIndexes,
			operationCounts,
			fileDetails,
		};
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

	const applied: AppliedWorkspaceEdit = {
		descriptions,
		files: [...touchedFiles],
		operationTotal,
		appliedOperationTotal,
		appliedOperationIndexes,
		operationCounts,
		fileDetails,
	};
	if (options.mutationContext && options.observe !== false) {
		recordLspMutation(options.mutationContext, {
			results: [applied],
			status: appliedOperationTotal > 0 ? "success" : "skipped",
		});
	}
	return applied;
}
