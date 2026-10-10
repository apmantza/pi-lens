/**
 * #4148: the pytest traceback regex was rewritten for linear time. It must
 * match the same outputs and capture the same text as the form it replaced.
 * `OLD_TRACEBACK` is that replaced form, kept here only as the oracle; the
 * new side runs through `parsePytestOutput`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TestRunnerClient } from "../../clients/test-runner-client.js";

const OLD_TRACEBACK = /_{10,}\s*\n\s*(\w+Error:\s*.+?)(?:\n|$)/gs;

const token = fc.constantFrom(
	"_",
	"__________",
	"___________",
	" ",
	"\t",
	"\n",
	"\n",
	"\r",
	"\r\n",
	String.fromCharCode(0x2028),
	"x",
	"ValueError:",
	"ValueError: boom",
	"Error:",
	"Warning: w",
);
const tail = fc.array(token, { maxLength: 14 }).map((parts) => parts.join(""));

const HEADER = "FAILED tests/test_a.py::test_x - AssertionError: boom\n";

function oracleStack(output: string): string | undefined {
	OLD_TRACEBACK.lastIndex = 0;
	const first = OLD_TRACEBACK.exec(output);
	return first ? first[1].trim().slice(0, 1000) : undefined;
}

function productionStack(output: string): string | undefined {
	const client = new TestRunnerClient(false) as any;
	return client.parsePytestOutput(
		output,
		"",
		1,
		"/repo/tests/test_a.py",
		"/repo",
		"pytest",
	).failures[0]?.stack;
}

describe("pytest traceback regex equivalence (#4148)", () => {
	it("captures the same stack as the replaced regex on any rule, whitespace and error mix", () => {
		fc.assert(
			fc.property(tail, (rest) => {
				const output = `${HEADER}${rest}`;
				expect(productionStack(output)).toBe(oracleStack(`${output}\n`));
			}),
			{ numRuns: 3000 },
		);
	});

	it("keeps the blank-line and carriage-return cases the replaced regex accepted", () => {
		const rule = "_".repeat(12);
		expect(productionStack(`${HEADER}${rule}\n\n\n  ValueError: x\n`)).toBe(
			"ValueError: x",
		);
		expect(productionStack(`${HEADER}${rule}  \r\n\r\nValueError: x\n`)).toBe(
			"ValueError: x",
		);
		expect(productionStack(`${HEADER}${rule}\nx\n`)).toBeUndefined();
	});
});
