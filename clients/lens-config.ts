import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseEnabledShape } from "./config-enabled-shape.js";
import type { PiLensProjectConfig } from "./project-lens-config.js";

export type PiLensFormatMode = "deferred" | "immediate";

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
	console.error(
		`[pi-lens] ignoring invalid global config ${configPath}: ${reason}`,
	);
}

/** For tests that need to force the warn-once cache to reset between cases. */
export function resetGlobalConfigWarnCache(): void {
	warnedInvalidGlobalConfigs.clear();
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
		const dispatchRaw = raw.dispatch;
		const dispatch =
			dispatchRaw && typeof dispatchRaw === "object"
				? (dispatchRaw as Record<string, unknown>)
				: undefined;
		const widgetRaw = raw.widget;
		const widget =
			widgetRaw && typeof widgetRaw === "object"
				? (widgetRaw as Record<string, unknown>)
				: undefined;
		const format = parseEnabledShape(raw.format, "format", warnInvalid);
		const autofix = parseEnabledShape(raw.autofix, "autofix", warnInvalid);
		const formatModeRaw = raw.format;
		const formatModeSource =
			formatModeRaw && typeof formatModeRaw === "object"
				? (formatModeRaw as Record<string, unknown>)
				: undefined;
		const actionableWarningsRaw = raw.actionableWarnings;
		const actionableWarnings =
			actionableWarningsRaw && typeof actionableWarningsRaw === "object"
				? (actionableWarningsRaw as Record<string, unknown>)
				: undefined;
		const actionableWarningsAutoFix = parseEnabledShape(
			actionableWarnings?.autoFix,
			"actionableWarnings.autoFix",
			warnInvalid,
		);
		const contextInjectionRaw = raw.contextInjection;
		const contextInjection =
			contextInjectionRaw && typeof contextInjectionRaw === "object"
				? (contextInjectionRaw as Record<string, unknown>)
				: undefined;
		const turnSummaryRaw = raw.turnSummary;
		const turnSummary =
			turnSummaryRaw && typeof turnSummaryRaw === "object"
				? (turnSummaryRaw as Record<string, unknown>)
				: undefined;
		const formatMode =
			formatModeSource?.mode === "immediate" ||
			formatModeSource?.mode === "deferred"
				? (formatModeSource.mode as PiLensFormatMode)
				: undefined;
		const ignore = Array.isArray(raw.ignore)
			? raw.ignore.filter((p): p is string => typeof p === "string")
			: undefined;

		return {
			ignore: ignore && ignore.length > 0 ? ignore : undefined,
			dispatch: dispatch
				? {
						runnerTimeoutFloorMs:
							typeof dispatch.runnerTimeoutFloorMs === "number" &&
							Number.isFinite(dispatch.runnerTimeoutFloorMs) &&
							dispatch.runnerTimeoutFloorMs > 0
								? dispatch.runnerTimeoutFloorMs
								: undefined,
					}
				: undefined,
			widget: widget
				? {
						visible:
							typeof widget.visible === "boolean" ? widget.visible : undefined,
					}
				: undefined,
			format: format
				? {
						enabled: format.enabled,
						mode: formatMode,
					}
				: undefined,
			autofix: autofix ? { enabled: autofix.enabled } : undefined,
			actionableWarnings: actionableWarnings
				? {
						enabled:
							typeof actionableWarnings.enabled === "boolean"
								? actionableWarnings.enabled
								: undefined,
						includeLspCodeActions:
							typeof actionableWarnings.includeLspCodeActions === "boolean"
								? actionableWarnings.includeLspCodeActions
								: undefined,
						deltaOnly:
							typeof actionableWarnings.deltaOnly === "boolean"
								? actionableWarnings.deltaOnly
								: undefined,
						autoFix: actionableWarningsAutoFix
							? { enabled: actionableWarningsAutoFix.enabled }
							: undefined,
					}
				: undefined,
			contextInjection: contextInjection
				? {
						enabled:
							typeof contextInjection.enabled === "boolean"
								? contextInjection.enabled
								: undefined,
					}
				: undefined,
			turnSummary: turnSummary
				? {
						enabled:
							typeof turnSummary.enabled === "boolean"
								? turnSummary.enabled
								: undefined,
					}
				: undefined,
		};
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

export function getGlobalAutoformatEnabled(configPath?: string): boolean {
	return loadPiLensGlobalConfig(configPath)?.format?.enabled !== false;
}

export function getGlobalAutofixEnabled(configPath?: string): boolean {
	return loadPiLensGlobalConfig(configPath)?.autofix?.enabled !== false;
}

export function getGlobalImmediateFormatDefault(configPath?: string): boolean {
	return loadPiLensGlobalConfig(configPath)?.format?.mode === "immediate";
}

export function getGlobalContextInjectionEnabled(configPath?: string): boolean {
	return (
		loadPiLensGlobalConfig(configPath)?.contextInjection?.enabled !== false
	);
}

export function getGlobalTurnSummaryEnabled(configPath?: string): boolean {
	return loadPiLensGlobalConfig(configPath)?.turnSummary?.enabled === true;
}

/** Which tier decided a resolved flag's value — for provenance in debug/skip logs (#792). */
export type PiLensFlagSource = "cli" | "project" | "global" | "default";

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
 * Precedence (unchanged, maintainer decision — project wins over global,
 * including re-enabling; only an explicit CLI disabling flag outranks
 * project config): cli → project → global → default.
 */
export function resolvePiLensFlagWithSource(
	name: string,
	value: boolean | string | undefined,
	config: PiLensGlobalConfig | undefined,
	projectConfig?: PiLensProjectConfig,
): ResolvedPiLensFlag {
	if (value) return { value, source: "cli" };
	if (name === "no-autoformat") {
		if (projectConfig?.format?.enabled !== undefined) {
			return { value: !projectConfig.format.enabled, source: "project" };
		}
		if (config?.format?.enabled === false) {
			return { value: true, source: "global" };
		}
		return { value: false, source: "default" };
	}
	if (name === "no-autofix") {
		if (projectConfig?.autofix?.enabled !== undefined) {
			return { value: !projectConfig.autofix.enabled, source: "project" };
		}
		if (config?.autofix?.enabled === false) {
			return { value: true, source: "global" };
		}
		return { value: false, source: "default" };
	}
	if (name === "immediate-format") {
		const immediate = config?.format?.mode === "immediate";
		return { value: immediate, source: immediate ? "global" : "default" };
	}
	if (name === "lens-actionable-warnings") {
		const enabled = config?.actionableWarnings?.enabled === true;
		return { value: enabled, source: enabled ? "global" : "default" };
	}
	if (name === "lens-actionable-warning-actions") {
		const enabled = config?.actionableWarnings?.includeLspCodeActions === true;
		return { value: enabled, source: enabled ? "global" : "default" };
	}
	if (name === "lens-actionable-warning-autofix") {
		if (projectConfig?.actionableWarnings?.autoFix?.enabled !== undefined) {
			return {
				value: projectConfig.actionableWarnings.autoFix.enabled,
				source: "project",
			};
		}
		const enabled = config?.actionableWarnings?.autoFix?.enabled === true;
		return { value: enabled, source: enabled ? "global" : "default" };
	}
	if (name === "lens-actionable-warning-all") {
		const all = config?.actionableWarnings?.deltaOnly === false;
		return { value: all, source: all ? "global" : "default" };
	}
	if (name === "no-lens-context") {
		const disabled = config?.contextInjection?.enabled === false;
		return { value: disabled, source: disabled ? "global" : "default" };
	}
	if (name === "lens-turn-summary") {
		const enabled = config?.turnSummary?.enabled === true;
		return { value: enabled, source: enabled ? "global" : "default" };
	}
	return { value, source: "default" };
}

export function resolvePiLensFlag(
	name: string,
	value: boolean | string | undefined,
	config: PiLensGlobalConfig | undefined,
	projectConfig?: PiLensProjectConfig,
): boolean | string | undefined {
	return resolvePiLensFlagWithSource(name, value, config, projectConfig).value;
}
