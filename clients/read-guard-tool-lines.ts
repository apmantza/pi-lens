import type { EditToolInput } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { BoundedFifoMap } from "./bounded-cache.js";
import {
	hostWouldApplyOldText,
	normalizeForGuardMatch,
	normalizeToLF,
	stripBom,
} from "./host-edit-normalize.js";
import { classifyMutatingTool } from "./mutating-tool.js";
import {
	isExactAppliedRetry,
	type EditSnapshotIdentity,
	type PartialApplyRecordStore,
	type PartiallyApplicableEdit,
} from "./partial-edit-apply.js";
import {
	boundedEditIndexes,
	createReadGuardEditBatchSummary,
	logReadGuardEvent,
	type EditBatchRejection,
	type ReadGuardEditBatchSummary,
} from "./read-guard-logger.js";

export interface GuardLineResult {
	touchedLines: [number, number] | undefined;
	// Individual ranges for multi-edit calls (e.g. rename at 4 scattered spots).
	// When set, read-guard checks each range independently instead of the bounding box.
	editRanges?: [number, number][];
	preflightError?: string;
	/** Composed header line of the blocking message (🔄/🛑/✅). */
	preflightHeader?: string;
	/**
	 * Per-edit failure bodies. Callers recompose them around a commit-status
	 * header, so committed bytes are never re-labelled by the preflight header
	 * (#2402).
	 */
	preflightDetails?: string[];
	// Edits that resolved successfully when only a subset failed preflight.
	// Caller can apply these directly and return a ⚠️ PARTIAL APPLY message.
	// Shares the host-pinned edit shape with applyPartiallyApplicableEdits.
	partiallyApplicable?: PartiallyApplicableEdit[];
	/** Edits recognized as exact retries of already-applied pairs (#2402). */
	alreadyAppliedEdits?: number[];
	/** Canonical bounded edit-batch telemetry, also reused by partial apply. */
	editBatchSummary?: ReadGuardEditBatchSummary;
	// All edits were resolved by exact content match — range snapshot staleness
	// is irrelevant since the content IS the edit target.
	contentMatchValidated?: boolean;
}

// Track repeated oldtext_not_found failures per (filePath, preview) to escalate messages.
export const MAX_FAILURE_TRACKER_SIZE = 200;
const recentOldTextFailures = new BoundedFifoMap<
	string,
	{ count: number; lastTs: number }
>(MAX_FAILURE_TRACKER_SIZE);
const REPEAT_FAILURE_TTL_MS = 300_000;

function trackOldTextFailure(filePath: string, preview: string): number {
	const key = `${filePath}::${preview}`;
	const now = Date.now();
	const prev = recentOldTextFailures.get(key);
	const count =
		prev && now - prev.lastTs < REPEAT_FAILURE_TTL_MS ? prev.count + 1 : 1;
	recentOldTextFailures.set(key, { count, lastTs: now });
	return count;
}

/** #2442 test-only: exercise the bounded failure tracker's capacity
 *  eviction directly, without a full read-guard preflight call. */
export function _trackOldTextFailureForTests(
	filePath: string,
	preview: string,
): number {
	return trackOldTextFailure(filePath, preview);
}
/** #2442 test-only: was this (filePath, preview) pair's escalation count
 *  reset by capacity eviction? (A fresh `_trackOldTextFailureForTests` call
 *  answering 1 again, after previously answering >1, means yes — but this
 *  reads the tracker's residency directly instead.) */
export function _hasOldTextFailureForTests(
	filePath: string,
	preview: string,
): boolean {
	return recentOldTextFailures.has(`${filePath}::${preview}`);
}

function findFirstLineOfOldText(
	content: string,
	oldText: string,
): number | undefined {
	const firstLine = oldText.replace(/\r\n/g, "\n").split("\n")[0].trim();
	if (firstLine.length < 5) return undefined;
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === firstLine) return i + 1;
	}
	return undefined;
}

function tokenizeForSimilarity(text: string): string[] {
	return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

/** Jaccard similarity over identifier/number tokens (whitespace + punctuation insensitive). */
function tokenSimilarity(a: string, b: string): number {
	const ta = new Set(tokenizeForSimilarity(a));
	const tb = new Set(tokenizeForSimilarity(b));
	if (ta.size === 0 || tb.size === 0) return 0;
	let intersection = 0;
	for (const token of ta) if (tb.has(token)) intersection += 1;
	return intersection / (ta.size + tb.size - intersection);
}

/**
 * "Did you mean?" recovery: when an oldText line can't be found, surface the
 * closest *current* file lines (by token similarity) so the model can rebuild
 * its edit from verbatim text in one turn instead of re-reading blind. Scans a
 * ±window around `nearLine` when known (the first-line locator), else the whole
 * file. Returns the top matches above `minScore`, with their real line numbers.
 *
 * Scores in normalized space but returns only `{ line, score }` — the caller
 * renders the text from a structurally-aligned RAW view so a suggestion can
 * never quote the normalized projection (#1050). NFKC folds CJK full-width
 * punctuation (`：`→`:`, `，`→`,`, `；`→`;`) and HOST_UNICODE_DASHES folds
 * `—`→`-`, so a suggestion rendered from normalized content told the agent to
 * copy bytes the file does not contain; the host's edit tool then fuzzy-matched
 * it and wrote the folded form onto the touched line. Normalization here is
 * comparison-only, exactly as everywhere else in this file.
 */
function findSimilarLines(
	content: string,
	target: string,
	options: {
		nearLine?: number;
		window?: number;
		max?: number;
		minScore?: number;
	} = {},
): Array<{ line: number; score: number }> {
	const { nearLine, window = 60, max = 3, minScore = 0.5 } = options;
	const needle = target.trim();
	if (needle.length < 4) return [];
	const lines = content.split("\n");
	const start = nearLine ? Math.max(0, nearLine - 1 - window) : 0;
	const end = nearLine
		? Math.min(lines.length, nearLine - 1 + window)
		: lines.length;
	const scored: Array<{ line: number; score: number }> = [];
	for (let i = start; i < end; i += 1) {
		const text = lines[i];
		if (text.trim() === "") continue;
		const score = tokenSimilarity(needle, text);
		if (score >= minScore) scored.push({ line: i + 1, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, max);
}

/**
 * Render did-you-mean rows from the file's real characters rather than the
 * normalized match space the line numbers were scored in. Taking only
 * `{ line }` from the scan makes quoting normalized text structurally
 * impossible (#1050).
 *
 * `rawLineAligned` must be `normalizeToLF(stripBom(raw).text)`: the same
 * STRUCTURAL normalization `normalizeForGuardMatch` applies (so line indices
 * cross-index 1:1 even for lone-CR or BOM files) but none of its CHARACTER
 * folding, so full-width punctuation, smart quotes, and NBSP survive.
 */
function formatSimilarLines(
	suggestions: Array<{ line: number }>,
	rawLineAligned: string,
): string {
	const rawLines = rawLineAligned.split("\n");
	const pad = (n: number) => String(n).padStart(4, " ");
	const rows = suggestions.map(
		({ line }) =>
			`      ${pad(line)} │ ${(rawLines[line - 1] ?? "").trimEnd()}`,
	);
	return `\n\nDid you mean one of these current lines?\n${rows.join("\n")}`;
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

// Match the host edit tool's fuzzy-match space (NFKC + smart quotes/dashes/
// spaces + BOM + lone-CR), so the guard resolves oldText -> range exactly where
// the host would apply it instead of false-blocking valid edits (#257).
//
// This is also where #505's "confusable-hyphen normalization" bundled item
// lives: normalizeForGuardMatch folds HOST_UNICODE_DASHES (U+2010, U+2011,
// U+2012, U+2013, U+2014, U+2015, U+2212 -> ASCII '-') before either side of
// the comparison below, so it runs on the PRIMARY match here, before any of
// the Tier A/B/C fallbacks in tryCorrectIndentationMismatchFromContent are
// even reached. Comparison-only, same as every tier below it — the bytes
// actually written on a successful edit are always the caller's original
// oldText/newText (see resolveOldTextEdits / applyPartiallyApplicableEdits),
// never this normalized form.
function normalizeContent(text: string): string {
	return normalizeForGuardMatch(text);
}

function lineNumberAt(content: string, index: number): number {
	return content.substring(0, index).split("\n").length;
}

/**
 * Deduplicated overlapping pairs, in candidate order, for the overlap error
 * message. Each overlapping edit appears in exactly one pair where possible;
 * a chain (A-B-C all overlapping) reports A-B and A-C.
 */
function overlapPairs(
	candidates: PartiallyApplicableEdit[],
): Array<[PartiallyApplicableEdit, PartiallyApplicableEdit]> {
	const pairs: Array<[PartiallyApplicableEdit, PartiallyApplicableEdit]> = [];
	const reported = new Set<PartiallyApplicableEdit>();
	for (let i = 0; i < candidates.length; i += 1) {
		const a = candidates[i];
		if (reported.has(a)) continue;
		for (let j = i + 1; j < candidates.length; j += 1) {
			const b = candidates[j];
			if (reported.has(b)) continue;
			if (b.spanStart < a.spanEnd && a.spanStart < b.spanEnd) {
				pairs.push([a, b]);
				reported.add(a);
				reported.add(b);
				break;
			}
		}
	}
	return pairs;
}

/** ✅ note appended to preflight/composed messages for recognized retries. */
export function formatAlreadyAppliedNotes(
	editIndexes: number[] | undefined,
): string {
	if (!editIndexes || editIndexes.length === 0) return "";
	const list = boundedEditIndexes(editIndexes)
		.map((index) => `edits[${index}]`)
		.join(", ");
	const suffix = editIndexes.length === 1 ? "was" : "were";
	const pronoun = editIndexes.length === 1 ? "it" : "them";
	return `\n\n✅ ${list} ${suffix} already applied by an identical earlier edit — the file already contains the result. Do NOT resubmit ${pronoun}.`;
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

function formatOccurrenceContext(
	content: string,
	occurrenceLines: number[],
	matchSpanLines: number,
	maxOccurrences = 5,
): string {
	const fileLines = content.split("\n");
	const shown = occurrenceLines.slice(0, maxOccurrences);
	const extra = occurrenceLines.length - shown.length;
	const pad = (n: number) => String(n).padStart(4, " ");
	const blocks = shown.map((startLine) => {
		const endLine = startLine + matchSpanLines - 1;
		const before = startLine > 1 ? fileLines[startLine - 2] : undefined;
		const after = endLine < fileLines.length ? fileLines[endLine] : undefined;
		const lines: string[] = [`  • Line ${startLine}:`];
		if (before !== undefined)
			lines.push(`      ${pad(startLine - 1)} │ ${before}`);
		if (matchSpanLines === 1) {
			lines.push(
				`      ${pad(startLine)} │ ${fileLines[startLine - 1] ?? ""}  ← match`,
			);
		} else {
			lines.push(
				`      ${pad(startLine)} │ ${fileLines[startLine - 1] ?? ""}  ← match start`,
			);
			if (matchSpanLines > 2) {
				lines.push(
					`      ${pad(0)} │ … (${matchSpanLines - 2} more line${matchSpanLines - 2 === 1 ? "" : "s"})`,
				);
			}
			lines.push(
				`      ${pad(endLine)} │ ${fileLines[endLine - 1] ?? ""}  ← match end`,
			);
		}
		if (after !== undefined) lines.push(`      ${pad(endLine + 1)} │ ${after}`);
		return lines.join("\n");
	});
	const tail =
		extra > 0
			? `\n  • … and ${extra} more occurrence${extra === 1 ? "" : "s"}`
			: "";
	return blocks.join("\n") + tail;
}

function countRawOccurrences(content: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let pos = 0;
	while (pos < content.length) {
		const idx = content.indexOf(needle, pos);
		if (idx === -1) break;
		count += 1;
		pos = idx + needle.length;
	}
	return count;
}

function exactOldTextForApply(
	rawContentLf: string,
	normalizedContent: string,
	oldText: string,
	candidate: string,
): { text: string; start: number; end: number } | undefined {
	const oldTextLf = oldText.replace(/\r\n/g, "\n");
	if (countRawOccurrences(rawContentLf, oldTextLf) === 1) {
		const start = rawContentLf.indexOf(oldTextLf);
		return { text: oldTextLf, start, end: start + oldTextLf.length };
	}
	if (
		candidate !== oldTextLf &&
		countRawOccurrences(rawContentLf, candidate) === 1
	) {
		const start = rawContentLf.indexOf(candidate);
		return { text: candidate, start, end: start + candidate.length };
	}
	const matchStart = normalizedContent.indexOf(candidate);
	if (matchStart < 0) return undefined;
	const rawLines = rawContentLf.split("\n");
	const normalizedLines = normalizedContent.split("\n");
	const rawLineStarts: number[] = [];
	let rawOffset = 0;
	for (const line of rawLines) {
		rawLineStarts.push(rawOffset);
		rawOffset += line.length + 1;
	}
	const normalizedLineStarts: number[] = [];
	let normalizedOffset = 0;
	for (const line of normalizedLines) {
		normalizedLineStarts.push(normalizedOffset);
		normalizedOffset += line.length + 1;
	}
	const mapOffset = (offset: number, preferEnd: boolean): number => {
		const line = Math.min(
			normalizedLines.length - 1,
			normalizedContent.slice(0, offset).split("\n").length - 1,
		);
		const rawLine = rawLines[line] ?? "";
		const bomOffset = line === 0 && rawLine.startsWith("\uFEFF") ? 1 : 0;
		const rawMatchLine = rawLine.slice(bomOffset);
		const target = offset - normalizedLineStarts[line];
		const normalizedLine = normalizedLines[line] ?? "";
		if (target >= normalizedLine.length) {
			if (preferEnd) return rawLineStarts[line] + rawLine.length;
			return rawLineStarts[line] + bomOffset + rawMatchLine.length;
		}
		let lower = 0;
		let upper = rawMatchLine.length;
		for (let boundary = 0; boundary <= rawMatchLine.length; boundary += 1) {
			const length = normalizeContent(rawMatchLine.slice(0, boundary)).length;
			if (length === target) return rawLineStarts[line] + bomOffset + boundary;
			if (length < target) lower = boundary;
			else if (upper === rawMatchLine.length) upper = boundary;
		}
		return rawLineStarts[line] + bomOffset + (preferEnd ? upper : lower);
	};
	const start = mapOffset(matchStart, false);
	const end = mapOffset(matchStart + candidate.length, true);
	const text = rawContentLf.slice(start, end);
	const rawMatchWithoutTrailingWhitespace = text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
	return normalizeContent(text) === candidate &&
		normalizeContent(text).length === rawMatchWithoutTrailingWhitespace.length
		? { text, start, end }
		: undefined;
}

function resolveOldTextEdits(
	edits: Array<{ oldText?: string; newText?: string; originalIndex?: number }>,
	filePath: string,
	sessionId: string | undefined,
	correlationId?: string,
	partialApplyRecords?: PartialApplyRecordStore,
	contentUnchangedSinceRead?: boolean,
): GuardLineResult {
	const startedAt = Date.now();
	const requestedIndexes: number[] = [];
	const logBatchEvent = (
		entry: Parameters<typeof logReadGuardEvent>[0],
	): void => logReadGuardEvent({ ...entry, correlationId });
	let rawBytes: Buffer;
	try {
		rawBytes = nodeFs.readFileSync(filePath);
	} catch {
		const editBatchSummary = createReadGuardEditBatchSummary({
			requestedIndexes: edits.map((edit, index) => edit.originalIndex ?? index),
			rejectedReasons: edits.map((edit, index) => ({
				index: edit.originalIndex ?? index,
				code: "preflight_blocked" as const,
			})),
		});
		logBatchEvent({
			event: "touched_lines_missing",
			sessionId,
			filePath,
			metadata: {
				tool: "edit",
				source: "edits_without_ranges",
				editCount: edits.length,
			},
		});
		logBatchEvent({
			event: "edit_batch_summary",
			filePath,
			metadata: { tool: "edit", editBatchSummary },
		});
		return { touchedLines: undefined, editBatchSummary };
	}
	const rawContent = rawBytes.toString("utf8");

	const rawContentLf = normalizeToLF(rawContent);
	const content = normalizeContent(rawContent);
	// #1053: the identity the spans below are resolved against. The apply step
	// re-reads the file and rejects the whole batch when this no longer holds,
	// so spans are never re-interpreted against changed bytes. The hash covers
	// byte identity; spans carry their own bounds checks.
	const snapshot: EditSnapshotIdentity = {
		hash: createHash("sha256").update(rawBytes).digest("hex"),
	};
	const errors: string[] = [];
	const failureKinds: string[] = [];
	const failedEditIndexes: number[] = [];
	const failedOldTextPreviews: string[] = [];
	const rejectedReasons: EditBatchRejection[] = [];
	const resolvedIndexes: number[] = [];
	const resolvedRanges: [number, number][] = [];
	const candidateEdits: PartiallyApplicableEdit[] = [];
	const passedEdits: PartiallyApplicableEdit[] = [];
	let overlapRejectedCount = 0;
	const alreadyAppliedEdits: number[] = [];
	let maxFailCount = 0;

	for (let i = 0; i < edits.length; i++) {
		const oldText = edits[i].oldText;
		const editIndex = edits[i].originalIndex ?? i;
		if (requestedIndexes.length < 100) requestedIndexes.push(editIndex);
		if (!oldText) continue;

		// Exact-retry recognition (#2402): an identical (oldText, newText) pair
		// this session already applied is recognized from the applied record and
		// confirmed by content evidence — never resolved again, never re-applied,
		// never counted as a failure. This is deliberately NOT a global
		// newText-present heuristic: the record only exists for pairs this
		// process actually committed.
		if (partialApplyRecords) {
			const record = partialApplyRecords.find(
				filePath,
				oldText,
				edits[i].newText,
			);
			if (
				record &&
				isExactAppliedRetry({
					contentLf: rawContentLf,
					oldKey: normalizeContent(oldText),
					newKey: normalizeContent(edits[i].newText ?? ""),
					contentHash: snapshot.hash,
					expectedContentHash: record.contentHash,
					expectedAfterWriteHash: record.afterWriteContentHash,
				})
			) {
				if (alreadyAppliedEdits.length < 100)
					alreadyAppliedEdits.push(editIndex);
				logBatchEvent({
					event: "edit_already_applied_retry",
					sessionId,
					filePath,
					metadata: {
						tool: "edit",
						source: "edits_without_ranges",
						editIndex,
					},
				});
				continue;
			}
		}

		let needle = normalizeContent(oldText);
		let occurrenceLines = findOccurrenceLines(content, needle);

		if (occurrenceLines.length === 0) {
			const corrected = tryCorrectIndentationMismatchFromContent(
				oldText,
				rawContentLf,
			);
			if (corrected !== undefined) {
				needle = normalizeContent(corrected);
				occurrenceLines = findOccurrenceLines(content, needle);
				if (occurrenceLines.length > 0) {
					logBatchEvent({
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
			if (failedEditIndexes.length < 100) {
				failedEditIndexes.push(editIndex);
				failedOldTextPreviews.push(preview);
			}
			if (rejectedReasons.length < 100) {
				rejectedReasons.push({ index: editIndex, code: "oldtext_not_found" });
			}
			const failCount = trackOldTextFailure(filePath, preview);
			if (failCount > maxFailCount) maxFailCount = failCount;
			let errorMsg = `edits[${editIndex}].oldText ("${preview}") was not found in the current file content.`;
			// Quote-style hint: if swapping " ↔ ' gives exactly one match, tell the agent why it failed.
			const quoteSwapCandidates: string[] = [];
			if (needle.includes('"'))
				quoteSwapCandidates.push(needle.replace(/"/g, "'"));
			if (needle.includes("'"))
				quoteSwapCandidates.push(needle.replace(/'/g, '"'));
			const quoteHit = quoteSwapCandidates.find(
				(s) => s !== needle && findOccurrenceLines(content, s).length === 1,
			);
			if (quoteHit !== undefined) {
				errorMsg += ` The file uses a different quote style — your oldText has ${needle.includes('"') ? "double" : "single"} quotes but the file has ${needle.includes('"') ? "single" : "double"} quotes. Fix the quote style in both oldText and newText before retrying.`;
			} else {
				const lineHint = findFirstLineOfOldText(content, oldText);
				const offsetHint =
					lineHint !== undefined
						? `\`offset=${Math.max(1, lineHint - 2)} limit=20\``
						: undefined;
				if (lineHint !== undefined) {
					// First line content exists in the file — the surrounding block has drifted.
					// Indentation autopatch already ran before this point and did not fix it,
					// so this is a content-drift failure, not a whitespace issue.
					if (failCount >= 2) {
						errorMsg +=
							` This is attempt #${failCount} — the first line of your oldText appears near line ${lineHint}` +
							` but the surrounding content no longer matches. This is a content-drift failure,` +
							` not an indentation issue (indentation autopatch already ran and did not fix it).` +
							` Re-read ${offsetHint} and rebuild oldText verbatim from the current file.`;
					} else if (contentUnchangedSinceRead === true) {
						errorMsg +=
							` The file is unchanged since your last read, so this oldText was not found as written.` +
							` Check for character-level differences such as full-width or smart punctuation,` +
							` em-dashes, or non-breaking spaces, then rebuild oldText verbatim.`;
					} else {
						errorMsg +=
							` The first line of your oldText appears near line ${lineHint} but the rest doesn't match.` +
							` The file has likely changed since your last read — this is a content-drift issue, not indentation.` +
							` Re-read ${offsetHint} and rebuild oldText from the verbatim file content.`;
					}
				} else {
					// First line not found anywhere in the file, even ignoring whitespace.
					if (failCount >= 2) {
						errorMsg +=
							` This is attempt #${failCount} — this text does not appear anywhere in the file,` +
							` even ignoring whitespace differences. Do NOT retry from memory.` +
							` Re-read the relevant section before rebuilding your edit.`;
					} else if (contentUnchangedSinceRead === true) {
						errorMsg +=
							` This text does not appear anywhere in the file, even ignoring indentation differences.` +
							` The file is unchanged since your last read, so the oldText was not found;` +
							` check character-level differences before retrying.`;
					} else {
						errorMsg +=
							` This text does not appear anywhere in the file, even ignoring indentation differences —` +
							` the file has likely changed significantly. Re-read the relevant section before retrying.`;
					}
				}
			}
			// "Did you mean?" — surface the closest current lines (token
			// similarity) so the model can rebuild oldText verbatim in one turn
			// instead of re-reading blind. Skipped on the quote-style path, which
			// already names the precise fix. Anchored near the first-line locator
			// when known, else scans the whole file. Scored against `content`
			// (normalized) but RENDERED from a structurally-aligned raw view —
			// quoting the normalized projection told the agent to copy bytes the
			// file does not contain (#1050).
			if (!errorMsg.includes("quote style")) {
				const similarLines = findSimilarLines(
					content,
					oldText.replace(/\r\n/g, "\n").split("\n")[0],
					{ nearLine: findFirstLineOfOldText(content, oldText) },
				);
				if (similarLines.length > 0) {
					errorMsg += formatSimilarLines(
						similarLines,
						normalizeToLF(stripBom(rawContent).text),
					);
				}
			}
			errors.push(errorMsg);
			// Counterfactual: would the host's edit tool have applied this oldText
			// anyway? hostWouldApply=true => this block is a false-block (pi-lens
			// friction the host wouldn't have); false => a genuine miss. This is the
			// measurement that tells us whether the guard earns its keep (#257).
			const hostMatch = hostWouldApplyOldText(rawContent, oldText);
			logBatchEvent({
				event: "oldtext_not_found", // Existing bounded record for this decision.
				sessionId,
				filePath,
				metadata: {
					tool: "edit",
					source: "edits_without_ranges",
					editIndex,
					oldTextPreview: preview,
					repeatFailureCount: failCount,
					hostWouldApply: hostMatch.wouldApply,
					hostOccurrences: hostMatch.occurrences,
					hostUsedFuzzyMatch: hostMatch.usedFuzzyMatch,
					...(contentUnchangedSinceRead !== undefined && {
						contentUnchangedSinceRead,
					}),
				},
			});
		} else if (occurrenceLines.length === 1) {
			const startLine = occurrenceLines[0];
			const endLine = startLine + needle.split("\n").length - 1;
			const applySpan = exactOldTextForApply(
				rawContentLf,
				content,
				oldText,
				needle,
			);
			if (applySpan !== undefined) {
				// #1053: carry the exact span the preflight approved, plus the
				// snapshot identity it was resolved against. The apply step
				// consumes these instead of re-searching oldText.
				candidateEdits.push({
					oldText,
					appliedSpanText: applySpan.text,
					newText: edits[i].newText,
					originalIndex: editIndex,
					snapshot,
					spanStart: applySpan.start,
					spanEnd: applySpan.end,
				});
				resolvedRanges.push([startLine, endLine]);
				if (resolvedIndexes.length < 100) resolvedIndexes.push(editIndex);
			} else {
				failureKinds.push("oldtext_unrepresentable");
				if (failedEditIndexes.length < 100) failedEditIndexes.push(editIndex);
				if (rejectedReasons.length < 100) {
					rejectedReasons.push({
						index: editIndex,
						code: "oldtext_unrepresentable",
					});
				}
				errors.push(
					`edits[${editIndex}].oldText matched normalized content but could not be mapped to one raw file span; the whole batch must be rebuilt from the current file content.`,
				);
				logBatchEvent({
					event: "edit_preflight_blocked",
					sessionId,
					filePath,
					metadata: {
						tool: "edit",
						source: "edits_without_ranges",
						reasonKind: "oldtext_unrepresentable",
						editIndex,
					},
				});
			}
			if (applySpan !== undefined) {
				logBatchEvent({
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
			}
		} else {
			const preview = oldText.trimStart().substring(0, 60).replace(/\n/g, "↵");
			failureKinds.push("oldtext_duplicate");
			if (failedEditIndexes.length < 100) {
				failedEditIndexes.push(editIndex);
				failedOldTextPreviews.push(preview);
			}
			if (rejectedReasons.length < 100) {
				rejectedReasons.push({ index: editIndex, code: "oldtext_duplicate" });
			}
			const matchSpanLines = needle.split("\n").length;
			const contextBlock = formatOccurrenceContext(
				content,
				occurrenceLines,
				matchSpanLines,
			);
			errors.push(
				`edits[${editIndex}].oldText ("${preview}") appears ${occurrenceLines.length} times:\n${contextBlock}\nPick the location you want and extend your oldText with the unique line above or below it (shown as context).`,
			);
			logBatchEvent({
				event: "oldtext_duplicate",
				sessionId,
				filePath,
				metadata: {
					tool: "edit",
					source: "edits_without_ranges",
					editIndex,
					occurrenceLines: occurrenceLines.slice(0, 100),
					occurrenceCount: occurrenceLines.length,
					oldTextPreview: preview,
				},
			});
		}
	}

	// Overlap guard (#1053): individually-unique matches can still overlap
	// (e.g. "abc" and "bcd" both matching inside "xabcy"). Applying both would
	// splice corrupt content, so overlapping candidates are rejected together
	// with one explicit message instead of being silently skipped.
	const sortedCandidates = [...candidateEdits].sort(
		(a, b) => a.spanStart - b.spanStart,
	);
	const overlaps = overlapPairs(sortedCandidates);
	for (let i = 0; i < sortedCandidates.length; i += 1) {
		const candidate = sortedCandidates[i];
		const overlapping = sortedCandidates.find(
			(other) =>
				other !== candidate &&
				other.spanStart < candidate.spanEnd &&
				candidate.spanStart < other.spanEnd,
		);
		if (overlapping) {
			overlapRejectedCount += 1;
			if (rejectedReasons.length < 100) {
				rejectedReasons.push({
					index: candidate.originalIndex,
					code: "span_overlap",
				});
			}
			continue;
		}
		passedEdits.push(candidate);
	}
	for (const [a, b] of overlaps) {
		errors.push(
			`edits[${a.originalIndex}] and edits[${b.originalIndex}] resolved to overlapping spans of the file — their oldTexts match regions that share bytes. Extend one oldText with a unique neighboring line so each edit targets one unambiguous span, or apply them in separate calls.`,
		);
	}
	// Overlap is a batch-level safety failure. Do not partially commit an
	// unrelated candidate from the same request while another pair is
	// ambiguous; the apply seam promises all-or-nothing preflight rejection.
	if (overlaps.length > 0) passedEdits.length = 0;

	const oldTextEditCount = edits.filter((edit) => !!edit.oldText).length;

	// Pure already-applied batch (#2402): every oldText edit is a recognized
	// exact retry, nothing failed, nothing remains to apply. The verdict is the
	// idempotent "already applied" note, never an escalating error.
	if (
		errors.length === 0 &&
		passedEdits.length === 0 &&
		alreadyAppliedEdits.length > 0 &&
		alreadyAppliedEdits.length === oldTextEditCount
	) {
		const header = `✅ ALREADY APPLIED — every edit in this call was already applied by an identical earlier submission. Do NOT retry this payload; re-read the file if you need to build a new edit.`;
		const details = alreadyAppliedEdits.map(
			(editIndex) => `edits[${editIndex}]: already applied — do not resubmit.`,
		);
		const editBatchSummary = createReadGuardEditBatchSummary({
			requestedIndexes,
			requestedTotal: edits.length,
			alreadyAppliedIndexes: boundedEditIndexes(alreadyAppliedEdits),
			alreadyAppliedTotal: alreadyAppliedEdits.length,
			durationMs: Date.now() - startedAt,
			terminalStatus: "skipped",
		});
		logBatchEvent({
			event: "edit_batch_summary",
			correlationId,
			filePath,
			metadata: { tool: "edit", editBatchSummary },
		});
		return {
			touchedLines: undefined,
			preflightError: `${header}\n\n${details.join("\n")}`,
			preflightHeader: header,
			preflightDetails: details,
			alreadyAppliedEdits,
			editBatchSummary,
		};
	}

	if (
		errors.length > 0 ||
		alreadyAppliedEdits.length > 0 ||
		resolvedRanges.length !== oldTextEditCount
	) {
		const failureDetails =
			errors.length > 0
				? errors
				: alreadyAppliedEdits.map(
						(editIndex) =>
							`edits[${editIndex}]: already applied — do not resubmit.`,
					);
		const uniqueFailureKinds = [...new Set(failureKinds)];
		const editBatchSummary = createReadGuardEditBatchSummary({
			requestedIndexes,
			requestedTotal: edits.length,
			resolvedIndexes,
			resolvedTotal: resolvedRanges.length,
			rejectedReasons,
			rejectedTotal: Math.max(
				0,
				oldTextEditCount -
					resolvedRanges.length -
					alreadyAppliedEdits.length +
					overlapRejectedCount,
			),
			alreadyAppliedIndexes: boundedEditIndexes(alreadyAppliedEdits),
			alreadyAppliedTotal: alreadyAppliedEdits.length,
			durationMs: Date.now() - startedAt,
			terminalStatus: "blocked",
		});
		logBatchEvent({
			event: "edit_preflight_blocked",
			correlationId,
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
				alreadyAppliedCount: alreadyAppliedEdits.length,
				overlapRejectedCount,
				failedEditIndexes,
				oldTextPreviews: failedOldTextPreviews.slice(0, 5),
				errorCount: errors.length,
			},
		});
		const header =
			errors.length === 0
				? `✅ ALREADY APPLIED — some edits in this call were already applied by an identical earlier submission. Do NOT resubmit them.`
				: maxFailCount >= 2
					? `🛑 RE-READ REQUIRED — You have submitted this oldText before and it still does not match.\n\nDo NOT retry from memory. Re-read \`${filePath}\` to get the current content, then rebuild your edit from the verbatim file text.`
					: uniqueFailureKinds.length === 1 &&
						  uniqueFailureKinds[0] === "span_overlap"
						? `🔄 RETRYABLE — Overlapping edit spans`
						: `🔄 RETRYABLE — Edit target not found`;
		logBatchEvent({
			event: "edit_batch_summary",
			correlationId,
			filePath,
			metadata: { tool: "edit", editBatchSummary },
		});
		return {
			touchedLines: undefined,
			preflightError: `${header}\n\n${failureDetails.join("\n\n")}${formatAlreadyAppliedNotes(alreadyAppliedEdits)}`,
			preflightHeader: header,
			preflightDetails: failureDetails,
			partiallyApplicable:
				passedEdits.length > 0 &&
				!failureKinds.includes("oldtext_unrepresentable")
					? passedEdits
					: undefined,
			alreadyAppliedEdits:
				alreadyAppliedEdits.length > 0 ? alreadyAppliedEdits : undefined,
			editBatchSummary,
		};
	}

	if (resolvedRanges.length === 0) {
		const editBatchSummary = createReadGuardEditBatchSummary({
			requestedIndexes,
			requestedTotal: edits.length,
			rejectedTotal: oldTextEditCount,
			terminalStatus: "blocked",
		});
		logBatchEvent({
			event: "touched_lines_missing",
			sessionId,
			filePath,
			metadata: {
				tool: "edit",
				source: "edits_without_ranges",
				editCount: edits.length,
			},
		});
		logBatchEvent({
			event: "edit_batch_summary",
			filePath,
			metadata: { tool: "edit", editBatchSummary },
		});
		return { touchedLines: undefined, editBatchSummary };
	}

	const starts = resolvedRanges.map(([s]) => s);
	const ends = resolvedRanges.map(([, e]) => e);
	const touchedLines: [number, number] = [
		Math.min(...starts),
		Math.max(...ends),
	];
	const editRanges = resolvedRanges.length > 1 ? resolvedRanges : undefined;
	logBatchEvent({
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
	const editBatchSummary = createReadGuardEditBatchSummary({
		requestedIndexes,
		requestedTotal: edits.length,
		resolvedIndexes,
		resolvedTotal: resolvedRanges.length,
		durationMs: Date.now() - startedAt,
		terminalStatus: "success",
	});
	return {
		touchedLines,
		editRanges,
		contentMatchValidated: true,
		editBatchSummary,
	};
}

// Canonical applied-edit keying lives beside the partial-apply seam that both
// writes and consumes it (partial-edit-apply.ts, #1053/#2402).
export { stripOldTextTrailingWhitespace } from "./partial-edit-apply.js";

/**
 * Normalises an oldText string for whitespace-only differences that editors routinely
 * introduce: trailing spaces/tabs on each line are stripped, and any trailing blank
 * lines (lines that are empty after trimming) are removed from the end. CRLF is
 * normalised to LF. Returns the same string if no change was needed.
 */

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

	// Tier A (#200): the fixed-length matchers above can't bridge a mid-block
	// blank-line difference; fall back to a blank-line-insensitive match that
	// recovers the real file span (unique-match guarded).
	const blankLineCandidate = findBlankLineInsensitiveCandidate(
		content,
		normalized,
	);
	if (blankLineCandidate !== undefined) {
		return blankLineCandidate;
	}

	// Tier B: interior-whitespace drift the earlier tiers can't bridge — the
	// indentation- and blank-line-insensitive tiers both still require each
	// non-blank line to match character-for-character after trimming only the
	// OUTER edges. When whitespace drifts INSIDE a line (a formatter collapsed
	// `a  +  b` → `a + b`, re-spaced operators/args, etc.) those tiers miss.
	// Matching on a fully-whitespace-collapsed signature catches it. Same
	// safety contract as Tier A: unique-match guarded, ≥2 anchors, recovers the
	// verbatim file span.
	const whitespaceCandidate = findWhitespaceInsensitiveCandidate(
		content,
		normalized,
	);
	if (whitespaceCandidate !== undefined) {
		return whitespaceCandidate;
	}

	// Tier C: Unicode-punctuation drift the whitespace tiers can't bridge — the
	// model emitted smart quotes / em-dashes / NBSP where the file has straight
	// quotes / hyphens / regular spaces (or vice versa), common when text is
	// pasted from rendered Markdown or the model "tidies" punctuation. Folding
	// those to their ASCII equivalents (on top of whitespace collapse) catches it.
	// Same safety contract as Tier B: signature-matched, unique-match guarded, ≥2
	// anchors, recovers the verbatim file span (the file's real characters).
	const unicodeCandidate = findUnicodePunctuationInsensitiveCandidate(
		content,
		normalized,
	);
	if (unicodeCandidate !== undefined) {
		return unicodeCandidate;
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

/**
 * Tier A of the blank-line autopatch (#200): tolerate mid-block blank-line
 * divergence — a blank line added or removed *inside* the block — which the
 * fixed-length window in {@link findIndentationInsensitiveCandidate} can't (any
 * interior blank-line delta breaks its 1:1 alignment). Blank lines are
 * semantically insignificant in every supported language, so matching the
 * oldText's non-blank lines (indentation-insensitive) against consecutive
 * content while skipping interior blanks on the content side is safe.
 *
 * Safety: matches by the non-blank "signature" but **recovers and returns the
 * real file span** (first→last matched non-blank line, real interior blanks
 * included) so the applied oldText is verbatim file bytes; requires the
 * signature to match **exactly once** (returns undefined on 0 or ≥2). Anchored
 * on ≥2 non-blank lines to avoid trivial single-line collisions.
 */
function findBlankLineInsensitiveCandidate(
	content: string,
	oldText: string,
): string | undefined {
	const stripIndent = (line: string) => line.replace(/^[\t ]+/, "").trimEnd();
	const isBlank = (line: string) => stripIndent(line) === "";

	const contentLines = content.split("\n");
	const oldNonBlank = oldText
		.split("\n")
		.map(stripIndent)
		.filter((line) => line !== "");
	// Need ≥2 anchors to be meaningful and collision-resistant; single-line
	// drift has no interior to differ and is handled by other tiers.
	if (oldNonBlank.length < 2) return undefined;

	const spans: Array<[number, number]> = [];
	for (let start = 0; start < contentLines.length; start += 1) {
		if (stripIndent(contentLines[start]) !== oldNonBlank[0]) continue;
		let contentIdx = start + 1;
		let oldIdx = 1;
		let end = start;
		let ok = true;
		while (oldIdx < oldNonBlank.length) {
			while (
				contentIdx < contentLines.length &&
				isBlank(contentLines[contentIdx])
			)
				contentIdx += 1;
			if (
				contentIdx >= contentLines.length ||
				stripIndent(contentLines[contentIdx]) !== oldNonBlank[oldIdx]
			) {
				ok = false;
				break;
			}
			end = contentIdx;
			oldIdx += 1;
			contentIdx += 1;
		}
		if (ok) spans.push([start, end]);
	}

	if (spans.length !== 1) return undefined;
	const [start, end] = spans[0];
	const candidate = contentLines.slice(start, end + 1).join("\n");
	return candidate === oldText ? undefined : candidate;
}

/**
 * Tier B of the whitespace autopatch: tolerate INTERIOR whitespace divergence
 * that {@link findBlankLineInsensitiveCandidate} (outer-trim only) and the
 * fixed-width converters can't bridge. The signature is each non-blank line
 * with **all** whitespace removed (`/\s+/g` → ""), so re-spacing inside a line
 * — `a  +  b` ↔ `a + b`, `foo( x )` ↔ `foo(x)`, tab/space mixes mid-line — no
 * longer breaks the match. This mirrors the content-hash normalization the
 * read-guard already uses for staleness (`lineContentHash`), so a span that
 * passes here is a span the guard considers semantically identical.
 *
 * Safety mirrors Tier A exactly: matches by the collapsed signature but
 * **recovers and returns the real file span** (verbatim bytes, interior blanks
 * included) so the applied oldText is exact; requires the signature to match
 * **exactly once** (0 or ≥2 → undefined); anchored on ≥2 non-blank lines to
 * resist single-line collisions (collapsing whitespace makes single-line
 * collisions more likely, so the ≥2 floor matters more here than in Tier A).
 */
function findWhitespaceInsensitiveCandidate(
	content: string,
	oldText: string,
): string | undefined {
	const collapse = (line: string) => line.replace(/\s+/g, "");
	const isBlank = (line: string) => collapse(line) === "";

	const contentLines = content.split("\n");
	const oldSignature = oldText
		.split("\n")
		.map(collapse)
		.filter((line) => line !== "");
	if (oldSignature.length < 2) return undefined;

	const spans: Array<[number, number]> = [];
	for (let start = 0; start < contentLines.length; start += 1) {
		if (collapse(contentLines[start]) !== oldSignature[0]) continue;
		let contentIdx = start + 1;
		let sigIdx = 1;
		let end = start;
		let ok = true;
		while (sigIdx < oldSignature.length) {
			while (
				contentIdx < contentLines.length &&
				isBlank(contentLines[contentIdx])
			)
				contentIdx += 1;
			if (
				contentIdx >= contentLines.length ||
				collapse(contentLines[contentIdx]) !== oldSignature[sigIdx]
			) {
				ok = false;
				break;
			}
			end = contentIdx;
			sigIdx += 1;
			contentIdx += 1;
		}
		if (ok) spans.push([start, end]);
	}

	if (spans.length !== 1) return undefined;
	const [start, end] = spans[0];
	const candidate = contentLines.slice(start, end + 1).join("\n");
	return candidate === oldText ? undefined : candidate;
}

/**
 * Fold the Unicode punctuation that models and rendered text routinely swap for
 * ASCII (and back) to a canonical ASCII form: smart single/double quotes →
 * `'`/`"`, the dash family (hyphen, figure/en/em dash, horizontal bar, minus) →
 * `-`, and non-breaking / typographic spaces → a regular space. Used only to
 * build a match signature — never to rewrite file content.
 */
function normalizeUnicodePunctuation(text: string): string {
	return text
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐-―−]/g, "-")
		.replace(/[  -   　]/g, " ");
}

/**
 * Tier C of the autopatch ladder: tolerate Unicode-punctuation divergence the
 * whitespace tiers can't bridge (smart quotes ↔ straight, em/en-dash ↔ hyphen,
 * NBSP ↔ space). The signature folds Unicode punctuation to ASCII and then
 * collapses all whitespace (so it subsumes Tier B and additionally absorbs the
 * punctuation swap). Safety mirrors Tier B exactly: matches by the folded
 * signature but **recovers and returns the verbatim file span** (the file's real
 * characters), requires the signature to match **exactly once**, and anchors on
 * ≥2 non-blank lines to resist single-line collisions.
 */
function findUnicodePunctuationInsensitiveCandidate(
	content: string,
	oldText: string,
): string | undefined {
	const fold = (line: string) =>
		normalizeUnicodePunctuation(line).replace(/\s+/g, "");
	const isBlank = (line: string) => fold(line) === "";

	const contentLines = content.split("\n");
	const oldSignature = oldText
		.split("\n")
		.map(fold)
		.filter((line) => line !== "");
	if (oldSignature.length < 2) return undefined;

	const spans: Array<[number, number]> = [];
	for (let start = 0; start < contentLines.length; start += 1) {
		if (fold(contentLines[start]) !== oldSignature[0]) continue;
		let contentIdx = start + 1;
		let sigIdx = 1;
		let end = start;
		let ok = true;
		while (sigIdx < oldSignature.length) {
			while (
				contentIdx < contentLines.length &&
				isBlank(contentLines[contentIdx])
			)
				contentIdx += 1;
			if (
				contentIdx >= contentLines.length ||
				fold(contentLines[contentIdx]) !== oldSignature[sigIdx]
			) {
				ok = false;
				break;
			}
			end = contentIdx;
			sigIdx += 1;
			contentIdx += 1;
		}
		if (ok) spans.push([start, end]);
	}

	if (spans.length !== 1) return undefined;
	const [start, end] = spans[0];
	const candidate = contentLines.slice(start, end + 1).join("\n");
	return candidate === oldText ? undefined : candidate;
}

/**
 * Shift a native range edit's line numbers, in place, by the relocation delta.
 * Returns true when a range matching `from` was found and rewritten. Powers the
 * content-verified range-stale auto-apply: the lines the agent meant to edit
 * moved (proven by read-time line hashes uniquely matching the new location),
 * so we re-target the positional edit to where the content now lives.
 *
 * Shifts by a constant line delta (`to[0] - from[0]`) applied to both the start
 * and end lines, so inclusive/exclusive end conventions and any character
 * offsets are preserved untouched — only the line position moves. Matches both
 * the single `oldRange` shape and `edits[].range` entries.
 */
export function relocateEditRange(
	input: unknown,
	from: [number, number],
	to: [number, number],
): boolean {
	const delta = to[0] - from[0];
	if (delta === 0 || !input || typeof input !== "object") return false;
	const editInput = input as {
		oldRange?: { start?: { line?: number }; end?: { line?: number } };
		edits?: Array<{
			range?: { start?: { line?: number }; end?: { line?: number } };
		}>;
	};
	const matchesFrom = (start?: number, end?: number) =>
		start === from[0] && end === from[1];
	let applied = false;

	const oldRange = editInput.oldRange;
	if (
		oldRange?.start?.line !== undefined &&
		oldRange.end?.line !== undefined &&
		matchesFrom(oldRange.start.line, oldRange.end.line)
	) {
		oldRange.start.line += delta;
		oldRange.end.line += delta;
		applied = true;
	}

	if (Array.isArray(editInput.edits)) {
		for (const edit of editInput.edits) {
			const start = edit.range?.start?.line;
			const end = edit.range?.end?.line ?? start;
			if (start !== undefined && matchesFrom(start, end)) {
				edit.range!.start!.line = start + delta;
				if (edit.range?.end?.line !== undefined) {
					edit.range.end.line += delta;
				}
				applied = true;
			}
		}
	}

	return applied;
}

export function getTouchedLinesForGuard(
	event: unknown,
	filePath?: string,
	sessionId?: string,
	correlationId?: string,
	partialApplyRecords?: PartialApplyRecordStore,
	contentUnchangedSinceRead?: boolean,
): GuardLineResult {
	// #2423: the seam decides whether this event mutates a file, and which shape
	// adapter (if any) already resolved its ranges. A tool named `replace` or
	// `insert` reaches the native-shape ladder below exactly like `edit` does.
	const mutation = classifyMutatingTool(event, {
		filePath,
		sessionId,
		correlationId,
	});
	if (mutation === undefined) return { touchedLines: undefined };

	if (mutation.kind === "edit") {
		// An adapter that recognized the input owns the answer, including a
		// blocking preflight error.
		if (mutation.touchedLines !== undefined || mutation.preflightError) {
			return {
				touchedLines: mutation.touchedLines,
				...(mutation.editRanges ? { editRanges: mutation.editRanges } : {}),
				...(mutation.preflightError
					? { preflightError: mutation.preflightError }
					: {}),
				...(mutation.editBatchSummary
					? { editBatchSummary: mutation.editBatchSummary }
					: {}),
			};
		}
		// The host standard-edit fields (path, edits[].oldText/newText) are pinned
		// to the SDK's EditToolInput, so a host edit-schema change is a compile
		// error instead of silently falling through to `unknown_edit_schema`. The
		// remaining keys are pi-lens's own extensions for native-ranged + hashline
		// edit tools; oldText/newText are probed as optional because range-only
		// edits omit them (refs #3).
		const editInput = (event as { input?: unknown }).input as Partial<
			Pick<EditToolInput, "path">
		> & {
			oldRange?: { start: { line: number }; end: { line: number } };
			edits?: Array<
				Partial<EditToolInput["edits"][number]> & {
					range?: { start?: { line: number }; end?: { line: number } };
				}
			>;
			operations?: unknown[];
			ops?: unknown[];
			set_line?: unknown;
			replace_lines?: unknown;
			replace_symbol?: unknown;
		};
		if (editInput.oldRange) {
			const touchedLines: [number, number] = [
				editInput.oldRange.start.line,
				editInput.oldRange.end.line,
			];
			if (filePath) {
				logReadGuardEvent({
					event: "touched_lines_detected",
					correlationId,
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
					return resolveOldTextEdits(
						editInput.edits,
						filePath,
						sessionId,
						correlationId,
						partialApplyRecords,
						contentUnchangedSinceRead,
					);
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
					correlationId,
					partialApplyRecords,
					contentUnchangedSinceRead,
				);
				if (resolved.preflightError) {
					// A mixed range/oldText request is one host operation. If any
					// oldText edit cannot be represented as a carried raw span,
					// close the whole batch instead of letting the host apply only
					// the native ranges.
					return {
						...resolved,
						partiallyApplicable: undefined,
						touchedLines: undefined,
					};
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
					correlationId,
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
				correlationId,
				sessionId,
				filePath,
				metadata: {
					tool: "edit",
					source: "unknown_edit_schema",
					// #2423: name the tool. An unknown schema under a third-party
					// tool name is the actionable case — it says which producer
					// needs a shape adapter.
					mutatingToolName: mutation.toolName,
					mutationProvenance: mutation.provenance,
					// #2423 review round 1 (F1): an adapter that RECOGNIZED the
					// shape but could not turn its anchors into lines says so here.
					// `adapterSource: "hashline-edit-pro"` with
					// `unresolvedReason: "remove_from:anchor_not_found"` is the
					// production record of a stale anchor — a report, not a block.
					adapterSource: mutation.source,
					unresolvedReason: mutation.unresolvedReason,
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

	// kind === "write": the whole file is the touched range.
	const lineCount = filePath ? countFileLines(filePath) : 1;
	const writeTouchedLines: [number, number] = [1, lineCount];
	if (filePath) {
		logReadGuardEvent({
			event: "touched_lines_detected",
			correlationId,
			sessionId,
			filePath,
			metadata: {
				tool: "write",
				source: "full_file_write",
				touchedLines: writeTouchedLines,
				lineCount,
			},
		});
	}
	return { touchedLines: writeTouchedLines };
}
