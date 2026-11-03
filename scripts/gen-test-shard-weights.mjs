#!/usr/bin/env node
/**
 * scripts/gen-test-shard-weights.mjs (#3771, #3801)
 *
 *   node scripts/gen-test-shard-weights.mjs --run <dir> [--run <dir> ...] [--out <file>]
 *
 * Regenerates scripts/test-shard-weights.json, the per-file seconds the
 * duration-balanced shard assignment (scripts/lib/test-shard-assignment.mjs)
 * packs by. Each `--run` is a directory holding the `vitest-results.json`
 * files of ONE CI run (download them with
 * `gh run download <run-id> -p 'unit-test-results-linux-shard-*' -D <dir>`;
 * the shards' artifacts are the same JSON the nightly test-history rollup
 * reads). A file's weight is the median of its per-run durations, so one slow
 * runner does not skew it. Keys are repo-relative posix paths and the output
 * is sorted, so regenerating from the same runs is byte-identical.
 */

import fs from "node:fs";
import { rowsFromArtifacts } from "./test-history-rollup.mjs";
import { median } from "./lib/test-shard-assignment.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

/**
 * The artifact walk and the per-file duration rule are the nightly test-history
 * rollup's (`rowsFromArtifacts`), so a report shape that rollup reads is read
 * here identically. Each run directory holds the shards' `vitest-results.json`
 * and `test-history-metadata.json` (what `gh run download` produces).
 *
 * @param {string[]} runDirs one directory per CI run
 * @returns {Record<string, number>}
 */
export function buildWeights(runDirs) {
	/** @type {Map<string, number[]>} */
	const samples = new Map();
	for (const dir of runDirs) {
		/** @type {Map<string, number>} */
		const thisRun = new Map();
		for (const row of rowsFromArtifacts([dir])) {
			// `row.file` is already the journal's repo-relative id (#3367); a name
			// outside `tests/` is not a test file and carries no weight.
			if (row.file.startsWith("tests/"))
				thisRun.set(row.file, row.durationMs / 1000);
		}
		for (const [id, seconds] of thisRun) {
			const list = samples.get(id) ?? [];
			list.push(seconds);
			samples.set(id, list);
		}
	}
	const files = {};
	for (const id of [...samples.keys()].sort((a, b) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		files[id] = Math.round(median(samples.get(id)) * 100) / 100;
	}
	return files;
}

function main(argv) {
	const runDirs = [];
	let out = "scripts/test-shard-weights.json";
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--run") runDirs.push(argv[++i]);
		else if (argv[i] === "--out") out = argv[++i];
		else throw new Error(`unknown argument ${argv[i]}`);
	}
	if (runDirs.length === 0)
		throw new Error("at least one --run <dir> is required");
	const files = buildWeights(runDirs);
	if (Object.keys(files).length === 0)
		throw new Error("no vitest-results.json found under the --run directories");
	const body = {
		generatedBy: "node scripts/gen-test-shard-weights.mjs",
		runs: runDirs.length,
		files,
	};
	fs.writeFileSync(out, `${JSON.stringify(body, null, "\t")}\n`);
	console.log(
		`${out}: ${Object.keys(files).length} files from ${runDirs.length} runs`,
	);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
