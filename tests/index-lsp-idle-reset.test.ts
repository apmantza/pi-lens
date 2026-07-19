import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetSubagentModeForTests } from "../clients/subagent-mode.js";
import { createPiMock } from "./support/pi-mock.js";

const INTEGRATION_TIMEOUT_MS = 45_000;

type IntegrationHook = (event: unknown, ctx: unknown) => unknown;

function createMockPi(overrides: Record<string, boolean> = {}) {
	const mock = createPiMock({
		"lens-lsp": true,
		"no-lsp": false,
		"lens-guard": false,
		...overrides,
	});
	return {
		pi: mock.asExtensionAPI(),
		handlers: new Proxy({} as Record<string, IntegrationHook[]>, {
			get: (_target, prop) =>
				typeof prop === "string" ? mock.handlers.get(prop) : undefined,
		}),
	};
}

vi.mock("../clients/read-guard.js", () => ({
	createReadGuard: () => ({
		isNewFile: () => false,
		checkEdit: () => ({ action: "allow" }),
		recordRead: () => {},
		recordWritten: () => {},
		noteCreatedFile: () => {},
		getReadHistory: () => [],
		getEditHistory: () => [],
		addExemption: () => {},
		getSummary: () => ({
			totalEdits: 0,
			totalBlocks: 0,
			byReason: {},
			byFile: {},
			lspExpansionsHelped: 0,
		}),
	}),
}));

describe("index.ts LSP idle reset", () => {
	let tmpDir: string;
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-idle-reset-"));
		vi.stubEnv("PI_LENS_STARTUP_MODE", "quick");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("does not touch a stale event ctx when the detached idle timer fires", async () => {
		let aliveIds: string[] = ["typescript"];
		const resetLSPService = vi.fn(() => {
			aliveIds = [];
		});
		vi.doMock("../clients/lsp/index.js", () => ({
			getLSPService: () => ({
				touchFile: vi.fn(),
				getAliveClientCount: () => aliveIds.length,
				getAliveServerIds: () => aliveIds,
			}),
			resetLSPService,
		}));
		vi.doMock("../clients/bootstrap.js", () => ({
			loadBootstrapClients: async () => ({
				knipClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
			}),
		}));

		const { default: registerExtension } = await import("../index.ts");
		const { pi, handlers } = createMockPi({ "no-lsp": false });
		registerExtension(pi);

		const turnEnd = handlers.turn_end?.[0];
		expect(turnEnd).toBeTypeOf("function");

		const statusUpdates: Array<[string, string | undefined]> = [];
		let stale = false;
		const ui = {
			notify: vi.fn(),
			setStatus: (id: string, text: string | undefined) =>
				statusUpdates.push([id, text]),
			theme: { fg: (_color: string, text: string) => text },
		};
		const ctx = {
			cwd: tmpDir,
			get ui() {
				if (stale) {
					throw new Error("This extension ctx is stale after session replacement");
				}
				return ui;
			},
		};
		const lspStatuses = () =>
			statusUpdates.flatMap(([id, text]) =>
				id === "pi-lens-lsp" ? [text] : [],
			);

		vi.useFakeTimers();
		try {
			await turnEnd?.({}, ctx);
			expect(lspStatuses().at(-1)).toBe("LSP Active: typescript");
			stale = true;

			await vi.advanceTimersByTimeAsync(240_000);

			expect(resetLSPService).toHaveBeenCalledTimes(1);
			expect(lspStatuses().at(-1)).toBe("LSP Inactive");
		} finally {
			vi.useRealTimers();
		}
	}, INTEGRATION_TIMEOUT_MS);

	// #713: subagent light mode uses a shorter idle reset (60s instead of 240s).
	it("subagent session fires the idle reset at 60s, not 240s (#713)", async () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		_resetSubagentModeForTests();

		try {
			const resetLSPService = vi.fn();
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () => ({
					touchFile: vi.fn(),
					getAliveClientCount: () => 0,
					getAliveServerIds: () => [],
				}),
				resetLSPService,
			}));
			vi.doMock("../clients/bootstrap.js", () => ({
				loadBootstrapClients: async () => ({
					knipClient: { isAvailable: () => false },
					depChecker: { isAvailable: () => false },
					testRunnerClient: { detectRunner: () => null },
				}),
			}));

			const { default: registerExtension } = await import("../index.ts");
			const { pi, handlers } = createMockPi({ "no-lsp": false });
			registerExtension(pi);

			const turnEnd = handlers.turn_end?.[0];
			expect(turnEnd).toBeTypeOf("function");

			const ctx = {
				cwd: tmpDir,
				ui: {
					notify: vi.fn(),
					setStatus: vi.fn(),
					theme: { fg: (_color: string, text: string) => text },
				},
			};

			vi.useFakeTimers();
			try {
				await turnEnd?.({}, ctx);

				// Should NOT fire at 59 seconds
				await vi.advanceTimersByTimeAsync(59_000);
				expect(resetLSPService).not.toHaveBeenCalled();

				// Should fire at exactly 60 seconds
				await vi.advanceTimersByTimeAsync(1_000);
				expect(resetLSPService).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		} finally {
			delete process.env.PI_SUBAGENT_CHILD;
			_resetSubagentModeForTests();
		}
	}, INTEGRATION_TIMEOUT_MS);

	it("normal (non-subagent) session still uses 240s idle reset (#713)", async () => {
		// Ensure no subagent env vars are set
		delete process.env.PI_SUBAGENT_CHILD;
		delete process.env.PI_SUBAGENT_CHILD_AGENT;
		delete process.env.PI_SUBAGENT_PARENT_PID;
		_resetSubagentModeForTests();

		const resetLSPService = vi.fn();
		vi.doMock("../clients/lsp/index.js", () => ({
			getLSPService: () => ({
				touchFile: vi.fn(),
				getAliveClientCount: () => 0,
				getAliveServerIds: () => [],
			}),
			resetLSPService,
		}));
		vi.doMock("../clients/bootstrap.js", () => ({
			loadBootstrapClients: async () => ({
				knipClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
			}),
		}));

		const { default: registerExtension } = await import("../index.ts");
		const { pi, handlers } = createMockPi({ "no-lsp": false });
		registerExtension(pi);

		const turnEnd = handlers.turn_end?.[0];
		expect(turnEnd).toBeTypeOf("function");

		const ctx = {
			cwd: tmpDir,
			ui: {
				notify: vi.fn(),
				setStatus: vi.fn(),
				theme: { fg: (_color: string, text: string) => text },
			},
		};

		vi.useFakeTimers();
		try {
			await turnEnd?.({}, ctx);

			// Should NOT fire at 60s (subagent threshold)
			await vi.advanceTimersByTimeAsync(60_000);
			expect(resetLSPService).not.toHaveBeenCalled();

			// Should NOT fire at 239s
			await vi.advanceTimersByTimeAsync(179_000);
			expect(resetLSPService).not.toHaveBeenCalled();

			// Should fire at 240s
			await vi.advanceTimersByTimeAsync(1_000);
			expect(resetLSPService).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	}, INTEGRATION_TIMEOUT_MS);

	it("PI_LENS_SUBAGENT_FULL=1 restores 240s idle reset even in a subagent session (#713)", async () => {
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_LENS_SUBAGENT_FULL = "1";
		_resetSubagentModeForTests();

		try {
			const resetLSPService = vi.fn();
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () => ({
					touchFile: vi.fn(),
					getAliveClientCount: () => 0,
					getAliveServerIds: () => [],
				}),
				resetLSPService,
			}));
			vi.doMock("../clients/bootstrap.js", () => ({
				loadBootstrapClients: async () => ({
					knipClient: { isAvailable: () => false },
					depChecker: { isAvailable: () => false },
					testRunnerClient: { detectRunner: () => null },
				}),
			}));

			const { default: registerExtension } = await import("../index.ts");
			const { pi, handlers } = createMockPi({ "no-lsp": false });
			registerExtension(pi);

			const turnEnd = handlers.turn_end?.[0];
			expect(turnEnd).toBeTypeOf("function");

			const ctx = {
				cwd: tmpDir,
				ui: {
					notify: vi.fn(),
					setStatus: vi.fn(),
					theme: { fg: (_color: string, text: string) => text },
				},
			};

			vi.useFakeTimers();
			try {
				await turnEnd?.({}, ctx);

				// Escape hatch: should NOT fire at 60s
				await vi.advanceTimersByTimeAsync(60_000);
				expect(resetLSPService).not.toHaveBeenCalled();

				// Should fire at 240s (full behavior restored)
				await vi.advanceTimersByTimeAsync(180_000);
				expect(resetLSPService).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		} finally {
			delete process.env.PI_SUBAGENT_CHILD;
			delete process.env.PI_LENS_SUBAGENT_FULL;
			_resetSubagentModeForTests();
		}
	}, INTEGRATION_TIMEOUT_MS);
});
