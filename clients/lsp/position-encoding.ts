/**
 * LSP position-encoding negotiation (#269).
 *
 * LSP positions are `(line, character)` where `character` is an offset into the
 * line measured in code units of the negotiated `positionEncoding`. The pre-3.17
 * default — and what callers hand us — is UTF-16. LSP 3.17 lets a server pick a
 * different encoding via `ServerCapabilities.positionEncoding`; some servers
 * (rust-analyzer ≥ 2024, recent gopls) prefer UTF-8. If we keep sending UTF-16
 * offsets to a UTF-8 server, every `character` past a multibyte glyph on the
 * line is wrong, and navigation silently lands on the wrong column.
 *
 * This module is the pure core: pick the encoding from the server's reply, and
 * translate a UTF-16 character offset to the negotiated encoding using the
 * line's text. UTF-16 is the identity (and the hot path — no work, no I/O).
 */

export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";

/** Encodings we advertise to servers, in preference order (UTF-16 first to keep
 *  the historical default unless a server explicitly wants otherwise). */
export const ADVERTISED_POSITION_ENCODINGS: readonly PositionEncoding[] = [
	"utf-16",
	"utf-8",
];

/**
 * The encoding the server will use, read from its initialize reply. Defaults to
 * UTF-16 when the server doesn't advertise one (pre-3.17 behaviour). An
 * unrecognised value also falls back to UTF-16 — safer than guessing.
 */
export function negotiatePositionEncoding(
	serverCapabilities: unknown,
): PositionEncoding {
	const raw = (
		serverCapabilities as { positionEncoding?: unknown } | null | undefined
	)?.positionEncoding;
	if (raw === "utf-8" || raw === "utf-16" || raw === "utf-32") return raw;
	return "utf-16";
}

/**
 * Convert a UTF-16 character offset within `lineText` to the negotiated
 * encoding's offset. UTF-16 is the identity. UTF-8 counts bytes; UTF-32 counts
 * Unicode code points. An offset past the end of the line is clamped to the
 * line length (in the source UTF-16 units) before conversion.
 */
export function convertCharacterOffset(
	encoding: PositionEncoding,
	lineText: string,
	utf16Character: number,
): number {
	if (encoding === "utf-16") return utf16Character;
	if (utf16Character <= 0) return 0;
	// Slice in UTF-16 units (JS string semantics), then re-measure the prefix in
	// the target encoding's units.
	const clamped = Math.min(utf16Character, lineText.length);
	const prefix = lineText.slice(0, clamped);
	if (encoding === "utf-8") return Buffer.byteLength(prefix, "utf8");
	// utf-32: number of Unicode code points (spread iterates by code point).
	return [...prefix].length;
}

/** Extract the text of a single 0-based line from full file content. */
export function lineTextAt(content: string, line: number): string {
	if (line < 0) return "";
	// Split on \n; trailing \r is irrelevant to offset math (it's after the
	// character columns the caller cares about, and never multibyte).
	const lines = content.split("\n");
	return lines[line] ?? "";
}
