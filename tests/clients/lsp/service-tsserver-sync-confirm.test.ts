/**
 * #707: per-edit path tsserver sync clean-confirm tests.
 *
 * When the diagnostics wait for a primary-scope touch times out with an empty
 * result and the primary server is tier-3-silent (classic typescript-language-
 * server), `touchFile` must attempt the `typescript.tsserverRequest` escape
 * hatch before marking the result inconclusive — turning "unconfirmed after
 * wait budget" into "confirmed clean" (or confirmed with diagnostics) at the
 * cost of a short sync RTT.
 *
 * Tests:
 *   1. clean TS file — sync returns empty body → confirmed, inconclusive=false
 *   2. dirty TS file — sync returns diagnostics → confirmed, findings surfaced
 *   3. non-typescript server — sync never attempted
 *   4. push arrives before timeout — sync never attempted (not a timeout case)
 *   5. sync fails (throws) — falls through to inconclusive behavior unchanged
 *   6. command not advertised — falls through to inconclusive behavior
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module-level mocks set up BEFORE any imports of the tested module ---

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

// Prevent quiet-window registration side-effects in tests
vi.mock("../../../clients/quiet-window.js", () => ({
	registerQuietWindowTask: vi.fn(),
}));

vi.mock("../../../clients/latency-logger.js", () => ({
	logLatency: vi.fn(),
}));

vi.mock("../../../clients/widget-state.js", () => ({
	recordLsp: vi.fn(),
}));

vi.mock("../../../clients/cascade-logger.js", () => ({
	logCascade: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeServer(
	id: string,
	extensions: string[] = [".ts"],
	role?: "language" | "auxiliary",
) {
	return {
		id,
		name: id,
		extensions,
		root: async () => "C:/repo",
		role,
		spawn: vi.fn(async () => ({
			process: makeFakeProcess(),
			source: "test",
		})),
	};
}

function makeSyncResponse(
	bodies: Partial<
		Record<"semanticDiagnosticsSync" | "syntacticDiagnosticsSync", unknown[]>
	>,
) {
	// The CLIENT's executeCommand is called as executeCommand(command, args)
	// (the service layer strips the filePath before forwarding to the client).
	return vi
		.fn()
		.mockImplementation(async (command: string, args: unknown[]) => {
			// command is the outer "typescript.tsserverRequest"; first arg element
			// is the inner tsserver sub-command name.
			const sub = (args as [string, unknown])[0] as
				| "semanticDiagnosticsSync"
				| "syntacticDiagnosticsSync";
			return {
				executed: true,
				result: {
					success: true,
					body: bodies[sub] ?? [],
				},
			};
		});
}

/** A minimal fake LSP client shape that satisfies LSPService's needs for the
 * primary-scope touchFile path. Callers can override individual methods. */
function makeClient(overrides: Record<string, unknown> = {}) {
	return {
		serverId: "typescript",
		root: "C:/repo",
		isAlive: () => true,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		getAdvertisedCommands: () => ["typescript.tsserverRequest"],
		getLaunchVariant: () => undefined, // classic (not native-ts7)
		getRawCapabilityKeys: () => [],
		diagnosticsVersion: 0,
		notify: {
			open: vi.fn().mockResolvedValue(undefined),
		},
		// waitForDiagnostics resolves after a delay to simulate the timeout path.
		// Default: resolves immediately (no diagnostics will land anyway).
		waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
		getDiagnostics: vi.fn(() => []),
		getAllDiagnostics: () => new Map(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("#707 per-edit tsserver sync clean-confirm in touchFile", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("clean TS file: sync returns empty body → confirmed clean, inconclusive=false", async () => {
		const client = makeClient({
			executeCommand: makeSyncResponse({}), // empty bodies → clean
		});
		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("typescript")]);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Use a very short wait so the diagnostics wait times out immediately
		const result = await service.touchFile(FILE, "const x = 1;\n", {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			// No maxClientWaitMs so spawn doesn't race a timer — only diagnostics wait is capped
			maxDiagnosticsWaitMs: 1, // effectively zero — times out immediately
			source: "test-707-clean",
		});

		expect(result).toBeDefined();
		expect(result).toEqual([]);
		// The sync confirm should have cleared the inconclusive flag
		expect((result as any)?.inconclusive).toBeFalsy();
	});

	it("dirty TS file: sync returns diagnostics → confirmed with findings, inconclusive=false", async () => {
		const syncDiag = {
			message: "Type 'number' is not assignable to type 'string'.",
			category: "error",
			code: 2322,
			startLocation: { line: 1, offset: 5 },
			endLocation: { line: 1, offset: 10 },
		};
		const client = makeClient({
			executeCommand: makeSyncResponse({ semanticDiagnosticsSync: [syncDiag] }),
		});
		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("typescript")]);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(FILE, "const x: string = 1;\n", {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			maxDiagnosticsWaitMs: 1,
			source: "test-707-dirty",
		});

		expect(result).toBeDefined();
		expect(result!.length).toBe(1);
		expect(result![0]?.message).toContain("not assignable to type 'string'");
		expect((result as any)?.inconclusive).toBeFalsy();
	});

	it("non-typescript server (gopls): sync is never attempted", async () => {
		// gopls is push-only but NOT silentOnClean — tier3-silent check won't fire
		const executeCommand = vi.fn();
		const client = makeClient({
			serverId: "gopls",
			executeCommand,
			getAdvertisedCommands: () => [], // gopls doesn't advertise tsserverRequest
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getLaunchVariant: () => undefined,
		});
		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("gopls", [".go"])]);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile("C:/repo/main.go", "package main\n", {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			maxDiagnosticsWaitMs: 1,
			source: "test-707-gopls",
		});

		// gopls is not silentOnClean, so the sync path must not be attempted
		expect(executeCommand).not.toHaveBeenCalled();
		// result may be inconclusive (timeout), that's fine — we just verify no sync
	});

	it("push diagnostics arrive before timeout: sync never attempted", async () => {
		const executeCommand = vi.fn();
		const diag = {
			severity: 1 as const,
			message: "error from push",
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
		};
		const client = makeClient({
			executeCommand,
			// waitForDiagnostics resolves fast (push arrived)
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => [diag]),
		});
		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("typescript")]);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Long enough wait that push "arrives" (getDiagnostics returns non-empty)
		// and the timeout doesn't trigger.
		const result = await service.touchFile(FILE, "const x: string = 1;\n", {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			maxDiagnosticsWaitMs: 5000, // large — push arrives well within budget
			source: "test-707-push-wins",
		});

		// The wait resolves before the budget — no timeout, so no sync call
		expect(executeCommand).not.toHaveBeenCalled();
		expect(result).toBeDefined();
		expect(result!.length).toBeGreaterThan(0);
	});

	it("sync executeCommand throws: falls through to inconclusive behavior", async () => {
		const client = makeClient({
			executeCommand: vi.fn().mockRejectedValue(new Error("No Project.")),
		});
		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("typescript")]);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(FILE, "const x = 1;\n", {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			maxDiagnosticsWaitMs: 1,
			source: "test-707-throws",
		});

		// Sync failed — should be inconclusive (undefined or has inconclusive flag)
		// Either undefined (no client ready) or an array with inconclusive=true
		if (result !== undefined) {
			expect((result as any)?.inconclusive).toBe(true);
		}
	});

	it("command not advertised: falls through to inconclusive behavior", async () => {
		const executeCommand = vi.fn();
		const client = makeClient({
			getAdvertisedCommands: () => [], // no tsserverRequest
			executeCommand,
		});
		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("typescript")]);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const result = await service.touchFile(FILE, "const x = 1;\n", {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			maxDiagnosticsWaitMs: 1,
			source: "test-707-unadvertised",
		});

		expect(executeCommand).not.toHaveBeenCalled();
		if (result !== undefined) {
			expect((result as any)?.inconclusive).toBe(true);
		}
	});
});
