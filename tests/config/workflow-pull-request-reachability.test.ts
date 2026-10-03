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
// EVALUATION and THE MODEL live in the shared owner,
// tests/support/workflow-pull-request-reachability.ts (#3941): the contexts,
// the `${{ }}`/`==` substitution, the `new Function` evaluation, and
// `triggersOnPullRequest`. This file keeps only the sweep: the matrix
// narrowing helpers below (`pullRequestMatrixCells` and friends), the
// registry audit, and the fixtures. `isPullRequestReachable` is imported so
// the reachability cases here drive the same function the sweep does.
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isAdvisoryCheck } from "../../scripts/lib/ci-checks.mjs";
import {
	assertSortedRegistry,
	auditRegistry,
	listSourceFiles,
	relativePosix,
} from "../support/sweep-kit.js";
import {
	PR_CONTEXTS,
	type PullRequestContext,
	type ScalarLiteralValue,
	evaluateForPullRequest,
	githubEquals,
	isPullRequestReachable,
	isTrueForPullRequest,
	loadWorkflow,
	substituteForPullRequest,
	triggersOnPullRequest,
	type WorkflowFile,
} from "../support/workflow-pull-request-reachability.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS_DIR = resolve(REPO_ROOT, ".github/workflows");

// The expression model itself is imported from
// tests/support/workflow-pull-request-reachability.ts (see the header).

/** A matrix value as a pull request sees it: `${{ }}` evaluated, else as written. */
function resolveMatrixValue(value: unknown, ctx: PullRequestContext): unknown {
	return typeof value === "string" && /^\s*\$\{\{[\s\S]*\}\}\s*$/.test(value)
		? evaluateForPullRequest(value, ctx)
		: value;
}

function matchesEntry(
	cell: Record<string, unknown>,
	entry: unknown,
	allowMissing: boolean,
): boolean {
	if (!entry || typeof entry !== "object") return false;
	return Object.entries(entry).every(([key, value]) =>
		allowMissing && !(key in cell) ? true : cell[key] === value,
	);
}

/**
 * How many cells a job's `strategy.matrix` yields under one PR context
 * (#3085 gap 2). GitHub's semantics: the cross product of the axes, minus
 * every combination an `exclude` entry fully matches, plus each `include`
 * entry that extends no remaining combination as a cell of its own. A job
 * with no matrix runs once.
 */
export function pullRequestMatrixCells(
	matrix: unknown,
	ctx: PullRequestContext,
): number {
	if (matrix === undefined) return 1;
	const resolved = resolveMatrixValue(matrix, ctx);
	if (!resolved || typeof resolved !== "object") return 1;
	const entries = Object.entries(resolved as Record<string, unknown>);
	const axes = entries.filter(
		([key]) => key !== "include" && key !== "exclude",
	);
	let cells: Record<string, unknown>[] = axes.length > 0 ? [{}] : [];
	for (const [key, raw] of axes) {
		const value = resolveMatrixValue(raw, ctx);
		const values = Array.isArray(value) ? value : [value];
		cells = cells.flatMap((cell) =>
			values.map((item) => ({ ...cell, [key]: item })),
		);
	}
	const exclude = resolveMatrixValue(
		(resolved as Record<string, unknown>).exclude,
		ctx,
	);
	if (Array.isArray(exclude)) {
		cells = cells.filter(
			(cell) => !exclude.some((entry) => matchesEntry(cell, entry, false)),
		);
	}
	const include = resolveMatrixValue(
		(resolved as Record<string, unknown>).include,
		ctx,
	);
	let count = cells.length;
	if (Array.isArray(include)) {
		for (const entry of include) {
			if (!cells.some((cell) => matchesEntry(cell, entry, true))) count++;
		}
	}
	return count;
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
			const condition = typeof job?.if === "string" ? job.if : undefined;
			const matrix = job?.strategy?.matrix;
			if (condition === undefined && matrix === undefined) continue;
			jobsExamined++;
			// Reachable only if ONE pull_request context both satisfies the
			// `if:` and leaves the matrix a cell (#3085 gap 2): an exclusion moved
			// from `if:` into the matrix is the same unreachability.
			const reachable = PR_CONTEXTS.some(
				(ctx) =>
					(condition === undefined || isTrueForPullRequest(condition, ctx)) &&
					pullRequestMatrixCells(matrix, ctx) > 0,
			);
			if (!reachable) flagged.push(`${file.path}::${jobName}`);
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
	".github/workflows/close-keyword-verification.yml::verify":
		"pull_request_target gated on github.event.pull_request.merged == true: it verifies what the close keywords DID once the PR is merged, which cannot be observed before the merge",
	".github/workflows/install-smoke.yml::host-latest-smoke":
		"advisory nightly drift lane: it installs the newest published host to detect upstream drift on a schedule, a signal about the ecosystem's state at a point in time rather than about the PR's diff (#2613)",
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
			// PR-triggerable (greetings.yml and the former mutation.yml carried no
			// job-level `if:` at all), 13 job-level `if:` expressions examined
			// in those 9, 7 of them unreachable from a pull request. Floors are
			// half, rounded down, so an accidental narrowing of the walk (a
			// moved directory, a glob that stops matching .yml) fails loudly
			// instead of reading clean -- AGENTS.md defect shape 10.
			// Recalibrate from this test's OWN measured numbers, never from a
			// figure copied out of a comment or a PR body.
			// Re-measured 2026-09-25 with matrices evaluated (#3085): 20 files,
			// 19 jobs examined (an `if:` or a matrix), 7 flagged.
			scannedCount: jobsExamined,
			minScanned: 9,
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

	// #3941 r3: the old JS-strict evaluation read a mixed-case pull-request
	// gate as unreachable and demanded a registry exemption for a real PR job.
	// The fold reads GitHub's case-insensitive equality, so no flag.
	it("does not flag a mixed-case pull-request gate as unreachable", () => {
		const file = [
			"on:",
			"  pull_request:",
			"jobs:",
			"  mixed:",
			"    if: github.event_name == 'PULL_REQUEST'",
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - run: echo mixed",
			"",
		].join("\n");
		const { flagged } = findPullRequestUnreachableJobs([
			{ path: ".github/workflows/fixture.yml", text: file },
		]);
		expect(flagged).toEqual([]);
	});

	// #3941 r4 (F6): the quoted-prose pair is TRUE on a pull request (two
	// constant strings differ), so a real PR job must not be flagged
	// unreachable. The pre-fix raw substitution corrupted the DATA and read it as
	// false.
	it("does not flag a true constant quoted-prose pair", () => {
		const quotedPair = `'github.event_name' != '"pull_request"' && 'github.event_name' != '"pull_request_target"'`;
		const file = [
			"on:",
			"  pull_request:",
			"jobs:",
			"  quoted:",
			`    if: ${JSON.stringify(quotedPair)}`,
			"    runs-on: ubuntu-latest",
			"    steps:",
			"      - run: echo quoted",
			"",
		].join("\n");
		const { flagged } = findPullRequestUnreachableJobs([
			{ path: ".github/workflows/fixture.yml", text: file },
		]);
		expect(flagged).toEqual([]);
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

	// #3941 r3: GitHub compares strings case-insensitively and coerces a
	// mismatched scalar type to a number. The shared fold routes both callers
	// through `githubEquals`, so a mixed-case pull-request literal is reachable
	// rather than silently read as unreachable -- which used to make
	// `findUndeclaredAdvisoryJobs` SKIP a real PR advisory job.
	it.each([
		["github.event_name == 'PULL_REQUEST'", true],
		["github.event_name == 'Pull_Request'", true],
		["github.event_name == 'PUSH'", false],
		["'0' == 0", true],
	])("folds GitHub equality: %s -> reachable=%s", (expr, expected) => {
		expect(isPullRequestReachable(expr)).toBe(expected);
	});

	// #3941 r4 (F6): the shared full model used to rewrite string-literal DATA
	// before folding, because every pass ran on raw text. A quoted literal is
	// DATA: a context path, a status function, or an operator inside it is
	// GitHub's own string bytes, never CODE. These cases drive the real consumer
	// entry point, not a helper.
	const openedContext = PR_CONTEXTS[0] as PullRequestContext;

	it.each([
		["'github.event_name'", "github.event_name"],
		["'always()'", "always()"],
		["'x==y'", "x==y"],
	])("keeps quoted literal DATA intact: %s", (expr, expected) => {
		expect(evaluateForPullRequest(expr, openedContext)).toBe(expected);
	});

	it("folds a constant quoted-prose pair the way GitHub compares it", () => {
		expect(
			isPullRequestReachable(
				`'github.event_name' != '"pull_request"' && 'github.event_name' != '"pull_request_target"'`,
			),
		).toBe(true);
	});

	it("does not read a context path inside a quoted literal as a context read", () => {
		expect(
			evaluateForPullRequest(
				"'github.event.issue.number' == 'github.event.issue.number'",
				openedContext,
			),
		).toBe(true);
	});

	it("reads GitHub's doubled-quote escape instead of producing invalid JS", () => {
		expect(
			evaluateForPullRequest("github.event_name == 'don''t'", openedContext),
		).toBe(false);
		expect(evaluateForPullRequest("'don''t' == 'don''t'", openedContext)).toBe(
			true,
		);
	});

	it("treats a backslash in a GitHub string as data, not a JS escape", () => {
		// `\u0041` is six literal characters in GitHub's grammar; JS would read
		// it as `A`, so a true result here would be the old silent decode.
		expect(evaluateForPullRequest("'a\\u0041b' == 'aAb'", openedContext)).toBe(
			false,
		);
	});

	it("reports a doubled-away or unclosed literal as unsupported", () => {
		expect(() =>
			evaluateForPullRequest(
				"github.event_name == 'pull_requ\\'est'",
				openedContext,
			),
		).toThrow(/unsupported expression/);
	});

	// #3941 r5 (F7): the fold used to trust token adjacency as operand
	// identity, but GitHub binds `!` and the relationals tighter than `==`/`!=`
	// and compares left-associatively. A literal comparison that is not a
	// complete operand is REFUSED with the bounded unsupported-expression
	// error, never folded into a guessed boolean. Each case drives the real
	// consumer entry point.
	it.each([
		// relational to the left of the equality's left operand
		"1 < 2 == true",
		"0 > 1 == false",
		"2 < 3 == true",
		// the same unsupported topology even when the guess happens to match
		"1 > 0 == true",
		// a relational takes the equality's right operand
		"0 == 1 < 2",
		"1 == 2 < 3",
		"true == 1 < 2",
		// prefix `!` directly on the operand
		"! 'x' != 'y'",
		"!1 == 0",
		"! 1 < 2 == true",
		// a comparison run that starts or ends at a non-literal operand
		"fromJSON('0') == 1 == 2",
		"1 == 1 == fromJSON('1')",
		// mixed with a supported boolean operator
		"1 < 2 == true && 'a' == 'A'",
	])("refuses unsupported comparison topology: %s", (expr) => {
		expect(() => isPullRequestReachable(expr)).toThrow(
			/unsupported expression/,
		);
	});

	it.each([
		// parentheses make the comparison a complete operand again
		["(1 > 0) == true", true],
		["(1 < 2) == true", true],
		["!(1 == 2)", true],
		["((1 == 1)) == true", true],
		// equality chains evaluate left-associatively, as GitHub does
		["1 == 1 == true", true],
		["1 != 1 == false", true],
		["1 == 2 == 3", false],
		["1 == 2 == 3 == 4", false],
		["1 == 1 == 1 == 1", true],
		// boolean operators bind looser than equality
		["1 < 2 && 3 == 3", true],
		["1 == 1 || 2 == 3", true],
	])(
		"keeps supported comparison topology: %s -> reachable=%s",
		(expr, expected) => {
			expect(isPullRequestReachable(expr)).toBe(expected);
		},
	);

	// #3941 r6 (F9): `COMPARISON_BOUNDARY_OPERATORS` already lists `<=`,
	// `>=`, and `!=`, and the entry guard keeps a non-literal right operand
	// out of the fold, but no case pinned any of the four. Removing `<=`,
	// `>=`, or `!=` from the boundary set, or forcing the entry guard false,
	// survived the r5 suite and silently restored the wrong-boolean F7 harm at
	// that neighbour. Each case drives the real model entry point AND the real
	// caller, so the refusal propagates instead of a clean `[]` flag.
	it.each(["1 <= 2 == true", "1 >= 2 == true", "fromJSON('0') != 1 == 2"])(
		"refuses an unsupported comparison neighbour: %s",
		(expr) => {
			expect(() => isPullRequestReachable(expr)).toThrow(
				/unsupported expression/,
			);
			const file: WorkflowFile = {
				path: ".github/workflows/fixture.yml",
				text: [
					"on:",
					"  pull_request:",
					"jobs:",
					"  probe:",
					`    if: ${expr}`,
				].join("\n"),
			};
			expect(() => findPullRequestUnreachableJobs([file])).toThrow(
				/unsupported expression/,
			);
		},
	);

	// #3941 r6 (F9): `1 == fromJSON('1')` is supported, not refused: the right
	// operand is a call, so the entry guard leaves the comparison to the
	// evaluator and GitHub loose equality makes `1 == 1` true. The guard is
	// load-bearing -- forcing it false folds the call as a literal and throws a
	// raw `SyntaxError` from `new Function`. A job gated on the expression is
	// reachable, and its advisory declaration is still named.
	it("keeps a comparison whose right operand is a call, not a literal", () => {
		expect(isPullRequestReachable("1 == fromJSON('1')")).toBe(true);
		const file: WorkflowFile = {
			path: ".github/workflows/fixture.yml",
			text: [
				"on:",
				"  pull_request:",
				"jobs:",
				"  probe:",
				"    name: probe (advisory)",
				"    continue-on-error: true",
				"    if: 1 == fromJSON('1')",
			].join("\n"),
		};
		expect(findPullRequestUnreachableJobs([file]).flagged).toEqual([]);
		expect(findUndeclaredAdvisoryJobs([file])).toEqual({
			flagged: [],
			advisoryJobs: [".github/workflows/fixture.yml::probe"],
		});
	});

	// #3941 r5 (F8.1): GitHub's expression grammar has single-quoted strings
	// only. A double-quoted literal is invalid, and the model names the
	// grammar rule at the real caller instead of falling through to a generic
	// character error.
	it("reports a GitHub-invalid double-quoted string as unsupported", () => {
		expect(() =>
			evaluateForPullRequest(
				'github.event_name == "pull_request"',
				openedContext,
			),
		).toThrow(/double-quoted string/);
	});

	// #3941 r5 (F8.3): the number token keeps GitHub's hex spelling (and the
	// exponent, leading-dot, and signed spellings), so `0xff == 255` is true.
	it.each([
		["0xff == 255", true],
		["0x10 == 16", true],
		["1e2 == 100", true],
		[".5 == 0.5", true],
		["-1 == -1", true],
		["1.5 == 1.5", true],
	])("keeps the number spelling GitHub accepts: %s", (expr, expected) => {
		expect(isPullRequestReachable(expr)).toBe(expected);
	});

	// #3941 r5 (F8.4): the `^...$` anchors on the needs forms are load-bearing.
	// A path that only begins or ends like a supported one must reach the
	// code-residue refusal, not be silently substituted as `success`/`'true'`.
	it("refuses a needs path that only begins or ends like a supported one", () => {
		for (const expr of [
			"needs.foo.result.bar == 'success'",
			"needs.foo.outputs.name.extra == 'true'",
			"xneeds.foo.result == 'success'",
			"xneeds.foo.outputs.name == 'true'",
		]) {
			expect(() => isPullRequestReachable(expr)).toThrow(
				/unrecognised context path/,
			);
		}
	});

	it("keeps a quoted literal that spells a needs path as DATA", () => {
		expect(
			evaluateForPullRequest(
				"'needs.foo.result.bar' == 'needs.foo.result.bar'",
				openedContext,
			),
		).toBe(true);
	});

	it("substitutes the supported needs result and output forms", () => {
		expect(isPullRequestReachable("needs.foo.result == 'success'")).toBe(true);
		expect(isPullRequestReachable("needs.foo.outputs.name == 'true'")).toBe(
			true,
		);
	});

	// #3941 r5 (F8.2): the context-value domain is closed to scalars at the
	// type level, so the old runtime non-scalar branch is deleted rather than
	// kept as an unreachable guard. The assertion below does not type-check if
	// `ScalarLiteralValue` is widened to admit an object.
	it("closes the context-value domain to scalars at the type level", () => {
		const scalarRow: [string, (ctx: PullRequestContext) => ScalarLiteralValue] =
			["github.example.scalar", () => 1];
		expect(scalarRow[0]).toBe("github.example.scalar");
		// A CONTEXT_PATHS row's value function may only return a scalar literal.
		// @ts-expect-error a context path may only inject a scalar literal
		const objectRowValue = (): ScalarLiteralValue => ({ nested: true });
		expect(objectRowValue).toBeTypeOf("function");
	});

	it("never rescans an injected context value as code", () => {
		// The value reads like a context path; a second raw pass would rewrite
		// it, and the two operands would no longer be equal.
		expect(
			evaluateForPullRequest("github.event_name == 'github.repository'", {
				...openedContext,
				eventName: "github.repository",
			}),
		).toBe(true);
	});

	it("preserves fromJSON JSON bytes, keys, and case", () => {
		expect(
			evaluateForPullRequest(
				`fromJSON('[{"KEY":"github.event_name"},{"always()":"x==y"}]')`,
				openedContext,
			),
		).toEqual([{ KEY: "github.event_name" }, { "always()": "x==y" }]);
	});

	it("exposes one GitHub equality owner for the fold and the projection", () => {
		expect(githubEquals("Pull_Request", "pull_request")).toBe(true);
		expect(githubEquals("push", "pull_request")).toBe(false);
		expect(githubEquals("0", 0)).toBe(true);
		expect(githubEquals(null, 0)).toBe(true);
		expect(githubEquals(false, 0)).toBe(true);
		expect(githubEquals(true, 1)).toBe(true);
		expect(githubEquals("nope", 0)).toBe(false);
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

	// #3941 r3 caller witness: a mixed-case pull-request gate is a REAL
	// pull-request job. The old JS-strict evaluation read it as unreachable and
	// this sweep skipped its missing advisory marker; the fold keeps it in the
	// population.
	it("names a mixed-case advisory job instead of skipping it", () => {
		const file = workflow(
			[
				"  probe:",
				"    name: probe",
				"    if: github.event_name == 'PULL_REQUEST'",
				"    continue-on-error: true",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: echo probe",
			].join("\n"),
		);
		expect(findUndeclaredAdvisoryJobs([file]).flagged).toEqual([
			".github/workflows/fixture.yml::probe",
		]);
	});

	// #3941 r4 (F6) caller witness: the quoted-prose pair is TRUE on a pull
	// request, so this job is PR-reachable. Skipping it would drop a real
	// advisory job from the sweep.
	it("names an advisory job whose quoted-prose gate is true on a pull request", () => {
		const quotedPair = `'github.event_name' != '"pull_request"' && 'github.event_name' != '"pull_request_target"'`;
		const file = workflow(
			[
				"  probe:",
				"    name: probe",
				`    if: ${JSON.stringify(quotedPair)}`,
				"    continue-on-error: true",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: echo probe",
			].join("\n"),
		);
		expect(findUndeclaredAdvisoryJobs([file]).flagged).toEqual([
			".github/workflows/fixture.yml::probe",
		]);
	});
});

// #3085 gap 2: the #3043 exclusion moved out of `if:` and into the matrix.
// The job has no `if:` at all, so the first column used to skip it, but no
// pull request ever gets a cell.
describe("matrix-level evasion is the same unreachability (#3085)", () => {
	const workflow = (jobs: string[]) => ({
		path: ".github/workflows/fixture.yml",
		text: ["on:", "  pull_request:", "  push:", "jobs:", ...jobs, ""].join(
			"\n",
		),
	});

	it("flags a job whose only matrix axis is empty on a pull request", () => {
		const file = workflow([
			"  smoke:",
			"    runs-on: ubuntu-latest",
			"    strategy:",
			"      matrix:",
			"        pm: ${{ github.event_name == 'pull_request' && fromJSON('[]') || fromJSON('[\"npm\"]') }}",
			"    steps:",
			"      - run: echo smoke",
		]);
		expect(findPullRequestUnreachableJobs([file]).flagged).toEqual([
			".github/workflows/fixture.yml::smoke",
		]);
	});

	it("flags a job whose exclude removes every cell on a pull request", () => {
		const file = workflow([
			"  smoke:",
			"    runs-on: ${{ matrix.os }}",
			"    strategy:",
			"      matrix:",
			"        os: [ubuntu-latest, macos-latest]",
			'        exclude: ${{ github.event_name == \'pull_request\' && fromJSON(\'[{"os":"ubuntu-latest"},{"os":"macos-latest"}]\') || fromJSON(\'[]\') }}',
			"    steps:",
			"      - run: echo smoke",
		]);
		expect(findPullRequestUnreachableJobs([file]).flagged).toEqual([
			".github/workflows/fixture.yml::smoke",
		]);
	});

	it("does not flag install-smoke's narrowing, which keeps one PR cell", () => {
		const file = workflow([
			"  mise-repro:",
			"    runs-on: ${{ matrix.os }}",
			"    strategy:",
			"      matrix:",
			"        os: [ubuntu-latest, macos-latest]",
			"        pi_via: ${{ github.event_name == 'pull_request' && fromJSON('[\"mise-node\"]') || fromJSON('[\"mise-node\", \"mise-npm-backend\"]') }}",
			"        exclude: ${{ github.event_name == 'pull_request' && fromJSON('[{\"os\":\"macos-latest\"}]') || fromJSON('[]') }}",
			"    steps:",
			"      - run: echo mise",
		]);
		expect(findPullRequestUnreachableJobs([file]).flagged).toEqual([]);
	});

	it("counts an include-only matrix as its include entries", () => {
		const file = workflow([
			"  lanes:",
			"    runs-on: ubuntu-latest",
			"    strategy:",
			"      matrix:",
			"        include: ${{ github.event_name == 'pull_request' && fromJSON('[{\"lane\":\"linux\"}]') || fromJSON('[]') }}",
			"    steps:",
			"      - run: echo lanes",
		]);
		expect(findPullRequestUnreachableJobs([file]).flagged).toEqual([]);
	});

	it("keeps an include entry that matches no combination as its own cell", () => {
		const file = workflow([
			"  smoke:",
			"    runs-on: ubuntu-latest",
			"    strategy:",
			"      matrix:",
			"        os: [ubuntu-latest]",
			"        exclude: ${{ github.event_name == 'pull_request' && fromJSON('[{\"os\":\"ubuntu-latest\"}]') || fromJSON('[]') }}",
			"        include: ${{ github.event_name == 'pull_request' && fromJSON('[{\"os\":\"windows-latest\"}]') || fromJSON('[]') }}",
			"    steps:",
			"      - run: echo smoke",
		]);
		expect(findPullRequestUnreachableJobs([file]).flagged).toEqual([]);
	});

	it("requires the if: and a non-empty matrix under the same pull_request context", () => {
		// synchronize-only if:, and a matrix empty on synchronize only.
		const file = workflow([
			"  split:",
			"    if: github.event.action == 'synchronize'",
			"    runs-on: ubuntu-latest",
			"    strategy:",
			"      matrix:",
			"        leg: ${{ github.event.action == 'synchronize' && fromJSON('[]') || fromJSON('[\"a\"]') }}",
			"    steps:",
			"      - run: echo split",
		]);
		expect(findPullRequestUnreachableJobs([file]).flagged).toEqual([
			".github/workflows/fixture.yml::split",
		]);
	});
});
