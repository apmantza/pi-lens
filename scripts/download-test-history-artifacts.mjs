#!/usr/bin/env node
/**
 * Incremental download of the Unit tests shard artifacts for the nightly
 * test-history rollup (#4030).
 *
 *   node scripts/download-test-history-artifacts.mjs --repository <owner/repo>
 *     --output-dir <dir> [--since <ISO>] [--max-runs <n>] [--artifact-name <n>]...
 *
 * `--since` is the journal's watermark (`test-history-rollup.mjs
 * --print-watermark`): the newest ingested `recordedAt`. The selection:
 * - lists repository artifacts newest first, page by page, and stops at the
 *   first page entirely older than the watermark minus LIST_LOOKBACK_MS, so
 *   a re-run's earlier parts are still listed;
 * - keeps the shard names, unexpired, and skips metadata-only artifacts (a
 *   cancelled shard uploads its 281-290 B metadata without results);
 * - groups by CI run and selects every run with an artifact newer than the
 *   watermark minus SELECT_OVERLAP_MS (the overlap covers an artifact that
 *   was still uploading when the previous night listed);
 * - takes at most MAX_RUNS_PER_NIGHT WHOLE runs, oldest first. A run is never
 *   split: every listed part of a selected run downloads, and the rollup's
 *   part ledger drops the parts it already holds. A run left past the cap has
 *   a newest artifact later than any ingested one, so the next night still
 *   selects it.
 * Downloading every unexpired artifact (90-day retention) grew until the
 * rollup's heap ran out (runs 36860553809 to 37316090921). Each ZIP streams to
 * its file, so no output buffer bounds its size. Only gh's `HTTP 5xx` and
 * `unexpected end of JSON input` (#5154) retry. The listing's JSON is parsed
 * here, so a listing body that fails to parse is not retried.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const MAX_ATTEMPTS = 4;
export const MAX_RUNS_PER_NIGHT = 100;
export const SELECT_OVERLAP_MS = 60 * 60 * 1000;
export const LIST_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
export const METADATA_ONLY_MAX_BYTES = 1024;
// #5154: the orchestrator's local `gh api -i` probe (comment 6559081169 on #5154)
// saw HTTP 500 with an empty body for listing pages 1 and 3 at 100 a page, and
// 200 for pages 1 to 10 at 30. The 500 is intermittent: a later probe got 200
// for the same pages at 100 a page. The CI job printed only
// `unexpected end of JSON input`, with no status.
export const LIST_PAGE_SIZE = 30;
// 1000 pages of 30 hold the 30000-artifact ceiling that 300 pages of 100 did.
export const MAX_LIST_PAGES = 1000;
export const ARTIFACT_NAMES = [
	"unit-test-results-linux",
	"unit-test-results-linux-shard-1",
	"unit-test-results-linux-shard-2",
	"unit-test-results-linux-shard-3",
	"unit-test-results-linux-shard-4",
	"unit-test-results-linux-shard-5",
];

function options(argv) {
	const result = {
		repository: process.env.GITHUB_REPOSITORY,
		outputDir: null,
		since: null,
		maxRuns: MAX_RUNS_PER_NIGHT,
		names: [],
	};
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--repository") result.repository = argv[++i];
		else if (argv[i] === "--output-dir") result.outputDir = argv[++i];
		else if (argv[i] === "--since") result.since = argv[++i] || null;
		else if (argv[i] === "--max-runs") result.maxRuns = Number(argv[++i]);
		else if (argv[i] === "--artifact-name") result.names.push(argv[++i]);
		else throw new Error(`unknown option ${argv[i]}`);
	}
	if (!result.repository || !result.outputDir)
		throw new Error("--repository and --output-dir are required");
	if (result.since !== null && !Number.isFinite(Date.parse(result.since)))
		throw new Error("--since must be an ISO date");
	if (!Number.isInteger(result.maxRuns) || result.maxRuns < 1)
		throw new Error("--max-runs must be a positive integer");
	if (!result.names.length) result.names = ARTIFACT_NAMES;
	return result;
}

function pause(attempt) {
	const delay =
		Number(process.env.TEST_HISTORY_RETRY_DELAY_MS ?? 1000) *
		2 ** (attempt - 1);
	if (delay > 0)
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

function isRetryable(result) {
	const text = `${result.stderr}\n${result.stdout}`;
	return (
		/\bHTTP 5\d\d\b/.test(text) || text.includes("unexpected end of JSON input")
	);
}

function failureText(result) {
	return String(
		result.error?.message ||
			result.stderr ||
			result.stdout ||
			`gh exited ${result.status}`,
	).trim();
}

/**
 * `gh api <args>`, retried on `HTTP 5xx` and on `unexpected end of JSON input`
 * (a cut-off response body, #5154) only. With `outputFile`, stdout goes
 * straight to that file (a ZIP of any size), and a failed attempt leaves no
 * partial file.
 */
function runGh(args, { outputFile } = {}) {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		const fd = outputFile ? fs.openSync(outputFile, "w") : undefined;
		let result;
		try {
			result = spawnSync("gh", ["api", ...args], {
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
				stdio: ["ignore", fd ?? "pipe", "pipe"],
			});
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
		if (result.status === 0 && !result.error) return result.stdout;
		if (outputFile) fs.rmSync(outputFile, { force: true });
		if (!isRetryable(result) || attempt === MAX_ATTEMPTS)
			throw new Error(failureText(result));
		pause(attempt);
	}
	throw new Error("unreachable");
}

/**
 * Pages through `fetchPage(page)` (newest first) until a page holds nothing
 * newer than `cutoffMs`, or the listing ends. The list is ordered by id, so
 * the stop tests a whole page rather than the first old entry.
 */
export function listArtifacts(fetchPage, cutoffMs, maxPages = MAX_LIST_PAGES) {
	const found = [];
	for (let page = 1; page <= maxPages; page += 1) {
		const artifacts = fetchPage(page);
		if (artifacts.length === 0) return found;
		found.push(...artifacts);
		if (artifacts.every((entry) => Date.parse(entry.createdAt) < cutoffMs))
			return found;
	}
	throw new Error(
		`artifact listing passed ${maxPages} pages without reaching ${new Date(cutoffMs).toISOString()}`,
	);
}

/** The listing window for a watermark: no history starts from the lookback. */
export function windowFor(since, now) {
	const start = since ? Date.parse(since) : now - LIST_LOOKBACK_MS;
	return {
		selectAfterMs: start - SELECT_OVERLAP_MS,
		listCutoffMs: start - LIST_LOOKBACK_MS,
	};
}

/**
 * The incremental selection over listed artifacts
 * (`{ id, name, size, createdAt, expired, runId }`), in whole runs.
 */
export function selectArtifacts(
	artifacts,
	{ since, now, maxRuns = MAX_RUNS_PER_NIGHT, names = ARTIFACT_NAMES },
) {
	const { selectAfterMs, listCutoffMs } = windowFor(since, now);
	const wanted = new Set(names);
	const byRun = new Map();
	let metadataOnly = 0;
	for (const artifact of artifacts) {
		if (!wanted.has(artifact.name) || artifact.expired) continue;
		if (Date.parse(artifact.createdAt) < listCutoffMs) continue;
		if (artifact.size <= METADATA_ONLY_MAX_BYTES) {
			metadataOnly += 1;
			continue;
		}
		const runId = String(artifact.runId);
		const list = byRun.get(runId) ?? [];
		list.push(artifact);
		byRun.set(runId, list);
	}
	const eligible = [...byRun]
		.map(([runId, list]) => ({
			runId,
			artifacts: list.sort((a, b) => a.id - b.id),
			newest: list.reduce(
				(max, entry) => (entry.createdAt > max ? entry.createdAt : max),
				"",
			),
		}))
		.filter((run) => Date.parse(run.newest) > selectAfterMs)
		.sort(
			(a, b) =>
				a.newest.localeCompare(b.newest) || a.runId.localeCompare(b.runId),
		);
	const runs = eligible.slice(0, maxRuns);
	return {
		runs,
		artifacts: runs.flatMap((run) => run.artifacts),
		eligibleRuns: eligible.length,
		metadataOnly,
		capped: eligible.length > runs.length,
	};
}

function fetchPageFor(repository) {
	return (page) => {
		const { artifacts } = JSON.parse(
			runGh([
				`/repos/${repository}/actions/artifacts?per_page=${LIST_PAGE_SIZE}&page=${page}`,
			]),
		);
		return artifacts.map((artifact) => ({
			id: artifact.id,
			name: artifact.name,
			size: artifact.size_in_bytes,
			createdAt: artifact.created_at,
			expired: artifact.expired,
			runId: artifact.workflow_run?.id ?? null,
		}));
	};
}

export function downloadArtifacts({
	repository,
	outputDir,
	since = null,
	maxRuns = MAX_RUNS_PER_NIGHT,
	names = ARTIFACT_NAMES,
	now = Date.now(),
}) {
	fs.mkdirSync(outputDir, { recursive: true });
	const listed = listArtifacts(
		fetchPageFor(repository),
		windowFor(since, now).listCutoffMs,
	);
	const selection = selectArtifacts(listed, { since, now, maxRuns, names });
	for (const artifact of selection.artifacts)
		runGh([`/repos/${repository}/actions/artifacts/${artifact.id}/zip`], {
			outputFile: path.join(outputDir, `${artifact.id}.zip`),
		});
	return selection;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const parsed = options(process.argv.slice(2));
		const selection = downloadArtifacts(parsed);
		const line = `test-history download: ${selection.runs.length} run(s), ${selection.artifacts.length} artifact(s) of ${selection.eligibleRuns} eligible run(s) after ${parsed.since ?? "no watermark"}; ${selection.metadataOnly} metadata-only skipped${selection.capped ? `; capped at ${parsed.maxRuns} runs, the rest wait for the next night` : ""}`;
		console.log(line);
		if (process.env.GITHUB_STEP_SUMMARY)
			fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n\n`);
	} catch (error) {
		console.error(
			error instanceof Error ? error.message.trim() : String(error),
		);
		process.exitCode = 1;
	}
}
