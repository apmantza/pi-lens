import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../clients/cache-manager.js";
import { createPiMock } from "./support/pi-mock.js";

// This suite predates the consolidated harness and is written against the
// legacy `{ pi, handlers, commands }` shape. Adapt the canonical createPiMock
// to that shape so there is a single mock recorder (the old tests/support/
// mock-pi.ts is removed), and preserve the default flags these tests assume.
// Call sites can move to the native createPiMock API (getHandlers/emit)
// opportunistically (#171).
// Each test does `vi.resetModules()` + `await import("../index.ts")`, so every
// case cold-evaluates the WHOLE extension dependency graph. That's inherently
// heavy, and under full-suite parallel-transform contention the first/most
// complex case (the session_start closure test) can exceed a tight per-test
// budget — it passes in ~3s isolated but was flaking at 15s under load. This is
// a time-budget issue, not a hang, so give these import-bound integration tests
// generous headroom; a genuine deadlock still fails, just later.
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
		commands: {
			// Legacy call sites invoke handlers as `handler(event, ctx)` with loose
			// args; expose that signature (the adapter is the compatibility layer).
			get: (name: string) =>
				mock.getCommand(name) as
					| {
							handler?: (args: unknown, ctx: unknown) => unknown;
							description?: string;
					  }
					| undefined,
		},
		tools: mock.tools,
		async trigger(event: string, ev: unknown, ctx: unknown = {}) {
			const results: unknown[] = [];
			for (const handler of mock.getHandlers(event)) {
				results.push(await handler(ev, ctx));
			}
			return results;
		},
	};
}

// Mock read-guard for integration tests to avoid dynamic require issues
vi.mock("../clients/read-guard.js", () => ({
	ReadGuard: class MockReadGuard {
		isNewFile() {
			return false;
		}
		checkEdit() {
			return { action: "allow" };
		}
		recordRead() {}
		recordWritten() {}
		noteCreatedFile() {}
		getReadHistory() {
			return [];
		}
		getEditHistory() {
			return [];
		}
		addExemption() {}
		getSummary() {
			return {
				totalEdits: 0,
				totalBlocks: 0,
				byReason: {},
				byFile: {},
				lspExpansionsHelped: 0,
			};
		}
	},
	createReadGuard: () =>
		new (class MockReadGuard {
			isNewFile() {
				return false;
			}
			checkEdit() {
				return { action: "allow" };
			}
			recordRead() {}
			recordWritten() {}
			noteCreatedFile() {}
			getReadHistory() {
				return [];
			}
			getEditHistory() {
				return [];
			}
			addExemption() {}
			getSummary() {
				return {
					totalEdits: 0,
					totalBlocks: 0,
					byReason: {},
					byFile: {},
					lspExpansionsHelped: 0,
				};
			}
		})(),
}));


describe("index.ts integration", () => {
	let tmpDir: string;
	let originalStartupMode: string | undefined;

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-index-int-"));
		originalStartupMode = process.env.PI_LENS_STARTUP_MODE;
		process.env.PI_LENS_STARTUP_MODE = "quick";
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		if (originalStartupMode === undefined)
			delete process.env.PI_LENS_STARTUP_MODE;
		else process.env.PI_LENS_STARTUP_MODE = originalStartupMode;
		vi.restoreAllMocks();
	});

	it("session_start handler passes working ensureTool closure into handleSessionStart", async () => {
		const ensureToolMock = vi.fn(async (name: string) => `/mock/${name}`);
		const handleSessionStartMock = vi.fn(
			async (deps: {
				ensureTool: (name: string) => Promise<string | undefined>;
			}) => {
				await expect(
					deps.ensureTool("typescript-language-server"),
				).resolves.toBe("/mock/typescript-language-server");
			},
		);

		vi.doMock("../clients/bootstrap.js", () => ({
			loadBootstrapClients: async () => ({
				metricsClient: { reset: () => {} },
				todoScanner: {},
				biomeClient: { isAvailable: () => false },
				ruffClient: { isAvailable: () => false },
				knipClient: { isAvailable: () => false },
				jscpdClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				agentBehaviorClient: {
					recordToolCall: () => {},
					formatWarnings: () => "",
				},
				complexityClient: {
					isSupportedFile: () => false,
					analyzeFile: () => null,
				},
			}),
		}));
		vi.doMock("../clients/runtime-session.js", () => ({
			handleSessionStart: handleSessionStartMock,
		}));
		vi.doMock("../clients/installer/index.js", () => ({
			ensureTool: ensureToolMock,
		}));

		const { default: registerExtension } = await import("../index.ts");
		const { pi, handlers } = createMockPi();
		registerExtension(pi as any);

		const sessionStart = handlers.session_start?.[0];
		expect(sessionStart).toBeTypeOf("function");

		await sessionStart?.({}, { cwd: tmpDir, ui: { notify: vi.fn() } });

		expect(handleSessionStartMock).toHaveBeenCalledTimes(1);
		expect(ensureToolMock).toHaveBeenCalledWith("typescript-language-server");
	}, INTEGRATION_TIMEOUT_MS);

	it("session_shutdown uses fast LSP reset so teardown does not wait on graceful shutdown", async () => {
		const resetLSPService = vi.fn();
		vi.doMock("../clients/lsp/index.js", () => ({
			getLSPService: () => ({
				touchFile: vi.fn(),
				getAliveClientCount: () => 0,
				getAliveServerIds: () => [],
			}),
			resetLSPService,
		}));

		const { default: registerExtension } = await import("../index.ts");
		const { pi, handlers } = createMockPi();
		registerExtension(pi as any);

		const shutdown = handlers.session_shutdown?.[0];
		expect(shutdown).toBeTypeOf("function");
		shutdown?.({ reason: "quit" }, { cwd: tmpDir });
		// processExiting:true is required alongside fast — at session_shutdown the
		// event loop is closing, so killProcessTree must terminate via the held
		// handle instead of spawning taskkill (Windows libuv abort, #234 / caf2ee8).
		expect(resetLSPService).toHaveBeenCalledWith({
			fast: true,
			processExiting: true,
		});
	}, INTEGRATION_TIMEOUT_MS);

	it("idle LSP reset repaints the footer to Inactive (detached 240s timer)", async () => {
		// The idle reset releases the warm servers from a detached timer with no pi
		// event in flight; without the wrapped reset the footer would keep showing a
		// stale "LSP Active" until the next turn. Assert the timer firing repaints it.
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
		registerExtension(pi as any);

		const turnEnd = handlers.turn_end?.[0];
		expect(turnEnd).toBeTypeOf("function");

		const statusUpdates: Array<[string, string | undefined]> = [];
		const ctx = {
			cwd: tmpDir,
			ui: {
				notify: vi.fn(),
				setStatus: (id: string, text: string | undefined) =>
					statusUpdates.push([id, text]),
				// identity theme so the asserted strings are the raw labels
				theme: { fg: (_c: string, s: string) => s },
			},
		};
		const lspStatuses = () =>
			statusUpdates.filter(([id]) => id === "pi-lens-lsp").map(([, t]) => t);

		vi.useFakeTimers();
		try {
			// turn_end with no modified files → schedules the 240s idle reset and
			// repaints the footer to the live state ("Active"), without resetting yet.
			await turnEnd?.({}, ctx);
			expect(lspStatuses().at(-1)).toBe("LSP Active: typescript");
			expect(resetLSPService).not.toHaveBeenCalled();

			// 240s of total idle (no further turns) → the detached timer fires the
			// wrapped reset, which releases the servers AND repaints to "Inactive".
			await vi.advanceTimersByTimeAsync(240_000);
			expect(resetLSPService).toHaveBeenCalledTimes(1);
			expect(lspStatuses().at(-1)).toBe("LSP Inactive");
		} finally {
			vi.useRealTimers();
		}
	}, INTEGRATION_TIMEOUT_MS);

	it("context handler prepends injected guidance before the user prompt", async () => {
		const { default: registerExtension } = await import("../index.ts");
		const { pi, handlers } = createMockPi();
		registerExtension(pi as any);

		const cacheManager = new CacheManager(false);
		cacheManager.writeCache(
			"session-start-guidance",
			{ content: "Use pi-lens tools when useful." },
			tmpDir,
		);

		const context = handlers.context?.[0];
		expect(context).toBeTypeOf("function");

		const userMessage = { role: "user", content: "Fix the bug" };
		const result = await context?.(
			{ messages: [userMessage] },
			{ cwd: tmpDir },
		);

		expect(result).toEqual({
			messages: [
				expect.objectContaining({
					role: "user",
					content: expect.stringContaining(
						"[pi-lens automated context — not a user request]",
					),
				}),
				userMessage,
			],
		});
	}, INTEGRATION_TIMEOUT_MS);

	it("tool_call records full-file reads from read.path with full line coverage", async () => {
		const recordRead = vi.fn();
		const mockReadGuard = {
			recordRead,
			getReadHistory: () => [],
			isNewFile: () => false,
			noteCreatedFile: () => {},
			recordWritten: () => {},
			checkEdit: () => ({ action: "allow" as const }),
		};
		const sourceFile = path.join(tmpDir, "src", "full-read.ts");
		fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
		fs.writeFileSync(sourceFile, "one\ntwo\nthree\nfour\nfive\n");

		vi.doMock("../clients/runtime-coordinator.js", () => ({
			RuntimeCoordinator: class {
				projectRoot = tmpDir;
				turnIndex = 0;
				complexityBaselines = new Map();
				cachedExports = new Map();
				readGuard = mockReadGuard;
				shouldWarmLspOnRead() {
					return true;
				}
				markLspReadWarmStarted() {}
				markLspReadWarmCompleted() {}
				clearLspReadWarmState() {}
				nextWriteIndex() {
					return 1;
				}
				peekWriteIndex() {
					return 1;
				}
				beginTurn() {}
				resetForSession() {}
				setTelemetryIdentity() {}
				telemetrySessionId = "test-session";
			},
		}));
		vi.doMock("../clients/bootstrap.js", () => ({
			loadBootstrapClients: async () => ({
				metricsClient: { reset: () => {} },
				todoScanner: {},
				biomeClient: { isAvailable: () => false },
				ruffClient: { isAvailable: () => false },
				knipClient: { isAvailable: () => false },
				jscpdClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				agentBehaviorClient: {
					recordToolCall: () => {},
					formatWarnings: () => "",
				},
				complexityClient: {
					isSupportedFile: () => false,
					analyzeFile: () => null,
				},
			}),
		}));

		const { default: registerExtension } = await import("../index.ts");
		const { pi, handlers } = createMockPi({ "no-lsp": true });
		registerExtension(pi as any);

		const toolCall = handlers.tool_call?.[0];
		expect(toolCall).toBeTypeOf("function");

		await toolCall?.(
			{
				toolName: "read",
				input: {
					path: sourceFile,
				},
			},
			{ cwd: tmpDir },
		);

		expect(recordRead).toHaveBeenCalledTimes(1);
		expect(recordRead).toHaveBeenCalledWith(
			expect.objectContaining({
				filePath: sourceFile,
				requestedOffset: 1,
				requestedLimit: 6,
				effectiveOffset: 1,
				effectiveLimit: 6,
			}),
		);
	}, INTEGRATION_TIMEOUT_MS);

	it("tool_call auto-patches safe indentation-only oldText before read-guard edit checks", async () => {
		const checkEdit = vi.fn(() => ({ action: "allow" as const }));
		const sourceFile = path.join(tmpDir, "src", "indent-edit.ts");
		fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
		fs.writeFileSync(sourceFile, "function foo() {\n\treturn 1;\n}\n");

		vi.doMock("../clients/runtime-coordinator.js", () => ({
			RuntimeCoordinator: class {
				projectRoot = tmpDir;
				turnIndex = 0;
				complexityBaselines = new Map();
				cachedExports = new Map();
				readGuard = {
					recordRead: () => {},
					getReadHistory: () => [],
					isNewFile: () => false,
					noteCreatedFile: () => {},
					recordWritten: () => {},
					checkEdit,
				};
				shouldWarmLspOnRead() {
					return false;
				}
				markLspReadWarmStarted() {}
				markLspReadWarmCompleted() {}
				clearLspReadWarmState() {}
				nextWriteIndex() {
					return 1;
				}
				peekWriteIndex() {
					return 1;
				}
				beginTurn() {}
				resetForSession() {}
				setTelemetryIdentity() {}
				telemetrySessionId = "test-session";
			},
		}));
		vi.doMock("../clients/bootstrap.js", () => ({
			loadBootstrapClients: async () => ({
				metricsClient: { reset: () => {} },
				todoScanner: {},
				biomeClient: { isAvailable: () => false },
				ruffClient: { isAvailable: () => false },
				knipClient: { isAvailable: () => false },
				jscpdClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				agentBehaviorClient: {
					recordToolCall: () => {},
					formatWarnings: () => "",
				},
				complexityClient: {
					isSupportedFile: () => false,
					analyzeFile: () => null,
				},
			}),
		}));

		const { default: registerExtension } = await import("../index.ts");
		const { pi, handlers } = createMockPi({ "no-lsp": true });
		registerExtension(pi as any);

		const toolCall = handlers.tool_call?.[0];
		expect(toolCall).toBeTypeOf("function");

		const event = {
			toolName: "edit",
			input: {
				path: sourceFile,
				edits: [
					{
						oldText: "function foo() {\n    return 1;\n}",
						newText: "function foo() {\n    return 2;\n}",
					},
				],
			},
		};
		const result = await toolCall?.(event, { cwd: tmpDir });

		expect(result).toBeUndefined();
		expect(event.input.edits[0].oldText).toBe(
			"function foo() {\n\treturn 1;\n}",
		);
		expect(event.input.edits[0].newText).toBe(
			"function foo() {\n\treturn 2;\n}",
		);
		expect(checkEdit).toHaveBeenCalled();
	}, INTEGRATION_TIMEOUT_MS);

	it("tool_call auto-patches all safe indentation-only oldText entries in multi-edit calls", async () => {
		const checkEdit = vi.fn(() => ({ action: "allow" as const }));
		const sourceFile = path.join(tmpDir, "src", "indent-multi-edit.ts");
		fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
		fs.writeFileSync(
			sourceFile,
			"function foo() {\n\treturn 1;\n}\n\nfunction bar() {\n\treturn 2;\n}\n",
		);

		vi.doMock("../clients/runtime-coordinator.js", () => ({
			RuntimeCoordinator: class {
				projectRoot = tmpDir;
				turnIndex = 0;
				complexityBaselines = new Map();
				cachedExports = new Map();
				readGuard = {
					recordRead: () => {},
					getReadHistory: () => [],
					isNewFile: () => false,
					noteCreatedFile: () => {},
					recordWritten: () => {},
					checkEdit,
				};
				shouldWarmLspOnRead() {
					return false;
				}
				markLspReadWarmStarted() {}
				markLspReadWarmCompleted() {}
				clearLspReadWarmState() {}
				nextWriteIndex() {
					return 1;
				}
				peekWriteIndex() {
					return 1;
				}
				beginTurn() {}
				resetForSession() {}
				setTelemetryIdentity() {}
				telemetrySessionId = "test-session";
			},
		}));
		vi.doMock("../clients/bootstrap.js", () => ({
			loadBootstrapClients: async () => ({
				metricsClient: { reset: () => {} },
				todoScanner: {},
				biomeClient: { isAvailable: () => false },
				ruffClient: { isAvailable: () => false },
				knipClient: { isAvailable: () => false },
				jscpdClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				agentBehaviorClient: {
					recordToolCall: () => {},
					formatWarnings: () => "",
				},
				complexityClient: {
					isSupportedFile: () => false,
					analyzeFile: () => null,
				},
			}),
		}));

		const { default: registerExtension } = await import("../index.ts");
		const { pi, handlers } = createMockPi({ "no-lsp": true });
		registerExtension(pi as any);

		const toolCall = handlers.tool_call?.[0];
		expect(toolCall).toBeTypeOf("function");

		const event = {
			toolName: "edit",
			input: {
				path: sourceFile,
				edits: [
					{
						oldText: "function foo() {\n    return 1;\n}",
						newText: "function foo() {\n    return 10;\n}",
					},
					{
						oldText: "function bar() {\n    return 2;\n}",
						newText: "function bar() {\n    return 20;\n}",
					},
				],
			},
		};
		const result = await toolCall?.(event, { cwd: tmpDir });

		expect(result).toBeUndefined();
		expect(event.input.edits[0].oldText).toBe(
			"function foo() {\n\treturn 1;\n}",
		);
		expect(event.input.edits[1].oldText).toBe(
			"function bar() {\n\treturn 2;\n}",
		);
		expect(event.input.edits[0].newText).toBe(
			"function foo() {\n\treturn 10;\n}",
		);
		expect(event.input.edits[1].newText).toBe(
			"function bar() {\n\treturn 20;\n}",
		);
		expect(checkEdit).toHaveBeenCalled();
	}, INTEGRATION_TIMEOUT_MS);

	it("tool_call only warms LSP on the first read until warm state is cleared", async () => {
		const touchFileMock = vi.fn().mockResolvedValue([]);
		const shouldWarmLspOnRead = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(true);
		const markLspReadWarmStarted = vi.fn();
		const markLspReadWarmCompleted = vi.fn();
		const clearLspReadWarmState = vi.fn();
		const sourceFile = path.join(tmpDir, "src", "warm-read.ts");
		fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
		fs.writeFileSync(sourceFile, "export const value = 1;\n");

		vi.doMock("../clients/runtime-coordinator.js", () => ({
			RuntimeCoordinator: class {
				projectRoot = tmpDir;
				turnIndex = 0;
				complexityBaselines = new Map();
				cachedExports = new Map();
				readGuard = {
					recordRead: () => {},
					getReadHistory: () => [],
					isNewFile: () => false,
					noteCreatedFile: () => {},
					recordWritten: () => {},
					checkEdit: () => ({ action: "allow" as const }),
				};
				shouldWarmLspOnRead = shouldWarmLspOnRead;
				markLspReadWarmStarted = markLspReadWarmStarted;
				markLspReadWarmCompleted = markLspReadWarmCompleted;
				clearLspReadWarmState = clearLspReadWarmState;
				nextWriteIndex() {
					return 1;
				}
				peekWriteIndex() {
					return 1;
				}
				beginTurn() {}
				resetForSession() {}
				setTelemetryIdentity() {}
				telemetrySessionId = "test-session";
			},
		}));
		vi.doMock("../clients/bootstrap.js", () => ({
			loadBootstrapClients: async () => ({
				metricsClient: { reset: () => {} },
				todoScanner: {},
				biomeClient: { isAvailable: () => false },
				ruffClient: { isAvailable: () => false },
				knipClient: { isAvailable: () => false },
				jscpdClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				agentBehaviorClient: {
					recordToolCall: () => {},
					formatWarnings: () => "",
				},
				complexityClient: {
					isSupportedFile: () => false,
					analyzeFile: () => null,
				},
			}),
		}));
		vi.doMock("../clients/lsp/index.js", async () => ({
			getLSPService: () => ({ touchFile: touchFileMock }),
		}));

		const { default: registerExtension } = await import("../index.ts");
		const { pi, handlers } = createMockPi({ "no-lsp": false });
		registerExtension(pi as any);

		const toolCall = handlers.tool_call?.[0];
		expect(toolCall).toBeTypeOf("function");

		for (let i = 0; i < 3; i += 1) {
			await toolCall?.(
				{
					toolName: "read",
					input: {
						path: sourceFile,
					},
				},
				{ cwd: tmpDir },
			);
			await Promise.resolve();
		}

		expect(shouldWarmLspOnRead).toHaveBeenCalledTimes(3);
		expect(touchFileMock).toHaveBeenCalledTimes(2);
		expect(markLspReadWarmStarted).toHaveBeenCalledTimes(2);
		expect(markLspReadWarmCompleted).toHaveBeenCalledTimes(2);
		expect(clearLspReadWarmState).not.toHaveBeenCalled();
	}, INTEGRATION_TIMEOUT_MS);

	it("tool_call does not warm LSP for unknown non-code file kinds", async () => {
		const touchFileMock = vi.fn().mockResolvedValue(undefined);
		const shouldWarmLspOnRead = vi.fn();
		const notesFile = path.join(tmpDir, "notes", "stderr.txt");
		fs.mkdirSync(path.dirname(notesFile), { recursive: true });
		fs.writeFileSync(notesFile, "plain text\n");

		vi.doMock("../clients/runtime-coordinator.js", () => ({
			RuntimeCoordinator: class {
				projectRoot = tmpDir;
				turnIndex = 0;
				complexityBaselines = new Map();
				cachedExports = new Map();
				readGuard = {
					recordRead: () => {},
					getReadHistory: () => [],
					isNewFile: () => false,
					noteCreatedFile: () => {},
					recordWritten: () => {},
					checkEdit: () => ({ action: "allow" as const }),
				};
				shouldWarmLspOnRead = shouldWarmLspOnRead;
				markLspReadWarmStarted() {}
				markLspReadWarmCompleted() {}
				clearLspReadWarmState() {}
				nextWriteIndex() {
					return 1;
				}
				peekWriteIndex() {
					return 1;
				}
				beginTurn() {}
				resetForSession() {}
				setTelemetryIdentity() {}
				telemetrySessionId = "test-session";
			},
		}));
		vi.doMock("../clients/bootstrap.js", () => ({
			loadBootstrapClients: async () => ({
				metricsClient: { reset: () => {} },
				todoScanner: {},
				biomeClient: { isAvailable: () => false },
				ruffClient: { isAvailable: () => false },
				knipClient: { isAvailable: () => false },
				jscpdClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				agentBehaviorClient: {
					recordToolCall: () => {},
					formatWarnings: () => "",
				},
				complexityClient: {
					isSupportedFile: () => false,
					analyzeFile: () => null,
				},
			}),
		}));
		vi.doMock("../clients/lsp/index.js", async () => ({
			getLSPService: () => ({ touchFile: touchFileMock }),
		}));

		const { default: registerExtension } = await import("../index.ts");
		const { pi, handlers } = createMockPi({ "no-lsp": false });
		registerExtension(pi as any);

		const toolCall = handlers.tool_call?.[0];
		expect(toolCall).toBeTypeOf("function");

		await toolCall?.(
			{
				toolName: "read",
				input: {
					path: notesFile,
				},
			},
			{ cwd: tmpDir },
		);
		await Promise.resolve();

		expect(shouldWarmLspOnRead).not.toHaveBeenCalled();
		expect(touchFileMock).not.toHaveBeenCalled();
	}, INTEGRATION_TIMEOUT_MS);

	it("tool_call does not warm LSP for internal support artifacts", async () => {
		const touchFileMock = vi.fn().mockResolvedValue(undefined);
		const shouldWarmLspOnRead = vi.fn();
		const turnStateFile = path.join(tmpDir, ".pi-lens", "turn-state.json");
		fs.mkdirSync(path.dirname(turnStateFile), { recursive: true });
		fs.writeFileSync(turnStateFile, '{"files":{}}\n');

		vi.doMock("../clients/runtime-coordinator.js", () => ({
			RuntimeCoordinator: class {
				projectRoot = tmpDir;
				turnIndex = 0;
				complexityBaselines = new Map();
				cachedExports = new Map();
				readGuard = {
					recordRead: () => {},
					getReadHistory: () => [],
					isNewFile: () => false,
					noteCreatedFile: () => {},
					recordWritten: () => {},
					checkEdit: () => ({ action: "allow" as const }),
				};
				shouldWarmLspOnRead = shouldWarmLspOnRead;
				markLspReadWarmStarted() {}
				markLspReadWarmCompleted() {}
				clearLspReadWarmState() {}
				nextWriteIndex() {
					return 1;
				}
				peekWriteIndex() {
					return 1;
				}
				beginTurn() {}
				resetForSession() {}
				setTelemetryIdentity() {}
				telemetrySessionId = "test-session";
			},
		}));
		vi.doMock("../clients/bootstrap.js", () => ({
			loadBootstrapClients: async () => ({
				metricsClient: { reset: () => {} },
				todoScanner: {},
				biomeClient: { isAvailable: () => false },
				ruffClient: { isAvailable: () => false },
				knipClient: { isAvailable: () => false },
				jscpdClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				agentBehaviorClient: {
					recordToolCall: () => {},
					formatWarnings: () => "",
				},
				complexityClient: {
					isSupportedFile: () => false,
					analyzeFile: () => null,
				},
			}),
		}));
		vi.doMock("../clients/lsp/index.js", async () => ({
			getLSPService: () => ({ touchFile: touchFileMock }),
		}));

		const { default: registerExtension } = await import("../index.ts");
		const { pi, handlers } = createMockPi({ "no-lsp": false });
		registerExtension(pi as any);

		const toolCall = handlers.tool_call?.[0];
		expect(toolCall).toBeTypeOf("function");

		await toolCall?.(
			{
				toolName: "read",
				input: {
					path: turnStateFile,
				},
			},
			{ cwd: tmpDir },
		);
		await Promise.resolve();

		expect(shouldWarmLspOnRead).not.toHaveBeenCalled();
		expect(touchFileMock).not.toHaveBeenCalled();
	}, INTEGRATION_TIMEOUT_MS);

	it("lens-health command reports crash, latency, diagnostics, and slop telemetry", async () => {
		vi.doMock("../clients/runtime-coordinator.js", () => ({
			RuntimeCoordinator: class {
				projectRoot = tmpDir;
				getCrashEntries() {
					return [[path.join(tmpDir, "src", "boom.ts"), 3]];
				}
				beginTurn() {}
				resetForSession() {}
				complexityBaselines = new Map();
				projectRulesScan = { hasCustomRules: false, rules: [] };
				cachedExports = new Map();
				errorDebtBaseline = null;
				sessionStartedAt = Date.now() - 5 * 60_000;
				readGuard = {
					isNewFile: () => false,
					noteCreatedFile: () => {},
					recordWritten: () => {},
					checkEdit: () => ({ action: "allow" }),
					recordRead: () => {},
				};
			},
		}));
		vi.doMock("../clients/lsp/index.js", () => ({
			getLSPService: () => ({
				getAliveClientCount: () => 1,
				getAliveServerIds: () => ["typescript"],
				getStatus: () => [
					{ serverId: "typescript", root: tmpDir, connected: true },
				],
				touchFile: vi.fn(),
				resetLSPService: () => {},
			}),
			resetLSPService: () => {},
		}));
		vi.doMock("../clients/dispatch/integration.js", async () => ({
			getDispatchSlopScoreLine: () => "Slop score: 12/100",
			getLatencyReports: () => [
				{
					filePath: path.join(tmpDir, "src", "boom.ts"),
					totalDurationMs: 321,
					totalDiagnostics: 4,
					runners: [
						{ runnerId: "lsp", durationMs: 200, status: "failed" },
						{ runnerId: "tree-sitter", durationMs: 90, status: "succeeded" },
						{ runnerId: "eslint", durationMs: 31, status: "succeeded" },
					],
				},
			],
			getCascadeSessionStats: () => ({
				runs: 5,
				diagnosticsSurfaced: 3,
				coldSnapshotTouches: 2,
			}),
			resetDispatchBaselines: () => {},
		}));
		vi.doMock("../clients/diagnostic-tracker.js", async () => ({
			getDiagnosticTracker: () => ({
				reset: () => {},
				getStats: () => ({
					totalShown: 8,
					totalAutoFixed: 2,
					totalAgentFixed: 1,
					totalUnresolved: 5,
					repeatOffenders: [
						{
							filePath: path.join(tmpDir, "src", "boom.ts"),
							line: 7,
							ruleId: "no-debugger",
							count: 3,
						},
					],
					topViolations: [
						{
							ruleId: "no-console",
							count: 6,
							samplePaths: [path.join(tmpDir, "src", "boom.ts")],
						},
					],
				}),
			}),
		}));
		vi.doMock("../clients/bootstrap.js", () => ({
			loadBootstrapClients: async () => ({
				metricsClient: { reset: () => {} },
				todoScanner: {},
				biomeClient: { isAvailable: () => false },
				ruffClient: { isAvailable: () => false },
				knipClient: { isAvailable: () => false },
				jscpdClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				agentBehaviorClient: {
					recordToolCall: () => {},
					formatWarnings: () => "",
				},
				complexityClient: {
					isSupportedFile: () => false,
					analyzeFile: () => null,
				},
			}),
		}));

		const { default: registerExtension } = await import("../index.ts");
		const { pi, commands } = createMockPi();
		registerExtension(pi as any);

		const notify = vi.fn();
		const lensHealth = commands.get("lens-health");
		expect(lensHealth?.handler).toBeTypeOf("function");

		await lensHealth?.handler?.({}, { ui: { notify } });

		expect(notify).toHaveBeenCalledTimes(1);
		const [message, level] = notify.mock.calls[0];
		expect(level).toBe("info");
		expect(message).toContain("🩺 PI-LENS HEALTH");
		expect(message).toContain("Pipeline crashes (session): 3");
		expect(message).toContain("Top crash files:");
		expect(message).toContain("boom.ts: 3");
		expect(message).toContain("Last dispatch: boom.ts (321ms, 4 diagnostics)");
		expect(message).toContain("lsp: 200ms (failed)");
		expect(message).toContain("Diagnostics shown: 8");
		expect(message).toContain("Auto-fixed: 2");
		expect(message).toContain("Agent-fixed: 1");
		expect(message).toContain("Unresolved carryover: 5");
		expect(message).toContain("Repeat offenders:");
		expect(message).toContain("boom.ts:7 no-debugger (3x)");
		expect(message).toContain("Top noisy rules:");
		expect(message).toContain("no-console: 6 (e.g. src/boom.ts)");
		expect(message).toContain("Slop score: 12/100");
		expect(message).toContain("Session started:");
		expect(message).toContain("LSP servers:");
		expect(message).toContain("✓ typescript");
		expect(message).toContain("Cascade runs: 5");
		expect(message).toContain("Cascade diagnostics surfaced: 3");
		expect(message).toContain("Cold-snapshot touches: 2");
	}, INTEGRATION_TIMEOUT_MS);
});
