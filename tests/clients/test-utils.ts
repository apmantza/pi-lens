import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, vi } from "vitest";
import { PROJECT_ROOT_MARKERS } from "../../clients/project-root-markers.js";
import {
	getTmpRootRegistry,
	registerTmpRoot,
} from "../support/tmp-root-registry.js";

// A just-used temp dir can still be written to after the owning test is done:
// a Windows file handle held briefly after a child/watcher/background scan
// exits (AV scanning, delayed handle release, #793, #810), or — measured on
// Linux, #4081 — a grandchild of a SIGKILLed real child still writing under
// the scratch home. An immediate recursive `rm` then throws EPERM/ENOTEMPTY.
// Node's in-call `maxRetries` does not recover that on Node 22 (it stalls
// ~3 s and still throws), so this loops over FRESH `rmSync` calls, each one
// re-walking the directory, for at most REMOVE_BUDGET_MS in total. If the dir
// is STILL there, a leftover temp dir under the OS temp root is harmless (the
// OS reclaims it eventually) while failing the whole test run over teardown
// is not — so the final failure warns instead of throwing. This is the ONE
// shared cleanup helper for test temp dirs (#810's pattern-class rule) —
// route every ad-hoc `fs.rmSync(dir, { recursive: true, force: true })`
// teardown through this instead of hand-rolling retries per suite.
const REMOVE_BUDGET_MS = 2_000;
const REMOVE_RETRY_MS = 50;
// The errnos Node's own `maxRetries` retries; anything else is not transient.
const RETRYABLE_REMOVE_CODES = new Set([
	"EBUSY",
	"EMFILE",
	"ENFILE",
	"ENOTEMPTY",
	"EPERM",
]);
export function removeTempDirSync(dir: string): void {
	const deadline = Date.now() + REMOVE_BUDGET_MS;
	for (;;) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (
				code === undefined ||
				!RETRYABLE_REMOVE_CODES.has(code) ||
				Date.now() >= deadline
			) {
				process.stderr.write(
					`[test cleanup] could not remove temp dir ${dir}: ${
						err instanceof Error ? err.message : String(err)
					}\n`,
				);
				return;
			}
			Atomics.wait(
				new Int32Array(new SharedArrayBuffer(4)),
				0,
				0,
				REMOVE_RETRY_MS,
			);
		}
	}
}

/** The project-root marker every `setupTestEnvironment` root carries unless a
 *  cell opts out (#4560). `.git` is honoured by `findNearestProjectRoot` and is
 *  the marker this suite's own project fixtures already plant
 *  (`makeProject`, `makeWarmableProject`, `writeSourceFiles`), so the shared
 *  default replaces those copies instead of adding a second vocabulary.
 *  An EMPTY directory is not a real Git marker (`isRealGitMarker` requires a
 *  `HEAD`), so the callers of that predicate (`resolveToolCwd`'s formatter cwd,
 *  `ephemeral-root`'s checkout classification) keep answering "not a repo",
 *  while `findNearestProjectRoot` (existence only) sees the fixture as its own
 *  root. `gitleaks-client`'s `hasGitRepo` is a bare existence check, so a
 *  `mode=full` scan now finds a repo in a fixture; the cells that pin that gate
 *  are part of this change.
 *  The directory is also invisible to the tree walks (`.git` is in
 *  `EXCLUDED_DIRS`), so no fixture file count moves.
 *
 *  Recurrence (#4546 / #4559): a bare fixture under `os.tmpdir()` resolved its
 *  project root by walking UP past the fixture. A stray empty `/tmp/.git` on
 *  the dev host made `findNearestProjectRoot` return `/tmp`, so a cell that
 *  saved and read a project snapshot under its fixture saw an empty one and
 *  redded with `expected undefined`. Planting the marker here makes every
 *  fixture its own root. A cell that asserts marker-less resolution passes
 *  `{ rootMarker: false }` and says why. */
export const TEST_FIXTURE_ROOT_MARKER =
	".git" satisfies (typeof PROJECT_ROOT_MARKERS)[number];

/**
 * A fixture root under the OS temp root, returned in its kernel identity
 * (#5439). macOS spells `os.tmpdir()` through `/var`, a link to
 * `/private/var`, and a symlinked `TMPDIR` is spelled through its link.
 * Production canonicalises the paths it reports and keys (`normalizeMapKey`,
 * `realpathSync.native`), so a fixture built under the spelled root compares a
 * different string than the code returns. Same identity rule as
 * {@link setupTestEnvironment} (#5217).
 */
export function mkdtempRealSync(prefix: string): string {
	return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function setupTestEnvironment(
	prefix = "pi-lens-test-",
	options: { rootMarker?: boolean; tmpRoot?: string } = {},
): {
	tmpDir: string;
	cleanup: () => void;
} {
	// macOS exposes its temporary directory through /var, while the kernel
	// identity is /private/var. Keep fixture expectations on that identity so
	// path-utils tests do not compare a pre-realpath spelling with production
	// output (#5217).
	const tmpDir = fs.realpathSync.native(
		fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), prefix)),
	);
	if (options.rootMarker !== false) {
		fs.mkdirSync(path.join(tmpDir, TEST_FIXTURE_ROOT_MARKER), {
			recursive: true,
		});
	}
	activeTestEnvironments.add(tmpDir);
	// #2912: the shared setup removes this root at file teardown and on SIGTERM,
	// so a timeout or a failed assertion before `cleanup()` cannot leak it.
	registerTmpRoot(getTmpRootRegistry(), tmpDir, "registered");
	return {
		tmpDir,
		cleanup: () => {
			removeTempDirSync(tmpDir);
			// Keep the root tracked: deferred work can recreate it before the
			// owning family's cleanup sweep runs.
		},
	};
}

const activeTestEnvironments = new Set<string>();

/**
 * Run `load` with the process's tmp env aimed inside the fixture root. pi's
 * extension loader builds jiti's transform cache as
 * `path.join(os.tmpdir(), "jiti")` for every extension it loads, so an
 * in-process load otherwise leaves a `jiti` directory at the shared tmp root,
 * where the fixture-sibling census judges it (#4641 F1). Inside the fixture it
 * is removed with the fixture. jiti only creates the directory: the built entry
 * imports natively, so the cache stays empty and the redirect costs nothing.
 *
 * Both real-host tiers load through that loader (`tests/support/pi-runner.ts`,
 * `tests/support/pi-session.ts`); this is the one copy they share, so the
 * redirect cannot drift between them (#4664 F6).
 */
export async function withFixtureTmpdir<T>(
	root: string,
	load: () => Promise<T>,
): Promise<T> {
	const isolate = path.join(root, "tmp");
	fs.mkdirSync(isolate, { recursive: true });
	const previous = {
		TMPDIR: process.env.TMPDIR,
		TEMP: process.env.TEMP,
		TMP: process.env.TMP,
	};
	process.env.TMPDIR = isolate;
	process.env.TEMP = isolate;
	process.env.TMP = isolate;
	try {
		return await load();
	} finally {
		if (previous.TMPDIR === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous.TMPDIR;
		if (previous.TEMP === undefined) delete process.env.TEMP;
		else process.env.TEMP = previous.TEMP;
		if (previous.TMP === undefined) delete process.env.TMP;
		else process.env.TMP = previous.TMP;
	}
}

export function cleanupTestEnvironments(
	prefix: string,
	options: { untrack?: boolean } = {},
): void {
	for (const tmpDir of activeTestEnvironments) {
		if (!path.basename(tmpDir).startsWith(prefix)) continue;
		removeTempDirSync(tmpDir);
		if (options.untrack !== false && !fs.existsSync(tmpDir)) {
			activeTestEnvironments.delete(tmpDir);
		}
	}
}

type WriterModule = Record<string, unknown>;

/**
 * Every copy of a writer module a drain has reached, keyed by subsystem. A
 * test that calls `vi.resetModules()` can leave queued writes on an earlier
 * copy (the one its top-level import holds) or on a later one (the one it
 * re-imported), so a drain waits on each copy it has seen, not only the
 * current one.
 */
const seenWriterModules = new Map<string, Set<WriterModule>>();

async function drainWriter(
	name: string,
	load: () => Promise<WriterModule>,
	hooks: readonly string[],
): Promise<void> {
	let copies = seenWriterModules.get(name);
	if (!copies) {
		copies = new Set();
		seenWriterModules.set(name, copies);
	}
	try {
		copies.add(await load());
	} catch {
		// The module failed to load under this file's mocks: nothing new to add.
	}
	for (const mod of copies) {
		for (const hook of hooks) {
			try {
				const fn = mod[hook];
				if (typeof fn === "function") await fn();
			} catch {
				// Mocked without the hook, or the hook failed: nothing to drain.
			}
		}
	}
}

/**
 * Wait for every known background writer that can recreate a fixture root
 * after its test removed it: review-graph persists, project-snapshot body
 * persists, extension-log appends, and the resident jscpd scan (#4505). Each
 * costs nothing when idle.
 *
 * The modules are loaded here, at call time, never at the top of this file,
 * so a file that never touched a writer pays only the import. Skipped under
 * fake timers; restore real timers first.
 *
 * Gap: a copy is only seen once a drain runs while it is the current copy. A
 * file that resets modules before its first drain, while its top-level import
 * still has writes queued, must drain that copy itself.
 */
export async function drainBackgroundWritesForTests(): Promise<void> {
	// The waits poll on `setTimeout`, which never fires under fake timers.
	if (vi.isFakeTimers()) return;
	await drainWriter(
		"review-graph",
		() => import("../../clients/review-graph/builder.js"),
		["flushReviewGraphPersistsForTests", "waitForReviewGraphPersistsForTests"],
	);
	await drainWriter(
		"project-snapshot",
		() => import("../../clients/project-snapshot.js"),
		["waitForProjectSnapshotPersistsForTests"],
	);
	await drainWriter(
		"extension-log",
		() => import("../../clients/extension-log.js"),
		["flushExtensionLog"],
	);
	// #4505: a session_start jscpd scan is fire-and-forget, so a file that ends
	// right after its last turn strands the report directory (the 4403 cascade
	// file, in the pre-push batch). Every drained cleanup waits for it.
	await drainResidentJscpdScans();
}

/**
 * Drain in-flight jscpd scans started by the resident analyzer bootstrap before
 * a test removes its fixture roots (#4133). A session-start jscpd scan is
 * fire-and-forget; if the test file ends while one is still running, Vitest
 * SIGTERMs the worker before the scan's `finally` removes its report directory
 * and the `pi-lens-jscpd-*` entry is stranded in the shared tmpdir. The
 * `JscpdClient.shutdown()` barrier (#3338) waits for it. `peek` resolves the
 * already-loaded client without forcing a load, and the method is optional so a
 * stub bootstrap double is a no-op rather than a crash.
 */
export async function drainResidentJscpdScans(): Promise<void> {
	const { peekBootstrapClients } = await import("../../clients/bootstrap.js");
	const client = peekBootstrapClients()?.jscpdClient as
		| { shutdown?: () => Promise<void> }
		| undefined;
	await client?.shutdown?.();
}

/**
 * Drain deferred fixture producers before the final cleanup pass. Keeping
 * roots tracked until the last tick preserves the hygiene sweep's handle.
 * The known background writers are drained first unless `drainWrites` is
 * false.
 */
export async function cleanupTestEnvironmentsDrained(
	prefix: string,
	options: {
		beforeDrain?: () => Promise<void>;
		drainWrites?: boolean;
	} = {},
): Promise<void> {
	await options.beforeDrain?.();
	if (options.drainWrites !== false) await drainBackgroundWritesForTests();
	for (let tick = 0; tick < 3; tick++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (tick === 2) {
			// The final producer turn can be queued by the preceding drain.
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		cleanupTestEnvironments(prefix, { untrack: tick === 2 });
	}
}

/**
 * Register an `afterEach` that drains and removes every root created through
 * `setupTestEnvironment` with one of `prefixes`. Call it at file or describe
 * scope, and create the file's temp roots with `setupTestEnvironment`.
 */
export function useTrackedTempDirs(...prefixes: string[]): void {
	afterEach(async () => {
		// The drain below parks on `setImmediate`, which a fake-timer test has
		// replaced. Vitest runs `afterEach` hooks in reverse registration order, so
		// this hook runs BEFORE the file's own `vi.useRealTimers()` teardown and
		// hung to the 10 s hook timeout, failing the faking test and every test
		// after it (launch.test.ts on Windows, #4019). Restore the real clock first.
		vi.useRealTimers();
		for (const prefix of prefixes) await cleanupTestEnvironmentsDrained(prefix);
	});
}

/**
 * A file reachable under TWO spellings that differ only in case, where the
 * kernel reports the on-disk spelling for both — the exact contract
 * `normalizeFilePath`'s POSIX arm depends on (#3098, the live half of #1024:
 * a raw mis-cased `lens_diagnostic_mark` write and a `normalizeMapKey` read
 * deriving two anchors for one file, so the agent's own mark never applies).
 *
 * Built natively where the filesystem is case-insensitive (macOS APFS/HFS+,
 * Windows, `nocase` vfat/ntfs3/cifs). On a case-sensitive filesystem — the
 * ubuntu Unit tests lane — the same observable contract is manufactured with a
 * case-variant symlink (`SUB` → `sub`): `existsSync(SUB/a.ts)` is true and
 * `realpathSync.native` returns `sub/a.ts`, byte-identical to what APFS
 * answers, so the seam under test cannot tell the two fixtures apart and the
 * guard runs on EVERY lane instead of skipping on the one CI actually has.
 *
 * `skipReason` is set — and the case cases must skip visibly — only where the
 * kernel cannot supply that contract: a Linux ext4/tmpfs casefold directory
 * aliases the spellings but `realpath(3)` returns the QUERIED casing (measured
 * in #3154), so there is nothing for the normalizer to canonicalize toward.
 */
export function createCaseAliasFixture(
	baseDir: string,
	options: { dirName?: string; fileName?: string; content?: string } = {},
): {
	/** Mis-cased spelling, as a raw `path.resolve(cwd, arg)` would carry it. */
	rawMisCased: string;
	/** The spelling really on disk. */
	onDisk: string;
	/** Set when this filesystem cannot report on-disk casing (see above). */
	skipReason?: string;
} {
	const dirName = options.dirName ?? "sub";
	const fileName = options.fileName ?? "a.ts";
	const onDiskDir = path.join(baseDir, dirName);
	fs.mkdirSync(onDiskDir, { recursive: true });
	const onDisk = path.join(onDiskDir, fileName);
	fs.writeFileSync(onDisk, options.content ?? "const target = bad();\n");

	const misCasedDir = path.join(baseDir, dirName.toUpperCase());
	const rawMisCased = path.join(misCasedDir, fileName);
	if (!fs.existsSync(rawMisCased)) {
		try {
			fs.symlinkSync(dirName, misCasedDir, "dir");
		} catch (err) {
			return {
				rawMisCased,
				onDisk,
				skipReason: `cannot alias ${dirName} as ${dirName.toUpperCase()}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			};
		}
	}
	let canonical: string | undefined;
	try {
		canonical = fs.realpathSync.native(rawMisCased);
	} catch {
		canonical = undefined;
	}
	return canonical === undefined || canonical === rawMisCased
		? {
				rawMisCased,
				onDisk,
				skipReason:
					"filesystem aliases the two spellings but reports the QUERIED casing, " +
					"not the on-disk one (Linux casefold directory) — refs #3154",
			}
		: { rawMisCased, onDisk };
}

/** The spellings {@link createPathIdentityFixture} plants, all absolute. */
export interface PathIdentityFixture {
	/** The real repository root. */
	repo: string;
	/** `repo-alias` -> `repo`: a link-spelled session root (case h). */
	aliasRoot: string;
	/** `repo/src/real.ts`, a regular file. */
	realFile: string;
	/** `repo/src/link.ts` -> `real.ts`: a file link in the root (case b). */
	fileLink: string;
	/** `repo/CLAUDE.md`, the target of {@link agentsLink}. */
	claudeMd: string;
	/** `repo/AGENTS.md` -> `CLAUDE.md`: the everyday markdown link (case a). */
	agentsLink: string;
	/** `repo/shared/util.ts`, reached through {@link dirLinkFile}. */
	sharedFile: string;
	/** `repo/src/linked/util.ts`, where `src/linked` -> `../shared` (case c). */
	dirLinkFile: string;
	/** `outside/ext.ts`, a file outside the repository. */
	outsideFile: string;
	/** `repo/src/out-link.ts` -> `../../outside/ext.ts`: a link out of the root (case d1). */
	outLink: string;
	/** Set when this host cannot create symlinks; the cell must skip visibly. */
	skipReason?: string;
}

/**
 * The #4689 symlinked-fixture family: one real repository and every link
 * spelling pi-lens must key by path identity, the kernel-real path. Each
 * shape names the defect its cells guard: a file link and a directory link
 * split one file into two records (shape 1, divergent path keys), a link out
 * of the root crosses the analysis-root class, and an alias root spells every
 * in-root file differently from its identity. `baseDir` should be a
 * `setupTestEnvironment` root so the shared hygiene owner removes it. The
 * other-worktree and unrelated-repository members are opt-in plants
 * ({@link plantOtherWorktree}, {@link plantUnrelatedRepo}), kept out of this
 * function for the reason {@link plantPackageLink} gives.
 */
export function createPathIdentityFixture(
	baseDir: string,
): PathIdentityFixture {
	const repo = path.join(baseDir, "repo");
	const outside = path.join(baseDir, "outside");
	fs.mkdirSync(path.join(repo, "src"), { recursive: true });
	fs.mkdirSync(path.join(repo, "shared"), { recursive: true });
	fs.mkdirSync(outside, { recursive: true });
	const realFile = path.join(repo, "src", "real.ts");
	const claudeMd = path.join(repo, "CLAUDE.md");
	const sharedFile = path.join(repo, "shared", "util.ts");
	const outsideFile = path.join(outside, "ext.ts");
	fs.writeFileSync(realFile, "export const real = 1;\n");
	fs.writeFileSync(claudeMd, "# Agents\n");
	fs.writeFileSync(sharedFile, "export const util = 1;\n");
	fs.writeFileSync(outsideFile, "export const ext = 1;\n");
	const fixture: PathIdentityFixture = {
		repo,
		aliasRoot: path.join(baseDir, "repo-alias"),
		realFile,
		fileLink: path.join(repo, "src", "link.ts"),
		claudeMd,
		agentsLink: path.join(repo, "AGENTS.md"),
		sharedFile,
		dirLinkFile: path.join(repo, "src", "linked", "util.ts"),
		outsideFile,
		outLink: path.join(repo, "src", "out-link.ts"),
	};
	try {
		fs.symlinkSync("real.ts", fixture.fileLink, "file");
		fs.symlinkSync("CLAUDE.md", fixture.agentsLink, "file");
		fs.symlinkSync(
			path.join("..", "shared"),
			path.join(repo, "src", "linked"),
			"dir",
		);
		fs.symlinkSync(
			path.join("..", "..", "outside", "ext.ts"),
			fixture.outLink,
			"file",
		);
		fs.symlinkSync("repo", fixture.aliasRoot, "dir");
	} catch (err) {
		fixture.skipReason = `cannot create symlinks here: ${
			err instanceof Error ? err.message : String(err)
		}`;
	}
	return fixture;
}

/** The cross-package link {@link plantPackageLink} adds to a fixture repo. */
export interface PackageLinkFixture {
	/** `repo/pkg-a`, a package with its own `package.json`. */
	pkgA: string;
	/** `repo/pkg-b`, a package with its own `package.json`. */
	pkgB: string;
	/** `repo/pkg-b/b.ts`, a regular file. */
	realFile: string;
	/** `repo/pkg-a/src/blink.ts` -> `../../pkg-b/b.ts`: a file in package A that is package B's. */
	fileLink: string;
	/** `repo/pkg-b/lib/lib.ts`, a regular file in a directory of package B. */
	libFile: string;
	/** `repo/pkg-a/lib` -> `../pkg-b/lib`: a directory in package A that is package B's. */
	dirLink: string;
	/** Set when this host cannot create symlinks; the cell must skip visibly. */
	skipReason?: string;
}

/**
 * The #4689 item 6 member of the symlinked-fixture family: a file link from
 * one package into another. Walking up from the link's SPELLING reaches
 * `pkg-a`'s markers, walking up from the file's identity reaches `pkg-b`'s,
 * so a marker walk or a child cwd chosen from the spelling runs the wrong
 * package's tool config (shape 1, divergent path keys). Kept out of
 * {@link createPathIdentityFixture} so the cells that count the repo's files
 * do not see two more packages.
 */
export function plantPackageLink(repo: string): PackageLinkFixture {
	const pkgA = path.join(repo, "pkg-a");
	const pkgB = path.join(repo, "pkg-b");
	fs.mkdirSync(path.join(pkgA, "src"), { recursive: true });
	fs.mkdirSync(pkgB, { recursive: true });
	fs.writeFileSync(path.join(pkgA, "package.json"), "{}\n");
	fs.writeFileSync(path.join(pkgB, "package.json"), "{}\n");
	const realFile = path.join(pkgB, "b.ts");
	fs.writeFileSync(realFile, "export const b = 1;\n");
	const libFile = path.join(pkgB, "lib", "lib.ts");
	fs.mkdirSync(path.dirname(libFile), { recursive: true });
	fs.writeFileSync(libFile, "export const lib = 1;\n");
	const fixture: PackageLinkFixture = {
		pkgA,
		pkgB,
		realFile,
		fileLink: path.join(pkgA, "src", "blink.ts"),
		libFile,
		dirLink: path.join(pkgA, "lib"),
	};
	try {
		fs.symlinkSync(
			path.join("..", "..", "pkg-b", "b.ts"),
			fixture.fileLink,
			"file",
		);
		fs.symlinkSync(path.join("..", "pkg-b", "lib"), fixture.dirLink, "dir");
	} catch (err) {
		fixture.skipReason = `cannot create symlinks here: ${
			err instanceof Error ? err.message : String(err)
		}`;
	}
	return fixture;
}

/**
 * A checkout with one linked worktree, written as git writes it: `<repo>/.git`
 * is a directory (the shared commondir), `<worktree>/.git` is a file holding
 * `gitdir: <repo>/.git/worktrees/<name>`, that gitdir's `commondir` points
 * back at the shared `.git`, and each gitdir holds a `HEAD`.
 * `resolveGitCheckout`/`resolveLinkedWorktreeOwner` read exactly these files,
 * so no `git` child is needed to classify the file. The layout is
 * `<root>/repo` and `<root>/repo-wt`.
 */
export function writeLinkedWorktree(root: string): {
	repo: string;
	worktree: string;
} {
	const repo = path.join(root, "repo");
	const worktree = path.join(root, "repo-wt");
	const gitDir = path.join(repo, ".git");
	const linkedGitDir = path.join(gitDir, "worktrees", "repo-wt");
	fs.mkdirSync(linkedGitDir, { recursive: true });
	fs.mkdirSync(worktree, { recursive: true });
	fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
	fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${linkedGitDir}\n`);
	fs.writeFileSync(path.join(linkedGitDir, "commondir"), "../..\n");
	// git writes a HEAD in both gitdirs, and a `.git` directory without one is
	// not a repository to `resolveGitCheckout` (#4508).
	fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
	fs.writeFileSync(path.join(linkedGitDir, "HEAD"), "ref: refs/heads/wt\n");
	return { repo, worktree };
}

/** The other-worktree member {@link plantOtherWorktree} adds to a fixture. */
export interface OtherWorktreeFixture {
	/** `repo-wt`, a linked worktree of the fixture's `repo` checkout. */
	worktree: string;
	/** `repo-wt/src/wt.ts`, a regular file in that worktree. */
	worktreeFile: string;
	/** `repo/src/wt-link.ts` -> `../../repo-wt/src/wt.ts`: spelled in the session root, owned by the other worktree. */
	worktreeLink: string;
	/** Set when this host cannot create symlinks; the cell must skip visibly. */
	skipReason?: string;
}

/**
 * The #4689 item 10 other-worktree member: a file link from the session's
 * checkout into a LINKED WORKTREE of it. Its spelling sits under the session
 * root, its identity under the worktree root, so a class decided from the
 * spelling reads `session` where the identity reads `linked-worktree`
 * (shape 1, divergent path keys, across the analysis-root class). `baseDir`
 * is the one {@link createPathIdentityFixture} was given: `repo` is its
 * checkout. Opt-in because it turns `repo` into a git checkout, which the
 * cells that count the repo's files do not expect.
 */
export function plantOtherWorktree(baseDir: string): OtherWorktreeFixture {
	const { repo, worktree } = writeLinkedWorktree(baseDir);
	const worktreeFile = path.join(worktree, "src", "wt.ts");
	fs.mkdirSync(path.dirname(worktreeFile), { recursive: true });
	fs.writeFileSync(worktreeFile, "export const wt = 1;\n");
	const fixture: OtherWorktreeFixture = {
		worktree,
		worktreeFile,
		worktreeLink: path.join(repo, "src", "wt-link.ts"),
	};
	try {
		fs.mkdirSync(path.join(repo, "src"), { recursive: true });
		fs.symlinkSync(
			path.join("..", "..", "repo-wt", "src", "wt.ts"),
			fixture.worktreeLink,
			"file",
		);
	} catch (err) {
		fixture.skipReason = `cannot create symlinks here: ${
			err instanceof Error ? err.message : String(err)
		}`;
	}
	return fixture;
}

/** The unrelated-repository member {@link plantUnrelatedRepo} adds to a fixture. */
export interface UnrelatedRepoFixture {
	/** `unrelated`, a git checkout sharing no history or worktree with `repo`. */
	unrelatedRepo: string;
	/** `unrelated/src/other.ts`, a regular file in that repository. */
	unrelatedFile: string;
	/** `repo/src/other-link.ts` -> `../../unrelated/src/other.ts`: spelled in the session root, owned by another project. */
	unrelatedLink: string;
	/** Set when this host cannot create symlinks; the cell must skip visibly. */
	skipReason?: string;
}

/**
 * The #4689 item 10 unrelated-repository member: a file link from the
 * session's checkout into a DIFFERENT repository. Its identity is a foreign
 * project, so a class decided from the spelling would treat the foreign file
 * as the session's own (shape 1, across the analysis-root class). The session
 * repo gets a `.git` too, so the member compares two checkouts. Whether the
 * foreign project reads `adopted` or `none` is the host's temp-root rule
 * (#4560): give `baseDir` a name without the `pi-lens-` prefix for `adopted`.
 */
export function plantUnrelatedRepo(baseDir: string): UnrelatedRepoFixture {
	const unrelatedRepo = path.join(baseDir, "unrelated");
	const unrelatedFile = path.join(unrelatedRepo, "src", "other.ts");
	fs.mkdirSync(path.dirname(unrelatedFile), { recursive: true });
	fs.mkdirSync(path.join(unrelatedRepo, ".git"), { recursive: true });
	fs.writeFileSync(
		path.join(unrelatedRepo, ".git", "HEAD"),
		"ref: refs/heads/main\n",
	);
	fs.writeFileSync(path.join(unrelatedRepo, "package.json"), "{}\n");
	fs.writeFileSync(unrelatedFile, "export const other = 1;\n");
	const repo = path.join(baseDir, "repo");
	// The session repo is a checkout too, so the cell compares two checkouts
	// (`resolveLinkedWorktreeOwner` answers null) and not "no checkout". A
	// `.git` directory without a HEAD is not a repository (#4508).
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
	const fixture: UnrelatedRepoFixture = {
		unrelatedRepo,
		unrelatedFile,
		unrelatedLink: path.join(repo, "src", "other-link.ts"),
	};
	try {
		fs.mkdirSync(path.join(repo, "src"), { recursive: true });
		fs.symlinkSync(
			path.join("..", "..", "unrelated", "src", "other.ts"),
			fixture.unrelatedLink,
			"file",
		);
	} catch (err) {
		fixture.skipReason = `cannot create symlinks here: ${
			err instanceof Error ? err.message : String(err)
		}`;
	}
	return fixture;
}

export function createTempFile(
	baseDir: string,
	relativePath: string,
	content: string,
): string {
	const filePath = path.join(baseDir, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	return filePath;
}

/**
 * The worker-owned parent of every pinned fixture HOME (#4591): outside every
 * root the harness deletes, outside the OS tmp root the census watches, and
 * beside the worker's own home rather than inside it.
 *
 * `vitest-setup.ts` publishes the resolved path on
 * `PI_LENS_TMP_HYGIENE_FIXTURE_HOME` before any test module loads and removes
 * this directory at its teardown; the name carries the worker-home prefix so
 * the run's dead-worker sweep reclaims a killed run's copy too. It is a SIBLING
 * of the worker home on purpose: production classifies a path under
 * `PI_LENS_HOME` as pi-lens's own housekeeping (`isPiLensInternalPath`) and
 * refuses to adopt it as a project, so a fixture HOME there would silently
 * change what the write path does with the files under it.
 *
 * The published value is the identity the teardown removes (#4591). Deriving
 * it again from `PI_LENS_TMP_HYGIENE_RUN_ID` at teardown time would answer with
 * a different directory after any in-process mutation of that variable (the
 * census suite mutates it on purpose), and the directories a case created would
 * then be reclaimed only by the run's six-hour sweep arm. The fallback below
 * exists for a harness that publishes the run-shared home only; with neither
 * variable set there is no place to put a fixture home, and the caller hears it.
 */
export function fixtureHomeRoot(): string {
	const published = process.env.PI_LENS_TMP_HYGIENE_FIXTURE_HOME?.trim();
	if (published) return path.resolve(published);
	const sharedHome = process.env.PI_LENS_TMP_HYGIENE_HOME?.trim();
	if (!sharedHome) {
		throw new Error(
			"fixtureHomeRoot() needs PI_LENS_TMP_HYGIENE_FIXTURE_HOME (or the run-shared PI_LENS_TMP_HYGIENE_HOME the vitest setup publishes) — a fixture home has no place to live outside the harness's own scratch root",
		);
	}
	return fixtureHomeRootIn(
		sharedHome,
		process.env.PI_LENS_TMP_HYGIENE_RUN_ID ?? "local",
		process.pid,
	);
}

/**
 * The ONE spelling of a worker's fixture-home root: `worker-home-<run>-<pid>-`
 * then `-fixtures`, under the run-shared home. The run's dead-worker sweep
 * matches the `worker-home-<run>-` family, so a killed worker's copy is
 * reclaimed with its own worker home.
 *
 * `vitest-setup.ts` publishes the value it derives from THIS worker's own
 * identity, never whatever the environment already holds (#4591 V1): a nested
 * Vitest child inherits the parent's whole environment, and a child that
 * published its parent's root removed that root — and every HOME pinned inside
 * it — at its own teardown. `fixtureHomeRoot()`'s fallback derives the same
 * name, so a worker with no inherited value still gets its own root.
 */
export function fixtureHomeRootIn(
	sharedHome: string,
	runId: string,
	pid: number,
): string {
	return path.join(
		path.resolve(sharedHome),
		`worker-home-${runId}-${pid}-fixtures`,
	);
}

/**
 * Point `os.homedir()` at a fresh fixture HOME and return it with its undo.
 *
 * `homedir()` reads `HOME` (Windows: `USERPROFILE`) on every call, so pinning
 * both is what makes a `~` path expand into this directory instead of the
 * maintainer's real home. Every call site restores in its own `finally`, and
 * the harness restores whatever is left at the end of the case
 * ({@link restorePinnedFixtureHomes}, called by `vitest-setup.ts`'s
 * `afterEach`): a setup step that throws between the pin and that `finally`
 * would otherwise leave the next case reading a fixture directory (#4591).
 *
 * The home deliberately does NOT live inside the fixture root (#4591). A child
 * the test never awaits inherits HOME and `cwd`, and a write it lands after the
 * file's teardown sweep re-creates a root the harness already removed: on
 * Windows `pi-lens-4577-resolver-cqF0yk` was still there three minutes later,
 * `registered=0 stragglers=0 failed=0` at its own sweep, for the census to red.
 * No sweep can remove a root a foreign process re-creates, so the home is
 * placed where nothing deletes it out from under a straggler and where the
 * tmp-root census never looks. Create the files the test needs under the
 * returned `home`.
 *
 * `slug` only names the directory, so a leftover is attributable to its file.
 */
export function pinFixtureHome(slug: string): {
	home: string;
	restore: () => void;
} {
	const base = fixtureHomeRoot();
	fs.mkdirSync(base, { recursive: true });
	// A counted name, not `mkdtempSync`: the census sweep over `mkdtemp` parents
	// (`tests/config/tmp-fixture-hygiene.test.ts`) admits tmpdir-, repo- and
	// scratch-rooted parents only, and this one is the worker's own scratch,
	// removed by the setup's teardown. The run id and pid in `base` already
	// separate workers, so a per-process count is all the uniqueness needed.
	fixtureHomeSeq += 1;
	const home = path.join(base, `${slug}-${process.pid}-${fixtureHomeSeq}`);
	fs.mkdirSync(home, { recursive: true });
	const undo = pinHome(home);
	let restored = false;
	const restore = () => {
		if (restored) return;
		restored = true;
		const index = pendingFixtureHomeRestores.indexOf(restore);
		if (index >= 0) pendingFixtureHomeRestores.splice(index, 1);
		undo();
	};
	pendingFixtureHomeRestores.push(restore);
	return { home, restore };
}

/** One counter per worker process; `fixtureHomeRoot()` separates runs. */
let fixtureHomeSeq = 0;

/** Pins this case has not undone yet, oldest first. */
const pendingFixtureHomeRestores: Array<() => void> = [];

/**
 * Undo every {@link pinFixtureHome} pin still in effect, newest first. The
 * harness calls this from its per-test `afterEach` (`vitest-setup.ts`), so a
 * case that throws between the pin and its own fixture work cannot leave HOME
 * pointed at a fixture directory for the next case: the call-site `finally`
 * never ran, and the home outlives it. A pin a call site already restored has
 * deregistered itself, so this is a no-op for the ordinary path.
 */
export function restorePinnedFixtureHomes(): void {
	while (pendingFixtureHomeRestores.length > 0) {
		const restore = pendingFixtureHomeRestores.pop();
		restore?.();
	}
}

/** The raw environment pin `pinFixtureHome` returns; not exported, so no call
 *  site can pin a home inside a root its own teardown deletes (#4591). */
function pinHome(home: string): () => void {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	return () => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
	};
}

/** How a connect to a Unix socket path ends: `connected` when a server
 *  listens there, otherwise the errno code (a stale socket or a regular file
 *  refuses with `ECONNREFUSED`). */
export function connectOutcome(endpoint: string): Promise<string> {
	return new Promise((resolve) => {
		const probe = net.createConnection(endpoint);
		probe.once("connect", () => {
			probe.destroy();
			resolve("connected");
		});
		probe.once("error", (error) =>
			resolve((error as NodeJS.ErrnoException).code ?? String(error)),
		);
	});
}

/** Leave a stale Unix socket file at `file`, as a killed host does, without a
 *  child process: bind, move the file aside so the close-time unlink finds
 *  nothing, close the listener, move the file back. */
export async function plantStaleUnixSocket(file: string): Promise<void> {
	const parked = `${file}.parked`;
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(file, resolve);
	});
	fs.renameSync(file, parked);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	fs.renameSync(parked, file);
}
