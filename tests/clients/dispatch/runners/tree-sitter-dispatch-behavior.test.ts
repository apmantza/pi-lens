/**
 * #448 — the runner's dispatch filters through the REAL engine: blockingOnly's
 * review-tier drop and the modifiedRanges gate. The mocked twin
 * (tree-sitter-runner.test.ts) stubs the query loader empty, so none of this
 * is reachable there. Fixture rules: debugger-statement (severity error,
 * inline_tier blocking) and variable-shadowing (inline_tier review).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	RunnerRegistry,
	dispatchForFile,
} from "../../../../clients/dispatch/dispatcher.js";
import treeSitterRunner from "../../../../clients/dispatch/runners/tree-sitter.js";
import {
	queriesForLanguage,
	queryLoader,
} from "../../../../clients/tree-sitter-query-loader.js";
import { getSharedTreeSitterClient } from "../../../../clients/tree-sitter-shared.js";

// Keep unrelated fire-and-forget review-graph enrichment out of real-runner
// tests. Tracked as a vi.fn so the #885 suite can assert WHEN the runner
// snapshots entities — never under the <5-line skip threshold.
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
import {
	assertGrammarAvailable,
	firedRuleIds,
	makeRealRunnerEnv,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";
let env: RealRunnerEnv;
beforeAll(async () => {
	env = makeRealRunnerEnv();
	await assertGrammarAvailable("typescript");
});
afterAll(() => env?.cleanup());

// Matches variable-shadowing and puts debugger statements on lines 3 and 8.
const MIXED_SRC = [
	"function process(data) {",
	"\tconst data = 1;",
	"\tdebugger;",
	"\treturn data;",
	"}",
	"",
	"function other() {",
	"\tdebugger;",
	"}",
	"",
].join("\n");

describe("tree-sitter runner — dispatch filtering (#448)", () => {
	// The positive review-tier assertion keeps both negative filters below from
	// passing vacuously if the real query fails to compile.
	it("runs review-tier rules and ignores modifiedRanges outside blockingOnly", async () => {
		const { ctx } = env.addFile("all-diagnostics.ts", MIXED_SRC, {
			modifiedRanges: [{ start: 1, end: 4 }],
		});
		const result = await treeSitterRunner.run(ctx);
		const fired = firedRuleIds(result);
		const debuggerLines = result.diagnostics
			.filter((d) => d.rule === "debugger-statement")
			.map((d) => d.line);
		expect(fired).toContain("variable-shadowing");
		expect(debuggerLines).toEqual([3, 8]);
	}, 30_000);

	it("filters review-tier rules and gates blocking diagnostics to modifiedRanges", async () => {
		const { ctx } = env.addFile("blocking-only.ts", MIXED_SRC, {
			blockingOnly: true,
			modifiedRanges: [{ start: 1, end: 4 }],
		});
		const result = await treeSitterRunner.run(ctx);
		const fired = firedRuleIds(result);
		const debuggerLines = result.diagnostics
			.filter((d) => d.rule === "debugger-statement")
			.map((d) => d.line);
		expect(fired).not.toContain("variable-shadowing");
		expect(debuggerLines).toEqual([3]);
	}, 30_000);

	it("applies inline suppression to a diagnostic produced by the real rule", async () => {
		const content = [
			"function suppressed() {",
			"\t// pi-lens-ignore: debugger-statement",
			"\tdebugger;",
			"}",
			"function visible() {",
			"\tdebugger;",
			"}",
			"",
		].join("\n");
		const { ctx, filePath } = env.addFile("suppression.ts", content, {
			deltaMode: false,
		});
		ctx.facts.setFileFact(filePath, "file.content", content);
		const registry = new RunnerRegistry();
		registry.register(treeSitterRunner);

		const result = await dispatchForFile(
			ctx,
			[{ mode: "all", runnerIds: [treeSitterRunner.id] }],
			registry,
		);
		const debuggerLines = result.diagnostics
			.filter((diagnostic) => diagnostic.rule === "debugger-statement")
			.map((diagnostic) => diagnostic.line);

		expect(debuggerLines).toEqual([6]);
	}, 30_000);
});

describe("tree-sitter runner — entity extraction skip threshold (#885)", () => {
	it("skips entity extraction for edits under the 5-line threshold", async () => {
		recordEntitySnapshotDiffMock.mockClear();
		const { ctx } = env.addFile("small-edit.ts", MIXED_SRC, {
			modifiedRanges: [{ start: 3, end: 3 }], // one changed line
		});
		const result = await treeSitterRunner.run(ctx);
		// Sanity: rules ran and fired — the skip below is the threshold, not a
		// vacuous no-op dispatch.
		expect(result.diagnostics.length).toBeGreaterThan(0);
		expect(recordEntitySnapshotDiffMock).not.toHaveBeenCalled();
	}, 30_000);

	it("runs entity extraction when modifiedRanges is absent (full-file dispatch)", async () => {
		recordEntitySnapshotDiffMock.mockClear();
		// No modifiedRanges override — e.g. clients/mcp/analyze.ts passes
		// undefined for full-file analysis. Absent ranges mean "whole file"
		// (matching isLineInModifiedRanges), never "trivial edit", so the
		// <5-line skip must NOT suppress the snapshot.
		const { ctx } = env.addFile("full-file-dispatch.ts", MIXED_SRC, {
			modifiedRanges: undefined,
		});
		const result = await treeSitterRunner.run(ctx);
		expect(result.diagnostics.length).toBeGreaterThan(0);
		expect(recordEntitySnapshotDiffMock).toHaveBeenCalledTimes(1);
	}, 30_000);

	it("runs entity extraction exactly once for edits at the threshold", async () => {
		recordEntitySnapshotDiffMock.mockClear();
		const { ctx } = env.addFile("threshold-edit.ts", MIXED_SRC, {
			modifiedRanges: [{ start: 1, end: 5 }], // five changed lines
		});
		const result = await treeSitterRunner.run(ctx);
		expect(result.diagnostics.length).toBeGreaterThan(0);
		expect(recordEntitySnapshotDiffMock).toHaveBeenCalledTimes(1);
	}, 30_000);

	it("snapshots the unsaved buffer content, not stale disk", async () => {
		const client = getSharedTreeSitterClient()!;
		const spy = vi.spyOn(client, "runQueryOnFile");
		try {
			const buffer = `${MIXED_SRC}\nfunction unsavedEntity() {}\n`;
			const { ctx, filePath } = env.addFile("unsaved-buffer.ts", MIXED_SRC, {
				modifiedRanges: [{ start: 1, end: 6 }], // over threshold
			});
			ctx.facts.setFileFact(filePath, "file.content", buffer);
			await treeSitterRunner.run(ctx);
			// Rule queries go through runQueriesOnFile (#888); the only per-rule
			// walks left are the entity snapshot's — and they must parse the
			// buffer, not the on-disk copy missing unsavedEntity.
			const entityCalls = spy.mock.calls.filter(([queryDef]) =>
				queryDef.id.startsWith("entity-"),
			);
			expect(entityCalls.length).toBeGreaterThan(0);
			for (const args of entityCalls) {
				expect(args[4]).toBe(buffer);
			}
		} finally {
			spy.mockRestore();
		}
	}, 30_000);
});

describe("tree-sitter runner — batched per-edit queries (#888)", () => {
	it("walks the tree once via runQueriesOnFile, never per-rule", async () => {
		const client = getSharedTreeSitterClient()!;
		const batchSpy = vi.spyOn(client, "runQueriesOnFile");
		const perRuleSpy = vi.spyOn(client, "runQueryOnFile");
		try {
			const { ctx } = env.addFile("single-walk.ts", MIXED_SRC, {
				// Small edit: entity extraction is skipped, so ANY per-rule walk
				// would be a regression to the pre-#888 loop.
				modifiedRanges: [{ start: 1, end: 2 }],
			});
			const result = await treeSitterRunner.run(ctx);
			expect(result.diagnostics.length).toBeGreaterThan(0);
			expect(batchSpy).toHaveBeenCalledTimes(1);
			expect(batchSpy.mock.calls[0][0].length).toBeGreaterThan(0);
			expect(perRuleSpy).not.toHaveBeenCalled();
		} finally {
			batchSpy.mockRestore();
			perRuleSpy.mockRestore();
		}
	}, 30_000);

	it("matches the legacy per-rule path rule-for-rule and line-for-line", async () => {
		const { ctx, filePath } = env.addFile("batch-equivalence.ts", MIXED_SRC, {
			modifiedRanges: [{ start: 1, end: 9 }],
		});
		const result = await treeSitterRunner.run(ctx);
		expect(result.diagnostics.length).toBeGreaterThan(0);

		// Oracle: the pre-#888 path — one runQueryOnFile walk per rule with the
		// same per-rule maxResults(10) cap, no blockingOnly gating.
		const client = getSharedTreeSitterClient()!;
		await queryLoader.loadQueries(env.cwd);
		const rules = queriesForLanguage(
			new Map([
				["typescript", queryLoader.getQueriesForLanguage("typescript")],
			]),
			"typescript",
		);
		expect(rules.length).toBeGreaterThan(0);
		const legacy = new Set<string>();
		for (const rule of rules) {
			const matches = await client.runQueryOnFile(
				rule,
				filePath,
				"typescript",
				{ maxResults: 10 },
			);
			for (const match of matches) {
				legacy.add(`${rule.id}:${match.line}:${match.column}`);
			}
		}

		const batched = new Set(
			result.diagnostics.map((d) => `${d.rule}:${d.line}:${d.column}`),
		);
		expect(batched).toEqual(legacy);
	}, 60_000);
});
