/**
 * Shared file path utilities for pi-lens
 */

import * as fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { Minimatch, type MinimatchOptions } from "./deps/minimatch.js";
import { detectFileRole } from "./file-role.js";
import { FRESHNESS_CADENCE_MS } from "./freshness-cadence.js";
import {
	isInSpawnTimeoutCooldown,
	noteSpawnTimeout,
} from "./spawn-timeout-cooldown.js";
import {
	collectTrackedFiles,
	getTrackedFilesSnapshot,
} from "./git-tracked-ignore.js";
import {
	getGlobalIgnorePatterns,
	getPiLensGlobalConfigPath,
} from "./lens-config.js";
import {
	homeRelativePath,
	isExternalOrVendorFile,
	isUnderDir,
	isWindowsPath,
	isWithinForm,
	normalizeEphemeralMapKey,
	normalizeFilePath,
	normalizePathSpelling,
	realpathOrResolve,
	relativeInside,
	toPosix,
	toProjectRelativePath,
	walkUpDirs,
} from "./path-utils.js";
import { STAGE_TMP_PATTERN, stagePathFor } from "./atomic-write-staging.js";
import { writeFileAtomic } from "./atomic-write.js";
import {
	findPiLensConfigInDir,
	findPiLensProjectConfig,
	loadPiLensConfigInDir,
	loadPiLensProjectConfig,
} from "./project-lens-config.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import {
	isPiOwnedTempPath,
	isEphemeralCheckoutRoot,
} from "./ephemeral-root.js";
import { getProcessSingleton } from "./process-singletons.js";
import { machineStateDir } from "./probe-home-state.js";

/**
 * Return the directory where pi-lens stores project-specific data
 * (caches, indexes, worklogs, etc.).
 *
 * Default: reuse <project>/.pi-lens if it already exists, otherwise use
 * ~/.pi-lens/projects/<project-slug>
 *
 * Override: set PILENS_DATA_DIR=/some/path — each project gets its own
 * subdirectory named after a sanitized form of its absolute path, e.g.
 *   PILENS_DATA_DIR=~/.pi-lens/projects
 *   → ~/.pi-lens/projects/home-user-myapp-<8-hex-hash>/
 *
 * The name comes from the root's PATH IDENTITY on POSIX (#4689 round 4,
 * maintainer decision 2026-10-21): every caller opens one directory whichever
 * spelling of the root it holds. The host's cwd may be spelled through a
 * link, while dispatch and the runtime hold the realpath. A directory an
 * earlier version named from a link spelling is adopted here, once, by
 * {@link adoptSpelledDataDirs}.
 *
 * Temporary checkouts (#1129 decision B, `isEphemeralCheckoutRoot`: a real
 * git checkout below the host tmpdir, or a directory inside one) keep the
 * same slug under `<base>/.ephemeral/<pid>-<8 hex>/`, a base this process
 * alone owns: normal within the process, never read by another one. The
 * exit hook removes it and the session-start sweep reaps a dead process's.
 * A leading dot keeps the name out of the slug namespace. Either answer is
 * settled once per process per (base, cwd).
 *
 * This keeps project folders clean and avoids creating .pi-lens folders
 * inside user projects.
 */
export function getProjectDataDir(cwd: string): string {
	const legacyProjectDir = path.join(cwd, ".pi-lens");
	const configuredBase = process.env.PILENS_DATA_DIR?.trim();
	const resolvedBase = projectDataBase();
	const memoKey = `${resolvedBase}\0${path.resolve(cwd)}`;
	const cached = settledDataDirs.get(memoKey);
	if (cached !== undefined) return cached;
	if (!configuredBase && fs.existsSync(legacyProjectDir)) {
		return legacyProjectDir;
	}
	const canonical = dataDirCanonicalRoot(cwd);
	const readable = projectDataDirReadableSlug(canonical.root);
	const hash = projectDataDirRootHash(canonical.root);
	const slug = `${readable || "default"}-${hash}`;
	const base = isEphemeralCheckoutRoot(cwd)
		? ephemeralDataBase(resolvedBase)
		: resolvedBase;
	const dir = path.join(base, slug);
	if (base !== resolvedBase && pendingDataDirMigrations.length < 32) {
		pendingDataDirMigrations.push({ to: dir, outcome: "ephemeral" });
	}
	const settled = settleProjectDataDir(
		base,
		readable || "default",
		dir,
		memoKey,
		canonical.fallback,
	);
	// Only into the directory this call settled on: adopting into `dir` while
	// an old-slug directory is still in use would create `dir`, and the next
	// session would prefer it over the old slug's data (#2874 "coexisting").
	if (settled === dir) {
		adoptSpelledDataDirs(path.resolve(cwd), base, dir, readable || "default");
	}
	return settled;
}

/**
 * Entries (files and the directories entered) one source's walk visits at
 * most; the rest stay in the old directory (#4689 r6: directories count, so
 * a tree of empty directories cannot walk without bound).
 */
const ADOPT_MAX_ENTRIES = 4096;

/**
 * The done-marker's name prefix, in the adopting directory, one per source
 * directory (#4689 round 5, N4). Never copied by a walk, so a directory never
 * inherits another source's marker.
 */
const ADOPTED_MARKER_PREFIX = ".adopted-";

/**
 * #4689 round 4: before this change the directory was named from the
 * caller's spelling of the root, so a session rooted at a link stored its
 * data under the link's name. When `spelledRoot` names a directory other
 * than `dir` and that directory exists, every file `dir` lacks is copied
 * into it. A copy never overwrites: it is staged and then hard-linked into
 * place, an exclusive create that cannot tear and that loses to a store's own
 * newer write. The old directory is kept, so a downgrade still reads it.
 * Lock entries and atomic-write stages are not data, so they are skipped.
 * The outcome is queued for the session-start drain (no ledger import here,
 * see `settleProjectDataDir`).
 *
 * Round 5 (N4): the walk runs once per source directory, not once per
 * process. A done-marker written after the walk, whatever each file's
 * outcome, stops every later process from walking again. Without it, a
 * file a store deleted under the real path came back from the kept old
 * directory at the next start (a cleared commit-gate record blocked commits
 * as stale). A crash before the marker leaves none, so the next start
 * resumes the copy-if-missing walk.
 *
 * Round 6 (G1): the link spelling named two shapes over time, the hashed
 * name (v4.2.0 to v4.4.4) and the unhashed one (v4.1.6 and earlier), so
 * both are sources, each with its own marker.
 */
function adoptSpelledDataDirs(
	spelledRoot: string,
	base: string,
	dir: string,
	settledOldSlug: string,
): void {
	const readable = projectDataDirReadableSlug(spelledRoot) || "default";
	// Newest first: copy-if-missing keeps the first source's copy of a file.
	// v4.2.0 to v4.4.4 named the directory `<readable>-<hash>`.
	const sources = [`${readable}-${projectDataDirRootHash(spelledRoot)}`];
	// v4.1.6 and earlier named it `<readable>` alone (#4689 r6 G1). When that
	// is the real root's own unhashed name, `settleProjectDataDir` has
	// already renamed it into `dir`, as on master.
	if (readable !== settledOldSlug) sources.push(readable);
	let copied = 0;
	let failed = 0;
	for (const source of sources) {
		const outcome = adoptSource(base, source, dir);
		copied += outcome.copied;
		failed += outcome.failed;
	}
	if ((copied > 0 || failed > 0) && pendingDataDirMigrations.length < 32) {
		pendingDataDirMigrations.push({
			to: dir,
			outcome: failed > 0 ? "adopt-failed" : "adopted",
		});
	}
}

/**
 * One source directory, walked at most once: its done-marker in `dir` is
 * written after the walk whatever each file's outcome, and checked first.
 * An unwritten marker counts as a failure, since the next start walks again.
 */
function adoptSource(
	base: string,
	source: string,
	dir: string,
): { copied: number; failed: number } {
	const from = path.join(base, source);
	if (from === dir || !isDirectory(from)) return { copied: 0, failed: 0 };
	const marker = path.join(dir, `${ADOPTED_MARKER_PREFIX}${source}`);
	if (fs.existsSync(marker)) return { copied: 0, failed: 0 };
	const { copied, failed } = copyMissingFiles(from, dir);
	return { copied, failed: failed + (markAdopted(marker) ? 0 : 1) };
}

function markAdopted(marker: string): boolean {
	try {
		fs.mkdirSync(path.dirname(marker), { recursive: true });
		writeFileAtomic(marker, "", { bestEffort: false });
		return true;
	} catch {
		// none: the caller records it as adopt-failed; the next start walks again.
		return false;
	}
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		// none: an absent directory is the common answer, nothing to adopt.
		return false;
	}
}

function copyMissingFiles(
	from: string,
	to: string,
): { copied: number; failed: number } {
	let copied = 0;
	let failed = 0;
	let seen = 0;
	const pending = [""];
	while (pending.length > 0) {
		const rel = pending.pop() ?? "";
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(path.join(from, rel), { withFileTypes: true });
		} catch {
			// none: counted into the adoption outcome the session-start drain records.
			failed++;
			continue;
		}
		for (const entry of entries) {
			const name = entry.name;
			if (name.endsWith(".lock") || name.endsWith(".locks")) continue;
			if (STAGE_TMP_PATTERN.test(name)) continue;
			if (name.startsWith(ADOPTED_MARKER_PREFIX)) continue;
			const child = path.join(rel, name);
			if (entry.isDirectory()) {
				if (++seen > ADOPT_MAX_ENTRIES) return { copied, failed: failed + 1 };
				pending.push(child);
				continue;
			}
			if (!entry.isFile()) continue;
			if (++seen > ADOPT_MAX_ENTRIES) return { copied, failed: failed + 1 };
			const outcome = copyIfMissing(
				path.join(from, child),
				path.join(to, child),
			);
			if (outcome === "copied") copied++;
			else if (outcome === "failed") failed++;
		}
	}
	return { copied, failed };
}

function copyIfMissing(
	source: string,
	target: string,
): "copied" | "present" | "failed" {
	// No existence pre-check: `linkSync` refuses a taken name (EEXIST below),
	// which answers the same question without a window between check and create.
	const stage = stagePathFor(target);
	// The stage is removed only once its parent is known to be a directory:
	// removing it under a parent that is a file throws ENOTDIR.
	let staged = false;
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		staged = true;
		fs.copyFileSync(source, stage);
		fs.linkSync(stage, target);
		return "copied";
	} catch (cause) {
		// none: EEXIST from `linkSync` (the parent is known to be a directory)
		// is a name already taken, by a concurrent adopter or by anything else
		// at the target, which wins as `existsSync` would have; any other errno
		// is counted into the outcome the session-start drain records. An
		// EEXIST from `mkdirSync` (a file where a directory is needed) fails.
		return staged && (cause as NodeJS.ErrnoException).code === "EEXIST"
			? "present"
			: "failed";
	} finally {
		if (staged) fs.rmSync(stage, { force: true });
	}
}

function projectDataBase(): string {
	const configuredBase = process.env.PILENS_DATA_DIR?.trim();
	return configuredBase || path.join(getGlobalPiLensDir(), "projects");
}

const EPHEMERAL_DATA_DIR_NAME = ".ephemeral";
const EPHEMERAL_TOKEN_PATTERN = /^(\d+)-[0-9a-f]{8}$/;

/**
 * The one token per process (a process singleton, so every module copy hands
 * out the same dir). The random half keeps a reused pid from inheriting a
 * dead process's leftovers before the sweep reaps them.
 */
function ephemeralDataToken(): { token: string; exitHook: boolean } {
	return getProcessSingleton("project-data-ephemeral-token", 1, () => ({
		token: `${process.pid}-${randomBytes(4).toString("hex")}`,
		exitHook: false,
	}));
}

function ephemeralDataBase(resolvedBase: string): string {
	const state = ephemeralDataToken();
	if (!state.exitHook) {
		state.exitHook = true;
		process.once("exit", removeEphemeralDataDirs);
	}
	return path.join(resolvedBase, EPHEMERAL_DATA_DIR_NAME, state.token);
}

/**
 * The exit hook: remove this process's ephemeral base. Best-effort and total.
 * An exit-time writer registered later can still recreate an entry; the
 * session-start sweep removes it once this pid is dead.
 */
export function removeEphemeralDataDirs(): void {
	const dir = path.join(
		projectDataBase(),
		EPHEMERAL_DATA_DIR_NAME,
		ephemeralDataToken().token,
	);
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// Left for the next session-start sweep.
	}
}

/**
 * Reap the ephemeral bases of dead processes under the configured data base.
 * Reads at most `maxEntries` entries; touches only directories named
 * `<pid>-<8 hex>` whose pid `isPidAlive` reports dead. A reused live pid keeps
 * its dead predecessor's dir until that pid dies too: the safe direction.
 * Returns the number of directories removed.
 */
export async function sweepDeadEphemeralDataDirs(options: {
	isPidAlive: (pid: number) => boolean;
	maxEntries?: number;
}): Promise<number> {
	const parent = path.join(projectDataBase(), EPHEMERAL_DATA_DIR_NAME);
	let handle: fs.Dir;
	try {
		handle = await fs.promises.opendir(parent);
	} catch {
		return 0;
	}
	let removed = 0;
	try {
		for (let i = 0; i < (options.maxEntries ?? 512); i++) {
			const entry = await handle.read();
			if (entry === null) break;
			const pid = entry.isDirectory()
				? EPHEMERAL_TOKEN_PATTERN.exec(entry.name)?.[1]
				: undefined;
			if (pid === undefined || options.isPidAlive(Number(pid))) continue;
			try {
				await fs.promises.rm(path.join(parent, entry.name), {
					recursive: true,
					force: true,
				});
				removed++;
			} catch {
				// Left for the next sweep.
			}
		}
	} catch {
		// Best-effort directory scan.
	} finally {
		await handle.close().catch(() => {});
	}
	return removed;
}

/**
 * The human-readable half of the project data-dir slug: the absolute root
 * with separators folded to dashes and anything else stripped.
 *
 * #2874: this form ALONE is not an identity — `src/pi-lens` and
 * `src/pi/lens` fold to the same string. It is only ever combined with
 * {@link projectDataDirRootHash}. Never use it as a directory name alone.
 *
 * Both halves come from one root: since #4689 round 4 its path identity
 * ({@link dataDirCanonicalRoot}). The readable half is `normalizePathSpelling`
 * of that root, the form `normalizeFilePath` returned before #4689, so a
 * root with no link keeps the name every earlier version wrote. A root
 * reached through a link moves to its real path's name, and its old
 * directory is adopted (#4689 review r1 F2 decided "no migration"; the
 * maintainer reversed that on 2026-10-21).
 */
function projectDataDirReadableSlug(canonicalRoot: string): string {
	const normalized = normalizePathSpelling(canonicalRoot);
	return normalized
		.replace(/^[a-z]:/i, "") // strip Windows drive letter
		.replace(/\/+/g, "-") // separators → dashes
		.replace(/[^A-Za-z0-9-]/g, "") // strip anything else
		.replace(/^-+/, "") // trim leading dashes
		.replace(/-+$/, ""); // trim trailing dashes
}

/**
 * The canonical root for both slug halves: on POSIX the root's path identity
 * (`realpathOrResolve`, the kernel-real path of the root or of its nearest
 * existing ancestor plus the missing tail), so a root that does not exist yet
 * names the directory it will have once created. On win32 it stays the
 * resolved path, as in every earlier version: a win32 name has never followed
 * the realpath, and changing it would rename directories for 8.3, junction
 * and casing spellings alike. `fallback` is true when the root is not on disk
 * (yet) or cannot be reached, and the name then rests on the nearest existing
 * ancestor. The hash is the first 8 hex chars of SHA-256 over the
 * root. A collision needs the same readable slug and the same 32-bit prefix,
 * so the practical collision population is readable-slug twin pairs.
 */
export function dataDirCanonicalRoot(
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): {
	root: string;
	fallback: boolean;
} {
	const resolved = path.resolve(cwd);
	const root = platform === "win32" ? resolved : realpathOrResolve(resolved);
	// Best-effort: the root may not exist yet. Existence is all the old
	// `realpathSync` probe's throw ever answered, and `existsSync` answers it
	// without a second identity walk (#4689 batch 8).
	return { root, fallback: !fs.existsSync(resolved) };
}

function projectDataDirRootHash(canonicalRoot: string): string {
	return createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 8);
}

export interface ProjectDataDirMigration {
	/** The hashed-slug directory derived for the root. */
	to: string;
	/**
	 * The bounded outcome that the session-start drain renders. `ephemeral`
	 * (#1129) is not a migration: the root got a process-owned dir instead.
	 */
	outcome:
		| "renamed"
		| "coexisting"
		| "rename-failed"
		| "identity-fallback"
		| "ephemeral"
		/** #4689 r4: files stored under the root's link spelling were copied. */
		| "adopted"
		/** #4689 r4: some of them could not be copied and stay where they were. */
		| "adopt-failed";
}

const pendingDataDirMigrations: ProjectDataDirMigration[] = [];
const settledDataDirs = new Map<string, string>();

export function resetProjectDataDirSessionState(): void {
	pendingDataDirMigrations.splice(0);
}

/**
 * One-time upgrade from a pre-#2874 slug directory to its hashed name.
 * When the old directory exists and the new one does not, the state moves
 * with one atomic `renameSync` (same parent, so same filesystem). When both
 * exist the new one wins and nothing moves. Either case queues one
 * {@link ProjectDataDirMigration} for the session-start drain, which emits
 * the `data_dir_migrated` record. Best-effort throughout: on any failure the
 * caller gets the pre-existing directory and behavior is unchanged.
 *
 * No ledger import here on purpose: `probe-home-state.ts` documents that a
 * direct edge between this module and `degradation-ledger.ts` in either
 * direction adds `no-client-cycles` violations, so the record is emitted by
 * the drain site in `runtime-session.ts` instead.
 */
function settleProjectDataDir(
	base: string,
	oldSlug: string,
	dir: string,
	memoKey: string,
	identityFallback: boolean,
): string {
	const oldDir = path.join(base, oldSlug);
	const newExists = fs.existsSync(dir);
	const oldExists = fs.existsSync(oldDir);
	if (!oldExists) {
		if (identityFallback && pendingDataDirMigrations.length < 32) {
			pendingDataDirMigrations.push({
				to: dir,
				outcome: "identity-fallback",
			});
		}
		// Steady state: nothing to migrate from.
		settledDataDirs.set(memoKey, dir);
		return dir;
	}
	if (!newExists) {
		try {
			fs.renameSync(oldDir, dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				if (fs.existsSync(dir)) {
					settledDataDirs.set(memoKey, dir);
					return dir;
				}
				if (fs.existsSync(oldDir)) return oldDir;
				return dir;
			}
			// Best-effort: retain the old directory and publish one bounded
			// failure notice for this process's memo key.
			if (pendingDataDirMigrations.length < 32) {
				pendingDataDirMigrations.push({
					to: dir,
					outcome: "rename-failed",
				});
			}
			settledDataDirs.set(memoKey, oldDir);
			return oldDir;
		}
	}
	// Either the rename just moved the state, or both directories already
	// existed and the new one wins. Queue one migration for the drain.
	settledDataDirs.set(memoKey, dir);
	if (pendingDataDirMigrations.length < 32) {
		pendingDataDirMigrations.push({
			to: dir,
			outcome: newExists ? "coexisting" : "renamed",
		});
	}
	return dir;
}

/**
 * Drain the queued {@link ProjectDataDirMigration}s, clearing the queue.
 * Called once per session start by `handleSessionStart`; each queued outcome is
 * therefore recorded at most once per session. Test-only callers must not rely
 * on queue depth across drains.
 */
export function drainProjectDataDirMigrations(): ProjectDataDirMigration[] {
	return pendingDataDirMigrations.splice(0);
}

/**
 * Test-only reset for the settled-directory memo. The memo is a pure
 * performance cache (one `existsSync` pair saved per latched directory), so
 * clearing it changes no observable behavior — it lets a test stage an
 * old-slug directory AFTER learning the new name, then resolve again.
 */
export function _resetProjectDataDirMemoForTests(): void {
	settledDataDirs.clear();
}

/**
 * The project-data path to SHOW an agent or a human, for a file that
 * {@link getProjectDataDir} owns.
 *
 * #2521: the turn-end actionable-warnings advisory told the agent to read a
 * hardcoded `.pi-lens/cache/actionable-warnings.json`, but that spelling is
 * only correct in the LEGACY arm of `getProjectDataDir` — a project with no
 * `.pi-lens/` directory (the common case) stores the report under
 * `~/.pi-lens/projects/<slug>/cache/`, and a `PILENS_DATA_DIR` project stores
 * it somewhere else again. Agents followed the advisory literally and got
 * `cat: .pi-lens/cache/actionable-warnings.json: No such file or directory`.
 *
 * Any instructional string that NAMES a project-data location must be built
 * here, so the displayed path and the written path can never disagree. Guarded
 * by `tests/clients/data-dir-display-path-sweep.test.ts`.
 *
 * Two output shapes, matching `toRunnerDisplayPath`'s convention
 * (`clients/dispatch/runner-context.ts`) so one advisory never mixes styles:
 *   - under `cwd` → a `/`-separated path relative to it
 *     (`.pi-lens/cache/actionable-warnings.json`), which is what the legacy
 *     arm produces and what an agent can paste straight into a shell.
 *   - anywhere else → absolute, `/`-separated, and `~`-folded via
 *     {@link homeRelativePath} so the default `~/.pi-lens/projects/...` store
 *     does not leak the account name into agent context (#2440 F5).
 *
 * String work on top of `getProjectDataDir`'s own resolution. Since #4101,
 * `toProjectRelativePath` retries canonically (a stat) only when the lexical
 * test says the target is outside the root; that retry tolerates a missing
 * path, so this stays safe for a file that has not been written yet and does
 * not throw on a surface whose whole job is to render a hint.
 *
 * The relative-or-absolute decision reuses `toProjectRelativePath`
 * (`clients/path-utils.ts`) — the same shape-aware primitive (lexical first,
 * a canonical retry only on a lexical miss, #4101)
 * `toRunnerDisplayPath` (`clients/dispatch/runner-context.ts`) composes for
 * the analogous "relative path if under this root, else something else"
 * decision — rather than a second hand-rolled `path.relative` fold. It is NOT
 * `toRunnerDisplayPath` itself: that helper routes its result through
 * `normalizeMapKey`, which on win32 calls `realpathSync.native()` (or, for a
 * not-yet-existing path, lowercases the unresolved tail) — exactly the
 * stat-and-mutate-casing behavior this function's contract above rules out.
 */
export function displayProjectDataPath(
	cwd: string,
	...segments: string[]
): string {
	const absolute = path.resolve(getProjectDataDir(cwd), ...segments);
	const absolutePosix = toPosix(absolute);
	const relative = toProjectRelativePath(absolute, cwd);
	if (relative !== absolutePosix) {
		return relative;
	}
	// `toProjectRelativePath` fell back to the (posix-ified) absolute path —
	// `absolute` is not under `cwd`. Fold `~` so the default
	// `~/.pi-lens/projects/...` store does not leak the account name into
	// agent context (#2440 F5). Posix-ify BEFORE the fold: `homeRelativePath`
	// deliberately returns a path that is not under `$HOME` unchanged,
	// separators included, so a `PILENS_DATA_DIR=D:\lens-data` store would
	// otherwise render with backslashes while the legacy arm above renders
	// with forward ones — `absolutePosix` is already folded, so this is a
	// no-op fold, not a second one.
	return homeRelativePath(absolutePosix);
}

/**
 * Machine-global pi-lens directory: `~/.pi-lens/` by default.
 *
 * Used for tool binaries (`~/.pi-lens/tools/`, `~/.pi-lens/bin/`), the
 * cross-process instance registry (`instances.json`, #449/#525) and the
 * orphan-backstop lease beside it, the auto-install probe cache, the
 * canonical global config (`config.json`), LSP server storage (intelephense's
 * index, PSES's per-PID session dir) and JVM runtimes — state that is
 * intentionally NOT project-scoped, because it spans every project pi-lens
 * has touched.
 *
 * Override: set `PI_LENS_HOME=/some/path` to relocate this ENTIRE root (every
 * caller routes through this one function, so one env var covers all of
 * them — see #525). Tests MUST set this to a per-worker temp dir in
 * `tests/support/vitest-setup.ts` rather than mocking each caller separately;
 * otherwise a test that exercises `registerInstance`/`sweepOrphans` or any
 * logger writes into the developer's REAL `~/.pi-lens` (dogfooded live: a
 * test-fixture instance survived in the real `instances.json` for 17h).
 *
 * DELIBERATELY cwd-INDEPENDENT (#2506 round 3). Its sibling
 * `getGlobalPiLensLogDir()` (`probe-home-state.ts`) carries the probe-home
 * redirect; this one must not, because the things resolved here are shared
 * machine state a session needs to KEEP: a pi session running from an agent
 * worktree or a throwaway temp project must still find the tools it already
 * installed and must still register in the one `instances.json` every other
 * pi-lens process on the box reads. Redirecting THIS function (as round 2 of
 * #2506 did) would silently give every worktree its own empty tool tree and
 * its own private registry, so the reaper could never see across them — a
 * worse defect than the telemetry pollution the redirect exists to stop.
 *
 * Distinct from `getProjectDataDir(cwd)`, which respects `PILENS_DATA_DIR`
 * (project-scoped) and produces per-project subdirectories. Callers writing
 * project caches, snapshots, or worklogs should use `getProjectDataDir(cwd)`
 * instead — `PI_LENS_HOME` is the MACHINE-scoped sibling of that override.
 * `getProjectDataDir` composes through THIS function, not the log one: a
 * probe's project caches are already isolated by its own path slug, and a
 * worktree session keeping its warm caches is the same "do not break the
 * session" argument as the tools above.
 */
export function getGlobalPiLensDir(): string {
	return machineStateDir();
}

/**
 * True for pi/pi-lens-owned files that can arrive at the tool-result seam
 * from outside the session root. These are housekeeping writes, not project
 * edits for which the actionable outside-root notice is useful.
 */
export function isPiLensInternalPath(
	filePath: string,
	projectRoot: string,
): boolean {
	const absolute = path.resolve(filePath);
	const home = path.resolve(os.homedir());
	const candidates = [
		getGlobalPiLensDir(),
		getProjectDataDir(projectRoot),
		path.join(home, ".pi"),
		path.join(home, ".pi-lens"),
	];
	if (candidates.some((dir) => isUnderDir(absolute, dir))) return true;
	if (isPiOwnedTempPath(absolute)) return true;
	return false;
}

/**
 * Directories to exclude from all scans (build outputs, dependencies, caches).
 * Used consistently across all scanners to avoid noise from generated files.
 */
export const EXCLUDED_DIRS = [
	"node_modules",
	".git",
	"dist",
	"build",
	".turbo",
	".cache",
	"target",
	"out",
	".parcel-cache",
	".svelte-kit",
	".nuxt",
	".yarn",
	".pnpm-store",
	".gradle",
	".next",
	".pi-lens",
	".pi", // pi agent directory
	// The SAME agent, rebranded: pi derives its config-dir name as
	// `pkg.piConfig?.configDir || ".pi"` (pi-coding-agent 0.85.1,
	// `dist/bundle/chunks/chunk-JVUZSMYM.js`), so a redistribution spells its
	// `<configDir>/agent/sessions` history `.omp/agent/sessions` instead.
	// #3112: a project-local one was walked entry-by-entry and spent the whole
	// startup-scan entry budget, so a five-file project reported
	// `too-many-entries` and never warmed its caches.
	".omp",
	".ruff_cache", // Python linter cache
	".worktrees",
	".claude",
	".codex",
	".rescue",
	".agents",
	".gstack",
	".superpowers",
	".guardrails",
	".playwright-cli",
	".playwright-mcp",
	".vscode",
	"venv",
	".venv",
	"coverage",
	"__pycache__",
	".tox",
	".pytest_cache",
	"*.dSYM",
	// Vendored upstream source conventions — universally too large to scan
	"vendor", // Go modules, PHP Composer, Ruby Bundler
	"third_party", // Chromium/Google convention (llama.cpp, sherpa-onnx, gRPC, TF)
	"third-party",
	"vendors",
];

/**
 * Which layer produced a pattern, per #703's layer-semantics fix. Precedence
 * (lowest → highest) is `global` → `gitignore` → `pilens` — see
 * `createProjectIgnoreMatcher`'s ordering comment. The layer determines
 * whether a winning positive match is subject to git's "a tracked file is
 * never ignored" rule:
 *   - `global` / `gitignore` emulate git itself, so they inherit that rule —
 *     a winning match from either NEVER excludes a file git tracks.
 *   - `pilens` (`.pi-lens.json`'s `ignore` field) is pi-lens-native user
 *     intent ("don't analyze this"), not a git emulation, so it excludes
 *     regardless of tracked status.
 *
 * `pilens` patterns can come from the root `.pi-lens.json` (loaded once at
 * matcher-construction time in `createProjectIgnoreMatcher`) OR from a
 * package-local `.pi-lens.json` layered in per ancestor directory by
 * `buildProjectIgnoreMatcher`'s `patternsForDir` (#783) — both are tagged
 * `"pilens"` and share the same tracked-file-rescue exemption.
 */
type GitignorePatternLayer = "global" | "gitignore" | "pilens";

interface GitignorePattern {
	pattern: string;
	negated: boolean;
	directoryOnly: boolean;
	rooted: boolean;
	hasSlash: boolean;
	layer: GitignorePatternLayer;
}

export interface ProjectIgnoreMatcher {
	rootDir: string;
	patterns: GitignorePattern[];
	/** Drops path verdicts below a changed nested `.gitignore`. */
	invalidateSubtree(subtree: string): void;
	isIgnored(filePath: string, isDirectory?: boolean): boolean;
	/**
	 * Primes the tracked-files set for `rootDir` (async `git ls-files`,
	 * memoized — see `git-tracked-ignore.ts`) so subsequent synchronous
	 * `isIgnored` calls in the SAME walk can honor #703's tracked-aware
	 * layer semantics. Callers with an async walk loop should await this
	 * ONCE before the loop starts, not per file. Fail-open: resolves even
	 * when git is absent/fails/times out (tracked-check then silently stays
	 * unavailable and `isIgnored` degrades to today's pattern-only
	 * behavior). Sync callers that never call this simply never prime — that
	 * degrade-to-pattern-only is intended, not a bug.
	 */
	ensureTrackedIndex(): Promise<void>;
}

interface IgnoreSource {
	path: string;
	mtimeMs: number;
	size: number;
}

type ProjectIgnoreMatcherWithFreshness = ProjectIgnoreMatcher & {
	getConsumedIgnoreSources(): readonly IgnoreSource[];
	refreshConsumedIgnoreSource(filePath: string): void;
};

function resolveGitIgnoreRoot(startDir: string): string {
	// #4689: the walk climbs the directory's path identity, so a link spelling
	// of a project (or a link into one of its subdirectories) reaches the same
	// `.git` and the same matcher as the real path. Every ignore verdict and
	// cache key below is taken against this identity root.
	for (const current of walkUpDirs(startDir)) {
		if (fs.existsSync(path.join(current, ".git"))) return current;
	}
	return realpathOrResolve(startDir);
}

function collapseSlashes(value: string): string {
	let out = "";
	let previousWasSlash = false;
	for (const ch of value) {
		if (ch === "/") {
			if (!previousWasSlash) out += ch;
			previousWasSlash = true;
			continue;
		}
		out += ch === "\\" ? "/" : ch;
		previousWasSlash = false;
	}
	return out;
}

function stripLeadingDotSlash(value: string): string {
	return value.startsWith("./") ? value.slice(2) : value;
}

function stripTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === "/") end -= 1;
	return value.slice(0, end);
}

function stripLeadingSlashes(value: string): string {
	let start = 0;
	while (start < value.length && value[start] === "/") start += 1;
	return value.slice(start);
}

function normalizeIgnorePath(value: string): string {
	return collapseSlashes(stripLeadingDotSlash(value));
}

function stripTrailingSpaces(value: string): string {
	// Good-enough gitignore whitespace handling: unescaped trailing spaces are ignored.
	let end = value.length;
	while (end > 0 && value[end - 1] === " " && value[end - 2] !== "\\") end -= 1;
	return value.slice(0, end).replace(/\\ /g, " ");
}

function parseGitignoreContent(
	content: string,
	layer: GitignorePatternLayer,
): GitignorePattern[] {
	const patterns: GitignorePattern[] = [];
	for (const rawLine of content.split(/\r?\n/)) {
		let line = stripTrailingSpaces(rawLine.trimStart());
		if (!line || line.startsWith("#")) continue;
		let negated = false;
		if (line.startsWith("!")) {
			negated = true;
			line = line.slice(1);
		}
		line = normalizeIgnorePath(line);
		if (!line) continue;

		const directoryOnly = line.endsWith("/");
		if (directoryOnly) line = stripTrailingSlashes(line);
		const rooted = line.startsWith("/");
		if (rooted) line = stripLeadingSlashes(line);
		if (!line) continue;

		patterns.push({
			pattern: line,
			negated,
			directoryOnly,
			rooted,
			hasSlash: line.includes("/"),
			layer,
		});
	}
	return patterns;
}

function expandGitignorePattern(pattern: GitignorePattern): string[] {
	const body = pattern.pattern;
	if (pattern.directoryOnly) {
		if (pattern.rooted || pattern.hasSlash) return [body, `${body}/**`];
		return [body, `${body}/**`, `**/${body}`, `**/${body}/**`];
	}
	if (pattern.rooted || pattern.hasSlash) return [body];
	return [body, `**/${body}`];
}

function matchesGitignorePattern(
	pattern: GitignorePattern,
	relativePath: string,
	isDirectory: boolean,
	matchExpanded: (value: string, expanded: string) => boolean,
): boolean {
	const candidate = stripLeadingSlashes(normalizeIgnorePath(relativePath));
	if (!candidate) return false;
	const candidates = isDirectory ? [candidate, `${candidate}/`] : [candidate];
	return expandGitignorePattern(pattern).some((expanded) => {
		if (isDirectory && expanded.endsWith("/**")) {
			const prefix = expanded.slice(0, -3);
			if (candidate === prefix || candidate.startsWith(`${prefix}/`))
				return true;
		}
		return candidates.some((value) => matchExpanded(value, expanded));
	});
}

/**
 * The pattern that decides `relativePath` among `patterns`: gitignore order,
 * so the LAST match wins and a later `!` pattern lifts an earlier ignore.
 */
function lastMatchingPattern(
	patterns: readonly GitignorePattern[],
	relativePath: string,
	isDirectory: boolean,
	matchExpanded: (value: string, expanded: string) => boolean,
): GitignorePattern | undefined {
	let winner: GitignorePattern | undefined;
	for (const pattern of patterns) {
		if (
			matchesGitignorePattern(pattern, relativePath, isDirectory, matchExpanded)
		)
			winner = pattern;
	}
	return winner;
}

/**
 * Glob options and a compile-once matcher shared by every gitignore pattern
 * match: the project ignore matcher below (one per matcher instance, so the
 * instance lifetime bounds the cache) and {@link isIgnoredByGitignoreLines}
 * (one per call).
 */
const gitignoreGlobOptions: MinimatchOptions = {
	dot: true,
	nocase: process.platform === "win32",
};

function createExpandedGlobMatcher(): (
	value: string,
	expanded: string,
) => boolean {
	const compiledGlobs = new Map<string, Minimatch>();
	return (value, expanded) => {
		let compiled = compiledGlobs.get(expanded);
		if (compiled === undefined) {
			compiled = new Minimatch(expanded, gitignoreGlobOptions);
			compiledGlobs.set(expanded, compiled);
		}
		return compiled.match(value);
	};
}

/**
 * Whether `filePath` is ignored by `lines`, read as the `ignore` field reads
 * them (#783): each line is parsed as a `.gitignore` line anchored to
 * `baseDir` (a leading `/` roots it there, a slashless line matches below it
 * at any depth), and the LAST line that matches decides, so `!` re-includes.
 * A file outside `baseDir` is never ignored (a `../` escape matches nothing),
 * and a file the lines never name is not. This is the one gitignore evaluator
 * `rules.<id>.ignorePaths` (#5029) shares with {@link createProjectIgnoreMatcher}:
 * both resolve a pattern list through `lastMatchingPattern`.
 */
export function isIgnoredByGitignoreLines(
	lines: readonly string[],
	baseDir: string,
	filePath: string,
	isDirectory = false,
): boolean {
	const relative = relativeInside(baseDir, filePath);
	if (relative === undefined) return false;
	const winner = lastMatchingPattern(
		parseGitignoreContent(lines.join("\n"), "pilens"),
		normalizeIgnorePath(relative),
		isDirectory,
		createExpandedGlobMatcher(),
	);
	return winner !== undefined && !winner.negated;
}

function readGitignorePatterns(
	rootDir: string,
	layer: GitignorePatternLayer = "gitignore",
): GitignorePattern[] {
	const gitignorePath = path.join(rootDir, ".gitignore");
	try {
		return parseGitignoreContent(
			fs.readFileSync(gitignorePath, "utf-8"),
			layer,
		);
	} catch {
		return [];
	}
}

/**
 * Fold one value onto the form {@link isWithinForm} compares on. A
 * Windows-shaped value folds its separators AND its case, because win32
 * compares both that way; a POSIX value is already the form the caller holds.
 *
 * `isWindowsPath` owns "is this value Windows-shaped", and the SHAPE selects
 * the fold, not the host (AGENTS shapes 2 and 35): a POSIX filename may
 * legally contain a backslash, so folding separators unconditionally turned a
 * sibling directory literally named `<root>\outside` into the child
 * `<root>/outside` of the root (#4876 review r2 F1). `path.win32.relative` —
 * the predicate this batch replaced — folded exactly these two axes on win32
 * and neither on POSIX.
 */
function containmentForm(value: string): string {
	return isWindowsPath(value) ? toPosix(value).toLowerCase() : value;
}

/**
 * `child` at or under `parent`, after folding both sides onto ONE containment
 * form. The one form is the point: `isWithinForm` asks callers to fold both
 * sides "the same way", and this is that way (#4876 review r2 F1/F4).
 */
export function isWithinPathForm(child: string, parent: string): boolean {
	return isWithinForm(containmentForm(child), containmentForm(parent));
}

function ancestorDirsBetween(rootDir: string, targetDir: string): string[] {
	// #4689 batch 7: containment is the owner predicate on one path form. The
	// hand-rolled `path.relative` test read a directory named `..foo` as outside
	// the root (its relative path begins with `..`), so its patterns never ran.
	if (!isWithinPathForm(targetDir, rootDir)) return [];
	const relative = path.relative(rootDir, targetDir);
	const dirs = [rootDir];
	if (!relative) return dirs;
	let current = rootDir;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		dirs.push(current);
	}
	return dirs;
}

function buildProjectIgnoreMatcher(
	resolvedRoot: string,
	patterns: GitignorePattern[],
): ProjectIgnoreMatcherWithFreshness {
	const consumedIgnoreSources = new Map<string, IgnoreSource>();
	// `signature` lets a caller that already statted the file reuse that one
	// stat (#2016's class on this seam: never re-derive a value you just
	// computed). Callers with no signature in hand still pay their own stat.
	const rememberIgnoreSource = (
		filePath: string,
		signature: FreshnessSignature = fileFreshnessSignature(filePath),
	): void => {
		consumedIgnoreSources.set(filePath, { path: filePath, ...signature });
	};
	rememberIgnoreSource(path.join(resolvedRoot, ".gitignore"));
	const nestedCache = new Map<
		string,
		{
			/**
			 * #2071: the ONE clock this directory's ignore rules and every path
			 * verdict derived from them share. Inside the window neither is
			 * re-checked, so two paths under the same rule cannot disagree.
			 */
			checkedAtMs: number;
			gitignoreMtimeMs: number;
			gitignoreSize: number;
			pilensMtimeMs: number;
			pilensSize: number;
			patterns: GitignorePattern[];
		}
	>();
	// #783: layer a NESTED `.pi-lens.json`'s `ignore` field the same way a
	// nested `.gitignore` is already layered — each ancestor directory between
	// `resolvedRoot` and the target is checked for its OWN config file (no
	// upward walk; `findPiLensConfigInDir`/`loadPiLensConfigInDir` look only
	// directly in `dir`), and its `ignore` patterns are anchored to `dir` (same
	// anchoring semantics as a `.gitignore` living in that directory) and
	// tagged `"pilens"` so #703's tracked-file-rescue rule still skips them.
	// `loadPiLensConfigInDir` reuses `project-lens-config.ts`'s own
	// path+mtime cache, so this never re-reads/re-parses JSON that some other
	// caller (or the root-config lookup above) already loaded.
	const patternsForDir = (dir: string): GitignorePattern[] => {
		if (dir === resolvedRoot) return patterns;
		const cached = nestedCache.get(dir);
		const now = Date.now();
		// #2071: inside the cadence window this directory's rules are frozen, so
		// no stat runs and every verdict already memoized under `dir` stays
		// derivable from exactly these patterns. Before this gate the freshness
		// check ran per call while `patternMemo` did not, which is what let a
		// fresh path and a memoized path in the same directory return opposite
		// verdicts for the same rule. Externally edited nested sources are
		// therefore picked up within PROJECT_IGNORE_FRESHNESS_CADENCE_MS, the
		// same bound #2159 already accepted for the root sources.
		// pi-authored `.gitignore` writes keep their instant path through
		// `invalidateProjectIgnoreMatcherForPath`.
		if (
			cached !== undefined &&
			now - cached.checkedAtMs < PROJECT_IGNORE_FRESHNESS_CADENCE_MS
		) {
			return cached.patterns;
		}
		const gitignoreSig = gitignoreSignature(dir);
		// One stat, two consumers. `rememberIgnoreSource` used to stat the same
		// file a second time on the line below this one.
		rememberIgnoreSource(path.join(dir, ".gitignore"), gitignoreSig);
		// #1105: gate on size too. `findPiLensConfigInDir` returns `size` alongside
		// `mtimeMs` (both from one stat), and `gitignoreSignature` reads both for
		// the nested `.gitignore`, so an mtime-preserving, length-changing edit to
		// EITHER nested source can no longer replay stale patterns for this subtree.
		const pilensInfo = findPiLensConfigInDir(dir);
		const pilensMtime = pilensInfo?.mtimeMs ?? -1;
		const pilensSize = pilensInfo?.size ?? -1;
		if (
			cached?.gitignoreMtimeMs === gitignoreSig.mtimeMs &&
			cached?.gitignoreSize === gitignoreSig.size &&
			cached?.pilensMtimeMs === pilensMtime &&
			cached?.pilensSize === pilensSize
		) {
			// Unchanged: re-arm the shared clock so the next window is measured
			// from this check, not from the build that first populated the entry.
			cached.checkedAtMs = now;
			return cached.patterns;
		}
		const nestedConfig = loadPiLensConfigInDir(dir);
		const nextPatterns = [
			...readGitignorePatterns(dir),
			...parseGitignoreContent(nestedConfig.ignore.join("\n"), "pilens"),
		];
		nestedCache.set(dir, {
			checkedAtMs: now,
			gitignoreMtimeMs: gitignoreSig.mtimeMs,
			gitignoreSize: gitignoreSig.size,
			pilensMtimeMs: pilensMtime,
			pilensSize: pilensSize,
			patterns: nextPatterns,
		});
		// #2071: drift is the SINGLE trigger. The rules under `dir` just changed,
		// so every verdict computed under the superseded rules dies in the same
		// step that supersedes them. `cached === undefined` is a first build, not
		// a change, and has no verdicts to drop.
		if (cached !== undefined) dropVerdictsUnder(dir);
		return nextPatterns;
	};

	// Per-matcher path → pattern-verdict memo. The matcher itself is cached by
	// `getProjectIgnoreMatcher` keyed on `.gitignore` size+mtime (#1105), so this
	// Map's lifetime is bounded to a single set of ignore rules — when any
	// `.gitignore` changes, the matcher is rebuilt and the memo is dropped
	// with it. Without this memo, every background scan (comment scan, knip,
	// jscpd, call-graph, source-filter, pipeline) recomputes O(ancestorDirs ×
	// patterns) per file, multiplying into 2-3s of pure CPU on a 2k-file
	// project. With it, the second visitor of the same path is O(1).
	//
	// #703: this memoizes only the PATTERN verdict (which is deterministic —
	// it never changes for a given matcher instance), NOT the tracked-aware
	// final verdict. The tracked-files set can transition from "not yet
	// primed" to "primed" mid-process (a walker calls `ensureTrackedIndex()`
	// partway through the matcher's lifetime), so baking the tracked check
	// into this memo would let an early, pre-priming call poison every later
	// lookup of the same path for this matcher's entire cache lifetime. The
	// tracked-set lookup itself is a cheap Set#has over syntactically-folded
	// keys (see `isTrackedAndRescued` — no `realpathSync` anywhere in this
	// function), and — critically — it's only ever paid for paths a pattern
	// already flagged as ignored, so it doesn't reintroduce the per-file cost
	// this memo exists to avoid for the common (not-ignored) case.
	const patternMemo = new Map<
		string,
		{ ignored: boolean; layer: GitignorePatternLayer | undefined }
	>();
	/**
	 * Drop every memoized verdict at or below `subtree`, leaving `nestedCache`
	 * alone. `patternsForDir` calls this the moment it rebuilds a directory's
	 * patterns, which is why it must NOT evict the entry that rebuild just
	 * wrote. `invalidateSubtree` layers the eviction on top for the write-hook
	 * path, where the caller knows the source changed but has not re-read it.
	 */
	function dropVerdictsUnder(subtree: string): void {
		// #4689 batch 7: the owner's containment predicate, on one path form. A
		// verdict for a file under a directory named `..foo` has a relative path
		// that begins with `..`, and the hand-rolled test kept it (#4861 F2).
		const subtreeForm = path.resolve(subtree);
		for (const key of patternMemo.keys()) {
			const memoPath = key.slice(2);
			if (isWithinPathForm(memoPath, subtreeForm)) {
				patternMemo.delete(key);
			}
		}
	}
	// #4689: `resolvedRoot` is the root's path identity, so a path spelled
	// through another name for the project (a link to the root, a link into it)
	// reads as outside the root by text. `isIgnored` answers such a path by
	// the identity of its directory (a file keeps its own name, which is its
	// tree path), so every spelling of one file shares one memo key, one set of
	// nested-rule directories and one tracked-set key. Directory identities are
	// taken once per directory: a walk through a link spelling pays one
	// `realpath` per directory, not per file.
	const dirIdentities = new Map<string, string>();
	const identityOfDir = (dir: string): string => {
		let identity = dirIdentities.get(dir);
		if (identity === undefined) {
			identity = realpathOrResolve(dir);
			dirIdentities.set(dir, identity);
		}
		return identity;
	};
	/**
	 * Does this caller spelling hold a `.` or `..` segment? Only such a spelling
	 * has to be resolved by the KERNEL: `path.resolve` folds a dot segment
	 * lexically, so a `..` after a directory link names a directory that never
	 * existed (#4876 review r2 F2). The pattern reads the same separator set as
	 * `splitPathSegments` on every platform (a `\` separates, so on POSIX a
	 * filename containing one reads as several segments: such a name pays one
	 * directory read, never a wrong verdict), and it is one regex rather than a
	 * split + filter + some because this runs on EVERY `isIgnored` call: 46-49 ns
	 * per call against the split's 230-240 ns (review r3 F3; the command and its
	 * output are in the PR body under `## Blast radius`).
	 */
	const hasDotSegment = (spelling: string): boolean =>
		/(^|[\\/])\.\.?([\\/]|$)/.test(spelling);
	/**
	 * The file's project path key, from the caller's own spelling. A spelling
	 * with no dot segment keeps the one `path.resolve` and the text compare, so a
	 * walk pays no kernel round trip per file (#703). A dot-segment spelling takes
	 * the identity of its DIRECTORY, which this matcher caches per directory, so a
	 * walk through one link pays one read per directory.
	 */
	const projectPathKey = (spelling: string): string => {
		const absolute = path.resolve(spelling);
		if (!hasDotSegment(spelling)) {
			if (isUnderRootText(absolute)) return absolute;
			return path.join(
				identityOfDir(path.dirname(absolute)),
				path.basename(absolute),
			);
		}
		// A dot segment that ENDS the spelling names a directory itself, so there
		// is no trailing name to keep: the whole spelling takes the kernel's
		// answer (`<root>/link/..` is the link target's parent, not `<root>`'s
		// lexically folded sibling).
		const tail = path.basename(spelling);
		if (tail === "." || tail === "..") return identityOfDir(spelling);
		return path.join(identityOfDir(path.dirname(spelling)), tail);
	};
	// The textual prefix test keeps the in-root path (every walk of a project
	// spelled by its identity) at one string compare, with no `path.relative`.
	// #4689 batch 7: it is the owner's `isWithinForm` on one path form, so the
	// containment rule has one spelling in the tree (#4861 F2).
	const isUnderRootText = (absolute: string): boolean =>
		isWithinPathForm(absolute, resolvedRoot);
	const invalidateSubtree = (subtree: string): void => {
		const absolute = path.resolve(subtree);
		// #4876 review r2 F2: a dot-segment spelling resolves through the kernel,
		// so this eviction reaches the directory the memo is really keyed under.
		let local = absolute;
		if (hasDotSegment(subtree)) local = identityOfDir(subtree);
		else if (!isUnderRootText(absolute)) local = identityOfDir(absolute);
		dropVerdictsUnder(local);
		nestedCache.delete(local);
	};

	// Compile expanded gitignore globs once per matcher instance. Relative-path
	// resolution remains outside this cache, so nested ignore scopes cannot leak
	// verdicts between sibling trees. The instance lifetime bounds this map.
	const matchExpanded = createExpandedGlobMatcher();

	// #703 perf follow-up: `normalizeEphemeralMapKey` (cheap slash-fold +
	// Windows-lowercase, zero fs I/O), NOT `normalizeMapKey` (realpath-backed).
	// This runs on every `isIgnored` call that reaches this branch — walks
	// over this repo alone visit thousands of pattern-ignored compiled
	// `*.js`/`*.d.ts` files, and `dispatch/integration.ts`'s per-edit cascade
	// check hits it too — so a `realpathSync` here would violate the
	// event-loop/slow-FS discipline `isIgnored` is required to keep (#462: 75x
	// slower on 9p/drvfs). Both `resolved` (this matcher's own `path.resolve`,
	// never realpath'd) and the tracked-set's keys (`git-tracked-ignore.ts`,
	// realpath'd ONCE per fetch on the shared root, not per file) are
	// self-consistent within one process/session, which is exactly
	// `normalizeEphemeralMapKey`'s contract — see that function's doc and
	// `git-tracked-ignore.ts`'s module doc for the full reasoning. Accepted
	// edge case: a symlinked or 8.3-short-name project root can make the cheap
	// fold miss even after the fetch side's one realpath — the file then stays
	// pattern-ignored, i.e. degrades to today's (pre-#703) behavior, which is
	// consistent with this whole feature's fail-open contract.
	function isTrackedAndRescued(resolved: string): boolean {
		const snapshot = getTrackedFilesSnapshot(resolvedRoot);
		if (!snapshot) return false; // never primed / git unavailable: fail-open to pattern-only
		return snapshot.has(normalizeEphemeralMapKey(resolved));
	}

	return {
		rootDir: resolvedRoot,
		patterns,
		getConsumedIgnoreSources: () => [...consumedIgnoreSources.values()],
		refreshConsumedIgnoreSource(filePath: string): void {
			// The freshness sweep refreshes this baseline after invalidation.
			if (consumedIgnoreSources.has(filePath)) rememberIgnoreSource(filePath);
		},
		invalidateSubtree,
		ensureTrackedIndex(): Promise<void> {
			return collectTrackedFiles(resolvedRoot).then(() => undefined);
		},
		isIgnored(filePath: string, isDirectory = false): boolean {
			// #4689: one verdict per file, whichever name reached it. The memo, the
			// nested-rule directories and the tracked set all key on the root's own
			// spelling.
			const resolved = projectPathKey(filePath);
			// Two namespaces (D: for directory queries, F: for file queries)
			// because gitignore semantics differ for trailing-slash patterns.
			const memoKey = (isDirectory ? "D:" : "F:") + resolved;
			let verdict = patternMemo.get(memoKey);
			if (verdict === undefined) {
				// #4689 batch 7: at-or-above the root is `!isWithinForm`, so a name
				// beginning with `..` stays inside the root it belongs to. The dropped
				// second test (`rootRelative.startsWith("..")`) treated `..foo/x` as
				// outside (#4861 F2).
				if (
					resolved === resolvedRoot ||
					!isWithinPathForm(resolved, resolvedRoot)
				) {
					verdict = { ignored: false, layer: undefined };
				} else {
					let ignored = false;
					let layer: GitignorePatternLayer | undefined;
					const patternDirs = ancestorDirsBetween(
						resolvedRoot,
						path.dirname(resolved),
					);
					for (const dir of patternDirs) {
						const dirPatterns = patternsForDir(dir);
						if (dirPatterns.length === 0) continue;
						const relative = path.relative(dir, resolved);
						const normalized = normalizeIgnorePath(relative);
						const winner = lastMatchingPattern(
							dirPatterns,
							normalized,
							isDirectory,
							matchExpanded,
						);
						if (winner) {
							ignored = !winner.negated;
							layer = winner.layer;
						}
					}
					verdict = { ignored, layer };
				}
				patternMemo.set(memoKey, verdict);
			}

			if (!verdict.ignored) return false;
			// #703 layer semantics: a winning positive match from `global` or
			// `gitignore` emulates git, so it inherits git's "a tracked file is
			// never ignored" rule. A winning match from `pilens` is pi-lens-native
			// intent and stays excluded regardless of tracked status. Directory
			// queries are never tracked-rescued — the tracked set is a file-id
			// set, not a directory set.
			if (
				!isDirectory &&
				verdict.layer !== "pilens" &&
				isTrackedAndRescued(resolved)
			) {
				return false;
			}
			return true;
		},
	};
}

export function createProjectIgnoreMatcher(
	rootDir: string,
	extraPatterns: string[] = [],
	globalPatterns: string[] = [],
): ProjectIgnoreMatcherWithFreshness {
	const resolvedRoot = resolveGitIgnoreRoot(rootDir);
	// Precedence is gitignore order: LATER patterns override earlier ones. So
	// global (lowest) → project .gitignore → project .pi-lens.json (highest),
	// which lets a project `!negation` re-include a globally-ignored path (#252).
	// Each layer is tagged (#703) so `isIgnored` can tell a git-emulating match
	// (`global`/`gitignore` — subject to "a tracked file is never ignored")
	// apart from pi-lens-native intent (`pilens` — excludes regardless).
	const patterns = [
		...parseGitignoreContent(globalPatterns.join("\n"), "global"),
		...readGitignorePatterns(resolvedRoot, "gitignore"),
		...parseGitignoreContent(extraPatterns.join("\n"), "pilens"),
	];
	return buildProjectIgnoreMatcher(resolvedRoot, patterns);
}

const projectIgnoreMatcherCache = new Map<
	string,
	{
		ignoreSources: IgnoreSource[];
		lastIgnoreFreshnessCheckMs: number;
		gitignoreMtimeMs: number;
		/** #1105 second axis for the root `.gitignore` (see FreshnessSignature). */
		gitignoreSize: number;
		lensConfigPath: string | undefined;
		lensConfigMtimeMs: number;
		/** #1105 second axis: an mtime-preserving, length-changing config edit
		 * (git checkout, same-second rewrite) must invalidate the ignore matcher
		 * too, not just `loadPiLensProjectConfig`'s own cache. Size is free from the
		 * stat that already produced `lensConfigMtimeMs`. */
		lensConfigSize: number;
		globalConfigMtimeMs: number;
		/** #1105 second axis for the global `~/.pi-lens/config.json`. */
		globalConfigSize: number;
		matcher: ProjectIgnoreMatcherWithFreshness;
	}
>();

/**
 * Nested ignore sources are checked at most once per root per cadence window.
 * Sourced from the shared leaf (`freshness-cadence.ts`) rather than owning the
 * value: `project-lens-config.ts`'s no-config discovery cache (#2483 round 2)
 * needs the same cadence and cannot import it FROM here, because this module
 * already imports `project-lens-config.ts` (the `clients/` acyclic-imports
 * rule would reject the reverse edge). Re-exported under this name so the
 * existing test imports (`tests/clients/project-ignore-freshness.test.ts` and
 * siblings) are unaffected.
 */
export const PROJECT_IGNORE_FRESHNESS_CADENCE_MS = FRESHNESS_CADENCE_MS;

/**
 * `size:mtimeMs` freshness signature for a single file (#1105). mtime alone
 * misses an in-place edit that preserves the timestamp (git checkout, a
 * same-second rewrite) but changes length; size is the free second axis (the
 * same stat already reads it) that catches it. Every ignore-matcher freshness
 * gate below (root + nested `.gitignore` and `.pi-lens.json`) compares BOTH
 * axes so a preserved-mtime, length-changing edit can no longer replay a stale
 * matcher. `{ mtimeMs: -1, size: -1 }` when the file is absent.
 */
interface FreshnessSignature {
	mtimeMs: number;
	size: number;
}

function fileFreshnessSignature(filePath: string): FreshnessSignature {
	try {
		const stat = fs.statSync(filePath);
		return { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		return { mtimeMs: -1, size: -1 };
	}
}

function globalConfigSignature(): FreshnessSignature {
	return fileFreshnessSignature(getPiLensGlobalConfigPath());
}

function gitignoreSignature(rootDir: string): FreshnessSignature {
	return fileFreshnessSignature(path.join(rootDir, ".gitignore"));
}

function hasIgnoreSourceDrift(sources: readonly IgnoreSource[]): boolean {
	return sources.some((source) => {
		const current = fileFreshnessSignature(source.path);
		return current.mtimeMs !== source.mtimeMs || current.size !== source.size;
	});
}

/**
 * The project config file found by the same upward walk as the loader. Cache
 * invalidation must track the actual file found, not only a file directly under
 * the git root: nested worktrees/submodules can legitimately inherit a
 * `.pi-lens.json` from a parent directory.
 */
function lensConfigInfo(rootDir: string): {
	info: ReturnType<typeof findPiLensProjectConfig>;
	path: string | undefined;
	mtimeMs: number;
	size: number;
} {
	const info = findPiLensProjectConfig(rootDir);
	return info
		? { info, path: info.path, mtimeMs: info.mtimeMs, size: info.size }
		: { info, path: undefined, mtimeMs: -1, size: -1 };
}

export function getProjectIgnoreMatcher(rootDir: string): ProjectIgnoreMatcher {
	const resolvedRoot = resolveGitIgnoreRoot(rootDir);
	const gitignoreSig = gitignoreSignature(resolvedRoot);
	const lensConfig = lensConfigInfo(resolvedRoot);
	const globalSig = globalConfigSignature();
	const cached = projectIgnoreMatcherCache.get(resolvedRoot);
	// A path can be discovered during the previous matcher lookup. Publish only
	// previously unseen sources so a walk cannot replace a pre-edit baseline.
	//
	// This runs BEFORE the sweep below, and the order is load-bearing. A nested
	// source can only be published on a call AFTER the one that consumed it.
	// With the publish second, the sweep never saw a source during the window in
	// which it was discovered, yet still reset `lastIgnoreFreshnessCheckMs`, so
	// the first sweep that could see it ran a FULL cadence later. Pickup was up
	// to 2x cadence, not 1x: measured stale at 2 s and 3 s, fresh at 4 s. The
	// baseline is protected by the `known` set, not by the ordering, so moving
	// the publish earlier cannot let a walk overwrite a pre-edit baseline.
	if (cached) {
		const known = new Set(cached.ignoreSources.map((source) => source.path));
		for (const source of cached.matcher.getConsumedIgnoreSources()) {
			if (!known.has(source.path)) cached.ignoreSources.push(source);
		}
	}
	if (
		cached &&
		Date.now() - cached.lastIgnoreFreshnessCheckMs >=
			PROJECT_IGNORE_FRESHNESS_CADENCE_MS
	) {
		cached.lastIgnoreFreshnessCheckMs = Date.now();
		if (hasIgnoreSourceDrift(cached.ignoreSources)) {
			for (const source of cached.ignoreSources) {
				if (hasIgnoreSourceDrift([source])) {
					const sourceIndex = cached.ignoreSources.findIndex(
						(cachedSource) => cachedSource.path === source.path,
					);
					invalidateProjectIgnoreMatcherForPath(source.path);
					cached.matcher.refreshConsumedIgnoreSource(source.path);
					const refreshedSource = cached.matcher
						.getConsumedIgnoreSources()
						.find((current) => current.path === source.path);
					if (sourceIndex !== -1 && refreshedSource !== undefined) {
						cached.ignoreSources.splice(sourceIndex, 1, refreshedSource);
					}
				}
			}
		}
	}
	if (
		cached?.gitignoreMtimeMs === gitignoreSig.mtimeMs &&
		cached?.gitignoreSize === gitignoreSig.size &&
		cached?.lensConfigPath === lensConfig.path &&
		cached?.lensConfigMtimeMs === lensConfig.mtimeMs &&
		cached?.lensConfigSize === lensConfig.size &&
		cached?.globalConfigMtimeMs === globalSig.mtimeMs &&
		cached?.globalConfigSize === globalSig.size
	) {
		return cached.matcher;
	}

	// Load both configs fresh on cache miss. On a cache HIT (the common case)
	// none of this runs — the only per-call cost is the size:mtimeMs stats above
	// (size is free from the same stat). The project loader is itself
	// size:mtimeMs-cached; the global loader re-parses, but only here on miss
	// (when some tracked signature changed).
	const projectConfig = loadPiLensProjectConfig(resolvedRoot, lensConfig.info);
	const matcher = createProjectIgnoreMatcher(
		resolvedRoot,
		projectConfig.ignore,
		getGlobalIgnorePatterns(),
	);
	projectIgnoreMatcherCache.set(resolvedRoot, {
		ignoreSources: [...matcher.getConsumedIgnoreSources()],
		lastIgnoreFreshnessCheckMs: Date.now(),
		gitignoreMtimeMs: gitignoreSig.mtimeMs,
		gitignoreSize: gitignoreSig.size,
		lensConfigPath: lensConfig.path,
		lensConfigMtimeMs: lensConfig.mtimeMs,
		lensConfigSize: lensConfig.size,
		globalConfigMtimeMs: globalSig.mtimeMs,
		globalConfigSize: globalSig.size,
		matcher,
	});
	return matcher;
}

/**
 * Invalidate the cached matcher state affected by a written `.gitignore`.
 *
 * Root changes discard the whole matcher because they change its base pattern
 * set. Nested changes evict only verdicts in that directory's subtree; the
 * matcher and compiled-glob memo remain reusable for unrelated trees.
 *
 * The subtree is the CALLER's spelling, never `path.resolve` of it: a bash
 * redirect that names `src/linked/../shared/.gitignore` writes
 * `<root>/shared/.gitignore`, and a lexical fold would evict `<root>/src/shared`,
 * a directory that never existed (#4876 review r3 F1, CodeRabbit inline
 * 4372287149).
 */
export function invalidateProjectIgnoreMatcherForPath(filePath: string): void {
	const resolvedPath = path.resolve(filePath);
	if (path.basename(resolvedPath).toLowerCase() !== ".gitignore") return;
	for (const [cachedRoot, cached] of projectIgnoreMatcherCache) {
		if (!isUnderDir(resolvedPath, cachedRoot)) continue;
		if (
			normalizeFilePath(resolvedPath) ===
			normalizeFilePath(path.join(cachedRoot, ".gitignore"))
		) {
			projectIgnoreMatcherCache.delete(cachedRoot);
			continue;
		}
		cached.matcher.invalidateSubtree(path.dirname(filePath));
	}
}

export function isPathIgnoredByProject(
	filePath: string,
	rootDir: string,
	isDirectory = false,
): boolean {
	return getProjectIgnoreMatcher(rootDir).isIgnored(filePath, isDirectory);
}

/**
 * "Is this a project-source path pi-lens's bookkeeping should care about" —
 * the `isPathIgnoredByProject` + `isExternalOrVendorFile` pair, previously
 * hand-duplicated at each of its 2 call sites (`registerReadBridge` and
 * `registerMutationBridge` in `index.ts`, both #2423). Consolidated here
 * (#2450 review round 2, F4) when a THIRD call site — `tools/lsp-navigation.ts`
 * threading the same gate onto its directly-threaded `LspMutationContext`, so
 * the direct LSP-mutation path and the mutation-bridge fallback path apply
 * the identical gate instead of the fallback silently being narrower. A
 * caller still layers its own `no-read-guard`-style flag check on top; that
 * flag has no file path to check against, so it stays outside this helper.
 */
export function isRecordableProjectPath(
	filePath: string,
	projectRoot: string,
): boolean {
	if (isPathIgnoredByProject(filePath, projectRoot, false)) return false;
	if (isExternalOrVendorFile(filePath, projectRoot)) return false;
	return true;
}

const projectIgnoreGlobsCache = new Map<
	string,
	{ mtimeMs: number; size: number; globs: string[] }
>();

export function getProjectIgnoreGlobs(rootDir: string): string[] {
	const resolvedRoot = path.resolve(rootDir);
	const signature = gitignoreSignature(resolvedRoot);
	const cached = projectIgnoreGlobsCache.get(resolvedRoot);
	if (
		cached &&
		cached.mtimeMs === signature.mtimeMs &&
		cached.size === signature.size
	) {
		return cached.globs;
	}
	const globs = readGitignorePatterns(resolvedRoot)
		.filter((pattern) => !pattern.negated)
		.flatMap((pattern) => expandGitignorePattern(pattern));
	projectIgnoreGlobsCache.set(resolvedRoot, { ...signature, globs });
	return globs;
}

function globToRegExp(glob: string): RegExp {
	// Directory names use the same `*`-only dialect as read-guard exemptions.
	// Collapse adjacent stars before compiling to avoid nullable-group
	// backtracking on a non-matching name (#2622).
	const escaped = glob
		.replace(/\*+/g, "*")
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

/**
 * Match directory name against exclusion patterns.
 * Supports exact names and lightweight glob patterns (for example `*.dSYM`).
 */
export function isExcludedDirName(
	dirName: string,
	extraPatterns: string[] = [],
): boolean {
	const candidate = dirName.trim();
	if (!candidate) return false;

	const patterns = [...EXCLUDED_DIRS, ...extraPatterns]
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	const candidateLower = candidate.toLowerCase();

	for (const pattern of patterns) {
		const patLower = pattern.toLowerCase();
		if (!patLower.includes("*") && !patLower.includes("?")) {
			if (candidateLower === patLower) return true;
			continue;
		}
		if (globToRegExp(pattern).test(candidate)) return true;
	}

	return false;
}

/**
 * Convert excluded directory names into glob patterns used by scanners.
 */
export function getExcludedDirGlobs(): string[] {
	return EXCLUDED_DIRS.map((dir) => `**/${dir}/**`);
}

/**
 * Shared Knip ignore patterns derived from central exclusions.
 */
export function getKnipIgnorePatterns(): string[] {
	return [
		...getExcludedDirGlobs(),
		"**/*.test.ts",
		"**/*.test.tsx",
		"**/*.test.js",
		"**/*.test.jsx",
		"**/*.spec.ts",
		"**/*.spec.tsx",
		"**/*.spec.js",
		"**/*.spec.jsx",
		"**/*.poc.test.ts",
		"**/*.poc.test.tsx",
		"**/__tests__/**",
		"**/tests/**",
	];
}

/**
 * The two facts a command that rewrites a file leaves behind, kept apart
 * (#5417). `changed` is whether the bytes differ, whatever the exit code and
 * whatever ended the run: a fixer that rewrites the file and then exits
 * nonzero, or is killed at its timeout, still changed it. `success` is the
 * exit code alone (`okStatuses` names the codes a tool documents as benign).
 * `after` is undefined when the file could not be read back: nothing is then
 * known to have changed.
 */
export function resolveWriteResult(
	before: string,
	after: string | undefined,
	run: { status: number | null; error?: unknown },
	okStatuses: readonly number[] = [0],
): { changed: boolean; success: boolean } {
	return {
		changed: after !== undefined && before !== after,
		success:
			!run.error && run.status !== null && okStatuses.includes(run.status),
	};
}

/**
 * Spawn a command and detect whether it modified a file on disk.
 * Returns 1 if the file content changed after the command ran, 0 otherwise,
 * whatever its exit code (see {@link resolveWriteResult}).
 * Useful for auto-fix tools (ESLint, Stylelint, RuboCop, etc.).
 */
export async function detectFileChangedAfterCommand(
	filePath: string,
	command: string,
	args: string[],
	cwd: string,
): Promise<number> {
	let before = "";
	try {
		before = fs.readFileSync(filePath, "utf-8");
	} catch {
		return 0;
	}

	// #1995: a command cooling down after a spawn timeout must not be handed
	// a second budget - autofix is one of the lanes that paid twice for a
	// wedged .cmd shim. Return "no fix applied" (an honest not-checked).
	if (isInSpawnTimeoutCooldown(command)) return 0;

	const result = await safeSpawnAsync(command, args, {
		timeout: 30000,
		cwd,
	});
	// #5376: a real spawn timeout carries BOTH `error` and `failure: "timeout"`,
	// so the timeout branch must precede the generic error return or the
	// cooldown is never armed.
	if (result.failure === "timeout") {
		noteSpawnTimeout({
			tool: path.basename(command).replace(/\.[^.]+$/, ""),
			command,
			phase: "autofix",
			durationMs: 30000,
			teardown: result.timeoutTeardown,
		});
	}

	let after: string | undefined;
	try {
		after = fs.readFileSync(filePath, "utf-8");
	} catch {
		after = undefined;
	}
	return resolveWriteResult(before, after, result).changed ? 1 : 0;
}

/**
 * Check if file path is a test/fixture/mock file.
 * Used by secrets scanner, rate command, and dispatch runners
 * to skip these files (false positives on fake credentials, etc).
 *
 * Delegate naming/directory classification to file-role (#2928). Fixtures,
 * mocks and test helpers remain this skip gate's separate policy.
 */
export function isTestFile(filePath: string): boolean {
	if (detectFileRole(filePath) === "test") return true;
	const normalized = toPosix(filePath);
	return (
		normalized.includes("test-utils") ||
		normalized.startsWith("test-") ||
		normalized.includes(".fixture.") ||
		normalized.includes(".mock.")
	);
}
