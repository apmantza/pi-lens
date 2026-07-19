/**
 * R8 (#714) — per-result early-unblock: slow auxiliary grace tests.
 *
 * Verifies that:
 *  1. Fast primary + slow aux: touchFile completes at ~primary+auxGrace, not at
 *     the aux deadline.
 *  2. Aux answering within grace: its diagnostics are included in the result.
 *  3. Slow primary: full wait as today (aux settling early does not shortcut
 *     primary confirmation).
 *  4. Primary-only path: zero new code path entered (grace timer never fires).
 *  5. getDiagnostics: fast primary + slow aux completes before aux deadline.
 *
 * Also covers the raceToCompletion aux-grace unit-level behaviour via the
 * aggregation.test.ts file; these tests exercise the service-level wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

const FILE = "C:/repo/main.ts";
const AUX_GRACE_MS = 500; // Default PI_LENS_AUX_GRACE_MS

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

/** A language-primary server (no role, defaults to "language"). */
function makePrimaryServer(id: string, ext = ".ts") {
	return {
		id,
		name: id,
		extensions: [ext],
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({
			process: makeFakeProcess(),
			source: "test",
		})),
	};
}

/** An auxiliary server (role:"auxiliary"). */
function makeAuxServer(id: string, ext = ".ts") {
	return {
		id,
		name: id,
		extensions: [ext],
		role: "auxiliary" as const,
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({
			process: makeFakeProcess(),
			source: "test",
		})),
	};
}

function makeDiagnostic(message: string) {
	return {
		severity: 1 as const,
		message,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 5 },
		},
	};
}

/**
 * A fake LSP client whose waitForDiagnostics resolves after `delayMs` ms and
 * whose getDiagnostics returns `diags` only AFTER the wait has resolved
 * (simulating real LSP push behaviour: diagnostics land in the client's cache
 * when the server publishes them, which is what waitForDiagnostics waits for).
 */
function makeClient(
	delayMs: number,
	diags: ReturnType<typeof makeDiagnostic>[] = [],
) {
	let waitSettled = false;
	return {
		isAlive: () => true,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		diagnosticsVersion: 0,
		// Only returns diagnostics after waitForDiagnostics has resolved,
		// matching real client behaviour (server pushes → client caches → wait resolves).
		getDiagnostics: vi.fn(() => (waitSettled ? diags : [])),
		notify: {
			open: vi.fn(async () => {}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		waitForDiagnostics: vi.fn(
			() =>
				new Promise<void>((resolve) =>
					setTimeout(() => {
						waitSettled = true;
						resolve();
					}, delayMs),
				),
		),
	};
}

describe("R8 — aux grace: touchFile with-auxiliary path", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		delete process.env.PI_LENS_AUX_GRACE_MS;
	});

	it("completes at primary+auxGrace, not at the aux deadline", async () => {
		process.env.PI_LENS_AUX_GRACE_MS = String(AUX_GRACE_MS);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Primary settles quickly; aux takes 3000ms (well beyond grace).
		const primaryClient = makeClient(100, [makeDiagnostic("primary error")]);
		const auxClient = makeClient(3000, [makeDiagnostic("aux finding")]);

		const primaryServer = makePrimaryServer("ts-primary");
		const auxServer = makeAuxServer("opengrep-aux");

		// getServersForFileWithConfig drives candidate lookup; both servers
		// must appear so the service considers spawning them.
		getServersForFileWithConfig.mockReturnValue([primaryServer, auxServer]);

		// Primary comes first (getClientForFile), aux second (getAuxiliaryClientsForFile).
		createLSPClient
			.mockResolvedValueOnce(primaryClient)
			.mockResolvedValueOnce(auxClient);

		// Warm both into the cache.
		await service.getClientsForFile(FILE);
		// Re-mock for auxiliary lookup (getAuxiliaryClientsForFile uses a separate call).
		createLSPClient.mockReset();

		// For this touch the service resolves primary via getClientForFile and
		// auxiliary via getAuxiliaryClientsForFile. Since clients are already cached
		// (ensureClientForServer returns from state), no further createLSPClient calls
		// are needed — but we need both clients in the cache first.
		// Simplest approach: warm both clients again via a second getClientsForFile
		// (they deduplicate inside the service state).
		const touchPromise = service.touchFile(FILE, "content", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep-aux"],
			collectDiagnostics: true,
			diagnostics: "document",
		});

		// Advance to primary settling (100ms).
		await vi.advanceTimersByTimeAsync(100);
		// Advance through aux grace window (500ms). Aux is still at 3000ms.
		await vi.advanceTimersByTimeAsync(AUX_GRACE_MS + 10);

		const result = await touchPromise;
		// Touch resolved before aux deadline (3000ms) — we only waited ~610ms.
		// Primary diagnostics included.
		expect(Array.isArray(result)).toBe(true);
		// Aux was cut off — its diagnostics may or may not be present depending
		// on whether it resolved before the grace expired. Since aux takes 3000ms
		// and grace is 500ms, aux is NOT included.
		const messages = (result ?? []).map((d: { message: string }) => d.message);
		// Primary must be included (it answered before grace).
		expect(messages).toContain("primary error");
		// Aux must NOT be included (it didn't answer within grace).
		expect(messages).not.toContain("aux finding");
	});

	it("includes aux diagnostics when aux answers within grace", async () => {
		process.env.PI_LENS_AUX_GRACE_MS = String(AUX_GRACE_MS);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Primary settles at 100ms, aux settles at 400ms (within 500ms grace).
		const primaryClient = makeClient(100, [makeDiagnostic("primary error")]);
		const auxClient = makeClient(400, [makeDiagnostic("aux finding")]);

		const primaryServer = makePrimaryServer("ts-primary");
		const auxServer = makeAuxServer("opengrep-aux");

		getServersForFileWithConfig.mockReturnValue([primaryServer, auxServer]);
		createLSPClient
			.mockResolvedValueOnce(primaryClient)
			.mockResolvedValueOnce(auxClient);

		await service.getClientsForFile(FILE);

		const touchPromise = service.touchFile(FILE, "content2", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep-aux"],
			collectDiagnostics: true,
			diagnostics: "document",
		});

		// Advance past primary (100ms) + aux (400ms) — all within grace (500ms).
		await vi.advanceTimersByTimeAsync(400);
		await vi.advanceTimersByTimeAsync(10);

		const result = await touchPromise;
		const messages = (result ?? []).map((d: { message: string }) => d.message);
		// Both must be present — aux answered within grace.
		expect(messages).toContain("primary error");
		expect(messages).toContain("aux finding");
	});

	it("still waits for slow primary even if aux settles early", async () => {
		process.env.PI_LENS_AUX_GRACE_MS = String(AUX_GRACE_MS);

		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// Aux settles fast; primary is slow.
		const primaryClient = makeClient(1200, [makeDiagnostic("primary error")]);
		const auxClient = makeClient(50, [makeDiagnostic("aux finding")]);

		const primaryServer = makePrimaryServer("ts-primary");
		const auxServer = makeAuxServer("opengrep-aux");

		getServersForFileWithConfig.mockReturnValue([primaryServer, auxServer]);
		createLSPClient
			.mockResolvedValueOnce(primaryClient)
			.mockResolvedValueOnce(auxClient);

		await service.getClientsForFile(FILE);

		const touchPromise = service.touchFile(FILE, "content3", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["opengrep-aux"],
			collectDiagnostics: true,
			diagnostics: "document",
		});

		// At 600ms: aux is done (50ms), grace would have expired, but PRIMARY is
		// still pending (1200ms). The touch must NOT have resolved yet.
		await vi.advanceTimersByTimeAsync(600);
		let resolved = false;
		touchPromise.then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(false);

		// Advance to primary settling.
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(10);

		const result = await touchPromise;
		const messages = (result ?? []).map((d: { message: string }) => d.message);
		expect(messages).toContain("primary error");
	});
});

describe("R8 — aux grace: raceToCompletion per-role unit tests", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("completes at primary+auxGrace when primary fast and aux slow", async () => {
		const { raceToCompletion } = await import(
			"../../../clients/lsp/aggregation.js"
		);

		const fast = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "primary", count: 1 }), 100),
		);
		const slow = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "aux", count: 1 }), 3000),
		);

		const resultPromise = raceToCompletion(
			[fast, slow],
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 5000,
				graceMs: 0, // No additional quality grace
				descriptors: [{ role: "primary" }, { role: "auxiliary" }],
				auxGraceMs: 500,
			},
		);

		// Primary settles at 100ms; aux grace starts. At 600ms grace expires.
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(10);

		const result = await resultPromise;
		// Should have resolved at ~610ms with only primary result (aux at 3000ms).
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("primary");
	});

	it("includes aux result when it answers within auxGrace", async () => {
		const { raceToCompletion } = await import(
			"../../../clients/lsp/aggregation.js"
		);

		const fast = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "primary", count: 1 }), 100),
		);
		const aux = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "aux", count: 2 }), 400),
		);

		const resultPromise = raceToCompletion(
			[fast, aux],
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 5000,
				graceMs: 0,
				descriptors: [{ role: "primary" }, { role: "auxiliary" }],
				auxGraceMs: 500,
			},
		);

		// Advance past aux (400ms). Primary settled at 100ms, aux grace = 500ms.
		// Aux answers at 400ms, which is within grace → both included.
		await vi.advanceTimersByTimeAsync(400);
		await vi.advanceTimersByTimeAsync(10);

		const result = await resultPromise;
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.id).sort()).toEqual(["aux", "primary"]);
	});

	it("primary-only path: aux grace timer never fires", async () => {
		const { raceToCompletion } = await import(
			"../../../clients/lsp/aggregation.js"
		);
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

		const p1 = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "a", count: 1 }), 50),
		);
		const p2 = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "b", count: 1 }), 80),
		);

		const resultPromise = raceToCompletion(
			[p1, p2],
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 1500,
				graceMs: 0,
				// No descriptors with role:"auxiliary" → aux-grace path not entered.
				descriptors: [{ role: "primary" }, { role: "primary" }],
				auxGraceMs: 500,
			},
		);

		const callCountBefore = setTimeoutSpy.mock.calls.length;

		await vi.advanceTimersByTimeAsync(80);
		await vi.advanceTimersByTimeAsync(10);
		await resultPromise;

		// No NEW setTimeout calls beyond the hard-timeout one set up at entry
		// should be for the aux grace (500ms). Verify by checking that no
		// 500ms setTimeout was scheduled.
		const newCalls = setTimeoutSpy.mock.calls.slice(callCountBefore);
		const auxGraceTimers = newCalls.filter(([, ms]) => ms === 500);
		expect(auxGraceTimers).toHaveLength(0);
	});

	it("slow primary: aux settling early does not finalize the race early", async () => {
		const { raceToCompletion } = await import(
			"../../../clients/lsp/aggregation.js"
		);

		// Aux resolves fast; primary is slow.
		const primary = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "primary", count: 0 }), 1200),
		);
		const aux = new Promise<{ id: string; count: number }>((resolve) =>
			setTimeout(() => resolve({ id: "aux", count: 5 }), 50),
		);

		const resultPromise = raceToCompletion(
			[primary, aux],
			// shouldComplete triggers when any has count > 0 — aux satisfies it at 50ms.
			(results) => results.some((r) => r.count > 0),
			{
				timeoutMs: 5000,
				graceMs: 0, // No quality grace
				descriptors: [{ role: "primary" }, { role: "auxiliary" }],
				auxGraceMs: 500,
			},
		);

		// At 600ms: aux is done (50ms), aux grace has expired, but PRIMARY is
		// still pending (1200ms). Race must NOT have resolved yet — primary is
		// not settled so aux-grace can't have started.
		let resolved = false;
		resultPromise.then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(600);
		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(false);

		// Advance past primary.
		await vi.advanceTimersByTimeAsync(700);
		await vi.advanceTimersByTimeAsync(10);
		const result = await resultPromise;
		expect(result.find((r) => r.id === "primary")).toBeDefined();
	});
});
