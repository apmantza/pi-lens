import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.hoisted(() => vi.fn());
let available = true;

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));
vi.mock("../../../../clients/tool-policy.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/tool-policy.js")
	>()),
	hasEslintConfig: () => true,
	hasGolangciConfig: () => true,
	getLinterPolicyForCwd: () => undefined,
}));
vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => available,
			isAvailableAsync: async () => available,
			getCommand: () => command,
		}),
		createCwdCachedProbe: () => async () => available,
		resolveToolCommand: () => "eslint",
		resolveAvailableOrInstall: async (checker: { getCommand: () => string }) =>
			available ? checker.getCommand() : null,
	}),
);

type Tool = "eslint" | "golangci-lint";
type SpawnResult = {
	error?: Error | null;
	status: number | null;
	signal?: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

const wire: Record<Tool, string> = {
	eslint: JSON.stringify([
		{
			filePath: "main.js",
			messages: [
				{
					ruleId: "no-alert",
					severity: 2,
					message: "bad alert",
					line: 2,
					column: 3,
				},
			],
		},
	]),
	"golangci-lint": JSON.stringify({
		Issues: [
			{
				FromLinter: "govet",
				Text: "bad Go",
				Severity: "error",
				Pos: { Filename: "main.go", Line: 2, Column: 3 },
			},
		],
	}),
};

async function dispatchOutcome(
	tool: Tool,
	result: SpawnResult,
	/**
	 * Keep the tool's own RELATIVE spelling of the reported file instead of
	 * rewriting it to the absolute temp path (#3278). golangci-lint really
	 * reports `Pos.Filename` relative to its base path — `PathPrettifier`
	 * overwrites the field with `filepath.Rel(basePath, …)` before the JSON
	 * printer sees it (v1.64.8 `pkg/result/processors/path_prettifier.go:31` +
	 * `path_relativity.go:43`) — so the substitution below, which every other
	 * cell in this file relies on, was a double that mirrored the runner's own
	 * wrong assumption and could not see the attribution defect.
	 */
	keepReportedSpelling = false,
) {
	vi.resetModules();
	const env = setupTestEnvironment(`pi-lens-${tool}-outcome-`);
	try {
		const filePath = path.join(
			env.tmpDir,
			tool === "eslint" ? "main.js" : "main.go",
		);
		fs.writeFileSync(filePath, "package main\n");
		if (tool === "golangci-lint")
			fs.writeFileSync(path.join(env.tmpDir, ".golangci.yml"), "run: {}\n");
		const actualResult =
			tool === "golangci-lint" && !keepReportedSpelling
				? {
						...result,
						stdout: result.stdout.replace(
							'"main.go"',
							JSON.stringify(filePath),
						),
					}
				: result;
		safeSpawnAsync.mockImplementation(
			async (_command: string, args: string[]) =>
				args.includes("--version")
					? { error: null, status: 0, stdout: "v1", stderr: "" }
					: actualResult,
		);
		const { createDispatchContext, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const runner = (
			await import(`../../../../clients/dispatch/runners/${tool}.js`)
		).default;
		const { getDegradationSummary, resetDegradationLedger } =
			await import("../../../../clients/degradation-ledger.js");
		resetDegradationLedger();
		const registry = new RunnerRegistry();
		registry.register(runner);
		let observed = { status: "", diagnostics: [] as unknown[] };
		const output = await dispatchForFile(
			createDispatchContext(
				filePath,
				env.tmpDir,
				{ getFlag: () => false },
				new FactStore(),
			),
			[{ mode: "all", runnerIds: [tool] }],
			registry,
			(_id, value) => {
				observed = { status: value.status, diagnostics: value.diagnostics };
			},
		);
		return {
			...observed,
			output: output.output,
			ledger: getDegradationSummary(),
		};
	} finally {
		env.cleanup();
	}
}

async function dispatchTwoEmptyFiles(tool: Tool) {
	vi.resetModules();
	const env = setupTestEnvironment(`pi-lens-${tool}-session-`);
	try {
		safeSpawnAsync.mockResolvedValue({
			error: null,
			status: 1,
			stdout: "",
			stderr: "",
		});
		const { createDispatchContext, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const runner = (
			await import(`../../../../clients/dispatch/runners/${tool}.js`)
		).default;
		const { getDegradationSummary, resetDegradationLedger } =
			await import("../../../../clients/degradation-ledger.js");
		resetDegradationLedger();
		const registry = new RunnerRegistry();
		registry.register(runner);
		for (const name of ["first", "second"]) {
			const filePath = path.join(
				env.tmpDir,
				`${name}.${tool === "eslint" ? "js" : "go"}`,
			);
			fs.writeFileSync(filePath, "package main\n");
			if (tool === "golangci-lint")
				fs.writeFileSync(path.join(env.tmpDir, ".golangci.yml"), "run: {}\n");
			await dispatchForFile(
				createDispatchContext(
					filePath,
					env.tmpDir,
					{ getFlag: () => false },
					new FactStore(),
				),
				[{ mode: "all", runnerIds: [tool] }],
				registry,
			);
		}
		return getDegradationSummary();
	} finally {
		env.cleanup();
	}
}

describe("JSON runner outcome seam (#1816)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		available = true;
	});
	for (const tool of ["eslint", "golangci-lint"] as const) {
		it.each([
			["status 0 clean", { status: 0, stdout: "", stderr: "" }],
			["status 0 stderr noise", { status: 0, stdout: "", stderr: "banner" }],
		])(`${tool}: %s stays clean`, async (_name, result) => {
			const observed = await dispatchOutcome(tool, { error: null, ...result });
			expect(observed.status).toBe("succeeded");
			expect(observed.diagnostics).toEqual([]);
		});
		it(`${tool}: valid JSON findings survive`, async () => {
			const observed = await dispatchOutcome(tool, {
				error: null,
				status: 1,
				stdout: wire[tool],
				stderr: "",
			});
			expect(observed.status).toBe("failed");
			expect(observed.diagnostics).toHaveLength(1);
			expect(observed.output.trim()).toBe(
				fs
					.readFileSync(
						path.resolve(
							"tests/fixtures/witness/runner-outcome-eslint-golangci",
							`${tool}.txt`,
						),
						"utf8",
					)
					.trim(),
			);
		});
		it(`${tool}: nonzero JSON findings survive every tool exit class`, async () => {
			const statuses = tool === "eslint" ? [1, 2] : [1, 3, 4, 5];
			for (const status of statuses) {
				const observed = await dispatchOutcome(tool, {
					error: null,
					status,
					stdout:
						tool === "eslint" && status === 2
							? JSON.stringify([
									{
										filePath: "main.js",
										messages: [
											{
												ruleId: null,
												severity: 2,
												fatal: true,
												message: "Parsing error: Unexpected token",
												line: 1,
												column: 4,
											},
										],
									},
								])
							: wire[tool],
					stderr: "",
				});
				expect(observed.status, `${tool} exit ${status}`).toBe("failed");
				expect(observed.diagnostics).toHaveLength(1);
			}
		});
		it(`${tool}: nonzero text is a parse error for every tool error class`, async () => {
			const statuses = tool === "eslint" ? [2] : [1, 3, 4, 5];
			for (const status of statuses) {
				const observed = await dispatchOutcome(tool, {
					error: null,
					status,
					stdout: "",
					stderr: "tool configuration or execution error",
				});
				expect(observed.status, `${tool} exit ${status}`).toBe("failed");
				expect(observed.diagnostics[0]).toMatchObject({
					id: `${tool}:parse-error:1`,
				});
			}
		});
		if (tool === "eslint") {
			it("eslint: status 2 warning findings remain delivered", async () => {
				const observed = await dispatchOutcome(tool, {
					error: null,
					status: 2,
					stdout: JSON.stringify([
						{
							filePath: "main.js",
							messages: [
								{
									ruleId: "no-warning-comments",
									severity: 1,
									message: "warning",
									line: 1,
									column: 1,
								},
							],
						},
					]),
					stderr: "",
				});
				expect(observed.status).toBe("succeeded");
				expect(observed.diagnostics).toHaveLength(1);
				expect(observed.diagnostics[0]).toMatchObject({
					severity: "warning",
					semantic: "warning",
				});
			});
		}
		it.each([
			["empty", { status: 1, stdout: "", stderr: "" }],
			["stderr-only", { status: 1, stdout: "", stderr: "garbage" }],
			["rejected", { status: 2, stdout: "", stderr: "unknown option" }],
		])(`${tool}: %s is not clean`, async (_name, result) => {
			const observed = await dispatchOutcome(tool, { error: null, ...result });
			expect(["skipped", "failed"]).toContain(observed.status);
		});
		it(`${tool}: signal is not clean`, async () => {
			const observed = await dispatchOutcome(tool, {
				error: null,
				status: null,
				signal: "SIGTERM",
				stdout: "",
				stderr: "",
			});
			expect(observed.status).toBe("skipped");
		});
		it(`${tool}: unavailable does not spawn`, async () => {
			available = false;
			const observed = await dispatchOutcome(tool, {
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});
			expect(observed.status).toBe("skipped");
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		});
		it(`${tool}: pins the JSON wire format`, async () => {
			await dispatchOutcome(tool, {
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				expect.any(String),
				tool === "eslint"
					? [
							"--format",
							"json",
							"--no-error-on-unmatched-pattern",
							expect.any(String),
						]
					: [
							"run",
							// #5119: a project `issues.fix: true` must not make this
							// diagnostics-only run rewrite the file.
							"--fix=false",
							"--output.json.path=stdout",
							"--output.text.path=",
							"--output.tab.path=",
							"--output.html.path=",
							"--output.checkstyle.path=",
							"--output.code-climate.path=",
							"--output.junit-xml.path=",
							"--output.teamcity.path=",
							"--output.sarif.path=",
							"--show-stats=false",
							expect.any(String),
						],
				expect.objectContaining({ cwd: expect.any(String) }),
			);
		});
		if (tool === "golangci-lint") {
			// ADR 0007 witness for the #3278 attribution slice: the rendered,
			// model-facing text for a run whose reported spelling is the one
			// golangci-lint really emits. Pre-fix this golden held the #1816
			// parse-error row instead of the finding, because `path.resolve` with no
			// base resolved `main.go` against the EXTENSION's cwd.
			it("golangci-lint: a base-path-relative Pos.Filename renders as the finding (#3278)", async () => {
				const observed = await dispatchOutcome(
					tool,
					{ error: null, status: 1, stdout: wire[tool], stderr: "" },
					true,
				);
				expect(observed.status).toBe("failed");
				expect(observed.diagnostics).toHaveLength(1);
				expect(observed.output.trim()).toBe(
					fs
						.readFileSync(
							path.resolve(
								"tests/fixtures/witness/runner-outcome-eslint-golangci",
								"golangci-lint-relative-path.txt",
							),
							"utf8",
						)
						.trim(),
				);
			});
		}
		it(`${tool}: bounds empty ledger across two files`, async () => {
			const rows = await dispatchTwoEmptyFiles(tool);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				kind: "runner-empty-result",
				count: 2,
				latestReasons: [{ subject: tool }],
			});
		});
	}
});
