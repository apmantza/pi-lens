/**
 * The async-context scopes that `safeSpawnAsync` reads (re-exported from
 * `safe-spawn.ts`). They live in their own module so a primitive that must step
 * out of them (`single-flight.ts`) does not import the whole spawn seam.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Capture-local cancellation; async context prevents interference with concurrent dispatch. */
export const spawnAbortScope = new AsyncLocalStorage<AbortSignal>();

/**
 * Who pays for a spawn that times out (#5413): the cooldown subject a timed-out
 * spawn arms in `spawn-timeout-cooldown.ts`, and the lane that paid.
 */
export interface SpawnCooldownIdentity {
	/** The tool as a reader names it in the latency row. */
	tool: string;
	/** The cooldown key: a runner id, or a command for the autofix lane. */
	subject: string;
	/** Which lane paid the budget ("lint", "autofix"). */
	phase: string;
}

/**
 * The runner a spawn runs for. The dispatcher enters it around each
 * `runner.run`, so every spawn a runner reaches arms that runner's cooldown on
 * its own timeout without each of ~50 runner call sites naming itself.
 */
export const spawnCooldownScope =
	new AsyncLocalStorage<SpawnCooldownIdentity>();
