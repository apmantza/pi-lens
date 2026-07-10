/**
 * module_report + read_symbol tool definitions (#245).
 *
 * Agent-facing surface for the structured read-substitute flow: module_report
 * gives a navigable overview of a module (outline + signatures + who-uses-this +
 * ready-to-use read args); read_symbol returns one symbol's verbatim body;
 * read_enclosing maps a file+line search/diagnostic hit to the smallest enclosing
 * symbol/callback body. The exact-body tools wire the read-guard tie-in — a body
 * they return is recorded as a genuine read of that range (module_report
 * deliberately does not, since an outline is shape, not body).
 */

import * as path from "node:path";
import { Type } from "../clients/deps/typebox.js";
import { logLatency } from "../clients/latency-logger.js";
import {
	moduleReport,
	readEnclosing,
	readSymbol,
	renderCompactModuleReport,
} from "../clients/module-report.js";
import { baseName, compactRenderResult } from "./render-compact.js";

function resolveFile(filePath: string, cwd: string | undefined): string {
	return path.isAbsolute(filePath)
		? filePath
		: path.resolve(cwd || ".", filePath);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function createModuleReportTool(getProjectRoot: () => string) {
	return {
		name: "module_report" as const,
		label: "Module Report",
		description:
			"Structured, navigable overview of a source module — a token-efficient substitute for reading the whole file. Returns each symbol's name/kind/signature/line-range (plus a first-line `doc` summary when a doc comment is attached), important inline callbacks/closures/lambdas with stable handles, plus who-uses-this, risk flags, and ranked recommendedReads. To read a symbol's body: call read/read_symbol with offset=startLine, limit=endLine-startLine+1 on THIS report's `path` — those aren't repeated per symbol. Prefer this before a full read; then use read_symbol (or read) for the exact body you need.\n" +
			"Single mode: language-uniform tree-sitter outline + review-graph who-uses-this + inline executable extraction; degrades to outline-only when no cached graph is available. `semantic.source` reports whether graph data was used.\n" +
			'Pass `blastRadius: true` to also get the cross-file blast radius — the transitive dependents of this module aggregated to ranked file `read` args ("if you change this, verify these files"). Read-only over the cached graph; omitted on a cold cache. Supersedes the standalone impact query.\n' +
			'`view: "compact"` returns a line-oriented text rendering (one line per symbol/callback, cheapest option) instead of JSON — same data, roughly a quarter of the token cost; use it for a quick skim. Default view returns JSON. An outline shows shape, not bodies — it does NOT count as having read a symbol\'s body for editing; use read_symbol for that.',
		promptSnippet:
			"Navigable file outline — a cheap substitute for reading a whole file",
		renderResult: compactRenderResult<{
			available?: boolean;
			staleness?: string;
			symbols?: number;
			exports?: number;
			callbacks?: number;
			view?: string;
		}>(({ details, args, isError }) => {
			const base = baseName(args.path) || "module";
			if (isError || details?.available === false) {
				return `module_report ${base} — unavailable`;
			}
			const parts = [
				`${details?.symbols ?? 0} symbols`,
				`${details?.exports ?? 0} exports`,
			];
			if (details?.callbacks) parts.push(`${details.callbacks} callbacks`);
			const view = details?.view && details.view !== "default" ? ` [${details.view}]` : "";
			return `module_report ${base}  ${parts.join(" · ")}${view}`;
		}),
		parameters: Type.Object({
			path: Type.String({
				description: "Absolute or workspace-relative path to the source file.",
			}),
			maxRefsPerSymbol: Type.Optional(
				Type.Number({
					description: "Cap on who-uses-this entries per symbol (default 10).",
				}),
			),
			focus: Type.Optional(
				Type.String({
					description:
						"Optional task hint used only to rank recommendedReads (does not expand scope or trigger scans).",
				}),
			),
			view: Type.Optional(
				Type.String({
					enum: ["summary", "default", "compact"],
					description:
						"Payload tier. summary returns top-level entries/recommendedReads and section provenance with heavy callback/usedBy/blast-radius payloads omitted. compact (cheapest) returns a line-oriented TEXT rendering of the full report instead of JSON.",
				}),
			),
			blastRadius: Type.Optional(
				Type.Boolean({
					description:
						"Include the cross-file blast-radius section: transitive dependents aggregated to ranked file reads. Read-only over the cached graph (omitted when cold).",
				}),
			),
			blastRadiusDepth: Type.Optional(
				Type.Number({
					description:
						"Max hops for the blast-radius walk (default 3). Only used with blastRadius.",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: {
				path: string;
				maxRefsPerSymbol?: number;
				focus?: string;
				view?: "summary" | "default" | "compact";
				blastRadius?: boolean;
				blastRadiusDepth?: number;
			},
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			// Resolve the file against the agent's cwd (sibling-tool convention); build
			// the review graph at the project root so cross-file who-uses-this is whole.
			const absFile = resolveFile(params.path, ctx.cwd);
			const cwd = getProjectRoot() || ctx.cwd || ".";
			let report: Awaited<ReturnType<typeof moduleReport>>;
			try {
				report = await moduleReport(absFile, cwd, {
					maxRefsPerSymbol: params.maxRefsPerSymbol,
					focus: params.focus,
					view: params.view,
					blastRadius: params.blastRadius,
					blastRadiusDepth: params.blastRadiusDepth,
				});
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Module report failed for ${path.basename(absFile)}: ${errorMessage(err)}`,
						},
					],
					isError: true,
					details: { available: false },
				};
			}
			// view:"compact" renders the report as line-oriented text (roughly a
			// quarter of the JSON cost for the same info) instead of JSON. Every
			// other view returns compact (unindented) JSON — omitting indentation
			// alone saves ~30% on the wire without changing the schema. Tests use
			// JSON.parse for the JSON views, so they are agnostic to whitespace.
			const text =
				params.view === "compact"
					? renderCompactModuleReport(report)
					: JSON.stringify(report);
			return {
				content: [{ type: "text" as const, text }],
				isError: !report.available,
				details: {
					available: report.available,
					staleness: report.staleness,
					symbols: report.summary.symbols,
					exports: report.summary.exports,
					callbacks: report.callbacks.length,
					callbackSupport: report.callbackSupport,
					view: report.view ?? "default",
				},
			};
		},
	};
}

type ReadRecord = {
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
};

type ReadRecorder = (filePath: string, symbol: ReadRecord) => void;

function recordReadCoverage(
	recordSymbolRead: ReadRecorder,
	result: {
		path: string;
		name?: string;
		kind?: string;
		startLine?: number;
		endLine?: number;
	},
	phase: string,
): boolean {
	if (
		!result.name ||
		!result.kind ||
		typeof result.startLine !== "number" ||
		typeof result.endLine !== "number"
	) {
		return false;
	}
	try {
		recordSymbolRead(result.path, {
			name: result.name,
			kind: result.kind,
			startLine: result.startLine,
			endLine: result.endLine,
		});
		return true;
	} catch (err) {
		logLatency({
			type: "phase",
			phase,
			filePath: result.path,
			durationMs: 0,
			metadata: { error: errorMessage(err) },
		});
		return false;
	}
}

export function createReadSymbolTool(
	getProjectRoot: () => string,
	recordSymbolRead: ReadRecorder,
) {
	return {
		name: "read_symbol" as const,
		label: "Read Symbol",
		description:
			"Return the verbatim source of a single named symbol or module_report callback handle in a file — a targeted, cheap alternative to reading the whole file. Pair with module_report: module_report finds the symbol/callback handle, read_symbol shows its body. Unlike an outline, this delivers the actual lines, so it counts as having read that symbol for the read-before-edit guard.",
		promptSnippet: "Read one symbol's body instead of the whole file",
		renderResult: compactRenderResult<{
			found?: boolean;
			name?: string;
			kind?: string;
			startLine?: number;
			endLine?: number;
		}>(({ details, args, isError, lineCount }) => {
			const base = baseName(args.path);
			if (isError || details?.found === false) {
				const sym = typeof args.symbol === "string" ? args.symbol : "?";
				return `read_symbol "${sym}" ${base} — not found`;
			}
			const range =
				details?.startLine && details?.endLine
					? `:${details.startLine}-${details.endLine} (${details.endLine - details.startLine + 1} lines)`
					: ` (${lineCount} lines)`;
			return `read_symbol ${details?.kind ?? ""} ${details?.name ?? ""}  ${base}${range}`.replace(
				/\s+/g,
				" ",
			);
		}),
		parameters: Type.Object({
			path: Type.String({
				description: "Absolute or workspace-relative path to the source file.",
			}),
			symbol: Type.String({
				description:
					"Exact symbol name or callback handle to read (e.g. a function, class, type, or module_report callbacks[].name).",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: { path: string; symbol: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			const absFile = resolveFile(params.path, ctx.cwd);
			const cwd = getProjectRoot() || ctx.cwd || ".";
			let result: Awaited<ReturnType<typeof readSymbol>>;
			try {
				result = await readSymbol(absFile, params.symbol, cwd);
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Read symbol failed for ${path.basename(absFile)}: ${errorMessage(err)}`,
						},
					],
					isError: true,
					details: { found: false },
				};
			}
			if (!result.found) {
				const warningSuffix = result.warnings?.length
					? ` Warnings: ${result.warnings.join("; ")}`
					: "";
				const text = result.error
					? `Could not inspect ${path.basename(absFile)}: ${result.error}${warningSuffix}`
					: `Symbol "${params.symbol}" not found in ${path.basename(absFile)}. Use module_report to list available symbols.${warningSuffix}`;
				return {
					content: [{ type: "text" as const, text }],
					isError: true,
					details: {
						found: false,
						...(result.error ? { error: result.error } : {}),
						...(result.warnings ? { warnings: result.warnings } : {}),
					},
				};
			}
			// Read-substitute tie-in (#245): a readSymbol body IS a real read of that
			// range, so record it as read-guard coverage for the symbol. Keep the tool
			// response useful even if the guard hook itself fails; surface that fact in
			// details so callers know the returned body may not unlock a later edit.
			const readRecorded = recordReadCoverage(
				recordSymbolRead,
				result,
				"read_symbol_guard_error",
			);
			const header = `${result.kind} ${result.name}  ${path.basename(result.path)}:${result.startLine}-${result.endLine}`;
			const guardWarning = readRecorded
				? ""
				: "\n\nWarning: read coverage recording failed; the returned body may not satisfy the edit guard.";
			return {
				content: [
					{
						type: "text" as const,
						text: `${header}${guardWarning}\n\n${result.source ?? ""}`,
					},
				],
				details: {
					found: true,
					name: result.name,
					kind: result.kind,
					startLine: result.startLine,
					endLine: result.endLine,
					readRecorded,
				},
			};
		},
	};
}

export function createReadEnclosingTool(
	getProjectRoot: () => string,
	recordSymbolRead: ReadRecorder,
) {
	return {
		name: "read_enclosing" as const,
		label: "Read Enclosing",
		description:
			"Return the verbatim source for the smallest useful symbol/callback enclosing a line in a file. Use after ast_grep_search, diagnostics, or LSP locations when you need exact body text without reading the whole file. Uses tree-sitter only — no LSP or graph build — and records read-guard coverage for the returned range.",
		promptSnippet: "Read the enclosing symbol or callback body for a line",
		renderResult: compactRenderResult<{
			found?: boolean;
			name?: string;
			kind?: string;
			line?: number;
			startLine?: number;
			endLine?: number;
		}>(({ details, args, isError }) => {
			const base = baseName(args.path);
			if (isError || details?.found === false) {
				const ln = typeof args.line === "number" ? args.line : "?";
				return `read_enclosing ${base}:${ln} — no enclosing symbol`;
			}
			const range =
				details?.startLine && details?.endLine
					? `:${details.startLine}-${details.endLine}`
					: "";
			return `read_enclosing ${details?.kind ?? ""} ${details?.name ?? ""}  ${base}${range}`.replace(
				/\s+/g,
				" ",
			);
		}),
		parameters: Type.Object({
			path: Type.String({
				description: "Absolute or workspace-relative path to the source file.",
			}),
			line: Type.Number({
				description: "1-based line number inside the desired symbol/callback.",
			}),
			kinds: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Optional kind filter, e.g. function, method, callback, class, object_property_callback.",
				}),
			),
			maxLines: Type.Optional(
				Type.Number({
					description:
						"Optional maximum body size to return. Oversized matches obey onOversize.",
				}),
			),
			onOversize: Type.Optional(
				Type.String({
					enum: ["error", "slice", "outline"],
					description:
						"Behavior when the enclosing body exceeds maxLines. error (default) returns metadata only; slice returns a bounded partial read around line; outline returns nested symbols/callbacks with read handles.",
				}),
			),
			aroundLine: Type.Optional(
				Type.Number({
					description:
						"Maximum lines for onOversize=slice; defaults to maxLines, then 80.",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: {
				path: string;
				line: number;
				kinds?: string[];
				maxLines?: number;
				onOversize?: "error" | "slice" | "outline";
				aroundLine?: number;
			},
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			const absFile = resolveFile(params.path, ctx.cwd);
			const cwd = getProjectRoot() || ctx.cwd || ".";
			let result: Awaited<ReturnType<typeof readEnclosing>>;
			try {
				result = await readEnclosing(absFile, params.line, cwd, {
					kinds: params.kinds,
					maxLines: params.maxLines,
					onOversize: params.onOversize,
					aroundLine: params.aroundLine,
				});
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Read enclosing failed for ${path.basename(absFile)}:${params.line}: ${errorMessage(err)}`,
						},
					],
					isError: true,
					details: { found: false },
				};
			}
			if (!result.found) {
				const warningSuffix = result.warnings?.length
					? ` Warnings: ${result.warnings.join("; ")}`
					: "";
				const outlineSuffix = result.outline?.length
					? `\n\nNested outline:\n${JSON.stringify(result.outline)}`
					: "";
				const text = result.error
					? `Could not read enclosing range in ${path.basename(absFile)}:${result.line}: ${result.error}${warningSuffix}${outlineSuffix}`
					: `No enclosing symbol/callback found in ${path.basename(absFile)}:${result.line}.${warningSuffix}`;
				return {
					content: [{ type: "text" as const, text }],
					isError: true,
					details: {
						found: false,
						line: result.line,
						...(result.name ? { name: result.name } : {}),
						...(result.kind ? { kind: result.kind } : {}),
						...(result.startLine ? { startLine: result.startLine } : {}),
						...(result.endLine ? { endLine: result.endLine } : {}),
						...(result.enclosingStartLine
							? { enclosingStartLine: result.enclosingStartLine }
							: {}),
						...(result.enclosingEndLine
							? { enclosingEndLine: result.enclosingEndLine }
							: {}),
						...(result.selection ? { selection: result.selection } : {}),
						...(result.outline ? { outline: result.outline } : {}),
						...(result.error ? { error: result.error } : {}),
						...(result.warnings ? { warnings: result.warnings } : {}),
					},
				};
			}
			const readRecorded = recordReadCoverage(
				recordSymbolRead,
				result,
				"read_enclosing_guard_error",
			);
			const range = result.partial
				? `${result.startLine}-${result.endLine} (partial of ${result.enclosingStartLine}-${result.enclosingEndLine})`
				: `${result.startLine}-${result.endLine}`;
			const header = `${result.kind} ${result.name}  ${path.basename(result.path)}:${range}`;
			const guardWarning = readRecorded
				? ""
				: "\n\nWarning: read coverage recording failed; the returned body may not satisfy the edit guard.";
			return {
				content: [
					{
						type: "text" as const,
						text: `${header}${guardWarning}\n\n${result.source ?? ""}`,
					},
				],
				details: {
					found: true,
					name: result.name,
					kind: result.kind,
					line: result.line,
					startLine: result.startLine,
					endLine: result.endLine,
					enclosingStartLine: result.enclosingStartLine,
					enclosingEndLine: result.enclosingEndLine,
					parentChain: result.parentChain,
					partial: result.partial,
					selection: result.selection,
					readRecorded,
					...(result.warnings ? { warnings: result.warnings } : {}),
				},
			};
		},
	};
}
