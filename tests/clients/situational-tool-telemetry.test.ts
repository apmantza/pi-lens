import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionLogEntry } from "../../clients/extension-log.js";

const logExtension = vi.hoisted(() => vi.fn());
vi.mock("../../clients/extension-log.js", () => ({ logExtension }));

import {
	_observeSituationalCallForTests,
	_observeSituationalActivationForTests,
	emitSituationalDeadWeight,
	resetSituationalToolTelemetry,
} from "../../clients/situational-tool-telemetry.js";

describe("situational dead-weight telemetry", () => {
	beforeEach(() => {
		logExtension.mockClear();
		resetSituationalToolTelemetry();
	});

	it("names the registered situational tools not activated or called", () => {
		_observeSituationalActivationForTests(["ast_grep_search"]);
		_observeSituationalCallForTests("lsp_navigation");

		emitSituationalDeadWeight();

		const entry = logExtension.mock.calls[0]?.[0] as ExtensionLogEntry;
		expect(entry).toMatchObject({
			subsystem: "tools",
			level: "debug",
			message: "situational tool dead weight",
		});
		expect(entry.metadata).toEqual({
			tools: [
				"ast_grep_replace",
				"ast_grep_outline",
				"ast_grep_dump",
				"lens_diagnostic_mark",
			],
		});
	});

	it("always emits the empty row after every situational tool was used", () => {
		_observeSituationalActivationForTests([
			"ast_grep_search",
			"ast_grep_replace",
			"ast_grep_outline",
			"ast_grep_dump",
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
});
