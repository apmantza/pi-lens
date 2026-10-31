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
//    pull_request cuts only, so a master push, the merge queue and the nightly
//    schedule must still run them in full (a dropped `schedule:` or an
//    over-wide `if:` leaves them with no run at all);
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
		schedule?: Array<{ cron: string }>;
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

describe("the cuts leave master, the merge queue and the nightly run intact (#5112)", () => {
	// Recurrence: the pull_request cut applied as `if: github.event_name ==
	// 'push'`, which would drop merge_group, workflow_dispatch and schedule.
	const evaluate = (expr: string, event: string) =>
		Boolean(
			new Function(
				`"use strict"; return (${expr.split("github.event_name").join(JSON.stringify(event))});`,
			)(),
		);

	it.each([
		["ci.yml", "strict-install-cold-cache", ci],
		["lint.yml", "strictness", lint],
	] as const)(
		"%s %s skips a pull request and runs every other event",
		(_f, id, workflow) => {
			const expr = workflow.jobs[id].if as string;
			expect(evaluate(expr, "pull_request")).toBe(false);
			for (const event of [
				"push",
				"merge_group",
				"workflow_dispatch",
				"schedule",
			])
				expect(evaluate(expr, event), event).toBe(true);
		},
	);

	it.each([
		["ci.yml", ci],
		["lint.yml", lint],
	] as const)("%s runs on a nightly schedule on master", (_f, workflow) => {
		expect(workflow.on.schedule).toHaveLength(1);
		// five fields, a daily run (day-of-month, month and weekday are `*`)
		expect(workflow.on.schedule?.[0].cron).toMatch(
			/^\d{1,2} \d{1,2} \* \* \*$/,
		);
		// The required check still reports on the queue's commit.
		expect(workflow.on.merge_group).toEqual({ types: ["checks_requested"] });
	});
});

describe("the greeting job starts only for a first-time author (#5112)", () => {
	const job = greetings.jobs.greeting;

	const starts = (
		pullRequest: string | null,
		issue: string | null,
	): boolean => {
		const expr = (job.if as string)
			.split("github.event.pull_request.author_association")
			.join(JSON.stringify(pullRequest))
			.split("github.event.issue.author_association")
			.join(JSON.stringify(issue));
		expect(expr).not.toContain("github.");
		return Boolean(new Function(`"use strict"; return (${expr});`)());
	};

	it.each([
		["FIRST_TIME_CONTRIBUTOR", null, true],
		["FIRST_TIMER", null, true],
		[null, "FIRST_TIME_CONTRIBUTOR", true],
		[null, "FIRST_TIMER", true],
		["MEMBER", null, false],
		["OWNER", null, false],
		["CONTRIBUTOR", null, false],
		["NONE", null, false],
		[null, "COLLABORATOR", false],
		[null, "CONTRIBUTOR", false],
		[null, null, false],
	])("pull_request=%s issue=%s starts: %s", (pullRequest, issue, expected) => {
		expect(starts(pullRequest, issue)).toBe(expected);
	});

	it("has no checkout and runs no repository code", () => {
		for (const s of job.steps ?? [])
			expect(s.uses ?? "").not.toMatch(/checkout/);
		expect((job.steps ?? []).every((s) => s.run === undefined)).toBe(true);
	});
});
