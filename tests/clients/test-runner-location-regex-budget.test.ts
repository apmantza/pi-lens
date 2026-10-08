// flake-shape: elapsed-time-assertion — the defect under test IS wall-clock.
// The runner-location regexes gave the right ANSWER on every input below; only
// the time was wrong (exponential in path depth, quadratic in a blank run or a
// long token), so no non-clock assertion separates fixed from broken. A mocked
// clock is by construction unfaithful here: it would measure nothing.

/**
 * #3871 r2/r3: bounded-time pin for the PHPUnit, Mix, and generic text-runner
 * location scans in `clients/test-runner-client.ts`. The parsers run inside
 * turn_end with no timeout of their own, so a slow match is a blocked host
 * event loop, not a slow answer.
 *
 * Measured on the maintainer host by restoring each regressed form in the
 * built output and running this file (`scripts/mutate.mjs --built`, node 24):
 *
 *   row                              | regressed form                    | elapsed
 *   ---------------------------------+-----------------------------------+--------
 *   PHPUnit path-only line, depth 30 | nested `(?:[^\s:]+\/)*` group      | 211 s
 *   Mix path-only line, depth 30     | nested `(?:[^\s:]+\/)*` group      | 212 s
 *   PHPUnit 100K blank lines         | `(?:^|\n)\s*` failure-block search | 3.7 s
 *   PHPUnit 100K blank, no location  | `(?:^|\n)\s*` location scan        | 5.4 s
 *   Mix 100K blank lines             | `^\s*` failure header (on master)  | 3.7 s
 *   Mix 100K blank lines             | `(?:^|\n)\s*` failure-block search | 4.0 s
 *   Mix 100K blank, no location      | `(?:^|\n)\s*` location scan        | 5.4 s
 *   generic 100K-character token     | unanchored `[^\s:]+\.ext`          | 4.5 s
 *
 * Every fixed row parses in about 1 ms. Budget (AGENTS.md loose bound screen,
 * both directions): 1000 ms per row sits three orders of magnitude above the
 * fixed cost and 3.7x below the cheapest regressed row.
 */
import { describe, expect, it } from "vitest";
import { TestRunnerClient } from "../../clients/test-runner-client.js";

const BUDGET_MS = 1000;

type ParserRow = {
	name: string;
	parse: (client: any) => { failures: Array<{ location?: string }> };
	location: string | undefined;
};

function expectWithinBudget(rows: readonly ParserRow[]): void {
	const client = new TestRunnerClient(false) as any;
	for (const row of rows) {
		const started = performance.now();
		const result = row.parse(client);
		const elapsed = performance.now() - started;
		// The answer is asserted beside the time: a fix that made the scan
		// fast by dropping the location would otherwise pass.
		expect(result.failures[0]?.location, row.name).toBe(row.location);
		expect(elapsed).toBeLessThan(BUDGET_MS);
	}
}

describe("text-runner location regex budget (#3871)", () => {
	it("keeps depth-30 text location parsing non-blocking (#3871 F2)", () => {
		const nested = Array.from({ length: 30 }, (_, index) => `d${index}`).join(
			"/",
		);
		expectWithinBudget([
			{
				name: "phpunit",
				parse: (client) =>
					client.parsePhpunitOutput(
						`1) A::a\n/${nested}/file.txt\ntests/Foo.php:7\nTests: 1, Errors: 1.`,
						"",
						1,
						"/repo/tests/Foo.php",
						"phpunit",
						"/repo",
						"/repo",
						"/repo",
					),
				location: "tests/Foo.php:7",
			},
			{
				name: "mix",
				parse: (client) =>
					client.parseMixTestOutput(
						`  1) test a (FooTest)\n  /${nested}/file.txt\n  test/foo_test.exs:9\n1 test, 1 failure`,
						"",
						1,
						"/repo/test/foo_test.exs",
						"mix",
						"/repo",
						"/repo",
						"/repo",
					),
				location: "test/foo_test.exs:9",
			},
			{
				name: "generic",
				parse: (client) =>
					client.parseGenericRunnerOutput(
						`FAILED /${nested}/test.py::test_value\n1 tests completed, 1 failed`,
						"",
						1,
						"/repo/test.py",
						"generic",
						"/repo",
						"/repo",
						"/repo",
					),
				location: undefined,
			},
		]);
	});

	it("keeps blank-run and long-token runner output linear (#3871 r3)", () => {
		// Recurrence (#3871 r2 verify LOW-1, Sonar S8786): `\s*` after a line
		// anchor crossed newlines, so each of 100K blank lines restarted a scan
		// of the whole run, and the unanchored generic match restarted inside a
		// 100K-character token at every offset.
		const blank = "\n".repeat(100_000);
		const token = "a".repeat(100_000);
		expectWithinBudget([
			{
				name: "phpunit blank run",
				parse: (client) =>
					client.parsePhpunitOutput(
						`1) A::a\nx${blank}tests/Foo.php:7\nTests: 1, Errors: 1.`,
						"",
						1,
						"/repo/tests/Foo.php",
						"phpunit",
						"/repo",
						"/repo",
						"/repo",
					),
				location: "tests/Foo.php:7",
			},
			{
				name: "mix blank run",
				parse: (client) =>
					client.parseMixTestOutput(
						`  1) test a (FooTest)\n  x${blank}  test/foo_test.exs:9\n1 test, 1 failure`,
						"",
						1,
						"/repo/test/foo_test.exs",
						"mix",
						"/repo",
						"/repo",
						"/repo",
					),
				location: "test/foo_test.exs:9",
			},
			// No location after the run: every line start fails, which is the
			// shape a `\s*` location scan pays for on every line.
			{
				name: "phpunit blank run, no location",
				parse: (client) =>
					client.parsePhpunitOutput(
						`1) A::a\nx${blank}y\nTests: 1, Errors: 1.`,
						"",
						1,
						"/repo/tests/Foo.php",
						"phpunit",
						"/repo",
						"/repo",
						"/repo",
					),
				location: undefined,
			},
			{
				name: "mix blank run, no location",
				parse: (client) =>
					client.parseMixTestOutput(
						`  1) test a (FooTest)\n  x${blank}y\n1 test, 1 failure`,
						"",
						1,
						"/repo/test/foo_test.exs",
						"mix",
						"/repo",
						"/repo",
						"/repo",
					),
				location: "FooTest",
			},
			{
				name: "generic long token",
				parse: (client) =>
					client.parseGenericRunnerOutput(
						`FAILED see ${token} at tests/widget.py:12\n1 tests completed, 1 failed`,
						"",
						1,
						"/repo/tests/widget.py",
						"generic",
						"/repo",
						"/repo",
						"/repo",
					),
				location: "tests/widget.py:12",
			},
		]);
	});
});
