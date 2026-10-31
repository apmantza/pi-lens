#!/usr/bin/env node
/**
 * scripts/hooks/guard-bash.mjs (#2699, refs umbrella #2697)
 *
 * PreToolUse hook for the Bash tool. Mechanically enforces six
 * non-negotiables that previously lived only as prose in CLAUDE.md and the
 * fixer/reviewer playbooks -- a fixer ran `git stash` on 2026-09-07 (the
 * #2686 lane), two review probes wrote into the real `~/.pi-lens` on
 * 2026-09-02 (#2506), a fixer pointed TMPDIR at the vitest harness home
 * on 2026-09-15 (#3026), and twice on 2026-09-16 a fixer ran
 * `git worktree remove` on a tree whose `node_modules` was a symlink into
 * the shared checkout, so git followed the link and emptied the shared
 * install (#3173), all rules a hook can catch that prose could not:
 *
 *   - `git stash` in any form but the read-only `list` / `show` (CLAUDE.md
 *     non-negotiable; an admit list, #5111)
 *   - `git reset --soft origin/<branch>` / `git reset --hard <anything>`
 *   - a HAND-typed `git worktree remove` with two force flags (the
 *     sanctioned removal is `node scripts/worktree-remove.mjs <path>` (#5111),
 *     `node scripts/prune-agent-worktrees.mjs` (liveness-checked), or unlock +
 *     single force)
 *   - ANY `git worktree remove` (force or not) on a worktree whose
 *     `node_modules` is a symlink pointing OUTSIDE that worktree (#3173,
 *     the #2704 class) -- see {@link hasNodeModulesSymlinkOutside}
 *   - a MUTATING `npm`/`npx npm@…` verb (`ci`, `install`, `update`,
 *     `uninstall`, `prune`, `dedupe`, `rebuild`, …), `--dry-run` or not, in
 *     a project whose `node_modules` is a symlink pointing OUTSIDE it (#4044,
 *     the #3173 shape on 2026-10-07) -- see {@link classifyNpm}
 *   - a DELETE (`rm`, `rmdir`, `unlink`, `find … -delete`/`-exec rm`) whose
 *     operand passes THROUGH a `node_modules` symlink pointing outside its
 *     project (`rm -rf node_modules/`, `node_modules/*`, `find node_modules/
 *     -delete`; #4044) -- unlinking the link itself stays allowed; see
 *     {@link classifyNodeModulesDelete}
 *   - an unpinned `node` probe that LOADS built runtime code from clients/
 *     or dist/ (not merely a payload that mentions "clients/" in passing --
 *     review round 2 F5) with no PI_LENS_HOME pin (docs/invariants/paths-os.md
 *     "Paths, data, and operating systems")
 *   - `TMPDIR`/`TMP`/`TEMP` aimed at the vitest harness's own home
 *     (docs/invariants/paths-os.md "Paths, data, and operating systems", #3026) -- see
 *     {@link classifyTempDirVars}
 *   - a WRITE under `/tmp` (#4348; tmpfs on the maintainer host): a redirect
 *     (`>`, `>>`, `2>`, `&>`, `>&file`), `tee`, a `cp`/`mv`/`install` target
 *     (last operand or `-t DIR`), `mkdir`, `touch` -- see {@link
 *     classifyTmpWrite}. The harness's `/tmp/claude-<uid>/` and every read are
 *     exempt. NOT handled (named limits): `dd of=`, `>|`, a write inside
 *     `bash -c`/`sh -c`/`eval`/`xargs`/`find -exec`, programs with their own
 *     output flags (`curl -o`, `sed -i`, `awk`, `git ... --output`), an
 *     `export` segment's redirect, abbreviated long options (`--target=`),
 *     `${TMPDIR:-/tmp}`, an unset `$TMPDIR` (bash expands it to empty) and
 *     other unresolvable expansions, the `mktemp` FILE form, `ln -s`,
 *     `tar -C /tmp`, `/var/tmp`, and `/dev/shm`.
 *   - a git HOOK BYPASS on `git commit`/`push`/`merge`/`rebase` (#3778, the
 *     #3703 class): `--no-verify`, `-n` (commit only -- on `push` it is
 *     `--dry-run`), `-c core.hooksPath=…`, a `git config core.hooksPath`
 *     write, and the `HUSKY=0` / `PI_LENS_SKIP_HOOKS` env prefixes the repo's
 *     husky hooks honour -- see {@link classifyHookBypass}
 *   - force pushes and `+refspec` pushes; an exact
 *     `--force-with-lease=<branch>:<sha>` is the only force form allowed
 *   - rebase starts and completion forms. Recovery with `--abort` or `--quit`
 *     remains available; merge `origin/master` instead of starting a rebase.
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
 * ## Shape: subtract the inert regions, THEN tokenize (review round 3)
 *
 * Round 2 delimited a `$( … )` span with a standalone paren/quote counter
 * that ran THROUGH heredoc bodies. One unbalanced `)` in prose therefore
 * closed the span early and the rest of a PR description leaked into the
 * top-level command scan (round 2's own PR body was denied by its own
 * hook). The lesson is structural, not a missing case: span extents and
 * heredoc bodies cannot be decided by two separate scanners.
 *
 * So there is now exactly ONE region pass, {@link lexRegions}, which is
 * simultaneously quote-, comment-, heredoc- and substitution-aware and
 * calls ITSELF to find a nested span's extent. It returns
 *
 *   - `retained`: the text left after every INERT region is subtracted, and
 *   - a flat list of every command-substitution body at any depth,
 *
 * and only then does {@link splitSegments} split on operators (it has to
 * know about quotes and nothing else, because substitutions, heredoc
 * bodies and comments are already gone). A stray `)`/backtick inside a
 * heredoc body is unreachable by construction rather than special-cased.
 *
 * The regions are classified from REAL bash, empirically -- every
 * (region kind × nesting context) cell of the state space was run through
 * `bash -c` with a side-effecting stand-in for the forbidden command, and
 * the cell's verdict is whether the side effect happened. The full table,
 * with the fixture id that pins each cell, is in the PR body and in
 * `tests/scripts/guard-bash-hook.test.ts`'s `LEXER_STATE_SPACE`. The three
 * results that are easy to get backwards from reading code alone:
 *
 *   - A heredoc body with a QUOTED delimiter (`<<'EOF'`, `<<"EOF"`,
 *     `<<\EOF`) is inert in full and is dropped.
 *   - A heredoc body with an UNQUOTED delimiter (`<<EOF`) is NOT inert:
 *     bash still expands `$( … )` and backticks inside it, so
 *     `cat <<EOF` / `$(git stash)` / `EOF` really runs it. Its body text is
 *     dropped but its substitutions are recursed into.
 *   - Quotes and `#` are LITERAL inside any heredoc body -- so
 *     `'$(git stash)'` and `# $(git stash)` on a body line both still run.
 *
 * A single-quoted span is deliberately NOT subtracted. It is inert for
 * operator splitting, expansion, and comment/heredoc recognition, but it
 * still takes part in WORD formation: `git 'stash'` and `'git' stash` both
 * really run `git stash`. It is retained as literal word text instead, and
 * {@link splitWords} strips the quotes when fusing the word.
 *
 * ## Path arguments: ONE resolver (#3988)
 *
 * Every rule that tests a PATH argument -- `git worktree remove`, `git
 * worktree add`, `git clone`, `mktemp -d`, `node <file>`, a leading `git -C`,
 * and the `cd`/`pushd` that moves the cwd -- resolves it through
 * {@link expandShellWord} / {@link resolveShellPath}: `~`, `$HOME`, `${HOME}`,
 * `$VAR` (the command's variables, then this hook's ambient env) and `$PWD`
 * are expanded the way bash would before the program sees them, then a relative
 * result resolves against the command's EFFECTIVE cwd (a preceding `cd`, a
 * `git -C`, else the payload cwd; a `cd` inside `( … )` does not leak out).
 * Bash expands git's, mktemp's and node's path words before an inline
 * `VAR=val` prefix applies, so they are expanded without it, while what the
 * program reads from its own env still sees it: git's hook-bypass check
 * (`HUSKY=0`), GNU mktemp's default `$TMPDIR` (no template, `-t`, bare
 * `--tmpdir`; the rule models GNU mktemp), and node's `PI_LENS_HOME` (#3997,
 * #4057). A path git or mktemp hands the kernel is resolved physically: the
 * nearest existing ancestor through `realpath`, the missing tail as written
 * (#3997 H3, #4060). A `cd` target resolves logically, or physically after
 * `cd -P`. A path that cannot be
 * resolved statically (`$(…)`/backticks, `~user`, a variable with no known
 * value, a glob, a cwd made unknown by an unresolvable `cd`) makes
 * `git worktree remove` fail CLOSED (`worktreeUnresolved`); the tmp-checkout
 * hygiene rules stay fail-open on it. A substitution's output is unknown, so
 * {@link findDeny} reads a command holding one twice, with the output opaque
 * and with it empty, and denies if either reading does (#3997). Not handled:
 * The #4044 rules (`npmLinkedInstall`, `linkedNodeModulesDelete`) test a
 * directory where the program lands: the holder of each `node_modules` a
 * delete operand passes through physically, as the kernel does (a symlink
 * before a later `..` is followed), and `--prefix` lexically, as npm does.
 * A directory they cannot read -- an unknown cwd, or a value from `$( … )`,
 * backticks or an unknown variable -- is the project the command runs in
 * (the payload cwd when the tracked cwd is unknown), failing closed, so a
 * linked lane stays denied after `cd $(pwd) && npm ci` and for
 * `npm --prefix "$(pwd)" ci`. Not
 * handled: `cd x &` and
 * `cd x |` (a backgrounded or piped `cd` still moves the tracked cwd), a
 * `cd` inside a `$( … )` span (each span starts from the payload cwd), and a
 * `cd` that fails.
 *
 * ## Handled
 *
 * `&&`, `||`, `;`, `|`, `&`, `(`, `)`, newline as segment separators;
 * single/double-quoted spans as opaque fused words; `$( … )` and backtick
 * spans, recursively (including a `\``-escaped backtick span nested inside
 * a backtick span, which bash does execute); `<<`/`<<-` heredocs with a
 * quoted, bare, or backslash-escaped delimiter, `<<-`'s leading-tab strip,
 * and a `\r` before the delimiter's newline (a CRLF command whose
 * terminator would otherwise never match, swallowing every later command);
 * `<<<` here-strings (content inert, substitutions live); `#` comments,
 * recognized only at a word start the way bash does (`a#b` is not a
 * comment); backslash-newline line continuation; a leading `{`
 * command-group brace, the shell keywords and operators that run the next
 * word (`do`, `then`, `else`, `elif`, `if`, `while`, `until`, `!`,
 * `coproc`; #3787) and `command`/`exec`/`env`/`sudo`/`time` runner
 * prefixes; `export VAR=val` persisted forward to later segments of the
 * same scan; a command word resolved by its final path segment
 * (`/usr/bin/git` == `./git` == `git`); leading `FOO=bar` env assignments
 * and the git global options that take a separate value (`-c <k>=<v>`,
 * `-C <dir>`, `--git-dir`, `--work-tree`, `--namespace`, `--config-env`,
 * `--attr-source`; #3787); a backslash-escaped command word
 * (`\g\i\t stash`, which bash runs).
 *
 * ## NOT handled (accepted; no test claims otherwise)
 *
 *   - `eval "…"`, `bash -c "…"` / `sh -c "…"`, `xargs git stash`: the
 *     nested string or spawned argv is opaque to any text scan.
 *   - A runner prefix carrying its OWN options -- `sudo -u root git stash`,
 *     `timeout 30 git stash`, `nice -n 10 git stash`, `stdbuf -o0 …`. Only
 *     the bare prefix forms above are stripped; a prefix followed by a
 *     flag stops the search (the flag becomes the command word and matches
 *     no rule).
 *   - A command word assembled by expansion (`git st$(echo a)sh`,
 *     `${G} stash`, `$(which git) stash`): no static text scan can resolve
 *     a runtime-computed word.
 *   - A word spelled with ANSI-C escapes (`$'\x67it' stash`): the escapes
 *     are not decoded. A coproc label holding one counts as an expansion.
 *   - `require(mod)` with a variable specifier, for the probe rule.
 *   - npm/node_modules rules (#4044): `npm_config_prefix=`/`NPM_CONFIG_PREFIX`
 *     in the env; a launcher between the shell and
 *     npm that this file's other rules also miss -- `/usr/bin/env`, `env -i`,
 *     `sudo -E`, `corepack npm`, `nohup`/`nice`/`timeout`, `xargs`, `npm exec
 *     -- npm ci`, `npx -c 'npm ci'`, `node …/npm-cli.js`; pnpm, yarn and bun
 *     writers; a package script that runs `npm ci` (`npm run clean`). For the
 *     delete rule: a glob that expands TO the link (a star-slash operand such as `rm -rf` of every subdirectory), `find -L`
 *     from an ancestor of the lane, `xargs rm`, `find -exec sh -c`, `shred`,
 *     `mv`, `rsync --delete`, `git clean`, `npx rimraf`, a runtime
 *     `rmSync`/`rmtree`, and a dash-leading operand after `--`.
 *   - A hook bypass spelled some other way (#3778):
 *     `GIT_CONFIG_KEY_0=core.hooksPath`, a hand edit of `.git/config`, or
 *     `git commit` through an alias. (`--no-veri`/`--no-verif` ARE matched; `--no-ver`
 *     is ambiguous, so git itself rejects it.)
 *   - `kill $(pgrep -f tlc2.TLC)` and `pgrep -f tlc2 | xargs kill` (#3556
 *     review F6): the same machine-wide kill harm `sharedKill` denies, but
 *     `pgrep` alone only lists PIDs -- nothing in this scan currently
 *     recognizes the KILLING half of that two-command shape.
 *
 * These are documented blind spots, not silent ones: the guard's threat
 * model is an agent's own slip, not a party deliberately hiding a command
 * from it.
 *
 * Never throws: any stdin/JSON/classification failure degrades to "allow"
 * (exit 0) rather than blocking every Bash call in the session -- a crashed
 * hook must never be the thing that blocks the tool. That is also what
 * bounds recursion: {@link lexRegions} nests once per nested span, and a
 * pathologically deep input raises RangeError, which {@link run} catches
 * and allows. (Round 2 capped nesting at depth 8, which silently ALLOWED
 * anything nested deeper; the cap is deleted rather than raised.)
 */
import {
	existsSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	statSync,
	writeSync,
} from "node:fs";
import {
	dirname,
	isAbsolute,
	join,
	basename,
	relative,
	resolve,
	sep as SEP,
} from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {"stash"|"reset"|"worktreeForce"|"worktreeSymlink"|"worktreeUnresolved"|"probe"|"tmpdirCollision"|"sharedKill"|"tmpCheckout"|"tmpWrite"|"checkUngated"|"hookBypass"|"forcePush"|"ciVerdictStatus"|"rebase"|"npmLinkedInstall"|"linkedNodeModulesDelete"|"unscannableCase"} DenyRule */

/** @type {Record<DenyRule, string>} */
export const RULE_MESSAGES = {
	stash:
		"git stash that writes is forbidden (CLAUDE.md non-negotiable) -- it is repo-global across worktrees; use `git diff > fix.patch` / `git checkout --` / `git apply` instead. Only the read-only `git stash list` and `git stash show [<flags>] [stash@{N}]` are admitted, as a bare command with no `-c`/global option other than `-C <dir>` and no env var (inline or exported) before it.",
	reset:
		"`git reset --soft origin/<branch>` / `git reset --hard` is forbidden (fixer playbook rule) -- use `git checkout HEAD -- <path>` to discard a single file instead.",
	worktreeForce:
		"a HAND-typed `git worktree remove` with two force flags is forbidden (fixer playbook rule) -- use `node scripts/worktree-remove.mjs <path> [--force]` (one force), `node scripts/prune-agent-worktrees.mjs` (liveness-checked; it applies the same double force internally once a tree is confirmed dead) for a stuck worktree, or `git worktree unlock` then a single-force remove.",
	worktreeSymlink:
		"git worktree remove on a tree whose node_modules symlink chain cannot be safely resolved or leads outside the tree is forbidden (#3173, the #2704 class -- git can follow the link and empty the SHARED install, not just this worktree's copy) -- run `node scripts/worktree-remove.mjs <path>`: it unlinks the `node_modules` symlink (only the link, never the shared install), refuses a real `node_modules` directory, then runs `git worktree remove` (add `--force` for a single force).",
	worktreeUnresolved:
		"git worktree remove on a path this hook cannot resolve statically is forbidden (#3988) -- the #3173 node_modules-symlink check cannot run on it. The path, or the directory it is relative to, comes from a `$(...)`/backtick substitution, a `$VAR` with no value in the command or the hook environment, a `~user` or glob spelling, or an unresolvable `cd`/`git -C`/`popd`. Spell the worktree's absolute path literally (or `cd` to a literal directory first) and run `node scripts/worktree-remove.mjs <path>`, or use `node scripts/prune-agent-worktrees.mjs` for a stuck tree.",
	probe:
		"an unpinned node probe that LOADS runtime code from clients/ or dist/ is forbidden (docs/invariants/paths-os.md, Paths, data, and operating systems) -- prefix `PI_LENS_HOME=<worktree>/.probe-home`.",
	tmpdirCollision:
		"TMPDIR/TMP/TEMP must not point at the vitest harness home (docs/invariants/paths-os.md, Paths, data, and operating systems) -- tests/support/vitest-setup.ts keeps the real TMPDIR on purpose and mkdtemps PI_LENS_HOME under os.tmpdir(), so a TMPDIR inside `.probe-home` moves the harness home into a git-ignored directory in the worktree and reds unrelated suites (#3026). Pin PI_LENS_HOME/PILENS_DATA_DIR there; give TMPDIR its own directory.",
	sharedKill:
		"pkill/killall with a bare (unscoped) pattern is forbidden (#3556) -- it matches machine-wide and can kill another concurrent session's TLC/vitest/etc run on this shared host -- kill the recorded PID of your own background job instead (`kill <pid>`), or use `pkill -f` with a pattern that includes your worktree's absolute path so only your own processes match.",
	tmpCheckout:
		"a checkout or scratch directory under /tmp is forbidden (#3526) -- /tmp on the maintainer host is tmpfs (RAM + swap; #2912 saw inode exhaustion there) and review/merge scratch checkouts filled it to 8/8 GB swap -- use `~/.local/share/pi-lens-orchestrator/tmp/<lane>` for orchestrator/reviewer scratch, `<worktree>/../probes-<pr>` for probe files, or `.claude/worktrees/` for a fixer's own worktree.",
	tmpWrite:
		"a write under /tmp is forbidden (#4348) -- /tmp on the maintainer host is tmpfs (RAM + swap), and a redirect (`>`, `>>`, `2>`, `&>`), `tee`, a `cp`/`mv`/`install` target, `mkdir` or `touch` there fills it the way the #3526 scratch checkouts did -- write scratch under `$TMPDIR` (the lane's `~/.local/share/pi-lens-orchestrator/tmp/<lane>`; export it in the same command, an unset one expands to empty), `<worktree>/../probes-<lane>`, or the harness's own `/tmp/claude-<uid>/` directory. Reads from /tmp stay allowed.",
	hookBypass:
		"bypassing git hooks (`--no-verify`, `git commit -n`, `-c core.hooksPath=`, `git config core.hooksPath`, `HUSKY=0`, `PI_LENS_SKIP_HOOKS=`) is forbidden (#3778; #3703 pushed `--no-verify` and put 56 red files into CI) -- hooks always run; for a red that looks unrelated, prove it with `node scripts/red-on-base.mjs` and, unless it says RED-ON-BASE, fix it; if it does, stop and hand back its output instead of pushing past it; to repair a wrong `core.hooksPath`, run `node scripts/setup-git-hooks.mjs`.",
	checkUngated:
		"a `git commit`/`git push` chained after a check (`npm run lint`/`build`/`test`/`fmt:check`/`preflight`, `npx vitest`, `tsc`, `node scripts/check-*.mjs`) through `;` or a pipe, rather than `&&`, is forbidden (#3471) -- the check's exit code gates nothing that way, so a real failure can still get committed or pushed; gate it with `&&`, or read the check's result in its own separate call.",
	forcePush:
		"force-pushing is forbidden -- merge `origin/master` instead; force-push needs explicit orchestrator authorization with `--force-with-lease=<branch>:<expected-sha>`.",
	rebase:
		"`git rebase` is forbidden -- merge `origin/master` instead; recovery may use `git rebase --abort` or `--quit`.",
	npmLinkedInstall:
		"npm ci/install/update/uninstall/prune/dedupe/rebuild (and `npx npm@… ci`) is forbidden where the node_modules symlink chain cannot be safely resolved or leads into another checkout (#4044, the #3173 shape -- `npm ci` removes node_modules/* before it reifies, ignores `--dry-run` on npm 9.2.0, and follows the link, so it emptied the SHARED install under every lane on 2026-10-07; the other verbs rewrite that shared install in place) -- answer install-flag questions in a scratch copy that holds no node_modules link (copy package.json and package-lock.json into a directory under $TMPDIR and run npm there), or `rm node_modules` in a separate command first (a chain is judged before its `rm` runs) and install into the lane's own real directory, or point `--prefix` at a real directory the hook can read, such as `--prefix $TMPDIR/<name>` (a `--prefix` from `$(…)`, backticks or an unknown variable is judged as this project).",
	linkedNodeModulesDelete:
		"a delete whose operand passes THROUGH a node_modules symlink chain that cannot be safely resolved or leads into another checkout is forbidden (#4044, the #3173 shape -- `rm -rf node_modules/`, `rm -rf node_modules/*` and `find node_modules/ -delete` follow the link and empty the SHARED install, measured with GNU coreutils on 2026-10-07) -- unlink the link itself instead: `rm node_modules` or `unlink node_modules` (no trailing slash, no glob; it removes only the link), and delete a real node_modules directory only in a scratch copy.",
	unscannableCase:
		"a command substitution holds a `case` word at a position this hook cannot classify (#4060) -- bash may open a case clause there, whose pattern `)` is not the substitution's closing paren, so the hook cannot tell where the substitution ends or which command it runs. Write the `case` as its own command (`case` at the start of a command, or after `;`, `&&`, `|`, `then`, `do`, `{`), keep it out of a `for`/`select`/`coproc`/`function` header and out of `((`/`$((`, or move the substitution's work into a script.",
	ciVerdictStatus:
		"ci-verdict's exit status is lost through a pipe -- read the final `ci-verdict: exit <N> (<kind>)` line, or run `; echo $?` before the pipe; do not read `$?` after `ci-verdict.mjs … | …` (#3883).",
};

/**
 * Characters after which a `#` starts a comment and a new word begins --
 * bash's own rule (a `#` in the MIDDLE of a word, `a#b`, is literal). Also
 * terminates a bare heredoc delimiter. `(`/`)` are deliberately NOT members:
 * adding them was mutation-inert (round 3's M14 stayed green), and inside a
 * `$( … )` body {@link lexRegions} already sets the word-start flag on those
 * two characters explicitly.
 */
const WORD_BREAK = /[\s;&|<>]/;

/**
 * Reserved words whose grammar {@link lexRegions} does not model (`for ((…)) do
 * case`, `coproc NAME case` and `function f case` all open a clause at a word
 * that is not at a command position). A `case` before the next separator fails
 * closed instead of guessing (#4060).
 */
const UNMODELLED_HEADS = new Set(["coproc", "function", "for", "select"]);

/** One whitespace-and-metacharacter-delimited word, read from `lastIndex`. */
const WORD_RUN = /[^\s;&|()<>]+/y;

/**
 * Left in the `lexRegions` output where a `case` word sits at a position the
 * lexer cannot classify. Without a classification the hook cannot tell where
 * the substitution ends, so {@link findDeny} refuses the command
 * (`unscannableCase`) rather than guess (#4060). A private-use character,
 * like {@link SUBSTITUTION_MARK}, so it never reads as shell syntax.
 */
const UNSCANNABLE_CASE = String.fromCharCode(0xe001);

/**
 * Segment separators in the retained text. Single characters only: `&&`
 * and `||` fall out as two consecutive separators with nothing between
 * them, which {@link splitSegments} discards. `(` and `)` are here because
 * bash treats them as metacharacters that delimit commands, which is what
 * makes `(git stash)` and `( cd x && git stash )` reachable.
 */
const SEGMENT_SEPARATOR = /[;&|()\n]/;

/**
 * Is `text[i]` (already known to match {@link SEGMENT_SEPARATOR}) actually a
 * live separator, or a `&` that is part of a REDIRECTION rather than the
 * background operator / half of `&&`? Found while building #3471's
 * `checkUngated` rule: `npm run lint >/dev/null 2>&1 && git commit …` (the
 * issue's own case 1, rewritten with `&&` -- exactly the form the rule must
 * ALLOW) split into three bogus segments ("…2>", "1", "… git commit …")
 * because the lone `&` inside `2>&1` matched {@link SEGMENT_SEPARATOR}
 * unconditionally; the accumulated separator text on the segment after it
 * happened to still read "&&" only by coincidence of THIS example's spacing,
 * which is exactly why measuring caught it, not code review. MEASURED
 * against real bash (`bash -c 'echo A 2>&1 && echo B'`, `'echo A >f 2>&1 &&
 * echo B'`, `'echo A &> f && echo B'`, `'echo A 1>&2 && echo B'`, all in the
 * PR body): `N>&M`/`>&M`/`<&M` (an fd-duplication target) and `&>`/`&>>`
 * (bash's redirect-both form) are single redirection tokens, never a
 * background operator or half of `&&` -- the following `&&` still gates on
 * the command BEFORE the redirection, not split by it. Detected the same
 * way a heredoc delimiter already is elsewhere in this file: by the RAW
 * source characters immediately before/after `text[i]`, which segment
 * splitting can read directly without a separate quote/comment-aware pass
 * (this scan only ever runs after {@link lexRegions} has already resolved
 * quotes, comments, and substitutions, so no quoted `&` reaches here).
 *
 * @param {string} text
 * @param {number} i
 * @returns {boolean}
 */
function isLiveSeparator(text, i) {
	const ch = text[i];
	if (!SEGMENT_SEPARATOR.test(ch)) return false;
	if (
		ch === "&" &&
		(text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">")
	)
		return false;
	return true;
}

/**
 * Characters a backslash escapes INSIDE a double-quoted span (bash: every
 * other backslash there is literal).
 */
const DOUBLE_QUOTE_ESCAPABLE = new Set(['"', "\\", "$", "`"]);

/**
 * Parse a `<<`/`<<-` heredoc operator's delimiter, starting just after the
 * two `<` characters. A delimiter is "quoted" -- meaning bash performs NO
 * expansion in the body -- if any part of it is single-quoted,
 * double-quoted, or backslash-escaped (`<<'EOF'`, `<<"EOF"`, `<<\EOF`,
 * `<<EO'F'` all qualify). An empty delimiter (malformed `<<`) is reported
 * as `null` so the caller treats the `<<` as ordinary text instead of
 * starting a heredoc.
 *
 * @param {string} text
 * @param {number} start index just after "<<"
 * @returns {{ delimiter: string | null; stripTabs: boolean; quoted: boolean; end: number }}
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
	let quoted = false;
	while (i < text.length && !WORD_BREAK.test(text[i])) {
		const ch = text[i];
		if (ch === "'" || ch === '"') {
			quoted = true;
			i++;
			while (i < text.length && text[i] !== ch) {
				delimiter += text[i];
				i++;
			}
			if (text[i] === ch) i++;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			quoted = true;
			delimiter += text[i + 1];
			i += 2;
			continue;
		}
		delimiter += ch;
		i++;
	}
	return { delimiter: delimiter || null, stripTabs, quoted, end: i };
}

/**
 * Scan an UNQUOTED-delimiter heredoc body for the only two things bash
 * still executes inside one: `$( … )` and backtick command substitution.
 * Quotes and `#` are LITERAL here (verified against real bash --
 * `cat <<EOF` / `'$(git stash)'` / `EOF` and `# $(git stash)` on a body
 * line both run), so this scan deliberately does NOT track quote or
 * comment state; a backslash still escapes the next character.
 *
 * @param {string} body
 * @param {string[]} out flat sink for every substitution body found
 */
function scanHeredocBodyForSubstitutions(body, out) {
	/** @type {string[]} */
	const found = [];
	let i = 0;
	while (i < body.length) {
		const ch = body[i];
		if (ch === "\\" && i + 1 < body.length) {
			i += 2;
			continue;
		}
		if (ch === "$" && body[i + 1] === "(") {
			/** @type {string[]} */
			const spanFound = [];
			const span = lexRegions(body, i + 2, ")", spanFound);
			if (!span.closed) {
				out.push(...found);
				return;
			}
			found.push(...spanFound);
			found.push(span.retained);
			i = span.end;
			continue;
		}
		if (ch === "`") {
			/** @type {string[]} */
			const spanFound = [];
			const span = lexRegions(body, i + 1, "`", spanFound);
			if (!span.closed) {
				out.push(...found);
				return;
			}
			found.push(...spanFound);
			found.push(span.retained);
			i = span.end;
			continue;
		}
		i++;
	}
	out.push(...found);
}

/**
 * Consume one heredoc body, starting just after the newline that triggered
 * it, and DROP it: body lines are never tokenized as commands (a PR
 * description, an issue comment, a file written through `cat <<'EOF' … EOF`
 * is data, not a command line). A body whose delimiter was UNQUOTED is
 * first handed to {@link scanHeredocBodyForSubstitutions}, because bash
 * does expand `$( )`/backticks there.
 *
 * The delimiter line is matched with `<<-`'s leading tabs stripped and with
 * a trailing `\r` tolerated: a CRLF command text whose terminator never
 * matches makes the body run to end-of-text and silently swallows every
 * later command, which is a false ALLOW -- the one direction this guard
 * must never fail in.
 *
 * @param {string} text
 * @param {number} start
 * @param {{ delimiter: string; stripTabs: boolean; quoted: boolean }} heredoc
 * @param {string[]} out
 * @returns {number} index just past the delimiter line's newline (or EOF)
 */
function consumeHeredocBody(text, start, heredoc, out) {
	let i = start;
	while (i <= text.length) {
		const nl = text.indexOf("\n", i);
		const lineEnd = nl === -1 ? text.length : nl;
		let line = text.slice(i, lineEnd);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (heredoc.stripTabs) line = line.replace(/^\t+/, "");
		if (line === heredoc.delimiter) {
			if (!heredoc.quoted)
				scanHeredocBodyForSubstitutions(text.slice(start, i), out);
			return nl === -1 ? lineEnd : lineEnd + 1;
		}
		if (nl === -1) break;
		i = lineEnd + 1;
	}
	if (!heredoc.quoted) scanHeredocBodyForSubstitutions(text.slice(start), out);
	return text.length;
}

/**
 * THE region pass. Walks `text` from `start` until `closer` (`")"` for a
 * `$( … )` body, `` "`" `` for a backtick body, or `null` for end-of-text),
 * returning the text left once every inert region is subtracted, and
 * pushing every command-substitution body it finds -- at any depth, since
 * it recurses into itself to find a nested span's extent -- into `out`.
 *
 * Because the SAME pass decides span extents and consumes heredoc bodies,
 * a `)` or a backtick inside a heredoc body can never close an enclosing
 * span (#2699 review round 2's V1). That is a property of the shape, not a
 * case that was remembered.
 *
 * Inside a `$( … )` body the pass also walks command positions (`mode`),
 * because a `case` clause's pattern `)` is not the body's closing paren and
 * only a `case` at a command position opens a clause. The positions are
 * admitted, not guessed: the body start, a separator, `(`, a `case` pattern's
 * `)`, a reserved word that starts a list ({@link COMMAND_KEYWORDS}). A word read
 * at a command position that is not one of those is the command name, and
 * everything after it is an argument. A `case` word where the walk does not
 * know (the headers in {@link UNMODELLED_HEADS}, `((`, `$((`, `case(`) is left
 * as {@link UNSCANNABLE_CASE}, which {@link findDeny} refuses (#4060).
 *
 * Subtracted: comments, heredoc bodies, and substitution bodies (the last
 * are re-scanned via `out`, not discarded; each leaves one
 * {@link SUBSTITUTION_MARK} behind so a word that held one is still known to
 * be incomplete, #3988). Retained: everything else,
 * including single- and double-quoted spans with their quote characters,
 * so word formation downstream is unaffected.
 *
 * @param {string} text
 * @param {number} start
 * @param {")"|"`"|null} closer
 * @param {string[]} out
 * @returns {{ end: number; retained: string; closed: boolean }}
 */
function lexRegions(text, start, closer, out) {
	let retained = "";
	let i = start;
	/** @type {"single"|"double"|"ansi"|null} */
	let quote = null;
	/** Nested plain `(`/`)` inside a `$( … )` body, so `$(( … ))` closes correctly. */
	let parenDepth = 0;
	/**
	 * Open `case` clauses inside a `$( … )` body, innermost last (#4060). A
	 * pattern's `)` ends the pattern, not the body, so the states are:
	 * `subject` (`case` seen at a command position, up to its `in`),
	 * `patternFirst` (after `in` or `;;`/`;&`/`;;&`: the first word is `esac`,
	 * which pops the frame, or a pattern), `pattern` (up to the pattern's `)`)
	 * and `body` (up to `;;`). The last clause may end with `esac` and no
	 * `;;`; its `body` frame is left behind, inert, because only a pattern
	 * state changes where a `)` goes.
	 * @type {Array<"subject"|"patternFirst"|"pattern"|"body">}
	 */
	const cases = [];
	/**
	 * Where the next word sits in a `$( … )` body (#4060). `start`: a command
	 * position, where a reserved word is one (`case`, `esac`, the openers in
	 * {@link COMMAND_KEYWORDS}). `args`: a command name was read, so every later
	 * word is an argument and a keyword-shaped one is plain text (`: do`,
	 * `echo case`). `cond`: inside `[[ … ]]`, where `case` is a plain word and
	 * a `(` opens no command. Any word that is not a recognised opener ends
	 * `start`, assignments and redirections included (bash reads `x=1 case` and
	 * `>f case` with `case` as the command name).
	 * @type {"start"|"args"|"cond"}
	 */
	let mode = "start";
	/** The opener read last at `start`, so `-p`/`--` after `time` keep it. */
	let prevOpener = "";
	/**
	 * `parenDepth` at a header the lexer does not model, or `null`: `for`,
	 * `select`, `coproc`, `function`, `((` and `$((`. A `case` word while held
	 * is unclassifiable and fails closed; a separator at or below the depth ends
	 * the hold (`for ((;;))` keeps its inner `;` out of it).
	 * @type {number | null}
	 */
	let holdDepth = closer === ")" && text[start] === "(" ? 0 : null;
	/** `retained.length` just past each open plain `(`, to tell `f()` from `(cmd)` at its `)`. */
	/** @type {number[]} */
	const parenOpens = [];
	const startCommand = () => {
		mode = "start";
		prevOpener = "";
	};
	let atWordStart = true;
	/** Heredoc markers seen on the current line, consumed in order at its newline. */
	/** @type {Array<{ delimiter: string; stripTabs: boolean; quoted: boolean }>} */
	let pendingHeredocs = [];
	while (i < text.length) {
		const ch = text[i];
		if (quote === "single") {
			retained += ch;
			if (ch === "'") quote = null;
			i++;
			continue;
		}
		if (quote === "ansi") {
			// `$'…'`: a backslash escapes the next character, so `\'` stays inside.
			const taken = ch === "\\" ? text.slice(i, i + 2) : ch;
			retained += taken;
			if (ch === "'") quote = null;
			i += taken.length;
			continue;
		}
		if (quote === "double") {
			if (ch === "\\" && text[i + 1] === "\n") {
				i += 2;
				continue;
			}
			if (ch === "\\" && DOUBLE_QUOTE_ESCAPABLE.has(text[i + 1])) {
				retained += ch + text[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') {
				quote = null;
				retained += ch;
				i++;
				continue;
			}
			if (ch === "$" && text[i + 1] === "(") {
				const span = lexRegions(text, i + 2, ")", out);
				out.push(span.retained);
				retained += SUBSTITUTION_MARK;
				i = span.end;
				continue;
			}
			if (ch === "`") {
				i = collectBacktickSpan(text, i, out);
				retained += SUBSTITUTION_MARK;
				continue;
			}
			retained += ch;
			i++;
			continue;
		}
		if (closer === ")") {
			const open = cases.length - 1;
			const frame = cases[open];
			if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") {
				if (holdDepth === null || parenDepth <= holdDepth) {
					holdDepth = null;
					if (mode !== "cond") startCommand();
				}
			} else if (
				atWordStart &&
				ch !== "#" &&
				!/[\s;&|()<>]/.test(ch) &&
				!(ch === "\\" && text[i + 1] === "\n")
			) {
				WORD_RUN.lastIndex = i;
				const word = WORD_RUN.exec(text)?.[0] ?? "";
				const next = text[i + word.length];
				if (frame === "subject") {
					if (word === "in") cases[open] = "patternFirst";
				} else if (frame === "patternFirst") {
					if (word === "esac") {
						cases.pop();
						mode = "args";
					} else cases[open] = "pattern";
				} else if (frame === "pattern") {
					// A pattern word: no keyword is read here.
				} else if (holdDepth !== null) {
					if (word === "case") out.push(UNSCANNABLE_CASE);
				} else if (mode === "cond") {
					if (word === "]]") mode = "args";
				} else if (mode === "start") {
					if (UNMODELLED_HEADS.has(word)) holdDepth = parenDepth;
					else if (
						COMMAND_KEYWORDS.has(word) ||
						word === "time" ||
						((word === "-p" || word === "--") &&
							(prevOpener === "time" || prevOpener === "-p"))
					)
						prevOpener = word;
					else if (word === "case") {
						// Only `case` + whitespace is a clause bash reads; `case(`,
						// `case;` and the like are syntax errors or forms not modelled.
						if (next !== undefined && /\s/.test(next)) {
							cases.push("subject");
							mode = "args";
						} else out.push(UNSCANNABLE_CASE);
					} else if (word === "[[") mode = "cond";
					else mode = "args";
				}
			}
			if (
				(frame === "patternFirst" || frame === "pattern") &&
				(ch === ")" || ch === "(")
			) {
				if (ch === ")") {
					cases[open] = "body";
					startCommand();
				}
				retained += ch;
				atWordStart = true;
				i++;
				continue;
			}
			if (frame === "body" && ch === ";" && /[;&]/.test(text[i + 1])) {
				const end = text.startsWith(";;&", i) ? i + 3 : i + 2;
				cases[open] = "patternFirst";
				retained += text.slice(i, end);
				atWordStart = true;
				i = end;
				continue;
			}
		}
		if (closer === ")" && ch === ")") {
			if (parenDepth === 0) return { end: i + 1, retained, closed: true };
			parenDepth--;
			// `f()` is followed by a compound command (a command position);
			// `(cmd)` and `<(cmd)` are followed by a separator or a redirection.
			if (holdDepth === null && mode !== "cond") {
				if (retained.slice(parenOpens.pop() ?? 0).trim() === "") startCommand();
				else mode = "args";
			} else parenOpens.pop();
			retained += ch;
			atWordStart = true;
			i++;
			continue;
		}
		if (closer === ")" && ch === "(") {
			// `((` at a command position is an arithmetic command, or two
			// subshells when the arithmetic reading fails: not modelled.
			if (holdDepth === null && mode === "start" && text[i + 1] === "(")
				holdDepth = parenDepth;
			parenDepth++;
			retained += ch;
			parenOpens.push(retained.length);
			if (holdDepth === null && mode !== "cond") startCommand();
			atWordStart = true;
			i++;
			continue;
		}
		if (closer === "`" && ch === "`")
			return { end: i + 1, retained, closed: true };
		if (ch === "\\" && text[i + 1] === "\n") {
			i += 2;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			// An escaped character is never special -- and the backslash is
			// KEPT here so a later `\$(`/`\#` is not re-read as live syntax;
			// splitWords drops it when forming the word.
			retained += ch + text[i + 1];
			atWordStart = false;
			i += 2;
			continue;
		}
		if (ch === "#" && atWordStart) {
			const nl = text.indexOf("\n", i);
			i = nl === -1 ? text.length : nl;
			continue;
		}
		if (ch === "<" && text[i + 1] === "<" && text[i + 2] === "<") {
			// A here-string is a redirection with one word of input, not a
			// heredoc marker. Consume all three '<' characters so the third
			// one cannot be re-read as the start of a phantom delimiter.
			retained += "<<<";
			atWordStart = false;
			i += 3;
			continue;
		}
		if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
			const marker = parseHeredocMarker(text, i + 2);
			if (marker.delimiter !== null) {
				pendingHeredocs.push({
					delimiter: marker.delimiter,
					stripTabs: marker.stripTabs,
					quoted: marker.quoted,
				});
				retained += text.slice(i, marker.end);
				atWordStart = false;
				i = marker.end;
				continue;
			}
		}
		if (ch === "\n" && pendingHeredocs.length > 0) {
			retained += "\n";
			let pos = i + 1;
			for (const heredoc of pendingHeredocs)
				pos = consumeHeredocBody(text, pos, heredoc, out);
			pendingHeredocs = [];
			atWordStart = true;
			i = pos;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			const span = lexRegions(text, i + 2, ")", out);
			out.push(span.retained);
			retained += SUBSTITUTION_MARK;
			atWordStart = false;
			i = span.end;
			continue;
		}
		if (ch === "`") {
			i = collectBacktickSpan(text, i, out);
			retained += SUBSTITUTION_MARK;
			atWordStart = false;
			continue;
		}
		if (ch === "$" && text[i + 1] === "'") {
			quote = "ansi";
			retained += "$'";
			atWordStart = false;
			i += 2;
			continue;
		}
		if (ch === "'") {
			quote = "single";
			retained += ch;
			atWordStart = false;
			i++;
			continue;
		}
		if (ch === '"') {
			quote = "double";
			retained += ch;
			atWordStart = false;
			i++;
			continue;
		}
		retained += ch;
		atWordStart = WORD_BREAK.test(ch);
		i++;
	}
	return { end: i, retained, closed: closer === null };
}

/**
 * Collect one backtick span that starts at `text[open]`, pushing its body
 * into `out` and returning the index just past its closing backtick.
 *
 * The extent comes from {@link lexRegions} (heredoc- and quote-aware, so a
 * heredoc body inside the span cannot close it early). The one thing a
 * backtick span needs on top: bash requires a NESTED backtick span to be
 * written `` \` ``, and it does execute it -- so when the body carries an
 * escaped backtick, the escape is undone and the body re-lexed, which
 * surfaces the inner substitution. Only `` \` `` is undone; `\$` and `\\`
 * are left alone, since undoing those would invent substitutions bash
 * treats as literal.
 *
 * @param {string} text
 * @param {number} open index of the opening backtick
 * @param {string[]} out
 * @returns {number}
 */
function collectBacktickSpan(text, open, out) {
	const span = lexRegions(text, open + 1, "`", out);
	if (span.retained.includes("\\`")) {
		const unescaped = span.retained.replace(/\\`/g, "`");
		const nested = lexRegions(unescaped, 0, null, out);
		out.push(nested.retained);
	} else {
		out.push(span.retained);
	}
	return span.end;
}

/**
 * Every region of `commandText` that bash can EXECUTE, as raw text ready
 * for {@link splitSegments}. Index 0 is the top level; the rest are
 * command-substitution bodies (from anywhere, including inside an
 * unquoted-delimiter heredoc body), already flattened, already stripped of
 * their own inert regions.
 *
 * @param {string} commandText
 * @returns {string[]}
 */
export function scannableRegions(commandText) {
	/** @type {string[]} */
	const substitutions = [];
	const { retained } = lexRegions(commandText, 0, null, substitutions);
	return [retained, ...substitutions];
}

// `splitWords` returns quote-stripped strings. For a word holding a live
// expansion it also keeps where each one sits, so coproc label validation can
// distinguish actual expansions from literal characters that happen to look
// like expansion syntax after quote removal.
const WORD_EXPANSIONS = Symbol("wordExpansions");

// Where each word holds an UNQUOTED, unescaped `>` -- a redirection operator
// (#4348). `splitWords` strips quotes, so `echo ">/tmp/x"` and `echo
// >/tmp/x` read the same afterwards; this sparse per-word list of buffer
// offsets is the only record of which one it was.
const WORD_REDIRECTS = Symbol("wordRedirects");

/**
 * Return the end offset for a live parameter, command or arithmetic
 * expansion (`$[…]` is the old arithmetic spelling) beginning at `start`,
 * or `start` when the dollar is literal.
 *
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function runtimeExpansionEnd(text, start) {
	const next = text[start + 1];
	const close = { "{": "}", "(": ")", "[": "]" }[next];
	if (close) {
		let depth = 1;
		let quote = null;
		for (let i = start + 2; i < text.length; i++) {
			const ch = text[i];
			if (ch === "\\") {
				i++;
				continue;
			}
			if (quote !== null) {
				if (ch === quote) quote = null;
				continue;
			}
			if (ch === "'" || ch === '"') {
				quote = ch;
				continue;
			}
			if (ch === next) depth++;
			if (ch === close && --depth === 0) return i + 1;
		}
		return text.length;
	}
	if (/[A-Za-z_]/.test(next ?? "")) {
		let end = start + 2;
		while (/[A-Za-z0-9_]/.test(text[end] ?? "")) end++;
		return end;
	}
	if (/[0-9@*#?$!-]/.test(next ?? "")) return start + 2;
	return start;
}

/**
 * Classify the leading character possibilities of a runtime expansion.
 *
 * @param {string} text
 * @param {number} start
 * @returns {"dynamic"|"numeric"|"nullableNumeric"}
 */
function runtimeExpansionKind(text, start) {
	const next = text[start + 1];
	if (next === "!") return "nullableNumeric";
	return (next === "(" && text[start + 2] === "(") || /[?#$[]/.test(next ?? "")
		? "numeric"
		: "dynamic";
}

/**
 * Whether a coproc label can form a Bash identifier, given where its live
 * expansions sit. Dynamic expansions may supply a valid first character;
 * numeric expansions cannot start an identifier but can extend one. With no
 * expansion the label itself must be an identifier.
 *
 * @param {string} label
 * @param {Array<{ kind: "dynamic"|"numeric"|"nullableNumeric"; start: number; end: number }>} expansions
 * @returns {boolean}
 */
function canFormCoprocIdentifier(label, expansions) {
	const parts = [];
	let at = 0;
	for (const expansion of expansions) {
		parts.push(label.slice(at, expansion.start), expansion);
		at = expansion.end;
	}
	parts.push(label.slice(at));
	let hasIdentifierStart = false;
	for (const part of parts) {
		if (typeof part !== "string") {
			if (part.kind === "numeric") {
				if (!hasIdentifierStart) return false;
			} else if (part.kind === "dynamic") {
				hasIdentifierStart = true;
			}
			// `nullableNumeric` is `$!`, which may be empty when there is no
			// recent background process, so a following literal can start it.
			continue;
		}
		for (const ch of part) {
			if (!hasIdentifierStart) {
				if (!/[A-Za-z_]/.test(ch)) return false;
				hasIdentifierStart = true;
			} else if (!/[A-Za-z0-9_]/.test(ch)) {
				return false;
			}
		}
	}
	return hasIdentifierStart;
}

/**
 * Split one scannable region into simple-command segments -- a one-line map
 * over {@link splitSegmentsWithSeparators} (#3526 review S2: the two lexer
 * bodies were near-duplicates, 0 diffs measured over the full 1,850-region
 * transcript corpus, and after `checkUngated` this function has no
 * production caller left -- {@link findDeny} uses the separator-tagged
 * version -- so the 5 redirection tests pinning `splitSegments`'s own
 * output now exercise the SAME lexer the hook actually runs, not a stale
 * duplicate of it).
 *
 * @param {string} region
 * @returns {string[]}
 */
export function splitSegments(region) {
	return splitSegmentsWithSeparators(region).map((s) => s.text);
}

/**
 * Split one segment into words: whitespace-separated outside quotes. A
 * quoted span fuses into the surrounding word rather than splitting on
 * internal whitespace, and its quote characters are stripped -- so
 * `echo "git stash"` yields the two words `echo` and `git stash` (one
 * opaque argument), while `git 'stash'` correctly yields `git` and
 * `stash`. Outside quotes a backslash escapes the next character and is
 * dropped, matching bash -- `\g\i\t stash` really does run `git stash`.
 *
 * @param {string} segment
 * @returns {string[]}
 */
export function splitWords(segment) {
	/** @type {string[]} */
	const words = [];
	// Sparse: an entry only for a word that holds a live expansion.
	const wordExpansions = [];
	const wordRedirects = [];
	let expansions = null;
	let redirects = null;
	let buf = "";
	/** @type {"single"|"double"|null} */
	let quote = null;
	let started = false;
	let i = 0;
	const addExpansion = (kind, text) => {
		(expansions ??= []).push({
			kind,
			start: buf.length,
			end: buf.length + text.length,
		});
		buf += text;
		started = true;
	};
	// Consume the live `$…` or backtick expansion at `i`, if there is one.
	const takeExpansion = () => {
		let end;
		if (segment[i] === "`") {
			const close = segment.indexOf("`", i + 1);
			end = close < 0 ? segment.length : close + 1;
		} else {
			end = runtimeExpansionEnd(segment, i);
			if (end === i) return false;
		}
		addExpansion(
			segment[i] === "`" ? "dynamic" : runtimeExpansionKind(segment, i),
			segment.slice(i, end),
		);
		i = end;
		return true;
	};
	const flush = () => {
		if (started) {
			if (expansions) wordExpansions[words.length] = expansions;
			if (redirects) wordRedirects[words.length] = redirects;
			words.push(buf);
		}
		buf = "";
		expansions = null;
		redirects = null;
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
			if (ch === SUBSTITUTION_MARK) {
				// Output this scan cannot know (findDeny's unknown reading). Kept
				// in the word, so no rule word matches it and no path resolves
				// through it; recorded as a dynamic expansion, so a coproc label
				// holding one can still form a name (#3949, #3997).
				addExpansion("dynamic", ch);
				i++;
				continue;
			}
			if (ch === "\\" && DOUBLE_QUOTE_ESCAPABLE.has(segment[i + 1])) {
				buf += segment[i + 1];
				i += 2;
				continue;
			}
			if (ch === '"') {
				quote = null;
				i++;
				continue;
			}
			if ((ch === "$" || ch === "`") && takeExpansion()) continue;
			buf += ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < segment.length) {
			started = true;
			buf += segment[i + 1];
			i += 2;
			continue;
		}
		if (ch === SUBSTITUTION_MARK) {
			// The same opaque, dynamic piece as in a double-quoted span above.
			addExpansion("dynamic", ch);
			i++;
			continue;
		}
		if (ch === "$" && segment[i + 1] === "'") {
			// ANSI-C quoting. Its escapes are not decoded, so a span holding
			// one counts as a live expansion: it could spell anything.
			let end = i + 2;
			while (end < segment.length && segment[end] !== "'") {
				end += segment[end] === "\\" ? 2 : 1;
			}
			const content = segment.slice(i + 2, end);
			if (content.includes("\\")) addExpansion("dynamic", content);
			else buf += content;
			started = true;
			i = end + 1;
			continue;
		}
		if (ch === "$" && segment[i + 1] === '"') {
			quote = "double";
			started = true;
			i += 2;
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
		if ((ch === "$" || ch === "`") && takeExpansion()) continue;
		started = true;
		if (ch === ">") (redirects ??= []).push(buf.length);
		buf += ch;
		i++;
	}
	flush();
	if (wordExpansions.length > 0) {
		Object.defineProperty(words, WORD_EXPANSIONS, { value: wordExpansions });
	}
	if (wordRedirects.length > 0) {
		Object.defineProperty(words, WORD_REDIRECTS, { value: wordRedirects });
	}
	return words;
}

/**
 * Whether a segment contains a live stdin redirection. Quote handling belongs
 * here with the shared shell lexer so consumers do not reinterpret folded
 * words such as `bash<<EOF` from quoted prose.
 *
 * @param {string} segment
 * @returns {boolean}
 */
export function hasLiveStdinRedirect(segment) {
	/** @type {"single" | "double" | undefined} */
	let quote;
	for (let index = 0; index < segment.length; index++) {
		const char = segment[index];
		// A single-quoted span escapes nothing: `'x\'` closes at the `'`, so the
		// redirection after it is live (#4595 Greptile r4307901268).
		if (quote === "single") {
			if (char === "'") quote = undefined;
			continue;
		}
		if (char === "\\") {
			index++;
			continue;
		}
		if (quote === "double") {
			if (char === '"') quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char === "'" ? "single" : "double";
			continue;
		}
		if (char === "<" && segment[index + 1] === "<") return true;
	}
	return false;
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

/** Global git flags that consume a SEPARATE following token as their value
 *  (#3787, each probed against git 2.53: `--exec-path` takes its value only
 *  as `=`, and `--super-prefix` is rejected as an unknown option). */
const GIT_TWO_TOKEN_FLAGS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--attr-source",
]);

/**
 * Does `dir` look like a git WORKTREE checkout -- checked the same way git
 * itself tells a linked worktree apart from the main repository: only a
 * linked worktree's top-level `.git` is a FILE whose content starts with
 * `gitdir:` (the main checkout's `.git` is a directory; an ordinary
 * directory that happens to share a name has no `.git` at all). Never
 * throws: a missing `.git`, or `readFileSync` on it failing for ANY reason
 * -- ENOENT, or EISDIR (reading a directory as a file, exactly what the
 * MAIN checkout's own `.git` is) -- both land in the one catch below, so
 * it is simply "not a worktree" -- acceptance #3, a path that is not a
 * worktree is left to git, never a false deny. A separate `lstatSync`
 * "is this a file?" pre-check was tried and DELETED: `readFileSync`
 * already throws EISDIR for exactly the directory case that pre-check
 * existed to catch (measured directly: `fs.readFileSync` on a real
 * directory throws `EISDIR`), so the pre-check never changed the verdict
 * and mutating it out left every test in this file green.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function looksLikeGitWorktree(dir) {
	try {
		return readFileSync(join(dir, ".git"), "utf8")
			.trimStart()
			.startsWith("gitdir:");
	} catch {
		return false;
	}
}

/**
 * Does `worktreeDir` contain a `node_modules` entry that is a SYMLINK whose
 * target resolves OUTSIDE `worktreeDir` -- the #3173 hazard (twice on
 * 2026-09-16, the #2704 class): the fixer playbook's own speed convention
 * (`ln -s <main checkout>/node_modules node_modules`) means a plain
 * `git worktree remove` on that tree makes git follow the link and empty
 * the SHARED install it points at, not just this worktree's own copy. A
 * real `node_modules` DIRECTORY, a missing entry, and a symlink that stays
 * INSIDE the worktree are all fine and return false -- deliberately
 * narrower than "any symlink", since only an OUTSIDE target can empty
 * something other than this worktree.
 *
 * `readlinkSync` alone decides "is this even a symlink" -- no separate
 * `lstatSync` type check, the same deletion as {@link looksLikeGitWorktree}'s:
 * measured directly, `readlinkSync` throws ENOENT for a missing entry and
 * EINVAL for a REAL directory or file, both caught below, so a pre-check
 * never changed the verdict and mutating it out left every test green. Its
 * raw link text proves that the entry is a symlink, then `realpathSync`
 * follows the complete chain before the containment check. An unreadable or
 * dangling target fails closed: this classifier protects destructive callers,
 * so uncertainty is the outside-link verdict rather than an allow.
 *
 * @param {string} worktreeDir
 * @returns {boolean}
 */
function hasNodeModulesSymlinkOutside(worktreeDir) {
	const nodeModulesPath = join(worktreeDir, "node_modules");
	try {
		readlinkSync(nodeModulesPath);
	} catch {
		return false;
	}
	let resolvedTarget;
	try {
		resolvedTarget = realpathSync(nodeModulesPath);
	} catch {
		return true;
	}
	const rel = relative(worktreeDir, resolvedTarget);
	return rel === ".." || rel.startsWith(`..${SEP}`) || isAbsolute(rel);
}

/**
 * Walk past a `git` invocation's global options (the {@link
 * GIT_TWO_TOKEN_FLAGS} take a separate value; every other `-x`/`--x` global
 * option is assumed to take none) and return the index of the subcommand
 * word. Shared by
 * {@link classifyGit} (deciding stash/reset/worktree/clone) and
 * {@link classifyCheckOrWrite} (deciding commit/push for #3471), so the
 * global-option skip lives in exactly one place.
 *
 * @param {string[]} args
 * @returns {number}
 */
function gitSubcommandIndex(args) {
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
	return i;
}

/** `/tmp` -- the tmpfs root #3526's `tmpCheckout` rule keeps scratch checkouts
 *  and mktemp directories off of. A literal string, not `os.tmpdir()`: the
 *  rule is specifically about the FILESYSTEM PATH `/tmp` (tmpfs on the
 *  maintainer host), not "wherever this process's own temp dir happens to
 *  be" -- those coincide when TMPDIR is unset, which is the common case. */
const TMP_ROOT = "/tmp";

/**
 * Does `targetDir` (already resolved to an absolute path) sit AT or UNDER
 * `TMP_ROOT` -- the same relative-path shape as {@link
 * hasNodeModulesSymlinkOutside}'s outside-check, inverted: here "under" is
 * the hazard, not "outside".
 *
 * @param {string} absoluteDir
 * @param {string} [root] defaults to {@link TMP_ROOT}; #4348 asks the same question of the harness's own `/tmp/claude-<uid>`
 * @returns {boolean}
 */
function isUnderTmpRoot(absoluteDir, root = TMP_ROOT) {
	const rel = relative(root, absoluteDir);
	return (
		rel === "" ||
		(!rel.startsWith(`..${SEP}`) && rel !== ".." && !isAbsolute(rel))
	);
}

/**
 * {@link isUnderTmpRoot} for the `tmpCheckout` destinations and the `tmpWrite`
 * targets, by either spelling of the root. {@link physicalPath} puts a path where the kernel does,
 * so where `/tmp` is a symlink (macOS: `/tmp` -> `private/tmp`) a missing leaf
 * `/tmp/new` resolves to `/private/tmp/new`, which the literal root misses;
 * master kept the lexical `/tmp/new` there and denied it (#4060 r2 F3,
 * r3 F7). This also reads macOS's `/private/tmp/x` as `/tmp`.
 *
 * @param {string} absoluteDir
 * @returns {boolean}
 */
function isUnderTmpCheckoutRoot(absoluteDir) {
	return (
		isUnderTmpRoot(absoluteDir) ||
		isUnderTmpRoot(absoluteDir, physicalPath(TMP_ROOT, TMP_ROOT))
	);
}

/** Bounds {@link expandShellWord}'s indirection loop -- generous for the real
 *  shapes this repo's own sessions use (`S=...; W=$S/wt` is one hop) while
 *  still terminating a pathological or self-referential chain (`A=$A`). */
const VAR_PREFIX_EXPANSION_CAP = 8;

/**
 * The placeholder {@link lexRegions} leaves where it subtracted a `$( … )` or
 * backtick span. A private-use character, not `$()`, so it never reads as a
 * segment separator or as shell syntax downstream. The span's body is scanned
 * as its own region. The mark stands for output this scan cannot know:
 * {@link findDeny} reads a command once with the mark as opaque word text
 * (so `$(pwd)/x` is not the WRONG path `/x`, and {@link expandShellWord}
 * refuses to resolve it, #3988) and once with the marks removed (#3997).
 */
const SUBSTITUTION_MARK = String.fromCharCode(0xe000);

/**
 * The value `$NAME` expands to, or `undefined` when this static scan cannot
 * know it. `PWD` is the command's effective cwd. The command's variables
 * (`env`: the `export` and standalone `VAR=val` segments carried forward in
 * `sharedEnv`, #2699 review round 2 F2, plus the inline prefix only for
 * GNU mktemp's own default `$TMPDIR`; never for a word bash expanded, #3997 F4,
 * #4057) win; then THIS hook's `process.env`,
 * because the guard runs as a real child process inheriting the shell's
 * ambient environment (measured: a bare `mktemp -d` with an ambient,
 * non-command-text `TMPDIR` pointed off /tmp must allow). `TMPDIR`/`TMP`/
 * `TEMP` default to `TMP_ROOT` when unset everywhere -- the real default
 * `os.tmpdir()`, bash and mktemp all fall back to.
 *
 * @param {string} name
 * @param {string | null | undefined} cwd
 * @param {Record<string, string>} env
 * @returns {string | undefined}
 */
function lookupShellVariable(name, cwd, env) {
	if (name === "PWD")
		return cwd === undefined ? process.cwd() : (cwd ?? undefined);
	if (name === "_" || name === "OLDPWD") return undefined;
	const value = env[name] ?? process.env[name];
	return value ?? (TEMP_DIR_VARS.includes(name) ? TMP_ROOT : undefined);
}

/**
 * THE path-word expander (#3988): redo, statically, what bash does to a WORD
 * before the program sees argv, so every rule that tests a path argument
 * (`git worktree remove`/`add`, `git clone`, `mktemp`, `node <file>`, `git -C`,
 * `cd`) judges the directory bash would hand it, not the spelling. Handled: a
 * leading `~` or `~/…` (from `HOME`, the command's variables first, then this
 * hook's ambient env); every `$NAME`/`${NAME}` reference anywhere in the
 * word, chased through indirected assignments (bounded by
 * {@link VAR_PREFIX_EXPANSION_CAP}: `S=/tmp/…/scratchpad; W=$S/wt; git
 * worktree add $W` is the ACTUAL shape of all 14 historical `/tmp`
 * worktree-adds in the transcript corpus, #3526 review F1), with a tilde
 * picked up mid-chain (`S=~/.local/…`) expanded too, including one the last
 * hop surfaces (#3997 F5). A variable whose value is a bare name is that
 * literal word, as in bash (`A=B; … $A` is the relative path `B`).
 *
 * `text` is always the best-effort expansion, with whatever could not be
 * resolved left in place -- a rule whose hazard is a false ALLOW of a resolvable
 * path (tmpCheckout) reads `text` and treats the leftover as relative,
 * exactly as before. `reason` is set when part of the word is NOT statically
 * knowable: a `$( … )`/backtick span ({@link SUBSTITUTION_MARK}), a `~user`/
 * `~+`/`~-` tilde, a variable with no known value (or an unset `HOME`), a
 * `${NAME:-x}`-style or `$1`/`$$` expansion (a self-referential or
 * over-long chain ends here too: it is still a `$` reference once the hop cap
 * is spent), or a glob character. A rule whose hazard is a false ALLOW of a
 * destructive command (`git worktree remove`) fails closed on it.
 *
 * Quote context is gone by the time a word reaches here ({@link splitWords}
 * strips quotes), so a single-quoted literal `'$HOME'` is expanded like an
 * unquoted one -- the conservative direction for both kinds of rule.
 *
 * @param {string} word
 * @param {string | null | undefined} cwd `null`: statically unknown (after an unresolvable `cd`)
 * @param {Record<string, string>} env see {@link lookupShellVariable}
 * @returns {{ text: string; reason?: string }}
 */
function expandShellWord(word, cwd, env) {
	/** @type {string | undefined} */
	let reason;
	let text = word;
	for (let hop = 0; hop <= VAR_PREFIX_EXPANSION_CAP; hop++) {
		if (text === "~" || text.startsWith("~/")) {
			const home = env.HOME ?? process.env.HOME;
			if (home === undefined) reason ??= "HOME is not set";
			else text = home + text.slice(1);
		} else if (/^~[^/]/.test(text)) {
			reason ??= "a ~user tilde";
		}
		if (hop === VAR_PREFIX_EXPANSION_CAP) break;
		let changed = false;
		text = text.replace(
			/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
			(reference, braced, bare) => {
				const name = braced ?? bare;
				const value = lookupShellVariable(name, cwd, env);
				if (value === undefined) return reference;
				changed = true;
				return value;
			},
		);
		if (!changed) break;
	}
	if (text.includes(SUBSTITUTION_MARK)) reason ??= "a command substitution";
	if (/[{}]/.test(text)) reason ??= "brace expansion";
	if (text.includes("$")) reason ??= "an unresolved or unsupported $ expansion";
	if (/[*?[]/.test(text)) reason ??= "a glob pattern";
	return reason === undefined ? { text } : { text, reason };
}

/**
 * {@link expandShellWord}, then anchored the way the OS would: a relative
 * result resolves against `cwd` (the command's effective cwd -- a preceding
 * `cd`, `git -C`, else the hook payload's own; `undefined` falls back to this
 * process's cwd, as every caller here always has). `cwd === null` means the
 * effective cwd is itself statically unknown, which makes a RELATIVE result
 * unresolvable (an absolute one is still exact).
 *
 * A path a program hands the kernel is judged where the kernel puts it, so
 * it is resolved PHYSICALLY (#3997 H3): the kernel follows `lnk` before the
 * `..` in `lnk/../wt`, while `path.resolve` (and `fs.realpathSync`, which
 * normalizes first) drops the pair lexically. Measured: `git worktree remove
 * scratch/lnk/../linked` removed the tree `lnk` points at. A target that does
 * not exist yet resolves its nearest existing ancestor physically and keeps
 * the missing tail as written ({@link physicalPath}, #4060). `logical` is
 * bash's own `cd`, which resolves `..` lexically (`cd lnk/.. && pwd` prints
 * the directory holding `lnk`); `cd -P` is the physical mode.
 *
 * @param {string} word
 * @param {string | null | undefined} cwd
 * @param {Record<string, string>} env
 * @param {boolean} [logical]
 * @returns {{ path: string; reason?: string }}
 */
function resolveShellPath(word, cwd, env, logical = false) {
	const { text, reason } = expandShellWord(word, cwd, env);
	const anchor = cwd ?? process.cwd();
	let path = resolve(anchor, text);
	if (reason === undefined && cwd === null && !isAbsolute(text))
		return { path, reason: "a working directory that is not statically known" };
	if (!logical)
		path = physicalPath(isAbsolute(text) ? text : `${anchor}/${text}`, path);
	return reason === undefined ? { path } : { path, reason };
}

/**
 * Where the kernel puts `spelling`: `realpath` of the nearest existing
 * ancestor of the RAW spelling (a `..` after a symlink is the kernel's, so the
 * spelling is never collapsed first), then the missing tail joined lexically.
 * A destination that does not exist yet (`git worktree add tl/new`, `tl` a
 * symlink to /tmp) still lands where its parent really is (#4060). `fallback`
 * is the lexical path, kept when not even the root resolves.
 *
 * @param {string} spelling
 * @param {string} fallback
 * @returns {string}
 */
function physicalPath(spelling, fallback) {
	/** @type {string[]} */
	const tail = [];
	let head = spelling;
	for (;;) {
		try {
			return resolve(realpathSync.native(head), ...tail);
		} catch {
			const parent = dirname(head);
			if (parent === head) return fallback;
			tail.unshift(basename(head));
			head = parent;
		}
	}
}

/** `git worktree add [flags] <path> [<commit-ish>]` flags that consume a
 *  separate following token as their value. */
const WORKTREE_ADD_VALUE_FLAGS = new Set(["-b", "-B", "--reason"]);

/** `git clone [flags] <repository> [<directory>]` flags that consume a
 *  separate following token as their value. Proportionate, matching this
 *  file's other argv-parsing sets: the common two-token forms, not every
 *  clone flag -- an unlisted value-taking flag's value would be
 *  misidentified as a positional, the same documented-blind-spot shape as
 *  {@link RUNNER_PREFIX_WORDS}. */
const CLONE_VALUE_FLAGS = new Set([
	"-b",
	"--branch",
	"-o",
	"--origin",
	"--depth",
	"--shallow-since",
	"--shallow-exclude",
	"--template",
	"--reference",
	"--reference-if-able",
	"--separate-git-dir",
	"--filter",
	"--server-option",
	"--bundle-uri",
	"-j",
	"--jobs",
	"-c",
	"--config",
]);

/**
 * Collect every positional (non-flag) argument, skipping each flag in
 * `valueFlags` together with its separate value token.
 *
 * @param {string[]} args
 * @param {Set<string>} valueFlags
 * @returns {string[]}
 */
function collectPositionals(args, valueFlags) {
	const positionals = [];
	let i = 0;
	while (i < args.length) {
		const a = args[i];
		if (valueFlags.has(a)) {
			i += 2;
			continue;
		}
		if (a.startsWith("-")) {
			i += 1;
			continue;
		}
		positionals.push(a);
		i += 1;
	}
	return positionals;
}

/** The git subcommands whose hooks `--no-verify` and friends skip (#3778). */
const HOOK_SUBCOMMANDS = new Set(["commit", "push", "merge", "rebase"]);

/** Message flags whose SEPARATE next token is text, not a flag -- so a
 *  `git commit -m "--no-verify"` is never read as the flag it quotes. Applies
 *  to `commit` and `merge` only: on `rebase` `-m` takes no value, and no
 *  `push` flag carries message text. */
const MESSAGE_VALUE_FLAGS = new Set(["-m", "-F", "--message", "--file"]);

/** `git commit` short options that take a value (the rest of the bundle, or
 *  the next token), so a bundle such as `-mn` stops being flags at `m`. */
const COMMIT_VALUE_LETTERS = "mFCctuS";

/** `git config` words that remove a key, leaving no trailing value to see
 *  (a SET always has a value after the key). */
const CONFIG_UNSET_WORDS = new Set(["--unset", "--unset-all", "unset"]);

/**
 * Does the env carry a variable the repo's husky hooks honour as an opt-out
 * (#3778)? `HUSKY=0` is husky's own dispatcher (`node_modules/husky/husky`:
 * `[ "${HUSKY-}" = "0" ] && exit 0`); `PI_LENS_SKIP_HOOKS` is tested with
 * `[ -n … ]` in .husky/pre-commit and .husky/pre-push, so any NON-EMPTY value
 * (even `0`) skips. `PI_LENS_PREPUSH_LOCK_SKIP` is deliberately absent: it is
 * the recorded opt-out #3717's own push-blocked message tells the pusher to
 * use, and it skips only the targeted-test step after a bounded lock wait.
 *
 * @param {Record<string, string>} env
 * @returns {boolean}
 */
function hasHookSkipEnv(env) {
	return env.HUSKY === "0" || (env.PI_LENS_SKIP_HOOKS ?? "") !== "";
}

/**
 * Classify a `git commit` short-option bundle. Stops at the first
 * value-taking letter: `-mn` is a message `n`, `-unormal` is an untracked
 * mode, neither is a bypass. "bypass": `-n` (`--no-verify`) came first.
 * "detached": the bundle ENDS on `m`/`F`, so the NEXT token is its value
 * (`-am "-n"`, `-aF -n`) and must not be read as a flag.
 *
 * @param {string} arg
 * @returns {"bypass" | "detached" | null}
 */
function scanCommitBundle(arg) {
	if (!/^-[A-Za-z]+$/.test(arg)) return null;
	const letters = arg.slice(1);
	for (let k = 0; k < letters.length; k++) {
		const ch = letters[k];
		if (ch === "n") return "bypass";
		if (COMMIT_VALUE_LETTERS.includes(ch))
			return k === letters.length - 1 && (ch === "m" || ch === "F")
				? "detached"
				: null;
	}
	return null;
}

/**
 * #3778: is `args[i]` (the subcommand) a hook bypass -- a `git config
 * core.hooksPath` WRITE, or a `commit`/`push`/`merge`/`rebase` carrying
 * `--no-verify`, `-n` (commit only: `git push -n` is `--dry-run`, and on
 * merge/rebase `-n` is `--no-stat`), a `core.hooksPath` global option, or a
 * skip env variable. Reads of `core.hooksPath` stay allowed.
 *
 * @param {string[]} args
 * @param {number} i index of the subcommand, after {@link gitSubcommandIndex}
 * @param {Record<string, string>} env
 * @returns {boolean}
 */
function classifyHookBypass(args, i, env) {
	const subcommand = args[i];
	if (subcommand === "config") {
		const rest = args.slice(i + 1);
		const key = rest.findIndex((a) => /^core\.hookspath$/i.test(a));
		if (key === -1) return false;
		return (
			rest.some((a) => CONFIG_UNSET_WORDS.has(a)) ||
			(rest[key + 1] !== undefined && !rest[key + 1].startsWith("-"))
		);
	}
	if (!HOOK_SUBCOMMANDS.has(subcommand)) return false;
	if (hasHookSkipEnv(env)) return true;
	if (args.slice(0, i).some((a) => /core\.hookspath/i.test(a))) return true;
	const skipsMessageValues = subcommand === "commit" || subcommand === "merge";
	for (let j = i + 1; j < args.length; j++) {
		const a = args[j];
		if (a === "--") break;
		if (skipsMessageValues && MESSAGE_VALUE_FLAGS.has(a)) {
			j++;
			continue;
		}
		// git accepts the unambiguous abbreviations `--no-veri`/`--no-verif`;
		// `--no-ver` is ambiguous and git rejects it.
		if (/^--no-veri(f(y)?)?$/.test(a)) return true;
		if (subcommand === "commit") {
			const bundle = scanCommitBundle(a);
			if (bundle === "bypass") return true;
			if (bundle === "detached") j++;
		}
	}
	return false;
}

/** `git stash list` / `git stash show` flags that only choose how history is
 *  printed (#5111). An ADMIT set: a flag not named here is refused, including
 *  `--output=`, `--ext-diff` and `--textconv`, which write or run programs. */
const STASH_READ_FLAGS = new Set([
	"--oneline",
	"--stat",
	"--shortstat",
	"--numstat",
	"--summary",
	"--name-only",
	"--name-status",
	"--no-color",
	"--no-patch",
	"-p",
	"--patch",
	"-s",
	"--include-untracked",
	"--only-untracked",
	"-u",
]);

/** The redirects agents append to a read (#5111): stderr to stdout, or output
 *  to `/dev/null`. Exact words only; any other redirect target is refused. */
const STASH_READ_REDIRECTS = new Set(["2>&1", "2>/dev/null", ">/dev/null"]);

/** `--format=` / `--pretty=` with a value of plain format characters only: no
 *  quote, `$`, backtick, `;`, `|`, `&`, `<`, `>` or the substitution mark. */
const STASH_FORMAT_FLAG = /^--(?:format|pretty)=[A-Za-z0-9%:,._ -]*$/;

/** The value of a `-C` before the subcommand (PR #5115 G1): one plain path word
 *  of known-good characters and never a leading `-`. `$`, a backtick, a quote,
 *  a glob, `{`, `(`, a backslash, a space and the substitution mark are not in
 *  it, so a value bash could expand or split into more words is refused. */
const STASH_DIR_VALUE = /^[A-Za-z0-9_./~+@:%=][A-Za-z0-9_./~+@:%=-]*$/;

/** `git stash show`'s one optional stash operand: `stash@{N}` or a bare `N`. */
const STASH_REF = /^(?:stash@\{\d+\}|\d+)$/;

/**
 * Is this `git ... stash ...` invocation one of the two read-only forms
 * (#5111)? Fail closed: it is an ADMIT list, so everything it does not
 * recognise -- a writing subcommand, bare `git stash`, a global option other
 * than `-C <dir>`, any env var (inline or exported), a flag or operand
 * outside the sets above, or a word holding a substitution -- is not read-only.
 *
 * @param {string[]} args
 * @param {number} i index of the `stash` word
 * @param {Record<string, string>} env
 * @returns {boolean}
 */
function isReadOnlyStash(args, i, env) {
	if (Object.keys(env).length > 0) return false;
	for (let k = 0; k < i; k += 2)
		if (args[k] !== "-C" || !STASH_DIR_VALUE.test(args[k + 1] ?? ""))
			return false;
	const [sub, ...rest] = args.slice(i + 1);
	if (sub !== "list" && sub !== "show") return false;
	let operands = 0;
	for (const word of rest) {
		if (STASH_READ_FLAGS.has(word) || STASH_READ_REDIRECTS.has(word)) continue;
		if (STASH_FORMAT_FLAG.test(word)) continue;
		if (sub === "show" && STASH_REF.test(word) && ++operands === 1) continue;
		return false;
	}
	return true;
}

/**
 * Classify a `git` invocation's args (after the leading "git" word).
 *
 * `cwd` (the PreToolUse payload's own `cwd`, threaded down from
 * {@link classifyPayload}) resolves a RELATIVE `git worktree remove <path>`
 * / `git worktree add <path>` / `git clone … <path>` argument the same way
 * git itself would, through {@link resolveShellPath} (#3988): `~`/`$VAR`
 * spellings are expanded first, and a relative path resolves against the
 * directory git runs in -- `cwd` after every leading `-C <dir>` option, each
 * relative to the one before (`-C a -C b` is `a/b`). A `git worktree remove`
 * path that cannot be resolved statically fails closed (`worktreeUnresolved`).
 *
 * @param {string[]} args
 * @param {string | null} [cwd] `null`: the effective cwd is statically unknown
 * @param {Record<string, string>} [env] git's own env, inline `VAR=val` prefix included (the hook-bypass check reads it)
 * @param {Record<string, string>} [expansionEnv] the shell variables bash expanded the path words with: the inline prefix applies only after expansion (#3997 F4)
 * @returns {DenyRule | null}
 */
function classifyGit(args, cwd, env = {}, expansionEnv = env) {
	const isRebaseFalseValue = (value) =>
		["false", "no", "0", "off"].includes(value.toLowerCase());
	const i = gitSubcommandIndex(args);
	const subcommand = args[i];
	// A bare process substitution word before the subcommand (`git -C <(true)
	// stash drop`): the lexer splits the segment at `<(`/`>(`, so the words
	// after it are never classified. A git segment that ends before its
	// subcommand on a dangling `<`/`>` word is refused, as the stash rule
	// (PR #5115 verify r4). Glued values (`-c x=<(..)`) and redirect words
	// read as the subcommand are not covered; see #4025.
	if ((args.at(-1) === "<" || args.at(-1) === ">") && i >= args.length - 1)
		return "stash";
	if (classifyHookBypass(args, i, env)) return "hookBypass";
	if (subcommand === "rebase") {
		const rest = args.slice(i + 1);
		return rest.length === 1 && (rest[0] === "--abort" || rest[0] === "--quit")
			? null
			: "rebase";
	}
	if (subcommand === "pull") {
		const rest = args.slice(i + 1);
		if (
			rest.some(
				(a) =>
					a === "-r" ||
					(/^-[^-]*r/.test(a) && a !== "--rebase") ||
					a === "--rebase" ||
					(a.startsWith("--rebase=") &&
						!isRebaseFalseValue(a.slice("--rebase=".length))),
			)
		)
			return "rebase";
	}
	if (subcommand === "config") {
		const rest = args.slice(i + 1);
		const keyIndex = rest.findIndex((a) => a.toLowerCase() === "pull.rebase");
		if (
			keyIndex >= 0 &&
			rest[keyIndex + 1] !== undefined &&
			!isRebaseFalseValue(rest[keyIndex + 1])
		)
			return "rebase";
		const branchKeyIndex = rest.findIndex((a) =>
			/^branch\..+\.rebase$/i.test(a),
		);
		if (
			branchKeyIndex >= 0 &&
			rest[branchKeyIndex + 1] !== undefined &&
			!isRebaseFalseValue(rest[branchKeyIndex + 1])
		)
			return "rebase";
	}
	if (
		args.slice(0, i).some((a) => {
			const match = /^pull\.rebase=(.*)$/i.exec(a);
			return match !== null && !isRebaseFalseValue(match[1]);
		})
	)
		return "rebase";
	if (subcommand === "push") {
		const rest = args.slice(i + 1);
		const hasExplicitLease = rest.some((a) =>
			/^--force-with-lease=[^:]+:[0-9a-fA-F]{4,64}$/.test(a),
		);
		const hasForce = rest.some(
			(a) => a === "--force" || a === "-f" || /^-[^-]*f/.test(a),
		);
		const hasLease = rest.some(
			(a) =>
				a === "--force-with-lease" ||
				a.startsWith("--force-with-lease=") ||
				a === "--force-w" ||
				a === "--force-with",
		);
		const hasPlusRefspec = rest.some((a) => a.startsWith("+"));
		if (
			rest.includes("--mirror") ||
			rest.includes("--mirr") ||
			(hasLease
				? !hasExplicitLease || hasForce || hasPlusRefspec
				: hasForce || hasPlusRefspec)
		)
			return "forcePush";
		return null;
	}
	if (subcommand === "stash")
		return isReadOnlyStash(args, i, env) ? null : "stash";
	if (subcommand === "reset") {
		const rest = args.slice(i + 1);
		if (rest.includes("--hard")) return "reset";
		if (rest.includes("--soft") && rest.some((a) => a.startsWith("origin/")))
			return "reset";
		return null;
	}
	// The directory git runs in: each leading `-C <dir>` moves it, relative to
	// the one before; a `<dir>` that cannot be resolved makes it unknown
	// (`null`), which makes any relative path argument unresolvable (#3988).
	/** @type {string | null | undefined} */
	let gitCwd = cwd;
	for (let k = 0; k < i; k++) {
		if (args[k] === "-C" && args[k + 1] !== undefined) {
			const target = resolveShellPath(args[k + 1], gitCwd, expansionEnv);
			gitCwd = target.reason === undefined ? target.path : null;
		}
		if (GIT_TWO_TOKEN_FLAGS.has(args[k])) k++;
	}
	if (subcommand === "worktree" && args[i + 1] === "remove") {
		const rest = args.slice(i + 2);
		let forceCount = 0;
		const positionals = [];
		for (const a of rest) {
			if (a === "-f" || a === "--force") forceCount++;
			else if (/^-f{2,}$/.test(a)) forceCount += a.length - 1;
			else if (!a.startsWith("-")) positionals.push(a);
		}
		if (forceCount >= 2) return "worktreeForce";
		if (positionals[0]) {
			// #3988: the path bash would hand git, or a named fail-closed deny --
			// the #3173 check cannot run on a path this scan cannot resolve.
			const { path: worktreeDir, reason } = resolveShellPath(
				positionals[0],
				gitCwd,
				expansionEnv,
			);
			if (reason !== undefined) return "worktreeUnresolved";
			if (
				looksLikeGitWorktree(worktreeDir) &&
				hasNodeModulesSymlinkOutside(worktreeDir)
			)
				return "worktreeSymlink";
		}
		return null;
	}
	// #3526: a `git worktree add`/`git clone` destination under /tmp, resolved
	// through the same resolveShellPath as the remove rule above and the mktemp
	// rule below (#3988). An UNRESOLVABLE destination stays a documented
	// fail-open here: this is a hygiene rule, and denying every
	// `git worktree add "$WT"` would block ordinary fixer work for a path that
	// cannot be shown to be under /tmp.
	if (subcommand === "worktree" && args[i + 1] === "add") {
		const rest = args.slice(i + 2);
		const [pathArg] = collectPositionals(rest, WORKTREE_ADD_VALUE_FLAGS);
		if (
			pathArg !== undefined &&
			isUnderTmpCheckoutRoot(
				resolveShellPath(pathArg, gitCwd, expansionEnv).path,
			)
		)
			return "tmpCheckout";
		return null;
	}
	if (subcommand === "clone") {
		const rest = args.slice(i + 1);
		const positionals = collectPositionals(rest, CLONE_VALUE_FLAGS);
		// Only an EXPLICIT destination directory (the second positional) is
		// judged -- `git clone <repo>` with no directory derives one from the
		// repo name, which this static scan cannot resolve (the same
		// documented-blind-spot shape as a command word built by expansion).
		if (
			positionals.length >= 2 &&
			isUnderTmpCheckoutRoot(
				resolveShellPath(positionals[1], gitCwd, expansionEnv).path,
			)
		)
			return "tmpCheckout";
		return null;
	}
	return null;
}

/** Commands whose operands are the paths they delete (`find` is judged
 *  separately: its operands are the leading words, its delete an expression). */
const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink"]);

/**
 * Is the project `cwd` runs in linked (PR #4054 round 4)? True when the cwd
 * itself sits inside a linked `node_modules` (npm run there lands in the
 * shared install's own checkout; measured on npm 9.2.0: `cd
 * lane/node_modules && npm prefix` prints `main`), or when npm's own walk-up
 * from the PHYSICAL cwd to the nearest directory with a `package.json` or
 * `node_modules` (from `lnk` -> `lane/scripts`, `npm prefix` prints the lane)
 * reaches a `node_modules` that {@link hasNodeModulesSymlinkOutside} calls
 * outside it. Also the answer for a directory the resolver cannot read (a
 * `$( … )` or backtick output, an unknown variable, a `~user`/`~+`, a glob):
 * such a part is judged as the project the command runs in, so `--prefix
 * "$(pwd)"` and `D=$(pwd); --prefix $D` get one verdict, and a real lane's
 * project is real.
 *
 * @param {string | undefined} cwd
 * @param {Record<string, string>} env
 * @returns {boolean}
 */
function projectNodeModulesLinked(cwd, env) {
	if (operandThroughNodeModulesLink(".", cwd, env, false, false)) return true;
	let dir = resolveShellPath(".", cwd, env).path;
	for (;;) {
		if (hasNodeModulesSymlinkOutside(dir)) return true;
		const parent = dirname(dir);
		if (
			parent === dir ||
			existsSync(join(dir, "package.json")) ||
			existsSync(join(dir, "node_modules"))
		)
			return false;
		dir = parent;
	}
}

/**
 * Does `operand` pass THROUGH a `node_modules` symlink that
 * {@link hasNodeModulesSymlinkOutside} calls outside its project? The operand
 * is expanded by {@link expandShellWord} (`$PWD/node_modules/`,
 * `~/node_modules/`, an assigned `$D/`) and walked component by component, the
 * cwd's own components first (a `cd` INTO the link, then `rm -rf ./*`). At each
 * `node_modules` component that something follows -- a component, `.`, `..`,
 * a trailing `/` (the kernel follows a link spelled with one), or, with
 * `followFinal` (`find -L|-H|-follow`), nothing -- the directory HOLDING it is
 * tested where the kernel lands: {@link resolveShellPath} in physical mode,
 * which follows a symlink before a later `..` (`../lnk/../node_modules/`
 * reaches the lane `lnk` points into, R3-2). Only the holder is resolved: a
 * physical realpath of the whole operand collapses `lane/node_modules/` onto
 * the link's target and the link leaves the path. A holder the resolver cannot
 * read is the project the command runs in ({@link projectNodeModulesLinked}).
 * `followAll` (`find -L|-follow` descend every link they meet) also tests the
 * operand itself as a holder (`find -L . -delete`). The bare link
 * (`rm -rf node_modules`) only unlinks it.
 *
 * @param {string} operand
 * @param {string | undefined} cwd
 * @param {Record<string, string>} env
 * @param {boolean} followFinal
 * @param {boolean} followAll
 * @returns {boolean}
 */
function operandThroughNodeModulesLink(
	operand,
	cwd,
	env,
	followFinal,
	followAll,
) {
	/** @param {string} holder */
	const holderLinked = (holder) => {
		const { path, reason } = resolveShellPath(holder, cwd, env);
		return reason === undefined
			? hasNodeModulesSymlinkOutside(path)
			: projectNodeModulesLinked(cwd, env);
	};
	if (followAll && holderLinked(operand)) return true;
	const { text } = expandShellWord(operand, cwd, env);
	const words = text.split(SEP);
	const anchor = isAbsolute(text) ? [] : (cwd ?? process.cwd()).split(SEP);
	const parts = [...anchor, ...words];
	for (let i = 1; i < parts.length; i++) {
		if (parts[i] !== "node_modules") continue;
		if (i === parts.length - 1 && !followFinal) continue;
		// The cwd's own components are known: a tracked cwd is always resolved.
		const linked =
			i < anchor.length
				? hasNodeModulesSymlinkOutside(
						resolveShellPath(parts.slice(0, i).join(SEP) || SEP, cwd, env).path,
					)
				: holderLinked(
						words.slice(0, i - anchor.length).join(SEP) ||
							(isAbsolute(text) ? SEP : "."),
					);
		if (linked) return true;
	}
	return false;
}

/**
 * The #4044 sibling rule: a delete (`rm`/`rmdir`/`unlink`, or `find` with
 * `-delete` or `-exec rm|rmdir|unlink`) with an operand through a linked
 * `node_modules`. MEASURED (GNU coreutils, 2026-10-07): `rm -rf
 * node_modules/`, `rm -rf node_modules/*`, `find node_modules/ -delete`,
 * `find -L|-H|-follow node_modules -delete`, `find -L|-follow . -delete`,
 * `find node_modules/ -exec rm -rf {} +` and `cd node_modules && rm -rf ./*`
 * all empty the link's target; `rm -rf node_modules` and `find node_modules
 * -delete` remove only the link. Operands go through {@link resolveShellPath}
 * (`$PWD`, `~`, assigned variables); a holder it cannot read
 * (`"$(pwd)/node_modules/"`, an unknown variable) is the project the command
 * runs in. NOT handled: a glob that expands TO the
 * link (a star-slash operand, `rm -rf` of every subdirectory or of a `node_m` prefix glob), `find -L` from an ancestor of the lane (only
 * an operand that is, holds, or sits under the link counts), an operand made
 * only of a substitution (`rm -rf $(ls)`: no `node_modules` component), `xargs rm`,
 * `find -exec sh -c`, `shred`, `mv`, `rsync --delete`, `git clean`,
 * `npx rimraf`, a runtime `rmSync`/`rmtree`.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {string | undefined} cwd
 * @param {Record<string, string>} env
 * @returns {DenyRule | null}
 */
function classifyNodeModulesDelete(cmd, args, cwd, env) {
	let operands;
	let followFinal = false;
	let followAll = false;
	if (cmd === "find") {
		let i = 0;
		while (/^-([HLP]|D\w*|O\d*)$/.test(args[i] ?? "")) {
			if (args[i] === "-H") followFinal = true;
			if (args[i] === "-L") followFinal = followAll = true;
			i++;
		}
		let end = i;
		while (end < args.length && !/^(-|\(|!)/.test(args[end])) end++;
		const expression = args.slice(end);
		if (expression.includes("-follow")) followFinal = followAll = true;
		const deletes = expression.some(
			(a, j) =>
				a === "-delete" ||
				(/^-(exec|execdir|ok|okdir)$/.test(a) &&
					DELETE_COMMANDS.has(commandBasename(expression[j + 1] ?? ""))),
		);
		if (!deletes) return null;
		operands = end > i ? args.slice(i, end) : ["."];
	} else {
		operands = args.filter((a) => !a.startsWith("-"));
	}
	return operands.some((o) =>
		operandThroughNodeModulesLink(o, cwd, env, followFinal, followAll),
	)
		? "linkedNodeModulesDelete"
		: null;
}

/** The `npm` verbs (and their aliases) that write `node_modules` (#4044):
 *  the clean-install family (`ci`, which ignores `--dry-run` on npm 9.2.0 and
 *  removes `node_modules/*` first), and every verb that runs the reify step.
 *  Read-only verbs (`ls`, `run`, `test`, `view`, `audit`, `outdated`, `exec`,
 *  `pack`, `config`) are absent on purpose. */
const NPM_NODE_MODULES_WRITERS = new Set(
	[
		"ci clean-install ic install-clean isntall-clean",
		"install-ci-test cit clean-install-test sit",
		"install i in ins inst insta instal add install-test it isntall isnt isnta isntal",
		"uninstall un unlink remove rm r update up upgrade udpate prune",
		"rebuild rb link ln dedupe ddp find-dupes",
	].flatMap((line) => line.split(" ")),
);

/** Every other npm verb (and alias) a worker types. Only used to tell a verb
 *  from the VALUE of an unlisted flag (`npm --audit false ci`: `false` is
 *  neither): the verb is the first positional that is in this set or in
 *  {@link NPM_NODE_MODULES_WRITERS}. */
const NPM_OTHER_VERBS = new Set(
	[
		"access adduser audit bugs cache completion config c get set deprecate diff dist-tag",
		"docs home doctor edit exec x explain why explore fund help help-search hook init create",
		"innit login logout ls list la ll org outdated owner author pack ping pkg prefix profile",
		"publish query repo restart root run run-script rum urn sbom search find s se shrinkwrap",
		"star stars start stop team test t tst token unpublish unstar version view show info v",
		"whoami",
	].flatMap((line) => line.split(" ")),
);

/** `npm`/`npx` flags that consume a separate following token, so the verb
 *  (or the npx command) is found past them. The `--flag=value` form is one
 *  token and needs no entry. */
const NPM_VALUE_FLAGS = new Set([
	"--prefix",
	"-w",
	"--workspace",
	"-p",
	"--package",
	"-c",
	"--call",
	"--registry",
	"--cache",
	"--userconfig",
	"--globalconfig",
	"--loglevel",
	"--omit",
	"--include",
	"--install-strategy",
	"--tag",
	"--scope",
	"--otp",
	"--before",
]);

/**
 * The #4044 rule: is this `npm`/`npx npm@…` invocation a node_modules WRITER
 * aimed at a project whose `node_modules` is a symlink resolving outside it?
 * That is the #3173 hazard with a different verb -- on 2026-10-07 a worker's
 * `npm ci --ignore-scripts --dry-run` in a lane whose `node_modules` linked
 * the main checkout's install emptied that install for every lane (npm 9.2.0
 * removes `node_modules/*` before reify, ignores the dry-run, and follows the
 * link). The clean-install family is denied with or without `--dry-run`; so
 * is every other writer, which keeps the rule one line: MEASURED on npm 9.2.0
 * and 11.18.0, `install`/`add`/`uninstall`/`update`/`prune`/`dedupe --dry-run`
 * leave a linked install intact, but nothing measured covers the next npm,
 * and the scratch-copy answer costs a worker nothing.
 *
 * The project dir is `--prefix` when given, else the cwd -- walked up to the
 * nearest directory with a `package.json` or `node_modules`, as npm's own
 * local-prefix lookup does (a lane's `scripts/` subdirectory reaches the
 * lane's link; {@link projectNodeModulesLinked}). A `--prefix` the resolver
 * cannot read (`"$(pwd)"`, backticks, an unknown variable) is that project
 * too, failing closed in a linked lane (R3-1); `--prefix $TMPDIR/<name>` is
 * readable. The link test is {@link hasNodeModulesSymlinkOutside}, the
 * #3173 classifier, deliberately without {@link looksLikeGitWorktree}: a
 * delete through an outside link is the hazard wherever the link sits.
 * `-g`/`--global` writes the global tree, not the project's, and is allowed.
 * The verb is the first positional that is a known npm verb, so the value of
 * an unlisted flag (`npm --audit false ci`) does not become the verb; the
 * `--prefix` goes through {@link resolveShellPath} (`$PWD`, `~`). NOT handled: see the
 * header's list (`npm_config_prefix=`, launchers, `npm exec -- npm ci`, ...).
 *
 * @param {"npm"|"npx"} cmd
 * @param {string[]} args
 * @param {string | undefined} cwd
 * @param {Record<string, string>} env
 * @returns {DenyRule | null}
 */
function classifyNpm(cmd, args, cwd, env) {
	let npmArgs = args;
	if (cmd === "npx") {
		let i = 0;
		while (i < args.length && args[i].startsWith("-")) {
			i += NPM_VALUE_FLAGS.has(args[i]) ? 2 : 1;
		}
		// `npx -y npm@11.18.0 ci`: the command npx runs is npm itself.
		if (!/^npm(@[^/]*)?$/.test(args[i] ?? "")) return null;
		npmArgs = args.slice(i + 1);
	}
	const positionals = collectPositionals(npmArgs, NPM_VALUE_FLAGS);
	const verbAt = positionals.findIndex(
		(a) => NPM_NODE_MODULES_WRITERS.has(a) || NPM_OTHER_VERBS.has(a),
	);
	const verb = positionals[verbAt];
	if (
		!NPM_NODE_MODULES_WRITERS.has(verb) &&
		!(verb === "audit" && positionals[verbAt + 1] === "fix")
	)
		return null;
	if (npmArgs.some((a) => a === "-g" || a === "--global")) return null;
	let prefix;
	for (let i = 0; i < npmArgs.length; i++) {
		if (npmArgs[i] === "--prefix") prefix = npmArgs[i + 1] ?? "";
		else if (npmArgs[i].startsWith("--prefix=")) prefix = npmArgs[i].slice(9);
	}
	// npm resolves `--prefix` lexically, and an empty one is the cwd (measured
	// on npm 9.2.0: `--prefix lnk/..` is the directory holding `lnk`). The
	// path npm writes through is `<prefix>/node_modules/`; without a readable
	// prefix it is the project the command runs in.
	const resolved =
		prefix === undefined ? undefined : resolveShellPath(prefix, cwd, env, true);
	const linked =
		resolved === undefined || resolved.reason !== undefined
			? projectNodeModulesLinked(cwd, env)
			: operandThroughNodeModulesLink(
					`${resolved.path}${SEP}node_modules${SEP}`,
					cwd,
					env,
					false,
					false,
				);
	return linked ? "npmLinkedInstall" : null;
}

// `-d`/`--directory` (bare or bundled, e.g. `-qd`) are the flags that make
// `mktemp` create a DIRECTORY -- parsed in {@link forEachBundledMktempFlag}
// and {@link classifyMktemp}'s own `--directory` check. A bare `mktemp` (no
// such flag) creates a FILE and is always allowed -- #3526's acceptance list
// says so explicitly, and a file cannot become the kind of multi-hundred-MB
// scratch checkout the incident was about.

/**
 * Classify an `mktemp` invocation's args for #3526's `tmpCheckout` rule.
 * File-mode (no `-d`/`--directory`) always allows.
 *
 * Directory-mode landing spot, MEASURED against GNU coreutils 9.4 mktemp
 * (this repo's `/tmp` probe, in the PR body) rather than assumed from the
 * man page's prose (AGENTS.md shape 16):
 *   - `-p <dir>` / `--tmpdir=<dir>` (bare `--tmpdir` with no `=`, GNU's own
 *     "use $TMPDIR" spelling, is folded into the same path via {@link
 *     resolveShellPath}'s `$TMPDIR` expansion below) -- lands in that dir,
 *     joined with the template if one was given.
 *   - An ABSOLUTE template with no `-p`/`--tmpdir=` -- lands in the
 *     template's own directory (`-p`/`--tmpdir=` wins if both are given;
 *     untested combination, not claimed).
 *   - A RELATIVE template with no `-p`/`--tmpdir=`/bare `--tmpdir` -- lands
 *     in mktemp's OWN cwd, never `$TMPDIR` (measured: `TMPDIR=/elsewhere
 *     mktemp -d foo.XXXXXX` still creates `foo.XXXXXX` in the current
 *     directory) -- the one place this rule's behaviour deviates from the
 *     issue's own prose ("no -p and no absolute template ⇒ deny, default is
 *     $TMPDIR or /tmp"), which does not hold for a RELATIVE template; only a
 *     template-omitting invocation actually defaults to $TMPDIR/tmp.
 *   - No template at all -- lands in `$TMPDIR`, or `/tmp` when unset
 *     (measured); folded through the same `$TMPDIR`-sentinel path.
 *
 * The `$TMPDIR` sentinel (no template, `-t` with a relative template, bare
 * `--tmpdir`) is GNU mktemp's own env read, so it expands with the inline
 * `TMPDIR=` prefix, and an empty TMPDIR falls back to /tmp as an unset one
 * does. Every word the command typed (a template, a
 * `-p`/`--tmpdir=` value) was expanded by bash before that prefix applied, so
 * it expands without it (#4057).
 *
 * @param {string[]} args
 * @param {string | undefined} cwd
 * @param {Record<string, string>} env
 * @returns {DenyRule | null}
 */
/**
 * Short mktemp options bundled into ONE token (`-dt`, `-dp`, `-qd`) are
 * common in this repo's own transcripts and were a false-allow blind spot
 * (#3526 review F2, measured against real GNU coreutils 9.4 -- the PR body
 * has the probe transcript): `mktemp -dt X`, `-dp DIR X` and `-qd /tmp/X`
 * all created a directory under `/tmp`, and the hook allowed every one.
 * Walks `a`'s characters (after the leading `-`) one at a time, exactly the
 * way GNU getopt bundles single-character short options, and calls back
 * for each recognized letter. `p`'s value is the token immediately AFTER
 * the whole bundled flag (`-dp DIR`, `-dp` alone with DIR as the next argv
 * word) -- real GNU mktemp does not accept `-pDIR` glued to the same token,
 * measured directly (`-pDIR` is rejected as an unrecognized option), so
 * only the separate-token form is claimed here.
 *
 * @param {string} a a single `-`-prefixed argv word (never `--x`)
 * @param {{ onDir: () => void; onTmpdirFlag: () => void; onForceTmpdirRelative: () => void }} handlers
 * @returns {boolean} whether `a` carried a `p` needing the next token as its value
 */
function forEachBundledMktempFlag(a, handlers) {
	let needsTmpdirValue = false;
	for (const ch of a.slice(1)) {
		if (ch === "d") handlers.onDir();
		else if (ch === "p") needsTmpdirValue = true;
		else if (ch === "t") handlers.onForceTmpdirRelative();
		// "q" (quiet) and "u" (dry-run, --dry-run) are accepted and ignored --
		// documented blind spot: neither changes WHERE the directory lands
		// among the cases this rule claims to handle. Any other letter is
		// likewise ignored rather than rejected, matching this file's
		// fail-open-on-unrecognized stance elsewhere.
	}
	return needsTmpdirValue;
}

/**
 * The readings of a typed word (#4057, #4826): {@link expandShellWord}'s text
 * as written, and, when that text still holds a reference this scan cannot
 * resolve, the same text with each such reference removed, as if bash had
 * expanded it to nothing. A rule that judges where the word lands reads both
 * and denies when either denies, as {@link findDeny} reads a substitution
 * (#3997). The gate admits no list of spellings that can be empty: a reference
 * left unresolved after expansion is unknown, whatever its form. Removed: any
 * `$NAME`, `${ … }` (nested braces too; an unterminated one runs to the end of
 * the word), `$( … )` and `$(( … ))`, a positional `$1`-`$9`, `$@`, `$*`,
 * `$!`, a backtick span, and a `~user`/`~+`/`~-` tilde. Kept as written: `$0`,
 * `$#`, `$$`, `$?`, `$-` and a lone `$`, which bash always sets to something.
 *
 * @param {string} word
 * @param {string | null | undefined} cwd
 * @param {Record<string, string>} env see {@link lookupShellVariable}
 * @returns {string[]} one reading, or two when the word holds an unresolved reference
 */
function expandShellReadings(word, cwd, env) {
	const { text } = expandShellWord(word, cwd, env);
	const unresolved = text.replace(/^~[^/]*/, "");
	let bare = "";
	for (let i = 0; i < unresolved.length; i++) {
		const ch = unresolved[i];
		const next = unresolved[i + 1] ?? "";
		if (ch === "`") {
			const close = unresolved.indexOf("`", i + 1);
			i = close === -1 ? unresolved.length : close;
		} else if (ch === "$" && (next === "{" || next === "(")) {
			const close = next === "{" ? "}" : ")";
			let depth = 0;
			let end = i + 1;
			for (; end < unresolved.length; end++) {
				if (unresolved[end] === next) depth++;
				else if (unresolved[end] === close && --depth === 0) break;
			}
			i = end;
		} else if (ch === "$" && /[A-Za-z_]/.test(next)) {
			i++;
			while (/[A-Za-z0-9_]/.test(unresolved[i + 1] ?? "")) i++;
		} else if (ch === "$" && /[1-9@*!]/.test(next)) {
			i++;
		} else bare += ch;
	}
	return bare === text ? [text] : [text, bare];
}

/**
 * Classify an `mktemp` invocation's args for #3526's `tmpCheckout` rule.
 * File-mode (no `-d`/`--directory`, bundled or not) always allows.
 *
 * @param {string[]} args
 * @param {string | undefined} cwd
 * @param {Record<string, string>} env mktemp's own env, inline `VAR=val` prefix included (GNU mktemp's default `$TMPDIR` reads it)
 * @param {Record<string, string>} [expansionEnv] the shell variables bash expanded the typed words with: the inline prefix applies only after expansion (#4057)
 * @returns {DenyRule | null}
 */
function classifyMktemp(args, cwd, env, expansionEnv = env) {
	let isDir = false;
	// The `-p`/`--tmpdir` directory and the variables it expands with: a typed
	// value is a word bash expanded, and bare `--tmpdir` is GNU mktemp's own
	// `$TMPDIR`, read from its own env (#4057).
	/** @type {{ dir: string | undefined; env: Record<string, string> } | undefined} */
	let tmpdirOverride;
	/** @type {string | undefined} */
	let template;
	// `-t`/bundled `t`: interpret a RELATIVE template as a single component
	// rooted at $TMPDIR (else /tmp) rather than mktemp's own cwd -- measured
	// against real GNU coreutils 9.4 (PR body has the transcript): TMPDIR is
	// consulted with `-t` even for a relative template, unlike the bare
	// relative-template default this file already measured.
	let forceTmpdirRelative = false;
	let i = 0;
	while (i < args.length) {
		const a = args[i];
		if (a === "--tmpdir") {
			// Bare form (no "="): GNU mktemp's own "use $TMPDIR" spelling.
			tmpdirOverride = { dir: "$TMPDIR", env };
			i++;
			continue;
		}
		if (a.startsWith("--tmpdir=")) {
			tmpdirOverride = {
				dir: a.slice("--tmpdir=".length),
				env: expansionEnv,
			};
			i++;
			continue;
		}
		if (a === "--directory") {
			isDir = true;
			i++;
			continue;
		}
		if (a.startsWith("-") && a !== "-" && !a.startsWith("--")) {
			const needsTmpdirValue = forEachBundledMktempFlag(a, {
				onDir: () => {
					isDir = true;
				},
				onForceTmpdirRelative: () => {
					forceTmpdirRelative = true;
				},
			});
			i++;
			if (needsTmpdirValue) {
				tmpdirOverride = { dir: args[i], env: expansionEnv };
				i++;
			}
			continue;
		}
		if (a.startsWith("-")) {
			// Every other long flag (--suffix=X, --dry-run, ...) is ignored --
			// documented blind spot, matching this file's other argv-parsing
			// sets: none of them change WHERE the directory lands among the
			// cases this rule claims to handle.
			i++;
			continue;
		}
		template = a;
		i++;
	}
	if (!isDir) return null;
	// Where the directory can land, every reading of every word that decides
	// it ({@link expandShellReadings}; the first reading that lands under /tmp
	// denies). #3988: bash expands `~`/`$TMPDIR`/`$HOME` in a typed word
	// BEFORE mktemp sees it, so `$TMPDIR/x.XXXXXX` is an ABSOLUTE template, not
	// a relative one that lands in cwd; it expands them before an inline
	// prefix applies (#4057). A reading that is empty lands in mktemp's own
	// default directory: GNU mktemp takes an empty `-p ''`/`--tmpdir=` as its
	// `$TMPDIR`, and takes an empty or unset `$TMPDIR` as /tmp (coreutils
	// mktemp.c: `env && *env ? env : "/tmp"`). Quotes are gone by now, so
	// `-p "$D"` and `-p $D` read alike.
	const defaultDirs = () =>
		expandShellReadings("$TMPDIR", cwd, env).map((dir) =>
			dir === "" ? TMP_ROOT : dir,
		);
	/** @type {string[]} */
	let targetDirs;
	if (tmpdirOverride?.dir !== undefined)
		targetDirs = expandShellReadings(
			tmpdirOverride.dir,
			cwd,
			tmpdirOverride.env,
		).flatMap((dir) => (dir === "" ? defaultDirs() : [dir]));
	else if (template === undefined) targetDirs = defaultDirs();
	else
		targetDirs = expandShellReadings(template, cwd, expansionEnv).flatMap(
			(text) => {
				if (isAbsolute(text)) return [dirname(text)];
				// `-t` roots a relative template at $TMPDIR; so does a template
				// that vanished. Otherwise it lands in the template's own directory
				// under mktemp's cwd (`.` for a bare name, #4060).
				return forceTmpdirRelative || text === ""
					? defaultDirs()
					: [dirname(text)];
			},
		);
	// The words are expanded already; what is left in them is unresolved in
	// every environment, so the prefix is never consulted again (#4057).
	return targetDirs.some((dir) =>
		isUnderTmpCheckoutRoot(resolveShellPath(dir, cwd, {}).path),
	)
		? "tmpCheckout"
		: null;
}

/**
 * The harness's own session directory, `/tmp/claude-<uid>`: the harness
 * creates and manages it, and the Bash tool's scratchpad lives there, so a
 * write into it is not agent-chosen /tmp scratch (#4348). `undefined` where
 * the platform has no uid (Windows has no `/tmp` either). {@link
 * isTmpWriteTarget} exempts it by NAME below the physical tmp root, never by
 * where the entry resolves: a `claude-<uid>` symlink to the tmp root, to a
 * directory above it or to a sibling would otherwise exempt everything there
 * (#4060 r4).
 */
const HARNESS_TMP_DIR =
	typeof process.getuid === "function"
		? `${TMP_ROOT}/claude-${process.getuid()}`
		: undefined;

/**
 * Does `word`, as bash expands it, name a place under `/tmp` (#4348)? The
 * same expander as every other path rule (#3988), so `$TMPDIR/x` follows the
 * command's own `TMPDIR=` assignments, then THIS hook's ambient `TMPDIR` -- a
 * lane that pins `TMPDIR` off `/tmp` writes `$TMPDIR/x` freely, one whose
 * `TMPDIR` is `/tmp` does not. A `TMPDIR`/`TMP`/`TEMP` set in neither place
 * expands to the EMPTY string, as in bash (`$TMPDIR/x` is `/x`), not to
 * `/tmp`: that default is `mktemp`'s, which {@link lookupShellVariable} lends
 * the other rules. Like `tmpCheckout`, an expansion this scan cannot resolve
 * (`${TMPDIR:-/tmp}`, `$(mktemp)`) is judged on its best-effort text and so
 * ALLOWS: a hygiene rule, not a fail-closed one.
 *
 * @param {string} word
 * @param {string | null | undefined} cwd
 * @param {Record<string, string>} env
 * @returns {boolean}
 */
function isTmpWriteTarget(word, cwd, env) {
	const unsetIsEmpty = Object.fromEntries(
		TEMP_DIR_VARS.filter(
			(name) => (env[name] ?? process.env[name]) === undefined,
		).map((name) => [name, ""]),
	);
	const { path } = resolveShellPath(word, cwd, { ...unsetIsEmpty, ...env });
	return (
		isUnderTmpCheckoutRoot(path) &&
		!(
			HARNESS_TMP_DIR !== undefined &&
			isUnderTmpRoot(
				path,
				join(physicalPath(TMP_ROOT, TMP_ROOT), basename(HARNESS_TMP_DIR)),
			)
		)
	);
}

/**
 * Every redirection target an UNQUOTED `>` in `words` names, in order (#4348):
 * `>`, `>>`, `2>`, `2>>`, `&>`, `&>>` and `>&file`, attached (`>/tmp/x`,
 * `echo hi>/tmp/x`) or as the next word. `splitWords` keeps the operator and
 * its target in the word as written, and {@link WORD_REDIRECTS} says which `>`
 * were live, so `echo "> /tmp/x"` and `echo \> /tmp/x` yield nothing. `>&2`
 * and `>&-` duplicate or close a descriptor and write no file.
 *
 * @param {string[]} words
 * @returns {string[]}
 */
function redirectTargets(words) {
	/** @type {number[][] | undefined} */
	const live = /** @type {any} */ (words)[WORD_REDIRECTS];
	/** @type {string[]} */
	const targets = [];
	if (live === undefined) return targets;
	for (let k = 0; k < words.length; k++) {
		const offsets = live[k];
		if (offsets === undefined) continue;
		const word = words[k];
		for (let p = 0; p < offsets.length; p++) {
			let end = offsets[p] + 1;
			while (offsets[p + 1] === end) {
				p++;
				end++;
			}
			const duplicates = word[end] === "&";
			if (duplicates) end++;
			const target =
				word.slice(end, offsets[p + 1] ?? word.length) || words[k + 1];
			if (target === undefined || (duplicates && /^(\d+|-)-?$/.test(target)))
				continue;
			targets.push(target);
		}
	}
	return targets;
}

/**
 * GNU-style option parse for the file-writing commands {@link
 * tmpWriteOperands} judges: `shortValue` letters and `longValue` names take a
 * value (glued, or the next word), `--` ends the options, and options may
 * follow operands (GNU permutes). Abbreviated long options (`--target=`) are
 * not recognised: a documented limit.
 *
 * @param {string[]} args
 * @param {string} shortValue
 * @param {string[]} longValue
 * @returns {{ operands: string[]; values: Record<string, string>; flags: Set<string> }}
 */
function parseWriterArgs(args, shortValue, longValue) {
	/** @type {string[]} */
	const operands = [];
	/** @type {Record<string, string>} */
	const values = {};
	const flags = new Set();
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--") {
			operands.push(...args.slice(i + 1));
			break;
		}
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const name = eq < 0 ? a : a.slice(0, eq);
			flags.add(name);
			if (longValue.includes(name))
				values[name] = eq < 0 ? (args[++i] ?? "") : a.slice(eq + 1);
		} else if (a.startsWith("-") && a.length > 1) {
			for (let j = 1; j < a.length; j++) {
				flags.add(`-${a[j]}`);
				if (!shortValue.includes(a[j])) continue;
				values[`-${a[j]}`] =
					a.length > j + 1 ? a.slice(j + 1) : (args[++i] ?? "");
				break;
			}
		} else operands.push(a);
	}
	return { operands, values, flags };
}

/**
 * The paths a file-writing command creates or fills (#4348): `tee`, `mkdir`
 * and `touch` write every operand (`touch -r REF` reads REF);
 * `cp`/`mv`/`install` write the `-t DIR` / `--target-directory` value, else
 * the LAST operand, never a source; `install -d` is `mkdir`. Everything else:
 * no paths.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {string[]}
 */
function tmpWriteOperands(cmd, args) {
	if (cmd === "tee") return parseWriterArgs(args, "", []).operands;
	if (cmd === "mkdir") return parseWriterArgs(args, "", []).operands;
	// `touch -r REF` reads REF. Its other values (`-d DATE`, `-t STAMP`) and
	// `mkdir -m MODE` are never a /tmp path, so they need no skipping.
	if (cmd === "touch")
		return parseWriterArgs(args, "r", ["--reference"]).operands;
	if (cmd !== "cp" && cmd !== "mv" && cmd !== "install") return [];
	const { operands, values, flags } = parseWriterArgs(args, "t", [
		"--target-directory",
	]);
	if (cmd === "install" && (flags.has("-d") || flags.has("--directory")))
		return operands;
	const targetDir = values["-t"] ?? values["--target-directory"];
	if (targetDir !== undefined) return [targetDir];
	return operands.slice(-1);
}

/**
 * #4348: is any file this segment writes under `/tmp` (outside the harness's
 * own directory)? Redirections of any command (via {@link redirectTargets}),
 * plus the operands {@link tmpWriteOperands} names. `/tmp` as a source or a
 * read is never judged.
 *
 * @param {string[]} rawWords the segment's words, redirections included
 * @param {string} cmd the command word, runner prefixes and assignments stripped
 * @param {string[]} args its arguments
 * @param {string | null | undefined} cwd
 * @param {Record<string, string>} env the SHELL's variables: bash expands these words before any inline `VAR=x` reaches the command
 * @returns {DenyRule | null}
 */
function classifyTmpWrite(rawWords, cmd, args, cwd, env) {
	return [...redirectTargets(rawWords), ...tmpWriteOperands(cmd, args)].some(
		(target) => isTmpWriteTarget(target, cwd, env),
	)
		? "tmpWrite"
		: null;
}

/** `pkill`/`killall` (#3556): neither has a way to scope by PID the way
 *  plain `kill <pid>` does, so this file never classifies `kill` itself --
 *  a bare PID target is inherently already scoped to one process. */
const SHARED_KILL_COMMANDS = new Set(["pkill", "killall"]);

/**
 * Classify a `pkill`/`killall` invocation's args for #3556's `sharedKill`
 * rule. `killall` matches by process NAME only (no full-command-line mode),
 * so no pattern text can scope it to one worktree -- always denied.
 * `pkill` is denied UNLESS it is given `-f`/`--full` (full-command-line
 * match, the mode where a worktree's absolute path can actually appear in
 * what is matched), `cwd` (the PreToolUse payload's own cwd) is itself a
 * LINKED worktree, and its pattern argument contains `cwd` as a literal
 * substring. The linked-worktree check (#3526/#3556 review F6) is load-
 * bearing, not redundant with the substring check: the orchestrator and
 * every subagent that has not entered a worktree run with `cwd` pointed at
 * the shared main checkout, a path PREFIX of every `.claude/worktrees/*`
 * path, so `pattern.includes(cwd)` alone was satisfiable by a pattern that
 * matches every worktree's TLC -- the exact harm this rule exists to stop.
 * NOT handled (documented, not fixed): a flag that consumes a separate
 * value token (`-u <user>`, `--signal <name>`) -- only the bare,
 * single-token forms are recognized; a two-token flag's value is
 * misidentified as the pattern and very unlikely to contain `cwd`, so this
 * degrades to "denied" rather than a false allow. Also not handled: `kill
 * $(pgrep -f tlc2.TLC)` and `pgrep -f tlc2 | xargs kill` carry the same
 * machine-wide-match harm through a different command shape this scan does
 * not recognize as killing anything (`pgrep` alone only lists PIDs).
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {string | undefined} cwd
 * @returns {DenyRule | null}
 */
function classifyPkillKillall(cmd, args, cwd) {
	if (cmd === "killall") return "sharedKill";
	let fullMatch = false;
	/** @type {string | undefined} */
	let pattern;
	for (const a of args) {
		if (a === "-f" || a === "--full") {
			fullMatch = true;
			continue;
		}
		if (a.startsWith("-")) continue;
		pattern = a;
	}
	if (!fullMatch || pattern === undefined) return "sharedKill";
	// #3526/#3556 review F6: `cwd` alone is not enough. The orchestrator and
	// every subagent that has not entered a worktree run with payload cwd
	// pointed at the SHARED main checkout, which is a path PREFIX of every
	// `.claude/worktrees/*` path -- `pattern.includes(cwd)` was true for
	// `pkill -f '<shared-checkout>.*tlc2'` and it matches every worktree's
	// TLC, the exact harm this rule exists to stop. Scoping is only
	// meaningful from INSIDE a linked worktree (checked the same way {@link
	// classifyGit}'s `git worktree remove` symlink-hazard check already
	// does): the shared main checkout's own `.git` is a directory, never a
	// file, so `looksLikeGitWorktree` is false there and the scoped form
	// never allows from it.
	if (cwd && looksLikeGitWorktree(cwd) && pattern.includes(cwd)) return null;
	return "sharedKill";
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

function repositoryRoot(start) {
	if (!start) return undefined;
	let current = resolve(start);
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function repositoryIdentity(root) {
	if (!root) return undefined;
	const gitEntry = join(root, ".git");
	try {
		if (statSync(gitEntry).isDirectory()) return realpathSync(gitEntry);
		const gitEntryText = readFileSync(gitEntry, "utf8");
		if (gitEntryText.startsWith("gitdir: ")) {
			const gitDir = resolve(root, gitEntryText.slice(8).trim());
			return realpathSync(dirname(dirname(gitDir)));
		}
		return realpathSync(gitEntry);
	} catch {
		return undefined;
	}
}

/**
 * The probe rule is about pi-lens runtime code, not every directory named
 * `clients` or `dist`. Resolve the loaded path from the command's effective
 * cwd and compare repository identity, including linked worktrees. #3680 is
 * the recurrence: `cd` into another repository must not inherit this repo's
 * relative `dist/` spelling.
 */
function loadsPiLensRuntime(fileOrSpecifier, cwd, initialIdentity) {
	// A missing `cd` target is not proof that a relative script belongs to
	// the repository at one of its ancestors. In particular, an unrelated
	// Git repository above that missing path must not make the probe look
	// foreign and therefore safe.
	if (!isAbsolute(fileOrSpecifier) && cwd) {
		try {
			realpathSync(cwd);
		} catch {
			return true;
		}
	}
	const loadedSpelling = isAbsolute(fileOrSpecifier)
		? resolve(fileOrSpecifier)
		: cwd
			? resolve(cwd, fileOrSpecifier)
			: resolve(fileOrSpecifier);
	let loaded;
	try {
		loaded = realpathSync(loadedSpelling);
	} catch {
		try {
			loaded = join(
				realpathSync(dirname(loadedSpelling)),
				basename(loadedSpelling),
			);
		} catch {
			loaded = loadedSpelling;
		}
	}
	const loadedRoot = repositoryRoot(loaded);
	const loadedIdentity = repositoryIdentity(loadedRoot);
	const referenceIdentity =
		initialIdentity ?? repositoryIdentity(repositoryRoot(process.cwd()));
	if (loadedIdentity && referenceIdentity)
		return loadedIdentity === referenceIdentity;
	if (!isAbsolute(fileOrSpecifier)) {
		// The test harness and hook callers may carry a synthetic cwd. A path
		// relative to a cwd that is not present cannot establish ownership, so
		// retain the conservative denial; a real directory outside a repository
		// is the reviewed #3680 allow case.
		try {
			if (!cwd) return true;
			if (cwd && !repositoryRoot(realpathSync(cwd))) return false;
		} catch {
			return true;
		}
	}
	// A relative path from an unknown cwd stays conservative. For an absolute
	// path, the realpath/identity checks above are authoritative when cwd is
	// known; an absent cwd remains conservative through the process-cwd
	// reference identity, while a known foreign cwd must not deny an unrelated
	// path whose repository identity could not be read.
	return !isAbsolute(fileOrSpecifier) || !cwd;
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
	/\b(?:require|import)\s*\(\s*["'`]([^"'`]*(?:clients|dist)\/[^"'`]*)["'`]|\bfrom\s+["'`]([^"'`]*(?:clients|dist)\/[^"'`]*)["'`]/g;

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
 * @param {Record<string, string>} env node's own env, inline `VAR=val` prefix included (the `PI_LENS_HOME` check reads it)
 * @param {string} rawSegment
 * @param {string | null | undefined} cwd
 * @param {string | undefined} initialIdentity
 * @param {Record<string, string>} [expansionEnv] the shell variables bash expanded the file word with: the inline prefix applies only after expansion (#4057)
 * @returns {DenyRule | null}
 */
function classifyNode(
	args,
	env,
	rawSegment,
	cwd,
	initialIdentity,
	expansionEnv = env,
) {
	const hasFlag = args.some(
		(a) =>
			a === "-e" ||
			a === "--eval" ||
			a === "-p" ||
			a === "--input-type" ||
			a.startsWith("--input-type="),
	);
	const fileArgWord = args.find(
		(a) => !a.startsWith("-") && /\.(?:mjs|js)$/.test(a),
	);
	// #3988: the FILE argument is a shell word (`~/r/dist/x.mjs`, `$HOME/…`),
	// so it is expanded like every other path argument, before an inline
	// prefix applies (#4057). Two words are not expanded here, as on master:
	// the `-e`/`-p` payload is matched as raw segment text, though bash still
	// expands a `$NAME` inside a double-quoted payload, and an attached
	// `--require=`/`--import=`/`--loader=` value is a flag to this scan, never
	// the file word.
	const fileArgLoadsRuntimeCode =
		fileArgWord !== undefined &&
		expandShellReadings(fileArgWord, cwd, expansionEnv).some(
			(fileArg) =>
				(fileArgUnderDir(fileArg, "clients") ||
					fileArgUnderDir(fileArg, "dist")) &&
				loadsPiLensRuntime(fileArg, cwd, initialIdentity),
		);
	const evalPayloadLoadsRuntimeCode =
		hasFlag &&
		[...rawSegment.matchAll(RUNTIME_LOAD_PATTERN)].some((match) =>
			loadsPiLensRuntime(match[1] ?? match[2], cwd, initialIdentity),
		);
	if (!fileArgLoadsRuntimeCode && !evalPayloadLoadsRuntimeCode) return null;
	if ("PI_LENS_HOME" in env) return null;
	if ("PI_LENS_HOME" in process.env) return null;
	return "probe";
}

/**
 * The environment variables Node's `os.tmpdir()` consults. MEASURED, not
 * assumed -- one child process per variable on node v22.22.1 (this repo's
 * runtime), Linux: `TMPDIR=/a` -> `/a`, `TMP=/b` -> `/b`, `TEMP=/c` ->
 * `/c`, all three set -> `/a`, none -> `/tmp`. All three reach the harness,
 * so the guard covers all three rather than only the one the incident used.
 */
const TEMP_DIR_VARS = ["TMPDIR", "TMP", "TEMP"];

/**
 * The directory name docs/invariants/paths-os.md "Paths, data, and operating systems"
 * prescribes for a pinned `PI_LENS_HOME` (and the {@link RULE_MESSAGES}.probe message
 * hands out).
 */
const HARNESS_HOME_SEGMENT = ".probe-home";

/** `$PI_LENS_HOME` / `${PI_LENS_HOME}` -- the same directory under its
 *  variable spelling, which is what an agent reaches for right after
 *  reading the `probe` rule's message. The name boundary matters: without
 *  it `$PI_LENS_HOME_TMP` and `$PI_LENS_HOMEDIR/x` -- different variables,
 *  naming different directories -- were both denied (review round 2 T3). */
const HARNESS_HOME_VARIABLE =
	/\$\{PI_LENS_HOME\}|\$PI_LENS_HOME(?![A-Za-z0-9_])/;

/**
 * Deny a `TMPDIR`/`TMP`/`TEMP` assignment that aims Node's temp directory
 * at the vitest harness's own `PI_LENS_HOME` (#3026, 2026-09-15).
 *
 * `tests/support/vitest-setup.ts` deliberately keeps the REAL `TMPDIR` and
 * mkdtemps the per-worker `PI_LENS_HOME` under `os.tmpdir()`. Point
 * `TMPDIR` at `<worktree>/.probe-home` and that home lands inside the
 * checkout, in a directory `.gitignore` ignores -- so every suite whose
 * fixtures live under `os.tmpdir()` is suddenly reading ignored paths. The
 * #3026 fixer did exactly that and reported "16 suites red on
 * origin/master"; the tree was green. Measured again on this branch:
 * `tests/clients/ext-gate-before-ignore.test.ts` is 8/8 green with TMPDIR
 * elsewhere and 7 failed / 1 passed with `TMPDIR=$PWD/.probe-home`, same
 * build, same tree.
 *
 * Matching is by path SEGMENT ({@link fileArgUnderDir}), never substring,
 * so `$PWD/.probe-home`, `/abs/.probe-home` and `.probe-home/sub` all
 * match while `.probe-home-2` does not.
 *
 * Known limit (review round 2): the offending path has to appear in the
 * assignment's own text. A third variable hides it --
 * `export PROBE_HOME=$PWD/.probe-home; export TMPDIR=$PROBE_HOME` allows,
 * because resolving it would mean evaluating the shell's variable
 * environment, which this static scan does not do (the same class as the
 * header's "command word assembled by expansion" blind spot).
 *
 * @param {Record<string, string>} env
 * @returns {DenyRule | null}
 */
function classifyTempDirVars(env) {
	for (const name of TEMP_DIR_VARS) {
		const value = env[name];
		if (value === undefined) continue;
		if (fileArgUnderDir(value, HARNESS_HOME_SEGMENT)) return "tmpdirCollision";
		if (HARNESS_HOME_VARIABLE.test(value)) return "tmpdirCollision";
	}
	return null;
}

/**
 * Words that just mean "run the following command", stripped before the
 * command word is identified. `command`/`exec`/`env` came from review
 * round 2 F7; `sudo`/`time` from round 3's V5 (both confirmed against real
 * bash to run their argument). Only the BARE forms are handled -- a prefix
 * carrying its own options (`sudo -u root`, `nice -n 10`, `timeout 30`) is
 * in the header's NOT-handled list.
 */
const RUNNER_PREFIX_WORDS = new Set(["command", "exec", "env", "sudo", "time"]);

/**
 * Reserved words and operators after which bash runs the NEXT word as a
 * command (#3787, each probed in bash 5.3: the side effect happened). Not
 * `case`/`esac`/`fi`/`done`/`in`/`select`: they run nothing at that word, and
 * a `case` arm is split off by its `)`. {@link lexRegions} reads the same set
 * (plus `time`, minus `coproc`) for the words after which a `case` still sits
 * at a command position (#4060).
 */
const COMMAND_KEYWORDS = new Set([
	"{",
	"!",
	"do",
	"then",
	"else",
	"elif",
	"if",
	"while",
	"until",
	"coproc",
]);

/**
 * Compound-command words a coproc name may precede and whose next word bash
 * runs (#3787 review, each probed in bash 5.3). `for`, `case` and `(` take
 * a name too, but their commands land in later segments.
 */
const COPROC_NAMED_BODY_WORDS = new Set(["{", "if", "while", "until"]);

/**
 * Strip any leading `{` brace, shell keyword ({@link COMMAND_KEYWORDS}) and
 * runner-prefix words, in any order and repeated, so `command env git stash`,
 * `{ sudo git stash` and `do git stash` all resolve to `git stash`. `env`'s
 * own `FOO=bar` assignments (if any) still parse correctly afterward via
 * {@link stripEnvAssignments} once `env` itself is dropped.
 *
 * @param {string[]} words
 * @returns {string[]}
 */
export function stripCommandGroupAndRunnerPrefixes(words) {
	let i = 0;
	while (i < words.length) {
		if (words[i] === "coproc") {
			// A coprocess may have an optional name before a compound
			// command: `coproc C { git stash; }`, `coproc C if git stash`.
			// Strip that name only when the following word makes the form
			// unambiguous; the ordinary `coproc git stash` keeps `git` as
			// the command word.
			if (
				COPROC_NAMED_BODY_WORDS.has(words[i + 2]) &&
				canFormCoprocIdentifier(
					words[i + 1],
					words[WORD_EXPANSIONS]?.[i + 1] ?? [],
				)
			) {
				// Runtime expansions may form a valid name; literal text around
				// them must remain identifier characters.
				i += 2;
				continue;
			}
		}
		if (COMMAND_KEYWORDS.has(words[i]) || RUNNER_PREFIX_WORDS.has(words[i])) {
			i++;
			continue;
		}
		break;
	}
	return words.slice(i);
}

/**
 * The final path segment of a command word -- so `/usr/bin/git`, `./git`,
 * and `git` all resolve to the same command name (#2699 review round 2 F7).
 *
 * @param {string} cmd
 * @returns {string}
 */
export function commandBasename(cmd) {
	const idx = Math.max(cmd.lastIndexOf("/"), cmd.lastIndexOf("\\"));
	return idx === -1 ? cmd : cmd.slice(idx + 1);
}

/**
 * Classify one segment. `sharedEnv` carries `export VAR=val` (or a
 * standalone `VAR=val` with no command on the same segment) assignments
 * forward to LATER segments in the same {@link findDeny} scan (#2699 review
 * round 2 F2: AGENTS.md sanctions `export PI_LENS_HOME=<worktree>/.probe-home`
 * as an earlier `;`/newline-separated segment, not only as this segment's
 * own prefix or `process.env`). The `export` builtin NEVER runs a trailing
 * command in real bash -- any word after its assignments is another (bare)
 * name marked for export, not a command -- so a segment starting with
 * `export` always terminates here, persisting into `sharedEnv` (mutated in
 * place) and returning `null`. A NON-exported `FOO=bar cmd` prefix, by
 * contrast, applies only to THIS segment's own command (matching real
 * bash), merged into the `effectiveEnv` passed to {@link classifyNode}.
 *
 * @param {string} rawSegment
 * @param {Record<string, string>} sharedEnv
 * @param {string | null} [cwd] the command's effective cwd (the PreToolUse payload's own, moved by any earlier `cd`; `null` once a `cd` could not be resolved), for the path-argument rules' {@link resolveShellPath}
 * @returns {DenyRule | null}
 */
export function classifySegment(
	rawSegment,
	sharedEnv = {},
	cwd,
	originCwd = cwd,
) {
	const rawWords = splitWords(rawSegment);
	if (rawWords.length === 0) return null;
	const words = stripCommandGroupAndRunnerPrefixes(rawWords);
	if (words.length === 0) return null;
	if (words[0] === "export") {
		const { env: exported } = stripEnvAssignments(words.slice(1));
		Object.assign(sharedEnv, exported);
		return classifyTempDirVars(exported);
	}
	const { env: segmentEnv, rest } = stripEnvAssignments(words);
	// Before the command dispatch: the #3026 incident's own command was
	// `TMPDIR=$PWD/.probe-home npx vitest run …`, and `npx` is a command this
	// guard classifies as nothing at all. The assignment is the offence, so
	// it is judged where it is written, whatever follows it.
	const tempDirCollision = classifyTempDirVars(segmentEnv);
	if (tempDirCollision) return tempDirCollision;
	// #4348: a write under /tmp, judged for every command (a redirection
	// belongs to the segment, not to one program) before the per-command rules.
	const tmpWrite = classifyTmpWrite(
		rawWords,
		commandBasename(rest[0] ?? ""),
		rest.slice(1),
		cwd,
		sharedEnv,
	);
	if (tmpWrite) return tmpWrite;
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
	// git, node and mktemp read their env with the inline prefix (`HUSKY=0 git
	// commit`, `PI_LENS_HOME=…`, GNU mktemp's default `$TMPDIR`), but bash expanded
	// their path words before that prefix applied (#3997 H1, F4; #4057).
	if (cmd === "git") return classifyGit(args, cwd, effectiveEnv, sharedEnv);
	if (cmd === "node" || cmd === "nodejs")
		return classifyNode(
			args,
			effectiveEnv,
			rawSegment,
			cwd,
			repositoryIdentity(repositoryRoot(originCwd)),
			sharedEnv,
		);
	// #4044: a `cd` this scan could not resolve leaves `cwd === null`. The
	// node_modules rules then judge the PAYLOAD cwd, failing closed: a linked
	// lane stays denied after `cd $(pwd) && npm ci`, and the hook's own cwd
	// (a real node_modules) is never the answer.
	const projectCwd = cwd ?? originCwd ?? undefined;
	if (cmd === "npm" || cmd === "npx")
		return classifyNpm(cmd, args, projectCwd, sharedEnv);
	if (cmd === "find" || DELETE_COMMANDS.has(cmd))
		return classifyNodeModulesDelete(cmd, args, projectCwd, sharedEnv);
	if (cmd === "mktemp")
		return classifyMktemp(args, cwd, effectiveEnv, sharedEnv);
	if (SHARED_KILL_COMMANDS.has(cmd))
		return classifyPkillKillall(cmd, args, cwd);
	return null;
}

/**
 * {@link splitSegments}'s sibling for #3471's `checkUngated` rule: the same
 * split, but each segment carries the separator text that preceded it
 * (`null` for the region's first segment). `&&`/`||` fall out of {@link
 * SEGMENT_SEPARATOR} as two consecutive single-char separators with an
 * EMPTY segment between them (splitSegments discards that empty segment;
 * here its two characters are accumulated into `pendingSep` instead of
 * being dropped, so they reach the NEXT real segment as one two-character
 * string) -- `splitSegments` itself is left untouched because existing
 * tests pin its plain string-array return shape.
 *
 * @param {string} region
 * @returns {Array<{ text: string; sep: string | null }>}
 */
export function splitSegmentsWithSeparators(region) {
	/** @type {Array<{ text: string; sep: string | null }>} */
	const segments = [];
	let buf = "";
	/** @type {"single"|"double"|null} */
	let quote = null;
	let pendingSep = "";
	let i = 0;
	const push = () => {
		if (buf.trim()) {
			segments.push({ text: buf, sep: pendingSep || null });
			pendingSep = "";
		}
		buf = "";
	};
	while (i < region.length) {
		const ch = region[i];
		if (quote === "single") {
			buf += ch;
			if (ch === "'") quote = null;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < region.length) {
			buf += ch + region[i + 1];
			i += 2;
			continue;
		}
		if (quote === "double") {
			buf += ch;
			if (ch === '"') quote = null;
			i++;
			continue;
		}
		if (ch === "$" && region[i + 1] === "'") {
			// ANSI-C quote: `\'` stays inside it, as splitWords reads it (#4060).
			let end = i + 2;
			while (end < region.length && region[end] !== "'")
				end += region[end] === "\\" ? 2 : 1;
			buf += region.slice(i, end + 1);
			i = end + 1;
			continue;
		}
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
		if (isLiveSeparator(region, i)) {
			push();
			pendingSep += ch;
			i++;
			continue;
		}
		buf += ch;
		i++;
	}
	push();
	return segments;
}

/** `npm run <script>` scripts #3471 treats as a "check" -- named in the
 *  issue itself, not a spelling-enumerated guess. */
const CHECK_NPM_SCRIPTS = new Set([
	"lint",
	"build",
	"test",
	"fmt:check",
	"preflight",
]);

/**
 * Does `fileArg` name a `scripts/check-*.mjs` file -- segment-membership
 * check for the directory (reusing {@link fileArgUnderDir}, so a leading
 * `./` or an absolute path is still recognized) plus a basename pattern for
 * the `check-*.mjs` part.
 *
 * @param {string} fileArg
 * @returns {boolean}
 */
function isCheckScriptPath(fileArg) {
	const segments = fileArg.split(/[\\/]+/);
	const base = segments[segments.length - 1];
	return (
		fileArgUnderDir(fileArg, "scripts") && /^check-[^/\\]*\.mjs$/.test(base)
	);
}

/**
 * Classify one segment as a #3471 "check" or "write" (a `git commit`/
 * `git push`), or neither. A "check" is exactly the set the issue names:
 * `npm run (lint|build|test|fmt:check|preflight)`, `npx vitest`, `tsc`, or
 * `node scripts/check-*.mjs`.
 *
 * @param {string} rawSegment
 * @returns {"check" | "write" | null}
 */
function classifyCheckOrWrite(rawSegment) {
	const rawWords = splitWords(rawSegment);
	if (rawWords.length === 0) return null;
	// A keyword-led segment is neither (#3787): stripping `if`/`while`/`until`
	// would turn a loop's own condition into a "check" that its `;`-joined
	// `done`/`fi` never gates, and deny `until npm test; do …; done && git
	// push`. Control flow is writeIsInsideControlFlow's job here.
	if (rawWords[0] !== "{" && COMMAND_KEYWORDS.has(rawWords[0])) return null;
	const words = stripCommandGroupAndRunnerPrefixes(rawWords);
	if (words.length === 0) return null;
	const { rest: afterEnv } = stripEnvAssignments(words);
	if (afterEnv.length === 0) return null;
	// `timeout <duration> <command>…` (bare form only, no options before the
	// duration -- #3526 review F4: this repo's own vitest convention is
	// `timeout 400 node_modules/.bin/vitest run …`, and 33 corpus rows use
	// it. A `timeout` carrying its own options stops the search, the same
	// documented-blind-spot shape as this file's other runner prefixes.
	const rest = afterEnv[0] === "timeout" ? afterEnv.slice(2) : afterEnv;
	if (rest.length === 0) return null;
	const cmd = commandBasename(rest[0]);
	const args = rest.slice(1);
	if (cmd === "git") {
		const i = gitSubcommandIndex(args);
		const subcommand = args[i];
		if (subcommand === "commit" || subcommand === "push") return "write";
		return null;
	}
	if (
		cmd === "npm" &&
		((args[0] === "run" && CHECK_NPM_SCRIPTS.has(args[1])) ||
			args[0] === "test" ||
			args[0] === "t")
	)
		return "check";
	if (cmd === "npx" && args[0] === "vitest") return "check";
	// A bare `vitest`/`node_modules/.bin/vitest` (#3526 review F4: 33 corpus
	// rows use the `.bin/vitest` spelling, none of them `npx vitest`) --
	// resolved by {@link commandBasename} the same way `/usr/bin/git` already
	// resolves to `git`.
	if (cmd === "vitest") return "check";
	if (cmd === "tsc") return "check";
	if (cmd === "node" || cmd === "nodejs") {
		const scriptArg = args.find((a) => !a.startsWith("-"));
		if (scriptArg !== undefined && isCheckScriptPath(scriptArg)) return "check";
	}
	return null;
}

/**
 * Bash keywords that OPEN a control-flow construct still active at the
 * point they appear -- `then`/`elif`/`else`/`do` mark being INSIDE an
 * `if`/`while`/`until`/`for`/`case` body, and a bare `if`/`while`/`until`/
 * `case` starting a segment is the same (its own `then`/`do` may be on the
 * SAME segment, `if cond; then`, already past by the time a later segment
 * is reached). Found auditing the REAL 2026-09-07..08 transcript corpus
 * (the PR body has the transcript): this repo's own convention for running
 * a check, saving its status, and deciding afterward is `vexit=$?; …; if
 * [ $vexit -eq 0 ]; then git add … && git commit … && git push …; fi` --
 * the commit IS properly gated, just not through `&&`, and a chain scan
 * that only understands `;`/`|`/`&&` cannot tell that apart from an
 * actually-ungated write.
 */
const CONTROL_FLOW_OPENERS = new Set([
	"if",
	"then",
	"elif",
	"else",
	"while",
	"until",
	"case",
	"do",
]);

/**
 * Bash keywords that CLOSE a control-flow construct -- `fi`/`done`/`esac`.
 * Walking backward from a write, hitting one of these before any {@link
 * CONTROL_FLOW_OPENERS} word means a construct closed BEFORE the write, so
 * it does not enclose it (#3526 review F3: `… for f in a; do :; done; git
 * push` and `… for f in a; do :; done; git push` -- an EARLIER, unrelated
 * `for…do…done` loop must not exempt a later, real ungated write; the whole-
 * region skip this replaces could not tell the difference).
 */
const CONTROL_FLOW_CLOSERS = new Set(["fi", "done", "esac"]);

/**
 * Is the write at `segments[j]` inside an unclosed control-flow construct?
 * Walks backward from `j` (the WHOLE region, not stopping at an earlier
 * write the way the check-search below does -- a shell construct's scope is
 * lexical, not reset by a completed commit/push inside it) for the nearest
 * segment whose first word is a {@link CONTROL_FLOW_OPENERS} or {@link
 * CONTROL_FLOW_CLOSERS} word. An opener found first means the write sits
 * inside that construct (own the check inside it too, so this scan stands
 * aside rather than guess at how it is really gated); a closer found first
 * means the nearest construct already ended, so it does NOT enclose the
 * write and the normal chain scan applies.
 *
 * @param {Array<{ text: string; sep: string | null }>} segments
 * @param {number} j
 * @returns {boolean}
 */
function writeIsInsideControlFlow(segments, j) {
	for (let m = j - 1; m >= 0; m--) {
		const first = segments[m].text.trim().split(/\s+/, 1)[0];
		if (first === undefined) continue;
		if (CONTROL_FLOW_CLOSERS.has(first)) return false;
		if (CONTROL_FLOW_OPENERS.has(first)) return true;
	}
	return false;
}

/**
 * #3471's `checkUngated` rule: scan one region's separator-tagged segments
 * for a `git commit`/`git push` ("write") segment whose NEAREST preceding
 * "check" segment is not connected to it by an unbroken chain of `&&`
 * separators. The backward search for that nearest check STOPS at an
 * earlier write (a completed commit/push is a fresh boundary -- #3471's own
 * proposal is about a check's result never gating ITS OWN following write,
 * not every write for the rest of the command; this is also what keeps an
 * ordinary `git commit -m x; git status` -- a sequential status check after
 * a commit, with no check anywhere -- allowed: no check precedes it at all,
 * so no write is judged).
 *
 * A `null` return for a write with NO preceding check (case 3 of #3471: a
 * bare `git push` with nothing gating it because nothing was ever supposed
 * to) is deliberate, not a gap this scan tries to close -- see the PR body
 * for why a general "a write must be command-final or &&-only" rule was
 * rejected (it denies that same sanctioned pattern).
 *
 * {@link writeIsInsideControlFlow} exempts a write PER-WRITE, not per-region
 * (#3526 review F3): a region can carry an earlier, CLOSED control-flow
 * construct (a `for…do…done` loop that finished before the check even
 * starts) alongside a later, genuinely ungated check-then-write that must
 * still deny -- a whole-region skip could not tell the two apart.
 *
 * @param {Array<{ text: string; sep: string | null }>} segments
 * @returns {DenyRule | null}
 */
function findUngatedWriteInChain(segments) {
	const shapes = segments.map((s) => classifyCheckOrWrite(s.text));
	for (let j = 0; j < segments.length; j++) {
		if (shapes[j] !== "write") continue;
		if (writeIsInsideControlFlow(segments, j)) continue;
		let k = -1;
		for (let m = j - 1; m >= 0; m--) {
			if (shapes[m] === "check") {
				k = m;
				break;
			}
			if (shapes[m] === "write") break;
		}
		if (k === -1) continue;
		let gated = true;
		for (let n = k + 1; n <= j; n++) {
			if (segments[n].sep !== "&&") {
				gated = false;
				break;
			}
		}
		if (!gated) return "checkUngated";
	}
	return null;
}

/**
 * #3883: a pipeline's `$?` is the status of its last command, not
 * ci-verdict's verdict. Recognize both orderings that make that mistake look
 * plausible: `ci-verdict | tail; echo $?`. Capturing with
 * `ci-verdict; echo $? | tail` happens before the pipe and remains allowed.
 *
 * F6 (round 2): also recognize the `timeout N node …` and
 * `node --flag …` wrappers, the `${?}` spelling, and `|&`; allow a
 * pipe-polluted `$?` once `set -o pipefail` is in force before the pipeline,
 * and allow a single-quoted `'$?'` (literal text to bash).
 *
 * @param {Array<{ text: string; sep: string | null }>} segments
 * @returns {DenyRule | null}
 */
function findPipedCiVerdictStatusRead(segments) {
	const isCiVerdict = (text) => {
		const words = stripCommandGroupAndRunnerPrefixes(splitWords(text));
		// `env FOO=bar` / `FOO=bar` before the wrapper still parse as prefixes.
		let { rest } = stripEnvAssignments(words);
		// `timeout <duration> node …` runs the node command it wraps; drop the
		// wrapper and its options/duration before looking for `node` (#3883 F6).
		// `-s`/`--signal` and `-k`/`--kill-after` each take their own argument,
		// so consume it too or the duration read lands on the signal
		// (`timeout -s KILL 600 node …`, #3883 R2).
		if (rest[0] === "timeout") {
			const takesArgument = (word) =>
				word === "-s" ||
				word === "--signal" ||
				word === "-k" ||
				word === "--kill-after";
			let i = 1;
			while (i < rest.length && rest[i].startsWith("-")) {
				i += takesArgument(rest[i]) ? 2 : 1;
			}
			i += 1; // the duration argument
			rest = rest.slice(i);
		}
		if (rest[0] !== "node" && rest[0] !== "nodejs") return false;
		// A node flag before the script path (`node --no-warnings …`) must not
		// hide it: the script is a non-flag word ending in the ci-verdict path.
		return rest
			.slice(1)
			.some(
				(word) =>
					!word.startsWith("-") &&
					/(?:^|[/\\])scripts[/\\]ci-verdict\.mjs$/.test(word),
			);
	};
	// A `$?` inside single quotes is literal text to bash, not the status; the
	// `${?}` spelling still reads it in every other context (#3883 F6). The
	// scan tracks double quotes too, so an apostrophe INSIDE a double-quoted
	// string (`echo "it's $? ok"`) does not open a phantom single-quote span
	// that hides the expansion (#3883 R2).
	const readsStatus = (text) => {
		let unquoted = "";
		let inSingle = false;
		let inDouble = false;
		for (const ch of text) {
			if (ch === "'" && !inDouble) {
				inSingle = !inSingle;
				continue;
			}
			if (ch === '"' && !inSingle) {
				inDouble = !inDouble;
				unquoted += ch;
				continue;
			}
			if (!inSingle) unquoted += ch;
		}
		return unquoted.includes("$?") || unquoted.includes("${?}");
	};
	// `set -o pipefail` makes the pipeline's `$?` the real status, so a command
	// that enables it before the pipeline is not the mistake this rule exists
	// for; `set +o pipefail` DISABLES it again, and a later disable undoes an
	// earlier enable (#3883 F6, R2).
	const pipefailSetting = (text) => {
		const { rest } = stripEnvAssignments(
			stripCommandGroupAndRunnerPrefixes(splitWords(text)),
		);
		if (rest[0] !== "set") return null;
		for (let j = 1; j < rest.length; j++) {
			const token = rest[j];
			if (!/^[-+][A-Za-z]*o$/.test(token)) continue;
			if (rest[j + 1] !== "pipefail") continue;
			return token[0] === "-";
		}
		return null;
	};
	let pipefail = false;
	for (let i = 0; i < segments.length; i++) {
		if (!isCiVerdict(segments[i].text)) {
			const setting = pipefailSetting(segments[i].text);
			if (setting !== null) pipefail = setting;
			continue;
		}
		// Only a pipefail in force BEFORE this command changes what `$?` means.
		if (pipefail) continue;
		for (let pipe = i + 1; pipe < segments.length; pipe++) {
			const sep = segments[pipe].sep;
			if (sep !== "|" && sep !== "|&") continue;
			if (segments.slice(pipe + 1).some((segment) => readsStatus(segment.text)))
				return "ciVerdictStatus";
		}
	}
	return null;
}

/**
 * Scan a full Bash command for the first denied rule: every executable
 * region {@link scannableRegions} found, split into segments and
 * classified. The top-level region runs first and accumulates `export`ed
 * assignments; each substitution region then starts from a COPY of that
 * state -- an approximation of bash's left-to-right export visibility, not
 * a fully-ordered interleaving with what appears textually inside a
 * `$( )`/backtick span (#2699 review round 2 F2). #3471's chain scan runs
 * per region too, ahead of the per-segment classification, since it needs
 * every segment of the region at once rather than one at a time.
 *
 * A substitution's output is not statically known (#3997), so a command
 * holding one is scanned in two readings, and the first deny wins: the
 * UNKNOWN reading keeps each {@link SUBSTITUTION_MARK} as one opaque piece of
 * word text (no rule word matches it, and a path holding it cannot be
 * resolved), then the EMPTY reading removes the marks -- the text master
 * scanned, where an unquoted word made only of substitutions vanishes, as
 * bash drops an empty unquoted expansion. Either reading alone misses a
 * hazard: `git $(:) stash` is only `git stash` when the output is empty, and
 * `git worktree remove $(echo wt)` only names a path when it is not.
 *
 * @param {string} commandText
 * @param {string} [cwd] the PreToolUse payload's own cwd, threaded to every segment
 * @returns {DenyRule | null}
 */
export function findDeny(commandText, cwd) {
	const unknownReading = scannableRegions(commandText);
	if (unknownReading.includes(UNSCANNABLE_CASE)) return "unscannableCase";
	const readings = unknownReading.some((region) =>
		region.includes(SUBSTITUTION_MARK),
	)
		? [
				unknownReading,
				unknownReading.map((region) =>
					region.replaceAll(SUBSTITUTION_MARK, ""),
				),
			]
		: [unknownReading];
	for (const regions of readings) {
		/** @type {Record<string, string>} */
		const sharedEnv = {};
		for (let index = 0; index < regions.length; index++) {
			const env = index === 0 ? sharedEnv : { ...sharedEnv };
			/** @type {string | null | undefined} */
			let effectiveCwd = cwd;
			/** @type {string | null | undefined} every `cd` read logically, as before #4060: after `cd -P lnk` the physical path no longer names the link, so `cd -P node_modules && rm -rf *` stays denied only through this second reading */
			let logicalCwd = cwd;
			/** @type {Array<[string | null | undefined, string | null | undefined]>} the cwds to restore at each `)`: a `( cd x && … )` subshell's `cd` never leaks out */
			const subshellCwds = [];
			const segments = splitSegmentsWithSeparators(regions[index]);
			const ciVerdictRule = findPipedCiVerdictStatusRead(segments);
			if (ciVerdictRule) return ciVerdictRule;
			const chainRule = findUngatedWriteInChain(segments);
			if (chainRule) return chainRule;
			for (const { text: segment, sep } of segments) {
				for (const ch of sep ?? "") {
					if (ch === "(") subshellCwds.push([effectiveCwd, logicalCwd]);
					else if (ch === ")" && subshellCwds.length > 0)
						[effectiveCwd, logicalCwd] = subshellCwds.pop();
				}
				const rule =
					classifySegment(segment, env, effectiveCwd, cwd) ??
					(logicalCwd === effectiveCwd
						? null
						: classifySegment(segment, env, logicalCwd, cwd));
				if (rule) return rule;
				effectiveCwd = cwdAfterSegment(segment, effectiveCwd, env);
				logicalCwd = cwdAfterSegment(segment, logicalCwd, env, false);
			}
		}
	}
	return null;
}

/**
 * The effective cwd after one segment runs: moved by `cd <dir>`/`pushd <dir>`
 * (flags `-L`/`-P`/`-e`/`-@` and `--` skipped; a bare `cd` is `~`), through
 * {@link resolveShellPath} like every other path argument (#3988). `null`
 * (statically unknown) after a target that cannot be resolved, `cd -`, a bare
 * `pushd` (swaps with the stack) or `popd`; a later absolute `cd` recovers a
 * known cwd. Assumes the `cd` succeeded and is not backgrounded or piped
 * (documented blind spot: `cd x & …`, `cd x | …`). The target resolves
 * logically, or physically when the last of `-L`/`-P` is `-P` (#4060; `set -P`
 * and `set -o physical` are not read). {@link findDeny} also reads every `cd`
 * logically (`honorPhysical` false), because a physical cwd no longer names the
 * link it came through. `pushd` has no `-P` (bash rejects it), so a `pushd -P`
 * is resolved logically like any `pushd`.
 *
 * @param {string} segment
 * @param {string | null | undefined} cwd
 * @param {Record<string, string>} env
 * @param {boolean} [honorPhysical] `false` reads every `cd` logically ({@link findDeny}'s second reading)
 * @returns {string | null | undefined}
 */
function cwdAfterSegment(segment, cwd, env, honorPhysical = true) {
	const words = stripCommandGroupAndRunnerPrefixes(splitWords(segment));
	const command = words[0];
	if (command === "popd") return null;
	if (command !== "cd" && command !== "pushd") return cwd;
	let k = 1;
	let physical = false;
	while (k < words.length && /^-[LPe@]+$/.test(words[k])) {
		// The last of -L/-P wins, clustered or not (`-LP` is physical, `-PL` logical).
		for (const flag of words[k])
			if (flag === "L" || flag === "P")
				physical = honorPhysical && command === "cd" && flag === "P";
		k++;
	}
	if (words[k] === "--") k++;
	const target = words[k] ?? (command === "cd" ? "~" : undefined);
	if (target === undefined || target === "-") return null;
	// Logical, like bash's default `cd -L`: `cd lnk/..` lands beside `lnk`;
	// `cd -P` follows `lnk` first (#4060).
	const resolved = resolveShellPath(target, cwd, env, !physical);
	return resolved.reason === undefined ? resolved.path : null;
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
	const p =
		/** @type {{ tool_name?: unknown; tool_input?: unknown; cwd?: unknown }} */ (
			payload
		);
	if (p.tool_name !== "Bash") return null;
	const toolInput = p.tool_input;
	if (!toolInput || typeof toolInput !== "object") return null;
	const command = /** @type {{ command?: unknown }} */ (toolInput).command;
	if (typeof command !== "string" || !command.trim()) return null;
	const cwd = typeof p.cwd === "string" ? p.cwd : undefined;
	return findDeny(command, cwd);
}

// #3089: nothing in the stdlib waits for fd 0 to become readable
// synchronously, and a bare retry loop would spin a core while the payload
// is still arriving. `Atomics.wait` is the one sleep that yields the CPU --
// same mechanism scripts/with-memory-watch.mjs uses for its own EAGAIN
// retry on the write side.
const READ_RETRY_SLEEP_MS = 5;
const readRetryPark = new Int32Array(new SharedArrayBuffer(4));

// #3089 review round 2 F3: the three ALLOW-BY-FAILURE paths in run() below
// (empty-or-unparseable raw text, a JSON.parse failure, and this function's
// own crash guard) used to exit 0 with empty stderr -- indistinguishable
// from a genuine "nothing to check" allow, which is exactly why the
// original readFileSync(0) short read was invisible for a release cycle.
// This note fires on the two paths that saw SOME input and failed to make
// sense of it; a genuinely empty stream (nothing ever arrived, no error) is
// still silent -- that is the ordinary "hook invoked with no payload" case,
// not a failure. Used ONLY on the JSON.parse failure path -- the payload
// genuinely could not be parsed there. The crash guard (any other throw,
// including a classifier crash on a payload that WAS read and parsed fine)
// gets its own cause-bearing message instead (#3089 review round 3 N1):
// labeling a classifier crash "unreadable or unparseable" is a wrong label
// on the most important fail-open this hook has -- worse than the silence
// it replaced, because it actively misdescribes what happened.
const UNREADABLE_PAYLOAD_NOTE =
	"guard-bash: payload unreadable or unparseable; allowing\n";

// #3089 review round 3 N2: a closed or read-only stderr fd (EBADF, EPIPE,
// ...) must never turn an intended exit-0 allow into an uncaught-exception
// exit 1. `process.stderr.write` is the wrong primitive to guard here --
// verified directly: it goes through Node's Writable stream machinery,
// which never throws synchronously for an I/O failure (it reports one via
// an async `'error'` event instead), so `try { process.stderr.write(text)
// } catch {}` alone still crashed with exit 1 in the read-only-fd
// reproduction below. `fs.writeSync(2, text)` bypasses that machinery and
// writes the fd directly -- confirmed to throw EBADF SYNCHRONOUSLY for the
// same read-only fd, which a try/catch can actually catch. Every stderr
// write in this file's hook path goes through this helper so a broken
// stderr can never be the thing that blocks (or crashes) the tool -- the
// same "must never throw" promise the file's header already makes for a
// classification crash.
function note(text) {
	try {
		writeSync(2, text);
	} catch {
		// The record is lost, but losing a record must never cost the exit
		// code that record was trying to explain.
	}
}

/**
 * Read stdin synchronously, draining fd 0 to EOF. Never blocks on an
 * interactive terminal. Returns "" for a genuine empty stream (a read that
 * cleanly hits EOF on the first call, no bytes ever seen); THROWS a
 * genuine, non-retryable read error (EBADF, a closed fd, ...) instead of
 * swallowing it, so {@link run}'s own crash guard can tell "nothing to
 * read" apart from "reading failed" and note the latter (review round 2
 * F3) while keeping the never-throws contract at the run() boundary.
 *
 * #3089: `readFileSync(0, "utf8")` fails open on a payload larger than a
 * pipe buffer. Node's spawnSync sets the child's stdin pipe to
 * non-blocking once the parent starts pumping its own synchronous event
 * loop to feed `input`; a `read(2)` issued before the next chunk has
 * landed then returns EAGAIN, `readFileSync` does not retry, and the
 * thrown error was swallowed by this function's own catch-all, returning
 * "" for a payload that was still arriving. Measured on this host,
 * reproducible from ~500 KB: `spawnSync(HOOK, { input })` for a
 * >=1 MB PreToolUse JSON payload throws
 * `EAGAIN: resource temporarily unavailable, read` out of
 * `readFileSync(0, "utf8")`, and the hook exits 0 instead of denying. A
 * `read(2)` loop that retries EAGAIN (this function) and keeps
 * accumulating chunks until a read returns 0 -- true EOF, not "nothing
 * available yet" -- closes that gap regardless of how many chunks the
 * payload arrives in or how far apart in time they land.
 *
 * @returns {string}
 */
function readStdin() {
	if (process.stdin.isTTY) return "";
	const chunks = [];
	const chunk = Buffer.alloc(65536);
	for (;;) {
		let bytesRead;
		try {
			bytesRead = readSync(0, chunk, 0, chunk.length, null);
		} catch (error) {
			if (error?.code === "EAGAIN") {
				Atomics.wait(readRetryPark, 0, 0, READ_RETRY_SLEEP_MS);
				continue;
			}
			// A read error that is not "try again" (EBADF, a closed fd, ...)
			// propagates to run()'s crash guard, which notes it and still
			// exits 0 -- never throws past that boundary.
			throw error;
		}
		if (bytesRead === 0) break; // true EOF: the writer closed its end.
		chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
	}
	return Buffer.concat(chunks).toString("utf8");
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
			note(UNREADABLE_PAYLOAD_NOTE);
			return 0;
		}
		const rule = classifyPayload(payload);
		if (!rule) return 0;
		note(`${RULE_MESSAGES[rule]}\n`);
		return 2;
	} catch (error) {
		// A crash in this hook -- a genuine readStdin() read error (EBADF, a
		// closed fd, ...) OR a classifier crash on a payload that WAS read
		// and parsed fine (the #2699 r3 depth-5000 nesting case throws
		// RangeError here, not in readStdin or JSON.parse) -- must never be
		// the thing that blocks the tool, but it also must not be silently
		// indistinguishable from an ordinary allow (#3089 review round 2
		// F3), and it must not claim the payload was "unreadable or
		// unparseable" when it demonstrably was read and parsed (#3089
		// review round 3 N1) -- error.code (a read error) or error.name (a
		// RangeError, or anything else classification can throw) names the
		// actual cause instead.
		note(
			`guard-bash: ${error?.code ?? error?.name ?? "error"} while checking payload; allowing\n`,
		);
		return 0;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = run();
}
