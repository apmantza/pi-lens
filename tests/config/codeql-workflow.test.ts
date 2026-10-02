import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { isAdvisoryCheck } from "../../scripts/lib/ci-checks.mjs";

// #3801 / #3869: CodeQL moved from GitHub default setup to a committed
// advanced workflow. codeql.yml covers master pushes and the weekly scan; the
// PR-time analysis is the advisory `codeql` job in ci.yml. Each assertion
// names the regression it keeps out. Advisory classification itself
// (`isAdvisoryCheck`) is asserted on the names EXPANDED from the YAML, never
// on a hand-written copy of them.

const ROOT = resolve(import.meta.dirname, "../..");

type Step = { uses?: string; with?: Record<string, string> };
type Job = {
	name?: string;
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

const codeqlJob = () => load("ci.yml").jobs.codeql;
const baselineJob = () => load("codeql.yml").jobs.analyze;
const codeqlSteps = (job: Job) =>
	(job.steps ?? []).filter((entry) =>
		String(entry.uses).startsWith("github/codeql-action/"),
	);

function ifClauses(condition: string): string[] {
	return condition
		.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
		.split(" && ")
		.map((clause) => clause.trim())
		.sort();
}

const codeqlIfClauses = [
	"github.event_name == 'pull_request'",
	"needs.heavy-gate.outputs.ready == 'true'",
].sort();

describe("#3801 CodeQL advanced-setup workflow contract", () => {
	// Recurrence: a committed workflow with no `name:` shows up in the Actions
	// UI and in check-run groupings under its file path.
	it("names the workflow and gives both workflows' codeql-action steps a full-SHA pin", () => {
		expect(load("codeql.yml").name).toBe("CodeQL");
		for (const job of [codeqlJob(), baselineJob()]) {
			const steps = codeqlSteps(job);
			expect(steps.map((entry) => entry.uses?.split("@")[0])).toEqual([
				"github/codeql-action/init",
				"github/codeql-action/analyze",
			]);
		}
		for (const file of ["codeql.yml", "ci.yml"]) {
			const raw = readFileSync(
				resolve(ROOT, ".github/workflows", file),
				"utf8",
			);
			for (const line of raw.split("\n")) {
				if (!/^\s*-?\s*uses:\s*github\/codeql-action\//.test(line)) continue;
				// The same pin style ci.yml uses: `@<40 hex> # vN`.
				expect(line).toMatch(/@[0-9a-f]{40} # v\d+(\.\d+\.\d+)?$/);
			}
		}
	});

	// Recurrence: bumping one workflow's codeql-action pin and not the other's
	// leaves PR analysis and the baseline on different CodeQL engines, so a PR
	// alert can be invisible on master (or the reverse).
	it("pins the same codeql-action commit, language set and path filter in ci.yml and codeql.yml", () => {
		const pr = codeqlSteps(codeqlJob());
		const baseline = codeqlSteps(baselineJob());
		expect(pr.map((entry) => entry.uses)).toEqual(
			baseline.map((entry) => entry.uses),
		);
		expect(pr[0].with).toEqual(baseline[0].with);
		expect(codeqlJob().strategy?.matrix?.language).toEqual(
			baselineJob().strategy?.matrix?.language,
		);
	});

	it("analyzes actions and javascript-typescript with build-mode none and the three path ignores", () => {
		const job = codeqlJob();
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

	// Recurrence: a PR-time codeql job that also runs on master pushes uploads
	// the same SARIF category codeql.yml already uploaded for that commit.
	it("keeps codeql.yml off pull_request and the ci.yml job on pull_request only", () => {
		const triggers = Object.keys(load("codeql.yml").on ?? {}).sort();
		expect(triggers).toEqual(["push", "schedule", "workflow_dispatch"]);
		const condition = String(codeqlJob().if);
		expect(condition).not.toContain("||");
		expect(ifClauses(condition)).toEqual(codeqlIfClauses);
	});

	// Recurrence (#3807 second lander): the PR-time analysis is one of the heavy
	// advisory jobs behind `heavy-gate`. A `needs:` on the four required jobs
	// directly would start CodeQL beside the heavy gate's other jobs, on a docs-only
	// diff (the gate is skipped there) and without the gate's lint.yml check;
	// a missing `ready` clause would run it on a not-ready gate.
	it("waits on heavy-gate only and runs for a ready gate on pull_request", () => {
		const job = codeqlJob();
		expect(asList(job.needs)).toEqual(["heavy-gate"]);
		const condition = String(job.if);
		expect(condition).not.toContain("||");
		expect(ifClauses(condition)).toEqual(codeqlIfClauses);
		// Advisory red on a fork PR (read-only token, SARIF upload refused) is
		// accepted; a silent skip is not.
		expect(condition).not.toMatch(/fork/);
		expect(condition).not.toMatch(/head\.repo/);
	});

	// Recurrence: a workflow-level `security-events: write` hands the SARIF
	// upload scope to every job in ci.yml.
	it("holds security-events: write at job scope only", () => {
		expect(load("ci.yml").permissions).toBeUndefined();
		expect(codeqlJob().permissions).toEqual({
			"security-events": "write",
			actions: "read",
			contents: "read",
		});
		expect(baselineJob().permissions).toEqual({
			"security-events": "write",
			actions: "read",
			contents: "read",
		});
		expect(load("codeql.yml").permissions).toEqual({ contents: "read" });
	});

	// Recurrence: a new CodeQL job name that scripts/lib/ci-checks.mjs does not
	// classify as advisory is a GATING check to ci-verdict and the merge train,
	// so an unrelated alert or an upload refusal would block every merge.
	it("ends every expanded CodeQL job name in (advisory) and classifies each as advisory", () => {
		const names = [...expandNames(codeqlJob()), ...expandNames(baselineJob())];
		expect(names.sort()).toEqual([
			"CodeQL (actions) (advisory)",
			"CodeQL (javascript-typescript) (advisory)",
			"CodeQL baseline (actions) (advisory)",
			"CodeQL baseline (javascript-typescript) (advisory)",
		]);
		for (const name of names) {
			expect(name.endsWith("(advisory)")).toBe(true);
			expect(isAdvisoryCheck(name)).toBe(true);
		}
		// The two workflows must not post the same check name.
		expect(new Set(names).size).toBe(names.length);
		// Advisory through the suffix, not through a tolerance that would hide a
		// broken pin behind a green job.
		expect(codeqlJob()["continue-on-error"]).not.toBe(true);
	});

	it("bounds both CodeQL jobs with timeout-minutes", () => {
		expect(codeqlJob()["timeout-minutes"]).toBe(20);
		expect(baselineJob()["timeout-minutes"]).toBe(20);
	});
});
