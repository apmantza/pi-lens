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
	['node -e "require(\'./clients/foo.js\')"', "probe"],
	['node --eval "clients/foo.js reference"', "probe"],
	['node --input-type=module -e "import(\'./clients/foo.js\')"', "probe"],
	['node -p "require(\'./clients/foo.js\')"', "probe"],
	["node clients/probe.mjs", "probe"],
	["node dist/probe.js", "probe"],
	['nodejs -e "clients/foo.js reference"', "probe"],
	// nested inside a subshell -- the tokenizer must recurse into $()/backticks.
	["echo $(git stash)", "stash"],
	["echo `git stash`", "stash"],
	// a non-PI_LENS_HOME env assignment must not defeat env-assignment
	// stripping -- the command word search must still land on "node".
	["FOO=bar node -e \"require('./clients/foo.js')\"", "probe"],
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
	'PI_LENS_HOME=/x node -e "...clients/..."',
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
	// $(...) fully inside single quotes is literal text to bash (no
	// expansion), so the tokenizer must not extract it as a subshell.
	"echo '$(git stash)'",
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
		const result = runHook('node -e "require(\'./clients/foo.js\')"', {
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
		const { env, rest } = stripEnvAssignments(["FOO=bar", "BAZ=qux", "git", "stash"]);
		expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
		expect(rest).toEqual(["git", "stash"]);
	});

	it("splitTopLevel collects $() and backtick subshell bodies for recursive scanning", () => {
		const { segments, subshells } = splitTopLevel("echo $(git stash) `git log`");
		expect(segments).toHaveLength(1);
		expect(subshells).toEqual(["git stash", "git log"]);
	});

	it("classifyPayload allows a Read tool call carrying a denied-looking command field", () => {
		expect(
			classifyPayload({ tool_name: "Read", tool_input: { command: "git stash" } }),
		).toBeNull();
	});

	it("splitWords fuses a quoted span into one opaque word", () => {
		expect(splitWords('echo "git stash"')).toEqual(["echo", "git stash"]);
	});
});
