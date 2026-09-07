// Pins the `oxlint advisory` job's rule-count floor guard in lint.yml
// (#2700 review round 2, F2): with `oxlint-tsgolint` absent, oxlint's
// `--type-aware` flag degrades SILENTLY (exit 1, zero rules run, zero
// findings) which, under this job's own `continue-on-error`, is
// indistinguishable in the GitHub Actions checks UI from a healthy run
// that simply found real issues (also exit 1). The step's inline bash
// parses oxlint's own `Finished in … with N rules …` trailer and fails
// with a named `::error::` annotation when N falls below a floor — this
// guard has NO other test (the PR's other lint-js.test.ts/ci-verdict.
// test.ts/flake-shape-ratchet.test.ts cases never load lint.yml at all),
// so deleting the whole block stayed green while the PR's own body
// claimed "mutation-proof" (round 3 finding).
//
// Same technique as tests/config/ci-infra-kill-rerun-gate.test.ts and
// tests/config/install-smoke-gates.test.ts: load the REAL workflow via
// yaml.load (never a hand-copied restatement of its bash) and assert
// against the loaded `run:` string.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = ".github/workflows/lint.yml";
const JOB_NAME = "oxlint-advisory";
const STEP_NAME_SUBSTRING = "oxlint advisory (categories";

type Step = { name?: unknown; run?: unknown };
type Job = { steps?: unknown };
type Workflow = { jobs?: Record<string, Job> };

function loadWorkflow(source?: string): Workflow {
	const text =
		source ?? readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
	return yaml.load(text) as Workflow;
}

function readStepRun(workflow: Workflow): string {
	const steps = workflow.jobs?.[JOB_NAME]?.steps;
	const step = Array.isArray(steps)
		? (steps as Step[]).find(
				(s) =>
					typeof s.name === "string" && s.name.includes(STEP_NAME_SUBSTRING),
			)
		: undefined;
	if (!step || typeof step.run !== "string") {
		throw new Error(
			`${WORKFLOW_PATH}: jobs.${JOB_NAME} has no step named "${STEP_NAME_SUBSTRING}" with a string run:`,
		);
	}
	return step.run;
}

describe("oxlint advisory rule-count floor guard (#2700 review round 2, F2)", () => {
	it("the real job step defines a RULE_FLOOR and compares $rules against it", () => {
		const run = readStepRun(loadWorkflow());
		expect(run).toMatch(/RULE_FLOOR=\d+/);
		expect(run).toMatch(/"\$rules"\s+-lt\s+"\$RULE_FLOOR"/);
	});

	it("breaching the floor emits a named ::error:: annotation and fails the step", () => {
		const run = readStepRun(loadWorkflow());
		expect(run).toMatch(/::error::.*\$rules.*\$RULE_FLOOR/);
		// The error branch must actually exit non-zero -- an `::error::` line
		// with no following `exit` would just be a log message, and
		// `continue-on-error` at job level would still swallow it as if this
		// step "passed".
		const errorLineIndex = run.indexOf("::error::");
		const exitAfterError = run.slice(errorLineIndex).match(/exit\s+1\b/);
		expect(exitAfterError).not.toBeNull();
	});

	it("the trailer this guard parses is produced by a pinned --format default, not CI's auto-selected reporter", () => {
		// #2700 review round 1, F3: without an explicit --format, CI
		// auto-selects a reporter that never prints the `Finished in … with
		// N rules …` trailer this guard's `grep` depends on -- so the floor
		// guard is only meaningful paired with the pinned reporter.
		const pkg = JSON.parse(
			readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
		);
		const advisoryScript: string = pkg.scripts["lint:js:advisory"];
		expect(advisoryScript).toMatch(/--format default\b/);
	});
});
