/**
 * Regression test for #2525 — `lsp_client_wait_timeout` (and its sibling
 * `lsp_client_wait_skipped`) named PRE-root candidate servers.
 *
 * Root cause: `LSPService.getClientForFile` built its primary wait set as
 * every non-auxiliary server registered for the extension
 * (`getServersForFileWithConfig(...).filter(s => s.role !== "auxiliary")`)
 * and only resolved each server's root INSIDE the sequential trial loop
 * (`ensureClientForServer`). The `lsp_client_wait_timeout`/`_wait_skipped`
 * records still printed that pre-root list (`servers.map(s => s.id)`), so a
 * plain TypeScript project with no `deno.json` read `serverIds:
 * ["typescript","deno"]` even though DenoServer (`fallbackFor: "typescript"`,
 * root gated on `deno.json(c)`) resolved to no root and never had a spawn
 * slot — the #1550 shape recurring (a record naming a subject that did not
 * act), same as #2524.
 *
 * The fix resolves roots where the RECORDS are emitted — the known-slow and
 * wait-timeout branches, plus the `lsp_client_unavailable` bookkeeping — all
 * of them cold paths, memoized so one acquisition asks a given server at most
 * once. The `lsp_client_wait_timeout`/`lsp_client_wait_skipped` records then
 * list only rooted `serverIds`, plus a separate `unrootedCandidates`
 * `{count, ids}`.
 *
 * Roots are explicitly NOT hoisted to the top of `getClientForFile`: the
 * sequential trial loop needs none of its own (`ensureClientForServer`
 * resolves and bails at `!root` before any spawn work), and `NearestRoot`
 * caches only successful hits, so hoisting charges a full walk to the
 * filesystem root for every unrooted fallback on every touch of every file —
 * including the warm-hit path, which emits no record at all. The
 * root-invocation-count cases below are the guard on that cost.
 *
 * These tests drive the real `getClientForFile` production path (not a
 * hand-fed input) with a two-server config shaped exactly like
 * typescript+deno.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logLatency = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

function fakeProcess(pid: number) {
	return {
		process: { killed: false },
		stdin: {} as any,
		stdout: {} as any,
		stderr: {} as any,
		pid,
	};
}

describe("getClientForFile wait records — unrooted candidates (#2525)", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		createLSPClient.mockResolvedValue({
			isAlive: () => true,
			shutdown: async () => {},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("lsp_client_wait_timeout names only the rooted candidate, not an unrooted deno-style fallback", async () => {
		// vi.useFakeTimers() BEFORE the import/construction (matching the
		// known-slow and L2-partition cases below) — installing it AFTER let a
		// real-timers window into the freshly re-imported module's own
		// (`vi.resetModules()`-fresh) setup, which was flaky under heavy
		// machine contention (an extra lsp_client_wait_timeout record, or an
		// outright hang, in a 53-file concurrent batch).
		vi.useFakeTimers();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Mirrors the real "typescript" primary: resolves a root and spawns,
		// but cold-start takes longer than the caller's wait budget. A
		// never-resolving promise (same idiom as the known-slow and
		// L2-partition cases below) proves "has not settled by the time the
		// budget expires" without a raw timer call of its own (flake-shape:
		// raw-timer-wait); the OUTER wait-budget race is still the
		// production code's own real `setTimeout`, driven deterministically
		// via `vi.advanceTimersByTimeAsync` below instead of racing the real
		// clock.
		const typescriptSpawn = vi.fn(() => new Promise<never>(() => {}));
		// Mirrors the real DenoServer: fallbackFor "typescript", root gated on
		// deno.json(c) which does not exist in this project, so root() resolves
		// to undefined. A throwing spawn keeps the double faithful — an unrooted
		// server has no binary to launch — but the assertion that matters is on
		// the record below; "spawn was not called" holds on the pre-fix code too
		// (`ensureClientForServer` has always bailed at `!root`), so asserting it
		// would be vacuous.
		const denoSpawn = vi.fn(async () => {
			throw new Error("deno must never be attempted without a resolved root");
		});

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: async () => "C:/repo",
				spawn: typescriptSpawn,
			},
			{
				id: "deno",
				name: "Deno",
				fallbackFor: "typescript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: async () => undefined,
				spawn: denoSpawn,
			},
		]);

		const file = "C:/repo/main.ts";
		// maxWaitMs=1 forces the real timeoutSentinel branch well before the
		// never-settling typescript spawn (or any deno attempt) could resolve;
		// advancing fake time fires that budget deterministically instead of
		// racing the real clock.
		const resultPromise = service.getClientForFile(file, 1);
		await vi.advanceTimersByTimeAsync(1);
		const result = await resultPromise;

		expect(result).toBeUndefined();

		const timeoutCalls = logLatency.mock.calls.filter(
			([entry]) => entry?.phase === "lsp_client_wait_timeout",
		);
		expect(timeoutCalls).toHaveLength(1);
		const metadata = timeoutCalls[0][0].metadata as {
			serverIds: string[];
			unrootedCandidates: { count: number; ids: string[] };
			partition?: string;
		};
		expect(metadata.serverIds).toEqual(["typescript"]);
		expect(metadata.unrootedCandidates).toEqual({ count: 1, ids: ["deno"] });
		// The partition resolved well within its own budget — `partition` must
		// be absent here, not unconditionally stamped "timed-out" (round 3, L2).
		expect(metadata.partition).toBeUndefined();
	});

	it("names both candidates when deno.json makes deno a real rooted fallback", async () => {
		// Same fake-timers-before-import ordering as the case above.
		vi.useFakeTimers();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Never-resolving promises (flake-shape: raw-timer-wait) — both spawns
		// only need to have not settled by the time the 1ms budget expires.
		const typescriptSpawn = vi.fn(() => new Promise<never>(() => {}));
		const denoSpawn = vi.fn(() => new Promise<never>(() => {}));

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: async () => "C:/repo",
				spawn: typescriptSpawn,
			},
			{
				id: "deno",
				name: "Deno",
				fallbackFor: "typescript",
				extensions: [".ts"],
				idleEviction: "resident",
				// deno.json IS present in this project: a real resolved root.
				root: async () => "C:/repo",
				spawn: denoSpawn,
			},
		]);

		const file = "C:/repo/main.ts";
		const resultPromise = service.getClientForFile(file, 1);
		await vi.advanceTimersByTimeAsync(1);
		const result = await resultPromise;

		expect(result).toBeUndefined();

		const timeoutCalls = logLatency.mock.calls.filter(
			([entry]) => entry?.phase === "lsp_client_wait_timeout",
		);
		expect(timeoutCalls).toHaveLength(1);
		const metadata = timeoutCalls[0][0].metadata as {
			serverIds: string[];
			unrootedCandidates: { count: number; ids: string[] };
		};
		// Both candidates resolved a root (deno.json present), so both are
		// legitimate wait candidates even though the sequential loop only
		// reached "typescript" before the budget expired.
		expect(metadata.serverIds).toEqual(["typescript", "deno"]);
		expect(metadata.unrootedCandidates).toEqual({ count: 0, ids: [] });
	});

	it("resolves no root for an unrooted fallback on the warm-hit path (hot-path cost guard)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Root-invocation counters ARE the assertion here. `NearestRoot` caches
		// only SUCCESSFUL hits (clients/lsp/server.ts — negatives are
		// deliberately uncached so a scaffolded deno.json is picked up without a
		// restart), so every call on an unrooted candidate is a fresh stat-walk
		// to the filesystem root. A served warm touch must therefore never ask
		// an unrooted fallback for its root at all: `getClientForFile` returns
		// as soon as the primary serves, long before any wait record is emitted.
		const typescriptRoot = vi.fn(async () => "C:/repo");
		const denoRoot = vi.fn(async () => undefined);

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: typescriptRoot,
				spawn: vi.fn(async () => fakeProcess(201)),
			},
			{
				id: "deno",
				name: "Deno",
				fallbackFor: "typescript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: denoRoot,
				spawn: vi.fn(async () => fakeProcess(202)),
			},
		]);

		const file = "C:/repo/main.ts";
		// Touch 1 spawns (cold); touches 2 and 3 hit the published client (warm).
		for (let i = 0; i < 3; i++) {
			expect(await service.getClientForFile(file)).toBeTruthy();
		}

		// The unrooted deno-style fallback is never consulted on a path that was
		// served: no wait record is emitted, so its root is never needed.
		expect(denoRoot).toHaveBeenCalledTimes(0);
		// And the served primary resolves at most once per touch.
		expect(typescriptRoot.mock.calls.length).toBeLessThanOrEqual(3);
	});

	it("lsp_client_wait_skipped names only rooted candidates on the known-slow shortcut", async () => {
		vi.useFakeTimers();
		const { recordSuccessfulLspSpawn } =
			await import("../../../clients/lsp/spawn-history.js");
		// Spawn history says typescript takes 6s; with a 750ms budget the
		// known-slow shortcut fires the moment the spawn is noted in flight.
		recordSuccessfulLspSpawn("typescript", 6_000);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const suspended = new Promise<never>(() => {});
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: async () => "C:/repo",
				spawn: vi.fn(async () => {
					await suspended;
					return fakeProcess(301);
				}),
			},
			{
				id: "deno",
				name: "Deno",
				fallbackFor: "typescript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: async () => undefined,
				spawn: vi.fn(async () => fakeProcess(302)),
			},
		]);

		const result = await service.getClientForFile("C:/repo/main.ts", 750);
		expect(result).toBeUndefined();

		const skippedCalls = logLatency.mock.calls.filter(
			([entry]) => entry?.phase === "lsp_client_wait_skipped",
		);
		expect(skippedCalls).toHaveLength(1);
		const metadata = skippedCalls[0][0].metadata as {
			serverIds: string[];
			unrootedCandidates: { count: number; ids: string[] };
			reason: string;
		};
		expect(metadata.reason).toBe("budget_skipped_known_slow");
		expect(metadata.serverIds).toEqual(["typescript"]);
		expect(metadata.unrootedCandidates).toEqual({ count: 1, ids: ["deno"] });
	});

	it("resolves each candidate's root at most once on an unserved touch", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Neither candidate resolves a root, so nothing is served and the
		// `lsp_client_unavailable` bookkeeping runs. That bookkeeping must not
		// re-walk a root the acquisition attempt already resolved: on a
		// no-root project every extra call is a full walk to the filesystem
		// root (negatives are uncached).
		const typescriptRoot = vi.fn(async () => undefined);
		const denoRoot = vi.fn(async () => undefined);

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: typescriptRoot,
				spawn: vi.fn(async () => fakeProcess(401)),
			},
			{
				id: "deno",
				name: "Deno",
				fallbackFor: "typescript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: denoRoot,
				spawn: vi.fn(async () => fakeProcess(402)),
			},
		]);

		expect(await service.getClientForFile("C:/repo/main.ts")).toBeUndefined();

		expect(typescriptRoot).toHaveBeenCalledTimes(1);
		expect(denoRoot).toHaveBeenCalledTimes(1);
	});

	it("degrades a rejecting root() to an unrooted candidate with a reason, instead of throwing (round 3, F3)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Mirrors case 1's rooted-but-slow primary: forces the real
		// `timeoutSentinel` branch, so `partitionCandidates` runs after the wait
		// race has already settled.
		const typescriptSpawn = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return fakeProcess(601);
		});
		// No SHIPPED `root()` rejects today — every one bottoms out in
		// `markerExists`, which only ever resolves `false` on a miss. This
		// double is deliberately unfaithful to any real server so the test
		// exercises the *robustness* of `partitionCandidates` itself, not a
		// real-world trigger; F3's own review probe showed nothing in
		// `getClientForFile` actually guards against it, so "no shipped root()
		// rejects" was not the same claim as "removed by construction".
		const denoRoot = vi.fn(async () => {
			throw new Error("deno root probe: simulated filesystem error");
		});

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: async () => "C:/repo",
				spawn: typescriptSpawn,
			},
			{
				id: "deno",
				name: "Deno",
				fallbackFor: "typescript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: denoRoot,
				spawn: vi.fn(async () => fakeProcess(602)),
			},
		]);

		const file = "C:/repo/main.ts";
		// Pre-fix, the rejecting root() throws out of `getClientForFile` itself
		// (the bare `Promise.all` inside `partitionCandidates` propagates it) —
		// this `await` is the assertion that matters: it must resolve, not reject.
		const result = await service.getClientForFile(file, 1);

		expect(result).toBeUndefined();

		const timeoutCalls = logLatency.mock.calls.filter(
			([entry]) => entry?.phase === "lsp_client_wait_timeout",
		);
		expect(timeoutCalls).toHaveLength(1);
		const metadata = timeoutCalls[0][0].metadata as {
			serverIds: string[];
			unrootedCandidates: {
				count: number;
				ids: string[];
				reasons?: Record<string, string>;
			};
			partition?: string;
		};
		expect(metadata.serverIds).toEqual(["typescript"]);
		expect(metadata.unrootedCandidates.count).toBe(1);
		expect(metadata.unrootedCandidates.ids).toEqual(["deno"]);
		expect(metadata.unrootedCandidates.reasons?.deno).toContain(
			"deno root probe",
		);
		// The rejection degrades gracefully within the L2 partition budget — it
		// is not the timed-out-and-gave-up-on-everything case, so `partition`
		// must be absent, not stamped "timed-out".
		expect(metadata.partition).toBeUndefined();
	});

	it("bounds partitionCandidates's own root walk so the timeout record still emits when a candidate's root() never resolves (round 3, L2)", async () => {
		vi.useFakeTimers();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				idleEviction: "resident",
				// Never resolves: `resolveServerRootOnce`'s trial-loop call and
				// `partitionCandidates`'s own call share this SAME pending promise
				// via the per-call `rootMemo`, so this reproduces an uncached
				// negative root walk that outlives the wait budget.
				root: () => new Promise(() => {}),
				spawn: vi.fn(async () => fakeProcess(701)),
			},
		]);

		const file = "C:/repo/main.ts";
		const resultPromise = service.getClientForFile(file, 1);

		// The outer wait-budget timer (effectiveMaxWaitMs=1) fires first,
		// selecting the real `timeoutSentinel` branch.
		await vi.advanceTimersByTimeAsync(1);
		// Pre-fix, `partitionCandidates()` here has no bound of its own and
		// would hang forever on the never-resolving `root()`. Advancing past
		// the L2 partition budget (<=250ms) is what proves it is bounded: the
		// promise below only settles because this fires.
		await vi.advanceTimersByTimeAsync(250);

		const result = await resultPromise;
		expect(result).toBeUndefined();

		const timeoutCalls = logLatency.mock.calls.filter(
			([entry]) => entry?.phase === "lsp_client_wait_timeout",
		);
		expect(timeoutCalls).toHaveLength(1);
		const metadata = timeoutCalls[0][0].metadata as {
			serverIds: string[];
			unrootedCandidates: { count: number; ids: string[] };
			partition?: string;
		};
		// Nothing settled within the partition budget, so the record honestly
		// reports "don't know" rather than a false zero-unrooted-candidates.
		expect(metadata.serverIds).toEqual([]);
		expect(metadata.unrootedCandidates).toEqual({ count: 0, ids: [] });
		expect(metadata.partition).toBe("timed-out");
	});
});
