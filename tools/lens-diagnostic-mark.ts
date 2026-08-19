/**
 * lens_diagnostic_mark — agent-facing disposition operation (#690, unifying
 * #181/#503/#504's discussion into one triage layer).
 *
 * Five dispositions, given the exact filePath/rule/message/line a
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
 *
 * #802: the caller-supplied `line` is NOT trusted as-is anymore — it's the
 * line a (possibly stale) lens_diagnostics call reported, and the file may
 * have moved on since (an earlier edit, a prior suppress in the same batch
 * shifting later lines down). Before writing anything, `verifyLine` below
 * cross-checks it against live per-file diagnostics recorded in
 * clients/widget-state.ts (same tool/rule/normalizedMessage — reusing
 * diagnostic-dispositions.ts's own normalizer so a match here agrees with the
 * anchor derivation) and reanchors to the CURRENT line when it differs. Where
 * widget-state has nothing for this exact finding, a conservative fuzzy
 * fallback accepts the caller's line if it's in-bounds and non-blank, else
 * searches a small window around it for the nearest non-blank line. See
 * verifyLine's doc for the failure-mode contract (false-positive/defer/
 * flagged degrade to today's trust-the-caller behavior on an internal error;
 * suppress never writes at an unverified position).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Type } from "../clients/deps/typebox.js";
import {
	markDisposition,
	normalizeMessage,
	type Disposition,
} from "../clients/diagnostic-dispositions.js";
import { insertSuppressComment } from "../clients/dispatch/suppress-writer.js";
import {
	getFileDiagnostics,
	type WidgetDiagnostic,
} from "../clients/widget-state.js";

const DISPOSITIONS = [
	"false-positive",
	"suppress",
	"defer",
	"flagged",
	"info",
] as const;

// How far ± the caller's line the fuzzy fallback searches for a plausible
// (non-blank) line when there's no widget-state match to reanchor from.
const FUZZY_SEARCH_RADIUS = 5;

function isBlank(text: string | undefined): boolean {
	return text === undefined || text.trim().length === 0;
}

/**
 * Look for a live widget-state diagnostic on this file matching
 * tool/rule/normalizedMessage, and return the line it's CURRENTLY recorded
 * at. Never throws — any lookup failure (widget-state unavailable, malformed
 * record) is treated identically to "no match", which safely falls through
 * to the fuzzy fallback below.
 *
 * Multiple matches (same rule/message on different lines, e.g. a copy-pasted
 * violation) are ambiguous; per #802 this picks the match CLOSEST to the
 * caller's line rather than guessing — the conservative choice for suppress,
 * which must never place a comment above the wrong site.
 */
function widgetCrossCheck(
	absPath: string,
	tool: string | undefined,
	rule: string | undefined,
	message: string,
	callerLine: number,
): { line: number; ambiguous: boolean } | undefined {
	let diagnostics: WidgetDiagnostic[] | undefined;
	try {
		diagnostics = getFileDiagnostics(absPath);
	} catch {
		return undefined;
	}
	if (!diagnostics || diagnostics.length === 0) return undefined;
	const normalized = normalizeMessage(message);
	const matches = diagnostics.filter(
		(d): d is WidgetDiagnostic & { line: number } =>
			d.line !== undefined &&
			normalizeMessage(d.message) === normalized &&
			(rule === undefined || d.rule === rule) &&
			(tool === undefined || d.tool === tool),
	);
	if (matches.length === 0) return undefined;
	if (matches.length === 1) return { line: matches[0].line, ambiguous: false };
	const closest = matches.reduce(
		(best, d) =>
			Math.abs(d.line - callerLine) < Math.abs(best.line - callerLine) ? d : best,
		matches[0],
	);
	return { line: closest.line, ambiguous: true };
}

/**
 * No widget-state match — accept the caller's line as-is if it's in bounds
 * and non-blank (today's behavior, unchanged); otherwise search outward for
 * the nearest non-blank line within FUZZY_SEARCH_RADIUS. Returns undefined
 * when nothing plausible is nearby (caller must be told to re-run
 * lens_diagnostics rather than write at a guessed position).
 */
function fuzzyReanchor(
	lines: string[],
	callerLine: number,
): { line: number; reanchored: boolean } | undefined {
	if (
		callerLine >= 1 &&
		callerLine <= lines.length &&
		!isBlank(lines[callerLine - 1])
	) {
		return { line: callerLine, reanchored: false };
	}
	for (let offset = 1; offset <= FUZZY_SEARCH_RADIUS; offset++) {
		for (const candidate of [callerLine - offset, callerLine + offset]) {
			if (candidate < 1 || candidate > lines.length) continue;
			if (!isBlank(lines[candidate - 1])) {
				return { line: candidate, reanchored: true };
			}
		}
	}
	return undefined;
}

type LineVerification =
	| { line: number; reanchored: boolean; note?: string }
	| { error: string };

/**
 * Verify/reanchor the caller's line against the file's CURRENT content
 * (#802). By construction this function never throws — the widget cross-
 * check and the fuzzy fallback are each internally defensive — so a caller
 * doesn't need to guess whether a thrown exception happened before or after
 * a "the line is wrong" determination; there's always a definitive returned
 * result.
 */
function verifyLine(
	content: string,
	absPath: string,
	tool: string | undefined,
	rule: string | undefined,
	message: string,
	callerLine: number,
): LineVerification {
	const lines = content.split(/\r?\n/);

	let widgetResult: { line: number; ambiguous: boolean } | undefined;
	try {
		widgetResult = widgetCrossCheck(absPath, tool, rule, message, callerLine);
	} catch {
		widgetResult = undefined;
	}
	if (widgetResult !== undefined) {
		const reanchored = widgetResult.line !== callerLine;
		return {
			line: widgetResult.line,
			reanchored,
			note: reanchored
				? `reanchored from line ${callerLine} to ${widgetResult.line}` +
					(widgetResult.ambiguous ? " (multiple live matches, chose nearest)" : "") +
					" against current diagnostics"
				: undefined,
		};
	}

	try {
		const fuzzy = fuzzyReanchor(lines, callerLine);
		if (!fuzzy) {
			return {
				error:
					`line ${callerLine} looks stale (out of range or blank, and no diagnostic ` +
					"match was found nearby) — re-run lens_diagnostics and retry with the current line.",
			};
		}
		return {
			line: fuzzy.line,
			reanchored: fuzzy.reanchored,
			note: fuzzy.reanchored
				? `reanchored from line ${callerLine} to ${fuzzy.line} (nearest non-blank line)`
				: undefined,
		};
	} catch {
		return {
			error: `could not verify line ${callerLine} — re-run lens_diagnostics and retry.`,
		};
	}
}

export function createLensDiagnosticMarkTool(
	getCwd: () => string,
	/** Runtime telemetry identity, when known (#1448 class sweep) — attributed
	 * onto the disposition log alongside the mark. */
	getIdentity?: () => { model?: string; provider?: string },
) {
	return {
		name: "lens_diagnostic_mark" as const,
		label: "Mark Diagnostic",
		description:
			"Record a disposition for a lens_diagnostics finding, using the exact filePath/rule/message/line " +
			"it was reported with. false-positive/suppress/info persist across sessions; defer lasts only for the " +
			"current session (resurfaces next time); flagged marks it for you to come back and fix, and shows " +
			"up tagged in a later lens_diagnostics mode=full. suppress additionally writes a `pi-lens-ignore: " +
			"<rule>` comment into the source above the flagged line — rule is required for suppress. info " +
			"filters from steering/injection without an inline comment. " +
			"The line is verified/reanchored against current diagnostics before writing (#802): if a live " +
			"diagnostic for this tool/rule/message is now at a different line, that line is used instead of " +
			"the one you passed. When suppressing several findings in the SAME file in one turn, work " +
			"bottom-up (highest line number first) — each inserted comment shifts later lines down by one, " +
			"and reanchoring can't always disambiguate two nearby findings.",
		promptSnippet:
			"Use lens_diagnostic_mark to dismiss a false-positive, suppress a won\'t-fix, defer, flag a finding to fix later, or mark as info only",
		parameters: Type.Object({
			filePath: Type.String({
				description:
					"The file the diagnostic was reported on (relative or absolute).",
			}),
			line: Type.Number({
				description: "The 1-based line the diagnostic was reported at.",
			}),
			message: Type.String({
				description:
					"The diagnostic's message, exactly as lens_diagnostics reported it.",
			}),
			rule: Type.Optional(
				Type.String({
					description:
						"The diagnostic's rule id, if it has one (shown in lens_diagnostics as [rule]). Required for disposition=suppress.",
				}),
			),
			tool: Type.Optional(
				Type.String({
					description: "The tool that produced the diagnostic, if known.",
				}),
			),
			disposition: Type.String({
				enum: DISPOSITIONS,
				description:
					"false-positive = the rule misfired. suppress = real finding, won\'t fix (writes an inline ignore comment). defer = fix later, this session only. flagged = mark for you to fix. info = real finding, informational only (filters from steering/injection, no inline comment).",
			}),
			reason: Type.Optional(
				Type.String({
					description: "Optional short reason, kept alongside the disposition.",
				}),
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
							text:
								"disposition=suppress requires `rule` — the inline pi-lens-ignore comment names a rule id.",
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

			// #802: verify/reanchor before anything is written. `verifyLine` never
			// throws by construction (see its doc), but this is still wrapped so an
			// unforeseen failure can never leave `verifiedLine` in an inconsistent
			// state — on any exception here, suppress refuses to write (the failure
			// mode that must stay safe) while false-positive/defer/flagged fall back
			// to trusting the caller's line, matching today's pre-#802 behavior.
			let verifiedLine = line;
			let reanchorNote: string | undefined;
			try {
				const verification = verifyLine(
					content,
					absPath,
					tool,
					rule,
					message,
					line,
				);
				if ("error" in verification) {
					if (disposition === "suppress") {
						return {
							content: [
								{
									type: "text" as const,
									text: `Refusing to suppress at ${path.relative(cwd, absPath)}:${line} — ${verification.error}`,
								},
							],
							isError: true,
							details: {},
						};
					}
					// false-positive/defer/flagged/info: same worst-case as before #802 — a
					// stale line produces a rotted (never-matching) anchor rather than a
					// blocked mark.
				} else {
					verifiedLine = verification.line;
					reanchorNote = verification.note;
				}
			} catch {
				if (disposition === "suppress") {
					return {
						content: [
							{
								type: "text" as const,
								text: `Refusing to suppress at ${path.relative(cwd, absPath)}:${line} — could not verify the line; re-run lens_diagnostics and retry.`,
							},
						],
						isError: true,
						details: {},
					};
				}
			}

			if (disposition === "suppress") {
				let updated: string;
				try {
					// biome-ignore lint/style/noNonNullAssertion: validated above
					updated = insertSuppressComment(content, absPath, verifiedLine, rule!);
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
				{
					cwd,
					filePath: absPath,
					tool,
					rule,
					message,
					line: verifiedLine,
					content,
				},
				disposition,
				reason,
				getIdentity?.(),
			);

			const verb =
				disposition === "suppress"
					? `suppressed (inline pi-lens-ignore comment written above line ${verifiedLine})`
					: disposition === "defer"
						? "deferred for this session"
						: disposition === "flagged"
							? "flagged to fix"
							: disposition === "info"
								? "marked info (filtered from steering/injection)"
								: "marked false-positive";
			const reanchorSuffix = reanchorNote ? ` (${reanchorNote})` : "";
			return {
				content: [
					{
						type: "text" as const,
						text: `${path.relative(cwd, absPath)}:${verifiedLine} ${verb}.${reanchorSuffix}`,
					},
				],
				details: { anchor, disposition, line: verifiedLine },
			};
		},
	};
}
