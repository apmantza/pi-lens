import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { runAutofix } from "../../clients/pipeline.js";
import {
	_getAgreementResolutionCountForTests,
	establishToolAgreement,
	TOOL_AGREEMENT_POLICIES,
} from "../../clients/tool-agreement.js";
import { listSafePipelineAutofixTools } from "../../clients/tool-policy.js";
import { setupTestEnvironment } from "./test-utils.js";

const { resolveToolCommandWithInstallFallback } = vi.hoisted(() => ({
	resolveToolCommandWithInstallFallback: vi.fn(),
}));
const { detectFileChangedAfterCommand } = vi.hoisted(() => ({
	detectFileChangedAfterCommand: vi.fn(),
}));
vi.mock(
	"../../clients/dispatch/runners/utils/runner-helpers.js",
	async (importOriginal) => ({
		...(await importOriginal()),
		resolveToolCommandWithInstallFallback,
	}),
);
vi.mock("../../clients/file-utils.js", async (importOriginal) => ({
	...(await importOriginal()),
	detectFileChangedAfterCommand,
}));

describe("runAutofix tool agreement seam (#3005)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-tool-agreement-");
		resetDegradationLedger();
		resolveToolCommandWithInstallFallback.mockReset();
		resolveToolCommandWithInstallFallback.mockResolvedValue("stylelint");
		detectFileChangedAfterCommand.mockReset();
		detectFileChangedAfterCommand.mockResolvedValue(1);
	});
	afterEach(() => env.cleanup());

	function deps() {
		return {
			biomeClient: { isSupportedFile: () => false } as never,
			ruffClient: { isPythonFile: () => false } as never,
			fixedThisTurn: new Set<string>(),
		};
	}

	it("establishes Node agreement from package.json and package-lock.json before autofix", async () => {
		fs.writeFileSync(
			path.join(env.tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(env.tmpDir, "package-lock.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: { "": {}, "node_modules/stylelint": { version: "16.4.0" } },
			}),
		);
		fs.writeFileSync(path.join(env.tmpDir, ".stylelintrc.json"), "{}\n");
		const file = path.join(env.tmpDir, "style.css");
		fs.writeFileSync(file, "a { color: red; }\n");

		const result = await runAutofix(
			file,
			env.tmpDir,
			() => undefined,
			() => {},
			deps(),
		);

		expect(result.fixedCount).toBe(1);
		expect(detectFileChangedAfterCommand).toHaveBeenCalledOnce();
		expect(getDegradationSummary()).toEqual([]);
	});

	it("establishes markdownlint agreement with markdownlint-cli2 before writing", async () => {
		// Regression for TA-003: the pipeline tool id is markdownlint, but the
		// resolver and installer identify its package as markdownlint-cli2. The
		// independent before/after seam must be reached only after that identity
		// is established, so a wrong package mapping makes this test red.
		fs.writeFileSync(
			path.join(env.tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { "markdownlint-cli2": "^0.23.2" } }),
		);
		fs.writeFileSync(
			path.join(env.tmpDir, "package-lock.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"": {},
					"node_modules/markdownlint-cli2": { version: "0.23.2" },
				},
			}),
		);
		const file = path.join(env.tmpDir, "README.md");
		fs.writeFileSync(file, "# Title\n");
		resolveToolCommandWithInstallFallback.mockResolvedValue(
			"markdownlint-cli2",
		);

		const result = await runAutofix(
			file,
			env.tmpDir,
			() => undefined,
			() => {},
			deps(),
		);

		expect(result.fixedCount).toBe(1);
		expect(detectFileChangedAfterCommand).toHaveBeenCalledOnce();
		expect(detectFileChangedAfterCommand).toHaveBeenCalledWith(
			file,
			"markdownlint-cli2",
			expect.arrayContaining(["--fix", file]),
			env.tmpDir,
			[1],
		);
		expect(getDegradationSummary()).toEqual([]);
	});

	it("declines once when the Node lockfile cannot establish agreement", async () => {
		fs.writeFileSync(
			path.join(env.tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(env.tmpDir, "package-lock.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: { "": {}, "node_modules/stylelint": { version: "15.11.0" } },
			}),
		);
		fs.writeFileSync(path.join(env.tmpDir, ".stylelintrc.json"), "{}\n");
		const file = path.join(env.tmpDir, "style.css");
		fs.writeFileSync(file, "a { color: red; }\n");

		const result = await runAutofix(
			file,
			env.tmpDir,
			() => undefined,
			() => {},
			deps(),
		);

		expect(result.fixedCount).toBe(0);
		expect(detectFileChangedAfterCommand).not.toHaveBeenCalled();
		expect(getDegradationSummary()).toEqual([
			expect.objectContaining({
				kind: "autofix-agreement-unavailable",
				count: 1,
				latestReasons: [expect.objectContaining({ subject: "node:stylelint" })],
			}),
		]);
	});

	it("names the project declaration and resolved lockfile version when they disagree", async () => {
		fs.writeFileSync(
			path.join(env.tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(env.tmpDir, "package-lock.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: { "": {}, "node_modules/stylelint": { version: "15.11.0" } },
			}),
		);
		const file = path.join(env.tmpDir, "style.css");
		fs.writeFileSync(file, "a { color: red; }\n");

		await runAutofix(
			file,
			env.tmpDir,
			() => undefined,
			() => {},
			deps(),
		);

		expect(getDegradationSummary()[0]?.latestReasons[0]?.reason).toEqual(
			expect.stringContaining("stylelint@^16.0.0"),
		);
		expect(getDegradationSummary()[0]?.latestReasons[0]?.reason).toEqual(
			expect.stringContaining("stylelint@15.11.0"),
		);
	});

	it.each([
		["empty resolved version", ""],
		["latest resolved version", "latest"],
		["wildcard resolved version", "*"],
		["overflowing resolved version", "999999999999999999999.0.0"],
	])(
		"declines an unparseable lockfile version: %s",
		async (_label, version) => {
			fs.writeFileSync(
				path.join(env.tmpDir, "package.json"),
				JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
			);
			fs.writeFileSync(
				path.join(env.tmpDir, "package-lock.json"),
				JSON.stringify({ packages: { "node_modules/stylelint": { version } } }),
			);
			const result = await runAutofix(
				path.join(env.tmpDir, "style.css"),
				env.tmpDir,
				() => undefined,
				() => {},
				deps(),
			);

			expect(result.fixedCount).toBe(0);
			expect(getDegradationSummary()[0]?.latestReasons[0]?.reason).toContain(
				"cannot be established",
			);
		},
	);

	it.each([
		["unsupported range", ">=16.0.0"],
		["build metadata", "16.4.0+build.7"],
	])(
		"declines a legal but unsupported agreement shape: %s",
		async (_label, rangeOrVersion) => {
			const range = rangeOrVersion.startsWith(">") ? rangeOrVersion : "^16.0.0";
			const version = rangeOrVersion.startsWith(">")
				? "16.4.0"
				: rangeOrVersion;
			fs.writeFileSync(
				path.join(env.tmpDir, "package.json"),
				JSON.stringify({ devDependencies: { stylelint: range } }),
			);
			fs.writeFileSync(
				path.join(env.tmpDir, "package-lock.json"),
				JSON.stringify({ packages: { "node_modules/stylelint": { version } } }),
			);

			await runAutofix(
				path.join(env.tmpDir, "style.css"),
				env.tmpDir,
				() => undefined,
				() => {},
				deps(),
			);

			expect(getDegradationSummary()[0]?.latestReasons[0]?.reason).toContain(
				"unsupported",
			);
		},
	);

	it("declines absent evidence and caches an unknown warning tool decision", () => {
		const before = _getAgreementResolutionCountForTests();
		const first = establishToolAgreement(
			"unregistered-warning-tool",
			env.tmpDir,
		);
		const second = establishToolAgreement(
			"unregistered-warning-tool",
			env.tmpDir,
		);

		expect(first).toMatchObject({
			decision: "decline",
			subject: "tool:unregistered-warning-tool",
			reasonCode: "evidence-unsupported",
		});
		expect(second).toEqual(first);
		expect(_getAgreementResolutionCountForTests()).toBe(before + 1);
	});

	it("declines a registered tool when project evidence is absent", () => {
		expect(establishToolAgreement("rust-clippy", env.tmpDir)).toMatchObject({
			decision: "decline",
			subject: "project:rust-clippy",
			reasonCode: "evidence-absent",
		});
	});

	it("keeps every safe pipeline autofix tool in the conservative agreement registry", () => {
		// Population guard for TA-003 and future policy drift: this is the full
		// autonomous pipeline-writer population, not only the formatter registry.
		for (const tool of listSafePipelineAutofixTools()) {
			expect(
				TOOL_AGREEMENT_POLICIES[tool],
				`${tool} must have an evidence policy before it can write files`,
			).toMatchObject({ withoutEvidence: "decline" });
		}
	});
});
