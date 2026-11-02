import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

type Step = {
	name?: string;
	if?: string;
	uses?: string;
	"continue-on-error"?: boolean | string;
};
type Job = {
	"continue-on-error"?: boolean | string;
	steps?: Step[];
};
type StepWorkflow = "ci.yml" | "lint.yml";

const jobs = (
	yaml.load(
		readFileSync(
			resolve(import.meta.dirname, "../../.github/workflows/ci.yml"),
			"utf8",
		),
	) as { jobs: Record<string, Job> }
).jobs;

const lintJobs = (
	yaml.load(
		readFileSync(
			resolve(import.meta.dirname, "../../.github/workflows/lint.yml"),
			"utf8",
		),
	) as { jobs: Record<string, Job> }
).jobs;

const workflowJobs: Record<StepWorkflow, Record<string, Job>> = {
	"ci.yml": jobs,
	"lint.yml": lintJobs,
};

// The check-running step of each required shard job, plus the verdict steps of
// the required `install-test` job and of the non-matrix required producers
// `lint-and-typecheck` (ci.yml), `knip`, and `oxfmt` (lint.yml). The shard jobs
// feed a required aggregate; `install-test` has no aggregate, so each matrix
// leg is its own required context (`Install test (ubuntu-latest)`, ...) and a
// tolerated step greens that leg. Named rather than looped so the
// intentionally best-effort steps stay allowed: `install-test` tolerates only
// `POSIX case-insensitive anchors (APFS)` and `Rule catalog report
// (non-blocking)`, both declared advisory in ci.yml. The aggregate jobs'
// enforcement steps stay covered by the blanket loop below (#3923 F1, #3925).
// #3957 adds the three non-matrix required producers the guard never read:
// the `lint.yml` load above, plus ci.yml's `lint-and-typecheck`.
const CRITICAL_STEPS: [
	workflow: StepWorkflow,
	jobId: string,
	stepName: string,
][] = [
	["ci.yml", "test", "Run tests"],
	["ci.yml", "test", "Tmp-fixture hygiene owner"],
	[
		"ci.yml",
		"tla-shards",
		"Model-check formal/ against each config's expected verdict",
	],
	[
		"ci.yml",
		"install-test",
		"Install from tarball (simulates pi install npm:pi-lens)",
	],
	["ci.yml", "install-test", "Verify required files in tarball"],
	[
		"ci.yml",
		"install-test",
		"Verify package.json entry points exist in tarball",
	],
	[
		"ci.yml",
		"install-test",
		"Verify bundled core grammars shipped in the tarball",
	],
	[
		"ci.yml",
		"install-test",
		"Load each extension entry point (catches missing files)",
	],
	[
		"ci.yml",
		"install-test",
		"Verify no host-provided package shipped in the tarball (#1926)",
	],
	[
		"ci.yml",
		"install-test",
		"Verify extension entry loads (catches missing node_modules deps)",
	],
	[
		"ci.yml",
		"install-test",
		"Startup not weakened — entry loads from precompiled dist (#182)",
	],
	// #3957: ci.yml's non-matrix required `Lint & type-check` job.
	["ci.yml", "lint-and-typecheck", "Lockfile complete under the CI npm pin"],
	["ci.yml", "lint-and-typecheck", "Lockfile in sync with package.json"],
	// #1185: the allowScripts policy check is a required verdict of this job.
	[
		"ci.yml",
		"lint-and-typecheck",
		"allowScripts policy matches the resolved lockfile",
	],
	["ci.yml", "lint-and-typecheck", "Grammar provenance in sync with manifest"],
	["ci.yml", "lint-and-typecheck", "Audit production dependencies"],
	["ci.yml", "lint-and-typecheck", "TypeScript & JS lint"],
	["ci.yml", "lint-and-typecheck", "ast-grep rule pair audit"],
	// #5002: the former `Dependency boundaries` job.
	["ci.yml", "lint-and-typecheck", "Check client dependency boundaries"],
	// #3957: lint.yml's non-matrix required `knip` and `oxfmt` jobs.
	["lint.yml", "knip", "Run knip"],
	["lint.yml", "oxfmt", "Check formatting"],
];

// #3957: every step of those three non-matrix required producers, classified
// so an added step cannot enter unclassified. `verdict` steps are the no-drop
// population above; `setup` and `best-effort` steps stay accepted and need not
// tolerate failure. A step's identity is its `name:` when it has one, else the
// `owner/repo` slug of its `uses:`, so a pinned-SHA bump does not move the
// population. The count table below is asserted against the classification.
type StepClass = "verdict" | "setup" | "best-effort";
type ProducerStep = { id: string; stepClass: StepClass };
type Producer = {
	workflow: StepWorkflow;
	job: string;
	steps: ProducerStep[];
};

const PRODUCERS: Producer[] = [
	{
		workflow: "ci.yml",
		job: "lint-and-typecheck",
		steps: [
			{ id: "actions/checkout", stepClass: "setup" },
			{ id: "actions/setup-node", stepClass: "setup" },
			{
				id: "Lockfile complete under the CI npm pin",
				stepClass: "verdict",
			},
			{ id: "Install dependencies", stepClass: "setup" },
			{ id: "Lockfile in sync with package.json", stepClass: "verdict" },
			{
				id: "allowScripts policy matches the resolved lockfile",
				stepClass: "verdict",
			},
			{
				id: "Grammar provenance in sync with manifest",
				stepClass: "verdict",
			},
			{ id: "Audit production dependencies", stepClass: "verdict" },
			{ id: "TypeScript & JS lint", stepClass: "verdict" },
			{ id: "ast-grep rule pair audit", stepClass: "verdict" },
			{ id: "Build compiled clients", stepClass: "setup" },
			{ id: "Check client dependency boundaries", stepClass: "verdict" },
		],
	},
	{
		workflow: "lint.yml",
		job: "knip",
		steps: [
			{ id: "actions/checkout", stepClass: "setup" },
			{ id: "actions/setup-node", stepClass: "setup" },
			{
				id: "Install knip (version pinned by the devDependency)",
				stepClass: "setup",
			},
			{ id: "Run knip", stepClass: "verdict" },
		],
	},
	{
		workflow: "lint.yml",
		job: "oxfmt",
		steps: [
			{ id: "actions/checkout", stepClass: "setup" },
			{ id: "actions/setup-node", stepClass: "setup" },
			{
				id: "Install oxfmt (version pinned by the devDependency)",
				stepClass: "setup",
			},
			{ id: "Check formatting", stepClass: "verdict" },
		],
	},
];

const PRODUCER_STEP_COUNTS: Record<
	`${StepWorkflow}:${string}`,
	Record<StepClass, number>
> = {
	"ci.yml:lint-and-typecheck": { verdict: 8, setup: 4, "best-effort": 0 },
	"lint.yml:knip": { verdict: 1, setup: 3, "best-effort": 0 },
	"lint.yml:oxfmt": { verdict: 1, setup: 3, "best-effort": 0 },
};

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

	// Recurrence (#3923 F1, #3925, #3957): the aggregate loop only pins the
	// aggregate jobs. A tolerated `continue-on-error` on a shard job's own
	// check-running step greens `Unit tests (shard k/N)` / `TLA+ models
	// (shard k/N)` while every ci.yml reader stays green, so the required
	// aggregate sees success. The same tolerance on an `install-test` verdict
	// step greens that leg's required context, since no aggregate re-reads its
	// result. Each critical step is asserted by name so a deletion or rename
	// cannot drop it from the population silently.
	it.each(CRITICAL_STEPS)(
		"keeps %s %s `%s` step from tolerating failure",
		(workflowFile, jobId, stepName) => {
			const steps = workflowJobs[workflowFile]?.[jobId]?.steps ?? [];
			const step = steps.find((entry) => entry.name === stepName);
			expect(
				step,
				`${workflowFile}:${jobId} must have a step named \`${stepName}\``,
			).toBeDefined();
			expect(
				step?.["continue-on-error"] ?? false,
				`${workflowFile}:${jobId} \`${stepName}\` must not tolerate failure`,
			).toBe(false);
		},
	);

	// #5002: as its own job the boundary check reported beside a lint red. Inside
	// `Lint & type-check` it needs `!cancelled()` to keep doing that.
	it.each(["Build compiled clients", "Check client dependency boundaries"])(
		"keeps lint-and-typecheck %s running after an earlier red step",
		(stepName) => {
			const step = jobs["lint-and-typecheck"].steps?.find(
				(entry) => entry.name === stepName,
			);
			expect(step?.if).toBe("${{ !cancelled() }}");
		},
	);

	// #3957: enumerate every step of the three non-matrix required producers so
	// a new step is classified before it can run unguarded, and assert the
	// classification count table. The live identities must be a sub-multiset of
	// the declared ones, so a duplicate `name:`/`uses:` cannot ride a removed
	// step past classification. Only the `verdict` class is no-drop (the
	// named population above), so a removed setup or best-effort step stays
	// accepted while a removed verdict step reds in the test above.
	it.each(PRODUCERS)(
		"classifies every step of the non-matrix required producer $workflow/$job",
		(producer) => {
			const job = workflowJobs[producer.workflow][producer.job];
			expect(
				job,
				`${producer.workflow}:${producer.job} must exist`,
			).toBeDefined();
			const declared = producer.steps.map((step) => step.id);
			const live = (job?.steps ?? []).map(
				(step) => step.name ?? (step.uses ?? "").replace(/@.*$/, ""),
			);
			// The live identities must be a sub-multiset of the declared ones:
			// `l(id) <= d(id)` per identity, not a set subset and not a total
			// count. A live step may reuse a declared identity only as often as
			// the declaration does, so a duplicate `name:`/`uses:` reds even when
			// another step was removed and the total is unchanged. A removed
			// setup or best-effort step leaves `l(id) = 0` and stays accepted; a
			// removed verdict step reds in the named test above.
			const declaredCount = new Map<string, number>();
			for (const id of declared) {
				declaredCount.set(id, (declaredCount.get(id) ?? 0) + 1);
			}
			const liveCount = new Map<string, number>();
			for (const id of live) {
				liveCount.set(id, (liveCount.get(id) ?? 0) + 1);
			}
			for (const [id, count] of liveCount) {
				const declaredForId = declaredCount.get(id) ?? 0;
				expect(
					declaredForId,
					`${producer.workflow}:${producer.job} step \`${id}\` is declared ${declaredForId} time(s) but appears ${count} time(s) in the workflow`,
				).toBeGreaterThanOrEqual(count);
			}
			const counts: Record<StepClass, number> = {
				verdict: 0,
				setup: 0,
				"best-effort": 0,
			};
			for (const step of producer.steps) counts[step.stepClass] += 1;
			const producerKey: `${StepWorkflow}:${string}` = `${producer.workflow}:${producer.job}`;
			expect(counts, `${producerKey} step classification counts`).toEqual(
				PRODUCER_STEP_COUNTS[producerKey],
			);
			// The named critical population and this producer's verdict class are
			// one population; a row added to only one of them fails here.
			const namedVerdicts = CRITICAL_STEPS.filter(
				([workflowFile, jobId]) =>
					workflowFile === producer.workflow && jobId === producer.job,
			).length;
			expect(
				counts.verdict,
				`${producerKey} verdict rows must match CRITICAL_STEPS`,
			).toBe(namedVerdicts);
		},
	);
});
