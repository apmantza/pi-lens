/**
 * Test-side runner for the drains modules register in
 * `clients/background-write-drains.ts` (#4937).
 *
 * Recurrence this prevents: a drain that resolved while its writer still had
 * work pending (a bounded snapshot wait, a probe-cache retry) read as settled,
 * and the write landed after the fixture root was removed. The runner rejects
 * on any drain that reports work remaining, so the file fails loudly instead of
 * removing the root under a live writer.
 *
 * FIXED POINT (#5745 r10). One pass in registration order was not enough: the
 * package-manager prime's drain waits for its probes, and the probes that start
 * after `npm config get prefix` returns add owned-child ledger work to the
 * safe-spawn drain, which every copy registers first and which had already
 * returned. The last child's removal then took the registry lock after the
 * fixture root was removed and re-created it (CI shard 5,
 * `pi-session-teardown.test.ts`). So the runner repeats full passes until a
 * pass ends with no drain's pending signal true.
 *
 * DEADLINE. The passes are bounded as a whole. A deadline that fires is a
 * transition, not a pass: the runner stops scheduling passes, writes one
 * `background-write-drain-deadline` degradation record, and rejects with the
 * drains still pending. It never resolves as settled.
 */
import { registeredBackgroundWriteDrainsForTests } from "../../clients/background-write-drains.js";

/**
 * Longest the passes may take together. Above the prime drain's own 10 s
 * bound, and below the 60 s hook timeout of the `afterAll` that runs it, so a
 * fired deadline reports itself instead of being cut by the hook.
 */
const FIXED_POINT_DEADLINE_MS = 30_000;

function pendingDrainNames(): string[] {
	return registeredBackgroundWriteDrainsForTests()
		.filter((entry) => entry.pending())
		.map((entry) => entry.drain.name || "anonymous drain");
}

/**
 * Run every registered drain, in registration order, until a full pass leaves
 * none pending; reject on any drain that is not settled and on the deadline.
 */
export async function drainRegisteredBackgroundWritesForTests(
	options: { deadlineMs?: number } = {},
): Promise<void> {
	// Tier 2 pins its fixture home before loading the logger graph. These
	// owners reach latency-logger, whose sink binds at module load (#5745 r11).
	const { withDeadline } = await import("../../clients/deadline-utils.js");
	const { recordDegradationOnce } =
		await import("../../clients/degradation-ledger.js");
	const deadlineMs = options.deadlineMs ?? FIXED_POINT_DEADLINE_MS;
	let expired = false;
	const passes = async (): Promise<{ remaining: string | undefined }> => {
		while (!expired) {
			for (const { drain } of registeredBackgroundWriteDrainsForTests()) {
				if (expired) break;
				const remaining = await drain();
				if (remaining !== undefined) return { remaining };
			}
			if (pendingDrainNames().length === 0) return { remaining: undefined };
			// A macrotask between passes: drains that settle in microtasks only
			// would otherwise never let the deadline's timer run.
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		return { remaining: undefined };
	};
	const outcome = await withDeadline(passes(), {
		ms: deadlineMs,
		onTimeout: "undefined",
	});
	if (outcome === undefined) {
		expired = true;
		const reason = `background-write drains did not reach a fixed point within ${deadlineMs} ms; still pending: ${pendingDrainNames().join(", ") || "none reported, a drain did not return"}`;
		recordDegradationOnce({
			kind: "background-write-drain-deadline",
			subject: "fixed-point",
			reason,
		});
		throw new Error(reason);
	}
	if (outcome.remaining !== undefined) throw new Error(outcome.remaining);
}
