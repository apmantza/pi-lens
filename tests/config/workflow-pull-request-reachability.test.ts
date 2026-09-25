// Registered-or-fail sweep: every job-level `if:` in a workflow a pull
// request can trigger must be reachable ON a pull request, or be registered
// here with a reason.
//
// THE RECURRENCE (#3043, and the 2026-09-15 retro's F2). #3033 edited the
// `pnpm-global` and `mise-repro` steps of install-smoke.yml. Both jobs were
// gated `if: github.event_name != 'pull_request'`, so that PR's own CI ran
// ZERO of the lines it changed; six matrix cells then failed on every master
// push for a day before a human read master. #3049 fixed the one instance by
// giving `pi-load` a PR-eligible cell and its own round-2 review named the
// next one: "`mise-repro` has no `pull_request` cell -- so moving its
// `export PATH=` line below the `pnpm config set` line would have reached
// master unseen." Nothing generic stopped the third. This file is that
// generic thing.
//
// WHAT "REACHABLE" MEANS HERE: eligible to EXECUTE on a pull_request event.
// Not "blocking" -- `mise-repro` is deliberately `continue-on-error` and its
// PR cell exists so the edited lines run and land in a log, not to gate the
// merge. A job with no `if:` at all is trivially reachable and is not
// examined by this first column. The second column (#3087) keeps the two
// apart: a PR-reachable job whose job-level `continue-on-error` holds on a
// pull request must declare "(advisory)" in its check-run name, so neither
// the check list nor `ci-verdict` reads its unconditional success as a gate.
//
// EVALUATION: the same technique as tests/config/ci-infra-kill-rerun-gate.ts
// and install-smoke-gates.ts -- yaml.load the REAL workflow, substitute every
// context path in the LOADED `if:` string with a JSON literal, and evaluate
// with `new Function`. GitHub Actions expression syntax and JS agree exactly
// on this subset (dotted paths, `==`, `!=`, `&&`, `||`, parentheses, quoted
// strings and numbers). An unrecognised context path THROWS rather than
// being guessed at, so a workflow that grows a new one fails loudly here
// instead of being silently read as reachable.
//
// THE MODEL, and what it cannot see. Reachability is decided against a small
// declared set of pull_request contexts (PR_CONTEXTS below) -- a job is
// reachable if ANY of them makes its `if:` true. `needs.*.result` reads
// `success` and `needs.*.outputs.*` reads `'true'`, the permissive reading:
// a job that is reachable only when an upstream job FAILS will read as
// unreachable and needs a registry entry naming that. Two known blind spots,
// stated rather than papered over:
//   1. A workflow with no `pull_request`/`pull_request_target` trigger at all
//      is out of scope -- the nightly-only lanes (tool-smoke, compat-smoke,
//      parser-smoke, release, labels, ...) are deliberate, and flagging every
//      job in them would bury this sweep's real signal in a registry nobody
//      reads.
//   2. Exclusion moved OUT of `if:` and INTO a matrix expression that
//      narrows to an empty list on pull_request would evade this scan. No
//      workflow does that today; install-smoke's three narrowed jobs all
//      keep a non-empty PR cell, which
//      tests/config/install-smoke-gates.test.ts evaluates cell by cell.
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { isAdvisoryCheck } from "../../scripts/lib/ci-checks.mjs";
import {
	assertSortedRegistry,
	auditRegistry,
	listSourceFiles,
	relativePosix,
} from "../support/sweep-kit.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS_DIR = resolve(REPO_ROOT, ".github/workflows");

interface PullRequestContext {
	label: string;
	eventName: string;
	action: string;
	merged: boolean;
}

// A job is PR-reachable if ANY of these makes its `if:` true. Two rows,
// because one cannot serve both: `clear-stale-verdict-labels` requires
// action `synchronize` while `pr-body-lint` requires action != synchronize,
// and both are genuinely PR-reachable.
const PR_CONTEXTS: readonly PullRequestContext[] = [
	{
		label: "pull_request / opened",
		eventName: "pull_request",
		action: "opened",
		merged: false,
	},
	{
		label: "pull_request / synchronize",
		eventName: "pull_request",
		action: "synchronize",
		merged: false,
	},
];

const CONTEXT_PATHS: Array<[string, (ctx: PullRequestContext) => unknown]> = [
	["github.event_name", (ctx) => ctx.eventName],
	["github.event.action", (ctx) => ctx.action],
	["github.event.pull_request.merged", (ctx) => ctx.merged],
	// Same-repo PR by a human: the common case, and the permissive one for
	// every fork / bot guard in the tree.
	["github.event.pull_request.head.repo.full_name", () => "acme/repo"],
	["github.event.pull_request.user.login", () => "a-human"],
	["github.repository", () => "acme/repo"],
	// A `pull_request` event carries no workflow_run payload at all, so every
	// path under it reads null -- which is what makes a workflow_run-only job
	// correctly unreachable from a PR.
	["github.event.workflow_run.head_repository.full_name", () => null],
	["github.event.workflow_run.head_branch", () => null],
	["github.event.workflow_run.conclusion", () => null],
	["github.event.workflow_run.run_attempt", () => null],
	["github.event.workflow_run.event", () => null],
];

// Zero-argument status functions and the permissive `needs.*` reading. Order
// matters only in that these run before the leftover-reference check.
const FUNCTION_SUBSTITUTIONS: Array<[RegExp, string]> = [
	[/always\(\)/g, "true"],
	[/success\(\)/g, "true"],
	[/failure\(\)/g, "false"],
	[/cancelled\(\)/g, "false"],
	[/needs\.[A-Za-z0-9_-]+\.result/g, '"success"'],
	[/needs\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+/g, '"true"'],
];

export function substituteForPullRequest(
	expr: string,
	ctx: PullRequestContext,
): string {
	// `${{ ... }}` is optional around a job-level `if:`; release.yml writes it
	// that way. Strip it before evaluating either spelling.
	let out = expr.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
	for (const [path, read] of CONTEXT_PATHS) {
		out = out.split(path).join(JSON.stringify(read(ctx)) ?? "null");
	}
	for (const [pattern, replacement] of FUNCTION_SUBSTITUTIONS) {
		out = out.replace(pattern, replacement);
	}
	if (/(?:github|needs|env|inputs|steps|vars|secrets)\./.test(out)) {
		throw new Error(
			`workflow-pull-request-reachability: unrecognised context path in an if: expression -- ` +
				`add it to CONTEXT_PATHS with the value a pull_request run would see, rather than ` +
				`letting it be guessed at. Residue: ${out}`,
		);
	}
	// `!=`/`==` before `===`, so the `!==` produced here is not re-rewritten.
	return out.replace(/!=/g, "!==").replace(/(?<![!<>=])==(?!=)/g, "===");
}

export function isPullRequestReachable(expr: string): boolean {
	return PR_CONTEXTS.some((ctx) => {
		const substituted = substituteForPullRequest(expr, ctx);
		// `new Function` over this repo's own workflow text plus JSON-literal
		// fixtures, never external or untrusted input -- the same argument
		// tests/config/ci-infra-kill-rerun-gate.test.ts makes for the same
		// technique.
		return Boolean(new Function(`"use strict"; return (${substituted});`)());
	});
}

interface WorkflowFile {
	/** `.github/workflows/<name>.yml`, the registry key prefix. */
	path: string;
	text: string;
}

type Job = { if?: unknown; name?: unknown; "continue-on-error"?: unknown };
type Workflow = { on?: unknown; jobs?: Record<string, Job> };

function loadWorkflow(text: string): Workflow {
	// `on:` is YAML 1.1 truthy, so js-yaml can key it as boolean `true`.
	const parsed = yaml.load(text) as Record<string, unknown>;
	const triggers = parsed?.on ?? parsed?.[true as unknown as string];
	return { on: triggers, jobs: parsed?.jobs as Record<string, Job> };
}

export function triggersOnPullRequest(workflow: Workflow): boolean {
	const triggers = workflow.on;
	// GitHub accepts three spellings of `on:` and this must read all three.
	// The ARRAY case is checked first and explicitly (round 2, F1): an array
	// is `typeof "object"`, so the mapping branch below would key it with
	// Object.keys and get ["0","1"] -- no match, and every job in that file
	// silently skipped with jobsExamined 0, the sweep reading clean over a
	// file it never looked inside. Every workflow in the tree happens to use
	// the mapping form today, which is exactly why this read clean; the
	// sweep exists for the next member, which may use any spelling.
	const names = Array.isArray(triggers)
		? triggers.map(String)
		: typeof triggers === "string"
			? [triggers]
			: triggers && typeof triggers === "object"
				? Object.keys(triggers as Record<string, unknown>)
				: [];
	return names.some(
		(name) => name === "pull_request" || name === "pull_request_target",
	);
}

/**
 * Every `<file>::<job>` whose `if:` a pull request can never satisfy, in the
 * workflows a pull request can trigger at all. Exported so the fixture case
 * below drives the same function the real-tree sweep does.
 */
export function findPullRequestUnreachableJobs(
	files: readonly WorkflowFile[],
): { flagged: string[]; jobsExamined: number } {
	const flagged: string[] = [];
	let jobsExamined = 0;
	for (const file of files) {
		const workflow = loadWorkflow(file.text);
		if (!triggersOnPullRequest(workflow)) continue;
		for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
			if (typeof job?.if !== "string") continue;
			jobsExamined++;
			if (!isPullRequestReachable(job.if)) {
				flagged.push(`${file.path}::${jobName}`);
			}
		}
	}
	return { flagged: flagged.sort(), jobsExamined };
}

/**
 * True when a job-level `continue-on-error` holds on a pull request: the
 * literal `true`, or an expression true under any PR context (#3087).
 */
export function isAdvisoryOnPullRequest(value: unknown): boolean {
	if (value === true) return true;
	if (typeof value !== "string") return false;
	return PR_CONTEXTS.some((ctx) =>
		Boolean(
			new Function(
				`"use strict"; return (${substituteForPullRequest(value, ctx)});`,
			)(),
		),
	);
}

/**
 * The second column (#3087): every job a pull request can run whose
 * job-level `continue-on-error` holds there, and among those, the ones whose
 * check-run name does not declare it advisory. Such a job's check always
 * concludes `success`, so a name `isAdvisoryCheck` does not recognise makes
 * `ci-verdict` report an unconditional pass as a gating one. The name is the
 * job's `name:` (its template, matrix expressions and all) or else its key.
 */
export function findUndeclaredAdvisoryJobs(files: readonly WorkflowFile[]): {
	flagged: string[];
	advisoryJobs: string[];
} {
	const flagged: string[] = [];
	const advisoryJobs: string[] = [];
	for (const file of files) {
		const workflow = loadWorkflow(file.text);
		if (!triggersOnPullRequest(workflow)) continue;
		for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
			const reachable =
				typeof job?.if !== "string" || isPullRequestReachable(job.if);
			if (!reachable || !isAdvisoryOnPullRequest(job?.["continue-on-error"]))
				continue;
			const key = `${file.path}::${jobName}`;
			advisoryJobs.push(key);
			const checkName = typeof job.name === "string" ? job.name : jobName;
			if (!isAdvisoryCheck(checkName.trim())) flagged.push(key);
		}
	}
	return { flagged: flagged.sort(), advisoryJobs: advisoryJobs.sort() };
}

function repoWorkflowFiles(): WorkflowFile[] {
	return listSourceFiles(WORKFLOWS_DIR, { extensions: [".yml", ".yaml"] })
		.sort()
		.map((absolute) => ({
			path: relativePosix(REPO_ROOT, absolute),
			text: readFileSync(absolute, "utf8"),
		}));
}

/**
 * Master-only lanes that are master-only BY CONSTRUCTION, each with the
 * reason a pull request cannot exercise it. A new entry here is a claim a
 * reviewer reads: the alternative -- giving the lane a PR-eligible cell, the
 * way `pi-load`, `smoke` and `mise-repro` now have one -- is always the
 * preferred answer when the lane's steps can run pre-merge at all.
 */
const EXEMPTIONS: Readonly<Record<string, string>> = {
	".github/workflows/ci-infra-kill-rerun.yml::classify":
		"workflow_run-triggered classifier: it reads a COMPLETED CI run's log, which by definition does not exist while that run is still going. Its own if: truth table is evaluated pre-merge, row by row, in tests/config/ci-infra-kill-rerun-gate.test.ts",
	".github/workflows/ci-infra-kill-rerun.yml::finalize-rerun":
		"workflow_run-triggered terminal-label swap, same lane and same reason as classify above; its if: is evaluated pre-merge in tests/config/ci-infra-kill-rerun-gate.test.ts",
	".github/workflows/ci.yml::record-post-merge-validation":
		"repository_dispatch post-merge recorder: the merge-train lane dispatches it AFTER a merge, so a pre-merge run is not a narrower version of this job, it is a contradiction",
	".github/workflows/close-keyword-verification.yml::verify":
		"pull_request_target gated on github.event.pull_request.merged == true: it verifies what the close keywords DID once the PR is merged, which cannot be observed before the merge",
	".github/workflows/install-smoke.yml::host-latest-smoke":
		"advisory nightly drift lane: it installs the newest published host to detect upstream drift on a schedule, a signal about the ecosystem's state at a point in time rather than about the PR's diff (#2613)",
	".github/workflows/install-smoke.yml::record-post-merge-validation":
		"repository_dispatch post-merge recorder, same shape and same reason as ci.yml's above",
	".github/workflows/lint.yml::record-post-merge-validation":
		"repository_dispatch post-merge recorder, same shape and same reason as ci.yml's above",
};

describe("every PR-triggerable workflow job is reachable on a pull request (#3043)", () => {
	it("flags no master-only job that is not registered with a reason", () => {
		const files = repoWorkflowFiles();
		const { flagged, jobsExamined } = findPullRequestUnreachableJobs(files);
		assertSortedRegistry(
			"workflow-pull-request-reachability exemptions",
			Object.keys(EXEMPTIONS),
		);
		const audit = auditRegistry({
			sweepName: "workflow pull-request reachability",
			flagged,
			registered: [],
			exemptions: EXEMPTIONS,
			// Calibration, measured on 2026-09-16 by raising both floors until
			// the audit printed its own counts, and re-measured in round 2 with
			// the `on:`-reader fixed: 20 workflow files walked, 9 of them
			// PR-triggerable (greetings.yml and mutation.yml carry no
			// job-level `if:` at all), 13 job-level `if:` expressions examined
			// in those 9, 7 of them unreachable from a pull request. Floors are
			// half, rounded down, so an accidental narrowing of the walk (a
			// moved directory, a glob that stops matching .yml) fails loudly
			// instead of reading clean -- AGENTS.md defect shape 10.
			// Recalibrate from this test's OWN measured numbers, never from a
			// figure copied out of a comment or a PR body.
			scannedCount: jobsExamined,
			minScanned: 6,
			minFlagged: 3,
			minReasonLength: 40,
			remediation:
				"Give the job a pull_request-eligible cell the way install-smoke's pi-load/smoke/mise-repro do " +
				"(narrow the matrix on github.event_name instead of gating the job off pull_request), or add it " +
				"to EXEMPTIONS with the reason a pull request cannot exercise it.",
		});
		expect(audit.problems, audit.problems.join("\n")).toEqual([]);
	});

	// REACHABLE is not GATING (#3087). A `continue-on-error` job concludes
	// `success` whatever its steps did, so a PR can satisfy the check above
	// with a lane that never blocks. Such a job must say so in its check-run
	// name, the repo's advisory marker (`scripts/lib/ci-checks.mjs`), so that
	// the check list and `ci-verdict` both read it as advisory.
	it("names every PR-reachable continue-on-error job as advisory", () => {
		const { flagged, advisoryJobs } =
			findUndeclaredAdvisoryJobs(repoWorkflowFiles());
		// Dead-sweep floor (AGENTS.md shape 10): measured 2 on 2026-09-25
		// (ci.yml::targeted-tests-advisory, install-smoke.yml::mise-repro).
		expect(advisoryJobs.length).toBeGreaterThanOrEqual(2);
		expect(
			flagged,
			`PR-reachable continue-on-error job(s) whose check-run name does not end in "(advisory)": ` +
				`${flagged.join(", ")}. Suffix the job's name: with "(advisory)", or make the job ` +
				`blocking on pull_request.`,
		).toEqual([]);
	});

	it("walks every workflow file in the tree, not a hand-maintained list", () => {
		const files = repoWorkflowFiles().map((file) => basename(file.path));
		expect(files.length).toBeGreaterThanOrEqual(15);
		expect(files).toContain("install-smoke.yml");
		expect(files).toContain("ci.yml");
	});
});

// The incident, as a fixture: install-smoke.yml's three jobs as they stood on
// head 1701d01d0 (master red for a day, #3043). All three carry the gate, so
// all three are flagged; the same three on today's tree are not.
describe("the #3043 shape is what this sweep flags", () => {
	const preFixInstallSmoke = [
		"name: install smoke",
		"on:",
		"  push:",
		"    branches: [master]",
		"  pull_request:",
		"    branches: [master]",
		"jobs:",
		"  smoke:",
		"    if: github.event_name != 'pull_request'",
		"    runs-on: ubuntu-latest",
		"    steps:",
		"      - run: echo smoke",
		"  pi-load:",
		"    if: github.event_name != 'pull_request'",
		"    runs-on: ubuntu-latest",
		"    steps:",
		"      - run: echo pi-load",
		"  mise-repro:",
		"    if: github.event_name != 'pull_request'",
		"    runs-on: ubuntu-latest",
		"    steps:",
		"      - run: echo mise-repro",
		"  host-range-smoke:",
		"    runs-on: ubuntu-latest",
		"    steps:",
		"      - run: echo host-range",
		"",
	].join("\n");

	it("flags all three gated jobs and leaves the ungated one alone", () => {
		const { flagged, jobsExamined } = findPullRequestUnreachableJobs([
			{ path: ".github/workflows/install-smoke.yml", text: preFixInstallSmoke },
		]);
		expect(flagged).toEqual([
			".github/workflows/install-smoke.yml::mise-repro",
			".github/workflows/install-smoke.yml::pi-load",
			".github/workflows/install-smoke.yml::smoke",
		]);
		// host-range-smoke has no `if:` at all, so it is never examined.
		expect(jobsExamined).toBe(3);
	});

	it("stops flagging a job once the gate is replaced by a PR-eligible matrix cell", () => {
		const fixed = preFixInstallSmoke.replace(
			"  smoke:\n    if: github.event_name != 'pull_request'\n",
			"  smoke:\n",
		);
		expect(fixed).not.toBe(preFixInstallSmoke);
		const { flagged } = findPullRequestUnreachableJobs([
			{ path: ".github/workflows/install-smoke.yml", text: fixed },
		]);
		expect(flagged).not.toContain(".github/workflows/install-smoke.yml::smoke");
	});

	// Round 2, F1: GitHub Actions accepts THREE spellings of `on:` -- a
	// mapping (`on:\n  pull_request:`), a bare string (`on: pull_request`)
	// and a LIST (`on: [push, pull_request]`). js-yaml parses the list as a
	// JS array, and an array is `typeof "object"`, so keying it with
	// Object.keys yielded ["0","1"] and every job in such a workflow was
	// silently skipped with jobsExamined 0 -- the sweep reading clean over a
	// file it never looked inside. All 20 workflows in the tree use the
	// mapping form today, which is exactly why this was invisible: the
	// sweep's whole purpose is the NEXT member, and the next member is free
	// to use any spelling GitHub accepts.
	it("flags the #3043 shape under the list form of `on:` (round 2, F1)", () => {
		const listForm = [
			"name: install smoke",
			"on: [push, pull_request]",
			"jobs:",
			"  smoke:",
			"    if: github.event_name != 'pull_request'",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - run: echo smoke",
			"",
		].join("\n");
		const { flagged, jobsExamined } = findPullRequestUnreachableJobs([
			{ path: ".github/workflows/install-smoke.yml", text: listForm },
		]);
		expect(jobsExamined).toBe(1);
		expect(flagged).toEqual([".github/workflows/install-smoke.yml::smoke"]);
	});

	it("flags the #3043 shape under the bare-string form of `on:` (round 2, F1)", () => {
		const stringForm = [
			"name: install smoke",
			"on: pull_request",
			"jobs:",
			"  smoke:",
			"    if: github.event_name != 'pull_request'",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - run: echo smoke",
			"",
		].join("\n");
		const { flagged, jobsExamined } = findPullRequestUnreachableJobs([
			{ path: ".github/workflows/install-smoke.yml", text: stringForm },
		]);
		expect(jobsExamined).toBe(1);
		expect(flagged).toEqual([".github/workflows/install-smoke.yml::smoke"]);
	});

	// A LIST form that does not name pull_request stays out of scope, the
	// same as the mapping form below -- the fix must widen the reader, not
	// the scope.
	it("does not flag a list-form workflow that never names pull_request (round 2, F1)", () => {
		const nightlyList = [
			"name: nightly",
			"on: [schedule, workflow_dispatch]",
			"jobs:",
			"  nightly-only:",
			"    if: github.event_name == 'schedule'",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - run: echo nightly",
			"",
		].join("\n");
		const { flagged, jobsExamined } = findPullRequestUnreachableJobs([
			{ path: ".github/workflows/nightly.yml", text: nightlyList },
		]);
		expect(flagged).toEqual([]);
		expect(jobsExamined).toBe(0);
	});

	// A workflow a pull request cannot trigger at all is deliberately out of
	// scope (blind spot 1 in the header): the nightly lanes are nightly on
	// purpose, and flagging all of them would bury the real signal.
	it("does not flag a job in a workflow with no pull_request trigger", () => {
		const nightly = [
			"name: nightly",
			"on:",
			"  schedule:",
			"    - cron: '0 6 * * *'",
			"jobs:",
			"  nightly-only:",
			"    if: github.event_name == 'schedule'",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - run: echo nightly",
			"",
		].join("\n");
		const { flagged, jobsExamined } = findPullRequestUnreachableJobs([
			{ path: ".github/workflows/nightly.yml", text: nightly },
		]);
		expect(flagged).toEqual([]);
		expect(jobsExamined).toBe(0);
	});
});

describe("the reachability model itself", () => {
	it.each([
		["github.event_name == 'pull_request'", true],
		["github.event_name != 'pull_request'", false],
		["github.event_name == 'push'", false],
		[
			"github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
			false,
		],
		[
			"always() && github.event_name == 'repository_dispatch' && needs.validate.result == 'success'",
			false,
		],
		// Two rows in PR_CONTEXTS, because neither action value alone
		// classifies both of these correctly.
		[
			"github.event_name == 'pull_request' && github.event.action == 'synchronize'",
			true,
		],
		[
			"github.event_name == 'pull_request' && github.event.action != 'synchronize'",
			true,
		],
		// A non-event gate is permissive: an upstream success and a truthy
		// output are the model's reading.
		["needs.detect-lockfile-change.outputs.changed == 'true'", true],
		["github.event.pull_request.user.login != 'dependabot[bot]'", true],
		["github.event.workflow_run.conclusion == 'failure'", false],
	])("%s -> reachable=%s", (expr, expected) => {
		expect(isPullRequestReachable(expr)).toBe(expected);
	});

	// A context path nobody declared must throw, not be guessed at: silently
	// reading an unknown path as reachable is how a sweep stops sweeping
	// (AGENTS.md defect shape 10).
	it("throws on an undeclared context path instead of reading the job as reachable", () => {
		expect(() =>
			isPullRequestReachable("github.event.issue.number == 1"),
		).toThrow(/unrecognised context path/);
	});
});

describe("reachable and gating are two columns (#3087)", () => {
	const workflow = (jobs: string) => ({
		path: ".github/workflows/fixture.yml",
		text: ["on:", "  pull_request:", "  push:", "jobs:", jobs].join("\n"),
	});

	it("flags a PR-reachable continue-on-error job whose name is not advisory", () => {
		const file = workflow(
			[
				"  mise-repro:",
				"    name: mise repro (#285) · ${{ matrix.os }}",
				"    continue-on-error: true",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: echo mise",
			].join("\n"),
		);
		expect(findUndeclaredAdvisoryJobs([file]).flagged).toEqual([
			".github/workflows/fixture.yml::mise-repro",
		]);
	});

	it("flags an unnamed advisory job, whose check-run name is its key", () => {
		const file = workflow(
			[
				"  drift:",
				"    continue-on-error: true",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: echo drift",
			].join("\n"),
		);
		expect(findUndeclaredAdvisoryJobs([file]).flagged).toEqual([
			".github/workflows/fixture.yml::drift",
		]);
	});

	it("does not flag an advisory job that declares it in its name", () => {
		const file = workflow(
			[
				"  mise-repro:",
				"    name: mise repro (#285) · ${{ matrix.os }} (advisory)",
				"    continue-on-error: true",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: echo mise",
			].join("\n"),
		);
		const result = findUndeclaredAdvisoryJobs([file]);
		expect(result.flagged).toEqual([]);
		expect(result.advisoryJobs).toEqual([
			".github/workflows/fixture.yml::mise-repro",
		]);
	});

	it("flags a job whose continue-on-error expression holds on a pull request", () => {
		const file = workflow(
			[
				"  probe:",
				"    name: probe",
				"    continue-on-error: ${{ github.event_name == 'pull_request' }}",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: echo probe",
			].join("\n"),
		);
		expect(findUndeclaredAdvisoryJobs([file]).flagged).toEqual([
			".github/workflows/fixture.yml::probe",
		]);
	});

	it("does not count a job that blocks on pull_request (option 1's shape)", () => {
		const file = workflow(
			[
				"  mise-repro:",
				"    name: mise repro (#285)",
				"    continue-on-error: ${{ github.event_name != 'pull_request' }}",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: echo mise",
			].join("\n"),
		);
		expect(findUndeclaredAdvisoryJobs([file])).toEqual({
			flagged: [],
			advisoryJobs: [],
		});
	});

	it("does not count an advisory job a pull request cannot run", () => {
		const file = workflow(
			[
				"  nightly:",
				"    if: github.event_name != 'pull_request'",
				"    continue-on-error: true",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: echo nightly",
			].join("\n"),
		);
		expect(findUndeclaredAdvisoryJobs([file]).advisoryJobs).toEqual([]);
	});
});
