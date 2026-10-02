import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { REQUIRED_CHECKS } from "../../scripts/lib/ci-checks.mjs";

// #3754: GitHub's merge queue tests each queued PR on a `merge_group` commit
// and waits for the required checks to report THERE. A required check whose
// workflow has no `merge_group` trigger never reports on that commit, so the
// queue waits until its timeout and ejects every PR. This file pins the
// trigger on each workflow that produces a required check, and that no
// required job is gated off on that event.

const ROOT = resolve(import.meta.dirname, "../..");

type Step = {
	name?: string;
	if?: string;
	run?: string;
	uses?: string;
	env?: Record<string, string>;
	with?: Record<string, string>;
};
type Job = {
	name?: string;
	if?: string;
	needs?: string | string[];
	env?: Record<string, string>;
	with?: Record<string, string>;
	steps?: Step[];
};
type Workflow = {
	on?: Record<string, unknown> | string[] | string;
	jobs: Record<string, Job>;
};
const load = (file: string) =>
	yaml.load(readFileSync(resolve(ROOT, file), "utf8")) as Workflow;

// The required checks, as branch protection names them on master (read live on
// 2026-09-30 with `gh api repos/apmantza/pi-lens/branches/master/protection`:
// Lint & type-check, Unit tests, Install test x3, knip, oxfmt format check,
// TLA+ models -- 8 contexts).
// GitHub is the source of truth and is not readable from a test, so this list
// is the one hand-kept mirror; the REQUIRED_CHECKS subset assertion below
// keeps it from drifting away from the script-side list.
const REQUIRED_JOBS = [
	{
		file: ".github/workflows/ci.yml",
		job: "lint-and-typecheck",
		name: "Lint & type-check",
	},
	{ file: ".github/workflows/ci.yml", job: "unit-tests", name: "Unit tests" },
	{
		file: ".github/workflows/ci.yml",
		job: "install-test",
		name: "Install test (${{ matrix.os }})",
	},
	{ file: ".github/workflows/lint.yml", job: "knip", name: "knip" },
	{
		file: ".github/workflows/lint.yml",
		job: "oxfmt",
		name: "oxfmt format check",
	},
	{
		file: ".github/workflows/ci.yml",
		job: "tla-models",
		name: "TLA+ models",
	},
];
const asList = (needs: string | string[] | undefined) =>
	Array.isArray(needs) ? needs : needs ? [needs] : [];

// Jobs that read `github.event.pull_request` yet MUST run on `merge_group`, so
// they cannot carry the `pull_request` guard. `changes` (#3801) classifies the
// diff for the heavy gate; on every non-pull_request event (merge_group
// included) `scripts/ci-changed-files.mjs` takes the fail-open full-suite
// direction and never reads `--repo`/`--pr`, so an empty
// `github.event.pull_request` is its supported input, not an error. That
// premise is pinned by tests/config/docs-only-ci-skip.test.ts (`runs the full
// suite for a merge_group event even for a docs-only file list`). Every row is
// checked to still be needed at the end of the guard test, so a future fix
// that removes the need reds here instead of leaving a stale admission.
const MERGE_GROUP_SAFE_PR_CONTEXT = [".github/workflows/ci.yml#changes"];

describe("#3754 merge queue workflow contract", () => {
	// Recurrence it prevents: enabling the queue while a required-check
	// workflow lacks `merge_group` (a workflow added later, or a trigger block
	// rewritten) strands every queued PR until the queue's check timeout.
	it("runs every required-check workflow on merge_group", () => {
		for (const file of new Set(REQUIRED_JOBS.map((entry) => entry.file))) {
			const on = load(file).on as Record<string, unknown>;
			expect(Object.keys(on), file).toContain("merge_group");
			expect(on.merge_group, file).toEqual({ types: ["checks_requested"] });
		}
	});

	// Recurrence: the job ids above drifting from the workflow (a rename leaves
	// the pin green while pinning nothing).
	it("names each required job exactly as branch protection does", () => {
		for (const { file, job, name } of REQUIRED_JOBS) {
			expect(load(file).jobs[job]?.name, `${file}#${job}`).toBe(name);
		}
		for (const required of REQUIRED_CHECKS) {
			expect(
				REQUIRED_JOBS.map((entry) => entry.name),
				required,
			).toContain(required);
		}
	});

	// Recurrence: a required job (or a job it `needs:`) that skips itself on
	// `merge_group` never reports on the merge commit, and the queue then waits
	// on a check that never ran. The gate is read structurally: a comparison of
	// `github.event_name` to a literal other than `merge_group` (`== 'pull_request'`,
	// `!= 'merge_group'`, `== 'workflow_dispatch'`) skips merge_group;
	// `always()`, `!cancelled()` and needs/result gates run there.
	it("does not gate any required job, or its needs chain, off merge_group", () => {
		for (const { file, job } of REQUIRED_JOBS) {
			const jobs = load(file).jobs;
			const chain = new Set<string>();
			const visit = (id: string) => {
				if (chain.has(id)) return;
				chain.add(id);
				for (const dependency of asList(jobs[id]?.needs)) visit(dependency);
			};
			visit(job);
			for (const id of chain) {
				const gate = jobs[id]?.if;
				expect(
					!gatesOffMergeGroup(gate),
					`${file}#${id} is in ${job}'s needs chain and carries if: ${gate}`,
				).toBe(true);
			}
		}
	});

	// Recurrence: the PR-only lanes (PR title/body, changelog fast-fail,
	// targeted advisory) read `github.event.pull_request`, which is empty on a
	// merge_group run. They must be skipped there, by an explicit
	// `pull_request` guard, never by failing. The short `github.base_ref` /
	// `github.head_ref` forms are PR-only too (#3765 F4), and a step-level
	// `pull_request` guard covers the reads inside that step (the `test` job's
	// fetch-base step).
	it("keeps every pull_request-context job guarded to pull_request", () => {
		const offenders: string[] = [];
		for (const file of [
			".github/workflows/ci.yml",
			".github/workflows/lint.yml",
		]) {
			const { jobs } = load(file);
			for (const [id, job] of Object.entries(jobs)) {
				if (
					jobUsesPullRequestContext(job) &&
					!MERGE_GROUP_SAFE_PR_CONTEXT.includes(`${file}#${id}`)
				)
					offenders.push(`${file}#${id}`);
			}
		}
		expect(offenders).toEqual([]);
		// Each admission must still be needed: the job reads PR context and is
		// unguarded. If either stops being true, delete the row (no blanket
		// admission).
		for (const key of MERGE_GROUP_SAFE_PR_CONTEXT) {
			const [file, id] = key.split("#");
			const job = load(file).jobs[id];
			expect(job, key).toBeDefined();
			expect(jobUsesPullRequestContext(job), key).toBe(true);
			expect(guardsToPullRequest(job?.if), key).toBe(false);
		}
	});

	// #3765 F4, red-first: the detector must see the short PR-context
	// spellings (`github.base_ref`/`github.head_ref`), not only the long form.
	// A step whose own `if` guards to pull_request is safe; the same read in an
	// unguarded step or job is an offender. `github.event.pull_request.head.sha`
	// stays excluded (the merge_group-safe metadata ternary).
	it("detects the short PR-context spellings outside a guard", () => {
		expect(
			jobUsesPullRequestContext({
				steps: [{ run: "BASE: ${{ github.base_ref }}" }],
			}),
		).toBe(true);
		expect(
			jobUsesPullRequestContext({
				steps: [{ run: "HEAD: ${{ github.head_ref }}" }],
			}),
		).toBe(true);
		expect(
			jobUsesPullRequestContext({
				steps: [
					{
						if: "github.event_name == 'pull_request'",
						run: "BASE: ${{ github.base_ref }}",
					},
				],
			}),
		).toBe(false);
		expect(
			jobUsesPullRequestContext({
				if: "github.event_name == 'pull_request'",
				steps: [{ run: "HEAD: ${{ github.head_ref }}" }],
			}),
		).toBe(false);
		expect(
			jobUsesPullRequestContext({
				steps: [
					{
						run: "SHA: ${{ github.event.pull_request.head.sha || github.sha }}",
					},
				],
			}),
		).toBe(false);
	});

	// The same detector on the REAL ci.yml#test expression: with its step guard
	// it is safe; removing only that guard makes it an offender. This is the
	// token proof the reviewer asked for, not a comment or an admission.
	it("flags the real ci.yml#test base_ref read when its step guard is removed", () => {
		const source = readFileSync(
			resolve(ROOT, ".github/workflows/ci.yml"),
			"utf8",
		);
		const guarded =
			"      - name: Fetch PR base for advisory self-scan\n        if: github.event_name == 'pull_request'";
		expect(source, "the real base_ref step guard").toContain(guarded);
		expect(
			jobUsesPullRequestContext(load(".github/workflows/ci.yml").jobs.test),
		).toBe(false);
		const mutated = yaml.load(
			source.replace(
				guarded,
				"      - name: Fetch PR base for advisory self-scan",
			),
		) as Workflow;
		expect(jobUsesPullRequestContext(mutated.jobs.test)).toBe(true);
	});

	// #3765 F3/F4: the merge_group-skip predicate is structural (operator +
	// literal), so an unlisted spelling is caught too; and it names no gate
	// that runs on merge_group.
	it("recognizes every merge_group-skipping gate spelling", () => {
		expect(gatesOffMergeGroup("github.event_name == 'pull_request'")).toBe(
			true,
		);
		expect(gatesOffMergeGroup("github.event_name != 'merge_group'")).toBe(true);
		expect(gatesOffMergeGroup("github.event_name == 'workflow_dispatch'")).toBe(
			true,
		);
		expect(gatesOffMergeGroup("always()")).toBe(false);
		expect(gatesOffMergeGroup("${{ !cancelled() }}")).toBe(false);
		expect(gatesOffMergeGroup("github.event_name == 'merge_group'")).toBe(
			false,
		);
		expect(gatesOffMergeGroup(undefined)).toBe(false);
	});

	// Population floor (#3765): an empty or shrunken pin would let every
	// assertion above pass vacuously. Branch protection currently has 8 required
	// contexts; the install matrix is one row that expands to three.
	it("keeps a real required-check population", () => {
		expect(REQUIRED_JOBS.length).toBeGreaterThanOrEqual(6);
		expect(MERGE_GROUP_SAFE_PR_CONTEXT.length).toBeGreaterThanOrEqual(1);
		for (const { file, job } of REQUIRED_JOBS) {
			expect(load(file).jobs[job], `${file}#${job}`).toBeDefined();
		}
		for (const key of MERGE_GROUP_SAFE_PR_CONTEXT) {
			const [file, id] = key.split("#");
			expect(load(file).jobs[id], key).toBeDefined();
		}
	});
});

/** A workflow `if:` that makes its job skip on a `merge_group` run: it
 *  compares `github.event_name` to a literal that is not `merge_group` with
 *  `==`, or to `merge_group` with `!=`. Any other gate (`always()`,
 *  `!cancelled()`, a needs/result check) runs there. */
function gatesOffMergeGroup(gate: string | undefined): boolean {
	for (const match of String(gate ?? "").matchAll(
		/github\.event_name\s*(==|!=)\s*['"]([^'"]*)['"]/g,
	)) {
		const runs =
			match[1] === "=="
				? match[2] === "merge_group"
				: match[2] !== "merge_group";
		if (!runs) return true;
	}
	return false;
}

/** Whether a gate skips the job unless the event is a pull request. */
function guardsToPullRequest(gate: string | undefined): boolean {
	return String(gate ?? "").includes("github.event_name == 'pull_request'");
}

/** Does the job read PR-only `github.*` context outside a `pull_request`
 *  guard? A step whose own `if:` guards to `pull_request`, and the job's own
 *  `if:`, cover every read inside them. The context is the long form
 *  `github.event.pull_request.*` (except the merge_group-safe `head.sha`
 *  fallback) plus the short `github.base_ref`/`github.head_ref` forms. The job
 *  is serialized from its parsed steps, so a read hidden in a nested `env` or
 *  `with` map is seen too. */
function jobUsesPullRequestContext(job: Job): boolean {
	if (guardsToPullRequest(job.if)) return false;
	const parts: unknown[] = [job.name, job.if, job.env, job.with];
	for (const step of job.steps ?? []) {
		if (guardsToPullRequest(step.if)) continue;
		parts.push(step);
	}
	return /github\.event\.pull_request\.(?!head\.sha\b)|github\.event\.action\s*!=|github\.(?:base_ref|head_ref)\b/.test(
		JSON.stringify(parts),
	);
}
