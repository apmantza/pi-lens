// flake-shape: in-process-mock — a language server is a spawned process; the subject is the drift and heartbeat producers above the client, which need a client that accepts a document and nothing else. The service, `logLatency`, the NDJSON sink and the performance report are real.
// flake-shape: service-double — the client double answers `notify.open` and the capability getters the sweep reads; no real server can be told to stall past the 10 s heartbeat gate on demand.
/**
 * #5379 — an age is not a duration, through the real producer, the real
 * latency sink and the real performance report.
 *
 * Recurrence it prevents: `lsp_document_drift` wrote the age of an untracked
 * disk drift (46 minutes after the document was last synced) into `durationMs`,
 * so the shipped performance report ranked it first in `slowestByP99` with a
 * p99 of 2,220,473 ms on a live log, ahead of every phase anyone waited for.
 * The producer now writes the value to `ageMs`; the report reads one shared
 * rule (`scripts/lib/latency-log-phases.mjs`) and never ranks it.
 *
 * Nothing but the language server client and the reverse-dependency index is
 * doubled (process boundaries): the drift sweep, `logLatency`, the NDJSON sink
 * and `collectLatencyPerformance` are all real. `PI_LENS_TEST_MODE=0` makes the
 * sink write for the one case, as the index witnesses do.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readNdjsonRows } from "../support/ndjson-rows.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/client.js")>()),
	createLSPClient,
}));

const ORIGINAL = "export const answer = 42;\nconst unused = 1;\n";
const BULK_EDITED = "export const answer = 42;\nexport const extra = 7;\n";
/** The 46-minute drift the live log carried (2,760,325 ms). */
const DRIFT_AGE_MS = 2_760_325;

function makeClient(openDocuments: Set<string>) {
	return {
		serverId: "typescript",
		isAlive: () => true,
		shutdown: vi.fn(async () => {}),
		isDocumentOpen: (filePath: string) =>
			openDocuments.has(path.resolve(filePath)),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none" as const,
		}),
		getOperationSupport: () => ({}),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => [],
		diagnosticsVersion: 0,
		getDiagnostics: vi.fn(() => []),
		notify: {
			announceCreated: () => undefined,
			open: vi.fn(async (filePath: string) => {
				openDocuments.add(path.resolve(filePath));
			}),
			change: vi.fn(async () => {}),
			watchedFileChange: vi.fn(),
		},
		waitForDiagnostics: vi.fn(async () => undefined),
	};
}

let dir: string;
let previousTestMode: string | undefined;
let previousHome: string | undefined;

beforeEach(async () => {
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	previousHome = process.env.PI_LENS_HOME;
	process.env.PI_LENS_TEST_MODE = "0";
	// The logger binds its file when its module loads: a private home gives this
	// file its own `latency.log`, so it neither clears nor reads rows another
	// concurrently running file wrote to the shared one.
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lens-age-5379-"));
	process.env.PI_LENS_HOME = path.join(dir, "home");
	vi.resetModules();
	(await import("../../clients/lsp/config.js"))._setServersForFileForTests(
		getServersForFileWithConfig,
	);
	getServersForFileWithConfig.mockReset();
	createLSPClient.mockReset();
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = previousTestMode;
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	await fs.rm(dir, { recursive: true, force: true });
});

it("a drift age written by the real producer is not ranked as a duration (#5379)", async () => {
	const logger = await import("../../clients/latency-logger.js");
	const { collectLatencyPerformance } =
		await import("../../clients/performance-report.js");
	const { LSPService } = await import("../../clients/lsp/index.js");
	// The private home took: nothing else writes to or reads from this log.
	expect(logger.getLatencyLogPath().startsWith(dir)).toBe(true);
	const sessionStartedAt = Date.now() - 1_000;

	const file = path.join(dir, "stdio.ts");
	await fs.writeFile(file, ORIGINAL, "utf-8");
	const service = new LSPService();
	const openDocuments = new Set<string>();
	getServersForFileWithConfig.mockReturnValue([
		{
			id: "typescript",
			name: "typescript",
			role: "language",
			extensions: [".ts"],
			root: async () => dir,
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		},
	]);
	createLSPClient.mockResolvedValue(makeClient(openDocuments));
	await service.touchFile(file, ORIGINAL, {
		diagnostics: "none",
		clientScope: "primary",
		source: "lsp_sync",
	});

	// The untracked bulk edit, then 46 minutes of nobody syncing the document.
	await fs.writeFile(file, BULK_EDITED, "utf-8");
	const future = new Date(Date.now() + 5_000);
	await fs.utimes(file, future, future);
	const realNow = Date.now.bind(Date);
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + DRIFT_AGE_MS);
	const result = await service.sweepDocumentDrift({ force: true });
	vi.restoreAllMocks();
	expect(result?.resynced).toBe(1);

	// One honest span for contrast: 40 ms of work somebody waited for.
	logger.logLatency({
		type: "phase",
		phase: "real_span_phase",
		filePath: "<pi-lens>",
		durationMs: 40,
	});
	await logger.flushLatencyLog();

	const written = readNdjsonRows<{ phase?: string; durationMs?: number }>(
		logger.getLatencyLogPath(),
	);
	expect(written.skipped).toBe(0);
	const drift = written.rows.filter(
		(row) => row.phase === "lsp_document_drift",
	);
	expect(drift, "the producer must have written its row").toHaveLength(1);

	const report = await collectLatencyPerformance({
		sessionStartedAt,
		topN: 5,
	});
	for (const scope of [report.logWindow, report.session]) {
		const ranked = scope.slowestByP99.map((row) => row.phase);
		expect(ranked, "the age must not be ranked as a duration").not.toContain(
			"lsp_document_drift",
		);
		expect(ranked).toContain("real_span_phase");
	}
	// A valid age row is not a malformed record either.
	expect(report.invalidRecords).toBe(0);
});

it("the workspace-sweep heartbeat writes its cumulative elapsed time as ageMs, the finished sweep keeps its span (#5379)", async () => {
	// Recurrence: a heartbeat every ~10 s wrote the sweep's cumulative elapsed
	// time into `durationMs`, so N heartbeats of one running sweep ranked as N
	// durations of one phase.
	const logger = await import("../../clients/latency-logger.js");
	const { collectLatencyPerformance } =
		await import("../../clients/performance-report.js");
	const { LSPService } = await import("../../clients/lsp/index.js");
	const sessionStartedAt = Date.now() - 1_000;
	fsSync.writeFileSync(path.join(dir, "a.py"), "x\n");
	fsSync.writeFileSync(path.join(dir, "b.py"), "y\n");

	vi.useFakeTimers({ toFake: ["Date"] });
	const client = makeClient(new Set());
	// Each open advances the clock past the 10 s heartbeat gate, as a slow
	// server would.
	client.notify.open = vi.fn(async () => {
		vi.setSystemTime(Date.now() + 11_000);
	});
	getServersForFileWithConfig.mockReturnValue([
		{
			id: "python",
			name: "python",
			extensions: [".py"],
			idleEviction: "resident",
			root: async () => dir,
			spawn: vi.fn(async () => ({ process: {}, source: "test" })),
		},
	]);
	createLSPClient.mockResolvedValue(client);
	await new LSPService().runWorkspaceDiagnostics(dir);
	vi.useRealTimers();
	await logger.flushLatencyLog();

	const written = readNdjsonRows<{
		phase?: string;
		durationMs?: number;
		ageMs?: number;
	}>(logger.getLatencyLogPath());
	expect(written.skipped).toBe(0);
	const heartbeats = written.rows.filter(
		(row) => row.phase === "lsp_workspace_diagnostics_progress",
	);
	expect(heartbeats.length, "the sweep must have heartbeat").toBeGreaterThan(0);
	for (const row of heartbeats) {
		expect(row.ageMs).toBeGreaterThanOrEqual(11_000);
		expect(row).not.toHaveProperty("durationMs");
	}
	const finished = written.rows.filter(
		(row) => row.phase === "lsp_workspace_diagnostics",
	);
	expect(finished).toHaveLength(1);
	expect(finished[0]).toHaveProperty("durationMs", expect.any(Number));
	expect(finished[0]).not.toHaveProperty("ageMs");

	const report = await collectLatencyPerformance({
		sessionStartedAt,
		topN: 20,
	});
	const ranked = report.logWindow.slowestByP99.map((row) => row.phase);
	expect(ranked).toContain("lsp_workspace_diagnostics");
	expect(ranked).not.toContain("lsp_workspace_diagnostics_progress");
});

it("host_boot and extension_loaded carry ageMs; extension_eval keeps its span (#5379)", async () => {
	// Recurrence: `host_boot` (ms since process start) and `extension_loaded`
	// (`host_boot` plus eval) were 52.4 s of 54.2 s of one live log's phase
	// total. `index.ts` maps the builder's records straight into `logLatency`.
	const logger = await import("../../clients/latency-logger.js");
	const { buildStartupTimingRecords } =
		await import("../../clients/startup-timing.js");
	for (const record of buildStartupTimingRecords({ loadMs: 900, evalMs: 40 })) {
		logger.logLatency(record);
	}
	await logger.flushLatencyLog();

	const written = readNdjsonRows<{
		phase?: string;
		durationMs?: number;
		ageMs?: number;
	}>(logger.getLatencyLogPath());
	expect(written.skipped).toBe(0);
	const byPhase = (phase: string) =>
		written.rows.filter((row) => row.phase === phase);
	for (const phase of ["host_boot", "extension_loaded"]) {
		expect(byPhase(phase), phase).toHaveLength(1);
		expect(byPhase(phase)[0], phase).toHaveProperty(
			"ageMs",
			expect.any(Number),
		);
		expect(byPhase(phase)[0], phase).not.toHaveProperty("durationMs");
	}
	expect(byPhase("extension_loaded")[0]?.ageMs).toBe(900);
	expect(byPhase("extension_eval")[0]).toMatchObject({ durationMs: 40 });
	expect(byPhase("extension_eval")[0]).not.toHaveProperty("ageMs");
});
