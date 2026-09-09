import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

// #951 review finding 2: the read-path enrichment had no positive-path or
// timeout coverage — every runtime-tool-call test mocked the warm client
// away, so enrichment never fired. This file pins the enrichment branch in
// runtime-tool-call.ts end to end: expansion is stubbed to a fixed result and
// a fake warm client feeds documentSymbol shapes (hierarchical, flat,
// never-resolving) through the REAL getOpenDocumentSymbols machinery.

vi.mock("../../clients/read-expansion.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/read-expansion.js")>();
	return {
		...actual,
		tryExpandRead: vi.fn().mockResolvedValue({
			newOffset: 1,
			newLimit: 12,
			enclosingSymbol: {
				name: "runSynthesis",
				kind: "function",
				startLine: 5,
				endLine: 12,
			},
			ancestry: [{ name: "ReviewManager", kind: "class", startLine: 1 }],
			durationMs: 3,
		}),
	};
});

const documentSymbolMock = vi.fn();
const warmClient = {
	client: {
		isDocumentOpen: () => true,
		getOperationSupport: () => ({ documentSymbol: true }),
		documentSymbol: documentSymbolMock,
	},
};
const getWarmClientForFileMock = vi.fn();
vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () =>
		makeLspServiceDouble({ getWarmClientForFile: getWarmClientForFileMock }),
	resetLSPService: () => {},
}));

const loggedEvents: Array<Record<string, unknown>> = [];
vi.mock("../../clients/read-guard-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/read-guard-logger.js")>();
	return {
		...actual,
		logReadGuardEvent: (event: Record<string, unknown>) => {
			loggedEvents.push(event);
		},
	};
});

vi.mock("../../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("../support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => ({
		complexityClient: {
			isSupportedFile: () => false,
			analyzeFile: async () => null,
		},
		biomeClient: {},
		ruffClient: {},
		metricsClient: {},
		agentBehaviorClient: { recordToolCall: () => {}, formatWarnings: () => "" },
	}));
});

const dbgLines: string[] = [];

function makeDeps(tmpDir: string, filePath: string) {
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = tmpDir;
	return {
		event: {
			toolName: "read",
			input: { path: filePath, offset: 6, limit: 2 },
		},
		ctx: { cwd: tmpDir },
		lensEnabled: true,
		getFlag: () => false,
		dbg: (line: string) => dbgLines.push(line),
		runtime,
		cacheManager: new CacheManager(false),
		ensureLSPConfigInitialized: async () => {},
		updateLspStatus: () => {},
		resetLSPService: () => {},
		getTreeSitterClient: vi.fn(() => ({
			init: vi.fn().mockResolvedValue(true),
		})),
	} as unknown as Parameters<typeof handleToolCall>[0];
}

function lastExpandedEvent(): Record<string, unknown> | undefined {
	return [...loggedEvents]
		.reverse()
		.find((event) => event.event === "ts_range_expanded");
}

const SOURCE = `class ReviewManager {\n${"\tline();\n".repeat(11)}}\n`;

describe("read-expansion LSP enrichment (#158)", () => {
	it("applies hierarchical enrichment: qualified name, LSP ancestry, enriched flag", async () => {
		const env = setupTestEnvironment("pi-lens-enrich-hier-");
		try {
			loggedEvents.length = 0;
			getWarmClientForFileMock.mockResolvedValue(warmClient);
			documentSymbolMock.mockResolvedValue([
				{
					name: "ReviewManager",
					kind: 5,
					range: {
						start: { line: 0, column: 0 },
						end: { line: 12, column: 1 },
					},
					children: [
						{
							name: "runSynthesis",
							kind: 6,
							range: {
								start: { line: 4, column: 0 },
								end: { line: 11, column: 1 },
							},
						},
					],
				},
			]);
			const filePath = createTempFile(env.tmpDir, "src/hier.ts", SOURCE);
			await handleToolCall(makeDeps(env.tmpDir, filePath));
			const event = lastExpandedEvent();
			expect(event).toBeDefined();
			expect(event?.symbol).toBe("ReviewManager.runSynthesis");
			expect(JSON.stringify(event)).toContain('"enriched":true');
		} finally {
			env.cleanup();
		}
	});

	it("keeps tree-sitter ancestry and chains containerName on flat results", async () => {
		const env = setupTestEnvironment("pi-lens-enrich-flat-");
		try {
			loggedEvents.length = 0;
			dbgLines.length = 0;
			getWarmClientForFileMock.mockResolvedValue(warmClient);
			// Flat SymbolInformation (native-ts7's measured shape): no children,
			// containment only via containerName, location instead of range.
			documentSymbolMock.mockResolvedValue([
				{
					name: "Outer",
					kind: 3,
					containerName: undefined,
					location: {
						range: {
							start: { line: 0, column: 0 },
							end: { line: 12, column: 1 },
						},
					},
				},
				{
					name: "Inner",
					kind: 5,
					containerName: "Outer",
					location: {
						range: {
							start: { line: 1, column: 0 },
							end: { line: 12, column: 1 },
						},
					},
				},
				{
					name: "runSynthesis",
					kind: 6,
					containerName: "Inner",
					location: {
						range: {
							start: { line: 4, column: 0 },
							end: { line: 11, column: 1 },
						},
					},
				},
			]);
			const filePath = createTempFile(env.tmpDir, "src/flat.ts", SOURCE);
			await handleToolCall(makeDeps(env.tmpDir, filePath));
			const event = lastExpandedEvent();
			expect(event).toBeDefined();
			// Nested containerName chain fully qualifies the name…
			expect(event?.symbol).toBe("Outer.Inner.runSynthesis");
			expect(JSON.stringify(event)).toContain('"enriched":true');
			// …and the tree-sitter ancestry survives in the symbolPath (flat
			// results carry no hierarchy — they must not wipe the real chain).
			const pathLine = dbgLines.find((line) =>
				line.includes("ts expanded read"),
			);
			expect(pathLine).toContain("ReviewManager →");
		} finally {
			env.cleanup();
		}
	});

	it("falls back to the tree-sitter name when documentSymbol never resolves", async () => {
		const env = setupTestEnvironment("pi-lens-enrich-timeout-");
		try {
			loggedEvents.length = 0;
			getWarmClientForFileMock.mockResolvedValue(warmClient);
			documentSymbolMock.mockReturnValue(new Promise(() => {}));
			const filePath = createTempFile(env.tmpDir, "src/slow.ts", SOURCE);
			const startedAt = Date.now();
			await handleToolCall(makeDeps(env.tmpDir, filePath));
			// The 150ms budget bounds the enrichment; the read must complete
			// promptly with the un-enriched tree-sitter identity.
			expect(Date.now() - startedAt).toBeLessThan(5_000);
			const event = lastExpandedEvent();
			expect(event).toBeDefined();
			const serialized = JSON.stringify(event);
			expect(serialized).toContain("runSynthesis");
			expect(serialized).not.toContain('"enriched":true');
			expect(event?.symbol).toBe("runSynthesis");
		} finally {
			env.cleanup();
		}
	});
});
