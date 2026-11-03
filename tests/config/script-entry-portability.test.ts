import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * Entry-module detection (AGENTS.md shape 44) has one owner:
 * `isMainModule(import.meta.url)` in `scripts/lib/is-main-module.mjs`, which
 * resolves BOTH the module URL and `process.argv[1]` natively (#4086, #4096).
 * A script that decides "am I the entry module?" any other way never runs its
 * main block on some host, and exits 0 saying nothing:
 *
 * - `import.meta.url === \`file://${process.argv[1]}\`` on Windows, where
 *   `argv[1]` is `D:\a\...\script.mjs` and the URL is `file:///D:/a/...`
 *   (master run 34400281631, 2026-09-09: the Windows advisory lane enumerated
 *   zero files; six scripts carried the gate).
 * - `import.meta.url === pathToFileURL(process.argv[1]).href` and
 *   `fileURLToPath(import.meta.url) === process.argv[1]` through a symlinked
 *   path, where node resolves the module URL but leaves `argv[1]` linked (the
 *   65 scripts folded onto the seam: `check-changelog-fragments.mjs` passed
 *   without checking, and the `guard-bash` hook allowed `git stash`).
 *
 * The detector admits one form and refuses the rest. In a covered file the
 * only reads of the program path are none (the seam is the one reader), so it
 * refuses every way of getting `process.argv[0]` or `[1]` into a value:
 * a literal index, `.at`/`.shift`/`.slice` from the front, a spread, an array
 * destructure, a binding of the bare array, a bare array passed on, a
 * computed `process[...]` access, an `argv` destructured from `process` or
 * imported; and it refuses `import.meta.url` or `.filename` as an operand of a
 * comparison, as the receiver of a string method, or bound to a name without
 * a wrapping call. Identifier-valued indexes (`process.argv[i]`, the option
 * parsers' own loops) are admitted: they cannot name the program path without
 * the literal, so a gate that reaches `argv[1]` through one and compares it
 * with a self path held in another binding is the residual this detector does
 * not read.
 */
const ARGV = String.raw`\bprocess\s*\.\s*argv\b`;
const META = String.raw`\bimport\s*\.\s*meta\s*\.\s*(?:url|filename)\b`;
const PATTERNS: Array<{ form: string; pattern: RegExp }> = [
	{
		form: "argv literal 0 or 1",
		pattern: new RegExp(`${ARGV}\\s*\\[\\s*[01]\\s*\\]`),
	},
	{
		form: "argv read from the front (at, shift, slice)",
		pattern: new RegExp(
			`${ARGV}\\s*\\.\\s*(?:at|shift|entries|keys|values|map|forEach|reduce|flat)\\b|${ARGV}\\s*\\.\\s*slice\\s*\\(\\s*(?:[01]\\s*)?[,)]`,
		),
	},
	{
		form: "argv spread",
		pattern: new RegExp(`\\.\\.\\.\\s*${ARGV}(?!\\s*[.\\[])`),
	},
	{
		form: "argv array destructure",
		pattern: new RegExp(`\\]\\s*=\\s*${ARGV}(?!\\s*[.\\[])`),
	},
	{
		form: "bare argv bound to a name",
		pattern: new RegExp(`=\\s*${ARGV}(?!\\s*[.\\[])`),
	},
	{
		form: "bare argv passed on",
		pattern: new RegExp(`[(,]\\s*${ARGV}\\s*[,)]`),
	},
	{
		form: "computed process access, or argv destructured or imported",
		pattern:
			/\bprocess\s*\[|\{[^{}]*\bargv\b[^{}]*\}\s*=\s*process\b|\bimport\s*\{[^}]*\bargv\b[^}]*\}\s*from\b/,
	},
	{
		form: "import.meta.url as a comparison operand",
		pattern: new RegExp(
			`${META}\\s*\\)*\\s*[!=]==?|[!=]==?\\s*(?:[\\w$.]+\\s*\\(\\s*)*${META}`,
		),
	},
	{
		form: "import.meta.url as a string-method receiver",
		pattern: new RegExp(
			`${META}\\s*\\.\\s*(?:endsWith|startsWith|includes|indexOf|localeCompare|toLowerCase|replace|slice)\\b`,
		),
	},
	{
		form: "import.meta.url bound to a name",
		pattern: new RegExp(`(?<![=!<>])=(?!=)\\s*${META}\\s*[;,)]`),
	},
];

/** The seam itself reads `process.argv[1]`; no other file may, but for: */
const SEAM = "scripts/lib/is-main-module.mjs";

/**
 * Files that cannot import the seam and carry a standalone gate of the same
 * rule (resolve both paths natively). Each is proved at runtime by its cell in
 * `tests/scripts/script-entry-gate-cells.test.ts` (a started run through a
 * symlinked path), and the third case below reds when an entry stops needing
 * its exemption.
 */
export const STANDALONE_GATES: Record<string, string> = {
	"scripts/hooks/guard-bash.mjs":
		"guard-bash-probe loads the hook from a git ref and tests copy it alone, so it cannot import scripts/lib",
};

export function scanEntryGate(source: string): string[] {
	const scanned = stripSource(source);
	return PATTERNS.filter(({ pattern }) => pattern.test(scanned)).map(
		({ form }) => form,
	);
}

export function findPrivateEntryGates(root: string, floor = 116): string[] {
	const files = [
		...listSourceFiles(resolve(root, "scripts"), {
			extensions: [".mjs", ".js", ".ts"],
		}),
		...listSourceFiles(resolve(root, "tests/support"), {
			extensions: [".mjs", ".js", ".ts"],
			skipTests: true,
		}),
	];
	// Calibration: 232 files under scripts/ and tests/support/ on 2026-11-03;
	// half is 116.
	assertNonEmptyScan("script entry-gate census", files.length, floor);
	const offenders: string[] = [];
	for (const absolute of files) {
		const relative = relativePosix(root, absolute);
		if (relative === SEAM || relative in STANDALONE_GATES) continue;
		const forms = scanEntryGate(readFileSync(absolute, "utf8"));
		if (forms.length > 0) offenders.push(`${relative}: ${forms.join("; ")}`);
	}
	return offenders.sort();
}

describe("script entry-module detection has one owner (isMainModule)", () => {
	it(
		"no script or test-support file reads the program path or compares import.meta.url itself",
		() => {
			expect(findPrivateEntryGates(ROOT)).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// Recurrence: a standalone exemption outliving its reason hides a private gate
	// (the exemption is data-only, shape 38).
	it("every standalone gate still carries a private gate", () => {
		for (const file of Object.keys(STANDALONE_GATES))
			expect(
				scanEntryGate(readFileSync(resolve(ROOT, file), "utf8")),
				file,
			).not.toEqual([]);
	});

	// Recurrences: review F1 on #2842 (reversed operands and a split member
	// access evaded the first regex while reintroducing the Windows defect) and
	// the 65 private copies #4096 left behind. Every spelling below is one the
	// detector's author did not design a pattern for by name.
	it("refuses the hand-built, the portable-looking and the aliased spellings of a private gate", () => {
		const offenders = [
			"if (import.meta.url === `file://${process.argv[1]}`) main();\n",
			"if (import.meta.url !== `file://${process.argv[1]}`) return;\n",
			"if (`file://${process.argv[1]}` === import.meta.url) main();\n",
			"if (import.meta.\n\turl === `file://${process.argv[1]}`) main();\n",
			"if (\n\timport.meta.url ===\n\t\t`file://${ process.argv[ 1 ] }`\n) main();\n",
			// The form the catalog used to name as the portable one.
			"if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();\n",
			"if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();\n",
			"if (process.argv[1]?.endsWith('check-prose.mjs')) main();\n",
			// An alias: the program path bound once, compared later.
			"const entry = process.argv[1];\nif (entry === fileURLToPath(import.meta.url)) main();\n",
			// An indirect read: no literal index, no member access.
			"const [, entry] = process.argv;\nmain(entry);\n",
			"const [node, entry] = process.argv;\n",
			"const entry = process.argv.at(1);\n",
			// A value reached through another binding: an identifier index into
			// argv, compared with the module URL.
			"const i = 1;\nconst entry = process.argv[i];\nif (pathToFileURL(entry).href === import.meta.url) main();\n",
			// A value reached through another binding.
			"const args = process.argv;\nif (args[1] === here) main();\n",
			"const here = import.meta.url;\nif (here === target) main();\n",
			"const { argv } = process;\nconst entry = argv[1];\n",
			"const key = 'argv';\nconst entry = process[key][1];\n",
			"run(process.argv);\n",
			"const rest = [...process.argv];\n",
			"if (import.meta.filename === process.argv.at(-1)) main();\n",
			"if (import.meta.url.endsWith(name)) main();\n",
		];
		for (const offender of offenders)
			expect(scanEntryGate(offender), offender).not.toEqual([]);
	});

	// Recurrence: a census whose exclusion list admits a whole directory reads
	// green with the tree unread; the seam and the standalone file are the only
	// admitted paths.
	it("reads scripts/ and tests/support/ and admits only the seam and the standalone gate", () => {
		const root = mkdtempSync(resolve(tmpdir(), "pi-lens-entry-portability-"));
		try {
			const plant = (rel: string, source: string) => {
				mkdirSync(resolve(root, rel, ".."), { recursive: true });
				writeFileSync(resolve(root, rel), source);
			};
			const gate = "if (process.argv[1] === here) main();\n";
			plant("scripts/private.mjs", gate);
			plant("scripts/deep/nested.mjs", gate);
			plant("tests/support/helper.mjs", gate);
			plant(
				"scripts/clean.mjs",
				"if (isMainModule(import.meta.url)) main();\n",
			);
			plant("scripts/lib/is-main-module.mjs", gate);
			plant("scripts/hooks/guard-bash.mjs", gate);
			expect(
				findPrivateEntryGates(root, 1).map((line) => line.split(":")[0]),
			).toEqual([
				"scripts/deep/nested.mjs",
				"scripts/private.mjs",
				"tests/support/helper.mjs",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("admits the seam call, option parsing and prose quoting the shape", () => {
		const clean = [
			"if (isMainModule(import.meta.url)) main();\n",
			"const here = fileURLToPath(import.meta.url);\n",
			"const dir = path.dirname(fileURLToPath(import.meta.url));\n",
			"const require = createRequire(import.meta.url);\n",
			"const url = new URL('../x.json', import.meta.url);\n",
			"main(process.argv.slice(2));\n",
			"const i = process.argv.indexOf('--out');\nconst out = process.argv[i + 1];\n",
			"if (process.argv.includes('--json')) emit();\n",
			"const first = process.argv[2];\n",
			"// never write import.meta.url === `file://${process.argv[1]}`\nmain();\n",
			"const note = 'import.meta.url === process.argv[1]';\n",
			"const uri = `file://${filePath}`;\n",
		];
		for (const source of clean)
			expect(scanEntryGate(source), source).toEqual([]);
	});
});
