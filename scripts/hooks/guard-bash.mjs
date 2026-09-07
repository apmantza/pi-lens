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
 *   - a HAND-typed `git worktree remove` with two force flags (the
 *     sanctioned removal is `node scripts/prune-agent-worktrees.mjs`,
 *     liveness-checked, or unlock + single force)
 *   - an unpinned `node` probe that LOADS built runtime code from clients/
 *     or dist/ (not merely a payload that mentions "clients/" in passing --
 *     review round 2 F5) with no PI_LENS_HOME pin (AGENTS.md "Probe
 *     hygiene")
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
 * Handled: `&&`, `||`, `;`, `|`, `&`, newlines as top-level split points;
 * single/double-quoted spans as opaque words (so quoted text is never
 * mistaken for a command -- `echo "git stash"` reads as one `echo` word and
 * one opaque argument word); `$( … )` and backtick spans, recursively
 * re-tokenized as their own commands (so `echo $(git stash)` is still
 * caught) UNLESS the span is inside a heredoc body (see below); `<<`/`<<-`
 * heredocs, whose body is consumed verbatim and dropped -- never split into
 * segments, never scanned for `$()`/backticks (review round 2 F1: a
 * markdown inline-code span or a command name inside a PR body / issue
 * comment / file written through `cat <<'EOF' … EOF` is not a live command,
 * and 18% of one day's real transcript carried a heredoc); a backslash-
 * newline line continuation (`git \`, next line `stash`, is one segment);
 * a leading `{` command-group brace and `command`/`exec`/`env` runner
 * prefixes, stripped before the command word is identified (round 2 F7);
 * `export VAR=val` (or a standalone `VAR=val` with no command in that
 * segment) persisted forward to LATER `;`/newline-separated segments in the
 * same scan, not just this segment's own prefix or `process.env` (round 2
 * F2 -- AGENTS.md's own sanctioned `export PI_LENS_HOME=<dir>` form); a
 * command word resolved by its final path segment, so `/usr/bin/git`,
 * `./git`, and `git` are the same command (round 2 F7); leading `FOO=bar`
 * env assignments and `-c <key>=<value>` / `-C <dir>` git global options,
 * skipped when finding the command word / subcommand.
 *
 * NOT handled (accepted, not exercised green by the test suite): `eval
 * "…"`, `bash -c "…"` / `sh -c "…"` / `xargs git stash` (the nested string
 * or spawned argv is opaque to this tokenizer, so a denied command hidden
 * behind any of these is not caught), bare `( … )` command grouping (only
 * `{ … }` is stripped), a heredoc nested inside a `$()`/backtick span whose
 * body itself contains an unbalanced `(`/`)`/backtick (the span-matching
 * paren/backtick scan is not heredoc-aware, so a stray one inside such a
 * body can close the span early -- none of #2699's own reviewed cases hit
 * this), and general backslash escaping outside quotes beyond the
 * heredoc/newline continuation above (quote handling covers `\"` inside
 * double quotes only).
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
		"a HAND-typed `git worktree remove` with two force flags is forbidden (fixer playbook rule) -- use `node scripts/prune-agent-worktrees.mjs` (liveness-checked; it applies the same double force internally once a tree is confirmed dead) for a stuck worktree, or `git worktree unlock` then a single-force remove.",
	probe:
		"an unpinned node probe that LOADS runtime code from clients/ or dist/ is forbidden (AGENTS.md Probe hygiene) -- prefix `PI_LENS_HOME=<worktree>/.probe-home`.",
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
 * Parse a `<<`/`<<-` heredoc operator's delimiter, starting just after the
 * two `<` characters. Handles a quoted delimiter (`'EOF'`/`"EOF"`, dequoted
 * for matching) and a bareword one, plus a leading `-` (`<<-`, which strips
 * leading tabs from body lines before matching the delimiter). An empty
 * delimiter (malformed `<<`) is reported as `null` so the caller treats the
 * `<<` as ordinary text instead of starting a heredoc.
 *
 * @param {string} text
 * @param {number} start index just after "<<"
 * @returns {{ delimiter: string | null; stripTabs: boolean; end: number }}
 */
function parseHeredocMarker(text, start) {
	let i = start;
	let stripTabs = false;
	if (text[i] === "-") {
		stripTabs = true;
		i++;
	}
	while (text[i] === " " || text[i] === "\t") i++;
	let delimiter = "";
	if (text[i] === "'" || text[i] === '"') {
		const q = text[i];
		i++;
		while (i < text.length && text[i] !== q) {
			delimiter += text[i];
			i++;
		}
		if (text[i] === q) i++;
	} else {
		while (i < text.length && !/[\s;&|<>]/.test(text[i])) {
			if (text[i] === "\\" && i + 1 < text.length) {
				delimiter += text[i + 1];
				i += 2;
				continue;
			}
			delimiter += text[i];
			i++;
		}
	}
	return { delimiter: delimiter || null, stripTabs, end: i };
}

/**
 * Consume a heredoc body starting at `start` (just after the newline that
 * triggered it), reading whole lines verbatim -- never tokenized, never
 * scanned for `$()`/backticks -- until a line that equals `delimiter`
 * (leading tabs stripped first when `stripTabs`). Runs to end-of-text
 * (never throws) if the delimiter is never found.
 *
 * @param {string} text
 * @param {number} start
 * @param {string} delimiter
 * @param {boolean} stripTabs
 * @returns {number} index just past the delimiter line's newline (or EOF)
 */
function consumeHeredocBody(text, start, delimiter, stripTabs) {
	let i = start;
	while (i <= text.length) {
		const nl = text.indexOf("\n", i);
		const lineEnd = nl === -1 ? text.length : nl;
		const line = text.slice(i, lineEnd);
		const compareLine = stripTabs ? line.replace(/^\t+/, "") : line;
		if (compareLine === delimiter) return nl === -1 ? lineEnd : lineEnd + 1;
		if (nl === -1) return text.length;
		i = lineEnd + 1;
	}
	return text.length;
}

/**
 * Split `text` into top-level simple-command segments (split on `&&`,
 * `||`, `;`, `|`, `&`, newline outside quotes) plus every `$( … )` /
 * backtick subshell body found OUTSIDE any heredoc body, for the caller to
 * recursively re-scan. Single quotes suppress everything, including
 * subshell expansion (matching bash); double quotes suppress
 * operator-splitting but still let `$()`/backticks expand inside them.
 *
 * A `<<`/`<<-` heredoc's body (the lines up to and including its delimiter
 * line) is consumed verbatim and DROPPED -- never split into segments,
 * never scanned for `$()`/backticks -- so a markdown inline-code span or a
 * mention of a forbidden command inside a heredoc (a PR body, an issue
 * comment, a file written via `cat <<'EOF'`) is never mistaken for a live
 * command (#2699 review round 2 F1). A real command placed on the line
 * AFTER a heredoc's closing delimiter is a genuinely new, separately
 * scanned segment.
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
	/** Heredoc markers seen since the last line-triggered consumption, consumed in order at the next top-level newline. */
	/** @type {Array<{ delimiter: string; stripTabs: boolean }>} */
	let pendingHeredocs = [];
	const push = () => {
		if (buf.trim()) segments.push(buf);
		buf = "";
	};
	while (i < text.length) {
		const ch = text[i];
		if (quote === null && ch === "\\" && text[i + 1] === "\n") {
			// Line continuation: the backslash-newline pair is removed, and the
			// next physical line joins this one -- never a segment split.
			i += 2;
			continue;
		}
		if (
			quote === null &&
			ch === "<" &&
			text[i + 1] === "<" &&
			text[i + 2] !== "<"
		) {
			const marker = parseHeredocMarker(text, i + 2);
			if (marker.delimiter !== null) {
				pendingHeredocs.push({
					delimiter: marker.delimiter,
					stripTabs: marker.stripTabs,
				});
				buf += text.slice(i, marker.end);
				i = marker.end;
				continue;
			}
		}
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
		if (ch === "\n" && pendingHeredocs.length > 0) {
			push();
			let pos = i + 1;
			for (const hd of pendingHeredocs) {
				pos = consumeHeredocBody(text, pos, hd.delimiter, hd.stripTabs);
			}
			pendingHeredocs = [];
			i = pos;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
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

/** Global git flags that consume a SEPARATE following token as their value. */
const GIT_TWO_TOKEN_FLAGS = new Set(["-C", "-c"]);

/**
 * Classify a `git` invocation's args (after the leading "git" word).
 * Walks past global options (`-C <dir>` and `-c <key>=<value>` are treated
 * as taking a separate value; every other `-x`/`--x` global option is
 * assumed to take none, which is all #2699's deny/allow strings need) to
 * find the subcommand.
 *
 * @param {string[]} args
 * @returns {DenyRule | null}
 */
function classifyGit(args) {
	let i = 0;
	while (i < args.length) {
		if (GIT_TWO_TOKEN_FLAGS.has(args[i])) {
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
 * Does `fileArg` name a file under a top-level `dirName` directory --
 * checked by exact PATH-SEGMENT membership, never a substring test (a
 * substring test on the whole command TEXT is exactly the #2699 review
 * round 2 F5 false-positive: a `node -e` payload that merely MENTIONS
 * "clients/" in an unrelated string still substring-matched). Segment
 * membership is naturally robust to a leading `./`, a `.\`-style Windows
 * separator, and an absolute path -- `"./clients/x.mjs"`,
 * `"/abs/worktree/clients/x.mjs"`, and `"clients/x.mjs"` all split into a
 * `"clients"` segment, so no separate normalization step (strip `./`,
 * resolve against `cwd`) is needed the way a `startsWith("clients/")`
 * prefix check would have required. Accepted imprecision: a file legitimately
 * under some OTHER project's `clients/`/`dist/` directory (e.g.
 * `vendor/other-repo/dist/x.mjs`) also matches -- proportionate to a
 * heuristic guard, and no narrower check can tell the two apart from argv
 * text alone.
 *
 * @param {string} fileArg
 * @param {string} dirName
 * @returns {boolean}
 */
function fileArgUnderDir(fileArg, dirName) {
	return fileArg.split(/[\\/]+/).includes(dirName);
}

/**
 * A `require(`/`import(` call, or a bare `from`, whose string-literal
 * specifier mentions a `clients/` or `dist/` path segment -- the shape of
 * an `-e`/`-p` payload that actually LOADS runtime code, as opposed to one
 * that merely mentions "clients/" in an unrelated string (#2699 review
 * round 2 F5: the orchestrator's `node -e` doc-patching idiom prints or
 * greps text that can incidentally contain "clients/" without ever loading
 * it). Accepted blind spot: a specifier built from a variable
 * (`require(mod)`) is invisible to a text pattern -- documented, not fixed,
 * since no static text scan can resolve a runtime-computed specifier.
 */
const RUNTIME_LOAD_PATTERN =
	/\b(?:require|import)\s*\(\s*["'`][^"'`]*(?:clients|dist)\/[^"'`]*["'`]|\bfrom\s+["'`][^"'`]*(?:clients|dist)\/[^"'`]*["'`]/;

/**
 * Classify a `node`/`nodejs` invocation's args. Denies only when ALL hold
 * (the #2699 probe rule, narrowed in review round 2 F5): the command runs a
 * `.mjs`/`.js` file argument that is ITSELF under `clients/`/`dist/`, or an
 * `-e`/`--eval`/`--input-type`/`-p` payload whose text actually LOADS
 * runtime code from `clients/`/`dist/` (a `require(`/`import(`/`from`
 * specifier naming it, per {@link RUNTIME_LOAD_PATTERN}) -- not merely a
 * payload that mentions "clients/" in passing; and neither this command's
 * own env assignments nor `process.env` carries `PI_LENS_HOME`.
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
	const fileArg = args.find(
		(a) => !a.startsWith("-") && /\.(?:mjs|js)$/.test(a),
	);
	const fileArgLoadsRuntimeCode =
		fileArg !== undefined &&
		(fileArgUnderDir(fileArg, "clients") || fileArgUnderDir(fileArg, "dist"));
	const evalPayloadLoadsRuntimeCode =
		hasFlag && RUNTIME_LOAD_PATTERN.test(rawSegment);
	if (!fileArgLoadsRuntimeCode && !evalPayloadLoadsRuntimeCode) return null;
	if ("PI_LENS_HOME" in env) return null;
	if ("PI_LENS_HOME" in process.env) return null;
	return "probe";
}

/** Bash builtins that just mean "run the following command" -- stripped before the command word is identified (#2699 review round 2 F7). */
const RUNNER_PREFIX_WORDS = new Set(["command", "exec", "env"]);

/**
 * Strip a leading `{` command-group brace and any leading `command`/`exec`/
 * `env` runner-prefix words (repeated, so `command env git stash` and
 * `{ command git stash` both resolve to `git stash`) before the command
 * word is identified. `env`'s own `FOO=bar` assignments (if any) still
 * parse correctly afterward via {@link stripEnvAssignments} once `env`
 * itself is dropped.
 *
 * @param {string[]} words
 * @returns {string[]}
 */
function stripCommandGroupAndRunnerPrefixes(words) {
	let i = 0;
	if (words[i] === "{") i++;
	while (i < words.length && RUNNER_PREFIX_WORDS.has(words[i])) i++;
	return words.slice(i);
}

/**
 * The final path segment of a command word -- so `/usr/bin/git`, `./git`,
 * and `git` all resolve to the same command name (#2699 review round 2 F7).
 *
 * @param {string} cmd
 * @returns {string}
 */
function commandBasename(cmd) {
	const idx = Math.max(cmd.lastIndexOf("/"), cmd.lastIndexOf("\\"));
	return idx === -1 ? cmd : cmd.slice(idx + 1);
}

/**
 * Classify one raw top-level segment. `sharedEnv` carries `export VAR=val`
 * (or a standalone `VAR=val` with no command on the same segment)
 * assignments forward to LATER segments in the same {@link findDeny} scan
 * (#2699 review round 2 F2: AGENTS.md sanctions `export
 * PI_LENS_HOME=<worktree>/.probe-home` as an earlier `;`/newline-separated
 * segment, not only as this segment's own prefix or `process.env`). The
 * `export` builtin NEVER runs a trailing command in real bash -- any word
 * after its assignments is another (bare) name marked for export, not a
 * command -- so a segment starting with `export` always terminates here,
 * persisting into `sharedEnv` (mutated in place) and returning `null`. A
 * NON-exported `FOO=bar cmd` prefix, by contrast, applies only to THIS
 * segment's own command (matching real bash), merged into the
 * `effectiveEnv` passed to {@link classifyNode}.
 *
 * @param {string} rawSegment
 * @param {Record<string, string>} sharedEnv
 * @returns {DenyRule | null}
 */
export function classifySegment(rawSegment, sharedEnv = {}) {
	const rawWords = splitWords(rawSegment);
	if (rawWords.length === 0) return null;
	const words = stripCommandGroupAndRunnerPrefixes(rawWords);
	if (words.length === 0) return null;
	if (words[0] === "export") {
		const { env: exported } = stripEnvAssignments(words.slice(1));
		Object.assign(sharedEnv, exported);
		return null;
	}
	const { env: segmentEnv, rest } = stripEnvAssignments(words);
	if (rest.length === 0) {
		// A standalone (non-exported) `VAR=val` with no command -- lenient:
		// persist it too (real bash would keep it a local shell variable, not
		// exported, but there is no command in this segment for the
		// distinction to matter either way).
		Object.assign(sharedEnv, segmentEnv);
		return null;
	}
	const effectiveEnv = { ...sharedEnv, ...segmentEnv };
	const cmd = commandBasename(rest[0]);
	const args = rest.slice(1);
	if (cmd === "git") return classifyGit(args);
	if (cmd === "node" || cmd === "nodejs")
		return classifyNode(args, effectiveEnv, rawSegment);
	return null;
}

/**
 * Scan a full Bash command (top-level segments AND every `$()`/backtick
 * subshell body, recursively) for the first denied rule. Depth-bounded so a
 * pathologically nested subshell degrades to "no match found" rather than
 * recursing without limit -- consistent with "never throw / never hang".
 * `inheritedEnv` seeds this scan's shared `export`ed-assignment state (see
 * {@link classifySegment}); each subshell recurses starting from the
 * accumulated state after ALL of this scan's own top-level segments ran --
 * an approximation of bash's left-to-right export visibility, not a
 * fully-ordered interleaving with what appears textually inside a
 * `$()`/backtick span (#2699 review round 2 F2).
 *
 * @param {string} commandText
 * @param {number} [depth]
 * @param {Record<string, string>} [inheritedEnv]
 * @returns {DenyRule | null}
 */
export function findDeny(commandText, depth = 0, inheritedEnv = {}) {
	if (depth > 8) return null;
	const { segments, subshells } = splitTopLevel(commandText);
	const sharedEnv = { ...inheritedEnv };
	for (const seg of segments) {
		const rule = classifySegment(seg, sharedEnv);
		if (rule) return rule;
	}
	for (const sub of subshells) {
		const rule = findDeny(sub, depth + 1, sharedEnv);
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
