// flake-shape: raw-timer-wait — fake timers exercise the live hook remainder after delayed pre-snapshot work

/**
 * #1549 — the touch verdict is PER SERVER, aggregated honestly.
 *
 * The rule this replaced was `inconclusive = notifyWriteTimedOut ||
 * diagnosticsTimedOut` with both flags TOUCH-WIDE over every spawned server. A
 * cascade neighbour sweep attaches ~5 servers per touch, `timeoutMs` is the MAX
 * over the servers waited on, and opengrep declares 3500ms — so one slow-but-
 * healthy scanner made the whole touch report "nothing is known about this file"
 * even when typescript answered in 100ms. Measured over 6,079 neighbour sweeps:
 * 97.6% inconclusive, against 15% for ordinary edit-time touches in the same
 * window; a post-#1528 dogfood still showed 37/37 inconclusive with the flood
 * fixed, which is what confirmed the merge rule as the driver.
 *
 * What must hold now:
 *   1. An answered primary beside a slow auxiliary is NOT inconclusive — its
 *      findings are usable — and the auxiliary is named as a coverage gap
 *      (`confirmation: "partial"` + `unconfirmedServerIds`, the #1493/#1533
 *      machinery), so nothing reads it as a clean bill of health.
 *   2. A primary that produced no evidence still makes the touch inconclusive
 *      (the fix may only ever NARROW a verdict, never invent a confirmation).
 *   3. An auxiliary's notify-write failure is a coverage gap too, not a verdict.
 *   4. A primary's notify-write failure IS a verdict, attributed as such.
 *   5. `inconclusiveServerIds`/`inconclusiveReason` name who and why, on the
 *      result and in `lsp_touch_file`/`lsp_diagnostics_timeout` — the issue's
 *      observability contract, so the next forensic sweep reads the cause
 *      instead of inferring it from duration histograms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	hashDiagnosticContent,
	resolveTouchVerdict,
} from "../../../clients/lsp/diagnostic-binding.js";
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
vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

const FILE = "C:/repo/main.ts";

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

function makeServer(id: string, role?: "auxiliary", custom = false) {
	return {
		id,
		name: id,
		extensions: [".ts"],
		...(role && { role }),
		...(custom && { custom }),
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
	};
}

function makeDiagnostic(message: string) {
	return {
		severity: 1 as const,
		message,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 5 },
		},
	};
}

/**
 * A faithful client double. Three production behaviours matter to every probe in
 * this file, and a double that skips any of them makes the probe vacuous
 * (defect shape 7):
 *
 *  1. `notify.open` CLEARS this path's diagnostics cache entry
 *     (`clearDiagnosticsForPath`) when the write lands. A present entry after a
 *     touch is therefore a fresh answer, which is the second evidence signal the
 *     verdict reads — and the signal the #814 aggregate gate reads through
 *     `getAllDiagnostics`, a REQUIRED method on `LSPClient`. Omitting it makes
 *     that gate throw into its own catch, so a fail-safe would pass by accident.
 *  2. A publication advances the PER-PATH stamp (#1531) and records a content
 *     BINDING for the exact bytes it was computed from (#1095/#1493) — only when
 *     the server actually publishes: findings, or an empty result under
 *     `publishesWhenClean`.
 *  3. A write can be SLOW without being lost. `notifyDelayMs` models the
 *     late-landing write that #1459 documents: charged as timed out against the
 *     caller's budget, it still lands, and the scanner then publishes for these
 *     bytes. `hangingNotify` is the other shape — a write that never lands at all.
 */
function makeClient(
	delayMs: number,
	diags: ReturnType<typeof makeDiagnostic>[] = [],
	options: {
		serverId: string;
		customServer?: boolean;
		publishesWhenClean?: boolean;
		/**
		 * Model a write that never lands (stalled stdin / backpressure), from the
		 * Nth write onward. `0` hangs every write; `1` lets the first land and hangs
		 * the rest, which is how a scanner ends up holding a PREVIOUS revision's
		 * findings while the touch that would have cleared them stalls.
		 */
		hangingNotifyAfterWrites?: number;
		/** Model a write that lands LATE (past the caller's notify budget). */
		notifyDelayMs?: number;
		waitForDiagnosticsRejects?: boolean;
	},
) {
	let version = 0;
	let writeCount = 0;
	const stampsByPath = new Map<string, number>();
	const cache = new Map<string, { diags: unknown[]; ts: number }>();
	const bindings = new Map<string, string>();
	/** The content each path's write last delivered, i.e. what a publish binds to. */
	const deliveredContent = new Map<string, string>();
	const publishes = diags.length > 0 || options.publishesWhenClean === true;
	const landWrite = (filePath: string, content: string): void => {
		cache.delete(normalizeMapKey(filePath));
		bindings.delete(filePath);
		deliveredContent.set(filePath, content);
	};
	return {
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
		getLaunchVariant: () => undefined,
		serverId: options.serverId,
		customServer: options.customServer === true,
		root: "C:/repo",
		get diagnosticsVersion() {
			return version;
		},
		getDiagnosticsVersionForPath: vi.fn(
			(filePath: string) => stampsByPath.get(filePath) ?? 0,
		),
		getDiagnostics: vi.fn(
			(filePath: string) =>
				(cache.get(normalizeMapKey(filePath))?.diags ?? []) as ReturnType<
					typeof makeDiagnostic
				>[],
		),
		getAllDiagnostics: vi.fn(() => cache),
		getDiagnosticBinding: vi.fn((filePath: string) => {
			const contentHash = bindings.get(filePath);
			return contentHash === undefined ? undefined : { contentHash };
		}),
		notify: {
			open: vi.fn((filePath: string, content: string) => {
				writeCount += 1;
				if (
					options.hangingNotifyAfterWrites !== undefined &&
					writeCount > options.hangingNotifyAfterWrites
				) {
					return new Promise<void>(() => {});
				}
				if (options.notifyDelayMs === undefined) {
					landWrite(filePath, content);
					return Promise.resolve();
				}
				return new Promise<void>((resolve) =>
					setTimeout(() => {
						landWrite(filePath, content);
						resolve();
					}, options.notifyDelayMs),
				);
			}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		pingLiveness: vi.fn().mockResolvedValue(true),
		waitForDiagnostics: vi.fn((filePath: string) => {
			if (options.waitForDiagnosticsRejects) {
				return Promise.reject(new Error("server transport failed"));
			}
			return new Promise<void>((resolve) =>
				setTimeout(() => {
					// A server publishes about the content it actually RECEIVED. With
					// no write landed there is nothing new to say, so a hanging write
					// leaves the previous publication (and its binding) in place —
					// exactly the stale-findings hazard the merge has to drop.
					const delivered = deliveredContent.get(filePath);
					if (publishes && delivered !== undefined) {
						version += 1;
						stampsByPath.set(filePath, version);
						cache.set(normalizeMapKey(filePath), {
							diags,
							ts: Date.now(),
						});
						bindings.set(filePath, hashDiagnosticContent(delivered));
					}
					resolve();
				}, delayMs),
			);
		}),
	};
}

/**
 * The multi-server sweep touch shape: `clientScope: "all"`, which is where a
 * primary and its auxiliaries are waited on together (`lens_diagnostics`
 * mode=full, `lsp_diagnostics` `serverScope: "all"`).
 *
 * This was the cascade neighbour fan-out's own shape when #1549 landed. #1720
 * has since narrowed that fan-out to `clientScope: "primary"` (integration.ts),
 * so the cascade lane no longer attaches auxiliaries at all — the touch-wide
 * collapse this file guards is unreachable from THAT caller today. The probes
 * stay on the "all" scope because that is the surface where the merge rule is
 * still live; naming the wrong caller would make them look like cascade
 * regression tests they are not.
 */
const CASCADE_TOUCH = {
	clientScope: "all" as const,
	collectDiagnostics: true as const,
	diagnostics: "document" as const,
	maxClientWaitMs: 1000,
	silent: true,
	source: "cascade",
};

function latencyRows(phase: string) {
	return logLatency.mock.calls
		.map(([entry]) => entry)
		.filter((entry) => entry?.phase === phase);
}

/**
 * Mount a service over the given clients. `primary` may be omitted to model a
 * file whose only configured server is a scanner (no language server) — the
 * aux-only fail-safe shape.
 */
async function mountService(clients: {
	primary?: ReturnType<typeof makeClient>;
	aux: ReturnType<typeof makeClient> | ReturnType<typeof makeClient>[];
}) {
	const { LSPService } = await import("../../../clients/lsp/index.js");
	const service = new LSPService();
	const auxClients = Array.isArray(clients.aux) ? clients.aux : [clients.aux];
	getServersForFileWithConfig.mockReturnValue([
		...(clients.primary
			? [
					makeServer(
						clients.primary.serverId,
						undefined,
						clients.primary.customServer,
					),
				]
			: []),
		...auxClients.map((client) =>
			makeServer(client.serverId, "auxiliary", client.customServer),
		),
	]);
	createLSPClient.mockImplementation(
		async (options: { serverId?: string }) =>
			auxClients.find((client) => client.serverId === options?.serverId) ??
			clients.primary,
	);
	return service;
}

async function touchOnce(
	service: {
		touchFile: (
			filePath: string,
			content: string,
			options: Record<string, unknown>,
		) => Promise<
			| {
					diags: Array<{ message: string }>;
					confirmation?: string;
					inconclusive?: boolean;
					inconclusiveServerIds?: string[];
					inconclusiveReason?: string;
					unconfirmedServerIds?: string[];
					diagnosticsUnsupportedServerIds?: string[];
			  }
			| undefined
		>;
	},
	content = "const x = 1;",
	overrides: Record<string, unknown> = {},
) {
	const touch = service.touchFile(FILE, content, {
		...CASCADE_TOUCH,
		...overrides,
	});
	await vi.advanceTimersByTimeAsync(8000);
	return await touch;
}

async function runTouch(
	primary: ReturnType<typeof makeClient>,
	aux: ReturnType<typeof makeClient>,
) {
	return await touchOnce(await mountService({ primary, aux }));
}

describe("#1549 — per-server touch verdict", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		logLatency.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
	});

	it("tonight's shape: an answered primary beside a slow auxiliary is USABLE, not inconclusive", async () => {
		// Exactly the observed sweep touch: typescript publishes a finding at 100ms,
		// opengrep needs 5000ms against a 1000ms cap, so the aggregate deadline
		// (max over waited servers) lapses on the auxiliary's account alone.
		const result = await runTouch(
			makeClient(100, [makeDiagnostic("primary error")], {
				serverId: "ts-primary",
			}),
			makeClient(5000, [], { serverId: "opengrep" }),
		);

		// The verdict under test.
		expect(result?.inconclusive).toBeUndefined();
		expect(result?.inconclusiveReason).toBeUndefined();
		// The primary's findings flow to the consumer.
		expect((result?.diags ?? []).map((d) => d.message)).toContain(
			"primary error",
		);
		// And the coverage claim is withdrawn, naming the scanner — so
		// `isConfirmedTouch` still fails closed and no cache is seeded from this.
		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
	});

	it("the sweep shape with TWO auxiliaries: the healthy scanner's findings survive the slow one's lapse", async () => {
		// The issue's actual population — a sweep touch attaches ~5 servers, and the
		// aggregate deadline is the MAX over them, so ONE slow scanner lapses the wait
		// for everyone. The single-auxiliary probes above pin the primary's answer;
		// this one pins the SIBLING auxiliary's, which is the other half of "discards
		// every good answer from the other servers in the same sweep". A merge that
		// drops on any timeout (rather than per contributor) still passes every
		// single-aux probe in this file and loses `typos finding` here.
		const result = await touchOnce(
			await mountService({
				primary: makeClient(100, [makeDiagnostic("primary error")], {
					serverId: "ts-primary",
				}),
				aux: [
					makeClient(150, [makeDiagnostic("typos finding")], {
						serverId: "typos",
					}),
					makeClient(5000, [], { serverId: "opengrep" }),
				],
			}),
		);

		expect((result?.diags ?? []).map((d) => d.message)).toEqual([
			"primary error",
			"typos finding",
		]);
		expect(result?.inconclusive).toBeUndefined();
		// Per-SERVER, not per-touch: only the scanner that said nothing is named.
		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
		// And the record carries the same per-server attribution, so a forensic
		// sweep can tell a lapsed auxiliary from a lapsed touch.
		expect(latencyRows("lsp_diagnostics_timeout")[0]?.metadata).toMatchObject({
			unansweredServerIds: ["opengrep"],
			attributedToPrimary: false,
		});
		expect(latencyRows("degradation_ledger")).toContainEqual(
			expect.objectContaining({
				metadata: expect.objectContaining({
					kind: "lsp-diagnostics-timeout",
					subject: "opengrep",
				}),
			}),
		);
	});

	it("the same shape on a CLEAN primary: confirmed-empty findings survive as partial", async () => {
		// The higher-frequency half of the sweep — a neighbour with nothing wrong.
		// The primary publishes an empty result (evidence that it ran), so the touch
		// speaks for it; only opengrep's coverage is missing.
		const result = await runTouch(
			makeClient(100, [], { serverId: "ts-primary", publishesWhenClean: true }),
			makeClient(5000, [], { serverId: "opengrep" }),
		);

		expect(result?.inconclusive).toBeUndefined();
		expect(result?.diags).toEqual([]);
		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
	});

	it("the latency row attributes the lapse: unansweredServerIds names the aux, attributedToPrimary is false", async () => {
		await runTouch(
			makeClient(100, [makeDiagnostic("primary error")], {
				serverId: "ts-primary",
			}),
			makeClient(5000, [], { serverId: "opengrep" }),
		);

		const timeoutRow = latencyRows("lsp_diagnostics_timeout")[0];
		expect(timeoutRow?.metadata).toMatchObject({
			unansweredServerIds: ["opengrep"],
			attributedToPrimary: false,
		});
		expect(latencyRows("degradation_ledger")).toContainEqual(
			expect.objectContaining({
				metadata: expect.objectContaining({
					kind: "lsp-diagnostics-timeout",
					subject: "opengrep",
				}),
			}),
		);
		const touchRow = latencyRows("lsp_touch_file")[0];
		expect(touchRow?.metadata).toMatchObject({
			inconclusive: false,
			confirmation: "partial",
		});
		expect(touchRow?.metadata).not.toHaveProperty("inconclusiveReason");
	});

	it("FAIL-SAFE: a primary with no evidence keeps the touch inconclusive, and says so", async () => {
		// The primary settles its wait having published nothing, and is not
		// classified silent-on-clean, so its silence is genuinely ambiguous. The fix
		// may only NARROW a verdict — it must never absolve this touch on the
		// strength of an auxiliary.
		const result = await runTouch(
			makeClient(100, [], { serverId: "ts-primary" }),
			makeClient(5000, [], { serverId: "opengrep" }),
		);

		expect(result?.inconclusive).toBe(true);
		expect(result?.confirmation).toBeUndefined();
		// #1549's observability contract: WHICH server, and WHICH deadline.
		expect(result?.inconclusiveServerIds).toEqual(["ts-primary"]);
		expect(result?.inconclusiveReason).toBe("diagnostics-wait");
		expect(latencyRows("lsp_touch_file")[0]?.metadata).toMatchObject({
			inconclusive: true,
			inconclusiveServerIds: ["ts-primary"],
			inconclusiveReason: "diagnostics-wait",
		});
		expect(latencyRows("lsp_diagnostics_timeout")[0]?.metadata).toMatchObject({
			attributedToPrimary: true,
		});
	});

	it("an AUXILIARY's notify write timing out is a coverage gap, not a verdict", async () => {
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "50";
		// opengrep's write never lands, so it was never sent these bytes and has
		// nothing to say about them. The primary answered, so the touch stands on its
		// findings and names the scanner instead of collapsing.
		const result = await runTouch(
			makeClient(100, [makeDiagnostic("primary error")], {
				serverId: "ts-primary",
			}),
			makeClient(100, [], {
				serverId: "opengrep",
				publishesWhenClean: true,
				hangingNotifyAfterWrites: 0,
			}),
		);

		expect(result?.inconclusive).toBeUndefined();
		expect((result?.diags ?? []).map((d) => d.message)).toContain(
			"primary error",
		);
		expect(result?.confirmation).toBe("partial");
		expect(result?.unconfirmedServerIds).toEqual(["opengrep"]);
		// The blackout keeps a record of its own, through the door that produced it —
		// a failed write leaves no wait outcome row for the coverage policy to read.
		expect(latencyRows("lsp_scanner_coverage_gap")[0]?.metadata).toMatchObject({
			auxNoAnswerServerIds: ["opengrep"],
		});
	});

	it("an auxiliary holding the PREVIOUS revision's findings does not get them merged as this touch's answer", async () => {
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "50";
		// The scanner's first write lands and it publishes a finding for revision one.
		// On the second touch its write stalls, so nothing clears that cache: the
		// finding is about bytes this touch does not carry. Before #1549 the touch was
		// blanket `inconclusive` and no consumer read `.diags`; now the primary's
		// answer flows, so the stale finding would have flowed with it, carrying the
		// previous revision's line numbers.
		const service = await mountService({
			primary: makeClient(100, [makeDiagnostic("primary error")], {
				serverId: "ts-primary",
			}),
			aux: makeClient(100, [makeDiagnostic("scanner finding rev1")], {
				serverId: "opengrep",
				hangingNotifyAfterWrites: 1,
			}),
		});

		const first = await touchOnce(service, "revision one");
		// A precondition, not the assertion under test: revision one WAS covered.
		expect((first?.diags ?? []).map((d) => d.message)).toContain(
			"scanner finding rev1",
		);
		expect(first?.confirmation).toBe("confirmed");

		const second = await touchOnce(service, "revision two");
		expect((second?.diags ?? []).map((d) => d.message)).toEqual([
			"primary error",
		]);
		expect(second?.inconclusive).toBeUndefined();
		expect(second?.confirmation).toBe("partial");
		expect(second?.unconfirmedServerIds).toEqual(["opengrep"]);
	});

	it("#1493 outranks the drop at MERGE time: a late-landing write that publishes for THESE bytes is covered", async () => {
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "50";
		// #1459's documented signature: the write is charged as timed out against the
		// caller's budget and then LANDS anyway, after which the scanner publishes for
		// this touch's content. The pre-notify content snapshot cannot see that — it
		// was captured before the write — so judging the scanner on it alone drops
		// findings that ARE about these bytes and names a scanner that answered. The
		// exemption is therefore re-read at merge time.
		const result = await runTouch(
			makeClient(100, [makeDiagnostic("primary error")], {
				serverId: "ts-primary",
			}),
			makeClient(300, [makeDiagnostic("scanner finding")], {
				serverId: "opengrep",
				notifyDelayMs: 150,
			}),
		);

		expect((result?.diags ?? []).map((d) => d.message)).toEqual([
			"primary error",
			"scanner finding",
		]);
		expect(result?.inconclusive).toBeUndefined();
		expect(result?.confirmation).toBe("confirmed");
		expect(result?.unconfirmedServerIds).toBeUndefined();
	});

	it("FAIL-SAFE: a touch with NO primary keeps the pre-#1549 touch-wide verdict", async () => {
		// A file whose only configured server is a scanner has no primary answer to
		// preserve, so there is nothing to absolve the touch WITH. Absolving it would
		// report "we heard from everyone we needed" about a touch that heard from
		// nobody — the overclaim direction of the same dishonesty.
		const service = await mountService({
			aux: makeClient(5000, [], { serverId: "opengrep" }),
		});
		const result = await touchOnce(service);

		expect(result?.inconclusive).toBe(true);
		expect(result?.confirmation).toBeUndefined();
		// Nobody to attribute it to: the verdict stands on the flag, honestly
		// unattributed, rather than blaming an auxiliary it never blames elsewhere.
		expect(result?.inconclusiveServerIds).toBeUndefined();
		expect(result?.inconclusiveReason).toBe("diagnostics-wait");
	});

	it("keeps a primary navigation-only server unconfirmed beside an answered auxiliary", async () => {
		// A navigation-only primary is excluded from the diagnostics wait. The
		// auxiliary can answer, but its evidence cannot become a primary verdict.
		const service = await mountService({
			primary: makeClient(100, [], {
				serverId: "nav-primary",
				customServer: true,
			}),
			aux: makeClient(5000, [makeDiagnostic("scanner finding")], {
				serverId: "opengrep",
			}),
		});
		const result = await touchOnce(service);

		expect(result?.inconclusive).toBeUndefined();
		expect(result?.confirmation).toBeUndefined();
		expect(result?.inconclusiveServerIds).toBeUndefined();
		expect(result?.inconclusiveReason).toBeUndefined();
	});

	it("waits once before latching a silent custom primary as navigation-only", async () => {
		const primary = makeClient(100, [], {
			serverId: "dexter",
			customServer: true,
		});
		const service = await mountService({
			primary,
			aux: makeClient(100, [], { serverId: "opengrep" }),
		});

		const result = await touchOnce(service);

		expect(primary.waitForDiagnostics).toHaveBeenCalledTimes(1);
		expect(result?.diagnosticsUnsupportedServerIds).toEqual(["dexter"]);
		expect(result?.confirmation).toBeUndefined();
		expect(result?.inconclusive).toBeUndefined();

		const second = await touchOnce(service, "const y = 2;");
		expect(primary.waitForDiagnostics).toHaveBeenCalledTimes(1);
		expect(second?.diagnosticsUnsupportedServerIds).toEqual(["dexter"]);
		expect(second?.confirmation).toBeUndefined();
	});

	it("shares one first-contact wait across concurrent touches", async () => {
		const primary = makeClient(5000, [], {
			serverId: "dexter",
			customServer: true,
		});
		const service = await mountService({
			primary,
			aux: makeClient(0, [], { serverId: "opengrep" }),
		});

		const first = service.touchFile(FILE, "const x = 1;", CASCADE_TOUCH);
		const second = service.touchFile(FILE, "const y = 2;", CASCADE_TOUCH);
		await vi.advanceTimersByTimeAsync(8000);
		const results = await Promise.all([first, second]);

		expect(primary.waitForDiagnostics).toHaveBeenCalledTimes(1);
		expect(results).toHaveLength(2);
		expect(results[0]?.diagnosticsUnsupportedServerIds).toEqual(["dexter"]);
		expect(results[1]?.diagnosticsUnsupportedServerIds).toEqual(["dexter"]);
	});

	it("fails closed when a shared first-contact probe rejects", async () => {
		const primary = makeClient(100, [], {
			serverId: "dexter",
			customServer: true,
			waitForDiagnosticsRejects: true,
		});
		const service = await mountService({
			primary,
			aux: makeClient(0, [], { serverId: "opengrep" }),
		});

		const first = service.touchFile(FILE, "const x = 1;", CASCADE_TOUCH);
		const second = service.touchFile(FILE, "const y = 2;", CASCADE_TOUCH);
		await vi.advanceTimersByTimeAsync(100);
		const results = await Promise.all([first, second]);

		expect(results.every((result) => result?.inconclusive)).toBe(true);
		expect(results.map((result) => result?.inconclusiveServerIds)).toEqual([
			["dexter"],
			["dexter"],
		]);
		expect(results[0]?.diagnosticsUnsupportedServerIds).toBeUndefined();

		const retry = service.touchFile(FILE, "const z = 3;", CASCADE_TOUCH);
		await vi.advanceTimersByTimeAsync(100);
		await retry;
		expect(primary.waitForDiagnostics).toHaveBeenCalledTimes(2);
	});

	it("does not latch first contact when the live hook deadline cuts the push wait", async () => {
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "5000";
		const primary = makeClient(5000, [], {
			serverId: "dexter",
			customServer: true,
		});
		const service = await mountService({
			primary,
			aux: makeClient(0, [], { serverId: "opengrep" }),
		});
		vi.spyOn(service, "getCapabilitySnapshots").mockResolvedValue([]);

		let settled = false;
		const first = service.touchFile(FILE, "const x = 1;", {
			...CASCADE_TOUCH,
			maxClientWaitMs: 5000,
			hook: "turn_end",
		});
		void first.then(() => {
			settled = true;
		});

		for (let i = 0; i < 100; i += 1) {
			await Promise.resolve();
			if (primary.waitForDiagnostics.mock.calls.length > 0) break;
		}
		expect(primary.waitForDiagnostics).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(3100);
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(true);
		const firstResult = await first;
		expect(firstResult?.diagnosticsUnsupportedServerIds).toBeUndefined();

		const second = service.touchFile(FILE, "const y = 2;", {
			...CASCADE_TOUCH,
			maxClientWaitMs: 5000,
			hook: "turn_end",
		});
		await vi.advanceTimersByTimeAsync(5000);
		await second;
		expect(primary.waitForDiagnostics).toHaveBeenCalledTimes(1);
		const third = await touchOnce(service, "const z = 3;");
		expect(third?.diagnosticsUnsupportedServerIds).toEqual(["dexter"]);
		expect(primary.waitForDiagnostics).toHaveBeenCalledTimes(1);
	});

	it("settles a first-contact wait when shutdown interrupts the shared probe", async () => {
		// #2765 round 6: a shutdown used to leave a silent first-contact caller
		// behind the push deadline; this pins the shutdown arm and destroyed guard.
		const primary = makeClient(5000, [], {
			serverId: "dexter",
			customServer: true,
		});
		const service = await mountService({
			primary,
			aux: makeClient(0, [], { serverId: "opengrep" }),
		});
		vi.spyOn(service, "getCapabilitySnapshots").mockResolvedValue([]);

		const touch = service.touchFile(FILE, "const x = 1;", {
			...CASCADE_TOUCH,
			maxClientWaitMs: 5000,
			hook: "session_start",
		});
		await vi.advanceTimersByTimeAsync(1);
		for (
			let i = 0;
			i < 20 && primary.waitForDiagnostics.mock.calls.length === 0;
			i += 1
		) {
			await Promise.resolve();
		}
		expect(primary.waitForDiagnostics).toHaveBeenCalledTimes(1);

		await service.shutdown();
		await expect(touch).resolves.toMatchObject({
			inconclusive: true,
			inconclusiveReason: "diagnostics-wait",
		});
		expect(
			(
				service as unknown as { state: { diagnosticsUnsupported: Set<string> } }
			).state.diagnosticsUnsupported.has("dexter"),
		).toBe(false);

		await expect(
			service.touchFile(FILE, "const y = 2;", CASCADE_TOUCH),
		).resolves.toBeUndefined();
		expect(primary.waitForDiagnostics).toHaveBeenCalledTimes(1);
	});

	it("cuts the caller at the 3-second hook while the shared probe latches at 5 seconds", async () => {
		// #2765 round 6: the caller deadline must not cancel the creator-owned probe,
		// or a late navigation-only latch becomes impossible after a hook cutoff.
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "5000";
		const primary = makeClient(5000, [], {
			serverId: "dexter",
			customServer: true,
		});
		const service = await mountService({
			primary,
			aux: makeClient(0, [], { serverId: "opengrep" }),
		});
		const touch = service.touchFile(FILE, "const x = 1;", {
			...CASCADE_TOUCH,
			maxClientWaitMs: 5000,
			hook: "turn_end",
		});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(3000);
		const cutOff = await touch;
		expect(cutOff?.diagnosticsUnsupportedServerIds).toBeUndefined();
		expect(
			(
				service as unknown as { state: { diagnosticsUnsupported: Set<string> } }
			).state.diagnosticsUnsupported.has("dexter"),
		).toBe(false);

		await vi.advanceTimersByTimeAsync(2000);
		expect(
			(
				service as unknown as { state: { diagnosticsUnsupported: Set<string> } }
			).state.diagnosticsUnsupported.has("dexter"),
		).toBe(true);
	});

	it("latches navigation-only when the shared push budget ends before the hook", async () => {
		// #2765 round 6: a shared probe completing before its caller deadline must
		// classify the silent custom server instead of reporting a cutoff.
		const primary = makeClient(2000, [], {
			serverId: "dexter",
			customServer: true,
		});
		const service = await mountService({
			primary,
			aux: makeClient(0, [], { serverId: "opengrep" }),
		});
		const touch = service.touchFile(FILE, "const x = 1;", {
			...CASCADE_TOUCH,
			maxClientWaitMs: 2000,
			hook: "turn_end",
		});

		await vi.advanceTimersByTimeAsync(2000);
		await expect(touch).resolves.toMatchObject({
			diagnosticsUnsupportedServerIds: ["dexter"],
		});
	});

	it("keeps a publishing custom server push-capable when it answers inside the hook", async () => {
		// #2765 round 6: publication before the hook cutoff must win the silent
		// classification race and deliver the server's diagnostics.
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "5000";
		const primary = makeClient(2500, [makeDiagnostic("published")], {
			serverId: "dexter",
			customServer: true,
		});
		const service = await mountService({
			primary,
			aux: makeClient(0, [], { serverId: "opengrep" }),
		});
		const touch = service.touchFile(FILE, "const x = 1;", {
			...CASCADE_TOUCH,
			maxClientWaitMs: 5000,
			hook: "turn_end",
		});
		for (
			let i = 0;
			i < 20 && primary.waitForDiagnostics.mock.calls.length === 0;
			i += 1
		) {
			await Promise.resolve();
		}

		await vi.advanceTimersByTimeAsync(2500);
		await vi.advanceTimersByTimeAsync(0);
		const result = await touch;
		expect(result?.diagnosticsUnsupportedServerIds).toBeUndefined();
		expect(
			primary.getDiagnostics(FILE).map((diagnostic) => diagnostic.message),
		).toEqual(["published"]);
		expect(primary.waitForDiagnostics).toHaveBeenCalledTimes(1);
	});

	it("gives concurrent callers independent deadlines over one five-second probe", async () => {
		// #2765 round 6: caller-local cutoffs must not shorten or restart the shared
		// five-second first-contact budget when concurrent touches share a server.
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "5000";
		const primary = makeClient(5000, [], {
			serverId: "dexter",
			customServer: true,
		});
		const service = await mountService({
			primary,
			aux: makeClient(0, [], { serverId: "opengrep" }),
		});
		vi.spyOn(service, "getCapabilitySnapshots").mockResolvedValue([]);
		const first = service.touchFile(FILE, "const x = 1;", {
			...CASCADE_TOUCH,
			maxClientWaitMs: 5000,
			hook: "agent_end",
		});
		const second = service.touchFile(FILE, "const y = 2;", {
			...CASCADE_TOUCH,
			maxClientWaitMs: 5000,
			hook: "session_start",
		});

		await vi.advanceTimersByTimeAsync(1000);
		const firstResult = await first;
		expect(firstResult?.diagnosticsUnsupportedServerIds).toBeUndefined();
		await vi.advanceTimersByTimeAsync(3000);
		expect(
			await Promise.race([
				second.then(() => "settled" as const),
				Promise.resolve("pending" as const),
			]),
		).toBe("pending");
		await vi.advanceTimersByTimeAsync(1000);
		const secondResult = await second;
		expect(secondResult?.diagnosticsUnsupportedServerIds).toEqual(["dexter"]);
		expect(primary.waitForDiagnostics).toHaveBeenCalledTimes(1);
		expect(
			(
				service as unknown as { state: { diagnosticsUnsupported: Set<string> } }
			).state.diagnosticsUnsupported.has("dexter"),
		).toBe(true);
	});

	it("does not wait again after a navigation-only latch when capability snapshots are absent", async () => {
		// #2765 round 6: the latch read must remain authoritative when the later
		// capability-snapshot pass is skipped or returns no snapshot.
		const primary = makeClient(100, [], {
			serverId: "dexter",
			customServer: true,
		});
		const service = await mountService({
			primary,
			aux: makeClient(0, [], { serverId: "opengrep" }),
		});
		const snapshots = vi
			.spyOn(service, "getCapabilitySnapshots")
			.mockResolvedValue([]);

		await expect(
			touchOnce(service, "const x = 1;", { hook: "turn_end" }),
		).resolves.toMatchObject({ diagnosticsUnsupportedServerIds: ["dexter"] });
		const waits = primary.waitForDiagnostics.mock.calls.length;
		snapshots.mockResolvedValue([]);
		await expect(
			touchOnce(service, "const y = 2;", { hook: "turn_end" }),
		).resolves.toMatchObject({ diagnosticsUnsupportedServerIds: ["dexter"] });
		expect(primary.waitForDiagnostics).toHaveBeenCalledTimes(waits);
	});

	it("keeps a custom primary on normal waits when first contact publishes", async () => {
		const primary = makeClient(100, [], {
			serverId: "dexter",
			customServer: true,
			publishesWhenClean: true,
		});
		const service = await mountService({
			primary,
			aux: makeClient(100, [], {
				serverId: "opengrep",
				publishesWhenClean: true,
			}),
		});

		const first = await touchOnce(service);
		const second = await touchOnce(service, "const y = 2;");

		expect(primary.waitForDiagnostics).toHaveBeenCalledTimes(2);
		expect(first?.diagnosticsUnsupportedServerIds).toBeUndefined();
		expect(first?.confirmation).toBe("confirmed");
		expect(second?.diagnosticsUnsupportedServerIds).toBeUndefined();
		expect(second?.confirmation).toBe("confirmed");
	});

	it("records one navigation-only degradation per custom server per session", async () => {
		const primary = makeClient(100, [], {
			serverId: "dexter",
			customServer: true,
		});
		const service = await mountService({
			primary,
			aux: makeClient(100, [], { serverId: "opengrep" }),
		});

		await touchOnce(service);
		await touchOnce(service, "const y = 2;");

		expect(
			latencyRows("degradation_ledger").filter(
				(row) =>
					row?.metadata?.kind === "lsp-diagnostics-unsupported" &&
					row?.metadata?.subject === "dexter",
			),
		).toHaveLength(1);
	});

	it("bounds capability lookup by the live hook remainder", async () => {
		const service = await mountService({
			primary: makeClient(0, [], {
				serverId: "dexter",
				customServer: true,
				publishesWhenClean: true,
			}),
			aux: makeClient(0, [], {
				serverId: "opengrep",
				publishesWhenClean: true,
			}),
		});
		vi.spyOn(
			service as unknown as {
				findOutsideProjectRoot: (
					filePath: string,
				) => Promise<string | undefined>;
			},
			"findOutsideProjectRoot",
		).mockImplementation(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 2900));
			return undefined;
		});
		vi.spyOn(service, "getCapabilitySnapshots").mockImplementation(
			() => new Promise(() => {}),
		);

		let settled = false;
		const touch = service.touchFile(FILE, "const x = 1;", {
			...CASCADE_TOUCH,
			hook: "turn_end",
		});
		void touch.then(() => {
			settled = true;
		});

		await vi.advanceTimersByTimeAsync(3100);
		expect(settled).toBe(true);
		await touch;
	});

	it("a scanner that went unheard is not marked warm, even on a NON-COLLECTING touch", async () => {
		// `demonstratedReady` means "this server answered for this file". A
		// non-collecting touch derives no auxiliary wait-outcome rows, so the coverage
		// list is the only thing between an unheard scanner and a warm mark it never
		// earned — which would then let it skip a warm-up it still needs.
		const service = await mountService({
			primary: makeClient(100, [makeDiagnostic("primary error")], {
				serverId: "ts-primary",
			}),
			aux: makeClient(5000, [], { serverId: "opengrep" }),
		});
		await touchOnce(service, "const x = 1;", { collectDiagnostics: false });

		const ready = [
			...(service as unknown as { state: { demonstratedReady: Set<string> } })
				.state.demonstratedReady,
		].join(" ");
		expect(ready).toContain("ts-primary");
		expect(ready).not.toContain("opengrep");
	});

	it("a PRIMARY's notify write timing out is a verdict, attributed to notify-write", async () => {
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "50";
		// The primary never received this content; a publication it makes anyway is
		// about a different revision. The auxiliary is healthy — a good scanner must
		// not launder the primary's failure into a confirmation.
		const result = await runTouch(
			makeClient(100, [makeDiagnostic("stale finding")], {
				serverId: "ts-primary",
				hangingNotifyAfterWrites: 0,
			}),
			makeClient(100, [], { serverId: "opengrep", publishesWhenClean: true }),
		);

		expect(result?.inconclusive).toBe(true);
		expect(result?.inconclusiveServerIds).toEqual(["ts-primary"]);
		expect(result?.inconclusiveReason).toBe("notify-write");
		expect(result?.confirmation).toBeUndefined();
	});
});

describe("#1549 — resolveTouchVerdict (the merge rule, in isolation)", () => {
	it("is conclusive when no primary missed a deadline", () => {
		expect(
			resolveTouchVerdict({
				primaryNotifyWriteTimedOutServerIds: [],
				diagnosticsTimedOut: false,
				diagnosticsUnansweredServerIds: [],
			}),
		).toEqual({ inconclusive: false });
	});

	it("names the notify-write cause", () => {
		expect(
			resolveTouchVerdict({
				primaryNotifyWriteTimedOutServerIds: ["typescript"],
				diagnosticsTimedOut: false,
				diagnosticsUnansweredServerIds: [],
			}),
		).toEqual({
			inconclusive: true,
			inconclusiveServerIds: ["typescript"],
			inconclusiveReason: "notify-write",
		});
	});

	it("names the diagnostics-wait cause", () => {
		expect(
			resolveTouchVerdict({
				primaryNotifyWriteTimedOutServerIds: [],
				diagnosticsTimedOut: true,
				diagnosticsUnansweredServerIds: ["rust-analyzer"],
			}),
		).toEqual({
			inconclusive: true,
			inconclusiveServerIds: ["rust-analyzer"],
			inconclusiveReason: "diagnostics-wait",
		});
	});

	it("reports both deadlines as mixed, deduping the server ids", () => {
		expect(
			resolveTouchVerdict({
				primaryNotifyWriteTimedOutServerIds: ["typescript"],
				diagnosticsTimedOut: true,
				diagnosticsUnansweredServerIds: ["typescript", "marksman"],
			}),
		).toEqual({
			inconclusive: true,
			inconclusiveServerIds: ["typescript", "marksman"],
			inconclusiveReason: "mixed",
		});
	});

	it("stands on the flag when the attribution is unknowable, rather than blaming nobody", () => {
		// A client with no per-path publication stamp yields no attribution. The
		// verdict must survive — this is the pre-#1549 state, honestly labelled.
		expect(
			resolveTouchVerdict({
				primaryNotifyWriteTimedOutServerIds: [],
				diagnosticsTimedOut: true,
				diagnosticsUnansweredServerIds: [],
			}),
		).toEqual({ inconclusive: true, inconclusiveReason: "diagnostics-wait" });
	});
});
