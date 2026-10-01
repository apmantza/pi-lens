// flake-shape: real-process-spawn — drives the analyzer's real CLI entry point over fixtures, like the sibling analyze-pi-lens-logs.test.ts.
/**
 * #3870: `scripts/analyze-pi-lens-logs.mjs` detects the live-session smells
 * (D1-D16 add, E1-E5 enhance, R1-R2 remove).
 *
 * Fixtures are cuts of the read-only forensics session logs, redacted
 * (`<home>` -> `/home/user`, `plegma` -> `proj`). A row that is not a
 * verbatim cut is labelled where it lives: JSON rows carry a
 * `"fixture":"synthetic: <why>"` field (no detector reads it), and text logs
 * carry a `# synthetic:` or `# subset cut:` line above the rows it covers
 * (the sessionstart parser skips lines without a `[ts]` prefix). Synthetic
 * rows exist only where the real logs hold no row for a must-NOT-flag or
 * boundary case. Each test pins one report row's must-flag and must-NOT-flag
 * cases from section 8.2 of the forensics report; its comment names the real
 * rows and the labelled synthetic ones.
 *
 * The script runs through its real entry point (subprocess with --root/--json)
 * exactly like `analyze-pi-lens-logs.test.ts`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT =
	process.env.PI_LENS_ANALYZE_SCRIPT ??
	path.resolve(HERE, "../../scripts/analyze-pi-lens-logs.mjs");
const FIXTURES = path.resolve(HERE, "../fixtures/analyze-logs");

interface Smell {
	id: string;
	count: number;
	severity: string;
	description: string;
	examples: any[];
}

function run(fixture: string, since = "all"): any {
	const out = execFileSync(
		process.execPath,
		[
			SCRIPT,
			"--root",
			path.join(FIXTURES, fixture),
			"--json",
			"--since",
			since,
		],
		{ encoding: "utf8" },
	);
	return JSON.parse(out);
}

function smell(report: any, id: string): Smell | undefined {
	return report.smells.find((entry: Smell) => entry.id === id) as
		| Smell
		| undefined;
}

describe("analyze-pi-lens-logs.mjs D1-D16 detectors (#3870)", () => {
	it("D1 log-coverage-gap: flags a 10min+ latency gap a live session filled", () => {
		// latency.log.1 last: ...lsp_touch_file ... 2026-09-30T11:52:18.708Z
		// latency.log  first: {"phase":"degradation_ledger",... "ledgerGeneration":31,
		//                      "ts":"2026-09-30T13:08:41.562Z"}
		// Must not flag: the real idle gap 14:44:08Z -> 14:55:23Z (11 minutes, one
		// sessionstart row) and the labelled synthetic 9-minute gap holding 20 rows.
		const report = run("log-coverage-gap");
		expect(report.detectors.logCoverageGap.gaps).toEqual([
			{
				start: "2026-09-30T11:52:18.708Z",
				end: "2026-09-30T13:08:41.562Z",
				minutes: 76,
				sessionstartRows: 25,
				cascadeRows: 0,
			},
		]);
		expect(smell(report, "log-coverage-gap")?.count).toBe(1);
	});

	it("D2 real-log-test-pollution: only test-home markers count as pollution", () => {
		// latency (pid 820094): {"phase":"degradation_ledger","filePath":".../review-3703/.probe-home/pi-lens-3521-witness-home-820094/instances.json",...}
		// extension (pid 240029): {"level":"debug","subsystem":"tool-cwd","message":"cwd runner pytest cwd=.../pi-lens-test-checkout-isolation-xNZNoE/..."}
		// B33: pid 650813's only pi-lens-test- marker sits in metadata.cwd, not
		// message, so the row proves the scan is over the full JSON object.
		const report = run("real-log-test-pollution");
		const d2 = report.detectors.realLogTestPollution;
		// two real witness-home rows plus the labelled synthetic witness-home
		// row the #3521 test writes when PI_LENS_HOME is unset
		expect(d2.latencyByPid).toEqual({ "820094": 3 });
		expect(d2.extensionByPid).toEqual({ "240029": 2, "650813": 1 });
		expect(smell(report, "real-log-test-pollution")?.count).toBe(6);
	});

	it("D2 extension-warn-errors: groups warn and error rows only", () => {
		// {"level":"error","subsystem":"dispatch","message":"yamllint: no config detected, running with default rules"} x2
		// {"level":"error","subsystem":"lsp-diagnostics","message":"lens_diagnostics verdict"}; three debug rows are not groups
		const report = run("real-log-test-pollution");
		expect(report.detectors.extensionWarnErrors).toEqual({
			"dispatch: yamllint: no config detected, running with default rules": 2,
			"lsp-diagnostics: lens_diagnostics verdict": 1,
		});
		expect(smell(report, "extension-warn-errors")?.count).toBe(2);
	});

	it("F2: a real session editing under pi-lens-worktrees is not pollution", () => {
		// Recurrence: r1/r2 flagged pid 1947541, a 1.5-day real session, as
		// "never belongs in a real log" because its edits live under
		// ~/Desktop/pi-lens-worktrees. Real rows: tool_result_received
		// toolName:edit and config_resolved on .../fix-3643-review/clients/mcp,
		// two opaque command rows, /tmp/pi-lens-ast-grep (pid 3103055), and the
		// extension row of pid 650812 on .../pi-lens-worktrees/review-3673.
		// Labelled synthetic: two opaque command rows naming a pi-lens-test-*
		// dir (command text, not a path) and an orchestrator session writing
		// under .probe-home/orchestration (pid 1393607).
		const report = run("real-log-test-pollution");
		const d2 = report.detectors.realLogTestPollution;
		expect(d2.latencyByPid["1947541"]).toBeUndefined();
		expect(d2.latencyByPid["1393607"]).toBeUndefined();
		expect(d2.latencyByPid["3103055"]).toBeUndefined();
		expect(d2.extensionByPid["650812"]).toBeUndefined();
	});

	it("D3 turn-end-tests-excluded: flags excluded test files and edit-only runs", () => {
		// [2026-09-30T21:47:54.336Z] turn_end: .worktrees/245-branch-lock-backlog/tests/unit/state-reaper.test.ts
		//   -> test target excluded by the built-in turn-end policy, skipping spawn (...)
		// Real runs: B3 (20:51:33Z: 44 `file(s) modified` lines, 0 ran, 3 excluded
		// test files) and 09-26T17:30:16Z (40 edits, 0 ran) flag; 09-27T07:40:48Z
		// (3 edits, 0 ran) and the B2b subset (12 edits, 1 ran) do not; the
		// labelled synthetic run excludes a SOURCE file's target and does not.
		const report = run("turn-end-tests-excluded");
		const runs = report.detectors.turnEndTestsExcluded.runs;
		expect(
			runs.map((r: any) => [r.startTs, r.edits, r.ran, r.excluded]),
		).toEqual([
			["2026-09-26T17:30:16.185Z", 40, 0, 0],
			["2026-09-30T20:51:33.141Z", 44, 0, 3],
		]);
		expect(smell(report, "turn-end-tests-excluded")?.count).toBe(2);
	});

	it("D4 test-target-cross-checkout: counts runs with at least 3 cross targets", () => {
		// [2026-09-30T11:07:31.035Z] turn_end: .worktrees/471-retained-trees/src/workspace.ts
		//   -> test vitest .worktrees/450-merge-into/tests/unit/workspace.test.ts (failed-first)
		// Real runs: 09-20T22:00 has 4 main-checkout (src/) to worktree targets;
		// 09-21T17:53 has 4 same-checkout targets; 09-22T19:43 has 1 cross
		// target (below 3); the B2 subset has 6 cross and 1 same. The labelled
		// synthetic 11:00 run is cross-checkout but `(safety)` mode, so only the
		// failed-first filter keeps its counts at 0 (B43).
		const report = run("test-target-cross-checkout");
		expect(
			report.detectors.testTargetCrossCheckout.runs.map((r: any) => [
				r.startTs,
				r.crossCheckout,
				r.failedFirst,
			]),
		).toEqual([
			[null, 0, 0], // the rows before the first `session_start fired`
			["2026-09-20T22:00:11.849Z", 4, 8],
			["2026-09-21T17:53:08.201Z", 0, 4],
			["2026-09-22T19:43:07.265Z", 1, 1],
			["2026-09-30T10:03:45.684Z", 6, 7],
			["2026-09-30T11:00:00.000Z", 0, 0],
		]);
		expect(smell(report, "test-target-cross-checkout")?.count).toBe(10);
	});

	it("D5 test-runner-stale-verdicts: judges stale share and delivery per session", () => {
		// [2026-09-30T20:40:34.636Z] turn_end: all tests passed (stale — turn advanced while tests ran)
		// Real runs: 09-23T19:12 (10 firings, 10 stale) flags; 09-25T19:09
		// (5/5) and 09-27T15:30 (9/8) stay under the 10-firing floor even
		// though together they pass it; the B2 subset (10 firings, 4 stale)
		// stays under the 50% share. Delivery: real session 01a0f1c5 (3 of 39
		// delivered) flags; the labelled synthetic sessions (3 of 10, 0 of 9) do not.
		const report = run("test-runner-stale-verdicts");
		const d5 = report.detectors.testRunnerStaleVerdicts;
		expect(d5.staleRuns).toEqual([
			{ startTs: "2026-09-23T19:12:30.754Z", firings: 10, stale: 10 },
		]);
		expect(d5.firings).toBe(34);
		expect(d5.stale).toBe(27);
		expect(
			d5.lowDelivery.map((s: any) => [s.sessionId, s.delivered, s.total]),
		).toEqual([["01a0f1c5-27ff-7414-8319-69eb2296dbe4", 3, 39]]);
		expect(smell(report, "test-runner-stale-verdicts")?.count).toBe(2);
	});

	it("D6 scanner-count-drift: flags a pid on either drift rule", () => {
		// {"phase":"knip","durationMs":7878,"metadata":{"execution":"executed","totalIssues":16187,...}}
		// Real pid 763652 (44 runs, 9256 -> 10758) flags on exactly 5 steps >= 100
		// with a 16% spread; real pid 3205171 (28 runs, 3 steps, 6%) does not.
		// Labelled synthetic pids: 9001 drifts by spread alone; 9002 has 9 runs.
		const report = run("knip");
		expect(
			report.detectors.knip.drift.map((d: any) => [d.pid, d.increments]),
		).toEqual([
			["763652", 5],
			["9001", 0],
		]);
		expect(smell(report, "scanner-count-drift")?.count).toBe(2);
		expect(smell(report, "scanner-count-drift")?.description).toBe(
			"knip totalIssues rose by >= 100 between consecutive executed runs at least 5 times, or its spread >= 25% (pids with >= 10 executed runs)",
		);
	});

	it("D6 turn-end-knip-cost: flags a pid's hourly or single-run knip cost", () => {
		// Real pid 3205171: 68546 ms of executed knip, single row 7878 ms. Real
		// pid 763652: 23107 ms over 1.8 h, max 937 ms, does not flag. Labelled
		// synthetic pid 9004 flags on the hourly rule alone; pid 9003 (4.8 s in
		// 2 minutes) does not, because a lifetime under an hour counts as one.
		// Labelled synthetic pid 9005 has one 40 s row but execution=skipped, so
		// it must not reach the cost table at all (B45 execution filter).
		const report = run("knip");
		expect(
			report.detectors.knip.cost.map((c: any) => [c.pid, c.totalMs, c.maxRow]),
		).toEqual([
			["3205171", 68546, 7878],
			["9004", 35000, 3500],
		]);
		expect(smell(report, "turn-end-knip-cost")?.count).toBe(2);
	});

	it("D7 hook-await-exceeded: reports every overrun and the per-pid ledger census", () => {
		// {"phase":"degradation_ledger","metadata":{"hook":"tool_result_edit","label":"registered-handler",
		//  "budgetMs":"10000","elapsedMs":"11398","kind":"hook-await-exceeded",...}}
		// Real ratios 1.149, 1.14, 1.228, 1.228 are over 1.1; 1.044, 1.007,
		// 1.003, 1.0 are not. The census keeps each kind's MAX count: pid 20730's
		// lsp-document-drift rows carry 4 then 2.
		const report = run("hook-await-exceeded");
		expect(report.detectors.hookAwait.rows).toHaveLength(8);
		expect(report.detectors.hookAwait.over).toBe(4);
		expect(smell(report, "hook-await-exceeded")?.count).toBe(8);
		expect(report.detectors.hookAwait.census).toEqual([
			{
				pid: "20730",
				kinds: [
					"read-guard-record-cap-trim=128",
					"lsp-document-drift=4",
					"hook-await-exceeded=1",
				],
			},
			{ pid: "3205171", kinds: ["hook-await-exceeded=1"] },
		]);
	});

	it("D8 turn-end-slow: flags a pid by slow share or by one long summary", () => {
		// {"type":"tool_result","toolName":"turn_end","durationMs":10188,"metadata":{"blockerSections":0,...}}
		// Real pid 3205171: 14 of 43 over 3 s, max 10188. Real pid 763652: 0 of
		// 42. Labelled synthetic pid 9201 (10 rows, 2 slow, max 4000) is under
		// the 20-row floor; pid 9202 (5 rows, one 8500 ms) flags on max alone.
		const report = run("turn-end-slow");
		expect(
			report.detectors.turnEndSlow.flagged.map((f: any) => [
				f.pid,
				f.rows,
				f.slow,
				f.max,
			]),
		).toEqual([
			["3205171", 43, 14, 10188],
			["9202", 5, 1, 8500],
		]);
		expect(smell(report, "turn-end-slow")?.count).toBe(2);
	});

	it("D8 turn-end-retained-state: flags a session that retained newer turn state 5+ times", () => {
		// [2026-09-30T20:56:36.852Z] turn_end: retaining newer turn state (dispatch=43, current=44)
		// Real runs: B3 (20:51:33Z) has 14 such lines; B2b (12:25:38Z) has 1.
		const report = run("turn-end-slow");
		expect(report.detectors.turnEndSlow.retainRuns).toEqual([
			{ start: "2026-09-30T20:51:33.141Z", count: 14 },
		]);
		expect(smell(report, "turn-end-retained-state")?.count).toBe(1);
	});

	it("D9 lsp-wait-empty-candidates: empty waits, no-client edits, warm-reuse clashes", () => {
		// {"phase":"lsp_touch_file",...,"metadata":{"source":"tool_call:edit","failureKind":"no_clients_none_spawning"}}
		// {"phase":"lsp_client_selected","metadata":{"serverId":"typescript","outcome":"warm-reuse"}}
		// Real rows: pid 3205171 (8 empty waits, 14500 ms; 9 of 26 edit touches
		// saw no client; 6 warm-reuse clashes, plus one at +515 ms that is
		// outside the window); pid 20730 (1500 ms of empty waits; a subset cut
		// of 24 edit touches, 4 with no client; 4 clashes). Two labelled
		// synthetic warm-reuse rows (another pid, another file) do not clash.
		const report = run("lsp-wait-empty-candidates");
		const d9 = report.detectors.lspWait;
		expect(d9.empty).toEqual([{ pid: "3205171", ms: 14500, rows: 8 }]);
		expect(d9.noClients.map((n: any) => [n.pid, n.noClients, n.rows])).toEqual([
			["3205171", 9, 26],
		]);
		const clashes = d9.contradictions.reduce(
			(acc: Record<string, number>, c: any) => ({
				...acc,
				[c.pid]: (acc[c.pid] ?? 0) + 1,
			}),
			{},
		);
		expect(clashes).toEqual({ "20730": 4, "3205171": 6 });
		expect(d9.pidCount).toBe(2);
		expect(smell(report, "lsp-wait-empty-candidates")?.count).toBe(2);
	});

	it("D10 resume-state-loss: separates a lost read set from a genuine zero_read", () => {
		// {"event":"edit_blocked","filePath":".../471-retained-trees/src/workspace.ts",
		//  "metadata":{"readCount":0,"reads":[],"verdictAction":"block","reasonKind":"zero_read"}}
		// Real rows: the three 09-30 zero_read blocks and every earlier row for
		// those files (14, 2, 0). A labelled synthetic read in ANOTHER session
		// does not make the other-session.ts block a lost read set, and a
		// labelled synthetic edit_blocked with reasonKind range_out_of_bounds
		// must stay out of both lists (B38 zero_read filter).
		const report = run("resume-state-loss");
		const d10 = report.detectors.resumeStateLoss;
		const base = (r: any) => path.basename(r.filePath);
		expect(d10.stateLost.map(base).sort()).toEqual([
			"workspace.ts",
			"worktree-captured-dirt.test.ts",
		]);
		expect(d10.genuine.map(base).sort()).toEqual([
			"other-session.ts",
			"router.ts",
		]);
		expect(smell(report, "resume-state-loss")?.count).toBe(2);
	});

	it("F3: a window starting mid-session carries every read-evidence kind", () => {
		// Recurrence: r2 carried only edit_batch_summary across the --since edge,
		// so a 12:00Z window called workspace.ts (whose only pre-window row here
		// is range_snapshot_validation candidateReadCount 1 at 11:07:27Z)
		// genuine. Pre-window rows live in read-guard.log.1, the blocks in
		// read-guard.log, so reading the rotated file first is also pinned.
		const report = run("window-anchors", "2026-09-30T12:00:00Z");
		const d10 = report.detectors.resumeStateLoss;
		const base = (r: any) => path.basename(r.filePath);
		expect(d10.stateLost.map(base).sort()).toEqual([
			"warned-only.ts",
			"workspace.ts",
			"worktree-captured-dirt.test.ts",
		]);
		expect(d10.genuine.map(base).sort()).toEqual([
			"router.ts",
			"unread-a.ts",
			"unread-b.ts",
		]);
		expect(smell(report, "resume-state-loss")?.count).toBe(3);
	});

	it("F3: a window starting after session_start fired keeps the D3 run", () => {
		// Recurrence: r1 dropped the final run when its `session_start fired`
		// (20:51:33Z) preceded the window, so --since 21:00Z zeroed D3.
		const report = run("window-anchors", "2026-09-30T21:00:00Z");
		const runs = report.detectors.turnEndTestsExcluded.runs;
		expect(runs).toHaveLength(1);
		expect(runs[0].startTs).toBe("2026-09-30T20:51:33.141Z");
		expect(runs[0].excluded).toBe(2);
		expect(smell(report, "turn-end-tests-excluded")?.count).toBe(1);
	});

	it("D11 carry-empty-restart: flags an empty carry into a populated branch", () => {
		// {"phase":"read_guard_branch_retained","metadata":{"trigger":"startup","source":"own-sidecar",
		//  "kept":0,"dropped":0,"branchToolResults":1034,"branchReadable":true}}
		// Real rows: that one, two parent-sidecar/live rows that kept and
		// dropped 1, and a source-none startup with 0 results. Labelled
		// synthetic rows: 49 results, source none with 1034, unreadable branch,
		// and kept=0/dropped=1 (B19: only kept+dropped===0 is an empty carry).
		const report = run("carry-empty-restart");
		const carry = report.detectors.carryEmptyRestart;
		expect(carry.map((c: any) => [c.pid, c.branchToolResults])).toEqual([
			["3205171", 1034],
		]);
		expect(smell(report, "carry-empty-restart")?.count).toBe(1);
	});

	it("D12 restart-self-nudge: flags a cross-process nudge after a handoff", () => {
		// {"phase":"agent_nudge","metadata":{"originLocal":0,"originCrossProcess":1,...}}
		// Real: pid 3205171's own-sidecar handoff at 20:51:33.177Z and its two
		// nudges at 20:52:19Z and 20:52:27Z flag. Labelled synthetic: a nudge
		// 301 s after the handoff, another pid's nudge inside the window, a
		// nudge after a handoffSource none start, and a same-pid nudge 177 ms
		// BEFORE the handoff (B20: the nudge must be at or after the handoff).
		const report = run("restart-self-nudge");
		expect(
			report.detectors.restartSelfNudge.map((n: any) => [n.pid, n.ts]),
		).toEqual([
			["3205171", "2026-09-30T20:52:19.339Z"],
			["3205171", "2026-09-30T20:52:27.708Z"],
		]);
		expect(smell(report, "restart-self-nudge")?.count).toBe(2);
		expect(smell(report, "restart-self-nudge")?.description).toContain(
			"suspect-grade",
		);
	});

	it("D13 deferred-runner-failed-undelivered: joins a failed collect-later runner to delivery", () => {
		// {"type":"runner","runnerId":"lsp","status":"failed","diagnosticCount":27,
		//  "metadata":{"tier":"collect-later","delivered":"turn_end"}} then
		// {"phase":"late_runner_findings","metadata":{"failed":1,"delivered":0,"dropped":0,...}}
		// Real: that pair (turn :22), the turn :21 delivery row, and two pid
		// 20730 immediate-tier failures. Labelled synthetic: a turn :23 runner
		// with no delivery row, a delivered one, a dropped one, a delivery that
		// precedes its runner (B22), and a delivery whose failed count is 0
		// (B40).
		const report = run("deferred-runner-failed-undelivered");
		const flags = report.detectors.deferredRunnerFailedUndelivered;
		expect(flags.map((f: any) => [f.pid, f.turnId, f.diagnosticCount])).toEqual(
			[["3205171", "01a0f1c5-27ff-7414-8319-69eb2296dbe4:22", 27]],
		);
		expect(smell(report, "deferred-runner-failed-undelivered")?.count).toBe(1);
	});

	it("D14 aux-stuck-pair: flags an auxiliary pair stuck in two turn ends", () => {
		// {"phase":"late_auxiliary_findings","metadata":{"stuckPairs":[{"filePath":".../src/workspace.ts","serverId":"opengrep"}]}}
		// Real: the 13 late_auxiliary_findings rows of pid 3205171. tools.ts is
		// stuck once and does not flag. Labelled synthetic: the same pair stuck
		// once under pid 9801 and once under pid 9802 must not merge (B39 pid
		// dimension).
		const report = run("aux-stuck-pair");
		expect(
			report.detectors.auxStuckPairs.map((p: any) => [
				p.filePath.split(".worktrees/")[1],
				p.count,
			]),
		).toEqual([
			["245-branch-lock-backlog/src/workspace.ts", 3],
			["245-branch-lock-backlog/src/cli.ts", 2],
			["231-ask3/src/workspace.ts", 2],
		]);
		expect(smell(report, "aux-stuck-pair")?.count).toBe(3);
	});

	it("D15 advisory-provenance-unknown: flags malformed-or-legacy provenance", () => {
		// {"phase":"advisory_provenance_decision","metadata":{"decision":"historical",
		//  "reasons":["malformed-or-legacy-provenance"],"provenanceStamp":"session unknown / turn unknown / generation unknown"}}
		// Real: pid 3205171's first row (20:51:32.500Z) and the malformed row
		// 186 s later; three content-changed historical rows do not flag.
		const report = run("advisory-provenance-unknown");
		const rows = report.detectors.advisoryProvenanceUnknown;
		expect(rows.map((r: any) => [r.pid, r.secondsSinceFirstRow])).toEqual([
			["3205171", 186],
		]);
		expect(smell(report, "advisory-provenance-unknown")?.count).toBe(1);
	});

	it("D16 slow-extension-load: flags pi-lens loads at or above 2s", () => {
		// [2026-09-30T12:25:38.171Z] pi-lens loaded: 6123ms after process start (from dist)
		// Real: 5608, 6013, 6123 and 2260 ms flag; 310, 375, 1136 and 596 ms do
		// not. 6013 (10:07:18Z) and 2260 (21:55:09Z) have no session start
		// within 60 s. Labelled synthetic edges: a 2000 ms load with a start at
		// its own ms, and 3000 ms loads with a start at +60000 ms (kept) and
		// +60001 ms (short-lived).
		const report = run("slow-extension-load");
		expect(
			report.detectors.slowExtensionLoad.map((l: any) => [
				l.ts,
				l.durationMs,
				l.shortLived,
			]),
		).toEqual([
			["2026-09-30T06:27:41.836Z", 5608, false],
			["2026-09-30T10:07:18.603Z", 6013, true],
			["2026-09-30T12:25:38.171Z", 6123, false],
			["2026-09-30T21:55:09.752Z", 2260, true],
			["2026-09-30T22:00:00.000Z", 2000, false],
			["2026-09-30T23:00:00.000Z", 3000, false],
			["2026-09-30T23:30:00.000Z", 3000, true],
		]);
		expect(smell(report, "slow-extension-load")?.count).toBe(7);
	});
});

describe("analyze-pi-lens-logs.mjs E1-E5 enhancements (#3870)", () => {
	it("E1 lsp-availability-noise: counts the production failure emitters only", () => {
		// real: "[...] lsp spawn marksman: failed (15299ms) error=Timeout after 15000ms"
		// real: "lsp launch candidate failed tool=vscode-json-language-server ... ENOENT" (F1)
		// not:  "lsp launch: command=... cwd=.../.worktrees/468-wait-timeout ..." and
		//       the other real path-token lines, "lsp read warm unavailable: ...",
		//       "lsp process <cmd>: closed code=143 ...".
		// Labelled synthetic production shapes: spawn unavailable, launch
		// managed/bundle/tree-bin failed.
		const report = run("lsp-availability-noise");
		expect(smell(report, "lsp-availability-noise")?.count).toBe(7);
	});

	it("F4: E2 reports blocks without claiming an unobservable host/model split", () => {
		// edit_blocked + edit_preflight_blocked are blocks; edit_warned is informational.
		const report = run("read-guard-blocks");
		expect(report.readGuard.events.edit_blocked).toBe(3);
		expect(report.readGuard.events.edit_preflight_blocked).toBe(3);
		expect(report.readGuard.warns).toHaveLength(5);
		expect(report.readGuard.modelSideBlock).toBeUndefined();
		expect(report.readGuard.hostSideFalseBlock).toBeUndefined();
		expect(smell(report, "read-guard-blocks")?.count).toBe(6);
	});

	it("E3 read-guard-stale-ranges: bypassed-content-match is not a stale read", () => {
		// {"event":"range_snapshot_validation","metadata":{"status":"mismatch",...,"outcome":"bypassed-content-match"}}
		// one synthetic enforced-block mismatch is the only real stale range.
		const report = run("read-guard-stale-ranges");
		expect(report.readGuard.bypassedMismatch).toBe(3);
		expect(report.readGuard.staleRanges).toHaveLength(1);
		expect(smell(report, "read-guard-stale-ranges")?.count).toBe(1);
	});

	it("E4 session starts count from session_start fired with build attribution", () => {
		// [2026-09-30T20:51:33.141Z] session_start fired
		// [2026-09-30T20:51:33.142Z] session_start: build identity — commit=cf1b548e ...
		// A real config_resolution_pending line whose root= sits under the
		// default exclude glob **/.plegma/work/** is excluded; the real
		// Desktop/proj pending line and its resolution are kept.
		const report = run("session-starts-build-attribution");
		expect(report.session.starts).toBe(4);
		expect(report.session.commits).toEqual({
			"4b6a3f53": 2,
			"64163cc9": 1,
			cf1b548e: 1,
		});
		expect(report.rowsExcluded).toBe(1);
		expect(report.config.sessionsPendingResolution).toBe(1);
		expect(report.config.sessionsWithoutResolution).toBe(0);
	});

	it("E5 Projects touched: a bash command filePath is not a project", () => {
		// {"phase":"opaque_mutation_prescan","filePath":"cd /home/user/Desktop/proj && gh issue view 413 ..."}
		// Real: five opaque_mutation_prescan rows and one
		// opaque_mutation_coverage_unknown row, five comfy-studio rows, one
		// `<pi-lens>` cache_usage row, and one opaque_mutation_recovered row,
		// whose filePath is the recovered path (.../proj/.fix-round/ledger.md).
		// Labelled synthetic: a path with a space, and the two command-text
		// phases the logs predate (opaque_mutation_incoming_excluded,
		// opaque_mutation_status_pair_unknown).
		const report = run("projects-touched");
		expect(report.projects).toEqual([
			{ key: "home", count: 6 },
			{ key: "proj", count: 1 },
		]);
	});
});

describe("analyze-pi-lens-logs.mjs R1-R2 removals (#3870)", () => {
	it("R1 removes the dead session.rotations counter", () => {
		const report = run("advisory-provenance-unknown");
		expect(report.session.rotations).toBeUndefined();
	});

	it("R2 read-guard examples carry the real line, not the undefined offset fields", () => {
		const report = run("resume-state-loss");
		for (const row of report.readGuard.stateLost) {
			expect(typeof row.line).toBe("number");
			expect(row.requestedOffset).toBeUndefined();
			expect(row.symbolStartLine).toBeUndefined();
		}
	});

	it("stays read-only: running writes nothing under the fixture root", () => {
		const root = path.join(FIXTURES, "log-coverage-gap");
		const before = fs.readdirSync(root).sort();
		run("log-coverage-gap");
		const after = fs.readdirSync(root).sort();
		expect(after).toEqual(before);
	});
});
