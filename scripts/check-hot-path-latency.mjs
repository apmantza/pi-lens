#!/usr/bin/env node
/**
 * Hot-path latency regression gate (#4363).
 *
 *   node scripts/check-hot-path-latency.mjs --base <built-tree> --head <built-tree>
 *     [--runs 15] [--budget-ms 600000] [--scratch <dir>] [--json <file>]
 *
 * Times the hot paths of `scripts/hot-path-sample.mjs` N times on each of two
 * built checkouts (`npm run build` in each) and decides with a bootstrapped
 * confidence interval (`scripts/lib/latency-stats.mjs`, which states the
 * rule). The runs alternate base, head / head, base, one fresh process each,
 * so a slow stretch of the host lands on both trees alike. One extra pair runs
 * first and is dropped: it pays the cold file cache for both.
 *
 * Exit 0: no metric regressed. 1: at least one metric regressed. 2: the
 * harness could not take a sample (a broken checkout is not a latency verdict).
 *
 * The CI lane is `.github/workflows/hot-path-latency.yml`. A markdown table of
 * the result is also appended to `$GITHUB_STEP_SUMMARY` when it is set.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	bootstrapCompare,
	DEFAULT_CONFIDENCE,
	DEFAULT_THRESHOLD,
	judge,
} from "./lib/latency-stats.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const SAMPLER = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"hot-path-sample.mjs",
);
// A sample takes about 2.5 s. 60 s per sample and 10 min for the whole lane keep
// a hung checkout well under the workflow's 20 min `timeout-minutes`.
const SAMPLE_TIMEOUT_MS = 60_000;
export const DEFAULT_BUDGET_MS = 600_000;
export const DEFAULT_RUNS = 15;

/** Take one sample of `tree` in a fresh process. Throws on any failure. */
export function runSampleProcess(tree, scratch) {
	fs.rmSync(scratch, { recursive: true, force: true });
	fs.mkdirSync(scratch, { recursive: true });
	const child = spawnSync(
		process.execPath,
		[SAMPLER, "--tree", tree, "--scratch", scratch],
		{ encoding: "utf8", timeout: SAMPLE_TIMEOUT_MS },
	);
	fs.rmSync(scratch, { recursive: true, force: true });
	if (child.status !== 0) {
		const why =
			child.error?.message ??
			child.stderr.trim().split("\n").slice(-5).join("\n");
		throw new Error(`sample of ${tree} failed (exit ${child.status}): ${why}`);
	}
	const lastLine = child.stdout.trim().split("\n").at(-1) ?? "";
	return JSON.parse(lastLine);
}

/**
 * Collect `runs` interleaved samples per tree, after one dropped warm-up pair.
 * `takeSample(label, tree, index)` returns `{ metric: ms }`. Throws when
 * `now()` passes `deadline`: a lane that cannot finish is a harness failure,
 * not a verdict.
 */
export function collectSamples({
	base,
	head,
	runs,
	takeSample,
	now = Date.now,
	deadline = Number.POSITIVE_INFINITY,
}) {
	const trees = { base, head };
	const samples = { base: [], head: [] };
	for (let i = -1; i < runs; i++) {
		const order = i % 2 === 0 ? ["head", "base"] : ["base", "head"];
		for (const label of order) {
			if (now() > deadline) {
				throw new Error(
					`time budget spent after ${samples.head.length} of ${runs} runs`,
				);
			}
			const sample = takeSample(label, trees[label], i);
			if (i >= 0) samples[label].push(sample);
		}
	}
	return samples;
}

/** One verdict row per metric, from the collected samples. */
export function evaluate(samples, threshold = DEFAULT_THRESHOLD) {
	const metrics = Object.keys(samples.base[0] ?? {});
	if (metrics.length === 0) throw new Error("no metrics in the samples");
	return metrics.map((metric) => {
		const column = (label) =>
			samples[label].map((s) => {
				const v = s[metric];
				if (typeof v !== "number" || !Number.isFinite(v)) {
					throw new Error(`${label} sample lacks a finite ${metric}`);
				}
				return v;
			});
		const comparison = bootstrapCompare(column("base"), column("head"));
		return Object.assign({ metric }, comparison, judge(comparison, threshold));
	});
}

const ms = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
const signed = (n) => `${n >= 0 ? "+" : ""}${ms(n)}`;

export function renderReport(rows, { runs, threshold = DEFAULT_THRESHOLD }) {
	const pct = Math.round(DEFAULT_CONFIDENCE * 100);
	const lines = [
		`Hot-path latency: ${runs} runs per tree, interleaved, ${pct}% bootstrap interval.`,
		`A metric fails when its head median is at least ${threshold.minRatio}x the base median and at least ${threshold.minDiffMs} ms slower, and the interval of the difference excludes zero.`,
		"",
		"| metric | base ms | head ms | diff ms [interval] | ratio [interval] | verdict |",
		"| --- | ---: | ---: | --- | --- | --- |",
	];
	for (const r of rows) {
		const verdict = r.regression
			? "REGRESSION"
			: r.significant
				? "slower, below threshold"
				: "ok";
		lines.push(
			`| ${r.metric} | ${ms(r.baseMedian)} | ${ms(r.headMedian)} | ${signed(r.diff.point)} [${signed(r.diff.lo)}, ${signed(r.diff.hi)}] | ${r.ratio.point.toFixed(2)} [${r.ratio.lo.toFixed(2)}, ${r.ratio.hi.toFixed(2)}] | ${verdict} |`,
		);
	}
	return lines.join("\n");
}

function argValue(argv, name) {
	const at = argv.indexOf(`--${name}`);
	return at >= 0 ? argv[at + 1] : undefined;
}

export function main(argv, io = {}) {
	const log = io.log ?? ((line) => process.stdout.write(`${line}\n`));
	const takeSampleProcess = io.takeSample;
	const base = argValue(argv, "base");
	const head = argValue(argv, "head");
	const runs = Number(argValue(argv, "runs") ?? DEFAULT_RUNS);
	if (!base || !head || !Number.isInteger(runs) || runs < 5) {
		log(
			"usage: check-hot-path-latency.mjs --base <dir> --head <dir> [--runs N>=5] [--scratch <dir>] [--json <file>]",
		);
		return 2;
	}
	const scratchRoot = path.resolve(
		argValue(argv, "scratch") ?? "hot-path-latency-scratch",
	);
	const takeSample =
		takeSampleProcess ??
		((label, tree, index) =>
			runSampleProcess(
				path.resolve(tree),
				path.join(scratchRoot, `${label}-${index}`),
			));
	let rows;
	try {
		const now = io.now ?? Date.now;
		const budgetMs = Number(argValue(argv, "budget-ms") ?? DEFAULT_BUDGET_MS);
		rows = evaluate(
			collectSamples({
				base,
				head,
				runs,
				takeSample,
				now,
				deadline: now() + budgetMs,
			}),
		);
	} catch (error) {
		log(
			`hot-path latency: harness failure: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 2;
	}
	const report = renderReport(rows, { runs });
	log(report);
	const jsonOut = argValue(argv, "json");
	if (jsonOut)
		fs.writeFileSync(jsonOut, `${JSON.stringify({ runs, rows }, null, 2)}\n`);
	const summaryFile = io.summaryFile ?? process.env.GITHUB_STEP_SUMMARY;
	if (summaryFile) fs.appendFileSync(summaryFile, `${report}\n`);
	const regressed = rows.filter((r) => r.regression).map((r) => r.metric);
	log(
		regressed.length > 0
			? `hot-path latency: REGRESSION in ${regressed.join(", ")}`
			: "hot-path latency: no regression",
	);
	return regressed.length > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
	process.exit(main(process.argv.slice(2)));
}
