/**
 * Shared process-bridge registration helper (#2437).
 *
 * `clients/read-bridge.ts` (#1265) and `clients/mutation-bridge.ts` (#2423)
 * each mount a versioned, frozen method-table object at a well-known
 * `globalThis[Symbol.for("pi-lens:...")]` key so a same-process producer can
 * reach pi-lens's bookkeeping without importing its internals. Both bridges
 * carried an identical mount body — a first-wins existence check,
 * `Object.freeze`, and a non-writable/non-configurable `Object.defineProperty`
 * — differing only in their key and method table (named by the #2432 review,
 * refs #2423). This module owns that body once.
 *
 * NOT `clients/process-singletons.ts` (#2146): that module keeps a single
 * MUTABLE, adopt-if-version-compatible value per "family" inside ONE shared
 * container (a different, single key mounts the container itself, and a
 * version mismatch there means "discard and rebuild"). A bridge's contract is
 * the opposite: the documented producer protocol reads
 * `globalThis[Symbol.for("pi-lens:mutation-bridge")]` directly as a frozen,
 * first-wins, unreplaceable property, and a version mismatch is the
 * PRODUCER's problem — an unsupported bridge it should not call — never a
 * signal for pi-lens to silently reset its own mount. Reusing the singleton
 * container would change that documented external contract, so this stays a
 * separate, deliberately smaller leaf built for the bridge shape only.
 *
 * STATIC IMPORTS: `process-singletons.ts` only, deliberately. That module is
 * itself a dependency leaf (no imports), so this one stays cycle-free while
 * gaining the versioned cell `rebindableProcessBridgeDeps` needs (#4169).
 */

import { getProcessSingleton } from "./process-singletons.js";

/** A bridge object mountable through {@link registerProcessBridge}. */
export interface ProcessBridge {
	readonly version: number;
}

/**
 * Mount `build()`'s result at `globalThis[key]`, once per process.
 *
 * First-wins: if `key` already exists on `globalThis` — from an earlier call
 * in this process, whether this bridge's own prior registration or a
 * redundant re-activation — `build()` is never invoked and the existing
 * mount is left untouched. The mounted value is frozen and installed
 * non-writable/non-configurable so no later code can silently replace or
 * extend it; the `in` check above is what keeps a redundant call from
 * throwing on that now-frozen property.
 */
export function registerProcessBridge<T extends ProcessBridge>(
	key: symbol,
	build: () => T,
): void {
	if (key in (globalThis as object)) return;

	const bridge = Object.freeze(build());

	Object.defineProperty(globalThis, key, {
		value: bridge,
		writable: false,
		configurable: false,
		enumerable: false,
	});
}

/**
 * The bridge mounted at `key`, or `undefined` when nothing is mounted, the
 * mounted value is not an object, or its `version` does not equal `version`.
 * A version mismatch means "not a bridge this caller recognizes" — never
 * adopted and never reset; the reset-on-mismatch behavior belongs to
 * `process-singletons.ts`'s different contract, not this one.
 */
export function getProcessBridge<T extends ProcessBridge>(
	key: symbol,
	version: number,
): T | undefined {
	const bridge = (globalThis as Record<symbol, unknown>)[key];
	if (!bridge || typeof bridge !== "object") return undefined;
	const candidate = bridge as Partial<T>;
	if (candidate.version !== version) return undefined;
	return candidate as T;
}

/**
 * An opaque identity token: a `RuntimeCoordinator` for a real activation, or a
 * module-scope `Symbol` for a direct (unit-test) registration.
 */
export type BridgeActivation = symbol | object;

interface ScopedBridgeActivation {
	readonly role: "primary" | "secondary";
	readonly scopeId: number;
	isLive(): boolean;
}

function isScopedBridgeActivation(
	activation: BridgeActivation,
): activation is ScopedBridgeActivation {
	if (typeof activation !== "object" || activation === null) return false;
	const candidate = activation as Partial<ScopedBridgeActivation>;
	return (
		(candidate.role === "primary" || candidate.role === "secondary") &&
		typeof candidate.scopeId === "number" &&
		typeof candidate.isLive === "function"
	);
}

function isPreSessionActivation(activation: BridgeActivation): boolean {
	return (
		typeof activation === "object" &&
		activation !== null &&
		(activation as { role?: unknown }).role === "pre-session"
	);
}

/**
 * A rebindable view of a first-wins bridge's dependencies (#4169).
 *
 * `/reload` can re-evaluate the pi-lens module graph: a TypeScript-source entry
 * is transpiled by the host's jiti loader rather than native-imported, so every
 * reload is a fresh module instance. `globalThis` keeps the first mount,
 * though, so a bridge whose build closure captured the first activation's deps
 * would answer into an orphaned runtime while the live session edits through a
 * fresh one — a bridge read then records nowhere the live guard can see, and
 * the edit is blocked "Edit without read".
 *
 * The deps therefore live in a versioned process singleton that every
 * activation rebinds. `activation` is the identity the deps were built for (the
 * activation's live runtime); a call carrying a different one replaces the
 * cell, while a repeat call from the same activation is a no-op, preserving
 * the bridge modules' own "second registration wins nothing" contract. The
 * mounted bridge calls the returned getter per invocation.
 */
export function rebindableProcessBridgeDeps<T extends object>(
	family: string,
	version: number,
	activation: BridgeActivation,
	deps: T,
): () => T | undefined {
	const cell = getProcessSingleton(family, version, () => ({
		activation,
		deps,
	}));
	const current = isScopedBridgeActivation(cell.activation)
		? cell.activation
		: undefined;
	const accepts = !isScopedBridgeActivation(activation)
		? isPreSessionActivation(activation)
			? current === undefined
			: cell.activation !== activation
		: activation.role === "primary" &&
			activation.isLive() &&
			(current === undefined ||
				(current.role === "primary" && activation.scopeId > current.scopeId));
	if (accepts) {
		cell.activation = activation;
		cell.deps = deps;
	}
	return () => {
		const owner = cell.activation;
		if (isScopedBridgeActivation(owner) && !owner.isLive()) return undefined;
		return cell.deps;
	};
}
