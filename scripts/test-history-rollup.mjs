#!/usr/bin/env node
/**
 * Listener for the durable CI test journal (refs #3215).
 *
 * The journal is deliberately a file on the `data/test-history` branch, not a
 * service. It keeps one row per (headSha, file, lane, run, attempt), never one
 * row per test case, and prunes rows older than 90 days. The run and attempt
 * are in the key (#3447) because a re-run keeps its run id: a failure and its
 * passing re-run on one head are the flake evidence, and a head-only key kept
 * one of the two and erased the other the next night. The bounded-read F2 incident
 * (#3326, 2026-09-23) was judged flaky by reading seven logs by hand; this
 * rollup makes that same-head evidence durable.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

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

function parseArgs(argv) {
	const result = {
		artifacts: [],
		history: null,
		summary: null,
		now: Date.now(),
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
		else throw new Error(`unknown option ${arg}`);
	}
	if (!result.artifacts.length || !result.history || !result.summary)
		throw new Error("at least one artifact and both output paths are required");
	if (!Number.isFinite(result.now))
		throw new Error("--now must be an ISO date");
	return result;
}

function filesUnder(input) {
	const stat = fs.statSync(input);
	if (stat.isFile()) return [input];
	return fs
		.readdirSync(input, { withFileTypes: true })
		.flatMap((entry) => filesUnder(path.join(input, entry.name)));
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findArtifactParts(inputs) {
	const jsonFiles = inputs
		.flatMap(filesUnder)
		.filter((file) => file.endsWith(".json"));
	const parts = [];
	for (const file of jsonFiles) {
		const value = readJson(file);
		if (value && Array.isArray(value.testResults)) {
			const directory = path.dirname(file);
			const metadataFile = path.join(directory, METADATA_FILENAME);
			const metadata = fs.existsSync(metadataFile)
				? readJson(metadataFile)
				: {};
			parts.push({ value, metadata });
		}
	}
	return parts;
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

export function rowsFromArtifacts(inputs) {
	return findArtifactParts(inputs).flatMap(({ value, metadata }) => {
		const headSha = metadata.headSha;
		const runId = String(metadata.runId ?? "");
		const lane = metadata.lane ?? "linux";
		// Absent on artifacts written before #3447; their rows keep the key
		// they were first stored under.
		const runAttempt =
			metadata.runAttempt === undefined
				? undefined
				: String(metadata.runAttempt);
		const recordedAt = metadata.recordedAt ?? new Date().toISOString();
		if (!isValidHeadSha(headSha))
			throw new Error("headSha must be a 40-hex SHA");
		if (!runId)
			throw new Error("artifact metadata must contain headSha and runId");
		return value.testResults.map((result) => ({
			headSha,
			runId,
			file: result.name ?? result.filepath ?? result.file ?? "",
			outcome: outcomeFor(result),
			durationMs: durationFor(result),
			lane,
			...(runAttempt === undefined ? {} : { runAttempt }),
			recordedAt,
		}));
	});
}

function readRows(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			const row = JSON.parse(line);
			if (row && typeof row === "object" && !isValidHeadSha(row.headSha))
				throw new Error("headSha must be a 40-hex SHA");
			return row;
		})
		.filter(validateRow);
}

function key(row) {
	return `${row.headSha}\0${row.file}\0${row.lane}\0${row.runId}\0${row.runAttempt ?? ""}`;
}

export function rollupTestHistory({
	artifactPaths,
	historyPath,
	summaryPath,
	now = Date.now(),
}) {
	const incoming = rowsFromArtifacts(artifactPaths);
	const priorRows = readRows(historyPath);
	const observations = [...priorRows, ...incoming];
	const byKey = new Map(priorRows.map((row) => [key(row), row]));
	for (const row of incoming) byKey.set(key(row), row);
	const cutoff = now - HISTORY_MAX_AGE_MS;
	const rows = [...byKey.values()]
		.filter((row) => Date.parse(row.recordedAt) >= cutoff)
		.sort(
			(a, b) =>
				a.recordedAt.localeCompare(b.recordedAt) ||
				key(a).localeCompare(key(b)),
		);
	const grouped = new Map();
	for (const row of rows) {
		if (!grouped.has(row.file)) grouped.set(row.file, []);
		grouped.get(row.file).push(row);
	}
	const liveObservations = observations.filter(
		(row) => Date.parse(row.recordedAt) >= cutoff,
	);
	const summaryGroups = new Map();
	for (const row of liveObservations) {
		if (!summaryGroups.has(row.file)) summaryGroups.set(row.file, []);
		summaryGroups.get(row.file).push(row);
	}
	const summary = [...summaryGroups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([file, fileRows]) => {
			const failures = fileRows.filter((row) => row.outcome === "failed");
			const passes = fileRows.filter((row) => row.outcome === "passed");
			const meanDurationMs =
				fileRows.reduce((sum, row) => sum + row.durationMs, 0) /
				fileRows.length;
			return {
				file,
				passCount: passes.length,
				failCount: failures.length,
				lastFailHead: failures.at(-1)?.headSha ?? null,
				meanDurationMs,
			};
		});
	const flakes = [...summaryGroups.keys()].sort().flatMap((file) => {
		const fileRows = summaryGroups.get(file);
		const heads = new Set(
			fileRows
				.filter((row) => row.outcome === "failed")
				.map((row) => row.headSha),
		);
		return [...heads]
			.filter((head) =>
				fileRows.some(
					(row) => row.headSha === head && row.outcome === "passed",
				),
			)
			.map((headSha) => ({ file, headSha }));
	});
	fs.mkdirSync(path.dirname(historyPath), { recursive: true });
	fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
	fs.writeFileSync(
		historyPath,
		rows.map((row) => JSON.stringify(row)).join("\n") +
			(rows.length ? "\n" : ""),
	);
	const output = {
		rowCount: rows.length,
		files: summary,
		flakeCandidates: flakes,
	};
	fs.writeFileSync(summaryPath, `${JSON.stringify(output, null, 2)}\n`);
	return output;
}

/**
 * The CLI arm, exported so its bounded-failure contract is observable in
 * process. Returns the process exit code: 0 on success, 2 for any bounded
 * failure (bad options, unreadable artifact, malformed head identity). The
 * nightly step runs under `set -euo pipefail`, so a nonzero return fails the
 * job rather than pushing a partial journal.
 */
export function runCli(argv) {
	try {
		const options = parseArgs(argv);
		const output = rollupTestHistory({
			artifactPaths: options.artifacts,
			historyPath: options.history,
			summaryPath: options.summary,
			now: options.now,
		});
		console.log(
			`test-history: ${output.rowCount} rows, ${output.files.length} files`,
		);
		console.log(
			`flake candidates: ${output.flakeCandidates.map(({ file, headSha }) => `${file} (${headSha})`).join(", ") || "none"}`,
		);
		if (process.env.GITHUB_STEP_SUMMARY)
			fs.appendFileSync(
				process.env.GITHUB_STEP_SUMMARY,
				`## Test history\n\nRows: ${output.rowCount}\n\n### Flake candidates\n\n${output.flakeCandidates.length ? output.flakeCandidates.map(({ file, headSha }) => `- \`${file}\` on \`${headSha}\``).join("\n") : "None"}\n`,
			);
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	process.exitCode = runCli(process.argv.slice(2));
