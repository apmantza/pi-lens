import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGlobalConfig } from "../support/global-config.js";
import { installLspServiceDouble } from "../support/lsp-service-seam.js";
import {
	endTurn,
	readTarget,
	step,
} from "../support/pi-session-commit-gate.js";
import {
	fauxToolCall,
	piSessionFixture,
	startPiSession,
} from "../support/pi-session.js";

const setGlobalConfig = useGlobalConfig();
const fixture = piSessionFixture();

describe("formatter session warm/first-use liveness (#1394)", () => {
	afterEach(() => vi.resetModules());

	it("session_start -> immediate format edit actually changes the file", async () => {
		vi.resetModules();
		vi.doMock("../../clients/formatters.js", async (importOriginal) => ({
			...(await importOriginal<typeof import("../../clients/formatters.js")>()),
			getFormattersForFile: async () => [
				{ name: "test-formatter", command: ["test-formatter"] },
			],
			formatFile: async (filePath: string) => {
				fs.writeFileSync(filePath, "export const formatted = true;\n");
				return { success: true, changed: true };
			},
		}));
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
					output: "formatter pipeline output",
					blockerOutput: "",
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
			touchFile: async () => [],
			supportsLSP: () => false,
			getStatus: () => [],
			getAliveServerIds: () => [],
		});
		setGlobalConfig({ format: { mode: "immediate" } });
		// Tier 2 (#4937 L6): a real pi session over the factory this test imported
		// after the doMocks above. `no-autoformat` is a default of the tier, so the
		// case turns it off: the claim is that the immediate format runs on the
		// first edit after a start.
		const cwd = path.join(fixture.root, "proj");
		const filePath = path.join(cwd, "live.ts");
		fs.mkdirSync(cwd, { recursive: true });
		fs.writeFileSync(filePath, "export const formatted = false;\n");
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			flags: new Map([["no-autoformat", false]]),
			inlineFactory: async () => (await import("../../index.js")).default,
			responses: [
				step(readTarget(filePath)),
				step(
					fauxToolCall("edit", {
						path: filePath,
						edits: [
							{
								oldText: "export const formatted = false;",
								newText: "export const formatted = 0;",
							},
						],
					}),
				),
				endTurn(),
			],
		});
		await handle.prompt("edit it");

		expect(handle.errors).toEqual([]);
		// The edit wrote `formatted = 0`; only the formatter's write leaves `true`.
		expect(fs.readFileSync(filePath, "utf8")).toContain("formatted = true");
	}, 30_000);
});
