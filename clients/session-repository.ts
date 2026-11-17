/**
 * Which bytes belong to the session's own repository (#4530).
 *
 * One question, asked by every lookup that may start a file pi-lens did not
 * name itself: is this file (or this search-path directory) the session
 * repository's own bytes? Under pi trust other than `trusted`, those bytes
 * never answer a lookup. `isUntrustedProjectPath` is the judgment; the spawn
 * seam (`clients/safe-spawn.ts`), the global-bin lookup
 * (`clients/package-manager.ts`) and the LSP launcher ask it.
 *
 * The identity is fixed, never threaded by a caller: the session root is this
 * process's cwd, the one root pi's trust answer is about. A path is the
 * session repository's when its KERNEL-REAL path (realpath of the spelling,
 * no lexical `..` collapse first) is not in pi-lens's own data dir and:
 *
 * - lies at or under the session root, or
 * - lies under a project-local bin dir of an ancestor of the session root
 *   below HOME (a monorepo's hoisted `node_modules/.bin`), or
 * - belongs to a checkout that shares the session checkout's git commondir,
 *   when that checkout's root is not HOME or above: the session's own checkout above
 *   a subdirectory session, the main checkout, every linked worktree, and a
 *   `node_modules` linked into any of them.
 *
 * HOME is the ceiling throughout, the same one the project-local bin walk
 * stops at (#2514): a session started in HOME or above it owns nothing, and a
 * dotfiles repository rooted at HOME must not turn `~/.local/bin` into project
 * bytes. A session outside HOME (`/tmp/x`, `/srv/app`) is a project like any
 * other.
 *
 * This module sits beside the analysis-root class seam
 * (`clients/analysis-root.ts`) and reads the same git identity
 * (`review-graph/git-identity.ts`), but cannot live in it: `safe-spawn.ts`
 * imports this, and `analysis-root.ts` imports `file-utils.ts`, which imports
 * `safe-spawn.ts`. It imports only leaves.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	isAtOrAboveHomeDir,
	isWithinForm,
	normalizeEphemeralMapKey,
	normalizeFilePath,
	normalizePathSpelling,
	realpathOrResolve,
	walkUpDirs,
} from "./path-utils.js";
import { PathKeyedMap } from "./path-keyed-map.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { logExtension } from "./extension-log.js";
import { machineStateDir } from "./probe-home-state.js";
import { getProjectTrustState } from "./project-trust.js";
import { resolveGitCheckout } from "./review-graph/git-identity.js";

/**
 * The project-local bin-directory shapes in this repo, most-preferred first.
 * Exported so every caller passes the SAME constant instead of re-listing the
 * directory names next to its own copy of the walk — the venv list alone had
 * three independent spellings before #2544 review F1 (`formatters.ts`,
 * `runner-helpers.ts`'s `createVenvFinder`, `dead-code-client.ts`'s
 * `venvCandidates`). `clients/package-manager.ts` re-exports them.
 *
 * `VENV_BIN_DIRS` lists BOTH the POSIX (`bin`) and Windows (`Scripts`) layouts
 * unconditionally rather than branching on `process.platform` at module load:
 * a module-load platform constant cannot be forced per test, so the other
 * branch is never exercised on the ubuntu lane (defect shape 30). The extra
 * two `existsSync` calls per directory are the price of a testable list, and
 * a `.venv/Scripts` on Linux (or `.venv/bin` under msys) resolves correctly
 * instead of being invisible.
 */
export const NODE_MODULES_BIN_DIRS: readonly string[] = [
	path.join("node_modules", ".bin"),
];
export const VENDOR_BIN_DIRS: readonly string[] = [path.join("vendor", "bin")];
export const VENV_BIN_DIRS: readonly string[] = [
	path.join(".venv", "bin"),
	path.join("venv", "bin"),
	path.join(".venv", "Scripts"),
	path.join("venv", "Scripts"),
];

/**
 * The launcher extension each project bin dir holds on Windows (#5410 S1 F2).
 * One registry `windowsExt` cannot serve both: pip writes `<venv>/Scripts/x.exe`,
 * npm writes `node_modules/.bin/x.cmd`. The walker tries a mapped dir's own
 * extension first, then the caller's `windowsExt` (a bun `.exe` shim in
 * `node_modules/.bin`), then the bare name; a dir not named here keeps the
 * caller's `windowsExt` alone.
 */
export const PROJECT_BIN_DIR_WINDOWS_EXT: Readonly<Record<string, string>> =
	Object.fromEntries([
		...VENV_BIN_DIRS.map((dir): [string, string] => [dir, ".exe"]),
		...NODE_MODULES_BIN_DIRS.map((dir): [string, string] => [dir, ".cmd"]),
	]);

/** Every project-local bin layout supported by the canonical resolver. */
export const PROJECT_LOCAL_BIN_DIRS: readonly string[] = [
	...NODE_MODULES_BIN_DIRS,
	...VENDOR_BIN_DIRS,
	...VENV_BIN_DIRS,
];

/** Every project-local bin dir of `dir` and of its ancestors below HOME. */
export function* projectLocalBinDirs(
	dir: string,
	home: string = os.homedir(),
): Generator<string> {
	// Spelled by design (#4689 item 6): this is the trust classifier's half of
	// the resolver/classifier pair (`localBinMatches` climbs the same axis). An
	// identity bin dir holds neither the alias spelling of a project shim nor
	// the shim's target, so the project's own binary would stop counting as
	// project-local and the trust refusal keyed on it would stop applying.
	for (const ancestor of walkUpDirs(dir, { spelling: true, homeDir: home })) {
		for (const binDir of PROJECT_LOCAL_BIN_DIRS)
			yield path.join(ancestor, binDir);
	}
}

/**
 * The session-repository judgment for the current session, as one predicate:
 * the session root, HOME, the data dir and the session checkout are read once
 * per judge, so a caller judging every entry of a search path pays for them
 * once. A judge is for one decision; it is never cached across calls, because
 * every input can change between decisions. See the module header for the rule.
 */
export function sessionRepositoryJudge(): (target: string) => boolean {
	const home = realpathOrResolve(os.homedir());
	const session = realpathOrResolve(process.cwd());
	if (isAtOrAboveHomeDir(session, home)) return () => false;
	const sessionForm = pathForm(session);
	const dataDirForm = pathForm(realpathOrResolve(machineStateDir()));
	// Only bin dirs that exist can hold a file; resolving the missing ones
	// would cost a failed `realpath` per missing segment, per judge.
	const binDirForms = [...projectLocalBinDirs(session, home)]
		.filter((dir) => fs.existsSync(dir))
		.map((dir) => pathForm(realpathOrResolve(dir)));
	let sessionCheckout: ReturnType<typeof resolveGitCheckout> | undefined;
	// Keyed by `pathForm`, not `normalizeMapKey` (#4776 verify V2): the keys
	// are already kernel-real, and `normalizeMapKey` folds a POSIX backslash
	// (a name character there) into a separator, so `tools\wt` and `tools/wt`
	// shared one memo entry and the second answered from the first. It also
	// re-ran `realpath` on every read of a memo that exists to avoid I/O.
	const ownerByDir = new PathKeyedMap<string | null>(pathForm);
	return (target) => {
		const real = realpathOrResolve(target);
		const form = pathForm(real);
		if (isWithinForm(form, dataDirForm)) return false;
		if (isWithinForm(form, sessionForm)) return true;
		if (binDirForms.some((binDir) => isWithinForm(form, binDir))) return true;
		sessionCheckout ??= resolveGitCheckout(session);
		if (!sessionCheckout || isAtOrAboveHomeDir(sessionCheckout.root, home))
			return false;
		return ownerCommonDirForm(real) === pathForm(sessionCheckout.commonDir);
	};

	/**
	 * The commondir (in {@link pathForm}) of the checkout owning `real`, or
	 * `null`. Walks up to the first directory holding a `.git` entry and asks
	 * the git identity seam about that one directory. The answers are kept for
	 * this judge only: the entries of one search path share most ancestors
	 * (`/usr`, HOME, `/`), so a judge stats each directory once rather than once
	 * per entry, and a missing `.git` costs one non-throwing existence check.
	 */
	function ownerCommonDirForm(real: string): string | null {
		const walked: string[] = [];
		let answer: string | null = null;
		for (const dir of walkUpDirs(real)) {
			const known = ownerByDir.get(dir);
			if (known !== undefined) {
				answer = known;
				break;
			}
			walked.push(dir);
			if (!hasGitEntry(dir)) continue;
			const owner = resolveGitCheckout(dir);
			// The HOME ceiling holds for the owning checkout too (#4776 verify
			// V4): HOME as a linked worktree of the session repository must not
			// make `~/.local/bin` project bytes.
			answer =
				owner && !isAtOrAboveHomeDir(owner.root, home)
					? pathForm(owner.commonDir)
					: null;
			break;
		}
		for (const dir of walked) ownerByDir.set(dir, answer);
		return answer;
	}
}

/**
 * Whether `dir` holds a `.git` entry (a directory or a worktree's file).
 * `existsSync` does not throw: a missing entry, or a `dir` that is a file,
 * is simply `false`.
 */
function hasGitEntry(dir: string): boolean {
	return fs.existsSync(path.join(dir, ".git"));
}

/**
 * One comparable form for kernel-real paths: on Windows, forward slashes
 * folded to lower case (its filesystems compare names case-insensitively);
 * on POSIX the real path itself, because a backslash there is a name
 * character, not a separator. Real paths already carry the on-disk spelling,
 * so no further normalization (and no filesystem access) is needed.
 */
function pathForm(real: string): string {
	return process.platform === "win32" ? normalizeEphemeralMapKey(real) : real;
}

/**
 * #5674: the judgment for one LSP root that is not admitted for project code,
 * as one predicate over search-path entries. An entry reaches the root when it
 * is relative (it follows each spawn's cwd), empty on POSIX (the cwd), or lies
 * at or under the root or a project-local bin dir of the root or an ancestor,
 * by spelling or, on POSIX, by identity (`isUnderDir`'s two axes). An answer
 * is judged by its real directory. The bin dirs are walked once per judge, so
 * a caller judging every entry of a search path pays once (#5678 verify V2);
 * like {@link sessionRepositoryJudge}, a judge is for one decision and is
 * never cached across calls.
 */
export function projectSearchJudge(root: string): (entry: string) => boolean {
	const binDirs = [...projectLocalBinDirs(root)];
	const spellings = [root, ...binDirs].map(normalizePathSpelling);
	// Only an existing directory can hold an existing path's identity, and a
	// missing one would cost a failed `realpath` per missing segment.
	let identities: string[] | undefined;
	return (entry) => {
		if (entry === "") return process.platform !== "win32";
		if (!path.isAbsolute(entry)) return true;
		const spelled = normalizePathSpelling(entry);
		if (spellings.some((dir) => isWithinForm(spelled, dir))) return true;
		if (process.platform === "win32") return false;
		identities ??= [
			root,
			...binDirs.flatMap((dir) => (fs.existsSync(dir) ? [dir] : [])),
		].map(normalizeFilePath);
		const real = normalizeFilePath(entry);
		return identities.some((dir) => isWithinForm(real, dir));
	};
}

/**
 * #5674: the LSP root, not admitted for project code, whose launch runs the
 * bare-name spawns of this async context: the installer's PATH rung and
 * probes, a runtime install, the launcher's npm probe. The spawn seam refuses
 * an executable whose real directory {@link projectSearchJudge} places in it,
 * so a link in a global bin dir that points into the root never runs. Built
 * lazily, as `extension-log.ts`'s capture window is: an active store taxes
 * every promise in the process.
 */
let unadmittedRootSpawns: AsyncLocalStorage<string> | undefined;

export function withUnadmittedRootSpawns<T>(root: string, run: () => T): T {
	unadmittedRootSpawns ??= new AsyncLocalStorage<string>();
	return unadmittedRootSpawns.run(root, run);
}

/** The root {@link withUnadmittedRootSpawns} set for this context, if any. */
export function unadmittedSpawnRoot(): string | undefined {
	return unadmittedRootSpawns?.getStore();
}

/**
 * Whether `resolved`, the file a bare name resolved to, lies in the root
 * {@link withUnadmittedRootSpawns} set for this context: the spawn seam's
 * lookup and a `which` answer are both judged here.
 */
export function inUnadmittedSpawnRoot(resolved: string): boolean {
	const root = unadmittedRootSpawns?.getStore();
	return (
		root !== undefined &&
		projectSearchJudge(root)(path.dirname(realpathOrResolve(resolved)))
	);
}

/**
 * Whether `target` (a file or a directory, any spelling) is the session
 * repository's own bytes. See the module header for the rule.
 */
export function isSessionRepositoryPath(target: string): boolean {
	return sessionRepositoryJudge()(target);
}

/**
 * The trust judgment: `target` is the session repository's bytes and pi has
 * not trusted the project. A trusted project (and every MCP host, which latches
 * `trusted` at start) returns before any filesystem work.
 */
export function isUntrustedProjectPath(target: string): boolean {
	if (getProjectTrustState() === "trusted") return false;
	return isSessionRepositoryPath(target);
}

/**
 * One bounded `trust-refusal` record per refused target per session, keyed by
 * the target's kernel-real path, so one link reached through several entries
 * or callers is one record. Every lookup that refuses a target writes through
 * here (#4530).
 */
export function recordProjectCommandRefusal(resolvedCommand: string): void {
	const trust = getProjectTrustState();
	const target = realpathOrResolve(resolvedCommand);
	if (
		recordDegradationOnce({
			kind: "trust-refusal",
			subject: `project-command:${target}`,
			reason: `lookup resolved inside the project and was refused: pi project trust is ${trust}`,
		})
	) {
		logExtension({
			subsystem: "project-trust",
			level: "warn",
			message:
				"lookup resolved inside the project and was refused: mark the project trusted in pi or upgrade pi",
			metadata: { command: resolvedCommand, target, trust },
		});
	}
}

/**
 * The first line of a `which`/`where` answer, or `null` when there is none or
 * it names the session repository's bytes under untrusted pi trust (a global
 * dir can hold a link into the project), or a file in the unadmitted LSP root
 * of this context (#5674). Callers start the answer by path, so
 * the spawn seam's lookup judgment never sees it: this is that judgment.
 */
export function admittedLookupAnswer(stdout: string): string | null {
	const answer = stdout.trim().split(/\r?\n/)[0] || null;
	if (
		answer === null ||
		!(isUntrustedProjectPath(answer) || inUnadmittedSpawnRoot(answer))
	)
		return answer;
	recordProjectCommandRefusal(answer);
	return null;
}
