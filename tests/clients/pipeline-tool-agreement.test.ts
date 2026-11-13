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
	NODE_LOCKFILE_MAX_BYTES,
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
			// #5544 round 2: the CLI argument is the project-relative target, so
			// cli2's `ignores` can match it; the change-detection target (first
			// argument) stays the absolute dispatched path.
			expect.arrayContaining(["--fix", "README.md"]),
			env.tmpDir,
		);
		expect(
			(
				vi.mocked(detectFileChangedAfterCommand).mock.calls[0]![2] as string[]
			).includes(file),
		).toBe(false);
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
	it("establishes Node agreement from an npm package-lock.json", () => {
		const dir = path.join(env.tmpDir, "npm-direct");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(dir, "package-lock.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: { "": {}, "node_modules/stylelint": { version: "16.4.0" } },
			}),
		);
		expect(establishToolAgreement("stylelint", dir)).toMatchObject({
			decision: "established",
			lockfile: "package-lock.json",
		});
	});

	it("establishes Node agreement from a pnpm v9 importers lockfile", () => {
		const dir = path.join(env.tmpDir, "pnpm-v9");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(dir, "pnpm-lock.yaml"),
			"lockfileVersion: 9.0\n" +
				"importers:\n" +
				"  .:\n" +
				"    devDependencies:\n" +
				"      stylelint:\n" +
				"        specifier: ^16.0.0\n" +
				"        version: 16.4.0\n",
		);
		expect(establishToolAgreement("stylelint", dir)).toMatchObject({
			decision: "established",
			lockfile: "pnpm-lock.yaml",
		});
	});

	it("establishes Node agreement from a pnpm workspace importer above the member", () => {
		const ws = path.join(env.tmpDir, "pnpm-workspace");
		const member = path.join(ws, "packages", "member");
		fs.mkdirSync(member, { recursive: true });
		fs.writeFileSync(
			path.join(ws, "package.json"),
			JSON.stringify({ private: true }),
		);
		fs.writeFileSync(
			path.join(ws, "pnpm-lock.yaml"),
			"lockfileVersion: 9.0\n" +
				"importers:\n" +
				"  packages/member:\n" +
				"    devDependencies:\n" +
				"      stylelint:\n" +
				"        specifier: ^16.0.0\n" +
				"        version: 16.4.0\n",
		);
		fs.writeFileSync(
			path.join(member, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		expect(establishToolAgreement("stylelint", member)).toMatchObject({
			decision: "established",
			lockfile: "pnpm-lock.yaml",
		});
	});

	it("establishes Node agreement from a pnpm v6 top-level lockfile", () => {
		const dir = path.join(env.tmpDir, "pnpm-v6");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(dir, "pnpm-lock.yaml"),
			"lockfileVersion: 5.4\n" +
				"specifiers:\n" +
				"  stylelint: ^16.0.0\n" +
				"devDependencies:\n" +
				"  stylelint:\n" +
				"    specifier: ^16.0.0\n" +
				"    version: 16.4.0\n",
		);
		expect(establishToolAgreement("stylelint", dir)).toMatchObject({
			decision: "established",
			lockfile: "pnpm-lock.yaml",
		});
	});

	it("establishes Node agreement from a yarn v1 lockfile with multiple descriptors", () => {
		const dir = path.join(env.tmpDir, "yarn-v1");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(dir, "yarn.lock"),
			"# yarn lockfile v1\n" +
				"\n" +
				"stylelint@^16.0.0, stylelint@^16.1.0:\n" +
				'  version "16.4.0"\n' +
				'  resolved "https://registry.yarnpkg.com/stylelint/-/stylelint-16.4.0.tgz#abc"\n',
		);
		expect(establishToolAgreement("stylelint", dir)).toMatchObject({
			decision: "established",
			lockfile: "yarn.lock",
		});
	});

	it("establishes Node agreement from a yarn Berry lockfile", () => {
		const dir = path.join(env.tmpDir, "yarn-berry");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(dir, "yarn.lock"),
			"__metadata:\n" +
				"  version: 8\n" +
				"  cacheKey: 10c0\n" +
				'"stylelint@npm:^16.0.0":\n' +
				"  version: 16.4.0\n" +
				'  resolution: "stylelint@npm:16.4.0"\n',
		);
		expect(establishToolAgreement("stylelint", dir)).toMatchObject({
			decision: "established",
			lockfile: "yarn.lock",
		});
	});

	it("runs autofix end to end in a pnpm project once agreement is established", async () => {
		const dir = path.join(env.tmpDir, "pnpm-e2e");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(dir, "pnpm-lock.yaml"),
			"lockfileVersion: 9.0\n" +
				"importers:\n" +
				"  .:\n" +
				"    devDependencies:\n" +
				"      stylelint:\n" +
				"        specifier: ^16.0.0\n" +
				"        version: 16.4.0\n",
		);
		fs.writeFileSync(path.join(dir, ".stylelintrc.json"), "{}\n");
		const file = path.join(dir, "style.css");
		fs.writeFileSync(file, "a { color: red; }\n");

		const result = await runAutofix(
			file,
			dir,
			() => undefined,
			() => {},
			deps(),
		);

		expect(result.fixedCount).toBe(1);
		expect(detectFileChangedAfterCommand).toHaveBeenCalledOnce();
	});

	it("prefers package-lock.json when several lockfiles share one directory", () => {
		const dir = path.join(env.tmpDir, "lockfile-precedence");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(dir, "package-lock.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: { "": {}, "node_modules/stylelint": { version: "15.11.0" } },
			}),
		);
		fs.writeFileSync(
			path.join(dir, "pnpm-lock.yaml"),
			"lockfileVersion: 9.0\n" +
				"importers:\n" +
				"  .:\n" +
				"    devDependencies:\n" +
				"      stylelint:\n" +
				"        specifier: ^16.0.0\n" +
				"        version: 16.4.0\n",
		);
		const agreement = establishToolAgreement("stylelint", dir);
		expect(agreement).toMatchObject({
			decision: "decline",
			subject: "node:stylelint",
		});
		if (agreement.decision === "decline") {
			expect(agreement.reason).toContain("package-lock.json");
		}
	});

	it("declines with evidence-absent when no lockfile exists", () => {
		const dir = path.join(env.tmpDir, "no-lockfile");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		const agreement = establishToolAgreement("stylelint", dir);
		expect(agreement).toMatchObject({
			decision: "decline",
			subject: "node:stylelint",
			reasonCode: "evidence-absent",
		});
		if (agreement.decision === "decline") {
			expect(agreement.reason).toContain("package-lock.json");
		}
	});

	it("declines an unparseable npm lockfile and names the supplier", () => {
		const dir = path.join(env.tmpDir, "bad-npm-lock");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(path.join(dir, "package-lock.json"), "{invalid json");
		const agreement = establishToolAgreement("stylelint", dir);
		expect(agreement).toMatchObject({
			decision: "decline",
			reasonCode: "evidence-unparseable",
		});
		if (agreement.decision === "decline") {
			expect(agreement.reason).toContain("package-lock.json");
		}
	});

	it("declines an unparseable pnpm lockfile and names the supplier", () => {
		const dir = path.join(env.tmpDir, "bad-pnpm-lock");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "[unclosed");
		const agreement = establishToolAgreement("stylelint", dir);
		expect(agreement).toMatchObject({
			decision: "decline",
			reasonCode: "evidence-unparseable",
		});
		if (agreement.decision === "decline") {
			expect(agreement.reason).toContain("pnpm-lock.yaml");
		}
	});

	it("declines an unparseable yarn lockfile and names the supplier", () => {
		const dir = path.join(env.tmpDir, "bad-yarn-lock");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(path.join(dir, "yarn.lock"), "[unclosed");
		const agreement = establishToolAgreement("stylelint", dir);
		expect(agreement).toMatchObject({
			decision: "decline",
			reasonCode: "evidence-unparseable",
		});
		if (agreement.decision === "decline") {
			expect(agreement.reason).toContain("yarn.lock");
		}
	});

	it("declines a pnpm resolution that disagrees and names the supplying lockfile", () => {
		const dir = path.join(env.tmpDir, "pnpm-disagree");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(dir, "pnpm-lock.yaml"),
			"lockfileVersion: 9.0\n" +
				"importers:\n" +
				"  .:\n" +
				"    devDependencies:\n" +
				"      stylelint:\n" +
				"        specifier: ^16.0.0\n" +
				"        version: 15.11.0\n",
		);
		const agreement = establishToolAgreement("stylelint", dir);
		expect(agreement).toMatchObject({ decision: "decline" });
		if (agreement.decision === "decline") {
			expect(agreement.reason).toContain("pnpm-lock.yaml");
			expect(agreement.reason).toContain("stylelint@15.11.0");
		}
	});

	it("declines a yarn v1 resolution that disagrees and names the supplying lockfile", () => {
		const dir = path.join(env.tmpDir, "yarn-v1-disagree");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(dir, "yarn.lock"),
			"# yarn lockfile v1\n" +
				"\n" +
				"stylelint@^16.0.0:\n" +
				'  version "15.11.0"\n' +
				'  resolved "https://registry.yarnpkg.com/stylelint/-/stylelint-15.11.0.tgz#abc"\n',
		);
		const agreement = establishToolAgreement("stylelint", dir);
		expect(agreement).toMatchObject({ decision: "decline" });
		if (agreement.decision === "decline") {
			expect(agreement.reason).toContain("yarn.lock");
			expect(agreement.reason).toContain("stylelint@15.11.0");
		}
	});

	it("declines a yarn Berry resolution that disagrees and names the supplying lockfile", () => {
		const dir = path.join(env.tmpDir, "yarn-berry-disagree");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(dir, "yarn.lock"),
			"__metadata:\n" +
				"  version: 8\n" +
				'"stylelint@npm:^16.0.0":\n' +
				"  version: 15.11.0\n" +
				'  resolution: "stylelint@npm:15.11.0"\n',
		);
		const agreement = establishToolAgreement("stylelint", dir);
		expect(agreement).toMatchObject({ decision: "decline" });
		if (agreement.decision === "decline") {
			expect(agreement.reason).toContain("yarn.lock");
			expect(agreement.reason).toContain("stylelint@15.11.0");
		}
	});

	it("declines an unsupported declared range against pnpm evidence", () => {
		const dir = path.join(env.tmpDir, "pnpm-unsupported-range");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: ">=16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(dir, "pnpm-lock.yaml"),
			"lockfileVersion: 9.0\n" +
				"importers:\n" +
				"  .:\n" +
				"    devDependencies:\n" +
				"      stylelint:\n" +
				"        specifier: '>=16.0.0'\n" +
				"        version: 16.4.0\n",
		);
		const agreement = establishToolAgreement("stylelint", dir);
		expect(agreement).toMatchObject({
			decision: "decline",
			reasonCode: "evidence-unsupported",
		});
		if (agreement.decision === "decline") {
			expect(agreement.reason).toContain("unsupported");
			expect(agreement.reason).toContain("pnpm-lock.yaml");
		}
	});

	// Review round on #3656. Contract: @pnpm/dependency-path@1001.1.10
	// (https://github.com/pnpm/pnpm/tree/main/packages/dependency-path),
	// `indexOfDepPathSuffix`/`parse`: a dependency reference is the version
	// followed by balanced `(...)` peer/patch groups, e.g.
	// `16.4.0(less@4.2.0)(postcss@8.4.0(foo@1.0.0))`.
	function writeNodeProject(
		name: string,
		lockName: string,
		lock: string,
	): string {
		const dir = path.join(env.tmpDir, name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(path.join(dir, lockName), lock);
		return dir;
	}

	function pnpmV9(version: string): string {
		return (
			"lockfileVersion: '9.0'\n" +
			"importers:\n" +
			"  .:\n" +
			"    devDependencies:\n" +
			"      stylelint:\n" +
			"        specifier: ^16.0.0\n" +
			`        version: ${version}\n`
		);
	}

	it("establishes agreement from a pnpm v9 version carrying a peer suffix", () => {
		const dir = writeNodeProject(
			"pnpm-v9-peer",
			"pnpm-lock.yaml",
			pnpmV9("16.4.0(less@4.2.0)"),
		);
		expect(establishToolAgreement("stylelint", dir)).toMatchObject({
			decision: "established",
			lockfile: "pnpm-lock.yaml",
		});
	});

	it("establishes agreement from nested and repeated pnpm peer groups", () => {
		const dir = writeNodeProject(
			"pnpm-v9-peer-nested",
			"pnpm-lock.yaml",
			pnpmV9("16.4.0(less@4.2.0)(postcss@8.4.0(foo@1.0.0))"),
		);
		expect(establishToolAgreement("stylelint", dir)).toMatchObject({
			decision: "established",
			lockfile: "pnpm-lock.yaml",
		});
	});

	it("establishes agreement from a pnpm v6 top-level version carrying a peer suffix", () => {
		const dir = writeNodeProject(
			"pnpm-v6-peer",
			"pnpm-lock.yaml",
			"lockfileVersion: '6.0'\n" +
				"devDependencies:\n" +
				"  stylelint:\n" +
				"    specifier: ^16.0.0\n" +
				"    version: 16.4.0(less@4.2.0)\n",
		);
		expect(establishToolAgreement("stylelint", dir)).toMatchObject({
			decision: "established",
			lockfile: "pnpm-lock.yaml",
		});
	});

	it("still declines a peer-suffixed pnpm version that disagrees with the declared range", () => {
		// The suffix strip must compare the core version, not wave it through.
		const dir = writeNodeProject(
			"pnpm-v9-peer-disagree",
			"pnpm-lock.yaml",
			pnpmV9("15.11.0(less@4.2.0)"),
		);
		const agreement = establishToolAgreement("stylelint", dir);
		expect(agreement).toMatchObject({
			decision: "decline",
			reasonCode: "evidence-unparseable",
		});
		if (agreement.decision === "decline") {
			expect(agreement.reason).toContain("stylelint@15.11.0");
			expect(agreement.reason).not.toContain("less@4.2.0");
			expect(agreement.reason).toContain("agreement disagrees");
		}
	});

	it.each([
		["an unbalanced group", "16.4.0(less@4.2.0"],
		["text after the last group", "16.4.0(less@4.2.0)extra"],
		["an empty group", "16.4.0()"],
		["a group with no core version", "(less@4.2.0)"],
		["a stray closing paren", "16.4.0)(less@4.2.0)"],
	])(
		"declines a pnpm version that cannot be normalised: %s",
		(_label, version) => {
			const dir = writeNodeProject(
				`pnpm-bad-suffix-${_label.replace(/\W+/g, "-")}`,
				"pnpm-lock.yaml",
				pnpmV9(`'${version}'`),
			);
			expect(establishToolAgreement("stylelint", dir)).toMatchObject({
				decision: "decline",
				reasonCode: "evidence-unparseable",
			});
		},
	);

	const CLASSIC_HEADER_LF =
		"# yarn lockfile v1\n" +
		"\n" +
		'"stylelint@^16.0.0", stylelint@^16.1.0:\n' +
		'  version "16.4.0"\n' +
		'  resolved "https://registry.yarnpkg.com/stylelint/-/stylelint-16.4.0.tgz#abc"\n' +
		"\n" +
		'other@^1.0.0:\n  version "1.0.0"\n';

	it("establishes agreement from a CRLF yarn Classic lockfile with a quoted multi-descriptor header", () => {
		const dir = writeNodeProject(
			"yarn-v1-crlf",
			"yarn.lock",
			CLASSIC_HEADER_LF.replace(/\n/g, "\r\n"),
		);
		expect(establishToolAgreement("stylelint", dir)).toMatchObject({
			decision: "established",
			lockfile: "yarn.lock",
		});
	});

	it("establishes agreement from a lone-CR yarn Classic lockfile", () => {
		const dir = writeNodeProject(
			"yarn-v1-cr",
			"yarn.lock",
			CLASSIC_HEADER_LF.replace(/\n/g, "\r"),
		);
		expect(establishToolAgreement("stylelint", dir)).toMatchObject({
			decision: "established",
			lockfile: "yarn.lock",
		});
	});

	it("reads the resolved version from a CRLF yarn Classic lockfile rather than waving it through", () => {
		const dir = writeNodeProject(
			"yarn-v1-crlf-disagree",
			"yarn.lock",
			CLASSIC_HEADER_LF.replace("16.4.0", "15.11.0").replace(/\n/g, "\r\n"),
		);
		const agreement = establishToolAgreement("stylelint", dir);
		expect(agreement).toMatchObject({
			decision: "decline",
			reasonCode: "evidence-unparseable",
		});
		if (agreement.decision === "decline") {
			expect(agreement.reason).toContain("stylelint@15.11.0");
			expect(agreement.reason).toContain("agreement disagrees");
		}
	});

	// Shape: a size bound on a new filesystem input (#3656 review). The reader
	// declines with a distinct code instead of reading and parsing the file.
	function padTo(base: string, bytes: number): string {
		return `${base}\n#${"x".repeat(bytes - Buffer.byteLength(base) - 2)}`;
	}
	const PNPM_OK = pnpmV9("16.4.0");
	const YARN_OK = CLASSIC_HEADER_LF;

	describe.each([
		["pnpm-lock.yaml", PNPM_OK],
		["yarn.lock", YARN_OK],
	])("%s read bound", (lockName, base) => {
		it("establishes agreement one byte below the cap", () => {
			const dir = writeNodeProject(
				`cap-below-${lockName}`,
				lockName,
				padTo(base, NODE_LOCKFILE_MAX_BYTES - 1),
			);
			expect(establishToolAgreement("stylelint", dir)).toMatchObject({
				decision: "established",
				lockfile: lockName,
			});
		});

		it("establishes agreement at exactly the cap", () => {
			const text = padTo(base, NODE_LOCKFILE_MAX_BYTES);
			expect(Buffer.byteLength(text)).toBe(NODE_LOCKFILE_MAX_BYTES);
			const dir = writeNodeProject(`cap-at-${lockName}`, lockName, text);
			expect(establishToolAgreement("stylelint", dir)).toMatchObject({
				decision: "established",
				lockfile: lockName,
			});
		});

		it("declines with evidence-too-large one byte over the cap", () => {
			const dir = writeNodeProject(
				`cap-over-${lockName}`,
				lockName,
				padTo(base, NODE_LOCKFILE_MAX_BYTES + 1),
			);
			const agreement = establishToolAgreement("stylelint", dir);
			expect(agreement).toMatchObject({
				decision: "decline",
				subject: "node:stylelint",
				reasonCode: "evidence-too-large",
			});
			if (agreement.decision === "decline") {
				expect(agreement.reason).toContain(lockName);
				expect(agreement.reason).toContain(String(NODE_LOCKFILE_MAX_BYTES));
			}
		});
	});

	it.each(["pnpm-lock.yaml", "yarn.lock"])(
		"declines with evidence-unreadable when %s cannot be read as a file",
		(lockName) => {
			// A directory opens but cannot be read: pins the unreadable branch of
			// the bounded reader apart from the too-large branch.
			const dir = writeNodeProject(`unreadable-${lockName}`, "unused.txt", "");
			fs.mkdirSync(path.join(dir, lockName));
			const agreement = establishToolAgreement("stylelint", dir);
			expect(agreement).toMatchObject({
				decision: "decline",
				reasonCode: "evidence-unreadable",
			});
			if (agreement.decision === "decline") {
				expect(agreement.reason).toContain(lockName);
				expect(agreement.reason).toContain("unreadable");
			}
		},
	);

	it("records one bounded degradation row when an oversized lockfile declines autofix", async () => {
		fs.writeFileSync(
			path.join(env.tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { stylelint: "^16.0.0" } }),
		);
		fs.writeFileSync(
			path.join(env.tmpDir, "yarn.lock"),
			padTo(YARN_OK, NODE_LOCKFILE_MAX_BYTES + 1),
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
				latestReasons: [
					expect.objectContaining({
						subject: "node:stylelint",
						reason: expect.stringContaining("yarn.lock"),
					}),
				],
			}),
		]);
	});
});
