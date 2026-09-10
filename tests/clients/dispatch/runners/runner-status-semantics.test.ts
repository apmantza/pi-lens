import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";
import { makeLspServiceDouble } from "../../../support/lsp-service-double.js";

const safeSpawnAsync = vi.fn();
const safeSpawn = vi.fn();
const tryLazyInstall = vi.fn(async () => true);
const supportsLSP = vi.fn();
const hasLSP = vi.fn();
const openFile = vi.fn();
const touchFile = vi.fn();
const getDiagnostics = vi.fn();
const codeAction = vi.fn();

// #1179: `touchFile` now resolves the `{ diags, inconclusive, binding }` wrapper
// (shape-5 structural fix) — wrap a mocked diagnostics array in the same shape.
const diagsResult = (
	diags: unknown[],
	extra: {
		inconclusive?: boolean;
		// #1470: the narrowed confirmation an aux cut off by the grace timer
		// produces — the touch is NOT inconclusive, but it no longer speaks for
		// the named servers.
		confirmation?: "confirmed" | "partial";
		unconfirmedServerIds?: string[];
		deferredServerIds?: string[];
	} = {},
) => ({ diags, ...extra });
const readFileContent = vi.fn(() => "const x = 1;\n");
const warmAttach = vi.hoisted(() => ({
	diagnostics: vi.fn(),
	codeActions: vi.fn(),
}));

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn,
	safeSpawnAsync,
}));

vi.mock("../../../../clients/dispatch/runners/utils/lazy-installer.js", () => ({
	tryLazyInstall,
}));

vi.mock("../../../../clients/lsp/index.js", () => ({
	getLSPService: () =>
		makeLspServiceDouble({
			supportsLSP,
			hasLSP,
			openFile,
			touchFile,
			getDiagnostics,
			codeAction,
			getClientForFile: vi.fn(),
		}),
}));

vi.mock("../../../../clients/dispatch/runners/utils.js", () => ({
	readFileContent,
}));

vi.mock("../../../../clients/warm-attach.js", () => ({
	tryWarmAttachedDiagnostics: warmAttach.diagnostics,
	tryWarmAttachedCodeActions: warmAttach.codeActions,
}));

function ctx(
	filePath: string,
	cwd: string,
	overrides: { fileRole?: string } = {},
) {
	return {
		filePath,
		cwd,
		kind: "jsts",
		fileRole: overrides.fileRole ?? "source",
		pi: {
			getFlag: (name: string) => name === "lens-lsp",
		},
		autofix: false,
		deltaMode: true,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

describe("runner status/semantic edge cases", () => {
	beforeEach(() => {
		safeSpawn.mockReset();
		safeSpawnAsync.mockReset();
		tryLazyInstall.mockClear();
		supportsLSP.mockReset();
		hasLSP.mockReset();
		openFile.mockReset();
		touchFile.mockReset();
		getDiagnostics.mockReset();
		codeAction.mockReset();
		readFileContent.mockReset();
		readFileContent.mockReturnValue("const x = 1;\n");
		supportsLSP.mockReturnValue(true);
		warmAttach.diagnostics.mockReset();
		warmAttach.codeActions.mockReset();
		warmAttach.diagnostics.mockResolvedValue(undefined);
	});

	it("golangci-lint returns failed/blocking for error diagnostics", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/golangci-lint.js")
		).default;
		const env = setupTestEnvironment("pi-lens-go-");
		try {
			const filePath = path.join(env.tmpDir, "main.go");
			fs.writeFileSync(
				path.join(env.tmpDir, ".golangci.yml"),
				"run:\n  timeout: 1m\n",
			);
			fs.writeFileSync(filePath, "package main\n");

			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 0,
				stdout: "ok",
				stderr: "",
			});
			safeSpawnAsync.mockResolvedValueOnce({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					Issues: [
						{
							FromLinter: "govet",
							Text: "suspicious",
							Severity: "error",
							Pos: { Filename: filePath, Line: 2, Column: 1 },
						},
					],
				}),
				stderr: "",
			});

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
		} finally {
			env.cleanup();
		}
	});

	it("rust-clippy returns warning semantic for non-parseable output", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/rust-clippy.js")
		).default;
		const env = setupTestEnvironment("pi-lens-rs-");
		try {
			const cargoToml = path.join(env.tmpDir, "Cargo.toml");
			const filePath = path.join(env.tmpDir, "src", "main.rs");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(cargoToml, "[package]\nname='demo'\nversion='0.1.0'\n");
			fs.writeFileSync(filePath, "fn main() {}\n");

			safeSpawnAsync
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "cargo",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "clippy",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 1,
					stdout: "cargo clippy failed without json",
					stderr: "",
				});

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
		} finally {
			env.cleanup();
		}
	});

	it("rubocop returns failed/blocking for error offenses", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/rubocop.js")
		).default;
		const env = setupTestEnvironment("pi-lens-rb-");
		try {
			const filePath = path.join(env.tmpDir, "main.rb");
			fs.writeFileSync(filePath, "puts 'hi'\n");

			safeSpawnAsync
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "rubocop",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: 1,
					stdout: JSON.stringify({
						files: [
							{
								path: filePath,
								offenses: [
									{
										severity: "error",
										message: "Style/SomeCop",
										cop_name: "Style/SomeCop",
										correctable: true,
										location: { line: 1, column: 1 },
									},
								],
							},
						],
					}),
					stderr: "",
				});

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner uses bounded document touch instead of unbounded aggregate diagnostics", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-bounded-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			supportsLSP.mockReturnValue(true);
			touchFile.mockResolvedValue(diagsResult([]));

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("succeeded");
			// Bounded touch: primary language server + the enabled auxiliaries
			// (opengrep is default-on) — NOT the unbounded "all"/aggregate path.
			expect(touchFile).toHaveBeenCalledWith(
				filePath,
				"const x = 1;\n",
				expect.objectContaining({
					diagnostics: "document",
					collectDiagnostics: true,
					clientScope: "with-auxiliary",
					auxiliaryServerIds: expect.arrayContaining(["opengrep"]),
					maxClientWaitMs: expect.any(Number),
					source: "dispatch-lsp-runner",
				}),
			);
			expect(getDiagnostics).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner returns skipped (not succeeded) when no client is ready", async () => {
		// touchFile resolves undefined → no LSP client was ready (cold/unavailable).
		// Reporting "succeeded, 0 diagnostics" would read as a clean result; the
		// runner must report "skipped" so the gap is flagged instead.
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-cold-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			supportsLSP.mockReturnValue(true);
			touchFile.mockResolvedValue(undefined);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner returns skipped (not succeeded) when the touch is inconclusive (timed out) (#570)", async () => {
		// touchFile resolves an array flagged `inconclusive` — the notify write
		// and/or diagnostics wait hit their deadline without the server
		// confirming completion. Reporting "succeeded, 0 diagnostics" here would
		// read as a confirmed clean bill of health when the check simply never
		// completed; the runner must report "skipped" (same treatment as the
		// no-client-ready case) so the coverage notice flags the gap.
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-inconclusive-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			supportsLSP.mockReturnValue(true);
			// #1179: empty `.diags` but `inconclusive: true` — an unconfirmed touch
			// (notify/diagnostics wait lapsed). The flag is now an explicit enumerable
			// wrapper field, so it survives any copy of `.diags` by construction.
			touchFile.mockResolvedValue(diagsResult([], { inconclusive: true }));

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner returns skipped for an EMPTY result whose auxiliary was cut off (#1470)", async () => {
		// The practical shape from #1470: opengrep hangs, our grace timer cuts it
		// off, the primary answers clean. The touch is deliberately NOT
		// inconclusive (the primary's answer is real), so the pre-fix runner
		// reported "succeeded / no-diagnostics" — a clean bill of health on the
		// security lane for a scan that never ran. `RunnerResult` has no
		// per-server coverage channel, so "skipped" is the honest verdict for an
		// EMPTY result and the coverage notice says so.
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-cutoff-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			supportsLSP.mockReturnValue(true);
			touchFile.mockResolvedValue(
				diagsResult([], {
					confirmation: "partial",
					unconfirmedServerIds: ["opengrep"],
				}),
			);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("renders a silenced scanner coverage marker once without claiming an empty touch is clean (#1867)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const { clearCoverageNoticeState, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const env = setupTestEnvironment("pi-lens-lsp-agent-coverage-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			clearCoverageNoticeState();
			touchFile
				.mockResolvedValueOnce(
					diagsResult([], {
						confirmation: "partial",
						unconfirmedServerIds: ["opengrep"],
					}),
				)
				.mockResolvedValueOnce(
					diagsResult([], {
						confirmation: "partial",
						unconfirmedServerIds: ["opengrep"],
					}),
				)
				.mockResolvedValueOnce(
					diagsResult([], {
						confirmation: "partial",
						unconfirmedServerIds: ["ast-grep"],
					}),
				);
			const registry = new RunnerRegistry();
			registry.register(runner);
			const groups = [{ mode: "all" as const, runnerIds: ["lsp"] }];

			const first = await dispatchForFile(
				ctx(filePath, env.tmpDir) as never,
				groups,
				registry,
			);
			expect(first.output).toContain("coverage: opengrep silent");
			expect(first.output).toContain("not a clean result");

			const repeated = await dispatchForFile(
				ctx(filePath, env.tmpDir) as never,
				groups,
				registry,
			);
			expect(repeated.output).not.toContain("coverage: opengrep silent");

			const changed = await dispatchForFile(
				ctx(filePath, env.tmpDir) as never,
				groups,
				registry,
			);
			expect(changed.output).toContain("coverage: ast-grep silent");
		} finally {
			env.cleanup();
		}
	});

	it("renders a primary diagnostic and its scanner coverage marker together (#1867 F2)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const { clearCoverageNoticeState, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const env = setupTestEnvironment("pi-lens-lsp-agent-coverage-primary-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			clearCoverageNoticeState();
			codeAction.mockResolvedValue([]);
			touchFile.mockResolvedValue(
				diagsResult(
					[
						{
							severity: 1,
							message: "Type error",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 5 },
							},
						},
					],
					{ confirmation: "partial", unconfirmedServerIds: ["opengrep"] },
				),
			);
			const registry = new RunnerRegistry();
			registry.register(runner);
			const result = await dispatchForFile(
				ctx(filePath, env.tmpDir) as never,
				[{ mode: "all" as const, runnerIds: ["lsp"] }],
				registry,
			);
			expect(result.output).toContain("Type error");
			expect(result.output).toContain("coverage: opengrep silent");
		} finally {
			env.cleanup();
		}
	});

	it("names deferred and silent scanners separately in one coverage notice (#2810)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const { clearCoverageNoticeState, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const env = setupTestEnvironment("pi-lens-lsp-mixed-coverage-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			clearCoverageNoticeState();
			touchFile.mockResolvedValue(
				diagsResult([], {
					confirmation: "partial",
					unconfirmedServerIds: ["typos", "zizmor"],
					deferredServerIds: ["typos"],
				}),
			);
			const registry = new RunnerRegistry();
			registry.register(runner);
			const result = await dispatchForFile(
				ctx(filePath, env.tmpDir) as never,
				[{ mode: "all" as const, runnerIds: ["lsp"] }],
				registry,
			);
			expect(result.output).toContain("coverage: typos deferred");
			expect(result.output).toContain("coverage: zizmor silent");
			expect(result.output).not.toContain("zizmor deferred");
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner still reports the PRIMARY's findings when only an auxiliary was cut off (#1470)", async () => {
		// The other half of the narrowing: collapsing a partial touch to
		// skipped/inconclusive across the board would discard a trustworthy
		// primary answer. Real findings must still reach the agent.
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-cutoff-findings-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			supportsLSP.mockReturnValue(true);
			codeAction.mockResolvedValue([]);
			touchFile.mockResolvedValue(
				diagsResult(
					[
						{
							severity: 1,
							message: "Type error",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 5 },
							},
						},
					],
					{ confirmation: "partial", unconfirmedServerIds: ["opengrep"] },
				),
			);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.failureKind).toBe("blocking_diagnostics");
			expect(result.diagnostics[0]?.message).toContain("Type error");
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner returns skipped for a warm-attached EMPTY result whose auxiliary was cut off (#1470)", async () => {
		// The same #1470 shape as the incumbent-touch test above, but on the
		// warm-attach IPC route: `available: true` with an empty diagnostics
		// array and `unconfirmedServerIds` on the response DTO. The wrapper this
		// runner builds from a warm-attach answer must carry that field through
		// to `touchCoverageGap`, not drop it — a hung opengrep must not read as
		// a clean bill of health here either.
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-warm-cutoff-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			warmAttach.diagnostics.mockResolvedValue({
				available: true,
				response: {
					diagnostics: [],
					confirmation: "partial",
					unconfirmedServerIds: ["opengrep"],
				},
			});

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
			expect(touchFile).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner returns warning semantic when server open fails", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			supportsLSP.mockReturnValue(true);
			hasLSP.mockResolvedValue(true);
			touchFile.mockRejectedValue(new Error("connection failed"));
			getDiagnostics.mockResolvedValue([]);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.message).toContain("LSP server failed");
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner surfaces codeAction guidance for blocking diagnostics", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-fix-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const a: string = 1;\n");

			hasLSP.mockResolvedValue(true);
			openFile.mockResolvedValue(undefined);
			touchFile.mockResolvedValue(
				diagsResult([
					{
						severity: 1,
						message: "Type 'number' is not assignable to type 'string'.",
						range: {
							start: { line: 0, character: 6 },
							end: { line: 0, character: 7 },
						},
						code: "2322",
					},
				]),
			);
			codeAction.mockResolvedValue([
				{ title: "Change type of 'a' to 'number'", kind: "quickfix" },
				{ title: "Convert number to string", kind: "quickfix" },
			]);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.fixable).toBe(true);
			expect(result.diagnostics[0]?.fixSuggestion).toContain(
				"LSP quick fixes:",
			);
			expect(result.diagnostics[0]?.fixSuggestion).toContain(
				"Change type of 'a' to 'number'",
			);
		} finally {
			env.cleanup();
		}
	});

	it("enriches warm-attached diagnostics with incumbent quickfixes", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-warm-fix-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const a: string = 1;\n");
			warmAttach.diagnostics.mockResolvedValue({
				available: true,
				response: {
					diagnostics: [
						{
							severity: 1,
							message: "Type mismatch",
							range: {
								start: { line: 0, character: 6 },
								end: { line: 0, character: 7 },
							},
						},
					],
				},
			});
			warmAttach.codeActions.mockResolvedValue({
				available: true,
				response: {
					actions: [[{ title: "Change type", kind: "quickfix" }]],
				},
			});

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);

			expect(result.diagnostics[0]?.fixSuggestion).toContain("Change type");
			expect(touchFile).not.toHaveBeenCalled();
			expect(codeAction).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("keeps warm diagnostics and does not promote when enrichment fails", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-warm-fix-fail-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const a: string = 1;\n");
			warmAttach.diagnostics.mockResolvedValue({
				available: true,
				response: {
					diagnostics: [
						{
							severity: 1,
							message: "Type mismatch",
							range: {
								start: { line: 0, character: 6 },
								end: { line: 0, character: 7 },
							},
						},
					],
				},
			});
			warmAttach.codeActions.mockResolvedValue({
				available: false,
				reason: "timeout",
			});

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);

			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]?.fixSuggestion).toBeUndefined();
			expect(warmAttach.diagnostics).toHaveBeenCalledTimes(1);
			expect(touchFile).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner drops ast-grep auxiliary findings on test files, but keeps opengrep's (#687)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-astgrep-test-skip-");
		try {
			const filePath = path.join(env.tmpDir, "main.test.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			supportsLSP.mockReturnValue(true);
			touchFile.mockResolvedValue(
				diagsResult([
					{
						severity: 2,
						message: "ast-grep finding",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 1 },
						},
						code: "no-javascript-url",
						source: "ast-grep",
					},
					{
						severity: 2,
						message: "opengrep finding",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 1 },
						},
						code: "some-rule",
						source: "Semgrep",
					},
				]),
			);

			const result = await runner.run(
				ctx(filePath, env.tmpDir, { fileRole: "test" }) as never,
			);
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]?.tool).toBe("opengrep");
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner keeps ast-grep auxiliary findings on non-test files", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-astgrep-source-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			supportsLSP.mockReturnValue(true);
			touchFile.mockResolvedValue(
				diagsResult([
					{
						severity: 2,
						message: "ast-grep finding",
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 1 },
						},
						code: "no-javascript-url",
						source: "ast-grep",
					},
				]),
			);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]?.tool).toBe("ast-grep");
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner ignores refactor-only code actions for fix guidance", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-refactor-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const a: string = 1;\n");

			hasLSP.mockResolvedValue(true);
			openFile.mockResolvedValue(undefined);
			touchFile.mockResolvedValue(
				diagsResult([
					{
						severity: 1,
						message: "Type 'number' is not assignable to type 'string'.",
						range: {
							start: { line: 0, character: 6 },
							end: { line: 0, character: 7 },
						},
						code: "2322",
					},
				]),
			);
			codeAction.mockResolvedValue([
				{ title: "Move to a new file", kind: "refactor.move.newFile" },
			]);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics[0]?.fixable).toBe(false);
			expect(result.diagnostics[0]?.fixSuggestion).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("lsp runner looks up codeAction for multiple blocking diagnostics in parallel (#453)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-parallel-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(
				filePath,
				"const a: string = 1;\nconst b: string = 2;\nconst c: string = 3;\n",
			);

			hasLSP.mockResolvedValue(true);
			openFile.mockResolvedValue(undefined);
			touchFile.mockResolvedValue(
				diagsResult(
					[0, 1, 2].map((line) => ({
						severity: 1,
						message: "Type 'number' is not assignable to type 'string'.",
						range: {
							start: { line, character: 6 },
							end: { line, character: 7 },
						},
						code: "2322",
					})),
				),
			);
			// Assert concurrency by observed overlap (max in-flight lookups), not
			// wall-clock — elapsed-time bounds flake under parallel vitest load.
			// Sequential awaits would never have more than 1 lookup in flight.
			let inFlight = 0;
			let maxInFlight = 0;
			codeAction.mockImplementation(
				() =>
					new Promise((resolve) => {
						inFlight += 1;
						maxInFlight = Math.max(maxInFlight, inFlight);
						setTimeout(() => {
							inFlight -= 1;
							resolve([{ title: "Fix it", kind: "quickfix" }]);
						}, 20);
					}),
			);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);

			expect(codeAction).toHaveBeenCalledTimes(3);
			expect(maxInFlight).toBe(3);
			expect(
				result.diagnostics.every((d) => d.fixSuggestion?.includes("Fix it")),
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});
