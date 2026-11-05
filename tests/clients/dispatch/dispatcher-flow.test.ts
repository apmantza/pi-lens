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

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearCoverageNoticeState,
	clearLatencyReports,
	createDispatchContext,
	getLatencyReports,
	RunnerRegistry,
	dispatchForFile as runDispatchForFile,
} from "../../../clients/dispatch/dispatcher.js";
import {
	observeRunnerLatency,
	resetObservedRunnerLatency,
} from "../../../clients/dispatch/collect-later-tier.js";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import { resetPendingRunnerFindings } from "../../../clients/dispatch/pending-runner-findings.js";
import {
	type Diagnostic,
	faultResult,
	type RunnerGroup,
	type RunnerResult,
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
		it("refuses all dispatch runners for an adopted root at the dispatch entry", async () => {
			// Recurrence: #4257 F1 allowed project-configured runners to execute
			// after the adopted-root notice, despite the caller's root classification.
			const run = vi.fn(async () => ({
				status: "succeeded" as const,
				diagnostics: [],
				semantic: "none" as const,
			}));
			registerRunner({
				id: "adopted-runner",
				appliesTo: ["jsts"],
				priority: 1,
				run,
			});
			const ctx = createDispatchContext(
				"test.ts",
				"/project",
				{ getFlag: () => false },
				new FactStore(),
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				"adopted",
			);
			const result = await runDispatchForFile(
				ctx,
				[{ mode: "all", runnerIds: ["adopted-runner"] }],
				registry,
			);
			expect(run).not.toHaveBeenCalled();
			expect(result.diagnostics).toEqual([]);
		});

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

		it("repeats the coverage notice for a pull dispatch and leaves the push latch untouched (#3791)", async () => {
			// #3791: the pi push surface latches the notice once per session (the
			// sibling test above). A pull surface (`pilens_analyze`, connected by
			// `dedupeCoverageNotice: false`) must say so on every call, and must
			// not consume the latch a later push still needs.
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
			const notice = "Pi-lens go analysis unavailable";
			const pull = () =>
				runDispatchForFile(ctx, groups, registry, undefined, {
					dedupeCoverageNotice: false,
				});

			// Pay the push latch first so the pull call has to ignore it, not just
			// start from a clean session.
			const pushFirst = await runDispatchForFile(ctx, groups, registry);
			expect(pushFirst.output).toContain(notice);
			const pushSecond = await runDispatchForFile(ctx, groups, registry);
			expect(pushSecond.output).not.toContain(notice);

			const pullFirst = await pull();
			expect(pullFirst.output).toContain(notice);
			expect(pullFirst.warnings.map((w) => w.message)).toContainEqual(
				expect.stringContaining(notice),
			);
			const pullSecond = await pull();
			expect(pullSecond.output).toContain(notice);
			expect(pullSecond.warnings.map((w) => w.message)).toContainEqual(
				expect.stringContaining(notice),
			);

			// The pull runs did not write the latch: the next push is still
			// suppressed, exactly as it would have been without the pulls.
			const pushThird = await runDispatchForFile(ctx, groups, registry);
			expect(pushThird.output).not.toContain(notice);
		}, 30000);

		it("does not let pull dispatches consume a fresh push notice (#3791 F2)", async () => {
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
			const notice = "Pi-lens go analysis unavailable";
			const pull = () =>
				runDispatchForFile(ctx, groups, registry, undefined, {
					dedupeCoverageNotice: false,
				});

			expect((await pull()).output).toContain(notice);
			expect((await pull()).output).toContain(notice);
			const firstPush = await runDispatchForFile(ctx, groups, registry);
			expect(firstPush.output).toContain(notice);
		});

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

		// Recurrence: `looksLikeDiagnosticCodePath` hand-rolled the backslash fold
		// (`text.replace(/\\/g, "/")`, a pin in path-key-fold-sweep) beside
		// `toPosix`. A Windows-spelled `<dir>\\<rule>:<line>` has its code-like
		// base only after the fold, so a drifted copy of the fold lets such a
		// path through as a file path. The dispatcher is the caller; the fold
		// seam is `toPosix`.
		it.each([
			["src\\lsp:80007", true],
			["C:\\proj\\similarity:3:4", true],
			["lsp:80007", true],
			["src\\main.ts", false],
		])(
			"treats the runner diagnostic path %j as code-like: %s",
			async (rawPath, codeLike) => {
				const logs: string[] = [];
				registerRunner({
					id: "code-path-backslash",
					appliesTo: ["jsts"],
					priority: 10,
					async run() {
						return {
							status: "succeeded",
							diagnostics: [
								{
									id: "diag-bs",
									message: "backslash code-like path",
									filePath: rawPath,
									severity: "warning",
									semantic: "warning",
									tool: "code-path-backslash",
								},
							],
							semantic: "warning",
						};
					},
				});

				const ctx = createMockContext("src/main.ts");
				const baseLog = ctx.log.bind(ctx);
				ctx.log = (message: string) => {
					logs.push(message);
					baseLog(message);
				};
				const result = await dispatchForFile(ctx, [
					{ mode: "all", runnerIds: ["code-path-backslash"] },
				]);

				expect(result.diagnostics).toHaveLength(1);
				const ignored = logs.some((line) =>
					line.includes(`ignored diagnostic code-like path '${rawPath}'`),
				);
				expect(ignored).toBe(codeLike);
				if (codeLike) {
					expect(result.diagnostics[0].filePath).toContain("src/main.ts");
				}
			},
		);

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

		it("calls a finding new when one tool names it under another id at the same place and rule (#4629)", async () => {
			// Two copies are one finding across LANES (a language server and a CLI),
			// not across ids of one tool: helm-lint's id carries an ordinal and
			// actionlint's carries the message, so a new message at the same line and
			// rule is a new finding. The id alone decides, as it did before #4629.
			const file = "/project/test.ts";
			const facts = new FactStore();
			setBaselineFacts(facts, file, [
				{
					id: "reporter-1-error",
					message: "chart name is missing",
					filePath: file,
					line: 3,
					column: 1,
					rule: "error",
					tool: "reporter",
					semantic: "blocking",
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
								id: "reporter-2-error",
								message: "chart version is missing",
								filePath: "test.ts",
								line: 3,
								column: 1,
								rule: "error",
								severity: "error",
								semantic: "blocking",
								tool: "reporter",
							},
						],
						semantic: "blocking",
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

			expect(result.diagnostics.map((d) => d.id)).toEqual(["reporter-2-error"]);
			expect(result.resolvedCount).toBe(1);
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

		it("never promotes a runner fault to a blocker when its message names an unused value (#4130)", async () => {
			// Recurrence (CodeRabbit review of #4934): `faultResult`
			// is a warning by construction. A new fault whose message names an
			// unused value reached `promoteDeltaUnusedToBlockers` in the delta, which
			// raised it to `blocking`, so a tool that broke entered the blocker map
			// (#3814).
			const facts = new FactStore();
			setBaselineFacts(facts, "/project/test.ts", []);

			registerRunner(
				createMockRunner({
					id: "reporter",
					appliesTo: ["jsts"],
					runResult: unusedNamingFault(),
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
			expect(result.diagnostics[0].semantic).toBe("warning");
			expect(result.diagnostics[0].severity).toBe("warning");
			expect(result.hasBlockers).toBe(false);
		});

		it("keeps a held-back runner fault a warning, so the record never holds it as a blocker (#4130)", async () => {
			// Recurrence: the same fault on the next edit is no longer new, so the
			// delta holds it back as already seen. That is the second caller of the
			// promotion seam (`stillObserved`), which must leave the fault a warning.
			const facts = new FactStore();
			setBaselineFacts(
				facts,
				"/project/test.ts",
				unusedNamingFault().diagnostics,
			);

			registerRunner(
				createMockRunner({
					id: "reporter",
					appliesTo: ["jsts"],
					runResult: unusedNamingFault(),
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

			expect(result.stillObserved?.map((d) => d.semantic)).toEqual(["warning"]);
			expect(result.hasBlockers).toBe(false);
		});

		it("states why a delta-promoted unused finding blocks, once for several items (#3218)", async () => {
			// Recurrence (2026-09-19 live session): the agent's own edit promoted
			// two hint-severity ts:6133 findings to `blocking`, but the STOP block
			// gave only the tier, so the agent re-ran lens_diagnostics to reconcile
			// "all listed items are ℹ️ tier" with the blocker header.
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
								id: "new-unused-a",
								message: "'tmpdir' is declared but its value is never read.",
								filePath: "test.ts",
								line: 12,
								severity: "hint",
								semantic: "none",
								tool: "lsp",
								code: "6133",
							},
							{
								id: "new-unused-b",
								message:
									"'FetchError' is declared but its value is never read.",
								filePath: "test.ts",
								line: 18,
								severity: "hint",
								semantic: "none",
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

			expect(result.hasBlockers).toBe(true);
			expect(result.blockerOutput).toContain(
				"🔴 STOP — 2 issue(s) must be fixed",
			);
			const reason =
				"new in this edit → blocks in delta mode; pre-existing unused declarations only advise.";
			expect(result.blockerOutput).toContain(reason);
			// One line, never per-item boilerplate.
			expect(result.blockerOutput.split(reason)).toHaveLength(2);
		});

		it("does not stamp the promotion reason on a natively blocking or baseline-preexisting unused finding (#3218)", async () => {
			// Recurrence guard for the negative direction: only findings the
			// promotion seam actually raised carry the reason. A natively blocking
			// unused finding (already error/blocking) and a baseline-preexisting
			// unused finding must render with no reason note, or every blocker
			// would claim it was promoted.
			const facts = new FactStore();
			setBaselineFacts(facts, "/project/test.ts", [
				{
					id: "old-unused",
					message: "'preexisting' is declared but its value is never read.",
					filePath: "test.ts",
					line: 30,
					severity: "hint",
					semantic: "none",
					tool: "lsp",
					code: "6133",
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
								id: "native-unused",
								message: "'kept' is declared but its value is never read.",
								filePath: "test.ts",
								line: 5,
								severity: "error",
								semantic: "blocking",
								tool: "lsp",
								code: "6133",
							},
							{
								id: "old-unused",
								message:
									"'preexisting' is declared but its value is never read.",
								filePath: "test.ts",
								line: 30,
								severity: "hint",
								semantic: "none",
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

			expect(result.hasBlockers).toBe(true);
			expect(result.blockerOutput).toContain(
				"🔴 STOP — 1 issue(s) must be fixed",
			);
			expect(result.blockerOutput).not.toContain(
				"new in this edit → blocks in delta mode",
			);
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
			// #4484 round 3 (R1): a precondition that threw never decided the
			// runner does not apply, so its skip reaches no verdict. Recurrence:
			// the throw read as "not applicable", a verdict, and retired the
			// runner's recorded blockers while they were on disk.
			expect(result.inconclusiveSources?.runnerIds).toEqual(["throws-when"]);
		});

		it("counts a precondition that declines as a verdict (#4484 round 3)", async () => {
			registerRunner(createConditionalRunner("declines", () => false));
			const result = await dispatchForFile(createMockContext("test.ts"), [
				{ mode: "all", runnerIds: ["declines"] },
			]);
			expect(result.inconclusiveSources).toBeUndefined();
		});
	});

	// #4484 round 3 (R4): lines an earlier write owed a runner because it
	// reached no verdict join that runner's range, and only that runner's.
	// Recurrence: a blocker first written while its runner had no verdict was
	// withheld as out of range on the next write and never recorded (TLC
	// MutOwedRanges, witness row 15).
	describe("owed ranges (#4484 round 3)", () => {
		it("widens only the owing runner's range", async () => {
			const seen = new Map<string, unknown>();
			for (const id of ["owed", "settled"]) {
				registerRunner({
					id,
					appliesTo: ["jsts"],
					priority: 1,
					run: async (ctx) => {
						seen.set(id, ctx.modifiedRanges);
						return { status: "succeeded", diagnostics: [], semantic: "none" };
					},
				});
			}
			const ctx = createDispatchContext(
				"test.ts",
				"/project",
				{ getFlag: () => false },
				new FactStore(),
				undefined,
				[{ start: 1, end: 1 }],
			);
			await dispatchForFile(
				{ ...ctx, owedRanges: new Map([["owed", [{ start: 2, end: 3 }]]]) },
				[{ mode: "all", runnerIds: ["owed", "settled"] }],
			);
			expect(seen.get("owed")).toEqual([{ start: 1, end: 3 }]);
			expect(seen.get("settled")).toEqual([{ start: 1, end: 1 }]);
		});

		// A collect-later run settles on its own and owes the next write
		// nothing. Recurrence: unmarked, a runner deferred on every write would
		// owe every edited line for good and widen each later edit's range.
		it("names a collect-later run in flight apart from the runners that owe", async () => {
			registerRunner(createCleanRunner("slow"));
			observeRunnerLatency({
				projectRoot: "/project",
				runnerId: "slow",
				durationMs: 60_000,
			});
			try {
				const ctx = createDispatchContext(
					"test.ts",
					"/project",
					{ getFlag: () => false },
					new FactStore(),
					undefined,
					[{ start: 1, end: 1 }],
					"/project",
					1,
				);
				const result = await dispatchForFile(ctx, [
					{ mode: "all", runnerIds: ["slow"] },
				]);
				expect(result.inconclusiveSources?.runnerIds).toEqual(["slow"]);
				expect(result.inconclusiveSources?.collectLaterRunnerIds).toEqual([
					"slow",
				]);
			} finally {
				resetObservedRunnerLatency();
				resetPendingRunnerFindings();
			}
		});
	});

	// #4509: napi runs under Gate B while it holds a recorded blocker, beside
	// the ast-grep server whose copies carry another identity.
	describe("covered runs (#4509)", () => {
		const finding = (
			line: number,
			serverId?: string,
			over: Partial<Diagnostic> = {},
		): Diagnostic => ({
			id: `f-${line}`,
			message: "Function returns 'unknown'",
			filePath: "test.ts",
			line,
			severity: "error",
			semantic: "blocking",
			tool: serverId ? "lsp" : "ast-grep-napi",
			// The spellings each runner gives one rule: the server's LSP copy
			// carries its source, napi's the rule id. The overlap dedupe keys on
			// the normalized rule (#4629), so the two name one finding there.
			// `laneCopyStandsFor` still decides what a settled run records.
			rule: serverId ? "ast-grep:no-unknown-returns" : "no-unknown-returns",
			...(serverId && { serverId }),
			...over,
		});
		const register = (laneAnswers: boolean, lane: Partial<Diagnostic> = {}) => {
			registerRunner({
				id: "lane",
				appliesTo: ["jsts"],
				priority: 1,
				run: async () => ({
					status: "succeeded",
					// A silent server delivers none of its copies.
					diagnostics: laneAnswers ? [finding(3, "srv", lane)] : [],
					semantic: "blocking",
					...(!laneAnswers && { unconfirmedServerIds: ["srv"] }),
				}),
			});
			registerRunner({
				id: "peer",
				appliesTo: ["jsts"],
				priority: 2,
				run: async () => ({
					status: "succeeded",
					diagnostics: [finding(3), finding(5)],
					semantic: "blocking",
					coveredBy: { runnerId: "lane", serverId: "srv" },
				}),
			});
		};
		const run = async (withSemantic = false) => {
			const ctx = createDispatchContext(
				"test.ts",
				"/project",
				{ getFlag: () => false },
				new FactStore(),
			);
			const result = await dispatchForFile(ctx, [
				{ mode: "all", runnerIds: ["lane", "peer"] },
			]);
			return result.diagnostics
				.map(
					(d) =>
						`${d.runnerId}@${d.line}${withSemantic ? `:${d.semantic}` : ""}`,
				)
				.sort();
		};

		// Recurrence (#4491 row 18b, probe P35): the run and the lane both
		// delivered the finding on the line the lane flagged: one finding,
		// listed twice in the STOP block.
		it("drops a covered run's finding where its answering lane flagged the line", async () => {
			register(true);
			expect(await run()).toEqual(["lane@3", "peer@5"]);
		});

		// Recurrence (#4491 row 26, probe P33): a covered run's verdict with
		// its lane silent is the only reading of the bytes; dropping or
		// voiding it would retire napi's blocker with the violation on disk.
		it("delivers a covered run's findings when its lane is silent", async () => {
			register(false);
			expect(await run()).toEqual(["peer@3", "peer@5"]);
		});

		// Recurrence (#4529 review R1, probe P45): the drop keyed by line
		// alone, so a team sgconfig's server flagging another rule on napi's
		// blocker line swapped napi's blocker out, or at warning left `✓ clean`.
		it("keeps a covered run's finding where its lane flagged another rule on the line", async () => {
			register(true, { rule: "ast-grep:other-rule" });
			expect(await run()).toEqual(["lane@3", "peer@3", "peer@5"]);
		});

		// Recurrence (#4529 review R1): a team sgconfig can downgrade the same
		// rule, and the server's warning copy then stood for napi's blocker,
		// so nothing blocked. The blocker is still the one delivered; the
		// overlap dedupe (#4629) absorbs the weaker copy of the same finding
		// into it, where it used to list both.
		it("keeps a covered run's blocker where its lane's copy of the rule is weaker", async () => {
			register(true, { severity: "warning", semantic: "warning" });
			expect(await run(true)).toEqual(["peer@3:blocking", "peer@5:blocking"]);
		});

		// A cover may name a runner and no server (`coveredBy.serverId` is
		// optional). Reading every finding as that lane's copy would drop the
		// run's own findings that no lane delivers.
		it("reads only the lane runner's copies when the cover names no server", async () => {
			registerRunner({
				id: "lane",
				appliesTo: ["jsts"],
				priority: 1,
				run: async () => ({
					status: "succeeded",
					diagnostics: [finding(3)],
					semantic: "blocking",
				}),
			});
			registerRunner({
				id: "peer",
				appliesTo: ["jsts"],
				priority: 2,
				run: async () => ({
					status: "succeeded",
					diagnostics: [finding(3), finding(5)],
					semantic: "blocking",
					coveredBy: { runnerId: "lane" },
				}),
			});
			expect(await run()).toEqual(["lane@3", "peer@5"]);
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

/**
 * A runner fault built by the production constructor (`faultResult`), whose
 * own message names an unused value. That word is the trigger the delta's
 * unused-value promotion reads.
 */
function unusedNamingFault(): RunnerResult {
	return faultResult(
		{
			kind: "server_error",
			failureMessage: "unused-variable check exited 2",
		},
		{
			id: "lsp:server-error:0",
			message: "LSP server failed: unused-variable check exited 2",
			filePath: "test.ts",
			line: 1,
			column: 1,
			tool: "lsp",
		},
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
