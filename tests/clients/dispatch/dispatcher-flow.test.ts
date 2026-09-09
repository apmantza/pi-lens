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
	clearCoverageNoticeState,
	clearLatencyReports,
	createDispatchContext,
	getLatencyReports,
	RunnerRegistry,
	dispatchForFile as runDispatchForFile,
} from "../../../clients/dispatch/dispatcher.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import type {
	Diagnostic,
	RunnerGroup,
	RunnerResult,
} from "../../../clients/dispatch/types.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	createCleanRunner,
	createConditionalRunner,
	createFailingRunner,
	createMockRunner,
	createWarningRunner,
} from "../../mocks/runner-factory.js";

describe("Dispatch Flow", () => {
	let registry: RunnerRegistry;

	const registerRunner = (
		runner: Parameters<RunnerRegistry["register"]>[0],
	) => {
		registry.register(runner);
	};
	const getRunner = (id: string) => registry.get(id);
	const getRunnersForKind = (kind: "jsts" | "python") =>
		registry.getForKind(kind);
	const dispatchForFile = (
		ctx: Parameters<typeof runDispatchForFile>[0],
		groups: Parameters<typeof runDispatchForFile>[1],
	) => runDispatchForFile(ctx, groups, registry);

	beforeEach(() => {
		registry = new RunnerRegistry();
		clearCoverageNoticeState();
		clearLatencyReports();
	});

	describe("Runner Registration", () => {
		it("registers and retrieves a runner by id", () => {
			const runner = createCleanRunner("test-runner");
			registerRunner(runner);

			const retrieved = getRunner("test-runner");
			expect(retrieved).toBeDefined();
			expect(retrieved?.id).toBe("test-runner");
		});

		it("returns undefined for an unregistered runner id", () => {
			const runner = getRunner("non-existent");
			expect(runner).toBeUndefined();
		});

		it("returns only runners registered for the requested file kind", () => {
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

		it("sorts runners by ascending priority", () => {
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
		it("executes a single runner and returns its diagnostics", async () => {
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

		it("skips all runners for generated files", async () => {
			let runCount = 0;
			registerRunner(
				createMockRunner({
					id: "generated-runner",
					appliesTo: ["jsts"],
					runResult: {
						status: "succeeded",
						diagnostics: [
							{
								id: "generated-warning",
								message: "should not run",
								filePath: "test.generated.ts",
								severity: "warning",
								semantic: "warning",
								tool: "generated-runner",
							},
						],
						semantic: "warning",
					},
					when: () => {
						runCount += 1;
						return true;
					},
				}),
			);

			const ctx = createMockContext("test.generated.ts");
			const result = await dispatchForFile(ctx, [
				{ mode: "all", runnerIds: ["generated-runner"] },
			]);

			expect(ctx.fileRole).toBe("generated");
			expect(result.diagnostics).toEqual([]);
			expect(result.output).toBe("");
			expect(runCount).toBe(0);
		});

		it("shows non-blocking analysis-unavailable notice when semantic tools are missing", async () => {
			registerRunner({
				id: "lsp",
				appliesTo: ["go"],
				priority: 4,
				async run() {
					return { status: "skipped", diagnostics: [], semantic: "none" };
				},
			});
			registerRunner({
				id: "go-vet",
				appliesTo: ["go"],
				priority: 12,
				async run() {
					return { status: "skipped", diagnostics: [], semantic: "none" };
				},
			});
			registerRunner({
				id: "golangci-lint",
				appliesTo: ["go"],
				priority: 14,
				async run() {
					return { status: "skipped", diagnostics: [], semantic: "none" };
				},
			});
			registerRunner({
				id: "tree-sitter",
				appliesTo: ["go"],
				priority: 20,
				async run() {
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			});

			const ctx = createMockContext("main.go");
			const groups: RunnerGroup[] = [
				{
					mode: "all",
					runnerIds: ["lsp", "go-vet", "golangci-lint", "tree-sitter"],
				},
			];

			const result = await dispatchForFile(ctx, groups);

			expect(result.hasBlockers).toBe(false);
			expect(result.output).toContain("Pi-lens go analysis unavailable");

			const secondResult = await dispatchForFile(ctx, groups);
			expect(secondResult.output).not.toContain(
				"Pi-lens go analysis unavailable",
			);
		}, 30000);

		it("does not let unrelated runner coverage suppress missing-tool notices", async () => {
			registerRunner({
				id: "lsp",
				appliesTo: ["go"],
				priority: 4,
				async run() {
					return { status: "skipped", diagnostics: [], semantic: "none" };
				},
			});
			registerRunner({
				id: "go-vet",
				appliesTo: ["go"],
				priority: 12,
				async run() {
					return { status: "skipped", diagnostics: [], semantic: "none" };
				},
			});
			registerRunner({
				id: "eslint",
				appliesTo: ["jsts"],
				priority: 15,
				async run() {
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			});

			const ctx = createMockContext("main.go");
			const groups: RunnerGroup[] = [
				{ mode: "all", runnerIds: ["lsp", "go-vet", "eslint"] },
			];

			const result = await dispatchForFile(ctx, groups);

			expect(result.output).toContain("Pi-lens go analysis unavailable");
		});

		it("executes every runner in a group and aggregates diagnostics", async () => {
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

		it("skips runners that do not apply to the file kind in a group", async () => {
			const calls: string[] = [];
			registerRunner(
				createMockRunner({
					id: "python-only",
					appliesTo: ["python"],
					runResult: {
						status: "succeeded",
						diagnostics: [
							{
								id: "wrong-kind",
								message: "must not run",
								filePath: "test.ts",
								severity: "error",
								semantic: "blocking",
								tool: "python-only",
							},
						],
						semantic: "blocking",
					},
				}),
			);
			registerRunner(
				createMockRunner({
					id: "all-kinds",
					appliesTo: [],
					runResult: {
						status: "succeeded",
						diagnostics: [],
						semantic: "none",
					},
					when: () => {
						calls.push("all-kinds");
						return true;
					},
				}),
			);
			registerRunner(
				createMockRunner({
					id: "jsts-only",
					appliesTo: ["jsts"],
					runResult: {
						status: "succeeded",
						diagnostics: [],
						semantic: "none",
					},
					when: () => {
						calls.push("jsts-only");
						return true;
					},
				}),
			);

			const ctx = createMockContext("test.ts");
			const result = await dispatchForFile(ctx, [
				{
					mode: "all",
					runnerIds: ["python-only", "all-kinds", "jsts-only"],
					filterKinds: ["jsts"],
				},
			]);

			expect(calls).toEqual(["all-kinds", "jsts-only"]);
			expect(result.diagnostics).toEqual([]);
			const report = getLatencyReports().at(-1);
			expect(report?.runners).toContainEqual(
				expect.objectContaining({
					runnerId: "python-only",
					status: "skipped",
				}),
			);
			expect(report?.runners).not.toContainEqual(
				expect.objectContaining({
					runnerId: "python-only",
					status: "failed",
				}),
			);
		});

		it("suppresses overlapping non-blocking lint warnings when LSP reports same span/class", async () => {
			registerRunner({
				id: "lsp",
				appliesTo: ["jsts"],
				priority: 4,
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

		it("skips an unregistered runner id without throwing", async () => {
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

		it("fallback mode continues after a failed runner and uses the next success", async () => {
			const calls: string[] = [];
			registerRunner({
				id: "first-fail",
				appliesTo: ["jsts"],
				priority: 10,
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
		it("filters out baseline issues in delta mode", async () => {
			const facts = new FactStore();
			setBaselineFacts(facts, "/project/test.ts", [
				{
					id: "old-issue",
					message: "Old",
				},
			]);

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

		it("reports baseline issues when delta mode is disabled", async () => {
			const facts = new FactStore();
			setBaselineFacts(facts, "/project/test.ts", [
				{
					id: "old-issue",
					message: "Old",
				},
			]);

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
			const ctx = createDispatchContext("test.ts", "/project", mockPi, facts);
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

		it("does not cross-contaminate delta baselines across cwds sharing a relative path (refs #2489)", async () => {
			// Simulates the warm `pilens_analyze` MCP route: one `FactStore`
			// instance (production's module-scope `sessionFacts` singleton)
			// serving delta-mode dispatches for many different project roots
			// over its lifetime, real `createDispatchContext` + `dispatchForFile`
			// call path throughout — no hand-fed context.
			const facts = new FactStore();
			registerRunner({
				id: "reporter",
				appliesTo: ["jsts"],
				priority: 10,
				async run(ctx): Promise<RunnerResult> {
					// Project A and project B each have their own `src/index.ts`;
					// the runner reports issue ids specific to whichever absolute
					// file it was actually invoked on.
					const diagnostics: Diagnostic[] = ctx.cwd.includes("projecta")
						? [
								{
									id: "issue-1",
									message: "A's issue",
									filePath: "src/index.ts",
									severity: "warning",
									semantic: "warning",
									tool: "reporter",
								},
							]
						: [
								{
									id: "issue-1",
									message: "B's issue (id collides with A's by coincidence)",
									filePath: "src/index.ts",
									severity: "warning",
									semantic: "warning",
									tool: "reporter",
								},
								{
									id: "issue-2",
									message: "B's second issue",
									filePath: "src/index.ts",
									severity: "warning",
									semantic: "warning",
									tool: "reporter",
								},
							];
					return {
						status: "succeeded",
						diagnostics,
						semantic: "warning",
					};
				},
			});
			const groups: RunnerGroup[] = [{ mode: "all", runnerIds: ["reporter"] }];

			// Project A's first-ever delta-mode dispatch of its `src/index.ts`
			// on the shared warm FactStore. This stores A's baseline.
			const ctxA = createDispatchContext(
				"src/index.ts",
				"/projecta",
				{ getFlag: () => false },
				facts,
			);
			await dispatchForFile(ctxA, groups);

			// Project B's first-ever delta-mode dispatch of ITS OWN
			// `src/index.ts` — a different absolute file under a different
			// project root, which shares only the relative path with A's.
			// B has never been dispatched before, so nothing should read as
			// "already seen": both of B's diagnostics must be reported.
			const ctxB = createDispatchContext(
				"src/index.ts",
				"/projectb",
				{ getFlag: () => false },
				facts,
			);
			const resultB = await dispatchForFile(ctxB, groups);

			expect(resultB.diagnostics.map((d) => d.id).sort()).toEqual([
				"issue-1",
				"issue-2",
			]);
		});
	});

	describe("Conditional Runners (when)", () => {
		it("skips the conditional runner when its condition evaluates to false", async () => {
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

		it("skips a runner whose when() throws and continues with the others", async () => {
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

	// #2337: ast-grep-napi declares skipTestFiles: true, but that flag was only
	// enforced in RunnerRegistry.getForKind. The jsts write-group path
	// (clients/dispatch/plan.ts) resolves runners by id via registry.get() and
	// runs them through runGroup, which never consulted skipTestFiles — so a
	// runner declaring the flag still ran, and reported findings, on test files.
	describe("skipTestFiles (dispatcher-level gate, #2337)", () => {
		const skipRunnerResult = () => ({
			status: "succeeded" as const,
			diagnostics: [
				{
					id: "napi-finding",
					message: "should not fire on test files",
					filePath: "auth.test.ts",
					severity: "warning" as const,
					semantic: "warning" as const,
					tool: "skip-test-runner",
				},
			],
			semantic: "warning" as const,
		});

		it("skips a skipTestFiles runner via the group/plan path on a test file", async () => {
			registerRunner(
				createMockRunner({
					id: "skip-test-runner",
					appliesTo: ["jsts"],
					skipTestFiles: true,
					runResult: skipRunnerResult(),
				}),
			);

			const ctx = createMockContext("auth.test.ts");
			const groups: RunnerGroup[] = [
				{
					mode: "all",
					runnerIds: ["skip-test-runner"],
					filterKinds: ["jsts"],
				},
			];

			const result = await dispatchForFile(ctx, groups);

			expect(result.diagnostics).toHaveLength(0);
			const report = getLatencyReports().at(-1);
			expect(
				report?.runners.find((r) => r.runnerId === "skip-test-runner")?.status,
			).toBe("test_file_skipped");
		});

		it("still runs a skipTestFiles runner on a non-test file", async () => {
			registerRunner(
				createMockRunner({
					id: "skip-test-runner",
					appliesTo: ["jsts"],
					skipTestFiles: true,
					runResult: skipRunnerResult(),
				}),
			);

			const ctx = createMockContext("auth.ts");
			const groups: RunnerGroup[] = [
				{
					mode: "all",
					runnerIds: ["skip-test-runner"],
					filterKinds: ["jsts"],
				},
			];

			const result = await dispatchForFile(ctx, groups);

			expect(result.diagnostics.map((d) => d.id)).toEqual(["napi-finding"]);
		});

		it("still runs a runner that does not declare skipTestFiles on a test file", async () => {
			registerRunner(
				createMockRunner({
					id: "plain-runner",
					appliesTo: ["jsts"],
					runResult: {
						status: "succeeded",
						diagnostics: [
							{
								id: "plain-finding",
								message: "runs on test files too",
								filePath: "auth.test.ts",
								severity: "warning",
								semantic: "warning",
								tool: "plain-runner",
							},
						],
						semantic: "warning",
					},
				}),
			);

			const ctx = createMockContext("auth.test.ts");
			const groups: RunnerGroup[] = [
				{
					mode: "all",
					runnerIds: ["plain-runner"],
					filterKinds: ["jsts"],
				},
			];

			const result = await dispatchForFile(ctx, groups);

			expect(result.diagnostics.map((d) => d.id)).toEqual(["plain-finding"]);
			const report = getLatencyReports().at(-1);
			expect(
				report?.runners.find((r) => r.runnerId === "plain-runner")?.status,
			).toBe("succeeded");
		});

		it("does not fire onRunnerResult for a skipTestFiles runner on a test file", async () => {
			registerRunner(
				createMockRunner({
					id: "skip-test-runner",
					appliesTo: ["jsts"],
					skipTestFiles: true,
					runResult: skipRunnerResult(),
				}),
			);

			const ctx = createMockContext("auth.test.ts");
			const ids: string[] = [];
			await runDispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["skip-test-runner"] }],
				registry,
				(id) => ids.push(id),
			);

			expect(ids).toEqual([]);
		});
	});

	describe("Per-runner result sink (onRunnerResult)", () => {
		it("fires once per executed runner with its exact result incl. failureKind", async () => {
			registerRunner({
				id: "ok",
				appliesTo: ["jsts"],
				priority: 10,
				async run() {
					return {
						status: "succeeded",
						diagnostics: [
							{
								id: "d1",
								message: "m",
								filePath: "test.ts",
								severity: "warning",
								semantic: "warning",
								tool: "ok",
							},
						],
						semantic: "warning",
					};
				},
			});
			registerRunner({
				id: "boom",
				appliesTo: ["jsts"],
				priority: 11,
				async run() {
					throw new Error("kaboom");
				},
			});

			const ctx = createMockContext("test.ts");
			const seen: Array<{
				id: string;
				status: string;
				kind: string | undefined;
				diags: number;
			}> = [];
			await runDispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["ok", "boom"] }],
				registry,
				(id, result) =>
					seen.push({
						id,
						status: result.status,
						kind: result.failureKind,
						diags: result.diagnostics.length,
					}),
			);

			expect(seen).toEqual([
				{ id: "ok", status: "succeeded", kind: undefined, diags: 1 },
				{ id: "boom", status: "failed", kind: "exception", diags: 0 },
			]);
		});

		it("does not fire for when-skipped or unregistered runners", async () => {
			registerRunner({
				id: "skipme",
				appliesTo: ["jsts"],
				priority: 10,
				when: async () => false,
				async run() {
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			});

			const ctx = createMockContext("test.ts");
			const ids: string[] = [];
			await runDispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["skipme", "ghost"] }],
				registry,
				(id) => ids.push(id),
			);

			expect(ids).toEqual([]);
		});
	});
});

// Helper function
function createMockContext(filePath: string) {
	return createDispatchContext(
		filePath,
		"/project",
		{
			getFlag: () => false,
		},
		new FactStore(),
	);
}

function setBaselineFacts(
	facts: FactStore,
	normalizedFilePath: string,
	diagnostics: unknown[],
): void {
	const absKey = `session.baseline.${normalizeMapKey(normalizedFilePath)}`;
	facts.setBoundedSessionFact(absKey, diagnostics);
}
