/**
 * Periodic version refresh for pi-lens's managed tools (#1730, #1747).
 *
 * #1730 covered the npm strategy. #1747 extends the SAME cadence, stamp file,
 * session budget and degradation kind to the other five rather than building a
 * second mechanism: github (27 entries), pip (6), archive (4), maven (1) and
 * gem (1) were all frozen at whatever the installer resolved on day one,
 * because `installTool` only runs when the tool is ABSENT. The only per-
 * strategy difference is the re-resolution step, which lives in
 * `installer/index.ts`'s `refreshManagedTool`.
 *
 * `~/.pi-lens/tools/package.json` records ranges, not versions — `npm install
 * knip` writes `"knip": "^6.4.1"` and a lockfile pinning 6.4.1. Nothing ever
 * re-resolved that range, so the managed copy stayed on the version present at
 * first install for the life of the machine. A managed knip 28 minors behind
 * produced 62 unused-export findings on a tree the same project's own knip
 * reported clean, and acting on those findings deletes live code. Every managed
 * npm tool drifts the same way; a stale pyright or biome is the same wrong
 * verdict, quieter.
 *
 * The policy, and the constraints each part answers:
 *
 * - Bounded. At most `maxPerSession` tools (default 1) are refreshed per
 *   session, and each tool is eligible again only once per `intervalMs`
 *   (default 7 days). A managed tools tree with 22 entries therefore costs at
 *   most one `npm update` spawn per session, never one per run and never a
 *   22-package burst.
 * - Off the hot path. `runManagedToolRefresh` is never awaited by a caller
 *   that serves a user request; `runtime-session.ts` schedules it on an
 *   unref'd background timer after `session_start` has already returned.
 * - Non-blocking for availability. A refresh failure never removes or hides
 *   the installed copy. `npm update` leaves the existing tree in place, and
 *   this module never touches `node_modules` itself, so the current version
 *   keeps serving.
 * - Re-armed per session, not per process. The per-session budget is keyed to
 *   the degradation ledger's session generation, so a long-lived process that
 *   serves many `/new` sessions re-checks eligibility each time — and the
 *   REAL cooldown lives in the persisted stamp, not in process memory, so a
 *   restart loop cannot turn a 7-day cadence into an every-launch one.
 * - Empty is not the same as errored. A missing stamp file means "never
 *   refreshed" and makes every tool eligible. An UNREADABLE stamp file means
 *   the cadence is unknown; the session degrades once and refreshes nothing,
 *   rather than treating unknown as fresh (drift forever) or as stale (a
 *   22-package burst on every session).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { recordDegradationOnce } from "../degradation-ledger.js";
import { commitDurableStoreAsync } from "../durable-store.js";
import {
	pmBinary,
	resolveNodePackageManager,
	updateArgs,
} from "../package-manager.js";
import { safeSpawnAsync } from "../safe-spawn.js";
import { logSessionStart } from "../sessionstart-logger.js";
import {
	acquireManagedInstallGate,
	getManagedToolsDir,
	getRefreshableManagedTools,
	invalidateManagedToolResolution,
	isManagedToolPresent,
	type ManagedToolStrategy,
	npmToolNeedsPostinstall,
	refreshManagedTool,
	resolveManagedNpmBinPath,
	verifyToolBinary,
} from "./index.js";
import {
	releaseManagedToolRefreshSlot,
	reserveManagedToolRefreshSlot,
} from "./managed-tool-refresh-session.js";

const STATE_FILENAME = ".refresh-state.json";
const STATE_VERSION = 1;

/** Default per-tool refresh cadence: once a week. */
const DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Cooldown after a FAILED refresh. Shorter than the success cadence — a failure
 * is usually a transient network or registry problem worth retrying sooner —
 * but still a real cooldown, so a permanently offline machine spawns at most
 * one `npm update` per tool per day rather than one per session.
 */
const DEFAULT_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PER_SESSION = 1;
const DEFAULT_TIMEOUT_MS = 120_000;

function numericEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function refreshIntervalMs(): number {
	return numericEnv("PI_LENS_TOOL_REFRESH_INTERVAL_MS", DEFAULT_INTERVAL_MS);
}

function retryIntervalMs(): number {
	return numericEnv("PI_LENS_TOOL_REFRESH_RETRY_MS", DEFAULT_RETRY_INTERVAL_MS);
}

function maxPerSession(): number {
	return numericEnv(
		"PI_LENS_TOOL_REFRESH_MAX_PER_SESSION",
		DEFAULT_MAX_PER_SESSION,
	);
}

function refreshTimeoutMs(): number {
	return numericEnv("PI_LENS_INSTALL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

// --- Persisted state ---

export interface ManagedToolRefreshEntry {
	/** When this tool's refresh last ran, successful or not. */
	checkedAt: number;
	/**
	 * Version installed after that run, when it could be read — the meaning
	 * differs per strategy (#1759 review F8), and callers displaying this
	 * value should not assume it is a semver:
	 *   - npm: the version from the installed package's own `package.json`.
	 *   - pip/gem: the tool's own `--version` output, probed after the run
	 *     (there is no manifest pi-lens can read for either).
	 *   - github: the release tag (`v1.2.3`, `2024.03.01`, whatever the repo
	 *     tags with) — NOT a parsed semver.
	 *   - archive/maven: the resolved coordinate itself (the pinned URL or the
	 *     Maven GAV), same as `resolutionId` — these two strategies have no
	 *     independent "installed version" to read.
	 */
	version?: string;
	/**
	 * What the tool's coordinate resolved to at that run — a GitHub release tag,
	 * an archive URL, a Maven GAV (#1747). This is the field that makes "did
	 * anything move?" answerable WITHOUT downloading: a github refresh that sees
	 * the same tag, or an archive refresh that sees the same pinned URL, stops
	 * here. npm and pip/gem leave it unset; their package manager owns the
	 * comparison.
	 */
	resolutionId?: string;
	/**
	 * `ETag` from the last GitHub `releases/latest` response (#1747), replayed as
	 * `If-None-Match`. A 304 answer costs no rate-limit quota and no download,
	 * which is what keeps 27 release-installed tools cheap. Written only after a
	 * SUCCESSFUL refresh: replaying an ETag from a run whose download failed
	 * would turn the retry into a 304 and skip the install forever.
	 */
	etag?: string;
	/** The run failed; `retryIntervalMs` applies instead of `intervalMs`. */
	failed?: boolean;
}

export interface ManagedToolRefreshState {
	version: number;
	tools: Record<string, ManagedToolRefreshEntry>;
}

/**
 * Reading the stamp has three outcomes, and collapsing any two of them is the
 * bug: `empty` (no file yet — everything is genuinely due) must not read as
 * `unreadable` (cadence unknown — refresh nothing this session), and neither
 * may read as `ok` with an empty map.
 */
export type ManagedToolRefreshStateRead =
	| { status: "ok"; state: ManagedToolRefreshState }
	| { status: "empty"; state: ManagedToolRefreshState }
	| { status: "unreadable"; reason: string };

function emptyState(): ManagedToolRefreshState {
	return { version: STATE_VERSION, tools: {} };
}

export function getManagedToolRefreshStatePath(): string {
	return path.join(getManagedToolsDir(), STATE_FILENAME);
}

/** Coerce one parsed entry, dropping anything whose shape we cannot trust. */
function parseEntry(value: unknown): ManagedToolRefreshEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.checkedAt !== "number") return undefined;
	if (!Number.isFinite(candidate.checkedAt)) return undefined;
	return {
		checkedAt: candidate.checkedAt,
		...(typeof candidate.version === "string" && {
			version: candidate.version,
		}),
		...(typeof candidate.resolutionId === "string" && {
			resolutionId: candidate.resolutionId,
		}),
		...(typeof candidate.etag === "string" && { etag: candidate.etag }),
		...(candidate.failed === true && { failed: true }),
	};
}

function parseState(contents: string): ManagedToolRefreshState {
	const parsed: unknown = JSON.parse(contents);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("refresh-state root is not an object");
	}
	const rawTools = (parsed as { tools?: unknown }).tools;
	if (!rawTools || typeof rawTools !== "object" || Array.isArray(rawTools)) {
		throw new Error("refresh-state.tools is not an object");
	}
	const tools: Record<string, ManagedToolRefreshEntry> = {};
	for (const [toolId, value] of Object.entries(
		rawTools as Record<string, unknown>,
	)) {
		const entry = parseEntry(value);
		if (entry) tools[toolId] = entry;
	}
	return { version: STATE_VERSION, tools };
}

export async function readManagedToolRefreshState(): Promise<ManagedToolRefreshStateRead> {
	let contents: string;
	try {
		contents = await fs.readFile(getManagedToolRefreshStatePath(), "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// ENOENT is the honest "never refreshed" answer. A permission error or a
		// directory in the file's place is NOT — that is unknown cadence.
		if (code === "ENOENT") return { status: "empty", state: emptyState() };
		return { status: "unreadable", reason: code ?? "read error" };
	}
	try {
		return { status: "ok", state: parseState(contents) };
	} catch (err) {
		return { status: "unreadable", reason: (err as Error).message };
	}
}

/**
 * Commit one tool's stamp under the durable-store lock, merging against
 * whatever a sibling pi-lens process wrote since this process read.
 *
 * A torn or corrupt file is recovered as empty HERE (rather than thrown) so a
 * later commit can replace it. The read path above still reports `unreadable`,
 * which is what suppresses the refresh; this side only has to make sure the
 * file becomes valid again instead of staying corrupt forever.
 */
async function writeRefreshStamp(
	toolId: string,
	entry: ManagedToolRefreshEntry,
): Promise<void> {
	try {
		await fs.mkdir(getManagedToolsDir(), { recursive: true });
		await commitDurableStoreAsync<ManagedToolRefreshState>({
			path: getManagedToolRefreshStatePath(),
			deserialize: (contents) => {
				if (contents === undefined) return emptyState();
				try {
					return parseState(contents);
				} catch {
					return emptyState();
				}
			},
			merge: (disk) => {
				disk.tools[toolId] = entry;
				return disk;
			},
			serialize: (disk) => JSON.stringify(disk, null, 2),
			waitMs: 2000,
			retryMs: 25,
			staleMs: 60_000,
			timeoutMessage: "Timed out waiting for managed-tool refresh-state lock",
			onContention: "skip-log",
			logContention: () => {
				logSessionStart(
					`managed-tool-refresh ${toolId}: stamp deferred because another process owns the lock`,
				);
			},
		});
	} catch (err) {
		// A stamp that cannot be written means this tool is eligible again next
		// session. That is noisier than intended but never wrong, so it degrades
		// rather than throwing into the background timer.
		recordDegradationOnce({
			kind: "managed-tool-refresh",
			subject: toolId,
			reason: `stamp write failed: ${(err as Error).message}`,
		});
		logSessionStart(
			`managed-tool-refresh ${toolId}: stamp write failed (${(err as Error).message})`,
		);
	}
}

/**
 * Record that a tool was just INSTALLED, so the cadence starts from the install
 * (#1747).
 *
 * An install has performed the freshest possible resolution, so leaving the
 * stamp absent would make the refresh treat a brand-new tool as never checked
 * and re-resolve it the moment the timer next fired. Recording the resolution
 * identity here is also what spares the archive and maven entries a redundant
 * re-download: their refresh compares the recorded pin against the registry's,
 * and an install writes exactly the pin it used.
 *
 * Called from `installer/index.ts`'s `finishInstallAttempt` for every strategy
 * EXCEPT npm — npm stamps itself via `stampManagedToolInstalled` below, which
 * also captures the installed version; this funnel would otherwise overwrite
 * that version-bearing stamp with a version-less one milliseconds later.
 */
export async function stampManagedToolInstall(
	toolId: string,
	resolutionId?: string,
	now: number = Date.now(),
): Promise<void> {
	await writeRefreshStamp(toolId, {
		checkedAt: now,
		...(resolutionId !== undefined && { resolutionId }),
	});
}

/**
 * Stamp a tool as freshly resolved, without refreshing it.
 *
 * Called right after a successful managed npm install (#1746 review F4). An
 * install already resolved the range against the registry seconds ago, so the
 * tool is by definition current. Without this stamp a fresh machine that
 * installs 22 tools on day one has 22 tools with no stamp, and then burns the
 * next 22 sessions running `npm update` on packages installed minutes earlier.
 *
 * Best-effort by design: a missing stamp costs one wasted update, never a
 * wrong version, so it must not fail an install.
 */
export async function stampManagedToolInstalled(
	toolId: string,
	packageName: string,
	now: number = Date.now(),
): Promise<void> {
	const version = await readInstalledVersion(packageName);
	await writeRefreshStamp(toolId, {
		checkedAt: now,
		...(version !== undefined && { version }),
	});
}

// --- Per-session budget ---

// --- Candidate selection ---

export interface RefreshCandidate {
	toolId: string;
	strategy: ManagedToolStrategy;
	/** npm/pip/gem only; github/maven/archive resolve from their own spec. */
	packageName?: string;
	/** npm only — what `refreshNpmOne` verifies after `npm update`. */
	binaryName?: string;
	checkArgs: string[];
	verificationTimeoutMs: number;
	/**
	 * npm only — see `packageEntryVerification`. Carried through so the refresh
	 * verifies the binary exactly the way the install did (#2722).
	 */
	packageEntryOf?: string;
	/** npm only — every installed registry id covered by this package update. */
	coveredToolIds?: string[];
}

/**
 * Registry entries that are BOTH refreshable and actually installed where
 * pi-lens installs. An entry pi-lens has never installed has no version to
 * move, and `npm update`, `pip install -U` or a release download on one would
 * turn a refresh into an unrequested install.
 *
 * The presence check is filesystem-only for every strategy (#1747), so scanning
 * all 60-odd registry entries on a background timer costs no spawn and no
 * network.
 */
async function installedRefreshCandidates(): Promise<RefreshCandidate[]> {
	const candidates: RefreshCandidate[] = [];
	for (const tool of getRefreshableManagedTools()) {
		if (!(await isManagedToolPresent(tool.toolId))) continue;
		candidates.push({
			toolId: tool.toolId,
			strategy: tool.strategy,
			checkArgs: tool.checkArgs,
			verificationTimeoutMs: tool.verificationTimeoutMs ?? 10_000,
			...(tool.packageName !== undefined && { packageName: tool.packageName }),
			...(tool.binaryName !== undefined && { binaryName: tool.binaryName }),
			...(tool.packageEntryOf !== undefined && {
				packageEntryOf: tool.packageEntryOf,
			}),
		});
	}
	const byPackage = new Map<string, RefreshCandidate>();
	const distinct: RefreshCandidate[] = [];
	for (const candidate of candidates) {
		if (candidate.strategy !== "npm" || !candidate.packageName) {
			distinct.push(candidate);
			continue;
		}
		const existing = byPackage.get(candidate.packageName);
		if (existing) {
			existing.coveredToolIds?.push(candidate.toolId);
			continue;
		}
		const representative = { ...candidate, coveredToolIds: [candidate.toolId] };
		byPackage.set(candidate.packageName, representative);
		distinct.push(representative);
	}
	return distinct;
}

/**
 * Which candidates are due, oldest stamp first. A tool with no stamp sorts
 * first (it has never been refreshed); ties break on toolId so the selection
 * is deterministic and a starved tool eventually reaches the front.
 */
export function selectStaleTools(
	candidates: readonly RefreshCandidate[],
	state: ManagedToolRefreshState,
	now: number,
): RefreshCandidate[] {
	const interval = refreshIntervalMs();
	const retry = retryIntervalMs();
	const due = candidates.filter((candidate) => {
		return (candidate.coveredToolIds ?? [candidate.toolId]).some((toolId) => {
			const entry = state.tools[toolId];
			if (!entry) return true;
			const cooldown = entry.failed ? retry : interval;
			return now - entry.checkedAt >= cooldown;
		});
	});
	return due.sort((a, b) => {
		const aAt = Math.min(
			...(a.coveredToolIds ?? [a.toolId]).map(
				(toolId) => state.tools[toolId]?.checkedAt ?? 0,
			),
		);
		const bAt = Math.min(
			...(b.coveredToolIds ?? [b.toolId]).map(
				(toolId) => state.tools[toolId]?.checkedAt ?? 0,
			),
		);
		return aAt !== bAt ? aAt - bAt : a.toolId.localeCompare(b.toolId);
	});
}

// --- Refresh ---

/** Version recorded in an installed package's own `package.json`, if readable. */
async function readInstalledVersion(
	packageName: string,
): Promise<string | undefined> {
	try {
		const raw = await fs.readFile(
			path.join(
				getManagedToolsDir(),
				"node_modules",
				packageName,
				"package.json",
			),
			"utf-8",
		);
		const parsed: unknown = JSON.parse(raw);
		const version = (parsed as { version?: unknown } | null)?.version;
		return typeof version === "string" ? version : undefined;
	} catch {
		return undefined;
	}
}

export type ManagedToolRefreshSkipReason =
	| "disabled"
	| "session-budget"
	| "no-candidates"
	| "state-unreadable"
	| "nothing-due";

export interface ManagedToolRefreshResult {
	toolId: string;
	strategy: ManagedToolStrategy;
	packageName?: string;
	previousVersion?: string;
	currentVersion?: string;
	changed: boolean;
	/** The updated binary answered `--version`. False also covers a failed spawn. */
	verified: boolean;
	ok: boolean;
	/** True when the package-manager or strategy refresh actually ran. */
	attempted?: boolean;
}

export interface ManagedToolRefreshOutcome {
	skipped?: ManagedToolRefreshSkipReason;
	refreshed: ManagedToolRefreshResult[];
}

/**
 * Refresh one tool, choosing the mechanism its install strategy needs (#1747).
 *
 * npm stays here because it needs the package-manager resolver; every other
 * strategy delegates to `refreshManagedTool` in the installer, which owns the
 * GitHub release query, the `pip install -U` ladder, `gem install`, and the
 * pinned-coordinate comparison for maven/archive. Both halves share ONE budget,
 * ONE stamp file and ONE degradation kind, so adding five strategies does not
 * turn one spawn per session into six.
 */
async function refreshOne(
	candidate: RefreshCandidate,
	entry: ManagedToolRefreshEntry | undefined,
	now: number,
): Promise<ManagedToolRefreshResult> {
	return candidate.strategy === "npm"
		? refreshNpmOne(candidate, now)
		: refreshNonNpmOne(candidate, entry, now);
}

async function refreshNonNpmOne(
	candidate: RefreshCandidate,
	entry: ManagedToolRefreshEntry | undefined,
	now: number,
): Promise<ManagedToolRefreshResult> {
	const previousVersion = entry?.version;
	const startedAt = Date.now();
	const attempt = await refreshManagedTool(candidate.toolId, {
		...(entry?.resolutionId !== undefined && {
			resolutionId: entry.resolutionId,
		}),
		...(entry?.etag !== undefined && { etag: entry.etag }),
		...(previousVersion !== undefined && { version: previousVersion }),
	});
	const elapsedMs = Date.now() - startedAt;

	if (!attempt.ok) {
		if (attempt.declined) {
			// #1759 review F2: the kill switch or the project-trust gate refused
			// BEFORE any strategy ran — nothing was touched, so this is not a
			// failure. No degradation, and deliberately NO stamp: writing one would
			// apply the 24h retry cooldown to a refusal that has nothing to do with
			// the tool, delaying its next real attempt after the block lifts.
			logSessionStart(
				`managed-tool-refresh ${candidate.toolId}: ${candidate.strategy} refresh declined after ${elapsedMs}ms (${attempt.reason ?? "unknown"}) — no stamp written, retried next session`,
			);
			return {
				toolId: candidate.toolId,
				strategy: candidate.strategy,
				...(candidate.packageName !== undefined && {
					packageName: candidate.packageName,
				}),
				previousVersion,
				currentVersion: previousVersion,
				changed: false,
				verified: false,
				ok: false,
				attempted: false,
			};
		}
		// A real failure may have left a stale cached path or probe entry behind
		// (e.g. a partially-cleared install), so the next resolution has to
		// re-probe rather than trust what it had before this attempt (#1759
		// review F1 — the npm path already does this on its own failure branch).
		invalidateManagedToolResolution(candidate.toolId);
		recordDegradationOnce({
			kind: "managed-tool-refresh",
			subject: candidate.toolId,
			reason: `${candidate.strategy} refresh failed: ${attempt.reason ?? "unknown"}`,
		});
		logSessionStart(
			`managed-tool-refresh ${candidate.toolId}: ${candidate.strategy} refresh failed after ${elapsedMs}ms — keeping ${previousVersion ?? "installed"} (${attempt.reason ?? "unknown"})`,
		);
		await writeRefreshStamp(candidate.toolId, {
			checkedAt: now,
			failed: true,
			...(previousVersion !== undefined && { version: previousVersion }),
			...(entry?.resolutionId !== undefined && {
				resolutionId: entry.resolutionId,
			}),
			// Deliberately NOT carrying `entry.etag` forward: a stamp that replays
			// the validator of a run whose download failed would get a 304 next
			// time and skip the install that never happened.
		});
		return {
			toolId: candidate.toolId,
			strategy: candidate.strategy,
			...(candidate.packageName !== undefined && {
				packageName: candidate.packageName,
			}),
			previousVersion,
			currentVersion: previousVersion,
			changed: false,
			// No spawn to verify for the non-npm strategies — a failed refresh never
			// touched the installed copy, so there is nothing new to check.
			verified: false,
			ok: false,
			attempted: true,
		};
	}

	const currentVersion = attempt.version;
	const changed = !attempt.unchanged;
	await writeRefreshStamp(candidate.toolId, {
		checkedAt: now,
		...(currentVersion !== undefined && { version: currentVersion }),
		...(attempt.resolutionId !== undefined && {
			resolutionId: attempt.resolutionId,
		}),
		...(attempt.etag !== undefined && { etag: attempt.etag }),
	});
	logSessionStart(
		changed
			? `managed-tool-refresh ${candidate.toolId}: ${previousVersion ?? "unknown"} → ${currentVersion ?? "unknown"} via ${candidate.strategy} (${elapsedMs}ms)`
			: `managed-tool-refresh ${candidate.toolId}: unchanged at ${currentVersion ?? previousVersion ?? "unknown"} via ${candidate.strategy} (${elapsedMs}ms)`,
	);
	return {
		toolId: candidate.toolId,
		strategy: candidate.strategy,
		...(candidate.packageName !== undefined && {
			packageName: candidate.packageName,
		}),
		previousVersion,
		currentVersion,
		changed,
		// `refreshManagedTool` already verifies the artifact it just wrote
		// (`verifyRefreshedArtifact` for github/archive/maven, the `--version`
		// probe for pip/gem) — `ok: true` here already means "and it runs".
		verified: true,
		ok: true,
		attempted: true,
	};
}

async function refreshNpmOne(
	candidate: RefreshCandidate,
	now: number,
): Promise<ManagedToolRefreshResult> {
	// Every npm candidate carries a packageName; `getRefreshableManagedTools`
	// drops the ones that do not.
	const packageName = candidate.packageName as string;

	// #1759 review R2: npm used to spawn `npm update` directly, with none of
	// the kill-switch/trust-gate/lock checks the five other strategies pass
	// through `refreshManagedTool`. Same primitive, same declined-no-op
	// semantics as `refreshNonNpmOne`'s `attempt.declined` branch below: a
	// refusal writes no stamp and records no degradation, so it does not burn
	// the tool's retry cooldown on a block that has nothing to do with it.
	const gateStartedAt = Date.now();
	const gate = await acquireManagedInstallGate(
		`managed tool refresh: ${candidate.toolId}`,
	);
	if (!gate.ok) {
		logSessionStart(
			`managed-tool-refresh ${candidate.toolId}: npm refresh declined after ${Date.now() - gateStartedAt}ms (${gate.reason ?? "unknown"}) — no stamp written, retried next session`,
		);
		return {
			toolId: candidate.toolId,
			strategy: "npm",
			packageName,
			changed: false,
			verified: false,
			ok: false,
			attempted: false,
		};
	}
	try {
		return await performNpmRefresh(candidate, packageName, now);
	} finally {
		await gate.release?.();
	}
}

async function performNpmRefresh(
	candidate: RefreshCandidate,
	packageName: string,
	now: number,
): Promise<ManagedToolRefreshResult> {
	const toolsDir = getManagedToolsDir();
	const previousVersion = await readInstalledVersion(packageName);
	const pm = await resolveNodePackageManager(toolsDir);
	const testNpmScript =
		process.env.PI_LENS_TEST_MODE === "1"
			? process.env.PI_LENS_TEST_NPM_SCRIPT
			: undefined;
	const command = testNpmScript ? process.execPath : pmBinary(pm);
	const args = [
		...(testNpmScript ? [testNpmScript] : []),
		...updateArgs(pm, packageName, {
			ignoreScripts: !npmToolNeedsPostinstall(packageName),
		}),
	];

	const startedAt = Date.now();
	const spawned = await safeSpawnAsync(command, args, {
		cwd: toolsDir,
		timeout: refreshTimeoutMs(),
		ignoreAmbientSignal: true,
		lifetimeCoupled: true,
	});
	const elapsedMs = Date.now() - startedAt;

	if (spawned.status !== 0 || spawned.error) {
		const reason = (spawned.error?.message ?? spawned.stderr ?? "").slice(
			0,
			200,
		);
		// "Keeping <old version>" would be an unchecked assertion (#1746 review
		// F2). The spawn budget kills the package manager where it stands, which
		// can be mid-write: the tree may hold a new version, a half-written one,
		// or the old one. So report the version that is actually on disk now, and
		// drop the cached resolution either way — a killed package manager can
		// rewrite `.bin` shims without moving the version in `package.json`.
		const onDisk = await readInstalledVersion(packageName);
		invalidateManagedToolResolution(candidate.toolId);
		recordDegradationOnce({
			kind: "managed-tool-refresh",
			subject: candidate.toolId,
			reason: `${pm} update failed: ${reason || "non-zero exit"}`,
		});
		logSessionStart(
			`managed-tool-refresh ${candidate.toolId}: ${pm} update failed after ${elapsedMs}ms — on disk now ${onDisk ?? "unreadable"} (was ${previousVersion ?? "unknown"}); resolution cache cleared for re-probe (${reason || "non-zero exit"})`,
		);
		await writeRefreshStamp(candidate.toolId, {
			checkedAt: now,
			failed: true,
			...(onDisk !== undefined && { version: onDisk }),
		});
		return {
			toolId: candidate.toolId,
			strategy: "npm",
			packageName,
			previousVersion,
			currentVersion: onDisk,
			changed: onDisk !== undefined && onDisk !== previousVersion,
			verified: false,
			ok: false,
			attempted: true,
		};
	}

	const currentVersion = await readInstalledVersion(packageName);
	const changed =
		currentVersion !== undefined && currentVersion !== previousVersion;

	// The update rewrote `node_modules`, so every cached claim about where this
	// tool resolves — the in-memory path cache and the 24h probe cache — is now
	// an assertion about a tree that no longer exists. Drop it BEFORE verifying,
	// so a caller arriving mid-verify re-probes rather than reading the stale
	// entry (#1746 review F2).
	invalidateManagedToolResolution(candidate.toolId);

	// `installNpmTool` treats verification as mandatory: an install that cannot
	// run its own binary is not an install. An UPDATE that leaves an unrunnable
	// binary is the same failure, and it used to pass silently — the version row
	// was written from `package.json` alone, which a half-written tree still
	// answers.
	// Every npm candidate carries a binaryName; `getRefreshableManagedTools`
	// drops npm entries that do not.
	const binaryName = candidate.binaryName as string;
	const binPath = resolveManagedNpmBinPath(binaryName);
	const verified = await verifyToolBinary(
		binPath,
		undefined,
		undefined,
		candidate.verificationTimeoutMs,
		candidate.checkArgs,
		// #2722: the same verification the install used. Without this the daily
		// refresh would demand a `--version` verdict from a server that can never
		// give one — a ~4 MB doomed spawn that stamps the refresh failed forever.
		candidate.packageEntryOf,
	);
	if (!verified) {
		recordDegradationOnce({
			kind: "managed-tool-refresh",
			subject: candidate.toolId,
			reason: `binary failed verification after ${pm} update (${previousVersion ?? "unknown"} → ${currentVersion ?? "unknown"})`,
		});
		// Deliberately NOT removed. `installNpmTool` deletes a freshly installed
		// package that fails verification because nothing was working before it;
		// here a working tool existed a moment ago, and deleting the tree takes it
		// offline for certain rather than probably. The cache invalidation above is
		// what lets `ensureTool`'s own probe-and-repair path see the breakage and
		// reinstall. Stamped as failed so the shorter retry cooldown applies.
		logSessionStart(
			`managed-tool-refresh ${candidate.toolId}: ${pm} update ran but ${binPath} failed verification — resolution cache cleared for re-probe (${elapsedMs}ms)`,
		);
		await writeRefreshStamp(candidate.toolId, {
			checkedAt: now,
			failed: true,
			...(currentVersion !== undefined && { version: currentVersion }),
		});
		return {
			toolId: candidate.toolId,
			strategy: "npm",
			packageName: candidate.packageName,
			previousVersion,
			currentVersion,
			changed,
			verified: false,
			ok: false,
			attempted: true,
		};
	}

	await writeRefreshStamp(candidate.toolId, {
		checkedAt: now,
		...(currentVersion !== undefined && { version: currentVersion }),
	});
	// The observability row #1730 asks for: a wrong verdict from a managed tool
	// can be traced to the version that produced it, and to the moment it moved.
	logSessionStart(
		changed
			? `managed-tool-refresh ${candidate.toolId}: ${previousVersion ?? "unknown"} → ${currentVersion} via ${pm} update, verified; package ${packageName}, covered ids ${candidate.coveredToolIds?.join(",") ?? candidate.toolId} (${elapsedMs}ms)`
			: `managed-tool-refresh ${candidate.toolId}: unchanged at ${currentVersion ?? previousVersion ?? "unknown"}; package ${packageName}, covered ids ${candidate.coveredToolIds?.join(",") ?? candidate.toolId} (${elapsedMs}ms)`,
	);
	return {
		toolId: candidate.toolId,
		strategy: "npm",
		packageName,
		previousVersion,
		currentVersion,
		changed,
		verified: true,
		ok: true,
		attempted: true,
	};
}

/**
 * The refresh currently running in this process, so a second caller joins it
 * instead of starting a rival one.
 *
 * #1746 review F1: `scheduleManagedToolRefresh` arms on EVERY
 * `handleSessionStart`, and an `npm update` can easily outlive the 30s gap to
 * the next session. Without this, two runs raced through the budget check and
 * both spawned a package manager into the same unlocked managed
 * `node_modules`. The join is the same shape `ensureTool` uses for its own
 * duplicate startup requests (`clients/installer/index.ts:4175-4182`, cleared
 * at `:4314-4318`).
 *
 * This is the local form of the single-flight primitive #1753 proposes. When
 * that lands, this is one of its callers.
 */
let refreshInFlight: Promise<ManagedToolRefreshOutcome> | null = null;

/**
 * A yield tap: called (and awaited) at every point in the walk where a
 * `handleSessionStart` reset could land mid-run. Production never passes one
 * — `noopTap` costs one no-op function call per await site. `tests/support/
 * reset-explorer.ts` fires `resetManagedToolRefreshSession` at a chosen tap
 * to prove the R2-F1 class (#1746) can't recur: see
 * `runManagedToolRefreshForExploration` below and
 * `tests/clients/installer/managed-tool-refresh.test.ts`'s "reset-interleaving
 * explorer (#1840)" block.
 */
type RefreshTap = () => void | Promise<void>;
const noopTap: RefreshTap = () => {};

/**
 * Run one session's worth of managed-tool refresh. Never throws: the caller is
 * a background timer with no one to report to.
 *
 * Concurrent callers share one run. The guard is only process-wide; two pi
 * processes can still refresh at the same time, which the per-tool stamp
 * narrows but does not close. See the PR body for that limit stated plainly.
 */
export function runManagedToolRefresh(
	now: number = Date.now(),
): Promise<ManagedToolRefreshOutcome> {
	const joined = refreshInFlight;
	if (joined) {
		logSessionStart(
			"managed-tool-refresh: joining the refresh already in flight",
		);
		return joined;
	}
	// No `await` between starting the run and publishing it, so no third caller
	// can slip through and start a second one.
	//
	// The clear is unconditional. An identity check (`if (refreshInFlight ===
	// run)`) is the usual companion to this pattern — `package-manager.ts:225`
	// needs one because its map entry can be replaced by a later caller while an
	// older probe is still settling. This slot cannot: the line below is its only
	// writer, and every other caller returns early while it is non-null, so when
	// this `finally` runs the slot still holds `run`. #1746 review round 2 proved
	// that branch unreachable (mutating it to an unconditional clear failed no
	// test), and a branch no input can take is not a guard.
	const run = executeManagedToolRefresh(now, noopTap).finally(() => {
		refreshInFlight = null;
	});
	refreshInFlight = run;
	return run;
}

/**
 * Test-only entry point for `tests/support/reset-explorer.ts`. Calls
 * `executeManagedToolRefresh` directly, bypassing the `refreshInFlight`
 * singleton above — the explorer runs one walk per await point and each must
 * be independent, not coalesced into the previous one. Never call this from
 * production code; production always goes through `runManagedToolRefresh`.
 */
export function runManagedToolRefreshForExploration(
	now: number,
	tap: RefreshTap,
): Promise<ManagedToolRefreshOutcome> {
	return executeManagedToolRefresh(now, tap);
}

async function executeManagedToolRefresh(
	now: number,
	tap: RefreshTap = noopTap,
): Promise<ManagedToolRefreshOutcome> {
	if (process.env.PI_LENS_DISABLE_TOOL_REFRESH === "1") {
		return { skipped: "disabled", refreshed: [] };
	}
	// Reserve BEFORE any await. Reading the budget here and spending it after
	// the two reads below is the F1 race; `reserveManagedToolRefreshSlot`
	// checks and takes in one synchronous step, and a run that turns out to
	// have nothing to do hands the slot straight back.
	if (!reserveManagedToolRefreshSlot(maxPerSession())) {
		return { skipped: "session-budget", refreshed: [] };
	}
	// Slots this run HOLDS and has not yet spent. Held slots are given back on
	// every exit that never reached a spawn; a spent slot is gone for good.
	let held = 1;
	const releaseReservation = (): void => {
		while (held > 0) {
			releaseManagedToolRefreshSlot();
			held -= 1;
		}
	};

	try {
		const candidates = await installedRefreshCandidates();
		await tap();
		if (candidates.length === 0) {
			releaseReservation();
			return { skipped: "no-candidates", refreshed: [] };
		}

		const read = await readManagedToolRefreshState();
		await tap();
		if (read.status === "unreadable") {
			// Unknown cadence. Refreshing nothing is the only answer that neither
			// drifts forever nor bursts every session; the ledger row is what makes
			// the suppressed cadence visible instead of silent.
			releaseReservation();
			recordDegradationOnce({
				kind: "managed-tool-refresh",
				subject: "refresh-state",
				reason: `refresh state unreadable (${read.reason}); skipping refresh this session`,
			});
			logSessionStart(
				`managed-tool-refresh: state unreadable (${read.reason}) — no tool refreshed this session`,
			);
			return { skipped: "state-unreadable", refreshed: [] };
		}

		const stale = selectStaleTools(candidates, read.state, now);
		if (stale.length === 0) {
			releaseReservation();
			return { skipped: "nothing-due", refreshed: [] };
		}

		// Top the reservation up to cover this run's whole walk, in ONE
		// synchronous block, and capture the total LOCALLY.
		//
		// #1746 review round 2 (R2-F1): the loop used to call
		// `reserveManagedToolRefreshSlot` again for each tool after the previous
		// tool's awaited refresh. `handleSessionStart` zeroes the global counter,
		// and a session start landing inside a 120s `npm update` therefore re-armed
		// the budget the running loop was still spending. Each further session
		// start bought the same loop another tool, so a long update plus a few
		// `/new` calls walked the entire 22-tool stale list. A local allowance
		// cannot be re-armed by anyone: a mid-run reset restores the SESSION's
		// right to start a new run, which is correct, without extending this one.
		const stalePackages = new Set<string>();
		const distinctStale = stale.filter((candidate) => {
			if (candidate.strategy !== "npm" || !candidate.packageName) return true;
			if (stalePackages.has(candidate.packageName)) return false;
			stalePackages.add(candidate.packageName);
			return true;
		});
		const want = Math.min(maxPerSession(), distinctStale.length);
		while (held < want && reserveManagedToolRefreshSlot(maxPerSession())) {
			held += 1;
		}
		let allowance = held;

		const refreshed: ManagedToolRefreshResult[] = [];
		for (const candidate of distinctStale) {
			// Once a spawn happens the slot is spent for good — a failing tool must
			// not hand its slot to the next candidate and turn a budget of one into
			// 22 spawns.
			if (allowance <= 0) break;
			allowance -= 1;
			held -= 1;
			try {
				const result = await refreshOne(
					candidate,
					read.state.tools[candidate.toolId],
					now,
				);
				refreshed.push(result);
				if (result.attempted && candidate.coveredToolIds) {
					for (const toolId of candidate.coveredToolIds) {
						if (toolId === candidate.toolId) continue;
						await writeRefreshStamp(toolId, {
							checkedAt: now,
							...(result.currentVersion !== undefined && {
								version: result.currentVersion,
							}),
							...(result.ok ? {} : { failed: true }),
						});
					}
				}
				await tap();
			} catch (err) {
				recordDegradationOnce({
					kind: "managed-tool-refresh",
					subject: candidate.toolId,
					reason: `refresh threw: ${(err as Error).message}`,
				});
			}
		}
		return { refreshed };
	} finally {
		// A throw before any spawn must not leak the reservation.
		releaseReservation();
	}
}
