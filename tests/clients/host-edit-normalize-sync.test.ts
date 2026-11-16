import { hostPackageDir } from "../support/pi-session.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { applyTextEditsToString } from "../../clients/lsp/edits.js";
import {
	HOST_BOM_CODE_POINT,
	HOST_EDIT_DIFF_SDK_FLOOR,
	HOST_SMART_DOUBLE_QUOTES,
	HOST_SMART_SINGLE_QUOTES,
	HOST_SPECIAL_SPACES,
	HOST_UNICODE_DASHES,
} from "../../clients/host-edit-normalize.js";

/**
 * Drift guard for the vendored host normalization ladder (#257). The host SDK is
 * type-only at runtime, so clients/host-edit-normalize.ts COPIES the host's
 * fuzzy-match code-point sets. This test re-reads the host source from devDeps
 * and fails if the host changes its ladder, so the copy can't silently rot.
 */

function hostEditDiffSource(): string {
	return fs.readFileSync(
		path.join(hostPackageDir(), "dist/core/tools/edit-diff.js"),
		"utf-8",
	);
}

// 0.85.1 extracted the BOM split/strip primitive out of edit-diff.js into a
// shared utils module (edit-diff.js now imports `splitBom` from here instead
// of inlining `content.startsWith(BOM)`). Read separately so the BOM
// assertion below tracks wherever the host actually defines the primitive,
// not wherever it happened to live when this guard was written.
function hostTextUtilsSource(): string {
	return fs.readFileSync(
		path.join(hostPackageDir(), "dist/utils/text.js"),
		"utf-8",
	);
}

// Slice out ONE named top-level `export function <name>(...) { ... }`'s own
// source, bounded by the next top-level `export function`/`export const`/EOF
// -- so an assertion against the slice can't be satisfied by a SIBLING
// declaration (e.g. a hypothetical `legacySplitBom` keeping the old literal
// while the real `splitBom` drifts to something else). Good enough for this
// file's flat, unminified shape; not a general JS parser.
function sliceExportedFunction(source: string, name: string): string {
	const startMarker = `export function ${name}(`;
	const start = source.indexOf(startMarker);
	if (start === -1) {
		throw new Error(`could not find "${startMarker}" in host source`);
	}
	// `export ` is OPTIONAL in the boundary: a non-exported sibling declared
	// right after the target (e.g. an unexported `function legacySplitBom`
	// kept for a deprecation window) must ALSO terminate the slice, or its
	// body gets swallowed into the target's captured source — the whole
	// point of scoping the assertion (#2586 review round 3, F4-residual).
	const nextDeclMatch = /\n(?:(?:export )?(?:function|const)\b)/.exec(
		source.slice(start + startMarker.length),
	);
	const end = nextDeclMatch
		? start + startMarker.length + nextDeclMatch.index
		: source.length;
	return source.slice(start, end);
}

// Re-encode a code point the way the host hard-codes it: \uXXXX, 4 hex digits,
// uppercase letters (matches the host source, e.g. ‚,  , ﻿).
const esc = (codePoint: number) =>
	`\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

describe("host-edit-normalize sync (host source drift guard)", () => {
	const src = hostEditDiffSource();

	it("installed host SDK is at or above the pinned floor", () => {
		const installed: string = JSON.parse(
			fs.readFileSync(path.join(hostPackageDir(), "package.json"), "utf-8"),
		).version;
		const toParts = (v: string) =>
			v.split(".").map((n) => Number.parseInt(n, 10));
		const [im, in_, ip] = toParts(installed);
		const [fm, fn, fp] = toParts(HOST_EDIT_DIFF_SDK_FLOOR);
		const ge = im > fm || (im === fm && (in_ > fn || (in_ === fn && ip >= fp)));
		expect(
			ge,
			`installed ${installed} < pinned floor ${HOST_EDIT_DIFF_SDK_FLOOR}`,
		).toBe(true);
	});

	it("host still applies the NFKC + per-line trimEnd ladder", () => {
		expect(src).toContain('.normalize("NFKC")');
		expect(src).toContain("trimEnd()");
	});

	it("host smart-quote / dash code-point sets match the vendored copy", () => {
		expect(src).toContain(`[${HOST_SMART_SINGLE_QUOTES.map(esc).join("")}]`);
		expect(src).toContain(`[${HOST_SMART_DOUBLE_QUOTES.map(esc).join("")}]`);
		expect(src).toContain(`[${HOST_UNICODE_DASHES.map(esc).join("")}]`);
	});

	it("host special-space class (range-encoded) matches the vendored copy", () => {
		// Host encodes U+2002..U+200A as a range; assert the boundaries + the
		// NBSP / narrow-NBSP / math-space / ideographic-space anchors.
		const first = HOST_SPECIAL_SPACES[0]; // U+00A0
		const rangeLo = 0x2002;
		const rangeHi = 0x200a;
		const tail = [0x202f, 0x205f, 0x3000];
		expect(src).toContain(
			`[${esc(first)}${esc(rangeLo)}-${esc(rangeHi)}${tail.map(esc).join("")}]`,
		);
		// And our flattened copy spans exactly that inclusive range + tail.
		const expected = [
			first,
			...Array.from({ length: rangeHi - rangeLo + 1 }, (_, i) => rangeLo + i),
			...tail,
		];
		expect(HOST_SPECIAL_SPACES).toEqual(expected);
	});

	it("host still exports normalization and preserves original line endings", () => {
		// #5670: pi 1.5.2 replaced global detect/restore with range-local
		// restoration. Keep our legacy ports unchanged and track the host seam.
		expect(src).toContain("export function normalizeToLF");
		expect(sliceExportedFunction(src, "normalizeToLF")).toContain(
			'text.replace(/\\r\\n/g, "\\n").replace(/\\r/g, "\\n")',
		);
		expect(src).toContain("export function applyReplacementsToOriginal");
	});

	it("host edits preserve untouched mixed endings after pi 1.5.2", async () => {
		// #5670: the former global restoration would rewrite the final CRLF
		// to LF because the first line is LF. The new host keeps those bytes.
		const host = await import(
			pathToFileURL(path.join(hostPackageDir(), "dist/core/tools/edit-diff.js"))
				.href
		);
		expect(
			host.applyReplacementsToOriginal("first\nold\r\nlast\r\n", [
				{ matchIndex: 6, matchLength: 3, newText: "new\nline" },
			]),
		).toBe("first\nnew\r\nline\r\nlast\r\n");
		// #5670 review r1 (F3): a host reverted to whole-file CRLF detection passes
		// the case above, because its edited line also ends in CRLF. This case edits
		// an LF line in a mixed-ending file, so that revert reds here.
		expect(
			host.applyReplacementsToOriginal("a\r\nold\nz\r\n", [
				{ matchIndex: 2, matchLength: 3, newText: "new\nline" },
			]),
		).toBe("a\r\nnew\nline\nz\r\n");
	});

	it("an LSP edit and the host edit tool agree on the line ending of mixed-ending files", async () => {
		// #5670 r2: pi-lens used the file's first ending for every edit while pi 1.5.2
		// takes the ending of the line where the replaced range starts. Each case is
		// run through the host's applyReplacementsToOriginal and through
		// applyTextEditsToString, and both must produce the literal expected text.
		const host = await import(
			pathToFileURL(path.join(hostPackageDir(), "dist/core/tools/edit-diff.js"))
				.href
		);
		type Pos = { line: number; character: number };
		const cases: Array<{
			name: string;
			content: string;
			start: Pos;
			end: Pos;
			newText: string;
			expected: string;
		}> = [
			{
				name: "CRLF line in an LF-first file",
				content: "a\nx\r\nc\r\n",
				start: { line: 1, character: 1 },
				end: { line: 1, character: 1 },
				newText: "\ny",
				expected: "a\nx\r\ny\r\nc\r\n",
			},
			{
				name: "LF line in a CRLF-first file",
				content: "a\r\nx\nc\n",
				start: { line: 1, character: 1 },
				end: { line: 1, character: 1 },
				newText: "\ny",
				expected: "a\r\nx\ny\nc\n",
			},
			{
				name: "range that starts on an LF line and ends on a CRLF line",
				content: "a\nb\r\nc\r\n",
				start: { line: 0, character: 1 },
				end: { line: 1, character: 1 },
				newText: "\nq\nr",
				expected: "a\nq\nr\r\nc\r\n",
			},
			{
				name: "range that starts on a CRLF line and ends on an LF line",
				content: "a\r\nb\nc\n",
				start: { line: 0, character: 1 },
				end: { line: 1, character: 1 },
				newText: "\nq\nr",
				expected: "a\r\nq\r\nr\nc\n",
			},
			{
				name: "unterminated last line after a CRLF line",
				content: "a\nb\r\nc",
				start: { line: 2, character: 1 },
				end: { line: 2, character: 1 },
				newText: "\nd",
				expected: "a\nb\r\nc\r\nd",
			},
			{
				name: "unterminated last line after an LF line",
				content: "a\r\nb\nc",
				start: { line: 2, character: 1 },
				end: { line: 2, character: 1 },
				newText: "\nd",
				expected: "a\r\nb\nc\nd",
			},
			{
				name: "insert after the final CRLF of a mixed file",
				content: "a\nb\r\n",
				start: { line: 2, character: 0 },
				end: { line: 2, character: 0 },
				newText: "x\ny",
				expected: "a\nb\r\nx\r\ny",
			},
			{
				name: "pure LF",
				content: "a\nb\n",
				start: { line: 0, character: 1 },
				end: { line: 0, character: 1 },
				newText: "\nx",
				expected: "a\nx\nb\n",
			},
			{
				name: "pure CRLF",
				content: "a\r\nb\r\n",
				start: { line: 0, character: 1 },
				end: { line: 0, character: 1 },
				newText: "\nx",
				expected: "a\r\nx\r\nb\r\n",
			},
		];
		for (const c of cases) {
			const lines = host.normalizeToLF(c.content).split("\n") as string[];
			const offset = (p: Pos) =>
				lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) +
				p.character;
			const fromHost = host.applyReplacementsToOriginal(c.content, [
				{
					matchIndex: offset(c.start),
					matchLength: offset(c.end) - offset(c.start),
					newText: c.newText,
				},
			]);
			const fromLsp = applyTextEditsToString(c.content, [
				{ range: { start: c.start, end: c.end }, newText: c.newText },
			]);
			expect(fromHost, "host: " + c.name).toBe(c.expected);
			expect(fromLsp, "lsp: " + c.name).toBe(c.expected);
		}
	});

	it("host still delegates BOM stripping to splitBom, and splitBom matches our vendored copy", () => {
		// edit-diff.js no longer inlines the BOM check itself (0.85.1 extracted
		// it into utils/text.js's `splitBom`) — assert the delegation still
		// exists, so a future host version that inlines something DIFFERENT
		// here (rather than keeping the shared primitive) still fails this
		// guard, then assert the actual code-point check against wherever
		// splitBom is now defined.
		expect(src).toMatch(/import\s*\{[^}]*\bsplitBom\b[^}]*\}\s*from/);
		expect(src).toContain("splitBom(");
		// Scoped to splitBom's OWN body, not "anywhere in text.js": a sibling
		// function (e.g. a hypothetical legacySplitBom) keeping the old
		// literal while the REAL splitBom drifts to something else must NOT
		// satisfy this assertion.
		const splitBomBody = sliceExportedFunction(
			hostTextUtilsSource(),
			"splitBom",
		);
		expect(splitBomBody).toContain(`startsWith("${esc(HOST_BOM_CODE_POINT)}")`);
	});

	it("host match decision is still exact-then-fuzzy, counted in fuzzy space", () => {
		// Guards hostWouldApplyOldText's replica of fuzzyFindText + countOccurrences.
		expect(src).toContain("export function fuzzyFindText");
		// exact match attempted first
		expect(src).toContain("content.indexOf(oldText)");
		// then fuzzy match in normalized space
		expect(src).toContain("normalizeForFuzzyMatch(content)");
		expect(src).toContain("normalizeForFuzzyMatch(oldText)");
		// duplicate count is taken in fuzzy space (split length - 1)
		expect(src).toContain("fuzzyContent.split(fuzzyOldText).length - 1");
	});
});
