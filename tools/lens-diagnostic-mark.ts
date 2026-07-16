/**
 * lens_diagnostic_mark — agent-facing disposition operation (#690, unifying
 * #181/#503/#504's discussion into one triage layer).
 *
 * Four dispositions, given the exact filePath/rule/message/line a
 * lens_diagnostics finding was reported with (same fields shown in that
 * tool's output):
 *   false-positive — the rule misfired. Persists project-wide.
 *   suppress       — real finding, deliberate policy not to fix. Writes an
 *                     inline `pi-lens-ignore: <rule>` comment into the source
 *                     (read by clients/dispatch/inline-suppressions.ts) —
 *                     portable and git-visible, not just a store entry.
 *   defer          — fix later. Session-ephemeral; resurfaces on the next
 *                     process run.
 *   flagged        — mark for the agent to fix. Persists until resolved;
 *                     surfaces in lens_diagnostics mode=full as "flagged-to-fix".
 *
 * Anchoring is content-based, never file:line, but the flavor differs by
 * disposition (see clients/diagnostic-dispositions.ts's module doc):
 * false-positive uses a STRICT anchor (rule + normalized message + a hash of
 * the diagnostic's OWN line — a site-specific judgment that should re-fire
 * if the line is rewritten); defer/suppress/flagged use a WEAK anchor (rule +
 * normalized message only — intent-level judgments that must survive edits to
 * the flagged line). Both are the SAME derivation clients/dispatch/
 * dispatcher.ts and lens-diagnostics.ts's mode=full path use when filtering,
 * so a mark made here is honored on the very next dispatch/query.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Type } from "../clients/deps/typebox.js";
import {
	markDisposition,
	type Disposition,
} from "../clients/diagnostic-dispositions.js";
import { insertSuppressComment } from "../clients/dispatch/suppress-writer.js";

const DISPOSITIONS = ["false-positive", "suppress", "defer", "flagged"] as const;

export function createLensDiagnosticMarkTool(getCwd: () => string) {
	return {
		name: "lens_diagnostic_mark" as const,
		label: "Mark Diagnostic",
		description:
			"Record a disposition for a lens_diagnostics finding, using the exact filePath/rule/message/line " +
			"it was reported with. false-positive/suppress persist across sessions; defer lasts only for the " +
			"current session (resurfaces next time); flagged marks it for you to come back and fix, and shows " +
			"up tagged in a later lens_diagnostics mode=full. suppress additionally writes a `pi-lens-ignore: " +
			"<rule>` comment into the source above the flagged line — rule is required for suppress.",
		promptSnippet:
			"Use lens_diagnostic_mark to dismiss a false-positive, suppress a won't-fix, defer, or flag a finding to fix later",
		parameters: Type.Object({
			filePath: Type.String({
				description: "The file the diagnostic was reported on (relative or absolute).",
			}),
			line: Type.Number({
				description: "The 1-based line the diagnostic was reported at.",
			}),
			message: Type.String({
				description: "The diagnostic's message, exactly as lens_diagnostics reported it.",
			}),
			rule: Type.Optional(
				Type.String({
					description:
						"The diagnostic's rule id, if it has one (shown in lens_diagnostics as [rule]). Required for disposition=suppress.",
				}),
			),
			tool: Type.Optional(
				Type.String({ description: "The tool that produced the diagnostic, if known." }),
			),
			disposition: Type.String({
				enum: DISPOSITIONS,
				description:
					"false-positive = the rule misfired. suppress = real finding, won't fix (writes an inline ignore comment). defer = fix later, this session only. flagged = mark for you to fix.",
			}),
			reason: Type.Optional(
				Type.String({ description: "Optional short reason, kept alongside the disposition." }),
			),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			const cwd = ctx.cwd ?? getCwd();
			const filePathArg = params.filePath;
			const line = params.line;
			const message = params.message;
			const disposition = params.disposition as Disposition;
			const rule = params.rule as string | undefined;
			const tool = params.tool as string | undefined;
			const reason = params.reason as string | undefined;

			if (
				typeof filePathArg !== "string" ||
				typeof line !== "number" ||
				typeof message !== "string" ||
				!DISPOSITIONS.includes(disposition as (typeof DISPOSITIONS)[number])
			) {
				return {
					content: [
						{
							type: "text" as const,
							text: "filePath, line, message, and a valid disposition are required.",
						},
					],
					isError: true,
					details: {},
				};
			}
			if (disposition === "suppress" && !rule) {
				return {
					content: [
						{
							type: "text" as const,
							text: "disposition=suppress requires `rule` — the inline pi-lens-ignore comment names a rule id.",
						},
					],
					isError: true,
					details: {},
				};
			}

			const absPath = path.isAbsolute(filePathArg)
				? filePathArg
				: path.resolve(cwd, filePathArg);

			let content: string;
			try {
				content = await fs.readFile(absPath, "utf-8");
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Could not read ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: {},
				};
			}

			if (disposition === "suppress") {
				let updated: string;
				try {
					// biome-ignore lint/style/noNonNullAssertion: validated above
					updated = insertSuppressComment(content, absPath, line, rule!);
				} catch (err) {
					return {
						content: [
							{
								type: "text" as const,
								text: err instanceof Error ? err.message : String(err),
							},
						],
						isError: true,
						details: {},
					};
				}
				await fs.writeFile(absPath, updated, "utf-8");
			}

			const anchor = markDisposition(
				cwd,
				{ cwd, filePath: absPath, tool, rule, message, line, content },
				disposition,
				reason,
			);

			const verb =
				disposition === "suppress"
					? `suppressed (inline pi-lens-ignore comment written above line ${line})`
					: disposition === "defer"
						? "deferred for this session"
						: disposition === "flagged"
							? "flagged to fix"
							: "marked false-positive";
			return {
				content: [
					{
						type: "text" as const,
						text: `${path.relative(cwd, absPath)}:${line} ${verb}.`,
					},
				],
				details: { anchor, disposition },
			};
		},
	};
}
