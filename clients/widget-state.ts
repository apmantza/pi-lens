import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WidgetDiagnostic {
	severity: string;
	message: string;
	line?: number;
	col?: number;
	rule?: string;
	tool?: string;
	uri?: string;
}

interface FileRecord {
	filePath: string;
	runners: Map<string, { status: string; count: number; durationMs?: number }>;
	formatters: Map<string, { changed: boolean; success: boolean }>;
	diagnostics: WidgetDiagnostic[];
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

// ── Public API ────────────────────────────────────────────────────────────────

export function setRenderCallback(fn: () => void): void {
	requestRenderFn = fn;
}

export function clearWidgetState(): void {
	files.clear();
	lspServers.clear();
	sessionLanguages = [];
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
	}>,
): void {
	const rec = getOrCreate(filePath);
	const base = pathToFileURL(filePath).href;
	rec.diagnostics = diagnostics.map((d) => {
		const rule = d.rule ?? d.id;
		const uri =
			d.line != null
				? `${base}#L${d.line}${d.column != null ? `:${d.column}` : ""}`
				: base;
		return {
			severity: d.severity ?? "info",
			message: d.message ?? "",
			line: d.line,
			col: d.column,
			rule,
			tool: d.tool,
			uri,
		};
	});
	rec.touchedAt = Date.now();
	files.set(filePath, rec);
	requestRender();
}

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

	if (files.size === 0 && lspServers.size === 0) return [];

	const lines: string[] = [];

	// Header — counts from deduplicated files only
	const deduped = dedupeByBasename([...files.values()]);
	const sorted = deduped.slice(0, 5);
	const langStr = sessionLanguages.slice(0, 6).join(" ");
	const totalErrors = countTotalIn("error", deduped);
	const totalWarnings = countTotalIn("warning", deduped);
	const summary =
		totalErrors > 0
			? red(`●${totalErrors}E`) +
				(totalWarnings > 0 ? " " + yellow(`▲${totalWarnings}W`) : "")
			: totalWarnings > 0
				? yellow(`▲${totalWarnings}W`)
				: files.size > 0
					? green("✓ clean")
					: "";
	const header = ` ${cyan("pi-lens")}${langStr ? "  " + dim(langStr) : ""}${summary ? "  " + summary : ""}`;
	lines.push(fitLine(header, w));

	// File list — most recently touched first, dedup by basename (last wins), cap at 5
	for (const rec of sorted) {
		const base = path.basename(rec.filePath);
		const errors = rec.diagnostics.filter((d) => d.severity === "error").length;
		const warnings = rec.diagnostics.filter(
			(d) => d.severity === "warning",
		).length;
		const dot = errors > 0 ? red("●") : warnings > 0 ? yellow("▲") : green("✓");
		const runnerNames = [...rec.runners.entries()]
			.filter(([, r]) => r.status !== "skipped")
			.map(([id]) => id)
			.join(" ");
		const counts =
			errors > 0
				? " " +
					red(`${errors}E`) +
					(warnings > 0 ? " " + yellow(`${warnings}W`) : "")
				: warnings > 0
					? " " + yellow(`${warnings}W`)
					: " " + dim("clean");
		const formatMark = [...rec.formatters.values()].some((f) => f.changed)
			? dim(" fmt")
			: "";
		const row = ` ${dot} ${base}  ${dim(runnerNames)}${formatMark}${counts}`;
		lines.push(fitLine(row, w));
	}

	// Diagnostics — errors from the most recently touched file that has them
	const withErrors = sorted.filter((r) =>
		r.diagnostics.some((d) => d.severity === "error"),
	);
	if (withErrors.length > 0) {
		const rec = withErrors[0];
		lines.push(fitLine(dim("─".repeat(Math.min(w, 60))), w));
		lines.push(fitLine(` ${dim(path.basename(rec.filePath))}`, w));
		const errors = rec.diagnostics
			.filter((d) => d.severity === "error")
			.slice(0, 5);
		const warnings =
			errors.length < 5
				? rec.diagnostics
						.filter((d) => d.severity === "warning")
						.slice(0, 5 - errors.length)
				: [];
		for (const d of [...errors, ...warnings]) {
			const sev = d.severity === "error" ? red("●") : yellow("▲");
			const loc = d.line != null ? osc8(d.uri ?? "", `L${d.line}`) : "";
			const rule = d.rule ? dim(` ${d.rule}`) : "";
			const prefix = `   ${sev} ${loc}${rule}  `;
			const msgWidth = Math.max(1, w - visibleWidth(prefix));
			const msg = fitLine(d.message, msgWidth, "…");
			lines.push(fitLine(`${prefix}${msg}`, w));
		}
	}

	// LSP status — only spawning servers (ready ones are quiet)
	const spawning = [...lspServers.values()].filter(
		(s) => s.status === "spawning",
	);
	if (spawning.length > 0) {
		const ids = spawning.map((s) => s.serverId).join(" ");
		lines.push(fitLine(` ${dim(`LSP spawning: ${ids}`)}`, w));
	}

	return lines;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getOrCreate(filePath: string): FileRecord {
	return (
		files.get(filePath) ?? {
			filePath,
			runners: new Map(),
			formatters: new Map(),
			diagnostics: [],
			touchedAt: Date.now(),
		}
	);
}

function countTotalIn(severity: string, recs: FileRecord[]): number {
	let n = 0;
	for (const rec of recs)
		n += rec.diagnostics.filter((d) => d.severity === severity).length;
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
