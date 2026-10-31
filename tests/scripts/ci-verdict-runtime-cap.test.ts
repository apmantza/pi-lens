// #3920 item 3: a required job's recent runtime against its `timeout-minutes`.
//
// The TLA+ shard cap was only found when pull requests started timing out
// (623-881 s against a 720 s cap), and #4672 then showed the sharper half: a
// 735 s shard was `cancelled` at its own 720 s timeout and reddened a REQUIRED
// check with no model violation. Nothing compared a job's runtime to its cap.
//
// The caps come from the workflow YAML the runner enforces (one source, no
// second table), and the durations come from the check-runs `ci-verdict`
// already fetched (`started_at`/`completed_at` on every row), so the report
// costs no network call of its own. It is non-gating: it never touches the
// exit code.
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { escapeRegExp } from "../../clients/string-utils.js";
import {
	computeVerdict,
	formatRuntimeCapLines,
	readJobTimeCaps,
} from "../../scripts/ci-verdict.mjs";
import {
	checkNamePattern,
	jobCapEntries,
	MAX_RUNTIME_CAP_LINES,
	RUNTIME_CAP_WARN_RATIO,
	runtimeCapLines,
} from "../../scripts/lib/ci-runtime-cap.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

/** The four `TLA+ models (shard k/N)` rows of run 39380875926 attempt 1,
 * captured verbatim (see tests/fixtures/ci-shard-verdict/). */
function realShardRows() {
	const payload = JSON.parse(
		readFileSync(
			join(
				import.meta.dirname,
				"..",
				"fixtures",
				"ci-shard-verdict",
				"tla-cancelled-complete.real.json",
			),
			"utf8",
		),
	) as {
		jobs: Array<{ name: string; started_at: string; completed_at: string }>;
	};
	return payload.jobs.map((job) => ({
		name: job.name,
		started_at: job.started_at,
		completed_at: job.completed_at,
		status: "completed",
		conclusion: "success",
	}));
}

describe("#3920 item 3: a required job's runtime against its cap", () => {
	// The finding the issue asked for: with the cap that shipped, this report
	// names the shard at 102% of its cap BEFORE it loses its teardown race.
	it("names the real 735 s shard at 102% of the 12-minute cap it shipped with", () => {
		const caps = [
			{
				file: ".github/workflows/ci.yml",
				jobId: "tla-shards",
				name: "TLA+ models (shard ...)",
				capMinutes: 12,
				pattern: checkNamePattern(
					"TLA+ models (shard ${{ matrix.shard }}/${{ strategy.job-total }})",
					escapeRegExp,
				),
			},
		];
		const lines = runtimeCapLines({ checkRuns: realShardRows(), caps });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("TLA+ models (shard 4/4)");
		// 06:36:59Z -> 06:49:14Z is 735 s against 720 s.
		expect(lines[0]).toContain("735s of 720s (102%)");
		expect(lines[0]).toContain("at or over its cap");
		expect(lines[0]).toContain("#4672");
		// F8: the row's `gating` field is now consumed, so a reader of the
		// report can tell a cap that blocks a merge from a nightly's advisory
		// one. Before this round the field was computed from a test the loop had
		// already passed (always true) and read nowhere.
		expect(lines[0]).toContain("(gating)");
	});

	// The other direction of the same field: a name on the advisory allowlist
	// carries a timeout-minutes in no workflow here, so the row is injected --
	// what matters is that a non-gating row says so.
	it("marks an advisory row's cap as advisory, not gating", () => {
		const caps = [
			{
				file: "nightly.yml",
				jobId: "slow",
				name: "slow (advisory)",
				capMinutes: 10,
				pattern: checkNamePattern("slow (advisory)", escapeRegExp),
			},
		];
		const lines = runtimeCapLines({
			checkRuns: [
				{
					name: "slow (advisory)",
					started_at: "2026-10-20T07:00:00Z",
					completed_at: "2026-10-20T07:09:00Z",
				},
			],
			caps,
		});
		expect(lines[0]).toContain("(advisory)");
		expect(lines[0]).not.toContain("(gating)");
	});

	// V5a: the marker must agree with the verdict. A check-run from a
	// schedule-only workflow is not a gate on this commit (#4090), so the row
	// is advisory -- and `computeVerdict` scores the same name `gating: false`.
	// Before the fix the report labelled seven nightly jobs `(gating)` while the
	// verdict excused them, so a reader of the report chased a blocker that
	// could not block.
	it("marks a schedule-only nightly row advisory, exactly as the verdict scores it", async () => {
		const caps = await readJobTimeCaps(ROOT);
		const name = "Build combined nightly report";
		const entry = caps.find((candidate) => candidate.pattern.test(name));
		expect(entry, `no cap entry for ${name}`).toBeDefined();
		const checkRun = {
			name,
			workflow_event: "schedule",
			started_at: "2026-10-20T07:00:00Z",
			completed_at: "2026-10-20T08:25:30Z", // 5130 s of a 5400 s cap = 95%
		};
		const lines = runtimeCapLines({ checkRuns: [checkRun], caps });
		expect(lines[0]).toContain(`${name} 5130s of 5400s (95%)`);
		expect(lines[0]).toContain("(advisory)");
		expect(lines[0]).not.toContain("(gating)");
		// The verdict's own answer for the same payload, so the two cannot drift
		// apart again: the row is reported red and still not gating.
		const verdict = computeVerdict(
			{
				check_runs: [
					{
						name: "Unit tests",
						status: "completed",
						conclusion: "success",
						started_at: "2026-10-20T07:00:00Z",
					},
					{
						name: "Lint & type-check",
						status: "completed",
						conclusion: "success",
						started_at: "2026-10-20T07:00:00Z",
					},
					{ ...checkRun, status: "completed", conclusion: "failure" },
				],
			},
			undefined,
			"MERGEABLE",
		);
		const scored = verdict.rows.find((row) => row.name === name);
		expect(scored?.gating).toBe(false);
		expect(verdict.exitCode).toBe(0);
	});

	// And the override still wins (AGENTS.md shape 38): the same schedule-only
	// name gates when branch protection's own list requires it.
	it("keeps a schedule-only name gating when branch protection requires it", () => {
		const caps = [
			{
				file: "stryker-nightly.yml",
				jobId: "publish",
				name: "Build combined nightly report",
				capMinutes: 90,
				pattern: checkNamePattern(
					"Build combined nightly report",
					escapeRegExp,
				),
			},
		];
		const lines = runtimeCapLines({
			checkRuns: [
				{
					name: "Build combined nightly report",
					workflow_event: "schedule",
					started_at: "2026-10-20T07:00:00Z",
					completed_at: "2026-10-20T08:25:30Z",
				},
			],
			caps,
			requiredChecks: ["Build combined nightly report"],
		});
		expect(lines[0]).toContain("(gating)");
	});

	// The size decision this PR made, pinned as behaviour: at the new 20-minute
	// cap the measured shard is at 61%, under the 70% warning line. A regression
	// that silently re-tightens the cap shows up here.
	it("is quiet at the cap this PR measured (20 min, 61% of it)", async () => {
		const caps = await readJobTimeCaps(ROOT);
		const lines = runtimeCapLines({ checkRuns: realShardRows(), caps });
		expect(lines).toHaveLength(1);
		// Four shard rows plus the aggregate row: every one resolves to a cap and
		// every one is under the warning line at 20 min / 30 min.
		expect(lines[0]).toMatch(
			/no job is at 70% of its timeout \(5 job\(s\) measured\)/,
		);
	});

	// A matrix shard is its own subject: the aggregate's own row is seconds of
	// `echo`, and the shard that gets cancelled is the one worth naming.
	it("warns about one shard alone while its aggregate stays far below its cap", () => {
		const caps = [
			{
				file: ".github/workflows/ci.yml",
				jobId: "tla-shards",
				name: "shard",
				capMinutes: 12,
				pattern: checkNamePattern(
					"TLA+ models (shard ${{ matrix.shard }}/${{ strategy.job-total }})",
					escapeRegExp,
				),
			},
			{
				file: ".github/workflows/ci.yml",
				jobId: "tla-models",
				name: "aggregate",
				capMinutes: 10,
				pattern: checkNamePattern("TLA+ models", escapeRegExp),
			},
		];
		const lines = runtimeCapLines({
			checkRuns: [
				{
					name: "TLA+ models (shard 4/4)",
					started_at: "2026-10-20T06:36:59Z",
					completed_at: "2026-10-20T06:46:14Z", // 555 s of 720 s = 77%
				},
				{
					name: "TLA+ models",
					started_at: "2026-10-20T06:49:16Z",
					completed_at: "2026-10-20T06:49:19Z", // 3 s of 600 s
				},
			],
			caps,
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("TLA+ models (shard 4/4)");
		expect(lines[0]).toContain("(77%)");
		expect(lines[0]).toContain("within 30% of its cap");
	});

	it("uses the 70% threshold and the latest run of a name", () => {
		expect(RUNTIME_CAP_WARN_RATIO).toBe(0.7);
		const caps = [
			{
				file: "f.yml",
				jobId: "j",
				name: "Job",
				capMinutes: 10,
				pattern: checkNamePattern("Job", escapeRegExp),
			},
		];
		const lines = runtimeCapLines({
			checkRuns: [
				// an older, slower run of the same name must lose to the newer one
				{
					name: "Job",
					id: 1,
					started_at: "2026-10-20T06:00:00Z",
					completed_at: "2026-10-20T06:09:00Z",
				},
				{
					name: "Job",
					id: 2,
					started_at: "2026-10-20T07:00:00Z",
					completed_at: "2026-10-20T07:01:00Z",
				},
			],
			caps,
		});
		expect(lines[0]).toContain("no job is at 70%");
	});

	it("skips a run with no usable duration instead of guessing one", () => {
		const caps = [
			{
				file: "f.yml",
				jobId: "j",
				name: "Job",
				capMinutes: 1,
				pattern: checkNamePattern("Job", escapeRegExp),
			},
		];
		const lines = runtimeCapLines({
			checkRuns: [{ name: "Job", started_at: "2026-10-20T07:00:00Z" }],
			caps,
		});
		expect(lines[0]).toContain("(0 job(s) measured)");
	});

	it("discloses the jobs it does not print", () => {
		const caps = [
			{
				file: "f.yml",
				jobId: "j",
				name: "Job",
				capMinutes: 1,
				pattern: /^Job [0-9]+$/,
			},
		];
		const checkRuns = Array.from(
			{ length: MAX_RUNTIME_CAP_LINES + 3 },
			(_, index) => ({
				name: `Job ${index}`,
				started_at: "2026-10-20T07:00:00Z",
				completed_at: "2026-10-20T07:00:59Z",
			}),
		);
		const lines = runtimeCapLines({
			checkRuns,
			caps,
			limit: MAX_RUNTIME_CAP_LINES,
		});
		expect(lines).toHaveLength(MAX_RUNTIME_CAP_LINES + 1);
		expect(lines.at(-1)).toContain("+3 more job(s)");
	});

	it("fails open into one bounded line when the workflow tree is unreadable", async () => {
		const lines = await formatRuntimeCapLines({
			checkRuns: realShardRows(),
			root: join(ROOT, "no-such-checkout"),
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Runtime vs cap: unavailable");
	});

	// Non-gating, proven through the real verdict function: the report is a
	// separate read of the same payload and never enters the exit code.
	//
	// #3920 review: this case used the REAL checkout's caps, where the shard's
	// 735 s is 61% of its 20-minute budget -- so the row printed only the "no
	// job is at 70%" summary and the assertion proved nothing about an over-cap
	// row. The cap is now 12 minutes, the value that shipped when the 735 s
	// shard was actually `cancelled`, so the row is at 102% and the over-cap arm
	// runs.
	it("does not change the verdict for a job at or over its cap", async () => {
		const payload = {
			check_runs: [
				{
					name: "TLA+ models (shard 4/4)",
					status: "completed",
					conclusion: "success",
					started_at: "2026-10-20T06:36:59Z",
					completed_at: "2026-10-20T06:49:14Z",
				},
			],
		};
		const verdict = computeVerdict(payload, ["TLA+ models (shard 4/4)"]);
		const caps = [
			{
				file: ".github/workflows/ci.yml",
				jobId: "tla-shards",
				name: "TLA+ models (shard ...)",
				capMinutes: 12,
				pattern: checkNamePattern(
					"TLA+ models (shard ${{ matrix.shard }}/${{ strategy.job-total }})",
					escapeRegExp,
				),
			},
		];
		const lines = runtimeCapLines({ checkRuns: payload.check_runs, caps });
		expect(lines).toHaveLength(1);
		// The report names it as over its cap...
		expect(lines[0]).toContain("735s of 720s (102%)");
		expect(lines[0]).toContain("at or over its cap");
		expect(lines[0]).toContain("(gating)");
		// ...and the verdict on the same payload is unchanged: the row concluded
		// success, so the runtime report cannot move the exit code.
		expect(verdict.exitCode).toBe(0);
	});
});

// #4680 r4 F1: `scripts/ci-verdict.mjs` is documented to run with nothing but
// `gh` on PATH, and lanes read CI before they build. Round 3 folded its private
// escape helper onto `clients/string-utils.js` with a STATIC import, and that
// file is build output (`.gitignore` `*.js`): an unbuilt `git archive` of the
// head died with ERR_MODULE_NOT_FOUND before printing a verdict, while master
// loaded. The tree below is what an unbuilt checkout gives the script: its
// tracked `scripts/` sources and the workflows, and no `clients/` build output.
describe("#4680 r4 F1: ci-verdict runs in a checkout that was never built", () => {
	it("loads without build output and degrades only the cap report, to one line", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-ci-verdict-unbuilt-"));
		try {
			mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
			// The script's static import closure, by name. A new static import
			// outside this list fails the import below with ERR_MODULE_NOT_FOUND,
			// naming the file, which is the loud direction: extend the list when
			// that import is itself tracked source.
			for (const file of [
				"scripts/ci-verdict.mjs",
				"scripts/lib/ci-checks.mjs",
				"scripts/lib/ci-failure-classifier.mjs",
				"scripts/lib/ci-runtime-cap.mjs",
				"scripts/lib/github-rest.mjs",
				"scripts/lib/vitest-summary.mjs",
				"scripts/update-contributors.mjs",
			])
				copyFileSync(join(ROOT, file), join(dir, file));
			mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
			copyFileSync(
				join(ROOT, ".github", "workflows", "ci.yml"),
				join(dir, ".github", "workflows", "ci.yml"),
			);
			const unbuilt = (await import(
				pathToFileURL(join(dir, "scripts", "ci-verdict.mjs")).href
			)) as typeof import("../../scripts/ci-verdict.mjs");
			// The verdict itself needs no build output...
			expect(
				unbuilt.computeVerdict(
					{
						check_runs: [
							{
								name: "Unit tests",
								status: "completed",
								conclusion: "success",
							},
							{
								name: "Lint & type-check",
								status: "completed",
								conclusion: "success",
							},
						],
					},
					["Unit tests", "Lint & type-check"],
				).exitCode,
			).toBe(0);
			// ...and the one report that does (the YAML parser and the escape
			// helper are both compiled `clients/` files) says so in one line.
			const lines = await unbuilt.formatRuntimeCapLines({
				checkRuns: realShardRows(),
				root: dir,
			});
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatch(/^Runtime vs cap: unavailable \(/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("#3920 item 3: the caps come from the workflow YAML itself", () => {
	it("resolves a matrix job's cap from its expanded check-run name", async () => {
		const caps = await readJobTimeCaps(ROOT);
		const shard = caps.filter((entry) =>
			entry.pattern.test("TLA+ models (shard 4/4)"),
		);
		expect(shard.map((entry) => entry.jobId)).toEqual(["tla-shards"]);
		expect(shard[0].capMinutes).toBe(20);
		// The aggregate keeps its own cap; the two rows must not swallow each
		// other's names.
		expect(
			caps
				.filter((entry) => entry.pattern.test("TLA+ models"))
				.map((entry) => entry.jobId),
		).toEqual(["tla-models"]);
		const unit = caps.filter((entry) =>
			entry.pattern.test("Unit tests (shard 3/5)"),
		);
		expect(unit.map((entry) => entry.jobId)).toEqual(["test"]);
	});

	it("reads every workflow that declares a timeout, including lint.yml", async () => {
		const caps = await readJobTimeCaps(ROOT);
		expect(caps.map((entry) => entry.file)).toContain(
			".github/workflows/lint.yml",
		);
		expect(caps.length).toBeGreaterThan(50);
	});

	it("expands only strategy.job-total to a number; any other expression admits one token", () => {
		const total = checkNamePattern(
			"Join (${{ matrix.os }}/${{ strategy.job-total }})",
			escapeRegExp,
		);
		expect(total.test("Join (ubuntu-latest/4)")).toBe(true);
		expect(total.test("Join (ubuntu-latest/x)")).toBe(false);
		const any = checkNamePattern("Job (${{ github.ref }})", escapeRegExp);
		expect(any.test("Job (refs/heads/master)")).toBe(true);
		// Anchored: a longer name is a different check.
		expect(any.test("Job (refs/heads/master) extra")).toBe(false);
	});

	it("keeps a job id as the name when the job declares none", () => {
		const entries = jobCapEntries(
			{ jobs: { build: { "timeout-minutes": 5 }, other: {} } },
			"ci.yml",
			escapeRegExp,
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			jobId: "build",
			name: "build",
			capMinutes: 5,
			file: "ci.yml",
		});
		expect(entries[0].pattern.test("build")).toBe(true);
	});

	it("ignores a job with no cap and one with an unreadable cap", () => {
		expect(
			jobCapEntries(
				{
					jobs: {
						a: {},
						b: { "timeout-minutes": "soon" },
						c: { "timeout-minutes": 0 },
					},
				},
				"ci.yml",
				escapeRegExp,
			),
		).toEqual([]);
	});

	it("parses what js-yaml sees in the real ci.yml, not a copy of it", async () => {
		const doc = yaml.load(
			readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8"),
		) as { jobs: Record<string, { "timeout-minutes"?: number }> };
		const entries = jobCapEntries(doc, "ci.yml", escapeRegExp);
		const shard = entries.find((entry) => entry.jobId === "tla-shards");
		expect(shard?.capMinutes).toBe(doc.jobs["tla-shards"]["timeout-minutes"]);
		expect(doc.jobs["tla-shards"]["timeout-minutes"]).toBe(20);
	});
});
