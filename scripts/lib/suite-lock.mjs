/**
 * scripts/lib/suite-lock.mjs
 *
 * Core lock primitives for the machine-wide test-suite lock (#1101), used by
 * scripts/with-test-lock.mjs. Named to avoid the repo's `test-*.mjs`
 * .gitignore pattern (reserved for ephemeral scratch fixtures) — kept in
 * its own importable module (rather than inline in with-test-lock.mjs) so a
 * unit test can exercise acquire/release/contention/stale-takeover directly,
 * with short poll intervals, without spawning a real process tree.
 *
 * Pattern mirrors clients/installer/index.ts's `.install.lock`
 * (acquireInstallLock / isProcessAlive): atomic create via
 * fs.open(path, "wx"), owner JSON body `{ pid, startedIso }`, and "stale once
 * the recorded PID is confirmed dead" takeover. This is a minimal standalone
 * re-implementation (not an import of clients/installer/index.ts) because
 * scripts/ must run as plain .mjs before `npm run build` compiles
 * clients/*.ts to clients/*.js — see that file for the original if the two
 * ever need to be reconciled. ONE deliberate divergence from that original:
 * `.install.lock` ALSO ages out a lock with a still-live, readable PID once
 * it exceeds the owner's install bound + slack (#946 F1's PID-recycle
 * defense — an install has a known bounded duration to size that against).
 * This lock does NOT do that (see point 5 below) — a test-suite run has no
 * such bound.
 *
 * OS-agnosticism, explicitly:
 *  1. Locking is done ONLY via atomic file create (`fs.open(path, "wx")`),
 *     which is atomic on both POSIX and Windows filesystems — no
 *     flock/fcntl/byte-range lock APIs, which differ across OSes and don't
 *     exist uniformly on Windows.
 *  2. PID liveness is `process.kill(pid, 0)`; EPERM is treated as ALIVE
 *     (Windows returns EPERM, not ESRCH, for some protected-but-live
 *     processes), so only ESRCH (or any non-EPERM error) is treated as dead.
 *  3. Correctness never depends on the release handler running: a hard kill
 *     (Windows `taskkill /F`, POSIX SIGKILL) skips both the `finally` in
 *     with-test-lock.mjs and the best-effort `process.once("exit", ...)`
 *     cleanup below. The stale-after-PID-dead takeover below is the actual
 *     recovery path and is covered by a dedicated test ("lockfile exists,
 *     recorded PID dead -> immediate takeover", no age/timeout wait needed).
 *  4. Windows can transiently hold a file open (AV scanners, search
 *     indexer) so unlinks can fail with EBUSY/EPERM even when no other
 *     pi-lens process is involved. Both stale-takeover removal and release
 *     retry the unlink a few times with a short backoff before giving up
 *     (and logging if they ultimately fail — the next waiter's stale check
 *     still recovers it). A momentarily-unreadable-but-present lock file
 *     during acquire is treated as CONTENDED (wait/retry), never as a crash.
 *  5. The lock body records `{ pid, startedIso }` (an ISO-8601 string, not
 *     just an epoch number) so heartbeat/timeout messages are human-legible
 *     ("held by PID <pid> since <startedIso>") for exactly this diagnosis:
 *     unlike `.install.lock`, this lock has NO age-expiry path for a lock
 *     whose recorded PID still reads as alive — deliberately, since a
 *     full-suite run has no bounded duration for a timeout to be sized
 *     against, and the owner never touches the lock file's mtime while
 *     holding it (so an mtime-based bound would just be a second arbitrary
 *     guess). The consequence: if the OS recycles a dead PID for an
 *     unrelated live process before a waiter re-checks, that waiter treats
 *     the lock as still (wrongly) held and WAITS FOREVER — recoverable only
 *     by a human reading the heartbeat's pid+startedIso and deleting the
 *     lock file by hand. This is strictly worse than the installer's
 *     bounded wait for that one PID-recycle case, traded deliberately for
 *     never taking over a run that is still genuinely in progress. Possible
 *     future hardening: have the owner periodically touch the lock file's
 *     mtime while still running, so a waiter could safely distinguish
 *     "stale mtime + dead-looking PID" from "recycled PID, still running" —
 *     not implemented here.
 *  6. Paths go through `os.homedir()` / `path.join()` throughout, never
 *     hand-built strings. Tests pass an explicit `lockPath` under a
 *     `fs.mkdtemp()` directory (or set `PI_LENS_HOME` to one) so they never
 *     touch the developer's real `~/.pi-lens`, and behavior doesn't depend
 *     on path casing or separator conventions.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Best-effort synchronous cleanup on process exit (mirrors
// activeInstallLocks in clients/installer/index.ts): if the wrapper is
// killed before its `finally` runs, still try to drop the lock file so the
// next owner doesn't have to wait out a full PID-liveness check against a
// dead process. Purely best-effort — a hard kill (SIGKILL / taskkill /F)
// skips this too, which is why correctness rests on the stale-PID-dead
// takeover, not on this handler running (see file header, point 3).
/** @type {Set<string>} */
const activeLocks = new Set();
let exitCleanupRegistered = false;

function registerExitCleanup() {
	if (exitCleanupRegistered) return;
	exitCleanupRegistered = true;
	process.once("exit", () => {
		for (const lockPath of activeLocks) {
			try {
				fs.unlinkSync(lockPath);
			} catch {
				// Best effort; the next owner verifies this PID is dead.
			}
		}
	});
}

/**
 * Default lock location: ONE machine-wide file, not per-repo. Concurrent
 * full-suite runs contend for the same machine resources (CPU, RAM) even
 * when they check out different worktrees of the same repo, or entirely
 * different repos — so this lock intentionally does NOT key on the repo
 * root path. `PI_LENS_HOME` (same override used by
 * clients/file-utils.ts#getGlobalPiLensDir) relocates it, primarily so
 * tests can point at an isolated temp home.
 *
 * @returns {string}
 */
export function getLockPath() {
	const override = process.env.PI_LENS_HOME?.trim();
	const home = override
		? path.resolve(override)
		: path.join(os.homedir(), ".pi-lens");
	return path.join(home, "test-suite.lock");
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the PID exists but we lack permission to signal it —
		// still alive (observed on Windows for some protected live
		// processes). Any other error (ESRCH, etc.) means it's gone.
		const error = /** @type {NodeJS.ErrnoException} */ (err);
		return error.code === "EPERM";
	}
}

/**
 * @param {{ pid?: unknown, startedIso?: unknown } | null} owner
 * @returns {string}
 */
function describeOwner(owner) {
	if (!owner || typeof owner.pid !== "number" || !Number.isInteger(owner.pid)) {
		return "unknown owner";
	}
	const started =
		typeof owner.startedIso === "string" ? owner.startedIso : "unknown time";
	return `PID ${owner.pid} since ${started}`;
}

/**
 * Default number of concurrent SHARED slots (#2435). Targeted `vitest run
 * <files>` batches from parallel agents used to bypass this lock entirely by
 * design — cheap individually, but 4-6 of them at once saturate the box and
 * produce exactly the timeout/spawn-budget flake class the exclusive lock
 * exists to prevent (#2435 evidence: 27-69 such failures per local full run,
 * none reproducible in isolation). Two is deliberately small: the point is a
 * ceiling on concurrent vitest fork pools, not a queue. #3839 kept it at two
 * when the pre-push hook joined the slots: a local run may fork up to 8
 * (50% of cores, capped, scripts/lib/worker-budget.mjs) and the box already sits at
 * load 100+, so the hook takes one of the same two slots instead of the
 * machine, and the ceiling on lock-managed fork pools does not rise. The
 * exclusive holder drains every slot up to MAX_SHARED_SLOTS, whatever count its
 * own env resolved, so a differing `--shared=N` elsewhere cannot hide a holder
 * from a full suite; this count only sizes the shared ceiling.
 */
export const DEFAULT_SHARED_SLOTS = 2;

/**
 * Highest slot count an acquirer can ask for (`resolveSharedSlots` clamps to
 * it), so slot files `0..MAX_SHARED_SLOTS-1` are every file that can exist.
 * The exclusive drain scans all of them (#3839): its own slot count only sizes
 * the shared ceiling, never the set of holders a full suite must wait for.
 */
export const MAX_SHARED_SLOTS = 32;

/**
 * Path of shared slot `index`, derived from the exclusive lock path so a
 * test that redirects `lockPath` into a temp dir redirects the slots with it
 * (single source of truth for the lock directory — never a second env read).
 *
 * @param {string} lockPath
 * @param {number} index
 * @returns {string}
 */
export function getSlotPath(lockPath, index) {
	const dir = path.dirname(lockPath);
	const ext = path.extname(lockPath);
	const stem = path.basename(lockPath, ext);
	return path.join(dir, `${stem}.slot-${index}${ext}`);
}

/**
 * Resolve a requested slot count to a sane integer. NaN/negative/garbage all
 * fall back to the default rather than to 0 (0 slots would mean "shared runs
 * can never acquire", a silent hang) — the repo's standing
 * `Number.isFinite`-before-`Math.max` guard for env-sourced numbers.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function resolveSharedSlots(raw) {
	const value = Number(raw);
	if (!Number.isFinite(value)) return DEFAULT_SHARED_SLOTS;
	const floored = Math.floor(value);
	if (floored < 1) return DEFAULT_SHARED_SLOTS;
	return Math.min(floored, MAX_SHARED_SLOTS);
}

/**
 * Remove a lock file, retrying briefly on transient Windows file-hold
 * errors (EBUSY/EPERM from AV/indexer) instead of failing immediately.
 * Returns true if the file was removed (or already gone), false if it
 * could not be removed after retries (logged by the caller; the next
 * waiter's stale-PID check still recovers it).
 *
 * @param {string} lockPath
 * @param {{ retries?: number, delayMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
async function removeLockWithRetry(lockPath, opts = {}) {
	const { retries = 3, delayMs = 50 } = opts;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			await fsp.unlink(lockPath);
			return true;
		} catch (err) {
			const error = /** @type {NodeJS.ErrnoException} */ (err);
			if (error.code === "ENOENT") return true;
			const transient = error.code === "EBUSY" || error.code === "EPERM";
			if (!transient || attempt === retries) {
				return false;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return false;
}

/**
 * Read one lock file's state without taking it.
 *
 * Staleness follows the SAME two rules acquireTestLock uses, deliberately —
 * a readable-but-dead PID is stale immediately; an unreadable/corrupt file is
 * stale only once it ages past `staleMaxAgeMs`; a readable LIVE PID is never
 * aged out (see the file header, point 5). Sharing the rules between the
 * exclusive lock and the shared slots is the point: a second, subtly
 * different staleness policy for slots would be exactly the hand-rolled
 * parallel state this repo keeps folding back onto one seam.
 *
 * @param {string} lockPath
 * @param {number} staleMaxAgeMs
 * @returns {Promise<{ state: "free"|"held"|"stale", owner: { pid?: unknown, startedIso?: unknown } | null }>}
 */
async function inspectLock(lockPath, staleMaxAgeMs) {
	/** @type {{ pid?: unknown, startedIso?: unknown } | null} */
	let owner = null;
	try {
		owner = JSON.parse(await fsp.readFile(lockPath, "utf8"));
	} catch (err) {
		const error = /** @type {NodeJS.ErrnoException} */ (err);
		if (error.code === "ENOENT") return { state: "free", owner: null };
		// Present but unreadable (racing writer / transient Windows hold):
		// fall through to the mtime bound below.
	}
	if (
		owner &&
		typeof owner.pid === "number" &&
		Number.isInteger(owner.pid) &&
		owner.pid > 0
	) {
		return { state: isProcessAlive(owner.pid) ? "held" : "stale", owner };
	}
	try {
		const stat = await fsp.stat(lockPath);
		return {
			state: Date.now() - stat.mtimeMs > staleMaxAgeMs ? "stale" : "held",
			owner,
		};
	} catch {
		// Raced a release between the read and the stat.
		return { state: "free", owner: null };
	}
}

/**
 * Atomically create `lockPath` with this process as owner. Returns false when
 * the file already exists (or is transiently unopenable on Windows — treated
 * as contended for the same reason acquireTestLock does); throws on anything
 * else.
 *
 * @param {string} lockPath
 * @returns {Promise<boolean>}
 */
async function createOwnedLock(lockPath) {
	try {
		const handle = await fsp.open(lockPath, "wx");
		try {
			await handle.writeFile(
				JSON.stringify({
					pid: process.pid,
					startedIso: new Date().toISOString(),
				}),
			);
		} finally {
			await handle.close();
		}
		return true;
	} catch (err) {
		const error = /** @type {NodeJS.ErrnoException} */ (err);
		if (
			error.code === "EEXIST" ||
			error.code === "EBUSY" ||
			error.code === "EPERM"
		) {
			return false;
		}
		throw error;
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TAKEOVER_GENERATION = /^lock\.(\d+)(\.released)?$/;

/** @param {readonly string[]} entries */
function topTakeoverGeneration(entries) {
	let top = 0;
	for (const name of entries) {
		const match = TAKEOVER_GENERATION.exec(name);
		if (match && !match[2]) top = Math.max(top, Number(match[1]));
	}
	return top;
}

/**
 * Win the right to take over one stale lock file (#3516), with the
 * discipline of `clients/generation-lock.ts` (TLC-checked in
 * `formal/file-locks/GenerationLock.tla`), which scripts cannot import
 * before a build: a directory of generations `lock.<n>`, where winning is
 * the exclusive create of the next generation. Of several takers that judged
 * the same generation free or stale, one create succeeds. A generation is
 * held while it is neither marked released nor stale by `inspectLock`'s
 * rules, so a taker that died holding it does not wedge later takeovers.
 *
 * @param {string} dir
 * @param {number} staleMaxAgeMs
 * @returns {Promise<{ dir: string, generation: number } | undefined>}
 */
async function acquireTakeover(dir, staleMaxAgeMs) {
	await fsp.mkdir(dir, { recursive: true });
	const listed = await fsp.readdir(dir);
	const top = topTakeoverGeneration(listed);
	if (!listed.includes(`lock.${top}.released`)) {
		const { state } = await inspectLock(
			path.join(dir, `lock.${top}`),
			staleMaxAgeMs,
		);
		if (state === "held") return undefined;
	}
	const takeover = { dir, generation: top + 1 };
	if (!(await createOwnedLock(path.join(dir, `lock.${takeover.generation}`))))
		return undefined;
	// A listing taken before cleanup can re-create a generation cleanup
	// removed; the new generation then sits below the top, and must back off.
	const entries = await fsp.readdir(dir);
	if (topTakeoverGeneration(entries) > takeover.generation) {
		await releaseTakeover(takeover);
		return undefined;
	}
	// Keep the predecessor, as generation-lock.ts does, so a taker whose
	// listing still shows it as the top collides with this generation.
	for (const name of entries) {
		const match = TAKEOVER_GENERATION.exec(name);
		if (!match || Number(match[1]) + 1 >= takeover.generation) continue;
		await removeLockWithRetry(path.join(dir, name));
	}
	return takeover;
}

/**
 * A write that fails throws, as a failed create does: the generation stays
 * held until this process dies, and `inspectLock` then reads it as stale.
 *
 * @param {{ dir: string, generation: number }} takeover
 */
async function releaseTakeover(takeover) {
	await fsp.writeFile(
		path.join(takeover.dir, `lock.${takeover.generation}.released`),
		"",
	);
}

/**
 * Remove a lock file this caller judged stale, without the #3476 race
 * (#3516). Removing it by path let two takers that judged the same dead
 * holder stale each remove it, and the later removal deleted the earlier
 * taker's fresh lock, so both entered. Only the winner of the takeover
 * removes, and only after reading the file again: under the takeover, a
 * stale file can change only through a writer from before #3516.
 *
 * @param {string} lockPath
 * @param {number} staleMaxAgeMs
 * @returns {Promise<boolean>} whether this call removed the file. False when
 *   another taker holds the takeover, the file is no longer stale, or it
 *   could not be removed; the caller waits and looks again.
 */
async function removeStaleLock(lockPath, staleMaxAgeMs) {
	const takeover = await acquireTakeover(`${lockPath}.takeover`, staleMaxAgeMs);
	if (!takeover) return false;
	try {
		const { state } = await inspectLock(lockPath, staleMaxAgeMs);
		if (state !== "stale") return false;
		return await removeLockWithRetry(lockPath);
	} finally {
		await releaseTakeover(takeover);
	}
}

/**
 * Wait until every shared slot is free (or reclaimable as stale), called by
 * the EXCLUSIVE holder AFTER it already owns the exclusive lock file. That
 * order is what makes the protocol terminate: a shared acquirer re-checks
 * the exclusive lock immediately after taking a slot and gives its slot back
 * when the lock is held, so the drain cannot be starved by an endless stream
 * of new shared runs.
 *
 * @param {object} options
 * @returns {Promise<void>}
 */
async function drainSharedSlots({
	lockPath,
	slots,
	start,
	timeoutMs,
	pollIntervalMs,
	heartbeatIntervalMs,
	staleMaxAgeMs,
	log,
}) {
	let lastHeartbeat = 0;
	for (;;) {
		let busy = 0;
		// Every slot file that can exist, not just this process's own `slots`:
		// an acquirer started with a larger `--shared=N` or
		// PI_LENS_TEST_SHARED_SLOTS may hold an index above it (#3839).
		for (let index = 0; index < MAX_SHARED_SLOTS; index++) {
			const slotPath = getSlotPath(lockPath, index);
			const { state } = await inspectLock(slotPath, staleMaxAgeMs);
			if (state === "free") continue;
			if (state === "stale") {
				// By path, unlike every other stale removal (#3516): this runs
				// while this process already holds the exclusive lock, and a
				// shared taker that re-created the slot since this read gives it
				// back at its own re-check of the exclusive lock.
				await removeLockWithRetry(slotPath);
				continue;
			}
			busy++;
		}
		if (busy === 0) return;

		const now = Date.now();
		if (timeoutMs > 0 && now - start > timeoutMs) {
			// Prefix is pinned: scripts/pre-push-targeted-tests.mjs matches a
			// caller's stderr for a LINE STARTING `[with-test-lock] timed out after
			// <n>ms waiting for test-suite lock` (with-test-lock.mjs adds the
			// bracket prefix) to classify a bounded lock wait separately from a
			// real test failure. Keep the prefix when rewording.
			throw new Error(
				`timed out after ${timeoutMs}ms waiting for test-suite lock: ` +
					`${busy} of ${Math.max(slots, busy)} shared slot(s) still busy`,
			);
		}
		if (now - lastHeartbeat >= heartbeatIntervalMs) {
			lastHeartbeat = now;
			log(
				`waiting for test-suite lock: draining ${busy} of ${Math.max(slots, busy)} shared slot(s)`,
			);
		}
		await sleep(pollIntervalMs);
	}
}

/**
 * Acquire ONE of `slots` shared slots (#2435) — the mode targeted `vitest
 * run <files>` batches use, so several agents can iterate concurrently
 * without the box hosting six full fork pools at once.
 *
 * Protocol, and why it is this shape:
 *   1. Wait while the EXCLUSIVE lock is held (a full-suite run wins).
 *   2. Atomically create the first free slot file.
 *   3. RE-CHECK the exclusive lock. If it appeared between 1 and 2, give the
 *      slot back and go to 1.
 * Step 3 is the whole correctness argument: without it, an exclusive holder
 * that observed all slots free could run concurrently with a shared run that
 * had already passed its own check. With it, the two orders interleave
 * safely and neither side can deadlock — the exclusive holder never yields
 * its lock while draining, and the shared side always yields.
 *
 * Same timeout/heartbeat/stale-reclaim semantics as acquireTestLock; a slot
 * whose recorded PID is dead is reclaimed immediately.
 *
 * @param {object} [options] Same shape as acquireTestLock, plus `slots`.
 * @returns {Promise<{ release: () => Promise<void>, lockPath: string, slotPath: string, slotIndex: number }>}
 */
export async function acquireSharedSlot(options = {}) {
	const lockPath = options.lockPath || getLockPath();
	const slots = resolveSharedSlots(
		options.slots ?? process.env.PI_LENS_TEST_SHARED_SLOTS,
	);
	const pollIntervalMs =
		options.pollIntervalMs ??
		(Number(process.env.PI_LENS_TEST_LOCK_POLL_MS) || 500);
	const heartbeatIntervalMs =
		options.heartbeatIntervalMs ??
		(Number(process.env.PI_LENS_TEST_LOCK_HEARTBEAT_MS) || 15_000);
	const timeoutMs =
		options.timeoutMs ??
		(Number(process.env.PI_LENS_TEST_LOCK_TIMEOUT_MS) || 0);
	const staleMaxAgeMs = options.staleMaxAgeMs ?? 5 * 60_000;
	const log = options.log || ((message) => console.error(message));

	await fsp.mkdir(path.dirname(lockPath), { recursive: true });

	const start = Date.now();
	let lastHeartbeat = 0;
	/** @type {string} */
	let waitReason = "";

	for (;;) {
		const exclusive = await inspectLock(lockPath, staleMaxAgeMs);
		if (exclusive.state === "stale") {
			await removeStaleLock(lockPath, staleMaxAgeMs);
		}
		if (exclusive.state !== "held") {
			for (let index = 0; index < slots; index++) {
				const slotPath = getSlotPath(lockPath, index);
				const slot = await inspectLock(slotPath, staleMaxAgeMs);
				if (slot.state === "stale")
					await removeStaleLock(slotPath, staleMaxAgeMs);
				else if (slot.state === "held") continue;

				if (!(await createOwnedLock(slotPath))) continue;

				// Acquire-then-verify: an exclusive holder may have taken the
				// lock while we were creating this slot.
				const recheck = await inspectLock(lockPath, staleMaxAgeMs);
				if (recheck.state === "held") {
					activeLocks.delete(slotPath);
					await removeLockWithRetry(slotPath);
					break;
				}

				activeLocks.add(slotPath);
				registerExitCleanup();
				let released = false;
				return {
					lockPath,
					slotPath,
					slotIndex: index,
					release: async () => {
						if (released) return;
						released = true;
						activeLocks.delete(slotPath);
						const removed = await removeLockWithRetry(slotPath);
						if (!removed) {
							log(
								`[test-lock] warning: could not remove shared slot file at ` +
									`${slotPath} after retries (Windows AV/indexer hold?); the ` +
									`next waiter's stale-PID check will recover it`,
							);
						}
					},
				};
			}
			waitReason = `all ${slots} shared slot(s) busy`;
		} else {
			waitReason = `exclusive test-suite lock held by ${describeOwner(exclusive.owner)}`;
		}

		const now = Date.now();
		if (timeoutMs > 0 && now - start > timeoutMs) {
			// Same pinned prefix as the exclusive path — see drainSharedSlots.
			throw new Error(
				`timed out after ${timeoutMs}ms waiting for test-suite lock: ${waitReason}`,
			);
		}
		if (now - lastHeartbeat >= heartbeatIntervalMs) {
			lastHeartbeat = now;
			log(`waiting for a shared test-suite slot: ${waitReason}`);
		}
		await sleep(pollIntervalMs);
	}
}

/**
 * Acquire the test-suite lock, waiting (with a heartbeat) if another process
 * already holds it. Resolves once the lock file has been atomically created
 * by this process AND every shared slot (#2435) has drained; the caller MUST
 * call the returned `release()` in a `finally`.
 *
 * @param {object} [options]
 * @param {string} [options.lockPath] Override the lock file path (default: getLockPath()).
 * @param {number} [options.pollIntervalMs] Poll backoff while contended (default: env PI_LENS_TEST_LOCK_POLL_MS or 500).
 * @param {number} [options.heartbeatIntervalMs] Max gap between heartbeat log lines while waiting (default: env PI_LENS_TEST_LOCK_HEARTBEAT_MS or 15000).
 * @param {number} [options.timeoutMs] Give up after this long waiting; 0/undefined = wait forever (default: env PI_LENS_TEST_LOCK_TIMEOUT_MS or 0).
 * @param {(message: string) => void} [options.log] Heartbeat sink (default: console.error).
 * @param {number} [options.staleMaxAgeMs] Age (ms) after which an unreadable/empty lock is treated as stale even without a readable owner PID (default: 5 minutes).
 * @param {number} [options.slots] Shared slots to drain before returning (default: env PI_LENS_TEST_SHARED_SLOTS or 2).
 * @returns {Promise<{ release: () => Promise<void>, lockPath: string }>}
 */
export async function acquireTestLock(options = {}) {
	const lockPath = options.lockPath || getLockPath();
	// The exclusive holder drains shared slots UNCONDITIONALLY, whether or not
	// its caller knows slots exist: a full-suite run must not share the box
	// with targeted runs, and making that depend on the caller passing a flag
	// would be a rail that silently defaults off.
	const slots = resolveSharedSlots(
		options.slots ?? process.env.PI_LENS_TEST_SHARED_SLOTS,
	);
	const pollIntervalMs =
		options.pollIntervalMs ??
		(Number(process.env.PI_LENS_TEST_LOCK_POLL_MS) || 500);
	const heartbeatIntervalMs =
		options.heartbeatIntervalMs ??
		(Number(process.env.PI_LENS_TEST_LOCK_HEARTBEAT_MS) || 15_000);
	const timeoutMs =
		options.timeoutMs ??
		(Number(process.env.PI_LENS_TEST_LOCK_TIMEOUT_MS) || 0);
	const staleMaxAgeMs = options.staleMaxAgeMs ?? 5 * 60_000;
	const log = options.log || ((message) => console.error(message));

	await fsp.mkdir(path.dirname(lockPath), { recursive: true });

	const start = Date.now();
	let lastHeartbeat = 0;

	// eslint-disable-next-line no-constant-condition -- bounded by timeoutMs when set
	while (true) {
		try {
			const handle = await fsp.open(lockPath, "wx");
			try {
				await handle.writeFile(
					JSON.stringify({
						pid: process.pid,
						startedIso: new Date().toISOString(),
					}),
				);
			} finally {
				await handle.close();
			}
			activeLocks.add(lockPath);
			registerExitCleanup();
			let released = false;
			const release = async () => {
				if (released) return;
				released = true;
				activeLocks.delete(lockPath);
				const removed = await removeLockWithRetry(lockPath);
				if (!removed) {
					log(
						`[test-lock] warning: could not remove lock file at ${lockPath} ` +
							`after retries (Windows AV/indexer hold?); the next waiter's ` +
							`stale-PID check will recover it`,
					);
				}
			};
			try {
				await drainSharedSlots({
					lockPath,
					slots,
					start,
					timeoutMs,
					pollIntervalMs,
					heartbeatIntervalMs,
					staleMaxAgeMs,
					log,
				});
			} catch (drainError) {
				// Never leak the exclusive lock on a drain timeout: without this
				// the file survives with a live PID, and every later run waits
				// forever on a holder that already gave up.
				await release();
				throw drainError;
			}
			return { lockPath, release };
		} catch (err) {
			const error = /** @type {NodeJS.ErrnoException} */ (err);
			// EBUSY/EPERM on the CREATE itself (not just on unlink — see
			// removeLockWithRetry) is a real, observed Windows race: a lock file
			// that was JUST unlinked by another process's release() can still
			// transiently reject a fresh `open(path, "wx")` with EPERM/EBUSY
			// before the OS fully drops the deleted file's handle. Treat that
			// exactly like EEXIST — contended, retry — rather than throwing;
			// otherwise a real two-waiter release/re-acquire handoff can
			// randomly crash the second waiter instead of letting it proceed.
			if (
				error.code !== "EEXIST" &&
				error.code !== "EBUSY" &&
				error.code !== "EPERM"
			) {
				throw error;
			}

			// The file exists but may be momentarily unreadable (a racing
			// writer, or a transient Windows file hold) — that is CONTENDED,
			// not a crash: treat it as "owner unknown" and keep waiting rather
			// than throwing.
			/** @type {{ pid?: unknown, startedIso?: unknown } | null} */
			let owner = null;
			try {
				owner = JSON.parse(await fsp.readFile(lockPath, "utf8"));
			} catch {
				// fall through to the mtime-based staleness check below
			}

			let stale = false;
			if (
				owner &&
				typeof owner.pid === "number" &&
				Number.isInteger(owner.pid) &&
				owner.pid > 0
			) {
				// Immediate takeover as soon as the recorded PID is confirmed
				// dead — no age/timeout wait required (point 3 above).
				stale = !isProcessAlive(owner.pid);
			} else {
				try {
					const stat = await fsp.stat(lockPath);
					stale = Date.now() - stat.mtimeMs > staleMaxAgeMs;
				} catch {
					// Raced a release between open() failing and stat() (both the
					// owner-read above and this stat found nothing) — loop and
					// retry acquisition. Still sleep pollIntervalMs first: without
					// it this path is an unbounded tight retry loop that ignores
					// timeoutMs (the deadline check below is never reached from
					// here), which would spin the CPU and could wait past
					// timeoutMs unbounded if this race kept re-triggering.
					await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
					continue;
				}
			}

			// #3516: another waiter may have judged the same owner stale and
			// already re-created the lock as its own. Only the takeover's winner
			// removes, after reading the file again. When this waiter did not
			// remove it (another taker holds the takeover, the file is no longer
			// stale, or a process holds a transient handle on it), it waits like
			// any contended waiter, under the same timeout.
			if (stale && (await removeStaleLock(lockPath, staleMaxAgeMs))) continue;

			const now = Date.now();
			if (timeoutMs > 0 && now - start > timeoutMs) {
				// Message shape is pinned: tests/scripts/suite-lock.test.ts:233
				// asserts against it directly, and scripts/pre-push-targeted-tests.mjs
				// matches a caller's stderr for a line starting "[with-test-lock]
				// timed out after <n>ms waiting for test-suite lock" to classify a
				// lock timeout separately from a real test failure. Reword both call
				// sites together with this string.
				throw new Error(
					`timed out after ${timeoutMs}ms waiting for test-suite lock held by ${describeOwner(owner)}`,
					{ cause: error },
				);
			}
			if (now - lastHeartbeat >= heartbeatIntervalMs) {
				lastHeartbeat = now;
				log(`waiting for test-suite lock held by ${describeOwner(owner)}`);
			}
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
	}
}
