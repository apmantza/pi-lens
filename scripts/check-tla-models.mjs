#!/usr/bin/env node
/**
 * Model-check every TLA+ config under formal/ and compare TLC's verdict with
 * the one the config expects (#3447).
 *
 * Each `.cfg` starts with two header lines:
 *
 *   \* expect: pass                        (or: violated <InvariantName>)
 *   \* module: FileLock                    (the .tla beside it)
 *
 * A config that documents a known bug expects the violation, so the check is
 * a ratchet both ways: a model edit that hides the bug reds, and a fix that
 * makes the invariant hold reds until its config says `pass`.
 *
 * Configs run through a bounded-concurrency pool (#3572) sized to the host's
 * CPU count, so the job's wall time falls well below the sum of every
 * config's own time. Every config always runs with a single TLC worker
 * (#3517): TLC's `-workers auto` explores the state graph across several
 * threads, so when a model can violate more than one invariant, whichever
 * thread gets there first decides which one TLC reports — a race the pool
 * would otherwise make worse, not better, by adding CPU contention. One
 * worker gives deterministic BFS order and so a deterministic first
 * violation, at no verdict cost either way: TLC still explores every
 * reachable state before it can report `pass`, so pinning one worker only
 * changes how long that takes, never whether a violation is found. Pinning
 * every config, not only `violated` ones, also keeps the pool itself simple:
 * it is the only source of concurrency, and TLC's own threading never
 * competes with it for the same cores.
 *
 * `--shard i/N` (#3918) runs only the configs at sorted positions p with
 * p % N === i - 1, so N CI jobs together run every config exactly once
 * (ci.yml `tla-shards`; `tests/config/tla-models-shard-workflow.test.ts`
 * pins the partition). Round-robin over the sorted list, not contiguous
 * blocks: the slow models cluster in a few `formal/` directories, and
 * stepping through the list spreads each directory across the shards.
 *
 * Usage: node scripts/check-tla-models.mjs [--jar <tla2tools.jar>] [--concurrency <n>] [--shard <i/N>]
 * Every flag's value may use the space or the equals form (`--shard 1/4` and
 * `--shard=1/4` are the same). An unknown flag, a missing value, or a
 * positional argument is rejected before any download or JVM spawn, so a typo
 * can never silently run the full, unsharded population (#3920).
 * Without --jar, the pinned release is downloaded to .cache/ and verified.
 * Without --concurrency, the pool is sized to the host's CPU count.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { assignShards, shardLoads } from "./lib/test-shard-assignment.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

export const TLA_TOOLS = Object.freeze({
	release: "v1.7.4",
	url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
	sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
});

const EXPECT_LINE = /^\\\*\s*expect:\s*(.+?)\s*$/m;
const MODULE_LINE = /^\\\*\s*module:\s*([A-Za-z_]\w*)\s*$/m;

/**
 * Read a config's expected verdict and module. Returns `{ error }` for a
 * missing or malformed header, so the check can name the file.
 */
export function parseModelHeader(text) {
	const expectMatch = EXPECT_LINE.exec(text);
	const moduleMatch = MODULE_LINE.exec(text);
	if (!expectMatch) return { error: "missing `\\* expect:` header" };
	if (!moduleMatch) return { error: "missing `\\* module:` header" };
	const value = expectMatch[1];
	if (value === "pass")
		return { module: moduleMatch[1], expect: { status: "pass" } };
	const violated = /^violated\s+([A-Za-z_]\w*)$/.exec(value);
	if (violated)
		return {
			module: moduleMatch[1],
			expect: { status: "violated", invariant: violated[1] },
		};
	return { error: `unrecognised expectation "${value}"` };
}

/** TLC's verdict from its combined output. */
export function classifyTlcOutput(output) {
	const violated = /Error: Invariant (\w+) is violated/.exec(output);
	if (violated) return { status: "violated", invariant: violated[1] };
	// A config with `CHECK_DEADLOCK TRUE` (a lock-order model, #3830) reports a
	// cycle as `Error: Deadlock reached.`; a config expects it as `violated Deadlock`.
	if (/^Error: Deadlock reached\./m.test(output))
		return { status: "violated", invariant: "Deadlock" };
	if (/Model checking completed\. No error has been found\./.test(output))
		return { status: "pass" };
	const errorLine = output
		.split("\n")
		.find((line) => /Error|Exception/.test(line));
	return { status: "error", detail: errorLine?.trim() ?? "no verdict" };
}

/**
 * TLC's distinct-state count from its statistics line
 * (`N states generated, M distinct states found, K states left on queue.`),
 * or null when the run printed none, such as a parse error (#4714). A missing
 * count is no count, never zero: the ratchet then reports rather than fails.
 */
export function parseDistinctStates(output) {
	const match =
		/^\s*[\d,]+ states generated, ([\d,]+) distinct states found/m.exec(
			String(output),
		);
	return match ? Number(match[1].replace(/,/g, "")) : null;
}

/**
 * How far a config's distinct-state count may grow past its recorded count
 * before the checker fails it (#4714). Recurrence: #3836, where three processes
 * at MaxGen=5 and Rounds=2 reached 30.8M distinct states and never finished.
 */
export const STATE_COUNT_FACTOR = 2;

/**
 * The runs whose distinct-state count exceeds the recorded count by more than
 * `factor`. A run with no count, or a config with no recorded count, is not a
 * jump here (see `unrecordedStateCounts`).
 *
 * @param {Array<{ id: string, distinctStates: number | null }>} outcomes
 * @param {Record<string, number>} states the recorded counts, by `modelCostId`
 * @param {number} [factor]
 */
export function stateCountJumps(outcomes, states, factor = STATE_COUNT_FACTOR) {
	const jumps = [];
	for (const outcome of outcomes) {
		const recorded = states[outcome.id];
		if (!Number.isInteger(recorded) || outcome.distinctStates == null) continue;
		if (outcome.distinctStates > recorded * factor)
			jumps.push({
				id: outcome.id,
				recorded,
				observed: outcome.distinctStates,
			});
	}
	return jumps;
}

/** The message for one `stateCountJumps` entry: its config, old and new count. */
export function formatStateJump(
	{ id, recorded, observed },
	factor = STATE_COUNT_FACTOR,
) {
	return `STATE-COUNT JUMP ${id}: old count ${recorded} distinct states (recorded in ${MODEL_COSTS_FILE}), new count ${observed} distinct states, more than ${factor}x the recorded count. If the growth is intended, re-record the count: regenerate from a shard log that prints it (scripts/gen-tla-model-costs.mjs), or raise the count in ${MODEL_COSTS_FILE} in the same PR with the reason`;
}

/** The configs that ran with a count but have no recorded count yet. */
export function unrecordedStateCounts(outcomes, states) {
	return outcomes
		.filter(
			(outcome) =>
				outcome.distinctStates != null && !Number.isInteger(states[outcome.id]),
		)
		.map((outcome) => outcome.id);
}

export function verdictMatches(expected, actual) {
	if (expected.status !== actual.status) return false;
	return (
		expected.status !== "violated" || expected.invariant === actual.invariant
	);
}

export function describeVerdict(verdict) {
	if (verdict.status === "violated") return `violated ${verdict.invariant}`;
	if (verdict.status === "error") return `error: ${verdict.detail}`;
	return "pass";
}

/** Every `formal/<dir>/*.cfg`, sorted. */
export function listModelConfigs(root) {
	const formal = path.join(root, "formal");
	if (!fs.existsSync(formal)) return [];
	const configs = [];
	for (const dir of fs.readdirSync(formal, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const abs = path.join(formal, dir.name);
		for (const file of fs.readdirSync(abs)) {
			if (file.endsWith(".cfg")) configs.push(path.join(abs, file));
		}
	}
	return configs.sort();
}

/**
 * Validates a `--shard i/N` value: integers with 1 <= i <= N. A malformed
 * value must throw here, never fall back to "all configs": a sharded CI job
 * that silently ran everything would not fail, it would just stop being a
 * shard.
 */
export function parseShardArg(raw) {
	const match = /^(\d+)\/(\d+)$/.exec(String(raw));
	const index = match ? Number(match[1]) : 0;
	const total = match ? Number(match[2]) : 0;
	if (index < 1 || index > total)
		throw new Error(
			`--shard must be i/N with 1 <= i <= N, got ${JSON.stringify(raw)}`,
		);
	return { index, total };
}

/**
 * The measured per-config TLC seconds, from scripts/tla-model-costs.json
 * (`scripts/gen-tla-model-costs.mjs`). The table's own provenance -- the run
 * ids it was measured from and the note -- lives in that file.
 *
 * A config the table does not know costs the table's MAXIMUM, not zero and not
 * the median: a config added without a regeneration is usually a NEW model
 * (heavier than the ones already there), and over-pricing it can only move it
 * into a lighter shard, while under-pricing it is how a fresh tail shard
 * appears. Same fail-closed direction as the Unit shards' weights file
 * (`scripts/lib/test-shard-assignment.mjs`), whose median fallback is safe
 * there because a new test file is small; a new TLC config is not.
 */
export const MODEL_COSTS_FILE = "scripts/tla-model-costs.json";

/**
 * @param {string} root repository root
 * @returns {{ files: Record<string, number>, max: number, states: Record<string, number> }}
 */
export function loadModelCosts(root) {
	const file = path.join(root, MODEL_COSTS_FILE);
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		// Loud, like the Unit shards' weights loader: every shard reads the same
		// checkout, so a missing or malformed table is a repository defect.
		throw new Error(
			`TLA+ model costs unreadable at ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const files = parsed?.files;
	if (!files || typeof files !== "object" || Array.isArray(files))
		throw new Error(`TLA+ model costs at ${file} have no "files" object`);
	const seconds = [];
	for (const [id, value] of Object.entries(files)) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
			throw new Error(
				`TLA+ model costs at ${file}: "${id}" is not a finite non-negative number`,
			);
		seconds.push(value);
	}
	// A table whose max is 0 is not a table: every config would price at 0,
	// `assignShards` would leave the whole corpus in shard 1 and three runners
	// would red with "selects no formal/*/*.cfg" -- a confusing diagnosis for
	// one bad regeneration (V4). The rule is the max, not the row count: `{}`
	// and a table of zero rows have the same max (#4680 r4 F5). Refuse it here
	// as well as at the generator, because a committed file can also be
	// truncated by hand.
	const max = seconds.length === 0 ? 0 : Math.max(...seconds);
	if (max <= 0)
		throw new Error(
			`TLA+ model costs at ${file} price no config above 0 s; regenerate with scripts/gen-tla-model-costs.mjs (a config with no row costs the table max, so a table whose max is 0 sends every config to shard 1)`,
		);
	// `states` is the #4714 distinct-state count per config. A table written
	// before it has no key at all, and that is a valid table with no counts.
	const states = parsed.states ?? {};
	if (typeof states !== "object" || Array.isArray(states))
		throw new Error(
			`TLA+ model costs at ${file} have a "states" that is not an object`,
		);
	for (const [id, count] of Object.entries(states))
		if (!Number.isInteger(count) || count < 0)
			throw new Error(
				`TLA+ model costs at ${file}: states["${id}"] is not a non-negative integer`,
			);
	return { files, max, states };
}

/**
 * The cost table's key for `config`: its path under `root`, ALWAYS posix.
 *
 * One seam for the table's key, because the table's keys are posix and the host
 * separator is not: keyed by hand, `<root>`-relative paths carry `\` on a
 * Windows runner, every lookup misses, and a miss costs the table's MAXIMUM --
 * so all configs become equal-cost and the balance this shard prints reads a
 * flat 1.00x by construction (docs/pi-lens-reviewer.md "Windows path shapes"; the
 * #4356 recurrence: a host-default separator reddening the Windows lane).
 * `pathImpl` is injectable so a posix lane can prove the win32 shape
 * (AGENTS.md shape 35) instead of trusting it.
 *
 * @param {string} root repository root
 * @param {string} config an absolute config path
 * @param {typeof path} [pathImpl] the host path module, or `path.win32` to dose one
 * @returns {string} the table key
 */
export function modelCostId(root, config, pathImpl = path) {
	return pathImpl.relative(root, config).split(pathImpl.sep).join("/");
}

/** `config`'s measured TLC seconds, or the table's max when it has no row. */
function costOf(config, root, costs) {
	return costs.files[modelCostId(root, config)] ?? costs.max;
}

/**
 * Shard `index` (1-based) of `total`.
 *
 * With no cost table (`costs === null`) this is the original round-robin over
 * the given order: equal costs make the LPT pack below assign exactly the same
 * way, and the pure helper stays usable without touching disk.
 *
 * With the measured table it is the same longest-processing-time pack the Unit
 * shards use (`assignShards`), over per-config TLC seconds. Round-robin by
 * COUNT was the #4672 defect: configs' costs differ by two orders of magnitude
 * (1.2 s to 422 s on the 2026-10-20 runs), so master run 39380875926's four
 * shards summed 733 s / 1255 s / 1617 s / 2148 s of TLC time, and the heaviest
 * was cancelled at 735 s against its 720 s `timeout-minutes` with every step
 * `success`.
 *
 * The result is re-sorted into the input (path) order, so a shard's execution
 * order -- and the log's config order -- is stable across runs.
 */
export function selectShard(configs, { index, total }, costs = null) {
	if (costs === null)
		return configs.filter((_, position) => position % total === index - 1);
	const { assignment } = packShards(configs, total, costs);
	return configs.filter((config) => assignment.get(config) === index);
}

/**
 * The pack itself, keyed by the config path: the ONE item id scheme the
 * selector and the printed balance share.
 *
 * `assignShards` breaks a cost TIE by ascending id, so the id decides which
 * shard a config lands in whenever two configs cost the same -- and 714 of the
 * 811 configs here sit in tie groups. Keyed by `String(position)` in the
 * selector and by the config path in the printed line, the two packs agreed on
 * every count and every summed second while disagreeing on 102 of the 201
 * configs in shard 1 (V5d). With the path as the id they are one pack, and
 * "equal-cost input reproduces round-robin exactly" is true of the membership
 * too, not only of the counts.
 *
 * @param {string[]} configs
 * @param {number} total
 * @param {{ root: string, files: Record<string, number>, max: number }} costs
 * @returns {{ items: Array<{ id: string, cost: number }>, assignment: Map<string, number> }}
 */
function packShards(configs, total, costs) {
	const items = configs.map((config) => ({
		id: config,
		cost: costOf(config, costs.root, costs),
	}));
	return { items, assignment: assignShards(items, total) };
}

/**
 * How far this shard's own measurement may disagree with the table's ORDERING
 * before the balance line calls the table stale.
 *
 * The old band compared one shard's summed seconds against the table's
 * projection for the same configs and called 1.25x drift. Re-measured against
 * the partition's first live run (39435284236), that quantity is not a table
 * property at all: the four shards spent 990.2 / 1753.5 / 1617.2 / 1578.8 s
 * where the table projected 1537.6 / 1538.8 / 1537.6 / 1537.6 s -- 0.64x,
 * 1.14x, 1.05x, 1.03x on a table generated the previous day. A shard's sum
 * carries the runner's own speed (a whole shard's configs run on one machine,
 * in one window), so it cancels the partition but not the machine.
 *
 * The ordering does not: every shard of that same run ranks its configs
 * exactly as the table does (rank agreement 0.865, 0.874, 0.889, 0.875 over
 * 201-204 configs), while a table whose rows were handed out in reverse order
 * scores -0.03 to 0.09 on those same runs. 0.60 sits between the two with the
 * low side 0.26 clear of the worst healthy shard, and it is scale-free: a
 * table that is uniformly wrong by 2x still ranks identically, and uniform
 * error cannot move a config out of its shard.
 */
export const MODEL_COST_RANK_TOLERANCE = 0.6;

/** Fewer priced configs than this cannot rank a table against a run. */
const MIN_RANKED_CONFIGS = 5;

/**
 * Spearman's rank agreement between the table's costs and this run's own
 * seconds over the configs where both are known, or `null` when the sample is
 * too small or one side has no spread (nothing to rank).
 *
 * @param {Array<[number, number]>} pairs [projected, measured]
 * @returns {number | null}
 */
function rankAgreement(pairs) {
	if (pairs.length < MIN_RANKED_CONFIGS) return null;
	const projected = averageRanks(pairs.map(([value]) => value));
	const measured = averageRanks(pairs.map(([, value]) => value));
	const n = pairs.length;
	const meanA = projected.reduce((sum, value) => sum + value, 0) / n;
	const meanB = measured.reduce((sum, value) => sum + value, 0) / n;
	let covariance = 0;
	let varianceA = 0;
	let varianceB = 0;
	for (let at = 0; at < n; at += 1) {
		const da = projected[at] - meanA;
		const db = measured[at] - meanB;
		covariance += da * db;
		varianceA += da * da;
		varianceB += db * db;
	}
	// A column with no spread (every config priced or measured the same) has
	// no ordering to compare, so this is "cannot tell", never "agrees".
	if (varianceA <= 0 || varianceB <= 0) return null;
	return covariance / Math.sqrt(varianceA * varianceB);
}

/** 1-based ranks with ties averaged, so an equal-cost group shares its rank. */
function averageRanks(values) {
	const order = values
		.map((value, position) => [value, position])
		.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
	const ranks = Array.from({ length: values.length });
	let at = 0;
	while (at < order.length) {
		let end = at;
		while (end + 1 < order.length && order[end + 1][0] === order[at][0])
			end += 1;
		const rank = (at + end) / 2 + 1;
		for (let slot = at; slot <= end; slot += 1) ranks[order[slot][1]] = rank;
		at = end + 1;
	}
	return ranks;
}

/**
 * The one line a shard prints about its own share of the measured work.
 *
 * The projected balance is computed from `scripts/tla-model-costs.json`, so it
 * is 1.00x BY CONSTRUCTION: it can never reveal drift in that table. The
 * second half is therefore the part that tests the table, and it reports two
 * independent things about this run's own seconds:
 *
 *  - the ratio between what this shard spent and what the table projected for
 *    its configs, printed as an ADVISORY number. It is not a drift verdict: on
 *    the partition's first live run (39435284236) the four shards sat at
 *    0.64x / 1.14x / 1.05x / 1.03x of a table generated the day before, so a
 *    band tight enough to be worth printing fires on a healthy run (V1).
 *  - the rank agreement between the table's ordering and this run's, which is
 *    scale-free and IS the verdict (`MODEL_COST_RANK_TOLERANCE`). The same run
 *    scored 0.865-0.889 on every shard; a table whose rows no longer describe
 *    the run scores near zero.
 *
 * @param {{ configs: string[], total: number, costs: { root: string, files: Record<string, number>, max: number }, observed?: Map<string, number> | Record<string, number> | null, rankTolerance?: number }} args
 * `observed` maps the cost table's keys (`modelCostId`) to the seconds this run
 * measured for that config; absent means "no measurement to compare", and the
 * line then says only that the projection is a projection.
 */
export function formatShardBalance({
	configs,
	total,
	costs,
	observed = null,
	rankTolerance = MODEL_COST_RANK_TOLERANCE,
}) {
	const all = listModelConfigs(costs.root);
	const { items, assignment } = packShards(all, total, costs);
	const { loads, files } = shardLoads(items, assignment, total);
	const unmeasured = all.filter(
		(config) => !(modelCostId(costs.root, config) in costs.files),
	);
	const hereLoad = items
		.filter((item) => configs.includes(item.id))
		.reduce((sum, item) => sum + item.cost, 0);
	const heaviest = Math.max(...loads);
	const lightest = Math.min(...loads);
	const shards = loads
		.map((load, at) => `${files[at]} configs/${load.toFixed(0)}s`)
		.join(", ");
	const headline =
		`this shard: ${configs.length} configs, ${hereLoad.toFixed(1)}s projected from ${MODEL_COSTS_FILE}; ` +
		`all shards (projected, so 1.00x says nothing about this run): ${shards}; ` +
		`heaviest/lightest = ${(heaviest / Math.max(1, lightest)).toFixed(2)}x`;
	return (
		headline +
		describeRunAgainstTable({ configs, costs, observed, rankTolerance }) +
		(unmeasured.length === 0
			? ""
			: `; ${unmeasured.length} config(s) have no row in ${MODEL_COSTS_FILE} and cost the table max -- rerun scripts/gen-tla-model-costs.mjs`)
	);
}

/** `observed` as a `modelCostId` -> seconds reader, or null. */
function observedSecondsReader(observed) {
	if (!observed) return null;
	if (typeof observed.get === "function")
		return (id) => observed.get(id) ?? null;
	return (id) => (id in observed ? observed[id] : null);
}

/**
 * The "this run" half of the balance line. Only configs the table prices are
 * compared -- an unmeasured config is priced at the table maximum on purpose,
 * so a comparison against it would measure that fallback and not the table.
 *
 * The summed ratio is reported, then the rank agreement decides. See
 * `MODEL_COST_RANK_TOLERANCE` for why one shard's ratio cannot be the verdict
 * and why the ordering can.
 */
function describeRunAgainstTable({ configs, costs, observed, rankTolerance }) {
	const read = observedSecondsReader(observed);
	const unavailable =
		"; this run's own seconds unavailable, so the table's projection above is unverified";
	if (read === null) return unavailable;
	let measured = 0;
	let compared = 0;
	let projectedCompared = 0;
	const pairs = [];
	for (const config of configs) {
		const id = modelCostId(costs.root, config);
		if (!(id in costs.files)) continue;
		const seconds = read(id);
		if (seconds === null) continue;
		measured += seconds;
		projectedCompared += costs.files[id];
		compared += 1;
		pairs.push([costs.files[id], seconds]);
	}
	if (compared === 0) return unavailable;
	const ratio = measured / Math.max(1e-9, projectedCompared);
	const text = `; this run measured ${measured.toFixed(1)}s for ${compared} of them (${ratio.toFixed(2)}x the table's ${projectedCompared.toFixed(1)}s -- one shard's own ratio, so it moves with this runner as well as with the table)`;
	const agreement = rankAgreement(pairs);
	if (agreement === null)
		return `${text}; too few priced configs (${compared}) to compare the table's ordering with this run, so the table is unverified here`;
	const scored = `rank agreement ${agreement.toFixed(2)} over ${compared} configs`;
	return agreement < rankTolerance
		? `${text} -- COST-TABLE DRIFT: the table's ordering no longer describes this run (${scored}, outside the ${rankTolerance.toFixed(2)} tolerance), so balance it with a fresh measurement (scripts/gen-tla-model-costs.mjs) rather than trusting the projection`
		: `${text}; the table's ordering still describes this run (${scored}, inside the ${rankTolerance.toFixed(2)} tolerance)`;
}

const CLI_OPTIONS = Object.freeze({
	jar: { type: "string" },
	concurrency: { type: "string" },
	shard: { type: "string" },
});

/**
 * Parse the checker's flags strictly. Every flag takes a value, so the
 * `--shard 1/4` and `--shard=1/4` forms are equivalent; `node:util`'s parser
 * handles both, leaving no second spelling to drift. `strict` rejects an
 * unknown flag, a missing value, and a positional argument, each by throwing.
 * `main()` calls this before the network or a JVM starts, so a typo can never
 * silently fall through to the full, unsharded population (#3920).
 */
export function parseCliArgs(argv) {
	const { values } = parseNodeArgs({
		args: [...argv],
		options: CLI_OPTIONS,
		strict: true,
		allowPositionals: false,
	});
	return { ...values };
}

/**
 * The configs one run covers: every `.cfg` under `formal/`, narrowed by `--shard`
 * when present. Throws on an empty selection so a shard with nothing to run
 * (more shards than configs) is loud, not a green no-op.
 */
export function selectConfigs(argv, root) {
	const { shard } = parseCliArgs(argv);
	const all = listModelConfigs(root);
	if (shard === undefined) {
		if (all.length === 0) throw new Error("no formal/*/*.cfg found");
		return all;
	}
	// The measured cost table is what makes a shard's WORK, not its config
	// COUNT, the thing the partition balances (#4672, see selectShard).
	const table = loadModelCosts(root);
	const configs = selectShard(all, parseShardArg(shard), {
		root,
		...table,
	});
	if (configs.length === 0)
		throw new Error(`--shard ${shard} selects no formal/*/*.cfg`);
	return configs;
}

/** The model costs a run loaded, or null when it ran unsharded. */
export function resolveShardCosts(argv, root) {
	const { shard } = parseCliArgs(argv);
	if (shard === undefined) return null;
	return { root, ...loadModelCosts(root) };
}

/**
 * The jar TLC runs from, as an absolute path: TLC runs with each config's
 * directory as cwd, so a relative `--jar` would not resolve there.
 */
export function resolveJarPath(jarArg, root) {
	return path.resolve(jarArg ?? path.join(root, ".cache", "tla2tools.jar"));
}

function sha256(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export async function ensureJar(jarArg, root) {
	const jar = resolveJarPath(jarArg, root);
	if (!fs.existsSync(jar)) {
		if (jarArg) throw new Error(`--jar ${jarArg} does not exist`);
		fs.mkdirSync(path.dirname(jar), { recursive: true });
		const response = await fetch(TLA_TOOLS.url);
		if (!response.ok)
			throw new Error(`download ${TLA_TOOLS.url}: HTTP ${response.status}`);
		fs.writeFileSync(jar, Buffer.from(await response.arrayBuffer()));
	}
	const actual = sha256(jar);
	if (actual !== TLA_TOOLS.sha256)
		throw new Error(
			`${jar}: sha256 ${actual}, expected ${TLA_TOOLS.sha256} (${TLA_TOOLS.release})`,
		);
	return jar;
}

/**
 * How many configs run at once. Bounded by the host's CPU count (more lanes
 * than cores only adds scheduling overhead) and by the config count itself
 * (never more lanes than there is work).
 */
export function computeConcurrency(numConfigs, availableParallelism) {
	return Math.max(1, Math.min(numConfigs, availableParallelism));
}

/**
 * Validates a user-supplied `--concurrency` value. A missing or non-numeric
 * value (`Number(undefined)` is `NaN`) must fail loudly here rather than
 * flow into the pool: `runPool`'s own `|| 1` guard would silently downgrade
 * a typo'd flag to serial execution with no warning at all.
 */
export function parseConcurrencyArg(raw) {
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1)
		throw new Error(
			`--concurrency must be an integer >= 1, got ${JSON.stringify(raw)}`,
		);
	return n;
}

/**
 * The pool size for this run: an explicit valid `--concurrency` wins; without
 * the flag, the host's parallelism and the config count bound the pool. Split
 * out of `main` (#3927) so both the absent and the explicit branch are
 * testable without a JVM or a network: `main` cannot reach this point in a
 * test because `ensureJar` downloads or reads a real jar first.
 */
export function resolveConcurrency(
	concurrencyRaw,
	numConfigs,
	availableParallelism,
) {
	return concurrencyRaw === undefined
		? computeConcurrency(numConfigs, availableParallelism)
		: parseConcurrencyArg(concurrencyRaw);
}

/**
 * The run's final summary line. Split out of `main` (#3927) so the whole-run
 * and sharded renderings are directly testable: it is the run's only
 * observable account of how many configs ran, at what shard and concurrency,
 * so a mutation here must red.
 */
export function formatSummary(configCount, shard, wallSeconds, concurrency) {
	const shardSuffix = shard === undefined ? "" : ` (shard ${shard})`;
	return `${configCount} configs${shardSuffix}, ${wallSeconds.toFixed(1)}s wall (concurrency=${concurrency}, 1 TLC worker/config).`;
}

/**
 * The `java` argv TLC runs with, as a pure function so tests need no JVM.
 * Always runs with a single TLC worker (`-workers 1`, #3517): TLC's
 * `-workers auto` explores the state graph across several threads, so a
 * model that can violate more than one invariant can report a different one
 * depending on which thread gets there first. One worker gives deterministic
 * BFS order, at no verdict cost, since TLC still explores every reachable
 * state before it can report `pass` regardless of worker count.
 *
 * `-Djava.io.tmpdir` is pinned to the run's own metadir: SANY extracts the
 * TLA+ standard modules (Naturals.tla, Sequences.tla, ...) to the JVM's temp
 * dir under a fixed name, not a unique one, so two TLC processes sharing the
 * OS temp dir can race there and one sees the other's half-written copy
 * (`tla2sany.semantic.AbortException`) — reproduced running the pool over
 * all of formal/ during this change's own development (see this PR's Tests
 * section for the stress-probe numbers). The pool makes this collision
 * likelier by running several TLC processes at once, so isolating it is
 * this change's own job, not a pre-existing risk merely inherited from the
 * CI host.
 */
export function buildJavaArgs(jar, metadir, configBasename, module) {
	return [
		`-Djava.io.tmpdir=${metadir}`,
		"-XX:+UseParallelGC",
		"-cp",
		jar,
		"tlc2.TLC",
		"-workers",
		"1",
		"-metadir",
		metadir,
		"-config",
		configBasename,
		module,
	];
}

function runTlc(jar, config, module) {
	const metadir = fs.mkdtempSync(path.join(os.tmpdir(), "tlc-"));
	const args = buildJavaArgs(jar, metadir, path.basename(config), module);
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn("java", args, { cwd: path.dirname(config) });
		} catch (error) {
			fs.rmSync(metadir, { recursive: true, force: true });
			resolve({ status: "error", detail: error.message });
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			fs.rmSync(metadir, { recursive: true, force: true });
			resolve({ status: "error", detail: error.message });
		});
		child.on("close", () => {
			fs.rmSync(metadir, { recursive: true, force: true });
			const output = `${stdout}\n${stderr}`;
			resolve({
				...classifyTlcOutput(output),
				distinctStates: parseDistinctStates(output),
			});
		});
	});
}

/**
 * Runs `task` over `items` with at most `concurrency` in flight at once,
 * returning results in input order regardless of completion order. Plain
 * async, no timers or real processes of its own, so it is unit-testable
 * with synthetic tasks (`tests/scripts/check-tla-models.test.ts`).
 */
export async function runPool(items, concurrency, task) {
	const results = Array.from({ length: items.length });
	let next = 0;
	async function lane() {
		for (;;) {
			const i = next;
			next += 1;
			if (i >= items.length) return;
			results[i] = await task(items[i], i);
		}
	}
	const lanes = Array.from(
		{ length: Math.min(concurrency, items.length) || 1 },
		lane,
	);
	await Promise.all(lanes);
	return results;
}

async function main() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const argv = process.argv.slice(2);
	// Every flag is parsed and validated before any download or JVM spawn
	// (#3920): a typo must fail loudly here, never run the full population.
	const {
		jar: jarArg,
		concurrency: concurrencyRaw,
		shard,
	} = parseCliArgs(argv);
	const configs = selectConfigs(argv, root);
	// #4672: with a shard, the run also prints how the measured work split
	// across ALL shards -- the balance is otherwise invisible until a shard
	// loses its race against `timeout-minutes` and reports `cancelled`.
	const shardCosts = resolveShardCosts(argv, root);
	// #4714: the recorded distinct-state counts gate the run whether or not it
	// is sharded, so the table is read (and refused when malformed) up front.
	const { states: recordedStates } = loadModelCosts(root);

	const availableParallelism =
		typeof os.availableParallelism === "function"
			? os.availableParallelism()
			: os.cpus().length;
	const concurrency = resolveConcurrency(
		concurrencyRaw,
		configs.length,
		availableParallelism,
	);
	const jar = await ensureJar(jarArg, root);

	const wallStarted = Date.now();
	const outcomes = await runPool(configs, concurrency, async (config) => {
		const name = path.relative(root, config);
		// The table's own key, so the balance line's drift half compares THIS
		// run's seconds against the table for the same configs (never a second
		// spelling of the key: `modelCostId` is the only one).
		const id = modelCostId(root, config);
		const header = parseModelHeader(fs.readFileSync(config, "utf8"));
		if (header.error) {
			console.log(`FAIL ${name}: ${header.error}`);
			return {
				name,
				id,
				dir: path.dirname(name),
				ok: false,
				seconds: 0,
				distinctStates: null,
			};
		}
		const started = Date.now();
		const actual = await runTlc(jar, config, header.module);
		const seconds = (Date.now() - started) / 1000;
		const ok = verdictMatches(header.expect, actual);
		const distinct =
			actual.distinctStates == null
				? ""
				: `, ${actual.distinctStates} distinct states`;
		console.log(
			`${ok ? "ok  " : "FAIL"} ${name}: expected ${describeVerdict(header.expect)}, got ${describeVerdict(actual)} (${seconds.toFixed(1)}s${distinct})`,
		);
		return {
			name,
			id,
			dir: path.dirname(name),
			ok,
			seconds,
			distinctStates: actual.distinctStates ?? null,
		};
	});
	const wallSeconds = (Date.now() - wallStarted) / 1000;

	const failures = outcomes.filter((outcome) => !outcome.ok).length;
	const jumps = stateCountJumps(outcomes, recordedStates);
	for (const jump of jumps) console.log(formatStateJump(jump));
	const unrecorded = unrecordedStateCounts(outcomes, recordedStates);
	if (unrecorded.length > 0)
		console.log(
			`${unrecorded.length} config(s) ran with no recorded distinct-state count in ${MODEL_COSTS_FILE}; their counts are reported above and do not fail the run (regenerate with scripts/gen-tla-model-costs.mjs to record them)`,
		);
	const perDir = new Map();
	for (const outcome of outcomes) {
		const totals = perDir.get(outcome.dir) ?? { seconds: 0, count: 0 };
		totals.seconds += outcome.seconds;
		totals.count += 1;
		perDir.set(outcome.dir, totals);
	}
	const dirLines = [...perDir.entries()]
		.sort((a, b) => b[1].seconds - a[1].seconds)
		.map(
			([dir, totals]) =>
				`  ${dir}: ${totals.seconds.toFixed(1)}s summed over ${totals.count} configs`,
		);
	console.log("");
	console.log(formatSummary(configs.length, shard, wallSeconds, concurrency));
	if (shard !== undefined && shardCosts) {
		const { total } = parseShardArg(shard);
		console.log(
			formatShardBalance({
				configs,
				total,
				costs: shardCosts,
				observed: new Map(
					outcomes.map((outcome) => [outcome.id, outcome.seconds]),
				),
			}),
		);
	}
	console.log("Per-directory TLC time (summed, not wall time):");
	for (const line of dirLines) console.log(line);

	if (failures > 0) {
		console.log(`${failures} of ${configs.length} models did not match.`);
		process.exitCode = 1;
	}
	if (jumps.length > 0) {
		console.log(
			`${jumps.length} model(s) grew past their recorded distinct-state count by more than ${STATE_COUNT_FACTOR}x.`,
		);
		process.exitCode = 1;
	}
}

if (isMainModule(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
