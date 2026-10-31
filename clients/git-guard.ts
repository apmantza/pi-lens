import * as nodeFs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_MAX_AGE_MS,
	type CacheInspection,
	type CacheManager,
} from "./cache-manager.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { isPathIgnoredByProject } from "./file-utils.js";
import {
	isOutsideProjectRoot,
	isUnderDir,
	pathsEqual,
	toPosix,
	toProjectRelativePath,
} from "./path-utils.js";
import {
	resolveGitCheckout,
	sameCheckoutOtherRoot,
	type GitCheckout,
} from "./review-graph/git-identity.js";
import { decodeShellWords, type DecodedShellWord } from "./bash-file-access.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { absorbSettledRunnerBlockers } from "./deferred-runner-blockers.js";
import { logLatency } from "./latency-logger.js";
import { resolveLensToolName, type LensToolHost } from "./tool-config.js";
import {
	canWriteAnalysisRoot,
	type AnalysisRootMode,
} from "./analysis-root.js";
import {
	advisoryFileHash,
	advisoryPathKey,
	MAX_ADVISORY_AFFECTED_FILES,
	snapshotAdvisoryProvenance,
	type AdvisoryProvenance,
} from "./advisory-provenance.js";

/** The structured, single-source turn record used by context and git-guard. */
export interface TurnEndFindingsCache {
	content: string;
	hasBlockers: boolean;
	affectedFiles: string[];
	sessionId: string;
	projectSeqStart: number;
	projectSeqEnd: number;
	fileSeqByPath: Record<string, number>;
	/** Content fingerprints catch edits made outside pi-lens between turns. */
	fileContentHashes: Record<string, string>;
	/** A capped record is never treated as complete/allowable. */
	affectedFilesTruncated?: boolean;
	/** Files represented by blockerContent, distinct from test failures. */
	blockingFiles?: string[] | undefined;
	/** Context has consumed the message, but the guard still owns the state. */
	consumed?: boolean;
	testFailures?: boolean;
	testFailureContent?: string;
	testFailureFiles?: string[];
	blockerContent?: string | undefined;
	provenance?: AdvisoryProvenance;
	/**
	 * Other sessions' blocker sections this record carries (#4738), one entry
	 * per owner, none of them `sessionId`. The top-level `blockerContent` and
	 * `blockingFiles` are `sessionId`'s own; a record without this field (every
	 * shape released before #4738) is one owner's.
	 */
	carriedBlockers?: BlockerPartition[] | undefined;
	/** When `sessionId` wrote the top-level sections (#4750, `BlockerPartition`). */
	blockerWrittenAt?: number | undefined;
	/**
	 * The session whose turn end composed `content` (#4943), the only session
	 * whose next request takes it. Absent, `content` is the owner's
	 * (`sessionId`): a commit-gate writer that rewrites `content` as the
	 * owner's blocker text leaves it out. Not a claim: the gate never reads it.
	 */
	deliverTo?: string | undefined;
}

/** One session's blocker sections in the record, with their owner (#4738). */
export interface BlockerPartition {
	sessionId: string;
	blockerContent: string;
	blockingFiles: string[];
	/**
	 * Epoch ms (#4750), written by two writers: the owner, when it writes these
	 * sections; and, for a partition a writer before #4750 wrote (no stamp), the
	 * first turn end of another session that carries it
	 * (`carriedTurnEndBlockers`' `?? now`, persisted by the composer's write or
	 * by the settled turn end's, #4762 r3), so such a record's window starts at
	 * that first carry. Text no file owns expires by it: the record's own
	 * timestamp moves with every writer's write, so it cannot tell how old one
	 * owner's text is.
	 */
	blockerWrittenAt?: number | undefined;
}

type GuardDecision = {
	block: boolean;
	unknown?: boolean;
	reason?: string;
};

function resolveGuardPath(filePath: string, cwd: string): string {
	return path.resolve(cwd, filePath);
}

function guardPathKey(filePath: string, cwd: string): string {
	return advisoryPathKey(filePath, cwd);
}

function fileFingerprint(filePath: string): string {
	return advisoryFileHash(filePath);
}

function currentFileFingerprint(filePath: string): string {
	try {
		nodeFs.statSync(filePath);
		return fileFingerprint(filePath);
	} catch (err) {
		return (err as { code?: string }).code === "ENOENT"
			? "missing"
			: `unreadable:${(err as { code?: string }).code ?? "unknown"}`;
	}
}

function capAffectedFiles(
	files: string[],
	cwd: string,
): {
	files: string[];
	truncated: boolean;
} {
	const unique = [...new Set(files.map((file) => resolveGuardPath(file, cwd)))];
	return {
		files: unique.slice(0, MAX_ADVISORY_AFFECTED_FILES),
		truncated: unique.length > MAX_ADVISORY_AFFECTED_FILES,
	};
}

/**
 * The turn-end composer's per-file attribution line
 * (`clients/runtime-turn.ts:1085`). The optional suppression notice carries its
 * own `": "`, so this shape is tried BEFORE the per-edit one below — otherwise
 * everything up to `disposition` reads as the file name (#3282 F5).
 */
const TURN_END_BLOCKER_SECTION =
	/^Unresolved from this turn — ([^\s].*?)(?: \(suppressed by disposition: \d+ finding\(s\)\))?:$/;

/**
 * The file a line of `blockerContent` ATTRIBUTES a new blocker section to, or
 * `undefined` when the line is rendered body that attributes nothing.
 *
 * Exactly the two shapes the two writers emit, and nothing else:
 *
 * - `<path>: <text>` at column 0 — `syncGitGuardRecord`'s own join below;
 * - `Unresolved from this turn — <path>[ (suppressed by disposition: N
 *   finding(s))]:` — the turn-end composer's blocker section header.
 *
 * Both writers render the blocker BODY with `formatDiagnostics(…, "blocking")`
 * (`clients/dispatch/utils/format-utils.ts:29`), which indents every line it
 * emits — the `  L<n>: <message>` diagnostics, their `    💡 Fix:` lines, the
 * `  ... and N more` tail, and the two-space continuations of a multi-line
 * message. The leading-whitespace test is therefore what separates body from
 * attribution, and it is why #3282 happened: a line-by-line parse read
 * `  L1: alpha is unsafe` as a file named `L1`.
 */
function blockerSectionFile(line: string): string | undefined {
	const turnEndSection = TURN_END_BLOCKER_SECTION.exec(line);
	if (turnEndSection) return turnEndSection[1];
	if (/^\s/.test(line)) return undefined;
	const separator = line.indexOf(": ");
	if (separator <= 0) return undefined;
	return line.slice(0, separator);
}

/**
 * The path key of every blocker SECTION `blockerContent` attributes, or
 * `undefined` when the text cannot be attributed at all.
 *
 * `blockerContent` is a sequence of per-file blocker SECTIONS: an attribution
 * line, then the rendered body it owns, up to the next attribution line or the
 * composer's `"\n\n"` part separator (`clients/runtime-turn.ts:4291`). The one
 * consumer is `clearedLastKnownBlocker` below, which drops `blockerContent`
 * when the file that just dispatched clean was the last entry in
 * `blockingFiles` — sound only if `blockingFiles` accounts for the WHOLE of
 * that text.
 *
 * Named recurrences, both live:
 *
 * - #3282: the writers render MULTI-LINE blocker text and a line-by-line parse
 *   judged every such record untrusted, so the first blocker of a session
 *   latched `blocking_provenance_untrusted` and refused every later commit —
 *   including after the agent fixed it.
 * - #1561: a section for a file `blockingFiles` omits must keep the gate
 *   closed, and so must a section no file owns at all. `blockerParts` is
 *   multi-lane — the trivy CRITICAL report (`clients/runtime-turn.ts:2141`),
 *   knip (`:2147`), the secrets lane (`:2099`) and cascade (`:1340`) each push
 *   sections belonging to no file — and clearing one of those on a clean
 *   dispatch of the file beside it would drop a live CVE or leaked secret out
 *   of the commit gate. That is the fail-closed direction, and the reason an
 *   unattributable line answers `unknown` rather than being swallowed.
 *
 * The rule is one-directional on purpose — every SECTION is owned, and
 * `blockingFiles` may name more. Demanding a bijection was #3282's second
 * cause: the composer writes `blockingFiles: affectedFiles`
 * (`clients/runtime-turn.ts:4292`), which carries every file the turn touched
 * plus every cascade neighbour with diagnostics, while only the files with a
 * surviving blocker get a section — so any turn that edited a second file was
 * judged untrusted for the rest of the session. The extra direction also
 * guarded nothing: the one consumer clears only when `blockingFiles` has
 * shrunk to the single file that just dispatched clean, and every section is
 * then that file's by this rule. For the same reason a duplicate section and a
 * duplicate `blockingFiles` entry need no clause of their own: neither can make
 * the clear drop a blocker some other file owns. An all-blank `blockerContent`
 * is NOT in that company — round 1 claimed it was, and the section-count guard
 * below is why (HIGH-3287-1).
 */
interface BlockerSection {
	/** The path key the section is attributed to. */
	key: string;
	/** The attribution line's own path spelling, for display. */
	file: string;
	/** The section's lines: its attribution line, then its body. */
	lines: string[];
}

function blockingProvenance(
	blockerContent: unknown,
	blockingFiles: unknown,
	cwd: string,
): BlockerSection[] | undefined {
	if (typeof blockerContent !== "string" || blockerContent.length === 0)
		return undefined;
	// `Array.isArray` only: a non-empty `blockingFiles` is not a separate
	// requirement (MEDIUM-3287-2, mutation M11 — it stayed green across the whole
	// seam suite). With at least one section required below, an empty
	// `blockingFiles` cannot satisfy the ownership test either way, so the clause
	// decided nothing; the entry type check under it still does, and has its own
	// red (M8).
	if (!Array.isArray(blockingFiles)) return undefined;
	if (
		blockingFiles.some(
			(file) => typeof file !== "string" || file.trim().length === 0,
		)
	) {
		return undefined;
	}
	const { sections, unowned } = splitBlockerSections(
		blockerContent,
		blockingFiles as string[],
		cwd,
	);
	// No line opened a section, so there is nothing for `blockingFiles` to be
	// checked against and nothing a per-file dispatch may claim authority over.
	// All-blank-but-non-empty text lands here (HIGH-3287-1, round 1's fail-open):
	// `[].every(…)` is vacuously true, so treating zero sections as "nothing left
	// to attribute" let a clean dispatch of an unrelated file DELETE a record
	// whose `blockingFiles` named a different file, and the gate then answered
	// `no_record`. Unattributed is not clean.
	if (unowned || sections.length === 0) return undefined;
	return sections;
}

/**
 * `blockerContent` split into the sections `blockingFiles` owns, and whether
 * any text is left that no entry owns: a body line with no section open, or a
 * section attributed to a file `blockingFiles` omits. `blockingProvenance`
 * trusts the text only when nothing is unowned; the turn-end composer keeps
 * another session's owned sections and replaces the rest (#4738).
 */
function splitBlockerSections(
	blockerContent: string,
	blockingFiles: readonly string[],
	cwd: string,
): { sections: BlockerSection[]; unowned: boolean } {
	const provenanceKeys = new Set(
		blockingFiles.map((file) => guardPathKey(file, cwd)),
	);
	const sections: BlockerSection[] = [];
	let unowned = false;
	let open: BlockerSection | undefined;
	for (const line of blockerContent.split("\n")) {
		// A ZERO-LENGTH line only: the composer's part separator. A
		// whitespace-only line is how `formatDiagnostics` renders a blank line
		// inside a multi-line diagnostic message, and it is body (#3282 F13).
		if (line.length === 0) {
			open = undefined;
			continue;
		}
		const file = blockerSectionFile(line);
		if (file === undefined) {
			// Body of the open section, or — with no section open — text that no
			// entry of `blockingFiles` can be held responsible for.
			if (open) open.lines.push(line);
			else unowned = true;
			continue;
		}
		open = { key: guardPathKey(file, cwd), file, lines: [line] };
		if (provenanceKeys.has(open.key)) sections.push(open);
		else unowned = true;
	}
	return { sections, unowned };
}

function getShellCommand(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const raw = input as { command?: unknown; cmd?: unknown };
	if (typeof raw.command === "string" && raw.command.trim()) return raw.command;
	if (typeof raw.cmd === "string" && raw.cmd.trim()) return raw.cmd;
	if (typeof raw.command === "string") return raw.command;
	return "";
}

function executableName(value: string): string {
	const normalized = toPosix(value);
	let name = (
		normalized.slice(normalized.lastIndexOf("/") + 1) ?? ""
	).toLowerCase();
	// Shell launchers are commonly supplied as resolved Windows paths or as
	// PATHEXT-qualified names. Guard classification must happen after the same
	// basename/extension normalization for every wrapper family.
	return name.replace(/\.(?:exe|com|bat|cmd)$/i, "");
}

function isShellWrapper(value: string): boolean {
	return new Set([
		"sh",
		"bash",
		"dash",
		"zsh",
		"ash",
		"cmd",
		"pwsh",
		"powershell",
	]).has(executableName(value));
}

function isGitExecutable(value: string): boolean {
	const names = new Set(["git", "git.exe", "git.cmd", "git.bat"]);
	// Two readings of a backslash before an ordinary character: the word model
	// keeps it for a native Windows path (`C:\tools\git.exe`), and bash removes
	// it (`g\it` is `git`, #4739). A command-position word is git under either.
	return [value, normalizeGuardVerbToken(value)].some((reading) =>
		names.has(executableName(reading)),
	);
}

const COMMAND_STRING_WRAPPERS = new Set(["busybox", "toybox", "nix-shell"]);

function isCommandStringWrapper(value: string): boolean {
	return COMMAND_STRING_WRAPPERS.has(executableName(value));
}

/**
 * True when the `'` at `index` opens an ANSI-C string (`$'…'`): an unescaped
 * `$` sits right before it. Inside one, a backslash escapes the next
 * character, a quote included (`$'\''` is one quote), so a scanner that ends
 * the string at the first `'` desyncs and reads what follows as quoted (#4739).
 */
function opensAnsiC(command: string, index: number): boolean {
	if (command[index - 1] !== "$") return false;
	let backslashes = 0;
	for (let i = index - 2; i >= 0 && command[i] === "\\"; i--) backslashes++;
	return backslashes % 2 === 0;
}

/**
 * Canonicalize shell parameter separators before command classification. The
 * quote-aware pass deliberately leaves literal arguments alone; the lexer
 * then supplies the command-position boundaries used by the guard.
 */
function canonicalizeGuardCommand(command: string): string {
	let result = "";
	let quote: "single" | "double" | undefined;
	let ansiC = false;
	let escaped = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "single") {
			result += ch;
			if (ansiC && ch === "\\") {
				result += command[i + 1] ?? "";
				i += 1;
			} else if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === "double") {
			result += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch === "'" ? "single" : "double";
			ansiC = ch === "'" && opensAnsiC(command, i);
			result += ch;
			continue;
		}
		const parameter = command.slice(i).match(/^\$\{IFS[^}]*\}/)?.[0];
		const positional = command.slice(i).match(/^\$IFS(?:\$[0-9]+)?/)?.[0];
		if (parameter || positional) {
			result += " ";
			i += (parameter ?? positional ?? "").length - 1;
			continue;
		}
		result += ch;
	}
	let collapsed = "";
	let pendingSpace = false;
	quote = undefined;
	// This pass does not know ANSI-C strings (#4739): on `$'\''` its quote state
	// flips, and only which blanks it collapses changes. The lexer splits on
	// every blank either way, and no decision reads the collapsed blanks.
	for (const ch of result) {
		if (!quote && ch === "\n") {
			collapsed += ch;
			pendingSpace = false;
			continue;
		}
		if (!quote && /\s/.test(ch)) {
			pendingSpace = collapsed.length > 0;
			continue;
		}
		if (pendingSpace) collapsed += " ";
		pendingSpace = false;
		collapsed += ch;
		if (!quote && (ch === "'" || ch === '"')) {
			quote = ch === "'" ? "single" : "double";
		} else if (
			(quote === "single" && ch === "'") ||
			(quote === "double" && ch === '"')
		) {
			quote = undefined;
		}
	}
	// Not the trailing end: a backslash-newline there is a line continuation
	// that joins the last word to nothing, and `git push\<newline>` is
	// `git push` (#4739).
	return collapsed.trimStart();
}

/** Normalize only a command-position token; never apply this to path args. */
function normalizeGuardVerbToken(value: string): string {
	return value
		.replace(/\\(?=[A-Za-z0-9_])/g, "")
		.replace(/`(?=.)/g, "")
		.replace(/\^(?=.)/g, "");
}

function expandGuardVerbToken(value: string): string[] {
	return normalizeGuardVerbToken(value).trim().split(/\s+/).filter(Boolean);
}

function delimitedSubstitutionBody(
	command: string,
	start: number,
	opener: string,
	closer: string,
): { body: string; end: number } | undefined {
	let depth = 1;
	let quote: "single" | "double" | undefined;
	let ansiC = false;
	let escaped = false;
	for (let i = start + opener.length; i < command.length; i++) {
		const ch = command[i];
		if (quote === "single") {
			if (ansiC && ch === "\\") i += 1;
			else if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === "double" && ch === '"') {
			quote = undefined;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch === "'" ? "single" : "double";
			ansiC = ch === "'" && opensAnsiC(command, i);
			continue;
		}
		if (command.startsWith(opener, i)) {
			depth += 1;
			i += opener.length - 1;
			continue;
		}
		if (command.startsWith(closer, i) && --depth === 0) {
			return { body: command.slice(start + opener.length, i), end: i };
		}
	}
	return undefined;
}

/**
 * Which git verbs a guard cares about (#2007).
 *
 * The wrapper, substitution, `$IFS`, PATHEXT, and text-consumer analysis
 * below took several review rounds to get right. A second guard that needs
 * the same "is this an actual git invocation, and which verb" answer must
 * reuse that analysis rather than grow a parallel lexer, so the classifier
 * takes the verb question as a parameter and keeps everything else shared.
 */
export interface GitVerbMatcher {
	/** Stable id for telemetry and tests. */
	readonly id: string;
	/**
	 * True when `verb` in git command position, with `argsAfterVerb`
	 * following it, is an operation this guard governs.
	 */
	readonly matchesVerb: (
		verb: string,
		argsAfterVerb: readonly string[],
	) => boolean;
	/**
	 * True when ANY non-leading (indirect) `git` token matches unconditionally.
	 * The commit/push guard is a policy gate an agent may want to evade, so
	 * unknown launchers fail closed there. A guard that protects the agent
	 * from its own accident sets this false and falls back to "an indirect
	 * git whose argv also carries a governed verb" — see
	 * `clients/shared-checkout-guard.ts`.
	 */
	readonly indirectAlwaysMatches: boolean;
	/**
	 * True when a LEADING post-verb `--help`/`-h` means "print documentation"
	 * and the invocation should not match (#2007).
	 *
	 * FALSE for the commit gate, and that is a contract, not a tuning knob.
	 * `-h` is a legal option VALUE: `git commit -m -h` creates a commit whose
	 * message is `-h` (verified against git 2.55 — it exits 0 and the log
	 * subject reads `-h`), and `git push --repo -h` really pushes. A gate that
	 * fails closed must not be talked out of a match by a token that might be
	 * a value. `git commit --help` therefore still classifies as an attempt,
	 * exactly as it did before this seam existed.
	 */
	readonly suppressPostVerbHelp: boolean;
}

const COMMIT_PUSH_MATCHER: GitVerbMatcher = {
	id: "commit-push",
	matchesVerb: (verb) => verb === "commit" || verb === "push",
	indirectAlwaysMatches: true,
	suppressPostVerbHelp: false,
};

function containsGuardedSubstitution(
	command: string,
	depth: number,
	matcher: GitVerbMatcher,
): boolean {
	if (depth > 3) return false;
	let quote: "single" | "double" | undefined;
	let ansiC = false;
	let escaped = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "single") {
			if (ansiC && ch === "\\") i += 1;
			else if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === "double" && ch === '"') {
			quote = undefined;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch === "'" ? "single" : "double";
			ansiC = ch === "'" && opensAnsiC(command, i);
			continue;
		}
		const substitution = command.startsWith("$(", i)
			? delimitedSubstitutionBody(command, i, "$(", ")")
			: command.startsWith("<(", i)
				? delimitedSubstitutionBody(command, i, "<(", ")")
				: command.startsWith(">(", i)
					? delimitedSubstitutionBody(command, i, ">(", ")")
					: ch === "`"
						? {
								body: command.slice(i + 1, command.indexOf("`", i + 1)),
								end: command.indexOf("`", i + 1),
							}
						: undefined;
		if (substitution && substitution.end >= 0) {
			const nested = canonicalizeGuardCommand(substitution.body);
			if (
				containsGuardedSubstitution(nested, depth + 1, matcher) ||
				decodeShellWords(nested).some((segment) =>
					containsGuardedGitVerb(segment.words, depth + 1, matcher),
				)
			) {
				return true;
			}
			i = substitution.end;
		}
	}
	return false;
}

/** Git global options that consume the following token as their value. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
	"-C",
	"-c",
	"--config-env",
	"--git-dir",
	"--work-tree",
	"--exec-path",
	"--namespace",
]);

const GIT_GLOBAL_OPTIONS_WITH_INLINE_VALUE = [
	"--config-env",
	"--git-dir",
	"--work-tree",
	"--exec-path",
	"--namespace",
];

/**
 * Index of git's subcommand token in `gitTokens` (which starts at the `git`
 * executable), after skipping global options and their values. Returns
 * `undefined` when the invocation has no subcommand at all — `git --help`,
 * `git --version`, or a trailing option with no verb behind it.
 *
 * Shared by the direct and indirect paths so both ask the same question about
 * the same position (#2007).
 */
function gitVerbIndex(gitTokens: string[]): number | undefined {
	let i = 1;
	while (i < gitTokens.length && gitTokens[i].startsWith("-")) {
		const option = gitTokens[i];
		if (["--help", "-h", "--version", "-v", "-V"].includes(option)) {
			return undefined;
		}
		if (option === "--") return i + 1 < gitTokens.length ? i + 1 : undefined;
		if (
			["-C", "-c"].some(
				(prefix) => option.startsWith(prefix) && option.length > prefix.length,
			)
		) {
			i += 1;
			continue;
		}
		if (
			GIT_GLOBAL_OPTIONS_WITH_INLINE_VALUE.some((prefix) =>
				option.startsWith(`${prefix}=`),
			)
		) {
			i += 1;
			continue;
		}
		i += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
	}
	return i < gitTokens.length ? i : undefined;
}

/**
 * True when the subcommand in git's command position is one the matcher
 * governs. `gitTokens[0]` is the `git` executable token.
 */
export function matchGitVerbAtCommandPosition(
	gitTokens: string[],
	matcher: GitVerbMatcher,
): boolean {
	const index = gitVerbIndex(gitTokens);
	if (index === undefined) return false;
	const argsAfterVerb = gitTokens.slice(index + 1);
	// `git checkout --help` prints documentation and touches nothing, and the
	// global-option walk above cannot see it, because it sits AFTER the verb.
	//
	// Only the FIRST argument counts, and only for matchers that opt in. `-h`
	// deeper in the argv may be an option VALUE rather than a help request —
	// `git commit -m -h` commits with the message `-h`, `git clean -e -h`
	// excludes a pattern named `-h`. Reading any position would need a
	// per-verb table of value-taking options for every governed verb, which is
	// exactly the hand-maintained parallel list this repo forbids, and every
	// gap in it would silently UNDER-block. Leading-position-only needs no
	// table, covers how help is actually invoked, and every other spelling
	// falls through to a match, which is the safe direction for a guard.
	if (
		matcher.suppressPostVerbHelp &&
		(argsAfterVerb[0] === "--help" || argsAfterVerb[0] === "-h")
	) {
		return false;
	}
	const verbs = expandGuardVerbToken(gitTokens[index] ?? "");
	return verbs.length === 1 && matcher.matchesVerb(verbs[0], argsAfterVerb);
}

/** Strip one layer of shell quoting the lexer preserved on a value token. */
function unquoteGuardValue(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' || first === "'") && first === last) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

/**
 * The directory a git invocation actually targets (#2007).
 *
 * `git -C <dir>` and `--work-tree` retarget the command at a DIFFERENT
 * directory, so a guard that evaluates the caller's cwd would inspect the
 * wrong working tree and allow a destructive command against a shared one.
 * `-C` composes cumulatively, exactly as git applies it; `--work-tree` names
 * the working tree directly and therefore wins.
 *
 * Returns the resolved absolute directory, or `cwd` when the invocation
 * carries no retargeting option.
 */
export function resolveGitTargetDirectory(
	gitTokens: string[],
	cwd: string,
): string {
	let base = cwd;
	let workTree: string | undefined;
	let i = 1;
	while (i < gitTokens.length && gitTokens[i].startsWith("-")) {
		const option = gitTokens[i];
		if (["--help", "-h", "--version", "-v", "-V"].includes(option)) break;
		if (option === "--") break;
		if (option === "-C" && i + 1 < gitTokens.length) {
			base = path.resolve(base, unquoteGuardValue(gitTokens[i + 1]));
			i += 2;
			continue;
		}
		if (option.startsWith("-C") && option.length > 2) {
			base = path.resolve(base, unquoteGuardValue(option.slice(2)));
			i += 1;
			continue;
		}
		if (option === "--work-tree" && i + 1 < gitTokens.length) {
			workTree = unquoteGuardValue(gitTokens[i + 1]);
			i += 2;
			continue;
		}
		if (option.startsWith("--work-tree=")) {
			workTree = unquoteGuardValue(option.slice("--work-tree=".length));
			i += 1;
			continue;
		}
		if (
			option.startsWith("-c") &&
			option.length > 2 &&
			!option.startsWith("--")
		) {
			i += 1;
			continue;
		}
		if (
			GIT_GLOBAL_OPTIONS_WITH_INLINE_VALUE.some((prefix) =>
				option.startsWith(`${prefix}=`),
			)
		) {
			i += 1;
			continue;
		}
		i += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
	}
	return workTree === undefined ? base : path.resolve(base, workTree);
}

/**
 * Every git invocation the command contains, as token arrays starting at the
 * `git` executable. Used by callers that must know WHICH directory a matched
 * command targets, not merely that it matched (#2007).
 */
export function collectGitInvocations(
	toolName: string,
	input: unknown,
): string[][] {
	if (toolName !== "bash") return [];
	const command = getShellCommand(input);
	if (!command) return [];
	const invocations: string[][] = [];
	for (const segment of decodeShellWords(canonicalizeGuardCommand(command))) {
		const tokens = segment.words.map((word) => word.text);
		const gitIndex = tokens.findIndex((token) => isGitExecutable(token));
		if (gitIndex >= 0) invocations.push(tokens.slice(gitIndex));
	}
	return invocations;
}

/**
 * A command string is a shell's, so its words are lexed again as one (the
 * decoded text of each word, joined): `bash -c $'git\x20push'` reads
 * `git push` (#4739 round 5).
 */
function commandStringHasGuardedVerb(
	words: readonly DecodedShellWord[],
	depth: number,
	matcher: GitVerbMatcher,
): boolean {
	return decodeShellWords(
		canonicalizeGuardCommand(words.map((word) => word.text).join(" ")),
	).some((segment) => containsGuardedGitVerb(segment.words, depth, matcher));
}

/**
 * Whether a word the model cannot read may start a guarded command (#4739). The
 * word model says what it cannot read (`DecodedShellWord.hidden`); this is the
 * gate's answer, and it fails closed: the word may be any word. As git, a
 * later word that is a governed verb guards the command (`$g push`), and so
 * does a later unread word when the first unread word is the command word
 * itself (`$g $v`). After a readable command word an unread word is an
 * argument, so `cp $SRC $DST` stays plain (round 6); `env $g $v` is the cost,
 * as on master. As `eval`, a launcher or its command-string switch, a later
 * word that holds a guarded command guards it (`bash $c 'git push'`,
 * `$e 'git push'`, round 4). Each later word is read alone, as `-c` takes one:
 * read joined, `$SHELL -c 'git status'` would put git at a non-leading index.
 * Git's own verb is the caller's case. An ANSI-C word is no such word: the
 * model decodes it (round 5). `docker push $IMAGE` reads nothing it cannot
 * see before its verb, and stays unguarded.
 *
 * Only a policy gate (`indirectAlwaysMatches`) answers this way: the guard that
 * protects an agent from its own accident would block commands it can read.
 */
function hidesGuardedVerb(
	words: readonly DecodedShellWord[],
	depth: number,
	matcher: GitVerbMatcher,
): boolean {
	if (!matcher.indirectAlwaysMatches) return false;
	const firstHidden = words.findIndex((word) => word.hidden);
	return (
		firstHidden >= 0 &&
		words
			.slice(firstHidden + 1)
			.some(
				(word) =>
					(firstHidden === 0 && word.hidden) ||
					matcher.matchesVerb(word.text, []) ||
					commandStringHasGuardedVerb([word], depth + 1, matcher),
			)
	);
}

function containsGuardedGitVerb(
	words: readonly DecodedShellWord[],
	depth: number,
	matcher: GitVerbMatcher,
): boolean {
	if (depth > 3 || words.length === 0) return false;
	let commandWords = words;
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(commandWords[0]?.text ?? "")) {
		commandWords = commandWords.slice(1);
	}
	if (commandWords.length === 0) return false;
	const expandedHead = expandGuardVerbToken(commandWords[0]?.text ?? "");
	if (expandedHead.length > 1) {
		commandWords = [
			...expandedHead.map((text) => ({ text })),
			...commandWords.slice(1),
		];
	}
	const commandTokens = commandWords.map((word) => word.text);
	if (isCommandStringWrapper(commandTokens[0] ?? "")) {
		const lower = commandTokens.slice(1).map((token) => token.toLowerCase());
		// nix-shell documents `--command` as `--run` in an interactive shell (#4739 r4).
		const runIndex = lower.findIndex(
			(token) => token === "--run" || token === "--command",
		);
		if (runIndex >= 0 && runIndex + 1 < commandTokens.length) {
			return commandStringHasGuardedVerb(
				commandWords.slice(runIndex + 2),
				depth + 1,
				matcher,
			);
		}
	}
	// These commands consume their following words as text/patterns; a bare
	// git token in their arguments is not an indirect executable invocation.
	// `$(git push)` is execution and must block; `"git push"` as literal text
	// is allowed. Substitutions are screened before this text-consumer escape.
	if (
		["echo", "printf", "grep"].includes(executableName(commandTokens[0] ?? ""))
	) {
		return false;
	}
	// `eval` joins its arguments and runs the result as a command string, as a
	// shell does for `-c`. A literal handed to it is read again, so
	// `eval "git push"` is the `git push` it runs (#4739 round 3). Like a
	// non-leading git, an `eval` after the first word is read too: `builtin eval`,
	// `command eval` and `if eval` run it (round 4). A string built by data flow
	// (`eval "$CMD"`) stays out of reach: it exists only at run time.
	const evalIndex = commandTokens.findIndex(
		(token) => executableName(token) === "eval",
	);
	if (
		evalIndex >= 0 &&
		commandStringHasGuardedVerb(
			commandWords.slice(evalIndex + 1),
			depth + 1,
			matcher,
		)
	) {
		return true;
	}
	if (hidesGuardedVerb(commandWords, depth, matcher)) return true;
	const gitIndex = commandTokens.findIndex((token) => isGitExecutable(token));
	if (gitIndex >= 0) {
		// Any non-leading git invocation is indirect. Do not maintain a wrapper
		// or flag allowlist: unknown launchers are the security boundary here.
		if (gitIndex > 0 && matcher.indirectAlwaysMatches) return true;
		const gitTokens = commandTokens.slice(gitIndex);
		const verbAt = gitVerbIndex(gitTokens);
		// A verb the model cannot read (`git $sub`, `git {push,x}`) is not
		// a verb the matcher can refuse.
		if (
			matcher.indirectAlwaysMatches &&
			verbAt !== undefined &&
			commandWords[gitIndex + verbAt]?.hidden
		) {
			return true;
		}
		// #2007: a guard that protects the agent from its own accident must not
		// decline `xargs git status`, so the indirect path stays armed only when
		// a governed verb sits in git's real COMMAND POSITION. Scanning every
		// token instead would fire on `find . -name checkout | xargs git add`,
		// where `checkout` is a positional value and not a subcommand at all.
		return matchGitVerbAtCommandPosition(gitTokens, matcher);
	}
	const leadingExecutable = commandTokens[0] ?? "";
	const knownCommandStringWrapper =
		isShellWrapper(leadingExecutable) ||
		isCommandStringWrapper(leadingExecutable);
	if (!knownCommandStringWrapper) {
		// Unknown launchers are a fail-closed boundary only when they explicitly
		// accept a command string. Re-tokenizing the value keeps literal mentions
		// such as `myprog -c "echo git push"` out of the guarded-command path.
		const unknownSwitchIndex = commandTokens
			.slice(1)
			.findIndex(
				(token) =>
					(token.startsWith("-") || token.startsWith("/")) && token.length > 1,
			);
		if (unknownSwitchIndex < 0) return false;
		const commandIndex = unknownSwitchIndex + 2;
		if (commandIndex >= commandTokens.length) return false;
		return commandStringHasGuardedVerb(
			commandWords.slice(commandIndex),
			depth + 1,
			matcher,
		);
	}
	const lower = commandTokens.slice(1).map((token) => token.toLowerCase());
	const switchIndex = lower.findIndex(
		(token) =>
			token === "-c" ||
			token === "--run" ||
			token === "-lc" ||
			(/^-[^-]*c$/.test(token) && !token.startsWith("--")) ||
			token === "/c" ||
			token === "-command" ||
			token === "-command:" ||
			token === "-encodedcommand",
	);
	if (switchIndex < 0 || switchIndex + 1 >= commandTokens.length) return false;
	// Encoded PowerShell is intentionally unsupported: decoding it here would
	// be a second shell/parser and could turn an ambiguous command into a false
	// allow. Plain -Command/-c is safely handed back to the shared lexer.
	if (lower[switchIndex] === "-encodedcommand") return false;
	// switchIndex is relative to commandTokens.slice(1), so +2 addresses the
	// command token after the switch for both cmd and PowerShell. This also
	// handles cmd options preceding /C (for example `/S /C`).
	let commandIndex = switchIndex + 2;
	if (commandTokens[commandIndex] === "--") commandIndex += 1;
	return commandStringHasGuardedVerb(
		commandWords.slice(commandIndex),
		depth + 1,
		matcher,
	);
}

/**
 * Analyze actual executable invocations, not substrings in shell text.
 *
 * Shared entry point for every guard that needs "is this bash input really a
 * git invocation of a verb I govern" (#2007). The verb question is the only
 * parameter; wrapper, substitution, and text-consumer analysis are identical
 * for all callers by construction.
 */
export function detectGuardedGitVerb(
	toolName: string,
	input: unknown,
	matcher: GitVerbMatcher,
): boolean {
	if (toolName !== "bash") return false;
	const command = getShellCommand(input);
	if (!command) return false;
	const canonical = canonicalizeGuardCommand(command);
	if (containsGuardedSubstitution(canonical, 0, matcher)) return true;
	return decodeShellWords(canonical).some((segment) =>
		containsGuardedGitVerb(segment.words, 0, matcher),
	);
}

/** The #1063 commit gate's own question. */
export function isGitCommitOrPushAttempt(
	toolName: string,
	input: unknown,
): boolean {
	return detectGuardedGitVerb(toolName, input, COMMIT_PUSH_MATCHER);
}

/**
 * The working trees one commit/push command writes to (#4941): what the gate
 * judges, instead of every blocker the process holds. `contains` answers
 * whether a path (a blocker's file, or the directory a latch is about) lies
 * in one of them. A tree is a git checkout, found by the one seam the review
 * graph and the analysis root use (`resolveGitCheckout`); a linked worktree is
 * a tree of its own.
 */
export interface CommitScope {
	contains(target: string): boolean;
}

/**
 * Commands that cannot move a later `git`'s directory or environment: the
 * only words besides `git` itself a scoped command may contain. `cd`,
 * `pushd`, `export`, an assignment, a function, a wrapper or anything else
 * not listed leaves the command unscoped, so a form nobody planned for is
 * judged by every blocker (AGENTS.md: gates fail closed).
 */
const SCOPE_NEUTRAL_COMMANDS: readonly string[] = [
	"echo",
	"printf",
	"tail",
	"head",
	"cat",
	"grep",
	"wc",
	"true",
];

/**
 * The words a scoped command may run as `git`: the bare name the shell finds
 * on PATH and the system locations a resolved path takes. Any other spelling
 * (`/tmp/evil/git`, `./git`, `git.cmd`) is a file the gate cannot vouch for,
 * which may retarget before it execs git, so the command goes unscoped
 * (#4941 r2 F4).
 */
const SCOPE_GIT_HEADS: readonly string[] = [
	"git",
	"/usr/bin/git",
	"/usr/local/bin/git",
	"/bin/git",
	"/opt/homebrew/bin/git",
];

/**
 * Variables git reads to find its repository or working tree before it looks
 * at the cwd. Set in the process, they retarget a command that names none of
 * them, so a scope read from the cwd would name the wrong tree (#4941 r2 F3).
 */
const GIT_RETARGETING_ENV: readonly string[] = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];

/** A stat that fails any way but ENOENT leaves the target unreadable, not scoped. */
function isExistingDirectory(directory: string): boolean {
	try {
		return (
			nodeFs.statSync(directory, { throwIfNoEntry: false })?.isDirectory() ??
			false
		);
	} catch {
		// none: an unreadable `-C` target (EACCES, ELOOP) is not a tree the gate
		// can place, so the command goes unscoped and every blocker is judged.
		return false;
	}
}

/**
 * The trees a bash `git commit`/`git push` command targets, or `undefined`
 * when it is not a form this reads, in which case the gate judges every
 * blocker. Admitted: segments that are a plain `git` (no assignment,
 * wrapper or substitution that runs git, and only a {@link SCOPE_GIT_HEADS}
 * spelling of it) or a {@link SCOPE_NEUTRAL_COMMANDS} word, with at least one
 * commit/push segment whose only global options are `-C <readable existing
 * directory>` and whose directory is inside a git checkout, in a process
 * whose environment does not retarget git ({@link GIT_RETARGETING_ENV}).
 */
export function resolveCommitScope(
	toolName: string,
	input: unknown,
	cwd: string,
): CommitScope | undefined {
	if (toolName !== "bash") return undefined;
	if (GIT_RETARGETING_ENV.some((name) => process.env[name])) return undefined;
	const command = getShellCommand(input);
	if (!command) return undefined;
	const canonical = canonicalizeGuardCommand(command);
	if (containsGuardedSubstitution(canonical, 0, COMMIT_PUSH_MATCHER)) {
		return undefined;
	}
	const trees: GitCheckout[] = [];
	for (const segment of decodeShellWords(canonical)) {
		const words = segment.words;
		const head = words[0]?.text;
		if (head === undefined) continue;
		if (!SCOPE_GIT_HEADS.includes(head)) {
			if (!SCOPE_NEUTRAL_COMMANDS.includes(head)) return undefined;
			continue;
		}
		const tokens = words.map((word) => word.text);
		if (!matchGitVerbAtCommandPosition(tokens, COMMIT_PUSH_MATCHER)) continue;
		const verbAt = gitVerbIndex(tokens);
		if (verbAt === undefined) return undefined;
		for (let i = 1; i < verbAt; i += 2) {
			const value = words[i + 1];
			if (
				tokens[i] !== "-C" ||
				value === undefined ||
				value.hidden ||
				value.tildeExpands
			) {
				return undefined;
			}
		}
		const directory = resolveGitTargetDirectory(tokens, cwd);
		if (!isExistingDirectory(directory)) return undefined;
		const checkout = resolveGitCheckout(directory);
		if (!checkout) return undefined;
		trees.push(checkout);
	}
	if (trees.length === 0) return undefined;
	return {
		// The target's own checkout, or one nested inside a committed tree: the
		// parent's commit stages a tracked file under it (#4941 r2 F2). A linked
		// worktree of the committed repository is a tree of its own, never the
		// parent's.
		contains: (target) => {
			const owner = resolveGitCheckout(target);
			if (!owner) return false;
			return trees.some(
				(tree) =>
					pathsEqual(tree.root, owner.root) ||
					(isUnderDir(owner.root, tree.root) &&
						!sameCheckoutOtherRoot(tree, owner)),
			);
		},
	};
}

function isTurnEndFindingsCache(value: unknown): value is TurnEndFindingsCache {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<TurnEndFindingsCache>;
	return (
		typeof record.content === "string" &&
		typeof record.hasBlockers === "boolean" &&
		Array.isArray(record.affectedFiles) &&
		record.affectedFiles.every((file) => typeof file === "string") &&
		typeof record.sessionId === "string" &&
		typeof record.projectSeqStart === "number" &&
		typeof record.projectSeqEnd === "number" &&
		Number.isFinite(record.projectSeqStart) &&
		Number.isFinite(record.projectSeqEnd) &&
		!!record.fileSeqByPath &&
		typeof record.fileSeqByPath === "object" &&
		Object.values(record.fileSeqByPath).every(
			(seq) => typeof seq === "number" && Number.isFinite(seq),
		) &&
		!!record.fileContentHashes &&
		typeof record.fileContentHashes === "object" &&
		Object.values(record.fileContentHashes).every(
			(hash) => typeof hash === "string",
		) &&
		(record.affectedFilesTruncated === undefined ||
			typeof record.affectedFilesTruncated === "boolean") &&
		(record.blockingFiles === undefined ||
			Array.isArray(record.blockingFiles)) &&
		wellFormedStamp(record.blockerWrittenAt) &&
		carriesWellFormedBlockers(record)
	);
}

/**
 * The only `carriedBlockers` a record may hold (#4738): absent, or a list of
 * non-empty partitions, each with a string owner other than the record's own
 * and every owner distinct, beside a non-empty top-level `blockerContent` (a
 * writer keeps a carried partition only under a top-level one). Any other form
 * is not a record, so the gate refuses it.
 */
function carriesWellFormedBlockers(
	record: Partial<TurnEndFindingsCache>,
): boolean {
	const carried = record.carriedBlockers;
	if (carried === undefined) return true;
	if (!Array.isArray(carried) || carried.length === 0) return false;
	if (typeof record.blockerContent !== "string" || !record.blockerContent)
		return false;
	const owners = new Set<string>([String(record.sessionId)]);
	return carried.every((partition) => {
		const ok =
			!!partition &&
			typeof partition.sessionId === "string" &&
			!owners.has(partition.sessionId) &&
			typeof partition.blockerContent === "string" &&
			partition.blockerContent.length > 0 &&
			Array.isArray(partition.blockingFiles) &&
			partition.blockingFiles.every((file) => typeof file === "string") &&
			wellFormedStamp(partition.blockerWrittenAt);
		if (ok) owners.add(partition.sessionId);
		return ok;
	});
}

/**
 * A partition's write stamp (#4750): absent (a released writer's record) or an
 * epoch-ms number. Any other value is not a record, so the gate refuses it
 * rather than read an age it cannot compute as never expiring.
 */
function wellFormedStamp(stamp: unknown): boolean {
	return stamp === undefined || Number.isFinite(stamp);
}

/** A stored record's fields as read, before any of them is trusted. */
type StoredRecord = Partial<TurnEndFindingsCache>;

/**
 * A stored value: its fields, or `undefined` fields for a value that is not an
 * object (#4733 r2). It is present, so the gate still refuses it, and it is
 * never read as a record that makes no claim.
 */
interface StoredValue {
	readonly fields: StoredRecord | undefined;
}

/**
 * The stored value WHATEVER ITS AGE (#4725), or `undefined` when there is none
 * or it cannot be read.
 *
 * The cache's freshness window is the gate's bound on TRUSTING a recorded
 * blocker, not a reason for the record's own writers to stop seeing it. Read
 * through the window, a stale record was invisible to every writer that could
 * carry or retire it: a clean write latched `cache_stale`, the turn end's
 * clean-up skipped it, and it refused every commit in every later session.
 */
function storedRecord(
	cacheManager: CacheManager,
	cwd: string,
): StoredValue | undefined {
	const read = cacheManager.readCache<unknown>(
		"turn-end-findings",
		cwd,
		Number.POSITIVE_INFINITY,
	);
	if (!read) return undefined;
	const { data } = read;
	// The parse that makes the type true, not a verdict: every claim predicate
	// already fails closed on a value with none of the record's fields.
	return {
		fields:
			data && typeof data === "object" ? (data as StoredRecord) : undefined,
	};
}

function cacheRecord(
	cacheManager: CacheManager,
	cwd: string,
): TurnEndFindingsCache | undefined {
	const fields = storedRecord(cacheManager, cwd)?.fields;
	return isTurnEndFindingsCache(fields) ? fields : undefined;
}

/**
 * True only for a record that states it carries no blocker (#4725): an explicit
 * `hasBlockers: false`, no test failures, and no blocker text. These are the
 * only fields a commit verdict reads to ALLOW, so a record that claims them
 * answers for nothing whichever session wrote it and however old it is. Every
 * other form (a blocker, a contradiction, a record with no claim at all) is
 * not admitted here and keeps failing closed.
 */
function claimsNoBlocker(fields: StoredRecord | undefined): boolean {
	if (!fields) return false;
	return (
		fields.hasBlockers === false &&
		(fields.testFailures === undefined || fields.testFailures === false) &&
		(fields.blockerContent === undefined || fields.blockerContent === "") &&
		// #4733 r1 F7: a test failure's text or files contradict the claim too.
		(fields.testFailureContent === undefined ||
			fields.testFailureContent === "") &&
		(fields.testFailureFiles === undefined ||
			(Array.isArray(fields.testFailureFiles) &&
				fields.testFailureFiles.length === 0)) &&
		// #4738: another session's carried blocker contradicts it too.
		fields.carriedBlockers === undefined
	);
}

/**
 * Every session's blocker sections in `record`, the top-level owner's first
 * (#4738). A record from before #4738 has no `carriedBlockers`, so it reads as
 * one partition owned by its `sessionId`.
 */
function recordPartitions(record: TurnEndFindingsCache): BlockerPartition[] {
	const top: BlockerPartition[] = record.blockerContent
		? [
				{
					sessionId: record.sessionId,
					blockerContent: record.blockerContent,
					blockingFiles: record.blockingFiles ?? [],
					blockerWrittenAt: record.blockerWrittenAt,
				},
			]
		: [];
	return [...top, ...(record.carriedBlockers ?? [])];
}

/**
 * The record fields for `partitions`, the first at top level and the rest
 * carried (#4738). `owner` is the first partition's session, `undefined` when
 * none is left, so the caller names the owner of a record that holds no
 * blocker section.
 */
export function blockerPartitionFields(
	partitions: readonly BlockerPartition[],
): {
	owner: string | undefined;
	blockerContent: string | undefined;
	blockingFiles: string[] | undefined;
	carriedBlockers: BlockerPartition[] | undefined;
	blockerWrittenAt: number | undefined;
} {
	const [top, ...carried] = partitions;
	return {
		owner: top?.sessionId,
		blockerContent: top?.blockerContent,
		blockingFiles: top?.blockingFiles,
		carriedBlockers: carried.length > 0 ? carried : undefined,
		blockerWrittenAt: top?.blockerWrittenAt,
	};
}

/**
 * True when the file a section names no longer exists: `ENOENT`/`ENOTDIR`
 * only, so an unreadable file is not gone. A stat, never a read.
 */
function sectionFileGone(section: BlockerSection, cwd: string): boolean {
	try {
		return (
			nodeFs.statSync(resolveGuardPath(section.file, cwd), {
				throwIfNoEntry: false,
			}) === undefined
		);
	} catch {
		// none: a stat that fails any other way (EACCES, ELOOP) is no proof the
		// file is gone, so its section stays and the gate keeps refusing on it,
		// naming the file: the refusal is this failure's record.
		return false;
	}
}

/**
 * `partition` with the sections `leaves` admits removed, the files `dropKeys`
 * names gone from its `blockingFiles` (#4738). Text the parse cannot attribute
 * keeps the whole partition, byte for byte (fail closed, #1561); so does a
 * partition that loses no section.
 */
function trimPartition(
	partition: BlockerPartition,
	cwd: string,
	dropKeys: ReadonlySet<string>,
	leaves: (section: BlockerSection) => boolean,
): { kept: BlockerPartition | undefined; dropped: number } {
	const sections = blockingProvenance(
		partition.blockerContent,
		partition.blockingFiles,
		cwd,
	);
	if (!sections) return { kept: partition, dropped: 0 };
	const blockingFiles = partition.blockingFiles.filter(
		(file) => !dropKeys.has(guardPathKey(file, cwd)),
	);
	const keptSections = sections.filter((section) => !leaves(section));
	const dropped = sections.length - keptSections.length;
	if (keptSections.length === 0) return { kept: undefined, dropped };
	return {
		kept: {
			sessionId: partition.sessionId,
			blockerContent:
				dropped > 0
					? keptSections.map((section) => section.lines.join("\n")).join("\n\n")
					: partition.blockerContent,
			blockingFiles,
			blockerWrittenAt: partition.blockerWrittenAt,
		},
		dropped,
	};
}

/** One row per write that drops another session's or a shared record's sections (#4738). */
function logSectionsDropped(
	cwd: string,
	by: "turn_end" | "write",
	basis: "own_session" | "file_gone" | "no_file",
): void {
	logLatency({
		type: "phase",
		toolName: "git-guard",
		filePath: cwd,
		phase: "sections_dropped",
		durationMs: 0,
		result: basis,
		metadata: { by, basis },
	});
}

/**
 * What a turn-end rewrite leaves out of the other sessions' partitions: a
 * section whose file is gone, and text no file owns once it expired (#4750).
 */
export interface CarriedDrops {
	gone: boolean;
	noFile: boolean;
}

/**
 * The `sections_dropped` rows for `dropped`, one per basis. The write that
 * leaves the sections out calls it, never the read that found them (#4750:
 * the read logged them, so a turn end that wrote nothing still logged drops).
 */
export function logCarriedDrops(cwd: string, dropped: CarriedDrops): void {
	if (dropped.noFile) logSectionsDropped(cwd, "turn_end", "no_file");
	if (dropped.gone) logSectionsDropped(cwd, "turn_end", "file_gone");
}

/**
 * True once `partition`'s owner wrote it longer ago than the gate trusts the
 * record (#4750). A partition with no stamp (a writer before #4750) has no age
 * yet, so it is not past the window: the carry stamps it with the time it
 * first read it, the turn end writes that stamp, and the window runs from
 * there.
 */
function pastFreshnessWindow(
	partition: BlockerPartition,
	now: number,
): boolean {
	const writtenAt = partition.blockerWrittenAt;
	return writtenAt !== undefined && now - writtenAt > DEFAULT_MAX_AGE_MS;
}

/**
 * The other sessions' blocker sections a turn-end rewrite carries (#4738).
 *
 * The composer's write is this session's whole evidence, so it replaces this
 * session's own partition, and only that. Another session's FILE section stays
 * until its file is re-checked whole and clean (`syncGitGuardRecord`) or is
 * gone (the gate's `affected_files_resolved` rule). Text of another session's
 * that names no file (a project lane's report: trivy, knip, secrets, cascade)
 * has no file to re-check, and this session's lanes may not have re-run (a
 * lane that is unavailable, or a report of the other session's own edits), so
 * it stays with its owner, whole, until the owner's next turn end replaces it
 * or the gate's freshness window has passed since the owner wrote it (#4750).
 * Before #4750 every turn end replaced it, so the gate allowed a commit
 * nothing had re-checked.
 *
 * @returns the stored value, read whatever its age (#4725: the composer read
 * it through the freshness window, so a day-old record was invisible to it and
 * its write replaced the record whole), the partitions to carry, and what the
 * write leaves out, for `logCarriedDrops` once it has written.
 *
 * #4921: `sessionId` is the composing turn's session, the one whose own
 * partition the write replaces; omitted, the coordinator's.
 */
export function readTurnEndGuardRecord(
	cacheManager: CacheManager,
	runtime: RuntimeCoordinator,
	cwd: string,
	sessionId?: string,
): {
	stored: Partial<TurnEndFindingsCache> | undefined;
	carried: BlockerPartition[];
	dropped: CarriedDrops;
} {
	const stored = storedRecord(cacheManager, cwd)?.fields;
	// The composer writes on every path that reads, so a stamp this read gave
	// a released partition reaches the record with that write.
	const { carried, dropped } = carriedTurnEndBlockers(
		stored,
		cwd,
		sessionId ?? runtime.telemetrySessionId,
	);
	return { stored, carried, dropped };
}

function carriedTurnEndBlockers(
	stored: StoredRecord | undefined,
	cwd: string,
	/** The session whose own partition is not carried. */
	me: string,
): { carried: BlockerPartition[]; dropped: CarriedDrops; stamped: boolean } {
	const dropped: CarriedDrops = { gone: false, noFile: false };
	if (!isTurnEndFindingsCache(stored))
		return { carried: [], dropped, stamped: false };
	const now = Date.now();
	const carried: BlockerPartition[] = [];
	// A released partition carried whole gets its first stamp here.
	let stamped = false;
	for (const partition of recordPartitions(stored)) {
		if (partition.sessionId === me) continue;
		if (
			!blockingProvenance(
				partition.blockerContent,
				partition.blockingFiles,
				cwd,
			) &&
			!pastFreshnessWindow(partition, now)
		) {
			if (partition.blockerWrittenAt === undefined) stamped = true;
			carried.push({
				...partition,
				blockerWrittenAt: partition.blockerWrittenAt ?? now,
			});
			continue;
		}
		const split = splitBlockerSections(
			partition.blockerContent,
			partition.blockingFiles.filter(
				(file) => typeof file === "string" && file.trim().length > 0,
			),
			cwd,
		);
		if (split.unowned) dropped.noFile = true;
		const live = split.sections.filter(
			(section) => !sectionFileGone(section, cwd),
		);
		if (live.length < split.sections.length) dropped.gone = true;
		if (live.length === 0) continue;
		carried.push({
			sessionId: partition.sessionId,
			blockerContent:
				live.length === split.sections.length && !split.unowned
					? partition.blockerContent
					: live.map((section) => section.lines.join("\n")).join("\n\n"),
			blockingFiles: partition.blockingFiles,
			blockerWrittenAt: partition.blockerWrittenAt,
		});
	}
	return { carried, dropped, stamped };
}

/**
 * The only fields a record that makes NO claim carries (#4733 r1 F3): what the
 * `--lens-guard`-off turn-end writer stores for delivery
 * (`clients/runtime-turn.ts`, the `else` branch), and 3.8.74's `{ content }`.
 * `deliverTo` (#4943) addresses the content; it claims nothing.
 */
const NO_CLAIM_FIELDS = [
	"content",
	"affectedFiles",
	"affectedFilesTruncated",
	"provenance",
	"deliverTo",
] as const;

/**
 * True only for a record that holds no structured claim: an object with string
 * `content` and no field outside {@link NO_CLAIM_FIELDS}. Its `content` may
 * still be a blocker report the writer delivered (#4733 r2 F14), but no field
 * says so a check could answer, so it answers to no
 * file, so no re-check of one file clears it; the gate still refuses it, and a
 * settled turn end with no blocker retires it. Any other key (a claim, an
 * owner, a field no writer of these shapes stores) is not this form and keeps
 * failing closed.
 */
function makesNoClaim(fields: StoredRecord | undefined): boolean {
	return (
		!!fields &&
		typeof fields.content === "string" &&
		Object.keys(fields).every((key) =>
			NO_CLAIM_FIELDS.some((field) => field === key),
		)
	);
}

/** One row per retired record: a retire removes the record it describes. */
function logRecordRetired(
	cwd: string,
	by: "turn_end" | "write",
	basis:
		| "own_session"
		| "no_blocker"
		| "no_claim"
		| "rechecked"
		| "file_gone"
		| "no_file",
): void {
	logLatency({
		type: "phase",
		toolName: "git-guard",
		filePath: cwd,
		phase: "record_retired",
		durationMs: 0,
		result: basis,
		metadata: { by, basis },
	});
}

/**
 * The turn end's clean-up of the persisted record, once the turn settled with
 * no blocker in the runtime (the caller's guard). It retires the record when
 * it is this session's own and holds no test failure (the rule both turn-end
 * branches applied before #4725), when it claims no blocker at all, or when it
 * makes no claim (#4733 r1 F3: the `--lens-guard`-off writer's record, which
 * answers to no file) — read whatever its age, so a record the freshness
 * window hides is no longer kept for good. A record another session wrote
 * that still carries a blocker stays: this session's turn end did not
 * re-check it (`syncGitGuardRecord` clears it file by file as this session
 * re-checks the files it names). The latch that described the record goes
 * with it; a dispatch latch stays (`RecordLatchReason`).
 *
 * #4921: `sessionId` is the settling turn's session, whose own partition
 * leaves; omitted, the coordinator's.
 *
 * @returns true when the record was retired.
 */
export function retireSettledGitGuardRecord(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	sessionId?: string,
): boolean {
	const stored = storedRecord(cacheManager, cwd)?.fields;
	if (!stored) return false;
	const me = sessionId ?? runtime.telemetrySessionId;
	const own =
		stored.sessionId === me &&
		stored.testFailures !== true &&
		stored.carriedBlockers === undefined;
	const basis = own
		? "own_session"
		: claimsNoBlocker(stored)
			? "no_blocker"
			: makesNoClaim(stored)
				? "no_claim"
				: undefined;
	if (basis) {
		cacheManager.clearCache("turn-end-findings", cwd);
		runtime.clearGitGuardCacheUnknown(cwd);
		logRecordRetired(cwd, "turn_end", basis);
		return true;
	}
	return retireOwnPartition(runtime, cacheManager, cwd, stored, me);
}

/**
 * The settled turn end's share of a record it does not own whole (#4738):
 * this session's own blocker sections leave (its runtime holds no blocker),
 * every other session's stay as the composer carries them (a section whose
 * file is gone leaves, and so does text no file owns once it expired, #4750),
 * and the record is deleted only when none is left.
 *
 * @returns true when the record was deleted.
 */
function retireOwnPartition(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	stored: StoredRecord,
	me: string,
): boolean {
	if (!isTurnEndFindingsCache(stored)) return false;
	// A record this session owns whole: the rule above decided it.
	if (stored.sessionId === me && stored.carriedBlockers === undefined)
		return false;
	const ownDropped = recordPartitions(stored).some(
		(partition) => partition.sessionId === me,
	);
	const {
		carried: kept,
		dropped,
		stamped,
	} = carriedTurnEndBlockers(stored, cwd, me);
	if (!ownDropped && !dropped.gone && !dropped.noFile) {
		// #4762 r3: nothing dropped, so the partitions kept are the stored ones
		// in their order. A released one just got its first stamp, and only a
		// write keeps it: unwritten, every read-only turn end would restart its
		// window and the report would never expire.
		if (stamped) {
			const fields = blockerPartitionFields(kept);
			writeGitGuardRecord(cacheManager, runtime, cwd, {
				...stored,
				carriedBlockers: fields.carriedBlockers,
				blockerWrittenAt: fields.blockerWrittenAt,
			});
		}
		return false;
	}
	const testFailures = stored.testFailures === true;
	// Nothing is left only when every other session's section left with its
	// file or expired: a record shared with another session holds at least one
	// of theirs.
	if (kept.length === 0 && !testFailures) {
		cacheManager.clearCache("turn-end-findings", cwd);
		runtime.clearGitGuardCacheUnknown(cwd);
		logRecordRetired(cwd, "turn_end", dropped.noFile ? "no_file" : "file_gone");
		return true;
	}
	if (ownDropped) logSectionsDropped(cwd, "turn_end", "own_session");
	logCarriedDrops(cwd, dropped);
	const fields = blockerPartitionFields(kept);
	const owner = fields.owner ?? stored.sessionId;
	writeGitGuardRecord(cacheManager, runtime, cwd, {
		...stored,
		content: [
			fields.blockerContent,
			testFailures ? stored.testFailureContent : undefined,
		]
			.filter((value): value is string => !!value)
			.join("\n\n"),
		blockerContent: fields.blockerContent,
		blockingFiles: fields.blockingFiles,
		carriedBlockers: fields.carriedBlockers,
		blockerWrittenAt: fields.blockerWrittenAt,
		hasBlockers: kept.length > 0 || testFailures,
		sessionId: owner,
		// Nothing new to deliver: the sections kept were already in the record.
		consumed: stored.consumed === true,
		// #4943: the content is now the owner's blocker text, not the message
		// the composer addressed.
		deliverTo: undefined,
	});
	return false;
}

/**
 * Every reason this module latches about the stored record itself (#4733 r1
 * F4), the only reasons the coordinator's latch slot holds. A dispatch that
 * never answered is latched per file instead
 * (`markGitGuardDispatchUnanswered`, #4733 r2 F12), so a writer that deletes
 * or rewrites the record clears this slot and leaves that latch alone.
 */
type RecordLatchReason =
	| "session_mismatch"
	| "blocking_provenance_untrusted"
	| "cache_write_failed"
	| "cache_fresh"
	| "cache_stale"
	| "cache_malformed"
	| "cache_unreadable";

function markCacheUnknown(
	runtime: RuntimeCoordinator,
	reason: RecordLatchReason,
	cwd: string,
): void {
	runtime.markGitGuardCacheUnknown(reason, cwd);
}

/**
 * The session a rewritten record belongs to (#4733 r1 F1). The owner speaks
 * for the record's blocker sections, so a writer keeps the stored owner while
 * any stored section survives its write, and stamps this session only when it
 * writes none. Test failures carry no owner: only a passing run clears them.
 */
function recordOwner(
	existing: TurnEndFindingsCache | undefined,
	runtime: RuntimeCoordinator,
	storedSectionSurvives: boolean,
): string {
	return existing && storedSectionSurvives
		? existing.sessionId
		: runtime.telemetrySessionId;
}

/** Persist a complete, bounded, content-bound guard record. */
export function writeGitGuardRecord(
	cacheManager: CacheManager,
	runtime: RuntimeCoordinator,
	cwd: string,
	record: TurnEndFindingsCache,
): boolean {
	const capped = capAffectedFiles(
		Array.isArray(record.affectedFiles) ? record.affectedFiles : [],
		cwd,
	);
	const fileSeqByPath = { ...record.fileSeqByPath };
	for (const file of capped.files) {
		const key = guardPathKey(file, cwd);
		if (fileSeqByPath[key] === undefined) {
			fileSeqByPath[key] = runtime.getFileSeq(resolveGuardPath(file, cwd));
		}
	}
	const currentProvenance = snapshotAdvisoryProvenance({
		cwd,
		runtime,
		generation: 0,
		files: capped.files.map((file) => ({
			path: file,
			role: "affected" as const,
		})),
		truncated: capped.truncated,
	});
	const fileContentHashes = Object.fromEntries(
		currentProvenance.files.map((file) => [
			guardPathKey(file.path, cwd),
			file.sha256,
		]),
	);
	const data: TurnEndFindingsCache = {
		...record,
		affectedFiles: capped.files,
		affectedFilesTruncated: capped.truncated,
		fileSeqByPath,
		blockingFiles: Array.isArray(record.blockingFiles)
			? capAffectedFiles(record.blockingFiles, cwd).files
			: undefined,
		fileContentHashes,
		provenance: record.provenance ?? currentProvenance,
	};
	try {
		cacheManager.writeCache("turn-end-findings", data, cwd);
		runtime.clearGitGuardCacheUnknown(cwd);
		return true;
	} catch {
		markCacheUnknown(runtime, "cache_write_failed", cwd);
		return false;
	}
}

function logDecision(
	cwd: string,
	decision: "blocked" | "allowed" | "unknown",
	reasonCategory: string,
	metadata: Record<string, unknown> = {},
): void {
	logLatency({
		type: "phase",
		toolName: "git-guard",
		filePath: cwd,
		phase: "decision",
		durationMs: 0,
		result: decision,
		metadata: { decision, reasonCategory, ...metadata },
	});
}

/**
 * What clears an unknown state this session's own evidence describes: a write
 * re-dispatches the file and rewrites (or clears) the record and the latch.
 * Never "start a fresh session": a fresh session reads the same record (#4725).
 */
const RECHECK_REMEDY =
	"Write the affected files again so pi-lens re-checks them, then retry.";

const MAX_REMEDY_FILES = 5;

/** How a dispatch latch's file is shown: an outside path is never printed. */
function shownLatchFile(filePath: string, cwd: string): string {
	const resolved = resolveGuardPath(filePath, cwd);
	return isOutsideProjectRoot(resolved, cwd)
		? "a file outside the project"
		: toProjectRelativePath(resolved, cwd);
}

/**
 * The action that clears a stored record this session cannot confirm: one
 * another session wrote, one older than the freshness window, or one no
 * writer of this version produces (#4725). `undefined` for a record that is
 * this session's own, fresh evidence, whose unknown states `RECHECK_REMEDY`
 * answers.
 *
 * Each sentence names an action `syncGitGuardRecord`,
 * `clearGitGuardTestFailure` or `retireSettledGitGuardRecord` honours for such
 * a record: a clean dispatch of a named file drops that file's sections, a
 * passing run retires its test failures, and a settled turn end retires a
 * record that makes no claim. A record whose blockers name no file has no
 * such action, and the text says what replaces it instead of inventing one:
 * its writer's next turn end, or, for another session's, the end of the
 * freshness window since that session wrote it (#4750).
 */
function unconfirmedRecordRemedy(
	stored: StoredValue | undefined,
	inspection: CacheInspection,
	/** #4921: the session attempting the commit. */
	me: string,
	cwd: string,
): string | undefined {
	if (stored === undefined) return undefined;
	const { fields } = stored;
	const record = isTurnEndFindingsCache(fields) ? fields : undefined;
	const testRemedy =
		record?.testFailures === true
			? "Run the failing tests again: a passing run clears them."
			: undefined;
	if (
		record &&
		inspection === "fresh" &&
		record.sessionId === me &&
		record.carriedBlockers === undefined
	) {
		// #4733 r1 F5: a write re-checks this session's own files, and clears no
		// test failure, so a record that holds one names the passing run too.
		return testRemedy
			? `Write the affected files again so pi-lens re-checks them. ${testRemedy} Then retry.`
			: undefined;
	}
	// #4738: every owner's sections, each parsed against its own files.
	const parsed = record
		? recordPartitions(record).map((partition) =>
				blockingProvenance(
					partition.blockerContent,
					partition.blockingFiles,
					cwd,
				),
			)
		: [];
	const sections = parsed.flatMap((owned) => owned ?? []);
	const parts: string[] = [];
	if (sections.length > 0) {
		// #4733 r1 F6: a file outside the project is counted, never printed:
		// its spelling is not the model's to see.
		const named = new Set<string>();
		const outsideKeys = new Set<string>();
		for (const section of sections) {
			const resolved = resolveGuardPath(section.file, cwd);
			if (isOutsideProjectRoot(resolved, cwd)) outsideKeys.add(section.key);
			else named.add(toProjectRelativePath(resolved, cwd));
		}
		const outside = outsideKeys.size;
		const listed = [...named].slice(0, MAX_REMEDY_FILES);
		const shownParts = listed.length > 0 ? [listed.join(", ")] : [];
		if (named.size > listed.length) {
			shownParts.push(`${named.size - listed.length} more`);
		}
		if (outside > 0) {
			shownParts.push(
				`${outside} file${outside === 1 ? "" : "s"} outside the project`,
			);
		}
		const shown = shownParts.join(" and ");
		parts.push(
			`The record names blockers in ${shown} that pi-lens cannot confirm. Fix them and write each file again: a clean pi-lens check of a file clears its part of the record.`,
		);
	}
	if (makesNoClaim(fields)) {
		parts.push(
			"The record makes no blocker claim pi-lens can check, so no re-check of one file clears it; a turn that ends with no blocker clears it.",
		);
	} else if (!record) {
		parts.push(
			"The record holds blockers pi-lens cannot attribute to a file, so no re-check of one file clears them; this session's next turn-end findings replace it.",
		);
	} else if (parsed.some((owned) => owned === undefined)) {
		// #4750: a turn end carries another session's text no file owns until
		// that session replaces it or it expires (`carriedTurnEndBlockers`).
		parts.push(
			`The record holds blockers pi-lens cannot attribute to a file, so no re-check of one file clears them; the session that wrote them replaces them at its next turn end, and once ${DEFAULT_MAX_AGE_MS / 60_000} minutes pass without that session rewriting them, a turn end of any session drops them.`,
		);
	}
	if (testRemedy) parts.push(testRemedy);
	return parts.length > 0 ? `${parts.join(" ")} Then retry.` : undefined;
}

function unknown(
	cwd: string,
	reasonCategory: string,
	metadata = {},
	remedy = RECHECK_REMEDY,
): GuardDecision {
	logDecision(cwd, "unknown", reasonCategory, metadata);
	return {
		block: true,
		unknown: true,
		reason: `🔴 COMMIT BLOCKED (--lens-guard): blocker state is unknown (${reasonCategory}). ${remedy}`,
	};
}

/**
 * Reconcile the one persisted record after a per-file dispatch. This is called
 * on tool_result, never tool_call, and therefore does not add disk I/O to the
 * edit preflight path.
 */
/**
 * Retire one file's inline blocker on a confirmed-clean verdict, then bring the
 * commit gate back in line with the map (#1561 F2).
 *
 * Retiring the map entry alone is not enough and claiming otherwise was wrong:
 * the gate reads a LATCH (`gitGuardHasBlockers`) and a PERSISTED record, and
 * `evaluateGitGuard` short-circuits on the latch before it ever looks at the
 * record. A retire that touched neither left the commit blocked and quoted the
 * retired blocker back as the reason.
 *
 * Both are recomputed exactly the way a clean dispatch recomputes them:
 * `updateGitGuardStatus(false, "")` re-derives the latch from the blocker map
 * — it cannot clear a latch another file's live blocker still justifies,
 * because that file's entry is still in the map — and `syncGitGuardRecord`
 * rewrites the persisted record from the same source of truth.
 *
 * Colocated with the gate rather than inlined at the wiring site so the claim
 * is testable without booting the extension.
 *
 * @returns true when the record was retired OR narrowed (at least one source
 * row left it; #4990 gap 1). Either way the caller records it — #1432 Gap 1 —
 * and the latch recompute below keeps a non-covered row gating the commit.
 */
export function retireInlineBlockerAndResyncGuard(args: {
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	cwd: string;
	filePath: string;
	writeIndex?: number;
	coveredSources: readonly string[];
	lensGuardEnabled: boolean;
}): boolean {
	// #4921: the retired record's section sits in its owner's partition, so
	// the resync speaks as that owner, whichever session ran the check.
	const owner = args.runtime.inlineBlockerOwner(args.filePath);
	const retired = args.runtime.retireInlineBlockerOnConfirmedClean(
		args.filePath,
		args.writeIndex,
		args.coveredSources,
	);
	if (!retired) return false;
	resyncGitGuardAfterRetire({ ...args, owner });
	return true;
}

/**
 * The gate half of a retirement: the latch re-derived from the map, then the
 * persisted record rewritten without `filePath`'s section, speaking as the
 * record's `owner`. Shared by every retire that leaves the map (the confirmed
 * clean above, and #5020's rows of other files, whose cited file was fixed or
 * deleted), so none of them can retire a record and leave the gate quoting it.
 */
export function resyncGitGuardAfterRetire(args: {
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	cwd: string;
	filePath: string;
	owner: string | undefined;
	lensGuardEnabled: boolean;
	analysisRootMode?: AnalysisRootMode;
	/** #5052 r2: the commit gate's checkout scope (see `syncGitGuardRecord`). */
	inCheckout?: ((filePath: string) => boolean) | undefined;
}): void {
	args.runtime.updateGitGuardStatus(false, "");
	if (args.lensGuardEnabled) {
		syncGitGuardRecord(
			args.runtime,
			args.cacheManager,
			args.cwd,
			args.filePath,
			args.analysisRootMode,
			undefined,
			args.owner,
			args.inCheckout,
		);
	}
}

/**
 * Bring the commit-gate LATCH back in line with the turn-end disposition
 * policy (#3248), at the point where the post-policy survivor set per file is
 * final.
 *
 * The defect this exists for: the agent marks every blocker on a file
 * `false-positive`, the turn-end composer renders no `Unresolved from this
 * turn` section and no `🔴 STOP` — and `lens-guard` still blocks the commit,
 * because `evaluateGitGuard` reads the LATCH first and the latch counted the
 * still-present map entry. The blocker record stays in the map on purpose: the
 * policy is content-bound and re-derived every turn end, so retiring the entry
 * would be silencing rather than filtering (AGENTS.md shape 10). It carries
 * the verdict instead, and the two gate derivations honor it — this latch, and
 * `syncGitGuardRecord`'s persisted `blockerContent` below.
 *
 * The persisted record needs no third writer here. The composer that calls
 * this rewrites it later in the SAME turn end from the same survivor set —
 * `writeGitGuardRecord` with `hasBlockers` derived from the surviving blocker
 * sections (`clients/runtime-turn.ts:4287`, and the dedupe path at `:4231`),
 * or `clearCache("turn-end-findings")` when nothing survives
 * (`clients/runtime-turn.ts:4379`) — and that clear is itself gated on the
 * latch this call just recomputed. Adding a second durable writer between them
 * would only race the one that already owns the record.
 *
 * Colocated with the gate rather than inlined at the wiring site, for the same
 * reason `retireInlineBlockerAndResyncGuard` is: the claim is testable without
 * booting the extension.
 */
export function resyncGitGuardAfterInlinePolicy(args: {
	runtime: RuntimeCoordinator;
	/** Files whose EVERY inline blocker the turn-end policy suppressed. */
	suppressedFilePaths: readonly string[];
	/**
	 * #4921: the turn session whose policy pass this is: only its records were
	 * judged, so only theirs take a verdict.
	 */
	sessionId: string | undefined;
}): void {
	const changed = args.runtime.applyInlineBlockerPolicyVerdicts(
		args.suppressedFilePaths,
		{ sessionId: args.sessionId },
	);
	// Nothing left the gate's view of the map and nothing rejoined it. This is
	// what keeps the recompute off every ordinary turn end: `updateGitGuardStatus`
	// re-derives the latch from the map, and a turn that changed no verdict has
	// no business re-deriving anything.
	if (args.suppressedFilePaths.length === 0 && changed === 0) return;
	// Exactly as the retire path re-derives it: `false` is this caller's own
	// contribution, never a blanket clear — a sibling file's surviving blocker
	// is still in the map and still sets the latch.
	args.runtime.updateGitGuardStatus(false, "");
}

/**
 * `editedCleanVerdict` is true only when the dispatch of `editedFilePath`
 * reached a clean verdict over the whole file (#4733 r1 F2): every runner and
 * server answered, over all of it, and the observation holds no blocker. Only
 * such a write speaks for another session's section of that file. A run with
 * no verdict (failed, unanswered, in flight, edit-scoped) observes nothing
 * (AGENTS.md shape 10), and this session's map, which carries its own blockers
 * through such runs, holds nothing of another session's.
 *
 * #4921: `sessionId` is the writing turn's session (omitted: the
 * coordinator's). Its partition is built from its own inline-blocker records
 * only and carries its id; a concurrent in-process session's records are its
 * own partition's, written by its own writes.
 */
export function syncGitGuardRecord(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	editedFilePath?: string,
	analysisRootMode: AnalysisRootMode = "session",
	editedCleanVerdict = false,
	sessionId?: string,
	/**
	 * #5048 (PR #5052 review): the commit gate's checkout scope. Its sync
	 * persists only the blockers in the committed tree, so another checkout's
	 * blocker is neither written into this cwd's cache nor judged by the
	 * commit. Omitted, every blocker of the session counts.
	 */
	inCheckout?: (filePath: string) => boolean,
): void {
	if (!canWriteAnalysisRoot(analysisRootMode)) return;
	// #3248: a record the turn-end policy fully suppressed is not a blocker the
	// commit gate may persist — the agent was shown nothing for it. The entry
	// stays in the map so the next turn re-derives the verdict from current
	// bytes; it just stops speaking for the gate.
	const entries = (
		runtime.getInlineBlockersSnapshot?.({ sessionId }) ?? []
	).filter(
		(entry) =>
			!entry.policySuppressed && (!inCheckout || inCheckout(entry.filePath)),
	);
	// #4725: the record is read whatever its age (`storedRecord`). Read through
	// the freshness window, a stale record latched `cache_stale` here on every
	// write, and no later session could clear it.
	const stored = storedRecord(cacheManager, cwd)?.fields;
	// A record that claims no blocker answers for nothing, whichever session
	// wrote it, so a write with no blocker of its own replaces it exactly as it
	// replaces a missing record (the clear branch below).
	if (entries.length === 0 && claimsNoBlocker(stored)) {
		cacheManager.clearCache("turn-end-findings", cwd);
		runtime.clearGitGuardCacheUnknown(cwd);
		logRecordRetired(cwd, "write", "no_blocker");
		return;
	}
	const existing = isTurnEndFindingsCache(stored) ? stored : undefined;
	const editedKey = editedFilePath
		? guardPathKey(editedFilePath, cwd)
		: undefined;
	const me = sessionId ?? runtime.telemetrySessionId;
	const blockerSections = existing?.blockerContent
		? blockingProvenance(
				existing.blockerContent,
				existing.blockingFiles ?? [],
				cwd,
			)
		: undefined;
	// #4738: every session's sections, each partition with its owner. A write
	// takes back only what it re-checked: this session's own section of the
	// edited file, another session's only with a whole-file clean verdict
	// (#4725, #4733 r1 F2), and another session's section whose file is gone
	// (the gate's `affected_files_resolved` rule). Every other section stays,
	// with its owner.
	const dropKey = new Set(editedKey ? [editedKey] : []);
	let droppedForeign = 0;
	let droppedOwn = 0;
	let goneForeign = 0;
	const trimmed: BlockerPartition[] = [];
	for (const partition of existing ? recordPartitions(existing) : []) {
		const own = partition.sessionId === me;
		const speaksForFile = !!editedKey && (own || editedCleanVerdict);
		const result = trimPartition(
			partition,
			cwd,
			speaksForFile ? dropKey : new Set(),
			(section) => {
				if (speaksForFile && section.key === editedKey) return true;
				if (own || !sectionFileGone(section, cwd)) return false;
				goneForeign += 1;
				return true;
			},
		);
		if (own) droppedOwn += result.dropped;
		else droppedForeign += result.dropped;
		if (result.kept) trimmed.push(result.kept);
	}
	const foreign = !!existing && existing.sessionId !== me;
	// Another session's record, and this write took nothing back from it.
	if (
		foreign &&
		entries.length === 0 &&
		droppedForeign === 0 &&
		droppedOwn === 0
	) {
		// #4921 r2 F1: the latch is process-wide, so it speaks for the record's
		// owner. Only the coordinator's own write may say "another session's
		// record"; a concurrent session's write leaves the record and the
		// latch to the session that owns them.
		if (sessionId !== undefined && !runtime.isCoordinatorSession(sessionId)) {
			recordDegradationOnce({
				kind: "git-guard-non-owner-write",
				subject: sessionId,
				reason:
					"a concurrent session's write left another session's commit-gate record and latch untouched",
			});
			return;
		}
		markCacheUnknown(runtime, "session_mismatch", cwd);
		return;
	}
	if (!existing && entries.length === 0) {
		const inspection = cacheManager.inspectCache("turn-end-findings", cwd);
		if (inspection !== "missing") {
			markCacheUnknown(runtime, `cache_${inspection}`, cwd);
			return;
		}
	}
	const fileSeqByPath: Record<string, number> = {};
	for (const [filePath, seq] of runtime.getFileSeqEntries?.() ?? []) {
		fileSeqByPath[guardPathKey(filePath, cwd)] = seq;
	}
	const inlineFiles = entries.map((entry) =>
		resolveGuardPath(entry.filePath, cwd),
	);
	if (existing?.blockerContent && !blockerSections) {
		markCacheUnknown(runtime, "blocking_provenance_untrusted", cwd);
		return;
	}
	// This session's own new evidence replaces its own partition and leads the
	// record (#4733 r5 F21: the writer of new sections owns the record); a write
	// with none keeps the stored order, so the stored owner stays while its
	// sections survive (#4733 r1 F1). The partition holds file sections only, so
	// it bears no write stamp: only text no file owns expires by one (#4750).
	const partitions =
		entries.length > 0
			? [
					{
						sessionId: me,
						blockerContent: entries
							.map((entry) => `${entry.filePath}: ${entry.summary}`)
							.join("\n"),
						blockingFiles: inlineFiles,
					},
					...trimmed.filter((partition) => partition.sessionId !== me),
				]
			: trimmed;
	const fields = blockerPartitionFields(partitions);
	const testFiles = existing?.testFailureFiles ?? [];
	let affectedFiles = [...(existing?.affectedFiles ?? []), ...inlineFiles];
	if (!entries.length && editedKey && existing) {
		const isStillTestFailure = testFiles.some(
			(file) => guardPathKey(file, cwd) === editedKey,
		);
		// Another session's section left for the edited file keeps it affected.
		// (A partition no file owns never reaches here: the provenance latch
		// above returns on it, and writers carry only owned sections.)
		const stillRecorded = partitions.some(
			(partition) =>
				!!blockingProvenance(
					partition.blockerContent,
					partition.blockingFiles,
					cwd,
				)?.some((section) => section.key === editedKey),
		);
		if (!isStillTestFailure && !stillRecorded) {
			affectedFiles = affectedFiles.filter(
				(file) => guardPathKey(file, cwd) !== editedKey,
			);
		}
	}
	const blockerContent = fields.blockerContent;
	const hasTestFailures = existing?.testFailures === true;
	const hasBlockers = partitions.length > 0 || hasTestFailures;
	const content = [
		blockerContent,
		hasTestFailures ? existing?.testFailureContent : undefined,
	]
		.filter((value): value is string => !!value)
		.join("\n\n");
	if (!hasBlockers && !content) {
		cacheManager.clearCache("turn-end-findings", cwd);
		// #3282 acceptance 5: this branch is a COMPLETE recomputation of the
		// gate's state that happens to find nothing left to record, so it owns the
		// unknown reason exactly as `writeGitGuardRecord` does (`:800`). Without
		// this, a reason latched earlier in the session outlived the record it
		// described and refused every commit after it, with no re-run able to
		// clear it.
		runtime.clearGitGuardCacheUnknown(cwd);
		if (droppedForeign > goneForeign)
			logRecordRetired(cwd, "write", "rechecked");
		else if (goneForeign > 0) logRecordRetired(cwd, "write", "file_gone");
		return;
	}
	if (goneForeign > 0) logSectionsDropped(cwd, "write", "file_gone");
	// #4725: what is left of another session's record is still that session's,
	// and so is its delivery state: this session re-checked one file, not the
	// rest. A record whose blocker sections are all gone keeps its owner for the
	// test failures it still holds. #4738: a record this session no longer
	// leads holds only sections already in it, so it keeps the stored delivery
	// state too, as the settled turn end's partition retire does.
	const owner = fields.owner ?? existing?.sessionId ?? me;
	writeGitGuardRecord(cacheManager, runtime, cwd, {
		content: content || existing?.content || "",
		blockerContent,
		blockingFiles: fields.blockingFiles ?? [],
		carriedBlockers: fields.carriedBlockers,
		blockerWrittenAt: fields.blockerWrittenAt,
		hasBlockers,
		affectedFiles,
		sessionId: owner,
		projectSeqStart: runtime.turnStartProjectSeq,
		projectSeqEnd: runtime.projectSeq,
		fileSeqByPath,
		fileContentHashes: {},
		consumed: owner !== me && existing?.consumed === true,
		testFailures: existing?.testFailures,
		testFailureContent: existing?.testFailureContent,
		testFailureFiles: existing?.testFailureFiles,
	});
}

/** Add blocking test failures to the same turn-end record. */
export function mergeGitGuardTestFailure(
	cacheManager: CacheManager,
	cwd: string,
	runtime: RuntimeCoordinator,
	content: string,
	files: string[],
): void {
	const existing = cacheRecord(cacheManager, cwd);
	const fileSeqByPath: Record<string, number> = {};
	for (const [filePath, seq] of runtime.getFileSeqEntries?.() ?? []) {
		fileSeqByPath[guardPathKey(filePath, cwd)] = seq;
	}
	const failedFiles = files.map((file) => resolveGuardPath(file, cwd));
	const blockerContent = existing?.blockerContent;
	// #4733 r1 F1: the stored sections stay, so their owner does.
	const sessionId = recordOwner(existing, runtime, !!blockerContent);
	const testFailureFiles = [
		...(existing?.testFailureFiles ?? []),
		...failedFiles,
	].filter(
		(file, index, all) =>
			all.findIndex(
				(candidate) => guardPathKey(candidate, cwd) === guardPathKey(file, cwd),
			) === index,
	);
	writeGitGuardRecord(cacheManager, runtime, cwd, {
		content: [blockerContent, content].filter(Boolean).join("\n\n"),
		blockerContent,
		blockingFiles: existing?.blockingFiles ?? [],
		// #4738: other sessions' sections ride along with their owners.
		carriedBlockers: existing?.carriedBlockers,
		blockerWrittenAt: existing?.blockerWrittenAt,
		testFailureContent: content,
		testFailureFiles: testFailureFiles,
		hasBlockers: true,
		affectedFiles: [...(existing?.affectedFiles ?? []), ...failedFiles],
		sessionId,
		projectSeqStart: runtime.turnStartProjectSeq,
		projectSeqEnd: runtime.projectSeq,
		fileSeqByPath,
		fileContentHashes: {},
		consumed: false,
		testFailures: true,
	});
}

/** A passing test run resolves only its own previous test failures. */
export function clearGitGuardTestFailure(
	cacheManager: CacheManager,
	cwd: string,
	runtime: RuntimeCoordinator,
	passedFiles: string[] = [],
): void {
	const existing = cacheRecord(cacheManager, cwd);
	if (!existing?.testFailures) return;
	const passedKeys = new Set(
		(passedFiles.length > 0
			? passedFiles
			: (existing.testFailureFiles ?? [])
		).map((file) => guardPathKey(file, cwd)),
	);
	const remainingFiles = (existing.testFailureFiles ?? []).filter(
		(file) => !passedKeys.has(guardPathKey(file, cwd)),
	);
	const blockerContent = existing.blockerContent ?? "";
	if (!blockerContent && remainingFiles.length === 0) {
		cacheManager.clearCache("turn-end-findings", cwd);
		runtime.clearGitGuardCacheUnknown(cwd);
		return;
	}
	// #4738: every owner's blocking files stay affected, not only the top
	// level's: a carried section's file dropped here left that owner's gate
	// judging its blocker with the file unchecked.
	const blockingKeys = new Set(
		[
			...(existing.blockingFiles ?? []),
			...(existing.carriedBlockers ?? []).flatMap(
				(partition) => partition.blockingFiles,
			),
		].map((file) => guardPathKey(file, cwd)),
	);
	const affectedFiles = existing.affectedFiles.filter(
		(file) =>
			blockingKeys.has(guardPathKey(file, cwd)) ||
			remainingFiles.some(
				(testFile) => guardPathKey(testFile, cwd) === guardPathKey(file, cwd),
			),
	);
	writeGitGuardRecord(cacheManager, runtime, cwd, {
		...existing,
		content: blockerContent,
		blockerContent,
		affectedFiles,
		testFailures: remainingFiles.length > 0,
		testFailureContent:
			remainingFiles.length > 0 ? existing.testFailureContent : undefined,
		testFailureFiles: remainingFiles.length > 0 ? remainingFiles : undefined,
		hasBlockers: !!blockerContent || remainingFiles.length > 0,
		// #4733 r1 F1: a passing run re-checks its tests, not the stored
		// sections, so they keep their owner.
		sessionId: recordOwner(existing, runtime, !!blockerContent),
		projectSeqStart: runtime.turnStartProjectSeq,
		projectSeqEnd: runtime.projectSeq,
		fileSeqByPath: Object.fromEntries(
			runtime
				.getFileSeqEntries()
				.map(([filePath, seq]) => [guardPathKey(filePath, cwd), seq]),
		),
		fileContentHashes: {},
		// #4943: the content is now the owner's blocker text.
		deliverTo: undefined,
	});
}

/**
 * The first suppression verdict in the blocker map that no longer describes the
 * file it was computed against, if any (#3248 round 2, GG-3283-01).
 *
 * `policySuppressed` is a statement about BYTES: the turn-end policy read the
 * file's current content, re-derived the record's blockers through the
 * content-bound disposition anchors, and found every one of them suppressed. It
 * is therefore only true while those bytes are still there. Everything that
 * changes a file THROUGH pi-lens re-establishes the verdict on its own — a
 * dispatch replaces the record wholesale, and the turn-end freshness sweep
 * demotes a self-drifted record. Since #4990 the demoted channel runs the same
 * policy pass, so a demoted record CAN be stamped suppressed; what keeps that
 * from opening the gate is the content check below, because a demoted record's
 * bytes no longer match the `recordedHash` its verdict was computed against.
 * Bytes that move OUTSIDE dispatch (an external formatter, a `git checkout`, an
 * editor write) trigger neither, and the commit gate can be
 * reached with no turn end in between at all — so the gate, the one reader that
 * can let a verdict OPEN a commit, confirms it here instead of trusting the
 * latch memo.
 *
 * Unverifiable is not clean: a record whose dispatch could not fingerprint the
 * file (`inlineBlockerFileContent` absent, `clients/pipeline.ts:1632`) carries
 * nothing to confirm, so it fails CLOSED — the same rule
 * `retireInlineBlockerOnConfirmedClean` applies to unknown provenance.
 *
 * Cost: nothing at all unless a verdict is live (the common case), then one
 * read per suppressed record — on commit/push attempts, the path that already
 * fingerprints every affected file below. A size/mtime fast path was written
 * first and deleted: `fileFingerprint` decides the same question on its own, so
 * the tiers were unmutatable branches, not guards. `fileFingerprint` also
 * returns `"missing"`/`"unreadable:<code>"` rather than throwing, and neither
 * can equal a recorded hash, so an unreadable file is expired too.
 */
function firstExpiredSuppressionVerdict(
	runtime: RuntimeCoordinator,
	inScope: ((filePath: string) => boolean) | undefined,
): { filePath: string; tier: string } | undefined {
	for (const entry of runtime.getInlineBlockersSnapshot?.() ?? []) {
		if (!entry.policySuppressed) continue;
		if (inScope && !inScope(entry.filePath)) continue;
		if (entry.recordedHash === undefined) {
			return { filePath: entry.filePath, tier: "no_baseline" };
		}
		if (fileFingerprint(entry.filePath) !== entry.recordedHash) {
			return { filePath: entry.filePath, tier: "content" };
		}
	}
	return undefined;
}

export function evaluateGitGuard(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	host: LensToolHost = "pi",
	/**
	 * #4921: the session attempting the commit (`ToolCallDeps.sessionId`);
	 * omitted, the coordinator's. A record only it owns is its own to judge.
	 */
	sessionId?: string,
	/**
	 * #4941: the command being gated. A commit/push in one repository is
	 * judged by that tree's blockers, whoever wrote them; omitted, or a form
	 * {@link resolveCommitScope} does not read, every blocker counts.
	 */
	invocation?: { toolName: string; input: unknown },
): GuardDecision {
	const me = sessionId ?? runtime.telemetrySessionId;
	const scope = invocation
		? resolveCommitScope(invocation.toolName, invocation.input, cwd)
		: undefined;
	const inScope = scope
		? (target: string) => scope.contains(resolveGuardPath(target, cwd))
		: undefined;
	// A record-failure latch names a project directory. One outside every
	// checkout (a workspace root above several repositories) cannot be placed
	// in a tree, so it counts for every commit (fail closed).
	const latchInScope = scope
		? (project: string) =>
				!resolveGitCheckout(resolveGuardPath(project, cwd)) ||
				scope.contains(resolveGuardPath(project, cwd))
		: undefined;
	// #2535 F3: a known tool with no mapping on this host resolves to
	// undefined — rephrase rather than naming a dead tool. `lens_diagnostics`
	// is pinned available on both hosts, so the fallback is defensive only.
	const diagnosticsTool = resolveLensToolName("lens_diagnostics", host);
	const inspectLine = diagnosticsTool
		? `Run ${diagnosticsTool} mode=all for full details, then commit again.`
		: "Inspect the full diagnostics, then commit again.";
	// #3814: a collect-later runner's answer that settled since the last turn
	// end has not been drained yet, so the latch below cannot know it. Feeding it
	// into the blocker map first makes the latch the one verdict. A failure here
	// leaves the pre-#3814 answer (the turn-end drain still records it), counted
	// once rather than refusing every commit on a bug the agent cannot fix.
	try {
		const absorbed = absorbSettledRunnerBlockers(runtime, cwd);
		// The inline path refreshes the persisted record beside the latch at
		// `tool_result`; a recording at the gate has no turn end to do it, and a
		// session boundary reads the record, not the latch (r1 M3). #5048: both
		// resyncs persist only the committing session's records into this cwd's
		// cache, and only those in the committed checkout (#5052 review:
		// `inScope`). An answer absorbed for another session joins the map (and
		// the latch) for its owner, whose own write or turn end persists it.
		if (absorbed.recorded > 0) {
			syncGitGuardRecord(
				runtime,
				cacheManager,
				cwd,
				undefined,
				undefined,
				undefined,
				sessionId,
				inScope,
			);
		}
		// #4484 r2: a retire speaks for its file, as a clean write does, so the
		// persisted record drops that file's section.
		for (const filePath of absorbed.retiredFiles) {
			syncGitGuardRecord(
				runtime,
				cacheManager,
				cwd,
				filePath,
				undefined,
				undefined,
				sessionId,
				inScope,
			);
		}
		// #5020: a row naming a file that was deleted since the record was made
		// has nothing left to fix, and no dispatch will ever re-take it. The gate
		// is the read that matters, so it retires them before it judges. Only the
		// committing session's records: the resync below writes this cwd's
		// cache, which holds that session's records and no other's, so another
		// session's row is left to its own gate or turn end, which writes the
		// owner's cache (PR #5033 round 3 item 4).
		for (const retired of runtime.retireForeignRowsOfMissingFiles({
			sessionId,
		})) {
			resyncGitGuardAfterRetire({
				runtime,
				cacheManager,
				cwd,
				filePath: retired.filePath,
				owner: retired.owner,
				lensGuardEnabled: true,
				inCheckout: inScope,
			});
		}
	} catch (failure) {
		incrementDegradationCount({
			kind: "deferred-blocker-gate-error",
			subject: "commit_gate",
			reason: failure instanceof Error ? failure.message : String(failure),
		});
	}
	const held = runtime.gitGuardStatus(inScope);
	if (held.hasBlockers) {
		logDecision(cwd, "blocked", "runtime_blockers", {
			projectSeq: runtime.projectSeq,
			// #4941: whether the refusal is this tree's blockers or, for a command
			// the scope does not read, every blocker the process holds.
			scoped: scope !== undefined,
		});
		const detail = held.summary ? `\n${held.summary}` : "";
		return {
			block: true,
			reason: `🔴 COMMIT BLOCKED (--lens-guard): unresolved blockers must be fixed before commit/push.${detail}\n${inspectLine}`,
		};
	}
	// #3248 round 2 (GG-3283-01): the latch above is a MEMO of the last policy
	// pass, and a pass can only speak for the bytes it read. A verdict whose file
	// has moved since is no answer at all, so it must not be the reason this
	// commit is allowed.
	const expired = firstExpiredSuppressionVerdict(runtime, inScope);
	if (expired) {
		return unknown(cwd, "inline_policy_stale", {
			file: expired.filePath,
			tier: expired.tier,
		});
	}
	const inspection = cacheManager.inspectCache("turn-end-findings", cwd);
	// #4725: the record is read whatever its age, so the refusal can name what
	// clears it and a no-blocker claim never refuses for being old.
	const stored =
		inspection === "missing" ? undefined : storedRecord(cacheManager, cwd);
	const recordRemedy = () =>
		unconfirmedRecordRemedy(stored, inspection, me, cwd) ?? RECHECK_REMEDY;
	// #4941: a reason latched about another tree's stored record is not this
	// commit's; any form scoping does not read still refuses on every reason.
	const latched = runtime.gitGuardCacheUnknownFor(latchInScope);
	if (latched) return unknown(cwd, latched, {}, recordRemedy());
	// #4733 r2 F12: a dispatch that never answered refuses until that file's own
	// dispatch returns, whatever happened to the record since. #4733 r3 F16: a
	// latch whose file is gone has no dispatch left to answer it, so it is
	// skipped, as a record's deleted affected file is (`liveFiles`); it is kept,
	// so bytes back at that path are gated again.
	const unanswered = runtime.gitGuardUnansweredDispatches.find(
		(entry) =>
			(!inScope || inScope(entry.filePath)) &&
			currentFileFingerprint(resolveGuardPath(entry.filePath, cwd)) !==
				"missing",
	);
	if (unanswered) {
		const shown = shownLatchFile(unanswered.filePath, cwd);
		return unknown(
			cwd,
			unanswered.reason,
			// #4733 r3 F18: one row per file, told apart.
			{ file: shown },
			`pi-lens could not check ${shown}. Write it again so pi-lens re-checks it, then retry.`,
		);
	}

	if (inspection === "missing") {
		logDecision(cwd, "allowed", "no_record");
		return { block: false };
	}
	// A record that claims no blocker answers for nothing, whatever its age and
	// whichever session wrote it (the fresh path allowed it before any session
	// check, and age adds no evidence to a claim of none).
	if (claimsNoBlocker(stored?.fields)) {
		logDecision(cwd, "allowed", "advisory_only", { inspection });
		return { block: false };
	}
	if (inspection !== "fresh") {
		return unknown(cwd, `cache_${inspection}`, {}, recordRemedy());
	}
	const fields = stored?.fields;
	if (!isTurnEndFindingsCache(fields)) {
		return unknown(cwd, "cache_malformed", {}, recordRemedy());
	}
	const record = fields;
	// Only a contradiction is left here (`hasBlockers: false` beside test
	// failures or blocker text); no writer produces one, so it is not admitted.
	if (!record.hasBlockers) return unknown(cwd, "cache_malformed");
	if (record.affectedFilesTruncated) {
		return unknown(cwd, "affected_files_truncated");
	}
	// #4738: the record speaks for every session that owns a section of it, so
	// this session judges it alone only when it is the only owner.
	if (record.sessionId !== me || record.carriedBlockers !== undefined) {
		return unknown(cwd, "session_mismatch", {}, recordRemedy());
	}
	if (record.projectSeqEnd !== runtime.projectSeq) {
		return unknown(cwd, "project_sequence_mismatch", {
			recordedProjectSeq: record.projectSeqEnd,
			currentProjectSeq: runtime.projectSeq,
		});
	}
	const liveFiles: string[] = [];
	for (const file of record.affectedFiles) {
		const resolved = resolveGuardPath(file, cwd);
		const key = guardPathKey(resolved, cwd);
		const recordedSeq = record.fileSeqByPath[key];
		if (
			recordedSeq === undefined ||
			recordedSeq !== (runtime.getFileSeq?.(resolved) ?? 0)
		) {
			return unknown(cwd, "file_sequence_mismatch", { file: resolved });
		}
		try {
			if (
				!isPathIgnoredByProject(resolved, runtime.projectRoot || cwd, false)
			) {
				const currentHash = currentFileFingerprint(resolved);
				if (currentHash !== "missing") {
					liveFiles.push(resolved);
					const expectedHash = record.fileContentHashes[key];
					if (
						!expectedHash ||
						expectedHash.startsWith("unreadable:") ||
						currentHash.startsWith("unreadable:") ||
						expectedHash !== currentHash
					) {
						return unknown(cwd, "file_content_changed", { file: resolved });
					}
				}
			}
		} catch {
			return unknown(cwd, "file_unreadable", { file: resolved });
		}
	}
	if (record.hasBlockers && record.affectedFiles.length === 0) {
		return unknown(cwd, "blocker_without_affected_file");
	}
	// A deleted/ignored affected file has been resolved; no stale blocker is
	// allowed to survive solely because its old path remains in the record.
	if (
		record.hasBlockers &&
		liveFiles.length === 0 &&
		record.affectedFiles.length > 0
	) {
		logDecision(cwd, "allowed", "affected_files_resolved", {
			projectSeq: record.projectSeqEnd,
		});
		return { block: false };
	}
	logDecision(cwd, "blocked", "cache_blockers", {
		projectSeq: record.projectSeqEnd,
		affectedFileCount: record.affectedFiles.length,
	});
	return {
		block: true,
		reason: `🔴 COMMIT BLOCKED (--lens-guard): unresolved blockers must be fixed before commit/push.\n${inspectLine}`,
	};
}
