/** Regression coverage for #1077: nested anchors report one outermost match. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import astGrepNapiRunner from "../../../../clients/dispatch/runners/ast-grep-napi.js";
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
