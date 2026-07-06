import { describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import {
	emitLensAnalysisComplete,
	emitLensTurnFindings,
	initLensEvents,
	LENS_EVENT_NAMES,
} from "../../clients/lens-events.js";

const waitImmediate = () => new Promise((resolve) => setImmediate(resolve));

function baseAnalysisPayload(
	overrides: Partial<Parameters<typeof emitLensAnalysisComplete>[0]> = {},
) {
	return {
		cwd: "/repo",
		filePath: "/repo/src/file.ts",
		toolName: "edit",
		model: "test-model",
		sessionId: "session-1",
		turnIndex: 2,
		writeIndex: 1,
		diagnostics: [],
		blockers: [],
		warnings: [],
		fixed: [],
		resolvedCount: 0,
		hasBlockers: false,
		fileModified: false,
		changedFiles: [],
		durationMs: 12,
		...overrides,
	};
}

describe("lens inter-extension events", () => {
	it("emits analysis-complete for every analysis and findings only when diagnostics exist", async () => {
		const emit = vi.fn();
		initLensEvents({ events: { emit } });

		emitLensAnalysisComplete(baseAnalysisPayload());
		await waitImmediate();

		expect(emit).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledWith(
			LENS_EVENT_NAMES.analysisComplete,
			expect.objectContaining({
				version: 1,
				source: "pi-lens",
				filePath: "/repo/src/file.ts",
				diagnostics: [],
			}),
		);

		const diagnostic: Diagnostic = {
			id: "lsp:1:1",
			message: "Type error",
			filePath: "/repo/src/file.ts",
			line: 1,
			column: 1,
			severity: "error",
			semantic: "blocking",
			tool: "lsp",
		};

		emit.mockClear();
		emitLensAnalysisComplete(
			baseAnalysisPayload({
				diagnostics: [diagnostic],
				blockers: [diagnostic],
				hasBlockers: true,
			}),
		);
		await waitImmediate();

		expect(emit).toHaveBeenCalledTimes(2);
		expect(emit).toHaveBeenNthCalledWith(
			1,
			LENS_EVENT_NAMES.analysisComplete,
			expect.objectContaining({ hasBlockers: true }),
		);
		expect(emit).toHaveBeenNthCalledWith(
			2,
			LENS_EVENT_NAMES.findings,
			expect.objectContaining({
				blockers: [expect.objectContaining({ tool: "lsp" })],
			}),
		);
	});

	it("emits turn-end findings with bounded content", async () => {
		const emit = vi.fn();
		initLensEvents({ events: { emit } });

		emitLensTurnFindings({
			cwd: "/repo",
			filePaths: ["/repo/src/file.ts"],
			sessionId: "session-1",
			turnIndex: 3,
			blockerSections: 1,
			advisorySections: 1,
			content: "x".repeat(9_000),
		});
		await waitImmediate();

		expect(emit).toHaveBeenCalledWith(
			LENS_EVENT_NAMES.turnFindings,
			expect.objectContaining({
				version: 1,
				source: "pi-lens",
				blockerSections: 1,
				advisorySections: 1,
				content: expect.stringMatching(/…$/),
			}),
		);
	});
});
