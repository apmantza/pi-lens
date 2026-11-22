/**
 * The instance registry's same-process mutation tail.
 *
 * STATIC IMPORTS: `process-singletons.js` only, deliberately. This module is
 * a dependency leaf so `tests/support/vitest-setup.ts` can join the tail at
 * worker teardown (#3617) without loading `instance-registry.ts`'s import
 * graph into every worker before a test file's `vi.mock` registers. Round 1
 * of #3703 imported the registry there and preloaded about 30 modules, and
 * 56 files that mock one of them went red.
 */

import { getProcessSingleton } from "./process-singletons.js";

// Every mutation routed through this tail (`registerInstance`,
// `registerInstanceRoot`, `recordLspChild`, `removeLspChild`) reads the WHOLE
// registry file, edits this process's own entry, and writes the whole
// file back. Two such mutations from the SAME process — e.g. a client-ceiling
// eviction's `removeLspChild(victimPid)` racing the replacement spawn's
// `recordLspChild(newChild)` that follows it — are ordinary concurrent async
// calls with no ordering guarantee between them. Without serialization, the
// later WRITE can be built from a read taken before the earlier write landed,
// silently reverting it (last-writer-wins losing a same-process update, not
// just the already-accepted cross-process one — see the module docstring of
// `instance-registry.ts`).
// #1724: this is why a forced LSP shutdown's deregistration could get
// clobbered by a concurrent respawn's registration. One shared tail
// serializes every same-process registry mutation of this shape so "record"
// and "remove" can never interleave their read-modify-write against each
// other — the single seam both the forced-shutdown and self-crash
// deregistration paths route through.
//
// #2146: the tail must be the PROCESS's one serialization point, and module
// scope did not deliver that. pi evaluates the pi-lens module graph up to nine
// times per process, so this module had up to nine tails, each serializing only
// its own callers. The dogfood run measured the consequence directly: three
// `instance-registry-corrupt` records inside nine seconds, with two project
// roots and one live instance's entry lost from `instances.json` — exactly the
// torn read-modify-write this tail exists to prevent, reintroduced by
// duplication rather than by a missing await. Keying it on `globalThis` makes
// every evaluation queue onto the same tail.
const REGISTRY_TAIL_FAMILY = "instance-registry.mutation-tail";
/** Bump when the tail cell's shape changes. */
const REGISTRY_TAIL_VERSION = 1;

function registryTailState(): { tail: Promise<void> } {
	return getProcessSingleton(
		REGISTRY_TAIL_FAMILY,
		REGISTRY_TAIL_VERSION,
		() => ({
			tail: Promise.resolve(),
		}),
	);
}

export function queueRegistryMutation(op: () => Promise<void>): Promise<void> {
	const state = registryTailState();
	const run = state.tail.then(op);
	state.tail = run.catch(() => {});
	return run;
}

/**
 * Test-only: resolve once every registry mutation queued so far has landed.
 *
 * Several production call sites fire registry writes and deliberately do not
 * await them (`void registerInstance(...)` in the session_start handler), so a
 * test that reads the file straight afterwards races them. Queuing an empty op
 * on the same tail joins the queue rather than sleeping on it, which keeps the
 * wait exact instead of timing-dependent.
 */
export function _settleRegistryMutationsForTests(): Promise<void> {
	return queueRegistryMutation(async () => {});
}
