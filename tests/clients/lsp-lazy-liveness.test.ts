import { CHECKED_BY_FIXTURE } from "../support/dispatch-verdict.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import {
	endTurn,
	readTarget,
	step,
	toolResults,
} from "../support/pi-session-commit-gate.js";
import {
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "../support/pi-session.js";

const fixture = piSessionFixture();

describe("LSP session warm/first-use liveness (#1394)", () => {
	afterEach(() => vi.resetModules());

	it("session_start -> first edit services the LSP and produces pipeline output", async () => {
		vi.resetModules();
		const touchFile = vi.fn(async () => []);
		vi.doMock(
			"../../clients/dispatch/integration.js",
			async (importOriginal) => ({
				...(await importOriginal<
					typeof import("../../clients/dispatch/integration.js")
				>()),
				dispatchLintWithResult: async () => ({
					diagnostics: [],
					blockers: [],
					warnings: [],
					baselineWarningCount: 0,
					fixed: [],
					resolvedCount: 0,
					output: "lsp pipeline output",
					blockerOutput: "",
					verdict: CHECKED_BY_FIXTURE,
					hasBlockers: false,
				}),
			}),
		);
		vi.doMock("../../clients/bootstrap.js", async () => {
			const { bootstrapSeamMock } =
				await import("../support/bootstrap-mock.js");
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
			touchFile,
			supportsLSP: () => true,
		});
		// Tier 2 (#4937 L6): a real pi session over the factory this test imported
		// after the doMocks above. `no-lsp` is a default of the tier, so the case
		// turns it off: the claim is that the first edit after a start reaches the
		// language-server seam.
		const cwd = path.join(fixture.root, "proj");
		const filePath = path.join(cwd, "live.ts");
		fs.mkdirSync(cwd, { recursive: true });
		fs.writeFileSync(filePath, "export const live = 1;\n");
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			flags: new Map([["no-lsp", false]]),
			inlineFactory: async () => (await import("../../index.js")).default,
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

		expect(handle.errors).toEqual([]);
		expect(touchFile).toHaveBeenCalled();
		const edits = toolResults(handle.requests.at(-1) ?? [], "edit");
		expect(edits).toHaveLength(1);
		expect(edits[0]?.text).toContain("lsp pipeline output");
	}, 30_000);
});
