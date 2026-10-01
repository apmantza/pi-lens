/**
 * scripts/lib/balanced-shard-sequencer.mjs (#3771, #3801)
 *
 * vitest's `sequence.sequencer` hook: only `shard()` is overridden (the file
 * order inside a shard stays vitest's own `sort()`, so `groupOrder` phases and
 * failed-first ordering are untouched). `--shard=k/N` keeps the spec set
 * vitest already resolved across ALL projects and hands shard k its LPT
 * slice from scripts/lib/test-shard-assignment.mjs. The assignment is
 * recomputed, never communicated, by each of the N shard jobs.
 */

import path from "node:path";
import { BaseSequencer } from "vitest/node";
import {
	assignShards,
	loadShardWeights,
	projectWorkers,
	SHARD_WEIGHTS_FILE,
	shardLoads,
	specCost,
} from "./test-shard-assignment.mjs";

/** Repo-relative posix path, the key of the weights snapshot. */
function relativeId(root, moduleId) {
	return path.relative(root, moduleId).split(path.sep).join("/");
}

export class BalancedShardSequencer extends BaseSequencer {
	async shard(files) {
		const { config } = this.ctx;
		const { index, count } = config.shard;
		const weights = loadShardWeights(
			path.resolve(config.root, SHARD_WEIGHTS_FILE),
		);
		let unmodeled = 0;
		const items = files.map((spec) => {
			const rel = relativeId(config.root, spec.moduleId);
			const known = weights.files[rel];
			if (known === undefined) unmodeled += 1;
			return {
				id: rel,
				cost: specCost(
					known ?? weights.median,
					projectWorkers(spec.project?.name),
				),
				spec,
			};
		});
		const assignment = assignShards(items, count);
		const { loads, files: counts } = shardLoads(items, assignment, count);
		const mean = loads.reduce((sum, load) => sum + load, 0) / count;
		this.ctx.logger?.log?.(
			`[shard-balance] shard ${index}/${count}: ${counts[index - 1]} of ${files.length} files, planned ${loads[index - 1].toFixed(0)}s against a ${mean.toFixed(0)}s mean (slowest shard ${Math.max(...loads).toFixed(0)}s, ${unmodeled} files without a recorded duration)`,
		);
		return items
			.filter((item) => assignment.get(item.id) === index)
			.map((item) => item.spec);
	}
}
