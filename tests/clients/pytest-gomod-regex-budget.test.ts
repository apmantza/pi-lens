// flake-shape: elapsed-time-assertion — the defect under test IS wall-clock.
// The pytest traceback scan and the go.mod module scan gave the right ANSWER on
// every input below; only the time was wrong (quadratic in a blank run or an
// underscore run), so no non-clock assertion separates fixed from broken. A
// mocked clock is by construction unfaithful here: it would measure nothing.

/**
 * #4148: bounded-time pin for the pytest traceback regex in
 * `clients/test-runner-client.ts` and the `module` regex in
 * `clients/review-graph/import-resolvers.ts`. Both run synchronously on the host
 * event loop with no timeout of their own, so a slow match is a blocked host,
 * not a slow answer.
 *
 * Measured on the maintainer host by reverting the two source lines to their
 * old form, rebuilding, and running this file (node 24):
 *
 *   row                               | old form              | elapsed
 *   ----------------------------------+-----------------------+--------
 *   pytest rule + 100K blank lines    | `_{10,}\s*\n\s*`      | 13.4 s
 *   pytest one 100K-character rule    | unanchored `_{10,}`   | 7.0 s
 *   go.mod 100K blank lines, no hit   | `^\s*module` (m flag) | 4.2 s
 *   go.mod 100K blank lines, then hit | `^\s*module` (m flag) | 4.5 s
 *   go.mod 100K CR lines, no hit      | `^[^\S\n]*module`     | 4.2 s
 *   go.mod 100K U+2028 lines, no hit  | `^[^\S\n]*module`     | 7.4 s
 *   go.mod 100K U+2029 lines, no hit  | `^[^\S\n]*module`     | 7.4 s
 *
 * Every fixed row runs in about 1 ms. Budget: 1000 ms per row sits three
 * orders of magnitude above the fixed cost and 4x below the cheapest
 * regressed row.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveImportToFiles } from "../../clients/review-graph/import-resolvers.js";
import { TestRunnerClient } from "../../clients/test-runner-client.js";
import { setupTestEnvironment } from "./test-utils.js";

const BUDGET_MS = 1000;
const LINES = 100_000;

function expectWithinBudget<T>(name: string, run: () => T, expected: T): void {
	const started = performance.now();
	const result = run();
	const elapsed = performance.now() - started;
	// The answer is asserted beside the time: a fix that made the scan
	// fast by dropping the match would otherwise pass.
	expect(result, name).toEqual(expected);
	expect(elapsed).toBeLessThan(BUDGET_MS);
}

describe("pytest traceback regex budget (#4148)", () => {
	function stackOf(output: string): string | undefined {
		const client = new TestRunnerClient(false) as any;
		const result = client.parsePytestOutput(
			`FAILED tests/test_a.py::test_x - AssertionError: boom\n${output}`,
			"",
			1,
			"/repo/tests/test_a.py",
			"/repo",
			"pytest",
		);
		return result.failures[0]?.stack;
	}

	const blank = "\n".repeat(LINES);

	it("keeps a rule followed by 100K blank lines and no error line linear", () => {
		expectWithinBudget(
			"blank run, no error line",
			() => stackOf(`${"_".repeat(12)}\n${blank}x\n`),
			undefined,
		);
	});

	it("still reads the error line after 100K blank lines", () => {
		expectWithinBudget(
			"blank run, then error line",
			() => stackOf(`${"_".repeat(12)}\n${blank}ValueError: boom\n`),
			"ValueError: boom",
		);
	});

	it("keeps one 100K-character underscore rule linear", () => {
		expectWithinBudget(
			"underscore run, no newline",
			() => stackOf("_".repeat(LINES)),
			undefined,
		);
	});
});

describe("go.mod module regex budget (#4148)", () => {
	let root: string;
	let cleanup: () => void;

	beforeEach(() => {
		const env = setupTestEnvironment("pi-lens-gomod-budget-");
		root = env.tmpDir;
		cleanup = env.cleanup;
		fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
		fs.mkdirSync(path.join(root, "cmd"), { recursive: true });
		fs.writeFileSync(path.join(root, "pkg", "a.go"), "package pkg\n");
		fs.writeFileSync(path.join(root, "cmd", "main.go"), "package main\n");
	});
	afterEach(() => cleanup());

	function resolveRel(goMod: string): string[] {
		fs.writeFileSync(path.join(root, "go.mod"), goMod);
		return resolveImportToFiles(
			root,
			path.join(root, "cmd", "main.go"),
			"go",
			"example.com/m/pkg",
		).map((p) => path.relative(root, p).replace(/\\/g, "/"));
	}

	const blank = "\n".repeat(LINES);

	it("keeps 100K blank lines with no module line linear", () => {
		expectWithinBudget(
			"blank run, no module line",
			() => resolveRel(`${blank}go 1.21\n`),
			[],
		);
	});

	// `^` under the `m` flag also follows `\r`, U+2028 and U+2029, so a
	// horizontal-only class must exclude them too.
	it.each([
		["carriage-return", "\r"],
		["line-separator", String.fromCharCode(0x2028)],
		["paragraph-separator", String.fromCharCode(0x2029)],
	])("keeps 100K %s lines with no module line linear", (name, terminator) => {
		expectWithinBudget(
			`${name} run, no module line`,
			() => resolveRel(`${terminator.repeat(LINES)}go 1.21${terminator}`),
			[],
		);
	});

	it("keeps 100K blank lines before a later module line linear", () => {
		expectWithinBudget(
			"blank run, then module line",
			() => resolveRel(`${blank}go 1.21\nmodule example.com/m\n`),
			["pkg/a.go"],
		);
	});
});
