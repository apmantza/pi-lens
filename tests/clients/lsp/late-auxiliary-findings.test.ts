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

const readCachedDiagnosticsForServers = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/lsp/index.js", () => ({
	// Only `getLSPService` crosses this seam in handleTurnEnd's import graph.
	getLSPService: () => ({ readCachedDiagnosticsForServers }),
}));

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

import { CacheManager } from "../../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../../clients/runtime-coordinator.js";
import { handleTurnEnd } from "../../../clients/runtime-turn.js";
import {
	drainPendingAuxiliaryCoverage,
	markPendingAuxiliaryCoverage,
	readLateAuxRearmTtlMs,
	resetPendingAuxiliaryCoverage,
} from "../../../clients/lsp/pending-aux-coverage.js";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import { setupTestEnvironment } from "../test-utils.js";

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
	logLatency.mockClear();
	resetPendingAuxiliaryCoverage();
});

afterEach(() => {
	resetPendingAuxiliaryCoverage();
	delete process.env.PI_LENS_LATE_AUX_REARM_TTL_MS;
});

describe("turn-end late-auxiliary findings (#2001/#2002)", () => {
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
					const out = new Map<string, LSPDiagnostic[]>();
					if (serverIds.has("opengrep"))
						out.set("opengrep", [diag(4, "late finding body")]);
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
				async () => new Map([["opengrep", [diag(0, "should not appear")]]]),
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
					new Map([["opengrep", [diag(0, "finding for deleted file")]]]),
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
				async () => new Map([["opengrep", []]]),
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
				async () => new Map([["opengrep", []]]),
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
				async () => new Map([["opengrep", []]]),
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
});
