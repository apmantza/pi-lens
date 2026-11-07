/**
 * Tests for scripts/analyze-pi-lens-logs.mjs — the log-smell analyzer.
 *
 * Runs the script as a subprocess (its real entry point, exercising the
 * --root/--json/--since flags) against a crafted fixture log directory and
 * asserts the machine-readable report. Covers the two sources added alongside
 * the failureKind work — actionable-warnings + ast-grep-tools — and the
 * runner-failure reclassification that separates a genuine runner breakage
 * ("server_error"/"timeout") from "the check ran and found blocking issues"
 * ("blocking_diagnostics"), so found-errors no longer read as crashes.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDirSync } from "../clients/test-utils.js";

const SCRIPT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../scripts/analyze-pi-lens-logs.mjs",
);

const NOW = new Date().toISOString();

function runAnalyzer(
	root: string,
	extraArgs: string[] = [],
	script = SCRIPT,
): string {
	return execFileSync(
		process.execPath,
		[script, "--root", root, "--since", "all", ...extraArgs],
		{ encoding: "utf8", timeout: 60_000 },
	);
}

function runReport(root: string, extraArgs: string[] = []): any {
	return JSON.parse(runAnalyzer(root, ["--json", ...extraArgs]));
}

describe("analyze-pi-lens-logs.mjs", () => {
	let root: string;
	let report: any;

	it("prints help exactly once through canonical and symlinked scripts paths", () => {
		// #4096: the unconditional main and the lexical tail both printed help
		// only on the canonical path; the symlink reached main once already.
		const linkedScripts = path.join(root, "scripts");
		fs.symlinkSync(path.dirname(SCRIPT), linkedScripts, "junction");
		for (const script of [
			SCRIPT,
			path.join(linkedScripts, path.basename(SCRIPT)),
		]) {
			const out = runAnalyzer(root, ["--help"], script);
			expect(
				out.match(/Usage: node scripts\/analyze-pi-lens-logs\.mjs/g),
				script,
			).toHaveLength(1);
		}
	});

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-loganalyze-"));

		// latency.log — three failed runners + one success. One failure carries an
		// explicit failureKind (infra), one only diagnostics (heuristic → found-errors).
		const latency = [
			// #2639: skills outcomes must survive the offline report boundary.
			// `absent` is the label clients/bundled-resource-health.ts writes when the
			// bundled skills/ dir is missing (ENOENT). `""` and `{}` are malformed
			// statuses that must not render as a blank label or [object Object].
			...["healthy", "healthy", "absent", "empty", "unreadable"].map(
				(status) => ({
					type: "phase",
					phase: "skills_resolved",
					ts: NOW,
					durationMs: 0,
					metadata: { status, entryCount: status === "healthy" ? 3 : 0 },
				}),
			),
			{ type: "phase", phase: "skills_resolved", ts: NOW },
			{
				type: "phase",
				phase: "skills_resolved",
				ts: NOW,
				metadata: { entryCount: 0 },
			},
			{
				type: "phase",
				phase: "skills_resolved",
				ts: NOW,
				metadata: { status: "" },
			},
			{
				type: "phase",
				phase: "skills_resolved",
				ts: NOW,
				metadata: { status: {} },
			},
			{
				type: "phase",
				phase: "unrelated",
				ts: NOW,
				metadata: { status: "healthy" },
			},
			// Synthetic benchmark corpus — excluded by the default denylist.
			{
				type: "phase",
				ts: NOW,
				phase: "lsp_diagnostics_timeout",
				filePath: "/tmp/pi-lens/heap-corpus/generated.ts",
				durationMs: 9000,
			},
			// found-errors via explicit tag
			{
				type: "runner",
				ts: NOW,
				runnerId: "lsp",
				status: "failed",
				durationMs: 120,
				diagnosticCount: 2,
				metadata: { failureKind: "blocking_diagnostics" },
			},
			// genuine infra failure (explicit)
			{
				type: "runner",
				ts: NOW,
				runnerId: "lsp",
				status: "failed",
				durationMs: 9000,
				diagnosticCount: 1,
				metadata: {
					failureKind: "server_error",
					failureMessage: "spawn ENOENT",
				},
			},
			// genuine infra failure (explicit)
			{
				type: "runner",
				ts: NOW,
				runnerId: "oxlint",
				status: "failed",
				durationMs: 31000,
				diagnosticCount: 0,
				metadata: { failureKind: "timeout" },
			},
			// found-errors via heuristic (legacy log: no metadata, but has diagnostics)
			{
				type: "runner",
				ts: NOW,
				runnerId: "biome-check-json",
				status: "failed",
				durationMs: 50,
				diagnosticCount: 7,
			},
			{
				type: "runner",
				ts: NOW,
				runnerId: "lsp",
				status: "succeeded",
				durationMs: 80,
				diagnosticCount: 0,
			},
			// Full LSP workspace sweeps (lens_diagnostics full): /proj/a completed
			// but hit the per-file budget on 4 files; /proj/b logged a start (and a
			// heartbeat) but never a completion — the hang/kill signature #383 added
			// this logging to catch.
			{
				type: "phase",
				ts: NOW,
				phase: "lsp_workspace_diagnostics_start",
				filePath: "/proj/a",
				durationMs: 0,
				metadata: { fileCount: 40, perFileMs: 15000 },
			},
			{
				type: "phase",
				ts: NOW,
				phase: "lsp_workspace_diagnostics",
				filePath: "/proj/a",
				durationMs: 52000,
				metadata: { filesChecked: 40, diagnosticCount: 3, timedOutFiles: 4 },
			},
			{
				type: "phase",
				ts: NOW,
				phase: "lsp_workspace_diagnostics_start",
				filePath: "/proj/b",
				durationMs: 0,
				metadata: { fileCount: 120, perFileMs: 15000 },
			},
			{
				type: "phase",
				ts: NOW,
				phase: "lsp_workspace_diagnostics_progress",
				filePath: "/proj/b",
				durationMs: 10000,
				metadata: {
					completed: 18,
					total: 120,
					timedOutFiles: 2,
					aborted: false,
				},
			},
			{
				type: "phase",
				ts: NOW,
				phase: "lsp_diagnostics_timeout",
				filePath: "/proj/b/x.ts",
				durationMs: 3000,
			},
			{
				type: "phase",
				ts: NOW,
				phase: "test_runner_verdict_delivery",
				filePath: "/proj/a",
				durationMs: 0,
				metadata: { sessionId: "session-a", stale: true },
			},
			{
				type: "phase",
				ts: NOW,
				phase: "test_runner_verdict_delivery",
				filePath: "/proj/a",
				durationMs: 0,
				metadata: { sessionId: "session-a", stale: false },
			},
			{
				type: "phase",
				ts: NOW,
				phase: "test_runner_verdict_delivery",
				filePath: "/proj/unknown",
				durationMs: 0,
				metadata: {
					sessionId: "all-unknown",
					verdictCount: 0,
					staleCount: 0,
					unknownCount: 40,
				},
			},
			{
				type: "phase",
				ts: NOW,
				phase: "test_runner_verdict_delivery",
				filePath: "/proj/fresh",
				durationMs: 0,
				metadata: {
					sessionId: "all-fresh",
					verdictCount: 40,
					staleCount: 0,
					unknownCount: 0,
				},
			},
		]
			.map((e) => JSON.stringify(e))
			.join("\n");
		fs.writeFileSync(path.join(root, "latency.log"), `${latency}\n`);

		// actionable-warnings.log
		const actionable = [
			{
				ts: NOW,
				event: "report_complete",
				metadata: { summary: { suppressed: 3, autoFixEligible: 1 } },
			},
			{ ts: NOW, event: "advisory_injected", metadata: { unsuppressed: 5 } },
			{ ts: NOW, event: "lsp_file_checked", metadata: { lspSource: "fresh" } },
			{
				ts: NOW,
				event: "lsp_file_skipped",
				metadata: { reason: "no_lsp_support" },
			},
		]
			.map((e) => JSON.stringify(e))
			.join("\n");
		fs.writeFileSync(
			path.join(root, "actionable-warnings.log"),
			`${actionable}\n`,
		);

		// ast-grep-tools.log
		const astGrep = [
			{
				ts: NOW,
				tool: "ast_grep_search",
				outcome: "success",
				matchCount: 3,
				truncated: false,
				durationMs: 40,
			},
			{
				ts: NOW,
				tool: "ast_grep_search",
				outcome: "no_matches",
				durationMs: 20,
			},
			{
				ts: NOW,
				tool: "ast_grep_replace",
				outcome: "error",
				errorKind: "multiple_ast_nodes",
				errorRaw: "pattern matched multiple nodes",
				pattern: "$X",
				durationMs: 30,
			},
		]
			.map((e) => JSON.stringify(e))
			.join("\n");
		fs.writeFileSync(path.join(root, "ast-grep-tools.log"), `${astGrep}\n`);

		// sessionstart.log — background-task timings in the current "runMs=" format
		// (one over the 3000ms threshold, one under) so the slow-background-tasks
		// smell is exercised against the real shape, not the stale "(<n>ms)" one.
		const sessionstart = [
			"session_start cwd: /proj/a",
			"session_start task call-graph: success runMs=28469 queuedMs=245",
			"session_start task codebase-model: success runMs=8 queuedMs=235",
		]
			.map((m) => `[${NOW}] ${m}`)
			.join("\n");
		fs.writeFileSync(path.join(root, "sessionstart.log"), `${sessionstart}\n`);

		// projects/<slug>/worklog.jsonl (#1448) — two projects, mixing attributed
		// and unattributed (pre-#1448 / unknown-identity) entries so the rollup
		// exercises rule × model grouping AND blank-model bucketing together.
		const worklogA = [
			{
				timestamp: NOW,
				filePath: "/proj/a/x.ts",
				rule: "no-unused-vars",
				tool: "eslint",
				message: "x is unused",
				line: 1,
				fixable: true,
				autoFixed: true,
				model: "claude-sonnet-4-5",
				provider: "anthropic",
			},
			{
				timestamp: NOW,
				filePath: "/proj/a/y.ts",
				rule: "no-unused-vars",
				tool: "eslint",
				message: "y is unused",
				line: 2,
				fixable: true,
				autoFixed: false,
				model: "claude-sonnet-4-5",
				provider: "anthropic",
			},
			// Pre-#1448 shape: no model/provider fields at all.
			{
				timestamp: NOW,
				filePath: "/proj/a/z.ts",
				rule: "no-unused-vars",
				tool: "eslint",
				message: "z is unused",
				line: 3,
				fixable: true,
				autoFixed: true,
			},
		]
			.map((e) => JSON.stringify(e))
			.join("\n");
		const projA = path.join(root, "projects", "proj-a");
		fs.mkdirSync(projA, { recursive: true });
		fs.writeFileSync(path.join(projA, "worklog.jsonl"), `${worklogA}\n`);

		const worklogB = [
			{
				timestamp: NOW,
				filePath: "/proj/b/w.ts",
				rule: "no-explicit-any",
				tool: "eslint",
				message: "unexpected any",
				line: 4,
				fixable: false,
				autoFixed: false,
				model: "gpt-5",
				provider: "openai",
			},
		]
			.map((e) => JSON.stringify(e))
			.join("\n");
		const projB = path.join(root, "projects", "proj-b");
		fs.mkdirSync(projB, { recursive: true });
		fs.writeFileSync(path.join(projB, "worklog.jsonl"), `${worklogB}\n`);

		report = runReport(root);
	});

	afterAll(() => {
		removeTempDirSync(root);
	});

	it("discovers and parses the two new sources", () => {
		expect(report.filesScanned.actionableWarnings).toBe(1);
		expect(report.filesScanned.astGrepTools).toBe(1);
		expect(report.rowsSeen["actionable-warnings"]).toBe(4);
		expect(report.rowsSeen["ast-grep-tools"]).toBe(3);
		expect(report.parseErrors).toEqual({});
		expect(report.rowsExcluded).toBe(1);
	});

	it("tallies skills outcomes without counting unrelated phases (#2639)", () => {
		expect(report.latency.skillsResolved).toEqual({
			healthy: 2,
			absent: 1,
			empty: 1,
			unreadable: 1,
			unknown: 4,
		});
	});

	it("renders skills outcome counts in text (#2639)", () => {
		const text = runAnalyzer(root);
		const section = text.split("\nSkills resolution\n")[1]?.split("\n\n")[0];
		expect(section).toBeDefined();
		for (const [status, count] of [
			["healthy", 2],
			["absent", 1],
			["empty", 1],
			["unreadable", 1],
			["unknown", 4],
		] as const) {
			expect(section).toMatch(new RegExp(`^\\s+${count}  ${status}$`, "m"));
		}
	});

	it("supports explicit repeatable exclusion globs", () => {
		const excluded = runReport(root, ["--exclude", "**/proj/**"]);
		expect(excluded.rowsExcluded).toBeGreaterThan(report.rowsExcluded);
		expect(excluded.rowsSeen.latency).toBeLessThan(report.rowsSeen.latency);
	});

	it("separates infra runner failures from found-errors", () => {
		const kinds = Object.fromEntries(
			report.latency.runnerFailureKinds.map((r: any) => [r.key, r.count]),
		);
		expect(kinds["lsp:blocking_diagnostics"]).toBe(1);
		expect(kinds["lsp:server_error"]).toBe(1);
		expect(kinds["oxlint:timeout"]).toBe(1);
		// legacy entry with diagnostics but no metadata → found-errors via heuristic
		expect(kinds["biome-check-json:blocking_diagnostics"]).toBe(1);
		expect(report.latency.runnerBlockingFindings).toEqual({
			lsp: 1,
			"biome-check-json": 1,
		});
	});

	it("reports stale test-runner verdict rate per session", () => {
		expect(report.latency.testRunnerVerdicts["session-a"]).toEqual({
			total: 2,
			stale: 1,
			unknown: 0,
			denominator: 2,
			rate: 0.5,
		});
	});

	it("distinguishes all-unknown verdicts from all-fresh verdicts", () => {
		// Regression for the analyzer dropping producer-emitted unknownCount and
		// making an unestablished population look like an all-fresh population.
		expect(report.latency.testRunnerVerdicts["all-unknown"]).toEqual({
			total: 0,
			stale: 0,
			unknown: 40,
			denominator: 0,
			rate: 0,
		});
		expect(report.latency.testRunnerVerdicts["all-fresh"]).toEqual({
			total: 40,
			stale: 0,
			unknown: 0,
			denominator: 40,
			rate: 0,
		});
	});

	it("counts only genuine breakages as the runner-failures smell", () => {
		const smell = report.smells.find((s: any) => s.id === "runner-failures");
		// server_error + timeout = 2; the two found-errors are excluded.
		expect(smell?.count).toBe(2);
		const kinds = smell.examples
			.map((e: any) => e.metadata?.failureKind)
			.sort();
		expect(kinds).toEqual(["server_error", "timeout"]);
	});

	it("aggregates the actionable-warnings advisory pipeline", () => {
		expect(report.actionable.advisoriesInjected).toBe(1);
		expect(report.actionable.advisoryWarningsInjected).toBe(5);
		expect(report.actionable.warningsSuppressed).toBe(3);
		expect(report.actionable.autoFixEligible).toBe(1);
		expect(report.actionable.lspSource).toEqual({ fresh: 1 });
		expect(report.actionable.fileSkipReasons).toEqual({ no_lsp_support: 1 });
	});

	it("flags slow background tasks in the current runMs= log format", () => {
		const smell = report.smells.find(
			(s: any) => s.id === "slow-background-tasks",
		);
		// call-graph ran 28469ms (>= 3000 threshold); codebase-model 8ms excluded.
		expect(smell?.count).toBe(1);
		expect(smell.examples[0].task).toBe("call-graph");
		expect(smell.examples[0].durationMs).toBe(28469);
	});

	it("surfaces incomplete + timed-out full LSP workspace sweeps", () => {
		const wd = report.latency.workspaceDiagnostics;
		expect(wd.started).toBe(2);
		expect(wd.completed).toBe(1);
		expect(wd.incomplete).toBe(1);
		expect(wd.timedOutSweeps).toBe(1);
		expect(wd.timedOutFilesTotal).toBe(4);
		expect(report.latency.phaseTimeouts.lsp_diagnostics_timeout).toBe(1);

		// #1618: the /proj/a sweep's `lsp_workspace_diagnostics` line above has
		// NO `unconfirmedByReason` field — vintage-attribution fallback buckets
		// its 4 files under a distinctly-labeled "pre-#1618 build" reason
		// instead of asserting they really were budget timeouts.
		expect(wd.unconfirmedByReason).toEqual({ "budget (pre-#1618 build)": 4 });

		const incomplete = report.smells.find(
			(s: any) => s.id === "lsp-workspace-diagnostics-incomplete",
		);
		expect(incomplete?.count).toBe(1);
		// the retained heartbeat shows how far the hung sweep got before silence
		expect(incomplete.examples[0].message).toContain("completed 18/120");

		const timeouts = report.smells.find(
			(s: any) => s.id === "lsp-workspace-file-timeouts",
		);
		expect(timeouts?.count).toBe(1);
	});

	describe("worklog per-model rollup (#1448)", () => {
		it("discovers worklog.jsonl under each project's data dir", () => {
			expect(report.filesScanned.worklog).toBe(2);
			expect(report.rowsSeen.worklog).toBe(4);
		});

		it("groups rule x model counts, bucketing unattributed entries as blank", () => {
			const rows: {
				rule: string;
				model: string;
				total: number;
				autoFixed: number;
			}[] = report.worklog.byRuleModel;
			const attributed = rows.find(
				(r) => r.rule === "no-unused-vars" && r.model === "claude-sonnet-4-5",
			);
			expect(attributed).toBeDefined();
			expect(attributed?.total).toBe(2);
			expect(attributed?.autoFixed).toBe(1);

			const blank = rows.find(
				(r) => r.rule === "no-unused-vars" && r.model === "",
			);
			expect(blank).toBeDefined();
			expect(blank?.total).toBe(1);
			expect(blank?.autoFixed).toBe(1);

			const other = rows.find(
				(r) => r.rule === "no-explicit-any" && r.model === "gpt-5",
			);
			expect(other?.total).toBe(1);
			expect(other?.autoFixed).toBe(0);
		});

		it("rolls up totals by model and by provider, with an (unknown) bucket", () => {
			const byModel = Object.fromEntries(
				report.worklog.byModel.map((x: { key: string; count: number }) => [
					x.key,
					x.count,
				]),
			);
			expect(byModel["claude-sonnet-4-5"]).toBe(2);
			expect(byModel["gpt-5"]).toBe(1);
			expect(byModel["(unknown)"]).toBe(1);

			const byProvider = Object.fromEntries(
				report.worklog.byProvider.map((x: { key: string; count: number }) => [
					x.key,
					x.count,
				]),
			);
			expect(byProvider.anthropic).toBe(2);
			expect(byProvider.openai).toBe(1);
			expect(byProvider["(unknown)"]).toBe(1);
		});
	});

	it("surfaces ast-grep tool errors as a smell", () => {
		expect(report.astGrep.outcomes["ast_grep_replace:error"]).toBe(1);
		expect(report.astGrep.errorKinds).toEqual({ multiple_ast_nodes: 1 });
		const smell = report.smells.find(
			(s: any) => s.id === "ast-grep-tool-errors",
		);
		expect(smell?.count).toBe(1);
		expect(smell.examples[0].errorKind).toBe("multiple_ast_nodes");
	});
});

// #1618 review round 5: the forensics tool that FOUND #1618 read the flat
// `timedOutFiles` count and reported every unconfirmed file as "hit the
// per-file budget" — 81 of the 111 it counted were actually
// service-destroyed. This isolated fixture (a post-#1618-build log line
// carrying the new `unconfirmedByReason` field) proves the analyzer now
// attributes by the real reason instead of collapsing everyone into budget.
describe("analyze-pi-lens-logs.mjs — unconfirmedByReason attribution (#1618 R5)", () => {
	let root: string;
	let report: any;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-loganalyze-1618-"));
		const latency = [
			{
				type: "phase",
				ts: NOW,
				phase: "lsp_workspace_diagnostics",
				filePath: "/proj/c",
				durationMs: 2000,
				metadata: {
					filesChecked: 225,
					diagnosticCount: 5,
					timedOutFiles: 111,
					unconfirmedByReason: {
						service_destroyed: 81,
						coverage_gap: 28,
						budget: 0,
						inconclusive: 0,
						error: 2,
					},
				},
			},
		]
			.map((e) => JSON.stringify(e))
			.join("\n");
		fs.writeFileSync(path.join(root, "latency.log"), `${latency}\n`);
		report = runReport(root);
	});

	afterAll(() => removeTempDirSync(root));

	it("attributes the real per-reason breakdown instead of the flat budget count", () => {
		const wd = report.latency.workspaceDiagnostics;
		expect(wd.timedOutFilesTotal).toBe(111);
		// The whole point: this is NOT "budget (pre-#1618 build)": 111 — the
		// per-reason field is present, so it's read directly, and a zero-count
		// reason contributes nothing (never a manufactured "budget: 0" that
		// could read as though budget exhaustion happened at all).
		expect(wd.unconfirmedByReason).toEqual({
			service_destroyed: 81,
			coverage_gap: 28,
			error: 2,
		});
		expect(wd.unconfirmedByReason["budget (pre-#1618 build)"]).toBeUndefined();

		const smell = report.smells.find(
			(s: any) => s.id === "lsp-workspace-file-timeouts",
		);
		expect(smell?.description).toContain("service_destroyed=81");
		expect(smell?.description).not.toContain("hit the per-file budget");
	});
});

/**
 * Per-phase and per-runner latency percentiles (#5263).
 *
 * The fixture is a static NDJSON file with fixed timestamps so the `--since`
 * edge is deterministic against a literal window instead of the wall clock.
 * The window used below (`2026-09-30T00:00:00Z`) keeps every
 * `2026-09-30T10:00:*` row and drops the three `pre_window_phase` rows dated
 * `2026-09-29`, which is what pins the distribution to the window instead of
 * to the whole file.
 *
 * Percentiles are the clamped lower-rank index the hot-path gate already uses
 * (`percentile` in `scripts/lib/latency-stats.mjs`): p(q) is the ascending
 * sample at index `clamp(floor(q * n), 0, n-1)`. The 10-row `pre_window_phase`
 * group pins that rule at the index where it differs from nearest-rank
 * (floor(0.5*10)=5 -> 60, where nearest-rank would answer 50).
 */
describe("analyze-pi-lens-logs.mjs per-phase latency distribution (#5263)", () => {
	const FIXTURES = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../fixtures/analyze-logs",
	);
	const WINDOW = "2026-09-30T00:00:00Z";

	function dist(fixture = "phase-distribution", since = WINDOW): any {
		// The file's existing subprocess seam: `--since` is repeated and the later
		// value wins in `parseArgs`, so the window is explicit without a second
		// spawn site (the #4362 flake-shape ratchet counts those per file).
		return runReport(path.join(FIXTURES, fixture), ["--since", since]).latency;
	}

	function group(rows: any[], key: string): any {
		return rows.find((row: any) => row.key === key);
	}

	it("reports count, p50, p95 and max per (tool, phase) over the window", () => {
		const latency = dist();
		const rows = latency.phaseLatency.rows;
		const row = group(rows, "turn_end:inline_blocker_policy");
		// Fixture durations 10,20,30,40,50,60,70,80,1000 (ascending): the shared
		// percentile answers p50 at index floor(0.5*9)=4 -> 50 and p95 at
		// index floor(0.95*9)=8 -> 1000.
		expect(row).toMatchObject({
			tool: "turn_end",
			phase: "inline_blocker_policy",
			count: 9,
			p50Ms: 50,
			p95Ms: 1000,
			maxMs: 1000,
			totalMs: 1360,
		});
		// The 1000ms outlier moves p95 and max but not p50 — the distribution
		// is a distribution, not an average, which is the whole point of #5263.
		expect(row.p50Ms).toBeLessThan(row.p95Ms);
	});

	it("reports a single-row phase with p50 equal to p95 and max", () => {
		const row = group(dist().phaseLatency.rows, "edit:dispatch_lint");
		expect(row).toMatchObject({
			count: 1,
			p50Ms: 700,
			p95Ms: 700,
			maxMs: 700,
			totalMs: 700,
		});
	});

	it("leaves a phase whose rows all precede --since out of the distribution", () => {
		const latency = dist();
		expect(
			group(latency.phaseLatency.rows, "turn_end:pre_window_phase"),
		).toBeUndefined();
		// Its 550ms must not dilute the shares of the phases that ARE in window:
		// 1360 + 700, not 1360 + 700 + 550.
		expect(latency.phaseLatency.totalMs).toBe(2060);
	});

	it("counts the pre-window phase when --since all widens the window", () => {
		const latency = dist("phase-distribution", "all");
		// The 10-row group is the percentile-rule pin: durations 10..100 answer
		// p50 = 60 (index floor(0.5*10) = 5, the 6th row), where nearest-rank would
		// answer 50; p95 = index floor(9.5) = 9 -> 100.
		expect(
			group(latency.phaseLatency.rows, "turn_end:pre_window_phase"),
		).toMatchObject({
			count: 10,
			p50Ms: 60,
			p95Ms: 100,
			maxMs: 100,
			totalMs: 550,
		});
		expect(latency.phaseLatency.totalMs).toBe(2610);
	});

	it("empties the distribution when the window holds no latency rows", () => {
		const latency = dist("phase-distribution", "2026-10-01T00:00:00Z");
		expect(latency.phaseLatency).toEqual({ totalMs: 0, rows: [] });
		expect(latency.runnerLatency).toEqual({ totalMs: 0, rows: [] });
	});

	it("excludes rows without a finite durationMs from the distribution", () => {
		const latency = dist();
		expect(
			group(latency.phaseLatency.rows, "turn_end:missing_duration_phase"),
		).toBeUndefined();
		expect(
			group(latency.phaseLatency.rows, "turn_end:null_duration_phase"),
		).toBeUndefined();
		// The rows are still real phase rows: the existing counter tally keeps them.
		const counts = Object.fromEntries(
			latency.phaseCounts.map((entry: any) => [entry.key, entry.count]),
		);
		expect(counts["missing_duration_phase"]).toBe(1);
		expect(counts["null_duration_phase"]).toBe(1);
	});

	it("reports the runner distribution without the rows that never ran", () => {
		const runner = group(dist().runnerLatency.rows, "oxlint");
		// 100,200,300 ran; the 9999ms `skipped` and `not_registered` rows record a
		// decision, not work, so they would flatten p50 to the skip time.
		expect(runner).toMatchObject({
			runner: "oxlint",
			count: 3,
			p50Ms: 200,
			p95Ms: 300,
			maxMs: 300,
			totalMs: 600,
			skippedRows: 2,
		});
	});

	it("reports each top phase's share of total in-window phase time", () => {
		const { rows, totalMs } = dist().phaseLatency;
		expect(totalMs).toBe(2060);
		expect(group(rows, "turn_end:inline_blocker_policy").share).toBeCloseTo(
			1360 / 2060,
			10,
		);
		expect(group(rows, "edit:dispatch_lint").share).toBeCloseTo(700 / 2060, 10);
		// Ranked by total time, and the rendered shares are fractions of the
		// PHASE family only — runner time is a separate denominator.
		expect(rows.map((row: any) => row.key)).toEqual([
			"turn_end:inline_blocker_policy",
			"edit:dispatch_lint",
		]);
		const runner = group(dist().runnerLatency.rows, "oxlint");
		expect(runner.share).toBe(1);
		expect(dist().runnerLatency.totalMs).toBe(600);
	});

	it("renders count, percentiles and share for each phase in text output", () => {
		const text = runAnalyzer(path.join(FIXTURES, "phase-distribution"), [
			"--since",
			WINDOW,
		]);
		const section = text.split("\nPhase latency\n")[1]?.split("\n\n")[0];
		expect(section).toBeDefined();
		expect(section).toMatch(
			/^\s+9\s+p50=50\s+p95=1000\s+max=1000\s+66\.0%\s+turn_end:inline_blocker_policy$/m,
		);
		expect(section).toMatch(
			/1\s+p50=700\s+p95=700\s+max=700\s+34\.0%\s+edit:dispatch_lint/,
		);
		expect(section).not.toMatch(/pre_window_phase/);
		const runnerSection = text.split("\nRunner latency\n")[1]?.split("\n\n")[0];
		expect(runnerSection).toMatch(
			/3\s+p50=200\s+p95=300\s+max=300\s+100\.0%\s+oxlint\s+\(skipped 2\)/,
		);
	});
});
