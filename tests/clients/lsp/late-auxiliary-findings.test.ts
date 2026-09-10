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
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../../clients/runtime-turn.js";
import {
	drainPendingAuxiliaryCoverage,
	markPendingAuxiliaryCoverage,
	MAX_LATE_AUX_REARMS,
	pendingAuxiliaryCoverageSize,
	readLateAuxRearmTtlMs,
	resetPendingAuxiliaryCoverage,
} from "../../../clients/lsp/pending-aux-coverage.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
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
			let fastStreak = 0;
			let auxWaitsAfterFive = 5;
			let repromoted = false;
			observeLateAuxiliaryAnswer.mockImplementation(
				async (_filePath: string, _serverId: string, elapsedMs: number) => {
					if (elapsedMs < 750) {
						fastStreak += 1;
						if (fastStreak === 5) {
							auxWaitsAfterFive = 6;
							repromoted = true;
						}
					}
				},
			);
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
			expect(auxWaitsAfterFive).toBe(6);
			expect(repromoted).toBe(true);
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
			// turn's freshness gate sees it as edited-after-the-scan (stale),
			// independent of how many times the pair's baseline gets refreshed
			// by the stale-path re-arm (which stamps a fresh `markedAtMs`).
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
