#!/usr/bin/env node
/**
 * scripts/check-test-timeout-headroom.mjs (#5311): flag the tests whose CI
 * duration already took more than a share of the timeout that would have
 * killed them, so the next signal is this line and not a flake.
 *
 * The rule (ratio, cap resolution, baseline identity) is
 * `scripts/lib/test-timeout-headroom.mjs`. This file does the host reads and
 * the exit code.
 *
 * Exit codes: advisory by default -- 0 whenever the check measured, 2 when it
 * could not (a missing or malformed report, an unreadable baseline, a bad
 * argument), because a run that measured nothing is never a pass (shape 11).
 * With `--fail-on-new` a test over the ratio that is NOT in the baseline exits
 * 1. The CI step runs the default so the signal is the annotation, not a red
 * merge box; a fixer running it locally passes `--fail-on-new`.
 *
 * The committed baseline holds today's offenders, generated with
 * `--write-baseline`; its rows print as `known` and stay quiet. An offender
 * outside it prints as `NEW` and carries the annotation, so a new one is
 * visible without gating the merge.
 *
 * Usage:
 *   node scripts/check-test-timeout-headroom.mjs --report <file|dir> [--report …]
 *     [--root <dir>] [--ratio 0.6] [--baseline <path>] [--write-baseline]
 *     [--note <provenance>] [--max-rows 60] [--scale N] [--fail-on-new]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	assessReports,
	buildBaselineDocument,
	DEFAULT_BASELINE_RELATIVE,
	formatRow,
	formatSummary,
	HEADROOM_RATIO,
	loadBaseline,
	staleBaselineEntries,
	TimeoutHeadroomError,
} from "./lib/test-timeout-headroom.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const MAX_ANNOTATIONS = 10;

/** Every `.json` under a file or directory, in path order. */
function reportFiles(inputs) {
	const out = [];
	for (const input of inputs) {
		if (!fs.existsSync(input))
			throw new TimeoutHeadroomError(`--report path does not exist: ${input}`);
		const stat = fs.statSync(input);
		if (stat.isFile()) out.push(input);
		else
			for (const entry of fs
				.readdirSync(input, { withFileTypes: true })
				.sort((a, b) => a.name.localeCompare(b.name))) {
				if (entry.name.endsWith(".json"))
					out.push(path.join(input, entry.name));
			}
	}
	if (out.length === 0)
		throw new TimeoutHeadroomError(
			`--report matched no .json file: ${inputs.join(", ")}`,
		);
	return out;
}

/**
 * The lane's own timeout multiplier, the same parse
 * `tests/support/test-timeout-scale.ts` applies to
 * `PI_LENS_TEST_TIMEOUT_SCALE`. The caps this script folds must be the caps the
 * run applied, so the step carries the same env as its `Run tests` step;
 * `tests/scripts/test-timeout-headroom.test.ts` pins the two parses against
 * each other so the rule stays in its one home.
 */
function envTestTimeoutScale(env = process.env) {
	const parsed = Number(env.PI_LENS_TEST_TIMEOUT_SCALE ?? "1");
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** A GitHub `::warning` annotation; %, CR and LF are escaped in its body. */
function annotation(title, text) {
	const data = text
		.replace(/%/g, "%25")
		.replace(/\r/g, "%0D")
		.replace(/\n/g, "%0A");
	return `::warning title=${title}::${data}`;
}

function parseArgs(argv) {
	const options = {
		reports: [],
		root: ROOT,
		ratio: HEADROOM_RATIO,
		baseline: undefined,
		writeBaseline: false,
		note: "",
		maxRows: 60,
		scale: undefined,
		failOnNew: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		switch (arg) {
			case "--report":
				options.reports.push(argv[(i += 1)]);
				break;
			case "--root":
				options.root = path.resolve(String(argv[(i += 1)]));
				break;
			case "--ratio":
				options.ratio = Number(argv[(i += 1)]);
				break;
			case "--baseline":
				options.baseline = path.resolve(String(argv[(i += 1)]));
				break;
			case "--write-baseline":
				options.writeBaseline = true;
				break;
			case "--note":
				options.note = String(argv[(i += 1)]);
				break;
			case "--max-rows":
				options.maxRows = Number(argv[(i += 1)]);
				break;
			case "--scale":
				options.scale = Number(argv[(i += 1)]);
				break;
			case "--fail-on-new":
				options.failOnNew = true;
				break;
			default:
				throw new TimeoutHeadroomError(`unknown argument: ${arg}`);
		}
	}
	if (options.reports.length === 0)
		throw new TimeoutHeadroomError("--report is required");
	if (
		!Number.isFinite(options.ratio) ||
		options.ratio <= 0 ||
		options.ratio >= 1
	)
		throw new TimeoutHeadroomError(
			`--ratio must be a fraction in (0, 1): ${options.ratio}`,
		);
	if (!Number.isInteger(options.maxRows) || options.maxRows < 1)
		throw new TimeoutHeadroomError(
			`--max-rows must be an integer >= 1: ${options.maxRows}`,
		);
	if (
		options.scale !== undefined &&
		(!Number.isFinite(options.scale) || options.scale <= 0)
	)
		throw new TimeoutHeadroomError(
			`--scale must be a positive number: ${options.scale}`,
		);
	return options;
}

export function runCli(argv, { log = console.log } = {}) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		log(error instanceof Error ? error.message : String(error));
		return 2;
	}
	const scale = options.scale ?? envTestTimeoutScale();
	const baselineFile =
		options.baseline ?? path.join(options.root, DEFAULT_BASELINE_RELATIVE);
	try {
		const files = reportFiles(options.reports);
		const reportValues = files.map((file) => {
			let value;
			try {
				value = JSON.parse(fs.readFileSync(file, "utf8"));
			} catch (error) {
				throw new TimeoutHeadroomError(
					`${file} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return { value, source: file };
		});
		const { rows, counts, reported } = assessReports({
			reportValues,
			root: options.root,
			ratio: options.ratio,
			scale,
		});

		if (options.writeBaseline) {
			const document = buildBaselineDocument({
				rows,
				generatedFrom: options.note || files.join(", "),
				ratio: options.ratio,
				scale,
			});
			fs.writeFileSync(
				baselineFile,
				`${JSON.stringify(document, null, "\t")}\n`,
			);
			log(
				`timeout-headroom: wrote ${document.entries.length} baseline entries to ${baselineFile}`,
			);
			return 0;
		}

		const baseline = loadBaseline(baselineFile);
		// A baseline row whose test has been renamed or deleted excuses nothing, so
		// it is named here rather than left to shrink the ratchet's coverage. Only
		// the files these reports carried are judged, so a shard that never ran a
		// file cannot call its rows stale.
		const stale = staleBaselineEntries(baseline, reported);
		const added = rows.filter((row) => !baseline.entries.has(row.id));
		const known = rows.length - added.length;
		for (const row of rows.slice(0, options.maxRows))
			log(`${added.includes(row) ? "NEW" : "known"}  ${formatRow(row)}`);
		if (rows.length > options.maxRows)
			log(
				`… and ${rows.length - options.maxRows} more rows (${rows.length} total)`,
			);
		log(
			formatSummary(counts, {
				known,
				added: added.length,
				ratio: options.ratio,
				scale,
			}),
		);
		if (!options.failOnNew && added.length > 0)
			log(
				"timeout-headroom: advisory mode (exit 0); pass --fail-on-new to block on a new offender",
			);
		if (stale.length > 0) {
			log(
				`timeout-headroom: ${String(stale.length)} baseline row(s) name no test these reports carried; prune with --write-baseline`,
			);
			for (const entry of stale.slice(0, options.maxRows))
				log(`stale  ${entry.file} > ${entry.test}`);
		}
		if (baseline.missing)
			log(
				annotation(
					"test-timeout-headroom",
					`no baseline at ${baselineFile}; every row below is new`,
				),
			);
		for (const row of added.slice(0, MAX_ANNOTATIONS))
			log(annotation("test-timeout-headroom", formatRow(row)));
		if (added.length > MAX_ANNOTATIONS)
			log(
				annotation(
					"test-timeout-headroom",
					`${added.length - MAX_ANNOTATIONS} further new offenders (see the step log)`,
				),
			);
		if (counts.unknown > 0)
			log(
				annotation(
					"test-timeout-headroom",
					`${counts.unknown} tests are over the ratio against the floor of their file because their cap did not resolve`,
				),
			);
		if (counts.undated > 0)
			log(
				annotation(
					"test-timeout-headroom",
					`${counts.undated} ran assertions carried no duration and could not be judged`,
				),
			);
		return options.failOnNew && added.length > 0 ? 1 : 0;
	} catch (error) {
		if (!(error instanceof TimeoutHeadroomError)) throw error;
		log(`timeout-headroom: ${error.message}`);
		return 2;
	}
}

if (isMainModule(import.meta.url))
	process.exitCode = runCli(process.argv.slice(2));
