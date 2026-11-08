/**
 * #5416: several tools name one issue with their own rule ids and severities.
 *
 * Recurrences this prevents (probed through the real `dispatchForFile` on
 * 90724817f):
 * - `const unused = 1;` warned under oxlint and blocked under biome, so the
 *   verdict depended on which linter of the fallback chain answered;
 * - `print(undefined_name)` reached the agent as two blockers (ruff `F821`,
 *   pyright `reportUndefinedVariable`) because their rules differ;
 * - the lintLike profile was keyed by the runner id `ruff-lint`, the runner
 *   emits the tool `ruff`, so the LSP-overlap filter never saw a ruff copy.
 *
 * The inputs are the tools' own captured bytes (`tests/fixtures/runner-output`,
 * `tests/fixtures/lsp-cli-copies`). The runner shells keep their real id,
 * kinds and priority; their `run` answers with what the runner's own exported
 * parser (`parseOxlintJson`, `parseBiomeJson`, `parseRuffJson`,
 * `parsePyrightOutput`, `convertLspDiagnostics`) makes of those bytes. The
 * plan, the dedupe, the delta and the verdict are production code.
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
import { TOOL_PLANS } from "../../../clients/dispatch/plan.js";
import {
	findingClassKey,
	findingClassOf,
	withClassSeverity,
} from "../../../clients/dispatch/rule-id-normalize.js";
import { parseBiomeJson } from "../../../clients/dispatch/runners/biome-check.js";
import biomeRunner from "../../../clients/dispatch/runners/biome-check.js";
import eslintRunner from "../../../clients/dispatch/runners/eslint.js";
import lspRunner from "../../../clients/dispatch/runners/lsp.js";
import oxlintRunner, {
	parseOxlintJson,
} from "../../../clients/dispatch/runners/oxlint.js";
import pyrightRunner, {
	parsePyrightOutput,
} from "../../../clients/dispatch/runners/pyright.js";
import ruffRunner, {
	parseRuffJson,
} from "../../../clients/dispatch/runners/ruff.js";
import { getToolProfile } from "../../../clients/dispatch/tool-profile.js";
import type {
	Diagnostic,
	RunnerDefinition,
	RunnerGroup,
	RunnerResult,
} from "../../../clients/dispatch/types.js";
import { convertLspDiagnostics } from "../../../clients/dispatch/utils/lsp-diagnostics.js";
import { getPrimaryDispatchGroup } from "../../../clients/language-policy.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import { resetProjectLensConfigCache } from "../../../clients/project-lens-config.js";
import { pinFixtureHome, setupTestEnvironment } from "../test-utils.js";

const FIXTURES = path.join(__dirname, "../../fixtures");

function captured(runner: string, name: string): { stdout: string } {
	return JSON.parse(
		fs.readFileSync(
			path.join(FIXTURES, "runner-output", runner, `${name}.captured.json`),
			"utf8",
		),
	) as { stdout: string };
}

let tmpDir: string;
let cleanup: () => void;
let restoreHome: () => void;

beforeEach(() => {
	({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-5416-"));
	({ restore: restoreHome } = pinFixtureHome("finding-class-5416"));
	resetProjectLensConfigCache();
});

afterEach(() => {
	restoreHome?.();
	cleanup();
	resetProjectLensConfigCache();
});

/** A real runner shell: its id, kinds and priority, answering with `diagnostics`. */
function answering(
	runner: RunnerDefinition,
	diagnostics: Diagnostic[],
): RunnerDefinition {
	return {
		...runner,
		run: async (): Promise<RunnerResult> => ({
			status: "succeeded",
			diagnostics,
			semantic: diagnostics.some((d) => d.semantic === "blocking")
				? "blocking"
				: "warning",
		}),
	};
}

/** The tool is not installed: the runner skips, as every runner does. */
function absent(runner: RunnerDefinition): RunnerDefinition {
	return {
		...runner,
		run: async (): Promise<RunnerResult> => ({
			status: "skipped",
			diagnostics: [],
			semantic: "none",
		}),
	};
}

async function dispatch(
	file: string,
	groups: RunnerGroup[],
	runners: RunnerDefinition[],
) {
	const registry = new RunnerRegistry();
	for (const runner of runners) registry.register(runner);
	const ctx = createDispatchContext(
		file,
		tmpDir,
		{ getFlag: () => false },
		new FactStore(),
	);
	return dispatchForFile(ctx, groups, registry);
}

describe("#5416: the blocking verdict does not depend on which JS linter answers", () => {
	/** The production JS fallback chain: eslint, then oxlint, then biome. */
	function jsChain(): RunnerGroup {
		const group = TOOL_PLANS.jsts.groups.find((g) =>
			g.runnerIds.includes("oxlint"),
		);
		if (!group) throw new Error("jsts plan has no oxlint group");
		return group;
	}

	/** oxlint's captured warning-tier `no-unused-vars`, parsed by its runner. */
	function oxlintUnused(file: string): Diagnostic[] {
		return parseOxlintJson(
			captured("oxlint", "warning-exit-zero").stdout,
			file,
			tmpDir,
		);
	}

	/** biome's captured `noUnusedVariables`, at the severity the project set. */
	function biomeUnused(file: string, severity: "warning" | "error") {
		const report = JSON.parse(captured("biome-check-json", "real").stdout);
		for (const d of report.diagnostics) d.severity = severity;
		return parseBiomeJson(JSON.stringify(report), file, tmpDir).diagnostics;
	}

	/** The same file answered once with oxlint present, once with it absent. */
	async function dispatchBothWays(biomeSeverity: "warning" | "error") {
		const file = path.join(tmpDir, "bad.js");
		fs.writeFileSync(file, "const unused = 1;\n");
		const withOxlint = await dispatch(
			file,
			[jsChain()],
			[
				absent(eslintRunner),
				answering(oxlintRunner, oxlintUnused(file)),
				answering(biomeRunner, biomeUnused(file, biomeSeverity)),
			],
		);
		const withoutOxlint = await dispatch(
			file,
			[jsChain()],
			[
				absent(eslintRunner),
				absent(oxlintRunner),
				answering(biomeRunner, biomeUnused(file, biomeSeverity)),
			],
		);
		// Each run was answered by the one tool its chain reached.
		expect(withOxlint.diagnostics.map((d) => d.tool)).toEqual(["oxlint"]);
		expect(withoutOxlint.diagnostics.map((d) => d.tool)).toEqual(["biome"]);
		return { withOxlint, withoutOxlint };
	}

	it("blocks an unused variable with oxlint present and absent when biome reports a warning", async () => {
		const { withOxlint, withoutOxlint } = await dispatchBothWays("warning");
		expect(withOxlint.hasBlockers).toBe(true);
		expect(withoutOxlint.hasBlockers).toBe(true);
		expect(withOxlint.blockers).toHaveLength(1);
		expect(withoutOxlint.blockers).toHaveLength(1);
	});

	it("blocks an unused variable with oxlint present and absent when biome reports an error", async () => {
		const { withOxlint, withoutOxlint } = await dispatchBothWays("error");
		expect(withOxlint.hasBlockers).toBe(true);
		expect(withoutOxlint.hasBlockers).toBe(true);
		expect(withOxlint.blockers).toHaveLength(1);
		expect(withoutOxlint.blockers).toHaveLength(1);
	});

	it("keeps the first-seen tier of a rule outside every class (no class swallows an unknown rule)", async () => {
		// A rule the table does not list keeps the severity its tool gave it, so
		// the class table is not a blanket "every warning blocks".
		const file = path.join(tmpDir, "bad.js");
		fs.writeFileSync(file, "debugger;\n");
		const warned: Diagnostic = {
			...oxlintUnused(file)[0],
			id: "oxlint-no-console-1",
			rule: "no-console",
			message: "Unexpected console statement. (no-console)",
		};
		const result = await dispatch(
			file,
			[jsChain()],
			[answering(oxlintRunner, [warned])],
		);
		expect(result.hasBlockers).toBe(false);
		expect(result.diagnostics.map((d) => d.semantic)).toEqual(["warning"]);
	});
});

describe("#5416: one undefined name is one blocker", () => {
	interface Capture {
		text: string;
		cli: { stdout: string };
		lsp: { diagnostics: LSPDiagnostic[] };
	}
	const capture = JSON.parse(
		fs.readFileSync(
			path.join(FIXTURES, "lsp-cli-copies", "pyright.captured.json"),
			"utf8",
		),
	) as Capture;

	/** The capture's `print(undefined_name)` is line 14, column 7. */
	const UNDEFINED_LINE = 14;
	const UNDEFINED_COLUMN = 7;

	function undefinedOnly<T extends { line?: number }>(items: T[]): T[] {
		return items.filter((d) => d.line === UNDEFINED_LINE);
	}

	/** ruff's captured JSON shape, carrying `F821` for the same place. */
	function ruffUndefined(file: string): Diagnostic[] {
		const [item] = JSON.parse(captured("ruff-lint", "real").stdout) as Array<
			Record<string, unknown>
		>;
		return parseRuffJson(
			JSON.stringify([
				{
					...item,
					code: "F821",
					name: "undefined-name",
					message: "Undefined name `undefined_name`",
					location: { row: UNDEFINED_LINE, column: UNDEFINED_COLUMN },
					filename: file,
					fix: null,
					severity: "error",
				},
			]),
			file,
		);
	}

	function groups(): RunnerGroup[] {
		const primary = getPrimaryDispatchGroup("python", true);
		if (!primary) throw new Error("python has no primary dispatch group");
		return [
			primary,
			{ mode: "fallback", runnerIds: ["ruff-lint"], filterKinds: ["python"] },
		];
	}

	function pythonLanes(file: string) {
		return {
			lsp: undefinedOnly(convertLspDiagnostics(capture.lsp.diagnostics, file)),
			pyright: undefinedOnly(
				parsePyrightOutput(JSON.parse(capture.cli.stdout), file).map((d) => ({
					...d,
					filePath: file,
				})),
			),
			ruff: ruffUndefined(file),
		};
	}

	it("delivers the finding once when the language server, pyright and ruff all report it", async () => {
		const file = path.join(tmpDir, "app.py");
		fs.writeFileSync(file, capture.text);
		const lanes = pythonLanes(file);
		// The inputs are three tools' copies of the one finding, at one place.
		expect(lanes.lsp.map((d) => d.rule)).toEqual([
			"Pyright:reportUndefinedVariable",
		]);
		expect(lanes.pyright.map((d) => d.rule)).toEqual([
			"reportUndefinedVariable",
		]);
		expect(lanes.ruff.map((d) => d.rule)).toEqual(["F821"]);

		const result = await dispatch(file, groups(), [
			answering(lspRunner, lanes.lsp),
			answering(pyrightRunner, lanes.pyright),
			answering(ruffRunner, lanes.ruff),
		]);

		expect(result.blockers).toHaveLength(1);
		expect(result.blockers[0]?.line).toBe(UNDEFINED_LINE);
		expect(result.output.match(/undefined_name/g) ?? []).toHaveLength(1);
	});

	it("keeps ruff's copy when it is the only tool that reports the name", async () => {
		// The dedupe never drops a finding that only one tool catches.
		const file = path.join(tmpDir, "app.py");
		fs.writeFileSync(file, capture.text);
		const result = await dispatch(file, groups(), [
			absent(lspRunner),
			absent(pyrightRunner),
			answering(ruffRunner, ruffUndefined(file)),
		]);
		expect(result.blockers.map((d) => d.rule)).toEqual(["F821"]);
	});

	it("keeps two findings apart when only one of them is in a class", async () => {
		// Fail closed to "distinct": pyright's other findings at the same place
		// are other findings, never folded into the undefined name.
		const file = path.join(tmpDir, "app.py");
		fs.writeFileSync(file, capture.text);
		const lanes = pythonLanes(file);
		const other: Diagnostic = {
			...lanes.pyright[0],
			id: "pyright-reportOptionalMemberAccess",
			rule: "reportOptionalMemberAccess",
			message: "member access on an optional value",
		};
		const result = await dispatch(file, groups(), [
			absent(lspRunner),
			answering(pyrightRunner, [lanes.pyright[0], other]),
			answering(ruffRunner, lanes.ruff),
		]);
		// The undefined name is one blocker (the higher-priority tool's copy
		// stands: `dedupPriority`), and the other rule at its place is a second.
		expect(result.blockers.map((d) => d.rule).sort()).toEqual([
			"F821",
			"reportOptionalMemberAccess",
		]);
	});
});

describe("#5416: the lintLike profile is read from the emitted tool id", () => {
	it("ruff's copy of a finding the language server also reports is suppressed", async () => {
		// Recurrence: the profile was keyed `ruff-lint` (the runner id) while the
		// runner emits `ruff`, so `suppressLintOverlapsWithLsp` never saw a ruff
		// copy as a lint tool and listed the finding twice.
		const file = path.join(tmpDir, "app.py");
		fs.writeFileSync(file, "x = 1\nif x == None:\n    pass\n");
		const ruff = parseRuffJson(
			JSON.stringify([
				{
					code: "E711",
					message: "Comparison to `None` should be `cond is None`",
					filename: file,
					location: { row: 2, column: 6 },
				},
			]),
			file,
		);
		const lsp = convertLspDiagnostics(
			[
				{
					range: {
						start: { line: 1, character: 5 },
						end: { line: 1, character: 9 },
					},
					message: "Comparison to None should use is",
					severity: 2,
					code: "reportOptionalOperand",
					source: "Pyright",
				},
			],
			file,
		);
		expect(ruff.map((d) => [d.tool, d.semantic])).toEqual([
			["ruff", "warning"],
		]);

		const primary = getPrimaryDispatchGroup("python", true);
		if (!primary) throw new Error("python has no primary dispatch group");
		const result = await dispatch(
			file,
			[
				primary,
				{ mode: "fallback", runnerIds: ["ruff-lint"], filterKinds: ["python"] },
			],
			[
				answering(lspRunner, lsp),
				absent(pyrightRunner),
				answering(ruffRunner, ruff),
			],
		);

		expect(result.diagnostics.map((d) => d.tool)).toEqual(["lsp"]);
	});

	it("reads ruff and biome by the tool id their runners emit, not by runner id", () => {
		// The profile is read with `Diagnostic.tool`, so a runner id that is not
		// also an emitted tool id is a dead key. `ruff-lint` and `biome-check-json`
		// were: the runners emit `ruff` and `biome`.
		for (const dead of ["ruff-lint", "biome-check-json"]) {
			expect(getToolProfile(dead).lintLike, dead).toBe(false);
		}
		for (const emitted of ["ruff", "biome", "oxlint", "eslint"]) {
			expect(getToolProfile(emitted).lintLike, emitted).toBe(true);
		}
	});
});

describe("#5416: the class table", () => {
	const at = {
		filePath: "/p/a.py",
		line: 3,
		column: 5,
	} as const;

	it.each([
		["eslint", "no-unused-vars", "unused-variable"],
		["eslint", "@typescript-eslint/no-unused-vars", "unused-variable"],
		["oxlint", "no-unused-vars", "unused-variable"],
		["biome", "lint/correctness/noUnusedVariables", "unused-variable"],
		["ruff", "F841", "unused-variable"],
		["pyright", "reportUnusedVariable", "unused-variable"],
		["biome", "lint/correctness/noUnusedImports", "unused-import"],
		["ruff", "F401", "unused-import"],
		["pyright", "reportUnusedImport", "unused-import"],
		["eslint", "no-undef", "undefined-name"],
		["oxlint", "no-undef", "undefined-name"],
		["biome", "lint/correctness/noUndeclaredVariables", "undefined-name"],
		["ruff", "F821", "undefined-name"],
		["pyright", "reportUndefinedVariable", "undefined-name"],
		["mypy", "name-defined", "undefined-name"],
		["lsp", "Pyright:reportUndefinedVariable", "undefined-name"],
		["lsp", "basedpyright:reportUndefinedVariable", "undefined-name"],
	] as const)("%s %s is %s", (tool, rule, cls) => {
		expect(findingClassOf({ tool, rule })).toBe(cls);
	});

	it("keeps a language server that is not Pyright out of the undefined-name class", () => {
		// Recurrence: stripping every `<source>:` merged another analyzer's
		// same-named code into Pyright's finding (#4629's closed prefix list).
		expect(
			findingClassOf({
				tool: "lsp",
				rule: "other-server:reportUndefinedVariable",
			}),
		).toBeUndefined();
		expect(
			findingClassOf({
				tool: "lsp",
				rule: "basedpyright:reportUndefinedVariable",
			}),
		).toBe("undefined-name");
	});

	it.each([
		// Another analyzer's same-named rule is another finding (#4629's rule).
		["ast-grep", "no-unused-vars"],
		["custom-lint", "F821"],
		["lsp", "typescript:6133"],
		["lsp", "other-server:reportUndefinedVariable"],
		["lsp", "reportUndefinedVariable"],
		// A listed rule under the wrong tool.
		["ruff", "no-unused-vars"],
		["eslint", "F841"],
		// Prototype keys are not rules.
		["ruff", "constructor"],
		["constructor", "F821"],
		// Rule-less.
		["ruff", undefined],
		["ruff", ""],
	] as const)("%s %s is no class member", (tool, rule) => {
		expect(findingClassOf({ tool, rule })).toBeUndefined();
	});

	it("gives two tools' copies at one place one key, and a place or class apart a different one", () => {
		const ruff = { ...at, tool: "ruff", rule: "F821" };
		const pyright = { ...at, tool: "pyright", rule: "reportUndefinedVariable" };
		expect(findingClassKey(ruff)).toBe(findingClassKey(pyright));
		expect(findingClassKey({ ...ruff, column: 6 })).not.toBe(
			findingClassKey(ruff),
		);
		expect(findingClassKey({ ...ruff, line: 4 })).not.toBe(
			findingClassKey(ruff),
		);
		expect(findingClassKey({ ...ruff, filePath: "/p/b.py" })).not.toBe(
			findingClassKey(ruff),
		);
		expect(findingClassKey({ ...ruff, rule: "F841" })).not.toBe(
			findingClassKey(ruff),
		);
		expect(
			findingClassKey({ ...at, tool: "ruff", rule: "E711" }),
		).toBeUndefined();
	});

	const member = (over: Partial<Diagnostic>): Diagnostic => ({
		id: "x",
		message: "m",
		filePath: "/p/a.py",
		line: 1,
		column: 1,
		severity: "warning",
		semantic: "warning",
		tool: "oxlint",
		rule: "no-unused-vars",
		...over,
	});

	it.each([
		["warning", "warning"],
		["hint", "none"],
		["info", "warning"],
	] as const)(
		"raises a %s-tier member (%s) to a blocker",
		(severity, semantic) => {
			expect(withClassSeverity(member({ severity, semantic }))).toMatchObject({
				severity: "error",
				semantic: "blocking",
			});
		},
	);

	it("leaves a blocker, a runner fault, a fixed or silent tier and a non-member as they are", () => {
		const blocker = member({ severity: "error", semantic: "blocking" });
		expect(withClassSeverity(blocker)).toBe(blocker);
		const fault = member({ runnerFault: true });
		expect(withClassSeverity(fault)).toBe(fault);
		for (const semantic of ["fixed", "silent"] as const) {
			const other = member({ semantic });
			expect(withClassSeverity(other)).toBe(other);
		}
		const outside = member({ rule: "no-console" });
		expect(withClassSeverity(outside)).toBe(outside);
	});
});
