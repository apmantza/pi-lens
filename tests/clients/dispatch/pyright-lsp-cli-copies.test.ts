/**
 * #4629: a `.py` file's primary group runs the Pyright language server and the
 * `pyright` CLI runner together (`clients/language-policy.ts`, `mode: "all"`).
 * The server publishes `source: "Pyright"` (`"basedpyright"` for that fork) and
 * `convertLspDiagnostics` renders its rule `<source>:<code>`; the CLI prints the
 * bare code. One finding therefore reached the agent twice, and a bare Pyright
 * code in `rules.<id>.disable` hid only the CLI copy.
 *
 * The inputs are real bytes (`tests/fixtures/lsp-cli-copies/*.captured.json`,
 * one `app.py` through `pyright --outputjson` and through the language server's
 * `textDocument/publishDiagnostics`, pyright 1.1.414 and basedpyright 1.40.2).
 * Everything after the process boundary is production code: the real
 * `convertLspDiagnostics`, `parsePyrightOutput`, the primary group, and
 * `dispatchForFile` with its dedupe, rule policy and delta.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createDispatchContext,
	dispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { findingClassOf } from "../../../clients/dispatch/rule-id-normalize.js";
import { parsePyrightOutput } from "../../../clients/dispatch/runners/pyright.js";
import pyrightRunner from "../../../clients/dispatch/runners/pyright.js";
import lspRunner from "../../../clients/dispatch/runners/lsp.js";
import { convertLspDiagnostics } from "../../../clients/dispatch/utils/lsp-diagnostics.js";
import { getPrimaryDispatchGroup } from "../../../clients/language-policy.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import { pinFixtureHome, setupTestEnvironment } from "../test-utils.js";

interface Capture {
	provenance: { tool: string; version: string };
	text: string;
	cli: { stdout: string };
	lsp: { diagnostics: LSPDiagnostic[] };
}

const FLAVOURS = [
	{ fixture: "pyright.captured.json", source: "Pyright" },
	{ fixture: "basedpyright.captured.json", source: "basedpyright" },
] as const;

function loadCapture(fixture: string): Capture {
	return JSON.parse(
		fs.readFileSync(
			path.join(__dirname, "../../fixtures/lsp-cli-copies", fixture),
			"utf8",
		),
	) as Capture;
}

/** One `line:column:code` per finding, from the CLI's own bytes (1-based). */
function expectedFindings(capture: Capture): string[] {
	const parsed = JSON.parse(capture.cli.stdout) as {
		generalDiagnostics: {
			rule: string;
			range: { start: { line: number; character: number } };
		}[];
	};
	return parsed.generalDiagnostics
		.map(
			(d) =>
				`${d.range.start.line + 1}:${d.range.start.character + 1}:${d.rule}`,
		)
		.sort();
}

let tmpDir: string;
let file: string;
let cleanup: () => void;
let restoreHome: () => void;

beforeEach(() => {
	// The shared setup plants the fixture's own `.git` marker, so the project
	// root resolves to this directory and never to one above the tmp root.
	({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-pyright-copies-"));
	// A fixture HOME beside the worker home: the project-config walk stops
	// below the real `~/.pi-lens`, so an operator's config can never select the
	// rules these cases read (a `.git` marker does not bound that walk, #4629
	// review F4).
	({ restore: restoreHome } = pinFixtureHome("pyright-copies"));
	file = path.join(tmpDir, "app.py");
	resetProjectLensConfigCache();
});

afterEach(() => {
	restoreHome?.();
	cleanup();
	resetProjectLensConfigCache();
});

/**
 * Dispatch the file through the production python group. The two runner shells
 * keep their real id, kinds and priority; only `run` answers with the captured
 * bytes, converted by the real converter and parser.
 */
async function dispatchCopies(
	capture: Capture,
	lanes: {
		lsp?: LSPDiagnostic[];
		cliStdout?: string;
		/** One store across dispatches, so each one reads the last one's baseline. */
		facts?: FactStore;
	} = {},
) {
	const lspDiagnostics = convertLspDiagnostics(
		lanes.lsp ?? capture.lsp.diagnostics,
		file,
	);
	const cliDiagnostics = parsePyrightOutput(
		JSON.parse(lanes.cliStdout ?? capture.cli.stdout),
		file,
	).map((d) => ({ ...d, filePath: file }));
	const registry = new RunnerRegistry();
	const answer = (diagnostics: typeof cliDiagnostics) => async () => ({
		status: "succeeded" as const,
		diagnostics,
		semantic: diagnostics.some((d) => d.semantic === "blocking")
			? ("blocking" as const)
			: ("warning" as const),
	});
	registry.register({ ...lspRunner, run: answer(lspDiagnostics) });
	registry.register({ ...pyrightRunner, run: answer(cliDiagnostics) });
	const group = getPrimaryDispatchGroup("python", true);
	if (!group) throw new Error("python has no primary dispatch group");
	const ctx = createDispatchContext(
		file,
		tmpDir,
		{ getFlag: () => false },
		lanes.facts ?? new FactStore(),
	);
	return dispatchForFile(ctx, [group], registry);
}

/** The CLI's bytes, parsed, for a case that edits what the CLI reports. */
function cliOutput(capture: Capture) {
	return JSON.parse(capture.cli.stdout) as {
		generalDiagnostics: {
			rule: string;
			range: {
				start: { line: number; character: number };
				end: { line: number; character: number };
			};
		}[];
	};
}

function findings(
	diagnostics: { line?: number; column?: number; rule?: string }[],
) {
	return diagnostics
		.map(
			(d) => `${d.line}:${d.column}:${(d.rule ?? "").replace(/^[^:]+:/, "")}`,
		)
		.sort();
}

describe.each(FLAVOURS)(
	"$source language server and the pyright CLI report one file (#4629)",
	({ fixture, source }) => {
		const capture = loadCapture(fixture);

		it("names the same findings in both lanes, under two spellings of each rule", () => {
			// The premise: the lanes agree on what is wrong and disagree only on
			// how the rule is spelled, which is the identity the dedupe reads.
			const lsp = convertLspDiagnostics(capture.lsp.diagnostics, file);
			const cli = parsePyrightOutput(JSON.parse(capture.cli.stdout), file);
			expect(findings(lsp)).toEqual(findings(cli));
			expect(lsp.every((d) => d.rule?.startsWith(`${source}:`))).toBe(true);
			expect(cli.some((d) => d.rule?.includes(":"))).toBe(false);
		});

		it("lists each finding once when both lanes report it", async () => {
			const result = await dispatchCopies(capture);
			expect(findings(result.diagnostics)).toEqual(expectedFindings(capture));
		});

		it("keeps the language server's copy of each finding", async () => {
			const result = await dispatchCopies(capture);
			expect(new Set(result.diagnostics.map((d) => d.tool))).toEqual(
				new Set(["lsp"]),
			);
			expect(
				result.diagnostics.every((d) => d.rule?.startsWith(`${source}:`)),
			).toBe(true);
		});

		it("counts each error once in the STOP header the agent reads", async () => {
			// The CLI's own findings that block: its errors, and (#5416) a warning
			// in a cross-tool class, an unused import being one. Each is one entry
			// of the header though both lanes published it.
			const blocking = (
				JSON.parse(capture.cli.stdout) as {
					generalDiagnostics: { severity: string; rule: string }[];
				}
			).generalDiagnostics.filter(
				(d) =>
					d.severity === "error" ||
					findingClassOf({ tool: "pyright", rule: d.rule }) !== undefined,
			).length;
			const result = await dispatchCopies(capture);
			expect(result.output).toContain(
				`STOP — ${blocking} issue(s) must be fixed`,
			);
		});

		it("lists the CLI's findings when the language server publishes nothing", async () => {
			const result = await dispatchCopies(capture, { lsp: [] });
			expect(findings(result.diagnostics)).toEqual(expectedFindings(capture));
			expect(new Set(result.diagnostics.map((d) => d.tool))).toEqual(
				new Set(["pyright"]),
			);
		});

		it("lists the language server's findings when the CLI reports nothing", async () => {
			const result = await dispatchCopies(capture, {
				cliStdout: JSON.stringify({ generalDiagnostics: [] }),
			});
			expect(findings(result.diagnostics)).toEqual(expectedFindings(capture));
			expect(new Set(result.diagnostics.map((d) => d.tool))).toEqual(
				new Set(["lsp"]),
			);
		});

		it("keeps another server's same-named code beside the CLI copy (the prefix list is closed)", async () => {
			// `ty` is the opt-in Python fallback server (clients/lsp/server.ts). A
			// code it shares with Pyright's is another analyzer's finding.
			const foreign = capture.lsp.diagnostics
				.filter((d) => d.code === "reportAssignmentType")
				.map((d) => ({ ...d, source: "ty" }));
			expect(foreign).toHaveLength(1);
			const result = await dispatchCopies(capture, { lsp: foreign });
			expect(
				result.diagnostics
					.filter((d) => d.line === 15)
					.map((d) => d.rule)
					.sort(),
			).toEqual(["reportAssignmentType", "ty:reportAssignmentType"]);
		});

		it("hides both copies of a rule listed by its bare code in rules.<id>.disable", async () => {
			fs.writeFileSync(
				path.join(tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: {
						"pyright-assignment": { disable: ["reportAssignmentType"] },
					},
				}),
			);
			const result = await dispatchCopies(capture);
			const expected = expectedFindings(capture).filter(
				(f) => !f.endsWith(":reportAssignmentType"),
			);
			expect(findings(result.diagnostics)).toEqual(expected);
			expect(result.output).not.toContain("declared type");
		});

		it("calls nothing new when the language server goes silent on an unchanged file (#4629)", async () => {
			// Delta mode: the agent is told only what is NEW since the last dispatch.
			// The first one holds the language server's copy of each finding (its
			// copy wins the dedupe). The second sees the same file with only the
			// CLI's copy, which carries another id. One finding is one finding, so
			// the delta calls nothing new and nothing fixed.
			const facts = new FactStore();
			const first = await dispatchCopies(capture, { facts });
			expect(findings(first.diagnostics)).toEqual(expectedFindings(capture));

			const second = await dispatchCopies(capture, { facts, lsp: [] });
			expect(findings(second.diagnostics)).toEqual([]);
			expect(second.blockers).toEqual([]);
			expect(second.output).not.toContain("STOP");
			expect(second.resolvedCount).toBe(0);
		});

		it("calls nothing new when the language server comes back on an unchanged file (#4629)", async () => {
			// The other half of the same flap: the baseline now holds the CLI's copy,
			// and the language server's copy, which wins the dedupe, must not read as
			// new beside it.
			const facts = new FactStore();
			await dispatchCopies(capture, { facts });
			await dispatchCopies(capture, { facts, lsp: [] });

			const third = await dispatchCopies(capture, { facts });
			expect(findings(third.diagnostics)).toEqual([]);
			expect(third.blockers).toEqual([]);
			expect(third.output).not.toContain("STOP");
			expect(third.resolvedCount).toBe(0);
		});

		it("still calls a changed finding new and a gone one fixed while the language server is silent (#4629)", async () => {
			// The shared identity must not hide a real change: the same place under
			// another rule, and the same rule on another line, are different findings.
			const facts = new FactStore();
			await dispatchCopies(capture, { facts });

			const cli = cliOutput(capture);
			const gone = cli.generalDiagnostics.find(
				(d) => d.rule === "reportAssignmentType",
			);
			const repeated = cli.generalDiagnostics.find((d) => d !== gone);
			if (!gone || !repeated) throw new Error("the capture lost its premise");
			const otherRuleHere = { ...gone, rule: "reportCallIssue" };
			const sameRuleElsewhere = {
				...repeated,
				range: {
					start: { line: 59, character: 0 },
					end: { line: 59, character: 4 },
				},
			};
			cli.generalDiagnostics = [
				...cli.generalDiagnostics.filter((d) => d !== gone),
				otherRuleHere,
				sameRuleElsewhere,
			];

			const second = await dispatchCopies(capture, {
				facts,
				lsp: [],
				cliStdout: JSON.stringify(cli),
			});
			expect(findings(second.diagnostics)).toEqual(
				[
					`${gone.range.start.line + 1}:${gone.range.start.character + 1}:reportCallIssue`,
					`60:1:${repeated.rule}`,
				].sort(),
			);
			expect(second.resolvedCount).toBe(1);
		});

		it("still reads the id: an unchanged CLI finding that moved lines is not new (#4629)", async () => {
			// The shared identity joins the id, it does not replace it. The CLI's id
			// carries no line, so a finding that moved keeps it, and so stays known.
			const facts = new FactStore();
			await dispatchCopies(capture, { facts, lsp: [] });

			const cli = cliOutput(capture);
			const moved = cli.generalDiagnostics.find(
				(d) => d.rule === "reportAssignmentType",
			);
			if (!moved) throw new Error("the capture lost its premise");
			moved.range.start.line += 1;
			moved.range.end.line += 1;

			const second = await dispatchCopies(capture, {
				facts,
				lsp: [],
				cliStdout: JSON.stringify(cli),
			});
			expect(findings(second.diagnostics)).toEqual([]);
			expect(second.resolvedCount).toBe(0);
		});
	},
);
