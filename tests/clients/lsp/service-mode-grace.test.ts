/**
 * Integration tests for getDiagnostics with mode-aware grace (1B)
 * and result-aware racing (1E).
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

function server(id: string) {
	return {
		id,
		name: id,
		extensions: [".ts"],
		root: async () => "C:/repo",
		spawn: vi.fn(async () => ({
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
		})),
	};
}

function diag(msg: string) {
	return {
		severity: 1 as const,
		message: msg,
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
	};
}

function fakeClient(waitMs: number, diags: ReturnType<typeof diag>[]) {
	return {
		isAlive: () => true,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none" as const,
		}),
		getOperationSupport: () => ({}),
		waitForDiagnostics: vi.fn(
			() => new Promise<void>((r) => setTimeout(r, waitMs)),
		),
		getDiagnostics: vi.fn(() => diags),
	};
}

describe("getDiagnostics — mode-aware grace (1B)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// NOTE: A "document mode resolves immediately" test is deferred.
	// Vitest's fake timers do not flush the recursive microtask chain
	// produced by synchronous finalize()→resolve() inside a .then() callback.
	// The behavior is covered by raceToCompletion unit tests (graceMs=0).

	it("full mode: grace window adds 400ms delay after first result", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const svc = new LSPService();

		let resolveSlow: () => void = () => {};
		const fast = fakeClient(100, [diag("fast-error")]);
		const slow = {
			...fakeClient(5000, []),
			waitForDiagnostics: vi.fn(
				() =>
					new Promise<void>((r) => {
						resolveSlow = r;
						setTimeout(r, 5000);
					}),
			),
		};
		void resolveSlow;

		createLSPClient.mockResolvedValueOnce(fast).mockResolvedValueOnce(slow);
		getServersForFileWithConfig.mockReturnValue([server("a"), server("b")]);
		await svc.getClientsForFile(FILE);

		const p = svc.getDiagnostics(FILE, "full");

		// Fast resolves at 100ms — grace timer (400ms) starts.
		await vi.advanceTimersByTimeAsync(100);
		let resolved = false;
		p.then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(false);

		await vi.advanceTimersByTimeAsync(400);
		const result = await p;
		expect(result).toHaveLength(1);
		expect(result[0].message).toBe("fast-error");
	});

	it("default mode (no parameter) == full mode", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const svc = new LSPService();

		let resolveSlow: () => void = () => {};
		const fast = fakeClient(50, [diag("default-error")]);
		const slow = {
			...fakeClient(5000, []),
			waitForDiagnostics: vi.fn(
				() =>
					new Promise<void>((r) => {
						resolveSlow = r;
						setTimeout(r, 5000);
					}),
			),
		};
		void resolveSlow;

		createLSPClient.mockResolvedValueOnce(fast).mockResolvedValueOnce(slow);
		getServersForFileWithConfig.mockReturnValue([server("a"), server("b")]);
		await svc.getClientsForFile(FILE);

		const p = svc.getDiagnostics(FILE); // default "full"
		await vi.advanceTimersByTimeAsync(50);
		let resolved = false;
		p.then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(false);
		await vi.advanceTimersByTimeAsync(400);
		const result = await p;
		expect(result).toHaveLength(1);
		expect(result[0].message).toBe("default-error");
	});
});

describe("getDiagnostics — result-aware racing (1E)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("empty fast client does NOT trigger early-unblock", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const svc = new LSPService();

		const empty = fakeClient(50, []);
		const real = fakeClient(300, [diag("real-error"), diag("second-error")]);

		createLSPClient.mockResolvedValueOnce(empty).mockResolvedValueOnce(real);
		getServersForFileWithConfig.mockReturnValue([
			server("empty"),
			server("real"),
		]);
		await svc.getClientsForFile(FILE);

		const p = svc.getDiagnostics(FILE, "document");

		await vi.advanceTimersByTimeAsync(50);
		let resolved = false;
		p.then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(false);

		await vi.advanceTimersByTimeAsync(250);
		await vi.advanceTimersByTimeAsync(1);

		const result = await p;
		expect(result).toHaveLength(2);
		expect(result.map((d) => d.message).sort()).toEqual([
			"real-error",
			"second-error",
		]);
	});

	it("both empty — waits for all, returns []", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const svc = new LSPService();

		const a = fakeClient(100, []);
		const b = fakeClient(300, []);

		createLSPClient.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
		getServersForFileWithConfig.mockReturnValue([server("a"), server("b")]);
		await svc.getClientsForFile(FILE);

		const p = svc.getDiagnostics(FILE, "document");
		await vi.advanceTimersByTimeAsync(100);
		let resolved = false;
		p.then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(resolved).toBe(false);
		await vi.advanceTimersByTimeAsync(200);
		await vi.advanceTimersByTimeAsync(1);
		const result = await p;
		expect(result).toHaveLength(0);
	});

	it("full mode: second client within grace window is collected", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const svc = new LSPService();

		const a = fakeClient(50, [diag("from-a")]);
		const b = fakeClient(200, [diag("from-b")]);

		createLSPClient.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
		getServersForFileWithConfig.mockReturnValue([server("a"), server("b")]);
		await svc.getClientsForFile(FILE);

		const p = svc.getDiagnostics(FILE, "full");
		await vi.advanceTimersByTimeAsync(200);
		await vi.advanceTimersByTimeAsync(1);
		const result = await p;
		expect(result).toHaveLength(2);
		expect(result.map((d) => d.message).sort()).toEqual(["from-a", "from-b"]);
	});
});
