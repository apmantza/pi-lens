import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WidgetDiagnostic {
	severity: string;
	semantic?: string;
	message: string;
	line?: number;
	col?: number;
	rule?: string;
	tool?: string;
	uri?: string;
}

/**
 * A diagnostic is "blocking" when pi-lens classifies it as a hard stop
 * (`semantic === "blocking"`). Falls back to severity for sources that
 * don't set `semantic` (raw tsc/eslint diagnostics) so the red dot still
 * fires on traditional compile errors.
 */
function isBlocking(d: WidgetDiagnostic): boolean {
	if (d.semantic === "blocking") return true;
	if (d.semantic == null && d.severity === "error") return true;
	return false;
}

interface FileRecord {
	filePath: string;
	runners: Map<string, { status: string; count: number; durationMs?: number }>;
	formatters: Map<string, { changed: boolean; success: boolean }>;
	diagnostics: WidgetDiagnostic[];
	diagnosticCounts: {
		blocking: number;
		errors: number;
		warnings: number;
	};
	hasFinalDiagnosticsSnapshot: boolean;
	touchedAt: number;
}

interface LspRecord {
	serverId: string;
	root: string;
	status: "spawning" | "ready" | "failed";
	durationMs?: number;
}

// ── Module state ─────────────────────────────────────────────────────────────

const files = new Map<string, FileRecord>();
const lspServers = new Map<string, LspRecord>();
let sessionLanguages: string[] = [];
let requestRenderFn: (() => void) | null = null;

const MAX_STORED_DIAGNOSTICS_PER_FILE = 12;

// ── Public API ────────────────────────────────────────────────────────────────

export function setRenderCallback(fn: () => void): void {
	requestRenderFn = fn;
}

export function clearWidgetState(): void {
	files.clear();
	lspServers.clear();
	sessionLanguages = [];
	requestRenderFn = null;
}

export function setSessionLanguages(langs: string[]): void {
	sessionLanguages = langs;
	requestRender();
}

export function recordFormatter(
	filePath: string,
	formatter: string,
	changed: boolean,
	success: boolean,
): void {
	const rec = getOrCreate(filePath);
	rec.formatters.set(formatter, { changed, success });
	rec.touchedAt = Date.now();
	files.set(filePath, rec);
	requestRender();
}

export function recordRunner(
	filePath: string,
	runnerId: string,
	status: string,
	diagnosticCount: number,
	durationMs?: number,
): void {
	const rec = getOrCreate(filePath);
	rec.runners.set(runnerId, { status, count: diagnosticCount, durationMs });
	rec.hasFinalDiagnosticsSnapshot = false;
	rec.touchedAt = Date.now();
	files.set(filePath, rec);
	requestRender();
}

export function recordDiagnostics(
	filePath: string,
	diagnostics: Array<{
		tool?: string;
		rule?: string;
		id?: string;
		message?: string;
		line?: number;
		column?: number;
		severity?: string;
		semantic?: string;
	}>,
): void {
	const rec = getOrCreate(filePath);
	const base = pathToFileURL(filePath).href;
	const normalized = diagnostics.map((d) => {
		const rule = d.rule ?? d.id;
		const uri =
			d.line != null
				? `${base}#L${d.line}${d.column != null ? `:${d.column}` : ""}`
				: base;
		return {
			severity: d.severity ?? "info",
			semantic: d.semantic,
			message: d.message ?? "",
			line: d.line,
			col: d.column,
			rule,
			tool: d.tool,
			uri,
		} satisfies WidgetDiagnostic;
	});

	let blocking = 0;
	let errors = 0;
	let warnings = 0;
	for (const diagnostic of normalized) {
		if (isBlocking(diagnostic)) blocking++;
		if (diagnostic.severity === "error") errors++;
		else if (diagnostic.severity === "warning") warnings++;
	}

	rec.diagnosticCounts = { blocking, errors, warnings };
	rec.diagnostics = capStoredDiagnostics(normalized);
	rec.hasFinalDiagnosticsSnapshot = true;
	rec.touchedAt = Date.now();
	files.set(filePath, rec);
	requestRender();
}

/** @internal Test-only helpers. Do not use in production code. */
export const __testing = {
	getWidgetStateSnapshot(): {
		files: Array<{
			filePath: string;
			storedDiagnostics: number;
			blocking: number;
			errors: number;
			warnings: number;
		}>;
	} {
		return {
			files: [...files.values()].map((rec) => ({
				filePath: rec.filePath,
				storedDiagnostics: rec.diagnostics.length,
				blocking: rec.diagnosticCounts.blocking,
				errors: rec.diagnosticCounts.errors,
				warnings: rec.diagnosticCounts.warnings,
			})),
		};
	},
};

export function recordLsp(
	serverId: string,
	root: string,
	status: "spawn_start" | "spawn_success" | "spawn_failed" | "unavailable",
	durationMs?: number,
): void {
	const key = `${serverId}@${root}`;
	const mapped =
		status === "spawn_start"
			? "spawning"
			: status === "spawn_success"
				? "ready"
				: "failed";
	lspServers.set(key, { serverId, root, status: mapped, durationMs });
	requestRender();
}

// ── Render ────────────────────────────────────────────────────────────────────

const HORIZONTAL_MIN_WIDTH = 70;

export function renderWidget(
	width: number,
	theme: {
		fg: (color: string, s: string) => string;
	},
): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const red = (s: string) => theme.fg("error", s);
	const yellow = (s: string) => theme.fg("warning", s);
	const green = (s: string) => theme.fg("success", s);
	const cyan = (s: string) => theme.fg("accent", s);
	const w = Math.max(1, width || 80);
	const useHorizontal = w >= HORIZONTAL_MIN_WIDTH;

	if (files.size === 0 && lspServers.size === 0) return [];

	const lines: string[] = [];

	// Header — counts from deduplicated files only
	const deduped = dedupeByBasename([...files.values()]);
	const recencySorted = deduped.filter(shouldRenderFile).slice(0, 5);
	const langStr = sessionLanguages.slice(0, 6).join(" ");
	const totalBlocking = countBlockingIn(deduped);
	const totalErrors = countTotalIn("error", deduped);
	const totalWarnings = countTotalIn("warning", deduped);
	const hasPendingAnalysis = deduped.some(isPendingAnalysis);
	const errorChunk =
		totalErrors > 0
			? (totalBlocking > 0 ? red : yellow)(`●${totalErrors}E`)
			: "";
	const warningChunk = totalWarnings > 0 ? yellow(`!${totalWarnings}W`) : "";
	const summary = errorChunk
		? errorChunk + (warningChunk ? " " + warningChunk : "")
		: warningChunk
			? warningChunk
			: files.size > 0 && !hasPendingAnalysis
				? green("✓ clean")
				: "";

	// LSP spawning — folded into the header in horizontal mode, tail line otherwise
	const spawning = [...lspServers.values()].filter(
		(s) => s.status === "spawning",
	);
	const lspChip =
		useHorizontal && spawning.length > 0 ? "  " + dim("LSP↑") : "";

	const header = ` ${cyan("pi-lens")}${langStr ? "  " + dim(langStr) : ""}${lspChip}${summary ? "  " + summary : ""}`;
	lines.push(fitLine(header, w));

	// File list — display order varies by mode
	if (useHorizontal) {
		const displayOrder = sortByTierThenRecency(recencySorted);
		const rowLine = packHorizontalRow(displayOrder, w, theme);
		if (rowLine.length > 0) lines.push(rowLine);
	} else {
		for (const rec of recencySorted) {
			lines.push(fitLine(formatFileRowVertical(rec, theme), w));
		}
	}

	// Diagnostics — blocking only, from the most recently touched file that has them.
	// Vertical mode keeps the divider/filename context; horizontal already shows the
	// filename on the packed row above, so we drop the extra header noise there.
	const withBlocking = recencySorted.filter((r) =>
		r.diagnostics.some(isBlocking),
	);
	if (withBlocking.length > 0) {
		const rec = withBlocking[0];
		if (!useHorizontal) {
			lines.push(fitLine(dim("─".repeat(Math.min(w, 60))), w));
			lines.push(fitLine(` ${dim(path.basename(rec.filePath))}`, w));
		}
		const blockers = rec.diagnostics.filter(isBlocking).slice(0, 5);
		for (const d of blockers) {
			const loc = d.line != null ? osc8(d.uri ?? "", `L${d.line}`) : "";
			const rule = d.rule ? dim(` ${d.rule}`) : "";
			const prefix = `   ${red("●")} ${loc}${rule}  `;
			const msgWidth = Math.max(1, w - visibleWidth(prefix));
			const msg = fitLine(d.message, msgWidth, "…");
			lines.push(fitLine(`${prefix}${msg}`, w));
		}
	}

	// LSP status tail — only in vertical mode; horizontal folds into header
	if (!useHorizontal && spawning.length > 0) {
		const ids = spawning.map((s) => s.serverId).join(" ");
		lines.push(fitLine(` ${dim(`LSP spawning: ${ids}`)}`, w));
	}

	return lines;
}

// ── File row layout ──────────────────────────────────────────────────────────

type FileTier = "blocking" | "warning" | "clean";

function classifyFileTier(rec: FileRecord): FileTier {
	if (rec.diagnosticCounts.blocking > 0) return "blocking";
	if (rec.diagnosticCounts.errors > 0 || rec.diagnosticCounts.warnings > 0) {
		return "warning";
	}
	return "clean";
}

function sortByTierThenRecency(recs: FileRecord[]): FileRecord[] {
	const order: Record<FileTier, number> = {
		blocking: 0,
		warning: 1,
		clean: 2,
	};
	return [...recs].sort((a, b) => {
		const ta = order[classifyFileTier(a)];
		const tb = order[classifyFileTier(b)];
		if (ta !== tb) return ta - tb;
		return b.touchedAt - a.touchedAt;
	});
}

function formatFileRowVertical(
	rec: FileRecord,
	theme: { fg: (color: string, s: string) => string },
): string {
	const dim = (s: string) => theme.fg("dim", s);
	const red = (s: string) => theme.fg("error", s);
	const yellow = (s: string) => theme.fg("warning", s);
	const green = (s: string) => theme.fg("success", s);

	const base = path.basename(rec.filePath);
	const blocking = rec.diagnosticCounts.blocking;
	const errors = rec.diagnosticCounts.errors;
	const warnings = rec.diagnosticCounts.warnings;
	const dot =
		blocking > 0
			? red("●")
			: warnings > 0 || errors > 0
				? yellow("!")
				: green("✓");
	const runnerNames = [...rec.runners.entries()]
		.filter(([, r]) => r.status !== "skipped")
		.map(([id]) => id)
		.join(" ");
	const counts =
		errors > 0
			? " " +
				(blocking > 0 ? red : yellow)(`${errors}E`) +
				(warnings > 0 ? " " + yellow(`${warnings}W`) : "")
			: warnings > 0
				? " " + yellow(`${warnings}W`)
				: " " + dim("clean");
	const changedFormatters = [...rec.formatters.entries()]
		.filter(([, f]) => f.changed)
		.map(([name]) => name);
	const formatMark =
		changedFormatters.length > 0
			? dim(` fmt:${changedFormatters.join(",")}`)
			: "";
	return ` ${dot} ${base}  ${dim(runnerNames)}${formatMark}${counts}`;
}

function packHorizontalRow(
	recs: FileRecord[],
	totalWidth: number,
	theme: { fg: (color: string, s: string) => string },
): string {
	if (recs.length === 0) return "";
	const dim = (s: string) => theme.fg("dim", s);
	const indent = "   ";
	const sep = "  ";
	// Reserve worst-case overflow space upfront so the marker always fits.
	// " +NN" — 4 visible chars covers up to two-digit overflow.
	const overflowReserve = 4;
	let used = visibleWidth(indent);
	const parts: string[] = [indent];
	const addedTokenWidths: number[] = [];
	let droppedAt = -1;
	for (let i = 0; i < recs.length; i++) {
		const sepWidth = parts.length > 1 ? visibleWidth(sep) : 0;
		const willOverflow = i < recs.length - 1;
		const reserve = willOverflow ? overflowReserve : 0;
		const remaining = totalWidth - used - sepWidth - reserve;
		if (remaining < 4) {
			droppedAt = i;
			break;
		}
		const token = formatFileTokenHorizontal(recs[i], remaining, theme);
		const tokenWidth = visibleWidth(token);
		if (token.length === 0 || used + sepWidth + tokenWidth > totalWidth) {
			droppedAt = i;
			break;
		}
		if (sepWidth > 0) {
			parts.push(sep);
			used += sepWidth;
		}
		parts.push(token);
		used += tokenWidth;
		addedTokenWidths.push(tokenWidth + sepWidth);
	}
	if (droppedAt >= 0) {
		let dropped = recs.length - droppedAt;
		let overflow = " " + dim(`+${dropped}`);
		// If reservation was insufficient (e.g. last token grew because no
		// reserve was applied), shed accepted tokens until overflow fits.
		while (
			used + visibleWidth(overflow) > totalWidth &&
			addedTokenWidths.length > 0
		) {
			const lastWidth = addedTokenWidths.pop() as number;
			used -= lastWidth;
			parts.pop(); // token
			if (parts.length > 1) parts.pop(); // preceding separator
			dropped++;
			overflow = " " + dim(`+${dropped}`);
		}
		if (used + visibleWidth(overflow) <= totalWidth) {
			parts.push(overflow);
		}
	}
	return fitLine(parts.join(""), totalWidth);
}

function formatFileTokenHorizontal(
	rec: FileRecord,
	remainingWidth: number,
	theme: { fg: (color: string, s: string) => string },
): string {
	const dim = (s: string) => theme.fg("dim", s);
	const red = (s: string) => theme.fg("error", s);
	const yellow = (s: string) => theme.fg("warning", s);

	const blocking = rec.diagnosticCounts.blocking;
	const errors = rec.diagnosticCounts.errors;
	const warnings = rec.diagnosticCounts.warnings;
	const formatterChanged = hasChangedFormatter(rec);

	let dotChar: string;
	if (blocking > 0) dotChar = red("●");
	else if (errors > 0 || warnings > 0) dotChar = yellow("!");
	else if (formatterChanged) dotChar = dim("✎");
	else dotChar = dim("·");

	let countsStyled = "";
	if (errors > 0 && warnings > 0) {
		const eColor = blocking > 0 ? red : yellow;
		countsStyled = " " + eColor(`${errors}E`) + yellow(`${warnings}W`);
	} else if (errors > 0) {
		const eColor = blocking > 0 ? red : yellow;
		countsStyled = " " + eColor(`${errors}E`);
	} else if (warnings > 0) {
		countsStyled = " " + yellow(`${warnings}W`);
	}

	const fullBasename = path.basename(rec.filePath);
	const fixedWidth = visibleWidth(dotChar) + 1 + visibleWidth(countsStyled);
	const basenameBudget = remainingWidth - fixedWidth;
	if (basenameBudget < 3) return "";
	const truncated = truncateBasename(fullBasename, basenameBudget);
	const linked = osc8(pathToFileURL(rec.filePath).href, truncated);
	return `${dotChar} ${linked}${countsStyled}`;
}

function truncateBasename(name: string, maxWidth: number): string {
	if (visibleWidth(name) <= maxWidth) return name;
	if (maxWidth < 2) return "…";
	const ext = path.extname(name);
	const stem = name.slice(0, name.length - ext.length);
	const keep = maxWidth - ext.length - 1;
	if (keep < 1) {
		// Extension alone wouldn't fit; truncate the whole name.
		return name.slice(0, maxWidth - 1) + "…";
	}
	return stem.slice(0, keep) + "…" + ext;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getOrCreate(filePath: string): FileRecord {
	return (
		files.get(filePath) ?? {
			filePath,
			runners: new Map(),
			formatters: new Map(),
			diagnostics: [],
			diagnosticCounts: { blocking: 0, errors: 0, warnings: 0 },
			hasFinalDiagnosticsSnapshot: false,
			touchedAt: Date.now(),
		}
	);
}

function hasChangedFormatter(rec: FileRecord): boolean {
	return [...rec.formatters.values()].some((f) => f.changed);
}

function shouldRenderFile(rec: FileRecord): boolean {
	return rec.hasFinalDiagnosticsSnapshot || hasChangedFormatter(rec);
}

function isPendingAnalysis(rec: FileRecord): boolean {
	return rec.runners.size > 0 && !rec.hasFinalDiagnosticsSnapshot;
}

function capStoredDiagnostics(
	diagnostics: WidgetDiagnostic[],
): WidgetDiagnostic[] {
	if (diagnostics.length <= MAX_STORED_DIAGNOSTICS_PER_FILE) return diagnostics;
	const blockers = diagnostics.filter(isBlocking);
	if (blockers.length >= MAX_STORED_DIAGNOSTICS_PER_FILE) {
		return blockers.slice(0, MAX_STORED_DIAGNOSTICS_PER_FILE);
	}
	const rest = diagnostics.filter((d) => !isBlocking(d));
	return [
		...blockers,
		...rest.slice(0, MAX_STORED_DIAGNOSTICS_PER_FILE - blockers.length),
	];
}

function countTotalIn(
	severity: "error" | "warning",
	recs: FileRecord[],
): number {
	let n = 0;
	for (const rec of recs) {
		if (severity === "error") n += rec.diagnosticCounts.errors;
		else n += rec.diagnosticCounts.warnings;
	}
	return n;
}

function countBlockingIn(recs: FileRecord[]): number {
	let n = 0;
	for (const rec of recs) n += rec.diagnosticCounts.blocking;
	return n;
}

function requestRender(): void {
	requestRenderFn?.();
}

function osc8(uri: string, label: string): string {
	if (!uri) return label;
	return `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
}

function fitLine(s: string, maxWidth: number, ellipsis = "..."): string {
	return truncateToWidth(s, Math.max(0, maxWidth), ellipsis);
}

function dedupeByBasename(recs: FileRecord[]): FileRecord[] {
	const seen = new Map<string, FileRecord>();
	for (const r of [...recs].sort((a, b) => a.touchedAt - b.touchedAt)) {
		seen.set(path.basename(r.filePath), r);
	}
	return [...seen.values()].sort((a, b) => b.touchedAt - a.touchedAt);
}
