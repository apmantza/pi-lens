// flake-shape: real-process-spawn — the oracle is real `bash -c`: whether bash runs `git commit` or `git push` for each spelling of the executable or the verb. A stubbed shell decodes nothing, and the rows exist because the matcher read token text that no shell reads (#4739).
/**
 * #4739: the `--lens-guard` commit gate reads the word bash decodes, run
 * against real bash.
 *
 * Recurrence: `$'git' push origin master` ran unguarded while `git push`,
 * `\git push` and `g""it push` were guarded, because the matcher read the
 * legacy token text (`$git`, with the `$` of the ANSI-C quote still in it).
 * Each hand-written spelling reds a different part of the word model, so the
 * rows are also generated, from the shared spelling generator (#4713 R11):
 * every quoting of the executable `git` before `push`, and of the verbs `push`
 * and `commit` after `git`.
 *
 * Each row runs through real `bash -c` with a recording stand-in for `git`
 * first on PATH (the real git never runs), then through
 * `isGitCommitOrPushAttempt`. A row passes when the gate guards exactly what
 * bash ran, or, for a row bash did not run, when it fails closed on a word the
 * model cannot read (see `ACCEPTED`).
 *
 * The fail-closed rule the table pins, in `hidesGuardedVerb`: a word the word
 * model cannot read (an expansion) may be any word. It
 * guards the command when it precedes a word that is, or may be, `commit` or
 * `push`, or a word that holds a guarded command (the unread word may be a
 * launcher's switch or `eval`), or when it is git's own verb. An ANSI-C word
 * is no such word: the model decodes it as bash does (round 5), and the
 * decode table below runs each escape class against real bash.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	decodeShellWords,
	scanShellWriteScopes,
	tokenizeShellCommand,
} from "../../clients/bash-file-access.js";
import {
	isGitCommitOrPushAttempt,
	collectGitInvocations,
} from "../../clients/git-guard.js";
import { isFailedGitIntegrationCommand } from "../../clients/runtime-tool-result.js";
import { isWorktreeMutatingGitAttempt } from "../../clients/shared-checkout-guard.js";
import { COMMAND_WRAPPERS, spellings } from "../support/shell-spellings.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import { removeTempDirSync } from "./test-utils.js";

interface Row {
	row: string;
	command: string;
	/** The verb real bash ran, or `null`: pinned against the oracle. */
	bash: "commit" | "push" | null;
	guard: boolean;
}

/** The acceptance spellings, and the fail-closed rows, one per rule clause. */
const ROWS: readonly Row[] = [
	{ row: "plain", command: "git push", bash: "push", guard: true },
	{
		row: "ANSI-C executable",
		command: "$'git' push origin master",
		bash: "push",
		guard: true,
	},
	{
		row: "locale executable",
		command: '$"git" push',
		bash: "push",
		guard: true,
	},
	{
		row: "mixed executable",
		command: "g$'i't push",
		bash: "push",
		guard: true,
	},
	{
		row: "escaped $ is a literal word",
		command: "\\$'git' push",
		bash: null,
		guard: false,
	},
	{
		row: "ANSI-C executable, commit",
		command: "FOO=1 $'git' commit -m x",
		bash: "commit",
		guard: true,
	},
	{
		row: "ANSI-C verb",
		command: "git $'push'",
		bash: "push",
		guard: true,
	},
	{
		row: "mixed verb",
		command: "git pu$'sh'",
		bash: "push",
		guard: true,
	},
	{
		row: "ANSI-C executable behind a launcher",
		command: "env $'git' push",
		bash: "push",
		guard: true,
	},
	{
		row: "ANSI-C executable in a shell string",
		command: "bash -c $'git push'",
		bash: "push",
		guard: true,
	},
	{
		// The close of `$'\''` is its LAST quote: reading the second as the
		// close swallowed the rest of the line (#4739).
		row: "escaped quote in ANSI-C, then git",
		command: ": $'\\'' ; git push",
		bash: "push",
		guard: true,
	},
	{
		row: "escaped quote in ANSI-C, then git, after text",
		command: "echo $'it\\'s' && git push",
		bash: "push",
		guard: true,
	},
	{
		// The substitution scanner ended the string at the escaped quote too.
		row: "escaped quote in ANSI-C, then a substitution",
		command: "echo $'\\'' $(git push)",
		bash: "push",
		guard: true,
	},
	{
		// The body scanner ended the string at the escaped quote and lost the `)`.
		row: "escaped quote in ANSI-C inside a substitution",
		command: "echo $(: $'\\'' ; git push)",
		bash: "push",
		guard: true,
	},
	{
		// So did the `$IFS` pass: it read `git${IFS}push` as quoted text.
		row: "escaped quote in ANSI-C, then git${IFS}push",
		command: ": $'\\'' ; git${IFS}push",
		bash: "push",
		guard: true,
	},
	{
		// #5649 F3. The `$IFS` pass tracked quotes but not backslashes: the
		// escaped quote flipped it into "quoted", and `git${IFS}commit` after
		// it was never folded, while bash ran the commit.
		row: "escaped single quote, then git${IFS}commit",
		command: "echo \\'; git${IFS}commit -m x",
		bash: "commit",
		guard: true,
	},
	{
		row: "escaped double quote, then git${IFS}commit",
		command: 'echo \\"; git${IFS}commit -m x',
		bash: "commit",
		guard: true,
	},
	{
		row: "escaped single quote, then git$IFS$9commit",
		command: "echo \\'; git$IFS$9commit -m x",
		bash: "commit",
		guard: true,
	},
	{
		// An escaped backslash does not escape the quote after it: the quote
		// opens a string, so the `$IFS` inside it is literal text.
		row: "escaped backslash, then a quote opens a string",
		command: "echo \\\\'; git${IFS}commit -m x'",
		bash: null,
		guard: false,
	},
	{
		row: "escaped backslash, then git${IFS}commit",
		command: "echo \\\\; git${IFS}commit -m x",
		bash: "commit",
		guard: true,
	},
	{
		// #5649 F4. Bash's blanks are space, tab and newline. The lexer also
		// split on NBSP, U+FEFF, U+2003 and U+2028, so a `#` after one began a
		// comment for the gate, and the `$(…)` after it ran in bash unseen.
		row: "NBSP before a hash is no comment",
		command: "echo x #$(git commit -m y)",
		bash: "commit",
		guard: true,
	},
	{
		row: "U+FEFF before a hash is no comment",
		command: "echo x﻿#$(git commit -m y)",
		bash: "commit",
		guard: true,
	},
	{
		row: "U+2003 before a hash is no comment",
		command: "echo x #$(git commit -m y)",
		bash: "commit",
		guard: true,
	},
	{
		row: "U+2028 before a hash is no comment",
		command: "echo x #$(git commit -m y)",
		bash: "commit",
		guard: true,
	},
	{
		row: "a tab before a hash is a comment",
		command: "echo x\t#$(git commit -m y)",
		bash: null,
		guard: false,
	},
	{
		// Same family as F4, found by the fuzz comparison: the `#` after an
		// escaped blank or operator is a word character, not a comment.
		row: "escaped blank before a hash is no comment",
		command: "echo \\ #$(git commit -m y)",
		bash: "commit",
		guard: true,
	},
	{
		row: "escaped semicolon before a hash is no comment",
		command: "echo a\\;#$(git commit -m y)",
		bash: "commit",
		guard: true,
	},
	{
		row: "escaped backslash, then a blank, then a hash is a comment",
		command: "echo \\\\ #$(git commit -m y)",
		bash: null,
		guard: false,
	},
	{
		// Same family: bash reads `$IFS#` as one word, so the `#` starts no
		// comment, but the fold wrote a blank there and made it one.
		row: "$IFS before a hash is no comment",
		command: "echo a$IFS#$(git commit -m y)",
		bash: "commit",
		guard: true,
	},
	{
		row: "${IFS} before a hash is no comment",
		command: "echo a${IFS}#$(git commit -m y)",
		bash: "commit",
		guard: true,
	},
	{
		// Review r1 F5: bash removes `\<newline>` before it reads the comment
		// boundary, so the `#` after `${IFS}\<newline>` is still a word
		// character. The lookahead read the raw `\` and wrote a plain blank.
		row: "${IFS} then a line continuation, then a hash is no comment",
		command: "echo a${IFS}\\\n#$(git commit -m y)",
		bash: "commit",
		guard: true,
	},
	{
		row: "$IFS then a line continuation, then a hash is no comment",
		command: "echo a$IFS\\\n#$(git commit -m y)",
		bash: "commit",
		guard: true,
	},
	{
		row: "${IFS} then a line continuation, then a blank hash is a comment",
		command: "echo a${IFS}\\\n #$(git commit -m y)",
		bash: null,
		guard: false,
	},
	// Review r1 F1 (regression, fail-open): CR is a word character, so the
	// here-doc delimiter keeps it and the closing line `EOF\r` matches it
	// exactly. The body scan stripped the CR from candidate lines, so a CRLF
	// here-doc never closed and the commit after it was read as body text.
	{
		row: "CRLF here-doc, then a hidden commit",
		command: "cat <<EOF\r\nbody\r\nEOF\r\ngit $'\\x63ommit' -m x\r\n",
		bash: "commit",
		guard: true,
	},
	{
		row: "CRLF quoted here-doc, then a hidden commit",
		command: "cat <<'EOF'\r\nbody\r\nEOF\r\ngit $'\\x63ommit' -m x\r\n",
		bash: "commit",
		guard: true,
	},
	{
		// The closing line is not tab-indented: the canonical collapse turns a
		// leading tab into a blank, a miss on the base too that #5648 removes.
		row: "CRLF `<<-` here-doc, then a hidden commit",
		command: "cat <<-EOF\r\n\tbody\r\nEOF\r\ngit $'\\x63ommit' -m x\r\n",
		bash: "commit",
		guard: true,
	},
	{
		row: "git commit text inside a CRLF here-doc body is no commit",
		command: "cat <<EOF\r\ngit commit -m x\r\nEOF\r\n",
		bash: null,
		guard: false,
	},
	{
		// The here-doc delimiter is `EOF<NBSP>x`, one word, so the body runs to
		// the line that holds all of it and the commit in it is text. The lexer
		// ended the delimiter at the NBSP and ran the line after `EOF`.
		row: "NBSP inside a here-doc delimiter",
		command: "cat <<EOF x >/dev/null\nEOF\ngit commit -m y\nEOF x\n",
		bash: null,
		guard: false,
	},
	{
		// The gate read `git<NBSP>commit` as two words; bash runs the one
		// command `git<NBSP>commit`, which is not git.
		row: "NBSP between git and commit is one word",
		command: "git commit -m x",
		bash: null,
		guard: false,
	},
	{
		// bash removes the backslash; the path reading kept it (#4739).
		row: "escaped letter in the executable",
		command: "g\\it push",
		bash: "push",
		guard: true,
	},
	{
		// The canonical text lost its trailing newline, and with it the
		// continuation that joins the last word to nothing.
		row: "trailing line continuation",
		command: "git push\\\n",
		bash: "push",
		guard: true,
	},
	{
		// Recurrence prevented (#5648 review F1): the removed blank-collapse
		// pass turned `\ ` before a newline into a line continuation, so the
		// gate read the commit as echo's word. Bash ends the command at the
		// newline and runs the commit.
		row: "escaped blank, then a newline, then git commit",
		command: "echo a \\ \ngit commit -m x",
		bash: "commit",
		guard: true,
	},
	{
		// The same shape with a carriage return in place of the blank.
		row: "escaped CR, then a newline, then git commit",
		command: "echo a \\\r\ngit commit -m x",
		bash: "commit",
		guard: true,
	},
	{
		row: "subshell",
		command: "(git push)",
		bash: "push",
		guard: true,
	},
	{
		row: "subshell after a list",
		command: "(true; git push)",
		bash: "push",
		guard: true,
	},
	{
		row: "subshell, commit",
		command: "(git commit -m x)",
		bash: "commit",
		guard: true,
	},
	{
		row: "nested subshells",
		command: "( (git push) )",
		bash: "push",
		guard: true,
	},
	{
		row: "subshell after a cd",
		command: "(cd . && git push)",
		bash: "push",
		guard: true,
	},
	{
		row: "group",
		command: "{ git push; }",
		bash: "push",
		guard: true,
	},
	{
		row: "group around a subshell",
		command: "{ (git push); }",
		bash: "push",
		guard: true,
	},
	{
		row: "subshell around a group",
		command: "( { git push; } )",
		bash: "push",
		guard: true,
	},
	{
		row: "subshell, mixed executable",
		command: "(g$'i't push)",
		bash: "push",
		guard: true,
	},
	{
		row: "subshell, escape in the executable",
		command: "($'\\x67it' push)",
		bash: "push",
		guard: true,
	},
	{
		row: "unbalanced open paren, which bash rejects",
		command: "(git push",
		bash: null,
		guard: true,
	},
	{
		row: "unbalanced close paren, which bash rejects",
		command: "git push)",
		bash: null,
		guard: true,
	},
	{
		row: "subshell around a verb the gate does not govern",
		command: "(git status)",
		bash: null,
		guard: false,
	},
	// Fail closed: a word the model cannot read.
	{
		row: "escape in the executable",
		command: "$'\\x67it' push",
		bash: "push",
		guard: true,
	},
	{
		row: "escape in the verb",
		command: "git $'\\x70ush'",
		bash: "push",
		guard: true,
	},
	{
		row: "escape in both",
		command: "$'\\x67it' $'\\x70ush'",
		bash: "push",
		guard: true,
	},
	{
		row: "escape in a shell string",
		command: "bash -c $'git\\x20push'",
		bash: "push",
		guard: true,
	},
	{
		row: "escape handed to eval",
		command: "eval $'git\\x20push'",
		bash: "push",
		guard: true,
	},
	// Round 3: a literal string handed to `eval` is a command string, as it is
	// for `bash -c`. Recurrence: review r1 F1, `eval "git push"` ran git while
	// the gate said false, because only an unquoted `eval git push` was read.
	{
		row: "eval, double-quoted string, push",
		command: 'eval "git push"',
		bash: "push",
		guard: true,
	},
	{
		row: "eval, double-quoted string, commit",
		command: 'eval "git commit -m x"',
		bash: "commit",
		guard: true,
	},
	{
		row: "eval, single-quoted string",
		command: "eval 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "eval, single-quoted string, commit",
		command: "eval 'git commit -m x'",
		bash: "commit",
		guard: true,
	},
	{
		row: "eval after a double dash",
		command: 'eval -- "git push"',
		bash: "push",
		guard: true,
	},
	{
		row: "eval of a substitution that prints git push",
		command: 'eval "$(echo git push)"',
		bash: "push",
		guard: true,
	},
	{
		row: "eval, string names a verb the gate does not govern",
		command: 'eval "git status"',
		bash: null,
		guard: false,
	},
	{
		row: "eval of a plain command",
		command: "eval echo hi",
		bash: null,
		guard: false,
	},
	// Round 3: a launcher's command string is read again, and an escape in it
	// is a word the re-lex cannot read. Recurrence: Greptile P1 on #4752,
	// `nix-shell --run $'git\x20push'` returned from the `--run` branch before
	// the fail-closed rule ran, and the re-lex saw an empty string.
	{
		row: "nix-shell --run, plain string",
		command: "nix-shell --run 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "nix-shell --run, escape in the string",
		command: "nix-shell --run $'git\\x20push'",
		bash: "push",
		guard: true,
	},
	{
		row: "nix-shell --run, escape in the executable",
		command: "nix-shell --run $'\\x67it push'",
		bash: "push",
		guard: true,
	},
	{
		row: "unknown launcher -c, escape in the string",
		command: "launcher -c $'git\\x20push'",
		bash: "push",
		guard: true,
	},
	{
		row: "nix-shell --run, string names no git",
		command: "nix-shell --run 'echo hi'",
		bash: null,
		guard: false,
	},
	// Round 4: a word the model cannot read may be a launcher's switch or
	// `eval`, so a later word that holds a guarded command guards the command.
	// Recurrence: verify r3 F1 on #4752, round 3 deleted the launcher clause and
	// `bash $'\x2dc' 'git push'` ran unguarded with every row green. F2 and F3:
	// `nix-shell --command` and an `eval` behind `builtin` or `command`.
	{
		row: "bash, escaped -c switch",
		command: "bash $'\\x2dc' 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "sh, escaped -c switch",
		command: "sh $'\\x2dc' 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "dash, escaped -c switch",
		command: "dash $'\\x2dc' 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "bash, escaped c of the switch",
		command: "bash $'-\\x63' 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "bash, switch escaped whole",
		command: "bash $'\\x2d\\x63' 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "nix-shell, escaped --run switch",
		command: "nix-shell $'\\x2d\\x2drun' 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "unknown launcher, escaped -c switch",
		command: "launcher $'\\x2dc' 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "escaped eval",
		command: "$'\\x65val' 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "escaped builtin before eval",
		command: "$'\\x62uiltin' eval 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "nix-shell --command",
		command: "nix-shell --command 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "builtin eval",
		command: "builtin eval 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "command eval",
		command: 'command eval "git push"',
		bash: "push",
		guard: true,
	},
	{
		row: "escaped -c switch, string runs no governed verb",
		command: "bash $'\\x2dc' 'git status'",
		bash: null,
		guard: false,
	},
	{
		row: "expansion as the launcher, string runs no governed verb",
		command: "$sh -c 'git status'",
		bash: null,
		guard: false,
	},
	{
		row: "nix-shell --command, string runs no governed verb",
		command: "nix-shell --command 'git status'",
		bash: null,
		guard: false,
	},
	{
		row: "command eval, string runs no governed verb",
		command: "command eval 'git status'",
		bash: null,
		guard: false,
	},
	{
		row: "eval as text",
		command: "echo eval 'git push'",
		bash: null,
		guard: false,
	},
	// Round 5: an ANSI-C word is decoded as bash decodes it, so a read-only
	// string or an ordinary flag value holding an escape is read, not guarded.
	// Recurrence: rounds 3 and 4 failed closed on every escape and guarded
	// `cut -d $'\t'`, `python3 -c $'…'` (11 of 20 realistic escape commands).
	{
		row: "read-only shell string holding an escape",
		command: "bash -c $'echo hi\\nls'",
		bash: null,
		guard: false,
	},
	{
		row: "read-only sh string holding an escape",
		command: "sh -c $'echo a\\necho b'",
		bash: null,
		guard: false,
	},
	{
		row: "read-only eval string holding an escape",
		command: "eval $'echo hi\\nls'",
		bash: null,
		guard: false,
	},
	{
		row: "tab in a shell string",
		command: "bash -c $'printf x\\ty'",
		bash: null,
		guard: false,
	},
	{
		row: "tab delimiter after a flag, cut",
		command: "cut -d $'\\t' -f1 f.txt",
		bash: null,
		guard: false,
	},
	{
		row: "tab delimiter after a flag, sort",
		command: "sort -t $'\\t' -k2 f.txt",
		bash: null,
		guard: false,
	},
	{
		row: "tab delimiter after a flag, paste",
		command: "paste -d $'\\t' a.txt b.txt",
		bash: null,
		guard: false,
	},
	{
		row: "newline delimiter after a flag, xargs",
		command: "xargs -d $'\\n' ls < f.txt",
		bash: null,
		guard: false,
	},
	{
		row: "tab pattern after a flag, rg",
		command: "rg -e $'\\t' f.txt",
		bash: null,
		guard: false,
	},
	{
		row: "inline python with an escape",
		command: "python3 -c $'x = 1\\ny = 2'",
		bash: null,
		guard: false,
	},
	{
		row: "inline node with an escape",
		command: "node -e $'let x = 1\\nx++'",
		bash: null,
		guard: false,
	},
	{
		row: "NUL ends the quote, the word goes on",
		command: "$'git\\x00x' push",
		bash: "push",
		guard: true,
	},
	{
		row: "NUL ends the quote inside the executable",
		command: "$'gi\\x00t' push",
		bash: null,
		guard: false,
	},
	{
		row: "NUL ends a shell string before a push",
		command: "bash -c $'git status\\x00\\ngit push'",
		bash: null,
		guard: false,
	},
	{
		row: "unicode escape executable",
		command: "$'\\u0067it' push",
		bash: "push",
		guard: true,
	},
	{
		row: "octal escape switch",
		command: "bash $'\\055c' 'git push'",
		bash: "push",
		guard: true,
	},
	{
		row: "expansion as the executable",
		command: "$g push",
		bash: "push",
		guard: true,
	},
	{
		// Recurrence: round 6 limits the later-unread-word clause to an unread
		// executable; dropping that arm would miss this (verify r5 class A).
		row: "expansions as the executable and the verb (r6 keep)",
		command: "$g $v",
		bash: "push",
		guard: true,
	},
	{
		row: "expansion as the verb",
		command: "git $v",
		bash: "push",
		guard: true,
	},
	{
		row: "command substitution as the executable",
		command: "$(echo git) push",
		bash: "push",
		guard: true,
	},
	{
		row: "glob as the executable",
		command: "bin/g?t push",
		bash: "push",
		guard: true,
	},
	{
		row: "brace list as the verb",
		command: "git {push,x}",
		bash: "push",
		guard: true,
	},
	{
		row: "unknown executable before a verb word, bash runs nothing",
		command: "$unset push",
		bash: null,
		guard: true,
	},
	{
		row: "double-quoted expansion as the executable",
		command: '"$g" push',
		bash: "push",
		guard: true,
	},
	{
		row: "locale-quoted expansion as the executable",
		command: '$"$g" push',
		bash: "push",
		guard: true,
	},
	{
		row: "empty word before git",
		command: "'' git push",
		bash: null,
		guard: true,
	},
	// Unguarded: a word that is not git, or a word the model cannot read that
	// cannot be git or its verb.
	{
		row: "escaped expansion is a literal word",
		command: "\\$g push",
		bash: null,
		guard: false,
	},
	{
		row: "single-quoted expansion is a literal word",
		command: "'$g' push",
		bash: null,
		guard: false,
	},
	{
		row: "expansion after the verb word",
		command: "ls push $g",
		bash: null,
		guard: false,
	},
	{
		row: "expansion in a shell string, which names no git",
		command: 'bash -c "echo $g"',
		bash: null,
		guard: false,
	},
	{
		row: "escape in an argument of an ordinary command",
		command: "ls $'a\\tb'",
		bash: null,
		guard: false,
	},
	{
		row: "escape in a text consumer",
		command: "echo $'\\x67it' push",
		bash: null,
		guard: false,
	},
	{
		row: "expansion in a text consumer",
		command: "echo $g push",
		bash: null,
		guard: false,
	},
	// Round 6 (verify r5 class A): an unread word after a readable command
	// word is an argument; a second unread word does not make it git.
	{
		row: "an unread argument and a readable one (r6)",
		command: "cp $SRC dst",
		bash: null,
		guard: false,
	},
	{
		row: "two unread arguments of an ordinary command (r6)",
		command: "cp $SRC $DST",
		bash: null,
		guard: false,
	},
	{
		row: "two unread arguments of a read-only git verb (r6)",
		command: "git status $A $B",
		bash: null,
		guard: false,
	},
	{
		row: "two unread arguments of git add (r6)",
		command: "git add $A $B",
		bash: null,
		guard: false,
	},
	{
		row: "two unread arguments of a reader (r6)",
		command: "cat $A $B",
		bash: null,
		guard: false,
	},
	{
		row: "an unread output and URL (r6)",
		command: "curl -s -o $OUT $URL",
		bash: null,
		guard: false,
	},
	{
		row: "an unread output and URL, wget (r6)",
		command: "wget -q -O $OUT $URL",
		bash: null,
		guard: false,
	},
	{
		row: "brace words of xargs (r6)",
		command: "xargs -I{} echo {}",
		bash: null,
		guard: false,
	},
	// #5652: the gate read a `bash -c` or `eval` string as words and never scanned
	// it for command substitutions, so `bash -c 'echo $(git commit -m x)'` ran a
	// commit the gate did not see. #5652 (comment, #5651 verify V1): the `)` that
	// closes a substitution is part of its word, so a `#` after it is no comment.
	{
		row: "bash -c body with a $() commit",
		command: "bash -c 'echo $(git commit -m x)'",
		bash: "commit",
		guard: true,
	},
	{
		row: "sh -c body with a $() push",
		command: "sh -c 'echo $(git push)'",
		bash: "push",
		guard: true,
	},
	{
		row: "bash -c body with a backtick commit",
		command: "bash -c 'echo `git commit -m x`'",
		bash: "commit",
		guard: true,
	},
	{
		row: "bash -c body with a double-quoted $() commit",
		command: "bash -c 'echo \"$(git commit -m x)\"'",
		bash: "commit",
		guard: true,
	},
	{
		row: "bash -c body with a process substitution commit",
		command: "bash -c 'cat <(git commit -m x)'",
		bash: "commit",
		guard: true,
	},
	{
		row: "bash -c body with an unquoted here-doc substitution",
		command: "bash -c 'cat <<EOF\n$(git commit -m x)\nEOF'",
		bash: "commit",
		guard: true,
	},
	{
		row: "eval body with a $() commit",
		command: "eval 'echo $(git commit -m x)'",
		bash: "commit",
		guard: true,
	},
	{
		row: "eval body with a backtick commit",
		command: "eval 'echo `git commit -m x`'",
		bash: "commit",
		guard: true,
	},
	{
		row: "eval of two words joins them, the substitution runs",
		command: "eval echo '$(git commit -m x)'",
		bash: "commit",
		guard: true,
	},
	{
		row: "bash -c inside bash -c, substitution in the inner body",
		command: "bash -c 'bash -c \"echo \\$(git commit -m x)\"'",
		bash: "commit",
		guard: true,
	},
	{
		row: "bash -c inside a $(), a substitution in its body",
		command: 'echo $(bash -c "echo \\$(git push)")',
		bash: "push",
		guard: true,
	},
	{
		row: "bash -c body holds a hidden-verb commit in a substitution",
		command: "bash -c 'echo $(git $'\"'\"'\\x63ommit'\"'\"' -m x)'",
		bash: "commit",
		guard: true,
	},
	{
		row: "bash -c body, substitution in single quotes is text",
		command: "bash -c \"echo '\\$(git commit -m x)'\"",
		bash: null,
		guard: false,
	},
	{
		row: "bash -c body, escaped substitution is text",
		command: "bash -c 'echo \\$(git commit -m x)'",
		bash: null,
		guard: false,
	},
	{
		row: "bash -c body, substitution after a comment is text",
		command: "bash -c 'echo a #$(git commit -m x)'",
		bash: null,
		guard: false,
	},
	{
		row: "bash -c body with a harmless substitution",
		command: "bash -c 'echo $(git status)'",
		bash: null,
		guard: false,
	},
	{
		row: "eval body, substitution in single quotes is text",
		command: "eval \"echo '\\$(git commit -m x)'\"",
		bash: null,
		guard: false,
	},
	{
		row: "a $() close is no comment boundary before a hash",
		command: "echo $(true)#$(git commit -m x)",
		bash: "commit",
		guard: true,
	},
	{
		row: "a backtick close is no comment boundary before a hash",
		command: "echo `true`#$(git commit -m x)",
		bash: "commit",
		guard: true,
	},
	{
		row: "a process substitution close is no comment boundary before a hash",
		command: "cat <(true)#$(git commit -m x)",
		bash: "commit",
		guard: true,
	},
	{
		row: "a $(( )) close is no comment boundary before a hash",
		command: "echo $((1))#$(git commit -m x)",
		bash: "commit",
		guard: true,
	},
	{
		row: "two $() before a hash, push then commit",
		command: "echo $(git push)#$(git commit -m x)",
		bash: "push",
		guard: true,
	},
	// The word tokenizer read the same `)` as a comment boundary and dropped the
	// rest of the line, a plain commit after `;` included.
	{
		row: "a $() close before a hash, then a plain commit after a semicolon",
		command: "echo $(true)#;git commit -m x",
		bash: "commit",
		guard: true,
	},
	{
		row: "a $(( )) close before a hash, then a plain commit after a semicolon",
		command: "echo $((1))#;git commit -m x",
		bash: "commit",
		guard: true,
	},
	{
		row: "a process substitution close before a hash, then a plain commit",
		command: "echo <(true)#;git commit -m x",
		bash: "commit",
		guard: true,
	},
	{
		row: "a nested $() close before a hash, then a plain commit",
		command: "echo $(echo $(true))#;git commit -m x",
		bash: "commit",
		guard: true,
	},
	{
		row: "a subshell close before a hash is a comment, a commit after it is text",
		command: "(true)#;git commit -m x",
		bash: null,
		guard: false,
	},
	{
		row: "a $() close before a hash, then a commit in a bash -c body",
		command: "echo $(true)#;sh -c 'git commit -m x'",
		bash: "commit",
		guard: true,
	},
	{
		row: "a $() close, a blank, then a hash is a comment",
		command: "echo $(true) #$(git commit -m x)",
		bash: null,
		guard: false,
	},
	{
		row: "a subshell close is a comment boundary before a hash",
		command: "(true)#$(git commit -m x)",
		bash: null,
		guard: false,
	},
	{
		row: "a $() close before a hash inside a bash -c body",
		command: "bash -c 'echo $(true)#$(git commit -m x)'",
		bash: "commit",
		guard: true,
	},
];

/**
 * The generated rows: every quoting of the executable and of the verbs, bare
 * and inside each subshell and group wrapper.
 */
const PLAIN: readonly string[] = [
	...spellings("git").map((spelled) => `${spelled} push`),
	...spellings("push").map((spelled) => `git ${spelled}`),
	...spellings("commit").map((spelled) => `git ${spelled} -m x`),
];
const GENERATED: readonly string[] = [
	...PLAIN,
	...COMMAND_WRAPPERS.flatMap((wrap) => PLAIN.map(wrap)),
];

/**
 * Accepted over-guards: rows bash does not run as git, which the gate guards
 * because it reads a word as git that bash reads as something else. Each is
 * base-equal (the gate guarded the row before #4739) and in the fail-closed
 * direction. Each entry carries its reason and the exact count it covers, so
 * an entry that stops matching, or starts matching more, reds here.
 */
const ACCEPTED: ReadonlyArray<{
	reason: string;
	rows: number;
	covers: (command: string) => boolean;
}> = [
	{
		reason:
			"bash reads a word holding whitespace (`git\\ push`, `'\\<newline>git'`) as one command name, and the head split reads it as `git` then `push`: a command bash cannot find",
		rows: 150,
		covers: (command) => command.includes("\\ ") || command.includes("'\\\n"),
	},
	{
		reason:
			"a backslash inside quotes (`'\\git'`, `\"\\p\"ush`) is literal to bash, and the verb normalization strips a backslash before a letter, so the gate reads the word as `git` or `push`",
		rows: 270,
		covers: (command) => /['"]\\[a-z]/.test(command),
	},
];

/**
 * Round 5: one ANSI-C word per escape class and edge, run through real bash
 * (`printf %s`, C.UTF-8): the simple escapes, octal (value & 0xff), `\x`,
 * `\u` and `\U` (surrogates, the 5- and 6-byte forms, a dropped value at
 * 2^31), `\cX`, an unknown escape, a missing digit, a digit past the cap,
 * and a NUL that ends only its own quote. Recurrence: rounds 1 to 4 left an
 * escape unread and failed closed on it, which guarded read-only commands.
 */
const ANSI_C_WORDS: readonly string[] = [
	"$'\\a\\b\\e\\E\\f\\n\\r\\t\\v'",
	"$'\\\\\\'\\\"\\?'",
	"$'\\7'",
	"$'\\101'",
	"$'\\0101'",
	"$'\\1234'",
	"$'\\777'",
	"$'\\18'",
	"$'a\\0b'c",
	"$'\\400'x",
	"$'\\08'",
	"$'\\x41'",
	"$'\\x7'",
	"$'\\x414'",
	"$'\\x2dc'",
	"$'\\xc3\\xa9'",
	"$'\\xff'",
	"$'\\xg'",
	"$'\\x41\\x'",
	"$'a\\x00b'c",
	"$'a\\x00b'$'cd'",
	"$'\\u41'",
	"$'\\u0067it'",
	"$'\\u00e9'",
	"$'\\u2010'",
	"$'\\u0080'",
	"$'\\ud800'",
	"$'\\uD83D\\uDE00'",
	"$'\\u'",
	"$'\\u00411'",
	"$'\\U000000411'",
	"$'\\u0000x'y",
	"$'\\U41'",
	"$'\\U0001F600'",
	"$'\\U0010FFFF'",
	"$'\\U110000'",
	"$'\\U00200000'",
	"$'\\U04000000'",
	"$'\\U7FFFFFFF'",
	"$'a\\U80000000b'",
	"$'a\\UFFFFFFFFb'",
	"$'\\cA'",
	"$'\\ca'",
	"$'\\c?'",
	"$'\\c['",
	"$'\\c1'",
	"$'\\cJ'",
	"$'\\c\\\\x'",
	"$'\\c\\\\\\\\'",
	"$'\\c\u00e9'",
	"$'\\c'",
	"$'\\c@x'y",
	"$'\\z'",
	"$'\\8'",
	"$'\\N'",
	"$'git'",
	"$'\u00e9\\x41'",
	"$'\\x67'it",
	"g$'\\x69't",
];

/**
 * The round 4 state table, as rows: each launcher, its switch (or `eval`) and
 * its command string, each spelled plain or with every character escaped, and
 * a `git status` twin of each. Bash decodes an escape before the command runs,
 * so every spelling runs what its plain twin runs. Recurrence: four rounds
 * patched one launcher spelling at a time, and the round 3 deletion of the
 * launcher clause passed every row because no row spelled the switch escaped.
 */
const escapeEach = (word: string) =>
	`$'${[...word].map((ch) => `\\x${ch.charCodeAt(0).toString(16)}`).join("")}'`;
interface LauncherRow {
	command: string;
	verb: "push" | "status";
	/** The string's verb is an expansion (`"git $s"`): the gate cannot read it. */
	unreadVerb: boolean;
}
const LAUNCHER_TABLE: readonly LauncherRow[] = (() => {
	const rows = new Map<string, LauncherRow>();
	const launchers: ReadonlyArray<readonly [string | null, string]> = [
		["bash", "-c"],
		["sh", "-c"],
		["dash", "-c"],
		["nix-shell", "--run"],
		["nix-shell", "--command"],
		["launcher", "-c"],
		[null, "eval"],
		["builtin", "eval"],
		["command", "eval"],
	];
	for (const [executable, start] of launchers)
		for (const escapeExecutable of [false, true])
			for (const escapeStart of [false, true])
				for (const string of ["plain", "escaped", "expansion"] as const)
					for (const verb of ["push", "status"] as const) {
						const words = [
							executable === null
								? undefined
								: escapeExecutable
									? escapeEach(executable)
									: executable,
							escapeStart ? escapeEach(start) : start,
							string === "plain"
								? `'git ${verb}'`
								: string === "escaped"
									? `$'git\\x20${verb}'`
									: `"git $${verb === "push" ? "v" : "s"}"`,
						];
						const command = words.filter(Boolean).join(" ");
						rows.set(command, {
							command,
							verb,
							unreadVerb: string === "expansion",
						});
					}
	return [...rows.values()];
})();

let root: string;
let home: string;
let log: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-ggdw-"));
	home = path.join(root, "home");
	log = path.join(root, "git.log");
	fs.mkdirSync(path.join(home, "bin"), { recursive: true });
	// A recording stand-in: the real git never runs. It logs git's first
	// argument, the verb, NUL-ended (a verb word may hold a newline).
	const stub = path.join(home, "bin", "git");
	fs.writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\0\' "$1" >> "$GITLOG"\n');
	fs.chmodSync(stub, 0o755);
	// Command-string launchers the gate knows by name, as stand-ins that do
	// what the real ones do with `-c`, `--run` and `--command`: run the string
	// in a shell.
	for (const [name, script] of [
		[
			"nix-shell",
			'#!/bin/sh\ncase "$1" in --run | --command) exec sh -c "$2" ;; esac\n',
		],
		["launcher", '#!/bin/sh\n[ "$1" = -c ] && exec sh -c "$2"\n'],
	] as const) {
		const launcher = path.join(home, "bin", name);
		fs.writeFileSync(launcher, script);
		fs.chmodSync(launcher, 0o755);
	}
});

afterAll(() => {
	removeTempDirSync(root);
});

/** Real `bash -c command` in the stub home: its stdout, even when it fails. */
function runBash(command: string, locale: string): Buffer {
	try {
		return execFileSync("bash", ["-c", command], {
			cwd: home,
			env: {
				PATH: `${path.join(home, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
				HOME: home,
				LC_ALL: locale,
				GITLOG: log,
				g: "git",
				v: "push",
				s: "status",
				sh: "sh",
			},
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
		});
	} catch (error) {
		// A command bash cannot run still logged what ran before it failed.
		return Buffer.from((error as { stdout?: Buffer }).stdout ?? "");
	}
}

/** The governed verb real bash ran for `command`, or `null`. */
function bashRan(command: string): "commit" | "push" | null {
	fs.rmSync(log, { force: true });
	runBash(command, "C");
	const verbs = fs.existsSync(log)
		? fs.readFileSync(log, "utf8").split("\0")
		: [];
	return verbs.includes("push")
		? "push"
		: verbs.includes("commit")
			? "commit"
			: null;
}

const guarded = (command: string) =>
	isGitCommitOrPushAttempt("bash", { command });

describe.skipIf(process.platform === "win32")(
	"the commit gate reads the word bash decodes (#4739)",
	() => {
		it("guards what real bash runs, row by row", () => {
			const failures: string[] = [];
			for (const row of ROWS) {
				const ran = bashRan(row.command);
				if (ran !== row.bash)
					failures.push(
						`${row.row} ${JSON.stringify(row.command)}: bash ran ${ran}, the row says ${row.bash}`,
					);
				if (guarded(row.command) !== row.guard)
					failures.push(
						`${row.row} ${JSON.stringify(row.command)}: gate ${!row.guard}, want ${row.guard}`,
					);
			}
			expect(failures).toEqual([]);
		}, 60_000);

		// Review r1 F6 (CodeRabbit): a PowerShell command string is read by
		// PowerShell, whose whitespace is Char.IsWhiteSpace (NBSP, U+0085, the
		// Unicode spaces, CR, VT, FF; CharTraits.IsWhitespace in the PowerShell
		// parser). Only the bash path takes bash's blanks. pwsh is not run
		// here: the rows are string-level, and the bash row is the oracle.
		it("reads a PowerShell or cmd command string with its own whitespace", () => {
			const nbsp = "\u00a0";
			const failures: string[] = [];
			for (const [command, want] of [
				[`pwsh -NoProfile -Command "git${nbsp}commit -m x"`, true],
				[`powershell.exe -c 'git${nbsp}push'`, true],
				[`cmd /c "git${nbsp}commit -m x"`, true],
				[`pwsh -Command "git\u2003commit -m x"`, true],
				[`bash -c "git${nbsp}commit -m x"`, false],
				[`git${nbsp}commit -m x`, false],
			] as const)
				if (guarded(command) !== want)
					failures.push(`${JSON.stringify(command)}: want ${want}`);
			expect(failures).toEqual([]);
		});

		it("guards every generated spelling bash runs as commit or push", () => {
			const failures: string[] = [];
			const covered = ACCEPTED.map(() => 0);
			let ran = 0;
			for (const command of GENERATED) {
				const verb = bashRan(command);
				if (verb !== null) ran++;
				const gate = guarded(command);
				if (gate === (verb !== null)) continue;
				const accepted =
					gate && verb === null
						? ACCEPTED.findIndex((entry) => entry.covers(command))
						: -1;
				if (accepted >= 0) {
					covered[accepted] = (covered[accepted] ?? 0) + 1;
					continue;
				}
				failures.push(
					`${JSON.stringify(command)}: bash ran ${verb}, the gate ${gate ? "guards" : "misses"}`,
				);
			}
			// Floors: the generator still composes, and bash still ran git (a
			// missing bash would run nothing and pass every miss as accepted).
			assertNonEmptyScan("composed spellings", GENERATED.length, 2000);
			assertNonEmptyScan("spellings bash ran as commit or push", ran, 100);
			expect(failures).toEqual([]);
			expect(covered).toEqual(ACCEPTED.map((entry) => entry.rows));
			// The cost bound: one spawn per row, so the exact count bounds the run.
			expect(GENERATED.length).toBe(
				PLAIN.length * (COMMAND_WRAPPERS.length + 1),
			);
			expect(PLAIN.length).toBe(693);
		}, 120_000);

		it("decodes every ANSI-C escape class as bash does (r5)", () => {
			const failures: string[] = [];
			let nonEmpty = 0;
			for (const word of ANSI_C_WORDS) {
				const command = `printf %s ${word}`;
				const bytes = runBash(command, "C.UTF-8");
				if (bytes.length > 0) nonEmpty++;
				const decoded = decodeShellWords(command)[0]?.words[2];
				// Bash's bytes read as UTF-8, as the command is; where they are
				// valid UTF-8 the decoded text is byte-identical too.
				const asText = new TextDecoder().decode(bytes);
				const valid = Buffer.from(asText, "utf8").equals(bytes);
				if (
					decoded?.hidden !== undefined ||
					decoded?.text !== asText ||
					(valid && !Buffer.from(decoded.text, "utf8").equals(bytes))
				)
					failures.push(
						`${JSON.stringify(word)}: bash ${bytes.toString("hex")}, decoded ${Buffer.from(decoded?.text ?? "").toString("hex")}${decoded?.hidden ? " (hidden)" : ""}`,
					);
			}
			// Floor: bash ran (a missing bash prints nothing for every word).
			assertNonEmptyScan("words bash printed", nonEmpty, 40);
			expect(failures).toEqual([]);
			expect(ANSI_C_WORDS.length).toBe(59);
		}, 60_000);

		it("guards every launcher spelling of the state table (r4)", () => {
			const failures: string[] = [];
			let accepted = 0;
			for (const row of LAUNCHER_TABLE) {
				const ran = bashRan(row.command);
				const want = row.verb === "push" ? "push" : null;
				if (ran !== want)
					failures.push(`${JSON.stringify(row.command)}: bash ran ${ran}`);
				const gate = guarded(row.command);
				if (gate === (ran !== null)) continue;
				// A status twin whose verb is an expansion: git's verb the gate
				// cannot read. An escape is decoded, so it is never a reason (r5).
				if (gate && row.verb === "status" && row.unreadVerb) {
					accepted++;
					continue;
				}
				failures.push(
					`${JSON.stringify(row.command)}: bash ran ${ran}, the gate ${gate ? "guards" : "misses"}`,
				);
			}
			expect(failures).toEqual([]);
			// 9 launchers, 3 string spellings, 2 verbs, 4 switch spellings (bare
			// eval has 2): 204 rows. 34 status twins spell git's verb as an
			// expansion; round 4 accepted 76, before the decode (round 5).
			expect(LAUNCHER_TABLE.length).toBe(204);
			expect(accepted).toBe(34);
		}, 60_000);
	},
);

describe("the word model the gate reads (#4739)", () => {
	const words = (command: string) =>
		decodeShellWords(command).flatMap((segment) => segment.words);

	it("reads the decoded word, not the token text", () => {
		// The legacy stream is the same `$git` for the two spellings bash
		// decodes differently; the decoded word is not.
		const legacy = (command: string) =>
			tokenizeShellCommand(command)[0]?.tokens[0];
		expect(legacy("$'git' push")).toBe(legacy("\\$'git' push"));
		expect(words("$'git' push")[0]).toEqual({ text: "git" });
		expect(words('$"git" push')[0]).toEqual({ text: "git" });
		expect(words("g$'i't push")[0]).toEqual({ text: "git" });
		expect(words("\\$'git' push")[0]).toEqual({ text: "$git" });
	});

	it("marks the words it cannot read, and which way", () => {
		// Round 5: an ANSI-C escape is decoded, so it is a word the model reads.
		expect(words("$'\\x67it'")[0]).toEqual({ text: "git" });
		expect(words("g$'\\x69't")[0]).toEqual({ text: "git" });
		for (const spelled of ["$g", "${g}", "$(echo", "`echo`", "gi?", "{git,x}"])
			expect(words(spelled)[0]?.hidden, spelled).toBe("expansion");
		for (const spelled of ["'$g'", "\\$g", "'gi?'", "$'$g'", "\\{git"])
			expect(words(spelled)[0]?.hidden, spelled).toBeUndefined();
	});

	it("ends a word at a paren, so the command word inside a subshell is its own", () => {
		// Recurrence: #4739 r2. `(git` was one word, so `(git push)` ran unguarded.
		const texts = (command: string) => words(command).map((w) => w.text);
		expect(texts("(git push)")).toEqual(["git", "push"]);
		expect(texts("( (git push) )")).toEqual(["git", "push"]);
		expect(texts("(g$'i't push)")).toEqual(["git", "push"]);
		expect(texts("{ git push; }")).toEqual(["git", "push"]);
		expect(texts("(cd x && git push)")).toEqual(["cd", "x", "git", "push"]);
		// A paren that is a character of its word stays in it: escaped, quoted,
		// or the opener of a substitution (which the gate reads as hidden).
		expect(texts("\\(git push")).toEqual(["\\(git", "push"]);
		expect(texts('"(git" push')).toEqual(["(git", "push"]);
		expect(texts("{git push")).toEqual(["{git", "push"]);
		expect(texts("$(echo git)")).toEqual(["$(echo", "git"]);
		expect(words("$(echo git)")[0]?.hidden).toBe("expansion");
	});

	it("keeps a native Windows executable path whole", () => {
		// The legacy token kept the backslashes; so does the decoded word.
		expect(words("C:\\tools\\git.exe push")[0]).toEqual({
			text: "C:\\tools\\git.exe",
		});
	});

	it("keeps `$'\\''` as one quote, so the next segment is its own", () => {
		// Recurrence: #4739. The lexer closed `$'\\'` at the escaped quote and
		// opened a quote at the real one, so `git push` sat inside it.
		expect(
			tokenizeShellCommand(": $'\\'' ; git push").map((s) => s.tokens),
		).toEqual([
			[":", "$\\'"],
			["git", "push"],
		]);
	});
});

describe("what else reads the decoded word (#4739)", () => {
	it("the shared-checkout guard sees an ANSI-C git too", () => {
		// The same matcher seam: `$'git' checkout .` rewrote the tree unguarded.
		expect(
			isWorktreeMutatingGitAttempt("bash", { command: "$'git' checkout ." }),
		).toBe(true);
	});

	it("reads the command inside a subshell or a group (r2)", () => {
		// Gains: `(git checkout .)` rewrote the tree unguarded. The commit gate
		// retires an over-guard on purpose: `{ git status; }` was an "indirect"
		// git behind a `{` word and was guarded; it is a direct git status now.
		// The shared-checkout guard answers false on it at both heads.
		const checkout = (command: string) =>
			isWorktreeMutatingGitAttempt("bash", { command });
		expect(checkout("(git checkout .)")).toBe(true);
		expect(checkout("{ git checkout .; }")).toBe(true);
		expect(checkout("(git status)")).toBe(false);
		expect(guarded("{ git status; }")).toBe(false);
		expect(guarded("(git status)")).toBe(false);
		expect(
			collectGitInvocations("bash", { command: "(git -C sub checkout .)" }),
		).toEqual([["git", "-C", "sub", "checkout", "."]]);
		// The other reader of the public token stream sees `(` and `git` apart
		// now and still names no git integration command: no gain, no loss.
		expect(isFailedGitIntegrationCommand("(git merge x)", true)).toBe(false);
	});

	it("the write scan reads a redirect inside a subshell (r2 side effect)", () => {
		// The redirect target `f.ts)` kept its paren, so the scan named no file
		// bash wrote (real bash wrote f.ts in each row but the second). Now it
		// names `f.ts`. The second row is the documented fallback: the scan keeps
		// the command's own cwd where bash wrote sub/f.ts, and recordWritten
		// confirms existence later.
		const written = (command: string) =>
			scanShellWriteScopes(command, "/w").written;
		expect(written("(printf x > f.ts)")).toEqual([path.resolve("/w", "f.ts")]);
		expect(written("echo $(printf x > f.ts)")).toEqual([
			path.resolve("/w", "f.ts"),
		]);
		expect(written("(cd sub && printf x > f.ts)")).toEqual([
			path.resolve("/w", "f.ts"),
		]);
	});

	it("reads a literal eval string for the shared-checkout guard too (r3)", () => {
		// The eval arm sits in the matcher both gates share, as the `bash -c`
		// arm does: `eval "git checkout ."` rewrote the tree unguarded, and
		// `eval "git status"` still does not match.
		const checkout = (command: string) =>
			isWorktreeMutatingGitAttempt("bash", { command });
		expect(checkout('eval "git checkout ."')).toBe(true);
		expect(checkout('eval "git status"')).toBe(false);
		expect(checkout("eval echo hi")).toBe(false);
	});

	it("targets the directory of an ANSI-C git", () => {
		expect(
			collectGitInvocations("bash", { command: "$'git' -C sub checkout ." }),
		).toEqual([["git", "-C", "sub", "checkout", "."]]);
	});

	it("fails closed only for the policy gate", () => {
		// Recurrence: #2007. The guard that protects an agent from its own
		// accident must not decline what it can read; it does not guard a word
		// it cannot read.
		expect(
			isWorktreeMutatingGitAttempt("bash", { command: "$g checkout ." }),
		).toBe(false);
		expect(guarded("$g push")).toBe(true);
		// Round 5: an ANSI-C word is decoded, so both guards read it alike.
		expect(
			isWorktreeMutatingGitAttempt("bash", {
				command: "$'\\x67it' checkout .",
			}),
		).toBe(true);
		expect(
			isWorktreeMutatingGitAttempt("bash", {
				command: "nix-shell --run $'git\\x20checkout .'",
			}),
		).toBe(true);
		expect(guarded("nix-shell --run $'git\\x20push'")).toBe(true);
	});
});
