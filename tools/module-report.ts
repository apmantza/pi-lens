/**
 * module_report + read_symbol tool definitions (#245).
 *
 * Agent-facing surface for the structured read-substitute flow: module_report
 * gives a navigable overview of a module (outline + signatures + who-uses-this +
 * ready-to-use read args); read_symbol returns one symbol's verbatim body. The
 * pair lets an agent understand and target a module without reading the whole
 * file. read_symbol also wires the read-guard tie-in — a symbol body it returns
 * is recorded as a genuine read of that range (module_report deliberately does
 * not, since an outline is shape, not body).
 */

import * as path from "node:path";
import { Type } from "../clients/deps/typebox.js";
import { moduleReport, readSymbol } from "../clients/module-report.js";

function resolveFile(filePath: string, cwd: string | undefined): string {
	return path.isAbsolute(filePath)
		? filePath
		: path.resolve(cwd || ".", filePath);
}

export function createModuleReportTool(getProjectRoot: () => string) {
	return {
		name: "module_report" as const,
		label: "Module Report",
		description:
			"Structured, navigable overview of a source module — a token-efficient substitute for reading the whole file. Returns each symbol's name/kind/signature/line-range with ready-to-use `read` arguments, plus who-uses-this, risk flags, and ranked recommendedReads. Prefer this before a full read; then use read_symbol (or read) for the exact body you need.\n" +
			"Single mode: tree-sitter outline + review-graph who-uses-this + bounded live-LSP enrichment (exact references/implementations for exported symbols, time-boxed; degrades to graph-only when no LSP server is available). `semantic.source` reports whether LSP data was used.\n" +
			"Pass `blastRadius: true` to also get the cross-file blast radius — the transitive dependents of this module aggregated to ranked file `read` args (\"if you change this, verify these files\"). Read-only over the cached graph; omitted on a cold cache. Supersedes the standalone impact query.\n" +
			"Returns JSON. An outline shows shape, not bodies — it does NOT count as having read a symbol's body for editing; use read_symbol for that.",
		promptSnippet:
			"Navigable file outline — a cheap substitute for reading a whole file",
		parameters: Type.Object({
			path: Type.String({
				description: "Absolute or workspace-relative path to the source file.",
			}),
			maxRefsPerSymbol: Type.Optional(
				Type.Number({
					description: "Cap on who-uses-this entries per symbol (default 10).",
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
			const report = await moduleReport(absFile, cwd, {
				maxRefsPerSymbol: params.maxRefsPerSymbol,
				blastRadius: params.blastRadius,
				blastRadiusDepth: params.blastRadiusDepth,
			});
			return {
				content: [
					// Compact JSON: omit indentation. Saves ~30% on the wire
					// without changing the schema. Tests use JSON.parse so
					// they are agnostic to whitespace.
					{ type: "text" as const, text: JSON.stringify(report) },
				],
				isError: !report.available,
				details: {
					available: report.available,
					staleness: report.staleness,
					symbols: report.summary.symbols,
					exports: report.summary.exports,
				},
			};
		},
	};
}

export function createReadSymbolTool(
	getProjectRoot: () => string,
	recordSymbolRead: (
		filePath: string,
		symbol: { name: string; kind: string; startLine: number; endLine: number },
	) => void,
) {
	return {
		name: "read_symbol" as const,
		label: "Read Symbol",
		description:
			"Return the verbatim source of a single named symbol (function/class/method/interface/type) in a file — a targeted, cheap alternative to reading the whole file. Pair with module_report: module_report finds the symbol, read_symbol shows its body. Unlike an outline, this delivers the actual lines, so it counts as having read that symbol for the read-before-edit guard.",
		promptSnippet:
			"Read one symbol's body instead of the whole file",
		parameters: Type.Object({
			path: Type.String({
				description: "Absolute or workspace-relative path to the source file.",
			}),
			symbol: Type.String({
				description:
					"Exact symbol name to read (e.g. a function, class, or type name).",
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
			const result = await readSymbol(absFile, params.symbol, cwd);
			if (!result.found) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Symbol "${params.symbol}" not found in ${path.basename(absFile)}. Use module_report to list available symbols.`,
						},
					],
					isError: true,
					details: { found: false },
				};
			}
			// Read-substitute tie-in (#245): a readSymbol body IS a real read of that
			// range, so record it as read-guard coverage for the symbol.
			if (
				result.kind &&
				typeof result.startLine === "number" &&
				typeof result.endLine === "number"
			) {
				recordSymbolRead(result.path, {
					name: result.name,
					kind: result.kind,
					startLine: result.startLine,
					endLine: result.endLine,
				});
			}
			const header = `${result.kind} ${result.name}  ${path.basename(result.path)}:${result.startLine}-${result.endLine}`;
			return {
				content: [
					{
						type: "text" as const,
						text: `${header}\n\n${result.source ?? ""}`,
					},
				],
				details: {
					found: true,
					name: result.name,
					kind: result.kind,
					startLine: result.startLine,
					endLine: result.endLine,
				},
			};
		},
	};
}
