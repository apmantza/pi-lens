/**
 * Shared constants and helpers for tool definitions
 */

import * as os from "node:os";
import * as path from "node:path";
import { expandPathsEntry } from "../clients/path-globs.js";
import {
	isAtOrAboveHomeDir,
	realpathOrResolve,
	resolveHostToolPath,
} from "../clients/path-utils.js";
import { DEFAULT_MAX_SCAN_ENTRIES } from "../clients/source-filter.js";

/**
 * The `paths` cap every tool shares (#5041): one reader, one bound. Every entry
 * becomes one walk, batch slot or glob probe, and before #5041 each tool carried
 * its own value (200 in ast-grep search, 100 in `lens_diagnostics` and
 * `ast_grep_outline`, none in replace and `symbol_search`). 100 is the value the
 * one tool with a downstream bound already enforced: `lens_diagnostics
 * source=lsp` reaches `MAX_BATCH_FILES` (100, `tools/lsp-diagnostics.ts`), so a
 * reader that admitted more would hand that route a list it refuses. The ast-grep
 * tools share no such bound and gain nothing from 200: no caller in the tree
 * sends more than 100 entries (#5047 F10), and a longer list narrows by
 * directory. The refusal names the cap, and the changelog announces it.
 */
export const MAX_PATHS_ENTRIES = 100;

/** The canonical single-file parameter (#5041), in precedence order. */
export const FILE_PATH_KEYS = ["path", "file", "filePath"] as const;

export interface FilePathRead {
	/** The caller's spelling, unresolved. "" when no spelling was sent. */
	path: string;
	/** Which spelling it came from, for messages. */
	key?: (typeof FILE_PATH_KEYS)[number];
	/** Set when the argument must be refused. */
	refusal?: string;
}

/**
 * Read the ONE single-file parameter (#5041): `path` is canonical, `file` and
 * `filePath` stay accepted so no caller breaks (#2418).
 *
 * Admitted: no spelling (the caller owns its own "required" message), one
 * spelling, or several spellings that name the same file. Refused, fail
 * closed: a non-string value, a blank value that leaves no file, or two
 * spellings that name different files — each would otherwise make this reader
 * guess which file the caller meant, and the tool would answer for a file the
 * caller never named.
 *
 * A blank string is ignored when another spelling names a file, and refused
 * when none does. Some clients fill every declared property with `""`, and
 * declaring `file`/`filePath` beside `path` must not turn such a call into a
 * refusal (#2418); a lone blank still names nothing, so the caller hears it.
 */
export function readFilePath(
	params: Readonly<Record<string, unknown>>,
): FilePathRead {
	const sent: { key: (typeof FILE_PATH_KEYS)[number]; value: string }[] = [];
	const blanks: (typeof FILE_PATH_KEYS)[number][] = [];
	for (const key of FILE_PATH_KEYS) {
		const raw = params[key];
		if (raw === undefined || raw === null) continue;
		if (typeof raw !== "string")
			return { path: "", key, refusal: `\`${key}\` must be a string path` };
		if (!raw.trim()) {
			blanks.push(key);
			continue;
		}
		sent.push({ key, value: raw });
	}
	const first = sent[0];
	if (!first) {
		const blank = blanks[0];
		return blank
			? { path: "", key: blank, refusal: `\`${blank}\` is blank — name a file` }
			: { path: "" };
	}
	if (new Set(sent.map((entry) => entry.value)).size > 1) {
		return {
			path: "",
			refusal: `${sent.map((entry) => `\`${entry.key}\`: ${entry.value}`).join(", ")} name different files — send one spelling`,
		};
	}
	return { path: first.value, key: first.key };
}

export interface PathsRead {
	/** Host-resolved entries. Empty when the caller sent no `paths`. A glob
	 * entry is replaced by the files and directories it names (#5371). */
	entries: string[];
	/** Set when the argument must be refused. */
	refusal?: string;
}

/**
 * The glob sentence every `paths` parameter carries (#5371). One owner, so no
 * surface can advertise a meaning another does not honour: `symbol_search`
 * documented "the same shape/semantics as `ast_grep_search`'s `paths`" while
 * only `symbol_search` expanded a glob.
 */
export const PATHS_GLOB_CLAUSE =
	"A glob entry (e.g. `src/**/*.ts`) expands to the files it matches; one matching none is refused (`no file matches`).";

function overCapRefusal(entry: string | undefined): PathsRead {
	const what = entry === undefined ? "`paths`" : `the glob \`${entry}\``;
	return {
		entries: [],
		refusal: `${what} names more than ${MAX_PATHS_ENTRIES} files — narrow the pattern, or pass a directory entry`,
	};
}

function describeEntryType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value;
}

/**
 * The one reader of a `paths` argument (#5041). Every tool calls it, so one
 * entry rule holds across the surface: a non-string, a blank entry, an empty
 * list and a list over {@link MAX_PATHS_ENTRIES} are refused, and every
 * admitted entry is resolved through the same host-path seam the read, edit,
 * write and ast-grep tools use (so `~`, `@` and unicode-space spellings behave
 * identically).
 *
 * #5371 added the third rule, and it lives HERE rather than in a consumer
 * because the failure was one parameter with three meanings: a glob entry
 * (`src/**\/*.ts`) is expanded once, through `clients/path-globs.ts`, into the
 * files and directories it names, so the literal-argv tools, the `stat`-based
 * scope, the LSP batch and the word-index filter all receive the same set.
 * Four rules the expansion owns, each stated by what it admits (r2, #5393):
 * - an entry is a LITERAL, untouched, when its cwd-relative spelling has no
 *   glob characters (a missing path keeps its own `path not found` answer and a
 *   deleted file from git output still gets its cached findings) OR when it
 *   exists on disk, whatever characters it has (`app/[id]`, `src/b{1,2}.ts`);
 *   everything else is a glob;
 * - a glob that matches nothing is refused with `no file matches <entry>`,
 *   never an empty result that reads as a clean answer (AGENTS.md shape 10); one
 *   that reaches outside `cwd`, or walks more than the scan ceiling, is refused
 *   by name too;
 * - the entries a tool receives as a file list (literals and expansions
 *   together, in any order) are bounded by {@link MAX_PATHS_ENTRIES}, the cap
 *   this reader already enforced and the one `lens_diagnostics source=lsp`
 *   answers for (`MAX_BATCH_FILES`). An over-large scope is refused, not
 *   narrowed. `filterOnly` lifts that cap for `symbol_search`, which filters an
 *   index and hands no tool a list;
 * - `!` leading an entry is refused.
 *
 * Before #5041 each tool had its own copy: search refused a non-string entry,
 * outline and lens_diagnostics dropped it, replace never looked. The silenced
 * shapes made a wrong call read as "no match".
 *
 * `absent` is the caller's own default for an omitted `paths`: "cwd" gives the
 * session cwd, which is what an ast-grep child needs to receive an absolute
 * target (#4233 V3-HIGH-01) and is the only entry that gets NO host resolver
 * stage (#4577 R2-2: a generated cwd holding U+00A0 was folded to a sibling
 * directory that does not exist); "none" leaves the list empty so the caller's
 * own "no restriction" path runs.
 *
 * Async because a glob is answered by a directory walk: it yields to the event
 * loop per slice so a wide pattern never holds pi's TUI (#1137).
 */
export async function readPathsArgument(
	raw: unknown,
	options: {
		cwd: string | undefined;
		absent?: "none" | "cwd";
		/** The entries scope a FILTER over an index (`symbol_search`) and reach no
		 * tool as a target list, so the file-list cap does not apply; the walk's
		 * own visited bound still does. */
		filterOnly?: boolean;
		/** The call's abort signal, handed to a glob's directory walk. */
		signal?: AbortSignal | undefined;
	},
): Promise<PathsRead> {
	const base = options.cwd || ".";
	const absent = options.absent ?? "none";
	if (raw === undefined || raw === null) {
		return { entries: absent === "cwd" ? [path.resolve(base)] : [] };
	}
	if (!Array.isArray(raw))
		return { entries: [], refusal: "paths must be an array of strings" };
	if (raw.length === 0)
		return {
			entries: [],
			refusal:
				"paths is empty: it names no entry, so the call would widen to the tool's default. Omit `paths` to use that default.",
		};
	if (raw.length > MAX_PATHS_ENTRIES)
		return {
			entries: [],
			refusal: `paths must contain at most ${MAX_PATHS_ENTRIES} string entries, got ${raw.length}`,
		};
	const entries: string[] = [];
	for (const [index, entry] of raw.entries()) {
		if (typeof entry !== "string")
			return {
				entries: [],
				refusal: `paths entry ${index + 1} must be a string, not ${describeEntryType(entry)}`,
			};
		if (!entry.trim())
			return { entries: [], refusal: `paths entry ${index + 1} is blank` };
		// A leading `!` is a minimatch NEGATION: on the matcher it names every
		// file the pattern excludes. That is workable while one consumer filters
		// a list it already holds, and a false promise once the entry is expanded
		// into a target list — the same entry would name everything the caller
		// wanted left out (#5371). `paths` names entries to include; leaving
		// files out belongs to the project ignore config.
		if (entry.trimStart().startsWith("!"))
			return {
				entries: [],
				refusal: `paths entry ${index + 1} starts with "!": \`paths\` names the entries to include, not the ones to leave out, and a negated entry names every other file. Name the entries you want, or ignore what you do not want through the project ignore config.`,
			};
		const resolved = resolveHostToolPath(entry, base);
		const expanded = await expandPathsEntry(
			resolved,
			base,
			options.filterOnly
				? Number.POSITIVE_INFINITY
				: MAX_PATHS_ENTRIES - entries.length,
			{ signal: options.signal },
		);
		if (expanded.refusal === "no-match") {
			return {
				entries: [],
				refusal: `no file matches \`${entry}\` — the glob matched no file under ${expanded.root}`,
			};
		}
		if (expanded.refusal === "over-cap") return overCapRefusal(entry);
		if (expanded.refusal === "over-walk") {
			return {
				entries: [],
				refusal: `the glob \`${entry}\` walked more than ${DEFAULT_MAX_SCAN_ENTRIES} entries under ${expanded.root} without finishing — name a deeper directory, or narrow the pattern`,
			};
		}
		if (expanded.refusal === "outside") {
			return {
				entries: [],
				refusal: `the glob \`${entry}\` reaches outside the workspace ${expanded.root} — a glob expands inside the workspace only; name a file or directory outside it literally`,
			};
		}
		if (expanded.refusal === "aborted") {
			return { entries: [], refusal: "paths expansion aborted" };
		}
		entries.push(...expanded.entries);
	}
	// Literals that FOLLOW an expanded glob were never part of its budget, so the
	// total is judged here, once, whatever order the entries came in (#5393 F6).
	if (!options.filterOnly && entries.length > MAX_PATHS_ENTRIES)
		return overCapRefusal(undefined);
	return { entries };
}

/**
 * The refusal a defaulted-target ast-grep tool returns when the session cwd
 * resolves at or above `$HOME`, or `undefined` when the call may proceed.
 *
 * #747/#250 guarded `ast_grep_search` only, with an inline copy; #5039 found
 * the mutating `ast_grep_replace` had no guard at all, so the same cwd served a
 * dry-run preview and an apply over the whole home tree. One seam now decides
 * it for both, and the inline copy is gone (net-count rule). Only the
 * DEFAULTED case is guarded: explicit `paths` are exactly what the caller
 * asked to touch and are never second-guessed. Both sides compare by real path
 * (#4911), so a cwd or a `$HOME` spelled through a link is refused too.
 *
 * `reason` is the terse code the tool log records as `errorRaw`; `text` is what
 * the model reads.
 */
export function defaultedCwdHomeRefusal(
	paths: readonly string[] | undefined,
	cwd: string | undefined,
): { reason: string; text: string } | undefined {
	if (paths?.length) return undefined;
	const spelling = cwd || ".";
	if (
		!isAtOrAboveHomeDir(
			realpathOrResolve(spelling),
			realpathOrResolve(os.homedir()),
		)
	)
		return undefined;
	return {
		reason: "defaulted cwd resolves at or above home directory",
		text: `Refused: no \`paths\` given and the working directory (${spelling}) resolves at or above the home directory — this would reach every unrelated tree under your home. Pass explicit \`paths\`, or run from a project directory.`,
	};
}

export const LANGUAGES = [
	"bash",
	"c",
	"cpp",
	"csharp",
	"css",
	"elixir",
	"go",
	"haskell",
	"html",
	"java",
	"javascript",
	"json",
	"kotlin",
	"lua",
	"nix",
	"php",
	"python",
	"ruby",
	"rust",
	"scala",
	"swift",
	"tsx",
	"typescript",
	"yaml",
] as const;

/**
 * #4687: the three ast-grep schemas carry `lang` as a plain string (the 24-id
 * enum cost ~240 bytes per tool per request), so this is the one check that
 * keeps an unknown id from reaching the CLI. It names every valid id, which is
 * what the enum used to tell the model.
 *
 * It reads the raw argument, not a typed one: the MCP route hands `execute`
 * the client's JSON without schema validation, so `lang` can be any JSON value
 * (#4723 F4). It admits only a string that is a known id, once one pair of
 * wrapping double quotes is stripped; absent or blank is "required" (or absent
 * when optional), and every other value is refused with `refusal`. An optional
 * `null` is absent, as at master, where the client built `--lang` only when the
 * value was truthy (#4723 N2); a required `null` is refused. `lang` is the
 * normalized id, or "" when there is none (blank included, so a blank optional
 * `lang` never reaches the CLI as `--lang " "`).
 */
export function readAstGrepLang(
	rawArg: unknown,
	required: boolean,
): { lang: string; refusal?: string } {
	const raw = rawArg === null && !required ? undefined : rawArg;
	const lang = typeof raw === "string" ? raw.replace(/^"|"$/g, "") : "";
	if (
		typeof raw === "string" &&
		(LANGUAGES as readonly string[]).includes(lang)
	)
		return { lang };
	const validIds = `valid ids: ${LANGUAGES.join(", ")}`;
	if (raw !== undefined && typeof raw !== "string")
		return { lang, refusal: `lang must be a string; ${validIds}` };
	if (!lang.trim())
		return required ? { lang: "", refusal: "lang is required" } : { lang: "" };
	return { lang, refusal: `unknown lang "${lang}"; ${validIds}` };
}
