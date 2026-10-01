import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

// #3753: the required `Unit tests` check is an aggregate job over a
// `vitest --shard=i/N` matrix. Each assertion names the regression it keeps out.

const ROOT = resolve(import.meta.dirname, "../..");

type Step = {
	name?: string;
	run?: string;
	if?: string;
	env?: Record<string, string>;
	with?: Record<string, string>;
};
type Job = {
	name?: string;
	needs?: string | string[];
	if?: string;
	env?: Record<string, string>;
	strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
	steps?: Step[];
};

function jobsOf(file: string): Record<string, Job> {
	return (
		yaml.load(readFileSync(resolve(ROOT, file), "utf8")) as {
			jobs: Record<string, Job>;
		}
	).jobs;
}

const CI = () => jobsOf(".github/workflows/ci.yml");
const asList = (needs: string | string[] | undefined) =>
	Array.isArray(needs) ? needs : needs ? [needs] : [];
const step = (job: Job, name: string) => {
	const found = job.steps?.find((entry) => entry.name === name);
	if (!found) throw new Error(`no "${name}" step`);
	return found;
};

describe("#3753 sharded Unit tests workflow contract", () => {
	// Recurrence: a required check that is SKIPPED (its `needs` failed) counts
	// as passing in branch protection. An aggregate without `if: always()`
	// would turn a red shard into a green `Unit tests`.
	it("keeps exactly one check named `Unit tests`: an always() aggregate over the shard job that fails unless every shard succeeded", () => {
		const jobs = CI();
		const named = Object.entries(jobs).filter(
			([, job]) => job.name === "Unit tests",
		);
		expect(named.map(([id]) => id)).toEqual(["unit-tests"]);
		const aggregate = jobs["unit-tests"];
		expect(asList(aggregate.needs)).toEqual(["test"]);
		expect(aggregate.if).toBe("always()");
		expect(aggregate.env?.SHARDS_RESULT).toBe("${{ needs.test.result }}");
		const run = String(
			step(aggregate, "Require every Unit tests shard to succeed").run,
		);
		// The exit sits INSIDE the not-success branch (a bare `exit 1` anywhere
		// else, or `exit 0` here, would pass a red shard).
		expect(run).toMatch(
			/if \[\[ "\$\{SHARDS_RESULT\}" != "success" \]\]; then[\s\S]*\n\s*exit 1\n\s*fi\s*$/,
		);
	});

	// Recurrence: a literal shard count beside a matrix edit (`--shard=k/3` with
	// four matrix entries) silently runs a fraction of the suite nowhere. The
	// count has ONE source, `strategy.job-total` (the matrix length), in both
	// the job name and the `--shard` denominator.
	it("derives the shard denominator from the matrix, never a literal", () => {
		const shard = CI().test;
		const shards = shard.strategy?.matrix?.shard ?? [];
		expect(shards).toEqual(
			Array.from({ length: shards.length }, (_, index) => index + 1),
		);
		expect(shards.length).toBeGreaterThan(1);
		expect(shard.strategy?.["fail-fast"]).toBe(false);
		expect(shard.name).toBe(
			"Unit tests (shard ${{ matrix.shard }}/${{ strategy.job-total }})",
		);
		const run = String(step(shard, "Run tests").run);
		expect(run).toContain(
			"--shard=${{ matrix.shard }}/${{ strategy.job-total }}",
		);
	});

	// Recurrence: `--shard` hands tests/config/tmp-fixture-hygiene (the
	// serialized owner that reds on other files' tmp leaks) to ONE shard, which
	// left the other shards' leaks unjudged. Every shard re-runs it, sharing
	// the sharded run's run id so it reads that run's baseline and manifest.
	it("re-runs the tmp-fixture-hygiene owner in every shard, after the sharded run, on the same run id", () => {
		const shard = CI().test;
		const names = (shard.steps ?? []).map((entry) => entry.name);
		expect(names.indexOf("Tmp-fixture hygiene owner")).toBe(
			names.indexOf("Run tests") + 1,
		);
		const owner = step(shard, "Tmp-fixture hygiene owner");
		expect(owner.run).toBe(
			"npm test -- tests/config/tmp-fixture-hygiene.test.ts",
		);
		expect(owner.if).toBeUndefined();
		expect(shard.env?.PI_LENS_TMP_HYGIENE_RUN_ID).toContain(
			"shard-${{ matrix.shard }}",
		);
		// No step-level override may split the two steps onto different ids.
		expect(step(shard, "Run tests").env?.PI_LENS_TMP_HYGIENE_RUN_ID).toBe(
			undefined,
		);
		expect(owner.env?.PI_LENS_TMP_HYGIENE_RUN_ID).toBe(undefined);
	});

	// #3801 (maintainer scope, from the 1500-run CI-friction study) dropped
	// install-test's own `needs: test` and `needs: lint-and-typecheck`: a cost
	// gate, not a data dependency, that made Install the LAST required check in
	// 35 of 37 green runs, a median 3.5 minutes behind Unit tests. Install now
	// starts beside the shards.
	it("lets Install start beside the shards", () => {
		const jobs = CI();
		const install = asList(jobs["install-test"].needs);
		expect(install).not.toContain("test");
		expect(install).not.toContain("lint-and-typecheck");
	});

	// Recurrence: the shard artifact names are the nightly rollup's input
	// (tool-smoke.yml downloads them by exact name). A new matrix shard
	// without a matching download name would drop that shard's files from the
	// durable history without any error.
	it("uploads one artifact per shard and the nightly rollup downloads every one", () => {
		const shard = CI().test;
		const upload = step(shard, "Upload per-file test results");
		const name = String(upload.with?.name);
		expect(name).toBe("unit-test-results-linux-shard-${{ matrix.shard }}");
		const rollup = String(
			step(
				jobsOf(".github/workflows/tool-smoke.yml")["test-history-rollup"],
				"Download unit-test result artifacts",
			).run,
		);
		for (const index of shard.strategy?.matrix?.shard ?? []) {
			expect(rollup).toContain(` unit-test-results-linux-shard-${index}`);
		}
		// Artifacts uploaded before the sharding keep the unsuffixed name.
		expect(rollup).toContain("for artifact_name in unit-test-results-linux ");
	});
});
