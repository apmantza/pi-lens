#!/usr/bin/env node
/**
 * scripts/gen-test-shard-weights.mjs (#3771, #3801, #5182)
 *
 *   node scripts/gen-test-shard-weights.mjs --run <dir> [--run <dir> ...] [--out <file>]
 *   node scripts/gen-test-shard-weights.mjs --journal <test-daily.ndjson> [--days <n>] [--out <file>]
 *
 * Regenerates scripts/test-shard-weights.json, the per-file seconds the
 * duration-balanced shard assignment (scripts/lib/test-shard-assignment.mjs)
 * packs by. Two inputs, mutually exclusive:
 *
 * --run: each directory holds the `vitest-results.json` files of ONE CI run
 * (`gh run download <run-id> -p 'unit-test-results-linux-shard-*' -D <dir>`).
 * A file's weight is the median of its per-run durations.
 *
 * --journal (no GitHub API needed): the nightly rollup's `test-daily.ndjson`,
 * `git fetch <remote> data/test-history` then
 * `git show FETCH_HEAD:history/test-daily.ndjson > <file>`. Takes the newest
 * `--days` (default 5) `linux` records; a file's weight is the median over
 * those days of `durationMs / runs / 1000` (days with `runs: 0` skipped).
 *
 * Keys are repo-relative posix paths under `tests/` and the output is sorted,
 * so regenerating from the same input is byte-identical.
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
	return filesFromSamples(samples);
}

/**
 * @param {Map<string, number[]>} samples seconds per file id
 * @returns {Record<string, number>} median seconds, rounded, keys sorted
 */
function filesFromSamples(samples) {
	const files = {};
	for (const id of [...samples.keys()].sort((a, b) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		files[id] = Math.round(median(samples.get(id)) * 100) / 100;
	}
	return files;
}

const DEFAULT_JOURNAL_DAYS = 5;

/**
 * Weights from the nightly test-history journal (`history/test-daily.ndjson`).
 * `durationMs` there sums a file's runs that day, so the day's seconds are
 * `durationMs / runs / 1000`.
 *
 * @param {Array<string | object>} lines NDJSON lines or parsed records
 * @param {number} days how many newest linux records to use
 * @returns {{ files: Record<string, number>, days: string[] }}
 */
export function buildWeightsFromJournal(lines, days) {
	if (!Number.isInteger(days) || days < 1)
		throw new Error(`--days must be a positive integer, got ${days}`);
	/** @type {Array<{ record: any, at: number }>} */
	const records = [];
	lines.forEach((line, i) => {
		if (typeof line !== "string")
			return records.push({ record: line, at: i + 1 });
		if (line.trim() === "") return;
		try {
			records.push({ record: JSON.parse(line), at: i + 1 });
		} catch (err) {
			throw new Error(`journal line ${i + 1} is not JSON: ${err.message}`);
		}
	});
	const linux = records.filter((r) => r.record && r.record.lane === "linux");
	for (const { record, at } of linux) {
		if (typeof record.day !== "string")
			throw new Error(`journal record ${at} (linux) has no string day`);
	}
	const newest = linux
		.map((r) => r.record)
		.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
		.slice(-days);
	if (newest.length === 0) throw new Error("journal has no linux record");
	/** @type {Map<string, number[]>} */
	const samples = new Map();
	for (const record of newest) {
		for (const [id, stat] of Object.entries(record.tests ?? {})) {
			if (!id.startsWith("tests/") || stat?.runs === 0) continue;
			if (!(stat?.runs > 0) || !Number.isFinite(stat.durationMs))
				throw new Error(
					`journal day ${record.day}: ${id} has a non-finite duration`,
				);
			const list = samples.get(id) ?? [];
			list.push(stat.durationMs / stat.runs / 1000);
			samples.set(id, list);
		}
	}
	// Same rule as the --run path: no durations is an error, never a snapshot
	// that prices every file at a zero median. Here, not in main, so a direct
	// caller and the CLI get it once, before anything is written.
	if (samples.size === 0)
		throw new Error(
			`journal's newest ${newest.length} linux day(s) hold no test durations`,
		);
	return {
		files: filesFromSamples(samples),
		days: newest.map((r) => r.day),
	};
}

export function main(argv) {
	const runDirs = [];
	let journal = null;
	let days = DEFAULT_JOURNAL_DAYS;
	let out = "scripts/test-shard-weights.json";
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--run") runDirs.push(argv[++i]);
		else if (argv[i] === "--journal") journal = argv[++i];
		else if (argv[i] === "--days") days = Number(argv[++i]);
		else if (argv[i] === "--out") out = argv[++i];
		else throw new Error(`unknown argument ${argv[i]}`);
	}
	if (journal !== null && runDirs.length > 0)
		throw new Error("--journal and --run are mutually exclusive");
	let body;
	if (journal !== null) {
		if (!Number.isInteger(days) || days < 1)
			throw new Error(`--days must be a positive integer, got ${days}`);
		let text;
		try {
			text = fs.readFileSync(journal, "utf8");
		} catch (err) {
			throw new Error(`cannot read journal ${journal}: ${err.message}`);
		}
		const built = buildWeightsFromJournal(text.split("\n"), days);
		// `runs` counts the days sampled here (one sample per file per day).
		body = {
			generatedBy: "node scripts/gen-test-shard-weights.mjs --journal",
			runs: built.days.length,
			days: built.days,
			files: built.files,
		};
	} else {
		if (runDirs.length === 0)
			throw new Error("--run <dir> or --journal <file> is required");
		const files = buildWeights(runDirs);
		if (Object.keys(files).length === 0)
			throw new Error(
				"no vitest-results.json found under the --run directories",
			);
		body = {
			generatedBy: "node scripts/gen-test-shard-weights.mjs",
			runs: runDirs.length,
			files,
		};
	}
	fs.writeFileSync(out, `${JSON.stringify(body, null, "\t")}\n`);
	console.log(
		`${out}: ${Object.keys(body.files).length} files from ${body.runs} ${journal !== null ? "days" : "runs"}`,
	);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
