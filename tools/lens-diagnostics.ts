/**
 * lens_diagnostics tool — cached project diagnostic state (issue #159).
 *
 * Three modes:
 *   delta (default) — fixable warnings from the current agent turn, read from
 *                     the actionable-warnings and code-quality-warnings caches.
 *   all             — all known diagnostic counts across every file pi-lens has
 *                     seen this session, read from the widget state.
 *   full            — active project-wide LSP diagnostic scan merged with all.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Type } from "../clients/deps/typebox.js";
import { applyInlineSuppressions } from "../clients/dispatch/inline-suppressions.js";
import { compactRenderResult } from "./render-compact.js";
import { combineAbortSignals } from "../clients/deadline-utils.js";
import { getProjectIgnoreMatcher } from "../clients/file-utils.js";
import { getLSPService } from "../clients/lsp/index.js";
import type { LSPDiagnostic } from "../clients/lsp/client.js";
import type { CacheManager } from "../clients/cache-manager.js";
import {
	loadProjectDiagnosticsDeltaReport,
	loadProjectDiagnosticsSnapshot,
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	reconcileProjectDiagnosticsSnapshot,
} from "../clients/project-diagnostics/cache.js";
import { extractCachedProjectDiagnostics } from "../clients/project-diagnostics/extractors.js";
import { scanProjectDiagnostics } from "../clients/project-diagnostics/scanner.js";
import type {
	ProjectDiagnostic,
	ProjectDiagnosticsDeltaReport,
	ProjectDiagnosticsSnapshot,
} from "../clients/project-diagnostics/types.js";
import type { ActionableWarningsReport } from "../clients/actionable-warnings.js";
import type { CodeQualityWarningsReport } from "../clients/code-quality-warnings.js";
import {
	getFileDiagnosticSummaries,
	type FileDiagnosticSummary,
	reconcileStaleWidgetFiles,
	type WidgetDiagnostic,
} from "../clients/widget-state.js";
import { makeProgressReporter, scanningSummaryLine } from "./scan-progress.js";

// The widget state exposes the full per-file diagnostic set; this is the tool's
// own generous display budget per file (independent of the TUI's 12 cap), to
// keep output bounded on a pathologically broken file.
const MAX_DIAGNOSTICS_PER_FILE = 50;

type LSPServiceLike = ReturnType<typeof getLSPService> & {
	runWorkspaceDiagnostics?: (
		cwd: string,
		options?: {
			maxFiles?: number;
			signal?: AbortSignal;
			onProgress?: (completed: number, total: number) => void;
		},
	) => Promise<WorkspaceLspDiagnosticResult[]>;
};


type WorkspaceLspDiagnosticResult = {
	filePath: string;
	diagnostics: LSPDiagnostic[];
	count?: number;
};

// Wall-clock ceiling for the whole mode=full scan. Even with per-file budgets
// and abort-signal honoring, a pathological state (a language server hanging on
// spawn/initialize across many files) could otherwise stall the tool
// indefinitely — an unattended session was observed hung for ~8h. This hard cap
// aborts the scan so it always returns (partial) rather than never. Env-tunable.
const FULL_SCAN_WALL_CLOCK_MS = (() => {
	const raw = Number(process.env.PI_LENS_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 300_000; // 5 min default
})();

export function createLensDiagnosticsTool(
	cacheManager: CacheManager,
	getCwd: () => string,
	getLspService: () => LSPServiceLike = getLSPService,
	// Flush any debounced per-edit dispatches before reading, so files the agent
	// fixed earlier in the turn are re-dispatched and the widget reflects the
	// CURRENT state — not the pre-fix diagnostics still pending in the debounce
	// window. Injected (index wires `flushDebouncedToolResults`); optional so the
	// tool stays decoupled and testable.
	flushPending: () => Promise<void> = async () => {},
) {
	return {
		name: "lens_diagnostics" as const,
		label: "Project Diagnostics",
		description:
			"Query pi-lens's diagnostic state. mode=delta/all are cache-only and instant; " +
			"mode=full is an expensive active project-wide LSP scan merged with cached runner state.\n\n" +
			"IMPORTANT: unlike lsp_diagnostics (LSP only), this tool covers ALL dispatch " +
			"runners: LSP errors, tree-sitter structural rules, ast-grep security rules, " +
			"biome/ruff/eslint lint findings, complexity violations, and more.\n\n" +
			"mode=delta (default): all warnings for the current agent turn — fixable warnings " +
			"(actionable-warnings cache) AND code quality/style/complexity issues " +
			"(code-quality-warnings cache). Same scope as the turn-end advisory, current turn only.\n\n" +
			"mode=all: blocking errors and warnings — with the actual messages (line, rule, " +
			"text), not just counts — for every file the agent has " +
			"EDITED this session (files that went through the dispatch pipeline). " +
			"NOTE: unedited files with pre-existing errors do NOT appear here — this is " +
			"not a full project scan. Use before declaring work done; stale blocking " +
			"errors from earlier turns are visible even if they dropped from turn-end context.\n\n" +
			"mode=full: EXPENSIVE active scan. Runs project-wide LSP diagnostics for " +
			"all supported files (including unedited files), then merges/deduplicates " +
			"that with mode=all cached runner state. Optional refreshRunners=cheap/all/cached " +
			"folds in project-wide runner findings: the in-process scanners (tree-sitter + " +
			"fact-rules + ast-grep) plus the CACHED heavyweight analyzers jscpd (copy-paste) " +
			"and madge (circular deps) — read from the session-start/turn-end caches, never " +
			"re-launched here.",
		promptSnippet:
			"Use lens_diagnostics mode=all to verify no blocking errors remain; use mode=full for expensive project-wide checks",
		renderResult: compactRenderResult<{
			mode?: string;
			phase?: string;
			completed?: number;
			total?: number;
			actionableWarnings?: number;
			qualityIssues?: number;
			projectDiagnostics?: number;
			filesWithIssues?: number;
			filesChecked?: number;
			totalBlocking?: number;
			totalErrors?: number;
			totalWarnings?: number;
		}>(({ details, args, isError, text }) => {
			// Streaming progress partials render the live bar (see scanningSummaryLine)
			// instead of the details-driven summary, which would show "0 diagnostics"
			// mid-scan.
			const scanning = scanningSummaryLine(details, text);
			if (scanning) return scanning;
			const mode =
				details?.mode ?? (typeof args.mode === "string" ? args.mode : "delta");
			if (isError) {
				return `lens_diagnostics ${mode} — ${text.split("\n")[0] ?? "error"}`;
			}
			if (mode === "delta") {
				const aw = details?.actionableWarnings ?? 0;
				const cq = details?.qualityIssues ?? 0;
				const pd = details?.projectDiagnostics ?? 0;
				if (aw + cq + pd === 0) return `lens_diagnostics delta — clean`;
				return `lens_diagnostics delta — ${aw} actionable · ${cq} quality · ${pd} project`;
			}
			const b = details?.totalBlocking ?? 0;
			const e = details?.totalErrors ?? 0;
			const w = details?.totalWarnings ?? 0;
			const files = details?.filesWithIssues ?? details?.filesChecked ?? 0;
			if (b + e + w === 0) {
				return `lens_diagnostics ${mode} — clean (${files} files)`;
			}
			return `lens_diagnostics ${mode} — ${b} blocking · ${e} errors · ${w} warnings (${files} files)`;
		}),
		parameters: Type.Object({
			mode: Type.Optional(
				Type.String({
					enum: ["delta", "all", "full"],
					description:
						"delta = current turn's fixable warnings (default). " +
						"all = session diagnostics for edited/dispatched files. " +
						"full = expensive active project-wide LSP scan plus cached runner diagnostics.",
				}),
			),
			refreshRunners: Type.Optional(
				Type.Union(
					[
						Type.Boolean(),
						Type.String({ enum: ["cached", "cheap", "all", "none"] }),
					],
					{
						description:
							"mode=full only: false/none = LSP + widget state only. cached = include cached project-runner snapshot + cached jscpd/madge findings. cheap = refresh the in-process runners (tree-sitter + fact-rules + ast-grep) first, plus cached jscpd/madge. all = same as cheap (jscpd/madge are always read from cache, never re-launched here).",
					},
				),
			),
			maxProjectFiles: Type.Optional(
				Type.Number({
					description:
						"mode=full refreshRunners=cheap/all only: cap project files scanned by the cheap project runners (tree-sitter + fact-rules + ast-grep). Does NOT bound the LSP sweep — use maxLspFiles for that.",
				}),
			),
			maxLspFiles: Type.Optional(
				Type.Number({
					description:
						"mode=full only: cap the number of files routed through the language server for the project-wide LSP sweep. On large projects (e.g. a Next.js app with thousands of source files) the uncapped sweep can take many minutes; set this to bound it. Default is generous (env PI_LENS_LSP_WORKSPACE_MAX_FILES, else 5000).",
				}),
			),
			severity: Type.Optional(
				Type.String({
					enum: ["error", "warning", "all"],
					description: "Filter by severity (default: all).",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: { cwd?: string; signal?: AbortSignal },
		) {
			const mode = (params.mode as string | undefined) ?? "delta";
			const severity = (params.severity as string | undefined) ?? "all";
			const refreshRunners = params.refreshRunners;
			const parsePositiveInt = (value: unknown): number | undefined =>
				typeof value === "number" && Number.isFinite(value) && value > 0
					? Math.floor(value)
					: undefined;
			const maxProjectFiles = parsePositiveInt(params.maxProjectFiles);
			const maxLspFiles = parsePositiveInt(params.maxLspFiles);
			const cwd = ctx.cwd ?? getCwd();

			// Escape aborts the agent *turn*, which fires ctx.signal (the turn-wired
			// abort); the positional signal is the tool-call signal. A registered
			// extension tool only reliably sees the turn abort via ctx.signal, so honor
			// BOTH — else a long mode=full scan ignores Escape (the reported bug).
			const abortSignal = combineAbortSignals(signal, ctx.signal);

			// Reflect the agent's just-made fixes before reporting: flush pending
			// per-edit dispatches (re-records fixed files), then drop entries whose
			// file changed on disk afterwards / was deleted (stale, e.g. external
			// edits). Together these stop fixed-this-session findings from lingering.
			await flushPending();
			const staleDropped = await reconcileStaleWidgetFiles();

			if (mode === "all") {
				return formatAllMode(cwd, severity, undefined, undefined, staleDropped);
			}
			if (mode === "full") {
				// Fold a hard wall-clock ceiling into the abort signal so the scan
				// always terminates (partial) even if a hung server would otherwise
				// stall it forever. AbortSignal.timeout aborts with a TimeoutError.
				const ceiling = AbortSignal.timeout(FULL_SCAN_WALL_CLOCK_MS);
				const fullSignal = combineAbortSignals(abortSignal, ceiling);
				// Stream a throttled progress bar: the full scan is opaque for minutes
				// otherwise.
				const onProgress = makeProgressReporter(onUpdate);
				return formatFullMode(cwd, severity, getLspService(), cacheManager, {
					refreshRunners,
					maxProjectFiles,
					maxLspFiles,
					signal: fullSignal,
					wallClockMs: FULL_SCAN_WALL_CLOCK_MS,
					onProgress,
				});
			}
			return formatDeltaMode(cacheManager, cwd, severity);
		},
	};
}

// ── delta mode ────────────────────────────────────────────────────────────────

function formatProjectDeltaDiagnostic(diagnostic: ProjectDiagnostic): string {
	const marker =
		diagnostic.semantic === "blocking" || diagnostic.severity === "error"
			? "🔴"
			: "ℹ";
	const rule = diagnostic.rule ?? diagnostic.code ?? diagnostic.runner;
	return `  ${marker} L${diagnostic.line ?? "?"}  ${rule}  ${diagnostic.message}`;
}

function appendProjectDiagnosticsDeltaLines(
	lines: string[],
	cwd: string,
	report: ProjectDiagnosticsDeltaReport | undefined,
	severity: string,
	includeFile: (filePath: string) => boolean,
): number {
	const diagnostics = (report?.diagnostics ?? []).filter(
		(diagnostic) =>
			includeFile(diagnostic.filePath) &&
			matchesSeverity(projectDiagnosticToWidget(diagnostic), severity),
	);
	const byFile = new Map<string, ProjectDiagnostic[]>();
	for (const diagnostic of diagnostics) {
		const filePath = path.resolve(diagnostic.filePath);
		const bucket = byFile.get(filePath) ?? [];
		bucket.push(diagnostic);
		byFile.set(filePath, bucket);
	}
	for (const [filePath, fileDiagnostics] of byFile) {
		const rel = path.relative(cwd, filePath);
		if (!lines.includes(rel)) lines.push(rel);
		for (const diagnostic of fileDiagnostics) {
			lines.push(formatProjectDeltaDiagnostic(diagnostic));
		}
	}
	return diagnostics.length;
}

function formatDeltaMode(
	cacheManager: CacheManager,
	cwd: string,
	severity: string,
): { content: [{ type: "text"; text: string }]; details: object } {
	const actionableEntry = cacheManager.readCache<ActionableWarningsReport>(
		"actionable-warnings",
		cwd,
	);
	const qualityEntry = cacheManager.readCache<CodeQualityWarningsReport>(
		"code-quality-warnings",
		cwd,
	);
	const actionable = actionableEntry?.data;
	const quality = qualityEntry?.data;
	const projectDelta = loadProjectDiagnosticsDeltaReport(cwd);
	const includeFile = createCurrentIgnoreFilter(cwd);
	const actionableFiles = (actionable?.files ?? []).filter((file) =>
		includeFile(file.filePath),
	);
	const qualityFiles = (quality?.files ?? []).filter((file) =>
		includeFile(file.filePath),
	);

	const lines: string[] = [];

	// Fixable warnings from actionable-warnings
	if (actionableFiles.length > 0 && severity !== "error") {
		for (const file of actionableFiles) {
			const rel = path.relative(cwd, file.filePath);
			lines.push(`${rel}`);
			for (const w of file.warnings ?? []) {
				lines.push(
					`  ⚠ L${w.line ?? "?"}  ${w.rule ?? w.code ?? w.tool}  ${w.message}`,
				);
			}
		}
	}

	// Quality issues
	if (qualityFiles.length > 0 && severity !== "error") {
		for (const file of qualityFiles) {
			const rel = path.relative(cwd, file.filePath);
			if (!lines.includes(rel)) lines.push(rel);
			for (const w of file.warnings ?? []) {
				lines.push(
					`  ℹ L${w.line ?? "?"}  ${w.rule ?? w.code ?? w.tool}  ${w.message}`,
				);
			}
		}
	}

	const projectDeltaCount = appendProjectDiagnosticsDeltaLines(
		lines,
		cwd,
		projectDelta,
		severity,
		includeFile,
	);

	const aw = actionableFiles.reduce(
		(count, file) => count + (file.warnings?.length ?? 0),
		0,
	);
	const cq = qualityFiles.reduce(
		(count, file) => count + (file.warnings?.length ?? 0),
		0,
	);

	if (lines.length === 0) {
		let text = `No ${severity === "all" ? "" : severity + " "}issues in the current turn delta.`;
		// Discoverability (#190): `delta` is current-turn-scoped, so it's empty
		// right after a resume even when prior findings were rehydrated into the
		// session-wide view. Point the agent at `mode=all` when that's the case.
		const carried = getFileDiagnosticSummaries().filter(
			(f) => includeFile(f.filePath) && f.diagnostics.length > 0,
		);
		const carriedIssues = carried.reduce((n, f) => n + f.diagnostics.length, 0);
		if (carried.length > 0) {
			text += ` ${carriedIssues} finding${carriedIssues === 1 ? "" : "s"} across ${carried.length} file${carried.length === 1 ? "" : "s"} carried over from earlier this session — use mode=all to see them.`;
		}
		return {
			content: [{ type: "text" as const, text }],
			details: { mode: "delta", warnings: 0, carriedOverFiles: carried.length },
		};
	}

	const summary = `\nSummary (turn delta): ${aw} actionable warning${aw === 1 ? "" : "s"} · ${cq} quality issue${cq === 1 ? "" : "s"} · ${projectDeltaCount} project diagnostic${projectDeltaCount === 1 ? "" : "s"}`;
	return {
		content: [{ type: "text" as const, text: lines.join("\n") + summary }],
		details: {
			mode: "delta",
			actionableWarnings: aw,
			qualityIssues: cq,
			projectDiagnostics: projectDeltaCount,
		},
	};
}

// ── all mode ──────────────────────────────────────────────────────────────────

function createCurrentIgnoreFilter(cwd: string): (filePath: string) => boolean {
	try {
		const matcher = getProjectIgnoreMatcher(cwd);
		return (filePath: string) =>
			!matcher.isIgnored(path.resolve(filePath), false);
	} catch {
		// Diagnostics should remain available even if an ignore config/root probe is
		// temporarily unreadable. Walkers already treat config load failures as
		// non-fatal; match that behavior for cached diagnostic presentation.
		return () => true;
	}
}

function filterProjectDiagnosticsSnapshot(
	snapshot: ProjectDiagnosticsSnapshot | undefined,
	includeFile: (filePath: string) => boolean,
): ProjectDiagnosticsSnapshot | undefined {
	if (!snapshot) return undefined;
	return {
		...snapshot,
		diagnostics: snapshot.diagnostics.filter((d) => includeFile(d.filePath)),
	};
}

function filterProjectDiagnosticsDeltaReport(
	report: ProjectDiagnosticsDeltaReport | undefined,
	includeFile: (filePath: string) => boolean,
): ProjectDiagnosticsDeltaReport | undefined {
	if (!report) return undefined;
	return {
		...report,
		diagnostics: report.diagnostics.filter((d) => includeFile(d.filePath)),
	};
}

/** A diagnostic counts as error-like when it blocks or has error severity. */
function isErrorLike(d: WidgetDiagnostic): boolean {
	return d.semantic === "blocking" || d.severity === "error";
}

function matchesSeverity(d: WidgetDiagnostic, severity: string): boolean {
	if (severity === "error") return isErrorLike(d);
	if (severity === "warning") return !isErrorLike(d);
	return true;
}

/** Most-important first: blocking → error → warning/other, then by line. */
function severityRank(d: WidgetDiagnostic): number {
	if (d.semantic === "blocking") return 0;
	if (d.severity === "error") return 1;
	if (d.severity === "warning") return 2;
	return 3;
}

function bySeverityThenLine(a: WidgetDiagnostic, b: WidgetDiagnostic): number {
	return severityRank(a) - severityRank(b) || (a.line ?? 0) - (b.line ?? 0);
}

function lspSeverityName(severity: LSPDiagnostic["severity"]): string {
	if (severity === 1) return "error";
	if (severity === 2) return "warning";
	if (severity === 3) return "info";
	return "hint";
}

function lspRuleId(diagnostic: LSPDiagnostic): string {
	const code =
		diagnostic.code === undefined ? undefined : String(diagnostic.code);
	if (diagnostic.source && code) return `${diagnostic.source}:${code}`;
	return diagnostic.source ?? code ?? "lsp";
}

function lspDiagnosticToWidget(diagnostic: LSPDiagnostic): WidgetDiagnostic {
	const severity = lspSeverityName(diagnostic.severity);
	const rule = lspRuleId(diagnostic);
	return {
		severity,
		semantic: diagnostic.severity === 1 ? "blocking" : "warning",
		message: diagnostic.message,
		line: diagnostic.range.start.line + 1,
		col: diagnostic.range.start.character + 1,
		rule,
		tool: "lsp",
	};
}

function projectDiagnosticToWidget(
	diagnostic: ProjectDiagnostic,
): WidgetDiagnostic {
	return {
		severity: diagnostic.severity,
		semantic: diagnostic.semantic,
		message: diagnostic.message,
		line: diagnostic.line,
		col: diagnostic.column,
		rule: diagnostic.rule ?? diagnostic.code,
		tool: diagnostic.runner || diagnostic.tool,
	};
}

// The ast-grep LSP keys its diagnostics `rule = "ast-grep:<id>"` (source:code,
// lsp-diagnostics.ts), while the napi runner — per-edit AND the project scan
// (#308) — emits the bare `<id>`. Both run the same shipped ruleset, so the same
// violation must collapse to one finding in mode=full's merge regardless of which
// engine produced it. Strip the `ast-grep:` source prefix and the `-js` language
// suffix (the napi runner already treats `<id>` / `<id>-js` as one rule) so the
// LSP sweep and the napi scan don't double-report the same line.
function normalizeRuleForDedup(ruleId: string): string {
	return ruleId.replace(/^ast-grep:/, "").replace(/-js$/, "");
}

function diagnosticDedupKey(
	filePath: string,
	diagnostic: WidgetDiagnostic,
): string {
	const ruleId = normalizeRuleForDedup(diagnostic.rule ?? diagnostic.tool ?? "");
	return [path.resolve(filePath), diagnostic.line ?? "?", ruleId].join(":");
}

function summarizeDiagnostics(
	filePath: string,
	diagnostics: WidgetDiagnostic[],
	hasFinalSnapshot: boolean,
): FileDiagnosticSummary {
	let blocking = 0;
	let errors = 0;
	let warnings = 0;
	for (const diagnostic of diagnostics) {
		if (diagnostic.semantic === "blocking") blocking++;
		if (diagnostic.severity === "error") errors++;
		else if (diagnostic.severity === "warning") warnings++;
	}
	return {
		filePath,
		blocking,
		errors,
		warnings,
		hasFinalSnapshot,
		diagnostics,
	};
}

function mergeDiagnosticsWithWidgetSummaries(
	widgetSummaries: FileDiagnosticSummary[],
	lspResults: WorkspaceLspDiagnosticResult[],
	projectSnapshot?: ProjectDiagnosticsSnapshot,
	projectDelta?: ProjectDiagnosticsDeltaReport,
): FileDiagnosticSummary[] {
	const byFile = new Map<string, FileDiagnosticSummary>();
	const seen = new Set<string>();

	for (const summary of widgetSummaries) {
		const filePath = path.resolve(summary.filePath);
		const diagnostics = (summary.diagnostics ?? []).map((d) => ({ ...d }));
		byFile.set(filePath, { ...summary, filePath, diagnostics });
		for (const diagnostic of diagnostics) {
			seen.add(diagnosticDedupKey(filePath, diagnostic));
		}
	}

	const addDiagnostic = (
		filePath: string,
		widgetDiagnostic: WidgetDiagnostic,
	) => {
		const existing = byFile.get(filePath);
		const diagnostics = existing ? [...existing.diagnostics] : [];
		const key = diagnosticDedupKey(filePath, widgetDiagnostic);
		if (seen.has(key)) return;
		seen.add(key);
		diagnostics.push(widgetDiagnostic);
		byFile.set(
			filePath,
			summarizeDiagnostics(
				filePath,
				diagnostics,
				existing?.hasFinalSnapshot ?? true,
			),
		);
	};

	for (const result of lspResults) {
		const filePath = path.resolve(result.filePath);
		for (const diagnostic of result.diagnostics ?? []) {
			addDiagnostic(filePath, lspDiagnosticToWidget(diagnostic));
		}
	}

	for (const diagnostic of projectSnapshot?.diagnostics ?? []) {
		addDiagnostic(
			path.resolve(diagnostic.filePath),
			projectDiagnosticToWidget(diagnostic),
		);
	}
	for (const diagnostic of projectDelta?.diagnostics ?? []) {
		addDiagnostic(
			path.resolve(diagnostic.filePath),
			projectDiagnosticToWidget(diagnostic),
		);
	}

	return [...byFile.values()];
}

/**
 * Apply inline `pi-lens-ignore` suppression to the merged mode=full summaries so
 * the project-wide sweep honors the same comments as the per-edit path (#442) —
 * without it, a site cleanly suppressed in mode=all reappears as blocking here.
 * Reads each flagged file once (bounded to files that actually have diagnostics);
 * a read failure is fail-safe (keep the diagnostics rather than hide a finding on
 * an I/O error). Re-summarizes so the blocking/error/warning counts reflect the
 * suppression.
 */
async function applyInlineSuppressionsToSummaries(
	summaries: FileDiagnosticSummary[],
): Promise<FileDiagnosticSummary[]> {
	return Promise.all(
		summaries.map(async (summary) => {
			if (!summary.diagnostics.length) return summary;
			let content: string;
			try {
				content = await fs.readFile(summary.filePath, "utf8");
			} catch {
				return summary; // never hide a finding on a read error
			}
			const kept = applyInlineSuppressions(summary.diagnostics, content);
			if (kept.length === summary.diagnostics.length) return summary;
			return summarizeDiagnostics(
				summary.filePath,
				kept,
				summary.hasFinalSnapshot,
			);
		}),
	);
}

function shouldUseCachedProjectDiagnostics(value: unknown): boolean {
	return value === "cached";
}

function shouldRefreshProjectDiagnostics(value: unknown): boolean {
	return value === "cheap" || value === "all";
}

/** True when full mode should include project-runner state at all (any non-none refreshRunners). */
function shouldIncludeProjectRunners(value: unknown): boolean {
	return shouldRefreshProjectDiagnostics(value) || value === "cached";
}

/**
 * Merge cache-derived diagnostics from the analyzer extractors (jscpd, madge,
 * gitleaks, knip …) into the scanned project snapshot: append to the existing
 * one (recording the runners), or synthesize a minimal snapshot when there was
 * no in-process scan. Returns the snapshot unchanged when there is nothing extra.
 */
function foldExtraDiagnosticsIntoSnapshot(
	snapshot: ProjectDiagnosticsSnapshot | undefined,
	extra: ProjectDiagnostic[],
	runners: string[],
	cwd: string,
): ProjectDiagnosticsSnapshot | undefined {
	if (extra.length === 0) return snapshot;
	if (snapshot) {
		const merged = new Set([...snapshot.runners, ...runners]);
		return {
			...snapshot,
			diagnostics: [...snapshot.diagnostics, ...extra],
			runners: [...merged],
		};
	}
	return {
		version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
		cwd,
		tier: "all",
		scannedAt: new Date().toISOString(),
		diagnostics: extra,
		filesScanned: 0,
		runners,
	};
}

async function getProjectDiagnosticsSnapshotForFullMode(
	cwd: string,
	options: {
		refreshRunners?: unknown;
		maxProjectFiles?: number;
		signal?: AbortSignal;
	},
): Promise<ProjectDiagnosticsSnapshot | undefined> {
	if (shouldRefreshProjectDiagnostics(options.refreshRunners)) {
		return scanProjectDiagnostics({
			cwd,
			tier: "cheap",
			maxFiles: options.maxProjectFiles,
			signal: options.signal,
		});
	}
	if (shouldUseCachedProjectDiagnostics(options.refreshRunners)) {
		// The cached snapshot is a cross-session cache; drop diagnostics for files
		// edited/deleted since the scan so a stale entry isn't replayed (#298). A
		// fresh scan (above) is current by construction and needs no reconcile.
		const cached = loadProjectDiagnosticsSnapshot(cwd);
		return cached
			? reconcileProjectDiagnosticsSnapshot(cached).snapshot
			: undefined;
	}
	return undefined;
}

async function formatFullMode(
	cwd: string,
	severity: string,
	lspService: LSPServiceLike,
	cacheManager: CacheManager,
	options: {
		refreshRunners?: unknown;
		maxProjectFiles?: number;
		maxLspFiles?: number;
		signal?: AbortSignal;
		wallClockMs?: number;
		onProgress?: (completed: number, total: number) => void;
	} = {},
): Promise<{ content: [{ type: "text"; text: string }]; details: object }> {
	const runWorkspaceDiagnostics = lspService.runWorkspaceDiagnostics;
	if (typeof runWorkspaceDiagnostics !== "function") {
		return {
			content: [
				{
					type: "text" as const,
					text: "LSP service does not support project-wide workspace diagnostics.",
				},
			],
			details: { mode: "full", filesChecked: 0, lspUnavailable: true },
		};
	}
	const { signal } = options;
	const includeFile = createCurrentIgnoreFilter(cwd);
	const [rawLspResults, rawProjectSnapshot] = await Promise.all([
		runWorkspaceDiagnostics.call(lspService, cwd, {
			maxFiles: options.maxLspFiles,
			signal,
			onProgress: options.onProgress,
		}),
		getProjectDiagnosticsSnapshotForFullMode(cwd, options),
	]);
	const aborted = signal?.aborted ?? false;
	const lspResults = rawLspResults.filter((result) =>
		includeFile(result.filePath),
	);
	const scannedSnapshot = filterProjectDiagnosticsSnapshot(
		rawProjectSnapshot,
		includeFile,
	);
	// Fold in the cached heavyweight-analyzer findings (jscpd, madge, gitleaks,
	// knip …) via the extractor registry — cache-only reads, never a fresh scan,
	// so mode=full can't relaunch or contend with the background runs. Only when
	// the caller opted into project-runner state.
	const extracted = shouldIncludeProjectRunners(options.refreshRunners)
		? extractCachedProjectDiagnostics(cacheManager, cwd)
		: { diagnostics: [], runners: [] };
	const projectSnapshot = foldExtraDiagnosticsIntoSnapshot(
		scannedSnapshot,
		extracted.diagnostics.filter((d) => includeFile(d.filePath)),
		extracted.runners,
		cwd,
	);
	const projectDelta = filterProjectDiagnosticsDeltaReport(
		loadProjectDiagnosticsDeltaReport(cwd),
		includeFile,
	);
	const summaries = await applyInlineSuppressionsToSummaries(
		mergeDiagnosticsWithWidgetSummaries(
			getFileDiagnosticSummaries().filter((summary) =>
				includeFile(summary.filePath),
			),
			lspResults,
			projectSnapshot,
			projectDelta,
		),
	);
	const result = formatAllMode(cwd, severity, summaries, {
		mode: "full",
		lspFilesChecked: rawLspResults.length,
		partial: aborted,
		projectDiagnostics:
			projectSnapshot === undefined
				? undefined
				: {
						tier: projectSnapshot.tier,
						filesScanned: projectSnapshot.filesScanned,
						diagnostics: projectSnapshot.diagnostics.length,
						runners: projectSnapshot.runners,
					},
		projectDiagnosticsDelta:
			projectDelta === undefined
				? undefined
				: {
						diagnostics: projectDelta.diagnostics.length,
						sources: projectDelta.sources,
						turnIndex: projectDelta.turnIndex,
					},
	});
	// Stopped mid-scan: the results above are whatever completed before the abort.
	// Tell the agent so it doesn't read a partial sweep as "clean" (#341). The
	// abort is either a user/turn cancel (Escape) or the wall-clock ceiling firing
	// (AbortSignal.timeout → TimeoutError), which guarantees the scan can't hang
	// indefinitely — distinguish them so the agent knows whether to just re-run.
	if (aborted) {
		const timedOut =
			(signal as (AbortSignal & { reason?: { name?: string } }) | undefined)
				?.reason?.name === "TimeoutError";
		const note = timedOut
			? `\n\n⚠ Scan exceeded its ${Math.round((options.wallClockMs ?? 0) / 1000)}s time budget and was stopped — results are partial. ` +
				"Narrow it with maxLspFiles, or raise PI_LENS_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS."
			: "\n\n⚠ Scan cancelled before completion — results are partial. " +
				"Re-run with a smaller maxLspFiles to finish within budget.";
		return {
			content: [{ type: "text" as const, text: result.content[0].text + note }],
			details: { ...result.details, timedOut },
		};
	}
	return result;
}

function formatAllMode(
	cwd: string,
	severity: string,
	summaries: FileDiagnosticSummary[] = getFileDiagnosticSummaries(),
	detailOverrides: Record<string, unknown> = { mode: "all" },
	staleDropped = 0,
): { content: [{ type: "text"; text: string }]; details: object } {
	// Files changed/deleted since their diagnostics were recorded have already
	// been dropped by reconcileStaleWidgetFiles; note them so the agent knows
	// those aren't "clean", just un-rescanned (use mode=full to refresh).
	const staleNote =
		staleDropped > 0
			? ` (${staleDropped} changed file${staleDropped === 1 ? "" : "s"} omitted as stale — use mode=full to rescan)`
			: "";

	const includeFile = createCurrentIgnoreFilter(cwd);
	const visibleSummaries = summaries.filter((s) => includeFile(s.filePath));

	// Filter to files with actual issues
	const withIssues = visibleSummaries.filter((s) => {
		if (severity === "error") return s.blocking > 0 || s.errors > 0;
		if (severity === "warning") return s.warnings > 0;
		return s.blocking > 0 || s.errors > 0 || s.warnings > 0;
	});

	if (withIssues.length === 0) {
		const text =
			(visibleSummaries.length === 0
				? "No files diagnosed yet this session."
				: `No ${severity === "all" ? "" : severity + " "}issues across ${visibleSummaries.length} file${visibleSummaries.length === 1 ? "" : "s"} diagnosed this session. ✓`) +
			staleNote;
		return {
			content: [{ type: "text" as const, text }],
			details: {
				...detailOverrides,
				filesChecked: visibleSummaries.length,
				staleDropped,
			},
		};
	}

	// Sort: blocking first, then errors, then warnings
	const sorted = withIssues.sort(
		(a, b) =>
			b.blocking - a.blocking || b.errors - a.errors || b.warnings - a.warnings,
	);

	const lines: string[] = [];
	let totalBlocking = 0;
	let totalErrors = 0;
	let totalWarnings = 0;

	for (const s of sorted) {
		const rel = path.relative(cwd, s.filePath);
		const parts: string[] = [];
		if (s.blocking > 0) parts.push(`🔴 ${s.blocking} blocking`);
		if (s.errors > 0 && s.blocking === 0) parts.push(`${s.errors}E`);
		if (s.warnings > 0) parts.push(`${s.warnings}W`);
		if (!s.hasFinalSnapshot) parts.push(`(pending)`);
		lines.push(`${rel}  ${parts.join("  ")}`);

		// List the actual diagnostics (not just counts) so the agent can act on
		// them without re-running anything — same "L<line>: <message>" shape as the
		// inline blocker output. The widget state now exposes the FULL set (not the
		// TUI's 12-cap); the tool applies its own generous per-file budget purely to
		// avoid flooding context on a pathologically broken file.
		const matching = (s.diagnostics ?? [])
			.filter((d) => matchesSeverity(d, severity))
			.sort(bySeverityThenLine);
		const shown = matching.slice(0, MAX_DIAGNOSTICS_PER_FILE);
		for (const d of shown) {
			const marker = isErrorLike(d)
				? d.semantic === "blocking"
					? "🔴 "
					: ""
				: "";
			const label = d.rule ?? d.tool;
			const tag = label ? ` [${label}]` : "";
			const msg = d.message.replace(/\s+/g, " ").trim();
			lines.push(`  ${marker}L${d.line ?? "?"}: ${msg}${tag}`);
		}
		if (matching.length > shown.length) {
			lines.push(
				`  … ${matching.length - shown.length} more in this file (showing ${shown.length} of ${matching.length})`,
			);
		}

		totalBlocking += s.blocking;
		totalErrors += s.errors;
		totalWarnings += s.warnings;
	}

	const summary = [
		`\nSummary (${visibleSummaries.length} files diagnosed this session):`,
		totalBlocking > 0
			? `  🔴 ${totalBlocking} blocking error${totalBlocking === 1 ? "" : "s"}`
			: null,
		totalErrors > 0
			? `  ${totalErrors} error${totalErrors === 1 ? "" : "s"}`
			: null,
		totalWarnings > 0
			? `  ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}`
			: null,
	]
		.filter(Boolean)
		.join("\n");

	return {
		content: [
			{ type: "text" as const, text: lines.join("\n") + summary + staleNote },
		],
		details: {
			...detailOverrides,
			filesWithIssues: withIssues.length,
			totalBlocking,
			totalErrors,
			totalWarnings,
			staleDropped,
		},
	};
}
