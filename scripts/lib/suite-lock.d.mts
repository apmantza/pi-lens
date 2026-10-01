// Type declarations for suite-lock.mjs (untyped .mjs imported from .ts tests).
// #1101; shared slots #2435.

export const DEFAULT_SHARED_SLOTS: number;
export const MAX_SHARED_SLOTS: number;

export function getLockPath(): string;

export function getSlotPath(lockPath: string, index: number): string;

export function resolveSharedSlots(raw: unknown): number;

export function isProcessAlive(pid: number): boolean;

export interface AcquireTestLockOptions {
	lockPath?: string;
	pollIntervalMs?: number;
	heartbeatIntervalMs?: number;
	timeoutMs?: number;
	log?: (message: string) => void;
	staleMaxAgeMs?: number;
	/** Shared slots to drain (exclusive) or contend for (shared). */
	slots?: number;
}

export interface TestLockHandle {
	lockPath: string;
	release: () => Promise<void>;
}

export interface SharedSlotHandle extends TestLockHandle {
	slotPath: string;
	slotIndex: number;
}

export function acquireTestLock(
	options?: AcquireTestLockOptions,
): Promise<TestLockHandle>;

export function acquireSharedSlot(
	options?: AcquireTestLockOptions,
): Promise<SharedSlotHandle>;
