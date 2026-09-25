import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

type PermissionValue = "read" | "write" | "none";
type Job = { permissions?: unknown };
type Workflow = {
	permissions?: unknown;
	jobs?: Record<string, Job>;
};

function readWorkflow(relativePath: string): Workflow {
	return yaml.load(
		readFileSync(resolve(REPO_ROOT, relativePath), "utf8"),
	) as Workflow;
}

function normalizePermissions(value: unknown): Record<string, PermissionValue> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`permissions must be a mapping, received ${String(value)}`);
	}

	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([name, access]) => {
			if (access !== "read" && access !== "write" && access !== "none") {
				throw new Error(`unsupported ${name} permission: ${String(access)}`);
			}
			return [name, access];
		}),
	);
}

/**
 * These capabilities come from the workflow steps, not from the YAML under
 * test: checkout needs contents:read, while the API/comment actions need
 * issues:write (pull-requests:write when the comment target is a PR, #3151). Every other job must remain tokenless.
 */
const EXPECTED_PERMISSIONS: Record<
	string,
	{
		workflow: Record<string, PermissionValue>;
		jobs: Record<string, Record<string, PermissionValue>>;
	}
> = {
	".github/workflows/install-smoke.yml": {
		workflow: {},
		jobs: {
			"validate-merge-train-dispatch": { contents: "read" },
			"record-post-merge-validation": { "pull-requests": "write" },
			smoke: { contents: "read" },
			"pi-load": { contents: "read" },
			"mise-repro": { contents: "read" },
			"host-range-smoke": { contents: "read", actions: "read" },
			"host-latest-smoke": { contents: "read", issues: "write" },
		},
	},
	".github/workflows/labels.yml": {
		workflow: {},
		jobs: {
			"validate-merge-train-dispatch": { contents: "read" },
			"record-post-merge-validation": { "pull-requests": "write" },
			sync: { contents: "read", issues: "write" },
		},
	},
};

describe("GitHub Actions workflow permissions", () => {
	for (const [workflowPath, expected] of Object.entries(EXPECTED_PERMISSIONS)) {
		it(`${workflowPath} keeps capabilities at the narrowest job scope`, () => {
			const workflow = readWorkflow(workflowPath);
			const jobs = workflow.jobs ?? {};

			expect(normalizePermissions(workflow.permissions)).toEqual(
				expected.workflow,
			);
			expect(Object.keys(jobs).sort()).toEqual(
				Object.keys(expected.jobs).sort(),
			);
			for (const [jobName, expectedPermissions] of Object.entries(
				expected.jobs,
			)) {
				expect(normalizePermissions(jobs[jobName]?.permissions)).toEqual(
					expectedPermissions,
				);
			}
		});
	}
});

// #3151: every `record-post-merge-validation` run that ever fired failed on
// `POST /issues/$PAYLOAD_PR_NUMBER/comments` with 403 "Resource not accessible
// by integration": the job held `issues: write`, and the comment target is a
// pull request. The classifier job in ci-infra-kill-rerun.yml posts to the
// same endpoint with `pull-requests: write` and succeeds.
describe("jobs that comment on a pull request hold pull-requests: write (#3151)", () => {
	const WORKFLOWS = [
		".github/workflows/ci.yml",
		".github/workflows/lint.yml",
		".github/workflows/install-smoke.yml",
		".github/workflows/labels.yml",
	];
	const PR_COMMENT_POST = /\/issues\/\$PAYLOAD_PR_NUMBER\/comments/;

	type StepJob = Job & { steps?: Array<{ run?: unknown }> };

	const population = WORKFLOWS.flatMap((workflowPath) => {
		const jobs = (readWorkflow(workflowPath).jobs ?? {}) as Record<
			string,
			StepJob
		>;
		return Object.entries(jobs)
			.filter(([, job]) =>
				(job.steps ?? []).some(
					(step) =>
						typeof step.run === "string" && PR_COMMENT_POST.test(step.run),
				),
			)
			.map(([jobName, job]) => ({ workflowPath, jobName, job }));
	});

	it("finds the post-merge recorder in each of the four workflows", () => {
		expect(
			population.map(
				({ workflowPath, jobName }) => `${workflowPath}#${jobName}`,
			),
		).toEqual(WORKFLOWS.map((path) => `${path}#record-post-merge-validation`));
	});

	it.each(WORKFLOWS)(
		"%s: the PR-comment job can write pull requests",
		(path) => {
			const member = population.find(
				({ workflowPath }) => workflowPath === path,
			);
			expect(normalizePermissions(member?.job.permissions)).toEqual({
				"pull-requests": "write",
			});
		},
	);
});
