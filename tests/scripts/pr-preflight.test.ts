import { afterEach, describe, expect, it, vi } from "vitest";
import { CI_JOB_NAMES } from "../../scripts/lib/ci-checks.mjs";

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
	it("pins preflight labels to the CI job vocabulary", async () => {
		const { GATES } = await import("../../scripts/pr-preflight.mjs");
		expect(
			GATES.find(([name]) => name === "check-changelog-fragments")?.[2],
		).toBe(CI_JOB_NAMES.CHANGELOG_FRAGMENT);
		expect(GATES.find(([name]) => name === "check:lockfile")?.[2]).toBe(
			CI_JOB_NAMES.LINT_AND_TYPECHECK,
		);
		expect(GATES.find(([name]) => name === "lockfile:complete")?.[1]).toEqual([
			"npm",
			"run",
			"check:lockfile",
			"--",
			"--complete",
		]);
		expect(GATES.find(([name]) => name === "knip")?.[1]).toEqual([
			process.execPath,
			"scripts/run-knip.mjs",
		]);
		expect(GATES.find(([name]) => name === "knip")?.[2]).toBe(
			CI_JOB_NAMES.KNIP,
		);
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
	it("rejects an unknown selector with the effective gate names", () => {
		expect(() =>
			runPreflight({ argv: ["--only", "does-not-exist"], env: {} }),
		).toThrow(/--only does-not-exist.*valid gate names:.*build.*lint/);
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
	it("reports an inconclusive child without failing preflight", () => {
		spawnSync.mockReturnValue({
			status: 3,
			stdout: "",
			stderr: "lockfile:complete: inconclusive: npm pin unavailable\n",
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const exitCode = runPreflight({
			argv: ["--only", "lockfile:complete"],
			spawn: spawnSync,
			env: {},
		});
		expect(exitCode).toBe(0);
		expect(log.mock.calls[0][0]).toContain("inconclusive");
		log.mockRestore();
	});
	it("records a spawn exception as a failed gate", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const exitCode = runPreflight({
			argv: ["--only", "lint"],
			spawn: () => {
				throw new Error("ENOENT injected");
			},
			env: {},
		});
		expect(exitCode).toBe(1);
		expect(log.mock.calls[0][0]).toContain("ENOENT injected");
		log.mockRestore();
	});
	it("runs Vitest gates through the shared test lock", () => {
		spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		runPreflight({
			argv: ["--only", "tests/config"],
			spawn: spawnSync,
			env: {},
		});
		expect(spawnSync.mock.calls[0][1]).toEqual(
			expect.arrayContaining(["scripts/with-test-lock.mjs", "--shared"]),
		);
		log.mockRestore();
	});
});
