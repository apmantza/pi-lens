/**
 * Tests for clients/lsp/cascade-tier.ts (#458, re-scope №2) — the tier
 * classifier, the outstanding-touch registry/reconcile logic, and the kill
 * switch. The actual "skip the in-lane wait" call site lives in
 * clients/dispatch/integration.ts and is covered by cascade-compute.test.ts;
 * this file unit-tests the standalone policy module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeMapKey } from "../../../clients/path-utils.js";

const getServersForFileWithConfig = vi.fn();
const registerQuietWindowTask = vi.fn();
// Module-scope so the identity survives `vi.resetModules()` — a factory-local
// `vi.fn()` is rebuilt with the module and the assertions would read a
// different spy than the code under test called.
const logCascade = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
}));

vi.mock("../../../clients/quiet-window.js", () => ({
	registerQuietWindowTask,
}));

vi.mock("../../../clients/cascade-logger.js", () => ({
	logCascade,
}));

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency: vi.fn(),
}));

const FILE = "C:/repo/neighbor.ts";

// #1899: the registry now bounds how OLD an outstanding touch may be
// (`OUTSTANDING_TOUCH_MAX_AGE_MS`, 15 minutes), so a touch stamped at an
// absolute `1_000` would read as ~56 years old and be discarded before any
// reconcile saw it. These constants keep a touch inside the age bound while
// staying EXPLICIT relative to one sampled base — the production comparison is
// a strict `entry.ts > touchedAt`, so the ordering must never depend on two
// wall-clock reads landing in different milliseconds.
const NOW_BASE = Date.now();
/** A touch fired 1s ago — well inside the age bound. */
const TOUCH_TS = NOW_BASE - 1_000;
/** A publish that landed after `TOUCH_TS`. */
const PUBLISH_TS = NOW_BASE;

function server(id: string, role?: "language" | "auxiliary") {
	return {
		id,
		name: id,
		extensions: [".ts"],
		root: async () => "C:/repo",
		role,
	};
}

describe("classifyCascadeWaitTier", () => {
	let mod: typeof import("../../../clients/lsp/cascade-tier.js");

	beforeEach(async () => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		registerQuietWindowTask.mockReset();
		mod = await import("../../../clients/lsp/cascade-tier.js");
	});

	it("classifies a push-only, silentOnClean server (typescript) as tier3-silent", () => {
		getServersForFileWithConfig.mockReturnValue([server("typescript")]);
		const snapshots = [
			{
				serverId: "typescript",
				root: "C:/repo",
				operationSupport: {} as any,
				workspaceDiagnosticsSupport: { mode: "push-only" as const },
				advertisedCommands: [],
				rawCapabilityKeys: [],
			},
		];
		const tier = mod.classifyCascadeWaitTier({} as any, FILE, snapshots as any);
		expect(tier).toBe("tier3-silent");
	});

	// #524/#529/#541/#558: "typescript" can be either the classic
	// typescript-language-server or TS7's native `tsc --lsp --stdio` (PR #526).
	// Classic is confirmed silentOnClean (re-measured 2026-07-12, unaffected by
	// the native-ts7 drift below) — the classifier's `launchVariant` branch
	// keeps the classic/unmarked path exactly as before, pinned unchanged.
	it("classifies a classic-variant typescript snapshot with silentOnClean as tier3-silent (pinned, unchanged)", () => {
		getServersForFileWithConfig.mockReturnValue([server("typescript")]);
		const snapshots = [
			{
				serverId: "typescript",
				root: "C:/repo",
				operationSupport: {} as any,
				workspaceDiagnosticsSupport: { mode: "push-only" as const },
				advertisedCommands: [],
				rawCapabilityKeys: [],
				launchVariant: "classic" as const,
			},
		];
		expect(mod.classifyCascadeWaitTier({} as any, FILE, snapshots as any)).toBe(
			"tier3-silent",
		);
	});

	// #541/#558: PR #541 (2026-07-11) briefly classified native-ts7 as
	// tier3-silent after a clean-signal probe run appeared to show it silent,
	// same as classic. A 2026-07-12 dual-environment re-measurement (nightly
	// CI Linux + local Windows dev, same `typescript@7.0.2` both times) found
	// native-ts7 now publishes 2 version-less diagnostic sets on clean
	// (`cleanPubs=2(v:0)`) — NOT silent, a drift from the #541 measurement.
	// Classic was re-confirmed silent in the same run and is unaffected. This
	// The shared policy stays on "waits". The cascade wrapper now uses its late
	// publication through the bounded collect-later path.
	it("classifies a native-ts7 typescript snapshot for cascade collect-later (#1444)", () => {
		getServersForFileWithConfig.mockReturnValue([server("typescript")]);
		const snapshots = [
			{
				serverId: "typescript",
				root: "C:/repo",
				operationSupport: {} as any,
				workspaceDiagnosticsSupport: { mode: "push-only" as const },
				advertisedCommands: [],
				rawCapabilityKeys: [],
				launchVariant: "native-ts7" as const,
			},
		];
		expect(mod.classifyCascadeWaitTier({} as any, FILE, snapshots as any)).toBe(
			"collect-later",
		);
	});

	it("keeps the shared native-ts7 server policy on waits outside cascade", () => {
		const snapshot = {
			serverId: "typescript",
			root: "C:/repo",
			operationSupport: {} as any,
			workspaceDiagnosticsSupport: { mode: "push-only" as const },
			advertisedCommands: [],
			rawCapabilityKeys: [],
			launchVariant: "native-ts7" as const,
		};
		expect(mod.classifyServerWaitTier("typescript", snapshot as any)).toBe(
			"waits",
		);
	});

	it("classifies a typescript snapshot with NO launchVariant marker (older snapshot) as tier3-silent — unchanged today-behavior", () => {
		getServersForFileWithConfig.mockReturnValue([server("typescript")]);
		const snapshots = [
			{
				serverId: "typescript",
				root: "C:/repo",
				operationSupport: {} as any,
				workspaceDiagnosticsSupport: { mode: "push-only" as const },
				advertisedCommands: [],
				rawCapabilityKeys: [],
				// no launchVariant field at all
			},
		];
		expect(mod.classifyCascadeWaitTier({} as any, FILE, snapshots as any)).toBe(
			"tier3-silent",
		);
	});

	it("classifies a pull-mode server as pull-capable", () => {
		getServersForFileWithConfig.mockReturnValue([server("rust-analyzer")]);
		const snapshots = [
			{
				serverId: "rust-analyzer",
				root: "C:/repo",
				operationSupport: {} as any,
				workspaceDiagnosticsSupport: { mode: "pull" as const },
				advertisedCommands: [],
				rawCapabilityKeys: [],
			},
		];
		expect(mod.classifyCascadeWaitTier({} as any, FILE, snapshots as any)).toBe(
			"pull-capable",
		);
	});

	it("classifies an unobserved custom no-provider server as diagnostics-unsupported", () => {
		const snapshot = {
			serverId: "dexter",
			root: "C:/repo",
			customServer: true,
			operationSupport: {} as any,
			workspaceDiagnosticsSupport: { mode: "push-only" as const },
			advertisedCommands: [],
			rawCapabilityKeys: [],
		};
		expect(mod.classifyServerWaitTier("dexter", snapshot as any)).toBe(
			"diagnostics-unsupported",
		);
	});

	it("latches a custom server to normal waits after any publish", () => {
		const snapshot = {
			serverId: "dexter",
			root: "C:/repo",
			customServer: true,
			diagnosticsPublished: true,
			operationSupport: {} as any,
			workspaceDiagnosticsSupport: { mode: "push-only" as const },
			advertisedCommands: [],
			rawCapabilityKeys: [],
		};
		expect(mod.classifyServerWaitTier("dexter", snapshot as any)).toBe("waits");
	});

	it("classifies a push-only server WITHOUT silentOnClean (e.g. pyright, tier 2) as waits", () => {
		getServersForFileWithConfig.mockReturnValue([server("python")]);
		const snapshots = [
			{
				serverId: "python",
				root: "C:/repo",
				operationSupport: {} as any,
				workspaceDiagnosticsSupport: { mode: "push-only" as const },
				advertisedCommands: [],
				rawCapabilityKeys: [],
			},
		];
		expect(mod.classifyCascadeWaitTier({} as any, FILE, snapshots as any)).toBe(
			"waits",
		);
	});

	it("fails safe to waits when there's no live snapshot for the primary server yet", () => {
		getServersForFileWithConfig.mockReturnValue([server("typescript")]);
		expect(mod.classifyCascadeWaitTier({} as any, FILE, [])).toBe("waits");
	});

	it("fails safe to waits when there are no configured servers for the file", () => {
		getServersForFileWithConfig.mockReturnValue([]);
		expect(mod.classifyCascadeWaitTier({} as any, FILE, [])).toBe("waits");
	});

	it("only considers the primary (non-auxiliary) server", () => {
		getServersForFileWithConfig.mockReturnValue([
			server("typescript"),
			server("opengrep", "auxiliary"),
		]);
		const snapshots = [
			{
				serverId: "opengrep",
				root: "C:/repo",
				operationSupport: {} as any,
				workspaceDiagnosticsSupport: { mode: "push-only" as const },
				advertisedCommands: [],
				rawCapabilityKeys: [],
			},
			{
				serverId: "typescript",
				root: "C:/repo",
				operationSupport: {} as any,
				workspaceDiagnosticsSupport: { mode: "push-only" as const },
				advertisedCommands: [],
				rawCapabilityKeys: [],
			},
		];
		// The auxiliary snapshot (opengrep) must not be mistaken for the primary's.
		expect(mod.classifyCascadeWaitTier({} as any, FILE, snapshots as any)).toBe(
			"tier3-silent",
		);
	});
});

describe("outstanding touch registry + reconcile", () => {
	let mod: typeof import("../../../clients/lsp/cascade-tier.js");

	beforeEach(async () => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		registerQuietWindowTask.mockReset();
		mod = await import("../../../clients/lsp/cascade-tier.js");
		mod._resetOutstandingCascadeTouchesForTests();
	});

	afterEach(() => {
		mod._resetOutstandingCascadeTouchesForTests();
	});

	/** Warm client whose per-file diagnostics map is given as [path, diags, ts] rows. */
	function warmClient(
		serverId: string,
		rows: Array<[string, unknown[], number]>,
	) {
		const map = new Map(
			rows.map(([p, diags, ts]) => [
				// getAllDiagnostics keys by normalizeMapKey — use the REAL
				// normalizer, never a hand-rolled replace: on a POSIX runner
				// normalizeMapKey lowercases a nonexistent Windows-style path
				// ("C:/repo/…" → "c:/repo/…"), so a hand-keyed fake map matches
				// on Windows but misses on Linux CI (the #210 path-key lesson).
				normalizeMapKey(p),
				{ diags, ts },
			]),
		);
		return {
			client: {
				serverId,
				getAllDiagnostics: vi.fn().mockReturnValue(map),
			},
		};
	}

	// Timestamps in these tests are EXPLICIT constants, never Date.now(): on a
	// fast CI box a wall-clock touchedAt and a wall-clock entry ts can land in
	// the SAME millisecond, and the production comparison is deliberately a
	// strict `entry.ts > touchedAt` (ties fail safe to unresolved), so
	// real-clock sampling makes these tests non-deterministic.
	const TOUCHED_AT = TOUCH_TS;
	const AFTER_TOUCH = PUBLISH_TS;
	const BEFORE_TOUCH = TOUCH_TS - 500;

	it("resolves an outstanding touch as resolved-found when THAT FILE's diagnostics published after the touch", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt: TOUCHED_AT,
		});

		const lspService = {
			getWarmClientForFile: vi
				.fn()
				.mockResolvedValue(
					warmClient("typescript", [[FILE, [{ message: "err" }], AFTER_TOUCH]]),
				),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			outcome: "resolved-found",
			diagnosticCount: 1,
		});
		// Registry is drained after reconcile.
		expect(mod._getOutstandingCascadeTouchesForTests()).toHaveLength(0);
	});

	it("resolves an outstanding touch as resolved-clean only when an empty publish for THAT FILE arrived after the touch", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt: TOUCHED_AT,
		});

		const lspService = {
			getWarmClientForFile: vi
				.fn()
				.mockResolvedValue(warmClient("typescript", [[FILE, [], AFTER_TOUCH]])),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0]).toMatchObject({
			outcome: "resolved-clean",
			diagnosticCount: 0,
		});
	});

	it("records unresolved — NEVER clean — when nothing published for the file by settle time (#240 doctrine)", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt: TOUCHED_AT,
		});

		const lspService = {
			getWarmClientForFile: vi
				.fn()
				// Client is warm but holds NO entry for this file at all.
				.mockResolvedValue(warmClient("typescript", [])),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
	});

	it("records unresolved when the only per-file entry PREDATES the touch (stale publish is not an answer)", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt: TOUCHED_AT,
		});

		const lspService = {
			getWarmClientForFile: vi
				.fn()
				.mockResolvedValue(
					warmClient("typescript", [[FILE, [], BEFORE_TOUCH]]),
				),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
	});

	it("records unresolved on an exact timestamp tie (ts === touchedAt) — ties resolve fail-safe", async () => {
		// The production comparison is a strict `entry.ts > touchedAt` by
		// design: a publish in the same millisecond as the pre-notify sample
		// cannot be proven post-touch, so it must not count as an answer.
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt: TOUCHED_AT,
		});

		const lspService = {
			getWarmClientForFile: vi
				.fn()
				.mockResolvedValue(warmClient("typescript", [[FILE, [], TOUCHED_AT]])),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
	});

	it("a sibling file's publish on the SAME client must not prove a silent neighbor clean (cross-file poisoning)", async () => {
		// Two neighbors touched on one tsserver client: A publishes findings,
		// B stays silent. Any client-wide freshness signal (e.g. the client's
		// diagnosticsVersion counter) would have advanced because of A — B must
		// still reconcile as unresolved, never resolved-clean (#240).
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/a.ts",
			serverId: "typescript",
			touchedAt: TOUCHED_AT,
		});
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/b.ts",
			serverId: "typescript",
			touchedAt: TOUCHED_AT,
		});

		// ONE shared client: only a.ts has a post-touch publish entry.
		const shared = warmClient("typescript", [
			["C:/repo/a.ts", [{ message: "err in a" }], AFTER_TOUCH],
		]);
		const lspService = {
			getWarmClientForFile: vi.fn().mockResolvedValue(shared),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes).toHaveLength(2);
		const byFile = Object.fromEntries(
			outcomes.map((o) => [o.filePath, o.outcome]),
		);
		expect(byFile["C:/repo/a.ts"]).toBe("resolved-found");
		expect(byFile["C:/repo/b.ts"]).toBe("unresolved");
	});

	it("records unresolved on a warm-miss (client idle-reaped) — reconcile must NEVER spawn a server", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt: TOUCHED_AT,
		});

		const getWarmClientForFile = vi.fn().mockResolvedValue(undefined);
		const lspService = { getWarmClientForFile };
		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
		// The warm-only accessor is the ONLY lookup used — no get-or-create.
		expect(getWarmClientForFile).toHaveBeenCalledTimes(1);
	});

	it("records unresolved when a different server now owns the file", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt: TOUCHED_AT,
		});

		const lspService = {
			getWarmClientForFile: vi
				.fn()
				.mockResolvedValue(warmClient("deno", [[FILE, [], AFTER_TOUCH]])),
		};
		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
	});

	it("records unresolved (never throws) when the client lookup itself rejects", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: FILE,
			serverId: "typescript",
			touchedAt: TOUCHED_AT,
		});

		const lspService = {
			getWarmClientForFile: vi.fn().mockRejectedValue(new Error("boom")),
		};
		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes[0].outcome).toBe("unresolved");
	});

	it("drains and resolves multiple outstanding touches independently", async () => {
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/a.ts",
			serverId: "typescript",
			touchedAt: TOUCHED_AT,
		});
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/b.ts",
			serverId: "typescript",
			touchedAt: TOUCHED_AT,
		});

		const lspService = {
			getWarmClientForFile: vi
				.fn()
				.mockImplementation(async (filePath: string) => {
					if (filePath.endsWith("a.ts")) {
						return warmClient("typescript", [
							["C:/repo/a.ts", [], AFTER_TOUCH],
						]);
					}
					return undefined; // b.ts's client vanished
				}),
		};

		const outcomes = await mod.reconcileOutstandingCascadeTouches(
			lspService as any,
		);
		expect(outcomes).toHaveLength(2);
		const byFile = Object.fromEntries(
			outcomes.map((o) => [o.filePath, o.outcome]),
		);
		expect(byFile["C:/repo/a.ts"]).toBe("resolved-clean");
		expect(byFile["C:/repo/b.ts"]).toBe("unresolved");
	});
});

describe("registerCascadeTierReconcileTask", () => {
	let mod: typeof import("../../../clients/lsp/cascade-tier.js");

	beforeEach(async () => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		registerQuietWindowTask.mockReset();
		mod = await import("../../../clients/lsp/cascade-tier.js");
		mod._resetOutstandingCascadeTouchesForTests();
		mod._resetCascadeTierReconcileRegistrationForTests();
	});

	it("registers exactly one quiet-window task, idempotently", () => {
		mod.registerCascadeTierReconcileTask(() => ({}) as any);
		mod.registerCascadeTierReconcileTask(() => ({}) as any);
		expect(registerQuietWindowTask).toHaveBeenCalledTimes(1);
		expect(registerQuietWindowTask).toHaveBeenCalledWith(
			"cascade_tier3_reconcile",
			expect.any(Function),
		);
	});

	// #1899: an empty registry used to return before the log line, so "the
	// backlog is drained" and "the sweep never ran" read identically in
	// cascade.log. The sweep now always emits its gauge.
	it("the registered task emits a zero gauge when the registry is empty", async () => {
		logCascade.mockClear();
		mod.registerCascadeTierReconcileTask(
			() =>
				({
					getWarmClientForFile: vi.fn(),
				}) as any,
		);
		const task = registerQuietWindowTask.mock
			.calls[0][1] as () => Promise<void>;
		await expect(task()).resolves.toBeUndefined();

		expect(logCascade).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "cascade_tier3_reconcile",
				metadata: expect.objectContaining({
					count: 0,
					unresolved: 0,
					avgAgeMs: 0,
					expired: 0,
					evicted: 0,
				}),
			}),
		);
	});

	// #1023: a resolved-found neighbor error must be RE-INJECTED to the agent
	// (previously logs-only). The task invokes onResolvedFound with the published
	// diagnostics so the caller can append it to the turn-end cascade seam.
	it("re-injects a resolved-found neighbor via onResolvedFound (not logs-only)", async () => {
		const onResolvedFound = vi.fn();
		const warm = {
			client: {
				serverId: "typescript",
				getAllDiagnostics: vi.fn().mockReturnValue(
					new Map([
						[
							normalizeMapKey("C:/repo/neighbor.ts"),
							{
								diags: [{ message: "cold neighbor err", severity: 1 }],
								ts: PUBLISH_TS,
							},
						],
					]),
				),
			},
		};
		mod.registerCascadeTierReconcileTask(
			() => ({ getWarmClientForFile: vi.fn().mockResolvedValue(warm) }) as any,
			{ onResolvedFound },
		);
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/neighbor.ts",
			serverId: "typescript",
			touchedAt: TOUCH_TS,
		});
		const task = registerQuietWindowTask.mock
			.calls[0][1] as () => Promise<void>;
		await task();

		expect(onResolvedFound).toHaveBeenCalledTimes(1);
		expect(onResolvedFound).toHaveBeenCalledWith(
			expect.objectContaining({
				filePath: "C:/repo/neighbor.ts",
				serverId: "typescript",
				diagnostics: [
					expect.objectContaining({ message: "cold neighbor err" }),
				],
			}),
		);
	});

	// #1023 boundary: a resolved-CLEAN outcome (empty publish) must NOT re-inject.
	it("does not re-inject on a resolved-clean outcome", async () => {
		const onResolvedFound = vi.fn();
		const warm = {
			client: {
				serverId: "typescript",
				getAllDiagnostics: vi
					.fn()
					.mockReturnValue(
						new Map([
							[
								normalizeMapKey("C:/repo/neighbor.ts"),
								{ diags: [], ts: PUBLISH_TS },
							],
						]),
					),
			},
		};
		mod.registerCascadeTierReconcileTask(
			() => ({ getWarmClientForFile: vi.fn().mockResolvedValue(warm) }) as any,
			{ onResolvedFound },
		);
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/neighbor.ts",
			serverId: "typescript",
			touchedAt: TOUCH_TS,
		});
		const task = registerQuietWindowTask.mock
			.calls[0][1] as () => Promise<void>;
		await task();

		expect(onResolvedFound).not.toHaveBeenCalled();
	});

	// #1444 (issue impact #2): the mirror case. A resolved-CLEAN outcome is a
	// CONFIRMED observation (a per-file publish that landed after the touch), and
	// it is the only thing that can clear the neighbour's now-stale footer errors
	// — the skipped in-lane wait never reconciled anything. It must be handed to
	// the caller with the publish timestamp as the observation time.
	it("hands a resolved-clean outcome to onResolvedClean with its publish time", async () => {
		const onResolvedFound = vi.fn();
		const onResolvedClean = vi.fn();
		const warm = {
			client: {
				serverId: "typescript",
				getAllDiagnostics: vi
					.fn()
					.mockReturnValue(
						new Map([
							[
								normalizeMapKey("C:/repo/neighbor.ts"),
								{ diags: [], ts: PUBLISH_TS },
							],
						]),
					),
			},
		};
		mod.registerCascadeTierReconcileTask(
			() => ({ getWarmClientForFile: vi.fn().mockResolvedValue(warm) }) as any,
			{ onResolvedFound, onResolvedClean },
		);
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/neighbor.ts",
			serverId: "typescript",
			touchedAt: TOUCH_TS,
		});
		const task = registerQuietWindowTask.mock
			.calls[0][1] as () => Promise<void>;
		await task();

		expect(onResolvedFound).not.toHaveBeenCalled();
		expect(onResolvedClean).toHaveBeenCalledTimes(1);
		expect(onResolvedClean).toHaveBeenCalledWith({
			filePath: "C:/repo/neighbor.ts",
			serverId: "typescript",
			publishedAt: PUBLISH_TS,
		});
	});

	// #240 doctrine: an UNRESOLVED touch is not a clean answer, so it must never
	// reach the footer-clearing callback.
	it("never calls onResolvedClean for an unresolved touch", async () => {
		const onResolvedClean = vi.fn();
		const warm = {
			client: {
				serverId: "typescript",
				// Nothing published for the file since the touch.
				getAllDiagnostics: vi.fn().mockReturnValue(new Map()),
			},
		};
		mod.registerCascadeTierReconcileTask(
			() => ({ getWarmClientForFile: vi.fn().mockResolvedValue(warm) }) as any,
			{ onResolvedClean },
		);
		mod.recordOutstandingCascadeTouch({
			filePath: "C:/repo/neighbor.ts",
			serverId: "typescript",
			touchedAt: TOUCH_TS,
		});
		const task = registerQuietWindowTask.mock
			.calls[0][1] as () => Promise<void>;
		await task();

		expect(onResolvedClean).not.toHaveBeenCalled();
	});
});

describe("isTierAwareCascadeEnabled kill switch", () => {
	let mod: typeof import("../../../clients/lsp/cascade-tier.js");
	const originalEnv = process.env.PI_LENS_TIER_AWARE_CASCADE;

	beforeEach(async () => {
		vi.resetModules();
		delete process.env.PI_LENS_TIER_AWARE_CASCADE;
		mod = await import("../../../clients/lsp/cascade-tier.js");
		mod._resetTierAwareCascadeEnabledForTests();
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.PI_LENS_TIER_AWARE_CASCADE;
		} else {
			process.env.PI_LENS_TIER_AWARE_CASCADE = originalEnv;
		}
	});

	it("defaults to enabled", () => {
		expect(mod.isTierAwareCascadeEnabled()).toBe(true);
	});

	it("PI_LENS_TIER_AWARE_CASCADE=0 disables it", () => {
		process.env.PI_LENS_TIER_AWARE_CASCADE = "0";
		mod._resetTierAwareCascadeEnabledForTests();
		expect(mod.isTierAwareCascadeEnabled()).toBe(false);
	});

	it("any other value keeps it enabled", () => {
		process.env.PI_LENS_TIER_AWARE_CASCADE = "false";
		mod._resetTierAwareCascadeEnabledForTests();
		expect(mod.isTierAwareCascadeEnabled()).toBe(true);
	});

	it("memoizes the read (module-level cache, like isQuietWindowEnabled)", () => {
		expect(mod.isTierAwareCascadeEnabled()).toBe(true);
		process.env.PI_LENS_TIER_AWARE_CASCADE = "0";
		// Still true — cached until _resetTierAwareCascadeEnabledForTests().
		expect(mod.isTierAwareCascadeEnabled()).toBe(true);
	});
});
