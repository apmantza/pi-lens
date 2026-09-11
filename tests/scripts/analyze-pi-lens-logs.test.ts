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

function runReport(root: string, extraArgs: string[] = []): any {
	const out = execFileSync(
		process.execPath,
		[SCRIPT, "--root", root, "--json", "--since", "all", ...extraArgs],
		{ encoding: "utf8" },
	);
	return JSON.parse(out);
}

describe("analyze-pi-lens-logs.mjs", () => {
	let root: string;
	let report: any;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-loganalyze-"));

		// latency.log — three failed runners + one success. One failure carries an
		// explicit failureKind (infra), one only diagnostics (heuristic → found-errors).
		const latency = [
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
			rate: 0.5,
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
