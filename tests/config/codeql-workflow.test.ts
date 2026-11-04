import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { isAdvisoryCheck } from "../../scripts/lib/ci-checks.mjs";

// #3801 / #3869: CodeQL moved from GitHub default setup to a committed
// advanced workflow. Since #5275 codeql.yml is the only CodeQL entry point and
// runs on a daily schedule or a dispatch: no master-push run and no PR-time
// job in ci.yml. Each assertion names the regression it keeps out. Advisory classification itself
// (`isAdvisoryCheck`) is asserted on the names EXPANDED from the YAML, never
// on a hand-written copy of them.

const ROOT = resolve(import.meta.dirname, "../..");

type Step = { uses?: string; with?: Record<string, string | boolean> };
type Job = {
	name?: string;
	uses?: string;
	needs?: string | string[];
	if?: string;
	"continue-on-error"?: boolean;
	"timeout-minutes"?: number;
	permissions?: Record<string, string>;
	strategy?: { matrix?: { language?: string[] } };
	steps?: Step[];
};
type Workflow = {
	name?: string;
	on?: Record<string, unknown>;
	permissions?: unknown;
	jobs: Record<string, Job>;
};

function load(file: string): Workflow {
	return yaml.load(
		readFileSync(resolve(ROOT, ".github/workflows", file), "utf8"),
	) as Workflow;
}

const asList = (needs: string | string[] | undefined) =>
	Array.isArray(needs) ? needs : needs ? [needs] : [];

function expandNames(job: Job): string[] {
	const languages = job.strategy?.matrix?.language ?? [];
	return languages.map((language) =>
		String(job.name).replaceAll("${{ matrix.language }}", language),
	);
}

const baselineJob = () => load("codeql.yml").jobs.analyze;
const uploadJob = () => load("codeql.yml").jobs.upload;
const codeqlSteps = (job: Job) =>
	(job.steps ?? []).filter((entry) =>
		String(entry.uses).startsWith("github/codeql-action/"),
	);

describe("#3801 CodeQL advanced-setup workflow contract", () => {
	// Recurrence: a committed workflow with no `name:` shows up in the Actions
	// UI and in check-run groupings under its file path.
	it("names the workflow and gives its codeql-action steps a full-SHA pin", () => {
		expect(load("codeql.yml").name).toBe("CodeQL");
		expect(
			codeqlSteps(baselineJob()).map((entry) => entry.uses?.split("@")[0]),
		).toEqual(["github/codeql-action/init", "github/codeql-action/analyze"]);
		const raw = readFileSync(
			resolve(ROOT, ".github/workflows", "codeql.yml"),
			"utf8",
		);
		let pinned = 0;
		for (const line of raw.split("\n")) {
			if (!/^\s*-?\s*uses:\s*github\/codeql-action\//.test(line)) continue;
			pinned += 1;
			// The same pin style ci.yml uses: `@<40 hex> # vN`.
			expect(line).toMatch(/@[0-9a-f]{40} # v\d+(\.\d+\.\d+)?$/);
		}
		expect(pinned).toBe(3);
	});

	it("analyzes actions and javascript-typescript with build-mode none and the three path ignores", () => {
		const job = baselineJob();
		expect(job.strategy?.matrix?.language).toEqual([
			"actions",
			"javascript-typescript",
		]);
		const init = codeqlSteps(job)[0];
		expect(init.with?.["build-mode"]).toBe("none");
		expect(init.with?.languages).toBe("${{ matrix.language }}");
		expect(yaml.load(String(init.with?.config))).toEqual({
			"paths-ignore": ["cases", "tests/fixtures", "dist"],
		});
		expect(codeqlSteps(job)[1].with?.category).toBe(
			"/language:${{ matrix.language }}",
		);
	});

	// Recurrence (#5275): CodeQL ran a 13-minute scan on every master push (about
	// 17 a day) plus a PR job whose check read "1 configuration not found". A
	// restored `push` or `pull_request` trigger brings that cost back.
	it("runs only on a daily schedule and on dispatch", () => {
		const workflow = load("codeql.yml");
		expect(Object.keys(workflow.on ?? {}).sort()).toEqual([
			"schedule",
			"workflow_dispatch",
		]);
		const schedule = (workflow.on?.schedule ?? []) as Array<{ cron: string }>;
		const crons = schedule.map((entry) => entry.cron);
		expect(crons).toHaveLength(1);
		const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] =
			crons[0].split(/\s+/);
		// Daily: every day-of-month, month and weekday, one fixed hour.
		expect([dayOfMonth, month, dayOfWeek, rest.length]).toEqual([
			"*",
			"*",
			"*",
			0,
		]);
		expect(hour).toMatch(/^\d+$/);
		// Off the top of the hour, where scheduled runs queue.
		expect(minute).toMatch(/^\d+$/);
		expect(minute).not.toBe("0");
	});

	// Recurrence (#5275): the PR-time `codeql` job returning to ci.yml would put
	// the 13-minute scan back on every PR. Asserted on the parsed workflow, so a
	// comment that names codeql-action is not a step (#5280 r1: a raw-text scan
	// reded on a comment in ci.yml). Any case, and job-level `uses:` too: GitHub
	// reads action references case-insensitively, and a job that calls a
	// reusable workflow runs that whole workflow.
	it("keeps ci.yml free of any CodeQL job or codeql-action step", () => {
		const jobs = Object.entries(load("ci.yml").jobs);
		expect(
			jobs.filter(([id, job]) =>
				/codeql/i.test(`${id} ${job.name ?? ""} ${job.uses ?? ""}`),
			),
		).toEqual([]);
		expect(
			jobs.flatMap(([, job]) =>
				(job.steps ?? []).filter((step) =>
					/codeql/i.test(String(step.uses ?? "")),
				),
			),
		).toEqual([]);
	});

	// Recurrence: a workflow-level `security-events: write` hands the SARIF
	// upload scope to every job in ci.yml.
	it("holds security-events: write at job scope only", () => {
		expect(load("ci.yml").permissions).toBeUndefined();
		expect(
			Object.entries(load("ci.yml").jobs)
				.filter(([, job]) => job.permissions?.["security-events"] !== undefined)
				.map(([id]) => id),
		).toEqual([]);
		expect(load("codeql.yml").permissions).toEqual({ contents: "read" });
	});

	// Recurrence: #4077, the baseline analysis job held `security-events: write`
	// and a `schedule || master` job guard, so a branch dispatch could not run the
	// analysis at all. The analysis is read-only (SARIF kept as a run artifact);
	// the one upload job holds the write scope behind the guard.
	it("splits the baseline into a read-only analysis and a guarded SARIF upload", () => {
		expect(baselineJob().permissions).toEqual({
			"security-events": "read",
			actions: "read",
			contents: "read",
		});
		expect(baselineJob().if).toBeUndefined();
		const analyze = codeqlSteps(baselineJob())[1];
		expect(analyze.with?.upload).toBe("never");
		expect(analyze.with?.["upload-database"]).toBe(false);
		expect(uploadJob().permissions).toEqual({
			"security-events": "write",
			actions: "read",
			contents: "read",
		});
		expect(asList(uploadJob().needs)).toEqual(["analyze"]);
		// Admits the daily schedule and a dispatch on master, nothing else: a
		// branch dispatch keeps the SARIF as an artifact only.
		expect(String(uploadJob().if)).toBe(
			"${{ !cancelled() && (github.event_name == 'schedule' || github.ref == 'refs/heads/master') }}",
		);
	});

	// Recurrence: #4077, the artifact name or the SARIF category drifting between
	// the analysis and the upload would upload nothing, or a result under a
	// category code scanning does not compare against master.
	it("uploads the analysis' own SARIF artifact under the analysis' own category", () => {
		const analyzeSteps = baselineJob().steps ?? [];
		const analyze = analyzeSteps.find((s) =>
			String(s.uses).startsWith("github/codeql-action/analyze@"),
		);
		const artifact = analyzeSteps.find((s) =>
			String(s.uses).startsWith("actions/upload-artifact@"),
		);
		const steps = uploadJob().steps ?? [];
		const download = steps.find((s) =>
			String(s.uses).startsWith("actions/download-artifact@"),
		);
		const sarif = steps.find((s) =>
			String(s.uses).startsWith("github/codeql-action/upload-sarif@"),
		);
		expect(artifact?.with?.name).toBe(download?.with?.name);
		expect(artifact?.with?.path).toBe(analyze?.with?.output);
		expect(download?.with?.path).toBe(sarif?.with?.sarif_file);
		expect(sarif?.with?.category).toBe(analyze?.with?.category);
		expect(sarif?.uses?.split("@")[0]).toBe(
			"github/codeql-action/upload-sarif",
		);
		// The same pinned engine as init and analyze.
		expect(sarif?.uses?.split("@")[1]).toBe(analyze?.uses?.split("@")[1]);
		expect(uploadJob().strategy?.matrix?.language).toEqual(
			baselineJob().strategy?.matrix?.language,
		);
	});

	// Recurrence: a new CodeQL job name that scripts/lib/ci-checks.mjs does not
	// classify as advisory is a GATING check to ci-verdict and the merge train,
	// so an unrelated alert or an upload refusal would block every merge.
	it("ends every expanded CodeQL job name in (advisory) and classifies each as advisory", () => {
		const names = [...expandNames(baselineJob()), ...expandNames(uploadJob())];
		expect(names.sort()).toEqual([
			"CodeQL baseline (actions) (advisory)",
			"CodeQL baseline (javascript-typescript) (advisory)",
			"CodeQL baseline upload (actions) (advisory)",
			"CodeQL baseline upload (javascript-typescript) (advisory)",
		]);
		for (const name of names) {
			expect(name.endsWith("(advisory)")).toBe(true);
			expect(isAdvisoryCheck(name)).toBe(true);
		}
		// Distinct check names, one per job and language.
		expect(new Set(names).size).toBe(names.length);
		// Advisory through the suffix, not through a tolerance that would hide a
		// broken pin behind a green job.
		expect(baselineJob()["continue-on-error"]).not.toBe(true);
	});

	it("bounds both CodeQL jobs with timeout-minutes", () => {
		expect(baselineJob()["timeout-minutes"]).toBe(20);
		expect(uploadJob()["timeout-minutes"]).toBe(10);
	});
});
