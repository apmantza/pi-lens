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
		"rustClient",
		"agentBehaviorClient",
	];
	return Object.fromEntries(keys.map((k) => [k, { __stub: k }]));
});

vi.mock("../../../clients/runtime-session.js", () => ({ handleSessionStart }));
vi.mock("../../../clients/runtime-turn.js", () => ({ handleTurnEnd }));
vi.mock("../../../clients/bootstrap.js", () => ({
	loadBootstrapClients: async () => stubClients,
}));
vi.mock("../../../clients/ast-grep-client.js", () => ({
	AstGrepClient: class {},
}));
vi.mock("../../../clients/lsp/index.js", () => ({
	getLSPService: () => ({ getAliveClientCount: () => 2 }),
	resetLSPService: vi.fn(),
}));
vi.mock("../../../clients/runtime-context.js", () => ({
	consumeSessionStartGuidance: vi.fn(() => ({
		messages: [{ role: "user", content: "PROJECT GUIDANCE" }],
	})),
	consumeTurnEndFindings: vi.fn(() => ({
		messages: [{ role: "user", content: "TURN ADVISORY" }],
	})),
	consumeTestFindings: vi.fn(() => ({
		messages: [{ role: "user", content: "TESTS FAILED" }],
	})),
}));

import {
	_resetMcpSessionContext,
	runSessionStart,
	runTurnEnd,
} from "../../../clients/mcp/session.js";

let tmpDir: string;

beforeEach(() => {
	handleSessionStart.mockClear();
	handleTurnEnd.mockClear();
	_resetMcpSessionContext();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-mcp-session-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
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
		// Bootstrap clients are wired through from the bundle.
		expect(deps.knipClient).toBe(stubClients.knipClient);
		expect(deps.jscpdClient).toBe(stubClients.jscpdClient);
		expect(deps.testRunnerClient).toBe(stubClients.testRunnerClient);
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
	});

	it("skips unreadable files without counting them", async () => {
		const outcome = await runTurnEnd(tmpDir, [
			path.join(tmpDir, "does-not-exist.ts"),
		]);
		expect(outcome.filesRegistered).toBe(0);
		expect(handleTurnEnd).toHaveBeenCalledTimes(1);
	});
});
