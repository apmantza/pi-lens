/**
 * #1714 (refs #1660) — the same throttle, proven against a REAL server process
 * over real stdio rather than a hand-rolled client double.
 *
 * `LSPService` spawns `tests/fixtures/fake-lsp-server.mjs` and talks to it
 * through the production client: real JSON-RPC framing, real pipes, real
 * ordering. The fixture runs its `FAKE_LSP_NOTIFY_BACKLOG_WEDGE` profile, so the
 * SERVER decides when it has been handed more documents than it can hold and
 * dies the way ast-grep died on live dogfood — stops reading stdin, answers
 * nothing, never recovers.
 *
 * SCOPE, stated because it matters: this harness proves the barrier's PROTOCOL —
 * that the drain round-trip really orders behind the document notifies on a real
 * pipe, and that a healthy server pays no coverage for it. It does NOT reach the
 * wedge, because `touchFile` here waits for the auxiliary's publication on every
 * file and so paces itself to the server. Production's sweep abandons that wait
 * at its budget and moves on, which is the asymmetry that builds the backlog;
 * that half is proven in `service-notify-inflight-throttle.test.ts`, whose double
 * models the sweep's real timing.
 */

import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const logLatency = vi.fn();

vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

const ROOT = process.cwd();
/**
 * The server dies above this many unread documents. Deliberately three times the
 * ceiling the test configures: the assertion is that pacing keeps the backlog
 * bounded, and a knife-edge margin would let a slow CI host, rather than the
 * throttle, decide the result (#1491/#1498).
 */
const WEDGE_ABOVE = 6;
/**
 * Per-document cost, set ABOVE the touch's own notify budget so the sweep hands
 * documents over faster than the server retires them. That is the production
 * asymmetry: a touch stops waiting after its budget and moves to the next file,
 * while the scanner is still working on the last one.
 */
const NOTIFY_COST_MS = 60;
const SWEEP_FILES = 12;

async function makeAuxServer() {
	const { spawnFakeLspServer } =
		await import("../../support/fake-lsp-server.js");
	return {
		id: "ast-grep",
		name: "ast-grep",
		role: "auxiliary" as const,
		extensions: [".ts"],
		idleEviction: "resident",
		root: async () => ROOT,
		spawn: async () => ({
			process: await spawnFakeLspServer({
				cwd: ROOT,
				env: {
					...process.env,
					FAKE_LSP_NOTIFY_BACKLOG_WEDGE: String(WEDGE_ABOVE),
					FAKE_LSP_NOTIFY_COST_MS: String(NOTIFY_COST_MS),
				},
			}),
			source: "test" as const,
		}),
	};
}

function sweepFiles(count: number): string[] {
	return Array.from({ length: count }, (_, i) =>
		path.join(ROOT, `sweep-file-${i}.ts`),
	);
}

async function runSweep(limit: string | undefined) {
	if (limit === undefined) delete process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT;
	else process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = limit;
	const { LSPService } = await import("../../../clients/lsp/index.js");
	const service = new LSPService();
	getServersForFileWithConfig.mockReturnValue([await makeAuxServer()]);
	const startedAt = Date.now();
	for (const file of sweepFiles(SWEEP_FILES)) {
		await service.touchFile(file, `export const x${file.length} = 1;\n`, {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "lens_diagnostics_full",
		});
	}
	const elapsedMs = Date.now() - startedAt;
	// The scanner's own verdict on whether the sweep drowned it: a wedged server
	// has stopped reading stdin, so no request can round-trip.
	const client = [
		...(
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state.clients.values(),
	][0] as { pingLiveness?: (ms?: number) => Promise<boolean> } | undefined;
	const stillAnswering = (await client?.pingLiveness?.(2000)) === true;
	await (
		service as unknown as { shutdown: (o?: unknown) => Promise<void> }
	).shutdown({ reason: "test", fast: true });
	return { stillAnswering, elapsedMs };
}

describe("#1714 — real-stream proof against a server with an intake ceiling", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		logLatency.mockReset();
		// Generous on purpose. This test is about the barrier's PROTOCOL, not about
		// what happens when it runs out of time — that path has its own test with
		// doubles, where the clock is not the host's to move. A tight budget here
		// would let CI contention turn a drained barrier into a stalled one, which
		// is the host-dependent-test shape (#1491/#1498), not a product signal.
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "15000";
	});

	afterEach(() => {
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		delete process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT;
		vi.restoreAllMocks();
	});

	it("a sweep-shaped run leaves the scanner alive and answering", async () => {
		const { stillAnswering } = await runSweep("2");

		expect(stillAnswering).toBe(true);
		const rows = logLatency.mock.calls.map(([entry]) => entry);
		const barriers = rows.filter(
			(entry) => entry?.phase === "lsp_notify_inflight_barrier",
		);
		// The barrier's round-trip really orders behind the document notifies over
		// a real pipe: every one of them comes back drained, which is only true if
		// the server answered a request written after the opens.
		expect(barriers.length).toBeGreaterThan(0);
		expect(barriers.every((row) => row.metadata?.outcome === "drained")).toBe(
			true,
		);
		expect(barriers[0]?.metadata?.serverId).toBe("ast-grep");
		// One record per barrier, not one per file.
		expect(barriers.length).toBeLessThanOrEqual(SWEEP_FILES / 2);
		// Pacing costs coverage nothing when the server keeps up: no file was
		// deferred, so none entered the sweep's coverage gap.
		expect(
			rows.filter((entry) => entry?.phase === "lsp_notify_resync_deferred"),
		).toHaveLength(0);
	}, 120_000);
});
