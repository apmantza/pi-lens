// #5062: a pull request a workflow opens with the repository GITHUB_TOKEN starts
// no `pull_request` run, so every required check stays absent until a
// maintainer closes and reopens it (PR #4945, BLOCKED from 2026-10-28; #4338
// and #2801 before it). `workflow_dispatch` is the one event a GITHUB_TOKEN can
// start, so each job that opens a PR dispatches every workflow that produces a
// required check on the branch it pushed. This census fails closed on that
// mechanism: a job that shows ANY sign of opening a PR must carry it, or be
// registered below as a non-opener with its reason. A new opener cannot slip
// through by spelling its PR creation in a form this file does not know,
// because the signals include the permission an opener needs.
//
// The workflows to dispatch are the ones with a `merge_group` trigger: #3754
// already requires exactly the workflows that produce a required check to run
// there (tests/config/merge-queue-workflows.test.ts), so the target set is
// derived from the tree and not mirrored by hand.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	effectivePermissions,
	workflowDocument,
	workflowTriggers,
} from "../../scripts/dispatch-safety.mjs";
import { assertNonEmptyScan, auditRegistry } from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

type Step = {
	id?: unknown;
	name?: unknown;
	if?: unknown;
	run?: unknown;
	uses?: unknown;
	with?: Record<string, unknown>;
	env?: Record<string, unknown>;
	"continue-on-error"?: unknown;
};
type Job = {
	permissions?: unknown;
	uses?: unknown;
	"continue-on-error"?: unknown;
	steps?: Step[];
};
type Workflow = {
	on?: unknown;
	permissions?: unknown;
	jobs?: Record<string, Job>;
};

const load = (source: string) => workflowDocument(source) as Workflow;

function workflowFiles(): { file: string; source: string }[] {
	const files = readdirSync(WORKFLOWS)
		.filter((name) => /\.ya?ml$/.test(name))
		.sort()
		.map((name) => ({
			file: name,
			source: readFileSync(resolve(WORKFLOWS, name), "utf8"),
		}));
	assertNonEmptyScan(
		"workflow files walked for bot-PR CI start",
		files.length,
		10,
	);
	return files;
}

// Workflows a dispatch must reach: those that run on `merge_group` (#3754).
function dispatchTargets(files: { file: string; source: string }[]): string[] {
	return files
		.filter(({ source }) =>
			workflowTriggers(load(source).on).includes("merge_group"),
		)
		.map(({ file }) => file);
}

// ── opener signals ──────────────────────────────────────────────────────────

const text = (value: unknown): string =>
	typeof value === "string" ? value : "";

// A comment line is not a command. Whole-line comments only: the mechanism
// below is matched against whole lines, so a trailing comment fails it.
function commandLines(run: unknown): string[] {
	return text(run)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
}

const PR_WORDS = /\bpr\s+create\b|\/pulls\b|pulls\.create|createPullRequest/;

function stepStrings(step: Step): string[] {
	return [
		...commandLines(step.run),
		...Object.values(step.with ?? {}).map(text),
	];
}

// The signs a job might open a PR. Deliberately wider than "calls
// create-pull-request": the write permission and the App token are what ANY
// opener needs, whatever it calls.
function openerSignals(workflow: Workflow, job: Job): string[] {
	const signals: string[] = [];
	const permissions = effectivePermissions(
		workflow.permissions,
		job.permissions,
	) as Record<string, string>;
	if (permissions["pull-requests"] === "write")
		signals.push("pull-requests: write");
	if (typeof job.uses === "string") signals.push("job-level uses");
	for (const step of job.steps ?? []) {
		const uses = text(step.uses).split("@")[0].toLowerCase();
		if (uses.endsWith("/create-pull-request"))
			signals.push("create-pull-request");
		if (uses.endsWith("/create-github-app-token"))
			signals.push("create-github-app-token");
		if (stepStrings(step).some((line) => PR_WORDS.test(line)))
			signals.push("a PR-creating command");
	}
	return [...new Set(signals)];
}

// ── the mechanism ───────────────────────────────────────────────────────────

const OPERATION = (id: string) => `steps.${id}.outputs.pull-request-operation`;
// The only `if:` forms that admit the dispatch: it fires when the PR was just
// created or updated, and it runs whatever an earlier step did (`!cancelled()`),
// so one failed dispatch or a failed disarm does not skip the other dispatch
// (#5062 r2 F2). The second form is the docs-refresh PR, which skips it when
// the App token opened the PR (CI already started, #4512).
function admittedIfs(id: string): string[] {
	const fired = `${OPERATION(id)} == 'created' || ${OPERATION(id)} == 'updated'`;
	return [
		`\${{ !cancelled() && (${fired}) }}`,
		`\${{ !cancelled() && (${fired}) && steps.app_token.outputs.token == '' }}`,
	];
}

const isDispatchStep = (step: Step) =>
	commandLines(step.run).some((line) => line.startsWith("gh workflow run "));

function dispatchProblems(
	workflow: Workflow,
	job: Job,
	targets: string[],
	targetsDispatchable: Record<string, boolean>,
): string[] {
	const problems: string[] = [];
	const steps = job.steps ?? [];
	const openers = steps.filter((step) =>
		text(step.uses).toLowerCase().includes("/create-pull-request@"),
	);
	if (openers.length === 0) return ["no create-pull-request step to bind to"];
	const permissions = effectivePermissions(
		workflow.permissions,
		job.permissions,
	) as Record<string, string>;
	if (permissions.actions !== "write") problems.push("lacks actions: write");
	if (job["continue-on-error"] !== undefined)
		problems.push("job continue-on-error");
	// Position (#5062 r2 F2): the dispatch steps close the job. A hard-failing
	// dispatch placed before the disarm failsafe or the promotion PR step skips
	// them (each runs under an implicit `success()`), and one placed before its
	// opener reads an empty `pull-request-operation` and never fires.
	const dispatchAt = steps.findIndex(isDispatchStep);
	if (dispatchAt >= 0) {
		for (const [index, step] of steps.entries())
			if (index > dispatchAt && !isDispatchStep(step))
				problems.push(
					`step ${JSON.stringify(text(step.name) || index)} runs after the first CI dispatch`,
				);
		for (const opener of openers)
			if (steps.indexOf(opener) > dispatchAt)
				problems.push(
					"a CI dispatch step precedes the create-pull-request step",
				);
	}
	for (const opener of openers) {
		const id = text(opener.id);
		const branch = text(opener.with?.branch);
		if (id === "" || branch === "" || branch.includes("${{")) {
			problems.push(
				"a create-pull-request step needs an id and a literal branch",
			);
			continue;
		}
		for (const target of targets) {
			if (!targetsDispatchable[target])
				problems.push(`${target} has no workflow_dispatch trigger`);
			const command = `gh workflow run ${target} --ref ${branch}`;
			const carrying = steps.filter((step) =>
				commandLines(step.run).includes(command),
			);
			if (carrying.length === 0) {
				problems.push(`no step runs \`${command}\``);
				continue;
			}
			for (const step of carrying) {
				if (step["continue-on-error"] !== undefined)
					problems.push(`\`${command}\` is continue-on-error`);
				if (
					typeof step.if !== "string" ||
					!admittedIfs(id).includes(step.if.replace(/\s+/g, " ").trim())
				)
					problems.push(`\`${command}\` has an unadmitted if`);
				if (step.env?.GH_TOKEN !== "${{ secrets.GITHUB_TOKEN }}")
					problems.push(`\`${command}\` does not use the repository token`);
				// Whole-line command: `|| true`, a variable branch or an `echo` of it
				// never matches, so a swallowed failure cannot satisfy the line.
				if (!commandLines(step.run).includes("set -euo pipefail"))
					problems.push(`\`${command}\` lacks set -euo pipefail`);
			}
		}
	}
	return problems;
}

type Finding = { key: string; detail: string };

export function botPrFindings(
	files: { file: string; source: string }[],
): Finding[] {
	const targets = dispatchTargets(files);
	const targetsDispatchable = Object.fromEntries(
		files
			.filter(({ file }) => targets.includes(file))
			.map(({ file, source }) => [
				file,
				workflowTriggers(load(source).on).includes("workflow_dispatch"),
			]),
	);
	const findings: Finding[] = [];
	for (const { file, source } of files) {
		const workflow = load(source);
		for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
			const signals = openerSignals(workflow, job ?? {});
			if (signals.length === 0) continue;
			const problems = dispatchProblems(
				workflow,
				job ?? {},
				targets,
				targetsDispatchable,
			);
			if (problems.length > 0)
				findings.push({
					key: `${file}:${name}`,
					detail: `(${signals.join(", ")}): ${problems.join("; ")}`,
				});
		}
	}
	return findings;
}

// Jobs that carry an opener signal and open no PR. Each reason names what the
// job does instead. An entry that stops being flagged reds as stale.
const NON_OPENERS: Record<string, string> = {
	"ci-infra-kill-rerun.yml:clear-stale-verdict-labels":
		"edits labels on an existing PR; `gh pr edit` needs pull-requests: write",
	"ci-infra-kill-rerun.yml:classify":
		"comments on an existing PR with the classifier verdict; opens none",
	"ci-infra-kill-rerun.yml:finalize-rerun":
		"updates labels and comments on an existing PR; opens none",
	"close-keyword-verification.yml:verify":
		"comments on a merged PR when a closing keyword did not close its issue",
	"greetings.yml:greeting":
		"posts a first-contribution comment on a PR or issue someone else opened",
	"stale.yml:stale":
		"labels and closes stale PRs and issues through actions/stale; opens none",
};

describe("bot-opened PRs start the required CI (#5062)", () => {
	it(
		"every PR-opening job dispatches each required-check workflow on its branch",
		() => {
			const files = workflowFiles();
			const findings = botPrFindings(files);
			const signalled = files.flatMap(({ source }) => {
				const workflow = load(source);
				return Object.entries(workflow.jobs ?? {}).filter(
					([, job]) => openerSignals(workflow, job ?? {}).length > 0,
				);
			});
			const audit = auditRegistry({
				sweepName: "PR-opening jobs without the CI-start dispatch",
				flagged: findings,
				registered: [],
				exemptions: NON_OPENERS,
				minReasonLength: 30,
				minFlagged: Object.keys(NON_OPENERS).length,
				scannedCount: signalled.length,
				minScanned: 5,
				remediation:
					"dispatch ci.yml and lint.yml on the branch (docs/ci-bot-pr-checks.md) or register the job as a non-opener with its reason",
			});
			expect(audit.problems).toEqual([]);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("derives the dispatch targets from the merge_group workflows", () => {
		// Recurrence: a required-check workflow added without a dispatch target
		// would leave bot PRs with that check absent again.
		expect(dispatchTargets(workflowFiles())).toEqual(["ci.yml", "lint.yml"]);
	});

	it("finds tool-smoke.yml's PR-opening job and passes it", () => {
		const files = workflowFiles();
		const workflow = load(
			files.find(({ file }) => file === "tool-smoke.yml")?.source ?? "",
		);
		expect(
			openerSignals(workflow, workflow.jobs?.["tool-smoke-prs"] ?? {}),
		).toEqual(
			expect.arrayContaining([
				"pull-requests: write",
				"create-pull-request",
				"create-github-app-token",
			]),
		);
		expect(
			botPrFindings(files).filter(({ key }) =>
				key.startsWith("tool-smoke.yml"),
			),
		).toEqual([]);
	});

	// ── the detector, on planted workflows ────────────────────────────────────

	const CI = "on:\n  merge_group:\n  workflow_dispatch:\njobs: {}\n";
	const LINT = CI;
	const dispatchStep = (
		target: string,
		branch: string,
		extra = "",
		ifLine = "        if: ${{ !cancelled() && (steps.pr.outputs.pull-request-operation == 'created' || steps.pr.outputs.pull-request-operation == 'updated') }}",
	) =>
		[
			"      - name: Start CI",
			ifLine,
			"        env:",
			"          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
			extra,
			"        run: |",
			"          set -euo pipefail",
			`          gh workflow run ${target} --ref ${branch}`,
		]
			.filter(Boolean)
			.join("\n");
	const opener = (steps: string, permissions = "actions: write") =>
		[
			"on:\n  schedule:\n    - cron: '0 6 * * *'\njobs:",
			"  open:",
			"    runs-on: ubuntu-latest",
			"    permissions:",
			`      ${permissions}`,
			"      pull-requests: write",
			"    steps:",
			"      - id: pr",
			"        uses: peter-evans/create-pull-request@abc",
			"        with:",
			"          branch: bot/x",
			steps,
		].join("\n");
	const both = `${dispatchStep("ci.yml", "bot/x")}\n${dispatchStep("lint.yml", "bot/x")}`;
	const run = (opening: string) =>
		botPrFindings([
			{ file: "ci.yml", source: CI },
			{ file: "lint.yml", source: LINT },
			{ file: "open.yml", source: opening },
		]).map(({ detail }) => detail);

	it("admits the opener that dispatches every target on its branch", () => {
		expect(run(opener(both))).toEqual([]);
	});

	it.each([
		["no dispatch at all", opener("      - run: echo hi")],
		["only one target", opener(dispatchStep("ci.yml", "bot/x"))],
		[
			"another branch",
			opener(
				`${dispatchStep("ci.yml", "bot/y")}\n${dispatchStep("lint.yml", "bot/y")}`,
			),
		],
		["no actions: write", opener(both, "contents: write")],
		[
			"a swallowed failure",
			opener(both.replaceAll("--ref bot/x", "--ref bot/x || true")),
		],
		[
			"an indirect branch",
			opener(
				both
					.replaceAll("--ref bot/x", '--ref "$BR"')
					.replace(
						"          set -euo",
						"          BR=bot/x\n          set -euo",
					),
			),
		],
		[
			"an echoed command",
			opener(both.replaceAll("gh workflow run", "echo gh workflow run")),
		],
		// Planted spellings the author did not design the detector around: an
		// indirect call, a value reached through another binding, an alias.
		[
			"an indirect REST dispatch",
			opener(
				"      - env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n        run: |\n          set -euo pipefail\n          gh api repos/o/r/actions/workflows/ci.yml/dispatches -f ref=bot/x\n          gh api repos/o/r/actions/workflows/lint.yml/dispatches -f ref=bot/x",
			),
		],
		[
			"a branch reached through an env binding",
			opener(
				both
					.replaceAll("--ref bot/x", '--ref "$BR"')
					.replaceAll("        env:", "        env:\n          BR: bot/x"),
			),
		],
		[
			"a command reached through xargs",
			opener(
				both.replaceAll(
					/gh workflow run (\S+) --ref bot\/x/g,
					"echo $1 | xargs -I{} gh workflow run {} --ref bot/x",
				),
			),
		],
		[
			"a command behind a shell variable alias",
			opener(
				both
					.replaceAll("gh workflow run", "$GH workflow run")
					.replace("          set -euo", "          GH=gh\n          set -euo"),
			),
		],
		[
			"a continue-on-error step",
			opener(
				both.replaceAll(
					"        env:",
					"        continue-on-error: true\n        env:",
				),
			),
		],
		[
			"a dead if",
			opener(
				both.replaceAll(
					"if: ${{ !cancelled() && (steps.pr.outputs.pull-request-operation == 'created' || steps.pr.outputs.pull-request-operation == 'updated') }}",
					"if: false",
				),
			),
		],
		[
			"a widened if",
			opener(both.replaceAll("== 'updated')", "== 'updated' || always())")),
		],
		[
			"a dispatch without !cancelled()",
			opener(
				both.replaceAll(
					"${{ !cancelled() && (steps.pr.outputs.pull-request-operation == 'created' || steps.pr.outputs.pull-request-operation == 'updated') }}",
					"steps.pr.outputs.pull-request-operation == 'created' || steps.pr.outputs.pull-request-operation == 'updated'",
				),
			),
		],
		// Recurrence: #5062 r2 F2, the docs-refresh dispatch sat before the
		// disarm failsafe and the promotion PR step; a failed `gh workflow run`
		// skipped both. Any step after the first dispatch is refused.
		[
			"a failsafe step after the dispatch",
			opener(`${both}\n      - name: Disarm\n        run: echo disarm`),
		],
		[
			"a dispatch step before the create-pull-request step",
			opener(both).replace(
				"      - id: pr\n        uses: peter-evans/create-pull-request@abc\n        with:\n          branch: bot/x\n",
				`${both}\n      - id: pr\n        uses: peter-evans/create-pull-request@abc\n        with:\n          branch: bot/x\n`,
			),
		],
		[
			"a personal token",
			opener(both.replaceAll("secrets.GITHUB_TOKEN", "secrets.BOT_PAT")),
		],
		[
			"a dispatch only in a comment",
			opener(
				"      - run: |\n          # gh workflow run ci.yml --ref bot/x\n          # gh workflow run lint.yml --ref bot/x\n          true",
			),
		],
		[
			"a dispatch step in another job",
			`${opener("      - run: echo hi")}\n  other:\n    runs-on: ubuntu-latest\n    permissions:\n      actions: write\n    steps:\n${both}\n`,
		],
	])("refuses an opener with %s", (_name, source) => {
		expect(run(source).length).toBeGreaterThan(0);
	});

	it("refuses a branch it cannot read", () => {
		expect(
			run(
				opener(both).replace(
					"branch: bot/x",
					"branch: bot/${{ github.run_id }}",
				),
			),
		).toEqual([expect.stringContaining("literal branch")]);
	});

	it("flags a PR opener spelled without create-pull-request", () => {
		// Recurrence: #5062's census must not depend on the opener calling the
		// action it knows. `gh pr create` under pull-requests: write is flagged.
		const source = [
			"on:\n  schedule:\n    - cron: '0 6 * * *'\njobs:",
			"  open:",
			"    permissions:\n      pull-requests: write",
			"    steps:\n      - run: gh pr create --fill",
		].join("\n");
		expect(run(source)).toEqual([
			expect.stringContaining("no create-pull-request step"),
		]);
	});

	it("flags a PR opener that holds only the App token", () => {
		const source = [
			"on:\n  schedule:\n    - cron: '0 6 * * *'\njobs:",
			"  open:",
			"    permissions:\n      contents: read",
			"    steps:\n      - uses: actions/create-github-app-token@abc",
		].join("\n");
		expect(run(source)).toHaveLength(1);
	});

	it("does not flag a job with no opener signal", () => {
		expect(
			run("on: push\njobs:\n  t:\n    steps:\n      - run: echo hi\n"),
		).toEqual([]);
	});

	it("flags a required-check workflow with no workflow_dispatch trigger", () => {
		// Recurrence: a target without the trigger makes `gh workflow run` fail
		// at 06:00 UTC with the PR already open and no checks.
		const findings = botPrFindings([
			{ file: "ci.yml", source: "on:\n  merge_group:\njobs: {}\n" },
			{ file: "lint.yml", source: LINT },
			{ file: "open.yml", source: opener(both) },
		]).map(({ detail }) => detail);
		expect(findings).toEqual([
			expect.stringContaining("ci.yml has no workflow_dispatch trigger"),
		]);
	});
});
