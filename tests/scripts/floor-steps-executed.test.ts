// flake-shape: real-process-spawn — the subject is the shell text of the evaluated-floor steps in grammar-health.yml, ci.yml and lint.yml (exit-code mapping, `set +e`, a step output read by a later step, `| tee` under pipefail); only a real bash running the extracted `run:` shows that a swallowed status or a renamed step id reds the night. The one stand-in is a fake `node` on PATH at the process boundary for the producer being floored; the shell, tee and the real scripts/assert-evaluated.mjs are the real ones.
// lane: wall-clock-budget (serialized); no wall-clock assertion, each case is a
// few-millisecond shell run plus one short node start.
/**
 * Recurrence #4518 (review r1 F1): the Swift and APFS floor steps were pinned
 * by regexes over their text. Deleting `set +e`, hard-coding `code=0` and
 * renaming `id: swift` all stayed green, and each one reds (or lies on) the
 * nightly. These run the extracted step text under GitHub's shell for that
 * step (`bash -e {0}`, or `bash --noprofile --norc -eo pipefail {0}` when the
 * step names `shell: bash`) and chain a step's `$GITHUB_OUTPUT` into the next
 * step's `env` exactly as the runner does.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

type Step = {
	id?: string;
	name?: string;
	run?: string;
	shell?: string;
	env?: Record<string, string>;
};
type Workflow = { jobs: Record<string, { steps: Step[] }> };

const ROOT = path.resolve(import.meta.dirname, "../..");
const workflow = (file: string) =>
	yaml.load(
		fs.readFileSync(path.join(ROOT, ".github/workflows", file), "utf8"),
	) as Workflow;
const stepNamed = (wf: Workflow, job: string, needle: string): Step => {
	const found = wf.jobs[job].steps.find((s) => s.name?.includes(needle));
	if (!found) throw new Error(`${job}: no step named like "${needle}"`);
	return found;
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-floor-steps-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let counter = 0;
const scratch = () => {
	const dir = path.join(tmpRoot, `case-${counter++}`);
	fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
	return dir;
};

/** A `node` on PATH: `fakeBody` for the producer being floored, the real node otherwise. */
function fakeNode(dir: string, producer: string, fakeBody: string) {
	const file = path.join(dir, "bin", "node");
	fs.writeFileSync(
		file,
		`#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.0.0; exit 0; fi\ncase "$1" in\n  ${producer}) ${fakeBody} ;;\n  *) exec "$REAL_NODE" "$@" ;;\nesac\n`,
		{ mode: 0o755 },
	);
}

function runStep(
	step: Step,
	dir: string,
	env: Record<string, string>,
	cwd: string = ROOT,
) {
	const file = path.join(dir, "step.sh");
	fs.writeFileSync(file, step.run ?? "");
	const args =
		step.shell === "bash"
			? ["--noprofile", "--norc", "-eo", "pipefail", file]
			: ["-e", file];
	return spawnSync("bash", args, {
		cwd,
		env: {
			PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`,
			REAL_NODE: process.execPath,
			RUNNER_TEMP: dir,
			...env,
		},
		encoding: "utf8",
	});
}

/** `${{ steps.<id>.outputs.<name> }}` inside a `run:` body, resolved before the script runs. */
function resolveInline(
	run: string,
	stepId: string | undefined,
	outputs: Record<string, string>,
) {
	return run.replaceAll(
		/\$\{\{\s*steps\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}/g,
		(whole: string, id: string, name: string) =>
			id === stepId ? (outputs[name] ?? "") : whole,
	);
}

/** `${{ steps.<id>.outputs.<name> }}` against the outputs the earlier step wrote. */
function resolveOutput(
	expression: string | undefined,
	stepId: string | undefined,
	outputs: Record<string, string>,
) {
	const m = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}$/.exec(
		expression ?? "",
	);
	return m && m[1] === stepId ? (outputs[m[2]] ?? "") : "";
}

describe("grammar-health Swift crash-watch, executed (#4518)", () => {
	const wf = workflow("grammar-health.yml");
	const watch = stepNamed(wf, "swift-crash-watch", "Force-load swift");
	const floor = stepNamed(
		wf,
		"swift-crash-watch",
		"Swift crash-watch evaluated floor",
	);

	function night(childExit: number) {
		const dir = scratch();
		fakeNode(dir, "scripts/check-grammar-load.mjs", `exit ${childExit}`);
		const out = path.join(dir, "output.txt");
		const summary = path.join(dir, "summary.md");
		fs.writeFileSync(out, "");
		fs.writeFileSync(summary, "");
		const first = runStep(watch, dir, {
			GITHUB_OUTPUT: out,
			GITHUB_STEP_SUMMARY: summary,
			PILENS_UNSAFE_FORCE_GRAMMAR_LOAD: "1",
		});
		const outputs = Object.fromEntries(
			fs
				.readFileSync(out, "utf8")
				.split("\n")
				.filter((l) => l.includes("="))
				.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
		);
		const second = runStep(floor, dir, {
			EVALUATED: resolveOutput(floor.env?.EVALUATED, watch.id, outputs),
		});
		return {
			first,
			outputs,
			second,
			summary: fs.readFileSync(summary, "utf8"),
		};
	}

	// Recurrence: the nightly's sanctioned outcomes. Exit 0 = the lift signal;
	// 2 (runtime unavailable) and 3 (grammar did not load) evaluated nothing;
	// 1 and any signal status (133 is the V8 trap seen on run 38886589847) are
	// the known #423 crash and DO count as evaluated.
	it.each([
		[0, "1", 0, true],
		[1, "1", 0, false],
		[2, "0", 1, false],
		[3, "0", 1, false],
		[133, "1", 0, false],
		[134, "1", 0, false],
	])(
		"child exit %i: evaluated=%s, floor step exit %i, lift notice %s",
		(childExit, evaluated, floorExit, lifted) => {
			const result = night(childExit);
			// `set +e`: a crashing child must not kill the step under `bash -e`.
			expect(result.first.status, result.first.stderr).toBe(0);
			expect(result.outputs.evaluated).toBe(evaluated);
			// #4518: the run's own log states the count, not only the step output
			// the floor step reads. The record the floor prints is JSON, so a log
			// search for `evaluated=` found only the step's echoed script text.
			expect(result.first.stdout).toContain(`evaluated=${evaluated}`);
			expect(result.second.status, result.second.stderr).toBe(floorExit);
			expect(
				result.first.stdout.includes("::notice title=Swift crash-watch::"),
			).toBe(lifted);
			expect(result.summary.includes("can be lifted")).toBe(lifted);
		},
	);

	// Recurrence: renaming `id: swift` left the floor step reading an empty
	// output, which reds every night.
	it("reads the output of the step that writes it (the ids line up)", () => {
		expect(floor.env?.EVALUATED).toBe(
			`\${{ steps.${watch.id}.outputs.evaluated }}`,
		);
	});
});

describe("ci.yml APFS floor step, executed (#4518)", () => {
	const step = stepNamed(
		workflow("ci.yml"),
		"install-test",
		"APFS anchors evaluated floor",
	);
	const floor = Number(/--floor (\d+)/.exec(step.run ?? "")?.[1]);

	function leg(report: string | null) {
		const dir = scratch();
		fakeNode(dir, "__never__", "exit 99");
		if (report !== null)
			fs.writeFileSync(path.join(dir, "apfs-anchors.json"), report);
		return runStep(step, dir, {});
	}
	const tests = (passed: number, failed = 0) =>
		JSON.stringify({ numPassedTests: passed, numFailedTests: failed });

	// Recurrence: a leg that executed nothing reading as an ordinary advisory
	// red, or green when vitest's filter matched nothing.
	it.each([
		["no reporter file", null],
		["truncated JSON", '{"numPassedTests":'],
		["zero tests executed", tests(0)],
		["one under the floor", tests(floor - 1)],
	])("reds the leg: %s", (_label, report) => {
		expect(leg(report).status).toBe(1);
	});

	it("passes at the floor, and counts failed tests as executed (the results stay advisory)", () => {
		expect(leg(tests(floor)).status).toBe(0);
		expect(leg(tests(floor - 10, 10)).status).toBe(0);
	});
});

describe("ci.yml Windows subset floor, executed (#4518)", () => {
	const step = stepNamed(
		workflow("ci.yml"),
		"unit-tests-windows",
		"under-executed",
	);
	const floor = Number(/--floor (\d+)/.exec(step.run ?? "")?.[1]);

	function leg(outcome: string, log: string | null) {
		const dir = scratch();
		fakeNode(dir, "__never__", "exit 99");
		if (log !== null)
			fs.writeFileSync(path.join(dir, "windows-vitest.log"), log);
		return runStep(
			{
				...step,
				run: (step.run ?? "").replaceAll(
					"${{ steps.windows-vitest.outcome }}",
					outcome,
				),
			},
			dir,
			{},
		);
	}

	// Recurrence: the follow-up read only `outcome == failure`, so a subset whose
	// files all skipped (or whose log lost its summary) was green.
	it.each([
		["all files skipped", "      Tests  26 skipped (26)\n"],
		["no summary", "Vitest crashed\n"],
		["below the floor", `      Tests  ${floor - 1} passed (${floor - 1})\n`],
		["no log at all", null],
	])("reds a green outcome when the log shows: %s", (_label, log) => {
		const result = leg("success", log);
		expect(result.status).toBe(1);
		// The named reason must survive: dropping `|| true` aborts the assignment
		// under `bash -e` with the same status but no floor annotation.
		expect(result.stderr).toContain(
			"::error title=nightly evaluated floor::windows-vitest:",
		);
	});

	it("passes a green outcome that executed at least the floor", () => {
		expect(
			leg(
				"success",
				`      Tests  ${floor} passed | 26 skipped (${floor + 26})\n`,
			).status,
		).toBe(0);
	});

	it("still reds a failed outcome first", () => {
		const result = leg(
			"failure",
			"      Tests  3 failed | 2516 passed (2519)\n",
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("::error title=Windows Vitest subset::3");
	});
});

describe("lint.yml advisory report pipes, executed (#4518)", () => {
	const wf = workflow("lint.yml");

	// Recurrence: the default shell has no pipefail, so `script | tee` took
	// tee's status and a script that crashed read green.
	it.each([
		["complexity", "Generate complexity report"],
		["strictness", "Generate strictness report"],
	])(
		"%s: a failing report script fails the step, a passing one does not",
		(tool, name) => {
			const step = stepNamed(wf, "lint-advisory", name);
			for (const [code, expected] of [
				[1, 1],
				[0, 0],
			] as const) {
				const dir = scratch();
				fakeNode(
					dir,
					`scripts/${tool}-report.mjs`,
					`echo report; exit ${code}`,
				);
				const result = runStep(step, dir, {}, dir);
				expect(result.status, `${tool} child ${code}: ${result.stderr}`).toBe(
					expected,
				);
			}
		},
	);
});

describe("stryker-pertest candidates floor, executed (#4518)", () => {
	const wf = workflow("stryker-pertest.yml");
	const candidates = stepNamed(wf, "mutate", "List tests that kill no mutant");
	const mutate = stepNamed(wf, "mutate", "Mutate the module");

	// The report shape Stryker's mutation-test-report helper writes. Two killed
	// mutants is a run that evaluated something; `{"files":{}}` is what an empty
	// mutant list becomes (`reportAll([])` -> `files: {}`), which Stryker reaches
	// on exit 0 when the mutated range holds nothing to mutate.
	const evaluated = JSON.stringify({
		files: {
			"clients/run-duration.js": {
				mutants: [
					{ id: "1", status: "Killed", coveredBy: ["t1"], killedBy: ["t1"] },
					{ id: "2", status: "Killed", coveredBy: ["t1"], killedBy: ["t1"] },
				],
			},
		},
		testFiles: {
			"tests/clients/run-duration.test.ts": {
				tests: [{ id: "t1", name: "reads the median" }],
			},
		},
	});

	/**
	 * The step runs `scripts/stryker-pertest.mjs` and `scripts/assert-evaluated.mjs`
	 * by repo-relative path from the scratch cwd. A `node` on PATH maps those to the
	 * real files and leaves every other argv shape to the real node: both subjects
	 * stay real, and their module-URL entry guards still match an absolute argv[1].
	 */
	function run(report: string | null) {
		const dir = scratch();
		fakeNode(
			dir,
			"scripts/*",
			'f="$1"; shift; exec "$REAL_NODE" "$REPO_ROOT/$f" "$@"',
		);
		if (report !== null) {
			fs.mkdirSync(path.join(dir, "reports", "mutation"), { recursive: true });
			fs.writeFileSync(
				path.join(dir, "reports", "mutation", "pertest.json"),
				report,
			);
		}
		const summary = path.join(dir, "summary.md");
		fs.writeFileSync(summary, "");
		const result = runStep(
			{
				...candidates,
				run: resolveInline(candidates.run ?? "", mutate.id, {
					wall_seconds: "42",
				}),
			},
			dir,
			{
				MODULE: "clients/run-duration.ts",
				REPO_ROOT: ROOT,
				GITHUB_STEP_SUMMARY: summary,
			},
			dir,
		);
		return { result, summary: fs.readFileSync(summary, "utf8") };
	}

	// Recurrence (#4518): a producer under `continue-on-error` that evaluated
	// nothing read green. The report's PRESENCE is not the population: Stryker
	// writes `{"files":{}}` and exits 0 for a range with nothing to mutate, and
	// the candidates file then says every test killed a mutant.
	it.each([
		["no report at all", null],
		["an empty report", '{"files":{}}'],
		[
			"a report with an empty mutants list",
			'{"files":{"clients/run-duration.js":{"mutants":[]}}}',
		],
		["a truncated report", '{"files":'],
	])("reds the step for %s", (_label, report) => {
		expect(run(report).result.status).toBe(1);
	});

	it("passes a report that holds an evaluated mutant", () => {
		const { result } = run(evaluated);
		expect(result.status, result.stderr).toBe(0);
	});

	// N1: the red path printed only an ::error::, so the run's summary page was
	// empty. The shared floor seam writes a row naming the count and the floor.
	it("names the count and the floor on the step summary it reds on", () => {
		expect(run('{"files":{}}').summary).toContain(
			"| stryker-pertest | 0 | 1 |",
		);
		expect(run(null).summary).toContain("| stryker-pertest | 0 | 1 |");
	});

	// The candidates table, the dropped-file note and the wall time survive a
	// green run in this order; a red one never claims every test killed a mutant.
	it("writes the candidates table and the wall time only for a green run", () => {
		const green = run(evaluated).summary;
		expect(green).toContain("Mutants: total: 2");
		expect(green).toContain("wall seconds: 42");
		expect(run('{"files":{}}').summary).not.toContain(
			"kills at least one mutant",
		);
	});

	// Recurrence: renaming `id: stryker` leaves the wall-time line reading an
	// empty output under `set -u`; the ids must line up as in the Swift case.
	it("resolves the wall time from the step that writes it", () => {
		expect(candidates.run).toContain(
			`\${{ steps.${mutate.id}.outputs.wall_seconds }}`,
		);
	});
});
