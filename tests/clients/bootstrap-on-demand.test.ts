/**
 * The on-demand analyzer bootstrap seam — #2467.
 *
 * Every case here drives the REAL `clients/bootstrap.ts`: the sharing, the
 * retry, the fail-open answer, both wait bounds, and the shutdown gate are
 * exercised through the module a production caller imports, not through a
 * double that re-implements them. The load itself is made deterministic by
 * faulting or gating ONE client module's import, which is the same seam a
 * genuine unresolved-dependency failure arrives through (#285/#335) — the
 * kit's `gatedPromise`, never a `setTimeout` race.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { gatedPromise } from "../support/fault-injection.js";

type BootstrapModule = typeof import("../../clients/bootstrap.js");
type LedgerModule = typeof import("../../clients/degradation-ledger.js");

const latencyEntries: Array<Record<string, unknown>> = [];

/**
 * Mock the latency sink (never the shape — #2281) and load a FRESH bootstrap
 * module plus the ledger it writes through, so both live in the same module
 * registry and the ledger a test reads is the one the seam wrote.
 */
async function freshSeam(): Promise<{
	bootstrap: BootstrapModule;
	ledger: LedgerModule;
}> {
	vi.doMock("../../clients/latency-logger.js", async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../clients/latency-logger.js")
		>()),
		logLatency: (entry: Record<string, unknown>) => {
			latencyEntries.push(entry);
		},
	}));
	const ledger = await import("../../clients/degradation-ledger.js");
	ledger.resetDegradationLedger();
	const bootstrap = await import("../../clients/bootstrap.js");
	return { bootstrap, ledger };
}

/**
 * Suspend the analyzer build at one client module's import until the returned
 * gate is released. `ruff-client` is an arbitrary member of the set — the
 * build `Promise.all`s all seventeen, so gating any one of them gates the
 * whole load, exactly as a slow filesystem would.
 */
function gateOneClientImport(): { release: () => void } {
	const gate = gatedPromise<void>();
	vi.doMock("../../clients/ruff-client.js", async (importOriginal) => {
		await gate.promise;
		return await importOriginal<
			typeof import("../../clients/ruff-client.js")
		>();
	});
	return { release: () => gate.resolve(undefined) };
}

/**
 * Make the FIRST build reject the way the module's own doc comment says it
 * can: one client fails to construct, and the failure logger that then runs
 * throws. Later builds log normally and succeed, so a retry is observable.
 */
function faultFirstBuild(): void {
	vi.doMock("../../clients/rust-client.js", () => ({
		RustClient: class {
			constructor() {
				throw new Error("rust-client unresolved");
			}
		},
	}));
	let poisoned = true;
	vi.doMock("../../clients/extension-log.js", async (importOriginal) => {
		const actual =
			await importOriginal<typeof import("../../clients/extension-log.js")>();
		return {
			...actual,
			logExtension: (entry: { subsystem?: string }) => {
				if (entry?.subsystem === "bootstrap" && poisoned) {
					poisoned = false;
					throw new Error("extension log sink down");
				}
			},
		};
	});
}

/**
 * Make the first `limit` builds reject, and every build after that succeed.
 *
 * Same seam as {@link faultFirstBuild} — one client fails to construct and the
 * failure logger that then runs throws — but counted, so a test can watch the
 * strike latch close and then watch a repaired environment reload.
 */
function faultBuildsUntil(limit: number): void {
	vi.doMock("../../clients/rust-client.js", () => ({
		RustClient: class {
			constructor() {
				throw new Error("rust-client unresolved");
			}
		},
	}));
	let builds = 0;
	vi.doMock("../../clients/extension-log.js", async (importOriginal) => {
		const actual =
			await importOriginal<typeof import("../../clients/extension-log.js")>();
		return {
			...actual,
			logExtension: (entry: { subsystem?: string }) => {
				if (entry?.subsystem !== "bootstrap") return;
				builds += 1;
				if (builds <= limit) throw new Error("extension log sink down");
			},
		};
	});
}

beforeEach(() => {
	vi.resetModules();
	vi.doUnmock("../../clients/ruff-client.js");
	vi.doUnmock("../../clients/rust-client.js");
	vi.doUnmock("../../clients/extension-log.js");
	vi.doUnmock("../../clients/latency-logger.js");
	latencyEntries.length = 0;
});

describe("#2467 — one shared, retryable analyzer-bootstrap load", () => {
	it("peek never starts a load, and reports the clients once one completes", async () => {
		const { bootstrap } = await freshSeam();
		expect(bootstrap.peekBootstrapClients()).toBeNull();
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(0);

		const clients = await bootstrap.loadBootstrapClients();
		expect(bootstrap.peekBootstrapClients()).toBe(clients);
	}, 30_000);

	it("concurrent demands share ONE build and get the same clients", async () => {
		const { bootstrap } = await freshSeam();
		const gate = gateOneClientImport();

		const first = bootstrap.loadBootstrapClients();
		const second = bootstrap.loadBootstrapClients();
		// Both callers are parked on the same flight before it can settle, which
		// is the window sharing has to cover; a memo-only design would start a
		// second build here (#1690).
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(1);

		gate.release();
		const [a, b] = await Promise.all([first, second]);
		expect(a).toBe(b);
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(1);

		// A demand after the flight settled reads the memo rather than rebuilding.
		expect(await bootstrap.loadBootstrapClients()).toBe(a);
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(1);
	}, 30_000);

	it("a rejected load does not latch — the next demand retries and succeeds", async () => {
		faultFirstBuild();
		const { bootstrap } = await freshSeam();

		await expect(bootstrap.loadBootstrapClients()).rejects.toThrow(
			"extension log sink down",
		);
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(1);
		// The rejection left no resident clients, which is what makes the retry
		// reachable at all.
		expect(bootstrap.peekBootstrapClients()).toBeNull();

		const clients = await bootstrap.loadBootstrapClients();
		expect(clients.biomeClient).toBeDefined();
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(2);
	}, 30_000);

	it("stamps the load record with the attempt, so a retry is distinguishable", async () => {
		faultFirstBuild();
		const { bootstrap } = await freshSeam();

		await expect(bootstrap.loadBootstrapClients()).rejects.toThrow();
		await bootstrap.loadBootstrapClients();

		const loads = latencyEntries.filter(
			(entry) => entry.phase === "bootstrap_clients_load",
		);
		// Only the SUCCESSFUL build writes the phase record; its attempt number
		// says it was the second try. That is the discrimination #2467's
		// observability section asks for without a per-demand record.
		expect(loads).toHaveLength(1);
		expect((loads[0]?.metadata as { attempt?: number })?.attempt).toBe(2);
	}, 30_000);
});

describe("#2467 — a failed demand fails OPEN for that caller", () => {
	it("answers null and counts one bounded degradation naming the demand", async () => {
		faultFirstBuild();
		const { bootstrap, ledger } = await freshSeam();

		const answer = await bootstrap.requestBootstrapClients({
			reason: "session-start-scans",
			hook: "session_start",
		});
		expect(answer).toBeNull();

		const group = ledger
			.getDegradationSummary()
			.find((entry) => entry.kind === "analyzer-bootstrap-unavailable");
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe("session-start-scans");
		expect(group?.latestReasons[0]?.reason).toContain("failed");
	}, 30_000);

	it("keeps one entry per demand while counting every occurrence", async () => {
		vi.doMock("../../clients/rust-client.js", () => ({
			RustClient: class {
				constructor() {
					throw new Error("rust-client unresolved");
				}
			},
		}));
		vi.doMock("../../clients/extension-log.js", async (importOriginal) => ({
			...(await importOriginal<
				typeof import("../../clients/extension-log.js")
			>()),
			logExtension: (entry: { subsystem?: string }) => {
				if (entry?.subsystem === "bootstrap")
					throw new Error("extension log sink down");
			},
		}));
		const { bootstrap, ledger } = await freshSeam();

		for (let i = 0; i < 3; i++) {
			expect(
				await bootstrap.requestBootstrapClients({
					reason: "tool-call",
					hook: "tool_call",
				}),
			).toBeNull();
		}
		const group = ledger
			.getDegradationSummary()
			.find((entry) => entry.kind === "analyzer-bootstrap-unavailable");
		expect(group?.count).toBe(3);
		expect(group?.latestReasons).toHaveLength(1);
	}, 30_000);
});

describe("#2467 — both bounds on the wait, neither on the load", () => {
	it("abandons the wait at the wall-clock ceiling without restarting the load", async () => {
		const { bootstrap, ledger } = await freshSeam();
		const gate = gateOneClientImport();

		const answer = await bootstrap.requestBootstrapClients({
			reason: "tool-call-complexity-baseline",
			hook: "tool_call",
			timeoutMs: 5,
		});
		expect(answer).toBeNull();
		const group = ledger
			.getDegradationSummary()
			.find((entry) => entry.kind === "analyzer-bootstrap-unavailable");
		expect(group?.latestReasons[0]?.reason).toContain("timeout");

		// The LOAD was never cancelled — the caller only stopped waiting on it.
		// A later demand joins the same flight instead of paying a second build.
		gate.release();
		const clients = await bootstrap.loadBootstrapClients();
		expect(clients.biomeClient).toBeDefined();
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(1);
	}, 30_000);

	it("abandons the wait when the caller aborts", async () => {
		const { bootstrap, ledger } = await freshSeam();
		const gate = gateOneClientImport();
		const controller = new AbortController();

		const pending = bootstrap.requestBootstrapClients({
			reason: "session-start-tool-probes",
			hook: "session_start",
			signal: controller.signal,
			// Far past anything this test waits for: the ABORT must be what ends
			// the wait, so a timeout that could also fire would make the case
			// pass for the wrong reason.
			timeoutMs: 60_000,
		});
		controller.abort();
		expect(await pending).toBeNull();

		// The CALLER'S OWN signal fired — a deliberate cancel, not the seam
		// degrading (#2467 review, F5). Writing it to the ledger inverted the
		// two: a user pressing Escape would surface as an unhealthy analyzer
		// graph in `pilens_health`. Nothing is recorded for it.
		const group = ledger
			.getDegradationSummary()
			.find((entry) => entry.kind === "analyzer-bootstrap-unavailable");
		expect(group).toBeUndefined();

		gate.release();
		await bootstrap.loadBootstrapClients();
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(1);
	}, 30_000);
});

describe("#2467 — the primary-shutdown gate", () => {
	it("refuses a NEW load after shutdown and fails open for the caller", async () => {
		const { bootstrap, ledger } = await freshSeam();
		bootstrap.markAnalyzerBootstrapShutdown();

		await expect(bootstrap.loadBootstrapClients()).rejects.toThrow(
			/shutting down/,
		);
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(0);
		expect(
			await bootstrap.requestBootstrapClients({
				reason: "post-shutdown",
				hook: "session_shutdown",
			}),
		).toBeNull();
		const group = ledger
			.getDegradationSummary()
			.find((entry) => entry.kind === "analyzer-bootstrap-unavailable");
		expect(group?.latestReasons[0]?.reason).toContain("shutdown");
	}, 30_000);

	it("never invalidates a waiter that was already in flight", async () => {
		const { bootstrap } = await freshSeam();
		const gate = gateOneClientImport();

		const waiter = bootstrap.loadBootstrapClients();
		// Shutdown lands with the load mid-flight — the #2467 interleaving. The
		// waiter must still get REAL clients; only a demand arriving after the
		// flight is gone may be refused.
		bootstrap.markAnalyzerBootstrapShutdown();
		gate.release();

		const clients = await waiter;
		expect(clients.biomeClient).toBeDefined();
		expect(bootstrap.peekBootstrapClients()).toBe(clients);

		// The gate is still closed for anything that would start a fresh build:
		// drop the resident memo (what a rebuilt process would look like) and
		// the next demand is refused.
		await expect(
			(async () => {
				bootstrap._resetAnalyzerBootstrapForTests();
				bootstrap.markAnalyzerBootstrapShutdown();
				return bootstrap.loadBootstrapClients();
			})(),
		).rejects.toThrow(/shutting down/);
	}, 30_000);

	it("unparks a bounded waiter at shutdown instead of burning the full ceiling", async () => {
		const { bootstrap, ledger } = await freshSeam();
		const gate = gateOneClientImport();

		const pending = bootstrap.requestBootstrapClients({
			reason: "session-start-scans",
			hook: "session_start",
			timeoutMs: 60_000,
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(1);

		bootstrap.markAnalyzerBootstrapShutdown();
		expect(await pending).toBeNull();
		const group = ledger
			.getDegradationSummary()
			.find((entry) => entry.kind === "analyzer-bootstrap-unavailable");
		expect(group?.latestReasons[0]?.reason).toContain("shutdown");

		gate.release();
		const clients = await bootstrap.loadBootstrapClients();
		expect(clients.biomeClient).toBeDefined();
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(1);
	}, 30_000);

	it("a bounded demand joins a live flight and gets clients when no shutdown fired", async () => {
		const { bootstrap } = await freshSeam();
		const gate = gateOneClientImport();

		const opener = bootstrap.loadBootstrapClients();
		const joiner = bootstrap.requestBootstrapClients({
			reason: "tool-call-complexity-baseline",
			hook: "tool_call",
			timeoutMs: 60_000,
		});

		gate.release();
		const [a, b] = await Promise.all([opener, joiner]);
		expect(b).toBe(a);
		expect(b?.biomeClient).toBeDefined();
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(1);
	}, 30_000);

	it("admits a NEW demand that arrives while a flight is still live", async () => {
		const { bootstrap } = await freshSeam();
		const gate = gateOneClientImport();

		// Caller A opens the flight; shutdown lands with it still in the air.
		const opener = bootstrap.loadBootstrapClients();
		bootstrap.markAnalyzerBootstrapShutdown();

		// Caller B is an entirely NEW demand, made after the gate closed — it
		// holds no pre-shutdown promise of its own, which is what separates
		// this from the waiter case above. The gate refuses only a load it
		// would have to START, so B joins the running flight. Drop the
		// `!bootstrapFlight.has(KEY)` half of the guard and this call rejects
		// with "shutting down" instead.
		const joiner = bootstrap.loadBootstrapClients();

		gate.release();
		const [a, b] = await Promise.all([opener, joiner]);
		expect(b).toBe(a);
		expect(b.biomeClient).toBeDefined();
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(1);
	}, 30_000);

	it("session_start re-arms the gate so a replacement session can load", async () => {
		const { bootstrap } = await freshSeam();
		bootstrap.markAnalyzerBootstrapShutdown();
		await expect(bootstrap.loadBootstrapClients()).rejects.toThrow(
			/shutting down/,
		);

		bootstrap.resetAnalyzerBootstrapSessionState();
		const clients = await bootstrap.loadBootstrapClients();
		expect(clients.biomeClient).toBeDefined();
	}, 30_000);
});

describe("#2467 — a load that cannot succeed latches after N strikes", () => {
	it("stops rebuilding after three failures and fails open immediately", async () => {
		faultBuildsUntil(Number.POSITIVE_INFINITY);
		const { bootstrap, ledger } = await freshSeam();

		for (let i = 0; i < 8; i++) {
			expect(
				await bootstrap.requestBootstrapClients({
					reason: "tool-call-complexity-baseline",
					hook: "tool_call",
				}),
			).toBeNull();
		}
		// Three BUILDS, not eight. Retry-after-failure is right for a TRANSIENT
		// fault; a permanently unresolvable analyzer module made every single
		// tool call re-run seventeen dynamic imports and
		// `collectInstallDiagnostics` for an answer that could not change.
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(3);

		const latched = ledger
			.getDegradationSummary()
			.find((entry) => entry.kind === "analyzer-bootstrap-latched");
		expect(latched?.count).toBe(1);
		expect(latched?.latestReasons).toHaveLength(1);
	}, 60_000);

	it("session_start re-arms the latch so a repaired environment reloads", async () => {
		faultBuildsUntil(3);
		const { bootstrap } = await freshSeam();

		for (let i = 0; i < 5; i++) {
			expect(
				await bootstrap.requestBootstrapClients({
					reason: "session-start-scans",
					hook: "session_start",
				}),
			).toBeNull();
		}
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(3);

		// The latch is a per-SESSION claim held in process-lived storage
		// (defect shape 17): without this reset a replacement session in a
		// repaired environment would find the analyzers refused for the rest
		// of the process.
		bootstrap.resetAnalyzerBootstrapSessionState();
		const clients = await bootstrap.requestBootstrapClients({
			reason: "session-start-scans",
			hook: "session_start",
		});
		expect(clients?.biomeClient).toBeDefined();
		expect(bootstrap._analyzerBootstrapLoadAttempts()).toBe(4);
	}, 60_000);
});
