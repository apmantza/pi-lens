/**
 * The async-context abort scope that `safeSpawnAsync` reads (re-exported from
 * `safe-spawn.ts`). It lives in its own module so a primitive that must step
 * out of the scope (`single-flight.ts`) does not import the whole spawn seam.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Capture-local cancellation; async context prevents interference with concurrent dispatch. */
export const spawnAbortScope = new AsyncLocalStorage<AbortSignal>();
