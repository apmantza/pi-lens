import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";

function createCtx(filePath: string, cwdOverride?: string) {
	return makeRunnerCtx(filePath, cwdOverride ?? path.dirname(filePath), {
		blockingOnly: false,
		modifiedRanges: undefined,
	});
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
		queryLoader: {
			loadQueries: vi.fn().mockResolvedValue([]),
			getQueriesForLanguage: vi.fn().mockReturnValue([]),
			getAllQueries: vi.fn().mockReturnValue([]),
		},
		queriesForLanguage: (queries: Map<string, unknown[]>, languageId: string) =>
			queries.get(languageId) ?? [],
		isDisabledQueryFilePath: () => false,
		ruleFilesForLanguage: () => [],
		ruleSourceLanguages: (languageId: string) => [languageId],
	}));
	vi.doMock("../../../../clients/cache/rule-cache.js", () => ({
		RuleCache: class {
			get() {
				return null;
			}
			set() {}
		},
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

	const mod =
		await import("../../../../clients/dispatch/runners/tree-sitter.js");
	return mod.default;
}

/**
 * Like loadRunnerWithClient, but with one or more queries loaded and client
 * spies for the batched (#888) and entity (#885) paths.
 */
async function loadRunnerWithQueries(queries: unknown[]) {
	vi.resetModules();

	const recordEntitySnapshotDiff = vi.fn(() => ({
		added: [] as string[],
		modified: [] as string[],
		removed: [] as string[],
	}));
	const runQueriesOnFile = vi.fn().mockResolvedValue([]);
	const runQueryOnFile = vi.fn().mockResolvedValue([]);

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
		recordEntitySnapshotDiff,
	}));
	vi.doMock("../../../../clients/tree-sitter-query-loader.js", () => ({
		queryLoader: {
			loadQueries: vi.fn().mockResolvedValue([]),
			getQueriesForLanguage: vi.fn().mockReturnValue(queries),
			getAllQueries: vi.fn().mockReturnValue(queries),
		},
		queriesForLanguage: (q: Map<string, unknown[]>, languageId: string) =>
			q.get(languageId) ?? [],
		isDisabledQueryFilePath: () => false,
		ruleFilesForLanguage: () => [],
		ruleSourceLanguages: (languageId: string) => [languageId],
	}));
	vi.doMock("../../../../clients/cache/rule-cache.js", () => ({
		RuleCache: class {
			get() {
				return null;
			}
			set() {}
		},
	}));
	vi.doMock("../../../../clients/tree-sitter-client.js", () => {
		function MockTreeSitterClient() {
			return {
				isAvailable: () => true,
				init: () => Promise.resolve(true),
				parseFile: () => Promise.resolve(null),
				query: () => [],
				runQueriesOnFile,
				runQueryOnFile,
			};
		}
		return { TreeSitterClient: MockTreeSitterClient };
	});

	const mod =
		await import("../../../../clients/dispatch/runners/tree-sitter.js");
	return {
		runner: mod.default,
		recordEntitySnapshotDiff,
		runQueriesOnFile,
		runQueryOnFile,
	};
}

describe("tree-sitter runner — metadata", () => {
	beforeEach(() => vi.resetModules());

	it("has expected id and appliesTo languages", async () => {
		vi.doMock("../../../../clients/tree-sitter-client.js", () => ({
			TreeSitterClient: () => ({
				isAvailable: () => false,
				init: () => Promise.resolve(false),
				parseFile: () => Promise.resolve(null),
				query: () => [],
			}),
		}));
		vi.doMock("../../../../clients/tree-sitter-logger.js", () => ({
			logTreeSitter: vi.fn(),
		}));
		vi.doMock("../../../../clients/review-graph/service.js", () => ({
			buildOrUpdateGraph: vi.fn(),
			computeImpactCascade: vi.fn(),
			recordEntitySnapshotDiff: vi.fn(),
		}));
		vi.doMock("../../../../clients/tree-sitter-query-loader.js", () => ({
			queryLoader: {
				loadQueries: vi.fn().mockResolvedValue([]),
				getQueriesForLanguage: vi.fn().mockReturnValue([]),
				getAllQueries: vi.fn().mockReturnValue([]),
			},
			queriesForLanguage: (
				queries: Map<string, unknown[]>,
				languageId: string,
			) => queries.get(languageId) ?? [],
			isDisabledQueryFilePath: () => false,
			ruleFilesForLanguage: () => [],
			ruleSourceLanguages: (languageId: string) => [languageId],
		}));
		vi.doMock("../../../../clients/cache/rule-cache.js", () => ({
			RuleCache: class {
				get() {
					return null;
				}
				set() {}
			},
		}));

		const mod =
			await import("../../../../clients/dispatch/runners/tree-sitter.js");
		const runner = mod.default;
		expect(runner.id).toBe("tree-sitter");
		expect(runner.appliesTo).toContain("jsts");
		expect(runner.appliesTo).toContain("python");
		expect(runner.appliesTo).toContain("go");
		expect(runner.appliesTo).toContain("rust");
		expect(runner.appliesTo).toContain("ruby");
		expect(runner.appliesTo).toContain("cxx");
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

	// `.md` has no tree-sitter grammar in the language registry. This used to
	// use `.java`, which #2424 wired to the java grammar as one of its reconciled
	// rows (the project scanner already resolved it; the shared ext->grammar map
	// did not). The runner's appliesTo never included the java kind, so nothing
	// but this direct call ever reached the skip path with a .java file.
	it("skips unsupported file extension", async () => {
		const runner = await loadRunnerWithClient(true, true);
		const result = await runner.run(createCtx("/fake/file.md") as any);
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

describe("tree-sitter runner — entity extraction skip threshold (#885)", () => {
	const fakeQuery = {
		id: "fake-rule",
		name: "fake-rule",
		severity: "warning",
		language: "typescript",
		message: "fake",
		query: "(identifier) @X",
		metavars: ["X"],
		has_fix: false,
		filePath: "rules/tree-sitter-queries/typescript/fake-rule.yml",
	};

	it("skips entity extraction for edits under 5 changed lines", async () => {
		const { runner, recordEntitySnapshotDiff, runQueryOnFile } =
			await loadRunnerWithQueries([fakeQuery]);
		const ctx = {
			...createCtx("/fake/file.ts"),
			modifiedRanges: [{ start: 10, end: 10 }], // 1 changed line
		};
		const result = await runner.run(ctx as any);
		expect(result.status).toBe("succeeded");
		expect(recordEntitySnapshotDiff).not.toHaveBeenCalled();
		// No entity queries reached the client either.
		expect(runQueryOnFile).not.toHaveBeenCalled();
	});

	it("runs entity extraction once for edits at/over 5 changed lines", async () => {
		const { runner, recordEntitySnapshotDiff, runQueryOnFile } =
			await loadRunnerWithQueries([fakeQuery]);
		const ctx = {
			...createCtx("/fake/file.ts"),
			modifiedRanges: [{ start: 10, end: 14 }], // 5 changed lines
		};
		const result = await runner.run(ctx as any);
		expect(result.status).toBe("succeeded");
		expect(recordEntitySnapshotDiff).toHaveBeenCalledTimes(1);
		// Only entity queries use the per-rule client path now.
		expect(runQueryOnFile.mock.calls.length).toBeGreaterThan(0);
		for (const args of runQueryOnFile.mock.calls) {
			expect(args[0].id).toMatch(/^entity-/);
		}
	});
});

describe("tree-sitter runner — batched per-edit queries (#888)", () => {
	const fakeQuery = {
		id: "fake-rule",
		name: "fake-rule",
		severity: "warning",
		language: "typescript",
		message: "fake",
		query: "(identifier) @X",
		metavars: ["X"],
		has_fix: false,
		filePath: "rules/tree-sitter-queries/typescript/fake-rule.yml",
	};

	it("issues one runQueriesOnFile call with the per-rule cap", async () => {
		const { runner, runQueriesOnFile, runQueryOnFile } =
			await loadRunnerWithQueries([fakeQuery]);
		const ctx = {
			...createCtx("/fake/file.ts"),
			modifiedRanges: [{ start: 10, end: 10 }],
		};
		await runner.run(ctx as any);
		expect(runQueriesOnFile).toHaveBeenCalledTimes(1);
		expect(runQueriesOnFile.mock.calls[0][0]).toEqual([
			expect.objectContaining({ id: "fake-rule" }),
		]);
		expect(runQueriesOnFile.mock.calls[0][3]).toEqual({ maxResults: 10 });
		// Small edit: no entity walks either.
		expect(runQueryOnFile).not.toHaveBeenCalled();
	});

	it("interpolates double-brace capture placeholders in diagnostic messages", async () => {
		const query = {
			...fakeQuery,
			message: "Hallucinated import '{{NAME}}' from '{{MODULE}}'",
		};
		const { runner, runQueriesOnFile } = await loadRunnerWithQueries([query]);
		runQueriesOnFile.mockResolvedValueOnce([
			{
				queryDef: query,
				match: {
					line: 1,
					column: 1,
					captures: { NAME: "JSONResponse", MODULE: "django" },
					matchedText: "from django import JSONResponse",
					nodeType: "import_from_statement",
				},
			},
		]);

		const result = await runner.run({
			...createCtx("/fake/file.ts"),
			modifiedRanges: [{ start: 1, end: 1 }],
		} as any);

		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]?.message).toBe(
			"Hallucinated import 'JSONResponse' from 'django'",
		);
	});
});
