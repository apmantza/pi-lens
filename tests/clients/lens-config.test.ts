import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getGlobalAutoformatEnabled,
	getGlobalImmediateFormatDefault,
	getGlobalWidgetDefaultVisible,
	getPiLensGlobalConfigPath,
	loadPiLensGlobalConfig,
	resolvePiLensFlag,
} from "../../clients/lens-config.js";

const tmpDirs: string[] = [];
let previousConfigPath: string | undefined;

function makeTempHome(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-config-"));
	tmpDirs.push(dir);
	return dir;
}

function writeConfig(home: string, contents: string): string {
	const configPath = getPiLensGlobalConfigPath(home);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, contents, "utf-8");
	return configPath;
}

beforeEach(() => {
	previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	delete process.env.PI_LENS_CONFIG_PATH;
});

afterEach(() => {
	if (previousConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("global pi-lens config", () => {
	it("uses ~/.pi-lens/config.json", () => {
		const home = makeTempHome();

		expect(getPiLensGlobalConfigPath(home)).toBe(
			path.join(home, ".pi-lens", "config.json"),
		);
	});

	it("honors an explicit config path override", () => {
		const home = makeTempHome();
		process.env.PI_LENS_CONFIG_PATH = path.join(home, "custom-config.json");

		expect(getPiLensGlobalConfigPath()).toBe(
			path.join(home, "custom-config.json"),
		);
	});

	it("parses widget and format preferences", () => {
		const home = makeTempHome();
		const configPath = writeConfig(
			home,
			JSON.stringify({
				widget: { visible: false },
				format: { enabled: true, mode: "immediate" },
				actionableWarnings: {
					enabled: true,
					includeLspCodeActions: true,
					deltaOnly: true,
					autoFix: { enabled: false },
				},
				unknown: true,
			}),
		);

		expect(loadPiLensGlobalConfig(configPath)).toEqual({
			widget: { visible: false },
			format: { enabled: true, mode: "immediate" },
			actionableWarnings: {
				enabled: true,
				includeLspCodeActions: true,
				deltaOnly: true,
				autoFix: { enabled: false },
			},
		});
		expect(getGlobalWidgetDefaultVisible(configPath)).toBe(false);
		expect(getGlobalAutoformatEnabled(configPath)).toBe(true);
		expect(getGlobalImmediateFormatDefault(configPath)).toBe(true);
	});

	it("ignores invalid format modes", () => {
		const home = makeTempHome();
		const configPath = writeConfig(
			home,
			JSON.stringify({ format: { enabled: false, mode: "later" } }),
		);

		expect(loadPiLensGlobalConfig(configPath)).toEqual({
			format: { enabled: false, mode: undefined },
		});
		expect(getGlobalAutoformatEnabled(configPath)).toBe(false);
		expect(getGlobalImmediateFormatDefault(configPath)).toBe(false);
	});

	it("resolves formatting flags from global config unless CLI flags are set", () => {
		const config = {
			format: { enabled: true, mode: "immediate" as const },
			actionableWarnings: {
				enabled: true,
				includeLspCodeActions: true,
				autoFix: { enabled: true },
			},
		};

		expect(resolvePiLensFlag("immediate-format", false, config)).toBe(true);
		expect(resolvePiLensFlag("no-autoformat", false, config)).toBe(false);
		expect(resolvePiLensFlag("no-autoformat", true, config)).toBe(true);
		expect(resolvePiLensFlag("lens-actionable-warnings", false, config)).toBe(
			true,
		);
		expect(
			resolvePiLensFlag("lens-actionable-warning-actions", false, config),
		).toBe(true);
		expect(
			resolvePiLensFlag("lens-actionable-warning-autofix", false, config),
		).toBe(true);
		expect(
			resolvePiLensFlag("lens-actionable-warning-all", false, config),
		).toBe(false);
		expect(resolvePiLensFlag("lens-semgrep-config", "p/ci", config)).toBe(
			"p/ci",
		);
	});

	it("defaults the widget to visible for missing or invalid config", () => {
		const home = makeTempHome();
		const missingPath = getPiLensGlobalConfigPath(home);
		const invalidPath = writeConfig(home, "not json");

		expect(getGlobalWidgetDefaultVisible(missingPath)).toBe(true);
		expect(getGlobalWidgetDefaultVisible(invalidPath)).toBe(true);
	});
});
