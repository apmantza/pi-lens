// flake-shape: real-process-spawn — the committed CLI entry (`node scripts/dispatch-safety.mjs`) is the subject of the last describe: its main-module guard, stdout/stderr split and exit code are what a maintainer's dispatch decision reads, and an in-process call of runCli cannot prove the entry wiring.
// #4076 review r2 (D2): scripts/dispatch-safety.mjs answers "does a dispatch of
// this workflow on this ref reach a write-scoped job". The first version read
// the job `if:` with a substring check, so six spoofed guards read as skipping
// the job while a branch dispatch still ran it, `--ref=x` was read as master and
// nothing exercised the CLI. It now shares the census' guard parser
// (tests/config/workflow-writers-governance.test.ts imports the same `guardOf`);
// each case below names the misreading it keeps out.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, runCli } from "../../scripts/dispatch-safety.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const FIXTURES = "tests/fixtures/dispatch-safety";
const JOBS = `${FIXTURES}/jobs.yml`;
const SCRIPT = resolve(ROOT, "scripts/dispatch-safety.mjs");

type Row = { job: string; guardSkips: boolean; writeScopes: string[] };

function rows(argv: string[]): Record<string, Row> {
	const result = runCli(argv, ROOT);
	expect(result.stderr).toEqual([]);
	expect(result.code).toBe(0);
	return Object.fromEntries(
		result.stdout
			.map((line) => JSON.parse(line) as Row)
			.map((row) => [row.job.split(":").pop() as string, row]),
	);
}

describe("dispatch-safety guardSkips on a branch dispatch (#4076 D2)", () => {
	const onBranch = rows([JOBS, "--ref", "feature-x"]);

	// Recurrence: a real guard skips the whole job on a branch dispatch.
	// Recurrence: #5062 made ci.yml dispatchable, and its pull_request-only CodeQL
	// job (`security-events: write`) read as runnable on a dispatch.
	it.each(["guarded", "schedule-only", "master-only", "pull-request-only"])(
		"reports %s as skipped",
		(job) => {
			expect(onBranch[job].guardSkips).toBe(true);
		},
	);

	// Recurrence: `guardSkipsOnRef` was a substring check on the job `if:`, so each
	// of these read as skipping the job while GitHub still ran it on a branch
	// dispatch with the write token. The census parser rejects all of them.
	it.each([
		"always-or-guard",
		"input-or-guard",
		"negated-guard",
		"format-wrapped",
		"compared-to-false",
		"schedule-or-input",
		"pull-request-or-input",
	])("does not report the spoofed guard %s as skipped", (job) => {
		expect(onBranch[job].guardSkips).toBe(false);
	});

	// Recurrence: a step-level guard never skips the job, so its write token is
	// still held; and a job with no `if:` always runs.
	it.each(["step-guard-only", "no-guard", "read-only"])(
		"does not report %s as skipped",
		(job) => {
			expect(onBranch[job].guardSkips).toBe(false);
		},
	);

	it("reports the write scopes the census resolves, per job", () => {
		expect(onBranch.guarded.writeScopes).toEqual(["issues"]);
		expect(onBranch["read-only"].writeScopes).toEqual([]);
		expect(Object.keys(onBranch)).toHaveLength(14);
	});
});

describe("dispatch-safety on a master dispatch", () => {
	// Recurrence: the first version treated any guard text as "runs on master";
	// a `schedule`-only guard skips every dispatch, master included.
	it("runs the schedule-or-master and master-only guards and skips the schedule-only one", () => {
		const onMaster = rows([JOBS]);
		expect(onMaster.guarded.guardSkips).toBe(false);
		expect(onMaster["master-only"].guardSkips).toBe(false);
		expect(onMaster["schedule-only"].guardSkips).toBe(true);
		expect(onMaster["pull-request-only"].guardSkips).toBe(true);
	});

	// Recurrence: `--ref=x` was parsed as "no flag" and answered for master.
	it.each([
		["--ref master", ["--ref", "master"]],
		["--ref=master", ["--ref=master"]],
		["--ref refs/heads/master", ["--ref", "refs/heads/master"]],
		["--ref=refs/heads/master", ["--ref=refs/heads/master"]],
	])("reads %s as the master ref", (_label, ref) => {
		expect(rows([JOBS, ...ref]).guarded.guardSkips).toBe(false);
	});

	it.each([
		["--ref=feature-x", ["--ref=feature-x"]],
		["--ref feature-x", ["--ref", "feature-x"]],
		["a tag ref", ["--ref", "refs/tags/v1"]],
		["a master-prefixed branch", ["--ref=master-2"]],
	])("reads %s as not master", (_label, ref) => {
		expect(rows([JOBS, ...ref]).guarded.guardSkips).toBe(true);
	});

	it("takes the flag before the file too", () => {
		expect(rows(["--ref=feature-x", JOBS]).guarded.guardSkips).toBe(true);
	});
});

describe("dispatch-safety argument and file errors", () => {
	it.each([
		["no arguments", [], /missing workflow file/],
		["a ref flag with no value", [JOBS, "--ref"], /--ref needs a branch name/],
		["an empty --ref=", [JOBS, "--ref="], /--ref needs a branch name/],
		["a flag as the ref value", [JOBS, "--ref", "--x"], /--ref needs/],
		["an unknown option", [JOBS, "--verbose"], /unknown option --verbose/],
		["a second file", [JOBS, JOBS], /unexpected argument/],
	])("exits 2 with a usage line for %s", (_label, argv, message) => {
		const result = runCli(argv, ROOT);
		expect(result.code).toBe(2);
		expect(result.stdout).toEqual([]);
		expect(result.stderr.join("\n")).toMatch(message);
		expect(result.stderr.join("\n")).toContain(
			"usage: node scripts/dispatch-safety.mjs",
		);
	});

	// Recurrence: a missing file printed a stack trace and exited 1.
	it("exits 2 with one clear line for a missing file", () => {
		const result = runCli([`${FIXTURES}/absent.yml`], ROOT);
		expect(result.code).toBe(2);
		expect(result.stderr).toHaveLength(1);
		expect(result.stderr[0]).toMatch(/^cannot read .*absent\.yml: ENOENT/);
		expect(result.stderr[0]).not.toMatch(/\n\s+at /);
	});

	it("exits 2 for unparseable YAML", () => {
		const result = runCli([`${FIXTURES}/broken.yml`], ROOT);
		expect(result.code).toBe(2);
		expect(result.stderr[0]).toMatch(/^cannot read .*broken\.yml: /);
	});

	// Recurrence: a workflow with no `workflow_dispatch` printed nothing and
	// exited 0, which a caller cannot tell from "no job writes".
	it("says so on stderr for a workflow that cannot be dispatched", () => {
		const result = runCli([`${FIXTURES}/push-only.yml`], ROOT);
		expect(result.code).toBe(0);
		expect(result.stdout).toEqual([]);
		expect(result.stderr[0]).toContain("no workflow_dispatch trigger");
	});

	it("lets the last --ref win", () => {
		expect(parseArgs([JOBS, "--ref=a", "--ref=b"])).toEqual({
			file: JOBS,
			ref: "b",
		});
	});
});

describe("dispatch-safety real CLI entry", () => {
	const spawn = (args: string[]) =>
		spawnSync(process.execPath, [SCRIPT, ...args], {
			cwd: ROOT,
			encoding: "utf8",
			timeout: 30_000,
		});

	it("prints one JSON line per job to stdout and exits 0", () => {
		const result = spawn([JOBS, "--ref=feature-x"]);
		expect(result.status).toBe(0);
		const parsed = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Row);
		expect(parsed.find((row) => row.job.endsWith(":guarded"))?.guardSkips).toBe(
			true,
		);
		expect(
			parsed.find((row) => row.job.endsWith(":always-or-guard"))?.guardSkips,
		).toBe(false);
	});

	it("exits 2 on a missing file without a stack trace", () => {
		const result = spawn([`${FIXTURES}/absent.yml`]);
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/cannot read .*absent\.yml: ENOENT/);
		expect(result.stderr).not.toMatch(/\n\s+at /);
	});
});
