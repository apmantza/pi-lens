import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { runAutofix } from "../../clients/pipeline.js";
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
});
