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
	/** Roots not recorded because the registry was full. */
	dropped: number;
}

/** A worker runs one file; the measured maximum is far below this. The cap
 *  bounds the registry (AGENTS.md shape 46) and `dropped` is reported. */
export const MAX_TMP_ROOTS = 1024;

const REGISTRY_KEY = Symbol.for("pi-lens.tests.tmp-root-registry");

export function getTmpRootRegistry(): TmpRootRegistry {
	const holder = globalThis as { [REGISTRY_KEY]?: TmpRootRegistry };
	return (holder[REGISTRY_KEY] ??= { roots: new Map(), dropped: 0 });
}

export function createTmpRootRegistry(): TmpRootRegistry {
	return { roots: new Map(), dropped: 0 };
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

/** One `entry<TAB>file` line per recorded entry whose creation this worker
 *  observed, sorted so the record is deterministic. `undefined` when there is
 *  nothing to say. Deliberately NOT one line per mkdtemp call: the registry
 *  already holds one entry per directory, so a recreation cannot grow the
 *  record (AGENTS.md shape 9). */
export function formatTmpRootCreators(
	registry: TmpRootRegistry,
): string | undefined {
	const lines: string[] = [];
	for (const [dir, entry] of registry.roots)
		if (entry.createdBy !== undefined)
			lines.push(`${path.basename(dir)}\t${entry.createdBy}`);
	if (lines.length === 0) return undefined;
	lines.sort();
	return `${lines.join("\n")}\n`;
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

/** The slice of `node:fs` the interposer wraps. Typed loosely on purpose: the
 *  real module's members are read-only in its declaration. */
export interface MkdtempTarget {
	mkdtempSync: (...args: never[]) => unknown;
	mkdtemp: (...args: never[]) => unknown;
	promises: { mkdtemp: (...args: never[]) => unknown };
}

/**
 * Record every `pi-lens-*` directory `mkdtemp` creates directly under the real
 * tmpdir, whoever calls it (a test file, a `vi.hoisted` block, production
 * code): 454 test files spell a raw `mkdtempSync`, and no shared helper sits
 * between them and `fs`. The caller re-publishes the patched members to ESM
 * importers with `syncBuiltinESMExports()`.
 */
export function installTmpRootInterposer(
	registry: TmpRootRegistry,
	target: MkdtempTarget,
	realTmp: string,
	/** The test file running when a directory appears. The shared setup passes
	 *  the process's own file, so an entry a test created is attributed to it
	 *  rather than to whatever file declares the name's prefix. */
	createdBy?: () => string,
): void {
	const tmpRoot = path.resolve(realTmp);
	const note = (dir: unknown): void => {
		if (typeof dir !== "string") return;
		const resolved = path.resolve(dir);
		if (
			path.dirname(resolved) === tmpRoot &&
			path.basename(resolved).startsWith("pi-lens-")
		)
			registerTmpRoot(registry, dir, "observed", createdBy?.());
	};
	const sync = target.mkdtempSync as (...args: unknown[]) => unknown;
	target.mkdtempSync = function (this: unknown, ...args: unknown[]) {
		const dir = sync.apply(this, args);
		note(dir);
		return dir;
	} as MkdtempTarget["mkdtempSync"];
	const callback = target.mkdtemp as (...args: unknown[]) => unknown;
	target.mkdtemp = function (this: unknown, ...args: unknown[]) {
		const last = args.length - 1;
		const done = args[last];
		if (typeof done === "function")
			args[last] = (error: unknown, dir: unknown) => {
				if (!error) note(dir);
				(done as (...cbArgs: unknown[]) => void)(error, dir);
			};
		return callback.apply(this, args);
	} as MkdtempTarget["mkdtemp"];
	const promised = target.promises.mkdtemp as (
		...args: unknown[]
	) => Promise<unknown>;
	target.promises.mkdtemp = async function (this: unknown, ...args: unknown[]) {
		const dir = await promised.apply(this, args);
		note(dir);
		return dir;
	} as MkdtempTarget["promises"]["mkdtemp"];
}
