import * as nodeFs from "node:fs";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { logReadGuardEvent } from "./read-guard-logger.js";

export interface GuardLineResult {
	touchedLines: [number, number] | undefined;
	// Individual ranges for multi-edit calls (e.g. rename at 4 scattered spots).
	// When set, read-guard checks each range independently instead of the bounding box.
	editRanges?: [number, number][];
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

function parseHashlineAnchor(anchor: unknown): number | undefined {
	if (typeof anchor !== "string") return undefined;
	const trimmed = anchor.trim();
	const separator = trimmed.indexOf(":");
	const lineText = separator === -1 ? trimmed : trimmed.slice(0, separator);
	if (!/^\d+$/.test(lineText)) return undefined;
	const line = Number(lineText);
	return Number.isInteger(line) && line > 0 ? line : undefined;
}

function combineRanges(ranges: [number, number][]): GuardLineResult {
	const starts = ranges.map(([start]) => start);
	const ends = ranges.map(([, end]) => end);
	return {
		touchedLines: [Math.min(...starts), Math.max(...ends)],
		editRanges: ranges.length > 1 ? ranges : undefined,
	};
}

function getHashlineOperations(input: Record<string, unknown>): unknown[] {
	if (Array.isArray(input.operations)) return input.operations;
	if (Array.isArray(input.ops)) return input.ops;
	if (input.set_line || input.replace_lines || input.replace_symbol)
		return [input];
	return [];
}

function resolveHashlineEditInput(
	input: Record<string, unknown>,
	filePath: string | undefined,
	sessionId: string | undefined,
): GuardLineResult | undefined {
	const operations = getHashlineOperations(input);
	if (operations.length === 0) return undefined;
	const ranges: [number, number][] = [];
	const errors: string[] = [];

	for (let index = 0; index < operations.length; index += 1) {
		const op = operations[index] as Record<string, unknown>;
		if (op.set_line) {
			const payload = op.set_line as Record<string, unknown>;
			const line = parseHashlineAnchor(payload.anchor);
			if (!line) {
				errors.push(`operation[${index}].set_line.anchor is malformed`);
				continue;
			}
			ranges.push([line, line]);
			continue;
		}
		if (op.replace_lines) {
			const payload = op.replace_lines as Record<string, unknown>;
			const start = parseHashlineAnchor(payload.start_anchor);
			const end = parseHashlineAnchor(payload.end_anchor);
			if (!start || !end) {
				errors.push(`operation[${index}].replace_lines anchors are malformed`);
				continue;
			}
			if (start > end) {
				errors.push(`operation[${index}].replace_lines range is inverted`);
				continue;
			}
			ranges.push([start, end]);
			continue;
		}
		if (op.replace_symbol) {
			errors.push(
				`operation[${index}].replace_symbol cannot be resolved safely yet; use line anchors or a native ranged edit`,
			);
			continue;
		}
		errors.push(`operation[${index}] is not a recognized hashline edit`);
	}

	if (errors.length > 0) {
		if (filePath) {
			logReadGuardEvent({
				event: "edit_preflight_blocked",
				sessionId,
				filePath,
				metadata: {
					tool: "edit",
					source: "hashline_edit",
					reasonKind: "unsupported_hashline_edit_target",
					operationCount: operations.length,
					errorCount: errors.length,
					errors: errors.slice(0, 10),
				},
			});
		}
		return {
			touchedLines: undefined,
			preflightError: `🔴 BLOCKED — Unsupported hashline edit target\n\n${errors.join("\n")}`,
		};
	}
	if (ranges.length === 0) return undefined;
	const result = combineRanges(ranges);
	if (filePath) {
		logReadGuardEvent({
			event: "touched_lines_detected",
			sessionId,
			filePath,
			metadata: {
				tool: "edit",
				source:
					ranges.length === 1 && ranges[0][0] === ranges[0][1]
						? "hashline_set_line"
						: "hashline_replace_lines",
				touchedLines: result.touchedLines,
				editRanges: result.editRanges,
				operationCount: operations.length,
			},
		});
	}
	return result;
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
	edits: Array<{ oldText?: string; originalIndex?: number }>,
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
	const failureKinds: string[] = [];
	const failedEditIndexes: number[] = [];
	const failedOldTextPreviews: string[] = [];
	const resolvedRanges: [number, number][] = [];

	for (let i = 0; i < edits.length; i++) {
		const oldText = edits[i].oldText;
		const editIndex = edits[i].originalIndex ?? i;
		if (!oldText) continue;

		let needle = normalizeContent(oldText);
		let occurrenceLines = findOccurrenceLines(content, needle);

		if (occurrenceLines.length === 0) {
			const corrected = tryCorrectIndentationMismatchFromContent(
				oldText,
				rawContent.replace(/\r\n/g, "\n"),
			);
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
							editIndex,
						},
					});
				}
			}
		}

		if (occurrenceLines.length === 0) {
			const preview = oldText.trimStart().substring(0, 60).replace(/\n/g, "↵");
			failureKinds.push("oldtext_not_found");
			failedEditIndexes.push(editIndex);
			failedOldTextPreviews.push(preview);
			errors.push(
				`edits[${editIndex}].oldText ("${preview}") was not found in the current file content. Re-read the relevant section of the file to confirm the exact text, then retry with the verbatim content.`,
			);
			logReadGuardEvent({
				event: "oldtext_not_found",
				sessionId,
				filePath,
				metadata: {
					tool: "edit",
					source: "edits_without_ranges",
					editIndex,
					oldTextPreview: preview,
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
					editIndex,
					touchedLines: [startLine, endLine],
				},
			});
		} else {
			const preview = oldText.trimStart().substring(0, 60).replace(/\n/g, "↵");
			failureKinds.push("oldtext_duplicate");
			failedEditIndexes.push(editIndex);
			failedOldTextPreviews.push(preview);
			const lineList = occurrenceLines.map((l) => `  • Line ${l}`).join("\n");
			errors.push(
				`edits[${editIndex}].oldText ("${preview}") appears ${occurrenceLines.length} times:\n${lineList}\nAdd more surrounding context to make it unique.`,
			);
			logReadGuardEvent({
				event: "oldtext_duplicate",
				sessionId,
				filePath,
				metadata: {
					tool: "edit",
					source: "edits_without_ranges",
					editIndex,
					occurrenceCount: occurrenceLines.length,
					occurrenceLines,
					oldTextPreview: preview,
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
						"One or more edit targets could not be resolved to exact lines. Re-read the relevant section and retry with the exact content as it appears in the file.",
					];
		const uniqueFailureKinds = [...new Set(failureKinds)];
		logReadGuardEvent({
			event: "edit_preflight_blocked",
			sessionId,
			filePath,
			metadata: {
				tool: "edit",
				source: "edits_without_ranges",
				reasonKind:
					uniqueFailureKinds.length === 1
						? uniqueFailureKinds[0]
						: "oldtext_resolution_failed",
				failureKinds: uniqueFailureKinds,
				editCount: edits.length,
				oldTextEditCount,
				resolvedOldTextEditCount: resolvedRanges.length,
				unresolvedOldTextEditCount: oldTextEditCount - resolvedRanges.length,
				failedEditIndexes,
				oldTextPreviews: failedOldTextPreviews.slice(0, 5),
				errorCount: errors.length,
			},
		});
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
	const editRanges = resolvedRanges.length > 1 ? resolvedRanges : undefined;
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
	return { touchedLines, editRanges };
}

/**
 * Tries to fix a tab/space indentation mismatch between the model's oldText and the
 * actual file. Returns the corrected oldText if a matching variant is found, or
 * undefined if the text already matches or no indentation conversion fixes it.
 */
export function tryCorrectIndentationMismatchFromContent(
	oldText: string,
	content: string,
): string | undefined {
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

	const indentationInsensitiveCandidate = findIndentationInsensitiveCandidate(
		content,
		normalized,
	);
	if (indentationInsensitiveCandidate !== undefined) {
		return indentationInsensitiveCandidate;
	}

	return undefined;
}

export function tryCorrectIndentationMismatch(
	oldText: string,
	filePath: string,
): string | undefined {
	try {
		return tryCorrectIndentationMismatchFromContent(
			oldText,
			nodeFs.readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n"),
		);
	} catch {
		return undefined;
	}
}

function findIndentationInsensitiveCandidate(
	content: string,
	oldText: string,
): string | undefined {
	const contentLines = content.split("\n");
	const oldLines = oldText.split("\n");
	const stripIndent = (line: string) => line.replace(/^[\t ]+/, "").trimEnd();
	const expected = oldLines.map(stripIndent);

	for (
		let start = 0;
		start <= contentLines.length - oldLines.length;
		start += 1
	) {
		let matches = true;
		for (let offset = 0; offset < oldLines.length; offset += 1) {
			if (
				stripIndent(contentLines[start + offset] ?? "") !== expected[offset]
			) {
				matches = false;
				break;
			}
		}
		if (matches) {
			const candidate = contentLines
				.slice(start, start + oldLines.length)
				.join("\n");
			if (candidate !== oldText) return candidate;
		}
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
			operations?: unknown[];
			ops?: unknown[];
			set_line?: unknown;
			replace_lines?: unknown;
			replace_symbol?: unknown;
		};
		const hashlineResult = resolveHashlineEditInput(
			editInput as Record<string, unknown>,
			filePath,
			sessionId,
		);
		if (hashlineResult) return hashlineResult;
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
			const unresolvedOldTextEdits = editInput.edits
				.map((edit, index) => ({ ...edit, originalIndex: index }))
				.filter(
					(edit) =>
						typeof edit.range?.start?.line !== "number" && !!edit.oldText,
				);
			if (rangedEdits.length === 0) {
				if (filePath) {
					return resolveOldTextEdits(editInput.edits, filePath, sessionId);
				}
				return { touchedLines: undefined };
			}
			let oldTextTouchedLines: [number, number] | undefined;
			let oldTextEditRanges: [number, number][] | undefined;
			if (unresolvedOldTextEdits.length > 0 && filePath) {
				const resolved = resolveOldTextEdits(
					unresolvedOldTextEdits,
					filePath,
					sessionId,
				);
				if (resolved.preflightError) {
					return resolved;
				}
				oldTextTouchedLines = resolved.touchedLines;
				oldTextEditRanges = resolved.editRanges;
			}
			const starts = rangedEdits.map(([start]) => start);
			const ends = rangedEdits.map(([, end]) => end);
			if (oldTextTouchedLines) {
				starts.push(oldTextTouchedLines[0]);
				ends.push(oldTextTouchedLines[1]);
			}
			const touchedLines: [number, number] = [
				Math.min(...starts),
				Math.max(...ends),
			];
			const allEditRanges = [...rangedEdits];
			if (oldTextEditRanges?.length) {
				allEditRanges.push(...oldTextEditRanges);
			} else if (oldTextTouchedLines) {
				allEditRanges.push(oldTextTouchedLines);
			}
			const editRanges = allEditRanges.length > 1 ? allEditRanges : undefined;
			if (filePath) {
				logReadGuardEvent({
					event: "touched_lines_detected",
					sessionId,
					filePath,
					metadata: {
						tool: "edit",
						source:
							unresolvedOldTextEdits.length > 0
								? "edits_mixed"
								: "edits_ranges",
						touchedLines,
						rangedEditCount: rangedEdits.length,
						resolvedOldTextEditCount: unresolvedOldTextEdits.length,
						totalEditCount: editInput.edits.length,
					},
				});
			}
			return { touchedLines, editRanges };
		}
		if (filePath) {
			const topLevelKeys = Object.keys(editInput as Record<string, unknown>);
			logReadGuardEvent({
				event: "touched_lines_missing",
				sessionId,
				filePath,
				metadata: {
					tool: "edit",
					source: "unknown_edit_schema",
					topLevelKeys,
					hasNativeOldRange: !!editInput.oldRange,
					hasNativeEdits: Array.isArray(editInput.edits),
					hasHashlineSetLine: !!editInput.set_line,
					hasHashlineReplaceLines: !!editInput.replace_lines,
					hasHashlineReplaceSymbol: !!editInput.replace_symbol,
					hasHashlineBatch:
						Array.isArray(editInput.operations) || Array.isArray(editInput.ops),
					strictModeWouldBlock: true,
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
