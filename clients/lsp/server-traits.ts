/**
 * The declared per-server LSP trait table (#1756 stage 1) and the ONE
 * server-role vocabulary (#1488).
 *
 * A server's behavioural traits were tribal knowledge in three shapes: a field
 * on `LSPServerInfo` (`notifyInflightLimit`, #1714), a measured marker on a
 * server-id-keyed wait-policy strategy (`silentOnClean`, #458), and a code
 * comment carrying a live probe's result (ast-grep's single-task ordered
 * replies, #1722). This module is the declaration surface for the ones whose
 * home is the SERVER DEFINITION, and it names the ones whose home is not.
 *
 * #1488's half lives here too, because the lifecycle class IS a trait
 * ("auxiliary vs language", #1756 stage 1) and its predicate is what every
 * consumer reads. Before this module the same distinction had two spellings
 * and no seam: `LSPServerInfo.role` said `"language" | "auxiliary"`
 * (clients/lsp/server.ts), `PromiseDescriptor.role` said
 * `"primary" | "auxiliary"` (clients/lsp/aggregation.ts), one inline ternary
 * translated between them at the `getDiagnostics` descriptor build, and 44
 * sites across clients/, tools/ and scripts/ answered "is this server an
 * auxiliary?" with their own `role === "auxiliary"` or `role !== "auxiliary"`.
 *
 * The vocabulary is the one the public LSP schema already publishes
 * (`lsp.servers.<id>.role` in clients/config-schema.ts, projected by
 * `ResolvedLspServer.role` in clients/lsp/resolved-config.ts), so this module
 * adds no third spelling.
 *
 * The auxiliary policy that READS these traits has two halves, one module
 * each, so a policy change edits one place:
 *   - lifecycle and wait: clients/lsp/auxiliary-lifecycle.ts
 *   - diagnostics (re-tag, suppression, blocking): clients/dispatch/auxiliary-lsp.ts
 *
 * This module imports nothing: `clients/lsp/server.ts` declares the trait
 * fields on `LSPServerInfo`, so a dependency in the other direction would be a
 * cycle.
 */

/**
 * The role an LSP server plays in a file's diagnostic collection (#1488).
 *
 * `"language"` = the file's primary language server; primary selection picks
 * one per file. `"auxiliary"` = a cross-cutting, diagnostic-only scanner
 * (security, spelling, secrets) that attaches across many languages and runs
 * ALONGSIDE the primary; it is never selected as primary and is collected only
 * on the with-auxiliary diagnostics path.
 */
export type LspServerRole = "language" | "auxiliary";

/**
 * Every member of the union, keyed by itself. A mapped type over
 * `LspServerRole`, so adding a third role fails to compile here until the
 * record names it — and an UNTYPED declared value (a config record's `role`)
 * is then validated against the union rather than against a hand-listed set of
 * spellings (#1488 acceptance criterion 3).
 */
const ROLE_MEMBERS: { readonly [K in LspServerRole]: K } = {
	language: "language",
	auxiliary: "auxiliary",
};

/**
 * The role a server definition takes when it does not declare one.
 *
 * Stated here rather than implied by a `!== "auxiliary"` test at each site,
 * which was #1488's third problem: negation-as-default meant a third role
 * would have read as a primary at all 44 sites with no compile error and no
 * failing test. Two declarations reach this default today, both deliberately:
 * a custom server built from `lsp.servers.<id>` (clients/lsp/config.ts's
 * `createServerFromConfig` — the public `role` field stays reserved and inert
 * until its catalog slice), and an id this process never registered. The
 * second is the pre-existing behaviour `selectWorkspaceScopeClient` documents:
 * unknown is treated as a primary, never silently dropped.
 */
export const DEFAULT_LSP_SERVER_ROLE: LspServerRole = "language";

/**
 * Anything carrying a declared role: a registry row, a `ResolvedLspServer`, a
 * config record, or a race descriptor. `unknown` rather than `LspServerRole`
 * so the ONE predicate also serves the untyped config path in
 * clients/lsp/resolved-config.ts, which validated the same value with its own
 * comparison before #1488.
 */
export interface LspRoleBearer {
	readonly role?: unknown;
}

/**
 * The ONE auxiliary predicate (#1488). Every "is this server an auxiliary?"
 * question in the tree asks this; an inlined comparison against the role
 * literal is a recurrence, detected by
 * `tests/config/lsp-role-predicate-sweep.test.ts`.
 *
 * The switch is exhaustive over `LspServerRole` with no default arm, so a
 * third role leaves the function without a return and fails to compile until
 * this predicate classifies it.
 */
export function isAuxiliary(bearer: LspRoleBearer | undefined): boolean {
	const declared = bearer?.role;
	const role: LspServerRole =
		typeof declared === "string" && Object.hasOwn(ROLE_MEMBERS, declared)
			? ROLE_MEMBERS[declared as LspServerRole]
			: DEFAULT_LSP_SERVER_ROLE;
	switch (role) {
		case "auxiliary":
			return true;
		case "language":
			return false;
	}
}

/**
 * #1722: how a server orders its replies against content notifications it has
 * not finished processing.
 *
 * `"single-task-ordered"` = the server drains its message stream in order on
 * one task, so a request written after N `didOpen`s is answered after those N
 * are scanned. That is the property that makes the auxiliary notify barrier
 * (`paceAuxNotify`, clients/lsp/index.ts) SOUND: one round-trip proves the
 * backlog was processed. Measured against the real ast-grep-lsp binary over 30
 * repository files (#1722): an idle `workspace/symbol` reply lands in 0 ms,
 * the same reply after 30 didOpens in 2263 ms with 29 of 30 publishes already
 * in.
 *
 * `"threaded"` = the server answers requests off a separate task, so a reply
 * proves nothing about the backlog. The barrier is INERT for such a server: it
 * answers instantly, `unacked` resets, and the notify sequence is exactly the
 * pre-#1714 one, with #743's write deadline, backpressure streak and wedge
 * timer owning a stall as they did before. Declaring it turns that inertness
 * from a measured outcome into a declared one and skips the round-trip.
 *
 * `"unmeasured"` = no probe result, the default and the fail-safe: the barrier
 * stays armed exactly as it does today, so an unmeasured server is never
 * granted a pacing change by omission. Same three-value shape as
 * `LSPServerInfo.idleEviction`.
 */
export type LspReplyOrdering =
	| "single-task-ordered"
	| "threaded"
	| "unmeasured";

/** The trait fields a server definition may declare. */
export interface LspServerTraitDeclaration {
	/** #1488 lifecycle class. Required: `LSPServerInfo.role` is non-optional. */
	readonly role: LspServerRole;
	/**
	 * #1714: how many document notifies this server may hold unacknowledged
	 * before the next notify has to prove the server drained its input. Omit to
	 * take the environment override, then {@link DEFAULT_NOTIFY_INFLIGHT_LIMIT}.
	 */
	readonly notifyInflightLimit?: number | undefined;
	/** #1722 reply-ordering semantics. Omit for {@link DEFAULT_REPLY_ORDERING}. */
	readonly replyOrdering?: LspReplyOrdering | undefined;
}

/** The total trait record every consumer reads: no field is optional. */
export interface LspServerTraits {
	readonly role: LspServerRole;
	readonly notifyInflightLimit: number;
	readonly replyOrdering: LspReplyOrdering;
}

/**
 * #1714: how many document notifies one auxiliary may hold UNACKNOWLEDGED
 * before the next notify has to prove the server drained its input.
 *
 * #1459's gate bounds CONCURRENT writes to one per auxiliary. That stops a
 * simultaneous fan-out, but a `lens_diagnostics mode=full` sweep is mostly
 * SEQUENTIAL — one file after another inside a server group (#387) — so every
 * write is alone in flight and the gate never engages. Each write still
 * resolves as soon as the pipe accepts the bytes, not when the scanner has read
 * them, so the sweep can hand a single-threaded scanner hundreds of full
 * re-parses faster than it consumes them. ast-grep stalled and had to be
 * force-killed twice in two full-scan exposures. Counting unacknowledged
 * notifies bounds the BACKLOG the sweep is allowed to build, which pipe-level
 * backpressure alone does not.
 */
export const DEFAULT_NOTIFY_INFLIGHT_LIMIT = 8;

/**
 * The fail-safe reply-ordering default: the barrier stays armed, which is what
 * every server got before the trait was declared.
 */
export const DEFAULT_REPLY_ORDERING: LspReplyOrdering = "unmeasured";

/**
 * The traits whose declared home is the wait-policy STRATEGY table
 * (`SERVER_DIAGNOSTIC_STRATEGIES`, clients/lsp/wait-policy/strategies.ts)
 * rather than the server definition, listed so
 * `tests/config/lsp-server-trait-table.test.ts` can hold the two tables
 * disjoint.
 *
 * They are not projected into {@link LspServerTraits} and this slice does not
 * move them. Each is a MEASURED behaviour whose value is produced by a probe
 * against the real binary and whose staleness is checked by its own census
 * test: `silentOnClean` by `tests/config/lsp-clean-behavior-census.test.ts`
 * (`scripts/probe-clean-signal.mjs`), `emptyFirstPublish` by
 * `tests/config/lsp-first-publish-census.test.ts`. Copying a value into a
 * second table would give it a second source of truth with no second
 * measurement behind it. `role`, `notifyInflightLimit` and `replyOrdering` are
 * declared here instead because they are policy the maintainer states, not
 * behaviour a probe re-measures.
 */
export const STRATEGY_TABLE_TRAITS = [
	"silentOnClean",
	"emptyFirstPublish",
	"diagnosticsFence",
	"workspaceIndexing",
] as const;

/**
 * The trait projection: one server definition in, one total record out.
 *
 * This is the single place a trait default is applied, so a consumer never
 * re-derives one — the shape `auxNotifyInflightLimit` had inlined in
 * clients/lsp/index.ts before #1756 stage 1 folded it here. Read at CALL time,
 * not at module load: `PI_LENS_LSP_AUX_NOTIFY_INFLIGHT` is a per-case knob in
 * the notify-throttle suites.
 */
export function serverTraits(
	declaration: LspServerTraitDeclaration,
): LspServerTraits {
	const declaredLimit = declaration.notifyInflightLimit;
	if (
		typeof declaredLimit === "number" &&
		Number.isFinite(declaredLimit) &&
		declaredLimit > 0
	) {
		return {
			role: declaration.role,
			notifyInflightLimit: Math.floor(declaredLimit),
			replyOrdering: declaration.replyOrdering ?? DEFAULT_REPLY_ORDERING,
		};
	}
	const envLimit = Number(process.env.PI_LENS_LSP_AUX_NOTIFY_INFLIGHT);
	return {
		role: declaration.role,
		notifyInflightLimit:
			Number.isFinite(envLimit) && envLimit > 0
				? Math.floor(envLimit)
				: DEFAULT_NOTIFY_INFLIGHT_LIMIT,
		replyOrdering: declaration.replyOrdering ?? DEFAULT_REPLY_ORDERING,
	};
}
