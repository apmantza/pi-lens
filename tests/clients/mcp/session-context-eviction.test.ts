/**
 * #1570: `getMcpSessionContext`'s `contextPromise ??= (async () => {...})()`
 * memo used to cache a REJECTED promise for the process lifetime. A single
 * transient failure while building the session context (e.g.
 * `loadBootstrapClients` hitting a momentary fs error) would permanently
 * break every later MCP call in the process — there is no session_start
 * boundary on the MCP path to re-arm anything, so eviction on rejection is
 * the only fix that lets a later call recover.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { listDeclaredGenerationSources } from "../../../clients/generation-guard.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../../../clients/latency-logger.js";
import { installLspServiceDouble } from "../../support/lsp-service-seam.js";
import { useConfigPath } from "../../support/global-config.js";
import { pinFixtureHome, setupTestEnvironment } from "../test-utils.js";

const loadBootstrapClients = vi.hoisted(() => vi.fn());
const createdRuntimes = vi.hoisted(
	() =>
		[] as Array<{
			sessionScope: {
				isLive: () => boolean;
				retiredBy: () => string | undefined;
			};
			captureSessionGeneration: () => { isCurrent: () => boolean };
		}>,
);

vi.mock("../../../clients/bootstrap.js", () => ({ loadBootstrapClients }));
vi.mock("../../../clients/ast-grep-client.js", () => ({
	AstGrepClient: class {},
}));
vi.mock("../../../clients/runtime-coordinator.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../clients/runtime-coordinator.js")
		>();
	class TrackedRuntimeCoordinator extends actual.RuntimeCoordinator {
		constructor(
			...args: ConstructorParameters<typeof actual.RuntimeCoordinator>
		) {
			super(...args);
			createdRuntimes.push(this);
		}
	}
	return { ...actual, RuntimeCoordinator: TrackedRuntimeCoordinator };
});
// Static (module-load-time) import, not a dynamic `await import(...)` inside
// the it() body — a dynamic import's module-graph transform cost (measured
// 3.3-5.2s under contention) was charged against the per-test timeout and
// flaked. Mocks above still hoist ahead of this import (vitest hoists
// vi.mock calls regardless of import position), matching session.test.ts's
// pattern.
import {
	_resetMcpSessionContext,
	getMcpSessionContext,
	invalidateMcpSessionIfConfigChanged,
	peekMcpSessionRuntime,
} from "../../../clients/mcp/session.js";

const setConfigPath = useConfigPath();

const TMP_PREFIX = "pi-lens-mcp-eviction-";
let env: ReturnType<typeof setupTestEnvironment>;
let previousDataDir: string | undefined;
let previousTestMode: string | undefined;

async function scopeEndReasons(): Promise<string[]> {
	await flushLatencyLog();
	const logPath = getLatencyLogPath();
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(
			(line) =>
				JSON.parse(line) as {
					phase?: string;
					metadata?: { transition?: string; reason?: string };
				},
		)
		.filter(
			(row) =>
				row.phase === "session_scope_transition" &&
				row.metadata?.transition === "end",
		)
		.map((row) => String(row.metadata?.reason));
}

beforeEach(async () => {
	env = setupTestEnvironment(TMP_PREFIX);
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	resetDegradationLedger();
	clearLatencyLog();
	await flushLatencyLog();
	// `getMcpSessionContext` reads only `getAliveClientCount`; the rest of the
	// surface comes from the factory (#2592).
	await installLspServiceDouble({ getAliveClientCount: () => 0 });
	loadBootstrapClients.mockReset();
	createdRuntimes.length = 0;
});

afterEach(async () => {
	try {
		await flushLatencyLog();
	} finally {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previousTestMode;
		env.cleanup();
		vi.resetModules();
	}
});

afterAll(async () => {
	await flushLatencyLog();
});

describe("getMcpSessionContext memo eviction (#1570)", () => {
	it("retries after a rejected build instead of replaying the same rejection forever", async () => {
		_resetMcpSessionContext();
		clearLatencyLog();
		await flushLatencyLog();

		loadBootstrapClients.mockRejectedValueOnce(
			new Error("EMFILE: transient fs error"),
		);
		await expect(getMcpSessionContext()).rejects.toThrow(
			"EMFILE: transient fs error",
		);
		expect(createdRuntimes).toHaveLength(1);
		const failedRuntime = createdRuntimes[0]!;
		expect(failedRuntime.sessionScope.isLive()).toBe(false);
		expect(failedRuntime.sessionScope.retiredBy()).toBe(
			"mcp-session-bootstrap-failed",
		);
		expect(await scopeEndReasons()).toEqual(["mcp-session-bootstrap-failed"]);

		loadBootstrapClients.mockResolvedValueOnce({ __stub: "clients" });
		const context = await getMcpSessionContext();
		expect(context.clients).toEqual({ __stub: "clients" });

		// The memo stays hot after a success — a THIRD call must not re-invoke
		// the loader.
		const again = await getMcpSessionContext();
		expect(again).toBe(context);
		expect(loadBootstrapClients).toHaveBeenCalledTimes(2);
	});

	it("retires a resolved session scope when _resetMcpSessionContext resets it", async () => {
		_resetMcpSessionContext();
		clearLatencyLog();
		await flushLatencyLog();

		loadBootstrapClients.mockResolvedValueOnce({ __stub: "first" });
		const first = await getMcpSessionContext();
		const firstHandle = first.runtime.captureSessionGeneration();
		expect(first.runtime.sessionScope.isLive()).toBe(true);
		expect(firstHandle.isCurrent()).toBe(true);

		_resetMcpSessionContext();
		expect(peekMcpSessionRuntime()).toBeUndefined();
		expect(first.runtime.sessionScope.isLive()).toBe(false);
		expect(first.runtime.sessionScope.retiredBy()).toBe("mcp-session-reset");
		expect(firstHandle.isCurrent()).toBe(false);
		expect(await scopeEndReasons()).toEqual(["mcp-session-reset"]);

		loadBootstrapClients.mockResolvedValueOnce({ __stub: "second" });
		const second = await getMcpSessionContext();
		expect(second).not.toBe(first);
		expect(second.runtime.sessionScope.isLive()).toBe(true);
		expect(second.runtime.sessionScope.retiredBy()).toBeUndefined();
	});

	it("prevents an in-flight bootstrap interrupted by _resetMcpSessionContext from republishing resolvedRuntime or evicting a successor memo", async () => {
		_resetMcpSessionContext();
		clearLatencyLog();
		await flushLatencyLog();
		resetDegradationLedger();

		expect(listDeclaredGenerationSources()).toContain("mcp-session-bootstrap");

		let resolveFirst!: (value: unknown) => void;
		loadBootstrapClients.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveFirst = resolve;
				}),
		);
		const first = getMcpSessionContext();
		expect(peekMcpSessionRuntime()).toBeUndefined();
		expect(createdRuntimes).toHaveLength(1);
		const firstRuntime = createdRuntimes[0]!;
		const firstHandle = firstRuntime.captureSessionGeneration();
		expect(firstRuntime.sessionScope.isLive()).toBe(true);
		expect(firstHandle.isCurrent()).toBe(true);

		// Reset while the first bootstrap is still awaiting loadBootstrapClients,
		// then start a successor bootstrap BEFORE the stale first promise settles.
		_resetMcpSessionContext();
		expect(firstRuntime.sessionScope.isLive()).toBe(false);
		expect(firstRuntime.sessionScope.retiredBy()).toBe("mcp-session-reset");
		expect(firstHandle.isCurrent()).toBe(false);
		expect(await scopeEndReasons()).toEqual(["mcp-session-reset"]);

		loadBootstrapClients.mockResolvedValueOnce({ __stub: "successor" });
		const successorPromise = getMcpSessionContext();

		resolveFirst({ __stub: "stale" });
		await expect(first).rejects.toThrow(
			/MCP session context reset during bootstrap/,
		);

		const successor = await successorPromise;
		expect(successor.clients).toEqual({ __stub: "successor" });
		expect(peekMcpSessionRuntime()).toBe(successor.runtime);
		expect(successor.runtime.sessionScope.retiredBy()).toBeUndefined();
		expect(successor.runtime.captureSessionGeneration().isCurrent()).toBe(true);
		// Stale catch handler must not have cleared the successor contextPromise.
		expect(await getMcpSessionContext()).toBe(successor);
		expect(loadBootstrapClients).toHaveBeenCalledTimes(2);
		expect(await scopeEndReasons()).toEqual(["mcp-session-reset"]);
		expect(
			getDegradationSummary()
				.filter((group) => group.kind === "generation-guard-stale-write")
				.flatMap((group) => group.latestReasons.map((entry) => entry.subject)),
		).toContain("mcp-session-bootstrap:bootstrap");
	});

	it("invalidates and resets the live MCP session when inspected config sources change", async () => {
		const { home, restore } = pinFixtureHome("mcp-eviction-config-change");
		try {
			setConfigPath(path.join(home, ".pi-lens", "config.json"));
			const projectDir = path.join(home, "repo");
			fs.mkdirSync(projectDir, { recursive: true });
			const configFile = path.join(projectDir, ".pi-lens.json");

			_resetMcpSessionContext();
			clearLatencyLog();
			await flushLatencyLog();

			// First observation records baseline without resetting.
			expect(invalidateMcpSessionIfConfigChanged(projectDir)).toBe(false);
			loadBootstrapClients.mockResolvedValue({ __stub: "clients" });
			const ctx1 = await getMcpSessionContext();
			expect(invalidateMcpSessionIfConfigChanged(projectDir)).toBe(false);

			// 1. Creating a previously absent .pi-lens.json (initially invalid JSON) resets.
			fs.writeFileSync(configFile, "{ not json", "utf8");
			expect(invalidateMcpSessionIfConfigChanged(projectDir)).toBe(true);
			expect(ctx1.runtime.sessionScope.isLive()).toBe(false);
			expect(ctx1.runtime.sessionScope.retiredBy()).toBe("mcp-session-reset");
			expect(peekMcpSessionRuntime()).toBeUndefined();

			// 2. Fixing invalid JSON (parsed: false -> true) resets again.
			const ctx2 = await getMcpSessionContext();
			fs.writeFileSync(configFile, JSON.stringify({ lsp: { warmFiles: [] } }));
			expect(invalidateMcpSessionIfConfigChanged(projectDir)).toBe(true);
			expect(ctx2.runtime.sessionScope.isLive()).toBe(false);
			expect(ctx2.runtime.sessionScope.retiredBy()).toBe("mcp-session-reset");

			// 3. Editing a setting resets again.
			const ctx3 = await getMcpSessionContext();
			fs.writeFileSync(
				configFile,
				JSON.stringify({ lsp: { warmFiles: ["src/a.ts"] } }),
			);
			expect(invalidateMcpSessionIfConfigChanged(projectDir)).toBe(true);
			expect(ctx3.runtime.sessionScope.retiredBy()).toBe("mcp-session-reset");

			// 4. Replacing with an unreadable directory, then fixing back to valid JSON resets each time.
			const ctx4 = await getMcpSessionContext();
			fs.rmSync(configFile);
			fs.mkdirSync(configFile, { recursive: true });
			expect(invalidateMcpSessionIfConfigChanged(projectDir)).toBe(true);
			expect(ctx4.runtime.sessionScope.isLive()).toBe(false);

			const ctx5 = await getMcpSessionContext();
			fs.rmSync(configFile, { recursive: true });
			fs.writeFileSync(configFile, "{}", "utf8");
			expect(invalidateMcpSessionIfConfigChanged(projectDir)).toBe(true);
			expect(ctx5.runtime.sessionScope.isLive()).toBe(false);

			// 5. Deleting the config file resets again.
			const ctx6 = await getMcpSessionContext();
			fs.rmSync(configFile);
			expect(invalidateMcpSessionIfConfigChanged(projectDir)).toBe(true);
			expect(ctx6.runtime.sessionScope.isLive()).toBe(false);

			const reasons = await scopeEndReasons();
			expect(reasons).toEqual(Array(6).fill("mcp-session-reset"));
		} finally {
			restore();
		}
	});
});
