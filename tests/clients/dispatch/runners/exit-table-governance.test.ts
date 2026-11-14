/**
 * Governance ratchet for the #3292 recurrence: three exit-table misses landed
 * in one day (#3252, #3280, and #3291's `php -l` 255), each because a runner
 * accepted an undocumented nonzero exit class as a completed analysis.
 *
 * Three scans, three deliberately different evidence policies:
 *
 * 1. **Source shape** — comment/string-blanked (`stripSource`), so prose or a
 *    string literal cannot manufacture an exit table.
 * 2. **Annotation** — raw `//` lines only, because the documentation IS a
 *    comment; code cannot satisfy it.
 * 3. **Matrix cell** — EXECUTABLE test text only: every character of the match
 *    must survive comment and string blanking. `codeMatches` is not strong
 *    enough here, because its `matchIsCode` passes when ANY character of the
 *    span lies in code — an `it(` prefix supplies one, so a test TITLE naming
 *    the status stood in for the deleted fixture (#3298 verify round 2,
 *    MEDIUM-2).
 *
 * `DOCUMENTED_RAN` pins every governed runner's `ran` set EXACTLY, in both
 * directions. A code ADDED reds until its matrix cell and its pin row land
 * together; a code REMOVED reds too, which the previous ratchet missed because
 * it only validated the codes still present, so deleting one silently shrank
 * the governed population (#3298 verify round 2, MEDIUM-3). Changing a
 * runner's exit contract therefore has to edit this table in the same change,
 * where review sees it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	matchingCloseIndex,
	matchingOpenIndex,
	stripSource,
} from "../../../support/sweep-kit.js";

const RUNNERS_DIR = fileURLToPath(
	new URL("../../../../clients/dispatch/runners", import.meta.url),
);
const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Temporary admissions, each keyed by file with the reason it is admitted.
 *
 * Empty, and it stays that way unless an in-flight migration owns a runner.
 * #3291's `ktlint.ts` and `php-lint.ts` sat here until that PR merged; the
 * expiry assertion below is what makes such a row impossible to forget.
 */
const EXEMPT: Record<string, string> = {};

/**
 * The exact documented `ran` set per governed runner. Shrink-and-grow ratchet:
 * the population scan finds the runner, this table says what it is allowed to
 * treat as a completed analysis, and any divergence in either direction reds.
 */
const DOCUMENTED_RAN: Record<string, number[]> = {
	"actionlint.ts": [1, 2],
	"cpp-check.ts": [1, 2],
	// Credo's nonzero statuses are a category bitmask (1..127), not an error
	// code list; 128+ means the invocation failed.
	"credo.ts": [
		1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
		22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
		41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
		60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78,
		79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97,
		98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112,
		113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127,
	],
	"dart-analyze.ts": [1, 2, 3],
	"detekt.ts": [1, 2],
	"dotnet-build.ts": [1, 2],
	"elixir-check.ts": [1, 2],
	"eslint.ts": [1, 2],
	"fish-indent.ts": [127],
	"golangci-lint.ts": [1, 2, 3, 4, 5],
	"hadolint.ts": [1, 2],
	"htmlhint.ts": [1, 2],
	"javac.ts": [1, 2],
	"ktlint.ts": [1, 2, 3],
	"markdownlint.ts": [1],
	"mypy.ts": [1, 2],
	"oxlint.ts": [1, 2],
	"php-lint.ts": [1, 255],
	"phpstan.ts": [1],
	"rubocop.ts": [1, 2],
	"ruff.ts": [1, 2],
	"shellcheck.ts": [1],
	"spellcheck.ts": [2],
	"sqlfluff.ts": [1],
	"stylelint.ts": [1, 2],
	"swiftlint.ts": [1, 2],
	"taplo.ts": [1],
	"tflint.ts": [1, 2],
	"vale.ts": [1, 2],
	"yamllint.ts": [1, 2],
	"zig-check.ts": [1, 2],
};

/**
 * Runner file -> the test file whose EXECUTABLE status fixtures drive it.
 * Every governed runner needs a row, and every code in its `DOCUMENTED_RAN`
 * pin needs a cell in that file unless it is admitted in {@link UNWITNESSED}.
 */
const MATRIX: Record<string, string> = {
	"actionlint.ts": "runner-outcome-actionlint-credo.test.ts",
	"cpp-check.ts": "compiler-outcome-runners.test.ts",
	"credo.ts": "runner-outcome-actionlint-credo.test.ts",
	"dart-analyze.ts": "secondary-language-runners.test.ts",
	"detekt.ts": "parsed-nothing.test.ts",
	"dotnet-build.ts": "compiler-outcome-runners-javac-dotnet.test.ts",
	"elixir-check.ts": "secondary-language-runners.test.ts",
	"eslint.ts": "runner-outcome-eslint-golangci.test.ts",
	"fish-indent.ts": "fish-indent.test.ts",
	"golangci-lint.ts": "runner-outcome-eslint-golangci.test.ts",
	"hadolint.ts": "nonzero-exit-no-output.test.ts",
	"htmlhint.ts": "htmlhint.test.ts",
	"javac.ts": "compiler-outcome-runners-javac-dotnet.test.ts",
	"ktlint.ts": "runner-outcome-ktlint-php-lint.test.ts",
	"markdownlint.ts": "exit-blind-runners.test.ts",
	"mypy.ts": "exit-blind-runners.test.ts",
	"oxlint.ts": "oxlint.test.ts",
	"php-lint.ts": "runner-outcome-ktlint-php-lint.test.ts",
	"phpstan.ts": "parsed-nothing.test.ts",
	"rubocop.ts": "runner-status-semantics.test.ts",
	"ruff.ts": "ruff.test.ts",
	"shellcheck.ts": "shellcheck.test.ts",
	"spellcheck.ts": "exit-blind-runners.test.ts",
	"sqlfluff.ts": "exit-blind-runners.test.ts",
	"stylelint.ts": "exit-blind-runners.test.ts",
	"swiftlint.ts": "exit-blind-runners.test.ts",
	"taplo.ts": "taplo.test.ts",
	"tflint.ts": "terraform-kotlin-runners.test.ts",
	"vale.ts": "exit-blind-runners.test.ts",
	"yamllint.ts": "exit-blind-runners.test.ts",
	"zig-check.ts": "compiler-outcome-runners.test.ts",
};

/**
 * `runner.ts:code` -> the reason that documented code has no executable cell
 * yet. Registered, not silenced: the assertion below reds again the moment a
 * cell DOES appear (promote the row out) or the code leaves the pin, so an
 * admission cannot outlive its reason the way #3291's exemptions nearly did.
 */
const UNWITNESSED: Record<string, string> = {
	"hadolint.ts:2":
		"no fixture drives hadolint's documented error exit; #3292 follow-up",
	"htmlhint.ts:2":
		"no fixture drives HTMLHint's documented error exit; #3292 follow-up",
};

function runnerFiles(): string[] {
	return fs
		.readdirSync(RUNNERS_DIR)
		.filter((name) => name.endsWith(".ts"))
		.filter((name) => !["index.ts", "utils.ts"].includes(name))
		.filter((name) => callsParseToolRun(read(name)))
		.sort();
}

function read(name: string): string {
	return fs.readFileSync(path.join(RUNNERS_DIR, name), "utf8");
}

function callsParseToolRun(source: string): boolean {
	return /\bparseToolRun(?:\s*<[^>]*>)?\s*\(/.test(stripSource(source));
}

type ExitTable = { line: number; codes: number[] };

function exitTables(source: string): ExitTable[] {
	const stripped = stripSource(source);
	const lines = stripped.split(/\r?\n/);
	const tables: ExitTable[] = [];
	for (let line = 0; line < lines.length; line++) {
		if (
			!/\bexitCodes\s*:/.test(lines[line]) &&
			!/\bToolExitCodes\s*=/.test(lines[line]) &&
			!/\b[A-Z][A-Z0-9_]*_EXIT_CODES\s*=/.test(lines[line])
		)
			continue;
		const window = lines.slice(line, line + 16).join(" ");
		const match = window.match(/\bran\s*:\s*\[([^\]]*)\]/);
		if (!match) continue;
		const codes = [...match[1].matchAll(/\d+/g)].map((m) => Number(m[0]));
		tables.push({ line, codes });
	}
	return tables;
}

function documentationFor(source: string, line: number): string {
	const lines = source.split(/\r?\n/);
	return lines
		.slice(Math.max(0, line - 12), line + 1)
		.filter((item) => /^\s*\/\//.test(item))
		.join(" ");
}

/**
 * Every exit status this test file drives EXECUTABLY.
 *
 * The whole scan runs over comment- and string-blanked source, so a test TITLE
 * (`it("... status 2 ...")`), a `// status: 2` comment and a bare string
 * literal contribute nothing — `codeMatches` was not enough for that, because
 * its `matchIsCode` passes when ANY character of the span lies in code, and an
 * `it(` prefix supplies one (#3298 verify round 2, MEDIUM-2).
 *
 * Evidence is bound by DATAFLOW into a fixture property, never by proximity.
 * Round 3 admitted any numeric array within three lines of a `status`
 * identifier, so `const statuses = "unrelated data"; const lines = [2];`
 * manufactured a cell for a runner whose only real fixture had been deleted
 * (#3298 verify round 3, MEDIUM-1). Three shapes, the three the fixtures in
 * this directory actually use:
 *
 * 1. `status: 2` / `exitCode: 2` — a numeric literal straight into the
 *    property the `safeSpawn` double returns.
 * 2. `for (const status of STATUSES)` whose loop variable is itself carried
 *    into that property (`{ error: null, status, ... }`), where `STATUSES` is
 *    an array literal or a `const` bound to one.
 * 3. `it.each(ARRAY)(title, async (status) => ...)` whose callback parameter
 *    is such a carrier.
 *
 * A CARRIER is an identifier this file really uses as the status value, so an
 * array reachable from no carrier is not evidence however close it sits, and
 * the `.each` rows that drive a clean exit through `(_name, result)` stay
 * non-evidence. `.forEach` is deliberately absent: no fixture here uses it,
 * and an accepted shape nothing exercises is an untested accept-surface.
 */
function statusCarriers(code: string): Set<string> {
	const carriers = new Set<string>();
	for (const match of code.matchAll(
		/\b(?:status|exitCode)\s*:\s*([A-Za-z_$][\w$]*)\b/g,
	))
		carriers.add(match[1]);
	for (const match of code.matchAll(/[{,]\s*(status|exitCode)\s*[,}]/g))
		carriers.add(match[1]);
	return carriers;
}

interface Binding {
	/** Offset of the declaration keyword. */
	at: number;
	/** Offset and text of the initializer. */
	valueAt: number;
	value: string;
	/** The block this declaration is visible in. */
	scopeStart: number;
	scopeEnd: number;
}

/** Every `{ ... }` block in this file as an offset pair. */
function blockRanges(code: string): [number, number][] {
	const open: number[] = [];
	const ranges: [number, number][] = [];
	for (let index = 0; index < code.length; index++) {
		if (code[index] === "{") open.push(index);
		else if (code[index] === "}") {
			const start = open.pop();
			if (start !== undefined) ranges.push([start, index]);
		}
	}
	return ranges;
}

/**
 * Every `const`/`let`/`var` declaration by bound name, each carrying the block
 * it is visible in. Round 4 kept only the initializers, so two declarations of
 * one name merged and an inactive outer array satisfied a use site that its
 * shadowing inner declaration owns (#3298 verify round 4, MEDIUM-1).
 */
function declaredBindings(code: string): Map<string, Binding[]> {
	const ranges = blockRanges(code);
	const bindings = new Map<string, Binding[]>();
	for (const match of code.matchAll(
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*);/dg,
	)) {
		const at = match.index;
		const [valueAt] = match.indices?.[2] ?? [at];
		let scopeStart = 0;
		let scopeEnd = code.length;
		for (const [start, end] of ranges)
			if (start < at && at < end && start > scopeStart) {
				scopeStart = start;
				scopeEnd = end;
			}
		const declarations = bindings.get(match[1]) ?? [];
		declarations.push({ at, valueAt, value: match[2], scopeStart, scopeEnd });
		bindings.set(match[1], declarations);
	}
	return bindings;
}

/**
 * The declaration of `name` that DOMINATES the use at `useAt`: visible there
 * (its block contains the use) and textually nearest before it. Sibling blocks
 * each resolve to their own declaration, and an inner declaration wins over
 * the outer one it shadows.
 */
function activeBinding(
	bindings: Map<string, Binding[]>,
	name: string,
	useAt: number,
): Binding | undefined {
	let active: Binding | undefined;
	for (const binding of bindings.get(name) ?? []) {
		if (binding.at >= useAt) continue;
		if (useAt < binding.scopeStart || useAt > binding.scopeEnd) continue;
		if (!active || binding.at > active.at) active = binding;
	}
	return active;
}

/** Numeric array literals in `expression`; an index (`codes[1]`) is not one. */
function numericArrays(expression: string): number[] {
	const codes: number[] = [];
	for (const match of expression.matchAll(
		/(?<![A-Za-z0-9_$)\]])\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/g,
	))
		for (const value of match[1].split(",")) codes.push(Number(value.trim()));
	return codes;
}

/**
 * Numeric arrays `expression` evaluates to, following each identifier to the
 * binding active AT THAT IDENTIFIER, so `const statuses = [1, 3]` reached
 * through a `for ... of` still counts while a shadowed sibling does not.
 * `seen` keeps a cyclic binding from recursing.
 */
function resolveArrays(
	bindings: Map<string, Binding[]>,
	expressionAt: number,
	expression: string,
	seen: Set<number>,
): number[] {
	const codes = numericArrays(expression);
	for (const match of expression.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
		const binding = activeBinding(
			bindings,
			match[1],
			expressionAt + match.index,
		);
		if (!binding || seen.has(binding.at)) continue;
		seen.add(binding.at);
		codes.push(
			...resolveArrays(bindings, binding.valueAt, binding.value, seen),
		);
	}
	return codes;
}

function executableStatusCells(testSource: string): Set<number> {
	const code = stripSource(testSource, { strings: "blank" });
	const carriers = statusCarriers(code);
	const bindings = declaredBindings(code);
	const cells = new Set<number>();
	for (const match of code.matchAll(/\b(?:status|exitCode)\s*:\s*(\d+)\b/g))
		cells.add(Number(match[1]));
	for (const match of code.matchAll(
		/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+/g,
	)) {
		if (!carriers.has(match[1])) continue;
		const open = code.indexOf("(", match.index);
		const close = matchingCloseIndex(code, open, "(", ")");
		if (close < 0) continue;
		const iterableAt = match.index + match[0].length;
		for (const cell of resolveArrays(
			bindings,
			iterableAt,
			code.slice(iterableAt, close),
			new Set(),
		))
			cells.add(cell);
	}
	for (const match of code.matchAll(/\b(?:it|test|describe)\.each\s*\(/g)) {
		const open = match.index + match[0].length - 1;
		const close = matchingCloseIndex(code, open, "(", ")");
		if (close < 0) continue;
		const arrow = code.indexOf("=>", close);
		if (arrow < 0) continue;
		const paramsClose = code.lastIndexOf(")", arrow);
		const paramsOpen = matchingOpenIndex(code, paramsClose, "(", ")");
		if (paramsOpen < 0 || paramsOpen < close) continue;
		const bound = code
			.slice(paramsOpen + 1, paramsClose)
			.split(",")
			.some((parameter) => carriers.has(parameter.trim()));
		if (!bound) continue;
		for (const cell of resolveArrays(
			bindings,
			open + 1,
			code.slice(open + 1, close),
			new Set(),
		))
			cells.add(cell);
	}
	return cells;
}

function sorted(codes: number[]): string {
	return JSON.stringify([...codes].sort((a, b) => a - b));
}

describe("documented runner exit-table ratchet (#3292)", () => {
	it("has a non-vacuous parseToolRun population", () => {
		const count = runnerFiles().length;
		assertNonEmptyScan("#3292 parseToolRun runners", count, 20);
		expect(count).toBeGreaterThanOrEqual(20);
	});

	it("expires temporary exemptions when their runner adopts parseToolRun", () => {
		const stale = Object.keys(EXEMPT).filter((name) => {
			const source = read(name);
			return callsParseToolRun(source) || exitTables(source).length > 0;
		});
		expect(stale).toEqual([]);
	});

	it("pins every governed runner's documented ran set exactly", () => {
		const failures: string[] = [];
		const population = runnerFiles();
		for (const name of population) {
			if (Object.hasOwn(EXEMPT, name)) continue;
			const tables = exitTables(read(name));
			if (tables.length !== 1 || tables[0].codes.length === 0) {
				failures.push(
					`${name}: exactly one explicit exitCodes.ran table required`,
				);
				continue;
			}
			if (!Object.hasOwn(DOCUMENTED_RAN, name)) {
				failures.push(
					`${name}: no DOCUMENTED_RAN pin for ran ${sorted(tables[0].codes)}`,
				);
				continue;
			}
			if (sorted(tables[0].codes) !== sorted(DOCUMENTED_RAN[name]))
				failures.push(
					`${name}: ran ${sorted(tables[0].codes)} does not match its pin ${sorted(DOCUMENTED_RAN[name])}`,
				);
		}
		for (const name of Object.keys(DOCUMENTED_RAN))
			if (!population.includes(name) || Object.hasOwn(EXEMPT, name))
				failures.push(`${name}: stale DOCUMENTED_RAN pin`);
		expect(failures).toEqual([]);
	});

	it("requires every parseToolRun runner to document its ran codes", () => {
		const failures: string[] = [];
		for (const name of runnerFiles()) {
			if (Object.hasOwn(EXEMPT, name)) continue;
			const source = read(name);
			const tables = exitTables(source);
			if (tables.length !== 1) continue;
			const docs = documentationFor(source, tables[0].line);
			if (
				!/(?:EXIT TABLE|exit contract)/i.test(docs) ||
				!/(https?:\/\/|(?:undocumented;\s*)?measured\s+(?:fixture|evidence)|\b(?:documented|documents|observed|observes|captured)\b)/i.test(
					docs,
				)
			)
				failures.push(
					`${name}: table needs a pinned upstream URL or measured-undocumented annotation`,
				);
			if (!/\b(?:rejected|error|fatal)\b/i.test(docs))
				failures.push(`${name}: annotation needs a rejected/error class`);
			for (const code of tables[0].codes) {
				if (!new RegExp(`\\b${code}\\b`).test(docs))
					failures.push(`${name}: annotation omits ran code ${code}`);
			}
		}
		expect(failures).toEqual([]);
	});

	// Fixture-level guard for the binding resolver itself (#3298 verify round 4,
	// MEDIUM-1): the whole-repo assertions below can only show that TODAY's
	// fixtures resolve, never that a shadowed or not-yet-declared binding is
	// rejected, because no runner test currently contains one.
	it("resolves a status binding to the declaration that dominates the use", () => {
		const shadowed = [
			"const statuses = [2];",
			"describe('outer', () => {",
			"\tit('inner', () => {",
			"\t\tconst statuses = 'unrelated data';",
			"\t\tfor (const status of statuses) {",
			"\t\t\tconst fixture = { status };",
			"\t\t\tvoid fixture;",
			"\t\t}",
			"\t});",
			"});",
		].join("\n");
		expect([...executableStatusCells(shadowed)]).toEqual([]);

		const siblings = [
			"it('a', () => {",
			"\tconst statuses = [1, 3];",
			"\tfor (const status of statuses) {",
			"\t\tconst fixture = { status };",
			"\t\tvoid fixture;",
			"\t}",
			"});",
			"it('b', () => {",
			"\tconst statuses = [4];",
			"\tfor (const status of statuses) {",
			"\t\tconst fixture = { status };",
			"\t\tvoid fixture;",
			"\t}",
			"});",
		].join("\n");
		expect([...executableStatusCells(siblings)].sort()).toEqual([1, 3, 4]);

		// A declaration in a block that does not CONTAIN the use is not visible
		// there, however early it appears. Text-level input on purpose: the
		// detector reads source, and this is the only direction that separates
		// visibility from textual order.
		const siblingOnly = [
			"it('a', () => {",
			"\tconst statuses = [9];",
			"\tvoid statuses;",
			"});",
			"it('b', () => {",
			"\tfor (const status of statuses) {",
			"\t\tconst fixture = { status };",
			"\t\tvoid fixture;",
			"\t}",
			"});",
		].join("\n");
		expect([...executableStatusCells(siblingOnly)]).toEqual([]);

		const declaredAfterUse = [
			"it('a', () => {",
			"\tfor (const status of statuses) {",
			"\t\tconst fixture = { status };",
			"\t\tvoid fixture;",
			"\t}",
			"\tconst statuses = [5];",
			"});",
		].join("\n");
		expect([...executableStatusCells(declaredAfterUse)]).toEqual([]);
	});

	it("witnesses every documented ran code with an executable matrix cell", () => {
		const failures: string[] = [];
		const population = runnerFiles().filter(
			(name) => !Object.hasOwn(EXEMPT, name),
		);
		const cellCache = new Map<string, Set<number>>();
		const cellsOf = (file: string): Set<number> => {
			let cells = cellCache.get(file);
			if (!cells) {
				cells = executableStatusCells(
					fs.readFileSync(path.join(TESTS_DIR, file), "utf8"),
				);
				cellCache.set(file, cells);
			}
			return cells;
		};
		const pinnedKeys = new Set<string>();
		for (const name of population) {
			const table = exitTables(read(name))[0];
			if (!table) continue;
			const cellFile = MATRIX[name];
			if (!cellFile) {
				failures.push(`${name}: no MATRIX row naming its status fixtures`);
				continue;
			}
			const cells = cellsOf(cellFile);
			for (const code of table.codes) {
				const key = `${name}:${code}`;
				pinnedKeys.add(key);
				if (cells.has(code)) {
					if (Object.hasOwn(UNWITNESSED, key))
						failures.push(
							`${key}: stale UNWITNESSED admission; ${cellFile} now drives it`,
						);
					continue;
				}
				if (Object.hasOwn(UNWITNESSED, key)) continue;
				failures.push(
					`${key}: documented ran code has no executable matrix cell in ${cellFile}`,
				);
			}
		}
		for (const name of Object.keys(MATRIX))
			if (!population.includes(name))
				failures.push(`${name}: stale MATRIX row`);
		for (const key of Object.keys(UNWITNESSED))
			if (!pinnedKeys.has(key))
				failures.push(
					`${key}: stale UNWITNESSED admission; no such pinned code`,
				);
		expect(failures).toEqual([]);
	});
});
