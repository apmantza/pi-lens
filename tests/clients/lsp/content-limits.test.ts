/**
 * #3405 round 2: both branches of the ONE bound on document content pi-lens
 * hands a language server.
 *
 * Recurrence this file prevents: the byte and line bounds used to be duplicated
 * (a private function in `clients/pipeline.ts`, an inline copy in
 * `clients/dispatch/runners/lsp.ts`) and neither copy had a test of its own —
 * so folding them into one module would have left the shared predicate's two
 * branches mutation-inert, with every consumer's coverage coming from fixtures
 * that happened to trip whichever branch first. Review finding M3406-1 is the
 * cost of that: a third writer was added with no bound at all.
 */

import { describe, expect, it } from "vitest";
import {
	exceedsExplicitQueryLimits,
	exceedsLspSyncLimits,
} from "../../../clients/lsp/content-limits.js";
import { LSP_QUERY_MAX_FILE_LINES_MIN } from "../../../clients/lens-config.js";
import { RUNTIME_CONFIG } from "../../../clients/runtime-config.js";
import { useGlobalConfig } from "../../support/global-config.js";

const MAX_BYTES = RUNTIME_CONFIG.pipeline.lspMaxFileBytes;
const MAX_LINES = RUNTIME_CONFIG.pipeline.lspMaxFileLines;

describe("exceedsLspSyncLimits (#3405 r2)", () => {
	it("refuses a document past the byte bound, on few lines", () => {
		// The minified-bundle shape: the LINE bound is nowhere near tripped, so
		// this case can only fail on bytes.
		const verdict = exceedsLspSyncLimits(`${"x".repeat(MAX_BYTES + 1)}\n`);
		expect(verdict.tooLarge).toBe(true);
		expect(verdict.reason).toContain("bytes >");
	});

	it("refuses a document past the line bound, well inside the byte bound", () => {
		// The inverse shape: ~2 bytes per line keeps the byte total tiny, so this
		// case can only fail on lines.
		const verdict = exceedsLspSyncLimits("a\n".repeat(MAX_LINES + 1));
		expect(verdict.tooLarge).toBe(true);
		expect(verdict.reason).toContain("lines >");
	});

	it("admits a document inside both bounds", () => {
		const verdict = exceedsLspSyncLimits("const x = 1;\n".repeat(10));
		expect(verdict).toEqual({ tooLarge: false, reason: "" });
	});

	it("admits a document exactly at each bound", () => {
		// Both comparisons are strict `>`, so the boundary value itself is in
		// bounds — a `>=` slip would refuse files the repository has always synced.
		expect(exceedsLspSyncLimits("x".repeat(MAX_BYTES)).tooLarge).toBe(false);
		expect(exceedsLspSyncLimits("a\n".repeat(MAX_LINES - 1)).tooLarge).toBe(
			false,
		);
	});
});

/**
 * #2066: the line count used to be `content.split("\n").length`, and the walk
 * that replaced it must land the SAME verdict on every terminator shape. Each
 * row is sized to sit on or one past the LINE bound with a tiny byte total, so
 * the row decides the verdict rather than the byte bound, and the expectation
 * is recomputed with the split itself — the reference, not the new walk.
 */
describe("the line bound counts what its historical split counted (#2066)", () => {
	const ROWS: ReadonlyArray<{ name: string; content: string }> = [
		{ name: "an empty document (one addressable line)", content: "" },
		{
			name: "LF lines exactly at the bound",
			content: "a\n".repeat(MAX_LINES - 1),
		},
		{ name: "LF lines one past the bound", content: "a\n".repeat(MAX_LINES) },
		{
			// #2066 review F1: the CRLF count is the native LF count, so this
			// row reds if a `\r` is ever counted as a second newline.
			name: "CRLF lines exactly at the bound (one terminator each, one LF each)",
			content: "a\r\n".repeat(MAX_LINES - 1),
		},
		{
			name: "CRLF lines one past the bound (one terminator each, one LF each)",
			content: "a\r\n".repeat(MAX_LINES),
		},
		{
			name: "a trailing newline one past the bound",
			content: `${"a\n".repeat(MAX_LINES - 1)}\n`,
		},
		{
			// Unchanged convention: `split("\n")` never saw a lone `\r` as a
			// separator, so this stays ONE line however many CRs it holds.
			name: "lone-CR text far past the bound",
			content: "a\r".repeat(MAX_LINES + 2),
		},
	];

	for (const row of ROWS) {
		it(`agrees with the split for ${row.name}`, () => {
			const reference = row.content.split("\n").length;
			const verdict = exceedsLspSyncLimits(row.content);
			if (reference > MAX_LINES) {
				expect(verdict.tooLarge).toBe(true);
				expect(verdict.reason).toBe(`${reference} lines > ${MAX_LINES} limit`);
			} else {
				expect(verdict).toEqual({ tooLarge: false, reason: "" });
			}
		});
	}
});

// #5306: the explicit single-file query's bound. Recurrence: a 10,034-line file
// could not be queried at all; the key lifts the LINE limit for that one caller
// and must not move the byte bound or the shared predicate's own default.
describe("exceedsExplicitQueryLimits (#5306)", () => {
	const setGlobalConfig = useGlobalConfig();
	const EIGHT_K = "a\n".repeat(8000);

	it("pins the config key's floor to the shared line bound", () => {
		// lens-config.ts cannot import runtime-config.ts (the reverse import exists),
		// so the floor is a second copy that this equality keeps honest.
		expect(LSP_QUERY_MAX_FILE_LINES_MIN).toBe(MAX_LINES);
	});

	it("with the key unset, refuses past the shared bound and names the key", () => {
		const verdict = exceedsExplicitQueryLimits(EIGHT_K);
		expect(verdict.tooLarge).toBe(true);
		expect(verdict.bound).toBe("lines");
		expect(verdict.reason).toContain("8001 lines > 5000 limit");
		expect(verdict.reason).toContain("lsp.queryMaxFileLines");
	});

	it("with the key at 20000, admits 8k lines and refuses 20001", () => {
		setGlobalConfig({ lsp: { queryMaxFileLines: 20_000 } });
		expect(exceedsExplicitQueryLimits(EIGHT_K)).toEqual({
			tooLarge: false,
			reason: "",
		});
		const over = exceedsExplicitQueryLimits("a\n".repeat(20_000));
		expect(over.tooLarge).toBe(true);
		expect(over.reason).toContain("20001 lines > 20000 limit");
	});

	it("gives no key advice at the key's ceiling, where it cannot help", () => {
		setGlobalConfig({ lsp: { queryMaxFileLines: 40_000 } });
		const over = exceedsExplicitQueryLimits("a\n".repeat(40_000));
		expect(over.reason).toBe("40001 lines > 40000 limit");
	});

	it("never lifts the byte bound, whatever the key, and gives no line advice for it", () => {
		setGlobalConfig({ lsp: { queryMaxFileLines: 20_000 } });
		const verdict = exceedsExplicitQueryLimits(
			`${"x".repeat(MAX_BYTES + 1)}\n`,
		);
		expect(verdict.tooLarge).toBe(true);
		expect(verdict.bound).toBe("bytes");
		expect(verdict.reason).not.toContain("lsp.queryMaxFileLines");
	});

	it("leaves the shared predicate's default alone with the key set", () => {
		setGlobalConfig({ lsp: { queryMaxFileLines: 20_000 } });
		expect(exceedsLspSyncLimits(EIGHT_K).tooLarge).toBe(true);
	});
});
