import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
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

// The SDK's `exports` map blocks subpath + package.json + main resolution, so
// locate the package by walking up from cwd to the node_modules entry that
// holds it (devDep; robust to nested node_modules).
function hostPackageDir(): string {
	const rel = path.join("node_modules", "@earendil-works", "pi-coding-agent");
	let dir = process.cwd();
	for (;;) {
		const candidate = path.join(dir, rel);
		if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("could not locate @earendil-works/pi-coding-agent");
}

function hostEditDiffSource(): string {
	return fs.readFileSync(
		path.join(hostPackageDir(), "dist/core/tools/edit-diff.js"),
		"utf-8",
	);
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

	it("host still exports the line-ending + BOM primitives we vendored", () => {
		expect(src).toContain("export function detectLineEnding");
		expect(src).toContain("export function normalizeToLF");
		expect(src).toContain("export function restoreLineEndings");
		expect(src).toContain(`startsWith("${esc(HOST_BOM_CODE_POINT)}")`);
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
