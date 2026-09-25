import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetSubagentModeForTests } from "../clients/subagent-mode.js";
import { getEffectiveLspIdleResetMs } from "../clients/runtime-turn.js";
import { createPiMock } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";
import {
	aliveServerHolder,
	lspStatusRecorder,
} from "./support/lsp-status-repaint.js";

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

/**
 * Shared fixture for every LSP status-repaint case (#3099): install the
 * LSP-service and bootstrap doubles, register the extension, and hand back the
 * `turn_end` handler plus a `pi-lens-lsp` status recorder. The idle-reset double
 * empties the alive set, which is what makes the second repaint observable
 * (#281).
 */
async function setupLspStatusRepaint(
	options: { flags?: Record<string, boolean> } = {},
) {
	const { resetLSPService, service } = aliveServerHolder();
	vi.doMock("../clients/lsp/index.js", () => ({
		getLSPService: service,
		resetLSPService,
	}));
	vi.doMock("../clients/bootstrap.js", async () => {
		const { bootstrapSeamMock } = await import("./support/bootstrap-mock.js");
		return bootstrapSeamMock(async () => ({
			knipClient: { isAvailable: () => false },
			depChecker: { isAvailable: () => false },
			testRunnerClient: { detectRunner: () => null },
		}));
	});

	const { default: registerExtension } = await import("../index.js");
	const { pi, handlers } = createMockPi({
		"no-lsp": false,
		...options.flags,
	});
	registerExtension(pi);

	const turnEnd = handlers.turn_end?.[0];
	expect(turnEnd).toBeTypeOf("function");

	const { ui, lspStatuses } = lspStatusRecorder();

	return { turnEnd, ui, lspStatuses, resetLSPService };
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
		// resetModules does not clear the mock registry (#2883).
		vi.doUnmock("../clients/lsp/index.js");
		vi.doUnmock("../clients/bootstrap.js");
	});

	it(
		"does not touch a stale event ctx when the detached idle timer fires",
		async () => {
			const { turnEnd, ui, lspStatuses, resetLSPService } =
				await setupLspStatusRepaint();

			let stale = false;
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

	// #3099: the opt-in compact status must reach `updateLspStatus` through the
	// real turn_end → status-repaint path, and it must render BOTH glyphs (active
	// on the turn, dim after the idle timer releases the servers). Server names
	// stay the default, which the tests above keep asserting with the flag off.
	it(
		"renders the compact LSP status glyphs when lens-compact-lsp-status is on (#3099)",
		async () => {
			const { turnEnd, ui, lspStatuses, resetLSPService } =
				await setupLspStatusRepaint({
					flags: { "lens-compact-lsp-status": true },
				});
			const ctx = { cwd: tmpDir, ui };

			vi.useFakeTimers();
			try {
				await turnEnd?.({}, ctx);
				// One glyph, not `LSP Active: typescript`.
				expect(lspStatuses().at(-1)).toBe("LSP ✓");

				await vi.advanceTimersByTimeAsync(getEffectiveLspIdleResetMs());

				expect(resetLSPService).toHaveBeenCalledTimes(1);
				expect(lspStatuses().at(-1)).toBe("LSP ✗");
			} finally {
				vi.useRealTimers();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	// #3099: the compact FAILED branch has no coverage above — that case only
	// records an idle-released active server, never a failed one. Mutating
	// `failedText`'s compact arm (`"LSP ✗"` → `"LSP ✓"`) leaves the suite
	// green without this. Drives the real turn_end → updateLspStatus path
	// with a recorded failure (`recordLsp` + `setSessionLanguages`, the same
	// seam `selectLspStatus` reads) so it observes the published string, not
	// the branch. One turn covers both states the review asked for: mixed
	// (typescript alive + python failed) while the default alive server is
	// still up, then failed-alone once the idle timer releases it.
	it(
		"renders the compact LSP status glyph for a failed server, alone and mixed with an active one (#3099)",
		async () => {
			const { turnEnd, ui, lspStatuses, resetLSPService } =
				await setupLspStatusRepaint({
					flags: { "lens-compact-lsp-status": true },
				});
			const { recordLsp, setSessionLanguages } =
				await import("../clients/widget-state.js");
			setSessionLanguages(["python"]);
			recordLsp("python", tmpDir, "spawn_failed");
			const ctx = { cwd: tmpDir, ui };

			vi.useFakeTimers();
			try {
				await turnEnd?.({}, ctx);
				// typescript alive (default) + python failed, side by side.
				expect(lspStatuses().at(-1)).toBe("LSP ✓ · LSP ✗");

				await vi.advanceTimersByTimeAsync(getEffectiveLspIdleResetMs());

				expect(resetLSPService).toHaveBeenCalledTimes(1);
				// typescript released; python's failure is all that remains, with
				// no live server to show alongside it.
				expect(lspStatuses().at(-1)).toBe("LSP ✗");
			} finally {
				vi.useRealTimers();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	// #3099: off mode publishes no status at all — `undefined`, not a dim
	// "LSP Inactive" — so a host that renders extension statuses stops showing
	// the `pi-lens-lsp` key entirely. Drives the real turn_end →
	// updateLspStatus path and asserts the published value across BOTH the
	// active turn and the idle-released repaint: neutering the guard (making
	// it a no-op) would make the first assertion see `"LSP Active: typescript"`
	// instead of `undefined`, and the second would still see a live server
	// name/dim text rather than staying `undefined` after the idle timer.
	it(
		"publishes no status at all when lens-hide-lsp-status is on, and stays unpublished across the idle repaint (#3099)",
		async () => {
			const { turnEnd, ui, lspStatuses, resetLSPService } =
				await setupLspStatusRepaint({
					flags: { "lens-hide-lsp-status": true },
				});
			const ctx = { cwd: tmpDir, ui };

			vi.useFakeTimers();
			try {
				await turnEnd?.({}, ctx);
				expect(lspStatuses().at(-1)).toBeUndefined();

				await vi.advanceTimersByTimeAsync(getEffectiveLspIdleResetMs());

				expect(resetLSPService).toHaveBeenCalledTimes(1);
				// Still unpublished after the repaint that would otherwise flip to
				// "LSP Inactive" (or its compact dim glyph) — the flag never changed.
				expect(lspStatuses().at(-1)).toBeUndefined();
			} finally {
				vi.useRealTimers();
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	// #3099: precedence — off wins when both flags are set, since there is
	// nothing left to render compactly once the key itself is gone. Mutating
	// the off-check's placement (checking compact first, or dropping the
	// early `return`) would let the compact glyph ("LSP ✓") leak out.
	it(
		"off outranks compact when both lens-hide-lsp-status and lens-compact-lsp-status are on (#3099)",
		async () => {
			const { turnEnd, ui, lspStatuses } = await setupLspStatusRepaint({
				flags: {
					"lens-hide-lsp-status": true,
					"lens-compact-lsp-status": true,
				},
			});
			const ctx = { cwd: tmpDir, ui };

			await turnEnd?.({}, ctx);
			expect(lspStatuses().at(-1)).toBeUndefined();
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
				const { turnEnd, ui, resetLSPService } = await setupLspStatusRepaint();
				const ctx = { cwd: tmpDir, ui };

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

			const { turnEnd, ui, resetLSPService } = await setupLspStatusRepaint();
			const ctx = { cwd: tmpDir, ui };

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
				const { turnEnd, ui, resetLSPService } = await setupLspStatusRepaint();
				const ctx = { cwd: tmpDir, ui };

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
