/**
 * #1714 — a full-scan sweep must not out-run an auxiliary scanner's input.
 *
 * #1459 bounded CONCURRENT auxiliary writes to one per server. A
 * `lens_diagnostics mode=full` sweep is sequential inside a server group (#387),
 * so that gate almost never engages: every write is alone in flight. Each write
 * resolves when the pipe accepts the bytes, not when the scanner reads them, so
 * the sweep can hand a single-threaded scanner hundreds of full re-parses faster
 * than it consumes them. On live dogfood that stalled ast-grep twice in two
 * full-scan exposures and both instances had to be force-killed.
 *
 * These tests use a client double that models the wedge the way the real server
 * showed it: past a fixed backlog of unread documents the server stops reading
 * its stdin and stops answering anything. The double, not the test, decides when
 * that happens, so the assertions measure the production behaviour rather than a
 * scripted outcome.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
const logLatency = vi.fn();

// Partial mock, not a whole-module replacement (#1723): `() => ({ logLatency })`
// replaces the ENTIRE module, so the day `clients/lsp/index.ts` imports one
// more thing from latency-logger — as it now does, for the sweep's phase
// bracket — this file dies with "No <name> export is defined on the mock".
// Spreading the actual module overrides only what this test needs to observe.
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

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

const ROOT = "C:/repo";
const NOTIFY_BUDGET_MS = 60;
const AUX_KEY = `ast-grep:${normalizeMapKey(ROOT)}`;

function makeFakeProcess() {
	return {
		process: {
			killed: false,
			kill: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		},
		stdin: { on: vi.fn(), off: vi.fn(), write: vi.fn() },
		stdout: { on: vi.fn(), off: vi.fn(), pipe: vi.fn() },
		stderr: { on: vi.fn(), off: vi.fn() },
		pid: 999,
	};
}

function makeServer(
	id: string,
	role?: "auxiliary",
	extra: Record<string, unknown> = {},
) {
	return {
		id,
		name: id,
		extensions: [".ts"],
		idleEviction: "resident",
		...(role !== undefined && { role }),
		...extra,
		root: async () => ROOT,
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
	};
}

/**
 * A scanner double with a real backlog ceiling.
 *
 * `wedgeAbove` is how many documents it can hold before its input path dies.
 * Every `didOpen` adds one; a `pingLiveness` round-trip is what clears it,
 * because the real server drains one ordered message stream — measured against
 * the ast-grep binary, whose reply goes from 0 ms idle to 2263 ms behind 30
 * `didOpen`s, landing within one document of the whole backlog.
 *
 * Once wedged it behaves like the production failure: writes never settle and it
 * never recovers.
 *
 * `pingMs` is how long the round-trip takes. `pingAnswers: false` models a
 * connection that does NOT round-trip: production's `pingLiveness` resolves
 * FALSE at its own timeout (clients/lsp/client.ts:2588) rather than hanging, so
 * this double resolves false at `pingMs` too. A never-settling promise would be
 * a shape production cannot produce.
 */
function makeScanner(
	serverId: string,
	options: {
		wedgeAbove?: number;
		pingAnswers?: boolean;
		pingMs?: number;
		writeLands?: boolean;
	} = {},
) {
	const wedgeAbove = options.wedgeAbove ?? Number.POSITIVE_INFINITY;
	const pingAnswers = options.pingAnswers ?? true;
	const pingMs = options.pingMs ?? 0;
	const writeLands = options.writeLands ?? true;
	const stats = {
		opens: 0,
		pings: 0,
		maxBacklog: 0,
		wedged: false,
	};
	let backlog = 0;
	let version = 0;
	const stampsByPath = new Map<string, number>();
	return {
		stats,
		serverId,
		isAlive: () => true,
		shutdown: vi.fn(async () => {}),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		get diagnosticsVersion() {
			return version;
		},
		getDiagnosticsVersionForPath: vi.fn(
			(filePath: string) => stampsByPath.get(filePath) ?? 0,
		),
		getDiagnostics: vi.fn(() => []),
		pingLiveness: vi.fn(async (timeoutMs?: number) => {
			stats.pings += 1;
			const settleMs = Math.min(pingMs, timeoutMs ?? pingMs);
			if (settleMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, settleMs));
			}
			// A wedged or non-answering connection reports dead at its own timeout,
			// exactly as the production helper does. It never hangs.
			if (stats.wedged || !pingAnswers) return false;
			backlog = 0;
			return true;
		}),
		notify: {
			open: vi.fn(async () => {
				stats.opens += 1;
				if (stats.wedged) return new Promise<void>(() => {});
				backlog += 1;
				stats.maxBacklog = Math.max(stats.maxBacklog, backlog);
				if (backlog > wedgeAbove) {
					stats.wedged = true;
					return new Promise<void>(() => {});
				}
				if (!writeLands) return new Promise<void>(() => {});
			}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			(filePath: string) =>
				new Promise<void>((resolve) => {
					version += 1;
					stampsByPath.set(filePath, version);
					resolve();
				}),
		),
	};
}

function makePrimary(serverId: string) {
	let version = 0;
	const stampsByPath = new Map<string, number>();
	return {
		serverId,
		isAlive: () => true,
		shutdown: vi.fn(async () => {}),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		get diagnosticsVersion() {
			return version;
		},
		getDiagnosticsVersionForPath: vi.fn(
			(filePath: string) => stampsByPath.get(filePath) ?? 0,
		),
		getDiagnostics: vi.fn(() => []),
		pingLiveness: vi.fn(async () => true),
		notify: {
			open: vi.fn(async () => {}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			(filePath: string) =>
				new Promise<void>((resolve) => {
					version += 1;
					stampsByPath.set(filePath, version);
					resolve();
				}),
		),
	};
}

function brokenKeys(service: unknown): string[] {
	return [
		...(
			service as { state: { broken: Map<string, number> } }
		).state.broken.keys(),
	];
}

function rowsFor(phase: string): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map(([entry]) => entry)
		.filter((entry) => entry?.phase === phase);
}

type TouchResult =
	| { unconfirmedServerIds?: string[]; confirmation?: string }
	| undefined;

/** The sweep's shape: one file after another, each awaited (#387). */
async function sweep(
	service: {
		touchFile: (
			filePath: string,
			content: string,
			options: Record<string, unknown>,
		) => Promise<unknown>;
	},
	files: string[],
): Promise<TouchResult[]> {
	const results: TouchResult[] = [];
	for (const file of files) {
		results.push(
			(await service.touchFile(file, `content of ${file}`, {
				clientScope: "all",
				diagnostics: "document",
				collectDiagnostics: true,
				source: "lens_diagnostics_full",
			})) as TouchResult,
		);
	}
	return results;
}

function sweepFiles(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${ROOT}/file${i}.ts`);
}

async function makeService() {
	const { LSPService } = await import("../../../clients/lsp/index.js");
	return new LSPService();
}

describe("#1714 — sweep notify volume must not out-run an auxiliary", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = String(NOTIFY_BUDGET_MS);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		delete process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT;
	});

	it("keeps a sweep-shaped burst below the scanner's wedge ceiling", async () => {
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "4";
		// The scanner dies above six unread documents. A 40-file sweep hands it far
		// more than that before anything asks whether it kept up.
		const aux = makeScanner("ast-grep", { wedgeAbove: 6 });
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();

		const files = sweepFiles(40);
		const results = await sweep(service, files);

		// The wedge path is never reached, and the backlog stayed under the ceiling.
		expect(aux.stats.wedged).toBe(false);
		expect(aux.stats.maxBacklog).toBeLessThanOrEqual(4);
		// Every file was still offered to the scanner — throttled, not skipped.
		expect(aux.stats.opens).toBe(40);
		// Nothing was reported as uncovered: the scanner kept up under pacing.
		expect(
			results.filter((r) => r?.unconfirmedServerIds?.includes("ast-grep")),
		).toHaveLength(0);
		// Bounded telemetry: one row per barrier, not per file, and it names the
		// server that hit the ceiling.
		const barriers = rowsFor("lsp_notify_inflight_barrier");
		expect(barriers.length).toBeGreaterThan(0);
		expect(barriers.length).toBeLessThanOrEqual(40 / 4);
		expect(barriers[0]?.metadata).toMatchObject({
			serverId: "ast-grep",
			limit: 4,
			outcome: "drained",
		});
	});

	it("lets a healthy scanner keep full throughput", async () => {
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "4";
		const aux = makeScanner("ast-grep");
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();

		const results = await sweep(service, sweepFiles(40));

		expect(aux.stats.opens).toBe(40);
		expect(
			results.filter((r) => r?.unconfirmedServerIds?.includes("ast-grep")),
		).toHaveLength(0);
		// The pacing cost on a healthy server is one round-trip per `limit` files.
		expect(aux.stats.pings).toBeLessThanOrEqual(40 / 4);
	});

	it("falls through to the write when the scanner stops answering, and pays the barrier only once", async () => {
		// The F2 shape: a ceiling plus a round-trip that never comes back. Pacing
		// exists for a healthy-but-slow scanner; a scanner that will not answer at
		// all is a STALL, and #743's write deadline, streak and wedge timer already
		// own that — they demote and respawn, which pacing cannot. Deferring here
		// withheld the write, accrued no strike, and left the sweep no exit.
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "4";
		// Ping takes longer than the whole notify budget, so no waiter can ever
		// afford it.
		const aux = makeScanner("ast-grep", {
			pingAnswers: false,
			pingMs: NOTIFY_BUDGET_MS * 5,
		});
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();

		const results = await sweep(service, sweepFiles(20));

		// Every file still reached the scanner. Nothing was withheld, nothing was
		// reported as uncovered, and throughput did not collapse.
		expect(aux.stats.opens).toBe(20);
		expect(
			results.filter((r) => r?.unconfirmedServerIds?.includes("ast-grep")),
		).toHaveLength(0);
		// ONE round-trip attempted for the whole burst, not one per file: the gate
		// latches open on the first failure instead of rebuilding a fresh
		// full-budget barrier for every remaining file.
		expect(aux.stats.pings).toBe(1);
		const barriers = rowsFor("lsp_notify_inflight_barrier");
		expect(barriers).toHaveLength(1);
		expect(barriers[0]?.metadata).toMatchObject({
			serverId: "ast-grep",
			outcome: "stalled",
		});
		expect(rowsFor("degradation_ledger")).toContainEqual(
			expect.objectContaining({
				metadata: expect.objectContaining({
					kind: "lsp-notify-inflight-stall",
					subject: expect.stringContaining("ast-grep:"),
				}),
			}),
		);
	});

	it("keeps the demote-and-respawn self-heal reachable through the ceiling path", async () => {
		// F3: a ceiling stall must feed the SAME strike ladder as any other stalled
		// write. The live session recovered because the wedge timer demoted the
		// server and a clean instance respawned; a gate that withheld the write
		// would arm no timer and the sweep would run to the end with no exit.
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "2";
		const aux = makeScanner("ast-grep", {
			pingAnswers: false,
			pingMs: NOTIFY_BUDGET_MS * 5,
			// Dead input path: the write never lands either.
			writeLands: false,
		});
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();

		await sweep(service, sweepFiles(6));

		// The writes went out, so the stall machinery saw them and demoted the
		// server into the breaker cooldown — the entry point to respawn.
		expect(aux.stats.opens).toBeGreaterThan(0);
		expect(brokenKeys(service).some((k) => k.startsWith(`ast-grep:`))).toBe(
			true,
		);
		expect(aux.shutdown).toHaveBeenCalled();
	}, 30_000);

	it("records one stalled barrier however many waiters abandon it (M1)", async () => {
		// The waiter logs when its own budget lapses; the barrier logs again when
		// the ping finally resolves false, later. Both describe ONE barrier, so the
		// dedupe latch is load-bearing rather than decorative.
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "2";
		const aux = makeScanner("ast-grep", {
			pingAnswers: false,
			// Answers AFTER the waiter's budget lapses, so both log sites fire.
			pingMs: NOTIFY_BUDGET_MS * 2,
		});
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();

		await sweep(service, sweepFiles(5));
		// Give the late round-trip time to resolve and reach its own log site.
		await new Promise((r) => setTimeout(r, NOTIFY_BUDGET_MS * 4));

		expect(
			rowsFor("lsp_notify_inflight_barrier").filter(
				(row) => (row.metadata as { outcome?: string }).outcome === "stalled",
			),
		).toHaveLength(1);
	}, 30_000);

	it("drops the backlog record when the stall ladder demotes the client (M2)", async () => {
		// A demoted client is torn down. Its backlog count describes a process that
		// no longer exists, and leaving it would make the replacement start at the
		// ceiling and pay a barrier on its first file.
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "2";
		const aux = makeScanner("ast-grep", { writeLands: false });
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();
		await sweep(service, sweepFiles(5));

		const inflight = (
			service as unknown as { auxNotifyInflight: Map<string, unknown> }
		).auxNotifyInflight;
		// The wedge timer demoted it; the ledger entry went with the client.
		expect(brokenKeys(service).some((k) => k.startsWith("ast-grep:"))).toBe(
			true,
		);
		expect([...inflight.keys()]).not.toContain(AUX_KEY);
	}, 30_000);

	it("never charges a new client with a retired one's backlog (M3a)", async () => {
		// Probed directly, because the two identity checks mask each other through
		// the public path: whichever one survives, the other's guard cleans up and
		// the test passes regardless. Each is pinned on its own.
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "2";
		const aux = makeScanner("ast-grep");
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();
		const inflight = (
			service as unknown as {
				auxNotifyInflight: Map<string, { client: unknown; unacked: number }>;
			}
		).auxNotifyInflight;
		const retired = { serverId: "ast-grep-retired" };
		inflight.set(AUX_KEY, { client: retired, unacked: 7 });

		(
			service as unknown as {
				noteAuxNotifyIssued: (key: string, client: unknown) => void;
			}
		).noteAuxNotifyIssued(AUX_KEY, aux);

		// A fresh count for a fresh process — not the corpse's seven plus one.
		const record = inflight.get(AUX_KEY);
		expect(record?.client).toBe(aux);
		expect(record?.unacked).toBe(1);
	});

	it("never makes a new client wait out a retired one's backlog (M3b)", async () => {
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "2";
		const aux = makeScanner("ast-grep");
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();
		const inflight = (
			service as unknown as {
				auxNotifyInflight: Map<string, { client: unknown; unacked: number }>;
			}
		).auxNotifyInflight;
		inflight.set(AUX_KEY, {
			client: { serverId: "ast-grep-retired" },
			unacked: 999,
		});

		await (
			service as unknown as {
				paceAuxNotify: (
					key: string,
					entry: unknown,
					filePath: string,
					waitMs: number,
					context: unknown,
				) => Promise<void>;
			}
		).paceAuxNotify(
			AUX_KEY,
			{ client: aux, info: { id: "ast-grep", role: "auxiliary" } },
			`${ROOT}/probe.ts`,
			1000,
			{ source: "lens_diagnostics_full", clientScope: "all" },
		);

		// The stale record is dropped, and the live client was never made to prove
		// anything about writes it never received.
		expect(inflight.has(AUX_KEY)).toBe(false);
		expect(aux.stats.pings).toBe(0);
	});

	it("counts the sweep's pre-open burst against the same ceiling", async () => {
		// The pre-open pass (#608/#621) writes `didOpen` straight to every client,
		// without going through `touchFile`. It is the sweep's second source of the
		// same volume, so a scanner at its ceiling must be left out of the burst
		// rather than handed the whole chunk on top of what it already holds.
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "2";
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-inflight-preopen-"),
		);
		try {
			for (let i = 0; i < 12; i += 1) {
				fs.writeFileSync(path.join(tmp, `f${i}.ts`), "export const x = 1;\n");
			}
			// Healthy but paced: it answers the round-trip, so the ceiling stays in
			// force and any pre-open that ignored the ledger shows up as extra
			// backlog. (A scanner that refuses to answer deliberately latches the
			// gate open — see the fall-through test — so it cannot pin this.)
			const aux = makeScanner("ast-grep");
			const primary = makePrimary("typescript");
			getServersForFileWithConfig.mockImplementation((fp: string) =>
				fp.endsWith(".ts")
					? [makeServer("typescript"), makeServer("ast-grep", "auxiliary")]
					: [],
			);
			createLSPClient.mockImplementation(
				async (options: { serverId?: string }) =>
					options?.serverId === "ast-grep" ? aux : primary,
			);
			const { LSPService } = await import("../../../clients/lsp/index.js");
			await new LSPService().runWorkspaceDiagnostics(tmp);

			expect(aux.stats.maxBacklog).toBeLessThanOrEqual(2);
		} finally {
			removeTempDirSync(tmp);
		}
	}, 60_000);

	it("re-arms the backlog count when the service resets", async () => {
		process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT = "4";
		const aux = makeScanner("ast-grep");
		const primary = makePrimary("typescript");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("ast-grep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "ast-grep" ? aux : primary,
		);
		const service = await makeService();

		await sweep(service, sweepFiles(3));
		const inflight = (
			service as unknown as { auxNotifyInflight: Map<string, unknown> }
		).auxNotifyInflight;
		expect([...inflight.keys()]).toContain(AUX_KEY);

		// `resetLSPService({reason: "session_start"})` runs this teardown; the map
		// must not carry a previous session's backlog into the next one.
		await (
			service as unknown as { shutdown: (o?: unknown) => Promise<void> }
		).shutdown({ reason: "session_start" });
		expect(inflight.size).toBe(0);
	});
});
