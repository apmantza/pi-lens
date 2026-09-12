import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { runAutofix } from "../../clients/pipeline.js";
import { hasGradleKtlintPlugin } from "../../clients/tool-policy.js";
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

describe("runAutofix ktlint project agreement (#3000)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let filePath: string;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-ktlint-agreement-");
		resetDegradationLedger();
		resolveToolCommandWithInstallFallback.mockClear();
		detectFileChangedAfterCommand.mockImplementation(async () => {
			fs.writeFileSync(filePath, "fun main() { println(1) }\n\n");
			return 1;
		});
		resolveToolCommandWithInstallFallback.mockResolvedValue("ktlint");
		filePath = path.join(env.tmpDir, "Example.kt");
		fs.writeFileSync(filePath, "fun main() { println(1) }\n");
	});

	afterEach(() => env.cleanup());

	it.each([
		["line comment", '// id("org.jlleitschuh.gradle.ktlint")\n'],
		["block comment", '/* apply plugin: "org.jlleitschuh.gradle.ktlint" */\n'],
		["string", 'val name = "id(\\"org.jlleitschuh.gradle.ktlint\\")"\n'],
	])("does not treat a %s as Gradle ownership", (_kind, source) => {
		fs.writeFileSync(path.join(env.tmpDir, "build.gradle.kts"), source);
		expect(hasGradleKtlintPlugin(env.tmpDir)).toBe(false);
	});

	it("declines before resolving or running ktlint for a Gradle-managed project", async () => {
		fs.writeFileSync(
			path.join(env.tmpDir, "build.gradle.kts"),
			'plugins { id("org.jlleitschuh.gradle.ktlint") version "14.2.0" }\n',
		);
		const before = fs.readFileSync(filePath, "utf8");

		const result = await runAutofix(
			filePath,
			env.tmpDir,
			() => undefined,
			() => {},
			{
				biomeClient: { isSupportedFile: () => false } as never,
				ruffClient: { isPythonFile: () => false } as never,
				fixedThisTurn: new Set<string>(),
			},
		);

		expect(fs.readFileSync(filePath, "utf8")).toBe(before);
		expect(result.fixedCount).toBe(0);
		expect(resolveToolCommandWithInstallFallback).not.toHaveBeenCalled();
		expect(getDegradationSummary()).toEqual([
			{
				kind: "autofix-agreement-unavailable",
				count: 1,
				droppedCount: 0,
				latestReasons: [
					{
						subject: "ktlint:gradle",
						reason: expect.stringContaining("cannot be established"),
					},
				],
			},
		]);
	});

	it("declines when buildSrc convention logic applies the ktlint plugin", async () => {
		const conventionPath = path.join(
			env.tmpDir,
			"buildSrc",
			"src",
			"main",
			"kotlin",
			"KotlinConvention.gradle.kts",
		);
		fs.mkdirSync(path.dirname(conventionPath), { recursive: true });
		fs.writeFileSync(
			conventionPath,
			'plugins { id("org.jlleitschuh.gradle.ktlint") version "14.2.0" }\n',
		);

		const result = await runAutofix(
			filePath,
			env.tmpDir,
			() => undefined,
			() => {},
			{
				biomeClient: { isSupportedFile: () => false } as never,
				ruffClient: { isPythonFile: () => false } as never,
				fixedThisTurn: new Set<string>(),
			},
		);

		expect(result.fixedCount).toBe(0);
		expect(resolveToolCommandWithInstallFallback).not.toHaveBeenCalled();
	});

	it("applies the lexical ownership edge matrix through runAutofix", async () => {
		const cases = [
			{
				name: "build.gradle.kts declaration",
				setup: () =>
					fs.writeFileSync(
						path.join(env.tmpDir, "build.gradle.kts"),
						'plugins { id("org.jlleitschuh.gradle.ktlint") }\n',
					),
				expectedFixedCount: 0,
			},
			{
				name: "settings.gradle.kts declaration",
				setup: () =>
					fs.writeFileSync(
						path.join(env.tmpDir, "settings.gradle.kts"),
						'plugins { id("org.jlleitschuh.gradle.ktlint") }\n',
					),
				expectedFixedCount: 0,
			},
			{
				name: "buildSrc convention plugin",
				setup: () => {
					const conventionPath = path.join(
						env.tmpDir,
						"buildSrc/src/main/kotlin/KotlinConvention.gradle.kts",
					);
					fs.mkdirSync(path.dirname(conventionPath), { recursive: true });
					fs.writeFileSync(
						conventionPath,
						'plugins { id("org.jlleitschuh.gradle.ktlint") }\n',
					);
				},
				expectedFixedCount: 0,
			},
			{
				name: "included build convention plugin",
				setup: () => {
					const conventionPath = path.join(
						env.tmpDir,
						"conventions/src/main/kotlin/KotlinConvention.kt",
					);
					fs.mkdirSync(path.dirname(conventionPath), { recursive: true });
					fs.writeFileSync(
						path.join(env.tmpDir, "settings.gradle.kts"),
						'includeBuild("conventions")\n',
					);
					fs.writeFileSync(
						conventionPath,
						'plugins { id("org.jlleitschuh.gradle.ktlint") }\n',
					);
				},
				expectedFixedCount: 0,
			},
			{
				name: "comment in build logic",
				setup: () =>
					fs.writeFileSync(
						path.join(env.tmpDir, "buildSrc.gradle.kts"),
						'// id("org.jlleitschuh.gradle.ktlint")\n',
					),
				expectedFixedCount: 1,
			},
			{
				name: "string in build logic",
				setup: () =>
					fs.writeFileSync(
						path.join(env.tmpDir, "build.gradle.kts"),
						'val pluginName = "org.jlleitschuh.gradle.ktlint"\n',
					),
				expectedFixedCount: 1,
			},
			{
				name: "plugin in a sibling module",
				setup: () => {
					const siblingPath = path.join(
						env.tmpDir,
						"module-a/build.gradle.kts",
					);
					fs.mkdirSync(path.dirname(siblingPath), { recursive: true });
					fs.writeFileSync(
						siblingPath,
						'plugins { id("org.jlleitschuh.gradle.ktlint") }\n',
					);
					filePath = path.join(env.tmpDir, "module-b/Example.kt");
					fs.mkdirSync(path.dirname(filePath), { recursive: true });
					fs.writeFileSync(filePath, "fun main() { println(1) }\n");
				},
				expectedFixedCount: 1,
			},
		] as const;

		for (const testCase of cases) {
			fs.rmSync(env.tmpDir, { recursive: true, force: true });
			fs.mkdirSync(env.tmpDir, { recursive: true });
			filePath = path.join(env.tmpDir, "Example.kt");
			fs.writeFileSync(filePath, "fun main() { println(1) }\n");
			testCase.setup();
			resolveToolCommandWithInstallFallback.mockClear();
			const result = await runAutofix(
				filePath,
				env.tmpDir,
				() => undefined,
				() => {},
				{
					biomeClient: { isSupportedFile: () => false } as never,
					ruffClient: { isPythonFile: () => false } as never,
					fixedThisTurn: new Set<string>(),
				},
			);
			expect(result.fixedCount, testCase.name).toBe(
				testCase.expectedFixedCount,
			);
		}
	});

	it("declines when Spotless owns ktlint", async () => {
		fs.writeFileSync(
			path.join(env.tmpDir, "build.gradle.kts"),
			"spotless { kotlin { ktlint() } }\n",
		);
		const result = await runAutofix(
			filePath,
			env.tmpDir,
			() => undefined,
			() => {},
			{
				biomeClient: { isSupportedFile: () => false } as never,
				ruffClient: { isPythonFile: () => false } as never,
				fixedThisTurn: new Set<string>(),
			},
		);
		expect(result.fixedCount).toBe(0);
		expect(resolveToolCommandWithInstallFallback).not.toHaveBeenCalled();
	});

	it("keeps the existing ktlint autofix path for a project without Gradle ownership", async () => {
		const result = await runAutofix(
			filePath,
			env.tmpDir,
			() => undefined,
			() => {},
			{
				biomeClient: { isSupportedFile: () => false } as never,
				ruffClient: { isPythonFile: () => false } as never,
				fixedThisTurn: new Set<string>(),
			},
		);

		expect(detectFileChangedAfterCommand).toHaveBeenCalledOnce();
		expect(result.fixedCount).toBe(1);
	});
});
