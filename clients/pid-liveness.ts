/**
 * The one `process.kill(pid, 0)` liveness check (#449/#525, moved here from
 * `instance-reaper.ts` so the lock modules it imports can reach it without an
 * import cycle). Every consumer that asks "is this recorded pid still running"
 * routes through it: the instance registry, the reaper, the budget, the review
 * graph stage sweep, the install and bounded pid-file locks, the generation
 * lock and the turn-state owner check. A rival copy decides EPERM or an
 * unprobeable pid its own way (the turn-state copy read EPERM as dead and
 * handed a live foreign worklist to the next writer).
 */

import { recordDegradationOnce } from "./degradation-ledger.js";

/** `process.kill(pid, 0)` liveness check: ESRCH ⇒ dead, anything else
 *  (EPERM, or no error thrown at all) ⇒ conservatively alive. Exported so
 *  other registry consumers (clients/lsp-budget.ts, #449 slice 2) reuse this
 *  exact liveness check rather than inventing a second one. */
export function realIsPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true; // no throw — process exists and we can signal it
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ESRCH") return false; // definitively dead
		// EPERM (exists, no permission) or any other/unknown errno: ambiguous —
		// never treat as dead. EPERM is an ordinary answer; any other code is a
		// pid Node would not signal, so it is recorded once per code.
		if (code !== "EPERM") {
			recordDegradationOnce({
				kind: "pid-liveness-unprobeable",
				subject: String(code ?? "unknown"),
				reason: `process.kill(pid, 0) threw ${String(code ?? "an error without a code")}; read as alive`,
			});
		}
		return true;
	}
}
