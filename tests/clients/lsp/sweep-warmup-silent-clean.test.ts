/**
 * #3187: `LSPService.ensureWarmForSweep`'s warm-up touch is the ONE touch in
 * the codebase that carries `collectDiagnostics: false` into a
 * `clientScope: "primary"`, single-server, `silentOnClean` shape — exactly the
 * shape the #707 tsserver sync clean-confirm race was built for. That race was
 * gated on `options.collectDiagnostics === true`, so on a tier3-silent
 * (push-only, classic typescript-language-server) project the warm-up could
 * not certify its own silence through the race at all: it paid the whole
 * cold-server push budget and only then reached the generic #799 clean-confirm
 * fallback (measured on a real 4.2.0 session: `lsp_sweep_warmup_done ms=6972`
 * against `timeoutMs=20000`, followed by a 113 ms touch of the same file).
 *
 * The fix makes the warm-up touch sync-ELIGIBLE without making it COLLECT, so
 * the verdict arrives at ~grace+RTT while the warm-up keeps publishing nothing
 * into `lastKnownDiagnostics` (the primary-only coverage a collecting warm-up
 * would have written there — the reporter's "one behaviour change worth a
 * maintainer's eye", declined here).
 *
 * The three shapes this file pins, each naming the recurrence it prevents:
 *   1. sync available  → the race certifies the warm-up (the #3187 defect).
 *   2. sync UNAVAILABLE → the generic #799 silent-clean gate still certifies
 *      it. Widening the race gate without widening that fallback's
 *      `!tsserverSyncEligible` exclusion would strand every warm-up whose
 *      server does not advertise `typescript.tsserverRequest` as
 *      inconclusive — a #744 warm-up failure, a retry, and a SKIPPED sweep
 *      group reported as unconfirmed. That is a regression the naive
 *      "flip the flag back" fix also ships.
 *   3. a warm-up must never write the file's `lastKnownDiagnostics` — the
 *      recurrence the #1470/#1493 prime guard exists for, reached from the new
 *      direction a collecting warm-up would open.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logLatency = vi.fn();

// Partial mocks (#2281): spread the real module and override only the two
// seams this file drives, so a production export added to either module later
// cannot go missing from the double.
vi.mock("../../../clients/lsp/config.js", async (importActual) => ({
	...(await importActual<typeof import("../../../clients/lsp/config.js")>()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", async (importActual) => ({
	...(await importActual<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));
// Read the real latency rows this change is observable through — the sink,
// not a claim about it.
vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

type LatencyRow = {
	phase?: string;
	metadata?: Record<string, unknown>;
};

function latencyRows(phase: string): LatencyRow[] {
	return logLatency.mock.calls
		.map(([row]) => row as LatencyRow)
		.filter((row) => row.phase === phase);
}

function makeTsServer(root: string) {
	return {
		id: "typescript",
		name: "typescript",
		extensions: [".ts"],
		idleEviction: "resident",
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

/** tsserver's NATIVE protocol diagnostic shape (see `tsserver-sync.ts`). */
const DIRTY_SYNC_DIAGNOSTIC = {
	message: "Type 'number' is not assignable to type 'string'.",
	category: "error",
	code: 2322,
	startLocation: { line: 1, offset: 5 },
	endLocation: { line: 1, offset: 10 },
};

function makeSyncResponse(
	bodies: Partial<
		Record<"semanticDiagnosticsSync" | "syntacticDiagnosticsSync", unknown[]>
	>,
) {
	return vi
		.fn()
		.mockImplementation(async (_command: string, args: unknown[]) => ({
			executed: true,
			result: {
				success: true,
				body:
					bodies[
						(args as [string, unknown])[0] as
							| "semanticDiagnosticsSync"
							| "syntacticDiagnosticsSync"
					] ?? [],
			},
		}));
}

/**
 * A classic typescript-language-server that classifies `tier3-silent`
 * (push-only + `silentOnClean` + no `native-ts7` launch variant) and NEVER
 * publishes for the warm-up's own content — the real cold tier3-silent
 * project's behaviour. `waitForDiagnostics` stays PENDING for the warm-up
 * touch (identified by the production-set `pullSettleSource: "pull-warmup"`
 * option, #1639) so the push wait cannot decide the race; the caller's own
 * deadline (`ensureWarmForSweep`'s `withDeadline`, or the sweep's per-file
 * budget) is the bound, exactly as it is for a server that has not published
 * yet. No raw test-side timer is used, so this file stays out of the
 * flake-shape ratchet's `raw-timer-wait` population.
 */
function makeTier3SilentTsClient(
	root: string,
	options: {
		executeCommand?: ReturnType<typeof vi.fn>;
		advertisedCommands?: string[];
		warmupWaitPending?: boolean;
	} = {},
) {
	const waitCalls: Array<{
		filePath: string;
		ms: number;
		pullSettleSource?: string;
	}> = [];
	const executeCommand = options.executeCommand ?? makeSyncResponse({});
	return {
		waitCalls,
		executeCommand,
		client: {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			getAdvertisedCommands: () =>
				options.advertisedCommands ?? ["typescript.tsserverRequest"],
			getRawCapabilityKeys: () => [],
			getLaunchVariant: () => undefined,
			serverId: "typescript",
			root,
			diagnosticsVersion: 0,
			notify: { open: vi.fn(async () => {}) },
			waitForDiagnostics: vi.fn(
				(
					filePath: string,
					ms: number,
					opts?: { pullSettleSource?: string },
				): Promise<undefined> => {
					waitCalls.push({
						filePath,
						ms,
						pullSettleSource: opts?.pullSettleSource,
					});
					if (
						options.warmupWaitPending !== false &&
						opts?.pullSettleSource === "pull-warmup"
					) {
						// Nothing published yet: this wait can only end on its
						// caller's deadline.
						return new Promise<undefined>(() => {});
					}
					return Promise.resolve(undefined);
				},
			),
			getDiagnostics: vi.fn(() => []),
			getAllDiagnostics: vi.fn(() => new Map()),
			pingLiveness: vi.fn().mockResolvedValue(true),
			executeCommand,
		},
	};
}

function syncSubCommands(executeCommand: ReturnType<typeof vi.fn>): string[] {
	return executeCommand.mock.calls
		.filter(([command]) => command === "typescript.tsserverRequest")
		.map(([, args]) => (args as [string, unknown])[0]);
}

describe("ensureWarmForSweep on a tier3-silent server (#3187)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-warmup-silent-"));
		// Production's own grace timer decides the race; pin it low so the
		// sync racer is not the slow part of the test.
		process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS = "1";
		process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS = "0";
	});
	afterEach(() => {
		delete process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS;
		delete process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS;
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		removeTempDirSync(tmp);
	});

	it("certifies the warm-up through the tsserver sync confirm instead of burning the push budget", async () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const x = 1;\n");
		const server = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [server] : [],
		);
		const { client, executeCommand, waitCalls } = makeTier3SilentTsClient(tmp);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const warm = await service.ensureWarmForSweep(filePath, {
			timeoutMs: 1000,
		});

		// The verdict came from the #707 sync commands, not from an expired
		// push budget: both sub-commands went out on the warm-up's own touch.
		expect(syncSubCommands(executeCommand)).toEqual(
			expect.arrayContaining([
				"semanticDiagnosticsSync",
				"syntacticDiagnosticsSync",
			]),
		);
		expect(warm.performedWarmup).toBe(true);
		expect(warm.failedServerIds).toEqual([]);

		// Exactly one warm-up round trip — the #744 retry never fired — and the
		// push budget it offered was the full cold-server floor, so the saving
		// is the race, not a shrunken wait.
		expect(waitCalls.length).toBe(1);
		expect(waitCalls[0]!.ms).toBe(1000);

		// Observability: ONE `lsp_tsserver_sync_confirm` row for this warm-up,
		// attributed to the warm-up source and the racing mode, beside the one
		// `lsp_sweep_warmup_start`/`_done` pair. That row is what tells a field
		// reader the warm-up certified through the race rather than through an
		// expired budget, and `budgetMs` is the budget it did not spend.
		const confirms = latencyRows("lsp_tsserver_sync_confirm");
		expect(confirms).toHaveLength(1);
		expect(confirms[0]!.metadata).toMatchObject({
			source: "lsp_sweep_warmup",
			mode: "race",
			serverId: "typescript",
			clientScope: "primary",
			confirmedDiagnosticCount: 0,
			budgetMs: 1000,
		});
		expect(latencyRows("lsp_sweep_warmup_start")).toHaveLength(1);
		expect(latencyRows("lsp_sweep_warmup_done")).toHaveLength(1);
		expect(latencyRows("lsp_sweep_warmup_failed")).toHaveLength(0);

		// The server is now demonstratedReady: a second check is a no-op.
		const second = await service.ensureWarmForSweep(filePath, {
			timeoutMs: 1000,
		});
		expect(second.performedWarmup).toBe(false);
		expect(waitCalls.length).toBe(1);
	});

	it("still certifies the warm-up through the generic silent-clean gate when the sync commands are unavailable", async () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const x = 1;\n");
		const server = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [server] : [],
		);
		// A server that does not advertise `typescript.tsserverRequest` (an
		// older/differently-configured typescript-language-server): the sync
		// path returns `undefined` and the push wait lapses with nothing
		// published. #799's generic gate must still read that silence as clean.
		const executeCommand = vi.fn();
		const { client } = makeTier3SilentTsClient(tmp, {
			executeCommand,
			advertisedCommands: [],
			warmupWaitPending: false,
		});
		createLSPClient.mockResolvedValue(client);
		// Flat wait override so the (immediately resolving) push wait counts as
		// a lapsed budget — the state the generic gate is reached from.
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "1";

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const warm = await service.ensureWarmForSweep(filePath, {
			timeoutMs: 1000,
		});

		expect(warm.failedServerIds).toEqual([]);
		expect(warm.performedWarmup).toBe(true);
		const second = await service.ensureWarmForSweep(filePath, {
			timeoutMs: 1000,
		});
		expect(second.performedWarmup).toBe(false);
	});

	it("never publishes the warm-up's own diagnostics into the file's last-known cache", async () => {
		const filePath = path.join(tmp, "a.ts");
		fs.writeFileSync(filePath, "const x: string = 1;\n");
		const server = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [server] : [],
		);
		// A DIRTY file: the sync confirm returns real findings the silent
		// server never published. The warm-up must reach its verdict from them
		// and then drop them — they are primary-scope-only evidence, and the
		// sweep's own `clientScope: "all"` touch is what speaks for this file.
		const { client, executeCommand } = makeTier3SilentTsClient(tmp, {
			executeCommand: makeSyncResponse({
				semanticDiagnosticsSync: [DIRTY_SYNC_DIAGNOSTIC],
			}),
		});
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const warm = await service.ensureWarmForSweep(filePath, {
			timeoutMs: 1000,
		});

		expect(syncSubCommands(executeCommand).length).toBeGreaterThan(0);
		expect(warm.failedServerIds).toEqual([]);
		expect(service.getLastKnownDiagnostics(filePath)).toBeUndefined();
	});
});

describe("runWorkspaceDiagnostics warm-up on a tier3-silent group (#3187)", () => {
	let tmp: string;
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-sweep-silent-"));
		process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS = "1";
		process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS = "0";
		// Keep the pre-fix red (warm-up + one #744 retry against a server that
		// never publishes) bounded at ~2 s instead of the 20 s production
		// default.
		process.env.PI_LENS_LSP_WARMUP_TIMEOUT_MS = "1000";
	});
	afterEach(() => {
		delete process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS;
		delete process.env.PI_LENS_LSP_WARMUP_RETRY_BACKOFF_MS;
		delete process.env.PI_LENS_LSP_WARMUP_TIMEOUT_MS;
		removeTempDirSync(tmp);
	});

	it("warms the group through the sync confirm, so the sweep scans its files instead of skipping them", async () => {
		for (const name of ["a.ts", "b.ts"]) {
			fs.writeFileSync(path.join(tmp, name), "const x = 1;\n");
		}
		const server = makeTsServer(tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".ts") ? [server] : [],
		);
		const { client, executeCommand } = makeTier3SilentTsClient(tmp);
		createLSPClient.mockResolvedValue(client);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const results = await service.runWorkspaceDiagnostics(tmp);

		// The sweep's own pre-loop warm-up is what certified the group: the
		// per-file touches run `clientScope: "all"` and never reach the #707
		// gate, so these sub-commands can only have come from the warm-up.
		expect(syncSubCommands(executeCommand)).toEqual(
			expect.arrayContaining([
				"semanticDiagnosticsSync",
				"syntacticDiagnosticsSync",
			]),
		);
		expect(results.length).toBe(2);
		// #744: a failed warm-up skips the whole group and reports every file
		// unconfirmed. A certified warm-up must not.
		for (const result of results) {
			expect(result.skippedWarmupFailure).toBeFalsy();
		}
	});
});
