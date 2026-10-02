import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

type Step = {
	name?: string;
	"continue-on-error"?: boolean | string;
};
type Job = {
	"continue-on-error"?: boolean | string;
	steps?: Step[];
};

const jobs = (
	yaml.load(
		readFileSync(
			resolve(import.meta.dirname, "../../.github/workflows/ci.yml"),
			"utf8",
		),
	) as { jobs: Record<string, Job> }
).jobs;

// The check-running step of each required shard job. The aggregate jobs'
// enforcement steps stay covered by the blanket loop below; these are the
// shard-level verdict producers. Named rather than looped so a future
// best-effort upload, metadata, or hygiene helper step does not have to fail
// the check to stay allowed (#3923 F1).
const CRITICAL_SHARD_STEPS: [jobId: string, stepName: string][] = [
	["test", "Run tests"],
	["test", "Tmp-fixture hygiene owner"],
	["tla-shards", "Model-check formal/ against each config's expected verdict"],
];

describe("#3920 sharded required-check failure policy", () => {
	// Recurrence: the #3919 review demonstrated that continue-on-error on a
	// shard job or aggregate step turns a failed required check green while
	// the existing aggregate-governance tests still pass. Parse YAML so prose
	// cannot satisfy this guard; expressions cannot override the failure policy.
	it.each([
		["test", "unit-tests"],
		["tla-shards", "tla-models"],
	])("keeps %s failures required through %s", (shardId, aggregateId) => {
		for (const id of [shardId, aggregateId]) {
			const job = jobs[id];
			expect(job, `${id} must exist`).toBeDefined();
			expect(
				job["continue-on-error"] ?? false,
				`${id} must not tolerate failure`,
			).toBe(false);
		}
		const steps = jobs[aggregateId].steps ?? [];
		expect(
			steps.length,
			`${aggregateId} must enforce its result`,
		).toBeGreaterThan(0);
		for (const step of steps) {
			expect(
				step["continue-on-error"] ?? false,
				`${aggregateId}: ${step.name} must not tolerate failure`,
			).toBe(false);
		}
	});

	// Recurrence (#3923 F1): the aggregate loop only pins the aggregate jobs.
	// A tolerated `continue-on-error` on a shard job's own check-running step
	// greens `Unit tests (shard k/N)` / `TLA+ models (shard k/N)` while every
	// ci.yml reader stays green, so the required aggregate sees success. Each
	// critical step is asserted by name so a deletion or rename cannot drop it
	// from the population silently.
	it.each(CRITICAL_SHARD_STEPS)(
		"keeps the %s job's `%s` step from tolerating failure",
		(jobId, stepName) => {
			const steps = jobs[jobId]?.steps ?? [];
			const step = steps.find((entry) => entry.name === stepName);
			expect(
				step,
				`${jobId} must have a step named \`${stepName}\``,
			).toBeDefined();
			expect(
				step?.["continue-on-error"] ?? false,
				`${jobId}: ${stepName} must not tolerate failure`,
			).toBe(false);
		},
	);
});
