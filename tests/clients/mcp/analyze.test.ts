/**
 * analyzeFile facade: runs the dispatch pipeline and maps the DispatchResult +
 * latency report into the JSON contract the MCP server returns.
 *
 * dispatchForFile is mocked (as in the dispatch-integration suite) so the test
 * asserts the *mapping* and the Tier-1 behaviours (warm LSP,
 * full/blocking-only, recording), not real runner execution. getLSPService is
 * mocked so warm-up never spawns a real language server.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchLatencyReport } from "../../../clients/dispatch/dispatcher.js";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";
import { removeTempDirSync } from "../test-utils.js";

vi.mock("../../../clients/dispatch/dispatcher.js", async (importOriginal) => {
	const mod =
		await importOriginal<
			typeof import("../../../clients/dispatch/dispatcher.js")
		>();
	return {
		...mod,
		dispatchForFile: vi.fn(),
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
	getLSPService: () =>
		makeLspServiceDouble({
			supportsLSP: mockSupportsLSP,
			touchFile: mockTouchFile,
		}),
}));

// #536: buildOrUpdateGraph is mocked so this suite asserts the GATING logic
// (updateGraph flag, blockers, file-kind eligibility) without exercising the
// real graph builder — that's covered by tests/mcp/analyze-graph.smoke.test.ts
// (real end-to-end graph build) and the review-graph suite's own unit tests.
const mockBuildOrUpdateGraph = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../clients/review-graph/service.js", () => ({
	buildOrUpdateGraph: mockBuildOrUpdateGraph,
}));

import { dispatchForFile } from "../../../clients/dispatch/dispatcher.js";
import { CacheManager } from "../../../clients/cache-manager.js";
import { resetDispatchBaselines } from "../../../clients/dispatch/integration.js";
import { getDiagnosticTracker } from "../../../clients/diagnostic-tracker.js";
import {
	clearWidgetState,
	getFileDiagnosticSummaries,
	reconcileStaleWidgetFiles,
	recordRunner,
} from "../../../clients/widget-state.js";
import { analyzeFile } from "../../../clients/mcp/analyze.js";
import { createLensDiagnosticMarkTool } from "../../../tools/lens-diagnostic-mark.js";
import { createCaseAliasFixture } from "../test-utils.js";

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
let previousDataDir: string | undefined;

beforeEach(() => {
	previousDataDir = process.env.PILENS_DATA_DIR;
	resetDispatchBaselines();
	clearWidgetState();
	vi.mocked(dispatchForFile).mockReset();
	mockTouchFile.mockClear();
	mockSupportsLSP.mockReset();
	mockSupportsLSP.mockReturnValue(false);
	mockBuildOrUpdateGraph.mockClear();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-analyze-"));
	process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
	tsFile = path.join(tmpDir, "app.ts");
	fs.writeFileSync(tsFile, "export const a = 1;\n");
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	removeTempDirSync(tmpDir);
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
			// #2420: counts now carry the advisories split. `noUnusedImports`
			// (severity/semantic "warning") classifies as a real warning, not an
			// advisory, so the warning count is unchanged and advisories is 0.
			advisories: 0,
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

	it("counts a deferred LSP runner as ran while preserving its status", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue({
			...emptyResult,
			latencyReport: {
				filePath: tsFile,
				fileKind: "jsts",
				runners: [
					{
						runnerId: "lsp",
						status: "deferred",
						diagnosticCount: 0,
						durationMs: 10,
					},
				],
			},
		} as never);

		const result = await analyzeFile(tsFile, tmpDir);

		expect(result.lsp).toMatchObject({ ran: true, status: "deferred" });
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

		vi.mocked(dispatchForFile).mockResolvedValue({
			...emptyResult,
			latencyReport: report,
		});

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

	it("attaches the latency report even when the ring is already at its 100-entry cap (#3642)", async () => {
		// dispatcher.ts:1444-1449 pushes then shifts once length > 100, so a
		// full ring's length is UNCHANGED by this dispatch's push (100 -> 100).
		// analyzeFile must still find the report it just caused, not rely on a
		// length delta.
		const newestReport: DispatchLatencyReport = {
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
		// The returned object is the dispatch identity even when the ring evicts
		// an older entry and keeps its length at 100.
		vi.mocked(dispatchForFile).mockResolvedValue({
			...emptyResult,
			latencyReport: newestReport,
		});

		const result = await analyzeFile(tsFile, tmpDir);

		expect(result.latency).toBeDefined();
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

	it("does not attach a foreign report when dispatch appends nothing", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);

		const result = await analyzeFile(tsFile, tmpDir);

		expect(result.latency).toBeUndefined();
		expect(result.fileKind).toBeUndefined();
	});

	it("keeps below-cap attribution from the dispatch identity", async () => {
		const report = {
			filePath: "app\\ts",
			fileKind: "jsts",
			runners: [],
			totalDurationMs: 12,
			stoppedEarly: false,
		};
		vi.mocked(dispatchForFile).mockResolvedValue({
			...emptyResult,
			latencyReport: report,
		} as never);

		const result = await analyzeFile(tsFile, tmpDir);

		expect(result.latency?.totalDurationMs).toBe(12);
	});

	it("uses the carried dispatch report instead of a ring neighbour", async () => {
		const carried = {
			filePath: tsFile,
			fileKind: "jsts",
			runners: [],
			totalDurationMs: 22,
			stoppedEarly: false,
		};
		vi.mocked(dispatchForFile).mockResolvedValue({
			...emptyResult,
			latencyReport: carried,
		} as never);

		const result = await analyzeFile(tsFile, tmpDir);

		expect(result.latency?.totalDurationMs).toBe(22);
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

	it("claims a stale pi worklist with an explicit MCP owner without null-erasing it", async () => {
		const cache = new CacheManager();
		cache.addModifiedRange(
			tsFile,
			{ start: 1, end: 1 },
			false,
			tmpDir,
			"stale-pi-session",
		);
		const stale = cache.readTurnState(tmpDir);
		stale.owner!.lastSeen = new Date(Date.now() - 31 * 60_000).toISOString();
		cache.writeTurnState(stale, tmpDir);
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);

		await analyzeFile(tsFile, tmpDir, { registerTurnState: true });

		const state = cache.readTurnState(tmpDir);
		expect(state.sessionId).toMatch(/^mcp-/);
		expect(state.owner).toMatchObject({ kind: "mcp" });
	});

	it("does not let a live foreign MCP owner consume or extend the worklist (#1262)", () => {
		const cache = new CacheManager();
		const first = path.join(tmpDir, "first.ts");
		const second = path.join(tmpDir, "second.ts");
		fs.writeFileSync(first, "export const first = 1;\n");
		fs.writeFileSync(second, "export const second = 2;\n");
		cache.addModifiedRange(
			first,
			{ start: 1, end: 1 },
			false,
			tmpDir,
			"mcp-live-a",
			"mcp",
		);
		const foreignState = cache.readTurnState(tmpDir);
		foreignState.owner!.pid = process.pid + 1;
		cache.writeTurnState(foreignState, tmpDir);
		const killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation(() => true as never);
		try {
			cache.addModifiedRange(
				second,
				{ start: 1, end: 1 },
				false,
				tmpDir,
				"mcp-live-b",
				"mcp",
			);
			const state = cache.readTurnState(tmpDir);
			expect(Object.keys(state.files)).toEqual(["first.ts"]);
			expect(
				cache.getTurnStateAccess(tmpDir, { kind: "mcp", id: "mcp-live-b" }),
			).toBe("foreign-live");
			const beforeCycle = state.turnCycles;
			expect(
				cache.clearTurnState(tmpDir, { kind: "mcp", id: "mcp-live-b" }),
			).toBe(false);
			expect(
				cache.incrementTurnCycle(tmpDir, { kind: "mcp", id: "mcp-live-b" })
					.turnCycles,
			).toBe(beforeCycle);
			expect(cache.readTurnState(tmpDir).files).toHaveProperty("first.ts");
		} finally {
			killSpy.mockRestore();
		}
	});

	it("allows a same-process session handoff to advance and clear turn state", () => {
		const cache = new CacheManager();
		const file = path.join(tmpDir, "same-process.ts");
		fs.writeFileSync(file, "export const value = 1;\n");
		cache.addModifiedRange(
			file,
			{ start: 1, end: 1 },
			false,
			tmpDir,
			"pi-old",
			"pi",
		);

		expect(
			cache.incrementTurnCycle(tmpDir, { kind: "pi", id: "pi-new" }).turnCycles,
		).toBe(1);
		expect(cache.clearTurnState(tmpDir, { kind: "pi", id: "pi-new" })).toBe(
			true,
		);
		expect(cache.readTurnState(tmpDir).files).toEqual({});
	});

	it("preserves explicit writer ownership across pi/MCP handoffs (#1262)", () => {
		const cache = new CacheManager();
		const piFile = path.join(tmpDir, "pi.ts");
		const mcpFile = path.join(tmpDir, "mcp.ts");
		const sameSessionFile = path.join(tmpDir, "same-session.ts");
		for (const file of [piFile, mcpFile, sameSessionFile]) {
			fs.writeFileSync(file, "export const value = 1;\n");
		}

		cache.addModifiedRange(
			piFile,
			{ start: 1, end: 1 },
			false,
			tmpDir,
			"pi-a",
			"pi",
		);
		// A live MCP writer cannot consume or claim the pi worklist.
		cache.addModifiedRange(
			mcpFile,
			{ start: 1, end: 1 },
			false,
			tmpDir,
			"mcp-a",
			"mcp",
		);
		expect(cache.readTurnState(tmpDir).files).not.toHaveProperty("mcp.ts");

		// A repeated PostToolUse from the same MCP session extends its own worklist.
		cache.addModifiedRange(
			sameSessionFile,
			{ start: 1, end: 1 },
			false,
			tmpDir,
			"pi-a",
			"pi",
		);
		expect(cache.readTurnState(tmpDir).files).toHaveProperty("same-session.ts");

		// sessionId:null is non-claiming: it may append a file but never erases owner.
		cache.addModifiedRange(
			mcpFile,
			{ start: 1, end: 1 },
			false,
			tmpDir,
			null,
			"mcp",
		);
		expect(cache.readTurnState(tmpDir).owner).toMatchObject({
			kind: "pi",
			id: "pi-a",
		});

		// A different pi session can replace the owner only after its heartbeat is stale.
		const stale = cache.readTurnState(tmpDir);
		stale.owner!.lastSeen = new Date(Date.now() - 31 * 60_000).toISOString();
		cache.writeTurnState(stale, tmpDir);
		cache.addModifiedRange(
			mcpFile,
			{ start: 1, end: 1 },
			false,
			tmpDir,
			"mcp-b",
			"mcp",
		);
		expect(cache.readTurnState(tmpDir).owner).toMatchObject({
			kind: "mcp",
			id: "mcp-b",
		});
	});

	it("leaves turn-state untouched by default (#A)", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);
		await analyzeFile(tsFile, tmpDir);
		const turnState = new CacheManager().readTurnState(tmpDir);
		expect(Object.keys(turnState.files).length).toBe(0);
	});

	// ── #536: warm-mode graph maintenance gating ────────────────────────────

	it("does not update the graph by default (updateGraph unset)", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);
		await analyzeFile(tsFile, tmpDir);
		expect(mockBuildOrUpdateGraph).not.toHaveBeenCalled();
	});

	it("updates the graph when updateGraph:true and dispatch has no blockers", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);
		await analyzeFile(tsFile, tmpDir, { updateGraph: true });
		expect(mockBuildOrUpdateGraph).toHaveBeenCalledTimes(1);
		expect(mockBuildOrUpdateGraph).toHaveBeenCalledWith(
			tmpDir,
			[tsFile],
			expect.anything(),
		);
	});

	it("skips the graph update when the dispatch has blockers, even with updateGraph:true", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue({
			...emptyResult,
			diagnostics: [blockingDiagnostic],
			blockers: [blockingDiagnostic],
			hasBlockers: true,
		});
		await analyzeFile(tsFile, tmpDir, { updateGraph: true });
		expect(mockBuildOrUpdateGraph).not.toHaveBeenCalled();
	});

	it("skips the graph update for a file kind the graph doesn't model", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);
		const csv = path.join(tmpDir, "data.csv");
		fs.writeFileSync(csv, "a,b\n1,2\n");
		await analyzeFile(csv, tmpDir, { updateGraph: true });
		expect(mockBuildOrUpdateGraph).not.toHaveBeenCalled();
	});

	it("never fails the analysis when the graph update throws", async () => {
		vi.mocked(dispatchForFile).mockResolvedValue(emptyResult);
		mockBuildOrUpdateGraph.mockRejectedValueOnce(new Error("graph boom"));
		const result = await analyzeFile(tsFile, tmpDir, { updateGraph: true });
		expect(result.counts.diagnostics).toBe(0);
	});
});

// #3160 F1: `analyzeFile` records into widget-state with the RAW absPath it
// derives from `pilens_analyze`'s agent-supplied `file` arg
// (clients/mcp/analyze.ts:437-439/469) — unlike clients/pipeline.ts:1612,
// which always records `ctx.filePath`, already canonicalized to on-disk
// casing by `createDispatchContext` (#2016/#3098). Two production writers,
// one raw and one canonical, for the SAME `allDiagnostics` map. Before this
// fix a mis-cased `pilens_analyze` call created a SEPARATE, orphaned
// widget-state record that `lens_diagnostic_mark`'s #3160 cross-check fix
// (normalizing the READ side only) could never reach under ANY caller
// spelling. `recordDiagnostics` is now normalized at the write side too
// (clients/mcp/analyze.ts:469), so the analyze-written record collapses
// onto the SAME canonical key a prior canonical write (e.g. the dispatcher's
// `recordRunner`, simulated directly here) already established — the mark
// tool must reanchor under EITHER spelling of the file.
describe("analyzeFile — widget cross-check key parity across writers (#3160 F1)", () => {
	it("a mis-cased pilens_analyze write and a canonical dispatcher write land under ONE widget-state key", async (ctx) => {
		const fixture = createCaseAliasFixture(tmpDir, {
			content: "const a = 1;\nconst b = 2;\nconst target = bad();\n",
		});
		ctx.skip(fixture.skipReason !== undefined, fixture.skipReason ?? "");

		// A prior per-edit dispatch already touched this file canonically —
		// clients/pipeline.ts always keys from ctx.filePath (#2016/#3098).
		// Modeled directly via the same widget-state primitive
		// clients/dispatch/dispatcher.ts calls (recordRunner(ctx.filePath, ...)).
		recordRunner(fixture.onDisk, "eslint", "succeeded", 0, 5, 1);

		// The agent now calls pilens_analyze with the MIS-CASED spelling it
		// typed; analyzeFile resolves this to fixture.rawMisCased and (after
		// the F1 fix) records under normalizeMapKey(absPath).
		vi.mocked(dispatchForFile).mockResolvedValue({
			diagnostics: [
				{
					id: "bad-1",
					message: "bad call",
					filePath: fixture.rawMisCased,
					line: 3,
					column: 1,
					severity: "error" as const,
					semantic: "blocking" as const,
					tool: "eslint",
					rule: "no-bad",
				},
			],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			blockerOutput: "",
			hasBlockers: false,
		});

		const misCasedRelative = path.relative(tmpDir, fixture.rawMisCased);
		await analyzeFile(misCasedRelative, tmpDir);

		const markTool = createLensDiagnosticMarkTool(() => tmpDir);
		const runMark = (filePath: string) =>
			markTool.execute(
				"call-1",
				{
					filePath,
					line: 2, // stale
					message: "bad call",
					rule: "no-bad",
					tool: "eslint",
					disposition: "false-positive",
				},
				undefined,
				() => {},
				{ cwd: tmpDir },
			);

		const onDiskRelative = path.relative(tmpDir, fixture.onDisk);
		const viaCanonical = await runMark(onDiskRelative);
		expect(viaCanonical.isError).toBeFalsy();
		expect(String(viaCanonical.content[0]?.text)).toMatch(
			/reanchored from line 2 to 3/,
		);

		const viaMisCased = await runMark(misCasedRelative);
		expect(viaMisCased.isError).toBeFalsy();
		expect(String(viaMisCased.content[0]?.text)).toMatch(
			/reanchored from line 2 to 3/,
		);
	});
});

describe("analyzeFile — absolute dot-segment `file` argument (#3184)", () => {
	// #3184: the SAME `path.isAbsolute(x) ? x : path.resolve(cwd, x)` line
	// (clients/mcp/analyze.ts:437-439) also passes an already-ABSOLUTE agent
	// argument through untouched, and before the path-utils fix
	// `normalizeMapKey` did not fold dot segments on POSIX — so an absolute
	// `file` argument containing `/../` recorded the analysis under a key no
	// reader derives (every canonical writer keys through `path.resolve`
	// first). The dot segment is built by string CONCATENATION;
	// `path.join`/`path.resolve` would fold it and make the fixture vacuous.
	it("an absolute pilens_analyze `file` argument with a dot segment lands under the canonical widget-state key", async () => {
		fs.mkdirSync(path.join(tmpDir, "sub"), { recursive: true });
		const plainAbs = path.join(tmpDir, "sub", "a.ts");
		fs.writeFileSync(
			plainAbs,
			"const a = 1;\nconst b = 2;\nconst t = bad();\n",
		);
		const dotSegmentAbs = `${path.join(tmpDir, "sub")}${path.sep}..${path.sep}sub${path.sep}a.ts`;
		expect(dotSegmentAbs).toContain("..");
		expect(fs.realpathSync.native(dotSegmentAbs)).toBe(
			fs.realpathSync.native(plainAbs),
		);

		vi.mocked(dispatchForFile).mockResolvedValue({
			diagnostics: [
				{
					id: "bad-1",
					message: "bad call",
					filePath: dotSegmentAbs,
					line: 3,
					column: 1,
					severity: "error" as const,
					semantic: "blocking" as const,
					tool: "eslint",
					rule: "no-bad",
				},
			],
			blockers: [],
			warnings: [],
			baselineWarningCount: 0,
			fixed: [],
			resolvedCount: 0,
			output: "",
			blockerOutput: "",
			hasBlockers: false,
		});

		await analyzeFile(dotSegmentAbs, tmpDir);

		const markTool = createLensDiagnosticMarkTool(() => tmpDir);
		const result = await markTool.execute(
			"call-1",
			{
				filePath: path.relative(tmpDir, plainAbs),
				line: 2, // stale
				message: "bad call",
				rule: "no-bad",
				tool: "eslint",
				disposition: "false-positive",
			},
			undefined,
			() => {},
			{ cwd: tmpDir },
		);
		expect(result.isError).toBeFalsy();
		expect(String(result.content[0]?.text)).toMatch(
			/reanchored from line 2 to 3/,
		);
	});
});

// #3573: the row `pilens_analyze` records is stamped at the analysis's first
// read, not after the dispatch. The first read is the LSP warm-up's: the
// dispatch that follows can serve the diagnostics the warm-up's content
// produced. A write that lands after that read, while the analysis is still
// running, is then newer than the row and `reconcileStaleWidgetFiles` drops it.
describe("analyzeFile stamps its widget row at the analysis read (#3573)", () => {
	const T_READ = 1_900_000_000_000;
	const T_EDIT = T_READ + 400;
	const T_REC = T_READ + 1500;
	const setMtime = (file: string, ms: number) =>
		fs.utimesSync(file, ms / 1000, ms / 1000);

	/** The dispatch analyses from T_READ to T_REC; `during` runs at T_EDIT. */
	function dispatchBlocker(during?: () => void) {
		vi.mocked(dispatchForFile).mockImplementation(async () => {
			vi.setSystemTime(T_EDIT);
			during?.();
			vi.setSystemTime(T_REC);
			return {
				...emptyResult,
				diagnostics: [blockingDiagnostic],
				blockers: [blockingDiagnostic],
				hasBlockers: true,
			};
		});
	}

	const rewrite = () => {
		fs.writeFileSync(tsFile, "export const a = 2;\n");
		setMtime(tsFile, T_EDIT);
	};

	const rows = () =>
		getFileDiagnosticSummaries().flatMap((s) => s.diagnostics ?? []);

	beforeEach(() => {
		setMtime(tsFile, T_READ - 1000);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T_READ);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("drops the row when the file is rewritten during the dispatch (#3573)", async () => {
		dispatchBlocker(rewrite);
		await analyzeFile(tsFile, tmpDir);
		expect(rows()).toHaveLength(1);
		expect(await reconcileStaleWidgetFiles()).toBe(1);
		expect(rows()).toEqual([]);
	});

	it("drops the row when the file is rewritten after the LSP warm-up read it (#3573)", async () => {
		mockSupportsLSP.mockReturnValue(true);
		mockTouchFile.mockImplementationOnce(async () => {
			vi.setSystemTime(T_EDIT);
			rewrite();
			vi.setSystemTime(T_REC);
			return undefined;
		});
		dispatchBlocker();
		await analyzeFile(tsFile, tmpDir);
		expect(mockTouchFile).toHaveBeenCalledTimes(1);
		expect(await reconcileStaleWidgetFiles()).toBe(1);
		expect(rows()).toEqual([]);
	});

	it("keeps the row when the file was written before the analysis read it (#3573)", async () => {
		// Its mtime leads the clock by 40 ms: the #1710 skew the tolerance absorbs.
		setMtime(tsFile, T_READ + 40);
		dispatchBlocker();
		await analyzeFile(tsFile, tmpDir);
		expect(await reconcileStaleWidgetFiles()).toBe(0);
		expect(rows()).toEqual([
			expect.objectContaining({ message: "Type error", observedAt: T_READ }),
		]);
	});
});
