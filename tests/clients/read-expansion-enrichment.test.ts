import { suspendAt } from "./interleaving-kit.js";
vi.hoisted(() => {
	vi.stubEnv("PI_LENS_READ_GUARD_LOG", "verbose");
});
import {
	flushReadGuardLog,
	getReadGuardLogPath,
} from "../../clients/read-guard-logger.js";
import { readNdjsonRows } from "../support/ndjson-rows.js";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { tryExpandRead } from "../../clients/read-expansion.js";
import { lineContentHash } from "../../clients/read-guard.js";
import { normalizeFilePath } from "../../clients/path-utils.js";
import { getAmbientAbortSignal } from "../../clients/safe-spawn.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolCall } from "../../clients/runtime-tool-call.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import { runHandlerExpectingNoThrow } from "../support/handler-verdict.js";

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
beforeEach(async () => {
	await installLspServiceDouble({
		getWarmClientForFile: getWarmClientForFileMock,
	});
});

beforeEach(() => {
	vi.stubEnv("PI_LENS_TEST_MODE", "0");
});
afterEach(() => {
	vi.unstubAllEnvs();
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

async function lastExpandedEvent(): Promise<
	Record<string, unknown> | undefined
> {
	await flushReadGuardLog();
	const result = readNdjsonRows(getReadGuardLogPath());
	expect(result.skipped).toBe(0);
	return result.rows
		.reverse()
		.find((event) => event.event === "ts_range_expanded");
}

const SOURCE = `class ReviewManager {\n${"\tline();\n".repeat(11)}}\n`;

describe("read-expansion LSP enrichment (#158)", () => {
	it("applies hierarchical enrichment: qualified name, LSP ancestry, enriched flag", async () => {
		const env = setupTestEnvironment("pi-lens-enrich-hier-");
		try {
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
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(makeDeps(env.tmpDir, filePath)),
			);
			const event = await lastExpandedEvent();
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
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(makeDeps(env.tmpDir, filePath)),
			);
			const event = await lastExpandedEvent();
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
			getWarmClientForFileMock.mockResolvedValue(warmClient);
			documentSymbolMock.mockReturnValue(new Promise(() => {}));
			const filePath = createTempFile(env.tmpDir, "src/slow.ts", SOURCE);
			const startedAt = Date.now();
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(makeDeps(env.tmpDir, filePath)),
			);
			// The 150ms budget bounds the enrichment; the read must complete
			// promptly with the un-enriched tree-sitter identity.
			expect(Date.now() - startedAt).toBeLessThan(5_000);
			const event = await lastExpandedEvent();
			expect(event).toBeDefined();
			const serialized = JSON.stringify(event);
			expect(serialized).toContain("runSynthesis");
			expect(serialized).not.toContain('"enriched":true');
			expect(event?.symbol).toBe("runSynthesis");
			expect(event?.metadata).toMatchObject({ lspSymbolTimeout: true });
		} finally {
			env.cleanup();
		}
	});
});

// Recurrence prevented (#5550, the deadline audit's `runtime-tool-call.ts:1171`
// row): Esc during the symbol lookup released the read but left the
// documentSymbol request pending with no signal, so the client stayed busy.
// The request now runs under the bound's signal, which aborts when the
// caller's does; the fake reads it the way the LSP request layer does. (The
// inner 150 ms `withBudget` lapse is a different abandonment, owned by the LSP
// request sender lane, #5097.)
describe("read-expansion LSP enrichment cancels what it abandons (#5550)", () => {
	it("aborts the documentSymbol request's signal when the caller's signal fires", async () => {
		const env = setupTestEnvironment("pi-lens-enrich-cancel-");
		try {
			getWarmClientForFileMock.mockResolvedValue(warmClient);
			const controller = new AbortController();
			let seen: AbortSignal | undefined;
			documentSymbolMock.mockImplementation(() => {
				seen = getAmbientAbortSignal();
				setTimeout(() => controller.abort(), 20);
				return new Promise(() => {});
			});
			const filePath = createTempFile(env.tmpDir, "src/cancel.ts", SOURCE);
			const deps = makeDeps(env.tmpDir, filePath);
			deps.ctx.signal = controller.signal;
			await runHandlerExpectingNoThrow(() => handleToolCall(deps));
			expect(seen).toBeDefined();
			expect(seen?.aborted).toBe(true);
		} finally {
			documentSymbolMock.mockReset();
			env.cleanup();
		}
	});
});

/**
 * #1649: the tool_call reads the file once before the expansion (its line
 * count) and again after it, for the record. The released capture ran at
 * recordRead, after the expansion's await, over the range the expansion
 * settled on. Recurrences prevented: hashes taken from the pre-expansion pass
 * cover only the requested lines, so a widened read lost its hashes; and
 * bytes read before the await hash a file another writer has since changed.
 */
describe("read accounting around the expansion await (#1649)", () => {
	const hashesOf = (text: string, first: number, last: number) =>
		Object.fromEntries(
			text
				.split("\n")
				.slice(first - 1, last)
				.map((line, i) => [first + i, lineContentHash(line)]),
		);

	it("hashes the widened range the expansion settled on", async () => {
		const env = setupTestEnvironment("pi-lens-1649-expand-");
		try {
			getWarmClientForFileMock.mockResolvedValue(undefined);
			const filePath = createTempFile(env.tmpDir, "src/wide.ts", SOURCE);
			const deps = makeDeps(env.tmpDir, filePath);
			await runHandlerExpectingNoThrow(() => handleToolCall(deps));
			const record = deps.runtime.readGuard.getReadHistory(filePath).at(-1);
			expect(record).toMatchObject({ effectiveOffset: 1, effectiveLimit: 12 });
			expect(record?.lineHashes).toEqual(hashesOf(SOURCE, 1, 12));
		} finally {
			env.cleanup();
		}
	});

	it("hashes the bytes on disk after the expansion's await", async () => {
		const env = setupTestEnvironment("pi-lens-1649-expand-race-");
		try {
			getWarmClientForFileMock.mockResolvedValue(undefined);
			const filePath = createTempFile(env.tmpDir, "src/race.ts", SOURCE);
			const rewritten = SOURCE.replace(/line\(\)/g, "other()");
			// The expansion finds nothing, but another writer lands while it runs.
			vi.mocked(tryExpandRead).mockImplementationOnce(async () => {
				fs.writeFileSync(filePath, rewritten);
				return undefined;
			});
			const deps = makeDeps(env.tmpDir, filePath);
			await runHandlerExpectingNoThrow(() => handleToolCall(deps));
			const record = deps.runtime.readGuard.getReadHistory(filePath).at(-1);
			expect(record).toMatchObject({ effectiveOffset: 6, effectiveLimit: 2 });
			expect(record?.lineHashes).toEqual(hashesOf(rewritten, 6, 7));
		} finally {
			env.cleanup();
		}
	});
});

// #5219 r2: warm lookup rejection must carry its file identity to disk.
it.each(["error", "string", "long"])(
	"persists warm lookup failures on the read file %s",
	async (mode) => {
		const env = setupTestEnvironment("pi-lens-enrich-error-");
		try {
			const cause =
				"warm lookup failed" + (mode === "long" ? "x".repeat(600) : "");
			getWarmClientForFileMock.mockRejectedValue(
				mode === "string" ? cause : new Error(cause),
			);
			const filePath = createTempFile(env.tmpDir, "src/error.ts", SOURCE);
			await runHandlerExpectingNoThrow(() =>
				handleToolCall(makeDeps(env.tmpDir, filePath)),
			);
			const event = await lastExpandedEvent();
			expect(event?.filePath).toBe(normalizeFilePath(filePath));
			expect(event?.metadata).toMatchObject({
				lspSymbolOutcome: "failed",
				lspSymbolError: cause.slice(0, 512),
			});
		} finally {
			env.cleanup();
		}
	},
);
it("persists the outer symbol deadline separately", async () => {
	const env = setupTestEnvironment("pi-lens-enrich-outer-");
	vi.useFakeTimers();
	const lookup = suspendAt(getWarmClientForFileMock, async () => warmClient);
	const request = suspendAt(documentSymbolMock, async () => []);
	try {
		const filePath = createTempFile(env.tmpDir, "src/outer.ts", SOURCE);
		const work = runHandlerExpectingNoThrow(() =>
			handleToolCall(makeDeps(env.tmpDir, filePath)),
		);
		await lookup.admitted;
		await vi.advanceTimersByTimeAsync(100);
		lookup.release();
		await request.admitted;
		await vi.advanceTimersByTimeAsync(101);
		await work;
		request.release();
		await request.completed;
		vi.useRealTimers();
		const event = await lastExpandedEvent();
		expect(event?.filePath).toBe(normalizeFilePath(filePath));
		expect(event?.metadata).toMatchObject({
			lspSymbolOutcome: "outer-deadline",
		});
	} finally {
		lookup.release();
		request.release();
		lookup.restore();
		request.restore();
		vi.useRealTimers();
		env.cleanup();
	}
});

// #5219 r2 T6: cancellation and a cold client must not become outer deadlines.
it.each(["caller-abort", "unavailable"])(
	"does not call %s a symbol deadline",
	async (mode) => {
		const env = setupTestEnvironment("pi-lens-enrich-control-");
		try {
			const controller = new AbortController();
			getWarmClientForFileMock.mockImplementation(async () => {
				if (mode === "caller-abort") {
					controller.abort();
					return undefined;
				}
				return undefined;
			});
			const filePath = createTempFile(env.tmpDir, "src/control.ts", SOURCE);
			const deps = makeDeps(env.tmpDir, filePath);
			deps.ctx.signal = controller.signal;
			await runHandlerExpectingNoThrow(() => handleToolCall(deps));
			const event = await lastExpandedEvent();
			expect(event?.filePath).toBe(normalizeFilePath(filePath));
			const metadata = event?.metadata as Record<string, unknown>;
			expect(metadata.lspSymbolTimeout).toBeUndefined();
			expect(metadata.lspSymbolOutcome).toBe(
				mode === "caller-abort" ? "caller-abort" : undefined,
			);
		} finally {
			env.cleanup();
		}
	},
);
