import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyConservativeActionableWarningFixes,
	type ActionableWarningsReport,
} from "../../clients/actionable-warnings.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { setupTestEnvironment } from "./test-utils.js";

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
const fakeService = makeLspServiceDouble({
	supportsLSP: () => true,
	openFile: async () => undefined,
	codeAction,
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
