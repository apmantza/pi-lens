/**
 * Dispatch System Integration Tests
 *
 * Tests the actual dispatch execution flow:
 * - Runner registration and retrieval
 * - dispatchForFile() with mock runners
 * - Delta mode filtering
 * - Group execution semantics
 * - Conditional runners (when)
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	createDispatchContext,
	dispatchForFile as runDispatchForFile,
	RunnerRegistry,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import type { RunnerGroup } from "../../../clients/dispatch/types.js";
import {
	createCleanRunner,
	createConditionalRunner,
	createFailingRunner,
	createMockRunner,
	createWarningRunner,
} from "../../mocks/runner-factory.js";

describe("Dispatch Flow", () => {
	let registry: RunnerRegistry;

	const registerRunner = (runner: Parameters<RunnerRegistry["register"]>[0]) => {
		registry.register(runner);
	};
	const getRunner = (id: string) => registry.get(id);
	const getRunnersForKind = (kind: "jsts" | "python") =>
		registry.getForKind(kind);
	const dispatchForFile = (ctx: Parameters<typeof runDispatchForFile>[0], groups: Parameters<typeof runDispatchForFile>[1]) =>
		runDispatchForFile(ctx, groups, registry);

	beforeEach(() => {
		registry = new RunnerRegistry();
	});

	describe("Runner Registration", () => {
		it("should register and retrieve runner", () => {
			const runner = createCleanRunner("test-runner");
			registerRunner(runner);

			const retrieved = getRunner("test-runner");
			expect(retrieved).toBeDefined();
			expect(retrieved?.id).toBe("test-runner");
		});

		it("should return undefined for unknown runner", () => {
			const runner = getRunner("non-existent");
			expect(runner).toBeUndefined();
		});

		it("should get runners for specific file kind", () => {
			registerRunner(
				createMockRunner({
					id: "ts-runner",
					appliesTo: ["jsts"],
					runResult: {
						status: "succeeded",
						diagnostics: [],
						semantic: "none",
					},
				}),
			);
			registerRunner(
				createMockRunner({
					id: "py-runner",
					appliesTo: ["python"],
					runResult: {
						status: "succeeded",
						diagnostics: [],
						semantic: "none",
					},
				}),
			);
			registerRunner(
				createMockRunner({
					id: "all-runner",
					appliesTo: ["jsts", "python"],
					runResult: {
						status: "succeeded",
						diagnostics: [],
						semantic: "none",
					},
				}),
			);

			const tsRunners = getRunnersForKind("jsts");
			expect(tsRunners.map((r) => r.id).sort()).toEqual([
				"all-runner",
				"ts-runner",
			]);

			const pyRunners = getRunnersForKind("python");
			expect(pyRunners.map((r) => r.id).sort()).toEqual([
				"all-runner",
				"py-runner",
			]);
		});

		it("should sort runners by priority", () => {
			registerRunner(
				createMockRunner({
					id: "low",
					appliesTo: ["jsts"],
					priority: 50,
					runResult: {
						status: "succeeded",
						diagnostics: [],
						semantic: "none",
					},
				}),
			);
			registerRunner(
				createMockRunner({
					id: "high",
					appliesTo: ["jsts"],
					priority: 5,
					runResult: {
						status: "succeeded",
						diagnostics: [],
						semantic: "none",
					},
				}),
			);
			registerRunner(
				createMockRunner({
					id: "medium",
					appliesTo: ["jsts"],
					priority: 20,
					runResult: {
						status: "succeeded",
						diagnostics: [],
						semantic: "none",
					},
				}),
			);

			const runners = getRunnersForKind("jsts");
			expect(runners.map((r) => r.id)).toEqual(["high", "medium", "low"]);
		});
	});

	describe("Dispatch Execution", () => {
		it("should execute single runner and return diagnostics", async () => {
			registerRunner(createWarningRunner("mock-linter"));

			const ctx = createMockContext("test.ts");
			const groups: RunnerGroup[] = [
				{ mode: "all", runnerIds: ["mock-linter"] },
			];

			const result = await dispatchForFile(ctx, groups);

			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].message).toBe("Mock warning");
			expect(result.warnings).toHaveLength(1);
			expect(result.blockers).toHaveLength(0);
		});

		it("shows non-blocking analysis-unavailable notice when semantic tools are missing", async () => {
			registerRunner({
				id: "lsp",
				appliesTo: ["go"],
				priority: 4,
				enabledByDefault: true,
				async run() {
					return { status: "skipped", diagnostics: [], semantic: "none" };
				},
			});
			registerRunner({
				id: "go-vet",
				appliesTo: ["go"],
				priority: 12,
				enabledByDefault: true,
				async run() {
					return { status: "skipped", diagnostics: [], semantic: "none" };
				},
			});
			registerRunner({
				id: "golangci-lint",
				appliesTo: ["go"],
				priority: 14,
				enabledByDefault: true,
				async run() {
					return { status: "skipped", diagnostics: [], semantic: "none" };
				},
			});
			registerRunner({
				id: "tree-sitter",
				appliesTo: ["go"],
				priority: 20,
				enabledByDefault: true,
				async run() {
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			});

			const ctx = createMockContext("main.go");
			const groups: RunnerGroup[] = [
				{ mode: "all", runnerIds: ["lsp", "go-vet", "golangci-lint", "tree-sitter"] },
			];

			const result = await dispatchForFile(ctx, groups);

			expect(result.hasBlockers).toBe(false);
			expect(result.output).toContain(
				"Pi-lens analysis unavailable. Tools for go not installed.",
			);

			const secondResult = await dispatchForFile(ctx, groups);
			expect(secondResult.output).not.toContain(
				"Pi-lens analysis unavailable. Tools for go not installed.",
			);
		});

		it("should execute multiple runners in group", async () => {
			registerRunner(createWarningRunner("runner-1"));
			registerRunner(createFailingRunner("runner-2"));
			registerRunner(createCleanRunner("runner-3"));

			const ctx = createMockContext("test.ts");
			const groups: RunnerGroup[] = [
				{
					mode: "all",
					runnerIds: ["runner-1", "runner-2", "runner-3"],
				},
			];

			const result = await dispatchForFile(ctx, groups);

			expect(result.diagnostics).toHaveLength(2); // warning + error
			expect(result.warnings).toHaveLength(1);
			expect(result.blockers).toHaveLength(1);
			expect(result.hasBlockers).toBe(true);
		});

		it("suppresses overlapping non-blocking lint warnings when LSP reports same span/class", async () => {
			registerRunner({
				id: "lsp",
				appliesTo: ["jsts"],
				priority: 4,
				enabledByDefault: true,
				async run() {
					return {
						status: "succeeded",
						diagnostics: [
							{
								id: "lsp-dup-1",
								message: "Unused variable",
								filePath: "test.ts",
								line: 12,
								severity: "warning",
								semantic: "warning",
								tool: "lsp",
								defectClass: "unused-value",
							},
						],
						semantic: "warning",
					};
				},
			});

			registerRunner({
				id: "eslint",
				appliesTo: ["jsts"],
				priority: 12,
				enabledByDefault: true,
				async run() {
					return {
						status: "succeeded",
						diagnostics: [
							{
								id: "eslint-dup-1",
								message: "no-unused-vars: Unused variable",
								filePath: "test.ts",
								line: 12,
								severity: "warning",
								semantic: "warning",
								tool: "eslint",
								defectClass: "unused-value",
							},
						],
						semantic: "warning",
					};
				},
			});

			const ctx = createMockContext("test.ts");
			const groups: RunnerGroup[] = [
				{ mode: "all", runnerIds: ["lsp", "eslint"] },
			];

			const result = await dispatchForFile(ctx, groups);

			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].tool).toBe("lsp");
		});

		it("should skip unregistered runners gracefully", async () => {
			registerRunner(createCleanRunner("registered"));

			const ctx = createMockContext("test.ts");
			const groups: RunnerGroup[] = [
				{ mode: "all", runnerIds: ["registered", "missing"] },
			];

			const result = await dispatchForFile(ctx, groups);

			// Should not throw, just skip missing runner
			expect(result.diagnostics).toHaveLength(0);
		});

		it("normalizes code-like diagnostic file paths to current file", async () => {
			registerRunner({
				id: "code-path",
				appliesTo: ["jsts"],
				priority: 10,
				enabledByDefault: true,
				async run() {
					return {
						status: "succeeded",
						diagnostics: [
							{
								id: "diag-1",
								message: "code-like path should be normalized",
								filePath: "lsp:80007",
								severity: "warning",
								semantic: "warning",
								tool: "code-path",
							},
						],
						semantic: "warning",
					};
				},
			});

			const ctx = createMockContext("src/main.ts");
			const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["code-path"] }];
			const result = await dispatchForFile(ctx, groups);

			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].filePath).toContain("src/main.ts");
		});

		it("fallback mode should continue after failed runner and use next success", async () => {
			const calls: string[] = [];
			registerRunner({
				id: "first-fail",
				appliesTo: ["jsts"],
				priority: 10,
				enabledByDefault: true,
				async run() {
					calls.push("first-fail");
					return {
						status: "failed",
						diagnostics: [
							{
								id: "fail-1",
								message: "first failed",
								filePath: "test.ts",
								severity: "warning",
								semantic: "warning",
								tool: "first-fail",
							},
						],
						semantic: "warning",
					};
				},
			});

			registerRunner({
				id: "second-success",
				appliesTo: ["jsts"],
				priority: 11,
				enabledByDefault: true,
				async run() {
					calls.push("second-success");
					return {
						status: "succeeded",
						diagnostics: [
							{
								id: "warn-2",
								message: "second ran",
								filePath: "test.ts",
								severity: "warning",
								semantic: "warning",
								tool: "second-success",
							},
						],
						semantic: "warning",
					};
				},
			});

			registerRunner({
				id: "third-skipped",
				appliesTo: ["jsts"],
				priority: 12,
				enabledByDefault: true,
				async run() {
					calls.push("third-skipped");
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			});

			const ctx = createMockContext("test.ts");
			const groups: RunnerGroup[] = [
				{
					mode: "fallback",
					runnerIds: ["first-fail", "second-success", "third-skipped"],
				},
			];

			const result = await dispatchForFile(ctx, groups);

			expect(calls).toEqual(["first-fail", "second-success"]);
			expect(result.diagnostics.map((d) => d.id).sort()).toEqual([
				"fail-1",
				"warn-2",
			]);
		});
	});

	describe("Delta Mode (Baseline Filtering)", () => {
		it("should filter pre-existing issues in delta mode", async () => {
			const facts = new FactStore();
			setBaselineFacts(facts, "/project/test.ts", [{
				id: "old-issue",
				message: "Old",
			}]);

			registerRunner(
				createMockRunner({
					id: "reporter",
					appliesTo: ["jsts"],
					runResult: {
						status: "succeeded",
						diagnostics: [
							{
								id: "old-issue",
								message: "Old",
								filePath: "test.ts",
								severity: "warning",
								semantic: "warning",
								tool: "reporter",
							},
							{
								id: "new-issue",
								message: "New",
								filePath: "test.ts",
								severity: "warning",
								semantic: "warning",
								tool: "reporter",
							},
						],
						semantic: "warning",
					},
				}),
			);

			const ctx = createDispatchContext(
				"test.ts",
				"/project",
				{ getFlag: () => false },
				facts,
			);
			const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["reporter"] }];

			const result = await dispatchForFile(ctx, groups);

			// Only new issue should be reported
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].id).toBe("new-issue");
		});

		it("should report all issues when delta mode disabled", async () => {
			const facts = new FactStore();
			setBaselineFacts(facts, "/project/test.ts", [{
				id: "old-issue",
				message: "Old",
			}]);

			registerRunner(
				createMockRunner({
					id: "reporter",
					appliesTo: ["jsts"],
					runResult: {
						status: "succeeded",
						diagnostics: [
							{
								id: "old-issue",
								message: "Old",
								filePath: "test.ts",
								severity: "warning",
								semantic: "warning",
								tool: "reporter",
							},
						],
						semantic: "warning",
					},
				}),
			);

			const mockPi = {
				getFlag: (f: string) => f === "no-delta",
			}; // Delta mode OFF
			const ctx = createDispatchContext(
				"test.ts",
				"/project",
				mockPi,
				facts,
			);
			const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["reporter"] }];

			const result = await dispatchForFile(ctx, groups);

			// All issues reported (no filtering)
			expect(result.diagnostics).toHaveLength(1);
		});

		it("promotes new unused-value diagnostics to blockers in delta mode", async () => {
			const facts = new FactStore();
			setBaselineFacts(facts, "/project/test.ts", []);

			registerRunner(
				createMockRunner({
					id: "reporter",
					appliesTo: ["jsts"],
					runResult: {
						status: "succeeded",
						diagnostics: [
							{
								id: "new-unused",
								message: "'x' is declared but its value is never read.",
								filePath: "test.ts",
								severity: "warning",
								semantic: "warning",
								tool: "lsp",
								code: "6133",
							},
						],
						semantic: "warning",
					},
				}),
			);

			const ctx = createDispatchContext(
				"test.ts",
				"/project",
				{ getFlag: () => false },
				facts,
			);
			const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["reporter"] }];

			const result = await dispatchForFile(ctx, groups);

			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].semantic).toBe("blocking");
			expect(result.diagnostics[0].severity).toBe("error");
			expect(result.hasBlockers).toBe(true);
		});
	});

	describe("Conditional Runners (when)", () => {
		it("should run conditional runner when condition true", async () => {
			registerRunner(
				createConditionalRunner("conditional", (ctx) => ctx.autofix),
			);

			const mockPi = {
				getFlag: (f: string) => f === "autofix-biome",
			};
			const ctx = createDispatchContext(
				"test.ts",
				"/project",
				mockPi,
				new FactStore(),
			);
			const groups: RunnerGroup[] = [
				{ mode: "all", runnerIds: ["conditional"] },
			];

			const result = await dispatchForFile(ctx, groups);

			expect(ctx.autofix).toBe(true);
			expect(result.diagnostics).toHaveLength(1);
		});

		it("should skip conditional runner when condition false", async () => {
			registerRunner(
				createConditionalRunner("conditional", (ctx) => ctx.autofix),
			);

			const mockPi = { getFlag: () => false };
			const ctx = createDispatchContext(
				"test.ts",
				"/project",
				mockPi,
				new FactStore(),
			);
			const groups: RunnerGroup[] = [
				{ mode: "all", runnerIds: ["conditional"] },
			];

			const result = await dispatchForFile(ctx, groups);

			expect(ctx.autofix).toBe(false);
			expect(result.diagnostics).toHaveLength(0);
		});

		it("should skip runner when when() throws and continue others", async () => {
			registerRunner(
				createMockRunner({
					id: "throws-when",
					appliesTo: ["jsts"],
					when: async () => {
						throw new Error("bad precondition");
					},
					runResult: {
						status: "succeeded",
						diagnostics: [
							{
								id: "should-not-run",
								message: "should not run",
								filePath: "test.ts",
								severity: "warning",
								semantic: "warning",
								tool: "throws-when",
							},
						],
						semantic: "warning",
					},
				}),
			);
			registerRunner(createWarningRunner("healthy"));

			const ctx = createMockContext("test.ts");
			const groups: RunnerGroup[] = [
				{ mode: "all", runnerIds: ["throws-when", "healthy"] },
			];

			const result = await dispatchForFile(ctx, groups);

			expect(result.diagnostics.map((d) => d.id)).toEqual(["healthy-warning"]);
		});
	});
});

// Helper function
function createMockContext(filePath: string) {
	return createDispatchContext(filePath, "/project", {
		getFlag: () => false,
	}, new FactStore());
}

function setBaselineFacts(
	facts: FactStore,
	normalizedFilePath: string,
	diagnostics: unknown[],
): void {
	const absKey = `session.baseline.${normalizeMapKey(normalizedFilePath)}`;
	const relKey = `session.baseline.${normalizeMapKey("test.ts")}`;
	facts.setSessionFact(absKey, diagnostics);
	facts.setSessionFact(relKey, diagnostics);
}
