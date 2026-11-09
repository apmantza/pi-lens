/**
 * The one schema projection seam between the pi tools and the MCP catalog
 * (#5138 PR 3): an MCP `inputSchema` is the pi tool's own TypeBox `parameters`
 * object plus the MCP-only `cwd`, never a hand-restated copy.
 *
 * It lives outside `mcp/server.ts` because that file is the stdio entry point
 * (importing it would run the server), while the projection cell has to assert
 * against the very function production calls.
 */

import { translateGuidanceToolNames } from "../clients/tool-config.js";

// Wrapped pi tools already declare their params as typebox (which IS JSON
// Schema). Emit that directly as the MCP inputSchema (+ the MCP-only `cwd`)
// instead of hand-restating it — no drift between the tool and its schema.
export function schemaWithCwd(parameters: unknown): Record<string, unknown> {
	const p = parameters as {
		properties?: Record<string, unknown>;
		required?: string[];
	};
	// Property descriptions name pi tools too (`ast_grep_search's`,
	// `module_report`); route each through the MCP name translator, like the
	// tool's own description, so the list never cites a tool MCP does not serve.
	const properties: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(p.properties ?? {})) {
		const property = value as { description?: unknown };
		properties[key] =
			typeof property.description === "string"
				? {
						...property,
						description: translateGuidanceToolNames(
							property.description,
							"mcp",
						),
					}
				: value;
	}
	return {
		type: "object",
		properties: {
			...properties,
			cwd: {
				type: "string",
				description: "Project root (defaults to the server workspace).",
			},
		},
		...(p.required ? { required: p.required } : {}),
	};
}
