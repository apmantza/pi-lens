#!/usr/bin/env node
/**
 * Nightly Stryker test-adequacy report: the state and body halves (#4005).
 *
 * `.github/workflows/stryker-nightly.yml` runs `scripts/stryker-diff.mjs` over
 * `<last-report-sha>..HEAD` on master and files ONE rolling tracking issue
 * through `scripts/upsert-tracking-issue.mjs`. This script owns the two steps
 * around the driver:
 *
 *   node scripts/stryker-nightly.mjs base --issues FILE --title TITLE
 *     [--pending-out FILE]
 *     Prints GITHUB_OUTPUT lines `base=<sha>`, `source=<issue|fallback-no-issue|
 *     fallback-bad-sha>` and `pending=<count>`. The last-report sha is the
 *     marker the previous report left in the tracking issue's body (`gh issue
 *     list --json title,body` output in FILE); no readable marker, or one that
 *     is not an ancestor of HEAD, falls back to the first commit older than 24
 *     hours. The carry-over queue (below) is written to --pending-out, one
 *     `path@sha` (or bare `path`) per line.
 *
 *   node scripts/stryker-nightly.mjs body --issues FILE --title TITLE
 *     --base SHA --head SHA --source S --status ok|failed --out FILE
 *     [--report JSON] [--outcomes JSON] [--run-url URL]
 *     Writes the issue body. After a COMPLETED run (status ok and a report) the
 *     marker advances to HEAD; a FAILED run leaves the marker and the queue as
 *     they were, so tomorrow's window covers it again.
 *
 *   node scripts/stryker-nightly.mjs combine --shards-dir DIR
 *     --expected-shards 0,1 --window W --out JSON --outcomes JSON
 *     Applies the completeness rule (`combineShards`) to the shard artifacts
 *     under DIR: `--out` gets every shard's report in shard order, or null on a
 *     failed night; `--outcomes` gets the status and per-shard verdicts.
 *
 * Carry-over queue: files a run skipped over the --max-files cap, or took but
 * could not finish (ranges sampled away, a budget-ended run), go on a FIFO
 * queue in the body (`<!-- stryker-nightly:pending=a@sha,b@sha -->`, at most
 * 200; the oldest are dropped and the body says so). The next night mutates the
 * queue first, then the new window by weight, under the same cap, and a queued
 * file that was fully evaluated leaves it.
 *
 * The base rule (#4005 r4, derived from the state-space table on PR #4013):
 * each entry carries its own base, the window base of the night that first
 * left the file unevaluated, kept across re-queues. On read, a base that is not
 * an ancestor of HEAD is dropped (the file stays, read against the window
 * base), and a base older than MAX_BASE_AGE_DAYS is re-based onto the floor
 * commit; the body counts both. No queued file is diffed against an unbounded
 * history. Entries are validated on read (`parseQueueEntry`): an edited issue
 * cannot inject a path outside the runtime tree or a base that is not a sha.
 *
 * Why the issue body and not an artifact or a committed file: it needs no
 * permission beyond the `issues: write` the upsert already holds (an artifact
 * read needs `actions: read`, a committed file needs `contents: write` against
 * a protected master), it is durable (artifacts expire), and a maintainer can
 * reset the window by editing the marker.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import { renderMutationMarkdown } from "./lib/mutation-report-render.mjs";
import {
	formatQueueEntry,
	isQueueablePath,
	parseQueueEntry,
} from "./lib/stryker-diff.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const MARKER_RE = /<!-- stryker-nightly:last-report-sha=([0-9a-f]{40}) -->/;
const PENDING_RE = /<!-- stryker-nightly:pending=([^\n]*?) -->/;
const FALLBACK_WINDOW = "24 hours ago";
export const MAX_PENDING = 200;
// Two weeks of a queued file's history. A first pass through a full queue at
// the 24-file cap waits at most ceil(200 / 24) = 9 nights, and one below
// 14 x 24 = 336 entries under 14, so within capacity nothing is re-based; past
// it, a re-queued (unfinished) file or a queue full for two weeks loses its
// older changes, and the body counts the entries.
export const MAX_BASE_AGE_DAYS = 14;

export const SOURCES = Object.freeze([
	"issue",
	"fallback-no-issue",
	"fallback-bad-sha",
]);

const isPlainObject = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * One shard artifact's verdict under the completeness rule (#4038 r4). An
 * artifact is usable only when all four hold: its record (`shard.json`) parses
 * and names a shard; the record's window stamp is this night's; its report
 * (`mutation.json`) is a mutation report for that shard (object `files`,
 * object `piLensMutationDiff` whose `shardIndex` is the record's); and the
 * driver exited 0 (`complete`) or exited non-zero with `partial` set
 * (`budget-cut`). A non-zero exit whose report carries `dryRunTimeout` is
 * `dry-run-timeout` (#4092): Stryker's initial test run outlasted
 * `dryRunTimeoutMinutes`, so no mutant was evaluated, and the night names that
 * instead of a generic failure. Everything else is `failed` with its reason.
 *
 * @param {{record?: unknown, report?: unknown, reportError?: string}} artifact
 * @param {string} window
 */
export function classifyShardArtifact({ record, report, reportError }, window) {
	if (!isPlainObject(record) || !Number.isInteger(record.shard)) {
		return {
			shard: null,
			outcome: "failed",
			reason: "no readable shard record",
		};
	}
	const { shard, exitCode } = record;
	const failed = (reason) => ({ shard, outcome: "failed", reason });
	if (record.window !== window)
		return failed("artifact is from another window");
	if (reportError !== undefined)
		return failed(`report unreadable: ${reportError}`);
	if (report === undefined)
		return failed(`driver exited ${exitCode} with no report`);
	const meta = report?.piLensMutationDiff;
	if (
		!isPlainObject(report) ||
		!isPlainObject(report.files) ||
		!isPlainObject(meta)
	) {
		return failed("report is not a mutation report");
	}
	if (meta.shardIndex !== shard) {
		return failed(`report is shard ${meta.shardIndex}'s`);
	}
	if (exitCode === 0)
		return { shard, outcome: "complete", reason: null, report };
	if (meta.partial) {
		return { shard, outcome: "budget-cut", reason: null, report };
	}
	if (isPlainObject(meta.dryRunTimeout)) {
		const { minutes, tests, estimatedSeconds } = meta.dryRunTimeout;
		const count = (value, text) => (Number.isFinite(value) ? text(value) : "");
		return {
			shard,
			outcome: "dry-run-timeout",
			reason: `the initial test run exceeded dryRunTimeoutMinutes${count(minutes, (value) => ` (${value})`)}${count(tests, (value) => ` with ${value} test file(s)`)}${count(estimatedSeconds, (value) => `, estimated ${Math.round(value)} s`)}`,
		};
	}
	return failed(`driver exited ${exitCode} without a partial result`);
}

/**
 * The night's status: `ok` only when each expected shard index has exactly one
 * artifact and it is usable (`classifyShardArtifact`); an unexpected or
 * unreadable artifact fails it too. A failed night carries no reports, so the
 * body keeps the marker and every queued `path@sha`.
 *
 * @param {{artifacts: Array<{record?: unknown, report?: unknown, reportError?: string}>, expectedShards: number[], window: string}} options
 */
export function combineShards({ artifacts, expectedShards, window }) {
	const verdicts = artifacts.map((artifact) =>
		classifyShardArtifact(artifact, window),
	);
	const expected = expectedShards.map((shard) => {
		const mine = verdicts.filter((verdict) => verdict.shard === shard);
		if (mine.length === 1) return mine[0];
		return {
			shard,
			outcome: "failed",
			reason: mine.length === 0 ? "missing" : `${mine.length} artifacts`,
		};
	});
	const strays = verdicts
		.filter((verdict) => !expectedShards.includes(verdict.shard))
		.map((verdict) =>
			verdict.outcome === "failed"
				? verdict
				: { ...verdict, outcome: "failed", reason: "unexpected shard" },
		);
	const shards = [...expected, ...strays];
	const status = shards.every(
		({ outcome }) => outcome === "complete" || outcome === "budget-cut",
	)
		? "ok"
		: "failed";
	return {
		status,
		shards: shards.map(({ shard, outcome, reason }) => ({
			shard,
			outcome,
			reason,
		})),
		reports:
			status === "ok" ? expected.map((verdict) => verdict.report) : undefined,
	};
}

// Each `mutation-shard-<n>` directory the publish job downloaded holds the
// shard's `shard.json` record and, when the driver wrote one, `mutation.json`.
function readShardArtifacts(dir) {
	if (!existsSync(dir)) return [];
	const read = (file) => {
		if (!existsSync(file)) return {};
		try {
			return { value: JSON.parse(readFileSync(file, "utf8")) };
		} catch (error) {
			return { error: error?.message ?? String(error) };
		}
	};
	return readdirSync(dir)
		.sort()
		.map((name) => {
			const report = read(join(dir, name, "mutation.json"));
			return {
				record: read(join(dir, name, "shard.json")).value,
				report: report.value,
				reportError: report.error,
			};
		});
}

function runCombine(argv) {
	const expectedShards = valueAfter(argv, "--expected-shards")
		.split(",")
		.filter(Boolean)
		.map(Number);
	if (
		expectedShards.length === 0 ||
		expectedShards.some((index) => !Number.isInteger(index) || index < 0)
	) {
		throw new Error("--expected-shards must be a comma-separated list");
	}
	const result = combineShards({
		artifacts: readShardArtifacts(valueAfter(argv, "--shards-dir")),
		expectedShards,
		window: valueAfter(argv, "--window"),
	});
	writeFileSync(
		valueAfter(argv, "--out"),
		JSON.stringify(result.reports ?? null),
	);
	writeFileSync(
		valueAfter(argv, "--outcomes"),
		JSON.stringify({ status: result.status, shards: result.shards }),
	);
	return result;
}

export const markerOf = (sha) =>
	`<!-- stryker-nightly:last-report-sha=${sha} -->`;

// The pending marker is always written, empty when the queue is: a spoofed
// marker later in the body (a survivor's source text) is never the first match.
const pendingMarker = (entries) =>
	`<!-- stryker-nightly:pending=${entries.map(formatQueueEntry).join(",")} -->`;

/**
 * The carry-over queue the previous report left in the tracking issue's body,
 * as `{file, base}` entries. Every entry is validated (`parseQueueEntry`), the
 * list is deduped by file (first wins) and bounded; anything else is ignored.
 * `git` is the read-side half of the base rule: a base it does not know as an
 * ancestor of HEAD is dropped (counted in `unknownBase`, as is an entry with
 * none), and one older than the floor is re-based onto it (counted in
 * `rebased`; `floor` is that base, null when nothing was re-based). Both steps
 * of the job pass the same oracle (`gitQueueOracle`).
 *
 * @param {{title: string, body?: string}[]} issues
 * @param {string} title
 * @param {{isAncestor: (sha: string) => boolean, floor: string | null, isOlderThanFloor: (sha: string) => boolean}} [git]
 * @returns {{entries: {file: string, base: string | null}[], rebased: number, unknownBase: number, floor: string | null}}
 */
export function parsePending(
	issues,
	title,
	git = { isAncestor: () => true, floor: null, isOlderThanFloor: () => false },
) {
	const body =
		(issues ?? []).find((entry) => entry?.title === title)?.body ?? "";
	const raw = PENDING_RE.exec(body)?.[1] ?? "";
	const byFile = new Map();
	for (const entry of raw.split(",").map(parseQueueEntry)) {
		if (entry && !byFile.has(entry.file)) byFile.set(entry.file, entry.base);
	}
	let rebased = 0;
	let unknownBase = 0;
	const entries = [...byFile].slice(-MAX_PENDING).map(([file, recorded]) => {
		const base =
			recorded !== null && git.isAncestor(recorded) ? recorded : null;
		if (base === null) {
			unknownBase++;
			return { file, base };
		}
		if (git.floor && base !== git.floor && git.isOlderThanFloor(base)) {
			rebased++;
			return { file, base: git.floor };
		}
		return { file, base };
	});
	return {
		entries,
		rebased,
		unknownBase,
		floor: rebased > 0 ? git.floor : null,
	};
}

/**
 * The read-side oracle of the base rule, over the checkout at `cwd`: ancestry
 * of HEAD, and the floor, the newest first-parent commit at least
 * MAX_BASE_AGE_DAYS older than HEAD by committer date (null in a younger
 * repository). Answers are memoised per sha: a queue holds a few distinct
 * bases, one per contributing night.
 *
 * @param {string} cwd
 */
export function gitQueueOracle(cwd) {
	const git = (args) => gitExecFileSync(args, { cwd, encoding: "utf8" }).trim();
	const ancestry = new Map();
	const isAncestor = (sha) => {
		if (!ancestry.has(sha)) {
			try {
				gitExecFileSync(["merge-base", "--is-ancestor", sha, "HEAD"], {
					cwd,
					stdio: "ignore",
				});
				ancestry.set(sha, true);
			} catch {
				ancestry.set(sha, false);
			}
		}
		return ancestry.get(sha);
	};
	// Read on first use only: an empty queue never asks.
	let cutoff;
	let floor;
	const cutoffOf = () =>
		(cutoff ??=
			Number(git(["log", "-1", "--format=%ct", "HEAD"])) -
			MAX_BASE_AGE_DAYS * 86_400);
	return {
		isAncestor,
		get floor() {
			floor ??=
				git([
					"rev-list",
					"--first-parent",
					"--max-count=1",
					`--before=${new Date(cutoffOf() * 1000).toISOString()}`,
					"HEAD",
				]) || null;
			return floor;
		},
		isOlderThanFloor: (sha) =>
			Number(git(["log", "-1", "--format=%ct", sha])) <= cutoffOf(),
	};
}

/**
 * What a COMPLETED night left undone, decided per shard report (#4038 r4):
 * `report` is one report or every shard's, in shard order. `capped` files were
 * never taken; `unfinished` says a report's taken files were not fully
 * evaluated (ranges sampled away, a budget-ended run, ranges not all tried, or
 * a zero-mutant run cut short), and `retry` is those files, minus the ones it
 * could not evaluate at all. All go on the queue; none holds the marker.
 *
 * @param {unknown} report
 * @returns {{capped: string[], unfinished: string[], retry: string[]}}
 */
export function coverageGaps(report) {
	const reports = [report].flat();
	const capped = [];
	const unfinished = [];
	const retry = [];
	reports.forEach((shardReport, index) => {
		const meta = shardReport?.piLensMutationDiff ?? {};
		const notes = shardGaps(meta);
		const prefix =
			reports.length > 1 ? `shard ${meta.shardIndex ?? index}: ` : "";
		capped.push(...(meta.filesSkippedOverCap ?? []).filter(isQueueablePath));
		unfinished.push(...notes.map((note) => `${prefix}${note}`));
		if (notes.length === 0) return;
		const notEvaluable = new Set([
			...(meta.filesUncovered ?? []),
			...(meta.filesNoSourceMap ?? []),
			...(meta.filesNoMutableLines ?? []),
		]);
		retry.push(
			...(meta.filesSelected ?? []).filter(
				(file) => isQueueablePath(file) && !notEvaluable.has(file),
			),
		);
	});
	return { capped, unfinished, retry };
}

function shardGaps(meta) {
	const unfinished = [];
	if (meta.rangesSampled) {
		unfinished.push(
			`sampled ${meta.rangesEvaluated ?? "?"} of ${meta.rangesTotal ?? "?"} changed-line ranges`,
		);
	}
	if (meta.partial) unfinished.push("partial run: the budget ended it");
	const tried = meta.rangesEvaluated;
	const total = meta.rangesTotal;
	if (
		typeof tried === "number" &&
		typeof total === "number" &&
		tried < total &&
		!meta.rangesSampled &&
		!meta.partial
	) {
		unfinished.push(`${tried} of ${total} ranges evaluated`);
	}
	// Zero mutants is final when there was nothing to mutate (an early exit
	// carries no range count, or the dry run measured none) or every range was
	// tried; a budget below the fixed overhead measured mutants it never ran.
	if (
		meta.zeroMutants &&
		unfinished.length === 0 &&
		typeof total === "number" &&
		meta.measuredTotalMutants !== 0 &&
		!(typeof tried === "number" && tried >= total)
	) {
		unfinished.push("no mutant was evaluated and the dry run measured some");
	}
	return unfinished;
}

/**
 * The queue after a night; `report` is one report or every shard's. A FAILED
 * run (anything but status ok with a report per shard) changes nothing. A
 * completed run drops the queued files it took, queues the
 * files it skipped over the cap, and re-queues at the back the files it took
 * but could not finish. Entries that no longer exist or are no longer
 * runtime-scoped drop silently; beyond MAX_PENDING the oldest drop and are
 * counted. The write-side half of the base rule: an entry keeps the base it
 * was read with, and a file new to the queue (or read without one) gets this
 * night's window base, where its unevaluated changes start.
 *
 * @param {{oldEntries: {file: string, base: string | null}[], base: string, status: string, report?: unknown, exists: (file: string) => boolean}} options
 * @returns {{entries: {file: string, base: string | null}[], dropped: number, completed: boolean}}
 */
export function nextQueue({ oldEntries, base, status, report, exists }) {
	const reports = [report].flat();
	if (
		status !== "ok" ||
		reports.length === 0 ||
		reports.some((entry) => !entry?.piLensMutationDiff)
	) {
		return { entries: oldEntries, dropped: 0, completed: false };
	}
	const oldBase = new Map(oldEntries.map((entry) => [entry.file, entry.base]));
	const { capped, retry } = coverageGaps(reports);
	const taken = new Set(
		reports.flatMap((entry) =>
			(entry.piLensMutationDiff.filesSelected ?? []).filter(isQueueablePath),
		),
	);
	const kept = [...oldBase.keys()].filter((file) => !taken.has(file));
	const all = [...new Set([...kept, ...capped, ...retry])].filter(
		(file) => isQueueablePath(file) && exists(file),
	);
	const dropped = Math.max(0, all.length - MAX_PENDING);
	return {
		entries: all
			.slice(dropped)
			.map((file) => ({ file, base: oldBase.get(file) ?? base })),
		dropped,
		completed: true,
	};
}

/**
 * The sha the previous report recorded in the tracking issue's body, or null.
 * `issues` is `gh issue list --json title,body`; the issue is found by exact
 * title, as `upsertTrackingIssue` finds it, so an unrelated issue carrying the
 * label (or a marker pasted in a comment-like body elsewhere) never counts.
 *
 * @param {{title: string, body?: string}[]} issues
 * @param {string} title
 * @returns {string | null}
 */
export function parseLastReportSha(issues, title) {
	const issue = (issues ?? []).find((entry) => entry?.title === title);
	return MARKER_RE.exec(issue?.body ?? "")?.[1] ?? null;
}

/**
 * @param {{issues: {title: string, body?: string}[], title: string, isAncestor: (sha: string) => boolean, fallbackBase: () => string}} options
 * @returns {{base: string, source: "issue" | "fallback-no-issue" | "fallback-bad-sha"}}
 */
export function pickBase({ issues, title, isAncestor, fallbackBase }) {
	const recorded = parseLastReportSha(issues, title);
	if (recorded === null) {
		return { base: fallbackBase(), source: "fallback-no-issue" };
	}
	if (!isAncestor(recorded)) {
		return { base: fallbackBase(), source: "fallback-bad-sha" };
	}
	return { base: recorded, source: "issue" };
}

// GitHub rejects an issue body over 65536 characters. The survivor table is
// bounded below; this is the hard stop for everything else a report can carry.
const MAX_BODY_CHARS = 60_000;
const MAX_SURVIVORS = 50;

/**
 * `previous` is the queue as `parsePending` read it, with its counts.
 * `report` is one report or every shard's; `shards` is `combineShards`'
 * per-shard verdicts, rendered so a failed night names its cause.
 *
 * @param {{base: string, head: string, source: string, status: "ok" | "failed", report?: unknown, shards?: {shard: number | null, outcome: string, reason: string | null}[], runUrl?: string, previous?: ReturnType<typeof parsePending>, exists?: (file: string) => boolean}} options
 * @returns {string}
 */
export function buildNightlyBody({
	base,
	head,
	source,
	status,
	report,
	shards,
	runUrl,
	previous = { entries: [], rebased: 0, unknownBase: 0, floor: null },
	exists = () => true,
}) {
	const queue = nextQueue({
		oldEntries: previous.entries,
		base,
		status,
		report,
		exists,
	});
	const timedOut = (shards ?? [])
		.filter(({ outcome }) => outcome === "dry-run-timeout")
		.map(({ shard }) => shard ?? "?");
	const gaps = queue.completed ? coverageGaps(report) : null;
	const notes = gaps
		? [
				...(gaps.capped.length > 0
					? [`${gaps.capped.length} file(s) skipped over the --max-files cap`]
					: []),
				...gaps.unfinished,
			]
		: [];
	const lines = [
		markerOf(queue.completed ? head : base),
		pendingMarker(queue.entries),
		"Updated nightly by the `Stryker nightly` workflow (#4005). **An exploratory test-adequacy report; it gates nothing.** Survivors on added runtime lines are candidates for a missing test, not defects: read each through a real caller before acting.",
		"",
		`- **Window:** \`${base.slice(0, 12)}..${head.slice(0, 12)}\` (base from: ${source})`,
		queue.completed
			? "- **Status:** ok"
			: `- **Status:** FAILED${timedOut.length > 0 ? ` (dry-run timeout in shard ${timedOut.join(", ")}: no mutant was evaluated)` : ""} -- the driver did not finish; the marker and the carry-over queue are unchanged, so the next night's window covers this one again`,
		`- **Coverage:** ${queue.completed ? (notes.length === 0 ? "the whole window was evaluated" : `not complete: ${notes.join("; ")}`) : "n/a"}`,
		`- **Carry-over queue:** ${queue.entries.length} file(s) (FIFO, at most ${MAX_PENDING}; the next night mutates these first, under the same cap, each against its own base, at most ${MAX_BASE_AGE_DAYS} days old)${queue.dropped > 0 ? `; ${queue.dropped} oldest file(s) were dropped because the queue overflowed` : ""}${previous.rebased > 0 ? `; ${previous.rebased} queued file(s) had a base older than ${MAX_BASE_AGE_DAYS} days and were re-based onto \`${previous.floor?.slice(0, 12)}\`, so their earlier changes are not evaluated` : ""}${previous.unknownBase > 0 ? `; ${previous.unknownBase} queued file(s) had no base git knows as an ancestor and were read against the window base` : ""}`,
	];
	if (shards?.length) {
		lines.push(
			`- **Shards:** ${shards.map(({ shard, outcome, reason }) => `${shard ?? "?"} ${outcome}${reason ? ` (${reason})` : ""}`).join("; ")}`,
		);
	}
	if (runUrl) lines.push(`- **Run:** ${runUrl}`);
	if (queue.entries.length > 0) {
		lines.push(
			"",
			`<details><summary>Queued files (${queue.entries.length})</summary>\n\n${queue.entries.map(({ file, base: since }) => `- \`${file}\` since \`${since?.slice(0, 12)}\``).join("\n")}\n\n</details>`,
		);
	}
	lines.push(
		"",
		"Kill criterion (#4005): remove this lane when two consecutive reports record no product defect and the #3982 benchmark does not make it cheap.",
		"",
	);
	const reports = [report ?? []].flat();
	lines.push(
		reports.length === 0
			? "No mutation report was produced for this window."
			: reports.length === 1
				? renderMutationMarkdown(reports[0], { maxSurvivors: MAX_SURVIVORS })
				: reports
						.map(
							(shardReport, index) =>
								`### Shard ${shardReport.piLensMutationDiff?.shardIndex ?? index}\n\n${renderMutationMarkdown(
									shardReport,
									{ maxSurvivors: Math.ceil(MAX_SURVIVORS / reports.length) },
								)}`,
						)
						.join("\n\n"),
	);
	const body = `${lines.join("\n")}\n`;
	if (body.length <= MAX_BODY_CHARS) return body;
	return `${body.slice(0, MAX_BODY_CHARS)}\n\n_Report truncated at ${MAX_BODY_CHARS} characters; the full report is in the \`mutation-report\` workflow artifact (kept 90 days)._\n`;
}

function valueAfter(argv, flag, fallback) {
	const index = argv.indexOf(flag);
	if (index < 0) {
		if (fallback !== undefined) return fallback;
		throw new Error(`${flag} is required`);
	}
	const value = argv[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${flag} requires a value`);
	return value;
}

function runBase(argv, cwd) {
	const git = (args) => gitExecFileSync(args, { cwd, encoding: "utf8" }).trim();
	const issues = JSON.parse(readFileSync(valueAfter(argv, "--issues"), "utf8"));
	const title = valueAfter(argv, "--title");
	const oracle = gitQueueOracle(cwd);
	const picked = pickBase({
		issues,
		title,
		isAncestor: oracle.isAncestor,
		fallbackBase: () =>
			git([
				"rev-list",
				"--max-count=1",
				`--before=${FALLBACK_WINDOW}`,
				"HEAD",
			]) || git(["rev-list", "--max-parents=0", "HEAD"]).split("\n")[0],
	});
	if (picked.source !== "issue") {
		console.error(
			`stryker-nightly: no usable last-report sha (${picked.source}); window starts at ${picked.base}`,
		);
	}
	const queue = parsePending(issues, title, oracle);
	const pendingOut = valueAfter(argv, "--pending-out", "");
	if (pendingOut) {
		writeFileSync(
			pendingOut,
			queue.entries.map((entry) => `${formatQueueEntry(entry)}\n`).join(""),
		);
	}
	return { ...picked, queue };
}

function runBody(argv, cwd) {
	const reportPath = valueAfter(argv, "--report", "");
	const outcomesPath = valueAfter(argv, "--outcomes", "");
	const status = valueAfter(argv, "--status");
	if (status !== "ok" && status !== "failed") {
		throw new Error("--status must be ok or failed");
	}
	// The same read as the `base` step's (same HEAD, same oracle), so the bases
	// written back are the ones the driver was given.
	const previous = parsePending(
		JSON.parse(readFileSync(valueAfter(argv, "--issues"), "utf8")),
		valueAfter(argv, "--title"),
		gitQueueOracle(cwd),
	);
	const body = buildNightlyBody({
		previous,
		exists: (file) => existsSync(join(cwd, file)),
		base: valueAfter(argv, "--base"),
		head: valueAfter(argv, "--head"),
		source: valueAfter(argv, "--source"),
		status,
		report:
			reportPath && existsSync(reportPath)
				? JSON.parse(readFileSync(reportPath, "utf8")) || undefined
				: undefined,
		shards: outcomesPath
			? JSON.parse(readFileSync(outcomesPath, "utf8")).shards
			: undefined,
		runUrl: valueAfter(argv, "--run-url", ""),
	});
	writeFileSync(valueAfter(argv, "--out"), body);
	return body;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
	const [command, ...rest] = argv;
	if (command === "base") return runBase(rest, cwd);
	if (command === "body") return runBody(rest, cwd);
	if (command === "combine") return runCombine(rest);
	throw new Error("usage: stryker-nightly.mjs base|body|combine ...");
}

if (isMainModule(import.meta.url)) {
	try {
		const result = main();
		// Only `base` prints: GITHUB_OUTPUT lines for the workflow to append.
		// `combine` also returns an object, and reading `result.queue` off it
		// crashed every CLI combine after its files were written (run
		// 37601788256).
		if (process.argv[2] === "base") {
			console.log(
				`base=${result.base}\nsource=${result.source}\npending=${result.queue.entries.length}`,
			);
		}
	} catch (error) {
		console.error(`stryker-nightly: failed: ${error?.message ?? error}`);
		process.exitCode = 1;
	}
}
