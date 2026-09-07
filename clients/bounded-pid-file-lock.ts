import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const waitArray = new Int32Array(new SharedArrayBuffer(4));

function ownerPidIsLive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
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
	if (pidUsable && !ownerPidIsLive(owner.pid)) return true;
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
 * Async directory-lock variant for commits that may span awaited I/O. Stale
 * owners are renamed aside before inspection/removal; token-checked release
 * likewise renames first, so a late owner can never delete its replacement.
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
	for (;;) {
		const release = await tryAcquireQuarantineLock(lockPath, options.staleMs);
		if (release) return release;
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

/**
 * Acquire a bounded synchronous cross-process file lock.
 *
 * PID liveness cannot distinguish a recycled PID from the original owner. A
 * recycled PID can therefore make a stale lock look live, but only for the
 * caller's bounded wait. OS start-time validation would require a platform-
 * specific subprocess on this synchronous behavior-gating path; the unique
 * token instead prevents a late release from deleting a replacement lock.
 */
interface BoundedPidFileLockOptions {
	waitMs: number;
	retryMs: number;
	timeoutMessage: string;
}

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
	for (;;) {
		try {
			const fd = fs.openSync(lockPath, "wx");
			fs.writeFileSync(fd, token, "utf8");
			fs.closeSync(fd);
			return () => {
				try {
					if (fs.readFileSync(lockPath, "utf8") === token) {
						fs.unlinkSync(lockPath);
					}
				} catch {
					// Protected write completed; cleanup is best-effort.
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const [pidText] = fs.readFileSync(lockPath, "utf8").split(":", 1);
				if (!ownerPidIsLive(Number.parseInt(pidText ?? "", 10))) {
					fs.unlinkSync(lockPath);
					continue;
				}
			} catch (lockError) {
				if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
			}
			if (Date.now() >= deadline) {
				if (options.onContention === "skip-log") {
					options.logContention();
					return null;
				}
				throw new Error(options.timeoutMessage, { cause: error });
			}
			Atomics.wait(waitArray, 0, 0, options.retryMs);
		}
	}
}
