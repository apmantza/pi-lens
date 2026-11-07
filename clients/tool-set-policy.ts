import { logLatency } from "./latency-logger.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import type { LazyToolsSetting } from "./lens-flag-registry.js";
import {
	defineSessionStore,
	type SessionScope,
	scopeCell,
} from "./session-scope.js";

type ToolSetMutationReason =
	| "fresh_session_lazy_deactivation"
	| "session_rebuild_restore"
	| "model_switch"
	| "lazy_activation"
	// A registered tool the policy disabled (config or command line, such as
	// `--no-tool`, #4913) dropped from the active set: its own reason, so a
	// monitor does not read it as lazy posture.
	| "policy_disabled_tool";

export interface ToolSetMutation {
	addedCount: number;
	removedCount: number;
	reason: ToolSetMutationReason;
	deferralApplies: boolean;
}

const LAZY_TOOL_MEMORY = "lazy-tool-memory";

/** The lazy tools the model activated in `scope`'s conversation, in activation order. */
function memory(scope: SessionScope): Set<string> {
	return scopeCell(
		scope,
		LAZY_TOOL_MEMORY,
		() => new Set<string>(),
	) as Set<string>;
}

/**
 * The conversation's lazy-tool activations (#3604, re-scoped by #3609 N8):
 * one cell per session scope, so a concurrent secondary keeps its own
 * (#3653). pi re-runs the factory on every rebuild, so the cell crosses to
 * the next activation through the hand-off and the sidecar. `/tree` keeps it
 * (D7): an extra tool costs prompt bytes, never correctness, and dropping one
 * would change the prompt-cache prefix.
 */
export const lazyToolMemoryStore = defineSessionStore<string[]>({
	name: LAZY_TOOL_MEMORY,
	policy: {
		startup: "adopt",
		new: "reset",
		resume: "adopt",
		fork: "adopt",
		reload: "adopt",
	},
	snapshot: (scope) => [...memory(scope)],
	restore: (scope, payload) => {
		if (!Array.isArray(payload)) return { itemsIn: 0, itemsKept: 0 };
		const before = memory(scope).size;
		for (const name of payload)
			if (typeof name === "string") memory(scope).add(name);
		return { itemsIn: payload.length, itemsKept: memory(scope).size - before };
	},
	reason:
		"the lazy tools a conversation activated, restored on every rebuild so the advertised tool list keeps its prompt-cache prefix",
});

export function rememberLazyTools(
	scope: SessionScope | undefined,
	names: readonly string[],
): void {
	if (!scope) {
		recordDegradationOnce({
			kind: "tool-set-scope-unavailable",
			subject: "activation",
			reason:
				"a lazy-tool activation arrived before its session scope began; activation memory is inert",
		});
		return;
	}
	for (const name of names) memory(scope).add(name);
}

export function getRememberedLazyTools(
	scope: SessionScope | undefined,
): ReadonlySet<string> {
	return scope ? memory(scope) : new Set<string>();
}

/** The only part of the host model object this module reads. */
type DeferredToolModel = {
	compat?: {
		supportsToolSearch?: boolean;
		supportsMidConvoSystemMessages?: boolean;
	};
};

/**
 * The lazy-tools posture the configuration asks for (#4687 item 7):
 * `tools.lazy` = `true` (`on`, the default: lazy on every model), `"auto"`
 * (decide per model), or `false` (`off`, also `--no-lazy-tools`). The CLI flag
 * wins, as for every registry flag.
 *
 * The default stays `true` (maintainer decision, 2026-10-21): over the live
 * window measured on #4687, one activation per 3,329 requests sits under the
 * ~1-per-1,000 break-even at which a folding model's prefix rewrite costs more
 * than carrying the situational schemas on every request.
 */
export type LazyToolsMode = "auto" | "on" | "off";

export function resolveLazyToolsMode(
	noLazyToolsFlag: boolean,
	setting: LazyToolsSetting | undefined,
): LazyToolsMode {
	if (noLazyToolsFlag) return "off";
	return setting === "auto" ? "auto" : "on";
}

/**
 * Whether the situational tools start inactive for `model` (#4687 item 7).
 *
 * `auto` reads pi-ai's own per-model fact. A model WITHOUT mid-conversation
 * system messages has pi-ai fold every system message into one head
 * (`collapseSystemMessages`), so each tool-set change rewrites the whole cached
 * prefix; such a model gets every tool from the start instead. A model that
 * does not state the fact is `false`: it pays the schema bytes, never the
 * rewrite. A session with NO resolved model is not a model without the fact:
 * nothing is known yet, so it keeps the configured default posture (lazy), and
 * the `model_select` that resolves one re-decides.
 */
export function lazyToolsApply(
	mode: LazyToolsMode,
	model: DeferredToolModel | undefined,
): boolean {
	if (mode !== "auto") return mode === "on";
	if (!model) return true;
	return supportsMidConvoSystemMessages(model);
}

export function supportsMidConvoSystemMessages(
	model: DeferredToolModel | undefined,
): boolean {
	return model?.compat?.supportsMidConvoSystemMessages === true;
}

/**
 * Whether the host will send this model deferred (searchable) tool
 * definitions rather than the full inline list.
 *
 * Read the host's own decision off `ctx.model.compat` — pi resolves that
 * flag from the model config (`core/model-config`, `compat.supportsToolSearch`)
 * and it is the only capability signal a consumer can honestly observe.
 * A missing flag means "unknown", which we report as false: this value only
 * annotates the `tool_set_mutation` log line, so guessing high would make the
 * log lie, while guessing low merely under-claims.
 */
export function supportsDeferredTools(
	model: DeferredToolModel | undefined,
): boolean {
	return model?.compat?.supportsToolSearch === true;
}

/**
 * A fresh logical conversation, for the `tool_set_mutation` reason label.
 * `undefined` is included because older hosts fire `session_start` with no
 * `reason` at all.
 *
 * Every OTHER reason (fork/reload/resume) is a session REBUILD: the host
 * constructs a brand-new AgentSession with `includeAllExtensionTools: true`
 * (pi `core/agent-session.js`), so every registered pi-lens tool is active
 * again by the time our handler runs. Those reasons must RESTORE the previous
 * posture, not skip.
 */
export function isFreshSessionStart(reason: unknown): boolean {
	return reason === undefined || reason === "startup" || reason === "new";
}

export interface ToolSetPlan {
	/** The exact set to hand `pi.setActiveTools`. */
	desired: string[];
	addedCount: number;
	removedCount: number;
	/**
	 * How many of `removedCount` are active tools named in `disabled` (off by
	 * config or command line), removed for that reason whatever the lazy
	 * posture would have done.
	 */
	policyDisabledCount: number;
	/** False when `desired` already equals the host's active set. */
	changed: boolean;
}

/**
 * Compute the active-tool set pi-lens wants: everything currently active that
 * is not a lazy tool, plus exactly the lazy tools the model activated in this
 * logical session (`remembered`).
 *
 * On startup/new `remembered` is empty and this is the plain baseline shrink.
 * On fork/reload/resume the host has just re-activated all registered tools,
 * and this restores the parent's posture character-for-character — which both
 * preserves the model's activations and keeps the advertised tool list equal
 * to the one the prompt cache prefix was built from.
 *
 * `disabled` names the registered tools the policy turns off, by config or
 * command line (`--no-tool`, whose value pi applies after the factory ran,
 * #4913). They are in neither the kept set nor the restored one.
 */
export function planToolSet(
	active: readonly string[],
	lazyNames: ReadonlySet<string>,
	remembered: ReadonlySet<string>,
	disabled: ReadonlySet<string> = new Set(),
): ToolSetPlan {
	const desired = active.filter(
		// Lazy tools are dropped here and re-appended below in REMEMBERED
		// (= activation) order. Keeping them in the host's registration
		// position would restore the right SET in the wrong ARRAY order, and
		// the active-tools array is what serializes into the request's tool
		// block — a transposition is a changed prefix, i.e. a cache miss.
		(name) => !lazyNames.has(name) && !disabled.has(name),
	);
	// A remembered tool the host did not list as active still belongs in the
	// set (defensive: the host controls what `getActiveTools` returns).
	const desiredSet = new Set(desired);
	for (const name of remembered) {
		if (!desiredSet.has(name) && !disabled.has(name)) {
			desired.push(name);
			desiredSet.add(name);
		}
	}
	const activeSet = new Set(active);
	const removedCount = active.filter((name) => !desiredSet.has(name)).length;
	const addedCount = desired.filter((name) => !activeSet.has(name)).length;
	let policyDisabledCount = 0;
	for (const name of active) if (disabled.has(name)) policyDisabledCount++;
	return {
		desired,
		addedCount,
		removedCount,
		policyDisabledCount,
		changed: addedCount > 0 || removedCount > 0,
	};
}

/**
 * One row per lazy-tools decision (#4687 item 7): every `session_start` and
 * every model switch, so a session whose plan changed nothing still says which
 * posture it chose and from what.
 */
export function recordToolSetDecision(decision: {
	trigger: "session_start" | "model_select";
	mode: LazyToolsMode;
	lazy: boolean;
	supportsMidConvoSystemMessages: boolean;
}): void {
	logLatency({
		type: "phase",
		filePath: "<pi-lens>",
		phase: "tool_set_decision",
		durationMs: 0,
		metadata: { ...decision },
	});
}

export function recordToolSetMutation(mutation: ToolSetMutation): void {
	logLatency({
		type: "phase",
		filePath: "<pi-lens>",
		phase: "tool_set_mutation",
		durationMs: 0,
		metadata: { ...mutation },
	});
}
