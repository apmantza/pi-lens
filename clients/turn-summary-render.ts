/**
 * Renderer for the #484 turn-summary custom message
 * (`pilens:turn-summary`). Collapsed = one tool-grouped line (pi-lens brand
 * accent). Expanded = file-major: each touched file lists its
 * formats/autofixes/diagnostics with tool + rule id + line.
 *
 * `Component` construction is verified practical from an extension: it is
 * just `@earendil-works/pi-tui`'s `Component` interface —
 * `{ render(width: number): string[] }` — no framework object graph needed.
 * `pi-tui` is already a devDependency (package.json `@earendil-works/pi-tui`).
 */

import type {
	MessageRenderer,
	MessageRenderOptions,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "./deps/pi-tui.js";
import { fitLines } from "./tui-fit.js";
import {
	formatTurnSummaryLine,
	type TurnSummaryDetails,
	type TurnSummaryEvent,
} from "./turn-summary.js";

// `CustomMessage<T>` itself is not re-exported from the package root (only
// reachable via the internal extensions/types subpath, which package.json's
// `exports` map does not expose) — derive the message param type from the
// publicly exported `MessageRenderer<T>` function-type alias instead.
type TurnSummaryMessage = Parameters<MessageRenderer<TurnSummaryDetails>>[0];

function severityColor(
	theme: Theme,
	severity: TurnSummaryEvent["severity"],
): (s: string) => string {
	if (severity === "error") return (s) => theme.fg("error", s);
	if (severity === "warning") return (s) => theme.fg("warning", s);
	return (s) => theme.fg("dim", s);
}

function eventLine(theme: Theme, event: TurnSummaryEvent): string {
	const loc = event.line !== undefined ? `:${event.line}` : "";
	if (event.kind === "diagnostic") {
		const color = severityColor(theme, event.severity);
		const rule = event.ruleId ? ` ${event.ruleId}` : "";
		const desc = event.description ? ` — ${event.description}` : "";
		return `    ${color(`[${event.tool}${rule}]`)}${loc}${desc}`;
	}
	if (event.kind === "autofix") {
		const desc = event.description ? ` — ${event.description}` : "";
		return `    ${theme.fg("success", `[autofix:${event.tool}]`)}${loc}${desc}`;
	}
	return `    ${theme.fg("accent", `[format:${event.tool}]`)}`;
}

function buildExpandedLines(details: TurnSummaryDetails, theme: Theme): string[] {
	const lines: string[] = [];
	lines.push(theme.fg("accent", theme.bold("pi-lens turn summary")));
	const sortedFiles = [...details.files].sort((a, b) =>
		a.displayPath.localeCompare(b.displayPath),
	);
	for (const file of sortedFiles) {
		lines.push(`  ${theme.bold(file.displayPath)}`);
		// File-major: formats, then autofixes, then diagnostics — matches the
		// order things happen in the write pipeline (format → autofix → lint).
		const formats = file.events.filter((e) => e.kind === "format");
		const autofixes = file.events.filter((e) => e.kind === "autofix");
		const diagnostics = file.events.filter((e) => e.kind === "diagnostic");
		for (const event of [...formats, ...autofixes, ...diagnostics]) {
			lines.push(eventLine(theme, event));
		}
	}
	return lines;
}

export function renderTurnSummaryMessage(
	message: TurnSummaryMessage,
	options: MessageRenderOptions,
	theme: Theme,
): Component | undefined {
	const details = message.details;
	if (!details) return undefined;

	// pi-tui HARD-CRASHES the host on any rendered line wider than the
	// terminal, so every line must be fitted to the width the TUI hands us
	// (#513 — an untruncated collapsed one-liner took down a live session).
	if (!options.expanded) {
		const line = formatTurnSummaryLine(details);
		const text = theme.fg("accent", line);
		return {
			render: (width: number) => fitLines([text], width),
			invalidate: () => {},
		};
	}

	const lines = buildExpandedLines(details, theme);
	return {
		render: (width: number) => fitLines(lines, width),
		invalidate: () => {},
	};
}
