/**
 * #3814 — the deferred-blocker recording seam, below the host entry.
 *
 * `tests/index-3814-deferred-blocker-gate.test.ts` proves the commit gate
 * through the pi host. This file pins the two properties that entry cannot
 * reach: the recording's provenance contract with the retire seam, and the
 * gate's fail-open behaviour when its pre-check throws. Real
 * `RuntimeCoordinator`, `CacheManager` and pending store throughout.
 */

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	absorbSettledRunnerBlockers,
	judgeDeferredRunnerFindings,
	recordDeferredRunnerBlockers,
	retireSettledRunnerBlockers,
} from "../../clients/deferred-runner-blockers.js";
import {
	deferRunnerFindings,
	peekSettledRunnerFindings,
	resetPendingRunnerFindings,
} from "../../clients/dispatch/pending-runner-findings.js";
import {
	createGenerationSource,
	type GenerationHandle,
} from "../../clients/generation-guard.js";
import type { Diagnostic, RunnerResult } from "../../clients/dispatch/types.js";
import {
	evaluateGitGuard,
	syncGitGuardRecord,
} from "../../clients/git-guard.js";
import {
	flushLatencyLog,
	getLatencyLogPath,
} from "../../clients/latency-logger.js";
import { lineHashOf } from "../../clients/line-alignment.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { setupTestEnvironment } from "./test-utils.js";

// Only the OS read boundary is wrapped; stores, coordinator, policy, and gate remain real.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const RUNNER_ID = "slow-runner";

afterEach(() => {
	resetPendingRunnerFindings();
	resetDegradationLedger();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function blocking(filePath: string): Diagnostic {
	return {
		id: `${RUNNER_ID}:app.ts:1`,
		message: "alpha is not a function",
		filePath,
		line: 1,
		severity: "error",
		semantic: "blocking",
		tool: RUNNER_ID,
		rule: "TS2349",
	};
}

/** A settled deferred answer for `filePath`, scanned just now. `session` is
 * the producer's captured handle; omitting it is a released writer's shape. */
async function settledAnswer(
	filePath: string,
	cwd: string,
	session?: GenerationHandle,
): Promise<void> {
	const result: RunnerResult = {
		status: "succeeded",
		diagnostics: [blocking(filePath)],
		semantic: "blocking",
	};
	deferRunnerFindings({
		filePath,
		cwd,
		projectRoot: cwd,
		runnerId: RUNNER_ID,
		markedAtMs: Date.now(),
		promise: Promise.resolve(result),
		...(session ? { session } : {}),
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("deferred blocker recording (#3814)", () => {
	it("keeps a fresh settled blocker gating when its bytes cannot be read", async () => {
		// Recurrence: #3896 mutant27 removed the optional byte read, turning
		// EACCES after a successful stat into a pre-check exception and false allow.
		// The real-filesystem POSIX probe proved the same red; faulting only the
		// OS read makes this witness portable without weakening any real owner.
		const env = setupTestEnvironment("pi-lens-3814-failopen-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await settledAnswer(filePath, env.tmpDir);
			const actualFs =
				await vi.importActual<typeof import("node:fs")>("node:fs");
			vi.mocked(fs.readFileSync).mockImplementation((file, options) => {
				if (file === filePath) {
					throw Object.assign(new Error("EACCES: reading app.ts"), {
						code: "EACCES",
					});
				}
				return actualFs.readFileSync(file, options);
			});
			expect(
				evaluateGitGuard(runtime, new CacheManager(false), env.tmpDir).block,
			).toBe(true);
			expect(
				getDegradationSummary().some(
					(row) => row.kind === "deferred-blocker-gate-error",
				),
			).toBe(false);
		} finally {
			vi.mocked(fs.readFileSync).mockImplementation(
				(await vi.importActual<typeof import("node:fs")>("node:fs"))
					.readFileSync,
			);
			env.cleanup();
		}
	});

	it("leaves the missing-path record to delivery rather than writing it during a gate peek", async () => {
		// Recurrence: #3814 r1 L1 duplicated delivery records from a commit peek.
		// Mutation of advisory-provenance's quiet guard must red this real sink.
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		const env = setupTestEnvironment("pi-lens-3814-failopen-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await settledAnswer(filePath, env.tmpDir);
			fs.unlinkSync(filePath);
			expect(
				evaluateGitGuard(runtime, new CacheManager(false), env.tmpDir).block,
			).toBe(false);
			await flushLatencyLog();
			const before = fs
				.readFileSync(getLatencyLogPath(), "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter(
					(row) =>
						row.filePath === env.tmpDir &&
						row.phase === "finding_dead_path_drop",
				);
			expect(before).toHaveLength(0);
			// The real settled store still owns the answer; delivery asks the same
			// verdict without quiet, just as the turn-end lane does.
			const [pending] = peekSettledRunnerFindings();
			expect(pending).toBeDefined();
			judgeDeferredRunnerFindings(pending, env.tmpDir);
			await flushLatencyLog();
			const after = fs
				.readFileSync(getLatencyLogPath(), "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter(
					(row) =>
						row.filePath === env.tmpDir &&
						row.phase === "finding_dead_path_drop",
				);
			expect(after).toHaveLength(1);
		} finally {
			env.cleanup();
		}
	});

	it("counts only newly recorded files when a settled replay joins a fresh answer", async () => {
		// The worker home is pinned before logger load; opt into the real sink.
		vi.stubEnv("PI_LENS_TEST_MODE", "0");
		// Recurrence: #3896 mutant63 counted an already recorded answer as a
		// newly blocking file in the commit-gate result and latency record.
		const env = setupTestEnvironment("pi-lens-3814-sources-");
		try {
			const firstPath = path.join(env.tmpDir, "first.ts");
			const secondPath = path.join(env.tmpDir, "second.ts");
			fs.writeFileSync(firstPath, "alpha();\n");
			fs.writeFileSync(secondPath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await settledAnswer(firstPath, env.tmpDir);
			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(1);
			await settledAnswer(secondPath, env.tmpDir);
			const result = absorbSettledRunnerBlockers(runtime, env.tmpDir);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(2);
			expect(result.recorded).toBe(1);
			expect(result.fileCount).toBe(1);
			await flushLatencyLog();
			const rows = fs
				.readFileSync(getLatencyLogPath(), "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter(
					(row) =>
						row.phase === "deferred_runner_blockers" &&
						row.filePath === env.tmpDir,
				);
			expect(rows).toHaveLength(2);
			expect(rows.at(-1)?.metadata).toMatchObject({
				recorded: 1,
				fileCount: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("is retired only by a clean verdict that covers the runner that raised it", async () => {
		// Recurrence: inline blockers carry the `tool` ids behind them so an
		// LSP-only clean cannot retire an eslint/pyright blocker (#1561 F1). A
		// deferred record that dropped `sources` would be retired by any clean
		// verdict, or (fail-closed on unknown provenance) by none.
		const env = setupTestEnvironment("pi-lens-3814-sources-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await settledAnswer(filePath, env.tmpDir);
			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(1);

			expect(
				runtime.retireInlineBlockerOnConfirmedClean(filePath, undefined, [
					"lsp",
				]),
			).toBe(false);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(1);
			expect(
				runtime.retireInlineBlockerOnConfirmedClean(filePath, undefined, [
					RUNNER_ID,
				]),
			).toBe(true);
			expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("makes a file blocking again when a deferred blocker joins a fully suppressed record", async () => {
		// Recurrence: `policySuppressed` is a verdict about the OLD finding set
		// (#3248). A merge that kept it would let the gate ignore a live deferred
		// blocker because the agent marked the earlier, different finding.
		const env = setupTestEnvironment("pi-lens-3814-suppressed-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const inline: Diagnostic = {
				...blocking(filePath),
				id: "inline-tool:app.ts:1",
				tool: "inline-tool",
				message: "inline finding",
			};
			runtime.recordInlineBlockers(
				filePath,
				"inline summary",
				runtime.nextWriteIndex(),
				["inline-tool"],
				[1],
				undefined,
				[inline],
			);
			runtime.applyInlineBlockerPolicyVerdicts([filePath]);
			runtime.updateGitGuardStatus(false, "");
			expect(runtime.gitGuardHasBlockers).toBe(false);

			await settledAnswer(filePath, env.tmpDir);
			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(1);

			expect(runtime.gitGuardHasBlockers).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	it("leaves a record with no structured diagnostics as it was", async () => {
		// Recurrence: merging into a text-only record would replace its text with
		// the new findings alone at the next replay (the replay re-renders from
		// `diagnostics`). The file already blocks, so nothing is lost by waiting.
		const env = setupTestEnvironment("pi-lens-3814-unstructured-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.recordInlineBlockers(
				filePath,
				"legacy summary text",
				runtime.nextWriteIndex(),
				["legacy-tool"],
			);
			await settledAnswer(filePath, env.tmpDir);

			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(0);
			expect(runtime.getInlineBlockersSnapshot()).toMatchObject([
				{ summary: "legacy summary text" },
			]);
			expect(
				runtime.getInlineBlockersSnapshot()[0]?.diagnostics,
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("fails open on a pre-check fault and judges the same answer again at the next attempt", async () => {
		// Recurrence (r1 L2): the gate claimed every settled entry before judging
		// any, so one transient fault left the entry unjudged for the rest of the
		// session and the next commit passed on a blocker that was waiting. The
		// fault is one counted ledger row; the retry blocks.
		const env = setupTestEnvironment("pi-lens-3814-failopen-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const cacheManager = new CacheManager(false);
			await settledAnswer(filePath, env.tmpDir);
			vi.spyOn(runtime, "recordDeferredInlineBlockers").mockImplementationOnce(
				() => {
					throw new Error("injected recording fault");
				},
			);

			expect(evaluateGitGuard(runtime, cacheManager, env.tmpDir).block).toBe(
				false,
			);
			const row = getDegradationSummary().find(
				(group) => group.kind === "deferred-blocker-gate-error",
			);
			expect(row?.count).toBe(1);
			expect(row?.latestReasons[0]?.reason).toContain(
				"injected recording fault",
			);
			expect(evaluateGitGuard(runtime, cacheManager, env.tmpDir).block).toBe(
				true,
			);
		} finally {
			env.cleanup();
		}
	});

	it("stamps the record with the moment the runner scanned", async () => {
		// Recurrence (r1 L3): `recordedAtMs` is the baseline the dependency-drift
		// sweep compares file and import mtimes against; a record stamped 0 is
		// demoted at the first sweep, and stamped with the recording time it would
		// never see a drift that happened between the scan and the recording.
		const env = setupTestEnvironment("pi-lens-3814-stamp-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const markedAtMs = Date.now() + 10_000;
			deferRunnerFindings({
				filePath,
				cwd: env.tmpDir,
				projectRoot: env.tmpDir,
				runnerId: RUNNER_ID,
				markedAtMs,
				promise: Promise.resolve({
					status: "succeeded",
					diagnostics: [blocking(filePath)],
					semantic: "blocking",
				} satisfies RunnerResult),
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(1);

			expect(runtime.getInlineBlockersSnapshot()[0]?.recordedAtMs).toBe(
				markedAtMs,
			);
		} finally {
			env.cleanup();
		}
	});

	it("stamps a settled blocker with its own line's text from the settled bytes", async () => {
		// Recurrence (#4484 round 5, K1's settle path): a record a settle starts
		// has no anchor, so the next write cannot align. Without the entry's own
		// line text it matched by identity alone, and a same-rule finding on a
		// line with other text could take over the record and pin.
		const env = setupTestEnvironment("pi-lens-4484-settle-text-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			await settledAnswer(filePath, env.tmpDir);
			expect(absorbSettledRunnerBlockers(runtime, env.tmpDir).recorded).toBe(1);
			expect(runtime.getInlineBlockerDiagnostics(filePath)?.[0]?.lineHash).toBe(
				lineHashOf("alpha();"),
			);
		} finally {
			env.cleanup();
		}
	});

	it("drops a retired producer's settled answer from the gate (staleReject)", async () => {
		// #3758/#3814: the gate's non-draining peek applies the same owned
		// admission the turn-end drain does. A commit in the gap before the next
		// session_start clears this store must not block on a retired session's
		// answer; the drop leaves the handle's `generation-guard-stale-write` row.
		const env = setupTestEnvironment("pi-lens-3814-peek-stale-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const sessions = createGenerationSource("test-runtime-session");
			const retired = sessions.capture();
			await settledAnswer(filePath, env.tmpDir, retired);
			sessions.bump();

			const cacheManager = new CacheManager(false);
			expect(evaluateGitGuard(runtime, cacheManager, env.tmpDir).block).toBe(
				false,
			);
			const row = getDegradationSummary().find(
				(group) => group.kind === "generation-guard-stale-write",
			);
			expect(row?.latestReasons[0]?.subject).toContain(
				`commit-gate:${RUNNER_ID}:${filePath}`,
			);
		} finally {
			env.cleanup();
		}
	});

	it("keeps the sole live answer gating beside a retired one (no-drop)", async () => {
		// Shape 54: the fence is proven in both directions. The retired file must
		// not be recorded while the live session's only fresh answer still is;
		// a peek that skipped the whole store on the first stale entry would let
		// this commit through.
		const env = setupTestEnvironment("pi-lens-3814-peek-live-");
		try {
			const stalePath = path.join(env.tmpDir, "stale.ts");
			const livePath = path.join(env.tmpDir, "live.ts");
			fs.writeFileSync(stalePath, "beta();\n");
			fs.writeFileSync(livePath, "alpha();\n");
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			const sessions = createGenerationSource("test-runtime-session");
			const retired = sessions.capture();
			await settledAnswer(stalePath, env.tmpDir, retired);
			sessions.bump();
			const live = sessions.capture();
			await settledAnswer(livePath, env.tmpDir, live);

			const recording = absorbSettledRunnerBlockers(runtime, env.tmpDir);
			expect(recording.recorded).toBe(1);
			expect(recording.fileCount).toBe(1);
			expect(
				runtime.getInlineBlockersSnapshot().map((record) => record.filePath),
			).toEqual([livePath]);
			expect(
				evaluateGitGuard(runtime, new CacheManager(false), env.tmpDir).block,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// #4484 round 3 (R3): a settled run's edit-range gate withholds a match on
	// a line the edit did not touch; the match is still observed at its line.
	// Recurrence: the settled retire read only the delivered findings, so a
	// collect-later range-gated runner retired a blocker that was still there.
	it("keeps a recorded blocker that a settled run withheld as out of range", () => {
		const env = setupTestEnvironment("pi-lens-4484-settle-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const sha256 = createHash("sha256")
				.update(fs.readFileSync(filePath))
				.digest("hex");
			const runtime = new RuntimeCoordinator();
			const recorded = { ...blocking(filePath), runnerId: RUNNER_ID };
			runtime.recordInlineBlockers(
				filePath,
				"🔴 STOP",
				1,
				undefined,
				[1],
				{ size: 9, sha256 },
				[recorded],
				undefined,
				1_000,
			);
			const retired = retireSettledRunnerBlockers(
				runtime,
				{
					filePath,
					cwd: env.tmpDir,
					projectRoot: env.tmpDir,
					runnerId: RUNNER_ID,
					markedAtMs: 2_000,
					result: {
						status: "succeeded",
						diagnostics: [],
						semantic: "blocking",
						outOfEditScope: [blocking(filePath)],
					},
				},
				{ kept: [] },
			);
			expect(retired).toBe(0);
			expect(runtime.getInlineBlockerDiagnostics(filePath)).toEqual([recorded]);
		} finally {
			env.cleanup();
		}
	});

	// #4484 round 7 (verify probe P34): napi's collect-later Gate B skip
	// settled as covered by the ast-grep server. The settle read it as a
	// file-wide verdict and retired an unfixed blocker outside the edit.
	it("retires nothing on a settled skip that defers to a covering lane", () => {
		const env = setupTestEnvironment("pi-lens-4484-settle-cover-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const sha256 = createHash("sha256")
				.update(fs.readFileSync(filePath))
				.digest("hex");
			const runtime = new RuntimeCoordinator();
			const recorded = { ...blocking(filePath), runnerId: RUNNER_ID };
			runtime.recordInlineBlockers(
				filePath,
				"🔴 STOP",
				1,
				undefined,
				[1],
				{ size: 9, sha256 },
				[recorded],
				undefined,
				1_000,
			);
			const settled = (coveredBy?: { runnerId: string; serverId: string }) =>
				retireSettledRunnerBlockers(
					runtime,
					{
						filePath,
						cwd: env.tmpDir,
						projectRoot: env.tmpDir,
						runnerId: RUNNER_ID,
						markedAtMs: 2_000,
						result: {
							status: "skipped",
							diagnostics: [],
							semantic: "none",
							skipReason: "covered-by-primary",
							...(coveredBy ? { coveredBy } : {}),
						},
					},
					{ kept: [] },
				);
			expect(settled({ runnerId: "lsp", serverId: "ast-grep" })).toBe(0);
			expect(runtime.getInlineBlockerDiagnostics(filePath)).toEqual([recorded]);
			// #4509 (row 31c): a run that names its covering lane read the
			// bytes itself, so it retires what it no longer observes.
			const ran = retireSettledRunnerBlockers(
				runtime,
				{
					filePath,
					cwd: env.tmpDir,
					projectRoot: env.tmpDir,
					runnerId: RUNNER_ID,
					markedAtMs: 2_000,
					result: {
						status: "succeeded",
						diagnostics: [],
						semantic: "none",
						coveredBy: { runnerId: "lsp", serverId: "ast-grep" },
					},
				},
				{ kept: [] },
			);
			expect(ran).toBe(1);
			runtime.recordInlineBlockers(
				filePath,
				"🔴 STOP",
				1,
				undefined,
				[1],
				{ size: 9, sha256 },
				[recorded],
				undefined,
				1_000,
			);
			// Control: the same skip without a lane is a file-wide verdict.
			expect(settled()).toBe(1);
		} finally {
			env.cleanup();
		}
	});

	// #4529 review R3 (probe P46): napi's slow run settled beside the
	// ast-grep server's recorded copy of the same finding. The settle kept
	// napi's own entry and recorded napi's copy too, so turn end listed one
	// violation twice.
	it("lets a covering lane's recorded copy stand for a settled covered run's finding", () => {
		const env = setupTestEnvironment("pi-lens-4529-settle-lane-");
		try {
			const filePath = path.join(env.tmpDir, "app.ts");
			fs.writeFileSync(filePath, "alpha();\n");
			const bytes = fs.readFileSync(filePath);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const napiCopy = { ...blocking(filePath), rule: "no-unknown-returns" };
			const own = { ...napiCopy, runnerId: RUNNER_ID };
			const laneCopy = (rule: string, serverId?: string): Diagnostic => ({
				...blocking(filePath),
				id: `lsp:${rule}:0`,
				tool: "lsp",
				rule,
				runnerId: "lsp",
				...(serverId !== undefined && { serverId }),
			});
			const settle = (
				lane: Diagnostic,
				coveredBy: { runnerId: string; serverId?: string } = {
					runnerId: "lsp",
					serverId: "ast-grep",
				},
			) => {
				const pending = {
					filePath,
					cwd: env.tmpDir,
					projectRoot: env.tmpDir,
					runnerId: RUNNER_ID,
					markedAtMs: 2_000,
					result: {
						status: "succeeded" as const,
						diagnostics: [napiCopy],
						semantic: "blocking" as const,
						coveredBy,
					},
				};
				const runtime = new RuntimeCoordinator();
				runtime.recordInlineBlockers(
					filePath,
					"🔴 STOP",
					1,
					undefined,
					[1],
					{ size: bytes.byteLength, sha256 },
					[own, lane],
					undefined,
					1_000,
				);
				const retired = retireSettledRunnerBlockers(runtime, pending, {
					kept: [napiCopy],
				});
				const recorded = recordDeferredRunnerBlockers(
					runtime,
					pending,
					[napiCopy],
					bytes,
				);
				return {
					retired,
					recorded,
					left: runtime
						.getInlineBlockerDiagnostics(filePath)
						?.map((d) => `${d.runnerId}:${d.rule}`),
				};
			};
			expect(
				settle(laneCopy("ast-grep:no-unknown-returns", "ast-grep")),
			).toEqual({
				retired: 1,
				recorded: 0,
				left: ["lsp:ast-grep:no-unknown-returns"],
			});
			// Control: the lane's copy of another rule is not napi's finding.
			const kept = {
				retired: 0,
				recorded: 0,
				left: [`${RUNNER_ID}:no-unknown-returns`, "lsp:ast-grep:other-rule"],
			};
			expect(settle(laneCopy("ast-grep:other-rule", "ast-grep"))).toEqual(kept);
			// A cover that names no server (`coveredBy.serverId` is optional)
			// reads only its runner's entries, never the run's own as its lane's.
			expect(
				settle(laneCopy("ast-grep:other-rule"), { runnerId: "lsp" }),
			).toEqual(kept);
		} finally {
			env.cleanup();
		}
	});
});

describe("#5048 a secondary's commit gate persists only its own records", () => {
	const PRIMARY = "pi-lens-5048-primary";
	const SECONDARY = "pi-lens-5048-secondary";
	const COMMIT = { toolName: "bash", input: { command: 'git commit -m "x"' } };

	/** Two checkouts: the primary's root A and the secondary's cwd B. The
	 * `.git/HEAD` marker is what `resolveGitCheckout` reads, so each commit is
	 * scoped to its own tree (#4941). */
	function twoRoots(tmpDir: string) {
		const projA = path.join(tmpDir, "projA");
		const projB = path.join(tmpDir, "projB");
		for (const dir of [projA, projB]) {
			fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, ".git", "HEAD"),
				"ref: refs/heads/main\n",
			);
		}
		const runtime = new RuntimeCoordinator();
		runtime.setTelemetryIdentity({ sessionId: PRIMARY });
		runtime.projectRoot = projA;
		return { projA, projB, runtime, cacheManager: new CacheManager(false) };
	}

	async function settledFor(
		filePath: string,
		cwd: string,
		diagnostics: Diagnostic[],
		owner: string = PRIMARY,
	): Promise<void> {
		deferRunnerFindings({
			filePath,
			cwd,
			projectRoot: cwd,
			runnerId: RUNNER_ID,
			markedAtMs: Date.now(),
			promise: Promise.resolve({
				status: "succeeded",
				diagnostics,
				semantic: diagnostics.length > 0 ? "blocking" : "none",
			} as RunnerResult),
			sessionId: owner,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
	}

	// Recurrence it prevents (#5048, PR #5033 verify r3 V2): the gate's
	// absorb-sync passed no session, so a secondary's commit in project B wrote
	// the primary's settled blocker into B's cache under the primary's id, and
	// every later commit of the secondary in B was refused `session_mismatch`.
	it("records the primary's settled blocker without writing it into the secondary's cache", async () => {
		const env = setupTestEnvironment("pi-lens-5048-absorb-");
		try {
			const { projA, projB, runtime, cacheManager } = twoRoots(env.tmpDir);
			const app = path.join(projA, "app.ts");
			fs.writeFileSync(app, "alpha();\n");
			await settledFor(app, projA, [blocking(app)]);

			const first = evaluateGitGuard(
				runtime,
				cacheManager,
				projB,
				"pi",
				SECONDARY,
				COMMIT,
			);
			// The answer joined the map for its owner, and B's cache holds none of it.
			expect(runtime.inlineBlockerOwner(app)).toBe(PRIMARY);
			expect(cacheManager.inspectCache("turn-end-findings", projB)).toBe(
				"missing",
			);
			expect(first).toEqual({ block: false });
			expect(
				evaluateGitGuard(runtime, cacheManager, projB, "pi", SECONDARY, COMMIT),
			).toEqual({ block: false });
			// The primary's commit in its own tree is still refused on its blocker.
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", undefined, COMMIT)
					.block,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents (#5048, the sibling sync in the same block): a
	// settled clean run retired one of the primary's blockers at a secondary's
	// commit, and the resync for that file, with no session, wrote the primary's
	// remaining blocker into B's cache under the primary's id.
	it("retires the primary's settled-clean blocker without writing its other blockers into the secondary's cache", async () => {
		const env = setupTestEnvironment("pi-lens-5048-retire-");
		try {
			const { projA, projB, runtime, cacheManager } = twoRoots(env.tmpDir);
			const app = path.join(projA, "app.ts");
			const other = path.join(projA, "other.ts");
			for (const file of [app, other]) {
				fs.writeFileSync(file, "alpha();\n");
				const bytes = fs.readFileSync(file);
				runtime.recordInlineBlockers(
					file,
					"🔴 STOP",
					runtime.nextWriteIndex(),
					undefined,
					[1],
					{
						size: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					},
					[{ ...blocking(file), runnerId: RUNNER_ID }],
					undefined,
					1_000,
				);
			}
			await settledFor(app, projA, []);

			evaluateGitGuard(runtime, cacheManager, projB, "pi", SECONDARY, COMMIT);
			// The clean run retired app.ts for its owner; other.ts stays the primary's.
			expect(runtime.hasInlineBlocker(app)).toBe(false);
			expect(runtime.inlineBlockerOwner(other)).toBe(PRIMARY);
			expect(cacheManager.inspectCache("turn-end-findings", projB)).toBe(
				"missing",
			);
			expect(
				evaluateGitGuard(runtime, cacheManager, projB, "pi", SECONDARY, COMMIT),
			).toEqual({ block: false });
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents (#5052 review, the absorb-sync): a
	// secondary's own settled blocker in checkout A joined B's cache through the
	// gate's absorb-sync, so its commit in B was refused for a file in another
	// tree. A commit is judged by its own repository (#4941).
	it("keeps a secondary's own blocker in another checkout out of the commit's cache and refusal", async () => {
		const env = setupTestEnvironment("pi-lens-5048-own-other-tree-");
		try {
			const { projA, projB, runtime, cacheManager } = twoRoots(env.tmpDir);
			const app = path.join(projA, "app.ts");
			fs.writeFileSync(app, "alpha();\n");
			await settledFor(app, projA, [blocking(app)], SECONDARY);
			expect(
				evaluateGitGuard(runtime, cacheManager, projB, "pi", SECONDARY, COMMIT),
			).toEqual({ block: false });
			expect(cacheManager.inspectCache("turn-end-findings", projB)).toBe(
				"missing",
			);
			expect(
				evaluateGitGuard(runtime, cacheManager, projB, "pi", SECONDARY, COMMIT),
			).toEqual({ block: false });
			// Its own commit in A is still refused on the blocker it owns.
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", SECONDARY, COMMIT)
					.block,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents (#5052 review, the same absorb-sync for the
	// primary): the primary's settled blocker in checkout A was persisted into
	// B's cache, so its commit in B was refused for a file in another tree.
	it("judges the primary's commit in another checkout by that checkout's blockers", async () => {
		const env = setupTestEnvironment("pi-lens-5048-primary-other-tree-");
		try {
			const { projA, projB, runtime, cacheManager } = twoRoots(env.tmpDir);
			const app = path.join(projA, "app.ts");
			fs.writeFileSync(app, "alpha();\n");
			await settledFor(app, projA, [blocking(app)], PRIMARY);
			expect(
				evaluateGitGuard(runtime, cacheManager, projB, "pi", undefined, COMMIT),
			).toEqual({ block: false });
			expect(cacheManager.inspectCache("turn-end-findings", projB)).toBe(
				"missing",
			);
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", undefined, COMMIT)
					.block,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents (#5048 review r1 F1, same root): a secondary's
	// commit in the primary's own root persisted the primary's settled blocker
	// into that root's cache, and the next session there was refused
	// `session_mismatch`. Pins the head: the root's cache stays missing, both
	// secondary commits are refused by the latch, and the primary's own commit
	// is refused. The record-loss window is the accepted p3 residual (PR body).
	it("leaves the primary's settled blocker out of a same-root secondary's commit cache", async () => {
		const env = setupTestEnvironment("pi-lens-5048-same-root-");
		try {
			const { projA, runtime, cacheManager } = twoRoots(env.tmpDir);
			const app = path.join(projA, "app.ts");
			fs.writeFileSync(app, "alpha();\n");
			await settledFor(app, projA, [blocking(app)], PRIMARY);
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", SECONDARY, COMMIT)
					.block,
			).toBe(true);
			expect(cacheManager.inspectCache("turn-end-findings", projA)).toBe(
				"missing",
			);
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", SECONDARY, COMMIT)
					.block,
			).toBe(true);
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", undefined, COMMIT)
					.block,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents (#5048 review r1 F2): a secondary's commit that
	// finds another session's commit-gate record at its root leaves that record
	// in place and records the non-owner write. The gate path reaches
	// `git-guard-non-owner-write`; master wrote no record here.
	it("records a same-root secondary's non-owner write and leaves the primary's record", async () => {
		const env = setupTestEnvironment("pi-lens-5048-non-owner-");
		resetDegradationLedger();
		try {
			const { projA, runtime, cacheManager } = twoRoots(env.tmpDir);
			const app = path.join(projA, "app.ts");
			const other = path.join(projA, "other.ts");
			fs.writeFileSync(app, "alpha();\n");
			fs.writeFileSync(other, "alpha();\n");
			await settledFor(app, projA, [blocking(app)], PRIMARY);
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", undefined, COMMIT)
					.block,
			).toBe(true);
			expect(cacheManager.inspectCache("turn-end-findings", projA)).toBe(
				"fresh",
			);
			await settledFor(other, projA, [blocking(other)], PRIMARY);
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", SECONDARY, COMMIT)
					.block,
			).toBe(true);
			expect(cacheManager.inspectCache("turn-end-findings", projA)).toBe(
				"fresh",
			);
			const row = getDegradationSummary().find(
				(group) => group.kind === "git-guard-non-owner-write",
			);
			expect(row?.count).toBe(1);
			expect(row?.latestReasons[0]?.subject).toBe(SECONDARY);
		} finally {
			resetDegradationLedger();
			env.cleanup();
		}
	});

	// Recurrence it prevents (#5048 review, the retire sync of the same
	// absorb-sync): a clean settled run retired the primary's blocker at the
	// secondary's commit in B, and the retire's resync wrote the secondary's own
	// blocker in checkout A into B's cache, refusing the commit there.
	it("keeps a secondary's blocker in another checkout out of the cache a clean retire rewrites", async () => {
		const env = setupTestEnvironment("pi-lens-5048-retire-other-tree-");
		try {
			const { projA, projB, runtime, cacheManager } = twoRoots(env.tmpDir);
			const app = path.join(projA, "app.ts");
			const other = path.join(projA, "other.ts");
			fs.writeFileSync(app, "alpha();\n");
			fs.writeFileSync(other, "alpha();\n");
			await settledFor(app, projA, [blocking(app)], PRIMARY);
			await settledFor(other, projA, [blocking(other)], SECONDARY);
			// The secondary's own blocker reaches the map through its commit in A.
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", SECONDARY, COMMIT)
					.block,
			).toBe(true);
			// The primary's app.ts settles clean: the next commit retires its blocker.
			await settledFor(app, projA, [], PRIMARY);
			expect(
				evaluateGitGuard(runtime, cacheManager, projB, "pi", SECONDARY, COMMIT),
			).toEqual({ block: false });
			expect(cacheManager.inspectCache("turn-end-findings", projB)).toBe(
				"missing",
			);
		} finally {
			env.cleanup();
		}
	});

	/** A blocker recorded on `file`'s current bytes, as a write records it. */
	function recordOn(
		runtime: RuntimeCoordinator,
		file: string,
		diagnostics: Diagnostic[],
		session?: string,
	): void {
		const bytes = fs.readFileSync(file);
		runtime.recordInlineBlockers(
			file,
			"🔴 STOP",
			runtime.nextWriteIndex(),
			undefined,
			[1],
			{
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
			diagnostics,
			undefined,
			1_000,
			session,
		);
		runtime.updateGitGuardStatus(false, "");
	}

	const otherRunner = (file: string): Diagnostic => ({
		...blocking(file),
		id: "other-runner:app.ts:1",
		tool: "other-runner",
		runnerId: "other-runner",
	});

	// Pins an accepted fail-closed regression (PR #5052 thread
	// PRRT_kwDORt8rec6yNpkM, row S2; maintainer decision 2026-10-31). The retire
	// sync speaks as the committing secondary, so the primary's cached section
	// stays, and the secondary's commit is refused `session_mismatch` until the
	// primary's next commit or write clears it. Master retired it. A clean
	// verdict for the file here (round 2's Remedy B) also dropped another
	// process's section for that file and allowed the commit (row S9, a
	// fail-open). The cure is one owner root per session (#5057): flip this
	// cell when that lands. The recurrence it prevents is a retire verdict that
	// drops a section the committing session does not own.
	it("refuses a same-root secondary's commit until the primary clears its cached section, after its only blocker settles clean", async () => {
		const env = setupTestEnvironment("pi-lens-5052-retire-cached-");
		try {
			const { projA, runtime, cacheManager } = twoRoots(env.tmpDir);
			const app = path.join(projA, "app.ts");
			fs.writeFileSync(app, "alpha();\n");
			await settledFor(app, projA, [blocking(app)], PRIMARY);
			// The primary's own commit persists its section at its root.
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", undefined, COMMIT)
					.block,
			).toBe(true);
			expect(cacheManager.inspectCache("turn-end-findings", projA)).toBe(
				"fresh",
			);
			await settledFor(app, projA, [], PRIMARY);
			const refused = evaluateGitGuard(
				runtime,
				cacheManager,
				projA,
				"pi",
				SECONDARY,
				COMMIT,
			);
			expect(refused.block).toBe(true);
			expect(refused.reason).toContain("session_mismatch");
			expect(runtime.hasInlineBlocker(app)).toBe(false);
			expect(cacheManager.inspectCache("turn-end-findings", projA)).toBe(
				"fresh",
			);
			// Self-clearing: the primary's own next commit retires its section.
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", undefined, COMMIT),
			).toEqual({ block: false });
			expect(cacheManager.inspectCache("turn-end-findings", projA)).toBe(
				"missing",
			);
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", SECONDARY, COMMIT),
			).toEqual({ block: false });
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents (review r2 row S3, Remedy A of the same thread):
	// a retire passed as a clean verdict for the whole file dropped the cached
	// section while another runner's blocker on that file was still live, so a
	// new process read no blocker for it.
	it("keeps the primary's cached section while another runner still blocks the file", async () => {
		const env = setupTestEnvironment("pi-lens-5052-retire-two-runners-");
		try {
			const { projA, runtime, cacheManager } = twoRoots(env.tmpDir);
			const app = path.join(projA, "app.ts");
			fs.writeFileSync(app, "alpha();\n");
			recordOn(runtime, app, [
				{ ...blocking(app), runnerId: RUNNER_ID },
				otherRunner(app),
			]);
			syncGitGuardRecord(runtime, cacheManager, projA);
			await settledFor(app, projA, [], PRIMARY);
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", SECONDARY, COMMIT)
					.block,
			).toBe(true);
			// The settled run retired its own blocker only.
			expect(
				runtime.getInlineBlockerDiagnostics(app)?.map((d) => d.runnerId),
			).toEqual(["other-runner"]);
			expect(cacheManager.inspectCache("turn-end-findings", projA)).toBe(
				"fresh",
			);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents (review r2 G1, row S7): the gate's #5020 retire
	// resync wrote the session's whole snapshot into the commit's cache, so a
	// blocker in checkout A refused the commit in checkout B once a cross-file
	// row there cited a deleted file.
	it("keeps a blocker in another checkout out of the cache the #5020 retire resync writes", () => {
		const env = setupTestEnvironment("pi-lens-5052-5020-other-tree-");
		try {
			const { projA, projB, runtime, cacheManager } = twoRoots(env.tmpDir);
			const a = path.join(projA, "a.ts");
			const x = path.join(projB, "x.yaml");
			fs.writeFileSync(a, "alpha();\n");
			fs.writeFileSync(x, "x: 1\n");
			recordOn(runtime, a, [blocking(a)], SECONDARY);
			// x.yaml's only row cites a file that no longer exists (#5020).
			recordOn(
				runtime,
				x,
				[{ ...blocking(path.join(projB, "gone.yaml")), tool: "helm-lint" }],
				SECONDARY,
			);
			expect(
				evaluateGitGuard(runtime, cacheManager, projB, "pi", SECONDARY, COMMIT),
			).toEqual({ block: false });
			expect(runtime.hasInlineBlocker(x)).toBe(false);
			expect(cacheManager.inspectCache("turn-end-findings", projB)).toBe(
				"missing",
			);
			// The blocker still refuses a commit in its own tree.
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", SECONDARY, COMMIT)
					.block,
			).toBe(true);
		} finally {
			env.cleanup();
		}
	});

	// Recurrence it prevents (review r2 G2, row S8): with the retire sync's
	// session dropped, a same-root secondary's commit that retired one of the
	// primary's blockers persisted the primary's other blocker into the root's
	// cache under the primary's id (the #5048 shape in one root).
	it("leaves the primary's other blockers out of the cache a same-root secondary's retire rewrites", async () => {
		const env = setupTestEnvironment("pi-lens-5052-retire-same-root-");
		try {
			const { projA, runtime, cacheManager } = twoRoots(env.tmpDir);
			const app = path.join(projA, "app.ts");
			const other = path.join(projA, "other.ts");
			for (const file of [app, other]) {
				fs.writeFileSync(file, "alpha();\n");
				recordOn(runtime, file, [{ ...blocking(file), runnerId: RUNNER_ID }]);
			}
			await settledFor(app, projA, [], PRIMARY);
			// The latch still refuses on other.ts; the root's cache stays unwritten.
			expect(
				evaluateGitGuard(runtime, cacheManager, projA, "pi", SECONDARY, COMMIT)
					.block,
			).toBe(true);
			expect(runtime.hasInlineBlocker(app)).toBe(false);
			expect(cacheManager.inspectCache("turn-end-findings", projA)).toBe(
				"missing",
			);
		} finally {
			env.cleanup();
		}
	});
});
