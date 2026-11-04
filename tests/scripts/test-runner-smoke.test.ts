/**
 * #5257: the nightly tool smoke plants a failing test per supported runner.
 *
 * Recurrence prevented: vitest 5 moved `--reporter=json` output into a file and
 * every per-edit test run read as passing; no nightly row held `TestRunnerClient`
 * to "a planted failing test is reported failing", so the drift reached users.
 * These cases pin the row population, the "latest, not the repo pin" install,
 * the verdict shape the master defect produced, the SKIPPED-with-reason rule,
 * and that the scheduled workflow actually runs the layer.
 *
 * Boundary decision (flake-shape): no real npm/pip/go spawn here. The live
 * rows run in the nightly (`Tool layer` step); the transcript of a local run is
 * in the PR body.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { stripCommentsAndStrings } from "../support/session-state-scan.js";
import {
	classifyPlantedFailure,
	evaluateTestRunnerRow,
	TEST_RUNNER_ROWS,
} from "../../scripts/lib/test-runner-smoke.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

type Result = {
	passed: number;
	failed: number;
	skipped: number;
	error?: string;
};

describe("classifyPlantedFailure", () => {
	it("passes only a run that counted the failure with no runner error", () => {
		const verdict = (r: Result) => classifyPlantedFailure(r).state;
		expect(verdict({ passed: 0, failed: 1, skipped: 0 })).toBe("pass");
		// The #5257 shape on master: the failing test read as an empty clean run.
		expect(verdict({ passed: 0, failed: 0, skipped: 0 })).toBe("fail");
		// An unreadable run is not a detected failure either.
		expect(
			verdict({ passed: 0, failed: 0, skipped: 0, error: "could not read" }),
		).toBe("fail");
		expect(verdict({ passed: 3, failed: 0, skipped: 0 })).toBe("fail");
	});
});

describe("TEST_RUNNER_ROWS", () => {
	it("covers vitest, jest, pytest and go test, one row each", () => {
		expect(
			TEST_RUNNER_ROWS.map((row: { runner: string }) => row.runner),
		).toEqual(["vitest", "jest", "pytest", "go"]);
	});

	it("installs vitest and jest at their latest version, never the repo pin", () => {
		const source = readFileSync(
			resolve(ROOT, "scripts/lib/test-runner-smoke.mjs"),
			"utf8",
		);
		expect(source).toContain("`${pkg}@latest`");
		expect(source).not.toMatch(/vitest@\^?\d/);
	});

	it("a row whose toolchain is absent is SKIPPED with its reason, not failed", async () => {
		const row = {
			id: "absent",
			runner: "go",
			provision: () => ({
				state: "skip" as const,
				reason: "the go toolchain is not on the job's PATH",
			}),
		};
		const result = await evaluateTestRunnerRow(row, {
			root: "/unused",
			client: {
				detectRunner: () => {
					throw new Error("must not run a skipped row");
				},
			},
		});
		expect(result).toMatchObject({
			state: "skip",
			detail: "the go toolchain is not on the job's PATH",
		});
	});

	it("a failed install is setup-failed (counts toward the exit code), not a skip", async () => {
		const result = await evaluateTestRunnerRow(
			{
				id: "broken",
				runner: "vitest",
				provision: () => ({
					state: "setup-failed" as const,
					reason: "npm install vitest@latest failed: ENOTFOUND",
				}),
			},
			{ root: "/unused", client: {} },
		);
		expect(result.state).toBe("setup-failed");
	});

	it("a detected runner other than the row's is a failure, not a pass", async () => {
		const result = await evaluateTestRunnerRow(
			{
				id: "vitest-latest",
				runner: "vitest",
				provision: () => ({
					state: "ready" as const,
					testFile: "/p/a.test.js",
				}),
			},
			{
				root: "/p",
				client: { detectRunner: () => ({ runner: "jest", config: {} }) },
			},
		);
		expect(result).toMatchObject({ state: "fail" });
	});
});

describe("scheduled workflow", () => {
	it("the Tool layer step runs the test-runner layer and keeps the worse status", () => {
		const workflow = yaml.load(
			readFileSync(resolve(ROOT, ".github/workflows/tool-smoke.yml"), "utf8"),
		) as {
			jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }>;
		};
		const step = workflow.jobs["tool-smoke"].steps.find(
			(candidate) => candidate.id === "tool_layer",
		);
		const run = step?.run ?? "";
		expect(run).toContain("smoke-tools.mjs --test-runners");
		expect(run).toContain("set -o pipefail");
		// Both commands run; a red first command must not hide the second.
		expect(run.match(/\|\| status=1/g)).toHaveLength(2);
		expect(run).toContain('exit "$status"');
	});
});

describe("smoke-tools.mjs entry", () => {
	// Recurrence prevented: the layer exists but `main()` stops dispatching it,
	// or exits 0 whatever the failure count, so a planted-failure row going red
	// never fails the nightly step (the #5257 drift would stay silent).
	it("dispatches --test-runners and exits non-zero on any failed row", () => {
		const code = stripCommentsAndStrings(
			readFileSync(resolve(ROOT, "scripts/smoke-tools.mjs"), "utf8"),
		);
		expect(code).toMatch(
			/if \(testRunners\) \{\s*process\.exit\(\(await runTestRunnerSmoke\(\{ verbose \}\)\) > 0 \? 1 : 0\);/,
		);
	});
});
