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
const mutationWorkflow = yaml.load(
	readFileSync(resolve(ROOT, ".github/workflows/mutation.yml"), "utf8"),
) as { jobs: Record<string, { name?: string; "continue-on-error"?: boolean }> };

const tools = [
	["jscpd", "jscpd (advisory)"],
	["yamllint", "yamllint (advisory)"],
	["typos", "typos (advisory)"],
	["taplo", "taplo (advisory)"],
] as const;

describe("#2706 advisory tooling workflow contracts", () => {
	it("keeps the mutation lane advisory and named", () => {
		const job = mutationWorkflow.jobs.mutation;
		expect(job?.name).toBe("mutation (advisory)");
		expect(job?.["continue-on-error"]).toBe(true);
	});

	it("keeps the mutation report upload explicit", () => {
		const raw = readFileSync(
			resolve(ROOT, ".github/workflows/mutation.yml"),
			"utf8",
		);
		expect(raw).toContain("actions/upload-artifact@<SHA-TO-PIN> # v4");
		expect(raw).toContain("path: reports/mutation/mutation.json");
	});

	it.each(tools)("keeps the %s job advisory and named", (key, name) => {
		const job = workflow.jobs[key];
		expect(job?.name).toBe(name);
		expect(job?.["continue-on-error"]).toBe(true);
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
