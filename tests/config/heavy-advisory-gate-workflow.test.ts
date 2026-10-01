import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import {
	CHANGES_CHECK,
	DEFERRED_ADVISORY_CHECKS,
	HEAVY_GATE_CHECK,
	isAdvisoryCheck,
} from "../../scripts/lib/ci-checks.mjs";
import { DEFAULT_DEADLINE_SECONDS } from "../../scripts/ci-heavy-gate.mjs";

const byCodeUnit = (a = "", b = "") => (a < b ? -1 : a > b ? 1 : 0);

// #3801: the heavy advisory jobs (mutation, the Windows Vitest subset) start
// only after the required checks passed on the same head. Each case names the
// regression it keeps out; the real YAML is loaded, never a source regex.

const ROOT = resolve(import.meta.dirname, "../..");

type Step = {
	id?: string;
	name?: string;
	run?: string;
	env?: Record<string, string>;
};
type Job = {
	name?: string;
	needs?: string | string[];
	if?: string;
	outputs?: Record<string, string>;
	permissions?: Record<string, string>;
	"timeout-minutes"?: number;
	"continue-on-error"?: boolean;
	strategy?: { matrix?: { os?: string[]; language?: string[] } };
	steps?: Step[];
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };

const load = (file: string) =>
	yaml.load(readFileSync(resolve(ROOT, file), "utf8")) as Workflow;
const asList = (needs: Job["needs"]) =>
	Array.isArray(needs) ? needs : needs ? [needs] : [];

// The branch-protection contexts of master, probed 2026-09-30 with
// `gh api repos/apmantza/pi-lens/branches/master/protection/required_status_checks`.
// A ruleset change is not visible to this file; ci-verdict's live read is the
// runtime authority and this list is the workflow shape it must match.
const REQUIRED_CONTEXTS = [
	"Lint & type-check",
	"Unit tests",
	"Install test (ubuntu-latest)",
	"Install test (windows-latest)",
	"Install test (macos-latest)",
	"knip",
	"oxfmt format check",
	"TLA+ models",
];

/** Every check-run name a job can produce (a matrix expands its `name`). */
function checkNamesOf(job: Job): string[] {
	const name = job.name ?? "";
	const matrix = job.strategy?.matrix;
	if (matrix?.os)
		return matrix.os.map((os) => name.replace("${{ matrix.os }}", os));
	if (matrix?.language)
		return matrix.language.map((language) =>
			name.replace("${{ matrix.language }}", language),
		);
	return [name];
}

const CI = load(".github/workflows/ci.yml");
const LINT = load(".github/workflows/lint.yml");
const gate = CI.jobs["heavy-gate"];
const gated = Object.entries(CI.jobs).filter(
	([id, job]) =>
		id !== "heavy-gate" && asList(job.needs).includes("heavy-gate"),
);

describe("#3801 heavy advisory jobs wait for the required checks", () => {
	// Recurrence: a required check renamed or dropped from the workflows makes
	// its branch-protection context absent, which GitHub reads as never
	// reported. The gate can only wait on what exists.
	it("keeps every required context produced by exactly one workflow job", () => {
		const hosted = new Map<string, string>();
		for (const [file, workflow] of [
			["ci.yml", CI],
			["lint.yml", LINT],
		] as const) {
			for (const [id, job] of Object.entries(workflow.jobs)) {
				for (const name of checkNamesOf(job)) hosted.set(name, `${file}:${id}`);
			}
		}
		for (const context of REQUIRED_CONTEXTS) {
			expect(hosted.has(context), `${context} must exist as a job name`).toBe(
				true,
			);
		}
	});

	// Recurrence: a required job omitted from the gate's needs (for example a
	// new install-test leg job id) lets the heavy lane start while that check
	// is still red or running.
	it("needs every required job hosted by ci.yml", () => {
		const needs = asList(gate.needs);
		const ciRequired = REQUIRED_CONTEXTS.flatMap((context) =>
			Object.entries(CI.jobs)
				.filter(([, job]) => checkNamesOf(job).includes(context))
				.map(([id]) => id),
		);
		expect([...new Set(ciRequired)].sort(byCodeUnit)).toEqual([
			"install-test",
			"lint-and-typecheck",
			"tla-models",
			"unit-tests",
		]);
		for (const id of ciRequired) expect(needs).toContain(id);
	});

	// Recurrence (#3801 docs-only scope): a gate that starts on a docs-only diff
	// would launch mutation and the Windows run for a change the maintainer wants
	// spared them. And a status function in the gate's `if` (always(),
	// cancelled(), failure()) would replace the implicit success() over its
	// needs, releasing the heavy jobs on a head whose required job is red.
	it("starts only for a code diff, and only when every needed job succeeded", () => {
		expect(asList(gate.needs)).toContain("changes");
		expect(gate.if).toBe("needs.changes.outputs.code == 'true'");
		expect(gate.if).not.toMatch(/\b(always|cancelled|failure|success)\(\)/);
	});

	// Recurrence (review r1 F3): ci-verdict reads the gate's and the changes
	// job's rows by name to tell a deferred run from a dropped one; a renamed
	// job silently reads every head as "older workflow".
	it("names the two jobs ci-verdict reads the deferred state from", () => {
		expect(gate.name).toBe(HEAVY_GATE_CHECK);
		expect(CI.jobs.changes.name).toBe(CHANGES_CHECK);
	});

	// Recurrence: `needs:` cannot reach lint.yml, so a required check hosted
	// there (knip, oxfmt) was simply not waited for. The gate step names each
	// one; a context hosted by lint.yml but missing from `--context` fails here.
	it("waits, through the script, for every required context that lint.yml hosts", () => {
		const step = gate.steps?.find((entry) => entry.id === "gate");
		const args = [
			...String(step?.run).matchAll(/--context (?:"([^"]+)"|(\S+))/g),
		].map((match) => match[1] ?? match[2]);
		const lintHosted = REQUIRED_CONTEXTS.filter((context) =>
			Object.values(LINT.jobs).some((job) =>
				checkNamesOf(job).includes(context),
			),
		);
		expect(lintHosted.length).toBeGreaterThan(0);
		expect([...args].sort(byCodeUnit)).toEqual(
			[...lintHosted].sort(byCodeUnit),
		);
	});

	// Recurrence (#3807 head 46f5f5ebf, knip RED): knip reads every workflow
	// `run:` line as a command, and `node script.mjs --require <x>` parses as
	// node's own `--require` preload, so `"oxfmt format check"` reported as an
	// unresolved import and the required knip check went red. A script flag
	// must not share a spelling with a node option.
	it("never spells a script flag like a node option in a run: command", () => {
		const nodeOptions =
			/\bnode\b[^\n|&;]*?\s(--require|-r|--import|--check|-c|--eval|-e|--print|-p)\b/;
		const offenders: string[] = [];
		for (const [id, job] of Object.entries(CI.jobs)) {
			for (const step of job.steps ?? []) {
				for (const line of String(step.run ?? "").split("\n")) {
					// a flag AFTER the script path belongs to the script, but knip
					// cannot tell; flag only the ambiguous spellings
					if (/\bnode\s+scripts\/\S+/.test(line) && nodeOptions.test(line))
						offenders.push(`${id}: ${line.trim()}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	// Recurrence: the output key or step id drifting makes every dependent's
	// `if:` false forever, so the heavy lanes silently never run.
	it("wires the job output `ready` to the script step and reads it in every dependent", () => {
		expect(gate.outputs?.ready).toBe("${{ steps.gate.outputs.ready }}");
		expect(gate.steps?.some((entry) => entry.id === "gate")).toBe(true);
		expect(gated.length).toBeGreaterThan(0);
		for (const [id, job] of gated) {
			expect(job.if, `${id} must test the gate's output`).toContain(
				"needs.heavy-gate.outputs.ready == 'true'",
			);
		}
	});

	// Recurrence: the deferred-row list in ci-checks.mjs (what ci-verdict shows
	// as PENDING) drifting from the jobs actually behind the gate.
	it("lists exactly the gated jobs as ci-verdict's deferred advisory checks", () => {
		expect(
			gated.flatMap(([, job]) => checkNamesOf(job)).sort(byCodeUnit),
		).toEqual([...DEFERRED_ADVISORY_CHECKS].sort(byCodeUnit));
	});

	// Recurrence (AGENTS.md shape 38): a heavy or gate row that gates. ci-verdict
	// and the merge train gate every non-advisory check-run.
	it("keeps the gate and everything behind it advisory and non-blocking", () => {
		expect(isAdvisoryCheck(gate.name ?? "")).toBe(true);
		for (const [, job] of gated)
			expect(isAdvisoryCheck(job.name ?? "")).toBe(true);
		const mutation = CI.jobs.mutation;
		expect(mutation["continue-on-error"]).toBe(true);
	});

	// Recurrence: a gate that polls a merge-ref sha finds no check-runs (they
	// hang on the PR head), reads "absent" for the full deadline and skips the
	// heavy lane on every PR.
	it("reads check-runs at the PR head sha, not the merge commit", () => {
		const step = gate.steps?.find((entry) => entry.id === "gate");
		expect(step?.env?.HEAD_SHA).toContain("github.event.pull_request.head.sha");
		expect(step?.env?.HEAD_SHA).toContain("|| github.sha");
		expect(gate.permissions?.checks).toBe("read");
	});

	// Recurrence: a gate job whose own ceiling is below its poll deadline is
	// killed mid-wait and reads as a red advisory row.
	it("bounds the gate's poll below its job timeout", () => {
		expect((gate["timeout-minutes"] ?? 0) * 60).toBeGreaterThan(
			DEFAULT_DEADLINE_SECONDS + 120,
		);
	});

	// Recurrence: the lane kept also running from its own ungated workflow. A
	// second `pull_request` mutation workflow would start the heavy run at once.
	it("has no ungated mutation workflow left beside the gated job", () => {
		expect(existsSync(resolve(ROOT, ".github/workflows/mutation.yml"))).toBe(
			false,
		);
		expect(CI.jobs.mutation.name).toBe("mutation (advisory)");
		expect(CI.jobs.mutation.if).toContain(
			"github.event_name == 'pull_request'",
		);
	});

	// Recurrence: the sticky-comment job running (and marking a stale comment)
	// on every red head, where the gate skipped mutation: a runner slot per red
	// push for no report.
	it("skips the sticky-comment job when mutation itself was skipped", () => {
		const comment = CI.jobs["mutation-comment"];
		expect(asList(comment.needs)).toEqual(["mutation"]);
		expect(comment.if).toContain("needs.mutation.result != 'skipped'");
		expect(comment.if).toContain("always()");
	});

	// Recurrence: #3756's aggregate lesson. A skipped required check counts as
	// passing, so the gate must never be (or replace) a required context.
	it("does not rename or replace any required context", () => {
		expect(REQUIRED_CONTEXTS).not.toContain(gate.name);
		expect(CI.jobs["unit-tests"].name).toBe("Unit tests");
		expect(CI.jobs["unit-tests"].if).toBe("always()");
	});
});
