// Compact tool-result rendering (refs #345).
//
// The navigable/structural tools (module_report, read_symbol, read_enclosing,
// ast_grep_search, ast_grep_outline) return large bodies that are
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
import { recordDegradationOnce } from "../clients/degradation-ledger.js";
import { getGlobalPiLensLogDir } from "../clients/probe-home-state.js";

/** The per-result delivery bound (#2848). Exported so surface gates and their
 * pins assert the real budget instead of restating the literal. */
export const MAX_RESULT_BYTES = 40 * 1024;
// 2026-09-10: cap the complete MCP payload before it can retain or log an
// unbounded result; ordinary results keep the complete-log contract below it.
export const COMPLETE_MCP_RESULT_INPUT_BUDGET_BYTES = 8 * 1024 * 1024;

// #2800 item 7: the footer is stamped AFTER the payload bound, so the
// footer's own maximum size is reserved inside MAX_RESULT_BYTES. The reserve
// is computed from the footer's widest literal: the `result error` verdict, a
// bounded diag severity section, and maximum-width numeric fields with the
// wider `truncated=false` value.
const FOOTER_MAX_DIGITS = String(Number.MAX_SAFE_INTEGER).length;
/** One `diag severity=` line is width-bounded so the footer's maximum size
 * stays finite and the reserve above stays sound. */
const FOOTER_DIAG_LINE_MAX_CHARS = 200;
const FOOTER_DIAG_SECTION_MAX_BYTES = 1024;

export const RESULT_FOOTER_RESERVE_BYTES = Buffer.byteLength(
	`\n\nresult error\n${"x".repeat(FOOTER_DIAG_SECTION_MAX_BYTES)}\nusage tokens=${"9".repeat(FOOTER_MAX_DIGITS)} elapsed-ms=${"9".repeat(FOOTER_MAX_DIGITS)} bytes=${"9".repeat(FOOTER_MAX_DIGITS)} truncated=false`,
	"utf8",
);

/** The payload byte budget the footer is stamped into: the delivered result
 * budget minus the reserved footer maximum (#2800 item 7). */
export const RESULT_PAYLOAD_BUDGET_BYTES =
	MAX_RESULT_BYTES - RESULT_FOOTER_RESERVE_BYTES;

export interface BoundedToolText {
	text: string;
	truncated: boolean;
	omittedCharacters: number;
	fullOutputPath?: string;
}

interface RenderedHeadTail {
	text: string;
	keptCharacters: number;
}

function renderHeadTail(
	text: string,
	maxBytes: number,
	markerFor: (head: number, tail: number) => string,
): RenderedHeadTail {
	const render = (kept: number): string => {
		const head = Math.floor(kept / 2);
		const tail = kept - head;
		return `${text.slice(0, head)}${markerFor(head, tail)}${text.slice(text.length - tail)}`;
	};
	let low = 0;
	let high = text.length;
	while (low < high) {
		const kept = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(render(kept), "utf8") <= maxBytes) low = kept;
		else high = kept - 1;
	}
	return { text: render(low), keptCharacters: low };
}

/** Bound model-facing result text while retaining both the useful head and tail.
 * `maxBytes` defaults to the full result budget; the footer gate passes the
 * payload budget that leaves room for the stamped footer (#2800 item 7). */
export function boundToolText(
	text: string,
	maxBytes: number = MAX_RESULT_BYTES,
): BoundedToolText {
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes <= maxBytes) {
		return { text, truncated: false, omittedCharacters: 0 };
	}

	const fullOutputPath = path.join(
		getGlobalPiLensLogDir(),
		`tool-result-${Date.now()}-${randomUUID()}.log`,
	);
	fs.mkdirSync(path.dirname(fullOutputPath), { recursive: true });

	if (totalBytes > COMPLETE_MCP_RESULT_INPUT_BUDGET_BYTES) {
		const omittedBytes = totalBytes - COMPLETE_MCP_RESULT_INPUT_BUDGET_BYTES;
		recordDegradationOnce({
			kind: "mcp-complete-result-budget-exceeded",
			subject: "complete-result",
			reason: `${totalBytes} input bytes exceeded ${COMPLETE_MCP_RESULT_INPUT_BUDGET_BYTES}-byte budget`,
			metadata: {
				totalBytes,
				budgetBytes: COMPLETE_MCP_RESULT_INPUT_BUDGET_BYTES,
			},
		});
		const logText = renderHeadTail(
			text,
			COMPLETE_MCP_RESULT_INPUT_BUDGET_BYTES,
			(head, tail) => {
				const keptBytes = Buffer.byteLength(
					`${text.slice(0, head)}${text.slice(text.length - tail)}`,
					"utf8",
				);
				return `\n\n[incomplete: ${totalBytes - keptBytes} bytes omitted, budget ${COMPLETE_MCP_RESULT_INPUT_BUDGET_BYTES}]\n\n[Full output: ${fullOutputPath}]\n\n`;
			},
		);
		fs.writeFileSync(fullOutputPath, logText.text, "utf8");
		const output = renderHeadTail(
			logText.text,
			maxBytes,
			() =>
				`\n\n[incomplete: ${omittedBytes} bytes omitted, budget ${COMPLETE_MCP_RESULT_INPUT_BUDGET_BYTES}]\n\n[Full output: ${fullOutputPath}]\n\n`,
		);
		return {
			text: output.text,
			truncated: true,
			omittedCharacters: text.length - logText.keptCharacters,
			fullOutputPath,
		};
	}

	fs.writeFileSync(fullOutputPath, text, "utf8");
	const output = renderHeadTail(
		text,
		maxBytes,
		(head, tail) =>
			`\n\n[${text.length - head - tail} characters omitted. Full output: ${fullOutputPath}]\n\n`,
	);
	return {
		text: output.text,
		truncated: true,
		omittedCharacters: text.length - output.keptCharacters,
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

export interface ToolResultContractLike extends CompactResultLike {
	usage?: { tokens?: number; elapsedMs?: number };
}

/** The one result type every pi-lens tool result conforms to (refs #2800).
 * `isError` is required, so a tool's inferred execute union can never drop the
 * flag and a test reading `result.isError` type-checks without a cast. */
export interface LensToolResult<D = unknown> extends CompactResultLike<D> {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
	details: D;
}

/** Matches an already-stamped contract footer at the end of the joined text.
 * A result re-entering the gate must not gain a second footer (refs #2852 N4).
 * The byte and truncated groups let the gate read the kept footer's own
 * delivery figures on re-entry (round 2 F1). */
const CONTRACT_FOOTER_TAIL_RE =
	/(?:^|\n)result (?:ok|error)\n(?:diag severity=[^\n]*\n)*usage tokens=\d+ elapsed-ms=\d+ bytes=(\d+) truncated=(true|false)$/;

/** Optional delivery figures the footer reports when the caller has already
 * bounded the payload (#2800 item 7). Absent on a direct stamp of an unbound
 * result, where the input text IS the delivered payload. */
export interface ToolResultDeliveryStats {
	bytes: number;
	truncated: boolean;
}

/**
 * Add the stable, model-facing result footer shared by pi and MCP.
 *
 * The host adapters own transport and terminal styling; this function owns the
 * textual contract. Defaults are deliberately deterministic because elapsed
 * time is not a property of a projection and must not make parity tests flaky.
 * Idempotent: a result whose text already ends with the footer is only
 * `isError`-normalized, never stamped twice.
 *
 * When `delivery` is given (the gate path), `bytes=`/`truncated=` describe the
 * already-bound payload; otherwise they describe this function's input text,
 * which is the delivered payload because no bound has run.
 */
export function renderToolResultContract<T extends ToolResultContractLike>(
	result: T,
	delivery?: ToolResultDeliveryStats,
): T {
	const normalized = {
		...result,
		isError: result.isError === true,
	} as T;
	const content = result.content ?? [];
	const textBlocks = content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text);
	if (textBlocks.length === 0) return normalized;
	const text = textBlocks.join("\n");
	if (CONTRACT_FOOTER_TAIL_RE.test(text)) return normalized;
	const details = normalized.details as Record<string, unknown> | undefined;
	// The diag section is width- and byte-bounded (#2800 item 7) so the
	// footer's maximum size — and therefore the reserved budget above — stays
	// finite regardless of how many diagnostics a result carries.
	const diagLines: string[] = [];
	let diagSectionBytes = 0;
	if (Array.isArray(details?.diagnostics)) {
		for (const value of details.diagnostics) {
			if (!value || typeof value !== "object") continue;
			const severity = (value as Record<string, unknown>).severity;
			if (typeof severity !== "string") continue;
			const line = `diag severity=${severity.slice(0, FOOTER_DIAG_LINE_MAX_CHARS)}`;
			const lineBytes = Buffer.byteLength(line, "utf8") + 1;
			if (diagSectionBytes + lineBytes > FOOTER_DIAG_SECTION_MAX_BYTES) break;
			diagLines.push(line);
			diagSectionBytes += lineBytes;
		}
	}
	const tokens =
		normalized.usage?.tokens ?? Math.ceil(Buffer.byteLength(text, "utf8") / 4);
	const elapsedMs = normalized.usage?.elapsedMs ?? 0;
	const deliveredBytes = delivery?.bytes ?? Buffer.byteLength(text, "utf8");
	const truncated = delivery?.truncated === true;
	const contractLines = [
		`result ${normalized.isError ? "error" : "ok"}`,
		...diagLines,
		`usage tokens=${tokens} elapsed-ms=${elapsedMs} bytes=${deliveredBytes} truncated=${truncated ? "true" : "false"}`,
	];
	let lastTextIndex = -1;
	for (let index = content.length - 1; index >= 0; index--) {
		const block = content[index];
		if (block?.type === "text" && typeof block.text === "string") {
			lastTextIndex = index;
			break;
		}
	}
	if (lastTextIndex < 0) return normalized;
	return {
		...normalized,
		content: content.map((block, index) =>
			index === lastTextIndex && block.type === "text"
				? { ...block, text: `${block.text}\n\n${contractLines.join("\n")}` }
				: block,
		),
	};
}

/** Bound the payload text blocks so the footer stamped afterwards still fits
 * inside MAX_RESULT_BYTES (refs #2800 item 7): each block is bounded to the
 * result budget minus the reserved footer maximum, and the delivered byte
 * count plus the bound's truncated flag travel with the result so the footer
 * can report them. Per-block bounding is inherited from #2852; production
 * results carry a single text block (renderToolText). */
export function boundResultPayload<T extends CompactResultLike>(
	result: T,
): { result: T; deliveredBytes: number; truncated: boolean } {
	if (!result.content) {
		return { result, deliveredBytes: 0, truncated: false };
	}
	const joined = fullTextOf(result);
	// The footer depends on this result's actual error, diagnostics, usage, and
	// delivered byte count. Iterate to the fixed point so ordinary results do not
	// reserve the widest possible footer, while the final bound remains sound.
	let payloadBudget = RESULT_PAYLOAD_BUDGET_BYTES;
	let bound = boundToolText(joined, payloadBudget);
	for (let i = 0; i < 3; i++) {
		const probe = renderToolResultContract(
			{ ...result, content: [{ type: "text" as const, text: bound.text }] },
			{
				bytes: Buffer.byteLength(bound.text, "utf8"),
				truncated: bound.truncated,
			},
		);
		const footerStart = fullTextOf(probe).indexOf("\n\nresult ");
		const footerBytes = Buffer.byteLength(
			fullTextOf(probe).slice(footerStart),
			"utf8",
		);
		payloadBudget = MAX_RESULT_BYTES - footerBytes;
		bound = boundToolText(joined, payloadBudget);
	}
	const firstText = result.content.findIndex(
		(block) => block.type === "text" && typeof block.text === "string",
	);
	let retainedText = false;
	const content = result.content
		.filter(
			(block, index) =>
				block.type !== "text" ||
				typeof block.text !== "string" ||
				index === firstText,
		)
		.map((block) => {
			if (
				block.type === "text" &&
				typeof block.text === "string" &&
				!retainedText
			) {
				retainedText = true;
				return { ...block, text: bound.text };
			}
			return block;
		});
	const deliveredBytes = Buffer.byteLength(fullTextOf({ content }), "utf8");
	return {
		result: { ...result, content },
		deliveredBytes,
		truncated: bound.truncated,
	};
}

/** Build the raw result envelope shared by both host adapters: the summary is
 * joined with the structured payload's fenced JSON, and the payload also rides
 * along as `details` for surface-side consumers (pi's compact-line summarizer,
 * the MCP gate's `diag severity=` footer lines). The contract footer and the
 * #2848 byte bound are NOT applied here — each surface stamps them once, after
 * the tool's own result exists (`finalizeToolResult` / the MCP dispatcher). */
export function renderToolText(
	summary: string,
	structured?: unknown,
	compact = false,
): {
	content: { type: "text"; text: string }[];
	details?: unknown;
} {
	const rawText =
		structured === undefined
			? summary
			: `${summary}\n\n\`\`\`json\n${JSON.stringify(structured, compact ? undefined : null, compact ? undefined : 2)}\n\`\`\``;
	return {
		content: [{ type: "text" as const, text: rawText }],
		details: structured,
	};
}

/** Drop the structured `details` field from a finished result. The MCP gate
 * consumes `details` for the footer's `diag severity=` lines and then strips
 * it before delivery, so the wire carries only the bounded text blocks
 * (refs #2852 N1); pi keeps `details` for its compact-line summarizer. */
export function stripResultDetails<T extends CompactResultLike>(result: T): T {
	const { details: _details, ...rest } = result;
	return rest as T;
}

/** What the gate returns alongside the finished result: the figures the
 * per-turn cache_usage row aggregates (#2800 item 7). */
export interface FinalizedToolDelivery<T> {
	result: T;
	deliveredBytes: number;
	truncated: boolean;
}

/** Finish a host-adapter result after its status and all warnings exist
 * (#2800 item 7): the payload bound runs FIRST with the footer's own maximum
 * size reserved inside MAX_RESULT_BYTES, then the footer is stamped LAST with
 * the delivered payload's byte count and the bound's truncated flag. So
 * `bytes=`/`truncated=` describe what the model actually receives, and the
 * delivered text — footer included — never exceeds MAX_RESULT_BYTES.
 *
 * Re-entry (refs #2852 N4, round 2 F1): the bound still runs on an
 * already-stamped result — master applied the bound after the stamp-skip, and
 * the kept tail carries the footer through it — so re-entry is never delivered
 * unbounded. A stamped result within the delivered budget is kept as-is; the
 * figures are the kept footer's own prior values, never a footer-inclusive
 * re-measure and never a hard-coded `false`. */
export function finalizeToolResultWithDelivery<
	T extends ToolResultContractLike,
>(result: T): FinalizedToolDelivery<T> {
	const normalized = { ...result, isError: result.isError === true } as T;
	const existingText = fullTextOf(normalized);
	const existingFooter = CONTRACT_FOOTER_TAIL_RE.exec(existingText);
	if (
		existingFooter &&
		Buffer.byteLength(existingText, "utf8") <= MAX_RESULT_BYTES
	) {
		return {
			result: normalized,
			deliveredBytes: Number(existingFooter[1]),
			truncated: existingFooter[2] === "true",
		};
	}
	const bound = boundResultPayload(normalized);
	const text = fullTextOf(bound.result);
	const keptFooter = CONTRACT_FOOTER_TAIL_RE.exec(text);
	if (keptFooter) {
		// The bound ran and the kept tail still carries the footer, so there is
		// nothing to stamp; the kept footer's figures stay the delivery
		// contract (row 6: prior value kept).
		return {
			result: bound.result,
			deliveredBytes: Number(keptFooter[1]),
			truncated: keptFooter[2] === "true",
		};
	}
	const stamped = renderToolResultContract(bound.result, {
		bytes: bound.deliveredBytes,
		truncated: bound.truncated,
	});
	return {
		result: stamped,
		deliveredBytes: bound.deliveredBytes,
		truncated: bound.truncated,
	};
}

/** Finish a host-adapter result after its status and all warnings exist. */
export function finalizeToolResult<T extends ToolResultContractLike>(
	result: T,
): T {
	return finalizeToolResultWithDelivery(result).result;
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
