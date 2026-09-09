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
 * Concurrency: every whole-file writer holds the adjacent `<registry>.lock`
 * O_EXCL lock across its read-modify-write. Contenders use 5-25ms jittered
 * backoff for up to 500ms; stale locks older than 5s or owned by a dead pid
 * are displaced and reclaimed. A crash can still leave a stale lock during
 * that window, so takeover remains deliberately bounded and observable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic, writeFileAtomicAsync } from "./atomic-write.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import {
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
import { realIsPidAlive, STALE_HEARTBEAT_MS } from "./instance-reaper.js";
import { normalizeFilePath } from "./path-utils.js";
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
}

export interface InstanceEntry {
	pid: number;
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

async function writeRegistryWithRetry(
	mutate: (file: RegistryFile) => RegistryFile,
	isCommitted: (file: RegistryFile) => boolean,
): Promise<void> {
	await withInstanceRegistryLock(registryPath(), async () => {
		for (let attempt = 0; attempt < REGISTRY_WRITE_RETRIES; attempt++) {
			await writeRegistryAsync(mutate(await readRegistryAsync()));
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
	return queueRegistryMutation(() => registerInstanceNow(projectRoot));
}

async function registerInstanceNow(projectRoot: string): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const pid = process.pid;
	const normalizedRoot = normalizeFilePath(projectRoot);
	const now = new Date().toISOString();
	const identity = isSubagentSession() ? getSubagentIdentity() : undefined;
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
			const others = file.instances.filter((entry) => entry.pid !== pid);
			const existing = file.instances.find((entry) => entry.pid === pid);
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
			others.push({
				pid,
				startedAt: existing?.startedAt ?? now,
				projectRoot: roots[0] ?? normalizedRoot,
				projectRoots: roots,
				lspChildren: existing?.lspChildren ?? [],
				lspChildCount: existing?.lspChildren?.length ?? 0,
				rssBytes: process.memoryUsage().rss,
				heartbeatAt: now,
				...(subagent ? { subagent } : {}),
			});
			return { instances: others };
		},
		(file) => file.instances.some((entry) => entry.pid === pid),
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
 * Shares the serialization tail with every other same-process registry
 * mutation, so it cannot interleave its read-modify-write with a concurrent
 * `registerInstance` and silently revert it (#1724).
 */
export function registerInstanceRoot(projectRoot: string): Promise<void> {
	return queueRegistryMutation(() => registerInstanceRootNow(projectRoot));
}

async function registerInstanceRootNow(projectRoot: string): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const pid = process.pid;
	const normalizedRoot = normalizeFilePath(projectRoot);
	await withInstanceRegistryLock(registryPath(), async () => {
		const file = await readRegistryAsync();
		const idx = file.instances.findIndex((entry) => entry.pid === pid);
		if (idx === -1) return;
		const current = file.instances[idx];
		const priorRoots = getInstanceRoots(current);
		const roots = mergeInstanceRoots(priorRoots, normalizedRoot);
		if (
			roots.length === priorRoots.length &&
			roots.every((root, index) => root === priorRoots[index])
		)
			return;
		file.instances[idx] = {
			...current,
			projectRoot: roots[0] ?? current.projectRoot,
			projectRoots: roots,
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
 *  LSP children's rss/CPU%). Cheap — safe to call every turn end. */
export async function updateHeartbeat(
	patch: HeartbeatPatch = {},
): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const pid = process.pid;
	await withInstanceRegistryLock(registryPath(), async () => {
		const file = await readRegistryAsync();
		const idx = file.instances.findIndex((entry) => entry.pid === pid);
		if (idx === -1) {
			// No prior registerInstance in this run (e.g. registry file was reaped
			// out from under us, or heartbeat fired before session_start finished) —
			// nothing to update against; skip rather than fabricate a projectRoot.
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

// Every mutation routed through this tail (`registerInstance`,
// `registerInstanceRoot`, `recordLspChild`, `removeLspChild`) reads the WHOLE
// registry file, edits this process's own entry, and writes the whole
// file back. Two such mutations from the SAME process — e.g. a client-ceiling
// eviction's `removeLspChild(victimPid)` racing the replacement spawn's
// `recordLspChild(newChild)` that follows it — are ordinary concurrent async
// calls with no ordering guarantee between them. Without serialization, the
// later WRITE can be built from a read taken before the earlier write landed,
// silently reverting it (last-writer-wins losing a same-process update, not
// just the already-accepted cross-process one — see the module docstring).
// #1724: this is why a forced LSP shutdown's deregistration could get
// clobbered by a concurrent respawn's registration. One shared tail
// serializes every same-process registry mutation of this shape so "record"
// and "remove" can never interleave their read-modify-write against each
// other — the single seam both the forced-shutdown and self-crash
// deregistration paths route through.
//
// #2146: the tail must be the PROCESS's one serialization point, and module
// scope did not deliver that. pi evaluates the pi-lens module graph up to nine
// times per process, so this module had up to nine tails, each serializing only
// its own callers. The dogfood run measured the consequence directly: three
// `instance-registry-corrupt` records inside nine seconds, with two project
// roots and one live instance's entry lost from `instances.json` — exactly the
// torn read-modify-write this tail exists to prevent, reintroduced by
// duplication rather than by a missing await. Keying it on `globalThis` makes
// every evaluation queue onto the same tail.
const REGISTRY_TAIL_FAMILY = "instance-registry.mutation-tail";
/** Bump when the tail cell's shape changes. */
const REGISTRY_TAIL_VERSION = 1;

function registryTailState(): { tail: Promise<void> } {
	return getProcessSingleton(
		REGISTRY_TAIL_FAMILY,
		REGISTRY_TAIL_VERSION,
		() => ({
			tail: Promise.resolve(),
		}),
	);
}

function queueRegistryMutation(op: () => Promise<void>): Promise<void> {
	const state = registryTailState();
	const run = state.tail.then(op);
	state.tail = run.catch(() => {});
	return run;
}

/**
 * Test-only: resolve once every registry mutation queued so far has landed.
 *
 * Several production call sites fire registry writes and deliberately do not
 * await them (`void registerInstance(...)` in the session_start handler), so a
 * test that reads the file straight afterwards races them. Queuing an empty op
 * on the same tail joins the queue rather than sleeping on it, which keeps the
 * wait exact instead of timing-dependent.
 */
export function _settleRegistryMutationsForTests(): Promise<void> {
	return queueRegistryMutation(async () => {});
}

/** Append/replace (by pid) an LSP child under this process's entry. */
export function recordLspChild(entry: RecordLspChildInput): Promise<void> {
	return queueRegistryMutation(() => recordLspChildNow(entry));
}

async function recordLspChildNow(entry: RecordLspChildInput): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const pid = process.pid;
	const now = new Date().toISOString();
	const childEntry: LspChildEntry = {
		pid: entry.pid,
		serverId: entry.serverId,
		command: entry.command,
		marker: entry.marker,
		spawnedAt: now,
	};
	const hostIdentity = getSubagentIdentity();
	await writeRegistryWithRetry(
		(file) => {
			const idx = file.instances.findIndex((inst) => inst.pid === pid);
			if (idx === -1) {
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
				file.instances.push({
					pid,
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
					instance.pid === pid &&
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
	const selfPid = process.pid;
	await withInstanceRegistryLock(registryPath(), async () => {
		const file = await readRegistryAsync();
		const idx = file.instances.findIndex((inst) => inst.pid === selfPid);
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
	if (!isInstanceRegistryEnabled()) return;
	const pid = process.pid;
	withInstanceRegistryLockSync(registryPath(), () => {
		const file = readRegistrySync();
		const remaining = file.instances.filter((entry) => entry.pid !== pid);
		if (remaining.length === file.instances.length) return;
		writeRegistrySync({ instances: remaining });
	});
}

/**
 * Drop ONE root from this process's entry (#2130) — the scoped counterpart to
 * {@link deregisterInstance}, for a worktree this host stops serving while the
 * host itself keeps running.
 *
 * SYNC fs inside, matching `deregisterInstance`'s `session_shutdown` contract
 * (#234: no child spawns at teardown; this function spawns none). Removing the
 * LAST root removes the whole entry — a host serving no root is not a peer any
 * caller should find. Removing the primary promotes the next root to
 * `projectRoot` rather than leaving a stale scalar behind.
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
 */
export function deregisterInstanceRoot(projectRoot: string): Promise<void> {
	return queueRegistryMutation(async () =>
		deregisterInstanceRootNow(projectRoot),
	);
}

function deregisterInstanceRootNow(projectRoot: string): void {
	if (!isInstanceRegistryEnabled()) return;
	const pid = process.pid;
	const normalizedRoot = normalizeFilePath(projectRoot);
	withInstanceRegistryLockSync(registryPath(), () => {
		const file = readRegistrySync();
		const idx = file.instances.findIndex((entry) => entry.pid === pid);
		if (idx === -1) return;
		const current = file.instances[idx];
		const remainingRoots = getInstanceRoots(current).filter(
			(root) => root !== normalizedRoot,
		);
		if (remainingRoots.length === getInstanceRoots(current).length) return;
		if (remainingRoots.length === 0) {
			writeRegistrySync({
				instances: file.instances.filter((entry) => entry.pid !== pid),
			});
			return;
		}
		file.instances[idx] = {
			...current,
			projectRoot: remainingRoots[0],
			projectRoots: remainingRoots,
		};
		writeRegistrySync(file);
	});
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
 * while the reaper sweep is the authoritative, scheduled cleanup. Injectable
 * so tests can pass a fake predicate (or omit filtering entirely by passing
 * a function that always returns true) without touching real OS process
 * state.
 */
export async function getResourceFootprint(
	isPidAlive: (pid: number) => boolean = realIsPidAlive,
): Promise<ResourceFootprint> {
	const instances = await readInstanceRegistry();
	const deadPids = new Set(
		instances
			.filter((instance) => !isPidAlive(instance.pid))
			.map((instance) => instance.pid),
	);
	if (deadPids.size > 0) {
		// Fire-and-forget: a health-report read must never block on, or fail
		// because of, a registry write.
		prunePids(deadPids).catch(() => {
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
	deadPids: Set<number>,
): Promise<"pruned" | "no-match" | "could-not-acquire"> {
	const result = await withInstanceRegistryLock(registryPath(), async () => {
		const file = await readRegistryAsync();
		const remaining = file.instances.filter(
			(entry) => !deadPids.has(entry.pid),
		);
		if (remaining.length === file.instances.length) return "no-match" as const;
		await writeRegistryAsync({ instances: remaining });
		return "pruned" as const;
	});
	return result ?? "could-not-acquire";
}

async function prunePids(deadPids: Set<number>): Promise<void> {
	await pruneDeadInstances(deadPids);
}
