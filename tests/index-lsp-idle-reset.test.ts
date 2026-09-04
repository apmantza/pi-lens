import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetSubagentModeForTests } from "../clients/subagent-mode.js";
import { getEffectiveLspIdleResetMs } from "../clients/runtime-turn.js";
import { createPiMock } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import { makeLspServiceDouble } from "./support/lsp-service-double.js";

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

vi.mock("../clients/read-guard.js", () => {
	class MockReadGuard {
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
	}

	return {
		ReadGuard: MockReadGuard,
		createReadGuard: () => new MockReadGuard(),
	};
});

describe("index.ts LSP idle reset", () => {
	let tmpDir: string;
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-idle-reset-"));
		vi.stubEnv("PI_LENS_STARTUP_MODE", "quick");
	});

	afterEach(() => {
		removeTempDirSync(tmpDir);
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it(
		"does not touch a stale event ctx when the detached idle timer fires",
		async () => {
			let aliveIds: string[] = ["typescript"];
			const resetLSPService = vi.fn(() => {
				aliveIds = [];
			});
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () =>
					makeLspServiceDouble({
						getAliveClientCount: () => aliveIds.length,
						getAliveServerIds: () => aliveIds,
					}),
				resetLSPService,
			}));
			vi.doMock("../clients/bootstrap.js", async () => {
				const { bootstrapSeamMock } =
					await import("./support/bootstrap-mock.js");
				return bootstrapSeamMock(async () => ({
					knipClient: { isAvailable: () => false },
					depChecker: { isAvailable: () => false },
					testRunnerClient: { detectRunner: () => null },
				}));
			});

			const { default: registerExtension } = await import("../index.js");
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
						throw new Error(
							"This extension ctx is stale after session replacement",
						);
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

				await vi.advanceTimersByTimeAsync(getEffectiveLspIdleResetMs());

				expect(resetLSPService).toHaveBeenCalledTimes(1);
				expect(lspStatuses().at(-1)).toBe("LSP Inactive");
			} finally {
				vi.useRealTimers();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	// #713: subagent light mode uses a shorter idle reset than a normal
	// session. #1618 (R4): that shortened delay is now ALSO derived against
	// the sweep's own wall-clock ceiling (`getEffectiveLspIdleResetMs` floors
	// it at `FULL_SCAN_WALL_CLOCK_MS + margin`), so under the DEFAULT 300s
	// ceiling the "shortened" and "normal" delays would collide (both floor
	// at 360s) and this test would prove nothing. Override the ceiling down
	// to isolate the #713 behavior this test actually targets: the subagent
	// path stays shorter than the base path when the sweep ceiling is small.
	it(
		"subagent session fires the idle reset sooner than a normal session (#713, #1618)",
		async () => {
			process.env.PI_SUBAGENT_CHILD = "1";
			process.env.PI_LENS_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS = "1";
			_resetSubagentModeForTests();

			try {
				const resetLSPService = vi.fn();
				vi.doMock("../clients/lsp/index.js", () => ({
					getLSPService: () => makeLspServiceDouble(),
					resetLSPService,
				}));
				vi.doMock("../clients/bootstrap.js", async () => {
					const { bootstrapSeamMock } =
						await import("./support/bootstrap-mock.js");
					return bootstrapSeamMock(async () => ({
						knipClient: { isAvailable: () => false },
						depChecker: { isAvailable: () => false },
						testRunnerClient: { detectRunner: () => null },
					}));
				});

				const { default: registerExtension } = await import("../index.js");
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

				const expectedMs = getEffectiveLspIdleResetMs();
				// Still meaningfully shorter than the base 240s floor — proves the
				// subagent classification is actually taking effect, not just
				// coincidentally matching the derived floor.
				expect(expectedMs).toBeLessThan(240_000);

				vi.useFakeTimers();
				try {
					await turnEnd?.({}, ctx);

					await vi.advanceTimersByTimeAsync(expectedMs - 1);
					expect(resetLSPService).not.toHaveBeenCalled();

					await vi.advanceTimersByTimeAsync(1);
					expect(resetLSPService).toHaveBeenCalledTimes(1);
				} finally {
					vi.useRealTimers();
				}
			} finally {
				delete process.env.PI_SUBAGENT_CHILD;
				delete process.env.PI_LENS_LENS_DIAGNOSTICS_FULL_TIMEOUT_MS;
				_resetSubagentModeForTests();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"normal (non-subagent) session still uses the base idle reset (#713, #1618)",
		async () => {
			// Ensure no subagent env vars are set
			delete process.env.PI_SUBAGENT_CHILD;
			delete process.env.PI_SUBAGENT_CHILD_AGENT;
			delete process.env.PI_SUBAGENT_PARENT_PID;
			_resetSubagentModeForTests();

			const resetLSPService = vi.fn();
			vi.doMock("../clients/lsp/index.js", () => ({
				getLSPService: () => makeLspServiceDouble(),
				resetLSPService,
			}));
			vi.doMock("../clients/bootstrap.js", async () => {
				const { bootstrapSeamMock } =
					await import("./support/bootstrap-mock.js");
				return bootstrapSeamMock(async () => ({
					knipClient: { isAvailable: () => false },
					depChecker: { isAvailable: () => false },
					testRunnerClient: { detectRunner: () => null },
				}));
			});

			const { default: registerExtension } = await import("../index.js");
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

				// Should NOT fire at 359s. #1618: the base idle reset is now derived
				// from `FULL_SCAN_WALL_CLOCK_MS` (300s default) plus a safety margin,
				// so it fires at 360s rather than the old flat 240s.
				await vi.advanceTimersByTimeAsync(299_000);
				expect(resetLSPService).not.toHaveBeenCalled();

				// Should fire at 360s
				await vi.advanceTimersByTimeAsync(1_000);
				expect(resetLSPService).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"PI_LENS_SUBAGENT_FULL=1 restores the base idle reset even in a subagent session (#713, #1618)",
		async () => {
			process.env.PI_SUBAGENT_CHILD = "1";
			process.env.PI_LENS_SUBAGENT_FULL = "1";
			_resetSubagentModeForTests();

			try {
				const resetLSPService = vi.fn();
				vi.doMock("../clients/lsp/index.js", () => ({
					getLSPService: () => makeLspServiceDouble(),
					resetLSPService,
				}));
				vi.doMock("../clients/bootstrap.js", async () => {
					const { bootstrapSeamMock } =
						await import("./support/bootstrap-mock.js");
					return bootstrapSeamMock(async () => ({
						knipClient: { isAvailable: () => false },
						depChecker: { isAvailable: () => false },
						testRunnerClient: { detectRunner: () => null },
					}));
				});

				const { default: registerExtension } = await import("../index.js");
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

					// Should fire at 360s (full behavior restored — #1618's derived base)
					await vi.advanceTimersByTimeAsync(300_000);
					expect(resetLSPService).toHaveBeenCalledTimes(1);
				} finally {
					vi.useRealTimers();
				}
			} finally {
				delete process.env.PI_SUBAGENT_CHILD;
				delete process.env.PI_LENS_SUBAGENT_FULL;
				_resetSubagentModeForTests();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);
});
