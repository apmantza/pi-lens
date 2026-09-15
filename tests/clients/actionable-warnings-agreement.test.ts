import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyConservativeActionableWarningFixes,
	buildActionableWarningsReport,
	type ActionableWarningsReport,
} from "../../clients/actionable-warnings.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { setupTestEnvironment } from "./test-utils.js";
import { normalizeMapKey } from "../../clients/path-utils.js";

const codeAction = vi.fn(async () => [
	{
		title: "Fix it",
		kind: "quickfix",
		isPreferred: true,
		edit: {
			changes: {},
		},
	},
]);
const getLastKnownDiagnostics = vi.fn(
	(): import("../../clients/lsp/client.js").LSPDiagnostic[] | undefined =>
		undefined,
);
const fakeService = makeLspServiceDouble({
	supportsLSP: () => true,
	openFile: async () => undefined,
	codeAction,
	getLastKnownDiagnostics,
});

vi.mock("../../clients/lsp/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/lsp/index.js")>()),
	getLSPService: () => fakeService,
}));

function report(filePath: string): ActionableWarningsReport {
	return {
		generatedAt: new Date().toISOString(),
		scope: "turn_delta",
		sessionId: "agreement-test",
		turnIndex: 1,
		projectSeqEnd: 1,
		deltaOnly: true,
		includeLspCodeActions: true,
		files: [
			{
				filePath,
				displayPath: path.basename(filePath),
				warnings: [
					{
						id: "eslint:fix",
						filePath,
						displayPath: path.basename(filePath),
						line: 1,
						column: 1,
						severity: "warning",
						tool: "eslint",
						message: "fixable warning",
						actions: [
							{
								title: "Fix it",
								hasEdit: true,
								hasCommand: false,
								autoFixEligible: true,
							},
						],
						suppressed: false,
						origin: "lsp",
					},
				],
			},
		],
		summary: {} as ActionableWarningsReport["summary"],
	};
}

describe("actionable warning quickfix agreement (#3005)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-actionable-agreement-");
		resetDegradationLedger();
		codeAction.mockClear();
		getLastKnownDiagnostics.mockReset();
		fs.writeFileSync(
			path.join(env.tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { eslint: "^9.0.0" } }),
		);
		fs.writeFileSync(
			path.join(env.tmpDir, "package-lock.json"),
			JSON.stringify({
				packages: { "node_modules/eslint": { version: "8.0.0" } },
			}),
		);
	});
	afterEach(() => env.cleanup());

	async function buildLspReport(
		filePath: string,
		source: string | undefined,
		serverId = "typescript",
	): Promise<ActionableWarningsReport> {
		getLastKnownDiagnostics.mockReturnValue([
			{
				severity: 2,
				message: "replace this value",
				code: "fix-value",
				source,
				serverId,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 5 },
				},
			},
		]);
		return buildActionableWarningsReport({
			cwd: env.tmpDir,
			sessionId: "agreement-test",
			turnIndex: 1,
			files: [filePath],
			modifiedRangesByFile: new Map([
				[normalizeMapKey(filePath), [{ start: 1, end: 1 }]],
			]),
			dispatchWarnings: [],
			includeLspCodeActions: true,
		});
	}

	function workspaceEdit(filePath: string) {
		return {
			changes: {
				[pathToFileURL(filePath).href]: [
					{
						range: {
							start: { line: 0, character: 0 },
							end: { line: 0, character: 5 },
						},
						newText: "const",
					},
				],
			},
		};
	}

	it("falls back to a known LSP serverId before applying its workspace edit", async () => {
		// #3005: removing the serverId fallback must make this production-path
		// quickfix decline instead of silently using generic `lsp`.
		const filePath = path.join(env.tmpDir, "server-id-app.ts");
		fs.writeFileSync(filePath, "value = 1;\n");
		fs.writeFileSync(
			path.join(env.tmpDir, "package-lock.json"),
			JSON.stringify({
				packages: { "node_modules/eslint": { version: "9.0.0" } },
			}),
		);
		codeAction.mockImplementation(async () => [
			{
				title: "Fix it",
				kind: "quickfix",
				isPreferred: true,
				autoFixEligible: true,
				hasEdit: true,
				hasCommand: false,
				edit: workspaceEdit(filePath),
			},
		]);

		const built = await buildLspReport(filePath, "lsp", "eslint");
		expect(built.files[0]?.warnings[0]?.tool).toBe("eslint");
		const result = await applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: built,
		});

		expect(result.applied).toBe(1);
		expect(fs.readFileSync(filePath, "utf8")).toBe("const = 1;\n");
	});

	it("declines an unsupported serverId fallback with bounded degradation evidence", async () => {
		// #3005: unknown server identities remain fail-closed when source is the
		// generic LSP label and an otherwise valid edit is offered.
		const filePath = path.join(env.tmpDir, "unknown-server-app.ts");
		fs.writeFileSync(filePath, "value = 1;\n");
		codeAction.mockImplementation(async () => [
			{
				title: "Fix it",
				kind: "quickfix",
				isPreferred: true,
				autoFixEligible: true,
				hasEdit: true,
				hasCommand: false,
				edit: workspaceEdit(filePath),
			},
		]);

		const built = await buildLspReport(filePath, "lsp", "unknown-lsp-server");
		expect(built.files[0]?.warnings[0]?.tool).toBe("unknown-lsp-server");
		const result = await applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: built,
		});

		expect(result.applied).toBe(0);
		expect(result.skipped[0]?.reason).toBe("tool_agreement_unavailable");
		expect(fs.readFileSync(filePath, "utf8")).toBe("value = 1;\n");
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "autofix-agreement-unavailable",
				latestReasons: [
					expect.objectContaining({ subject: "tool:unknown-lsp-server" }),
				],
			}),
		]);
	});

	it("uses a real LSP producer identity before applying its workspace edit", async () => {
		const filePath = path.join(env.tmpDir, "app.ts");
		fs.writeFileSync(filePath, "value = 1;\n");
		fs.writeFileSync(
			path.join(env.tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { eslint: "^9.0.0" } }),
		);
		fs.writeFileSync(
			path.join(env.tmpDir, "package-lock.json"),
			JSON.stringify({
				packages: { "node_modules/eslint": { version: "9.0.0" } },
			}),
		);
		codeAction.mockImplementation(async () => [
			{
				title: "Fix it",
				kind: "quickfix",
				isPreferred: true,
				autoFixEligible: true,
				hasEdit: true,
				hasCommand: false,
				edit: workspaceEdit(filePath),
			},
		]);

		const built = await buildLspReport(filePath, "eslint");
		expect(built.files[0]?.warnings[0]?.tool).toBe("eslint");
		const result = await applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: built,
		});

		expect(result.applied).toBe(1);
		expect(fs.readFileSync(filePath, "utf8")).toBe("const = 1;\n");
	});

	it("declines an unknown LSP producer before applying its workspace edit", async () => {
		const filePath = path.join(env.tmpDir, "app.ts");
		fs.writeFileSync(filePath, "value = 1;\n");
		codeAction.mockImplementation(async () => [
			{
				title: "Fix it",
				kind: "quickfix",
				isPreferred: true,
				autoFixEligible: true,
				hasEdit: true,
				hasCommand: false,
				edit: workspaceEdit(filePath),
			},
		]);

		const built = await buildLspReport(filePath, "unknown-lsp-producer");
		const result = await applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: built,
		});

		expect(result.applied).toBe(0);
		expect(result.skipped[0]?.reason).toBe("tool_agreement_unavailable");
		expect(fs.readFileSync(filePath, "utf8")).toBe("value = 1;\n");
	});

	it("declines the autonomous quickfix before applying its workspace edit", async () => {
		const filePath = path.join(env.tmpDir, "app.ts");
		fs.writeFileSync(filePath, "const value = 1;\n");
		const result = await applyConservativeActionableWarningFixes({
			cwd: env.tmpDir,
			report: report(filePath),
		});

		expect(result.applied).toBe(0);
		expect(result.skipped).toEqual([
			{ id: "eslint:fix", reason: "tool_agreement_unavailable" },
		]);
		expect(codeAction).not.toHaveBeenCalled();
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "autofix-agreement-unavailable",
				latestReasons: [expect.objectContaining({ subject: "node:eslint" })],
			}),
		]);
	});
});
