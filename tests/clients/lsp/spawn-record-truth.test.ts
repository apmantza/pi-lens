// #2064: the LSP records could not count spawns.
//
// `lsp_client_selected` reported `cold-spawn` after `await spawnPromise`, so
// every caller that merely JOINED another caller's in-flight spawn reported it
// too. A 21.8h field window held 62 `cold-spawn` records that clustered into 21
// real spawn events — a 3.0x over-count — and one cluster held 39 records
// inside 2ms against a measured 29.3s TypeScript spawn. Separately, no latency
// record proved a TypeScript language-server process ever started:
// `lsp_launch_candidate_success` covers only servers that launch through
// `resolveAndLaunch`, and fired 0 times for `typescript` in that window.
//
// These tests pin both halves.
//
// MUTATION PROOFS, stated so a later reader can re-run them:
//   - make `startedSpawn` unconditionally `true` in `ensureClientForServer` and
//     the concurrency, burst-replay, and failure-join tests red;
//   - make it unconditionally `false` and the same three red;
//   - delete the `lsp_server_spawned` emit in `spawnClient` and three tests
//     red, including the `getClientsForFile` one;
//   - move the `startedSpawn` capture to AFTER `await spawnPromise` (which is
//     the pre-fix shape) and the burst replay reports 39 spawns again;
//   - make `spawnClient` rethrow from its own catch and the "splits the
//     starter from the joiners when the spawn fails" test reds (the error
//     escapes the acquisition); the claim-pin test uses a throwing trust
//     probe, which fires before `spawnClient`'s try, so that mutation does
//     not touch it. A rethrow deletes records rather than re-opening the
//     over-count.
//
// NOT claimed as mutation-proven: the catch around `await spawnPromise` keeps
// a single `spawn-failure` value on purpose. See the comment at that catch and
// the last test in this file for the reachability analysis.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<
		typeof import("../../../clients/latency-logger.js")
	>()),
	logLatency,
}));

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({ createLSPClient }));

/**
 * Drives the one route into `ensureClientForServer`'s catch: a throw from
 * `spawnClient` BEFORE its own `try`. Defaults to off, so every other test in
 * this file runs against the real trust module's behavior.
 */
const trustProbeThrows = { value: false };
vi.mock("../../../clients/project-trust.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../clients/project-trust.js")>();
	return {
		...actual,
		isLspSpawnAllowedByTrust: () => {
			if (trustProbeThrows.value) throw new Error("trust probe threw");
			return actual.isLspSpawnAllowedByTrust();
		},
	};
});

function fakeClient(alive: { value: boolean }) {
	return {
		root: "/repo",
		isAlive: vi.fn(() => alive.value),
		isBusy: vi.fn(() => false),
		shutdown: vi.fn(async () => undefined),
		wasShutdownIntentional: vi.fn(() => false),
		getExitedAt: vi.fn(() => undefined),
		notify: {
			open: vi.fn(async () => undefined),
			change: vi.fn(async () => undefined),
		},
		diagnosticsVersion: 0,
		getWorkspaceDiagnosticsSupport: vi.fn(() => ({
			advertised: false,
			mode: "push-only",
			diagnosticProviderKind: "unavailable",
		})),
	};
}

const liveSpawn = {
	process: {
		process: { killed: false },
		stdin: {},
		stdout: {},
		stderr: {},
		pid: 4242,
	},
};

/** Every `lsp_client_selected` record's outcome, in emission order. */
function selectionOutcomes(): unknown[] {
	return logLatency.mock.calls
		.filter(([entry]) => entry?.phase === "lsp_client_selected")
		.map(([entry]) => entry.metadata?.outcome);
}

function countOutcome(outcome: string): number {
	return selectionOutcomes().filter((value) => value === outcome).length;
}

function spawnRecords(): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.filter(([entry]) => entry?.phase === "lsp_server_spawned")
		.map(([entry]) => entry);
}

/**
 * Drain enough macrotask turns that every concurrent caller has reached its
 * `await spawnPromise`. Real timers on purpose: a fake-timer drain would not
 * flush the microtask chain the acquisition path walks through.
 */
async function settleConcurrentCallers(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe("LSP spawn records count truthfully (#2064)", () => {
	let spawnBehavior: () => Promise<unknown>;
	const alive = { value: true };

	beforeEach(async () => {
		vi.resetModules();
		logLatency.mockClear();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		alive.value = true;
		spawnBehavior = async () => liveSpawn;
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: async () => "/repo",
				spawn: vi.fn(() => spawnBehavior()),
			},
		]);
		createLSPClient.mockImplementation(() => fakeClient(alive));
		const ledger = await import("../../../clients/degradation-ledger.js");
		ledger.resetDegradationLedger();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("marks exactly one starter and N-1 joiners for one slow spawn", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			spawnBehavior = async () => {
				await held;
				return liveSpawn;
			};
			const callers = 5;
			const pending = Array.from({ length: callers }, (_, index) =>
				service.getClientForFile(`/repo/f${index}.ts`),
			);
			// Every caller is now parked behind the SAME in-flight spawn.
			await settleConcurrentCallers();
			release?.();
			const served = await Promise.all(pending);
			expect(served.every(Boolean)).toBe(true);

			// The point of the issue: one process started, four callers joined it.
			expect(countOutcome("cold-spawn")).toBe(1);
			expect(countOutcome("cold-spawn-joined")).toBe(callers - 1);
			// One record per selection, so the reuse-rate denominator is unchanged.
			expect(selectionOutcomes()).toHaveLength(callers);
		} finally {
			release?.();
			await service.shutdown({ processExiting: true });
		}
	});

	// The 2026-08-25T07:18:48.303Z field cluster: 39 records in 2ms against a
	// measured 29.3s spawn. Pre-fix that reads as 39 spawns, which is not
	// physically possible.
	it("replays the 39-record burst as 1 spawn and 38 joins", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			spawnBehavior = async () => {
				await held;
				return liveSpawn;
			};
			const pending = Array.from({ length: 39 }, (_, index) =>
				service.getClientForFile(`/repo/burst${index}.ts`),
			);
			await settleConcurrentCallers();
			release?.();
			await Promise.all(pending);

			expect(countOutcome("cold-spawn")).toBe(1);
			expect(countOutcome("cold-spawn-joined")).toBe(38);

			// One process start, and on THIS path the spawn record and the
			// starter outcome agree. They do not agree in general — see the
			// `getClientsForFile` test below, which is why the recipe is an
			// inequality.
			expect(spawnRecords()).toHaveLength(1);

			// Nothing else reached the record, so the denominator is unchanged
			// and no third value slipped in.
			expect(new Set(selectionOutcomes())).toEqual(
				new Set(["cold-spawn", "cold-spawn-joined"]),
			);
			expect(selectionOutcomes()).toHaveLength(39);
		} finally {
			release?.();
			await service.shutdown({ processExiting: true });
		}
	});

	it("records a TypeScript process start in latency.log", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			expect(await service.getClientForFile("/repo/a.ts")).toBeTruthy();
			const records = spawnRecords();
			expect(records).toHaveLength(1);
			expect(records[0].metadata).toMatchObject({
				serverId: "typescript",
				triggerFilePath: "/repo/a.ts",
			});
			expect(typeof records[0].durationMs).toBe("number");

			// A warm reuse is not a process start, so the count must not move.
			expect(await service.getClientForFile("/repo/b.ts")).toBeTruthy();
			expect(selectionOutcomes()).toEqual(["cold-spawn", "warm-reuse"]);
			expect(spawnRecords()).toHaveLength(1);
		} finally {
			await service.shutdown({ processExiting: true });
		}
	});

	it("splits the starter from the joiners when the spawn fails", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			spawnBehavior = async () => {
				await held;
				throw new Error("spawn refused");
			};
			const callers = 5;
			const pending = Array.from({ length: callers }, (_, index) =>
				service.getClientForFile(`/repo/bad${index}.ts`),
			);
			await settleConcurrentCallers();
			release?.();
			const served = await Promise.all(pending);
			expect(served.every((entry) => entry === undefined)).toBe(true);

			// One failed process start, not five.
			expect(countOutcome("spawn-failure")).toBe(1);
			expect(countOutcome("spawn-failure-joined")).toBe(callers - 1);
			// A failed spawn started a process attempt but produced no server.
			expect(spawnRecords()).toEqual([]);
		} finally {
			release?.();
			await service.shutdown({ processExiting: true });
		}
	});

	// #2064 review F1. `getClientsForFile` and `getAuxiliaryClientsForFile`
	// call `ensureClientForServer` with no `onOutcome`, so a spawn on those
	// paths writes a process-start record and NO selection record. This test
	// exists because the first version of this PR documented the two counts as
	// equal, which is false in production and would have sent a log reader
	// hunting a phantom leak. The relation is
	// `count(lsp_server_spawned) >= count(outcome="cold-spawn")`, and
	// `lsp_server_spawned` is the authoritative spawn count.
	it("counts a getClientsForFile spawn with no selection record", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			const result = await service.getClientsForFile("/repo/a.ts");
			expect(result.clients).toHaveLength(1);

			// The process started, and only the spawn record says so.
			expect(spawnRecords()).toHaveLength(1);
			expect(selectionOutcomes()).toEqual([]);
		} finally {
			await service.shutdown({ processExiting: true });
		}
	});

	// #2064 review F2. The catch around `await spawnPromise` deliberately keeps
	// one `spawn-failure` value rather than splitting starter from joiner, and
	// this test pins the reachability analysis that justifies it. `spawnClient`
	// never rethrows, so the catch is reachable only when `spawnClient` throws
	// before its own `try` — here, a throwing trust probe. Two facts follow,
	// and both are asserted: the acquisition REJECTS rather than resolving, and
	// the rethrow unwinds past every `lsp_client_selected` emit site, so the
	// catch's outcome value reaches no record. A discriminator nothing can
	// observe is a vacuous guard.
	//
	// Honest framing: this is a claim pin, not a red-first regression test. It
	// passes before and after the fix. Its job is to fail if someone later
	// makes `spawnClient` rethrow, because that would make the catch reachable
	// with a live joiner and the single value would start over-counting again.
	it("emits no selection record when the acquisition throws", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			trustProbeThrows.value = true;
			const settled = await Promise.allSettled([
				service.getClientForFile("/repo/x1.ts"),
				service.getClientForFile("/repo/x2.ts"),
			]);
			expect(settled.map((entry) => entry.status)).toEqual([
				"rejected",
				"rejected",
			]);
			expect(selectionOutcomes()).toEqual([]);
			expect(spawnRecords()).toEqual([]);
		} finally {
			trustProbeThrows.value = false;
			await service.shutdown({ processExiting: true });
		}
	});
});
