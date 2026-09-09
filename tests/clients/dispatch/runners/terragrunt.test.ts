import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { setupTestEnvironment } from "../../test-utils.js";

const safeSpawnAsync = vi.fn();
const ensureTool = vi.fn();
const getLinterPolicyForCwd = vi.fn();

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
}));

vi.mock("../../../../clients/installer/index.js", () => ({
	ensureTool,
}));

vi.mock("../../../../clients/tool-policy.js", () => ({
	getLinterPolicyForCwd,
}));

// Availability is a mutable flag behind ONE hoisted mock rather than a
// per-test vi.doMock: doMock registrations are resolved at import time and
// outlive resetModules, so which registration wins depended on test order.
const toolState = vi.hoisted(() => ({ available: true }));

vi.mock(
	"../../../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../../clients/dispatch/runners/utils/runner-helpers.js")
		>()),
		createAvailabilityChecker: (command: string) => ({
			isAvailableAsync: async () => toolState.available,
			getCommand: () => (toolState.available ? command : null),
		}),
		resolveAvailableOrInstall: async (_checker: unknown, toolId: string) =>
			toolState.available ? "terragrunt" : ensureTool(toolId),
	}),
);

function createCtx(filePath: string, cwd: string) {
	return makeRunnerCtx(filePath, cwd, { kind: "terragrunt" });
}

describe("terragrunt runner", () => {
	beforeEach(() => {
		vi.resetModules();
		toolState.available = true;
		safeSpawnAsync.mockReset();
		ensureTool.mockReset();
		getLinterPolicyForCwd.mockReset();
		getLinterPolicyForCwd.mockReturnValue({
			runnerNames: ["terragrunt"],
			preferredRunners: ["terragrunt"],
			defaultRunner: "terragrunt",
			defaultWhenUnconfigured: true,
			gate: "smart-default",
		});
	});

	it("runs terragrunt hcl validate from the edited file directory", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const nestedDir = path.join(env.tmpDir, "infra", "stack");
			fs.mkdirSync(nestedDir, { recursive: true });
			const filePath = path.join(nestedDir, "terragrunt.hcl");
			fs.writeFileSync(
				filePath,
				'include "root" {\n  path = find_in_parent_folders()\n}\n',
			);

			// Clean unit: terragrunt v1.1.2 prints NOTHING (empty stdout, exit 0).
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"terragrunt",
				["hcl", "validate", "--json", "--non-interactive"],
				expect.objectContaining({ cwd: nestedDir }),
			);
		} finally {
			env.cleanup();
		}
	});

	// Regression: terragrunt's `--filter` is component filter-syntax, NOT a
	// filename. A bare basename (`--filter=terragrunt.hcl`) matches zero
	// components, so terragrunt validates NOTHING — empirically exit 0 with empty
	// stdout even for a broken unit (verified on v1.1.2). The runner must NOT pass
	// --filter, or every real finding would be silently suppressed.
	it("does not pass a --filter argument (it would suppress all findings)", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			await runner.run(createCtx(filePath, env.tmpDir) as never);

			const args = safeSpawnAsync.mock.calls[0][1] as string[];
			expect(args.some((a) => a.startsWith("--filter"))).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	// TOLERANT FALLBACK shape — NOT what terragrunt v1.1.2 emits (it prints a flat
	// array with string severity, see the test below). Retained so the parser
	// keeps decoding a nested `invalid_files`/numeric-severity payload should a
	// different/older terragrunt build produce one.
	it("parses the nested invalid_files shape with numeric severity (tolerant fallback)", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					invalid_files: [
						{
							diagnostics: [
								{
									severity: 1,
									summary: "bad block",
									range: {
										filename: "terragrunt.hcl",
										start: { line: 3, column: 2 },
									},
								},
							],
						},
					],
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]).toMatchObject({
				line: 3,
				column: 2,
				severity: "error",
				semantic: "blocking",
				tool: "terragrunt",
			});
		} finally {
			env.cleanup();
		}
	});

	// REAL shape captured from terragrunt v1.1.2 (win-x64): a flat JSON array of
	// diagnostics with STRING severity, an ABSOLUTE `range.filename`, and
	// `summary`/`detail`/`snippet` fields. The filename is built from the test's
	// own tmp path so pathsEqual attribution holds on any OS (Linux CI included).
	it("parses the real flat array shape captured from terragrunt v1.1.2", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(
				filePath,
				'locals {\n  region = "us-east-1"\n}\n\ninputs = {\n  region = local.does_not_exist\n}\n',
			);

			// No `error`: findings are a normal nonzero exit, not a spawn failure.
			safeSpawnAsync.mockResolvedValue({
				status: 1,
				stdout: JSON.stringify([
					{
						range: {
							filename: filePath,
							start: { line: 6, column: 17, byte: 62 },
							end: { line: 6, column: 32, byte: 77 },
						},
						snippet: {
							context: "",
							code: "  region = local.does_not_exist",
							values: [],
							start_line: 6,
							highlight_start_offset: 16,
							highlight_end_offset: 31,
						},
						summary: "Unsupported attribute",
						detail:
							'This object does not have an attribute named "does_not_exist".',
						severity: "error",
					},
				]),
				// terragrunt logs a summary line to stderr alongside the JSON stdout.
				stderr: "ERROR  1 HCL validation error(s) found",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]).toMatchObject({
				line: 6,
				column: 17,
				severity: "error",
				semantic: "blocking",
				tool: "terragrunt",
				message: "Unsupported attribute",
			});
		} finally {
			env.cleanup();
		}
	});

	// A clean unit prints NOTHING on v1.1.2 (empty stdout, exit 0) — not `[]`.
	it("treats empty stdout from a clean unit as success with no findings", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "root.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("succeeded");
			expect(result.semantic).toBe("none");
			expect(result.diagnostics).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	// The mirror image of the test above, and the one that matters: an empty
	// stdout only means "clean" when the process also EXITED clean. A binary that
	// predates the `hcl` command group prints its usage error to stderr and exits
	// non-zero — safe-spawn reports that as `status: 1` with NO `error` (a nonzero
	// exit is not a spawn failure), so a guard keyed only on `error` lets it fall
	// through and report a clean run for a file nothing ever validated.
	it("skips when an older binary rejects the hcl command group", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				status: 1,
				stdout: "",
				stderr: 'Error: unknown command "hcl" for "terragrunt"',
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("skipped");
			expect(result.diagnostics).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("skips when the spawn times out before producing output", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: new Error("Process timed out after 30000ms"),
				failure: "timeout",
				status: null,
				stdout: "",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("skipped");
		} finally {
			env.cleanup();
		}
	});

	it("drops diagnostics reported against other files in the unit", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: JSON.stringify({
					invalid_files: [
						{
							diagnostics: [
								{
									severity: 1,
									summary: "problem elsewhere",
									range: {
										filename: "other.hcl",
										start: { line: 2, column: 1 },
									},
								},
								{
									severity: 1,
									summary: "problem here",
									range: {
										filename: "terragrunt.hcl",
										start: { line: 4, column: 1 },
									},
								},
							],
						},
					],
				}),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].message).toBe("problem here");
		} finally {
			env.cleanup();
		}
	});

	it("surfaces malformed JSON as failed with a parse-error, never clean", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: "not json at all",
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			// #1839: exit 1 whose output cannot be parsed is an unreadable report
			// of problems — never a clean result.
			expect(result.status).toBe("failed");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]).toMatchObject({
				id: "terragrunt:parse-error:1",
				severity: "warning",
				semantic: "warning",
			});
		} finally {
			env.cleanup();
		}
	});

	it("proceeds when no linter policy applies", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			getLinterPolicyForCwd.mockReturnValue(null);
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: JSON.stringify({ invalid_files: [] }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("succeeded");
			expect(safeSpawnAsync).toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("still parses stdout when the spawn reports an error", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			// A real spawn failure: `status` is null and `error` is set. Partial
			// stdout still gets parsed rather than thrown away.
			safeSpawnAsync.mockResolvedValue({
				error: new Error("Process killed by signal: SIGTERM"),
				failure: "signal",
				status: null,
				stdout: JSON.stringify([
					{
						severity: 1,
						summary: "bad attribute",
						range: {
							filename: "terragrunt.hcl",
							start: { line: 2, column: 3 },
						},
					},
				]),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("failed");
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0].message).toBe("bad attribute");
		} finally {
			env.cleanup();
		}
	});

	it("rolls mixed error and warning diagnostics up to failed/blocking", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 1,
				stdout: JSON.stringify([
					{
						severity: 2,
						summary: "unused local",
						range: {
							filename: "terragrunt.hcl",
							start: { line: 1, column: 1 },
						},
					},
					{
						severity: 1,
						summary: "invalid block",
						range: {
							filename: "terragrunt.hcl",
							start: { line: 4, column: 1 },
						},
					},
				]),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("failed");
			expect(result.semantic).toBe("blocking");
			expect(result.diagnostics).toHaveLength(2);
			expect(
				result.diagnostics.map((d: { severity: string }) => d.severity),
			).toEqual(["warning", "error"]);
		} finally {
			env.cleanup();
		}
	});

	it("skips when the tool is unavailable", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			toolState.available = false;
			ensureTool.mockResolvedValue(null);

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("skipped");
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	it("falls back to the managed binary when terragrunt is not on PATH", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			toolState.available = false;
			ensureTool.mockResolvedValue("/managed/bin/terragrunt");
			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: JSON.stringify({ invalid_files: [] }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("succeeded");
			expect(ensureTool).toHaveBeenCalledWith("terragrunt");
			expect(safeSpawnAsync).toHaveBeenCalledWith(
				"/managed/bin/terragrunt",
				expect.arrayContaining(["hcl", "validate"]),
				expect.anything(),
			);
		} finally {
			env.cleanup();
		}
	});

	it("skips when policy prefers a different runner", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			getLinterPolicyForCwd.mockReturnValue({
				runnerNames: ["terragrunt"],
				preferredRunners: [],
				defaultWhenUnconfigured: false,
				gate: "config-first",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("skipped");
			expect(safeSpawnAsync).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});

	// Ordering guard: this runs after the two availability-off tests and would
	// pass vacuously if their doMock leaked, so it pins the beforeEach restore.
	it("still sees the tool as available after the availability-off tests", async () => {
		const env = setupTestEnvironment("pi-lens-terragrunt-runner-");
		try {
			const filePath = path.join(env.tmpDir, "terragrunt.hcl");
			fs.writeFileSync(filePath, "locals {}\n");

			safeSpawnAsync.mockResolvedValue({
				error: null,
				status: 0,
				stdout: JSON.stringify({ invalid_files: [] }),
				stderr: "",
			});

			const runner = (
				await import("../../../../clients/dispatch/runners/terragrunt.js")
			).default;

			const result = await runner.run(createCtx(filePath, env.tmpDir) as never);

			expect(result.status).toBe("succeeded");
			expect(ensureTool).not.toHaveBeenCalled();
		} finally {
			env.cleanup();
		}
	});
});

describe("parseTerragruntOutput", () => {
	async function parse(raw: string, filePath = "/repo/terragrunt.hcl") {
		const { parseTerragruntOutput } =
			await import("../../../../clients/dispatch/runners/terragrunt.js");
		return parseTerragruntOutput(raw, filePath);
	}

	it("returns [] for empty or whitespace-only output", async () => {
		expect(await parse("")).toEqual([]);
		expect(await parse("  \n\t")).toEqual([]);
	});

	it("returns [] when invalid_files is present but not an array", async () => {
		expect(await parse(JSON.stringify({ invalid_files: {} }))).toEqual([]);
		expect(await parse(JSON.stringify({ invalid_files: "oops" }))).toEqual([]);
	});

	it("returns [] for JSON scalar payloads", async () => {
		expect(await parse("null")).toEqual([]);
		expect(await parse("42")).toEqual([]);
		expect(await parse('"error"')).toEqual([]);
	});

	it("skips null and non-object entries in a flat array, keeping valid ones", async () => {
		const diagnostics = await parse(
			JSON.stringify([null, "junk", 7, { severity: 1, summary: "real" }]),
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toBe("real");
	});

	it("ignores invalid_files entries whose diagnostics is missing or not an array", async () => {
		const diagnostics = await parse(
			JSON.stringify({
				invalid_files: [
					null,
					{},
					{ diagnostics: "nope" },
					{ diagnostics: [{ severity: 1, summary: "kept" }] },
				],
			}),
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toBe("kept");
	});

	it("defaults to line 1 column 1 when range is missing", async () => {
		const diagnostics = await parse(
			JSON.stringify([{ severity: 1, summary: "no range" }]),
		);
		expect(diagnostics[0]).toMatchObject({ line: 1, column: 1 });
	});

	// A unit's `include "root" { path = find_in_parent_folders() }` makes the
	// parent's terragrunt.hcl a real source of diagnostics, and its basename
	// matches the edited file's while its line numbers belong to another file.
	it("drops a same-basename diagnostic from the parent unit", async () => {
		const diagnostics = await parse(
			JSON.stringify([
				{
					severity: 1,
					summary: "parent problem",
					range: {
						filename: "../terragrunt.hcl",
						start: { line: 9, column: 1 },
					},
				},
			]),
			"/repo/infra/stack/terragrunt.hcl",
		);
		expect(diagnostics).toEqual([]);
	});

	it("keeps a diagnostic reported by absolute path for the edited file", async () => {
		const diagnostics = await parse(
			JSON.stringify([
				{
					severity: 1,
					summary: "here",
					range: {
						filename: path.resolve("/repo/infra/stack/terragrunt.hcl"),
						start: { line: 3, column: 1 },
					},
				},
			]),
			"/repo/infra/stack/terragrunt.hcl",
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toBe("here");
	});

	it("keeps a bare-filename diagnostic for the edited file", async () => {
		const diagnostics = await parse(
			JSON.stringify([
				{
					severity: 1,
					summary: "here",
					range: { filename: "terragrunt.hcl", start: { line: 3, column: 1 } },
				},
			]),
			"/repo/infra/stack/terragrunt.hcl",
		);
		expect(diagnostics).toHaveLength(1);
	});

	it("keeps diagnostics that carry no range.filename", async () => {
		const diagnostics = await parse(
			JSON.stringify([
				{
					severity: 1,
					summary: "unit-level",
					range: { start: { line: 2, column: 5 } },
				},
			]),
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ line: 2, column: 5 });
	});

	it("falls back to a generic message when summary and detail are both missing", async () => {
		const diagnostics = await parse(JSON.stringify([{ severity: 1 }]));
		expect(diagnostics[0].message).toBe("terragrunt hcl validate error");
	});

	it("uses detail as the message when summary is missing", async () => {
		const diagnostics = await parse(
			JSON.stringify([{ severity: 1, detail: "the long explanation" }]),
		);
		expect(diagnostics[0].message).toBe("the long explanation");
	});

	it("maps numeric severity 2 to a non-blocking warning", async () => {
		const diagnostics = await parse(
			JSON.stringify([{ severity: 2, summary: "w" }]),
		);
		expect(diagnostics[0]).toMatchObject({
			severity: "warning",
			semantic: "warning",
		});
	});

	it("matches string severity case-insensitively", async () => {
		const diagnostics = await parse(
			JSON.stringify([{ severity: "ERROR", summary: "e" }]),
		);
		expect(diagnostics[0]).toMatchObject({
			severity: "error",
			semantic: "blocking",
		});
	});

	it("treats unknown string severities as warning", async () => {
		const diagnostics = await parse(
			JSON.stringify([{ severity: "info", summary: "i" }]),
		);
		expect(diagnostics[0]).toMatchObject({
			severity: "warning",
			semantic: "warning",
		});
	});

	// The dispatcher dedupes on filePath:line:column:defectClass:(rule||id) and
	// runs delta mode off `d.id` alone, so a line-only id drops the second
	// finding at a position and hides a changed finding from the agent.
	it("gives two findings at the same position distinct ids", async () => {
		const diagnostics = await parse(
			JSON.stringify([
				{
					severity: 1,
					summary: "unsupported block",
					range: { start: { line: 4, column: 2 } },
				},
				{
					severity: 1,
					summary: "unknown attribute",
					range: { start: { line: 4, column: 2 } },
				},
			]),
		);
		expect(diagnostics).toHaveLength(2);
		expect(diagnostics[0].id).not.toBe(diagnostics[1].id);
	});

	it("changes the id when the message at a line changes", async () => {
		const before = await parse(
			JSON.stringify([
				{ severity: 1, summary: "was this", range: { start: { line: 4 } } },
			]),
		);
		const after = await parse(
			JSON.stringify([
				{ severity: 1, summary: "now that", range: { start: { line: 4 } } },
			]),
		);
		expect(after[0].id).not.toBe(before[0].id);
	});

	it("keeps the id stable for the same finding across runs", async () => {
		const payload = JSON.stringify([
			{
				severity: 1,
				summary: "unsupported block",
				range: { start: { line: 4, column: 2 } },
			},
		]);
		expect((await parse(payload))[0].id).toBe((await parse(payload))[0].id);
	});
});
