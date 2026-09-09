import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getGlobalActionableWarningMaxFixes,
	getGlobalWidgetDefaultVisible,
	getPiLensGlobalConfigPath,
	loadPiLensGlobalConfig,
	resetGlobalConfigWarnCache,
	resolvePiLensFlag,
	resolvePiLensFlagWithSource,
} from "../../clients/lens-config.js";
import {
	getLensFlagSpec,
	LENS_FLAGS,
	type LensFlagSpec,
} from "../../clients/lens-flag-registry.js";
import { EMPTY_PROJECT_CONFIG } from "../../clients/project-lens-config.js";
import { removeTempDirSync } from "./test-utils.js";

// #1333: these config/telemetry warnings no longer reach the terminal — pi owns
// it — they go to the ndjson sink in `clients/extension-log.ts`. The sink mock
// below forwards each entry's message to `console.error` so the assertions in
// this file keep covering what they were written to cover (message content and
// the warn-once dedup contract) without re-deriving every expectation. The
// "no raw terminal write" half of the invariant is enforced repo-wide by
// tests/clients/extension-terminal-silence.test.ts.
vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: { message: string }) => console.error(entry.message),
	};
});

const tmpDirs: string[] = [];
let previousConfigPath: string | undefined;
let previousEnvValues = new Map<string, string | undefined>();

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

/** Build the nested object a spec's dotted `configKey` reads from. */
function configFor(configKey: string, value: unknown): Record<string, unknown> {
	const segments = configKey.split(".");
	const root: Record<string, unknown> = {};
	let node = root;
	for (const segment of segments.slice(0, -1)) {
		node[segment] = {};
		node = node[segment] as Record<string, unknown>;
	}
	node[segments[segments.length - 1]] = value;
	return root;
}

/** The config value that makes a spec's flag resolve to `true`. */
function enablingConfigValue(spec: LensFlagSpec): unknown {
	if (spec.name === "immediate-format") return "immediate";
	return !spec.negated;
}

beforeEach(() => {
	previousConfigPath = process.env.PI_LENS_CONFIG_PATH;
	previousEnvValues = new Map(
		LENS_FLAGS.filter((spec) => spec.env).map((spec) => [
			spec.env as string,
			process.env[spec.env as string],
		]),
	);
	for (const name of previousEnvValues.keys()) delete process.env[name];
	delete process.env.PI_LENS_CONFIG_PATH;
	resetGlobalConfigWarnCache();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetGlobalConfigWarnCache();
	if (previousConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
	else process.env.PI_LENS_CONFIG_PATH = previousConfigPath;
	for (const [name, value] of previousEnvValues) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	for (const dir of tmpDirs.splice(0)) {
		removeTempDirSync(dir);
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
		const parsed = loadPiLensGlobalConfig(configPath);
		// format.enabled:true → --no-autoformat stays off; mode:"immediate" → on.
		expect(resolvePiLensFlag("no-autoformat", false, parsed)).toBe(false);
		expect(resolvePiLensFlag("immediate-format", false, parsed)).toBe(true);
	});

	it("warns once on an unknown top-level config key but not on recognized ones", () => {
		const home = makeTempHome();
		const configPath = writeConfig(
			home,
			JSON.stringify({
				lps: { enabled: false }, // typo of lsp.enabled
				lsp: { enabled: false }, // recognized flag key — must NOT warn
				tools: {
					ast_grep_search: { enabled: false },
					unknown_tool: { enabled: false },
				},
				$schema: "https://example.com/schema.json", // allowed, must NOT warn
			}),
		);

		expect(loadPiLensGlobalConfig(configPath)).toEqual({
			lsp: { enabled: false },
			tools: { ast_grep_search: { enabled: false } },
		});
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('unknown key "lps"'),
		);
		// The recognized `lsp` key and the allowed `$schema` must not warn.
		const warnedForLsp = (console.error as ReturnType<typeof vi.fn>).mock.calls
			.flat()
			.some(
				(arg) =>
					typeof arg === "string" && arg.includes('unknown key "lsp"') === true,
			);
		expect(warnedForLsp).toBe(false);
		const warnedForSchema = (
			console.error as ReturnType<typeof vi.fn>
		).mock.calls
			.flat()
			.some((arg) => typeof arg === "string" && arg.includes("$schema"));
		expect(warnedForSchema).toBe(false);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('unknown key "tools.unknown_tool.enabled"'),
		);

		// Warn-once: repeated loads do not add further warnings for the same key.
		const callsAfterFirst = (console.error as ReturnType<typeof vi.fn>).mock
			.calls.length;
		loadPiLensGlobalConfig(configPath);
		expect((console.error as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
			callsAfterFirst,
		);
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
		const parsed = loadPiLensGlobalConfig(configPath);
		// format.enabled:false → --no-autoformat resolves on; invalid mode falls
		// back so immediate-format stays off.
		expect(resolvePiLensFlag("no-autoformat", false, parsed)).toBe(true);
		expect(resolvePiLensFlag("immediate-format", false, parsed)).toBe(false);
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
		expect(
			resolvePiLensFlag(
				"no-lens-context",
				false,
				loadPiLensGlobalConfig(configPath),
			),
		).toBe(true);

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
		// context injection default-on → no-lens-context resolves off (false).
		expect(
			resolvePiLensFlag(
				"no-lens-context",
				false,
				loadPiLensGlobalConfig(configPath),
			),
		).toBe(false);
		// missing config file → still default-on
		expect(
			resolvePiLensFlag(
				"no-lens-context",
				false,
				loadPiLensGlobalConfig(path.join(home, "nope.json")),
			),
		).toBe(false);
	});

	it("defaults turnSummary to disabled (opt-in, #484)", () => {
		const home = makeTempHome();
		expect(
			resolvePiLensFlag(
				"lens-turn-summary",
				false,
				loadPiLensGlobalConfig(path.join(home, "nope.json")),
			),
		).toBe(false);
		const configPath = writeConfig(home, JSON.stringify({ widget: {} }));
		expect(
			resolvePiLensFlag(
				"lens-turn-summary",
				false,
				loadPiLensGlobalConfig(configPath),
			),
		).toBe(false);
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
		expect(
			resolvePiLensFlag(
				"lens-turn-summary",
				false,
				loadPiLensGlobalConfig(configPath),
			),
		).toBe(true);
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
			// autofix.enabled:false → --no-autofix resolves on (true).
			expect(
				resolvePiLensFlag(
					"no-autofix",
					false,
					loadPiLensGlobalConfig(configPath),
				),
			).toBe(true);
		});

		it("defaults autofix to enabled when config is missing or silent", () => {
			const home = makeTempHome();
			// autofix default-on → no-autofix resolves off (false).
			expect(
				resolvePiLensFlag(
					"no-autofix",
					false,
					loadPiLensGlobalConfig(path.join(home, "nope.json")),
				),
			).toBe(false);
			const configPath = writeConfig(home, JSON.stringify({ widget: {} }));
			expect(
				resolvePiLensFlag(
					"no-autofix",
					false,
					loadPiLensGlobalConfig(configPath),
				),
			).toBe(false);
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

			expect(
				loadPiLensGlobalConfig(configPath)?.autofix?.enabled,
			).toBeUndefined();
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

	// #533: three sibling global scalars used to coerce a present-but-malformed
	// value to undefined SILENTLY, unlike actionableWarnings.autoFix.maxFixes
	// which already warned. These pin down that they now warn on present-invalid
	// input and — the false-positive guard — stay silent when the key is absent.
	describe("malformed global scalar value warns (#533 value-warn parity)", () => {
		function warnedFor(substring: string): boolean {
			return (console.error as ReturnType<typeof vi.fn>).mock.calls
				.flat()
				.some((arg) => typeof arg === "string" && arg.includes(substring));
		}

		it("warns once on a present-but-invalid widget.visible; absent stays silent", () => {
			const home = makeTempHome();
			const badPath = writeConfig(
				home,
				JSON.stringify({ widget: { visible: "yes" } }),
			);
			expect(loadPiLensGlobalConfig(badPath)).toEqual({
				widget: { visible: undefined },
			});
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("widget.visible must be a boolean"),
			);
			const callsAfterFirst = (console.error as ReturnType<typeof vi.fn>).mock
				.calls.length;
			loadPiLensGlobalConfig(badPath);
			expect(
				(console.error as ReturnType<typeof vi.fn>).mock.calls.length,
			).toBe(callsAfterFirst);

			// Absent visible → no warn (false-positive guard).
			const silentHome = makeTempHome();
			const silentPath = writeConfig(
				silentHome,
				JSON.stringify({ widget: {} }),
			);
			loadPiLensGlobalConfig(silentPath);
			expect(warnedFor("widget.visible")).toBe(true);
			(console.error as ReturnType<typeof vi.fn>).mockClear();
			loadPiLensGlobalConfig(silentPath);
			expect(warnedFor("widget.visible")).toBe(false);
		});

		it("warns once on a present-but-invalid format.mode; absent stays silent", () => {
			const home = makeTempHome();
			const badPath = writeConfig(
				home,
				JSON.stringify({ format: { mode: "immedaite" } }), // spellchecker:disable-line
			);
			expect(loadPiLensGlobalConfig(badPath)).toEqual({
				format: { mode: undefined },
			});
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					'format.mode must be "immediate" or "deferred"',
				),
			);

			// A config with only format.enabled (no mode) must NOT warn about mode.
			(console.error as ReturnType<typeof vi.fn>).mockClear();
			const silentHome = makeTempHome();
			const silentPath = writeConfig(
				silentHome,
				JSON.stringify({ format: { enabled: true } }),
			);
			loadPiLensGlobalConfig(silentPath);
			expect(warnedFor("format.mode")).toBe(false);
		});

		it("warns once on a present-but-invalid dispatch.runnerTimeoutFloorMs; absent stays silent", () => {
			const home = makeTempHome();
			const badPath = writeConfig(
				home,
				JSON.stringify({ dispatch: { runnerTimeoutFloorMs: "180000" } }),
			);
			expect(loadPiLensGlobalConfig(badPath)).toEqual({
				dispatch: { runnerTimeoutFloorMs: undefined },
			});
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"dispatch.runnerTimeoutFloorMs must be a positive finite number",
				),
			);

			// An empty dispatch object (no floor key) must NOT warn.
			(console.error as ReturnType<typeof vi.fn>).mockClear();
			const silentHome = makeTempHome();
			const silentPath = writeConfig(
				silentHome,
				JSON.stringify({ dispatch: {} }),
			);
			loadPiLensGlobalConfig(silentPath);
			expect(warnedFor("dispatch.runnerTimeoutFloorMs")).toBe(false);
		});
	});

	describe("resolvePiLensFlagWithSource (#792)", () => {
		it("reports source=cli when an explicit CLI value wins", () => {
			expect(
				resolvePiLensFlagWithSource("no-autofix", true, undefined, undefined),
			).toEqual({ value: true, source: "cli" });
			expect(
				resolvePiLensFlagWithSource(
					"no-autoformat",
					true,
					undefined,
					undefined,
				),
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
				resolvePiLensFlagWithSource(
					"lens-actionable-warning-autofix",
					undefined,
					{
						actionableWarnings: { autoFix: { enabled: true } },
					},
				),
			).toEqual({ value: true, source: "global" });
		});

		it("reports source=default when nothing overrides the built-in default", () => {
			expect(
				resolvePiLensFlagWithSource("no-autofix", false, undefined, undefined),
			).toEqual({ value: false, source: "default" });
			expect(
				resolvePiLensFlagWithSource(
					"no-autoformat",
					false,
					undefined,
					undefined,
				),
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

		it("reports source=env when a registry env binding forces the flag on", () => {
			const spec = getLensFlagSpec("no-lens-context") as LensFlagSpec;
			expect(spec.env).toBe("PI_LENS_NO_CONTEXT_INJECTION");

			process.env.PI_LENS_NO_CONTEXT_INJECTION = "1";
			// Outranks even a global config that explicitly re-enables injection.
			expect(
				resolvePiLensFlagWithSource("no-lens-context", false, {
					contextInjection: { enabled: true },
				}),
			).toEqual({ value: true, source: "env" });

			process.env.PI_LENS_NO_CONTEXT_INJECTION = "0";
			expect(resolvePiLensFlagWithSource("no-lens-context", false, {})).toEqual(
				{ value: false, source: "default" },
			);
		});

		it("resolvePiLensFlag delegates to resolvePiLensFlagWithSource with zero behavior change", () => {
			const globalConfig = { autofix: { enabled: false } };
			const projectConfig = {
				...EMPTY_PROJECT_CONFIG,
				autofix: { enabled: true },
			};
			expect(
				resolvePiLensFlag("no-autofix", false, globalConfig, projectConfig),
			).toBe(
				resolvePiLensFlagWithSource(
					"no-autofix",
					false,
					globalConfig,
					projectConfig,
				).value,
			);
		});
	});

	// #166: the registry is the single source of truth, so coverage is asserted
	// over EVERY entry rather than a hand-picked subset. A new flag with no
	// config wiring fails here the moment it lands.
	describe("flag registry coverage (#166)", () => {
		it.each(LENS_FLAGS.map((spec) => [spec.name, spec] as const))(
			"%s is settable from config.json and reports source=global",
			(_name, spec) => {
				const config = configFor(spec.configKey, enablingConfigValue(spec));
				expect(resolvePiLensFlagWithSource(spec.name, false, config)).toEqual({
					value: true,
					source: "global",
				});
			},
		);

		it.each(LENS_FLAGS.map((spec) => [spec.name, spec] as const))(
			"%s falls back to its registry default when config is silent",
			(_name, spec) => {
				expect(resolvePiLensFlagWithSource(spec.name, false, {})).toEqual({
					value: spec.default,
					source: "default",
				});
				expect(
					resolvePiLensFlagWithSource(spec.name, undefined, undefined),
				).toEqual({ value: spec.default, source: "default" });
			},
		);

		it.each(LENS_FLAGS.map((spec) => [spec.name, spec] as const))(
			"%s honors an explicit CLI value over config.json",
			(_name, spec) => {
				const disabling = configFor(
					spec.configKey,
					spec.name === "immediate-format" ? "deferred" : spec.negated,
				);
				expect(resolvePiLensFlagWithSource(spec.name, true, disabling)).toEqual(
					{ value: true, source: "cli" },
				);
			},
		);

		// The gap this issue reported: seven flags were registered on the CLI but
		// fell straight through the resolver, so config.json could never set them.
		it.each([
			["no-lens", "lens"],
			["no-lsp", "lsp"],
			["no-tests", "tests"],
			["no-delta", "delta"],
			["no-opengrep", "opengrep"],
			["no-read-guard", "readGuard"],
		] as const)(
			"%s is disabled by %s.enabled=false in the parsed global config",
			(flag, section) => {
				const home = makeTempHome();
				const configPath = writeConfig(
					home,
					JSON.stringify({ [section]: { enabled: false } }),
				);

				const config = loadPiLensGlobalConfig(configPath);
				expect(config).toEqual({ [section]: { enabled: false } });
				expect(resolvePiLensFlag(flag, false, config)).toBe(true);
				// enabled=true is the built-in behavior, so the flag stays off.
				expect(
					resolvePiLensFlag(flag, false, { [section]: { enabled: true } }),
				).toBe(false);
			},
		);

		it("lens-guard is enabled by guard.enabled=true (the one positive backfill)", () => {
			const home = makeTempHome();
			const configPath = writeConfig(
				home,
				JSON.stringify({ guard: { enabled: true } }),
			);

			const config = loadPiLensGlobalConfig(configPath);
			expect(config).toEqual({ guard: { enabled: true } });
			expect(resolvePiLensFlag("lens-guard", false, config)).toBe(true);
			expect(
				resolvePiLensFlag("lens-guard", false, { guard: { enabled: false } }),
			).toBe(false);
		});

		it("parses every registry key out of one config.json", () => {
			const home = makeTempHome();
			const raw: Record<string, unknown> = {};
			for (const spec of LENS_FLAGS) {
				const segments = spec.configKey.split(".");
				let node = raw;
				for (const segment of segments.slice(0, -1)) {
					node[segment] ??= {};
					node = node[segment] as Record<string, unknown>;
				}
				node[segments[segments.length - 1]] = enablingConfigValue(spec);
			}
			const configPath = writeConfig(home, JSON.stringify(raw));

			const config = loadPiLensGlobalConfig(configPath);
			for (const spec of LENS_FLAGS) {
				expect(
					resolvePiLensFlag(spec.name, false, config),
					`flag: ${spec.name}`,
				).toBe(true);
			}
		});

		it("warns once and ignores a non-boolean value at any registry key", () => {
			const home = makeTempHome();
			const configPath = writeConfig(
				home,
				JSON.stringify({ lsp: { enabled: "no" }, guard: 7 }),
			);

			const config = loadPiLensGlobalConfig(configPath);
			expect(config?.lsp?.enabled).toBeUndefined();
			expect(config?.guard).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("lsp.enabled must be a boolean"),
			);
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("guard must be an object"),
			);
			expect(resolvePiLensFlag("no-lsp", false, config)).toBe(false);
			expect(resolvePiLensFlag("lens-guard", false, config)).toBe(false);

			const callsAfterFirst = (console.error as ReturnType<typeof vi.fn>).mock
				.calls.length;
			loadPiLensGlobalConfig(configPath);
			expect(
				(console.error as ReturnType<typeof vi.fn>).mock.calls.length,
			).toBe(callsAfterFirst);
		});

		// Documented in globalconfig.md since #792, but no loader read it until
		// #166 — agent_end always used the hardcoded default of 5.
		it("parses actionableWarnings.autoFix.maxFixes", () => {
			const home = makeTempHome();
			const configPath = writeConfig(
				home,
				JSON.stringify({ actionableWarnings: { autoFix: { maxFixes: 12 } } }),
			);

			expect(loadPiLensGlobalConfig(configPath)).toEqual({
				actionableWarnings: { autoFix: { maxFixes: 12 } },
			});
			expect(getGlobalActionableWarningMaxFixes(configPath)).toBe(12);
		});

		it("accepts maxFixes=0 as 'report but fix nothing', not as absent", () => {
			const home = makeTempHome();
			const configPath = writeConfig(
				home,
				JSON.stringify({
					actionableWarnings: { autoFix: { enabled: true, maxFixes: 0 } },
				}),
			);

			expect(getGlobalActionableWarningMaxFixes(configPath)).toBe(0);
			// The toggle beside it still resolves normally.
			expect(
				resolvePiLensFlag(
					"lens-actionable-warning-autofix",
					false,
					loadPiLensGlobalConfig(configPath),
				),
			).toBe(true);
		});

		it("warns once and ignores a negative or non-numeric maxFixes", () => {
			const home = makeTempHome();
			const negativePath = writeConfig(
				home,
				JSON.stringify({ actionableWarnings: { autoFix: { maxFixes: -1 } } }),
			);
			expect(getGlobalActionableWarningMaxFixes(negativePath)).toBeUndefined();

			const stringPath = writeConfig(
				home,
				JSON.stringify({ actionableWarnings: { autoFix: { maxFixes: "5" } } }),
			);
			expect(getGlobalActionableWarningMaxFixes(stringPath)).toBeUndefined();
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"actionableWarnings.autoFix.maxFixes must be a non-negative finite number",
				),
			);
		});

		it("defaults maxFixes to undefined so the caller's built-in 5 applies", () => {
			const home = makeTempHome();
			const configPath = writeConfig(
				home,
				JSON.stringify({ actionableWarnings: { autoFix: { enabled: true } } }),
			);
			expect(getGlobalActionableWarningMaxFixes(configPath)).toBeUndefined();
			expect(
				getGlobalActionableWarningMaxFixes(path.join(home, "nope.json")),
			).toBeUndefined();
		});

		it("only project-scoped flags read .pi-lens.json", () => {
			const projectScoped = LENS_FLAGS.filter(
				(spec) => spec.scope === "project",
			).map((spec) => spec.name);
			expect(projectScoped).toEqual([
				"no-autoformat",
				"no-autofix",
				"lens-actionable-warning-autofix",
				"no-knip",
				"no-jscpd",
				"no-madge",
				"no-gitleaks",
				"no-govulncheck",
				"no-dead-code",
				"no-complexity",
			]);

			// A global-scoped key sitting in a project config decides nothing.
			const projectConfig = {
				...EMPTY_PROJECT_CONFIG,
				raw: { lsp: { enabled: false } },
			};
			expect(
				resolvePiLensFlagWithSource("no-lsp", false, undefined, projectConfig),
			).toEqual({ value: false, source: "default" });
		});
	});
});
