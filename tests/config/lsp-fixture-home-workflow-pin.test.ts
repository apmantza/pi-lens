// #2687 option (b): each script keeps a fresh per-run scratch home so concurrent
// invocations never share a tool tree or instances registry. The home is named,
// claimed, announced, and swept by scripts/lib/scratch-dir.mjs.
//
// Same technique as tests/config/install-smoke-gates.test.ts: load the REAL
// workflow via yaml.load, assert on the LOADED structure (never a hand-copied
// restatement of the YAML text).
//
// The workflow-level pins used by the earlier shared-cache design are absent;
// this test keeps that option (b) decision visible as the workflow changes.
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
	[".github/workflows/tool-smoke.yml", "tool-smoke", 6],
	[".github/workflows/parser-smoke.yml", "parser-smoke", 1],
];

describe.each(WORKFLOWS)(
	"%s jobs.%s leaves per-run scratch homes to the harness (#2687)",
	(workflowPath, jobName, expectedInstallSteps) => {
		const workflow = loadWorkflow(workflowPath);
		const jobEnv = workflow.jobs?.[jobName]?.env;

		it("does not pin a shared tool tree at job level", () => {
			expect(jobEnv?.PI_LENS_HOME).toBeUndefined();
			expect(jobEnv?.PILENS_DATA_DIR).toBeUndefined();
		});

		it("counts the --install steps this job's cache-sharing claim is actually about", () => {
			const steps = workflow.jobs?.[jobName]?.steps;
			const installSteps = (
				Array.isArray(steps) ? (steps as Array<{ run?: unknown }>) : []
			).filter((s) => typeof s.run === "string" && s.run.includes("--install"));
			expect(installSteps.length).toBe(expectedInstallSteps);
		});
	},
);
