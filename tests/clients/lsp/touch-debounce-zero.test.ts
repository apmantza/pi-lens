// flake-shape: in-process-mock — createLSPClient spawns a language-server process; the double it returns runs the real handleNotifyOpen and reads content identity through the real sentContentFor and hasNotifyInFlightFor, and a real server cannot be made to report whether it holds exactly the debounce gate's bytes on demand
// flake-shape: service-double — a language-server client is a spawned process; only its alive-answers are scripted; the notify queue and content identity gate are the real ones over a real state
/**
 * Issue #5419: drives the `TOUCH_DEBOUNCE_MS <= 0` branch of `shouldSkipNotify`.
 *
 * PI_LENS_LSP_TOUCH_DEBOUNCE_MS is read once at module load (clients/lsp/index.ts
 * line 352). When set to "0", `shouldSkipNotify` returns `false` unconditionally
 * (the debounce switch is off), so two identical-content touches for one file
 * both reach the client. With the default (1500 > 0), the second identical touch
 * is debounced: `shouldSkipNotify` returns `true` and `notify.open` is NOT called
 * a second time.
 *
 * Production chain: the REAL `LSPService.touchFile` and the REAL
 * `handleNotifyOpen` notify queue per client, over a mock `MessageConnection`
 * (the process boundary). Content identity is read through the real
 * `sentContentFor` and `hasNotifyInFlightFor` so the debounce's content gate
 * is exercised, not bypassed. vi.resetModules() + a dynamic import reloads the
 * module with the env value, matching the env-at-import pattern used in
 * service-scanner-coverage-gap.test.ts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as clientModule from "../../../clients/lsp/client.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";
import { createMockState } from "./mock-client-state.js";

const { getServersForFileWithConfig, createLSPClient } = vi.hoisted(() => ({
	getServersForFileWithConfig: vi.fn(),
	createLSPClient: vi.fn(),
}));

vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

const CONTENT = "# test\n";
const SYNC = {
	diagnostics: "none" as const,
	clientScope: "primary" as const,
	source: "lsp_sync",
};

function makeServer(id: string, ext: string, root: string) {
	return {
		id,
		name: id,
		extensions: [ext],
		idleEviction: "resident" as const,
		role: "language" as const,
		root: async () => root,
		spawn: vi.fn(async () => ({ process: {}, source: "test" })),
	};
}

/**
 * A push-only client over the real notify queue.
 *
 * Unlike service-crash-respawn.test.ts's client (which tests the client-identity
 * check at `previous.client.deref() !== client` before the content check is
 * reached), this one implements `getSentContent` and `hasNotifyInFlight` so the
 * debounce's content-identity gate is exercised: after the first notify lands,
 * `sentContentFor` reports the stored hash, and `hasNotifyInFlightFor` reports
 * the drained queue. Without those, `shouldSkipNotify` falls through at the
 * content check and always re-pushes — the debounce is never reached.
 */
function makeClient(serverId: string, root: string) {
	const state = createMockState({ root, serverId });
	const holds = (filePath: string) =>
		state.openDocuments.has(normalizeMapKey(filePath));
	const client = {
		serverId,
		root,
		customServer: false,
		state,
		holds,
		isAlive: () => state.isConnected && !state.isDestroyed,
		isConnected: true,
		wasShutdownIntentional: () => false,
		getExitedAt: () => state.exitedAt,
		shutdown: vi.fn(async () => {}),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => [],
		getLaunchVariant: () => undefined,
		notify: {
			announceCreated: () => undefined,
			open: vi.fn(
				(
					filePath: string,
					content: string,
					languageId: string,
					preserveDiagnostics?: boolean,
					silent?: boolean,
					saved?: boolean,
					readStamp?: number,
					contentHash?: string,
				) =>
					clientModule.handleNotifyOpen(
						state,
						filePath,
						content,
						languageId,
						preserveDiagnostics,
						silent,
						saved,
						readStamp,
						contentHash,
					),
			),
		},
		// The debounce's content-identity gate (shouldSkipNotify #4532 gap 9 F3).
		// Without these, `sentContent === undefined` → `return false` and the
		// debounce is never exercised.
		getSentContent: (filePath: string) =>
			clientModule.sentContentFor(state, filePath),
		// #4532 gap 9 F1: the queue is drained after the first touch completes,
		// so the second touch's check correctly sees "no content send in flight".
		hasNotifyInFlight: (filePath: string) =>
			clientModule.hasNotifyInFlightFor(state, filePath),
		getDiagnosticsVersionForPath: (filePath: string) =>
			holds(filePath) ? 1 : 0,
		getDiagnostics: () => [],
		getAllDiagnostics: () => new Map(),
		getDiagnosticBinding: () => undefined,
		waitForDiagnostics: vi.fn(async () => {}),
		pingLiveness: vi.fn(async () => client.isAlive()),
	};
	return client;
}

describe("touch-debounce 0 branch (#5419)", () => {
	let tmp: string;
	let filePath: string;

	beforeEach(() => {
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-debounce-zero-"));
		filePath = path.join(tmp, "a.md");
		fs.writeFileSync(filePath, CONTENT);
		vi.useFakeTimers({ toFake: ["Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
		delete process.env.PI_LENS_LSP_TOUCH_DEBOUNCE_MS;
		removeTempDirSync(tmp);
	});

	it("default TOUCH_DEBOUNCE_MS: second identical SYNC touch is debounced", async () => {
		delete process.env.PI_LENS_LSP_TOUCH_DEBOUNCE_MS;
		vi.resetModules();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const { _setServersForFileForTests } =
			await import("../../../clients/lsp/config.js");
		_setServersForFileForTests(getServersForFileWithConfig);

		const server = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [server] : [],
		);
		const client = makeClient("marksman", tmp);
		createLSPClient.mockResolvedValue(client);

		const service = new LSPService();
		await service.touchFile(filePath, CONTENT, SYNC);
		await service.touchFile(filePath, CONTENT, SYNC);

		// The debounce skips the second identical push: notify.open called once.
		expect(client.notify.open).toHaveBeenCalledTimes(1);
	});

	it("PI_LENS_LSP_TOUCH_DEBOUNCE_MS=0: both identical SYNC touches reach the client", async () => {
		process.env.PI_LENS_LSP_TOUCH_DEBOUNCE_MS = "0";
		vi.resetModules();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const { _setServersForFileForTests } =
			await import("../../../clients/lsp/config.js");
		_setServersForFileForTests(getServersForFileWithConfig);

		const server = makeServer("marksman", ".md", tmp);
		getServersForFileWithConfig.mockImplementation((fp: string) =>
			fp.endsWith(".md") ? [server] : [],
		);
		const client = makeClient("marksman", tmp);
		createLSPClient.mockResolvedValue(client);

		const service = new LSPService();
		await service.touchFile(filePath, CONTENT, SYNC);
		await service.touchFile(filePath, CONTENT, SYNC);

		// The debounce is disabled (TOUCH_DEBOUNCE_MS = 0): both touches
		// reach the client, so notify.open is called twice.
		expect(client.notify.open).toHaveBeenCalledTimes(2);
	});
});
