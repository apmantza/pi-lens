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

const GENERATION = /^lock\.(\d+)(\.released)?$/;

export interface GenerationHold {
	readonly dir: string;
	readonly generation: number;
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

/** Release a generation this process holds by marking it released. */
export function releaseGeneration(hold: GenerationHold): void {
	try {
		fs.writeFileSync(path.join(hold.dir, releasedName(hold.generation)), "");
	} catch {
		// The generation stays live until its owner dies or the lease runs out.
	}
}

/**
 * One acquisition attempt: undefined when the lock is held or another taker
 * won the race; the caller backs off and retries.
 */
export function tryAcquireGeneration(
	dir: string,
	staleMs: number,
): GenerationHold | undefined {
	fs.mkdirSync(dir, { recursive: true });
	const listed = fs.readdirSync(dir);
	const top = topGeneration(listed);
	if (
		top > 0 &&
		!listed.includes(releasedName(top)) &&
		!pidFileIsStale(generationPath(dir, top), staleMs)
	) {
		return undefined;
	}
	const hold = { dir, generation: top + 1 };
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
	const entries = fs.readdirSync(dir);
	if (topGeneration(entries) > hold.generation) {
		releaseGeneration(hold);
		return undefined;
	}
	removeBelowPredecessor(dir, entries, hold.generation);
	return hold;
}
