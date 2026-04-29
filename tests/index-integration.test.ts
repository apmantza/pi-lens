import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

type Handler = (event: any, ctx: any) => unknown;

interface MockPi {
	registerTool: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	registerFlag: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	getFlag: ReturnType<typeof vi.fn>;
}

function createMockPi(flagOverrides: Record<string, boolean> = {}): {
	pi: MockPi;
	handlers: Record<string, Handler[]>;
	commands: Map<string, { handler?: Handler; description?: string }>;
} {
	const handlers: Record<string, Handler[]> = {};
	const commands = new Map<
		string,
		{ handler?: Handler; description?: string }
	>();
	const flags = new Map<string, boolean>([
		["lens-lsp", true],
		["no-lsp", false],
		["lens-guard", false],
		...Object.entries(flagOverrides),
	]);

	const pi: MockPi = {
		registerTool: vi.fn(),
		registerCommand: vi.fn(
			(name: string, config: { handler?: Handler; description?: string }) => {
				commands.set(name, config);
			},
		),
		registerFlag: vi.fn((name: string, config: { default?: boolean }) => {
			if (!flags.has(name) && typeof config?.default === "boolean") {
				flags.set(name, config.default);
			}
		}),
		on: vi.fn((event: string, handler: Handler) => {
			(handlers[event] ??= []).push(handler);
		}),
		getFlag: vi.fn((name: string) => flags.get(name) ?? false),
	};

	return { pi, handlers, commands };
}

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
				typeCoverageClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailable: () => false },
				rustClient: { isAvailable: () => false },
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
	}, 15_000);

	it("tool_call handler executes captureSnapshot and similarity paths without crashing", async () => {
		const captureSnapshotMock = vi.fn();
		const touchFileMock = vi.fn().mockResolvedValue(undefined);
		const sourceFile = path.join(tmpDir, "src", "feature.ts");
		const similarTarget = path.join(tmpDir, "src", "existing.ts");
		fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
		fs.writeFileSync(
			sourceFile,
			"export function freshFeature() { return 1; }\n",
		);
		fs.writeFileSync(
			similarTarget,
			"export function oldFeature() { return 2; }\n",
		);

		vi.doMock("../clients/bootstrap.js", () => ({
			loadBootstrapClients: async () => ({
				metricsClient: { reset: () => {} },
				todoScanner: {},
				biomeClient: { isAvailable: () => false },
				ruffClient: { isAvailable: () => false },
				knipClient: { isAvailable: () => false },
				jscpdClient: { isAvailable: () => false },
				typeCoverageClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailable: () => false },
				rustClient: { isAvailable: () => false },
				agentBehaviorClient: {
					recordToolCall: () => {},
					formatWarnings: () => "",
				},
				complexityClient: {
					isSupportedFile: () => true,
					analyzeFile: () => ({
						maintainabilityIndex: 88,
						cognitiveComplexity: 3,
						maxNestingDepth: 1,
						linesOfCode: 10,
						maxCyclomaticComplexity: 2,
						codeEntropy: 1.2,
					}),
				},
			}),
		}));
		vi.doMock("../clients/runtime-session.js", () => ({
			handleSessionStart: async (deps: any) => {
				deps.runtime.projectRoot = tmpDir;
				deps.runtime.cachedExports.set("otherExport", similarTarget);
				deps.runtime.cachedProjectIndex = {
					entries: new Map([["existing", { id: "existing" }]]),
				};
			},
		}));
		vi.doMock("../clients/metrics-history.js", () => ({
			captureSnapshot: captureSnapshotMock,
		}));
		vi.doMock("../clients/lsp/index.js", async () => {
			const actual = await vi.importActual<
				typeof import("../clients/lsp/index.js")
			>("../clients/lsp/index.js");
			return {
				...actual,
				getLSPService: () => ({ touchFile: touchFileMock }),
			};
		});
		vi.doMock("../clients/dispatch/runners/similarity.js", async () => {
			const actual = await vi.importActual<
				typeof import("../clients/dispatch/runners/similarity.js")
			>("../clients/dispatch/runners/similarity.js");
			const ts = await import("typescript");
			return {
				...actual,
				extractFunctions: () => [
					{
						name: "freshFeature",
						transitionCount: 42,
						matrix: [[1]],
						kind: ts.SyntaxKind.FunctionDeclaration,
					},
				],
			};
		});
		vi.doMock("../clients/project-index.js", async () => {
			const actual = await vi.importActual<
				typeof import("../clients/project-index.js")
			>("../clients/project-index.js");
			return {
				...actual,
				findSimilarFunctions: () => [
					{
						targetId: `src/existing.ts:oldFeature`,
						targetName: "oldFeature",
						targetLocation: similarTarget + ":1",
						similarity: 0.95,
						signature: "() => number",
						targetTransitionCount: 42,
					},
				],
			};
		});

		const { default: registerExtension } = await import("../index.ts");
		const { pi, handlers } = createMockPi({
			"lens-lsp": true,
			"no-lsp": false,
		});
		registerExtension(pi as any);

		const notify = vi.fn();
		await handlers.session_start?.[0]?.({}, { cwd: tmpDir, ui: { notify } });

		const toolCall = handlers.tool_call?.[0];
		expect(toolCall).toBeTypeOf("function");

		const result = await toolCall?.(
			{
				toolName: "write",
				input: {
					path: sourceFile,
					content: "export function freshFeature() { return 1; }\n",
				},
			},
			{ cwd: tmpDir },
		);

		expect(captureSnapshotMock).toHaveBeenCalledTimes(1);
		expect(captureSnapshotMock).toHaveBeenCalledWith(
			sourceFile,
			expect.objectContaining({
				maintainabilityIndex: 88,
				cognitiveComplexity: 3,
				maxNestingDepth: 1,
				linesOfCode: 10,
				maxCyclomatic: 2,
				entropy: 1.2,
			}),
		);
		expect(touchFileMock).toHaveBeenCalled();
		expect(result).toEqual(
			expect.objectContaining({
				block: false,
				reason: expect.stringContaining("Potential structural similarity"),
			}),
		);
	}, 15_000);

	it("tool_call records full-file reads from read.path with full line coverage", async () => {
		const recordRead = vi.fn();
		const mockReadGuard = {
			recordRead,
			getReadHistory: () => [],
			isNewFile: () => false,
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
				cachedProjectIndex = null;
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
				typeCoverageClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailable: () => false },
				rustClient: { isAvailable: () => false },
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
	}, 15_000);

	it("tool_call only warms LSP on the first read until warm state is cleared", async () => {
		const touchFileMock = vi.fn().mockResolvedValue(undefined);
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
				cachedProjectIndex = null;
				readGuard = {
					recordRead: () => {},
					getReadHistory: () => [],
					isNewFile: () => false,
					checkEdit: () => ({ action: "allow" as const }),
				};
				shouldWarmLspOnRead = shouldWarmLspOnRead;
				markLspReadWarmStarted = markLspReadWarmStarted;
				markLspReadWarmCompleted = markLspReadWarmCompleted;
				clearLspReadWarmState = clearLspReadWarmState;
				nextWriteIndex() {
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
				typeCoverageClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailable: () => false },
				rustClient: { isAvailable: () => false },
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
	}, 15_000);

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
				cachedProjectIndex = null;
				readGuard = {
					recordRead: () => {},
					getReadHistory: () => [],
					isNewFile: () => false,
					checkEdit: () => ({ action: "allow" as const }),
				};
				shouldWarmLspOnRead = shouldWarmLspOnRead;
				markLspReadWarmStarted() {}
				markLspReadWarmCompleted() {}
				clearLspReadWarmState() {}
				nextWriteIndex() {
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
				typeCoverageClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailable: () => false },
				rustClient: { isAvailable: () => false },
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
	}, 15_000);

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
				cachedProjectIndex = null;
				readGuard = {
					recordRead: () => {},
					getReadHistory: () => [],
					isNewFile: () => false,
					checkEdit: () => ({ action: "allow" as const }),
				};
				shouldWarmLspOnRead = shouldWarmLspOnRead;
				markLspReadWarmStarted() {}
				markLspReadWarmCompleted() {}
				clearLspReadWarmState() {}
				nextWriteIndex() {
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
				typeCoverageClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailable: () => false },
				rustClient: { isAvailable: () => false },
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
	}, 15_000);

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
				cachedProjectIndex = null;
				errorDebtBaseline = null;
				readGuard = {
					isNewFile: () => false,
					checkEdit: () => ({ action: "allow" }),
					recordRead: () => {},
				};
			},
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
				typeCoverageClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailable: () => false },
				rustClient: { isAvailable: () => false },
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
	}, 15_000);
});
