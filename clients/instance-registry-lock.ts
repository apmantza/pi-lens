/** Cross-process mutual exclusion for the machine-global instance registry. */

import * as fs from "node:fs";
import { randomInt } from "node:crypto";
import * as path from "node:path";

import { incrementDegradationCount } from "./degradation-ledger.js";
import {
	type GenerationHold,
	isLockContention,
	pidFileIsStale,
	pidFileOwner,
	releaseGeneration,
	tryAcquireGeneration,
} from "./generation-lock.js";
import { getProcessSingleton } from "./process-singletons.js";

const OWN_HOLDS_FAMILY = "instance-registry.lock-own-holds";
/** Bump when the cell's shape changes. */
const OWN_HOLDS_VERSION = 1;

/**
 * How many async holds of the registry lock are in flight in this process.
 * A process singleton, not module scope: pi evaluates this module more than
 * once per process (#2146), and the holder and a sync waiter can sit in
 * different evaluations.
 */
function ownAsyncHolds(): { count: number } {
	return getProcessSingleton(OWN_HOLDS_FAMILY, OWN_HOLDS_VERSION, () => ({
		count: 0,
	}));
}

const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 500;
const LOCK_MIN_BACKOFF_MS = 5;
const LOCK_MAX_BACKOFF_MS = 25;

function generationDir(target: string): string {
	return `${target}.locks`;
}

/**
 * The pre-#3476 lock file. Writers from older versions take only this file,
 * so while mixed versions run a generation holder holds it too: an older
 * writer blocks on it, and a live older writer blocks the holder. Only a
 * generation holder creates or removes it, so writers of this version never
 * race each other for it. A stale one is removed by path, which races only
 * an older writer's own takeover.
 */
function legacyLockPath(target: string): string {
	return `${target}.lock`;
}

function createLegacyLock(lock: string): boolean {
	try {
		fs.writeFileSync(lock, `${process.pid} ${Date.now()}\n`, { flag: "wx" });
		return true;
	} catch (error) {
		if (isLockContention(error)) return false;
		throw error;
	}
}

function takeLegacyLock(lock: string): boolean {
	if (createLegacyLock(lock)) return true;
	if (!pidFileIsStale(lock, LOCK_STALE_MS)) return false;
	try {
		fs.unlinkSync(lock);
	} catch {
		// Windows: still open elsewhere. The create below then fails and retries.
	}
	return createLegacyLock(lock);
}

function releaseLegacyLock(lock: string): void {
	// An older writer's stale takeover may have replaced it: keep theirs.
	if (pidFileOwner(lock) !== process.pid) return;
	try {
		fs.unlinkSync(lock);
	} catch {
		// Already displaced.
	}
}

/**
 * One attempt: the hold, "busy" (retry after a backoff), or "failed" (a
 * filesystem error other than contention, recorded; the caller gives up).
 * Never throws: a throw would reach session shutdown's deregisterInstance().
 */
function tryAcquire(target: string): GenerationHold | "busy" | "failed" {
	let hold: GenerationHold | undefined;
	try {
		hold = tryAcquireGeneration(generationDir(target), LOCK_STALE_MS);
		if (!hold) return "busy";
		if (hold.tookOverStale) recordStaleTakeover(target, hold);
		if (takeLegacyLock(legacyLockPath(target))) return hold;
		recordLegacyHeld(target);
		releaseGeneration(hold);
		return "busy";
	} catch (cause) {
		recordLockFailure(target, cause);
		if (hold) releaseGeneration(hold);
		return "failed";
	}
}

function release(target: string, hold: GenerationHold): void {
	releaseLegacyLock(legacyLockPath(target));
	releaseGeneration(hold);
}

function recordLockFailure(target: string, cause: unknown): void {
	const code = (cause as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
	incrementDegradationCount({
		kind: "instance-registry-lock-failed",
		subject: path.resolve(target),
		reason: `lock acquisition failed for ${path.basename(target)} (${code}); the registry write was skipped`,
	});
}

function recordStaleTakeover(target: string, hold: GenerationHold): void {
	incrementDegradationCount({
		kind: "instance-registry-lock-stale-takeover",
		subject: path.resolve(target),
		reason: `took over lock generation ${hold.generation - 1} from a dead or aged-out holder`,
	});
}

function recordLegacyHeld(target: string): void {
	const lock = legacyLockPath(target);
	incrementDegradationCount({
		kind: "instance-registry-lock-legacy-held",
		subject: path.resolve(lock),
		reason: `backed off: ${path.basename(lock)} is held by pid ${pidFileOwner(lock) ?? "unknown"}, a writer from before #3476`,
	});
}

function recordOwnHold(target: string): void {
	incrementDegradationCount({
		kind: "instance-registry-lock-own-hold",
		subject: path.resolve(target),
		reason: "did not wait: an async registry op of this process holds the lock",
	});
}

function recordLockTimeout(target: string): void {
	incrementDegradationCount({
		kind: "instance-registry-lock-timeout",
		subject: path.resolve(target),
		reason: `lock acquisition exhausted for ${path.basename(target)}`,
	});
}

function backoffMs(): number {
	return randomInt(LOCK_MIN_BACKOFF_MS, LOCK_MAX_BACKOFF_MS + 1);
}

function backoff(): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs());
}

/**
 * A wait that outlasts any one hold (#3498): a generation, or an older
 * writer's lock file, older than the lease is taken over, so waiting the lease
 * plus one ordinary wait reaches the lock unless a filesystem error stops it.
 */
export const LOCK_WAIT_THROUGH_LEASE_MS = LOCK_STALE_MS + LOCK_WAIT_MS;

export async function withInstanceRegistryLock<T>(
	target: string,
	op: () => Promise<T>,
	waitMs = LOCK_WAIT_MS,
): Promise<T | undefined> {
	const deadline = Date.now() + waitMs;
	while (Date.now() <= deadline) {
		const hold = tryAcquire(target);
		if (hold === "failed") return undefined;
		if (hold === "busy") {
			if (Date.now() <= deadline)
				await new Promise((resolve) => setTimeout(resolve, backoffMs()));
			continue;
		}
		const holds = ownAsyncHolds();
		holds.count += 1;
		try {
			return await op();
		} finally {
			holds.count -= 1;
			release(target, hold);
		}
	}
	recordLockTimeout(target);
	return undefined;
}

/**
 * The sync wait blocks the event loop, so it can never get a lock an async op
 * of this process holds: that op needs the loop to release it. It returns
 * `undefined` at once then, and the caller queues behind the holder.
 */
export function withInstanceRegistryLockSync<T>(
	target: string,
	op: () => T,
): T | undefined {
	if (ownAsyncHolds().count > 0) {
		recordOwnHold(target);
		return undefined;
	}
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (Date.now() <= deadline) {
		const hold = tryAcquire(target);
		if (hold === "failed") return undefined;
		if (hold === "busy") {
			if (Date.now() <= deadline) backoff();
			continue;
		}
		try {
			return op();
		} finally {
			release(target, hold);
		}
	}
	recordLockTimeout(target);
	return undefined;
}
