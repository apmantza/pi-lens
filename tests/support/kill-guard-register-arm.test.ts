/**
 * The kill guard's REGISTER arm must watch the registry production writes to
 * (#2042, #5722 review F1).
 *
 * Named recurrence: #5722 moved `clients/safe-spawn.ts`'s lifetime registry
 * from `process[Symbol.for("pi-lens.safe-spawn.lifetime-state")]` into
 * `getProcessSingleton("safe-spawn-lifetime", 1, ...)` and left
 * `tests/support/kill-guard.ts` wrapping the retired slot. Production then
 * added pids to a set the guard never wrapped, the arm that covers the exit-time
 * SIGKILL route went dead, and all 489 tests stayed green because none
 * provokes a `register` violation.
 *
 * The case goes through the production registry (the process-singleton cell
 * `clients/safe-spawn.ts` reads), never a local copy of it. That
 * `safeSpawnAsync` writes to this same cell is pinned beside the guard's other
 * real-process cases in `tests/real-harness/child-exit.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getProcessSingleton } from "../../clients/process-singletons.js";
import { takeKillGuardViolationsForTest } from "./kill-guard.js";

/** The cell `clients/safe-spawn.ts#lifetimeState` reads: same family and version. */
function productionLifetimePids(): Set<number> {
	return getProcessSingleton("safe-spawn-lifetime", 1, () => ({
		pids: new Set<number>(),
		installed: false,
	})).pids;
}

describe.skipIf(process.platform !== "linux")(
	"kill guard register arm on the production lifetime registry",
	() => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("records a fabricated pid added to the production registry", () => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			const fabricated = 2468; // the #2042 literal
			const pids = productionLifetimePids();
			try {
				pids.add(fabricated);
				expect(
					takeKillGuardViolationsForTest([fabricated]).map((v) => [
						v.site,
						v.target,
						v.detail,
					]),
				).toEqual([["register", fabricated, "lifetime-registry"]]);
			} finally {
				pids.delete(fabricated);
			}
		});
	},
);
