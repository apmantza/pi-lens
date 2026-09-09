/** Shared resolver for model-facing tool availability (#2800). */

import { readFlagConfigValue } from "./lens-flag-registry.js";

/** The extension tool names that may be controlled by `tools.<name>.enabled`. */
export const LENS_TOOL_NAMES = [
	"ast_grep_search",
	"ast_grep_replace",
	"ast_grep_outline",
	"ast_grep_dump",
	"lsp_navigation",
	"lsp_diagnostics",
	"lens_diagnostics",
	"lens_diagnostic_mark",
	"symbol_search",
	"module_report",
	"project_report",
	"read_symbol",
	"read_enclosing",
	"effective_config",
] as const;

export type LensToolName = (typeof LENS_TOOL_NAMES)[number];

/** Resolve one tool. CLI names are comma-separated to support repeatable flags. */
export function resolveLensToolEnabled(
	name: string,
	globalConfig: unknown,
	projectConfig: unknown,
	cliNoTools?: string | readonly string[],
): boolean {
	const cliNames = Array.isArray(cliNoTools)
		? cliNoTools
		: typeof cliNoTools === "string"
			? cliNoTools.split(",")
			: [];
	if (cliNames.some((entry) => entry.trim() === name)) return false;
	const project = readFlagConfigValue(projectConfig, `tools.${name}.enabled`);
	if (project !== undefined) return project;
	const global = readFlagConfigValue(globalConfig, `tools.${name}.enabled`);
	return global ?? true;
}

/** Copy and validate the known per-tool leaves from one config document. */
export function readToolConfig(
	raw: unknown,
	warnInvalid: (reason: string) => void,
): Record<string, { enabled?: boolean }> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const section = (raw as Record<string, unknown>).tools;
	if (!section || typeof section !== "object" || Array.isArray(section))
		return undefined;
	const result: Record<string, { enabled?: boolean }> = {};
	for (const [name, value] of Object.entries(section)) {
		if (name === "lazy") continue;
		if (!(LENS_TOOL_NAMES as readonly string[]).includes(name)) {
			warnInvalid(
				`unknown key "tools.${name}.enabled" is not a recognized pi-lens tool`,
			);
			continue;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			warnInvalid(`tools.${name} must be an object with enabled`);
			continue;
		}
		const enabled = (value as Record<string, unknown>).enabled;
		if (enabled !== undefined && typeof enabled !== "boolean") {
			warnInvalid(`tools.${name}.enabled must be a boolean`);
			continue;
		}
		result[name] = enabled === undefined ? {} : { enabled };
	}
	return Object.keys(result).length > 0 ? result : undefined;
}
