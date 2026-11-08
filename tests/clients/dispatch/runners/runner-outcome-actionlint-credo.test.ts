import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.hoisted(() => vi.fn());
// Drives the `--version` probe both runners make through the real
// availability seams (the resolver for actionlint, the cwd probe for credo).
let toolAvailable = true;
const toolNotFound = {
	error: new Error("spawn ENOENT"),
	status: null,
	stdout: "",
	stderr: "",
	spawnFailure: { kind: "tool-not-found" },
};

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/safe-spawn.js")
	>()),
	safeSpawnAsync,
}));

type Tool = "actionlint" | "credo";
type SpawnResult = {
	error?: Error | null;
	status: number | null;
	signal?: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

async function dispatchOutcome(tool: Tool, result: SpawnResult) {
	vi.resetModules();
	const env = setupTestEnvironment(`pi-lens-${tool}-outcome-`);
	try {
		const filePath = path.join(
			env.tmpDir,
			tool === "actionlint" ? ".github/workflows/ci.yml" : "lib/example.ex",
		);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(
			filePath,
			tool === "actionlint" ? "name: CI\n" : "defmodule Example do\nend\n",
		);
		if (tool === "credo")
			fs.writeFileSync(
				path.join(env.tmpDir, "mix.exs"),
				"defmodule MixProject do\nend\n",
			);
		safeSpawnAsync.mockImplementation(
			async (_command: string, args: string[]) => {
				if (!args.includes("--version")) return result;
				return toolAvailable
					? { error: null, status: 0, stdout: "credo 1.7", stderr: "" }
					: toolNotFound;
			},
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
		let status = "";
		const output = await dispatchForFile(
			createDispatchContext(
				filePath,
				env.tmpDir,
				{ getFlag: () => false },
				new FactStore(),
			),
			[{ mode: "all", runnerIds: [tool] }],
			registry,
			(_id, result) => {
				status = result.status;
			},
		);
		return { status, output: output.output, ledger: getDegradationSummary() };
	} finally {
		env.cleanup();
	}
}

async function dispatchEmptyPair(tool: Tool) {
	vi.resetModules();
	const env = setupTestEnvironment(`pi-lens-${tool}-outcome-pair-`);
	try {
		const firstPath = path.join(
			env.tmpDir,
			tool === "actionlint" ? ".github/workflows/first.yml" : "lib/first.ex",
		);
		const secondPath = path.join(
			env.tmpDir,
			tool === "actionlint" ? ".github/workflows/second.yml" : "lib/second.ex",
		);
		for (const filePath of [firstPath, secondPath]) {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(
				filePath,
				tool === "actionlint" ? "name: CI\n" : "defmodule Example do\nend\n",
			);
		}
		if (tool === "credo")
			fs.writeFileSync(
				path.join(env.tmpDir, "mix.exs"),
				"defmodule MixProject do\nend\n",
			);
		safeSpawnAsync.mockImplementation(
			async (_command: string, args: string[]) =>
				args.includes("--version")
					? { error: null, status: 0, stdout: "credo 1.7", stderr: "" }
					: { error: null, status: 1, stdout: "", stderr: "" },
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
		const facts = new FactStore();
		for (const filePath of [firstPath, secondPath]) {
			await dispatchForFile(
				createDispatchContext(
					filePath,
					env.tmpDir,
					{ getFlag: () => false },
					facts,
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

const findings = {
	actionlint: JSON.stringify([
		{
			message: "bad workflow",
			filepath: ".github/workflows/ci.yml",
			line: 2,
			column: 3,
			kind: "syntax",
		},
	]),
	credo: JSON.stringify({
		issues: [
			{
				filename: "lib/example.ex",
				line_no: 2,
				column: 1,
				message: "bad credo",
				category: "Style",
				check: "Credo.Check",
				priority: 5,
			},
		],
	}),
};

describe("actionlint and credo shared runner outcome seam (#1816)", () => {
	beforeEach(() => {
		safeSpawnAsync.mockReset();
		toolAvailable = true;
	});

	for (const tool of ["actionlint", "credo"] as const) {
		it.each([
			["clean", { status: 0, stdout: "", stderr: "" }, "succeeded"],
			[
				"clean-with-stderr-noise",
				{ status: 0, stdout: "", stderr: "actionlint summary noise" },
				"succeeded",
			],
			["findings", { status: 1, stdout: findings[tool], stderr: "" }, "failed"],
			["empty", { status: 1, stdout: "", stderr: "" }, "skipped"],
			["parse-error", { status: 1, stdout: "", stderr: "not JSON" }, "failed"],
			["stderr-only", { status: 1, stdout: "", stderr: "not JSON" }, "failed"],
			[
				"signal",
				{ status: null, stdout: "", stderr: "", signal: "SIGTERM" as const },
				"skipped",
			],
			[
				"rejected",
				{ status: 2, stdout: "", stderr: "unknown option" },
				"failed",
			],
		])("%s preserves the shared outcome", async (_row, result, expected) => {
			const observed = await dispatchOutcome(tool, { error: null, ...result });
			expect(observed.status).toBe(expected);
			if (expected === "skipped")
				expect(observed.ledger[0]?.latestReasons[0]?.subject).toBe(tool);
		});

		// #5437 review F4: this toggle used to drive a checker double the
		// actionlint runner no longer calls, so the cell passed vacuously.
		it(`${tool}: unavailable does not report clean`, async () => {
			toolAvailable = false;
			const observed = await dispatchOutcome(tool, {
				error: new Error("missing"),
				status: null,
				stdout: "",
				stderr: "",
			});
			expect(observed.status).toBe("skipped");
		});

		it(`${tool}: nonzero empty output is one bounded ledger row across two files`, async () => {
			const summary = await dispatchEmptyPair(tool);
			const rows = summary.filter((row) => row.kind === "runner-empty-result");
			expect(rows).toHaveLength(1);
			expect(rows[0]?.latestReasons[0]?.subject).toBe(tool);
			expect(rows[0]?.count).toBe(2);
		});
	}

	it("actionlint pins the real JSON output format instead of claiming a text parser", async () => {
		await dispatchOutcome("actionlint", {
			error: null,
			status: 1,
			stdout: findings.actionlint,
			stderr: "",
		});
		expect(safeSpawnAsync).toHaveBeenCalledWith(
			expect.any(String),
			["-format", "{{json .}}", expect.any(String)],
			expect.objectContaining({ timeout: 15000 }),
		);
	});

	it.each(["actionlint", "credo"] as const)(
		"renders the %s witness golden through the STOP delivery surface",
		async (tool) => {
			const observed = await dispatchOutcome(tool, {
				error: null,
				status: 1,
				stdout: findings[tool],
				stderr: "",
			});
			expect(observed.output.trim()).toBe(
				fs
					.readFileSync(
						path.resolve(
							"tests/fixtures/witness/runner-outcome-actionlint-credo",
							`${tool}.txt`,
						),
						"utf8",
					)
					.trim(),
			);
		},
	);
});
