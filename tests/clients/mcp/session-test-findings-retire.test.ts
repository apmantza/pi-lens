/**
 * #2522 review round 3, F2 — the MCP Stop-hook commit must not wipe the
 * turn-end deferral set.
 *
 * `acknowledgeTestFindings` is the LIVE commit for the Stop-hook transport
 * (`clients/mcp/session.ts:451`, reached through `acknowledgeTurnEnd` →
 * `commit()`). Round 2 taught only `consumeTestFindings` to preserve
 * `deferredTargets` and left this second copy writing
 * `{ content: "", testRunGeneration }`, so every Stop-hook delivery erased the
 * cut batch. On the ack-only branch (`session.ts:446-453`) `handleTurnEnd` does
 * not run at all that turn, so nothing re-dispatches the set before it is
 * wiped — the targets a batch was cut on were simply never run again.
 *
 * This drives the REAL `clients/mcp/session.ts` transaction with the REAL
 * `clients/runtime-context.ts` (deliberately NOT mocked, unlike
 * `session.test.ts`, whose whole-module mock is exactly what let the defect
 * through) against a real on-disk cache.
 *
 * #4943 R2 (second describe): the same real transaction reads the project's
 * turn-end slot as the MCP host, its one delivery address plus its own
 * coordinator id, so it neither delivers nor acknowledges a pi session's
 * staged message. `handleTurnEnd` stays mocked here; the real composer beside
 * a real pi session is `tests/index-4943-turn-end-delivery-slot.test.ts`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import { getProjectDataDir } from "../../../clients/file-utils.js";
import { installLspServiceDouble } from "../../support/lsp-service-seam.js";
import type { TestRunnerFindingsCache } from "../../../clients/project-diagnostics/runner-adapters/runner-findings.js";
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
import {
	MCP_DELIVERY_ADDRESS,
	_resetMcpSessionContext,
	_resetTurnEndChain,
	acknowledgeTurnEnd,
	getMcpSessionContext,
	runTurnEndForIpc,
} from "../../../clients/mcp/session.js";

let tmpDir: string;
let previousDataDir: string | undefined;

beforeEach(async () => {
	// `getMcpSessionContext` reads only `getAliveClientCount`; the rest of the
	// surface comes from the factory (#2592).
	await installLspServiceDouble({ getAliveClientCount: () => 0 });
	previousDataDir = process.env.PILENS_DATA_DIR;
	handleTurnEnd.mockClear();
	_resetMcpSessionContext();
	_resetTurnEndChain();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2522-ack-"));
	process.env.PILENS_DATA_DIR = path.join(tmpDir, "data");
});

afterEach(() => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	removeTempDirSync(tmpDir);
});

describe("#2522 R3 F2 — Stop-hook ack retires the advisory, not the deferral set", () => {
	it("keeps deferredTargets, retiredTargets and the generation across commit()", async () => {
		const cache = new CacheManager(false);
		const carried = path.join(tmpDir, "src", "slow.test.ts");
		const retired = path.join(tmpDir, "src", "forever.test.ts");
		cache.writeCache(
			"test-runner-findings",
			{
				content:
					"1 test target(s) did not finish within the turn-end batch budget and are deferred to the next turn (they run first): src/slow.test.ts",
				runnerErrorOnly: true,
				testRunGeneration: 7,
				deferredTargets: [
					{ testFile: carried, runner: "vitest", attempts: 1, sessionId: "s1" },
				],
				retiredTargets: [
					{ testFile: retired, runner: "vitest", attempts: 2, sessionId: "s1" },
				],
			} satisfies TestRunnerFindingsCache,
			tmpDir,
		);

		const delivery = await runTurnEndForIpc(tmpDir);
		expect(delivery.outcome.tests).toContain("deferred to the next turn");
		expect(delivery.deliveryId).toBeTruthy();
		// The ack-only branch: a cached advisory short-circuits the pass, so
		// `handleTurnEnd` — the only thing that re-dispatches a deferral — never
		// runs this turn. That is precisely why the commit must not drop the set.
		expect(handleTurnEnd).not.toHaveBeenCalled();

		expect(acknowledgeTurnEnd(tmpDir, delivery.deliveryId as string)).toBe(
			true,
		);

		const after = cache.readCache<TestRunnerFindingsCache>(
			"test-runner-findings",
			tmpDir,
		)?.data;
		// The advisory itself IS retired — delivered exactly once.
		expect(after?.content).toBe("");
		// ...and everything a delivery does not settle survives it.
		expect(after?.testRunGeneration).toBe(7);
		expect((after?.deferredTargets ?? []).map((t) => t.testFile)).toEqual([
			carried,
		]);
		expect((after?.deferredTargets ?? [])[0]?.attempts).toBe(1);
		expect((after?.retiredTargets ?? []).map((t) => t.testFile)).toEqual([
			retired,
		]);
	});
});

describe("#4943 R2: the MCP host reads the turn-end slot as its own address", () => {
	const PI_SESSION = "01a18652-pi-session";

	function stored(): string {
		return fs.readFileSync(
			path.join(getProjectDataDir(tmpDir), "cache", "turn-end-findings.json"),
			"utf8",
		);
	}

	function stage(cache: CacheManager, record: Record<string, unknown>): string {
		cache.writeCache("turn-end-findings", record, tmpDir);
		return stored();
	}

	it("leaves a pi session's staged message byte for byte through the Stop pass", async () => {
		// RECURRENCE GUARDED: #4943 R2. The Stop pass peeked the slot with no
		// reader identity: it rendered a pi session's blocker to the MCP client
		// and its acknowledge marked it consumed for the pi session.
		const cache = new CacheManager(false);
		const before = stage(cache, {
			content: "Unresolved from this turn — src/pi.ts",
			hasBlockers: true,
			sessionId: PI_SESSION,
			deliverTo: PI_SESSION,
			consumed: false,
		});
		resetDegradationLedger();
		const delivery = await runTurnEndForIpc(tmpDir);
		expect(delivery.outcome.turnEnd).toBeUndefined();
		expect(delivery.deliveryId).toBeUndefined();
		expect(stored()).toBe(before);
		// The skip is told apart from an empty slot: one ledger record per
		// addressee, though the pass peeked twice (the cached peek, then the
		// peek after its own turn end).
		const skips = getDegradationSummary().find(
			(group) => group.kind === "turn-end-delivery-addressed-elsewhere",
		);
		expect(skips?.count).toBe(1);
		expect(skips?.latestReasons.map((entry) => entry.subject)).toEqual([
			PI_SESSION,
		]);
	});

	it("acknowledges only the message it delivered, not one a pi turn end staged since", async () => {
		// RECURRENCE GUARDED: #4943 R2, the acknowledge. It consumed whatever
		// the slot held at ack time, so a pi turn end that staged between the
		// Stop reply and its ack lost its message to the MCP client's ack.
		const cache = new CacheManager(false);
		stage(cache, {
			content: "the MCP turn's advisory",
			deliverTo: MCP_DELIVERY_ADDRESS,
		});
		const delivery = await runTurnEndForIpc(tmpDir);
		expect(delivery.outcome.turnEnd).toContain("the MCP turn's advisory");
		const piStaged = stage(cache, {
			content: "Unresolved from this turn — src/pi.ts",
			hasBlockers: true,
			sessionId: PI_SESSION,
			deliverTo: PI_SESSION,
			consumed: false,
		});
		expect(acknowledgeTurnEnd(tmpDir, delivery.deliveryId as string)).toBe(
			true,
		);
		expect(stored()).toBe(piStaged);
	});

	it("delivers what an earlier MCP server staged, and a blocker this server owns once a rewrite drops the address", async () => {
		// The address is one constant for every server process, so a restarted
		// server still delivers what the last one staged (session-telemetry
		// invariants). A commit-gate rewrite drops the address and leaves the
		// owner, the coordinator id of the server that wrote it: that server
		// still reads it, and a pi session's owned record stays the pi
		// session's.
		const cache = new CacheManager(false);
		stage(cache, {
			content: "staged by the last server",
			deliverTo: MCP_DELIVERY_ADDRESS,
			sessionId: "lens-earlier-1",
		});
		const restarted = await runTurnEndForIpc(tmpDir);
		expect(restarted.outcome.turnEnd).toContain("staged by the last server");
		expect(acknowledgeTurnEnd(tmpDir, restarted.deliveryId as string)).toBe(
			true,
		);

		const own = (await getMcpSessionContext()).runtime.telemetrySessionId;
		stage(cache, {
			content: "this server's blocker text",
			hasBlockers: true,
			sessionId: own,
			consumed: false,
		});
		const rewritten = await runTurnEndForIpc(tmpDir);
		expect(rewritten.outcome.turnEnd).toContain("this server's blocker text");
		expect(acknowledgeTurnEnd(tmpDir, rewritten.deliveryId as string)).toBe(
			true,
		);

		const before = stage(cache, {
			content: "a pi session's blocker text",
			hasBlockers: true,
			sessionId: PI_SESSION,
			consumed: false,
		});
		const foreign = await runTurnEndForIpc(tmpDir);
		expect(foreign.outcome.turnEnd).toBeUndefined();
		expect(stored()).toBe(before);
	});

	it("acknowledges a deferred Stop pass only for the MCP host, not a pi turn end staged since", async () => {
		// RECURRENCE GUARDED: #4943 R2, the deferred commit (`runTurnEndNowImpl`
		// in `clients/mcp/session.ts`, reached when a Stop pass finds nothing
		// cached and stages its own turn end). Its acknowledge once passed no
		// reader and no address, and `addressedElsewhere` admits every message
		// to a reader that names no session, so a pi turn end that staged
		// between the Stop reply and its ack lost its message to the MCP ack.
		const cache = new CacheManager(false);
		handleTurnEnd.mockImplementationOnce(async () => {
			stage(cache, {
				content: "the MCP turn's advisory",
				deliverTo: MCP_DELIVERY_ADDRESS,
			});
			return undefined;
		});
		const delivery = await runTurnEndForIpc(tmpDir);
		expect(handleTurnEnd).toHaveBeenCalledTimes(1);
		expect(delivery.outcome.turnEnd).toContain("the MCP turn's advisory");
		expect(delivery.deliveryId).toBeTruthy();
		const piStaged = stage(cache, {
			content: "Unresolved from this turn — src/pi.ts",
			hasBlockers: true,
			sessionId: PI_SESSION,
			deliverTo: PI_SESSION,
			consumed: false,
		});
		expect(acknowledgeTurnEnd(tmpDir, delivery.deliveryId as string)).toBe(
			true,
		);
		expect(stored()).toBe(piStaged);
	});
});
