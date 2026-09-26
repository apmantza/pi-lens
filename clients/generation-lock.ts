/**
 * Generation lock: cross-process mutual exclusion that never removes a lock
 * by path (#3476). The TLC-checked design is
 * `formal/file-locks/GenerationLock.tla`.
 *
 * The lock is a directory of files `lock.1`, `lock.2`, … The holder is the
 * creator of the highest generation while that file is neither released
 * (`lock.<g>.released` exists) nor stale (its owner pid is dead, or its mtime
 * is older than the lease). Every acquisition, a stale takeover included, is
 * an exclusive create of the next generation, so of several takers that
 * judged the same generation stale exactly one create succeeds. The old
 * pid-file locks removed the stale lock by path instead, and a taker acting
 * on an earlier judgement could remove a live successor's lock.
 *
 * The generation is created with `wx` and its pid written in the same call,
 * not linked from a written temp file: hard links fail on FAT/exFAT and some
 * network shares (the reason #3475 kept `wx`). A reader that meets the
 * generation before its pid is written reads it as live until its mtime
 * passes the lease, the rule #3475 gave the bounded lock, so the empty window
 * can only delay a takeover, never admit one.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { incrementDegradationCount } from "./degradation-ledger.js";

const GENERATION = /^lock\.(\d+)(\.released)?$/;

export interface GenerationHold {
	readonly dir: string;
	readonly generation: number;
	/** The generation below was held by a dead or aged-out owner, not released. */
	readonly tookOverStale: boolean;
}

/** The pid a `<pid> <ms>` lock file names, if it names one. */
export function pidFileOwner(file: string): number | undefined {
	try {
		const pid = Number(fs.readFileSync(file, "utf8").trim().split(/\s+/)[0]);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function isPidAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
	}
}

/**
 * A pid lock file is stale once its mtime is `staleMs` old (the lease) or
 * its owner pid is dead. One with no readable pid is live until the lease
 * runs out. A file that cannot be read now is not stale: the caller retries.
 */
export function pidFileIsStale(file: string, staleMs: number): boolean {
	try {
		const stat = fs.statSync(file);
		if (Date.now() - stat.mtimeMs > staleMs) return true;
		const pid = pidFileOwner(file);
		return pid !== undefined && !isPidAlive(pid);
	} catch {
		return false;
	}
}

/** Lock contention, including Windows' delete-pending and sharing errors. */
export function isLockContention(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "EEXIST" || code === "EPERM" || code === "EBUSY";
}

function generationPath(dir: string, generation: number): string {
	return path.join(dir, `lock.${generation}`);
}

function releasedName(generation: number): string {
	return `lock.${generation}.released`;
}

function topGeneration(entries: readonly string[]): number {
	let top = 0;
	for (const name of entries) {
		const match = GENERATION.exec(name);
		if (match && !match[2]) top = Math.max(top, Number(match[1]));
	}
	return top;
}

/**
 * The holder deletes generations, and their markers, below its predecessor.
 * The predecessor stays so that a taker whose listing still shows it as the
 * top collides with the holder's own generation. A delete that fails
 * (Windows: another process has the file open) is left for the next holder.
 */
function removeBelowPredecessor(
	dir: string,
	entries: readonly string[],
	generation: number,
): void {
	for (const name of entries) {
		const match = GENERATION.exec(name);
		if (!match || Number(match[1]) + 1 >= generation) continue;
		try {
			fs.unlinkSync(path.join(dir, name));
		} catch {
			// Left for the next holder.
		}
	}
}

/**
 * Record a stale takeover for the bounded, quarantine and installer locks.
 * The registry lock records its own kinds.
 */
export function recordGenerationTakeover(hold: GenerationHold): void {
	incrementDegradationCount({
		kind: "generation-lock-stale-takeover",
		subject: path.resolve(hold.dir),
		reason: `took over lock generation ${hold.generation - 1} from a dead or aged-out holder`,
	});
}

/**
 * Record a back-off on a held pre-generation lock file, once per acquisition.
 * Its holder is a writer from before #3476, or this version's own holder
 * whose generation outlived the lease while it was still inside.
 */
export function recordLegacyLockHeld(legacyPath: string): void {
	incrementDegradationCount({
		kind: "generation-lock-legacy-held",
		subject: path.resolve(legacyPath),
		reason: `backed off: ${path.basename(legacyPath)} is held by another writer (one from before #3476, or a holder past the generation lease)`,
	});
}

/** Release a generation this process holds by marking it released. */
export function releaseGeneration(hold: GenerationHold): void {
	try {
		fs.writeFileSync(path.join(hold.dir, releasedName(hold.generation)), "");
	} catch {
		// The generation stays live until its owner dies or the lease runs out.
	}
}

/** A running heartbeat started by {@link startGenerationHeartbeat}. */
export interface GenerationHeartbeat {
	/** Stop refreshing. Idempotent; the holder calls this in `finally`. */
	stop(): void;
}

/**
 * How often a heartbeat refreshes a held generation's mtime: a quarter of the
 * lease, floored at 1s so a very short lease (tests) never thrashes the
 * filesystem. A quarter leaves three missed ticks of margin before a
 * contender's `pidFileIsStale` would judge the generation stale (#3515).
 */
export function heartbeatIntervalMs(leaseMs: number): number {
	return Math.max(1_000, Math.floor(leaseMs / 4));
}

/**
 * Keep a held generation's mtime fresh so a hold that legitimately outlives
 * its lease is never judged stale by a contender's `tryAcquireGeneration`
 * (#3515: an ERESOLVE npm install can run two 120s attempts inside the
 * installer's 180s lease). An unref'd interval — it must never keep the
 * process alive on its own — that the holder always stops in `finally`,
 * released or not. A failed `utimesSync` (the generation directory gone, a
 * transient I/O error) is swallowed here: `ownsTopGeneration` below is what
 * the holder checks before a write it cannot safely race, not this tick.
 */
export function startGenerationHeartbeat(
	hold: GenerationHold,
	intervalMs: number,
): GenerationHeartbeat {
	const file = generationPath(hold.dir, hold.generation);
	const timer = setInterval(() => {
		try {
			const now = new Date();
			fs.utimesSync(file, now, now);
		} catch {
			// Best effort; see doc comment above.
		}
	}, intervalMs);
	timer.unref();
	return { stop: () => clearInterval(timer) };
}

/**
 * Whether `hold` is still the live top generation: its own generation is
 * neither marked released nor superseded by a taker that judged it stale.
 * The holder calls this right before a write it cannot safely race with a
 * second holder (#3515) — `startGenerationHeartbeat` is what USUALLY keeps
 * that race from becoming reachable at all; this is the check for the tick
 * it missed (a suspended process, a blocked event loop, a heartbeat write
 * that failed). Any error reading the directory (removed, unreadable) is
 * "no longer owned": the safe direction for a check guarding a write.
 */
export function ownsTopGeneration(hold: GenerationHold): boolean {
	try {
		const entries = fs.readdirSync(hold.dir);
		if (entries.includes(releasedName(hold.generation))) return false;
		return topGeneration(entries) === hold.generation;
	} catch {
		return false;
	}
}

/**
 * One acquisition attempt: undefined when the lock is held or another taker
 * won the race; the caller backs off and retries. Any other filesystem error
 * throws, after releasing any generation this attempt created.
 */
export function tryAcquireGeneration(
	dir: string,
	staleMs: number,
): GenerationHold | undefined {
	fs.mkdirSync(dir, { recursive: true });
	const listed = fs.readdirSync(dir);
	const top = topGeneration(listed);
	const free = top === 0 || listed.includes(releasedName(top));
	if (!free && !pidFileIsStale(generationPath(dir, top), staleMs)) {
		return undefined;
	}
	const hold = { dir, generation: top + 1, tookOverStale: !free };
	try {
		fs.writeFileSync(
			generationPath(dir, hold.generation),
			`${process.pid} ${Date.now()}\n`,
			{ flag: "wx" },
		);
	} catch (error) {
		if (isLockContention(error)) return undefined;
		throw error;
	}
	// A listing taken before cleanup can re-create a generation cleanup
	// removed; the new generation then sits below the top, and must back off.
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch (cause) {
		// Unreleased, this live process's generation would hold every writer
		// out until the lease ran out.
		releaseGeneration(hold);
		throw cause;
	}
	if (topGeneration(entries) > hold.generation) {
		releaseGeneration(hold);
		return undefined;
	}
	removeBelowPredecessor(dir, entries, hold.generation);
	return hold;
}
