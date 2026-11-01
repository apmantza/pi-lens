// Pins the #5112 runner-minute cuts to their workflow-level contract (#3995
// slice A: Install test 10,875 min, lint strictness 2,106, install-smoke
// smoke 1,447, greeting 1,446, Strict install 1,410; none had a real catch in
// 30 days). The real YAML is loaded, so each assertion reds on the edit that
// would break it. The smoke job's gate has its own table in
// install-smoke-gates.test.ts and the install-path list in
// tests/scripts/ci-changed-files.test.ts.
//
// Recurrences this prevents:
//  - a required `Install test (<os>)` leg that skips at job level (a skipped
//    job reports `skipped`, and ci-verdict demands a literal `success` on a
//    required row, #2618), or whose heavy steps lose their guard and install on
//    every docs pull request again;
//  - the three required context names changing with the job's name template;
//  - the cut reaching master: Install test, Strict install and strictness are
//    pull_request cuts only, so a master push, the merge queue and a dispatch
//    must still run them in full (an over-wide `if:` leaves them with no run
//    at all; the nightly schedule was dropped for cost, #5112);
//  - the greeting job starting a runner for every author (1,446 min for an
//    action that posts to a first-time author only).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const ROOT = resolve(import.meta.dirname, "../..");
type Step = {
	id?: string;
	if?: string;
	name?: string;
	shell?: string;
	uses?: string;
	env?: Record<string, string>;
	run?: string;
};
type Job = {
	name?: string;
	if?: string;
	permissions?: Record<string, string>;
	strategy?: { matrix?: { os?: string[] } };
	steps?: Step[];
};
type Workflow = {
	on: Record<string, unknown> & {
		merge_group?: { types: string[] };
	};
	jobs: Record<string, Job>;
};
const load = (file: string) =>
	yaml.load(
		readFileSync(resolve(ROOT, ".github/workflows", file), "utf8"),
	) as Workflow;

const ci = load("ci.yml");
const lint = load("lint.yml");
const greetings = load("greetings.yml");

describe("Install test always reports and installs only on install paths (#5112)", () => {
	const job = ci.jobs["install-test"];
	const steps = job.steps ?? [];
	const classifyAt = steps.findIndex((s) => s.id === "scope");

	it("keeps the three required contexts and is never skipped at job level", () => {
		expect(job.name).toBe("Install test (${{ matrix.os }})");
		expect(job.strategy?.matrix?.os).toEqual([
			"ubuntu-latest",
			"windows-latest",
			"macos-latest",
		]);
		expect(job.if).toBeUndefined();
	});

	it("classifies the diff in an unconditional bash step with the PR number and a token", () => {
		const classify = steps[classifyAt];
		expect(classify.name).toBe("Classify the changed files");
		expect(classify.if).toBeUndefined();
		// The Windows default shell is pwsh, which does not expand "$EVENT_NAME".
		expect(classify.shell).toBe("bash");
		expect(classify.run).toMatch(/node scripts\/ci-changed-files\.mjs\b/);
		expect(classify.run).toContain('--event "$EVENT_NAME"');
		expect(classify.run).toContain('--pr "$PR_NUMBER"');
		expect(classify.env?.GH_TOKEN).toBe("${{ github.token }}");
		expect(classify.env?.EVENT_NAME).toBe("${{ github.event_name }}");
		expect(classify.env?.PR_NUMBER).toBe(
			"${{ github.event.pull_request.number }}",
		);
		// The script reads the file list through the API with this token.
		expect(job.permissions?.["pull-requests"]).toBe("read");
	});

	it("guards every step after the classifier, so no heavy step is left unguarded", () => {
		const after = steps.slice(classifyAt + 1);
		expect(after.length).toBeGreaterThan(10);
		const unguarded = after
			.filter(
				(s) =>
					!(s.if ?? "").includes("steps.scope.outputs.install") &&
					// The macOS-only APFS pair is a non-pull_request pair: it cannot run
					// on the pull request this guard is about.
					!(s.if ?? "").includes("github.event_name != 'pull_request'"),
			)
			.map((s) => s.name);
		expect(unguarded).toEqual([]);
		// `!= 'false'`, never `== 'true'`: an empty output (a doubt) installs.
		for (const s of after.filter((s) =>
			(s.if ?? "").includes("steps.scope.outputs.install"),
		)) {
			if (s.name === "No install files changed")
				expect(s.if).toBe("steps.scope.outputs.install == 'false'");
			else expect(s.if, s.name).toContain("install != 'false'");
		}
		// The checkout and node setup precede the classifier and carry no guard.
		for (const s of steps.slice(0, classifyAt)) expect(s.if).toBeUndefined();
	});

	it("states the skip with a line in the step summary", () => {
		const noop = steps.find((s) => s.name === "No install files changed");
		expect(noop?.run).toContain("no install files changed");
		expect(noop?.run).toContain('"$GITHUB_STEP_SUMMARY"');
	});
});

describe("the cuts leave master, the merge queue and dispatches intact (#5112)", () => {
	// Recurrence: the pull_request cut applied as `if: github.event_name ==
	// 'push'`, which would drop merge_group and workflow_dispatch.
	const evaluate = (expr: string, event: string) =>
		Boolean(
			new Function(
				`"use strict"; return (${expr.split("github.event_name").join(JSON.stringify(event))});`,
			)(),
		);

	it("ci.yml strict-install-cold-cache skips a pull request and runs every other event", () => {
		const expr = ci.jobs["strict-install-cold-cache"].if as string;
		expect(evaluate(expr, "pull_request")).toBe(false);
		for (const event of ["push", "merge_group", "workflow_dispatch"])
			expect(evaluate(expr, event), event).toBe(true);
	});

	// The strictness steps carry the cut as a step `if`: the guarded steps skip
	// a pull request, and a Lint (advisory) step stays free to run on it.
	it.each(["Generate strictness report", "Publish strictness report"])(
		"lint.yml %s skips a pull request and runs every other event",
		(name) => {
			const step = lint.jobs["lint-advisory"].steps?.find(
				(s) => s.name === name,
			);
			expect(step?.if, name).toBeDefined();
			const expr = String(step?.if).replace(/^\$\{\{|\}\}$/g, "");
			// Status functions are true while the job is live; only the event decides.
			const live = expr
				.replace(/!cancelled\(\)/g, "true")
				.replace(/always\(\)/g, "true");
			expect(evaluate(live, "pull_request")).toBe(false);
			for (const event of ["push", "merge_group", "workflow_dispatch"])
				expect(evaluate(live, event), event).toBe(true);
		},
	);

	it.each([
		["ci.yml", ci],
		["lint.yml", lint],
	] as const)(
		"%s still reports on the merge queue's commit",
		(_f, workflow) => {
			expect(workflow.on.merge_group).toEqual({ types: ["checks_requested"] });
		},
	);
});

// #5002: the lockfile gate is a trigger filter, not a detect job. A pull request
// that touches neither path posts no OSV row; schedule and dispatch scan in full.
describe("OSV scan starts from a lockfile paths filter, not a detect job (#5002)", () => {
	const osv = load("osv-scan.yml");

	it("filters the pull_request trigger to the lockfile and this file, leaving schedule and dispatch unfiltered", () => {
		const on = osv.on as Record<string, { paths?: string[] } | undefined>;
		expect(on.pull_request?.paths).toEqual([
			"package-lock.json",
			".github/workflows/osv-scan.yml",
		]);
		expect(on.schedule).toBeDefined();
		expect(on.workflow_dispatch).toBeDefined();
		expect(on.schedule).not.toHaveProperty("paths");
	});

	it("has the one scan job, with no needs or if, scanning the PR's own head lockfile", () => {
		expect(Object.keys(osv.jobs)).toEqual(["osv-scan"]);
		const job = osv.jobs["osv-scan"] as Job & { needs?: unknown };
		expect(job.name).toBe("OSV scan (advisory)");
		expect(job.needs).toBeUndefined();
		expect(job.if).toBeUndefined();
		const checkout = (job.steps ?? []).find((s) =>
			s.uses?.startsWith("actions/checkout@"),
		) as (Step & { with?: Record<string, string> }) | undefined;
		expect(checkout?.with?.ref).toBe(
			"${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || '' }}",
		);
	});
});

describe("the greeting job starts for every issue and for a first-time pull request author (#5112)", () => {
	const job = greetings.jobs.greeting;

	// Recurrence (#5117 review B2): the job first keyed both events on the
	// payload's author_association, so a CONTRIBUTOR (an author with commits)
	// opening a first ISSUE never reached actions/first-interaction, which asks
	// the repository's history. The issue path therefore starts on the event
	// alone; only pull requests, the bulk of the 1,446 minutes, are gated.
	const starts = (event: string, association: string | null): boolean => {
		const expr = (job.if as string)
			.split("github.event_name")
			.join(JSON.stringify(event))
			.split("github.event.pull_request.author_association")
			.join(JSON.stringify(association));
		expect(expr).not.toContain("github.");
		return Boolean(new Function(`"use strict"; return (${expr});`)());
	};

	it.each([
		["pull_request_target", "FIRST_TIME_CONTRIBUTOR", true],
		["pull_request_target", "FIRST_TIMER", true],
		["pull_request_target", "MEMBER", false],
		["pull_request_target", "OWNER", false],
		["pull_request_target", "CONTRIBUTOR", false],
		["pull_request_target", "NONE", false],
		// An `issues` payload has no pull_request object at all.
		["issues", null, true],
	])(
		"%s with pull_request association %s starts: %s",
		(event, association, expected) => {
			expect(starts(event, association)).toBe(expected);
		},
	);

	it("has no checkout and runs no repository code", () => {
		for (const s of job.steps ?? [])
			expect(s.uses ?? "").not.toMatch(/checkout/);
		expect((job.steps ?? []).every((s) => s.run === undefined)).toBe(true);
	});
});
