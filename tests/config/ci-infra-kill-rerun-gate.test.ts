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
import { ADVISORY_ONLY_MARKER } from "../../scripts/lib/ci-failure-classifier.mjs";

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
// `if:` was under test. Dropping the `push` arm from the `elif` leaves every
// other test green while a real push run passes neither --pr nor
// --allow-missing-pr, so the classifier throws and the rerun never fires:
// #2668 again, with only a red classify job as signal.
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

// The truth table review F3 named (12 rows then, 18 now after #2042's
// run_attempt rows), each row independently a pass/exclude case for the
// real, loaded if: expression.
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
		"workflow_dispatch (manual run)",
		ctx({ event: "workflow_dispatch" }),
		false,
	],
	// #2042 (2026-09-15): the SECOND infra kill on one head. This gate read
	// `run_attempt == 1`, so the second 137-kill of #3048 and of #3040 was
	// never classified and attempt 3 had to be started BY HAND both times.
	// Attempts 1 and 2 are eligible; attempt 3 is the bound.
	[
		"pull_request run on its SECOND attempt (a second infra kill on one head)",
		ctx({ event: "pull_request", runAttempt: 2 }),
		true,
	],
	[
		"push-to-master run on its SECOND attempt (a second infra kill on one head)",
		ctx({ event: "push", headBranch: "master", runAttempt: 2 }),
		true,
	],
	// The bound: a rerun can only be issued FROM attempt 1 or 2, so at most
	// two automatic reruns exist per head and attempt 3 is terminal.
	[
		"pull_request run on its THIRD attempt (the two-rerun bound)",
		ctx({ event: "pull_request", runAttempt: 3 }),
		false,
	],
	[
		"push-to-master run on its THIRD attempt (the two-rerun bound)",
		ctx({ event: "push", headBranch: "master", runAttempt: 3 }),
		false,
	],
	[
		"push-to-master run on a FOURTH attempt (still bounded)",
		ctx({ event: "push", headBranch: "master", runAttempt: 4 }),
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

	// Mutation-proof for #2042's own gate, both directions. Reverting
	// `run_attempt <= 2` to the shipped `run_attempt == 1` must flip the
	// second-kill row from eligible to excluded -- the exact state that made
	// #3048's and #3040's second 137-kill on one head a HAND rerun on
	// 2026-09-15. Dropping the conjunct altogether must stop excluding
	// attempt 3, which is the runaway-loop direction.
	it("mutation-proof: run_attempt <= 2 is the only reading that covers a second infra kill and still bounds the lane (#2042)", () => {
		const secondKill = ctx({
			event: "push",
			headBranch: "master",
			runAttempt: 2,
		});
		const thirdAttempt = ctx({
			event: "push",
			headBranch: "master",
			runAttempt: 3,
		});
		expect(evaluateIf(ifExpr, secondKill)).toBe(true);
		expect(evaluateIf(ifExpr, thirdAttempt)).toBe(false);

		const preFix = ifExpr.replace(
			/github\.event\.workflow_run\.run_attempt\s*<=\s*2/,
			"github.event.workflow_run.run_attempt == 1",
		);
		expect(preFix).not.toBe(ifExpr);
		expect(evaluateIf(preFix, secondKill)).toBe(false);

		const unbounded = ifExpr.replace(
			/\s*&&\s*github\.event\.workflow_run\.run_attempt\s*<=\s*2/,
			"",
		);
		expect(unbounded).not.toBe(ifExpr);
		expect(evaluateIf(unbounded, thirdAttempt)).toBe(true);
	});

	// Review round 2, MUT J: the `if:` truth table above cannot see this --
	// it only pins whether the JOB runs, not what the STEP's own `elif` does
	// once it has. The `push` arm must appear in the --allow-missing-pr
	// branch (and no retired event arm may return), or a push run silently
	// gets neither --pr nor --allow-missing-pr and the classifier throws
	// (#2668 again).
	it("the step's --allow-missing-pr branch names push and no retired event (review round 2, MUT J)", () => {
		const stepRun = readClassifyStepRun();
		expect(stepRun).toContain('"$RUN_EVENT" == "push"');
		expect(stepRun).not.toContain("repository_dispatch");
	});
});

// #3801 (verify r2 V3): a not-ready `Heavy advisory gate` exits 1, which fails
// the CI run with every required check green. The classifier skips such a run
// (no failed `Unit tests` job) and the label step used to read "skipped" as
// "not infra" and put `ci:real` on the green PR. A run whose failed jobs are
// all advisory (the classifier prints ADVISORY_ONLY_MARKER) must label nothing
// and clear stale verdict labels; every other skip keeps `ci:real`.
describe("ci-infra-kill-rerun.yml classify label step for an advisory-only failure (#3801)", () => {
	const run = () => {
		const job = (loadWorkflow().jobs as Record<string, WorkflowJob>).classify;
		return String(
			(job.steps as WorkflowStep[]).find((step) =>
				String(step.run).includes("gh pr edit"),
			)?.run,
		);
	};
	it("greps the classifier's own advisory-only phrase and adds no label in that branch", () => {
		const text = run();
		expect(text).toContain(ADVISORY_ONLY_MARKER);
		const branch =
			/elif grep -q -- '[^']*only advisory jobs failed' <<<"\$output"; then([\s\S]*?)\n\s*else/.exec(
				text,
			)?.[1];
		expect(branch).toBeDefined();
		expect(branch).toContain("--remove-label 'ci:real'");
		expect(branch).toContain("--remove-label 'ci:infra'");
		expect(branch).not.toContain("--add-label");
	});

	// Recurrence (verify r3 V5): the grep read the WHOLE CLI stdout, which on the
	// real-failure path carries log-derived text (the first failing assertion
	// line). A genuine red `Unit tests` shard whose assertion text contained the
	// phrase lost its `ci:real` label. The pattern is anchored to the CLI's own
	// skip line, and this evaluates the pattern the workflow really uses.
	it("anchors the phrase to the classifier's skip line, so log text cannot trigger it", () => {
		const pattern =
			/grep -q -- '([^']*only advisory jobs failed)' <<<"\$output"/.exec(
				run(),
			)?.[1];
		expect(pattern).toBeDefined();
		const regex = new RegExp(pattern as string, "m");
		const skipLine = `CI failure classifier skipped: run 9 has no failed job named "Unit tests"; ${ADVISORY_ONLY_MARKER} (Heavy advisory gate (advisory))`;
		expect(regex.test(skipLine)).toBe(true);
		// a real failure: the CLI's result line, then the sticky comment body
		// carrying the failing assertion line verbatim
		const realFailure = [
			"PR #42 sha=abc job=Unit tests (shard 2/4) -> real",
			"<!-- ci-classifier -->",
			`AssertionError: expected "${ADVISORY_ONLY_MARKER}" to be logged`,
			`  ${skipLine}`,
		].join("\n");
		expect(regex.test(realFailure)).toBe(false);
	});

	it("keeps ci:infra first and ci:real as the fall-through", () => {
		const text = run();
		const infra = text.indexOf("-> infra-");
		const advisory = text.indexOf(ADVISORY_ONLY_MARKER);
		const real = text.indexOf("--add-label 'ci:real'");
		expect(infra).toBeGreaterThan(-1);
		expect(infra).toBeLessThan(advisory);
		expect(advisory).toBeLessThan(real);
	});
});

describe("ci-infra-kill-rerun.yml synchronize label cleanup (#2856)", () => {
	it("synchronize cleanup removes both verdict labels", () => {
		const workflow = loadWorkflow();
		expect(workflow.on?.pull_request?.types).toEqual(["synchronize"]);
		const job = (workflow.jobs as Record<string, WorkflowJob>)[
			"clear-stale-verdict-labels"
		];
		expect(job).toBeDefined();
		expect(job?.if).toContain("github.event_name == 'pull_request'");
		expect(job?.if).toContain("github.event.action == 'synchronize'");
		const run = (job!.steps as WorkflowStep[]).find((step) => step.run)?.run;
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

	// #2042 (2026-09-15): keyed on the TERMINAL attempt, not on the literal
	// number 2. With `classify` now firing on attempts 1 AND 2, an attempt-2
	// FAILURE is an intermediate state (classify reruns it), so swapping the
	// terminal labels there would announce a verdict the lane is still
	// working on. Terminal = attempt 2 that SUCCEEDED, or attempt 3 either
	// way (the two-rerun bound forbids a fourth automatic attempt).
	const terminalRows: Array<[string, WorkflowRunContext, boolean]> = [
		[
			"pull_request success attempt 2 (green; no third attempt will exist)",
			ctx({ conclusion: "success", runAttempt: 2 }),
			true,
		],
		[
			"pull_request failure attempt 2 (intermediate: classify reruns it)",
			ctx({ conclusion: "failure", runAttempt: 2 }),
			false,
		],
		[
			"pull_request success attempt 3 (terminal)",
			ctx({ conclusion: "success", runAttempt: 3 }),
			true,
		],
		[
			"pull_request failure attempt 3 (terminal)",
			ctx({ conclusion: "failure", runAttempt: 3 }),
			true,
		],
		[
			"pull_request attempt 1 failure (classify's own label swap owns this)",
			ctx({ conclusion: "failure", runAttempt: 1 }),
			false,
		],
		[
			"pull_request cancelled attempt 3 (neither failure nor success)",
			ctx({ conclusion: "cancelled", runAttempt: 3 }),
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
			"push failure attempt 2 (intermediate)",
			ctx({
				event: "push",
				headBranch: "master",
				conclusion: "failure",
				runAttempt: 2,
			}),
			false,
		],
		[
			"push success attempt 3 (terminal)",
			ctx({
				event: "push",
				headBranch: "master",
				conclusion: "success",
				runAttempt: 3,
			}),
			true,
		],
		[
			"push failure attempt 3 (terminal)",
			ctx({
				event: "push",
				headBranch: "master",
				conclusion: "failure",
				runAttempt: 3,
			}),
			true,
		],
		[
			"push failure attempt 4 (cannot exist under the bound; still excluded)",
			ctx({
				event: "push",
				headBranch: "master",
				conclusion: "failure",
				runAttempt: 4,
			}),
			false,
		],
	];

	it.each(terminalRows)("%s => fires %s", (_label, context, expected) => {
		expect(evaluateIf(ifExpr, context)).toBe(expected);
	});

	// Mutation-proof for the re-key (#2042). Leaving this job on the shipped
	// `run_attempt == 2` once classify covers attempt 2 makes attempt 2 the
	// SECOND rerun trigger's own finalizer: a failing attempt 2 -- which
	// classify is about to rerun -- would get the terminal `ci:real` label,
	// and the genuinely terminal attempt 3 would get none at all.
	it("mutation-proof: reverting the terminal key to run_attempt == 2 mislabels the intermediate attempt and drops the terminal one (#2042)", () => {
		const failingAttempt2 = ctx({ conclusion: "failure", runAttempt: 2 });
		const terminalAttempt3 = ctx({ conclusion: "failure", runAttempt: 3 });
		expect(evaluateIf(ifExpr, failingAttempt2)).toBe(false);
		expect(evaluateIf(ifExpr, terminalAttempt3)).toBe(true);

		// A YAML `>-` block folds some newlines and keeps others (the more
		// -indented continuation lines), so the mutation is applied to a
		// whitespace-flattened copy of the SAME loaded string rather than to a
		// hand-copied restatement of it.
		const flat = ifExpr.replace(/\s+/g, " ");
		expect(evaluateIf(flat, terminalAttempt3)).toBe(true);
		const preFix = flat.replace(
			/\( github\.event\.workflow_run\.run_attempt == 3 \|\| \(github\.event\.workflow_run\.run_attempt == 2 && github\.event\.workflow_run\.conclusion == 'success'\) \)/,
			"github.event.workflow_run.run_attempt == 2",
		);
		expect(preFix).not.toBe(flat);
		expect(evaluateIf(preFix, failingAttempt2)).toBe(true);
		expect(evaluateIf(preFix, terminalAttempt3)).toBe(false);
	});

	it("loads the terminal label swap and no-PR summary path", () => {
		expect(job).toBeDefined();
		const run = (job!.steps as WorkflowStep[]).find((step) => step.run)?.run;
		expect(run).toContain("--remove-label 'ci:infra'");
		expect(run).toContain("--add-label 'ci:real'");
		expect(run).toContain("GITHUB_STEP_SUMMARY");
		expect(run).toContain("exit 0");
	});
});
