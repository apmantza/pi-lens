/**
 * Cross-process instance registry (#449 slice 1).
 *
 * Observability substrate for multi-agent LSP resource sharing. Records, in
 * a single machine-global file (`~/.pi-lens/instances.json`), every live
 * pi-lens process: its pid, project root, live LSP child servers, RSS, and a
 * heartbeat timestamp. Later slices (cross-process budget, same-root warm
 * attach) build on this; slice 1 is purely observational — it changes no
 * dispatch/LSP behavior, it only records state and reaps stale entries /
 * orphaned LSP children (#472).
 *
 * File shape: `{ instances: InstanceEntry[] }`. Missing or corrupt file is
 * treated as `{ instances: [] }` — this module must never throw on a read.
 *
 * Concurrency: every whole-file writer holds the registry lock
 * (`instance-registry-lock.ts`) across its read-modify-write: a generation
 * lock in `<registry>.locks/` (#3476), plus the old `<registry>.lock` file so
 * writers from older versions still block. Contenders use 5-25ms jittered
 * backoff for up to 500ms. A generation older than 5s or owned by a dead pid
 * is taken over by exclusively creating the next one, so only one taker
 * wins; takeovers, timeouts and lock errors are recorded in the ledger.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic, writeFileAtomicAsync } from "./atomic-write.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import {
	createGenerationSource,
	type GenerationHandle,
	type GenerationSource,
} from "./generation-guard.js";
import {
	LOCK_WAIT_THROUGH_LEASE_MS,
	withInstanceRegistryLock,
	withInstanceRegistryLockSync,
} from "./instance-registry-lock.js";
// #735: reuse the #449/#525 reaper's exact conservative liveness check
// (`process.kill(pid, 0)`, ESRCH-only-means-dead) rather than inventing a
// second one — see realIsPidAlive's own docstring, which already calls out
// clients/lsp-budget.ts as a precedent consumer. This creates a live-binding
// import cycle with instance-reaper.ts (which imports readInstanceRegistry/
// isInstanceRegistryEnabled from here); safe under Node ESM because every
// use on both sides happens inside function bodies, never at module-
// evaluation time, so both modules are fully initialized before either
// import is actually invoked.
import {
	BACKSTOP_SCAN_TIMEOUT_MS,
	realIsPidAlive,
	STALE_HEARTBEAT_MS,
	terminateScannerChild,
} from "./instance-reaper.js";
import { normalizeFilePath } from "./path-utils.js";
import {
	isInPidNamespace,
	ownPidNamespace,
	ownProcessStart,
	ownProcessStartIfKnown,
	type ProcessTableOptions,
	readProcessStart,
} from "./process-snapshot.js";
import { queueRegistryMutation } from "./instance-registry-tail.js";
import { getProcessSingleton } from "./process-singletons.js";
import { getSubagentIdentity, isSubagentSession } from "./subagent-mode.js";

export interface LspChildEntry {
	pid: number;
	serverId: string;
	command: string;
	/** Per-spawn-unique marker (e.g. a temp sgconfig path) for command-line
	 *  re-identification when the pid itself is gone/recycled. */
	marker?: string;
	spawnedAt: string;
	/** Resident set size in bytes, sampled at heartbeat cadence via
	 *  clients/resource-sampler.ts (#620). Best-effort — `undefined` when the
	 *  pid couldn't be sampled (already exited, or sampling itself failed). */
	rssBytes?: number;
	/** CPU percent (0-100+, matching `pidusage`'s convention — can exceed 100
	 *  on a multi-core box under sustained load) sampled at the same cadence.
	 *  Same best-effort/undefined semantics as `rssBytes`. */
	cpuPercent?: number;
	/**
	 * The child's OS start time, read when it was recorded (#3538). The
	 * reaper kills this pid only while it still has this start: a pid alone
	 * names whatever process holds it now. Absent on records written by
	 * pi-lens before #3538 or when the read failed; such a child is never
	 * killed by pid.
	 */
	processStart?: string;
}

/**
 * One process incarnation: a pid and the OS start time it had (#3538). Two
 * entries with the same pid and different starts belong to two processes.
 */
export interface InstanceIdentity {
	pid: number;
	processStart?: string | undefined;
	pidNamespace?: string | undefined;
}

export interface InstanceEntry {
	pid: number;
	/**
	 * The host's OS start time (#3538). A live pid with a different start is
	 * another process on a reused pid, and this entry's instance is dead.
	 * Absent on entries written before #3538; they are judged by pid alone.
	 * Added beside `startedAt`, which is the session's start as pi-lens
	 * records it and which older versions still read.
	 */
	processStart?: string;
	/**
	 * The host's pid namespace on Linux (`/proc/<pid>/ns/pid`, #3539 review
	 * F1). `pid` and `processStart` mean something only inside it; a reaper
	 * in another namespace leaves the entry alone. Absent elsewhere and on
	 * entries written before it.
	 */
	pidNamespace?: string | undefined;
	startedAt: string;
	/**
	 * The host's FIRST registered root — its primary. Pinned at first
	 * registration and never overwritten since #2130; before that fix every
	 * `registerInstance` clobbered it, so a host serving a subagent temp
	 * worktree advertised the TEMP DIR as its project root and the
	 * shared-checkout guard (#2107) and warm attach (#2007) both read a root
	 * the host was not actually working in.
	 *
	 * Kept as a scalar for wire compatibility: every pre-#2130 entry on disk
	 * has it, and it is what a human reading `instances.json` looks at first.
	 * `projectRoots` is the authoritative set — read it through
	 * {@link getInstanceRoots}, never this field alone.
	 */
	projectRoot: string;
	/**
	 * Provenance when a child had to synthesize the host identity.
	 *
	 * Set only by `recordLspChild` when it has to synthesize the host entry
	 * before `registerInstance` has run. `registerInstanceNow` rebuilds the
	 * entry from scratch and has never carried this field over, for any value,
	 * so the field's presence has always meant "no real registration has landed
	 * for this pid yet". That is what makes it a usable signal.
	 *
	 * `"lsp-fallback"` is the one value that means the root is a GUESS
	 * (`process.cwd()`) rather than evidence. #2130 round 2 reads it: the first
	 * real registration takes the primary slot from a guessed root instead of
	 * appending behind it. Roots appended to the entry in the meantime are
	 * kept — only index 0 is the guess.
	 */
	rootSource?: "session-cwd" | "service-cwd" | "lsp-fallback";
	/**
	 * Every root this host serves, insertion-ordered, `projectRoot` first
	 * (#2130). Registration is ADDITIVE: a second root joins the set instead of
	 * replacing the first. Absent on pre-#2130 entries, which
	 * {@link getInstanceRoots} folds back to `[projectRoot]`.
	 */
	projectRoots?: string[];
	/**
	 * Who holds each root (#3849), one record per holder: each record lists
	 * exactly the roots THAT holder registered. `host` is this process's own
	 * `registerInstance` and always lists `projectRoot`; every declined
	 * secondary activation is a holder of its own. Only the holder's own
	 * shutdown, or pruning (whole-entry removal, root or holder cap
	 * eviction), removes a record, and a root stays in `projectRoots` while
	 * any record lists it. Absent on pre-#3849 entries, which
	 * {@link readRootHolders} reads as `host` holding every root.
	 */
	projectRootHolders?: Record<string, string[]>;
	lspChildren: LspChildEntry[];
	lspChildCount: number;
	rssBytes: number;
	/** Host process CPU percent, sampled at the same heartbeat cadence as
	 *  `rssBytes` (#620). `undefined` when sampling failed/unavailable (e.g.
	 *  the `pidusage` dependency errored) — a missing value must never be
	 *  read as "0% CPU". */
	cpuPercent?: number;
	heartbeatAt: string;
	/** Best-effort identity for concurrency-profile analysis (#822). Absent
	 *  entirely for primary sessions and tolerated as absent on old entries. */
	subagent?: {
		marker?: string;
		agentType?: string;
		parentPid?: number;
		runId?: string;
	};
}

interface RegistryFile {
	instances: InstanceEntry[];
}

function registryPath(): string {
	return path.join(getGlobalPiLensDir(), "instances.json");
}

/**
 * Bounds a start-time read the same way the reaper bounds its own. A
 * function, not a module constant: the reaper import is a cycle, usable only
 * inside function bodies (see the import's comment).
 */
function startReadOptions(): ProcessTableOptions {
	return {
		timeoutMs: BACKSTOP_SCAN_TIMEOUT_MS,
		onTimeout: (child) =>
			terminateScannerChild(child, {
				kind: "orphan-backstop-scanner-escalated",
				timeoutMs: BACKSTOP_SCAN_TIMEOUT_MS,
			}),
	};
}

/**
 * Whether `entry` is this process's own entry (#3538). The pid must match,
 * and so must the start time the entry recorded. An entry left on this pid
 * by an instance that crashed is not this process's: taking it over adopted
 * that instance's LSP children, and a later removal by pid dropped them
 * without a kill (#3539). An entry with no start (written before #3538, or
 * while this process's own start was unknown) is judged by the pid, as
 * every entry was before. This process writes its start only once it is
 * known, and then keeps it, so while `selfStart` is unknown an entry that
 * carries a start is some other process's.
 */
function isOwnEntry(entry: InstanceEntry, selfStart: string | undefined) {
	return (
		entry.pid === process.pid &&
		(entry.processStart === undefined || entry.processStart === selfStart)
	);
}

// --- Kill switch (lazy, memoized — house style per clients/runtime-config.ts) ---

// #2146 class-sweep verdict: STAYS at module scope. Duplicating this memo
// across module evaluations is wasteful, not wrong — every copy re-reads the
// same `process.env` and reaches the same answer, so no caller can observe a
// disagreement. Only state that is WRONG when duplicated moves to
// `process-singletons.ts`.
let _enabledCache: boolean | undefined;

/**
 * `PI_LENS_INSTANCE_REGISTRY=0` disables the registry entirely: every
 * exported function in this module becomes a no-op (including the reaper
 * sweep in clients/instance-reaper.ts, which checks this too).
 */
export function isInstanceRegistryEnabled(): boolean {
	if (_enabledCache !== undefined) return _enabledCache;
	_enabledCache = process.env.PI_LENS_INSTANCE_REGISTRY !== "0";
	return _enabledCache;
}

/** Test-only: clear the memoized kill-switch read. */
export function _resetInstanceRegistryEnabledForTests(): void {
	_enabledCache = undefined;
}

// --- Read ---

/**
 * Distinguishes "no registry yet" (ENOENT — a genuinely clean start, never
 * recorded) from "a registry file exists but couldn't be trusted" (corrupt
 * JSON, wrong shape, or another read error — e.g. a torn write left behind by
 * a killed process, #1609 layer b). Both degrade to `{ instances: [] }`
 * either way (this store is purely observational, per the module docstring),
 * but only the latter is worth recording — a clean empty start must never
 * read the same as a corrupt one, or a genuine torn-file regression would be
 * invisible.
 *
 * `readRegistrySync`/`readRegistryAsync` are called from many sites across a
 * session (register/heartbeat/reap/footprint — not only session_start), so
 * this goes through `recordDegradationOnce` (#1609 review, the small fix)
 * rather than a plain log call: the ledger's own per-kind/subject dedup caps
 * it at one record for the session regardless of how many times the same
 * torn file gets re-read, instead of re-logging on every call.
 */
function recordCorruptRegistryRead(reasonCode: string): void {
	recordDegradationOnce({
		kind: "instance-registry-corrupt",
		subject: "instances.json",
		reason: `read failed (${reasonCode}); treating as empty`,
	});
}

function readRegistrySync(): RegistryFile {
	try {
		const raw = fs.readFileSync(registryPath(), "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && Array.isArray(parsed.instances)) {
			return parsed as RegistryFile;
		}
		recordCorruptRegistryRead("invalid shape");
		return { instances: [] };
	} catch (err) {
		// Missing file, corrupt JSON, or a read error — treat as empty, never
		// throw. Missing (ENOENT) is a clean start and stays silent; anything
		// else is recorded so a corrupt/torn file is distinguishable from one.
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code !== "ENOENT") recordCorruptRegistryRead(code ?? "invalid");
		return { instances: [] };
	}
}

async function readRegistryAsync(): Promise<RegistryFile> {
	try {
		const raw = await fs.promises.readFile(registryPath(), "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && Array.isArray(parsed.instances)) {
			return parsed as RegistryFile;
		}
		recordCorruptRegistryRead("invalid shape");
		return { instances: [] };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code !== "ENOENT") recordCorruptRegistryRead(code ?? "invalid");
		return { instances: [] };
	}
}

/** Read-only snapshot of the whole registry (used by the reaper). */
export async function readInstanceRegistry(): Promise<InstanceEntry[]> {
	const file = await readRegistryAsync();
	return file.instances;
}

// --- Write (atomic tmp + rename via clients/atomic-write.ts, #762) ---

async function writeRegistryAsync(file: RegistryFile): Promise<void> {
	const dir = getGlobalPiLensDir();
	const target = registryPath();
	try {
		await fs.promises.mkdir(dir, { recursive: true });
	} catch {
		// Best-effort observability substrate — a failed mkdir just means this
		// update is lost, never a thrown error for the caller.
		return;
	}
	// bestEffort (default): a failed write just means this update is lost,
	// never a thrown error for the caller.
	await writeFileAtomicAsync(target, JSON.stringify(file));
}

const REGISTRY_WRITE_RETRIES = 3;

/** `mutate` returns undefined to write nothing (#3498). */
async function writeRegistryWithRetry(
	mutate: (file: RegistryFile) => RegistryFile | undefined,
	isCommitted: (file: RegistryFile) => boolean,
): Promise<void> {
	await withInstanceRegistryLock(registryPath(), async () => {
		for (let attempt = 0; attempt < REGISTRY_WRITE_RETRIES; attempt++) {
			const next = mutate(await readRegistryAsync());
			if (next === undefined) return;
			await writeRegistryAsync(next);
			if (isCommitted(await readRegistryAsync())) return;
		}
	});
}

function writeRegistrySync(file: RegistryFile): void {
	const dir = getGlobalPiLensDir();
	const target = registryPath();
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		return;
	}
	writeFileAtomic(target, JSON.stringify(file));
}

// --- Mutations (all read-modify-write whole file) ---

/**
 * Every root an entry serves, oldest first (#2130).
 *
 * The single reader for root identity in this module — no caller may compare
 * `entry.projectRoot` directly, or a host's secondary roots become invisible
 * again. Folds a pre-#2130 entry (no `projectRoots`) back to its scalar root,
 * and drops non-string / empty members so a hand-edited or torn file cannot
 * make a comparison throw.
 */
export function getInstanceRoots(entry: InstanceEntry): string[] {
	const listed = Array.isArray(entry.projectRoots)
		? entry.projectRoots.filter(
				(root): root is string => typeof root === "string" && root.length > 0,
			)
		: [];
	if (listed.length > 0) return listed;
	return typeof entry.projectRoot === "string" && entry.projectRoot.length > 0
		? [entry.projectRoot]
		: [];
}

/**
 * Bound on the per-host root set (#2130). A host that legitimately serves many
 * worktrees must not grow an unbounded path list inside a file every other
 * pi-lens process reads on every heartbeat. Eviction drops the OLDEST
 * NON-PRIMARY root: `projectRoot` is the host's own working directory and the
 * one the shared-checkout guard most needs, so it is never evicted.
 * Deliberately smaller than `SESSION_ROOT_CAP` (128, `clients/lsp/
 * session-roots.ts`) because that registry lives in memory for one process
 * while this one is serialized to disk for all of them. The two are not
 * mirrors: they answer different questions about different populations, so
 * #2518's one-store rule (a root's LSP config cannot be evicted while the
 * root is served) does not extend to this cap.
 */
const INSTANCE_ROOT_CAP = 32;

/**
 * The SINGLE owner of root-set semantics: dedupe, append order, and
 * primary-preserving cap eviction (#2130).
 *
 * Both writers — `registerInstance` (the full session-start registration) and
 * `registerInstanceRoot` (the lightweight add a declined secondary-root start
 * performs) — fold through this, so the two can never disagree about what the
 * set means. Pure, so the rule is testable without touching the filesystem.
 */
export function mergeInstanceRoots(
	priorRoots: readonly string[],
	normalizedRoot: string,
): string[] {
	const roots = priorRoots.includes(normalizedRoot)
		? [...priorRoots]
		: [...priorRoots, normalizedRoot];
	// Evict from index 1 upward so the primary at index 0 survives.
	while (roots.length > INSTANCE_ROOT_CAP) roots.splice(1, 1);
	return roots;
}

/** The holder record of this process's own `registerInstance` calls (#3849). */
const HOST_ROOT_HOLDER = "host";

/**
 * Bound on the secondary holder records in one entry (#3849). A holder that
 * never reaches its shutdown keeps its record until the entry goes, so the
 * count needs its own bound beside the root cap: twice the root cap, oldest
 * record evicted first. The host record is never evicted.
 */
const ROOT_HOLDER_CAP = 2 * INSTANCE_ROOT_CAP;

/**
 * The holder records of `entry` (#3849). A pre-#3849 entry has none, and
 * reads as the host holding every root: no secondary's shutdown can then
 * free a root whose holders were never recorded.
 */
function readRootHolders(entry: InstanceEntry): Record<string, string[]> {
	const raw: unknown = entry.projectRootHolders;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { [HOST_ROOT_HOLDER]: getInstanceRoots(entry) };
	}
	const holders: Record<string, string[]> = {};
	for (const [holder, listed] of Object.entries(raw)) {
		if (!Array.isArray(listed)) continue;
		holders[holder] = listed.filter(
			(root): root is string => typeof root === "string" && root.length > 0,
		);
	}
	return holders;
}

/**
 * The SINGLE settle of the ownership rule (#3849), run by every writer of
 * an entry's roots in the same locked write. Records keep only roots in
 * `roots` (so a root the cap evicted leaves every record with it), the
 * host record keeps the primary, the oldest secondary records beyond
 * `ROOT_HOLDER_CAP` go, and a root stays only while some record lists it.
 */
function settleRootHolders(
	roots: readonly string[],
	holders: Readonly<Record<string, readonly string[]>>,
): { roots: string[]; holders: Record<string, string[]> } {
	const primary = roots[0];
	const settled: Record<string, string[]> = {};
	for (const [holder, listed] of Object.entries(holders)) {
		const kept = roots.filter((root) => listed.includes(root));
		if (kept.length > 0) settled[holder] = kept;
	}
	if (primary !== undefined) {
		settled[HOST_ROOT_HOLDER] = roots.filter(
			(root) =>
				root === primary || holders[HOST_ROOT_HOLDER]?.includes(root) === true,
		);
	}
	const secondaries = Object.keys(settled).filter(
		(holder) => holder !== HOST_ROOT_HOLDER,
	);
	for (const holder of secondaries.slice(
		0,
		Math.max(0, secondaries.length - ROOT_HOLDER_CAP),
	)) {
		delete settled[holder];
	}
	const listed = new Set(Object.values(settled).flat());
	return { roots: roots.filter((root) => listed.has(root)), holders: settled };
}

/**
 * Register `projectRoot` for this process, ADDITIVELY (#2130).
 *
 * Creates the entry on first call and pins `projectRoot` as the primary. Every
 * later call for a different root APPENDS to `projectRoots` instead of
 * overwriting — that overwrite is the defect #2130 records, where a subagent
 * temp worktree's session start made the host advertise a temp dir as its root.
 * Re-registering a root already in the set is a no-op for the set (the
 * heartbeat/rss fields still refresh).
 */
export function registerInstance(projectRoot: string): Promise<void> {
	const generation = registrationGeneration().capture();
	return queueRegistryMutation(() =>
		registerInstanceNow(projectRoot, generation),
	);
}

async function registerInstanceNow(
	projectRoot: string,
	generation: GenerationHandle,
): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const normalizedRoot = normalizeFilePath(projectRoot);
	// #3498: a registration made before `deregisterInstance` starts only after
	// it (still queued) and must not become the heartbeat's repair root.
	if (!registrationIsCurrent(generation, normalizedRoot)) return;
	rememberRegistrationRoot(projectRoot);
	const pid = process.pid;
	const now = new Date().toISOString();
	const identity = isSubagentSession() ? getSubagentIdentity() : undefined;
	const selfStart = await ownProcessStart(startReadOptions());
	const subagent = identity
		? {
				marker: identity.marker,
				agentType: identity.agentName,
				parentPid: identity.parentPid,
				runId: identity.runId,
			}
		: undefined;
	await writeRegistryWithRetry(
		(file) => {
			// #3498: the session may have ended while this waited for the lock.
			if (!registrationIsCurrent(generation, normalizedRoot)) return undefined;
			const others = file.instances.filter(
				(entry) => !isOwnEntry(entry, selfStart),
			);
			const existing = file.instances.find((entry) =>
				isOwnEntry(entry, selfStart),
			);
			// #2130 round 2, class sweep. A `recordLspChild` that arrives before
			// this call synthesizes the entry from `process.cwd()` and stamps
			// `rootSource: "lsp-fallback"` to say so. Pinning made that GUESS
			// permanent: the real session root joined the set behind it, and the
			// host went on advertising a directory nobody asked it to serve —
			// #2130's symptom reached through a different writer. So the first
			// REAL registration takes the pin from a guessed primary. Any other
			// `rootSource` ("session-cwd", "service-cwd") IS evidence of the root
			// and keeps its pin, with this root appending behind it as usual.
			//
			// Review round 1, F1: ONLY index 0 is the guess. Everything behind it
			// was appended by `registerInstanceRoot`, which is a declined
			// secondary-root start recording a root it genuinely serves and which
			// does not clear `rootSource`. Discarding the whole set would drop
			// those, blinding the shared-checkout guard (#2107) to a live root —
			// the same harm, inverted. Re-seed with the real root so it pins, then
			// fold the rest back through `mergeInstanceRoots` so dedupe, order,
			// and the cap stay single-owned.
			const existingRoots = existing ? getInstanceRoots(existing) : [];
			const roots =
				existing?.rootSource === "lsp-fallback"
					? existingRoots
							.slice(1)
							.reduce(
								(acc, root) => mergeInstanceRoots(acc, root),
								[normalizedRoot],
							)
					: mergeInstanceRoots(existingRoots, normalizedRoot);
			// #3849: the host holds what it registers; the settle prunes every
			// record to the capped set in this same write.
			const holders = existing ? readRootHolders(existing) : {};
			const settled = settleRootHolders(roots, {
				...holders,
				[HOST_ROOT_HOLDER]: [
					...(holders[HOST_ROOT_HOLDER] ?? []),
					normalizedRoot,
				],
			});
			const namespace = ownPidNamespace();
			others.push({
				pid,
				...(selfStart === undefined ? {} : { processStart: selfStart }),
				...(namespace === undefined ? {} : { pidNamespace: namespace }),
				startedAt: existing?.startedAt ?? now,
				projectRoot: settled.roots[0] ?? normalizedRoot,
				projectRoots: settled.roots,
				projectRootHolders: settled.holders,
				lspChildren: existing?.lspChildren ?? [],
				lspChildCount: existing?.lspChildren?.length ?? 0,
				rssBytes: process.memoryUsage().rss,
				heartbeatAt: now,
				...(subagent ? { subagent } : {}),
			});
			return { instances: others };
		},
		(file) => file.instances.some((entry) => isOwnEntry(entry, selfStart)),
	);
}

/**
 * Add ONE root to this process's existing entry (#2130), without any of
 * `registerInstance`'s other side effects — no RSS resample, no `startedAt`
 * reseed, no subagent-identity capture.
 *
 * This is what a DECLINED session start performs. `registerInstance` lives in
 * the full-start body, below the #473/#2129 secondary gate, so a
 * `secondary-root` start never reaches it. Without this call the temp root
 * would be absent from `instances.json` entirely: the shared-checkout guard
 * and warm attach would have LESS information about it than before #2130, and
 * `deregisterInstanceRoot` would have nothing to remove.
 *
 * NEVER creates an entry. A declined start has no host entry to append to only
 * when this process never registered one (the registry was reaped, or the
 * primary's start has not landed yet). Synthesizing one here would write the
 * TEMP root as `projectRoot` — reproducing the exact clobber #2130 is about —
 * so this returns quietly instead. The next `registerInstance` re-creates the
 * entry with the real root pinned.
 *
 * `holder` is the declined activation's own id (#3849): the root joins that
 * holder's record, and only `deregisterInstanceRoot` with the same id, or
 * pruning, ends that hold. A root another record also lists outlives this
 * holder's record, and the primary is the host's alone: adding it records
 * nothing.
 *
 * Shares the serialization tail with every other same-process registry
 * mutation, so it cannot interleave its read-modify-write with a concurrent
 * `registerInstance` and silently revert it (#1724).
 */
export function registerInstanceRoot(
	projectRoot: string,
	holder: string,
): Promise<void> {
	return queueRegistryMutation(() =>
		registerInstanceRootNow(projectRoot, holder),
	);
}

async function registerInstanceRootNow(
	projectRoot: string,
	holder: string,
): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const normalizedRoot = normalizeFilePath(projectRoot);
	const selfStart = await ownProcessStart(startReadOptions());
	await withInstanceRegistryLock(registryPath(), async () => {
		const file = await readRegistryAsync();
		const idx = file.instances.findIndex((entry) =>
			isOwnEntry(entry, selfStart),
		);
		const current = file.instances[idx];
		if (current === undefined) return;
		const priorRoots = getInstanceRoots(current);
		// The host's record already holds its primary: nothing to add.
		if (priorRoots[0] === normalizedRoot) return;
		const holders = readRootHolders(current);
		const settled = settleRootHolders(
			mergeInstanceRoots(priorRoots, normalizedRoot),
			{
				...holders,
				[holder]: [...(holders[holder] ?? []), normalizedRoot],
			},
		);
		if (
			settled.roots.length === priorRoots.length &&
			settled.roots.every((root, index) => root === priorRoots[index]) &&
			JSON.stringify(settled.holders) ===
				JSON.stringify(current.projectRootHolders)
		)
			return;
		file.instances[idx] = {
			...current,
			projectRoot: settled.roots[0] ?? current.projectRoot,
			projectRoots: settled.roots,
			projectRootHolders: settled.holders,
		};
		await writeRegistryAsync(file);
	});
}

export interface HeartbeatPatch {
	rssBytes?: number;
	/** Host CPU percent for this heartbeat (#620). Omit to leave the
	 *  previously-recorded value untouched (sampling is best-effort and may
	 *  legitimately fail on a given tick — an omission must not be read as
	 *  "0% CPU", so this only overwrites when a fresh sample is supplied). */
	cpuPercent?: number;
	/** Per-lspChild resource samples (#620), keyed by pid, applied on top of
	 *  the process's current `lspChildren` array. A pid not present in this
	 *  map keeps its previous rss/cpu values untouched (the child may simply
	 *  not have been sampled this tick, e.g. sampling failed for that pid
	 *  alone) — never zeroed out. Pids the entry no longer knows about are
	 *  ignored (the child was already removed via `removeLspChild`).
	 */
	childUsage?: Record<number, { rssBytes?: number; cpuPercent?: number }>;
}

/** Update this process's heartbeat/rss (and, since #620, host CPU% + live
 *  LSP children's rss/CPU%). Cheap — safe to call every turn end.
 *
 * #3602: runs on the SAME tail as `registerInstance`/`registerInstanceRoot`/
 * `deregisterInstance` (`queueRegistryMutation`) rather than taking the
 * registry lock directly. Before this, a heartbeat queued behind a
 * still-in-flight `registerInstance` (session_start's `void
 * registerInstance(...)`, not awaited) could win the race to the lock: it
 * would read the registry before that registration's write landed, find no
 * own entry, and — because `registerInstanceNow` had already set the
 * repair-intent root via `rememberRegistrationRoot` BEFORE its write — record
 * a spurious `instance-registry-registration-missing` on an ordinary first
 * turn and queue a redundant re-register. Sharing the tail makes the two
 * mutations' submission order (session_start's registration, then
 * turn_end's/agent_settled's heartbeat) their EXECUTION order too, so a
 * heartbeat can never observe that half-registered state again. */
export async function updateHeartbeat(
	patch: HeartbeatPatch = {},
): Promise<void> {
	return queueRegistryMutation(() => updateHeartbeatNow(patch));
}

async function updateHeartbeatNow(patch: HeartbeatPatch): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const pid = process.pid;
	const selfStart = await ownProcessStart(startReadOptions());
	let missing = false;
	await withInstanceRegistryLock(registryPath(), async () => {
		const file = await readRegistryAsync();
		const idx = file.instances.findIndex((entry) =>
			isOwnEntry(entry, selfStart),
		);
		if (idx === -1) {
			// No entry for this pid: registerInstance has not run here yet, or
			// its write was dropped (lock timeout, #3447) or reaped. Never
			// fabricate a projectRoot; re-register below only from the root
			// registerInstance was actually given.
			missing = true;
			return;
		}
		const now = new Date().toISOString();
		const current = file.instances[idx];
		const lspChildren = patch.childUsage
			? current.lspChildren.map((child) => {
					const usage = patch.childUsage?.[child.pid];
					if (!usage) return child;
					return {
						...child,
						rssBytes: usage.rssBytes ?? child.rssBytes,
						cpuPercent: usage.cpuPercent ?? child.cpuPercent,
					};
				})
			: current.lspChildren;
		file.instances[idx] = {
			...current,
			rssBytes: patch.rssBytes ?? process.memoryUsage().rss,
			cpuPercent: patch.cpuPercent ?? current.cpuPercent,
			lspChildren,
			lspChildCount: lspChildren.length,
			heartbeatAt: now,
		};
		await writeRegistryAsync(file);
	});
	const intent = registrationIntent();
	if (
		missing &&
		intent.root !== undefined &&
		intent.target === registryPath()
	) {
		incrementDegradationCount({
			kind: "instance-registry-registration-missing",
			subject: String(pid),
			reason:
				"entry missing at heartbeat; re-registering from the session root",
		});
		// Queued, not awaited: the heartbeat runs on the turn-end hook path,
		// where every await counts against the hook (#2523). session_start's
		// own `void registerInstance(...)` is the same shape.
		void registerInstance(intent.root);
	}
}

export interface RecordLspChildInput {
	pid: number;
	serverId: string;
	command: string;
	marker?: string;
	/** Session identity used if this child arrives before host registration. */
	sessionIdentity?: {
		projectRoot: string;
		startedAt: string;
		rootSource?: "session-cwd" | "service-cwd" | "lsp-fallback";
	};
}

/**
 * #3447: the root `registerInstance` was last asked to register, and the
 * registry file it was meant for. A registration can be dropped for good --
 * the lock's bounded wait ran out (`instance-registry-lock-timeout`) or the
 * file was reaped -- and `updateHeartbeat` re-registers from this rather
 * than leaving the session invisible to the shared-checkout guard and warm
 * attach for the rest of its life. It is the real session root, not a guess,
 * which is why the heartbeat may use it where it refuses to fabricate one.
 *
 * Process-wide for the same reason as the tail above: the heartbeat and the
 * registration can run in different evaluations of this module. Cleared by
 * `deregisterInstance` and by deregistering the last root, so a late
 * heartbeat never resurrects an instance that left.
 */
const REGISTRATION_INTENT_FAMILY = "instance-registry.registration-intent";
/** Bump when the intent cell's shape changes. */
const REGISTRATION_INTENT_VERSION = 1;

function registrationIntent(): {
	root: string | undefined;
	target: string | undefined;
} {
	return getProcessSingleton(
		REGISTRATION_INTENT_FAMILY,
		REGISTRATION_INTENT_VERSION,
		() => ({ root: undefined, target: undefined }),
	);
}

/**
 * #3498: advanced by `deregisterInstance`. `registerInstance` captures it when
 * it is called, and a registration whose generation moved drops itself twice:
 * before it sets the intent, and under the lock before it writes. A
 * registration still queued, or still waiting on the lock, when the session
 * ended would otherwise land after the removal and re-create the ended root,
 * or point the heartbeat's repair at it. Process-wide for the same reason as
 * the tail: the registration and the removal can run in different
 * evaluations of this module. The heartbeat's repair calls `registerInstance`,
 * so it captures the generation current after the heartbeat's own lock.
 */
const REGISTRATION_GENERATION_FAMILY =
	"instance-registry.registration-generation";
/** Bump when the generation cell's shape changes. */
const REGISTRATION_GENERATION_VERSION = 1;

function registrationGeneration(): GenerationSource {
	return getProcessSingleton(
		REGISTRATION_GENERATION_FAMILY,
		REGISTRATION_GENERATION_VERSION,
		() => createGenerationSource("instance-registry-registration"),
	);
}

/**
 * Whether a registration may still land, recording the drop when it may not.
 * The record comes from this module's own ledger, not the generation source's:
 * the source is a process singleton and may belong to another evaluation.
 */
function registrationIsCurrent(
	generation: GenerationHandle,
	normalizedRoot: string,
): boolean {
	if (generation.isCurrent()) return true;
	incrementDegradationCount({
		kind: "instance-registry-registration-superseded",
		subject: normalizedRoot,
		reason: "the session ended before this registration landed; dropped",
	});
	return false;
}

function rememberRegistrationRoot(root: string | undefined): void {
	const intent = registrationIntent();
	intent.root = root;
	intent.target = root === undefined ? undefined : registryPath();
}

// The tail lives in a dependency leaf so the shared test setup can join it
// without loading this module's import graph (#3703).
export { _settleRegistryMutationsForTests } from "./instance-registry-tail.js";

/** Append/replace (by pid) an LSP child under this process's entry. */
export function recordLspChild(entry: RecordLspChildInput): Promise<void> {
	const generation = registrationGeneration().capture();
	return queueRegistryMutation(() => recordLspChildNow(entry, generation));
}

async function recordLspChildNow(
	entry: RecordLspChildInput,
	generation: GenerationHandle,
): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const pid = process.pid;
	const now = new Date().toISOString();
	const [selfStart, childStart] = await Promise.all([
		ownProcessStart(startReadOptions()),
		readProcessStart(entry.pid, startReadOptions()),
	]);
	const childEntry: LspChildEntry = {
		pid: entry.pid,
		serverId: entry.serverId,
		command: entry.command,
		marker: entry.marker,
		spawnedAt: now,
		...(childStart === undefined ? {} : { processStart: childStart }),
	};
	const hostIdentity = getSubagentIdentity();
	await writeRegistryWithRetry(
		(file) => {
			const idx = file.instances.findIndex((inst) =>
				isOwnEntry(inst, selfStart),
			);
			if (idx === -1) {
				// #3498: a child recorded before the session ended must not
				// re-create the ended session's entry. Its own shutdown path kills
				// it, and the OS-table backstop still sees it.
				const guessedRoot = normalizeFilePath(
					entry.sessionIdentity?.projectRoot ?? process.cwd(),
				);
				if (!registrationIsCurrent(generation, guessedRoot)) return undefined;
				// registerInstance hasn't run yet in this process (or was reaped) —
				// synthesize a minimal entry so the child is still tracked.
				recordDegradationOnce({
					kind: "instance-registry-registration-missing",
					subject: String(pid),
					reason: "synthesizing host entry while recording an LSP child",
				});
				const identity = entry.sessionIdentity;
				if (!identity?.projectRoot) {
					recordDegradationOnce({
						kind: "instance-registry-identity-fallback",
						subject: String(pid),
						reason: "session cwd unavailable; using process cwd",
					});
				}
				const projectRoot = normalizeFilePath(
					identity?.projectRoot ?? process.cwd(),
				);
				const namespace = ownPidNamespace();
				file.instances.push({
					pid,
					...(selfStart === undefined ? {} : { processStart: selfStart }),
					...(namespace === undefined ? {} : { pidNamespace: namespace }),
					startedAt: identity?.startedAt ?? now,
					projectRoot,
					rootSource: identity?.rootSource ?? "lsp-fallback",
					projectRoots: [projectRoot],
					lspChildren: [childEntry],
					lspChildCount: 1,
					rssBytes: process.memoryUsage().rss,
					heartbeatAt: now,
					...(hostIdentity
						? {
								subagent: {
									marker: hostIdentity.marker,
									agentType: hostIdentity.agentName,
									parentPid: hostIdentity.parentPid,
									runId: hostIdentity.runId,
								},
							}
						: {}),
				});
			} else {
				const current = file.instances[idx];
				const filtered = current.lspChildren.filter(
					(child) => child.pid !== entry.pid,
				);
				filtered.push(childEntry);
				file.instances[idx] = {
					...current,
					lspChildren: filtered,
					lspChildCount: filtered.length,
				};
			}
			return file;
		},
		(file) =>
			file.instances.some(
				(instance) =>
					isOwnEntry(instance, selfStart) &&
					instance.lspChildren.some((child) => child.pid === entry.pid),
			),
	);
}

/**
 * Remove an LSP child (by pid) from this process's entry. `expectedMarker`,
 * when supplied, guards against the pid-recycling window between this
 * child's death and this call landing: if the recorded entry for `pid` now
 * carries a DIFFERENT marker than the one this caller spawned, some other
 * child has already claimed that pid (recycled) and must not be removed on
 * this caller's behalf — same asymmetric-safety contract as the reaper's
 * `buildIdentityMatcher` (never remove on an unverifiable/mismatched
 * identity). Omit `expectedMarker` for a server this process never derived a
 * marker for (pid-only match, unchanged pre-#1724 behavior) — safe because
 * this call fires synchronously off THIS process's own just-confirmed exit
 * of that exact pid, well inside the OS's pid-reuse latency.
 */
export function removeLspChild(
	pid: number,
	expectedMarker?: string,
): Promise<void> {
	return queueRegistryMutation(() => removeLspChildNow(pid, expectedMarker));
}

async function removeLspChildNow(
	pid: number,
	expectedMarker?: string,
): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const selfStart = await ownProcessStart(startReadOptions());
	await withInstanceRegistryLock(registryPath(), async () => {
		const file = await readRegistryAsync();
		const idx = file.instances.findIndex((inst) => isOwnEntry(inst, selfStart));
		if (idx === -1) return;
		const current = file.instances[idx];
		const filtered = current.lspChildren.filter((child) => {
			if (child.pid !== pid) return true; // keep — different pid
			if (expectedMarker && child.marker && child.marker !== expectedMarker) {
				return true; // keep — pid recycled onto a differently-marked child
			}
			return false; // drop — this is the child we're deregistering
		});
		if (filtered.length === current.lspChildren.length) return; // nothing removed
		file.instances[idx] = {
			...current,
			lspChildren: filtered,
			lspChildCount: filtered.length,
		};
		await writeRegistryAsync(file);
	});
}

/**
 * Remove this process's entry entirely. SYNC fs only — safe to call from
 * `session_shutdown` (#234: no child spawns permitted at teardown; this
 * function spawns nothing).
 */
export function deregisterInstance(): void {
	rememberRegistrationRoot(undefined);
	registrationGeneration().bump();
	if (!isInstanceRegistryEnabled()) return;
	const selfStart = ownProcessStartIfKnown();
	const removed = withInstanceRegistryLockSync(registryPath(), () => {
		const next = withoutOwnEntry(readRegistrySync(), selfStart);
		if (next) writeRegistrySync(next);
		return true;
	});
	if (removed) return;
	// #3498: the sync removal did not get the lock. A peer held it for the whole
	// sync wait, or this process's own heartbeat or registration holds it, which
	// the sync path does not wait on. The process may live on through a
	// session replacement, so queue the removal behind the holder instead of
	// dropping it and leaving the ended session's root in the registry.
	incrementDegradationCount({
		kind: "instance-registry-deregister-queued",
		subject: String(process.pid),
		reason:
			"the sync removal could not take the registry lock; queued behind the holder",
	});
	void queueRegistryMutation(deregisterInstanceAfterHolder);
}

/**
 * The removal `deregisterInstance` could not make in its sync wait (#3498).
 * It waits through the lock lease, so a holder that outlives the sync wait
 * and an ordinary async wait still cannot make it drop.
 */
async function deregisterInstanceAfterHolder(): Promise<void> {
	const selfStart = await ownProcessStart(startReadOptions());
	await withInstanceRegistryLock(
		registryPath(),
		async () => {
			const next = withoutOwnEntry(await readRegistryAsync(), selfStart);
			if (next) await writeRegistryAsync(next);
			incrementDegradationCount({
				kind: "instance-registry-deregister-landed",
				subject: String(process.pid),
				reason: next
					? "the queued removal took the lock and removed this process's entry"
					: "the queued removal took the lock; the entry was already gone",
			});
		},
		LOCK_WAIT_THROUGH_LEASE_MS,
	);
}

/**
 * The file without this process's entry, or undefined when it holds none.
 * Both removals, the sync one and the queued one, key it through
 * `isOwnEntry` (#3498).
 */
function withoutOwnEntry(
	file: RegistryFile,
	selfStart: string | undefined,
): RegistryFile | undefined {
	const remaining = file.instances.filter(
		(entry) => !isOwnEntry(entry, selfStart),
	);
	return remaining.length === file.instances.length
		? undefined
		: { instances: remaining };
}

/**
 * Drop ONE root from this process's entry (#2130) — the scoped counterpart to
 * {@link deregisterInstance}, for a worktree this host stops serving while the
 * host itself keeps running.
 *
 * The operation runs on the registry tail and uses async filesystem calls.
 * It ends `holder`'s own hold on the root and nothing else (#3849): the
 * root leaves the entry only when no other record (the host's included)
 * lists it. A holder whose hold already ended (a whole-entry removal at a
 * primary reload, a cap eviction, or an add that found no entry) writes
 * nothing, so it can never free the root a later holder registered. The
 * host's record always lists the primary, so this never removes it.
 *
 * QUEUED, unlike `deregisterInstance` (#2130 round 2). The two look alike but
 * run at opposite ends of a process's life. `deregisterInstance` runs as the
 * HOST exits, where a queued write may never get a turn, so it must bypass the
 * tail and write immediately. This one runs at a SECONDARY's shutdown, where
 * the process lives on and the ordering is what matters: a declined start fires
 * `void registerInstanceRoot(cwd)` onto the tail (index.ts:1851) and never
 * awaits it, so a short-lived subagent reaching shutdown first would remove a
 * root that had not been added yet. The removal found nothing, the queued add
 * landed behind it, and the temp root LEAKED until host exit or cap eviction.
 * Sharing the tail makes remove-after-add hold by construction.
 *
 * The returned promise resolves when the removal has landed. Callers in
 * teardown paths may fire and forget it — the tail still orders the write —
 * but they can no longer read the file straight afterwards and expect the
 * removal to be visible.
 *
 * The single lock below waits through the lease for a peer or own prior
 * holder, on this tail slot, before giving the next queued op its turn.
 */
export function deregisterInstanceRoot(
	projectRoot: string,
	holder: string,
): Promise<void> {
	const generation = registrationGeneration().capture();
	return queueRegistryMutation(async () =>
		deregisterInstanceRootNow(projectRoot, holder, generation),
	);
}

/**
 * The write this root removal must make (or none), plus the intent-cell side
 * effect, from a fresh read (#3587). The single lease-waiting lock path calls
 * this once under the lock, so a holder cannot force a second, stale decision.
 * Keys the entry through `isOwnEntry`, exactly as `deregisterInstance` does
 * (#3498).
 */
type RootRemovalPlan = {
	file: RegistryFile;
	outcome: "kept" | "freed";
};

/** The `instance-registry-deregister-landed` reason for each decision. */
const ROOT_REMOVAL_REASONS: Readonly<
	Record<RootRemovalPlan["outcome"] | "none", string>
> = {
	kept: "holder left; another holder keeps the root",
	freed: "last holder left; root freed",
	none: "the queued removal took the lock; there was nothing left to remove",
};

function planRootRemoval(
	file: RegistryFile,
	normalizedRoot: string,
	holder: string,
	selfStart: string | undefined,
	generation: GenerationHandle,
): RootRemovalPlan | undefined {
	const idx = file.instances.findIndex((entry) => isOwnEntry(entry, selfStart));
	const current = file.instances[idx];
	if (current === undefined) {
		// Entry already gone (e.g. a dropped registration): still stop a
		// heartbeat from re-registering the root this host just left.
		const intent = registrationIntent();
		if (
			intent.root !== undefined &&
			normalizeFilePath(intent.root) === normalizedRoot
		)
			rememberRegistrationRoot(undefined);
		return undefined;
	}
	const prior = settleRootHolders(
		getInstanceRoots(current),
		readRootHolders(current),
	);
	const held = prior.holders[holder];
	// #3849: no hold of this holder's own on the root, nothing to end.
	if (!held?.includes(normalizedRoot)) return undefined;
	const next = settleRootHolders(prior.roots, {
		...prior.holders,
		[holder]: held.filter((root) => root !== normalizedRoot),
	});
	// Keep a heartbeat re-registration on a root the host still serves,
	// unless the host session ended since this removal was queued (#3498):
	// its roots are no longer served, and the intent must stay clear.
	if (generation.isCurrent()) rememberRegistrationRoot(next.roots[0]);
	return {
		file: {
			instances: file.instances.map((entry, i) =>
				i === idx
					? {
							...current,
							projectRoot: next.roots[0] ?? current.projectRoot,
							projectRoots: next.roots,
							projectRootHolders: next.holders,
						}
					: entry,
			),
		},
		outcome: next.roots.includes(normalizedRoot) ? "kept" : "freed",
	};
}

async function deregisterInstanceRootNow(
	projectRoot: string,
	holder: string,
	generation: GenerationHandle,
): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const normalizedRoot = normalizeFilePath(projectRoot);
	const selfStart = await ownProcessStart(startReadOptions());
	await withInstanceRegistryLock(
		registryPath(),
		async () => {
			const next = planRootRemoval(
				await readRegistryAsync(),
				normalizedRoot,
				holder,
				selfStart,
				generation,
			);
			if (next) await writeRegistryAsync(next.file);
			incrementDegradationCount({
				kind: "instance-registry-deregister-landed",
				subject: String(process.pid),
				reason: ROOT_REMOVAL_REASONS[next?.outcome ?? "none"],
			});
		},
		LOCK_WAIT_THROUGH_LEASE_MS,
	);
}

/**
 * Every OTHER live pi-lens process registered against the same project root,
 * oldest first (#2007).
 *
 * "Live" is the registry's own three-part answer, not a guess: a different
 * pid, an OS-confirmed alive pid, and a parseable heartbeat inside
 * `STALE_HEARTBEAT_MS`. This is the single predicate for "am I sharing this
 * directory with someone" — `selectWarmAttachIncumbent` picks the oldest
 * entry it returns, and the shared-checkout guard asks whether it returns
 * anything at all. Both must move together if the liveness rule changes.
 *
 * Roots are compared after `normalizeFilePath`, the same form
 * `registerInstance` writes, so drive-letter case and separators cannot make
 * a peer invisible (catalog shape 1).
 *
 * `match` picks what "same directory" means, and the two callers genuinely
 * differ. Warm attach needs `"exact"`: it shares one LSP service, which is
 * bound to a specific project root. The shared-checkout guard needs
 * `"containment"`: a peer registered at the repo root and a command run from
 * `repo/clients` share one working tree, and an exact compare would report no
 * peer and allow the destructive command. Containment compares on segment
 * boundaries, so `/repo-backup` never matches `/repo`.
 *
 * Best-effort by construction: the caller supplies the entries, so a failed
 * registry read is the caller's empty list, which reads as "no known peer".
 */
export type PeerRootMatch = "exact" | "containment";

/**
 * True when `a` and `b` are the same directory, or one contains the other.
 * Compared on SEGMENT boundaries, so `/repo-backup` never matches `/repo`.
 */
function rootsOverlap(a: string, b: string): boolean {
	if (a === b) return true;
	const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
	return longer.startsWith(shorter.endsWith("/") ? shorter : `${shorter}/`);
}

export function selectLivePeerInstances(
	entries: readonly InstanceEntry[],
	root: string,
	now: number = Date.now(),
	isPidAlive: (pid: number) => boolean = realIsPidAlive,
	match: PeerRootMatch = "exact",
): InstanceEntry[] {
	const normalizedRoot = normalizeFilePath(root);
	return entries
		.filter(
			(entry) =>
				entry.pid !== process.pid &&
				// #2130: a host serves a SET of roots. Matching only
				// `entry.projectRoot` made every secondary root invisible, so a peer
				// working in the same checkout under its second root read as "no
				// peer" — and the shared-checkout guard then allowed the destructive
				// command it exists to block.
				getInstanceRoots(entry).some((entryRoot) =>
					match === "exact"
						? entryRoot === normalizedRoot
						: rootsOverlap(entryRoot, normalizedRoot),
				) &&
				isPidAlive(entry.pid) &&
				Number.isFinite(Date.parse(entry.heartbeatAt)) &&
				now - Date.parse(entry.heartbeatAt) <= STALE_HEARTBEAT_MS,
		)
		.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

// --- Resource footprint aggregation (#620) ----------------------------------

export interface InstanceFootprint {
	pid: number;
	/** The host's pinned primary root. Kept for wire compatibility — every
	 *  pre-#2130 consumer of `pilens_health`'s `resourceFootprint` reads it. */
	projectRoot: string;
	/**
	 * Every root this host serves (#2130), through {@link getInstanceRoots} —
	 * the same single reader the shared-checkout guard uses.
	 *
	 * Without it a multi-root host reported as if it worked in one directory:
	 * the scalar above is only the FIRST root, so `pilens_health` showed a
	 * subagent's temp worktree nowhere at all while `instances.json` listed it.
	 * Always present and always non-empty for a well-formed entry, so a
	 * consumer never has to branch on the pre-#2130 shape.
	 */
	projectRoots: string[];
	rssBytes: number;
	cpuPercent: number;
	lspChildCount: number;
	lspChildRssBytes: number;
	lspChildCpuPercent: number;
}

export interface ResourceFootprint {
	instanceCount: number;
	totalRssBytes: number;
	/** Sum of every sampled CPU%, host + every LSP child, across every
	 *  registered instance. This is a SUM, not an average — on a multi-core
	 *  box it can exceed 100 even for a single busy process (matches
	 *  `pidusage`'s per-process convention), so read it as "how much CPU is
	 *  attributable to pi-lens", not "% of one core". */
	totalCpuPercent: number;
	totalLspChildCount: number;
	perInstance: InstanceFootprint[];
}

/**
 * PURE aggregation over a registry snapshot: "how much CPU/RAM is pi-lens
 * attributable to, right now, across every process it owns" (#620) — the
 * host of every registered instance plus every one of its live LSP children.
 * Missing/unsampled `rssBytes`/`cpuPercent` (best-effort sampling can fail)
 * are treated as 0 for summation purposes — never as a full instance to
 * exclude, since a partially-sampled instance's other numbers are still real
 * data worth surfacing.
 *
 * Does NOT include transient analyzer children (jscpd/knip/etc.) — those are
 * short-lived and sampled separately per-invocation via
 * clients/resource-sampler.ts into clients/latency-logger.ts, not carried in
 * the registry (see the module docstring's scope note).
 *
 * #735: `isPidAlive`, when supplied, drops any instance whose owning pid is
 * confirmed dead BEFORE aggregation — a hard-killed pi process otherwise
 * leaves a registry entry with heartbeat-cached RSS that reads as a live,
 * resource-consuming instance until it eventually ages out (up to
 * `STALE_HEARTBEAT_MS`, see clients/instance-reaper.ts). Dropped rather than
 * flagged `stale: true`: a dead pid is unambiguous (unlike heartbeat
 * staleness, which the reaper deliberately treats as "maybe idle-but-alive"
 * and never uses to justify removing/hiding anything) — the wire shape and
 * every existing caller (chiefly `pilens_health`'s headline instance
 * count/RSS/CPU numbers) simply expects a footprint of currently-live
 * instances. Left `undefined` for pure/synchronous callers (incl. every
 * pre-#735 unit test) that pass a plain snapshot with no intent to check OS
 * process state — no filtering happens, preserving prior behavior exactly.
 * No pid-reuse identity check is applied here (unlike the reaper's child-pid
 * `matchProcess`): `InstanceEntry` never recorded the host's own command
 * line to verify against (same gap #525 called out for the reaper's PARENT
 * pid, deliberately left unfixed there too), and a health-report false
 * positive is a much smaller blast radius than the reaper's mistaken kill —
 * so plain liveness is judged sufficient here.
 */
export function computeResourceFootprint(
	instances: InstanceEntry[],
	isPidAlive?: (pid: number) => boolean,
): ResourceFootprint {
	const liveInstances = isPidAlive
		? instances.filter((instance) => isPidAlive(instance.pid))
		: instances;
	const perInstance: InstanceFootprint[] = liveInstances.map((instance) => {
		const lspChildRssBytes = instance.lspChildren.reduce(
			(sum, child) => sum + (child.rssBytes ?? 0),
			0,
		);
		const lspChildCpuPercent = instance.lspChildren.reduce(
			(sum, child) => sum + (child.cpuPercent ?? 0),
			0,
		);
		const roots = getInstanceRoots(instance);
		return {
			pid: instance.pid,
			projectRoot: roots[0] ?? instance.projectRoot,
			projectRoots: roots,
			rssBytes: instance.rssBytes ?? 0,
			cpuPercent: instance.cpuPercent ?? 0,
			lspChildCount: instance.lspChildren.length,
			lspChildRssBytes,
			lspChildCpuPercent,
		};
	});

	let totalRssBytes = 0;
	let totalCpuPercent = 0;
	let totalLspChildCount = 0;
	for (const inst of perInstance) {
		totalRssBytes += inst.rssBytes + inst.lspChildRssBytes;
		totalCpuPercent += inst.cpuPercent + inst.lspChildCpuPercent;
		totalLspChildCount += inst.lspChildCount;
	}

	return {
		instanceCount: perInstance.length,
		totalRssBytes,
		totalCpuPercent,
		totalLspChildCount,
		perInstance,
	};
}

/**
 * Read the live registry and compute the aggregate footprint — the query
 * side of "how much CPU/RAM is pi-lens using right now" (#620). Best-effort
 * (readInstanceRegistry never throws); the answer only reflects whatever
 * heartbeats have landed so far.
 *
 * #735: defaults to the reaper's `realIsPidAlive` so dead-pid registry
 * entries (a hard-killed pi process) are excluded from both the returned
 * footprint AND — opportunistically, fire-and-forget, best-effort — pruned
 * from the on-disk registry, the same "entry removal only, never blocks the
 * caller" convention `sweepOrphans`/`pruneDeadInstances` already use.
 * Pruning here is a bonus cleanup, not a substitute for the reaper sweep:
 * this path only prunes pids this particular read happened to find dead,
 * while the reaper sweep is the authoritative, scheduled cleanup. It never
 * prunes an entry that still lists children (#3539): only the sweep reaps
 * those, and it reaps them from that entry. Injectable
 * so tests can pass a fake predicate (or omit filtering entirely by passing
 * a function that always returns true) without touching real OS process
 * state.
 */
export async function getResourceFootprint(
	isPidAlive: (pid: number) => boolean = realIsPidAlive,
): Promise<ResourceFootprint> {
	const instances = await readInstanceRegistry();
	// #3539: only an entry with no children left to reap. This read kills
	// nothing, so dropping an entry that still lists children lost the only
	// record the registry sweep would have reaped them from. And only an entry
	// from this pid namespace: another namespace's pid, read from here, is not
	// its host (review F1).
	const namespace = ownPidNamespace();
	const dead: InstanceIdentity[] = instances
		.filter(
			(instance) =>
				!isPidAlive(instance.pid) &&
				instance.lspChildren.length === 0 &&
				isInPidNamespace(instance, namespace),
		)
		.map((instance) => ({
			pid: instance.pid,
			processStart: instance.processStart,
			pidNamespace: instance.pidNamespace,
		}));
	if (dead.length > 0) {
		// Fire-and-forget: a health-report read must never block on, or fail
		// because of, a registry write. Queued behind this process's other
		// registry writes, so `_settleRegistryMutationsForTests` awaits it too.
		queueRegistryMutation(() => prunePids(dead)).catch(() => {
			// best-effort — a dead-pid entry that fails to prune here is simply
			// re-evaluated (and re-dropped from the report) on the next read, and
			// remains catchable by the scheduled reaper sweep regardless.
		});
	}
	return computeResourceFootprint(instances, isPidAlive);
}

/** Best-effort removal of specific dead pids' entries from the on-disk
 *  registry (#735). Re-reads immediately before writing (rather than reusing
 *  an earlier snapshot) to narrow — not eliminate — the last-writer-wins race
 *  already accepted for this module's read-modify-write model (see the
 *  module docstring). Mirrors clients/instance-reaper.ts's
 *  `pruneDeadInstances` in the reaper delegates here so this module owns the
 *  registry lock seam without creating a dependency on the reaper. */
export async function pruneDeadInstances(
	dead: readonly InstanceIdentity[],
): Promise<"pruned" | "no-match" | "could-not-acquire"> {
	const result = await withInstanceRegistryLock(registryPath(), async () => {
		const file = await readRegistryAsync();
		// #3538: by (pid, start). A new instance that registered on a dead
		// one's pid while the sweep ran keeps its entry.
		const key = (identity: InstanceIdentity) =>
			`${identity.pid}:${identity.processStart ?? ""}:${identity.pidNamespace ?? ""}`;
		const targets = new Set(dead.map(key));
		const remaining = file.instances.filter(
			(entry) => !targets.has(key(entry)),
		);
		if (remaining.length === file.instances.length) return "no-match" as const;
		await writeRegistryAsync({ instances: remaining });
		return "pruned" as const;
	});
	return result ?? "could-not-acquire";
}

async function prunePids(dead: readonly InstanceIdentity[]): Promise<void> {
	await pruneDeadInstances(dead);
}
