import * as fs from "node:fs";
import { withResidentBootstrap } from "../support/bootstrap-access.js";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { resolvePiLensFlag } from "../../clients/lens-config.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleSessionStart } from "../../clients/runtime-session.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { handleTurnEnd } from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const latencyEntries: Array<Record<string, unknown>> = [];
vi.mock("../../clients/latency-logger.js", async (importActual) => {
	const actual =
		await importActual<typeof import("../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: Record<string, unknown>) => latencyEntries.push(entry),
	};
});

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

vi.mock("../../clients/pipeline.js", () => ({
	runPipeline: vi.fn(async () => ({
		output: "no blockers",
		hasBlockers: false,
		isError: false,
		fileModified: false,
		cascadePromise: undefined,
	})),
}));

type MadgeFixture = ReturnType<typeof createMadgeFixture>;

function createMadgeFixture(prefix: string) {
	const env = setupTestEnvironment(prefix);
	const runtime = new RuntimeCoordinator();
	const cacheManager = new CacheManager(false);
	const filePath = path.join(env.tmpDir, "src", "cycle.ts");
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, "export const value = 1;\n");
	return { env, runtime, cacheManager, filePath, dbg: vi.fn() };
}

function markMadgeFileModified(input: {
	fixture: MadgeFixture;
	importsChanged: boolean;
}) {
	const { fixture, importsChanged } = input;
	fixture.cacheManager.addModifiedRange(
		fixture.filePath,
		{ start: 1, end: 1 },
		importsChanged,
		fixture.env.tmpDir,
	);
}

async function runMadgeTurnEnd(input: {
	fixture: MadgeFixture;
	getFlag?: (name: string) => boolean;
	ensureAvailable?: ReturnType<typeof vi.fn>;
	checkFilesBatch?: ReturnType<typeof vi.fn>;
}) {
	const { fixture } = input;
	const { env, runtime, cacheManager, dbg } = fixture;
	const ensureAvailable = input.ensureAvailable ?? vi.fn(async () => true);
	const checkFilesBatch = input.checkFilesBatch ?? vi.fn();
	await handleTurnEnd({
		ctxCwd: env.tmpDir,
		getFlag:
			input.getFlag ?? ((name: string) => name === "lens-turn-end-madge"),
		dbg,
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable, checkFilesBatch } as any,
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as any);
	return { ensureAvailable, checkFilesBatch };
}

describe("runtime event flow", () => {
	it("runs the real turn-end madge batch and carries its result metadata (#1251)", async () => {
		const fixture = createMadgeFixture("pi-lens-madge-turn-end-");
		latencyEntries.length = 0;
		try {
			markMadgeFileModified({ fixture, importsChanged: true });
			const stats = {
				requested: 1,
				missing: 0,
				cacheHits: 0,
				spawned: 1,
				failed: 0,
				commandKind: "npx",
				resolveMs: 3,
				targets: [{ file: "src/cycle.ts", durationMs: 125, ok: true }],
				targetsTruncated: false,
			};
			const resolvedFile = path.resolve(fixture.filePath);
			const checkFilesBatch = vi.fn(async () => ({
				results: new Map([
					[
						resolvedFile,
						{
							hasCircular: true,
							circular: [{ file: resolvedFile, path: resolvedFile }],
							checked: true,
							cacheHit: false,
						},
					],
				]),
				stats,
			}));

			await runMadgeTurnEnd({ fixture, checkFilesBatch });

			expect(checkFilesBatch).toHaveBeenCalledWith(
				[resolvedFile],
				fixture.env.tmpDir,
			);
			expect(fixture.dbg).toHaveBeenCalledWith(
				expect.stringContaining("circular dependency note"),
			);
			const madge = latencyEntries.find((entry) => entry.phase === "madge");
			expect(madge?.metadata).toEqual(stats);
		} finally {
			fixture.env.cleanup();
		}
	});

	it("skips the turn-end madge batch entirely when the flag is off (default, #766)", async () => {
		const fixture = createMadgeFixture("pi-lens-madge-flag-off-");
		latencyEntries.length = 0;
		try {
			markMadgeFileModified({ fixture, importsChanged: true });
			expect(resolvePiLensFlag("lens-turn-end-madge", false, {})).toBe(false);
			const { ensureAvailable, checkFilesBatch } = await runMadgeTurnEnd({
				fixture,
				getFlag: (name) =>
					name === "lens-turn-end-madge"
						? resolvePiLensFlag(name, false, {}) === true
						: false,
			});

			expect(checkFilesBatch).not.toHaveBeenCalled();
			expect(ensureAvailable).not.toHaveBeenCalled();
			const madge = latencyEntries.find((entry) => entry.phase === "madge");
			expect(madge?.metadata).toEqual({ skipped: true });
		} finally {
			fixture.env.cleanup();
		}
	});

	it("skips the turn-end madge batch when enabled but madge is unavailable (#766)", async () => {
		const fixture = createMadgeFixture("pi-lens-madge-unavailable-");
		try {
			markMadgeFileModified({ fixture, importsChanged: true });
			const ensureAvailable = vi.fn(async () => false);
			const { checkFilesBatch } = await runMadgeTurnEnd({
				fixture,
				ensureAvailable,
			});

			expect(ensureAvailable).toHaveBeenCalled();
			expect(checkFilesBatch).not.toHaveBeenCalled();
		} finally {
			fixture.env.cleanup();
		}
	});

	it("does not spawn madge when enabled but no import-changed files exist (#766)", async () => {
		const fixture = createMadgeFixture("pi-lens-madge-no-import-changes-");
		try {
			markMadgeFileModified({ fixture, importsChanged: false });
			const { ensureAvailable, checkFilesBatch } = await runMadgeTurnEnd({
				fixture,
			});

			expect(ensureAvailable).toHaveBeenCalled();
			expect(checkFilesBatch).not.toHaveBeenCalled();
		} finally {
			fixture.env.cleanup();
		}
	});

	it("flows session_start -> tool_result -> turn_end -> context", async () => {
		const env = setupTestEnvironment("pi-lens-event-flow-");
		const runtime = new RuntimeCoordinator();
		const cacheManager = new CacheManager(false);
		const notify = vi.fn();

		try {
			const filePath = path.join(env.tmpDir, "src", "flow.ts");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "export const value = 1;\n");

			await handleSessionStart(
				withResidentBootstrap({
					ctxCwd: env.tmpDir,
					getFlag: () => false,
					notify,
					dbg: () => {},
					log: () => {},
					runtime,
					cacheManager,
					todoScanner: { scanDirectory: () => ({ items: [] }) },
					astGrepClient: {
						isAvailable: () => false,
						ensureAvailable: async () => false,
						scanExports: async () => new Map(),
					},
					biomeClient: {
						isAvailable: () => false,
						ensureAvailable: async () => false,
					},
					ruffClient: {
						isAvailable: () => false,
						ensureAvailable: async () => false,
					},
					knipClient: {
						isAvailable: () => false,
						ensureAvailable: async () => false,
						analyze: async () => EMPTY_KNIP_RESULT,
					},
					jscpdClient: {
						isAvailable: () => false,
						ensureAvailable: async () => false,
					},
					deadCodeClients: [],
					depChecker: {
						isAvailable: () => false,
						ensureAvailable: async () => false,
					},
					testRunnerClient: {
						detectRunner: () => null,
						runTestFile: () => ({}),
					},
					goClient: { isGoAvailableAsync: async () => false },
					rustClient: { isAvailableAsync: async () => false },
					ensureTool: async () => null,
					cleanStaleTsBuildInfo: () => [],
					resetDispatchBaselines: () => {},
					resetLSPService: () => {},
				}) as any,
			);

			await handleToolResult({
				event: {
					toolName: "write",
					input: { path: filePath },
					details: {},
					content: [{ type: "text", text: "base" }],
				},
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				biomeClient: {},
				ruffClient: {},
				testRunnerClient: {},
				resetLSPService: () => {},
				agentBehaviorRecord: () => [],
				formatBehaviorWarnings: () => "",
			} as any);

			cacheManager.addModifiedRange(
				filePath,
				{ start: 1, end: 1 },
				false,
				env.tmpDir,
			);

			// cascadeRun is undefined (mock returns undefined) — no accumulation
			expect(runtime.consumeCascadeRuns()).toHaveLength(0);

			await handleTurnEnd({
				ctxCwd: env.tmpDir,
				getFlag: () => false,
				dbg: () => {},
				runtime,
				cacheManager,
				knipClient: {
					ensureAvailable: async () => false,
					analyze: async () => EMPTY_KNIP_RESULT,
				},
				deadCodeClients: [],
				depChecker: { ensureAvailable: async () => false },
				testRunnerClient: { getTestRunTarget: () => null },
				resetLSPService: () => {},
				resetFormatService: () => {},
			} as any);

			// No cascade results or knip blockers — turn_end clears state
			const firstContext = consumeTurnEndFindings(cacheManager, env.tmpDir);
			expect(firstContext).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});
});
