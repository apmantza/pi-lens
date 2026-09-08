// Pins the four #2706 advisory jobs to their workflow-level contracts. The
// real YAML is loaded so deleting a job, its advisory tolerance, or the
// typos action pin makes this test fail.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const ROOT = resolve(import.meta.dirname, "../..");
const workflow = yaml.load(
	readFileSync(resolve(ROOT, ".github/workflows/lint.yml"), "utf8"),
) as {
	jobs: Record<
		string,
		{
			name?: string;
			"continue-on-error"?: boolean;
			steps?: Array<Record<string, unknown>>;
		}
	>;
};

const tools = [
	["jscpd", "jscpd (advisory)"],
	["yamllint", "yamllint (advisory)"],
	["typos", "typos (advisory)"],
	["taplo", "taplo (advisory)"],
] as const;

describe("#2706 advisory tooling workflow contracts", () => {
	it.each(tools)("keeps the %s job advisory and named", (key, name) => {
		const job = workflow.jobs[key];
		expect(job?.name).toBe(name);
		expect(job?.["continue-on-error"]).toBe(true);
	});

	it("pins the typos action to a full commit SHA with the release comment", () => {
		// Recurrence: the round-1 draft carried the literal offline placeholder
		// `<SHA-TO-PIN>`; an unpinned or placeholder `uses:` would run whatever the
		// tag points at. The repo pins every third-party action by SHA.
		const steps = workflow.jobs.typos?.steps ?? [];
		const action = steps.find(
			(step) =>
				typeof step.uses === "string" &&
				step.uses.startsWith("crate-ci/typos@"),
		);
		expect(action?.uses).toMatch(/^crate-ci\/typos@[0-9a-f]{40}$/);
		const raw = readFileSync(
			resolve(ROOT, ".github/workflows/lint.yml"),
			"utf8",
		);
		expect(raw).toMatch(/crate-ci\/typos@[0-9a-f]{40} # v1\.50\.1\b/);
	});
});
