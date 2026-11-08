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

import * as path from "node:path";
import { minimatch } from "./deps/minimatch.js";
import { getProjectIgnoreMatcher } from "./file-utils.js";
import { relativeInside, toPosix } from "./path-utils.js";
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

/** Glob syntax in a caller's entry. `*`, `?`, `[` and `{` are minimatch magic;
 * a leading `!` is a negation. Other characters (a `+`, a literal `!` mid-name)
 * stay literal, so a file named `foo!.ts` is still a literal path. */
export function hasGlobMagic(entry: string): boolean {
	return /[*?[{]/.test(entry) || entry.startsWith("!");
}

/** How one glob entry resolved. `refusal` is the reason a caller must be told
 * the glob named nothing, or named more than the cap admits; `root` is the
 * directory the pattern was searched under, for the message. */
export interface GlobExpansion {
	/** The files and directories the pattern names, host-resolved. */
	entries: string[];
	refusal?: "no-match" | "over-cap";
	root: string;
}

/**
 * The deepest directory an entry's path reaches before any glob syntax: the
 * shallowest place a walk can start and still reach every match.
 *
 * The climb goes UP while a segment still spells glob syntax, and stops at the
 * first literal one. Climbing PAST a magic directory name (`app[1]`) is on
 * purpose: minimatch reads that segment as a pattern too, so the literal
 * directory may not exist at all and starting under it would find nothing.
 * `path.dirname` terminates at the filesystem root (`parent === current`), so
 * an all-magic entry (`**\/*.ts` under the workspace root) lands on the root
 * the caller named, never loops.
 */
function literalPrefixDir(absolute: string): string {
	let current = absolute;
	for (;;) {
		const name = path.basename(current);
		const parent = path.dirname(current);
		if (
			!name ||
			name === current ||
			parent === current ||
			!hasGlobMagic(name)
		) {
			return current;
		}
		current = parent;
	}
}

/**
 * Expand ONE glob entry against `cwd` into the files (and directories) it
 * names, bounded to `budget` results.
 *
 * The walk starts at the entry's literal prefix directory, pruned and matched
 * by the rules every project walker already shares: `shouldRecurseIntoDir` with
 * `getProjectIgnoreMatcher` (the `.gitignore` + `.pi-lens.json` + excluded
 * directory-name decision `collectSourceFilesAsync` applies to the word index
 * `symbol_search` searches), and `fileMatchesPathGlobs` — the matcher
 * `symbol_search` already used, so the two surfaces cannot drift. A directory
 * that matches is returned AS the directory: consumers scope a directory entry's
 * whole subtree, which is what the pattern means, and it keeps one entry per
 * matched subtree instead of one per file.
 *
 * A prefix below `cwd` stays the walk root; a prefix that would climb above
 * `cwd` (a workspace whose own name holds glob syntax, #5047 F1) is clamped to
 * `cwd`, because that syntax is a literal the caller never wrote.
 *
 * The walk stops once it holds more than `budget` matches: an over-large scope
 * is REFUSED by the caller (`tools/shared.ts`), never silently narrowed
 * (AGENTS.md shape 10). The reader never hands over a budget below 1.
 */
export async function expandPathGlob(
	entry: string,
	cwd: string,
	budget: number,
): Promise<GlobExpansion> {
	// `cwd` is part of the resolution, not a decoration: a caller that hands over
	// a relative entry gets the same root-relative meaning the reader gave it,
	// and an already-absolute entry is unchanged.
	const absolute = path.resolve(cwd, entry);
	let root = literalPrefixDir(absolute);
	const cwdAbsolute = path.resolve(cwd);
	if (
		relativeInside(cwdAbsolute, absolute) !== undefined &&
		relativeInside(cwdAbsolute, root) === undefined
	) {
		root = cwdAbsolute;
	}

	// The same decision `collectSourceFilesAsync` applies to the word index
	// `symbol_search` searches: `.gitignore`, the `.pi-lens.json` exclusions, and
	// the excluded directory names, through `shouldRecurseIntoDir`. No probe
	// guard: no sibling walker wraps this call, and a config the matcher cannot
	// read is the tool call's own error, not a reason to scan unignored.
	const matcher = getProjectIgnoreMatcher(root);
	const policy: DirWalkPolicy = { ignoreMatcher: matcher };
	const pattern = [absolute];
	const matches: string[] = [];
	await walkTreeStackAsync(
		root,
		(entry_, fullPath) => {
			if (entry_.isDirectory()) {
				if (fileMatchesPathGlobs(fullPath, cwd, pattern)) {
					matches.push(fullPath);
					// The directory entry carries its subtree; walking into it would
					// report the same files twice.
					return "skip";
				}
				return shouldRecurseIntoDir(entry_, fullPath, policy)
					? "recurse"
					: "skip";
			}
			if (!entry_.isFile()) return "skip";
			if (matcher.isIgnored(fullPath, false)) return "skip";
			if (fileMatchesPathGlobs(fullPath, cwd, pattern)) matches.push(fullPath);
			return "skip";
		},
		// Yield off the event loop per budget slice: a glob can name a whole
		// workspace, and a tool call must not hold pi's TUI (#1137).
		{ budgetMs: 8, shouldStop: () => matches.length > budget },
	);
	if (matches.length > budget)
		return { entries: [], refusal: "over-cap", root };
	if (matches.length === 0) return { entries: [], refusal: "no-match", root };
	return { entries: matches, root };
}
