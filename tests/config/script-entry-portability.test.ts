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
const HAND_BUILT_ENTRY_GATE =
	/import\.meta\.url\s*[!=]==?\s*`file:\/\/\$\{\s*process\.argv\[1\]/;

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

	it("the scan matches the shape and ignores a comment quoting it", () => {
		const offender =
			"if (import.meta.url === `file://${process.argv[1]}`) main();\n";
		const fixed =
			"if (import.meta.url === pathToFileURL(process.argv[1]).href) main();\n";
		const prose =
			"// never write import.meta.url === `file://${process.argv[1]}`\nmain();\n";
		expect(
			HAND_BUILT_ENTRY_GATE.test(stripSource(offender, { strings: "keep" })),
		).toBe(true);
		expect(
			HAND_BUILT_ENTRY_GATE.test(stripSource(fixed, { strings: "keep" })),
		).toBe(false);
		expect(
			HAND_BUILT_ENTRY_GATE.test(stripSource(prose, { strings: "keep" })),
		).toBe(false);
	});
});
