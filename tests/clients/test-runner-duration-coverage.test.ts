import { afterEach, describe, expect, it, vi } from "vitest";
import { TestRunnerClient } from "../../clients/test-runner-client.js";
import * as durations from "../../clients/run-duration.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const text = (output: string, runner: string) => [
	output,
	"",
	0,
	"duration.test",
	runner,
];
const json = (suites: unknown[]) => [
	JSON.stringify({ numPassedTests: 1, numFailedTests: 0, testResults: suites }),
	"",
	"duration.test.ts",
	".",
	"vitest",
];
const span = [{ startTime: 1000, endTime: 1040.6 }];
const dotnet =
	"Failed: 0, Passed: 1, Skipped: 0, Total: 1, Duration: 2 s 345 ms - t.dll";
const assertions = [
	{ assertionResults: [{ duration: 20.2 }, { duration: 20.4 }] },
];
// #1484: include delegators as well as leaves; a new parse* method or field
// must acquire a measured/absent witness before joining this population.
const cases: Array<[string, unknown[], unknown[], number]> = [
	["parseJsonTestOutput", json(span), json([{}]), 41],
	["parseVitestOutput", json(span), json([{}]), 41],
	["parseJestOutput", json(span), json([{}]), 41],
	["jsonRunDurationMs", [span], [[{}]], 41],
	[
		"jsonRunDurationMs",
		[assertions],
		[[{ assertionResults: [{ duration: -1 }] }]],
		41,
	],
	["jsonRunDurationMs", [[{ startTime: 1000, endTime: 1000 }]], [[{}]], 0],
	[
		"parsePytestOutput",
		["===== 1 passed in 2.01s =====", "", 0, "test_duration.py", ".", "pytest"],
		["unrecognized", "", 0, "test_duration.py", ".", "pytest"],
		2010,
	],
	[
		"parsePytestOutput",
		["1 passed in 0.00s", "", 0, "test_duration.py", ".", "pytest"],
		["unrecognized", "", 0, "test_duration.py", ".", "pytest"],
		0,
	],
	[
		"parsePhpunitOutput",
		text("Time: 00:00.123\nOK (1 test, 1 assertion)", "phpunit"),
		text("unrecognized", "phpunit"),
		123,
	],
	[
		"parsePhpunitOutput",
		text("Time: 00:00.000", "phpunit"),
		text("Time: . seconds", "phpunit"),
		0,
	],
	[
		"parsePhpunitOutput",
		text("Time: 2.01 seconds", "phpunit"),
		text("Time: 0 seconds", "phpunit"),
		2010,
	],
	[
		"parseMixTestOutput",
		text("Finished in 2.01 seconds\n1 test, 0 failures", "mix"),
		text("unrecognized", "mix"),
		2010,
	],
	[
		"parseMixTestOutput",
		text("Finished in 0.00 seconds", "mix"),
		text("unrecognized", "mix"),
		0,
	],
	[
		"parseGenericRunnerOutput",
		text("ok example.com/pkg 0.253s", "go"),
		text("unrecognized", "go"),
		253,
	],
	[
		"parseGenericRunnerDuration",
		["ok example.com/pkg 0.253s", "go"],
		["unrecognized", "go"],
		253,
	],
	["parseGoDuration", ["ok example.com/pkg 0.253s"], ["unrecognized"], 253],
	[
		"parseCargoDuration",
		["test result: ok.; finished in 0.25s"],
		["unrecognized"],
		250,
	],
	["parseDotnetDuration", [dotnet], ["unrecognized"], 2345],
	[
		"parseDotnetDuration",
		[dotnet.replace("2 s 345 ms", "< 1 ms")],
		["unrecognized"],
		0,
	],
	[
		"parseMavenDuration",
		["Tests run: 1, Time elapsed: 0.175 s"],
		["unrecognized"],
		175,
	],
	[
		"parseRspecDuration",
		["Finished in 0.32394 seconds"],
		["unrecognized"],
		324,
	],
	[
		"parseMinitestDuration",
		["Finished in 0.254594s, 7.8557 runs/s"],
		["unrecognized"],
		255,
	],
];
const client = new TestRunnerClient(false) as unknown as Record<
	string,
	(...args: unknown[]) => unknown
>;
const reading = (method: string, args: unknown[]) => {
	const result = client[method](...args);
	return typeof result === "object" && result !== null
		? (result as { duration?: number }).duration
		: result;
};
const parserNames = () =>
	[
		...new Set([
			...Object.getOwnPropertyNames(Object.getPrototypeOf(client)),
			...Object.getOwnPropertyNames(client),
		]),
	]
		.filter((name) => /^(?:parse|jsonRunDurationMs$)/.test(name))
		.sort();

afterEach(() => vi.restoreAllMocks());

describe("shared duration normalization (#1484)", () => {
	it.each(cases)(
		"preserves %s measured and absent readings",
		(method, valid, invalid, expected) => {
			expect(reading(method, valid)).toBe(expected);
			expect(reading(method, invalid)).toBeUndefined();
		},
	);

	it.each(cases)(
		"routes %s measurements through the shared helper",
		(method, valid, _invalid, expected) => {
			// Observe the real normalizer without replacing its implementation.
			const normalize = vi.spyOn(durations, "toMeasuredDurationMs");
			expect(reading(method, valid)).toBe(expected);
			expect(normalize).toHaveReturnedWith(expected);
		},
	);

	it("enumerates every parser and requires a duration witness or configuration exemption", () => {
		const discovered = parserNames();
		assertNonEmptyScan(
			"test result and duration parsers",
			discovered.length,
			16,
		);
		// Configuration globs produce no test result or duration.
		expect(discovered).toEqual(
			[
				...new Set(cases.map(([method]) => method)),
				"parseVitestTestGlobs",
			].sort(),
		);
	});

	it("leaves a malformed ExUnit duration unmeasured", () => {
		// Synthetic malformed text: real ExUnit does not print a dot alone.
		expect(
			reading(
				"parseMixTestOutput",
				text("Finished in . seconds\n1 test, 0 failures", "mix"),
			),
		).toBeUndefined();
	});
});
