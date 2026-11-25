/**
 * Process-wide registry of "settle my deferred writes" functions, one per
 * evaluation of a module that owns a module-scope deferred writer (#4937).
 *
 * WHY. pi loads the built extension through its own jiti loader with
 * `moduleCache: false`, so a tier-2 test process holds a second, private copy of
 * every `clients/` module: the extension's. A deferred writer in that copy (a
 * worker snapshot persist, a debounced cache flush) is invisible to the test
 * side's own `import`, and its write lands after the fixture root was removed,
 * re-creating it. Master run 40967488612 leaked
 * `pi-lens-pi-session-yB7mpc` that way. Each such module registers its drain
 * here when it loads; the harness joins every copy's drain before it removes
 * the root (`tests/support/pi-session.ts`).
 *
 * STATIC IMPORTS: none, deliberately: a dependency leaf, so any module with a
 * deferred writer can register without a cycle.
 *
 * STATE. Keyed on `globalThis` with `Symbol.for`, not on module scope (the
 * module is itself evaluated once per copy) and not in `process-singletons`
 * (its test reset would drop the registration of a copy that is already
 * loaded). Entries are held strongly, in a plain Map from drain to its pending
 * signal: a drain is a module-level function that its module keeps alive anyway, and no `WeakRef` is constructed
 * at module load (a test that stubs the global `WeakRef` counts every
 * construction, and `clients/dependency-checker.ts` imports the installer).
 *
 * STRICT DRAINS. A drain resolves with `undefined` only when its writer has
 * nothing left to land, and with a string naming what remains otherwise: a
 * bounded wait or a scheduled retry that read as "settled" would let the write
 * land after the root was removed, the defect this registry exists to close.
 * A registering module therefore registers a wrapper that checks its own
 * pending state, not a bare bounded helper. The test side decides what an
 * unsettled drain means (`tests/support/background-write-drains.ts` rejects).
 *
 * PENDING SIGNALS (#5745 r10). One drain can create work for another that
 * already ran: the package-manager prime's drain waits for its probes, and
 * their `safeSpawnAsync` children add owned-child ledger work after the
 * safe-spawn drain, registered earlier in every copy, returned. So each drain
 * registers a pending signal beside it, and the runner repeats full passes
 * until no signal is true. A signal reads only the state its own drain waits
 * on: one that stayed true after its drain settled would repeat passes until
 * the runner's deadline.
 */

const REGISTRY_KEY = Symbol.for("pi-lens.background-write-drains.v2");

/** Resolves `undefined` once settled, else a description of what remains. */
export type BackgroundWriteDrain = () => Promise<string | undefined>;

/**
 * Synchronous and cheap: whether the drain's writer has work it has not landed
 * yet, read from the state the drain itself waits on. The test-side runner
 * reads it after each full pass (#5745 r10).
 */
export type BackgroundWritePending = () => boolean;

export interface RegisteredBackgroundWriteDrain {
	readonly drain: BackgroundWriteDrain;
	readonly pending: BackgroundWritePending;
}

const host = globalThis as typeof globalThis & { [key: symbol]: unknown };

function registry(): Map<BackgroundWriteDrain, BackgroundWritePending> {
	const existing = host[REGISTRY_KEY];
	if (existing instanceof Map)
		return existing as Map<BackgroundWriteDrain, BackgroundWritePending>;
	const fresh = new Map<BackgroundWriteDrain, BackgroundWritePending>();
	host[REGISTRY_KEY] = fresh;
	return fresh;
}

/**
 * Register `drain` for this module evaluation. It resolves `undefined` only
 * once the module's writer has nothing left to land; `pending` reports, at any
 * moment, whether that writer has work the drain would wait for.
 */
export function registerBackgroundWriteDrain(
	drain: BackgroundWriteDrain,
	pending: BackgroundWritePending,
): void {
	registry().set(drain, pending);
}

/** Test-only: every drain registered so far, in registration order. */
export function registeredBackgroundWriteDrainsForTests(): readonly RegisteredBackgroundWriteDrain[] {
	return [...registry()].map(([drain, pending]) => ({ drain, pending }));
}
