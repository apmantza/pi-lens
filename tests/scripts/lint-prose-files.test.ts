// flake-shape: real-process-spawn — the prose selection shells out to real `git` against fixture repos, and the Lint prose step runs under real `bash` and `node`; an in-process double cannot prove the ACMR diff, a shallow checkout's unreadable base, git's quoted path names, or the step's exit-code wiring (#5249).
// #5249: every pull request inherited the `Lint (advisory)` prose red from
// Markdown it did not touch, because Vale linted the whole path list. The
// selection script (scripts/lint-prose-files.mjs) and the workflow step that
// runs it decide what Vale reads. Each case names the recurrence it keeps out.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { envFor, gitExecFileSync } from "../../scripts/lib/git-fixture-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts", "lint-prose-files.mjs");
// The path list the step always linted, in the order the step named it.
const WHOLE_LIST = [
	"docs",
	"AGENTS.md",
	"CLAUDE.md",
	"README.md",
	"CONTRIBUTING.md",
	".claude/agents",
	".changelog",
];
const WHOLE_OUTPUT = `${WHOLE_LIST.join("\n")}\n`;

type LintAdvisoryStep = { name?: string; run?: string };
const lintAdvisory = (
	yaml.load(
		fs.readFileSync(path.join(ROOT, ".github/workflows/lint.yml"), "utf8"),
	) as { jobs: Record<string, { steps?: LintAdvisoryStep[] }> }
).jobs["lint-advisory"];
const proseRun =
	lintAdvisory?.steps?.find((step) => step.name === "Lint prose")?.run ?? "";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
	return String(
		gitExecFileSync(
			[
				"-c",
				"user.email=pi-lens-test@example.com",
				"-c",
				"user.name=pi-lens-test",
				...args,
			],
			{ cwd: dir, encoding: "utf8" },
		),
	);
}

function write(dir: string, file: string, body: string): void {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), body);
}

// A base commit on `master` with `origin/master` pointing at it, then a
// `feature` commit holding the edits under test. Fixtures live under the
// git-ignored `.probe-home` (#4867), never on tmpfs.
function makeRepo(headEdits: (dir: string) => void): string {
	// process.cwd() is the repo root under vitest, as in changelog-entries.test.ts;
	// the containment scan (tests/config/tmp-fixture-hygiene.test.ts) reads that
	// spelling as a repo-rooted parent.
	fs.mkdirSync(path.join(process.cwd(), ".probe-home"), { recursive: true });
	const dir = fs.mkdtempSync(
		path.join(process.cwd(), ".probe-home", "lint-prose-"),
	);
	dirs.push(dir);
	git(dir, ["init", "-q", "-b", "master"]);
	write(dir, "README.md", "# Readme\n");
	write(dir, "AGENTS.md", "# Agents\n");
	write(dir, "docs/guide.md", "# Guide\n");
	write(dir, "docs/gone.md", "# Gone\n");
	write(dir, "clients/code.ts", "export const v = 1;\n");
	write(dir, "tests/fixtures/notes.md", "# Notes\n");
	write(dir, ".vale.ini", "StylesPath = .vale/styles\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-qm", "base"]);
	git(dir, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
	git(dir, ["checkout", "-q", "-b", "feature"]);
	headEdits(dir);
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-qm", "head"]);
	return dir;
}

// Moves master one commit past the branch point, as a later merge does, and
// repoints origin/master at it. The feature branch keeps its own base.
function advanceMaster(dir: string, edits: (dir: string) => void): void {
	git(dir, ["checkout", "-q", "master"]);
	edits(dir);
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-qm", "master"]);
	git(dir, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
	git(dir, ["checkout", "-q", "feature"]);
}

// Changed: a prose edit, an added prose file, a deleted prose file, and changes
// the filter must drop (a non-Markdown doc, code, and Markdown outside the list).
function changedRepo(): string {
	return makeRepo((dir) => {
		write(dir, "docs/guide.md", "# Guide\n\nEdited.\n");
		write(dir, "docs/new.md", "# New\n");
		fs.rmSync(path.join(dir, "docs/gone.md"));
		write(dir, "docs/picture.png", "not really a png\n");
		write(dir, "clients/code.ts", "export const v = 2;\n");
		write(dir, "tests/fixtures/notes.md", "# Notes\n\nEdited.\n");
	});
}

function noProseRepo(): string {
	return makeRepo((dir) => {
		write(dir, "clients/code.ts", "export const v = 2;\n");
		write(dir, "docs/picture.png", "not really a png\n");
		write(dir, "tests/fixtures/notes.md", "# Notes\n\nEdited.\n");
	});
}

function selection(dir: string, event: string) {
	const result = spawnSync(process.execPath, [SCRIPT, "--event", event], {
		cwd: dir,
		encoding: "utf8",
		env: envFor(dir, {}),
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function linkScripts(dir: string): void {
	fs.symlinkSync(path.join(ROOT, "scripts"), path.join(dir, "scripts"), "dir");
}

// Runs the workflow's own `Lint prose` run block under the runner's shell
// flags, with a recording `vale` stub in the working directory: the stub is
// the one process boundary, since the real binary is downloaded in CI.
function runProseStep(dir: string, event = "pull_request") {
	fs.writeFileSync(
		path.join(dir, "vale"),
		"#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > vale-args.txt\n",
		{ mode: 0o755 },
	);
	const result = spawnSync(
		"bash",
		["--noprofile", "--norc", "-eo", "pipefail", "-c", proseRun],
		{
			cwd: dir,
			encoding: "utf8",
			env: envFor(dir, { GITHUB_EVENT_NAME: event }),
		},
	);
	const argsFile = path.join(dir, "vale-args.txt");
	return {
		status: result.status,
		output: `${result.stdout}${result.stderr}`,
		vale: fs.existsSync(argsFile)
			? fs.readFileSync(argsFile, "utf8").split("\n").filter(Boolean)
			: null,
	};
}

describe("the prose selection on a pull request (#5249)", () => {
	// Recurrence: the whole-tree run. A PR that touched one doc linted all 123
	// files and inherited master's DateFormat red. Only the added or changed
	// Markdown under the prose paths is linted; deleted and non-Markdown files
	// and Markdown outside the list are not.
	it("lints only the Markdown the pull request adds or changes under the prose paths", () => {
		const result = selection(changedRepo(), "pull_request");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("docs/guide.md\ndocs/new.md\n");
	});

	// Recurrence: a PR that changes no prose must skip, not lint the whole tree
	// it did not touch. Empty stdout is the skip signal the step reads.
	it("prints nothing when the pull request changes no Markdown under the prose paths", () => {
		const result = selection(noProseRepo(), "pull_request");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
	});

	// Recurrence: the checkout depth. `actions/checkout` defaults to depth 1, and
	// a shallow clone cannot see origin/master, so the diff is unreadable. The
	// gate fails closed: the whole list, with the reason on stderr.
	it("falls back to the whole list, with the reason, when the base cannot be read", () => {
		const origin = changedRepo();
		const shallow = `${origin}-shallow`;
		dirs.push(shallow);
		gitExecFileSync(
			[
				"clone",
				"-q",
				"--depth",
				"1",
				"--branch",
				"feature",
				`file://${origin}`,
				shallow,
			],
			{ cwd: path.dirname(origin) },
		);
		const result = selection(shallow, "pull_request");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(WHOLE_OUTPUT);
		expect(result.stderr).toContain("cannot diff origin/master...HEAD");
	});

	// Recurrence: push and merge-queue runs (and dispatches, which the bot-PR
	// path uses) keep the whole tree. The diff is not read for them at all.
	it.each(["push", "merge_group", "workflow_dispatch"])(
		"lints the whole list on a %s run",
		(event) => {
			const result = selection(changedRepo(), event);
			expect(result.status).toBe(0);
			expect(result.stdout).toBe(WHOLE_OUTPUT);
		},
	);

	// Recurrence: fail-open on an unrecognized value. git quotes a path name with
	// non-ASCII bytes; the filter cannot read `"docs/caf\303\251.md"`, so it must
	// lint the whole list rather than drop the file.
	it("falls back to the whole list when git quotes a changed path name", () => {
		const dir = makeRepo((edit) => write(edit, "docs/café.md", "# Café\n"));
		const result = selection(dir, "pull_request");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(WHOLE_OUTPUT);
	});

	// Recurrence: a diff against master's tip (`origin/master..HEAD`) selects the
	// prose master changed after this branch point, which the pull request never
	// touched; the merge-base diff selects only the pull request's own files.
	it("diffs against the merge base, not master's tip, after master moves on", () => {
		const dir = changedRepo();
		advanceMaster(dir, (edit) =>
			write(edit, "AGENTS.md", "# Agents\n\nMaster edit.\n"),
		);
		const result = selection(dir, "pull_request");
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("docs/guide.md\ndocs/new.md\n");
	});

	// Recurrence: a rule change in Vale's config, its style files, the workflow or
	// the selection script re-judges every prose file. Selecting only the changed
	// Markdown would pass inherited findings the new rule now reports. A deleted
	// config file counts as a touch too, so the check reads the whole diff.
	it("lints the whole list when the pull request touches a lint config file", () => {
		const configEdits: Array<[string, (dir: string) => void]> = [
			[
				".vale.ini edited",
				(dir) =>
					write(
						dir,
						".vale.ini",
						"StylesPath = .vale/styles\nMinAlertLevel = error\n",
					),
			],
			[".vale.ini deleted", (dir) => fs.rmSync(path.join(dir, ".vale.ini"))],
			[
				".vale/styles added",
				(dir) =>
					write(
						dir,
						".vale/styles/Google/DateFormat.yml",
						"extends: existence\n",
					),
			],
			[
				"lint.yml edited",
				(dir) => write(dir, ".github/workflows/lint.yml", "name: Lint\n"),
			],
			[
				"selection script edited",
				(dir) => write(dir, "scripts/lint-prose-files.mjs", "// edited\n"),
			],
		];
		for (const [label, edit] of configEdits) {
			const dir = makeRepo((head) => {
				edit(head);
				write(head, "docs/guide.md", "# Guide\n\nEdited.\n");
			});
			const result = selection(dir, "pull_request");
			expect(result.status, label).toBe(0);
			expect(result.stdout, label).toBe(WHOLE_OUTPUT);
		}
	});
});

describe("the Lint prose step on a pull request (#5249)", () => {
	// Recurrence: Vale read the whole path list on every PR. The step hands Vale
	// exactly the changed files.
	it("hands Vale exactly the changed prose files", () => {
		const dir = changedRepo();
		linkScripts(dir);
		const step = runProseStep(dir);
		expect(step.status).toBe(0);
		expect(step.vale).toEqual(["docs/guide.md", "docs/new.md"]);
	});

	// Recurrence: a PR with no prose change ran Vale over the inherited docs and
	// reported their red. The step skips Vale with a notice instead.
	it("skips Vale with a notice when no prose changed", () => {
		const dir = noProseRepo();
		linkScripts(dir);
		const step = runProseStep(dir);
		expect(step.status).toBe(0);
		expect(step.vale).toBeNull();
		expect(step.output).toContain("::notice::");
	});

	// Recurrence: a process-substitution read (`mapfile < <(node ...)`) hides the
	// script's exit status, so a crashed selection read as "no prose changed" and
	// skipped Vale green. A selection that cannot run must fail the step.
	it("fails the step, and never skips Vale, when the selection script cannot run", () => {
		const dir = changedRepo();
		const step = runProseStep(dir);
		expect(step.status).not.toBe(0);
		expect(step.vale).toBeNull();
	});

	// Recurrence: a step that hard-codes the event (`--event pull_request`) diffs
	// on a push to master too, where the range is empty, so Vale skipped the whole
	// tree. The step reads the event from $GITHUB_EVENT_NAME: a push lints the list.
	it("hands Vale the whole list on a push run", () => {
		const dir = changedRepo();
		linkScripts(dir);
		const step = runProseStep(dir, "push");
		expect(step.status).toBe(0);
		expect(step.vale).toEqual(WHOLE_LIST);
	});
});
