/**
 * analyzeFile facade: runs the dispatch pipeline and maps the DispatchResult +
 * latency report into the JSON contract the MCP server returns.
 *
 * dispatchForFile + getLatencyReports are mocked (as in the dispatch-integration
 * suite) so the test asserts the *mapping* and the Tier-1 behaviours (warm LSP,
 * full/blocking-only, recording), not real runner execution. getLSPService is
 * mocked so warm-up never spawns a real language server.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchLatencyReport } from "../../../clients/dispatch/dispatcher.js";

vi.mock("../../../clients/dispatch/dispatcher.js", async (importOriginal) => {
	const mod =
		await importOriginal<
			typeof import("../../../clients/dispatch/dispatcher.js")
		>();
	return {
		...mod,
		dispatchForFile: vi.fn(),
		getLatencyReports: vi.fn(() => []),
	};
});

vi.mock("../../../clients/dispatch/fact-runner.js", async (importOriginal) => {
	const mod =
		await importOriginal<
			typeof import("../../../clients/dispatch/fact-runner.js")
		>();
	return { ...mod, runProviders: vi.fn() };
});

// Warm-up must never spawn a real LSP server in unit tests.
const mockTouchFile = vi.hoisted(() => vi.fn(async () => undefined));
const mockSupportsLSP = vi.hoisted(() => vi.fn((_file: string) => false));
vi.mock("../../../clients/lsp/index.js", () => ({
	getLSPService: () => ({
		supportsLSP: mockSupportsLSP,
		touchFile: mockTouchFile,
	}),
}));

import { dispatchForFile, getLatencyReports } from "../../../clients/dispatch/dispatcher.js";
import { CacheManager } from "../../../clients/cache-manager.js";
import { resetDispatchBaselines } from "../../../clients/dispatch/integration.js";
import { getDiagnosticTracker } from "../../../clients/diagnostic-tracker.js";
import {
	clearWidgetState,
	getFileDiagnosticSummaries,
} from "../../../clients/widget-state.js";
import { analyzeFile } from "../../../clients/mcp/analyze.js";

const warningDiagnostic = {
	id: "warn-1",
	message: "Unused import",
	filePath: "app.ts",
	line: 3,
	column: 1,
	severity: "warning" as const,
	semantic: "warning" as const,
	tool: "biome",
	rule: "noUnusedImports",
	fixable: true,
	fixSuggestion: "Remove the import",
};

const blockingDiagnostic = {
	id: "err-1",
	message: "Type error",
	filePath: "app.ts",
	line: 1,
	severity: "error" as const,
	semantic: "blocking" as const,
	tool: "tsc",
};

const emptyResult = {
	diagnostics: [],
	blockers: [],
	warnings: [],
	baselineWarningCount: 0,
	fixed: [],
	resolvedCount: 0,
	output: "",
	blockerOutput: "",
	hasBlockers: false,
};

let tmpDir: string;
let tsFile: string;

beforeEach(() => {
	resetDispatchBaselines();
	clearWidgetState();
	vi.mocked(dispatchForFile).mockReset();
	vi.mocked(getLatencyReports).mockReset();
	vi.mocked(getLatencyReports).mockReturnValue([]);
	mockTouchFile.mockClear();
	mockSupportsLSP.mockReset();
	mockSupportsLSP.mockReturnValue(false);
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-analyze-"));
	tsFile = path.join(tmpDir, "app.ts");
	fs.writeFileSync(tsFile, "export const a = 1;\n");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("analyzeFile", () => {
	it("maps DispatchResult diagnostics and counts into the MCP contract", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue({
			diagnostics: [blockingDiagnostic, warningDiagnostic],
			blockers: [blockingDiagnostic],
			warnings: [warningDiagnostic],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "1 error, 1 warning",
			blockerOutput: "1 error",
			hasBlockers: true,
		});

		const result = await analyzeFile(tsFile, tmpDir);

		expect(result.filePath).toBe(tsFile);
		expect(result.cwd).toBe(tmpDir);
		expect(result.hasBlockers).toBe(true);
		expect(result.counts).toEqual({
			diagnostics: 2,
			blockers: 1,
			warnings: 1,
			fixed: 0,
		});
		const warn = result.diagnostics.find((d) => d.rule === "noUnusedImports");
		expect(warn).toMatchObject({
			line: 3,
			severity: "warning",
			tool: "biome",
			fixable: true,
			fixSuggestion: "Remove the import",
		});
		expect(typeof result.durationMs).toBe("number");
	});

	it("attaches the latency report appended during this dispatch", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);

		const report: DispatchLatencyReport = {
			filePath: tsFile,
			fileKind: "jsts",
			overallStartMs: 0,
			overallEndMs: 1200,
			totalDurationMs: 1200,
			runners: [
				{
					runnerId: "lsp",
					startTime: 0,
					endTime: 1000,
					durationMs: 1000,
					status: "succeeded",
					diagnosticCount: 0,
					semantic: "blocking",
				},
			],
			stoppedEarly: false,
			totalDiagnostics: 0,
			blockers: 0,
			warnings: 0,
		};

		vi.mocked(getLatencyReports)
			.mockReturnValueOnce([])
			.mockReturnValueOnce([report]);

		const result = await analyzeFile(tsFile, tmpDir);

		expect(result.fileKind).toBe("jsts");
		// LSP outcome surfaced explicitly (honesty signal — #D).
		expect(result.lsp).toEqual({
			ran: true,
			status: "succeeded",
			diagnosticCount: 0,
			durationMs: 1000,
		});
		expect(result.latency).toEqual({
			totalDurationMs: 1200,
			stoppedEarly: false,
			runners: [
				{
					runnerId: "lsp",
					durationMs: 1000,
					status: "succeeded",
					diagnosticCount: 0,
				},
			],
		});
	});

	it("returns an empty result (no latency) for an unsupported file kind", async () => {
		const csv = path.join(tmpDir, "data.csv");
		fs.writeFileSync(csv, "a,b\n1,2\n");

		const result = await analyzeFile(csv, tmpDir);

		expect(result.counts.diagnostics).toBe(0);
		expect(result.latency).toBeUndefined();
		expect(dispatchForFile).not.toHaveBeenCalled();
	});

	it("resolves a relative file path against cwd", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);
		const result = await analyzeFile("app.ts", tmpDir);
		expect(result.filePath).toBe(tsFile);
	});

	// ── Tier 1 ───────────────────────────────────────────────────────────────

	it("runs the full analysis (blockingOnly=false) by default (#A)", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);
		await analyzeFile(tsFile, tmpDir);
		const ctx = vi.mocked(dispatchForFile).mock.calls[0][0];
		expect(ctx.blockingOnly).toBe(false);
	});

	it("honours blockingOnly=true when requested (#A)", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);
		await analyzeFile(tsFile, tmpDir, { blockingOnly: true });
		const ctx = vi.mocked(dispatchForFile).mock.calls[0][0];
		expect(ctx.blockingOnly).toBe(true);
	});

	it("warms the LSP (source=mcp-warmup) before dispatch when supported (#D)", async () => {
		mockSupportsLSP.mockReturnValue(true);
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);

		await analyzeFile(tsFile, tmpDir, { flags: { "no-lsp": false } });

		expect(mockTouchFile).toHaveBeenCalledWith(
			tsFile,
			expect.any(String),
			expect.objectContaining({
				source: "mcp-warmup",
				collectDiagnostics: true,
			}),
		);
	});

	it("skips LSP warm-up when no-lsp is set or warmLsp=false (#D)", async () => {
		mockSupportsLSP.mockReturnValue(true);
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);

		await analyzeFile(tsFile, tmpDir, { flags: { "no-lsp": true } });
		expect(mockTouchFile).not.toHaveBeenCalled();

		await analyzeFile(tsFile, tmpDir, {
			flags: { "no-lsp": false },
			warmLsp: false,
		});
		expect(mockTouchFile).not.toHaveBeenCalled();
	});

	it("records diagnostics into widget state and the tracker (#C)", async () => {
		// Unique id/line — the diagnostic tracker is a global singleton that
		// dedupes by identity, so a diagnostic reused from another test would not
		// re-increment totalShown.
		const uniqueDiagnostic = {
			id: "c-test-unique",
			message: "Unique blocker",
			filePath: "app.ts",
			line: 99,
			column: 1,
			severity: "error" as const,
			semantic: "blocking" as const,
			tool: "tsc",
		};
		const shownBefore = getDiagnosticTracker().getStats().totalShown;
		vi.mocked(dispatchForFile).mockResolvedValue({
			...emptyResult,
			diagnostics: [uniqueDiagnostic],
			blockers: [uniqueDiagnostic],
			hasBlockers: true,
		});

		await analyzeFile(tsFile, tmpDir);

		const summaries = getFileDiagnosticSummaries();
		expect(summaries.some((s) => s.diagnostics.length > 0)).toBe(true);
		expect(getDiagnosticTracker().getStats().totalShown).toBeGreaterThan(
			shownBefore,
		);
	});

	it("does not record when record=false (#C)", async () => {
		clearWidgetState();
		vi.mocked(dispatchForFile).mockResolvedValue({
			...emptyResult,
			diagnostics: [blockingDiagnostic],
		});

		await analyzeFile(tsFile, tmpDir, { record: false });

		expect(getFileDiagnosticSummaries().length).toBe(0);
	});

	it("registers the file into turn-state when registerTurnState is set (#A)", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);
		await analyzeFile(tsFile, tmpDir, { registerTurnState: true });
		const turnState = new CacheManager().readTurnState(tmpDir);
		expect(Object.keys(turnState.files).length).toBe(1);
	});

	it("leaves turn-state untouched by default (#A)", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);
		await analyzeFile(tsFile, tmpDir);
		const turnState = new CacheManager().readTurnState(tmpDir);
		expect(Object.keys(turnState.files).length).toBe(0);
	});
});
