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
} from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const TESTS_ROOT = resolve(ROOT, "tests");

const DO_MOCK = /\bvi\.doMock\(\s*(["'`])([^"'`]+)\1/g;
const DO_UNMOCK = /\bvi\.doUnmock\(\s*(["'`])([^"'`]+)\1/g;
// `it(`, `test(`, and their chained forms (`it.each(...)(`, `it.runIf(...)(`,
// `test.skip(`), each counted once.
const TEST_CALL = /\b(?:it|test)(?:\s*\.\s*[A-Za-z]+(?:\s*\([^()]*\))?)*\s*\(/g;

function specifiers(source: string, pattern: RegExp): Set<string> {
	return new Set(codeMatches(source, pattern).map((match) => match[2]));
}

/** The `vi.doMock` specifiers a multi-test file never undoes. */
export function unUndoneDoMocks(source: string): string[] {
	if (codeMatches(source, TEST_CALL).length < 2) return [];
	const undone = specifiers(source, DO_UNMOCK);
	return [...specifiers(source, DO_MOCK)]
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
		if (codeMatches(source, DO_MOCK).length > 0) filesWithDoMock++;
		for (const spec of unUndoneDoMocks(source))
			flagged.push(`${file}::${spec}`);
	}
	return { flagged: flagged.sort(), filesWithDoMock };
}

describe("vi.doMock is undone in multi-test files (#2883)", () => {
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
	});
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
