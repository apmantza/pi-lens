// #4358 review r1 F1: cache-prune.yml deletes shared repository state, so which
// job may hold `actions: write` and which may pass `--apply` is a structural
// fact, read from the PARSED workflow (a comment cannot satisfy or dodge it).
// Recurrence it keeps out: adding `--apply` or `actions: write` to the `plan`
// job (the pull_request dry run) left every other test green, so the only thing
// between a pull request and a real delete was a read-only token; and an edit
// that dropped the `prune` job's schedule-or-master guard let a branch run
// delete caches.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	effectivePermissions,
	guardOf,
	workflowDocument,
	writeScopes,
} from "../../scripts/dispatch-safety.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = ".github/workflows";
const PRUNE = `${WORKFLOWS}/cache-prune.yml`;
const SCRIPT = "prune-actions-cache.mjs";

type Step = { run?: unknown; env?: unknown };
type Job = { if?: unknown; permissions?: unknown; steps?: Step[] };
type Doc = {
	permissions?: unknown;
	jobs?: Record<string, Job>;
};

const load = (file: string) =>
	workflowDocument(readFileSync(resolve(ROOT, file), "utf8")) as Doc;

/** Jobs of a workflow whose `run:` text passes `--apply` to the prune script. */
function applyingJobs(doc: Doc): string[] {
	return Object.entries(doc.jobs ?? {})
		.filter(([, job]) =>
			(job.steps ?? []).some(
				(step) =>
					typeof step.run === "string" &&
					step.run.includes(SCRIPT) &&
					/--apply\b/.test(step.run),
			),
		)
		.map(([name]) => name);
}

function writerScopesOf(doc: Doc, job: Job): string[] {
	return writeScopes(effectivePermissions(doc.permissions, job.permissions));
}

describe("cache-prune.yml: only `prune` writes (#4358 r1 F1)", () => {
	const doc = load(PRUNE);
	const jobs = doc.jobs ?? {};

	it("has exactly the plan and prune jobs", () => {
		expect(Object.keys(jobs).sort()).toEqual(["plan", "prune"]);
	});

	// Recurrence: a workflow-level `actions: write` would hand the PR dry-run
	// job a delete-capable token.
	it("grants nothing at workflow level", () => {
		expect(doc.permissions).toEqual({});
	});

	it("holds actions: write in `prune` and in no other job", () => {
		const holders = Object.entries(jobs)
			.filter(([, job]) => writerScopesOf(doc, job).includes("actions"))
			.map(([name]) => name);
		expect(holders).toEqual(["prune"]);
		expect(writerScopesOf(doc, jobs.prune)).toEqual(["actions"]);
	});

	it("passes --apply in `prune` and in no other job", () => {
		expect(applyingJobs(doc)).toEqual(["prune"]);
	});

	it("keeps `plan` a pull_request-only dry run with no write scope", () => {
		expect(jobs.plan.if).toBe("github.event_name == 'pull_request'");
		expect(writerScopesOf(doc, jobs.plan)).toEqual([]);
	});

	// Recurrence: dropping the guard lets a branch push or a pull request run the
	// deleting job. A real guard is `schedule`, `master`, or `schedule || master`.
	it("guards `prune` to the schedule or master", () => {
		expect(guardOf(jobs.prune.if).guarded).toBe(true);
		expect(String(jobs.prune.if)).not.toContain("pull_request");
	});

	// Recurrence (#5082): `push` was path-filtered to edits of this file and the
	// script, so only the nightly `schedule` run (which GitHub started 09:00 to
	// 11:01 UTC on 2026-10-19..30, hours after its 04:30 cron) pruned. Every
	// non-docs master push saves a ~785 MB CodeQL overlay base database, and one
	// day of pushes left 11 copies, 8.65 GB of a 10.19 GB cache, which put the
	// npm entries the Unit shards restore at the mercy of LRU eviction. A prune
	// started by the push itself can finish BEFORE that push's CodeQL baseline
	// saves its copy (CodeRabbit on #5095), so the trigger is the CodeQL
	// workflow's completion on master instead.
	it("prunes when the CodeQL workflow completes on master, not on the push", () => {
		type On = Record<
			string,
			{ workflows?: string[]; types?: string[]; branches?: string[] }
		>;
		const read = (file: string) =>
			yaml.load(readFileSync(resolve(ROOT, file), "utf8")) as {
				name: string;
				on: On;
				concurrency?: { group?: string; "cancel-in-progress"?: boolean };
			};
		const raw = read(PRUNE);
		expect(raw.on.push).toBeUndefined();
		expect(raw.on.schedule).toBeDefined();
		// the name is what `workflows:` matches, so a rename of codeql.yml must
		// move this trigger with it
		const codeql = read(`${WORKFLOWS}/codeql.yml`);
		expect(raw.on.workflow_run.workflows).toEqual([codeql.name]);
		expect(raw.on.workflow_run.types).toEqual(["completed"]);
		expect(raw.on.workflow_run.branches).toEqual(["master"]);
		// queued prunes wait for the running one, never cancel a delete mid-way
		expect(raw.concurrency).toEqual({
			group: "cache-prune",
			"cancel-in-progress": false,
		});
		// the dry-run `plan` stays path-filtered: it only needs to run when the
		// rules change
		expect((raw.on.pull_request as { paths?: string[] }).paths).toEqual([
			".github/workflows/cache-prune.yml",
			"scripts/prune-actions-cache.mjs",
		]);
	});

	it("is the only workflow that passes --apply to the prune script", () => {
		const files = readdirSync(resolve(ROOT, WORKFLOWS)).filter((file) =>
			/\.ya?ml$/.test(file),
		);
		assertNonEmptyScan("workflows scanned for --apply", files.length, 10);
		const appliers = files.flatMap((file) =>
			applyingJobs(load(`${WORKFLOWS}/${file}`)).map((job) => `${file}:${job}`),
		);
		expect(appliers).toEqual(["cache-prune.yml:prune"]);
	});

	// Recurrence: the parse must see the planted text, not a comment.
	it("ignores --apply named only in a comment", () => {
		const planted = workflowDocument(
			[
				"jobs:",
				"  plan:",
				"    steps:",
				"      # run: node scripts/prune-actions-cache.mjs --apply",
				"      - run: node scripts/prune-actions-cache.mjs",
			].join("\n"),
		) as Doc;
		expect(applyingJobs(planted)).toEqual([]);
	});
});
