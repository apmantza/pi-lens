/**
 * Turn-end integration for the widget-footer dependency-drift delivery cap
 * (#2275), sibling of #1950's inline-blocker cap
 * (`blocker-freshness-delivery-cap.test.ts`).
 *
 * #1631's dependency-drift gate demotes a blocking widget-store diagnostic
 * whose forward import changed out-of-band
 * (`reconcileStaleWidgetDependencyBlockers` / the #1790 turn-end sweep chain
 * via `markWidgetFileBlockersStale`) to a `[stale — re-run to confirm]`
 * advisory (demote, not drop — #1419). Unlike #1950's inline-blocker
 * demotion, that widget demotion never retired: it re-derives every turn
 * from the widget's own diagnostic list with no stored delivery count, so it
 * re-serves in the footer for the rest of the session.
 *
 * Review round F1 pins the counting rule the first cut got wrong: the footer
 * renders ONE record per draw (`withBlocking[0]`, its first five qualifying
 * entries), so "a turn ended" is NOT "the agent saw this row". The delivery
 * count must advance only for rows the footer ACTUALLY RENDERED since the
 * last turn end — the widget-surface analogue of #1950's own
 * deferred-until-delivered commit (`pendingDependencyDriftDeliveries`).
 *
 * Review round F2 pins the retirement SHAPE: retiring must hide the row from
 * the footer, not splice it out of `allDiagnostics` — that store also feeds
 * `lens_diagnostics mode=all` and `lens_diagnostic_mark`, where a dropped
 * unconfirmed LSP error would read as CLEAN.
 *
 * Mutation proof: hardcoding the cap check in `runtime-turn.ts`'s widget-cap
 * loop to `false` leaves the row still rendering and writes no
 * `demoted-finding-retired` ledger entry; making the loop walk every stale
 * file instead of the rendered ones reds the three-file probe.
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
import {
	clearWidgetState,
	getFileDiagnostics,
	isBlocking,
	markWidgetFileBlockersStale,
	recordDiagnostics,
	renderWidget,
} from "../../clients/widget-state.js";
import { setupTestEnvironment } from "./test-utils.js";

const e = String.fromCharCode(27);
const theme = {
	fg: (_color: string, s: string) => `${e}[38;2;102;102;102m${s}${e}[39m`,
};

/**
 * A hard ceiling on every multi-turn loop below, INDEPENDENT of
 * `DEPENDENCY_DRIFT_MAX_DELIVERIES`. Mutation testing that raises the cap
 * constant (to `Infinity`, say) must make these tests FAIL, not hang — a
 * loop bounded by the constant under test spins forever instead of reading.
 */
const MAX_TURNS = 12;

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

/**
 * Drive one more turn with activity so `handleTurnEnd` doesn't early-return
 * on "no modified files this turn". Touches a per-turn noise file — mirrors
 * `blocker-freshness-delivery-cap.test.ts`'s own `driveTurn`.
 */
function driveTurn(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	sessionId: string,
	turn: number,
): Promise<void> {
	runtime.beginTurn();
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

/**
 * Fix-round 3 (#2275 review F1): drive one more turn with NO modified files
 * at all — the read-only-stretch case. Unlike `driveTurn`, this never
 * touches `cacheManager.addModifiedRange`, so `turnState.files` stays empty
 * and `handleTurnEnd` takes the `files.length === 0 && !hasCascadeRuns()`
 * early-return branch (runtime-turn.ts). The widget-cap drain/charge loop
 * must still run on this path — a quiet turn that repaints the footer and
 * draws a demoted row is still a delivery.
 */
function driveQuietTurn(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
): Promise<void> {
	runtime.beginTurn();
	return handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
}

/** Record one widget-ONLY blocking LSP row and demote it on the drift axis. */
function recordDemoted(filePath: string, message: string): void {
	fs.writeFileSync(filePath, `export const x = "${message}";\n`);
	recordDiagnostics(
		filePath,
		[
			{
				severity: "error",
				semantic: "blocking",
				message,
				tool: "lsp",
				line: 1,
			},
		],
		1,
		Date.now() - 60_000,
	);
	expect(markWidgetFileBlockersStale(filePath, "dependency-drift")).toBe(true);
}

function staleEntry(filePath: string) {
	return (getFileDiagnostics(filePath) ?? []).find(
		(d) => d.staleReason === "dependency-drift",
	);
}

function ledgerReasons(): string[] {
	const entry = getDegradationSummary().find(
		(d: { kind: string }) => d.kind === "demoted-finding-retired",
	) as { latestReasons?: Array<{ reason: string }> } | undefined;
	return (entry?.latestReasons ?? []).map((r) => r.reason);
}

afterEach(() => {
	cancelLSPIdleReset();
	resetDegradationLedger();
	clearWidgetState();
	logLatency.mockClear();
});

describe("widget-footer dependency-drift delivery cap (#2275)", () => {
	it(`counts only RENDERED deliveries and retires after exactly ${DEPENDENCY_DRIFT_MAX_DELIVERIES} of them`, async () => {
		const env = setupTestEnvironment("pi-lens-2275-cap-");
		try {
			const sessionId = "widget-cap-session";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const consumer = path.join(env.tmpDir, "consumer.ts");
			recordDemoted(consumer, "type error demoted by drift");

			let renders = 0;
			for (let turn = 1; turn <= MAX_TURNS; turn++) {
				const footer = renderWidget(120, theme).join("\n");
				if (footer.includes("type error demoted by drift")) renders += 1;
				await driveTurn(runtime, cacheManager, env.tmpDir, sessionId, turn);
				if (staleEntry(consumer)?.footerRetired === true) break;
			}

			// Retired after exactly `DEPENDENCY_DRIFT_MAX_DELIVERIES` RENDERS —
			// not after that many turn ends.
			expect(renders).toBe(DEPENDENCY_DRIFT_MAX_DELIVERIES);

			// F2: hidden from the footer, but NOT dropped from the store — this
			// same `allDiagnostics` list feeds mode=all and lens_diagnostic_mark.
			const entry = staleEntry(consumer);
			expect(entry).toBeDefined();
			expect(entry?.footerRetired).toBe(true);
			expect(entry?.stale).toBe(true);
			expect(entry?.staleReason).toBe("dependency-drift");
			expect(isBlocking(entry!)).toBe(false);
			expect(renderWidget(120, theme).join("\n")).not.toContain(
				"type error demoted by drift",
			);

			// F1: the ledger's N is the number of times the row was actually
			// rendered, not the number of turn ends that elapsed.
			expect(ledgerReasons()).toEqual(
				expect.arrayContaining([
					expect.stringContaining(
						`capped after ${DEPENDENCY_DRIFT_MAX_DELIVERIES} deliveries`,
					),
				]),
			);
			expect(ledgerReasons().join(" ")).toContain("re-run can still confirm");

			// Further turns neither re-render it nor advance it any further.
			await driveTurn(
				runtime,
				cacheManager,
				env.tmpDir,
				sessionId,
				MAX_TURNS + 1,
			);
			expect(staleEntry(consumer)?.staleDeliveryCount).toBe(
				DEPENDENCY_DRIFT_MAX_DELIVERIES,
			);
			expect(renderWidget(120, theme).join("\n")).not.toContain(
				"type error demoted by drift",
			);
		} finally {
			env.cleanup();
		}
	});

	// F1 probe (the reviewer's shape): three files demoted on the same turn,
	// but the footer only ever renders `withBlocking[0]`'s top five entries.
	// The two files the agent never saw must not advance toward the cap.
	it("advances only the file the footer actually rendered, not every demoted file", async () => {
		const env = setupTestEnvironment("pi-lens-2275-three-");
		try {
			const sessionId = "widget-cap-three";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const paths = ["alpha.ts", "beta.ts", "gamma.ts"].map((n) =>
				path.join(env.tmpDir, n),
			);
			const messages = paths.map((p) => `drifted in ${path.basename(p)}`);
			paths.forEach((p, i) => recordDemoted(p, messages[i]));

			// The footer serves exactly ONE of the three.
			const footer = renderWidget(120, theme).join("\n");
			const shownIdx = messages.findIndex((m) => footer.includes(m));
			expect(shownIdx).toBeGreaterThanOrEqual(0);
			expect(messages.filter((m) => footer.includes(m))).toHaveLength(1);

			for (let turn = 1; turn <= MAX_TURNS; turn++) {
				renderWidget(120, theme);
				await driveTurn(runtime, cacheManager, env.tmpDir, sessionId, turn);
				if (staleEntry(paths[shownIdx])?.footerRetired === true) break;
			}

			// The rendered file capped…
			expect(staleEntry(paths[shownIdx])?.footerRetired).toBe(true);
			// …and the two the footer never showed are untouched at zero.
			for (let i = 0; i < paths.length; i++) {
				if (i === shownIdx) continue;
				const other = staleEntry(paths[i]);
				// Still demoted-but-live: neither retired nor charged a delivery.
				expect(other).toBeDefined();
				expect(other?.footerRetired).toBeUndefined();
				expect(other?.staleDeliveryCount ?? 0).toBe(0);
			}
		} finally {
			env.cleanup();
		}
	});

	// F1 corollary: a session with no footer at all (headless / widget never
	// drawn) delivers nothing, so nothing may ever be retired.
	it("never retires a row the footer never rendered", async () => {
		const env = setupTestEnvironment("pi-lens-2275-headless-");
		try {
			const sessionId = "widget-cap-headless";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const consumer = path.join(env.tmpDir, "unseen.ts");
			recordDemoted(consumer, "never rendered anywhere");

			for (let turn = 1; turn <= MAX_TURNS; turn++) {
				await driveTurn(runtime, cacheManager, env.tmpDir, sessionId, turn);
			}

			const entry = staleEntry(consumer);
			expect(entry).toBeDefined();
			expect(entry?.footerRetired).toBeUndefined();
			expect(entry?.staleDeliveryCount ?? 0).toBe(0);
			expect(ledgerReasons()).toEqual([]);
		} finally {
			env.cleanup();
		}
	});

	// Fix-round 3 (#2275 review F1): a read-only stretch (no modified files
	// any turn) still repaints the footer and can draw a demoted row. Before
	// the fix, the drain/charge loop sat below `handleTurnEnd`'s
	// `files.length === 0` early return, so this sequence rendered the row
	// every turn while the delivery count never advanced — 5 quiet turns, 5
	// renders, `staleDeliveryCount` still `undefined`.
	it(`advances the delivery count and retires after ${DEPENDENCY_DRIFT_MAX_DELIVERIES} quiet (no-file) turns`, async () => {
		const env = setupTestEnvironment("pi-lens-2275-quiet-");
		try {
			const sessionId = "widget-cap-quiet";
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId });
			runtime.beginTurn();
			const cacheManager = new CacheManager(false);

			const consumer = path.join(env.tmpDir, "quiet-consumer.ts");
			recordDemoted(consumer, "type error demoted during a quiet stretch");

			let renders = 0;
			for (let turn = 1; turn <= MAX_TURNS; turn++) {
				const footer = renderWidget(120, theme).join("\n");
				if (footer.includes("type error demoted during a quiet stretch")) {
					renders += 1;
				}
				await driveQuietTurn(runtime, cacheManager, env.tmpDir);
				if (staleEntry(consumer)?.footerRetired === true) break;
			}

			// Retired after exactly `DEPENDENCY_DRIFT_MAX_DELIVERIES` RENDERS —
			// on turns that touched NO file at all.
			expect(renders).toBe(DEPENDENCY_DRIFT_MAX_DELIVERIES);

			const entry = staleEntry(consumer);
			expect(entry).toBeDefined();
			expect(entry?.footerRetired).toBe(true);
			expect(entry?.staleDeliveryCount).toBe(DEPENDENCY_DRIFT_MAX_DELIVERIES);
			expect(renderWidget(120, theme).join("\n")).not.toContain(
				"type error demoted during a quiet stretch",
			);
			expect(ledgerReasons()).toEqual(
				expect.arrayContaining([
					expect.stringContaining(
						`capped after ${DEPENDENCY_DRIFT_MAX_DELIVERIES} deliveries`,
					),
				]),
			);
		} finally {
			env.cleanup();
		}
	});
});
