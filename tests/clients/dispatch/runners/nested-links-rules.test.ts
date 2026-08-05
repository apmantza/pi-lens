/** Regression coverage for #1077: nested anchors report one outermost match. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import astGrepNapiRunner from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import {
	dispatchLintDetailed,
	dispatchLintWithResult,
} from "../../../../clients/dispatch/integration.js";
import treeSitterRunner from "../../../../clients/dispatch/runners/tree-sitter.js";
import {
	assertGrammarAvailable,
	makeRealRunnerEnv,
	napiFallbackHasTool,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

const { recordEntitySnapshotDiffMock } = vi.hoisted(() => ({
	recordEntitySnapshotDiffMock: vi.fn(() => ({
		added: [] as string[],
		removed: [] as string[],
		modified: [] as string[],
	})),
}));

vi.mock(
	"../../../../clients/review-graph/service.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/review-graph/service.js")
		>()),
		recordEntitySnapshotDiff: recordEntitySnapshotDiffMock,
	}),
);

const NESTED_LINKS = [
	"const view = (",
	"  <a href=\"/outer\">",
	"    <span>",
	"      <a href=\"/middle\">",
	"        <em><a href=\"/inner\">deep</a></em>",
	"      </a>",
	"    </span>",
	"  </a>",
	");",
].join("\n");

const OUTERMOST_START = { line: 2, column: 3 };
const SAME_LINE_CHAIN =
	'const sameLine = <a href="/outer"><span><a href="/middle"><em><a href="/inner">deep</a></em></a></span></a>;';
const TWO_SAME_LINE_CHAINS =
	'const chains = <a href="/one"><span><a href="/two"><em><a href="/three">one</a></em></a></span></a><a href="/four"><span><a href="/five"><em><a href="/six">two</a></em></a></span></a>;';
const SAFE_LINKS = [
	"const single = <div><a href=\"/single\">single</a></div>;",
	"const siblings = <div><a href=\"/first\">first</a><a href=\"/second\">second</a></div>;",
].join("\n");

let env: RealRunnerEnv;
beforeAll(async () => {
	env = makeRealRunnerEnv();
	await assertGrammarAvailable("tsx");
});
afterAll(() => env?.cleanup());

describe("no-nested-links real dispatch parity (#1077)", () => {
	it("production dispatch deduplicates NAPI fallback and Tree-Sitter to one blocker", async () => {
		const { filePath } = env.addFile("dispatch-nested-links.tsx", NESTED_LINKS);
		const { result, runners } = await dispatchLintDetailed(
			filePath,
			env.cwd,
			{
				getFlag: (flag) => flag === "no-lsp" || flag === "no-ast-grep",
			},
			{ blockingOnly: false },
		);
		const nestedDiagnostics = result.diagnostics.filter(
			(diagnostic) => diagnostic.rule === "no-nested-links",
		);

		expect(runners.map(({ runnerId }) => runnerId)).toEqual(
			expect.arrayContaining(["ast-grep-napi", "tree-sitter"]),
		);
		expect(
			runners.find(({ runnerId }) => runnerId === "ast-grep-napi")?.result
				.diagnostics.filter((diagnostic) => diagnostic.rule === "no-nested-links"),
		).toHaveLength(1);
		expect(
			runners.find(({ runnerId }) => runnerId === "tree-sitter")?.result
				.diagnostics.filter((diagnostic) => diagnostic.rule === "no-nested-links"),
		).toHaveLength(1);
		expect(nestedDiagnostics).toHaveLength(1);
		expect(result.blockers).toHaveLength(1);
		expect(result.hasBlockers).toBe(true);

		const withResultFile = env.addFile(
			"dispatch-nested-links-with-result.tsx",
			NESTED_LINKS,
		);
		const withResult = await dispatchLintWithResult(
			withResultFile.filePath,
			env.cwd,
			{
				getFlag: (flag) => flag === "no-lsp" || flag === "no-ast-grep",
			},
			undefined,
			undefined,
			{ blockingOnly: false },
		);
		expect(
			withResult.diagnostics.filter(
				(diagnostic) => diagnostic.rule === "no-nested-links",
			),
		).toHaveLength(1);
		expect(withResult.blockers).toHaveLength(1);
		expect(nestedDiagnostics[0]).toMatchObject({
			line: OUTERMOST_START.line,
			column: OUTERMOST_START.column,
			severity: "error",
			semantic: "blocking",
		});
	}, 60_000);

	it("keeps same-line wrappers and independent same-line chains distinct", async () => {
		const sameLine = env.addFile("same-line-nested-links.tsx", SAME_LINE_CHAIN);
		const twoChains = env.addFile(
			"two-same-line-nested-links.tsx",
			TWO_SAME_LINE_CHAINS,
		);
		const pi = {
			getFlag: (flag: string) => flag === "no-lsp" || flag === "no-ast-grep",
		};

		const sameLineResult = await dispatchLintDetailed(
			sameLine.filePath,
			env.cwd,
			pi,
			{ blockingOnly: false },
		);
		const sameLineDiagnostics = sameLineResult.result.diagnostics.filter(
			(diagnostic) => diagnostic.rule === "no-nested-links",
		);
		expect(sameLineDiagnostics).toHaveLength(1);
		expect(sameLineResult.result.blockers).toHaveLength(1);

		const twoChainsResult = await dispatchLintDetailed(
			twoChains.filePath,
			env.cwd,
			pi,
			{ blockingOnly: false },
		);
		const twoChainDiagnostics = twoChainsResult.result.diagnostics.filter(
			(diagnostic) => diagnostic.rule === "no-nested-links",
		);
		expect(twoChainDiagnostics).toHaveLength(2);
		expect(twoChainsResult.result.blockers).toHaveLength(2);
		expect(twoChainDiagnostics.map((diagnostic) => diagnostic.column)).toEqual([
			16, 122,
		]);
	}, 60_000);

	it("NAPI reports exactly the outermost three-level anchor chain", async () => {
		const { ctx } = env.addFile("nested-links.tsx", NESTED_LINKS, {
			hasTool: napiFallbackHasTool,
			pi: { getFlag: (flag) => (flag === "no-ast-grep" ? true : undefined) },
		});
		const result = await astGrepNapiRunner.run(ctx);
		const diagnostics = result.diagnostics.filter(
			(diagnostic) => diagnostic.rule === "no-nested-links",
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			line: OUTERMOST_START.line,
			column: OUTERMOST_START.column,
			severity: "error",
			semantic: "blocking",
		});
	});

	it("NAPI allows wrappers and sibling anchors", async () => {
		const { ctx } = env.addFile("safe-links.tsx", SAFE_LINKS, {
			hasTool: napiFallbackHasTool,
			pi: { getFlag: (flag) => (flag === "no-ast-grep" ? true : undefined) },
		});
		const result = await astGrepNapiRunner.run(ctx);
		expect(
			result.diagnostics.filter(
				(diagnostic) => diagnostic.rule === "no-nested-links",
			),
		).toHaveLength(0);
	});

	it("Tree-Sitter allows wrappers and sibling anchors", async () => {
		const { ctx } = env.addFile("safe-links-tree-sitter.tsx", SAFE_LINKS);
		const result = await treeSitterRunner.run(ctx);
		expect(
			result.diagnostics.filter(
				(diagnostic) => diagnostic.rule === "no-nested-links",
			),
		).toHaveLength(0);
	});

	it("Tree-Sitter reports the same outermost range through wrappers", async () => {
		const { ctx } = env.addFile("nested-links-tree-sitter.tsx", NESTED_LINKS);
		const result = await treeSitterRunner.run(ctx);
		const diagnostics = result.diagnostics.filter(
			(diagnostic) => diagnostic.rule === "no-nested-links",
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			line: OUTERMOST_START.line,
			column: OUTERMOST_START.column,
			severity: "error",
			semantic: "blocking",
			matchedText: NESTED_LINKS.slice(
				NESTED_LINKS.indexOf("<a"),
				NESTED_LINKS.lastIndexOf("  </a>") + "  </a>".length,
			),
		});
	});
});
