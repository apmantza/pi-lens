import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
	LIST_LOOKBACK_MS,
	METADATA_ONLY_MAX_BYTES,
	SELECT_OVERLAP_MS,
	type ListedArtifact,
	listArtifacts,
	selectArtifacts,
} from "../../scripts/download-test-history-artifacts.mjs";

// flake-shape: real-process-spawn — only a real gh child boundary can prove that a transient API failure is retried, a persistent failure stays fatal, and a ZIP of any size reaches its file.

const roots: string[] = [];
const script = path.resolve(
	import.meta.dirname,
	"../../scripts/download-test-history-artifacts.mjs",
);

afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const watermark = "2026-10-01T06:00:00.000Z";
const at = (offsetMs: number) =>
	new Date(Date.parse(watermark) + offsetMs).toISOString();
let nextId = 1;
function artifact(
	runId: number,
	createdAt: string,
	overrides: Partial<ListedArtifact> = {},
): ListedArtifact {
	return {
		id: nextId++,
		name: "unit-test-results-linux-shard-1",
		size: 250_000,
		createdAt,
		expired: false,
		runId,
		...overrides,
	};
}
const select = (artifacts: ListedArtifact[], maxRuns?: number) =>
	selectArtifacts(artifacts, {
		since: watermark,
		now: Date.parse(watermark) + 24 * HOUR,
		...(maxRuns === undefined ? {} : { maxRuns }),
	});
const runIds = (selection: ReturnType<typeof select>) =>
	selection.runs.map((run) => run.runId);

/**
 * #4030 review F2/F4: the first fix took the newest artifact per shard name,
 * about 1 in 45 runs, and no test pinned the selection (sorting oldest-first
 * left the suite green). Ingest is incremental now: every run newer than the
 * journal's watermark, in whole runs, capped per night.
 */
describe("incremental artifact selection (#4030)", () => {
	it("selects every run with an artifact after the watermark, within the overlap, and none before", () => {
		const selection = select([
			artifact(1, at(-SELECT_OVERLAP_MS - 1)),
			artifact(2, at(-SELECT_OVERLAP_MS + 60_000)),
			artifact(3, at(2 * HOUR)),
			artifact(4, at(5 * HOUR)),
		]);
		expect(runIds(selection)).toEqual(["2", "3", "4"]);
		expect(selection.eligibleRuns).toBe(3);
		expect(selection.capped).toBe(false);
	});

	it("caps a night in whole runs, oldest first, and leaves the rest newer than anything it took", () => {
		// Run 10's shards finish at +1h and +3h, run 11 at +2h, run 12 at +4h.
		const parts = [
			artifact(10, at(1 * HOUR)),
			artifact(10, at(3 * HOUR), { name: "unit-test-results-linux-shard-2" }),
			artifact(11, at(2 * HOUR)),
			artifact(12, at(4 * HOUR)),
		];
		const selection = select(parts, 2);
		// Ordered by each run's newest part: 11 (+2h), 10 (+3h), then 12 (+4h).
		expect(runIds(selection)).toEqual(["11", "10"]);
		// No run is split: both of run 10's parts come with it.
		expect(selection.artifacts.map((entry) => entry.runId)).toEqual([
			11, 10, 10,
		]);
		expect(selection.capped).toBe(true);
		// The run left for the next night is newer than every part taken, so a
		// watermark advanced to this night's newest row still selects it.
		const taken = Math.max(
			...selection.artifacts.map((entry) => Date.parse(entry.createdAt)),
		);
		expect(Date.parse(at(4 * HOUR))).toBeGreaterThan(taken);
		expect(
			runIds(
				selectArtifacts(parts, {
					since: new Date(taken).toISOString(),
					now: Date.parse(watermark) + 24 * HOUR,
				}),
			),
		).toContain("12");
	});

	it("downloads every listed part of a re-run, including attempt-1 parts from before the watermark", () => {
		const selection = select([
			artifact(20, at(-10 * HOUR)),
			artifact(20, at(-9 * HOUR), { name: "unit-test-results-linux-shard-2" }),
			artifact(20, at(6 * HOUR), { name: "unit-test-results-linux-shard-3" }),
		]);
		expect(runIds(selection)).toEqual(["20"]);
		expect(selection.artifacts).toHaveLength(3);
	});

	it("skips metadata-only, expired, foreign-named and pre-lookback artifacts", () => {
		const selection = select([
			artifact(30, at(HOUR), { size: METADATA_ONLY_MAX_BYTES }),
			artifact(31, at(HOUR), { expired: true }),
			artifact(32, at(HOUR), { name: "unit-test-build-abc" }),
			artifact(33, at(-LIST_LOOKBACK_MS - 1)),
			artifact(34, at(HOUR), { size: METADATA_ONLY_MAX_BYTES + 1 }),
		]);
		expect(runIds(selection)).toEqual(["34"]);
		expect(selection.metadataOnly).toBe(1);
	});

	it("starts from the lookback window when there is no watermark", () => {
		const now = Date.parse(watermark);
		const selection = selectArtifacts(
			[
				artifact(40, new Date(now - LIST_LOOKBACK_MS - 2 * HOUR).toISOString()),
				artifact(41, new Date(now - HOUR).toISOString()),
			],
			{ since: null, now },
		);
		expect(runIds(selection)).toEqual(["41"]);
	});
});

describe("artifact listing pages (#4030)", () => {
	const cutoff = Date.parse(watermark);
	it("stops at the first page with nothing newer than the cutoff", () => {
		const pages = [
			[artifact(1, at(HOUR)), artifact(2, at(-HOUR))],
			[artifact(3, at(-2 * HOUR)), artifact(4, at(-3 * HOUR))],
			[artifact(5, at(-4 * HOUR))],
		];
		const asked: number[] = [];
		const listed = listArtifacts((page) => {
			asked.push(page);
			return pages[page - 1] ?? [];
		}, cutoff);
		expect(asked).toEqual([1, 2]);
		expect(listed.map((entry) => entry.runId)).toEqual([1, 2, 3, 4]);
	});

	it("stops at an empty page and refuses to page past its bound", () => {
		expect(
			listArtifacts(
				(page) => (page === 1 ? [artifact(1, at(HOUR))] : []),
				cutoff,
			),
		).toHaveLength(1);
		// A listing that never reaches the cutoff stops at the bound, loudly.
		let asked = 0;
		expect(() =>
			listArtifacts(
				() => {
					asked += 1;
					return [artifact(1, at(HOUR))];
				},
				cutoff,
				3,
			),
		).toThrow(/passed 3 pages without reaching 2026-10-01T06:00:00.000Z/);
		expect(asked).toBe(3);
	});
});

type Mode =
	| "transient"
	| "persistent"
	| "large"
	| "truncated"
	| "notFound"
	| "otherJson";
const LARGE_ZIP_BYTES = 1.5 * 1024 * 1024;

function fakeGh(mode: Mode) {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-history-download-"),
	);
	roots.push(root);
	const bin = path.join(root, "bin");
	const output = path.join(root, "artifacts");
	fs.mkdirSync(bin);
	const zipCalls = path.join(root, "zip-calls");
	const listCalls = path.join(root, "list-calls");
	const listed = JSON.stringify({
		id: 101,
		name: "unit-test-results-linux",
		size: 300_000,
		createdAt: new Date().toISOString(),
		expired: false,
		runId: 7,
	});
	const zipBody = {
		transient:
			"if [ \"$count\" -lt 4 ]; then printf '%s\\n' 'gh: HTTP 503' >&2; exit 1; fi; printf 'zip-bytes'",
		persistent: "printf '%s\\n' 'gh: HTTP 503' >&2; exit 1",
		large: `head -c ${LARGE_ZIP_BYTES} /dev/zero`,
		truncated: "printf 'zip-bytes'",
		notFound: "printf 'zip-bytes'",
		otherJson: "printf 'zip-bytes'",
	}[mode];
	// Listing faults: the `gh api --jq` listing on a cut-off body (#5154, the
	// reported failure), a non-retryable 404 (the control), and another JSON
	// error that must stay fatal (the #5154 review F1 control).
	const listFault = {
		transient: "",
		persistent: "",
		large: "",
		truncated: `if [ "$listCount" -lt 2 ]; then printf '%s\\n' 'unexpected end of JSON input' >&2; exit 1; fi`,
		notFound: "printf '%s\\n' 'gh: Not Found (HTTP 404)' >&2; exit 1",
		otherJson:
			"printf '%s\\n' 'json: cannot unmarshal string into Go value of type int' >&2; exit 1",
	}[mode];
	fs.writeFileSync(
		path.join(bin, "gh"),
		`#!/bin/sh
case "$*" in
  *actions/artifacts\\?per_page=100\\&page=1*)
    listCount=0
    [ -f ${JSON.stringify(listCalls)} ] && listCount=$(cat ${JSON.stringify(listCalls)})
    listCount=$((listCount + 1))
    printf '%s' "$listCount" > ${JSON.stringify(listCalls)}
    ${listFault}
    printf '%s\\n' '${listed}'
    ;;
  *actions/artifacts\\?per_page=100\\&page=*)
    ;;
  */zip)
    count=0
    [ -f ${JSON.stringify(zipCalls)} ] && count=$(cat ${JSON.stringify(zipCalls)})
    count=$((count + 1))
    printf '%s' "$count" > ${JSON.stringify(zipCalls)}
    ${zipBody}
    ;;
esac
`,
	);
	fs.chmodSync(path.join(bin, "gh"), 0o755);
	const run = () =>
		execFileSync(
			process.execPath,
			[script, "--repository", "o/r", "--output-dir", output],
			{
				env: {
					...process.env,
					GITHUB_STEP_SUMMARY: "",
					PATH: `${bin}:${process.env.PATH}`,
					TEST_HISTORY_RETRY_DELAY_MS: "0",
				},
				encoding: "utf8",
				stdio: "pipe",
			},
		);
	const zips = () => Number(fs.readFileSync(zipCalls, "utf8"));
	const listingCalls = () => Number(fs.readFileSync(listCalls, "utf8"));
	return { run, zips, listingCalls, zip: path.join(output, "101.zip") };
}

describe("download-test-history-artifacts process boundary", () => {
	it("retries a transient 5xx and succeeds on the bounded final attempt", () => {
		// Recurrence #4030: the nightly exited on one transient GitHub 503
		// instead of retrying the artifact download.
		const gh = fakeGh("transient");
		expect(gh.run()).toContain(
			"test-history download: 1 run(s), 1 artifact(s) of 1 eligible run(s) after no watermark; 0 metadata-only skipped",
		);
		// Three failed ZIP attempts before recovery.
		expect(gh.zips()).toBe(4);
		expect(fs.readFileSync(gh.zip, "utf8")).toBe("zip-bytes");
	});

	it("fails after the retry bound on a persistent 5xx", () => {
		const gh = fakeGh("persistent");
		expect(() => gh.run()).toThrow();
		// Four bounded ZIP attempts, and no partial ZIP left behind.
		expect(gh.zips()).toBe(4);
		expect(fs.existsSync(gh.zip)).toBe(false);
	});

	// Recurrence #5154 (#5103 closed without the fix): the nightly's `gh api
	// --jq` listing got a cut-off body, `unexpected end of JSON input`, and
	// `isRetryable` retried only HTTP 5xx, so the whole night failed.
	it("retries a listing whose body is cut off (unexpected end of JSON input) and succeeds on the second attempt", () => {
		const gh = fakeGh("truncated");
		expect(gh.run()).toContain(
			"test-history download: 1 run(s), 1 artifact(s) of 1 eligible run(s) after no watermark; 0 metadata-only skipped",
		);
		// The listing ran twice: the cut-off attempt, then the retry.
		expect(gh.listingCalls()).toBe(2);
		expect(fs.readFileSync(gh.zip, "utf8")).toBe("zip-bytes");
	});

	// Control: a 404 is not transient, so the listing fails on its first call.
	it("fails at once on a non-retryable 404 in the listing", () => {
		const gh = fakeGh("notFound");
		expect(() => gh.run()).toThrow(/HTTP 404/);
		expect(gh.listingCalls()).toBe(1);
	});

	// Control (#5154 review F1): only the cut-off literal retries. Any other JSON
	// error stays fatal on its first call. Recurrence: a predicate broadened to
	// every JSON error (`/JSON/i`) would retry this non-transient gh failure
	// four times.
	it("fails at once on another JSON error in the listing (only the cut-off body retries)", () => {
		const gh = fakeGh("otherJson");
		expect(() => gh.run()).toThrow(/cannot unmarshal/);
		expect(gh.listingCalls()).toBe(1);
	});

	// #4030 review F4: `spawnSync`'s default 1 MiB `maxBuffer` failed every ZIP
	// over 1 MiB with a blank error and no retry (probe: 1.5 MiB, exit 1, empty
	// stderr); the legacy artifact was at 87% of it. A ZIP streams to its file.
	it("writes a ZIP larger than the default spawn buffer whole", () => {
		const gh = fakeGh("large");
		gh.run();
		expect(gh.zips()).toBe(1);
		expect(fs.statSync(gh.zip).size).toBe(LARGE_ZIP_BYTES);
	});
});
