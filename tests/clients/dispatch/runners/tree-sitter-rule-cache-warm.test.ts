/**
 * #448 — rule-cache round-trip. Every other real-runner test uses a fresh temp
 * cwd, so it only ever sees a COLD cache; fields the cache.set projection drops
 * (rule-cache.ts QueryCacheEntry) silently vanish on the warm path in
 * production. Each test here runs the runner twice against the SAME cwd so run
 * 2 rehydrates from the cache written by run 1.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import treeSitterRunner from "../../../../clients/dispatch/runners/tree-sitter.js";
import {
	_resetSharedTreeSitterClientForTests,
	getSharedTreeSitterClient,
} from "../../../../clients/tree-sitter-shared.js";

const { logTreeSitter } = vi.hoisted(() => ({ logTreeSitter: vi.fn() }));
vi.mock("../../../../clients/tree-sitter-logger.js", () => ({
	logTreeSitter: (entry: unknown) => logTreeSitter(entry),
}));
// Keep unrelated fire-and-forget review-graph enrichment out of real-runner tests.
vi.mock(
	"../../../../clients/review-graph/service.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/review-graph/service.js")
		>()),
		recordEntitySnapshotDiff: () => ({ added: [], removed: [], modified: [] }),
	}),
);
import {
	assertGrammarAvailable,
	firedRuleIds,
	makeRealRunnerEnv,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

let env: RealRunnerEnv;
afterAll(() => env?.cleanup());

const ASSERT_SRC = "def f(x):\n    assert x > 0, 'x required'\n    return x\n";

// [false, true] holds because each `it` below is single-language (python-only,
// then typescript-only) — RuleCache is per-language, and its on-disk cache
// under PI_LENS_HOME/projects/<slug> survives `env.cleanup()` (which only
// removes the fixture cwd, not PI_LENS_HOME).
function observedCacheHits(): Array<boolean | undefined> {
	return logTreeSitter.mock.calls
		.map(([entry]) => entry as { phase?: string; cacheHit?: boolean })
		.filter((entry) => entry.phase === "queries_loaded")
		.map((entry) => entry.cacheHit);
}

describe("tree-sitter runner — rule cache round-trip (#448)", () => {
	beforeAll(async () => {
		env = makeRealRunnerEnv();
		await assertGrammarAvailable("python");
		await assertGrammarAvailable("typescript");
	});

	it("skip_test_files survives a cache round-trip", async () => {
		logTreeSitter.mockClear();
		// Cold run populates <data-dir>/cache/python-rules-v*.json.
		const cold = env.addFile("app.py", ASSERT_SRC);
		expect(firedRuleIds(await treeSitterRunner.run(cold.ctx))).toContain(
			"python-assert-production",
		);

		// Warm run rehydrates from the cache; the #440 carve-out must survive.
		const warm = env.addFile(
			"tests/test_app.py",
			"def test_ok():\n    assert 1 + 1 == 2\n",
		);
		expect(firedRuleIds(await treeSitterRunner.run(warm.ctx))).not.toContain(
			"python-assert-production",
		);
		expect(observedCacheHits()).toEqual([false, true]);
	}, 30_000);

	it("fix_action survives a cache round-trip", async () => {
		logTreeSitter.mockClear();
		// has_fix IS cached, so asserting on `fixable` would prove nothing; the
		// fix_action-derived suggestion is what the warm path loses.
		const suggestionFor = async (relPath: string) => {
			const { ctx } = env.addFile(relPath, "debugger;\n");
			const result = await treeSitterRunner.run(ctx);
			const d = result.diagnostics.find((x) => x.rule === "debugger-statement");
			expect(d).toBeDefined();
			return d?.fixSuggestion;
		};

		expect(await suggestionFor("a.ts")).toBe("remove this statement");
		expect(await suggestionFor("b.ts")).toBe("remove this statement");
		expect(observedCacheHits()).toEqual([false, true]);
	}, 30_000);
});

// #878 — the RuleCache key fingerprinted only the language's OWN rules
// directory, but tsx also RUNS the typescript rule set (queriesForLanguage).
// A typescript-rule edit therefore never invalidated the on-disk tsx cache:
// the next process computed the same hash over the unchanged tsx files and
// served the stale compiled rules. The fingerprint now covers the full
// effective rule set, so an inherited-rule edit must force a miss, while an
// unrelated language's rule edit must not.
describe("tree-sitter runner — inherited rule-set fingerprint (#878)", () => {
	let env878: RealRunnerEnv;
	beforeAll(async () => {
		env878 = makeRealRunnerEnv();
		await assertGrammarAvailable("tsx");
	});
	afterAll(() => env878?.cleanup());

	const tsRulePath = () =>
		path.join(
			env878.cwd,
			"rules",
			"tree-sitter-queries",
			"typescript",
			"proj-marker-ts.yml",
		);
	const pyRulePath = () =>
		path.join(
			env878.cwd,
			"rules",
			"tree-sitter-queries",
			"python",
			"proj-marker-py.yml",
		);
	const writeRule = (file: string, message: string) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			[
				"id: proj-marker",
				"name: Project Marker",
				"severity: warning",
				"category: general",
				`message: "${message}"`,
				"query: |",
				"  (debugger_statement) @DBG",
				"metavars: [DBG]",
				"",
			].join("\n"),
			"utf-8",
		);
	};

	it("an inherited typescript-rule edit invalidates the tsx cache; a python-rule edit does not", async () => {
		writeRule(tsRulePath(), "marker v1");
		writeRule(pyRulePath(), "py marker v1");
		logTreeSitter.mockClear();

		// Run 1 (cold): populates the on-disk tsx cache; the project-local
		// typescript rule fires through the inherited rule set.
		const cold = env878.addFile("a.tsx", "debugger;\n");
		expect(firedRuleIds(await treeSitterRunner.run(cold.ctx))).toContain(
			"proj-marker",
		);

		// Run 2 (warm): same rules on disk → cache hit.
		const warm = env878.addFile("b.tsx", "debugger;\n");
		await treeSitterRunner.run(warm.ctx);

		// Edit the INHERITED typescript rule. Pre-fix this left the tsx
		// fingerprint unchanged and run 3 hit the stale cache. Assert on the
		// EDITED MESSAGE, not just the rule id — the id is identical pre/post
		// edit, so a stale v1 rule set would still make a toContain("proj-marker")
		// pass; only the v2 message proves run 3 re-read the rule from disk (the
		// loader's in-memory memo used to hand back v1 on the cache miss and the
		// runner persisted it under the fresh fingerprint).
		writeRule(tsRulePath(), "marker v2 changed");
		const afterInheritedEdit = env878.addFile("c.tsx", "debugger;\n");
		const run3 = await treeSitterRunner.run(afterInheritedEdit.ctx);
		expect(firedRuleIds(run3)).toContain("proj-marker");
		const markerDiag = run3.diagnostics.find((d) => d.rule === "proj-marker");
		expect(markerDiag?.message).toContain("marker v2 changed");

		// Control: editing an UNRELATED language's rule must NOT invalidate.
		writeRule(pyRulePath(), "py marker v2 changed");
		const afterUnrelatedEdit = env878.addFile("d.tsx", "debugger;\n");
		await treeSitterRunner.run(afterUnrelatedEdit.ctx);

		expect(observedCacheHits()).toEqual([false, true, false, true]);
	}, 30_000);
});

// #5260 — the first dispatch of a project misses the rule cache and hands the
// client the loader's full rule objects; every later one hands it the cache's
// projection, which drops description, tags, category and the rest. The client
// keyed its combined batch on the whole object, so the second dispatch compiled
// the same rules again (about 430 ms of a 972 ms dispatch). Red on
// origin/master f11775b35: `compileQueryBatchOnce` ran twice.
describe("tree-sitter runner — query batch reuse across the cache round-trip (#5260)", () => {
	let env5260: RealRunnerEnv;
	beforeAll(async () => {
		env5260 = makeRealRunnerEnv();
		await assertGrammarAvailable("typescript");
	});
	afterAll(() => {
		env5260?.cleanup();
		_resetSharedTreeSitterClientForTests();
	});

	it("builds the TypeScript rule batch once for the cold, warm and third dispatch", async () => {
		logTreeSitter.mockClear();
		_resetSharedTreeSitterClientForTests();
		const client = getSharedTreeSitterClient();
		if (!client) throw new Error("tree-sitter unavailable");
		const buildBatch = vi.spyOn(
			client as unknown as {
				compileQueryBatchOnce: (...args: unknown[]) => Promise<unknown>;
			},
			"compileQueryBatchOnce",
		);

		const source = "export const answer = (a: number): number => a + 1;\n";
		await treeSitterRunner.run(env5260.addFile("first.ts", source).ctx);
		expect(buildBatch).toHaveBeenCalledTimes(1);
		await treeSitterRunner.run(env5260.addFile("second.ts", source).ctx);
		await treeSitterRunner.run(env5260.addFile("third.ts", source).ctx);
		expect(buildBatch).toHaveBeenCalledTimes(1);
		// The warm runs really were rule-cache hits, so the client saw projections.
		expect(observedCacheHits()).toEqual([false, true, true]);
	}, 30_000);
});

// #5278 review (Greptile P2 and CodeRabbit): a project rule that declares
// `predicates:` got a different batch identity on the warm dispatch. The loader
// parses the field, RuleCache does not persist it, and the identity hashed it,
// so the cold dispatch and every later one keyed apart. Recurrence guarded: a
// rule field that the cache projection drops and the identity still hashes
// splits the batch again on the second dispatch.
describe("tree-sitter runner — batch reuse for a rule that declares predicates (#5260)", () => {
	let envPredicates: RealRunnerEnv;
	beforeAll(async () => {
		envPredicates = makeRealRunnerEnv();
		await assertGrammarAvailable("typescript");
	});
	afterAll(() => {
		envPredicates?.cleanup();
		_resetSharedTreeSitterClientForTests();
	});

	it("builds the batch once for a project rule with predicates, cold, warm and third", async () => {
		logTreeSitter.mockClear();
		_resetSharedTreeSitterClientForTests();
		const client = getSharedTreeSitterClient();
		if (!client) throw new Error("tree-sitter unavailable");
		const buildBatch = vi.spyOn(
			client as unknown as {
				compileQueryBatchOnce: (...args: unknown[]) => Promise<unknown>;
			},
			"compileQueryBatchOnce",
		);
		const rule = path.join(
			envPredicates.cwd,
			"rules",
			"tree-sitter-queries",
			"typescript",
			"proj-predicates-ts.yml",
		);
		fs.mkdirSync(path.dirname(rule), { recursive: true });
		fs.writeFileSync(
			rule,
			[
				"id: proj-predicates",
				"name: Project Predicates",
				"severity: warning",
				"category: general",
				'message: "predicates rule"',
				"query: |",
				"  (debugger_statement) @DBG",
				"metavars: [DBG]",
				"predicates:",
				"  - type: eq",
				"    var: DBG",
				'    value: "debugger"',
				"",
			].join("\n"),
			"utf-8",
		);

		const source = "debugger;\n";
		const cold = await treeSitterRunner.run(
			envPredicates.addFile("cold.ts", source).ctx,
		);
		expect(firedRuleIds(cold)).toContain("proj-predicates");
		await treeSitterRunner.run(envPredicates.addFile("warm.ts", source).ctx);
		await treeSitterRunner.run(envPredicates.addFile("third.ts", source).ctx);
		expect(buildBatch).toHaveBeenCalledTimes(1);
		expect(observedCacheHits()).toEqual([false, true, true]);
	}, 30_000);
});
