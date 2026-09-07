import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	RUNNER_SKIP_REASONS,
	type RunnerGroup,
	type RunnerResult,
} from "../../../../clients/dispatch/types.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import {
	capKilledSpawnResult,
	capThenAbortedSpawnResult,
	capThenTimedOutSpawnResult,
} from "../../../support/spawn-shapes.js";
import { setupTestEnvironment } from "../../test-utils.js";

// All hoisted: importing `spawn-shapes.js` above reaches the mocked safe-spawn
// module, so every mock factory below now runs during the import phase — a
// plain `const` would still be in its temporal dead zone when it does.
const { safeSpawn, safeSpawnAsync, ensureTool } = vi.hoisted(() => ({
	safeSpawn: vi.fn(),
	safeSpawnAsync: vi.fn(),
	ensureTool: vi.fn(async (_toolId?: string) => "oxlint"),
}));
const logLatency = vi.hoisted(() => vi.fn());

const OXLINT_NO_FILES_BANNER =
	"No files found to lint. Please check your paths and ignore patterns.";
const CANONICAL_NO_FILES_REPORT = {
	diagnostics: [],
	number_of_files: 0,
	number_of_rules: 96,
	threads_count: 16,
	start_time: 0.009533,
};
const CAPTURED_NO_FILES_STDOUT =
	`${OXLINT_NO_FILES_BANNER}\n` +
	'{ "diagnostics": [],\n' +
	'              "number_of_files": 0,\n' +
	'              "number_of_rules": 96,\n' +
	'              "threads_count": 16,\n' +
	'              "start_time": 0.009533\n' +
	"            }\n" +
	"            ";

function noFilesEnvelope(
	report: Record<string, unknown> | string = CANONICAL_NO_FILES_REPORT,
	banner = OXLINT_NO_FILES_BANNER,
): string {
	return `${banner}\n${typeof report === "string" ? report : JSON.stringify(report)}`;
}

const MATRIX_UNCONFIRMED_REASONS: Record<string, string> = {
	"spawn failure with exact envelope": "process-spawn",
	"timeout with exact envelope": "process-timeout",
	"killed process with exact envelope": "process-killed",
	"signal termination with exact envelope": "process-signal",
	"truncated exact envelope": "process-truncated",
	"cap-killed truncated envelope": "process-truncated",
	"capped then timed-out envelope": "process-timeout",
	"capped then aborted envelope": "process-killed",
	"status zero with exact envelope": "status-zero",
	"other nonzero status with exact envelope": "status-other",
	"null status with exact envelope": "status-null",
	"nonempty stderr with exact envelope": "stderr-nonempty",
	"near banner": "banner-near",
	"missing banner": "banner-missing",
	"unknown JSON key": "json-unknown-key",
	"missing captured JSON key": "json-missing-key",
	"diagnostics has the wrong type": "json-known-field-invalid",
	"number_of_files has the wrong type": "json-known-field-invalid",
	"number_of_files is out of range": "json-known-field-invalid",
	"number_of_rules has the wrong type": "json-known-field-invalid",
	"number_of_rules is out of range": "json-known-field-invalid",
	"threads_count is out of range": "json-known-field-invalid",
	"threads_count has the wrong type": "json-known-field-invalid",
	"start_time has the wrong type": "json-known-field-invalid",
	"start_time is out of range": "json-known-field-invalid",
	"malformed JSON after exact banner": "json-malformed",
	"nonempty diagnostics with zero files": "diagnostics-nonempty",
	"nonzero file count after exact banner": "files-nonzero",
};

// `importOriginal`, not a bare stub: the cap-kill row below builds the REAL
// truncation result, and that needs safe-spawn's own `SpawnFailureError`.
vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawn,
	safeSpawnAsync,
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool,
}));

vi.mock("../../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

vi.mock("../../../../clients/dispatch/runners/utils/runner-helpers.js", () => ({
	resolveToolCommand: vi.fn(() => null),
	resolveToolCommandWithInstallFallback: vi.fn(async (_cwd: string) => {
		const installed = await ensureTool("oxlint");
		return installed ?? null;
	}),
}));

function createCtx(filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd);
}

describe("oxlint runner", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		ensureTool.mockReset();
		logLatency.mockReset();
		ensureTool.mockResolvedValue("oxlint");
		// Simulate oxlint not being available on PATH/venv so ensureTool path is used.
		safeSpawn.mockReturnValue({ error: new Error("not found"), status: 1 });
	});

	it("keeps expected runner skip reasons on a closed type/runtime taxonomy", () => {
		expect(RUNNER_SKIP_REASONS).toEqual(["no-files-matched"]);
		const valid: RunnerResult = {
			status: "skipped",
			diagnostics: [],
			semantic: "none",
			skipReason: "no-files-matched",
		};
		expect(valid.skipReason).toBe("no-files-matched");

		const invalid: RunnerResult = {
			status: "skipped",
			diagnostics: [],
			semantic: "none",
			// @ts-expect-error free text is not an admitted telemetry reason
			skipReason: "ignored because someone felt like it",
		};
		expect(invalid.skipReason).toBe("ignored because someone felt like it");
	});

	it.each([
		{
			name: "exact captured envelope",
			result: {
				error: null,
				status: 1,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "",
			},
			expectedStatus: "skipped",
			expectedSkipReason: "no-files-matched",
		},
		{
			name: "spawn failure with exact envelope",
			result: {
				error: new Error("spawn failed"),
				failure: "spawn",
				status: null,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "",
			},
			expectedStatus: "skipped",
			expectedDegradation: "runner-empty-result",
		},
		{
			name: "timeout with exact envelope",
			result: {
				error: new Error("Process timed out after 30000ms"),
				failure: "timeout",
				status: null,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "",
			},
			expectedStatus: "skipped",
			expectedDegradation: "runner-empty-result",
		},
		{
			name: "killed process with exact envelope",
			result: {
				error: new Error("Spawn aborted"),
				failure: "aborted",
				status: null,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "",
			},
			expectedStatus: "skipped",
			expectedDegradation: "runner-empty-result",
		},
		{
			name: "signal termination with exact envelope",
			result: {
				error: new Error("Process killed by signal: SIGTERM"),
				failure: "signal",
				signal: "SIGTERM" as NodeJS.Signals,
				status: null,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "",
			},
			expectedStatus: "skipped",
			expectedDegradation: "runner-empty-result",
		},
		{
			name: "truncated exact envelope",
			result: {
				error: null,
				status: 1,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "",
				outputTruncated: true,
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "cap-killed truncated envelope",
			result: capKilledSpawnResult({ stdout: CAPTURED_NO_FILES_STDOUT }),
			expectedStatus: "skipped",
			expectedDegradation: "runner-empty-result",
		},
		{
			name: "capped then timed-out envelope",
			result: capThenTimedOutSpawnResult({
				stdout: CAPTURED_NO_FILES_STDOUT,
			}),
			expectedStatus: "skipped",
			expectedDegradation: "runner-empty-result",
		},
		{
			name: "capped then aborted envelope",
			result: capThenAbortedSpawnResult({
				stdout: CAPTURED_NO_FILES_STDOUT,
			}),
			expectedStatus: "skipped",
			expectedDegradation: "runner-empty-result",
		},
		{
			name: "status zero with exact envelope",
			result: {
				error: null,
				status: 0,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "",
			},
			expectedStatus: "failed",
			expectedFailureKind: "unconfirmed_output",
		},
		{
			name: "other nonzero status with exact envelope",
			result: {
				error: null,
				status: 2,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "null status with exact envelope",
			result: {
				error: null,
				status: null,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "",
			},
			expectedStatus: "skipped",
			expectedDegradation: "runner-empty-result",
		},
		{
			name: "nonempty stderr with exact envelope",
			result: {
				error: null,
				status: 1,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "Error: invalid configuration\n",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "near banner",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope(
					CANONICAL_NO_FILES_REPORT,
					"No files found to lint. Check paths and ignores.",
				),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "missing banner",
			result: {
				error: null,
				status: 1,
				stdout: JSON.stringify(CANONICAL_NO_FILES_REPORT),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "unknown JSON key",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope({
					...CANONICAL_NO_FILES_REPORT,
					error: "invalid config",
				}),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "missing captured JSON key",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope({
					diagnostics: [],
					number_of_files: 0,
					number_of_rules: 96,
					threads_count: 16,
				}),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "diagnostics has the wrong type",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope({
					...CANONICAL_NO_FILES_REPORT,
					diagnostics: {},
				}),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "number_of_files has the wrong type",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope({
					...CANONICAL_NO_FILES_REPORT,
					number_of_files: "0",
				}),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "number_of_files is out of range",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope({
					...CANONICAL_NO_FILES_REPORT,
					number_of_files: -1,
				}),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "number_of_rules has the wrong type",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope({
					...CANONICAL_NO_FILES_REPORT,
					number_of_rules: "96",
				}),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "number_of_rules is out of range",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope({
					...CANONICAL_NO_FILES_REPORT,
					number_of_rules: -1,
				}),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "threads_count is out of range",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope({
					...CANONICAL_NO_FILES_REPORT,
					threads_count: 0,
				}),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "threads_count has the wrong type",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope({
					...CANONICAL_NO_FILES_REPORT,
					threads_count: "16",
				}),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "start_time has the wrong type",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope({
					...CANONICAL_NO_FILES_REPORT,
					start_time: "0.009533",
				}),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "start_time is out of range",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope({
					...CANONICAL_NO_FILES_REPORT,
					start_time: -0.1,
				}),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "malformed JSON after exact banner",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope('{ "diagnostics": [], "number_of_files": 0'),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "nonempty diagnostics with zero files",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope({
					...CANONICAL_NO_FILES_REPORT,
					diagnostics: [{ message: "invalid config" }],
				}),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "nonzero file count after exact banner",
			result: {
				error: null,
				status: 1,
				stdout: noFilesEnvelope({
					...CANONICAL_NO_FILES_REPORT,
					number_of_files: 1,
				}),
				stderr: "",
			},
			expectedStatus: "failed",
			expectedDegradation: "runner-parsed-nothing",
		},
		{
			name: "ordinary matched clean report",
			result: {
				error: null,
				status: 0,
				stdout: JSON.stringify({ diagnostics: [], number_of_files: 1 }),
				stderr: "",
			},
			expectedStatus: "succeeded",
		},
	])(
		"classifies the no-files state matrix: $name",
		async ({
			name,
			result: spawnResult,
			expectedStatus,
			expectedSkipReason,
			expectedDegradation,
			expectedFailureKind,
		}) => {
			const env = setupTestEnvironment(
				`pi-lens-oxlint-matrix-${name.replace(/[^a-z0-9]+/gi, "-")}-`,
			);
			try {
				const filePath = path.join(env.tmpDir, "sample.ts");
				fs.writeFileSync(filePath, "const value = 1;\n");
				safeSpawnAsync.mockResolvedValueOnce(spawnResult);
				const runnerModule =
					await import("../../../../clients/dispatch/runners/oxlint.js");
				const decision = runnerModule.decideOxlintNoFiles(
					spawnResult,
					spawnResult.stdout,
					spawnResult.stderr,
				);
				const expectedDecision = expectedSkipReason
					? { kind: "expected-no-files" }
					: expectedStatus === "succeeded"
						? { kind: "ordinary-report" }
						: {
								kind: "unconfirmed-no-files",
								reason: MATRIX_UNCONFIRMED_REASONS[name],
							};
				if (!expectedSkipReason && expectedStatus !== "succeeded") {
					expect(MATRIX_UNCONFIRMED_REASONS[name]).toBeDefined();
				}
				expect(decision).toEqual(expectedDecision);

				const runner = runnerModule.default;
				const outcome = await runner.run({
					...createCtx(filePath, env.tmpDir),
					hasTool: async () => false,
				} as never);

				expect(outcome.status).toBe(expectedStatus);
				expect(outcome.skipReason).toBe(expectedSkipReason);
				expect(outcome.failureKind).toBe(expectedFailureKind);
				const degradationKinds = logLatency.mock.calls
					.map(
						([entry]) =>
							entry as { phase?: string; metadata?: { kind?: string } },
					)
					.filter((entry) => entry.phase === "degradation_ledger")
					.map((entry) => entry.metadata?.kind);
				if (expectedDegradation) {
					expect(degradationKinds).toContain(expectedDegradation);
				} else {
					expect(degradationKinds).toEqual([]);
				}
			} finally {
				env.cleanup();
			}
		},
	);

	it("does not skip test files (#576) — real correctness findings matter there too", async () => {
		const { default: oxlintRunner } =
			await import("../../../../clients/dispatch/runners/oxlint.js");
		expect(oxlintRunner.skipTestFiles).toBe(false);
	});

	it("auto-installs and runs oxlint as the no-config JS/TS fallback", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-runner-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "console.log('hi')\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					diagnostics: [
						{
							message: "Unexpected console statement",
							code: "eslint(no-console)",
							severity: "warning",
							help: "Replace console.log with a logger",
							filename: filePath,
							labels: [{ span: { line: 1, column: 1 } }],
						},
					],
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;

			// hasTool returns false → triggers resolveToolCommandWithInstallFallback → ensureTool
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			expect(ensureTool).toHaveBeenCalledWith("oxlint");
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"oxlint",
				expect.arrayContaining(["--format", "json", filePath]),
				// #2100: the cap is what makes `outputTruncated` reachable at all.
				expect.objectContaining({
					timeout: 30000,
					maxOutputBytes: 8 * 1024 * 1024,
				}),
			);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]).toMatchObject({
				tool: "oxlint",
				rule: "no-console",
				line: 1,
				fixSuggestion: "Replace console.log with a logger",
			});
		} finally {
			env.cleanup();
		}
	});

	// #2691: the lint spawn passed no `cwd`, so a nested oxlint config was
	// resolved against the extension host's `process.cwd()` instead of
	// `ctx.cwd` -- same shape as #1731 (sqlfluff) and #2691's own yamllint.
	it("spawns the lint with the dispatch context's cwd, not the host's (#2691)", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-cwd-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "console.log('hi')\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 0,
				stdout: JSON.stringify({ diagnostics: [] }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;

			await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"oxlint",
				expect.arrayContaining(["--format", "json", filePath]),
				expect.objectContaining({ cwd: env.tmpDir }),
			);
		} finally {
			env.cleanup();
		}
	});

	it("reports exit-0 warning findings as succeeded, not failed (#1947, #1955 review F1)", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-warning-exit-zero-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const unused = 1;\n");

			// oxlint exits 0 whenever nothing reaches error severity, so a
			// warning-only report — its default severity — arrives at exit 0.
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 0,
				stdout: JSON.stringify({
					diagnostics: [
						{
							message: "Variable 'unused' is declared but never used",
							code: "eslint(no-unused-vars)",
							severity: "warning",
							help: "Consider removing this declaration",
							filename: filePath,
							labels: [{ span: { line: 1, column: 7 } }],
						},
					],
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			// status MUST be "succeeded", not "failed": plan.ts's
			// ["eslint", "oxlint", "biome-check-json"] fallback group
			// (dispatcher.ts runGroup) only stops at the first runner reporting
			// `status: "succeeded"`. A "failed" status here would let
			// biome-check-json run again on the same file for a mere warning —
			// extra spawns, a possible install, duplicate findings.
			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]).toMatchObject({
				tool: "oxlint",
				rule: "no-unused-vars",
				severity: "warning",
				semantic: "warning",
			});
		} finally {
			env.cleanup();
		}
	});

	it("a warning-only exit-0 run stops plan.ts's jsts fallback group at oxlint (#1955 review F1)", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-fallback-stop-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const unused = 1;\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: JSON.stringify({
					diagnostics: [
						{
							message: "Variable 'unused' is declared but never used",
							code: "eslint(no-unused-vars)",
							severity: "warning",
							filename: filePath,
							labels: [{ span: { line: 1, column: 7 } }],
						},
					],
				}),
				stderr: "",
			});

			const oxlintRunner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const { dispatchForFile, RunnerRegistry } =
				await import("../../../../clients/dispatch/dispatcher.js");

			// eslint has no config in this workspace, so the real eslint runner
			// would skip — stand in with the same status so the fallback chain
			// reaches oxlint exactly as plan.ts's
			// ["eslint", "oxlint", "biome-check-json"] group would.
			const biomeCalls: number[] = [];
			const registry = new RunnerRegistry();
			registry.register({
				id: "eslint",
				appliesTo: ["jsts"],
				priority: 1,
				async run() {
					return { status: "skipped", diagnostics: [], semantic: "none" };
				},
			});
			registry.register({ ...oxlintRunner, priority: 2 });
			registry.register({
				id: "biome-check-json",
				appliesTo: ["jsts"],
				priority: 3,
				async run() {
					biomeCalls.push(Date.now());
					return { status: "succeeded", diagnostics: [], semantic: "none" };
				},
			});

			const groups: RunnerGroup[] = [
				{
					mode: "fallback",
					runnerIds: ["eslint", "oxlint", "biome-check-json"],
				},
			];
			const ctx = {
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			};

			const result = await dispatchForFile(ctx as never, groups, registry);

			// The regression this pins: a "failed" status on oxlint's warning-only
			// exit-0 result would NOT stop a fallback group (dispatcher.ts's
			// runGroup only stops at "succeeded"), so biome-check-json would run
			// too — extra spawns, a possible install, duplicate findings.
			expect(biomeCalls).toHaveLength(0);
			expect(result.warnings.some((w) => w.tool === "oxlint")).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("skips when ESLint is explicitly configured", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-eslint-config-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const x = 1\n");
			fs.writeFileSync(path.join(env.tmpDir, ".eslintrc.json"), "{}\n");

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("skipped");
			expect(ensureTool).not.toHaveBeenCalled();
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("falls back to plain oxlint when Vite+ is configured but vp is not installed", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-vite-plus-fallback-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "console.log('hi')\n");
			fs.writeFileSync(
				path.join(env.tmpDir, "package.json"),
				JSON.stringify({ devDependencies: { "vite-plus": "^0.1.0" } }),
			);

			// First call: vp --version (not found)
			// Second call: oxlint --format unix <file> (success, no issues)
			safeSpawnAsync
				.mockResolvedValueOnce({
					error: new Error("not found"),
					status: 1,
					stdout: "",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "",
					stderr: "",
				});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"vp",
				["--version"],
				expect.objectContaining({ timeout: 5000 }),
			);
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"oxlint",
				expect.arrayContaining(["--format", "json", filePath]),
				// #2100: the cap is what makes `outputTruncated` reachable at all.
				expect.objectContaining({
					timeout: 30000,
					maxOutputBytes: 8 * 1024 * 1024,
				}),
			);
			expect(result.status).toBe("succeeded");
		} finally {
			env.cleanup();
		}
	});

	/**
	 * #2514 / #2544 review F1, through the real runner.
	 *
	 * `resolveLocalVp` was a private, UNCEILINGED copy of the shared bin walk,
	 * while `formatters.ts`'s `oxfmtFormatter` resolved the SAME binary — `vp` —
	 * through the ceilinged `findInNodeModules`. So one `vp` resolver stopped at
	 * `$HOME` and the other climbed past it, and which policy applied depended
	 * on whether the format path or the lint path asked. A
	 * `node_modules/.bin/vp` at or above `$HOME` can never be this project's own
	 * Vite+ install: it is the home-level pi-extensions manifest's own bin.
	 *
	 * Two-sided on purpose — the run must fall through to the `vp --version`
	 * PATH probe (the "vp is not installed" branch above), not merely skip.
	 */
	it("does not resolve a vp planted at HOME as the project's Vite+ binary (#2514)", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-vp-home-ceiling-");
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		try {
			const fakeHome = env.tmpDir;
			const projectDir = path.join(fakeHome, "project");
			fs.mkdirSync(projectDir, { recursive: true });
			const filePath = path.join(projectDir, "sample.ts");
			fs.writeFileSync(filePath, "console.log('hi')\n");
			fs.writeFileSync(
				path.join(projectDir, "package.json"),
				JSON.stringify({ devDependencies: { "vite-plus": "^0.1.0" } }),
			);

			const homeBinDir = path.join(fakeHome, "node_modules", ".bin");
			fs.mkdirSync(homeBinDir, { recursive: true });
			const homeVpCmd = path.join(homeBinDir, "vp.cmd");
			const homeVp = path.join(homeBinDir, "vp");
			fs.writeFileSync(homeVpCmd, "@ECHO off\r\n");
			fs.writeFileSync(homeVp, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;

			// vp --version (not found), then oxlint (clean).
			safeSpawnAsync
				.mockResolvedValueOnce({
					error: new Error("not found"),
					status: 1,
					stdout: "",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "",
					stderr: "",
				});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run(createCtx(filePath, projectDir) as never);

			const spawned = safeSpawnAsync.mock.calls.map((call) => call[0]);
			expect(spawned).not.toContain(homeVpCmd);
			expect(spawned).not.toContain(homeVp);
			// Pre-fix the home-level bin WAS the resolved command, so the PATH
			// probe never happened at all.
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"vp",
				["--version"],
				expect.objectContaining({ timeout: 5000 }),
			);
			expect(result.status).toBe("succeeded");
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			env.cleanup();
		}
	});

	it("promotes severity=error diagnostics to blocking semantic", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-error-promotion-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "debugger;\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					diagnostics: [
						{
							message: "`debugger` statement is not allowed",
							code: "eslint(no-debugger)",
							severity: "error",
							help: "Remove the debugger statement",
							filename: filePath,
							labels: [{ span: { line: 1, column: 1 } }],
						},
					],
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]).toMatchObject({
				severity: "error",
				semantic: "blocking",
				rule: "no-debugger",
				fixSuggestion: "Remove the debugger statement",
			});
		} finally {
			env.cleanup();
		}
	});

	it("falls back to unix-format parsing when oxlint emits non-JSON output", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-fallback-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "console.log('hi')\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: `${filePath}:1:1: Unexpected console statement (no-console)\n`,
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			expect(result.status).toBe("failed");
			expect(result.diagnostics[0]).toMatchObject({
				tool: "oxlint",
				rule: "no-console",
				line: 1,
			});
			// Unix fallback has no fix info — fixSuggestion is absent here.
			expect(result.diagnostics[0].fixSuggestion).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("keeps a matched clean file distinct from a no-files skip", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-clean-match-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 0,
				stdout: JSON.stringify({ diagnostics: [], number_of_files: 1 }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const log = vi.fn();
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
				log,
			} as never);

			expect(result).toMatchObject({
				status: "succeeded",
				semantic: "none",
				diagnostics: [],
			});
			expect(result.skipReason).toBeUndefined();
			expect(log).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("keeps nonzero garbage as a failure, not a no-files skip", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-garbage-failure-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: "oxlint: internal failure, report unavailable\n",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			expect(result.status).toBe("failed");
			expect(result.skipReason).toBeUndefined();
			expect(result.diagnostics[0]).toMatchObject({
				semantic: "warning",
				message: expect.stringContaining("could not be parsed"),
			});
		} finally {
			env.cleanup();
		}
	});

	it("does not trust number_of_files=0 inside an error report", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-zero-files-error-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					diagnostics: [],
					number_of_files: 0,
					error: "invalid config",
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			expect(result.status).toBe("failed");
			expect(result.skipReason).toBeUndefined();
			expect(result.diagnostics[0]?.message).toContain("could not be parsed");
			expect(logLatency).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "degradation_ledger",
					metadata: expect.objectContaining({
						kind: "runner-parsed-nothing",
						subject: "oxlint",
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("does not suppress stderr accompanying an otherwise expected no-files report", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-zero-files-stderr-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout:
					"No files found to lint. Please check your paths and ignore patterns.\n" +
					'{ "diagnostics": [], "number_of_files": 0 }',
				stderr: "Error: invalid configuration\n",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			expect(result.status).toBe("failed");
			expect(result.skipReason).toBeUndefined();
			expect(result.diagnostics[0]?.message).toContain("could not be parsed");
			expect(logLatency).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "degradation_ledger",
					metadata: expect.objectContaining({
						kind: "runner-parsed-nothing",
						subject: "oxlint",
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("reports a config-excluded file as skipped, not succeeded (dogfood #1985 review F2b/R2)", async () => {
		// Nested-config discovery means a file under a directory with its own
		// `.oxlintrc.json` ignorePatterns — or covered by a parent config's
		// ignorePatterns — makes oxlint report `number_of_files: 0` and an empty
		// `diagnostics` array. That is the SAME shape as a genuinely clean file:
		// zero diagnostics. Without reading `number_of_files`, "config excluded
		// this file" and "this file has no findings" are indistinguishable — the
		// AGENTS.md empty-result invariant (an empty result must distinguish
		// clean from errored/excluded).
		//
		// #1985 review round 2: a hand-built `JSON.stringify({...})` double
		// passed against a parser that bailed on real bytes, because real
		// oxlint prints a "No files found to lint." BANNER LINE to stdout
		// BEFORE the JSON when `number_of_files` is 0 — the #1946 fixture
		// discipline exists for exactly this gap. This is the VERBATIM stdout
		// `npx oxlint@1.79.0 --format json <excluded-file>` produced (exit 1,
		// stderr empty), captured against a real `.oxlintrc.json` with
		// `ignorePatterns` covering the target file.
		const env = setupTestEnvironment("pi-lens-oxlint-excluded-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const unused = 1;\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const log = vi.fn();
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
				log,
			} as never);

			expect(result.status).toBe("skipped");
			expect(result.skipReason).toBe("no-files-matched");
			expect(result.semantic).toBe("none");
			expect(result.diagnostics).toHaveLength(0);
			// The existing latency runner record carries the structured skip reason.
			// This expected policy outcome must not enter the extension error log.
			expect(log).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("does not let a timed-out partial report masquerade as a no-files skip", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-timeout-partial-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			safeSpawnAsync.mockResolvedValueOnce({
				error: new Error("Process timed out after 30000ms"),
				failure: "timeout",
				status: null,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const result = await runner.run({
				...createCtx(filePath, env.tmpDir),
				hasTool: async () => false,
			} as never);

			// The shared #1994 outcome gate owns process failures. It records the
			// degradation and returns an unconfirmed skip, never the expected-policy
			// reason that would suppress failure accounting.
			expect(result.status).toBe("skipped");
			expect(result.skipReason).toBeUndefined();
			expect(logLatency).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "degradation_ledger",
					metadata: expect.objectContaining({
						kind: "runner-empty-result",
						subject: "oxlint",
					}),
				}),
			);
		} finally {
			env.cleanup();
		}
	});

	it("carries the no-files reason through existing runner telemetry", async () => {
		const env = setupTestEnvironment("pi-lens-oxlint-skip-telemetry-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: CAPTURED_NO_FILES_STDOUT,
				stderr: "",
			});

			const oxlintRunner = (
				await import("../../../../clients/dispatch/runners/oxlint.js")
			).default;
			const {
				clearLatencyReports,
				dispatchForFile,
				getLatencyReports,
				RunnerRegistry,
			} = await import("../../../../clients/dispatch/dispatcher.js");
			clearLatencyReports();
			const registry = new RunnerRegistry();
			registry.register(oxlintRunner);
			const extensionLog = vi.fn();

			await dispatchForFile(
				{
					...createCtx(filePath, env.tmpDir),
					hasTool: async () => false,
					log: extensionLog,
				} as never,
				[{ mode: "all", runnerIds: ["oxlint"] }],
				registry,
			);

			const report = getLatencyReports().at(-1);
			expect(report?.runners).toContainEqual(
				expect.objectContaining({
					runnerId: "oxlint",
					status: "skipped",
					skipReason: "no-files-matched",
				}),
			);
			const runnerRow = logLatency.mock.calls
				.map(([entry]) => entry as Record<string, unknown>)
				.find(
					(entry) => entry.type === "runner" && entry.runnerId === "oxlint",
				);
			expect(runnerRow).toMatchObject({
				status: "skipped",
				metadata: { skipReason: "no-files-matched" },
			});
			expect(
				logLatency.mock.calls.some(
					([entry]) =>
						(entry as { phase?: string }).phase === "degradation_ledger",
				),
			).toBe(false);
			expect(extensionLog).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("rejects untyped free-text skip reasons at the latency boundary", async () => {
		const env = setupTestEnvironment("pi-lens-runner-skip-reason-boundary-");
		try {
			const filePath = path.join(env.tmpDir, "sample.ts");
			fs.writeFileSync(filePath, "const value = 1;\n");
			const {
				clearLatencyReports,
				dispatchForFile,
				getLatencyReports,
				RunnerRegistry,
			} = await import("../../../../clients/dispatch/dispatcher.js");
			clearLatencyReports();
			const registry = new RunnerRegistry();
			registry.register({
				id: "malformed-skip",
				appliesTo: ["jsts"],
				priority: 1,
				async run() {
					return {
						status: "skipped",
						diagnostics: [],
						semantic: "none",
						skipReason: "free text from an untyped plugin",
					} as never;
				},
			});

			await dispatchForFile(
				createCtx(filePath, env.tmpDir) as never,
				[{ mode: "all", runnerIds: ["malformed-skip"] }],
				registry,
			);

			const latency = getLatencyReports().at(-1)?.runners.at(-1);
			expect(latency).toMatchObject({
				runnerId: "malformed-skip",
				status: "skipped",
			});
			expect(latency).not.toHaveProperty("skipReason");
			const runnerRow = logLatency.mock.calls
				.map(([entry]) => entry as Record<string, unknown>)
				.find(
					(entry) =>
						entry.type === "runner" && entry.runnerId === "malformed-skip",
				);
			expect(runnerRow).not.toHaveProperty("metadata.skipReason");
		} finally {
			env.cleanup();
		}
	});
});
