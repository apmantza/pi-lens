/**
 * #3483: the LSP idle reset can land while `computeCascadeForFile` is still
 * touching neighbours. The compute reads `getLSPService()` once, and the reset
 * marks that generation destroyed; a neighbour whose touch then hits the
 * destroyed service comes back `undefined` from `touchFile` (at the entry
 * `checkDestroyed()` or at client acquire) and used to be dropped from the run
 * with no marker, so a run whose other neighbour was clean read as "clean".
 *
 * Two seams:
 *  - the real `LSPService` + real `resetLSPService({ reason: "idle" })` prove
 *    both destroyed returns come back `undefined` on a service that reports
 *    itself destroyed, and that a live service with no client does not;
 *  - the real `computeCascadeForFile` with the shared service double (the
 *    language server is a process boundary) proves the run keeps the lost
 *    neighbour as unconfirmed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ImpactCascadeResult,
	ReviewGraph,
} from "../../clients/review-graph/types.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { setupTestEnvironment } from "./test-utils.js";

const mocks = vi.hoisted(() => ({
	actualGetLSPService: undefined as undefined | (() => unknown),
	getLSPService: vi.fn(),
	getServersForFileWithConfig: vi.fn(),
	createLSPClient: vi.fn(),
	buildOrUpdateGraph: vi.fn(),
	computeImpactCascade: vi.fn(),
	computeTransitiveImpact: vi.fn(),
	formatImpactCascade: vi.fn(),
	logCascade: vi.fn(),
	logLatency: vi.fn(),
}));

vi.mock("../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/config.js")>()),
	getServersForFileWithConfig: mocks.getServersForFileWithConfig,
}));

vi.mock("../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/client.js")>()),
	createLSPClient: mocks.createLSPClient,
}));

vi.mock("../../clients/lsp/index.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/lsp/index.js")>();
	mocks.actualGetLSPService = actual.getLSPService;
	return {
		...actual,
		getLSPService: (...args: unknown[]) => mocks.getLSPService(...args),
	};
});

vi.mock("../../clients/review-graph/service.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/review-graph/service.js")
	>()),
	buildOrUpdateGraph: mocks.buildOrUpdateGraph,
	computeImpactCascade: mocks.computeImpactCascade,
	computeTransitiveImpact: mocks.computeTransitiveImpact,
	formatImpactCascade: mocks.formatImpactCascade,
}));

// `logCascade` no-ops under `isTestMode()`; spying is the only way to read
// the cascade's own rows.
vi.mock("../../clients/cascade-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/cascade-logger.js")>()),
	logCascade: mocks.logCascade,
}));

vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/latency-logger.js")>()),
	logLatency: mocks.logLatency,
}));

const pyServer = {
	id: "pyright",
	name: "pyright",
	extensions: [".py"],
	root: async () => undefined,
	spawn: vi.fn(async () => undefined),
};

const CASCADE_TOUCH = {
	diagnostics: "document",
	collectDiagnostics: true,
	maxClientWaitMs: 2000,
	silent: true,
	source: "cascade",
	clientScope: "primary",
} as const;

function touchFailureKind(filePath: string): unknown {
	return mocks.logLatency.mock.calls
		.map(
			([row]) => row as { phase?: string; filePath?: string; metadata?: any },
		)
		.filter(
			(row) =>
				row.phase === "lsp_touch_file" && row.filePath?.endsWith(filePath),
		)
		.at(-1)?.metadata?.failureKind;
}

function emptyGraph(): ReviewGraph {
	return {
		version: "test",
		builtAt: new Date().toISOString(),
		nodes: new Map(),
		edges: [],
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
	};
}

function impact(filePath: string, neighbors: string[]): ImpactCascadeResult {
	return {
		filePath,
		changedSymbols: ["changed"],
		directImporters: neighbors,
		directCallers: [],
		neighborFiles: neighbors,
		riskFlags: [],
	};
}

// The first import of the real LSP service and the cascade module costs
// seconds cold (transform + load), which put the first test of each describe
// near vitest's 5 s default under load. Pay it once here, under its own
// budget; the per-test re-imports after vi.resetModules() are then cheap.
beforeAll(async () => {
	await import("../../clients/lsp/index.js");
	await import("../../clients/dispatch/integration.js");
}, 30_000);

beforeEach(async () => {
	vi.resetModules();
	mocks.getLSPService.mockReset();
	mocks.getServersForFileWithConfig
		.mockReset()
		.mockImplementation((filePath: string) =>
			filePath.endsWith(".py") ? [pyServer] : [],
		);
	mocks.createLSPClient.mockReset();
	mocks.buildOrUpdateGraph.mockReset().mockResolvedValue(emptyGraph());
	mocks.computeImpactCascade.mockReset();
	mocks.computeTransitiveImpact.mockReset().mockReturnValue({
		seedFile: "",
		hits: [],
		truncated: false,
		maxDepthReached: 0,
	});
	mocks.formatImpactCascade.mockReset().mockReturnValue("impact header");
	mocks.logCascade.mockReset();
	mocks.logLatency.mockReset();
}, 30_000);

describe("#3483 premise: a destroyed generation's touch returns undefined and says so", () => {
	async function realService() {
		const lsp = await import("../../clients/lsp/index.js");
		mocks.getLSPService.mockImplementation(() => mocks.actualGetLSPService?.());
		return { lsp, service: lsp.getLSPService() };
	}

	it("(c) a touch that ENTERS after the idle reset", async () => {
		const { lsp, service } = await realService();
		const neighbour = path.join(process.cwd(), "src", "n2.py");
		lsp.resetLSPService({ reason: "idle" });

		const out = await service.touchFile(neighbour, "x = 1\n", CASCADE_TOUCH);

		expect(out).toBeUndefined();
		expect(touchFailureKind("n2.py")).toBe("destroyed");
		expect(service.checkDestroyed()).toBe(true);
	});

	it("(b) a touch the idle reset catches while it ACQUIRES a client", async () => {
		const { lsp, service } = await realService();
		const neighbour = path.join(process.cwd(), "src", "n2.py");

		const pending = service.touchFile(neighbour, "x = 1\n", CASCADE_TOUCH);
		lsp.resetLSPService({ reason: "idle" });
		const out = await pending;

		expect(out).toBeUndefined();
		expect(touchFailureKind("n2.py")).toBe("no_clients_none_spawning");
		expect(service.checkDestroyed()).toBe(true);
	});

	it("a LIVE service with no client for the file is not destroyed", async () => {
		const { lsp, service } = await realService();
		mocks.getServersForFileWithConfig.mockReturnValue([]);
		const neighbour = path.join(process.cwd(), "src", "n2.py");

		const out = await service.touchFile(neighbour, "x = 1\n", CASCADE_TOUCH);

		expect(out).toBeUndefined();
		expect(service.checkDestroyed()).toBe(false);
		lsp.resetLSPService({ reason: "idle" });
	});
});

describe("#3483 cascade: a neighbour lost to an idle reset stays unconfirmed", () => {
	const lspError = {
		severity: 1 as const,
		message: "n1 cross-file error",
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
		code: "X1",
		source: "pyright",
	};

	/**
	 * n1's touch is in flight when the reset lands (its answer still returns,
	 * the replay's outcome (a)); n2's touch enters afterwards and comes back
	 * `undefined`, as the premise tests above show the real service does.
	 */
	async function runCascade(options: {
		n1Diags: (typeof lspError)[];
		reset: boolean;
	}) {
		const env = setupTestEnvironment("cascade-idle-reset-");
		const primary = path.join(env.tmpDir, "model.py");
		const n1 = path.join(env.tmpDir, "n1.py");
		const n2 = path.join(env.tmpDir, "n2.py");
		fs.writeFileSync(primary, "class User: pass\n");
		fs.writeFileSync(n1, "from model import User\n");
		fs.writeFileSync(n2, "from model import User\n");
		mocks.computeImpactCascade.mockReturnValue(impact(primary, [n1, n2]));
		let destroyed = false;
		let n1Entered!: () => void;
		const n1Touched = new Promise<void>((resolve) => {
			n1Entered = resolve;
		});
		mocks.getLSPService.mockReturnValue(
			makeLspServiceDouble({
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				checkDestroyed: vi.fn(() => destroyed),
				touchFile: vi.fn(async (filePath: string) => {
					if (filePath === n1) {
						if (options.reset) destroyed = true;
						n1Entered();
						return { diags: options.n1Diags };
					}
					await n1Touched;
					// Destroyed: the entry return. Live: no client for this file.
					return undefined;
				}),
			}),
		);
		const { computeCascadeForFile } =
			await import("../../clients/dispatch/integration.js");
		try {
			const run = await computeCascadeForFile(primary, env.tmpDir, {
				turnSeq: 1,
				writeSeq: 1,
			});
			const n2Row = mocks.logCascade.mock.calls
				.map(([row]) => row)
				.find(
					(row) => row.phase === "neighbor_touch" && row.neighborFile === n2,
				);
			return { run, n1, n2, n2Row };
		} finally {
			env.cleanup();
		}
	}

	it("REPLAY-CASCADE-N1-CLEAN: the run is not 'clean' when n2 was never checked", async () => {
		const { run, n2, n2Row } = await runCascade({ n1Diags: [], reset: true });

		expect(run.skipReason).toBeUndefined();
		expect(run.result?.neighbors).toContainEqual(
			expect.objectContaining({
				filePath: n2,
				diagnostics: [],
				inconclusive: true,
			}),
		);
		expect(run.result?.formatted).toContain(
			"Cascade diagnostics inconclusive for 1 neighbor file(s)",
		);
		expect(run.result?.formatted).toContain("n2.py");
		expect(n2Row?.metadata).toEqual({
			inconclusive: true,
			inconclusiveReason: "service-destroyed",
		});
	});

	it("REPLAY-CASCADE-N1-ERROR: n2 is named unconfirmed, not hidden as display truncation", async () => {
		const { run, n2 } = await runCascade({ n1Diags: [lspError], reset: true });

		expect(run.result?.formatted).toContain("n1 cross-file error");
		expect(run.result?.formatted).not.toContain("more dependent file(s)");
		expect(run.result?.neighbors.map((n) => n.filePath)).toContain(n2);
		expect(run.result?.formatted).toContain(
			"Cascade diagnostics inconclusive for 1 neighbor file(s)",
		);
	});

	it("a neighbour with no client on a LIVE service is still dropped, not flagged", async () => {
		const { run, n2Row } = await runCascade({ n1Diags: [], reset: false });

		expect(run.skipReason).toBe("clean");
		expect(run.result).toBeUndefined();
		expect(n2Row).toBeUndefined();
		expect(run.neighborCount).toBe(1);
	});
});
