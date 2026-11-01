// flake-shape: real-process-spawn — the subject IS the guard's own
// stdin/exit-code/stderr contract (what Claude Code's PreToolUse dispatch
// actually invokes); an in-process call to the exported classify functions
// cannot see a drift in that contract. Admitted in vitest.config.ts's
// wallClockBudgetInclude. The transcript harness also pins a bounded
// end-to-end budget for its sampled real hook processes. The scoped-pkill
// cases (#3663 CI round) also spawn real `git` to build a linked-worktree
// fixture, because F6's allow depends on a real linked worktree.
//
// #2699 (refs umbrella #2697): PreToolUse Bash guard hook.
//
// Spawns the real script as a child process with the PreToolUse JSON on
// stdin -- not just the exported classify functions -- because the
// acceptance criterion is the CLI's own stdin/exit-code/stderr contract
// (what Claude Code actually invokes), the same reasoning
// tests/scripts/classify-ci-failure-cli.test.ts documents for its own CLI:
// an in-process call to the exported functions can't notice a drift in the
// stdin shape, the exit code, or which stream carries the message.
//
// Only that wiring needs a child. The verdict-only table rows (the deny and
// allow lists, the #3778 hook-bypass rows, the #3988 path-argument rows) call
// the exported classifyPayload through hookVerdict() under the env the child
// would get, and so does every transcript-corpus row; the spawn cases (the
// pipe-safe ci-verdict message, the tmpWrite exit-2/exit-0 witness, malformed
// JSON, the large-payload drain, the broken stderr and the corpus's denies plus
// every 50th row) pin the stdin, exit-code and stderr wiring those rows skip.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	classifySegment,
	classifyPayload,
	findDeny,
	RULE_MESSAGES,
	scannableRegions,
	splitSegments,
	splitSegmentsWithSeparators,
	splitWords,
	stripEnvAssignments,
} from "../../scripts/hooks/guard-bash.mjs";
import type { DenyRule } from "../../scripts/hooks/guard-bash.d.mts";
import { gitExecFileSync } from "../support/git-fixture-env.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const HOOK = join(repoRoot, "scripts", "hooks", "guard-bash.mjs");

// The PreToolUse payload cwd every test in this file uses by default --
// deliberately NOT `repoRoot` (#3526 review S1). `repoRoot` is wherever
// THIS checkout happens to live, and a reviewer's own worktree convention
// puts that under `/tmp`: run there, and every relative-path exemption
// ALLOW row (".claude/worktrees/…", the "resolves under this worktree's own
// cwd" test) falsely denied, because the same /tmp root that the fix is
// SUPPOSED to catch was also, coincidentally, this suite's own cwd. A fixed,
// synthetic, guaranteed-off-/tmp path makes every relative-resolution
// assertion here true regardless of where the checkout lives -- it never
// needs to exist on disk, since none of guard-bash's path-resolution rules
// touch the filesystem at `cwd` itself (only at a RESOLVED worktree/mktemp
// argument, e.g. the node_modules-symlink-hazard fixtures below, which
// build real directories for exactly that reason).
const PAYLOAD_CWD = "/home/dev/pi-lens-guard-bash-fixed-cwd";

// Every env var this suite's own process runs under, MINUS PI_LENS_HOME --
// so a negative (deny) case can never pass because the outer test runner
// happens to have PI_LENS_HOME set (probe hygiene: this repo's own worktree
// convention sets it for ad-hoc probes), and a positive (PI_LENS_HOME
// ambient) case sets it back deliberately.
//
// HOME is pinned to a synthetic path off /tmp for the same reason as PAYLOAD_CWD
// (#4789 review F1). The vitest worker's own HOME is a scratch directory under
// `os.tmpdir()` (tests/support/vitest-setup.ts), and on every host whose TMPDIR
// is `/tmp` (GitHub runners, most shells) a `~` then expands under /tmp, where
// the guard's own `tmpCheckout` rule denies the `~`-destination allow-list rows.
// A row that needs another HOME overrides it, as `{ ...BASE_ENV, HOME: x }` does.
const BASE_ENV: NodeJS.ProcessEnv = {
	...Object.fromEntries(
		Object.entries(process.env).filter(([key]) => key !== "PI_LENS_HOME"),
	),
	HOME: "/home/dev/guard-bash-hook-base-home",
};

function runHook(
	command: string,
	env: NodeJS.ProcessEnv = BASE_ENV,
	cwd: string = PAYLOAD_CWD,
) {
	return spawnSync(process.execPath, [HOOK], {
		input: JSON.stringify({
			session_id: "test",
			cwd,
			permission_mode: "default",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command },
		}),
		encoding: "utf8",
		env,
	});
}

/**
 * runHook's result for many commands at once: the same PreToolUse payload and
 * the same child, spawned `concurrency` at a time (#3801; the transcript corpus
 * spawned 1122 children one after another while the wall-clock lane leaves the
 * other cores idle). Results come back in input order, so a caller's offense
 * list is as deterministic as the serial loop's.
 */
async function runHooksConcurrently(
	commands: readonly string[],
	env: NodeJS.ProcessEnv,
	concurrency: number,
): Promise<Array<{ status: number | null; stderr: string }>> {
	const results = new Array<{ status: number | null; stderr: string }>(
		commands.length,
	);
	let next = 0;
	const one = (command: string) =>
		new Promise<{ status: number | null; stderr: string }>(
			(resolveRun, rejectRun) => {
				const child = spawn(process.execPath, [HOOK], {
					env,
					stdio: ["pipe", "ignore", "pipe"],
				});
				let stderr = "";
				child.stderr.setEncoding("utf8");
				child.stderr.on("data", (chunk: string) => {
					stderr += chunk;
				});
				child.on("error", rejectRun);
				child.on("close", (status) => resolveRun({ status, stderr }));
				child.stdin.on("error", rejectRun);
				child.stdin.end(
					JSON.stringify({
						session_id: "test",
						cwd: PAYLOAD_CWD,
						permission_mode: "default",
						hook_event_name: "PreToolUse",
						tool_name: "Bash",
						tool_input: { command },
					}),
				);
			},
		);
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (next < commands.length) {
				const at = next++;
				results[at] = await one(commands[at]);
			}
		}),
	);
	return results;
}

/**
 * runHook's verdict without the child: the same PreToolUse payload through the
 * hook's own `classifyPayload`, with `process.env` swapped for exactly the
 * `env` the child would get (the classifier reads `$NAME`, HOME and
 * PI_LENS_HOME from it) and restored before returning. The rule-to-result
 * mapping mirrors run()'s success path only (a throw must red here, where the
 * child would allow with a note); the spawn cases pin run() itself.
 */
function hookVerdict(
	command: string,
	env: NodeJS.ProcessEnv = BASE_ENV,
	cwd: string = PAYLOAD_CWD,
): { status: number; stderr: string } {
	const payload: unknown = JSON.parse(
		JSON.stringify({
			session_id: "test",
			cwd,
			permission_mode: "default",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command },
		}),
	);
	const saved = { ...process.env };
	for (const key of Object.keys(process.env)) delete process.env[key];
	for (const [key, value] of Object.entries(env))
		if (value !== undefined) process.env[key] = value;
	try {
		const rule = classifyPayload(payload);
		return rule
			? { status: 2, stderr: `${RULE_MESSAGES[rule]}\n` }
			: { status: 0, stderr: "" };
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, saved);
	}
}

/**
 * A real `git init` + `git worktree add` fixture: `main` is the main checkout,
 * `<root>/<linkedRelative>` a linked worktree registered with it. Hoisted from
 * the pkill block so the #3988 path-resolver rows reuse it (#3556, #3988).
 */
function makeLinkedWorktreeFixture(linkedRelative = "linked"): {
	root: string;
	main: string;
	linked: string;
} {
	const root = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-git-"));
	const main = join(root, "main");
	const linked = join(root, linkedRelative);
	mkdirSync(main);
	gitExecFileSync("git", ["init", "-q"], { cwd: main });
	writeFileSync(join(main, "README.md"), "fixture\n");
	gitExecFileSync("git", ["add", "README.md"], { cwd: main });
	gitExecFileSync("git", ["commit", "-q", "-m", "seed"], {
		cwd: main,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "pi-lens test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "pi-lens test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	gitExecFileSync("git", ["worktree", "add", "-q", linked], {
		cwd: main,
	});
	return { root, main, linked };
}

// Every deny string the issue lists, with the rule keyword its message must
// name (the acceptance criterion: "assert exit code AND the message names
// the rule").
const DENY_CASES: Array<[command: string, ruleNeedle: string]> = [
	["git push --force origin branch", "force"],
	["git push -f origin branch", "force"],
	// review round 2 F1: an explicit lease must not mask an unconditional
	// force or a +refspec in the same push.
	["git push --force --force-with-lease=b:0123abcd origin HEAD:b", "force"],
	["git push --force-with-lease=b:0123abcd origin +HEAD:b", "force"],
	// review round 2 F4: mirror can delete and overwrite every remote ref.
	["git push --mirror origin", "force"],
	// review round 2 F5: both bundled force spellings and -C must remain
	// visible to the force-push rule.
	["git push -fu origin branch", "force"],
	["git push -uf origin branch", "force"],
	["git -C /tmp/worktree push -f origin branch", "force"],
	["git push --force-with-lease=b:012 origin HEAD:b", "force"],
	["git push --force-with-lease origin branch", "force"],
	["git push --force-with-lease=branch origin branch", "force"],
	["git push --force-w origin branch", "force"],
	["git push --force-with origin branch", "force"],
	["git push --mirr origin", "force"],
	["git push origin +HEAD:branch", "force"],
	["git rebase origin/master", "rebase"],
	// review round 2 F2: every pull/config spelling that enables rebase is
	// denied; explicit false remains an allowed opt-out.
	["git pull --rebase", "rebase"],
	["git pull -r", "rebase"],
	["git pull -vr", "rebase"],
	["git pull --rebase=true", "rebase"],
	["git -c pull.rebase=true pull", "rebase"],
	["git config pull.rebase true", "rebase"],
	["git config branch.main.rebase true", "rebase"],
	// review round 2 F3: finishing a rebase is denied, while abort/quit
	// remain available as recovery exits.
	["git rebase --continue", "rebase"],
	["git rebase --skip", "rebase"],
	["git stash", "stash"],
	["git stash pop", "stash"],
	["git stash apply", "stash"],
	["git stash drop", "stash"],
	["git stash push", "stash"],
	["git -C /tmp/some-worktree stash", "stash"],
	// a quoted -C argument with an internal space must still fuse into ONE
	// word, or the -C pairing misaligns and "stash" is missed.
	['git -C "/tmp/some dir" stash', "stash"],
	["git reset --soft origin/master", "reset"],
	["git reset --soft origin/fix/2699-guard-bash-hook", "reset"],
	["git reset --hard HEAD", "reset"],
	["git reset --hard abc1234", "reset"],
	["git worktree remove -f -f /tmp/tree", "worktree"],
	["git worktree remove --force --force /tmp/tree", "worktree"],
	["git worktree remove -ff /tmp/tree", "worktree"],
	["node -e \"require('./clients/foo.js')\"", "probe"],
	["node --eval \"require('./clients/foo.js')\"", "probe"],
	["node --input-type=module -e \"import('./clients/foo.js')\"", "probe"],
	["node -p \"require('./clients/foo.js')\"", "probe"],
	["node clients/probe.mjs", "probe"],
	["node dist/probe.js", "probe"],
	["nodejs -e \"require('./clients/foo.js')\"", "probe"],
	// nested inside a subshell -- the tokenizer must recurse into $()/backticks.
	["echo $(git stash)", "stash"],
	["echo `git stash`", "stash"],
	// a non-PI_LENS_HOME env assignment must not defeat env-assignment
	// stripping -- the command word search must still land on "node".
	["FOO=bar node -e \"require('./clients/foo.js')\"", "probe"],
	// review round 2 F1: a real command placed AFTER a heredoc's closing
	// delimiter, on the same overall command, is still a live command.
	["cat <<EOF\nharmless text\nEOF\ngit stash", "stash"],
	// review round 2 F4: a leading "./" or an absolute path under clients/
	// must still be recognized (segment membership, not a prefix string).
	["node ./clients/probe.mjs", "probe"],
	// review round 2 F7: runner-prefix words, a path to git, a `-c` global
	// option, a single `&` separator, `{ …; }` grouping, and a backslash-
	// newline continuation must not defeat stash detection.
	["command git stash", "stash"],
	["exec git stash", "stash"],
	["env git stash", "stash"],
	["/usr/bin/git stash", "stash"],
	["./git stash", "stash"],
	["git -c user.name=agent stash", "stash"],
	["cd /tmp & git stash", "stash"],
	["{ git stash; }", "stash"],
	["git \\\nstash", "stash"],
	// review round 3 V5: `sudo` and `time` are runner prefixes -- both
	// confirmed against real bash to run their argument.
	["sudo git stash", "stash"],
	["time git stash", "stash"],
	// review round 3 V3b: a CRLF command text. Before this round the
	// delimiter line "EOF\r" never matched "EOF", so the body ran to
	// end-of-text and silently swallowed the real command after it.
	["cat <<'EOF'\r\nbody\r\nEOF\r\ngit stash", "stash"],
	// review round 3: bash drops a backslash before an ordinary character,
	// so this really does run git stash.
	["\\g\\i\\t stash", "stash"],
	// review round 3: `( … )` command grouping (round 2 documented this as
	// unhandled; segment splitting on the metacharacters makes it free).
	["(cd /tmp && git stash)", "stash"],
	// review round 3 V3a (LX-5-4), through the real CLI: an UNQUOTED
	// heredoc delimiter does not stop bash expanding $( ) in the body --
	// verified by running it with a side-effecting stand-in.
	["cat <<EOF\n$(git stash)\nEOF", "stash"],
	// review round 2 F1: a valid substitution before an unclosed one must
	// remain visible to the guard, because bash expands it before reporting
	// the later malformed substitution.
	["cat <<EOF\n$(git stash)\n$(echo harmless\nEOF\ngit diff", "stash"],
	// verify round 2: the backtick flush is a separate branch in the hook, so
	// it needs its own case -- deleting only that branch left the `$( )` case
	// green while this one allowed.
	["cat <<EOF\n`git stash`\n`echo harmless\nEOF\ngit diff", "stash"],
	// W1 (#2726): a here-string is not a heredoc marker.  The command after
	// it remains live and must still be classified.
	["grep x <<< foo\ngit stash", "stash"],
	// #3026 (2026-09-15), the recurrence this rule prevents: a fixer aimed
	// TMPDIR at the vitest harness's own PI_LENS_HOME, then reported "16
	// suites red on origin/master" from a tree that was green. The command
	// is VERBATIM from that PR body. Measured on this branch:
	// tests/clients/ext-gate-before-ignore.test.ts is 8/8 green with TMPDIR
	// elsewhere and 7 failed / 1 passed with this prefix.
	[
		"TMPDIR=$PWD/.probe-home npx vitest run tests/clients/ext-gate-before-ignore.test.ts",
		"tmpdir",
	],
	// The export spelling of the same offence -- a separate branch of
	// classifySegment (the export builtin never runs a trailing command, so
	// it returns before the command dispatch).
	["export TMPDIR=$PWD/.probe-home && npm test", "tmpdir"],
	// A quoted value, and an absolute path: segment membership, not a
	// $PWD-prefix string match, is what decides.
	['TMPDIR="/home/dev/wt/.probe-home" npm test', "tmpdir"],
	// A directory UNDER the harness home is the same collision.
	["TMPDIR=$PWD/.probe-home/tmp npm test", "tmpdir"],
	// TMP and TEMP reach os.tmpdir() too (measured; see TEMP_DIR_VARS).
	["TMP=$PWD/.probe-home npm test", "tmpdir"],
	["TEMP=$PWD/.probe-home npm test", "tmpdir"],
	// The variable spelling of the same directory -- what an agent reaches
	// for straight after reading the `probe` rule's own message.
	["TMPDIR=$PI_LENS_HOME npx vitest run tests/config", "tmpdir"],
	["TMPDIR=${PI_LENS_HOME}/x npx vitest run tests/config", "tmpdir"],
	["TMPDIR=$PI_LENS_HOME/sub npx vitest run tests/config", "tmpdir"],
	// #3556: pkill/killall with a bare, unscoped pattern -- the acceptance
	// criterion's own reproduction ("The hook refuses `pkill -f tlc2.TLC`").
	["pkill -f tlc2.TLC", "pkill"],
	["pkill tlc2", "pkill"],
	["killall tlc2.TLC", "pkill"],
	["killall -9 vitest", "pkill"],
	// #3526: an absolute /tmp destination for a scratch checkout -- the
	// incident this rule fixes, verbatim.
	["git worktree add /tmp/pi-lens-review-1234", "/tmp"],
	[
		"git clone https://github.com/apmantza/pi-lens /tmp/pi-lens-scratch",
		"/tmp",
	],
	// An absolute mktemp template, or an explicit -p/--tmpdir=, under /tmp --
	// self-contained (unlike the bare "mktemp -d" default, this does not
	// depend on this test runner's own ambient TMPDIR).
	["mktemp -d /tmp/pi-lens-review-XXXXXX", "/tmp"],
	["mktemp -d -p /tmp/scratch foo.XXXXXX", "/tmp"],
	["mktemp --directory --tmpdir=/tmp/scratch foo.XXXXXX", "/tmp"],
	// #3471: a check's exit code lost to `;`/`|` before an unconditional
	// git commit/push -- the issue's own case 1 and case 2, verbatim.
	[
		'npm run lint >/dev/null 2>&1; echo "lint=$?"; git add -A && git commit -m "x"',
		"chained",
	],
	[
		"npx vitest run tests/foo.test.ts 2>&1 | grep -iE 'error|fail'; git add -A && git commit -m x && git push origin y",
		"chained",
	],
	// #3883: a pipeline reads the pipe's status, not ci-verdict's status;
	// the final `ci-verdict: exit` line is the authoritative status instead.
	["node scripts/ci-verdict.mjs 1 | tail; echo $?", "ci-verdict"],
	// #3883 F6: wrappers and spellings the round-1 rule missed.
	["timeout 600 node scripts/ci-verdict.mjs 1 | tail; echo $?", "ci-verdict"],
	[
		"timeout --foreground 600 node scripts/ci-verdict.mjs 1 | tail; echo $?",
		"ci-verdict",
	],
	["node --no-warnings scripts/ci-verdict.mjs 1 | tail; echo $?", "ci-verdict"],
	["node scripts/ci-verdict.mjs 1 | tail; echo ${?}", "ci-verdict"],
	["node scripts/ci-verdict.mjs 1 |& tail; echo $?", "ci-verdict"],
	// #3883 R2: `timeout`'s own options take arguments (`-s KILL`, `-k 5`), so
	// the duration read must not land on the signal.
	[
		"timeout -s KILL 600 node scripts/ci-verdict.mjs 1 | tail; echo $?",
		"ci-verdict",
	],
	[
		"timeout -k 5 600 node scripts/ci-verdict.mjs 1 | tail; echo $?",
		"ci-verdict",
	],
	// #3883 R2: the single-quote stripper must not treat an apostrophe inside a
	// double-quoted string as opening a single-quote span that hides `$?`.
	[
		"node scripts/ci-verdict.mjs 1 | tail; echo \"it's $? ok it's\"",
		"ci-verdict",
	],
	// #3883 R2: `set +o pipefail` DISABLES pipefail, so the pipeline's `$?` is
	// the filter's status again.
	[
		"set +o pipefail; node scripts/ci-verdict.mjs 1 | tail; echo $?",
		"ci-verdict",
	],
];

// Every allow string the issue lists, which must stay green.
const ALLOW_CASES: string[] = [
	"git push",
	"git push origin HEAD:branch",
	"git push --force-with-lease=branch:0123456789abcdef0123456789abcdef01234567 origin HEAD:branch",
	"git rebase --abort",
	"git rebase --quit",
	"git pull --rebase=false",
	"git pull --rebase=no",
	"git pull --rebase=0",
	"git pull --rebase=off",
	"git -c pull.rebase=false pull",
	"git -c pull.rebase=no pull",
	"git -c pull.rebase=0 pull",
	"git -c pull.rebase=off pull",
	"git config pull.rebase false",
	"git config pull.rebase no",
	"git config pull.rebase 0",
	"git config pull.rebase off",
	"git config branch.main.rebase false",
	"git diff > fix.patch",
	"git checkout HEAD -- x",
	"git worktree remove -f /tmp/tree",
	"git worktree remove --force /tmp/tree",
	"git reset HEAD~1",
	"git log --grep=stash",
	'echo "git stash"',
	"PI_LENS_HOME=/x node -e \"require('./clients/foo.js')\"",
	"node scripts/ci-verdict.mjs 1",
	// #3883: piping output without reading `$?` is a valid way to inspect the
	// command's output; only `| tail` shows the final `ci-verdict: exit`
	// line, and this `| head` form reads no status either way.
	"node scripts/ci-verdict.mjs 1 | head",
	// #3883: capture `$?` before sending the captured status through a pipe.
	"node scripts/ci-verdict.mjs 1; echo $? | tail",
	// #3883 F5: a `;`-separated segment between ci-verdict and the `$?` read is
	// not a pipe, so the status is still ci-verdict's own.
	"node scripts/ci-verdict.mjs 1; git status; echo $?",
	// #3883 F6: `set -o pipefail` makes the pipeline's status the real one.
	"set -o pipefail; node scripts/ci-verdict.mjs 1 | tail; echo $?",
	// #3883 R2: a later `set +o pipefail` disables it, and re-enabling after a
	// disable still makes the pipeline's status the real one.
	"set +o pipefail; set -o pipefail; node scripts/ci-verdict.mjs 1 | tail; echo $?",
	// #3883 F6: a single-quoted `'$?'` is literal text, not the status.
	"node scripts/ci-verdict.mjs 1 | tail; echo '$?'",
	// #3723: the sanctioned form of the worktree open/close sequence the
	// hook's worktreeSymlink rule otherwise denies -- a node script, not a
	// hand-typed `git worktree remove`, and it loads no clients/ or dist/ code.
	"node scripts/pr-worktree.mjs open 9001 --head --name review-1",
	"node scripts/pr-worktree.mjs open 9001 --merge",
	"node scripts/pr-worktree.mjs close /home/dev/Desktop/pi-lens-worktrees/review-1",
	// #5111: the one worktree-removal helper the refusals name.
	// a process substitution AFTER the subcommand is classified normally
	"git diff <(true) <(true)",
	"git -C . diff --no-index <(echo a) <(echo b)",
	"node scripts/worktree-remove.mjs /home/dev/wt/lane-1",
	"node scripts/worktree-remove.mjs /home/dev/wt/lane-1 --force",
	"npx vitest run tests/clients/foo.test.ts",
	"npm test",
	"npm run build",
	"echo hi",
	// node with neither an eval flag nor a .mjs/.js file argument, even
	// though the text mentions clients/ -- the flag/file-arg gate, not the
	// clients/dist reference alone, must decide.
	"node -c clients/tsconfig.json",
	// node -e with no clients/ or dist/ reference at all -- the reference
	// gate, not the eval flag alone, must decide.
	'node -e "console.log(1)"',
	// --soft with no origin/ target -- only "--soft origin/<branch>" denies.
	"git reset --soft HEAD~1",
	// worktree subcommand other than "remove" -- the remove check, not a
	// bare "worktree" match, must decide.
	"git worktree list",
	// double-force on a non-"remove" worktree subcommand -- the rule is
	// "remove with two forces", not "worktree with two forces anywhere".
	// (#3526: the path is off /tmp on purpose -- a /tmp destination is its
	// own, unrelated deny, tmpCheckout, pinned separately below.)
	"git worktree add .claude/worktrees/new-tree -f -f",
	// $(...) fully inside single quotes is literal text to bash (no
	// expansion), so the tokenizer must not extract it as a subshell.
	"echo '$(git stash)'",
	// review round 2 F1: the reviewer's own reproduction set -- a heredoc
	// body mentioning a forbidden command (as literal text, or inside a
	// markdown inline-code span) is not a live command, in each of these
	// shapes: a $()-wrapped `cat` heredoc feeding a CLI flag, a bare `cat`
	// redirect, a `git commit -F` heredoc, and a heredoc through a
	// different interpreter (python) whose own quoting happens to also
	// protect it.
	"gh pr create --body \"$(cat <<'EOF'\nSome text mentions `git stash` inline but is not a command.\nEOF\n)\"",
	"cat > CLAUDE.md <<'EOF'\n- `git stash` is forbidden.\nEOF",
	"gh issue comment 2699 --body \"$(cat <<'EOF'\nDo not run `git reset --hard HEAD`.\nEOF\n)\"",
	"git commit -F - <<'EOF'\nfix: mentions `git stash` in the body\nEOF",
	"python3 <<'PYEOF'\nprint(\"do not run git reset --soft origin/master\")\nPYEOF",
	// review round 2 F2: AGENTS.md sanctions `export PI_LENS_HOME=<dir>` as
	// an earlier `;`/newline-separated segment, not only this segment's own
	// prefix or process.env.
	"export PI_LENS_HOME=/x/.probe-home; node -e \"require('./clients/foo.js')\"",
	"export PI_LENS_HOME=/x/.probe-home\nnode -e \"require('./clients/foo.js')\"",
	// review round 2 F4: a leading "./" before scripts/, and an absolute
	// path under scripts/, must still be recognized as exempt.
	"node ./scripts/ci-verdict.mjs 1",
	"node /home/dev/pi-lens/scripts/ci-verdict.mjs 1",
	// review round 2 F5: a payload that MENTIONS "clients/" without
	// actually loading it (the orchestrator's doc-patching idiom) must
	// allow -- only an actual require(/import(/from load specifier denies.
	"node -e \"console.log('note: see clients/ for the service list')\"",
	// review round 3 V1 (LX-6-2), through the real CLI: the exact minimal
	// reproduction the round 2 verify filed -- one unbalanced ")" in a
	// quoted heredoc body used to close the enclosing $( ) span early and
	// leak the rest of the document into the top-level scan.
	"gh pr create --body \"$(cat <<'EOF'\nsmiley :) here\nwe never run `git stash`\nEOF\n)\"",
	// review round 3 (LX-10-1), through the real CLI: a `#` comment.
	"echo hi # $(git stash)",
	// W2 (#2726): real bash does not execute an unclosed substitution in an
	// unquoted heredoc body, but it does continue with a later live command.
	"cat <<EOF\n$(git stash\nEOF\ngit diff",
	"cat <<EOF\n`git stash\nEOF\ngit diff",
	// Real bash reports the malformed outer substitution and does not run a
	// nested substitution inside it.
	"cat <<EOF\n$(echo x\n$(git stash)\nEOF",
	// #3026: the COMPLIANT shapes of the tmpdirCollision rule. TMPDIR aimed
	// at its own directory, with PI_LENS_HOME still pinned at .probe-home
	// exactly as docs/invariants/paths-os.md "Paths, data, and operating systems"
	// prescribes.
	"PI_LENS_HOME=$PWD/.probe-home TMPDIR=$PWD/.tmp-disk npx vitest run tests/config",
	"export TMPDIR=/home/dev/.cache/lane-tmp\nnpx vitest run tests/config",
	// TMPDIR untouched -- the harness keeps the real one on purpose.
	"PI_LENS_HOME=$PWD/.probe-home npx vitest run tests/config",
	// A neighbouring directory whose NAME merely starts with the harness
	// segment is a different directory (segment equality, not prefix).
	"TMPDIR=$PWD/.probe-home-2 npm test",
	// PI_LENS_HOME itself pointed at .probe-home is the PRESCRIBED form and
	// must never be caught by the TMPDIR rule.
	"PI_LENS_HOME=$PWD/.probe-home npm test",
	"export PI_LENS_HOME=$PWD/.probe-home && npm test",
	// Review round 2 T3: a DIFFERENT variable whose name merely starts with
	// PI_LENS_HOME names a different directory. Both were denied before the
	// name boundary landed.
	"TMPDIR=$PI_LENS_HOME_TMP npm test",
	"TMPDIR=$PI_LENS_HOMEDIR/x npm test",
	// Review round 2, named limit: a third variable hides the path from a
	// static scan, so this ALLOWS. The row exists so the limit is a pinned,
	// visible behaviour rather than an untested claim in a docblock.
	"export PROBE_HOME=$PWD/.probe-home; export TMPDIR=$PROBE_HOME; npm test",
	// #3556: `kill <pid>` is a different command from pkill/killall entirely
	// -- the acceptance criterion's own "It allows `kill <pid>`".
	"kill 12345",
	"kill -9 12345",
	// #3526: the acceptance list's own named exemptions. `.claude/worktrees/`
	// is relative, resolved against `PAYLOAD_CWD` (this suite's own default
	// cwd), which is never under /tmp.
	"git worktree add .claude/worktrees/agent-3526-deadbeef",
	"git worktree add ~/.cache/pi-lens-orchestrator/worktrees/agent-x",
	"git worktree add ~/.local/share/pi-lens-orchestrator/tmp/lane-1",
	"git worktree add ~/.plegma/work/sub-1",
	// git clone with no explicit destination -- name-derived, out of scope
	// (documented blind spot: this static scan cannot resolve it).
	"git clone https://github.com/apmantza/pi-lens",
	// git clone WITH an explicit destination, off /tmp.
	"git clone https://github.com/apmantza/pi-lens /home/dev/scratch/pi-lens",
	// mktemp for a FILE (no -d/--directory) is always allowed regardless of
	// where it lands -- even a FILE path that is itself under /tmp.
	"mktemp foo.XXXXXX",
	"mktemp /tmp/pi-lens-review-file.XXXXXX",
	"mktemp",
	// An explicit -p/--tmpdir= OUTSIDE /tmp allows even though the template
	// itself is bare.
	"mktemp -d -p /home/dev/scratch foo.XXXXXX",
	"mktemp -d --tmpdir=/home/dev/scratch foo.XXXXXX",
	// rm/ls/du/find on /tmp are untouched -- this file never classifies them.
	"rm -rf /tmp/pi-lens-review-1234",
	"ls /tmp",
	// #3471: fully `&&`-gated -- the issue's own case 1 and case 2, rewritten.
	'npm run lint >/dev/null 2>&1 && git add -A && git commit -m "x"',
	"npx vitest run tests/foo.test.ts && git add -A && git commit -m x && git push origin y",
	// An ordinary sequential status check after a commit -- no check precedes
	// the commit at all, so nothing is judged. A general "a write must be
	// &&-only or command-final" rule would deny this harmless pattern; see
	// the PR body for why that shape was rejected.
	'git commit -m "x" ; git status',
	// A write gated by an EARLIER write via && -- the boundary-stop search
	// for the nearest check must not reach back past it.
	"npm run lint && git push origin y ; git commit -m x",
	// Gated through shell control flow (`if [ $vexit -eq 0 ]`, this repo's
	// own convention for deciding after saving a check's exit code) rather
	// than `&&` -- unmodeled, so left alone rather than guessed at.
	"npm run build; vexit=$?; if [ $vexit -eq 0 ]; then git commit -m x; fi",
	// A node script that is NOT scripts/check-*.mjs is not a "check".
	"node scripts/build.mjs ; git commit -m x",
	// Two checks, `;`-separated, with NO git commit/push anywhere -- nothing
	// for this rule to judge at all.
	"npm run lint ; npm run build",
];

// The real transcript corpus (#2705) is
// `tests/fixtures/guard-bash/transcript-corpus-2026-09-08.json`, extracted
// from this project's Claude Code session transcripts on 2026-09-06..08 with
// secrets and the maintainer's email scrubbed. The fixture is data under
// tests/fixtures, so test-file sweeps do not walk it as executable code.
const TRANSCRIPT_CORPUS = JSON.parse(
	readFileSync(
		join(
			repoRoot,
			"tests/fixtures/guard-bash/transcript-corpus-2026-09-08.json",
		),
		"utf8",
	),
) as Array<{ command: string; firstSeen: string }>;

const TRANSCRIPT_CORPUS_DATE = "2026-09-07..08";

function commandHash(command: string): string {
	return createHash("sha256").update(command).digest("hex");
}

// These are the only two commands in the 2026-09-07..08 transcript corpus
// that exercise a guard rule. Keep this allowlist independent of findDeny so
// a rule widening cannot silently turn a false positive into an expectation.
//
// #3471's `checkUngated` rule audited the same corpus and found 20 REAL
// historical instances of the exact shape the issue describes: a check
// (`npm run lint`/`build`/`test`, `npx vitest`, `node scripts/check-*.mjs`)
// piped to `grep`/`tail`/`head` -- which replaces its exit status with the
// filter's, almost always 0 -- and/or separated by `;`, with a `git
// commit`/`git push` then running unconditionally (or gated on the WRONG,
// filter's, exit status) rather than on the check's own result. Each one
// was read in full before pinning (the PR body quotes one representative
// example, `ff582cb3…`, in full; the rest are read and reasoned about
// individually, not re-quoted). None is gated through shell control flow
// (that shape -- `vexit=$?; …; if [ $vexit -eq 0 ]; then git commit …; fi`,
// also present in this corpus -- is excluded per-WRITE, not per-region, see
// `writeIsInsideControlFlow` in guard-bash.mjs, and contributes ZERO of
// these 20 checkUngated pins).
//
// #3526 review round 2 (F1, F3, F4) re-audited after three fixes and found
// 17 more real instances, also read in full before pinning:
//   - F1 (variable-indirected /tmp destinations, `S=/tmp/…; W=$S/wt; git
//     worktree add $W` -- the ACTUAL shape of every historical /tmp
//     worktree-add in this corpus, never a literal `$TMPDIR`): 9 new
//     `tmpCheckout` denies.
//   - F3 (the control-flow exemption moved from whole-region to per-write):
//     1 new `checkUngated` deny (`e3cbc7a3…`) -- an EARLIER, already-closed
//     `for…do…done` loop no longer exempts a LATER, genuinely ungated
//     check -> write in the same region.
//   - F4 (`vitest` recognized by basename, a bare `timeout <duration>`
//     prefix stepped past, `npm test`/`npm t` added): 7 new `checkUngated`
//     denies -- this repo's own `timeout N node_modules/.bin/vitest`/
//     `timeout N npx vitest` convention, previously invisible to the check
//     set entirely (the `timeout` word was an unrecognized command, not
//     stripped).
const EXPECTED_TRANSCRIPT_DENIES = new Set([
	// #3988: six real historical orchestrator commands that run
	// `git worktree remove --force "$w"` / `…/$w` with a LOOP variable (`for w
	// in …; do`, `while read w`) or a glob (`.claude/worktrees/agent-2670-*`).
	// The path is unknowable to a static scan, so the destructive remove now
	// fails closed with `worktreeUnresolved`; each remove was read in full and
	// none carries a literal path. The sanctioned bulk removal is `node
	// scripts/prune-agent-worktrees.mjs`.
	"8bc8a4c462c564042423fff3baf78f05f2d88b6b2048ada41d5a04ff42047b28",
	"e70b2e5ae55217946e9eb793a8cf4af8ab0abc8cfa31763c0fa747829e7662ab",
	"af560ff2bb6809fb75e9ca40ce445e248b43795ff2d7f9532be6cde38290bfcf",
	"a3576fba5be22edefa148b8a98c06257fe1b01451392c4b33fbc90d598f1beac",
	"893583dbbe1c42779753301c1af6c9545958e36e492d264dfc537e81fafc8773",
	"3c4bd55c640f77611b546c28f1fcfa2e2b0045336c5edd3875f37c6e81a0fa8f",
	// #3888 audit: no executable historical `git push --force`, `+refspec`,
	// or `git rebase` rows were present; prose and commit-message mentions are
	// inert and remain correctly allowed by the corpus test.
	"21def4efd19e12fd4fcb3f0cfcbc7f000814ed54d6ecdb39701e74b08288811f",
	"22441661595314c7a8207f7cb04bee63c81882c05e64e5325d7245ffcb3ec5d7",
	// #3471 checkUngated -- audited true positives, round 1 (20):
	"ff582cb347e379fcf2dd2e965ea22a0313e76f18edad51ef7efc0cd01ad7b0ae",
	"ada188d5f502c2c534e449a06b19aeef59e5d3f48e47f7061a1b8e65d1c55bce",
	"a4f133cc3630108fcac7048f875b54e8920a2e01ba1f05426fbea6d4155d5582",
	"361b6ddfa5b81d111cd47883870ab7fcbd46a338ebe34e0f195dad22fdacd1cd",
	"b7e841213ab73312e829093f80495d3e5137b12f9119527b7a72828756a3953c",
	"07db63515b544bb9590a9cc2b2635ab663bbebd9dbc3e678e8a045027108a86d",
	"753dcb972e90d8bf7eea472aaef27385c204a8207161c1ca4108fd1d6a2ceb86",
	"6cfb7e92ef0c2eca551db9a684e8f172cc518b918a9905893e708fe147d1b160",
	"be38e0c9692695e1a954326eec1d4b58ab1f16f109541388a8ff2b021a1d899c",
	"1fe3f8f5d4256ba9cf4533648d9042f8b3241a32e7d9cb4e68a418b1f772c7c3",
	"9149ffc1d0e49e2f5f95034626f1af7d29cc392acd80c0a3d9a9a8444186c296",
	"51da626c87c6754f450617d738c4bdc7367a700a4fcaa9cc7833ff4ce8bd2aa5",
	"a7e72ce55e6a139fbfb8cf1ccef5c44195354c4b6f7148c0c2da23c94722ece6",
	"a2643e0ca815efd1cc39f61df81a82b09369581c96fef17f50ef2c8368daa6a6",
	"6df74407743e7df399c37e01281948bb3a10120a3ecf3d705d1208853a35bd61",
	"058bbb4cf2d5477a7451cf3b0e81452096e6935e66696fe67f3ce68ee2c46904",
	"a50b6f92c8f233d7b0794c66a968106330905c6d23fdcd64ca561570758ed769",
	"247e48689008fc34af723b56eb1e1faea15683d8b77bdaddb8ed0967b3070ed8",
	"a5aaebed4a33c5a63036aa4de421060ee3742097384404930ac7382dae1ef25a",
	"b536e5e79822d8de332813a67673887436042c628b4751f25e8500fd0411cbff",
	// #3526 review round 2, F1 -- variable-indirected /tmp worktree-adds (9):
	"4162c428ba3cd3eb276a0980fd1a8d7444e6f55ef356a7c5ab5d4143e92aff49",
	"06609131379d5d1b21c2f1a68b2346d4c9c63741a73d08c06ecf72f8e15aa423",
	"e13eea5655fe6e57395def929222751b50359d41dffbee72d2b6e9c1d7150ae7",
	"94a337509cf95b0daa738e00d023e78e2e9a4cd4e3e08c260ad07ac4c53bb112",
	"8166b556313c947b48016bfc552c5a5cec196bd5bb5ce2f0f8890ed246307809",
	"afdf482fd5cae451a226ebf0ebe721e433442fc86a5772b3bba56e823474e4fc",
	"78b2ecd67afae2eabc3b4db24f3e8bb154f9d0ff23c2d598117834bfce33bcad",
	"e0dd951d15e8ef944ae1a8b22ff6355567dd546c70a65e8e73d313dda91fffce",
	"f5c05f910019f743bb94c7d086b5cc3e82371321624400e19831e2e7b6bafe42",
	// #3526 review round 2, F3 -- an earlier CLOSED for/do/done loop no
	// longer exempts a later genuinely ungated check -> write (1):
	"e3cbc7a31b6837426817b794e54db318d3fef8fb766c023014336d7c1baae8e5",
	// #3526 review round 2, F4 -- timeout-wrapped / basename-resolved
	// vitest, previously invisible to the check set entirely (7):
	"99384a2525ff8dddfee78c82c51af7021f01d6165005167033a717ffc56ea077",
	"a6e2260e0c64ac20af126d1d7990830de94cce598da9bde0610262e75e3c905d",
	"e849647d34e37aab0f927095172358192015259992a7202e98c09ee960b26a31",
	"830516326aef8a7961d80c8b2ebcf53243a6c3408a2120f4bb6dcfc3386b3650",
	"f8e25082d8aab77f62006719b1a214b65cb87af7faeb8d5baf12574d9480c366",
	"cad4314ec40a34fb85ae43f865f96b5862397f363e26003cc814e87dfafceebf",
	// #3883 (round 2): six real historical `ci-verdict … | tail; echo "exit=$?"`
	// reads the new rule flags. Each was read in full; the `$?` is the tail's
	// status, not ci-verdict's verdict, and none enables `pipefail` first.
	"71eeb73974cf43c002ee51e46d0ad68a98243e20ded231956f12bf8948c547ab",
	"c9d112f10e0bc11cad5f0fdf866da6237cb90a92d0c8dbf70fcf189cbfb6e870",
	"e2cc62fdb1cd8355b95d36151544d43a77e35678b98007dddd206c77fe5cedf2",
	"a22ad5af048cb1448818b448f7c18287dbfeea08df29e05b0bf05e254ca0eaba",
	"94854ee02d361bd93e7e8b4020fb49cb30573937b576e435abffb6a1734827dd",
	"6ffdccbc34f482d728a5d85c70a93409ce0fd45ebf315a0fb8c931ef2aa4d4d5",
	// #3997 review round 3: sixteen real prune-loop removals with a variable
	// or glob path. The resolver must fail closed on each unknown destination.
	"b822082d3c03828f5e6589eb36eb83ac6660bd263432f06135c5035cc85e45a3",
	"afeca36779b64436851458b39454f955acacd385b03daa0b7be858d05723a0d4",
	"c2f6c24b1f1fdb4838fa9e8693009458671a74ef3f804d6ff2fba2ee371b986e",
	"4a35050e22495d98d1ebbde8fda95c2d6b96f24eabf726b7fdc8cb759d837128",
	"4be227e85b9819a6f2c829da3ee9ed1b7c5073ee83dfa3c686583f09d82f3ae3",
	"74b13dcd7ed03e7dc93d8522267a5f77f00cb98ca2ca3bb362426a294cd112b2",
	"18d80ce9728adc956d5e5a17538faecf6531ea551d2687ba7d9990b25a8a9b9b",
	"7e02e1dc1a511467cc0f9313d40f0a12636988eb88cc6cb6a1b895bc81c33f0c",
	"fe0c92cc4745cfae37cd0c22487a9a3b038358131d80947f2353426278d41370",
	"a06f9ee2f394ed05803ae46a0229b777051a02e1d34280f1990f32db74a6abf1",
	"0973763cd67dd37adbdab186ec3249f0215ac3c26b6973644512d9f44273ed0a",
	"26da3d3934a1a12faed2daeaf5d10738455de223bd86e0290056347df4e5cc5a",
	"ee140c03b7ca31650f3e72d7bed92cb32f77c45b744894ed7e60993c1d434620",
	"8fe3ac723bfecd13bbb15cf14fa8483430099c6edf8f0b12e56f46fda5a8271f",
	"fc4a33caaa9bc458f4dd3a8fafe3bf352d4f06c51917ee176ffb389bafad6c3b",
	"3ffb74708189595c9f09295c5b4a3725c4c76624b659af7065dea9f385a7056f",
	"a06f9ee2f394ed05803ae46a0229b777051a02e1d34280f1990f32db74a6abf1",
]);

const EXPECTED_TRANSCRIPT_ALLOWS = new Set([
	// Historical plegma maintenance transcript is an explicit allow.
	"30b1b57e56ca162793f411ef91bc8e47607a91f420039b3e00451ecd5278ea02",
]);

describe("scripts/hooks/guard-bash.mjs -- deny list (#2699)", () => {
	it.each(DENY_CASES)("denies %j", (command, ruleNeedle) => {
		const result = hookVerdict(command);
		expect(result.status).toBe(2);
		expect(result.stderr.toLowerCase()).toContain(ruleNeedle);
	});

	it("explains the pipe-safe final line for #3883", () => {
		const result = runHook("node scripts/ci-verdict.mjs 1 | tail; echo $?");
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("final `ci-verdict: exit <N> (<kind>)`");
		expect(result.stderr).toContain("; echo $?` before the pipe");
	});
});

describe("scripts/hooks/guard-bash.mjs -- allow list (#2699)", () => {
	it.each(ALLOW_CASES)("allows %j", (command) => {
		const result = hookVerdict(command);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});
});

describe("scripts/hooks/guard-bash.mjs -- rule declarations (review round 2 T1)", () => {
	it("declares tmpdirCollision in the DenyRule union the .d.mts exports", () => {
		// The union in scripts/hooks/guard-bash.d.mts is what every .ts caller
		// sees. It shipped without the fifth rule in round 1, so this typed
		// binding is the guard: remove "tmpdirCollision" from the union and
		// `npm run lint` fails with TS2322 before the suite even runs.
		const rule: DenyRule = "tmpdirCollision";
		expect(RULE_MESSAGES[rule]).toContain("TMPDIR");
	});

	it("declares worktreeSymlink in the DenyRule union the .d.mts exports", () => {
		// Same guard as the tmpdirCollision case above, for the sixth rule
		// (#3173): remove "worktreeSymlink" from the union and `npm run lint`
		// fails with TS2322 before the suite even runs.
		const rule: DenyRule = "worktreeSymlink";
		expect(RULE_MESSAGES[rule]).toContain("node_modules");
	});

	it("declares sharedKill in the DenyRule union the .d.mts exports", () => {
		// Same guard, for #3556's seventh rule.
		const rule: DenyRule = "sharedKill";
		expect(RULE_MESSAGES[rule]).toContain("pkill");
	});

	it("declares tmpCheckout in the DenyRule union the .d.mts exports", () => {
		// Same guard, for #3526's eighth rule.
		const rule: DenyRule = "tmpCheckout";
		expect(RULE_MESSAGES[rule]).toContain("/tmp");
	});

	it("declares checkUngated in the DenyRule union the .d.mts exports", () => {
		// Same guard, for #3471's ninth rule.
		const rule: DenyRule = "checkUngated";
		expect(RULE_MESSAGES[rule]).toContain("&&");
	});

	it("declares ciVerdictStatus in the DenyRule union", () => {
		const rule: DenyRule = "ciVerdictStatus";
		expect(RULE_MESSAGES[rule]).toContain(
			"final `ci-verdict: exit <N> (<kind>)`",
		);
	});
});

// #3173 (twice on 2026-09-16): a fixer ran `git worktree remove` on a tree
// whose node_modules was a symlink into the shared checkout
// (`ln -s <main checkout>/node_modules node_modules`, the fixer playbook's
// own speed convention). Git followed the link and emptied the SHARED
// install; any other agent building or testing in that window saw spurious
// ERR_MODULE_NOT_FOUND. This is a real filesystem check (not pure text
// classification like every other rule above), so each case builds a real
// fixture directory rather than a fictitious path string.
describe("scripts/hooks/guard-bash.mjs -- git worktree remove node_modules symlink hazard (#3173)", () => {
	// A linked git worktree's top-level .git is a FILE containing
	// "gitdir: ..." (never a directory -- that is the main checkout). This
	// is the only thing {@link looksLikeGitWorktree} checks; the content
	// need not resolve to a real repository for the classifier to accept it.
	function makeWorktreeDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		writeFileSync(
			join(dir, ".git"),
			"gitdir: /some/main/checkout/.git/worktrees/fixture\n",
		);
		return dir;
	}

	it("denies git worktree remove on a tree whose node_modules is a symlink OUTSIDE it", () => {
		const shared = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-shared-nm-"));
		const tree = makeWorktreeDir("guard-bash-worktree-symlink-");
		symlinkSync(shared, join(tree, "node_modules"));
		try {
			const result = runHook(`git worktree remove ${tree}`);
			expect(result.status).toBe(2);
			expect(result.stderr.toLowerCase()).toContain("worktree");
			// The note names the fix (acceptance #1; the one helper, #5111).
			expect(result.stderr).toContain(
				"node scripts/worktree-remove.mjs <path>",
			);
		} finally {
			rmSync(tree, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
		}
	});

	it("denies git worktree remove through a two-hop node_modules symlink (#4080)", () => {
		const shared = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-shared-nm-"));
		const tree = makeWorktreeDir("guard-bash-worktree-two-hop-");
		const inner = join(tree, "inner");
		symlinkSync(inner, join(tree, "node_modules"));
		symlinkSync(shared, inner);
		try {
			const result = runHook(`git worktree remove ${tree}`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain(
				"node scripts/worktree-remove.mjs <path>",
			);
		} finally {
			rmSync(tree, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
		}
	});

	const BROKEN_CHAIN_ROWS = [
		{
			label: "self-loop",
			setup: (tree: string) =>
				symlinkSync("node_modules", join(tree, "node_modules")),
		},
		{
			label: "two-cycle",
			setup: (tree: string) => {
				const nodeModules = join(tree, "node_modules");
				const inner = join(tree, "inner");
				symlinkSync("inner", nodeModules);
				symlinkSync("node_modules", inner);
			},
		},
		{
			label: "dangling in-project link",
			setup: (tree: string) => {
				const inner = join(tree, "inner");
				symlinkSync("inner", join(tree, "node_modules"));
				symlinkSync("missing", inner);
			},
		},
		{
			label: "ENOTDIR",
			setup: (tree: string) => {
				writeFileSync(join(tree, "package.json"), "{}\n");
				symlinkSync("package.json/child", join(tree, "node_modules"));
			},
		},
	] as const;

	it.each(BROKEN_CHAIN_ROWS)(
		"fails closed for $label chains across npm and delete callers (#4080)",
		({ setup }) => {
			const tree = mkdtempSync(
				join(tmpdir(), "pi-lens-guard-bash-broken-chain-"),
			);
			writeFileSync(join(tree, "package.json"), "{}\n");
			setup(tree);
			try {
				for (const command of [
					"npm ci",
					"rm -rf node_modules/",
					"rm -rf node_modules/*",
				]) {
					const result = runHook(command, BASE_ENV, tree);
					expect(result.status, command).toBe(2);
					expect(result.stderr, command).toMatch(/#4044|#3173/);
				}
			} finally {
				rmSync(tree, { recursive: true, force: true });
			}
		},
	);

	it("fails closed for a dangling in-project chain on git worktree remove (#4080)", () => {
		const tree = makeWorktreeDir("guard-bash-worktree-dangling-chain-");
		symlinkSync("inner", join(tree, "node_modules"));
		symlinkSync("missing", join(tree, "inner"));
		try {
			const result = runHook(`git worktree remove ${tree}`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("#3173");
		} finally {
			rmSync(tree, { recursive: true, force: true });
		}
	});

	it("allows the SAME tree once node_modules is unlinked (the note's own prescribed fix)", () => {
		const shared = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-shared-nm-"));
		const tree = makeWorktreeDir("guard-bash-worktree-symlink-");
		const nodeModules = join(tree, "node_modules");
		symlinkSync(shared, nodeModules);
		unlinkSync(nodeModules);
		try {
			const result = runHook(`git worktree remove ${tree}`);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			rmSync(tree, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
		}
	});

	it("allows a tree with a REAL node_modules directory (not a symlink)", () => {
		const tree = makeWorktreeDir("guard-bash-worktree-real-nm-");
		mkdirSync(join(tree, "node_modules"));
		try {
			const result = runHook(`git worktree remove ${tree}`);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			rmSync(tree, { recursive: true, force: true });
		}
	});

	it("allows a symlinked node_modules whose target stays INSIDE the worktree (only an OUTSIDE target is the hazard)", () => {
		const tree = makeWorktreeDir("guard-bash-worktree-inside-symlink-");
		const realInside = join(tree, "vendor", "node_modules");
		mkdirSync(dirname(realInside), { recursive: true });
		mkdirSync(realInside);
		symlinkSync(realInside, join(tree, "node_modules"));
		try {
			const result = runHook(`git worktree remove ${tree}`);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			rmSync(tree, { recursive: true, force: true });
		}
	});

	it("allows a git worktree remove on a path that does not exist -- left to git, no false deny", () => {
		const doesNotExist = join(
			tmpdir(),
			"guard-bash-worktree-does-not-exist-3173",
		);
		const result = runHook(`git worktree remove ${doesNotExist}`);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("allows a git worktree remove on an ordinary directory that is NOT a git worktree, even with a hazard-shaped symlink", () => {
		// Same symlink-outside shape as the deny case above, but with no .git
		// file at all -- looksLikeGitWorktree must gate BEFORE the symlink
		// check runs, or an ordinary directory that merely contains a
		// "node_modules" symlink (e.g. a project's own dependency symlink)
		// would be denied.
		const shared = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-shared-nm-"));
		const dir = mkdtempSync(
			join(tmpdir(), "pi-lens-guard-bash-not-a-worktree-"),
		);
		symlinkSync(shared, join(dir, "node_modules"));
		try {
			const result = runHook(`git worktree remove ${dir}`);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
		}
	});

	it("still detects git worktree remove embedded in a chained command (&&, ;)", () => {
		const shared = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-shared-nm-"));
		const tree = makeWorktreeDir("guard-bash-worktree-symlink-chained-");
		symlinkSync(shared, join(tree, "node_modules"));
		try {
			const chainedAnd = runHook(`cd /tmp && git worktree remove ${tree}`);
			expect(chainedAnd.status).toBe(2);
			expect(chainedAnd.stderr.toLowerCase()).toContain("worktree");

			const chainedSemi = runHook(`echo hi; git worktree remove ${tree}`);
			expect(chainedSemi.status).toBe(2);
			expect(chainedSemi.stderr.toLowerCase()).toContain("worktree");
		} finally {
			rmSync(tree, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
		}
	});

	it("still denies with a single --force (this rule is not gated by the double-force worktreeForce rule)", () => {
		const shared = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-shared-nm-"));
		const tree = makeWorktreeDir("guard-bash-worktree-symlink-force-");
		symlinkSync(shared, join(tree, "node_modules"));
		try {
			const result = runHook(`git worktree remove --force ${tree}`);
			expect(result.status).toBe(2);
			expect(result.stderr.toLowerCase()).toContain("worktree");
		} finally {
			rmSync(tree, { recursive: true, force: true });
			rmSync(shared, { recursive: true, force: true });
		}
	});
});

// #4044 (2026-10-07 09:16:22Z): a worker ran `npm ci --ignore-scripts
// --dry-run` in a lane whose node_modules was a symlink to the main
// checkout's install. npm 9.2.0 ignores --dry-run for the clean-install
// family and removes node_modules/* through the link, so every lane lost its
// dependencies. Recurrence these cases catch: the #3173 shape (a delete
// through a node_modules link) reached by a different verb, or by a spelling
// the first guard missed (`cd <lane> && …`, `--prefix`, `npx npm@…`, a
// subdirectory of the lane). Real filesystem fixtures, driven through the
// real hook entry.
describe("scripts/hooks/guard-bash.mjs -- npm writers and deletes through a linked node_modules (#4044)", () => {
	function makeLane(linked: boolean): {
		tree: string;
		shared: string;
		cleanup: () => void;
	} {
		const shared = mkdtempSync(
			join(tmpdir(), "pi-lens-guard-bash-npm-shared-nm-"),
		);
		const tree = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-npm-lane-"));
		writeFileSync(join(tree, "package.json"), "{}\n");
		if (linked) symlinkSync(shared, join(tree, "node_modules"));
		else mkdirSync(join(tree, "node_modules"));
		return {
			tree,
			shared,
			cleanup: () => {
				rmSync(tree, { recursive: true, force: true });
				rmSync(shared, { recursive: true, force: true });
			},
		};
	}

	const MUTATING = [
		"npm ci",
		"npm ci --ignore-scripts --dry-run",
		"npm clean-install",
		"npm install",
		"npm i",
		"npm add left-pad",
		"npm uninstall left-pad",
		"npm rm left-pad",
		"npm update",
		"npm up",
		"npm prune",
		"npm dedupe",
		"npm rebuild",
		"npm install-ci-test",
		"npm cit",
		"npm audit fix",
		"npm link",
		"npm install --no-save oxfmt",
		"npm install --dry-run",
	];

	it.each(MUTATING)(
		"denies `%s` when node_modules links outside the lane, and names the safe forms",
		(command) => {
			const { tree, cleanup } = makeLane(true);
			try {
				const result = runHook(command, BASE_ENV, tree);
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("#4044");
				expect(result.stderr).toContain("scratch copy");
				expect(result.stderr).toContain("--prefix");
			} finally {
				cleanup();
			}
		},
	);

	it("denies npm writers and deletes through a two-hop node_modules symlink (#4080)", () => {
		const { tree, shared, cleanup } = makeLane(true);
		const nodeModules = join(tree, "node_modules");
		const inner = join(tree, "inner");
		unlinkSync(nodeModules);
		symlinkSync(inner, nodeModules);
		symlinkSync(shared, inner);
		try {
			for (const command of [
				"npm ci",
				"rm -rf node_modules/",
				"rm -rf node_modules/*",
			]) {
				const result = runHook(command, BASE_ENV, tree);
				expect(result.status, command).toBe(2);
				expect(result.stderr, command).toContain("#4044");
			}
		} finally {
			cleanup();
		}
	});

	it("allows a chain whose first hop leaves the lane but resolves back inside (#4080)", () => {
		const tree = mkdtempSync(
			join(tmpdir(), "pi-lens-guard-bash-inside-chain-"),
		);
		const outsideSpelling = join(dirname(tree), `${basename(tree)}-link`);
		mkdirSync(join(tree, "inner"));
		symlinkSync(tree, outsideSpelling);
		symlinkSync(
			join("..", basename(outsideSpelling), "inner"),
			join(tree, "node_modules"),
		);
		try {
			const result = runHook("npm ci", BASE_ENV, tree);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			rmSync(tree, { recursive: true, force: true });
			unlinkSync(outsideSpelling);
		}
	});

	it("denies the incident's own shape: `cd <lane> && npm ci --dry-run` from an unrelated payload cwd", () => {
		const { tree, cleanup } = makeLane(true);
		try {
			const result = runHook(`cd ${tree} && npm ci --dry-run`);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("#4044");
		} finally {
			cleanup();
		}
	});

	it("denies `npm --prefix <linked lane> ci` and `npm ci --prefix=<linked lane>` from another cwd", () => {
		const { tree, cleanup } = makeLane(true);
		try {
			for (const command of [
				`npm --prefix ${tree} ci`,
				`npm ci --prefix=${tree}`,
				`npm ci --prefix ${tree}`,
			]) {
				const result = runHook(command);
				expect(result.status, command).toBe(2);
				expect(result.stderr, command).toContain("#4044");
			}
		} finally {
			cleanup();
		}
	});

	it("resolves a relative --prefix against the payload cwd", () => {
		const { tree, cleanup } = makeLane(true);
		try {
			const result = runHook(
				`npm --prefix ./${tree.split("/").pop()} ci`,
				BASE_ENV,
				dirname(tree),
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("#4044");
		} finally {
			cleanup();
		}
	});

	it("denies `npx -y npm@11.18.0 ci` and bare `npx npm ci` in a linked lane", () => {
		const { tree, cleanup } = makeLane(true);
		try {
			for (const command of [
				"npx -y npm@11.18.0 ci",
				"npx --yes npm@11 ci --dry-run",
				"npx npm ci",
				"npx -p npm@11.18.0 -y npm ci",
			]) {
				const result = runHook(command, BASE_ENV, tree);
				expect(result.status, command).toBe(2);
				expect(result.stderr, command).toContain("#4044");
			}
		} finally {
			cleanup();
		}
	});

	it("denies from a subdirectory of the lane, where npm walks up to the lane's node_modules", () => {
		const { tree, cleanup } = makeLane(true);
		const sub = join(tree, "scripts", "deep");
		mkdirSync(sub, { recursive: true });
		try {
			const result = runHook("npm ci", BASE_ENV, sub);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("#4044");
		} finally {
			cleanup();
		}
	});

	it("denies behind an env assignment and a runner prefix", () => {
		const { tree, cleanup } = makeLane(true);
		try {
			for (const command of ["CI=1 npm ci", "env npm ci", "echo go; npm ci"]) {
				const result = runHook(command, BASE_ENV, tree);
				expect(result.status, command).toBe(2);
				expect(result.stderr, command).toContain("#4044");
			}
		} finally {
			cleanup();
		}
	});

	it("allows every mutating verb where node_modules is a REAL directory", () => {
		const { tree, cleanup } = makeLane(false);
		try {
			for (const command of [
				...MUTATING,
				"npx -y npm@11.18.0 ci",
				`cd ${tree} && npm ci`,
			]) {
				const result = runHook(command, BASE_ENV, tree);
				expect(result.status, command).toBe(0);
				expect(result.stderr, command).toBe("");
			}
		} finally {
			cleanup();
		}
	});

	it("allows read-only and non-install npm/npx verbs through a linked node_modules", () => {
		const { tree, cleanup } = makeLane(true);
		try {
			for (const command of [
				"npm ls",
				"npm run build",
				"npm test",
				"npm view left-pad version",
				"npm audit",
				"npm outdated",
				"npm pack --dry-run",
				"npm exec vitest",
				"npx vitest run tests/x.test.ts",
				"npx -y tsc --noEmit",
				"npm config get registry",
				"npm --prefix . ls",
			]) {
				const result = runHook(command, BASE_ENV, tree);
				expect(result.status, command).toBe(0);
				expect(result.stderr, command).toBe("");
			}
		} finally {
			cleanup();
		}
	});

	it("allows the message's own safe forms: --prefix into a real directory, and a global install", () => {
		const linked = makeLane(true);
		const real = makeLane(false);
		try {
			for (const command of [
				`npm --prefix ${real.tree} ci`,
				`npm ci --prefix=${real.tree}`,
				"npm install -g left-pad",
			]) {
				const result = runHook(command, BASE_ENV, linked.tree);
				expect(result.status, command).toBe(0);
				expect(result.stderr, command).toBe("");
			}
		} finally {
			linked.cleanup();
			real.cleanup();
		}
	});

	it("allows `npm ci` in a lane with no node_modules yet, and where the link stays INSIDE the lane", () => {
		const bare = makeLane(false);
		rmSync(join(bare.tree, "node_modules"), { recursive: true });
		const inside = makeLane(false);
		rmSync(join(inside.tree, "node_modules"), { recursive: true });
		const vendor = join(inside.tree, "vendor", "node_modules");
		mkdirSync(vendor, { recursive: true });
		symlinkSync(vendor, join(inside.tree, "node_modules"));
		try {
			for (const tree of [bare.tree, inside.tree]) {
				const result = runHook("npm ci", BASE_ENV, tree);
				expect(result.status, tree).toBe(0);
				expect(result.stderr, tree).toBe("");
			}
		} finally {
			bare.cleanup();
			inside.cleanup();
		}
	});

	it("stops the walk-up at the nearest package.json, so a nested project with its own install is judged on its own", () => {
		const { tree, cleanup } = makeLane(true);
		const nested = join(tree, "packages", "x");
		mkdirSync(join(nested, "node_modules"), { recursive: true });
		writeFileSync(join(nested, "package.json"), "{}\n");
		try {
			const result = runHook("npm ci", BASE_ENV, nested);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			cleanup();
		}
	});

	// Recurrence: the #4044 sibling measured with GNU coreutils on 2026-10-07:
	// `rm -rf node_modules/`, `rm -rf node_modules/*` and `find node_modules/
	// -delete` follow a link and empty its target, while the no-slash forms
	// only unlink the link. The npm rule alone left these open, and each is
	// one keystroke from the form that is safe.
	const DELETES_THROUGH = [
		"rm -rf node_modules/",
		"rm -rf node_modules/*",
		"rm -rf ./node_modules/",
		"rm -rf -- node_modules/",
		"rm -r node_modules/.cache",
		"rmdir node_modules/x",
		"unlink node_modules/x",
		"env rm -rf node_modules/",
		"find node_modules/ -delete",
		"find node_modules/ -type f -delete",
		"find -L node_modules -delete",
		"find -H node_modules -delete",
		"find node_modules/ -exec rm -rf {} +",
		"find node_modules/ -execdir unlink {} ;",
	];

	it.each(DELETES_THROUGH)(
		"denies `%s` when node_modules links outside the lane, and names the unlink form",
		(command) => {
			const { tree, cleanup } = makeLane(true);
			try {
				const result = runHook(command, BASE_ENV, tree);
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("#4044");
				expect(result.stderr).toContain("rm node_modules");
			} finally {
				cleanup();
			}
		},
	);

	it("resolves the operand through the cwd the command really runs in: cd, absolute, relative and subdirectory spellings", () => {
		const { tree, cleanup } = makeLane(true);
		const sub = join(tree, "scripts");
		mkdirSync(sub);
		const laneName = tree.split("/").pop();
		try {
			const cases: Array<[string, string]> = [
				[`cd ${tree} && rm -rf node_modules/`, PAYLOAD_CWD],
				[`rm -rf ${tree}/node_modules/`, PAYLOAD_CWD],
				[`rm -rf ${tree}/node_modules/*`, PAYLOAD_CWD],
				[`find ${tree}/node_modules/ -delete`, PAYLOAD_CWD],
				[`rm -rf ./${laneName}/node_modules/`, dirname(tree)],
				["rm -rf ../node_modules/", sub],
				["rm -rf ../node_modules/*", sub],
				// cd INTO the link, then delete by glob or by `.`.
				[`cd ${tree}/node_modules && rm -rf ./*`, PAYLOAD_CWD],
				[`cd ${tree}/node_modules && find . -delete`, PAYLOAD_CWD],
				[`cd ${tree}/node_modules && find -delete`, PAYLOAD_CWD],
			];
			for (const [command, cwd] of cases) {
				const result = runHook(command, BASE_ENV, cwd);
				expect(result.status, command).toBe(2);
				expect(result.stderr, command).toContain("#4044");
			}
		} finally {
			cleanup();
		}
	});

	it("allows unlinking the link itself and every delete that does not pass through it", () => {
		const { tree, cleanup } = makeLane(true);
		try {
			for (const command of [
				"rm node_modules",
				"rm -rf node_modules",
				"rm -f ./node_modules",
				"unlink node_modules",
				`rm -rf ${tree}/node_modules`,
				"find node_modules -delete",
				"find node_modules -name x -print",
				"find node_modules/ -name x -print",
				"find . -delete",
				"find node_modules/ -exec ls {} +",
				"rm -rf dist src/*",
				"ls node_modules/",
			]) {
				const result = runHook(command, BASE_ENV, tree);
				expect(result.status, command).toBe(0);
				expect(result.stderr, command).toBe("");
			}
		} finally {
			cleanup();
		}
	});

	it("allows `rm -rf node_modules/` where node_modules is a real directory, absent, or links INSIDE the lane", () => {
		const real = makeLane(false);
		const bare = makeLane(false);
		rmSync(join(bare.tree, "node_modules"), { recursive: true });
		const inside = makeLane(false);
		rmSync(join(inside.tree, "node_modules"), { recursive: true });
		const vendor = join(inside.tree, "vendor", "node_modules");
		mkdirSync(vendor, { recursive: true });
		symlinkSync(vendor, join(inside.tree, "node_modules"));
		try {
			for (const tree of [real.tree, bare.tree, inside.tree]) {
				for (const command of [
					"rm -rf node_modules/",
					"rm -rf node_modules/*",
					"find node_modules/ -delete",
				]) {
					const result = runHook(command, BASE_ENV, tree);
					expect(result.status, `${tree} ${command}`).toBe(0);
					expect(result.stderr, `${tree} ${command}`).toBe("");
				}
			}
		} finally {
			real.cleanup();
			bare.cleanup();
			inside.cleanup();
		}
	});

	// Round 3 (#3997 merged). Recurrence: #3997's `cwdAfterSegment` hands a rule
	// `cwd === null` after a `cd` it cannot resolve, and the #4054 rules read
	// `cwd ?? process.cwd()` -- the HOOK's cwd, a real node_modules -- so
	// `cd $(pwd) && npm ci` in a linked lane allowed (verify-3997-r4 section 5).
	// An unknown cwd is judged as the payload's own cwd, failing closed.
	it.each([
		"cd $UNSET_4044_DIR && npm ci",
		"popd; npm ci",
		"cd - ; npm ci",
		"cd $(pwd) && npm ci",
		"cd `pwd` && npm install",
		"cd $(pwd) && rm -rf node_modules/",
		"cd $(pwd) && find node_modules/ -delete",
	])(
		"denies `%s` in a linked lane: an unknown cwd is the payload cwd",
		(command) => {
			const { tree, cleanup } = makeLane(true);
			try {
				const result = runHook(command, BASE_ENV, tree);
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("#4044");
			} finally {
				cleanup();
			}
		},
	);

	it("allows the same unknown-cwd commands when the payload cwd holds a real node_modules", () => {
		const { tree, cleanup } = makeLane(false);
		try {
			for (const command of [
				"cd $UNSET_4044_DIR && npm ci",
				"popd; npm ci",
				"cd $(pwd) && rm -rf node_modules/",
			]) {
				const result = runHook(command, BASE_ENV, tree);
				expect(result.status, command).toBe(0);
				expect(result.stderr, command).toBe("");
			}
		} finally {
			cleanup();
		}
	});

	// Recurrence: the rules resolved operands with plain `resolve`, so a
	// `$PWD`/`$VAR`/`~` spelling of the same path was allowed (#3988's one
	// resolver, #3997). Logical mode: a physical realpath collapses
	// `lane/node_modules/` onto the target and the link vanishes from the path.
	it("resolves `$PWD`, exported/assigned variables and `~` in delete operands and --prefix", () => {
		const { tree, cleanup } = makeLane(true);
		try {
			const cases: Array<[string, NodeJS.ProcessEnv]> = [
				["rm -rf $PWD/node_modules/", BASE_ENV],
				["rm -rf ${PWD}/node_modules/*", BASE_ENV],
				["npm ci --prefix $PWD", BASE_ENV],
				["npm --prefix=$PWD ci", BASE_ENV],
				["D=node_modules; rm -rf $D/", BASE_ENV],
				["export NM=$PWD/node_modules; rm -rf $NM/", BASE_ENV],
				["P=$PWD; npm --prefix $P ci", BASE_ENV],
				["cd $PWD && rm -rf node_modules/", BASE_ENV],
				["rm -rf ~/node_modules/", { ...BASE_ENV, HOME: tree }],
				["npm ci --prefix ~", { ...BASE_ENV, HOME: tree }],
			];
			for (const [command, env] of cases) {
				const result = runHook(command, env, tree);
				expect(result.status, command).toBe(2);
				expect(result.stderr, command).toContain("#4044");
			}
		} finally {
			cleanup();
		}
	});

	it("allows in-lane deletes that resolve past the link without passing through it", () => {
		const { tree, cleanup } = makeLane(true);
		try {
			for (const command of [
				"rm -rf $PWD/dist/",
				"rm -rf $PWD/node_modules",
				"rm -rf ~/dist/",
			]) {
				const result = runHook(command, { ...BASE_ENV, HOME: tree }, tree);
				expect(result.stderr, command).toBe("");
				expect(result.status, command).toBe(0);
			}
		} finally {
			cleanup();
		}
	});

	// Round 4 state table (PR #4054 body, "Round 4"): value form x lane x verb.
	// Recurrence: round 3 let `npm --prefix "$(pwd)" ci` through in a linked
	// lane while `D=$(pwd); npm --prefix $D ci` denied (R3-1, a regression it
	// introduced), and resolved `../lnk/../node_modules/` lexically while the
	// kernel follows `lnk` first (R3-2). One rule covers every row: a directory
	// is tested where the program lands (kernel walk for deletes, npm's own
	// resolution for --prefix and the walk-up), and a part the resolver cannot
	// read is the project the command runs in.
	function makeTableFixture(): { root: string; cleanup: () => void } {
		const root = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-r4-"));
		const shared = join(root, "main", "node_modules");
		mkdirSync(shared, { recursive: true });
		for (const name of ["lane", "real"]) {
			mkdirSync(join(root, name, "scripts"), { recursive: true });
			writeFileSync(join(root, name, "package.json"), "{}\n");
		}
		symlinkSync(shared, join(root, "lane", "node_modules"));
		mkdirSync(join(root, "real", "node_modules"));
		mkdirSync(join(root, "sib"));
		mkdirSync(join(root, "scratch"));
		symlinkSync(join(root, "lane", "scripts"), join(root, "lnk"));
		symlinkSync(join(root, "real", "scripts"), join(root, "rlnk"));
		return {
			root,
			cleanup: () => rmSync(root, { recursive: true, force: true }),
		};
	}

	const OFF_TMP_SCRATCH = "/home/dev/pi-lens-guard-bash-r4-scratch";

	// [id, command ({dir} = the lane, {lnk} = its scripts link), payload cwd,
	//  HOME is the lane, expected in the linked lane, expected in the real one]
	const ROUND4_TABLE: Array<
		[string, string, "lane" | "sib", boolean, "deny" | "allow", "allow"]
	> = [
		["N1 literal", "npm --prefix {dir} ci", "sib", false, "deny", "allow"],
		[
			"N2 known var",
			"P={dir}; npm --prefix $P ci",
			"sib",
			false,
			"deny",
			"allow",
		],
		[
			"N3 unknown var",
			'npm --prefix "$UNSET_4054_R4" ci',
			"lane",
			false,
			"deny",
			"allow",
		],
		[
			"N3b unknown var",
			"npm ci --prefix $UNSET_4054_R4/x",
			"lane",
			false,
			"deny",
			"allow",
		],
		["N4 $(cmd)", 'npm --prefix "$(pwd)" ci', "lane", false, "deny", "allow"],
		["N4b $(cmd)", "npm ci --prefix=$(pwd)", "lane", false, "deny", "allow"],
		[
			"N4c $(cmd)",
			'npm ci --prefix "$(git rev-parse --show-toplevel)"',
			"lane",
			false,
			"deny",
			"allow",
		],
		[
			"N4d $(cmd)",
			'npm --prefix "$(mktemp -d)" ci',
			"lane",
			false,
			"deny",
			"allow",
		],
		[
			"N4e $(cmd) via var",
			"D=$(pwd); npm --prefix $D ci",
			"lane",
			false,
			"deny",
			"allow",
		],
		["N5 backtick", "npm ci --prefix `pwd`", "lane", false, "deny", "allow"],
		["N6 ~", "npm --prefix ~ ci", "sib", true, "deny", "allow"],
		["N6b $HOME", "npm --prefix $HOME ci", "sib", true, "deny", "allow"],
		[
			"N6c ~+ (bash: $PWD)",
			"npm --prefix ~+ ci",
			"lane",
			false,
			"deny",
			"allow",
		],
		[
			"N7 $TMPDIR",
			"npm --prefix $TMPDIR/s ci",
			"lane",
			false,
			"allow",
			"allow",
		],
		[
			"N7b $TMPDIR cd",
			"cd $TMPDIR/s && npm ci",
			"lane",
			false,
			"allow",
			"allow",
		],
		["N8 $PWD", "npm --prefix $PWD ci", "lane", false, "deny", "allow"],
		[
			"N9 symlink+.. cd",
			"cd ../{lnk} && npm ci",
			"sib",
			false,
			"deny",
			"allow",
		],
		[
			"N9b symlink+.. prefix",
			"npm --prefix ../{lnk}/.. ci",
			"sib",
			false,
			"allow",
			"allow",
		],
		[
			"N10 cwd inside the link",
			"cd {dir}/node_modules && npm ci",
			"sib",
			false,
			"deny",
			"allow",
		],
		[
			"N10b prefix inside the link",
			"npm --prefix {dir}/node_modules ci",
			"sib",
			false,
			"deny",
			"allow",
		],
		["D1 literal", "rm -rf node_modules/", "lane", false, "deny", "allow"],
		[
			"D1b literal link only",
			"rm -rf node_modules",
			"lane",
			false,
			"allow",
			"allow",
		],
		[
			"D2 known var",
			"D={dir}; rm -rf $D/node_modules/",
			"sib",
			false,
			"deny",
			"allow",
		],
		[
			"D3 unknown var",
			'rm -rf "$UNSET_4054_R4/node_modules/"',
			"lane",
			false,
			"deny",
			"allow",
		],
		[
			"D4 $(cmd)",
			'rm -rf "$(pwd)/node_modules/"',
			"lane",
			false,
			"deny",
			"allow",
		],
		[
			"D4b $(cmd)",
			'rm -rf "$(git rev-parse --show-toplevel)/node_modules/"',
			"lane",
			false,
			"deny",
			"allow",
		],
		[
			"D4c $(cmd) via var",
			"S=$(pwd); rm -rf $S/node_modules/",
			"lane",
			false,
			"deny",
			"allow",
		],
		[
			"D4d $(cmd) find",
			'find "$(pwd)/node_modules/" -delete',
			"lane",
			false,
			"deny",
			"allow",
		],
		[
			"D4e $(cmd) find -L",
			"find -L $(pwd) -delete",
			"lane",
			false,
			"deny",
			"allow",
		],
		[
			"D5 backtick",
			"rm -rf `pwd`/node_modules/",
			"lane",
			false,
			"deny",
			"allow",
		],
		["D6 ~", "rm -rf ~/node_modules/", "sib", true, "deny", "allow"],
		["D6b $HOME", "rm -rf $HOME/node_modules/*", "sib", true, "deny", "allow"],
		[
			"D6c ~+ (bash: $PWD)",
			"rm -rf ~+/node_modules/",
			"lane",
			false,
			"deny",
			"allow",
		],
		[
			"D7 $TMPDIR",
			"rm -rf $TMPDIR/s/node_modules/",
			"lane",
			false,
			"allow",
			"allow",
		],
		["D8 $PWD", "rm -rf $PWD/node_modules/", "lane", false, "deny", "allow"],
		[
			"D9 symlink+..",
			"rm -rf ../{lnk}/../node_modules/",
			"sib",
			false,
			"deny",
			"allow",
		],
		[
			"D9b symlink+.. cd",
			"cd ../{lnk} && rm -rf ../node_modules/",
			"sib",
			false,
			"deny",
			"allow",
		],
	];

	it.each(ROUND4_TABLE)(
		"round-4 state table %s: `%s` (cwd %s) in a linked and a real lane",
		(_id, template, cwdKind, homeIsLane, linkedVerdict, realVerdict) => {
			const { root, cleanup } = makeTableFixture();
			try {
				for (const [lane, link, verdict] of [
					["lane", "lnk", linkedVerdict],
					["real", "rlnk", realVerdict],
				] as const) {
					const dir = join(root, lane);
					const command = template
						.replaceAll("{dir}", dir)
						.replaceAll("{lnk}", link);
					const { UNSET_4054_R4: _unset, ...env } = BASE_ENV;
					const result = runHook(
						command,
						{
							...env,
							// A `mktemp` row reads TMPDIR as where mktemp lands: a
							// fixture root under /tmp (the CI runner's os.tmpdir())
							// would add the unrelated #3526 tmpCheckout deny to the
							// real-lane allow (round 5, N4d). The hook only reads the
							// string, so those rows get a path off /tmp.
							TMPDIR: template.includes("mktemp")
								? OFF_TMP_SCRATCH
								: join(root, "scratch"),
							...(homeIsLane ? { HOME: dir } : {}),
						},
						cwdKind === "sib" ? join(root, "sib") : dir,
					);
					if (verdict === "deny") {
						expect(result.status, `${lane}: ${command}`).toBe(2);
						expect(result.stderr, `${lane}: ${command}`).toContain("#4044");
					} else {
						expect(result.stderr, `${lane}: ${command}`).toBe("");
						expect(result.status, `${lane}: ${command}`).toBe(0);
					}
				}
			} finally {
				cleanup();
			}
		},
	);

	// Recurrence (round 5, CI on 4440b2e8): N4d passed locally and reds on the
	// runner, because the table's real-lane allow silently depended on the
	// host's os.tmpdir(). The /tmp half of that dependence is pinned here by
	// reason: a `mktemp -d` prefix lands under TMPDIR, and under /tmp it is the
	// #3526 tmpCheckout deny, never the #4044 one, in a real lane.
	it("names the #3526 reason for a mktemp -d --prefix when TMPDIR is under /tmp", () => {
		const { root, cleanup } = makeTableFixture();
		try {
			const { UNSET_4054_R4: _unset, ...env } = BASE_ENV;
			const result = runHook(
				'npm --prefix "$(mktemp -d)" ci',
				{ ...env, TMPDIR: "/tmp/pi-lens-guard-bash-r5-scratch" },
				join(root, "real"),
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toBe(`${RULE_MESSAGES.tmpCheckout}\n`);
		} finally {
			cleanup();
		}
	});

	// Recurrence: round 3 resolved `node_modules/..` lexically to the lane,
	// while the kernel follows the link first and lands in the shared
	// install's parent (`find node_modules/.. -delete` would empty the main
	// checkout); the same holds for a relative path from a cwd inside the link.
	it("denies a path the kernel resolves through the link before a `..`, and not through a real node_modules", () => {
		const linked = makeLane(true);
		const real = makeLane(false);
		try {
			for (const [command, cwd] of [
				["find node_modules/.. -delete", linked.tree],
				["rm -rf node_modules/../x", linked.tree],
				[`cd ${linked.tree}/node_modules && rm -rf ../x`, PAYLOAD_CWD],
			]) {
				const result = runHook(command, BASE_ENV, cwd);
				expect(result.status, command).toBe(2);
				expect(result.stderr, command).toContain("#4044");
			}
			for (const command of [
				"find node_modules/.. -delete",
				`cd ${real.tree}/node_modules && rm -rf ../x`,
			]) {
				const result = runHook(command, BASE_ENV, real.tree);
				expect(result.stderr, command).toBe("");
				expect(result.status, command).toBe(0);
			}
		} finally {
			linked.cleanup();
			real.cleanup();
		}
	});

	it("points an unreadable --prefix at a $TMPDIR scratch directory", () => {
		const { tree, cleanup } = makeLane(true);
		try {
			const result = runHook('npm --prefix "$(pwd)" ci', BASE_ENV, tree);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("--prefix $TMPDIR/<name>");
		} finally {
			cleanup();
		}
	});

	// Recurrence (review-4054 F1): `find -L .`/`-follow` descend INTO the link
	// from any operand that merely holds it, and the PR claimed `-L/-H` were
	// covered only for an operand named node_modules itself.
	it.each([
		"find -L . -delete",
		"find -L . -name f -delete",
		"find . -follow -delete",
		"find node_modules -follow -delete",
		"find -L . -exec rm -f {} +",
	])("denies `%s` in a linked lane", (command) => {
		const { tree, cleanup } = makeLane(true);
		try {
			const result = runHook(command, BASE_ENV, tree);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("#4044");
		} finally {
			cleanup();
		}
	});

	it("allows following find forms that do not delete, or whose operand holds no link, and the same in a real lane", () => {
		const linked = makeLane(true);
		mkdirSync(join(linked.tree, "dist"));
		const real = makeLane(false);
		try {
			for (const [command, cwd] of [
				["find -L . -name f -print", linked.tree],
				["find -L dist -delete", linked.tree],
				["find . -follow -name f", linked.tree],
				["find . -delete", linked.tree],
				["find -L . -delete", real.tree],
				["find . -follow -delete", real.tree],
			]) {
				const result = runHook(command, BASE_ENV, cwd);
				expect(result.status, command).toBe(0);
				expect(result.stderr, command).toBe("");
			}
		} finally {
			linked.cleanup();
			real.cleanup();
		}
	});

	// Recurrence (review-4054 F4): `NPM_VALUE_FLAGS` was a closed list, so an
	// unlisted value flag ("--audit false", "--maxsockets 3") became the verb.
	it.each([
		"npm --audit false ci",
		"npm --fund false ci",
		"npm --ignore-scripts false ci",
		"npm --fetch-retries 3 ci",
		"npm --maxsockets 3 install",
		"npm --audit-level high ci",
		"npm --lockfile-version 3 install",
		"npm --proxy http://x:8080 ci",
	])(
		"denies `%s` in a linked lane: an unlisted value flag does not hide the verb",
		(command) => {
			const { tree, cleanup } = makeLane(true);
			try {
				const result = runHook(command, BASE_ENV, tree);
				expect(result.status).toBe(2);
				expect(result.stderr).toContain("#4044");
			} finally {
				cleanup();
			}
		},
	);

	it("allows read-only verbs and a script named like a writer behind unlisted value flags", () => {
		const { tree, cleanup } = makeLane(true);
		try {
			for (const command of [
				"npm --audit false ls",
				"npm --maxsockets 3 run build",
				"npm run ci",
				"npm run install",
				"npm test ci",
				"npm view install version",
			]) {
				const result = runHook(command, BASE_ENV, tree);
				expect(result.status, command).toBe(0);
				expect(result.stderr, command).toBe("");
			}
		} finally {
			cleanup();
		}
	});

	// Recurrence (review-4054 F6): the message said "or `rm node_modules`
	// first", but `rm node_modules && npm ci` is judged statically and denied
	// as one command; the remedy needs two calls.
	it("tells the reader the unlink and the install are separate commands", () => {
		const { tree, cleanup } = makeLane(true);
		try {
			const result = runHook("npm ci", BASE_ENV, tree);
			expect(result.stderr).toContain("in a separate command");
		} finally {
			cleanup();
		}
	});

	it("declares linkedNodeModulesDelete in the DenyRule union the .d.mts exports", () => {
		// Same typed-binding guard as npmLinkedInstall below.
		const rule: DenyRule = "linkedNodeModulesDelete";
		expect(RULE_MESSAGES[rule]).toContain("unlink");
	});

	it("declares npmLinkedInstall in the DenyRule union the .d.mts exports", () => {
		// Same typed-binding guard as the rule declarations above: remove the
		// member from scripts/hooks/guard-bash.d.mts and `npm run lint` reds.
		const rule: DenyRule = "npmLinkedInstall";
		expect(RULE_MESSAGES[rule]).toContain("node_modules");
	});
});

// #3988: every guard-bash rule that tests a PATH argument resolves it through
// ONE resolver (`expandShellWord` / `resolveShellPath` in guard-bash.mjs): the
// shell expansions bash performs before the program sees argv (`~`, `$HOME`,
// `${HOME}`, `$VAR`, `$PWD`), then the command's effective cwd (a preceding
// `cd`, `git -C`, else the hook payload's cwd). Recurrence this block names:
// 2026-10-06, `git worktree remove --force ~/.local/share/.../3967-final` ran
// unblocked against a tree whose node_modules was a symlink into the main
// checkout (#3173 hole); the tmp-checkout, mktemp and node-probe rules each
// carried a partial expander of their own and had the same hole. A path that
// cannot be resolved statically fails CLOSED for the destructive rule
// (`git worktree remove`), with its own named rule.
//
// Every row goes through the hook's classifier (hookVerdict, the PreToolUse
// payload under the env the child would get), against a REAL registered
// linked worktree whose node_modules is a symlink into a shared directory, the
// reviewer's probe from the issue body.
describe("scripts/hooks/guard-bash.mjs -- path-argument resolver (#3988)", () => {
	type PathRow = {
		label: string;
		/** `@W@` symlinked worktree, `@CLEAN@` worktree with a real node_modules, `@HOME@`, `@ROOT@`, `@SCRATCH@` (HOME/scratch). */
		command: string;
		/** payload cwd, same placeholders; default PAYLOAD_CWD */
		cwd?: string;
		/** extra hook env; `undefined` removes the variable */
		env?: Record<string, string | undefined>;
		rule: DenyRule | null;
	};

	let fixture: ReturnType<typeof makeLinkedWorktreeFixture>;
	let home: string;
	let scratch: string;
	let clean: string;
	let shared: string;

	beforeAll(() => {
		fixture = makeLinkedWorktreeFixture(join("home", "scratch", "wt"));
		home = join(fixture.root, "home");
		scratch = join(home, "scratch");
		shared = join(fixture.root, "shared-node-modules");
		mkdirSync(shared);
		symlinkSync(shared, join(fixture.linked, "node_modules"));
		// A second registered-looking tree whose node_modules is a REAL
		// directory: the allow arm that proves a resolved path is judged, not
		// blanket-denied.
		clean = join(scratch, "clean");
		mkdirSync(join(clean, "node_modules"), { recursive: true });
		writeFileSync(
			join(clean, ".git"),
			"gitdir: /some/main/checkout/.git/worktrees/clean\n",
		);
		// HOME/away/lnk -> HOME/scratch/wt: `away/lnk/../wt` names the
		// symlinked tree to the kernel and `away/wt` (absent) lexically (#3997 H3).
		mkdirSync(join(home, "away"));
		symlinkSync(join("..", "scratch", "wt"), join(home, "away", "lnk"));
		// HOME/rootlink and HOME/scratch/rl -> /: a symlinked parent whose
		// physical place differs from its spelling, for destinations that do not
		// exist yet (#4060 item 2). /usr is off /tmp and /tmp is on it, on every host.
		symlinkSync("/", join(home, "rootlink"));
		symlinkSync("/", join(scratch, "rl"));
	});

	afterAll(() => {
		rmSync(fixture.root, { recursive: true, force: true });
	});

	function fill(text: string): string {
		return text
			.replaceAll("@W@", fixture.linked)
			.replaceAll("@CLEAN@", clean)
			.replaceAll("@SCRATCH@", scratch)
			.replaceAll("@HOME@", home)
			.replaceAll("@ROOT@", fixture.root);
	}

	function decide(row: PathRow) {
		const env: NodeJS.ProcessEnv = { ...BASE_ENV, HOME: home };
		for (const [key, value] of Object.entries(row.env ?? {}))
			if (value === undefined) delete env[key];
			else env[key] = fill(value);
		return hookVerdict(fill(row.command), env, fill(row.cwd ?? PAYLOAD_CWD));
	}

	function expectRule(row: PathRow) {
		const result = decide(row);
		if (row.rule === null) {
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
		} else {
			expect(result.stderr).toBe(`${RULE_MESSAGES[row.rule]}\n`);
			expect(result.status).toBe(2);
		}
	}

	const OFF_TMP_HOME = "/home/dev/guard-bash-3988-home";
	const TMP_HOME = "/tmp/guard-bash-3988-home";

	// -- git worktree remove: spelling x cwd context -> #3173 deny -----------
	const REMOVE_DENY_ROWS: PathRow[] = [
		{
			label: "absolute path (baseline)",
			command: "git worktree remove --force @W@",
			rule: "worktreeSymlink",
		},
		{
			label: "~/ spelling",
			command: "git worktree remove ~/scratch/wt",
			rule: "worktreeSymlink",
		},
		{
			label: "$HOME/ spelling",
			command: "git worktree remove $HOME/scratch/wt",
			rule: "worktreeSymlink",
		},
		{
			label: "${HOME}/ spelling",
			command: "git worktree remove ${HOME}/scratch/wt",
			rule: "worktreeSymlink",
		},
		{
			label: "~/ spelling after a chained `echo x;`",
			command: "echo x; git worktree remove --force ~/scratch/wt",
			rule: "worktreeSymlink",
		},
		{
			label: "double-quoted $HOME spelling",
			command: 'git worktree remove "$HOME/scratch/wt"',
			rule: "worktreeSymlink",
		},
		{
			label: "relative path from the payload cwd",
			command: "git worktree remove wt",
			cwd: "@SCRATCH@",
			rule: "worktreeSymlink",
		},
		{
			label: "relative ../ path with a trailing slash",
			command: "git worktree remove ../scratch/wt/",
			cwd: "@SCRATCH@",
			rule: "worktreeSymlink",
		},
		{
			label: "`.` with the payload cwd inside the tree",
			command: "git worktree remove .",
			cwd: "@W@",
			rule: "worktreeSymlink",
		},
		{
			label: "relative path after `cd <relative> &&`",
			command: "cd scratch && git worktree remove wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "relative path after `cd <relative>;`",
			command: "cd scratch; git worktree remove wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "relative path after `cd ~/dir &&`",
			command: "cd ~/scratch && git worktree remove wt",
			cwd: "@ROOT@",
			rule: "worktreeSymlink",
		},
		{
			label: "relative path after `cd $HOME/dir &&`",
			command: "cd $HOME/scratch && git worktree remove wt",
			cwd: "@ROOT@",
			rule: "worktreeSymlink",
		},
		{
			label: "relative path after `cd -P dir &&`",
			command: "cd -P scratch && git worktree remove wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "relative path inside `(cd dir && ...)`",
			command: "(cd scratch && git worktree remove wt)",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "relative path after `git -C <relative>`",
			command: "git -C scratch worktree remove wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "relative path after `git -C ~/dir`",
			command: "git -C ~/scratch worktree remove wt",
			cwd: "@ROOT@",
			rule: "worktreeSymlink",
		},
		{
			label: "relative path after chained `git -C a -C b`",
			command: "git -C @HOME@ -C scratch worktree remove wt",
			cwd: "@ROOT@",
			rule: "worktreeSymlink",
		},
		{
			label: "$PWD-anchored path",
			command: "git worktree remove $PWD/wt",
			cwd: "@SCRATCH@",
			rule: "worktreeSymlink",
		},
		{
			label: "variable assigned earlier in the command (tilde in the value)",
			command: "S=~/scratch; git worktree remove $S/wt",
			rule: "worktreeSymlink",
		},
		{
			label: "exported variable holding a $HOME path",
			command: 'export V=$HOME/scratch/wt; git worktree remove "$V"',
			rule: "worktreeSymlink",
		},
		{
			label: "~/ spelling with HOME exported in the command, not the hook env",
			command: "export HOME=@HOME@; git worktree remove ~/scratch/wt",
			env: { HOME: "/nonexistent-3988" },
			rule: "worktreeSymlink",
		},
		{
			label: "variable that exists only in the hook's ambient env",
			command: "git worktree remove $WT_3988",
			env: { WT_3988: "@W@" },
			rule: "worktreeSymlink",
		},
	];

	// -- git worktree remove: unresolvable -> fail CLOSED (#3988) ------------
	const REMOVE_UNRESOLVED_ROWS: PathRow[] = [
		{
			label: "variable with no known value",
			command: "git worktree remove $OTHERVAR_3988/scratch/wt",
			rule: "worktreeUnresolved",
		},
		{
			label: "$(...) inside the path",
			command: "git worktree remove $(pwd)/scratch/wt",
			rule: "worktreeUnresolved",
		},
		{
			label: "whole path from a quoted $(...)",
			command: 'git worktree remove "$(cat wt.txt)"',
			rule: "worktreeUnresolved",
		},
		{
			label: "backticks inside the path",
			command: "git worktree remove `pwd`/scratch/wt",
			rule: "worktreeUnresolved",
		},
		{
			label: "~user spelling",
			command: "git worktree remove ~nobody/scratch/wt",
			rule: "worktreeUnresolved",
		},
		{
			label: "parameter expansion with an operator",
			command: "git worktree remove ${HOME:-x}/scratch/wt",
			rule: "worktreeUnresolved",
		},
		{
			label: "glob that expands to the tree",
			command: "git worktree remove ~/scratch/w*",
			rule: "worktreeUnresolved",
		},
		{
			label: "HOME unset in the hook env",
			command: "git worktree remove $HOME/scratch/wt",
			env: { HOME: undefined },
			rule: "worktreeUnresolved",
		},
		{
			label: "~/ spelling with HOME unset in the hook env",
			command: "git worktree remove ~/scratch/wt",
			env: { HOME: undefined },
			rule: "worktreeUnresolved",
		},
		{
			label: "self-referential variable chain",
			command: "A=$A; git worktree remove $A/wt",
			rule: "worktreeUnresolved",
		},
		{
			label: "variable chain that bottoms out in an unknown variable",
			command: "A=$B_3988; git worktree remove $A/wt",
			rule: "worktreeUnresolved",
		},
		{
			label: "relative path after `cd $UNKNOWN &&` (cwd unknown)",
			command: "cd $OTHERVAR_3988 && git worktree remove wt",
			cwd: "@SCRATCH@",
			rule: "worktreeUnresolved",
		},
		{
			label: "relative path after `cd ~user &&` (cwd unknown)",
			command: "cd ~nobody && git worktree remove wt",
			cwd: "@SCRATCH@",
			rule: "worktreeUnresolved",
		},
		{
			label: "relative path after `cd $(...) &&` (cwd unknown)",
			command: "cd $(git rev-parse --show-toplevel) && git worktree remove wt",
			cwd: "@SCRATCH@",
			rule: "worktreeUnresolved",
		},
		{
			label: "relative path after `popd` (cwd unknown)",
			command: "popd >/dev/null && git worktree remove wt",
			cwd: "@SCRATCH@",
			rule: "worktreeUnresolved",
		},
		{
			label: "relative path after `git -C $UNKNOWN`",
			command: "git -C $OTHERVAR_3988 worktree remove wt",
			cwd: "@SCRATCH@",
			rule: "worktreeUnresolved",
		},
		{
			label: 'relative path after `git -C "$(...)"`',
			command: 'git -C "$(pwd)" worktree remove wt',
			cwd: "@SCRATCH@",
			rule: "worktreeUnresolved",
		},
	];

	// -- git worktree remove: resolved, and judged on its merits -> allow ----
	const REMOVE_ALLOW_ROWS: PathRow[] = [
		{
			label: "~/ spelling of a tree with a real node_modules",
			command: "git worktree remove ~/scratch/clean",
			rule: null,
		},
		{
			label: "$HOME/ spelling of a tree with a real node_modules",
			command: "git worktree remove $HOME/scratch/clean",
			rule: null,
		},
		{
			label: "relative path of a tree with a real node_modules",
			command: "git worktree remove clean",
			cwd: "@SCRATCH@",
			rule: null,
		},
		{
			label: "`cd dir &&` relative path of a clean tree",
			command: "cd scratch && git worktree remove clean",
			cwd: "@HOME@",
			rule: null,
		},
		{
			label: "`git -C dir` relative path of a clean tree",
			command: "git -C scratch worktree remove clean",
			cwd: "@HOME@",
			rule: null,
		},
		{
			label: "ambient variable naming a clean tree",
			command: "git worktree remove $WT_3988",
			env: { WT_3988: "@CLEAN@" },
			rule: null,
		},
		{
			label: "~/ path that is not a worktree at all",
			command: "git worktree remove ~/scratch/gone",
			rule: null,
		},
		{
			// Recurrence: a `cd` inside `( ... )` leaked its directory to every
			// later segment, so this resolved `wt` under scratch and denied.
			label: "a subshell's `cd` does not leak out of its parentheses",
			command: "(cd scratch && true); git worktree remove wt",
			cwd: "@HOME@",
			rule: null,
		},
		{
			label: "no path argument at all",
			command: "git worktree remove --help",
			rule: null,
		},
	];

	it.each(REMOVE_DENY_ROWS)("denies the #3173 hazard through $label", (row) =>
		expectRule(row),
	);

	it.each(REMOVE_UNRESOLVED_ROWS)(
		"fails closed (named rule) on an unresolvable path: $label",
		(row) => {
			expectRule(row);
			expect(RULE_MESSAGES.worktreeUnresolved).toContain("#3988");
		},
	);

	it.each(REMOVE_ALLOW_ROWS)("allows a resolved clean path: $label", (row) =>
		expectRule(row),
	);

	// -- #3997 round 4: the remove rows c0184f1 got wrong ---------------------
	// Each row is a cell of the PR body's "Round 4" table that c0184f1 allowed
	// (or denied for the wrong reason). H2: c0184f1 stripped a whole-word
	// substitution to "", which skipped the check. H3: `path.resolve` drops
	// `lnk/..` lexically, but git removed the tree `lnk` points at (measured).
	// F4: bash expands `~` before an inline `HOME=` applies. F5: a real `$`
	// chain, plus the identifier-valued spelling bash reads as a literal word.
	const ROUND4_REMOVE_ROWS: PathRow[] = [
		{
			label: "H2 unquoted $(...) as the whole path",
			command: "git worktree remove $(echo wt)",
			cwd: "@SCRATCH@",
			rule: "worktreeUnresolved",
		},
		{
			label: "H2 backticks as the whole path",
			command: "git worktree remove `echo wt`",
			cwd: "@SCRATCH@",
			rule: "worktreeUnresolved",
		},
		{
			label: "H2 --force, then a quoted $(...)",
			command: 'git worktree remove --force "$(echo wt)"',
			cwd: "@SCRATCH@",
			rule: "worktreeUnresolved",
		},
		{
			label: "H2 --, then a quoted $(...)",
			command: 'git worktree remove -- "$(echo wt)"',
			cwd: "@SCRATCH@",
			rule: "worktreeUnresolved",
		},
		{
			label: "H2 a $(...) word before the path",
			command: "git worktree remove $(echo -f) wt",
			cwd: "@SCRATCH@",
			rule: "worktreeUnresolved",
		},
		{
			label: "H2 an unquoted $(...) as the git -C directory",
			command: "git -C $(pwd) worktree remove wt",
			cwd: "@SCRATCH@",
			rule: "worktreeUnresolved",
		},
		{
			label: "H3 a relative path through a symlink, then ..",
			command: "git worktree remove away/lnk/../wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "H3 a $PWD path through a symlink, then ..",
			command: "git worktree remove $PWD/away/lnk/../wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "H3 symlink, then .. after git -C",
			command: "git -C away worktree remove lnk/../wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "H3 symlink, then .. as the git -C directory",
			command: "git -C away/lnk/.. worktree remove wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "H3 symlink, then .. after a cd",
			command: "cd away; git worktree remove lnk/../wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			// bash's `cd` is logical (`cd away/lnk/.. && pwd` prints HOME/away),
			// so `wt` names the absent HOME/away/wt, not the symlinked tree.
			label: "H3 a cd target stays logical",
			command: "cd away/lnk/.. && git worktree remove wt",
			cwd: "@HOME@",
			rule: null,
		},
		{
			label: "F4 an inline HOME= does not change what ~ expands to",
			command: "HOME=/nonexistent-3997 git worktree remove ~/scratch/wt",
			rule: "worktreeSymlink",
		},
		{
			label: "F5 an 8-variable $ chain ending in ~ resolves",
			command:
				"H=~/scratch/wt; G=$H; F=$G; E=$F; D=$E; C=$D; B=$C; A=$B; git worktree remove $A",
			rule: "worktreeSymlink",
		},
		{
			label: "F5 a 9-variable $ chain fails closed at the bound",
			command:
				"I=~/scratch/wt; H=$I; G=$H; F=$G; E=$F; D=$E; C=$D; B=$C; A=$B; git worktree remove $A",
			rule: "worktreeUnresolved",
		},
		{
			// `$A` is the literal word `B` to bash: a relative path that is absent.
			label: "F5 an identifier-valued variable is a literal word, not a chain",
			command:
				"A=B; B=C; C=D; D=E; E=F; F=G; G=H; H=~/scratch/wt; git worktree remove $A",
			rule: null,
		},
	];

	it.each(ROUND4_REMOVE_ROWS)("round 4 remove cell: $label", (row) =>
		expectRule(row),
	);

	// -- #4060 item 1: `cd -P` resolves its target physically ---------------
	// Measured with bash 5: the LAST of -L/-P in the options wins, flags may be
	// clustered, and `-e` does not change the mode. `cd away/lnk/..` prints
	// HOME/away (logical); `cd -P away/lnk/..` prints HOME/scratch.
	const CD_PHYSICAL_ROWS: PathRow[] = [
		{
			label: "cd -P through a symlink, then ..",
			command: "cd -P away/lnk/.. && git worktree remove wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "cd -LP (the last flag wins)",
			command: "cd -LP away/lnk/.. && git worktree remove wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "cd -L -P (the last flag wins)",
			command: "cd -L -P away/lnk/.. && git worktree remove wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "cd -Pe (-e does not change the mode)",
			command: "cd -Pe away/lnk/.. && git worktree remove wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "cd -P -- (the option terminator)",
			command: "cd -P -- away/lnk/.. && git worktree remove wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "cd -P to the link, then a plain cd ..",
			command: "cd -P away/lnk && cd .. && git worktree remove wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			label: "a logical cd to the link, then cd -P ..",
			command: "cd away/lnk && cd -P .. && git worktree remove wt",
			cwd: "@HOME@",
			rule: "worktreeSymlink",
		},
		{
			// The physical cwd is the shared install itself and no longer names the
			// link, so only the logical reading of the same `cd` still denies this.
			label: "cd -P into a linked node_modules, then rm -rf *",
			command: "cd -P node_modules && rm -rf *",
			cwd: "@W@",
			rule: "linkedNodeModulesDelete",
		},
		{
			label: "cd -PL stays logical (the last flag wins)",
			command: "cd -PL away/lnk/.. && git worktree remove wt",
			cwd: "@HOME@",
			rule: null,
		},
		{
			label: "cd -P -L stays logical (the last flag wins)",
			command: "cd -P -L away/lnk/.. && git worktree remove wt",
			cwd: "@HOME@",
			rule: null,
		},
		{
			label: "cd -L stays logical",
			command: "cd -L away/lnk/.. && git worktree remove wt",
			cwd: "@HOME@",
			rule: null,
		},
	];

	it.each(CD_PHYSICAL_ROWS)("cd mode (#4060 item 1): $label", (row) =>
		expectRule(row),
	);

	// -- #4060 item 2: a destination that does not exist yet ----------------
	// `realpath` fails on the missing leaf, so the resolver resolves the nearest
	// existing ancestor physically and appends the missing tail. `rootlink` is a
	// symlink to `/`: the same spelling lands under /usr (allow) and under /tmp
	// (deny), and the fixture root itself sits under /tmp on a host whose TMPDIR
	// is /tmp, so each direction is the red on one kind of host.
	const MISSING_LEAF_ROWS: PathRow[] = [
		{
			label: "worktree add below a symlink to /, landing under /tmp",
			command: "git worktree add rootlink/tmp/pi-lens-4060-new",
			cwd: "@HOME@",
			rule: "tmpCheckout",
		},
		{
			label: "worktree add below a symlink to /, landing under /usr",
			command: "git worktree add rootlink/usr/pi-lens-4060-new",
			cwd: "@HOME@",
			rule: null,
		},
		{
			label: "worktree add two missing levels below a symlink to /, under /tmp",
			command: "git worktree add rootlink/tmp/pi-lens-4060-a/b/new",
			cwd: "@HOME@",
			rule: "tmpCheckout",
		},
		{
			// F4 (PR #4935 review): both readings of the /tmp row above deny on a
			// host whose TMPDIR is /tmp (HOME is then under /tmp lexically too), so
			// it never tested the walk there. This one differs by host kind: the
			// kernel puts it under /usr (allow), the spelling under HOME.
			label:
				"worktree add two missing levels below a symlink to /, landing under /usr",
			command: "git worktree add rootlink/usr/pi-lens-4060-a/b/new",
			cwd: "@HOME@",
			rule: null,
		},
		{
			label: "clone below a symlink to /, landing under /tmp",
			command: "git clone r rootlink/tmp/pi-lens-4060-new",
			cwd: "@HOME@",
			rule: "tmpCheckout",
		},
		{
			label: "clone below a symlink to /, landing under /usr",
			command: "git clone r rootlink/usr/pi-lens-4060-new",
			cwd: "@HOME@",
			rule: null,
		},
		{
			label: "mktemp -d template below a symlink to /, landing under /tmp",
			command: "mktemp -d rootlink/tmp/x.XXXXXX",
			cwd: "@HOME@",
			rule: "tmpCheckout",
		},
		{
			label: "mktemp -d template below a symlink to /, landing under /usr",
			command: "mktemp -d rootlink/usr/x.XXXXXX",
			cwd: "@HOME@",
			rule: null,
		},
		{
			label:
				"mktemp -d template with a missing directory below a symlink to /, under /tmp",
			command: "mktemp -d rootlink/tmp/pi-lens-4060-gone/x.XXXXXX",
			cwd: "@HOME@",
			rule: "tmpCheckout",
		},
		{
			label: "git -C a symlink to /, then a missing /tmp destination",
			command: "git -C rootlink/tmp worktree add pi-lens-4060-new",
			cwd: "@HOME@",
			rule: "tmpCheckout",
		},
		{
			// The `..` after `lnk` is the kernel's, so the walk starts from the raw
			// spelling: collapsing it first names HOME/away/rl/usr/…, which holds
			// no symlink to follow.
			label: "a symlink, then .., then a symlink to / (the raw spelling walks)",
			command: "git worktree add away/lnk/../rl/usr/pi-lens-4060-new",
			cwd: "@HOME@",
			rule: null,
		},
		{
			label: "a symlink, then .., then a symlink to /, landing under /tmp",
			command: "git worktree add away/lnk/../rl/tmp/pi-lens-4060-new",
			cwd: "@HOME@",
			rule: "tmpCheckout",
		},
	];

	it.each(MISSING_LEAF_ROWS)("missing leaf (#4060 item 2): $label", (row) =>
		expectRule(row),
	);

	// lane: Linux unit shards. /proc/self/root is the hook process's own root, so
	// the spelling is off /tmp lexically and on it physically whatever TMPDIR is.
	it.skipIf(process.platform !== "linux").each([
		["worktree add", "git worktree add /proc/self/root/tmp/pi-lens-4060-new"],
		["clone", "git clone r /proc/self/root/tmp/pi-lens-4060-new"],
		["mktemp -d", "mktemp -d /proc/self/root/tmp/x.XXXXXX"],
	])(
		"missing leaf below /proc/self/root/tmp (#4060 item 2): %s",
		(_name, command) =>
			expectRule({ label: command, command, rule: "tmpCheckout" }),
	);

	// -- the other path-taking rules go through the SAME resolver ------------
	// tmpCheckout (#3526): worktree add, clone, mktemp -d, plus `cd`/`-C`.
	// An unresolvable variable stays a documented fail-OPEN there: it is a
	// hygiene rule, and denying every `git worktree add "$WT"` would block
	// ordinary fixer work for a path that cannot be shown to be under /tmp.
	const TMP_ROWS: PathRow[] = [
		{
			label: "worktree add after `git -C /tmp` with a relative path",
			command: "git -C /tmp worktree add wt",
			rule: "tmpCheckout",
		},
		{
			label: "clone into a relative directory after `git -C /tmp`",
			command: "git -C /tmp clone https://example.invalid/r.git x",
			rule: "tmpCheckout",
		},
		{
			label: "worktree add after `cd $VAR &&` where VAR=/tmp",
			command: "T=/tmp; cd $T && git worktree add wt",
			rule: "tmpCheckout",
		},
		{
			label: "worktree add at $HOME/ with HOME under /tmp",
			command: "git worktree add $HOME/wt",
			env: { HOME: TMP_HOME },
			rule: "tmpCheckout",
		},
		{
			label: "clone into ${HOME}/ with HOME under /tmp",
			command: "git clone https://example.invalid/r.git ${HOME}/x",
			env: { HOME: TMP_HOME },
			rule: "tmpCheckout",
		},
		{
			label: "mktemp -d with a $TMPDIR/ template under /tmp",
			command: "mktemp -d $TMPDIR/x.XXXXXX",
			env: { TMPDIR: "/tmp/guard-bash-3988-tmpdir" },
			rule: "tmpCheckout",
		},
		{
			label: "mktemp -d with a ~/ template and HOME under /tmp",
			command: "mktemp -d ~/x.XXXXXX",
			env: { HOME: TMP_HOME },
			rule: "tmpCheckout",
		},
		{
			label: "worktree add after `cd ~ &&` with HOME under /tmp",
			command: "cd ~ && git worktree add wt",
			env: { HOME: TMP_HOME },
			rule: "tmpCheckout",
		},
		{
			label: "worktree add at $HOME/ with HOME off /tmp",
			command: "git worktree add $HOME/wt",
			env: { HOME: OFF_TMP_HOME },
			rule: null,
		},
		{
			label: "worktree add after `git -C ~/dir` with HOME off /tmp",
			command: "git -C ~/proj worktree add wt",
			env: { HOME: OFF_TMP_HOME },
			rule: null,
		},
		{
			label: "mktemp -d with a ~/ template and HOME off /tmp",
			command: "mktemp -d ~/x.XXXXXX",
			env: { HOME: OFF_TMP_HOME },
			rule: null,
		},
		{
			label: "worktree add at an unresolvable variable (documented fail-open)",
			command: "git worktree add $OTHERVAR_3988/wt",
			rule: null,
		},
	];

	it.each(TMP_ROWS)(
		"tmp-checkout rule resolves through the shared resolver: $label",
		(row) => expectRule(row),
	);

	// node probe (#3680): a `~`/`$HOME` file argument was resolved as a RELATIVE
	// path under cwd, so the repository-ownership check judged the wrong file.
	describe("node probe file argument", () => {
		let otherRepo: string;
		let foreignDir: string;

		beforeAll(() => {
			otherRepo = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-3988-other-"));
			foreignDir = mkdtempSync(
				join(tmpdir(), "pi-lens-guard-bash-3988-foreign-"),
			);
			mkdirSync(join(otherRepo, "dist"));
			// An empty `.git` directory is all repositoryRoot/repositoryIdentity read;
			// no `git init` spawn, so the real-process-spawn ratchet does not rise.
			mkdirSync(join(otherRepo, ".git"));
		});

		afterAll(() => {
			rmSync(otherRepo, { recursive: true, force: true });
			rmSync(foreignDir, { recursive: true, force: true });
		});

		it.each([
			["~", "~/dist/cli.js"],
			["$HOME", "$HOME/dist/cli.js"],
		])(
			"allows a %s spelling of a runtime file in ANOTHER repository",
			(_label, spelling) => {
				const result = hookVerdict(
					`node ${spelling} --help`,
					{ ...BASE_ENV, HOME: otherRepo },
					repoRoot,
				);
				expect(result.stderr).toBe("");
				expect(result.status).toBe(0);
			},
		);

		it.each([
			["~", "~/clients/probe.mjs"],
			["$HOME", "$HOME/clients/probe.mjs"],
		])(
			"denies a %s spelling of a runtime file in THIS repository, from a foreign cwd",
			(_label, spelling) => {
				const result = hookVerdict(
					`node ${spelling}`,
					{ ...BASE_ENV, HOME: repoRoot },
					foreignDir,
				);
				expect(result.stderr).toBe(`${RULE_MESSAGES.probe}\n`);
				expect(result.status).toBe(2);
			},
		);

		// #4057: bash expands node's file word from the shell's own variables
		// before an inline prefix applies, as it does git's (#3997), while node
		// reads PI_LENS_HOME from its own environment, prefix included. Measured
		// on /bin/bash 3.2: with R=a in the shell, `R=b PI_LENS_HOME=/h node
		// $R/dist/x.js` ran a's script, and the script saw PI_LENS_HOME=/h. Each
		// row sets the hook's ambient value itself and runs the real hook.
		it.each([
			{
				label: "an inline HOME= does not move ~ out of this repository",
				command: "HOME=@OTHER@ node ~/clients/probe.mjs",
				ambient: { HOME: "@REPO@" },
				rule: "probe",
			},
			{
				label: "an inline HOME= does not move ~ into this repository",
				command: "HOME=@REPO@ node ~/clients/probe.mjs",
				ambient: { HOME: "@OTHER@" },
				rule: null,
			},
			{
				label:
					"an inline VAR= does not move a $VAR file out of this repository",
				command: "LANE_4057=@OTHER@ node $LANE_4057/dist/cli.js",
				ambient: { LANE_4057: "@REPO@" },
				rule: "probe",
			},
			{
				label: "an inline VAR= does not move a $VAR file into this repository",
				command: "LANE_4057=@REPO@ node $LANE_4057/dist/cli.js",
				ambient: { LANE_4057: "@OTHER@" },
				rule: null,
			},
			{
				label: "an inline PI_LENS_HOME= still pins the probe node runs",
				command:
					"PI_LENS_HOME=/x/.probe-home LANE_4057=@OTHER@ node $LANE_4057/clients/probe.mjs",
				ambient: { LANE_4057: "@REPO@" },
				rule: null,
			},
		] as Array<{
			label: string;
			command: string;
			ambient: Record<string, string>;
			rule: DenyRule | null;
		}>)("$label (#4057)", ({ command, ambient, rule }) => {
			const fill = (text: string) =>
				text.replaceAll("@REPO@", repoRoot).replaceAll("@OTHER@", otherRepo);
			const result = runHook(
				fill(command),
				{
					...BASE_ENV,
					...Object.fromEntries(
						Object.entries(ambient).map(([key, value]) => [key, fill(value)]),
					),
				},
				foreignDir,
			);
			expect(result.stderr).toBe(
				rule === null ? "" : `${RULE_MESSAGES[rule]}\n`,
			);
			expect(result.status).toBe(rule === null ? 0 : 2);
		});

		// #4057 accepted residual: neither the shell nor the hook's env has
		// LANE_4057, so bash expands `$LANE_4057` to the empty string and node
		// runs `/clients/probe.mjs`. expandShellWord leaves an unknown `$NAME` in
		// place, and loadsPiLensRuntime resolves that leftover under this
		// repository, so the hook denies, as master does for the same word with no
		// prefix. Master allowed the prefixed form only by expanding the prefix.
		it.each([
			{
				label: "an inline VAR= does not resolve an unknown $VAR file word",
				command:
					"LANE_4057=/home/dev/guard-bash-4057-lane node $LANE_4057/clients/probe.mjs",
			},
			{
				label: "an unknown $VAR file word with no prefix",
				command: "node $LANE_4057/clients/probe.mjs",
			},
		])("$label reads as relative to this repository (#4057)", ({ command }) => {
			const result = runHook(
				command,
				Object.fromEntries(
					Object.entries(BASE_ENV).filter(([key]) => key !== "LANE_4057"),
				),
				repoRoot,
			);
			expect(result.stderr).toBe(`${RULE_MESSAGES.probe}\n`);
			expect(result.status).toBe(2);
		});

		// Recurrence (#4826 review r1 F1): an inline `S=` prefix used to cover
		// `$S` after an absolute head only because the prefix was expanded into
		// the word. The shell has no S, so bash hands node `<repo>/clients/…` and
		// the file loads. The word has two readings, as written and with the
		// references it cannot resolve removed; either one loading this
		// repository's runtime denies.
		it.each([
			{
				label: "an unset $S after ${PWD}, S only in the prefix",
				command: "S= node ${PWD}$S/clients/probe.mjs",
				rule: "probe" as DenyRule | null,
			},
			{
				label: "an unset $S after ${PWD} with no prefix",
				command: "node ${PWD}$S/clients/probe.mjs",
				rule: "probe" as DenyRule | null,
			},
			{
				label: "an unset $S after a resolved $R",
				command: "R=@REPO@; S= node $R$S/dist/x.js",
				rule: "probe" as DenyRule | null,
			},
			{
				label: "a ${S:-} after ${PWD}",
				command: "node ${PWD}${S:-}/clients/probe.mjs",
				rule: "probe" as DenyRule | null,
			},
			{
				label: "an unset $S after ${PWD} for a file outside clients/ and dist/",
				command: "S= node ${PWD}$S/scripts/x.mjs",
				rule: null,
			},
		])("$label (#4057)", ({ command, rule }) => {
			const result = runHook(
				command.replaceAll("@REPO@", repoRoot),
				Object.fromEntries(
					Object.entries(BASE_ENV).filter(([key]) => key !== "S"),
				),
				repoRoot,
			);
			expect(result.stderr).toBe(
				rule === null ? "" : `${RULE_MESSAGES[rule]}\n`,
			);
			expect(result.status).toBe(rule === null ? 0 : 2);
		});
	});
});

// #3997 round 4: a substitution's output is unknown, so the hook reads it
// both as empty (the text master scanned) and as one opaque word piece, and
// denies when either reading denies. Each deny row is a cell master denied and
// c0184f1 allowed: the substitution's mark split or fused a rule word, or
// (H1) the inline hook-bypass env never reached classifyGit.
describe("scripts/hooks/guard-bash.mjs -- substitution next to a rule word (#3997)", () => {
	it.each([
		["git $(:) stash", "stash"],
		["$(:) git stash", "stash"],
		["sudo $(:) git stash", "stash"],
		["env $(:) git stash", "stash"],
		["git -C . $(:) stash", "stash"],
		["git `:` stash", "stash"],
		["npm$(:) run lint; git$(:) commit -m x", "checkUngated"],
		["mktemp $(:)-d /tmp/x.XXXX", "tmpCheckout"],
		["git worktree add /tm$(:)p/wt", "tmpCheckout"],
		["git clone r /tm$(:)p/x", "tmpCheckout"],
		["HUSKY=0 git $(:) commit -m x", "hookBypass"],
		["PI_LENS_SKIP_HOOKS=1 git co$(:)mmit -m x", "hookBypass"],
	] as Array<[string, DenyRule]>)("denies %s", (command, rule) => {
		const result = runHook(command);
		expect(result.stderr).toBe(`${RULE_MESSAGES[rule]}\n`);
		expect(result.status).toBe(2);
	});

	// The opaque reading must not turn an ordinary substitution into a deny.
	it.each([
		'git commit -m "$(cat msg.txt)"',
		"echo $(git rev-parse HEAD)",
		'git -C "$(git rev-parse --show-toplevel)" status',
	])("allows %s", (command) => {
		const result = runHook(command);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
});

// #4060 item 3: two spans the lexer closed in the wrong place, so `git stash`
// ran with the hook reading it as quoted text or as part of a substitution.
// Every DENY row was measured against bash 5 with a fake `git` that touches a
// marker: each one really runs `git stash`, except the `echo case x in` row,
// which only pins that the span closes at its own paren (the hook denies it
// under the empty reading of the substitution, as it denies `git $(:) stash`).
//   (a) a case pattern's `)` closed a `$( … )` body at the first pattern;
//   (b) `$'\''` (ANSI-C quoting, where `\'` is an escaped quote) read as a
//       closed quote followed by an open one, in a body and at top level.
describe("scripts/hooks/guard-bash.mjs -- case patterns and ANSI-C quotes (#4060)", () => {
	it.each([
		["a case pattern in a substitution", "git $(case x in x) : ;; esac) stash"],
		["a leading-paren pattern", "git $(case x in (x) : ;; esac) stash"],
		["an alternation pattern", "git $(case x in y|x) : ;; esac) stash"],
		["the ;& terminator", "git $(case x in x) : ;& y) : ;; esac) stash"],
		["esac after a plain ;", "git $(case x in x) : ; esac) stash"],
		["newline-separated clauses", "git $(case x in\nx) :\n;;\nesac) stash"],
		[
			"a nested case",
			"git $(case x in x) case y in y) : ;; esac ;; esac) stash",
		],
		[
			"a substitution as the subject",
			"git $(case $(echo x) in x) : ;; esac) stash",
		],
		["case after then", "git $(if :; then case x in x) : ;; esac; fi) stash"],
		["case after a ;", "git $(: ; case x in x) : ;; esac) stash"],
		[
			"an ANSI-C quote in a case body",
			"git $(case x in x) echo $'\\'' ;; esac) stash",
		],
		["an ANSI-C \\' in a substitution", "$(: $'\\'' ) git stash"],
		[
			"an ANSI-C \\' that must not swallow the closing paren",
			"git $(: $'\\'') stash",
		],
		["an ANSI-C \\' at top level", "echo $'\\'' ; git stash"],
		["an ANSI-C \\' mid-word", "echo $'a\\'b' && git stash"],
		[
			"a `case x in` argument whose paren must still close the substitution",
			"git $(echo case x in) stash",
		],
	] as Array<[string, string]>)("denies %s", (_name, command) => {
		const result = runHook(command);
		expect(result.stderr).toBe(`${RULE_MESSAGES.stash}\n`);
		expect(result.status).toBe(2);
	});

	it.each([
		["a case in a substitution", "echo $(case x in x) echo hi ;; esac)"],
		[
			"a case in a quoted substitution",
			'git commit -m "$(case x in x) echo hi ;; esac)"',
		],
		["an ANSI-C \\' then a harmless command", "echo $'\\'' ; echo ok"],
		["an ANSI-C \\\\ closes at the quote", "echo $'\\\\' ; echo ok"],
		["a `case` argument is not a case clause", "echo $(echo case x in)"],
	])("allows %s", (_name, command) => {
		const result = runHook(command);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});

	it("keeps `$'` inside double quotes literal: the next command still runs", () => {
		const result = runHook(`echo "$'" ; git stash`);
		expect(result.stderr).toBe(`${RULE_MESSAGES.stash}\n`);
		expect(result.status).toBe(2);
	});
});

// #4060 round 2 (PR #4935 review F3): `physicalPath` puts a missing leaf where
// the kernel does, so where /tmp is a symlink (macOS: /tmp -> private/tmp) the
// destination `/tmp/new` resolves to `/private/tmp/new`, which a literal-/tmp
// comparison misses. Master kept the lexical `/tmp/new` and denied it; head
// allowed it, and no lane runs this suite on macOS. The hook is copied with its
// one `TMP_ROOT` literal re-pointed at a fixture root that is a symlink, which
// is the macOS shape on any host, and imported in process like `findDeny`'s
// other callers here (a spawned copy would be a new real-process-spawn hit).
describe("scripts/hooks/guard-bash.mjs -- tmpCheckout and tmpWrite where the tmp root is a symlink (#4060 r2, r3, r4)", () => {
	type HookModule = typeof import("../../scripts/hooks/guard-bash.mjs");
	let root: string;
	let mod: HookModule;
	// Roots whose `claude-<uid>` entry is itself a symlink (r4, PR #4935
	// CodeRabbit GjnV): to the physical tmp root, above it, and to a sibling.
	const harnessLinks = {
		self: ".",
		above: "..",
		sibling: "sib",
	} as const;
	const linkedRoots = new Map<keyof typeof harnessLinks, string>();
	const linkedMods = new Map<keyof typeof harnessLinks, HookModule>();
	const roots: string[] = [];

	// The hook is copied with its one `TMP_ROOT` literal re-pointed at
	// `<dir>/tmp`, a symlink to `private/tmp`, and imported in process.
	async function loadRooted(
		linkTarget?: string,
	): Promise<{ dir: string; hook: HookModule }> {
		const dir = realpathSync(
			mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-macroot-")),
		);
		roots.push(dir);
		mkdirSync(join(dir, "private", "tmp", "sib"), { recursive: true });
		symlinkSync(join("private", "tmp"), join(dir, "tmp"));
		if (linkTarget !== undefined && typeof process.getuid === "function")
			symlinkSync(
				linkTarget,
				join(dir, "private", "tmp", `claude-${process.getuid()}`),
			);
		const source = readFileSync(HOOK, "utf8");
		const literal = 'const TMP_ROOT = "/tmp";';
		// Guards the re-point itself: a renamed constant would make every row
		// below test the real /tmp instead of the fixture.
		expect(source.split(literal)).toHaveLength(2);
		const copy = join(dir, "guard-bash-macroot.mjs");
		writeFileSync(
			copy,
			source.replace(
				literal,
				`const TMP_ROOT = ${JSON.stringify(join(dir, "tmp"))};`,
			),
		);
		return {
			dir,
			hook: (await import(pathToFileURL(copy).href)) as HookModule,
		};
	}

	beforeAll(async () => {
		const main = await loadRooted();
		root = main.dir;
		mod = main.hook;
		mkdirSync(join(root, "elsewhere"));
		mkdirSync(join(root, "private", "other"), { recursive: true });
		for (const [name, target] of Object.entries(harnessLinks)) {
			const key = name as keyof typeof harnessLinks;
			const linked = await loadRooted(target);
			linkedRoots.set(key, linked.dir);
			linkedMods.set(key, linked.hook);
		}
	});

	afterAll(() => {
		for (const dir of roots) rmSync(dir, { recursive: true, force: true });
	});

	function verdict(command: string): string | null {
		return mod.findDeny(command, PAYLOAD_CWD);
	}

	it.each([
		["a missing leaf", "git worktree add @R@/tmp/pi-lens-4060-new"],
		["two missing levels", "git worktree add @R@/tmp/pi-lens-4060-a/b/new"],
		["a clone", "git clone r @R@/tmp/pi-lens-4060-new"],
		["an existing mktemp directory", "mktemp -d @R@/tmp/x.XXXXXX"],
		["a missing mktemp directory", "mktemp -d @R@/tmp/gone/x.XXXXXX"],
	])("denies %s below the symlinked root", (_name, template) => {
		expect(verdict(template.replaceAll("@R@", root))).toBe("tmpCheckout");
	});

	// #4060 round 3 (PR #4935 verify F7): `tmpWrite` asked the same root
	// question with the literal spelling only, so a redirect, `mkdir`, `touch`
	// or `cp` target below a symlinked /tmp lost its master denial (master kept
	// the lexical `/tmp/new` for a missing leaf; `physicalPath` now returns
	// `/private/tmp/new`).
	it.each([
		["a redirect to a missing leaf", "echo x > @R@/tmp/new.txt"],
		["an append two levels down", "echo x >> @R@/tmp/a/b.txt"],
		["a mkdir", "mkdir @R@/tmp/new"],
		["a touch", "touch @R@/tmp/new"],
		["a cp target", "cp a @R@/tmp/new.txt"],
	])("denies %s below the symlinked root as tmpWrite", (_name, template) => {
		expect(verdict(template.replaceAll("@R@", root))).toBe("tmpWrite");
	});

	// The harness's own `/tmp/claude-<uid>` stays exempt (there is no uid, and
	// so no harness directory, on Windows).
	it.skipIf(typeof process.getuid !== "function").each([
		[
			"a redirect into the harness directory",
			"echo x > @R@/tmp/claude-@U@/new",
		],
		["a mkdir in the harness directory", "mkdir @R@/tmp/claude-@U@/sub"],
	])("allows %s", (_name, template) => {
		const uid = String(process.getuid?.());
		expect(
			verdict(template.replaceAll("@R@", root).replaceAll("@U@", uid)),
		).toBeNull();
	});

	it("allows a redirect outside the symlinked root", () => {
		expect(verdict(`echo x > ${root}/elsewhere/new`)).toBeNull();
	});

	// #4060 round 4 (PR #4935 CodeRabbit GjnV, a regression of round 3): the
	// harness exemption must name the directory `claude-<uid>` directly below
	// the PHYSICAL tmp root. When that entry is a symlink to the tmp root, to
	// a directory above it, or to a sibling, exempting wherever it resolves
	// let `echo x > /tmp/new` (or every write under the sibling) through,
	// while master denied it.
	it.skipIf(typeof process.getuid !== "function").each([
		["the tmp root", "self", "echo x > @R@/tmp/new"],
		["the tmp root, at a nested leaf", "self", "mkdir @R@/tmp/a/b"],
		["a directory above the tmp root", "above", "echo x > @R@/tmp/new"],
		["a sibling directory", "sibling", "echo x > @R@/tmp/sib/new"],
		[
			"a sibling directory, by the link",
			"sibling",
			"echo x > @R@/tmp/claude-@U@/new",
		],
	] as const)(
		"denies a write when the harness directory is a symlink to %s",
		(_name, key, template) => {
			const dir = linkedRoots.get(key) as string;
			const hook = linkedMods.get(key) as HookModule;
			const command = template
				.replaceAll("@R@", dir)
				.replaceAll("@U@", String(process.getuid?.()));
			expect(hook.findDeny(command, PAYLOAD_CWD)).toBe("tmpWrite");
		},
	);

	it.each([
		["a sibling of the symlinked root", "git worktree add @R@/elsewhere/new"],
		[
			"the root's target spelled by its own name",
			"git worktree add @R@/private/other/new",
		],
	])("allows %s", (_name, template) => {
		expect(verdict(template.replaceAll("@R@", root))).toBeNull();
	});
});

// #4060 round 2 (PR #4935 review F1/F2): where a `case` clause may open inside
// a `$( … )` body is decided by the lexer's own command-position state, never
// by the text before the word. Each deny row below was measured against bash
// 5.3.9 with a fake `git` that records its argv: every one runs `git stash`.
// The first group is F1, the regression the retained-text regex introduced: a
// keyword used as an ARGUMENT (`: do`) or a word that merely ENDS in one
// (`-do`, `x.do`, `a=if`) opened a phantom clause, so the real `)` that closes
// the substitution was read as a pattern's `)` and `stash` fell inside the
// substitution, leaving `git ⟨mark⟩` outside (master denied all of them).
describe("scripts/hooks/guard-bash.mjs -- case clauses open only at a command position (#4060 r2)", () => {
	it.each([
		"git $(: do case x in x) stash",
		"git $(: then case x in x) stash",
		"git $(: else case x in x) stash",
		"git $(: elif case x in x) stash",
		"git $(: if case x in x) stash",
		"git $(: while case x in x) stash",
		"git $(: until case x in x) stash",
		"git $(: -do case x in x) stash",
		"git $(: --do case x in x) stash",
		"git $(: x.do case x in x) stash",
		"git $(: x/then case x in x) stash",
		"git $(: a:do case x in x) stash",
		"git $(: a=if case x in x) stash",
		"git $(x=1 case x in x) stash",
		"git $(: <(:) case x in x) stash",
		"git $(: 2>&1 case x in x) stash",
		"git $(: -else case x in x) stash",
		"git $(: x.elif case x in x) stash",
		"git $(: -while case x in x) stash",
		"git $(: x/until case x in x) stash",
	])(
		"an argument or word tail shaped like a keyword opens no clause: %s",
		(command) => {
			expect(hookVerdict(command).stderr).toBe(`${RULE_MESSAGES.stash}\n`);
		},
	);

	// F2: `!` and `time` (with `-p` / `--`) are reserved-word prefixes the
	// grammar accepts before a compound command, so `case` after them is at a
	// command position and the pattern's `)` must not close the substitution.
	it.each([
		"git $(! case x in x) : ;; esac) stash",
		"git $(! ! case x in x) : ;; esac) stash",
		"git $(time case x in x) : ;; esac) stash",
		"git $(time -p case x in x) : ;; esac) stash",
		"git $(time -p -- case x in x) : ;; esac) stash",
		"git $(time ! case x in x) : ;; esac) stash",
		"git $(! time case x in x) : ;; esac) stash",
		"git $(: && ! case x in x) : ;; esac) stash",
	])(
		"a reserved-word prefix before case is a command position: %s",
		(command) => {
			expect(hookVerdict(command).stderr).toBe(`${RULE_MESSAGES.stash}\n`);
		},
	);

	// Positions bash does open a clause at (each measured to run `git stash`).
	it.each([
		"git $({ case x in x) : ;; esac; }) stash",
		"git $(if case x in x) : ;; esac; then :; fi) stash",
		"git $(until case x in x) : ;; esac; do break; done) stash",
		"git $(if :; then :; elif case x in x) : ;; esac; then :; fi) stash",
		"git $(if :; then :; else case x in x) : ;; esac; fi) stash",
		"git $(: |case x in x) : ;; esac) stash",
		"git $(: &case x in x) : ;; esac) stash",
		"git $(f() case x in x) : ;; esac; f) stash",
		"git $( (case x in x) : ;; esac) ) stash",
		"git $(case x in x) case y in y) : ;; esac ;; esac) stash",
		"git $(case x in x) : ;; esac;case y in y) : ;; esac) stash",
		"git $(case x in x) : ;;esac) stash",
		"git $(case x in(x) : ;; esac) stash",
		"git $([[ ( case ) ]] ; case x in x) : ;; esac) stash",
		"git $([[ a && case ]] ; case x in x) : ;; esac) stash",
		"git $([[ ( case == in ) ]]) stash",
		"git $(:; \\\ncase x in x) : ;; esac) stash",
		"git $(case x in a|esac) : ;; esac) stash",
		"git $(case x in esac) stash",
		"git $(echo >&2 case x in x) stash",
		"git $(echo &>/dev/null case x in x) stash",
		"git $(case x in x) echo esac ;; y) : ;; esac) stash",
		"git $(case in in x) : ;; esac) stash",
		"git $(case esac in x) : ;; esac) stash",
		"git $(case x in in) : ;; esac) stash",
		"git $(case x in x) : ;; (y) : ;; esac) stash",
		"git $(case x in x) (echo) ;; esac) stash",
		"git $(case x in x) : ;; *) : ;; esac) stash",
		"git $(for i in a; do case x in x) : ;; esac; done) stash",
		"git $(for ((i=0;i<1;i++)) ; do case x in x) : ;; esac; break; done) stash",
	])(
		"a clause opened at a command position keeps its pattern paren: %s",
		(command) => {
			expect(hookVerdict(command).stderr).toBe(`${RULE_MESSAGES.stash}\n`);
		},
	);

	// #4060 round 3 (PR #4935 verify F6): a `#` comment between the clauses is
	// skipped, never read as a pattern word. Round 2's word branch ran before
	// the comment branch, so `esac` after a comment arrived at a `pattern`
	// frame and the `)` after it closed a pattern instead of the substitution:
	// `stash` fell inside the substitution and the command was ALLOWED while
	// bash 5.3.9 runs `git stash` (round 1 and master denied the first two).
	it.each([
		"git $(case x in\n# note\nesac) stash",
		"git $(case x in x) : ;;\n# note\nesac) stash",
		"git $(case x in x) : ;; # note\n esac) stash",
		"git $(case x in # note\nesac) stash",
		"git $(case x in\n# note\nx) : ;; esac) stash",
		"git $(case x in x) : ;;\n# a\n# b\nesac) stash",
	])("a comment inside a case body is skipped: %s", (command) => {
		expect(hookVerdict(command).stderr).toBe(`${RULE_MESSAGES.stash}\n`);
	});

	// `#` that does not start a comment keeps its old reading: inside a word
	// (`a#b`) and as `$#`.
	it.each([
		"git $(: a#b case x in x) stash",
		"git $(echo $# ; case x in x) : ;; esac) stash",
		"git $(case x in a#b) : ;; esac) stash",
	])("a `#` that is not a comment starts no comment: %s", (command) => {
		expect(hookVerdict(command).stderr).toBe(`${RULE_MESSAGES.stash}\n`);
	});

	it("allows a commented case clause whose body is harmless", () => {
		expect(
			hookVerdict("git $(case x in\n# note\nx) : ;; esac) status").status,
		).toBe(0);
	});

	// `case` in a position the lexer does not model fails CLOSED: the hook
	// cannot tell whether bash opens a clause there, so it cannot tell where the
	// substitution ends. `for ((…)) do case`, `coproc [NAME] case` and
	// `function f case` really run `git stash` in bash 5.3.9; `$((case))` is
	// arithmetic, and `case(` is a syntax error either way.
	it.each([
		"git $(for ((i=0;i<1;i++)) do case x in x) : ;; esac; done) stash",
		"git $(coproc case x in x) : ;; esac) stash",
		"git $(coproc NAME case x in x) : ;; esac) stash",
		"git $(function f case x in x) : ;; esac; f) stash",
		"git $(for i do case x in x) : ;; esac; break; done) stash",
		"git $(select i do case x in x) : ;; esac; break; done) stash",
		"git $((case x in x) : ;; esac)) stash",
		"git $(: && ((case == x)) ; : in) stash",
		"git $(((case x in x) : ;; esac) )) stash",
		"git $(case(x) in x) : ;; esac) stash",
	])("an unmodelled grammar position fails closed: %s", (command) => {
		expect(hookVerdict(command).stderr).toBe(
			`${RULE_MESSAGES.unscannableCase}\n`,
		);
	});
});

describe("scripts/hooks/guard-bash.mjs -- ambient PI_LENS_HOME (#2699)", () => {
	it("allows an unpinned-looking node probe when PI_LENS_HOME is only in process.env, not the command text", () => {
		const result = runHook("node -e \"require('./clients/foo.js')\"", {
			...BASE_ENV,
			PI_LENS_HOME: "/some/probe/home",
		});
		expect(result.status).toBe(0);
	});
});

describe(`scripts/hooks/guard-bash.mjs -- transcript corpus ${TRANSCRIPT_CORPUS_DATE} (#2705)`, () => {
	// A synthetic HOME that is never created, like PAYLOAD_CWD: the hook only
	// resolves `~` against it. A mkdtemp under os.tmpdir() is /tmp when TMPDIR
	// is unset or /tmp, which turned the corpus's `~/...` writes into /tmp
	// writes (#4348 review r1: 5 rows flipped).
	const corpusHome = "/home/dev/pi-lens-guard-bash-corpus-home";
	const corpusEnv = {
		...BASE_ENV,
		HOME: corpusHome,
		PI_LENS_HOME: join(corpusHome, ".pi-lens"),
		PILENS_DATA_DIR: join(corpusHome, "data"),
		PI_LENS_INSTALL_LOG: join(corpusHome, "logs", "install.log"),
	};
	// The fixture was captured as uid 1000: its 655 harness-scratch writes name
	// /tmp/claude-1000/. The exemption is the RUNNER's own uid, so the hook sees
	// the runner's directory; the hash and the EXPECTED_* sets stay keyed on the
	// original row (#4348 review r1: a CI uid != 1000 gave `expected 313 to be
	// 66`).
	const asRunner = (command: string) =>
		command.replaceAll(
			"/tmp/claude-1000",
			`/tmp/claude-${process.getuid?.() ?? 1000}`,
		);

	it("keeps the transcript corpus at zero non-rule denies", () => {
		const offenses: string[] = [];
		let actualDenies = 0;
		for (const { command } of TRANSCRIPT_CORPUS) {
			const result = hookVerdict(asRunner(command), corpusEnv);
			const hash = commandHash(command);
			const expectedDeny = EXPECTED_TRANSCRIPT_DENIES.has(hash);
			const expectedAllow = EXPECTED_TRANSCRIPT_ALLOWS.has(hash);
			if (result.status === 2) actualDenies++;

			if (expectedDeny) {
				if (result.status !== 2)
					offenses.push(`expected deny was allowed: ${command}`);
				continue;
			}
			if (expectedAllow && result.status !== 0)
				offenses.push(`expected allow was denied: ${command}`);
			else if (!expectedAllow && result.status !== 0)
				offenses.push(`non-rule deny (${result.status}): ${command}`);
			else if (result.stderr !== "")
				offenses.push(`unexpected stderr: ${command}`);
		}

		expect(actualDenies).toBe(EXPECTED_TRANSCRIPT_DENIES.size);
		expect(offenses).toEqual([]);
	});

	// The real hook for every row. The classifier pass above skips the child's
	// stdin, exit-code and stderr wiring, so a deny that only the hook adds (a
	// non-rule deny from run() on one row) is caught here and nowhere else.
	// Recurrence: the 88-row sample this loop replaced let a hook-only deny on
	// an unsampled row pass (#4729 review r1 F1). The in-process verdict rides
	// beside each spawn, since it costs no process.
	it("keeps every transcript row's real hook verdict at zero non-rule denies", async () => {
		const offenses: string[] = [];
		const mismatches: string[] = [];
		let actualDenies = 0;
		const started = performance.now();
		// #3801: four children at a time; the verdicts below are read in corpus
		// order, so the offense and mismatch lists keep their serial order.
		const children = await runHooksConcurrently(
			TRANSCRIPT_CORPUS.map(({ command }) => asRunner(command)),
			corpusEnv,
			4,
		);
		for (const [index, { command }] of TRANSCRIPT_CORPUS.entries()) {
			const child = children[index];
			const verdict = hookVerdict(asRunner(command), corpusEnv);
			if (child.status !== verdict.status || child.stderr !== verdict.stderr)
				mismatches.push(
					`child ${child.status} vs classifier ${verdict.status}: ${command}`,
				);
			const hash = commandHash(command);
			const expectedDeny = EXPECTED_TRANSCRIPT_DENIES.has(hash);
			const expectedAllow = EXPECTED_TRANSCRIPT_ALLOWS.has(hash);
			if (child.status === 2) actualDenies++;

			if (expectedDeny) {
				if (child.status !== 2)
					offenses.push(`expected deny was allowed: ${command}`);
				continue;
			}
			if (expectedAllow && child.status !== 0)
				offenses.push(`expected allow was denied: ${command}`);
			else if (!expectedAllow && child.status !== 0)
				offenses.push(`non-rule deny (${child.status}): ${command}`);
			else if (child.stderr !== "")
				offenses.push(`unexpected stderr: ${command}`);
		}
		const elapsedMs = performance.now() - started;
		console.log(
			`guard-bash transcript corpus: ${TRANSCRIPT_CORPUS.length} rows through the real hook, ${actualDenies} expected denies, ${Math.round(elapsedMs)}ms`,
		);
		expect(elapsedMs).toBeLessThan(180_000);
		expect(actualDenies).toBe(EXPECTED_TRANSCRIPT_DENIES.size);
		expect(offenses).toEqual([]);
		expect(mismatches).toEqual([]);
	}, 180_000);
});

describe("scripts/hooks/guard-bash.mjs -- never throws (#2699)", () => {
	it("exits 0 on malformed JSON on stdin", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: "not json {{{",
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
	});

	it("exits 0 on empty stdin", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: "",
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
	});

	it("exits 0 when tool_input is missing entirely", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: JSON.stringify({ tool_name: "Bash" }),
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
	});

	it("exits 0 when tool_input is an empty object", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: JSON.stringify({ tool_name: "Bash", tool_input: {} }),
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
	});

	it("exits 0 when tool_input.command is not a string", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: JSON.stringify({
				tool_name: "Bash",
				tool_input: { command: 12345 },
			}),
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
	});

	it("exits 0 for a non-Bash tool even with a denied command string", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: JSON.stringify({
				tool_name: "Edit",
				tool_input: { command: "git stash" },
			}),
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
	}, 180_000);
});

// #3089: readStdin drains fd 0 to EOF instead of a single readFileSync(0)
// call. Measured on this host: spawnSync's `input` option pumps the
// child's stdin pipe non-blocking while its own synchronous event loop
// feeds it, so a `read(2)` issued before the next chunk has landed can
// throw EAGAIN -- reproducible from ~500 KB of JSON payload, reliably at
// the 1 MB+ sizes below. Pre-fix, `readFileSync(0, "utf8")` does not retry
// that EAGAIN; the throw was swallowed by readStdin's own catch-all,
// producing "no payload" for a payload that was still arriving, and the
// hook failed OPEN (exit 0) on a command it would otherwise have denied.
// This is the real script (HOOK, spawned exactly as runHook() above does)
// over a real OS pipe (spawnSync's own child stdio pipe) -- not a hand-fed
// classifyPayload() call, which never touches readStdin at all.
describe("scripts/hooks/guard-bash.mjs -- drains stdin to EOF on a large payload (#3089)", () => {
	function payloadOfAtLeast(bytes: number, tailCommand: string): string {
		const pad = "x".repeat(bytes);
		return `echo ${pad} && ${tailCommand}`;
	}

	it.each([
		["~500 KB", 500_000],
		["1 MB", 1_000_000],
		["2 MB", 2_000_000],
		["9 MB", 9_000_000],
	])(
		"still denies a %s payload (a single readFileSync(0) fails open here)",
		(_label, bytes) => {
			const command = payloadOfAtLeast(bytes, "git stash");
			const result = runHook(command);
			expect(result.status, `payload length ${command.length}`).toBe(2);
			expect(result.stderr.toLowerCase()).toContain("stash");
		},
		// review round 2 F1: no explicit timeout inherits vitest's 5000ms
		// default (vitest.config.ts sets hookTimeout, not testTimeout), which
		// the 2 MB/9 MB cases blow through under Stryker's dry run -- Stryker
		// then aborts before mutating this PR's own file. The file's own
		// convention for a real spawn this size is 180_000 (see :391, :453).
		60_000,
	);

	// The never-throws contract from #2699 is unchanged by the drain loop:
	// a read error or a genuinely empty stream is still "no payload", not a
	// crash and not a deny.
	it("still exits 0 on a genuinely empty stream", () => {
		const result = spawnSync(process.execPath, [HOOK], {
			input: "",
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("still exits 0 on a genuine read error (EBADF, not EAGAIN) -- and notes it (#3089 review round 2 F2/F3)", () => {
		// review round 2 F2: stdio: "ignore" hands the child /dev/null, which
		// reads 0 bytes cleanly -- the same EOF branch as the empty-stream
		// case above, never reaching readStdin's `throw error` at :1079-ish.
		// A WRITE-ONLY fd handed to the child as fd 0 instead produces a
		// GENUINE EBADF on the child's first read(2) (probed directly:
		// fs.readSync on a write-only fd throws
		// "EBADF: bad file descriptor, read"), which is the branch that
		// mutation-tests `throw error` -- reverting it to `break` would
		// silently fold this case into the empty-stream case (chunks stays
		// [], "" is returned instead of the error propagating), losing the
		// note asserted below.
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-ebadf-"));
		const writeOnlyFile = join(dir, "write-only");
		const writeOnlyFd = openSync(writeOnlyFile, "w");
		try {
			const result = spawnSync(process.execPath, [HOOK], {
				stdio: [writeOnlyFd, "pipe", "pipe"],
				encoding: "utf8",
				env: BASE_ENV,
			});
			expect(result.status).toBe(0);
			// review round 2 F3: a genuine read error is a FAILURE, not an
			// ordinary "nothing to check" allow -- unlike the true-empty-
			// stream case above, it is noted so the hook's own stderr says
			// why nothing was checked instead of looking identical to every
			// other allow. review round 3 N1: the note names the actual
			// cause (error.code, EBADF here) via the crash guard's shared
			// template -- NOT the JSON.parse-only "unreadable or
			// unparseable" wording, which this path never reaches (readStdin
			// throws before run() ever gets to `raw.trim()` or JSON.parse).
			expect(result.stderr).toBe(
				"guard-bash: EBADF while checking payload; allowing\n",
			);
		} finally {
			closeSync(writeOnlyFd);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// #3089 review round 2 F3: the JSON.parse failure path is the OTHER
	// "saw real input, failed to make sense of it" failure (distinct from
	// the read-error case above) -- a payload cut off mid-document, the
	// literal shape a short read produces. Built directly (sliced valid
	// JSON) rather than raced through spawnSync's own EAGAIN timing, so the
	// truncation point is deterministic.
	it("notes an unparseable (truncated) payload instead of allowing silently", () => {
		const fullPayload = JSON.stringify({
			session_id: "probe",
			cwd: repoRoot,
			permission_mode: "default",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: `echo ${"x".repeat(1_000_000)} && git stash` },
		});
		const truncated = fullPayload.slice(0, 500_105);
		expect(truncated.length).toBeLessThan(fullPayload.length);
		expect(() => JSON.parse(truncated)).toThrow();
		const result = spawnSync(process.execPath, [HOOK], {
			input: truncated,
			encoding: "utf8",
			env: BASE_ENV,
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe(
			"guard-bash: payload unreadable or unparseable; allowing\n",
		);
	});

	// #3089 review round 3 N2: the note() write itself must never be the
	// thing that turns an intended exit-0 allow into an uncaught-exception
	// exit 1. A read-only fd handed to the child as stderr reproduces this:
	// the crash-guard path (forced here via the same depth-5000 nesting
	// that crashes the tokenizer, a real command containing `git stash`)
	// tries to note the failure, that write itself fails, and pre-fix that
	// second failure was unguarded.
	it("still exits 0 (not 1) when the crash-guard's own note write fails (read-only stderr fd)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-stderr-ro-"));
		const readOnlyFile = join(dir, "stderr-ro");
		writeFileSync(readOnlyFile, "");
		const readOnlyFd = openSync(readOnlyFile, "r");
		try {
			const deep = `${"$(".repeat(5000)}git stash${")".repeat(5000)}`;
			const result = spawnSync(process.execPath, [HOOK], {
				input: JSON.stringify({
					session_id: "probe",
					cwd: repoRoot,
					permission_mode: "default",
					hook_event_name: "PreToolUse",
					tool_name: "Bash",
					tool_input: { command: `echo ${deep}` },
				}),
				stdio: ["pipe", "pipe", readOnlyFd],
				encoding: "utf8",
				env: BASE_ENV,
			});
			// Pre-fix (`try { process.stderr.write(text) } catch {}` alone):
			// exit 1, an uncaught 'error' event from the Writable stream's
			// own async I/O failure, which a synchronous try/catch around
			// process.stderr.write cannot catch -- confirmed exit 1 in that
			// configuration. Post-fix (fs.writeSync, which throws EBADF
			// synchronously for this same fd): exit 0.
			expect(result.status).toBe(0);
		} finally {
			closeSync(readOnlyFd);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// #3089 review trailing round (#3121): the ALLOW-path notes (round 2/3)
// were mutation-tested against a broken stderr; the DENY path's OWN write
// -- `note(`${RULE_MESSAGES[rule]}\n`)` -- never was. Reverting just that
// one call site to `process.stderr.write` (note() itself untouched) keeps
// every prior test in this file green (none of them deny through a broken
// stderr) while reintroducing exactly #3121's bug: a `git stash` a caller
// asked to have denied gets ALLOWED (exit 1, an uncaught exception, not
// exit 2) whenever stderr happens to be unwritable. The verdict (deny) and
// the message (why) are two different guarantees; only the message may be
// lost to a broken stderr, never the verdict.
describe("scripts/hooks/guard-bash.mjs -- deny verdict survives a broken stderr (#3121)", () => {
	const DENY_RULE_COMMANDS: Array<[rule: string, command: string]> = [
		["stash", "git stash"],
		["reset", "git reset --hard HEAD"],
		["worktree", "git worktree remove -f -f /tmp/tree"],
		[
			"tmpdirCollision",
			"TMPDIR=$PWD/.probe-home npx vitest run tests/clients/ext-gate-before-ignore.test.ts",
		],
		["probe", "node -e \"require('./clients/foo.js')\""],
	];

	it.each(DENY_RULE_COMMANDS)(
		"still denies (%s) when stderr is a read-only fd -- message lost, verdict kept",
		(_rule, command) => {
			const dir = mkdtempSync(join(tmpdir(), "pi-lens-guard-bash-deny-ro-"));
			const readOnlyFile = join(dir, "stderr-ro");
			writeFileSync(readOnlyFile, "");
			const readOnlyFd = openSync(readOnlyFile, "r");
			try {
				const result = spawnSync(process.execPath, [HOOK], {
					input: JSON.stringify({
						session_id: "probe",
						cwd: repoRoot,
						permission_mode: "default",
						hook_event_name: "PreToolUse",
						tool_name: "Bash",
						tool_input: { command },
					}),
					stdio: ["pipe", "pipe", readOnlyFd],
					encoding: "utf8",
					env: BASE_ENV,
				});
				expect(result.status).toBe(2);
			} finally {
				closeSync(readOnlyFd);
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("scripts/hooks/guard-bash.mjs -- registration (review round 2 F3)", () => {
	it(".claude/settings.json's PreToolUse Bash hook does not start with a relative path", () => {
		const settings = JSON.parse(
			readFileSync(join(repoRoot, ".claude", "settings.json"), "utf8"),
		);
		const entry = settings.hooks.PreToolUse[0];
		expect(entry.matcher).toBe("Bash");
		const command: string = entry.hooks[0].command;
		// A relative "node scripts/hooks/guard-bash.mjs" resolves against the
		// hook's cwd, which follows Claude into a worktree that predates this
		// file -- ERR_MODULE_NOT_FOUND on every Bash call, no enforcement.
		// ${CLAUDE_PROJECT_DIR} stays pinned to the session-start root
		// regardless of a later worktree cd (the hooks doc's own recommended
		// fix for exactly this).
		expect(command).toContain("${CLAUDE_PROJECT_DIR}");
		expect(/^node\s+scripts\//.test(command)).toBe(false);
		expect(command.includes("scripts/hooks/guard-bash.mjs")).toBe(true);
	});
});

describe("scripts/hooks/guard-bash.mjs -- tokenizer unit behavior (#2699)", () => {
	it("treats a quoted command word as opaque text, not a live command boundary", () => {
		expect(findDeny('echo "git stash"')).toBeNull();
		expect(findDeny("echo 'git stash'")).toBeNull();
	});

	it("splits on &&, ||, ;, |, and newline at the top level", () => {
		expect(findDeny("echo hi && git stash")).toBe("stash");
		expect(findDeny("echo hi || git stash")).toBe("stash");
		expect(findDeny("echo hi ; git stash")).toBe("stash");
		expect(findDeny("echo hi\ngit stash")).toBe("stash");
	});

	it("strips leading env assignments before finding the command word", () => {
		const { env, rest } = stripEnvAssignments([
			"FOO=bar",
			"BAZ=qux",
			"git",
			"stash",
		]);
		expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
		expect(rest).toEqual(["git", "stash"]);
	});

	it("scannableRegions returns the top level first, then every substitution body, flattened", () => {
		// Each subtracted span leaves one SUBSTITUTION_MARK (U+E000) behind
		// (#3988), so a word that held a `$( … )`/backtick span is known to be
		// incomplete instead of collapsing into a shorter, wrong path.
		expect(scannableRegions("echo $(git stash) `git log`")).toEqual([
			"echo \uE000 \uE000",
			"git stash",
			"git log",
		]);
		// Flattened at ANY depth -- round 2 recursed with a depth cap of 8,
		// which silently ALLOWED anything nested deeper.
		expect(scannableRegions("echo $(echo $(echo $(git stash)))")).toEqual([
			"echo \uE000",
			"git stash",
			"echo \uE000",
			"echo \uE000",
		]);
	});

	it("splitSegments splits the retained text on every metacharacter", () => {
		expect(splitSegments("a && b || c ; d | e & f\ng")).toEqual([
			"a ",
			" b ",
			" c ",
			" d ",
			" e ",
			" f",
			"g",
		]);
	});

	it("classifyPayload allows a Read tool call carrying a denied-looking command field", () => {
		expect(
			classifyPayload({
				tool_name: "Read",
				tool_input: { command: "git stash" },
			}),
		).toBeNull();
	});

	it("splitWords fuses a quoted span into one opaque word", () => {
		expect(splitWords('echo "git stash"')).toEqual(["echo", "git stash"]);
	});

	it("keeps a substitution mark from fusing into the surrounding rule word (#3997 F1)", () => {
		for (const command of [
			"git stash$(true)",
			"git reset --hard$(:)",
			"git push --force$(:) origin x",
			"git commit --no-verify$(:) -m x",
		]) {
			expect(findDeny(command), command).not.toBeNull();
		}
	});

	it("fails closed for the reviewed resolver blind spots (#3997 F3-F6)", () => {
		for (const command of [
			"A=$(pwd); git worktree remove $A/wt",
			"export A=$(pwd); git worktree remove $A/wt",
			"git worktree remove $OLDPWD/wt",
			"git worktree remove {-q,/path/wt}",
		]) {
			expect(
				findDeny(command, "/home/dev/pi-lens-guard-bash-fixed-cwd"),
				command,
			).toBe("worktreeUnresolved");
		}
	});

	it("(review round 2 F1) drops a QUOTED-delimiter heredoc body -- its backtick span is never collected as a substitution", () => {
		const regions = scannableRegions(
			"cat <<'EOF'\nmentions `git stash` here\nEOF",
		);
		// Only the top level survives; no substitution region was produced.
		expect(regions).toHaveLength(1);
		// The command's own text ("cat <<'EOF'") survives; the body does not.
		expect(regions[0]).not.toContain("git stash");
	});

	it("(review round 2 F1) a heredoc nested inside a $() subshell still drops its own body", () => {
		expect(
			findDeny("gh pr create --body \"$(cat <<'EOF'\n`git stash`\nEOF\n)\""),
		).toBeNull();
	});

	it("(review round 2 F7) a command word is resolved by its final path segment", () => {
		expect(findDeny("/usr/bin/git stash")).toBe("stash");
		expect(findDeny("./git stash")).toBe("stash");
	});
});

describe("scripts/hooks/guard-bash.mjs -- cross-segment export tracking (review round 2 F2)", () => {
	// Spawned (not a direct findDeny() call): the PI_LENS_HOME-absence branch
	// reads real process.env, so an in-process call would inherit whatever
	// this test RUNNER's own environment carries (this repo's own probe-
	// hygiene convention sets PI_LENS_HOME for ad-hoc probes) -- exactly the
	// ambient-leakage BASE_ENV exists to prevent for the spawned cases below.
	it("a bare (non-export) prefix on an earlier segment does not leak to a later segment's node call", () => {
		const result = runHook(
			"PI_LENS_HOME=/x true; node -e \"require('./clients/foo.js')\"",
		);
		expect(result.status).toBe(2);
		expect(result.stderr.toLowerCase()).toContain("probe");
	});

	it("export on an earlier segment DOES reach a later segment's node call", () => {
		const result = runHook(
			"export PI_LENS_HOME=/x; node -e \"require('./clients/foo.js')\"",
		);
		expect(result.status).toBe(0);
	});

	it("a standalone (non-exported) VAR=val segment with no command also persists forward (lenient)", () => {
		const result = runHook(
			"PI_LENS_HOME=/x; node -e \"require('./clients/foo.js')\"",
		);
		expect(result.status).toBe(0);
	});

	it("`export FOO=bar node ...` on ONE segment never runs node at all (real bash: export takes only names/assignments, never a trailing command)", () => {
		// Deliberately NOT PI_LENS_HOME: if `export`'s trailing words were
		// (wrongly) treated as a command to classify, this would misread
		// "node" as the command and (with no PI_LENS_HOME anywhere) deny it.
		// Real bash never runs "node" here at all -- "node" is just another
		// bare name `export` marks, so nothing executes and this allows.
		const result = runHook(
			"export SOME_OTHER_VAR=/x node -e \"require('./clients/foo.js')\"",
		);
		expect(result.status).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Lexer state space (review round 3)
// ---------------------------------------------------------------------------
//
// Round 2's verify found a NEW defect on the seam round 2 built (V1: a
// `$( … )` span delimited by a paren counter that ran THROUGH heredoc
// bodies), so this round enumerates the seam's whole axis instead of
// patching the case that was reported: (region kind) × (nesting context),
// 11 rows × 5 columns. Row/column ids match the table in the PR body.
//
// Every `expect` value below is EMPIRICAL. Each command was run through
// real `bash -c` with the forbidden command rewritten to `touch <marker>`,
// and the expectation is whether the marker FILE appeared -- so a `cat`
// that merely PRINTS a heredoc body cannot be mistaken for one that
// executes it. All 58 agreed with real bash (transcript in the PR body);
// an earlier pass that grepped stdout for a printed marker instead was
// wrong on six cells, which is why the side-effect form is the one that
// ships.
//
// Driven through the exported `findDeny` rather than a spawned process:
// the subject here is the LEXER, and 58 more child processes would add ~2s
// of wall clock to a suite whose CLI contract is already pinned by the 90+
// spawned cases above (the four headline cells -- V1, V3a, V2, the comment
// region -- are additionally spawned in DENY_CASES/ALLOW_CASES). No case
// in this table can reach the probe rule, so none of them reads
// `process.env`.
const S = "git stash";

type LexerCell = {
	id: string;
	cell: string;
	command: string;
	expect: "deny" | "allow";
};

const LEXER_STATE_SPACE: LexerCell[] = [
	// R1 -- top-level text (a bare simple command)
	{
		id: "LX-1-1",
		cell: "R1/C1 a bare simple command",
		command: S,
		expect: "deny",
	},
	{
		id: "LX-1-2",
		cell: "R1/C2 command inside $( )",
		command: `echo $(${S})`,
		expect: "deny",
	},
	{
		id: "LX-1-3",
		cell: "R1/C3 command inside backticks",
		command: `echo \`${S}\``,
		expect: "deny",
	},
	{
		id: "LX-1-4",
		cell: "R1/C4 plain body text is data, never a command",
		command: `cat <<EOF\n${S}\nEOF`,
		expect: "allow",
	},
	{
		id: "LX-1-5",
		cell: "R1/C5 command text in double quotes is one opaque word",
		command: `echo "${S}"`,
		expect: "allow",
	},

	// R2 -- double-quoted span
	{
		id: "LX-2-1",
		cell: "R2/C1 a double-quoted span fuses into the surrounding word",
		command: `git "stash"`,
		expect: "deny",
	},
	{
		id: "LX-2-1b",
		cell: "R2/C1 an ESCAPED double quote outside quotes must not open a quote region and swallow the separator",
		command: `echo a\\" ; ${S}`,
		expect: "deny",
	},
	{
		id: "LX-2-2",
		cell: "R2/C2 same, inside $( )",
		command: `echo $(git "stash")`,
		expect: "deny",
	},
	{
		id: "LX-2-3",
		cell: "R2/C3 same, inside backticks",
		command: 'echo `git "stash"`',
		expect: "deny",
	},
	{
		id: "LX-2-4",
		cell: "R2/C4 quotes are LITERAL in a body; the $( ) inside still runs",
		command: `cat <<EOF\n"$(${S})"\nEOF`,
		expect: "deny",
	},
	{
		id: "LX-2-5",
		cell: "R2/C5 an escaped quote inside double quotes stays literal",
		command: `echo "he said \\"${S}\\""`,
		expect: "allow",
	},
	{
		id: "LX-2-5b",
		cell: "R2/C5 an escaped $ inside double quotes is not a substitution",
		command: `echo "\\$(${S})"`,
		expect: "allow",
	},
	{
		id: "LX-2-5c",
		cell: "R2/C5 an escaped backtick inside double quotes is not a substitution",
		command: `echo "\\\`${S}\\\`"`,
		expect: "allow",
	},

	// R3 -- single-quoted span
	{
		id: "LX-3-1",
		cell: "R3/C1 no expansion inside single quotes",
		command: `echo '$(${S})'`,
		expect: "allow",
	},
	{
		id: "LX-3-1b",
		cell: "R3/C1 a single-quoted span still forms the WORD (must not be deleted)",
		command: `git 'stash'`,
		expect: "deny",
	},
	{
		id: "LX-3-1c",
		cell: "R3/C1 an ESCAPED single quote outside quotes must not open a quote region and swallow the separator",
		command: `echo a\\' ; ${S}`,
		expect: "deny",
	},
	{
		id: "LX-3-1d",
		cell: "R3/C1 …nor hide LIVE syntax after it -- the region pass's own quote state, not just the segment splitter's",
		command: `echo a\\' $(${S})`,
		expect: "deny",
	},
	{
		id: "LX-3-2",
		cell: "R3/C2 same, inside $( )",
		command: `echo $(echo '$(${S})')`,
		expect: "allow",
	},
	{
		id: "LX-3-3",
		cell: "R3/C3 same, inside backticks",
		command: `echo \`echo '$(${S})'\``,
		expect: "allow",
	},
	{
		id: "LX-3-4",
		cell: "R3/C4 single quotes are LITERAL in a body; the $( ) still runs",
		command: `cat <<EOF\n'$(${S})'\nEOF`,
		expect: "deny",
	},
	{
		id: "LX-3-5",
		cell: "R3/C5 an apostrophe in double quotes must not open a quote region",
		command: `echo "it's $(${S})"`,
		expect: "deny",
	},

	// R4 -- backtick span
	{
		id: "LX-4-1",
		cell: "R4/C1 a backtick span closes; text after it is still scanned",
		command: `echo \`date\`; ${S}`,
		expect: "deny",
	},
	{
		id: "LX-4-2",
		cell: "R4/C2 backtick span inside $( )",
		command: `echo $(echo \`${S}\`)`,
		expect: "deny",
	},
	{
		id: "LX-4-3",
		cell: "R4/C3 a backslash-escaped backtick span nested in a backtick span",
		command: `echo \`echo \\\`${S}\\\`\``,
		expect: "deny",
	},
	{
		id: "LX-4-4",
		cell: "R4/C4 backtick substitution inside an unquoted-delimiter body",
		command: `cat <<EOF\n\`${S}\`\nEOF`,
		expect: "deny",
	},
	{
		id: "LX-4-5",
		cell: "R4/C5 backtick span inside double quotes",
		command: `echo "\`${S}\`"`,
		expect: "deny",
	},

	// R5 -- $( ) span
	{
		id: "LX-5-1",
		cell: "R5/C1 a ) inside quotes must not close the span early",
		command: `echo $(echo ')') ; ${S}`,
		expect: "deny",
	},
	{
		id: "LX-5-1b",
		cell: "R5/C1 plain nested ( ) must not close the span early -- with the enclosing double quotes, a truncated span leaves the rest as ONE quoted word",
		command: `echo "$( (echo a) ; ${S} )"`,
		expect: "deny",
	},
	{
		id: "LX-5-2",
		cell: "R5/C2 nested $( )",
		command: `echo $(echo $(${S}))`,
		expect: "deny",
	},
	{
		id: "LX-5-3",
		cell: "R5/C3 $( ) inside backticks",
		command: `echo \`echo $(${S})\``,
		expect: "deny",
	},
	{
		id: "LX-5-4",
		cell: "R5/C4 V3a -- $( ) in an unquoted-delimiter body really runs",
		command: `cat <<EOF\n$(${S})\nEOF`,
		expect: "deny",
	},
	{
		id: "LX-5-5",
		cell: "R5/C5 $( ) inside double quotes",
		command: `echo "$(${S})"`,
		expect: "deny",
	},

	// R6 -- heredoc body, QUOTED delimiter
	{
		id: "LX-6-1",
		cell: "R6/C1 a quoted-delimiter body is inert in full",
		command: `cat <<'EOF'\n$(${S})\nEOF`,
		expect: "allow",
	},
	{
		id: "LX-6-2",
		cell: "R6/C2 V1 -- an unbalanced ) in a quoted body must not close the enclosing $( )",
		command: `gh pr create --body "$(cat <<'EOF'\nsmiley :) here\nwe never run \`${S}\`\nEOF\n)"`,
		expect: "allow",
	},
	{
		id: "LX-6-3",
		cell: "R6/C3 a quoted-delimiter heredoc inside a backtick span",
		command: `echo \`cat <<'EOF'\n$(${S})\nEOF\n\``,
		expect: "allow",
	},
	{
		id: "LX-6-4",
		cell: "R6/C4 a << operator inside a body is literal text",
		command: `cat <<'EOF'\ncat <<'X'\n${S}\nEOF`,
		expect: "allow",
	},
	{
		id: "LX-6-5",
		cell: "R6/C5 a << inside double quotes NEVER starts a heredoc",
		command: `echo "cat <<'EOF'"; ${S}`,
		expect: "deny",
	},

	// R7 -- heredoc body, UNQUOTED delimiter
	{
		id: "LX-7-1",
		cell: "R7/C1 unquoted-delimiter body text with no substitution is inert",
		command: `cat <<EOF\nmentions ${S} here\nEOF`,
		expect: "allow",
	},
	{
		id: "LX-7-2",
		cell: "R7/C2 unquoted-delimiter body inside $( )",
		command: `gh pr create --body "$(cat <<EOF\n$(${S})\nEOF\n)"`,
		expect: "deny",
	},
	{
		id: "LX-7-3",
		cell: "R7/C3 unquoted-delimiter body inside backticks",
		command: `echo \`cat <<EOF\n$(${S})\nEOF\n\``,
		expect: "deny",
	},
	{
		id: "LX-7-4",
		cell: "R7/C4 a nested << inside an unquoted body is literal",
		command: `cat <<EOF\ncat <<'X'\n${S}\nX\nEOF`,
		expect: "allow",
	},
	{
		id: "LX-7-5",
		cell: "R7/C5 unquoted-delimiter body inside double quotes",
		command: `echo "$(cat <<EOF\n$(${S})\nEOF\n)"`,
		expect: "deny",
	},

	// R8 -- <<- tab-stripped body
	{
		id: "LX-8-1",
		cell: "R8/C1 V2 -- <<- strips leading tabs before matching the delimiter",
		command: `cat <<-EOF\n\tbody\n\tEOF\n${S}`,
		expect: "deny",
	},
	{
		id: "LX-8-2",
		cell: "R8/C2 <<-'EOF' body inside $( ) is inert",
		command: `gh pr create --body "$(cat <<-'EOF'\n\tmentions ${S}\n\tEOF\n)"`,
		expect: "allow",
	},
	{
		id: "LX-8-3",
		cell: "R8/C3 <<-EOF body substitution inside backticks",
		command: `echo \`cat <<-EOF\n\t$(${S})\n\tEOF\n\``,
		expect: "deny",
	},
	{
		id: "LX-8-4",
		cell: "R8/C4 a quoted <<- delimiter drops substitutions",
		command: `cat <<-'EOF'\n\t$(${S})\n\tEOF`,
		expect: "allow",
	},
	{
		id: "LX-8-5",
		cell: "R8/C5 <<-EOF body substitution inside double quotes",
		command: `echo "$(cat <<-EOF\n\t$(${S})\n\tEOF\n)"`,
		expect: "deny",
	},

	// R9 -- here-string <<<
	{
		id: "LX-9-1",
		cell: "R9/C1 here-string content is data",
		command: `cat <<< "${S}"`,
		expect: "allow",
	},
	{
		id: "LX-9-1b",
		cell: "R9/C1 a substitution in a here-string IS live",
		command: `cat <<< $(${S})`,
		expect: "deny",
	},
	{
		id: "LX-9-2",
		cell: "R9/C2 here-string inside $( )",
		command: `echo $(cat <<< "${S}")`,
		expect: "allow",
	},
	{
		id: "LX-9-3",
		cell: "R9/C3 here-string inside backticks",
		command: `echo \`cat <<< "${S}"\``,
		expect: "allow",
	},
	{
		id: "LX-9-4",
		cell: "R9/C4 a <<< inside a heredoc body is literal",
		command: `cat <<EOF\ncat <<< "${S}"\nEOF`,
		expect: "allow",
	},
	{
		id: "LX-9-5",
		cell: "R9/C5 <<< must not read as << with delimiter <",
		command: `cat <<< "hi"; ${S}`,
		expect: "deny",
	},

	// R10 -- comment
	{
		id: "LX-10-1",
		cell: "R10/C1 a comment hides a substitution",
		command: `echo hi # $(${S})`,
		expect: "allow",
	},
	{
		id: "LX-10-1b",
		cell: "R10/C1 a # mid-word is NOT a comment",
		command: `echo a#b; ${S}`,
		expect: "deny",
	},
	{
		id: "LX-10-2",
		cell: "R10/C2 comment inside $( )",
		command: `echo $(echo hi # $(${S})\n)`,
		expect: "allow",
	},
	{
		id: "LX-10-3",
		cell: "R10/C3 comment inside backticks",
		command: `echo \`echo hi # $(${S})\n\``,
		expect: "allow",
	},
	{
		id: "LX-10-4",
		cell: "R10/C4 # is NOT a comment in a heredoc body",
		command: `cat <<EOF\n# $(${S})\nEOF`,
		expect: "deny",
	},
	{
		id: "LX-10-5",
		cell: "R10/C5 # inside double quotes is not a comment",
		command: `echo "# hi"; ${S}`,
		expect: "deny",
	},

	// R11 -- backslash-newline continuation
	{
		id: "LX-11-1",
		cell: "R11/C1 backslash-newline splices one command",
		command: "git \\\nstash",
		expect: "deny",
	},
	{
		id: "LX-11-2",
		cell: "R11/C2 splice inside $( )",
		command: "echo $(git \\\nstash)",
		expect: "deny",
	},
	{
		id: "LX-11-3",
		cell: "R11/C3 splice inside backticks",
		command: "echo `git \\\nstash`",
		expect: "deny",
	},
	{
		id: "LX-11-4",
		cell: "R11/C4 splice inside a heredoc body's $( )",
		command: "cat <<EOF\n$(git \\\nstash)\nEOF",
		expect: "deny",
	},
	{
		id: "LX-11-5",
		cell: "R11/C5 splice inside double quotes must not swallow the next command",
		command: `echo "a\\\nb"; ${S}`,
		expect: "deny",
	},
];

describe("scripts/hooks/guard-bash.mjs -- lexer state space (review round 3)", () => {
	it.each(
		LEXER_STATE_SPACE.map((f) => [f.id, f.cell, f.command, f.expect] as const),
	)("%s %s", (_id, _cell, command, expected) => {
		expect(findDeny(command) === null ? "allow" : "deny").toBe(expected);
	});

	it("covers all 55 (region kind × nesting context) cells with no duplicate ids", () => {
		const ids = LEXER_STATE_SPACE.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
		// 11 rows × 5 columns, plus 9 same-cell discriminators (LX-2-1b,
		// LX-2-5b, LX-2-5c, LX-3-1b, LX-3-1c, LX-3-1d, LX-5-1b, LX-9-1b,
		// LX-10-1b) that each pin a second behaviour of their own cell.
		expect(ids).toHaveLength(64);
		for (let row = 1; row <= 11; row++)
			for (let col = 1; col <= 5; col++)
				expect(ids).toContain(`LX-${row}-${col}`);
	});
});

describe("scripts/hooks/guard-bash.mjs -- heredoc terminator matching (review round 3 V3b)", () => {
	// A CRLF command text is what a Windows/Git-Bash-shaped tool call
	// carries. Round 2 compared the raw line, so "EOF\r" never equalled
	// "EOF": the body ran to end-of-text and every later command was
	// silently swallowed -- a false ALLOW, the one direction this guard
	// must never fail in.
	it("tolerates a \\r before the delimiter line's newline", () => {
		expect(findDeny("cat <<'EOF'\r\nbody\r\nEOF\r\ngit stash")).toBe("stash");
		expect(findDeny("cat <<-EOF\r\n\tbody\r\n\tEOF\r\ngit stash")).toBe(
			"stash",
		);
	});

	it("strips tabs ONLY for <<-, never for a plain << (the inverse mutation)", () => {
		// Real bash: a TAB-indented "EOF" does not terminate a plain <<
		// heredoc, so `git stash` here is body text and nothing runs. If tabs
		// were stripped unconditionally the body would end early and that
		// line would be read as a live command -- a false DENY.
		expect(findDeny("cat <<EOF\n\tEOF\ngit stash\nEOF")).toBeNull();
		// Control, same shape with <<-: the tab-stripped delimiter DOES
		// terminate, so the line after it is a live command.
		expect(findDeny("cat <<-EOF\n\tEOF\ngit stash")).toBe("stash");
	});

	it("still swallows nothing when the delimiter genuinely never appears", () => {
		// No terminator at all: the body runs to end-of-text, which is what
		// bash does too (it reports an unterminated heredoc and runs nothing).
		expect(findDeny("cat <<'EOF'\ngit stash")).toBeNull();
	});
});

describe("scripts/hooks/guard-bash.mjs -- runner prefixes (review round 3 V5)", () => {
	it("strips sudo and time, which really do run their argument", () => {
		expect(findDeny("sudo git stash")).toBe("stash");
		expect(findDeny("time git stash")).toBe("stash");
		expect(findDeny("sudo time command git stash")).toBe("stash");
	});

	it("does NOT claim to handle a runner prefix carrying its own options", () => {
		// Documented in the script header's NOT-handled block rather than
		// silently believed to work: the option becomes the command word.
		expect(findDeny("sudo -u root git stash")).toBeNull();
		expect(findDeny("timeout 30 git stash")).toBeNull();
	});
});

describe("scripts/hooks/guard-bash.mjs -- unbounded nesting never throws (review round 3)", () => {
	// Round 2 capped substitution recursion at depth 8, which silently
	// ALLOWED anything nested deeper. The cap is deleted; what bounds the
	// pass now is `run`'s own never-throw contract.
	it("allows (exit 0) rather than crashing on pathologically deep nesting", () => {
		const deep = `${"$(".repeat(5000)}git stash${")".repeat(5000)}`;
		const result = runHook(`echo ${deep}`);
		expect(result.status === 0 || result.status === 2).toBe(true);
		expect(result.status).not.toBe(1);
	});

	it("catches nesting far deeper than round 2's depth cap of 8", () => {
		const deep = `${"$(".repeat(20)}git stash${")".repeat(20)}`;
		expect(findDeny(`echo ${deep}`)).toBe("stash");
	});

	// #3089 review round 3 N1: the depth-5000 case above IS this hook's most
	// important fail-open -- the payload is read and JSON.parse'd perfectly
	// (it contains a real `git stash`, which should have been denied), and
	// ONLY the tokenizer crashes (RangeError: Maximum call stack size
	// exceeded, confirmed directly against classifyPayload on this host).
	// Before this round the crash guard's note claimed the payload was
	// "unreadable or unparseable" -- false; a wrong label on the most
	// important fail-open is worse than the silence it replaced. The note
	// must name the real cause (error.name here, since a RangeError has no
	// .code) instead.
	it("names RangeError, not 'unreadable or unparseable', when the classifier (not the read) crashes", () => {
		const deep = `${"$(".repeat(5000)}git stash${")".repeat(5000)}`;
		const result = runHook(`echo ${deep}`);
		// Measured on this host (and required by the finding this test
		// pins): depth 5000 deterministically overflows the tokenizer's own
		// recursion, so the crash guard is what's under test, not the
		// tokenizer's variable stack-depth tolerance the sibling test above
		// allows for.
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("RangeError");
		expect(result.stderr).not.toContain("unreadable");
		expect(result.stderr).not.toContain("unparseable");
	});
});

// ---------------------------------------------------------------------------
// #3556: pkill/killall shared-tool kill guard
// ---------------------------------------------------------------------------
//
// #3556 (2026-09-26): a fixer ran `pkill -f tlc2.TLC` to stop its own TLC
// run; the pattern matches machine-wide, so it may have killed a concurrent
// session's run too (load average ~30 at the time, a sibling TLC run failed
// with AbortException). `repoRoot` (this worktree's own real, linked
// checkout on disk) doubles as the "worktree's absolute path" the
// acceptance criterion's scoped form names, and is passed EXPLICITLY as
// `cwd` below (never the default `PAYLOAD_CWD`, which is synthetic and not
// a real linked worktree -- #3526/#3556 review F6 needs a REAL one for the
// scoped-allow direction).
describe("scripts/hooks/guard-bash.mjs -- pkill/killall shared-tool kill guard (#3556)", () => {
	it("denies a scoped pattern from the fixture's non-linked main checkout", () => {
		// #3663: keep the CI/plain-clone negative arm explicit so a test cannot
		// pass merely because this suite happens to run in a linked worktree.
		const fixture = makeLinkedWorktreeFixture();
		try {
			const result = runHook(
				`pkill -f ${fixture.main}.*tlc2`,
				BASE_ENV,
				fixture.main,
			);
			expect(result.status).toBe(2);
			expect(result.stderr.toLowerCase()).toContain("pkill");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("allows pkill -f scoped to this worktree's own absolute path, run FROM that worktree", () => {
		const fixture = makeLinkedWorktreeFixture();
		try {
			const result = runHook(
				`pkill -f ${fixture.linked}.*tlc2`,
				BASE_ENV,
				fixture.linked,
			);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("denies pkill -f scoped to a DIFFERENT worktree's path", () => {
		const fixture = makeLinkedWorktreeFixture();
		try {
			const result = runHook(
				"pkill -f /some/other/worktree.*tlc2",
				BASE_ENV,
				fixture.linked,
			);
			expect(result.status).toBe(2);
			expect(result.stderr.toLowerCase()).toContain("pkill");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("still denies a bare (no -f) pkill even when the pattern text happens to contain the worktree path -- bare pkill matches by NAME only, never full command line", () => {
		const fixture = makeLinkedWorktreeFixture();
		try {
			const result = runHook(
				`pkill ${fixture.linked}`,
				BASE_ENV,
				fixture.linked,
			);
			expect(result.status).toBe(2);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("strips a runner prefix (sudo) before finding the -f pattern", () => {
		const fixture = makeLinkedWorktreeFixture();
		try {
			const denied = runHook(
				"sudo pkill -f tlc2.TLC",
				BASE_ENV,
				fixture.linked,
			);
			expect(denied.status).toBe(2);
			const allowed = runHook(
				`sudo pkill -f ${fixture.linked}.*tlc2`,
				BASE_ENV,
				fixture.linked,
			);
			expect(allowed.status).toBe(0);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("a signal flag before -f does not defeat pattern parsing", () => {
		const fixture = makeLinkedWorktreeFixture();
		try {
			const denied = runHook("pkill -9 -f tlc2.TLC", BASE_ENV, fixture.linked);
			expect(denied.status).toBe(2);
			const allowed = runHook(
				`pkill -9 -f ${fixture.linked}.*tlc2`,
				BASE_ENV,
				fixture.linked,
			);
			expect(allowed.status).toBe(0);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("killall is never scoped -- it matches by process NAME only, so no pattern text can allow it", () => {
		const result = runHook(`killall -9 ${repoRoot}.*tlc2`, BASE_ENV, repoRoot);
		expect(result.status).toBe(2);
	});

	it("kill <pid> is a different command entirely, unaffected by this rule", () => {
		expect(findDeny("kill 12345")).toBeNull();
		expect(findDeny(`kill ${repoRoot}`)).toBeNull();
	});

	// #3526/#3556 review F6: cwd alone is not enough. The orchestrator (and
	// any subagent that has not entered a worktree) runs with payload cwd
	// pointed at the SHARED main checkout, a path PREFIX of every
	// `.claude/worktrees/*` path -- `pattern.includes(cwd)` was satisfiable
	// from there even though it is not itself a linked worktree.
	it("denies a scoped pkill -f run from a real directory that is NOT a linked worktree, even though the pattern contains that exact cwd", () => {
		const notAWorktree = mkdtempSync(
			join(tmpdir(), "pi-lens-guard-bash-not-worktree-cwd-"),
		);
		try {
			const result = runHook(
				`pkill -f ${notAWorktree}.*tlc2`,
				BASE_ENV,
				notAWorktree,
			);
			expect(result.status).toBe(2);
			expect(result.stderr.toLowerCase()).toContain("pkill");
		} finally {
			rmSync(notAWorktree, { recursive: true, force: true });
		}
	});

	it("allows the SAME pattern once that cwd becomes a real linked worktree (only .git's shape changed)", () => {
		const dir = mkdtempSync(
			join(tmpdir(), "pi-lens-guard-bash-becomes-worktree-cwd-"),
		);
		try {
			writeFileSync(
				join(dir, ".git"),
				"gitdir: /some/main/checkout/.git/worktrees/fixture\n",
			);
			const result = runHook(`pkill -f ${dir}.*tlc2`, BASE_ENV, dir);
			expect(result.status).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// #3526: checkout/scratch-directory-under-/tmp guard (tmpCheckout)
// ---------------------------------------------------------------------------
//
// #3526 (2026-09-26): ~20 review/merge scratch checkouts accumulated under
// /tmp (tmpfs = RAM + swap on the maintainer host), 340-420 MB each, ~10 GB
// total, swap at 8/8 GB. `mktemp -d`'s bare (no template, no -p/--tmpdir=)
// default depends on this test RUNNER's own ambient TMPDIR/TMP/TEMP, so
// those two cases get their own isolated env (BASE_ENV already strips
// PI_LENS_HOME for the same ambient-leakage reason the probe-hygiene section
// above documents); every other case here is self-contained (an absolute
// template, an explicit -p/--tmpdir=, or a RELATIVE template that measurably
// lands in mktemp's own cwd -- `PAYLOAD_CWD` by default in this suite,
// never /tmp).
describe("scripts/hooks/guard-bash.mjs -- checkout/scratch directory under /tmp (#3526)", () => {
	const NO_AMBIENT_TMPDIR_ENV: NodeJS.ProcessEnv = Object.fromEntries(
		Object.entries(BASE_ENV).filter(
			([key]) => !["TMPDIR", "TMP", "TEMP"].includes(key),
		),
	);

	it("denies a bare `mktemp -d` (no template, no -p) with no ambient TMPDIR -- the measured default is /tmp", () => {
		const result = runHook("mktemp -d", NO_AMBIENT_TMPDIR_ENV);
		expect(result.status).toBe(2);
		expect(result.stderr.toLowerCase()).toContain("/tmp");
	});

	it("allows a bare `mktemp -d` when TMPDIR is set ambient to somewhere off /tmp", () => {
		const result = runHook("mktemp -d", {
			...NO_AMBIENT_TMPDIR_ENV,
			TMPDIR: "/home/dev/scratch",
		});
		expect(result.status).toBe(0);
	});

	it("denies TMPDIR=<off-tmp-looking-but-under-/tmp> mktemp -d -- the offending value is judged, not just its ambient absence", () => {
		const result = runHook(
			"TMPDIR=/tmp/pi-lens-review mktemp -d",
			NO_AMBIENT_TMPDIR_ENV,
		);
		expect(result.status).toBe(2);
	});

	it("allows a git worktree add whose destination resolves under a non-/tmp cwd", () => {
		expect(
			findDeny(
				`git worktree add ${PAYLOAD_CWD}/../agent-3526-new`,
				PAYLOAD_CWD,
			),
		).toBeNull();
	});

	it("resolves a RELATIVE git worktree add target against the payload cwd, denying when that cwd is itself under /tmp", () => {
		// #3526's acceptance: "a git worktree add ../x from a checkout under
		// /tmp is denied" -- built with a real cwd under /tmp so the
		// resolution is not a fictitious path string.
		const underTmp = "/tmp/pi-lens-guard-bash-3526-cwd-fixture";
		expect(findDeny("git worktree add ../sibling-tree", underTmp)).toBe(
			"tmpCheckout",
		);
	});

	it("a literal $TMPDIR-shaped worktree destination defaults to /tmp when TMPDIR is not set on this command or ambiently", () => {
		const result = runHook(
			'git worktree add "$TMPDIR/foo"',
			NO_AMBIENT_TMPDIR_ENV,
		);
		expect(result.status).toBe(2);
	});

	// Bash expands `$TMPDIR` before the inline `TMPDIR=` reaches git (measured:
	// `TMPDIR=/home/dev/scratch printf %s "$TMPDIR/foo"` prints the shell's
	// value), so the destination follows the SHELL's TMPDIR. The ambient TMPDIR
	// is set explicitly in both rows: the row it replaces read the runner's own
	// TMPDIR, so it passed with a lane TMPDIR off /tmp and redded in CI (#3997).
	it("an inline TMPDIR= does not move a $TMPDIR-shaped destination: bash expands the word first", () => {
		const command = 'TMPDIR=/home/dev/scratch git worktree add "$TMPDIR/foo"';
		expect(runHook(command, NO_AMBIENT_TMPDIR_ENV).stderr).toBe(
			`${RULE_MESSAGES.tmpCheckout}\n`,
		);
		const offTmp = runHook(command, {
			...NO_AMBIENT_TMPDIR_ENV,
			TMPDIR: "/home/dev/elsewhere",
		});
		expect(offTmp.stderr).toBe("");
		expect(offTmp.status).toBe(0);
	});

	// #4057: mktemp has two TMPDIRs. A word the agent typed (a template, a
	// `-p` or `--tmpdir=` value, a `~`) is expanded by bash from the shell's own
	// variables before the inline prefix applies, as git's words are (#3997).
	// GNU mktemp's own default directory (no template, `-t`, bare `--tmpdir`) is
	// read from mktemp's environment, so the prefix moves it. The rule models
	// GNU coreutils mktemp as #3526 measured it (9.4); this change did not re-run
	// GNU mktemp. Measured on macOS 26.5 (/bin/bash 3.2.57, BSD mktemp from
	// shell_cmds-329, whose man page lists `-p tmpdir, --tmpdir[=tmpdir]`) with
	// TMPDIR=a in the shell: `TMPDIR=b mktemp -d $TMPDIR/x.XXXXXX`, `-p $TMPDIR
	// x.XXXXXX` and `--tmpdir=$TMPDIR x.XXXXXX` landed in a, bare `--tmpdir
	// x.XXXXXX` landed in b, and no template and `-t` landed in the per-user
	// temp directory, in neither, so only the GNU model backs those two rows.
	// Each row sets the hook's ambient TMPDIR (or HOME) itself, so the runner's
	// own value never decides it, and names only absent directories, which the
	// hook judges as spelled on every platform.
	describe("an inline TMPDIR= moves only mktemp's own default (#4057)", () => {
		const AMBIENT_TMP = "/tmp/guard-bash-4057-ambient";
		const AMBIENT_OFF = "/home/dev/guard-bash-4057-ambient";
		const INLINE_TMP = "/tmp/guard-bash-4057-inline";
		const INLINE_OFF = "/home/dev/guard-bash-4057-inline";
		// Recurrence (#4826 review r1 F2): the gate admitted a closed list of
		// spellings that can expand to nothing and was widened twice; each of
		// these is a parameter expansion bash makes empty for an unset D and the
		// list missed. Any reference the hook cannot resolve takes both readings.
		const EMPTY_SPELLINGS = [
			"${D:-}",
			"${D-}",
			"${D%x}",
			"${D#x}",
			"${D:+x}",
			"${D:0:0}",
			"${D:-${E}}",
		];
		// mktemp's own /tmp fallback lands in /tmp itself, which exists. On macOS
		// /tmp resolves to /private/tmp; the tmpCheckout rules compare against
		// both spellings of the root (#4060 r2), so the rows deny there too.
		const TMP_FALLBACK_RULE: DenyRule = "tmpCheckout";
		const ROWS: Array<{
			label: string;
			command: string;
			ambient: Record<string, string>;
			rule: DenyRule | null;
		}> = [
			{
				label: "a $TMPDIR/ template follows the shell's TMPDIR under /tmp",
				command: `TMPDIR=${INLINE_OFF} mktemp -d $TMPDIR/x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: "a $TMPDIR/ template follows the shell's TMPDIR off /tmp",
				command: `TMPDIR=${INLINE_TMP} mktemp -d $TMPDIR/x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: null,
			},
			{
				label: "a -p $TMPDIR value follows the shell's TMPDIR under /tmp",
				command: `TMPDIR=${INLINE_OFF} mktemp -d -p $TMPDIR x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label:
					"a bundled -dp $TMPDIR value follows the shell's TMPDIR off /tmp",
				command: `TMPDIR=${INLINE_TMP} mktemp -dp "$TMPDIR" x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: null,
			},
			{
				label: "a --tmpdir=$TMPDIR value follows the shell's TMPDIR under /tmp",
				command: `TMPDIR=${INLINE_OFF} mktemp -d --tmpdir=$TMPDIR x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: "a --tmpdir=$TMPDIR value follows the shell's TMPDIR off /tmp",
				command: `TMPDIR=${INLINE_TMP} mktemp -d --tmpdir=$TMPDIR x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: null,
			},
			{
				label: "a ~/ template follows the shell's HOME under /tmp",
				command: "HOME=/home/dev/guard-bash-4057-home mktemp -d ~/x.XXXXXX",
				ambient: { HOME: "/tmp/guard-bash-4057-home" },
				rule: "tmpCheckout",
			},
			{
				label: "a ~/ template follows the shell's HOME off /tmp",
				command: "HOME=/tmp/guard-bash-4057-home mktemp -d ~/x.XXXXXX",
				ambient: { HOME: "/home/dev/guard-bash-4057-home" },
				rule: null,
			},
			{
				// The shell has no T, so bash hands mktemp `//x.XXXXXX`.
				label: "a variable only the prefix sets stays unexpanded in a template",
				command: "T=tmp/guard-bash-4057 mktemp -d /$T/x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: null,
			},
			{
				label: "an earlier export is the shell's TMPDIR for a typed word",
				command: `export TMPDIR=/tmp/guard-bash-4057-exported; TMPDIR=${INLINE_OFF} mktemp -d $TMPDIR/x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: "tmpCheckout",
			},
			// Accepted residual: TMPDIR is unset in the shell and in the hook's env.
			// Bash expands a typed `$TMPDIR` to the empty string, so mktemp gets
			// `/guard-bash-4057-unset/…`, but the hook reads lookupShellVariable's
			// `/tmp` default, as git's words do. The prefix is not consulted. The
			// absent subdirectory keeps macOS's /tmp symlink out of the verdict.
			{
				label: "an unset shell TMPDIR in a template reads the /tmp default",
				command: `TMPDIR=${INLINE_OFF} mktemp -d $TMPDIR/guard-bash-4057-unset/x.XXXXXX`,
				ambient: {},
				rule: "tmpCheckout",
			},
			{
				label: "an unset shell TMPDIR in a -p value reads the /tmp default",
				command: `TMPDIR=${INLINE_OFF} mktemp -d -p $TMPDIR/guard-bash-4057-unset x.XXXXXX`,
				ambient: {},
				rule: "tmpCheckout",
			},
			// A `-p`/`--tmpdir=` value or a template that is one variable the shell
			// does not have expands to nothing. GNU mktemp reads an empty `-p ''` or
			// `--tmpdir=` as its own `$TMPDIR`, else /tmp (coreutils mktemp.c), and a
			// vanished template leaves none, which defaults there too. The prefix's
			// `D` never reaches the word. The ambient TMPDIR is an absent directory,
			// so macOS's /tmp symlink stays out of the verdict.
			{
				label: "-p $D, D only in the prefix: mktemp's TMPDIR under /tmp",
				command: "D=/tmp/guard-bash-4057-lane mktemp -d -p $D x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: '-p "$D", D only in the prefix: mktemp\'s TMPDIR under /tmp',
				command: 'D=/tmp/guard-bash-4057-lane mktemp -d -p "$D" x.XXXXXX',
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: "-p ${D}, D only in the prefix: mktemp's TMPDIR under /tmp",
				command: "D=/tmp/guard-bash-4057-lane mktemp -d -p ${D} x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: "--tmpdir=$D, D only in the prefix: mktemp's TMPDIR under /tmp",
				command: "D=/tmp/guard-bash-4057-lane mktemp -d --tmpdir=$D x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label:
					"a $D template, D only in the prefix: mktemp's TMPDIR under /tmp",
				command: "D=/tmp/guard-bash-4057-lane mktemp -d $D",
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: 'an empty-assigned -p "$D" reads mktemp\'s TMPDIR under /tmp',
				command: 'D=; mktemp -d -p "$D" x.XXXXXX',
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: "-p \"$D\" follows mktemp's TMPDIR off /tmp, not the prefix's D",
				command: 'D=/tmp/guard-bash-4057-lane mktemp -d -p "$D" x.XXXXXX',
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: null,
			},
			{
				label: '-p "$D" with D unset reads the prefix\'s TMPDIR under /tmp',
				command: `TMPDIR=${INLINE_TMP} mktemp -d -p "$D" x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: "tmpCheckout",
			},
			// The same holds for any word made only of references the hook cannot
			// resolve and bash can expand to empty: a positional parameter (the
			// hook's command has none), `$*`, `$!` before any background job, and a
			// concatenation of unset variables. `$0` is always set, and a resolved
			// part keeps the word non-empty, so neither gets the empty reading.
			{
				label: '-p "$1", no parameters: mktemp\'s TMPDIR under /tmp',
				command: 'mktemp -d -p "$1" x.XXXXXX',
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: '-p "${1}", no parameters: mktemp\'s TMPDIR under /tmp',
				command: 'mktemp -d -p "${1}" x.XXXXXX',
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: '-p "$*", no parameters: mktemp\'s TMPDIR under /tmp',
				command: 'mktemp -d -p "$*" x.XXXXXX',
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: '-p "$!", no background job: mktemp\'s TMPDIR under /tmp',
				command: 'mktemp -d -p "$!" x.XXXXXX',
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: "--tmpdir=$D$E, both unset: mktemp's TMPDIR under /tmp",
				command: "mktemp -d --tmpdir=$D$E x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: "a $D$E template, both unset: mktemp's TMPDIR under /tmp",
				command: "mktemp -d $D$E",
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: '-p "$0" is never empty: it stays relative to the cwd',
				command: 'mktemp -d -p "$0" x.XXXXXX',
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: null,
			},
			{
				label: '-p "$X$D" with X off /tmp is never empty',
				command: 'X=/home/dev/guard-bash-4057-x; mktemp -d -p "$X$D" x.XXXXXX',
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: null,
			},
			// Recurrence (#4826 review r1 F1): moving the typed words off the prefix
			// env removed the only cover for an absolute head followed by a variable
			// the shell lacks. `S` is unset in the shell, so bash hands mktemp
			// `/tmp/…` and the directory lands under /tmp; the prefix's S is never
			// read. The unprefixed spelling was already allowed on master.
			{
				label: "a /tmp$S template, S only in the prefix, lands under /tmp",
				command: "S= mktemp -d /tmp$S/guard-bash-4057-f1/x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: "tmpCheckout",
			},
			{
				label: "a /tmp$S template with no prefix lands under /tmp",
				command: "mktemp -d /tmp$S/guard-bash-4057-f1/x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: "tmpCheckout",
			},
			{
				label: "-p /tmp$S, S only in the prefix, lands under /tmp",
				command: "S= mktemp -d -p /tmp$S/guard-bash-4057-f1 x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: "tmpCheckout",
			},
			{
				label: "--tmpdir=/tmp$S, S only in the prefix, lands under /tmp",
				command: "S= mktemp -d --tmpdir=/tmp$S/guard-bash-4057-f1 x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: "tmpCheckout",
			},
			{
				label: "a /home$S template stays off /tmp",
				command: "S= mktemp -d /home$S/dev/guard-bash-4057-f1/x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: null,
			},
			// Recurrence (#4826 review r1 F2): see EMPTY_SPELLINGS. Quotes are gone
			// by the time the hook reads the word, so the quoted spelling stands for
			// the unquoted one too.
			...EMPTY_SPELLINGS.flatMap((spelling) => [
				{
					label: `-p "${spelling}" reads mktemp's TMPDIR under /tmp`,
					command: `mktemp -d -p "${spelling}" x.XXXXXX`,
					ambient: { TMPDIR: AMBIENT_TMP },
					rule: "tmpCheckout" as DenyRule | null,
				},
				{
					label: `-p "${spelling}" follows mktemp's TMPDIR off /tmp`,
					command: `mktemp -d -p "${spelling}" x.XXXXXX`,
					ambient: { TMPDIR: AMBIENT_OFF },
					rule: null as DenyRule | null,
				},
			]),
			{
				label: '--tmpdir="${D-}" reads mktemp\'s TMPDIR under /tmp',
				command: 'mktemp -d --tmpdir="${D-}" x.XXXXXX',
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: 'a "${D-}" template reads mktemp\'s TMPDIR under /tmp',
				command: 'mktemp -d "${D-}"',
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label:
					'a quoted backtick -p "`true`" reads mktemp\'s TMPDIR under /tmp',
				command: 'mktemp -d -p "`true`" x.XXXXXX',
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			// Parser-hostile words: an unterminated or unparseable reference is a
			// reference the hook cannot resolve, so it neither throws nor allows.
			{
				label: "-p '${' (unterminated brace) reads mktemp's TMPDIR under /tmp",
				command: "mktemp -d -p '${' x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label:
					"-p '$((1+1' (unterminated arithmetic) reads mktemp's TMPDIR under /tmp",
				command: "mktemp -d -p '$((1+1' x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: '-p "${!D}" (indirection) reads mktemp\'s TMPDIR under /tmp',
				command: 'mktemp -d -p "${!D}" x.XXXXXX',
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label:
					"-p ~nosuch (unresolvable ~user) reads mktemp's TMPDIR under /tmp",
				command: "mktemp -d -p ~guardbash4057nosuch x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			{
				label: "a lone backtick in a -p value reads mktemp's TMPDIR under /tmp",
				command: "mktemp -d -p '`' x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: "tmpCheckout",
			},
			// GNU mktemp reads TMPDIR only when it is set and non-empty, else
			// /tmp (coreutils mktemp.c: `env && *env`), so an empty TMPDIR in
			// mktemp's own env, from the prefix or the ambient env, is /tmp for its
			// default directory (TMP_FALLBACK_RULE).
			{
				label: "an empty TMPDIR= with no template falls back to /tmp",
				command: "TMPDIR= mktemp -d",
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: TMP_FALLBACK_RULE,
			},
			{
				label: "an empty TMPDIR= with -t falls back to /tmp",
				command: "TMPDIR= mktemp -d -t x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: TMP_FALLBACK_RULE,
			},
			{
				label: "an empty TMPDIR= with bare --tmpdir falls back to /tmp",
				command: "TMPDIR= mktemp -d --tmpdir x.XXXXXX",
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: TMP_FALLBACK_RULE,
			},
			{
				label: 'an empty TMPDIR= with -p "" falls back to /tmp',
				command: 'TMPDIR= mktemp -d -p "" x.XXXXXX',
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: TMP_FALLBACK_RULE,
			},
			{
				label: "an empty TMPDIR (ambient) with no template falls back to /tmp",
				command: "mktemp -d",
				ambient: { TMPDIR: "" },
				rule: TMP_FALLBACK_RULE,
			},
			{
				label: "an empty TMPDIR from TMPDIR=$X, X unset, falls back to /tmp",
				command: "TMPDIR=$X mktemp -d",
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: TMP_FALLBACK_RULE,
			},
			{
				label:
					"an empty TMPDIR (ambient) with bare --tmpdir falls back to /tmp",
				command: "mktemp -d --tmpdir x.XXXXXX",
				ambient: { TMPDIR: "" },
				rule: TMP_FALLBACK_RULE,
			},
			{
				label:
					"a non-empty prefix over an empty TMPDIR (ambient) follows the prefix",
				command: `TMPDIR=${INLINE_OFF} mktemp -d`,
				ambient: { TMPDIR: "" },
				rule: null,
			},
			{
				label: "no template lands in the prefix's TMPDIR under /tmp",
				command: `TMPDIR=${INLINE_TMP} mktemp -d`,
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: "tmpCheckout",
			},
			{
				label: "no template lands in the prefix's TMPDIR off /tmp",
				command: `TMPDIR=${INLINE_OFF} mktemp -d`,
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: null,
			},
			{
				label: "-t lands in the prefix's TMPDIR under /tmp",
				command: `TMPDIR=${INLINE_TMP} mktemp -d -t x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: "tmpCheckout",
			},
			{
				label: "-t lands in the prefix's TMPDIR off /tmp",
				command: `TMPDIR=${INLINE_OFF} mktemp -d -t x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: null,
			},
			{
				label: "a bundled -dt lands in the prefix's TMPDIR under /tmp",
				command: `TMPDIR=${INLINE_TMP} mktemp -dt x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: "tmpCheckout",
			},
			{
				label: "a bundled -dt lands in the prefix's TMPDIR off /tmp",
				command: `TMPDIR=${INLINE_OFF} mktemp -dt x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: null,
			},
			{
				label: "bare --tmpdir lands in the prefix's TMPDIR under /tmp",
				command: `TMPDIR=${INLINE_TMP} mktemp -d --tmpdir x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_OFF },
				rule: "tmpCheckout",
			},
			{
				label: "bare --tmpdir lands in the prefix's TMPDIR off /tmp",
				command: `TMPDIR=${INLINE_OFF} mktemp -d --tmpdir x.XXXXXX`,
				ambient: { TMPDIR: AMBIENT_TMP },
				rule: null,
			},
		];

		it.each(ROWS)("$label", ({ command, ambient, rule }) => {
			const result = runHook(command, {
				...NO_AMBIENT_TMPDIR_ENV,
				...ambient,
			});
			expect(result.stderr).toBe(
				rule === null ? "" : `${RULE_MESSAGES[rule]}\n`,
			);
			expect(result.status).toBe(rule === null ? 0 : 2);
		});
	});

	it("a /tmp string inside a comment, a heredoc body, or echo text never trips the rule -- this rule reads argv WORDS, not raw text", () => {
		expect(
			findDeny(
				"echo 'scratch checkouts must never land under /tmp' # reminder",
			),
		).toBeNull();
		expect(
			findDeny("cat <<'EOF'\nmktemp -d /tmp/not-a-real-command\nEOF"),
		).toBeNull();
	});

	// #3526 review F1: the historical incident shape, verbatim. All 14 real
	// `/tmp` worktree-adds in the transcript corpus use variable indirection
	// (`S=/tmp/…; W=$S/wt; git worktree add $W`), never a literal `$TMPDIR`.
	describe("variable-indirected destinations (review F1)", () => {
		it("resolves a one-hop indirected /tmp destination", () => {
			expect(
				findDeny(
					"S=/tmp/claude-0/x/scratchpad; W=$S/wt; git worktree add -q --detach $W HEAD",
					PAYLOAD_CWD,
				),
			).toBe("tmpCheckout");
		});

		it("resolves a two-hop indirected /tmp destination", () => {
			expect(
				findDeny("A=/tmp/x; B=$A/y; git worktree add $B", PAYLOAD_CWD),
			).toBe("tmpCheckout");
		});

		it("keeps an indirected NON-/tmp destination allowed", () => {
			expect(
				findDeny('W=".claude/worktrees/a"; git worktree add "$W"', PAYLOAD_CWD),
			).toBeNull();
			// hookVerdict, not findDeny: `~` expands from the HOME of the env it is
			// given (BASE_ENV's off-/tmp one), not from the worker's pinned HOME.
			expect(
				hookVerdict(
					"S=~/.local/share/pi-lens-orchestrator/tmp; W=$S/wt; git worktree add $W",
					BASE_ENV,
					PAYLOAD_CWD,
				).status,
			).toBe(0);
		});

		it("does not hang on a self-referential chain, and stays allowed (the cap breaks the loop, leaving unresolved $A as literal text)", () => {
			expect(findDeny("A=$A; git worktree add $A", PAYLOAD_CWD)).toBeNull();
		});

		it("resolves a chain up to the cap depth", () => {
			expect(
				findDeny(
					"A=/home/x; B=$A/y; C=$B/z; D=$C/w; git worktree add $D",
					PAYLOAD_CWD,
				),
			).toBeNull();
		});

		it("mktemp -p also resolves through indirection", () => {
			expect(
				findDeny("S=/tmp/scratch; mktemp -d -p $S foo.XXXXXX", PAYLOAD_CWD),
			).toBe("tmpCheckout");
		});
	});

	// #3526 review F2: bundled short mktemp flags and -t, measured against
	// real GNU coreutils 9.4 (PR body has the transcript).
	describe("bundled short mktemp flags and -t (review F2)", () => {
		it("denies -d -t, -dt, -dp DIR, and -qd /tmp/X", () => {
			// #3556 S4: make the intended /tmp landing explicit. The classifier
			// correctly reads the real process environment for `-t`, so an
			// orchestrator lane's off-/tmp TMPDIR must not change this fixture.
			expect(
				findDeny("TMPDIR=/tmp mktemp -d -t rvprobe.XXXX", PAYLOAD_CWD),
			).toBe("tmpCheckout");
			expect(findDeny("TMPDIR=/tmp mktemp -dt rvprobe.XXXX", PAYLOAD_CWD)).toBe(
				"tmpCheckout",
			);
			expect(findDeny("mktemp -dp /tmp rvprobe.XXXX", PAYLOAD_CWD)).toBe(
				"tmpCheckout",
			);
			expect(findDeny("mktemp -qd /tmp/pi-lens-review-XXXX", PAYLOAD_CWD)).toBe(
				"tmpCheckout",
			);
		});

		it("allows the same bundled forms when -p/-t root off /tmp", () => {
			expect(
				findDeny("mktemp -dp /home/dev/scratch rvprobe.XXXX", PAYLOAD_CWD),
			).toBeNull();
			expect(
				findDeny(
					"TMPDIR=/home/dev/scratch mktemp -dt rvprobe.XXXX",
					PAYLOAD_CWD,
				),
			).toBeNull();
		});

		it("a bundled flag with no 'd' letter stays file mode (always allowed)", () => {
			expect(findDeny("mktemp -qt rvprobe.XXXX", PAYLOAD_CWD)).toBeNull();
		});
	});

	// #3526 review S1: bash resolves `~` before the program ever sees argv;
	// this static scanner has to redo that step, and must do it regardless
	// of where the payload cwd happens to be (a reviewer's own worktree may
	// itself sit under /tmp).
	describe("~ (HOME) expansion (review S1)", () => {
		it("expands ~/… to a real HOME even when cwd is itself under /tmp", () => {
			const underTmpCwd = "/tmp/some-review-worktree";
			// hookVerdict, not findDeny: the classifier reads `~` from the env it
			// is given, and the worker's own HOME is a scratch dir under /tmp
			// whenever TMPDIR is /tmp (#4789 review F1).
			for (const command of [
				"git worktree add ~/.cache/pi-lens-orchestrator/worktrees/agent-x",
				"git worktree add ~/.local/share/pi-lens-orchestrator/tmp/lane-1",
				"git worktree add ~/.plegma/work/sub-1",
			])
				expect(
					hookVerdict(command, BASE_ENV, underTmpCwd).status,
					command,
				).toBe(0);
		});

		it("expands ~ picked up MID-CHAIN through variable indirection", () => {
			expect(
				hookVerdict(
					"S=~/.local/share/pi-lens-orchestrator/tmp; W=$S/wt; git worktree add $W",
					BASE_ENV,
					"/tmp/some-review-worktree",
				).status,
			).toBe(0);
		});

		it("bare ~ alone expands too, even when cwd is itself under /tmp", () => {
			// A cwd OFF /tmp would allow this even if `~` were left unexpanded
			// (the unresolved literal is still a relative path that resolves
			// off-tmp against an off-tmp cwd) -- this must use an UNDER-/tmp
			// cwd, the same way the `~/…` cases above do, so the assertion
			// actually depends on the bare-`~` branch running.
			expect(
				hookVerdict("git worktree add ~", BASE_ENV, "/tmp/some-review-worktree")
					.status,
			).toBe(0);
		});
	});
});

// ---------------------------------------------------------------------------
// #3471: git commit/push chained after an ungated check (checkUngated)
// ---------------------------------------------------------------------------
//
// #3471: a check (npm run lint/build/test/fmt:check/preflight, npx vitest,
// tsc, node scripts/check-*.mjs) piped or `;`-separated from a following git
// commit/push never gates it -- three 2026-09-25 incidents, quoted in the
// PR body verbatim as DENY_CASES entries above; the corpus audit below (also
// in the PR body) found the SAME shape 20 more times in real history.
describe("scripts/hooks/guard-bash.mjs -- git commit/push chained after an ungated check (#3471)", () => {
	it("tsc as a check", () => {
		expect(findDeny("tsc --noEmit ; git commit -m x")).toBe("checkUngated");
		expect(findDeny("tsc --noEmit && git commit -m x")).toBeNull();
	});

	it("node scripts/check-*.mjs as a check", () => {
		expect(
			findDeny("node scripts/check-pr-body.mjs 123 ; git push origin y"),
		).toBe("checkUngated");
		expect(
			findDeny("node scripts/check-pr-body.mjs 123 && git push origin y"),
		).toBeNull();
	});

	it("a DIFFERENT node script is not a check", () => {
		expect(findDeny("node scripts/build.mjs ; git commit -m x")).toBeNull();
	});

	// #3471 review F4: `npx vitest` alone missed this repo's own convention.
	describe("vitest by basename, a timeout prefix, and npm test (review F4)", () => {
		it("node_modules/.bin/vitest is a check, resolved by basename", () => {
			expect(
				findDeny(
					"node_modules/.bin/vitest run t.test.ts 2>&1 | grep x; git commit -m x",
				),
			).toBe("checkUngated");
			expect(
				findDeny("node_modules/.bin/vitest run t.test.ts && git commit -m x"),
			).toBeNull();
		});

		it("a bare timeout <duration> prefix is stepped past", () => {
			expect(
				findDeny(
					"timeout 400 node_modules/.bin/vitest run t.test.ts 2>&1 | grep x; git add -A && git commit -m x && git push origin y",
				),
			).toBe("checkUngated");
			expect(
				findDeny(
					"timeout 400 node_modules/.bin/vitest run t.test.ts && git add -A && git commit -m x && git push origin y",
				),
			).toBeNull();
		});

		it("npm test and npm t are checks", () => {
			expect(findDeny("npm test 2>&1 | tail; git commit -m x")).toBe(
				"checkUngated",
			);
			expect(findDeny("npm test && git commit -m x")).toBeNull();
			expect(findDeny("npm t 2>&1 | tail; git commit -m x")).toBe(
				"checkUngated",
			);
		});

		it("a timeout-wrapped, unrelated binary is still not a check", () => {
			expect(
				findDeny(
					"timeout 30 node_modules/.bin/oxfmt --check x.ts ; git commit -m x",
				),
			).toBeNull();
		});
	});

	it("no preceding check at all allows -- this is not a general 'write must be && or terminal' rule (it would deny the repo's own sanctioned `commit; status` pattern)", () => {
		expect(findDeny('git commit -m "x" ; git status')).toBeNull();
		expect(findDeny("echo hi; git push origin y")).toBeNull();
	});

	it("the backward search for the nearest check stops at an earlier write", () => {
		// npm run lint DOES gate the push (&&); the commit that follows is a
		// fresh boundary, not judged against the lint check at all.
		expect(
			findDeny("npm run lint && git push origin y ; git commit -m x"),
		).toBeNull();
	});

	it("a check piped to a filter (grep/tail/head) before an unconditional write -- the pipeline's exit status is the FILTER's, not the check's", () => {
		expect(
			findDeny(
				"npm run build 2>&1 | tail -1 && git add -A && git commit -m x && git push origin y",
			),
		).toBe("checkUngated");
	});

	it("shell control flow (if/then/fi deciding from a saved $?) is left alone rather than guessed at", () => {
		// This repo's OWN convention (audited in the corpus, PR body): save
		// the check's exit code, then gate through `if`, not `&&`. A pure
		// separator scan cannot see that gate, so it stands aside entirely
		// rather than deny a properly-gated write.
		expect(
			findDeny(
				"npm run build; vexit=$?; if [ $vexit -eq 0 ]; then git add -A && git commit -m x; fi",
			),
		).toBeNull();
	});

	it("splitSegmentsWithSeparators tags each segment with its preceding separator, null for the first", () => {
		expect(splitSegmentsWithSeparators("a && b || c ; d | e & f\ng")).toEqual([
			{ text: "a ", sep: null },
			{ text: " b ", sep: "&&" },
			{ text: " c ", sep: "||" },
			{ text: " d ", sep: ";" },
			{ text: " e ", sep: "|" },
			{ text: " f", sep: "&" },
			{ text: "g", sep: "\n" },
		]);
	});

	// #3471 review F3: the control-flow exemption moved from whole-REGION to
	// per-WRITE (a backward walk that stops at the nearest opener or closer),
	// because a region can carry an EARLIER, already-closed construct beside
	// a LATER, genuinely ungated check -> write the old whole-region skip
	// could not tell apart. Real corpus row e3cbc7a3 is this shape.
	describe("per-write control-flow scoping (review F3)", () => {
		it("an earlier, closed for/do/done loop does not exempt a later ungated write (corpus e3cbc7a3)", () => {
			expect(
				findDeny(
					"for f in a; do :; done; npx vitest run tests/config/hook-await-bounds.test.ts 2>&1 | grep -E 'Tests |Test Files'; git add x && git commit -m y && git push z",
				),
			).toBe("checkUngated");
		});

		it("a trivial if/fi with nothing inside still denies the write after it", () => {
			expect(
				findDeny(
					"npm run lint 2>&1 | tail; if true; then :; fi; git push origin y",
				),
			).toBe("checkUngated");
		});

		it("a trivial for/do/done with nothing inside still denies the write after it", () => {
			expect(
				findDeny(
					"npm run lint 2>&1 | tail; for f in a; do :; done; git push origin y",
				),
			).toBe("checkUngated");
		});

		it("the vexit convention still allows -- the write's nearest control-flow word is an opener (then), not a closer", () => {
			expect(
				findDeny(
					"npm run build; vexit=$?; if [ $vexit -eq 0 ]; then git add -A && git commit -m x; fi",
				),
			).toBeNull();
		});

		it("a while/do/done convention also still allows", () => {
			expect(
				findDeny(
					"npm run build; vexit=$?; while [ $vexit -eq 0 ]; do git add -A && git commit -m x; break; done",
				),
			).toBeNull();
		});
	});
});

// ---------------------------------------------------------------------------
// #3471 lexer fix: a redirection `&` is not a segment separator
// ---------------------------------------------------------------------------
//
// Found building #3471's chain scan: `2>&1`'s lone `&` matched the plain
// SEGMENT_SEPARATOR regex unconditionally, splitting `npm run lint
// >/dev/null 2>&1 && git commit …` (the issue's own case 1, rewritten with
// `&&` -- exactly the form checkUngated must ALLOW) into bogus segments and
// corrupting the separator a later segment was tagged with. Measured against
// real bash in the PR body (`2>&1`, `>f 2>&1`, `&> f`, `1>&2` are all single
// redirection tokens, never a background operator or half of `&&`).
describe("scripts/hooks/guard-bash.mjs -- a redirection `&` is not a segment separator (#3471)", () => {
	it("2>&1 does not break a following && chain", () => {
		expect(
			findDeny("npm run lint >/dev/null 2>&1 && git commit -m x"),
		).toBeNull();
		expect(splitSegments("echo hi >/dev/null 2>&1 && echo bye")).toEqual([
			"echo hi >/dev/null 2>&1 ",
			" echo bye",
		]);
	});

	it("a bare stdout-to-file redirect then 2>&1 still keeps one segment", () => {
		expect(
			splitSegmentsWithSeparators("echo hi >f.log 2>&1 && echo bye"),
		).toEqual([
			{ text: "echo hi >f.log 2>&1 ", sep: null },
			{ text: " echo bye", sep: "&&" },
		]);
	});

	it("1>&2 (duplicating stdout onto stderr) is the same shape, reversed", () => {
		expect(splitSegments("echo hi 1>&2 && echo bye")).toEqual([
			"echo hi 1>&2 ",
			" echo bye",
		]);
	});

	it("bash's &> (redirect both) form is recognized from the OTHER side (& followed by >)", () => {
		expect(splitSegments("echo hi &> f.log && echo bye")).toEqual([
			"echo hi &> f.log ",
			" echo bye",
		]);
	});

	it("a REAL background & (not adjacent to a redirect operator) is still a live separator", () => {
		expect(findDeny("sleep 1 & git stash")).toBe("stash");
		expect(splitSegments("sleep 1 & git stash")).toEqual([
			"sleep 1 ",
			" git stash",
		]);
	});

	it("&& is still recognized as one two-character separator, not defeated by the redirect-ampersand check", () => {
		expect(splitSegments("echo hi && echo bye")).toEqual([
			"echo hi ",
			" echo bye",
		]);
	});
});

describe("scripts/hooks/guard-bash.mjs -- node probe repository ownership (#3680)", () => {
	it("allows a node file outside this repository, including after cd", () => {
		const otherRepo = mkdtempSync(join(tmpdir(), "pi-lens-3680-other-repo-"));
		const foreignDir = mkdtempSync(join(tmpdir(), "pi-lens-3680-foreign-dir-"));
		try {
			mkdirSync(join(otherRepo, "dist"));
			gitExecFileSync("git", ["init", "--quiet", otherRepo], {
				stdio: "ignore",
			});
			expect(
				runHook(`node ${otherRepo}/dist/cli.js --help`, {}, repoRoot).status,
			).toBe(0);
			expect(
				runHook(`cd ${otherRepo} && node dist/cli.js --help`, {}, repoRoot)
					.status,
			).toBe(0);
			expect(
				runHook(
					`cd ${foreignDir} && node dist/cli.js --help`,
					BASE_ENV,
					repoRoot,
				).status,
			).toBe(0);
			// A nonexistent cd target is unknowable to the static guard, so the
			// conservative probe denial remains pinned.
			expect(
				runHook(
					`cd ${join(foreignDir, "missing")} && node dist/cli.js --help`,
					BASE_ENV,
					repoRoot,
				).status,
			).toBe(2);
		} finally {
			rmSync(otherRepo, { recursive: true, force: true });
			rmSync(foreignDir, { recursive: true, force: true });
		}
	});

	it("denies a relative node probe after cd fails inside another repository", () => {
		const foreignRepo = mkdtempSync(
			join(tmpdir(), "pi-lens-3680-foreign-repo-"),
		);
		try {
			gitExecFileSync("git", ["init", "--quiet", foreignRepo], {
				stdio: "ignore",
			});
			expect(
				runHook(
					`cd ${join(foreignRepo, "missing")} && node dist/cli.js --help`,
					BASE_ENV,
					repoRoot,
				).status,
			).toBe(2);
		} finally {
			rmSync(foreignRepo, { recursive: true, force: true });
		}
	});

	it("denies a runtime file in this checkout, including a plain clone", () => {
		expect(
			runHook(
				`node ${join(repoRoot, "clients", "probe.mjs")}`,
				BASE_ENV,
				repoRoot,
			).status,
		).toBe(2);
	});

	it("denies a runtime file reached through a symlink", () => {
		const linkRoot = mkdtempSync(join(tmpdir(), "pi-lens-3680-link-"));
		try {
			symlinkSync(join(repoRoot, "clients"), join(linkRoot, "clients"));
			expect(
				runHook(
					`node ${join(linkRoot, "clients", "probe.mjs")}`,
					BASE_ENV,
					repoRoot,
				).status,
			).toBe(2);
		} finally {
			rmSync(linkRoot, { recursive: true, force: true });
		}
	});

	it("pins the process-cwd initialIdentity fallback for a relative probe", () => {
		const previous = process.env.PI_LENS_HOME;
		delete process.env.PI_LENS_HOME;
		try {
			expect(classifySegment("node clients/probe.mjs")).toBe("probe");
			expect(
				classifySegment(
					`node ${join(repoRoot, "clients", "probe.mjs")}`,
					{},
					"/tmp/3688-foreign-cwd",
					null as unknown as undefined,
				),
			).toBe("probe");
		} finally {
			if (previous === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previous;
		}
	});
});

// #3778: the "hooks always run" rule (docs/pi-lens-subagent.md: never
// `--no-verify`, `-n`, `-c core.hooksPath=…`, `HUSKY=0`) lived only as prose.
// Recurrences this block names, so it does not ship as a speculative guard:
//   - #3703: a worker pushed with `--no-verify` and 56 files were red in CI.
//   - 2026-09-30 (orchestrator): `git commit --no-verify -m x` was used for a
//     scratch probe commit and guard-bash let it through with rc=0.
// False positives cost more than misses here (every Bash call runs this
// hook), so the allow rows below are the half of the contract that matters.
describe("scripts/hooks/guard-bash.mjs -- git hook bypass (#3778)", () => {
	const DENY: string[] = [
		// the two incident shapes, verbatim
		"git commit --no-verify -m x",
		"git push --no-verify origin fix/3703-x",
		// the other three subcommands the issue names
		"git merge --no-verify origin/master",
		"git rebase --no-verify origin/master",
		"git rebase -m --no-verify origin/master", // rebase -m takes no value
		// git accepts the unambiguous abbreviations (r1 F3)
		"git commit --no-veri -m x",
		"git commit --no-verif -m x",
		"git push --no-veri origin y",
		"git push --no-verif origin y",
		"git rebase --no-veri origin/master",
		"git merge --no-verif origin/master",
		// a bundle ending on -m/-F takes the NEXT token as its value, and a
		// later -n is still a flag
		"git commit -am x -n",
		"git commit -aF msg.txt -n",
		"git commit -mx -n", // glued message, so -n is the NEXT flag
		"git commit -au -n", // -u takes only a glued mode, so -n is a flag
		// -n means --no-verify on `git commit`, alone or bundled
		"git commit -n -m x",
		"git commit -anm x",
		"git commit -m x -n",
		// global options before the subcommand do not hide it
		"git -C /some/worktree commit --no-verify -m x",
		'git -C "/some dir" push --no-verify',
		"git -c x=y commit --no-verify -m x",
		"git -c user.name=a -C /w push --no-verify",
		// a core.hooksPath override on the command line
		"git -c core.hooksPath=/dev/null commit -m x",
		"git -c core.hookspath=/dev/null push origin y",
		"git -c core.hooksPath= commit -m x",
		"git --config-env=core.hooksPath=NOHOOKS commit -m x",
		// a core.hooksPath WRITE, in every spelling a write can take
		"git config core.hooksPath /dev/null",
		"git config --local core.hooksPath /dev/null",
		"git config --global core.hooksPath ''",
		"git config --unset core.hooksPath",
		"git config --unset-all core.hooksPath",
		"git config --add core.hooksPath /x",
		"git config set core.hooksPath /x",
		"git config unset core.hooksPath",
		"git config core.hookspath /x",
		// the bypass variables the repo's hook runner honours
		"HUSKY=0 git commit -m x",
		'HUSKY="0" git push origin y',
		"env HUSKY=0 git commit -m x",
		"PI_LENS_SKIP_HOOKS=1 git push origin y",
		"PI_LENS_SKIP_HOOKS=0 git commit -m x",
		"export HUSKY=0; git commit -m x",
		// inside a substitution, and after a chain
		'echo "$(git commit --no-verify -m x)"',
		"git add -A && git commit --no-verify -m x",
	];

	it.each(DENY)("denies %j", (command) => {
		const result = hookVerdict(command);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("hook");
		// the one-line teaching message names the sanctioned path
		expect(result.stderr).toContain("scripts/red-on-base.mjs");
		expect(result.stderr.trim().split("\n")).toHaveLength(1);
	});

	const ALLOW: string[] = [
		// -n is not a bypass outside `git commit`
		"git log -n 5",
		"head -n 5 file.txt",
		"git push -n origin y", // --dry-run, not --no-verify
		"git push --dry-run origin y",
		"git merge -n origin/master", // --no-stat
		"git diff -n",
		// flag text that is a message/body, not a flag
		'git commit -m "drop --no-verify from the runbook"',
		'git commit -m "--no-verify"',
		'git commit -m "-n"',
		// a bundle ending on -m/-F: the detached value is text (r1 F4)
		'git commit -am "-n"',
		'git commit -sm "-n"',
		'git commit -am "--no-verify"',
		"git commit -aF -n",
		"git commit --no-ver -m x", // ambiguous: git itself rejects it
		'git commit --message "--no-verify"',
		'git commit -F "-n"',
		'git commit --file "--no-verify"',
		'git merge -m "--no-verify" origin/master',
		'git merge -F "--no-verify" origin/master',
		"git commit -F msg.txt",
		"git commit -am x",
		"git commit -mn",
		"git commit -unormal -m x",
		"git commit --no-edit --amend",
		"git commit -m x -- -n",
		// heredoc, quoted PR body, --body-file: inert
		"git commit -F - <<'EOF'\nsubject\n\nmentions --no-verify and HUSKY=0\nEOF",
		"git commit -m \"$(cat <<'EOF'\nbody with git commit --no-verify\nEOF\n)\"",
		'gh pr create --title t --body "never use --no-verify or -n"',
		"gh pr create --title t --body-file PR_BODY.md",
		"gh pr edit 1 --body-file PR_BODY.md",
		"echo git commit --no-verify # a comment about it",
		"git commit -m x # --no-verify",
		// global options without a bypass
		"git -c x=y commit -m x",
		"git -C /some/worktree commit -m x",
		"git -c user.name=a push origin y",
		// core.hooksPath READS, which setup-git-hooks.mjs itself does
		"git config core.hooksPath",
		"git config --get core.hooksPath",
		"git config --local --get core.hooksPath",
		"git config get core.hooksPath",
		"git config core.hooksPath --local",
		"git config core.editor vim",
		// env that is not the bypass, or not on a hook-running git command
		"HUSKY=1 git commit -m x",
		"HUSKY=0 npm install",
		"PI_LENS_SKIP_HOOKS= git commit -m x",
		"HUSKY=0 git status",
		"echo HUSKY=0",
		"export HUSKY=0",
		// the sanctioned, recorded pre-push lock opt-out (#3717)
		"PI_LENS_PREPUSH_LOCK_SKIP=1 git push origin y",
		// subcommands the rule does not cover
		"git -c core.hooksPath=/x status",
		"git log --no-verify",
	];

	it.each(ALLOW)("allows %j", (command) => {
		const result = hookVerdict(command);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	// -<letter>n... with a value-taking letter first is a value, not `-n`.
	it.each([..."mFCctuS"])("commit -%s<value with n> is not a bypass", (l) => {
		expect(findDeny(`git commit -${l}nx`)).toBeNull();
	});

	// r1 F1: a core.hooksPath write is denied whatever the value (the repair
	// `git config core.hooksPath .husky/_` is in the maintainer's transcripts),
	// so the message must name the sanctioned repair instead.
	it("a core.hooksPath write names setup-git-hooks as the repair", () => {
		const result = runHook("git config core.hooksPath /x/.husky/_");
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("node scripts/setup-git-hooks.mjs");
	});

	it("declares hookBypass in the DenyRule union the .d.mts exports", () => {
		// Same guard as the sibling rule declarations: remove "hookBypass" from
		// the union and `npm run lint` fails with TS2322 before the suite runs.
		const rule: DenyRule = "hookBypass";
		expect(RULE_MESSAGES[rule]).toContain("red-on-base");
	});

	// Recurrence this prevents: a fourth skip variable added to a husky hook
	// that this guard never learns about (the same hand-list-mirroring-a-
	// -registry drift the repo's single-source rule names). The names are read
	// from the hooks' own `if [ -n "$NAME" ]` opt-outs and from husky's own
	// dispatcher, so a new opt-out reds here instead of shipping unguarded.
	it("denies every skip variable the repo's hook runner honours", () => {
		const names = new Set<string>();
		for (const hookFile of ["pre-commit", "pre-push"]) {
			const text = readFileSync(join(repoRoot, ".husky", hookFile), "utf8");
			for (const m of text.matchAll(/\[ -n "\$([A-Z_]+)" \]/g)) names.add(m[1]);
		}
		expect([...names]).toContain("PI_LENS_SKIP_HOOKS");
		for (const name of names)
			expect(findDeny(`${name}=1 git commit -m x`), name).toBe("hookBypass");
		const dispatcher = readFileSync(
			join(repoRoot, "node_modules", "husky", "husky"),
			"utf8",
		);
		expect(dispatcher).toContain('[ "${HUSKY-}" = "0" ] && exit 0');
		expect(findDeny("HUSKY=0 git commit -m x")).toBe("hookBypass");
	});
});

// #3787: two helpers every git rule shares. Both populations were measured
// against real bash 5.3 and git 2.53, not read from the issue:
//   - Keywords that run the NEXT word as a command: do, then, else, elif, if,
//     while, until, `!`, coproc (each created its side-effect file in a probe).
//     Excluded on purpose: case/esac/fi/done/in/select and `function f {`,
//     which run nothing at that word (a `case` arm is split off by `)`).
//   - Git globals that take a SEPARATE value token: -C, -c, --git-dir,
//     --work-tree, --namespace, --config-env, --attr-source. Excluded:
//     --exec-path (its value form is `=` only; a bare one just prints the
//     path) and --super-prefix (git 2.53 rejects it as an unknown option).
describe("scripts/hooks/guard-bash.mjs -- shell keywords and separate-token git globals (#3787)", () => {
	const KEYWORD_SHAPES: Array<[name: string, wrap: (cmd: string) => string]> = [
		["do", (c) => `for b in x; do ${c}; done`],
		["then", (c) => `if true; then ${c}; fi`],
		["else", (c) => `if false; then :; else ${c}; fi`],
		["elif", (c) => `if false; then :; elif ${c}; then :; fi`],
		["if", (c) => `if ${c}; then :; fi`],
		["while", (c) => `while ${c}; do break; done`],
		["until", (c) => `until ${c}; do break; done`],
		["bang", (c) => `! ${c}`],
		["coproc", (c) => `coproc ${c}`],
		["keyword then runner prefix", (c) => `if true; then command ${c}; fi`],
		["keyword then brace", (c) => `if true; then { ${c}; }; fi`],
	];
	const GUARDED: Array<[command: string, rule: DenyRule]> = [
		["git stash", "stash"],
		["git reset --hard", "reset"],
		["git worktree remove -f -f ../w", "worktreeForce"],
		["git push --no-verify origin y", "hookBypass"],
		["git commit -n -m x", "hookBypass"],
		["git push --force origin y", "forcePush"],
		["git rebase origin/master", "rebase"],
	];

	describe.each(KEYWORD_SHAPES)("after %s", (_name, wrap) => {
		it.each(GUARDED)("denies %j", (command, rule) => {
			expect(findDeny(wrap(command))).toBe(rule);
		});
	});

	it("denies a keyword-led hook bypass through the real hook entry", () => {
		const result = runHook("for b in x; do git push --no-verify; done");
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("scripts/red-on-base.mjs");
		expect(runHook("if true; then git commit -n; fi").status).toBe(2);
	});

	it("classifies a guarded command in a named brace-form coproc", () => {
		// Pure parser seam: neither this fixture nor the test launches Bash or
		// executes its payload.
		const command = 'coproc C { git stash; }; wait "$COPROC_PID"';
		expect(findDeny(command)).toBe("stash");
	});

	it.each([
		['coproc $USER { git stash; }; wait "$COPROC_PID"', "USER"],
		['coproc ${X:-C} { git stash; }; wait "$COPROC_PID"', "X default"],
		['coproc "$USER" { git stash; }; wait "$COPROC_PID"', "double-quoted USER"],
		['coproc $1 { git stash; }; wait "$COPROC_PID"', "positional parameter"],
		['coproc $- { git stash; }; wait "$COPROC_PID"', "shell option flags"],
		[
			"coproc $'\\x43' { git stash; }; wait \"$COPROC_PID\"",
			"ANSI-C hexadecimal escape",
		],
		[
			"coproc $'\\u43' { git stash; }; wait \"$COPROC_PID\"",
			"ANSI-C short Unicode escape",
		],
		[
			"coproc $'C\\0!' { git stash; }; wait \"$COPROC_PID\"",
			"ANSI-C NUL-truncated",
		],
		[
			"coproc $'\\x{43}' { git stash; }; wait \"$COPROC_PID\"",
			"ANSI-C braced hexadecimal escape",
		],
		['coproc $@ { git stash; }; wait "$COPROC_PID"', "positional list"],
		['coproc $* { git stash; }; wait "$COPROC_PID"', "positional star"],
		[
			'coproc "$@" { git stash; }; wait "$COPROC_PID"',
			"quoted positional list",
		],
		[
			'coproc "$*" { git stash; }; wait "$COPROC_PID"',
			"quoted positional star",
		],
		['coproc C$SUFFIX { git stash; }; wait "$COPROC_PID"', "suffix expansion"],
		["coproc $'C' { git stash; }; wait \"$COPROC_PID\"", "ANSI-C quoted label"],
		['coproc $"C" { git stash; }; wait "$COPROC_PID"', "locale-quoted label"],
		[
			'coproc "$(printf C)" { git stash; }; wait "$COPROC_PID"',
			"command substitution",
		],
		[
			'coproc "`printf C`" { git stash; }; wait "$COPROC_PID"',
			"backtick substitution",
		],
		[
			'coproc $(printf C)9 { git stash; }; wait "$COPROC_PID"',
			"unquoted command substitution with digit suffix",
		],
		[
			'coproc `printf C`9 { git stash; }; wait "$COPROC_PID"',
			"unquoted backtick substitution with digit suffix",
		],
		['coproc C$? { git stash; }; wait "$COPROC_PID"', "status suffix"],
		[
			'coproc $!A { git stash; }; wait "$COPROC_PID"',
			"nullable process suffix",
		],
		[
			'coproc C$! { git stash; }; wait "$COPROC_PID"',
			"nullable process with prefix",
		],
		['coproc C$((65)) { git stash; }; wait "$COPROC_PID"', "arithmetic suffix"],
		[
			'coproc C$[65] { git stash; }; wait "$COPROC_PID"',
			"old arithmetic suffix",
		],
	])(
		"denies git stash through the real hook for a %s coproc label",
		(command) => {
			// Review #3949 found Bash accepts expanded and special-quoted
			// optional labels, so scan their guarded bodies at the real hook.
			const result = runHook(command);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("stash");
		},
	);

	it("denies a coproc label with a dynamic prefix and digit suffix", () => {
		const result = runHook(
			'coproc ${PREFIX}1 { git stash; }; wait "$COPROC_PID"',
			{ ...BASE_ENV, PREFIX: "C" },
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("stash");
	});

	it.each([
		["if", "coproc C if git stash; then :; fi"],
		["while", "coproc C while git stash; do break; done"],
		["until", "coproc C until git stash; do break; done"],
		["a subshell", "coproc C ( git stash )"],
		["for", "coproc C for x in 1; do git stash; done"],
		["case", "coproc C case x in x) git stash;; esac"],
		["if, with an expanded label", "coproc $USER if git stash; then :; fi"],
	])(
		"denies git stash through the real hook in a named coproc before %s",
		(_body, command) => {
			// Bash takes the optional label before any compound command, not only
			// a brace group: each form ran its body in a bash 5.3 probe.
			const result = runHook(command);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain("stash");
		},
	);

	it.each(["coproc C git stash", "coproc C ! git stash"])(
		"allows %j, which bash never runs as git",
		(command) => {
			// Probed in bash 5.3: the first runs `C` (command not found), the
			// second is a syntax error.
			expect(findDeny(command)).toBeNull();
		},
	);

	it.each([
		["coproc '$USER' { git stash; }; wait \"$COPROC_PID\"", "single-quoted"],
		['coproc \\$USER { git stash; }; wait "$COPROC_PID"', "escaped"],
		[
			'coproc "$"USER { git stash; }; wait "$COPROC_PID"',
			"double-quoted dollar boundary",
		],
	])(
		"allows git stash when a coproc label has a %s literal dollar",
		(command) => {
			// Bash rejects these labels and skips the body; the hook must retain
			// quote/escape evidence instead of treating the dollar as expansion.
			const result = runHook(command);
			expect(result.status).toBe(0);
		},
	);

	it("allows a literal-dollar residue followed by an empty expansion", () => {
		const env = { ...BASE_ENV };
		delete env.SUFFIX;
		const result = runHook(
			'coproc "$"USER$SUFFIX { git stash; }; wait "$COPROC_PID"',
			env,
		);
		expect(result.status).toBe(0);
	});

	it("denies an ANSI-C escape in a coproc label without decoding it", () => {
		// Fails closed: bash rejects this label, but the hook does not decode
		// escapes, so an escaped span could spell anything.
		expect(findDeny("coproc C$'\\U00110000' { git stash; }")).toBe("stash");
	});

	it.each([
		['coproc $? { git stash; }; wait "$COPROC_PID"', "status"],
		['coproc $# { git stash; }; wait "$COPROC_PID"', "argument count"],
		['coproc $$ { git stash; }; wait "$COPROC_PID"', "process id"],
		['coproc $! { git stash; }; wait "$COPROC_PID"', "last process id"],
		['coproc $?A { git stash; }; wait "$COPROC_PID"', "status plus suffix"],
		['coproc $#A { git stash; }; wait "$COPROC_PID"', "count plus suffix"],
		['coproc $$A { git stash; }; wait "$COPROC_PID"', "pid plus suffix"],
		['coproc $[65] { git stash; }; wait "$COPROC_PID"', "old arithmetic"],
	])("allows a fixed non-identifier coproc expansion: %s", (command) => {
		expect(runHook(command).status).toBe(0);
	});

	it("accepts digits and underscores in named coproc labels", () => {
		// Bash labels permit identifier tails; keep the guard from dropping a
		// valid label when a future identifier regex mutation rejects them.
		const command = 'coproc _C9 { git stash; }; wait "$COPROC_PID"';
		expect(findDeny(command)).toBe("stash");
	});

	it.each(["!C", "C!", "$'C!'"])(
		"does not treat the invalid coproc label %j as a named brace group",
		(label) => {
			// Bash reports these as invalid identifiers and does not run the body;
			// both regex anchors must therefore remain exact.
			expect(findDeny(`coproc ${label} { git stash; }`)).toBeNull();
		},
	);

	it.each([
		["git stash --include-untracked", "stash"],
		["git commit -n -m x", "hookBypass"],
		["git push --force origin main", "forcePush"],
	] as const)("keeps git arguments in named coproc groups: %s", (git, rule) => {
		expect(findDeny(`coproc C { ${git}; }`)).toBe(rule);
	});

	it.each([
		["git stash --include-untracked", "stash"],
		["git commit -n -m x", "hookBypass"],
		["git push --force origin main", "forcePush"],
	] as const)(
		"keeps git arguments in unnamed coproc groups: %s",
		(git, rule) => {
			expect(findDeny(`coproc { ${git}; }`)).toBe(rule);
		},
	);

	it.each([
		["git stash '{'", "stash"],
		["git commit -n '{'", "hookBypass"],
		["git push --force '{'", "forcePush"],
	] as const)(
		"does not treat a quoted brace argument as coproc syntax: %s",
		(git, rule) => {
			expect(findDeny(git)).toBe(rule);
		},
	);

	// #3787 mutation follow-up: braces group commands but do not gate a
	// failed check; excluding every keyword must not also exclude `{`.
	it.each(["git commit -m x", "git push"])(
		"denies an ungated %s after a brace-led check",
		(write) => {
			expect(findDeny(`{ npm test; }; ${write}`)).toBe("checkUngated");
			expect(findDeny(`{ npm test && ${write}; }`)).toBeNull();
		},
	);

	const GLOBAL_FLAGS: string[] = [
		"--git-dir x",
		"--work-tree x",
		"--namespace x",
		"--config-env k=V",
		"--attr-source HEAD",
		"-C x --git-dir y --work-tree z",
	];

	describe.each(GLOBAL_FLAGS)("after the global %s", (flags) => {
		it.each(GUARDED)("denies %j", (command, rule) => {
			const [, ...rest] = command.split(" ");
			expect(findDeny(`git ${flags} ${rest.join(" ")}`)).toBe(rule);
		});
	});

	// The other direction: a global that takes NO separate value must not
	// swallow the subcommand after it.
	it.each([
		"--no-pager",
		"--bare",
		"-p",
		"--literal-pathspecs",
		"--exec-path=/x",
		"--git-dir=x",
	])("a valueless global %s does not hide the subcommand", (flag) => {
		expect(findDeny(`git ${flag} stash`)).toBe("stash");
	});

	it("sees core.hooksPath given as a separate --config-env value", () => {
		expect(
			findDeny("git --config-env core.hooksPath=NOHOOKS commit -m x"),
		).toBe("hookBypass");
		expect(
			findDeny("git --config-env core.hooksPath=NOHOOKS push origin y"),
		).toBe("hookBypass");
		expect(
			findDeny(
				"for b in x; do git --git-dir x --config-env core.hooksPath=H commit; done",
			),
		).toBe("hookBypass");
	});

	const ALLOW: string[] = [
		// the keyword word as an argument, not a command word
		"echo then git stash",
		"echo do; git status",
		'grep -n "then git stash" notes.txt',
		"printf '%s' else",
		// keyword-led commands that are not guarded
		"for b in x; do git status; done",
		"if true; then git log -n 5; fi",
		"if git diff --quiet; then git commit -m x; fi",
		"while git fetch origin; do break; done",
		"! git diff --quiet",
		"for b in x; do git push origin y; done",
		'if true; then git commit -m "mentions --no-verify and -n"; fi',
		"for b in x; do git reset --mixed HEAD; done",
		"for b in x; do git worktree remove -f ../w; done",
		// a loop or branch that gates on a check stays a gate for the chain
		// scan (#3471): the keyword word is not itself a check segment
		"if ! npm test; then exit 1; fi; git commit -m x",
		"if npm test; then echo ok; fi; git commit -m x",
		"while ! npm test; do sleep 1; done; git push",
		"until npm test; do sleep 1; done && git commit -m x",
		// a separate global's value that spells a guarded subcommand
		"git --git-dir stash status",
		"git --work-tree stash status",
		"git --namespace stash log",
		"git --config-env user.name=stash status",
		"git --attr-source stash status",
		// global options that are not a bypass
		"git --git-dir x commit -m x",
		"git --work-tree x push origin y",
		"git --namespace ns push origin y",
		"git --config-env user.name=NAME commit -m x",
		'git --git-dir x commit -m "--no-verify"',
		"git --git-dir=x --work-tree=y status",
		"git --no-pager log -n 5",
		"git --config-env core.hooksPath=H status",
	];

	it.each(ALLOW)("allows %j through the real hook entry", (command) => {
		const result = runHook(command);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("still does not claim sh -c, eval, xargs or nice/timeout/env -i prefixes", () => {
		expect(findDeny("sh -c 'git stash'")).toBeNull();
		expect(findDeny('eval "git stash"')).toBeNull();
		expect(findDeny("echo x | xargs git stash")).toBeNull();
		expect(findDeny("nice -n 10 git stash")).toBeNull();
		expect(findDeny("timeout 30 git stash")).toBeNull();
		expect(findDeny("env -i git stash")).toBeNull();
		expect(findDeny("GIT_CONFIG_KEY_0=core.hooksPath git commit")).toBeNull();
	});

	it("reads a plain ANSI-C quoted command word but decodes no escape", () => {
		expect(findDeny("$'git' stash")).toBe("stash");
		expect(findDeny("$'\\x67it' stash")).toBeNull();
	});
});

describe("scripts/hooks/guard-bash.mjs -- branch history guard (#3888)", () => {
	it("teaches merge-over-rebase and explicit lease authorization", () => {
		const rebase = runHook("git rebase origin/master");
		expect(rebase.status).toBe(2);
		expect(rebase.stderr).toContain("merge `origin/master`");
		const force = runHook("git push --force origin branch");
		expect(force.status).toBe(2);
		expect(force.stderr).toContain("explicit orchestrator authorization");
	});

	it("declares the new rules in the typed export", () => {
		const force: DenyRule = "forcePush";
		const rebase: DenyRule = "rebase";
		expect(RULE_MESSAGES[force]).toContain("origin/master");
		expect(RULE_MESSAGES[rebase]).toContain("origin/master");
	});
});

// #4348: agent writes under /tmp. Recurrence: on 2026-10-13 two Haiku
// investigators wrote an error file to /tmp and deleted it, and a Haiku helper
// wrote gh output there; `tmpCheckout` (#3526) only covers checkouts and
// mktemp directories, so redirects, tee and file writes passed. /tmp on the
// maintainer host is tmpfs (RAM + swap). Every row below is a command from that
// family or a lookalike the rule must leave alone.
describe("scripts/hooks/guard-bash.mjs -- writes under /tmp (#4348)", () => {
	const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
	const NO_AMBIENT_TMPDIR_ENV: NodeJS.ProcessEnv = Object.fromEntries(
		Object.entries(BASE_ENV).filter(
			([key]) => !["TMPDIR", "TMP", "TEMP"].includes(key),
		),
	);
	const deny = (command: string) => findDeny(command, PAYLOAD_CWD);

	// Recurrence: the redirect branch (`>`, `>>`, `2>`, `&>`, `>&file`) missing
	// or limited to a space-separated target -- the Haiku error file was
	// `2> /tmp/err.txt`, and `echo hi>/tmp/x` has no space at all.
	it.each([
		"echo hi > /tmp/x",
		"echo hi >/tmp/x",
		"echo hi>/tmp/x",
		"echo hi >> /tmp/x",
		"gh pr view 1 2> /tmp/err.txt",
		"gh pr view 1 2>/tmp/err.txt",
		"gh pr view 1 2>>/tmp/err.txt",
		"gh pr view 1 &> /tmp/out",
		"gh pr view 1 &>> /tmp/out",
		"gh pr view 1 >& /tmp/out",
		"gh pr view 1 2>&1 > /tmp/out",
		"> /tmp/x",
		"> /tmp/x echo hi",
		'echo "a">/tmp/x',
		"echo a > /tmp/../tmp/x",
		"cat <<EOF > /tmp/x\nbody\nEOF",
		"cd /tmp && echo x > y",
		"S=/tmp/scratch; echo a > $S/out",
	])("denies the redirect %j", (command) => {
		expect(deny(command)).toBe("tmpWrite");
	});

	// Recurrence: `tee` as the stdout-to-file spelling a redirect-only rule
	// misses; every operand is a file, not only the first.
	it.each([
		"echo a | tee /tmp/x",
		"echo a | tee -a /tmp/x",
		"echo a | tee ./ok /tmp/y",
		"echo a | sudo tee /tmp/x",
	])("denies tee: %j", (command) => {
		expect(deny(command)).toBe("tmpWrite");
	});

	// Recurrence: a cp/mv rule that judged the FIRST operand (the source) or
	// ignored `-t DIR`, which names the destination before the sources.
	it.each([
		"cp a /tmp/b",
		"cp -r a b /tmp/",
		"mv a /tmp/b",
		"cp -t /tmp a b",
		"cp --target-directory=/tmp a",
		"cp --target-directory /tmp a",
		"cp -rt /tmp a",
		"cp -t/tmp a",
		"mv -t /tmp a",
		"install a /tmp/b",
		"install -m 755 a /tmp/b",
		"install -d /tmp/a /home/dev/b",
	])("denies the cp/mv/install target %j", (command) => {
		expect(deny(command)).toBe("tmpWrite");
	});

	// Recurrence: mkdir/touch judged by the last operand only, or `-m 755`'s
	// value read as the directory.
	it.each([
		"mkdir /tmp/a",
		"mkdir -p /tmp/a/b",
		"mkdir -m 755 /tmp/a",
		"mkdir ./ok /tmp/a",
		"touch /tmp/a",
		"touch -d yesterday /tmp/a",
	])("denies mkdir/touch: %j", (command) => {
		expect(deny(command)).toBe("tmpWrite");
	});

	// Recurrence: the rule widening into reads ("reads that /tmp cannot
	// serve"): /tmp as a source, an input redirect, a listing or a delete must
	// stay allowed.
	it.each([
		"cat /tmp/x",
		"cat < /tmp/x",
		"cp /tmp/x ./y",
		"cp /tmp/x /tmp/y ./dir",
		"cp -t ./dir /tmp/x",
		"mv /tmp/x ./y",
		"install /tmp/x ./y",
		"touch -r /tmp/ref ./x",
		"mkdir -m 755 ./a",
		"grep -r foo /tmp",
		"ls /tmp",
		"rm -rf /tmp/x",
	])("allows the read or non-/tmp write %j", (command) => {
		expect(deny(command)).toBeNull();
	});

	// Recurrence: a prefix match on "/tmp" (`/tmpfoo`) or a relative `tmp/`.
	it.each([
		"echo a > /tmpfoo/x",
		"echo a > ./tmp/x",
		"echo a > tmp/x",
		"echo a > /home/dev/tmp/x",
		"mkdir -p /home/dev/tmp/x",
		"cp a /var/tmp-not/b",
	])("does not treat %j as /tmp", (command) => {
		expect(deny(command)).toBeNull();
	});

	// Recurrence (principles §2, "Detectors match code, not prose"): a quoted
	// string, a comment, an escaped `>` or a heredoc body that merely spells a
	// write must never deny.
	it.each([
		'echo "> /tmp/x"',
		"echo '> /tmp/x'",
		'echo ">/tmp/x"',
		"echo '>/tmp/x'",
		'echo ">" /tmp/x',
		"echo \\>/tmp/x",
		'echo "cp a /tmp/b"',
		"echo \\> /tmp/x",
		"echo a # > /tmp/x",
		"grep '>' /tmp/x",
		"cat <<'EOF'\n> /tmp/x\ncp a /tmp/b\ntee /tmp/c\nEOF",
		"cat <<EOF\n> /tmp/x\nmkdir /tmp/y\nEOF",
		"git commit -m 'write > /tmp/x with tee /tmp/y'",
	])("a /tmp write spelled as text never denies: %j", (command) => {
		expect(deny(command)).toBeNull();
	});

	// Recurrence: `2>&1`, `>&2` and `>&-` read as redirects into a file named
	// `1`/`2`/`-`, or into whatever follows them.
	it.each([
		"gh pr view 1 >/dev/null 2>&1",
		"gh pr view 1 2>&1",
		"echo hi >&2",
		"echo hi 2>&-",
		"echo hi >&2 /tmp/not-a-target",
	])("a descriptor duplicate writes no file: %j", (command) => {
		expect(deny(command)).toBeNull();
	});

	// Recurrence: a `>`/`>>` with its target attached takes the NEXT word (the
	// command's own argument, here a /tmp READ) as its target too.
	it.each([
		"cat >out.txt /tmp/in",
		"cat >>out.txt /tmp/in",
		"sort 2>>err /tmp/in",
	])(
		"an attached redirect target does not borrow the next word: %j",
		(command) => {
			expect(deny(command)).toBeNull();
		},
	);

	// Recurrence: a descriptor duplicate read as a file NAMED `1`/`2`/`-` --
	// only visible when the cwd is itself under /tmp, where a relative file is
	// a /tmp file. A real redirect there still denies.
	it("a descriptor duplicate is not a relative file even when the cwd is under /tmp", () => {
		const underTmp = "/tmp/pi-lens-guard-bash-4348-cwd-fixture";
		for (const command of ["cmd 2>&1", "echo hi >&2", "echo hi >&-"])
			expect(findDeny(command, underTmp), command).toBeNull();
		expect(findDeny("echo hi > out.txt", underTmp)).toBe("tmpWrite");
	});

	// The acceptance's exemption: the harness's own session directory. Another
	// uid's directory is not the harness's, and `..` out of it lands in /tmp.
	it("exempts /tmp/claude-<uid>/ and nothing beside it", () => {
		expect(deny(`echo a > /tmp/claude-${uid}/scratch/x`)).toBeNull();
		expect(deny(`mkdir -p /tmp/claude-${uid}/scratch`)).toBeNull();
		expect(deny(`cp a /tmp/claude-${uid}/scratch/b`)).toBeNull();
		expect(deny(`echo a | tee /tmp/claude-${uid}/x`)).toBeNull();
		expect(deny(`echo a > /tmp/claude-${uid + 1}/x`)).toBe("tmpWrite");
		expect(deny(`echo a > /tmp/claude-${uid}/../x`)).toBe("tmpWrite");
		expect(deny(`echo a > /tmp/claude-${uid}x/x`)).toBe("tmpWrite");
	});

	// Recurrence: guessing $TMPDIR. It is expanded by the same resolver as
	// every other path rule: the shell's value (command text, then the hook's
	// own environment), and /tmp only when neither sets it. A lane pinned off
	// /tmp writes $TMPDIR freely; an unset or /tmp-pointing one does not.
	describe("$TMPDIR", () => {
		const lane = "/home/dev/lane-tmp";
		it.each(["echo a > $TMPDIR/x", "echo a > ${TMPDIR}/x", "mkdir $TMPDIR/d"])(
			"%j follows the ambient TMPDIR",
			(command) => {
				expect(runHook(command, { ...BASE_ENV, TMPDIR: lane }).status).toBe(0);
				expect(
					runHook(command, { ...BASE_ENV, TMPDIR: "/tmp/pi-lens-x" }).stderr,
				).toBe(`${RULE_MESSAGES.tmpWrite}\n`);
				expect(runHook(command, { ...BASE_ENV, TMPDIR: "/tmp" }).stderr).toBe(
					`${RULE_MESSAGES.tmpWrite}\n`,
				);
			},
		);

		// Recurrence (review r1, 93,532 real commands): `> $TMPDIR/ci.txt` in a
		// shell where TMPDIR was never exported. Bash expands the unset variable
		// to the empty string -- the real write was `/ci.txt` ("Permission
		// denied") -- so `/tmp` is mktemp's default, not the shell's. The hook's
		// unresolved-expansion contract is to fail open; the rule must not
		// invent /tmp for TMPDIR, TMP or TEMP.
		it.each([
			"echo a > $TMPDIR/x",
			"echo a > ${TMPDIR}/x",
			'echo a > "$TMPDIR/x"',
			"mkdir -p $TMPDIR/d",
			"echo a | tee $TMPDIR/x",
			"cp a $TMP/x",
			"touch $TEMP/x",
		])("%j with TMPDIR unset everywhere fails open", (command) => {
			const result = runHook(command, NO_AMBIENT_TMPDIR_ENV);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
		});

		it("an unset TMP does not hide a TMPDIR that points at /tmp", () => {
			expect(
				runHook("cp a $TMPDIR/x", { ...NO_AMBIENT_TMPDIR_ENV, TMPDIR: "/tmp" })
					.stderr,
			).toBe(`${RULE_MESSAGES.tmpWrite}\n`);
		});

		it("an assignment earlier in the command wins over the ambient value", () => {
			expect(
				runHook("TMPDIR=/tmp/y; echo a > $TMPDIR/x", {
					...BASE_ENV,
					TMPDIR: lane,
				}).stderr,
			).toBe(`${RULE_MESSAGES.tmpWrite}\n`);
		});

		// bash expands the redirect word before the inline `TMPDIR=` applies to
		// the command (the #3997 rule for git's path words).
		it("an inline TMPDIR= does not move the redirect target", () => {
			expect(
				runHook("TMPDIR=/tmp/y echo a > $TMPDIR/x", {
					...BASE_ENV,
					TMPDIR: lane,
				}).status,
			).toBe(0);
		});
	});

	it("denies through the real hook with the rule's teaching message on stderr", () => {
		const result = runHook("echo hi > /tmp/x");
		expect(result.status).toBe(2);
		expect(result.stderr).toBe(`${RULE_MESSAGES.tmpWrite}\n`);
		expect(RULE_MESSAGES.tmpWrite).toContain("/tmp");
		const allowed = runHook(`echo hi > /tmp/claude-${uid}/x`);
		expect(allowed.status).toBe(0);
		expect(allowed.stderr).toBe("");
	});

	// Named limits, pinned so each is a visible decision rather than an
	// untested docblock claim. Every one is a write this static scan does not
	// follow (see the PR body "Limits"); none is promised denied.
	it.each([
		"dd if=/dev/zero of=/tmp/x count=1",
		"echo a >| /tmp/x",
		"export A=1 > /tmp/x",
		"bash -c 'echo a > /tmp/x'",
		"sh -c 'cp a /tmp/b'",
		"echo a | xargs -I{} touch /tmp/{}",
		"find . -name x -exec cp {} /tmp/ ;",
		"curl -o /tmp/x https://example.com",
		"sed -i s/a/b/ /tmp/x",
		"awk '{print > \"/tmp/x\"}' f",
		"cp --target=/tmp a",
		"echo a > ${TMPDIR:-/tmp}/x",
		"echo a > /private/tmp/x",
	])("limit: %j is not judged", (command) => {
		expect(deny(command)).toBeNull();
	});
});

// #5111: `git stash` is an ADMIT list, not a deny list. Recurrence: 41 of 43
// stash refusals in 14 days of transcripts (#3995 slice B) were the read-only
// `git stash list`. Only `list` and `show` (with read-only flags and, for
// `show`, one `stash@{N}`) pass; every other form, including a spelling the
// scan cannot classify, stays denied (principles: gates fail closed).
const STASH_ADMITTED: string[] = [
	"git stash list",
	"git stash show",
	"git stash list --oneline",
	"git stash list --stat",
	"git stash list --format=%gd:%s",
	'git stash list --pretty="%gd %s"',
	"git stash show --stat",
	"git stash show -p",
	"git stash show --name-only stash@{1}",
	"git stash show stash@{0}",
	"git stash show 2",
	"git -C /home/dev/wt stash list",
	"git -C /home/dev/a -C b stash show",
	"git -C ~/wt stash list",
	"git -C ../wt-1.2_x@y stash show",
	"git stash list | head -5",
	"git stash list 2>&1",
	"git stash list 2>/dev/null",
	"git stash show -p >/dev/null 2>&1",
	"git stash list --format=%gd; git status",
	"git stash list && git status",
	"cd /home/dev/wt && git stash list",
	"git stash 'list'",
	'git "stash" list',
];

const STASH_STILL_DENIED: string[] = [
	// every writing subcommand, and the bare form (= push)
	"git stash",
	"git stash push",
	"git stash push -m list",
	"git stash save wip",
	"git stash pop",
	"git stash apply",
	"git stash drop",
	"git stash clear",
	"git stash create",
	"git stash store abc123",
	"git stash branch newbranch",
	"git stash -u",
	"git stash -m list",
	"git stash --include-untracked",
	// spellings of list/show git does not take as the subcommand
	"git stash li",
	"git stash LIST",
	"git stash list-all",
	// extra operands and flags outside the admitted set
	"git stash list drop",
	"git stash list stash@{0}",
	"git stash list --output=/home/dev/x",
	"git stash list -- drop",
	"git stash show drop",
	"git stash show -p drop",
	"git stash show stash@{0} drop",
	"git stash show stash@{0} stash@{1}",
	"git stash show --ext-diff",
	"git stash show --output=/home/dev/x",
	"git stash show --format=$X",
	"git stash show --format=$(echo %gd)",
	"git stash list --format='%gd' '--output=/home/dev/x'",
	"git stash list > /home/dev/out",
	"git stash list 2>/home/dev/out",
	"git stash list >/dev/nullx",
	"git stash list >>/dev/null",
	"git stash 2>&1 list",
	// global options before the subcommand (-c config, aliases, git-dir)
	"git -c core.pager=sh stash list",
	"git -c alias.stash=push stash list",
	"git --git-dir=/home/dev/g stash list",
	"git --no-pager stash list",
	"git --exec-path=/home/dev/x stash show",
	"git -C /home/dev/wt -c user.name=a stash list",
	// PR #5115 Greptile G1: the -C VALUE is part of the words bash hands git, so
	// a value the scan cannot read as one plain path is a refusal (bash runs
	// `git -C . stash save stash list` for the first row).
	'git -C $(printf ". stash save") stash list',
	"git -C `echo .` stash list",
	'git -C "$X" stash list',
	"git -C $X stash list",
	"git -C ${X} stash list",
	"git -C '. stash save' stash list",
	"git -C a\\ b stash list",
	"git -C {.,.} stash list",
	"git -C * stash list",
	"git -C ? stash list",
	"git -C [a] stash list",
	"git -C -c stash list",
	"git -c a=$(echo x) stash list",
	// PR #5115 verify r4: the lexer splits a segment at `<(`/`>(`, so the words
	// after a process substitution before the subcommand are never classified
	// (bash runs `git -C /dev/fd/63 stash drop`). A git segment that ends
	// before its subcommand on a dangling `<`/`>` is refused.
	"git -C <(true) stash drop",
	"git -C >(true) stash drop",
	"git <(true) stash drop",
	"git -C . <(true) stash pop",
	// env, inline or exported earlier in the command
	"FOO=1 git stash list",
	"GIT_EXTERNAL_DIFF=/home/dev/x git stash show -p",
	"export GIT_PAGER=sh; git stash list",
	"env GIT_PAGER=sh git stash list",
	// substitutions and expansions the scan cannot resolve
	"git stash $(echo drop)",
	"git stash `echo drop`",
	'git stash "$(echo drop)"',
	"git stash $(:) list",
	"git stash list $(echo drop)",
	"git stash list `echo drop`",
	"git stash list $X",
	"git stash $X",
	"git stash {list,drop}",
	"git stash l*",
	"git stash show $'\\x64rop'",
	// quoted spellings that resolve to something else
	'git "stash" drop',
	"git stash 'drop'",
	'git stash "pu""sh"',
	'git stash "list drop"',
	// a writing stash chained after an admitted one
	"git stash list && git stash drop",
	"git stash list; git stash pop",
	"git stash list | git stash apply",
	"echo $(git stash drop)",
];

describe("scripts/hooks/guard-bash.mjs -- stash admit list (#5111)", () => {
	it.each(STASH_ADMITTED)("admits %j", (command) => {
		const result = hookVerdict(command);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});

	it.each(STASH_STILL_DENIED)("still denies %j", (command) => {
		const result = hookVerdict(command);
		expect(result.stderr).toBe(`${RULE_MESSAGES.stash}\n`);
		expect(result.status).toBe(2);
	});

	// #5111: every worktree-remove refusal names the helper, so an agent no
	// longer answers with an `rm` and a retry (215 refusals in 14 days).
	it.each(["worktreeSymlink", "worktreeUnresolved", "worktreeForce"] as const)(
		"%s refusal names scripts/worktree-remove.mjs",
		(rule) => {
			expect(RULE_MESSAGES[rule]).toContain("scripts/worktree-remove.mjs");
		},
	);

	it("names the admitted read-only forms in the refusal", () => {
		expect(RULE_MESSAGES.stash).toContain("git stash list");
		expect(RULE_MESSAGES.stash).toContain("git stash show");
	});
});
