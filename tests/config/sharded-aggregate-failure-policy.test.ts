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

// The check-running step of each required shard job, plus the verdict steps of
// the required `install-test` job. The shard jobs feed a required aggregate;
// `install-test` has no aggregate, so each matrix leg is its own required
// context (`Install test (ubuntu-latest)`, ...) and a tolerated step greens
// that leg. Named rather than looped so the intentionally best-effort steps
// stay allowed: `install-test` tolerates only `POSIX case-insensitive anchors
// (APFS)` and `Rule catalog report (non-blocking)`, both declared advisory in
// ci.yml. The aggregate jobs' enforcement steps stay covered by the blanket
// loop below (#3923 F1, #3925).
const CRITICAL_STEPS: [jobId: string, stepName: string][] = [
	["test", "Run tests"],
	["test", "Tmp-fixture hygiene owner"],
	["tla-shards", "Model-check formal/ against each config's expected verdict"],
	["install-test", "Install from tarball (simulates pi install npm:pi-lens)"],
	["install-test", "Verify required files in tarball"],
	["install-test", "Verify package.json entry points exist in tarball"],
	["install-test", "Verify bundled core grammars shipped in the tarball"],
	["install-test", "Load each extension entry point (catches missing files)"],
	[
		"install-test",
		"Verify no host-provided package shipped in the tarball (#1926)",
	],
	[
		"install-test",
		"Verify extension entry loads (catches missing node_modules deps)",
	],
	[
		"install-test",
		"Startup not weakened — entry loads from precompiled dist (#182)",
	],
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

	// Recurrence (#3923 F1, #3925): the aggregate loop only pins the aggregate
	// jobs. A tolerated `continue-on-error` on a shard job's own check-running
	// step greens `Unit tests (shard k/N)` / `TLA+ models (shard k/N)` while
	// every ci.yml reader stays green, so the required aggregate sees success.
	// The same tolerance on an `install-test` verdict step greens that leg's
	// required context, since no aggregate re-reads its result. Each critical
	// step is asserted by name so a deletion or rename cannot drop it from the
	// population silently.
	it.each(CRITICAL_STEPS)(
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
