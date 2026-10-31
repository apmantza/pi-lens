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
	permissions?: Record<string, string>;
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
	it("keeps shard setup local and cache-only", () => {
		const shard = CI().test;
		expect(asList(shard.needs)).toEqual([]);
		expect(step(shard, "Install dependencies").run).toContain("npm install");
		expect(step(shard, "Build").run).toBe("npm run build");
		const cache = step(shard, "Cache npm cache");
		expect(cache.with?.key).toContain("hashFiles('package-lock.json')");
		expect(cache.with?.path).toBe("~/.npm");
	});

	// Recurrence (#5082): the shard restored ~/.npm twice, once through
	// `actions/cache` (`npm-Linux-node-22-<hash>`, 162 MB on master) and once
	// through setup-node's automatic npm cache, whose Linux entry
	// (`node-cache-Linux-x64-npm-<hash>`) held 676 bytes. The empty one is the
	// duplicate: it restores nothing, costs a restore and a post-job save probe
	// per shard, and sits in the 10 GB cap.
	it("restores ~/.npm exactly once: setup-node's automatic npm cache is off beside `actions/cache`", () => {
		const shard = CI().test;
		const setupNode = shard.steps?.find((entry) =>
			String((entry as { uses?: string }).uses).startsWith(
				"actions/setup-node@",
			),
		) as { with?: Record<string, unknown> } | undefined;
		expect(setupNode?.with?.["package-manager-cache"]).toBe(false);
		expect(setupNode?.with?.cache).toBeUndefined();
		const npmCaches = (shard.steps ?? []).filter(
			(entry) =>
				String((entry as { uses?: string }).uses).startsWith(
					"actions/cache@",
				) &&
				String((entry as { with?: Record<string, string> }).with?.path) ===
					"~/.npm",
		);
		expect(npmCaches.map((entry) => entry.name)).toEqual(["Cache npm cache"]);
	});

	// Recurrence: changing the matrix job or its shard population without
	// updating the required aggregate can make branch protection observe the
	// wrong job. The aggregate must follow the one matrix job by id.
	it("makes the Unit aggregate depend on the shard matrix job", () => {
		const jobs = CI();
		const matrixJobs = Object.entries(jobs).filter(
			([, job]) =>
				job.name?.startsWith("Unit tests (shard ") &&
				job.strategy?.matrix?.shard !== undefined,
		);
		expect(matrixJobs.map(([id]) => id)).toEqual(["test"]);
		expect(asList(jobs["unit-tests"].needs)).toContain(matrixJobs[0][0]);
		expect(matrixJobs[0][1].strategy?.matrix?.shard?.length).toBeGreaterThan(1);
	});

	// Recurrence: #4039 round 2 left `tla-models` with `needs: test` while its
	// env still read `needs.tla-shards.result`; actionlint caught it on CI only
	// (run 37599120579). Any job reading `needs.<id>.result` must need <id>.
	it("every job that reads needs.<id>.result lists <id> in needs", () => {
		const jobs = CI();
		const broken: string[] = [];
		for (const [id, job] of Object.entries(jobs)) {
			const text = JSON.stringify({
				env: job.env,
				if: job.if,
				steps: (job as { steps?: unknown }).steps,
			});
			for (const m of text.matchAll(/needs\.([A-Za-z0-9_-]+)\.result/g))
				if (!asList(job.needs).includes(m[1]))
					broken.push(`${id} reads needs.${m[1]} without needing it`);
		}
		expect(broken).toEqual([]);
	});

	// Recurrence: a required check that is SKIPPED (its `needs` failed) counts
	// as passing in branch protection. An aggregate without `if: always()`
	// would turn a red shard into a green `Unit tests`.
	// #4672: the verdict itself moved to the shared
	// `scripts/check-shard-verdict.mjs` seam, which both sharded aggregates
	// call; what stays pinned here is this aggregate's own inputs (its shard
	// job's result, its shard-row pattern, its check step) and that no step can
	// green a red shard. The classification is pinned from fixtures in
	// tests/scripts/check-shard-verdict.test.ts.
	it("keeps exactly one check named `Unit tests`: an always() aggregate over the shard job, classified by the shared shard-verdict seam", () => {
		const jobs = CI();
		const named = Object.entries(jobs).filter(
			([, job]) => job.name === "Unit tests",
		);
		expect(named.map(([id]) => id)).toEqual(["unit-tests"]);
		const aggregate = jobs["unit-tests"];
		expect(asList(aggregate.needs)).toEqual(["test"]);
		expect(aggregate.if).toBe("always()");
		expect(aggregate.env?.SHARDS_RESULT).toBe("${{ needs.test.result }}");
		const verdictStep = step(
			aggregate,
			"Require every Unit tests shard to succeed",
		);
		const run = String(verdictStep.run);
		expect(run).toMatch(
			/^\s*node scripts\/check-shard-verdict\.mjs \\\n\s*--label "Unit tests" \\\n\s*--result "\$\{SHARDS_RESULT\}"/m,
		);
		expect(verdictStep.env?.SHARD_JOB_PATTERN).toBe(
			"^Unit tests \\(shard [0-9]+/[0-9]+\\)$",
		);
		expect(verdictStep.env?.SHARD_CHECK_STEP).toBe("Run tests");
		// V2b: the gate that runs AFTER `Run tests` in this job is named too, so
		// a cancel between the two cannot green the aggregate. The flag is
		// repeatable and both values reach the seam.
		expect(verdictStep.env?.SHARD_TRAILING_CHECK_STEP).toBe(
			"Tmp-fixture hygiene owner",
		);
		expect(run).toContain('--check-step "${SHARD_CHECK_STEP}"');
		expect(run).toContain('--check-step "${SHARD_TRAILING_CHECK_STEP}"');
		expect(run).not.toMatch(/exit 0/);
		// The shard count is not baked into the pattern's semantics: it matches
		// `shard k/N` for any N, so the #3753 re-shard moves the matrix alone.
		const pattern = new RegExp(String(verdictStep.env?.SHARD_JOB_PATTERN));
		expect(pattern.test("Unit tests (shard 7/9)")).toBe(true);
		expect(pattern.test("Unit tests")).toBe(false);
		// #4672: reading this run's job list needs the actions scope and nothing
		// wider.
		expect(aggregate.permissions).toEqual({
			contents: "read",
			actions: "read",
		});
	});

	// V2b, the ordering half: the seam reads a step LIST, so the list has to
	// follow the job's own step order. Every step in `test` that runs at or
	// after `Run tests` and is not an `if: always()`/`failure()`/`cancelled()`
	// tail step must be named as a `--check-step`; otherwise a cancel between
	// `Run tests` and it leaves a real gate unjudged while the aggregate greens.
	// Adding a gating step there therefore reds this test until the flag list
	// follows, instead of silently widening the hole.
	it("names every gating step that runs after `Run tests` as a required step", () => {
		const jobs = CI();
		const shardSteps = jobs.test.steps ?? [];
		const names = shardSteps.map((entry) => entry.name ?? "");
		const work = names.indexOf("Run tests");
		expect(work).toBeGreaterThan(-1);
		const tolerates = (entry: Step) =>
			/^(always|failure|cancelled)\(\)$/.test(String(entry.if ?? ""));
		const gatingAfter = shardSteps
			.slice(work + 1)
			.filter((entry) => !tolerates(entry))
			.map((entry) => String(entry.name));
		// The hygiene gate is the one that matters here, and it really does run
		// after the work step.
		expect(gatingAfter).toContain("Tmp-fixture hygiene owner");
		const verdictStep = step(
			jobs["unit-tests"],
			"Require every Unit tests shard to succeed",
		);
		const run = String(verdictStep.run);
		const required = [
			...run.matchAll(/--check-step "\$\{(SHARD_[A-Z_]+)\}"/g),
		].map((match) => String(verdictStep.env?.[match[1]]));
		expect(required[0]).toBe("Run tests");
		expect(required).toEqual(["Run tests", ...gatingAfter]);
		// The names are real steps of the shard job, not typos: a renamed step
		// would otherwise leave the seam requiring a name nothing can report.
		for (const name of required) expect(names).toContain(name);
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
		expect(shards.length).toBe(5);
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
		const downloader = readFileSync(
			resolve(ROOT, "scripts/download-test-history-artifacts.mjs"),
			"utf8",
		);
		const rollup = String(
			step(
				jobsOf(".github/workflows/tool-smoke.yml")["test-history-rollup"],
				"Download unit-test result artifacts",
			).run,
		);
		for (const index of shard.strategy?.matrix?.shard ?? []) {
			expect(downloader).toContain(`"unit-test-results-linux-shard-${index}"`);
		}
		// Artifacts uploaded before the sharding keep the unsuffixed name.
		expect(downloader).toContain('"unit-test-results-linux"');
		expect(rollup).toContain("download-test-history-artifacts.mjs");
	});
});
