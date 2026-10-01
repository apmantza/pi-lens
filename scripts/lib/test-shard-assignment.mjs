/**
 * scripts/lib/test-shard-assignment.mjs (#3771, #3801)
 *
 * The duration-balanced Unit tests shard assignment. vitest's own `--shard=k/N`
 * sorts spec paths by sha1 and cuts equal FILE COUNTS, so the five shards of
 * #3756 ran 107 s to 252 s of `Run tests` (2.3x). This module replaces the cut
 * with a longest-processing-time-first (LPT) greedy pack over measured
 * per-file seconds.
 *
 * EVERY shard job computes the whole assignment independently and keeps its
 * own slice, so the function must be a pure, order-independent function of
 * (items, count): two shards that disagree on one file run it twice or nowhere.
 * `assignShards` therefore sorts by (cost desc, id asc) itself and breaks load
 * ties toward the lowest shard index; it never depends on input order.
 *
 * The per-file seconds live in scripts/test-shard-weights.json, a generated
 * snapshot (scripts/gen-test-shard-weights.mjs, from the vitest JSON reports
 * the shards already upload). A file the snapshot does not know costs the
 * snapshot's median, so a new file never needs a config edit to land in
 * exactly one shard; only its balance waits for the next regeneration.
 */

import fs from "node:fs";

export const SHARD_WEIGHTS_FILE = "scripts/test-shard-weights.json";

/**
 * @param {string} filePath absolute path of the weights snapshot
 * @returns {{ files: Record<string, number>, median: number }}
 */
export function loadShardWeights(filePath) {
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		// Loud on purpose: every shard reads the same checkout, so a missing or
		// malformed snapshot is a repository defect, never a per-shard accident.
		throw new Error(
			`test shard weights unreadable at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const files = parsed?.files;
	if (!files || typeof files !== "object" || Array.isArray(files)) {
		throw new Error(`test shard weights at ${filePath} have no "files" object`);
	}
	const seconds = [];
	for (const [id, value] of Object.entries(files)) {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new Error(
				`test shard weights at ${filePath}: "${id}" is not a finite non-negative number`,
			);
		}
		seconds.push(value);
	}
	return { files, median: median(seconds) };
}

/** @param {number[]} values */
export function median(values) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Parallelism each vitest project runs with on the CI runner the snapshot was
 * measured on (4 vCPU: `scripts/lib/worker-budget.mjs` gives `maxWorkers` 3 and
 * `heavyMaxWorkers` 1; `timing-sensitive` is a literal 2). Keyed by project NAME,
 * never read from the host: every shard job recomputes the whole assignment, and
 * a divisor taken from `os.availableParallelism()` made two shard hosts of
 * different shapes disagree, so a file ran twice or nowhere (review r1 F4).
 * A project not listed is serialized (`maxWorkers: 1`): grammar-heavy,
 * lsp-spawn-heavy, real-harness, wall-clock-budget, tmp-fixture-hygiene.
 * tests/config/test-shard-assignment.test.ts pins this table to the config.
 */
export const PROJECT_PARALLELISM = Object.freeze({
	default: 3,
	"timing-sensitive": 2,
});

/** @param {unknown} projectName a vitest project's name */
export function projectWorkers(projectName) {
	return PROJECT_PARALLELISM[String(projectName ?? "")] ?? 1;
}

/**
 * Model cost of one spec: its measured seconds divided by the parallelism its
 * project runs with, because a shard's phases run one after another and a
 * `maxWorkers: 3` phase takes about a third of its summed file time while a
 * `maxWorkers: 1` (serialized) phase takes all of it.
 *
 * @param {number} seconds
 * @param {number} workers a project's parallelism (see `projectWorkers`)
 */
export function specCost(seconds, workers) {
	return seconds / Math.max(1, workers);
}

/**
 * Deterministic LPT pack. Returns shard index (1-based) per item id.
 *
 * @param {Array<{ id: string, cost: number }>} items
 * @param {number} count shard count (>= 1)
 * @returns {Map<string, number>}
 */
export function assignShards(items, count) {
	if (!Number.isInteger(count) || count < 1) {
		throw new Error(`shard count must be a positive integer, got ${count}`);
	}
	const ordered = [...items].sort(
		(a, b) => b.cost - a.cost || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	const loads = Array.from({ length: count }, () => 0);
	const assignment = new Map();
	for (const item of ordered) {
		let lightest = 0;
		for (let shard = 1; shard < count; shard += 1) {
			if (loads[shard] < loads[lightest]) lightest = shard;
		}
		loads[lightest] += item.cost;
		assignment.set(item.id, lightest + 1);
	}
	return assignment;
}

/**
 * Per-shard summary for the one log line each shard prints.
 *
 * @param {Array<{ id: string, cost: number }>} items
 * @param {Map<string, number>} assignment
 * @param {number} count
 */
export function shardLoads(items, assignment, count) {
	const loads = Array.from({ length: count }, () => 0);
	const files = Array.from({ length: count }, () => 0);
	for (const item of items) {
		const shard = assignment.get(item.id);
		loads[shard - 1] += item.cost;
		files[shard - 1] += 1;
	}
	return { loads, files };
}
