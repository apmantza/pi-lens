/**
 * session: drives pi-lens's real lifecycle handlers for the MCP path. The
 * handlers (handleSessionStart/handleTurnEnd) and the bootstrap bundle are
 * mocked — this asserts the deps wiring, the consume-bridge → tool result, and
 * that turn_end registers edited files into turn state.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../../clients/cache-manager.js";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";
import { gatedPromise } from "../../support/fault-injection.js";
import { removeTempDirSync } from "../test-utils.js";

const handleSessionStart = vi.hoisted(() =>
	vi.fn(async (_deps: unknown) => undefined),
);
const handleTurnEnd = vi.hoisted(() =>
	vi.fn(async (_deps: unknown) => undefined),
);
const stubClients = vi.hoisted(() => {
	const keys = [
		"ruffClient",
		"biomeClient",
		"knipClient",
		"todoScanner",
		"jscpdClient",
		"depChecker",
		"testRunnerClient",
		"metricsClient",
		"complexityClient",
		"goClient",
		"govulncheckClient",
		"gitleaksClient",
		"trivyClient",
		"opengrepClient",
		"rustClient",
		"agentBehaviorClient",
	];
	return Object.fromEntries(keys.map((k) => [k, { __stub: k }]));
});

vi.mock("../../../clients/runtime-session.js", () => ({ handleSessionStart }));
vi.mock("../../../clients/runtime-turn.js", () => ({ handleTurnEnd }));
vi.mock("../../../clients/bootstrap.js", async () => {
	const { bootstrapSeamMock } = await import("../../support/bootstrap-mock.js");
	return bootstrapSeamMock(async () => stubClients);
});
vi.mock("../../../clients/ast-grep-client.js", () => ({
	AstGrepClient: class {},
}));
vi.mock("../../../clients/lsp/index.js", () => ({
	// `getMcpSessionContext` reads only `getAliveClientCount`; the rest of the
	// surface comes from the factory (#2592).
	getLSPService: () => makeLspServiceDouble({ getAliveClientCount: () => 2 }),
	resetLSPService: vi.fn(),
}));
// Hoisted (not inlined in the factory) so the delivery tests can make a consume
// THROW — the #1274 error path the two-phase protocol exists to survive.
const runtimeContext = vi.hoisted(() => ({
	acknowledgeTurnEndFindings: vi.fn(),
	acknowledgeTestFindings: vi.fn(),
	consumeSessionStartGuidance: vi.fn(() => ({
		messages: [{ role: "user", content: "PROJECT GUIDANCE" }],
	})),
	consumeTurnEndFindings: vi.fn(() => ({
		messages: [{ role: "user", content: "TURN ADVISORY" }],
	})),
	peekTurnEndFindings: vi.fn(() => ({
		messages: [{ role: "user", content: "TURN ADVISORY" }],
	})),
	consumeTestFindings: vi.fn(() => ({
		messages: [{ role: "user", content: "TESTS FAILED" }],
	})),
	peekTestFindings: vi.fn(() => ({
		messages: [{ role: "user", content: "TESTS FAILED" }],
	})),
}));
vi.mock("../../../clients/runtime-context.js", () => runtimeContext);

import {
	_peekInFlightIpcTurnEnds,
	_resetMcpSessionContext,
	_resetTurnEndChain,
	acknowledgeTurnEnd,
	runSessionStart,
	runTurnEnd,
	runTurnEndForIpc,
} from "../../../clients/mcp/session.js";

let tmpDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
	previousDataDir = process.env.PILENS_DATA_DIR;
	handleSessionStart.mockClear();
	handleTurnEnd.mockClear();
	_resetMcpSessionContext();
	_resetTurnEndChain();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-session-"));
	process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
});

afterEach(() => {
	vi.useRealTimers();
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	removeTempDirSync(tmpDir);
});

describe("runSessionStart", () => {
	it("forwards a complete deps bundle to handleSessionStart", async () => {
		await runSessionStart(tmpDir);

		expect(handleSessionStart).toHaveBeenCalledTimes(1);
		const deps = handleSessionStart.mock.calls[0][0] as Record<string, unknown>;
		expect(deps.ctxCwd).toBe(tmpDir);
		expect(typeof deps.getFlag).toBe("function");
		expect(deps.cacheManager).toBeDefined();
		expect(deps.runtime).toBeDefined();
		// The bootstrap clients travel through the ONE seam `SessionStartDeps`
		// now takes (#2467 review) — the MCP server has already loaded them, so
		// both of the seam's questions answer with the real bundle rather than
		// deferring. Asserting through the seam, not through fifteen forwarded
		// fields, is what makes a dropped client impossible instead of silent.
		const bootstrap = deps.bootstrap as {
			peek: () => unknown;
			request: (reason: string) => Promise<unknown>;
		};
		expect(bootstrap.peek()).toBe(stubClients);
		expect(await bootstrap.request("session-start-scans")).toBe(stubClients);
		expect(typeof deps.resetDispatchBaselines).toBe("function");
	});

	it("returns the consumed guidance and LSP client count", async () => {
		const outcome = await runSessionStart(tmpDir);
		expect(outcome.guidance).toBe("PROJECT GUIDANCE");
		expect(outcome.aliveLspClients).toBe(2);
		// No baseline computed yet on a fresh RuntimeCoordinator.
		expect(outcome.errorDebtBaseline).toBeUndefined();
	});
});

describe("runTurnEnd", () => {
	it("registers edited files into turn state and returns findings", async () => {
		const file = path.join(tmpDir, "edited.ts");
		fs.writeFileSync(file, "export const a = 1;\nexport const b = 2;\n");

		const outcome = await runTurnEnd(tmpDir, [file]);

		expect(handleTurnEnd).toHaveBeenCalledTimes(1);
		expect(outcome.filesRegistered).toBe(1);
		expect(outcome.turnEnd).toBe("TURN ADVISORY");
		expect(outcome.tests).toBe("TESTS FAILED");

		// The file was written into turn state for the handler to pick up.
		const deps = handleTurnEnd.mock.calls[0][0] as {
			cacheManager: { readTurnState: (cwd: string) => { files: object } };
		};
		const turnState = deps.cacheManager.readTurnState(tmpDir);
		expect(Object.keys(turnState.files).length).toBe(1);
		// MCP delivery must classify provenance with the same live runtime as the
		// in-process context hook; omitting this argument made legacy/stale data
		// look current on one transport only.
		expect(runtimeContext.consumeTurnEndFindings).toHaveBeenCalledWith(
			expect.anything(),
			tmpDir,
			expect.anything(),
		);
		expect(runtimeContext.consumeTestFindings).toHaveBeenCalledWith(
			expect.anything(),
			tmpDir,
			expect.anything(),
		);
	});

	it("skips unreadable files without counting them", async () => {
		const outcome = await runTurnEnd(tmpDir, [
			path.join(tmpDir, "does-not-exist.ts"),
		]);
		expect(outcome.filesRegistered).toBe(0);
		expect(handleTurnEnd).toHaveBeenCalledTimes(1);
	});

	it("keeps findings available when the Stop client times out (#1218)", async () => {
		const file = path.join(tmpDir, "timeout.ts");
		fs.writeFileSync(file, "export const timeout = true;\n");
		new CacheManager().addModifiedRange(
			file,
			{ start: 1, end: 1 },
			true,
			tmpDir,
			"mcp-test",
			"mcp",
		);

		const delivery = await runTurnEndForIpc(tmpDir);
		expect(delivery.outcome.turnEnd).toBe("TURN ADVISORY");
		expect(delivery.outcome.tests).toBe("TESTS FAILED");
		expect(delivery.deliveryId).toBeTypeOf("string");
		// A later Stop receives the same durable delivery rather than running a
		// second pass or losing findings while the first client was gone.
		const retry = await runTurnEndForIpc(tmpDir);
		expect(retry.deliveryId).toBe(delivery.deliveryId);
		expect(retry.outcome).toEqual(delivery.outcome);
		expect(acknowledgeTurnEnd(tmpDir, delivery.deliveryId!)).toBe(true);
	});

	// #1274: `acknowledgeTurnEnd` deleted the pending delivery BEFORE calling
	// commit, so a throwing consume destroyed the only handle to the findings —
	// exactly the loss the two-phase protocol exists to prevent, reintroduced on
	// the error path. Pre-fix the retry below mints a NEW deliveryId because the
	// entry is already gone.
	it("keeps the delivery re-fetchable when the commit throws (#1274)", async () => {
		const delivery = await runTurnEndForIpc(tmpDir);
		expect(delivery.deliveryId).toBeTypeOf("string");

		runtimeContext.acknowledgeTurnEndFindings.mockImplementationOnce(() => {
			throw new Error("cache write failed");
		});
		expect(() =>
			acknowledgeTurnEnd(tmpDir, delivery.deliveryId as string),
		).toThrow("cache write failed");

		const retry = await runTurnEndForIpc(tmpDir);
		expect(retry.deliveryId).toBe(delivery.deliveryId);
		expect(retry.outcome.turnEnd).toBe("TURN ADVISORY");
		expect(acknowledgeTurnEnd(tmpDir, delivery.deliveryId as string)).toBe(
			true,
		);
	});

	// #1274: every timed-out client and every distinct raw-cwd alias used to
	// leave an entry in the map for the life of the process. Expiry drops the
	// capability WITHOUT committing, which re-arms the findings — the safe
	// direction, since an unconsumed finding is re-reported while a wrongly
	// consumed one is gone for good.
	it("expires a stale delivery instead of holding it forever (#1274)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const delivery = await runTurnEndForIpc(tmpDir);
		vi.setSystemTime(Date.now() + 11 * 60_000);

		expect(acknowledgeTurnEnd(tmpDir, delivery.deliveryId as string)).toBe(
			false,
		);
		const fresh = await runTurnEndForIpc(tmpDir);
		expect(fresh.deliveryId).not.toBe(delivery.deliveryId);
		expect(fresh.outcome.turnEnd).toBe("TURN ADVISORY");
	});

	it("bounds the delivery map instead of growing it without limit (#1274)", async () => {
		const dirs = Array.from({ length: 9 }, (_, i) =>
			path.join(tmpDir, `workspace-${i}`),
		);
		const deliveries = [];
		for (const dir of dirs) deliveries.push(await runTurnEndForIpc(dir));

		// Oldest-first eviction, uncommitted: the capability is refused, the
		// findings stay in the cache for a later Stop.
		expect(
			acknowledgeTurnEnd(dirs[0], deliveries[0].deliveryId as string),
		).toBe(false);
		expect(
			acknowledgeTurnEnd(dirs[8], deliveries[8].deliveryId as string),
		).toBe(true);
	});

	// #1274: a Stop-hook turn-end request carries no files and no sessionId, so
	// overlapping ones are byte-identical. The queue admits ONE waiter, so
	// pre-fix the third concurrent Stop was rejected outright with "queue is
	// busy" — a hook failure caused purely by arrival timing.
	it("coalesces byte-identical Stop-hook requests onto one pass (#1274)", async () => {
		const results = await Promise.all([
			runTurnEndForIpc(tmpDir),
			runTurnEndForIpc(tmpDir),
			runTurnEndForIpc(tmpDir),
		]);

		const ids = new Set(results.map((result) => result.deliveryId));
		expect(ids.size).toBe(1);
		expect(results[0].deliveryId).toBeTypeOf("string");
	});

	it("commits finding delivery only after the Stop reply is acknowledged", async () => {
		runtimeContext.peekTurnEndFindings.mockClear();
		runtimeContext.consumeTurnEndFindings.mockClear();
		runtimeContext.acknowledgeTurnEndFindings.mockClear();
		runtimeContext.acknowledgeTestFindings.mockClear();
		const delivery = await runTurnEndForIpc(tmpDir);
		expect(delivery.outcome.turnEnd).toBe("TURN ADVISORY");
		expect(runtimeContext.peekTurnEndFindings).toHaveBeenCalledTimes(1);
		expect(runtimeContext.consumeTurnEndFindings).not.toHaveBeenCalled();
		expect(acknowledgeTurnEnd(tmpDir, delivery.deliveryId!)).toBe(true);
		expect(runtimeContext.acknowledgeTurnEndFindings).toHaveBeenCalledTimes(1);
		expect(runtimeContext.acknowledgeTestFindings).toHaveBeenCalledTimes(1);
		expect(acknowledgeTurnEnd(tmpDir, delivery.deliveryId!)).toBe(false);
	});

	// Two concurrent handleTurnEnds share one RuntimeCoordinator/CacheManager and
	// race the turn-state clear. The MCP tool and the Stop hook's IPC route both
	// land here, and a hook killed at Claude Code's timeout leaves the pass running.
	it("serializes overlapping passes instead of running them concurrently", async () => {
		let release: (() => void) | undefined;
		handleTurnEnd.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					release = () => resolve(undefined);
				}),
		);

		const first = runTurnEnd(tmpDir);
		const second = runTurnEnd(tmpDir);
		await vi.waitFor(() => expect(release).toBeDefined());
		expect(handleTurnEnd).toHaveBeenCalledTimes(1);

		release?.();
		await Promise.all([first, second]);
		expect(handleTurnEnd).toHaveBeenCalledTimes(2);
	});

	// The chain is a module-level promise every caller links onto, so a thrown
	// pass must be absorbed before it becomes the next caller's link. Without the
	// reset, one failed turn_end rejects every later Stop hook with the PREVIOUS
	// turn's error and never runs the pass at all — a warm server that quietly
	// stops checking for the rest of the session.
	it("keeps serving callers after a pass rejects", async () => {
		handleTurnEnd.mockRejectedValueOnce(new Error("pass blew up"));

		await expect(runTurnEnd(tmpDir)).rejects.toThrow("pass blew up");
		const outcome = await runTurnEnd(tmpDir);

		expect(handleTurnEnd).toHaveBeenCalledTimes(2);
		expect(outcome.turnEnd).toBe("TURN ADVISORY");
	});
});

/**
 * In-flight ABA release (#1968, kit-driven white-box probe — sibling of
 * dead-code-client's/knip-client's bare-`.finally` release, same shape).
 *
 * `runTurnEndForIpc`'s in-flight map cleared with a bare delete-by-key. The
 * race needs a SECOND WRITER replacing the map entry mid-flight — the public
 * API alone cannot produce it today (single set site; microtask FIFO orders
 * every observer after A's cleanup) — so this test simulates that writer
 * directly. `runTurnEndForIpc` registers the map entry synchronously (before
 * its first internal `await`), so the successor can be installed with zero
 * awaits between the call and the injection — no tick-based race needed. Red
 * on the pre-fix bare `.finally` delete: A's cleanup evicted B and the third
 * caller started a duplicate Stop-hook pass.
 */
describe("runTurnEndForIpc in-flight ABA release (#1968)", () => {
	it("a late-settling pass does not evict its mid-flight successor", async () => {
		const buildA = runTurnEndForIpc(tmpDir);
		// Synchronous: the map entry is already registered here, before A's
		// first internal `await` has had a chance to resolve.
		expect(_peekInFlightIpcTurnEnds().get(tmpDir)).toBeDefined();

		// B replaces the entry under the same key while A is still in flight.
		const successor = gatedPromise<Awaited<typeof buildA>>();
		_peekInFlightIpcTurnEnds().set(tmpDir, successor.promise);

		await buildA; // A settles

		// B's entry survived A's cleanup...
		expect(_peekInFlightIpcTurnEnds().get(tmpDir)).toBe(successor.promise);
		// ...and a third caller SHARES B instead of starting a duplicate pass.
		const third = runTurnEndForIpc(tmpDir);
		expect(third).toBe(successor.promise);

		successor.resolve({
			outcome: { turnEnd: "", tests: "", filesRegistered: 0 },
		});
		await third;
	});
});
