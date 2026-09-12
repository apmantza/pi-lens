import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { CacheManager } from "./cache-manager.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import { isPathIgnoredByProject } from "./file-utils.js";
import { tokenizeShellCommand } from "./bash-file-access.js";
import { logLatency } from "./latency-logger.js";
import { resolveLensToolName, type LensToolHost } from "./tool-config.js";
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
	blockingFiles?: string[];
	/** Context has consumed the message, but the guard still owns the state. */
	consumed?: boolean;
	testFailures?: boolean;
	testFailureContent?: string;
	testFailureFiles?: string[];
	blockerContent?: string;
	provenance?: AdvisoryProvenance;
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

/** Recovery is safe only when blocker content and its file provenance agree. */
function hasCompleteBlockingProvenance(
	blockerContent: unknown,
	blockingFiles: unknown,
	cwd: string,
): blockingFiles is string[] {
	if (typeof blockerContent !== "string" || blockerContent.length === 0)
		return false;
	if (!Array.isArray(blockingFiles) || blockingFiles.length === 0) return false;
	if (
		blockingFiles.some(
			(file) => typeof file !== "string" || file.trim().length === 0,
		)
	) {
		return false;
	}
	const provenanceKeys = blockingFiles.map((file) => guardPathKey(file, cwd));
	if (new Set(provenanceKeys).size !== provenanceKeys.length) return false;
	const blockerKeys = blockerContent.split("\n").map((line) => {
		const separator = line.indexOf(": ");
		if (separator <= 0) return undefined;
		const file = line.slice(0, separator).trim();
		return file.length > 0 ? guardPathKey(file, cwd) : undefined;
	});
	if (blockerKeys.some((key) => key === undefined)) return false;
	const uniqueBlockerKeys = new Set(blockerKeys as string[]);
	return (
		uniqueBlockerKeys.size === blockerKeys.length &&
		uniqueBlockerKeys.size === provenanceKeys.length &&
		[...uniqueBlockerKeys].every((key) => provenanceKeys.includes(key))
	);
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
	const normalized = value.replace(/\\/g, "/");
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
	return new Set(["git", "git.exe", "git.cmd", "git.bat"]).has(
		executableName(value),
	);
}

const COMMAND_STRING_WRAPPERS = new Set(["busybox", "toybox", "nix-shell"]);

function isCommandStringWrapper(value: string): boolean {
	return COMMAND_STRING_WRAPPERS.has(executableName(value));
}

/**
 * Canonicalize shell parameter separators before command classification. The
 * quote-aware pass deliberately leaves literal arguments alone; the lexer
 * then supplies the command-position boundaries used by the guard.
 */
function canonicalizeGuardCommand(command: string): string {
	let result = "";
	let quote: "single" | "double" | undefined;
	let escaped = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "single") {
			result += ch;
			if (ch === "'") quote = undefined;
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
	return collapsed.trim();
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
	let escaped = false;
	for (let i = start + opener.length; i < command.length; i++) {
		const ch = command[i];
		if (quote === "single") {
			if (ch === "'") quote = undefined;
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
	let escaped = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "single") {
			if (ch === "'") quote = undefined;
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
				tokenizeShellCommand(nested).some((segment) =>
					containsGuardedGitVerb(segment.tokens, depth + 1, matcher),
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
	for (const segment of tokenizeShellCommand(
		canonicalizeGuardCommand(command),
	)) {
		const gitIndex = segment.tokens.findIndex((token) =>
			isGitExecutable(token),
		);
		if (gitIndex >= 0) invocations.push(segment.tokens.slice(gitIndex));
	}
	return invocations;
}

function containsGuardedGitVerb(
	tokens: string[],
	depth: number,
	matcher: GitVerbMatcher,
): boolean {
	if (depth > 3 || tokens.length === 0) return false;
	let commandTokens = tokens;
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(commandTokens[0] ?? "")) {
		commandTokens = commandTokens.slice(1);
	}
	if (commandTokens.length === 0) return false;
	const expandedHead = expandGuardVerbToken(commandTokens[0] ?? "");
	if (expandedHead.length > 1) {
		commandTokens = [...expandedHead, ...commandTokens.slice(1)];
	}
	if (isCommandStringWrapper(commandTokens[0] ?? "")) {
		const lower = commandTokens.slice(1).map((token) => token.toLowerCase());
		const runIndex = lower.findIndex((token) => token === "--run");
		if (runIndex >= 0 && runIndex + 1 < commandTokens.length) {
			const nestedCommand = commandTokens.slice(runIndex + 2).join(" ");
			return tokenizeShellCommand(canonicalizeGuardCommand(nestedCommand)).some(
				(segment) => containsGuardedGitVerb(segment.tokens, depth + 1, matcher),
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
	const gitIndex = commandTokens.findIndex((token) => isGitExecutable(token));
	if (gitIndex >= 0) {
		// Any non-leading git invocation is indirect. Do not maintain a wrapper
		// or flag allowlist: unknown launchers are the security boundary here.
		if (gitIndex > 0 && matcher.indirectAlwaysMatches) return true;
		// #2007: a guard that protects the agent from its own accident must not
		// decline `xargs git status`, so the indirect path stays armed only when
		// a governed verb sits in git's real COMMAND POSITION. Scanning every
		// token instead would fire on `find . -name checkout | xargs git add`,
		// where `checkout` is a positional value and not a subcommand at all.
		return matchGitVerbAtCommandPosition(
			commandTokens.slice(gitIndex),
			matcher,
		);
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
		const nestedCommand = commandTokens.slice(commandIndex).join(" ");
		return tokenizeShellCommand(canonicalizeGuardCommand(nestedCommand)).some(
			(segment) => containsGuardedGitVerb(segment.tokens, depth + 1, matcher),
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
	const nestedCommand = commandTokens.slice(commandIndex).join(" ");
	return tokenizeShellCommand(canonicalizeGuardCommand(nestedCommand)).some(
		(segment) => containsGuardedGitVerb(segment.tokens, depth + 1, matcher),
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
	return tokenizeShellCommand(canonical).some((segment) =>
		containsGuardedGitVerb(segment.tokens, 0, matcher),
	);
}

/** The #1063 commit gate's own question. */
export function isGitCommitOrPushAttempt(
	toolName: string,
	input: unknown,
): boolean {
	return detectGuardedGitVerb(toolName, input, COMMIT_PUSH_MATCHER);
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
		(record.blockingFiles === undefined || Array.isArray(record.blockingFiles))
	);
}

function cacheRecord(
	cacheManager: CacheManager,
	cwd: string,
): TurnEndFindingsCache | undefined {
	const entry = cacheManager.readCache<unknown>("turn-end-findings", cwd);
	return entry && isTurnEndFindingsCache(entry.data) ? entry.data : undefined;
}

function markCacheUnknown(runtime: RuntimeCoordinator, reason: string): void {
	runtime.markGitGuardCacheUnknown(reason);
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
		runtime.clearGitGuardCacheUnknown();
		return true;
	} catch {
		markCacheUnknown(runtime, "cache_write_failed");
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

function unknown(
	cwd: string,
	reasonCategory: string,
	metadata = {},
): GuardDecision {
	logDecision(cwd, "unknown", reasonCategory, metadata);
	return {
		block: true,
		unknown: true,
		reason: `🔴 COMMIT BLOCKED (--lens-guard): blocker state is unknown (${reasonCategory}). Re-run pi-lens checks or start a fresh session, then retry.`,
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
 * @returns true when an entry was retired (the caller logs it — #1432 Gap 1).
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
	const retired = args.runtime.retireInlineBlockerOnConfirmedClean(
		args.filePath,
		args.writeIndex,
		args.coveredSources,
	);
	if (!retired) return false;
	args.runtime.updateGitGuardStatus(false, "");
	if (args.lensGuardEnabled) {
		syncGitGuardRecord(
			args.runtime,
			args.cacheManager,
			args.cwd,
			args.filePath,
		);
	}
	return true;
}

export function syncGitGuardRecord(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	editedFilePath?: string,
): void {
	const entries = runtime.getInlineBlockersSnapshot?.() ?? [];
	const inspection = cacheManager.inspectCache("turn-end-findings", cwd);
	const existing = cacheRecord(cacheManager, cwd);
	if (
		existing &&
		existing.sessionId !== runtime.telemetrySessionId &&
		entries.length === 0
	) {
		markCacheUnknown(runtime, "session_mismatch");
		return;
	}
	if (!existing && inspection !== "missing" && entries.length === 0) {
		markCacheUnknown(runtime, `cache_${inspection}`);
		return;
	}
	const fileSeqByPath: Record<string, number> = {};
	for (const [filePath, seq] of runtime.getFileSeqEntries?.() ?? []) {
		fileSeqByPath[guardPathKey(filePath, cwd)] = seq;
	}
	const inlineFiles = entries.map((entry) =>
		resolveGuardPath(entry.filePath, cwd),
	);
	const existingBlockingFiles = existing?.blockingFiles ?? [];
	const provenanceComplete = existing?.blockerContent
		? hasCompleteBlockingProvenance(
				existing.blockerContent,
				existingBlockingFiles,
				cwd,
			)
		: true;
	if (existing?.blockerContent && !provenanceComplete) {
		markCacheUnknown(runtime, "blocking_provenance_untrusted");
		return;
	}
	const editedKey = editedFilePath
		? guardPathKey(editedFilePath, cwd)
		: undefined;
	const testFiles = existing?.testFailureFiles ?? [];
	const remainingBlockingFiles =
		editedKey && existingBlockingFiles.length > 0
			? existingBlockingFiles.filter(
					(file) => guardPathKey(file, cwd) !== editedKey,
				)
			: existingBlockingFiles;
	let affectedFiles = [...(existing?.affectedFiles ?? []), ...inlineFiles];
	if (!entries.length && editedKey && existing) {
		const isStillTestFailure = testFiles.some(
			(file) => guardPathKey(file, cwd) === editedKey,
		);
		const isUnknownBlockingPath =
			existingBlockingFiles.length === 0 && !!existing.blockerContent;
		if (!isStillTestFailure && !isUnknownBlockingPath) {
			affectedFiles = affectedFiles.filter(
				(file) => guardPathKey(file, cwd) !== editedKey,
			);
		}
	}
	// A clean per-file dispatch is authoritative for that file. When the
	// persisted record has explicit blocking-file provenance and the last such
	// file just reconciled clean, retaining blockerContent would resurrect a
	// stale blocker on every later git-guard lookup. Records without that
	// provenance remain fail-closed: they cannot be safely cleared here.
	const clearedLastKnownBlocker =
		!entries.length &&
		!!editedKey &&
		provenanceComplete &&
		existingBlockingFiles.length > 0 &&
		remainingBlockingFiles.length === 0;
	const blockerContent =
		entries.length > 0
			? entries.map((entry) => `${entry.filePath}: ${entry.summary}`).join("\n")
			: clearedLastKnownBlocker
				? undefined
				: existing?.blockerContent;
	const hasTestFailures = existing?.testFailures === true;
	const hasBlockers = !!blockerContent || hasTestFailures;
	const content = [
		blockerContent,
		hasTestFailures ? existing?.testFailureContent : undefined,
	]
		.filter((value): value is string => !!value)
		.join("\n\n");
	if (!hasBlockers && !content) {
		cacheManager.clearCache("turn-end-findings", cwd);
		return;
	}
	writeGitGuardRecord(cacheManager, runtime, cwd, {
		content: content || existing?.content || "",
		blockerContent,
		blockingFiles: entries.length > 0 ? inlineFiles : remainingBlockingFiles,
		hasBlockers,
		affectedFiles,
		sessionId: runtime.telemetrySessionId,
		projectSeqStart: runtime.turnStartProjectSeq,
		projectSeqEnd: runtime.projectSeq,
		fileSeqByPath,
		fileContentHashes: {},
		consumed: false,
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
		testFailureContent: content,
		testFailureFiles: testFailureFiles,
		hasBlockers: true,
		affectedFiles: [...(existing?.affectedFiles ?? []), ...failedFiles],
		sessionId: runtime.telemetrySessionId,
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
		return;
	}
	const blockingKeys = new Set(
		(existing.blockingFiles ?? []).map((file) => guardPathKey(file, cwd)),
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
		sessionId: runtime.telemetrySessionId,
		projectSeqStart: runtime.turnStartProjectSeq,
		projectSeqEnd: runtime.projectSeq,
		fileSeqByPath: Object.fromEntries(
			runtime
				.getFileSeqEntries()
				.map(([filePath, seq]) => [guardPathKey(filePath, cwd), seq]),
		),
		fileContentHashes: {},
	});
}

export function evaluateGitGuard(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	host: LensToolHost = "pi",
): GuardDecision {
	if (runtime.gitGuardHasBlockers) {
		logDecision(cwd, "blocked", "runtime_blockers", {
			projectSeq: runtime.projectSeq,
		});
		const detail = runtime.gitGuardSummary
			? `\n${runtime.gitGuardSummary}`
			: "";
		return {
			block: true,
			reason: `🔴 COMMIT BLOCKED (--lens-guard): unresolved blockers must be fixed before commit/push.${detail}\nRun ${resolveLensToolName("lens_diagnostics", host)} mode=all for full details, then commit again.`,
		};
	}
	if (runtime.gitGuardCacheUnknownReason) {
		return unknown(cwd, runtime.gitGuardCacheUnknownReason);
	}

	const inspection = cacheManager.inspectCache("turn-end-findings", cwd);
	if (inspection === "missing") {
		logDecision(cwd, "allowed", "no_record");
		return { block: false };
	}
	if (inspection !== "fresh") return unknown(cwd, `cache_${inspection}`);
	const pending = cacheManager.readCache<unknown>("turn-end-findings", cwd);
	if (!pending || !isTurnEndFindingsCache(pending.data)) {
		return unknown(cwd, "cache_malformed");
	}
	const record = pending.data;
	if (!record.hasBlockers) {
		logDecision(cwd, "allowed", "advisory_only");
		return { block: false };
	}
	if (record.affectedFilesTruncated) {
		return unknown(cwd, "affected_files_truncated");
	}
	if (record.sessionId !== runtime.telemetrySessionId) {
		return unknown(cwd, "session_mismatch");
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
		reason: `🔴 COMMIT BLOCKED (--lens-guard): unresolved blockers must be fixed before commit/push.\nRun ${resolveLensToolName("lens_diagnostics", host)} mode=all for full details, then commit again.`,
	};
}
