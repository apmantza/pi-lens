import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getGlobalAutofixEnabled,
	getGlobalAutoformatEnabled,
	getGlobalContextInjectionEnabled,
	getGlobalImmediateFormatDefault,
	getGlobalTurnSummaryEnabled,
	getGlobalWidgetDefaultVisible,
	getPiLensGlobalConfigPath,
	loadPiLensGlobalConfig,
	resetGlobalConfigWarnCache,
	resolvePiLensFlag,
	resolvePiLensFlagWithSource,
} from "../../clients/lens-config.js";
import { EMPTY_PROJECT_CONFIG } from "../../clients/project-lens-config.js";

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
	resetGlobalConfigWarnCache();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetGlobalConfigWarnCache();
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
		expect(resolvePiLensFlag("lens-opengrep-config", "p/ci", config)).toBe(
			"p/ci",
		);
	});

	it("resolves mutation flags from project config before global defaults", () => {
		const globalConfig = {
			format: { enabled: false },
			actionableWarnings: { autoFix: { enabled: true } },
		};
		const disabledProjectConfig = {
			...EMPTY_PROJECT_CONFIG,
			format: { enabled: false },
			autofix: { enabled: false },
			actionableWarnings: { autoFix: { enabled: false } },
		};

		expect(
			resolvePiLensFlag(
				"no-autoformat",
				false,
				{ format: { enabled: true } },
				disabledProjectConfig,
			),
		).toBe(true);
		expect(
			resolvePiLensFlag(
				"no-autofix",
				false,
				globalConfig,
				disabledProjectConfig,
			),
		).toBe(true);
		expect(
			resolvePiLensFlag(
				"lens-actionable-warning-autofix",
				undefined,
				globalConfig,
				disabledProjectConfig,
			),
		).toBe(false);

		const enabledProjectConfig = {
			...EMPTY_PROJECT_CONFIG,
			format: { enabled: true },
			autofix: { enabled: true },
			actionableWarnings: { autoFix: { enabled: true } },
		};
		expect(
			resolvePiLensFlag(
				"no-autoformat",
				false,
				globalConfig,
				enabledProjectConfig,
			),
		).toBe(false);
		expect(
			resolvePiLensFlag(
				"no-autofix",
				false,
				globalConfig,
				enabledProjectConfig,
			),
		).toBe(false);
		expect(
			resolvePiLensFlag(
				"lens-actionable-warning-autofix",
				undefined,
				{ actionableWarnings: { autoFix: { enabled: false } } },
				enabledProjectConfig,
			),
		).toBe(true);
		expect(
			resolvePiLensFlag(
				"no-autoformat",
				true,
				{ format: { enabled: true } },
				enabledProjectConfig,
			),
		).toBe(true);
	});

	it("parses contextInjection.enabled and resolves the no-lens-context flag", () => {
		const home = makeTempHome();
		const configPath = writeConfig(
			home,
			JSON.stringify({ contextInjection: { enabled: false } }),
		);

		expect(loadPiLensGlobalConfig(configPath)).toEqual({
			contextInjection: { enabled: false },
		});
		expect(getGlobalContextInjectionEnabled(configPath)).toBe(false);

		// no-lens-context flag is true (i.e. "disable") when config disables injection
		expect(
			resolvePiLensFlag("no-lens-context", false, {
				contextInjection: { enabled: false },
			}),
		).toBe(true);
		// CLI flag set explicitly wins regardless of config
		expect(
			resolvePiLensFlag("no-lens-context", true, {
				contextInjection: { enabled: true },
			}),
		).toBe(true);
		// config enabled=true (or absent) → flag resolves falsy (injection stays on)
		expect(
			resolvePiLensFlag("no-lens-context", false, {
				contextInjection: { enabled: true },
			}),
		).toBe(false);
		expect(resolvePiLensFlag("no-lens-context", false, {})).toBe(false);
	});

	it("defaults context injection to enabled when unset", () => {
		const home = makeTempHome();
		const configPath = writeConfig(home, JSON.stringify({ widget: {} }));
		expect(getGlobalContextInjectionEnabled(configPath)).toBe(true);
		// missing config file → enabled
		expect(
			getGlobalContextInjectionEnabled(path.join(home, "nope.json")),
		).toBe(true);
	});

	it("defaults turnSummary to disabled (opt-in, #484)", () => {
		const home = makeTempHome();
		expect(getGlobalTurnSummaryEnabled(path.join(home, "nope.json"))).toBe(
			false,
		);
		const configPath = writeConfig(home, JSON.stringify({ widget: {} }));
		expect(getGlobalTurnSummaryEnabled(configPath)).toBe(false);
		expect(resolvePiLensFlag("lens-turn-summary", false, {})).toBe(false);
	});

	it("parses turnSummary.enabled=true and resolves the lens-turn-summary flag", () => {
		const home = makeTempHome();
		const configPath = writeConfig(
			home,
			JSON.stringify({ turnSummary: { enabled: true } }),
		);
		expect(loadPiLensGlobalConfig(configPath)).toEqual({
			turnSummary: { enabled: true },
		});
		expect(getGlobalTurnSummaryEnabled(configPath)).toBe(true);
		expect(
			resolvePiLensFlag("lens-turn-summary", false, {
				turnSummary: { enabled: true },
			}),
		).toBe(true);
		// explicit CLI flag wins regardless of config
		expect(
			resolvePiLensFlag("lens-turn-summary", true, {
				turnSummary: { enabled: false },
			}),
		).toBe(true);
		// config false (or absent) → flag resolves falsy
		expect(
			resolvePiLensFlag("lens-turn-summary", false, {
				turnSummary: { enabled: false },
			}),
		).toBe(false);
	});

	it("parses a positive dispatch.runnerTimeoutFloorMs", () => {
		const home = makeTempHome();
		const configPath = writeConfig(
			home,
			JSON.stringify({ dispatch: { runnerTimeoutFloorMs: 180000 } }),
		);

		expect(loadPiLensGlobalConfig(configPath)).toEqual({
			dispatch: { runnerTimeoutFloorMs: 180000 },
		});
	});

	it("rejects a non-positive or non-finite dispatch.runnerTimeoutFloorMs", () => {
		const home = makeTempHome();
		const negativePath = writeConfig(
			home,
			JSON.stringify({ dispatch: { runnerTimeoutFloorMs: -10 } }),
		);
		const zeroPath = writeConfig(
			home,
			JSON.stringify({ dispatch: { runnerTimeoutFloorMs: 0 } }),
		);
		const stringPath = writeConfig(
			home,
			JSON.stringify({ dispatch: { runnerTimeoutFloorMs: "180000" } }),
		);

		expect(loadPiLensGlobalConfig(negativePath)).toEqual({
			dispatch: { runnerTimeoutFloorMs: undefined },
		});
		expect(loadPiLensGlobalConfig(zeroPath)).toEqual({
			dispatch: { runnerTimeoutFloorMs: undefined },
		});
		expect(loadPiLensGlobalConfig(stringPath)).toEqual({
			dispatch: { runnerTimeoutFloorMs: undefined },
		});
	});

	it("defaults the widget to visible for missing or invalid config", () => {
		const home = makeTempHome();
		const missingPath = getPiLensGlobalConfigPath(home);
		const invalidPath = writeConfig(home, "not json");

		expect(getGlobalWidgetDefaultVisible(missingPath)).toBe(true);
		expect(getGlobalWidgetDefaultVisible(invalidPath)).toBe(true);
	});

	// #792: docs/globalconfig.md documented a global `autofix.enabled` example
	// long before the parser/resolver actually honored it. These pin down the
	// full precedence chain now that it's wired up.
	describe("global autofix.enabled parity (#792)", () => {
		it("parses autofix.enabled from global config", () => {
			const home = makeTempHome();
			const configPath = writeConfig(
				home,
				JSON.stringify({ autofix: { enabled: false } }),
			);

			expect(loadPiLensGlobalConfig(configPath)).toEqual({
				autofix: { enabled: false },
			});
			expect(getGlobalAutofixEnabled(configPath)).toBe(false);
		});

		it("defaults autofix to enabled when config is missing or silent", () => {
			const home = makeTempHome();
			expect(getGlobalAutofixEnabled(path.join(home, "nope.json"))).toBe(true);
			const configPath = writeConfig(home, JSON.stringify({ widget: {} }));
			expect(getGlobalAutofixEnabled(configPath)).toBe(true);
		});

		it("global autofix.enabled=false disables --no-autofix's default", () => {
			expect(
				resolvePiLensFlag("no-autofix", false, { autofix: { enabled: false } }),
			).toBe(true);
			expect(
				resolvePiLensFlag("no-autofix", false, { autofix: { enabled: true } }),
			).toBe(false);
			expect(resolvePiLensFlag("no-autofix", false, {})).toBe(false);
		});

		it("project autofix.enabled overrides global in EITHER direction (project wins, #792 maintainer decision)", () => {
			const globalDisabled = { autofix: { enabled: false } };
			const globalEnabled = { autofix: { enabled: true } };

			// Project re-enables what global disabled.
			expect(
				resolvePiLensFlag("no-autofix", false, globalDisabled, {
					...EMPTY_PROJECT_CONFIG,
					autofix: { enabled: true },
				}),
			).toBe(false);
			// Project disables regardless of global.
			expect(
				resolvePiLensFlag("no-autofix", false, globalEnabled, {
					...EMPTY_PROJECT_CONFIG,
					autofix: { enabled: false },
				}),
			).toBe(true);
			// Explicit CLI flag still outranks everything.
			expect(
				resolvePiLensFlag("no-autofix", true, globalEnabled, {
					...EMPTY_PROJECT_CONFIG,
					autofix: { enabled: true },
				}),
			).toBe(true);
		});

		it("warns once (not repeatedly) on an invalid global autofix.enabled value", () => {
			const home = makeTempHome();
			const configPath = writeConfig(
				home,
				JSON.stringify({ autofix: { enabled: "no" } }),
			);

			expect(loadPiLensGlobalConfig(configPath)?.autofix?.enabled).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("autofix.enabled must be a boolean"),
			);
			const callsAfterFirst = (console.error as ReturnType<typeof vi.fn>).mock
				.calls.length;

			loadPiLensGlobalConfig(configPath);
			loadPiLensGlobalConfig(configPath);
			expect(
				(console.error as ReturnType<typeof vi.fn>).mock.calls.length,
			).toBe(callsAfterFirst);
		});

		it("warns once on an invalid global format.enabled and actionableWarnings.autoFix.enabled value", () => {
			const home = makeTempHome();
			const configPath = writeConfig(
				home,
				JSON.stringify({
					format: { enabled: "nope" },
					actionableWarnings: { autoFix: { enabled: 1 } },
				}),
			);

			const parsed = loadPiLensGlobalConfig(configPath);
			expect(parsed?.format?.enabled).toBeUndefined();
			expect(parsed?.actionableWarnings?.autoFix?.enabled).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("format.enabled must be a boolean"),
			);
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"actionableWarnings.autoFix.enabled must be a boolean",
				),
			);
		});
	});

	describe("resolvePiLensFlagWithSource (#792)", () => {
		it("reports source=cli when an explicit CLI value wins", () => {
			expect(
				resolvePiLensFlagWithSource("no-autofix", true, undefined, undefined),
			).toEqual({ value: true, source: "cli" });
			expect(
				resolvePiLensFlagWithSource("no-autoformat", true, undefined, undefined),
			).toEqual({ value: true, source: "cli" });
		});

		it("reports source=project when project config decides no-autofix/no-autoformat", () => {
			const projectConfig = {
				...EMPTY_PROJECT_CONFIG,
				format: { enabled: false },
				autofix: { enabled: false },
			};
			expect(
				resolvePiLensFlagWithSource(
					"no-autoformat",
					false,
					undefined,
					projectConfig,
				),
			).toEqual({ value: true, source: "project" });
			expect(
				resolvePiLensFlagWithSource(
					"no-autofix",
					false,
					undefined,
					projectConfig,
				),
			).toEqual({ value: true, source: "project" });
			expect(
				resolvePiLensFlagWithSource(
					"lens-actionable-warning-autofix",
					undefined,
					undefined,
					{
						...EMPTY_PROJECT_CONFIG,
						actionableWarnings: { autoFix: { enabled: true } },
					},
				),
			).toEqual({ value: true, source: "project" });
		});

		it("reports source=global when only global config decides", () => {
			expect(
				resolvePiLensFlagWithSource("no-autofix", false, {
					autofix: { enabled: false },
				}),
			).toEqual({ value: true, source: "global" });
			expect(
				resolvePiLensFlagWithSource("no-autoformat", false, {
					format: { enabled: false },
				}),
			).toEqual({ value: true, source: "global" });
			expect(
				resolvePiLensFlagWithSource("lens-actionable-warning-autofix", undefined, {
					actionableWarnings: { autoFix: { enabled: true } },
				}),
			).toEqual({ value: true, source: "global" });
		});

		it("reports source=default when nothing overrides the built-in default", () => {
			expect(
				resolvePiLensFlagWithSource("no-autofix", false, undefined, undefined),
			).toEqual({ value: false, source: "default" });
			expect(
				resolvePiLensFlagWithSource("no-autoformat", false, undefined, undefined),
			).toEqual({ value: false, source: "default" });
			expect(
				resolvePiLensFlagWithSource(
					"lens-actionable-warning-autofix",
					undefined,
					undefined,
					undefined,
				),
			).toEqual({ value: false, source: "default" });
		});

		it("resolvePiLensFlag delegates to resolvePiLensFlagWithSource with zero behavior change", () => {
			const globalConfig = { autofix: { enabled: false } };
			const projectConfig = {
				...EMPTY_PROJECT_CONFIG,
				autofix: { enabled: true },
			};
			expect(resolvePiLensFlag("no-autofix", false, globalConfig, projectConfig)).toBe(
				resolvePiLensFlagWithSource(
					"no-autofix",
					false,
					globalConfig,
					projectConfig,
				).value,
			);
		});
	});
});
