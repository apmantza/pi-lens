import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	findDocumentSymbolAtLine,
	getOpenDocumentSymbols,
	qualifiedLspSymbolName,
} from "../../clients/lsp-document-symbols.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import {
	installLspService,
	installLspServiceDouble,
} from "../support/lsp-service-seam.js";
import { observeTimerRelease } from "../support/timer-release.js";

// No service until a case installs one (the former `getLSPService: vi.fn()`
// answered undefined). The first two cases are pure functions and never ask.
beforeEach(async () => {
	await installLspServiceDouble(null);
});

const range = (start: number, end: number) => ({
	start: { line: start, character: 0 },
	end: { line: end, character: 1 },
});

// A warm client whose document is open and whose `documentSymbol` is the case's.
function installOpenDocumentClient(documentSymbol: () => Promise<unknown>) {
	installLspService(
		makeLspServiceDouble({
			getWarmClientForFile: vi.fn().mockResolvedValue({
				client: {
					isDocumentOpen: () => true,
					getOperationSupport: () => ({ documentSymbol: true }),
					documentSymbol,
				},
			}),
		}),
	);
}

describe("LSP document symbols", () => {
	it("selects the smallest hierarchical symbol and qualifies its ancestry", () => {
		const located = findDocumentSymbolAtLine(
			[
				{
					name: "ReviewManager",
					kind: 5,
					range: range(0, 8),
					children: [{ name: "runSynthesis", kind: 6, range: range(2, 5) }],
				},
			],
			4,
		);
		expect(located?.symbol.name).toBe("runSynthesis");
		expect(qualifiedLspSymbolName(located!)).toBe("ReviewManager.runSynthesis");
	});

	it("uses containerName for flat SymbolInformation responses", () => {
		const located = findDocumentSymbolAtLine(
			[
				{
					name: "runSynthesis",
					containerName: "ReviewManager",
					kind: 6,
					location: { uri: "file:///a.ts", range: range(2, 5) },
				},
			],
			4,
		);
		expect(qualifiedLspSymbolName(located!)).toBe("ReviewManager.runSynthesis");
	});

	it.each([
		["cold", undefined],
		[
			"closed",
			{
				client: {
					isDocumentOpen: () => false,
					getOperationSupport: () => ({ documentSymbol: true }),
				},
			},
		],
	])("does not request symbols when %s", async (_name, warm) => {
		installLspService(
			makeLspServiceDouble({
				getWarmClientForFile: vi.fn().mockResolvedValue(warm),
			}),
		);
		expect(await getOpenDocumentSymbols("/a.ts")).toBeUndefined();
	});

	it("falls back on error and timeout", async () => {
		const documentSymbol = vi
			.fn()
			.mockRejectedValueOnce(new Error("nope"))
			.mockReturnValueOnce(new Promise(() => {}));
		installOpenDocumentClient(documentSymbol);
		expect(await getOpenDocumentSymbols("/a.ts", 5)).toBeUndefined();
		expect(await getOpenDocumentSymbols("/a.ts", 5)).toBeUndefined();
	});

	// Recurrence (shape 4, #1097/#1109): the budget is one shared `withBudget`
	// race. A hand-rolled copy that leaves its losing timer armed keeps a REF'd
	// tail on a one-shot `pi --print` process for the rest of the budget.
	it.each([
		["answers first", async () => [{ name: "foo", kind: 12 }]],
		[
			"rejects",
			async () => {
				throw new Error("server died");
			},
		],
	])("releases the budget timer when the request %s", async (_name, answer) => {
		const BUDGET_MS = 4_321;
		const observer = observeTimerRelease(BUDGET_MS);
		try {
			installOpenDocumentClient(answer);
			await getOpenDocumentSymbols("/a.ts", BUDGET_MS);
			expect(observer.armed()).toHaveLength(1);
			expect(observer.unreleased()).toEqual([]);
		} finally {
			observer.restore();
		}
	});
});
