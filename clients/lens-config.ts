import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

export function loadPiLensGlobalConfig(
	configPath = getPiLensGlobalConfigPath(),
): PiLensGlobalConfig | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;

		const raw = parsed as Record<string, unknown>;
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
		const formatRaw = raw.format;
		const format =
			formatRaw && typeof formatRaw === "object"
				? (formatRaw as Record<string, unknown>)
				: undefined;
		const actionableWarningsRaw = raw.actionableWarnings;
		const actionableWarnings =
			actionableWarningsRaw && typeof actionableWarningsRaw === "object"
				? (actionableWarningsRaw as Record<string, unknown>)
				: undefined;
		const actionableWarningsAutoFixRaw = actionableWarnings?.autoFix;
		const actionableWarningsAutoFix =
			actionableWarningsAutoFixRaw &&
			typeof actionableWarningsAutoFixRaw === "object"
				? (actionableWarningsAutoFixRaw as Record<string, unknown>)
				: undefined;
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
			format?.mode === "immediate" || format?.mode === "deferred"
				? format.mode
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
						enabled:
							typeof format.enabled === "boolean" ? format.enabled : undefined,
						mode: formatMode,
					}
				: undefined,
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
							? {
									enabled:
										typeof actionableWarningsAutoFix.enabled === "boolean"
											? actionableWarningsAutoFix.enabled
											: undefined,
								}
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

export function resolvePiLensFlag(
	name: string,
	value: boolean | string | undefined,
	config: PiLensGlobalConfig | undefined,
): boolean | string | undefined {
	if (value) return value;
	if (name === "no-autoformat") {
		return config?.format?.enabled === false;
	}
	if (name === "immediate-format") {
		return config?.format?.mode === "immediate";
	}
	if (name === "lens-actionable-warnings") {
		return config?.actionableWarnings?.enabled === true;
	}
	if (name === "lens-actionable-warning-actions") {
		return config?.actionableWarnings?.includeLspCodeActions === true;
	}
	if (name === "lens-actionable-warning-autofix") {
		return config?.actionableWarnings?.autoFix?.enabled === true;
	}
	if (name === "lens-actionable-warning-all") {
		return config?.actionableWarnings?.deltaOnly === false;
	}
	if (name === "no-lens-context") {
		return config?.contextInjection?.enabled === false;
	}
	if (name === "lens-turn-summary") {
		return config?.turnSummary?.enabled === true;
	}
	return value;
}
