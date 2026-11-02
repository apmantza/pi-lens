import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { isAdvisoryCheck } from "../../scripts/lib/ci-checks.mjs";
import {
	commandBasename,
	hasLiveStdinRedirect,
	stripCommandGroupAndRunnerPrefixes,
	scannableRegions,
	splitSegmentsWithSeparators,
	splitWords,
	stripEnvAssignments,
} from "../../scripts/hooks/guard-bash.mjs";
import { assertNonEmptyScan, stripSource } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

type Step = { uses?: unknown; run?: unknown; env?: unknown; with?: unknown };
type Job = {
	name?: string;
	if?: string;
	env?: unknown;
	steps?: unknown;
};
type Workflow = {
	on?: { pull_request?: unknown; pull_request_target?: unknown };
	env?: unknown;
	jobs?: Record<string, Job>;
};

function load(path: string): { workflow: Workflow; source: string } {
	const source = readFileSync(path, "utf8");
	return { workflow: yaml.load(source) as Workflow, source };
}

function jobSource(source: string, jobName: string): string {
	const stripped = stripSource(source, { strings: "blank" });
	const rawLines = source.split("\n");
	const lines = stripped.split("\n");
	const start = rawLines.findIndex((line) => line === `  ${jobName}:`);
	if (start < 0) throw new Error(`job ${jobName} not found`);
	const end = rawLines.findIndex(
		(line, index) => index > start && /^  [A-Za-z0-9_-]+:/.test(line),
	);
	return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function isActiveOnPullRequest(job: Job): boolean {
	return !job.if?.includes("github.event.workflow_run.");
}

function writesWithToken(jobText: string): boolean {
	return (
		/\bgh\s+(?:pr|issue)\s+(?:edit|comment|merge)\b/.test(jobText) ||
		/\bgh\s+api\b[\s\S]*?(?:-X|--method)\s+(?:POST|PATCH|PUT|DELETE)\b/.test(
			jobText,
		) ||
		/\bcurl\b[\s\S]*?(?:--request|-X)\s+(?:POST|PATCH|PUT|DELETE)\b/.test(
			jobText,
		) ||
		/\bcheck-close-keywords\.mjs\s+--verify-merged\b/.test(jobText) ||
		/\buses:\s*actions\/github-script@[^\s]+[\s\S]*?\bgithub\.rest\.(?:issues|pulls)\.(?:create|createComment|update|updateComment|delete|deleteComment|addLabels|removeLabel|addAssignees|removeAssignees|setLabels)\b/.test(
			jobText,
		)
	);
}

describe("fork-capped workflow token writes (#2993)", () => {
	it("guards or advisory-lists every active pull_request token write", () => {
		// Recurrence #2993: a fork pull_request receives a read-only token, so a
		// metadata write can fail and block the merge gate. Scan stripped source
		// so comments and quoted examples cannot launder a write or its guard.
		const findings: string[] = [];
		for (const name of readdirSync(WORKFLOWS)) {
			if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
			const path = resolve(WORKFLOWS, name);
			const { workflow, source } = load(path);
			if (!workflow.on?.pull_request) continue;
			for (const [key, job] of Object.entries(workflow.jobs ?? {})) {
				if (
					!isActiveOnPullRequest(job) ||
					!writesWithToken(jobSource(source, key))
				) {
					continue;
				}
				const displayName = job.name ?? key;
				const guarded = job.if?.includes(
					"github.event.pull_request.head.repo.full_name == github.repository",
				);
				if (
					!guarded &&
					!isAdvisoryCheck(displayName) &&
					!isAdvisoryCheck(key)
				) {
					findings.push(`${name}:${key} (${displayName})`);
				}
			}
		}
		expect(findings, "fork-capped token writes must be contained").toEqual([]);
	});

	it("rejects a same-shaped write without a fork guard or advisory name", () => {
		// Reject twin: the nearest wrong shape must remain visible to prevent a
		// comment-only guard or an unrelated advisory entry from clearing it.
		const source = `  dangerous:\n    name: Dangerous\n    if: github.event_name == 'pull_request'\n    run: gh pr edit 123 --remove-label x`;
		const job = {
			name: "Dangerous",
			if: "github.event_name == 'pull_request'",
		};
		expect(writesWithToken(jobSource(source, "dangerous"))).toBe(true);
		expect(job.if).not.toContain("head.repo.full_name == github.repository");
		expect(isAdvisoryCheck(job.name)).toBe(false);
	});

	it("detects github-script REST writes after source blanking", () => {
		const source = `  mutator:
    name: Mutator
    uses: actions/github-script@v7
    with:
      script: |
        await github.rest.issues.createComment({ issue_number: 1 });`;
		expect(writesWithToken(jobSource(source, "mutator"))).toBe(true);
	});

	it("does not classify github-script REST reads as writes", () => {
		const source = `  reader:
    name: Reader
    uses: actions/github-script@v7
    with:
      script: |
        await github.rest.issues.get({ issue_number: 1 });`;
		expect(writesWithToken(jobSource(source, "reader"))).toBe(false);
	});

	it("detects curl short-form write methods", () => {
		const source = `  mutator:
    name: Mutator
    run: curl -X PATCH https://api.github.com/repos/example/repo/issues/1`;
		expect(writesWithToken(jobSource(source, "mutator"))).toBe(true);
	});

	it("keeps greeting outside the fork-capped population", () => {
		const { workflow } = load(resolve(WORKFLOWS, "greetings.yml"));
		expect(workflow.on?.pull_request).toBeUndefined();
		expect(isAdvisoryCheck("greeting")).toBe(true);
	});

	it("skips cleanup when the synchronize PR head is a fork", () => {
		const { workflow } = load(resolve(WORKFLOWS, "ci-verdict-labels.yml"));
		expect(workflow.jobs?.["clear-stale-verdict-labels"]?.if).toContain(
			"github.event.pull_request.head.repo.full_name == github.repository",
		);
	});

	it("runs merged-PR comment verification on the uncapped target trigger", () => {
		const { workflow } = load(
			resolve(WORKFLOWS, "close-keyword-verification.yml"),
		);
		expect(workflow.on?.pull_request_target).toBeDefined();
	});
});

// A `gh` call resolves its repository from one of three sources: `GH_REPO` (at
// workflow, job or step scope), the checkout's git remote, or its own
// `-R`/`--repo` (for `gh api`, the repository in the request path). A call that
// offers none dies where it writes, with
// `failed to run git: fatal: not a git repository`.
//
// #4382 named that on the push lane, where the fix removed the wrong PR number.
// Its PR-lane sibling stayed: `finalize-rerun` has no checkout and no `GH_REPO`,
// so run 38956598286 (2026-10-16, attempt 2 green) failed in "Swap terminal
// rerun labels" and the terminal verdict label was never swapped. Six of six
// runs that reached that write failed the same way, the first on 2026-10-10
// (run 38459454960), so the defect predates #4386 and is not a regression of it.
//
// The census derives its population from shell STRUCTURE, not from a regex over
// job text (AGENTS.md shape 69: an enumerated spelling list passes every
// spelling it does not know). Each `run:` script is lexed by the shared shell
// lexer `scripts/hooks/guard-bash.mjs` exports -- the one the Bash guard runs --
// rather than by a hand-rolled line filter, so:
//   - a comment cannot create a call, and a quoted example is ONE opaque word,
//     so prose can neither issue a call nor satisfy an exemption (F1);
//   - a `\`-continued command is one command, a `$( … )` body is a script of
//     its own, `bash -c '<script>'` and `eval '<script>'` are scanned as the
//     script they run, and a command word resolves through the workflow's own
//     declared env, so an alias, an absolute path and a write verb are all
//     `gh` wherever they sit (F2);
//   - every invocation is judged on its own, so one call's `-R` cannot excuse a
//     later call (F3).
// A shape the census cannot classify -- an unresolvable command word, `gh`
// outside command position (an unmodelled wrapper), a non-shell step that names
// `gh`, and an inline script the lexer cannot open (a heredoc handed to a shell,
// a script piped or substituted into one, `su -c`, `node -e`, `python -c`) -- is
// REPORTED as `unclassified`, never skipped, so the gate fails closed.
//
// Shell variables and exported child environment are separate: workflow < job
// < step < preceding exports < this command's prefix. Standalone assignments
// affect shell expansion, but reach gh's environment only after export.
// Only the runner's GITHUB_REPOSITORY supplies an implicit repository operand:
// `--repo
// "$GITHUB_REPOSITORY"` resolves in a checkout-free job (the shape #4382 is
// about), while a workflow-declared `""` still clears it and any other
// undeclared variable still expands to nothing.
//
// Stated limits of a source census: a shell that runs a FILE (`bash ci.sh`) or
// remote input (`curl … | sh`) is not read, an inline
// `-c`/`-e` payload that does not itself name a `gh` call is not reported (and a
// matcher pattern that does, `grep -e 'gh …'`, IS reported: the census cannot
// tell a pattern from a program), and an earlier `echo GH_REPO=… >> $GITHUB_ENV`
// is not tracked. A shell heredoc is conservatively reported when its whole
// run script names gh: the lexer removes the body, so a gh call elsewhere in
// the same script can also trigger that report. Unquoted-heredoc substitutions
// with no retained position are checked against incoming env only. Function
// bodies are scanned at definition scope; function calls are not interpreted.

/** Shell interpreters whose `-c` argument is itself a script bash runs. */
const SHELL_COMMANDS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
/** Prefix commands whose later argument may be the stdin-fed interpreter. */
const STDIN_WRAPPERS = new Set([
	"command",
	"env",
	"exec",
	"nice",
	"sudo",
	"timeout",
]);
/** Enumerated data-stdin forms; every unlisted flag refuses (STATE_TABLE.md). */
const STDIN_DATA_CONSUMERS: Record<string, readonly string[]> = {
	cat: [],
	tee: [],
	jq: [],
	grep: ["-q", "--"],
	sed: ["-n"],
	awk: [],
};
/** Flags through which a non-shell executor is handed its program as a string. */
const SCRIPT_FLAGS = new Set(["-c", "-e", "-p", "--eval", "--print"]);
/**
 * Words that open or close a context this census does not model: a conditional,
 * a loop, a case, a function or group body. An admitted
 * `export GH_REPO` survives none of them (STATE_TABLE.md row 13).
 */
const CONTEXT_WORDS = new Set([
	"{",
	"}",
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"select",
	"function",
]);
/**
 * `gh api` flags that consume the next word as their value (gh 2.100.0
 * `gh api --help`), so an option's value never stands in for the endpoint.
 */
const API_OPTION_VALUES = new Set([
	"--cache",
	"-F",
	"--field",
	"-H",
	"--header",
	"--hostname",
	"--input",
	"-q",
	"--jq",
	"-X",
	"--method",
	"-p",
	"--preview",
	"-f",
	"--raw-field",
	"-t",
	"--template",
]);
/** One variable reference as a whole word: `$GH_BIN`, `${GH_BIN}`. */
const VARIABLE_WORD = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
/**
 * A `gh` command word inside opaque text -- a script string, a JSON payload, a
 * quoted argument. `gh` alone is not one: a call carries its subject, so the
 * word boundary is what tells a call from the command word itself. This is the
 * half of the witness that reads a quoted payload the lexer keeps whole
 * (`exec.exec('gh', [ … ])`); the other half is the shared lexer.
 */
const GH_COMMAND_WORD = /(?:^|[\s"'`;&|(])gh(?=[\s"'`;&|,)])/;
/** A repository root as `gh api` names one, or the GraphQL endpoint. */
const API_REPOSITORY_ROOT =
	/^(?:graphql|\/?repos\/(?:\$GITHUB_REPOSITORY|\$\{\{\s*github\.repository\s*\}\}|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/|$))/;
/**
 * The runner variable guaranteed to name the current owner/repository.
 * Other runner variables are not implicit repository sources.
 */
// Only GITHUB_REPOSITORY is guaranteed to name the current owner/repository.
// https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables
const RUNNER_PROVIDED_VARIABLE = /^GITHUB_REPOSITORY$/;
type GhInvocation = {
	/** 0-based index of the step whose `run:` script holds the call. */
	step: number;
	/** The simple command that runs `gh`, quotes and comments stripped. */
	words: string[];
	/** This call carries a provable repository source of its own. */
	hasSource: boolean;
};

/**
 * The two script facts the census carries forward, both fail-closed: an
 * admitted `export GH_REPO=<provable>` is in force at this position, and every
 * name the script REBINDS (standalone assignment, `export`, `unset`,
 * `export -n`) no longer answers for its declared value. No value, and no
 * scope, is tracked (STATE_TABLE.md, "Deleted machinery").
 */
type ScriptState = { exportedRepo: boolean; rebound: Set<string> };

type Census = {
	invocations: GhInvocation[];
	/** Shapes the census cannot classify: reported, never skipped. */
	unclassified: Array<{ step: number; detail: string }>;
};

type Finding = {
	job: string;
	kind: "missing-source" | "unclassified";
	detail: string;
};

function declaredEnv(...scopes: unknown[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const scope of scopes) {
		if (typeof scope !== "object" || scope === null) continue;
		for (const [key, value] of Object.entries(
			scope as Record<string, unknown>,
		)) {
			if (value === undefined || value === null) continue;
			env[key] = String(value);
		}
	}
	return env;
}

/**
 * Resolve a command word to the command it runs, and whether the census could
 * read it at all -- an undeclared alias, or an alias whose value is a runtime
 * expression. Command POSITION belongs to the Bash guard, so every arm shares
 * one alias model: a declared `SHELLX=bash` runs a shell wherever `bash` would.
 */
function resolveCommand(
	word: string,
	env: Record<string, string>,
	rebound: Set<string> = new Set<string>(),
): { command: string; unresolved: boolean } {
	const variable = VARIABLE_WORD.exec(word);
	if (!variable) {
		const command = commandBasename(word);
		return { command, unresolved: command.includes("$") };
	}
	const value = rebound.has(variable[1]) ? undefined : env[variable[1]]?.trim();
	if (value === undefined || value === "") {
		return { command: word, unresolved: true };
	}
	const [first] = value.split(/\s+/);
	if (first === undefined || first.includes("${{")) {
		return { command: word, unresolved: true };
	}
	return { command: commandBasename(first), unresolved: false };
}

/**
 * A `gh` call inside text the census does not execute -- a heredoc body, an
 * inline `-c` payload, a non-shell step's arguments. The witness is this
 * census's own command resolution over the shared lexer's words, so it names
 * the same call whichever way the script spells it: the literal word, a path
 * whose basename is `gh` (`/usr/bin/gh`), a `$VAR`/`${VAR}` whose declared
 * value resolves to `gh`, and the quoted spellings the lexer folds into `gh`
 * (`"g"h`, `\gh`, `g''h`). A private splitter here missed exactly those, and
 * an empty population reads as a clean workflow (AGENTS.md shape 69).
 */
function namesGhCall(text: string, env: Record<string, string>): boolean {
	if (GH_COMMAND_WORD.test(text)) return true;
	// A payload keeps its own separators (`true;$GH_BIN pr edit …`), so ask
	// each simple command in it, not only its first word.
	for (const { text: segment } of splitSegmentsWithSeparators(text)) {
		for (const word of splitWords(segment)) {
			// The lexer hands back a quoted argument as one opaque word, so a
			// script argument's own command word is the first token of that word.
			for (const candidate of [word, word.split(/\s+/)[0] ?? ""]) {
				if (
					candidate !== "" &&
					resolveCommand(candidate, env).command === "gh"
				) {
					return true;
				}
			}
		}
	}
	return false;
}

function isCheckoutStep(step: Step): boolean {
	return /^actions\/checkout@/.test(String(step.uses));
}

/**
 * A non-shell executor can still run `gh` (`exec.exec('gh pr edit …')` in a
 * github-script step). The census models shell scripts only, so it reports
 * that step instead of skipping it.
 */
function namesGhCommand(step: Step, env: Record<string, string>): boolean {
	return namesGhCall(JSON.stringify(step.with ?? ""), env);
}

/**
 * A variable's value at the live `gh` boundary, in its three states: declared
 * by the workflow (its value, `""` included); never declared but supplied by
 * the Actions runner (`GITHUB_REPOSITORY`, the owner/repository value); or
 * never declared and
 * not the runner's, which expands to nothing -- a typo or an unexported shell
 * variable, the state #4382's `--repo "$PATCH_REPO"` probe pins.
 */
function variableValue(
	name: string,
	env: Record<string, string>,
	rebound: Set<string> = new Set<string>(),
): string | undefined {
	// A name the script rebinds no longer holds its declared value.
	if (rebound.has(name)) return undefined;
	const declared = env[name];
	if (declared !== undefined) return declared;
	return RUNNER_PROVIDED_VARIABLE.test(name)
		? "__RUNNER_REPOSITORY__"
		: undefined;
}

/**
 * The gh verb's index: the first word that is neither a flag nor a `--flag`
 * value. gh's global options (`--hostname github.com`, `--repo owner/repo`)
 * precede the verb, so a value sitting in an option's slot is not the verb.
 */
function ghVerbIndex(words: string[]): number {
	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		if (word.startsWith("-")) {
			// A long option without `=` takes its value as the next word.
			if (word.startsWith("--") && !word.includes("=")) index++;
			continue;
		}
		return index;
	}
	return -1;
}

/**
 * The endpoint word of a `gh api` call: its first positional word after the
 * verb. Options and their values (`-X POST`, `--input graphql`, `-f k=v`) sit
 * in front of it, and an option's value is not an endpoint.
 */
function apiEndpoint(words: string[], verb: number): string | undefined {
	for (let index = verb + 1; index < words.length; index++) {
		const word = words[index];
		if (word.startsWith("-")) {
			if (API_OPTION_VALUES.has(word) && !word.includes("=")) index++;
			continue;
		}
		return word;
	}
	return undefined;
}

/**
 * Does this `gh` command need a repository? `gh auth` and `gh --version` do
 * not; `gh api` names one in its request path. Every other verb does, including
 * the verbs no census enumerated (`gh variable set`, `gh secret set`).
 */
function needsRepository(words: string[]): boolean {
	const verb = ghVerbIndex(words);
	if (verb < 0 || words[verb] === "auth") return false;
	if (words[verb] !== "api") return true;
	// Only the endpoint carries the request path. gh options and their values
	// (`--input graphql` is a filename) are not the endpoint, and an option's
	// value cannot satisfy a placeholder the endpoint must still resolve.
	const endpoint = apiEndpoint(words, verb);
	return (
		endpoint !== undefined &&
		/\{(?:owner|repo)\}/.test(endpoint) &&
		!API_REPOSITORY_ROOT.test(endpoint)
	);
}

/**
 * Expand the two modelled reference forms (`$NAME`, `${NAME}`) through `env`
 * until the text stops changing, so a declared value that is itself a
 * reference (`REPO: $GITHUB_REPOSITORY`) resolves the way the shell chain
 * would. Any other `$` form is left standing for its caller to refuse.
 */
function expandReferences(
	value: string,
	env: Record<string, string>,
	rebound: Set<string> = new Set<string>(),
): string {
	let expanded = value;
	for (let pass = 0; pass < 8; pass++) {
		const next = expanded.replace(
			/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
			(_, braced, bare) => variableValue(braced ?? bare, env, rebound) ?? "",
		);
		if (next === expanded) return expanded;
		expanded = next;
	}
	return expanded;
}

/**
 * The contents of single-quoted spans that hold a `$`. The shell never expands
 * those, so the text is a literal gh receives verbatim, never a reference the
 * census may resolve: `GH_REPO='$TARGET'` sends the five characters `$TARGET`
 * (F12). Quote class is lost once the lexer folds a word, so it is read here,
 * from the segment's own text.
 */
function literalDollarText(text: string): Set<string> {
	const literal = new Set<string>();
	for (const match of text.matchAll(/'([^']*)'/g)) {
		if (match[1].includes("$")) literal.add(match[1]);
	}
	return literal;
}

/** Is this a repository operand a live `gh` accepts? `""` is not. */
function isRepoValue(
	value: string | undefined,
	env: Record<string, string>,
	literal: Set<string>,
	rebound: Set<string> = new Set<string>(),
	seenEnv: Set<string> = new Set<string>(),
): boolean {
	const text = (value ?? "").trim();
	// A single-quoted `$` value is literal text: never a slug, never a reference.
	if (literal.has(text)) return false;
	const expanded = expandReferences(text, env, rebound).trim();
	// Two expansion forms are modelled above; any other `$` or backtick left in
	// the operand (`${VAR:-}`, `$1`, `${ARR[0]}`) is text the census cannot read,
	// so it is no source. Only the two repository workflow expressions below are
	// declared values.
	const residual = expanded.replace(/\$\{\{[\s\S]*?\}\}/g, "");
	if (expanded === "__RUNNER_REPOSITORY__") return true;
	if (/^\$\{\{\s*github\.repository\s*\}\}$/.test(expanded)) return true;
	const envReference = /^\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(
		expanded,
	);
	if (envReference) {
		const name = envReference[1];
		if (seenEnv.has(name)) return false;
		const nextSeen = new Set(seenEnv);
		nextSeen.add(name);
		return isRepoValue(env[name], env, literal, rebound, nextSeen);
	}
	if (expanded === "" || expanded.startsWith("-") || /[$`]/.test(residual))
		return false;
	return /^(?:[^/\s]+\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expanded);
}

/** `-R owner/repo`, `-Rowner/repo`, `--repo owner/repo`, `--repo=owner/repo`. */
function hasRepoOperand(
	words: string[],
	env: Record<string, string>,
	literal: Set<string>,
	rebound: Set<string> = new Set<string>(),
): boolean | undefined {
	let explicit: boolean | undefined;
	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		// `--` ends the options, so nothing after it is a source.
		if (word === "--") break;
		if (word === "-R" || word === "--repo") {
			explicit = isRepoValue(words[index + 1], env, literal, rebound);
			index++;
			continue;
		}
		if (word.startsWith("--repo=")) {
			explicit = isRepoValue(
				word.slice("--repo=".length),
				env,
				literal,
				rebound,
			);
			continue;
		}
		if (word.startsWith("-R") && word.length > 2)
			explicit = isRepoValue(word.slice(2), env, literal, rebound);
		// An option's VALUE is not an option: `--body '--repo=not-a-slug'` names a
		// body, so a valid `--repo` earlier is not replaced by it (Greptile
		// r4307901275). A word carrying `=` holds its own value.
		else if (word.startsWith("-") && !word.includes("=")) index++;
	}
	return explicit;
}

/**
 * Return the stdin-fed interpreter in a command, if any. Redirections may be
 * leading, trailing, attached to the command, or followed by another
 * redirection. Only the explicitly listed wrappers are traversed; a quoted
 * example such as `printf 'bash<<EOF'` remains an ordinary printf argument.
 */
function stdinFedInterpreter(
	words: string[],
	env: Record<string, string>,
	text: string,
): string | undefined {
	if (!hasLiveStdinRedirect(text)) return undefined;
	// Round 9 (STATE_TABLE.md): the admitted flag set is enumerated per program,
	// so an unlisted flag refuses instead of passing as data.
	const admitsData = (command: string, start: number): boolean => {
		const allowed = STDIN_DATA_CONSUMERS[command];
		if (!allowed) return false;
		// Every flag-position word is judged, wherever the redirection sits: a
		// flag after the redirection (`sed <<EOF -f -`) still reads the heredoc
		// as the program. A redirection token, a bare `-` (the stdin operand),
		// any operand, and everything after `--` are not flags.
		let endOptions = false;
		for (let index = start; index < words.length; index++) {
			const word = words[index];
			if (word === "--") {
				endOptions = true;
				continue;
			}
			if (endOptions || word === "-" || !word.startsWith("-")) continue;
			// No admitted form names an external script (`-f`, `--file`), so the
			// enumerated set alone refuses it, in any position.
			if (!allowed.includes(word)) return false;
		}
		return true;
	};
	let index = 0;
	let wrapper: string | undefined;
	while (index < words.length) {
		const word = words[index];
		if (["|", ";", "&&", "||"].includes(word)) return undefined;
		const attached = /^(.*?)(<<<|<<-?)/.exec(word);
		if (attached) {
			if (attached[1] !== "") {
				const resolved = resolveCommand(attached[1], env).command;
				return admitsData(resolved, index + 1) ? "" : attached[1];
			}
			index++;
			continue;
		}
		if (/^\d*[<>]/.test(word)) {
			index++;
			continue;
		}
		const resolved = resolveCommand(word, env).command;
		if (!wrapper && STDIN_WRAPPERS.has(resolved)) {
			wrapper = resolved;
			index++;
			continue;
		}
		if (wrapper === "env" && (word.startsWith("-") || word.includes("="))) {
			index++;
			continue;
		}
		if (wrapper === "timeout" && (/^-/.test(word) || /^\d/.test(word))) {
			index++;
			continue;
		}
		if (
			wrapper !== undefined &&
			["command", "exec", "nice", "sudo"].includes(wrapper) &&
			word.startsWith("-")
		) {
			index++;
			continue;
		}
		return admitsData(resolved, index + 1) ? "" : word;
	}
	return undefined;
}

function scanScript(
	script: string,
	step: number,
	env: Record<string, string>,
	census: Census,
): void {
	// The lexer emits substitution bodies in postorder and leaves one marker
	// per child. Rebuild that tree, then visit a child at the marker's position:
	// a substitution is a subshell, so it starts clean and nothing it binds
	// travels back.
	const marker = scannableRegions("$(true)")[0];
	type Region = { text: string; children: Region[] };
	const regions = scannableRegions(script);
	const pending: Region[] = [];
	for (const text of [...regions.slice(1), regions[0]]) {
		const count = text.split(marker).length - 1;
		pending.push({ text, children: count ? pending.splice(-count) : [] });
	}
	const witness = namesGhCall(script, env);
	const visit = (region: Region): void => {
		const state: ScriptState = {
			exportedRepo: false,
			rebound: new Set<string>(),
		};
		const subshells: boolean[] = [];
		let child = 0;
		for (const { text, sep } of splitSegmentsWithSeparators(region.text)) {
			// A separator is the boundary that PRECEDES this segment, applied in
			// the order it appears: `);(` closes the first subshell before the
			// second opens, so one subshell's export never reaches the next. A
			// subshell or a pipeline starts clean (STATE_TABLE.md row 13): the
			// census admits an export only at the script level it was written in.
			for (const boundary of sep ?? "") {
				if (boundary === "(") {
					subshells.push(state.exportedRepo);
					state.exportedRepo = false;
				} else if (boundary === ")") {
					state.exportedRepo = subshells.pop() ?? false;
				}
			}
			if (sep !== null && sep.replaceAll("||", "").includes("|")) {
				state.exportedRepo = false;
			}
			for (let n = 1; n < text.split(marker).length; n++) {
				const nested = region.children[child++];
				if (nested) visit(nested);
			}
			classifySegment(text, step, env, census, state, witness);
		}
	};
	// A substitution in an unquoted heredoc has no retained marker, so its
	// position is unavailable: judge it as a top-level script, never against a
	// later export (conservative missing-source is intentional).
	const roots =
		pending.length === 1
			? pending
			: regions.map((text) => ({ text, children: [] }));
	for (const region of roots) visit(region);
}

/**
 * The census owns this classifier: it COLLECTS invocations and unclassified
 * shapes into a `Census`. It is not the Bash guard's exported
 * `classifySegment`, which returns a `DenyRule`; the guard is asked for lexing
 * and command position, never for policy. The only script state it carries is
 * `state.exportedRepo` (STATE_TABLE.md).
 */
function classifySegment(
	text: string,
	step: number,
	declared: Record<string, string>,
	census: Census,
	state: ScriptState,
	regionNamesGhCall: boolean,
): void {
	const literal = literalDollarText(text);
	const rawWords = splitWords(text);
	// A context word opens or closes a construct the census does not model, so
	// no admitted export survives it (STATE_TABLE.md row 13).
	if (CONTEXT_WORDS.has(rawWords[0] ?? "")) state.exportedRepo = false;
	const { env: assigned, rest } = stripEnvAssignments(
		stripCommandGroupAndRunnerPrefixes(rawWords),
	);
	if (rest.length === 0) {
		// A standalone assignment rebinds the name for every later expansion of
		// this script. Its VALUE is not followed, so the declared value must not
		// answer either (Greptile 10:51: `GH_BIN=gh` over `GH_BIN: echo`).
		for (const name of Object.keys(assigned)) state.rebound.add(name);
		return;
	}
	if (rest[0] === "export") {
		// The one script binding the census admits: `export GH_REPO=<provable>`.
		// `export -n NAME` removes that attribute (and `export -n NAME=value`
		// sets a value WITHOUT exporting it), and a bare `export GH_REPO` marks a
		// value this census does not follow: in all three `stripEnvAssignments`
		// finds no `GH_REPO` value, so the binding is no source.
		const words = rest.slice(1);
		for (const word of words)
			if (!word.startsWith("-")) state.rebound.add(word.split("=")[0]);
		if (
			!words.some((word) => word === "GH_REPO" || word.startsWith("GH_REPO="))
		)
			return;
		state.exportedRepo = isRepoValue(
			stripEnvAssignments(words).env.GH_REPO,
			declared,
			literal,
			state.rebound,
		);
		return;
	}
	if (rest[0] === "unset") {
		for (const name of rest.slice(1))
			if (!name.startsWith("-")) state.rebound.add(name);
		if (rest.slice(1).includes("GH_REPO")) state.exportedRepo = false;
		return;
	}
	// A same-command prefix belongs to its own command's environment (and to no
	// other). Nothing else about a segment changes the environment.
	const scope = { ...declared, ...assigned };
	// One resolution for every arm, so an alias cannot be a shell in one spelling
	// and a stranger in another (AGENTS.md shape 69).
	const resolved = resolveCommand(rest[0], scope, state.rebound);
	if (resolved.unresolved) {
		// A lone unresolvable word is not a call the census can judge: every
		// repository-needing `gh` verb carries at least its subject, and the
		// shared lexer also hands back array elements (`HOST_PKGS+=("$pkg")`
		// lexes as the segment `"$pkg"`) and other parenthesised fragments.
		// With an argument list in hand there is a verb to read, so an alias
		// the workflow never declared is reported rather than skipped.
		if (rest.length < 2) return;
		census.unclassified.push({
			step,
			detail: `the command word \`${rest[0]}\` cannot be resolved`,
		});
		return;
	}
	const command = resolved.command;
	// Stdin redirections are unreadable program input. The lexer subtracts a
	// heredoc body before this scan, while a herestring stays in the segment;
	// both must report when their interpreter's input names a gh call. The
	// admitted set carries no script flag (`-c`/`-e`/`-p`/`--eval`/`--print`),
	// so an admitted data heredoc never runs code (STATE_TABLE.md round 9).
	const stdinInterpreter = stdinFedInterpreter(rest, scope, text);
	if (stdinInterpreter !== undefined && regionNamesGhCall) {
		if (stdinInterpreter !== "") {
			census.unclassified.push({
				step,
				detail: `\`${stdinInterpreter}\` reads a stdin-fed program this census does not read`,
			});
		}
		return;
	}
	if (SHELL_COMMANDS.has(command)) {
		const flag = rest.findIndex(
			(word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word),
		);
		const nested = flag < 0 ? undefined : rest[flag + 1];
		if (nested !== undefined) {
			// A `-c` payload is a second shell with its own argv, so the census
			// reports it rather than resolving a call it does not read.
			if (namesGhCall(nested, scope)) {
				census.unclassified.push({
					step,
					detail: `\`${rest[0]} ${rest[flag]}\` runs a script this census does not read, and it names a \`gh\` call`,
				});
			}
			return;
		}
		// `bash ci.sh` runs a FILE: a stated limit, not a body the census misses.
		if (
			rest.slice(1).some((word) => !word.startsWith("-") && !/^[<>]/.test(word))
		) {
			return;
		}
		// A bare `bash` reads stdin. Report it when this region names a `gh` call
		// (`printf … | bash`, `bash <(echo …)`), and stay silent for remote input
		// (`curl … | sh`), which is a stated limit rather than a modelled call.
		if (regionNamesGhCall) {
			census.unclassified.push({
				step,
				detail: `\`${rest[0]}\` reads its script from stdin, which names a \`gh\` call`,
			});
		}
		return;
	}
	if (command === "eval") {
		// `eval` runs in the CALLER's shell, so neither direction of its effect is
		// provable: a payload export would have to travel back out, and an outer
		// export into the payload is not something this census follows. Report it
		// when it names a call, never resolve one through it (F10).
		const payload = rest.slice(1).join(" ");
		if (/\bGH_REPO\b/.test(payload)) state.exportedRepo = false;
		if (namesGhCall(payload, scope)) {
			census.unclassified.push({
				step,
				detail: `\`${rest[0]}\` runs a script this census does not read, and it names a \`gh\` call`,
			});
		}
		return;
	}
	if (command === "gh") {
		const explicitRepo = hasRepoOperand(rest, declared, literal, state.rebound);
		census.invocations.push({
			step,
			words: rest,
			// A prefix assignment reaches the CHILD's environment, so it is read
			// for `GH_REPO`; it is not visible to the shell's own word expansion,
			// so an operand is resolved against the declared env alone.
			hasSource:
				explicitRepo ??
				(state.exportedRepo ||
					isRepoValue(scope.GH_REPO, declared, literal, state.rebound)),
		});
		return;
	}
	// A non-shell executor handed its program as a string: `su -c '<script>'`,
	// `node -e '<script>'`, `python3 -c '<script>'`. The census cannot run it, so
	// it reports the shape rather than reading the call as absent.
	const scriptFlag = rest.findIndex(
		(word, index) => index > 0 && SCRIPT_FLAGS.has(word),
	);
	if (scriptFlag >= 0 && namesGhCall(rest[scriptFlag + 1] ?? "", scope)) {
		census.unclassified.push({
			step,
			detail: `\`${rest[0]} ${rest[scriptFlag]}\` runs a script this census does not read, and it names a \`gh\` call`,
		});
		return;
	}
	if (rest.slice(1).some((word) => commandBasename(word) === "gh")) {
		census.unclassified.push({
			step,
			detail: `\`gh\` is an argument of \`${rest[0]}\`, not the command`,
		});
	}
}

function censusWorkflow(workflow: Workflow): {
	findings: Finding[];
	population: string[];
} {
	const findings: Finding[] = [];
	const population: string[] = [];
	const workflowEnv = declaredEnv(workflow.env);
	for (const [key, job] of Object.entries(workflow.jobs ?? {})) {
		const census: Census = { invocations: [], unclassified: [] };
		const jobEnv = declaredEnv(job.env);
		let checkoutBefore = false;
		let named = false;
		const steps = (job.steps ?? []) as Step[];
		for (let index = 0; index < steps.length; index++) {
			const step = steps[index];
			const env = { ...workflowEnv, ...jobEnv, ...declaredEnv(step.env) };
			if (typeof step.run === "string") {
				const calls = census.invocations.length;
				const problems = census.unclassified.length;
				scanScript(step.run, index, env, census);
				for (const invocation of census.invocations.slice(calls)) {
					named = true;
					if (!needsRepository(invocation.words)) continue;
					if (checkoutBefore || invocation.hasSource) continue;
					findings.push({
						job: key,
						kind: "missing-source",
						detail: `step ${index + 1}: \`${invocation.words.join(" ")}\``,
					});
				}
				for (const problem of census.unclassified.slice(problems)) {
					named = true;
					findings.push({
						job: key,
						kind: "unclassified",
						detail: `step ${index + 1}: ${problem.detail}`,
					});
				}
			} else if (namesGhCommand(step, env)) {
				named = true;
				findings.push({
					job: key,
					kind: "unclassified",
					detail: `step ${index + 1}: a non-shell step names \`gh\``,
				});
			}
			if (isCheckoutStep(step)) checkoutBefore = true;
		}
		if (named) population.push(key);
	}
	return { findings, population };
}

const BARE_GH_WRITE = "gh pr edit 4550 --add-label ci:real";

/** A one-job workflow driving the same census the workflow tree runs. */
function probe(options: {
	run: string;
	workflowEnv?: Record<string, string>;
	jobEnv?: Record<string, string>;
	stepEnv?: Record<string, string>;
	checkout?: boolean;
}): { findings: Finding[]; population: string[] } {
	const steps: Step[] = [];
	if (options.checkout) steps.push({ uses: "actions/checkout@v7" });
	steps.push({ env: options.stepEnv, run: options.run });
	return censusWorkflow({
		env: options.workflowEnv,
		jobs: { probe: { env: options.jobEnv, steps } },
	});
}

function findingsOf(workflow: Workflow): Array<[string, string]> {
	return censusWorkflow(workflow).findings.map((finding) => [
		finding.job,
		finding.kind,
	]);
}

function loaded(...lines: string[]): Workflow {
	return yaml.load(lines.join("\n")) as Workflow;
}

describe("workflow gh calls resolve a repository (#4382)", () => {
	it("gives every gh invocation in every workflow a repository source", () => {
		const findings: string[] = [];
		const population: string[] = [];
		for (const name of readdirSync(WORKFLOWS).sort()) {
			if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
			const { workflow } = load(resolve(WORKFLOWS, name));
			const census = censusWorkflow(workflow);
			population.push(...census.population.map((job) => `${name}:${job}`));
			findings.push(
				...census.findings.map(
					(finding) =>
						`${name}:${finding.job} (${finding.kind}: ${finding.detail})`,
				),
			);
		}
		// The census derives its population from structure; an empty derivation
		// must fail rather than read as a clean tree.
		assertNonEmptyScan("workflow gh census", population.length, 12);
		expect(
			findings,
			"a gh call with no GH_REPO, checkout, or -R dies on repo resolution",
		).toEqual([]);
	});

	it("flags the pre-fix finalize-rerun job shape, naming the job", () => {
		// Reject twin: the nearest wrong shape -- a gh write with no repository
		// source -- must stay visible, and the record must name the job.
		const census = censusWorkflow(
			loaded(
				"on: {workflow_run: null}",
				"jobs:",
				"  finalize-rerun:",
				"    runs-on: ubuntu-latest",
				"    env:",
				"      GH_TOKEN: secret",
				"    steps:",
				"      - run: |",
				`          ${BARE_GH_WRITE}`,
				"  classify:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - uses: actions/checkout@v7",
				`      - run: ${BARE_GH_WRITE}`,
			),
		);
		expect(census.findings.map((finding) => finding.job)).toEqual([
			"finalize-rerun",
		]);
		expect(census.findings[0]?.kind).toBe("missing-source");
		expect(census.findings[0]?.detail).toContain(BARE_GH_WRITE);
		expect(census.population).toEqual(["finalize-rerun", "classify"]);
	});

	it("does not read a commented-out gh call as one", () => {
		const census = censusWorkflow(
			loaded(
				"on: {workflow_run: null}",
				"jobs:",
				"  docs:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: |",
				"          # gh pr edit 4550 --add-label ci:real",
				"          echo hello",
			),
		);
		expect(census.findings).toEqual([]);
		expect(census.population).toEqual([]);
	});

	it("does not let a comment or a quoted example supply the repository", () => {
		// F1, both directions: prose cannot ISSUE a call, and prose cannot
		// satisfy an exemption either. The comment below is the line a
		// maintainer would write to document the job's own -R flag.
		expect(
			findingsOf(
				loaded(
					"on: {workflow_run: null}",
					"jobs:",
					"  trailing-comment:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - run: |",
					`          ${BARE_GH_WRITE}  # e.g. -R owner/repo`,
					"  quoted-example:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - run: |",
					'          echo "reminder: use -R owner/repo when you run gh pr edit"',
					`          ${BARE_GH_WRITE}`,
				),
			),
		).toEqual([
			["trailing-comment", "missing-source"],
			["quoted-example", "missing-source"],
		]);
	});

	it("names every gh invocation shape the shell offers", () => {
		// F2: the gate is green only if it sees EVERY spelling, so each plant
		// here is a real call with no repository source and must be a finding.
		// A call the census cannot read is `unclassified`, never resolved.
		expect(
			findingsOf(
				loaded(
					"on: {workflow_run: null}",
					"jobs:",
					"  alias:",
					"    runs-on: ubuntu-latest",
					"    env:",
					"      GH_BIN: gh",
					"    steps:",
					`      - run: $GH_BIN${BARE_GH_WRITE.slice(2)}`,
					"  absolute-path:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					`      - run: /usr/bin/${BARE_GH_WRITE}`,
					"  nested-shell:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					`      - run: bash -c '${BARE_GH_WRITE}'`,
					"  evaluated:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					`      - run: eval '${BARE_GH_WRITE}'`,
					"  continued:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - run: |",
					"          gh \\",
					"            pr edit 4550 --add-label ci:real",
					"  unlisted-verb:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - run: gh variable set FOO --body bar",
				),
			),
		).toEqual([
			["alias", "missing-source"],
			["absolute-path", "missing-source"],
			["nested-shell", "unclassified"],
			["evaluated", "unclassified"],
			["continued", "missing-source"],
			["unlisted-verb", "missing-source"],
		]);
	});

	it("reports an invocation shape it cannot classify", () => {
		// Fail closed: a shape the census cannot read is a finding, never a skip.
		expect(
			findingsOf(
				loaded(
					"on: {workflow_run: null}",
					"jobs:",
					"  undeclared-alias:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - run: $GH_BIN pr edit 4550 --add-label ci:real",
					"  wrapped:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					`      - run: timeout 30 ${BARE_GH_WRITE}`,
					"  non-shell:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - uses: actions/github-script@v7",
					"        with:",
					"          script: |",
					`            exec.exec('${BARE_GH_WRITE}')`,
					"  non-shell-separate:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - uses: actions/github-script@v7",
					"        with:",
					"          script: |",
					"            exec.exec('gh', ['pr', 'edit', '4550', '--add-label', 'ci:real'])",
				),
			),
		).toEqual([
			["undeclared-alias", "unclassified"],
			["wrapped", "unclassified"],
			["non-shell", "unclassified"],
			["non-shell-separate", "unclassified"],
		]);
	});

	it("judges each call, so one call's -R does not excuse another", () => {
		const census = censusWorkflow(
			loaded(
				"on: {workflow_run: null}",
				"jobs:",
				"  mixed:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: |",
				"          gh pr view 9999 -R owner/repo",
				"          gh pr edit 9999 --add-label x",
			),
		);
		expect(census.findings).toEqual([
			{
				job: "mixed",
				kind: "missing-source",
				detail: "step 1: `gh pr edit 9999 --add-label x`",
			},
		]);
	});

	it("accepts a workflow-scope GH_REPO", () => {
		expect(
			probe({
				run: BARE_GH_WRITE,
				workflowEnv: { GH_REPO: "${{ github.repository }}" },
			}).findings,
		).toEqual([]);
	});

	it("accepts a job-scope GH_REPO", () => {
		expect(
			probe({
				run: BARE_GH_WRITE,
				jobEnv: { GH_REPO: "${{ github.repository }}" },
			}).findings,
		).toEqual([]);
	});

	it("accepts a step-scope GH_REPO, the placement cache-prune.yml uses", () => {
		expect(
			probe({
				run: BARE_GH_WRITE,
				stepEnv: { GH_REPO: "${{ github.repository }}" },
			}).findings,
		).toEqual([]);
	});

	it("accepts -R and --repo operands", () => {
		for (const operand of [
			"-R owner/repo",
			"-Rowner/repo",
			"--repo owner/repo",
			"--repo=owner/repo",
		]) {
			expect(
				probe({ run: `${BARE_GH_WRITE} ${operand}` }).findings,
				operand,
			).toEqual([]);
		}
	});

	it("requires the value of an attached -R<slug> operand", () => {
		// R10: the attached branch is a branch of its own, not a spelling of the
		// spaced one -- an expansion that resolves to nothing is no source.
		expect(
			probe({ run: `${BARE_GH_WRITE} -R$PATCH_REPO` }).findings.map(
				(f) => f.kind,
			),
		).toEqual(["missing-source"]);
	});

	it("counts a repository operand built from a runner variable", () => {
		// R8: the Actions runner defines GITHUB_REPOSITORY before any script runs,
		// so a checkout-free job that writes through it is valid -- the shape
		// labels.yml:sync uses on both of its calls.
		for (const options of [
			{ run: `${BARE_GH_WRITE} --repo "$GITHUB_REPOSITORY"` },
			{ run: `${BARE_GH_WRITE} -R "$GITHUB_REPOSITORY"` },
			{ run: BARE_GH_WRITE, jobEnv: { GH_REPO: "$GITHUB_REPOSITORY" } },
		]) {
			expect(probe(options).findings, JSON.stringify(options)).toEqual([]);
		}
	});

	it("keeps a declared empty runner variable empty", () => {
		// R8's third state: a nearer `""` still clears the runner's own value, so
		// the rule adds a source only where the workflow did not override it.
		expect(
			probe({
				run: `${BARE_GH_WRITE} --repo "$GITHUB_REPOSITORY"`,
				stepEnv: { GITHUB_REPOSITORY: "" },
			}).findings.map((f) => f.kind),
		).toEqual(["missing-source"]);
	});

	it("rejects unrelated runner variables as repository sources", () => {
		// F1: a runner namespace is not a guaranteed repository value.
		for (const name of [
			"GITHUB_REPOSITOR", // spellchecker:disable-line
			"GITHUB_SHA",
			"GITHUB_REPOSITORY_OWNER",
			"RUNNER_TEMP",
			"PATCH_REPO",
		]) {
			expect(
				probe({ run: `${BARE_GH_WRITE} --repo "$${name}"` }).findings.map(
					(f) => f.kind,
				),
				name,
			).toEqual(["missing-source"]);
		}
	});

	it("admits one exported literal and no export-marking state", () => {
		// R6: an export with a provable value is the one script binding the
		// census admits. `GH_REPO=owner/repo` then `export GH_REPO` marks a shell
		// variable whose value the census does not follow, so it is no source
		// (STATE_TABLE.md rows 12 and 17).
		expect(
			probe({ run: `export GH_REPO=owner/repo\n${BARE_GH_WRITE}` }).findings,
		).toEqual([]);
		expect(
			probe({
				run: `GH_REPO=owner/repo\nexport GH_REPO\n${BARE_GH_WRITE}`,
			}).findings.map((found) => found.kind),
		).toEqual(["missing-source"]);
	});

	it("distinguishes shell variables from child environment", () => {
		// F2: shell expansion sees standalone variables; gh's environment does not.
		// A script variable's value is not followed either way, so even the
		// operand form is reported (STATE_TABLE.md rows 5 and 17).
		expect(
			probe({ run: `GH_REPO=owner/repo\n${BARE_GH_WRITE}` }).findings.map(
				(found) => found.kind,
			),
		).toEqual(["missing-source"]);
		expect(
			probe({
				run: `GH_REPO=owner/repo\n${BARE_GH_WRITE} -R "$GH_REPO"`,
			}).findings.map((found) => found.kind),
		).toEqual(["missing-source"]);
		expect(
			probe({
				run: `GH_BIN=gh\n$GH_BIN pr edit 9999 --add-label x`,
			}).findings.map((found) => found.kind),
		).toEqual(["unclassified"]);
	});

	it("confines command prefixes to their command", () => {
		// F2: prefix assignment supplies only this child's environment.
		expect(
			probe({
				run: `GH_REPO=owner/repo ${BARE_GH_WRITE}\n${BARE_GH_WRITE}`,
			}).findings.map((f) => f.kind),
		).toEqual(["missing-source"]);
	});

	it("applies exports at the script level they were written in", () => {
		// F3/F20: the census does not model an exported value crossing into a
		// command substitution, so an export outside it does not certify the call
		// inside. A later export cannot satisfy an earlier substitution either.
		// Both directions report; this is a conservative model limit, not a claim
		// that Bash fails to inherit exported variables in a subshell.
		for (const body of [
			`$(${BARE_GH_WRITE})`,
			"`" + BARE_GH_WRITE + "`",
			`$(${BARE_GH_WRITE}; echo "$(${BARE_GH_WRITE})")`,
		]) {
			for (const run of [
				`echo "${body}"\nexport GH_REPO=owner/repo`,
				`export GH_REPO=owner/repo\necho "${body}"`,
			]) {
				expect(
					probe({ run }).findings.map((found) => found.kind),
					run,
				).toContain("missing-source");
			}
		}
		expect(
			probe({ run: `echo "$(export GH_REPO=owner/repo; ${BARE_GH_WRITE})"` })
				.findings,
		).toEqual([]);
	});

	it("keeps substitution bindings local", () => {
		// F3: changes made inside a substitution never export back to its parent.
		expect(
			probe({
				run: `echo "$(export GH_REPO=owner/repo; ${BARE_GH_WRITE})"\n${BARE_GH_WRITE}`,
			}).findings.map((f) => f.kind),
		).toEqual(["missing-source"]);
	});

	it("keeps subshell bindings local", () => {
		// Scope extension of F3: a subshell cannot export into the parent.
		expect(
			probe({
				run: `(export GH_REPO=owner/repo; ${BARE_GH_WRITE})\n${BARE_GH_WRITE}`,
			}).findings.map((f) => f.kind),
		).toEqual(["missing-source"]);
	});

	it("closes each subshell before the next opens", () => {
		// A separator carrying both `)` and `(` is one close and one open, in
		// that order: the next subshell does not inherit the previous export.
		for (const run of [
			`(export GH_REPO=owner/repo); (${BARE_GH_WRITE})`,
			`(export GH_REPO=owner/repo) && (${BARE_GH_WRITE})`,
			`(export GH_REPO=owner/repo)\n(${BARE_GH_WRITE})`,
		])
			expect(
				probe({ run }).findings.map((f) => f.kind),
				run,
			).toEqual(["missing-source"]);
		expect(
			probe({ run: `(export GH_REPO=owner/repo; ${BARE_GH_WRITE})` }).findings,
		).toEqual([]);
	});

	it("keeps function bindings in their definition scope", () => {
		// F3 scope sweep: scanning a body is not execution of its exports.
		expect(
			probe({
				run: `publish() {\nexport GH_REPO=owner/repo\n${BARE_GH_WRITE}\n}\n${BARE_GH_WRITE}`,
			}).findings.map((f) => f.kind),
		).toEqual(["missing-source"]);
		expect(
			probe({
				run: `publish() {\n${BARE_GH_WRITE}\n}\nexport GH_REPO=owner/repo`,
			}).findings.map((f) => f.kind),
		).toEqual(["missing-source"]);
	});

	it("expands assignments when they execute", () => {
		// F2/F3: a later binding cannot retroactively change an earlier value,
		// and a script assignment's value is never followed (row 5).
		for (const run of [
			`export GH_REPO=$TARGET\nexport TARGET=owner/repo\n${BARE_GH_WRITE}`,
			`TARGET=owner/repo ${BARE_GH_WRITE} -R "$TARGET"`,
			`export GH_REPO="$(echo owner/repo)"\n${BARE_GH_WRITE}`,
			`TARGET=owner/repo\nexport GH_REPO=$TARGET\n${BARE_GH_WRITE}`,
		]) {
			expect(
				probe({ run }).findings.map((found) => found.kind),
				run,
			).toEqual(["missing-source"]);
		}
	});

	it("judges bindings before and after each scoped call", () => {
		// State-table witnesses for the before/same-command/after axes. An export
		// admits only calls at its own script level, so a subshell or a new shell
		// between them leaves the call reported (row 13).
		for (const run of [
			`${BARE_GH_WRITE}\nGH_REPO=owner/repo`,
			`${BARE_GH_WRITE}\nexport GH_REPO=owner/repo`,
			`echo "$(GH_REPO=owner/repo; ${BARE_GH_WRITE})"`,
			`(${BARE_GH_WRITE}); export GH_REPO=owner/repo`,
			`(GH_REPO=owner/repo; ${BARE_GH_WRITE})`,
			`export GH_REPO=owner/repo; (${BARE_GH_WRITE})`,
		])
			expect(
				probe({ run }).findings.map((found) => found.kind),
				run,
			).toEqual(["missing-source"]);
		for (const run of [
			`export GH_REPO=owner/repo; ${BARE_GH_WRITE}`,
			`echo "$(GH_REPO=owner/repo ${BARE_GH_WRITE})"`,
			`(GH_REPO=owner/repo ${BARE_GH_WRITE})`,
			`(export GH_REPO=owner/repo; ${BARE_GH_WRITE})`,
			// An unrelated export is not a boundary: it leaves GH_REPO alone.
			`export GH_REPO=owner/repo; export PATH=/x; ${BARE_GH_WRITE}`,
			// A later standalone assignment changes the value without removing
			// the export attribute, which is what the rule reads.
			`export GH_REPO=old/repo; GH_REPO=owner/repo; ${BARE_GH_WRITE}`,
		])
			expect(probe({ run }).findings, run).toEqual([]);
	});

	it("fails closed when heredoc substitutions lose their position", () => {
		// F3: an orphaned body cannot borrow an export through a misplaced marker.
		const run = `export GH_REPO=owner/repo\necho "$(echo hello)"\ncat <<EOF\n$(${BARE_GH_WRITE})\nEOF`;
		expect(probe({ run }).findings.map((f) => f.kind)).toEqual([
			"missing-source",
		]);
		expect(probe({ run, jobEnv: { GH_REPO: "owner/repo" } }).findings).toEqual(
			[],
		);
	});

	it("ignores benign shell heredocs", () => {
		// F4: a readable body with no gh command is not an opaque gh program.
		for (const shell of ["bash", "sh", "timeout 30 bash"]) {
			expect(
				probe({ run: `${shell} <<'EOF'\necho hello\nEOF` }).findings,
			).toEqual([]);
		}
	});

	it("accepts repository-independent API endpoints", () => {
		// F5: literal endpoints do not need repository inference.
		for (const endpoint of ["user", "rate_limit", "orgs/owner/repos"]) {
			expect(probe({ run: `gh api ${endpoint}` }).findings).toEqual([]);
		}
	});

	it("accepts a gh api call that names its repository in the path", () => {
		for (const call of [
			"gh api repos/owner/repo/issues/1 --method PATCH -f body=hi",
			'gh api "/repos/$GITHUB_REPOSITORY/issues/1" --method PATCH -f body=hi',
		]) {
			expect(probe({ run: call }).findings, call).toEqual([]);
		}
	});

	it("accepts a checkout that lands before the call", () => {
		expect(probe({ run: BARE_GH_WRITE, checkout: true }).findings).toEqual([]);
	});

	it("does not accept a checkout that lands after the call", () => {
		const census = censusWorkflow({
			jobs: {
				probe: {
					steps: [{ run: BARE_GH_WRITE }, { uses: "actions/checkout@v7" }],
				},
			},
		});
		expect(census.findings.map((finding) => finding.kind)).toEqual([
			"missing-source",
		]);
	});

	it("does not accept an empty repository source", () => {
		for (const run of [
			`${BARE_GH_WRITE} --repo ""`,
			`${BARE_GH_WRITE} --repo=`,
		]) {
			expect(
				probe({ run }).findings.map((f) => f.kind),
				run,
			).toEqual(["missing-source"]);
		}
		expect(
			probe({ run: BARE_GH_WRITE, jobEnv: { GH_REPO: "" } }).findings.map(
				(f) => f.kind,
			),
		).toEqual(["missing-source"]);
	});

	it("keeps repository-independent commands out of the findings", () => {
		expect(probe({ run: "gh auth status" }).findings).toEqual([]);
		expect(probe({ run: "gh --version" }).findings).toEqual([]);
		// They are still in the population: the census read them, it just found
		// nothing to require.
		expect(probe({ run: "gh auth status" }).population).toEqual(["probe"]);
	});

	it("judges shared command positions instead of rejecting valid shell", () => {
		// R1: command position belongs to guard-bash, including keywords.
		for (const prefix of [
			"if",
			"do",
			"{",
			"!",
			"exec",
			"env GH_TOKEN=x",
			"command",
			"sudo",
			"then",
			"time",
		]) {
			expect(
				probe({ run: `${prefix} ${BARE_GH_WRITE} -R owner/repo` }).findings,
				prefix,
			).toEqual([]);
			expect(
				probe({ run: `${prefix} ${BARE_GH_WRITE}` }).findings.map(
					(f) => f.kind,
				),
				prefix,
			).toEqual(["missing-source"]);
		}
		for (const run of [
			`for x in 1; do ${BARE_GH_WRITE} -R o/r; done`,
			`if ${BARE_GH_WRITE} -R o/r; then echo ok; fi`,
			`(${BARE_GH_WRITE} -R o/r)`,
			...["&&", "||", ";", "|"].map(
				(op) => `echo x ${op} ${BARE_GH_WRITE} -R o/r`,
			),
		]) {
			expect(probe({ run }).findings, run).toEqual([]);
		}
	});

	it("uses effective environment for each invocation", () => {
		// R2/R5: a prefix and an `env` wrapper are the same command's own
		// environment, and a nearer empty binding clears an outer one. A `-c`
		// payload is a second shell, so it is reported, not read (row 25).
		for (const run of [
			`GH_REPO=owner/repo ${BARE_GH_WRITE}`,
			`env GH_REPO=owner/repo ${BARE_GH_WRITE}`,
		]) {
			expect(probe({ run }).findings, run).toEqual([]);
		}
		expect(
			probe({
				run: `bash -c 'GH_REPO=owner/repo ${BARE_GH_WRITE}'`,
			}).findings.map((found) => found.kind),
		).toEqual(["unclassified"]);
	});

	it("honors nearer empty repository bindings", () => {
		// R5: an empty override removes the farther source.
		for (const options of [
			{ jobEnv: { GH_REPO: "" } },
			{ stepEnv: { GH_REPO: "" } },
			{ stepEnv: { GH_REPO: "${{ '' }}" } },
			{ run: `GH_REPO="" ${BARE_GH_WRITE}` },
		]) {
			expect(
				probe({
					run: BARE_GH_WRITE,
					workflowEnv: { GH_REPO: "owner/repo" },
					...options,
				}).findings.map((f) => f.kind),
			).toEqual(["missing-source"]);
		}
	});

	it("requires bound repository operands", () => {
		// R4: an unset shell operand is empty at the live gh boundary.
		const run = `${BARE_GH_WRITE} --repo "$PATCH_REPO"`;
		expect(probe({ run }).findings.map((f) => f.kind)).toEqual([
			"missing-source",
		]);
		expect(
			probe({ run, stepEnv: { PATCH_REPO: "owner/repo" } }).findings,
		).toEqual([]);
	});

	it("reads the api endpoint rather than an option's value", () => {
		// `--input graphql` is a filename, not the endpoint: an option's value
		// cannot satisfy a placeholder the endpoint still has to resolve.
		for (const run of [
			`gh api 'repos/{owner}/{repo}/issues' --input graphql`,
			`gh api --input graphql 'repos/{owner}/{repo}/issues'`,
			`gh api 'repos/{owner}/{repo}/issues' -F body=@graphql`,
		])
			expect(
				probe({ run }).findings.map((f) => f.kind),
				run,
			).toEqual(["missing-source"]);
		// Boundary: a literal endpoint with an input file needs no repository.
		expect(
			probe({ run: "gh api repos/owner/repo/issues --input body.json" })
				.findings,
		).toEqual([]);
	});

	it("refuses an operand expansion the census cannot read", () => {
		// F8: only `$NAME`/`${NAME}` are modelled. Any other expansion
		// (`${VAR:-}`, `$1`, `${ARR[0]}`) leaves text the census cannot read, so
		// the operand is no source rather than a trusted non-empty value.
		for (const run of [
			`${BARE_GH_WRITE} --repo "\${PATCH_REPO:-}"`,
			`${BARE_GH_WRITE} --repo "$1"`,
			`${BARE_GH_WRITE} --repo "\${REPOS[0]}"`,
		])
			expect(
				probe({ run }).findings.map((f) => f.kind),
				run,
			).toEqual(["missing-source"]);
		// Boundary: a workflow expression is a declared source, not an
		// expansion the census failed to read.
		expect(
			probe({ run: `${BARE_GH_WRITE} --repo "\${{ github.repository }}"` })
				.findings,
		).toEqual([]);
	});

	it("requires repository operands to be provable slugs", () => {
		// F18: non-empty text is not a repository source; live gh rejects these
		// values during repository resolution.
		for (const run of [
			`${BARE_GH_WRITE} --repo not-a-slug`,
			`${BARE_GH_WRITE} --repo /`,
			`${BARE_GH_WRITE} --repo owner`,
			`${BARE_GH_WRITE} --repo .`,
			`${BARE_GH_WRITE} --repo "\${{ inputs.missing }}"`,
			`GH_REPO=not-a-slug ${BARE_GH_WRITE}`,
		]) {
			expect(
				probe({ run }).findings.map((found) => found.kind),
				run,
			).toEqual(["missing-source"]);
		}
		expect(
			probe({ run: `${BARE_GH_WRITE} --repo owner/repo` }).findings,
		).toEqual([]);
		expect(
			probe({
				run: `${BARE_GH_WRITE} --repo "\${{ env.GH_REPO }}"`,
				workflowEnv: { GH_REPO: "owner/repo" },
			}).findings,
		).toEqual([]);
	});

	it("does not let an explicit invalid repo operand be masked", () => {
		for (const run of [
			`${BARE_GH_WRITE} --repo owner/repo --repo not-a-slug`,
			`${BARE_GH_WRITE} -R owner/repo -R /`,
			`GH_REPO=owner/repo ${BARE_GH_WRITE} --repo not-a-slug`,
			`${BARE_GH_WRITE} --repo not-a-slug --repo owner/repo`,
		]) {
			const kinds = probe({ run }).findings.map((found) => found.kind);
			if (run.endsWith("owner/repo")) expect(kinds, run).toEqual([]);
			else expect(kinds, run).toEqual(["missing-source"]);
		}
	});

	it("reads an option's value as data, not as a repository option", () => {
		// Greptile r4307901275: `--body '--repo=not-a-slug'` is a body whose text
		// looks like an option, so a valid `--repo` before it still answers, and a
		// word after `--` never does.
		expect(
			probe({
				run: `${BARE_GH_WRITE} --repo owner/repo --body '--repo=not-a-slug'`,
			}).findings,
		).toEqual([]);
		expect(
			probe({
				run: `${BARE_GH_WRITE} --repo owner/repo --body '--repo not-a-slug'`,
			}).findings,
		).toEqual([]);
		// Nothing after `--` is an option, so an operand list cannot clear or
		// replace the declared repository.
		expect(
			probe({
				run: `GH_REPO=owner/repo ${BARE_GH_WRITE} -- data --repo=not-a-slug`,
			}).findings,
		).toEqual([]);
		expect(
			probe({ run: `${BARE_GH_WRITE} -- --repo=not-a-slug` }).findings.map(
				(found) => found.kind,
			),
		).toEqual(["missing-source"]);
	});

	it("refuses cyclic env repository expressions without throwing", () => {
		const workflowEnvs: Array<Record<string, string>> = [
			{ GH_REPO: "${{ env.GH_REPO }}" },
			{ GH_REPO: "${{ env.OTHER }}", OTHER: "${{ env.GH_REPO }}" },
		];
		for (const workflowEnv of workflowEnvs) {
			expect(
				probe({
					run: `${BARE_GH_WRITE} --repo "\${{ env.GH_REPO }}"`,
					workflowEnv,
				}).findings.map((found) => found.kind),
				JSON.stringify(workflowEnv),
			).toEqual(["missing-source"]);
		}
	});

	it("judges API endpoint shapes and placeholder requirements", () => {
		// R3: an endpoint root and GraphQL do not need cwd resolution.
		for (const run of [
			"gh api graphql -f query='{viewer{login}}'",
			"gh api repos/owner/repo --method PATCH -f x=y",
		]) {
			expect(probe({ run }).findings, run).toEqual([]);
		}
		expect(
			probe({ run: "gh api repos/{owner}/{repo}/issues/1" }).findings.map(
				(f) => f.kind,
			),
		).toEqual(["missing-source"]);
	});

	it("finds the api endpoint behind its options", () => {
		// R3/Greptile P2: the endpoint is not always words[2] -- options and their
		// values sit in front of it, and gh's global options sit in front of the
		// verb. Live gh 2.100.0 accepts every call below.
		for (const run of [
			"gh api -X POST repos/owner/repo/issues -f title=x",
			"gh api --paginate graphql -f q=x",
			"gh --hostname github.com api graphql -f q=x",
		]) {
			expect(probe({ run }).findings, run).toEqual([]);
		}
	});

	it("reports unsupported default command expansion", () => {
		// R6: a runtime fallback must not silently leave the population.
		expect(
			probe({ run: "${GH_BIN:-gh} pr edit 4550 --add-label x" }).findings.map(
				(f) => f.kind,
			),
		).toEqual(["unclassified"]);
	});

	it("reports an inline script the census cannot read", () => {
		// R9: each of these hands a `gh` write to an executor whose script text this
		// census cannot read. An empty population here reads as a clean workflow.
		// The payload only has to NAME a call: the census never runs it.
		for (const run of [
			`bash <<'EOF'\n${BARE_GH_WRITE}\nEOF`,
			`sh <<'EOF'\n${BARE_GH_WRITE}\nEOF`,
			`printf '%s\\n' '${BARE_GH_WRITE}' | bash`,
			`bash <(echo '${BARE_GH_WRITE}')`,
			`su -c '${BARE_GH_WRITE}'`,
			`node -e "console.log('${BARE_GH_WRITE}')"`,
			`python3 -c "import os; os.system('${BARE_GH_WRITE}')"`,
		]) {
			expect(
				probe({ run }).findings.map((f) => f.kind),
				run,
			).toEqual(["unclassified"]);
		}
	});

	it("reports an unreadable script in every gh spelling the census resolves", () => {
		// F7: the witness is the census's own command resolution, so a path
		// (`/usr/bin/gh`) and a declared variable (`$GH_BIN`) name the same call
		// a literal `gh` word does. A literal-word witness skipped both, and an
		// empty population reads as a clean workflow.
		for (const options of [
			{ run: `bash <<'EOF'\n/usr/bin/gh pr edit 4550 --add-label x\nEOF` },
			{
				run: `bash <<'EOF'\n$GH_BIN pr edit 4550 --add-label x\nEOF`,
				jobEnv: { GH_BIN: "gh" },
			},
			{
				run: `printf '%s\\n' '$GH_BIN pr edit 4550 --add-label x' | bash`,
				jobEnv: { GH_BIN: "gh" },
			},
			{ run: `su -c '/usr/bin/gh pr edit 4550 --add-label x'` },
			{
				run: `node -e "$GH_BIN pr edit 4550 --add-label x"`,
				jobEnv: { GH_BIN: "gh" },
			},
		]) {
			expect(
				probe(options).findings.map((f) => f.kind),
				JSON.stringify(options),
			).toEqual(["unclassified"]);
		}
	});

	it("refuses every unadmitted stdin-fed program", () => {
		for (const options of [
			{ run: `ruby <<EOF\n${BARE_GH_WRITE}\nEOF` },
			{ run: `perl - <<EOF\n${BARE_GH_WRITE}\nEOF` },
			{ run: `php <<'PHP'\n${BARE_GH_WRITE}\nPHP` },
			{ run: `osascript <<'AS'\n${BARE_GH_WRITE}\nAS` },
			{ run: `busybox sh <<EOF\n${BARE_GH_WRITE}\nEOF` },
			{ run: `env ruby <<EOF\n${BARE_GH_WRITE}\nEOF` },
			{ run: `exec ruby <<EOF\n${BARE_GH_WRITE}\nEOF` },
			{ run: `timeout 30 ruby <<EOF\n${BARE_GH_WRITE}\nEOF` },
			{ run: `$SH <<EOF\n${BARE_GH_WRITE}\nEOF`, stepEnv: { SH: "ruby" } },
		]) {
			expect(
				probe(options).findings.map((found) => found.kind),
				JSON.stringify(options),
			).toEqual(["unclassified"]);
		}
	});

	it("admits only data consumers for stdin-fed input", () => {
		for (const run of [
			`cat <<EOF\n${BARE_GH_WRITE}\nEOF`,
			`tee <<EOF\n${BARE_GH_WRITE}\nEOF`,
			`jq <<EOF\n${BARE_GH_WRITE}\nEOF`,
			`grep gh <<EOF\n${BARE_GH_WRITE}\nEOF`,
			`sed -n 1p <<EOF\n${BARE_GH_WRITE}\nEOF`,
			`awk '{print}' <<EOF\n${BARE_GH_WRITE}\nEOF`,
			// A bare `-` is the stdin operand, not a flag, and `--` ends options,
			// so a dash-led PATTERN after it is data (STATE_TABLE.md round 9).
			`cat - <<EOF\n${BARE_GH_WRITE}\nEOF`,
			`grep -q -- '-dash-led pattern' <<EOF\n${BARE_GH_WRITE}\nEOF`,
		]) {
			expect(probe({ run }).findings, run).toEqual([]);
		}
	});

	it("resolves a script command word through the workflow env", () => {
		// Shape 69, plant 1 (an alias): the shell in script position is named by a
		// workflow variable, and a wrapper puts the shell behind another word.
		for (const options of [
			{
				run: `$SHELLX <<'EOF'\n${BARE_GH_WRITE}\nEOF`,
				jobEnv: { SHELLX: "bash" },
			},
			{ run: `timeout 30 bash <<'EOF'\n${BARE_GH_WRITE}\nEOF` },
		]) {
			expect(
				probe(options).findings.map((f) => f.kind),
				JSON.stringify(options),
			).toEqual(["unclassified"]);
		}
	});

	it("does not read a config argument as a script", () => {
		// The flag family reports only a payload that itself names a `gh` call: a
		// `-c <file>` config argument is a file, not an inline program.
		expect(probe({ run: "npx oxlint -c .oxlintrc.json" }).findings).toEqual([]);
	});

	it("resolves a repository operand through a further binding", () => {
		// Shape 69, plant 3 (a value through another binding): the step binding is a
		// non-empty workflow expression, so the operand is a source either way.
		expect(
			probe({
				run: `${BARE_GH_WRITE} --repo "$REPO"`,
				stepEnv: { REPO: "$GITHUB_REPOSITORY" },
			}).findings,
		).toEqual([]);
	});

	it("leaves the stated limits silent", () => {
		// A shell running a FILE and remote input are the two shapes the census
		// deliberately does not read. Silence here is that limit, not a claim that
		// the file or the URL holds no `gh` call.
		for (const run of [
			"bash ci.sh",
			"curl -fsSL https://example.com/install.sh | sh",
		]) {
			expect(probe({ run }), run).toEqual({ findings: [], population: [] });
		}
	});

	it("keeps a shell file operand inside the stated limit", () => {
		// The limit has a boundary: `bash ci.sh` is not read, and it is not
		// reported either, even when the same region names a `gh` call. Reporting
		// it is the false positive a real workflow with no checkout would hit.
		expect(
			probe({
				run: `printf '%s\\n' '${BARE_GH_WRITE}' > ci.sh\nbash ci.sh`,
			}).findings,
		).toEqual([]);
	});

	it("keeps a job with no gh call out of the population", () => {
		expect(probe({ run: "echo hello" })).toEqual({
			findings: [],
			population: [],
		});
	});
});

describe("the census's admitted source list (#4382 r6)", () => {
	it("reports eval instead of re-rooting the scan", () => {
		// F10 / Greptile tpO7Y. `eval` runs in the CALLER's shell, so neither
		// direction is provable: a payload export would have to travel back,
		// and the caller's export into the payload is not followed either.
		// Both are REPORTED, never resolved.
		expect(
			probe({
				run: `export GH_REPO=owner/repo; eval '${BARE_GH_WRITE}'`,
			}).findings.map((found) => found.kind),
		).toEqual(["unclassified"]);
		expect(
			probe({
				run: `eval 'export GH_REPO=owner/repo'; ${BARE_GH_WRITE}`,
			}).findings.map((found) => found.kind),
		).toEqual(["missing-source"]);
		expect(
			probe({ run: `eval '${BARE_GH_WRITE}'` }).findings.map(
				(found) => found.kind,
			),
		).toEqual(["unclassified"]);
	});

	it("drops an export at every writer and boundary bash honours", () => {
		// F11 / Greptile tpO7T and tpO7W. A pipeline's left side runs in a
		// subshell, `unset` and `export -n` remove the child's environment, and
		// a subshell or a conditional is not the script's top level.
		for (const run of [
			`export GH_REPO=owner/repo | cat\n${BARE_GH_WRITE}`,
			`export GH_REPO=owner/repo\nunset GH_REPO\n${BARE_GH_WRITE}`,
			`export GH_REPO=owner/repo\nunset -v GH_REPO\n${BARE_GH_WRITE}`,
			`export GH_REPO=owner/repo\nexport -n GH_REPO\n${BARE_GH_WRITE}`,
			`export GH_REPO=owner/repo\nexport -n GH_REPO=owner/repo\n${BARE_GH_WRITE}`,
			`export GH_REPO=owner/repo; (${BARE_GH_WRITE})`,
			`export GH_REPO=owner/repo; if true; then ${BARE_GH_WRITE}; fi`,
			`export GH_REPO=owner/repo\nfor x in 1; do ${BARE_GH_WRITE}; done`,
		]) {
			expect(
				probe({ run }).findings.map((found) => found.kind),
				run,
			).toEqual(["missing-source"]);
		}
	});

	it("reads a single-quoted value as the literal text gh receives", () => {
		// F12 / Greptile tpO7a. Single quotes suppress expansion, so `$TARGET`
		// reaches gh as the five characters `$TARGET`, which is no repository --
		// even when a declared variable of that name has a value.
		expect(
			probe({
				run: `GH_REPO='$TARGET' ${BARE_GH_WRITE}`,
				stepEnv: { TARGET: "owner/repo" },
			}).findings.map((found) => found.kind),
		).toEqual(["missing-source"]);
		expect(
			probe({
				run: `TARGET=owner/repo; export GH_REPO='$TARGET'; ${BARE_GH_WRITE}`,
			}).findings.map((found) => found.kind),
		).toEqual(["missing-source"]);
		expect(
			probe({
				run: `${BARE_GH_WRITE} --repo '$TARGET'`,
				stepEnv: { TARGET: "owner/repo" },
			}).findings.map((found) => found.kind),
		).toEqual(["missing-source"]);
		// Boundary: a double-quoted reference is still a reference.
		expect(
			probe({
				run: `GH_REPO="$TARGET" ${BARE_GH_WRITE}`,
				stepEnv: { TARGET: "owner/repo" },
			}).findings,
		).toEqual([]);
		// Boundary: a single-quoted slug holds no `$`, so it is a literal source.
		for (const run of [
			`GH_REPO='owner/repo' ${BARE_GH_WRITE}`,
			`${BARE_GH_WRITE} --repo 'owner/repo'`,
		]) {
			expect(probe({ run }).findings, run).toEqual([]);
		}
	});

	it("asks the shared lexer for the heredoc witness", () => {
		// F13: the census's own command resolution reads the quoted spellings
		// `"g"h` and `\gh`, and an attached redirection (`bash<<EOF`) names the
		// same shell a spaced one does.
		for (const options of [
			{ run: `bash <<'EOF'\n"g"h pr edit 4550 --add-label x\nEOF` },
			{ run: `bash <<'EOF'\n\\gh pr edit 4550 --add-label x\nEOF` },
			{ run: `bash<<'EOF'\n/usr/bin/gh pr edit 4550 --add-label x\nEOF` },
		]) {
			expect(
				probe(options).findings.map((found) => found.kind),
				JSON.stringify(options),
			).toEqual(["unclassified"]);
		}
		// The same spelling as a command word is a call the census DOES read, so
		// it carries its own (absent) source finding rather than a report.
		expect(
			probe({ run: `'g'h pr edit 4550 --add-label x` }).findings.map(
				(found) => found.kind,
			),
		).toEqual(["missing-source"]);
	});

	it("reports a binding writer nobody listed", () => {
		// The plant: a form outside every list the brief names. `declare -x`
		// exports too, and this census does not model it, so the call is
		// unresolved rather than resolved.
		for (const run of [
			`declare -x GH_REPO=owner/repo; ${BARE_GH_WRITE}`,
			`source ./repo.env; ${BARE_GH_WRITE}`,
		]) {
			expect(
				probe({ run }).findings.map((found) => found.kind),
				run,
			).toEqual(["missing-source"]);
		}
	});

	it("drops a declared value the script rebinds", () => {
		// Greptile 10:51 (`Overwritten commands disappear`): a standalone
		// assignment replaces the declared value for every later expansion in
		// the same script, so the declared value no longer answers for it.
		// The census does not follow the new value, so both shapes report.
		expect(
			probe({
				run: `GH_BIN=gh\n$GH_BIN pr edit 4550 --add-label x`,
				stepEnv: { GH_BIN: "echo" },
			}).findings.map((found) => found.kind),
		).toEqual(["unclassified"]);
		expect(
			probe({
				run: `PATCH_REPO=not-a-slug\n${BARE_GH_WRITE} --repo "$PATCH_REPO"`,
				stepEnv: { PATCH_REPO: "owner/repo" },
			}).findings.map((found) => found.kind),
		).toEqual(["missing-source"]);
		// The other two writers rebind too: an `export` sets a new value, and
		// `unset` removes the declared one.
		expect(
			probe({
				run: `export GH_BIN=gh\n$GH_BIN pr edit 4550 --add-label x`,
				stepEnv: { GH_BIN: "echo" },
			}).findings.map((found) => found.kind),
		).toEqual(["unclassified"]);
		expect(
			probe({
				run: `unset PATCH_REPO\n${BARE_GH_WRITE} --repo "$PATCH_REPO"`,
				stepEnv: { PATCH_REPO: "owner/repo" },
			}).findings.map((found) => found.kind),
		).toEqual(["missing-source"]);
		// Boundary: a same-command prefix is scoped to its own command and
		// changes no expansion, so the declared value still answers.
		expect(
			probe({
				run: `PATCH_REPO=not-a-slug ${BARE_GH_WRITE} --repo "$PATCH_REPO"`,
				stepEnv: { PATCH_REPO: "owner/repo" },
			}).findings,
		).toEqual([]);
	});

	it("reads a heredoc after a single-quoted backslash", () => {
		// Greptile r4307901268: inside single quotes a backslash escapes nothing,
		// so `'x\'` closes at the quote and the heredoc after it is live.
		expect(
			probe({
				run: `python3 - 'x\\' <<EOF\n${BARE_GH_WRITE}\nEOF`,
			}).findings.map((found) => found.kind),
		).toEqual(["unclassified"]);
	});

	it("reads a quoted heredoc operator as argument text", () => {
		// Greptile 10:51 (`Printed examples fail CI`): `printf` prints a
		// string that happens to contain `<<`; no body was subtracted, so no
		// heredoc was handed to a shell and the call is judged normally.
		expect(
			probe({ run: `printf '%s\\n' 'bash<<EOF'; gh api user` }).findings,
		).toEqual([]);
		expect(probe({ run: `echo 'bash <<EOF'\ngh api user` }).findings).toEqual(
			[],
		);
		expect(
			probe({ run: `timeout 30 printf '%s\\n' 'bash<<EOF'; gh api user` })
				.findings,
		).toEqual([]);
		// Boundary: the same spelling as a real redirection is still reported.
		expect(
			probe({ run: `bash <<'EOF'\ngh api user\nEOF` }).findings.map(
				(found) => found.kind,
			),
		).toEqual(["unclassified"]);
	});

	it("invalidates an export when eval can rewrite GH_REPO", () => {
		for (const payload of ["unset GH_REPO", "export -n GH_REPO", "GH_REPO="]) {
			expect(
				probe({
					run: `export GH_REPO=owner/repo; eval '${payload}'; ${BARE_GH_WRITE}`,
				}).findings.map((found) => found.kind),
				payload,
			).toEqual(["missing-source"]);
		}
		expect(
			probe({
				run: `export GH_REPO=owner/repo; eval 'echo hi'; ${BARE_GH_WRITE}`,
			}).findings,
		).toEqual([]);
	});

	it("reads the command word on each side of a payload separator", () => {
		// Greptile 10:51 (`Nested calls disappear`): a quoted payload keeps its
		// own `;`/`|` separators, so the witness asks every simple command in
		// it, not only its first word.
		for (const payload of [
			"true;$GH_BIN pr edit 4550 --add-label x",
			"true && $GH_BIN pr edit 4550 --add-label x",
		]) {
			expect(
				probe({
					run: `bash -c '${payload}'`,
					stepEnv: { GH_BIN: "gh" },
				}).findings.map((found) => found.kind),
				payload,
			).toEqual(["unclassified"]);
		}
	});

	it("recognises a heredoc however its operator is spelled", () => {
		// Greptile 11:15: a spaced delimiter (`bash << EOF`) and an attached one
		// behind a wrapper (`timeout 30 bash<<'EOF'`) hand the same body to the
		// same shell, so they report the same way.
		for (const run of [
			`bash << EOF\n${BARE_GH_WRITE}\nEOF`,
			`sh <<-EOF\n${BARE_GH_WRITE}\nEOF`,
			`timeout 30 bash<<'EOF'\n${BARE_GH_WRITE}\nEOF`,
			`bash <<< '${BARE_GH_WRITE}'`,
		]) {
			expect(
				probe({ run }).findings.map((found) => found.kind),
				run,
			).toEqual(["unclassified"]);
		}
		// Boundary: a herestring with no call in it is silent, like any other
		// readable-looking payload with nothing to read.
		expect(probe({ run: `bash <<< 'echo hello'` }).findings).toEqual([]);
	});

	// Round 9 NEW-1/NEW-2: stdin must not hide executable program inputs. The
	// admitted forms are an enumerated set per program, so every external-program
	// flag refuses wherever it stands, and so does an unlisted flag.
	it.each([
		["inline sed", "sed -e 'e gh pr edit 4550 --add-label x' <<EOF\nhi\nEOF"],
		["sed short file", "sed -f - <<EOF\n1e gh pr edit 4550 --add-label x\nEOF"],
		[
			"sed long file",
			"sed --file=- <<EOF\n1e gh pr edit 4550 --add-label x\nEOF",
		],
		[
			"sed device",
			"sed -f /dev/stdin <<EOF\n1e gh pr edit 4550 --add-label x\nEOF",
		],
		[
			"sed file flag after the redirection",
			"sed <<EOF -f -\n1e gh pr edit 4550 --add-label x\nEOF",
		],
		[
			"sed unlisted flag",
			"sed -i 's/a/b/' <<EOF\n1e gh pr edit 4550 --add-label x\nEOF",
		],
		[
			"awk short file",
			'awk -f - <<EOF\nBEGIN{system("gh pr edit 4550 --add-label x")}\nEOF',
		],
		[
			"awk device",
			'awk -f /dev/stdin <<EOF\nBEGIN{system("gh pr edit 4550 --add-label x")}\nEOF',
		],
		["grep short file", "grep -qf - <<EOF\ngh pr edit 4550 --add-label x\nEOF"],
		[
			"inline sed over a herestring",
			"sed -e '1e gh pr edit 4550 --add-label x' <<< data",
		],
	])("refuses stdin program: %s", (_name, run) => {
		expect(
			probe({ run }).findings.map((found) => found.kind),
			run,
		).toEqual(["unclassified"]);
	});

	it("rejects every unread stdin-fed interpreter spelling", () => {
		// Round 7 plants: attached, leading, trailing, wrapped, and non-shell
		// interpreter stdin forms must not pass after their payload is subtracted.
		for (const run of [
			`bash <<EOF 2>&1\n${BARE_GH_WRITE}\nEOF`,
			`bash<<<'${BARE_GH_WRITE}'`,
			`<<EOF bash\n${BARE_GH_WRITE}\nEOF`,
			`timeout 30 bash <<EOF | cat\n${BARE_GH_WRITE}\nEOF`,
			`python3 - <<PY\n${BARE_GH_WRITE}\nPY`,
			`node <<'JS'\n${BARE_GH_WRITE}\nJS`,
		]) {
			expect(
				probe({ run }).findings.map((found) => found.kind),
				run,
			).toEqual(["unclassified"]);
		}
	});

	it("reports a nested shell program instead of reading it", () => {
		// Same shape 24 seam, one arm: a `-c` payload is a second shell with its
		// own argv, so it is reported whatever it contains.
		for (const options of [
			{ run: `bash -c '${BARE_GH_WRITE}'` },
			{ run: `bash -ec 'GH_REPO=owner/repo ${BARE_GH_WRITE}'` },
			{ run: `sh -c "${BARE_GH_WRITE}"` },
		]) {
			expect(
				probe(options).findings.map((found) => found.kind),
				JSON.stringify(options),
			).toEqual(["unclassified"]);
		}
	});
});
