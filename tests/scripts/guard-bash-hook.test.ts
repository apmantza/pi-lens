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
	splitTopLevel,
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

	it("splitTopLevel collects $() and backtick subshell bodies for recursive scanning", () => {
		const { segments, subshells } = splitTopLevel(
			"echo $(git stash) `git log`",
		);
		expect(segments).toHaveLength(1);
		expect(subshells).toEqual(["git stash", "git log"]);
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

	it("(review round 2 F1) drops a heredoc body verbatim -- its backtick span is never collected as a subshell", () => {
		const { segments, subshells } = splitTopLevel(
			"cat <<'EOF'\nmentions `git stash` here\nEOF",
		);
		expect(subshells).toEqual([]);
		// The command's own text ("cat <<'EOF'") survives; the body does not.
		expect(segments.join(" ")).not.toContain("git stash");
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
