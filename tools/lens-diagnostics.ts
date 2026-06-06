/**
 * lens_diagnostics tool — cached project diagnostic state (issue #159).
 *
 * Two modes:
 *   delta (default) — fixable warnings from the current agent turn, read from
 *                     the actionable-warnings and code-quality-warnings caches.
 *   all             — all known diagnostic counts across every file pi-lens has
 *                     seen this session, read from the widget state.
 */

import * as path from "node:path";
import { Type } from "typebox";
import type { CacheManager } from "../clients/cache-manager.js";
import type { ActionableWarningsReport } from "../clients/actionable-warnings.js";
import type { CodeQualityWarningsReport } from "../clients/code-quality-warnings.js";
import {
	getFileDiagnosticSummaries,
	type WidgetDiagnostic,
} from "../clients/widget-state.js";

export function createLensDiagnosticsTool(
	cacheManager: CacheManager,
	getCwd: () => string,
) {
	return {
		name: "lens_diagnostics" as const,
		label: "Project Diagnostics",
		description:
			"Query pi-lens's current diagnostic state without re-running LSP or dispatch. " +
			"Reads from cache only — zero LSP calls, instant response.\n\n" +
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
			"errors from earlier turns are visible even if they dropped from turn-end context. " +
			"For project-wide LSP diagnostics (all files including unedited ones), use " +
			"lsp_navigation operation=workspaceDiagnostics.",
		promptSnippet: "Use lens_diagnostics mode=all to verify no blocking errors remain",
		parameters: Type.Object({
			mode: Type.Optional(
				Type.String({
					enum: ["delta", "all"],
					description:
						"delta = current turn's fixable warnings (default). " +
						"all = full session diagnostic counts per file.",
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
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			const mode = (params.mode as string | undefined) ?? "delta";
			const severity = (params.severity as string | undefined) ?? "all";
			const cwd = ctx.cwd ?? getCwd();

			if (mode === "all") {
				return formatAllMode(cwd, severity);
			}
			return formatDeltaMode(cacheManager, cwd, severity);
		},
	};
}

// ── delta mode ────────────────────────────────────────────────────────────────

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

	const lines: string[] = [];

	// Fixable warnings from actionable-warnings
	if (actionable?.files && actionable.files.length > 0 && severity !== "error") {
		for (const file of actionable.files) {
			const rel = path.relative(cwd, file.filePath);
			lines.push(`${rel}`);
			for (const w of file.warnings ?? []) {
				lines.push(`  ⚠ L${w.line ?? "?"}  ${w.rule ?? w.code ?? w.tool}  ${w.message}`);
			}
		}
	}

	// Quality issues
	if (quality?.files && quality.files.length > 0 && severity !== "error") {
		for (const file of quality.files) {
			const rel = path.relative(cwd, file.filePath);
			if (!lines.includes(rel)) lines.push(rel);
			for (const w of file.warnings ?? []) {
				lines.push(`  ℹ L${w.line ?? "?"}  ${w.rule ?? w.code ?? w.tool}  ${w.message}`);
			}
		}
	}

	const aw = actionable?.summary?.warnings ?? 0;
	const cq = quality?.summary?.warnings ?? 0;

	if (lines.length === 0) {
		const text = `No ${severity === "all" ? "" : severity + " "}issues in the current turn delta.`;
		return { content: [{ type: "text" as const, text }], details: { mode: "delta", warnings: 0 } };
	}

	const summary = `\nSummary (turn delta): ${aw} actionable warning${aw === 1 ? "" : "s"} · ${cq} quality issue${cq === 1 ? "" : "s"}`;
	return {
		content: [{ type: "text" as const, text: lines.join("\n") + summary }],
		details: { mode: "delta", actionableWarnings: aw, qualityIssues: cq },
	};
}

// ── all mode ──────────────────────────────────────────────────────────────────

/** A diagnostic counts as error-like when it blocks or has error severity. */
function isErrorLike(d: WidgetDiagnostic): boolean {
	return d.semantic === "blocking" || d.severity === "error";
}

function matchesSeverity(d: WidgetDiagnostic, severity: string): boolean {
	if (severity === "error") return isErrorLike(d);
	if (severity === "warning") return !isErrorLike(d);
	return true;
}

function formatAllMode(
	cwd: string,
	severity: string,
): { content: [{ type: "text"; text: string }]; details: object } {
	const summaries = getFileDiagnosticSummaries();

	// Filter to files with actual issues
	const withIssues = summaries.filter((s) => {
		if (severity === "error") return s.blocking > 0 || s.errors > 0;
		if (severity === "warning") return s.warnings > 0;
		return s.blocking > 0 || s.errors > 0 || s.warnings > 0;
	});

	if (withIssues.length === 0) {
		const text = summaries.length === 0
			? "No files diagnosed yet this session."
			: `No ${severity === "all" ? "" : severity + " "}issues across ${summaries.length} file${summaries.length === 1 ? "" : "s"} diagnosed this session. ✓`;
		return { content: [{ type: "text" as const, text }], details: { mode: "all", filesChecked: summaries.length } };
	}

	// Sort: blocking first, then errors, then warnings
	const sorted = withIssues.sort(
		(a, b) =>
			b.blocking - a.blocking ||
			b.errors - a.errors ||
			b.warnings - a.warnings,
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
		// inline blocker output. Stored diagnostics are capped per file and ordered
		// with blockers first.
		const shown = (s.diagnostics ?? []).filter((d) =>
			matchesSeverity(d, severity),
		);
		for (const d of shown) {
			const marker = isErrorLike(d) ? (d.semantic === "blocking" ? "🔴 " : "") : "";
			const label = d.rule ?? d.tool;
			const tag = label ? ` [${label}]` : "";
			const msg = d.message.replace(/\s+/g, " ").trim();
			lines.push(`  ${marker}L${d.line ?? "?"}: ${msg}${tag}`);
		}
		const totalForFile =
			severity === "error"
				? s.blocking + s.errors
				: severity === "warning"
					? s.warnings
					: s.blocking + s.errors + s.warnings;
		if (totalForFile > shown.length) {
			lines.push(`  … ${totalForFile - shown.length} more not shown (per-file display cap)`);
		}

		totalBlocking += s.blocking;
		totalErrors += s.errors;
		totalWarnings += s.warnings;
	}

	const summary = [
		`\nSummary (${summaries.length} files diagnosed this session):`,
		totalBlocking > 0 ? `  🔴 ${totalBlocking} blocking error${totalBlocking === 1 ? "" : "s"}` : null,
		totalErrors > 0 ? `  ${totalErrors} error${totalErrors === 1 ? "" : "s"}` : null,
		totalWarnings > 0 ? `  ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"}` : null,
	].filter(Boolean).join("\n");

	return {
		content: [{ type: "text" as const, text: lines.join("\n") + summary }],
		details: { mode: "all", filesWithIssues: withIssues.length, totalBlocking, totalErrors, totalWarnings },
	};
}
