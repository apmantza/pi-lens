import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";
import { installLspServiceDouble } from "../../../support/lsp-service-seam.js";

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
		inconclusiveServerIds?: string[];
		inconclusiveReason?:
			| "notify-write"
			| "diagnostics-wait"
			| "mixed"
			| "primary-unavailable";
		primaryUnavailableCause?: "unstarted";
		// #1470: the narrowed confirmation an aux cut off by the grace timer
		// produces — the touch is NOT inconclusive, but it no longer speaks for
		// the named servers.
		confirmation?: "confirmed" | "partial";
		unconfirmedServerIds?: string[];
		deferredServerIds?: string[];
		binding?: { boundToCurrentDisk: boolean | "unknown" };
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

vi.mock("../../../../clients/dispatch/runners/utils.js", () => ({
	readFileContent,
}));

vi.mock("../../../../clients/warm-attach.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/warm-attach.js")
	>()),
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

// #4709: FILE-LEVEL on purpose. The `vi.mock` this replaced was hoisted and
// file-wide, and a `beforeEach` covers only the block that owns it. A
// describe-scoped install narrows that reach silently: this file has two
// top-level describes, and `per-edit blocker scope (#4481)` below kept passing
// only by reading the first describe's leftover singleton, so six of its cases
// red under `--sequence.shuffle --sequence.seed=202` (#4722 F1).
beforeEach(async () => {
	await installLspServiceDouble({
		supportsLSP,
		hasLSP,
		openFile,
		touchFile,
		getDiagnostics,
		codeAction,
		getClientForFile: vi.fn(),
	});
});

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

	it("rubocop does not claim clean when a failing run is unparsable (#1816)", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/rubocop.js")
		).default;
		const env = setupTestEnvironment("pi-lens-rb-unparseable-");
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
					stdout: "rubocop emitted non-JSON failure output",
					stderr: "",
				});

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).not.toBe("succeeded");
			expect(result.diagnostics).not.toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("rubocop preserves valid findings on status 2 (#1816)", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/rubocop.js")
		).default;
		const env = setupTestEnvironment("pi-lens-rb-status-2-findings-");
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
					status: 2,
					stdout: JSON.stringify({
						files: [
							{
								path: filePath,
								offenses: [
									{
										severity: "warning",
										message: "Style/SomeCop",
										cop_name: "Style/SomeCop",
										correctable: false,
										location: { line: 1, column: 1 },
									},
								],
							},
						],
					}),
					stderr: "",
				});
			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("succeeded");
			expect(result.diagnostics).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("rubocop reports a parse error for status 1 stderr-only output (#1816)", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/rubocop.js")
		).default;
		const env = setupTestEnvironment("pi-lens-rb-stderr-only-");
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
					stdout: "",
					stderr: "rubocop failed on stderr",
				});
			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("failed");
			expect(result.diagnostics).toMatchObject([
				{ id: "rubocop:parse-error:1" },
			]);
		} finally {
			env.cleanup();
		}
	});

	it("rubocop keeps status-2 output failures non-clean and signals skipped (#1816)", async () => {
		const runner = (
			await import("../../../../clients/dispatch/runners/rubocop.js")
		).default;
		const env = setupTestEnvironment("pi-lens-rb-outcome-");
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
					status: 2,
					stdout: "",
					stderr: "invalid option",
				});
			const rejected = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(rejected.status).toBe("failed");
			expect(rejected.diagnostics).toMatchObject([
				{ id: "rubocop:parse-error:1" },
			]);

			safeSpawnAsync
				.mockResolvedValueOnce({
					error: null,
					status: 0,
					stdout: "rubocop",
					stderr: "",
				})
				.mockResolvedValueOnce({
					error: null,
					status: null,
					signal: "SIGTERM",
					stdout: "",
					stderr: "",
				});
			const signaled = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(signaled.status).toBe("skipped");
		} finally {
			env.cleanup();
		}
	});

	it("real dispatcher preserves a RuboCop parse failure (#1816)", async () => {
		const { createDispatchContext, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const runner = (
			await import("../../../../clients/dispatch/runners/rubocop.js")
		).default;
		const env = setupTestEnvironment("pi-lens-rb-dispatch-outcome-");
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
					stdout: "rubocop emitted non-JSON failure output",
					stderr: "",
				});
			const registry = new RunnerRegistry();
			registry.register(runner);
			let observed: string | undefined;
			await dispatchForFile(
				createDispatchContext(
					filePath,
					env.tmpDir,
					{ getFlag: () => false },
					new FactStore(),
				),
				[{ mode: "all", runnerIds: ["rubocop"] }],
				registry,
				(_runnerId, result) => {
					observed = result.status;
				},
			);
			expect(observed).toBe("failed");
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
					// #3481 round 1: when the runner read the file.
					readStamp: expect.any(Number),
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

	it("preserves answered auxiliary findings beside an inconclusive primary (#4219)", async () => {
		// #4219: marksman can miss the diagnostics deadline while typos has already
		// published real findings for the same bytes. The inconclusive verdict must
		// not erase those answered diagnostics before the dispatcher can deliver them.
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-4219-");
		try {
			const filePath = path.join(env.tmpDir, "README.md");
			fs.writeFileSync(filePath, "A known mispeling and a seperat typo.\n");

			supportsLSP.mockReturnValue(true);
			touchFile.mockResolvedValue(
				diagsResult(
					[
						{
							severity: 2,
							message: "mispeling → misspelling",
							source: "typos",
							range: {
								start: { line: 0, character: 7 },
								end: { line: 0, character: 16 },
							},
						},
						{
							severity: 2,
							message: "seperat → separate",
							source: "typos",
							range: {
								start: { line: 0, character: 25 },
								end: { line: 0, character: 32 },
							},
						},
					],
					{
						inconclusive: true,
						inconclusiveServerIds: ["marksman"],
						inconclusiveReason: "diagnostics-wait",
					},
				),
			);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.diagnostics).toHaveLength(2);
			expect(result.diagnostics.map((d) => d.tool)).toEqual(["typos", "typos"]);
			expect(result.status).toBe("succeeded");
			expect(result.unconfirmedServerIds).toEqual(["marksman"]);
		} finally {
			env.cleanup();
		}
	});

	// #5008, the inverse cell: an auxiliary's finding is not a verdict about the
	// PRIMARY's recorded blockers. Here the touch is inconclusive with no
	// attribution at all (the shape `TouchFileResult` documents for a client
	// without a per-path publication stamp), so only the runner's own
	// `inconclusive` flag can keep them pending — without it, `failed` +
	// `blocking_diagnostics` is `hasUsableResult` and every `lsp` blocker retires
	// on the strength of another server's answer.
	it("keeps an unconfirmed primary out of the answering auxiliary's verdict (#5008)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-5008-inverse-");
		try {
			const { reachedNoVerdict } =
				await import("../../../../clients/dispatch/types.js");
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			supportsLSP.mockReturnValue(true);
			codeAction.mockResolvedValue([]);
			touchFile.mockResolvedValue(
				diagsResult(
					[
						{
							severity: 1,
							message: "Function returns 'unknown'",
							source: "ast-grep",
							code: "no-unknown-returns",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 10 },
							},
						},
					],
					{ inconclusive: true },
				),
			);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			// The answering server's finding still delivers as a blocker.
			expect(result.status).toBe("failed");
			expect(result.failureKind).toBe("blocking_diagnostics");
			expect(result.diagnostics[0]?.message).toContain("unknown");
			// The unanswered primary speaks for nothing, so the run retires nothing.
			expect(reachedNoVerdict(result)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence prevented: #5285 r3 (CodeRabbit on 548fc8d4c). A touch whose
	// diagnostics wait lapsed without naming a server, but that still collected a
	// finding, makes the real runner return `succeeded` flagged `inconclusive`.
	// The latency row dropped the flag, so the coverage rule built a `checked`
	// verdict from a primary that never answered, and the footer kept no reason.
	it("an inconclusive touch that still delivers a finding is not a checked verdict (#5285 r3)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const {
			clearCoverageNoticeState,
			createDispatchContext,
			dispatchForFile,
			RunnerRegistry,
		} = await import("../../../../clients/dispatch/dispatcher.js");
		const env = setupTestEnvironment("pi-lens-lsp-5285-inconclusive-");
		try {
			clearCoverageNoticeState();
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			touchFile.mockResolvedValue(
				diagsResult(
					[
						{
							severity: 2,
							message: "'x' is declared but its value is never read.",
							source: "typescript",
							code: 6133,
							range: {
								start: { line: 0, character: 6 },
								end: { line: 0, character: 7 },
							},
						},
					],
					{ inconclusive: true, inconclusiveReason: "diagnostics-wait" },
				),
			);
			const registry = new RunnerRegistry();
			registry.register(runner);
			const dispatchCtx = createDispatchContext(
				filePath,
				env.tmpDir,
				{ getFlag: (name: string) => name === "lens-lsp" },
				new FactStore(),
			);

			const result = await dispatchForFile(
				dispatchCtx,
				[{ mode: "all", runnerIds: ["lsp"] }],
				registry,
				undefined,
				{ dedupeCoverageNotice: false },
			);

			expect({
				verdict: result.verdict.checked,
				row: result.latencyReport?.runners.find((r) => r.runnerId === "lsp")
					?.status,
				delivered: result.warnings.map((w) => w.rule ?? w.message),
			}).toEqual({
				verdict: false,
				row: "succeeded",
				delivered: expect.arrayContaining([expect.stringContaining("6133")]),
			});
		} finally {
			env.cleanup();
		}
	});

	// #5008: the negative half of the same guard. A touch that reports neither a
	// completed confirmation policy nor an inconclusive verdict says nothing
	// about the primary, so a deferred auxiliary's findings must not turn it into
	// a run that answers for the primary's blockers.
	it("does not read a confirmation-less touch as an answered primary (#5008)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-5008-unconfirmed-");
		try {
			const { reachedNoVerdict } =
				await import("../../../../clients/dispatch/types.js");
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			supportsLSP.mockReturnValue(true);
			touchFile.mockResolvedValue(
				diagsResult(
					[
						{
							severity: 2,
							message: "Prefer a const declaration.",
							source: "biome",
							code: "use-const",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 5 },
							},
						},
					],
					{
						unconfirmedServerIds: ["opengrep"],
						deferredServerIds: ["opengrep"],
					},
				),
			);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("deferred");
			expect(reachedNoVerdict(result)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("drops stale primary findings beside fresh answered findings (#4231)", async () => {
		// #4231: a timed-out primary can retain its previous diagnostics. The
		// runner must not turn that stale last-known error into a blocking result
		// merely because an auxiliary answered for the new file content.
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-4231-");
		try {
			const filePath = path.join(env.tmpDir, "README.md");
			fs.writeFileSync(filePath, "A fresh typo.\n");

			supportsLSP.mockReturnValue(true);
			touchFile.mockResolvedValue(
				diagsResult(
					[
						{
							severity: 1,
							message: "stale primary error",
							serverId: "marksman",
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 1 },
							},
						},
						{
							severity: 2,
							message: "fresh auxiliary finding",
							serverId: "typos",
							source: "typos",
							range: {
								start: { line: 0, character: 2 },
								end: { line: 0, character: 7 },
							},
						},
					],
					{
						inconclusive: true,
						inconclusiveServerIds: ["marksman"],
						inconclusiveReason: "diagnostics-wait",
						binding: { boundToCurrentDisk: false },
					},
				),
			);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]?.tool).toBe("typos");
			expect(result.status).toBe("succeeded");
			expect(result.unconfirmedServerIds).toEqual(["marksman"]);
		} finally {
			env.cleanup();
		}
	});

	// #5008: the primary answered these bytes and opengrep never reported. That
	// is a verdict about the PRIMARY's blockers (its empty answer retires them)
	// and no verdict about opengrep's (the named id keeps those), which the
	// dispatcher's server clause already carries. Reporting `skipped` for the
	// whole run made a fixed blocker unretirable (#1470's honest gap, one
	// position too wide).
	it("lsp runner answers for the primary while an unconfirmed auxiliary keeps its gap (#5008)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-cutoff-");
		try {
			const { reachedNoVerdict } =
				await import("../../../../clients/dispatch/types.js");
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
			expect(result.status).toBe("succeeded");
			expect(result.diagnostics).toEqual([]);
			// Still no claim of full coverage: the gap rides the result.
			expect(result.unconfirmedServerIds).toEqual(["opengrep"]);
			expect(reachedNoVerdict(result)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	// Review r2 (F2): the findings arm's `&& !primaryAnswered` had no witness. A
	// run that DOES report findings still answers for the primary only when the
	// touch completed its confirmation policy; with a deferred auxiliary, an
	// unanswered primary must keep the run `deferred` (no verdict), or the
	// auxiliary's findings retire the primary's recorded blockers.
	it("answers a warnings-only findings run only when the primary answered for the deferred scanner (#5008)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-5008-findings-deferred-");
		try {
			const { reachedNoVerdict } =
				await import("../../../../clients/dispatch/types.js");
			const filePath = path.join(env.tmpDir, "README.md");
			fs.writeFileSync(filePath, "A fresh typo.\n");
			const typo = {
				severity: 2,
				message: "`teh` is a typo of `the`.",
				source: "typos",
				serverId: "typos",
				code: "teh",
				range: {
					start: { line: 0, character: 2 },
					end: { line: 0, character: 5 },
				},
			};

			supportsLSP.mockReturnValue(true);
			touchFile.mockResolvedValueOnce(
				diagsResult([typo], {
					confirmation: "partial",
					deferredServerIds: ["typos"],
				}),
			);
			const answered = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(answered.diagnostics).toHaveLength(1);
			expect(answered.status).toBe("succeeded");
			expect(answered.deferredServerIds).toEqual(["typos"]);
			expect(reachedNoVerdict(answered)).toBe(false);

			touchFile.mockResolvedValueOnce(
				diagsResult([typo], { deferredServerIds: ["typos"] }),
			);
			const unanswered = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(unanswered.diagnostics).toHaveLength(1);
			expect(unanswered.status).toBe("deferred");
			expect(reachedNoVerdict(unanswered)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// Review r2 (F4): `confirmation` says the primary ANSWERED; `binding` says
	// whether that answer was computed for THESE bytes. Recurrence (#5008): a
	// version-less primary published for the previous revision, so its empty
	// answer completed the confirmation policy against different content and the
	// run read as a verdict — `keepUnobserved` then retired a live blocker.
	// `boundToCurrentDisk: false` is the evidence #4231 already drops stale
	// contributors by, so it says the same thing about the whole answer.
	it("keeps a stale-bound partial answer out of the primary's verdict (#5008)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-5008-stale-bound-");
		try {
			const { reachedNoVerdict } =
				await import("../../../../clients/dispatch/types.js");
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			supportsLSP.mockReturnValue(true);
			touchFile.mockResolvedValue(
				diagsResult([], {
					confirmation: "partial",
					unconfirmedServerIds: ["opengrep"],
					binding: { boundToCurrentDisk: false },
				}),
			);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
			// The gap still rides the result; only the verdict is withheld.
			expect(result.unconfirmedServerIds).toEqual(["opengrep"]);
			expect(reachedNoVerdict(result)).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// Review r2 (F4), the arm with no named gap: the same stale-bound answer
	// with nothing unconfirmed. Every server answered, so no id names the gap and
	// only the binding says the answer was computed for other bytes; a
	// `succeeded` here retired the primary's blocker on it just the same.
	it("keeps a stale-bound all-clear answer from reading as a clean verdict (#5008)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-5008-stale-clean-");
		try {
			const { reachedNoVerdict } =
				await import("../../../../clients/dispatch/types.js");
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			supportsLSP.mockReturnValue(true);
			touchFile.mockResolvedValue(
				diagsResult([], {
					confirmation: "partial",
					binding: { boundToCurrentDisk: false },
				}),
			);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("skipped");
			expect(reachedNoVerdict(result)).toBe(true);

			// The same answer bound to these bytes stays the pre-r2 reading.
			touchFile.mockResolvedValue(
				diagsResult([], {
					confirmation: "partial",
					binding: { boundToCurrentDisk: true },
				}),
			);
			const bound = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(bound.status).toBe("succeeded");
			expect(reachedNoVerdict(bound)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	// #5017: the findings arms of the same stale-bound answer. Recurrence: a
	// primary that completed its policy against older bytes published rows, the
	// run read as a verdict (`failed` + `blocking_diagnostics`, or `succeeded`),
	// and `keepUnobserved` retired a live recorded blocker on findings about other
	// bytes. A stale-bound answer is not an observation of these bytes: its rows
	// are withheld (only an inconclusive touch names which server they did not
	// come from, the #4231 provenance) and the run takes the no-verdict arm the
	// empty answer takes. Cells L, N and P are verify round 3 of #5016.
	const staleRow = (severity: 1 | 2) => ({
		severity,
		message:
			severity === 1
				? "Cannot find name 'BAD_OTHER'."
				: "'unusedVar' is declared but its value is never read.",
		source: "ts",
		serverId: "typescript",
		code: severity === 1 ? 2304 : 6133,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 5 },
		},
	});

	it("withholds a stale-bound blocking answer from the verdict (#5017 L)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-5017-l-");
		try {
			const { reachedNoVerdict } =
				await import("../../../../clients/dispatch/types.js");
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			codeAction.mockResolvedValue([]);
			touchFile.mockResolvedValue(
				diagsResult([staleRow(1)], {
					confirmation: "confirmed",
					binding: { boundToCurrentDisk: false },
				}),
			);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect({
				status: result.status,
				semantic: result.semantic,
				reachedNoVerdict: reachedNoVerdict(result),
				diagnosticCount: result.diagnostics.length,
			}).toEqual({
				status: "skipped",
				semantic: "none",
				reachedNoVerdict: true,
				diagnosticCount: 0,
			});

			// The same row bound to these bytes is still the verdict it was.
			touchFile.mockResolvedValue(
				diagsResult([staleRow(1)], {
					confirmation: "confirmed",
					binding: { boundToCurrentDisk: true },
				}),
			);
			const bound = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(bound.status).toBe("failed");
			expect(bound.diagnostics).toHaveLength(1);
			expect(reachedNoVerdict(bound)).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("withholds a stale-bound warnings-only answer from the verdict (#5017 N)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-5017-n-");
		try {
			const { reachedNoVerdict } =
				await import("../../../../clients/dispatch/types.js");
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			touchFile.mockResolvedValue(
				diagsResult([staleRow(2)], {
					confirmation: "confirmed",
					binding: { boundToCurrentDisk: false },
				}),
			);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect({
				status: result.status,
				semantic: result.semantic,
				reachedNoVerdict: reachedNoVerdict(result),
				diagnosticCount: result.diagnostics.length,
			}).toEqual({
				status: "skipped",
				semantic: "none",
				reachedNoVerdict: true,
				diagnosticCount: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	// P: the blocking row must not let `hasErrors` pick `failed` before the
	// no-verdict decision; the deferred scanner keeps the run `deferred` and its
	// ids still ride the result for the coverage notice.
	it("withholds a stale-bound blocking answer beside a deferred scanner from the verdict (#5017 P)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-5017-p-");
		try {
			const { reachedNoVerdict } =
				await import("../../../../clients/dispatch/types.js");
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			codeAction.mockResolvedValue([]);
			touchFile.mockResolvedValue(
				diagsResult([staleRow(1)], {
					confirmation: "partial",
					unconfirmedServerIds: ["opengrep"],
					deferredServerIds: ["opengrep"],
					binding: { boundToCurrentDisk: false },
				}),
			);

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect({
				status: result.status,
				semantic: result.semantic,
				reachedNoVerdict: reachedNoVerdict(result),
				diagnosticCount: result.diagnostics.length,
				unconfirmedServerIds: result.unconfirmedServerIds,
				deferredServerIds: result.deferredServerIds,
			}).toEqual({
				status: "deferred",
				semantic: "none",
				reachedNoVerdict: true,
				diagnosticCount: 0,
				unconfirmedServerIds: ["opengrep"],
				deferredServerIds: ["opengrep"],
			});
		} finally {
			env.cleanup();
		}
	});

	// #5034 review r3 (F7). Recurrence: since #5014 a fallback-served touch is
	// `primary-unavailable` and names the OWNER, which was never acquired and
	// contributed no row and no binding. The stale filter read that name as the
	// #4231 provenance (the named server is the stale contributor), kept the
	// fallback's rows about other bytes, and published them as `failed` +
	// blocking. An auxiliary's rows on the same verdict are the same case.
	it("withholds a stale-bound fallback answer for an unanswered primary from the verdict (#5034 F7)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-5034-f7-");
		try {
			const { reachedNoVerdict } =
				await import("../../../../clients/dispatch/types.js");
			const filePath = path.join(env.tmpDir, "main.py");
			fs.writeFileSync(filePath, "x = 1\n");
			const row = (serverId: string) => ({
				severity: 1 as const,
				message: `${serverId} finding about older bytes`,
				source: serverId,
				serverId,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 1 },
				},
			});
			const unanswered = (bound: boolean) =>
				diagsResult([row("python-jedi"), row("typos")], {
					inconclusive: true,
					inconclusiveServerIds: ["python"],
					inconclusiveReason: "primary-unavailable",
					primaryUnavailableCause: "unstarted",
					binding: { boundToCurrentDisk: bound },
				});

			codeAction.mockResolvedValue([]);
			touchFile.mockResolvedValue(unanswered(false));
			const stale = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect({
				status: stale.status,
				semantic: stale.semantic,
				reachedNoVerdict: reachedNoVerdict(stale),
				diagnosticCount: stale.diagnostics.length,
				primaryUnavailableCause: stale.primaryUnavailableCause,
			}).toEqual({
				status: "skipped",
				semantic: "none",
				reachedNoVerdict: true,
				diagnosticCount: 0,
				primaryUnavailableCause: "unstarted",
			});

			// Bound to these bytes, the fallback's rows are its real answer.
			touchFile.mockResolvedValue(unanswered(true));
			const bound = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(bound.status).toBe("failed");
			expect(bound.diagnostics).toHaveLength(2);
		} finally {
			env.cleanup();
		}
	});

	// #5030: the same stale-bound answer, arriving over the warm-attach socket.
	// Recurrence: the incumbent's DTO dropped the touch's content binding, so this
	// reader built its wrapper with no binding and read every incumbent answer as
	// these bytes (`failed` + blocking row for cell L, below). The answer comes
	// from the REAL producer (`_serveWarmRequestForTests`, a JSON round trip), so
	// the cell reds on the dropped field, not on a hand-shaped input.
	describe("warm-attach stale-bound answer (#5030)", () => {
		const warmFile = (dir: string) => path.join(dir, "main.ts");
		const incumbentAnswer = async (
			dir: string,
			incumbentTouch: Record<string, unknown>,
		) => {
			const { _serveWarmRequestForTests } =
				await import("../../../../clients/warm-attach.js");
			const { contentHash, WARM_DIAGNOSTICS_SCHEMA_VERSION } =
				await import("../../../../clients/mcp/ipc.js");
			const content = "const x = 1;\n";
			touchFile.mockResolvedValueOnce(incumbentTouch);
			const served = await _serveWarmRequestForTests({
				route: "diagnostics",
				version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
				file: warmFile(dir),
				cwd: dir,
				content,
				contentHash: contentHash(content),
				deadlineAt: Date.now() + 60_000,
			});
			return {
				available: true,
				response: JSON.parse(JSON.stringify(served.result)),
			};
		};
		const verdictOf = async (
			runner: { run: (ctx: never) => Promise<any> },
			dir: string,
		) => {
			const { reachedNoVerdict } =
				await import("../../../../clients/dispatch/types.js");
			const result = await runner.run(ctx(warmFile(dir), dir) as never);
			return {
				status: result.status,
				reachedNoVerdict: reachedNoVerdict(result),
				diagnosticCount: result.diagnostics.length,
			};
		};
		const WITHHELD = {
			status: "skipped",
			reachedNoVerdict: true,
			diagnosticCount: 0,
		};

		it.each([
			[false, WITHHELD],
			[true, { status: "failed", reachedNoVerdict: false, diagnosticCount: 1 }],
			[
				"unknown",
				{ status: "failed", reachedNoVerdict: false, diagnosticCount: 1 },
			],
		] as const)(
			"a warm incumbent's answer bound %s reads as %j",
			async (bound, expected) => {
				const runner = (
					await import("../../../../clients/dispatch/runners/lsp.js")
				).default;
				const env = setupTestEnvironment("pi-lens-lsp-5030-bound-");
				try {
					fs.writeFileSync(warmFile(env.tmpDir), "const x = 1;\n");
					codeAction.mockResolvedValue([]);
					warmAttach.codeActions.mockResolvedValue({ available: false });
					warmAttach.diagnostics.mockResolvedValue(
						await incumbentAnswer(
							env.tmpDir,
							diagsResult([staleRow(1)], {
								confirmation: "confirmed",
								binding: { boundToCurrentDisk: bound },
							}),
						),
					);

					expect(await verdictOf(runner, env.tmpDir)).toEqual(expected);
				} finally {
					env.cleanup();
				}
			},
		);

		// Mixed builds: an incumbent built before #5030 sends no binding. The
		// absence is "not current", never "current" (the same fail-closed rule the
		// direct route applies to a stale bound), so a binding-less or unreadable
		// value is withheld too.
		// Today's response shape, captured from a build before #5030 (a stale-bound
		// touch served by `_serveWarmRequestForTests`): the corpus fixture is what
		// the older incumbent actually puts on the socket.
		it("withholds the response a build before #5030 sends", async () => {
			const runner = (
				await import("../../../../clients/dispatch/runners/lsp.js")
			).default;
			const env = setupTestEnvironment("pi-lens-lsp-5030-fixture-");
			try {
				fs.writeFileSync(warmFile(env.tmpDir), "const x = 1;\n");
				codeAction.mockResolvedValue([]);
				warmAttach.codeActions.mockResolvedValue({ available: false });
				const response = JSON.parse(
					fs.readFileSync(
						new URL(
							"../../../fixtures/warm-attach/diagnostics-response-pre-5030.json",
							import.meta.url,
						),
						"utf8",
					),
				);
				expect(response).not.toHaveProperty("binding");
				warmAttach.diagnostics.mockResolvedValue({ available: true, response });

				expect(await verdictOf(runner, env.tmpDir)).toEqual(WITHHELD);
			} finally {
				env.cleanup();
			}
		});

		it.each([
			["an older incumbent's answer (no binding field)", undefined],
			["a null binding", null],
			["a binding that is not an object", "yes"],
			["a binding with no verdict", {}],
			["a binding with an unrecognised verdict", { boundToCurrentDisk: "yes" }],
		] as const)("withholds %s", async (_label, wire) => {
			const runner = (
				await import("../../../../clients/dispatch/runners/lsp.js")
			).default;
			const env = setupTestEnvironment("pi-lens-lsp-5030-nobinding-");
			try {
				fs.writeFileSync(warmFile(env.tmpDir), "const x = 1;\n");
				codeAction.mockResolvedValue([]);
				warmAttach.codeActions.mockResolvedValue({ available: false });
				warmAttach.diagnostics.mockResolvedValue({
					available: true,
					response: {
						diagnostics: [staleRow(1)],
						confirmation: "confirmed",
						...(wire !== undefined && { binding: wire }),
					},
				});

				expect(await verdictOf(runner, env.tmpDir)).toEqual(WITHHELD);
			} finally {
				env.cleanup();
			}
		});
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

	it("repeats a scanner coverage notice on every pull without consuming the push latch (#3791)", async () => {
		// #3791: the same session latch dedupes the scanner-partial notice class
		// too, so a warm `pilens_analyze` pull of a file with a silent scanner
		// also read as a clean result on the second call. A pull dispatch
		// (`dedupeCoverageNotice: false`) must emit it every time and must leave
		// the push latch intact.
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const { clearCoverageNoticeState, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const env = setupTestEnvironment("pi-lens-lsp-pull-coverage-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			clearCoverageNoticeState();
			touchFile.mockResolvedValue(
				diagsResult([], {
					confirmation: "partial",
					unconfirmedServerIds: ["opengrep"],
				}),
			);
			const registry = new RunnerRegistry();
			registry.register(runner);
			const groups = [{ mode: "all" as const, runnerIds: ["lsp"] }];
			const notice = "coverage: opengrep silent";
			const pull = () =>
				dispatchForFile(
					ctx(filePath, env.tmpDir) as never,
					groups,
					registry,
					undefined,
					{ dedupeCoverageNotice: false },
				);

			// Pay the push latch first, so the pull has to ignore a set key.
			const pushFirst = await dispatchForFile(
				ctx(filePath, env.tmpDir) as never,
				groups,
				registry,
			);
			expect(pushFirst.output).toContain(notice);
			const pushSecond = await dispatchForFile(
				ctx(filePath, env.tmpDir) as never,
				groups,
				registry,
			);
			expect(pushSecond.output).not.toContain(notice);

			expect((await pull()).output).toContain(notice);
			expect((await pull()).output).toContain(notice);

			// The pulls did not write the latch either: the next push stays silent.
			const pushThird = await dispatchForFile(
				ctx(filePath, env.tmpDir) as never,
				groups,
				registry,
			);
			expect(pushThird.output).not.toContain(notice);
		} finally {
			env.cleanup();
		}
	});

	it("keeps a fresh scanner push notice after two pulls (#3791 F2)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const { clearCoverageNoticeState, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const env = setupTestEnvironment("pi-lens-lsp-fresh-push-coverage-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			clearCoverageNoticeState();
			touchFile.mockResolvedValue(
				diagsResult([], {
					confirmation: "partial",
					unconfirmedServerIds: ["opengrep"],
				}),
			);
			const registry = new RunnerRegistry();
			registry.register(runner);
			const groups = [{ mode: "all" as const, runnerIds: ["lsp"] }];
			const notice = "coverage: opengrep silent";
			const pull = () =>
				dispatchForFile(
					ctx(filePath, env.tmpDir) as never,
					groups,
					registry,
					undefined,
					{ dedupeCoverageNotice: false },
				);

			expect((await pull()).output).toContain(notice);
			expect((await pull()).output).toContain(notice);
			const firstPush = await dispatchForFile(
				ctx(filePath, env.tmpDir) as never,
				groups,
				registry,
			);
			expect(firstPush.output).toContain(notice);
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

	it("reports a late-delivery scanner as deferred and an unpromised one as neither, both keeping the primary's verdict (#2810, #5008)", async () => {
		// #2810 round-4 F1, runner half of the chain: the two coverage classes
		// must not collapse into one answer. A scanner the touch marked
		// collect-later is named in `deferredServerIds` (its findings arrive at
		// turn end); one the touch has no delivery path for is named in
		// `unconfirmedServerIds` alone (#1470's honest gap). #5008: the primary
		// answered both times, so the run is still a verdict about the primary's
		// blockers and the status says nothing about the auxiliaries.
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-late-status-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			touchFile.mockResolvedValue(
				diagsResult([], {
					confirmation: "partial",
					unconfirmedServerIds: ["typos"],
					deferredServerIds: ["typos"],
				}),
			);
			const late = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(late.status).toBe("succeeded");
			expect(late.deferredServerIds).toEqual(["typos"]);
			touchFile.mockResolvedValue(
				diagsResult([], {
					confirmation: "partial",
					unconfirmedServerIds: ["typos"],
				}),
			);
			const unpromised = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(unpromised.status).toBe("succeeded");
			expect(unpromised.deferredServerIds).toBeUndefined();
			expect(unpromised.unconfirmedServerIds).toEqual(["typos"]);
		} finally {
			env.cleanup();
		}
	});

	it("re-notices the same scanner when it moves from silent to late-delivery pending (#2810)", async () => {
		// #2810 round-4 F1, second axis: the once-per-session dedupe key was built
		// from the UNCONFIRMED set alone, so the first message a scanner produced
		// was the only one the session ever showed. A scanner first reported
		// silent and later marked collect-later kept the "not a clean result"
		// wording forever (and vice versa).
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const { clearCoverageNoticeState, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const env = setupTestEnvironment("pi-lens-lsp-notice-partition-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");
			clearCoverageNoticeState();
			const registry = new RunnerRegistry();
			registry.register(runner);
			touchFile.mockResolvedValue(
				diagsResult([], {
					confirmation: "partial",
					unconfirmedServerIds: ["typos"],
				}),
			);
			const first = await dispatchForFile(
				ctx(filePath, env.tmpDir) as never,
				[{ mode: "all" as const, runnerIds: ["lsp"] }],
				registry,
			);
			expect(first.output).toContain("coverage: typos silent");
			touchFile.mockResolvedValue(
				diagsResult([], {
					confirmation: "partial",
					unconfirmedServerIds: ["typos"],
					deferredServerIds: ["typos"],
				}),
			);
			const second = await dispatchForFile(
				ctx(filePath, env.tmpDir) as never,
				[{ mode: "all" as const, runnerIds: ["lsp"] }],
				registry,
			);
			expect(second.output).toContain("coverage: typos deferred");
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

	it("answers for the primary on the warm-attach route while an auxiliary keeps its gap (#1470, #5008)", async () => {
		// The same #1470 shape as the incumbent-touch test above, but on the
		// warm-attach IPC route: `available: true` with an empty diagnostics
		// array and `unconfirmedServerIds` on the response DTO. The wrapper this
		// runner builds from a warm-attach answer must carry that field through
		// to `touchCoverageGap`, not drop it — a hung opengrep must not read as
		// a clean bill of health here either. #5008: the incumbent's
		// `confirmation` is the field that says the primary answered, so dropping
		// THAT would read every warm answer as a primary that never completed its
		// policy.
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-warm-cutoff-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const x = 1;\n");

			warmAttach.diagnostics.mockResolvedValue({
				available: true,
				response: {
					binding: { boundToCurrentDisk: true },
					diagnostics: [],
					confirmation: "partial",
					unconfirmedServerIds: ["opengrep"],
				},
			});

			const result = await runner.run(ctx(filePath, env.tmpDir) as never);
			expect(result.status).toBe("succeeded");
			expect(result.diagnostics).toEqual([]);
			expect(result.unconfirmedServerIds).toEqual(["opengrep"]);
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
			expect(result.diagnostics[0]).toMatchObject({
				runnerFault: true,
				semantic: "warning",
			});
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
					binding: { boundToCurrentDisk: true },
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
					binding: { boundToCurrentDisk: true },
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

	// Recurrence (#4944 review F2): the exclusion reached only the local touch, so
	// a warm incumbent started without the flag still delivered its ast-grep
	// rows to a session that had switched ast-grep off.
	it("drops a switched-off auxiliary's warm-attached rows and keeps the others (#4944)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-warm-switched-off-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const a: string = 1;\n");
			const range = {
				start: { line: 0, character: 6 },
				end: { line: 0, character: 7 },
			};
			warmAttach.diagnostics.mockResolvedValue({
				available: true,
				response: {
					binding: { boundToCurrentDisk: true },
					diagnostics: [
						{
							severity: 1,
							message: "Type mismatch",
							range,
							source: "typescript",
							serverId: "typescript",
						},
						{
							severity: 1,
							message: "warm ast-grep finding",
							range,
							source: "ast-grep",
							serverId: "ast-grep",
						},
					],
				},
			});
			const messages = async (switches: readonly string[]) =>
				(
					await runner.run({
						...ctx(filePath, env.tmpDir),
						pi: {
							getFlag: (name: string) =>
								name === "lens-lsp" || switches.includes(name),
						},
					} as never)
				).diagnostics.map((d) => d.message);

			// The control: with the switch unset the fixture does deliver the row.
			expect(await messages([])).toEqual([
				"Type mismatch",
				"warm ast-grep finding",
			]);
			expect(await messages(["no-ast-grep"])).toEqual(["Type mismatch"]);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence (#4947 r2 verify N1): the receipt dropped a switched-off
	// server's rows but kept its id, so a clean file came back skipped and the
	// dispatcher printed "ast-grep silent — diagnostics are incomplete" for a
	// scanner this session had switched off.
	it("drops a switched-off auxiliary from the incumbent's coverage gap and keeps the others (#4944)", async () => {
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-warm-switched-off-gap-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const a = 1;\n");
			warmAttach.diagnostics.mockResolvedValue({
				available: true,
				response: {
					binding: { boundToCurrentDisk: true },
					diagnostics: [],
					confirmation: "partial",
					unconfirmedServerIds: ["ast-grep", "typos"],
				},
			});
			const gap = async (switches: readonly string[]) =>
				(
					await runner.run({
						...ctx(filePath, env.tmpDir),
						pi: {
							getFlag: (name: string) =>
								name === "lens-lsp" || switches.includes(name),
						},
					} as never)
				).unconfirmedServerIds;

			// The control: with the switch unset the incumbent's gap is reported.
			expect(await gap([])).toEqual(["ast-grep", "typos"]);
			expect(await gap(["no-ast-grep"])).toEqual(["typos"]);
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

/**
 * #4481 — which blockers the per-edit pass scopes to the lines a write
 * changed. Only line-local rule runners (ast-grep, tree-sitter) are scoped: a
 * structural rule matches the lines it flags, so on a file's first write (no
 * delta baseline yet) its blocker on an unchanged line is pre-existing.
 * Language servers and linters stay unscoped by design: an edit causes a type
 * error at the callers of a changed signature, or an unused-declaration lint
 * at a line it never touched (maintainer decision, 2026-10-15). Each case
 * drives the real dispatcher and runner, blocking-only with the ranges a host
 * `edit` produces; only the LSP service and the linter process are doubles.
 */
describe("per-edit blocker scope (#4481)", () => {
	/** The write changed line 2 only; every finding on line 1 is outside it. */
	const CHANGED = [{ start: 2, end: 2 }];

	beforeEach(() => {
		safeSpawnAsync.mockReset();
		touchFile.mockReset();
		codeAction.mockReset();
		codeAction.mockResolvedValue([]);
		readFileContent.mockReset();
		readFileContent.mockReturnValue("const a: string = 1;\nconst b = 2;\n");
		supportsLSP.mockReturnValue(true);
		warmAttach.diagnostics.mockReset();
		warmAttach.diagnostics.mockResolvedValue(undefined);
	});

	function lspDiag(
		line: number,
		source?: string,
		severity = 1,
		endLine = line,
	) {
		return {
			severity,
			message: source ? `${source} finding` : "Type error",
			range: {
				start: { line: line - 1, character: 0 },
				end: { line: endLine - 1, character: 1 },
			},
			code: source ? "no-unknown-returns" : "2322",
			...(source && { source }),
		};
	}

	async function dispatchLsp(diags: unknown[], blockingOnly = true) {
		const { createDispatchContext, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const runner = (await import("../../../../clients/dispatch/runners/lsp.js"))
			.default;
		const env = setupTestEnvironment("pi-lens-lsp-edit-scope-");
		try {
			const filePath = path.join(env.tmpDir, "main.ts");
			fs.writeFileSync(filePath, "const a: string = 1;\nconst b = 2;\n");
			touchFile.mockResolvedValue(diagsResult(diags));
			const registry = new RunnerRegistry();
			registry.register(runner);
			return await dispatchForFile(
				createDispatchContext(
					filePath,
					env.tmpDir,
					{ getFlag: (flag: string) => flag === "lens-lsp" },
					new FactStore(),
					blockingOnly,
					CHANGED,
				),
				[{ mode: "all", runnerIds: ["lsp"] }],
				registry,
			);
		} finally {
			env.cleanup();
		}
	}

	// Recurrence: #4481 through the ast-grep LSP lane — the same rule catalog
	// as ast-grep-napi, delivered by `ast-grep lsp` when its binary is present.
	it("drops an ast-grep LSP blocker on an unchanged line", async () => {
		const result = await dispatchLsp([lspDiag(1, "ast-grep")]);

		expect(result.blockers.filter((d) => d.tool === "ast-grep")).toEqual([]);
		// #4484 round 2: withheld from delivery, still observed. Recurrence: the
		// lane dropped it, so the record lost a blocker an edit elsewhere left.
		expect(result.stillObserved).toEqual([
			expect.objectContaining({ tool: "ast-grep", line: 1, runnerId: "lsp" }),
		]);
	});

	// Recurrence: #4482 review r1 F1 — the real ast-grep LSP reports
	// `array-callback-return` from line 1 to line 3; an edit inside it (line 2)
	// caused it, and a start-line gate dropped it.
	it("keeps an ast-grep LSP blocker whose span contains the edit", async () => {
		const result = await dispatchLsp([lspDiag(1, "ast-grep", 1, 3)]);

		expect(result.blockers).toEqual([
			expect.objectContaining({ tool: "ast-grep", line: 1 }),
		]);
	});

	// Recurrence: a span gate that read the wrong end (or widened every span)
	// would bring back the #4481 STOP on an untouched multi-line match.
	it("drops a multi-line ast-grep LSP blocker wholly outside the edit", async () => {
		const result = await dispatchLsp([lspDiag(3, "ast-grep", 1, 4)]);

		expect(result.blockers.filter((d) => d.tool === "ast-grep")).toEqual([]);
	});

	// Recurrence: an ast-grep LSP gate that drops in-range findings too would
	// hide a blocker the write itself introduced.
	it("keeps an ast-grep LSP blocker on a changed line", async () => {
		const result = await dispatchLsp([lspDiag(2, "ast-grep")]);

		expect(result.blockers).toEqual([
			expect.objectContaining({ tool: "ast-grep", line: 2 }),
		]);
	});

	// Recurrence: a gate that dropped every out-of-range ast-grep finding would
	// erase its warning tier from lens_diagnostics, not only its STOP.
	it("keeps an ast-grep LSP warning on an unchanged line", async () => {
		const result = await dispatchLsp([lspDiag(1, "ast-grep", 2)]);

		expect(result.warnings).toEqual([
			expect.objectContaining({ tool: "ast-grep", line: 1 }),
		]);
	});

	// Recurrence: a gate keyed off the ranges alone would drop blockers from a
	// full (non-blocking) pass that carries the write's ranges.
	it("keeps an unchanged-line ast-grep LSP blocker outside the blocking-only pass", async () => {
		const result = await dispatchLsp([lspDiag(1, "ast-grep")], false);

		expect(result.blockers).toEqual([
			expect.objectContaining({ tool: "ast-grep", line: 1 }),
		]);
	});

	// Recurrence: a range gate added to a semantic runner would hide errors the
	// edit caused, such as a type error at the caller of a changed signature.
	it("keeps a language-server blocker on an unchanged line", async () => {
		const result = await dispatchLsp([lspDiag(1)]);

		expect(result.blockers).toEqual([
			expect.objectContaining({ tool: "lsp", line: 1, semantic: "blocking" }),
		]);
	});

	// Recurrence: a range gate added to a linter would hide a finding the edit
	// caused at a line it never touched (an unused declaration after its last
	// use is deleted, no-undef after a declaration is removed).
	it("keeps a linter blocker on an unchanged line", async () => {
		const { createDispatchContext, dispatchForFile, RunnerRegistry } =
			await import("../../../../clients/dispatch/dispatcher.js");
		const runner = (
			await import("../../../../clients/dispatch/runners/rubocop.js")
		).default;
		const env = setupTestEnvironment("pi-lens-rb-edit-scope-");
		try {
			const filePath = path.join(env.tmpDir, "main.rb");
			fs.writeFileSync(filePath, "value = 1\nputs 'hi'\n");
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
										message: "Useless assignment to variable - `value`.",
										cop_name: "Lint/UselessAssignment",
										correctable: false,
										location: { line: 1, column: 1 },
									},
								],
							},
						],
					}),
					stderr: "",
				});
			const registry = new RunnerRegistry();
			registry.register(runner);

			const result = await dispatchForFile(
				createDispatchContext(
					filePath,
					env.tmpDir,
					{ getFlag: () => false },
					new FactStore(),
					true,
					CHANGED,
				),
				[{ mode: "all", runnerIds: ["rubocop"] }],
				registry,
			);

			expect(result.blockers).toEqual([
				expect.objectContaining({ tool: "rubocop", line: 1 }),
			]);
		} finally {
			env.cleanup();
		}
	});
});
