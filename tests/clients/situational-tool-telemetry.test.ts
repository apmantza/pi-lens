import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionLogEntry } from "../../clients/extension-log.js";

const logExtension = vi.hoisted(() => vi.fn());
vi.mock("../../clients/extension-log.js", () => ({ logExtension }));

import {
	emitSituationalDeadWeight,
	endSituationalToolTelemetry,
	observeSituationalToolActivation,
	observeSituationalToolCall,
	resetSituationalToolTelemetry,
	startSituationalToolTelemetrySession,
} from "../../clients/situational-tool-telemetry.js";

describe("situational dead-weight telemetry", () => {
	beforeEach(() => {
		logExtension.mockClear();
		resetSituationalToolTelemetry();
	});

	it("names the registered situational tools not activated or called", () => {
		observeSituationalToolActivation(["ast_grep_search"]);
		observeSituationalToolCall("lsp_navigation");

		emitSituationalDeadWeight();

		const entry = logExtension.mock.calls[0]?.[0] as ExtensionLogEntry;
		expect(entry).toEqual({
			subsystem: "tools",
			level: "debug",
			message: "situational tool dead weight",
			metadata: {
				tools: ["ast_grep_replace", "ast_grep_outline", "lens_diagnostic_mark"],
			},
		});
	});

	it("always emits the empty row after every situational tool was used", () => {
		observeSituationalToolActivation([
			"ast_grep_search",
			"ast_grep_replace",
			"ast_grep_outline",
			"lsp_navigation",
			"lens_diagnostic_mark",
		]);

		emitSituationalDeadWeight();

		expect(logExtension).toHaveBeenCalledWith({
			subsystem: "tools",
			level: "debug",
			message: "situational tool dead weight",
			metadata: { tools: [] },
		});
	});

	it("keeps the opener-owned latch armed for repeated emits", () => {
		startSituationalToolTelemetrySession("pi");
		emitSituationalDeadWeight();
		emitSituationalDeadWeight();

		expect(logExtension).toHaveBeenCalledTimes(1);
		endSituationalToolTelemetry();
	});

	it("preserves observations across a pi session rebuild", () => {
		startSituationalToolTelemetrySession("pi");
		observeSituationalToolActivation(["ast_grep_search"]);
		observeSituationalToolCall("ast_grep_search");
		startSituationalToolTelemetrySession("pi");
		expect(logExtension).not.toHaveBeenCalled();
		endSituationalToolTelemetry();

		expect(logExtension).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "situational tool dead weight",
				metadata: {
					tools: [
						"ast_grep_replace",
						"ast_grep_outline",
						"lsp_navigation",
						"lens_diagnostic_mark",
					],
				},
			}),
		);
	});

	it("repeated pi session_start with the same conversation is idempotent", () => {
		startSituationalToolTelemetrySession("pi");
		observeSituationalToolCall("ast_grep_search");
		startSituationalToolTelemetrySession("pi");
		endSituationalToolTelemetry();

		expect(logExtension).toHaveBeenCalledTimes(1);
		expect(logExtension.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				message: "situational tool dead weight",
				metadata: {
					tools: [
						"ast_grep_replace",
						"ast_grep_outline",
						"lsp_navigation",
						"lens_diagnostic_mark",
					],
				},
			}),
		);
	});

	it("session_shutdown quit emits and clears the pi dead-weight row", () => {
		startSituationalToolTelemetrySession("pi");
		observeSituationalToolCall("ast_grep_search");
		endSituationalToolTelemetry();
		endSituationalToolTelemetry();

		expect(logExtension).toHaveBeenCalledTimes(1);
		expect(logExtension.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				message: "situational tool dead weight",
				metadata: {
					tools: [
						"ast_grep_replace",
						"ast_grep_outline",
						"lsp_navigation",
						"lens_diagnostic_mark",
					],
				},
			}),
		);
	});
});
