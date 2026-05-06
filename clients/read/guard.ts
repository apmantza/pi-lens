/**
 * Read-Before-Edit Guard for pi-lens
 *
 * Blocks edits that lack adequate prior reading:
 * 1. Zero-read edit: never read this file in this branch
 * 2. File modified since read: disk content changed (FileTime)
 * 3. Out-of-range edit: edit target not covered by any previous read
 * 4. LSP expansion exemption: single-line read expanded to full symbol counts
 *
 * Falls back safely when LSP is unavailable.
 */

import * as nodeFs from "node:fs";
import { createFileTime, type FileTime } from "../file-time.js";
import { logReadGuardEvent } from "./guard-logger.js";

// --- Types ---

export interface ReadRecord {
	filePath: string;
	// What the agent *asked* for
	requestedOffset: number;
	requestedLimit: number;
	// What pi-lens *delivered* (after LSP expansion, if any)
	effectiveOffset: number;
	effectiveLimit: number;
	expandedByLsp: boolean;
	enclosingSymbol?: {
		name: string;
		kind: string;
		startLine: number;
		endLine: number;
	};
	turnIndex: number;
	writeIndex: number;
	timestamp: number;
}

export interface EditRecord {
	filePath: string;
	tool: "write" | "edit";
	touchedLines: [start: number, end: number];
	precedingReads: ReadRecord[];
	verdict: "allowed" | "blocked" | "warned";
	reason?: string;
	timestamp: number;
}

export interface ReadGuardVerdict {
	action: "allow" | "block" | "warn";
	reason?: string;
	details?: {
		editRange: [number, number];
		readRanges: Array<{ start: number; end: number }>;
		symbolRanges: Array<{ name: string; start: number; end: number }>;
	};
}

export interface ReadGuardConfig {
	enabled: boolean;
	mode: "block" | "warn" | "off";
	contextLines: number;
	exemptions: Array<{
		pattern: string;
		mode: "allow" | "warn" | "block";
	}>;
}

// --- Constants ---

const DEFAULT_CONFIG: ReadGuardConfig = {
	enabled: true,
	mode: "block",
	contextLines: 3,
	exemptions: [
		{ pattern: "*.md", mode: "allow" },
		{ pattern: "*.txt", mode: "allow" },
		{ pattern: "*.log", mode: "allow" },
	],
};

const OWN_EDIT_STALE_GRACE_MS = Math.max(
	0,
	Number.parseInt(
		process.env.PI_LENS_READ_GUARD_OWN_EDIT_GRACE_MS ?? "120000",
		10,
	) || 120000,
);

// --- ReadGuard Class ---

export class ReadGuard {
	private readonly config: ReadGuardConfig;
	private readonly reads = new Map<string, ReadRecord[]>();
	private readonly edits = new Map<string, EditRecord[]>();
	private readonly fileTime: FileTime;
	private readonly exemptions = new Set<string>(); // One-time exemptions via /lens-allow-edit
	private readonly sessionId: string;

	constructor(sessionId: string, config: Partial<ReadGuardConfig> = {}) {
		this.sessionId = sessionId;
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.fileTime = createFileTime(sessionId);
	}

	// --- Public API ---

	/**
	 * Record that a file was read.
	 * Call this from the tool_call handler after any LSP expansion.
	 */
	recordRead(record: ReadRecord): void {
		const arr = this.reads.get(record.filePath) ?? [];
		arr.push(record);
		this.reads.set(record.filePath, arr);

		logReadGuardEvent({
			event: "read_recorded",
			sessionId: this.sessionId,
			filePath: record.filePath,
			requestedOffset: record.requestedOffset,
			requestedLimit: record.requestedLimit,
			effectiveOffset: record.effectiveOffset,
			effectiveLimit: record.effectiveLimit,
			symbol: record.enclosingSymbol?.name,
			symbolKind: record.enclosingSymbol?.kind,
			symbolStartLine: record.enclosingSymbol?.startLine,
			symbolEndLine: record.enclosingSymbol?.endLine,
			metadata: {
				expandedByLsp: record.expandedByLsp,
				turnIndex: record.turnIndex,
				writeIndex: record.writeIndex,
				readCountForFile: arr.length,
			},
		});

		// Also update FileTime stamp for this file
		this.fileTime.read(record.filePath);
	}

	/**
	 * Check if an edit should be allowed.
	 * Returns verdict with action and optional reason for blocking.
	 */
	checkEdit(
		filePath: string,
		touchedLines?: [number, number],
		editRanges?: [number, number][],
	): ReadGuardVerdict {
		// Check exemptions
		if (this.exemptions.has(filePath)) {
			this.exemptions.delete(filePath); // One-time use
			const verdict = this.allow();
			this.recordVerdict(filePath, "edit", touchedLines, verdict, {
				reasonKind: "manual_exemption",
			});
			return verdict;
		}

		// Check config exemptions by pattern
		const exemptionMode = this.getExemptionMode(filePath);
		if (exemptionMode === "allow") {
			const verdict = this.allow();
			this.recordVerdict(filePath, "edit", touchedLines, verdict, {
				reasonKind: "pattern_exemption",
				exemptionMode,
			});
			return verdict;
		}

		// 1. Zero-read check
		const fileReads = this.reads.get(filePath);
		if (!fileReads || fileReads.length === 0) {
			const verdict = this.blockOrWarn(
				"zero-read",
				`🔴 BLOCKED — Edit without read\n\nYou are trying to edit \`${filePath}\` but have not read it in this conversation.\n\nRead the file first, then retry the edit: \`read path="${filePath}"\``,
			);
			this.recordVerdict(filePath, "edit", touchedLines, verdict, {
				reasonKind: "zero_read",
			});
			return verdict;
		}

		// 2. FileTime check (actual staleness)
		let ignoredOwnEditStaleness = false;
		if (this.fileTime.hasChanged(filePath)) {
			const lastRead = fileReads[fileReads.length - 1];
			if (this.canTreatStalenessAsOwnPriorEdit(filePath, lastRead.timestamp)) {
				ignoredOwnEditStaleness = true;
			} else {
				const verdict = this.blockOrWarn(
					"file-modified",
					`🔴 BLOCKED — File modified since read\n\nYou last read \`${filePath}\` at ${new Date(lastRead.timestamp).toISOString()}.\nThe file has been modified on disk since then (auto-format, external tool, or previous edit).\n\nYour mental model is out of sync with the actual file content.\nTo proceed:\n  1. Re-read the file: \`read path="${filePath}"\``,
				);
				this.recordVerdict(filePath, "edit", touchedLines, verdict, {
					reasonKind: "file_modified",
					lastReadTimestamp: lastRead.timestamp,
				});
				return verdict;
			}
		}

		// If no line range specified, we can only check zero-read and FileTime
		if (!touchedLines) {
			const verdict = this.allow();
			this.recordVerdict(filePath, "edit", touchedLines, verdict, {
				reasonKind: "no_line_info",
			});
			return verdict;
		}

		// 3. Range coverage check
		// When the edit touches multiple disjoint spots (e.g. rename across 4 tool
		// registrations), check each spot independently. Collapsing to a bounding
		// box would falsely flag reads that cover exactly the right lines.
		const rangesToCheck: [number, number][] =
			editRanges && editRanges.length > 1 ? editRanges : [touchedLines];

		let viaSymbol = false;
		for (const range of rangesToCheck) {
			const coverage = this.checkCoverage(filePath, range);
			if (!coverage.covered) {
				const lastRead = fileReads[fileReads.length - 1];
				const [editStart, editEnd] = range;
				const lastReadEnd =
					lastRead.effectiveOffset + lastRead.effectiveLimit - 1;
				const verdict = this.blockOrWarn(
					"out-of-range",
					`🔴 BLOCKED — Edit outside read range\n\nYou read \`${filePath}\` lines ${lastRead.effectiveOffset}-${lastReadEnd}${lastRead.enclosingSymbol ? ` (${lastRead.enclosingSymbol.kind} \`${lastRead.enclosingSymbol.name}\`)` : ""}, but your edit touches lines ${editStart}-${editEnd}.\n\nRead the relevant section first, then retry the edit:\n  \`read path="${filePath}" offset=${Math.max(1, editStart - 5)} limit=${Math.min(30, editEnd - editStart + 10)}\``,
					{
						editRange: range,
						readRanges: fileReads.map((r) => ({
							start: r.effectiveOffset,
							end: r.effectiveOffset + r.effectiveLimit - 1,
						})),
						symbolRanges: fileReads
							.filter((r) => r.enclosingSymbol)
							.map((r) => ({
								name: r.enclosingSymbol!.name,
								start: r.enclosingSymbol!.startLine,
								end: r.enclosingSymbol!.endLine,
							})),
					},
				);
				this.recordVerdict(filePath, "edit", touchedLines, verdict, {
					reasonKind: "out_of_range",
				});
				return verdict;
			}
			if (coverage.viaSymbol) viaSymbol = true;
		}

		const verdict = this.allow();
		this.recordVerdict(filePath, "edit", touchedLines, verdict, {
			reasonKind: viaSymbol ? "symbol_coverage" : "range_coverage",
			viaSymbol,
			ignoredOwnEditStaleness,
		});
		return verdict;
	}

	/**
	 * Check if this is a new file (no existing file on disk).
	 * New file writes are exempt from the guard.
	 */
	isNewFile(filePath: string): boolean {
		try {
			return !nodeFs.existsSync(filePath);
		} catch {
			return true; // Assume new if we can't stat
		}
	}

	/**
	 * Refresh the FileTime stamp after the model's own write lands on disk.
	 * Call this from the tool_result handler so the next checkEdit on the same
	 * file doesn't see "file_modified" caused by our own previous edit.
	 */
	recordWritten(filePath: string): void {
		this.fileTime.read(filePath);
	}

	/**
	 * Add a one-time exemption for a file.
	 * Called via /lens-allow-edit command.
	 */
	addExemption(filePath: string): void {
		this.exemptions.add(filePath);
		logReadGuardEvent({
			event: "exemption_added",
			sessionId: this.sessionId,
			filePath,
			metadata: {
				source: "lens-allow-edit",
			},
		});
	}

	/**
	 * Get summary statistics for /lens-health.
	 */
	getSummary(): {
		totalEdits: number;
		totalBlocks: number;
		byReason: Record<string, number>;
		byFile: Record<string, { edits: number; blocks: number }>;
		lspExpansionsHelped: number;
	} {
		let totalEdits = 0;
		let totalBlocks = 0;
		let lspExpansionsHelped = 0;
		const byReason: Record<string, number> = {};
		const byFile: Record<string, { edits: number; blocks: number }> = {};

		for (const [filePath, records] of this.edits) {
			for (const record of records) {
				totalEdits++;
				byFile[filePath] = byFile[filePath] ?? { edits: 0, blocks: 0 };
				byFile[filePath].edits++;

				if (record.verdict === "blocked") {
					totalBlocks++;
					byFile[filePath].blocks++;
				}

				if (record.reason) {
					byReason[record.reason] = (byReason[record.reason] ?? 0) + 1;
				}

				// Count LSP expansions that allowed an edit
				if (
					record.precedingReads.some((r) => r.expandedByLsp) &&
					record.verdict === "allowed"
				) {
					lspExpansionsHelped++;
				}
			}
		}

		return {
			totalEdits,
			totalBlocks,
			byReason,
			byFile,
			lspExpansionsHelped,
		};
	}

	/**
	 * Get all read records for a file (for debugging).
	 */
	getReadHistory(filePath: string): ReadRecord[] {
		return this.reads.get(filePath) ?? [];
	}

	/**
	 * Get all edit records for a file (for debugging).
	 */
	getEditHistory(filePath: string): EditRecord[] {
		return this.edits.get(filePath) ?? [];
	}

	// --- Private helpers ---

	private canTreatStalenessAsOwnPriorEdit(
		filePath: string,
		lastReadTimestamp: number,
	): boolean {
		const edits = this.edits.get(filePath) ?? [];
		const latest = edits.at(-1);
		if (!latest) return false;
		if (latest.verdict !== "allowed" && latest.verdict !== "warned")
			return false;
		if (latest.timestamp < lastReadTimestamp) return false;
		return Date.now() - latest.timestamp <= OWN_EDIT_STALE_GRACE_MS;
	}

	private checkCoverage(
		filePath: string,
		touchedLines: [number, number],
	): { covered: boolean; viaSymbol: boolean } {
		const [editStart, editEnd] = touchedLines;

		const reads = this.reads.get(filePath) ?? [];

		// First pass: check symbol coverage and any single read that covers the edit.
		for (const read of reads) {
			const readStart = Math.max(
				1,
				read.effectiveOffset - this.config.contextLines,
			);
			const readEnd =
				read.effectiveOffset +
				read.effectiveLimit -
				1 +
				this.config.contextLines;

			if (editStart >= readStart && editEnd <= readEnd) {
				return { covered: true, viaSymbol: false };
			}

			if (read.enclosingSymbol) {
				const symStart = read.enclosingSymbol.startLine;
				const symEnd = read.enclosingSymbol.endLine;
				if (symStart <= editStart && symEnd >= editEnd) {
					return { covered: true, viaSymbol: true };
				}
			}
		}

		// Second pass: merge all read intervals and check if their union covers
		// [editStart, editEnd]. Handles multi-chunk reads (e.g. 1-100 + 101-200).
		const intervals = reads.map(
			(read) =>
				[
					Math.max(1, read.effectiveOffset - this.config.contextLines),
					read.effectiveOffset +
						read.effectiveLimit -
						1 +
						this.config.contextLines,
				] as [number, number],
		);

		intervals.sort((a, b) => a[0] - b[0]);

		// Merge overlapping/adjacent intervals
		const merged: Array<[number, number]> = [];
		for (const [s, e] of intervals) {
			if (merged.length > 0 && s <= merged[merged.length - 1][1] + 1) {
				merged[merged.length - 1][1] = Math.max(
					merged[merged.length - 1][1],
					e,
				);
			} else {
				merged.push([s, e]);
			}
		}

		for (const [s, e] of merged) {
			if (editStart >= s && editEnd <= e) {
				return { covered: true, viaSymbol: false };
			}
		}

		return { covered: false, viaSymbol: false };
	}

	private getExemptionMode(
		filePath: string,
	): "allow" | "warn" | "block" | null {
		for (const exemption of this.config.exemptions) {
			if (this.matchesPattern(filePath, exemption.pattern)) {
				return exemption.mode;
			}
		}
		return null;
	}

	private matchesPattern(filePath: string, pattern: string): boolean {
		// Simple glob matching — can be expanded
		if (pattern.startsWith("*")) {
			const suffix = pattern.slice(1);
			return filePath.endsWith(suffix);
		}
		if (pattern.includes("*")) {
			// Convert glob to regex
			const regex = new RegExp(
				`^${pattern.replace(/\\/g, "\\\\").replace(/\./g, "\\.").replace(/\*/g, ".*")}$`,
			);
			return regex.test(filePath);
		}
		return filePath === pattern;
	}

	private blockOrWarn(
		_reason: string,
		message: string,
		details?: ReadGuardVerdict["details"],
	): ReadGuardVerdict {
		if (this.config.mode === "warn") {
			return { action: "warn", reason: message, details };
		}
		return { action: "block", reason: message, details };
	}

	private allow(): ReadGuardVerdict {
		return { action: "allow" };
	}

	private recordEdit(
		filePath: string,
		tool: "write" | "edit",
		touchedLines: [number, number],
		verdict: ReadGuardVerdict,
	): void {
		const arr = this.edits.get(filePath) ?? [];
		arr.push({
			filePath,
			tool,
			touchedLines,
			precedingReads: this.reads.get(filePath) ?? [],
			verdict: mapVerdictAction(verdict.action),
			reason: verdict.reason,
			timestamp: Date.now(),
		});
		this.edits.set(filePath, arr);
	}

	private recordVerdict(
		filePath: string,
		tool: "write" | "edit",
		touchedLines: [number, number] | undefined,
		verdict: ReadGuardVerdict,
		metadata: Record<string, unknown> = {},
	): void {
		const normalizedTouchedLines = touchedLines ?? [1, 1];
		this.recordEdit(filePath, tool, normalizedTouchedLines, verdict);
		const reads = this.reads.get(filePath) ?? [];
		logReadGuardEvent({
			event:
				verdict.action === "allow"
					? "edit_allowed"
					: verdict.action === "warn"
						? "edit_warned"
						: "edit_blocked",
			sessionId: this.sessionId,
			filePath,
			metadata: {
				tool,
				touchedLines: touchedLines ?? null,
				normalizedTouchedLines,
				readCount: reads.length,
				reads: reads.map((read) => ({
					requestedOffset: read.requestedOffset,
					requestedLimit: read.requestedLimit,
					effectiveOffset: read.effectiveOffset,
					effectiveLimit: read.effectiveLimit,
					expandedByLsp: read.expandedByLsp,
					enclosingSymbol: read.enclosingSymbol ?? null,
					timestamp: read.timestamp,
				})),
				verdictAction: verdict.action,
				details: verdict.details,
				...metadata,
			},
		});
	}
}

// --- Factory ---

function mapVerdictAction(
	action: ReadGuardVerdict["action"],
): EditRecord["verdict"] {
	switch (action) {
		case "allow":
			return "allowed";
		case "block":
			return "blocked";
		case "warn":
			return "warned";
	}
}

export function createReadGuard(
	sessionId: string,
	config?: Partial<ReadGuardConfig>,
): ReadGuard {
	return new ReadGuard(sessionId, config);
}
