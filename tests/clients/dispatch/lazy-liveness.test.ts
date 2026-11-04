import { CHECKED_BY_FIXTURE } from "../../support/dispatch-verdict.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installLspServiceDouble } from "../../support/lsp-service-seam.js";
import {
	endTurn,
	readTarget,
	step,
	toolResults,
} from "../../support/pi-session-commit-gate.js";
import {
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "../../support/pi-session.js";

const dispatchResult = {
	diagnostics: [{ tool: "dispatch", message: "dispatch fired" }],
	blockers: [],
	warnings: [],
	baselineWarningCount: 0,
	fixed: [],
	resolvedCount: 0,
	output: "dispatch output",
	blockerOutput: "",
	verdict: CHECKED_BY_FIXTURE,
	hasBlockers: false,
};

const fixture = piSessionFixture();

describe("dispatch session warm/first-use liveness (#1394)", () => {
	afterEach(() => vi.resetModules());

	it("session_start -> edit tool_result produces dispatch output", async () => {
		vi.resetModules();
		vi.doMock(
			"../../../clients/dispatch/integration.js",
			async (importOriginal) => ({
				...(await importOriginal<
					typeof import("../../../clients/dispatch/integration.js")
				>()),
				dispatchLintWithResult: async () => dispatchResult,
			}),
		);
		vi.doMock("../../../clients/bootstrap.js", async () => {
			const { bootstrapSeamMock } =
				await import("../../support/bootstrap-mock.js");
			return bootstrapSeamMock(async () => ({
				todoScanner: {},
				biomeClient: { isAvailable: () => false, isSupportedFile: () => false },
				ruffClient: { isAvailable: () => false, isSupportedFile: () => false },
				knipClient: {
					isAvailable: () => false,
					analyze: async () => ({ issues: [] }),
				},
				jscpdClient: { isAvailable: () => false },
				depChecker: { isAvailable: () => false },
				deadCodeClients: [],
				testRunnerClient: { detectRunner: () => null },
				goClient: { isGoAvailableAsync: async () => false },
				rustClient: { isAvailableAsync: async () => false },
				agentBehaviorClient: {
					recordToolCall: () => [],
					formatWarnings: () => "",
				},
				complexityClient: {
					isSupportedFile: () => false,
					analyzeFile: () => null,
				},
			}));
		});
		// Installed AFTER every doMock above and BEFORE the entry import:
		// `vi.resetModules()` re-evaluates `clients/lsp/index.ts`, whose import-time
		// configure replaces the lifecycle (tests/support/lsp-service-seam.ts, step 2).
		await installLspServiceDouble({
			touchFile: async () => [],
			supportsLSP: () => false,
			getStatus: () => [],
			getAliveServerIds: () => [],
		});
		// Tier 2 (#4937 L6): a real pi session over the factory this test imported
		// after the doMocks above, so the mocked dispatch seam is the one the
		// extension calls. The model reads, then edits: pi's own tool result is
		// what the dispatch output rides.
		const cwd = path.join(fixture.root, "proj");
		const filePath = path.join(cwd, "src", "live.ts");
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, "export const live = 1;\n");
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			inlineFactory: async () => (await import("../../../index.js")).default,
			responses: [
				step(readTarget(filePath)),
				step(
					fauxToolCall("edit", {
						path: filePath,
						edits: [
							{
								oldText: "export const live = 1;",
								newText: "export const live = 2;",
							},
						],
					}),
				),
				endTurn(),
			],
		});
		await handle.prompt("edit it");

		// A handler that threw on pi's real turn_end would reach pi's error
		// channel and leave the tool result looking healthy.
		expect(handle.errors).toEqual([]);
		const edits = toolResults(handle.requests.at(-1) ?? [], "edit");
		expect(edits).toHaveLength(1);
		expect(edits[0]?.text).toContain("dispatch output");
	}, 30_000);
});
