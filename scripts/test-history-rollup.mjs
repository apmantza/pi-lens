#!/usr/bin/env node
/**
 * Listener for the durable CI test journal (refs #3215, #4030).
 *
 * The journal is deliberately a file on the `data/test-history` branch, not a
 * service. Since #4030 it holds daily per-test aggregates, one line per
 * (day, lane) (`history/test-daily.ndjson`), never raw rows: raw rows were
 * about 15 MB a day and passed GitHub's 100 MB file limit within a week. A
 * day line is
 *
 *   { day, lane, newestRecordedAt, heads: [sha...], parts: [key...],
 *     tests: { <file>: { runs, passes, fails, skips, durationMs,
 *                        passMask?, failMask? } } }
 *
 * - `runs`/`passes`/`fails`/`skips`/`durationMs` sum the file's runs that day;
 *   one raw row was one file-run, so the sum of `runs` is the old row count.
 * - The masks are the flake evidence the #3215 rule needs: bit i set means
 *   `heads[i]` passed (failed) the file that day. A failure and its passing
 *   re-run on one head (#3447) are two bits on that head, on any day of the
 *   window. One bit per head of the day bounds a day where everything fails.
 * - `parts` is the ingest ledger that makes nightly ingest exactly-once: a part
 *   is one artifact's results file, keyed `runId/runAttempt/<smallest file>`
 *   (shard file sets are disjoint); a run migrated from the raw journal is
 *   recorded whole as `runId/runAttempt/*`.
 * - Retention drops whole day lines past 90 days; nothing splits a day or a
 *   run. A journal over HISTORY_MAX_BYTES is refused (exit 2), never evicted.
 *
 * Identity (#3367): a test's `file` is its repo-relative posix path
 * (`normalizeTestFile`), never vitest's absolute runner path. Both entrances
 * normalize: a new artifact (`artifactParts`) and a raw row read for the
 * one-time migration (`rawRow`, the compat read for the absolute-path and
 * pre-#3447 journals). The migration streams the raw file (`forEachLine`): a
 * whole-file string can exceed Node's string limit (#4031).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { isMainModule } from "./lib/is-main-module.mjs";

export const HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const HISTORY_MAX_BYTES = 95 * 1024 * 1024;

/**
 * The single source of truth for the producer/consumer artifact contract.
 *
 * The CI producer writes this basename beside its vitest JSON, and this
 * script looks for exactly this basename. Round 3 shipped a producer writing
 * `test-history-metadata.json` and a consumer reading `metadata.json`, so the
 * real run-35918869980 artifact rolled up to nothing (exit 2, zero rows) and
 * lane 1 had never produced a row. `tests/config/test-history-workflow.test.ts`
 * asserts the workflow steps against THIS constant, so the two halves cannot
 * drift apart again.
 */
export const METADATA_FILENAME = "test-history-metadata.json";

/**
 * The one identity of a test in the journal (#3367): everything from the last
 * `/tests/` segment on, with posix separators. Test files never nest a
 * `tests` directory (`tests/fixtures/**` is excluded from vitest), while a
 * checkout root may contain one, so the last occurrence is the repo-relative
 * start. A name with no `tests/` anchor is kept verbatim (posix), never
 * dropped: the journal records it and a reader can see the miss.
 */
export function normalizeTestFile(name) {
	const posix = String(name).replaceAll("\\", "/");
	const at = posix.lastIndexOf("/tests/");
	return at === -1 ? posix : posix.slice(at + 1);
}

function parseArgs(argv) {
	const result = {
		artifacts: [],
		history: null,
		summary: null,
		now: Date.now(),
		printWatermark: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--artifact" || arg === "--artifact-dir") {
			const value = argv[++i];
			if (!value) throw new Error(`${arg} needs a path`);
			result.artifacts.push(value);
		} else if (arg === "--history") result.history = argv[++i];
		else if (arg === "--summary") result.summary = argv[++i];
		else if (arg === "--now") result.now = Date.parse(argv[++i]);
		else if (arg === "--print-watermark") result.printWatermark = true;
		else throw new Error(`unknown option ${arg}`);
	}
	if (result.printWatermark) {
		if (!result.history) throw new Error("--print-watermark needs --history");
		return result;
	}
	if (!result.artifacts.length || !result.history || !result.summary)
		throw new Error("at least one artifact and both output paths are required");
	if (!Number.isFinite(result.now))
		throw new Error("--now must be an ISO date");
	return result;
}

/**
 * Calls `onLine` for every non-empty line of `file`, reading `chunkBytes` at a
 * time, so no string ever holds the whole file (#4031). Splitting on the 0x0A
 * byte is safe in UTF-8: it never occurs inside a multi-byte sequence.
 */
export function forEachLine(file, onLine, chunkBytes = 1 << 20) {
	const fd = fs.openSync(file, "r");
	const emit = (bytes) => {
		const line = bytes.toString("utf8").replace(/\r$/, "");
		if (line) onLine(line);
	};
	try {
		const chunk = Buffer.alloc(chunkBytes);
		let carry = Buffer.alloc(0);
		for (;;) {
			const read = fs.readSync(fd, chunk, 0, chunkBytes, null);
			if (read === 0) break;
			const data = Buffer.concat([carry, chunk.subarray(0, read)]);
			let start = 0;
			for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
				emit(data.subarray(start, nl));
				start = nl + 1;
			}
			carry = Buffer.from(data.subarray(start));
		}
		if (carry.length) emit(carry);
	} finally {
		fs.closeSync(fd);
	}
}

function filesUnder(input) {
	const stat = fs.statSync(input);
	if (stat.isFile()) return [input];
	return fs
		.readdirSync(input, { withFileTypes: true })
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		.flatMap((entry) => filesUnder(path.join(input, entry.name)));
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function outcomeFor(result) {
	if (result.status === "failed" || result.numFailingTests > 0) return "failed";
	if (result.status === "skipped" || result.numPendingTests > 0)
		return "skipped";
	return "passed";
}

function durationFor(result) {
	if (Number.isFinite(result.duration)) return Math.max(0, result.duration);
	if (Number.isFinite(result.startTime) && Number.isFinite(result.endTime))
		return Math.max(0, result.endTime - result.startTime);
	return 0;
}

function isValidHeadSha(value) {
	// Lowercase only: `github.sha` and `pull_request.head.sha` are always
	// lowercase hex, so an uppercase value is a hand-edited or foreign
	// producer, not a git head. It must not enter the durable journal, where
	// it would key as a second head for the same commit.
	return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function validateRow(row) {
	return (
		row &&
		typeof row === "object" &&
		isValidHeadSha(row.headSha) &&
		typeof row.runId === "string" &&
		typeof row.file === "string" &&
		typeof row.outcome === "string" &&
		typeof row.lane === "string" &&
		Number.isFinite(row.durationMs) &&
		Number.isFinite(Date.parse(row.recordedAt))
	);
}

function rowsOfPart(value, metadata) {
	const headSha = metadata.headSha;
	const runId = String(metadata.runId ?? "");
	const lane = metadata.lane ?? "linux";
	// Absent on artifacts written before #3447; their rows keep the key they
	// were first stored under.
	const runAttempt =
		metadata.runAttempt === undefined ? undefined : String(metadata.runAttempt);
	const recordedAt = metadata.recordedAt ?? new Date().toISOString();
	if (!isValidHeadSha(headSha)) throw new Error("headSha must be a 40-hex SHA");
	if (!runId)
		throw new Error("artifact metadata must contain headSha and runId");
	return value.testResults.map((result) => ({
		headSha,
		runId,
		file: normalizeTestFile(
			result.name ?? result.filepath ?? result.file ?? "",
		),
		outcome: outcomeFor(result),
		durationMs: durationFor(result),
		lane,
		...(runAttempt === undefined ? {} : { runAttempt }),
		recordedAt,
	}));
}

/**
 * One artifact part at a time (its vitest JSON beside its metadata), so the
 * rollup holds one parsed report in memory, never the whole night's set.
 */
function* artifactParts(inputs) {
	for (const file of inputs.flatMap(filesUnder)) {
		if (!file.endsWith(".json")) continue;
		const value = readJson(file);
		if (!value || !Array.isArray(value.testResults)) continue;
		const metadataFile = path.join(path.dirname(file), METADATA_FILENAME);
		const metadata = fs.existsSync(metadataFile) ? readJson(metadataFile) : {};
		yield rowsOfPart(value, metadata);
	}
}

export function rowsFromArtifacts(inputs) {
	return [...artifactParts(inputs)].flat();
}

/**
 * The compat read of one raw journal line (the pre-#4030 format), with `file`
 * normalized for rows written with an absolute runner path before #3367. A
 * non-40-hex head is a bounded failure; any other invalid row is dropped.
 */
function rawRow(row) {
	if (row && typeof row === "object" && !isValidHeadSha(row.headSha))
		throw new Error("headSha must be a 40-hex SHA");
	const normalized =
		row && typeof row.file === "string"
			? { ...row, file: normalizeTestFile(row.file) }
			: row;
	return validateRow(normalized) ? normalized : undefined;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MASK_RE = /^[0-9a-f]+$/;
const COUNT_FIELDS = ["runs", "passes", "fails", "skips", "durationMs"];

function maskOf(value, where) {
	if (value === undefined) return 0n;
	if (typeof value !== "string" || !MASK_RE.test(value))
		throw new Error(`malformed mask at ${where}`);
	return BigInt(`0x${value}`);
}

/** The in-memory day line: a head index and BigInt masks beside the file shape. */
function emptyDay(day, lane) {
	return {
		day,
		lane,
		newestRecordedAt: null,
		heads: [],
		headIndex: new Map(),
		parts: new Set(),
		tests: new Map(),
	};
}

function parseDayLine(doc, where) {
	if (
		typeof doc.day !== "string" ||
		!DAY_RE.test(doc.day) ||
		typeof doc.lane !== "string" ||
		!Array.isArray(doc.heads) ||
		!Array.isArray(doc.parts) ||
		!doc.tests ||
		typeof doc.tests !== "object"
	)
		throw new Error(`malformed day line at ${where}`);
	const day = emptyDay(doc.day, doc.lane);
	for (const sha of doc.heads) {
		if (!isValidHeadSha(sha)) throw new Error("headSha must be a 40-hex SHA");
		day.headIndex.set(sha, day.heads.length);
		day.heads.push(sha);
	}
	for (const part of doc.parts) day.parts.add(String(part));
	if (Number.isFinite(Date.parse(doc.newestRecordedAt)))
		day.newestRecordedAt = doc.newestRecordedAt;
	for (const [file, entry] of Object.entries(doc.tests)) {
		if (!entry || COUNT_FIELDS.some((field) => !Number.isFinite(entry[field])))
			throw new Error(`malformed test entry ${file} at ${where}`);
		day.tests.set(file, {
			runs: entry.runs,
			passes: entry.passes,
			fails: entry.fails,
			skips: entry.skips,
			durationMs: entry.durationMs,
			pass: maskOf(entry.passMask, where),
			fail: maskOf(entry.failMask, where),
		});
	}
	return day;
}

/** The working set of day lines, keyed by day and lane. */
class DailyHistory {
	constructor() {
		this.days = new Map();
		this.ledger = new Set();
		this.migratedRows = 0;
	}

	dayFor(day, lane) {
		const key = `${day}\0${lane}`;
		let entry = this.days.get(key);
		if (!entry) this.days.set(key, (entry = emptyDay(day, lane)));
		return entry;
	}

	addDay(day) {
		const key = `${day.day}\0${day.lane}`;
		if (this.days.has(key)) throw new Error(`duplicate day line ${key}`);
		this.days.set(key, day);
		for (const part of day.parts) this.ledger.add(`${day.lane}\0${part}`);
	}

	addPart(day, part) {
		day.parts.add(part);
		this.ledger.add(`${day.lane}\0${part}`);
	}

	fold(row) {
		const recordedAt = new Date(Date.parse(row.recordedAt)).toISOString();
		const day = this.dayFor(recordedAt.slice(0, 10), row.lane);
		if (!day.newestRecordedAt || recordedAt > day.newestRecordedAt)
			day.newestRecordedAt = recordedAt;
		let index = day.headIndex.get(row.headSha);
		if (index === undefined) {
			index = day.heads.length;
			day.headIndex.set(row.headSha, index);
			day.heads.push(row.headSha);
		}
		let entry = day.tests.get(row.file);
		if (!entry)
			day.tests.set(
				row.file,
				(entry = {
					runs: 0,
					passes: 0,
					fails: 0,
					skips: 0,
					durationMs: 0,
					pass: 0n,
					fail: 0n,
				}),
			);
		const bit = 1n << BigInt(index);
		entry.runs += 1;
		entry.durationMs += row.durationMs;
		if (row.outcome === "failed") {
			entry.fails += 1;
			entry.fail |= bit;
		} else if (row.outcome === "skipped") entry.skips += 1;
		else {
			entry.passes += 1;
			entry.pass |= bit;
		}
		return day;
	}

	/** The one-time migration of a raw row: its run is recorded whole. */
	foldRaw(row) {
		const day = this.fold(row);
		this.addPart(day, `${row.runId}/${row.runAttempt ?? ""}/*`);
		this.migratedRows += 1;
	}

	/**
	 * Folds one artifact part unless the ledger already holds it (a part seen
	 * on an earlier night, or a run the raw journal held). Returns whether the
	 * part was new.
	 */
	foldPart(rows) {
		if (rows.length === 0) return false;
		const [first] = rows;
		const run = `${first.runId}/${first.runAttempt ?? ""}`;
		const smallest = rows.reduce(
			(min, row) => (row.file < min ? row.file : min),
			first.file,
		);
		const part = `${run}/${smallest}`;
		if (
			this.ledger.has(`${first.lane}\0${part}`) ||
			this.ledger.has(`${first.lane}\0${run}/*`)
		)
			return false;
		let day;
		for (const row of rows) day = this.fold(row);
		this.addPart(day, part);
		return true;
	}

	prune(now) {
		const cutoffDay = new Date(now - HISTORY_MAX_AGE_MS)
			.toISOString()
			.slice(0, 10);
		for (const [key, day] of this.days)
			if (day.day < cutoffDay) this.days.delete(key);
	}

	sortedDays() {
		return [...this.days.values()].sort(
			(a, b) =>
				a.day.localeCompare(b.day) ||
				(a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0),
		);
	}

	watermark() {
		let newest = null;
		for (const day of this.days.values())
			if (day.newestRecordedAt && (!newest || day.newestRecordedAt > newest))
				newest = day.newestRecordedAt;
		return newest;
	}
}

/**
 * Reads the prior journal: day lines, or (one time) the raw journal, line by
 * line. A raw line is the pre-#4030 row shape; a day line carries `day` and
 * `tests`.
 */
function readHistory(file) {
	const history = new DailyHistory();
	if (!fs.existsSync(file)) return history;
	let lineNumber = 0;
	forEachLine(file, (line) => {
		lineNumber += 1;
		const value = JSON.parse(line);
		if (
			value &&
			typeof value === "object" &&
			"day" in value &&
			"tests" in value
		)
			history.addDay(parseDayLine(value, `history line ${lineNumber}`));
		else {
			const row = rawRow(value);
			if (row) history.foldRaw(row);
		}
	});
	return history;
}

function serializeDay(day) {
	const tests = {};
	for (const file of [...day.tests.keys()].sort()) {
		const entry = day.tests.get(file);
		tests[file] = {
			runs: entry.runs,
			passes: entry.passes,
			fails: entry.fails,
			skips: entry.skips,
			durationMs: Math.round(entry.durationMs),
			...(entry.pass ? { passMask: entry.pass.toString(16) } : {}),
			...(entry.fail ? { failMask: entry.fail.toString(16) } : {}),
		};
	}
	return JSON.stringify({
		day: day.day,
		lane: day.lane,
		newestRecordedAt: day.newestRecordedAt,
		heads: day.heads,
		parts: [...day.parts].sort(),
		tests,
	});
}

/** Heads whose bit is set in `mask`, lowest index first. */
function headsIn(mask, heads) {
	const found = [];
	for (let index = 0; mask >> BigInt(index); index += 1)
		if ((mask >> BigInt(index)) & 1n) found.push(heads[index]);
	return found;
}

/** Every summary view, from the day lines that are published (#4030 F3). */
function summarize(days) {
	const perFile = new Map();
	const allHeads = new Set();
	let rowCount = 0;
	for (const day of days) {
		for (const sha of day.heads) allHeads.add(sha);
		for (const [file, entry] of day.tests) {
			let acc = perFile.get(file);
			if (!acc)
				perFile.set(
					file,
					(acc = {
						passCount: 0,
						failCount: 0,
						runs: 0,
						durationMs: 0,
						lastFailHead: null,
						failHeads: [],
						passHeads: new Set(),
					}),
				);
			acc.passCount += entry.passes;
			acc.failCount += entry.fails;
			acc.runs += entry.runs;
			acc.durationMs += entry.durationMs;
			rowCount += entry.runs;
			for (const sha of headsIn(entry.pass, day.heads)) acc.passHeads.add(sha);
			for (const sha of headsIn(entry.fail, day.heads)) {
				if (!acc.failHeads.includes(sha)) acc.failHeads.push(sha);
				acc.lastFailHead = sha;
			}
		}
	}
	const files = [...perFile.keys()].sort();
	return {
		rowCount,
		files: files.map((file) => {
			const acc = perFile.get(file);
			return {
				file,
				passCount: acc.passCount,
				failCount: acc.failCount,
				lastFailHead: acc.lastFailHead,
				meanDurationMs: acc.runs ? acc.durationMs / acc.runs : 0,
			};
		}),
		// One row per failing (file, head); `flake` is the owner's rule (#3215):
		// the same head also passed that file. The history selector reads this.
		failures: files.flatMap((file) => {
			const acc = perFile.get(file);
			return acc.failHeads.map((headSha) => ({
				file,
				headSha,
				flake: acc.passHeads.has(headSha),
			}));
		}),
		heads: [...allHeads].sort(),
	};
}

/** Where the next incremental ingest starts: the newest ingested row. */
export function historyWatermark(historyPath) {
	return readHistory(historyPath).watermark();
}

export function rollupTestHistory({
	artifactPaths,
	historyPath,
	summaryPath,
	now = Date.now(),
	maxBytes = HISTORY_MAX_BYTES,
}) {
	const history = readHistory(historyPath);
	let ingestedParts = 0;
	let duplicateParts = 0;
	for (const rows of artifactParts(artifactPaths)) {
		if (history.foldPart(rows)) ingestedParts += 1;
		else if (rows.length) duplicateParts += 1;
	}
	history.prune(now);
	const days = history.sortedDays();
	const lines = days.map(serializeDay);
	const bytes = lines.reduce(
		(total, line) => total + Buffer.byteLength(line) + 1,
		0,
	);
	if (bytes > maxBytes)
		throw new Error(
			`test history would be ${bytes} bytes, over the ${maxBytes}-byte bound; refusing to publish (#4030)`,
		);
	const views = summarize(days);
	const flakes = views.failures
		.filter((failure) => failure.flake)
		.map(({ file, headSha }) => ({ file, headSha }));
	fs.mkdirSync(path.dirname(historyPath), { recursive: true });
	fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
	fs.writeFileSync(historyPath, lines.map((line) => `${line}\n`).join(""));
	const output = {
		rowCount: views.rowCount,
		files: views.files,
		flakeCandidates: flakes,
		failures: views.failures,
		// Every distinct head in the window, failing or not: the selector's
		// population for deciding which directories are touched by too many heads
		// to say anything about a failure (#3215 lane 3 review F1).
		heads: views.heads,
		// When this rollup ran: the selector's staleness clock (a quiet repo with
		// no CI rows is not lagging data, a rollup that stopped running is).
		generatedAt: new Date(now).toISOString(),
		// The newest ingested row: where the next incremental ingest starts.
		ingestedThrough: history.watermark(),
		dayCount: days.length,
	};
	fs.writeFileSync(summaryPath, `${JSON.stringify(output, null, 2)}\n`);
	return {
		...output,
		bytes,
		ingestedParts,
		duplicateParts,
		migratedRows: history.migratedRows,
	};
}

/**
 * The CLI arm, exported so its bounded-failure contract is observable in
 * process. Returns the process exit code: 0 on success, 2 for any bounded
 * failure (bad options, unreadable artifact, malformed head identity, a
 * journal over its byte bound). The nightly step runs under
 * `set -euo pipefail`, so a nonzero return fails the job rather than pushing
 * a partial journal.
 */
export function runCli(argv) {
	try {
		const options = parseArgs(argv);
		if (options.printWatermark) {
			console.log(historyWatermark(options.history) ?? "");
			return 0;
		}
		const output = rollupTestHistory({
			artifactPaths: options.artifacts,
			historyPath: options.history,
			summaryPath: options.summary,
			now: options.now,
		});
		const ingest = `${output.ingestedParts} new part(s), ${output.duplicateParts} already ingested, ${output.migratedRows} raw row(s) migrated; ${output.dayCount} day(s), ${output.bytes} bytes, ingested through ${output.ingestedThrough ?? "nothing"}`;
		console.log(
			`test-history: ${output.rowCount} rows, ${output.files.length} files`,
		);
		console.log(`test-history ingest: ${ingest}`);
		console.log(
			`flake candidates: ${output.flakeCandidates.map(({ file, headSha }) => `${file} (${headSha})`).join(", ") || "none"}`,
		);
		if (process.env.GITHUB_STEP_SUMMARY)
			fs.appendFileSync(
				process.env.GITHUB_STEP_SUMMARY,
				`## Test history\n\nRows: ${output.rowCount}\n\nIngest: ${ingest}\n\n### Flake candidates\n\n${output.flakeCandidates.length ? output.flakeCandidates.map(({ file, headSha }) => `- \`${file}\` on \`${headSha}\``).join("\n") : "None"}\n`,
			);
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
}

if (isMainModule(import.meta.url))
	process.exitCode = runCli(process.argv.slice(2));
