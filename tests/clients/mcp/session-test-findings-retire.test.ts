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
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../../clients/cache-manager.js";
import { makeLspServiceDouble } from "../../support/lsp-service-double.js";
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
	getLSPService: () => makeLspServiceDouble({ getAliveClientCount: () => 0 }),
	resetLSPService: vi.fn(),
}));

import {
	_resetMcpSessionContext,
	_resetTurnEndChain,
	acknowledgeTurnEnd,
	runTurnEndForIpc,
} from "../../../clients/mcp/session.js";

let tmpDir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
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
