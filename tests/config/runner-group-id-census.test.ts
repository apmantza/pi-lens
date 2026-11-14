import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SgNode } from "@ast-grep/napi";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { RunnerRegistry } from "../../clients/dispatch/dispatcher.js";
import { registerDefaultRunners } from "../../clients/dispatch/runners/index.js";
import { censusSourceFiles, parseRoot } from "../support/ast-census.js";
import {
	assertNonEmptyScan,
	auditRegistry,
	readWalkedFiles,
	relativePosix,
	stableOccurrenceKey,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const registry = new RunnerRegistry();
registerDefaultRunners(registry);

// Runtime-derived values are audited per occurrence, never skipped by shape.
const DYNAMIC_SITES: Record<string, string> = {
	"clients/deferred-runner-blockers.ts#absorbSettledRunnerBlockers:e342c2bb":
		"telemetry copies runner identities from settled results; it does not construct a dispatch group",
	"clients/dispatch/adopted-root-runners.ts#filterGroupsForAdoptedRoot:030a55e6":
		"filters the input group's existing runner ids through the adopted-root policy; introduces no ids",
	"clients/dispatch/dispatcher.ts#dispatchForFile:74a0e36b":
		"result metadata copies the set of inconclusive runners; it does not construct a dispatch group",
	"clients/dispatch/integration.ts#withPrimaryPolicyGroup:b9413ec9":
		"filters lsp from the input group's existing runner ids; introduces no ids",
	"clients/dispatch/integration.ts#prepareSeedLaneRun:97a13cae":
		"filters existing plan ids to eligible inline linters for the seed lanes (the pre-edit capture and the staged-delta read); introduces no ids",
	"clients/dispatch/types.ts#checkedVerdict:0547fba4":
		"a verdict's list of the runners that completed, copied from the result rows; it is not a dispatch group and introduces no ids",
	"clients/language-policy.ts#getPrimaryDispatchGroup:17282e2d":
		"copies or filters the censused PRIMARY_DISPATCH_GROUPS literals; introduces no ids",
};

type Problem = { key: string; detail: string };

function propertyName(pair: SgNode): unknown {
	const raw = pair.field("key") ?? pair;
	const key =
		raw?.kind() === "computed_property_name"
			? raw.children().find((node) => node.isNamed())
			: raw;
	return key?.kind() === "string"
		? JSON5.parse<unknown>(key.text())
		: key?.text();
}

/** #4312: literal references must resolve against registrations, not declarations. */
function census(
	source: string,
	file = "fixture.ts",
): { ids: string[]; problems: Problem[] } {
	const ids: string[] = [];
	const problems: Problem[] = [];
	const lines = source.split("\n");
	const report = (node: SgNode, message: string) => {
		const line = node.range().start.line;
		problems.push({
			key: stableOccurrenceKey(file, lines, line),
			detail: `${file}:${line + 1}: ${message}`,
		});
	};
	for (const pair of parseRoot(source).findAll({
		rule: {
			any: [{ kind: "pair" }, { kind: "shorthand_property_identifier" }],
		},
	})) {
		if (propertyName(pair) !== "runnerIds") continue;
		const value = pair.field("value");
		if (value?.kind() !== "array") {
			report(pair, `unclassified runner ids ${pair.text()}`);
			continue;
		}
		const elements = value.children().filter((node) => node.isNamed());
		for (const element of elements) {
			if (element.kind() === "comment") continue;
			if (element.kind() !== "string") {
				report(element, `unclassified runner id ${element.text()}`);
				continue;
			}
			const id = JSON5.parse<string>(element.text());
			ids.push(id);
			if (!registry.get(id)) report(element, `unregistered runner id ${id}`);
		}
	}
	return { ids, problems };
}

describe("RunnerGroup literal id census (#4312)", () => {
	it(
		"resolves every literal runnerIds member against the runner registry",
		() => {
			const files = censusSourceFiles(
				["clients", "tools", "mcp", "scripts", "index.ts"].map((dir) =>
					path.join(ROOT, dir),
				),
				{ extensions: [".ts", ".mjs", ".js", ".cjs"], skipTests: true },
			);
			assertNonEmptyScan("production sources", files.length, 600);
			assertNonEmptyScan("registered runners", registry.list().length, 40);
			const problems: Problem[] = [];
			let references = 0;
			for (const { file, source } of readWalkedFiles(files)) {
				const result = census(source, relativePosix(ROOT, file));
				references += result.ids.length;
				problems.push(...result.problems);
			}
			assertNonEmptyScan("literal runner id references", references, 100);
			expect(
				auditRegistry({
					sweepName: "runner-group-id-census",
					flagged: problems,
					registered: [],
					exemptions: DYNAMIC_SITES,
				}).problems,
			).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("checks quoted and computed literal keys without counting prose", () => {
		const result = census(`
			// runnerIds: ["comment-only"]
			const prose = 'runnerIds: ["string-only"]';
			const metadata = { runnerIds: [] };
			const groups = [{ runnerIds: ["lsp" /* registered */] },
				{ "runnerIds": ["not-registered"] },
				{ ["runnerIds"]: ['also-not-registered'] },
				{ ["runner\\u0049ds"]: ['escaped-not-registered'] }];
		`);
		expect(result.ids).toEqual([
			"lsp",
			"not-registered",
			"also-not-registered",
			"escaped-not-registered",
		]);
		expect(result.problems).toHaveLength(3);
		expect(
			result.problems.every((problem) =>
				problem.detail.includes("unregistered"),
			),
		).toBe(true);
	});

	it.each([
		'const ids = ["missing"]; const group = { mode: "all", runnerIds: ids };',
		'const getIds = () => ["missing"]; const group = { mode: "all", runnerIds: getIds() };',
		'const holder = { ids: ["missing"] }; const group = { mode: "all", runnerIds: holder.ids };',
		'const runnerIds = ["missing"]; const group = { mode: "all", runnerIds };',
		'const ids = ["missing"]; const group = { runnerIds: ids };',
		'const ids = ["missing"]; const group = { runnerIds: [...ids] };',
		'const group = { mode: "all", runnerIds: (["missing"]) };',
		'const group = { mode: "all", runnerIds: ["missing"] as string[] };',
		'const group = { mode: "all", runnerIds: ["missing"] satisfies string[] };',
		'const group = { mode: "all", runnerIds: <string[]>["missing"] };',
		'const group = { mode: "all", runnerIds: ["missing"]! };',
	])("refuses an unclassified runnerIds value: %s", (source) => {
		// #4312 review: whole values bypassed the array-element classifier.
		const { problems } = census(source);
		expect(problems).toHaveLength(1);
		expect(problems[0]?.detail).toContain("unclassified runner id");
	});

	it.each([
		'const alias = "missing"; const group = { mode: "all", runnerIds: [alias] };',
		'const getId = () => "missing"; const group = { "mode": "all", runnerIds: [getId()] };',
		'const ids = ["missing"]; const group = { ["mode"]: "all", runnerIds: [...ids] };',
	])(
		"refuses a nonliteral member instead of silently skipping it: %s",
		(source) => {
			// Shape 69: alias, indirect call, and a value through another binding.
			expect(census(source).problems).toEqual([
				expect.objectContaining({
					detail: expect.stringContaining("unclassified runner id"),
				}),
			]);
		},
	);
});
