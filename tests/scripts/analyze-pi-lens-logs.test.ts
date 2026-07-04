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

const SCRIPT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../scripts/analyze-pi-lens-logs.mjs",
);

const NOW = new Date().toISOString();

function runReport(root: string): any {
	const out = execFileSync(
		process.execPath,
		[SCRIPT, "--root", root, "--json", "--since", "all"],
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
				metadata: { failureKind: "server_error", failureMessage: "spawn ENOENT" },
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
				metadata: { completed: 18, total: 120, timedOutFiles: 2, aborted: false },
			},
			{
				type: "phase",
				ts: NOW,
				phase: "lsp_diagnostics_timeout",
				filePath: "/proj/b/x.ts",
				durationMs: 3000,
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
			{ ts: NOW, event: "lsp_file_skipped", metadata: { reason: "no_lsp_support" } },
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
			{ ts: NOW, tool: "ast_grep_search", outcome: "no_matches", durationMs: 20 },
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

		report = runReport(root);
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("discovers and parses the two new sources", () => {
		expect(report.filesScanned.actionableWarnings).toBe(1);
		expect(report.filesScanned.astGrepTools).toBe(1);
		expect(report.rowsSeen["actionable-warnings"]).toBe(4);
		expect(report.rowsSeen["ast-grep-tools"]).toBe(3);
		expect(report.parseErrors).toEqual({});
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

	it("counts only genuine breakages as the runner-failures smell", () => {
		const smell = report.smells.find((s: any) => s.id === "runner-failures");
		// server_error + timeout = 2; the two found-errors are excluded.
		expect(smell?.count).toBe(2);
		const kinds = smell.examples.map((e: any) => e.metadata?.failureKind).sort();
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
