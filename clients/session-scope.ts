/**
 * Session scopes and the lineage handle (#3611, slice S1 of the #3609 design).
 *
 * pi re-runs the extension factory on every session transition except
 * `/tree`, and may re-evaluate the entry module on `/reload`, so the one
 * `RuntimeCoordinator` an evaluation holds cannot tell its sessions apart by
 * a per-instance counter: two evaluations' counters both start at 0 (N4), and
 * a per-evaluation order turn restarts while the widget's write guards, a
 * `clients/` module, keep their tokens (N3).
 *
 * The identity rule: **a lineage is a scope ticket, drawn from one process
 * counter when a scope begins. A handle is current while its scope is live
 * (session level) and, at branch level, while the scope's branch epoch equals
 * the one it captured.** A scope stops being live at its `session_shutdown`
 * or when its coordinator begins the next scope, and never becomes live
 * again. No session id, file or evaluation ordinal takes part in currency.
 *
 * The model is `formal/session-lifecycle/` (S9): tickets are its scope ids,
 * {@link retireScope} is its `Retire`, {@link moveBranch} its `Tree` epoch
 * bump, {@link nextOrderTurn} its `processOrderTurn`, and
 * {@link recordDroppedRead} its `recordDrop`.
 *
 * Handles hold their scope record by reference, so a retired scope needs no
 * registry lookup, and the process singleton holds two counters and nothing
 * that grows.
 */

import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { hashText } from "./finding-identity.js";
import {
	createGenerationSource,
	type GenerationHandle,
} from "./generation-guard.js";
import type { PathSetLike } from "./runtime-coordinator.js";
import { logLatency } from "./latency-logger.js";
import { getProcessSingleton } from "./process-singletons.js";
import { PI_LENS_EVALUATION_ORDINAL } from "./startup-timing.js";

export type ScopeRole = "primary" | "secondary";

/** `session`: the scope is live. `branch`: live, and no `/tree` since capture. */
export type LineageLevel = "session" | "branch";

/**
 * A `GenerationHandle`, so every existing `guardedWrite` site takes it
 * unchanged. `generation` is the scope ticket.
 */
export interface LineageHandle extends GenerationHandle {
	readonly scopeId: number;
	/** The scope's branch epoch at capture. */
	readonly branchEpoch: number;
	isCurrent(level?: LineageLevel): boolean;
}

/**
 * Keep fixed-this-turn marks in the session that captured the work. A fixer
 * can finish after `/new`; its late mark must not suppress the successor's
 * own fixer for the same file (#3576).
 */
export function sessionFencedFixedThisTurn(
	set: PathSetLike,
	handle: Pick<GenerationHandle, "guardedWrite">,
): PathSetLike {
	const fixedThisTurn: PathSetLike = {
		...set,
		add: (fixedPath) => {
			handle.guardedWrite(fixedPath, () => set.add(fixedPath));
			return fixedThisTurn;
		},
	};
	return fixedThisTurn;
}

export interface SessionScope {
	readonly scopeId: number;
	readonly role: ScopeRole;
	/** The scope this one replaced in the same coordinator, if any. */
	readonly parentScopeId: number | undefined;
	/** The ticket of the scope its coordinator was constructed with. */
	readonly coordinatorId: number | undefined;
	branchEpoch(): number;
	isLive(): boolean;
	/** Why the scope stopped being live: pi's shutdown reason, "shutdown" when pi sent none, or "superseded". */
	retiredBy(): string | undefined;
	capture(): LineageHandle;
}

const REGISTRY_FAMILY = "session-scope.registry";
/**
 * The counter names `nextTicket` and `orderTurn` are frozen: a cell of
 * another version hands them over by name (`carriedCounter`), so a renamed
 * or nested counter would restart its sequence within the process. Add a
 * field beside them; never rename or move them.
 */
const REGISTRY_VERSION = 1;

interface RegistryCounters {
	nextTicket: number;
	orderTurn: number;
}

/** A counter carried over from another build's cell, or 0 when it has none. */
function carriedCounter(cell: unknown, field: keyof RegistryCounters): number {
	const value = (cell as Partial<Record<keyof RegistryCounters, unknown>>)?.[
		field
	];
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: 0;
}

/**
 * Process-wide, so a second module evaluation continues both counters
 * instead of restarting them (catalog shape 25). A cell from another build
 * (another version) is replaced, but its counters seed the new cell: a
 * ticket or an order turn never repeats within a process, whichever builds
 * meet in it (#3611 r2).
 */
function registry(): RegistryCounters {
	let seed: RegistryCounters = { nextTicket: 0, orderTurn: 0 };
	return getProcessSingleton(
		REGISTRY_FAMILY,
		REGISTRY_VERSION,
		() => seed,
		(previous) => {
			seed = {
				nextTicket: carriedCounter(previous, "nextTicket"),
				orderTurn: carriedCounter(previous, "orderTurn"),
			};
		},
	);
}

/**
 * Where a handle keeps the scope it names, for {@link recordDroppedRead}.
 * `Symbol.for`, so a handle from another module evaluation is still read.
 */
const CAPTURED_SCOPE = Symbol.for("pi-lens.session-scope.captured.v1");

interface CapturedScope {
	scope: Scope;
	branch: GenerationHandle;
}

class Scope implements SessionScope {
	readonly scopeId: number;
	readonly role: ScopeRole;
	readonly parentScopeId: number | undefined;
	readonly coordinatorId: number | undefined;
	private retiredReason: string | undefined;
	/** The scope's store cells, by key (#3612); see {@link scopeCell}. */
	readonly cells = new Map<string, unknown>();
	// The stale-write record keeps its `runtime-session:<subject>` subject.
	private readonly life = createGenerationSource("runtime-session");
	private readonly branch = createGenerationSource("session-branch");

	constructor(args: {
		role: ScopeRole;
		parentScopeId?: number;
		coordinatorId?: number;
	}) {
		this.scopeId = drawTicket();
		this.role = args.role;
		this.parentScopeId = args.parentScopeId;
		this.coordinatorId = args.coordinatorId;
	}

	branchEpoch(): number {
		return this.branch.current();
	}

	isLive(): boolean {
		return this.retiredReason === undefined;
	}

	retiredBy(): string | undefined {
		return this.retiredReason;
	}

	/** The first reason wins. */
	retire(reason: string | undefined): void {
		if (this.retiredReason !== undefined) return;
		// A host that sends no reason still ends the scope.
		this.retiredReason = reason ?? "shutdown";
		this.life.bump();
	}

	moveBranch(): void {
		this.branch.bump();
	}

	capture(): LineageHandle {
		const life = this.life.capture();
		const branch = this.branch.capture();
		return {
			generation: this.scopeId,
			scopeId: this.scopeId,
			branchEpoch: branch.generation,
			isCurrent: (level: LineageLevel = "session") =>
				life.isCurrent() && (level === "session" || branch.isCurrent()),
			guardedWrite: (subject, write) => life.guardedWrite(subject, write),
			[CAPTURED_SCOPE]: { scope: this, branch },
		} as LineageHandle;
	}
}

/** The next process-unique ticket (scopes and #3855's successor names). */
function drawTicket(): number {
	const state = registry();
	state.nextTicket += 1;
	return state.nextTicket;
}

/**
 * Begin a scope: draw its ticket. A coordinator begins one when constructed
 * and one per `resetForSession`; a declined secondary start begins its own.
 */
export function beginScope(args: {
	role: ScopeRole;
	parentScopeId?: number;
	coordinatorId?: number;
}): SessionScope {
	return new Scope(args);
}

/**
 * Retire a scope. Every handle it issued stops being current. Idempotent:
 * the first reason wins.
 */
export function retireScope(
	scope: SessionScope,
	reason: string | undefined,
): void {
	const wasLive = scope.isLive();
	(scope as Scope).retire(reason);
	// #3873 O4: pi's shutdown retires a scope and `logScopeTransition` writes
	// that row at its call site. A scope retired by its coordinator beginning
	// the next one (`superseded`) had no shutdown before it, so this is the
	// only record that a start replaced a scope that never ended: an orphan.
	if (wasLive && reason === "superseded")
		logScopeTransition(scope, { transition: "end", reason });
}

/** `/tree`: the scope's branch epoch moves once; its handles go branch-stale. */
export function moveBranch(scope: SessionScope): void {
	(scope as Scope).moveBranch();
}

/**
 * The next write-order turn, from one process counter (N3). A turn drawn
 * later outranks every earlier token, whichever coordinator or module
 * evaluation drew it.
 */
export function nextOrderTurn(): number {
	const state = registry();
	state.orderTurn += 1;
	return state.orderTurn;
}

/**
 * `end` (#3873): a scope its coordinator superseded without a shutdown.
 * `demote`: a start declined as a gap non-successor (#3855); its `start` row
 * is role `secondary`, this row says why.
 */
export type ScopeTransition = "start" | "shutdown" | "tree" | "end" | "demote";

/**
 * One `session_scope_transition` row per scope start, retire and branch
 * move (design §3.7). `evaluationOrdinal` and `coordinatorId` answer N3's
 * residence question: distinct coordinator ids per pid across a `/reload`
 * mean the entry module was re-evaluated.
 */
export function logScopeTransition(
	scope: SessionScope,
	args: {
		transition: ScopeTransition;
		reason: string | undefined;
		sessionId?: string;
		/** Absent for a retire that has no session cwd (`end`). */
		cwd?: string;
		/** A primary start's hand-off source (#3612); see {@link adoptHandoff}. */
		handoffSource?: StartSource;
		/** Why the decision went this way (`demote`: basis, gap and lineage). */
		detail?: Record<string, unknown>;
	},
): void {
	logLatency({
		type: "phase",
		phase: "session_scope_transition",
		filePath: args.cwd ?? "<pi-lens>",
		durationMs: 0,
		metadata: {
			transition: args.transition,
			reason: args.reason,
			scopeId: scope.scopeId,
			parentScopeId: scope.parentScopeId,
			role: scope.role,
			branchEpoch: scope.branchEpoch(),
			sessionId: args.sessionId,
			evaluationOrdinal: PI_LENS_EVALUATION_ORDINAL,
			coordinatorId: scope.coordinatorId,
			handoffSource: args.handoffSource,
			...args.detail,
		},
	});
}

/**
 * F1 (maintainer decision A + C on #3609): a read-guard write that its
 * lineage fence dropped is a false block when its entry is still on its
 * writer's branch. Such a drop leaves one counted record carrying the scope's
 * retirement reason, so correct `/new` drops can be told from `/reload` and
 * resume false blocks. "Still on the branch" is read from captures, never
 * from a live session: the write was queued at `writeBranchEpoch`, and with
 * no `/tree` between that queue and the drop, the entry it credits is still
 * on its conversation's branch. When the branch moved in between, the entry
 * cannot be shown to be on it, the live read guard would have refused the
 * write as a branch move, and only the fence's own stale-write record stays.
 */
export function recordDroppedRead(
	handle: LineageHandle,
	site: string,
	writeBranchEpoch: number,
): void {
	const captured = (
		handle as LineageHandle & { [CAPTURED_SCOPE]?: CapturedScope }
	)[CAPTURED_SCOPE];
	// The branch did not move after the drop's capture, nor between the
	// write's queue and that capture (#3611 r2 F1).
	if (!captured?.branch.isCurrent()) return;
	if (writeBranchEpoch !== handle.branchEpoch) return;
	// A handle whose scope is live and whose branch did not move is current,
	// so its guard never drops: a caller reaches here only after a retire.
	const reason = captured.scope.retiredBy();
	incrementDegradationCount({
		kind: "session-scope-read-dropped",
		subject: `${reason}:${site}`,
		reason: `a ${site} read-guard write of scope ${captured.scope.scopeId} was dropped after the scope retired (${reason}); its entry is still on its conversation's branch`,
	});
}

// --- Session stores and the hand-off (#3612, slice S2 of the #3609 design) ---
//
// pi re-runs the factory for every transition except `/tree`, so a store's
// state crosses to the next activation only through the hand-off: a sync
// snapshot at the primary's `session_shutdown` (D3), taken by the successor's
// `session_start`, or the sidecar when no in-process successor exists.

/** The `session_start` reasons pi sends. A missing or unknown reason is a `startup`. */
export type StartReason = "startup" | "new" | "resume" | "fork" | "reload";

/**
 * What a store does at a primary `session_start` (design §4). `adopt` restores
 * the start's hand-off source: carry on `/reload`, import-parent on `/fork`,
 * `/clone` and `pi --fork`, rehydrate on resume and launch.
 */
export type StartAction = "adopt" | "reset" | "none";

export type HandoffSource = "slot" | "own-sidecar" | "parent-sidecar";
export type StartSource = HandoffSource | "none";

/**
 * Where each start reason looks for the state it adopts, in order; the first
 * source that exists wins for every store. Only a successor that continues
 * the same conversation reads the slot: the reloaded session, or the fork
 * that copied it. A resume's slot would hold the session it left.
 */
const SOURCES: Readonly<Record<StartReason, readonly HandoffSource[]>> = {
	startup: ["own-sidecar", "parent-sidecar"],
	resume: ["own-sidecar", "parent-sidecar"],
	fork: ["slot", "parent-sidecar"],
	reload: ["slot", "own-sidecar"],
	new: [],
};

export function toStartReason(reason: string | undefined): StartReason {
	return reason !== undefined && Object.hasOwn(SOURCES, reason)
		? (reason as StartReason)
		: "startup";
}

export interface AdoptContext {
	reason: StartReason;
	source: StartSource;
	/** A sidecar source's save time, for a store that reconciles with disk. */
	savedAt: number | undefined;
	/** The starting session's live session manager. */
	sessionManager: unknown;
	cwd: string;
}

/**
 * What a store's `restore` reports for its `session_store_action` row
 * (#3873): the items its payload held and how many it kept.
 */
export interface StoreCarry {
	itemsIn: number;
	itemsKept: number;
}

export interface SessionStoreSpec<P> {
	/** Unique; the sidecar key and the governance registry's row name. */
	name: string;
	policy: Readonly<Record<StartReason, StartAction>>;
	/**
	 * Sync and bounded: it runs in `session_shutdown`, whose budget is 0 ms
	 * (#2523). `undefined` hands nothing off.
	 */
	snapshot(scope: SessionScope): P | undefined;
	/**
	 * `payload` is untrusted (a sidecar is JSON from disk) and `undefined`
	 * when the source held none, or no source existed.
	 */
	restore(
		scope: SessionScope,
		payload: unknown,
		ctx: AdoptContext,
	): void | StoreCarry | Promise<void | StoreCarry>;
	reset?(scope: SessionScope): void;
	/** One sentence: why this state is a store. */
	reason: string;
}

/** Declared stores, in declaration order: a store exists only by being declared. */
const sessionStores = new Map<string, SessionStoreSpec<unknown>>();

export function defineSessionStore<P>(
	spec: SessionStoreSpec<P>,
): SessionStoreSpec<P> {
	if (sessionStores.has(spec.name))
		throw new Error(`session store ${spec.name} is declared twice`);
	sessionStores.set(spec.name, spec as SessionStoreSpec<unknown>);
	return spec;
}

/** For the governance sweep (§3.8 items 1 and 2.6). */
export function listSessionStores(): readonly SessionStoreSpec<unknown>[] {
	return [...sessionStores.values()];
}

/**
 * The cell a scope holds under `key`, created by `init` on first use. Cells
 * live on the scope, so a module re-evaluation cannot fork them, and a
 * secondary's scope has cells of its own.
 */
export function scopeCell<T>(
	scope: SessionScope,
	key: string,
	init?: () => T,
): T | undefined {
	const cells = (scope as Scope).cells;
	if (!cells.has(key) && init) cells.set(key, init());
	return cells.get(key) as T | undefined;
}

/** Every declared store's snapshot of `scope`, by store name: the hand-off and sidecar payload. */
export function snapshotSessionStores(
	scope: SessionScope,
): Record<string, unknown> {
	const snapshots: Record<string, unknown> = {};
	for (const spec of sessionStores.values()) {
		const payload = spec.snapshot(scope);
		if (payload !== undefined) snapshots[spec.name] = payload;
	}
	return snapshots;
}

/**
 * The slot is keyed by the transition it was left for: the start reason and
 * the successor's session file (F2). A file-less session has no file, so its
 * key is the ticket of the scope that left the slot (#3819), bound to the
 * session manager it left from. pi hands a file-less `/reload` or in-memory
 * `/fork` successor that same manager, so the successor finds the ticket; a
 * subagent's own start, on a manager no primary shutdown left a slot from,
 * does not.
 */
interface Handoff {
	reason: StartReason;
	/** The successor's session file; file-less, the stashing scope's ticket. */
	key: string | number;
	stores: Record<string, unknown>;
	/**
	 * When the snapshot was taken (#3873): the slot's age in its records.
	 * Optional so a slot a build from before this field stashed (same cell
	 * version) still reads: its rows carry no age.
	 */
	at?: number;
	/** A `key-mismatch-left` row was written for this slot (#3873): once per slot. */
	mismatchLogged?: boolean;
}

const HANDOFF_FAMILY = "session-scope.handoff";
/**
 * Bump when {@link Handoff}'s or the cell's shape changes incompatibly. The
 * #3873 fields are optional additions, so the version stays 2 and a slot an
 * earlier build left is still taken.
 */
const HANDOFF_VERSION = 2;

interface HandoffCell {
	handoff: Handoff | undefined;
	/** A pi session manager to the ticket of the last slot left from it. */
	left: WeakMap<object, number>;
}

/** A session manager is a WeakMap key only when it is an object. */
function asManager(sessionManager: unknown): object | undefined {
	return typeof sessionManager === "object" && sessionManager !== null
		? sessionManager
		: undefined;
}

function handoffSlot(): HandoffCell {
	return getProcessSingleton(HANDOFF_FAMILY, HANDOFF_VERSION, () => ({
		handoff: undefined,
		left: new WeakMap<object, number>(),
	}));
}

/** What became of the slot: one `session_handoff_slot` row per op (#3873). */
type SlotOp =
	| "stashed"
	| "replaced"
	| "taken"
	| "key-mismatch-left"
	| "forwarded"
	| "unconsumed-at-exit";

/** A slot or start key for a row: a file as a short hash, a ticket as itself. */
function describeKey(key: string | number | undefined): string | undefined {
	if (key === undefined) return undefined;
	return typeof key === "number" ? `ticket:${key}` : `file:${hashText(key, 8)}`;
}

/** A slot's age in ms, `undefined` for one stashed before `at` existed. */
function ageOf(handoff: Handoff | undefined): number | undefined {
	return handoff?.at === undefined ? undefined : Date.now() - handoff.at;
}

/**
 * #3873 O1: one `session_handoff_slot` row per slot transition, so a slot
 * that was left, replaced, taken, left for another start, or never consumed
 * is provable from `latency.log`. Bound: at most one row per primary
 * shutdown (`stashed`, `replaced`, `forwarded`, `unconsumed-at-exit`) and per
 * primary or demoted start (`taken`, `key-mismatch-left`); each is a distinct
 * lifecycle event with no loop behind it, about 350 B.
 */
function logSlotOp(
	op: SlotOp,
	handoff: Handoff | undefined,
	extra: Record<string, unknown> = {},
): void {
	logLatency({
		type: "phase",
		phase: "session_handoff_slot",
		filePath: "<pi-lens>",
		durationMs: 0,
		metadata: {
			op,
			reason: handoff?.reason,
			keyHash: describeKey(handoff?.key),
			storeNames: handoff && Object.keys(handoff.stores),
			ageMs: ageOf(handoff),
			...extra,
		},
	});
}

/**
 * At a primary `session_shutdown` (sync): leave the scope's snapshot for a
 * successor that continues its conversation. pi sends `targetSessionFile`
 * for a fork; a reload keeps its own file and sends none. One slot, replaced.
 * True when a slot was left.
 */
export function stashHandoff(
	scope: SessionScope,
	args: {
		reason: string | undefined;
		sessionFile: string | undefined;
		targetSessionFile: string | undefined;
		/** The session's pi session manager, which binds a file-less slot's ticket. */
		sessionManager?: unknown;
	},
): boolean {
	// `quit` and a missing reason have no successor: they read as `startup`.
	const reason = toStartReason(args.reason);
	const cell = handoffSlot();
	if (!SOURCES[reason].includes("slot")) {
		// #3873 O1: the process ends with a slot nobody took.
		if (cell.handoff && (args.reason === undefined || args.reason === "quit"))
			logSlotOp("unconsumed-at-exit", cell.handoff);
		return false;
	}
	const manager = asManager(args.sessionManager);
	if (manager !== undefined) cell.left.set(manager, scope.scopeId);
	const replaced = cell.handoff;
	cell.handoff = {
		reason,
		key: args.targetSessionFile ?? args.sessionFile ?? scope.scopeId,
		stores: snapshotSessionStores(scope),
		at: Date.now(),
	};
	logSlotOp(replaced ? "replaced" : "stashed", cell.handoff, {
		...(replaced && {
			replacedReason: replaced.reason,
			replacedKeyHash: describeKey(replaced.key),
			replacedAgeMs: ageOf(replaced),
		}),
	});
	return true;
}

/** Who asked for the slot (#3873): the adopting start, a forward or a discard. */
type SlotTaker = "adopt" | "forward" | "discard";

/**
 * Consume the slot only when its key equals this start's (F2): its session
 * file, or, file-less, its predecessor's ticket. A slot left for another
 * start stays in place.
 */
function takeSlot(
	reason: StartReason,
	key: string | number | undefined,
	by: SlotTaker,
): Handoff | undefined {
	const slot = handoffSlot();
	const handoff = slot.handoff;
	if (!handoff) return undefined;
	if (handoff.reason !== reason || handoff.key !== key) {
		// Once per slot: a stale slot outlives its successor and every later
		// declined start asks for it, so a row per ask would be a row per start.
		if (!handoff.mismatchLogged) {
			handoff.mismatchLogged = true;
			logSlotOp("key-mismatch-left", handoff, {
				by,
				askedReason: reason,
				askedKeyHash: describeKey(key),
			});
		}
		return undefined;
	}
	slot.handoff = undefined;
	logSlotOp("taken", handoff, { by });
	return handoff;
}

export function takeHandoff(
	reason: StartReason,
	key: string | number | undefined,
	by: SlotTaker = "adopt",
): Record<string, unknown> | undefined {
	return takeSlot(reason, key, by)?.stores;
}

/**
 * A start's slot key: its session file, or, file-less, the ticket its session
 * manager left (#3819). pi hands a file-less `/reload` or in-memory `/fork`
 * successor its predecessor's manager. #3855: also the identity a primary's
 * replacement gap admits ({@link successorStartKey}).
 */
export function startKey(
	sessionFile: string | undefined,
	sessionManager: unknown,
): string | number | undefined {
	const manager = asManager(sessionManager);
	return sessionFile ?? (manager && handoffSlot().left.get(manager));
}

/**
 * #3855: at a primary replacement `session_shutdown`, after its own
 * {@link stashHandoff} or {@link forwardHandoff}: the {@link startKey} its
 * successor's start will compute. pi names a `/new`, resume or persisted
 * `/fork` successor's file (`targetSessionFile`), and hands a `/reload` or
 * in-memory `/fork` successor the same session, so its own file or the ticket
 * bound to its manager. An in-memory `/new` gets a new manager and no file:
 * nothing links it, and the key is `undefined`.
 *
 * #3855 r5: a file-less `/reload` or `/fork` is always named by a ticket. When
 * the manager carries none (the shutdown of a start that has not stashed: an
 * in-memory `/new` or startup interrupted in any window of its start, #3881),
 * a fresh one is bound to it here, so the gap is never named by no key, which
 * every key-less start would match. A manager that carries one keeps it.
 */
export function successorStartKey(args: {
	reason: string | undefined;
	sessionFile: string | undefined;
	targetSessionFile: string | undefined;
	sessionManager: unknown;
}): string | number | undefined {
	if (args.targetSessionFile !== undefined) return args.targetSessionFile;
	const reason = toStartReason(args.reason);
	if (reason !== "reload" && reason !== "fork") return undefined;
	const key = startKey(args.sessionFile, args.sessionManager);
	const manager = asManager(args.sessionManager);
	if (key !== undefined || manager === undefined) return key;
	const ticket = drawTicket();
	handoffSlot().left.set(manager, ticket);
	return ticket;
}

/**
 * A declined (demoted) `session_start` (#3819 r2): discard, without adopting,
 * the slot left for it. A row-17 start demoted the real successor, which can
 * return later as a primary start of the same conversation and must not take
 * the stale slot then. Only the start the slot was left for can match it, so
 * no other start's slot is lost. True when a slot was discarded.
 */
export function discardHandoff(args: {
	reason: string | undefined;
	sessionFile: string | undefined;
	sessionManager: unknown;
}): boolean {
	const reason = toStartReason(args.reason);
	if (
		!takeHandoff(
			reason,
			startKey(args.sessionFile, args.sessionManager),
			"discard",
		)
	)
		return false;
	recordDegradationOnce({
		kind: "session-scope-handoff-discarded",
		subject: reason,
		reason: `a demoted ${reason} start discarded the hand-off slot left for it, so a later start of its conversation cannot take it stale`,
	});
	return true;
}

/**
 * A primary `session_shutdown` that landed while its own `session_start` was
 * still in flight (#3881): that start never adopted, so its scope holds none
 * of the conversation; the slot left for it does. Re-key that slot to this
 * shutdown's transition, and stash nothing of the scope. A start in flight
 * with no slot left for it changes nothing. True when a slot was forwarded.
 *
 * The slot keeps only the stores its own start would have adopted (#3881
 * r2): the successor's policy then applies on top, so an interrupted `/fork`
 * resets the parent's authorship and leaves its advisories, as a clean one.
 */
export function forwardHandoff(args: {
	startReason: string | undefined;
	reason: string | undefined;
	sessionFile: string | undefined;
	targetSessionFile: string | undefined;
	sessionManager: unknown;
}): boolean {
	const reason = toStartReason(args.reason);
	const startReason = toStartReason(args.startReason);
	const key = startKey(args.sessionFile, args.sessionManager);
	const taken = SOURCES[reason].includes("slot")
		? takeSlot(startReason, key, "forward")
		: undefined;
	const stores = taken?.stores;
	if (taken) {
		const adopted: Record<string, unknown> = {};
		for (const [name, payload] of Object.entries(taken.stores))
			if (sessionStores.get(name)?.policy[startReason] === "adopt")
				adopted[name] = payload;
		// A taken slot's key equalled `key`, so `key` is defined here. The
		// snapshot keeps its age: forwarding re-keys it, it is not a new one.
		const forwarded: Handoff = {
			reason,
			key: args.targetSessionFile ?? (key as string | number),
			stores: adopted,
			...(taken.at !== undefined && { at: taken.at }),
		};
		handoffSlot().handoff = forwarded;
		logSlotOp("forwarded", forwarded);
	}
	// The successor's start resets the in-memory ledger; the record's durable
	// `degradation_ledger` row in latency.log is what outlives it.
	const outcome = stores ? "forwarded" : "no-slot";
	recordDegradationOnce({
		kind: "session-scope-handoff-interrupted",
		subject: startReason,
		reason: `a ${reason} shutdown landed before its ${startReason} start adopted; it ${stores ? "handed on the slot left for that start" : "found no slot left for that start to hand on"} and stashed nothing of its own scope`,
		metadata: { shutdownReason: reason, outcome },
	});
	return stores !== undefined;
}

export interface PersistedStores {
	savedAt: number;
	stores: Record<string, unknown>;
	/** The envelope version this build read (#3873). */
	version?: number;
	/** The on-disk version a migrated file was written at. */
	migratedFrom?: number;
}

/** The store names a payload actually holds (`undefined` values are absent). */
function heldStoreNames(stores: Record<string, unknown>): string[] {
	return Object.entries(stores).flatMap(([name, payload]) =>
		payload === undefined ? [] : [name],
	);
}

/**
 * A primary `session_start`, after its scope began: resolve the hand-off
 * source once, then run every store's action for the reason. A secondary
 * never adopts: its scope's cells start empty (#473).
 *
 * #3873 O2, O3: one `session_handoff_adopt` row (every candidate tried and
 * why it fell through) and one `session_store_action` row per declared store
 * per primary start; bounded by primary starts, about 400 B each, and
 * `dbg` gets the one-line per-store carry summary.
 */
export async function adoptHandoff(
	scope: SessionScope,
	args: {
		reason: string | undefined;
		sessionFile: string | undefined;
		sessionManager: unknown;
		cwd: string;
		loadOwnSidecar(): Promise<PersistedStores | undefined>;
		loadParentSidecar(): Promise<PersistedStores | undefined>;
		dbg?: (message: string) => void;
	},
): Promise<StartSource> {
	const reason = toStartReason(args.reason);
	// Only a fork or reload slot is ever left, so no other reason matches.
	const slotted = takeSlot(
		reason,
		startKey(args.sessionFile, args.sessionManager),
		"adopt",
	);
	let source: StartSource = "none";
	let found: { savedAt?: number; stores: Record<string, unknown> } | undefined;
	const tried: Array<Record<string, unknown>> = [];
	for (const candidate of SOURCES[reason]) {
		let version: number | undefined;
		let ageMs: number | undefined;
		if (candidate === "slot") {
			found = slotted && { stores: slotted.stores };
			if (slotted) ageMs = ageOf(slotted);
		} else {
			const sidecar =
				candidate === "own-sidecar"
					? await args.loadOwnSidecar()
					: await args.loadParentSidecar();
			found = sidecar;
			version = sidecar?.migratedFrom ?? sidecar?.version;
			if (sidecar) ageMs = Date.now() - sidecar.savedAt;
		}
		tried.push({
			source: candidate,
			found: found !== undefined,
			...(found && {
				version,
				ageMs,
				storeNames: heldStoreNames(found.stores),
			}),
		});
		if (found) {
			source = candidate;
			break;
		}
	}
	logLatency({
		type: "phase",
		phase: "session_handoff_adopt",
		filePath: args.cwd,
		durationMs: 0,
		metadata: {
			reason,
			startKeyHash: describeKey(
				startKey(args.sessionFile, args.sessionManager),
			),
			scopeId: scope.scopeId,
			tried,
			chosen: source,
		},
	});
	if (SOURCES[reason][0] === "slot" && source !== "slot")
		recordDegradationOnce({
			kind: "session-scope-handoff-missed",
			subject: reason,
			reason: `a ${reason} start found no hand-off slot keyed by its session file or its predecessor's ticket; it started from ${source}`,
		});
	const summary: string[] = [];
	for (const spec of sessionStores.values()) {
		const action = spec.policy[reason];
		if (action === "reset") spec.reset?.(scope);
		const payload = found?.stores[spec.name];
		let carry: StoreCarry | undefined;
		if (action === "adopt") {
			const restored = await spec.restore(scope, payload, {
				reason,
				source,
				savedAt: found?.savedAt,
				sessionManager: args.sessionManager,
				cwd: args.cwd,
			});
			if (restored) carry = restored;
		}
		const label = action === "none" ? "skip" : action;
		logLatency({
			type: "phase",
			phase: "session_store_action",
			filePath: args.cwd,
			durationMs: 0,
			metadata: {
				store: spec.name,
				action: label,
				reason,
				source,
				payloadPresent: payload !== undefined,
				...(carry && {
					itemsIn: carry.itemsIn,
					itemsKept: carry.itemsKept,
					itemsDropped: carry.itemsIn - carry.itemsKept,
				}),
			},
		});
		summary.push(
			carry
				? `${spec.name} ${label} ${carry.itemsKept}/${carry.itemsIn}`
				: `${spec.name} ${label}`,
		);
	}
	args.dbg?.(`session_start: stores from ${source} — ${summary.join(", ")}`);
	return source;
}
