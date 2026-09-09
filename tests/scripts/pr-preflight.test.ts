import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.fn();
vi.mock("node:child_process", () => ({ spawnSync }));

const { formatSummary, parseArgs, runPreflight } =
	await import("../../scripts/pr-preflight.mjs");

afterEach(() => spawnSync.mockReset());

describe("pr preflight", () => {
	it("formats one summary table with the CI job column", () => {
		const table = formatSummary([
			{ gate: "lint", job: "Lint & type-check", code: 0, firstRed: "" },
		]);
		expect(table).toContain("gate");
		expect(table).toContain("mirrored CI job");
		expect(table).toContain("pass/fail");
	});
	it("parses only and skip selectors", () => {
		expect(parseArgs(["--only", "lint"])).toEqual({
			only: "lint",
			skip: undefined,
		});
		expect(parseArgs(["--skip", "lint"])).toEqual({
			only: undefined,
			skip: "lint",
		});
	});
	it("rejects skipping hard gates with the maintainer decision", () => {
		for (const gate of ["fmt:check", "build"]) {
			expect(() => parseArgs(["--skip", gate])).toThrow(
				`--skip ${gate} is not allowed: hard gate: unformatted files merged and redded master twice on 2026-09-09`,
			);
		}
	});
	it("propagates a red child exit code and preserves its first line", () => {
		spawnSync.mockReturnValue({
			status: 1,
			stdout: "",
			stderr: "gate exploded\n",
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const exitCode = runPreflight({
			argv: ["--only", "lint"],
			spawn: spawnSync,
			env: {},
		});
		expect(exitCode).toBe(1);
		expect(spawnSync).toHaveBeenCalledOnce();
		expect(log.mock.calls[0][0]).toContain("gate exploded");
		log.mockRestore();
	});
});
