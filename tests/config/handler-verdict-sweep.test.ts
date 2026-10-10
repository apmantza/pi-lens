/**
 * Governance: a test never calls `handleToolCall` without the swallowed-throw
 * check (#3518; recurrence #4182).
 *
 * `handleToolCall` absorbs every throw as "no opinion" (`undefined`) plus one
 * `tool-call-handler-throw` ledger record, so a test whose mocks are
 * incomplete reads a crash as the verdict it asserts. #4182's review found
 * `observed-mutation-integration.test.ts` in exactly that state: a
 * `clients/bootstrap.js` mock without `requestBootstrapClients` made the
 * handler throw before the read guard, and every "result is undefined / not
 * blocked" assertion passed regardless. #4182 fixed that file by hand and swept
 * 33 bootstrap mocks by hand; nothing stopped the next test file from
 * repeating it. `tests/support/handler-verdict.ts` is the one check;
 * this sweep fails the next file that calls the handler without it.
 *
 * The detector reads CODE, not prose: `stripSource` blanks comments and string
 * contents before any needle runs, so a comment saying "wrapped in
 * runHandlerExpectingNoThrow" cannot satisfy the requirement and a call named
 * in a string cannot trip it. A call counts as checked only when it sits
 * lexically inside the argument list of a `runHandlerExpectingNoThrow(...)`
 * CALL (a call in the same file's comment or string does not open one).
 *
 * What the sweep covers, and why this is the whole population:
 *
 * - Direct `handleToolCall(...)` calls, bare or member form: every one must be
 *   inside the helper, or be registered below with a reason.
 * - The pi hook route (`pi.emit("tool_call")`, `getHandlers("tool_call")`,
 *   `getHandlerOrThrow("tool_call")`, `handlers.get("tool_call")`) all run the
 *   handler `tests/support/pi-mock.ts` registered, and that mock wraps every
 *   `tool_call` registration in the helper. The sweep pins that wrapping at the
 *   source and `tests/clients/handler-verdict-helper.test.ts` pins it at
 *   runtime, including for a test that calls `vi.resetModules()` and imports
 *   `index.js` (the helper reads the ledger of both module graphs, #4201 F1).
 * - Every other hook handler either has no whole-handler catch
 *   (`handleToolResult`, `handleAgentEnd`, `handleTurnEnd`,
 *   `handleSessionStart`: a throw rejects the awaited call) or rethrows under
 *   vitest (`surfaceHandlerCrash`, #2884), so a swallowed throw cannot read as
 *   a verdict there. The helper still watches `hook-handler-crash` for the
 *   `rethrow: false` sites.
 *
 * Known limit: a test file that builds its OWN host mock and registers a
 * `tool_call` handler on it bypasses `pi-mock.ts`. None exists
 * (`grep -rn 'on("tool_call"' tests` finds only the fixture file registering on
 * the checked mock); the first one would need to adopt `createPiMock`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	assertNonEmptyScan,
	auditRegistry,
	listSourceFiles,
	matchingCloseIndex,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const TESTS_ROOT = path.join(REPO_ROOT, "tests");

const HELPER = "runHandlerExpectingNoThrow";

/**
 * Tests that call `handleToolCall` WITHOUT the helper because they make the
 * handler throw on purpose to test its guard. Key: `<file> :: <it() title>`.
 * An entry whose test no longer holds a raw call is reported as stale.
 */
const INTENTIONAL_DEGRADATION: Readonly<Record<string, string>> = {
	"tests/clients/pi-host-contract.test.ts :: absorbs a handler-internal throw and records one degradation":
		"Makes the handler throw through getFlag to assert the total guard returns undefined and records one tool-call-handler-throw row; the helper would fail the call this test requires to succeed.",
	"tests/clients/pi-host-contract.test.ts :: records the repeat throw once per tool name":
		"Calls the throwing handler three times to assert the ledger keeps one record per tool name; the helper refuses a call after a recorded swallow, which is the state under test.",
	"tests/clients/pi-host-contract.test.ts :: still blocks an unread edit when the attribution cleanup throws":
		"Makes the blocked-attribution cleanup throw to assert the block verdict survives and the swallow is recorded under attribution-cleanup:<tool>; the recorded throw is the assertion.",
};

export interface HandlerCallScan {
	/** `handleToolCall(` call sites inside a `runHandlerExpectingNoThrow(...)` argument list. */
	checked: number;
	/** Call sites outside one, with the enclosing `it()` title when found. */
	raw: Array<{ line: number; title: string | undefined }>;
	/** References that evade call-shaped detection (alias import, passed as a value). */
	escapes: Array<{ line: number; text: string }>;
}

function lineOf(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
	return line;
}

/** Blank every `import ... from "x"` statement, preserving length and lines. */
function blankImports(code: string, withStrings: string): string {
	const out = code.split("");
	for (const match of withStrings.matchAll(
		/(^|\n)[ \t]*import\b[^;]*?\bfrom\s*["'][^"']+["']\s*;?/g,
	)) {
		const start = (match.index ?? 0) + (match[1]?.length ?? 0);
		const end = (match.index ?? 0) + match[0].length;
		for (let i = start; i < end; i++) if (out[i] !== "\n") out[i] = " ";
	}
	return out.join("");
}

export function scanHandlerCalls(source: string): HandlerCallScan {
	const code = stripSource(source, { strings: "blank" });
	const withStrings = stripSource(source, { strings: "keep" });
	const checkedRanges: Array<[number, number]> = [];
	for (const match of code.matchAll(new RegExp(`\\b${HELPER}\\s*\\(`, "g"))) {
		const open = (match.index ?? 0) + match[0].length - 1;
		const close = matchingCloseIndex(code, open, "(", ")");
		checkedRanges.push([open, close === -1 ? code.length : close]);
	}
	const titles = [
		...withStrings.matchAll(
			/\b(?:it|test)(?:\.\w+)*\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g,
		),
	].map((match) => ({ index: match.index ?? 0, title: match[2] }));

	const result: HandlerCallScan = { checked: 0, raw: [], escapes: [] };
	for (const match of code.matchAll(/\bhandleToolCall\s*\(/g)) {
		const index = match.index ?? 0;
		if (checkedRanges.some(([open, close]) => index > open && index < close)) {
			result.checked++;
			continue;
		}
		const title = titles.filter((entry) => entry.index < index).at(-1)?.title;
		result.raw.push({ line: lineOf(source, index), title });
	}

	const codeNoImports = blankImports(code, withStrings);
	for (const match of codeNoImports.matchAll(/\bhandleToolCall\b(?!\s*\()/g)) {
		const index = match.index ?? 0;
		if (
			/\btypeof\s+$/.test(codeNoImports.slice(Math.max(0, index - 12), index))
		)
			continue;
		result.escapes.push({
			line: lineOf(source, index),
			text: "handleToolCall used as a value",
		});
	}
	for (const match of code.matchAll(/\bhandleToolCall\s+as\s+\w+/g)) {
		result.escapes.push({
			line: lineOf(source, match.index ?? 0),
			text: "handleToolCall imported under an alias",
		});
	}
	return result;
}

interface PopulationScan {
	scannedFiles: number;
	checked: number;
	flagged: Array<{ key: string; detail: string }>;
	escapes: string[];
}

function scanPopulation(): PopulationScan {
	const files = listSourceFiles(TESTS_ROOT, {
		exclude: (rel) =>
			rel.startsWith("fixtures/") ||
			// The helper's own header names the call in prose; the fixture test
			// calls the handler raw ON PURPOSE to show what the helper catches.
			rel === "support/handler-verdict.ts" ||
			rel === "clients/handler-verdict-helper.test.ts",
	});
	const population: PopulationScan = {
		scannedFiles: files.length,
		checked: 0,
		flagged: [],
		escapes: [],
	};
	for (const file of files) {
		const source = fs.readFileSync(file, "utf8");
		if (!source.includes("handleToolCall")) continue;
		const rel = `tests/${relativePosix(TESTS_ROOT, file)}`;
		const scan = scanHandlerCalls(source);
		population.checked += scan.checked;
		for (const site of scan.raw) {
			population.flagged.push({
				key: `${rel} :: ${site.title ?? "(outside any it)"}`,
				detail: `${rel}:${site.line}`,
			});
		}
		for (const escape of scan.escapes) {
			population.escapes.push(`${rel}:${escape.line} ${escape.text}`);
		}
	}
	return population;
}

describe("#3518 — handleToolCall is called through the swallowed-throw check", () => {
	const population = scanPopulation();

	it("scans a real population (floor)", () => {
		assertNonEmptyScan(
			"handler-verdict sweep: test files",
			population.scannedFiles,
			400,
		);
		// 14 migrated files held 135 call sites (130 checked, 5 registered raw) when this sweep landed.
		assertNonEmptyScan(
			"handler-verdict sweep: checked call sites",
			population.checked,
			120,
		);
	});

	it("has no raw handleToolCall call outside the registered intentional-degradation tests", () => {
		const audit = auditRegistry({
			sweepName: "handler-verdict sweep",
			flagged: population.flagged,
			registered: [],
			exemptions: INTENTIONAL_DEGRADATION,
			requireUniqueFlagged: false,
			minFlagged: 1,
			remediation: `Wrap the call: await ${HELPER}(() => handleToolCall(deps)) from tests/support/handler-verdict.ts. handleToolCall swallows every throw as "no opinion", so an unchecked verdict can pass on a crashed handler (#4182). A test that makes the handler throw on purpose is registered in INTENTIONAL_DEGRADATION with its reason.`,
		});
		expect(audit.problems).toEqual([]);
	});

	it("has no handleToolCall reference that evades the call-shaped check", () => {
		expect(population.escapes).toEqual([]);
	});

	it("pins the pi mock wrapping every tool_call registration in the helper", () => {
		const source = fs.readFileSync(
			path.join(TESTS_ROOT, "support/pi-mock.ts"),
			"utf8",
		);
		const code = stripSource(source, { strings: "keep" });
		expect(code).toMatch(
			new RegExp(`event === "tool_call"[\\s\\S]{0,200}\\b${HELPER}\\s*\\(`),
		);
	});

	describe("detector (fixture sources)", () => {
		const check = (source: string) => scanHandlerCalls(source);

		it("accepts a call inside the helper", () => {
			const scan = check(
				`it("x", async () => { await ${HELPER}(() => handleToolCall(deps)); });`,
			);
			expect(scan).toMatchObject({ checked: 1, raw: [], escapes: [] });
		});

		it("flags a bare call, a member call, and names the enclosing it()", () => {
			const scan = check(
				[
					`it("bare", async () => { await handleToolCall(deps); });`,
					`it("member", async () => { await mod.handleToolCall(deps); });`,
				].join("\n"),
			);
			expect(scan.raw).toEqual([
				{ line: 1, title: "bare" },
				{ line: 2, title: "member" },
			]);
		});

		it("is not satisfied by prose: a comment or string naming the helper opens no checked range", () => {
			const scan = check(
				[
					`// ${HELPER}(() => handleToolCall(deps)) is what this should use`,
					`const note = "${HELPER}(";`,
					`it("raw", async () => { await handleToolCall(deps); /* ${HELPER}( */ });`,
				].join("\n"),
			);
			expect(scan.checked).toBe(0);
			expect(scan.raw).toHaveLength(1);
		});

		it("is not tripped by prose: a call named in a comment or string is not a call", () => {
			const scan = check(
				[
					`// await handleToolCall(deps);`,
					`const text = "handleToolCall(deps)";`,
					"const tpl = `handleToolCall(${x})`;",
				].join("\n"),
			);
			expect(scan).toMatchObject({ checked: 0, raw: [], escapes: [] });
		});

		it("is not satisfied by importing the helper: only a call opens a checked range", () => {
			// Every migrated file imports the helper, so a detector that read the
			// import as an opening would excuse every raw call after it.
			const scan = check(
				[
					`import { ${HELPER} } from "../support/handler-verdict.js";`,
					`it("raw", async () => { await handleToolCall(deps); });`,
				].join("\n"),
			);
			expect(scan.checked).toBe(0);
			expect(scan.raw).toEqual([{ line: 2, title: "raw" }]);
		});

		it("flags a call after the helper's own argument list closed", () => {
			const scan = check(
				`it("after", async () => { await ${HELPER}(() => other()); await handleToolCall(deps); });`,
			);
			expect(scan.checked).toBe(0);
			expect(scan.raw).toHaveLength(1);
		});

		it("flags an alias import and a value reference, and allows typeof and a plain import", () => {
			expect(
				check(
					`import { handleToolCall as run } from "../../clients/runtime-tool-call.js";`,
				).escapes,
			).toHaveLength(1);
			expect(
				check(`const run = handleToolCall;\nrun(deps);`).escapes,
			).toHaveLength(1);
			expect(check(`vi.fn(handleToolCall);`).escapes).toHaveLength(1);
			expect(
				check(
					[
						`import { handleToolCall } from "../../clients/runtime-tool-call.js";`,
						`type Deps = Parameters<typeof handleToolCall>[0];`,
					].join("\n"),
				),
			).toMatchObject({ checked: 0, raw: [], escapes: [] });
		});
	});
});
