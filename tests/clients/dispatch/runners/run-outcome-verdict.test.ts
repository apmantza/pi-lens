/**
 * #5411: one run-outcome verdict. The same exit, output or timeout used to read
 * `succeeded`, `failed` or `skipped` depending on which runner reported it.
 * Every case here drives a real runner's `run()` and replaces only the process
 * boundary (`safeSpawnAsync`), so the verdict under test is the one the runner
 * returns, not a restatement of the seam.
 *
 * Recurrence this guards: the 2026-11-08 tool-alignment audit probed
 * `exit 1 + "still not json"` through vale, swiftlint, ruff and taplo and got
 * succeeded / succeeded / failed / skipped, and a ruff deprecation warning on
 * stderr turned a valid F401 report into `ruff:parse-error`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import {
	listCapturedOutputs,
	materialize,
} from "../../../helpers/captured-runner-output.js";
import { setupTestEnvironment } from "../../test-utils.js";

// Only the process boundary is replaced. The availability checker, the install
// resolver and the config policy are the real ones: each tool gets a presence
// stub on a PATH of this suite's own, as captured-real-output.test.ts does, and
// every spawn that is not the analysed file's own run answers as a healthy
// `--version` probe.
const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));

vi.mock("../../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	safeSpawnAsync,
}));

const FIXTURE_DETEKT_WORKSPACE = fileURLToPath(
	new URL(
		"../../../fixtures/runner-exit-codes/detekt/workspace/",
		import.meta.url,
	),
);

interface SpawnAnswer {
	stdout?: string;
	stderr?: string;
	status: number | null;
	signal?: NodeJS.Signals | null;
	error?: Error;
	failure?: string;
	spawnFailure?: { kind: string };
}

interface Tool {
	/** Runner module basename. */
	module: string;
	/** Dispatch kind the runner's `appliesTo` declares. */
	kind: string;
	/** Analysed file, relative to the workspace. */
	file: string;
	/** Files that gate the runner, written before the run. */
	setup?: (dir: string) => void;
	/** The exit status inside the tool's own `ran` table. */
	ranStatus: number;
}

const TOOLS: Record<string, Tool> = {
	vale: {
		module: "vale",
		kind: "markdown",
		file: "doc.md",
		ranStatus: 1,
		setup: (dir) =>
			fs.writeFileSync(path.join(dir, ".vale.ini"), "StylesPath = styles\n"),
	},
	swiftlint: {
		module: "swiftlint",
		kind: "swift",
		file: "a.swift",
		ranStatus: 1,
	},
	ruff: { module: "ruff", kind: "python", file: "sample.py", ranStatus: 1 },
	taplo: { module: "taplo", kind: "toml", file: "config.toml", ranStatus: 1 },
	detekt: {
		module: "detekt",
		kind: "kotlin",
		file: "Bad.kt",
		ranStatus: 1,
		setup: (dir) =>
			fs.cpSync(FIXTURE_DETEKT_WORKSPACE, dir, { recursive: true }),
	},
	spellcheck: {
		module: "spellcheck",
		kind: "markdown",
		file: "doc.md",
		ranStatus: 2,
	},
	credo: {
		module: "credo",
		kind: "elixir",
		file: "lib/example.ex",
		ranStatus: 1,
		setup: (dir) =>
			fs.writeFileSync(
				path.join(dir, "mix.exs"),
				"defmodule MixProject do\nend\n",
			),
	},
	rubocop: { module: "rubocop", kind: "ruby", file: "a.rb", ranStatus: 1 },
	shellcheck: {
		module: "shellcheck",
		kind: "shell",
		file: "a.sh",
		ranStatus: 1,
	},
};

async function runTool(
	name: keyof typeof TOOLS,
	answer: SpawnAnswer,
	/** Analysed file, when a captured report names its own. */
	file: string = TOOLS[name].file,
): Promise<
	Awaited<
		ReturnType<
			import("../../../../clients/dispatch/types.js").RunnerDefinition["run"]
		>
	>
> {
	const tool = TOOLS[name];
	const env = setupTestEnvironment(`pi-lens-5411-${name}-`);
	try {
		tool.setup?.(env.tmpDir);
		const filePath = path.join(env.tmpDir, file);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "x\n");
		// Availability probes (`--version`) answer cleanly; only the lint spawn
		// returns the case under test.
		safeSpawnAsync.mockImplementation(
			async (_cmd: string, args: string[] = []) =>
				args.some((arg) => arg.endsWith(file))
					? { error: null, signal: null, stdout: "", stderr: "", ...answer }
					: { error: null, status: 0, stdout: "tool 1.0.0", stderr: "" },
		);
		const runner = (
			await import(`../../../../clients/dispatch/runners/${tool.module}.js`)
		).default;
		return await runner.run({
			filePath,
			cwd: env.tmpDir,
			kind: tool.kind,
			fileRole: "source",
			pi: { getFlag: (flag: string) => flag === "no-lsp" },
			autofix: false,
			deltaMode: true,
			facts: new FactStore(),
			hasTool: async () => true,
			log: () => {},
		} as never);
	} finally {
		env.cleanup();
	}
}

const TIMED_OUT: SpawnAnswer = {
	status: null,
	signal: "SIGTERM",
	error: new Error("Process timed out after 15000ms (killed with SIGTERM)"),
	failure: "timeout",
	spawnFailure: { kind: "timeout" },
};

describe("one run-outcome verdict (#5411)", () => {
	const presenceStub = setupTestEnvironment("pi-lens-5411-bin-");
	const originalPath = process.env.PATH;

	beforeAll(() => {
		for (const name of [
			"vale",
			"swiftlint",
			"ruff",
			"taplo",
			"detekt",
			"typos",
			"mix",
			"rubocop",
			"shellcheck",
		]) {
			fs.writeFileSync(path.join(presenceStub.tmpDir, name), "#!/bin/sh\n", {
				mode: 0o755,
			});
		}
		process.env.PATH = `${presenceStub.tmpDir}${path.delimiter}${originalPath ?? ""}`;
	});

	afterAll(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		presenceStub.cleanup();
	});

	beforeEach(() => {
		vi.resetModules();
		safeSpawnAsync.mockReset();
	});

	// Before: vale/swiftlint/spellcheck `succeeded`, taplo/detekt `skipped`, the
	// finishParsedRun runners (ruff) `failed/parser_error`. A tool that exits
	// nonzero and prints something the parser cannot read has not said the file
	// is clean, and has not failed to run: the reader disagrees with the tool.
	it.each([
		"vale",
		"swiftlint",
		"ruff",
		"taplo",
		"detekt",
		"spellcheck",
	] as const)(
		"%s: a nonzero exit with unreadable output is failed/parser_error",
		async (name) => {
			const result = await runTool(name, {
				status: TOOLS[name].ranStatus,
				stdout: "still not json",
			});
			expect({
				status: result.status,
				failureKind: result.failureKind,
				diagnosticIds: result.diagnostics.map((d) => d.id),
			}).toEqual({
				status: "failed",
				failureKind: "parser_error",
				diagnosticIds: [`${name}:parse-error:1`],
			});
			expect(result.diagnostics[0]?.runnerFault).toBe(true);
		},
	);

	// Before: a tool that timed out was `skipped` (did not run) through the seam
	// and `failed/timeout` through helm-lint, rust-clippy and helm-render.
	it("swiftlint: a timeout is a skipped run that did not run", async () => {
		const result = await runTool("swiftlint", TIMED_OUT);
		expect(result).toMatchObject({
			status: "skipped",
			skipFault: "did-not-run",
			diagnostics: [],
		});
	});

	describe("a deprecation warning on stderr beside a valid report", () => {
		const NOISE =
			"warning: The top-level linter settings are deprecated in favour of their counterparts in the `lint` section.\n";

		function captured(runnerId: string) {
			const fixture = listCapturedOutputs().find(
				(f) => f.provenance.runner === runnerId && f.caseName === "real",
			);
			if (!fixture) throw new Error(`no captured fixture for ${runnerId}`);
			return fixture;
		}

		// Before: ruff, rubocop, credo and shellcheck handed the parser
		// stdout+stderr, so the warning corrupted a valid JSON document and the
		// real F401 finding came back as `<tool>:parse-error:1`. The real ruff
		// 0.17.3 does exactly this for a top-level `select` in pyproject.
		it.each([
			["ruff", "ruff-lint"],
			["rubocop", "rubocop"],
			["shellcheck", "shellcheck"],
		] as const)(
			"%s reports the captured finding, not a parse error",
			async (name, runnerId) => {
				const fixture = captured(runnerId);
				const workspace = path.join("/ws", name);
				const bytes = materialize(fixture, workspace);
				const result = await runTool(
					name,
					{ status: bytes.status, stdout: bytes.stdout, stderr: NOISE },
					fixture.file,
				);
				expect(result.diagnostics.length).toBeGreaterThan(0);
				expect(result.failureKind).not.toBe("parser_error");
				expect(
					result.diagnostics.some((d) => d.id.includes("parse-error")),
				).toBe(false);
			},
		);

		it("credo reports its finding, not a parse error", async () => {
			const result = await runTool("credo", {
				status: 1,
				stdout: JSON.stringify({
					issues: [
						{
							filename: "lib/example.ex",
							line_no: 1,
							column: 1,
							message: "Modules should have a @moduledoc tag.",
							category: "readability",
							check: "Credo.Check.Readability.ModuleDoc",
							priority: 20,
						},
					],
				}),
				stderr: NOISE,
			});
			expect(result.diagnostics.map((d) => d.rule)).toEqual([
				"Credo.Check.Readability.ModuleDoc",
			]);
			expect(result.failureKind).not.toBe("parser_error");
		});

		// The stderr fallback: stdout carries nothing, so a failing tool's own
		// error text is what the parser (and the verdict) must see. Without it
		// the run reads as "nothing to parse" and is skipped as did-not-run.
		it("ruff still reads stderr when stdout is empty and the exit is nonzero", async () => {
			const result = await runTool("ruff", {
				status: 2,
				stdout: "",
				stderr: "error: Failed to parse pyproject.toml\n",
			});
			expect(result).toMatchObject({
				status: "failed",
				failureKind: "parser_error",
			});
		});
	});
});
