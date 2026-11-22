/**
 * #3952 caller-side witness: the selective idle-eviction rollout read through
 * the REAL registry object and the REAL `LSPService`.
 *
 * Why this file exists (the #3645 recurrence it closes): the existing
 * `idle-eviction.test.ts` proves the policy gate with a hand-written server
 * literal (`idleEviction: "transparent"`), and `idle-eviction-probe-driver.test.ts`
 * arms the policy itself. Neither reads the declaration the runtime actually
 * ships, so a literal flip `transparent → unmeasured` (or the reverse) stayed
 * green. Here the only replaced pieces are the external boundaries — the
 * server's `spawn()` process launcher and the `createLSPClient` transport —
 * and `getServerById(id)` (the real registry object) is asserted identity-equal
 * to the entry the service used. `clients/lsp/config.js` and
 * `clients/lsp/server.js` are imported real; no core config, store, or registry
 * module is mocked.
 *
 * The measured protocol order is mirrored: acquire an idle client, read its
 * findings, let the shared idle timer release it, respawn on the next request,
 * and compare the finding keys. A declaration that is not `transparent` never
 * arms the timer, so this case is red pre-fix and green after the flip.
 *
 * #3952 root cause (2026-10-19): every case here ALSO compiles the real
 * session config for its fixture root (`initLSPConfig`), because that is the
 * seam the nightly measurement runs through: with a served root, the service
 * reads `config.registeredServers` rather than the catalog fallback. Before
 * `clients/lsp/config.ts` returned the catalog entry there, that list held a
 * shallow copy per built-in, so the nightly probe's `server.idleEviction =
 * "transparent"` arm on the catalog object never reached `scheduleIdleEviction`
 * and every candidate read `not-evicted` from 2026-10-10 onward. Without the
 * `initLSPConfig` call these cases read the catalog directly and stay green on
 * the broken code, which is how the rollout shipped unmeasured.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getServerById,
	LSP_SERVERS,
	type LSPServerInfo,
} from "../../../clients/lsp/server.js";
import {
	findingKey,
	selectFixtureForServer,
} from "../../../scripts/lib/lsp-idle-eviction-probe.mjs";
import { LSP_FIXTURES } from "../../../scripts/smoke-tools.mjs";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { pinFixtureHome } from "../test-utils.js";

const createLSPClient = vi.fn();

// Only the client transport is doubled; the config and registry modules stay real.
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

/** The ten ids this PR declares `transparent` for the first time. */
const ENABLED_IDS = [
	"bash",
	"clojure",
	"cpp",
	"css",
	"deno",
	"fish",
	"html",
	"php",
	"prisma",
	"yaml",
] as const;

/** The ids of one #3952 decision class, read from the registry test. */
function registryClass(name: string): string[] {
	const registryTest = readFileSync(
		path.join(
			path.dirname(fileURLToPath(import.meta.url)),
			"../../config/lsp-idle-eviction-registry.test.ts",
		),
		"utf8",
	);
	const body = new RegExp(`const ${name} = \\[([^\\]]*)\\] as const;`).exec(
		registryTest,
	)?.[1];
	const ids = [...(body ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	if (ids.length === 0)
		throw new Error(`${name} not found in the registry test`);
	return ids;
}

/**
 * A server declared `resident` (the opt-out witness, #5700). Taken from
 * #3952's HOLD_INDEXER class, which the nightly promotion (#3989) never
 * auto-promotes: a hard-coded `docker` here went red the moment the promotion
 * PR flipped it (#3994 r3).
 */
const RESIDENT_WITNESS_ID = registryClass("HOLD_INDEXER_IDS")[0];

/**
 * A server declared `unmeasured` (the default witness, #5700): the first
 * UNPROVEN id with an owned smoke fixture. The nightly promotes only an id it
 * measured eligible on two nights, which an unproven one is not.
 */
const UNMEASURED_WITNESS_ID = registryClass("UNPROVEN_IDS").find((id) => {
	const server = LSP_SERVERS.find((s) => s.id === id);
	return (
		server !== undefined &&
		selectFixtureForServer(server, LSP_FIXTURES) !== null
	);
});

const IDLE_WINDOW_MS = 20;

function fakeProcess(pid: number) {
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
		pid: 1332 + pid,
	};
}

function finding(serverId: string, line: number) {
	return {
		serverId,
		source: serverId,
		severity: 1 as const,
		message: `problem ${line}`,
		range: {
			start: { line, character: 0 },
			end: { line, character: 1 },
		},
	};
}

function makeClient(pid: number, serverId: string) {
	return {
		serverId,
		root: "/repo",
		isAlive: vi.fn(() => true),
		isBusy: vi.fn(() => false),
		wasShutdownIntentional: vi.fn(() => true),
		shutdown: vi.fn(async () => undefined),
		getProcessPid: () => pid,
		recentStderr: () => "",
		checkAlive: () => undefined,
		notify: {
			open: vi.fn(async () => undefined),
			change: vi.fn(async () => undefined),
		},
		getDiagnostics: vi.fn(() => [finding(serverId, 1), finding(serverId, 2)]),
		getAllDiagnostics: vi.fn(() => new Map()),
		getTrackedDiagnosticPaths: vi.fn(() => []),
		pruneDiagnostics: vi.fn(() => 0),
		getDiagnosticBinding: vi.fn(() => undefined),
		diagnosticsVersion: 1,
		getDiagnosticsVersionForPath: vi.fn(() => 1),
		waitForDiagnostics: vi.fn(async () => undefined),
		getWorkspaceDiagnosticsSupport: vi.fn(() => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "unavailable" as const,
		})),
		getOperationSupport: vi.fn(() => ({})),
		getMalformedFileOperationRegistrations: () => new Set(),
	};
}

type ClientDouble = ReturnType<typeof makeClient>;

/** Replace every server's process launcher; only the target may spawn. */
function doubleSpawnBoundary(targetId: string, nextPid: () => number) {
	for (const server of LSP_SERVERS) {
		vi.spyOn(server, "spawn").mockImplementation(async () =>
			server.id === targetId
				? ({
						process: fakeProcess(nextPid()),
						source: "test",
					} as never)
				: undefined,
		);
	}
}

/**
 * The fixture file AND its root directory: the file the measurement touches,
 * and the root the real session config is compiled for. A relative `dir`
 * (`tests/fixtures/tool-smoke/<lang>`) resolves against this worktree, which
 * is also the cwd the probe runs from.
 */
function fixtureFor(server: LSPServerInfo): { dir: string; file: string } {
	const fixture = selectFixtureForServer(server, LSP_FIXTURES);
	expect(fixture, `${server.id} has an owned smoke fixture`).not.toBeNull();
	return {
		dir: path.resolve(fixture!.dir),
		file: `${fixture!.dir}/${fixture!.file}`,
	};
}

describe("declared-transparent servers evict through the real registry (#3952)", () => {
	let nextPid = 0;
	let spawned: ClientDouble[] = [];
	let home: { restore: () => void } | undefined;

	beforeEach(() => {
		setProjectTrustState("trusted");
		// `initLSPConfig` resolves the loader's global config against
		// `os.homedir()`, so the case reads a fixture home and never the
		// maintainer's (#4591).
		home = pinFixtureHome("pi-lens-3952-idle-evict");
		nextPid = 0;
		spawned = [];
		createLSPClient.mockReset();
		createLSPClient.mockImplementation(async (args: { serverId: string }) => {
			const client = makeClient(nextPid++, args.serverId);
			spawned.push(client);
			return client;
		});
		delete process.env.PI_LENS_LSP_IDLE_EVICT_MS;
		delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
	});

	afterEach(async () => {
		const config = await import("../../../clients/lsp/config.js");
		config.resetLSPConfigStateForTests();
		home?.restore();
		home = undefined;
		resetProjectTrust();
		vi.restoreAllMocks();
		vi.useRealTimers();
		delete process.env.PI_LENS_LSP_IDLE_EVICT_MS;
		delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
	});

	for (const id of ENABLED_IDS) {
		it(`${id}: evicts on idle and respawns without dropping findings`, async () => {
			vi.useFakeTimers();
			// Arm the window before the first touch so `scheduleIdleEviction`
			// schedules under the declared value. The policy is never forced.
			process.env.PI_LENS_LSP_IDLE_EVICT_MS = String(IDLE_WINDOW_MS);
			doubleSpawnBoundary(id, () => nextPid);
			const server = getServerById(id) as LSPServerInfo;
			const { dir, file } = fixtureFor(server);
			const config = await import("../../../clients/lsp/config.js");
			// The seam the nightly probe runs through: this root is served, so the
			// service reads the COMPILED registry instead of the catalog fallback.
			await config.initLSPConfig(dir);
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();

			const entry = await service.getClientForFile(file);
			expect(entry?.info, `${id} registry object`).toBe(server);
			expect(entry?.info.id, `${id} entry id`).toBe(id);
			const baseline = (await service.getDiagnostics(file, "document")).map(
				findingKey,
			);
			expect(baseline.length, `${id} baseline findings`).toBeGreaterThan(0);

			// The real shared timer fires on the fake clock.
			await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);
			expect(entry!.client.shutdown, `${id} shutdown`).toHaveBeenCalledWith({
				reason: "idle_eviction",
			});
			expect(service.getAliveClientCount(), `${id} alive after idle`).toBe(0);

			// A fresh client generation serves the next request.
			const post = (await service.getDiagnostics(file, "document")).map(
				findingKey,
			);
			expect(spawned.length, `${id} client generations`).toBe(2);
			expect(spawned[0].getProcessPid(), `${id} distinct pids`).not.toBe(
				spawned[1].getProcessPid(),
			);
			expect(new Set(post), `${id} no finding dropped`).toEqual(
				new Set(baseline),
			);
			expect(post.length, `${id} finding count`).toBe(baseline.length);

			await service.shutdown();
		});
	}

	// #5700: the excluded default flipped. An `unmeasured` registry server
	// (declined before, so it lived as long as the host) is evicted on idle
	// through the compiled registry; only `resident` opts out.
	it("evicts an unmeasured registry server on idle (#5700 policy-gate witness)", async () => {
		vi.useFakeTimers();
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = String(IDLE_WINDOW_MS);
		const witness = UNMEASURED_WITNESS_ID;
		expect(witness, "an unproven server with a smoke fixture").toBeDefined();
		doubleSpawnBoundary(witness!, () => nextPid);
		const server = getServerById(witness!) as LSPServerInfo;
		expect(server.idleEviction, `${witness} declared`).toBe("unmeasured");
		const { dir, file } = fixtureFor(server);
		const config = await import("../../../clients/lsp/config.js");
		await config.initLSPConfig(dir);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const entry = await service.getClientForFile(file);
		expect(entry?.info, `${witness} registry object`).toBe(server);
		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);
		expect(entry!.client.shutdown, `${witness} released`).toHaveBeenCalledWith({
			reason: "idle_eviction",
		});
		expect(service.getAliveClientCount()).toBe(0);

		await service.shutdown();
	});

	it("keeps a server declared resident (#5700 opt-out witness)", async () => {
		vi.useFakeTimers();
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = String(IDLE_WINDOW_MS);
		doubleSpawnBoundary(RESIDENT_WITNESS_ID, () => nextPid);
		const server = getServerById(RESIDENT_WITNESS_ID) as LSPServerInfo;
		expect(server.idleEviction, `${RESIDENT_WITNESS_ID} declared`).toBe(
			"resident",
		);
		const { dir, file } = fixtureFor(server);
		const config = await import("../../../clients/lsp/config.js");
		await config.initLSPConfig(dir);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const entry = await service.getClientForFile(file);
		expect(entry?.info, `${RESIDENT_WITNESS_ID} registry object`).toBe(server);
		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 5);
		expect(
			entry!.client.shutdown,
			`${RESIDENT_WITNESS_ID} stays resident`,
		).not.toHaveBeenCalled();
		expect(service.getAliveClientCount()).toBe(1);

		await service.shutdown();
	});

	it("evicts a server the probe arms, through the compiled registry (#3952)", async () => {
		vi.useFakeTimers();
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = String(IDLE_WINDOW_MS);
		doubleSpawnBoundary(RESIDENT_WITNESS_ID, () => nextPid);
		const server = getServerById(RESIDENT_WITNESS_ID) as LSPServerInfo;
		expect(server.idleEviction, `${RESIDENT_WITNESS_ID} declared`).toBe(
			"resident",
		);
		const { dir, file } = fixtureFor(server);
		const config = await import("../../../clients/lsp/config.js");
		await config.initLSPConfig(dir);
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		try {
			// The probe's order: spawn and read the baseline under the DECLARED
			// policy (no timer), then arm the catalog object and issue one ordinary
			// request, which is what (re)schedules the timer under the new policy.
			const entry = await service.getClientForFile(file);
			const baseline = (await service.getDiagnostics(file, "document")).map(
				findingKey,
			);
			expect(baseline.length, "baseline findings").toBeGreaterThan(0);

			server.idleEviction = "transparent";
			await service.getClientForFile(file);

			await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);
			expect(
				entry!.client.shutdown,
				"armed server shutdown",
			).toHaveBeenCalledWith({
				reason: "idle_eviction",
			});
			expect(service.getAliveClientCount(), "alive after idle").toBe(0);

			const post = (await service.getDiagnostics(file, "document")).map(
				findingKey,
			);
			expect(spawned.length, "client generations").toBe(2);
			expect(new Set(post), "no finding dropped").toEqual(new Set(baseline));
		} finally {
			// The catalog entry is process-wide: put the declaration back before
			// any other case in this file reads it.
			server.idleEviction = "resident";
			await service.shutdown();
		}
	});
});
