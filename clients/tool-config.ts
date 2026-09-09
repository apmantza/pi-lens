/** Shared resolver for model-facing tool availability (#2800). */

import { readFlagConfigValue } from "./lens-flag-registry.js";

/** The complete model-facing tool population on pi and MCP. */
export const TOOL_REGISTRY = [
	{
		name: "ast_grep_search",
		piName: "ast_grep_search",
		mcpName: "pilens_ast_grep_search",
		disableable: true,
	},
	{
		name: "ast_grep_replace",
		piName: "ast_grep_replace",
		mcpName: "pilens_ast_grep_replace",
		disableable: true,
	},
	{
		name: "ast_grep_outline",
		piName: "ast_grep_outline",
		mcpName: undefined,
		disableable: true,
	},
	{
		name: "lsp_navigation",
		piName: "lsp_navigation",
		mcpName: "pilens_lsp_navigation",
		disableable: true,
	},
	{
		name: "lsp_diagnostics",
		piName: "lsp_diagnostics",
		mcpName: "pilens_lsp_diagnostics",
		disableable: true,
	},
	{
		name: "lens_diagnostics",
		piName: "lens_diagnostics",
		mcpName: "pilens_diagnostics",
		disableable: true,
	},
	{
		name: "lens_diagnostic_mark",
		piName: "lens_diagnostic_mark",
		mcpName: undefined,
		disableable: true,
	},
	{
		name: "symbol_search",
		piName: "symbol_search",
		mcpName: "pilens_symbol_search",
		disableable: true,
	},
	{
		name: "module_report",
		piName: "module_report",
		mcpName: "pilens_module_report",
		disableable: true,
	},
	{
		name: "project_report",
		piName: "project_report",
		mcpName: "pilens_project_report",
		disableable: true,
	},
	{
		name: "read_symbol",
		piName: "read_symbol",
		mcpName: "pilens_read_symbol",
		disableable: true,
	},
	{
		name: "read_enclosing",
		piName: "read_enclosing",
		mcpName: "pilens_read_enclosing",
		disableable: true,
	},
	{
		name: "effective_config",
		piName: "effective_config",
		mcpName: "pilens_effective_config",
		disableable: true,
	},
	{
		name: "pi_lens_activate_tools",
		piName: "pi_lens_activate_tools",
		mcpName: undefined,
		disableable: false,
	},
	{
		name: "analyze",
		piName: undefined,
		mcpName: "pilens_analyze",
		disableable: true,
	},
	{
		name: "health",
		piName: undefined,
		mcpName: "pilens_health",
		disableable: true,
	},
	{
		name: "latency",
		piName: undefined,
		mcpName: "pilens_latency",
		disableable: true,
	},
	{
		name: "project_scan",
		piName: undefined,
		mcpName: "pilens_project_scan",
		disableable: true,
	},
	{
		name: "rebuild",
		piName: undefined,
		mcpName: "pilens_rebuild",
		disableable: true,
	},
	{
		name: "session_start",
		piName: undefined,
		mcpName: "pilens_session_start",
		disableable: false,
	},
	{
		name: "turn_end",
		piName: undefined,
		mcpName: "pilens_turn_end",
		disableable: false,
	},
] as const;

export const LENS_TOOL_NAMES = TOOL_REGISTRY.map(
	(tool) => tool.name,
) as readonly string[];

export type ToolRegistryEntry = (typeof TOOL_REGISTRY)[number];

export function toolRegistryEntryForPi(
	name: string,
): ToolRegistryEntry | undefined {
	return TOOL_REGISTRY.find((tool) => tool.piName === name);
}

export function toolRegistryEntryForMcp(
	name: string,
): ToolRegistryEntry | undefined {
	return TOOL_REGISTRY.find((tool) => tool.mcpName === name);
}

export type LensToolName = (typeof LENS_TOOL_NAMES)[number];

/** Resolve one tool. CLI names are comma-separated to support repeatable flags. */
export function resolveLensToolEnabled(
	name: string,
	globalConfig: unknown,
	projectConfig: unknown,
	cliNoTools?: string | readonly string[],
): boolean {
	const entry = TOOL_REGISTRY.find((tool) => tool.name === name);
	if (entry?.disableable === false) return true;
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
	warnInvalid: (reason: string, code?: "PILENS_CFG_0009") => void,
): Record<string, { enabled?: boolean }> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const section = (raw as Record<string, unknown>).tools;
	if (!section || typeof section !== "object" || Array.isArray(section))
		return undefined;
	const result: Record<string, { enabled?: boolean }> = {};
	for (const [name, value] of Object.entries(section)) {
		if (name === "lazy") continue;
		const entry = TOOL_REGISTRY.find((tool) => tool.name === name);
		if (!entry) {
			warnInvalid(
				`unknown key "tools.${name}.enabled" is not a recognized pi-lens tool`,
				"PILENS_CFG_0009",
			);
			continue;
		}
		if (!entry.disableable) {
			warnInvalid(
				`key "tools.${name}.enabled" cannot be disabled because it is required for the ${entry.mcpName ? "MCP session" : "pi tool activation"} contract`,
				"PILENS_CFG_0009",
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
