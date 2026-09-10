import { logLatency } from "./latency-logger.js";

type ToolSetMutationReason =
	| "fresh_session_lazy_deactivation"
	| "session_rebuild_restore"
	| "lazy_activation";

export interface ToolSetMutation {
	addedCount: number;
	removedCount: number;
	reason: ToolSetMutationReason;
	deferralApplies: boolean;
}

// pi re-runs the extension factory for session rebuilds, but imports this
// module once per process. Keep conversation activation memory here, keyed by
// pi's session file rather than by a factory closure or process-wide session.
const rememberedLazyToolsBySessionFile = new Map<string, Set<string>>();

export function rememberLazyTools(
	sessionFile: string | undefined,
	names: readonly string[],
): void {
	if (!sessionFile) return;
	const remembered =
		rememberedLazyToolsBySessionFile.get(sessionFile) ?? new Set<string>();
	for (const name of names) remembered.add(name);
	rememberedLazyToolsBySessionFile.set(sessionFile, remembered);
}

export function getRememberedLazyTools(
	sessionFile: string | undefined,
): ReadonlySet<string> {
	return sessionFile
		? (rememberedLazyToolsBySessionFile.get(sessionFile) ?? new Set<string>())
		: new Set<string>();
}

export function clearRememberedLazyTools(
	sessionFile: string | undefined,
): void {
	if (sessionFile) rememberedLazyToolsBySessionFile.delete(sessionFile);
}

/** The only part of the host model object this module reads. */
type DeferredToolModel = {
	compat?: {
		supportsToolReferences?: boolean;
	};
};

/**
 * Whether the host will send this model deferred (searchable) tool
 * definitions rather than the full inline list.
 *
 * Read the host's own decision off `ctx.model.compat` — pi resolves that
 * flag from the model config (`core/model-config`, `compat.supportsToolReferences`)
 * and it is the only capability signal a consumer can honestly observe.
 * A missing flag means "unknown", which we report as false: this value only
 * annotates the `tool_set_mutation` log line, so guessing high would make the
 * log lie, while guessing low merely under-claims.
 */
export function supportsDeferredTools(
	model: DeferredToolModel | undefined,
): boolean {
	return model?.compat?.supportsToolReferences === true;
}

/**
 * A fresh logical conversation — the only reasons that start with an empty
 * activation memory. `undefined` is included because older hosts fire
 * `session_start` with no `reason` at all.
 *
 * Every OTHER reason (fork/reload/resume) is a session REBUILD: the host
 * constructs a brand-new AgentSession with `includeAllExtensionTools: true`
 * (pi `core/agent-session.js`), so every registered pi-lens tool is active
 * again by the time our handler runs, while pi-lens's own extension closure
 * state survives. Those reasons must RESTORE the previous posture, not skip.
 */
export function isFreshSessionStart(reason: unknown): boolean {
	return reason === undefined || reason === "startup" || reason === "new";
}

export interface ToolSetPlan {
	/** The exact set to hand `pi.setActiveTools`. */
	desired: string[];
	addedCount: number;
	removedCount: number;
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
 */
export function planToolSet(
	active: readonly string[],
	lazyNames: ReadonlySet<string>,
	remembered: ReadonlySet<string>,
): ToolSetPlan {
	const desired = active.filter(
		// Lazy tools are dropped here and re-appended below in REMEMBERED
		// (= activation) order. Keeping them in the host's registration
		// position would restore the right SET in the wrong ARRAY order, and
		// the active-tools array is what serializes into the request's tool
		// block — a transposition is a changed prefix, i.e. a cache miss.
		(name) => !lazyNames.has(name),
	);
	// A remembered tool the host did not list as active still belongs in the
	// set (defensive: the host controls what `getActiveTools` returns).
	const desiredSet = new Set(desired);
	for (const name of remembered) {
		if (!desiredSet.has(name)) {
			desired.push(name);
			desiredSet.add(name);
		}
	}
	const activeSet = new Set(active);
	const removedCount = active.filter((name) => !desiredSet.has(name)).length;
	const addedCount = desired.filter((name) => !activeSet.has(name)).length;
	return {
		desired,
		addedCount,
		removedCount,
		changed: addedCount > 0 || removedCount > 0,
	};
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
