import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { CI_JOB_NAMES, REQUIRED_CHECKS } from "../../scripts/lib/ci-checks.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

// Recurrence (#3837, #3838; CI-friction investigation 2026-09-30). Three
// shapes cost every PR minutes of queue time at the free-tier 20-job cap:
//
//  1. A dispatch-only first hop. ci.yml and lint.yml opened with a
//     `validate-merge-train-dispatch` job whose every step was gated on
//     `repository_dispatch`: a no-op on a pull request, yet every job waited
//     behind it (queued median 310 s, p90 609 s). Its only sender was the
//     merge-train lane, which merged 0 PRs in 322 runs and is retired.
//  2. `edited` on lint.yml. A retitle re-ran the whole Lint graph (62 of 167
//     PR runs, 446 jobs) to refresh three metadata checks.
//  3. The retired lane coming back in pieces: a trigger, a label or a run step
//     with no sender, or a sender with no validator.
//
// The graph below is read from the real workflow files, not a hand-written
// copy, so a revert of any of the three shows up here.

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

type Step = { if?: unknown; run?: unknown };
type Job = {
	name?: string;
	if?: unknown;
	needs?: string | string[];
	steps?: Step[];
	strategy?: { matrix?: { os?: unknown } };
};
type Workflow = {
	on?: unknown;
	jobs?: Record<string, Job>;
};

function loadAll(): Array<{ file: string; workflow: Workflow }> {
	return readdirSync(WORKFLOWS)
		.filter((file) => /\.ya?ml$/.test(file))
		.sort()
		.map((file) => ({
			file,
			workflow: yaml.load(
				readFileSync(resolve(WORKFLOWS, file), "utf8"),
			) as Workflow,
		}));
}

function triggerNames(on: unknown): string[] {
	if (typeof on === "string") return [on];
	if (Array.isArray(on)) return on.map(String);
	if (on && typeof on === "object") return Object.keys(on);
	return [];
}

function pullRequestTypes(on: unknown): string[] | undefined {
	if (!on || typeof on !== "object" || Array.isArray(on)) return undefined;
	const trigger = (on as Record<string, unknown>).pull_request;
	if (!trigger || typeof trigger !== "object") return undefined;
	const types = (trigger as { types?: unknown }).types;
	return Array.isArray(types) ? types.map(String) : [];
}

function needsOf(job: Job): string[] {
	if (Array.isArray(job.needs)) return job.needs;
	return typeof job.needs === "string" ? [job.needs] : [];
}

const mentionsDispatch = (value: unknown) =>
	typeof value === "string" && value.includes("repository_dispatch");

/** A job that does nothing on a pull request: itself or every step is gated on a dispatch. */
function isDispatchOnly(job: Job): boolean {
	if (mentionsDispatch(job.if)) return true;
	const steps = job.steps ?? [];
	return steps.length > 0 && steps.every((step) => mentionsDispatch(step.if));
}

function jobCheckName(key: string, job: Job): string {
	return job.name ?? key;
}

function jobCheckNames(key: string, job: Job): string[] {
	const name = jobCheckName(key, job);
	const matrixOs = job.strategy?.matrix?.os;
	if (!name.includes("${{ matrix.os }}") || !Array.isArray(matrixOs)) {
		return [name];
	}
	return matrixOs.map((os) => name.replace("${{ matrix.os }}", String(os)));
}

describe("retired merge-train lane and its dispatch hop (#3837)", () => {
	const all = loadAll();

	it("reads every workflow file, not a hand-kept list", () => {
		assertNonEmptyScan("workflow files", all.length, 15);
	});

	it("has no workflow triggered by repository_dispatch", () => {
		// Nothing sends the event once the lane is gone; a surviving trigger is a
		// dead consumer, and (without the ancestry validator) an unchecked one.
		const consumers = all
			.filter(({ workflow }) =>
				triggerNames(workflow.on).includes("repository_dispatch"),
			)
			.map(({ file }) => file);
		expect(consumers).toEqual([]);
	});

	it("lets no job wait on a dispatch-only job", () => {
		let edges = 0;
		const findings: string[] = [];
		for (const { file, workflow } of all) {
			const jobs = workflow.jobs ?? {};
			for (const [key, job] of Object.entries(jobs)) {
				for (const target of needsOf(job)) {
					edges += 1;
					const upstream = jobs[target];
					if (upstream && isDispatchOnly(upstream)) {
						findings.push(`${file}: ${key} needs dispatch-only ${target}`);
					}
				}
			}
		}
		assertNonEmptyScan("workflow needs edges", edges, 5);
		expect(findings).toEqual([]);
	});

	it("keeps the lint.yml gating jobs at the root of the graph", () => {
		const jobs = all.find(({ file }) => file === "lint.yml")?.workflow.jobs;
		expect(jobs).toBeDefined();
		for (const key of ["knip", "oxfmt"]) {
			expect(needsOf(jobs?.[key] ?? {}), `${key} needs`).toEqual([]);
		}
	});

	it("leaves no run step, label or workflow file for the lane", () => {
		const runText = all.flatMap(({ workflow }) =>
			Object.values(workflow.jobs ?? {}).flatMap((job) =>
				(job.steps ?? []).map((step) => String(step.run ?? "")),
			),
		);
		assertNonEmptyScan("workflow run steps", runText.length, 50);
		expect(runText.filter((run) => /merge-train-lane/.test(run))).toEqual([]);
		expect(existsSync(resolve(WORKFLOWS, "merge-train-lane.yml"))).toBe(false);
		const labels = yaml.load(
			readFileSync(resolve(ROOT, ".github/labels.yml"), "utf8"),
		) as Array<{ name: string }>;
		expect(
			labels.map(({ name }) => name).filter((n) => /^train:/.test(n)),
		).toEqual([]);
	});
});

describe("PR metadata checks live in their own workflow (#3838)", () => {
	const all = loadAll();
	const byFile = (name: string) =>
		all.find(({ file }) => file === name)?.workflow;

	it("lets only pr-metadata.yml run on edited", () => {
		// An edit refreshes the checks that read the live title/body; every other
		// PR workflow reads the tree, which an edit does not change.
		const editable = all
			.filter(({ workflow }) =>
				pullRequestTypes(workflow.on)?.includes("edited"),
			)
			.map(({ file }) => file);
		expect(editable).toEqual(["pr-metadata.yml"]);
	});

	it("runs pr-metadata.yml on opened, edited, synchronize and reopened", () => {
		expect(
			[...(pullRequestTypes(byFile("pr-metadata.yml")?.on) ?? [])].sort(),
		).toEqual(["edited", "opened", "reopened", "synchronize"]);
	});

	it("still runs all of Lint on a push (opened, synchronize, reopened)", () => {
		const on = byFile("lint.yml")?.on;
		expect([...(pullRequestTypes(on) ?? [])].sort()).toEqual([
			"opened",
			"reopened",
			"synchronize",
		]);
		expect(triggerNames(on)).toContain("push");
	});

	it("hosts the three metadata jobs only in pr-metadata.yml, with no hop", () => {
		const metadataNames = [
			"PR title",
			"PR body (advisory)",
			"Close-keyword syntax",
		];
		const hosts = new Map<string, string[]>();
		for (const { file, workflow } of all) {
			for (const [key, job] of Object.entries(workflow.jobs ?? {})) {
				const name = jobCheckName(key, job);
				if (metadataNames.includes(name)) {
					hosts.set(name, [...(hosts.get(name) ?? []), file]);
				}
			}
		}
		expect(Object.fromEntries(hosts)).toEqual({
			"PR title": ["pr-metadata.yml"],
			"PR body (advisory)": ["pr-metadata.yml"],
			"Close-keyword syntax": ["pr-metadata.yml"],
		});
		for (const job of Object.values(byFile("pr-metadata.yml")?.jobs ?? {})) {
			expect(needsOf(job)).toEqual([]);
		}
	});

	it("keeps every required check name on a job that still exists", () => {
		// Required names are what branch protection and ci-verdict match on; a
		// move between workflows must not rename one.
		const names = new Set(
			all.flatMap(({ workflow }) =>
				Object.entries(workflow.jobs ?? {}).flatMap(([key, job]) =>
					jobCheckNames(key, job),
				),
			),
		);
		for (const required of [
			...REQUIRED_CHECKS,
			CI_JOB_NAMES.KNIP,
			"oxfmt format check",
			"Install test (ubuntu-latest)",
			"Install test (windows-latest)",
			"Install test (macos-latest)",
			"TLA+ models",
		]) {
			expect(names.has(required), `job named ${required}`).toBe(true);
		}
	});
});
