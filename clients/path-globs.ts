/**
 * The one meaning of a `paths` glob (#5371).
 *
 * Every tool that takes `paths` reads it through `readPathsArgument`
 * (`tools/shared.ts`), and that reader calls THIS module, so a glob entry means
 * the same thing in `symbol_search` as in `ast_grep_search`,
 * `ast_grep_replace`, `ast_grep_outline`, `lens_diagnostics` (both of its
 * routes) and their MCP mirrors. Before #5371 the glob rule lived inside
 * `symbol_search`'s filter alone and each other consumer interpreted the same
 * entries itself — minimatch, a literal argv target, or a `statSync` — so
 * `paths: ["src/**\/*.ts"]` found files in one tool and answered "No matches
 * found" or "path not found" in the others (a false clean, AGENTS.md shape 10).
 *
 * The matcher came out of `clients/lens-engine.ts` verbatim (net-count: the
 * rule moved here, it did not get a second copy), and the expansion walk reuses
 * the shared walker engine and the shared project-ignore decision rather than
 * writing a third traversal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "./deps/minimatch.js";
import { getProjectIgnoreMatcher } from "./file-utils.js";
import { relativeInside, toPosix } from "./path-utils.js";
import { DEFAULT_MAX_SCAN_ENTRIES } from "./source-filter.js";
import {
	shouldRecurseIntoDir,
	walkTreeStackAsync,
	type DirWalkPolicy,
} from "./source-walker.js";

/** Same glob semantics as ast_grep_search's `paths`: a bare directory/file
 * entry scopes its whole subtree (via a `/**` suffix match), a full glob
 * pattern is matched as-is. `paths` entries arrive host-resolved (#5038), so
 * `src`, `./src` and the absolute directory scope the same files. An entry at
 * or under `cwd` is matched as its `cwd`-relative spelling: the workspace
 * prefix is a literal, never glob syntax, so a directory named `app[1]` or
 * `app{a,b}` keeps its scope (#5047 F1), while the part the caller wrote after
 * it (`src/**\/*.ts`) is still a pattern. Any other entry (outside `cwd`, or a
 * relative glob) is also tried against the candidate's absolute spelling. */
export function fileMatchesPathGlobs(
	file: string,
	cwd: string,
	globs: readonly string[],
): boolean {
	const rel = path.relative(cwd, file).split(path.sep).join("/");
	const abs = path.resolve(file).split(path.sep).join("/");
	const options = { dot: true, nocase: process.platform === "win32" };
	const matches = (candidate: string, pattern: string) =>
		minimatch(candidate, pattern, options) ||
		minimatch(candidate, `${pattern}/**`, options);
	return globs.some((raw) => {
		const within = path.isAbsolute(raw) ? relativeInside(cwd, raw) : undefined;
		// An entry at or under `cwd` is matched on the relative spelling alone,
		// never against the absolute candidate, whose workspace prefix is not a
		// pattern. `cwd` itself relativizes to "", which scopes the whole workspace.
		if (within !== undefined) return matches(rel, toPosix(within) || "**");
		const pattern = toPosix(raw);
		return matches(rel, pattern) || (abs !== rel && matches(abs, pattern));
	});
}

/** Glob syntax in a caller's text: `*`, `?`, `[` and `{` are minimatch magic.
 * Other characters (a `+`, a `!` mid-name) stay literal, so a file named
 * `foo!.ts` is still a literal path. A LEADING `!` is not handled here: it is a
 * negation, and the reader refuses it before it can be expanded (#5371) — on the
 * matcher a negated entry names everything the pattern excludes, which is the
 * opposite of a target list. */
function hasGlobMagic(text: string): boolean {
	return /[*?[{]/.test(text);
}

/**
 * Whether a host-resolved `paths` entry is a glob to expand (#5371 r2). One rule,
 * stated by what it admits as a LITERAL and read the same way for every spelling:
 *
 * - the workspace prefix is never syntax (a directory named `app[1]` is a
 *   directory), so only the part of the entry below `cwd` is read for glob
 *   characters;
 * - an entry with no such characters is a literal, present or not, so a deleted
 *   file keeps its own `path not found` answer;
 * - an entry that spells glob characters but EXISTS on disk is a literal too
 *   (`app/[id]/page.tsx`, `src/b{1,2}.ts`): a name that is really there is the
 *   path the caller meant, whatever minimatch would make of its brackets.
 *   Only `ENOENT`/`ENOTDIR` prove it absent; any other refusal (`EACCES`,
 *   `ELOOP`) leaves the entry a literal, because a path the kernel will not
 *   answer for is not one to guess a pattern for;
 * - everything else is a glob.
 */
async function isGlobEntry(resolved: string, cwd: string): Promise<boolean> {
	const spelled = relativeInside(path.resolve(cwd), resolved) ?? resolved;
	if (!hasGlobMagic(spelled)) return false;
	return fs.promises.lstat(resolved).then(
		() => false,
		(refusal: NodeJS.ErrnoException) => {
			// none: `ENOENT`/`ENOTDIR` is this probe's answer ("absent"), not a failure
			// to report; every other refusal answers "literal", the cautious side, and
			// the tool then reports the path itself.
			return refusal.code === "ENOENT" || refusal.code === "ENOTDIR";
		},
	);
}

/** How one `paths` entry resolved. `refusal` is the reason a caller must be told
 * the glob named nothing usable; `root` is the directory the pattern was
 * searched under, for the message. */
export interface GlobExpansion {
	/** The files and directories the pattern names, host-resolved. */
	entries: string[];
	refusal?: "no-match" | "over-cap" | "over-walk" | "outside" | "aborted";
	root: string;
}

export interface ExpandPathsEntryOptions {
	/** Directory entries the walk may visit before it refuses. Defaults to the
	 * shared scan ceiling every project walker already honours. */
	maxVisited?: number;
	/** The call's abort signal: a fired signal ends the walk with `aborted`. */
	signal?: AbortSignal | undefined;
}

/**
 * The directory a walk starts under: `cwd` plus the segments of the entry's
 * cwd-relative spelling that come BEFORE its first glob segment. A segment is
 * magic or it is not, so `src/**\/index.ts` and `src/*\/index.ts` start at
 * `src`; the literal `index.ts` after a magic segment is never part of the root.
 */
function literalRoot(cwd: string, relative: string): string {
	let root = cwd;
	for (const segment of relative.split("/")) {
		if (hasGlobMagic(segment)) break;
		root = path.join(root, segment);
	}
	return root;
}

/**
 * Resolve ONE `paths` entry against `cwd`: a literal is returned as it is, a
 * glob is expanded into the files (and directories) it names, bounded to
 * `budget` results.
 *
 * The glob must lie inside `cwd`: a pattern rooted at `..` or at an absolute
 * directory elsewhere is refused (`outside`), because a walk from there reads
 * a tree the call never named. A LITERAL outside `cwd` never reaches this
 * function; the reader passes it through exactly as before.
 *
 * The walk starts at {@link literalRoot} after the tracked-file index is primed
 * (the word index and the startup scan do the same, so a tracked file that a
 * `.gitignore` pattern also matches is kept on a cold call as on a warm one),
 * and every directory passes the shared ignore decision BEFORE it may match:
 * `shouldRecurseIntoDir` with `getProjectIgnoreMatcher` (the `.gitignore` +
 * `.pi-lens.json` + excluded-name decision `collectSourceFilesAsync` applies to
 * the word index `symbol_search` searches). A directory that matches is
 * returned AS the directory: consumers scope a directory entry's whole subtree,
 * which is what the pattern means.
 *
 * The walk stops once it holds more than `budget` matches, once it has visited
 * `maxVisited` entries, or once the signal fires. An over-large or unfinished
 * scope is REFUSED by the caller (`tools/shared.ts`), never silently narrowed
 * (AGENTS.md shape 10): a walk that gave up must not read as "no file matches".
 */
export async function expandPathsEntry(
	entry: string,
	cwd: string,
	budget: number,
	options: ExpandPathsEntryOptions = {},
): Promise<GlobExpansion> {
	const cwdAbsolute = path.resolve(cwd);
	const absolute = path.resolve(cwdAbsolute, entry);
	// A literal is the entry itself, untouched (present or not).
	if (!(await isGlobEntry(absolute, cwdAbsolute)))
		return { entries: [absolute], root: cwdAbsolute };
	const relative = relativeInside(cwdAbsolute, absolute);
	if (relative === undefined) {
		return { entries: [], refusal: "outside", root: cwdAbsolute };
	}
	const root = literalRoot(cwdAbsolute, relative);
	const { signal } = options;

	// Keyed at the call's own root, not the walk root: a `.gitignore` or
	// `.pi-lens.json` between `cwd` and the prefix directory still applies.
	const matcher = getProjectIgnoreMatcher(cwdAbsolute);
	const policy: DirWalkPolicy = { ignoreMatcher: matcher };
	const pattern = [absolute];
	const maxVisited = options.maxVisited ?? DEFAULT_MAX_SCAN_ENTRIES;
	const matches: string[] = [];
	let visited = 0;
	let walkedTooMuch = false;
	await walkTreeStackAsync(
		root,
		(entry_, fullPath) => {
			if (signal?.aborted) return "stop";
			visited += 1;
			if (visited > maxVisited) {
				walkedTooMuch = true;
				return "stop";
			}
			if (entry_.isDirectory()) {
				if (!shouldRecurseIntoDir(entry_, fullPath, policy)) return "skip";
				if (!fileMatchesPathGlobs(fullPath, cwdAbsolute, pattern))
					return "recurse";
			} else if (
				!entry_.isFile() ||
				matcher.isIgnored(fullPath, false) ||
				!fileMatchesPathGlobs(fullPath, cwdAbsolute, pattern)
			) {
				return "skip";
			}
			// A matched directory carries its subtree; walking into it would report
			// the same files twice.
			matches.push(fullPath);
			return matches.length > budget ? "stop" : "skip";
		},
		// Yield off the event loop per budget slice: a glob can name a whole
		// workspace, and a tool call must not hold pi's TUI (#1137).
		{ budgetMs: 8, beforeWalk: () => matcher.ensureTrackedIndex() },
	);
	if (signal?.aborted) return { entries: [], refusal: "aborted", root };
	if (walkedTooMuch) return { entries: [], refusal: "over-walk", root };
	if (matches.length > budget)
		return { entries: [], refusal: "over-cap", root };
	if (matches.length === 0) return { entries: [], refusal: "no-match", root };
	return { entries: matches, root };
}
