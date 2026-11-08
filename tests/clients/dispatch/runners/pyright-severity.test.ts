import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import pyrightRunner, {
	normalizePyrightSeverity,
	parsePyrightOutput,
} from "../../../../clients/dispatch/runners/pyright.js";
import type { Diagnostic } from "../../../../clients/dispatch/types.js";
import { convertLspDiagnostics } from "../../../../clients/dispatch/utils/lsp-diagnostics.js";
import { setupTestEnvironment } from "../../test-utils.js";

/**
 * #1802: pyright's `--outputjson` output declares three severities on
 * `generalDiagnostics[].severity` — "error", "warning", "information" — but
 * the runner collapsed "information" into "warning", the same defect shape
 * #1787 fixed for ast-grep-napi and #1791 fixed for biome-check. These tests
 * import the REAL `parsePyrightOutput`/`normalizePyrightSeverity` from the
 * compiled runner (not an inlined copy) so the mapping can't drift silently
 * out of sync with what's shipped.
 *
 * #1802 fix round: the original fixture used an invented `{ start: { line,
 * column } }` shape pyright never emits. The real shape (pyright's own
 * docs, docs/command-line.md "JSON Output") is
 * `{ file, severity, message, rule?, range: { start: { line, character },
 * end } }` — no top-level `start`, and `range` positions are zero-based.
 * `range` is omitted entirely when pyright has nothing to point at. Fixed
 * both the fixture shape and the parser (which previously read a `start`
 * field that real pyright output never has, so every real diagnostic
 * landed at line 0/column 0).
 */
describe("normalizePyrightSeverity", () => {
	it("maps information to info", () => {
		expect(normalizePyrightSeverity("information")).toBe("info");
	});

	it("passes error and warning through unchanged", () => {
		expect(normalizePyrightSeverity("error")).toBe("error");
		expect(normalizePyrightSeverity("warning")).toBe("warning");
	});

	it("falls back to warning for an unrecognized value", () => {
		expect(normalizePyrightSeverity(undefined)).toBe("warning");
		expect(normalizePyrightSeverity("bogus" as never)).toBe("warning");
	});
});

describe("parsePyrightOutput", () => {
	// Documented pyright --outputjson shape: no top-level `start`, and
	// `range.start`/`range.end` positions are zero-based.
	function makeData(severity: string) {
		return {
			generalDiagnostics: [
				{
					severity,
					message: "example diagnostic",
					file: "/proj/example.py",
					rule: "reportExample",
					range: {
						start: { line: 2, character: 4 },
						end: { line: 2, character: 10 },
					},
				},
			],
		};
	}

	it("preserves pyright's information tier as info, not warning", () => {
		const diags = parsePyrightOutput(
			makeData("information"),
			"/proj/example.py",
		);
		expect(diags).toHaveLength(1);
		expect(diags[0].severity).toBe("info");
		// Non-error severities stay non-blocking.
		expect(diags[0].semantic).toBe("warning");
	});

	it("keeps error diagnostics blocking", () => {
		const diags = parsePyrightOutput(makeData("error"), "/proj/example.py");
		expect(diags[0].severity).toBe("error");
		expect(diags[0].semantic).toBe("blocking");
	});

	it("keeps warning diagnostics as warning/non-blocking", () => {
		const diags = parsePyrightOutput(makeData("warning"), "/proj/example.py");
		expect(diags[0].severity).toBe("warning");
		expect(diags[0].semantic).toBe("warning");
	});

	it("never widens blocking classification for the info tier", () => {
		const diags = parsePyrightOutput(
			makeData("information"),
			"/proj/example.py",
		);
		// Mutation guard: an info-tier diagnostic must stay non-blocking even
		// though its severity display tier changed.
		expect(diags[0].semantic).not.toBe("blocking");
	});

	it("converts range.start's zero-based line/character to one-based line/column", () => {
		// #1802 fix round: on pre-fix code every real diagnostic landed at
		// line 0/column 0, because the parser read a top-level `start` field
		// real pyright output never sets. line 2 (0-based) / character 4
		// (0-based) must become line 3 / column 5.
		const diags = parsePyrightOutput(makeData("warning"), "/proj/example.py");
		expect(diags[0].line).toBe(3);
		expect(diags[0].column).toBe(5);
	});

	it("falls back to line 1/column 1 when range is omitted", () => {
		// pyright omits `range` entirely when it has no location to report.
		const data = {
			generalDiagnostics: [
				{
					severity: "error",
					message: "no location",
					file: "/proj/example.py",
					rule: "reportExample",
				},
			],
		};
		const diags = parsePyrightOutput(data, "/proj/example.py");
		expect(diags[0].line).toBe(1);
		expect(diags[0].column).toBe(1);
	});
});

/**
 * #5412: one pyright "information" finding reached two semantics. The CLI
 * parser gave it `warning` (the advisory tier the CLI runners share), and the
 * LSP converter gave the same severity-3 finding `none`, so the copy the
 * dispatcher kept depended on which lane answered first. Recurrence: the
 * 2026-11-08 tool-alignment audit, `parsePyrightOutput` against
 * `convertLspDiagnostics` on one finding (origin/master 90724817f).
 */
describe("pyright information tier agrees across the CLI and the LSP (#5412)", () => {
	const message = 'Import "os" is not accessed';
	const range = {
		start: { line: 2, character: 4 },
		end: { line: 2, character: 10 },
	};

	it("gives one information finding the same semantic through both paths", () => {
		const cli = parsePyrightOutput(
			{
				generalDiagnostics: [
					{
						severity: "information",
						message,
						file: "/proj/example.py",
						rule: "reportUnusedImport",
						range,
					},
				],
			},
			"/proj/example.py",
		);
		const lsp = convertLspDiagnostics(
			[
				{
					severity: 3,
					code: "reportUnusedImport",
					source: "Pyright",
					message,
					range,
				},
			] as never,
			"/proj/example.py",
		);
		expect(cli[0]?.semantic).toBe("warning");
		expect(lsp[0]?.semantic).toBe(cli[0]?.semantic);
	});

	// Recurrence: the #5412 r1 review. The branch that gives an unset severity
	// the warning tier (`|| !d.severity`) survived every convertLspDiagnostics
	// test, so an LSP diagnostic with no severity could turn into a blocker
	// candidate without a red.
	it("keeps an LSP diagnostic with no severity at semantic none", () => {
		const lsp = convertLspDiagnostics(
			[
				{ code: "reportUnusedImport", source: "Pyright", message, range },
			] as never,
			"/proj/example.py",
		);
		expect(lsp).toHaveLength(1);
		expect(lsp[0]?.semantic).toBe("none");
	});
});

/**
 * #5412: a pyright finding with no rule (a syntax error, say) took its id from
 * the line alone, `pyright-<line>`. Two such findings on one line therefore
 * shared an id, and the dispatcher's `findingKey` (which reads `rule || id`)
 * kept one. Recurrence: the same audit, `pyright-${rule || line}` in pyright.ts.
 */
describe("rule-less pyright findings keep distinct identities (#5412)", () => {
	it("gives two rule-less findings on one line two different ids", () => {
		const range = {
			start: { line: 4, character: 0 },
			end: { line: 4, character: 1 },
		};
		const diags = parsePyrightOutput(
			{
				generalDiagnostics: [
					{ severity: "error", message: "Expected expression", range },
					{ severity: "error", message: "Unexpected indentation", range },
				],
			},
			"/proj/example.py",
		);
		expect(diags).toHaveLength(2);
		expect(diags[0]?.rule).toBeUndefined();
		expect(diags[1]?.rule).toBeUndefined();
		expect(diags[0]?.id).not.toBe(diags[1]?.id);
	});

	it("gives the same message on two lines two different ids", () => {
		const at = (line: number) => ({
			severity: "error",
			message: "Expected expression",
			range: {
				start: { line, character: 0 },
				end: { line, character: 1 },
			},
		});
		const diags = parsePyrightOutput(
			{ generalDiagnostics: [at(2), at(8)] },
			"/proj/example.py",
		);
		expect(diags).toHaveLength(2);
		expect(diags[0]?.id).not.toBe(diags[1]?.id);
	});
});

/**
 * #5412 round 2: a rule-less id keeps its line, as go vet's does. Run 1 holds
 * one syntax error on line 3; run 2 adds the same message on line 9. Run 2
 * must announce line 9 and must not repeat line 3, because the delta reads
 * `Diagnostic.id` alone. Recurrence: the r1 review probe, where
 * `pyright-<hash(message)>` gave both lines one id and the delta held the new
 * error back as already seen (run 2 delivered nothing).
 */
describe("rule-less pyright findings stay apart in delta mode (#5412)", () => {
	it("announces the second identical message on another line on the next run", async () => {
		const env = setupTestEnvironment("pi-lens-pyright-delta-");
		try {
			const file = path.join(env.tmpDir, "a.py");
			fs.writeFileSync(file, "x = (\n");
			const facts = new FactStore();
			let answer: Diagnostic[] = [];
			const registry = new RunnerRegistry();
			registry.register({
				...pyrightRunner,
				run: async () => ({
					status: "failed" as const,
					diagnostics: answer,
					semantic: "blocking" as const,
				}),
			});
			const dispatch = () =>
				dispatchForFile(
					createDispatchContext(
						file,
						env.tmpDir,
						{ getFlag: () => false },
						facts,
					),
					[{ mode: "all", runnerIds: ["pyright"] }],
					registry,
				);
			const error = (line: number) => ({
				severity: "error",
				message: "Expected expression",
				file,
				range: { start: { line, character: 0 }, end: { line, character: 1 } },
			});

			answer = parsePyrightOutput({ generalDiagnostics: [error(2)] }, file);
			const first = await dispatch();
			expect(first.diagnostics.map((d) => d.line)).toEqual([3]);

			answer = parsePyrightOutput(
				{ generalDiagnostics: [error(2), error(8)] },
				file,
			);
			const second = await dispatch();
			expect(second.diagnostics.map((d) => d.line)).toEqual([9]);
		} finally {
			env.cleanup();
		}
	});
});
