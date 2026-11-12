/**
 * The async-context scopes that `safeSpawnAsync` reads (re-exported from
 * `safe-spawn.ts`). They live in their own module so a primitive that must step
 * out of them (`single-flight.ts`) does not import the whole spawn seam.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getProcessSingleton } from "./process-singletons.js";

/**
 * One pair of storages per process, not per module evaluation: an entered
 * storage is never disabled and Node propagates every enabled one into every
 * new async resource, so one per evaluation (extension reload, test resets)
 * taxes every later promise (#5413, #5182).
 */
const FAMILY = "spawn-abort-scope";
const VERSION = 1;

interface SpawnScopes {
	abort: AsyncLocalStorage<AbortSignal>;
	cooldown: AsyncLocalStorage<SpawnCooldownIdentity>;
}

const scopes = getProcessSingleton<SpawnScopes>(FAMILY, VERSION, () => ({
	abort: new AsyncLocalStorage<AbortSignal>(),
	cooldown: new AsyncLocalStorage<SpawnCooldownIdentity>(),
}));

/** Capture-local cancellation; async context prevents interference with concurrent dispatch. */
export const spawnAbortScope = scopes.abort;

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
export const spawnCooldownScope = scopes.cooldown;
