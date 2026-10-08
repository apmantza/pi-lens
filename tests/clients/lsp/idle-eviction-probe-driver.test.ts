/**
 * #3645: the nightly probe's production driver, run over the REAL LSPService.
 *
 * Recurrence this file prevents: a measurement that evicts through a parallel
 * retire path (or that flips a policy after the timer was already scheduled)
 * measures something production never does, and its verdicts would steer
 * `idleEviction` declarations wrongly. The driver must make an `unmeasured`
 * server evictable through the service's OWN idle timer, and put the registry
 * object and the environment back exactly as it found them.
 *
 * Only the language-server boundary is faked (config lookup and the client
 * factory), as in idle-eviction.test.ts; the timer, policy gate, retirement,
 * lease and respawn paths are the production ones, on fake timers. The fake
 * `touchFile` wrapper is the one seam the unit lane cannot run for real: a
 * real diagnostics touch needs a real server, which only the nightly spawns.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createServiceDriver,
	probeServer,
	type ProbeFinding,
} from "../../../scripts/lib/lsp-idle-eviction-probe.mjs";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/config.js")>()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

function fakeClient(pid: number) {
	return {
		serverId: "goish",
		root: "/repo",
		isAlive: vi.fn(() => true),
		isBusy: vi.fn(() => false),
		shutdown: vi.fn(async (_options?: { reason?: string }) => undefined),
		getProcessPid: () => pid,
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

const finding = (line: number): ProbeFinding => ({
	serverId: "goish",
	source: "goish",
	severity: 1,
	message: `problem ${line}`,
	range: { start: { line, character: 0 }, end: { line, character: 1 } },
});

function registryServer(role?: "auxiliary", root = "/repo") {
	return {
		id: "goish",
		name: "goish",
		extensions: [".go"],
		idleEviction: "unmeasured" as string,
		...(role ? { role } : {}),
		root: async () => root,
		spawn: vi.fn(async () => ({
			process: {
				process: { killed: false },
				stdin: {},
				stdout: {},
				stderr: {},
				pid: 7,
			},
		})),
	};
}

function ephemeralCheckout(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-idle-probe-"));
	fs.mkdirSync(path.join(root, ".git"));
	fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	return root;
}

async function harness(
	server: ReturnType<typeof registryServer>,
	postEvictionFindings: (spawnCount: number) => ProbeFinding[],
) {
	getServersForFileWithConfig.mockReturnValue([server]);
	const { LSPService } = await import("../../../clients/lsp/index.js");
	// Same module registry as the service, so these are the ledger it writes to.
	const { recordDegradation } =
		await import("../../../clients/degradation-ledger.js");
	const service = new LSPService();
	const isAux = server.role === "auxiliary";
	const entryFor = async (file: string) =>
		isAux
			? (
					await service.getAuxiliaryClientsForFile(file, new Set([server.id]))
				)[0]
			: await service.getClientForFile(file);
	const lsp = {
		getClientForFile: (file: string) => service.getClientForFile(file),
		getAuxiliaryClientsForFile: (file: string, ids: ReadonlySet<string>) =>
			service.getAuxiliaryClientsForFile(file, ids),
		getAliveServerIds: () => service.getAliveServerIds(),
		touchFile: async (file: string) => {
			const entry = await entryFor(file);
			if (!entry) return undefined;
			const spawns = createLSPClient.mock.calls.length;
			return {
				diags:
					spawns <= 1 ? [finding(1), finding(2)] : postEvictionFindings(spawns),
			};
		},
	};
	const measured: number[] = [];
	const driver = createServiceDriver({
		lsp,
		server,
		target: { absFile: "/repo/main.go", content: "package main" },
		windowMs: 20,
		touchBudgets: { maxClientWaitMs: 1_000, maxDiagnosticsWaitMs: 1_000 },
		residentBytesOf: async (pid) => {
			measured.push(pid);
			return pid * 1_000_000;
		},
		prepare: async () => undefined,
		dispose: async () => undefined,
		now: () => Date.now(),
		sleep: async (ms) => {
			await vi.advanceTimersByTimeAsync(ms);
		},
	});
	return { service, driver, measured, recordDegradation };
}

const spawnedClients: Array<ReturnType<typeof fakeClient>> = [];

const budgets = {
	baselineAttempts: 2,
	baselineSettleMs: 10,
	evictionWaitMs: 1_000,
	recordWaitMs: 1_000,
	pollMs: 10,
	coldStartWaitMs: 1_000,
};

describe("idle-eviction probe driver over the real LSPService (#3645)", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		delete process.env.PI_LENS_LSP_IDLE_EVICT_MS;
		delete process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS;
		delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
		let pid = 100;
		spawnedClients.length = 0;
		createLSPClient.mockImplementation(async () => {
			const client = fakeClient(pid++);
			spawnedClients.push(client);
			return client;
		});
	});

	afterEach(() => {
		delete process.env.PI_LENS_LSP_IDLE_EVICT_MS;
		delete process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("evicts an unmeasured server through the service's own timer once armed, then keeps it resident once restored", async () => {
		const server = registryServer();
		const { service, driver } = await harness(server, () => [
			finding(1),
			finding(2),
		]);
		await driver.touch();
		expect(driver.isTargetAlive()).toBe(true);

		// Unarmed, an unmeasured server is never evicted, however long it idles.
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		expect(driver.isTargetAlive()).toBe(true);

		const restore = await driver.armEviction();
		expect(server.idleEviction).toBe("transparent");
		expect(process.env.PI_LENS_LSP_IDLE_EVICT_MS).toBe("20");
		expect(driver.isTargetAlive()).toBe(true);
		await vi.advanceTimersByTimeAsync(20);
		expect(driver.isTargetAlive()).toBe(false);

		restore();
		expect(server.idleEviction).toBe("unmeasured");
		expect(process.env.PI_LENS_LSP_IDLE_EVICT_MS).toBeUndefined();
		expect(process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS).toBeUndefined();

		await driver.touch();
		expect(driver.isTargetAlive()).toBe(true);
		expect(createLSPClient).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(25 * 60_000);
		expect(driver.isTargetAlive()).toBe(true);
		await service.shutdown();
	});

	it("restores a pre-existing generic window rather than deleting it", async () => {
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = "777";
		const { service, driver } = await harness(registryServer(), () => []);
		await driver.touch();
		const restore = await driver.armEviction();
		expect(process.env.PI_LENS_LSP_IDLE_EVICT_MS).toBe("20");
		restore();
		restore();
		expect(process.env.PI_LENS_LSP_IDLE_EVICT_MS).toBe("777");
		await service.shutdown();
	});

	it("arms the ephemeral window for a temporary git checkout", async () => {
		const root = ephemeralCheckout();
		try {
			process.env.PI_LENS_LSP_IDLE_EVICT_MS = "100000";
			process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS = "777";
			const server = registryServer(undefined, root);
			const { service, driver } = await harness(server, () => [finding(1)]);
			await driver.touch();

			const restore = await driver.armEviction();
			const { getLspIdleEvictMsForRoot } =
				await import("../../../clients/lsp/index.js");
			expect(process.env.PI_LENS_LSP_IDLE_EVICT_MS).toBe("20");
			expect(process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS).toBe("20");
			// Recurrence: c61fc49ba added a timer the probe did not arm (#3989).
			// Ask the real selector for both root classes so either arm cannot drift.
			expect(getLspIdleEvictMsForRoot(root)).toBe(20);
			expect(getLspIdleEvictMsForRoot("/repo")).toBe(20);
			await vi.advanceTimersByTimeAsync(20);
			expect(driver.isTargetAlive()).toBe(false);

			restore();
			expect(process.env.PI_LENS_LSP_IDLE_EVICT_MS).toBe("100000");
			expect(process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS).toBe("777");
			await service.shutdown();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads the server's resident bytes from the pid of its live client", async () => {
		const { service, driver, measured } = await harness(
			registryServer(),
			() => [],
		);
		await driver.touch();
		expect(await driver.rssBytes()).toBe(100_000_000);
		expect(measured).toEqual([100]);
		await service.shutdown();
	});

	it("reports a primary server eligible end to end through probeServer", async () => {
		const server = registryServer();
		const { service, driver } = await harness(server, () => [
			finding(1),
			finding(2),
		]);
		const row = await probeServer({
			server,
			fixture: { lang: "go", file: "main.go" },
			createDriver: () => driver,
			budgets,
		});
		expect(row).toMatchObject({
			serverId: "goish",
			declared: "unmeasured",
			result: "eligible",
			respawn: "ok",
			coverage: "preserved",
			rssBytes: 100_000_000,
		});
		expect(server.idleEviction).toBe("unmeasured");
		expect(process.env.PI_LENS_LSP_IDLE_EVICT_MS).toBeUndefined();
		await service.shutdown();
	});

	it("vetoes a server whose respawned client reports fewer findings", async () => {
		const server = registryServer();
		const { service, driver } = await harness(server, () => [finding(1)]);
		const row = await probeServer({
			server,
			fixture: { lang: "go", file: "main.go" },
			createDriver: () => driver,
			budgets,
		});
		expect(row).toMatchObject({
			result: "vetoed",
			reason: "findings-narrowed",
			coverage: "narrowed",
		});
		expect(server.idleEviction).toBe("unmeasured");
		await service.shutdown();
	});

	it("measures an auxiliary-role server through the auxiliary acquisition path", async () => {
		const server = registryServer("auxiliary");
		const { service, driver } = await harness(server, () => [
			finding(1),
			finding(2),
		]);
		const row = await probeServer({
			server,
			fixture: { lang: "go", file: "main.go", auxiliarySourceMatch: "goish" },
			createDriver: () => driver,
			budgets,
		});
		expect(row).toMatchObject({
			role: "auxiliary",
			result: "eligible",
			rssBytes: 100_000_000,
		});
		expect(server.idleEviction).toBe("unmeasured");
		await service.shutdown();
	});

	// Review round 1 F4: the probe used to read the degradation ledger's count to
	// tell a release from a crash. The ledger keeps at most 32 distinct kinds and
	// folds later ones into `other`, so with the ledger full every eviction read
	// `client-died` and every server nightly went `inconclusive`. The eviction is
	// now observed on the client's own shutdown, which nothing can crowd out.
	it("still recognises an eviction when the degradation ledger is saturated", async () => {
		const server = registryServer();
		const { service, driver, recordDegradation } = await harness(server, () => [
			finding(1),
			finding(2),
		]);
		for (let i = 0; i < 60; i++)
			recordDegradation({
				kind: `saturating-kind-${i}` as never,
				subject: "s",
				reason: "r",
			});
		const row = await probeServer({
			server,
			fixture: { lang: "go", file: "main.go" },
			createDriver: () => driver,
			budgets,
		});
		expect(row).toMatchObject({ result: "eligible", respawn: "ok" });
		await service.shutdown();
	});

	it("reports a client that dies while armed as client-died, not as evicted", async () => {
		const server = registryServer();
		const { service, driver } = await harness(server, () => [
			finding(1),
			finding(2),
		]);
		const arm = driver.armEviction.bind(driver);
		driver.armEviction = async () => {
			const restore = await arm();
			// A crash: the client is torn down for some other reason and stops being
			// alive; the idle timer's callback bails on a dead client. Only a
			// shutdown carrying reason "idle_eviction" is an eviction.
			const client = spawnedClients.at(-1);
			await client?.shutdown({ reason: "pipeline_crash" });
			client?.isAlive.mockReturnValue(false);
			return restore;
		};
		const row = await probeServer({
			server,
			fixture: { lang: "go", file: "main.go" },
			createDriver: () => driver,
			budgets,
		});
		expect(row).toMatchObject({
			result: "inconclusive",
			reason: "client-died",
			respawn: "not-evicted",
		});
		await service.shutdown();
	});
});
