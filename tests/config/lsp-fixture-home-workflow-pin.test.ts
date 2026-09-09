// #2762 recurrence (2026-09-08): #2755 removed these job-level pins in favour
// of per-invocation scratch homes; the first nightly after it lost the shared
// tool tree between the --install steps and the Format layer reported seven
// managed formatters as "ran clean but left the file unchanged". Per-run
// isolation stays the LOCAL default (scripts/lib/scratch-dir.mjs); in CI the
// job-level pin wins because withScratchHome() respects an explicit value.
// #2670 review F1: `tool-smoke.yml` runs SEVEN `--install` invocations
// (smoke-tools.mjs x3, characterize-lsp.mjs, probe-clean-signal.mjs,
// server-capabilities.mjs) in ONE job. `PI_LENS_HOME` relocates the
// installer's tool tree/bin dir/probe cache (module-level consts at
// `clients/installer/index.ts`), not just logs — with no JOB-level pin, each
// script's own `withScratchHome()` (scripts/lib/lsp-fixture-workspace.mjs)
// mints a FRESH, empty scratch home per invocation, so every step re-pulls
// every managed tool from scratch instead of sharing the one tool tree the
// job's ephemeral `$HOME` gave them for free pre-#2670. Job-level
// `PI_LENS_HOME`/`PILENS_DATA_DIR` restores that sharing: `withScratchHome`'s
// "already pinned" branch is a no-op against an explicit value, so setting it
// once at the job is the entire fix.
//
// Same technique as tests/config/install-smoke-gates.test.ts: load the REAL
// workflow via yaml.load, assert on the LOADED structure (never a hand-copied
// restatement of the YAML text).
//
// Before this file existed, PI_LENS_HOME/PILENS_DATA_DIR were absent from
// both workflows entirely (proven below by deleting the env lines from a
// SOURCE copy and reloading) and no test in the repo checked for them.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

type Job = { env?: Record<string, unknown>; steps?: unknown };
type Workflow = { jobs?: Record<string, Job> };

function loadWorkflow(workflowPath: string, source?: string): Workflow {
	const text = source ?? readFileSync(resolve(REPO_ROOT, workflowPath), "utf8");
	return yaml.load(text) as Workflow;
}

// [workflowPath, jobName, installStepCount] — installStepCount is asserted
// too, so a step added/removed under one of these jobs without updating this
// table's own understanding of "how many steps share the cache" is visible.
const WORKFLOWS: Array<[string, string, number]> = [
	[".github/workflows/tool-smoke.yml", "tool-smoke", 7], // #2780 clean-gate step added a seventh cache-sharing install.
	[".github/workflows/parser-smoke.yml", "parser-smoke", 1],
];

describe.each(WORKFLOWS)(
	"%s jobs.%s.env pins PI_LENS_HOME/PILENS_DATA_DIR (#2670 review F1)",
	(workflowPath, jobName, expectedInstallSteps) => {
		const workflow = loadWorkflow(workflowPath);
		const jobEnv = workflow.jobs?.[jobName]?.env;

		it("carries a non-empty PI_LENS_HOME", () => {
			expect(typeof jobEnv?.PI_LENS_HOME).toBe("string");
			expect((jobEnv?.PI_LENS_HOME as string).trim().length).toBeGreaterThan(0);
		});

		it("carries a non-empty PILENS_DATA_DIR", () => {
			expect(typeof jobEnv?.PILENS_DATA_DIR).toBe("string");
			expect((jobEnv?.PILENS_DATA_DIR as string).trim().length).toBeGreaterThan(
				0,
			);
		});

		it("PI_LENS_HOME and PILENS_DATA_DIR resolve to the SAME dir (one shared tool tree, not two)", () => {
			expect(jobEnv?.PI_LENS_HOME).toBe(jobEnv?.PILENS_DATA_DIR);
		});

		it('never points at ${{ runner.temp }} (unavailable at job-level env — actionlint: "context \\"runner\\" is not allowed here")', () => {
			expect(String(jobEnv?.PI_LENS_HOME)).not.toContain("runner.temp");
		});

		it("counts the --install steps this job's cache-sharing claim is actually about", () => {
			const steps = workflow.jobs?.[jobName]?.steps;
			const installSteps = (
				Array.isArray(steps) ? (steps as Array<{ run?: unknown }>) : []
			).filter((s) => typeof s.run === "string" && s.run.includes("--install"));
			expect(installSteps.length).toBe(expectedInstallSteps);
		});

		// Mutation-proof: before this file existed, deleting the pin entirely
		// left every other check in this repo green.
		it("mutation-proof: deleting the PI_LENS_HOME env line reds the pin assertion", () => {
			const source = readFileSync(resolve(REPO_ROOT, workflowPath), "utf8");
			const lines = source.split("\n");
			const lineIdx = lines.findIndex((line) =>
				/^\s*PI_LENS_HOME:\s/.test(line),
			);
			expect(lineIdx, "no PI_LENS_HOME: line found").toBeGreaterThanOrEqual(0);
			const mutatedLines = [...lines];
			mutatedLines.splice(lineIdx, 1);
			const mutatedSource = mutatedLines.join("\n");
			expect(mutatedSource).not.toBe(source);
			const mutatedWorkflow = loadWorkflow(workflowPath, mutatedSource);
			expect(
				mutatedWorkflow.jobs?.[jobName]?.env?.PI_LENS_HOME,
			).toBeUndefined();
		});
	},
);
