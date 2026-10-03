// flake-shape: real-process-spawn — #3926 executes the real `Record Windows
// Vitest outcome` bash block at its true process boundary under GitHub's
// `bash --noprofile --norc -eo pipefail` flags. A fixture Node program at the
// production population-script path is the only stand-in; the `node`
// interpreter and the child PATH are the real ones, so no delimiter,
// executable name, or shebang is mocked (#3926 review F1). It also drives the
// ref-deleted Git mechanism through the registered
// tests/support/git-fixture-env.ts seam. Both are the boundaries under test;
// no in-process double observes them.
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import yaml from "../../clients/deps/js-yaml.js";
import { setupTestEnvironment } from "../clients/test-utils.js";
import { gitExecFileSync } from "../support/git-fixture-env.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import { provesNotPullRequestEligible } from "../support/workflow-pull-request-reachability.js";
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
	uses?: string;
	with?: Record<string, string>;
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

// #3941: ONE checkout census over every workflow file, parsed from the real
// YAML (never a text scan -- a comment or a string that happens to spell a
// ref is not a checkout input). The taxonomy comes from each job's own parsed
// fields, so a member can never be satisfied by a name-shaped comment:
//
//   A gating/dependencies   pull_request-eligible, not an early advisory site
//   B heavy-gated           `needs:` includes the heavy gate (#3926)
//   C early-start advisory  pull_request-eligible, advisory, with a checkout
//   D other triggers        not pull_request-eligible
//   gate                    the heavy gate itself, excluded from A-D above
//
// The #3926 stage-B rule and the #3941 stage-C rule both read this one seam.
// Only stages B and C can start after a merge deletes `refs/pull/<n>/merge`;
// stage A must report before the merge and stage D never runs on a pull
// request. `github.ref` names the mutable merge ref, so a B or C checkout
// that pins it fetches a ref the merge may already have deleted. Stages A and
// D keep their inputs and are the named excluded defaults.
//
// `pull_request-eligible` (stages A and C) is the shared event-only exclusion
// projection, never a negative regex (#3941 F1):
// `provesNotPullRequestEligible` says a job's `if:` can only be true for a
// non-pull-request event. A condition it cannot prove -- another context
// path, a status function, an action or event it does not model -- stays
// eligible, so the guard keeps covering a real checkout (AGENTS.md shape 48).
const WORKFLOW_DIR = resolve(ROOT, ".github/workflows");
const EPHEMERAL_PULL_REF = "${{ github.ref }}";
const CAPTURED_COMMIT = "${{ github.sha }}";
const PINNED_CHECKOUT =
	"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";

type Stage = "A" | "B" | "C" | "D" | "gate";
type CensusRow = {
	file: string;
	jobId: string;
	jobName: string;
	stage: Stage;
	events: string[];
	uses: string[];
	refs: Array<string | undefined>;
};
type CheckoutSite = {
	file: string;
	jobId: string;
	jobName: string;
	stage: Stage;
	events: string[];
	uses: string;
	ref: string | undefined;
};

function workflowEvents(workflow: Workflow): Set<string> {
	const on = (workflow as { on?: unknown }).on;
	if (typeof on === "string") return new Set([on]);
	if (Array.isArray(on)) return new Set(on.map(String));
	if (on && typeof on === "object") return new Set(Object.keys(on));
	return new Set();
}

function checkoutStepsOf(job: Job): Step[] {
	return (job.steps ?? []).filter(
		(step) => step.uses?.startsWith("actions/checkout@") === true,
	);
}

function classifyStage(
	file: string,
	jobId: string,
	job: Job,
	events: Set<string>,
): Stage {
	if (file === "ci.yml" && jobId === "heavy-gate") return "gate";
	if (asList(job.needs).includes("heavy-gate")) return "B";
	// A workflow that can trigger on `pull_request` at all, whose job `if:`
	// does not PROVE it runs only off `pull_request`. The projection is the
	// shared event-only one (#3941 F1): `host-latest-smoke`'s
	// `event_name == 'schedule' || event_name == 'workflow_dispatch'` is
	// excluded, while `event_name != 'pull_request'` is NOT (a
	// `pull_request_target` event satisfies it), so an unproven condition
	// stays eligible rather than silently losing the guard.
	const pullRequestEligible =
		events.has("pull_request") && !provesNotPullRequestEligible(job.if);
	if (!pullRequestEligible) return "D";
	if (isAdvisoryCheck(job.name ?? jobId) && checkoutStepsOf(job).length > 0)
		return "C";
	return "A";
}

function workflowSources(): Map<string, string> {
	return new Map(
		readdirSync(WORKFLOW_DIR)
			.filter((name) => name.endsWith(".yml"))
			.sort(byCodeUnit)
			.map((name) => [name, readFileSync(resolve(WORKFLOW_DIR, name), "utf8")]),
	);
}

function censusRows(sources: ReadonlyMap<string, string>): CensusRow[] {
	const rows: CensusRow[] = [];
	for (const [file, text] of [...sources.entries()].sort(([a], [b]) =>
		byCodeUnit(a, b),
	)) {
		const workflow = yaml.load(text) as Workflow;
		const events = workflowEvents(workflow);
		for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
			const steps = checkoutStepsOf(job);
			rows.push({
				file,
				jobId,
				jobName: job.name ?? jobId,
				stage: classifyStage(file, jobId, job, events),
				events: [...events],
				uses: steps.map((step) => step.uses ?? ""),
				refs: steps.map((step) => step.with?.ref),
			});
		}
	}
	return rows;
}

function sitesOf(rows: CensusRow[]): CheckoutSite[] {
	return rows.flatMap((row) =>
		row.refs.map((ref, index) => ({
			file: row.file,
			jobId: row.jobId,
			jobName: row.jobName,
			stage: row.stage,
			events: row.events,
			uses: row.uses[index] ?? "",
			ref,
		})),
	);
}

function stageJobCounts(rows: CensusRow[]) {
	const counts = new Map<Stage, number>();
	for (const row of rows)
		counts.set(row.stage, (counts.get(row.stage) ?? 0) + 1);
	return counts;
}

function stageSummary(sites: CheckoutSite[]) {
	const summary = new Map<
		Stage,
		{ jobs: Set<string>; sites: number; explicit: number; githubRef: number }
	>();
	for (const site of sites) {
		const entry = summary.get(site.stage) ?? {
			jobs: new Set<string>(),
			sites: 0,
			explicit: 0,
			githubRef: 0,
		};
		entry.jobs.add(`${site.file}::${site.jobId}`);
		entry.sites += 1;
		if (site.ref !== undefined) entry.explicit += 1;
		if (site.ref === EPHEMERAL_PULL_REF) entry.githubRef += 1;
		summary.set(site.stage, entry);
	}
	return summary;
}

// The ONE captured-commit predicate, used by BOTH the stage-B and stage-C
// rules (#3941 F2): a checkout is on the captured source event commit when it
// leaves `ref` unset (the pinned action's default is `github.sha`) or names
// `${{ github.sha }}` explicitly. Those are the only two proven-equivalent
// spellings; every other explicit ref is treated as unsafe rather than matched
// against a denylist of mutable names.
const onCapturedCommit = (ref: string | undefined) =>
	ref === undefined || ref === CAPTURED_COMMIT;

// The ONE named admission to the captured-commit rule: osv-scan deliberately
// checks out the PR's own head commit so it scans the PR's lockfile rather
// than a merge-drifted one (#1844). The job runs no checked-out code -- it
// feeds the lockfile to osv-scanner -- so reading the untrusted head is
// acceptable HERE and nowhere else. The admission names the site AND its
// exact ref expression: a changed ref no longer matches, so the conservative
// predicate below flags it (the stale-admission test pins the live value in
// both directions).
const OSV_HEAD_SCAN = "osv-scan.yml::osv-scan";
const OSV_HEAD_SCAN_REF =
	"${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || '' }}";
const isAdmittedHeadScan = (site: CheckoutSite): boolean =>
	`${site.file}::${site.jobId}` === OSV_HEAD_SCAN &&
	site.ref === OSV_HEAD_SCAN_REF;

// Stage-C checkout sites that do NOT use the captured commit and are not the
// one reviewed head-scan admission. Empty after the #3941 fix; the census
// mutation cases below reintroduce each member in turn.
const earlyStartUnsafeSites = (sites: CheckoutSite[]) =>
	sites.filter(
		(site) =>
			site.stage === "C" &&
			!onCapturedCommit(site.ref) &&
			!isAdmittedHeadScan(site),
	);

const CENSUS_SOURCES = workflowSources();
const CENSUS_ROWS = censusRows(CENSUS_SOURCES);
const CENSUS_SITES = sitesOf(CENSUS_ROWS);

// The eleven early-start advisory jobs whose checkout pinned the merge ref,
// by the ids the task names. Each must stay pull_request-eligible, advisory,
// and NOT behind the gate; the census proves the trigger and the stage.
const EARLY_START_MEMBERS = [
	{
		file: "ci.yml",
		jobId: "targeted-tests-advisory",
		name: "Targeted tests (advisory)",
	},
	{
		file: "install-smoke.yml",
		jobId: "mise-repro",
		name: "mise repro (#285) \u00b7 ${{ matrix.os }} \u00b7 ${{ matrix.pi_via }} (advisory)",
	},
	{ file: "lint.yml", jobId: "vale", name: "Vale prose lint (advisory)" },
	{ file: "lint.yml", jobId: "oxlint-advisory", name: "oxlint (advisory)" },
	{ file: "lint.yml", jobId: "jscpd", name: "jscpd (advisory)" },
	{ file: "lint.yml", jobId: "complexity", name: "complexity (advisory)" },
	{ file: "lint.yml", jobId: "strictness", name: "strictness (advisory)" },
	{ file: "lint.yml", jobId: "yamllint", name: "yamllint (advisory)" },
	{ file: "lint.yml", jobId: "typos", name: "typos (advisory)" },
	{ file: "lint.yml", jobId: "taplo", name: "taplo (advisory)" },
	{
		file: "pr-metadata.yml",
		jobId: "pr-body-lint",
		name: "PR body (advisory)",
	},
] as const;

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

// #3926: the heavy advisory jobs start only after the required checks pass, so
// auto-merge may already have deleted the mutable `refs/pull/<n>/merge` that
// `github.ref` names. A gated checkout must rely on the action's default
// captured commit (`github.sha`, the validated test-merge tree), never on the
// ephemeral ref. The sibling gated jobs `mutation` and `codeql` already do.
// The rule is derived from `needs`, so a future gated job is covered.
describe("#3926 a gated checkout pins the captured commit, never the merge ref", () => {
	const checkoutSteps = (id: string): Step[] =>
		(CI.jobs[id]?.steps ?? []).filter(
			(step) => step.uses?.startsWith("actions/checkout@") === true,
		);
	const checkoutRefs = (id: string): Array<string | undefined> =>
		checkoutSteps(id).map((step) => step.with?.ref);

	// Recurrence (#3807/#3924): a gated job (or this one) restores
	// `ref: ${{ github.ref }}` and its checkout fetches a ref the merge deleted.
	// Reads the shared census (stage B), not a second checkout sweep.
	it("keeps every checkout behind heavy-gate off the ephemeral pull ref", () => {
		const gatedSites = CENSUS_SITES.filter((site) => site.stage === "B");
		expect(gatedSites.length).toBeGreaterThan(0);
		for (const [id] of gated)
			expect(
				gatedSites.some((site) => site.jobId === id),
				`${id} must still check out the repository`,
			).toBe(true);
		const offenders = gatedSites
			.filter((site) => !onCapturedCommit(site.ref))
			.map((site) => `${site.file}::${site.jobId}: ref=${site.ref}`);
		expect(offenders).toEqual([]);
	});

	// Positive pin: the one site #3807/#3924 proved red now uses the default.
	it("uses the captured commit on unit-tests-windows", () => {
		expect(checkoutRefs("unit-tests-windows")).not.toContain(
			"${{ github.ref }}",
		);
		expect(
			checkoutRefs("unit-tests-windows").every(
				(ref) => ref === undefined || ref === "${{ github.sha }}",
			),
		).toBe(true);
	});

	// The action's default is what makes the captured commit reachable; the
	// evaluated revision must stay pinned, not drift to a floating tag.
	it("keeps the pinned checkout revision", () => {
		for (const [id, job] of gated) {
			for (const step of job.steps ?? []) {
				if (!step.uses?.startsWith("actions/checkout@")) continue;
				expect(step.uses, `${id} checkout revision`).toBe(
					"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
				);
			}
		}
	});
});

// #3941: the early-start advisory population. These eleven jobs run on
// `pull_request` and are NOT behind `heavy-gate`, so a runner-queue delay can
// start their checkout after auto-merge deletes the mutable
// `refs/pull/<n>/merge` that `github.ref` names. This is the separate producer
// the gate-based #3926 rule cannot cover. No field incident is claimed on
// these eleven: the failure class is proven by the same pinned checkout
// source contract (`actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`,
// asserted below) and the real deleted-ref / captured-SHA witness in the
// #3926 block; the production failure (#3926) is the same checkout mechanism
// on the one gated Windows site. The rule folds onto the shared census, so a
// future early-start advisory job is covered without a second resolver.
//
// Mutation harness: reintroduce `ref: <ref>` on the named job's first
// checkout in an in-memory copy of the real file text, then re-parse. The
// committed sources are never written; each trial starts from a fresh copy.
function restoreCheckoutRef(text: string, jobId: string, ref: string): string {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line === `  ${jobId}:`);
	if (start < 0) throw new Error(`job ${jobId} not found`);
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^  \S/.test(line) && line.trimEnd().endsWith(":")) {
			end = i;
			break;
		}
	}
	let checkout = -1;
	for (let i = start + 1; i < end; i++) {
		if ((lines[i] ?? "").includes("uses: actions/checkout@")) {
			checkout = i;
			break;
		}
	}
	if (checkout < 0) throw new Error(`checkout not found in ${jobId}`);
	let withAt = -1;
	for (let i = checkout + 1; i < end; i++) {
		const line = lines[i] ?? "";
		if (line === "        with:") {
			withAt = i;
			break;
		}
		if (line.startsWith("      - ")) break; // next step: this checkout has no with:
	}
	if (withAt >= 0) {
		let refAt = -1;
		for (let i = withAt + 1; i < end; i++) {
			const line = lines[i] ?? "";
			if (line.startsWith("          ref:")) {
				refAt = i;
				break;
			}
			if (!/^ {10,}\S/.test(line)) break;
		}
		if (refAt >= 0) lines[refAt] = `          ref: ${ref}`;
		else lines.splice(withAt + 1, 0, `          ref: ${ref}`);
	} else
		lines.splice(checkout + 1, 0, "        with:", `          ref: ${ref}`);
	return lines.join("\n");
}

describe("#3941 early-start advisory checkouts pin the captured commit", () => {
	const summary = stageSummary(CENSUS_SITES);
	const jobCounts = stageJobCounts(CENSUS_ROWS);
	const stageJobs = (stage: Stage) => jobCounts.get(stage) ?? 0;
	const stageRefs = (stage: Stage) => summary.get(stage)?.githubRef ?? 0;

	// A minimal real-shaped workflow for the default / captured-SHA / unsafe
	// controls. `on:` is the only knob that changes a job's stage, and `name:`
	// is the only knob that changes its advisory classification.
	const fixture = (
		refLine: string,
		extraSteps: string[] = [],
		jobName = "Fixture tool (advisory)",
		trigger = "  pull_request:",
	) =>
		[
			"name: Fixture",
			"on:",
			trigger,
			"jobs:",
			"  fixture:",
			`    name: ${jobName}`,
			"    runs-on: ubuntu-latest",
			"    steps:",
			`      - uses: ${PINNED_CHECKOUT} # v7`,
			"        with:",
			refLine,
			"          persist-credentials: false",
			...extraSteps,
			"",
		].join("\n");
	const sitesOfFixture = (text: string) =>
		sitesOf(censusRows(new Map([["fixture.yml", text]])));

	it("records every stage's job and site counts from the parsed YAML", () => {
		// 55 checkout sites across the tree; 60 non-gate job rows (A22/B3/C14/D21
		// after #3941 F1 moved install-smoke's schedule-only `host-latest-smoke`
		// from C to D). Sites and jobs are counted separately so a no-checkout
		// job cannot launder a stage's population. The floor call keeps this
		// census registered under the sweep-floor meta-sweep: an empty walk fails
		// instead of reading clean.
		assertNonEmptyScan(
			"early-start advisory checkout census",
			CENSUS_SITES.length,
			55,
		);
		expect(CENSUS_SITES.length).toBe(55);
		expect(
			stageJobs("A") + stageJobs("B") + stageJobs("C") + stageJobs("D"),
		).toBe(60);
		expect(stageJobs("A")).toBe(22);
		expect(stageJobs("B")).toBe(3);
		expect(stageJobs("C")).toBe(14);
		expect(stageJobs("D")).toBe(21);
		// The gate's own checkout is its own stage and is excluded from A-D.
		expect(summary.get("gate")?.sites).toBe(1);
		// #3941 F1: the schedule/dispatch-only advisory job is NOT early-start,
		// even though its workflow also triggers on pull_request.
		const hostLatest = CENSUS_SITES.find(
			(site) =>
				site.file === "install-smoke.yml" && site.jobId === "host-latest-smoke",
		);
		expect(hostLatest?.stage, "host-latest-smoke").toBe("D");
		expect(hostLatest?.events).toContain("pull_request");
	});

	it("removes every stage-C merge-ref site and only those", () => {
		// After the fix: 27 github.ref sites became 16 (19 explicit refs).
		expect(stageRefs("A")).toBe(15);
		expect(stageRefs("B")).toBe(0);
		expect(stageRefs("C")).toBe(0);
		expect(stageRefs("D")).toBe(1);
		const totalGithubRef = CENSUS_SITES.filter(
			(site) => site.ref === EPHEMERAL_PULL_REF,
		).length;
		expect(totalGithubRef).toBe(16);
		const totalExplicit = CENSUS_SITES.filter(
			(site) => site.ref !== undefined,
		).length;
		expect(totalExplicit).toBe(19);
	});

	it("keeps every early-start advisory checkout on the captured commit", () => {
		// The predicate is the captured commit, not the literal `github.ref`: a
		// stage-C site on any other explicit ref is unsafe (#3941 F2).
		expect(earlyStartUnsafeSites(CENSUS_SITES)).toEqual([]);
		const stageCNotCaptured = CENSUS_SITES.filter(
			(site) => site.stage === "C" && !onCapturedCommit(site.ref),
		);
		// Exactly one stage-C site is not on the captured commit: the admitted
		// osv-scan head scan. Every other stage-C site uses the default.
		expect(
			stageCNotCaptured.map((site) => `${site.file}::${site.jobId}`),
		).toEqual([OSV_HEAD_SCAN]);
		const admitted = stageCNotCaptured[0];
		expect(admitted !== undefined && isAdmittedHeadScan(admitted)).toBe(true);
	});

	// The one admission is live and exact. A stale admission -- the ref changed,
	// or the head-scan source removed -- reds the pin below, and the mutation
	// proves a mutable ref at that site is flagged, not admitted.
	it("admits only osv-scan's exact read-only head-scan ref", () => {
		const osvSite = CENSUS_SITES.find(
			(site) => `${site.file}::${site.jobId}` === OSV_HEAD_SCAN,
		);
		expect(osvSite, OSV_HEAD_SCAN).toBeDefined();
		expect(osvSite?.stage, OSV_HEAD_SCAN).toBe("C");
		// Pins the live admission value: a changed ref leaves the admission
		// meaningless and stale, so this expectation reds.
		expect(osvSite?.ref, `${OSV_HEAD_SCAN} ref`).toBe(OSV_HEAD_SCAN_REF);
		const sources = new Map(CENSUS_SOURCES);
		sources.set(
			"osv-scan.yml",
			restoreCheckoutRef(
				CENSUS_SOURCES.get("osv-scan.yml") as string,
				"osv-scan",
				"${{ github.head_ref }}",
			),
		);
		const offenders = earlyStartUnsafeSites(sitesOf(censusRows(sources))).map(
			(site) => `${site.file}::${site.jobId}`,
		);
		expect(offenders).toEqual([OSV_HEAD_SCAN]);
	});

	it("names the exact eleven early-start advisory members", () => {
		// #3941 F3: an independent population pin. The per-member mutation cases
		// below are generated FROM `EARLY_START_MEMBERS`, so deleting a row would
		// delete its own witness; the count and the exact key set are the floor
		// that reds instead.
		expect(EARLY_START_MEMBERS.length).toBe(11);
		expect(
			EARLY_START_MEMBERS.map(
				(member) => `${member.file}::${member.jobId}`,
			).sort(byCodeUnit),
		).toEqual([
			"ci.yml::targeted-tests-advisory",
			"install-smoke.yml::mise-repro",
			"lint.yml::complexity",
			"lint.yml::jscpd",
			"lint.yml::oxlint-advisory",
			"lint.yml::strictness",
			"lint.yml::taplo",
			"lint.yml::typos",
			"lint.yml::vale",
			"lint.yml::yamllint",
			"pr-metadata.yml::pr-body-lint",
		]);
		const byFileJob = new Map(
			CENSUS_SITES.map((site) => [`${site.file}::${site.jobId}`, site]),
		);
		for (const member of EARLY_START_MEMBERS) {
			const key = `${member.file}::${member.jobId}`;
			const site = byFileJob.get(key);
			expect(site, key).toBeDefined();
			expect(site?.stage, `${key} stage`).toBe("C");
			expect(site?.jobName, `${key} name`).toBe(member.name);
			// Trigger and pinned source: pull_request-eligible, and the pinned
			// actions/checkout revision whose default fetches the captured
			// `github.sha`.
			expect(site?.events, `${key} trigger`).toContain("pull_request");
			expect(site?.uses, `${key} checkout revision`).toBe(PINNED_CHECKOUT);
			// The captured commit is the default, so `ref` is unset.
			expect(site?.ref, `${key} ref`).toBeUndefined();
		}
	});

	// The excluded defaults, named and measured: stage-A gating jobs must
	// report before the merge, so their merge ref still exists and they keep
	// `github.ref`; stage D never runs on a pull request. The rule must not
	// reach into either, and it must flag only the eleven stage-C sites.
	it("leaves the gating and other-trigger checkouts as named exclusions", () => {
		const gatingSites = CENSUS_SITES.filter(
			(site) => site.stage === "A" && site.ref === EPHEMERAL_PULL_REF,
		);
		expect(gatingSites.length).toBe(15);
		expect(earlyStartUnsafeSites(gatingSites)).toEqual([]);
		const otherTriggerSites = CENSUS_SITES.filter(
			(site) => site.stage === "D" && site.ref === EPHEMERAL_PULL_REF,
		);
		expect(
			otherTriggerSites.map((site) => `${site.file}::${site.jobId}`),
		).toEqual(["labels.yml::sync"]);
	});

	// Controls, all through the real parser: the default checkout and an
	// explicit captured commit are safe; `github.ref` is unsafe; and a comment
	// or a string that spells the ref is not a checkout input. Only stage C is
	// in scope.
	it("allows the default and the captured commit, and flags every other explicit ref", () => {
		expect(
			earlyStartUnsafeSites(sitesOfFixture(fixture("          # no ref"))),
		).toEqual([]);
		expect(
			earlyStartUnsafeSites(
				sitesOfFixture(fixture(`          ref: ${CAPTURED_COMMIT}`)),
			),
		).toEqual([]);
		// Every other explicit ref is unsafe, not just `${{ github.ref }}`
		// (#3941 F2): a mutable name, a ref_name, or an interpolated merge ref.
		for (const ref of [
			EPHEMERAL_PULL_REF,
			"${{ github.head_ref }}",
			"${{ github.ref_name }}",
			"refs/pull/${{ github.event.pull_request.number }}/merge",
		]) {
			const unsafe = earlyStartUnsafeSites(
				sitesOfFixture(fixture(`          ref: ${ref}`)),
			);
			expect(
				unsafe.map((site) => site.ref),
				`ref ${ref}`,
			).toEqual([ref]);
		}
	});

	it("does not read a comment or a string as a checkout ref", () => {
		const commented = sitesOfFixture(
			fixture(`          # ref: ${EPHEMERAL_PULL_REF}`),
		);
		expect(commented[0]?.ref).toBeUndefined();
		expect(earlyStartUnsafeSites(commented)).toEqual([]);
		const stringLiteral = sitesOfFixture(
			fixture("          # no ref", [
				"      - name: note",
				`        run: 'echo "ref: ${EPHEMERAL_PULL_REF} is prose"'`,
			]),
		);
		expect(stringLiteral[0]?.ref).toBeUndefined();
		expect(earlyStartUnsafeSites(stringLiteral)).toEqual([]);
	});

	it("scopes the rule to stage C, not gating or other-trigger jobs", () => {
		const gating = sitesOfFixture(
			fixture(`          ref: ${EPHEMERAL_PULL_REF}`, [], "Fixture tool"),
		);
		expect(gating[0]?.stage).toBe("A");
		expect(earlyStartUnsafeSites(gating)).toEqual([]);
		const otherTrigger = sitesOfFixture(
			fixture(
				`          ref: ${EPHEMERAL_PULL_REF}`,
				[],
				"Fixture tool (advisory)",
				"  push:",
			),
		);
		expect(otherTrigger[0]?.stage).toBe("D");
		expect(earlyStartUnsafeSites(otherTrigger)).toEqual([]);
	});

	// The eleven mutations: reintroduce the old unsafe input on each member in
	// a fresh in-memory copy and prove the guard reds on exactly that site and
	// no other, without changing the site population.
	for (const member of EARLY_START_MEMBERS) {
		it(`flags ${member.file}::${member.jobId} again when its github.ref returns`, () => {
			const sources = new Map(CENSUS_SOURCES);
			const original = sources.get(member.file);
			expect(original, member.file).toBeDefined();
			sources.set(
				member.file,
				restoreCheckoutRef(
					original as string,
					member.jobId,
					EPHEMERAL_PULL_REF,
				),
			);
			const mutatedSites = sitesOf(censusRows(sources));
			// The mutation changed one ref, not the population.
			expect(mutatedSites.length).toBe(CENSUS_SITES.length);
			const offenders = earlyStartUnsafeSites(mutatedSites).map(
				(site) => `${site.file}::${site.jobId}`,
			);
			expect(offenders).toEqual([`${member.file}::${member.jobId}`]);
			// The real sources are a fresh read and stay clean: restore is exact.
			expect(earlyStartUnsafeSites(CENSUS_SITES)).toEqual([]);
		});
	}
});

// #3941 F1: stage eligibility is the SHARED event-only exclusion projection,
// not the old negative-only `!/event_name != 'pull_request'/` regex. That
// regex read install-smoke.yml::host-latest-smoke -- whose workflow also
// carries `pull_request` while its own `if:` runs only on
// schedule/workflow_dispatch -- as an early-start advisory site. The
// projection is conservative in one direction: it excludes a job only when
// its `if:` is false for EVERY pull-request event name, and anything it
// cannot prove stays eligible (AGENTS.md shape 48).
describe("#3941 stage eligibility is the shared event-only projection", () => {
	// The checkout `with:` block carries an optional `ref:` line; the `if:` is
	// the only knob that changes the stage. The `if:` value is emitted as a YAML
	// double-quoted scalar (JSON escaping) so an expression that begins with a
	// quote -- `'github.event_name' != …` -- is still valid YAML.
	const fixtureText = (ifLine: string, refLine?: string): string =>
		[
			"name: Fixture",
			"on:",
			"  pull_request:",
			"jobs:",
			"  fixture:",
			"    name: Fixture tool (advisory)",
			`    if: ${JSON.stringify(ifLine)}`,
			"    runs-on: ubuntu-latest",
			"    steps:",
			`      - uses: ${PINNED_CHECKOUT} # v7`,
			"        with:",
			...(refLine ? [refLine] : []),
			"          persist-credentials: false",
			"",
		].join("\n");
	const fixtureSites = (ifLine: string, refLine?: string) =>
		sitesOf(
			censusRows(new Map([["fixture.yml", fixtureText(ifLine, refLine)]])),
		);
	const fixtureStage = (ifLine: string): Stage | undefined =>
		fixtureSites(ifLine)[0]?.stage;

	it("excludes only a condition false for every pull-request event", () => {
		// The real host, plus any event-name-only non-PR gate, is excluded.
		expect(
			provesNotPullRequestEligible(
				"github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
			),
		).toBe(true);
		expect(provesNotPullRequestEligible("github.event_name == 'push'")).toBe(
			true,
		);
		expect(
			provesNotPullRequestEligible("${{ github.event_name == 'schedule' }}"),
		).toBe(true);
		// pull_request itself, a mixed `||`, and pull_request_target are NOT.
		expect(
			provesNotPullRequestEligible("github.event_name == 'pull_request'"),
		).toBe(false);
		expect(
			provesNotPullRequestEligible(
				"github.event_name == 'schedule' || github.event_name == 'pull_request'",
			),
		).toBe(false);
		expect(
			provesNotPullRequestEligible(
				"github.event_name == 'pull_request_target'",
			),
		).toBe(false);
		expect(
			provesNotPullRequestEligible("github.event_name != 'pull_request'"),
		).toBe(false);
		// Unproven stays eligible: another context path, a status function, an
		// action the model does not enumerate, or no `if:` at all.
		expect(provesNotPullRequestEligible("failure()")).toBe(false);
		expect(
			provesNotPullRequestEligible("github.event.action == 'closed'"),
		).toBe(false);
		expect(
			provesNotPullRequestEligible(
				"github.event_name == 'schedule' || github.event.issue.number == 1",
			),
		).toBe(false);
		expect(
			provesNotPullRequestEligible("needs.changes.outputs.code == 'true'"),
		).toBe(false);
		// A condition that names no pull-request event at all is outside this
		// projection's axis: unproven, never excluded.
		expect(provesNotPullRequestEligible("false")).toBe(false);
		expect(provesNotPullRequestEligible(undefined)).toBe(false);
	});

	// #3941 F5: GitHub compares strings case-insensitively ("GitHub ignores
	// case when comparing strings"), so a literal that case-insensitively names
	// a pull-request event makes the condition true on that event and the job
	// is NOT excluded. The pre-fix projection evaluated the substituted string
	// with JS strict equality and read `'PULL_REQUEST'` as excluded.
	it("treats a mixed-case pull-request literal as eligible (#3941 F5)", () => {
		expect(
			provesNotPullRequestEligible("github.event_name == 'PULL_REQUEST'"),
		).toBe(false);
		expect(
			provesNotPullRequestEligible("github.event_name == 'Pull_Request'"),
		).toBe(false);
		expect(
			provesNotPullRequestEligible(
				"github.event_name == 'schedule' || github.event_name == 'PULL_REQUEST'",
			),
		).toBe(false);
		// The same fold, other direction: a non-PR literal in any case still
		// excludes, because the atom is false for both PR events.
		expect(
			provesNotPullRequestEligible(
				"github.event_name == 'SCHEDULE' || github.event_name == 'WORKFLOW_DISPATCH'",
			),
		).toBe(true);
	});

	// #3941 r3: the projection is a syntactic SHAPE, so one extra operator, a
	// numeric comparison, grouping, or a `github.event_name` inside quoted
	// prose is UNPROVEN and stays eligible. The pre-fix `new Function` oracle
	// evaluated each with JS semantics and read it as excluded.
	it("leaves an unproven operator, type, or quoted axis eligible", () => {
		// GHA loose equality coerces `'0'` to `0`, so this runs on a PR.
		expect(
			provesNotPullRequestEligible(
				"github.event_name == 'pull_request' && '0' == 0",
			),
		).toBe(false);
		// `github.event_name` inside quoted prose is DATA, not a context read;
		// both constant strings differ from either literal, so the `&&` is true
		// on a PR and the job runs.
		expect(
			provesNotPullRequestEligible(
				"'github.event_name' != '\"pull_request\"' && 'github.event_name' != '\"pull_request_target\"'",
			),
		).toBe(false);
		expect(
			provesNotPullRequestEligible("(github.event_name == 'schedule')"),
		).toBe(false);
		expect(
			provesNotPullRequestEligible(
				"github.event_name == 'schedule' || github.event.issue.number == 1",
			),
		).toBe(false);
	});

	// #3941 r3: GitHub's string escaping is not JS's (a literal quote is
	// doubled, not backslash-escaped), so an escaped literal is UNPROVEN and
	// never guessed at as JS string content.
	it("does not guess a JS escaping GitHub does not use", () => {
		expect(provesNotPullRequestEligible("github.event_name == 'don''t'")).toBe(
			false,
		);
		expect(
			provesNotPullRequestEligible("github.event_name == 'pull_requ\\'est'"),
		).toBe(false);
	});

	it("stages the same conditions through the real census parser", () => {
		expect(fixtureStage("github.event_name == 'schedule'")).toBe("D");
		expect(
			fixtureStage(
				"github.event_name == 'schedule' || github.event_name == 'pull_request'",
			),
		).toBe("C");
		expect(fixtureStage("github.event_name == 'pull_request'")).toBe("C");
		expect(fixtureStage("failure()")).toBe("C");
		expect(fixtureStage("github.event.action == 'closed'")).toBe("C");
		expect(fixtureStage("github.event_name == 'pull_request_target'")).toBe(
			"C",
		);
		// #3941 F5/r3: a mixed-case PR literal, an extra operator, and a quoted
		// axis are all UNPROVEN, so the job stays stage C; a mixed-case non-PR
		// `||` still excludes (stage D).
		expect(fixtureStage("github.event_name == 'PULL_REQUEST'")).toBe("C");
		expect(
			fixtureStage(
				"github.event_name == 'schedule' || github.event_name == 'PULL_REQUEST'",
			),
		).toBe("C");
		expect(
			fixtureStage("github.event_name == 'pull_request' && '0' == 0"),
		).toBe("C");
		expect(
			fixtureStage(
				"'github.event_name' != '\"pull_request\"' && 'github.event_name' != '\"pull_request_target\"'",
			),
		).toBe("C");
		expect(
			fixtureStage(
				"github.event_name == 'SCHEDULE' || github.event_name == 'WORKFLOW_DISPATCH'",
			),
		).toBe("D");
	});

	// The consequence of the conservative direction, measured end to end: an
	// unproven `if:` keeps the job in stage C, so an early-start checkout that
	// pins the merge ref is still flagged -- the real pull-request guard is
	// never lost to a false exclusion.
	it("keeps an unproven condition's early-start checkout in the guard", () => {
		for (const ifLine of [
			"github.event_name == 'PULL_REQUEST'",
			"github.event_name == 'pull_request' && '0' == 0",
			"'github.event_name' != '\"pull_request\"' && 'github.event_name' != '\"pull_request_target\"'",
		]) {
			const sites = fixtureSites(
				ifLine,
				`          ref: ${EPHEMERAL_PULL_REF}`,
			);
			expect(sites[0]?.stage, ifLine).toBe("C");
			expect(
				earlyStartUnsafeSites(sites).map(
					(site) => `${site.file}::${site.jobId}`,
				),
				ifLine,
			).toEqual(["fixture.yml::fixture"]);
		}
	});
});

// #3926 secondary defect: the always-run summary invoked the checked-out
// population script unconditionally, so after a failed checkout it died with
// `Cannot find module ... win32-gate-population.mjs` instead of reporting that
// the subset never ran. These cases run the real `Record Windows Vitest
// outcome` `run:` block under GitHub's `bash --noprofile --norc -eo pipefail`
// flags at a true process boundary. A fixture Node program at the production
// population-script path is the only stand-in, and it runs under the real
// `node` on PATH, so the child PATH is never rewritten and no delimiter,
// executable name, or `#!/bin/sh` shebang is mocked (#3926 review F1: the old
// `stubBin + ":" + PATH` line was POSIX-only and the stub shadowed `node`
// only on a `:`-delimited PATH).
describe("#3926 the Windows summary stays honest when the tree is unavailable", () => {
	const summaryStep = (CI.jobs["unit-tests-windows"]?.steps ?? []).find(
		(step) => step.name === "Record Windows Vitest outcome",
	);

	const fixture = setupTestEnvironment("pi-lens-3926-");

	beforeAll(() => {
		const lib = resolve(fixture.tmpDir, "scripts/lib");
		mkdirSync(lib, { recursive: true });
		writeFileSync(
			resolve(lib, "win32-gate-population.mjs"),
			[
				'import { appendFileSync } from "node:fs";',
				'import { basename } from "node:path";',
				"const args = process.argv.slice(2);",
				'appendFileSync(process.env.NODE_MARKER, `${basename(process.argv[1])} ${args.join(" ")}\\n`);',
				'console.log(`population-fixture: ${args.join(" ")}`);',
				'process.exit(Number(process.env.NODE_FIXTURE_EXIT ?? "0"));',
			].join("\n"),
		);
	});
	afterAll(() => fixture.cleanup());

	function runSummary(caseName: string, withList: boolean, exitCode = 0) {
		const runnerTemp = resolve(fixture.tmpDir, `runner-${caseName}`);
		mkdirSync(runnerTemp, { recursive: true });
		if (withList)
			writeFileSync(
				resolve(runnerTemp, "windows-vitest-files.txt"),
				"tests/a.test.ts\n",
			);
		const summary = resolve(fixture.tmpDir, `summary-${caseName}.md`);
		const marker = resolve(fixture.tmpDir, `node-${caseName}.marker`);
		const script = String(summaryStep?.run).replace(
			/\$\{\{\s*steps\.windows-vitest\.outcome\s*\}\}/,
			"skipped",
		);
		const result = spawnSync(
			"bash",
			["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
			{
				cwd: fixture.tmpDir,
				encoding: "utf8",
				env: {
					...process.env,
					GITHUB_STEP_SUMMARY: summary,
					RUNNER_TEMP: runnerTemp,
					NODE_MARKER: marker,
					NODE_FIXTURE_EXIT: String(exitCode),
				},
			},
		);
		return { result, summary, marker };
	}

	// Recurrence (#3924): the missing-module error replaced the real checkout
	// failure. With no list, the step exits 0, says "Not executed", and never
	// touches the checked-out script; the checkout step's own error stays the
	// visible cause.
	it("reports Not executed and never runs the script when the list is absent", () => {
		const { result, summary, marker } = runSummary("absent", false);
		expect(result.status, String(result.stderr)).toBe(0);
		const text = readFileSync(summary, "utf8");
		expect(text).toContain("Not executed");
		expect(text).toContain("windows_vitest=skipped");
		expect(existsSync(marker)).toBe(false);
	});

	// The other direction: with the list present the guard must not swallow the
	// real population summary (the no-drop invariant beside the safety one).
	it("runs the population script and keeps its summary when the list exists", () => {
		const { result, summary, marker } = runSummary("present", true);
		expect(result.status, String(result.stderr)).toBe(0);
		expect(existsSync(marker)).toBe(true);
		expect(readFileSync(marker, "utf8")).toContain(
			"win32-gate-population.mjs --summary --executed-file-list",
		);
		const text = readFileSync(summary, "utf8");
		// The fixture's own stdout reached the step summary: the real child ran.
		expect(text).toContain("population-fixture: --summary");
		expect(text).not.toContain("Not executed");
		expect(text).toContain("windows_vitest=skipped");
	});

	// The safety direction of the same seam under GitHub's real `-eo pipefail`
	// flags: a population script that exits nonzero must abort the step, never
	// fall through to a `windows_vitest=` line that reads as a clean run.
	// Measured on the host: without `-e` the same block exits 0 and writes
	// `windows_vitest=success` even though `node` failed.
	it("does not write a clean outcome when the population script exits nonzero", () => {
		const { result, summary } = runSummary("nodefail", true, 3);
		expect(result.status, String(result.stderr)).not.toBe(0);
		expect(readFileSync(summary, "utf8")).not.toContain(
			"windows_vitest=skipped",
		);
	});
});

// #3926 root-cause witness: reproduces the refspec-form mechanism against the
// real `git` binary through the registered `git-fixture-env` seam. The local
// transport proves the form difference (by-name fails after the ref is
// deleted; by-captured-SHA resolves the object); GitHub's own server-side
// policy is established by the same-run, same-second sibling successes in
// INVESTIGATION.md.
describe("#3926 the merge ref disappears but the captured commit resolves", () => {
	const fixture = setupTestEnvironment("pi-lens-3926-git-");
	afterAll(() => fixture.cleanup());

	// The fixture owns its identity through the four environment keys Git reads
	// for BOTH roles. The git-fixture-env seam pins GIT_CONFIG_GLOBAL at
	// `<cwd>/gitconfig` and discards a caller override, so a config-file identity
	// never reaches git here; without these four keys `git commit` dies with
	// "Author identity unknown" on any host with no ambient identity (#3926 r3).
	it("fails the by-name fetch and succeeds the by-captured-SHA fetch", () => {
		const git = (cwd: string, args: string[]): string =>
			gitExecFileSync("git", args, {
				cwd,
				encoding: "utf8",
				env: {
					GIT_AUTHOR_NAME: "pi-lens test",
					GIT_AUTHOR_EMAIL: "test@example.com",
					GIT_COMMITTER_NAME: "pi-lens test",
					GIT_COMMITTER_EMAIL: "test@example.com",
				},
			});

		const work = resolve(fixture.tmpDir, "work");
		const origin = resolve(fixture.tmpDir, "origin.git");
		mkdirSync(work, { recursive: true });
		git(work, ["init", "-q", "-b", "master"]);
		writeFileSync(resolve(work, "base.txt"), "base\n");
		git(work, ["add", "-A"]);
		git(work, ["commit", "-qm", "base"]);
		const base = git(work, ["rev-parse", "HEAD"]).trim();

		git(work, ["checkout", "-q", "-b", "pr"]);
		writeFileSync(resolve(work, "head.txt"), "head\n");
		git(work, ["add", "-A"]);
		git(work, ["commit", "-qm", "head"]);
		const head = git(work, ["rev-parse", "HEAD"]).trim();

		// The base advances independently, so the test merge is a real two-parent
		// commit with no parent reachable through the PR head.
		git(work, ["checkout", "-q", "master"]);
		writeFileSync(resolve(work, "main.txt"), "main\n");
		git(work, ["add", "-A"]);
		git(work, ["commit", "-qm", "main advance"]);
		const main = git(work, ["rev-parse", "HEAD"]).trim();

		git(work, ["merge", "--no-ff", "-q", "-m", "test merge", "pr"]);
		const merge = git(work, ["rev-parse", "HEAD"]).trim();
		expect(
			[base, head, main, merge].every((sha) => /^[0-9a-f]{40}$/.test(sha)),
		).toBe(true);
		expect(new Set([base, head, main, merge]).size).toBe(4);

		git(work, ["checkout", "-q", "master"]);
		git(work, ["reset", "-q", "--hard", main]);
		git(work, ["update-ref", "refs/pull/7/head", head]);
		git(work, ["update-ref", "refs/pull/7/merge", merge]);
		git(fixture.tmpDir, ["init", "-q", "--bare", origin]);
		git(work, [
			"push",
			"-q",
			origin,
			"refs/heads/master:refs/heads/master",
			"refs/pull/7/head:refs/pull/7/head",
			"refs/pull/7/merge:refs/pull/7/merge",
		]);

		// The merge commit is now reachable only through the mutable ref that the
		// merge deletes. A clone after the deletion does not carry the object.
		git(origin, ["update-ref", "-d", "refs/pull/7/merge"]);
		const consumer = resolve(fixture.tmpDir, "consumer");
		git(fixture.tmpDir, ["clone", "-q", "--no-local", origin, consumer]);

		const byName = (() => {
			try {
				git(consumer, [
					"fetch",
					"origin",
					"+refs/pull/7/merge:refs/remotes/pull/7/merge",
				]);
				return "succeeded";
			} catch (error) {
				return String((error as { stderr?: Buffer | string }).stderr ?? error);
			}
		})();
		expect(byName).toContain("couldn't find remote ref refs/pull/7/merge");

		expect(() =>
			git(consumer, ["fetch", "origin", `+${merge}:refs/remotes/pull/7/b1`]),
		).not.toThrow();
		expect(git(consumer, ["rev-parse", "refs/remotes/pull/7/b1"]).trim()).toBe(
			merge,
		);
	});
});
