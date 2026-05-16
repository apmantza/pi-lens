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
	return value;
}
