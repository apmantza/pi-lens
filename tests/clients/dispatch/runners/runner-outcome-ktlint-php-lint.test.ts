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
	getAutofixCapability: () => undefined,
	getLinterPolicyForCwd: () => undefined,
}));
vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailableAsync: async () => available,
			getVerdict: () => ({
				outcome: "missing",
				cause: "not-found",
				elapsedMs: 0,
				latched: true,
				retryAtMs: 0,
			}),
			getCommand: () => command,
		}),
		resolveToolCommandWithInstallFallback: async () =>
			available ? "ktlint" : null,
	}),
);

type Tool = "ktlint" | "php-lint";
type SpawnResult = {
	error?: Error | null;
	status: number | null;
	signal?: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

const wire: Record<Tool, string> = {
	ktlint: JSON.stringify([
		{
			file: "Main.kt",
			errors: [
				{
					line: 2,
					column: 3,
					message: "Missing spacing",
					rule: "standard:spacing",
				},
			],
		},
	]),
	"php-lint":
		'PHP Parse error:  syntax error, unexpected token "}" in Main.php on line 3\nErrors parsing Main.php',
};

async function dispatchOutcome(tool: Tool, result: SpawnResult) {
	vi.resetModules();
	const env = setupTestEnvironment(`pi-lens-${tool}-outcome-`);
	try {
		const extension = tool === "ktlint" ? "kt" : "php";
		const filePath = path.join(env.tmpDir, `Main.${extension}`);
		fs.writeFileSync(filePath, "bad source\n");
		safeSpawnAsync.mockResolvedValue(result);
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
				`${name}.${tool === "ktlint" ? "kt" : "php"}`,
			);
			fs.writeFileSync(filePath, "bad source\n");
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

describe("JSON/text runner outcome seam (#1816)", () => {
	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
		available = true;
	});

	// Recurrence (#4522): ktlint 1.8.0 prints its own log lines on stdout around
	// the reporter's JSON (tests/fixtures/runner-output/ktlint/real.captured.json),
	// and the runner parsed the whole stream, so every finding replayed as a
	// parse error.
	it.each([
		["a log line before the report", "WARN before\n{report}\n"],
		[
			"log lines before and after the report",
			"WARN before\n{report}\n00:55:36.000 [main] INFO done [ok]\n",
		],
	])("ktlint: reads the findings with %s (#4522)", async (_name, template) => {
		const observed = await dispatchOutcome("ktlint", {
			error: null,
			status: 1,
			stdout: template.replace(
				"{report}",
				JSON.stringify(JSON.parse(wire.ktlint), null, 4),
			),
			stderr: "",
		});
		expect(observed.status).toBe("succeeded");
		expect(observed.diagnostics).toHaveLength(1);
		expect(JSON.stringify(observed.diagnostics)).toContain(
			"[standard:spacing] Missing spacing",
		);
	});

	for (const tool of ["ktlint", "php-lint"] as const) {
		it.each([
			["status 0 clean", { status: 0, stdout: "", stderr: "" }],
			["status 0 stderr noise", { status: 0, stdout: "", stderr: "banner" }],
		])(`${tool}: %s stays clean`, async (_name, result) => {
			const observed = await dispatchOutcome(tool, { error: null, ...result });
			expect(observed.status).toBe("succeeded");
			expect(observed.diagnostics).toEqual([]);
		});

		it.each(tool === "ktlint" ? [1, 2, 3] : [1, 255])(
			`${tool}: documented status %s findings survive`,
			async (status) => {
				const observed = await dispatchOutcome(tool, {
					error: null,
					status,
					stdout: tool === "ktlint" ? wire[tool] : "",
					stderr: tool === "php-lint" ? wire[tool] : "",
				});
				expect(observed.status).toBe(
					tool === "ktlint" ? "succeeded" : "failed",
				);
				expect(observed.diagnostics).toHaveLength(1);
				if (tool === "php-lint") {
					expect(observed.output.trim()).toBe(
						fs
							.readFileSync(
								path.resolve(
									"tests/fixtures/witness/runner-outcome-ktlint-php-lint/php-lint.txt",
								),
								"utf8",
							)
							.trim(),
					);
				}
			},
		);

		// The inverse direction of each per-tool exit table, and the proof that an
		// admission stays LOCAL: the status asserted here is one the SIBLING
		// runner admits (ktlint is handed php-lint's 255, php-lint is handed
		// ktlint's 2). #3291 round 2 threaded both tables through a shared
		// `parseToolRun` option whose undefined default erased eleven other
		// runners' tables; a widened or shared table makes this cell report the
		// findings instead of skipping.
		it(`${tool}: the sibling's admitted status stays rejected`, async () => {
			const observed = await dispatchOutcome(tool, {
				error: null,
				status: tool === "ktlint" ? 255 : 2,
				stdout: tool === "ktlint" ? wire[tool] : "",
				stderr: tool === "php-lint" ? wire[tool] : "",
			});
			expect(observed.status).toBe("skipped");
			expect(observed.diagnostics).toEqual([]);
			expect(observed.ledger[0]).toMatchObject({ kind: "runner-empty-result" });
		});

		it(`${tool}: nonzero text is a parse error`, async () => {
			const observed = await dispatchOutcome(tool, {
				error: null,
				status: 1,
				stdout: "",
				stderr: "tool configuration or execution error",
			});
			expect(observed.status).toBe("failed");
			expect(observed.diagnostics[0]).toMatchObject({
				id: `${tool}:parse-error:1`,
			});
		});

		it(`${tool}: nonzero empty output is not clean`, async () => {
			const observed = await dispatchOutcome(tool, {
				error: null,
				status: 1,
				stdout: "",
				stderr: "",
			});
			expect(observed.status).toBe("skipped");
			expect(observed.ledger[0]).toMatchObject({ kind: "runner-empty-result" });
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

		it(`${tool}: captures the complete command wire`, async () => {
			await dispatchOutcome(tool, {
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				expect.any(String),
				tool === "ktlint"
					? ["--reporter=json", expect.any(String)]
					: ["-l", expect.any(String)],
				expect.objectContaining({
					cwd: expect.any(String),
					timeout: expect.any(Number),
				}),
			);
		});

		it(`${tool}: two files keep one bounded ledger row`, async () => {
			const rows = await dispatchTwoEmptyFiles(tool);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ kind: "runner-empty-result", count: 2 });
		});
	}
});
