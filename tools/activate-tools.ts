/**
 * pi_lens_activate_tools — the loader tool that bootstraps pi's dynamic
 * tooling (registered-but-inactive tools activated via `pi.setActiveTools`).
 *
 * A handful of pi-lens tools are situational (structural ast-grep
 * search/replace/outline/dump, LSP go-to-definition/references/rename) —
 * useful on many turns, but not every turn. On hosts that support it, pi
 * lets an extension register such tools inactive and expose a small
 * always-active loader the model calls to activate a subset by name
 * (docs: https://github.com/earendil-works/pi, packages/coding-agent/docs/
 * extensions.md, "Dynamic Tool Loading"). Newly activated tools appear
 * starting the NEXT turn — no reload needed.
 *
 * This tool stays always-active (it has to, to bootstrap activation). It is
 * a no-op catalog lookup on hosts where the caller never wired
 * `setActiveTools`/`getActiveTools` (see the feature-detected gating in
 * index.ts) — the situational tools are registered statically active there
 * instead, so calling this tool is harmless, just unnecessary.
 */

import { Type } from "../clients/deps/typebox.js";

export interface ActivatableToolInfo {
	name: string;
	summary: string;
}

/** The subset of the host `pi` API this tool needs, kept minimal + optional
 * so it degrades cleanly on hosts that don't implement dynamic tooling. */
export type ActiveToolsHost = {
	getActiveTools?: () => string[];
	setActiveTools?: (names: string[]) => void;
};

export function createActivateToolsTool(
	pi: ActiveToolsHost,
	lazyTools: ActivatableToolInfo[],
) {
	const lazyNames = lazyTools.map((t) => t.name);
	const lazyNameSet = new Set(lazyNames);
	const catalog = lazyTools.map((t) => `${t.name} — ${t.summary}`).join("\n");

	return {
		name: "pi_lens_activate_tools" as const,
		label: "Activate pi-lens Tools",
		description:
			"Activate one or more situational pi-lens tools that stay registered but inactive by default, so the default tool list stays lean. " +
			"Call this ONCE with the tools you need before using them — they become callable starting the NEXT turn. " +
			`Available:\n${catalog}`,
		promptSnippet:
			"Activate situational ast-grep / lsp_navigation tools before using them",
		parameters: Type.Object({
			tools: Type.Array(Type.String({ enum: lazyNames }), {
				minItems: 1,
				description:
					"Names of situational tools to activate (see this tool's description for the catalog).",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
		) {
			const requested = Array.isArray(params.tools)
				? (params.tools as unknown[]).filter(
						(t): t is string => typeof t === "string" && lazyNameSet.has(t),
					)
				: [];

			if (requested.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No valid tool names given. Available: ${lazyNames.join(", ")}`,
						},
					],
					isError: true,
					details: { matches: [], added: [] },
				};
			}

			// Additive only, per the docs' contract: never drop currently active
			// tools in the same call.
			const active =
				typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
			const merged = [...new Set([...active, ...requested])];
			if (typeof pi.setActiveTools === "function") {
				pi.setActiveTools(merged);
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Activated: ${requested.join(", ")}. Available starting next turn.`,
					},
				],
				details: { matches: requested, added: requested },
			};
		},
	};
}
