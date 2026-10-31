/**
 * Per-worker registry of tmp roots the shared setup removes at file teardown
 * and on the worker's SIGTERM (#2912).
 *
 * Named recurrences, all measured on 2026-09-30 in the required Unit tests
 * job, each on a PR that did not touch the leaking file, each with "live
 * owners: none":
 *  - `pi-lens-sym-cpp-*` (tree-sitter-symbols, #3706): a registered root, the
 *    test timed out holding it, so its `finally { env.cleanup() }` had not run
 *    when the fork was killed;
 *  - `pi-lens-install-attempt-*` (#3705) and `pi-lens-tool-discovery-home-*`
 *    (#3699): raw roots the file DID remove, recreated afterwards by a deferred
 *    writer (measured: `probe-cache.json` + `probe-cache.json.locks` land in
 *    the removed home ~150 ms after `afterEach`).
 *
 * Nothing in the harness removed a root once its file ended: the hygiene owner
 * sweeps at the end of the RUN, after its assertion. Vitest SIGTERMs a fork
 * with no `exit` event, so no file-owned hook can be the last word either.
 *
 * Two kinds of root, two rules — the split is what keeps a genuine leak red:
 *  - `registered` (`setupTestEnvironment`): the harness OWNS this root's
 *    lifecycle, so it is removed whenever it still exists, whatever the test's
 *    outcome (timeout, failed assertion, kill).
 *  - `observed` (any other `pi-lens-*` `mkdtemp` directly under the real
 *    tmpdir): the FILE owns it. It is removed only when this worker saw the
 *    file remove it first and something recreated it afterwards (a straggler
 *    write). A root the file never removed is a forgotten cleanup and stays for
 *    the hygiene owner to red.
 * A directory made any other way (`mkdirSync`, a child process) is in neither
 * kind and is never touched.
 *
 * State lives on `globalThis`, not in this module: a test that calls
 * `vi.resetModules()` re-evaluates every module (AGENTS.md shape 25), and a
 * module-local Map would split the roots between the copy that recorded them
 * and the copy the setup sweeps. It is per PROCESS, so a worker can only ever
 * remove a root it created itself — never a sibling's live one.
 */
import * as path from "node:path";
import { realpathSync } from "node:fs";

export type TmpRootKind = "registered" | "observed";

interface TmpRootEntry {
	kind: TmpRootKind;
	/** This worker saw the directory absent after it was recorded. */
	sawAbsent: boolean;
	/** The test file this worker was running when the entry first appeared, when
	 *  the interposer could see the creation (a test process). `undefined` for an
	 *  entry another process made, which no interposer observes. */
	createdBy?: string;
}

export interface TmpRootRegistry {
	roots: Map<string, TmpRootEntry>;
	/** Direct tmp-root directories a TEST PROCESS created with `mkdir` (#4560),
	 *  keyed by resolved path. Creator attribution only: they are never sweep
	 *  members, because the #2912 rule that a directory made by `mkdirSync` is
	 *  never touched still holds. Bounded by the same cap as `roots`. */
	siblings: Map<string, { createdBy?: string }>;
	/** Directories a TEST PROCESS created directly at the repository root
	 *  (#4864, #4867), keyed by entry name. Whatever syscall made it: a named
	 *  directory and a `mkdtemp` root are the same shape to a repo-walking
	 *  governance scan on another worker, which lists the tree and then
	 *  `ENOENT`s when the cell removes it mid-walk. The `mkdtemp` name's
	 *  uniqueness does not remove the directory from that window (#4867).
	 *  Bounded by the same cap as `roots`. */
	repoRootDirs: Map<string, { createdBy?: string }>;
	/** Roots not recorded because the registry was full. */
	dropped: number;
}

/** A worker runs one file; the measured maximum is far below this. The cap
 *  bounds the registry (AGENTS.md shape 46) and `dropped` is reported. */
export const MAX_TMP_ROOTS = 1024;

const REGISTRY_KEY = Symbol.for("pi-lens.tests.tmp-root-registry");

export function getTmpRootRegistry(): TmpRootRegistry {
	const holder = globalThis as { [REGISTRY_KEY]?: TmpRootRegistry };
	return (holder[REGISTRY_KEY] ??= {
		roots: new Map(),
		siblings: new Map(),
		repoRootDirs: new Map(),
		dropped: 0,
	});
}

export function createTmpRootRegistry(): TmpRootRegistry {
	return {
		roots: new Map(),
		siblings: new Map(),
		repoRootDirs: new Map(),
		dropped: 0,
	};
}

export function registerTmpRoot(
	registry: TmpRootRegistry,
	dir: string,
	kind: TmpRootKind,
	createdBy?: string,
): void {
	const existing = registry.roots.get(dir);
	if (existing) {
		// `setupTestEnvironment` creates through `mkdtempSync`, which the
		// interposer already recorded as observed; the harness claim wins.
		if (kind === "registered") existing.kind = "registered";
		// One record per entry: the FIRST observation names the creator, and a
		// later registration (the harness claim) never rewrites it.
		if (existing.createdBy === undefined && createdBy !== undefined)
			existing.createdBy = createdBy;
		return;
	}
	if (registry.roots.size >= MAX_TMP_ROOTS) {
		registry.dropped += 1;
		return;
	}
	registry.roots.set(dir, { kind, sawAbsent: false, createdBy });
}

/** Record a directory a TEST PROCESS created by name directly under the
 *  repository root (#4864). Keyed by entry NAME, not path: two workers that
 *  build the same fixture name are the collision this records. Creator
 *  attribution only, like `siblings`.
 *
 *  The RULE this serves is the OUTCOME, not the syscall: no directory created
 *  directly at the checkout root, whatever made it. The RECORDED writers are
 *  `mkdirSync`, `mkdir` and `promises.mkdir` (the three `noteSibling` call
 *  sites in `installTmpRootInterposer`) and `mkdtempSync`, `mkdtemp` and
 *  `promises.mkdtemp` (its three `noteRepoRoot` call sites, #4867). The rest
 *  of the population is admitted silently today and is named under the PR's
 *  `## Accepted residuals` (AGENTS.md shape 69): `cpSync`, `renameSync` and a
 *  child process's `mkdir`. */
export function registerRepoRootDir(
	registry: TmpRootRegistry,
	dir: string,
	createdBy?: string,
): void {
	const name = path.basename(path.resolve(dir));
	const existing = registry.repoRootDirs.get(name);
	if (existing) {
		if (existing.createdBy === undefined && createdBy !== undefined)
			existing.createdBy = createdBy;
		return;
	}
	if (
		registry.roots.size + registry.siblings.size + registry.repoRootDirs.size >=
		MAX_TMP_ROOTS
	) {
		registry.dropped += 1;
		return;
	}
	registry.repoRootDirs.set(name, { createdBy });
}

/** The line prefix that marks a repository-root creation in the creators
 *  record, so a tmp-root entry and a repo-root entry stay distinguishable. */
export const REPO_ROOT_CREATE_PREFIX = "repo-root:";

/** The repo-root directories this worker recorded, keyed by entry name. */
export function recordedRepoRootDirs(
	registry: TmpRootRegistry,
): Map<string, string | undefined> {
	const dirs = new Map<string, string | undefined>();
	for (const [name, entry] of registry.repoRootDirs)
		dirs.set(name, entry.createdBy);
	return dirs;
}

/** Record a directory a TEST PROCESS made at the tmp root with `mkdir`, for
 *  creator attribution only (never a sweep member, #4560). */
export function registerTmpSibling(
	registry: TmpRootRegistry,
	dir: string,
	createdBy?: string,
): void {
	const resolved = path.resolve(dir);
	const existing = registry.siblings.get(resolved);
	if (existing) {
		if (existing.createdBy === undefined && createdBy !== undefined)
			existing.createdBy = createdBy;
		return;
	}
	if (registry.roots.size + registry.siblings.size >= MAX_TMP_ROOTS) {
		registry.dropped += 1;
		return;
	}
	registry.siblings.set(resolved, { createdBy });
}

/** One `entry<TAB>file` line per recorded entry whose creation this worker
 *  observed, sorted so the record is deterministic. `undefined` when there is
 *  nothing to say. Deliberately NOT one line per mkdtemp call: the registry
 *  already holds one entry per directory, so a recreation cannot grow the
 *  record (AGENTS.md shape 9). */
export function formatTmpRootCreators(
	registry: TmpRootRegistry,
): string | undefined {
	// A Set, not an array: a path can be a mkdtemp root AND later recreated by
	// mkdir (a straggler fixture), and one entry carries one creator line.
	const lines = new Set<string>();
	for (const [dir, entry] of registry.roots)
		if (entry.createdBy !== undefined)
			lines.add(`${path.basename(dir)}\t${entry.createdBy}`);
	for (const [dir, entry] of registry.siblings)
		if (entry.createdBy !== undefined)
			lines.add(`${path.basename(dir)}\t${entry.createdBy}`);
	// #4864: a repo-root creation is always recorded, creator or not, because
	// the judgment (git) runs in the owner's process, not this one.
	for (const [name, entry] of registry.repoRootDirs)
		lines.add(
			`${REPO_ROOT_CREATE_PREFIX}${name}\t${entry.createdBy ?? "unknown"}`,
		);
	if (lines.size === 0) return undefined;
	return `${[...lines].sort().join("\n")}\n`;
}

/** The observed creator of each recorded entry, keyed by entry name. The
 *  in-process counterpart of the persisted creators record. */
export function recordedTmpRootCreators(
	registry: TmpRootRegistry,
): Map<string, string> {
	const creators = new Map<string, string>();
	for (const [dir, entry] of registry.roots)
		if (entry.createdBy !== undefined)
			creators.set(path.basename(dir), entry.createdBy);
	for (const [dir, entry] of registry.siblings)
		if (entry.createdBy !== undefined)
			creators.set(path.basename(dir), entry.createdBy);
	return creators;
}

/** Note which recorded roots are absent NOW. Called after each test's own
 *  `afterEach` hooks (the setup's is registered first, so it runs last) and
 *  before each sweep. A root seen absent was removed by its owner. */
export function sampleTmpRoots(
	registry: TmpRootRegistry,
	exists: (dir: string) => boolean,
): void {
	for (const [dir, entry] of registry.roots)
		if (!entry.sawAbsent && !exists(dir)) entry.sawAbsent = true;
}

export interface TmpRootSweep {
	removed: { dir: string; kind: TmpRootKind }[];
	failed: string[];
}

/** Remove every recorded root the rule above allows. Entries stay recorded
 *  after removal: a later straggler recreates the same path, and a second sweep
 *  (SIGTERM) must still find it (AGENTS.md shape 47). */
export function sweepTmpRoots(
	registry: TmpRootRegistry,
	io: { exists: (dir: string) => boolean; remove: (dir: string) => void },
): TmpRootSweep {
	sampleTmpRoots(registry, io.exists);
	const sweep: TmpRootSweep = { removed: [], failed: [] };
	for (const [dir, entry] of registry.roots) {
		if (entry.kind !== "registered" && !entry.sawAbsent) continue;
		if (!io.exists(dir)) continue;
		try {
			io.remove(dir);
		} catch {
			sweep.failed.push(dir);
			continue;
		}
		if (io.exists(dir)) sweep.failed.push(dir);
		else sweep.removed.push({ dir, kind: entry.kind });
	}
	return sweep;
}

/** One record per file, never one per root. `undefined` when there is nothing
 *  to say. */
export function formatTmpRootSweep(
	file: string,
	sweep: TmpRootSweep,
	registry: TmpRootRegistry,
	via: "afterAll" | "SIGTERM",
): string | undefined {
	// `dropped` is a per-file fact: reported by the afterAll record only.
	const dropped = via === "afterAll" ? registry.dropped : 0;
	if (sweep.removed.length === 0 && sweep.failed.length === 0 && dropped === 0)
		return undefined;
	const registered = sweep.removed.filter((r) => r.kind === "registered");
	const stragglers = sweep.removed.length - registered.length;
	return `[tmp-hygiene-sweep] tests/${file} via=${via} registered=${registered.length} stragglers=${stragglers} failed=${sweep.failed.length} dropped=${dropped}\n`;
}

/** The creators-record prefix of a sweep record (#4591), the way
 *  `REPO_ROOT_CREATE_PREFIX` marks a repository-root creation: `sweep:<via>:<name>`
 *  keys never collide with a bare entry name, so the one persisted record
 *  carries both without a second file or a second flush latch. */
export const TMP_ROOT_SWEEP_PREFIX = "sweep:";

/** What a sweep found at one recorded root: it `removed` it, tried and `failed`,
 *  `held` an observed root its file never removed (not the sweep's to remove),
 *  or the root was `absent` (its owner removed it, or it was never created). */
export type TmpRootSweepOutcome = "removed" | "failed" | "held" | "absent";

/** One `sweep:<via>:<name>` key and `<kind>,<outcome>,<epoch ms>` value per
 *  recorded root, so the serialized census can tell a root that was in the
 *  registry at sweep time and reappeared afterwards (a deferred writer) from a
 *  root the sweep never owned (the interposer never recorded it). The outcome is
 *  read back from the registry and the sweep, so it needs no second `exists`
 *  probe: after `sweepTmpRoots` sampled, a root that is neither removed nor
 *  failed is `held` exactly when it is observed and was never seen absent. One
 *  record per root per `via`, bounded by `MAX_TMP_ROOTS`, never one per call. */
export function formatTmpRootSweepRecords(
	registry: TmpRootRegistry,
	sweep: TmpRootSweep,
	via: "afterAll" | "SIGTERM",
	at: number,
): string[] {
	const removed = new Set(sweep.removed.map((r) => r.dir));
	const failed = new Set(sweep.failed);
	const lines: string[] = [];
	for (const [dir, entry] of registry.roots) {
		const outcome: TmpRootSweepOutcome = removed.has(dir)
			? "removed"
			: failed.has(dir)
				? "failed"
				: entry.kind !== "registered" && !entry.sawAbsent
					? "held"
					: "absent";
		lines.push(
			`${TMP_ROOT_SWEEP_PREFIX}${via}:${path.basename(dir)}\t${entry.kind},${outcome},${Math.round(at)}`,
		);
	}
	return lines;
}

/** The slice of `node:fs` the interposer wraps. Typed loosely on purpose: the
 *  real module's members are read-only in its declaration. */
export interface TmpRootFsTarget {
	mkdtempSync: (...args: never[]) => unknown;
	mkdtemp: (...args: never[]) => unknown;
	mkdirSync: (...args: never[]) => unknown;
	mkdir: (...args: never[]) => unknown;
	promises: {
		mkdtemp: (...args: never[]) => unknown;
		mkdir: (...args: never[]) => unknown;
	};
}

/**
 * Record directories created directly under the real tmpdir, whoever calls it
 * (a test file, a `vi.hoisted` block, production code): 454 test files spell a
 * raw `mkdtempSync`, and no shared helper sits between them and `fs`.
 *
 * `mkdtemp` records only the `pi-lens-` namespace, because that is the family
 * the census observes and sweeps (#2912). `mkdir` records ANY name: a fixture
 * sibling written at the tmp root — `path.join(<fixture>, "..")` — is the
 * pattern-class leak of #4560, and its name is not namespaced. Both record ANY
 * name when the caller passes a `repoRoot` and the call created its directory
 * directly there, because that population is a repo-walking scan's hazard and
 * not a tmp-namespace one (#4864, #4867). A directory a
 * CHILD process creates is not observed here: that is the case with no creator
 * on record, and the reason a child's tmp cache is counted and never asserted.
 * It is NOT the case for a loader's cache created IN THIS PROCESS -- pi's
 * `createJiti` (`@earendil-works/pi-coding-agent/dist/core/extensions/loader.js`)
 * mkdirs `path.join(os.tmpdir(), "jiti")` from the test process itself on the
 * first by-path extension load, so this interposer sees it and attributes it to
 * the file that was running (#4673; the write is removed at its source by the
 * `JITI_FS_CACHE=0` pin in `tests/support/vitest-setup.ts`). The caller
 * re-publishes the patched members to ESM importers with
 * `syncBuiltinESMExports()`.
 */
export function installTmpRootInterposer(
	registry: TmpRootRegistry,
	target: TmpRootFsTarget,
	realTmp: string,
	/** The test file running when a directory appears. The shared setup passes
	 *  the process's own file, so an entry a test created is attributed to it
	 *  rather than to whatever file declares the name's prefix. */
	createdBy?: () => string,
	/** The repository root, when the caller wants named creations there recorded
	 *  (#4864). `undefined` keeps the tmp-root ledger only. */
	repoRoot = undefined as string | undefined,
): void {
	// #3703: shared setup runs before test mocks. Import only node builtins
	// and tests/support modules here, never clients/ (which would cache real fs).
	//
	// The production owner of the Windows-shape predicate is
	// `clients/path-utils.ts` (`isWindowsPath`, and `toPosix` for the separator
	// fold, AGENTS.md "Issue and PR design contract", core-domain rule). It cannot
	// be shared here: the shared setup is evaluated before a test file's
	// `vi.mock("node:fs")`, so importing `clients/path-utils.ts` would bind real
	// fs ahead of the mock (#3703). Named deferral, review round 5 (N4-2): this
	// spelling stays local and differs from the owner's on two shapes --
	// `C:temp` (owner true, this false: the owner accepts a bare drive prefix)
	// and `\Temp` (owner true, this false: the owner accepts one rooted
	// backslash, this needs a full UNC `\\`). Neither shape is producible from
	// `os.tmpdir()`. The separator fold below is byte-identical to the owner's
	// `toPosix`.
	const windows = /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/.test(realTmp);
	const pathApi = windows ? path.win32 : path.posix;
	const canonicalParent = (parent: string): string => {
		let canonical = parent;
		try {
			canonical = realpathSync.native(parent);
		} catch {
			// Synthetic or unavailable parents retain their platform spelling.
		}
		return windows
			? path.win32.resolve(canonical).replace(/\\/g, "/").toLowerCase()
			: path.posix.resolve(canonical);
	};
	const tmpRoot = pathApi.resolve(realTmp);
	const isDirectTmpChild = (dir: unknown): dir is string => {
		if (typeof dir !== "string") return false;
		const resolved = pathApi.resolve(dir);
		return (
			canonicalParent(pathApi.dirname(resolved)) === canonicalParent(tmpRoot)
		);
	};
	// #4864: a directory NAMED directly at the repository root is the shape a
	// repo-walking scan on another worker can list and then lose to a removal.
	// The tmp-root comparison above is the same one; only the watched parent
	// differs, so the caller passes the root it wants judged.
	const repoRootName =
		repoRoot === undefined
			? undefined
			: canonicalParent(pathApi.resolve(repoRoot));
	const isDirectRepoRootChild = (dir: unknown): dir is string => {
		if (repoRootName === undefined || typeof dir !== "string") return false;
		const resolved = pathApi.resolve(dir);
		return canonicalParent(pathApi.dirname(resolved)) === repoRootName;
	};
	const note = (dir: unknown): void => {
		if (
			isDirectTmpChild(dir) &&
			path.basename(path.resolve(dir)).startsWith("pi-lens-")
		)
			registerTmpRoot(registry, dir, "observed", createdBy?.());
	};
	// A fixture SIBLING (any name) is the #4560 population; `mkdtemp`'s
	// namespace rule above stays as it was.
	//
	// Judge what the call CREATED, not what it requested (#4560 F3). A recursive
	// `mkdir(<tmp>/name/src)` creates `name` at the tmp root, and its return value
	// is the first directory it created -- or nothing at all when it created none,
	// so a re-mkdir of a directory another process made is never blamed on this
	// test. A plain call returns nothing, and its requested path is what it made.
	const isRecursive = (options: unknown): boolean =>
		typeof options === "object" &&
		options !== null &&
		(options as { recursive?: unknown }).recursive === true;
	const noteSibling = (
		requested: unknown,
		created: unknown,
		recursive: boolean,
	): void => {
		const made = recursive ? created : requested;
		if (isDirectTmpChild(made)) {
			registerTmpSibling(registry, made, createdBy?.());
			return;
		}
		// The rule is the OUTCOME: a directory NAMED directly at the checkout root
		// is the shape a repo-walking scan loses. This branch sees the `mkdir`
		// writers only; `mkdtemp` reaches the same rule through `noteRepoRoot`.
		// The admitted remainder is `cpSync`, `renameSync` and a child process's
		// `mkdir`.
		if (isDirectRepoRootChild(made))
			registerRepoRootDir(registry, made, createdBy?.());
	};
	// #4867: the same OUTCOME rule for `mkdtemp`, which `note` above only judges
	// at the tmp root. A root named directly at the checkout root is on disk for
	// the life of the cell, and its unique name does not keep a repo-walking scan
	// from listing it and losing it to the cell's own removal.
	const noteRepoRoot = (dir: unknown): void => {
		if (isDirectRepoRootChild(dir))
			registerRepoRootDir(registry, dir, createdBy?.());
	};
	const sync = target.mkdtempSync as (...args: unknown[]) => unknown;
	target.mkdtempSync = function (this: unknown, ...args: unknown[]) {
		const dir = sync.apply(this, args);
		note(dir);
		noteRepoRoot(dir);
		return dir;
	} as TmpRootFsTarget["mkdtempSync"];
	const callback = target.mkdtemp as (...args: unknown[]) => unknown;
	target.mkdtemp = function (this: unknown, ...args: unknown[]) {
		const last = args.length - 1;
		const done = args[last];
		if (typeof done === "function")
			args[last] = (error: unknown, dir: unknown) => {
				if (!error) {
					note(dir);
					noteRepoRoot(dir);
				}
				(done as (...cbArgs: unknown[]) => void)(error, dir);
			};
		return callback.apply(this, args);
	} as TmpRootFsTarget["mkdtemp"];
	const promised = target.promises.mkdtemp as (
		...args: unknown[]
	) => Promise<unknown>;
	target.promises.mkdtemp = async function (this: unknown, ...args: unknown[]) {
		const dir = await promised.apply(this, args);
		note(dir);
		noteRepoRoot(dir);
		return dir;
	} as TmpRootFsTarget["promises"]["mkdtemp"];
	const mkdirSync = target.mkdirSync as (...args: unknown[]) => unknown;
	target.mkdirSync = function (this: unknown, ...args: unknown[]) {
		const dir = mkdirSync.apply(this, args);
		noteSibling(args[0], dir, isRecursive(args[1]));
		return dir;
	} as TmpRootFsTarget["mkdirSync"];
	// The callback form supplies the same first-created path as its second
	// callback argument; forward it through the common judgment.
	const mkdirCallback = target.mkdir as (...args: unknown[]) => unknown;
	target.mkdir = function (this: unknown, ...args: unknown[]) {
		const last = args.length - 1;
		const done = args[last];
		if (typeof done === "function")
			args[last] = (error: unknown, ...rest: unknown[]) => {
				if (!error) noteSibling(args[0], rest[0], isRecursive(args[1]));
				(done as (...cbArgs: unknown[]) => void)(error, ...rest);
			};
		return mkdirCallback.apply(this, args);
	} as TmpRootFsTarget["mkdir"];
	const promisedMkdir = target.promises.mkdir as (
		...args: unknown[]
	) => Promise<unknown>;
	target.promises.mkdir = async function (this: unknown, ...args: unknown[]) {
		const dir = await promisedMkdir.apply(this, args);
		noteSibling(args[0], dir, isRecursive(args[1]));
		return dir;
	} as TmpRootFsTarget["promises"]["mkdir"];
}
