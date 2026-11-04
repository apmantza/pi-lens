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
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { DEPENDENCY_DRIFT_MAX_DELIVERIES } from "../../clients/blocker-freshness.js";
import { deferRunnerFindings } from "../../clients/dispatch/pending-runner-findings.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
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
 * #4921 review (CodeRabbit): the turn-end dedupe keys the turn's file set only
 * while a count-driven hold (the #1950 drift advisory) is IN the delivered
 * message. When the cap cuts that advisory away it stays pending and nothing
 * advanced, so the message is the whole identity. Recurrence this prevents: a
 * cut drift advisory kept the file set in the key, and an unchanged blocker
 * was re-delivered on every turn that wrote a different file.
 */
describe("a cut drift advisory does not key the dedupe on the file set (#4921)", () => {
	it("suppresses an identical capped message on a turn that writes a different file", async () => {
		const env = setupTestEnvironment("pi-lens-4921-cut-hold-");
		try {
			const sessionId = "cut-hold-session";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const consumer = path.join(env.tmpDir, "consumer.ts");
			const dep = path.join(env.tmpDir, "dep.ts");
			const live = path.join(env.tmpDir, "live.ts");
			fs.writeFileSync(dep, "export const other = 1;\n");
			fs.writeFileSync(
				consumer,
				'import { other } from "./dep.js";\nexport const t = other;\n',
			);
			fs.writeFileSync(live, "export const l = 1;\n");
			for (const file of [consumer, live]) {
				runtime.bumpFileSeq(file);
				cacheManager.addModifiedRange(
					file,
					{ start: 1, end: 2 },
					false,
					env.tmpDir,
					sessionId,
				);
			}
			// The live blocker alone overflows the 1000-char turn-end cap, so the
			// drift advisory (rendered after it) is cut and stays pending.
			runtime.recordInlineBlockers(
				live,
				`🔴 STOP — 1 issue(s) must be fixed:\n  L1: ${"x".repeat(1500)}`,
				1,
				["lsp"],
			);
			runtime.recordInlineBlockers(consumer, "🔴 L1 a drifted blocker", 1, [
				"lsp",
			]);
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(dep, future, future);

			const delivered: Array<string | undefined> = [];
			for (let turn = 1; turn <= 3; turn++) {
				await driveTurn(
					runtime,
					cacheManager,
					consumer,
					env.tmpDir,
					sessionId,
					turn,
				);
				// A request inside one prompt (#5240): the unchanged set stays staged for
				// the next prompt's first request, never re-sent here.
				const result = consumeTurnEndFindings(
					cacheManager,
					env.tmpDir,
					runtime,
					undefined,
					undefined,
					{ atPromptTail: false, blockersLive: true },
				);
				delivered.push(result ? JSON.stringify(result.messages) : undefined);
			}

			// Turn 1 delivers the capped blocker; the drift advisory was cut, so
			// its count never advanced.
			expect(delivered[0]).toContain("must be fixed");
			expect(runtime.getInlineBlockersSnapshot().length).toBe(2);
			expect(
				runtime
					.getInlineBlockersSnapshot()
					.every((entry) => (entry.staleDeliveryCount ?? 0) === 0),
			).toBe(true);
			// Turns 2 and 3 write other files but the message is the same.
			expect(delivered[1]).toBeUndefined();
			expect(delivered[2]).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #4921 verify F5: the opposite direction of the cut-hold case. A drift advisory
 * that LEADS the message and alone overflows the cap is delivered (the plan
 * counts it reached, so the #1950 count advances) although the capped content
 * holds only a prefix of it. The file set must stay in the key, or every later
 * turn is suppressed and the cap stalls at one delivery. Recurrence this
 * prevents: counts [1] -> [1] -> [1] and the record never retiring.
 */
describe("a leading oversized drift advisory still reaches the delivery cap (#4921)", () => {
	it("advances the count each delivered turn and retires the record", async () => {
		const env = setupTestEnvironment("pi-lens-4921-leading-hold-");
		try {
			const sessionId = "leading-hold-session";
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
			// The advisory is the whole message and exceeds the 1000-char cap.
			runtime.recordInlineBlockers(consumer, `🔴 L1 ${"x".repeat(1500)}`, 1, [
				"lsp",
			]);
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(dep, future, future);

			const counts: number[][] = [];
			const delivered: boolean[] = [];
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));
			delivered.push(
				consumeTurnEndFindings(cacheManager, env.tmpDir, runtime) !== undefined,
			);
			counts.push(
				runtime
					.getInlineBlockersSnapshot()
					.map((entry) => entry.staleDeliveryCount ?? 0),
			);
			for (let turn = 2; turn <= 3; turn++) {
				await driveTurn(
					runtime,
					cacheManager,
					consumer,
					env.tmpDir,
					sessionId,
					turn,
				);
				delivered.push(
					consumeTurnEndFindings(cacheManager, env.tmpDir, runtime) !==
						undefined,
				);
				counts.push(
					runtime
						.getInlineBlockersSnapshot()
						.map((entry) => entry.staleDeliveryCount ?? 0),
				);
			}
			// Each turn writes another file, so each is a new delivery; the third
			// reaches the cap and retires the record (the round-1 behaviour).
			expect(counts).toEqual([[1], [2], []]);
			expect(delivered).toEqual([true, true, true]);
		} finally {
			env.cleanup();
		}
	});

	it("advances the count when a short live blocker leads and the drift advisory follows whole", async () => {
		const env = setupTestEnvironment("pi-lens-4921-trailing-hold-");
		try {
			const sessionId = "trailing-hold-session";
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
			// A short live blocker leads; the drift advisory follows it whole, so
			// only the content check (not the leading-part arm) sees it delivered.
			const live = path.join(env.tmpDir, "live.ts");
			fs.writeFileSync(live, "export const l = 1;\n");
			runtime.bumpFileSeq(live);
			cacheManager.addModifiedRange(
				live,
				{ start: 1, end: 2 },
				false,
				env.tmpDir,
				sessionId,
			);
			runtime.recordInlineBlockers(live, "🔴 L1 a live blocker", 1, ["lsp"]);
			runtime.recordInlineBlockers(consumer, "🔴 L1 a drifted blocker", 1, [
				"lsp",
			]);
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(dep, future, future);

			const counts: number[][] = [];
			const delivered: boolean[] = [];
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));
			delivered.push(
				consumeTurnEndFindings(cacheManager, env.tmpDir, runtime) !== undefined,
			);
			counts.push(
				runtime
					.getInlineBlockersSnapshot()
					.map((entry) => entry.staleDeliveryCount ?? 0),
			);
			for (let turn = 2; turn <= 3; turn++) {
				await driveTurn(
					runtime,
					cacheManager,
					consumer,
					env.tmpDir,
					sessionId,
					turn,
				);
				delivered.push(
					consumeTurnEndFindings(cacheManager, env.tmpDir, runtime) !==
						undefined,
				);
				counts.push(
					runtime
						.getInlineBlockersSnapshot()
						.map((entry) => entry.staleDeliveryCount ?? 0),
				);
			}
			// Each turn writes another file, so each is a new delivery; the third
			// reaches the cap and retires the record (the round-1 behaviour).
			// The live blocker never counts; the drift record is the max, and 0 once retired.
			expect(counts.map((c) => Math.max(0, ...c))).toEqual([1, 2, 0]);
			expect(delivered).toEqual([true, true, true]);
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #4921 verify F7: only the #1950 drift hold counts on delivery, so only it may
 * key the file set. A deferred runner's broken-runner note is a hold too, and
 * its text names the runner and the failure kind, never the written file.
 * Recurrence this prevents: dropping the `skipOnSuppressed` conjunct from the
 * key restored #4921's defect through this second producer, an identical note
 * re-delivered on every turn that wrote a different file, with the suite green.
 */
describe("a repeated broken-runner note does not key the dedupe on the file set (#4921)", () => {
	it("delivers it once while each turn writes a different file", async () => {
		const env = setupTestEnvironment("pi-lens-4921-runner-note-");
		try {
			const sessionId = "runner-note-session";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			const cacheManager = new CacheManager(false);
			const runnerFile = path.join(env.tmpDir, "run-a.ts");
			fs.writeFileSync(runnerFile, "export const r = 1;\n");
			const past = new Date(Date.now() - 10_000);
			fs.utimesSync(runnerFile, past, past);

			const delivered: Array<string | undefined> = [];
			for (let turn = 1; turn <= 3; turn++) {
				runtime.beginTurn();
				// A different written file every turn: only the file set differs.
				const noise = path.join(env.tmpDir, `noise-${turn}.ts`);
				fs.writeFileSync(noise, `export const noise${turn} = ${turn};\n`);
				runtime.bumpFileSeq(noise);
				cacheManager.addModifiedRange(
					noise,
					{ start: 1, end: 1 },
					false,
					env.tmpDir,
					sessionId,
				);
				// The same note every turn: runner id and failure kind only.
				deferRunnerFindings({
					filePath: runnerFile,
					cwd: env.tmpDir,
					projectRoot: env.tmpDir,
					runnerId: "slow-runner",
					markedAtMs: Date.now(),
					promise: Promise.resolve({
						status: "failed",
						semantic: "warning",
						failureKind: "timeout",
						failureMessage: "boom",
						diagnostics: [],
					}),
				});
				await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, env.tmpDir));
				const result = consumeTurnEndFindings(
					cacheManager,
					env.tmpDir,
					runtime,
				);
				delivered.push(result ? JSON.stringify(result.messages) : undefined);
			}
			expect(delivered[0]).toContain("Deferred runner slow-runner failed");
			expect(delivered[1]).toBeUndefined();
			expect(delivered[2]).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});

/**
 * #2982 review, the blocking finding. A self-drift demotion is content-confirmed
 * and re-arming: `touch` does not demote it, and a file whose bytes come back
 * un-demotes before any cap applies. #4990 added
 * `SELF_DRIFT_MAX_DELIVERIES` for the OTHER shape — a rewrite that never
 * returns to the recorded bytes — whose cap behavior is covered by
 * `tests/clients/demoted-finding-4990.test.ts`.
 */
describe("self-drift demotion is content-confirmed and re-arming (#2982)", () => {
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
			const baselineBytes = fs.readFileSync(target);
			runtime.recordInlineBlockers(
				target,
				"🔴 hardcoded secret",
				1,
				["ast-grep"],
				undefined,
				{
					size: baselineBytes.byteLength,
					sha256: createHash("sha256").update(baselineBytes).digest("hex"),
				},
			);
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
});
