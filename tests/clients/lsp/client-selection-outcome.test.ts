// #1934: `lsp_client_selected` fired 5601 times in a 20.8h dogfood window
// carrying only `{serverId, candidateCount}`, so no log said whether the pool
// reused a warm client or paid for a spawn. These tests pin the outcome
// discriminator on that record and the bounded warm-miss record its warm-only
// sibling `getWarmClientForFile` now emits.
//
// MUTATION PROOFS, stated so a later reader can re-run them:
//   - delete `outcome` from either `lsp_client_selected` metadata block and
//     the three "reachable" tests red;
//   - make `spawnAttemptErrored` return `true` unconditionally and the clean
//     -decline test reds (a breaker-cooldown skip would report an error);
//   - make it return `false` unconditionally and the spawn-failure test reds;
//   - delete the `missed.length > 0` guard and the "no server" test reds;
//   - drop `risingEdgePer` on the warm-miss emit and the dedupe test reds.
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

/** Every `lsp_client_selected` record's outcome, in emission order. */
function selectionOutcomes(): unknown[] {
	return logLatency.mock.calls
		.filter(([entry]) => entry?.phase === "lsp_client_selected")
		.map(([entry]) => entry.metadata?.outcome);
}

function warmMissRecords(): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.filter(([entry]) => entry?.phase === "lsp_warm_client_missing")
		.map(([entry]) => entry);
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

describe("lsp_client_selected outcome discriminator (#1934)", () => {
	let spawnBehavior: () => Promise<unknown>;
	const alive = { value: true };
	let resetDegradationLedger: () => void;

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-21T06:00:00Z"));
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
		({ resetDegradationLedger } =
			await import("../../../clients/degradation-ledger.js"));
		resetDegradationLedger();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("names a cold spawn, then a warm reuse, on the same record", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			// First acquisition has an empty pool: it costs a process.
			expect(await service.getClientForFile("/repo/a.ts")).toBeTruthy();
			expect(selectionOutcomes()).toEqual(["cold-spawn"]);

			// Second acquisition on the same server/root is served from the pool.
			expect(await service.getClientForFile("/repo/b.ts")).toBeTruthy();
			expect(selectionOutcomes()).toEqual(["cold-spawn", "warm-reuse"]);

			// The pair shares one denominator, which is the point of #1934: the
			// reuse rate is computable from this record alone.
			expect(
				logLatency.mock.calls.filter(
					([entry]) => entry?.phase === "lsp_client_selected",
				).length,
			).toBe(2);
		} finally {
			await service.shutdown({ processExiting: true });
		}
	});

	it("keeps serverId and candidateCount on the record it rides on", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			await service.getClientForFile("/repo/a.ts");
			const record = logLatency.mock.calls.find(
				([entry]) => entry?.phase === "lsp_client_selected",
			)?.[0];
			expect(record.metadata).toMatchObject({
				serverId: "typescript",
				candidateCount: 1,
				outcome: "cold-spawn",
			});
		} finally {
			await service.shutdown({ processExiting: true });
		}
	});

	it("names a spawn failure, and does not repeat it for the clean cooldown skip", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			spawnBehavior = async () => {
				throw new Error("spawn refused");
			};
			// The spawn ran and errored: an ERRORED selection, not a clean miss.
			expect(await service.getClientForFile("/repo/a.ts")).toBeUndefined();
			expect(selectionOutcomes()).toEqual(["spawn-failure"]);

			// The same failure cooled the (server, root) key down. The next touch
			// inside that cooldown never reaches a spawn, so it is a CLEAN
			// decline and must NOT be reported as another spawn failure. This is
			// both the availability invariant and the bound on the record.
			expect(await service.getClientForFile("/repo/b.ts")).toBeUndefined();
			expect(selectionOutcomes()).toEqual(["spawn-failure"]);
		} finally {
			await service.shutdown({ processExiting: true });
		}
	});

	it("names a spawn failure when the binary is absent and installs are allowed", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			// `spawn` RESOLVES undefined rather than throwing: the second of the
			// two genuine failure branches, on the exponential breaker ladder.
			spawnBehavior = async () => undefined;
			expect(await service.getClientForFile("/repo/a.ts")).toBeUndefined();
			expect(selectionOutcomes()).toEqual(["spawn-failure"]);
		} finally {
			await service.shutdown({ processExiting: true });
		}
	});

	// #1934 verify round: a decline write must SHADOW the previous attempt's
	// verdict. Only a successful spawn deletes the map entry, so a key that
	// failed once carries "failed" until something overwrites it. If a later
	// clientless exit forgets to write, that stale "failed" is what the
	// selection reads, and a policy decline inherits the earlier failure's
	// label. This drives failure, then cooldown expiry, then trust refusal on
	// the same key. The shutdown-mid-spawn and shutdown-mid-initialize
	// declines in `spawnClient` are the same mechanism on the same map; they
	// are not separately driven here because reaching them needs a shutdown
	// raced against an in-flight spawn, which buys no coverage this test does
	// not already give.
	it("shadows a stale failed verdict when the next attempt declines", async () => {
		const trust = await import("../../../clients/project-trust.js");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			spawnBehavior = async () => {
				throw new Error("spawn refused");
			};
			expect(await service.getClientForFile("/repo/a.ts")).toBeUndefined();
			expect(selectionOutcomes()).toEqual(["spawn-failure"]);

			// Past the 15s breaker cooldown, so the next touch reaches a spawn
			// rather than taking the `lsp_client_skipped_broken` early return.
			vi.setSystemTime(new Date("2026-08-21T06:01:00Z"));
			// The host now refuses the binary. That exit sets no cooldown and is
			// a policy decline, so the selection must stay silent.
			trust.setProjectTrustState("untrusted");
			expect(await service.getClientForFile("/repo/b.ts")).toBeUndefined();
			expect(selectionOutcomes()).toEqual(["spawn-failure"]);
		} finally {
			trust.resetProjectTrust();
			await service.shutdown({ processExiting: true });
		}
	});

	// #1934 review F1. The "binary unavailable while installs are disabled"
	// branch sets a 15s cooldown, yet it is a POLICY decline by its own
	// comment: no ladder, no permanent latch, because the binary may appear on
	// PATH later in the same session. Inferring the outcome from breaker state
	// therefore mislabeled it as a spawn failure, once per 15s per
	// (server, root) for the whole session — roughly 5000 mislabeled records a
	// day with PI_LENS_DISABLE_LSP_INSTALL=1 or an untrusted project.
	it("reports a decline, not a failure, when the binary is absent with installs disabled", async () => {
		const previous = process.env.PI_LENS_DISABLE_LSP_INSTALL;
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			spawnBehavior = async () => undefined;
			expect(await service.getClientForFile("/repo/a.ts")).toBeUndefined();
			expect(selectionOutcomes()).toEqual([]);

			// The bound must hold in THIS configuration, not just the default
			// one. Walk past the flat cooldown three times: the spawn is retried
			// each time and declines each time, and the record stays silent.
			for (const [index, file] of ["b", "c", "d"].entries()) {
				vi.setSystemTime(
					new Date(Date.UTC(2026, 7, 21, 6, 0, 0) + (index + 1) * 60_000),
				);
				expect(
					await service.getClientForFile(`/repo/${file}.ts`),
				).toBeUndefined();
			}
			expect(selectionOutcomes()).toEqual([]);
		} finally {
			await service.shutdown({ processExiting: true });
			if (previous === undefined) {
				delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
			} else {
				process.env.PI_LENS_DISABLE_LSP_INSTALL = previous;
			}
		}
	});

	it("reports no outcome record when no server matches the file", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			getServersForFileWithConfig.mockReturnValue([]);
			expect(await service.getClientForFile("/repo/a.txt")).toBeUndefined();
			expect(selectionOutcomes()).toEqual([]);
		} finally {
			await service.shutdown({ processExiting: true });
		}
	});

	it("reports a clean decline, not a failure, when the root does not resolve", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			getServersForFileWithConfig.mockReturnValue([
				{
					id: "typescript",
					name: "TypeScript",
					extensions: [".ts"],
					idleEviction: "resident",
					root: async () => undefined,
					spawn: vi.fn(() => spawnBehavior()),
				},
			]);
			expect(await service.getClientForFile("/elsewhere/a.ts")).toBeUndefined();
			// No spawn was attempted, so nothing errored and nothing is claimed.
			expect(selectionOutcomes()).toEqual([]);
		} finally {
			await service.shutdown({ processExiting: true });
		}
	});
});

describe("getWarmClientForFile warm-miss record (#1934)", () => {
	const alive = { value: true };
	let resetDegradationLedger: () => void;
	let getDegradationSummary: () => Array<{
		kind: string;
		count: number;
		latestReasons: Array<{ subject: string; reason: string }>;
	}>;

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-21T06:00:00Z"));
		logLatency.mockClear();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		alive.value = true;
		getServersForFileWithConfig.mockReturnValue([
			{
				id: "typescript",
				name: "TypeScript",
				extensions: [".ts"],
				idleEviction: "resident",
				root: async () => "/repo",
				spawn: vi.fn(async () => liveSpawn),
			},
		]);
		createLSPClient.mockImplementation(() => fakeClient(alive));
		const ledger = await import("../../../clients/degradation-ledger.js");
		resetDegradationLedger = ledger.resetDegradationLedger;
		getDegradationSummary =
			ledger.getDegradationSummary as unknown as typeof getDegradationSummary;
		resetDegradationLedger();
		const bounded = await import("../../../clients/bounded-telemetry.js");
		bounded.resetBoundedTelemetry();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("names the server and root on a cold pool, once, and counts the rest", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			expect(await service.getWarmClientForFile("/repo/a.ts")).toBeUndefined();
			const records = warmMissRecords();
			expect(records).toHaveLength(1);
			// The root is normalized for map keying, which on Windows prefixes a
			// drive letter. Assert the shape, not the host's absolute form.
			expect(records[0].filePath).toBe("/repo/a.ts");
			const metadata = records[0].metadata as {
				serverIds: string[];
				roots: string[];
				identity: string;
			};
			expect(metadata.serverIds).toEqual(["typescript"]);
			expect(metadata.roots).toHaveLength(1);
			expect(metadata.roots[0].endsWith("/repo")).toBe(true);
			expect(metadata.identity).toBe(`typescript:${metadata.roots[0]}`);

			// Rising edge per candidate set: the per-file callers (cascade quiet
			// window, read expansion) must not turn a cold pool into a log storm.
			expect(await service.getWarmClientForFile("/repo/b.ts")).toBeUndefined();
			expect(await service.getWarmClientForFile("/repo/c.ts")).toBeUndefined();
			expect(warmMissRecords()).toHaveLength(1);

			// The ledger still holds the EXACT count, which is the pool-miss
			// signal a suppressed detailed record would otherwise erase.
			const group = getDegradationSummary().find(
				(entry) => entry.kind === "lsp-warm-client-missing",
			);
			expect(group?.count).toBe(3);
			expect(group?.latestReasons.map((entry) => entry.subject)).toEqual([
				metadata.identity,
			]);
		} finally {
			await service.shutdown({ processExiting: true });
		}
	});

	it("stays silent when the file has no server with a resolvable root", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			getServersForFileWithConfig.mockReturnValue([]);
			expect(await service.getWarmClientForFile("/repo/a.txt")).toBeUndefined();

			getServersForFileWithConfig.mockReturnValue([
				{
					id: "typescript",
					name: "TypeScript",
					extensions: [".ts"],
					idleEviction: "resident",
					root: async () => undefined,
					spawn: vi.fn(async () => liveSpawn),
				},
			]);
			expect(
				await service.getWarmClientForFile("/elsewhere/a.ts"),
			).toBeUndefined();

			// Neither case is a pool miss: there was never a slot to miss.
			expect(warmMissRecords()).toEqual([]);
		} finally {
			await service.shutdown({ processExiting: true });
		}
	});

	it("stays silent when a warm client serves the file", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		try {
			expect(await service.getClientForFile("/repo/a.ts")).toBeTruthy();
			logLatency.mockClear();
			expect(await service.getWarmClientForFile("/repo/a.ts")).toBeTruthy();
			expect(warmMissRecords()).toEqual([]);
		} finally {
			await service.shutdown({ processExiting: true });
		}
	});
});
