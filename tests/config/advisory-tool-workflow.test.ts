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
	// on exactly the three policy jobs (pr-title-lint, pr-body-lint in
	// lint.yml plus the close-keyword job in close-keywords.yml); no other job
	// may inherit it, or a bump would skip a check that still applies to it.
	const dependabotSkip =
		"github.event_name == 'pull_request' && github.event.pull_request.user.login != 'dependabot[bot]'";

	it("skips pr-title-lint and pr-body-lint for dependabot and no other lint.yml job", () => {
		const policyJobs = ["pr-title-lint", "pr-body-lint"];
		for (const key of policyJobs) {
			expect(workflow.jobs[key]?.if, `${key} must skip dependabot`).toBe(
				dependabotSkip,
			);
		}
		const others = Object.keys(workflow.jobs).filter(
			(key) => !policyJobs.includes(key),
		);
		for (const key of others) {
			expect(
				workflow.jobs[key]?.if ?? "",
				`${key} must not skip dependabot`,
			).not.toContain("dependabot");
		}
	});

	it("skips the close-keyword job for dependabot", () => {
		const closeKeywords = yaml.load(
			readFileSync(
				resolve(ROOT, ".github/workflows/close-keywords.yml"),
				"utf8",
			),
		) as { jobs: Record<string, { if?: string }> };
		expect(
			closeKeywords.jobs.lint?.if,
			"close-keyword must skip dependabot",
		).toBe(dependabotSkip);
	});
});
