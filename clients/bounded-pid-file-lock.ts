import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { BoundedFifoMap } from "./bounded-cache.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import {
	type GenerationHold,
	heartbeatIntervalMs,
	isLockContention,
	recordGenerationTakeover,
	recordLegacyLockHeld,
	releaseGeneration,
	startGenerationHeartbeat,
	topGenerationHolder,
	tryAcquireGeneration,
} from "./generation-lock.js";
import { realIsPidAlive } from "./pid-liveness.js";

const waitArray = new Int32Array(new SharedArrayBuffer(4));

/**
 * How long a bounded lock with no readable pid stays live (#3475), and since
 * #3476 the lease of the bounded lock's generations: a generation older than
 * this is stale even if its pid is alive. While the pre-#3476 file is also
 * taken (the bridge, #3489), that file is judged by pid liveness alone, so a
 * live holder still keeps every contender out past this lease.
 *
 * The exclusive create and the token write are separate steps, so a
 * contender can read a lock whose creator is alive but has not written its
 * token yet. Reading that empty file as a dead owner unlinked a live lock. A
 * lock with no parseable pid is therefore live until its mtime is this old,
 * which only a creator that died (or whose write threw) between the two steps
 * leaves behind. The same bound as the registry lock's LOCK_STALE_MS.
 */
const UNREADABLE_LOCK_STALE_MS = 5_000;

/**
 * The generation directory of a pid-file lock (#3476): `<store>.lock` holds
 * its generations in `<store>.locks`.
 */
function generationDir(lockPath: string): string {
	return `${lockPath}s`;
}

/** A contender's verdict on an existing bounded lock. */
function boundedLockIsStale(lockPath: string): boolean {
	const [pidText] = fs.readFileSync(lockPath, "utf8").split(":", 1);
	const pid = Number.parseInt(pidText ?? "", 10);
	if (Number.isSafeInteger(pid) && pid > 0) return !realIsPidAlive(pid);
	return Date.now() - fs.statSync(lockPath).mtimeMs > UNREADABLE_LOCK_STALE_MS;
}

interface QuarantinePidFileLockOptions extends BoundedPidFileLockOptions {
	staleMs: number;
}

type QuarantineLockOwner = {
	pid: number;
	createdAt: number;
	token: string;
};

function quarantinePath(lockPath: string, token: string): string {
	return `${lockPath}.quarantine-${process.pid}-${token}`;
}

async function restoreQuarantinedLock(
	lockPath: string,
	quarantined: string,
): Promise<void> {
	try {
		await fsp.rename(quarantined, lockPath);
	} catch {
		// A replacement owner may already hold the canonical name. Never overwrite it.
	}
}

async function releaseQuarantineLock(
	lockPath: string,
	token: string,
): Promise<void> {
	const quarantined = quarantinePath(lockPath, `release-${token}`);
	let renamed = false;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await fsp.rename(lockPath, quarantined);
			renamed = true;
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt === 2)
				return;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}
	if (!renamed) return;
	try {
		const owner = JSON.parse(
			await fsp.readFile(path.join(quarantined, "owner.json"), "utf8"),
		) as Partial<QuarantineLockOwner>;
		if (owner.token === token) {
			await fsp.rm(quarantined, { recursive: true, force: true });
		} else {
			await restoreQuarantinedLock(lockPath, quarantined);
		}
	} catch {
		await restoreQuarantinedLock(lockPath, quarantined);
	}
}

function quarantineOwnerIsStale(
	owner: QuarantineLockOwner,
	staleMs: number,
): boolean {
	// #1816: the two staleness signals are INDEPENDENT, and the original
	// conjunction made the dead-PID one unreachable. An `owner.json` with a
	// valid PID but a missing or non-numeric `createdAt` (an older writer, a
	// half-written file, a hand-edited one) short-circuited on the
	// `Number.isFinite` guard, so a dead owner never reclaimed and the lock
	// stayed poisoned for the life of the directory. This is
	// `installer/index.ts:173`'s predicate: a dead PID reclaims regardless of
	// `createdAt`, and an aged lock reclaims regardless of what the PID says.
	const pidUsable = Number.isInteger(owner.pid) && owner.pid > 0;
	if (pidUsable && !realIsPidAlive(owner.pid)) return true;
	return (
		Number.isFinite(owner.createdAt) && Date.now() - owner.createdAt > staleMs
	);
}

async function reclaimQuarantineLock(
	lockPath: string,
	staleMs: number,
): Promise<boolean> {
	const quarantined = quarantinePath(
		lockPath,
		`reclaim-${Date.now()}-${randomUUID()}`,
	);
	try {
		await fsp.rename(lockPath, quarantined);
	} catch {
		return false;
	}
	let stale = false;
	try {
		const owner = JSON.parse(
			await fsp.readFile(path.join(quarantined, "owner.json"), "utf8"),
		) as QuarantineLockOwner;
		stale = quarantineOwnerIsStale(owner, staleMs);
	} catch {
		try {
			stale = Date.now() - (await fsp.stat(quarantined)).mtimeMs > staleMs;
		} catch {
			stale = false;
		}
	}
	if (stale) {
		await fsp.rm(quarantined, { recursive: true, force: true });
		return true;
	}
	await restoreQuarantinedLock(lockPath, quarantined);
	return false;
}

/** The pre-#3476 directory lock; since #3476 only a generation holder takes it. */
async function tryAcquireQuarantineLock(
	lockPath: string,
	staleMs: number,
): Promise<(() => Promise<void>) | null> {
	const owner: QuarantineLockOwner = {
		pid: process.pid,
		createdAt: Date.now(),
		token: `${process.pid}-${Date.now()}-${randomUUID()}`,
	};
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await fsp.mkdir(lockPath);
			try {
				await fsp.writeFile(
					path.join(lockPath, "owner.json"),
					JSON.stringify(owner),
					"utf8",
				);
			} catch (error) {
				await fsp
					.rm(lockPath, { recursive: true, force: true })
					.catch(() => {});
				throw error;
			}
			return () => releaseQuarantineLock(lockPath, owner.token);
		} catch (error) {
			// none: EEXIST means another holder won the `mkdir`; the stale-owner
			// branch below decides whether this attempt reclaims the lock, and a
			// non-EEXIST failure rethrows on the next line.
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let stale: boolean;
		try {
			const existing = JSON.parse(
				await fsp.readFile(path.join(lockPath, "owner.json"), "utf8"),
			) as QuarantineLockOwner;
			stale = quarantineOwnerIsStale(existing, staleMs);
		} catch {
			try {
				stale = Date.now() - (await fsp.stat(lockPath)).mtimeMs > staleMs;
			} catch {
				stale = true;
			}
		}
		if (!stale || !(await reclaimQuarantineLock(lockPath, staleMs)))
			return null;
	}
	return null;
}

/**
 * One attempt at the quarantine lock since #3476: a generation in
 * `<lockPath>s` with `staleMs` as its lease, then the pre-#3476 directory
 * lock `lockPath` (above). Writers from older versions take only that
 * directory, so a generation holder holds it too, as the bounded lock holds
 * its old file. Only a generation holder takes it, so its rename-aside
 * takeover races only an older writer's own.
 *
 * #3515: this is an async holder — its caller's commit can span awaited I/O —
 * so a heartbeat keeps the generation's mtime fresh for the whole hold,
 * exactly as the installer's lock now does, rather than leaving `staleMs` as
 * the only thing standing between a slow commit and a stale-takeover race.
 */
async function tryAcquireQuarantineGeneration(
	lockPath: string,
	staleMs: number,
): Promise<(() => Promise<void>) | "busy" | "legacy-held"> {
	const hold = tryAcquireGeneration(generationDir(lockPath), staleMs);
	if (!hold) return "busy";
	if (hold.tookOverStale) recordGenerationTakeover(hold);
	let releaseLegacy: (() => Promise<void>) | null;
	try {
		releaseLegacy = await tryAcquireQuarantineLock(lockPath, staleMs);
	} catch (cause) {
		releaseGeneration(hold);
		throw cause;
	}
	if (releaseLegacy) {
		const heartbeat = startGenerationHeartbeat(
			hold,
			heartbeatIntervalMs(staleMs),
		);
		return async () => {
			heartbeat.stop();
			await releaseLegacy();
			releaseGeneration(hold);
		};
	}
	releaseGeneration(hold);
	return "legacy-held";
}

/**
 * Async lock variant for commits that may span awaited I/O. Since #3476 it
 * is a generation lock, so of two takers of a dead owner's lock exactly one
 * enters. The old takeover renamed the lock directory aside to inspect it,
 * and while a live successor's directory was aside a fourth writer could
 * create the path and enter beside it.
 */
export async function acquireQuarantinePidFileLock(
	lockPath: string,
	options: QuarantinePidFileLockOptions & { onContention?: "throw" },
): Promise<() => Promise<void>>;
export async function acquireQuarantinePidFileLock(
	lockPath: string,
	options: QuarantinePidFileLockOptions & {
		onContention: "skip-log";
		logContention: () => void;
	},
): Promise<(() => Promise<void>) | null>;
export async function acquireQuarantinePidFileLock(
	lockPath: string,
	options: QuarantinePidFileLockOptions &
		(
			| { onContention?: "throw" }
			| { onContention: "skip-log"; logContention: () => void }
		),
): Promise<(() => Promise<void>) | null> {
	const deadline = Date.now() + options.waitMs;
	let legacyHeldRecorded = false;
	for (;;) {
		const release = await tryAcquireQuarantineGeneration(
			lockPath,
			options.staleMs,
		);
		if (typeof release === "function") return release;
		if (release === "legacy-held" && !legacyHeldRecorded) {
			legacyHeldRecorded = true;
			recordLegacyLockHeld(lockPath);
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			if (options.onContention === "skip-log") {
				options.logContention();
				return null;
			}
			throw new Error(options.timeoutMessage);
		}
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(options.retryMs, remaining)),
		);
	}
}

interface BoundedPidFileLockOptions {
	waitMs: number;
	retryMs: number;
	timeoutMessage: string;
}

/**
 * The pre-#3476 bounded lock file, `lockPath` itself. Writers from older
 * versions take only this file, so while mixed versions run a generation
 * holder holds it too: an older writer blocks on it, and a live older writer
 * blocks the holder. Only a generation holder creates or removes it, so
 * writers of this version never race each other for it. A stale one is
 * removed by path, which races only an older writer's own takeover.
 */
function createLegacyBoundedLock(lockPath: string, token: string): boolean {
	try {
		fs.writeFileSync(lockPath, token, { encoding: "utf8", flag: "wx" });
		return true;
	} catch (cause) {
		if (isLockContention(cause)) return false;
		throw cause;
	}
}

function takeLegacyBoundedLock(lockPath: string, token: string): boolean {
	if (createLegacyBoundedLock(lockPath, token)) return true;
	try {
		if (!boundedLockIsStale(lockPath)) return false;
		fs.unlinkSync(lockPath);
	} catch {
		// Gone since the create, or (Windows) still open elsewhere: retry.
		return false;
	}
	return createLegacyBoundedLock(lockPath, token);
}

function releaseLegacyBoundedLock(lockPath: string, token: string): void {
	try {
		// An older writer's stale takeover may have replaced it: keep theirs.
		if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
	} catch {
		// Protected write completed; cleanup is best-effort.
	}
}

/**
 * One attempt: the hold, or why not: "busy" (the generation is held) or
 * "legacy-held" (the old file is). The caller retries either way.
 */
function tryAcquireBoundedLock(
	lockPath: string,
	token: string,
): GenerationHold | "busy" | "legacy-held" {
	const hold = tryAcquireGeneration(
		generationDir(lockPath),
		UNREADABLE_LOCK_STALE_MS,
	);
	if (!hold) return "busy";
	if (hold.tookOverStale) recordGenerationTakeover(hold);
	let took: boolean;
	try {
		took = takeLegacyBoundedLock(lockPath, token);
	} catch (cause) {
		releaseGeneration(hold);
		throw cause;
	}
	if (took) return hold;
	releaseGeneration(hold);
	return "legacy-held";
}

// #3594: per generation directory, the holder a wait last ran out on. Only a
// later holder writes another name, so a match is that same holder, still
// there. An unreadable holder is `undefined`, which never matches (a first
// wait is never skipped).
//
// Round 2 (review F1): the remembered name is one of two shapes, chosen by
// {@link currentHolderIdentity} from the CURRENT retry's own outcome, not a
// fixed choice per lock — `tryAcquireBoundedLock` has two contended outcomes
// and they name different things:
//   - "busy": the generation itself is held. Named by its top generation
//     file, `lock.<n> <pid> <ms>` (`topGenerationHolder`).
//   - "legacy-held": this call took and released its own fresh generation,
//     but the pre-#3476 bridge file (`lockPath` itself) is live. Named by
//     THAT file's own contents (`legacy <token>`).
// A generation has only a 5s lease (`UNREADABLE_LOCK_STALE_MS`) and no
// heartbeat, so a holder stuck past 5s is taken over by the next contender's
// always-run first try — which then finds the SAME live pid still holding
// the bridge file, and returns "legacy-held". Remembering only the busy
// shape left that (the normal state of a holder stuck more than 5s) with no
// memory at all: `topGenerationHolder` named a fresh, released generation on
// every call, never matching, so every call after the first ~3s paid the
// full wait again (round 1's miss — probed and reported in review).
const timedOutHolders = new BoundedFifoMap<string, string | undefined>(16);

/**
 * The name a remembered holder needs to match, for the outcome `hold` names.
 * `undefined` (unreadable file, race with a release) never matches — the
 * caller's `timedOutHolder !== undefined` check on the REMEMBERED value
 * already guards the first-wait case; this is the same safety for the
 * CURRENT read.
 */
function currentHolderIdentity(
	dir: string,
	lockPath: string,
	hold: "busy" | "legacy-held",
): string | undefined {
	if (hold === "busy") return topGenerationHolder(dir);
	try {
		// The bridge file's create (`wx`) and its token write are separate
		// steps (see the doc comment above `acquireBoundedPidFileLock`), so a
		// reader can meet it empty. An empty read is therefore never a real
		// holder's identity — `undefined`, like an unreadable one, so it can
		// never match a later reader's own empty-read coincidence either.
		const content = fs.readFileSync(lockPath, "utf8");
		return content ? `legacy ${content}` : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Acquire a bounded synchronous cross-process file lock.
 *
 * Since #3476 it is a generation lock (`clients/generation-lock.ts`) in
 * `<lockPath>s`, so of two takers of a dead owner's lock exactly one enters.
 * The old takeover unlinked `lockPath`, and a taker acting on an earlier
 * judgement could unlink a live successor's lock.
 *
 * A live holder is never superseded while the bridge to the pre-#3476 file
 * exists: a taker of its aged-out generation still backs off on that file,
 * which is judged by pid liveness alone. PID liveness cannot distinguish a
 * recycled PID from the original owner, so a recycled PID still wedges the
 * lock until that process exits, as before #3476. Removing the bridge
 * (#3489) gives live holders the UNREADABLE_LOCK_STALE_MS lease.
 *
 * #3594: once a wait has run out on the current holder, a later call that
 * finds the SAME holder still there tries once (the `tryAcquireBoundedLock`
 * call below always runs at least once) and falls back at once, exactly as a
 * timed-out wait does — throwing, or returning `null` under
 * `onContention: "skip-log"`. A genuinely new holder gets the full wait
 * again. "The same holder" is named by {@link currentHolderIdentity} from
 * the CURRENT retry's own outcome (round 2, review F1): a generation has
 * only a 5s lease and no heartbeat, so a holder stuck past 5s is taken over
 * by the next contender's own first try, which then finds the pre-#3476
 * bridge file still held by that same live pid ("legacy-held") — the
 * NORMAL state of a holder stuck more than a few seconds, not an edge case.
 * Naming only the generation-file identity left that state unrecognized on
 * every later call (a released, re-taken-over generation is a fresh name
 * every time), so the skip stopped firing again after roughly one lease.
 */
export function acquireBoundedPidFileLock(
	lockPath: string,
	options: BoundedPidFileLockOptions & { onContention?: "throw" },
): () => void;
export function acquireBoundedPidFileLock(
	lockPath: string,
	options: BoundedPidFileLockOptions & {
		onContention: "skip-log";
		logContention: () => void;
	},
): (() => void) | null;
export function acquireBoundedPidFileLock(
	lockPath: string,
	options: BoundedPidFileLockOptions &
		(
			| { onContention?: "throw" }
			| { onContention: "skip-log"; logContention: () => void }
		),
): (() => void) | null {
	const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
	const deadline = Date.now() + options.waitMs;
	const dir = generationDir(lockPath);
	const timedOutHolder = timedOutHolders.get(dir);
	let legacyHeldRecorded = false;
	for (;;) {
		const hold = tryAcquireBoundedLock(lockPath, token);
		if (typeof hold === "object") {
			return () => {
				releaseLegacyBoundedLock(lockPath, token);
				releaseGeneration(hold);
			};
		}
		if (hold === "legacy-held" && !legacyHeldRecorded) {
			legacyHeldRecorded = true;
			recordLegacyLockHeld(lockPath);
		}
		if (
			timedOutHolder !== undefined &&
			currentHolderIdentity(dir, lockPath, hold) === timedOutHolder
		) {
			recordDegradationOnce({
				kind: "bounded-pid-lock-wait-skipped",
				subject: path.resolve(dir),
				reason: `did not wait: ${timedOutHolder} still holds the lock after an earlier wait ran out`,
			});
			if (options.onContention === "skip-log") {
				options.logContention();
				return null;
			}
			throw new Error(options.timeoutMessage);
		}
		if (Date.now() >= deadline) {
			timedOutHolders.set(dir, currentHolderIdentity(dir, lockPath, hold));
			if (options.onContention === "skip-log") {
				options.logContention();
				return null;
			}
			throw new Error(options.timeoutMessage);
		}
		Atomics.wait(waitArray, 0, 0, options.retryMs);
	}
}
