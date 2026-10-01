// Pins the four #2706 advisory jobs to their workflow-level contracts. The
// real YAML is loaded so deleting a job, its advisory tolerance, or the
// typos action pin makes this test fail.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { isAdvisoryCheck } from "../../scripts/lib/ci-checks.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const workflow = yaml.load(
	readFileSync(resolve(ROOT, ".github/workflows/lint.yml"), "utf8"),
) as {
	jobs: Record<
		string,
		{
			name?: string;
			if?: string;
			"continue-on-error"?: boolean;
			steps?: Array<Record<string, unknown>>;
		}
	>;
	on?: { pull_request?: { types?: string[] } };
};
// #3838: the PR title / body / close-keyword jobs live in pr-metadata.yml.
const metadataWorkflow = yaml.load(
	readFileSync(resolve(ROOT, ".github/workflows/pr-metadata.yml"), "utf8"),
) as {
	jobs: Record<string, { name?: string; if?: string }>;
	on?: { pull_request?: { types?: string[] } };
};
const mutationWorkflow = yaml.load(
	readFileSync(resolve(ROOT, ".github/workflows/mutation.yml"), "utf8"),
) as { jobs: Record<string, { name?: string; "continue-on-error"?: boolean }> };

const tools = [
	["complexity", "complexity (advisory)"],
	["strictness", "strictness (advisory)"],
	["jscpd", "jscpd (advisory)"],
	["yamllint", "yamllint (advisory)"],
	["typos", "typos (advisory)"],
	["taplo", "taplo (advisory)"],
] as const;

describe("#2706 advisory tooling workflow contracts", () => {
	it("keeps oxfmt as a gating, named job", () => {
		const job = workflow.jobs.oxfmt;
		expect(job?.name).toBe("oxfmt format check");
		expect(job?.["continue-on-error"]).not.toBe(true);
		expect(isAdvisoryCheck("oxfmt format check")).toBe(false);
	});

	// Recurrence: #2837 -- master went red after #2827/#2829 merged unused
	// exports while knip was advisory. Once gating, a rename back to
	// "(advisory)", a continue-on-error, or an ADVISORY_CHECKS entry would
	// silently let that class merge again.
	it("keeps knip as a gating, named job", () => {
		const job = workflow.jobs.knip;
		expect(job?.name).toBe("knip");
		expect(job?.["continue-on-error"]).not.toBe(true);
		expect(isAdvisoryCheck("knip")).toBe(false);
	});

	it("keeps the mutation lane advisory and named", () => {
		const job = mutationWorkflow.jobs.mutation;
		expect(job?.name).toBe("mutation (advisory)");
		expect(job?.["continue-on-error"]).toBe(true);
	});

	it("pins the mutation report upload action by SHA and keeps the report path explicit", () => {
		const raw = readFileSync(
			resolve(ROOT, ".github/workflows/mutation.yml"),
			"utf8",
		);
		// Recurrence: PR #2751 round 1 and PR #2758 round 1 both shipped a test
		// asserting the offline `<SHA-TO-PIN>` placeholder; the pin must be a
		// full commit SHA with the release comment.
		expect(raw).toMatch(
			/actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+\b/,
		);
		expect(raw).toContain("path: reports/mutation/mutation.json");
	});

	it.each(tools)("keeps the %s job advisory and named", (key, name) => {
		const job = workflow.jobs[key];
		expect(job?.name).toBe(name);
		expect(job?.["continue-on-error"]).toBe(true);
	});

	it("keeps complexity wired to the report, summary, and pinned upload", () => {
		const raw = readFileSync(
			resolve(ROOT, ".github/workflows/lint.yml"),
			"utf8",
		);
		const start = raw.indexOf("  complexity:");
		const next = raw.slice(start + 1).search(/^  [A-Za-z0-9_-]+:/m);
		const block = raw.slice(start, next === -1 ? undefined : start + 1 + next);
		expect(block).toContain("npm run build");
		expect(block).toContain("node scripts/complexity-report.mjs");
		expect(block).toContain('>> \"$GITHUB_STEP_SUMMARY\"');
		expect(block).toContain("path: reports/complexity/complexity.md");
		expect(block).toMatch(
			/actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+/,
		);
	});

	it("pins every action in the four jobs to a full SHA with a release comment", () => {
		// Recurrence: the round-1 draft carried the literal offline placeholder
		// `<SHA-TO-PIN>`; any unpinned action would run whatever its mutable tag
		// points at. Keep every action in each new job pinned with its release.
		const raw = readFileSync(
			resolve(ROOT, ".github/workflows/lint.yml"),
			"utf8",
		);
		for (const key of tools.map(([jobKey]) => jobKey)) {
			const start = raw.indexOf(`  ${key}:`);
			const next = raw.slice(start + 1).search(/^  [A-Za-z0-9_-]+:/m);
			const block = raw.slice(
				start,
				next === -1 ? undefined : start + 1 + next,
			);
			const uses = block.split("\n").filter((line) => /^\s+- uses:/.test(line));
			expect(uses, `${key} must retain its action steps`).not.toHaveLength(0);
			for (const line of uses) {
				expect(line).toMatch(
					/^\s+- uses:\s+[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}\s+# v\d+(?:\.\d+){0,2}\s*$/,
				);
			}
		}
	});
});

describe("#2714 dependabot skips the human PR-policy checks", () => {
	// Recurrence: Dependabot PRs can never carry an issue ref in the title or
	// the PR-body template, so `PR title` and `PR body (advisory)` went red on
	// every bump and the merge train ignored them by hand. The skip must stay
	// on exactly the three policy jobs (pr-title-lint, pr-body-lint and
	// close-keyword-lint, all in pr-metadata.yml since #3838); no other job
	// may inherit it, or a bump would skip a check that still applies to it.
	const dependabotSkip =
		"github.event_name == 'pull_request' && github.event.pull_request.user.login != 'dependabot[bot]'";

	it("skips the three policy jobs for dependabot", () => {
		expect(metadataWorkflow.jobs["pr-title-lint"]?.if).toBe(dependabotSkip);
		expect(metadataWorkflow.jobs["pr-body-lint"]?.if).toContain(
			"github.event_name == 'pull_request'",
		);
		expect(metadataWorkflow.jobs["pr-body-lint"]?.if).toContain(
			"github.event.pull_request.user.login != 'dependabot[bot]'",
		);
		expect(
			metadataWorkflow.jobs["close-keyword-lint"]?.if,
			"close-keyword must skip dependabot",
		).toBe(dependabotSkip);
		expect(Object.keys(metadataWorkflow.jobs).sort()).toEqual([
			"close-keyword-lint",
			"pr-body-lint",
			"pr-title-lint",
		]);
	});

	it("lets no lint.yml job skip dependabot", () => {
		for (const [key, job] of Object.entries(workflow.jobs)) {
			expect(job.if ?? "", `${key} must not skip dependabot`).not.toContain(
				"dependabot",
			);
		}
	});
});

describe("#3030 PR body lint event coverage", () => {
	function bodyJobRunsFor(action: string): boolean {
		const condition = metadataWorkflow.jobs["pr-body-lint"]?.if ?? "";
		return (
			condition.includes("github.event_name == 'pull_request'") &&
			!condition.includes(`github.event.action != '${action}'`)
		);
	}

	it("keeps the workflow event matrix and PR-body action matrix exact", () => {
		// Recurrence: #3864 F2. The TLA+ coverage rule reads the PR diff, so a push
		// (synchronize) can make a green PR red or fix a red one; every PR event
		// that can change the body or the diff must run the advisory check.
		expect(metadataWorkflow.on?.pull_request?.types).toEqual([
			"opened",
			"synchronize",
			"reopened",
			"edited",
		]);
		const actionMatrix = {
			opened: true,
			reopened: true,
			edited: true,
			synchronize: true,
		} as const;
		for (const [action, expected] of Object.entries(actionMatrix)) {
			expect(bodyJobRunsFor(action), `${action} PR-body validation`).toBe(
				expected,
			);
		}
	});

	it("keeps every PR event running the PR-body lint, none excluding synchronize", () => {
		const excludedJobs = Object.entries(metadataWorkflow.jobs)
			.filter(([, job]) =>
				(job.if ?? "").includes("github.event.action != 'synchronize'"),
			)
			.map(([key]) => key);
		expect(excludedJobs).toEqual([]);
	});
});
