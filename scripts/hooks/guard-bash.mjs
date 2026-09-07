#!/usr/bin/env node
/**
 * scripts/hooks/guard-bash.mjs (#2699, refs umbrella #2697)
 *
 * PreToolUse hook for the Bash tool. Mechanically enforces four
 * non-negotiables that previously lived only as prose in CLAUDE.md and the
 * fixer/reviewer playbooks -- a fixer ran `git stash` on 2026-09-07 (the
 * #2686 lane) and two review probes wrote into the real `~/.pi-lens` on
 * 2026-09-02 (#2506), both rules a hook can catch that prose could not:
 *
 *   - `git stash` in any form (CLAUDE.md non-negotiable)
 *   - `git reset --soft origin/<branch>` / `git reset --hard <anything>`
 *   - `git worktree remove` with two force flags
 *   - an unpinned `node` probe against built runtime code (clients/ or
 *     dist/) with no PI_LENS_HOME pin (AGENTS.md "Probe hygiene")
 *
 * ## Contract source
 *
 * Fetched https://code.claude.com/docs/en/hooks (docs.anthropic.com/en/docs/
 * claude-code/hooks 301-redirects there) on 2026-09-07. A PreToolUse hook
 * receives this on stdin:
 *   { session_id, transcript_path, cwd, permission_mode, hook_event_name,
 *     tool_name, tool_input, tool_use_id, ... }
 * For the Bash tool, `tool_input = { command: string, ... }`. A hook denies
 * the call in one of two ways: (a) exit code 2 with the reason written to
 * stderr, or (b) exit 0 and print
 * `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":
 * "deny","permissionDecisionReason":"..."}}` to stdout. This script uses
 * (a) -- the issue's own wording ("exit 2 with a one-line teaching message")
 * names it, and it is the simpler of the two to test (one exit code, one
 * stream, no JSON-shape drift risk on stdout).
 *
 * ## Tokenizer scope (accepted blind spots)
 *
 * A small hand-rolled tokenizer, not a general shell parser.
 * `clients/bash-file-access.ts`'s `tokenizeShellCommand` (the "shared shell
 * tokenizer" AGENTS.md's git-guard section names) was considered and
 * rejected: it never splits `$( … )`/backtick subshells into their own
 * segments (this hook needs that to catch `echo $(git stash)`), it does not
 * strip leading env assignments, and its import graph pulls in
 * read-guard/mutating-tool/partial-edit-apply machinery built for the
 * extension's own in-process tool-call interception -- disproportionate
 * weight, and the wrong bounded context, for a <50ms external hook process
 * that shares no runtime with that code.
 *
 * Handled: `&&`, `||`, `;`, `|`, newlines as top-level split points;
 * single/double-quoted spans as opaque words (so quoted text is never
 * mistaken for a command -- `echo "git stash"` reads as one `echo` word and
 * one opaque argument word); `$( … )` and backtick spans, recursively
 * re-tokenized as their own commands (so `echo $(git stash)` is still
 * caught); leading `FOO=bar` env assignments, stripped from the command-word
 * search but remembered for the PI_LENS_HOME probe rule.
 *
 * NOT handled (accepted, not exercised green by the test suite): heredocs
 * (`<<EOF`), `eval "…"`, `bash -c "…"` / `sh -c "…"` (the nested string is
 * opaque to this tokenizer, so a denied command hidden behind `bash -c` is
 * not caught), bare `( … )` command grouping, and general backslash
 * escaping outside quotes (quote handling covers `\"` inside double quotes
 * only, since no deny/allow string in #2699 needs more).
 *
 * Never throws: any stdin/JSON/classification failure degrades to "allow"
 * (exit 0) rather than blocking every Bash call in the session -- a crashed
 * hook must never be the thing that blocks the tool.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** @typedef {"stash"|"reset"|"worktreeForce"|"probe"} DenyRule */

/** @type {Record<DenyRule, string>} */
export const RULE_MESSAGES = {
	stash:
		"git stash is forbidden (CLAUDE.md non-negotiable) -- it is repo-global across worktrees; use `git diff > fix.patch` / `git checkout --` / `git apply` instead.",
	reset:
		"`git reset --soft origin/<branch>` / `git reset --hard` is forbidden (fixer playbook rule) -- use `git checkout HEAD -- <path>` to discard a single file instead.",
	worktreeForce:
		"`git worktree remove` with two force flags is forbidden (fixer playbook rule) -- use `git worktree unlock` then a single-force remove.",
	probe:
		"an unpinned node probe against built runtime code (clients/ or dist/) is forbidden (AGENTS.md Probe hygiene) -- prefix `PI_LENS_HOME=<worktree>/.probe-home`.",
};

/**
 * Read a `$( … )` body starting just after the opening "$(". Honors nested
 * parens and quotes so a nested `$(…)` or a quoted `)` does not close the
 * span early. Runs to end-of-text (never throws) if unterminated.
 *
 * @param {string} text
 * @param {number} start index just after "$("
 * @returns {{ body: string; end: number }} end is just past the matching ")"
 */
function readParenSpan(text, start) {
	let depth = 1;
	let i = start;
	/** @type {"single"|"double"|null} */
	let quote = null;
	while (i < text.length && depth > 0) {
		const ch = text[i];
		if (quote === "single") {
			if (ch === "'") quote = null;
		} else if (quote === "double") {
			if (ch === "\\") {
				i += 2;
				continue;
			}
			if (ch === '"') quote = null;
		} else {
			if (ch === "'") quote = "single";
			else if (ch === '"') quote = "double";
			else if (ch === "(") depth++;
			else if (ch === ")") depth--;
		}
		i++;
	}
	return { body: text.slice(start, Math.max(start, i - 1)), end: i };
}

/**
 * Read a backtick-command-substitution body starting just after the opening
 * backtick. Runs to end-of-text (never throws) if unterminated.
 *
 * @param {string} text
 * @param {number} start index just after the opening backtick
 * @returns {{ body: string; end: number }} end is just past the closing backtick
 */
function readBacktickSpan(text, start) {
	let i = start;
	while (i < text.length && text[i] !== "`") {
		if (text[i] === "\\") i++;
		i++;
	}
	return { body: text.slice(start, i), end: Math.min(text.length, i + 1) };
}

/**
 * Split `text` into top-level simple-command segments (split on `&&`,
 * `||`, `;`, `|`, newline outside quotes) plus every `$( … )` / backtick
 * subshell body found anywhere in `text`, for the caller to recursively
 * re-scan. Single quotes suppress everything, including subshell expansion
 * (matching bash); double quotes suppress operator-splitting but still let
 * `$()`/backticks expand inside them.
 *
 * @param {string} text
 * @returns {{ segments: string[]; subshells: string[] }}
 */
export function splitTopLevel(text) {
	/** @type {string[]} */
	const segments = [];
	/** @type {string[]} */
	const subshells = [];
	let buf = "";
	/** @type {"single"|"double"|null} */
	let quote = null;
	let i = 0;
	const push = () => {
		if (buf.trim()) segments.push(buf);
		buf = "";
	};
	while (i < text.length) {
		const ch = text[i];
		if (quote === "single") {
			buf += ch;
			if (ch === "'") quote = null;
			i++;
			continue;
		}
		if (quote === "double") {
			if (ch === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) {
				buf += ch + text[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') {
				quote = null;
				buf += ch;
				i++;
				continue;
			}
			if (ch === "$" && text[i + 1] === "(") {
				const { body, end } = readParenSpan(text, i + 2);
				subshells.push(body);
				buf += text.slice(i, end);
				i = end;
				continue;
			}
			if (ch === "`") {
				const { body, end } = readBacktickSpan(text, i + 1);
				subshells.push(body);
				buf += text.slice(i, end);
				i = end;
				continue;
			}
			buf += ch;
			i++;
			continue;
		}
		// not in a quote
		if (ch === "'") {
			quote = "single";
			buf += ch;
			i++;
			continue;
		}
		if (ch === '"') {
			quote = "double";
			buf += ch;
			i++;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			const { body, end } = readParenSpan(text, i + 2);
			subshells.push(body);
			buf += text.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "`") {
			const { body, end } = readBacktickSpan(text, i + 1);
			subshells.push(body);
			buf += text.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "&" && text[i + 1] === "&") {
			push();
			i += 2;
			continue;
		}
		if (ch === "|" && text[i + 1] === "|") {
			push();
			i += 2;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "\n") {
			push();
			i += 1;
			continue;
		}
		buf += ch;
		i++;
	}
	push();
	return { segments, subshells };
}

/**
 * Split one top-level segment into words: whitespace-separated outside
 * quotes. A quoted span (single or double) fuses into the surrounding word
 * rather than splitting on internal whitespace, and its quote characters
 * are stripped -- so `echo "git stash"` yields the two words `echo` and
 * `git stash` (one opaque word), never four. A `$( … )`/backtick span is
 * kept as raw text inside its enclosing word (its content is scanned
 * separately, via {@link splitTopLevel}'s `subshells` over the original
 * text).
 *
 * @param {string} segment
 * @returns {string[]}
 */
export function splitWords(segment) {
	/** @type {string[]} */
	const words = [];
	let buf = "";
	/** @type {"single"|"double"|null} */
	let quote = null;
	let started = false;
	let i = 0;
	const flush = () => {
		if (started) words.push(buf);
		buf = "";
		started = false;
	};
	while (i < segment.length) {
		const ch = segment[i];
		if (quote === "single") {
			started = true;
			if (ch === "'") {
				quote = null;
				i++;
				continue;
			}
			buf += ch;
			i++;
			continue;
		}
		if (quote === "double") {
			started = true;
			if (ch === "\\" && (segment[i + 1] === '"' || segment[i + 1] === "\\")) {
				buf += segment[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') {
				quote = null;
				i++;
				continue;
			}
			buf += ch;
			i++;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			i++;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			started = true;
			i++;
			continue;
		}
		if (ch === '"') {
			quote = "double";
			started = true;
			i++;
			continue;
		}
		if (ch === "$" && segment[i + 1] === "(") {
			started = true;
			const { end } = readParenSpan(segment, i + 2);
			buf += segment.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "`") {
			started = true;
			const { end } = readBacktickSpan(segment, i + 1);
			buf += segment.slice(i, end);
			i = end;
			continue;
		}
		started = true;
		buf += ch;
		i++;
	}
	flush();
	return words;
}

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * Strip leading `FOO=bar` env assignments from a word list, returning the
 * assignments (for the PI_LENS_HOME probe rule) and the remaining
 * command+args words.
 *
 * @param {string[]} words
 * @returns {{ env: Record<string, string>; rest: string[] }}
 */
export function stripEnvAssignments(words) {
	/** @type {Record<string, string>} */
	const env = {};
	let i = 0;
	while (i < words.length) {
		const m = ENV_ASSIGNMENT.exec(words[i]);
		if (!m) break;
		env[m[1]] = m[2];
		i++;
	}
	return { env, rest: words.slice(i) };
}

/**
 * Classify a `git` invocation's args (after the leading "git" word).
 * Walks past global options (only `-C <dir>` is treated as taking a
 * separate value; every other `-x`/`--x` global option is assumed to take
 * none, which is all #2699's deny/allow strings need) to find the
 * subcommand.
 *
 * @param {string[]} args
 * @returns {DenyRule | null}
 */
function classifyGit(args) {
	let i = 0;
	while (i < args.length) {
		if (args[i] === "-C") {
			i += 2;
			continue;
		}
		if (args[i].startsWith("-")) {
			i += 1;
			continue;
		}
		break;
	}
	const subcommand = args[i];
	if (subcommand === "stash") return "stash";
	if (subcommand === "reset") {
		const rest = args.slice(i + 1);
		if (rest.includes("--hard")) return "reset";
		if (rest.includes("--soft") && rest.some((a) => a.startsWith("origin/")))
			return "reset";
		return null;
	}
	if (subcommand === "worktree" && args[i + 1] === "remove") {
		const rest = args.slice(i + 2);
		let forceCount = 0;
		for (const a of rest) {
			if (a === "-f" || a === "--force") forceCount++;
			else if (/^-f{2,}$/.test(a)) forceCount += a.length - 1;
		}
		if (forceCount >= 2) return "worktreeForce";
		return null;
	}
	return null;
}

/**
 * Classify a `node`/`nodejs` invocation's args. Denies only when ALL hold
 * (the #2699 probe rule): the command runs `-e`/`--eval`/`--input-type`/
 * `-p`, or a `.mjs`/`.js` file argument not under `scripts/`; the raw
 * segment text references `clients/` or `dist/`; and neither this
 * command's own env assignments nor `process.env` carries `PI_LENS_HOME`.
 *
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {string} rawSegment
 * @returns {DenyRule | null}
 */
function classifyNode(args, env, rawSegment) {
	const hasFlag = args.some(
		(a) =>
			a === "-e" ||
			a === "--eval" ||
			a === "-p" ||
			a === "--input-type" ||
			a.startsWith("--input-type="),
	);
	const hasFileArg = args.some(
		(a) =>
			!a.startsWith("-") && /\.(?:mjs|js)$/.test(a) && !a.startsWith("scripts/"),
	);
	if (!hasFlag && !hasFileArg) return null;
	if (!rawSegment.includes("clients/") && !rawSegment.includes("dist/"))
		return null;
	if ("PI_LENS_HOME" in env) return null;
	if ("PI_LENS_HOME" in process.env) return null;
	return "probe";
}

/**
 * Classify one raw top-level segment (its own env-assignment prefix already
 * part of `rawSegment`).
 *
 * @param {string} rawSegment
 * @returns {DenyRule | null}
 */
export function classifySegment(rawSegment) {
	const words = splitWords(rawSegment);
	if (words.length === 0) return null;
	const { env, rest } = stripEnvAssignments(words);
	if (rest.length === 0) return null;
	const cmd = rest[0];
	const args = rest.slice(1);
	if (cmd === "git") return classifyGit(args);
	if (cmd === "node" || cmd === "nodejs") return classifyNode(args, env, rawSegment);
	return null;
}

/**
 * Scan a full Bash command (top-level segments AND every `$()`/backtick
 * subshell body, recursively) for the first denied rule. Depth-bounded so a
 * pathologically nested subshell degrades to "no match found" rather than
 * recursing without limit -- consistent with "never throw / never hang".
 *
 * @param {string} commandText
 * @param {number} [depth]
 * @returns {DenyRule | null}
 */
export function findDeny(commandText, depth = 0) {
	if (depth > 8) return null;
	const { segments, subshells } = splitTopLevel(commandText);
	for (const seg of segments) {
		const rule = classifySegment(seg);
		if (rule) return rule;
	}
	for (const sub of subshells) {
		const rule = findDeny(sub, depth + 1);
		if (rule) return rule;
	}
	return null;
}

/**
 * Run the guard over the PreToolUse payload. Pure (besides the
 * `PI_LENS_HOME` env read already folded into {@link classifyNode}) --
 * takes the parsed payload, returns the rule to deny for (or null to
 * allow). Exported so tests can drive it without spawning a child process
 * when they only care about classification, not the stdin/exit-code
 * plumbing.
 *
 * @param {unknown} payload
 * @returns {DenyRule | null}
 */
export function classifyPayload(payload) {
	if (!payload || typeof payload !== "object") return null;
	const p = /** @type {{ tool_name?: unknown; tool_input?: unknown }} */ (
		payload
	);
	if (p.tool_name !== "Bash") return null;
	const toolInput = p.tool_input;
	if (!toolInput || typeof toolInput !== "object") return null;
	const command = /** @type {{ command?: unknown }} */ (toolInput).command;
	if (typeof command !== "string" || !command.trim()) return null;
	return findDeny(command);
}

/**
 * Read stdin synchronously. Never blocks on an interactive terminal and
 * never throws -- any read failure is "no payload", which {@link run}
 * treats as allow.
 *
 * @returns {string}
 */
function readStdin() {
	if (process.stdin.isTTY) return "";
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

/**
 * @returns {number} process exit code -- 0 to allow, 2 to deny.
 */
export function run() {
	try {
		const raw = readStdin();
		if (!raw.trim()) return 0;
		/** @type {unknown} */
		let payload;
		try {
			payload = JSON.parse(raw);
		} catch {
			return 0;
		}
		const rule = classifyPayload(payload);
		if (!rule) return 0;
		process.stderr.write(`${RULE_MESSAGES[rule]}\n`);
		return 2;
	} catch {
		// A crash in this hook must never be the thing that blocks the tool.
		return 0;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = run();
}
