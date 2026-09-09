// Compact tool-result rendering (refs #345).
//
// The navigable/structural tools (module_report, read_symbol, read_enclosing,
// ast_grep_search, ast_grep_dump, ast_grep_outline) return large bodies that are
// useful to the MODEL but flood the user's terminal. The pi host renders a tool's
// `content` verbatim only when the tool defines no `renderResult` (the
// createResultFallback path in tool-execution.ts). By supplying a `renderResult`
// we decouple the two surfaces entirely:
//   - `content` (returned from execute) is unchanged -> the model still gets the
//     full payload.
//   - `renderResult` is TUI-only -> the user sees a one-line summary by default,
//     and the full output when the row is expanded (options.expanded), exactly
//     like the built-in read/grep/bash tools.
//
// Design borrowed from the community renderer extensions pi-tool-display and
// pi-claude-style-tools (summary-by-default + expand-on-demand), but scoped to
// pi-lens's own tools and driven off structured `details` rather than blind
// truncation. Those extensions default to respecting a tool's own renderResult
// (overrideExistingRenderers === false), so these renderers win and still coexist
// with a globally-installed renderer extension.

import { Text } from "../clients/deps/pi-tui.js";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getGlobalPiLensLogDir } from "../clients/probe-home-state.js";

const MAX_RESULT_BYTES = 40 * 1024;

export interface BoundedToolText {
	text: string;
	truncated: boolean;
	omittedCharacters: number;
	fullOutputPath?: string;
}

/** Bound model-facing result text while retaining both the useful head and tail. */
export function boundToolText(text: string): BoundedToolText {
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes <= MAX_RESULT_BYTES) {
		return { text, truncated: false, omittedCharacters: 0 };
	}

	const fullOutputPath = path.join(
		getGlobalPiLensLogDir(),
		`tool-result-${Date.now()}-${randomUUID()}.log`,
	);
	fs.mkdirSync(path.dirname(fullOutputPath), { recursive: true });
	fs.writeFileSync(fullOutputPath, text, "utf8");

	const marker = (omitted: number) =>
		`\n\n[${omitted} characters omitted. Full output: ${fullOutputPath}]\n\n`;
	const render = (kept: number): string => {
		const head = Math.floor(kept / 2);
		const tail = kept - head;
		return `${text.slice(0, head)}${marker(text.length - kept)}${text.slice(text.length - tail)}`;
	};
	// Find the largest retained slice without repeatedly rebuilding a large
	// string. Complete MCP tool renderings can be hundreds of kilobytes.
	let low = 0;
	let high = text.length;
	while (low < high) {
		const kept = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(render(kept), "utf8") <= MAX_RESULT_BYTES) low = kept;
		else high = kept - 1;
	}
	const output = render(low);
	return {
		text: output,
		truncated: true,
		omittedCharacters: text.length - low,
		fullOutputPath,
	};
}

/** Minimal shape of the tool result handed to renderResult — kept structural so
 * this helper does not depend on the exact AgentToolResult generic. */
export interface CompactResultLike<D = unknown> {
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
	details?: D;
}

interface CompactSummaryInput<D = unknown> {
	details: D | undefined;
	args: Record<string, unknown>;
	isError: boolean;
	/** Full model-facing text (all text content blocks joined). */
	text: string;
	/** Line count of the full text — handy for tools whose details lack counts. */
	lineCount: number;
}

export type CompactSummarizer<D = unknown> = (
	input: CompactSummaryInput<D>,
) => string;

/** How a rendered line should be styled. `brand` is pi-lens blue (our colour);
 * `error` and `output` defer to the active theme so red/normal stay legible. */
export type CompactStyle = "brand" | "error" | "output";

// pi-lens brand colour: blue characters on whatever background the pi tool shell
// paints (default success/error background is left untouched). Truecolor bold
// foreground, theme-independent so the summary reads as ours regardless of the
// active pi theme. We reset only the foreground (\x1b[39m) and bold (\x1b[22m) so
// the shell background still composites.
const PI_LENS_BLUE_FG = "\x1b[1m\x1b[38;2;96;165;250m"; // bold blue
const RESET_FG = "\x1b[39m\x1b[22m";

/** Join all text content blocks into the full model-facing string. */
export function fullTextOf(result: CompactResultLike): string {
	return (result.content ?? [])
		.filter(
			(c): c is { type: string; text: string } =>
				c.type === "text" && typeof c.text === "string",
		)
		.map((c) => c.text)
		.join("\n");
}

/**
 * Pure selection of what to display — exported separately so it can be unit
 * tested without constructing a TUI component or a Theme.
 */
export function selectCompactText<D = unknown>(
	result: CompactResultLike<D>,
	args: Record<string, unknown>,
	expanded: boolean,
	summarize: CompactSummarizer<D>,
): { text: string; style: CompactStyle } {
	const text = fullTextOf(result);
	if (expanded) {
		return {
			text: text || "(no output)",
			style: result.isError ? "error" : "output",
		};
	}
	const lineCount = text ? text.split("\n").length : 0;
	let summary: string;
	try {
		summary = summarize({
			details: result.details,
			args,
			isError: result.isError === true,
			text,
			lineCount,
		});
	} catch {
		// Never let a summarizer bug blank the row — fall back to the first line.
		summary = text.split("\n")[0] ?? "";
	}
	// Collapsed summaries render in pi-lens blue; errors stay theme-red.
	return { text: summary, style: result.isError ? "error" : "brand" };
}

/** Apply a CompactStyle to text. `brand` uses raw blue ANSI; the rest defer to
 * the theme so error-red and normal output stay consistent with the host. */
function paintCompact(style: CompactStyle, text: string, theme: Theme): string {
	if (style === "brand") {
		return `${PI_LENS_BLUE_FG}${text}${RESET_FG}`;
	}
	const color: ThemeColor = style === "error" ? "error" : "toolOutput";
	return theme.fg(color, text);
}

/**
 * Build a `renderResult` for a tool. `summarize` produces the one-line collapsed
 * view from the structured result; the expanded view shows the full payload.
 */
export function compactRenderResult<D = unknown>(
	summarize: CompactSummarizer<D>,
) {
	return (
		result: CompactResultLike<D>,
		options: { expanded: boolean },
		theme: Theme,
		context: { lastComponent?: unknown; args?: unknown },
	): Text => {
		const component =
			context.lastComponent instanceof Text
				? context.lastComponent
				: new Text("", 0, 0);
		const { text, style } = selectCompactText(
			result,
			(context.args ?? {}) as Record<string, unknown>,
			options.expanded === true,
			summarize,
		);
		component.setText(paintCompact(style, text, theme));
		return component;
	};
}

/** Shorten an absolute/relative path to its basename for the summary line. */
export function baseName(p: unknown): string {
	if (typeof p !== "string" || p.length === 0) return "";
	const parts = p.split(/[\\/]/);
	return parts[parts.length - 1] || p;
}
