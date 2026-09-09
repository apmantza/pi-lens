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

/** Minimal shape of the tool result handed to renderResult — kept structural so
 * this helper does not depend on the exact AgentToolResult generic. */
export interface CompactResultLike<D = unknown> {
	content?: Array<{ type: string; text?: string }>;
	isError?: boolean;
	details?: D;
}

export interface ToolResultContractLike extends CompactResultLike {
	usage?: { tokens?: number; elapsedMs?: number };
}

/**
 * Add the stable, model-facing result footer shared by pi and MCP.
 *
 * The host adapters own transport and terminal styling; this function owns the
 * textual contract. Defaults are deliberately deterministic because elapsed
 * time is not a property of a projection and must not make parity tests flaky.
 */
export function renderToolResultContract<T extends ToolResultContractLike>(
	result: T,
): T {
	const content = result.content ?? [];
	const textBlocks = content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text);
	if (textBlocks.length === 0) return result;
	const text = textBlocks.join("\n");
	if (/^usage tokens=\d+ elapsed-ms=\d+$/m.test(text)) return result;
	const details = result.details as Record<string, unknown> | undefined;
	const diagnostics = Array.isArray(details?.diagnostics)
		? details.diagnostics
				.filter(
					(value): value is Record<string, unknown> =>
						Boolean(value) && typeof value === "object",
				)
				.map((diagnostic) => diagnostic.severity)
				.filter((severity): severity is string => typeof severity === "string")
				.map((severity) => `diag severity=${severity}`)
		: [];
	const tokens =
		result.usage?.tokens ?? Math.ceil(Buffer.byteLength(text, "utf8") / 4);
	const elapsedMs = result.usage?.elapsedMs ?? 0;
	const contractLines = [
		`result ${result.isError ? "error" : "ok"}`,
		...diagnostics,
		`usage tokens=${tokens} elapsed-ms=${elapsedMs}`,
	];
	let lastTextIndex = -1;
	for (let index = content.length - 1; index >= 0; index--) {
		const block = content[index];
		if (block?.type === "text" && typeof block.text === "string") {
			lastTextIndex = index;
			break;
		}
	}
	if (lastTextIndex < 0) return result;
	return {
		...result,
		content: content.map((block, index) =>
			index === lastTextIndex && block.type === "text"
				? { ...block, text: `${block.text}\n\n${contractLines.join("\n")}` }
				: block,
		),
	};
}

/** Build the shared text envelope used by both host adapters. */
export function renderToolText(
	summary: string,
	structured?: unknown,
	compact = false,
): { content: { type: "text"; text: string }[] } {
	const text =
		structured === undefined
			? summary
			: `${summary}\n\n\`\`\`json\n${JSON.stringify(structured, compact ? undefined : null, compact ? undefined : 2)}\n\`\`\``;
	return renderToolResultContract({
		content: [{ type: "text" as const, text }],
		details: structured,
	});
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
