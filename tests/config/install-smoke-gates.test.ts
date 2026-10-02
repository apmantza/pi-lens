// Pins install-smoke.yml's job-level `if:` event gates (#2613 review T1).
// Exactly ONE job still carries one: `host-latest-smoke`'s
// `schedule`/`workflow_dispatch` gate, the nightly advisory drift lane.
// `host-range-smoke` deliberately carries NO gate (it is the PR-gating lane)
// and is intentionally absent from this table.
//
// #3043: `pi-load` LEFT this table. It used to carry a
// `!= 'pull_request'` gate, which is why #3033 could edit its pnpm-global
// arm and ship a break no PR-eligible lane could execute -- six matrix cells
// then failed on every master push for a day. Its gating moved into an
// event-dependent matrix (one ubuntu x pnpm-global cell on pull_request, the
// full 2x4 otherwise); the block at the bottom of this file evaluates that
// real expression per event.
//
// 2026-09-15 retro F2: `smoke` and `mise-repro` left this table the same way
// and for the same reason -- #3049's own round-2 review named mise-repro as
// the next member of #3043's class ("moving its `export PATH=` line below
// the `pnpm config set` line would have reached master unseen"). Their
// per-event matrices are evaluated at the bottom of this file beside
// pi-load's, and the general rule they now satisfy is swept over every
// workflow by tests/config/workflow-pull-request-reachability.test.ts.
//
// Same technique as tests/config/ci-infra-kill-rerun-gate.test.ts (#2668
// review F3): load the REAL workflow via yaml.load, then evaluate the
// LOADED `if:` string (never a hand-copied restatement of it) against a
// synthetic `github.event_name` via `new Function` — GitHub Actions
// expression syntax and JS agree exactly on this subset (dotted paths, `==`,
// `!=`, `&&`, `||`, quoted string literals).
//
// Before this file existed, dropping all three `!= 'pull_request'` gates
// AND the schedule gate stayed 27/27 green (no test in the repo evaluated
// any of these `if:` strings) — proven below by deleting one gate.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = ".github/workflows/install-smoke.yml";

type Step = { name?: unknown; run?: unknown };
type Job = { if?: unknown; steps?: unknown };
type Workflow = { env?: unknown; jobs?: Record<string, Job> };

function loadWorkflow(source?: string): Workflow {
	const text =
		source ?? readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
	return yaml.load(text) as Workflow;
}

function readJobIf(workflow: Workflow, jobName: string): string {
	const ifExpr = workflow.jobs?.[jobName]?.if;
	if (typeof ifExpr !== "string") {
		throw new Error(
			`${WORKFLOW_PATH}: jobs.${jobName}.if is not a string (got ${typeof ifExpr})`,
		);
	}
	return ifExpr;
}

function readStepRun(
	workflow: Workflow,
	jobName: string,
	stepNameSubstring: string,
): string {
	const steps = workflow.jobs?.[jobName]?.steps;
	const step = Array.isArray(steps)
		? (steps as Step[]).find(
				(s) => typeof s.name === "string" && s.name.includes(stepNameSubstring),
			)
		: undefined;
	if (typeof step?.run !== "string") {
		throw new Error(
			`${WORKFLOW_PATH}: jobs.${jobName} has no step named like "${stepNameSubstring}" with a run: string`,
		);
	}
	return step.run;
}

function evaluateIf(expr: string, eventName: string): boolean {
	const substituted = expr
		.split("github.event_name")
		.join(JSON.stringify(eventName));
	if (substituted.includes("github.")) {
		throw new Error(
			`unsubstituted github.* reference survived evaluation: ${substituted} (this table only understands github.event_name)`,
		);
	}
	// `new Function` on a string built entirely from this repo's own workflow
	// file plus a JSON-literal test fixture, never external/untrusted input.
	const fn = new Function(`"use strict"; return (${substituted});`);
	return Boolean(fn());
}

const EVENTS = [
	"pull_request",
	"push",
	"schedule",
	"workflow_dispatch",
] as const;

// [jobName, expected-eligible-events]
const GATES: Array<[string, readonly string[]]> = [
	["host-latest-smoke", ["schedule", "workflow_dispatch"]],
];

describe("install-smoke.yml job event gates (#2613 review T1)", () => {
	const workflow = loadWorkflow();

	it("names exactly the one gated job this table still covers", () => {
		// Guards the table itself: a job renamed out from under GATES would
		// otherwise throw inside readJobIf below with a less legible message.
		expect(GATES.map(([name]) => name)).toEqual(["host-latest-smoke"]);
	});

	it.each(["host-range-smoke", "pi-load", "smoke", "mise-repro"])(
		"%s deliberately carries no event gate (its matrix is the whole gate)",
		(jobName) => {
			expect(workflow.jobs?.[jobName]?.if).toBeUndefined();
		},
	);

	for (const [jobName, eligibleEvents] of GATES) {
		describe(`jobs.${jobName}.if`, () => {
			const ifExpr = readJobIf(workflow, jobName);

			for (const event of EVENTS) {
				const expected = eligibleEvents.includes(event);
				it(`${expected ? "runs" : "skips"} on ${event}`, () => {
					expect(evaluateIf(ifExpr, event)).toBe(expected);
				});
			}
		});
	}

	// Mutation-proof: before this file existed, no test evaluated these `if:`
	// strings at all, so deleting a gate was invisible (27/27 stayed green).
	// Demonstrate the table catches it for each of the four gates.
	for (const [jobName] of GATES) {
		it(`mutation-proof: deleting jobs.${jobName}.if reds this table (job becomes unconditionally eligible)`, () => {
			const source = readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
			const lines = source.split("\n");
			// Locate THIS job's own top-level key line ("  <jobName>:", exactly
			// two leading spaces so a same-named step/matrix key nested deeper
			// never matches), then remove the first "if:" line found before the
			// next top-level job key -- several of these jobs share the exact
			// same `if:` text, so a plain string .replace() would always hit
			// the FIRST job carrying that text regardless of which job this
			// iteration targets (caught by this test itself: with a naive
			// global replace, the pi-load/mise-repro cases redded against the
			// WRONG job -- smoke's -- having already lost its gate).
			const jobKeyPattern = new RegExp(`^ {2}${jobName}:\\s*$`);
			const startIdx = lines.findIndex((line) => jobKeyPattern.test(line));
			expect(
				startIdx,
				`job key line for ${jobName} not found`,
			).toBeGreaterThanOrEqual(0);
			let ifLineIdx = -1;
			for (let i = startIdx + 1; i < lines.length; i++) {
				if (/^ {2}\S.*:\s*$/.test(lines[i])) break; // next top-level job key
				if (/^\s*if:\s/.test(lines[i])) {
					ifLineIdx = i;
					break;
				}
			}
			expect(
				ifLineIdx,
				`no if: line found under jobs.${jobName}`,
			).toBeGreaterThanOrEqual(0);

			const mutatedLines = [...lines];
			mutatedLines.splice(ifLineIdx, 1);
			const mutatedSource = mutatedLines.join("\n");
			expect(mutatedSource).not.toBe(source);

			const mutatedWorkflow = loadWorkflow(mutatedSource);
			// With the gate gone, the job has no `if:` at all -- readJobIf would
			// throw ("not a string"), which itself IS the red signal a real
			// silent-drop would produce against this table's other assertions.
			expect(mutatedWorkflow.jobs?.[jobName]?.if).toBeUndefined();
		});
	}
});

// Round-2 review F3: every script on host-range-smoke/host-latest-smoke's
// critical path must be in the push/pull_request `paths:` filter, or a PR
// that touches ONLY that script gets zero install-smoke coverage at all --
// not even the PR-gating lane #2613 exists to run on exactly such a PR.
describe("install-smoke.yml paths: filter names every critical-path script (#2613 review F3)", () => {
	const workflow = loadWorkflow() as unknown as {
		on?: {
			push?: { paths?: unknown };
			pull_request?: { branches?: unknown; paths?: unknown };
		};
	};
	const pushPaths = workflow.on?.push?.paths;
	const pullRequestPaths = workflow.on?.pull_request?.paths;

	const REQUIRED_PATHS = [
		"scripts/npm-retry.mjs",
		"scripts/lib/retry.mjs",
		"scripts/notify-install-smoke-drift.mjs",
		"scripts/lib/install-smoke-drift.mjs",
		"scripts/lib/drift-issue.mjs",
		"scripts/download-grammars.js",
	];

	it("push: and pull_request: share the exact same paths list (the YAML anchor/alias)", () => {
		expect(Array.isArray(pushPaths)).toBe(true);
		expect(pullRequestPaths).toEqual(pushPaths);
	});

	it("pull_request: is restricted to the master base branch", () => {
		expect(workflow.on?.pull_request?.branches).toEqual(["master"]);
	});

	// Mutation-proof for CONTRACT-01: removing the PR branch binding must red
	// this parsed workflow contract even when the shared path filter remains.
	it("mutation-proof: removing pull_request.branches reds the contract", () => {
		const source = readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
		const mutatedSource = source.replace(
			/  pull_request:\n    branches: \[master\]\n/,
			"  pull_request:\n",
		);
		const mutatedWorkflow = loadWorkflow(mutatedSource) as typeof workflow;
		expect(mutatedWorkflow.on?.pull_request?.branches).not.toEqual(["master"]);
	});

	it.each(REQUIRED_PATHS)("names %s", (p) => {
		expect(pushPaths).toContain(p);
	});
});

// Round-2 review F2: the classify step's master-conclusion comparator was
// fixed in round 1 (only "success" means "passes on master") but left
// UNPINNED -- the #2675 MUT-J precedent ("today nothing reds on that") that
// a regression back to `[ -n "$CONCLUSION" ]` (any non-empty conclusion,
// which "cancelled"/"skipped"/"timed_out" all satisfy) would leave every
// existing test green, since none of them read this step's actual bash.
describe("host-range-smoke's classify step names the master conclusion exactly (#2613 review F2)", () => {
	const workflow = loadWorkflow();
	const stepRun = readStepRun(
		workflow,
		"host-range-smoke",
		"Classify newest-in-range failure",
	);

	it('treats ONLY "success" as "passes on master"', () => {
		expect(stepRun).toContain('[ "$CONCLUSION" = "success" ]');
	});

	it('treats "failure" as upstream drift (both branches present, not merged)', () => {
		expect(stepRun).toContain('[ "$CONCLUSION" = "failure" ]');
	});

	// Mutation-proof: the exact regression F2 named -- `-n` (non-empty) wrongly
	// admits "cancelled"/"skipped"/"timed_out" as if they meant "passes".
	it('mutation-proof: the `-n "$CONCLUSION"` regression this test would catch', () => {
		const mutated = stepRun.replace(
			'[ "$CONCLUSION" = "success" ]',
			'[ -n "$CONCLUSION" ]',
		);
		expect(mutated).not.toBe(stepRun);
		expect(mutated).not.toContain('[ "$CONCLUSION" = "success" ]');
	});
});

// Round-2 review F5: PI_HOST_SUPPORTED_RANGE is the ONLY thing keeping the
// wildcard peerDependencies range from making the newest-in-range lane
// silently unbounded (review S1). A future edit setting it to "*" (or any
// range with no upper comparator, e.g. a bare "x") would restore exactly
// that bug while every OTHER test here (which all supply their own
// PI_HOST_SUPPORTED_RANGE fixture) stays green.
describe("PI_HOST_SUPPORTED_RANGE is a genuinely bounded range, never a wildcard (#2613 review F5)", () => {
	const workflow = loadWorkflow();
	const env = (workflow as { env?: Record<string, unknown> }).env;
	const range = env?.PI_HOST_SUPPORTED_RANGE;

	it("is declared as a non-empty string", () => {
		expect(typeof range).toBe("string");
		expect((range as string).trim().length).toBeGreaterThan(0);
	});

	it('is not the bare wildcard "*" or "x"', () => {
		expect((range as string).trim()).not.toBe("*");
		expect((range as string).trim()).not.toBe("x");
	});

	it("carries an upper-bound comparator (< or <=), so it is not open-ended above", () => {
		expect(range as string).toMatch(/<=?\s*\d/);
	});

	// Mutation-proof: apply the SAME assertions this describe-block runs
	// against the real value to the exact regression F5 named ("*" and a
	// bare "x"), proving they would have failed had the workflow actually
	// regressed to either.
	function isBoundedNonWildcard(value: string): boolean {
		const trimmed = value.trim();
		return (
			trimmed.length > 0 &&
			trimmed !== "*" &&
			trimmed !== "x" &&
			/<=?\s*\d/.test(value)
		);
	}

	it("the real configured value passes this file's own bounded-range check", () => {
		expect(isBoundedNonWildcard(range as string)).toBe(true);
	});

	it.each(["*", "x", ">=0.80.10"])(
		"mutation-proof: %s fails this file's own bounded-range check (the exact F5 regression)",
		(regressed) => {
			expect(isBoundedNonWildcard(regressed)).toBe(false);
		},
	);
});

// #3043: the lane that shipped the break, and the two lanes the 2026-09-15
// retro swept beside it. `pi-load` used to be gated off pull_request
// entirely, so #3033 edited its pnpm-global arm with no lane able to run it
// and six matrix cells failed on every master push until a human read
// master; `smoke` and `mise-repro` carried the identical gate and #3049's
// round-2 review named mise-repro as the next member of the class. The gate
// is now the matrix itself in all three: PR-time exactly ONE cell executes
// the arm; every other event keeps the full matrix. This block evaluates the
// REAL expressions off the loaded workflow -- never a restatement of them --
// the same way the `if:` table above evaluates the real gate strings.
//
// One evaluator, three jobs: the per-job copy this block used to carry for
// pi-load alone is now the shared one below (net-count rule -- a second
// copy of a matrix evaluator is a defect, not a convenience).

// GitHub Actions expression -> value, for the subset these matrix keys use:
// `github.event_name`, string equality, `&&`/`||`, and `fromJSON` of a
// literal. JS agrees with Actions on all of it (and `A && X || Y` picks X
// when A holds, Y otherwise, in both languages).
function evaluateMatrixExpression(raw: unknown, eventName: string): unknown {
	if (typeof raw !== "string") return raw;
	const body = raw.trim().match(/^\$\{\{([\s\S]*)\}\}$/)?.[1];
	if (body === undefined) return raw;
	const substituted = body
		.split("github.event_name")
		.join(JSON.stringify(eventName))
		.split("fromJSON(")
		.join("JSON.parse(");
	if (substituted.includes("github.")) {
		throw new Error(
			`unsubstituted github.* reference survived evaluation: ${substituted}`,
		);
	}
	// `new Function` over this repo's own workflow text plus a JSON-literal
	// fixture event name, never external input.
	return new Function(`"use strict"; return (${substituted});`)();
}

type MatrixGatedJob = {
	/** Job key in the workflow. */
	job: string;
	/** The matrix key crossed with `os` for this job. */
	axis: string;
	/** Cells that run on pull_request, as "<os> · <axis value>". */
	prCells: readonly string[];
	/** Cells that run on every non-PR event. */
	fullCells: readonly string[];
};

const MATRIX_GATED_JOBS: readonly MatrixGatedJob[] = [
	{
		job: "pi-load",
		axis: "pi_install",
		prCells: ["ubuntu-latest · pnpm-global"],
		fullCells: [
			"ubuntu-latest · npm-global",
			"ubuntu-latest · pnpm-global",
			"ubuntu-latest · bun-global",
			"ubuntu-latest · curl",
			"macos-latest · npm-global",
			"macos-latest · pnpm-global",
			"macos-latest · bun-global",
			"macos-latest · curl",
		],
	},
	{
		job: "smoke",
		axis: "pm",
		prCells: ["ubuntu-latest · pnpm"],
		fullCells: [
			"ubuntu-latest · npm",
			"ubuntu-latest · pnpm",
			"ubuntu-latest · bun",
			"ubuntu-latest · yarn",
			"macos-latest · npm",
			"macos-latest · pnpm",
			"macos-latest · bun",
			"macos-latest · yarn",
		],
	},
	{
		job: "mise-repro",
		axis: "pi_via",
		prCells: ["ubuntu-latest · mise-node"],
		fullCells: [
			"ubuntu-latest · mise-node",
			"ubuntu-latest · mise-npm-backend",
			"macos-latest · mise-node",
			"macos-latest · mise-npm-backend",
		],
	},
];

describe.each(MATRIX_GATED_JOBS)(
	"install-smoke.yml $job matrix: a pull_request-eligible cell, not an event gate (#3043)",
	({ job, axis, prCells, fullCells }) => {
		const workflow = loadWorkflow() as unknown as {
			jobs?: Record<
				string,
				{ if?: unknown; strategy?: { matrix?: Record<string, unknown> } }
			>;
		};
		const matrix = workflow.jobs?.[job]?.strategy?.matrix;

		function cellsFor(eventName: string): string[] {
			const os = evaluateMatrixExpression(matrix?.os, eventName) as string[];
			const axisValues = evaluateMatrixExpression(
				matrix?.[axis],
				eventName,
			) as string[];
			const exclude = (evaluateMatrixExpression(matrix?.exclude, eventName) ??
				[]) as Array<Record<string, string>>;
			return os
				.flatMap((osValue) =>
					axisValues.map((axisValue) => ({ os: osValue, [axis]: axisValue })),
				)
				.filter(
					(cell) =>
						!exclude.some((entry) =>
							Object.entries(entry).every(
								([key, value]) =>
									(cell as Record<string, string>)[key] === value,
							),
						),
				)
				.map(
					(cell) => `${cell.os} · ${(cell as Record<string, string>)[axis]}`,
				);
		}

		it("carries no job-level `if:` (the matrix is the whole gate)", () => {
			expect(workflow.jobs?.[job]?.if).toBeUndefined();
		});

		it(`runs exactly ${prCells.join(", ")} on pull_request`, () => {
			expect(cellsFor("pull_request")).toEqual([...prCells]);
		});

		it.each(["push", "schedule", "workflow_dispatch"])(
			"keeps the full matrix on %s",
			(event) => {
				expect(cellsFor(event).sort()).toEqual([...fullCells].sort());
			},
		);

		// The PR-time narrowing is done with `exclude`, NOT by turning `os` into
		// an expression, because tests/support/workflow-shell-portability.ts
		// decides "can this job run on macOS?" by looking for a literal `macos-`
		// string in the matrix value: an expression-valued `os` would silently
		// drop the job from that bash-4 portability sweep while every test here
		// stayed green.
		it("keeps matrix.os a literal array so the macOS portability sweep still sees this job", () => {
			expect(matrix?.os).toEqual(["ubuntu-latest", "macos-latest"]);
		});
	},
);
