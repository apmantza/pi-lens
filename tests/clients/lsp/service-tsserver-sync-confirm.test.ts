/**
 * #707: per-edit path tsserver sync clean-confirm tests.
 *
 * Racing variant: for a tier-3 silent primary (classic typescript-language-
 * server), `touchFile` races the push wait against a grace-delayed
 * `typescript.tsserverRequest` sync confirm (grace default 300ms, tunable via
 * PI_LENS_TSSERVER_SYNC_GRACE_MS) — a clean file resolves at ~grace+RTT
 * instead of burning the full push-wait budget. An end-of-wait fallback still
 * covers the case where the race couldn't answer but the wait timed out empty.
 *
 * End-of-wait fallback tests (push wait resolves before the grace, so the
 * race is decided by push and the fallback fires on the timed-out empty
 * result):
 *   1. clean TS file — sync returns empty body → confirmed, inconclusive=false
 *   2. dirty TS file — sync returns diagnostics → confirmed, findings surfaced
 *   3. non-typescript server — sync never attempted
 *   4. push arrives before timeout — sync never attempted (not a timeout case)
 *   5. sync fails (throws) — falls through to inconclusive behavior unchanged
 *   6. command not advertised — falls through to inconclusive behavior
 *
 * Racing tests (grace pinned low via PI_LENS_TSSERVER_SYNC_GRACE_MS):
 *   a. clean file — sync confirm resolves the touch WELL UNDER the wait budget
 *   b. push arriving before the grace — no sync request ever goes out
 *   c. sync failing mid-race — wait runs to its budget, end-of-wait fallback
 *      still gets its shot (also fails → inconclusive preserved)
 *   d. dirty-file sync winner — findings surfaced, not discarded
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
		.mockImplementation(async (_command: string, args: unknown[]) => {
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
		delete process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS;
	});

	afterEach(() => {
		delete process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS;
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

		await service.touchFile("C:/repo/main.go", "package main\n", {
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

	// --- Racing variant (#707 upgrade): the sync confirm races the push wait ---

	describe("racing sync confirm", () => {
		it("clean file: racing sync confirm resolves the touch WELL UNDER the wait budget", async () => {
			process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS = "25";
			const client = makeClient({
				executeCommand: makeSyncResponse({}), // empty bodies → confirmed clean
				// Push wait pinned: a silent-on-clean server never publishes on a
				// clean file, so this wait would run to its full ~1000ms strategy
				// budget (typescript aggregateWaitMs) if nothing raced it.
				waitForDiagnostics: vi.fn(() => new Promise(() => {})),
			});
			createLSPClient.mockResolvedValue(client);
			getServersForFileWithConfig.mockReturnValue([makeServer("typescript")]);

			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();

			const started = Date.now();
			const result = await service.touchFile(FILE, "const x = 1;\n", {
				clientScope: "primary",
				diagnostics: "document",
				collectDiagnostics: true,
				maxDiagnosticsWaitMs: 5000, // budget = min(5000, strategy 1000) = 1000ms
				source: "test-707-race-clean",
			});
			const elapsed = Date.now() - started;

			// The sync confirm answers at ~grace(25ms)+RTT — far below the 1000ms
			// budget the pinned push wait would otherwise burn in full.
			expect(elapsed).toBeLessThan(800);
			expect(result).toBeDefined();
			expect(result).toEqual([]);
			expect((result as any)?.inconclusive).toBeFalsy();
		});

		it("dirty file: racing sync winner surfaces the diagnostics, not discarded", async () => {
			process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS = "25";
			const syncDiag = {
				message: "Cannot find name 'missingSymbol'.",
				category: "error",
				code: 2304,
				startLocation: { line: 3, offset: 1 },
				endLocation: { line: 3, offset: 14 },
			};
			const client = makeClient({
				executeCommand: makeSyncResponse({
					semanticDiagnosticsSync: [syncDiag],
				}),
				waitForDiagnostics: vi.fn(() => new Promise(() => {})), // push pinned
			});
			createLSPClient.mockResolvedValue(client);
			getServersForFileWithConfig.mockReturnValue([makeServer("typescript")]);

			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();

			const started = Date.now();
			const result = await service.touchFile(FILE, "missingSymbol();\n", {
				clientScope: "primary",
				diagnostics: "document",
				collectDiagnostics: true,
				maxDiagnosticsWaitMs: 5000,
				source: "test-707-race-dirty",
			});
			const elapsed = Date.now() - started;

			expect(elapsed).toBeLessThan(800);
			expect(result).toBeDefined();
			expect(result!.length).toBe(1);
			expect(result![0]?.message).toContain("Cannot find name");
			// tsserver 1-based line 3/offset 1 → LSP 0-based line 2/character 0
			expect(result![0]?.range.start).toEqual({ line: 2, character: 0 });
			expect((result as any)?.inconclusive).toBeFalsy();
		});

		it("push arriving before the grace: no sync request ever goes out", async () => {
			process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS = "40";
			const executeCommand = vi.fn();
			const diag = {
				severity: 1 as const,
				message: "error from push",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 5 },
				},
			};
			const client = makeClient({
				executeCommand,
				// Push publishes almost immediately — well before the 40ms grace.
				waitForDiagnostics: vi.fn(
					() => new Promise((resolve) => setTimeout(resolve, 5)),
				),
				getDiagnostics: vi.fn(() => [diag]),
			});
			createLSPClient.mockResolvedValue(client);
			getServersForFileWithConfig.mockReturnValue([makeServer("typescript")]);

			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();

			const result = await service.touchFile(FILE, "const x: string = 1;\n", {
				clientScope: "primary",
				diagnostics: "document",
				collectDiagnostics: true,
				maxDiagnosticsWaitMs: 5000,
				source: "test-707-race-push-first",
			});

			// Wait past the grace so the racer's timer has definitely fired — it
			// must see the settled push wait and bail without a sync request.
			await new Promise((resolve) => setTimeout(resolve, 80));

			expect(executeCommand).not.toHaveBeenCalled();
			expect(result).toBeDefined();
			expect(result!.length).toBe(1);
			expect((result as any)?.inconclusive).toBeFalsy();
		});

		it("sync failing mid-race: wait runs to its budget, end-of-wait fallback fires and inconclusive is preserved", async () => {
			process.env.PI_LENS_TSSERVER_SYNC_GRACE_MS = "10";
			const executeCommand = vi
				.fn()
				.mockRejectedValue(new Error("No Project."));
			const client = makeClient({
				executeCommand,
				// Push wait respects its per-call timeout — resolves exactly at the
				// budget, i.e. today's silent-server timeout behavior.
				waitForDiagnostics: vi.fn(
					(_file: string, timeoutMs: number) =>
						new Promise((resolve) => setTimeout(resolve, timeoutMs)),
				),
			});
			createLSPClient.mockResolvedValue(client);
			getServersForFileWithConfig.mockReturnValue([makeServer("typescript")]);

			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();

			const started = Date.now();
			const result = await service.touchFile(FILE, "const x = 1;\n", {
				clientScope: "primary",
				diagnostics: "document",
				collectDiagnostics: true,
				maxDiagnosticsWaitMs: 100, // budget = min(100, 1000) = 100ms
				source: "test-707-race-sync-fails",
			});
			const elapsed = Date.now() - started;

			// The failed racing attempt must NOT shorten the wait — the push wait
			// still ran to its 100ms budget.
			expect(elapsed).toBeGreaterThanOrEqual(90);
			// The racing attempt tried (executeCommand called), then the
			// end-of-wait fallback tried again — both failed, so today's
			// inconclusive behavior is preserved.
			expect(executeCommand).toHaveBeenCalled();
			expect(result).toBeDefined();
			expect((result as any)?.inconclusive).toBe(true);
		});
	});
});
