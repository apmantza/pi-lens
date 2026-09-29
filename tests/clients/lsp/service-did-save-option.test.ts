/**
 * #3405: `LSPService.touchFile`'s `saved` option is what reaches the client.
 *
 * Recurrence this file prevents: a save flag that stops at the service boundary.
 * The client-side gate (`tests/clients/lsp/did-save-notification.test.ts`) can be
 * perfect and the fix still inert if `touchFile` never forwards the caller's
 * declaration to `notify.open` — the wrong-layer half of the same seam. These
 * cases drive the REAL `LSPService.touchFile` with the exact option object the
 * post-write sync (`clients/pipeline.ts`, `source: "lsp_sync"`) issues and read
 * the argument the client was handed.
 *
 * Screens: the only doubles are `createLSPClient` and the server registry, both
 * true process/config boundaries — the service, its per-server notify loop and
 * its debounce bookkeeping are real. Not a **loose bound**: the sixth argument
 * is pinned to the exact boolean in both directions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const ROOT = "C:/repo";

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
		pid: 4343,
	};
}

function makeServer(id: string, ext: string) {
	return {
		id,
		name: id,
		extensions: [ext],
		idleEviction: "resident",
		root: async () => ROOT,
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
	};
}

function makeClient(serverId: string, open: ReturnType<typeof vi.fn>) {
	return {
		serverId,
		root: ROOT,
		customServer: false,
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
		diagnosticsVersion: 0,
		getDiagnosticsVersionForPath: vi.fn(() => 0),
		getDiagnostics: vi.fn(() => []),
		getAllDiagnostics: vi.fn(() => new Map()),
		getDiagnosticBinding: vi.fn(() => undefined),
		notify: {
			open,
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		pingLiveness: vi.fn().mockResolvedValue(true),
		waitForDiagnostics: vi.fn(async () => {}),
	};
}

/** Exactly the options `clients/pipeline.ts`'s `resyncLspFile` issues, minus
 *  the flag under test. */
const POST_WRITE_TOUCH = {
	diagnostics: "none" as const,
	source: "lsp_sync",
	clientScope: "primary" as const,
	maxClientWaitMs: 5000,
};

async function touchWith(
	options: Record<string, unknown>,
): Promise<unknown[] | undefined> {
	const { LSPService } = await import("../../../clients/lsp/index.js");
	const service = new LSPService();
	const open = vi.fn(async () => {});
	getServersForFileWithConfig.mockReturnValue([
		makeServer("typescript", ".ts"),
	]);
	createLSPClient.mockResolvedValue(makeClient("typescript", open));
	const file = `${ROOT}/saved.ts`;
	await service.getClientsForFile(file);
	await service.touchFile(file, "const x = 1;\n", {
		...POST_WRITE_TOUCH,
		...options,
	});
	return open.mock.calls[0];
}

describe("#3405 — touchFile forwards the caller's save declaration", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("hands notify.open saved=true for the post-write sync's own options", async () => {
		const call = await touchWith({ saved: true });
		expect(call?.[5]).toBe(true);
	});

	it("hands notify.open saved=false when the caller declared no save", async () => {
		// Every warm-up, cascade and sweep caller lands here. `false`, never
		// `undefined`: the client's parameter default is what a partial double
		// would fall back to, so the service states the answer explicitly.
		const call = await touchWith({});
		expect(call?.[5]).toBe(false);
	});
});
