import { beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

const FILE = "C:/repo/main.py";

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

function makeServer(id: string) {
	return {
		id,
		name: id,
		extensions: [".py"],
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

describe("LSPService.touchFile collectDiagnostics", () => {
	beforeEach(() => {
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});

	it("returns merged diagnostics from touched clients", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const diagnostic = makeDiagnostic("collected error");
		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: {
				open: vi.fn().mockResolvedValue(undefined),
			},
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => [diagnostic, diagnostic]),
		};

		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

		const result = await service.touchFile(FILE, "print('x')\n", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			maxClientWaitMs: 25,
			silent: true,
			source: "test",
		});

		expect(client.notify.open).toHaveBeenCalledWith(
			FILE,
			"print('x')\n",
			"python",
			undefined,
			true,
		);
		expect(client.waitForDiagnostics).toHaveBeenCalledWith(FILE, 25);
		expect(result).toEqual([diagnostic]);
	});

	it("skips notify.open on the second touch with identical content but still waits for diagnostics (#116)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const diagnostic = makeDiagnostic("collected error");
		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: {
				open: vi.fn().mockResolvedValue(undefined),
			},
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => [diagnostic]),
		};

		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

		const content = "print('x')\n";

		// First touch — diagnostics not collected (mirrors the post-write
		// tool_result path which fires touchFile with diagnostics="none").
		await service.touchFile(FILE, content, {
			clientScope: "primary",
			diagnostics: "none",
			collectDiagnostics: false,
			maxClientWaitMs: 25,
			silent: true,
			source: "tool_call:edit",
		});
		expect(client.notify.open).toHaveBeenCalledTimes(1);

		// Second touch — diagnostics collected (mirrors the dispatch-lsp-runner
		// path which fires moments later with the same content). The notify
		// should be skipped, but the diagnostic wait must still happen so the
		// runner returns the LSP's published diagnostics.
		const result = await service.touchFile(FILE, content, {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			maxClientWaitMs: 25,
			silent: true,
			source: "dispatch-lsp-runner",
		});

		expect(client.notify.open).toHaveBeenCalledTimes(1);
		expect(client.waitForDiagnostics).toHaveBeenCalledWith(FILE, 25);
		expect(result).toEqual([diagnostic]);
	});

	it("sends notify.open again when the second touch has different content", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn().mockResolvedValue(undefined) },
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => []),
		};

		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

		await service.touchFile(FILE, "print('x')\n", {
			clientScope: "primary",
			diagnostics: "none",
			source: "tool_call:edit",
		});
		await service.touchFile(FILE, "print('y')\n", {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "dispatch-lsp-runner",
		});

		expect(client.notify.open).toHaveBeenCalledTimes(2);
	});

	function makeBudgetClient() {
		return {
			isAlive: () => true,
			shutdown: async () => {},
			getWorkspaceDiagnosticsSupport: () => ({
				advertised: false,
				mode: "push-only" as const,
				diagnosticProviderKind: "none",
			}),
			getOperationSupport: () => ({}),
			notify: { open: vi.fn().mockResolvedValue(undefined) },
			waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn(() => []),
		};
	}

	it("an explicit maxDiagnosticsWaitMs caps the wait when tighter than the server strategy (#117)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = makeBudgetClient();
		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

		// 800 < python strategy (1500), so the caller's tight budget binds and
		// reaches the client unchanged.
		await service.touchFile(FILE, "print('x')\n", {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			maxClientWaitMs: 8000,
			maxDiagnosticsWaitMs: 800,
			source: "dispatch-lsp-runner",
		});

		expect(client.waitForDiagnostics).toHaveBeenCalledWith(FILE, 800);
	});

	it("the per-server strategy budget caps the wait below a looser caller value (#203)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = makeBudgetClient();
		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

		// Caller cap 2500, but python's strategy aggregateWaitMs is 1500 — on the
		// single-server hot path the tighter per-server budget wins so a fast
		// server isn't held to a flat multi-second wait.
		await service.touchFile(FILE, "print('x')\n", {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			maxClientWaitMs: 8000,
			maxDiagnosticsWaitMs: 2500,
			source: "dispatch-lsp-runner",
		});

		expect(client.waitForDiagnostics).toHaveBeenCalledWith(FILE, 1500);
	});

	it("uses the per-server strategy budget when no caller budget is set (#203)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = makeBudgetClient();
		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

		// No maxDiagnosticsWaitMs/maxClientWaitMs — the python strategy (1500)
		// applies instead of the 1200 document-mode floor.
		await service.touchFile(FILE, "print('x')\n", {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "dispatch-lsp-runner",
		});

		expect(client.waitForDiagnostics).toHaveBeenCalledWith(FILE, 1500);
	});

	function makeBudgetClientWithId(serverId: string) {
		return { ...makeBudgetClient(), serverId };
	}

	it("gives each server its own caller-cap-bounded deadline on the with-auxiliary path, not a shared max (#242)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const primaryClient = makeBudgetClientWithId("python");
		const auxClient = makeBudgetClientWithId("ast-grep");
		createLSPClient.mockImplementation(async (args: { serverId: string }) =>
			args.serverId === "ast-grep" ? auxClient : primaryClient,
		);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("python"),
			{ ...makeServer("ast-grep"), role: "auxiliary" as const },
		]);

		// Caller cap 2500. Old code waited max(2500, max(1500,1800))=2500 for BOTH.
		// Now each server gets min(callerCap, ownBudget): python 1500, ast-grep 1800.
		await service.touchFile(FILE, "print('x')\n", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["ast-grep"],
			diagnostics: "document",
			collectDiagnostics: true,
			maxClientWaitMs: 8000,
			maxDiagnosticsWaitMs: 2500,
			source: "dispatch-lsp-runner",
		});

		expect(primaryClient.waitForDiagnostics).toHaveBeenCalledWith(FILE, 1500);
		expect(auxClient.waitForDiagnostics).toHaveBeenCalledWith(FILE, 1800);
	});

	it("the caller cap is a ceiling on the with-auxiliary path — a tight cap binds every server (#242)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const primaryClient = makeBudgetClientWithId("python");
		const auxClient = makeBudgetClientWithId("ast-grep");
		createLSPClient.mockImplementation(async (args: { serverId: string }) =>
			args.serverId === "ast-grep" ? auxClient : primaryClient,
		);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("python"),
			{ ...makeServer("ast-grep"), role: "auxiliary" as const },
		]);

		// Cap 1200 is tighter than both strategy budgets (1500, 1800), so both
		// servers are capped to 1200 — a slow aux can no longer blow the per-edit cap.
		await service.touchFile(FILE, "print('x')\n", {
			clientScope: "with-auxiliary",
			auxiliaryServerIds: ["ast-grep"],
			diagnostics: "document",
			collectDiagnostics: true,
			maxClientWaitMs: 8000,
			maxDiagnosticsWaitMs: 1200,
			source: "dispatch-lsp-runner",
		});

		expect(primaryClient.waitForDiagnostics).toHaveBeenCalledWith(FILE, 1200);
		expect(auxClient.waitForDiagnostics).toHaveBeenCalledWith(FILE, 1200);
	});

	it("gives each server its own caller-cap-bounded deadline on the 'all' scope, not a shared flat number (#573)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const primaryClient = makeBudgetClientWithId("python");
		const auxClient = makeBudgetClientWithId("ast-grep");
		createLSPClient.mockImplementation(async (args: { serverId: string }) =>
			args.serverId === "ast-grep" ? auxClient : primaryClient,
		);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("python"),
			{ ...makeServer("ast-grep"), role: "auxiliary" as const },
		]);

		// Before #573, clientScope "all" fell through to the flat
		// `callerCap ?? modeFloor` branch: BOTH servers would have been called
		// with the same 2500 caller cap regardless of their own strategy budget
		// (python 1500, ast-grep 1800). Now each gets min(callerCap, ownBudget).
		await service.touchFile(FILE, "print('x')\n", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			maxClientWaitMs: 8000,
			maxDiagnosticsWaitMs: 2500,
			source: "lens_diagnostics_full",
		});

		expect(primaryClient.waitForDiagnostics).toHaveBeenCalledWith(FILE, 1500);
		expect(auxClient.waitForDiagnostics).toHaveBeenCalledWith(FILE, 1800);
	});

	it("a fast primary server's own wait call is bounded by its own budget, not held to a slow auxiliary's larger one, on the 'all' scope (#573)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		// typescript strategy is 1000ms (fast, push-silent); opengrep is
		// 3500ms (slow auxiliary scanner). No caller cap set.
		const primaryClient = makeBudgetClientWithId("typescript");
		const auxClient = makeBudgetClientWithId("opengrep");
		createLSPClient.mockImplementation(async (args: { serverId: string }) =>
			args.serverId === "opengrep" ? auxClient : primaryClient,
		);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("typescript"),
			{ ...makeServer("opengrep"), role: "auxiliary" as const },
		]);

		await service.touchFile(FILE, "const x = 1;\n", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			source: "lens_diagnostics_full",
		});

		// Each server's individual waitForDiagnostics call is bounded by its
		// OWN strategy budget — the fast primary is not parked at 3500ms
		// waiting for the slow auxiliary's ceiling.
		expect(primaryClient.waitForDiagnostics).toHaveBeenCalledWith(FILE, 1000);
		expect(auxClient.waitForDiagnostics).toHaveBeenCalledWith(FILE, 3500);
	});

	it("the caller cap is a ceiling on the 'all' scope — a tight cap binds every server (#573)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const primaryClient = makeBudgetClientWithId("python");
		const auxClient = makeBudgetClientWithId("ast-grep");
		createLSPClient.mockImplementation(async (args: { serverId: string }) =>
			args.serverId === "ast-grep" ? auxClient : primaryClient,
		);
		getServersForFileWithConfig.mockReturnValue([
			makeServer("python"),
			{ ...makeServer("ast-grep"), role: "auxiliary" as const },
		]);

		// Cap 1200 is tighter than both strategy budgets (1500, 1800), so both
		// servers are capped to 1200.
		await service.touchFile(FILE, "print('x')\n", {
			clientScope: "all",
			diagnostics: "document",
			collectDiagnostics: true,
			maxClientWaitMs: 8000,
			maxDiagnosticsWaitMs: 1200,
			source: "lens_diagnostics_full",
		});

		expect(primaryClient.waitForDiagnostics).toHaveBeenCalledWith(FILE, 1200);
		expect(auxClient.waitForDiagnostics).toHaveBeenCalledWith(FILE, 1200);
	});

	it("PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS env override still wins on the 'all' scope (#573)", async () => {
		const previous = process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "700";
		try {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();

			const primaryClient = makeBudgetClientWithId("python");
			const auxClient = makeBudgetClientWithId("ast-grep");
			createLSPClient.mockImplementation(async (args: { serverId: string }) =>
				args.serverId === "ast-grep" ? auxClient : primaryClient,
			);
			getServersForFileWithConfig.mockReturnValue([
				makeServer("python"),
				{ ...makeServer("ast-grep"), role: "auxiliary" as const },
			]);

			await service.touchFile(FILE, "print('x')\n", {
				clientScope: "all",
				diagnostics: "document",
				collectDiagnostics: true,
				maxClientWaitMs: 8000,
				maxDiagnosticsWaitMs: 2500,
				source: "lens_diagnostics_full",
			});

			expect(primaryClient.waitForDiagnostics).toHaveBeenCalledWith(FILE, 700);
			expect(auxClient.waitForDiagnostics).toHaveBeenCalledWith(FILE, 700);
		} finally {
			if (previous === undefined) {
				delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
			} else {
				process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = previous;
			}
		}
	});

	it("with-auxiliary and single-server primary per-server behavior is unchanged by the 'all' fix (#573 regression guard)", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();
		const client = makeBudgetClient();
		createLSPClient.mockResolvedValue(client);
		getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

		await service.touchFile(FILE, "print('x')\n", {
			clientScope: "primary",
			diagnostics: "document",
			collectDiagnostics: true,
			maxClientWaitMs: 8000,
			maxDiagnosticsWaitMs: 2500,
			source: "dispatch-lsp-runner",
		});

		// Unchanged from the pre-#573 behavior: primary/single-server still gets
		// its own strategy budget (1500), capped by the caller ceiling (2500).
		expect(client.waitForDiagnostics).toHaveBeenCalledWith(FILE, 1500);
	});

	it("does not hang when notify.open backpressures — bounded by PI_LENS_LSP_NOTIFY_BUDGET_MS", async () => {
		const prev = process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
		process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = "50";
		try {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const client = {
				isAlive: () => true,
				shutdown: async () => {},
				getWorkspaceDiagnosticsSupport: () => ({
					advertised: false,
					mode: "push-only" as const,
					diagnosticProviderKind: "none",
				}),
				getOperationSupport: () => ({}),
				// notify.open never resolves = a server whose stdin backpressures
				// (wedged/CPU-bound). Unbounded, this parked the dispatch LSP runner
				// until its 30s dispatcher timeout. It must now bail at the budget.
				notify: { open: vi.fn(() => new Promise(() => {})) },
				waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
				getDiagnostics: vi.fn(() => []),
			};
			createLSPClient.mockResolvedValue(client);
			getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

			const started = Date.now();
			const result = await service.touchFile(FILE, "print('x')\n", {
				clientScope: "primary",
				diagnostics: "document",
				collectDiagnostics: true,
				maxClientWaitMs: 25,
				maxDiagnosticsWaitMs: 50,
				source: "dispatch-lsp-runner",
			});
			const elapsed = Date.now() - started;

			expect(client.notify.open).toHaveBeenCalled();
			expect(elapsed).toBeLessThan(2000); // returned, did not hang on the write
			expect(result).toEqual([]); // no fresh diagnostics, but no hang
		} finally {
			if (prev === undefined) delete process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS;
			else process.env.PI_LENS_LSP_NOTIFY_BUDGET_MS = prev;
		}
	});

	it("PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS overrides the option chain", async () => {
		const previous = process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
		process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = "1000";
		try {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const client = {
				isAlive: () => true,
				shutdown: async () => {},
				getWorkspaceDiagnosticsSupport: () => ({
					advertised: false,
					mode: "push-only" as const,
					diagnosticProviderKind: "none",
				}),
				getOperationSupport: () => ({}),
				notify: { open: vi.fn().mockResolvedValue(undefined) },
				waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
				getDiagnostics: vi.fn(() => []),
			};

			createLSPClient.mockResolvedValue(client);
			getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

			// Even with a higher explicit option, env wins via readEnvDiagnosticsWaitMs
			// because the touchFile resolution checks the env before the explicit option.
			// Verify: the env override of 1000 ms is what reaches the client.
			await service.touchFile(FILE, "print('x')\n", {
				clientScope: "primary",
				diagnostics: "document",
				collectDiagnostics: true,
				maxClientWaitMs: 8000,
				source: "dispatch-lsp-runner",
			});

			expect(client.waitForDiagnostics).toHaveBeenCalledWith(FILE, 1000);
		} finally {
			if (previous === undefined) {
				delete process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS;
			} else {
				process.env.PI_LENS_LSP_DIAGNOSTICS_MAX_WAIT_MS = previous;
			}
		}
	});

	// #570: a touch whose diagnostics wait TIMES OUT must never present as a
	// confirmed clean result — the returned array must be flagged
	// `inconclusive`, and (critically) a previously-confirmed non-empty
	// `lastKnownDiagnostics` record must survive the timeout untouched rather
	// than being wiped by an unconfirmed empty result.
	describe("#570 timeout does not present as confirmed-clean", () => {
		it("a timed-out touch does NOT clear lastKnownDiagnostics when there was a prior confirmed non-empty result", async () => {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const diagnostic = makeDiagnostic("real error");
			// First client call: confirms one real diagnostic (fast, no timeout).
			let diagnosticsToReturn = [diagnostic];
			const client = {
				isAlive: () => true,
				shutdown: async () => {},
				getWorkspaceDiagnosticsSupport: () => ({
					advertised: false,
					mode: "push-only" as const,
					diagnosticProviderKind: "none",
				}),
				getOperationSupport: () => ({}),
				notify: { open: vi.fn().mockResolvedValue(undefined) },
				waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
				getDiagnostics: vi.fn(() => diagnosticsToReturn),
			};
			createLSPClient.mockResolvedValue(client);
			getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

			const firstResult = await service.touchFile(FILE, "print('x')\n", {
				clientScope: "primary",
				diagnostics: "document",
				collectDiagnostics: true,
				maxClientWaitMs: 8000,
				maxDiagnosticsWaitMs: 8000,
				source: "dispatch-lsp-runner",
			});
			expect(firstResult).toEqual([diagnostic]);
			expect((firstResult as any).inconclusive).not.toBe(true);
			expect(service.getLastKnownDiagnostics(FILE)).toEqual([diagnostic]);

			// Second touch: content changed (so notify isn't skipped) and the
			// diagnostics wait is forced to time out via maxDiagnosticsWaitMs: 0
			// (timeoutMs resolves to 0, so `waitedMs + 20 >= timeoutMs` is always
			// true even though the mock wait resolves instantly). The server's
			// diagnostics cache reads back empty (as if cleared by the fresh
			// notify.open and nothing arrived yet) — this must NOT be read as a
			// confirmed clean result.
			diagnosticsToReturn = [];
			const secondResult = await service.touchFile(FILE, "print('y')\n", {
				clientScope: "primary",
				diagnostics: "document",
				collectDiagnostics: true,
				maxClientWaitMs: 8000,
				maxDiagnosticsWaitMs: 0,
				source: "dispatch-lsp-runner",
			});

			expect((secondResult as any).inconclusive).toBe(true);
			// The prior confirmed non-empty record must survive untouched.
			expect(service.getLastKnownDiagnostics(FILE)).toEqual([diagnostic]);
		});

		it("a confirmed (non-timeout) empty result still clears lastKnownDiagnostics as before", async () => {
			const { LSPService } = await import("../../../clients/lsp/index.js");
			const service = new LSPService();
			const diagnostic = makeDiagnostic("real error");
			let diagnosticsToReturn = [diagnostic];
			const client = {
				isAlive: () => true,
				shutdown: async () => {},
				getWorkspaceDiagnosticsSupport: () => ({
					advertised: false,
					mode: "push-only" as const,
					diagnosticProviderKind: "none",
				}),
				getOperationSupport: () => ({}),
				notify: { open: vi.fn().mockResolvedValue(undefined) },
				waitForDiagnostics: vi.fn().mockResolvedValue(undefined),
				getDiagnostics: vi.fn(() => diagnosticsToReturn),
			};
			createLSPClient.mockResolvedValue(client);
			getServersForFileWithConfig.mockReturnValue([makeServer("python")]);

			await service.touchFile(FILE, "print('x')\n", {
				clientScope: "primary",
				diagnostics: "document",
				collectDiagnostics: true,
				maxClientWaitMs: 8000,
				maxDiagnosticsWaitMs: 8000,
				source: "dispatch-lsp-runner",
			});
			expect(service.getLastKnownDiagnostics(FILE)).toEqual([diagnostic]);

			// Second touch: content changed, generous budget (no timeout), and the
			// server genuinely reports zero diagnostics this time — the existing
			// behavior (clear the cache, report clean) must be unchanged.
			diagnosticsToReturn = [];
			const secondResult = await service.touchFile(FILE, "print('y')\n", {
				clientScope: "primary",
				diagnostics: "document",
				collectDiagnostics: true,
				maxClientWaitMs: 8000,
				maxDiagnosticsWaitMs: 8000,
				source: "dispatch-lsp-runner",
			});

			expect(secondResult).toEqual([]);
			expect((secondResult as any).inconclusive).not.toBe(true);
			expect(service.getLastKnownDiagnostics(FILE)).toBeUndefined();
		});
	});
});
