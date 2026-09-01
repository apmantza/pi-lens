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
 * issues:write. Every other job must remain tokenless.
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
			"record-post-merge-validation": { issues: "write" },
			smoke: { contents: "read" },
			"pi-load": { contents: "read" },
			"mise-repro": { contents: "read" },
		},
	},
	".github/workflows/labels.yml": {
		workflow: {},
		jobs: {
			"validate-merge-train-dispatch": { contents: "read" },
			"record-post-merge-validation": { issues: "write" },
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
