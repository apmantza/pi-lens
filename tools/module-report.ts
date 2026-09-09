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
			"Return a navigable source-module outline with symbols, references, and read handles. Example: use module_report on `src/app.ts` before read_symbol.",
		promptSnippet: "Outline a source module before reading a body",
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
			const view =
				details?.view && details.view !== "default" ? ` [${details.view}]` : "";
			return `module_report ${base}  ${parts.join(" · ")}${view}`;
		}),
		parameters: Type.Object({
			path: Type.String({
				description: "Source file, e.g. `src/app.ts`.",
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
			callGraph: Type.Optional(
				Type.Boolean({
					description:
						"Include bounded derived callers/callees from the cached FunctionCallGraph; cold or stale cache state is explicit.",
				}),
			),
			maxCallGraphEntries: Type.Optional(
				Type.Number({
					description:
						"Per-direction cap for call-graph relations (default 20).",
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
				callGraph?: boolean;
				maxCallGraphEntries?: number;
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
					callGraph: params.callGraph,
					maxCallGraphEntries: params.maxCallGraphEntries,
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
			"Return one symbol's verbatim source. Example: use read_symbol after module_report identifies `parseConfig`.",
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
					"Exact symbol name or callback handle to read (e.g. a function, class, type, or module_report callbacks[].name). Accepts a dotted `Class.method` name to resolve a member.",
			}),
			kind: Type.Optional(
				Type.String({
					description:
						"Optional kind filter (e.g. function, interface, class) to disambiguate when multiple same-file symbols share the requested name. Omitting it returns the first match, same as today.",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: { path: string; symbol: string; kind?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			const absFile = resolveFile(params.path, ctx.cwd);
			const cwd = getProjectRoot() || ctx.cwd || ".";
			let result: Awaited<ReturnType<typeof readSymbol>>;
			try {
				result = await readSymbol(absFile, params.symbol, cwd, {
					kind: params.kind,
				});
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
				const suggestionSuffix = result.suggestions?.length
					? ` Did you mean: ${result.suggestions.join(", ")}?`
					: " Use module_report to list available symbols.";
				const text = result.error
					? `Could not inspect ${path.basename(absFile)}: ${result.error}${warningSuffix}`
					: `Symbol "${params.symbol}" not found in ${path.basename(absFile)}.${suggestionSuffix}${warningSuffix}`;
				return {
					content: [{ type: "text" as const, text }],
					isError: true,
					details: {
						found: false,
						...(result.error ? { error: result.error } : {}),
						...(result.warnings ? { warnings: result.warnings } : {}),
						...(result.suggestions ? { suggestions: result.suggestions } : {}),
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
			const ambiguityNote = result.ambiguous
				? ` (${result.ambiguous.count} matches — returned the ${result.kind}; pass \`kind\` to disambiguate: ${result.ambiguous.kinds.join(", ")})`
				: "";
			const header = `${result.kind} ${result.name}${ambiguityNote}  ${path.basename(result.path)}:${result.startLine}-${result.endLine}`;
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
					...(result.ambiguous ? { ambiguous: result.ambiguous } : {}),
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
			"Return the smallest symbol or callback enclosing a line. Example: use read_enclosing after a diagnostic points to line 42.",
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
