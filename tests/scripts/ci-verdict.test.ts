import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import {
	computeVerdict,
	DEFAULT_GH_TIMEOUT_MS,
	EXIT_DIRTY,
	EXIT_FAILURE,
	EXIT_PENDING,
	EXIT_SUCCESS,
	EXIT_TRANSPORT,
	EXIT_USAGE,
	fetchCheckRunsPayload,
	formatVerdictTable,
	HARD_CAP_SECONDS,
	isPrNumber,
	isTransientGhError,
	MIN_GH_TIMEOUT_MS,
	POLL_INTERVAL_SECONDS,
	parseArgs,
	pollVerdict,
	resolveClassification,
	resolveGhTimeoutMs,
	resolveHeadSha,
	resolveRepository,
	resolveRequiredCheckNames,
	resolveWaitCapSeconds,
	run,
} from "../../scripts/ci-verdict.mjs";
import {
	ADVISORY_CHECKS,
	isAdvisoryCheck,
} from "../../scripts/lib/ci-checks.mjs";

function checkRun({
	name,
	status = "completed",
	conclusion = "success",
	started_at = "2026-09-03T00:00:00Z",
	id = 1,
	html_url = `https://github.com/apmantza/pi-lens/actions/runs/${id}`,
	details_url = `${html_url}/job/${id}`,
}: {
	name: string;
	status?: string;
	conclusion?: string | null;
	started_at?: string;
	id?: number;
	html_url?: string;
	details_url?: string;
}) {
	return { name, status, conclusion, started_at, id, html_url, details_url };
}

const BOTH_SUCCESS = {
	check_runs: [
		checkRun({ name: "Unit tests", id: 1 }),
		checkRun({ name: "Lint & type-check", id: 2 }),
	],
};

const REAL_CHECK_RUNS = JSON.parse(
	readFileSync(
		join(process.cwd(), "tests/fixtures/ci-verdict/real-check-runs.json"),
		"utf8",
	),
);
const PR_3382_CANCELLED = JSON.parse(
	readFileSync(
		join(process.cwd(), "tests/fixtures/ci-verdict/pr-3382-cancelled.json"),
		"utf8",
	),
);

describe("computeVerdict — the four exit codes (#2539 acceptance criterion)", () => {
	it("reports an armed infrastructure rerun only while its later attempt runs", () => {
		const verdict = computeVerdict(
			{
				check_runs: [
					checkRun({ name: "Unit tests", conclusion: "failure", id: 1 }),
				],
			},
			["Unit tests"],
			"MERGEABLE",
			"infra-kill",
			{
				originalFailed: true,
				latestAttempt: { status: "queued", conclusion: null, run_attempt: 2 },
			},
		);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(verdict.reason).toContain("infra (rerun armed)");
	});
	it("reports a concluded rerun failure even when ci:infra remains", () => {
		const verdict = computeVerdict(
			{ check_runs: [checkRun({ name: "Unit tests", conclusion: "failure" })] },
			["Unit tests"],
			"MERGEABLE",
			"infra-net",
			{
				originalFailed: true,
				latestAttempt: {
					status: "completed",
					conclusion: "failure",
					run_attempt: 2,
				},
			},
		);
		expect(verdict.exitCode).toBe(EXIT_FAILURE);
	});
	it("exits 0 when both required checks concluded success", () => {
		const verdict = computeVerdict(BOTH_SUCCESS);
		expect(verdict.exitCode).toBe(EXIT_SUCCESS);
		expect(verdict.rows.every((row) => row.present)).toBe(true);
	});

	it("exits 1 when a required check completed with a non-success conclusion", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", conclusion: "failure", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
			],
		};
		const verdict = computeVerdict(payload);
		expect(verdict.exitCode).toBe(EXIT_FAILURE);
	});

	it("exits 3 while a required check is still queued or in_progress", () => {
		const payload = {
			check_runs: [
				checkRun({
					name: "Unit tests",
					status: "in_progress",
					conclusion: null,
					id: 1,
				}),
				checkRun({ name: "Lint & type-check", id: 2 }),
			],
		};
		const verdict = computeVerdict(payload);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
	});
});

// #2539 round 2, F1: absent is not automatically DIRTY. `ci-verdict.mjs:116-120`
// pre-fix exited 2 the instant a required check was absent from the payload,
// without ever asking GitHub whether the PR was actually merge-conflicted --
// the common cause of an absent check is CI not yet registered (a fresh
// push), which `pollVerdict`'s break-on-any-non-pending-verdict loop could
// then never bridge with `--wait`. Fixed via `mergeable` threaded from
// `gh pr view --json headRefOid,mergeable` through to `computeVerdict`.
describe("computeVerdict — absent-check verdict is mergeable-aware (#2539 round 2, F1)", () => {
	it("A1: exits 3 (pending) when a required check is absent but the PR is MERGEABLE", () => {
		const payload = {
			check_runs: [checkRun({ name: "Unit tests", id: 1 })],
		};
		const verdict = computeVerdict(payload, undefined, "MERGEABLE");
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		const lint = verdict.rows.find((row) => row.name === "Lint & type-check");
		expect(lint?.present).toBe(false);
	});

	it("A2: exits 2 (DIRTY) when a required check is absent AND the PR is CONFLICTING", () => {
		const payload = {
			check_runs: [checkRun({ name: "Unit tests", id: 1 })],
		};
		const verdict = computeVerdict(payload, undefined, "CONFLICTING");
		expect(verdict.exitCode).toBe(EXIT_DIRTY);
	});

	it("A3: exits 3 (pending) when the target is a bare SHA (mergeable=null, no PR context)", () => {
		const verdict = computeVerdict({ check_runs: [] }, undefined, null);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(verdict.reason).toMatch(/no PR context/);
	});

	it("also reads UNKNOWN mergeable as pending, not DIRTY", () => {
		const verdict = computeVerdict(
			{ check_runs: [checkRun({ name: "Unit tests", id: 1 })] },
			undefined,
			"UNKNOWN",
		);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
	});

	// #2664: the reported live scenario -- BOTH required rows absent (a base
	// retargeted after open; ci.yml has no `edited` trigger, so neither check
	// ever registers) with a MERGEABLE head. The issue claimed this exited 0;
	// it already exits 3 (see the doc comment above computeVerdict), so this
	// pins that exit code AND the issue's optional hint text, which is the
	// one piece #2664 actually adds.
	it("A5 (#2664): both required rows absent + MERGEABLE exits 3 with the retarget hint", () => {
		const verdict = computeVerdict({ check_runs: [] }, undefined, "MERGEABLE");
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(verdict.rows.every((row) => !row.present)).toBe(true);
		expect(verdict.reason).toContain("mergeable=MERGEABLE");
		expect(verdict.reason).toContain(
			"if the base was retargeted after this PR opened, push a commit or close/reopen to re-arm ci.yml",
		);
	});

	it("DIRTY still takes priority over an independently failed sibling check, when CONFLICTING", () => {
		const payload = {
			check_runs: [
				// Unit tests absent entirely; Lint failed outright. Confirmed
				// conflict must still win over the sibling's concrete failure.
				checkRun({ name: "Lint & type-check", conclusion: "failure", id: 2 }),
			],
		};
		expect(computeVerdict(payload, undefined, "CONFLICTING").exitCode).toBe(
			EXIT_DIRTY,
		);
	});

	it("a non-conflicting absence yields FAILURE, not PENDING, when the sibling concretely failed", () => {
		// Unlike the CONFLICTING case above: with no confirmed conflict, a
		// concrete failure on the other required check is real evidence and
		// must not be masked by an absent check that's merely unregistered.
		const payload = {
			check_runs: [
				checkRun({ name: "Lint & type-check", conclusion: "failure", id: 2 }),
			],
		};
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_FAILURE,
		);
	});
});

// #2539 round 3, F1: round 2's DIRTY gate was `anyAbsent && mergeable ===
// "CONFLICTING"`, so the DOMINANT DIRTY shape -- a head that went green and
// only turned conflicted AFTERWARD, same head SHA, old green check-runs
// still attached -- read as a pass. A live probe on #2552 confirmed exit 0
// ("both required checks concluded success") on a present-and-green PR that
// `gh pr view` reported as CONFLICTING. DIRTY must fire from `mergeable`
// alone, independent of whether the required checks are present.
describe("computeVerdict — DIRTY fires on CONFLICTING regardless of check presence (#2539 round 3, F1)", () => {
	it("exits 2 (DIRTY) when both required checks are present and green but the PR is CONFLICTING", () => {
		const verdict = computeVerdict(BOTH_SUCCESS, undefined, "CONFLICTING");
		expect(verdict.exitCode).toBe(EXIT_DIRTY);
		expect(verdict.rows.every((row) => row.present)).toBe(true);
		expect(verdict.rows.every((row) => row.conclusion === "success")).toBe(
			true,
		);
	});

	it("the verdict record always carries mergeState, even off the DIRTY path", () => {
		expect(
			computeVerdict(BOTH_SUCCESS, undefined, "CONFLICTING").mergeState,
		).toBe("CONFLICTING");
		expect(
			computeVerdict(BOTH_SUCCESS, undefined, "MERGEABLE").mergeState,
		).toBe("MERGEABLE");
		// Bare-SHA target: no PR context, mergeable is null -- reported as
		// "n/a", and DIRTY documented as PR-only: null can never equal the
		// literal string "CONFLICTING".
		expect(computeVerdict(BOTH_SUCCESS, undefined, null).mergeState).toBe(
			"n/a",
		);
		expect(computeVerdict(BOTH_SUCCESS, undefined, null).exitCode).toBe(
			EXIT_SUCCESS,
		);
	});

	it("run() prints the merge state line unconditionally, including on a clean pass", async () => {
		const ghExec = (args: string[]) => {
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
			return JSON.stringify(BOTH_SUCCESS);
		};
		const stdoutLines: string[] = [];
		const exitCode = await run({
			argv: ["2539"],
			ghExec,
			stdout: (line: string) => stdoutLines.push(line),
			stderr: () => {},
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(stdoutLines).toContain("Merge state: MERGEABLE");
	});

	it("run() exits 2 end to end for a present-and-green PR that is CONFLICTING (#2552 live-probe shape)", async () => {
		const ghExec = (args: string[]) => {
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({
					headRefOid: "c0ffee",
					mergeable: "CONFLICTING",
				});
			return JSON.stringify(BOTH_SUCCESS);
		};
		const stdoutLines: string[] = [];
		const exitCode = await run({
			argv: ["2539"],
			ghExec,
			stdout: (line: string) => stdoutLines.push(line),
			stderr: () => {},
		});
		expect(exitCode).toBe(EXIT_DIRTY);
		expect(stdoutLines).toContain("Merge state: CONFLICTING");
	});
});

// #3373: the real PR #3358 response crossed the REST page boundary. The
// regression is that a complete two-page read must expose all 162 names to
// the production fetch seam, without a synthetic truncation verdict.
describe("fetchCheckRunsPayload — complete pagination (#3373)", () => {
	it("reads every page until total_count is covered", () => {
		const calls: string[] = [];
		const ghExec = (args: string[]) => {
			calls.push(args[1]);
			const page = Number(
				new URLSearchParams(args[1].split("?")[1]).get("page"),
			);
			return JSON.stringify({
				total_count: REAL_CHECK_RUNS.source.total_count,
				check_runs: REAL_CHECK_RUNS.pages[page - 1] ?? [],
			});
		};
		const payload = fetchCheckRunsPayload("apmantza/pi-lens", "head", ghExec);
		expect(calls).toEqual([
			"repos/apmantza/pi-lens/commits/head/check-runs?per_page=100&page=1",
			"repos/apmantza/pi-lens/commits/head/check-runs?per_page=100&page=2",
		]);
		expect(payload.check_runs).toHaveLength(REAL_CHECK_RUNS.source.total_count);
	});
});

describe("computeVerdict — rerun de-duplication (latest-started wins)", () => {
	it("picks the most recently started run when a name appears twice (a rerun)", () => {
		const payload = {
			check_runs: [
				checkRun({
					name: "Unit tests",
					conclusion: "failure",
					started_at: "2026-09-03T00:00:00Z",
					id: 1,
				}),
				checkRun({
					name: "Unit tests",
					conclusion: "success",
					started_at: "2026-09-03T01:00:00Z",
					id: 2,
				}),
				checkRun({ name: "Lint & type-check", id: 3 }),
			],
		};
		const verdict = computeVerdict(payload);
		expect(verdict.exitCode).toBe(EXIT_SUCCESS);
		const unitTests = verdict.rows.find((row) => row.name === "Unit tests");
		expect(unitTests?.conclusion).toBe("success");
	});

	// #2539 round 2, F5 (reviewer probe): the live REST API returns check-runs
	// NEWEST-FIRST, but the single pre-round-2 fixture above only covered
	// older-then-newer array order. A `matches[matches.length - 1]` ("last
	// wins") tiebreak stays green on that one fixture while getting the real
	// API's order backwards -- it would report the STALE failing run instead
	// of the fix-confirming success. Reversed order must resolve identically.
	it("resolves identically when the rerun array is newest-first (the live API's own order)", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Lint & type-check", id: 3 }),
				checkRun({
					name: "Unit tests",
					conclusion: "success",
					started_at: "2026-09-03T01:00:00Z",
					id: 2,
				}),
				checkRun({
					name: "Unit tests",
					conclusion: "failure",
					started_at: "2026-09-03T00:00:00Z",
					id: 1,
				}),
			],
		};
		const verdict = computeVerdict(payload);
		expect(verdict.exitCode).toBe(EXIT_SUCCESS);
		const unitTests = verdict.rows.find((row) => row.name === "Unit tests");
		expect(unitTests?.conclusion).toBe("success");
	});

	// #2539 round 2, F2/F5: the shared `resolveLatestByName` tie policy
	// (scripts/lib/ci-checks.mjs) is fail-closed, not id-based. A superseded
	// SUCCESS carrying the HIGHER id, or a duplicate with no `started_at` at
	// all, must not read as success -- both are covered again here (beyond
	// merge-train-warden.test.ts's own coverage of the shared resolver)
	// because ci-verdict.mjs is what actually calls it with REST-shaped runs.
	it("does not let a superseded success with the higher id win an unorderable tie (in_progress first)", () => {
		const payload = {
			check_runs: [
				checkRun({
					name: "Unit tests",
					status: "in_progress",
					conclusion: null,
					started_at: "",
					id: 1,
				}),
				checkRun({
					name: "Unit tests",
					status: "completed",
					conclusion: "success",
					started_at: "",
					id: 99,
				}),
				checkRun({ name: "Lint & type-check", id: 3 }),
			],
		};
		const verdict = computeVerdict(payload);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		const unitTests = verdict.rows.find((row) => row.name === "Unit tests");
		expect(unitTests?.status).toBe("in_progress");
	});

	// #2539 round 3: the case above happens to also put the correct winner
	// (in_progress) FIRST in array order, so it cannot distinguish the real
	// fail-closed policy (non-success wins an unorderable tie, per
	// preferCheckRun in scripts/lib/ci-checks.mjs) from a regression to
	// "array position first wins" -- both would return in_progress there.
	// Swapping the order (success first, in_progress LAST) forces them apart:
	// a first-wins bug would return success here; the real fail-closed policy
	// still returns in_progress regardless of position.
	it("does not let a superseded success with the higher id win an unorderable tie (in_progress last)", () => {
		const payload = {
			check_runs: [
				checkRun({
					name: "Unit tests",
					status: "completed",
					conclusion: "success",
					started_at: "",
					id: 99,
				}),
				checkRun({
					name: "Unit tests",
					status: "in_progress",
					conclusion: null,
					started_at: "",
					id: 1,
				}),
				checkRun({ name: "Lint & type-check", id: 3 }),
			],
		};
		const verdict = computeVerdict(payload);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		const unitTests = verdict.rows.find((row) => row.name === "Unit tests");
		expect(unitTests?.status).toBe("in_progress");
	});
});

// #2609: `ci-verdict.mjs` used to build `rows` ONLY from the fixed
// `["Unit tests", "Lint & type-check"]` pair, so a red "Production install
// build" or "Install test" job on PR #2588's head e32d814e never entered the
// computation -- `run() 2588` printed "both required checks concluded
// success" while the Production install build job was genuinely red (a
// widened peer range with a space, word-split by `read -ra`). Pre-fix, this
// whole describe block's first test reproduces that: RED on
// `git show <pre-#2609 sha>:scripts/ci-verdict.mjs`'s `computeVerdict`,
// because that version never looked at any check-run name outside
// `requiredChecks`.
describe("computeVerdict — every check-run gates unless advisory (#2609)", () => {
	const REAL_PROD_INSTALL_BUILD_NAME =
		"Production install build (--omit=dev, from source)";

	it("exits 1 when a discovered, non-advisory check-run fails even though both required checks pass (PR #2588 shape)", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
				checkRun({
					name: REAL_PROD_INSTALL_BUILD_NAME,
					conclusion: "failure",
					id: 3,
				}),
			],
		};
		const verdict = computeVerdict(payload, undefined, "MERGEABLE");
		expect(verdict.exitCode).toBe(EXIT_FAILURE);
		expect(verdict.reason).toContain(REAL_PROD_INSTALL_BUILD_NAME);
		const row = verdict.rows.find(
			(r) => r.name === REAL_PROD_INSTALL_BUILD_NAME,
		);
		expect(row?.gating).toBe(true);
	});

	it("exits 0 when only a name-suffix advisory lane fails (OSV scan (advisory))", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
				checkRun({
					name: "OSV scan (advisory)",
					conclusion: "failure",
					id: 3,
				}),
			],
		};
		const verdict = computeVerdict(payload, undefined, "MERGEABLE");
		expect(verdict.exitCode).toBe(EXIT_SUCCESS);
		const row = verdict.rows.find((r) => r.name === "OSV scan (advisory)");
		expect(row?.gating).toBe(false);
	});

	it("exits 0 when only a static-allowlist advisory vendor check fails (SonarCloud/CodeQL, no suffix)", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
				checkRun({
					name: "SonarCloud Code Analysis",
					conclusion: "failure",
					id: 3,
				}),
			],
		};
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_SUCCESS,
		);
	});

	it("exits 3 (pending) while a discovered gating check is still queued or in progress", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
				checkRun({
					name: REAL_PROD_INSTALL_BUILD_NAME,
					status: "in_progress",
					conclusion: null,
					id: 3,
				}),
			],
		};
		const verdict = computeVerdict(payload, undefined, "MERGEABLE");
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(verdict.reason).toContain(REAL_PROD_INSTALL_BUILD_NAME);
	});

	// Not hypothetical: this repository's `record-post-merge-validation` job
	// (ci.yml AND lint.yml) has a job-level `if: ... event_name ==
	// 'repository_dispatch'` and reports "skipped" on every ordinary
	// pull_request run (confirmed live on PR #2588, 2026-09-06 -- two "Record
	// post-merge validation" rows, both "skipping" in `gh pr checks`). A bare
	// `conclusion !== "success"` check (the pre-#2609 comparison, applied to a
	// newly-discovered row) would red every PR forever.
	it("a discovered gating check that concluded 'skipped' does not fail the verdict", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
				checkRun({
					name: "Record post-merge validation",
					conclusion: "skipped",
					id: 3,
				}),
			],
		};
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_SUCCESS,
		);
	});

	it("a discovered gating check that concluded 'neutral' does not fail the verdict", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
				checkRun({ name: "Some neutral tool", conclusion: "neutral", id: 3 }),
			],
		};
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_SUCCESS,
		);
	});

	// AGENTS.md shape 38: "the cheapest evasion is adding a real gate to the
	// advisory list." A name GitHub's OWN branch-protection read confirms as
	// required must gate even if it also happens to match the static
	// advisory allowlist -- this is the override `computeVerdict`'s `gating =
	// requiredNameSet.has(name) || !isAdvisoryCheck(name)` provides. Deleting
	// the `requiredNameSet.has(name) ||` half (keeping only
	// `!isAdvisoryCheck(name)`) is the exact mutation this test catches.
	it("a name confirmed required by branch protection always gates, even if it matches the advisory allowlist", () => {
		const payload = {
			check_runs: [
				checkRun({
					name: "SonarCloud Code Analysis",
					conclusion: "failure",
					id: 1,
				}),
			],
		};
		const verdict = computeVerdict(
			payload,
			["SonarCloud Code Analysis"],
			"MERGEABLE",
		);
		expect(verdict.exitCode).toBe(EXIT_FAILURE);
	});

	it("discovered rows are sorted by name after the required rows, each carrying present:true", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
				checkRun({ name: "Install test (windows-latest)", id: 3 }),
				checkRun({ name: "Install test (macos-latest)", id: 4 }),
			],
		};
		const verdict = computeVerdict(payload, undefined, "MERGEABLE");
		expect(verdict.rows.map((r) => r.name)).toEqual([
			"Unit tests",
			"Lint & type-check",
			"Install test (macos-latest)",
			"Install test (windows-latest)",
		]);
		expect(verdict.rows.slice(2).every((r) => r.present)).toBe(true);
	});
});

// #2618 fix-round-2 state-space table (required/discovered x conclusion x
// merge state; the "run current / superseded" axis only produces a distinct
// cell for "cancelled", so it is folded into that row rather than repeated
// for every conclusion). CONFLICTING is tested densely once elsewhere
// (#2539 round 3, F1's "DIRTY fires... regardless of check presence" block)
// and here only for the two NEW cells this round adds (required/cancelled,
// discovered/cancelled-current) -- DIRTY's precedence over every other
// signal is unchanged production code, not re-verified per conclusion.
//
//  row kind    | conclusion | supersession        | exit (MERGEABLE) | exit (CONFLICTING)
//  ------------|------------|----------------------|-------------------|--------------------
//  required    | success    | --                   | 0 (existing)      | 2 (existing)
//  required    | failure    | --                   | 1 (existing)      | 2 (existing)
//  required    | cancelled  | latest              | 3  #3373          | 2  NEW
//  required    | skipped    | --                   | 1  F1             | 2  (covered by table-driven test)
//  required    | neutral    | --                   | 1  F1             | 2  (covered by table-driven test)
//  required    | timed_out  | --                   | 1  (sanity)       | 2  (covered by table-driven test)
//  required    | absent     | --                   | 3 (existing A1)   | 2 (existing A2)
//  discovered  | success    | --                   | 0 (existing)      | 2 (existing)
//  discovered  | failure    | --                   | 1 (existing)      | 2 (existing)
//  discovered  | cancelled  | current (no replacement yet) | 3  F2      | 2  NEW
//  discovered  | cancelled  | superseded (newer row exists)| 0 (dedup drops it; live PR #2607 shape) | 2 (existing precedence)
//  discovered  | skipped    | --                   | 0 (round-1)       | 2 (existing)
//  discovered  | neutral    | --                   | 0 (round-1)       | 2 (existing)
//  discovered  | timed_out  | --                   | 1  (sanity)       | 2 (existing)
//  discovered  | absent     | --                   | impossible by construction -- a discovered row's name, by definition, appeared in the payload
//  advisory    | any incl. failure | --            | 0 (existing)      | 2 (existing)
describe("computeVerdict — required rows reject skip/neutral/failure while latest cancellation reruns (#3373)", () => {
	// The exact reported shape: ci.yml:253's `test` job (`Unit tests`) has
	// `needs: validate-merge-train-dispatch` with no `if:` -- a failed/skipped
	// dependency skips it outright, and the pre-fix-round-2 code (which
	// exempted EVERY gating row's skipped/neutral conclusion, not just
	// discovered ones) read that as a clean pass.
	it("RED PROOF: a required 'Unit tests' that concluded skipped no longer passes", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", conclusion: "skipped", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
			],
		};
		const verdict = computeVerdict(payload, undefined, "MERGEABLE");
		expect(verdict.exitCode).toBe(EXIT_FAILURE);
		expect(verdict.reason).toContain("Unit tests (skipped)");
	});

	it.each([
		["failure", EXIT_FAILURE],
		["cancelled", EXIT_PENDING],
		["skipped", EXIT_FAILURE],
		["neutral", EXIT_FAILURE],
		["timed_out", EXIT_FAILURE],
		["success", EXIT_SUCCESS],
	])(
		"a required row concluding %s exits %i regardless of the discovered-row grace",
		(conclusion, expectedExit) => {
			const payload = {
				check_runs: [
					checkRun({ name: "Unit tests", conclusion, id: 1 }),
					checkRun({ name: "Lint & type-check", id: 2 }),
				],
			};
			expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
				expectedExit,
			);
		},
	);

	it("a required row's cancelled conclusion stays non-zero even under CONFLICTING precedence (table cell: required/cancelled x CONFLICTING)", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", conclusion: "cancelled", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
			],
		};
		expect(computeVerdict(payload, undefined, "CONFLICTING").exitCode).toBe(
			EXIT_DIRTY,
		);
	});
});

describe("computeVerdict — a discovered row's cancelled conclusion is uncertain, not failing (#2618 fix-round-2, F2)", () => {
	// RED PROOF against the pre-fix-round-2 code, reproduced with the REAL
	// check_suite id and started_at GitHub returned for PR #2607's
	// "Record post-merge validation" oldest (cancelled) run, live-probed
	// 2026-09-06: `gh api repos/apmantza/pi-lens/commits/<sha>/check-runs`
	// returned THREE check-suites for that name on ONE commit -- 17:21:06
	// cancelled, 17:25:29 skipped, 17:32:15 skipped. This fixture carries
	// ONLY the cancelled one, reproducing the transient window before either
	// replacement had posted (`cancel-in-progress: true`, ci.yml:15-16).
	it("RED PROOF: a lone cancelled discovered row (no replacement posted yet) no longer fails the verdict", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
				checkRun({
					name: "Record post-merge validation",
					conclusion: "cancelled",
					started_at: "2026-09-06T17:21:06Z",
					id: 101527303167,
				}),
			],
		};
		const verdict = computeVerdict(payload, undefined, "MERGEABLE");
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		// #2618 fix round 3: the reason must NOT say "still queued or in
		// progress" for a row the table itself reports as `completed
		// cancelled` -- that reads as a contradiction. It gets its own clause.
		expect(verdict.reason).not.toMatch(/still queued or in progress/);
		expect(verdict.reason).toContain(
			"superseded run cancelled and not replaced: rerun 101527303167 (gh run rerun 101527303167)",
		);
	});

	it("a latest cancelled row gets an explicit rerun even beside a still-running row", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
				checkRun({
					name: "Record post-merge validation",
					conclusion: "cancelled",
					id: 3,
				}),
				checkRun({
					name: "Production install build (--omit=dev, from source)",
					status: "in_progress",
					conclusion: null,
					id: 4,
				}),
			],
		};
		const verdict = computeVerdict(payload, undefined, "MERGEABLE");
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(verdict.reason).toContain(
			"superseded run cancelled and not replaced: rerun 3 (gh run rerun 3)",
		);
	});

	// The SAME live shape once a replacement HAS posted: `resolveLatestByName`
	// already drops the older cancelled check-suite via `started_at`, so the
	// verdict reads whatever the newest row says (here: skipped, exempt) --
	// this is the "superseded" table cell, and it was ALREADY correct before
	// this round (the dedup logic is untouched); pinned here as a live-data
	// regression guard now that a lone cancelled row means something
	// different (pending) than a superseded one (invisible).
	it("a cancelled discovered row already superseded by a newer replacement is invisible, not pending (PR #2607 live shape)", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
				checkRun({
					name: "Record post-merge validation",
					conclusion: "cancelled",
					started_at: "2026-09-06T17:21:06Z",
					id: 101527303167,
				}),
				checkRun({
					name: "Record post-merge validation",
					conclusion: "skipped",
					started_at: "2026-09-06T17:25:29Z",
					id: 101527918964,
				}),
				checkRun({
					name: "Record post-merge validation",
					conclusion: "skipped",
					started_at: "2026-09-06T17:32:15Z",
					id: 101528845721,
				}),
			],
		};
		const verdict = computeVerdict(payload, undefined, "MERGEABLE");
		expect(verdict.exitCode).toBe(EXIT_SUCCESS);
		const row = verdict.rows.find(
			(r) => r.name === "Record post-merge validation",
		);
		expect(row?.conclusion).toBe("skipped");
	});

	it("a discovered row's cancelled conclusion stays uncertain (pending) even under CONFLICTING precedence (table cell: discovered/cancelled-current x CONFLICTING)", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
				checkRun({
					name: "Record post-merge validation",
					conclusion: "cancelled",
					id: 3,
				}),
			],
		};
		expect(computeVerdict(payload, undefined, "CONFLICTING").exitCode).toBe(
			EXIT_DIRTY,
		);
	});

	it("uses the newer success when an older cancelled lint run is present (#3373)", () => {
		const verdict = computeVerdict(
			{
				check_runs: [
					...BOTH_SUCCESS.check_runs.filter(
						(run) => run.name !== "Lint & type-check",
					),
					...REAL_CHECK_RUNS.cancelledReplacement.check_runs,
				],
			},
			undefined,
			"MERGEABLE",
		);
		expect(verdict.exitCode).toBe(EXIT_SUCCESS);
		expect(
			verdict.rows.find((row) => row.name === "Lint & type-check")?.conclusion,
		).toBe("success");
	});

	it("reports the latest cancelled lint run with its rerun command (#3373)", () => {
		const verdict = computeVerdict(
			{
				check_runs: [
					...BOTH_SUCCESS.check_runs,
					...REAL_CHECK_RUNS.cancelledLatest.check_runs,
				],
			},
			undefined,
			"MERGEABLE",
		);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(verdict.reason).toBe(
			"superseded run cancelled and not replaced: rerun 107416999999 (gh run rerun 107416999999)",
		);
	});

	it("uses the workflow run id from the #3382 check-run details URL (#3386)", () => {
		const verdict = computeVerdict(
			{
				check_runs: [
					...BOTH_SUCCESS.check_runs.filter(
						(run) => run.name !== "Lint & type-check",
					),
					...PR_3382_CANCELLED.check_runs,
				],
			},
			undefined,
			"MERGEABLE",
		);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(verdict.reason).toBe(
			"superseded run cancelled and not replaced: rerun 36022234159 (gh run rerun 36022234159)",
		);
	});

	it("uses --job only when details_url verifies the check-run id is the job id", () => {
		const verdict = computeVerdict(
			{
				check_runs: [
					...BOTH_SUCCESS.check_runs.filter(
						(run) => run.name !== "Lint & type-check",
					),
					checkRun({
						name: "Lint & type-check",
						conclusion: "cancelled",
						id: 77,
						details_url: "https://github.com/acme/repo/actions/job/77",
					}),
				],
			},
			undefined,
			"MERGEABLE",
		);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(verdict.reason).toContain("rerun 77 (gh run rerun --job 77)");
	});

	it("names a third-party check that cannot be rerun via gh", () => {
		const detailsUrl = "https://sonarcloud.io/project/status/acme";
		const verdict = computeVerdict(
			{
				check_runs: [
					...BOTH_SUCCESS.check_runs,
					checkRun({
						name: "CodeQL",
						conclusion: "cancelled",
						id: 88,
						details_url: detailsUrl,
					}),
				],
			},
			["Unit tests", "Lint & type-check", "CodeQL"],
			"MERGEABLE",
		);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(verdict.reason).toBe(
			`superseded run cancelled and not replaced: CodeQL cannot be rerun via gh (not a GitHub Actions job; details: ${detailsUrl})`,
		);
	});

	it("names a mismatched Actions job that cannot be rerun via gh", () => {
		const detailsUrl = "https://github.com/acme/repo/actions/job/88";
		const verdict = computeVerdict(
			{
				check_runs: [
					...BOTH_SUCCESS.check_runs.filter(
						(run) => run.name !== "Lint & type-check",
					),
					checkRun({
						name: "Lint & type-check",
						conclusion: "cancelled",
						id: 77,
						details_url: detailsUrl,
					}),
				],
			},
			undefined,
			"MERGEABLE",
		);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		expect(verdict.reason).toBe(
			`superseded run cancelled and not replaced: Lint & type-check cannot be rerun via gh (not a GitHub Actions job; details: ${detailsUrl})`,
		);
	});

	it("a discovered row's timed_out conclusion still fails (sanity: only cancelled gets the uncertain grace)", () => {
		const payload = {
			check_runs: [
				checkRun({ name: "Unit tests", id: 1 }),
				checkRun({ name: "Lint & type-check", id: 2 }),
				checkRun({
					name: "Production install build (--omit=dev, from source)",
					conclusion: "timed_out",
					id: 3,
				}),
			],
		};
		expect(computeVerdict(payload, undefined, "MERGEABLE").exitCode).toBe(
			EXIT_FAILURE,
		);
	});

	// A required row's cancelled conclusion failing outright (never pending)
	// in the MERGEABLE case is already pinned by the "required row concluding
	// %s exits %i" table-driven test above (its "cancelled" row) -- deleted a
	// near-duplicate here after probing that `pendingGatingRows`' own
	// `requiredNameSet` guard is structurally dead code (removing it changes
	// no test outcome: `failingGatingRows` always wins precedence first for a
	// required row), so there is no separate line left to guard against.
});

describe("resolveRequiredCheckNames — live branch-protection read (#2609)", () => {
	it("returns the contexts array when gh api resolves branch protection", () => {
		const ghExec = (args: string[]) => {
			expect(args).toEqual([
				"api",
				"repos/acme/repo/branches/master/protection",
			]);
			return JSON.stringify({
				required_status_checks: {
					contexts: ["Unit tests", "Lint & type-check"],
				},
			});
		};
		expect(resolveRequiredCheckNames("acme/repo", ghExec)).toEqual([
			"Unit tests",
			"Lint & type-check",
		]);
	});

	it("returns null when gh api throws (403/404/timeout/not readable)", () => {
		const ghExec = () => {
			throw new Error("HTTP 403: Resource not accessible");
		};
		expect(resolveRequiredCheckNames("acme/repo", ghExec)).toBeNull();
	});

	it("returns null when the response has no required_status_checks.contexts array", () => {
		const ghExec = () => JSON.stringify({ some: "other shape" });
		expect(resolveRequiredCheckNames("acme/repo", ghExec)).toBeNull();
	});

	// #2618 fix-round-2 reviewer note: `.checks[].context` (the modern,
	// per-app shape) is read in PREFERENCE to the deprecated `.contexts`
	// string array, matching this repo's own live response (probed
	// 2026-09-06: both present and in agreement).
	it("prefers required_status_checks.checks[].context over the legacy .contexts array", () => {
		const ghExec = () =>
			JSON.stringify({
				required_status_checks: {
					// Legacy array deliberately stale/wrong here so the test can
					// only pass if `.checks` won.
					contexts: ["Stale Legacy Name"],
					checks: [
						{ context: "Lint & type-check", app_id: 15368 },
						{ context: "Unit tests", app_id: 15368 },
					],
				},
			});
		expect(resolveRequiredCheckNames("acme/repo", ghExec)).toEqual([
			"Lint & type-check",
			"Unit tests",
		]);
	});

	it("falls back to .contexts when .checks is absent (older API response shape)", () => {
		const ghExec = () =>
			JSON.stringify({
				required_status_checks: {
					contexts: ["Unit tests", "Lint & type-check"],
				},
			});
		expect(resolveRequiredCheckNames("acme/repo", ghExec)).toEqual([
			"Unit tests",
			"Lint & type-check",
		]);
	});

	it("falls back to .contexts when .checks is present but empty", () => {
		const ghExec = () =>
			JSON.stringify({
				required_status_checks: {
					checks: [],
					contexts: ["Unit tests", "Lint & type-check"],
				},
			});
		expect(resolveRequiredCheckNames("acme/repo", ghExec)).toEqual([
			"Unit tests",
			"Lint & type-check",
		]);
	});

	it("passes the timeoutMs through to ghExec's own options", () => {
		const calls: unknown[] = [];
		const ghExec = (_args: string[], options: unknown) => {
			calls.push(options);
			return JSON.stringify({ required_status_checks: { contexts: [] } });
		};
		resolveRequiredCheckNames("acme/repo", ghExec, 12_345);
		expect(calls[0]).toEqual({ timeoutMs: 12_345 });
	});
});

// #2618 fix-round-2, F3: `greeting` (greetings.yml, actions/first-interaction)
// was not on the advisory allowlist, so a token or action-version failure in
// a cosmetic welcome bot could block the train. Rather than hand-add that
// one name and hope nothing else was missed, this enumerates every job name
// from every workflow that can actually attach a check-run to an OPEN PR's
// head (has `opened`/`synchronize` in its `pull_request(_target)` types, or
// no `types:` filter at all -- ci.yml, lint.yml, osv-scan.yml, greetings.yml;
// EXCLUDED: close-keyword-verification.yml, `types: [closed]` only, never
// fires on an open PR) and classifies EVERY one of them, so a future new job
// with no `(advisory)` suffix and no allowlist entry fails this test instead
// of silently blocking (or silently NOT blocking) the train.
describe("isAdvisoryCheck — every job name from a PR-triggered workflow is classified explicitly (#2618 fix-round-2, F3)", () => {
	const WORKFLOWS_DIR = resolve(import.meta.dirname, "../../.github/workflows");

	function recordValue(value: unknown): Record<string, unknown> {
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	}

	// True when the workflow's `pull_request` or `pull_request_target`
	// trigger can fire on an open/updated PR -- i.e. `types:` is absent
	// (GitHub's default is [opened, synchronize, reopened]) or explicitly
	// includes `opened` or `synchronize`.
	function firesOnOpenOrSyncPr(doc: Record<string, unknown>): boolean {
		const on = recordValue(doc.on);
		for (const key of ["pull_request", "pull_request_target"]) {
			if (on[key] === undefined) continue;
			const types = recordValue(on[key]).types;
			if (
				!Array.isArray(types) ||
				types.includes("opened") ||
				types.includes("synchronize")
			) {
				return true;
			}
		}
		return false;
	}

	function expandMatrixNames(name: string, matrix: unknown): string[] {
		const matrixRecord = recordValue(matrix);
		let names = [name];
		for (const [key, values] of Object.entries(matrixRecord)) {
			if (!Array.isArray(values)) continue;
			const placeholder = `\${{ matrix.${key} }}`;
			names = names.flatMap((current) =>
				current.includes(placeholder)
					? values.map((value) =>
							current.replaceAll(placeholder, String(value)),
						)
					: [current],
			);
		}
		return names;
	}

	function jobNamesFromPrTriggeredWorkflows(): Set<string> {
		const names = new Set<string>();
		for (const entry of readdirSync(WORKFLOWS_DIR)) {
			if (!/\.ya?ml$/i.test(entry)) continue;
			const doc = recordValue(
				yaml.load(readFileSync(join(WORKFLOWS_DIR, entry), "utf8")),
			);
			if (!firesOnOpenOrSyncPr(doc)) continue;
			for (const [key, job] of Object.entries(recordValue(doc.jobs))) {
				const jobRecord = recordValue(job);
				const rawName = (jobRecord.name as string | undefined) ?? key;
				const matrix = recordValue(jobRecord.strategy).matrix;
				for (const name of expandMatrixNames(rawName, matrix)) names.add(name);
			}
		}
		return names;
	}

	// Names GitHub posts that come from NO committed workflow file, so the
	// YAML-driven enumeration above cannot discover them: the default CodeQL
	// code-scanning setup (no codeql.yml in this repo) and the third-party
	// SonarCloud GitHub App integration. Live-probed on PR #2588, 2026-09-06.
	const EXTERNAL_GATING_NAMES = [
		"Analyze (actions)",
		"Analyze (go)",
		"Analyze (javascript-typescript)",
		"Analyze (python)",
		"Analyze (ruby)",
		"Analyze (rust)",
	];
	const EXTERNAL_ADVISORY_NAMES = ["CodeQL", "SonarCloud Code Analysis"];

	const EXPECTED_ADVISORY = new Set([
		"Unit tests Windows (advisory)",
		"PR body (advisory)",
		"Vale prose lint (advisory)",
		"OSV scan (advisory)",
		"knip (advisory)",
		"jscpd (advisory)",
		"yamllint (advisory)",
		"typos (advisory)",
		"taplo (advisory)",
		"mutation (advisory)",
		"complexity (advisory)",
		// #2697 item 9: the strictness census lane (two scratch tsconfigs) is advisory.
		"strictness (advisory)",
		"Targeted tests (advisory)",
		"host latest nightly (advisory)",
		"greeting",
		// #2993: stale verdict-label cleanup is metadata bookkeeping, not a
		// change-correctness assertion, so token, API, or already-absent-label
		// failures must never block a merge.
		"Clear stale CI verdict labels",
		// #2700 review round 3: named "oxlint (advisory)" (the `(advisory)`
		// suffix, not a hand-maintained ci-checks.mjs entry like `greeting`
		// above) -- the full categories+plugins+type-aware oxlint sweep
		// (lint.yml), most of whose findings are un-triaged on master today
		// (see the PR body's per-rule table), so this must never gate like
		// `lint:js` does. See the dedicated "classified by the suffix, not
		// an explicit allowlist entry" case below for the proof that this
		// name carries NO entry in `ADVISORY_CHECKS`.
		"oxlint (advisory)",
		// #3087: install-smoke's mise-repro is continue-on-error on every event,
		// so its cells always conclude success; the "(advisory)" suffix makes
		// ci-verdict read them as advisory instead of a gating pass.
		"mise repro (#285) · ubuntu-latest · ${{ matrix.pi_via }} (advisory)",
		"mise repro (#285) · macos-latest · ${{ matrix.pi_via }} (advisory)",
		...EXTERNAL_ADVISORY_NAMES,
	]);

	it("finds a non-empty, real job-name set to classify (the enumeration itself works)", () => {
		const names = jobNamesFromPrTriggeredWorkflows();
		expect(names.size).toBeGreaterThan(5);
		expect(names.has("Unit tests")).toBe(true);
		expect(names.has("Install test (ubuntu-latest)")).toBe(true);
	});

	it("classifies every job name mechanically discovered from ci.yml/lint.yml/osv-scan.yml/greetings.yml, with none left unclassified", () => {
		const names = jobNamesFromPrTriggeredWorkflows();
		const mismatches: string[] = [];
		for (const name of names) {
			const expectedAdvisory = EXPECTED_ADVISORY.has(name);
			if (isAdvisoryCheck(name) !== expectedAdvisory) {
				mismatches.push(
					`${name}: isAdvisoryCheck=${isAdvisoryCheck(name)}, expected=${expectedAdvisory}`,
				);
			}
		}
		expect(mismatches).toEqual([]);
	});

	// The reviewer's explicit gating list, plus the externally-sourced
	// Analyze(<lang>) jobs -- a mutation guard against a future accidental
	// addition of any of these to the advisory allowlist. `Install test (*)`
	// is pinned here exactly like `Production install build` already was in
	// the #2609 (round 1) describe block above.
	it("the reviewer's named gating list is NOT advisory", () => {
		for (const name of [
			...EXTERNAL_GATING_NAMES,
			"Detect lockfile change",
			"PR title",
			"actionlint",
			"markdownlint",
			"Dependency boundaries",
			"Close-keyword syntax",
			"Changelog fragment (fast-fail)",
			"Validate merge-train dispatch",
			"Install test (ubuntu-latest)",
			"Install test (windows-latest)",
			"Install test (macos-latest)",
			"Production install build (--omit=dev, from source)",
			"oxfmt format check",
		]) {
			expect(isAdvisoryCheck(name)).toBe(false);
		}
	});

	it("the reviewer's named advisory list IS advisory, including the newly-added greeting", () => {
		for (const name of [
			...EXTERNAL_ADVISORY_NAMES,
			"greeting",
			"PR body (advisory)",
			"Vale prose lint (advisory)",
			"OSV scan (advisory)",
			"oxlint (advisory)",
			"jscpd (advisory)",
			"yamllint (advisory)",
			"typos (advisory)",
			"taplo (advisory)",
			"mutation (advisory)",
		]) {
			expect(isAdvisoryCheck(name)).toBe(true);
		}
	});

	// #2700 review round 3: the repo's settled convention for a NEW advisory
	// job is the `(advisory)` name suffix with no continue-on-error (what
	// `Vale prose lint (advisory)` above and
	// osv-scan.yml already do) -- not a hand-maintained ADVISORY_CHECKS
	// entry like `greeting`'s (that shape exists only because `greeting`'s
	// real GitHub Actions job name, from greetings.yml's job KEY, carries no
	// suffix at all and cannot be renamed without losing the upstream
	// action's own posting identity). Proves the classification comes from
	// the suffix, not a copy this file forgot to keep updated.
	it("oxlint (advisory) is classified by the name suffix, not a hand-maintained ADVISORY_CHECKS entry", () => {
		expect(ADVISORY_CHECKS.has("oxlint (advisory)")).toBe(false);
		expect(isAdvisoryCheck("oxlint (advisory)")).toBe(true);
	});

	it("registers the four tool jobs in the explicit advisory allowlist (#2706)", () => {
		expect([...ADVISORY_CHECKS]).toEqual(
			expect.arrayContaining([
				"jscpd (advisory)",
				"yamllint (advisory)",
				"typos (advisory)",
				"taplo (advisory)",
				"mutation (advisory)",
				"complexity (advisory)",
				"Targeted tests (advisory)",
			]),
		);
	});
});

describe("isAdvisoryCheck — workflow advisory names stay in policy", () => {
	it("classifies every advisory-named job across all workflows", () => {
		const mismatches: string[] = [];
		const discovered: string[] = [];
		for (const entry of readdirSync(
			resolve(import.meta.dirname, "../../.github/workflows"),
		)) {
			if (!/\.ya?ml$/i.test(entry)) continue;
			const document = yaml.load(
				readFileSync(
					resolve(import.meta.dirname, "../../.github/workflows", entry),
					"utf8",
				),
			) as { jobs?: Record<string, { name?: unknown }> };
			for (const [key, job] of Object.entries(document.jobs ?? {})) {
				const name = typeof job?.name === "string" ? job.name : key;
				if (!name.toLowerCase().includes("advisory")) continue;
				discovered.push(`${entry}:${key}=${name}`);
				if (!isAdvisoryCheck(name)) mismatches.push(`${entry}:${key}=${name}`);
			}
		}
		expect(discovered).not.toEqual([]);
		expect(mismatches).toEqual([]);
	});
});

describe("run — prints the gating source and uses a live branch-protection read (#2609)", () => {
	it("documents the branch-protection source and threads it into the verdict", async () => {
		const ghExec = (args: string[]) => {
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
			if (args[1] === "repos/acme/repo/branches/master/protection") {
				return JSON.stringify({
					required_status_checks: {
						contexts: ["Unit tests", "Lint & type-check"],
					},
				});
			}
			return JSON.stringify(BOTH_SUCCESS);
		};
		const stdoutLines: string[] = [];
		const exitCode = await run({
			argv: ["2539"],
			ghExec,
			stdout: (line: string) => stdoutLines.push(line),
			stderr: () => {},
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(
			stdoutLines.some((l) => l.startsWith("Gating source: branch protection")),
		).toBe(true);
	});

	it("falls back to the advisory-allowlist wording when branch protection is unreadable", async () => {
		const ghExec = (args: string[]) => {
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
			if (args[1] === "repos/acme/repo/branches/master/protection") {
				throw new Error("HTTP 403");
			}
			return JSON.stringify(BOTH_SUCCESS);
		};
		const stdoutLines: string[] = [];
		const exitCode = await run({
			argv: ["2539"],
			ghExec,
			stdout: (line: string) => stdoutLines.push(line),
			stderr: () => {},
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(
			stdoutLines.some((l) =>
				l.startsWith("Gating source: advisory allowlist only"),
			),
		).toBe(true);
	});
});

describe("formatVerdictTable", () => {
	it("renders a fixed CHECK/STATUS/CONCLUSION/URL table", () => {
		const verdict = computeVerdict(BOTH_SUCCESS);
		const table = formatVerdictTable(verdict.rows);
		const lines = table.split("\n");
		expect(lines[0]).toMatch(/^CHECK\s+STATUS\s+CONCLUSION\s+URL\s*$/);
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("Unit tests");
		expect(lines[2]).toContain("Lint & type-check");
	});

	it("shows an absent required check as 'absent' with no conclusion or URL", () => {
		const verdict = computeVerdict({ check_runs: [] });
		const table = formatVerdictTable(verdict.rows);
		for (const line of table.split("\n").slice(1)) {
			expect(line).toContain("absent");
		}
	});
});

describe("isPrNumber", () => {
	it.each(["2539", "1", "000123"])("treats %s as a PR number", (value) => {
		expect(isPrNumber(value)).toBe(true);
	});

	it.each(["abc1234", "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", ""])(
		"treats %s as sha-shaped, not a PR number",
		(value) => {
			expect(isPrNumber(value)).toBe(false);
		},
	);
});

describe("resolveWaitCapSeconds — the hard cap", () => {
	it("clamps a requested wait above the hard cap down to the hard cap", () => {
		expect(resolveWaitCapSeconds(HARD_CAP_SECONDS * 10)).toBe(HARD_CAP_SECONDS);
	});

	it("passes a requested wait under the cap through unchanged", () => {
		expect(resolveWaitCapSeconds(60)).toBe(60);
	});

	it("treats a missing/non-positive wait as no waiting at all", () => {
		expect(resolveWaitCapSeconds(null as unknown as number)).toBe(0);
		expect(resolveWaitCapSeconds(0)).toBe(0);
		expect(resolveWaitCapSeconds(-5)).toBe(0);
		expect(resolveWaitCapSeconds(Number.NaN)).toBe(0);
	});
});

describe("pollVerdict", () => {
	it("does exactly ONE fetch by default (no --wait): the issue's baseline promise", async () => {
		let calls = 0;
		const fetchPayload = async () => {
			calls += 1;
			return {
				check_runs: [
					checkRun({
						name: "Unit tests",
						status: "in_progress",
						conclusion: null,
						id: 1,
					}),
					checkRun({ name: "Lint & type-check", id: 2 }),
				],
			};
		};
		const { verdict, polls } = await pollVerdict({
			fetchPayload,
			waitSeconds: null,
		});
		expect(calls).toBe(1);
		expect(polls).toBe(1);
		expect(verdict.exitCode).toBe(EXIT_PENDING);
	});

	it("stops polling immediately once the verdict is no longer pending", async () => {
		// Fake clock (not real Date.now): a mutant that drops the
		// exitCode!==EXIT_PENDING stop condition would otherwise busy-loop for
		// the full real 300s wait budget before this test could catch it.
		let clock = 0;
		let calls = 0;
		let sleeps = 0;
		const fetchPayload = async () => {
			calls += 1;
			return BOTH_SUCCESS;
		};
		const { polls } = await pollVerdict({
			fetchPayload,
			waitSeconds: 300,
			now: () => clock,
			sleepImpl: async (ms: number) => {
				sleeps += 1;
				clock += ms;
			},
		});
		expect(calls).toBe(1);
		expect(polls).toBe(1);
		expect(sleeps).toBe(0);
	});

	it("polls at the fixed >=30s interval, bounded by the hard cap, while pending", async () => {
		let clock = 0;
		const now = () => clock;
		let sleeps = 0;
		const sleepIntervals: number[] = [];
		const fetchPayload = async () => ({
			check_runs: [
				checkRun({
					name: "Unit tests",
					status: "in_progress",
					conclusion: null,
					id: 1,
				}),
				checkRun({
					name: "Lint & type-check",
					status: "in_progress",
					conclusion: null,
					id: 2,
				}),
			],
		});
		const sleepImpl = async (ms: number) => {
			sleeps += 1;
			sleepIntervals.push(ms);
			clock += ms;
		};
		const requestedWaitSeconds = HARD_CAP_SECONDS * 100; // wildly over the cap
		const { verdict, polls } = await pollVerdict({
			fetchPayload,
			waitSeconds: requestedWaitSeconds,
			sleepImpl,
			now,
		});
		expect(verdict.exitCode).toBe(EXIT_PENDING);
		// Bounded by HARD_CAP_SECONDS, not the wildly larger requested wait.
		const expectedSleeps = Math.floor(HARD_CAP_SECONDS / POLL_INTERVAL_SECONDS);
		expect(sleeps).toBe(expectedSleeps);
		expect(polls).toBe(expectedSleeps + 1);
		expect(
			sleepIntervals.every((ms) => ms === POLL_INTERVAL_SECONDS * 1000),
		).toBe(true);
	});

	// #2539 round 2, F1: `mergeable` must actually reach `computeVerdict`
	// through the poll loop, not just be accepted as a dead parameter.
	it("threads `mergeable` through to computeVerdict on every read", async () => {
		const fetchPayload = async () => ({
			check_runs: [checkRun({ name: "Unit tests", id: 1 })],
		});
		const conflicting = await pollVerdict({
			fetchPayload,
			waitSeconds: null,
			mergeable: "CONFLICTING",
		});
		expect(conflicting.verdict.exitCode).toBe(EXIT_DIRTY);
		const mergeableOne = await pollVerdict({
			fetchPayload,
			waitSeconds: null,
			mergeable: "MERGEABLE",
		});
		expect(mergeableOne.verdict.exitCode).toBe(EXIT_PENDING);
	});

	// #2539 round 2, F4: `fetchPayload` must receive the remaining wait budget
	// so a caller can derive a `gh` call's own timeout from it. `undefined` on
	// a one-shot read (no `--wait` at all); a decreasing number while polling.
	it("passes the remaining wait budget to fetchPayload, undefined with no --wait", async () => {
		const remainingArgs: (number | undefined)[] = [];
		await pollVerdict({
			fetchPayload: async (remainingMs) => {
				remainingArgs.push(remainingMs);
				return BOTH_SUCCESS;
			},
			waitSeconds: null,
		});
		expect(remainingArgs).toEqual([undefined]);

		let clock = 0;
		const waitArgs: (number | undefined)[] = [];
		await pollVerdict({
			fetchPayload: async (remainingMs) => {
				waitArgs.push(remainingMs);
				return clock === 0
					? {
							check_runs: [
								checkRun({
									name: "Unit tests",
									status: "in_progress",
									conclusion: null,
									id: 1,
								}),
								checkRun({ name: "Lint & type-check", id: 2 }),
							],
						}
					: BOTH_SUCCESS;
			},
			waitSeconds: 60,
			now: () => clock,
			sleepImpl: async (ms: number) => {
				clock += ms;
			},
		});
		expect(waitArgs).toEqual([60_000, 30_000]);
	});
});

describe("resolveGhTimeoutMs — the derived per-call gh timeout (#2539 round 2, F4)", () => {
	it("falls back to the flat default with no wait budget (undefined/null, not a number)", () => {
		expect(resolveGhTimeoutMs(undefined)).toBe(DEFAULT_GH_TIMEOUT_MS);
		expect(resolveGhTimeoutMs(null as unknown as number)).toBe(
			DEFAULT_GH_TIMEOUT_MS,
		);
	});

	it("uses the remaining budget when it is between the floor and the default", () => {
		expect(resolveGhTimeoutMs(5_000)).toBe(5_000);
		expect(resolveGhTimeoutMs(30_000)).toBe(30_000);
	});

	it("clamps to the default when the remaining budget is larger", () => {
		expect(resolveGhTimeoutMs(HARD_CAP_SECONDS * 1000)).toBe(
			DEFAULT_GH_TIMEOUT_MS,
		);
	});
});

// #2539 round 3, F2: `resolveGhTimeoutMs` clamped straight to the literal
// remaining budget with no floor. A probe on `--wait 31` derived a 50ms
// timeout for the last poll and killed a healthy ~950ms `gh` call (exit 70
// over a genuinely green head). Separately, a budget already at its deadline
// (remainingMs === 0) fell through the `remainingMs > 0` guard to the FULL
// 60s default -- the opposite failure, on the very call meant to end the
// wait. `MIN_GH_TIMEOUT_MS` floors both.
describe("resolveGhTimeoutMs — floored at MIN_GH_TIMEOUT_MS (#2539 round 3, F2)", () => {
	it("floors a tiny positive remainder up to MIN_GH_TIMEOUT_MS instead of killing a healthy call", () => {
		// `--wait 31` on the last poll: 31s cap, 30.95s already spent sleeping
		// at the fixed 30s interval, ~50ms left -- the exact live-probe shape.
		expect(resolveGhTimeoutMs(50)).toBe(MIN_GH_TIMEOUT_MS);
		expect(resolveGhTimeoutMs(1)).toBe(MIN_GH_TIMEOUT_MS);
	});

	it("floors an exhausted budget (remainingMs === 0) instead of granting the full 60s default", () => {
		// The deadline is already reached -- this is the LAST call before
		// giving up, and it must not itself get a fresh 60s timeout that could
		// blow the `--wait` budget it was derived from.
		expect(resolveGhTimeoutMs(0)).toBe(MIN_GH_TIMEOUT_MS);
	});

	it("MIN_GH_TIMEOUT_MS is well under DEFAULT_GH_TIMEOUT_MS and the hard cap", () => {
		expect(MIN_GH_TIMEOUT_MS).toBeGreaterThan(0);
		expect(MIN_GH_TIMEOUT_MS).toBeLessThan(DEFAULT_GH_TIMEOUT_MS);
	});
});

describe("fetchCheckRunsPayload — timeout wiring (#2539 round 2, F4)", () => {
	it("passes the timeoutMs through to ghExec's own options", () => {
		const calls: Array<{ args: string[]; options: unknown }> = [];
		const ghExec = (args: string[], options: unknown) => {
			calls.push({ args, options });
			return JSON.stringify({ check_runs: [] });
		};
		fetchCheckRunsPayload("acme/repo", "deadbeef", ghExec, 12_345);
		expect(calls).toHaveLength(1);
		expect(calls[0].options).toEqual({ timeoutMs: 12_345 });
		expect(calls[0].args).toEqual([
			"api",
			"repos/acme/repo/commits/deadbeef/check-runs?per_page=100&page=1",
		]);
	});

	it("defaults to DEFAULT_GH_TIMEOUT_MS when no timeout is given", () => {
		const calls: unknown[] = [];
		const ghExec = (_args: string[], options: unknown) => {
			calls.push(options);
			return JSON.stringify({ check_runs: [] });
		};
		fetchCheckRunsPayload("acme/repo", "deadbeef", ghExec);
		expect(calls[0]).toEqual({ timeoutMs: DEFAULT_GH_TIMEOUT_MS });
	});
});

describe("resolveRepository", () => {
	it("resolves and trims the gh CLI's own nameWithOwner jq output", () => {
		const ghExec = (args: string[]) => {
			expect(args).toEqual([
				"repo",
				"view",
				"--json",
				"nameWithOwner",
				"--jq",
				".nameWithOwner",
			]);
			return "acme/repo\n";
		};
		expect(resolveRepository(ghExec)).toBe("acme/repo");
	});

	// #2539 round 3, F2: this call used to fire with NO options at all, so it
	// fell back to the `gh()` wrapper's own default (a flat 60s) with no
	// relationship whatsoever to `--wait` -- the same gap F4 closed for the
	// check-runs read, just missed here.
	it("passes the timeoutMs through to ghExec's own options", () => {
		const calls: unknown[] = [];
		const ghExec = (_args: string[], options: unknown) => {
			calls.push(options);
			return "acme/repo";
		};
		resolveRepository(ghExec, 12_345);
		expect(calls[0]).toEqual({ timeoutMs: 12_345 });
	});

	it("defaults to DEFAULT_GH_TIMEOUT_MS when no timeout is given", () => {
		const calls: unknown[] = [];
		const ghExec = (_args: string[], options: unknown) => {
			calls.push(options);
			return "acme/repo";
		};
		resolveRepository(ghExec);
		expect(calls[0]).toEqual({ timeoutMs: DEFAULT_GH_TIMEOUT_MS });
	});
});

describe("resolveHeadSha — mergeable resolution (#2539 round 2, F1)", () => {
	it("resolves sha AND mergeable via ONE gh pr view call for a PR number", () => {
		const calls: string[][] = [];
		const ghExec = (args: string[]) => {
			calls.push(args);
			return JSON.stringify({
				headRefOid: "c0ffee123456",
				mergeable: "CONFLICTING",
			});
		};
		const result = resolveHeadSha("2539", ghExec);
		expect(result).toEqual({ sha: "c0ffee123456", mergeable: "CONFLICTING" });
		expect(calls).toEqual([
			["pr", "view", "2539", "--json", "headRefOid,mergeable"],
		]);
	});

	it("returns mergeable: null for a bare SHA target, with no gh call at all", () => {
		const ghExec = () => {
			throw new Error("must not call gh for a bare SHA target");
		};
		expect(resolveHeadSha("abc1234", ghExec)).toEqual({
			sha: "abc1234",
			mergeable: null,
		});
	});

	// #2539 round 3, F2: same gap as resolveRepository above.
	it("passes the timeoutMs through to ghExec's own options for a PR-number target", () => {
		const calls: unknown[] = [];
		const ghExec = (_args: string[], options: unknown) => {
			calls.push(options);
			return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
		};
		resolveHeadSha("2539", ghExec, 12_345);
		expect(calls[0]).toEqual({ timeoutMs: 12_345 });
	});

	it("defaults to DEFAULT_GH_TIMEOUT_MS when no timeout is given", () => {
		const calls: unknown[] = [];
		const ghExec = (_args: string[], options: unknown) => {
			calls.push(options);
			return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
		};
		resolveHeadSha("2539", ghExec);
		expect(calls[0]).toEqual({ timeoutMs: DEFAULT_GH_TIMEOUT_MS });
	});
});

describe("resolveClassification — label freshness (#2856)", () => {
	it("ignores a verdict label whose classifier marker belongs to an older head", () => {
		const ghExec = () =>
			JSON.stringify({
				headRefOid: "abcdef1234567",
				labels: [{ name: "ci:real" }],
				comments: [
					{
						body: "ci-classifier: real — first failure: old <!-- ci-classifier:sha=0123456789abc rerun=false -->",
					},
				],
			});
		expect(resolveClassification("2856", ghExec)).toBeNull();
	});

	it("accepts a verdict label only when its classifier marker matches the head", () => {
		const ghExec = () =>
			JSON.stringify({
				headRefOid: "abcdef1234567",
				labels: [{ name: "ci:infra" }],
				comments: [
					{
						body: "ci-classifier: infra-kill (detail) <!-- ci-classifier:sha=abcdef1234567 rerun=false -->",
					},
				],
			});
		expect(resolveClassification("2856", ghExec)).toBe("infra-kill");
	});
});

// #2539 round 3, F2: `run()` must derive resolveRepository/resolveHeadSha's
// timeout from the FULL clamped `--wait` budget (nothing spent yet when
// they fire), not the flat default -- otherwise a small `--wait` still lets
// an unbounded 60s hang on either of these two calls blow the whole budget
// before polling even starts.
describe("run — resolveRepository/resolveHeadSha get a --wait-derived timeout (#2539 round 3, F2)", () => {
	it("derives the initial timeout from the full --wait cap, floored at MIN_GH_TIMEOUT_MS", async () => {
		const seenTimeouts: unknown[] = [];
		const ghExec = (args: string[], options?: { timeoutMs?: number }) => {
			seenTimeouts.push(options?.timeoutMs);
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
			return JSON.stringify(BOTH_SUCCESS);
		};
		await run({
			argv: ["2539", "--wait", "1"],
			ghExec,
			stdout: () => {},
			stderr: () => {},
		});
		// --wait 1 (1s = 1000ms) is under MIN_GH_TIMEOUT_MS, so both the
		// repository and PR-view calls must floor to MIN_GH_TIMEOUT_MS, not
		// clamp down to 1000ms and not fall back to the 60s default.
		expect(seenTimeouts[0]).toBe(MIN_GH_TIMEOUT_MS);
		expect(seenTimeouts[1]).toBe(MIN_GH_TIMEOUT_MS);
	});

	it("falls back to the flat default with no --wait", async () => {
		const seenTimeouts: unknown[] = [];
		const ghExec = (args: string[], options?: { timeoutMs?: number }) => {
			seenTimeouts.push(options?.timeoutMs);
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
			return JSON.stringify(BOTH_SUCCESS);
		};
		await run({
			argv: ["2539"],
			ghExec,
			stdout: () => {},
			stderr: () => {},
		});
		expect(seenTimeouts[0]).toBe(DEFAULT_GH_TIMEOUT_MS);
		expect(seenTimeouts[1]).toBe(DEFAULT_GH_TIMEOUT_MS);
	});
});

describe("run — exit codes distinct from verdict codes (#2539 round 2, F3)", () => {
	it("exits 64 (usage) with no target, before any gh call", async () => {
		const ghExec = () => {
			throw new Error("must not call gh on a usage error");
		};
		const stderrLines: string[] = [];
		const exitCode = await run({
			argv: [],
			ghExec,
			stdout: () => {},
			stderr: (line: string) => stderrLines.push(line),
		});
		expect(exitCode).toBe(EXIT_USAGE);
		expect(exitCode).not.toBe(EXIT_DIRTY); // 64, never collides with 2
		expect(stderrLines.join("\n")).toMatch(/usage:/);
	});

	it("exits 70 (transport), not 1, when gh itself fails", async () => {
		const ghExec = () => {
			throw new Error("gh: command not found");
		};
		const stderrLines: string[] = [];
		const exitCode = await run({
			argv: ["2539"],
			ghExec,
			stdout: () => {},
			stderr: (line: string) => stderrLines.push(line),
		});
		expect(exitCode).toBe(EXIT_TRANSPORT);
		expect(exitCode).not.toBe(EXIT_FAILURE); // 70, never collides with 1
		expect(stderrLines.join("\n")).toMatch(/command not found/);
	});

	it("returns the real verdict exit code end to end for a healthy PR", async () => {
		const ghExec = (args: string[]) => {
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({
					headRefOid: "c0ffee",
					mergeable: "MERGEABLE",
				});
			return JSON.stringify(BOTH_SUCCESS);
		};
		const stdoutLines: string[] = [];
		const exitCode = await run({
			argv: ["2539"],
			ghExec,
			stdout: (line: string) => stdoutLines.push(line),
			stderr: () => {},
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(stdoutLines.join("\n")).toContain("acme/repo@c0ffee");
	});
});

describe("parseArgs", () => {
	it("parses the positional target and an optional --wait value", () => {
		expect(parseArgs(["2539"])).toEqual({ target: "2539", waitSeconds: null });
		expect(parseArgs(["2539", "--wait", "60"])).toEqual({
			target: "2539",
			waitSeconds: 60,
		});
		expect(parseArgs(["abc1234", "--wait", "90"])).toEqual({
			target: "abc1234",
			waitSeconds: 90,
		});
	});

	it("returns a null target when no positional argument is given", () => {
		expect(parseArgs([])).toEqual({ target: null, waitSeconds: null });
	});
});

// #2935: a GitHub API outage used to kill every armed `--wait` at once with
// exit 70. A transient `gh` failure (network, 5xx, a gh call that hit its own
// timeout) now backs off and keeps waiting inside the remaining budget; an
// auth/repo error still exits 70 on the spot.
describe("run --wait — transient gh errors back off instead of exiting 70 (#2935)", () => {
	function ghError(stderr: string, extra: Record<string, unknown> = {}) {
		return Object.assign(new Error(`Command failed: gh api\n${stderr}`), {
			status: 1,
			stderr,
			...extra,
		});
	}

	// A fake `gh` whose check-runs read throws `failures` in order, then
	// answers green. Every other call answers normally.
	function flakyGh(failures: Error[]) {
		let checkRunsCalls = 0;
		const ghExec = (args: string[]) => {
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({
					headRefOid: "c0ffee",
					mergeable: "MERGEABLE",
					labels: [],
					comments: [],
				});
			if (String(args[1]).endsWith("/protection")) throw ghError("HTTP 404");
			checkRunsCalls += 1;
			const failure = failures[checkRunsCalls - 1];
			if (failure) throw failure;
			return JSON.stringify(BOTH_SUCCESS);
		};
		return { ghExec, checkRunsCalls: () => checkRunsCalls };
	}

	function fakeClock() {
		let clock = 0;
		const sleeps: number[] = [];
		return {
			now: () => clock,
			sleepImpl: async (ms: number) => {
				sleeps.push(ms);
				clock += ms;
			},
			sleeps,
		};
	}

	const CONNECT =
		"error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com";

	it("fails N times, then succeeds: exit 0, one line per retry, 30 s doubling", async () => {
		const { ghExec, checkRunsCalls } = flakyGh([
			ghError(CONNECT),
			ghError("HTTP 502: Bad Gateway (https://api.github.com/repos/acme/repo)"),
			ghError(CONNECT),
		]);
		const clock = fakeClock();
		const stderrLines: string[] = [];
		const exitCode = await run({
			argv: ["2935", "--wait", "600"],
			ghExec,
			stdout: () => {},
			stderr: (line: string) => stderrLines.push(line),
			now: clock.now,
			sleepImpl: clock.sleepImpl,
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(checkRunsCalls()).toBe(4);
		expect(clock.sleeps).toEqual([30_000, 60_000, 120_000]);
		const retryLines = stderrLines.filter((line) => /transient/.test(line));
		expect(retryLines).toHaveLength(3);
		expect(retryLines[0]).toMatch(/retrying in 30s/);
	});

	it("resets the backoff after a successful read", async () => {
		const PENDING = JSON.stringify({
			check_runs: [
				checkRun({
					name: "Unit tests",
					status: "in_progress",
					conclusion: null,
					id: 1,
				}),
				checkRun({ name: "Lint & type-check", id: 2 }),
			],
		});
		const answers: Array<Error | string> = [
			ghError(CONNECT),
			ghError(CONNECT),
			PENDING,
			ghError(CONNECT),
			JSON.stringify(BOTH_SUCCESS),
		];
		const ghExec = (args: string[]) => {
			if (args[0] === "repo") return "acme/repo";
			if (args[0] === "pr")
				return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
			if (String(args[1]).endsWith("/protection")) throw ghError("HTTP 404");
			const answer = answers.shift();
			if (answer instanceof Error) throw answer;
			return answer as string;
		};
		const clock = fakeClock();
		const exitCode = await run({
			argv: ["2935", "--wait", "600"],
			ghExec,
			stdout: () => {},
			stderr: () => {},
			now: clock.now,
			sleepImpl: clock.sleepImpl,
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		// 30, 60 (backoff), 30 (poll interval), then 30 again, not 120.
		expect(clock.sleeps).toEqual([
			30_000,
			60_000,
			POLL_INTERVAL_SECONDS * 1000,
			30_000,
		]);
	});

	it("caps the backoff at 5 minutes", async () => {
		const { ghExec } = flakyGh(
			Array.from({ length: 5 }, () => ghError(CONNECT)),
		);
		const clock = fakeClock();
		const exitCode = await run({
			argv: ["2935", "--wait", String(HARD_CAP_SECONDS)],
			ghExec,
			stdout: () => {},
			stderr: () => {},
			now: clock.now,
			sleepImpl: clock.sleepImpl,
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(clock.sleeps).toEqual([30_000, 60_000, 120_000, 240_000, 300_000]);
	});

	it("exits 70 only once the budget is exhausted while still unreachable, never sleeping past it", async () => {
		const { ghExec, checkRunsCalls } = flakyGh(
			Array.from({ length: 100 }, () => ghError(CONNECT)),
		);
		const clock = fakeClock();
		const stderrLines: string[] = [];
		const exitCode = await run({
			argv: ["2935", "--wait", "100"],
			ghExec,
			stdout: () => {},
			stderr: (line: string) => stderrLines.push(line),
			now: clock.now,
			sleepImpl: clock.sleepImpl,
		});
		expect(exitCode).toBe(EXIT_TRANSPORT);
		// 30 + 60, then only the 10 s left, then one last read at the deadline.
		expect(clock.sleeps).toEqual([30_000, 60_000, 10_000]);
		expect(checkRunsCalls()).toBe(4);
		expect(stderrLines.at(-1)).toMatch(/error connecting to api\.github\.com/);
	});

	it("keeps the immediate exit 70 for an auth or repo error inside --wait", async () => {
		for (const stderr of [
			"HTTP 401: Bad credentials (https://api.github.com/repos/acme/repo)",
			"HTTP 404: Not Found (https://api.github.com/repos/acme/repo/commits/c0ffee/check-runs)",
			"To get started with GitHub CLI, please run:  gh auth login",
		]) {
			const { ghExec, checkRunsCalls } = flakyGh([ghError(stderr)]);
			const clock = fakeClock();
			const exitCode = await run({
				argv: ["2935", "--wait", "600"],
				ghExec,
				stdout: () => {},
				stderr: () => {},
				now: clock.now,
				sleepImpl: clock.sleepImpl,
			});
			expect(exitCode, stderr).toBe(EXIT_TRANSPORT);
			expect(checkRunsCalls(), stderr).toBe(1);
			expect(clock.sleeps, stderr).toEqual([]);
		}
	});

	it("a one-shot read (no --wait) still exits 70 on a transient error", async () => {
		const { ghExec, checkRunsCalls } = flakyGh([ghError(CONNECT)]);
		const clock = fakeClock();
		const exitCode = await run({
			argv: ["2935"],
			ghExec,
			stdout: () => {},
			stderr: () => {},
			now: clock.now,
			sleepImpl: clock.sleepImpl,
		});
		expect(exitCode).toBe(EXIT_TRANSPORT);
		expect(checkRunsCalls()).toBe(1);
		expect(clock.sleeps).toEqual([]);
	});

	// #2935 remainder: the two startup lookups (`gh repo view`, `gh pr view`)
	// ran before the retry loop, so a wait armed while GitHub was already
	// down still exited 70 at once.
	function startupFlakyGh(repoFailures: Error[], prFailures: Error[]) {
		const calls = { repo: 0, pr: 0 };
		const ghExec = (args: string[]) => {
			if (args[0] === "repo") {
				calls.repo += 1;
				const failure = repoFailures[calls.repo - 1];
				if (failure) throw failure;
				return "acme/repo";
			}
			if (args[0] === "pr" && args.join(" ").includes("headRefOid,mergeable")) {
				calls.pr += 1;
				const failure = prFailures[calls.pr - 1];
				if (failure) throw failure;
				return JSON.stringify({ headRefOid: "c0ffee", mergeable: "MERGEABLE" });
			}
			if (args[0] === "pr")
				return JSON.stringify({
					headRefOid: "c0ffee",
					labels: [],
					comments: [],
				});
			if (String(args[1]).endsWith("/protection")) throw ghError("HTTP 404");
			return JSON.stringify(BOTH_SUCCESS);
		};
		return { ghExec, calls };
	}

	it("retries the startup lookups on a transient error inside --wait", async () => {
		const { ghExec, calls } = startupFlakyGh(
			[ghError(CONNECT), ghError(CONNECT)],
			[ghError("HTTP 503: Service Unavailable")],
		);
		const clock = fakeClock();
		const stderrLines: string[] = [];
		const exitCode = await run({
			argv: ["2935", "--wait", "600"],
			ghExec,
			stdout: () => {},
			stderr: (line: string) => stderrLines.push(line),
			now: clock.now,
			sleepImpl: clock.sleepImpl,
		});
		expect(exitCode).toBe(EXIT_SUCCESS);
		expect(calls).toEqual({ repo: 3, pr: 2 });
		// Each lookup backs off from 30 s on its own.
		expect(clock.sleeps).toEqual([30_000, 60_000, 30_000]);
		expect(stderrLines.filter((line) => /transient/.test(line))).toHaveLength(
			3,
		);
	});

	it("counts startup retries against the same --wait budget", async () => {
		// 100 s budget: 30 + 60 s spent getting the repo leaves 10 s, so the
		// head-SHA lookup gets one 10 s wait and one final try at the deadline.
		const { ghExec, calls } = startupFlakyGh(
			[ghError(CONNECT), ghError(CONNECT)],
			Array.from({ length: 10 }, () => ghError(CONNECT)),
		);
		const clock = fakeClock();
		const exitCode = await run({
			argv: ["2935", "--wait", "100"],
			ghExec,
			stdout: () => {},
			stderr: () => {},
			now: clock.now,
			sleepImpl: clock.sleepImpl,
		});
		expect(exitCode).toBe(EXIT_TRANSPORT);
		expect(clock.sleeps).toEqual([30_000, 60_000, 10_000]);
		expect(calls.pr).toBe(2);
	});

	it("startup retries and the poll share one --wait budget", async () => {
		// One 30 s startup retry, then checks that stay pending: every sleep
		// together must fit inside the 120 s asked for, not 30 s + 120 s.
		let repoCalls = 0;
		const ghExec = (args: string[]) => {
			if (args[0] === "repo") {
				repoCalls += 1;
				if (repoCalls === 1) throw ghError(CONNECT);
				return "acme/repo";
			}
			if (args[0] === "pr")
				return JSON.stringify({
					headRefOid: "c0ffee",
					mergeable: "MERGEABLE",
					labels: [],
					comments: [],
				});
			if (String(args[1]).endsWith("/protection")) throw ghError("HTTP 404");
			return JSON.stringify({
				check_runs: [
					checkRun({
						name: "Unit tests",
						status: "in_progress",
						conclusion: null,
						id: 1,
					}),
					checkRun({ name: "Lint & type-check", id: 2 }),
				],
			});
		};
		const clock = fakeClock();
		const exitCode = await run({
			argv: ["2935", "--wait", "120"],
			ghExec,
			stdout: () => {},
			stderr: () => {},
			now: clock.now,
			sleepImpl: clock.sleepImpl,
		});
		expect(exitCode).toBe(EXIT_PENDING);
		expect(clock.sleeps[0]).toBe(30_000);
		expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(
			120_000,
		);
	});

	it("a one-shot read still exits 70 when a startup lookup fails transiently", async () => {
		const { ghExec, calls } = startupFlakyGh([ghError(CONNECT)], []);
		const clock = fakeClock();
		const exitCode = await run({
			argv: ["2935"],
			ghExec,
			stdout: () => {},
			stderr: () => {},
			now: clock.now,
			sleepImpl: clock.sleepImpl,
		});
		expect(exitCode).toBe(EXIT_TRANSPORT);
		expect(calls.repo).toBe(1);
		expect(clock.sleeps).toEqual([]);
	});
});

describe("isTransientGhError (#2935)", () => {
	const withStderr = (stderr: string, extra: Record<string, unknown> = {}) =>
		Object.assign(new Error("Command failed: gh"), { stderr, ...extra });

	it.each([
		["connect failure", withStderr("error connecting to api.github.com")],
		["HTTP 500", withStderr("HTTP 500: Internal Server Error")],
		["HTTP 502", withStderr("HTTP 502: Bad Gateway")],
		["HTTP 503", withStderr("HTTP 503: Service Unavailable")],
		["HTTP 504", withStderr("HTTP 504: Gateway Timeout")],
		[
			"connection reset",
			withStderr("read tcp 1.2.3.4:5: connection reset by peer"),
		],
		["i/o timeout", withStderr("dial tcp: i/o timeout")],
		["TLS handshake timeout", withStderr("net/http: TLS handshake timeout")],
		[
			"gh hit its own timeout",
			withStderr("", { code: "ETIMEDOUT", signal: "SIGTERM" }),
		],
		[
			"stderr as a Buffer",
			withStderr(Buffer.from("HTTP 503: x") as unknown as string),
		],
	])("%s is transient", (_label, error) => {
		expect(isTransientGhError(error)).toBe(true);
	});

	it.each([
		["HTTP 401", withStderr("HTTP 401: Bad credentials")],
		[
			"HTTP 403",
			withStderr("HTTP 403: Resource not accessible by integration"),
		],
		["HTTP 404", withStderr("HTTP 404: Not Found")],
		["gh auth login", withStderr("please run:  gh auth login")],
		[
			"gh not on PATH",
			Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" }),
		],
		[
			"malformed JSON",
			new SyntaxError("Unexpected token < in JSON at position 0"),
		],
		["a non-Error value", "boom"],
		["undefined", undefined],
	])("%s is not transient", (_label, error) => {
		expect(isTransientGhError(error)).toBe(false);
	});
});
