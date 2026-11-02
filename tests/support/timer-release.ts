/**
 * Observe whether a bounded wait releases its timer (AGENTS.md shape 4: every
 * timer is cleared on every settle path).
 *
 * `observeTimerRelease(ms)` wraps the ambient `setTimeout`/`clearTimeout` (the
 * fake ones when `vi.useFakeTimers()` ran first) and records each handle armed
 * with a delay of exactly `ms`. `unreleased()` is the armed handles nothing has
 * cleared yet: after a wait whose work settled first, it must be empty, or the
 * losing timer stays pending for the rest of its delay (#1097, #1109: a REF'd
 * tail that keeps a one-shot `pi --print` process alive).
 *
 * A cell picks a delay no other code in its path uses, so the observation names
 * the one race under test and not a sibling's timer.
 */
import { vi } from "vitest";

export interface TimerReleaseObserver {
	/** Handles armed with the watched delay, in arming order. */
	armed(): unknown[];
	/** Armed handles nothing has passed to `clearTimeout`. */
	unreleased(): unknown[];
	restore(): void;
}

export function observeTimerRelease(delayMs: number): TimerReleaseObserver {
	const realSet = globalThis.setTimeout;
	const realClear = globalThis.clearTimeout;
	const armed: unknown[] = [];
	const cleared = new Set<unknown>();
	const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
		handler: (...args: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	) => {
		const handle = realSet(handler, ms, ...args);
		if (ms === delayMs) armed.push(handle);
		return handle;
	}) as typeof setTimeout);
	const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
		handle?: Parameters<typeof clearTimeout>[0],
	) => {
		cleared.add(handle);
		return realClear(handle);
	}) as typeof clearTimeout);
	return {
		armed: () => [...armed],
		unreleased: () => armed.filter((handle) => !cleared.has(handle)),
		restore: () => {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		},
	};
}
