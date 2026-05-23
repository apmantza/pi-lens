import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type PiLensFormatMode = "deferred" | "immediate";

export interface PiLensGlobalConfig {
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
		const formatMode =
			format?.mode === "immediate" || format?.mode === "deferred"
				? format.mode
				: undefined;

		return {
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
		};
	} catch {
		return undefined;
	}
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
	return value;
}
