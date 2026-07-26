/**
 * #667: neither `lsp_diagnostics` nor `lens_diagnostics` had a warm-check
 * step before starting their per-file sweep loop. `serverCountReady:1` only
 * proves the server process spawned and passed the LSP `initialize`
 * handshake — a tsserver-style server can still be loading/indexing the
 * project internally for seconds after that, so whichever file(s) land
 * first in a sweep paid that cost as individual per-file timeouts (observed:
 * the first 5 files of a real 100-file sweep all hit the exact per-file
 * ceiling with `serverCountReady:1`, file 6 onward clean and fast).
 *
 * `LSPService.ensureWarmForSweep` (clients/lsp/index.ts) is the ONE shared
 * fix both tools route through: a real "has this server already answered a
 * confirmed diagnostics touch this session" check (`isDemonstratedReady`,
 * set by `touchFile` on a non-inconclusive diagnostics-mode result), not
 * just `isAlive()`. Cold → exactly one bounded warm-up round trip before the
 * real sweep. Already-warm → a no-op, no extra round trip, no added latency
 * — this file also guards the "must not become a mandatory extra round trip
 * every time" regression the issue explicitly calls out.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

function makeTsServer(root: string) {
	return {
		id: "typescript",
		name: "typescript",
		extensions: [".ts"],
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

/** Fake client: one shared instance (real servers are single per project root). */
function makeFakeClient(root: string, serverId = "typescript") {
	const waitCalls: Array<{ filePath: string; ms: number }> = [];
	return {
		client: {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			getAdvertisedCommands: () => [],
			getRawCapabilityKeys: () => [],
			serverId,
			root,
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(async (filePath: string, ms: number) => {
				waitCalls.push({ filePath, ms });
				return undefined;
			}),
			getDiagnostics: vi.fn(() => []),
		},
		waitCalls,
	};
}

describe("LSPService.ensureWarmForSweep (#667)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-warmup-"));
	});
	afterEach(() => removeTempDirSync(tmp));

	it("performs exactly one warm-up round trip against a cold server, then treats it as warm (pure decision-logic: fake client state)", async () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const x = 1;\n");
		const tsServer = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmp);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Cold: server has never answered a diagnostics touch — must perform
		// the warm-up round trip.
		const first = await service.ensureWarmForSweep(filePath);
		expect(first.performedWarmup).toBe(true);
		expect(waitCalls.length).toBe(1);

		// Now warm (the warm-up touch itself confirmed diagnostics, marking the
		// client ready) — calling again must be a no-op: no extra round trip.
		const second = await service.ensureWarmForSweep(filePath);
		expect(second.performedWarmup).toBe(false);
		expect(waitCalls.length).toBe(1); // unchanged — no new round trip
	});

	it("#832: skips the generic cold floor for a workspace-indexing server classified silent-on-clean", async () => {
		const filePath = path.join(tmp, "cold.md");
		fs.writeFileSync(filePath, "# clean\n");
		const marksman = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmp, "marksman");
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		await service.ensureWarmForSweep(filePath, { timeoutMs: 20000 });

		// Marksman's configured 1500ms workspace-indexing budget is enough for
		// the first attempt. Before #832, warmupOverride turned this into the
		// generic 20000ms cold floor.
		expect(waitCalls).toHaveLength(1);
		expect(waitCalls[0]!.ms).toBe(1500);
	});

	it("#669: gives a cold server the FULL requested warm-up budget, not the strategy's short steady-state aggregateWaitMs (regression: perServerTimeout's Math.min ceiling silently shrank a 20000ms ask down to typescript's 1000ms aggregateWaitMs)", async () => {
		const filePath = path.join(tmp, "cold.ts");
		fs.writeFileSync(filePath, "const x = 1;\n");
		const tsServer = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmp);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// typescript's real strategy aggregateWaitMs is 1000ms (server-strategies.ts)
		// — far below the 20000ms warm-up budget requested here. Before the fix,
		// `perServerTimeout`'s `Math.min(callerCap, strategyWait)` silently capped
		// the actual `waitForDiagnostics` call at 1000ms regardless of what was
		// asked for.
		const result = await service.ensureWarmForSweep(filePath, {
			timeoutMs: 20000,
		});
		expect(result.performedWarmup).toBe(true);
		expect(waitCalls.length).toBe(1);
		expect(waitCalls[0]!.ms).toBe(20000);
	});

	it("is a no-op for a server that already answered a real touchFile diagnostics call earlier in the session", async () => {
		const filePath = path.join(tmp, "b.ts");
		fs.writeFileSync(filePath, "const y = 2;\n");
		const tsServer = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmp);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Simulate an ordinary (non-sweep) per-edit touch earlier in the
		// session already confirming this server can answer diagnostics.
		await service.touchFile(filePath, "const y = 2;\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "primary",
			source: "test_prior_touch",
		});
		expect(waitCalls.length).toBe(1);

		const result = await service.ensureWarmForSweep(filePath);
		expect(result.performedWarmup).toBe(false);
		expect(waitCalls.length).toBe(1); // no extra round trip on top of the prior touch
	});
});

describe("runWorkspaceDiagnostics sweep-level warm-up behavior (#667)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-warmup-sweep-"));
	});
	afterEach(() => removeTempDirSync(tmp));

	it("a cold sweep pays exactly one extra warm-up round trip before the per-file loop, on top of the normal per-file touches", async () => {
		const names = ["a.ts", "b.ts", "c.ts"];
		for (const n of names) fs.writeFileSync(path.join(tmp, n), "const z = 1;\n");
		const tsServer = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmp);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const results = await service.runWorkspaceDiagnostics(tmp);

		expect(results.length).toBe(3);
		// 3 real per-file sweep touches + exactly 1 extra warm-up round trip
		// against whichever file the sweep grouped first — NOT a blind delay
		// per file, one deliberate warm-up for the whole (single-server) group.
		expect(waitCalls.length).toBe(4);
	});

	it("a sweep against an already-warm server (demonstrated ready from a prior touch this session) skips the warm-up round trip entirely — no added latency", async () => {
		const names = ["a.ts", "b.ts", "c.ts"];
		for (const n of names) fs.writeFileSync(path.join(tmp, n), "const z = 1;\n");
		const tsServer = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [tsServer] : [],
		);
		const { client, waitCalls } = makeFakeClient(tmp);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Warm the server up front via an ordinary confirmed touch (mirrors an
		// earlier tool call / earlier sweep in the same session).
		const primed = path.join(tmp, "a.ts");
		await service.touchFile(primed, "const z = 1;\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "primary",
			source: "test_prior_touch",
		});
		expect(waitCalls.length).toBe(1);

		const results = await service.runWorkspaceDiagnostics(tmp);
		expect(results.length).toBe(3);
		// Exactly the 3 real per-file touches — the pre-sweep warm-up check
		// found the server already demonstrated ready and skipped it (no 4th,
		// warm-up-only call).
		expect(waitCalls.length).toBe(1 + 3);
	});
});

/**
 * #744: a warm-up that TIMES OUT used to be a silent dead end — no re-warm, no
 * backoff, no skip — so a wedged `workspaceIndexing` server (marksman, observed
 * live burning the full 20s and staying cold) had every subsequent per-file
 * touch re-pay a full per-file budget against it and time out again, dragging
 * the whole sweep. These tests pin the new behavior: one retry on a failed
 * warm-up, and if the retry also fails the server is reported in
 * `failedServerIds` and its files are skipped for the rest of the sweep and
 * reported UNCONFIRMED (not confirmed-clean).
 *
 * #799: marksman itself is now `silentOnClean: true` (`server-strategies.ts`)
 * — a real timeout for it (no publish, notify succeeded) is CONFIRMED clean,
 * not a failed warm-up (see `silent-clean-confirm.test.ts`). These "genuinely
 * still cold" tests use a fictitious server id (`workspace-indexer-generic`,
 * not present in `SERVER_DIAGNOSTIC_STRATEGIES`, so it falls back to
 * `DEFAULT_STRATEGY` with `silentOnClean` unset) to keep exercising the
 * distinct "the server truly never answered" failure mode the #744
 * retry/skip machinery (and #799's negative cache) exists for.
 */
function makeServer(id: string, ext: string, root: string) {
	return {
		id,
		name: id,
		extensions: [ext],
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

/**
 * Fake client whose per-call warm-up outcome is scripted: each
 * `waitForDiagnostics` call consumes the next entry of `plan` ("timeout" =
 * resolve `undefined` AT the server's deadline, so `touchFile` records the
 * touch as inconclusive → the server never becomes `demonstratedReady`; "warm"
 * = resolve immediately, a confirmed clean result). `plan` is padded with its
 * last entry so a plan shorter than the number of calls keeps that outcome.
 */
function makeControlledClient(
	serverId: string,
	root: string,
	plan: Array<"timeout" | "warm">,
) {
	const waitCalls: Array<{ filePath: string; ms: number }> = [];
	let call = 0;
	return {
		client: {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			serverId,
			root,
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(async (filePath: string, ms: number) => {
				const outcome = plan[Math.min(call, plan.length - 1)] ?? "warm";
				call += 1;
				waitCalls.push({ filePath, ms });
				if (outcome === "timeout") {
					// Mirror a real client resolving `undefined` at its own deadline:
					// `touchFile`'s `waitedMs >= timeoutMs` sets `diagnosticsTimedOut`,
					// so the touch is inconclusive and the server is NOT marked ready.
					await new Promise<void>((resolve) => {
						const t = setTimeout(resolve, ms);
						t.unref?.();
					});
				}
				return undefined;
			}),
			getDiagnostics: vi.fn(() => []),
		},
		waitCalls,
	};
}

describe("LSPService.ensureWarmForSweep warm-up retry/skip (#744)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-warmup-744-"));
		// Flat, tiny per-server diagnostics budget so a scripted "timeout" resolves
		// in ~50ms instead of a real multi-second strategy budget — keeps the tests
		// fast and deterministic without changing the code path under test.
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "50";
		// No real backoff between the attempt and its retry.
		process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS = "0";
	});
	afterEach(() => {
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		delete process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS;
		removeTempDirSync(tmp);
	});

	it("retries exactly once when the first warm-up times out, then reports the still-cold server in failedServerIds", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const genericServer = makeServer("workspace-indexer-generic", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [genericServer] : [],
		);
		const { client, waitCalls } = makeControlledClient(
			"workspace-indexer-generic",
			tmp,
			["timeout", "timeout"],
		);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.ensureWarmForSweep(filePath, {
			timeoutMs: 500,
		});
		expect(result.performedWarmup).toBe(true);
		// Both attempts left the server cold → it's reported failed for this sweep.
		expect(result.failedServerIds).toEqual(["workspace-indexer-generic"]);
		// Exactly two warm-up round trips: the initial attempt + one retry. Not
		// one (no retry), not three (retry must fire at most once).
		expect(waitCalls.length).toBe(2);
	});

	it("a server that warms on the retry participates normally (no failure, and a later warm-check is a no-op)", async () => {
		const filePath = path.join(tmp, "b.md");
		fs.writeFileSync(filePath, "# hi\n");
		const genericServer = makeServer("workspace-indexer-generic", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [genericServer] : [],
		);
		const { client, waitCalls } = makeControlledClient(
			"workspace-indexer-generic",
			tmp,
			["timeout", "warm"],
		);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.ensureWarmForSweep(filePath, {
			timeoutMs: 500,
		});
		expect(result.performedWarmup).toBe(true);
		expect(result.failedServerIds).toEqual([]);
		expect(waitCalls.length).toBe(2); // initial timeout + successful retry

		// The retry confirmed the server ready, so a later warm-check is a no-op.
		const again = await service.ensureWarmForSweep(filePath, { timeoutMs: 500 });
		expect(again.performedWarmup).toBe(false);
		expect(again.failedServerIds).toEqual([]);
		expect(waitCalls.length).toBe(2); // unchanged — no extra round trip
	});

	it("a sweep skips a group whose primary server fails warm-up (initial + retry), reporting its files as unconfirmed/skipped rather than clean, while a healthy group runs normally", async () => {
		fs.writeFileSync(path.join(tmp, "a.md"), "# a\n");
		fs.writeFileSync(path.join(tmp, "b.md"), "# b\n");
		fs.writeFileSync(path.join(tmp, "c.ts"), "const z = 1;\n");
		const genericServer = makeServer("workspace-indexer-generic", ".md", tmp);
		const ts = makeServer("typescript", ".ts", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [genericServer] : fp.endsWith(".ts") ? [ts] : [],
		);
		// genericServer never warms (perpetual timeout); typescript warms immediately.
		const genericClient = makeControlledClient(
			"workspace-indexer-generic",
			tmp,
			["timeout"],
		);
		const tsClient = makeControlledClient("typescript", tmp, ["warm"]);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			opts.serverId === "workspace-indexer-generic"
				? genericClient.client
				: tsClient.client,
		);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const results = await service.runWorkspaceDiagnostics(tmp);

		const byPath = new Map(results.map((r) => [path.basename(r.filePath), r]));
		// Both markdown files: skipped after failed warm-up — reported UNCONFIRMED
		// (timedOut) with the explicit skip reason, never confirmed-clean.
		for (const name of ["a.md", "b.md"]) {
			const r = byPath.get(name)!;
			expect(r.timedOut).toBe(true);
			expect(
				(r as { skippedWarmupFailure?: boolean }).skippedWarmupFailure,
			).toBe(true);
			expect(r.count).toBe(0);
		}
		// The healthy TypeScript group ran normally: confirmed, not skipped.
		const cts = byPath.get("c.ts")!;
		expect(cts.timedOut).toBeFalsy();
		expect(
			(cts as { skippedWarmupFailure?: boolean }).skippedWarmupFailure,
		).toBeUndefined();

		// genericServer was touched ONLY by the two warm-up attempts — its per-file
		// touches were skipped, so it never re-paid its timeout per markdown file
		// (that would be 2 warm-up + 2 per-file = 4). This is the drag this fixes.
		expect(genericClient.waitCalls.length).toBe(2);
	});
});

/**
 * #799: a warm-up that ends inconclusive (initial + retry both leave a
 * server cold) used to have NO memory across sweeps — a follow-up sweep in
 * the same session re-paid the full initial-attempt + retry round trip all
 * over again (observed live: "follow-up sweep re-paid everything"). The
 * negative cache (`LSPState.demonstratedCold`) fixes that: a server known
 * cold this session skips straight to the existing #744 group-skip
 * accounting, and the cache is session-scoped — a brand new `LSPService`
 * (what `resetLSPService` produces) starts clean.
 */
describe("LSPService.ensureWarmForSweep negative cache (#799)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-warmup-799-"));
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "50";
		process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS = "0";
	});
	afterEach(() => {
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		delete process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS;
		removeTempDirSync(tmp);
	});

	it("a follow-up sweep against a server that stayed cold last time skips warm-up entirely instead of re-paying it", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const genericServer = makeServer("workspace-indexer-generic", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [genericServer] : [],
		);
		const { client, waitCalls } = makeControlledClient(
			"workspace-indexer-generic",
			tmp,
			["timeout", "timeout"],
		);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const first = await service.ensureWarmForSweep(filePath, { timeoutMs: 500 });
		expect(first.performedWarmup).toBe(true);
		expect(first.failedServerIds).toEqual(["workspace-indexer-generic"]);
		expect(waitCalls.length).toBe(2); // initial attempt + retry

		// A follow-up sweep (same session) must NOT re-run the warm-up round
		// trip — it already knows this server is cold.
		const second = await service.ensureWarmForSweep(filePath, {
			timeoutMs: 500,
		});
		expect(second.performedWarmup).toBe(false);
		expect(second.failedServerIds).toEqual(["workspace-indexer-generic"]);
		expect(second.skippedFromCache).toBe(true);
		expect(waitCalls.length).toBe(2); // unchanged — no new round trips
	});

	it("a server that later demonstrates readiness through an ordinary touch is removed from the cold set", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const genericServer = makeServer("workspace-indexer-generic", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [genericServer] : [],
		);
		const { client, waitCalls } = makeControlledClient(
			"workspace-indexer-generic",
			tmp,
			["timeout", "timeout", "warm"],
		);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const first = await service.ensureWarmForSweep(filePath, { timeoutMs: 500 });
		expect(first.failedServerIds).toEqual(["workspace-indexer-generic"]);

		// An ordinary confirmed touch (e.g. a real per-edit dispatch) proves the
		// server is actually fine now — this must clear the negative cache.
		await service.touchFile(filePath, "# hi\n", {
			diagnostics: "document",
			collectDiagnostics: true,
			clientScope: "primary",
			source: "test_recovery_touch",
		});
		expect(waitCalls.length).toBe(3);

		// The next sweep must run the real check again (already-warm now, not
		// cached-cold) — no warm-up round trip needed either way, but critically
		// it must NOT report the server as still failed from the stale cache.
		const second = await service.ensureWarmForSweep(filePath, {
			timeoutMs: 500,
		});
		expect(second.failedServerIds).toEqual([]);
		expect(waitCalls.length).toBe(3); // no extra round trip — already warm
	});

	it("a fresh LSPService instance (mirrors resetLSPService's session boundary) does not inherit the previous instance's cold cache", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const genericServer = makeServer("workspace-indexer-generic", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [genericServer] : [],
		);
		const { client, waitCalls } = makeControlledClient(
			"workspace-indexer-generic",
			tmp,
			["timeout", "timeout"],
		);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const firstSession = new LSPService();
		const result = await firstSession.ensureWarmForSweep(filePath, {
			timeoutMs: 500,
		});
		expect(result.failedServerIds).toEqual(["workspace-indexer-generic"]);
		expect(waitCalls.length).toBe(2);

		// `resetLSPService` discards the whole instance and creates a new one —
		// simulate that boundary directly. The new instance's `demonstratedCold`
		// must be empty, so it retries the warm-up fresh rather than trusting
		// the previous session's negative cache.
		const secondSession = new LSPService();
		const again = await secondSession.ensureWarmForSweep(filePath, {
			timeoutMs: 500,
		});
		expect(again.performedWarmup).toBe(true);
		expect(again.skippedFromCache).toBeUndefined();
		expect(waitCalls.length).toBe(4); // a fresh initial attempt + retry
	});
});

/**
 * #799: `ensureWarmForSweep`'s `warmupOverride` floor used to apply to EVERY
 * attempt — the retry re-paid the full cold-start budget on top of the
 * initial attempt, guaranteeing a 2x-budget burn for a server that simply
 * never publishes (silentOnClean) as much as for a genuinely still-cold one.
 * Only the FIRST attempt should get that floor; the retry should respect the
 * server's own (much shorter) strategy wait.
 */
describe("ensureWarmForSweep warmupOverride floor scoping (#799)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-warmup-floor-799-"));
		process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS = "0";
	});
	afterEach(() => {
		delete process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS;
		removeTempDirSync(tmp);
	});

	it("floors the FIRST attempt to the requested warm-up budget, but the retry respects the server's own (shorter) strategy budget instead of re-flooring", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		// A fictitious server (not in SERVER_DIAGNOSTIC_STRATEGIES) falls back to
		// DEFAULT_STRATEGY (aggregateWaitMs: 1500, no silentOnClean) — this
		// isolates the floor-scoping behavior from #799's separate silent-clean
		// confirm gate.
		const genericServer = makeServer("workspace-indexer-generic", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [genericServer] : [],
		);
		const { client, waitCalls } = makeControlledClient(
			"workspace-indexer-generic",
			tmp,
			["timeout", "timeout"],
		);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Requested warm-up budget (50ms) is far below DEFAULT_STRATEGY's
		// 1500ms aggregateWaitMs — attempt 1 must still floor UP to 1500ms (the
		// cold-start protection #669 fixed), but attempt 2 must NOT re-floor:
		// it should fall back to `Math.min(callerCap, strategyWait)` = 50ms.
		await service.ensureWarmForSweep(filePath, { timeoutMs: 50 });
		expect(waitCalls.length).toBe(2);
		expect(waitCalls[0]!.ms).toBe(1500); // attempt 1: floored to strategyWait
		expect(waitCalls[1]!.ms).toBe(50); // attempt 2: respects the caller cap
	}, 10000);
});
