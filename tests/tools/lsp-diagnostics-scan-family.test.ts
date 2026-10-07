/**
 * Exhaustive #2434-fold regression coverage for `runDirectoryDiagnostics`'s
 * scan-language decision (tools/lsp-diagnostics.ts).
 *
 * #2458 fix-round F1 (BLOCKER): `SCAN_LANGUAGE_PRIORITY` used to be a FLAT
 * `LanguageId[]` and `runDirectoryDiagnostics` walked it one id at a time,
 * breaking at the first id with any file match. That silently lost the
 * sibling half of every registry-split pair the fold introduced — `.ts`+
 * `.tsx`, `.js`+`.jsx`, `.css`+`.scss`, `.css`+`.less`, `.less`+`.scss`,
 * `.json`+`.jsonc`, `.mts`/`.cts`+`.tsx`, `.mjs`/`.cjs`+`.jsx` — because the
 * pre-#2434 `LANG_EXTENSIONS` table bundled each of those under ONE key and
 * scanned both extensions together, while the per-id loop tried the ids
 * making up that old key separately and stopped at the first match.
 *
 * The fix groups `SCAN_LANGUAGE_PRIORITY` into FAMILIES (one per old golden
 * key) and unions every member id's extensions into ONE `collectFiles`/
 * `hasMatch` call per family. `resolveDirectoryScanExtensions` (exported from
 * tools/lsp-diagnostics.ts) is the exact decision function
 * `runDirectoryDiagnostics` calls in production; this file drives it with an
 * in-memory `hasMatch` predicate instead of real file I/O so every 1- and
 * 2-extension combination in the pre-fold golden extension universe (56
 * extensions -> 1596 combinations) runs in milliseconds, not by spinning up
 * 1596 real directories through the full LSP-mocked tool.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveDirectoryScanExtensions } from "../../tools/lsp-diagnostics.js";

const golden = JSON.parse(
	readFileSync(
		new URL(
			"../fixtures/lsp-diagnostics-lang-extensions.json",
			import.meta.url,
		),
		"utf8",
	),
) as { order: string[]; extensions: Record<string, string[]> };

/**
 * Master's semantics: the pre-#2434 table's first key (in its original
 * declaration order) with any extension in `presentExtensions`, returning
 * that key's full (possibly wider) extension list — the set `collectFiles`
 * would have matched against for a real directory.
 */
function goldenWinningExtensions(
	presentExtensions: readonly string[],
): readonly string[] | undefined {
	for (const key of golden.order) {
		const exts = golden.extensions[key];
		if (presentExtensions.some((ext) => exts.includes(ext))) return exts;
	}
	return undefined;
}

describe("resolveDirectoryScanExtensions (#2434 exhaustive family coverage, #2458 fix-round F1)", () => {
	it("includes Lean files in the added Lean scan family", async () => {
		const result = await resolveDirectoryScanExtensions((extensions) =>
			extensions.includes(".lean"),
		);
		expect(result).toContain(".lean");
	});

	const universe = [
		...new Set(Object.values(golden.extensions).flat() as string[]),
	].sort();

	it(`matches master's LANG_EXTENSIONS scanned-file-set for every 1- and 2-extension directory in the golden universe (${universe.length} extensions, ${(universe.length * (universe.length + 1)) / 2} combinations)`, async () => {
		const mismatches: string[] = [];

		for (let i = 0; i < universe.length; i++) {
			for (let j = i; j < universe.length; j++) {
				const present = i === j ? [universe[i]] : [universe[i], universe[j]];
				const presentSet = new Set(present);

				const expectedWinner = goldenWinningExtensions(present);
				const actualWinner = await resolveDirectoryScanExtensions((exts) =>
					exts.some((ext) => presentSet.has(ext)),
				);

				// A synthetic directory's files are exactly `present`'s extensions,
				// so the SCANNED-FILE-SET a real directory would produce is
				// `present` filtered to membership in the winning family/key's
				// (possibly wider) extension list — not the raw winner arrays,
				// which legitimately differ on extensions neither present file has.
				const expectedScanned = present
					.filter((ext) => expectedWinner?.includes(ext))
					.sort()
					.join(",");
				const actualScanned = present
					.filter((ext) => actualWinner?.includes(ext))
					.sort()
					.join(",");

				if (expectedScanned !== actualScanned) {
					mismatches.push(
						`present=${present.join("+")}: expected scanned={${expectedScanned}}, got {${actualScanned}}`,
					);
				}
			}
		}

		expect(mismatches).toEqual([]);
	});
});
