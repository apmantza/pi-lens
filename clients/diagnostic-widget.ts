import * as path from "node:path";
import type { Diagnostic, DispatchResult } from "./dispatch/types.js";
import { normalizeMapKey } from "./path-utils.js";

const MAX_FILES = 8;

type Semantic = "blocking" | "warning" | "fixed";

interface FileEntry {
	semantic: Semantic;
	relPath: string;
	line?: number;
	column?: number;
	tool: string;
	message: string;
	extraCount: number;
}

// Ordered map: insertion order = chronological, most recently edited last.
// When a file is re-edited its entry is deleted and re-inserted so it moves to the end.
const fileEntries = new Map<string, FileEntry>();

let _setWidget: ((lines: string[] | undefined) => void) | null = null;
let _projectRoot = "";

export function bindDiagnosticWidget(
	setWidget: (
		key: string,
		lines: string[] | undefined,
		opts?: { placement?: string },
	) => void,
	projectRoot: string,
): void {
	_setWidget = (lines) =>
		setWidget("pi-lens-diag", lines, { placement: "belowEditor" });
	_projectRoot = projectRoot;
}

export function unbindDiagnosticWidget(): void {
	try {
		_setWidget?.(undefined);
	} catch {}
	_setWidget = null;
	fileEntries.clear();
}

// Called at turn_start — clears the previous turn's entries.
export function clearDiagnosticWidget(): void {
	fileEntries.clear();
	try {
		_setWidget?.(undefined);
	} catch {}
}

export function pushDispatchResult(
	result: DispatchResult,
	filePath: string,
): void {
	if (!_setWidget) return;

	const key = normalizeMapKey(filePath);

	// Determine worst semantic and pick the representative diagnostic.
	let semantic: Semantic;
	let rep: Diagnostic | undefined;
	let extraCount = 0;

	if (result.blockers.length > 0) {
		semantic = "blocking";
		[rep] = result.blockers;
		extraCount = result.blockers.length - 1;
	} else if (result.warnings.length > 0) {
		semantic = "warning";
		[rep] = result.warnings;
		extraCount = result.warnings.length - 1;
	} else if (result.fixed.length > 0) {
		semantic = "fixed";
		[rep] = result.fixed;
		extraCount = result.fixed.length - 1;
	} else {
		// No findings — remove the entry for this file if one existed.
		if (fileEntries.has(key)) {
			fileEntries.delete(key);
			_setWidget(fileEntries.size > 0 ? renderLines() : undefined);
		}
		return;
	}

	const relPath = relativize(rep?.filePath ?? filePath);

	// Delete then re-insert: moves entry to end (most recently edited last).
	fileEntries.delete(key);
	fileEntries.set(key, {
		semantic,
		relPath,
		line: rep?.line,
		column: rep?.column,
		tool: rep?.tool ?? "",
		message: rep?.message ?? "",
		extraCount,
	});

	// Evict oldest entries when over cap.
	while (fileEntries.size > MAX_FILES) {
		const oldest = fileEntries.keys().next().value;
		if (oldest) fileEntries.delete(oldest);
	}

	_setWidget(renderLines());
}

function relativize(fp: string): string {
	try {
		const rel = path.relative(_projectRoot, fp);
		return (rel.startsWith("..") ? path.basename(fp) : rel).replace(/\\/g, "/");
	} catch {
		return path.basename(fp);
	}
}

// ANSI constants
const R   = "\x1b[0m";
const RED = "\x1b[31m";
const YEL = "\x1b[33m";
const GRN = "\x1b[32m";
const CYN = "\x1b[36m";
const GRY = "\x1b[90m";

const SEV: Record<Semantic, { icon: string; color: string }> = {
	blocking: { icon: "●", color: RED },
	warning:  { icon: "▲", color: YEL },
	fixed:    { icon: "✓", color: GRN },
};

function renderLines(): string[] {
	const entries = [...fileEntries.values()];

	const nBlocked = entries.filter((e) => e.semantic === "blocking").length;
	const nWarned  = entries.filter((e) => e.semantic === "warning").length;
	const nFixed   = entries.filter((e) => e.semantic === "fixed").length;

	const parts = [
		nBlocked ? `${RED}${nBlocked} blocked${R}` : "",
		nWarned  ? `${YEL}${nWarned} warned${R}`   : "",
		nFixed   ? `${GRN}${nFixed} fixed${R}`     : "",
	].filter(Boolean).join(`  ${GRY}·${R}  `);

	const lines: string[] = [`${GRY}── pi-lens${R}  ${parts}`];

	for (const e of entries) {
		const { icon, color } = SEV[e.semantic];
		const loc     = e.line ? `:${e.line}${e.column ? `:${e.column}` : ""}` : "";
		// Pad plain strings before applying colour so ANSI codes don't skew width.
		const filePad = `${e.relPath}${loc}`.padEnd(30);
		const toolPad = e.tool.padEnd(14);
		const msg     = e.message.slice(0, 55);
		const extra   = e.extraCount > 0 ? `  ${GRY}+${e.extraCount}${R}` : "";

		lines.push(
			`  ${color}${icon}${R} ${CYN}${filePad}${R}  ${GRY}${toolPad}${R}  ${msg}${extra}`,
		);
	}

	return lines;
}
