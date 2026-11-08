import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { hasUsableResult } from "../../../../clients/dispatch/types.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
let availabilityCheck: (command: string) => boolean = () => true;

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailable: () => availabilityCheck(command),
			isAvailableAsync: async () => availabilityCheck(command),
			getCommand: () => command,
		}),
	}),
);

function mockRunnerHelpers(
	isAvailable: (command: string) => boolean = () => true,
): void {
	availabilityCheck = isAvailable;
}

function createCtx(
	kind: "dart" | "zig" | "gleam" | "elixir",
	filePath: string,
	cwd: string,
) {
	return makeRunnerCtx(filePath, cwd, { kind });
}

/**
 * Does THIS filesystem fold case? Measured once against a real temp directory,
 * never asserted from `process.platform` (#3159 round 2: a platform-shaped
 * case claim redded EEXIST on the first real macOS run). APFS and NTFS answer
 * true, ext4 answers false, and the case-variant cell below asserts the
 * filesystem's own answer on every lane instead of skipping off Windows.
 */
function hostFoldsPathCase(): boolean {
	const probe = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-case-probe-"));
	try {
		fs.writeFileSync(path.join(probe, "probe.ex"), "");
		return fs.existsSync(path.join(probe, "PROBE.ex"));
	} finally {
		fs.rmSync(probe, { recursive: true, force: true });
	}
}

const HOST_FOLDS_PATH_CASE = hostFoldsPathCase();

interface SpawnShape {
	error?: Error | null;
	status: number | null;
	signal?: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

/**
 * Drive one runner outcome through the REAL dispatcher: registry lookup,
 * `dispatchForFile`, the in-process degradation ledger and the model-facing
 * renderer. Every failure-list cell for `dart-analyze` and `elixir-check`
 * enters here rather than calling `runner.run` directly — review round 2 found
 * a direct-runner signal test that stayed green under a mutation erasing the
 * signal from the shared `parseToolRun` input (#1816).
 */
async function dispatchOutcome(
	tool: "dart-analyze" | "elixir-check",
	caseName: string,
	spawnResult: SpawnShape | ((filePath: string) => SpawnShape),
	options: { available?: boolean; mixProject?: boolean } = {},
) {
	vi.resetModules();
	const env = setupTestEnvironment(`pi-lens-${tool}-${caseName}-`);
	try {
		const kind = tool === "dart-analyze" ? "dart" : "elixir";
		const extension = kind === "dart" ? "main.dart" : "lib/app.ex";
		const filePath = path.join(env.tmpDir, extension);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
			kind === "dart" ? "void main() {}\n" : "defmodule App do\n",
		);
		if (kind === "elixir" && (options.mixProject ?? true)) {
			fs.writeFileSync(
				path.join(env.tmpDir, "mix.exs"),
				"defmodule Demo.MixProject do end\n",
			);
		}

		mockRunnerHelpers(() => options.available ?? true);
		if (options.available ?? true)
			safeSpawnAsync.mockResolvedValue(
				typeof spawnResult === "function" ? spawnResult(filePath) : spawnResult,
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
		let observedStatus: string | undefined;
		let observedSemantic: string | undefined;
		let observedSkipFault: string | undefined;
		let observedDiagnostics: Array<{ id?: string; semantic?: string }> = [];
		const result = await dispatchForFile(
			createDispatchContext(
				filePath,
				env.tmpDir,
				{ getFlag: () => false },
				new FactStore(),
			),
			[{ mode: "all", runnerIds: [tool] }],
			registry,
			(_runnerId, runnerResult) => {
				observedStatus = runnerResult.status;
				observedSemantic = runnerResult.semantic;
				observedSkipFault = runnerResult.skipFault;
				observedDiagnostics = runnerResult.diagnostics;
			},
		);
		return {
			status: observedStatus,
			semantic: observedSemantic,
			skipFault: observedSkipFault,
			diagnostics: observedDiagnostics,
			output: result.output,
			ledger: getDegradationSummary(),
			spawnCalls: safeSpawnAsync.mock.calls.length,
		};
	} finally {
		env.cleanup();
	}
}

describe("secondary language fallback runners", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		availabilityCheck = () => true;
		mockRunnerHelpers();
	});

	it("keeps a clean dart run with no output clean through dispatch (#1816)", async () => {
		// Prevents the empty-output guard from swallowing the ordinary clean
		// save: exit 0 with neither stream written is a clean file, not a
		// degraded run. The opposite direction of `guards dart empty output`.
		const observed = await dispatchOutcome("dart-analyze", "clean", {
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});
		expect(observed.status).toBe("succeeded");
		expect(observed.diagnostics).toEqual([]);
		expect(observed.output).toBe("");
		expect(observed.ledger).toEqual([]);
	});

	it("renders dart findings from a nonzero run through dispatch (#1816)", async () => {
		// Prevents a machine-format finding from being downgraded or dropped
		// between the parser and the model-facing render.
		const observed = await dispatchOutcome(
			"dart-analyze",
			"findings",
			(filePath) => ({
				error: null,
				status: 1,
				stdout: "",
				stderr: `ERROR|LINT|unused_local_variable|${filePath}|2|1|1|unused value`,
			}),
		);
		expect(observed.status).toBe("failed");
		expect(observed.semantic).toBe("blocking");
		expect(observed.diagnostics).toHaveLength(1);
		expect(observed.output).toContain("🔴 STOP — 1 issue(s) must be fixed:");
		expect(observed.output).toContain("[unused_local_variable] unused value");
	});

	it("renders dart compile errors from an exit-3 run through dispatch (#1937)", async () => {
		// Prevents the Dart 3.5-era exit table from returning: dart 3.13 exits 3
		// when the analyzer reports an ERROR, and a table that stops at 2 rejects
		// the invocation and drops the finding (captured bytes in
		// tests/fixtures/runner-output/dart-analyze).
		const observed = await dispatchOutcome(
			"dart-analyze",
			"exit-3",
			(filePath) => ({
				error: null,
				status: 3,
				stdout: `ERROR|COMPILE_TIME_ERROR|INVALID_ASSIGNMENT|${filePath}|3|11|14|A value of type 'String' can't be assigned to a variable of type 'int'.`,
				stderr: "",
			}),
		);
		expect(observed.status).toBe("failed");
		expect(observed.semantic).toBe("blocking");
		expect(observed.diagnostics).toHaveLength(1);
		expect(observed.output).toContain("[INVALID_ASSIGNMENT]");
	});

	it("guards dart nonzero unparseable stdout through dispatch (#1816)", async () => {
		// Prevents a failed dart run whose stdout the parser cannot read from
		// being rendered as a clean file (#1781 shape).
		const observed = await dispatchOutcome("dart-analyze", "unparseable", {
			error: null,
			status: 1,
			stdout: "dart analyze failed unexpectedly",
			stderr: "",
		});
		expect(observed.status).toBe("failed");
		expect(observed.semantic).toBe("warning");
		expect(observed.diagnostics[0]?.id).toBe("dart-analyze:parse-error:1");
		expect(observed.ledger[0]?.kind).toBe("runner-parsed-nothing");
	});

	it("guards dart stderr-only nonzero output through dispatch (#1816)", async () => {
		// dart analyze writes its machine diagnostics to stderr, so a runner
		// that parsed stdout alone would call every failing run clean.
		const observed = await dispatchOutcome("dart-analyze", "stderr-only", {
			error: null,
			status: 1,
			stdout: "",
			stderr: "dart analyze failed unexpectedly",
		});
		expect(observed.status).toBe("failed");
		expect(observed.semantic).toBe("warning");
		expect(observed.diagnostics[0]?.id).toBe("dart-analyze:parse-error:1");
		expect(observed.ledger[0]?.kind).toBe("runner-parsed-nothing");
	});

	it("keeps dart status-0 stderr noise clean through dispatch (#1816)", async () => {
		// Prevents harmless dart stderr banners from becoming a false finding
		// or a degradation row.
		const observed = await dispatchOutcome("dart-analyze", "stderr-noise", {
			error: null,
			status: 0,
			stdout: "",
			stderr: "dart analyze: no issues\n",
		});
		expect(observed.status).toBe("succeeded");
		expect(observed.diagnostics).toEqual([]);
		expect(observed.output).toBe("");
		expect(observed.ledger).toEqual([]);
	});

	it("guards dart signal termination through dispatch (#1816)", async () => {
		// Prevents a signal-killed dart run from becoming a clean rendered
		// result, and keeps the signal named in the ledger reason. Round 2
		// found the direct-runner version of this test green under a mutation
		// that erased `signal` from the `parseToolRun` input.
		const observed = await dispatchOutcome("dart-analyze", "signal", {
			error: null,
			status: null,
			signal: "SIGTERM",
			stdout: "",
			stderr: "",
		});
		expect(observed.status).toBe("skipped");
		expect(observed.output).toContain("not a clean result");
		expect(observed.ledger[0]?.latestReasons[0]?.reason).toContain("SIGTERM");
		// #4130: the signal death reaches the delivery sink as a named fault.
		expect(observed.skipFault).toBe("did-not-run");
	});

	it("falls back to flutter analyze when dart is unavailable", async () => {
		vi.resetModules();
		mockRunnerHelpers((command) => command === "flutter");

		const env = setupTestEnvironment("pi-lens-dart-flutter-runner-");
		try {
			const filePath = path.join(env.tmpDir, "lib", "main.dart");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "void main() {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: `warning|static_warning|unused_import|${filePath}|2|1|1|Unused import`,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/dart-analyze.js")
			).default;

			const result = await runner.run(
				createCtx("dart", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("warning");
			expect(safeSpawnAsync.mock.calls[0]?.[0]).toBe("flutter");
		} finally {
			env.cleanup();
		}
	});

	it("guards dart rejection through dispatch (#1816)", async () => {
		// Prevents a rejected dart invocation from becoming a clean rendered result.
		const observed = await dispatchOutcome("dart-analyze", "rejected", {
			error: null,
			status: 2,
			stdout: "",
			stderr: "unknown dart analyze option",
		});
		expect(observed.status).toBe("failed");
		expect(observed.diagnostics[0]?.id).toBe("dart-analyze:parse-error:1");
		expect(observed.ledger[0]?.kind).toBe("runner-parsed-nothing");
	});

	it("guards dart empty output through dispatch (#1816)", async () => {
		// Prevents a failed Dart run with no parser input from becoming clean.
		const observed = await dispatchOutcome("dart-analyze", "empty", {
			error: null,
			status: 1,
			stdout: "",
			stderr: "",
		});
		expect(observed.status).toBe("skipped");
		expect(observed.output).toContain("not a clean result");
		expect(observed.ledger[0]?.latestReasons[0]?.reason).toContain("no output");
		// #4130: a failed run that said nothing is a fault, not an absent tool.
		expect(observed.skipFault).toBe("did-not-run");
	});

	it("guards actual dart unavailability through dispatch (#1816)", async () => {
		// Prevents absent dart and flutter binaries from being reported as clean.
		const observed = await dispatchOutcome(
			"dart-analyze",
			"unavailable",
			{ error: null, status: 0, stdout: "", stderr: "" },
			{ available: false },
		);
		expect(observed.status).toBe("skipped");
		expect(observed.output).toContain("not a clean result");
		expect(observed.spawnCalls).toBe(0);
		expect(observed.ledger).toEqual([]);
		// #4130: nothing was invoked, so an absent tool stays a plain skip.
		expect(observed.skipFault).toBeUndefined();
	});

	// RECURRENCE THIS PREVENTS: #4130 item 3. zig-check and gleam-check turned a
	// spawn that failed with no output into a bare skip, which the smoke
	// classifier read as "tool absent". The tool resolved and was invoked, so
	// the skip names the fault.
	it.each([
		["zig-check", "zig", "src/main.zig", "pub fn main() void {}\n"],
		["gleam-check", "gleam", "src/app.gleam", "pub fn main() { 1 }\n"],
	] as const)(
		"%s names a spawn failure on its skip (#4130)",
		async (id, kind, file, source) => {
			const env = setupTestEnvironment(`pi-lens-${id}-spawn-fault-`);
			try {
				const filePath = path.join(env.tmpDir, file);
				fs.mkdirSync(path.dirname(filePath), { recursive: true });
				fs.writeFileSync(filePath, source);
				safeSpawnAsync.mockResolvedValue({
					error: new Error("Process timed out after 30000ms"),
					status: null,
					stdout: "",
					stderr: "",
				});
				const runner = (
					await import(`../../../../clients/dispatch/runners/${id}.js`)
				).default;

				const result = await runner.run(
					createCtx(kind, filePath, env.tmpDir) as never,
				);
				expect(result.status).toBe("skipped");
				expect(result.skipFault).toBe("did-not-run");

				// The same runner with no tool installed invokes nothing: plain skip.
				safeSpawnAsync.mockClear();
				mockRunnerHelpers(() => false);
				vi.resetModules();
				const absent = await (
					await import(`../../../../clients/dispatch/runners/${id}.js`)
				).default.run(createCtx(kind, filePath, env.tmpDir) as never);
				expect(absent.status).toBe("skipped");
				expect(absent.skipFault).toBeUndefined();
				expect(safeSpawnAsync).not.toHaveBeenCalled();
			} finally {
				env.cleanup();
			}
		},
	);

	// RECURRENCE THIS PREVENTS: #4130 item 3, same shape as the zig/gleam rows
	// above. pyright and prisma-validate resolved their tool, the spawn failed,
	// and the bare skip read as "tool absent" to the smoke classifier.
	it.each([
		["pyright", "python", "app.py", "x = 1\n"],
		["prisma-validate", "prisma", "schema.prisma", "model A { id Int @id }\n"],
	] as const)(
		"%s names a spawn failure on its skip (#4130)",
		async (id, kind, file, source) => {
			const env = setupTestEnvironment(`pi-lens-${id}-spawn-fault-`);
			try {
				const filePath = path.join(env.tmpDir, file);
				fs.writeFileSync(filePath, source);
				safeSpawnAsync.mockResolvedValue({
					error: new Error("Process timed out after 60000ms"),
					status: null,
					stdout: "",
					stderr: "",
				});
				const runner = (
					await import(`../../../../clients/dispatch/runners/${id}.js`)
				).default;

				const result = await runner.run(
					makeRunnerCtx(filePath, env.tmpDir, {
						kind,
						pi: { getFlag: (name: string) => name === "no-lsp" },
					} as never) as never,
				);
				expect(safeSpawnAsync).toHaveBeenCalled();
				expect(result.status).toBe("skipped");
				expect(result.skipFault).toBe("did-not-run");
			} finally {
				env.cleanup();
			}
		},
		30_000,
	);

	// RECURRENCE THIS PREVENTS: #4130 round 2 (PR #4971 threads on gleam-check and
	// prisma-validate). The spawn guard only caught a cut-short run with NO
	// output at all; a run killed after it printed something reached the parser,
	// and gleam reported it `succeeded` (nothing parsed, status null) or
	// `blocking_diagnostics` (something parsed), prisma reported an unmarked
	// skip or `blocking_diagnostics`. Smoke then rendered a broken tool as
	// pass or skip.
	describe("a cut-short run that printed something is a fault (#4130)", () => {
		const gleamFinding = (filePath: string) =>
			[
				"error: Type mismatch",
				`  ┌─ ${filePath}:1:8`,
				"  │",
				"1 │ pub fn main() { 1 }",
				"  │        ^ expected Int",
			].join("\n");

		async function runGleam(
			spawn: SpawnShape,
			render: (filePath: string) => string,
		) {
			const env = setupTestEnvironment("pi-lens-gleam-cut-short-");
			try {
				const filePath = path.join(env.tmpDir, "src", "app.gleam");
				fs.mkdirSync(path.dirname(filePath), { recursive: true });
				fs.writeFileSync(filePath, "pub fn main() { 1 }\n");
				safeSpawnAsync.mockResolvedValue({
					...spawn,
					stderr: render(filePath),
				});
				const runner = (
					await import("../../../../clients/dispatch/runners/gleam-check.js")
				).default;
				return await runner.run(
					createCtx("gleam", filePath, env.tmpDir) as never,
				);
			} finally {
				env.cleanup();
			}
		}

		it("gleam keeps the findings it printed before a timeout, as a fault", async () => {
			const result = await runGleam(
				{
					error: new Error("Process timed out after 30000ms"),
					status: null,
					stdout: "",
					stderr: "",
				},
				gleamFinding,
			);
			expect(result.status).toBe("failed");
			expect(result.failureKind).toBe("did-not-run");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]?.message).toContain("Type mismatch");
			expect(hasUsableResult(result)).toBe(false);
		});

		it("gleam never reads a killed run with only progress output as clean", async () => {
			const result = await runGleam(
				{
					error: new Error("Process timed out after 30000ms"),
					status: null,
					stdout: "",
					stderr: "",
				},
				() => "   Compiling demo",
			);
			expect(result.status).toBe("skipped");
			expect(result.skipFault).toBe("did-not-run");
		});

		it("gleam keeps a completed run's findings as ordinary findings", async () => {
			const result = await runGleam(
				{ error: null, status: 1, stdout: "", stderr: "" },
				gleamFinding,
			);
			expect(result.status).toBe("failed");
			expect(result.failureKind).toBe("blocking_diagnostics");
			expect(result.skipFault).toBeUndefined();
			expect(hasUsableResult(result)).toBe(true);
		});

		async function runPrisma(spawn: SpawnShape) {
			const env = setupTestEnvironment("pi-lens-prisma-cut-short-");
			try {
				const filePath = path.join(env.tmpDir, "schema.prisma");
				fs.writeFileSync(filePath, "model A { id Int @id }\n");
				safeSpawnAsync.mockResolvedValue(spawn);
				const runner = (
					await import("../../../../clients/dispatch/runners/prisma-validate.js")
				).default;
				return await runner.run(
					makeRunnerCtx(filePath, env.tmpDir, {
						kind: "prisma",
						pi: { getFlag: (name: string) => name === "no-lsp" },
					} as never) as never,
				);
			} finally {
				env.cleanup();
			}
		}

		it("prisma faults a killed run whose partial output has no diagnostics", async () => {
			const result = await runPrisma({
				error: null,
				status: null,
				signal: "SIGKILL",
				stdout: "Prisma schema loaded from schema.prisma",
				stderr: "",
			});
			expect(result.status).toBe("skipped");
			expect(result.skipFault).toBe("did-not-run");
		});

		it("prisma never counts a killed run's non-validation output as findings", async () => {
			// npm's E404 (`npx --no prisma` with nothing to run) parses to a
			// "finding" for any text; only prisma's own report may be kept.
			const result = await runPrisma({
				error: null,
				status: null,
				signal: "SIGKILL",
				stdout: "",
				stderr: "npm error code E404",
			});
			expect(result.status).toBe("skipped");
			expect(result.skipFault).toBe("did-not-run");
			expect(result.diagnostics).toEqual([]);
		});

		it("prisma keeps a killed run's validation findings, as a fault", async () => {
			const result = await runPrisma({
				error: null,
				status: null,
				signal: "SIGKILL",
				stdout: "",
				stderr:
					"Error: Prisma schema validation - (get-config wasm)\nValidation Error Count: 1\nschema.prisma:1",
			});
			expect(result.status).toBe("failed");
			expect(result.failureKind).toBe("did-not-run");
			expect(result.diagnostics).toHaveLength(1);
			expect(hasUsableResult(result)).toBe(false);
		});

		// #5411: a completed nonzero run whose output yields nothing is
		// failed/parser_error, the verdict every other runner gives it; the plain
		// skip this runner kept disagreed with its own parse-error arm.
		it("prisma reports a completed run with nothing parsed as failed/parser_error", async () => {
			const result = await runPrisma({
				error: null,
				status: 1,
				stdout: "Prisma schema loaded from schema.prisma",
				stderr: "",
			});
			expect(result.status).toBe("failed");
			expect(result.failureKind).toBe("parser_error");
			expect(result.skipFault).toBeUndefined();
		});
	});

	it("surfaces a warning when zig exits non-zero without structured diagnostics", async () => {
		const env = setupTestEnvironment("pi-lens-zig-runner-");
		try {
			const filePath = path.join(env.tmpDir, "src", "main.zig");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "pub fn main() void {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "zig failed before emitting diagnostics",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/zig-check.js")
			).default;

			const result = await runner.run(
				createCtx("zig", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.id).toBe("zig-check:parse-error:1");
		} finally {
			env.cleanup();
		}
	});

	it("keeps context-free zig compiler diagnostics non-blocking", async () => {
		const env = setupTestEnvironment("pi-lens-zig-contextless-");
		try {
			const filePath = path.join(env.tmpDir, "src", "main.zig");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "pub fn main() void {}\n");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: `${filePath}:2:1: error: unable to load module`,
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/zig-check.js")
			).default;
			const result = await runner.run(
				createCtx("zig", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.semantic).toBe("warning");
		} finally {
			env.cleanup();
		}
	});

	it("surfaces a runner-fault warning, never a blocker, when gleam exits non-zero without structured output (#4130)", async () => {
		const env = setupTestEnvironment("pi-lens-gleam-runner-");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.gleam");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "pub fn main() { Nil }\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "gleam check failed unexpectedly",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/gleam-check.js")
			).default;

			const result = await runner.run(
				createCtx("gleam", filePath, env.tmpDir) as never,
			);

			expect(result.status).toBe("failed");
			expect(result.failureKind).toBe("unconfirmed_output");
			expect(result.semantic).toBe("warning");
			expect(result.diagnostics[0]?.message).toContain("gleam check failed");
			expect(result.diagnostics[0]).toMatchObject({
				runnerFault: true,
				semantic: "warning",
			});
		} finally {
			env.cleanup();
		}
	});

	// #4130, through the commit gate's absorb path: a settled collect-later
	// gleam fault never enters the blocker map (#3814). The runtime chain loads
	// inside the case because the mocked spawn module is not initialized when
	// static imports run.
	it("keeps a gleam runner fault out of the blocker map when it settles as a collect-later answer (#4130)", async () => {
		const env = setupTestEnvironment("pi-lens-gleam-fault-blocker-");
		const pendingStore =
			await import("../../../../clients/dispatch/pending-runner-findings.js");
		try {
			const filePath = path.join(env.tmpDir, "src", "app.gleam");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "pub fn main() { Nil }\n");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: "gleam check failed unexpectedly",
			});
			const runner = (
				await import("../../../../clients/dispatch/runners/gleam-check.js")
			).default;
			const result = await runner.run(
				createCtx("gleam", filePath, env.tmpDir) as never,
			);
			const { absorbSettledRunnerBlockers } =
				await import("../../../../clients/deferred-runner-blockers.js");
			const { RuntimeCoordinator } =
				await import("../../../../clients/runtime-coordinator.js");
			const runtime = new RuntimeCoordinator();
			pendingStore.deferRunnerFindings({
				filePath,
				cwd: env.tmpDir,
				projectRoot: env.tmpDir,
				runnerId: "gleam-check",
				markedAtMs: Date.now() + 60_000,
				promise: Promise.resolve(result),
			});
			await pendingStore.settlePendingRunnerFindingsForTests();

			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(0);
			expect(runtime.getInlineBlockerDiagnostics(filePath) ?? []).toEqual([]);
		} finally {
			pendingStore.resetPendingRunnerFindings();
			env.cleanup();
		}
	});

	it("keeps a clean elixir run with no output clean through dispatch (#1816)", async () => {
		// Prevents the empty-output guard from swallowing the ordinary clean
		// save: exit 0 with neither stream written is a clean file, not a
		// degraded run. The opposite direction of `guards elixir empty output`.
		const observed = await dispatchOutcome("elixir-check", "clean", {
			error: null,
			status: 0,
			stdout: "",
			stderr: "",
		});
		expect(observed.status).toBe("succeeded");
		expect(observed.diagnostics).toEqual([]);
		expect(observed.output).toBe("");
		expect(observed.ledger).toEqual([]);
	});

	it("guards elixir nonzero unparseable stdout through dispatch (#1816)", async () => {
		// Prevents a failed Mix run whose stdout the parser cannot read from
		// being rendered as a clean file (#1781 shape).
		const observed = await dispatchOutcome("elixir-check", "unparseable", {
			error: null,
			status: 1,
			stdout: "elixir compiler failed before emitting diagnostics",
			stderr: "",
		});
		expect(observed.status).toBe("failed");
		expect(observed.semantic).toBe("warning");
		expect(observed.diagnostics[0]?.id).toBe("elixir-check:parse-error:1");
		expect(observed.ledger[0]?.kind).toBe("runner-parsed-nothing");
	});

	it("guards elixir stderr-only nonzero output through dispatch (#1816)", async () => {
		// Mix writes its compiler diagnostics to stderr, so a runner that
		// parsed stdout alone would call every failing compile clean.
		const observed = await dispatchOutcome("elixir-check", "stderr-only", {
			error: null,
			status: 1,
			stdout: "",
			stderr: "elixir compiler failed before emitting diagnostics",
		});
		expect(observed.status).toBe("failed");
		expect(observed.semantic).toBe("warning");
		expect(observed.diagnostics[0]?.id).toBe("elixir-check:parse-error:1");
		expect(observed.ledger[0]?.kind).toBe("runner-parsed-nothing");
	});

	it("guards elixir empty output through dispatch (#1816)", async () => {
		// Prevents a failed Mix run with no parser input from becoming clean.
		const observed = await dispatchOutcome("elixir-check", "empty", {
			error: null,
			status: 1,
			stdout: "",
			stderr: "",
		});
		expect(observed.status).toBe("skipped");
		expect(observed.output).toContain("not a clean result");
		expect(observed.ledger[0]?.latestReasons[0]?.reason).toContain("no output");
	});

	it("guards elixir signal termination through dispatch (#1816)", async () => {
		// Prevents a signal-killed Mix run from becoming a clean rendered result.
		const observed = await dispatchOutcome("elixir-check", "signal", {
			error: null,
			status: null,
			signal: "SIGTERM",
			stdout: "",
			stderr: "",
		});
		expect(observed.status).toBe("skipped");
		expect(observed.output).toContain("not a clean result");
		expect(observed.ledger[0]?.latestReasons[0]?.reason).toContain("SIGTERM");
	});

	it("keeps elixir status-0 stderr noise clean through dispatch (#1816)", async () => {
		// Prevents harmless Mix stderr noise from becoming a false diagnostic.
		const observed = await dispatchOutcome("elixir-check", "stderr-noise", {
			error: null,
			status: 0,
			stdout: "",
			stderr: "Compiling 1 file (.ex)\n",
		});
		expect(observed.status).toBe("succeeded");
		expect(observed.output).toBe("");
		expect(observed.ledger).toEqual([]);
	});

	it("guards elixir rejection through dispatch (#1816)", async () => {
		// Prevents a rejected Mix invocation from becoming a clean rendered result.
		const observed = await dispatchOutcome("elixir-check", "rejected", {
			error: null,
			status: 2,
			stdout: "",
			stderr: "unknown Mix option",
		});
		expect(observed.status).toBe("failed");
		expect(observed.diagnostics[0]?.id).toBe("elixir-check:parse-error:1");
		expect(observed.ledger[0]?.kind).toBe("runner-parsed-nothing");
	});

	it("guards actual elixir unavailability through dispatch (#1816)", async () => {
		// Prevents absent Mix and elixirc binaries from being reported as clean.
		const observed = await dispatchOutcome(
			"elixir-check",
			"unavailable",
			{ error: null, status: 0, stdout: "", stderr: "" },
			{ available: false },
		);
		expect(observed.status).toBe("skipped");
		expect(observed.output).toContain("not a clean result");
		expect(observed.spawnCalls).toBe(0);
		expect(observed.ledger).toEqual([]);
	});

	it("real dispatcher renders an elixir nonzero finding (#1816)", async () => {
		const env = setupTestEnvironment("pi-lens-elixir-dispatch-witness-");
		try {
			const filePath = path.join(env.tmpDir, "lib", "app.ex");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(
				path.join(env.tmpDir, "mix.exs"),
				"defmodule Demo.MixProject do end\n",
			);
			fs.writeFileSync(filePath, "defmodule App do\n");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "",
				stderr: `** (SyntaxError) lib/app.ex:1:1: unexpected end of file`,
			});
			const { createDispatchContext, dispatchForFile, RunnerRegistry } =
				await import("../../../../clients/dispatch/dispatcher.js");
			const runner = (
				await import("../../../../clients/dispatch/runners/elixir-check.js")
			).default;
			const registry = new RunnerRegistry();
			registry.register(runner);
			let observedStatus: string | undefined;
			const result = await dispatchForFile(
				createDispatchContext(
					filePath,
					env.tmpDir,
					{ getFlag: () => false },
					new FactStore(),
				),
				[{ mode: "all", runnerIds: ["elixir-check"] }],
				registry,
				(_runnerId, runnerResult) => {
					observedStatus = runnerResult.status;
				},
			);
			expect(observedStatus).toBe("failed");
			expect(result.output).toContain("🔴 STOP — 1 issue(s) must be fixed:");
			await expect(result.output).toMatchFileSnapshot(
				"../../../fixtures/witness/runner-outcome-dart-analyze-elixir-check/elixir-nonzero-findings.txt",
			);
		} finally {
			env.cleanup();
		}
	});

	it("keeps standalone elixirc diagnostics non-blocking through dispatch (#1816)", async () => {
		// A direct `elixirc` invocation cannot resolve Mix dependencies, so its
		// findings must inform without blocking — and must not reach the model
		// as a STOP the way the Mix-context render does.
		const observed = await dispatchOutcome(
			"elixir-check",
			"elixirc-contextless",
			{
				error: null,
				status: 1,
				stdout: "",
				stderr:
					"** (CompileError) lib/app.ex:1:1: module Dependency is not loaded",
			},
			{ mixProject: false },
		);
		expect(observed.status).toBe("succeeded");
		expect(observed.semantic).toBe("warning");
		expect(observed.diagnostics[0]?.semantic).toBe("warning");
		expect(observed.output).not.toContain("🔴 STOP");
	});

	it("matches an elixir diagnostic whose reported path uses a backslash separator (#1193)", async () => {
		// D4. The separator direction #3256 declined this member for, now
		// decided and pinned: the identity seam slash-folds on EVERY platform,
		// so `lib\app.ex` and `lib/app.ex` name one file on the ubuntu lane
		// too. Folding can only merge, never split, and the pre-fix failure
		// mode was a dropped finding — so this is the safe direction. A POSIX
		// file literally named `lib\app.ex` alongside `lib/app.ex` is the
		// price, recorded in the PR body.
		const observed = await dispatchOutcome(
			"elixir-check",
			"backslash-spelling",
			{
				error: null,
				status: 1,
				stdout: "",
				stderr: [
					"    error: undefined function boom/0",
					"    └─ lib\\app.ex:4:5: App.greet/0",
				].join("\n"),
			},
		);
		expect(observed.diagnostics.map((d) => d.id)).toEqual([
			"elixir-check-error-4-5",
		]);
		expect(observed.output).toContain("undefined function boom/0");
	});

	it("treats a case-variant elixir path exactly as this filesystem does (#1193)", async () => {
		// D2/D3, both directions in one cell. `lib/App.ex` is a DIFFERENT file
		// from `lib/app.ex` on a case-sensitive host and the SAME file on a
		// case-folding one, and the seam asks the filesystem rather than
		// asserting a platform. This is the over-merge guard: an unconditional
		// fold reds it on ubuntu, and dropping the fold reds it on the
		// windows-vitest and macOS lanes.
		const observed = await dispatchOutcome("elixir-check", "case-variant", {
			error: null,
			status: 1,
			stdout: "",
			stderr: [
				"    error: undefined function boom/0",
				"    └─ lib/App.ex:4:5: App.greet/0",
			].join("\n"),
		});
		expect(
			observed.diagnostics.filter((d) => d.id === "elixir-check-error-4-5"),
		).toHaveLength(HOST_FOLDS_PATH_CASE ? 1 : 0);
	});
});
