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
