import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonReporter } from "vitest/node";
import {
	METADATA_FILENAME,
	rollupTestHistory,
	rowsFromArtifacts,
	runCli,
} from "../../scripts/test-history-rollup.mjs";

const roots: string[] = [];
const validHead = "a".repeat(40);
const repoRoot = path.resolve(import.meta.dirname, "../..");
/**
 * The real `unit-test-results-linux` artifact of CI run 35918869980, downloaded
 * with `gh run download 35918869980 -n unit-test-results-linux` and trimmed to
 * three of its 1,165 result entries (one assertion each). Its two basenames and
 * every field the rollup reads are verbatim.
 */
const realArtifact = path.join(
	repoRoot,
	"tests/fixtures/test-history/run-35918869980",
);

afterEach(() => {
	vi.restoreAllMocks();
	roots
		.splice(0)
		.forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

function tempRoot() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-test-history-"));
	roots.push(root);
	return root;
}

/** Always through the shared basename constant, never a literal. */
function writeMetadata(directory: string, metadata: Record<string, unknown>) {
	fs.writeFileSync(
		path.join(directory, METADATA_FILENAME),
		JSON.stringify(metadata),
	);
}

function fixture() {
	const root = tempRoot();
	const artifact = path.join(root, "artifact");
	fs.mkdirSync(artifact);
	writeMetadata(artifact, {
		headSha: validHead,
		runId: 101,
		lane: "linux",
		recordedAt: "2026-09-22T00:00:00.000Z",
	});
	fs.writeFileSync(
		path.join(artifact, "vitest.json"),
		JSON.stringify({
			testResults: [
				{ name: "tests/flaky.test.ts", status: "failed", duration: 12 },
				{ name: "tests/steady.test.ts", status: "passed", duration: 8 },
			],
		}),
	);
	return { root, artifact };
}

/** Runs the exported CLI arm in process and captures its bounded output. */
function cli(args: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	vi.spyOn(console, "log").mockImplementation((line) => out.push(String(line)));
	vi.spyOn(console, "error").mockImplementation((line) =>
		err.push(String(line)),
	);
	// The rollup appends to GITHUB_STEP_SUMMARY when it is set; the Unit tests
	// lane sets it, and a test must not write into the job's own summary.
	vi.stubEnv("GITHUB_STEP_SUMMARY", "");
	const exitCode = runCli(args);
	return { exitCode, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("test-history-rollup real entry point", () => {
	it("writes one row per test file and identifies same-head pass/fail evidence", () => {
		const { root, artifact } = fixture();
		const second = path.join(root, "artifact-2");
		fs.mkdirSync(second);
		writeMetadata(second, {
			headSha: validHead,
			runId: 102,
			lane: "linux",
			recordedAt: "2026-09-22T01:00:00.000Z",
		});
		fs.writeFileSync(
			path.join(second, "vitest.json"),
			JSON.stringify({
				testResults: [
					{ name: "tests/flaky.test.ts", status: "passed", duration: 10 },
				],
			}),
		);
		const history = path.join(root, "history.ndjson");
		const summary = path.join(root, "summary.json");
		const output = rollupTestHistory({
			artifactPaths: [artifact, second],
			historyPath: history,
			summaryPath: summary,
			now: Date.parse("2026-09-23T00:00:00.000Z"),
		});
		// Two runs on one head are two observations (#3447): flaky fails in run
		// 101 and passes in 102, and the journal keeps both, plus steady.
		expect(output.rowCount).toBe(3);
		expect(output.flakeCandidates).toEqual([
			{ file: "tests/flaky.test.ts", headSha: validHead },
		]);
		expect(fs.readFileSync(history, "utf8").trim().split("\n")).toHaveLength(3);
		expect(JSON.parse(fs.readFileSync(summary, "utf8")).files).toEqual(
			expect.arrayContaining([
				{
					file: "tests/flaky.test.ts",
					passCount: 1,
					failCount: 1,
					lastFailHead: validHead,
					meanDurationMs: 11,
				},
			]),
		);
	});

	it("keeps a same-head failure and its passing re-run across nightly rollups (#3447)", () => {
		// CI run 36132594277: attempt 1 of Unit tests failed and the job was
		// re-run under the same run id. Both attempts upload an artifact.
		const root = tempRoot();
		const attempt = (runAttempt: number, status: string, at: string) => {
			const dir = path.join(root, `attempt-${runAttempt}`);
			fs.mkdirSync(dir);
			writeMetadata(dir, {
				headSha: validHead,
				runId: 7,
				runAttempt,
				lane: "linux",
				recordedAt: at,
			});
			fs.writeFileSync(
				path.join(dir, "vitest.json"),
				JSON.stringify({
					testResults: [{ name: "tests/race.test.ts", status, duration: 5 }],
				}),
			);
			return dir;
		};
		const failed = attempt(1, "failed", "2026-09-25T12:12:40.000Z");
		const passed = attempt(2, "passed", "2026-09-25T12:30:00.000Z");
		const history = path.join(root, "history.ndjson");
		const summary = path.join(root, "summary.json");
		const now = Date.parse("2026-09-26T11:00:00.000Z");
		rollupTestHistory({
			artifactPaths: [failed, passed],
			historyPath: history,
			summaryPath: summary,
			now,
		});
		// The next night: the same artifacts are downloaded again, and the
		// journal must still hold both observations for the head.
		const nextNight = rollupTestHistory({
			artifactPaths: [failed, passed],
			historyPath: history,
			summaryPath: summary,
			now: now + 24 * 60 * 60 * 1000,
		});
		expect(nextNight.rowCount).toBe(2);
		expect(nextNight.flakeCandidates).toEqual([
			{ file: "tests/race.test.ts", headSha: validHead },
		]);
		// And once the artifacts have expired, from the journal alone.
		const afterExpiry = rollupTestHistory({
			artifactPaths: [],
			historyPath: history,
			summaryPath: summary,
			now: now + 2 * 24 * 60 * 60 * 1000,
		});
		expect(afterExpiry.flakeCandidates).toEqual([
			{ file: "tests/race.test.ts", headSha: validHead },
		]);
	});

	it("prunes rows older than 90 days while retaining current rows", () => {
		const { root, artifact } = fixture();
		const oldHistory = path.join(root, "history.ndjson");
		fs.writeFileSync(
			oldHistory,
			`${JSON.stringify({ headSha: "b".repeat(40), runId: "1", file: "old.test.ts", outcome: "passed", durationMs: 1, lane: "linux", recordedAt: "2026-01-01T00:00:00.000Z" })}\n`,
		);
		const summary = path.join(root, "summary.json");
		const output = rollupTestHistory({
			artifactPaths: [artifact],
			historyPath: oldHistory,
			summaryPath: summary,
			now: Date.parse("2026-09-23T00:00:00.000Z"),
		});
		expect(output.rowCount).toBe(2);
		expect(fs.readFileSync(oldHistory, "utf8")).not.toContain(
			'"headSha":"old"',
		);
	});

	// Round 3 F8: the producer uploaded `test-history-metadata.json` while the
	// consumer looked for a sibling `metadata.json`, so the rollup exited 2 on
	// every real artifact and lane 1 never wrote a row. This runs the real CLI
	// over the real downloaded artifact layout, so the two basenames cannot
	// drift apart again without a red here.
	it("rolls up the real run-35918869980 artifact layout into durable rows", () => {
		const root = tempRoot();
		const artifacts = path.join(root, "artifacts", "3801234567");
		fs.mkdirSync(artifacts, { recursive: true });
		for (const name of fs.readdirSync(realArtifact))
			fs.copyFileSync(
				path.join(realArtifact, name),
				path.join(artifacts, name),
			);
		expect(fs.readdirSync(artifacts).sort()).toEqual([
			METADATA_FILENAME,
			"vitest-results.json",
		]);
		const history = path.join(root, "history.ndjson");
		const summary = path.join(root, "summary.json");
		const result = cli([
			"--artifact-dir",
			path.join(root, "artifacts"),
			"--history",
			history,
			"--summary",
			summary,
			"--now",
			"2026-09-24T00:00:00.000Z",
		]);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("test-history: 3 rows, 3 files");
		const rows = fs
			.readFileSync(history, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(rows).toHaveLength(3);
		// The real metadata's identity, verbatim from the downloaded artifact.
		expect(new Set(rows.map((row) => row.headSha))).toEqual(
			new Set(["a5a44be4f846291cd8bf470c8a69973579958fd6"]),
		);
		expect(new Set(rows.map((row) => row.runId))).toEqual(
			new Set(["35918869980"]),
		);
		// Real vitest names a file by its absolute runner path, and every entry
		// in that run passed. `durationMs` comes from endTime - startTime,
		// because real per-file entries carry no `duration` field.
		expect(
			rows.find((row) =>
				String(row.file).endsWith("tests/real-harness/child-exit.test.ts"),
			),
		).toMatchObject({
			file: "/home/runner/work/pi-lens/pi-lens/tests/real-harness/child-exit.test.ts",
			outcome: "passed",
			lane: "linux",
			recordedAt: "2026-09-23T21:10:42.273Z",
		});
		expect(rows.every((row) => Number(row.durationMs) > 0)).toBe(true);
	});

	// Round 3 F8, the other direction: a results file with no metadata beside it
	// must stay a bounded failure rather than silently inventing an identity.
	it("fails bounded when the metadata basename is absent", () => {
		const root = tempRoot();
		const artifact = path.join(root, "artifact");
		fs.mkdirSync(artifact);
		fs.copyFileSync(
			path.join(realArtifact, "vitest-results.json"),
			path.join(artifact, "vitest-results.json"),
		);
		const history = path.join(root, "history.ndjson");
		const result = cli([
			"--artifact-dir",
			artifact,
			"--history",
			history,
			"--summary",
			path.join(root, "summary.json"),
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("headSha must be a 40-hex SHA");
		expect(fs.existsSync(history)).toBe(false);
	});

	it("rejects malformed metadata head SHAs with the CLI's bounded error exit", () => {
		const { root, artifact } = fixture();
		writeMetadata(artifact, {
			headSha: "x",
			runId: 101,
			lane: "linux",
			recordedAt: "2026-09-22T00:00:00.000Z",
		});
		const history = path.join(root, "history.ndjson");
		const result = cli([
			"--artifact-dir",
			artifact,
			"--history",
			history,
			"--summary",
			path.join(root, "summary.json"),
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("headSha must be a 40-hex SHA");
		expect(fs.existsSync(history)).toBe(false);
	});

	// Round 3 F7: `/^[0-9a-f]{40}$/i` accepted an uppercase 40-hex head and
	// persisted it. Git never emits one, and an uppercase twin would key as a
	// second head for the same commit, splitting same-head flake evidence.
	it("rejects an uppercase 40-hex head SHA", () => {
		const { root, artifact } = fixture();
		writeMetadata(artifact, {
			headSha: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
			runId: 101,
			lane: "linux",
			recordedAt: "2026-09-22T00:00:00.000Z",
		});
		const history = path.join(root, "history.ndjson");
		const result = cli([
			"--artifact-dir",
			artifact,
			"--history",
			history,
			"--summary",
			path.join(root, "summary.json"),
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("headSha must be a 40-hex SHA");
		expect(fs.existsSync(history)).toBe(false);
	});

	// Round 3 F7, the reader side: an uppercase head already on the data branch
	// must not be carried forward either.
	it("refuses to read an uppercase head SHA out of existing history", () => {
		const { root, artifact } = fixture();
		const history = path.join(root, "history.ndjson");
		fs.writeFileSync(
			history,
			`${JSON.stringify({ headSha: "ABCDEF0123456789ABCDEF0123456789ABCDEF01", runId: "1", file: "old.test.ts", outcome: "passed", durationMs: 1, lane: "linux", recordedAt: "2026-09-22T00:00:00.000Z" })}\n`,
		);
		const result = cli([
			"--artifact-dir",
			artifact,
			"--history",
			history,
			"--summary",
			path.join(root, "summary.json"),
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("headSha must be a 40-hex SHA");
	});
});

/**
 * Round 3 F9 replacement for a `spawnSync("npm test")` pair. The additive
 * console line and the artifact schema both belong to the installed vitest
 * (5.0.0), whose `JsonReporter` is a public `vitest/node` export — so the
 * contract is pinned by driving that real upstream class in process, at a true
 * library boundary, instead of admitting two real child processes to the
 * flake-shape ratchet. The reporter is upstream code, not a double of our
 * assumption about it.
 */
describe("vitest JsonReporter contract the CI producer relies on", () => {
	it("emits exactly one JSON-report line and a schema rowsFromArtifacts reads", async () => {
		const root = tempRoot();
		const outputFile = path.join(root, "vitest-results.json");
		const logged: string[] = [];
		const reporter = new JsonReporter({ outputFile });
		reporter.onInit({
			logger: {
				log: (line: unknown) => logged.push(String(line)),
				warn: (line: unknown) => logged.push(`warn: ${String(line)}`),
			},
			config: { root, passWithNoTests: true },
			snapshot: { summary: {} },
		} as unknown as Parameters<JsonReporter["onInit"]>[0]);
		const test = {
			type: "test",
			name: "keeps one row per file",
			mode: "run",
			meta: {},
			tags: [],
			result: { state: "pass", duration: 7, startTime: 1_000 },
		};
		const fileTask = {
			type: "suite",
			name: "probe.test.ts",
			filepath: "/home/runner/work/pi-lens/pi-lens/tests/probe.test.ts",
			mode: "run",
			result: { state: "pass" },
			tasks: [test],
		};
		await reporter.onTestRunEnd([{ task: fileTask }] as unknown as Parameters<
			JsonReporter["onTestRunEnd"]
		>[0]);

		// The exact additive console contract the `Run tests` step accepts: one
		// line, that text, the resolved output path — and nothing else.
		expect(logged).toEqual([`JSON report written to ${outputFile}`]);

		// The same file the producer uploads, consumed by the real rollup seam.
		writeMetadata(root, {
			headSha: validHead,
			runId: "7",
			lane: "linux",
			recordedAt: "2026-09-23T00:00:00.000Z",
		});
		expect(rowsFromArtifacts([root])).toEqual([
			{
				headSha: validHead,
				runId: "7",
				file: "/home/runner/work/pi-lens/pi-lens/tests/probe.test.ts",
				outcome: "passed",
				durationMs: 7,
				lane: "linux",
				recordedAt: "2026-09-23T00:00:00.000Z",
			},
		]);
	});
});
