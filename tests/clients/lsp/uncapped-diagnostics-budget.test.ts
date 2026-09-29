/**
 * #3402 r2 — what an UNCAPPED `lsp_diagnostics` call pays on a server that
 * publishes nothing.
 *
 * `tools/lsp-diagnostics.ts` leaves `waitMs` undefined unless the caller asks
 * for one, and passes it straight through as `maxClientWaitMs`. `touchFile`'s
 * `perServerTimeout` treats that cap as a CEILING and, with no cap at all,
 * hands the server its full declared `aggregateWaitMs`. So a strategy budget
 * chosen to fit the tool-smoke gate's 8000ms ceiling is not a harness number:
 * it is the wall-clock a normal turn-end diagnostic query blocks for whenever
 * the server has nothing to publish. Round 2 of this PR raised four servers to
 * 8000 for the gate's benefit; this file is the probe that makes that cost
 * visible in a test instead of in a user's turn.
 *
 * The double is production-faithful on the axis under test: it resolves
 * `waitForDiagnostics` only when the budget it was GIVEN elapses, and publishes
 * nothing — the no-publication path. The assertions read the budget it was
 * handed AND the fake-clock time the touch actually blocked, so a fix that
 * merely renamed the number could not pass.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/config.js")>()),
	getServersForFileWithConfig,
	getServerInitOverride: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

// Module scope, not only `beforeEach`: the client double's wait below is a timer
// on the FAKE clock (that is what makes the measured budget deterministic), and
// both vitest and the flake-shape scan's line-ordered fake-timer state have to
// see the activation before that timer is written.
vi.useFakeTimers();

const ROOT = "C:/repo";

function makeFakeProcess() {
	return {
		process: {
			killed: false,
			kill: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		},
		stdin: { on: vi.fn(), off: vi.fn(), write: vi.fn() },
		stdout: { on: vi.fn(), off: vi.fn(), pipe: vi.fn() },
		stderr: { on: vi.fn(), off: vi.fn() },
		pid: 4242,
	};
}

function makeServer(id: string, ext: string) {
	return {
		id,
		name: id,
		extensions: [ext],
		idleEviction: "resident",
		root: async () => ROOT,
		spawn: vi.fn(async () => ({ process: makeFakeProcess(), source: "test" })),
	};
}

/**
 * A server that never publishes for the touched file. Every budget it is handed
 * is recorded, and the promise resolves only once that budget has elapsed on the
 * clock — which is what makes the elapsed-time assertion evidence rather than a
 * restatement of the argument.
 */
function makeSilentClient(serverId: string, budgets: number[]) {
	return {
		serverId,
		root: ROOT,
		customServer: false,
		isAlive: () => true,
		shutdown: async () => {},
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none",
		}),
		getOperationSupport: () => ({}),
		getAdvertisedCommands: () => [],
		getRawCapabilityKeys: () => [],
		getLaunchVariant: () => undefined,
		diagnosticsVersion: 0,
		getDiagnosticsVersionForPath: vi.fn(() => 0),
		getDiagnostics: vi.fn(() => []),
		getAllDiagnostics: vi.fn(() => new Map()),
		getDiagnosticBinding: vi.fn(() => undefined),
		notify: {
			open: vi.fn(async () => {}),
			change: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		},
		pingLiveness: vi.fn().mockResolvedValue(true),
		waitForDiagnostics: vi.fn((_filePath: string, budgetMs: number) => {
			budgets.push(budgetMs);
			return new Promise<void>((resolve) => setTimeout(resolve, budgetMs));
		}),
	};
}

/** Exactly the touch `tools/lsp-diagnostics.ts` issues for `serverScope`
 *  "primary": no `waitMs` from the caller means no `maxClientWaitMs` at all. */
const UNCAPPED_TOOL_TOUCH = {
	diagnostics: "document" as const,
	collectDiagnostics: true as const,
	clientScope: "primary" as const,
	source: "lsp_diagnostics",
	maxClientWaitMs: undefined,
};

async function measure(
	serverId: string,
	ext: string,
	overrides: Record<string, unknown> = {},
): Promise<{ budgets: number[]; blockedMs: number }> {
	const { LSPService } = await import("../../../clients/lsp/index.js");
	const service = new LSPService();
	const budgets: number[] = [];
	const client = makeSilentClient(serverId, budgets);
	getServersForFileWithConfig.mockReturnValue([makeServer(serverId, ext)]);
	createLSPClient.mockResolvedValue(client);
	const file = `${ROOT}/Gate${ext}`;
	await service.getClientsForFile(file);

	const startedAt = Date.now();
	let settledAt = -1;
	const touch = service
		.touchFile(file, "seeded content", {
			...UNCAPPED_TOOL_TOUCH,
			...overrides,
		})
		.then((result) => {
			settledAt = Date.now();
			return result;
		});
	// Well past any budget under test, so the measurement is the wait's own
	// deadline rather than the end of the window this test advanced.
	await vi.advanceTimersByTimeAsync(30000);
	await touch;
	return { budgets, blockedMs: settledAt - startedAt };
}

describe("#3402 — uncapped lsp_diagnostics wait on a no-publication server", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// The r2 defect, in the direction that hurts a user: csharp-ls's budget was
	// set to the gate's 8000ms ceiling, so this path blocked for 8s on any C#
	// file the server stayed silent about. 6000 is the measured value (run
	// 36058292424 / gate run 36059988117); this asserts the cost of the number,
	// not the number.
	it("pays csharp's measured budget, not the gate's ceiling", async () => {
		const { budgets, blockedMs } = await measure("csharp", ".cs");
		expect(budgets).toEqual([6000]);
		expect(blockedMs).toBeGreaterThanOrEqual(6000);
		expect(blockedMs).toBeLessThan(7000);
	});

	// fsharp/expert/vue published nothing at 1500 AND nothing at 8000 on the same
	// nightly fixtures, so an entry for them could only ever add latency. With no
	// entry they cost the default.
	it("pays only the default budget for the servers with no measured publish", async () => {
		for (const [serverId, ext] of [
			["fsharp", ".fs"],
			["expert", ".ex"],
			["vue", ".vue"],
		] as const) {
			const { budgets, blockedMs } = await measure(serverId, ext);
			expect(budgets, serverId).toEqual([1500]);
			expect(blockedMs, serverId).toBeGreaterThanOrEqual(1500);
			expect(blockedMs, serverId).toBeLessThan(2500);
		}
	});

	// The other direction of the same seam: a caller that DOES pass a cap still
	// gets it as a ceiling, so the per-edit dispatch runner's 2500ms
	// (`clients/dispatch/runners/lsp.ts`) is unchanged by csharp's raise. This is
	// what confines the cost above to the explicit-query path.
	it("keeps a caller-supplied cap as a ceiling over the raised budget", async () => {
		const { budgets, blockedMs } = await measure("csharp", ".cs", {
			maxDiagnosticsWaitMs: 2500,
		});
		expect(budgets).toEqual([2500]);
		expect(blockedMs).toBeLessThan(3500);
	});
});
