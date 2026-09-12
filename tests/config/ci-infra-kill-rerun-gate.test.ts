// Pins .github/workflows/ci-infra-kill-rerun.yml's `jobs.classify.if:`
// expression (#2668 review F3): "the YAML if: cannot be red-proven locally
// is false: tests/config/github-workflow-permissions.test.ts already loads
// workflows with yaml.load." This file reuses that same loader, then
// evaluates the LOADED if: string (not a hand-copied restatement of it —
// the test would drift silently otherwise) against synthetic GitHub Actions
// `workflow_run` contexts, so a change to the real expression is exercised
// here without ever running inside GitHub Actions.
//
// Evaluation approach: the if: string is plain JS-shaped boolean logic
// (dotted property paths, `==`, `&&`, `||`, quoted string/number literals)
// once every `github.*` context path is substituted with a literal value —
// GitHub Actions expression syntax and JS expression syntax agree exactly
// on this subset. Substituting every known path with `JSON.stringify(value)`
// and evaluating the result with `new Function` (never on untrusted input —
// this repo's own workflow file is the only source) is the same technique
// tests/scripts/playground-verify-rule-sentinel.test.ts already uses to
// evaluate a small expression string without a full parser.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = ".github/workflows/ci-infra-kill-rerun.yml";

type WorkflowStep = { run?: unknown };
type WorkflowJob = { env?: unknown; if?: unknown; steps?: unknown };
type ClassifyJob = { if?: unknown; steps?: unknown };
type Workflow = {
	on?: { pull_request?: { types?: unknown[] } };
	jobs?: { classify?: ClassifyJob; "finalize-rerun"?: WorkflowJob };
};

function loadWorkflow(): Workflow {
	return yaml.load(
		readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8"),
	) as Workflow;
}

function readClassifyIf(): string {
	const ifExpr = loadWorkflow().jobs?.classify?.if;
	if (typeof ifExpr !== "string") {
		throw new Error(
			`${WORKFLOW_PATH}: jobs.classify.if is not a string (got ${typeof ifExpr})`,
		);
	}
	return ifExpr;
}

// Review round 2, MUT J: the eligible-event set is duplicated in TWO places
// -- the job's `if:` (which arms this job at all) and this step's own
// `elif` (which decides whether to pass --allow-missing-pr) -- and only the
// `if:` was under test. Dropping the `repository_dispatch` arm from the
// `elif` leaves every other test green while a real dispatch run passes
// neither --pr nor --allow-missing-pr, so the classifier throws and the
// rerun never fires: #2668 again, with only a red classify job as signal.
function readClassifyStepRun(): string {
	const steps = loadWorkflow().jobs?.classify?.steps;
	const classifyStep = Array.isArray(steps)
		? (steps as WorkflowStep[]).find(
				(step) =>
					typeof step.run === "string" &&
					step.run.includes("classify-ci-failure.mjs"),
			)
		: undefined;
	if (typeof classifyStep?.run !== "string") {
		throw new Error(
			`${WORKFLOW_PATH}: no step running classify-ci-failure.mjs found`,
		);
	}
	return classifyStep.run;
}

interface WorkflowRunContext {
	repository: string;
	headRepositoryFullName: string;
	event: string;
	headBranch: string;
	conclusion: string;
	runAttempt: number;
	pullRequestNumber: string;
}

// Textual substitution of every dotted context path this expression reads,
// each replaced with its JSON literal BEFORE evaluation -- deliberately not
// a real expression parser (GitHub Actions expressions are not JS), just
// enough to turn this one known, controlled string into evaluable JS.
const CONTEXT_PATHS: Array<[string, (ctx: WorkflowRunContext) => unknown]> = [
	[
		"github.event.workflow_run.head_repository.full_name",
		(ctx) => ctx.headRepositoryFullName,
	],
	["github.repository", (ctx) => ctx.repository],
	["github.event.workflow_run.event", (ctx) => ctx.event],
	["github.event.workflow_run.head_branch", (ctx) => ctx.headBranch],
	["github.event.workflow_run.conclusion", (ctx) => ctx.conclusion],
	["github.event.workflow_run.run_attempt", (ctx) => ctx.runAttempt],
	[
		"github.event.workflow_run.pull_requests[0].number",
		(ctx) => ctx.pullRequestNumber,
	],
];

function substitute(expr: string, ctx: WorkflowRunContext): string {
	let out = expr;
	for (const [path, read] of CONTEXT_PATHS) {
		const value = read(ctx);
		// `Array.prototype.join` treats an undefined separator as "," -- every
		// value here must round-trip through JSON.stringify as a real string.
		const literal = JSON.stringify(value);
		if (typeof literal !== "string") {
			throw new Error(`unstringifiable context value for ${path}: ${value}`);
		}
		out = out.split(path).join(literal);
	}
	if (out.includes("github.")) {
		throw new Error(
			`unsubstituted github.* reference survived evaluation: ${out}`,
		);
	}
	return out;
}

function evaluateIf(expr: string, ctx: WorkflowRunContext): boolean {
	const substituted = substitute(expr, ctx);
	// `new Function` on a string built entirely from this repo's own workflow
	// file plus JSON-literal test fixtures, never external/untrusted input --
	// see the file header for why this is the same technique as elsewhere.
	const fn = new Function(`"use strict"; return (${substituted});`);
	return Boolean(fn());
}

const SAME_REPO = "acme/repo";
const FORK_REPO = "someone-else/repo";

function ctx(overrides: Partial<WorkflowRunContext>): WorkflowRunContext {
	return {
		repository: SAME_REPO,
		headRepositoryFullName: SAME_REPO,
		event: "pull_request",
		headBranch: "feature-x",
		conclusion: "failure",
		runAttempt: 1,
		pullRequestNumber: "123",
		...overrides,
	};
}

// The 12-row truth table review F3 named, each row independently a
// pass/exclude case for the real, loaded if: expression.
const ROWS: Array<[string, WorkflowRunContext, boolean]> = [
	["same-repo PR", ctx({ event: "pull_request" }), true],
	[
		"fork PR (head_repository differs from github.repository)",
		ctx({ event: "pull_request", headRepositoryFullName: FORK_REPO }),
		false,
	],
	["push to master", ctx({ event: "push", headBranch: "master" }), true],
	[
		"push to a non-master branch",
		ctx({ event: "push", headBranch: "not-master" }),
		false,
	],
	[
		"repository_dispatch (merge-train-post-merge) targeting master",
		ctx({ event: "repository_dispatch", headBranch: "master" }),
		true,
	],
	[
		"workflow_dispatch (manual run)",
		ctx({ event: "workflow_dispatch" }),
		false,
	],
	[
		"pull_request run on its SECOND attempt (already rerun once)",
		ctx({ event: "pull_request", runAttempt: 2 }),
		false,
	],
	[
		"push-to-master run on its SECOND attempt (already rerun once)",
		ctx({ event: "push", headBranch: "master", runAttempt: 2 }),
		false,
	],
	[
		"a SUCCEEDED run (nothing to classify)",
		ctx({ event: "push", headBranch: "master", conclusion: "success" }),
		false,
	],
	[
		"a CANCELLED run (nothing to classify)",
		ctx({ event: "push", headBranch: "master", conclusion: "cancelled" }),
		false,
	],
	["a schedule-triggered run", ctx({ event: "schedule" }), false],
	["a merge_group-triggered run", ctx({ event: "merge_group" }), false],
];

describe("ci-infra-kill-rerun.yml classify job gate (#2668 review F3)", () => {
	const ifExpr = readClassifyIf();

	it.each(ROWS)("%s -> eligible=%s", (_label, context, expected) => {
		expect(evaluateIf(ifExpr, context)).toBe(expected);
	});

	// Mutation-proof (review F3): "today nothing reds on that" -- before this
	// file existed, no test in the repo evaluated the if: string at all, so
	// deleting the fork guard was invisible. Demonstrate the NEW table would
	// catch it: strip the `head_repository... &&` conjunct from the loaded
	// expression and show the fork-PR row flips from correctly-excluded to
	// incorrectly-included.
	it("mutation-proof: removing the fork guard flips the fork-PR row from excluded to included", () => {
		const forkRow = ctx({
			event: "pull_request",
			headRepositoryFullName: FORK_REPO,
		});
		expect(evaluateIf(ifExpr, forkRow)).toBe(false);

		const withoutForkGuard = ifExpr.replace(
			/github\.event\.workflow_run\.head_repository\.full_name\s*==\s*github\.repository\s*&&\s*/,
			"",
		);
		expect(withoutForkGuard).not.toBe(ifExpr);
		expect(evaluateIf(withoutForkGuard, forkRow)).toBe(true);
	});

	// Review round 2, MUT J: the `if:` truth table above cannot see this --
	// it only pins whether the JOB runs, not what the STEP's own `elif` does
	// once it has. Both `push` and `repository_dispatch` must appear in the
	// --allow-missing-pr branch, or a dispatch run silently gets neither
	// --pr nor --allow-missing-pr and the classifier throws (#2668 again).
	it("the step's --allow-missing-pr branch names both push and repository_dispatch (review round 2, MUT J)", () => {
		const stepRun = readClassifyStepRun();
		expect(stepRun).toContain('"$RUN_EVENT" == "push"');
		expect(stepRun).toContain('"$RUN_EVENT" == "repository_dispatch"');
	});
});

describe("ci-infra-kill-rerun.yml synchronize label cleanup (#2856)", () => {
	it("synchronize cleanup removes both verdict labels", () => {
		const workflow = loadWorkflow();
		expect(workflow.on?.pull_request?.types).toEqual(["synchronize"]);
		const job = (workflow.jobs as Record<string, WorkflowJob>)[
			"clear-stale-verdict-labels"
		];
		expect(job?.if).toContain("github.event_name == 'pull_request'");
		expect(job?.if).toContain("github.event.action == 'synchronize'");
		const run = (job?.steps as WorkflowStep[]).find((step) => step.run)?.run;
		expect(run).toContain("--remove-label 'ci:infra'");
		expect(run).toContain("--remove-label 'ci:real'");
		expect(job?.env).toMatchObject({ GH_REPO: "${{ github.repository }}" });
	});
});

describe("ci-infra-kill-rerun.yml terminal rerun path (#2806 F3)", () => {
	const job = loadWorkflow().jobs?.["finalize-rerun"];
	const ifExpr = job?.if;
	if (typeof ifExpr !== "string") {
		throw new Error(`${WORKFLOW_PATH}: jobs.finalize-rerun.if is not a string`);
	}

	const terminalRows: Array<[string, WorkflowRunContext, boolean]> = [
		[
			"pull_request success attempt 2",
			ctx({ conclusion: "success", runAttempt: 2 }),
			true,
		],
		[
			"pull_request failure attempt 2",
			ctx({ conclusion: "failure", runAttempt: 2 }),
			true,
		],
		[
			"pull_request success attempt 3",
			ctx({ conclusion: "success", runAttempt: 3 }),
			false,
		],
		[
			"pull_request failure attempt 3",
			ctx({ conclusion: "failure", runAttempt: 3 }),
			false,
		],
		[
			"push success attempt 2",
			ctx({
				event: "push",
				headBranch: "master",
				conclusion: "success",
				runAttempt: 2,
			}),
			true,
		],
		[
			"push failure attempt 2",
			ctx({
				event: "push",
				headBranch: "master",
				conclusion: "failure",
				runAttempt: 2,
			}),
			true,
		],
		[
			"push success attempt 3",
			ctx({
				event: "push",
				headBranch: "master",
				conclusion: "success",
				runAttempt: 3,
			}),
			false,
		],
		[
			"push failure attempt 3",
			ctx({
				event: "push",
				headBranch: "master",
				conclusion: "failure",
				runAttempt: 3,
			}),
			false,
		],
		[
			"repository_dispatch success attempt 2",
			ctx({
				event: "repository_dispatch",
				headBranch: "master",
				conclusion: "success",
				runAttempt: 2,
			}),
			true,
		],
		[
			"repository_dispatch failure attempt 2",
			ctx({
				event: "repository_dispatch",
				headBranch: "master",
				conclusion: "failure",
				runAttempt: 2,
			}),
			true,
		],
		[
			"repository_dispatch success attempt 3",
			ctx({
				event: "repository_dispatch",
				headBranch: "master",
				conclusion: "success",
				runAttempt: 3,
			}),
			false,
		],
		[
			"repository_dispatch failure attempt 3",
			ctx({
				event: "repository_dispatch",
				headBranch: "master",
				conclusion: "failure",
				runAttempt: 3,
			}),
			false,
		],
	];

	it.each(terminalRows)("%s => fires %s", (_label, context, expected) => {
		expect(evaluateIf(ifExpr, context)).toBe(expected);
	});

	it("loads the terminal label swap and no-PR summary path", () => {
		const run = (job?.steps as WorkflowStep[]).find((step) => step.run)?.run;
		expect(run).toContain("--remove-label 'ci:infra'");
		expect(run).toContain("--add-label 'ci:real'");
		expect(run).toContain("GITHUB_STEP_SUMMARY");
		expect(run).toContain("exit 0");
	});
});
