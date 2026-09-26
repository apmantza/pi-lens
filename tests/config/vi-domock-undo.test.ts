// Sweep (#2883): every `vi.doMock(<specifier>)` in a test file with more than
// one test must be undone with `vi.doUnmock(<specifier>)` in the same file.
// The population was 24 specifiers in 8 files at the start of #2883's fix and
// is 0 after it, so there is no admitted baseline: a new one reds at once.
//
// WHY. `vi.resetModules()` clears the module cache but NOT the mock registry,
// so a `doMock` outlives its test: every later case in the file re-imports the
// same mock. #2859's instance dropped an installer export, fourteen
// `session_start` awaits rejected into `index.ts`'s catch, and the whole file
// stayed green. A single-test file has no later case to leak into, so it is
// out of scope by construction.
//
// MATCHING. Specifiers are read from code only (the sweep-kit `codeMatches`
// seam), so a `vi.doMock("x")` named in a comment or a string is not a call.
// A specifier counts as undone when the same literal appears in a
// `vi.doUnmock(...)` call anywhere in the file; a specifier that is also
// hoist-mocked with a top-level `vi.mock` cannot be undone that way (doUnmock
// would drop the hoisted mock too): steer the hoisted mock with a
// `vi.hoisted` flag instead, as fish-indent.test.ts does.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	codeMatches,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const TESTS_ROOT = resolve(ROOT, "tests");

const DO_MOCK = /\bvi\.doMock\(\s*(["'`])([^"'`]+)\1/g;
const DO_UNMOCK = /\bvi\.doUnmock\(\s*(["'`])([^"'`]+)\1/g;
// `it(`, `test(`, and their chained forms (`it.each(...)(`, `it.runIf(...)(`,
// `test.skip(`), each counted once.
const TEST_CALL = /\b(?:it|test)(?:\s*\.\s*[A-Za-z]+(?:\s*\([^()]*\))?)*\s*\(/g;

function specifiers(
	source: string,
	pattern: RegExp,
	stripped?: string,
): Set<string> {
	return new Set(
		codeMatches(source, pattern, stripped).map((match) => match[2]),
	);
}

/**
 * The `vi.doMock` specifiers a multi-test file never undoes.
 *
 * `stripped`, when given, must be `stripSource(source)` (#3514) — the same
 * precomputed-work shape `codeMatches` itself takes, so a caller matching one
 * file against this and the sibling `DO_MOCK` count below pays `stripSource`
 * once, not once per regex. Omitted, this recomputes it, so the standalone
 * `unUndoneDoMocks(source)` unit tests below are unaffected.
 */
export function unUndoneDoMocks(source: string, stripped?: string): string[] {
	if (codeMatches(source, TEST_CALL, stripped).length < 2) return [];
	const undone = specifiers(source, DO_UNMOCK, stripped);
	return [...specifiers(source, DO_MOCK, stripped)]
		.filter((spec) => !undone.has(spec))
		.sort();
}

// 25 test files call vi.doMock (measured 2026-09-25); half, rounded down.
const FLOOR = 12;

function scanTree(): { flagged: string[]; filesWithDoMock: number } {
	const flagged: string[] = [];
	let filesWithDoMock = 0;
	for (const absolute of listSourceFiles(TESTS_ROOT, {
		extensions: [".test.ts", ".test.mts"],
	})) {
		const file = relativePosix(ROOT, absolute);
		if (file.includes("/fixtures/")) continue;
		const source = readFileSync(absolute, "utf8");
		// #3514: one `stripSource` pass per file, shared by the three regex
		// matches below (TEST_CALL, DO_MOCK, DO_UNMOCK) instead of the four
		// `codeMatches` calls each redoing it. Measured: 1212 files, match time
		// ~5.0s unshared vs ~1.3s shared (see PR body).
		const stripped = stripSource(source);
		if (codeMatches(source, DO_MOCK, stripped).length > 0) filesWithDoMock++;
		for (const spec of unUndoneDoMocks(source, stripped))
			flagged.push(`${file}::${spec}`);
	}
	return { flagged: flagged.sort(), filesWithDoMock };
}

describe("vi.doMock is undone in multi-test files (#2883)", () => {
	// Whole-tree walk + parse (#3514): times out under load at the 5s default
	// (measured 9.9s at load average ~18, run 2026-09-26). Explicit budget
	// sized from a loaded replay after the stripSource sharing above; see the
	// PR body's before/after numbers.
	it("flags no vi.doMock specifier a multi-test file never undoes", () => {
		const { flagged, filesWithDoMock } = scanTree();
		// Dead-sweep floor (AGENTS.md shape 10); see FLOOR.
		assertNonEmptyScan("vi.doMock files", filesWithDoMock, FLOOR);
		expect(
			flagged,
			"vi.doMock specifier(s) never undone in a multi-test file: add " +
				"`vi.doUnmock(<same specifier>)` to the file's afterEach (vi.resetModules " +
				"does not clear the mock registry).",
		).toEqual([]);
	}, 30_000);
});

describe("the doMock-undo matcher", () => {
	const twoTests = 'it("a", () => {});\nit("b", () => {});\n';

	it("flags a doMock the file never undoes", () => {
		expect(
			unUndoneDoMocks(`${twoTests}vi.doMock("../x.js", () => ({}));\n`),
		).toEqual(["../x.js"]);
	});

	it("accepts a doMock the file undoes", () => {
		expect(
			unUndoneDoMocks(
				`${twoTests}vi.doMock("../x.js", () => ({}));\nafterEach(() => vi.doUnmock("../x.js"));\n`,
			),
		).toEqual([]);
	});

	it("ignores a single-test file", () => {
		expect(
			unUndoneDoMocks(
				'it("only", () => {});\nvi.doMock("../x.js", () => ({}));\n',
			),
		).toEqual([]);
	});

	it("does not read a doMock named only in a comment", () => {
		expect(
			unUndoneDoMocks(`${twoTests}// vi.doMock("../x.js") would leak\n`),
		).toEqual([]);
	});

	it("does not count a doUnmock named only in a comment as undoing", () => {
		expect(
			unUndoneDoMocks(
				`${twoTests}vi.doMock("../x.js", () => ({}));\n// vi.doUnmock("../x.js") later\n`,
			),
		).toEqual(["../x.js"]);
	});

	it("counts chained test forms as tests", () => {
		expect(
			unUndoneDoMocks(
				'it.runIf(true)("a", () => {});\ntest.each([1])("b", () => {});\nvi.doMock("../x.js", () => ({}));\n',
			),
		).toEqual(["../x.js"]);
	});
});
