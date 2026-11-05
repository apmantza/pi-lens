/**
 * The one byte/line bound on document content pi-lens hands a language server.
 *
 * #3405 r2 (M3406-1): this predicate used to exist twice — as a private
 * `exceedsLspSyncLimits` in `clients/pipeline.ts` and again inline in
 * `clients/dispatch/runners/lsp.ts` — so a THIRD writer could be added that
 * simply had neither. That is what happened: `tools/lsp-diagnostics.ts` reads a
 * whole file with `fs.readFileSync` and touches with it, and once the touch
 * could also carry `textDocument/didSave.text` (`includeText`), the same
 * unbounded string was serialized into a second JSON-RPC frame. Both callers now
 * ask this module, and so does the didSave payload seam, so the bound is one
 * constant pair in one place rather than a convention each new writer must
 * remember.
 *
 * The two established callers act on it by skipping their whole LSP step — a
 * file this large is not synced at all. That behaviour is deliberately NOT
 * folded in here: what a caller does at the bound is the caller's policy, and
 * `sendDidSave`'s is different (it drops the redundant `text` and still sends
 * the save, because the server already received these bytes in the didOpen or
 * didChange this save follows).
 *
 * #2066: the line count this predicate compares is
 * `clients/lsp/content-scan.ts`'s count-only entry point, not a `split("\n")`
 * of its own. The verdicts are unchanged, byte for byte — the split's length
 * was the `\n` count + 1 — and the split's allocation (one substring per line,
 * ~40 800 of them on a 1.95 MB document) is gone. The count needs no
 * terminator knowledge, so it stays native on EVERY document: asking the full
 * `scanDocumentContent` here instead paid that owner's per-character
 * `lastLine` loop for a number this predicate never reads, which made any
 * document holding a `\r` 4.6x to 5.5x slower to check than the split it
 * replaced (review F1).
 */

import {
	getGlobalLspQueryMaxFileLines,
	LSP_QUERY_MAX_FILE_LINES_MAX,
} from "../lens-config.js";
import { RUNTIME_CONFIG } from "../runtime-config.js";
import { countLfNewlines } from "./content-scan.js";

const LSP_MAX_FILE_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const LSP_MAX_FILE_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;

export interface LspContentLimitVerdict {
	tooLarge: boolean;
	/** Human-readable measurement, empty when within the bound. */
	reason: string;
	/** Which bound tripped; absent when within both. */
	bound?: "bytes" | "lines";
}

export function exceedsLspSyncLimits(
	content: string,
	maxLines: number = LSP_MAX_FILE_LINES,
): LspContentLimitVerdict {
	const sizeBytes = Buffer.byteLength(content, "utf-8");
	if (sizeBytes > LSP_MAX_FILE_BYTES) {
		return {
			tooLarge: true,
			reason: `${sizeBytes} bytes > ${LSP_MAX_FILE_BYTES} limit`,
			bound: "bytes",
		};
	}

	// #2066: the count is the document's `\n` occurrences + 1 — exactly what
	// `content.split("\n").length` returned, including every one of its
	// conventions: `\n` is the only separator (a lone-CR document has no `\n`,
	// so it is ONE line here, as it always was), a trailing `\n` adds one more,
	// empty, line, and the comparison below stays a strict `>`. The split built
	// one substring per line to count them (1.18 ms and a 40 814-element array on
	// a 1.95 MB document, measured through this function); the native count
	// allocates nothing and costs a CRLF document what it costs an LF one.
	const lineCount = countLfNewlines(content) + 1;
	if (lineCount > maxLines) {
		return {
			tooLarge: true,
			reason: `${lineCount} lines > ${maxLines} limit`,
			bound: "lines",
		};
	}

	return { tooLarge: false, reason: "" };
}

/**
 * The bound for the explicit single-file `lens_diagnostics source=lsp` query
 * (#5306): the shared bound, except that the line limit is the global
 * `lsp.queryMaxFileLines` key. Read from the GLOBAL config only, so neither a
 * tool argument nor a project file can raise it, and read only after the shared
 * bound refused the file, so a query under it never touches the config. A
 * refusal for lines names the key (a byte refusal cannot be raised, and a limit
 * already at the key's ceiling has nothing left to offer).
 */
export function exceedsExplicitQueryLimits(
	content: string,
): LspContentLimitVerdict {
	const shared = exceedsLspSyncLimits(content);
	if (shared.bound !== "lines") return shared;
	const maxLines = getGlobalLspQueryMaxFileLines() ?? LSP_MAX_FILE_LINES;
	const verdict = exceedsLspSyncLimits(content, maxLines);
	if (!verdict.tooLarge || maxLines >= LSP_QUERY_MAX_FILE_LINES_MAX) {
		return verdict;
	}
	return {
		...verdict,
		reason: `${verdict.reason}; this single-file query can raise its line limit with lsp.queryMaxFileLines in the user-level pi-lens config (up to ${LSP_QUERY_MAX_FILE_LINES_MAX})`,
	};
}
