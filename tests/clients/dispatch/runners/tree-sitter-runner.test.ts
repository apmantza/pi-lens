import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";

function createCtx(filePath: string, cwdOverride?: string) {
	return {
		filePath,
		cwd: cwdOverride ?? path.dirname(filePath),
		kind: "jsts",
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: true,
		blockingOnly: false,
		modifiedRanges: undefined,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

async function loadRunnerWithClient(isAvailable: boolean, initResult: boolean) {
	vi.resetModules();

	vi.doMock("../../../../clients/tree-sitter-logger.js", () => ({
		logTreeSitter: vi.fn(),
	}));
	vi.doMock("../../../../clients/review-graph/service.js", () => ({
		buildOrUpdateGraph: vi.fn().mockResolvedValue({}),
		computeImpactCascade: vi.fn().mockReturnValue({
			changedSymbols: [],
			neighborFiles: [],
			directImporters: [],
			directCallers: [],
			riskFlags: [],
		}),
		recordEntitySnapshotDiff: vi.fn(),
	}));
	vi.doMock("../../../../clients/tree-sitter-query-loader.js", () => ({
		queryLoader: { loadQueries: vi.fn().mockResolvedValue([]), getAllQueries: vi.fn().mockReturnValue([]) },
	}));
	vi.doMock("../../../../clients/cache/rule-cache.js", () => ({
		RuleCache: function () { return { get: () => null, set: () => {} }; },
	}));
	vi.doMock("../../../../clients/tree-sitter-client.js", () => {
		function MockTreeSitterClient() {
			return {
				isAvailable: () => isAvailable,
				init: () => Promise.resolve(initResult),
				parseFile: () => Promise.resolve(null),
				query: () => [],
			};
		}
		return { TreeSitterClient: MockTreeSitterClient };
	});

	const mod = await import("../../../../clients/dispatch/runners/tree-sitter.js");
	return mod.default;
}

describe("tree-sitter runner — metadata", () => {
	beforeEach(() => vi.resetModules());

	it("has expected id and appliesTo languages", async () => {
		vi.doMock("../../../../clients/tree-sitter-client.js", () => ({
			TreeSitterClient: function () {
				return { isAvailable: () => false, init: () => Promise.resolve(false), parseFile: () => Promise.resolve(null), query: () => [] };
			},
		}));
		vi.doMock("../../../../clients/tree-sitter-logger.js", () => ({ logTreeSitter: vi.fn() }));
		vi.doMock("../../../../clients/review-graph/service.js", () => ({ buildOrUpdateGraph: vi.fn(), computeImpactCascade: vi.fn(), recordEntitySnapshotDiff: vi.fn() }));
		vi.doMock("../../../../clients/tree-sitter-query-loader.js", () => ({ queryLoader: { loadQueries: vi.fn().mockResolvedValue([]), getAllQueries: vi.fn().mockReturnValue([]) } }));
		vi.doMock("../../../../clients/cache/rule-cache.js", () => ({ RuleCache: function () { return { get: () => null, set: () => {} }; } }));

		const mod = await import("../../../../clients/dispatch/runners/tree-sitter.js");
		const runner = mod.default;
		expect(runner.id).toBe("tree-sitter");
		expect(runner.appliesTo).toContain("jsts");
		expect(runner.appliesTo).toContain("python");
		expect(runner.appliesTo).toContain("go");
		expect(runner.appliesTo).toContain("rust");
		expect(runner.appliesTo).toContain("ruby");
		expect(runner.enabledByDefault).toBe(true);
	});
});

describe("tree-sitter runner — skip paths", () => {
	it("skips when client is not available", async () => {
		const runner = await loadRunnerWithClient(false, false);
		const result = await runner.run(createCtx("/fake/file.ts") as any);
		expect(result.status).toBe("skipped");
		expect(result.diagnostics).toHaveLength(0);
		expect(result.semantic).toBe("none");
	});

	it("skips when client init fails", async () => {
		const runner = await loadRunnerWithClient(true, false);
		const result = await runner.run(createCtx("/fake/file.ts") as any);
		expect(result.status).toBe("skipped");
		expect(result.diagnostics).toHaveLength(0);
	});

	it("skips unsupported file extension", async () => {
		const runner = await loadRunnerWithClient(true, true);
		const result = await runner.run(createCtx("/fake/file.java") as any);
		expect(result.status).toBe("skipped");
	});

	it("returns no diagnostics when no rules dir exists", async () => {
		const runner = await loadRunnerWithClient(true, true);
		const ctx = createCtx("/fake/file.ts", "/nonexistent/cwd");
		const result = await runner.run(ctx as any);
		expect(["skipped", "succeeded"]).toContain(result.status);
		expect(result.diagnostics).toHaveLength(0);
	});
});
