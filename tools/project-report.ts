/**
 * project_report pi tool (#773) — the top of the discovery funnel:
 * project_report orients the agent in the project, module_report explains one
 * file, read_symbol reads the exact body. Thin wrapper over the existing
 * projectReport() engine seam (clients/lens-engine.ts), mirroring the MCP
 * pilens_project_report tool. Follows symbol_search's cold-cache contract
 * (#348 decision 3): a cold graph kicks off a background build and returns
 * `available: false` with a retry hint, never blocking the call.
 */

import { Type } from "../clients/deps/typebox.js";
import {
	projectReport,
	renderTextProjectReport,
	type ProjectReport,
} from "../clients/lens-engine.js";
import {
	compactRenderResult,
	JSON_CELL_DETAILS_KEY,
	renderToolText,
	type LensToolResult,
} from "./render-compact.js";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

type ProjectReportDetails = {
	available?: boolean;
	hint?: string | undefined;
	hubs?: number;
	entryPoints?: number;
	view?: string;
	[JSON_CELL_DETAILS_KEY]?: boolean;
};

export function createProjectReportTool(getProjectRoot: () => string) {
	return {
		name: "project_report" as const,
		label: "Project Report",
		description:
			'Orient in a project from its review graph, with ranked hubs and entry points. Returns a line-oriented TEXT report by default; pass view:"json" for the full JSON payload. On a cold cache, project_report and symbol_search return available: false with a retry hint and start a non-blocking background build; module_report degrades to outline-only with cache freshness explicit. Example: use project_report before module_report when the target file is unknown.',
		promptSnippet: "Orient in a project before choosing a file",
		renderResult: compactRenderResult<ProjectReportDetails>(
			({ details, isError }) => {
				if (isError || details?.available === false) {
					return `project_report — unavailable${details?.hint ? `: ${details.hint}` : ""}`;
				}
				const parts = [
					`${details?.hubs ?? 0} hub(s)`,
					`${details?.entryPoints ?? 0} entry point(s)`,
				];
				const view =
					details?.view && details.view !== "default"
						? ` [${details.view}]`
						: "";
				return `project_report  ${parts.join(" · ")}${view}`;
			},
		),
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Number({
					description:
						"Scales every ranked section's cap (default 10) — a single knob for all sections.",
				}),
			),
			focus: Type.Optional(
				Type.String({
					description:
						"Optional task hint used only to re-rank sections toward relevant subsystems (does not expand scope or trigger scans).",
				}),
			),
			view: Type.Optional(
				Type.String({
					// Plain string, no enum: "json" is the JSON hatch; anything else is text.
					description:
						'Payload tier. "json" returns the full JSON report; any other value (or omitting view) returns the default line-oriented TEXT rendering.',
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: { limit?: number; focus?: string; view?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		): Promise<LensToolResult<ProjectReportDetails>> {
			const cwd = getProjectRoot() || ctx.cwd || ".";
			let report: ProjectReport;
			try {
				report = await projectReport(cwd, {
					limit: params.limit,
					focus: params.focus,
				});
			} catch (err) {
				return {
					...renderToolText(`Project report failed: ${errorMessage(err)}`),
					isError: true,
					details: { available: false },
				};
			}
			if (!report.available) {
				// Cold cache is still the text cell (#5150): the renderer owns the
				// unavailable layout (hint, LAST BUILD, UNRENDERED), so no fenced
				// JSON sidecar is emitted here either.
				return {
					content: [
						{ type: "text" as const, text: renderTextProjectReport(report) },
					],
					isError: true,
					details: { available: false, hint: report.hint },
				};
			}
			// #5150: default text, explicit JSON hatch. Unknown views fall
			// through to the default cell — never to JSON.
			const text =
				params.view === "json"
					? JSON.stringify(report)
					: renderTextProjectReport(report);
			return {
				content: [{ type: "text" as const, text }],
				isError: false,
				details: {
					available: true,
					hubs: report.hubs?.length ?? 0,
					entryPoints: report.entryPoints?.length ?? 0,
					view: params.view === "json" ? "json" : "default",
					[JSON_CELL_DETAILS_KEY]: params.view === "json",
				},
			};
		},
	};
}
