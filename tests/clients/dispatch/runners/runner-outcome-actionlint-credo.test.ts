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
		if (!toolAvailable) {
			// The unavailable case must not inherit a host PATH binary or a managed
			// copy from another test/process. Keep both discovery roots fixture-local.
			const emptyPath = path.join(env.tmpDir, "empty-path");
			fs.mkdirSync(emptyPath);
			vi.stubEnv("PATH", emptyPath);
			vi.stubEnv("PI_LENS_HOME", path.join(env.tmpDir, "pi-lens-home"));
			vi.stubEnv("PI_LENS_DISABLE_TOOL_INSTALL", "1");
		}
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
		vi.unstubAllEnvs();
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

const credoBitmaskFixtures = {
	readability: fs.readFileSync(
		"tests/fixtures/witness/runner-outcome-actionlint-credo/credo-readability.json",
		"utf8",
	),
	mixed: fs.readFileSync(
		"tests/fixtures/witness/runner-outcome-actionlint-credo/credo-mixed.json",
		"utf8",
	),
};

const credoBitmaskStatusCells = [
	{ status: 1 },
	{ status: 2 },
	{ status: 3 },
	{ status: 4 },
	{ status: 5 },
	{ status: 6 },
	{ status: 7 },
	{ status: 8 },
	{ status: 9 },
	{ status: 10 },
	{ status: 11 },
	{ status: 12 },
	{ status: 13 },
	{ status: 14 },
	{ status: 15 },
	{ status: 16 },
	{ status: 17 },
	{ status: 18 },
	{ status: 19 },
	{ status: 20 },
	{ status: 21 },
	{ status: 22 },
	{ status: 23 },
	{ status: 24 },
	{ status: 25 },
	{ status: 26 },
	{ status: 27 },
	{ status: 28 },
	{ status: 29 },
	{ status: 30 },
	{ status: 31 },
	{ status: 32 },
	{ status: 33 },
	{ status: 34 },
	{ status: 35 },
	{ status: 36 },
	{ status: 37 },
	{ status: 38 },
	{ status: 39 },
	{ status: 40 },
	{ status: 41 },
	{ status: 42 },
	{ status: 43 },
	{ status: 44 },
	{ status: 45 },
	{ status: 46 },
	{ status: 47 },
	{ status: 48 },
	{ status: 49 },
	{ status: 50 },
	{ status: 51 },
	{ status: 52 },
	{ status: 53 },
	{ status: 54 },
	{ status: 55 },
	{ status: 56 },
	{ status: 57 },
	{ status: 58 },
	{ status: 59 },
	{ status: 60 },
	{ status: 61 },
	{ status: 62 },
	{ status: 63 },
	{ status: 64 },
	{ status: 65 },
	{ status: 66 },
	{ status: 67 },
	{ status: 68 },
	{ status: 69 },
	{ status: 70 },
	{ status: 71 },
	{ status: 72 },
	{ status: 73 },
	{ status: 74 },
	{ status: 75 },
	{ status: 76 },
	{ status: 77 },
	{ status: 78 },
	{ status: 79 },
	{ status: 80 },
	{ status: 81 },
	{ status: 82 },
	{ status: 83 },
	{ status: 84 },
	{ status: 85 },
	{ status: 86 },
	{ status: 87 },
	{ status: 88 },
	{ status: 89 },
	{ status: 90 },
	{ status: 91 },
	{ status: 92 },
	{ status: 93 },
	{ status: 94 },
	{ status: 95 },
	{ status: 96 },
	{ status: 97 },
	{ status: 98 },
	{ status: 99 },
	{ status: 100 },
	{ status: 101 },
	{ status: 102 },
	{ status: 103 },
	{ status: 104 },
	{ status: 105 },
	{ status: 106 },
	{ status: 107 },
	{ status: 108 },
	{ status: 109 },
	{ status: 110 },
	{ status: 111 },
	{ status: 112 },
	{ status: 113 },
	{ status: 114 },
	{ status: 115 },
	{ status: 116 },
	{ status: 117 },
	{ status: 118 },
	{ status: 119 },
	{ status: 120 },
	{ status: 121 },
	{ status: 122 },
	{ status: 123 },
	{ status: 124 },
	{ status: 125 },
	{ status: 126 },
	{ status: 127 },
];

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
			// The availability verdict, not the lint spawn's own failure, skips it.
			expect(
				safeSpawnAsync.mock.calls.filter(
					([, args]) => !(args as string[]).includes("--version"),
				),
			).toEqual([]);
		});

		it(`${tool}: nonzero empty output is one bounded ledger row across two files`, async () => {
			const summary = await dispatchEmptyPair(tool);
			const rows = summary.filter((row) => row.kind === "runner-empty-result");
			expect(rows).toHaveLength(1);
			expect(rows[0]?.latestReasons[0]?.subject).toBe(tool);
			expect(rows[0]?.count).toBe(2);
		});
	}

	it.each([
		["Readability", 4, credoBitmaskFixtures.readability, "ModuleDoc"],
		["mixed categories", 6, credoBitmaskFixtures.mixed, "TagTODO"],
	])(
		"credo reports real %s output for bitmask exit %s",
		async (_name, status, stdout, rule) => {
			const observed = await dispatchOutcome("credo", {
				error: null,
				status,
				stdout,
				stderr: "",
			});
			expect(observed.status).toBe("failed");
			expect(observed.output).toContain(rule);
		},
	);

	it("credo accepts every category bitmask status", async () => {
		for (const { status } of credoBitmaskStatusCells) {
			const observed = await dispatchOutcome("credo", {
				error: null,
				status: status,
				stdout: credoBitmaskFixtures.readability,
				stderr: "",
			});
			expect(observed.status).toBe("failed");
		}
	});

	it("credo rejects an invocation error status above the bitmask", async () => {
		const observed = await dispatchOutcome("credo", {
			error: null,
			status: 128,
			stdout: credoBitmaskFixtures.readability,
			stderr: "unknown option",
		});
		expect(observed.status).toBe("skipped");
	});

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
