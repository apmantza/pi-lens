import * as nodeFs from "node:fs";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { logReadGuardEvent } from "./read-guard-logger.js";

export interface GuardLineResult {
	touchedLines: [number, number] | undefined;
	preflightError?: string;
}

export function countFileLines(filePath: string): number {
	try {
		const content = nodeFs.readFileSync(filePath, "utf-8");
		if (content.length === 0) return 1;
		return content.split(/\r?\n/).length;
	} catch {
		return 1;
	}
}

function normalizeContent(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

function lineNumberAt(content: string, index: number): number {
	return content.substring(0, index).split("\n").length;
}

function findOccurrenceLines(content: string, needle: string): number[] {
	const lines: number[] = [];
	let pos = 0;
	while (pos < content.length) {
		const idx = content.indexOf(needle, pos);
		if (idx === -1) break;
		lines.push(lineNumberAt(content, idx));
		pos = idx + needle.length;
	}
	return lines;
}

function resolveOldTextEdits(
	edits: Array<{ oldText?: string }>,
	filePath: string,
	sessionId: string | undefined,
): GuardLineResult {
	let rawContent: string;
	try {
		rawContent = nodeFs.readFileSync(filePath, "utf-8");
	} catch {
		logReadGuardEvent({
			event: "touched_lines_missing",
			sessionId,
			filePath,
			metadata: {
				tool: "edit",
				source: "edits_without_ranges",
				editCount: edits.length,
			},
		});
		return { touchedLines: undefined };
	}

	const content = normalizeContent(rawContent);
	const errors: string[] = [];
	const resolvedRanges: [number, number][] = [];

	for (let i = 0; i < edits.length; i++) {
		const oldText = edits[i].oldText;
		if (!oldText) continue;

		let needle = normalizeContent(oldText);
		let occurrenceLines = findOccurrenceLines(content, needle);

		if (occurrenceLines.length === 0) {
			const corrected = tryCorrectIndentationMismatch(oldText, filePath);
			if (corrected !== undefined) {
				needle = normalizeContent(corrected);
				occurrenceLines = findOccurrenceLines(content, needle);
				if (occurrenceLines.length > 0) {
					logReadGuardEvent({
						event: "oldtext_indent_corrected",
						sessionId,
						filePath,
						metadata: {
							tool: "edit",
							source: "edits_without_ranges",
							editIndex: i,
						},
					});
				}
			}
		}

		if (occurrenceLines.length === 0) {
			const preview = oldText.trimStart().substring(0, 60).replace(/\n/g, "↵");
			errors.push(
				`edits[${i}].oldText ("${preview}") was not found in the current file content. Re-read the file and refresh the edit target before retrying.`,
			);
			logReadGuardEvent({
				event: "oldtext_not_found",
				sessionId,
				filePath,
				metadata: {
					tool: "edit",
					source: "edits_without_ranges",
					editIndex: i,
				},
			});
		} else if (occurrenceLines.length === 1) {
			const startLine = occurrenceLines[0];
			const endLine = startLine + needle.split("\n").length - 1;
			resolvedRanges.push([startLine, endLine]);
			logReadGuardEvent({
				event: "oldtext_resolved",
				sessionId,
				filePath,
				metadata: {
					tool: "edit",
					source: "edits_without_ranges",
					editIndex: i,
					touchedLines: [startLine, endLine],
				},
			});
		} else {
			const preview = oldText.trimStart().substring(0, 60).replace(/\n/g, "↵");
			const lineList = occurrenceLines.map((l) => `  • Line ${l}`).join("\n");
			errors.push(
				`edits[${i}].oldText ("${preview}") appears ${occurrenceLines.length} times:\n${lineList}\nAdd more surrounding context to make it unique.`,
			);
			logReadGuardEvent({
				event: "oldtext_duplicate",
				sessionId,
				filePath,
				metadata: {
					tool: "edit",
					source: "edits_without_ranges",
					editIndex: i,
					occurrenceCount: occurrenceLines.length,
					occurrenceLines,
				},
			});
		}
	}

	const oldTextEditCount = edits.filter((edit) => !!edit.oldText).length;
	if (errors.length > 0 || resolvedRanges.length !== oldTextEditCount) {
		const failureDetails =
			errors.length > 0
				? errors
				: [
						"One or more edit targets could not be resolved to exact lines. Re-read the file and retry with more precise oldText context.",
					];
		return {
			touchedLines: undefined,
			preflightError: `🔴 BLOCKED — Ambiguous edit target\n\n${failureDetails.join("\n\n")}`,
		};
	}

	if (resolvedRanges.length === 0) {
		logReadGuardEvent({
			event: "touched_lines_missing",
			sessionId,
			filePath,
			metadata: {
				tool: "edit",
				source: "edits_without_ranges",
				editCount: edits.length,
			},
		});
		return { touchedLines: undefined };
	}

	const starts = resolvedRanges.map(([s]) => s);
	const ends = resolvedRanges.map(([, e]) => e);
	const touchedLines: [number, number] = [
		Math.min(...starts),
		Math.max(...ends),
	];
	logReadGuardEvent({
		event: "touched_lines_detected",
		sessionId,
		filePath,
		metadata: {
			tool: "edit",
			source: "oldtext_resolved",
			touchedLines,
			resolvedEditCount: resolvedRanges.length,
			totalEditCount: edits.length,
		},
	});
	return { touchedLines };
}

/**
 * Tries to fix a tab/space indentation mismatch between the model's oldText and the
 * actual file. Returns the corrected oldText if a matching variant is found, or
 * undefined if the text already matches or no indentation conversion fixes it.
 */
export function tryCorrectIndentationMismatch(
	oldText: string,
	filePath: string,
): string | undefined {
	let content: string;
	try {
		content = nodeFs.readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
	} catch {
		return undefined;
	}

	const normalized = oldText.replace(/\r\n/g, "\n");
	if (content.includes(normalized)) return undefined;

	const conversions = [
		// tabs → 2 spaces
		(s: string) =>
			s
				.split("\n")
				.map((l) => l.replace(/^\t+/, (m) => "  ".repeat(m.length)))
				.join("\n"),
		// tabs → 4 spaces
		(s: string) =>
			s
				.split("\n")
				.map((l) => l.replace(/^\t+/, (m) => "    ".repeat(m.length)))
				.join("\n"),
		// 2 spaces → tabs
		(s: string) =>
			s
				.split("\n")
				.map((l) => l.replace(/^( {2})+/, (m) => "\t".repeat(m.length / 2)))
				.join("\n"),
		// 4 spaces → tabs
		(s: string) =>
			s
				.split("\n")
				.map((l) => l.replace(/^( {4})+/, (m) => "\t".repeat(m.length / 4)))
				.join("\n"),
	];

	for (const convert of conversions) {
		const candidate = convert(normalized);
		if (candidate !== normalized && content.includes(candidate))
			return candidate;
	}

	return undefined;
}

export function getTouchedLinesForGuard(
	event: unknown,
	filePath?: string,
	sessionId?: string,
): GuardLineResult {
	if (isToolCallEventType("edit", event as any)) {
		const editInput = (event as { input?: unknown }).input as {
			oldRange?: { start: { line: number }; end: { line: number } };
			edits?: Array<{
				range?: { start?: { line: number }; end?: { line: number } };
				oldText?: string;
				newText?: string;
			}>;
		};
		if (editInput.oldRange) {
			const touchedLines: [number, number] = [
				editInput.oldRange.start.line,
				editInput.oldRange.end.line,
			];
			if (filePath) {
				logReadGuardEvent({
					event: "touched_lines_detected",
					sessionId,
					filePath,
					metadata: {
						tool: "edit",
						source: "oldRange",
						touchedLines,
					},
				});
			}
			return { touchedLines };
		}
		if (editInput.edits?.length) {
			const rangedEdits = editInput.edits
				.map((edit) => {
					const start = edit.range?.start?.line;
					const end = edit.range?.end?.line ?? start;
					if (typeof start !== "number" || typeof end !== "number") {
						return null;
					}
					return [start, end] as [number, number];
				})
				.filter((range): range is [number, number] => range !== null);
			if (rangedEdits.length === 0) {
				if (filePath) {
					return resolveOldTextEdits(editInput.edits, filePath, sessionId);
				}
				return { touchedLines: undefined };
			}
			const starts = rangedEdits.map(([start]) => start);
			const ends = rangedEdits.map(([, end]) => end);
			const touchedLines: [number, number] = [
				Math.min(...starts),
				Math.max(...ends),
			];
			if (filePath) {
				logReadGuardEvent({
					event: "touched_lines_detected",
					sessionId,
					filePath,
					metadata: {
						tool: "edit",
						source: "edits_ranges",
						touchedLines,
						rangedEditCount: rangedEdits.length,
						totalEditCount: editInput.edits.length,
					},
				});
			}
			return { touchedLines };
		}
		if (filePath) {
			logReadGuardEvent({
				event: "touched_lines_missing",
				sessionId,
				filePath,
				metadata: {
					tool: "edit",
					source: "no_oldRange_or_edits",
				},
			});
		}
		return { touchedLines: undefined };
	}

	if (isToolCallEventType("write", event as any)) {
		const lineCount = filePath ? countFileLines(filePath) : 1;
		const touchedLines: [number, number] = [1, lineCount];
		if (filePath) {
			logReadGuardEvent({
				event: "touched_lines_detected",
				sessionId,
				filePath,
				metadata: {
					tool: "write",
					source: "full_file_write",
					touchedLines,
					lineCount,
				},
			});
		}
		return { touchedLines };
	}

	return { touchedLines: undefined };
}
