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
 * The detector fails closed (#5228 review F1: a list of refused spellings let
 * 19 of 22 plants through). It finds every occurrence of four roots in the
 * comment-and-string-blanked source and admits an occurrence only in one of
 * the forms below; every other occurrence is a hit:
 *
 * - `process`: a plain member other than `argv` (`process.env`); `argv` read
 *   as `.length`, `.slice(start` or `[index]`, where start and index are an
 *   integer literal of 2 or more or an identifier with an optional `+ n`/`- n`;
 *   `argv.includes(` or `argv.indexOf(` whose first argument is a whole string
 *   or template literal; `typeof process`; an object key (`{ process: ... }`);
 *   `import process from`; `.bind(process)`; `Object.defineProperty(process,`.
 * - `import.meta`: `.url` as an argument of a call in URL_CALLEES (and only
 *   after the first argument of `new URL`), `.dirname` as an argument of
 *   `resolve` or `join`, and `.resolve(`; each call followed by `)`, `,`,
 *   `;`, `}`, `]` or `:`, never by an operator or a member. `.resolve` bare
 *   before `?` is a feature test and is admitted.
 * - `globalThis` / `global`: a plain member, `declare global`, or the first
 *   argument of `spyOn(` (a `"process"` second argument still reds below).
 * - a `"process"` or `"node:process"` string literal (read in the raw source
 *   at a delimiter the blanked text keeps): the specifier of
 *   `import process from`, or an operand of `===` / `!==`.
 *
 * Residuals (admitted forms broader than the rule): an identifier index or
 * slice start can still hold 0 or 1; a literal search argument can name the
 * script, and a template literal can interpolate it; an admitted call's
 * result can be compared one call out
 * (`dirname(fileURLToPath(import.meta.url)) === x`); `.bind(process)` hands
 * a function `this.argv`; code built from strings (`new Function`, a
 * computed `import()` specifier) is not read.
 */
const INDEX = String.raw`(?:[2-9]|[1-9]\d+|[A-Za-z_$][\w$]*(?:\s*[+-]\s*\d+)?)`;
const ARGV_TAIL = new RegExp(
	String.raw`process\s*\.\s*argv\s*(?:\.\s*(?:length\b|slice\s*\(\s*${INDEX}\s*[,)])|\[\s*${INDEX}\s*\])`,
	"y",
);
/**
 * `argv.includes(` / `argv.indexOf(` admit a first argument only when it is one
 * whole string or template literal (the blanked text keeps the delimiters). An
 * identifier such as `self` is a hit: the search must name a literal, never
 * the program path (#5228 review G1).
 */
const ARGV_SEARCH =
	/process\s*\.\s*argv\s*\.\s*(?:includes|indexOf)\s*\(\s*(?:"[^"\n]*"|'[^'\n]*'|`[^`]*`)\s*[,)]/y;
const PLAIN_MEMBER = /\s*\.\s*[A-Za-z_$]/y;
const URL_CALLEES = new Set([
	"isMainModule",
	"isEntryPoint",
	"fileURLToPath",
	"createRequire",
	"createJiti",
	"resolvePackagePath",
	"URL",
]);
const DIRNAME_CALLEES = new Set(["resolve", "join"]);
const CALL_FOLLOWER = /[),;}\]:]/;
const OPEN = "([{";
const CLOSE = ")]}";

type Hit = { at: number; root: string };

function nextNonSpace(text: string, from: number): string {
	const match = /\S/.exec(text.slice(from));
	return match ? match[0] : "";
}

function prevNonSpace(text: string, before: number): string {
	for (let i = before - 1; i >= 0; i--) if (/\S/.test(text[i])) return text[i];
	return "";
}

/** Index of the bracket that opens the innermost group around `at`, or -1. */
function enclosingOpen(text: string, at: number): number {
	let depth = 0;
	for (let i = at - 1; i >= 0; i--) {
		if (CLOSE.includes(text[i])) depth++;
		else if (OPEN.includes(text[i])) {
			if (depth === 0) return i;
			depth--;
		}
	}
	return -1;
}

/** Index of the bracket that closes the group opened at `open`, or -1. */
function matchingClose(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (OPEN.includes(text[i])) depth++;
		else if (CLOSE.includes(text[i]) && --depth === 0) return i;
	}
	return -1;
}

/** The call's result is used as a value, never compared or dereferenced. */
function callEndsCleanly(text: string, open: number): boolean {
	const close = matchingClose(text, open);
	if (close < 0) return false;
	const follower = nextNonSpace(text, close + 1);
	return follower === "" || CALL_FOLLOWER.test(follower);
}

function admitsProcess(text: string, at: number): boolean {
	const before = text.slice(Math.max(0, at - 40), at);
	const after = text.slice(at, at + 80);
	ARGV_TAIL.lastIndex = 0;
	if (ARGV_TAIL.test(after)) return true;
	ARGV_SEARCH.lastIndex = at;
	if (ARGV_SEARCH.test(text)) return true;
	PLAIN_MEMBER.lastIndex = "process".length;
	if (PLAIN_MEMBER.test(after) && !/^process\s*\.\s*argv\b/.test(after))
		return true;
	if (/\btypeof\s+$/.test(before)) return true;
	if (/[{,]\s*$/.test(before) && /^process\s*:/.test(after)) return true;
	if (/\bimport\s+$/.test(before) && /^process\s+from\b/.test(after))
		return true;
	if (/\.\s*bind\s*\(\s*$/.test(before) && /^process\s*\)/.test(after))
		return true;
	return (
		/\bObject\s*\.\s*defineProperty\s*\(\s*$/.test(before) &&
		/^process\s*,/.test(after)
	);
}

function admitsImportMeta(text: string, at: number): boolean {
	const member = /import\s*\.\s*meta\s*\.\s*(url|dirname|resolve)\b/y;
	member.lastIndex = at;
	const match = member.exec(text);
	if (!match) return false;
	const name = match[1];
	const end = at + match[0].length;
	if (name === "resolve") {
		const next = /\s*(\(|\?(?![.?]))/y;
		next.lastIndex = end;
		const call = next.exec(text);
		if (!call) return false;
		return call[1] === "?" || callEndsCleanly(text, next.lastIndex - 1);
	}
	const previous = prevNonSpace(text, at);
	if (!"(,".includes(previous) || previous === "") return false;
	if (!",)".includes(nextNonSpace(text, end) || "x")) return false;
	const open = enclosingOpen(text, at);
	if (open < 0 || text[open] !== "(") return false;
	const callee = /(\bnew\s+)?([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(0, open));
	if (!callee) return false;
	const allowed =
		name === "url"
			? URL_CALLEES.has(callee[2]) &&
				(callee[2] !== "URL" || (Boolean(callee[1]) && previous === ","))
			: DIRNAME_CALLEES.has(callee[2]);
	return allowed && callEndsCleanly(text, open);
}

function admitsGlobal(text: string, at: number, word: string): boolean {
	const before = text.slice(Math.max(0, at - 30), at);
	if (/\bdeclare\s+$/.test(before)) return true;
	if (
		/\bspyOn\s*\(\s*$/.test(before) &&
		/^\w+\s*,/.test(text.slice(at, at + 20))
	)
		return true;
	PLAIN_MEMBER.lastIndex = at + word.length;
	return PLAIN_MEMBER.test(text);
}

function admitsProcessString(text: string, at: number, end: number): boolean {
	const before = text.slice(Math.max(0, at - 40), at);
	return (
		/\bimport\s+process\s+from\s*$/.test(before) ||
		/[!=]==\s*$/.test(before) ||
		/^\s*[!=]==/.test(text.slice(end, end + 10))
	);
}

function scanHits(source: string): Hit[] {
	const text = stripSource(source);
	const hits: Hit[] = [];
	for (const match of text.matchAll(/\bprocess\b/g))
		if (!admitsProcess(text, match.index))
			hits.push({ at: match.index, root: "process" });
	for (const match of text.matchAll(/\bimport\s*\.\s*meta\b/g))
		if (!admitsImportMeta(text, match.index))
			hits.push({ at: match.index, root: "import.meta" });
	for (const match of text.matchAll(/(?<![.\w$])(globalThis|global)\b/g))
		if (!admitsGlobal(text, match.index, match[1]))
			hits.push({ at: match.index, root: match[1] });
	// Strings are blank in `text`; the raw source holds the literal, and the
	// blanked text keeps a real literal's delimiters at the same offsets.
	for (const match of source.matchAll(/(["'`])(?:node:)?process\1/g)) {
		const end = match.index + match[0].length;
		if (text[match.index] !== match[1] || text[end - 1] !== match[1]) continue;
		if (!admitsProcessString(text, match.index, end))
			hits.push({ at: match.index, root: "a process module string" });
	}
	return hits.sort((a, b) => a.at - b.at);
}

function lineOf(source: string, at: number): number {
	return source.slice(0, at).split("\n").length;
}

/** Each hit as `line N: <root>: <source line>`. */
export function scanEntryGate(source: string): string[] {
	const lines = source.split("\n");
	return scanHits(source).map(({ at, root }) => {
		const line = lineOf(source, at);
		return `line ${line}: ${root}: ${lines[line - 1].trim()}`;
	});
}

/** The seam itself reads `process.argv[1]`; no other file may, but for: */
const SEAM = "scripts/lib/is-main-module.mjs";

const SYMBOL_KEY_ALIAS =
	"a typed alias of the global object to reach one Symbol.for registry key; the alias is read only through that key";

/**
 * Single sites admitted outside the seam, matched by their exact trimmed
 * source line, one hit each; the rest of each file is scanned. The fourth case below reds when a
 * site stops producing the hit it admits.
 */
export const ADMITTED_SITES: Array<{
	file: string;
	site: string;
	reason: string;
}> = [
	{
		file: "scripts/hooks/guard-bash.mjs",
		site: "realpathSync.native(process.argv[1]) ===",
		reason:
			"standalone gate of the same rule (resolves both paths natively): guard-bash-probe loads the hook from a git ref and tests copy it alone, so it cannot import scripts/lib; its cell in tests/scripts/script-entry-gate-cells.test.ts proves it through a symlinked path",
	},
	{
		file: "tests/support/kill-guard.ts",
		site: "const host = process as typeof process & {",
		reason: SYMBOL_KEY_ALIAS,
	},
	{
		file: "tests/support/check-build-freshness.ts",
		site: "latch: Record<symbol, unknown> = globalThis as Record<symbol, unknown>,",
		reason: SYMBOL_KEY_ALIAS,
	},
	{
		file: "tests/support/tmp-root-registry.ts",
		site: "const holder = globalThis as { [REGISTRY_KEY]?: TmpRootRegistry };",
		reason: SYMBOL_KEY_ALIAS,
	},
];

/** The source line a hit reports, as `line N: <root>: <trimmed line>`. */
function hitSource(hit: string): string {
	return hit.replace(/^line \d+: [^:]+: /, "");
}

/** The site whose exact trimmed line this hit reports, if any. */
function admittedSite(relative: string, hit: string) {
	const source = hitSource(hit);
	return ADMITTED_SITES.find(
		({ file, site }) => file === relative && source === site,
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
	const admitted = new Set<(typeof ADMITTED_SITES)[number]>();
	for (const absolute of files) {
		const relative = relativePosix(root, absolute);
		if (relative === SEAM) continue;
		for (const hit of scanEntryGate(readFileSync(absolute, "utf8"))) {
			const site = admittedSite(relative, hit);
			// A site admits one hit: a verbatim copy of its line is a hit.
			if (site && !admitted.has(site)) admitted.add(site);
			else offenders.push(`${relative}: ${hit}`);
		}
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

	// Recurrence: an admission outliving its site is data that admits the next
	// gate written on that line (the admission is data-only, shape 38).
	it("every admitted site still produces the hit it admits", () => {
		for (const { file, site } of ADMITTED_SITES)
			expect(
				scanEntryGate(readFileSync(resolve(ROOT, file), "utf8")).filter(
					(hit) => hitSource(hit) === site,
				),
				`${file}: ${site}`,
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

	// Recurrence: review F1 on #5228, where a denylist of spellings let 19 of 22
	// plants through. The first block is the reviewer's plants; the second is
	// spellings this detector's author did not design for (an alias, an
	// indirect call, a value reached through another binding).
	it("refuses every spelling outside the admitted forms", () => {
		const offenders = [
			'import proc from "node:process";\nif (proc.argv[1] === here) main();\n',
			"const p = process;\nif (p.argv[1] === here) main();\n",
			"const entry = process.argv.find((a) => a.endsWith('.mjs'));\n",
			"const entry = process.argv.filter(Boolean)[1];\n",
			'const entry = process.argv["1"];\n',
			"const entry = process.argv[0x1];\n",
			"const entry = process.argv[0 + 1];\n",
			"const entry = process.argv?.[1];\n",
			'const entry = globalThis["process"].argv[1];\n',
			"if (new URL(import.meta.url).pathname === entry) main();\n",
			"for (const arg of process.argv) check(arg);\n",
			"const entry = process.argv.slice(-1)[0];\n",
			"const all = process.argv.join(' ');\n",
			"const entry = process.argv.findLast((a) => a.endsWith('.mjs'));\n",
			"if (import.meta.main) main();\n",
			"if (import.meta.dirname === dir) main();\n",
			"if (import.meta.resolve('./self.mjs') === entry) main();\n",
			"const { 1: entry } = process.argv;\n",
			"const { argv: [, entry] } = process;\n",
			"const entry = process['argv'][1];\n",
			// An alias through a destructure, and through a binding of the global.
			"const { process: p } = globalThis;\nconst entry = p.argv[1];\n",
			"const g = globalThis;\nconst entry = g.process.argv[1];\n",
			"const entry = globalThis.process.argv[1];\n",
			// An indirect call.
			'const entry = Reflect.get(process, "argv")[1];\n',
			'const entry = require("node:process").argv[1];\n',
			'const { argv } = await import("process");\n',
			// A value reached through another binding.
			"const m = import.meta;\nif (m.url === entry) main();\n",
			'if (import.meta["url"] === entry) main();\n',
			"const entry = process.argv.slice(1)[0];\n",
			"const head = process.argv.slice(0, 2);\n",
			"const entry = process.argv[2 - 1];\n",
			"const copy = structuredClone(process.argv);\n",
			"if (fileURLToPath(import.meta.url) === entry) main();\n",
			"if (fileURLToPath(import.meta.url).endsWith(name)) main();\n",
			"if (Object.is(import.meta.url, entry)) main();\n",
			"const here = (import.meta.url);\n",
			// G1 (#5228 review r3): a search of argv admits only a string or
			// template literal as its first argument, never an identifier.
			"if (process.argv.includes(self)) main();\n",
			"const hit = process.argv.indexOf(self) === 1;\n",
			"if (process.argv.includes('--x' + self)) main();\n",
			// The alias of argv, and the indirect call, of the same search.
			"const argv = process.argv;\nif (argv.includes(self)) main();\n",
			"const hit = Reflect.apply(Array.prototype.includes, process.argv, [self]);\n",
		];
		const passed = offenders.filter(
			(source) => scanEntryGate(source).length === 0,
		);
		expect(passed).toEqual([]);
	});

	// Recurrence: review G2 on #5228, where a substring match let a same-line
	// edit or a verbatim duplicate of an admitted line ride its admission. A
	// site admits one hit, on the line whose trimmed text equals the site.
	it(
		"admits each site once, on its exact trimmed line",
		() => {
			const root = mkdtempSync(resolve(tmpdir(), "pi-lens-entry-sites-"));
			try {
				const plant = (rel: string, source: string) => {
					mkdirSync(resolve(root, rel, ".."), { recursive: true });
					writeFileSync(resolve(root, rel), source);
				};
				const site = "realpathSync.native(process.argv[1]) ===";
				// The admitted line, then a verbatim copy of it (the copy is a hit).
				plant(
					"scripts/hooks/guard-bash.mjs",
					`if (\n\t${site}\n\tlink\n) run();\nif (\n\t${site}\n\tlink\n) run();\n`,
				);
				// The admitted line widened on the same line (a hit).
				plant(
					"tests/support/tmp-root-registry.ts",
					"const holder = globalThis as { [REGISTRY_KEY]?: TmpRootRegistry }; // widened\n",
				);
				expect(findPrivateEntryGates(root, 1)).toEqual([
					"scripts/hooks/guard-bash.mjs: line 6: process: realpathSync.native(process.argv[1]) ===",
					"tests/support/tmp-root-registry.ts: line 1: globalThis: const holder = globalThis as { [REGISTRY_KEY]?: TmpRootRegistry }; // widened",
				]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// Recurrence: a census whose exclusion list admits a whole directory reads
	// green with the tree unread; the seam is the only admitted path, and an
	// admitted site admits its own line, never the rest of its file.
	it(
		"reads scripts/ and tests/support/ and admits only the seam and the admitted sites",
		() => {
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
				plant(
					"scripts/hooks/guard-bash.mjs",
					"if (\n\trealpathSync.native(process.argv[1]) ===\n\tlink\n) run();\n",
				);
				plant(
					"tests/support/kill-guard.ts",
					"const host = process as typeof process & {\n\tKEY: 1,\n};\nconst entry = process.argv[1];\n",
				);
				expect(findPrivateEntryGates(root, 1)).toEqual([
					"scripts/deep/nested.mjs: line 1: process: if (process.argv[1] === here) main();",
					"scripts/private.mjs: line 1: process: if (process.argv[1] === here) main();",
					"tests/support/helper.mjs: line 1: process: if (process.argv[1] === here) main();",
					"tests/support/kill-guard.ts: line 4: process: const entry = process.argv[1];",
				]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		TREE_WALK_TIMEOUT_MS,
	);

	// Recurrence: an admitted form the tree uses today going unadmitted reds the
	// census for code that reads no program path; each line is a real form.
	it("admits the seam call, option parsing, the real process uses and prose quoting the shape", () => {
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
			"const at = process.argv.indexOf('--n');\nconst n = at >= 0 ? process.argv[at + 1] : undefined;\n",
			"for (let i = 0; i < process.argv.length; i++) use(process.argv[i]);\n",
			"const rest = process.argv.slice(separator + 1);\n",
			"const args = process.argv\n\t.slice(2)\n\t.find((a) => a === '--x');\n",
			"process.exitCode = 1;\nconst env = process . env;\n",
			"const kill = process.kill.bind(process) as typeof process.kill;\n",
			"Object.defineProperty(process, 'platform', { value: 'win32' });\n",
			"const { process: child } = proc;\nconst o = { process: child };\n",
			'import process from "node:process";\n',
			'if (node.name === "process" || "node:process" !== spec) skip();\n',
			"const f = globalThis.fetch;\ndeclare global {}\n",
			"const root = resolve(import.meta.dirname, '..');\n",
			"const url = import.meta.resolve\n\t? import.meta.resolve(spec)\n\t: other;\n",
			"const jiti = createJiti(import.meta.url);\n",
			"const p = resolvePackagePath(\n\timport.meta.url,\n\t'../x',\n);\n",
			"if (isEntryPoint(import.meta.url)) {\n\tmain();\n}\n",
		];
		for (const source of clean)
			expect(scanEntryGate(source), source).toEqual([]);
	});
});
