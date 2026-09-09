import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * A script that decides "am I the entry module?" by comparing
 * `import.meta.url` with a hand-built `file://${process.argv[1]}` string
 * never runs its main block on Windows: `process.argv[1]` is
 * `D:\a\...\script.mjs` while `import.meta.url` is `file:///D:/a/...`.
 *
 * Recurrence: master run 34400281631 (2026-09-09, head 711483dd4) — the
 * Windows advisory lane enumerated zero files because
 * `scripts/lib/win32-gate-population.mjs --files` printed nothing; six
 * scripts carried the same gate. `pathToFileURL(process.argv[1]).href` is
 * the portable comparison.
 */
const META_URL = String.raw`import\s*\.\s*meta\s*\.\s*url`;
const HAND_BUILT = String.raw`\x60file:\/\/\$\{\s*process\s*\.\s*argv\s*\[\s*1\s*\]`;
const OPERATOR = String.raw`\s*[!=]==?\s*`;
// Both operand orders and a member access split across whitespace or a line
// break (review F1 on #2842): the sweep must miss neither.
const HAND_BUILT_ENTRY_GATE = new RegExp(
	`${META_URL}${OPERATOR}${HAND_BUILT}|${HAND_BUILT}[^\x60]*\x60${OPERATOR}${META_URL}`,
);

export function findHandBuiltEntryGates(root: string): string[] {
	const files = listSourceFiles(resolve(root, "scripts"), {
		extensions: [".mjs", ".js", ".ts"],
	});
	// Calibration: 120 files under scripts/ on 2026-09-09; half is 60.
	assertNonEmptyScan("script entry-gate census", files.length, 60);
	const offenders: string[] = [];
	for (const absolute of files) {
		const source = readFileSync(absolute, "utf8");
		// The needle's evidence lives in a template literal, so strings stay;
		// comments are blanked so prose quoting the shape cannot match.
		const scanned = stripSource(source, { strings: "keep" });
		if (HAND_BUILT_ENTRY_GATE.test(scanned))
			offenders.push(relativePosix(root, absolute));
	}
	return offenders.sort();
}

describe("script entry-module detection is Windows-portable", () => {
	it("no script compares import.meta.url with a hand-built file:// string", () => {
		expect(findHandBuiltEntryGates(ROOT)).toEqual([]);
	});

	it("the scan matches every spelling of the shape and ignores a comment quoting it", () => {
		const scan = (source: string) =>
			HAND_BUILT_ENTRY_GATE.test(stripSource(source, { strings: "keep" }));
		// Recurrence: review F1 on #2842 — reversed operands and a split member
		// access evaded the first regex while reintroducing the Windows defect.
		const offenders = [
			"if (import.meta.url === `file://${process.argv[1]}`) main();\n",
			"if (import.meta.url !== `file://${process.argv[1]}`) return;\n",
			"if (`file://${process.argv[1]}` === import.meta.url) main();\n",
			"if (import.meta.\n\turl === `file://${process.argv[1]}`) main();\n",
			"if (\n\timport.meta.url ===\n\t\t`file://${ process.argv[ 1 ] }`\n) main();\n",
		];
		for (const offender of offenders)
			expect(scan(offender), offender).toBe(true);
		const clean = [
			"if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();\n",
			"// never write import.meta.url === `file://${process.argv[1]}`\nmain();\n",
			"const uri = `file://${filePath}`;\n",
		];
		for (const source of clean) expect(scan(source), source).toBe(false);
	});
});
