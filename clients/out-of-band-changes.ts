/**
 * #4476: disk changes pi-lens learns about only by looking.
 *
 * pi-lens advertises `workspace.didChangeWatchedFiles.dynamicRegistration`, so
 * a server may hand file watching to it: TypeScript 7's native server
 * registers `<root>/**` and its `node_modules` as client watchers and then
 * re-reads a closed file only when a watched-files event names that exact
 * file, or when it restarts (measured with a raw JSON-RPC probe of
 * `tsc --lsp --stdio`, TS 7.0.2; directory and manifest events change
 * nothing). pi-lens reports its own writes and the bash writes it recovers,
 * but not a file a command writes into a gitignored directory (codegen), a
 * change made outside pi, or a dependency install. The server then kept the
 * old declarations for its whole life, and the diagnostics cache served
 * entries whose ambient scope had changed under them.
 *
 * At each #4493 look (a bash tool_result, every tool_call) this module
 * compares the root's install stamps (lockfiles, package-manager install
 * markers and a Python venv's `site-packages` directories) and a bounded walk
 * of the root's declaration files, then publishes
 * what changed as one `DiskChange` (#4535). The publisher allocates the
 * project sequence; its subscribers restart the root's primary clients and
 * send the exact-URI watched-files events (#4528), and move the
 * diagnostics-cache clock so the entries whose scope holds a changed path or
 * an install are refused. This module names no consumer.
 *
 * The same look compares the config files a server reads once and keeps
 * (`pyrightconfig.json`, `pyproject.toml`: the closed list in
 * `clients/lsp/server-config-files.ts`) at the root only (a config below it is
 * a declared p3 residual: the look stats the root's names, it does not walk),
 * and publishes a created, edited or deleted one as a `config` change (#4532
 * gap 12). A config born after the server answered never reached it before:
 * pyright kept its "could not be resolved" findings for the server's life until
 * a watched-files event named the file.
 *
 * The records are process-wide per root, as the servers are (two sessions on
 * one root share them, so one install restarts once). They describe the disk,
 * not a session, so a session boundary keeps them: an install made between
 * sessions is still seen. A root's first look records and changes nothing
 * unless the caller names the epoch of the live server rooted there (#4532):
 * an install fresher than that epoch is the change the server missed, so it is
 * published instead of recorded as a baseline the server never read.
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import { basename, join } from "node:path";
import { BoundedFifoMap } from "./bounded-cache.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import {
	type DiskChangeInput,
	type DiskChangeRuntime,
	publishDiskChange,
} from "./disk-changes.js";
import {
	ensureDiskChangeSubscribers,
	LSP_CONSUMER,
} from "./disk-change-subscribers.js";
import { untilAborted } from "./deadline-utils.js";
import { isExcludedDirName } from "./file-utils.js";
import { logLatency } from "./latency-logger.js";
import {
	isAtOrAboveHomeDir,
	isUnderDir,
	normalizeMapKey,
	realpathOrResolve,
} from "./path-utils.js";
import { SERVER_CONFIG_FILE_NAMES } from "./lsp/server-config-files.js";
import { PROJECT_VENV_DIR_NAMES } from "./python-environment.js";
import { createSingleFlight } from "./single-flight.js";
import { compareOrdinal } from "./string-utils.js";

/**
 * Files an install rewrites at the root: the lockfiles, and the markers a
 * package manager writes into its install tree (npm rewrites
 * `node_modules/.package-lock.json` on `npm install` and `npm ci`, measured;
 * `npm ci` leaves the lockfile and the `node_modules` inode alone). The
 * `node_modules` directory itself is not one: a tool's cache directory under
 * it would restart the servers.
 */
const INSTALL_LOCKFILES = [
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"uv.lock",
	"poetry.lock",
	"Pipfile.lock",
	"pdm.lock",
	"go.sum",
	"Cargo.lock",
];
/** The install markers, under `node_modules`. */
const INSTALL_MARKERS = [
	".package-lock.json",
	".modules.yaml",
	".yarn-state.yml",
	".yarn-integrity",
];
/** The interpreter level of a POSIX venv's `site-packages` directory. */
const VENV_LIB_DIR = "lib";
/** The Windows venv layout's `site-packages`, relative to the venv root. */
const VENV_WINDOWS_SITE_PACKAGES = join("Lib", "site-packages");
/**
 * Interpreter directories under `<venv>/lib` statted per look. A venv holds one
 * per interpreter on the platform, so the cap never binds on a real
 * environment; it exists so a pathological `lib` cannot turn every look into a
 * stat storm, and an interpreter directory past the cap is not stamped — an
 * install there publishes nothing, which is the bound's stated cost, chosen
 * over an unbounded stat per look.
 */
const VENV_INTERPRETER_DIRS_MAX = 4;

/** Directories one declaration walk reads before it stops (degraded). */
const DECLARATION_WALK_MAX_DIRS = 4096;
/** Declaration files one walk records before it stops (degraded). */
const DECLARATION_WALK_MAX_FILES = 2048;
/** Directory reads in flight during one walk. */
const DECLARATION_WALK_CONCURRENCY = 16;
/**
 * Declaration files: TypeScript `.d.ts`/`.d.mts`/`.d.cts` and Python `.pyi`
 * stubs (#4532 gap 3: a stub changed or added outside pi reached no server;
 * pyright keeps the bytes of a closed stub it read for an importer).
 */
const DECLARATION_FILE = /(?:\.d\.[cm]?ts|\.pyi)$/i;
/** Roots kept; the oldest is dropped (its next look is a first look). */
const MAX_ROOTS = 64;

/** Least time between two tool_call walks of one root (bash results always walk). */
function declarationLookIntervalMs(): number {
	const raw = Number(process.env.PI_LENS_DECLARATION_LOOK_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
}

interface RootRecord {
	stamp: string;
	/** name -> `ino:size:mtimeMs` of each listed server config file (#4532). */
	configs: Map<string, string> | undefined;
	/** path -> `ino:size:mtimeMs`; undefined until a walk completes uncapped. */
	declarations: Map<string, string> | undefined;
	walkedAt: number;
}

const records = new BoundedFifoMap<string, RootRecord>(MAX_ROOTS);
/**
 * One look per root at a time: a look that arrives mid-flight joins it and
 * gets one trailing look, which compares against the record the flight left,
 * so two sessions' looks after one install restart once. The trailing look
 * runs the first caller's closure, so a joiner's walk demand rides
 * {@link owedWalks}, not the closure.
 */
const looks = createSingleFlight<void>({ coalesceTrailing: true });

/**
 * #4532 gap 6: roots owed a declaration walk by a caller whose trigger demands
 * one (a bash result), by root key. The trailing pass of a joined flight runs
 * the FIRST caller's closure, so a bash result that joined a `tool_call` look
 * got no walk, and the file its command generated waited for some later walk.
 *
 * Each caller writes its demand here in the same synchronous step as its join
 * ({@link oweDeclarationWalk}), and every pass takes its key's demand before
 * its first await: the running pass has either not taken yet (it walks for
 * the joiner) or has, and then the join earned the trailing pass that takes
 * it. Process-wide like `records` (a session boundary keeps it: it is a demand
 * on the disk, and costs at most one walk); bounded like `records`, and an
 * evicted demand only defers the change to the next walk.
 */
const owedWalks = new BoundedFifoMap<string, true>(MAX_ROOTS);

/**
 * Owe `root`'s next look a declaration walk when this call demands one: a
 * `tool_result` under the `"trigger"` rule. A `tool_call`, and every
 * `"interval"` look, walk only when the interval has passed, which the pass
 * reads from the record itself, so they owe nothing. The HEAD look calls this
 * for its own caller before it joins (`resyncHeadMove`): a HEAD look that
 * joins runs the first caller's closure too.
 */
export function oweDeclarationWalk(
	root: string,
	trigger: "tool_call" | "tool_result",
	walk: OutOfBandLookOptions["walk"] = "trigger",
): void {
	if (demandsWalk(trigger, walk)) owedWalks.set(normalizeMapKey(root), true);
}

/** #4476's rule: a bash result always walks, unless the look is `"interval"`.
 *
 * #4532 gap 5: `"always"` is the caller saying it must not answer from a view
 * the walk has not refreshed — the `lsp_diagnostics` body does, so a
 * declaration file created inside `PI_LENS_DECLARATION_LOOK_MS` reaches the
 * server before the answer rather than after the next bash result. */
function demandsWalk(
	trigger: "tool_call" | "tool_result",
	walk: OutOfBandLookOptions["walk"],
): boolean {
	return (
		walk === "always" || (trigger === "tool_result" && walk !== "interval")
	);
}

const fingerprint = (stat: {
	ino: number;
	size: number;
	mtimeMs: number;
}): string => `${stat.ino}:${stat.size}:${stat.mtimeMs}`;

/** Created, changed and deleted server config files between two looks. */
function diffServerConfigs(
	root: string,
	before: ReadonlyMap<string, string>,
	after: ReadonlyMap<string, string>,
): Array<{ filePath: string; type: number }> {
	return diffDeclarations(
		new Map([...before].map(([name, print]) => [join(root, name), print])),
		new Map([...after].map(([name, print]) => [join(root, name), print])),
	);
}

/**
 * The stamp of `root`'s Python venv `site-packages` directories (#4532 gap 3).
 *
 * A project that installs with `pip install` and keeps no lockfile — the
 * reported shape: a `pyproject.toml` and a local `.venv` — wrote nothing the
 * lockfile and `node_modules` stamp could see, so an install published no
 * change, no server restarted, and pyright served the `Import "x" could not be
 * resolved` it had cached for its whole life (measured on real pyright
 * 1.1.414: stale through 40 calls over 20 s; the same install behind a
 * published change clears on call 1).
 *
 * One directory stat per `site-packages` and NO listing of its contents: `pip
 * install` adds the package's directory and its `.dist-info` entry, which moves
 * the directory's own mtime, inode or size. A root with no venv costs no
 * syscall here; a venv costs one `lib` listing and one stat per interpreter
 * directory, plus one stat for the Windows layout (absent on POSIX).
 *
 * Residual: an install that rewrites files INSIDE an existing package
 * directory without adding or removing an entry (a reinstall of the same
 * package release that leaves `<name>` and its `.dist-info` in place)
 * changes no entry of
 * `site-packages` itself, so it publishes nothing; pip's own uninstall-then-
 * install moves the directory. The other side of the same bound is a write AT
 * the `site-packages` root: Python caches a top-level module's bytecode in a
 * `__pycache__` there, so the FIRST import of a top-level installed module
 * moves the directory's identity and publishes one install (which also
 * refuses the diagnostics cache workspace-wide, `clients/disk-change-
 * subscribers.ts`). It is bounded to that first import: the `.pyc` is cached,
 * so a re-import moves nothing. Review 5009 F2.
 */
async function readVenvInstallParts(
	root: string,
	listed: ReadonlySet<string>,
): Promise<Array<{ part: string; changedAt: number }>> {
	const targets: Array<{ label: string; dir: string }> = [];
	for (const name of PROJECT_VENV_DIR_NAMES) {
		if (!listed.has(name)) continue;
		const venvRoot = join(root, name);
		// The Windows layout has no interpreter level, so it is one stat either way.
		targets.push({
			label: `${name}/${VENV_WINDOWS_SITE_PACKAGES}`,
			dir: join(venvRoot, VENV_WINDOWS_SITE_PACKAGES),
		});
		let interpreters: import("node:fs").Dirent[];
		try {
			interpreters = await fsp.readdir(join(venvRoot, VENV_LIB_DIR), {
				withFileTypes: true,
			});
		} catch {
			// none: the Windows layout, or a venv root that holds no `lib`.
			continue;
		}
		// Deterministic order, as the declaration walk's keys are (S2871): the
		// population that fits `VENV_INTERPRETER_DIRS_MAX` must not depend on the
		// order the filesystem listed the entries in. The type guard runs BEFORE
		// the cap, so a stray file in `lib` is never a candidate and cannot spend
		// a slot the venv's own interpreter directory needs (review 5009 F1).
		interpreters.sort((a, b) => compareOrdinal(a.name, b.name));
		const interpreterDirs = interpreters
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.slice(0, VENV_INTERPRETER_DIRS_MAX);
		for (const interpreter of interpreterDirs) {
			targets.push({
				label: `${name}/${VENV_LIB_DIR}/${interpreter.name}/site-packages`,
				dir: join(venvRoot, VENV_LIB_DIR, interpreter.name, "site-packages"),
			});
		}
	}
	return Promise.all(
		targets.map(async (target) => {
			try {
				const stat = await fsp.stat(target.dir);
				return {
					part: `${target.label}=${fingerprint(stat)}`,
					changedAt: stat.mtimeMs,
				};
			} catch {
				// none: the venv has no `site-packages` at this layout, which reads as
				// "no entry here" exactly as a listed name that could not be statted
				// does; a layout that appears later changes the stamp.
				return { part: `${target.label}=-`, changedAt: 0 };
			}
		}),
	);
}

/**
 * The root's install stamp and the freshest timestamp in it.
 *
 * `stamp` is opaque equality evidence: one listing of the root, then a stat of
 * each lockfile it holds and, when it holds `node_modules`, of each install
 * marker (a tool call pays a listing and a few stats, not one stat per name). A
 * name that appears, changes or goes away changes the stamp.
 *
 * `newestChangeMs` is what a FIRST look needs (#4532). With no prior record the
 * look has nothing to compare, and the reported case — `ln -s` of another
 * checkout's `node_modules` into a worktree that had none — carries OLD mtimes:
 * the target install predates the server's spawn. So the stamp also carries the
 * `node_modules` entry's OWN `lstat` when it is a symlink: that is the instant
 * the root acquired its dependency tree, which is the change the server missed.
 * A real `node_modules` directory is deliberately NOT an entry — a tool writing
 * a cache directory under it would change the stamp and restart servers for
 * nothing (#4476's reason for listing markers instead of the directory).
 */
async function readInstallStamp(root: string): Promise<{
	stamp: string;
	newestChangeMs: number;
	/** The root's server config files; `undefined` when the root cannot be listed. */
	configs: Map<string, string> | undefined;
}> {
	let listed: Set<string>;
	try {
		listed = new Set(await fsp.readdir(root));
	} catch {
		return { stamp: "-", newestChangeMs: 0, configs: undefined };
	}
	const names: string[] = [];
	for (const name of INSTALL_LOCKFILES) if (listed.has(name)) names.push(name);
	let linkPrint: string | undefined;
	let linkChangedAt = 0;
	if (listed.has("node_modules")) {
		for (const marker of INSTALL_MARKERS) names.push(`node_modules/${marker}`);
		let link: import("node:fs").Stats | undefined;
		try {
			link = await fsp.lstat(join(root, "node_modules"));
		} catch {
			// none: the entry vanished between the listing and the lstat, so this
			// look has no symlink lane to record (the stamp still carries the
			// markers it listed).
			link = undefined;
		}
		if (link?.isSymbolicLink()) {
			linkPrint = `node_modules=${fingerprint(link)}`;
			linkChangedAt = link.mtimeMs;
		}
	}
	// #4532: the root's server config files are statted in the same round as
	// the stamp's names, and kept out of the stamp (a config is no install).
	const configNames: string[] = [];
	for (const name of SERVER_CONFIG_FILE_NAMES)
		if (listed.has(name)) configNames.push(name);
	// #4532 gap 3: the venv's `site-packages` directories ride the same round,
	// so the look pays no extra await for them.
	const [statted, venvParts] = await Promise.all([
		Promise.all(
			[...names, ...configNames].map(async (name) => {
				try {
					const stat = await fsp.stat(join(root, name));
					return {
						part: `${name}=${fingerprint(stat)}`,
						changedAt: stat.mtimeMs,
					};
				} catch {
					return { part: `${name}=-`, changedAt: 0 };
				}
			}),
		),
		readVenvInstallParts(root, listed),
	]);
	const parts = statted.slice(0, names.length);
	// A listed name that could not be statted reads as absent, as in the stamp.
	const configs = new Map<string, string>();
	for (const [index, name] of configNames.entries()) {
		const print = (
			statted[names.length + index] as { part: string }
		).part.slice(name.length + 1);
		if (print !== "-") configs.set(name, print);
	}
	if (linkPrint !== undefined)
		parts.push({ part: linkPrint, changedAt: linkChangedAt });
	parts.push(...venvParts);
	return {
		configs,
		stamp: parts.map((entry) => entry.part).join("|"),
		newestChangeMs: parts.reduce(
			(newest, entry) => Math.max(newest, entry.changedAt),
			0,
		),
	};
}

/**
 * A file's mtime comes from the kernel's COARSER clock and can land a tick
 * BELOW `Date.now()`, so an install written in the same second as the spawn can
 * stamp earlier than the spawn epoch. Comparing exactly would read that install
 * as "the client already saw it" and record its stamp as the baseline, and
 * nothing publishes afterwards because the record now holds the new stamp
 * (#4532 round 4, LOW-5: the margin lived in a test fixture, where it proved
 * nothing about production). One second is the whole slack a coarse-granularity
 * filesystem needs; a wider window would start admitting installs the client
 * really did read.
 */
const COARSE_MTIME_SLACK_MS = 1_000;

/**
 * The FIRST look's verdict for a root with no record yet (#4532): an install
 * counts when the freshest stamp entry is at or after the epoch of the client
 * that has to re-read it. `since` absent or 0 means "no epoch" — the caller
 * has no live client at this root, so the first look keeps #4476's rule and
 * changes nothing.
 *
 * `>=`, not `>`: an install that finished in the same millisecond the client
 * spawned is indistinguishable from one that landed after it, and the safe
 * direction is the restart.
 */
function firstLookSawInstall(
	install: { newestChangeMs: number },
	since: number | undefined,
): boolean {
	return (
		since !== undefined &&
		since > 0 &&
		install.newestChangeMs >= since - COARSE_MTIME_SLACK_MS
	);
}

/**
 * One walk's answer: the declaration files under `root`, the directories the
 * walk could not read, and the files it listed but could not stat for a reason
 * other than absence.
 */
interface DeclarationWalk {
	declarations: Map<string, string>;
	/** Directories whose listing failed, bounded by `DECLARATION_WALK_MAX_DIRS`. */
	unreadable: string[];
	/** Files whose `stat` failed with an error that is not absence (#4603 F2). */
	unreadableFiles: string[];
}

/**
 * The declaration files under `root`, outside the shared excluded directories
 * (gitignored ones included: codegen writes there), in a deterministic order;
 * `undefined` when the walk hit a cap.
 *
 * #4596: a directory that cannot be listed is REPORTED, not skipped. Skipping
 * it left the walk's map looking complete, so the diff below read every
 * declaration file under it as deleted (`lsp_out_of_band_change` said
 * `deleted: 1` for a file that still existed), and a consumer acted on that
 * row. The map the caller diffs keeps the previous fingerprint of a file under
 * an unreadable directory instead, so an unreadable subtree reads as
 * "unchanged, as far as this walk could tell" rather than as a deletion.
 *
 * #4603 F2: a file the walk listed but could not stat is the same question one
 * level down. `ENOENT`/`ENOTDIR` mean the file went away between the listing
 * and the stat, which is absence; `EACCES`, `EPERM`, `EIO`, `ESTALE` and
 * `ENOMEM` mean the walk cannot tell, so the file joins `unreadableFiles` and
 * keeps its previous fingerprint exactly as a subtree does. Reading every
 * failure as absence published `deleted: 1` for a file that exists whenever a
 * readable directory held an unreadable file.
 */
async function walkDeclarations(
	root: string,
): Promise<DeclarationWalk | undefined> {
	const found: string[] = [];
	const unreadable: string[] = [];
	const unreadableFiles: string[] = [];
	const queue = [root];
	let next = 0;
	let capped = false;
	const worker = async () => {
		while (!capped && next < queue.length) {
			if (next >= DECLARATION_WALK_MAX_DIRS) {
				capped = true;
				return;
			}
			const dir = queue[next++] as string;
			let entries: import("node:fs").Dirent[];
			try {
				entries = await fsp.readdir(dir, { withFileTypes: true });
			} catch {
				unreadable.push(dir);
				continue;
			}
			for (const entry of entries) {
				if (entry.isDirectory()) {
					if (!isExcludedDirName(entry.name)) queue.push(join(dir, entry.name));
				} else if (entry.isFile() && DECLARATION_FILE.test(entry.name)) {
					found.push(join(dir, entry.name));
				}
			}
			if (found.length > DECLARATION_WALK_MAX_FILES) capped = true;
		}
	};
	// The queue grows while workers drain it; a worker that finds it empty
	// returns, so the walk re-arms until every directory was read.
	while (!capped && next < queue.length)
		await Promise.all(
			Array.from({ length: DECLARATION_WALK_CONCURRENCY }, worker),
		);
	if (capped) return undefined;
	// Deterministic, code-unit order (Sonar S2871): `declarations` inserts in
	// this order, so every class `diffDeclarations` emits is in this order. The
	// finished `changes` array is not globally sorted — it is the walk's class
	// first, then the `deleted` class from the previous map — and no consumer
	// reads a position: subscribers key by path and count by type.
	// `compareOrdinal` (the documented comparator for a sort whose output becomes
	// a key), never `localeCompare`, whose answer depends on the machine's locale
	// and ICU build and would order one run's walk differently from another's.
	found.sort(compareOrdinal);
	const declarations = new Map<string, string>();
	// Parallel stats, then one pass into the map: the callback returns its pair
	// so a failed stat is an explicit `undefined` rather than a swallowed
	// statement.
	const prints = await Promise.all(
		found.map(
			async (
				filePath,
			): Promise<[string, string] | [string, undefined] | undefined> => {
				try {
					return [filePath, fingerprint(await fsp.stat(filePath))];
				} catch (err) {
					const code = (err as NodeJS.ErrnoException | undefined)?.code;
					if (code === "ENOENT" || code === "ENOTDIR") {
						// none: gone between the listing and the stat, which is absence,
						// not a failure reading the subtree (the walk's own listing above
						// is what reports an unreadable directory).
						return undefined;
					}
					// Unreadable is not absent: keep the file's identity and let
					// `carryUnreadable` restore its previous fingerprint.
					return [filePath, undefined];
				}
			},
		),
	);
	for (const print of prints) {
		if (print === undefined) continue;
		if (print[1] === undefined) unreadableFiles.push(print[0]);
		else declarations.set(print[0], print[1]);
	}
	return { declarations, unreadable, unreadableFiles };
}

/**
 * Keep the previous fingerprint of every declaration file the walk could not
 * read — one under a directory it could not list, or one it listed and could
 * not stat for a reason other than absence — so the diff sees it as unchanged
 * rather than absent (#4596, #4603 F2).
 *
 * The carried set is bounded by the walk's own file cap: entries that would
 * take the map past it are counted in `dropped` and not added, and the caller
 * then keeps the previous map whole instead of storing a partial one (#4603
 * F5). Neither the map nor the diff can exceed the cap, and no entry the diff
 * would read as deleted leaves the record.
 */
function carryUnreadable(
	declarations: Map<string, string> | undefined,
	previous: ReadonlyMap<string, string> | undefined,
	walk: DeclarationWalk | undefined,
): { carried: number; dropped: number } {
	if (
		!declarations ||
		!previous ||
		!walk ||
		(walk.unreadable.length === 0 && walk.unreadableFiles.length === 0)
	)
		return { carried: 0, dropped: 0 };
	const unreadableFiles = new Set(walk.unreadableFiles);
	const carried: string[] = [];
	for (const filePath of previous.keys()) {
		if (declarations.has(filePath)) continue;
		const underUnreadableDir = walk.unreadable.some((dir) =>
			isUnderDir(filePath, dir),
		);
		if (!underUnreadableDir && !unreadableFiles.has(filePath)) continue;
		carried.push(filePath);
	}
	// Deterministic order: the population that fits the cap must not depend on
	// Map insertion order or on which parallel stat settled first. Same
	// comparator as the walk's, for the same reason. This one orders the stored
	// record, not a payload: a carried entry keeps its previous fingerprint, so
	// it never appears in this round's diff, and a round that drops carried
	// entries past the cap keeps the previous map whole.
	carried.sort(compareOrdinal);
	let dropped = 0;
	for (const filePath of carried) {
		if (declarations.size >= DECLARATION_WALK_MAX_FILES) {
			dropped++;
			continue;
		}
		declarations.set(filePath, previous.get(filePath) as string);
	}
	return { carried: carried.length - dropped, dropped };
}

function diffDeclarations(
	before: ReadonlyMap<string, string>,
	after: ReadonlyMap<string, string>,
): Array<{ filePath: string; type: number }> {
	const changes: Array<{ filePath: string; type: number }> = [];
	for (const [filePath, print] of after) {
		const prior = before.get(filePath);
		if (prior === undefined) changes.push({ filePath, type: 1 });
		else if (prior !== print) changes.push({ filePath, type: 2 });
	}
	for (const filePath of before.keys())
		if (!after.has(filePath)) changes.push({ filePath, type: 3 });
	return changes;
}

/**
 * What a look needs to know beyond its root (#4532).
 */
export interface OutOfBandLookOptions {
	/**
	 * The epoch ms of the earliest live PRIMARY client rooted here. Used only by
	 * a FIRST look of this root (no record yet): an install whose freshest stamp
	 * entry is at or after it restarts those clients, because they spawned
	 * before the root resolved its dependencies. Absent or 0 keeps #4476's rule —
	 * a first look records and changes nothing.
	 */
	since?: number;
	/**
	 * When the declaration walk runs. `"trigger"` (the default) keeps #4476's
	 * rule: a `tool_result` always walks, a `tool_call` walks at most once per
	 * `PI_LENS_DECLARATION_LOOK_MS`. `"interval"` walks at most that often on
	 * every trigger, which is what a look at an EXTRA root uses: the walk is
	 * bounded per root, and the install stamp is what an extra root is looked at
	 * for, so a big worktree's walk cannot run on every bash result. `"always"`
	 * walks on this look whatever the interval says, for a caller that is about
	 * to answer from the servers' view (#4532 gap 5).
	 */
	walk?: "trigger" | "interval" | "always";
	/**
	 * The caller's abort signal (#5005 F3). A caller that already abandoned its
	 * answer looks at nothing: no install stamp, no walk, no publish, and no walk
	 * demand owed to the next look. A caller that abandons the answer while its
	 * look runs stops waiting for it, because an answer nobody reads must not be
	 * held by a walk; the look itself still finishes for any caller joined to it
	 * (see `untilAborted`).
	 *
	 * `| undefined` so a caller can pass its own `AbortSignal | undefined`
	 * through the existing options object without a new
	 * `exactOptionalPropertyTypes` diagnostic (`tools/lsp-diagnostics.ts` does).
	 */
	signal?: AbortSignal | undefined;
}

/**
 * Look at `root` for an install or a declaration-file change since its last
 * look, and publish what changed (see the module doc). Looks of one root run
 * one at a time, each against the record the previous one left (`looks`).
 *
 * The consumers are subscribers of the disk-change publisher (#4535): this
 * detector no longer names the LSP service or the diagnostics cache. `runtime`
 * is the bulk mutation seam the publisher allocates the existing project
 * sequence through; without it the change still reaches every subscriber, but
 * no sequence is allocated.
 *
 * `options.since` is the one way a FIRST look of a root publishes (#4532): it
 * names the epoch of the server that has to re-read the root, so an install
 * that appeared after that server spawned is not mistaken for state it already
 * read.
 */
export function lookForOutOfBandChanges(
	root: string,
	trigger: "tool_call" | "tool_result",
	runtime?: DiskChangeRuntime,
	options: OutOfBandLookOptions = {},
): Promise<void> {
	// #5005 F3: a caller that already abandoned its answer spends nothing at all.
	// Before this guard the answer route's look ran its whole walk for a call
	// whose signal was already aborted, and the batch it was for then answered
	// no file.
	if (options.signal?.aborted) return Promise.resolve();
	// #4905: the home folder (or a folder above it) holds more directories than
	// the declaration walk's cap on any real machine, so each look would spend
	// its time and end capped. Same ceiling as the opaque prescan, `analysis-root`
	// and `jscpd-client` (#4760): the walk is skipped, and said once per session,
	// because a walk that did not run is not a walk that found nothing. Only the
	// walk: the install stamp (one listing and a few stats) is still read and
	// compared, so an install under this root still publishes and restarts the
	// client rooted here.
	// By real path on both sides, as `analysis-root` does (#4689).
	const homeRoot = isAtOrAboveHomeDir(
		realpathOrResolve(root),
		realpathOrResolve(os.homedir()),
	);
	if (homeRoot)
		recordDegradationOnce({
			kind: "lsp-declaration-look-capped",
			subject: "home-root",
			reason:
				"a session root that is the home folder or above it is not walked for declaration files changed outside pi-lens; such a change under it is not looked for (a dependency install still is)",
		});
	const key = normalizeMapKey(root);
	oweDeclarationWalk(root, trigger, options.walk);
	const look = looks.run(key, () =>
		lookOnce(root, key, trigger, runtime, options, homeRoot),
	);
	return untilAborted(look, options.signal);
}

/** The `DiskChange.sources` entry of a server config file change (#4532). */
export const CONFIG_SOURCE = "config";

/** `diffDeclarations`'s watched-files type codes, as the record names them. */
const CHANGE_TYPE = {
	1: "created",
	2: "changed",
	3: "deleted",
} as const;

/**
 * One look's record. `paths` is the population the cache refuses entries for
 * (normalized); `pathChanges` keeps the detector's own spelling for the
 * exact-URI watched-files events. An install cannot be enumerated, so a
 * look that only saw one records `paths: "unknown"`, never an empty list.
 */
function outOfBandChange(
	root: string,
	installed: boolean,
	changes: ReadonlyArray<{ filePath: string; type: number }>,
	configChanges: ReadonlyArray<{ filePath: string; type: number }>,
	at: number,
): DiskChangeInput {
	const sources = [
		...(installed ? ["install"] : []),
		...(changes.length > 0 ? ["declarations"] : []),
		...(configChanges.length > 0 ? [CONFIG_SOURCE] : []),
	];
	const pathChanges = [...changes, ...configChanges].map((change) => ({
		filePath: change.filePath,
		type: CHANGE_TYPE[change.type as 1 | 2 | 3],
	}));
	return {
		root,
		origin: "out-of-band",
		sources,
		// A stat fingerprint, not the bytes: an `inferred` change may never by
		// itself confirm that a finding was not reproduced.
		kind: "inferred",
		// A config file changes the analysis of every file under its root, so it
		// cannot be enumerated any more than an install can: the cache refuses
		// everything scanned before it (`"unknown"`), never just the config path.
		paths:
			configChanges.length > 0
				? "unknown"
				: changes.length > 0
					? changes.map((change) => normalizeMapKey(change.filePath))
					: installed
						? "unknown"
						: [],
		...(pathChanges.length > 0 ? { pathChanges } : {}),
		at,
	};
}

async function lookOnce(
	root: string,
	key: string,
	trigger: "tool_call" | "tool_result",
	runtime: DiskChangeRuntime | undefined,
	options: OutOfBandLookOptions,
	/** The root is the home folder or above it: no declaration walk (#4905). */
	skipWalk: boolean,
): Promise<void> {
	// #4532 gap 6: this pass serves every walk demand written before it
	// started, its own caller's and any joiner's, and takes them before its
	// first await (`owedWalks`). A pass with none walks under the interval rule,
	// as a lone `tool_call` or `"interval"` look does.
	const walkOwed = owedWalks.delete(key);
	const started = Date.now();
	const prior = records.get(key);
	const walkDue =
		!skipWalk &&
		(walkOwed ||
			prior === undefined ||
			started - prior.walkedAt >= declarationLookIntervalMs());
	const [install, walked] = await Promise.all([
		readInstallStamp(root),
		walkDue ? walkDeclarations(root) : Promise.resolve(undefined),
	]);
	const observed = walkDue ? walked : undefined;
	// #4596: a file under a directory this walk could not read — or one it
	// listed and could not stat — keeps the fingerprint the previous walk gave
	// it. The diff then cannot call it deleted, and a real change there is
	// reported by the first walk that can read it again: deferred, never
	// invented and never lost.
	const carry = carryUnreadable(
		observed?.declarations,
		prior?.declarations,
		observed,
	);
	// #4603 F5: when the carried set does not fit the walk's own file cap, the
	// walk is incomplete. Keep the previous map whole (it is at or below the cap
	// by induction) so the stored snapshot can never grow past the cap and the
	// diff cannot read a carried file as deleted.
	const incomplete = carry.dropped > 0;
	const declarations = incomplete
		? prior?.declarations
		: (observed?.declarations ?? prior?.declarations);
	records.set(key, {
		stamp: install.stamp,
		// An unlistable root keeps the previous baseline: reading it as "no
		// config files" would publish every one as created on the next look.
		configs: install.configs ?? prior?.configs,
		declarations,
		walkedAt: walkDue && !incomplete ? started : (prior?.walkedAt ?? started),
	});
	if (walkDue && walked === undefined)
		recordDegradationOnce({
			kind: "lsp-declaration-look-capped",
			subject: key,
			reason: `the declaration-file walk passed ${DECLARATION_WALK_MAX_DIRS} directories or ${DECLARATION_WALK_MAX_FILES} files; declaration files created, edited or deleted outside pi-lens under this root reach no language server and no diagnostics-cache entry is refused for them`,
		});
	const unreadableFiles = observed?.unreadableFiles ?? [];
	if (
		observed &&
		(observed.unreadable.length > 0 || unreadableFiles.length > 0)
	) {
		const firstUnreadable = observed.unreadable[0] ?? unreadableFiles[0];
		incrementDegradationCount({
			kind: "lsp-declaration-walk-unreadable",
			subject: key,
			reason: `${incomplete ? `${carry.dropped} declaration file(s) could not be carried past the ${DECLARATION_WALK_MAX_FILES}-file cap, so the previous walk's map stands; ` : ""}${observed.unreadable.length} unreadable dir(s) and ${unreadableFiles.length} unreadable file(s) under this root, first \`${firstUnreadable}\`; ${carry.carried} declaration file(s) kept their previous fingerprint, so a change there is not read as a deletion`,
			metadata: {
				unreadableDirs: observed.unreadable.length,
				firstUnreadableDir: observed.unreadable[0],
				unreadableFiles: unreadableFiles.length,
				firstUnreadableFile: unreadableFiles[0],
				heldBackDeclarations: carry.carried,
				carriedDropped: carry.dropped,
			},
		});
	}
	// #4532: a root's FIRST look normally records and changes nothing (#4476).
	// When the caller names the epoch of the live server rooted here, an install
	// fresher than that epoch IS the change the server missed — the worktree
	// whose `node_modules` symlink appeared after its server spawned — so the
	// first look publishes it. Without `since`, this is unchanged behaviour.
	const installed =
		prior === undefined
			? firstLookSawInstall(install, options.since)
			: install.stamp !== prior.stamp;
	if (prior === undefined && !installed) return;
	// An incomplete walk (`incomplete`) leaves the record's own map in place, so
	// there is nothing to diff this round.
	const changes =
		walkDue && !incomplete && declarations && prior?.declarations
			? diffDeclarations(prior.declarations, declarations)
			: [];
	const configChanges =
		install.configs && prior?.configs
			? diffServerConfigs(root, prior.configs, install.configs)
			: [];
	if (!installed && changes.length === 0 && configChanges.length === 0) return;
	const at = Date.now();
	// I1: the per-root record is committed above, before any consumer runs.
	ensureDiskChangeSubscribers();
	const { results, failedSubscribers } = await publishDiskChange(
		outOfBandChange(root, installed, changes, configChanges, at),
		runtime,
	);
	// The restart count belongs to the LSP subscriber's own answer; the row
	// keeps reporting it rather than the publisher growing a special case.
	//
	// A consumer that threw is not a consumer that restarted nothing: it never
	// got as far as the look, and `-1` is the same "never answered" the other
	// rows use for `changed`, `held` and `targets` (review round 3, p3-1). The
	// publisher already recorded `disk-change-subscriber-failed` for it.
	const restarted = failedSubscribers.has(LSP_CONSUMER)
		? -1
		: ((results.get(LSP_CONSUMER) as { restarted?: number } | undefined)
				?.restarted ?? 0);
	const count = (type: number) =>
		changes.reduce((n, change) => n + (change.type === type ? 1 : 0), 0);
	logLatency({
		type: "phase",
		phase: "lsp_out_of_band_change",
		filePath: root,
		durationMs: Date.now() - started,
		result: [
			...(installed ? ["install"] : []),
			...(changes.length > 0 ? ["declarations"] : []),
			...(configChanges.length > 0 ? [CONFIG_SOURCE] : []),
		].join("+"),
		metadata: {
			trigger,
			restarted,
			// Which look produced this row: the root's FIRST look (no record yet,
			// so only `since` can make it publish — the #4532 live-client epoch)
			// or a later look compared against the recorded stamp. Both the
			// session-cwd root and a live client's root write the same record,
			// so this names the look, not the caller.
			scope: prior === undefined ? "first-look" : "recorded",
			// #4532 gap 6: the walk served a demand this row's own trigger did not
			// make: a bash result that joined this flight (`owedWalks`).
			joinedWalk: walkOwed && !demandsWalk(trigger, options.walk),
			created: count(1),
			changed: count(2),
			deleted: count(3),
			// The server config files this look forwarded (#4532), by name.
			configs: configChanges.map(
				(change) =>
					`${CHANGE_TYPE[change.type as 1 | 2 | 3]}:${basename(change.filePath)}`,
			),
		},
	});
}
