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

export interface ActivateToolsOptions {
	deferredToolSupport?: (ctx: unknown) => boolean;
	/**
	 * Called with every lazy tool name the model asked for, so the extension
	 * can remember this logical session's activations and restore them after
	 * the host rebuilds the session — fork/reload/resume construct a fresh
	 * AgentSession with every registered tool active again, while pi-lens's
	 * closure state survives (see clients/tool-set-policy.ts).
	 */
	onActivated?: (names: string[]) => void;
	onMutation?: (mutation: {
		addedCount: number;
		removedCount: number;
		reason: "lazy_activation";
		deferralApplies: boolean;
	}) => void;
}

export function createActivateToolsTool(
	pi: ActiveToolsHost,
	lazyTools: ActivatableToolInfo[],
	options: ActivateToolsOptions = {},
) {
	const lazyNames = lazyTools.map((t) => t.name);
	const lazyNameSet = new Set(lazyNames);

	return {
		name: "pi_lens_activate_tools" as const,
		label: "Activate pi-lens Tools",
		description:
			'Activate registered situational tools for the next turn. Example: `{tools: ["lsp_navigation"]}`.',
		promptSnippet: "Activate a situational tool",
		parameters: Type.Object({
			tools: Type.Array(Type.String({ enum: lazyNames }), {
				minItems: 1,
				description:
					"Names of situational tools to activate, e.g. `lsp_navigation`.",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx?: unknown,
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
			// Remember every requested tool, not just the newly-added ones: a
			// tool that is already active still has to survive the next
			// fork/reload/resume restore.
			options.onActivated?.(requested);

			const active =
				typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
			const activeSet = new Set(active);
			const added = requested.filter((name) => !activeSet.has(name));
			const merged = [...new Set([...active, ...added])];
			if (added.length > 0 && typeof pi.setActiveTools === "function") {
				pi.setActiveTools(merged);
				options.onMutation?.({
					addedCount: added.length,
					removedCount: 0,
					reason: "lazy_activation",
					deferralApplies: options.deferredToolSupport?.(ctx) ?? false,
				});
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Activated: ${requested.join(", ")}. Available starting next turn.`,
					},
				],
				details: { matches: requested, added },
			};
		},
	};
}
