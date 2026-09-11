/**
 * Turn-end integration for the dependency-drift delivery cap (#1950).
 *
 * #1631's freshness gate demotes a blocker whose dependency drifted to a
 * `[stale — re-run to confirm]` advisory (demote, not drop — #1419), and
 * #1949 gave that demotion the shared degradation-ledger body, but
 * deliberately did NOT retire it: the cited coordinates are still in bounds,
 * so a fresh dispatch can genuinely confirm or clear it. Nothing capped how
 * many times the SAME demoted record kept re-serving, though — incident data
 * showed 18 `alreadyStale` re-serves in one window with near-zero
 * information after the first delivery.
 *
 * This drives the real `handleTurnEnd` across several turns and asserts:
 *   1. The demotion re-serves, unretired, below the delivery cap.
 *   2. At the cap (`DEPENDENCY_DRIFT_MAX_DELIVERIES`), the record retires
 *      with a note that says the OPPOSITE of #1944's past-EOF retirement —
 *      "re-run can still confirm", not "cannot be re-confirmed".
 *   3. After retirement, the record is gone from the store and never
 *      resurfaces.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { DEPENDENCY_DRIFT_MAX_DELIVERIES } from "../../clients/blocker-freshness.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function makeTurnEndDeps(
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
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as any;
}

function readTurnEndContent(cacheManager: CacheManager, cwd: string): string {
	return (
		cacheManager.readCache<{ content: string }>("turn-end-findings", cwd)?.data
			?.content ?? ""
	);
}

/**
 * Drive one more turn with activity so `handleTurnEnd` doesn't early-return
 * on "no modified files this turn" (same requirement blocker-past-eof-turn-end
 * uses for its multi-turn case).
 *
 * Also touches a per-turn NOISE file (`noise-<turn>.ts`) alongside `consumer`.
 * Fix-round F1: `handleTurnEnd`'s `turn-end-findings-last` signature dedupe
 * suppresses a turn whose rendered content is byte-identical to the last one
 * DELIVERED — and the demoted blocker's own body renders identically turn to
 * turn until the cap note appears, so without something else varying in the
 * signature (the touched-file set, here), every turn after the first would
 * suppress forever and the cap would never be reached. A stable, single-file,
 * single-finding turn is exactly the shape #1950's own incident data showed
 * causing repeat SILENT suppression in production — this noise file stands
 * in for "something else about the turn differs", which is the common case.
 */
function driveTurn(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	consumer: string,
	cwd: string,
	sessionId: string,
	turn: number,
): Promise<void> {
	runtime.beginTurn();
	runtime.bumpFileSeq(consumer);
	cacheManager.addModifiedRange(
		consumer,
		{ start: 1, end: 2 },
		false,
		cwd,
		sessionId,
	);
	const noise = path.join(cwd, `noise-${turn}.ts`);
	fs.writeFileSync(noise, `export const noise${turn} = ${turn};\n`);
	runtime.bumpFileSeq(noise);
	cacheManager.addModifiedRange(
		noise,
		{ start: 1, end: 1 },
		false,
		cwd,
		sessionId,
	);
	return handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
}

afterEach(() => {
	cancelLSPIdleReset();
	resetDegradationLedger();
	logLatency.mockClear();
});

describe("dependency-drift delivery cap (#1950)", () => {
	it(`retires after ${DEPENDENCY_DRIFT_MAX_DELIVERIES} deliveries, with a "still confirmable" note, not #1944's "unrecoverable" one`, async () => {
		const env = setupTestEnvironment("pi-lens-1950-cap-");
		try {
			const sessionId = "cap-session";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const consumer = path.join(env.tmpDir, "consumer.ts");
			const dep = path.join(env.tmpDir, "dep.ts");
			fs.writeFileSync(dep, "export const other = 1;\n");
			fs.writeFileSync(
				consumer,
				'import { other } from "./dep.js";\nexport const t = other;\n',
			);

			runtime.bumpFileSeq(consumer);
			cacheManager.addModifiedRange(
				consumer,
				{ start: 1, end: 2 },
				false,
				env.tmpDir,
				sessionId,
			);
			runtime.recordInlineBlockers(consumer, "🔴 L1 a real blocker", 1, [
				"lsp",
			]);

			// The dependency drifts out-of-band after the verdict.
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(dep, future, future);

			// Turn 1: the sweep detects drift and demotes; the SAME turn's
			// delivery loop serves the fresh demotion (delivery 1 of the cap).
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));
			let content = readTurnEndContent(cacheManager, env.tmpDir);
			expect(content).toContain("[stale — re-run to confirm]");
			expect(content).not.toContain("Not shown again after");
			// Fix-round F1: assert the ACTUAL delivery count directly off the
			// store, not off `turn-end-findings`'s cached content — a turn whose
			// content the signature dedupe suppresses leaves that cache holding
			// the PREVIOUS turn's content, which would make a content-only
			// assertion pass even for a turn that never reached the agent.
			let snapshot = runtime.getInlineBlockersSnapshot();
			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]?.staleDeliveryCount).toBe(1);

			// Turns 2..cap-1: re-served, still not retired, count advancing by
			// exactly one PER DELIVERED turn.
			for (
				let delivery = 2;
				delivery < DEPENDENCY_DRIFT_MAX_DELIVERIES;
				delivery++
			) {
				await driveTurn(
					runtime,
					cacheManager,
					consumer,
					env.tmpDir,
					sessionId,
					delivery,
				);
				content = readTurnEndContent(cacheManager, env.tmpDir);
				expect(content).toContain("[stale — re-run to confirm]");
				expect(content).not.toContain("Not shown again after");
				snapshot = runtime.getInlineBlockersSnapshot();
				expect(snapshot).toHaveLength(1);
				expect(snapshot[0]?.staleDeliveryCount).toBe(delivery);
			}

			// The delivery that reaches the cap retires the record.
			await driveTurn(
				runtime,
				cacheManager,
				consumer,
				env.tmpDir,
				sessionId,
				DEPENDENCY_DRIFT_MAX_DELIVERIES,
			);
			content = readTurnEndContent(cacheManager, env.tmpDir);
			expect(content).toContain("[stale — re-run to confirm]");
			expect(content).toContain(
				`Not shown again after ${DEPENDENCY_DRIFT_MAX_DELIVERIES} deliveries`,
			);
			// #1950 vs #1944: the wording must NOT claim the finding is
			// unconfirmable — it may still be accurate.
			expect(content).not.toContain("cannot be re-confirmed");
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);

			expect(getDegradationSummary()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "demoted-finding-retired",
						latestReasons: expect.arrayContaining([
							expect.objectContaining({
								reason: expect.stringContaining("re-run can still confirm"),
							}),
						]),
					}),
				]),
			);

			// A further turn has nothing left to re-serve: the record never
			// resurfaces once retired (proven directly against the store rather
			// than the cache, since an empty turn-end result may leave the prior
			// cache entry untouched — a caching detail orthogonal to this fix).
			await driveTurn(
				runtime,
				cacheManager,
				consumer,
				env.tmpDir,
				sessionId,
				DEPENDENCY_DRIFT_MAX_DELIVERIES + 1,
			);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("does not advance the delivery count on a turn the signature dedupe suppresses (F1)", async () => {
		const env = setupTestEnvironment("pi-lens-1950-suppressed-");
		try {
			const sessionId = "suppressed-session";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const consumer = path.join(env.tmpDir, "consumer.ts");
			const dep = path.join(env.tmpDir, "dep.ts");
			fs.writeFileSync(dep, "export const other = 1;\n");
			fs.writeFileSync(
				consumer,
				'import { other } from "./dep.js";\nexport const t = other;\n',
			);

			runtime.bumpFileSeq(consumer);
			cacheManager.addModifiedRange(
				consumer,
				{ start: 1, end: 2 },
				false,
				env.tmpDir,
				sessionId,
			);
			runtime.recordInlineBlockers(consumer, "🔴 L1 a real blocker", 1, [
				"lsp",
			]);
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(dep, future, future);

			// Turn 1: demoted and delivered — count becomes 1.
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));
			expect(runtime.getInlineBlockersSnapshot()[0]?.staleDeliveryCount).toBe(
				1,
			);
			const turn1Content = readTurnEndContent(cacheManager, env.tmpDir);

			// Turn 2: re-touch the SAME consumer with no other change — the
			// rendered advisory is byte-identical to turn 1's (the count driving
			// it hasn't moved and stays below the cap note threshold), so
			// `turn-end-findings-last`'s signature dedupe suppresses it. The
			// cached content therefore stays turn 1's, unchanged.
			runtime.beginTurn();
			runtime.bumpFileSeq(consumer);
			cacheManager.addModifiedRange(
				consumer,
				{ start: 1, end: 2 },
				false,
				env.tmpDir,
				sessionId,
			);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));

			// The count must NOT have advanced: this turn was never delivered.
			expect(runtime.getInlineBlockersSnapshot()[0]?.staleDeliveryCount).toBe(
				1,
			);
			expect(readTurnEndContent(cacheManager, env.tmpDir)).toBe(turn1Content);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #2982 review, the blocking finding. Self-drift demotion must not inherit the
 * dependency-drift delivery cap: that cap retires a record permanently after
 * DEPENDENCY_DRIFT_MAX_DELIVERIES stale deliveries, and it was designed for
 * recoverable LSP dependency drift. A self-drift record can carry ast-grep or
 * tree-sitter security provenance, so walking one out of turn-end rendering
 * because an advisory was shown three times is not a policy this gate applies.
 *
 * Drives the real `handleTurnEnd` across more turns than the cap.
 */
describe("self-drift is outside the delivery cap (#2982)", () => {
	it("an mtime-only move with unchanged bytes never demotes at all", async () => {
		const env = setupTestEnvironment("pi-lens-2982-touch-");
		try {
			const sessionId = "touch-session";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const target = path.join(env.tmpDir, "config.ts");
			fs.writeFileSync(target, "const token = 'aaa';\n");
			runtime.bumpFileSeq(target);
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				sessionId,
			);
			runtime.recordInlineBlockers(target, "🔴 hardcoded secret", 1, [
				"ast-grep",
			]);
			runtime.updateGitGuardStatus(true, "🔴 hardcoded secret");

			// `touch`: mtime forward, every byte where it was.
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(target, future, future);

			for (let turn = 1; turn <= DEPENDENCY_DRIFT_MAX_DELIVERIES + 2; turn++) {
				await driveTurn(
					runtime,
					cacheManager,
					target,
					env.tmpDir,
					sessionId,
					turn,
				);
				const snapshot = runtime.getInlineBlockersSnapshot();
				expect(snapshot).toHaveLength(1);
				expect(snapshot[0]?.stale).toBe(false);
			}
			// Still authoritative, never demoted, never retired.
			const content = readTurnEndContent(cacheManager, env.tmpDir);
			expect(content).not.toContain("[stale — re-run to confirm]");
			expect(runtime.gitGuardHasBlockers).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("a real content change demotes but is never retired by the cap", async () => {
		const env = setupTestEnvironment("pi-lens-2982-nocap-");
		try {
			const sessionId = "nocap-session";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const target = path.join(env.tmpDir, "config.ts");
			fs.writeFileSync(target, "const token = 'aaa';\n");
			runtime.bumpFileSeq(target);
			cacheManager.addModifiedRange(
				target,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
				sessionId,
			);
			runtime.recordInlineBlockers(target, "🔴 hardcoded secret", 1, [
				"ast-grep",
			]);
			runtime.updateGitGuardStatus(true, "🔴 hardcoded secret");

			// A real byte change that leaves the secret in place.
			fs.writeFileSync(target, "const token = 'aaa'; // moved\n");
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(target, future, future);

			for (let turn = 1; turn <= DEPENDENCY_DRIFT_MAX_DELIVERIES + 2; turn++) {
				await driveTurn(
					runtime,
					cacheManager,
					target,
					env.tmpDir,
					sessionId,
					turn,
				);
				const snapshot = runtime.getInlineBlockersSnapshot();
				// The record survives every turn past the cap boundary.
				expect(snapshot).toHaveLength(1);
				expect(snapshot[0]?.stale).toBe(true);
				expect(snapshot[0]?.staleReason).toBe("self-drift");
				// The cap's counter is never advanced for this reason.
				expect(snapshot[0]?.staleDeliveryCount ?? 0).toBe(0);
			}

			const content = readTurnEndContent(cacheManager, env.tmpDir);
			expect(content).not.toContain("Not shown again after");
			// And the commit gate still holds throughout.
			expect(runtime.gitGuardHasBlockers).toBe(true);
		} finally {
			env.cleanup();
		}
	});
});
