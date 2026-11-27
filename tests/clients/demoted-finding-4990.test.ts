// flake-shape: in-process-mock — the inline_blocker_policy row goes through logLatency, turn_end logs more phases after it than the five the getRecentLoggedPhases ring keeps, and test mode skips the file sink, so a passed-through spy is the only reader (#4990)
/**
 * #4990 gaps 2 and 3 — the DEMOTED (self-drift) blocker channel.
 *
 * The reported incident: a language server flagged a file mid-refactor, the
 * agent rewrote the file, and the record's own bytes drifted. The freshness
 * sweep demoted it to `[stale — re-run to confirm]` (`staleReason:
 * "self-drift"`), and from then on every turn end re-served the dead
 * coordinates:
 *
 *   - gap 2: the stale branch never read the record's structured
 *     diagnostics, so it never ran `applyInlineBlockerPolicy`. A
 *     `false-positive` mark the agent had made had no effect on the one
 *     surface that kept printing the finding.
 *   - gap 3: `self-drift` was deliberately outside the #1950 delivery cap,
 *     on the rationale that a self-drift record re-arms, so "a record that
 *     heals on its own needs no bounded-noise retirement". That covers a file
 *     whose bytes COME BACK. It does not cover the ordinary case here: the
 *     file was rewritten and never returns to its recorded bytes, so the
 *     record re-served for the rest of the session.
 *
 * Both cases drive the real `handleTurnEnd` / `consumeTurnEndFindings` pair
 * over several turns against the real `RuntimeCoordinator`, the real durable
 * disposition store and the real freshness sweep. The record is demoted by
 * the sweep's own content-confirmed axis (a real byte change), never by a
 * hand-set `stale` flag.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import {
	_resetStateCacheForTests,
	markDisposition,
} from "../../clients/diagnostic-dispositions.js";
import { SELF_DRIFT_MAX_DELIVERIES } from "../../clients/finding-delivery-gate.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { formatDiagnostics } from "../../clients/dispatch/utils/format-utils.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
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

function blockingDiagnostic(
	filePath: string,
	line: number,
	message: string,
): Diagnostic {
	return {
		id: `ast-grep:${path.basename(filePath)}:${line}`,
		message,
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool: "ast-grep",
		rule: "no-eval",
	};
}

/**
 * Record the verdict the way `runtime-tool-result.ts` records one from a
 * `PipelineResult`: the summary is the production renderer's output for the
 * same diagnostics, the sources and lines are derived from that array, and the
 * content baseline is captured from the bytes the verdict is about.
 */
function recordBlockers(
	runtime: RuntimeCoordinator,
	filePath: string,
	diagnostics: Diagnostic[],
): void {
	const bytes = fs.readFileSync(filePath);
	runtime.recordInlineBlockers(
		filePath,
		formatDiagnostics(diagnostics, "blocking").trim(),
		runtime.nextWriteIndex(),
		[...new Set(diagnostics.map((d) => d.tool))],
		diagnostics
			.map((d) => d.line)
			.filter((line): line is number => typeof line === "number"),
		{
			size: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		},
		diagnostics,
	);
}

/** Mark a finding `false-positive` through the real durable store. */
function markFalsePositive(cwd: string, diagnostic: Diagnostic): void {
	markDisposition(
		cwd,
		{
			cwd,
			filePath: diagnostic.filePath,
			tool: diagnostic.tool,
			rule: diagnostic.rule,
			message: diagnostic.message,
			line: diagnostic.line,
			content: fs.readFileSync(diagnostic.filePath, "utf8"),
		},
		"false-positive",
	);
}

/**
 * Land one more turn with activity so `handleTurnEnd` does not early-return on
 * "no modified files this turn". The per-turn noise file stands in for
 * "something else about the turn differs", which is the shape the report
 * describes (the demoted advisory rides along whenever anything else in the
 * message changes, #4921).
 */
function driveTurn(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	consumer: string,
	cwd: string,
	turn: number,
): Promise<void> {
	runtime.beginTurn();
	runtime.bumpFileSeq(consumer);
	cacheManager.addModifiedRange(consumer, { start: 1, end: 1 }, false, cwd);
	const noise = path.join(cwd, `noise-${turn}.ts`);
	fs.writeFileSync(noise, `export const noise${turn} = ${turn};\n`);
	runtime.bumpFileSeq(noise);
	cacheManager.addModifiedRange(noise, { start: 1, end: 1 }, false, cwd);
	return handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
}

/** What the agent actually reads at this turn end — "" when it says nothing. */
function turnEndText(
	cacheManager: CacheManager,
	cwd: string,
	runtime: RuntimeCoordinator,
): string {
	return (
		consumeTurnEndFindings(cacheManager, cwd, runtime)?.messages?.[0]
			?.content ?? ""
	);
}

interface InlinePolicyTally {
	stale?: number;
	candidates?: number;
	kept?: number;
	dispositionSuppressed?: number;
}

function inlinePolicyRows(): Array<{ metadata?: InlinePolicyTally }> {
	return logLatency.mock.calls
		.map(([entry]) => entry)
		.filter(
			(entry: { phase?: string }) => entry?.phase === "inline_blocker_policy",
		) as Array<{ metadata?: InlinePolicyTally }>;
}

function demotedRetirementReasons(): string[] {
	return (
		getDegradationSummary().flatMap((entry) =>
			entry.kind === "demoted-finding-retired"
				? (entry.latestReasons ?? []).map((row) => row.reason)
				: [],
		) ?? []
	);
}

beforeEach(() => {
	resetDegradationLedger();
});

afterEach(() => {
	cancelLSPIdleReset();
	resetDegradationLedger();
	_resetStateCacheForTests();
	logLatency.mockClear();
});

describe("#4990 gap 2 — the demoted channel honours stored dispositions", () => {
	it("never re-serves a self-drift record whose every finding is marked false-positive", async () => {
		const env = setupTestEnvironment("pi-lens-4990-demoted-mark-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "lib", "upstreams.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(
				filePath,
				[
					"const a = setCached(1);",
					"const b = HEALTH_CACHE_ID;",
					"export const c = a + b;",
					"",
				].join("\n"),
			);

			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const diagnostics = [
				blockingDiagnostic(filePath, 1, "Cannot find name 'setCached'."),
				blockingDiagnostic(filePath, 2, "Cannot find name 'HEALTH_CACHE_ID'."),
			];
			recordBlockers(runtime, filePath, diagnostics);

			// The refactor: both symbols are gone, so the record's own bytes
			// drifted. This is the freshness sweep's content-confirmed axis.
			fs.writeFileSync(filePath, ["export const fixed = true;", ""].join("\n"));
			// The agent marks the findings after the rewrite, exactly as the
			// report states (13:42:58Z, after the 13:42:31Z rewrite).
			for (const diagnostic of diagnostics) markFalsePositive(cwd, diagnostic);
			// The record was a real blocker at the time it was recorded.
			runtime.updateGitGuardStatus(true, "blockers");
			expect(runtime.gitGuardHasBlockers).toBe(true);

			await driveTurn(runtime, cacheManager, filePath, cwd, 1);
			const first = turnEndText(cacheManager, cwd, runtime);
			expect(first).not.toContain("[stale — re-run to confirm]");
			expect(first).not.toContain("Cannot find name 'setCached'");
			expect(first).not.toContain("Cannot find name 'HEALTH_CACHE_ID'");

			// Multi-turn: the same dead coordinates must not come back on the
			// next turn either.
			await driveTurn(runtime, cacheManager, filePath, cwd, 2);
			const second = turnEndText(cacheManager, cwd, runtime);
			expect(second).not.toContain("[stale — re-run to confirm]");
			expect(second).not.toContain("Cannot find name 'setCached'");

			// The suppression is countable, not silent: one bounded policy row
			// names the stale record and the two findings the marks removed.
			const rows = inlinePolicyRows();
			expect(rows.length).toBeGreaterThan(0);
			const last = rows.at(-1);
			expect(last?.metadata?.stale).toBe(1);
			expect(last?.metadata?.candidates).toBe(2);
			expect(last?.metadata?.dispositionSuppressed).toBe(2);
			// A demoted record whose every finding is marked is no longer a blocker
			// the commit gate may quote: the same survivor set decides both (#3248).
			expect(runtime.gitGuardHasBlockers).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("serves only the unmarked findings of a partly marked self-drift record", async () => {
		const env = setupTestEnvironment("pi-lens-4990-demoted-partial-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(
				filePath,
				["eval(one);", "eval(two);", "export const x = 1;", ""].join("\n"),
			);

			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const marked = blockingDiagnostic(filePath, 1, "eval(one) is banned");
			const kept = blockingDiagnostic(filePath, 2, "eval(two) is banned");
			recordBlockers(runtime, filePath, [marked, kept]);

			// A same-path rewrite drifts the record's own bytes.
			fs.writeFileSync(
				filePath,
				["eval(one);", "eval(two);", "export const x = 2;", ""].join("\n"),
			);
			markFalsePositive(cwd, marked);

			await driveTurn(runtime, cacheManager, filePath, cwd, 1);
			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("[stale — re-run to confirm]");
			expect(text).toContain("eval(two) is banned");
			expect(text).not.toContain("eval(one) is banned");
			// The demoted body keeps its past-tense wording, never the live
			// "must be fixed" imperative (#1944).
			expect(text).not.toContain("must be fixed");
			// Review F2 (#4998): the drop is TOLD, not only logged. Both arms run
			// the same policy stack, so both owe the owner doc's disclosure rule
			// (`clients/finding-delivery-gate.ts` "What a disposition dropped is
			// also told to the agent, never only logged"); before this the
			// demoted arm rendered the survivors and said nothing about the rest.
			expect(text).toContain(
				"[stale — re-run to confirm] app.ts (suppressed by disposition: 1 finding(s)):",
			);

			const last = inlinePolicyRows().at(-1);
			expect(last?.metadata?.stale).toBe(1);
			expect(last?.metadata?.candidates).toBe(2);
			expect(last?.metadata?.kept).toBe(1);
			expect(last?.metadata?.dispositionSuppressed).toBe(1);
		} finally {
			env.cleanup();
		}
	});
});

describe("#4990 gap 2b — a file-less turn's mark reaches the demoted arm", () => {
	it("clears the commit-gate latch for a fully marked demoted record with no edit this turn", async () => {
		const env = setupTestEnvironment("pi-lens-4990-readonly-mark-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "drift.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
			recordBlockers(runtime, filePath, [diagnostic]);
			runtime.updateGitGuardStatus(true, "blockers");

			// Turn 1: the rewrite demotes the record through the real sweep.
			fs.writeFileSync(filePath, "alphaFixed();\n");
			await driveTurn(runtime, cacheManager, filePath, cwd, 1);
			const snapshot = runtime.getInlineBlockersSnapshot();
			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]?.staleReason).toBe("self-drift");
			// The demoted record is still a real blocker for the gate.
			runtime.updateGitGuardStatus(false, "");
			expect(runtime.gitGuardHasBlockers).toBe(true);

			// The agent marks it on a turn that writes NOTHING (#4698's path).
			markFalsePositive(cwd, diagnostic);
			runtime.beginTurn();
			await handleTurnEnd({
				...makeTurnEndDeps(runtime, cacheManager, cwd),
				getFlag: (flag: string) => flag === "lens-guard",
			});

			expect(runtime.gitGuardHasBlockers).toBe(false);
			expect(runtime.getInlineBlockersSnapshot()[0]?.policySuppressed).toBe(
				true,
			);
		} finally {
			env.cleanup();
		}
	});
});

describe("#4990 gap 3 — the self-drift delivery cap", () => {
	it(`retires a self-drift record after ${SELF_DRIFT_MAX_DELIVERIES} deliveries, with the "still confirmable" reason`, async () => {
		const env = setupTestEnvironment("pi-lens-4990-self-drift-cap-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "consumer.ts");
			fs.writeFileSync(filePath, "export const before = 1;\n");

			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(
				filePath,
				1,
				"incomplete assertion",
			);
			recordBlockers(runtime, filePath, [diagnostic]);
			runtime.updateGitGuardStatus(true, "blockers");

			// The rewrite the agent made while fixing the code the finding named.
			// The bytes never come back, which is the shape #2982's "it re-arms"
			// rationale did not cover.
			fs.writeFileSync(filePath, "export const afterTheFix = true;\n");

			// Below the cap: re-served, not retired, count advancing by exactly
			// one per delivered turn.
			for (let delivery = 1; delivery < SELF_DRIFT_MAX_DELIVERIES; delivery++) {
				await driveTurn(runtime, cacheManager, filePath, cwd, delivery);
				const text = turnEndText(cacheManager, cwd, runtime);
				expect(text).toContain("[stale — re-run to confirm]");
				expect(text).not.toContain("Not shown again after");
				const snapshot = runtime.getInlineBlockersSnapshot();
				expect(snapshot).toHaveLength(1);
				expect(snapshot[0]?.staleReason).toBe("self-drift");
				expect(snapshot[0]?.staleDeliveryCount).toBe(delivery);
			}

			// The delivery that reaches the cap retires the record.
			await driveTurn(
				runtime,
				cacheManager,
				filePath,
				cwd,
				SELF_DRIFT_MAX_DELIVERIES,
			);
			const capped = turnEndText(cacheManager, cwd, runtime);
			expect(capped).toContain("[stale — re-run to confirm]");
			expect(capped).toContain(
				`Not shown again after ${SELF_DRIFT_MAX_DELIVERIES} deliveries`,
			);
			// #1944's "cannot be re-confirmed" would be false here: a fresh
			// dispatch can still confirm or clear the finding.
			expect(capped).not.toContain("cannot be re-confirmed");
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
			// A demoted record gates a commit until it is retired (§2982's safety
			// pin), and the retire itself resyncs the latch.
			expect(runtime.gitGuardHasBlockers).toBe(false);

			// The ledger distinguishes "capped" from "retired, unrecoverable".
			expect(demotedRetirementReasons()).toEqual(
				expect.arrayContaining([
					expect.stringContaining("re-run can still confirm"),
				]),
			);

			// Once retired it never resurfaces.
			await driveTurn(
				runtime,
				cacheManager,
				filePath,
				cwd,
				SELF_DRIFT_MAX_DELIVERIES + 1,
			);
			expect(turnEndText(cacheManager, cwd, runtime)).not.toContain(
				"[stale — re-run to confirm]",
			);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	// Review F3 (#4998): the count is PER DEMOTION EPISODE. The self axis re-arms,
	// so a record whose bytes come back un-demotes; healing must drop the count
	// with the demotion, or the next episode retires on its first delivery and
	// the ledger claims more deliveries than the agent ever saw.
	it("starts a fresh delivery count when a healed self-drift record is re-demoted", async () => {
		const env = setupTestEnvironment("pi-lens-4990-self-drift-episode-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "episode.ts");
			const recordedBytes = "export const before = 1;\n";
			fs.writeFileSync(filePath, recordedBytes);

			const runtime = new RuntimeCoordinator();
			const cacheManager = new CacheManager(false);
			recordBlockers(runtime, filePath, [
				blockingDiagnostic(filePath, 1, "incomplete assertion"),
			]);
			runtime.updateGitGuardStatus(true, "blockers");

			// Episode 1: the agent rewrites the file to fix the named code.
			fs.writeFileSync(filePath, "export const fixedA = true;\n");
			for (let delivery = 1; delivery < SELF_DRIFT_MAX_DELIVERIES; delivery++) {
				await driveTurn(runtime, cacheManager, filePath, cwd, delivery);
				expect(turnEndText(cacheManager, cwd, runtime)).toContain(
					"[stale — re-run to confirm]",
				);
			}
			expect(runtime.getInlineBlockersSnapshot()[0]?.staleDeliveryCount).toBe(
				SELF_DRIFT_MAX_DELIVERIES - 1,
			);

			// Heal: the recorded bytes come back (a checkout, a revert, an editor
			// undo), which is exactly the re-arm this axis was built for.
			fs.writeFileSync(filePath, recordedBytes);
			await driveTurn(
				runtime,
				cacheManager,
				filePath,
				cwd,
				SELF_DRIFT_MAX_DELIVERIES,
			);
			const healed = runtime.getInlineBlockersSnapshot();
			expect(healed).toHaveLength(1);
			expect(healed[0]?.stale).toBe(false);
			expect(healed[0]?.staleReason).toBeUndefined();
			expect(healed[0]?.staleDeliveryCount).toBeUndefined();

			// Episode 2: a different rewrite demotes it again. This episode has
			// seen ONE delivery, so it must neither retire nor claim a cap.
			fs.writeFileSync(filePath, "export const fixedB = true;\n");
			await driveTurn(
				runtime,
				cacheManager,
				filePath,
				cwd,
				SELF_DRIFT_MAX_DELIVERIES + 1,
			);
			const secondEpisode = turnEndText(cacheManager, cwd, runtime);
			expect(secondEpisode).toContain("[stale — re-run to confirm]");
			expect(secondEpisode).not.toContain("Not shown again after");
			const after = runtime.getInlineBlockersSnapshot();
			expect(after).toHaveLength(1);
			expect(after[0]?.staleReason).toBe("self-drift");
			expect(after[0]?.staleDeliveryCount).toBe(1);
			expect(
				demotedRetirementReasons().filter((reason) =>
					reason.includes("self-drift"),
				),
			).toEqual([]);
		} finally {
			env.cleanup();
		}
	});
});
