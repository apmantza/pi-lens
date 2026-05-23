import fs from "node:fs/promises";
import path from "node:path";
import { uriToPath } from "./path-utils.js";

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

export interface AppliedWorkspaceEdit {
	descriptions: string[];
	files: string[];
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
): Promise<AppliedWorkspaceEdit> {
	const descriptions: string[] = [];
	const touchedFiles = new Set<string>();
	const textEditsByUri = flattenWorkspaceTextEdits(edit);

	try {
		for (const [uri, edits] of textEditsByUri) {
			const filePath = uriToPath(uri);
			const content = await fs.readFile(filePath, "utf-8");
			const updated = applyTextEditsToString(content, edits);
			await fs.writeFile(filePath, updated, "utf-8");
			touchedFiles.add(filePath);
			descriptions.push(
				`Applied ${edits.length} edit(s) to ${relativeToCwd(filePath, cwd)}`,
			);
		}

		for (const change of edit.documentChanges ?? []) {
			if (typeof change !== "object" || change === null || !("kind" in change))
				continue;
			const kind = (change as { kind?: unknown }).kind;
			if (kind === "create" && typeof (change as CreateFileOp).uri === "string") {
				const filePath = uriToPath((change as CreateFileOp).uri);
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				await fs
					.writeFile(filePath, "", { flag: "wx" })
					.catch(async (err: unknown) => {
						if ((err as { code?: string }).code !== "EEXIST") throw err;
					});
				touchedFiles.add(filePath);
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
				descriptions.push(`Deleted ${relativeToCwd(filePath, cwd)}`);
			}
		}
	} catch (err) {
		const already = [...touchedFiles];
		if (already.length > 0) {
			const alreadyList = already
				.map((f) => `  • ${relativeToCwd(f, cwd)}`)
				.join("\n");
			throw new Error(
				`Workspace edit failed mid-application — ${already.length} file(s) already written, no rollback performed:\n${alreadyList}\nCause: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		throw err;
	}

	return { descriptions, files: [...touchedFiles] };
}
