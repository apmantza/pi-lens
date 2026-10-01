import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	listModelConfigs,
	selectConfigs,
} from "../../scripts/check-tla-models.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

// #3918: the required `TLA+ models` check is an aggregate job over a
// `check-tla-models.mjs --shard i/N` matrix. Each assertion names the
// regression it keeps out.

const ROOT = resolve(import.meta.dirname, "../..");

type Step = { name?: string; run?: string };
type Job = {
	name?: string;
	needs?: string | string[];
	if?: string;
	env?: Record<string, string>;
	strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[] } };
	steps?: Step[];
};

const JOBS = (
	yaml.load(
		readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
	) as {
		jobs: Record<string, Job>;
	}
).jobs;
const asList = (needs: string | string[] | undefined) =>
	Array.isArray(needs) ? needs : needs ? [needs] : [];

describe("#3918 sharded TLA+ models workflow contract", () => {
	// Recurrence: a required check that is SKIPPED (its `needs` failed) counts
	// as passing in branch protection. An aggregate that drops the shard job
	// from `needs`, loses `if: always()`, or exits 0 on a non-success result
	// turns a red or cancelled shard into a green `TLA+ models`.
	it("keeps exactly one check named `TLA+ models`: an always() aggregate over the shard job that fails unless every shard succeeded", () => {
		const named = Object.entries(JOBS).filter(
			([, job]) => job.name === "TLA+ models",
		);
		expect(named.map(([id]) => id)).toEqual(["tla-models"]);
		const aggregate = JOBS["tla-models"];
		expect(asList(aggregate.needs)).toEqual(["tla-shards"]);
		expect(aggregate.if).toBe("always()");
		expect(aggregate.env?.SHARDS_RESULT).toBe("${{ needs.tla-shards.result }}");
		const run = String(
			aggregate.steps?.find(
				(entry) => entry.name === "Require every TLA+ models shard to succeed",
			)?.run,
		);
		// The exit sits INSIDE the not-success branch (a bare `exit 1` anywhere
		// else, or `exit 0` here, would pass a red shard).
		expect(run).toMatch(
			/if \[\[ "\$\{SHARDS_RESULT\}" != "success" \]\]; then[\s\S]*\n\s*exit 1\n\s*fi\s*$/,
		);
	});

	// Recurrence: a literal shard count beside a matrix edit (`--shard k/3`
	// with four matrix entries) silently runs a fraction of the models nowhere.
	// The count has ONE source, `strategy.job-total`, in the job name and the
	// `--shard` denominator, and the matrix is exactly 1..N.
	it("derives the shard denominator from the matrix, never a literal", () => {
		const shard = JOBS["tla-shards"];
		const shards = shard.strategy?.matrix?.shard ?? [];
		expect(shards).toEqual(
			Array.from({ length: shards.length }, (_, index) => index + 1),
		);
		expect(shards.length).toBeGreaterThan(1);
		expect(shard.strategy?.["fail-fast"]).toBe(false);
		expect(shard.name).toBe(
			"TLA+ models (shard ${{ matrix.shard }}/${{ strategy.job-total }})",
		);
		const run = shard.steps?.map((entry) => entry.run ?? "").join("\n") ?? "";
		expect(run).toMatch(
			/^\s*node scripts\/check-tla-models\.mjs --shard \$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}\s*$/m,
		);
	});

	// Recurrence: the pre-#3918 single job ran every config in one runner and
	// hit its 12-minute cap at 514 configs. A shard that quietly runs all
	// configs again (a malformed or dropped `--shard`) would reintroduce that.
	it("runs every config in exactly one shard, for the workflow's own shard count", () => {
		const all = listModelConfigs(ROOT);
		assertNonEmptyScan("TLA+ model configs", all.length, 74);
		const total = JOBS["tla-shards"].strategy?.matrix?.shard?.length ?? 0;
		const owners = new Map<string, number[]>();
		for (let index = 1; index <= total; index += 1) {
			const picked = selectConfigs(["--shard", `${index}/${total}`], ROOT);
			// A shard with nothing to run is a dead runner; keep them all busy.
			expect(picked.length, `shard ${index}/${total} is empty`).toBeGreaterThan(
				0,
			);
			for (const config of picked) {
				owners.set(config, [...(owners.get(config) ?? []), index]);
			}
		}
		const problems = all.flatMap((config) => {
			const shards = owners.get(config) ?? [];
			return shards.length === 1
				? []
				: [`${config}: in shards [${shards.join(", ")}]`];
		});
		expect(problems).toEqual([]);
		expect(owners.size).toBe(all.length);
	});

	// Recurrence: a partition that is only correct for the workflow's current N
	// would go wrong at the next matrix edit. Re-check across a range of N.
	it.each([1, 2, 3, 5, 7, 8])(
		"partitions into %i shards with no config skipped or doubled",
		(total) => {
			const all = listModelConfigs(ROOT);
			const picked = Array.from({ length: total }, (_, index) =>
				selectConfigs(["--shard", `${index + 1}/${total}`], ROOT),
			).flat();
			expect([...picked].sort()).toEqual([...all].sort());
		},
	);
});
