/**
 * Turn-end collect-later delivery for slow auxiliary LSP servers
 * (#2001/#2002).
 *
 * Drives the real `handleTurnEnd` against a mocked `getLSPService()` seam
 * (the process boundary — a real auxiliary client is an external child
 * process) and asserts the agent-visible guarantees:
 *   1. Findings an auxiliary published AFTER its aux-grace window expired are
 *      probed from the client cache at the next turn end and DELIVERED as an
 *      advisory (`runtime-turn:late-auxiliary-findings`, gated surface).
 *   2. A cited file edited after the mark timestamp drops its findings; a
 *      deleted cited file drops too. Neither is delivered stale, and both are
 *      counted in the `late_auxiliary_findings` latency record.
 *   3. A pair whose client is alive but still empty re-arms — freshness
 *      baseline preserved, TTL anchored on the last re-arm so each probe
 *      extends the window (`PI_LENS_LATE_AUX_REARM_TTL_MS`-tunable); past
 *      the TTL or with a dead client the pair drops.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";

const readCachedDiagnosticsForServers = vi.hoisted(() => vi.fn());
const observeLateAuxiliaryAnswer = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/lsp/index.js", () => ({
	// Only `getLSPService` crosses this seam in handleTurnEnd's import graph;
	// the double still carries the full surface so a method this path grows
	// later cannot throw into a swallow-all catch (#2582).
	getLSPService: () =>
		makeLspServiceDouble({
			readCachedDiagnosticsForServers,
			observeLateAuxiliaryAnswer,
		}),
}));

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Parameters<typeof actual.logLatency>[0]) => {
			logLatency(entry);
			actual.logLatency(entry);
		},
	};
});

import { CacheManager } from "../../../clients/cache-manager.js";
import { resetBoundedTelemetry } from "../../../clients/bounded-telemetry.js";
import {
	_resetDeferredForTests,
	_resetStateCacheForTests,
} from "../../../clients/diagnostic-dispositions.js";
import { createLensDiagnosticMarkTool } from "../../../tools/lens-diagnostic-mark.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../../clients/runtime-turn.js";
import {
	captureAuxPublicationBacklog,
	drainPendingAuxiliaryCoverage,
	markPendingAuxiliaryCoverage,
	MAX_LATE_AUX_REARMS,
	pendingAuxiliaryCoverageSize,
	readLateAuxRearmTtlMs,
	resetPendingAuxiliaryCoverage,
} from "../../../clients/lsp/pending-aux-coverage.js";
import {
	closeDocument,
	handleNotifyChange,
	handleNotifyOpen,
	publicationCountsForPath,
	setupIncomingHandlers,
	type LSPClientState,
	type LSPDiagnostic,
} from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { pathToFileURL } from "node:url";
import { createMockState } from "./mock-client-state.js";
import { setupTestEnvironment } from "../test-utils.js";

// The fixed behavior admits 20 detailed gap rows per turn. The regression uses
// 24 pairs, so a half-fixed cap still exceeds this bound and turns the test red.
const EXPECTED_GAP_DETAIL_CAP_PER_TURN = 20;
// The degradation ledger keeps 20 latest identity/reason entries per kind;
// excess identities are represented by droppedCount, not retained implicitly.
const EXPECTED_LEDGER_IDENTITY_CAP = 20;

function diag(line: number, message: string): LSPDiagnostic {
	return {
		range: {
			start: { line, character: 0 },
			end: { line, character: 10 },
		},
		severity: 2,
		code: "rule-x",
		source: "opengrep",
		message,
	};
}

function makeDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
) {
	return {
		ctxCwd: cwd,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => ({
				success: true,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "skipped",
			}),
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as any;
}

/** Register the file as modified this turn so turn_end runs its main path. */
function registerEdit(
	env: { tmpDir: string },
	sessionId: string,
	cacheManager: CacheManager,
	filePath: string,
	content = "export const value = 1;\n",
): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	// Pin mtime 10s in the past so the freshness relation is explicit.
	const past = new Date(Date.now() - 10_000);
	fs.utimesSync(filePath, past, past);
	cacheManager.addModifiedRange(
		filePath,
		{ start: 1, end: 1 },
		false,
		env.tmpDir,
		sessionId,
	);
}

function turnEndContent(cacheManager: CacheManager, cwd: string): string {
	return (
		cacheManager.readCache<{ content: string }>("turn-end-findings", cwd)?.data
			?.content ?? ""
	);
}

function lateAuxRecord(): any | undefined {
	return logLatency.mock.calls
		.map((call) => call[0])
		.find(
			(entry: any) =>
				entry?.type === "phase" && entry?.phase === "late_auxiliary_findings",
		);
}

beforeEach(() => {
	readCachedDiagnosticsForServers.mockReset();
	observeLateAuxiliaryAnswer.mockReset();
	observeLateAuxiliaryAnswer.mockResolvedValue(undefined);
	logLatency.mockClear();
	resetPendingAuxiliaryCoverage();
	resetBoundedTelemetry();
	resetDegradationLedger();
});

afterEach(() => {
	resetPendingAuxiliaryCoverage();
	resetBoundedTelemetry();
	resetDegradationLedger();
	delete process.env.PI_LENS_LATE_AUX_REARM_TTL_MS;
});

describe("turn-end late-auxiliary findings (#2001/#2002)", () => {
	it("PROBE-REPROMOTE-DRAIN: handleTurnEnd observes five fast late publications", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-repromote-") as any;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-repromote" });
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "repromote.ts");
			// The observer is a mock here: this test pins that the drain CALLS it
			// with the publish-minus-mark elapsed time; re-promotion itself is pinned
			// against the real service in service-aux-grace.test.ts.
			observeLateAuxiliaryAnswer.mockImplementation(async () => {});
			readCachedDiagnosticsForServers.mockImplementation(
				async () =>
					new Map([
						[
							"opengrep",
							{ diags: [diag(1, "late typo")], publishedAt: Date.now() },
						],
					]),
			);

			const deliveredPerTurn: number[] = [];
			for (let turn = 0; turn < 5; turn += 1) {
				runtime.beginTurn();
				registerEdit(env, "late-aux-repromote", cacheManager, file);
				markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 100);
				await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
				deliveredPerTurn.push(lateAuxRecord()?.metadata?.delivered ?? 0);
			}

			expect(deliveredPerTurn).toEqual([1, 1, 1, 1, 1]);
			expect(observeLateAuxiliaryAnswer).toHaveBeenCalledTimes(5);
			// Re-promotion itself is pinned one seam lower (service-aux-grace.test.ts);
			// this test pins the drain's observe call and its publish-minus-mark metric.
		} finally {
			env.cleanup();
		}
	});

	it("delivers findings an auxiliary published after its grace window expired", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-deliver-") as any;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-session" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "scanned.ts");
			registerEdit(env, "late-aux-session", cacheManager, file);

			// The grace expired without publication → the pair was marked ~2s
			// AFTER the file write but BEFORE the scan finished.
			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 2000);
			// By turn end the scanner has published into its client cache.
			readCachedDiagnosticsForServers.mockImplementation(
				async (_filePath: string, serverIds: ReadonlySet<string>) => {
					const out = new Map<
						string,
						{ diags: LSPDiagnostic[]; publishedAt: number }
					>();
					if (serverIds.has("opengrep"))
						out.set("opengrep", {
							diags: [diag(4, "late finding body")],
							publishedAt: Date.now(),
						});
					return out;
				},
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			const content = turnEndContent(cacheManager, env.tmpDir);
			expect(content).toContain("Late auxiliary diagnostics");
			expect(content).toContain("opengrep");
			expect(content).toContain("late finding body");
			expect(content).toContain(path.basename(file));

			// The pair was consumed, not left pending.
			expect(drainPendingAuxiliaryCoverage()).toHaveLength(0);

			// One bounded latency record names the outcome counts.
			const record = lateAuxRecord();
			expect(record).toBeDefined();
			expect(record.metadata).toMatchObject({
				pending: 1,
				delivered: 1,
				stale: 0,
				rearmed: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("drops findings when the cited file was edited after the mark", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-stale-") as any;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-stale" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "stale.ts");
			registerEdit(env, "late-aux-stale", cacheManager, file);

			// Marked long before the edit that drifted the file past the mark:
			// mtime (now-10s) > mark (now-60s) + tolerance → stale → drop.
			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 60_000);
			readCachedDiagnosticsForServers.mockImplementation(
				async () =>
					new Map([
						[
							"opengrep",
							{
								diags: [diag(0, "should not appear")],
								publishedAt: Date.now(),
							},
						],
					]),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			const content = turnEndContent(cacheManager, env.tmpDir);
			expect(content).not.toContain("should not appear");
			expect(content).not.toContain("Late auxiliary diagnostics");

			const record = lateAuxRecord();
			expect(record).toBeDefined();
			expect(record.metadata).toMatchObject({ pending: 1, delivered: 0 });
			expect(record.metadata.stale).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});

	it("retires a newer empty publication as cleanConfirmed", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-clean-") as any;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-clean" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "clean.ts");
			registerEdit(env, "late-aux-clean", cacheManager, file);
			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 2_000);
			const clean: {
				diags: LSPDiagnostic[];
				publishedAt: number;
			} = { diags: [], publishedAt: Date.now() };
			readCachedDiagnosticsForServers.mockResolvedValue(
				new Map([["opengrep", clean]]),
			);
			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			expect(drainPendingAuxiliaryCoverage()).toHaveLength(0);
			expect(lateAuxRecord()?.metadata).toMatchObject({
				pending: 1,
				cleanConfirmed: 1,
				rearmed: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("retires a never-published pair at the re-arm ceiling", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-ceiling-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-ceiling" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "ceiling.ts");
			registerEdit(env, "late-aux-ceiling", cacheManager, file);
			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 1000);
			readCachedDiagnosticsForServers.mockResolvedValue(
				new Map([["opengrep", { diags: [], publishedAt: undefined }]]),
			);

			for (let turn = 0; turn <= MAX_LATE_AUX_REARMS; turn += 1) {
				registerEdit(env, "late-aux-ceiling", cacheManager, file);
				await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			}

			const ceilingRemaining = drainPendingAuxiliaryCoverage();
			expect(ceilingRemaining).toHaveLength(0);
			const records = logLatency.mock.calls
				.map((call) => call[0])
				.filter((entry: any) => entry?.phase === "late_auxiliary_findings");
			expect(records.at(-1)?.metadata).toMatchObject({
				pairCreated: 1,
				ceilingExhausted: 1,
				pendingAfter: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("retires a stale-looping pair at the re-arm ceiling with a distinct outcome (#2167)", async () => {
		// The no-publication ceiling above bounds the "still scanning" branch.
		// A pair that DOES get answered every turn, but whose findings are
		// always stale (the cited file keeps looking edited-after-the-scan),
		// re-arms through the SEPARATE clause at the stale-findings site. That
		// clause carries its own `(pair.rearmCount ?? 0) < MAX_LATE_AUX_REARMS`
		// check; deleting it would let this loop re-arm forever instead of
		// ever reaching `ceilingExhausted`.
		const env = setupTestEnvironment("pi-lens-late-aux-stale-ceiling-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-stale-ceiling" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const sessionId = "late-aux-stale-ceiling";
			const file = path.join(env.tmpDir, "src", "stale-ceiling.ts");

			// Write the file ONCE and pin its mtime far in the future so every
			// turn's freshness gate sees it as edited-after-the-scan (stale)
			// on every re-arm.
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "export const value = 1;\n");
			const future = new Date(Date.now() + 600_000);
			fs.utimesSync(file, future, future);
			cacheManager.addModifiedRange(
				file,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				sessionId,
			);

			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 1000);
			const farPublishedAt = Date.now() + 500_000;
			readCachedDiagnosticsForServers.mockImplementation(
				async () =>
					new Map([
						[
							"opengrep",
							{
								diags: [diag(0, "stale finding body")],
								publishedAt: farPublishedAt,
							},
						],
					]),
			);

			for (let turn = 0; turn <= MAX_LATE_AUX_REARMS; turn += 1) {
				// Keep this turn's modified-file worklist non-empty WITHOUT
				// touching the pinned future mtime the freshness gate reads.
				cacheManager.addModifiedRange(
					file,
					{ start: 1, end: 1 },
					false,
					env.tmpDir,
					sessionId,
				);
				await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			}

			expect(drainPendingAuxiliaryCoverage()).toHaveLength(0);
			const content = turnEndContent(cacheManager, env.tmpDir);
			expect(content).not.toContain("stale finding body");

			const records = logLatency.mock.calls
				.map((call) => call[0])
				.filter((entry: any) => entry?.phase === "late_auxiliary_findings");
			const rearmedTotal = records.reduce(
				(sum: number, r: any) => sum + (r.metadata.rearmed ?? 0),
				0,
			);
			expect(rearmedTotal).toBe(MAX_LATE_AUX_REARMS);
			// The ceiling turn retires the pair as `ceilingExhausted` — a
			// DISTINCT outcome from `expired` (TTL) or `answered` (delivered).
			expect(records.at(-1)?.metadata).toMatchObject({
				pairCreated: 1,
				ceilingExhausted: 1,
				expired: 0,
				pendingAfter: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("bounds a transient probe throw to a re-arm instead of dropping coverage (#2167 R2-2)", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-probe-throw-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-probe-throw" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const sessionId = "late-aux-probe-throw";
			const file = path.join(env.tmpDir, "src", "probe-throw.ts");
			registerEdit(env, sessionId, cacheManager, file);
			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 1000);
			readCachedDiagnosticsForServers.mockRejectedValue(
				new Error("transient cache read failure"),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			// One transient throw counts the failure AND keeps the pair
			// pending — the coverage must not vanish uncounted.
			expect(pendingAuxiliaryCoverageSize()).toBe(1);
			expect(lateAuxRecord()?.metadata).toMatchObject({
				probeFailed: 1,
				rearmed: 1,
				pendingAfter: 1,
			});

			// The re-arm is still bounded: repeated throws eventually retire
			// the pair instead of looping forever.
			for (let turn = 0; turn < MAX_LATE_AUX_REARMS; turn += 1) {
				cacheManager.addModifiedRange(
					file,
					{ start: 1, end: 1 },
					false,
					env.tmpDir,
					sessionId,
				);
				await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			}
			expect(pendingAuxiliaryCoverageSize()).toBe(0);
			const records = logLatency.mock.calls
				.map((call) => call[0])
				.filter((entry: any) => entry?.phase === "late_auxiliary_findings");
			expect(records.at(-1)?.metadata).toMatchObject({
				ceilingExhausted: 1,
				pendingAfter: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("reconciles pair units across clean, stale, absent, and eviction paths", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-pair-reconcile-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "5000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-pair-reconcile" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const clean = path.join(env.tmpDir, "src", "clean.ts");
			const stale = path.join(env.tmpDir, "src", "stale.ts");
			registerEdit(env, "late-aux-pair-reconcile", cacheManager, stale);
			registerEdit(env, "late-aux-pair-reconcile", cacheManager, clean);
			markPendingAuxiliaryCoverage(
				path.join(env.tmpDir, "src", "evicted.ts"),
				["opengrep"],
				Date.now() - 1000,
			);
			markPendingAuxiliaryCoverage(clean, ["opengrep"], Date.now() - 1000);
			markPendingAuxiliaryCoverage(
				stale,
				["opengrep"],
				Date.now() - 60_000,
				Date.now() - 1000,
			);
			const absent = path.join(env.tmpDir, "src", "absent.ts");
			markPendingAuxiliaryCoverage(absent, ["opengrep"], Date.now() - 1000);
			const expired = path.join(env.tmpDir, "src", "expired.ts");
			markPendingAuxiliaryCoverage(expired, ["opengrep"], Date.now() - 10_000);
			for (let index = 0; index < 47; index += 1) {
				markPendingAuxiliaryCoverage(
					path.join(env.tmpDir, "src", `clean-${index}.ts`),
					["opengrep"],
					Date.now() - 1000,
				);
			}
			readCachedDiagnosticsForServers.mockImplementation(
				async (filePath: string) => {
					if (filePath === absent) return new Map();
					if (filePath === stale)
						return new Map([
							[
								"opengrep",
								{ diags: [diag(0, "old")], publishedAt: Date.now() },
							],
						]);
					if (filePath === expired)
						return new Map([
							["opengrep", { diags: [], publishedAt: Date.now() - 20_000 }],
						]);
					return new Map([
						["opengrep", { diags: [], publishedAt: Date.now() }],
					]);
				},
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			const metadata = lateAuxRecord()?.metadata;
			// 52 pairs were marked above (evicted.ts, clean, stale, absent,
			// expired, clean-0..46) against a 50-pair cap: "evicted.ts" and
			// "clean" are the two OLDEST pairs, so both are cap-evicted before
			// this drain ever sees them (#2168). `capEvicted` folds them back
			// into the reconciliation sum instead of letting them vanish
			// uncounted — `pairCreated` (52) now reflects every pair actually
			// marked, not just what survived to be drained (50).
			expect(metadata).toMatchObject({
				pairCreated: 52,
				capEvicted: 2,
				cleanConfirmed: 47,
				clientGone: 1,
				expired: 1,
				rearmed: 1,
				pendingAfter: 1,
			});
			expect(
				metadata.cleanConfirmed +
					metadata.clientGone +
					metadata.expired +
					metadata.pendingAfter +
					metadata.capEvicted,
			).toBe(metadata.pairCreated);
			expect(metadata.stale).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	it("reconciles expired and conversion-empty retirements", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-reconcile-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "5000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-reconcile" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const expired = path.join(env.tmpDir, "src", "expired.ts");
			const empty = path.join(env.tmpDir, "src", "empty.ts");
			registerEdit(env, "late-aux-reconcile", cacheManager, expired);
			registerEdit(env, "late-aux-reconcile", cacheManager, empty);
			markPendingAuxiliaryCoverage(expired, ["opengrep"], Date.now() - 10_000);
			markPendingAuxiliaryCoverage(empty, ["opengrep"], Date.now() - 2_000);
			readCachedDiagnosticsForServers.mockImplementation(
				async (filePath: string) =>
					filePath === expired
						? new Map([
								["opengrep", { diags: [], publishedAt: Date.now() - 20_000 }],
							])
						: new Map([
								[
									"opengrep",
									{ diags: [{ message: "bad" }], publishedAt: Date.now() },
								],
							]),
			);
			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			const metadata = lateAuxRecord()?.metadata;
			expect(metadata).toMatchObject({ pending: 2, expired: 1, missing: 1 });
			expect(metadata.expired + metadata.missing).toBe(metadata.pending);
		} finally {
			env.cleanup();
		}
	});

	it("drops findings when the cited file is gone", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-deleted-") as any;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-deleted" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const kept = path.join(env.tmpDir, "src", "kept.ts");
			registerEdit(env, "late-aux-deleted", cacheManager, kept);

			const deleted = path.join(env.tmpDir, "src", "deleted.ts");
			markPendingAuxiliaryCoverage(deleted, ["opengrep"], Date.now() - 2000);
			readCachedDiagnosticsForServers.mockImplementation(
				async () =>
					new Map([
						[
							"opengrep",
							{
								diags: [diag(0, "finding for deleted file")],
								publishedAt: Date.now(),
							},
						],
					]),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			const content = turnEndContent(cacheManager, env.tmpDir);
			expect(content).not.toContain("finding for deleted file");
			const record = lateAuxRecord();
			expect(record).toBeDefined();
			expect(record.metadata.missing).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});

	it("re-arms an alive-but-empty probe within the TTL and preserves the baseline", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-rearm-") as any;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-rearm" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "slow.ts");
			registerEdit(env, "late-aux-rearm", cacheManager, file);

			const markedAt = Date.now() - 1000;
			markPendingAuxiliaryCoverage(file, ["opengrep"], markedAt);
			// Client alive (present in the map) but the scan has not landed yet.
			readCachedDiagnosticsForServers.mockImplementation(
				async () => new Map([["opengrep", { diags: [] }]]),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			// Nothing delivered, but the pair survives for the NEXT turn end.
			expect(turnEndContent(cacheManager, env.tmpDir)).not.toContain(
				"Late auxiliary diagnostics",
			);
			const stillPending = drainPendingAuxiliaryCoverage();
			expect(stillPending).toHaveLength(1);
			// The freshness baseline survives re-arm untouched...
			expect(stillPending[0].markedAtMs).toBe(markedAt);
			// ...and the successful probe advanced the TTL anchor past the mark.
			expect(stillPending[0].lastRearmedAtMs).toBeGreaterThan(markedAt);

			// Past the TTL the same empty probe retires the pair instead. The
			// store preserves a live pair's baseline, so expire by draining first
			// and marking fresh with an already-aged timestamp.
			resetPendingAuxiliaryCoverage();
			registerEdit(env, "late-aux-rearm", cacheManager, file);
			markPendingAuxiliaryCoverage(
				file,
				["opengrep"],
				Date.now() - readLateAuxRearmTtlMs() - 5000,
			);
			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			expect(drainPendingAuxiliaryCoverage()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("a successful probe extends the window past the original mark's TTL", async () => {
		// Red-first core of the decoupled-clock fix: a pair whose MARK is older
		// than the TTL but that was just re-armed by a successful empty probe
		// must stay pending — each probe proves the scanner is alive but slow.
		const env = setupTestEnvironment("pi-lens-late-aux-extend-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "5000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-extend" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "extend.ts");
			registerEdit(env, "late-aux-extend", cacheManager, file);

			// Marked 10s ago (past the 5s TTL from mark) but re-armed 1s ago by
			// the previous turn's probe.
			markPendingAuxiliaryCoverage(
				file,
				["opengrep"],
				Date.now() - 10_000,
				Date.now() - 1_000,
			);
			readCachedDiagnosticsForServers.mockImplementation(
				async () => new Map([["opengrep", { diags: [] }]]),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			// Kept for the next turn end; baseline unchanged, anchor advanced.
			const stillPending = drainPendingAuxiliaryCoverage();
			expect(stillPending).toHaveLength(1);
			expect(stillPending[0].markedAtMs).toBeLessThan(Date.now() - 5_000);
			expect(stillPending[0].lastRearmedAtMs).toBeGreaterThan(
				Date.now() - 5_000,
			);
		} finally {
			env.cleanup();
		}
	});

	it("an un-re-armed pair past the TTL still drops (no always-keep drift)", async () => {
		// Mirror guard for the extension test: without a re-arm stamp the TTL
		// must keep measuring from the mark, so an old silent pair is retired.
		const env = setupTestEnvironment("pi-lens-late-aux-expire-") as any;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "5000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-expire" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "expire.ts");
			registerEdit(env, "late-aux-expire", cacheManager, file);

			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 10_000);
			readCachedDiagnosticsForServers.mockImplementation(
				async () => new Map([["opengrep", { diags: [] }]]),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			expect(drainPendingAuxiliaryCoverage()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("drops a pair silently when the auxiliary client is gone", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-gone-") as any;
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-gone" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "gone.ts");
			registerEdit(env, "late-aux-gone", cacheManager, file);

			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 2000);
			// The service answers with an EMPTY map: no live client for opengrep.
			readCachedDiagnosticsForServers.mockImplementation(async () => new Map());

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			expect(drainPendingAuxiliaryCoverage()).toHaveLength(0);
			const record = lateAuxRecord();
			expect(record).toBeDefined();
			expect(record.metadata.clientGone).toBe(1);
			expect(record.metadata.rearmed).toBe(0);
		} finally {
			env.cleanup();
		}
	});

	it("re-arms a pair while notify-stall teardown awaits a replacement (#2356)", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-demoted-");
		try {
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-demoted" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "demoted.ts");
			registerEdit(env, "late-aux-demoted", cacheManager, file);
			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 1000);

			// This is the LSP service's explicit notify-stall teardown status. It is
			// distinct from an absent client: the old generation was removed, but the
			// breaker still permits a replacement attempt after cooldown.
			readCachedDiagnosticsForServers.mockResolvedValue(
				new Map([
					[
						"opengrep",
						{ diags: [], notifyStallDemoted: true, demotedAt: Date.now() },
					],
				]),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			const pending = drainPendingAuxiliaryCoverage();
			expect(pending).toHaveLength(1);
			expect(lateAuxRecord()?.metadata).toMatchObject({
				notifyStallDemoted: 1,
				rearmed: 1,
				clientGone: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("re-raises a coverage gap when a demoted scanner has no replacement (#2356)", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-demoted-gap-");
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "5000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-demoted-gap" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "demoted-gap.ts");
			registerEdit(env, "late-aux-demoted-gap", cacheManager, file);
			markPendingAuxiliaryCoverage(
				file,
				["opengrep"],
				Date.now() - 1000,
				Date.now() - 1000,
				MAX_LATE_AUX_REARMS,
			);
			readCachedDiagnosticsForServers.mockResolvedValue(
				new Map([
					[
						"opengrep",
						{ diags: [], notifyStallDemoted: true, demotedAt: Date.now() },
					],
				]),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			expect(drainPendingAuxiliaryCoverage()).toHaveLength(0);
			expect(lateAuxRecord()?.metadata).toMatchObject({
				notifyStallDemoted: 1,
				coverageGapReRaised: 1,
				clientGone: 0,
			});
			const gapRows = logLatency.mock.calls
				.map(([entry]) => entry)
				.filter((entry: unknown) => {
					if (typeof entry !== "object" || entry === null) return false;
					const record = entry as {
						phase?: unknown;
						metadata?: { reRaised?: unknown };
					};
					return (
						record.phase === "lsp_scanner_coverage_gap" &&
						record.metadata?.reRaised === true
					);
				});
			expect(gapRows).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("caps re-raised coverage-gap detail while preserving aggregate visibility (#2356)", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-demoted-gap-cap-");
		const previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		const realLatencyLogger = await vi.importActual<
			typeof import("../../../clients/latency-logger.js")
		>("../../../clients/latency-logger.js");
		try {
			realLatencyLogger.clearLatencyLog();
			await realLatencyLogger.flushLatencyLog();
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "5000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: "late-aux-demoted-gap-cap" });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const pairCount = EXPECTED_GAP_DETAIL_CAP_PER_TURN + 4;
			const demotedAt = Date.now();
			const files = Array.from({ length: pairCount }, (_, index) =>
				path.join(env.tmpDir, "src", `demoted-gap-${index}.ts`),
			);
			for (const file of files) {
				registerEdit(env, "late-aux-demoted-gap-cap", cacheManager, file);
				markPendingAuxiliaryCoverage(
					file,
					["opengrep"],
					demotedAt - 1000,
					demotedAt - 1000,
					MAX_LATE_AUX_REARMS,
				);
			}
			readCachedDiagnosticsForServers.mockResolvedValue(
				new Map([
					["opengrep", { diags: [], notifyStallDemoted: true, demotedAt }],
				]),
			);

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));

			// Read the serialized bytes written by the real logger. The mocked
			// wrapper above records calls for the surrounding suite, but this proof
			// verifies the production sink's actual NDJSON surface.
			await realLatencyLogger.flushLatencyLog();
			const serializedRows = fs
				.readFileSync(realLatencyLogger.getLatencyLogPath(), "utf8")
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => JSON.parse(line) as any);
			const record = serializedRows.find(
				(entry) => entry?.phase === "late_auxiliary_findings",
			);
			expect(record?.metadata).toMatchObject({
				coverageGapReRaised: pairCount,
				coverageGapReRaisedDetailed: EXPECTED_GAP_DETAIL_CAP_PER_TURN,
				coverageGapReRaisedDropped:
					pairCount - EXPECTED_GAP_DETAIL_CAP_PER_TURN,
			});
			const gapRows = serializedRows.filter(
				(entry) =>
					entry?.phase === "lsp_scanner_coverage_gap" &&
					entry?.metadata?.reRaised === true,
			);
			expect(gapRows).toHaveLength(EXPECTED_GAP_DETAIL_CAP_PER_TURN);
			expect(
				gapRows.every((row: any) =>
					row.metadata.identity.endsWith(row.filePath),
				),
			).toBe(true);
			expect(gapRows[0]).toMatchObject({
				filePath: expect.stringContaining("demoted-gap-0.ts"),
				metadata: {
					identity: expect.stringContaining("opengrep:"),
					serverIds: ["opengrep"],
				},
			});
			const gapLedger = getDegradationSummary().find(
				(group) => group.kind === "lsp-scanner-coverage-gap",
			);
			expect(gapLedger).toMatchObject({
				count: pairCount,
				latestReasons: expect.any(Array),
				droppedCount: pairCount - EXPECTED_LEDGER_IDENTITY_CAP,
			});
			expect(gapLedger?.latestReasons).toHaveLength(
				EXPECTED_LEDGER_IDENTITY_CAP,
			);
			expect(
				gapLedger?.latestReasons.every(
					(entry) =>
						entry.subject.startsWith("opengrep:") &&
						entry.subject.includes("demoted-gap-"),
				),
			).toBe(true);
		} finally {
			if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
			else process.env.PI_LENS_TEST_MODE = previousTestMode;
			env.cleanup();
		}
	});

	it("correlates notify-stall demotions to each pair generation (#2356)", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-demoted-generation-");
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "5000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({
				sessionId: "late-aux-demoted-generation",
			});
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const terminalFile = path.join(env.tmpDir, "src", "terminal.ts");
			const eligibleFile = path.join(env.tmpDir, "src", "eligible.ts");
			const postDemotionFile = path.join(env.tmpDir, "src", "post-demotion.ts");
			registerEdit(
				env,
				"late-aux-demoted-generation",
				cacheManager,
				terminalFile,
			);
			registerEdit(
				env,
				"late-aux-demoted-generation",
				cacheManager,
				eligibleFile,
			);
			registerEdit(
				env,
				"late-aux-demoted-generation",
				cacheManager,
				postDemotionFile,
			);

			const demotedAt = Date.now();
			markPendingAuxiliaryCoverage(
				terminalFile,
				["opengrep"],
				demotedAt - 2,
				demotedAt - 2,
				MAX_LATE_AUX_REARMS,
			);
			markPendingAuxiliaryCoverage(eligibleFile, ["opengrep"], demotedAt - 1);
			markPendingAuxiliaryCoverage(
				postDemotionFile,
				["opengrep"],
				demotedAt + 1,
			);
			readCachedDiagnosticsForServers.mockImplementation(async () => {
				return new Map([
					["opengrep", { diags: [], notifyStallDemoted: true, demotedAt }],
				]);
			});

			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			const firstDrain = drainPendingAuxiliaryCoverage();
			expect(firstDrain.map((pair) => pair.filePath)).toEqual([eligibleFile]);
			expect(lateAuxRecord()?.metadata).toMatchObject({
				pending: 3,
				notifyStallDemoted: 2,
				rearmed: 1,
				clientGone: 1,
				coverageGapReRaised: 1,
			});

			// The terminal pair must not clear the shared marker. The pre-demotion
			// eligible pair remains attributable and re-arms on the next turn.
			logLatency.mockClear();
			runtime.beginTurn();
			markPendingAuxiliaryCoverage(eligibleFile, ["opengrep"], demotedAt - 1);
			registerEdit(
				env,
				"late-aux-demoted-generation",
				cacheManager,
				eligibleFile,
			);
			await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
			const secondDrain = drainPendingAuxiliaryCoverage();
			expect(secondDrain.map((pair) => pair.filePath)).toEqual([eligibleFile]);
			expect(lateAuxRecord()?.metadata).toMatchObject({
				pending: 1,
				notifyStallDemoted: 1,
				rearmed: 1,
				clientGone: 0,
				coverageGapReRaised: 0,
			});
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #3482: the drain's freshness was two timestamps plus an mtime gate, and a
 * version-less publish cannot say which revision it scanned. These cases drive
 * the real publish handler, resync clear and per-path counts (only the service
 * lookup is a double, reading that real client state) into the real
 * `handleTurnEnd`.
 */
describe("turn-end late-auxiliary drain never delivers an older revision's scan (#3482)", () => {
	function cachedFrom(state: LSPClientState, file: string) {
		const key = normalizeMapKey(file);
		// Same shape as LSPService.readCachedDiagnosticsForServers:
		// `getAllDiagnostics().get(key)` -> { diags: entry?.diags ?? [], publishedAt: entry?.ts }.
		// #3548: keyed by the scanner's OWN serverId (not a literal "opengrep")
		// so the same helper drives a #3548 typos/zizmor replay; every existing
		// call site passes an opengrep-armed scanner, so this is the same key
		// as before for all of them.
		return async () =>
			new Map([
				[
					state.serverId,
					{
						diags: state.pushDiagnostics.get(key) ?? [],
						publishedAt: state.pushDiagnosticTimestamps.get(key),
					},
				],
			]);
	}

	function armOpengrep(root: string, serverId = "opengrep") {
		const state = createMockState({ serverId, root });
		setupIncomingHandlers(state, {});
		const calls = vi.mocked(state.connection.onNotification).mock
			.calls as unknown as Array<[string, (params: unknown) => void]>;
		const handler = calls.find(
			(call) => call[0] === "textDocument/publishDiagnostics",
		)?.[1];
		expect(handler).toBeDefined();
		const client = {
			getPublicationCountsForPath: (filePath: string) =>
				publicationCountsForPath(state, normalizeMapKey(filePath)),
		};
		return {
			state,
			client,
			/** A raw version-less receipt, NOT flushed through the debounce. */
			receive: (file: string, diagnostics: LSPDiagnostic[]) =>
				handler?.({ uri: pathToFileURL(file).href, diagnostics }),
			/** #3490: opengrep's param-less `semgrep/rulesRefreshed`
			 *  (opengrep@1a5fd9d `Scan_helpers.refresh_rules`); a no-op when no
			 *  handler is registered, so a missing handler reds on behaviour. */
			rulesRefreshed: () =>
				calls.find((call) => call[0] === "semgrep/rulesRefreshed")?.[1]?.(
					undefined,
				),
			/** A versioned publish (ast-grep's shape), flushed through the debounce. */
			publishVersioned: (
				file: string,
				version: number,
				diagnostics: LSPDiagnostic[],
			) => {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				try {
					handler?.({ uri: pathToFileURL(file).href, version, diagnostics });
					vi.advanceTimersByTime(300);
				} finally {
					vi.useRealTimers();
				}
			},
			/** A version-less publish, flushed through opengrep's 250 ms debounce. */
			publish: (file: string, diagnostics: LSPDiagnostic[]) => {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				try {
					handler?.({ uri: pathToFileURL(file).href, diagnostics });
					vi.advanceTimersByTime(300);
				} finally {
					vi.useRealTimers();
				}
			},
		};
	}

	function writeAt(file: string, content: string, mtimeMs: number): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
		fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
	}

	async function turnEnd(
		runtime: RuntimeCoordinator,
		cacheManager: CacheManager,
		cwd: string,
		sessionId: string,
		file: string,
	): Promise<{ content: string; metadata: any }> {
		logLatency.mockClear();
		cacheManager.addModifiedRange(
			file,
			{ start: 1, end: 1 },
			false,
			cwd,
			sessionId,
		);
		await handleTurnEnd(makeDeps(runtime, cacheManager, cwd));
		return {
			content: turnEndContent(cacheManager, cwd),
			metadata: lateAuxRecord()?.metadata,
		};
	}

	it("counts sends and STORED publications per open lifetime (#3482 backlog axis)", async () => {
		// The binding is only as good as these two counts: a count taken at raw
		// receipt lets a debounced receipt satisfy the backlog while the cache
		// still holds the older scan, and a count that outlives its document
		// lifetime (or a store for a path never opened) under-counts the backlog.
		const scanner = armOpengrep("/project");
		const file = "/project/src/counted.ts";
		const other = "/project/src/fallback.ts";
		const counts = (target: string) =>
			publicationCountsForPath(scanner.state, normalizeMapKey(target));

		const key = normalizeMapKey(file);

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			scanner.receive(file, []); // a store before any open (e.g. a workspace pull)
			vi.advanceTimersByTime(300);
			expect(counts(file)).toEqual({ sent: 0, published: 0 });
			// A receipt still pending when the first open clears it belongs to no
			// send of this lifetime.
			scanner.receive(file, [diag(0, "pre-open")]);
			await handleNotifyOpen(scanner.state, file, "a", "ts", false, true);
			expect(counts(file)).toEqual({ sent: 1, published: 0 });

			scanner.receive(file, [diag(0, "received")]);
			expect(counts(file)).toEqual({ sent: 1, published: 0 });
			vi.advanceTimersByTime(300);
			expect(counts(file)).toEqual({ sent: 1, published: 1 });
			// #3482 r1 F1: a surplus while nothing is outstanding (opengrep's
			// rule-load [] then its post-rulesRefreshed republish) is absorbed.
			scanner.receive(file, [diag(0, "republished")]);
			vi.advanceTimersByTime(300);
			expect(counts(file)).toEqual({ sent: 1, published: 1 });

			// A resync clears the cache but not the count.
			await handleNotifyOpen(scanner.state, file, "b", "ts", false, true);
			expect(counts(file)).toEqual({ sent: 2, published: 1 });
			// #3482 lifetime: the counts span a close, and a receipt still pending
			// at close answered its send, so it counts.
			scanner.receive(file, [diag(0, "at close")]);
			await closeDocument(scanner.state, file);
			expect(counts(file)).toEqual({ sent: 2, published: 2 });
			expect(scanner.state.publicationStoreCountsByPath.has(key)).toBe(true);

			// The didChange fallback open starts a lifetime too.
			scanner.receive(other, []);
			vi.advanceTimersByTime(300);
			await handleNotifyChange(scanner.state, other, "x");
			expect(counts(other)).toEqual({ sent: 1, published: 0 });
		} finally {
			vi.useRealTimers();
		}
	});

	/** One agent touch: write, resync-send, and mark with the captured backlog. */
	async function touchAndMark(
		scanner: ReturnType<typeof armOpengrep>,
		file: string,
		content: string,
		notifiedAtMs: number,
		saved = false,
	): Promise<void> {
		writeAt(file, content, notifiedAtMs);
		await handleNotifyOpen(
			scanner.state,
			file,
			content,
			"ts",
			false,
			true,
			saved,
		);
		// #3548: the scanner's own serverId, not a literal "opengrep" — every
		// existing call site is opengrep-armed, so this is unchanged for them.
		markPendingAuxiliaryCoverage(
			file,
			[scanner.state.serverId],
			notifiedAtMs,
			undefined,
			undefined,
			captureAuxPublicationBacklog(scanner.client, file),
		);
	}

	const V1 = `${Array.from({ length: 20 }, (_, i) => `const a${i} = ${i};`).join("\n")}\n`;
	const V2 = "export const v = 2;\n";

	it("CLOSE-PUBLISH-SKIPPED: typos' close-triggered publish does not count as an owed scan, and a later real backlog publish still does (#3548)", async () => {
		const scanner = armOpengrep("/project", "typos");
		const file = "/project/src/close-typos.ts";
		const counts = () =>
			publicationCountsForPath(scanner.state, normalizeMapKey(file));
		await handleNotifyOpen(scanner.state, file, "a", "ts", false, true);
		expect(counts()).toEqual({ sent: 1, published: 0 });
		await closeDocument(scanner.state, file);
		// tekumara/typos-lsp `did_close`: an empty, version-less publish, sent
		// unconditionally on every close, that answers no send.
		scanner.publish(file, []);
		expect(counts()).toEqual({ sent: 1, published: 0 });
		// A genuine backlog answer arriving after the one skip is spent still
		// counts, same as before this fix.
		scanner.publish(file, [diag(0, "late real scan")]);
		expect(counts()).toEqual({ sent: 1, published: 1 });
	});

	it("CLOSE-PUBLISH-UNMARKED-STILL-COUNTS: a close-time publish for a server without publishesOnClose still answers the closed lifetime's owed scan (#3548 inverse)", async () => {
		const scanner = armOpengrep("/project", "eslint");
		const file = "/project/src/close-inverse.ts";
		const counts = () =>
			publicationCountsForPath(scanner.state, normalizeMapKey(file));
		await handleNotifyOpen(scanner.state, file, "a", "ts", false, true);
		expect(counts()).toEqual({ sent: 1, published: 0 });
		await closeDocument(scanner.state, file);
		// The same empty, version-less shape typos' close-triggered publish
		// carries — but eslint carries no `publishesOnClose` marker, so it is
		// never granted a skip and this still counts, exactly as before #3548.
		scanner.publish(file, []);
		expect(counts()).toEqual({ sent: 1, published: 1 });
	});

	it("CLOSE-PUBLISH-CREDIT-RESET: a skip credit granted by one close does not survive a reopen, so a second close only ever grants its own (#3548 review r1 B1)", async () => {
		// #3477's `closedAndGone` drops a reopen for a closed path whose file
		// is also gone from disk — a real file is required for the reopens
		// below to actually run rather than being silently skipped.
		const env = setupTestEnvironment("pi-lens-close-credit-reset-") as any;
		try {
			const scanner = armOpengrep(env.tmpDir, "typos");
			const file = path.join(env.tmpDir, "src", "credit-reset.ts");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "a");
			const counts = () =>
				publicationCountsForPath(scanner.state, normalizeMapKey(file));
			await handleNotifyOpen(scanner.state, file, "a", "ts", false, true);
			// Close #1: typos owes one close-triggered publish. Reopen happens
			// before it ever arrives, so the credit is spent by nothing.
			await closeDocument(scanner.state, file);
			await handleNotifyOpen(scanner.state, file, "b", "ts", false, true);
			expect(counts()).toEqual({ sent: 2, published: 0 });
			// Close #2: a fresh credit for THIS close only — never two.
			await closeDocument(scanner.state, file);
			// One close-triggered publish arrives (close #2's own) and spends it.
			scanner.publish(file, []);
			// A GENUINE backlog finding — the real, late answer this pair is
			// actually owed — arrives next, still closed. With the leak, close
			// #2's OWN credit is really 2 (1 leaked from close #1, spent by
			// nothing, plus 1 fresh), so this publish is ALSO wrongly skipped
			// and `published` stays 0. Fixed, close #2 granted exactly 1
			// credit, already spent by its own close-triggered publish above,
			// so this one counts.
			scanner.publish(file, [diag(0, "real finding")]);
			expect(counts()).toEqual({ sent: 2, published: 1 });
		} finally {
			env.cleanup();
		}
	});

	it("CLOSE-PUBLISH-LATE-AFTER-REOPEN: typos' close-triggered publish that arrives only AFTER a reopen is not exempted — an admitted residual (#3548 review r1 B1)", async () => {
		const env = setupTestEnvironment("pi-lens-close-publish-late-") as any;
		try {
			const scanner = armOpengrep(env.tmpDir, "typos");
			const file = path.join(env.tmpDir, "src", "publish-late.ts");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "a");
			const key = normalizeMapKey(file);
			const counts = () => publicationCountsForPath(scanner.state, key);
			await handleNotifyOpen(scanner.state, file, "a", "ts", false, true);
			await closeDocument(scanner.state, file);
			// Reopen BEFORE the close-triggered publish arrives: closedDocuments
			// no longer has this path, so the skip credit (now spent by the
			// reopen clear, #3548 review r1 B1) is moot for what follows either
			// way.
			await handleNotifyOpen(scanner.state, file, "b", "ts", false, true);
			expect(counts()).toEqual({ sent: 2, published: 0 });
			expect(scanner.state.pushDiagnostics.has(key)).toBe(false);
			// typos' close-triggered publish for the FIRST close finally arrives,
			// now that the path is open again. It is not routed through the
			// closedDocuments branch at all (the path isn't closed), so nothing
			// this PR added applies to it: it is stored and counted exactly like
			// any other publish for the currently open document — a version-
			// less, possibly EMPTY set standing in for content "b"'s real
			// diagnostics until "b"'s own scan publishes. This ordering (the
			// close handler's publish outrunning a slower in-flight scan) is
			// exactly what #3548's `publishesOnClose` marker assumes does NOT
			// happen for the credit itself to be meaningful; when it doesn't
			// hold, this is the existing #3482 "span" behavior, unchanged by
			// this fix in either direction.
			scanner.publish(file, []);
			expect(counts()).toEqual({ sent: 2, published: 1 });
			expect(scanner.state.pushDiagnostics.get(key)).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	it("REPLAY-RULE-LOAD-SURPLUS: opengrep's rule-load [] plus its refresh republish cannot shorten a later backlog (#3482 r1 F1)", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-rule-load-") as any;
		const sessionId = "late-aux-rule-load";
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "scanned.ts");
			const scanner = armOpengrep(env.tmpDir);
			readCachedDiagnosticsForServers.mockImplementation(
				cachedFrom(scanner.state, file),
			);
			// v0 is opened during the one-time rule load: an empty answer, then
			// the real scan after `semgrep/rulesRefreshed`.
			writeAt(file, "export const v = 0;\n", Date.now() - 30_000);
			await handleNotifyOpen(
				scanner.state,
				file,
				"export const v = 0;\n",
				"ts",
				false,
				true,
			);
			scanner.publish(file, []);
			scanner.publish(file, [diag(0, "V0 finding")]);
			await touchAndMark(scanner, file, V1, Date.now() - 20_000);
			await touchAndMark(scanner, file, V2, Date.now() - 10_000);
			scanner.publish(file, [diag(11, "V1-ONLY finding on line 12")]);

			const first = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(first.content).not.toContain("V1-ONLY");
			expect(first.metadata).toMatchObject({ delivered: 0, backlogPending: 1 });

			scanner.publish(file, [diag(0, "V2 finding on line 1")]);
			const second = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(second.content).toContain("V2 finding on line 1");
		} finally {
			env.cleanup();
		}
	});

	it("REPLAY-RULES-REFRESHED-INFLIGHT: the refresh republish cannot answer v1's outstanding send, so v1 is withheld after a re-touch (#3490)", async () => {
		const env = setupTestEnvironment(
			"pi-lens-late-aux-rules-refreshed-",
		) as any;
		const sessionId = "late-aux-rules-refreshed";
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "scanned.ts");
			const scanner = armOpengrep(env.tmpDir);
			readCachedDiagnosticsForServers.mockImplementation(
				cachedFrom(scanner.state, file),
			);
			// #3490's sequence. 1: v0 is opened during rule load; its [] arrives.
			writeAt(file, "export const v = 0;\n", Date.now() - 30_000);
			await handleNotifyOpen(
				scanner.state,
				file,
				"export const v = 0;\n",
				"ts",
				false,
				true,
			);
			scanner.publish(file, []);
			// 2: touch 1 sends v1.
			await touchAndMark(scanner, file, V1, Date.now() - 20_000);
			// 3: the rules load; the refresh republish lands before v1's answer.
			scanner.rulesRefreshed();
			scanner.publish(file, [diag(0, "V0 REPUBLISH finding")]);
			// 4: touch 2 sends v2 and re-marks.
			await touchAndMark(scanner, file, V2, Date.now() - 10_000);
			// 5: v1's answer lands.
			scanner.publish(file, [diag(11, "V1-ONLY finding on line 12")]);

			const first = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(first.content).not.toContain("V1-ONLY");
			expect(first.metadata).toMatchObject({ delivered: 0, backlogPending: 1 });

			scanner.publish(file, [diag(0, "V2 finding on line 1")]);
			const second = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(second.content).toContain("V2 finding on line 1");
		} finally {
			env.cleanup();
		}
	});

	it("REPLAY-RULES-REFRESHED-THEN-ANSWER: after the refresh republish, the next answer still counts and is delivered (#3490 inverse)", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-refresh-answer-") as any;
		const sessionId = "late-aux-refresh-answer";
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "scanned.ts");
			const scanner = armOpengrep(env.tmpDir);
			readCachedDiagnosticsForServers.mockImplementation(
				cachedFrom(scanner.state, file),
			);
			writeAt(file, "export const v = 0;\n", Date.now() - 30_000);
			await handleNotifyOpen(
				scanner.state,
				file,
				"export const v = 0;\n",
				"ts",
				false,
				true,
			);
			scanner.publish(file, []);
			await touchAndMark(scanner, file, V1, Date.now() - 20_000);
			scanner.publish(file, [diag(11, "V1 finding on line 12")]);
			// Two publications stored, nothing outstanding: the refresh takes one
			// back (not all of them) and its republish restores it.
			scanner.rulesRefreshed();
			scanner.publish(file, [diag(11, "V1 REPUBLISH finding")]);
			await touchAndMark(scanner, file, V2, Date.now() - 10_000);
			scanner.publish(file, [diag(0, "V2 finding on line 1")]);

			const first = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(first.content).toContain("V2 finding on line 1");
			expect(first.metadata).toMatchObject({ delivered: 1, backlogPending: 0 });
		} finally {
			env.cleanup();
		}
	});

	it("REPLAY-RULES-REFRESHED-DURING-DEBOUNCE: a first answer still inside the debounce at the notification is taken back too (#3490 r1 F1)", async () => {
		const env = setupTestEnvironment(
			"pi-lens-late-aux-refresh-debounce-",
		) as any;
		const sessionId = "late-aux-refresh-debounce";
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "scanned.ts");
			const scanner = armOpengrep(env.tmpDir);
			readCachedDiagnosticsForServers.mockImplementation(
				cachedFrom(scanner.state, file),
			);
			writeAt(file, "export const v = 0;\n", Date.now() - 30_000);
			await handleNotifyOpen(
				scanner.state,
				file,
				"export const v = 0;\n",
				"ts",
				false,
				true,
			);
			// v0's rule-load [] has arrived (so opengrep recorded the scan and
			// will republish it) but is still inside the 250 ms debounce when
			// the notification lands.
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				scanner.receive(file, []);
				scanner.rulesRefreshed();
				vi.advanceTimersByTime(300);
			} finally {
				vi.useRealTimers();
			}
			// A touch after the notification; the republish lands before its answer.
			await touchAndMark(scanner, file, V1, Date.now() - 20_000);
			scanner.publish(file, [diag(0, "V0 REPUBLISH finding")]);
			await touchAndMark(scanner, file, V2, Date.now() - 10_000);
			scanner.publish(file, [diag(11, "V1-ONLY finding on line 12")]);

			const first = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(first.content).not.toContain("V1-ONLY");
			expect(first.metadata).toMatchObject({ delivered: 0, backlogPending: 1 });

			scanner.publish(file, [diag(0, "V2 finding on line 1")]);
			const second = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(second.content).toContain("V2 finding on line 1");
		} finally {
			env.cleanup();
		}
	});

	it("REFRESH-DEBOUNCED-RECEIPT-COUNTS: a debounced receipt is taken back once, and only on a path with a send (#3490 r1 F1)", async () => {
		const scanner = armOpengrep("/project");
		const counted = "/project/src/counted.ts";
		const first = "/project/src/first.ts";
		const unopened = "/project/src/unopened.ts";
		const counts = (target: string) =>
			publicationCountsForPath(scanner.state, normalizeMapKey(target));
		await handleNotifyOpen(scanner.state, counted, "a", "ts", false, true);
		scanner.publish(counted, []);
		await handleNotifyOpen(scanner.state, first, "b", "ts", false, true);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			// Receipts still inside the debounce at the notification: a second
			// one on a counted path, a first one, and one for a path never opened.
			scanner.receive(counted, [diag(0, "again")]);
			scanner.receive(first, []);
			scanner.receive(unopened, []);
			scanner.rulesRefreshed();
			expect(counts(counted)).toEqual({ sent: 1, published: 0 });
			expect(counts(first)).toEqual({ sent: 1, published: -1 });
			expect(
				scanner.state.publicationStoreCountsByPath.has(
					normalizeMapKey(unopened),
				),
			).toBe(false);
			vi.advanceTimersByTime(300);
		} finally {
			vi.useRealTimers();
		}
		// The flushed receipts count; each republish then restores its path.
		expect(counts(counted)).toEqual({ sent: 1, published: 1 });
		expect(counts(first)).toEqual({ sent: 1, published: 0 });
		scanner.publish(first, [diag(0, "republish")]);
		expect(counts(first)).toEqual({ sent: 1, published: 1 });
	});

	it("REFRESH-LEAVES-UNANSWERED-PATH: rulesRefreshed takes one publication back only from paths that already had one (#3490)", async () => {
		// A path with no publication yet in its lifetime may not be republished
		// (opengrep republishes the files it has a scan recorded for); taking one
		// back from it would swallow its first real answer for good.
		const scanner = armOpengrep("/project");
		const answered = "/project/src/answered.ts";
		const unanswered = "/project/src/unanswered.ts";
		const counts = (target: string) =>
			publicationCountsForPath(scanner.state, normalizeMapKey(target));
		await handleNotifyOpen(scanner.state, answered, "a", "ts", false, true);
		scanner.publish(answered, []);
		await handleNotifyOpen(scanner.state, unanswered, "b", "ts", false, true);
		expect(counts(answered)).toEqual({ sent: 1, published: 1 });
		expect(counts(unanswered)).toEqual({ sent: 1, published: 0 });

		logLatency.mockClear();
		scanner.rulesRefreshed();
		expect(counts(answered)).toEqual({ sent: 1, published: 0 });
		expect(counts(unanswered)).toEqual({ sent: 1, published: 0 });
		expect(
			logLatency.mock.calls
				.map(([entry]) => entry)
				.filter((entry) => entry.phase === "lsp_rules_refreshed"),
		).toEqual([
			expect.objectContaining({
				type: "phase",
				filePath: "/project",
				durationMs: 0,
				metadata: { serverId: "opengrep", rebaselinedPaths: 1 },
			}),
		]);

		scanner.publish(answered, [diag(0, "republish")]);
		scanner.publish(unanswered, [diag(0, "first answer")]);
		expect(counts(answered)).toEqual({ sent: 1, published: 1 });
		expect(counts(unanswered)).toEqual({ sent: 1, published: 1 });
	});

	/**
	 * #3482's surplus publishes that pi-lens itself triggers, read from
	 * opengrep@1a5fd9d `Notification_handler.on_notification`: a didSave runs
	 * `scan_file` again, and a scan queued before a close publishes after it.
	 * v0 is open and answered in each replay.
	 */
	async function surplusReplay(
		prefix: string,
		body: (ctx: {
			scanner: ReturnType<typeof armOpengrep>;
			file: string;
			turn: () => Promise<{ content: string; metadata: any }>;
		}) => Promise<void>,
		// #3548: which server's strategy this replay arms — defaults to
		// opengrep (every pre-#3548 call site) so existing replays are
		// unaffected; typos' close-publish replay passes "typos".
		serverId = "opengrep",
	): Promise<void> {
		const env = setupTestEnvironment(`pi-lens-late-aux-${prefix}-`) as any;
		const sessionId = `late-aux-${prefix}`;
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "scanned.ts");
			const scanner = armOpengrep(env.tmpDir, serverId);
			// opengrep declares `save: true` (opengrep@1a5fd9d LS.ml); harmless
			// for a serverId that never sends a save-marked touch.
			scanner.state.saveOptions = { includeText: false };
			readCachedDiagnosticsForServers.mockImplementation(
				cachedFrom(scanner.state, file),
			);
			const v0 = "export const v = 0;\n";
			writeAt(file, v0, Date.now() - 30_000);
			await handleNotifyOpen(scanner.state, file, v0, "ts", false, true);
			scanner.publish(file, []);
			await body({
				scanner,
				file,
				turn: () => turnEnd(runtime, cacheManager, env.tmpDir, sessionId, file),
			});
		} finally {
			env.cleanup();
		}
	}

	const didSaves = (scanner: ReturnType<typeof armOpengrep>) =>
		vi
			.mocked(scanner.state.connection.sendNotification)
			.mock.calls.filter(([method]) => method === "textDocument/didSave")
			.length;

	it("REPLAY-SAVE-RESCAN: opengrep's didSave rescan of v1 cannot answer v2's send, so v1 is withheld after a re-touch (#3482 surplus)", async () => {
		await surplusReplay("save-rescan", async ({ scanner, file, turn }) => {
			// Touch 1 is a save (#3405, lsp_diagnostics): opengrep scans v1 on
			// the reopen and again on didSave.
			await touchAndMark(scanner, file, V1, Date.now() - 20_000, true);
			expect(didSaves(scanner)).toBe(1);
			scanner.publish(file, [diag(11, "V1-ONLY finding on line 12")]);
			await touchAndMark(scanner, file, V2, Date.now() - 10_000);
			// v1's save rescan lands after touch 2's send.
			scanner.publish(file, [diag(11, "V1-ONLY finding on line 12")]);

			const first = await turn();
			expect(first.content).not.toContain("V1-ONLY");
			expect(first.metadata).toMatchObject({ delivered: 0, backlogPending: 1 });

			scanner.publish(file, [diag(0, "V2 finding on line 1")]);
			expect((await turn()).content).toContain("V2 finding on line 1");
		});
	});

	it("REPLAY-SAVE-RESCAN-THEN-ANSWER: after a save's two publications, the next answer still counts and is delivered (#3482 surplus inverse)", async () => {
		await surplusReplay("save-answer", async ({ scanner, file, turn }) => {
			await touchAndMark(scanner, file, V1, Date.now() - 20_000, true);
			scanner.publish(file, [diag(0, "V1 open scan")]);
			scanner.publish(file, [diag(0, "V1 save rescan")]);
			await touchAndMark(scanner, file, V2, Date.now() - 10_000);
			scanner.publish(file, [diag(0, "V2 finding on line 1")]);

			const first = await turn();
			expect(first.content).toContain("V2 finding on line 1");
			expect(first.metadata).toMatchObject({ delivered: 1, backlogPending: 0 });
		});
	});

	it("SAVE-RESCAN-EXPECTED: a save adds one expected publication on a rescansOnSave server only, the held-document save included (#3482 surplus)", async () => {
		const scanner = armOpengrep("/project");
		scanner.state.saveOptions = { includeText: false };
		const file = "/project/src/saved.ts";
		const counts = () =>
			publicationCountsForPath(scanner.state, normalizeMapKey(file));
		await handleNotifyOpen(scanner.state, file, "a", "ts", false, true, true);
		expect(counts()).toEqual({ sent: 2, published: 0 });
		// #3481: an entry read before the content last sent is dropped, and its
		// save goes out for the document the server holds.
		await handleNotifyOpen(
			scanner.state,
			file,
			"c",
			"ts",
			false,
			true,
			false,
			2,
		);
		await handleNotifyOpen(
			scanner.state,
			file,
			"b",
			"ts",
			false,
			true,
			true,
			1,
		);
		expect(didSaves(scanner)).toBe(2);
		expect(counts()).toEqual({ sent: 4, published: 0 });

		// ast-grep declares no rescan on save: its didSave expects nothing.
		const other = armOpengrep("/project", "ast-grep");
		other.state.saveOptions = { includeText: false };
		await handleNotifyOpen(other.state, file, "a", "ts", false, true, true);
		expect(didSaves(other)).toBe(1);
		expect(
			publicationCountsForPath(other.state, normalizeMapKey(file)),
		).toEqual({ sent: 1, published: 0 });
	});

	it("ZIZMOR-SAVE-RESCAN-EXPECTED: a save adds one expected publication on zizmor now that rescansOnSave is set, for whenever dynamic didSave registration is honoured (#3548)", async () => {
		// zizmor@main `crates/zizmor/src/lsp.rs` registers `textDocument/didSave`
		// DYNAMICALLY (`initialized()`); `applyDynamicCapabilities` (client.ts)
		// does not honour that registration today, so nothing sets
		// `state.saveOptions` for zizmor at runtime. Set directly here, same
		// shape as SAVE-RESCAN-EXPECTED above, to prove the counting side of
		// the #3548 fix independent of the unbuilt dynamic-capability wiring.
		const scanner = armOpengrep("/project", "zizmor");
		scanner.state.saveOptions = { includeText: true };
		const file = "/project/.github/workflows/ci.yml";
		const counts = () =>
			publicationCountsForPath(scanner.state, normalizeMapKey(file));
		await handleNotifyOpen(scanner.state, file, "a", "yaml", false, true, true);
		expect(didSaves(scanner)).toBe(1);
		expect(counts()).toEqual({ sent: 2, published: 0 });
	});

	it("REPLAY-REOPEN-INFLIGHT: a scan queued before a close cannot answer the reopened file's send (#3482 lifetime)", async () => {
		await surplusReplay("reopen-inflight", async ({ scanner, file, turn }) => {
			await touchAndMark(scanner, file, V1, Date.now() - 20_000);
			// #3477: renamed away while v1's scan runs, then back with v2 (a fresh
			// didOpen, a new open lifetime).
			await closeDocument(scanner.state, file);
			await touchAndMark(scanner, file, V2, Date.now() - 10_000);
			scanner.publish(file, [diag(11, "V1-ONLY finding on line 12")]);

			const first = await turn();
			expect(first.content).not.toContain("V1-ONLY");
			expect(first.metadata).toMatchObject({ delivered: 0, backlogPending: 1 });

			scanner.publish(file, [diag(0, "V2 finding on line 1")]);
			expect((await turn()).content).toContain("V2 finding on line 1");
		});
	});

	it("REPLAY-CLOSE-PUBLISH-INFLIGHT: typos' close-triggered publish cannot answer an in-flight scan, so the reopened file's send is still owed one (#3548)", async () => {
		await surplusReplay(
			"close-publish-inflight",
			async ({ scanner, file, turn }) => {
				await touchAndMark(scanner, file, V1, Date.now() - 20_000);
				// #3477: renamed away while v1's scan runs. typos' did_close
				// publishes an empty, version-less set unconditionally, landing
				// before v1's real (slower) scan finishes.
				await closeDocument(scanner.state, file);
				scanner.publish(file, []);
				// Renamed back with v2 (a fresh didOpen, a new open lifetime).
				await touchAndMark(scanner, file, V2, Date.now() - 10_000);
				// v1's real, stale scan finally lands.
				scanner.publish(file, [diag(11, "V1-ONLY finding on line 12")]);

				const first = await turn();
				expect(first.content).not.toContain("V1-ONLY");
				expect(first.metadata).toMatchObject({
					delivered: 0,
					backlogPending: 1,
				});

				scanner.publish(file, [diag(0, "V2 finding on line 1")]);
				expect((await turn()).content).toContain("V2 finding on line 1");
			},
			"typos",
		);
	});

	it("REPLAY-CLOSE-PUBLISH-CREDIT-LEAK: a skip credit from one close cannot swallow a genuine backlog finding across a second close (#3548 review r1 B1)", async () => {
		await surplusReplay(
			"close-publish-credit-leak",
			async ({ scanner, file, turn }) => {
				// Close #1: typos owes one close-triggered publish. The reopen
				// below happens before it ever arrives, so (leaked) the credit
				// is never spent and (fixed) is discarded rather than carried.
				await closeDocument(scanner.state, file);
				await touchAndMark(scanner, file, V1, Date.now() - 30_000);
				// Close #2: typos owes ANOTHER close-triggered publish, for
				// THIS close.
				await closeDocument(scanner.state, file);
				// typos' own close-triggered publish for close #2 arrives,
				// spending exactly the credit THIS close granted.
				scanner.publish(file, []);
				// A GENUINE backlog finding — the real, late answer this pair's
				// mark is actually waiting on — arrives while still closed.
				// Leaked, the leftover credit from close #1 swallows it too;
				// fixed, there is no credit left and it counts.
				scanner.publish(file, [diag(11, "REAL-FINDING")]);
				await touchAndMark(scanner, file, V2, Date.now() - 10_000);

				const first = await turn();
				expect(first.content).not.toContain("REAL-FINDING");
				expect(first.metadata).toMatchObject({
					delivered: 0,
					backlogPending: 1,
				});

				// v2's real answer lands. Fixed, this is the last publish the
				// mark needed (REAL-FINDING already counted) and it delivers.
				// Leaked, REAL-FINDING's lost count means the mark still needs
				// ONE MORE publish than this ever supplies — permanently stuck,
				// re-armed every turn, never delivered.
				scanner.publish(file, [diag(0, "V2 finding on line 1")]);
				const second = await turn();
				expect(second.metadata).toMatchObject({
					delivered: 1,
					backlogPending: 0,
				});
				expect(second.content).toContain("V2 finding on line 1");
			},
			"typos",
		);
	});

	it("REPLAY-REOPEN-DROPPED-WHILE-CLOSED: a scan that publishes while the path is closed still counts, so the reopened file's answer is delivered (#3482 lifetime inverse)", async () => {
		await surplusReplay("reopen-dropped", async ({ scanner, file, turn }) => {
			await touchAndMark(scanner, file, V1, Date.now() - 20_000);
			await closeDocument(scanner.state, file);
			scanner.publish(file, [diag(11, "V1-ONLY finding on line 12")]);
			expect(scanner.state.pushDiagnostics.has(normalizeMapKey(file))).toBe(
				false,
			);
			await touchAndMark(scanner, file, V2, Date.now() - 10_000);
			scanner.publish(file, [diag(0, "V2 finding on line 1")]);

			const first = await turn();
			expect(first.content).toContain("V2 finding on line 1");
			expect(first.metadata).toMatchObject({ delivered: 1, backlogPending: 0 });
		});
	});

	it("REPLAY-RULES-REFRESHED-ACROSS-REOPEN: the refresh take-back survives a close and reopen, so the republish cannot answer the reopened file's send (#3482 lifetime, #3513 residual 4)", async () => {
		await surplusReplay("refresh-reopen", async ({ scanner, file, turn }) => {
			scanner.rulesRefreshed();
			await closeDocument(scanner.state, file);
			await touchAndMark(scanner, file, V2, Date.now() - 10_000);
			// The refresh republish for v0 lands after the reopen.
			scanner.publish(file, [diag(11, "V0 REPUBLISH finding on line 12")]);

			const first = await turn();
			expect(first.content).not.toContain("V0 REPUBLISH");
			expect(first.metadata).toMatchObject({ delivered: 0, backlogPending: 1 });

			scanner.publish(file, [diag(0, "V2 finding on line 1")]);
			expect((await turn()).content).toContain("V2 finding on line 1");
		});
	});

	it("REPLAY-RESYNC-DROPS-PENDING-RECEIPT: a receipt the resync clear drops still counts, so v2 is delivered (#3482 r1 F2)", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-resync-drop-") as any;
		const sessionId = "late-aux-resync-drop";
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "scanned.ts");
			const scanner = armOpengrep(env.tmpDir);
			readCachedDiagnosticsForServers.mockImplementation(
				cachedFrom(scanner.state, file),
			);
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				await touchAndMark(scanner, file, V1, Date.now() - 20_000);
				// v1's scan answers, but touch 2's resync clears it inside the
				// 250 ms debounce, before it is stored.
				scanner.receive(file, [diag(11, "V1-ONLY finding on line 12")]);
				await touchAndMark(scanner, file, V2, Date.now() - 10_000);
				scanner.receive(file, [diag(0, "V2 CURRENT finding")]);
				vi.advanceTimersByTime(300);
			} finally {
				vi.useRealTimers();
			}

			const first = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(first.content).toContain("V2 CURRENT finding");
			expect(first.metadata).toMatchObject({ delivered: 1, backlogPending: 0 });
		} finally {
			env.cleanup();
		}
	});

	it("REPLAY-DEBOUNCE-COALESCES-TWO-SCANS: two receipts inside one debounce window count twice, so v2 is delivered (#3482 r1 F2)", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-coalesce-") as any;
		const sessionId = "late-aux-coalesce";
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "scanned.ts");
			const scanner = armOpengrep(env.tmpDir);
			readCachedDiagnosticsForServers.mockImplementation(
				cachedFrom(scanner.state, file),
			);
			await touchAndMark(scanner, file, V1, Date.now() - 20_000);
			await touchAndMark(scanner, file, V2, Date.now() - 10_000);
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				// Both queued scans answer after touch 2, 100 ms apart: the second
				// receipt replaces the first's debounce timer, one store.
				scanner.receive(file, [diag(11, "V1-ONLY finding on line 12")]);
				vi.advanceTimersByTime(100);
				scanner.receive(file, [diag(0, "V2 CURRENT finding")]);
				vi.advanceTimersByTime(300);
			} finally {
				vi.useRealTimers();
			}

			const first = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(first.content).toContain("V2 CURRENT finding");
			expect(first.content).not.toContain("V1-ONLY");
			expect(first.metadata).toMatchObject({ delivered: 1, backlogPending: 0 });
		} finally {
			env.cleanup();
		}
	});

	it("REPLAY-SUPERSEDED-VERSIONED-PUSH: a versioned answer dropped as superseded still counts, so v2 is delivered (#3482 r2)", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-superseded-") as any;
		const sessionId = "late-aux-superseded";
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "scanned.ts");
			const scanner = armOpengrep(env.tmpDir);
			readCachedDiagnosticsForServers.mockImplementation(
				cachedFrom(scanner.state, file),
			);
			// A versioned scanner (ast-grep publishes document versions): v0 is
			// opened and answered, then v1 and v2 are sent before v1's answer.
			writeAt(file, "export const v = 0;\n", Date.now() - 30_000);
			await handleNotifyOpen(
				scanner.state,
				file,
				"export const v = 0;\n",
				"ts",
				false,
				true,
			);
			scanner.publishVersioned(file, 0, [diag(0, "V0 finding")]);
			await touchAndMark(scanner, file, V1, Date.now() - 20_000);
			await touchAndMark(scanner, file, V2, Date.now() - 10_000);
			// v1's answer lands after v2 was sent: dropped as superseded, never
			// stored. v2's answer is stored.
			scanner.publishVersioned(file, 1, [
				diag(11, "V1-ONLY finding on line 12"),
			]);
			scanner.publishVersioned(file, 2, [diag(0, "V2 CURRENT finding")]);

			const first = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(first.content).toContain("V2 CURRENT finding");
			expect(first.content).not.toContain("V1-ONLY");
			expect(first.metadata).toMatchObject({ delivered: 1, backlogPending: 0 });
		} finally {
			env.cleanup();
		}
	});

	it("REPLAY-SUPERSEDED-SEEDED-PUSH: on a seed-first-push server the superseded answer still counts (#3482 r2)", async () => {
		const env = setupTestEnvironment(
			"pi-lens-late-aux-superseded-seed-",
		) as any;
		const sessionId = "late-aux-superseded-seed";
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "scanned.ts");
			// eslint seeds its first push after a clear: the SEED path, not the debounce.
			const scanner = armOpengrep(env.tmpDir, "eslint");
			readCachedDiagnosticsForServers.mockImplementation(
				cachedFrom(scanner.state, file),
			);
			// A versioned scanner (ast-grep publishes document versions): v0 is
			// opened and answered, then v1 and v2 are sent before v1's answer.
			writeAt(file, "export const v = 0;\n", Date.now() - 30_000);
			await handleNotifyOpen(
				scanner.state,
				file,
				"export const v = 0;\n",
				"ts",
				false,
				true,
			);
			scanner.publishVersioned(file, 0, [diag(0, "V0 finding")]);
			await touchAndMark(scanner, file, V1, Date.now() - 20_000);
			await touchAndMark(scanner, file, V2, Date.now() - 10_000);
			// v1's answer lands after v2 was sent: dropped as superseded, never
			// stored. v2's answer is stored.
			scanner.publishVersioned(file, 1, [
				diag(11, "V1-ONLY finding on line 12"),
			]);
			scanner.publishVersioned(file, 2, [diag(0, "V2 CURRENT finding")]);

			const first = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(first.content).toContain("V2 CURRENT finding");
			expect(first.content).not.toContain("V1-ONLY");
			expect(first.metadata).toMatchObject({ delivered: 1, backlogPending: 0 });
		} finally {
			env.cleanup();
		}
	});

	it("REPLAY-RETOUCH-REMARK: withholds v1's publish after a re-touch re-marks, then delivers v2's", async () => {
		const env = setupTestEnvironment("pi-lens-late-aux-retouch-") as any;
		const sessionId = "late-aux-retouch";
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "scanned.ts");
			const scanner = armOpengrep(env.tmpDir);
			readCachedDiagnosticsForServers.mockImplementation(
				cachedFrom(scanner.state, file),
			);

			// Touch 1 sends v1 (20 lines); its grace lapses and marks the pair.
			const v1 = Array.from({ length: 20 }, (_, i) => `const a${i} = ${i};`);
			writeAt(file, `${v1.join("\n")}\n`, Date.now() - 20_000);
			await handleNotifyOpen(
				scanner.state,
				file,
				v1.join("\n"),
				"ts",
				false,
				true,
			);
			markPendingAuxiliaryCoverage(
				file,
				["opengrep"],
				Date.now() - 20_000,
				undefined,
				undefined,
				captureAuxPublicationBacklog(scanner.client, file),
			);
			// Touch 2: the agent edits to a one-line v2 while v1's scan runs. The
			// resync clears, sends v2, finds no evidence and re-marks.
			writeAt(file, "export const v = 2;\n", Date.now() - 10_000);
			await handleNotifyOpen(
				scanner.state,
				file,
				"export const v = 2;\n",
				"ts",
				false,
				true,
			);
			markPendingAuxiliaryCoverage(
				file,
				["opengrep"],
				Date.now() - 10_000,
				undefined,
				undefined,
				captureAuxPublicationBacklog(scanner.client, file),
			);
			// v1's scan publishes, with no version, after the re-mark.
			scanner.publish(file, [diag(11, "V1-ONLY finding on line 12")]);

			const first = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(first.content).not.toContain("V1-ONLY");
			expect(first.metadata).toMatchObject({
				delivered: 0,
				rearmed: 1,
				backlogPending: 1,
			});
			// The re-arm carries the binding: a second turn end still withholds it.
			const second = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(second.content).not.toContain("V1-ONLY");
			expect(second.metadata).toMatchObject({
				delivered: 0,
				backlogPending: 1,
			});

			// v2's own scan publishes: the binding releases and v2's finding lands.
			scanner.publish(file, [diag(0, "V2 finding on line 1")]);
			const third = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(third.content).toContain("V2 finding on line 1");
			expect(third.content).not.toContain("V1-ONLY");
			expect(third.metadata).toMatchObject({ delivered: 1, backlogPending: 0 });
		} finally {
			env.cleanup();
		}
	});

	it("keeps the baseline on a stale re-arm, so a later publish cannot absorb an external edit", async () => {
		// FixRefreshOnStale: the stale verdict used to re-arm with a baseline of
		// "now", which moved past the external edit's mtime; an older queued scan
		// that published afterwards then passed both the publishedAt and mtime
		// gates against content it never saw.
		const env = setupTestEnvironment("pi-lens-late-aux-stale-keep-") as any;
		const sessionId = "late-aux-stale-keep";
		try {
			process.env.PI_LENS_LATE_AUX_REARM_TTL_MS = "600000";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);
			const file = path.join(env.tmpDir, "src", "external.ts");
			// Marked at the touch's notify; an external edit lands afterwards.
			markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 20_000);
			writeAt(file, "export const external = 1;\n", Date.now() - 10_000);
			readCachedDiagnosticsForServers.mockImplementation(
				async () =>
					new Map([
						[
							"opengrep",
							{
								diags: [diag(4, "SCANNED-BEFORE-EDIT")],
								publishedAt: Date.now() - 5_000,
							},
						],
					]),
			);
			const first = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(first.content).not.toContain("SCANNED-BEFORE-EDIT");
			expect(first.metadata).toMatchObject({ delivered: 0, rearmed: 1 });
			expect(first.metadata.stale).toBeGreaterThan(0);

			// An older queued scan publishes after that drain.
			const laterPublish = Date.now() + 1;
			readCachedDiagnosticsForServers.mockImplementation(
				async () =>
					new Map([
						[
							"opengrep",
							{
								diags: [diag(4, "QUEUED-OLDER-SCAN")],
								publishedAt: laterPublish,
							},
						],
					]),
			);
			const second = await turnEnd(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				file,
			);
			expect(second.content).not.toContain("QUEUED-OLDER-SCAN");
			expect(second.metadata).toMatchObject({ delivered: 0 });
			expect(second.metadata.stale).toBeGreaterThan(0);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #3102 member 1. This advisory rendered raw LSP findings with no stored
 * disposition filter, no `.pi-lens.json` rule policy and no inline
 * `pi-lens-ignore` suppression — so a finding the agent marked
 * `false-positive` re-reported on every turn that drained a late pair, while
 * `mode=delta`/`mode=full`/the per-edit dispatcher and (since #3088) the
 * `source=lsp` probe lane all hid it. It also converted with a hardcoded
 * `tool: "lsp"`, so the identity a mark anchors on — `opengrep`, the
 * auxiliary's real tool id on every other surface — never matched this one
 * (#3046/#3047).
 *
 * Every case drives the production `handleTurnEnd` drain against a real mark
 * written by the production `lens_diagnostic_mark` tool.
 */
describe("turn-end late-auxiliary advisory applies the finding policy (#3102)", () => {
	const MARKED = "late finding the agent dismissed";
	const OTHER = "late finding nobody marked";
	/** Two lines, so the marked finding's STRICT anchor hashes real content and
	 * the unmarked sibling keeps the absence assertion from passing vacuously. */
	const BODY = "const marked = 1;\nconst other = 2;\n";
	/** The spelling every OTHER surface renders once `retagAuxiliaryDiagnostics`
	 * gives the auxiliary its real tool id — and therefore the spelling of a
	 * mark made from the widget, `mode=full` or `mode=delta`. */
	const CANONICAL_MARK = { tool: "opengrep", rule: "opengrep:rule-x" };

	function otherDiag(line: number): LSPDiagnostic {
		return { ...diag(line, OTHER), code: "rule-y" };
	}

	async function mark(cwd: string, params: Record<string, unknown>) {
		const markTool = createLensDiagnosticMarkTool(() => cwd);
		return markTool.execute("mark-3102", params, undefined, () => {}, { cwd });
	}

	/** One production turn_end drain over a single late pair carrying `diags`,
	 * returning the advisory text the agent would receive. */
	async function drain(
		env: { tmpDir: string },
		file: string,
		diags: LSPDiagnostic[],
	): Promise<string> {
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: "late-aux-3102" });
		runtime.beginTurn();
		const cacheManager = new CacheManager(false);
		cacheManager.addModifiedRange(
			file,
			{ start: 1, end: 1 },
			false,
			env.tmpDir,
			"late-aux-3102",
		);
		markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 2000);
		readCachedDiagnosticsForServers.mockImplementation(
			async (_p: string, serverIds: ReadonlySet<string>) => {
				const out = new Map<
					string,
					{ diags: LSPDiagnostic[]; publishedAt: number }
				>();
				if (serverIds.has("opengrep"))
					out.set("opengrep", { diags, publishedAt: Date.now() });
				return out;
			},
		);
		await handleTurnEnd(makeDeps(runtime, cacheManager, env.tmpDir));
		return turnEndContent(cacheManager, env.tmpDir);
	}

	/** A temp project whose scanned file is written with `body` and pinned 10s
	 * in the past, so the freshness gate reports it live against the mark. */
	function setup(body = BODY) {
		const env = setupTestEnvironment("pi-lens-3102-late-aux-") as any;
		const file = path.join(env.tmpDir, "scanned.ts");
		fs.writeFileSync(file, body);
		const past = new Date(Date.now() - 10_000);
		fs.utimesSync(file, past, past);
		_resetDeferredForTests();
		_resetStateCacheForTests();
		return { env, file };
	}

	it("premise: both findings reach the agent before anything is marked", async () => {
		const { env, file } = setup();
		try {
			const content = await drain(env, file, [diag(0, MARKED), otherDiag(1)]);
			expect(content).toContain("Late auxiliary diagnostics");
			expect(content).toContain(MARKED);
			expect(content).toContain(OTHER);
		} finally {
			_resetStateCacheForTests();
			env.cleanup();
		}
	});

	it("drops a finding marked false-positive under the auxiliary's real tool id", async () => {
		const { env, file } = setup();
		try {
			const marked = await mark(env.tmpDir, {
				filePath: file,
				line: 1,
				message: MARKED,
				...CANONICAL_MARK,
				disposition: "false-positive",
			});
			expect(marked.isError).toBeFalsy();

			const content = await drain(env, file, [diag(0, MARKED), otherDiag(1)]);
			expect(content).not.toContain(MARKED);
			expect(content).toContain(OTHER);
		} finally {
			_resetStateCacheForTests();
			env.cleanup();
		}
	});

	it("drops a finding marked from the advisory's own rendering, which prints no tool", async () => {
		// The advisory line is `file:line:col [rule] message` — no tool for the
		// agent to pass on, and `lens_diagnostic_mark`'s `tool` is optional.
		const { env, file } = setup();
		try {
			const marked = await mark(env.tmpDir, {
				filePath: file,
				line: 1,
				message: MARKED,
				rule: "opengrep:rule-x",
				disposition: "false-positive",
			});
			expect(marked.isError).toBeFalsy();

			const content = await drain(env, file, [diag(0, MARKED), otherDiag(1)]);
			expect(content).not.toContain(MARKED);
			expect(content).toContain(OTHER);
		} finally {
			_resetStateCacheForTests();
			env.cleanup();
		}
	});

	it("drops a rule the project disabled in .pi-lens.json", async () => {
		const { env, file } = setup();
		try {
			fs.writeFileSync(
				path.join(env.tmpDir, ".pi-lens.json"),
				JSON.stringify({
					rules: { security: { disable: ["opengrep:rule-x"] } },
				}),
			);
			const content = await drain(env, file, [diag(0, MARKED), otherDiag(1)]);
			expect(content).not.toContain(MARKED);
			expect(content).toContain(OTHER);
		} finally {
			_resetStateCacheForTests();
			env.cleanup();
		}
	});

	it("drops a finding an inline pi-lens-ignore comment suppresses", async () => {
		// The comment is line 1; the suppressed finding is on line 2.
		const { env, file } = setup(
			"// pi-lens-ignore: opengrep:rule-x\nconst marked = 1;\nconst other = 2;\n",
		);
		try {
			const content = await drain(env, file, [diag(1, MARKED), otherDiag(2)]);
			expect(content).not.toContain(MARKED);
			expect(content).toContain(OTHER);
		} finally {
			_resetStateCacheForTests();
			env.cleanup();
		}
	});

	it("honors the auxiliary's own native nosemgrep suppression", async () => {
		const { env, file } = setup(
			"const marked = 1; // nosemgrep: rule-x\nconst other = 2;\n",
		);
		try {
			const content = await drain(env, file, [diag(0, MARKED), otherDiag(1)]);
			expect(content).not.toContain(MARKED);
			expect(content).toContain(OTHER);
			expect(lateAuxRecord()?.metadata).toMatchObject({ auxSuppressed: 1 });
		} finally {
			_resetStateCacheForTests();
			env.cleanup();
		}
	});

	it("says nothing at all when every late finding was suppressed", async () => {
		const { env, file } = setup();
		try {
			await mark(env.tmpDir, {
				filePath: file,
				line: 1,
				message: MARKED,
				...CANONICAL_MARK,
				disposition: "false-positive",
			});
			const content = await drain(env, file, [diag(0, MARKED)]);
			expect(content).not.toContain("Late auxiliary diagnostics");
			expect(lateAuxRecord()?.metadata).toMatchObject({
				delivered: 0,
				dispositionSuppressed: 1,
			});
		} finally {
			_resetStateCacheForTests();
			env.cleanup();
		}
	});

	it("states the drop count on the delivery and in the bounded turn record", async () => {
		const { env, file } = setup();
		try {
			await mark(env.tmpDir, {
				filePath: file,
				line: 1,
				message: MARKED,
				...CANONICAL_MARK,
				disposition: "false-positive",
			});
			const content = await drain(env, file, [diag(0, MARKED), otherDiag(1)]);
			expect(content).toContain("suppressed by disposition: 1 finding(s)");
			expect(lateAuxRecord()?.metadata).toMatchObject({
				delivered: 1,
				dispositionSuppressed: 1,
			});
		} finally {
			_resetStateCacheForTests();
			env.cleanup();
		}
	});

	it("keeps findings visible when the cited file cannot be read (fail open)", async () => {
		// A weak-anchored mark would still apply without content; a STRICT
		// false-positive anchor must not, so an unreadable file leaves the
		// finding VISIBLE rather than hiding it on an I/O error (shape 48).
		// Replacing the file with a directory keeps the stat (the freshness gate
		// passes) while the read fails.
		const { env, file } = setup();
		try {
			await mark(env.tmpDir, {
				filePath: file,
				line: 1,
				message: MARKED,
				...CANONICAL_MARK,
				disposition: "false-positive",
			});
			fs.rmSync(file);
			fs.mkdirSync(file);
			const past = new Date(Date.now() - 10_000);
			fs.utimesSync(file, past, past);

			const content = await drain(env, file, [diag(0, MARKED)]);
			expect(content).toContain(MARKED);
		} finally {
			_resetStateCacheForTests();
			env.cleanup();
		}
	});
});
