// flake-shape: real-process-spawn — the subject IS the guard's own
// stdin/exit-code/stderr contract (what Claude Code's PreToolUse dispatch
// actually invokes); an in-process call to the exported classify functions
// cannot see a drift in that contract. Admitted in vitest.config.ts's
// wallClockBudgetInclude.
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
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	classifyPayload,
	findDeny,
	scannableRegions,
	splitSegments,
	splitWords,
	stripEnvAssignments,
} from "../../scripts/hooks/guard-bash.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const HOOK = join(repoRoot, "scripts", "hooks", "guard-bash.mjs");

// Every env var this suite's own process runs under, MINUS PI_LENS_HOME --
// so a negative (deny) case can never pass because the outer test runner
// happens to have PI_LENS_HOME set (probe hygiene: this repo's own worktree
// convention sets it for ad-hoc probes), and a positive (PI_LENS_HOME
// ambient) case sets it back deliberately.
const BASE_ENV: NodeJS.ProcessEnv = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => key !== "PI_LENS_HOME"),
);

function runHook(command: string, env: NodeJS.ProcessEnv = BASE_ENV) {
	return spawnSync(process.execPath, [HOOK], {
		input: JSON.stringify({
			session_id: "test",
			cwd: repoRoot,
			permission_mode: "default",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command },
		}),
		encoding: "utf8",
		env,
	});
}

// Every deny string the issue lists, with the rule keyword its message must
// name (the acceptance criterion: "assert exit code AND the message names
// the rule").
const DENY_CASES: Array<[command: string, ruleNeedle: string]> = [
	["git stash", "stash"],
	["git stash list", "stash"],
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
];

// Every allow string the issue lists, which must stay green.
const ALLOW_CASES: string[] = [
	"git diff > fix.patch",
	"git checkout HEAD -- x",
	"git worktree remove -f /tmp/tree",
	"git worktree remove --force /tmp/tree",
	"git reset HEAD~1",
	"git log --grep=stash",
	'echo "git stash"',
	"PI_LENS_HOME=/x node -e \"require('./clients/foo.js')\"",
	"node scripts/ci-verdict.mjs 1",
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
	"git worktree add /tmp/new-tree -f -f",
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
];

describe("scripts/hooks/guard-bash.mjs -- deny list (#2699)", () => {
	it.each(DENY_CASES)("denies %j", (command, ruleNeedle) => {
		const result = runHook(command);
		expect(result.status).toBe(2);
		expect(result.stderr.toLowerCase()).toContain(ruleNeedle);
	});
});

describe("scripts/hooks/guard-bash.mjs -- allow list (#2699)", () => {
	it.each(ALLOW_CASES)("allows %j", (command) => {
		const result = runHook(command);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
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
	});
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
		expect(scannableRegions("echo $(git stash) `git log`")).toEqual([
			"echo  ",
			"git stash",
			"git log",
		]);
		// Flattened at ANY depth -- round 2 recursed with a depth cap of 8,
		// which silently ALLOWED anything nested deeper.
		expect(scannableRegions("echo $(echo $(echo $(git stash)))")).toEqual([
			"echo ",
			"git stash",
			"echo ",
			"echo ",
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
		// 11 rows × 5 columns, plus 6 same-cell discriminators (LX-2-5b,
		// LX-2-5c, LX-3-1b, LX-5-1b, LX-9-1b, LX-10-1b) that each pin a
		// second behaviour of their own cell.
		expect(ids).toHaveLength(61);
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
});
