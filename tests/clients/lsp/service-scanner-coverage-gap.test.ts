/**
 * #1459 — a cascade sweep must not drive a scanner into the notify-write
 * breaker, and a scanner's silence must never read as a clean verdict.
 *
 * Before this fix a `clientScope: "all"` sweep fanned a full-text `didOpen`
 * resync at opengrep for every neighbour inside a few milliseconds. Its stdin
 * stopped draining, three per-server write deadlines expired, and the #743
 * breaker opened for 15 s. Every touch inside that window then skipped the
 * scanner and still resolved `confirmation: "confirmed"` — a security blackout
 * that read as scanned-clean.
 *
 * These tests verify:
 *  1. A burst of concurrent resyncs at an auxiliary issues ONE write (the rest
 *     defer), so the breaker never trips, and the deferred touches report the
 *     scanner as uncovered.
 *  2. A write that lands after its deadline retracts the timeout it was charged
 *     for — slow is not broken.
 *  3. A write nothing accepts for the whole wedge window still demotes the
 *     server, so the gate cannot defer a dead input path forever.
 *  4. A touch that skipped a scanner because its breaker was open resolves
 *     `"partial"` and names the scanner, not `"confirmed"`.
 */

import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../../clients/path-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();
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

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

const ROOT = "C:/repo";
const NOTIFY_BUDGET_MS = 100;
const AUX_KEY_PREFIX = `opengrep:${normalizeMapKey(ROOT)}`;

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
		root: async () => ROOT,
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
		...extra,
	};
}

function makeDiagnostic(message: string) {
	return {
		severity: 1 as const,
		message,
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
	};
}

/**
 * A fake client. `writeMs` is how long its `didOpen` takes to be accepted:
 * `undefined` means it never lands (a wedged stdin), 0 means immediately.
 *
 * `publishes` models the diagnostics wait. `"never"` is the production profile
 * for a scanner that was not sent this content: its version cannot advance, so a
 * wait on it can only expire. A test that resolves this instantly would let the
 * touch reach `"partial"` on a timing profile production never has.
 *
 * #1533: `"immediately"` must ALSO advance `diagnosticsVersion`, because that is
 * what a real client's early resolve MEANS — the wait settles when a publication
 * lands (client.ts). A double that resolved without the bump modelled a client
 * production does not have, and the `"all"`-scope evidence check reads it as a
 * silent scanner (shape 7: the fixture, not the code, decided the verdict).
 * `diagnosticsVersion` is therefore a GETTER; a caller that spreads this object
 * (`{...makeClient(...)}`) freezes the value at spread time and must not rely on
 * later bumps.
 */
function makeClient(
	serverId: string,
	writeMs: number | undefined,
	diags: ReturnType<typeof makeDiagnostic>[] = [],
	publishes: "immediately" | "never" = "immediately",
) {
	// Concurrency instrumentation. Call COUNT cannot see the defect the gate
	// exists to prevent: N writes issued back-to-back and N issued simultaneously
	// are the same count. `maxInFlight` is the invariant — one outstanding resync
	// per auxiliary — and `openOffsets` shows the flood shape when it breaks.
	const startedAt = Date.now();
	let inFlight = 0;
	let version = 0;
	const stats = { maxInFlight: 0, openOffsets: [] as number[] };
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
		// #1531: production decides freshness and aux evidence from the PER-PATH
		// publication stamp, not the client-global counter, so the double answers on
		// that axis too — an accessor-less double would silently exercise only the
		// fail-closed branch and never the real read.
		//
		// #1533 merge: the `"never"` profile still stamps nothing, so every read is an
		// honest 0 and its silence is modelled rather than inferred. The
		// `"immediately"` profile DOES stamp the path it published for, because that is
		// what an early-resolving wait means for a notified push-only auxiliary — and
		// the per-path stamp is now the axis the evidence check reads, so stamping only
		// the global counter would leave a publishing scanner looking silent.
		stampsByPath,
		getDiagnosticsVersionForPath: vi.fn(
			(filePath: string) => stampsByPath.get(filePath) ?? 0,
		),
		getDiagnostics: vi.fn(() => diags),
		getAllDiagnostics: vi.fn(() => new Map()),
		notify: {
			open: vi.fn(() => {
				inFlight += 1;
				stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
				stats.openOffsets.push(Date.now() - startedAt);
				return new Promise<void>((resolve) => {
					if (writeMs === undefined) return;
					setTimeout(() => {
						inFlight -= 1;
						resolve();
					}, writeMs);
				});
			}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		// A real client resolves this on its OWN timeout and never rejects, so the
		// silent profile must resolve at `timeoutMs` WITHOUT advancing
		// `diagnosticsVersion` — a promise that never settles would model a client
		// production does not have.
		waitForDiagnostics: vi.fn(
			(filePath: string, timeoutMs?: number) =>
				new Promise<void>((resolve) => {
					if (publishes === "never") setTimeout(resolve, timeoutMs ?? 1000);
					else {
						// A publication landing is what resolves a real wait early. Stamp
						// BOTH axes exactly as `client.ts` does: the global counter advances
						// and the per-path stamp records that counter's value for this file
						// (#1531). Bumping only the global counter would leave the evidence
						// check — which reads per-path — seeing a silent scanner.
						version += 1;
						stampsByPath.set(filePath, version);
						resolve();
					}
				}),
		),
	};
}

function phases(): string[] {
	return logLatency.mock.calls.map(([entry]) => entry?.phase);
}

function rowsFor(phase: string): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map(([entry]) => entry)
		.filter((entry) => entry?.phase === phase);
}

function brokenKeys(service: unknown): string[] {
	return [
		...(
			service as { state: { broken: Map<string, number> } }
		).state.broken.keys(),
	];
}

function streakKeys(service: unknown): string[] {
	return [
		...(
			service as { notifyWriteBackpressureStreak: Map<string, number> }
		).notifyWriteBackpressureStreak.keys(),
	];
}

async function touchAll(
	service: {
		touchFile: (
			filePath: string,
			content: string,
			options: Record<string, unknown>,
		) => Promise<unknown>;
	},
	files: string[],
) {
	return Promise.all(
		files.map((file) =>
			service.touchFile(file, `content of ${file}`, {
				clientScope: "all",
				diagnostics: "document",
				collectDiagnostics: true,
				source: "cascade",
			}),
		),
	);
}

describe("#1459 — sweep fan-out must not black out a scanner silently", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = String(NOTIFY_BUDGET_MS);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
	});

	it("a burst of resyncs issues one write, defers the rest, and never trips the breaker", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// The scanner is slow (3x the write budget) but healthy — its write lands.
		// It never publishes for the files it was not sent, which is what makes the
		// "deferred servers are not waited on" half of the fix load-bearing: a wait
		// on this client could only expire, flipping the touch to `inconclusive`.
		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS * 3, [], "never");
		const primary = makeClient("typescript", 0, [
			makeDiagnostic("primary finding"),
		]);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? aux : primary,
		);

		const files = ["a.ts", "b.ts", "c.ts", "d.ts"].map((f) => `${ROOT}/${f}`);
		const pending = touchAll(service, files);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		const results = (await pending) as Array<
			| {
					diags: unknown[];
					confirmation?: string;
					inconclusive?: boolean;
					unconfirmedServerIds?: string[];
			  }
			| undefined
		>;

		// The gate let exactly one resync through; the other three deferred.
		expect(aux.notify.open).toHaveBeenCalledTimes(1);
		expect(aux.stats.maxInFlight).toBe(1);
		expect(rowsFor("lsp_notify_resync_deferred")).toHaveLength(3);

		// The breaker never opened, and no streak survived the late landing.
		expect(phases()).not.toContain("lsp_notify_backpressure_broken");
		expect(brokenKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			false,
		);
		expect(streakKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			false,
		);

		// Every touch says the scanner did not cover its content. Three because the
		// gate deferred their resync; the FOURTH because the write it did issue took
		// 3x the budget to land, so that touch has no evidence from opengrep either.
		// #1549: before the per-server verdict, that fourth touch reported blanket
		// `inconclusive` instead — a slow-but-healthy scanner discarding a primary
		// answer, which is the defect the gap list is supposed to replace.
		const deferred = results.filter((r) =>
			r?.unconfirmedServerIds?.includes("opengrep"),
		);
		expect(deferred).toHaveLength(4);
		for (const result of deferred) {
			// Narrowed, not collapsed: the primary's answer stands, and the deferred
			// scanner is not waited on, so nothing flips the touch to inconclusive.
			expect(result?.confirmation).toBe("partial");
			expect(result?.inconclusive).toBeUndefined();
			expect(result?.diags).toHaveLength(1);
		}
		// One row per uncovered touch: three deferrals plus #1549's late write, which
		// names its own door (`auxNoAnswerServerIds`) so the two causes stay legible.
		const gapRows = rowsFor("lsp_scanner_coverage_gap");
		expect(gapRows).toHaveLength(4);
		expect(
			gapRows.filter((row) =>
				(
					row.metadata as { deferredResyncServerIds?: string[] }
				)?.deferredResyncServerIds?.includes("opengrep"),
			),
		).toHaveLength(3);
		expect(
			gapRows.filter((row) =>
				(
					row.metadata as { auxNoAnswerServerIds?: string[] }
				)?.auxNoAnswerServerIds?.includes("opengrep"),
			),
		).toHaveLength(1);
		// The EXACT list on a deferral row, not just membership: a deferred touch
		// names the one scanner it does not speak for and nothing else.
		const deferredRow = gapRows.find(
			(row) =>
				(row.metadata as { deferredResyncServerIds?: string[] })
					?.deferredResyncServerIds,
		);
		expect(deferredRow?.metadata).toMatchObject({
			deferredResyncServerIds: ["opengrep"],
			source: "cascade",
		});
		// And the exact list on the late-write row, through its own door.
		const lateWriteRow = gapRows.find(
			(row) =>
				(row.metadata as { auxNoAnswerServerIds?: string[] })
					?.auxNoAnswerServerIds,
		);
		expect(lateWriteRow?.metadata).toMatchObject({
			auxNoAnswerServerIds: ["opengrep"],
			source: "cascade",
		});
	});

	it("a write that lands after its deadline retracts the timeout it was charged for", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS * 3);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(aux);

		// Three sequential slow-but-landing writes. Pre-#1459 each one charged a
		// timeout and the third opened the breaker.
		for (const content of ["one", "two", "three"]) {
			const pending = service.touchFile(`${ROOT}/a.ts`, content, {
				clientScope: "all",
				diagnostics: "document",
				collectDiagnostics: true,
				source: "cascade",
			});
			await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 10);
			await pending;
		}

		expect(aux.notify.open).toHaveBeenCalledTimes(3);
		expect(rowsFor("lsp_notify_write_late_landed")).toHaveLength(3);
		expect(phases()).not.toContain("lsp_notify_backpressure_broken");
		expect(brokenKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			false,
		);
	});

	it("a write nothing accepts for the wedge window still demotes the server", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Wedged: the write never lands.
		const aux = makeClient("opengrep", undefined);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(aux);

		const first = service.touchFile(`${ROOT}/a.ts`, "one", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 8);
		await first;

		const second = service.touchFile(`${ROOT}/b.ts`, "two", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS);
		await second;

		const demotions = rowsFor("lsp_notify_backpressure_broken");
		expect(demotions).toHaveLength(1);
		expect(
			(demotions[0]?.metadata as { outstandingMs?: number } | undefined)
				?.outstandingMs,
		).toBeGreaterThanOrEqual(NOTIFY_BUDGET_MS * 5);
		expect(brokenKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			true,
		);
		expect(aux.shutdown).toHaveBeenCalled();
	});

	it("a scanner skipped for an open breaker makes the touch partial, not confirmed", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const primary = makeClient("typescript", 0, [
			makeDiagnostic("primary finding"),
		]);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(primary);

		// The scanner is mid-cooldown, exactly as a #743 demotion leaves it.
		(
			service as unknown as { state: { broken: Map<string, number> } }
		).state.broken.set(AUX_KEY_PREFIX, Date.now() + 15_000);

		const pending = service.touchFile(`${ROOT}/a.ts`, "content", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 20);
		const result = (await pending) as
			| { confirmation?: string; unconfirmedServerIds?: string[] }
			| undefined;

		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
		const gapRows = rowsFor("lsp_scanner_coverage_gap");
		expect(gapRows).toHaveLength(1);
		expect(gapRows[0]?.metadata).toMatchObject({
			brokenSkippedServerIds: ["opengrep"],
		});
		expect(rowsFor("degradation_ledger")).toContainEqual(
			expect.objectContaining({
				metadata: expect.objectContaining({
					kind: "lsp-scanner-coverage-gap",
					subject: expect.stringContaining("opengrep:"),
				}),
			}),
		);
	});

	// #1533 makes the "still confirmed" half load-bearing on this scope too: `"all"`
	// now derives auxiliary coverage evidence from post-wait state, so a scanner that
	// publishes for every file must keep every touch unqualified. This is the
	// overcorrection guard for the aggregate path.
	//
	// The load-bearing concurrency assertion, and the negative control in one.
	// The gate is a QUEUE, not a drop: a healthy scanner accepts each write in
	// milliseconds, so all SIX concurrent touches still get scanned and every touch
	// still claims full confirmation — but they go through ONE AT A TIME.
	//
	// Call count alone cannot see the defect: a version of the gate that checked
	// the slot and then let each caller insert its own record after an `await`
	// passed a count assertion while measuring maxInFlight 5 (one write, then a
	// five-wide flood one budget later) — #1459's own root cause rebuilt inside the
	// fix. `writeMs` must be NONZERO for the probe to have anything to overlap.
	it("a healthy scanner gets every file, one resync at a time, still confirmed", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const aux = makeClient("opengrep", 10);
		const primary = makeClient("typescript", 0, [
			makeDiagnostic("primary finding"),
		]);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? aux : primary,
		);

		const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"].map(
			(f) => `${ROOT}/${f}`,
		);
		const pending = touchAll(service, files);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		const results = (await pending) as Array<
			{ confirmation?: string; unconfirmedServerIds?: string[] } | undefined
		>;

		expect(aux.stats.maxInFlight).toBe(1);
		expect(aux.notify.open).toHaveBeenCalledTimes(6);
		expect(rowsFor("lsp_notify_resync_deferred")).toHaveLength(0);
		expect(rowsFor("lsp_scanner_coverage_gap")).toHaveLength(0);
		for (const result of results) {
			expect(result?.confirmation).toBe("confirmed");
			expect(result?.unconfirmedServerIds).toBeUndefined();
		}
	});

	it("a wedged scanner is demoted by its own write's wedge timer, without a later touch", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Wedged: the write never lands, and NOTHING touches this server again.
		const aux = makeClient("opengrep", undefined);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(aux);

		const pending = service.touchFile(`${ROOT}/a.ts`, "one", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		await pending;

		const demotions = rowsFor("lsp_notify_backpressure_broken");
		expect(demotions).toHaveLength(1);
		expect(brokenKeys(service).some((k) => k.startsWith(AUX_KEY_PREFIX))).toBe(
			true,
		);
		expect(aux.shutdown).toHaveBeenCalled();
	});

	it("keeps a pending late pair attributable across notify-stall teardown (#2356)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const {
			drainPendingAuxiliaryCoverage,
			markPendingAuxiliaryCoverage,
			resetPendingAuxiliaryCoverage,
		} = await import("../../../clients/lsp/pending-aux-coverage.js");
		const service = new LSPService();
		const aux = makeClient("opengrep", undefined, [], "never");
		const file = `${ROOT}/late.ts`;
		getServersForFileWithConfig.mockReturnValue([
			makeServer("opengrep", "auxiliary"),
		]);
		(
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state.clients.set(AUX_KEY_PREFIX, aux);
		markPendingAuxiliaryCoverage(file, ["opengrep"], Date.now() - 1000);

		// Call the production teardown seam. It deletes the client, but the
		// late-pair probe must retain the reason for that temporary absence.
		(
			service as unknown as {
				demoteForNotifyStall: (...args: unknown[]) => void;
			}
		).demoteForNotifyStall(
			AUX_KEY_PREFIX,
			{ client: aux, info: makeServer("opengrep", "auxiliary") },
			file,
			{ outstandingMs: NOTIFY_BUDGET_MS * 5 },
		);

		const duringCooldown = await service.readCachedDiagnosticsForServers(
			file,
			new Set(["opengrep"]),
		);
		expect(duringCooldown.get("opengrep")).toMatchObject({
			notifyStallDemoted: true,
			demotedAt: expect.any(Number),
		});
		expect(aux.shutdown).toHaveBeenCalled();
		expect(drainPendingAuxiliaryCoverage()).toHaveLength(1);

		// A replacement generation clears the retired-generation marker and is
		// treated as a normal live cache probe again.
		const replacement = makeClient("opengrep", 0, [], "never");
		(
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state.clients.set(AUX_KEY_PREFIX, replacement);
		const afterReplacement = await service.readCachedDiagnosticsForServers(
			file,
			new Set(["opengrep"]),
		);
		expect(afterReplacement.get("opengrep")).toEqual({ diags: [] });
		resetPendingAuxiliaryCoverage();
	});

	it("a queued resync never waits longer than the caller's own budget", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// The scanner holds its write far past any budget, so the second touch can
		// only queue — and its caller allowed a total of a THIRD of the write budget.
		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS * 50, [], "never");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(aux);

		void service.touchFile(`${ROOT}/a.ts`, "one", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(1);

		const callerCapMs = Math.floor(NOTIFY_BUDGET_MS / 3);
		const second = service.touchFile(`${ROOT}/b.ts`, "two", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
			maxClientWaitMs: callerCapMs,
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		await second;

		const deferrals = rowsFor("lsp_notify_resync_deferred");
		expect(deferrals).toHaveLength(1);
		const row = deferrals[0] as { metadata?: Record<string, unknown> };
		// The queue wait was capped by the caller's own budget, not by the flat
		// write budget — a caller that asked for less must not be taxed more.
		expect(row.metadata?.queueWaitMs).toBeLessThanOrEqual(callerCapMs);
		// And the queued touch never pushed a second, overlapping resync.
		expect(aux.stats.openOffsets).toHaveLength(1);
	});

	it("an auxiliary resync is not starved when a cold primary spawn exceeds the caller's flat budget (#2239)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// #2239: the caller's flat budget (dispatch-lsp-runner's LSP_SPAWN_BUDGET_MS)
		// is smaller than this primary's own clientWaitTimeoutMs override (Ruby's
		// 30s in production) — getClientForFile waits out the LARGER floor
		// internally, so a cold spawn legitimately runs past the flat budget.
		const FLAT_CALLER_MS = NOTIFY_BUDGET_MS / 2;
		const PRIMARY_WAIT_FLOOR_MS = NOTIFY_BUDGET_MS * 50;
		const PRIMARY_SPAWN_DELAY_MS = NOTIFY_BUDGET_MS * 3;
		// Still outstanding when the cold spawn resolves; short enough that a
		// queue wait bounded by the write budget can still outlast it.
		const AUX_WRITE_MS = NOTIFY_BUDGET_MS * 3.5;

		const aux = makeClient("opengrep", AUX_WRITE_MS, [], "never");
		const primary = makeClient("ruby", 0);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith("/a.ts")
				? [makeServer("opengrep", "auxiliary")]
				: [
						makeServer("ruby", undefined, {
							clientWaitTimeoutMs: PRIMARY_WAIT_FLOOR_MS,
							spawn: vi.fn(
								() =>
									new Promise((resolve) => {
										setTimeout(
											() =>
												resolve({ process: makeFakeProcess(), source: "test" }),
											PRIMARY_SPAWN_DELAY_MS,
										);
									}),
							),
						}),
						makeServer("opengrep", "auxiliary"),
					],
		);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? aux : primary,
		);

		void service.touchFile(`${ROOT}/a.ts`, "one", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			diagnostics: "document",
			collectDiagnostics: true,
			source: "dispatch-lsp-runner",
			maxClientWaitMs: FLAT_CALLER_MS,
		});
		await vi.advanceTimersByTimeAsync(1);

		const second = service.touchFile(`${ROOT}/b.ts`, "two", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			diagnostics: "document",
			collectDiagnostics: true,
			source: "dispatch-lsp-runner",
			maxClientWaitMs: FLAT_CALLER_MS,
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		await second;

		// The cold ruby spawn alone consumed more than the flat caller budget, but
		// the auxiliary still got queue time from the SAME per-server floor
		// getClientForFile used internally — it was not starved to zero.
		expect(rowsFor("lsp_notify_resync_deferred")).toHaveLength(0);
		expect(aux.stats.openOffsets).toHaveLength(2);
	});

	it("does not widen the auxiliary's queue wait past the write budget even when a primary's per-server floor is large (#2239 guard)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// The per-server floor (Ruby-sized) is huge, but the write withholding
		// coverage outlasts the write budget by a wide margin. Deriving queueWaitMs
		// from the floor must not let it borrow time beyond the write budget —
		// that would reintroduce the unbounded per-edit latency #1459 closed.
		const FLAT_CALLER_MS = NOTIFY_BUDGET_MS / 2;
		const PRIMARY_WAIT_FLOOR_MS = NOTIFY_BUDGET_MS * 50;
		const PRIMARY_SPAWN_DELAY_MS = NOTIFY_BUDGET_MS / 4;
		const AUX_WRITE_MS = NOTIFY_BUDGET_MS * 20;

		const aux = makeClient("opengrep", AUX_WRITE_MS, [], "never");
		const primary = makeClient("ruby", 0);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith("/a.ts")
				? [makeServer("opengrep", "auxiliary")]
				: [
						makeServer("ruby", undefined, {
							clientWaitTimeoutMs: PRIMARY_WAIT_FLOOR_MS,
							spawn: vi.fn(
								() =>
									new Promise((resolve) => {
										setTimeout(
											() =>
												resolve({ process: makeFakeProcess(), source: "test" }),
											PRIMARY_SPAWN_DELAY_MS,
										);
									}),
							),
						}),
						makeServer("opengrep", "auxiliary"),
					],
		);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? aux : primary,
		);

		void service.touchFile(`${ROOT}/a.ts`, "one", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			diagnostics: "document",
			collectDiagnostics: true,
			source: "dispatch-lsp-runner",
			maxClientWaitMs: FLAT_CALLER_MS,
		});
		await vi.advanceTimersByTimeAsync(1);

		const second = service.touchFile(`${ROOT}/b.ts`, "two", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			diagnostics: "document",
			collectDiagnostics: true,
			source: "dispatch-lsp-runner",
			maxClientWaitMs: FLAT_CALLER_MS,
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		await second;

		const deferrals = rowsFor("lsp_notify_resync_deferred");
		expect(deferrals).toHaveLength(1);
		const row = deferrals[0] as { metadata?: Record<string, unknown> };
		// Bounded by the write budget, nowhere near the 50x-budget server floor.
		expect(row.metadata?.queueWaitMs).toBeLessThanOrEqual(NOTIFY_BUDGET_MS);
	});

	it("a queued touch does not write to a client that was evicted while it waited", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// The holder's write settles INSIDE the queue budget, so the waiter really
		// reaches the claim — a write that outlasts the budget would make the waiter
		// time out first and never exercise the guard at all (shape 7).
		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS / 2, [], "never");
		getServersForFileWithConfig.mockReturnValue([
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockResolvedValue(aux);

		void service.touchFile(`${ROOT}/a.ts`, "one", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(aux.notify.open).toHaveBeenCalledTimes(1);

		const second = service.touchFile(`${ROOT}/b.ts`, "two", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		// Evict the client while the second touch is queued behind its write. An
		// eviction DELETES the registry entry, which is exactly the shape a guard
		// that exempted "no entry" waved through: the waiter would take the freed
		// slot, write to the corpse, and `markTouched` would record this content as
		// delivered (#1253 laundering).
		await vi.advanceTimersByTimeAsync(1);
		(
			service as unknown as { state: { clients: Map<string, unknown> } }
		).state.clients.delete(AUX_KEY_PREFIX);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		await second;

		// No second write, and the retired generation earned no debounce entry.
		expect(aux.notify.open).toHaveBeenCalledTimes(1);
		expect(rowsFor("lsp_notify_resync_deferred")).toHaveLength(1);
		const touched = (
			service as unknown as { recentTouches: Map<string, unknown> }
		).recentTouches;
		expect([...touched.keys()].some((k) => k.includes("b.ts"))).toBe(false);
	});

	it("a deferred auxiliary records a `deferred` aux-wait outcome, never `silent`", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS * 50, [], "never");
		const primary = makeClient("typescript", 0, [
			makeDiagnostic("primary finding"),
		]);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? aux : primary,
		);

		const touchOptions = {
			clientScope: "with-auxiliary" as const,
			auxiliaryServerIds: ["opengrep"],
			diagnostics: "document" as const,
			collectDiagnostics: true,
			source: "cascade",
		};
		const first = service.touchFile(`${ROOT}/a.ts`, "one", touchOptions);
		await vi.advanceTimersByTimeAsync(1);
		const second = service.touchFile(`${ROOT}/b.ts`, "two", touchOptions);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		await Promise.all([first, second]);

		const outcomes = rowsFor("lsp_aux_wait_outcome").flatMap(
			(row) =>
				(
					row.metadata as {
						outcomes?: Array<{ serverId: string; outcome: string }>;
					}
				)?.outcomes ?? [],
		);
		const opengrepOutcomes = outcomes
			.filter((entry) => entry.serverId === "opengrep")
			.map((entry) => entry.outcome);
		// #1493 boundary: `silent` stays reserved for a scanner that HAD the content
		// and published nothing. A deferral must never be recorded there.
		expect(opengrepOutcomes).toContain("deferred");
		expect(opengrepOutcomes).not.toContain("silent");
	});

	it("a deferred scanner's stale findings are not merged as this touch's answer", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// The scanner still holds the PREVIOUS content's finding: the resync that
		// would have cleared its cache is the one the gate deferred.
		const aux = makeClient(
			"opengrep",
			NOTIFY_BUDGET_MS * 3,
			[makeDiagnostic("stale scanner finding")],
			"never",
		);
		const primary = makeClient("typescript", 0);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? aux : primary,
		);

		const files = ["a.ts", "b.ts"].map((f) => `${ROOT}/${f}`);
		const pending = touchAll(service, files);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		const results = (await pending) as Array<
			| {
					diags: unknown[];
					confirmation?: string;
					unconfirmedServerIds?: string[];
			  }
			| undefined
		>;

		const deferred = results.find((r) =>
			r?.unconfirmedServerIds?.includes("opengrep"),
		);
		expect(deferred).toBeDefined();
		expect(deferred?.diags).toEqual([]);
	});

	// #1493 integration: the content-hash exemption outranks the deferral. A
	// scanner that already published for EXACTLY these bytes has reported on this
	// file, so the gate skipping its resync withholds nothing — and its stored
	// findings must still reach the result. Fail this and the merge either
	// overclaims (drops findings while saying "confirmed") or underclaims (reports
	// a gap for a file the scanner demonstrably covered).
	it("a deferred scanner that already published these exact bytes stays covered", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const { hashDiagnosticContent } =
			await import("../../../clients/lsp/diagnostic-binding.js");
		const service = new LSPService();

		const storedFinding = makeDiagnostic("stored scanner finding");
		const aux = makeClient("opengrep", NOTIFY_BUDGET_MS * 3, [], "never");
		// Its stored publication is bound to the SECOND file's exact content.
		const auxWithBinding = {
			...aux,
			getDiagnostics: vi.fn((filePath: string) =>
				filePath.endsWith("b.ts") ? [storedFinding] : [],
			),
			getDiagnosticBinding: vi.fn((filePath: string) =>
				filePath.endsWith("b.ts")
					? {
							contentHash: hashDiagnosticContent("two"),
							boundToCurrentDisk: true,
						}
					: undefined,
			),
		};
		const primary = makeClient("typescript", 0);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? auxWithBinding : primary,
		);

		const touchOptions = {
			clientScope: "with-auxiliary" as const,
			auxiliaryServerIds: ["opengrep"],
			diagnostics: "document" as const,
			collectDiagnostics: true,
			source: "cascade",
		};
		const first = service.touchFile(`${ROOT}/a.ts`, "one", touchOptions);
		await vi.advanceTimersByTimeAsync(1);
		const second = service.touchFile(`${ROOT}/b.ts`, "two", touchOptions);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		const [, result] = (await Promise.all([first, second])) as Array<
			| {
					diags: Array<{ message: string }>;
					confirmation?: string;
					unconfirmedServerIds?: string[];
			  }
			| undefined
		>;

		// Deferred, so the resync never went out …
		expect(rowsFor("lsp_notify_resync_deferred")).not.toHaveLength(0);
		// … but the scanner had already spoken for these bytes, so no gap …
		expect(result?.unconfirmedServerIds ?? []).not.toContain("opengrep");
		expect(result?.confirmation).toBe("confirmed");
		// … and its stored findings still reach the caller.
		expect(result?.diags.map((d) => d.message)).toContain(
			"stored scanner finding",
		);
	});
});

/**
 * #1586 — the deferred door judged coverage from the PRE-NOTIFY snapshot.
 *
 * #1571 established the merge-time predicate (`auxCoversThisContent`): a stored
 * binding read at MERGE time, unioned with #1493's pre-notify snapshot, deciding
 * both whether an auxiliary's findings are dropped and whether it is named
 * uncovered. The deferred door never went through it — it filtered
 * `notifyDeferredServerIds` on the snapshot alone and dropped every deferred
 * server's findings unconditionally. The snapshot is taken BEFORE the notify, so
 * it cannot see the publication that #1459's own late-write signature produces:
 * the outstanding write the gate deferred behind LANDS, the scanner scans, and it
 * publishes for exactly these bytes while the deferred touch is still waiting.
 *
 * The fixture is that race, with two CONCURRENT touches of one file sharing one
 * scanner client:
 *   - the FIRST claims the scanner's single resync slot with a slow write;
 *   - the SECOND is DEFERRED behind it, and its pre-notify snapshot sees nothing;
 *   - the first write then lands and the scanner publishes;
 *   - the primary publishes later still, so the deferred touch is demonstrably
 *     mid-wait when that happens.
 */
describe("#1586 — deferred-door coverage is judged at merge time", () => {
	const FILE = `${ROOT}/a.ts`;
	const CONTENT = "const value = 1;";
	const LATE_FINDING = "late scanner finding";
	const POST_MERGE_FINDING = "post-merge scanner finding";
	const PRIMARY_PUBLISH_MS = 700;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		(
			await import("../../../clients/lsp/spawn-history.js")
		)._clearSuccessfulLspSpawnHistoryForTests();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = String(NOTIFY_BUDGET_MS);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
	});

	/**
	 * A primary that publishes at `publishAtMs` instead of instantly, so a
	 * concurrent touch is still inside its diagnostics wait when the scanner's
	 * late publication lands. It rides its own budget WITHOUT publishing when that
	 * budget is shorter, so a mis-sized fixture fails as an inconclusive touch
	 * rather than modelling a client production does not have.
	 *
	 * The `diagnosticsVersion` getter and the per-path stamp are redefined AFTER
	 * the spread: spreading `makeClient(...)` evaluates its getter once and freezes
	 * the value.
	 */
	function makePublishingPrimary(publishAtMs: number) {
		let version = 0;
		const stampsByPath = new Map<string, number>();
		return {
			...makeClient("typescript", 0),
			get diagnosticsVersion() {
				return version;
			},
			getDiagnosticsVersionForPath: vi.fn(
				(filePath: string) => stampsByPath.get(filePath) ?? 0,
			),
			waitForDiagnostics: vi.fn(
				(filePath: string, timeoutMs?: number) =>
					new Promise<void>((resolve) => {
						if (timeoutMs !== undefined && timeoutMs < publishAtMs) {
							setTimeout(resolve, timeoutMs);
							return;
						}
						setTimeout(() => {
							version += 1;
							stampsByPath.set(filePath, version);
							resolve();
						}, publishAtMs);
					}),
			),
		};
	}

	/**
	 * A scanner that holds NOTHING until its own `didOpen` write is accepted, and
	 * from that moment reports a finding bound to `publishedContentHash`. That is
	 * the production sequence the gate defers behind: the write lands, the scan
	 * runs, the publication is stored with the fingerprint of the text that was
	 * sent. Its wait still never resolves early (`"never"`), because a scanner that
	 * was not sent THIS touch's bytes cannot answer this touch's wait.
	 */
	function makeLatePublishingAux(
		writeMs: number,
		publishedContentHash: string,
	) {
		const base = makeClient("opengrep", writeMs, [], "never");
		let published = false;
		return {
			...base,
			getDiagnostics: vi.fn(() =>
				published ? [makeDiagnostic(LATE_FINDING)] : [],
			),
			getDiagnosticBinding: vi.fn(() =>
				published ? { contentHash: publishedContentHash } : undefined,
			),
			notify: {
				...base.notify,
				open: vi.fn(() =>
					base.notify.open().then(() => {
						published = true;
					}),
				),
			},
		};
	}

	type TouchResult =
		| {
				diags: Array<{ message: string }>;
				confirmation?: string;
				inconclusive?: boolean;
				unconfirmedServerIds?: string[];
		  }
		| undefined;

	async function runDeferredPublishRace(
		clientScope: "with-auxiliary" | "all",
		publishedContentHash: string,
	): Promise<{ holdingResult: TouchResult; deferredResult: TouchResult }> {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const aux = makeLatePublishingAux(
			NOTIFY_BUDGET_MS * 3,
			publishedContentHash,
		);
		const primary = makePublishingPrimary(PRIMARY_PUBLISH_MS);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? aux : primary,
		);

		const touchOptions = {
			clientScope,
			...(clientScope === "with-auxiliary" && {
				auxiliaryServerIds: ["opengrep"],
			}),
			diagnostics: "document" as const,
			collectDiagnostics: true,
			source: "cascade",
		};
		const holding = service.touchFile(FILE, CONTENT, touchOptions);
		await vi.advanceTimersByTimeAsync(1);
		const deferred = service.touchFile(FILE, CONTENT, touchOptions);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		const [holdingResult, deferredResult] = (await Promise.all([
			holding,
			deferred,
		])) as [TouchResult, TouchResult];
		return { holdingResult, deferredResult };
	}

	it.each(["with-auxiliary", "all"] as const)(
		"%s: a deferred scanner bound to these bytes at merge time keeps its findings and is not named",
		async (clientScope) => {
			const { hashDiagnosticContent } =
				await import("../../../clients/lsp/diagnostic-binding.js");
			const { deferredResult } = await runDeferredPublishRace(
				clientScope,
				hashDiagnosticContent(CONTENT),
			);

			// The gate really did defer the second touch's resync …
			expect(rowsFor("lsp_notify_resync_deferred")).toHaveLength(1);
			// … but by merge time the scanner had published for EXACTLY these bytes,
			// so it has reported on this file and the deferral withholds nothing.
			expect(deferredResult?.diags.map((d) => d.message)).toContain(
				LATE_FINDING,
			);
			expect(deferredResult?.unconfirmedServerIds ?? []).not.toContain(
				"opengrep",
			);
			expect(deferredResult?.confirmation).toBe("confirmed");
			// The primary answered inside its budget; nothing here is inconclusive.
			expect(deferredResult?.inconclusive).toBeFalsy();
		},
	);

	it.each(["with-auxiliary", "all"] as const)(
		"%s: a deferred scanner bound to OTHER bytes stays dropped and named",
		async (clientScope) => {
			const { hashDiagnosticContent } =
				await import("../../../clients/lsp/diagnostic-binding.js");
			// The honest case, and the guard against un-narrowing on a timer: the
			// scanner published, but for the PREVIOUS revision. Its findings carry
			// that revision's line numbers and must not ride out as this touch's
			// answer.
			const { deferredResult } = await runDeferredPublishRace(
				clientScope,
				hashDiagnosticContent("const value = 2;"),
			);

			expect(rowsFor("lsp_notify_resync_deferred")).toHaveLength(1);
			expect(deferredResult?.unconfirmedServerIds).toContain("opengrep");
			expect(deferredResult?.confirmation).toBe("partial");
			expect(deferredResult?.diags.map((d) => d.message)).not.toContain(
				LATE_FINDING,
			);
			expect(deferredResult?.inconclusive).toBeFalsy();
		},
	);

	it.each(["with-auxiliary", "all"] as const)(
		"%s: no door names a scanner whose findings the merge kept",
		async (clientScope) => {
			// The single-predicate property, asserted behaviorally. The HOLDING touch
			// is judged by three doors at once — the notify-write door (its write was
			// charged as timed out), the aux wait-outcome door (its wait produced no
			// publication for this touch), and the merge. #1571 put the merge on the
			// merge-time predicate and left the wait-outcome door on the pre-notify
			// snapshot, so the touch named a scanner whose findings it had just
			// merged. Naming and merging must agree, whichever door reached first.
			const { hashDiagnosticContent } =
				await import("../../../clients/lsp/diagnostic-binding.js");
			const { holdingResult } = await runDeferredPublishRace(
				clientScope,
				hashDiagnosticContent(CONTENT),
			);

			expect(holdingResult?.diags.map((d) => d.message)).toContain(
				LATE_FINDING,
			);
			expect(holdingResult?.unconfirmedServerIds ?? []).not.toContain(
				"opengrep",
			);
			expect(holdingResult?.confirmation).toBe("confirmed");
		},
	);

	it("a deferred scanner covered only by the PRE-NOTIFY snapshot stays covered", async () => {
		// The other half of the union, which nothing pinned. The scanner published
		// for these bytes BEFORE this touch, so the deferred touch's snapshot has it;
		// then the holding touch's write lands and CLEARS its cache, so the live read
		// at merge time finds nothing. Coverage must survive that — the snapshot is
		// in the union precisely because a landed write erases the evidence. A door
		// that keeps only the live half passes every other probe in this file.
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const { hashDiagnosticContent } =
			await import("../../../clients/lsp/diagnostic-binding.js");
		const service = new LSPService();

		const storedFinding = makeDiagnostic("previously published finding");
		const auxBase = makeClient("opengrep", NOTIFY_BUDGET_MS * 3, [], "never");
		// Starts holding a publication for exactly this content; the write that
		// lands clears both, exactly as `clearDiagnosticsForPath` does in production.
		let cacheCleared = false;
		const aux = {
			...auxBase,
			getDiagnostics: vi.fn(() => (cacheCleared ? [] : [storedFinding])),
			getDiagnosticBinding: vi.fn(() =>
				cacheCleared
					? undefined
					: { contentHash: hashDiagnosticContent(CONTENT) },
			),
			notify: {
				...auxBase.notify,
				open: vi.fn(() =>
					auxBase.notify.open().then(() => {
						cacheCleared = true;
					}),
				),
			},
		};
		// The delayed primary is load-bearing: it keeps the deferred touch inside its
		// diagnostics wait until AFTER the holding write lands, so the live read is
		// already empty when the merge asks. With an instantly-publishing primary the
		// deferred touch merges before the clear and the live half answers, which
		// leaves the snapshot half untested.
		const primary = makePublishingPrimary(PRIMARY_PUBLISH_MS);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? aux : primary,
		);

		const touchOptions = {
			clientScope: "with-auxiliary" as const,
			auxiliaryServerIds: ["opengrep"],
			diagnostics: "document" as const,
			collectDiagnostics: true,
			source: "cascade",
		};
		const holding = service.touchFile(FILE, CONTENT, touchOptions);
		await vi.advanceTimersByTimeAsync(1);
		const deferred = service.touchFile(FILE, CONTENT, touchOptions);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		const [, deferredResult] = (await Promise.all([holding, deferred])) as [
			TouchResult,
			TouchResult,
		];

		expect(rowsFor("lsp_notify_resync_deferred")).toHaveLength(1);
		// The live read is empty by now — only the pre-notify snapshot can cover it.
		expect(aux.getDiagnosticBinding()).toBeUndefined();
		expect(deferredResult?.unconfirmedServerIds ?? []).not.toContain(
			"opengrep",
		);
		expect(deferredResult?.confirmation).toBe("confirmed");
		// Carried in from the snapshot, since the live cache is empty by now.
		expect(deferredResult?.diags.map((d) => d.message)).toContain(
			"previously published finding",
		);
	});

	/**
	 * #1586 review round (F1). The merge freezes its drop decisions and applies
	 * them; `touchFile` then AWAITS — `brokenSkippedAuxiliaryServerIds` on every
	 * collecting touch, plus the tsserver-sync and liveness gates on their paths —
	 * before it settles `unconfirmedServerIds`. Asking the live predicate again at
	 * that second instant lets a publication that landed in between un-name a
	 * scanner whose findings the first instant already dropped: the result claims
	 * `confirmed` while its `.diags` is missing the scanner's answer, and the
	 * `lsp_scanner_coverage_gap` row (frozen at the merge) contradicts it. That is
	 * #1459's blackout reading as scanned-clean — the overclaim direction, which
	 * also unblocks the `lastKnownDiagnostics` prime and the `demonstratedReady`
	 * mark that `coverageGap` exists to hold shut.
	 *
	 * The pair below shares one clock: the auxiliary's publication becomes visible
	 * once the merge has read the PRIMARY's cache. That read is the merge's own
	 * `getDiagnostics` call, made exactly once per collecting touch, so it marks
	 * the instant the drop was frozen and applied — everything the auxiliary
	 * reports after it lands in the window the naming filter used to re-read.
	 *
	 * Spreading `makeClient` freezes its `diagnosticsVersion` getter; harmless
	 * here because every evidence check in play reads the per-path stamp, whose
	 * accessor closes over the live map.
	 */
	function makePostMergePublishPair(auxWriteMs: number, contentHash: string) {
		let merged = false;
		const primaryBase = makeClient("typescript", 0, [
			makeDiagnostic("primary finding"),
		]);
		const primary = {
			...primaryBase,
			getDiagnostics: vi.fn(() => {
				merged = true;
				return primaryBase.getDiagnostics();
			}),
		};
		const auxBase = makeClient("opengrep", auxWriteMs, [], "never");
		const aux = {
			...auxBase,
			getDiagnostics: vi.fn(() =>
				merged ? [makeDiagnostic(POST_MERGE_FINDING)] : [],
			),
			getDiagnosticBinding: vi.fn(() => (merged ? { contentHash } : undefined)),
		};
		return { primary, aux };
	}

	function lastKnownFor(service: unknown, filePath: string): unknown {
		return (
			service as { lastKnownDiagnostics: Map<string, unknown> }
		).lastKnownDiagnostics.get(normalizeMapKey(filePath));
	}

	it("stale-write door: a publication landing after the merge cannot un-name the drop", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const { hashDiagnosticContent } =
			await import("../../../clients/lsp/diagnostic-binding.js");
		const service = new LSPService();

		// The write is charged as timed out (3x the budget), so the merge drops the
		// scanner's findings. The scan then publishes — after the merge.
		const { primary, aux } = makePostMergePublishPair(
			NOTIFY_BUDGET_MS * 3,
			hashDiagnosticContent(CONTENT),
		);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? aux : primary,
		);

		const touch = service.touchFile(FILE, CONTENT, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		const result = (await touch) as TouchResult;

		// The drop stands — that decision was made and cannot be unmade here.
		expect(result?.diags.map((d) => d.message)).not.toContain(
			POST_MERGE_FINDING,
		);
		// So the touch must still say it does not speak for the scanner.
		expect(result?.unconfirmedServerIds).toContain("opengrep");
		expect(result?.confirmation).toBe("partial");
		// And the gap row must not contradict the result it was logged beside.
		const gapRow = rowsFor("lsp_scanner_coverage_gap")[0];
		expect(
			(gapRow?.metadata as { auxNoAnswerServerIds?: string[] })
				?.auxNoAnswerServerIds,
		).toContain("opengrep");
		// Downstream: `coverageGap` is what holds the cache prime shut (#1470/#1493).
		expect(lastKnownFor(service, FILE)).toBeUndefined();
	});

	it("deferred door: a publication landing after the merge cannot un-name the drop", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const { hashDiagnosticContent } =
			await import("../../../clients/lsp/diagnostic-binding.js");
		const service = new LSPService();

		const { primary, aux } = makePostMergePublishPair(
			NOTIFY_BUDGET_MS * 3,
			hashDiagnosticContent(CONTENT),
		);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? aux : primary,
		);

		const touchOptions = {
			clientScope: "with-auxiliary" as const,
			auxiliaryServerIds: ["opengrep"],
			diagnostics: "document" as const,
			collectDiagnostics: true,
			source: "cascade",
		};
		const holding = service.touchFile(FILE, CONTENT, touchOptions);
		await vi.advanceTimersByTimeAsync(1);
		const deferred = service.touchFile(FILE, CONTENT, touchOptions);
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		const [, deferredResult] = (await Promise.all([holding, deferred])) as [
			TouchResult,
			TouchResult,
		];

		expect(rowsFor("lsp_notify_resync_deferred")).toHaveLength(1);
		expect(deferredResult?.diags.map((d) => d.message)).not.toContain(
			POST_MERGE_FINDING,
		);
		expect(deferredResult?.unconfirmedServerIds).toContain("opengrep");
		expect(deferredResult?.confirmation).toBe("partial");
		// No cache assertion here: the HOLDING touch merges after the publication and
		// is legitimately confirmed, so it primes the cache on its own evidence. The
		// single-touch probe above is where the prime is pinned.
	});

	it("keeps ONE content-match rule and ONE coverage predicate", async () => {
		// The single-predicate property, asserted by construction — and tightened
		// after the review round, which showed the previous form fenced a second
		// read of the SNAPSHOT VARIABLE rather than a second coverage RULE: a door
		// given its own inline `contentHash === touchContentHash` test sailed
		// through green.
		//
		// Both atoms are pinned now. `touchContentHash` is readable only by the one
		// comparator every content-bound question goes through (including
		// `carriedAuxiliary`, which asks it before the notify), and the pre-notify
		// snapshot is readable only by `auxCoversThisContent`. A door that invents
		// its own rule has to reference one of them and turns this red.
		const source = await fs.readFile(
			fileURLToPath(new URL("../../../clients/lsp/index.ts", import.meta.url)),
			"utf-8",
		);
		const code = source
			.split("\n")
			.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
		const hashSites = code.filter((line) => line.includes("touchContentHash"));
		expect(hashSites).toHaveLength(2);
		expect(hashSites[0]).toContain("const touchContentHash");
		expect(hashSites[1]).toContain("=== touchContentHash");
		const snapshotSites = code.filter((line) =>
			line.includes("auxPublishedThisContent"),
		);
		expect(snapshotSites).toHaveLength(2);
		expect(snapshotSites[0]).toContain("const auxPublishedThisContent");
		expect(snapshotSites[1]).toContain("auxPublishedThisContent.has(serverId)");
	});

	/**
	 * #1586 review round (F3). `mergeBinding` used to filter the RAW deferral set
	 * (`deferredResyncServerIds`), which excludes every deferred scanner from the
	 * merged binding regardless of whether the merge kept its findings. That
	 * diverges from `droppedAuxiliaryServerIds` — the frozen set the drop and the
	 * naming both read — exactly when a deferred scanner is COVERED: its findings
	 * ride along in `.diags`, but the raw filter still throws away its fingerprint.
	 *
	 * The divergence only surfaces with a version-less primary (`makeClient` never
	 * defines `getDiagnosticBinding`, matching a real primary that never bound a
	 * publish fingerprint): with a bound primary in the mix, its own fingerprint
	 * would win the merge and hide the loss. Here the covered auxiliary is the
	 * ONLY contributor with a fingerprint, so its absence from the merged binding
	 * is the only signal.
	 */
	it("F3: the merged binding carries a deferred-but-covered scanner's fingerprint", async () => {
		const { hashDiagnosticContent } =
			await import("../../../clients/lsp/diagnostic-binding.js");
		const contentHash = hashDiagnosticContent(CONTENT);
		const { deferredResult } = await runDeferredPublishRace(
			"with-auxiliary",
			contentHash,
		);

		// Sanity check first: the scanner's findings really did merge (F1's
		// guarantee) — otherwise a missing fingerprint would be unsurprising.
		expect(deferredResult?.diags.map((d) => d.message)).toContain(LATE_FINDING);
		expect(
			(deferredResult as unknown as { binding?: { contentHash?: string } })
				?.binding?.contentHash,
		).toBe(contentHash);
	});
});

/**
 * #1586 review round (FIND-1). The reconciliation filter on
 * `unconfirmedServerIds` (`!auxCoveredAtMerge.has(serverId)`, index.ts) is what
 * F1's fix rests on: `auxUnconfirmedServerIds` is decided when the aux WAIT
 * ends, strictly before the merge, so a publication landing between that wait
 * outcome and the merge freeze would otherwise leave the scanner named while
 * the merge kept its findings. Deleting the filter leaves every other probe in
 * this file green — it is reachable but nothing else in the suite exercises it.
 *
 * This is its own top-level describe, not nested under the "#1586" block above,
 * because it needs a publication that lands strictly between the aux
 * wait-outcome row and the merge's own read of the primary's cache — a single
 * touch, not the holding/deferred race the other #1586 probes share.
 */
describe("#1586 review round (FIND-1) — publication lands between the aux wait outcome and the merge", () => {
	const FILE = `${ROOT}/a.ts`;
	const CONTENT = "const value = 1;";

	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = String(NOTIFY_BUDGET_MS);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
	});

	it("does not name a scanner the merge kept", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const { hashDiagnosticContent } =
			await import("../../../clients/lsp/diagnostic-binding.js");
		const service = new LSPService();
		const hash = hashDiagnosticContent(CONTENT);

		let published = false;
		logLatency.mockImplementation((entry: { phase?: string }) => {
			if (entry?.phase === "lsp_aux_wait_outcome") published = true;
		});

		const auxBase = makeClient("opengrep", 0, [], "never");
		const aux = {
			...auxBase,
			getDiagnostics: vi.fn(() =>
				published ? [makeDiagnostic("late scanner finding")] : [],
			),
			getDiagnosticBinding: vi.fn(() =>
				published ? { contentHash: hash } : undefined,
			),
		};
		const primary = makeClient("typescript", 0, [makeDiagnostic("primary")]);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			makeServer("opengrep", "auxiliary"),
		]);
		createLSPClient.mockImplementation(
			async (options: { serverId?: string }) =>
				options?.serverId === "opengrep" ? aux : primary,
		);

		const touch = service.touchFile(FILE, CONTENT, {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep"],
			diagnostics: "document",
			collectDiagnostics: true,
			source: "cascade",
		});
		await vi.advanceTimersByTimeAsync(NOTIFY_BUDGET_MS * 200);
		const result = (await touch) as {
			diags: Array<{ message: string }>;
			confirmation?: string;
			unconfirmedServerIds?: string[];
		};

		expect(result.diags.map((d) => d.message)).toContain(
			"late scanner finding",
		);
		expect(result.unconfirmedServerIds ?? []).not.toContain("opengrep");
		expect(result.confirmation).toBe("confirmed");
	});
});
