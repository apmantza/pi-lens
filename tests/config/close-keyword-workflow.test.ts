import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = ".github/workflows/close-keywords.yml";

type Workflow = {
	name?: string;
	on?: { pull_request?: { branches?: string[]; types?: string[] } };
	permissions?: Record<string, string>;
	jobs?: Record<
		string,
		{
			name?: string;
			permissions?: Record<string, string>;
			steps?: Array<{ run?: string; env?: Record<string, string> }>;
		}
	>;
};

function loadWorkflow(source?: string): Workflow {
	return yaml.load(
		source ?? readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8"),
	) as Workflow;
}

describe("close-keywords workflow contract (#2640)", () => {
	it("re-gates title edits and keeps the check-run name stable", () => {
		const workflow = loadWorkflow();
		expect(workflow.name).toBe("Close-keyword syntax");
		expect(workflow.on?.pull_request?.types).toEqual([
			"opened",
			"synchronize",
			"reopened",
			"edited",
		]);
		expect(workflow.jobs?.lint?.name).toBe("Close-keyword syntax");
	});

	it("requires only pull-request reads and runs the live PR lint", () => {
		const workflow = loadWorkflow();
		expect(workflow.permissions).toEqual({ "pull-requests": "read" });
		const job = workflow.jobs?.lint;
		expect(job?.permissions).toEqual({ "pull-requests": "read" });
		const step = job?.steps?.find((candidate) =>
			(candidate.run ?? "").includes("check-close-keywords.mjs"),
		);
		expect(step?.run).toContain("--lint-pr");
		expect(step?.env?.GITHUB_TOKEN).toContain("secrets.GITHUB_TOKEN");
	});
});
