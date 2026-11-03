#!/usr/bin/env node
/**
 * Nightly verdict on the project-snapshot persist bench (#3916, recurrence of
 * #3789): did the worker persist's RSS jump drift back toward the cloned shape?
 *
 *   node scripts/bench-snapshot-persist.mjs --persists 1 --out <report-N.json>   (x5)
 *   node scripts/check-snapshot-persist-ratio.mjs --report <report-1.json> ... \
 *     --report <report-5.json> [--body <issue.md>] [--state <file>] [--run-url <url>]
 *
 * One sample is the first persist's RSS jump in worker mode divided by the
 * same persist in sync mode, both from ONE bench invocation on ONE runner, so
 * the runner's allocator and heap limits mostly cancel. The verdict compares
 * the MEDIAN of SAMPLE_COUNT samples with the threshold: the one hosted sample
 * taken first (1.822) sat at the dev box's healthy ceiling (1.831), and a
 * single noisy persist must not flip a nightly either way. Samples are
 * independent bench invocations (each spawns a fresh child process, so a fresh
 * worker and heap, per mode), never later persists of one child.
 *
 * Persist 0 is the sample, not a steady-state max or median: after the first
 * persist the settled-RSS baseline moves with GC timing. The cloning worker's
 * steady runs fell from about 285 MB to about 155 MB mid-run (a median can
 * land on either side), and the fixed worker spiked once to 146-149 MB in 2 of
 * 8 healthy runs (a max can land on the wrong side). Persist 0 separated the
 * trees in every measured local run: 1.688-1.831 on the fixed tree (11 runs),
 * 2.099-2.369 on the cloning tree (9 runs); see
 * tests/fixtures/snapshot-persist-nightly-calibration.json and
 * tests/fixtures/snapshot-persist-measurement.json, pinned by
 * tests/scripts/check-snapshot-persist-ratio.test.ts. Known limit: the
 * control is the same tree's own sync path, which the cloning tree also made
 * heavier (about 150-166 MB against 92-101 MB), so the ratio understates the
 * worker's own regression; that is why the gap is only 1.83 to 2.10.
 *
 * Exit 0 clean, 1 drift (the median exceeds the threshold), 2 a report is
 * unusable or fewer than SAMPLE_COUNT were given (never a drift verdict, but
 * the workflow files the tracking issue with the reason). `--state` receives
 * `clean`, `drift` or `error`; `--body` is written for drift and error and
 * removed on clean.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isMainModule } from "./lib/is-main-module.mjs";

/**
 * PROVISIONAL drift threshold on the median of SAMPLE_COUNT first-persist
 * ratios. It is the geometric midpoint (1.96) of the gap between the worst
 * healthy run (1.831) and the best cloning-tree run (2.099), both measured on a
 * 32-CPU dev box, rounded down: +6.5% above the worst healthy run, -7.1% below
 * the best regressed one. The only hosted measurement before round 2 was one
 * sample at 1.822. It is re-calibrated against the hosted nightly medians after
 * HOSTED_NIGHTS_BEFORE_RECALIBRATION nights (the tracking-issue body says so).
 */
export const DRIFT_THRESHOLD = 1.95;
export const SAMPLE_COUNT = 5;
export const HOSTED_NIGHTS_BEFORE_RECALIBRATION = 7;

/**
 * @param {unknown} report one `bench-snapshot-persist.mjs` JSON report
 * @returns {{workerMB: number, syncMB: number, ratio: number}}
 */
export function firstPersistRatio(report) {
	const results = Array.isArray(report?.results) ? report.results : [];
	const jump = (mode) => {
		const run = results
			.find((result) => result?.mode === mode)
			?.runs?.find((candidate) => candidate?.persist === 0);
		const value = run?.rssJumpMB;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			throw new Error(`report has no usable persist 0 rssJumpMB for ${mode}`);
		}
		return value;
	};
	const workerMB = jump("worker");
	const syncMB = jump("sync");
	return { workerMB, syncMB, ratio: workerMB / syncMB };
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {unknown[]} reports one bench report per independent sample
 * @param {{threshold?: number, samples?: number}} [options]
 * @returns {{state: "clean" | "drift" | "error", threshold: number, samples?: {workerMB: number, syncMB: number, ratio: number}[], median?: number, min?: number, max?: number, reason?: string}}
 */
export function evaluate(
	reports,
	{ threshold = DRIFT_THRESHOLD, samples: required = SAMPLE_COUNT } = {},
) {
	try {
		if (!Array.isArray(reports) || reports.length < required) {
			throw new Error(
				`need ${required} independent bench reports, got ${Array.isArray(reports) ? reports.length : 0}`,
			);
		}
		const samples = reports.map((report, index) => {
			try {
				return firstPersistRatio(report);
			} catch (error) {
				throw new Error(`sample ${index + 1}: ${error?.message ?? error}`);
			}
		});
		const ratios = samples.map((sample) => sample.ratio);
		const mid = median(ratios);
		return {
			state: mid > threshold ? "drift" : "clean",
			threshold,
			samples,
			median: mid,
			min: Math.min(...ratios),
			max: Math.max(...ratios),
		};
	} catch (error) {
		return {
			state: "error",
			threshold,
			reason: error?.message ?? String(error),
		};
	}
}

const fmt = (value) => value.toFixed(3);

/** Markdown body for the single persistent tracking issue (drift or error). */
export function buildIssueBody(verdict, { runUrl, report } = {}) {
	const lines = [
		"Auto-filed/updated by the nightly `tool-smoke` workflow's `snapshot-persist-bench` job (#3916, recurrence of #3789).",
		"",
	];
	if (verdict.state === "error") {
		lines.push(
			`**The snapshot-persist measurement was unusable tonight, so no drift verdict was made.** Reason: ${verdict.reason}`,
			"",
			"Likely causes: the bench crashed or timed out, or its report shape changed (`scripts/bench-snapshot-persist.mjs`). Reproduce with `npm run build && node scripts/bench-snapshot-persist.mjs --persists 1`.",
		);
	} else {
		const ratios = verdict.samples.map((s) => fmt(s.ratio)).join(", ");
		lines.push(
			`Tonight's median worker/sync first-persist RSS ratio over ${verdict.samples.length} independent samples is **${fmt(verdict.median)}** (min ${fmt(verdict.min)}, max ${fmt(verdict.max)}; samples ${ratios}), over the threshold **${verdict.threshold}** (\`DRIFT_THRESHOLD\` in \`scripts/check-snapshot-persist-ratio.mjs\`). Locally a healthy tree measured 1.69-1.83 and the tree that structured-cloned the snapshot into the worker (4.3.0) measured 2.10-2.37; the one hosted sample taken before this check was 1.822.`,
			"",
			"A likely cause is a change that puts a clone or a second serialization back on the worker persist path (`clients/project-snapshot.ts`, `clients/gzip-stage-write.ts`). Reproduce with `npm run build && node scripts/bench-snapshot-persist.mjs --persists 1`.",
		);
	}
	lines.push(
		"",
		`**The threshold is PROVISIONAL.** It was calibrated on a 32-CPU dev box plus one hosted sample, and is re-calibrated after ${HOSTED_NIGHTS_BEFORE_RECALIBRATION} hosted nights. Each night's median, min and max are in the \`snapshot-persist ratio:\` log line and the step summary of the \`snapshot-persist-bench\` job.`,
	);
	if (report?.node || report?.platform) {
		lines.push(
			"",
			`Runner: ${report.node ?? "?"} on ${report.platform ?? "?"}`,
		);
	}
	if (runUrl) lines.push("", `Workflow run: ${runUrl}`);
	lines.push(
		"",
		"This issue is closed automatically once a nightly run is back under the threshold with a usable measurement.",
	);
	return lines.join("\n");
}

function flags(argv, name) {
	const values = [];
	for (let at = argv.indexOf(name); at >= 0; at = argv.indexOf(name, at + 1)) {
		const value = argv[at + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`${name} requires a value`);
		}
		values.push(value);
	}
	return values;
}

/** @returns {number} the process exit code */
export function main(argv = process.argv.slice(2), log = console.log) {
	const reportPaths = flags(argv, "--report");
	if (reportPaths.length === 0) throw new Error("--report is required");
	const [bodyPath] = flags(argv, "--body");
	const [statePath] = flags(argv, "--state");
	const [runUrl] = flags(argv, "--run-url");
	let reports = [];
	let verdict;
	try {
		reports = reportPaths.map((reportPath) => {
			try {
				return JSON.parse(fs.readFileSync(reportPath, "utf8"));
			} catch (error) {
				throw new Error(
					`cannot read ${reportPath}: ${error?.message ?? error}`,
				);
			}
		});
		verdict = evaluate(reports);
	} catch (error) {
		verdict = {
			state: "error",
			threshold: DRIFT_THRESHOLD,
			reason: error?.message ?? String(error),
		};
	}
	if (statePath) {
		fs.mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true });
		fs.writeFileSync(statePath, `${verdict.state}\n`);
	}
	if (bodyPath) {
		if (verdict.state === "clean") {
			fs.rmSync(bodyPath, { force: true });
		} else {
			fs.mkdirSync(path.dirname(path.resolve(bodyPath)), { recursive: true });
			fs.writeFileSync(
				bodyPath,
				`${buildIssueBody(verdict, { runUrl, report: reports[0] })}\n`,
			);
		}
	}
	if (verdict.state === "error") {
		log(`snapshot-persist ratio: error: ${verdict.reason}`);
		log(`::error::snapshot persist measurement unusable: ${verdict.reason}`);
		return 2;
	}
	log(
		`snapshot-persist ratio: ${verdict.state} median=${fmt(verdict.median)} min=${fmt(verdict.min)} max=${fmt(verdict.max)} n=${verdict.samples.length} threshold=${verdict.threshold} (PROVISIONAL) samples=${verdict.samples.map((s) => `${s.workerMB}/${s.syncMB}`).join(" ")}`,
	);
	if (verdict.state === "drift") {
		log(
			`::error::snapshot persist worker/sync RSS median ratio ${fmt(verdict.median)} exceeds ${verdict.threshold}`,
		);
		return 1;
	}
	return 0;
}

if (isMainModule(import.meta.url)) {
	try {
		process.exitCode = main();
	} catch (error) {
		console.error(`snapshot-persist ratio: failed: ${error?.message ?? error}`);
		process.exitCode = 2;
	}
}
