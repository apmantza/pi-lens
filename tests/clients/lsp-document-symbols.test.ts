import { describe, expect, it, vi } from "vitest";
import {
	findDocumentSymbolAtLine,
	getOpenDocumentSymbols,
	qualifiedLspSymbolName,
} from "../../clients/lsp-document-symbols.js";
import { getLSPService } from "../../clients/lsp/index.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: vi.fn(),
}));

const range = (start: number, end: number) => ({
	start: { line: start, character: 0 },
	end: { line: end, character: 1 },
});

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
		vi.mocked(getLSPService).mockReturnValue(
			makeLspServiceDouble({
				getWarmClientForFile: vi.fn().mockResolvedValue(warm),
			}) as never,
		);
		expect(await getOpenDocumentSymbols("/a.ts")).toBeUndefined();
	});

	it("falls back on error and timeout", async () => {
		const documentSymbol = vi
			.fn()
			.mockRejectedValueOnce(new Error("nope"))
			.mockReturnValueOnce(new Promise(() => {}));
		vi.mocked(getLSPService).mockReturnValue(
			makeLspServiceDouble({
				getWarmClientForFile: vi.fn().mockResolvedValue({
					client: {
						isDocumentOpen: () => true,
						getOperationSupport: () => ({ documentSymbol: true }),
						documentSymbol,
					},
				}),
			}) as never,
		);
		expect(await getOpenDocumentSymbols("/a.ts", 5)).toBeUndefined();
		expect(await getOpenDocumentSymbols("/a.ts", 5)).toBeUndefined();
	});
});
