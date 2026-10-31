import { readFileSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	MODEL_COSTS_FILE,
	MODEL_COST_RANK_TOLERANCE,
	formatShardBalance,
	listModelConfigs,
	loadModelCosts,
	modelCostId,
	selectConfigs,
	selectShard,
} from "../../scripts/check-tla-models.mjs";
import { assignShards } from "../../scripts/lib/test-shard-assignment.mjs";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

// #3918: the required `TLA+ models` check is an aggregate job over a
// `check-tla-models.mjs --shard i/N` matrix. Each assertion names the
// regression it keeps out.

const ROOT = resolve(import.meta.dirname, "../..");

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = {
	name?: string;
	needs?: string | string[];
	if?: string;
	env?: Record<string, string>;
	permissions?: Record<string, string>;
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
	//
	// #4672: the aggregate's verdict is now the shared
	// `scripts/check-shard-verdict.mjs` seam (it distinguishes a shard
	// cancelled AFTER its model check finished from one cancelled during it),
	// so this pin no longer reads a shell comparison. What it keeps pinning is
	// the property that comparison carried: the aggregate reads the shard job's
	// own result, hands it to the seam, and the seam is the only thing that can
	// exit 0. The classification itself is pinned from fixtures in
	// tests/scripts/check-shard-verdict.test.ts.
	it("keeps exactly one check named `TLA+ models`: an always() aggregate over the shard job, classified by the shared shard-verdict seam", () => {
		const named = Object.entries(JOBS).filter(
			([, job]) => job.name === "TLA+ models",
		);
		expect(named.map(([id]) => id)).toEqual(["tla-models"]);
		const aggregate = JOBS["tla-models"];
		// #5082: `changes` joins so the aggregate can tell "formal/ proven
		// unchanged, no shard started" from "a shard is missing".
		expect(asList(aggregate.needs)).toEqual(["changes", "tla-shards"]);
		expect(aggregate.if).toBe("always()");
		expect(aggregate.env?.SHARDS_RESULT).toBe("${{ needs.tla-shards.result }}");
		const step = aggregate.steps?.find(
			(entry) => entry.name === "Require every TLA+ models shard to succeed",
		);
		const run = String(step?.run);
		// The shard job's result reaches the seam, and the seam decides.
		expect(step?.env?.SHARDS_RESULT ?? aggregate.env?.SHARDS_RESULT).toBe(
			"${{ needs.tla-shards.result }}",
		);
		expect(run).toMatch(
			/^\s*node scripts\/check-shard-verdict\.mjs \\\n\s*--label "TLA\+ models" \\\n\s*--result "\$\{SHARDS_RESULT\}"/m,
		);
		// The shard population this aggregate classifies is the `tla-shards`
		// matrix's own rows, matched by name, never a list of job ids.
		expect(step?.env?.SHARD_JOB_PATTERN).toMatch(/\^TLA\\\+ models \\\(shard/);
		// And the verdict runs on the row's real work step: a cancelled shard is
		// a pass only when THIS step concluded success (#4672).
		expect(step?.env?.SHARD_CHECK_STEP).toBe(
			"Model-check formal/ against each config's expected verdict",
		);
		// No `exit 0` shortcut and no swallowing step beside it: the seam's own
		// exit code is the job's verdict.
		expect(run).not.toMatch(/exit 0/);
		// Reading this run's job list needs the actions scope; nothing else was
		// widened (#4672).
		expect(aggregate.permissions).toEqual({
			contents: "read",
			actions: "read",
		});
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

	// #4672: the shipped split is by MEASURED COST, and this is the guard that
	// the measured table plus the workflow's shard count actually keeps the work
	// even. It reads the committed table itself, computes the per-shard summed
	// cost independently of the production code, and asserts the spread the old
	// count-based split lost: that one put 28% / 22% / 13% / 37% of the TLC
	// seconds in shards 1-4 (2.9x), which is how shard 4 came to be cancelled at
	// 735 s against a 720 s cap with every step `success`.
	it("packs the measured per-config TLC seconds evenly across the workflow's shard count", () => {
		const total = JOBS["tla-shards"].strategy?.matrix?.shard?.length ?? 0;
		expect(total).toBeGreaterThan(1);
		const table = loadModelCosts(ROOT);
		// Every lookup goes through `modelCostId`, the production key seam: a
		// hand-built `resolve(config).slice(ROOT.length + 1)` keeps the HOST
		// separator, so on a Windows runner every lookup in the corpus misses,
		// every config falls back to `table.max`, and the balance assertion below
		// is then 1.00x by construction -- vacuous (F1, docs/pi-lens-reviewer.md "Windows path
		// shapes"). The miss guard is what keeps that from passing silently.
		const misses = listModelConfigs(ROOT).filter(
			(config) => !(modelCostId(ROOT, config) in table.files),
		);
		expect(
			misses,
			"a cost lookup that misses the table falls back to table.max for every config, which makes the 1.05 balance assertion below vacuous instead of measured; key the table through modelCostId",
		).toEqual([]);
		const byShard = Array.from({ length: total }, (_, index) =>
			selectConfigs(["--shard", `${index + 1}/${total}`], ROOT).reduce(
				(sum, config) =>
					sum + (table.files[modelCostId(ROOT, config)] ?? table.max),
				0,
			),
		);
		assertNonEmptyScan("measured shard costs", byShard.length, 2);
		const heaviest = Math.max(...byShard);
		const lightest = Math.min(...byShard);
		// Greedy LPT on the full corpus (833 configs at #4714) lands within a few seconds of the ideal; 5%
		// admits one regenerated table's rounding without admitting a real tail.
		expect(heaviest / lightest).toBeLessThan(1.05);
		// And the counterfactual the fix exists for: the count-based round-robin
		// over the same table is NOT balanced, so this assertion cannot be
		// satisfied by a table that ignores the costs. The round-robin spread
		// moves with each config's sorted position, not with the table: one
		// added config took it from 2.07x (811 configs) to 2.00x, a second to
		// 1.47x (#4704). The bound stays well clear of the 1.05 above, which is
		// all a cost-blind table needs to fail (it lands near 1.00x).
		const roundRobin = Array.from({ length: total }, (_, index) =>
			listModelConfigs(ROOT)
				.filter((_, position) => position % total === index)
				.reduce(
					(sum, config) =>
						sum + (table.files[modelCostId(ROOT, config)] ?? table.max),
					0,
				),
		);
		expect(
			Math.max(...roundRobin) / Math.min(...roundRobin),
			"the count-based split this PR replaced should still be measurably worse; if it is not, the table or the corpus changed shape and the note in ci.yml is stale",
		).toBeGreaterThan(1.25);
	});

	// A cost row for a config that no longer exists is a table that was not
	// regenerated: it hides a deleted or renamed model behind a stale balance.
	it("carries a cost row for every formal config and none for a vanished one", () => {
		const table = loadModelCosts(ROOT);
		const live = new Set(
			listModelConfigs(ROOT).map((config) => modelCostId(ROOT, config)),
		);
		const stale = Object.keys(table.files).filter((id) => !live.has(id));
		expect(
			stale,
			`${MODEL_COSTS_FILE} has rows for configs that do not exist; rerun scripts/gen-tla-model-costs.mjs`,
		).toEqual([]);
		assertNonEmptyScan("model cost rows", Object.keys(table.files).length, 100);
	});

	// #4672 cap sizing: the old 12-minute cap sat AT the measured maximum (735 s
	// against 720 s on run 39380875926), so a slower runner turned finished work
	// into `cancelled`. The cap is the second mechanism behind the partition, and
	// it must keep the margin the file records.
	it("sizes the shard cap from the measured worst shard, with margin", () => {
		const shard = JOBS["tla-shards"];
		const cap = Number(
			(shard as Job & { "timeout-minutes"?: number })["timeout-minutes"],
		);
		// The projected worst shard after the cost-weighted partition is ~505 s
		// (1538 s of TLC work at the measured 3.05 s work per second of wall);
		// the worst shard ever observed at the old partition was 735 s -- the
		// attempt the 720 s cap CUT SHORT, not the 724 s the p90 table's maximum
		// shows, because that table cannot contain a censored attempt (F6).
		expect(cap).toBe(20);
		expect(cap * 60).toBeGreaterThanOrEqual(1.5 * 735);
		const file = readFileSync(
			resolve(ROOT, ".github/workflows/ci.yml"),
			"utf8",
		);
		const block = file.slice(
			file.indexOf("#4672 cap sizing"),
			file.indexOf("#4672 cap sizing") + 2400,
		);
		// The comment carries the measured tail and the margin, not a guess: both
		// cancellations (attempt 1 at 735 s, attempt 2 at 726 s, each against the
		// 720 s cap) and the per-shard-position p90 the cap was sized from.
		const whole = readFileSync(
			resolve(ROOT, ".github/workflows/ci.yml"),
			"utf8",
		);
		expect(whole).toContain("735 s and then 726 s against 720 s");
		expect(whole).toContain("118491126416");
		expect(whole).toContain("118632989721");
		expect(block).toContain("700 s (shard 4)");
		// F6: the p90 table excludes the two attempts the cap censored, so its
		// 724 s maximum is NOT the worst shard ever observed; the margin is
		// stated against 735 s (1200/735 = 1.63x), and the table's window says
		// what it leaves out. The comment is wrapped, so collapse it before
		// matching a phrase that spans lines.
		const prose = block.replace(/^[ \t]*#/gm, "").replace(/\s+/g, " ");
		expect(prose).toContain(
			"excludes the two attempts the 720 s cap cut short",
		);
		expect(prose).toContain("1.63x the worst shard ever observed (735 s)");
		expect(prose).not.toContain("1.6x the worst shard ever observed (724 s)");
	});

	// The balance line is the shard's own record of the split; without it a
	// stale table is invisible until a timeout 12 minutes later.
	it("prints the per-shard balance, labels the split as the table's projection, and names every unmeasured config", () => {
		const costs = resolveCostsFixture();
		const configs = listModelConfigs(ROOT).slice(0, 4);
		const line = formatShardBalance({ configs, total: 4, costs });
		expect(line).toContain("all shards");
		expect(line).toContain("projected from scripts/tla-model-costs.json");
		expect(line).toContain("heaviest/lightest = ");
		expect(line).toContain("have no row in");
		expect(line).toContain("scripts/gen-tla-model-costs.mjs");
		// With no measurement handed in there is nothing to compare, and the
		// line says so instead of implying the projection is the run.
		expect(line).toContain("this run's own seconds unavailable");
		expect(line).not.toContain("COST-TABLE DRIFT");
	});

	// F4: the projection half of that line is computed from the table itself, so
	// it is 1.00x by construction and can never reveal drift in the table -- the
	// one thing `Accepted residuals` offers it for. These cases are the drift
	// half: this run's own seconds against the table's own ORDERING.
	it("prints the drift between the table and this run when they agree", () => {
		const costs = { root: ROOT, ...loadModelCosts(ROOT) };
		const configs = listModelConfigs(ROOT).slice(0, 40);
		const observed = new Map<string, number>(
			configs.map((config) => [
				modelCostId(ROOT, config),
				costs.files[modelCostId(ROOT, config)] ?? costs.max,
			]),
		);
		const line = formatShardBalance({ configs, total: 4, costs, observed });
		expect(line).toContain("this run measured");
		expect(line).toContain("(1.00x the table's");
		expect(line).toContain("the table's ordering still describes this run");
		expect(line).toContain("rank agreement 1.00");
		expect(line).toContain(`${MODEL_COST_RANK_TOLERANCE.toFixed(2)} tolerance`);
		expect(line).not.toContain("COST-TABLE DRIFT");
	});

	// V1, the false positive this replaces: the shipped 1.25x band was sized
	// from "shard-level sums move up to 24% run to run", and the partition's
	// FIRST live run (39435284236) falsified that. Replayed here from that
	// run's own four shard logs (fixtures/tla-model-costs/, captured verbatim
	// with `gh run view 39435284236 --log --job <id>`), a FRESH table and a
	// per-shard sum sit 0.64x apart on shard 1/4 -- so the published line
	// printed `COST-TABLE DRIFT` on a healthy run, one shard of four. A warning
	// that cries wolf is worse than none: no shard of this run may print it.
	// The ratios are re-pinned on each cost-table regeneration (#4714 regen from
	// run 40147263648): each is this fixture run's measured shard seconds over
	// the seconds the table projects for that shard, so a new table or a new
	// fixture run moves it. The pin still asserts no DRIFT line.
	it.each([
		["1of4", "0.65x"],
		["2of4", "1.65x"],
		["3of4", "1.00x"],
		["4of4", "1.47x"],
	] as const)(
		"does not call the table stale for shard %s of the healthy run 39435284236",
		(shard, ratio) => {
			const measured = JSON.parse(
				readFileSync(
					join(
						import.meta.dirname,
						"..",
						"fixtures",
						"tla-model-costs",
						`run-39435284236-${shard}.json`,
					),
					"utf8",
				),
			) as { files: Record<string, number> };
			const costs = { root: ROOT, ...loadModelCosts(ROOT) };
			const observed = new Map<string, number>(Object.entries(measured.files));
			const configs = Object.keys(measured.files).map((id) =>
				resolve(ROOT, id),
			);
			assertNonEmptyScan(`shard ${shard} configs`, configs.length, 100);
			const line = formatShardBalance({ configs, total: 4, costs, observed });
			// The ratio is still reported -- an operator reads this run's own
			// numbers -- but it is not the verdict, because one shard's sum
			// carries the runner's speed as well as the table's error.
			expect(line).toContain(`(${ratio} the table's`);
			expect(line).toContain("one shard's own ratio");
			expect(line).not.toContain("COST-TABLE DRIFT");
			expect(line).toContain("the table's ordering still describes this run");
		},
	);

	// The direction that must red: the table's rows still exist, nothing is
	// unmeasured, but its ORDERING no longer describes this run -- the shape a
	// table that was never regenerated after a corpus rewrite arrives in.
	it("names a stale cost table instead of confirming it with its own projection", () => {
		const costs = { root: ROOT, ...loadModelCosts(ROOT) };
		const configs = listModelConfigs(ROOT).slice(0, 40);
		// Hand this run the table's rows in REVERSE order: each config measured
		// roughly what the table budgets for its opposite end.
		const reversed = [...configs].reverse();
		const observed = new Map<string, number>(
			configs.map((config, index) => [
				modelCostId(ROOT, config),
				Math.max(
					0.1,
					costs.files[modelCostId(ROOT, reversed[index])] ?? costs.max,
				),
			]),
		);
		const line = formatShardBalance({ configs, total: 4, costs, observed });
		expect(line).toContain("COST-TABLE DRIFT");
		expect(line).toContain("the table's ordering no longer describes this run");
		expect(line).toContain(
			`outside the ${MODEL_COST_RANK_TOLERANCE.toFixed(2)}`,
		);
		expect(line).toContain("scripts/gen-tla-model-costs.mjs");
		// The projection half is untouched: the two halves are independent, so a
		// reader sees the table's own spread next to this run's disagreement.
		expect(line).toContain("heaviest/lightest = ");
	});

	// A config count too small to rank cannot be compared, and the line says
	// so instead of guessing in either direction.
	it("says it cannot compare when this shard has too few priced configs to rank", () => {
		const costs = { root: ROOT, ...loadModelCosts(ROOT) };
		const configs = listModelConfigs(ROOT).slice(0, 2);
		const observed = new Map<string, number>(
			configs.map((config) => [
				modelCostId(ROOT, config),
				99 * (costs.files[modelCostId(ROOT, config)] ?? costs.max),
			]),
		);
		const line = formatShardBalance({ configs, total: 4, costs, observed });
		expect(line).toContain("too few priced configs");
		expect(line).not.toContain("COST-TABLE DRIFT");
	});

	// V5d: `selectShard` (the selector each shard runs) and
	// `formatShardBalance` (the line it prints) packed the same 811 configs with
	// DIFFERENT item ids -- `String(position)` against the config path -- and
	// `assignShards` breaks a cost tie by ascending id. 714 of these configs sit
	// in tie groups, so the two packs disagreed on the MEMBERSHIP of all four
	// shards (102 of shard 1's 201 configs swapped) while every number either
	// printed was identical. One pack, keyed by the config path.
	//
	// #4680 r4 F7: the expectation is built HERE, from the table and the
	// shared LPT pack keyed by the config path, not read back from either
	// function. The old assertion (`this shard: <selected.length> configs`)
	// restated the count the test itself passed in, and the faithful old
	// selector (position-keyed) left it green.
	it("packs the selector and the printed balance with one item id scheme", () => {
		const costs = { root: ROOT, ...loadModelCosts(ROOT) };
		const all = listModelConfigs(ROOT);
		const pack = assignShards(
			all.map((config) => ({
				id: config,
				cost: costs.files[modelCostId(ROOT, config)] ?? costs.max,
			})),
			4,
		);
		for (let index = 1; index <= 4; index += 1) {
			const selected = selectShard(all, { index, total: 4 }, costs);
			const expected = all.filter((config) => pack.get(config) === index);
			expect(
				selected,
				`shard ${index}/4 selects a different membership than the path-keyed pack`,
			).toEqual(expected);
			// The printed line projects the same members' seconds.
			const projected = expected.reduce(
				(sum, config) =>
					sum + (costs.files[modelCostId(ROOT, config)] ?? costs.max),
				0,
			);
			expect(
				formatShardBalance({ configs: selected, total: 4, costs }),
			).toContain(
				`this shard: ${expected.length} configs, ${projected.toFixed(1)}s projected`,
			);
			expect(selected.length).toBeGreaterThan(0);
		}
		const owners = new Map<string, number>();
		for (let index = 1; index <= 4; index += 1)
			for (const config of selectShard(all, { index, total: 4 }, costs))
				owners.set(config, (owners.get(config) ?? 0) + 1);
		expect(owners.size).toBe(all.length);
		expect([...owners.values()].filter((count) => count !== 1)).toEqual([]);
	});

	// The selector's own docstring: equal-cost input reproduces the count-based
	// round-robin exactly. Keyed by `String(position)` the tie broke in
	// LEXICOGRAPHIC id order ('0','1','10','100',...), so the pack was a shuffle
	// of that round-robin, not that round-robin.
	it("reproduces the count-based round-robin on equal-cost input", () => {
		const all = listModelConfigs(ROOT);
		const flat = {
			root: ROOT,
			files: Object.fromEntries(
				all.map((config) => [modelCostId(ROOT, config), 1]),
			),
			max: 1,
		};
		for (let index = 1; index <= 4; index += 1) {
			expect(selectShard(all, { index, total: 4 }, flat)).toEqual(
				all.filter((_, position) => position % 4 === index - 1),
			);
		}
	});

	// F1, the HIGH finding: `Unit tests Windows` was red at the PR's head because
	// the cost-table key was built by hand with the HOST separator, while every
	// key in scripts/tla-model-costs.json is posix. AGENTS.md shape 35: dose the
	// win32 semantics here rather than trusting a CI lane to notice.
	it("keys the cost table through one posix normalizer, so a Windows host separator cannot miss every row", () => {
		const table = loadModelCosts(ROOT);
		const winRoot = "C:\\pi-lens";
		const winConfig = "C:\\pi-lens\\formal\\blocker-pending\\CarryGateB.cfg";
		// The pre-fix expression, verbatim in shape: a root-relative slice keeps
		// `\`, and no row in the posix-keyed table answers to it.
		const preFixKey = win32.relative(winRoot, winConfig);
		expect(preFixKey).toBe("formal\\blocker-pending\\CarryGateB.cfg");
		expect(table.files[preFixKey]).toBeUndefined();
		// The production seam maps the same pair onto the table's own key.
		const key = modelCostId(winRoot, winConfig, win32);
		expect(key).toBe("formal/blocker-pending/CarryGateB.cfg");
		expect(table.files[key]).toBeGreaterThan(0);
		// And over the whole population: every real config, addressed as a
		// Windows runner would address it, still keys its row.
		const unreached = listModelConfigs(ROOT)
			.map((config) => {
				const relative = modelCostId(ROOT, config);
				expect(relative).not.toContain("\\");
				const asWindows = `${winRoot}\\${relative.split("/").join("\\")}`;
				return modelCostId(winRoot, asWindows, win32);
			})
			.filter((id) => !(id in table.files));
		expect(unreached).toEqual([]);
	});
});

/**
 * The real table, then a copy with one config removed, so the unmeasured branch
 * of the balance line is exercised without touching the committed file.
 */
function resolveCostsFixture() {
	const table = loadModelCosts(ROOT);
	const files = { ...table.files };
	delete files[Object.keys(files)[0]];
	return { root: ROOT, files, max: table.max };
}
