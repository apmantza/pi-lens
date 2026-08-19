import { logExtension } from "./extension-log.js";
import { notifyUserDegradation } from "./user-notify.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	assignFlagConfigSection,
	flagConfigSectionKeys,
	flagValueFromConfig,
	getLensFlagSpec,
	GLOBAL_NON_FLAG_CONFIG_SECTIONS,
	LENS_FLAGS,
	readFlagConfigValue,
} from "./lens-flag-registry.js";
import {
	findNestedProjectMutationValue,
	type PiLensProjectConfig,
} from "./project-lens-config.js";

export type PiLensFormatMode = "deferred" | "immediate";

/** The `{ enabled?: boolean }` section every registry flag key lives under. */
export interface PiLensToggleConfig {
	enabled?: boolean;
}

export interface PiLensGlobalConfig {
	/**
	 * Gitignore-style patterns excluded from pi-lens scans across ALL projects.
	 * Merged at LOWEST precedence: a project `.gitignore` or `.pi-lens.json`
	 * `ignore` (including `!negation`) overrides these. See #252.
	 */
	ignore?: string[];
	dispatch?: {
		/**
		 * Minimum wall-clock budget (ms) for every dispatch runner.
		 * Acts as a floor: effective timeout = max(runner.timeoutMs ?? 30_000, runnerTimeoutFloorMs).
		 * Useful for large monorepos where slow toolchains (e.g. cargo clippy) exceed
		 * any runner's declared budget. Also overridable via PI_LENS_RUNNER_TIMEOUT_FLOOR_MS.
		 */
		runnerTimeoutFloorMs?: number;
	};
	widget?: {
		/** Whether the diagnostics widget is visible when a session starts. */
		visible?: boolean;
	};
	/** Whether pi-lens runs at all this session (`--no-lens`). */
	lens?: PiLensToggleConfig;
	/** Whether unified LSP diagnostics run (`--no-lsp`). */
	lsp?: PiLensToggleConfig;
	/** Whether the test runner fires on write (`--no-tests`). */
	tests?: PiLensToggleConfig;
	/** Whether delta mode limits diagnostics to new ones (`--no-delta`). */
	delta?: PiLensToggleConfig;
	/** Whether the experimental commit/push blocker runs (`--lens-guard`). */
	guard?: PiLensToggleConfig;
	/** Whether the Opengrep auxiliary LSP attaches (`--no-opengrep`). */
	opengrep?: PiLensToggleConfig;
	/** Whether the read-before-edit behavior monitor runs (`--no-read-guard`). */
	readGuard?: PiLensToggleConfig;
	format?: {
		/** Whether auto-formatting is enabled. */
		enabled?: boolean;
		/** When to run auto-formatting after write/edit tool results. */
		mode?: PiLensFormatMode;
	};
	autofix?: {
		/**
		 * Whether the pipeline may apply deterministic linter fixes (Biome,
		 * Ruff, ESLint, ...). Defaults true. A project `.pi-lens.json`
		 * `autofix.enabled` overrides this in either direction (#792).
		 */
		enabled?: boolean;
	};
	actionableWarnings?: {
		/** Write turn-delta fixable warning reports and inject a short advisory. */
		enabled?: boolean;
		/** Enrich warning reports with LSP code-action titles. */
		includeLspCodeActions?: boolean;
		/** Restrict reporting to warnings introduced by this turn. */
		deltaOnly?: boolean;
		autoFix?: {
			/** Experimental conservative agent_end warning autofix. Defaults false. */
			enabled?: boolean;
			/**
			 * Cap on quickfixes applied per turn. Defaults 5. `0` keeps the report
			 * but applies nothing. Documented since #792 but only wired up in #166.
			 */
			maxFixes?: number;
		};
	};
	contextInjection?: {
		/**
		 * Whether pi-lens prepends automatic findings (session-start guidance,
		 * turn-end findings, test findings) into the next model turn via the
		 * `context` hook. Defaults true. Set false to keep tools/LSP/read-guard/
		 * formatting running while avoiding prompt-cache invalidation from injected
		 * messages. Findings are still cached for `lens_diagnostics` / `/lens-health`.
		 */
		enabled?: boolean;
		/**
		 * How findings are delivered when enabled. `"inject"` (default) prepends
		 * findings into the transcript via the `context` hook. `"steer"` sends
		 * findings as a steer message via `pi.sendUserMessage` so they land after
		 * the current assistant turn finishes its tool calls instead of interrupting
		 * the prompt cache.
		 */
		mode?: "inject" | "steer";
	};
	turnSummary?: {
		/**
		 * Opt-in, transcript-persistent per-turn summary of diagnostics found,
		 * autofixes applied, and autoformats applied (#484). Defaults false —
		 * absence of this key means off. One collapsed/expandable entry per turn,
		 * only emitted when the turn's collection is non-empty.
		 */
		enabled?: boolean;
	};
}

export function getPiLensGlobalConfigPath(homeDir = os.homedir()): string {
	const override = process.env.PI_LENS_CONFIG_PATH;
	if (override) return path.resolve(override);
	return path.join(homeDir, ".pi-lens", "config.json");
}

const warnedInvalidGlobalConfigs = new Set<string>();

/**
 * Same warn-once-per-(path, reason) contract as project-lens-config.ts's
 * `warnInvalidConfigOnce` — a malformed global config value is logged once
 * and then treated as absent, rather than silently dropped (#792).
 */
function warnInvalidGlobalConfigOnce(configPath: string, reason: string): void {
	const key = `${configPath}:${reason}`;
	if (warnedInvalidGlobalConfigs.has(key)) return;
	warnedInvalidGlobalConfigs.add(key);
	const message = `ignoring invalid global config ${configPath}: ${reason}`;
	logExtension({
		subsystem: "lens-config",
		level: "warn",
		message,
		metadata: { configPath, reason },
	});
	// HUMAN-audience too: a config the user wrote is being ignored. Routed
	// through the host's own render path (#1333), never a raw write.
	notifyUserDegradation(`pi-lens: ${message}`);
}

/** For tests that need to force the warn-once cache to reset between cases. */
export function resetGlobalConfigWarnCache(): void {
	warnedInvalidGlobalConfigs.clear();
}

function asConfigObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function loadPiLensGlobalConfig(
	configPath = getPiLensGlobalConfigPath(),
): PiLensGlobalConfig | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;

		const raw = parsed as Record<string, unknown>;
		const warnInvalid = (reason: string) =>
			warnInvalidGlobalConfigOnce(configPath, reason);
		const config: Record<string, unknown> = {};

		for (const spec of LENS_FLAGS) {
			if (spec.readGlobal) continue;
			assignFlagConfigSection(raw, config, spec.configKey, warnInvalid);
		}

		const ignore = Array.isArray(raw.ignore)
			? raw.ignore.filter((p): p is string => typeof p === "string")
			: undefined;
		if (ignore && ignore.length > 0) config.ignore = ignore;

		const dispatch = asConfigObject(raw.dispatch);
		if (dispatch) {
			const floor = dispatch.runnerTimeoutFloorMs;
			if (typeof floor === "number" && Number.isFinite(floor) && floor > 0) {
				config.dispatch = { runnerTimeoutFloorMs: floor };
			} else {
				// #533: warn only when the key is PRESENT but malformed — an absent
				// key stays silent so a config that never mentions it is not falsely
				// flagged. Same warn-once path as the maxFixes case below.
				if ("runnerTimeoutFloorMs" in dispatch) {
					warnInvalid(
						"dispatch.runnerTimeoutFloorMs must be a positive finite number",
					);
				}
				config.dispatch = { runnerTimeoutFloorMs: undefined };
			}
		}

		const autoFix = asConfigObject(
			asConfigObject(raw.actionableWarnings)?.autoFix,
		);
		if (autoFix && "maxFixes" in autoFix) {
			if (
				typeof autoFix.maxFixes === "number" &&
				Number.isFinite(autoFix.maxFixes) &&
				autoFix.maxFixes >= 0
			) {
				config.actionableWarnings ??= {};
				const warnings = config.actionableWarnings as Record<string, unknown>;
				warnings.autoFix ??= {};
				(warnings.autoFix as Record<string, unknown>).maxFixes = Math.floor(
					autoFix.maxFixes,
				);
			} else {
				warnInvalid(
					"actionableWarnings.autoFix.maxFixes must be a non-negative finite number",
				);
			}
		}

		const widget = asConfigObject(raw.widget);
		if (widget) {
			if (typeof widget.visible === "boolean") {
				config.widget = { visible: widget.visible };
			} else {
				// #533: present-but-wrong-type warns; absent stays silent.
				if ("visible" in widget) {
					warnInvalid("widget.visible must be a boolean");
				}
				config.widget = { visible: undefined };
			}
		}

		const format = asConfigObject(raw.format);
		if (format) {
			config.format ??= {};
			const formatSection = config.format as Record<string, unknown>;
			if (format.mode === "immediate" || format.mode === "deferred") {
				formatSection.mode = format.mode;
			} else {
				// #533: a present-but-invalid mode (e.g. "immedaite") warns and
				// falls back; an absent mode stays silent.
				if ("mode" in format) {
					warnInvalid('format.mode must be "immediate" or "deferred"');
				}
				formatSection.mode = undefined;
			}
		}

		const contextInjection = asConfigObject(raw.contextInjection);
		if (contextInjection) {
			config.contextInjection ??= {};
			const ciSection = config.contextInjection as Record<string, unknown>;
			if (
				contextInjection.mode === "inject" ||
				contextInjection.mode === "steer"
			) {
				ciSection.mode = contextInjection.mode;
			} else {
				// #533: a present-but-invalid mode warns and falls back; an
				// absent mode stays silent.
				if ("mode" in contextInjection) {
					warnInvalid('contextInjection.mode must be "inject" or "steer"');
				}
				ciSection.mode = undefined;
			}
		}

		// #533 hygiene: a completely unknown top-level key (e.g. a typo like
		// `lps` for `lsp`) is otherwise dropped silently, so a setting the user
		// thought they made does nothing with no signal. Warn once per key. The
		// recognized set is single-sourced (#883): the flag sections derived
		// from the registry plus the declared non-flag global sections
		// (`GLOBAL_NON_FLAG_CONFIG_SECTIONS`, which co-locates `$schema` and the
		// hand-parsed namespaces beside the registry). Adding a flag needs no
		// edit here; adding a namespace is a one-line edit in that one constant.
		const knownGlobalConfigKeys = new Set<string>([
			...flagConfigSectionKeys(LENS_FLAGS),
			...GLOBAL_NON_FLAG_CONFIG_SECTIONS,
		]);
		for (const key of Object.keys(raw)) {
			if (!knownGlobalConfigKeys.has(key)) {
				warnInvalid(
					`unknown key "${key}" is not a recognized pi-lens setting (check for a typo); ignored`,
				);
			}
		}

		return config as PiLensGlobalConfig;
	} catch {
		return undefined;
	}
}

export function getGlobalIgnorePatterns(configPath?: string): string[] {
	return loadPiLensGlobalConfig(configPath)?.ignore ?? [];
}

export function getGlobalWidgetDefaultVisible(configPath?: string): boolean {
	return loadPiLensGlobalConfig(configPath)?.widget?.visible !== false;
}

/** Per-turn quickfix cap; undefined means "use the built-in default of 5". */
export function getGlobalActionableWarningMaxFixes(
	configPath?: string,
): number | undefined {
	return loadPiLensGlobalConfig(configPath)?.actionableWarnings?.autoFix
		?.maxFixes;
}

/** Which tier decided a resolved flag's value — for provenance in debug/skip logs (#792). */
export type PiLensFlagSource =
	| "env"
	| "cli"
	| "project"
	| `nested-project:${string}`
	| "global"
	| "default";

export interface ResolvedPiLensFlag {
	value: boolean | string | undefined;
	source: PiLensFlagSource;
}

/**
 * Resolve a flag AND report which config tier decided it — same precedence
 * as {@link resolvePiLensFlag} (which now delegates here), just also
 * returning the `source` so callers can log e.g.
 * "(--no-autofix, source=project)" instead of a bare boolean (#792).
 *
 * Every tier is driven by `clients/lens-flag-registry.ts` (#166): the spec's
 * `configKey` is read out of each config object rather than matched by a
 * per-flag branch, so a new toggle needs no change here at all.
 *
 * Precedence: env → cli → nested-project → project → global → default.
 * Project tiers apply to `scope: "project"` flags only (maintainer decision —
 * project wins over global, including re-enabling; only an explicit CLI
 * disabling flag outranks project config). A name with no registry entry
 * passes its CLI value straight through, which is how untyped string flags
 * like `--lens-opengrep-config` keep working.
 */
export function resolvePiLensFlagWithSource(
	name: string,
	value: boolean | string | undefined,
	config: PiLensGlobalConfig | undefined,
	projectConfig?: PiLensProjectConfig,
	editedFilePath?: string,
	projectRoot?: string,
): ResolvedPiLensFlag {
	const spec = getLensFlagSpec(name);
	if (spec?.env && process.env[spec.env] === "1") {
		return { value: true, source: "env" };
	}
	if (value) return { value, source: "cli" };
	if (!spec) return { value, source: "default" };

	if (spec.scope === "project") {
		const nested =
			editedFilePath && projectRoot
				? findNestedProjectMutationValue(spec, editedFilePath, projectRoot)
				: undefined;
		if (nested) {
			return {
				value: flagValueFromConfig(spec, nested.value),
				source:
					path.resolve(nested.dir) === path.resolve(projectRoot as string)
						? "project"
						: (`nested-project:${nested.dir}` as const),
			};
		}
		const projectValue = readFlagConfigValue(projectConfig, spec.configKey);
		if (projectValue !== undefined) {
			return {
				value: flagValueFromConfig(spec, projectValue),
				source: "project",
			};
		}
	}

	const globalValue = spec.readGlobal
		? spec.readGlobal((config ?? {}) as Record<string, unknown>)
		: readFlagConfigValue(config, spec.configKey);
	if (globalValue !== undefined) {
		return { value: flagValueFromConfig(spec, globalValue), source: "global" };
	}

	return { value: spec.default, source: "default" };
}

export function resolvePiLensFlag(
	name: string,
	value: boolean | string | undefined,
	config: PiLensGlobalConfig | undefined,
	projectConfig?: PiLensProjectConfig,
	editedFilePath?: string,
	projectRoot?: string,
): boolean | string | undefined {
	return resolvePiLensFlagWithSource(
		name,
		value,
		config,
		projectConfig,
		editedFilePath,
		projectRoot,
	).value;
}
