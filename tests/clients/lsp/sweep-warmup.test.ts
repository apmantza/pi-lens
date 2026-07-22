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
function makeFakeClient(root: string) {
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
			serverId: "typescript",
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
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

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
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

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
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("retries exactly once when the first warm-up times out, then reports the still-cold server in failedServerIds", async () => {
		const filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : [],
		);
		const { client, waitCalls } = makeControlledClient("marksman", tmp, [
			"timeout",
			"timeout",
		]);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.ensureWarmForSweep(filePath, {
			timeoutMs: 500,
		});
		expect(result.performedWarmup).toBe(true);
		// Both attempts left the server cold → it's reported failed for this sweep.
		expect(result.failedServerIds).toEqual(["marksman"]);
		// Exactly two warm-up round trips: the initial attempt + one retry. Not
		// one (no retry), not three (retry must fire at most once).
		expect(waitCalls.length).toBe(2);
	});

	it("a server that warms on the retry participates normally (no failure, and a later warm-check is a no-op)", async () => {
		const filePath = path.join(tmp, "b.md");
		fs.writeFileSync(filePath, "# hi\n");
		const marksman = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : [],
		);
		const { client, waitCalls } = makeControlledClient("marksman", tmp, [
			"timeout",
			"warm",
		]);
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
		const marksman = makeServer("marksman", ".md", tmp);
		const ts = makeServer("typescript", ".ts", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [marksman] : fp.endsWith(".ts") ? [ts] : [],
		);
		// marksman never warms (perpetual timeout); typescript warms immediately.
		const marksmanClient = makeControlledClient("marksman", tmp, ["timeout"]);
		const tsClient = makeControlledClient("typescript", tmp, ["warm"]);
		createLSPClient.mockImplementation(async (opts: { serverId: string }) =>
			opts.serverId === "marksman" ? marksmanClient.client : tsClient.client,
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

		// marksman was touched ONLY by the two warm-up attempts — its per-file
		// touches were skipped, so it never re-paid its timeout per markdown file
		// (that would be 2 warm-up + 2 per-file = 4). This is the drag this fixes.
		expect(marksmanClient.waitCalls.length).toBe(2);
	});
});
