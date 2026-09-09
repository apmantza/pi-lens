/**
 * THE final registration boundary for a host-facing tool: everything that
 * must be true of a tool definition the instant before `pi.registerTool`
 * sees it. `index.ts` runs every tool it registers — always-active,
 * situational, and the compact-line-wrapped variants — through this one
 * function, so a property added here reaches every tool without a second
 * call site to keep in sync.
 *
 * Two jobs today:
 *  1. metadata the host requires is present (a non-empty description);
 *  2. an in-flight tool call HOLDS the event loop (#2507). pi-lens unrefs the
 *     LSP child, its stdio pipes and several waiting timers so an idle
 *     one-shot process can exit; in a headless child with no other referenced
 *     handle that let Node exit 0 in the middle of `lsp_diagnostics`. Every
 *     tool call therefore takes a counted hold for its own duration — see
 *     `clients/event-loop-hold.ts` for why the hold lives there and not in
 *     the unref itself.
 */

import { acquireEventLoopHold } from "./event-loop-hold.js";

export type ToolDefinition = {
	name?: unknown;
	description?: unknown;
	execute?: unknown;
};

export function normalizeToolDefinition<T extends ToolDefinition>(tool: T): T {
	const name = typeof tool.name === "string" ? tool.name.trim() : "tool";
	const description =
		typeof tool.description === "string" && tool.description.trim().length > 0
			? tool.description
			: `Use the ${name} tool.`;
	const execute = tool.execute;
	if (typeof execute !== "function") {
		return { ...tool, description } as T;
	}
	const inner = execute as (...args: unknown[]) => unknown;
	return {
		...tool,
		description,
		// A plain function, not an arrow: `this` stays whatever the host called
		// the tool with, so a definition whose `execute` reads `this` keeps
		// working. The hold is released in `finally`, so a rejected or aborted
		// call releases exactly like a resolved one.
		execute: async function (this: unknown, ...args: unknown[]) {
			const release = acquireEventLoopHold(name);
			try {
				return await inner.apply(this, args);
			} finally {
				release();
			}
		},
	} as T;
}
