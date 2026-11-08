// #4005 (from the #3995 census): the Stryker mutation lane is a nightly,
// exploratory test-adequacy report, not a per-PR job. The real YAML is loaded
// and judged by one shape function; each MUTATION case below plants one
// regression into the real text and expects the function to name it.
// #4077: the issue edit is its own guarded job (`publish-issue`, issues: write);
// `prepare` and `publish` are read-only so a branch dispatch runs the pipeline.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");
const NIGHTLY = ".github/workflows/stryker-nightly.yml";
const nightlySource = readFileSync(resolve(ROOT, NIGHTLY), "utf8");

type Step = {
	id?: string;
	name?: string;
	uses?: string;
	if?: string;
	run?: string;
	"continue-on-error"?: boolean;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
};
type Job = {
	if?: unknown;
	needs?: unknown;
	permissions?: Record<string, string>;
	steps?: Step[];
	"timeout-minutes"?: number;
};
type Workflow = {
	on?: Record<string, unknown>;
	concurrency?: { group?: string; "cancel-in-progress"?: boolean };
	permissions?: unknown;
	jobs?: Record<string, Job>;
};

const load = (text: string) => yaml.load(text) as Workflow;
const WRITE_GUARD =
	"github.event_name == 'schedule' || github.ref == 'refs/heads/master'";

/** Every way the nightly workflow can stop being the #4005 shape. */
function nightlyFindings(text: string): string[] {
	const findings: string[] = [];
	const workflow = load(text);
	const triggers = Object.keys(workflow.on ?? {});
	for (const forbidden of [
		"pull_request",
		"pull_request_target",
		"push",
		"merge_group",
	]) {
		if (triggers.includes(forbidden)) findings.push(`trigger: ${forbidden}`);
	}
	if (!triggers.includes("schedule")) findings.push("no schedule trigger");
	if (JSON.stringify(workflow.permissions) !== "{}")
		findings.push("workflow-level permissions are not {}");

	const jobs = Object.entries(workflow.jobs ?? {});
	if (jobs.length !== 4) findings.push(`jobs: ${jobs.length}, expected 4`);
	const prepare = workflow.jobs?.prepare ?? ({} as Job);
	const mutate = workflow.jobs?.mutate ?? ({} as Job);
	const publish = workflow.jobs?.publish ?? ({} as Job);
	const issueJob = workflow.jobs?.["publish-issue"] ?? ({} as Job);
	// Recurrence: #4077, a write scope on a job a branch dispatch runs. Only
	// `publish-issue` holds `issues: write`; `prepare` only lists the issue.
	for (const [name, job, expected] of [
		["prepare", prepare, { contents: "read", issues: "read" }],
		["mutate", mutate, { contents: "read" }],
		["publish", publish, { contents: "read" }],
		["publish-issue", issueJob, { contents: "read", issues: "write" }],
	] as const) {
		if (
			JSON.stringify(Object.entries(job.permissions ?? {}).sort()) !==
			JSON.stringify(Object.entries(expected).sort())
		)
			findings.push(
				`job permissions ${name} are not ${JSON.stringify(expected)}`,
			);
	}
	for (const [name, job] of [
		["prepare", prepare],
		["mutate", mutate],
		["publish", publish],
	] as const) {
		const text = String(job.if ?? "");
		if (/github\.ref|event_name/.test(text))
			findings.push(
				`read-only job ${name} is scoped away from branch dispatch`,
			);
	}
	const steps = [
		...(prepare.steps ?? []),
		...(mutate.steps ?? []),
		...(publish.steps ?? []),
		...(issueJob.steps ?? []),
	];
	const run = (step: Step) => step.run ?? "";
	const window = (prepare.steps ?? []).find((step) => step.id === "window");
	const windowIndex = (prepare.steps ?? []).indexOf(window ?? ({} as Step));
	if (
		windowIndex < 0 ||
		!(prepare.steps ?? [])
			.slice(0, windowIndex)
			.some((step) => run(step).includes("npm ci --ignore-scripts"))
	)
		findings.push("window step runs before dependencies are installed");
	if (!/-- clients tools mcp index\.ts\b/.test(run(window ?? {})))
		findings.push("window step does not scope the diff to the runtime paths");
	if (
		!/stryker-nightly\.mjs base .*--title "\$TRACKING_TITLE"/.test(
			run(window ?? {}),
		)
	)
		findings.push(
			"window step does not read the state under the tracking title",
		);

	const driver = steps.find((step) =>
		run(step).includes("scripts/stryker-diff.mjs"),
	);
	if (!driver || !/--base "\$BASE"/.test(run(driver)))
		findings.push("driver step is not run over the window's base");
	// Recurrence (#4035): the nightly cap must match the maintainer-approved
	// 24-file intake; a stale lower pin silently grows the carry-over queue.
	if (driver && !/--max-files 12\b/.test(run(driver)))
		findings.push("driver does not use the 12-file shard cap");
	if (driver && !/--total-max-files 24\b/.test(run(driver)))
		findings.push("driver does not use the 24-file total cap");
	if (driver && driver["continue-on-error"] !== true)
		findings.push("driver failure would skip the tracking-issue step");
	// Recurrence (#4005 r2): scripts/**/*.mjs competing with runtime files for
	// the --max-files slots, which pushed runtime files over the cap.
	if (driver && !/--runtime-only\b/.test(run(driver)))
		findings.push("driver step is not restricted to the runtime paths");

	// Recurrence (#4005 r3): the carry-over queue not reaching the driver, or a
	// run skipped on an empty window while files are still queued.
	if (
		!/stryker-nightly\.mjs base [^\n]*--pending-out "\$RUNNER_TEMP\/stryker-nightly-pending\.txt"/.test(
			run(window ?? {}),
		)
	)
		findings.push(
			"window step does not write the carry-over queue for the driver",
		);
	if (
		!/&& \[ ! -s "\$RUNNER_TEMP\/stryker-nightly-pending\.txt" \]/.test(
			run(window ?? {}),
		)
	)
		findings.push("an empty window would skip a run while files are queued");
	if (
		driver &&
		!/--pending-file "\$RUNNER_TEMP\/stryker-nightly-pending\.txt"/.test(
			run(driver),
		)
	)
		findings.push("driver step does not take the queue");
	// Recurrence (#4005 r3): the body step recomputing the queue from nothing, so
	// a failed night would clear it.
	const bodyStep = (publish.steps ?? []).find((step) =>
		run(step).includes("stryker-nightly.mjs body"),
	);
	if (
		!/stryker-nightly\.mjs body --issues "\$RUNNER_TEMP\/stryker-nightly-issues\.json" --title "\$TRACKING_TITLE"/.test(
			run(bodyStep ?? {}),
		)
	)
		findings.push(
			"the body step does not read the previous queue from the tracking issue",
		);

	// Recurrence (#4005 r2 X1): two overlapping runs (a dispatch during the
	// schedule) read the same marker and write the issue out of order.
	if (
		workflow.concurrency?.group !== "stryker-nightly" ||
		workflow.concurrency?.["cancel-in-progress"] !== false
	)
		findings.push(
			"concurrency is not the non-cancelling stryker-nightly group",
		);

	// Recurrence (#4005 r2 X2): publishing a successful status despite a failed
	// shard advanced the marker over an incomplete night.
	const body = (publish.steps ?? []).find((step) =>
		run(step).includes("stryker-nightly.mjs body"),
	);
	const bodyRun = run(body ?? {});
	if (
		!body ||
		!bodyRun.includes("combined-outcomes.json") ||
		!bodyRun.includes("process.stdout.write(x.status)") ||
		!/stryker-nightly\.mjs body .*--status "\$STATUS"/.test(bodyRun)
	)
		findings.push(
			"the body's --status is not derived from the combined shard outcomes",
		);

	const upsert = (issueJob.steps ?? []).find((step) =>
		run(step).includes("scripts/upsert-tracking-issue.mjs"),
	);
	if (
		!upsert ||
		!/upsert-tracking-issue\.mjs --title "\$TRACKING_TITLE" --label nightly-drift --body-file/.test(
			run(upsert),
		)
	)
		findings.push("no title-keyed upsert step on the nightly-drift label");
	if (
		upsert &&
		!String(upsert.if ?? "").includes(WRITE_GUARD) &&
		!String(issueJob.if ?? "").includes(WRITE_GUARD)
	)
		findings.push("the issue writer is not scoped to schedule or master");
	// Recurrence: #4077, the body the writer posts is the one the read-only job
	// built: one artifact name on both sides, and the writer needs the builder.
	const bodyUpload = (publish.steps ?? []).find((step) =>
		step.uses?.startsWith("actions/upload-artifact@"),
	);
	const bodyDownload = (issueJob.steps ?? []).find((step) =>
		step.uses?.startsWith("actions/download-artifact@"),
	);
	if (
		issueJob.needs !== "publish" ||
		!bodyUpload ||
		bodyUpload.with?.name !== bodyDownload?.with?.name ||
		!String(bodyUpload.with?.path ?? "").endsWith("/stryker-nightly-body.md")
	)
		findings.push("the issue writer does not take the publish job's body");
	if (/gh issue (create|edit|comment|close)/.test(steps.map(run).join("\n")))
		findings.push("a raw gh issue write bypasses the shared upsert CLI");

	if (
		!steps.some((step) =>
			/^steps\.stryker\.outcome == 'failure'$/.test(step.if ?? ""),
		)
	)
		findings.push("no step turns a driver failure into a red run");
	const checkout = steps.find((step) =>
		step.uses?.startsWith("actions/checkout@"),
	);
	if (checkout?.with?.["fetch-depth"] !== 0)
		findings.push("checkout is shallow: git diff <sha>..HEAD needs history");

	// Recurrence (run 37599048379): `path: "$RUNNER_TEMP/..."` on
	// download-artifact is a literal directory under the workspace, because no
	// shell expands an action input; both shards and publish found nothing.
	for (const step of steps)
		for (const [key, value] of Object.entries(step.with ?? {}))
			if (/\$[A-Za-z_{]/.test(String(value).replace(/\$\{\{[^}]*\}\}/g, "")))
				findings.push(`action input ${key} names a shell variable: ${value}`);
	// Recurrence (#4038 r3): `npm ci --ignore-scripts` skips the `prepare`
	// grammar download that the Vitest runs under Stryker parse with.
	const mutateSteps = mutate.steps ?? [];
	const grammars = mutateSteps.findIndex((step) =>
		run(step).includes(
			"node scripts/download-grammars.js --core --dest grammars",
		),
	);
	if (grammars < 0 || grammars > mutateSteps.indexOf(driver ?? {}))
		findings.push(
			"the mutate job does not download the core grammars before the driver",
		);
	// Recurrence (run 37601788256): the LSP fixture tests in a shard's dry run
	// import dist/, which `npm run build` does not produce; Stryker's initial
	// test run failed in both shards.
	const dist = mutateSteps.findIndex((step) =>
		/^npm run build:dist$/m.test(run(step)),
	);
	if (dist < 0 || dist > mutateSteps.indexOf(driver ?? {}))
		findings.push("the mutate job does not build dist/ before the driver");
	// Recurrence (nightly triage 2026-10-29, #4171): a bare
	// `node scripts/stryker-diff.mjs` has no node_modules/.bin on PATH (only
	// `npm run` adds it), so the ast-grep and formatter tests the mutation runs
	// execute looked their CLI up on PATH and redded the initial run. The same
	// export shuffle-census-nightly.yml's census step carries.
	const driverRun = run(driver ?? {});
	const pathExport = driverRun.indexOf(
		'export PATH="$GITHUB_WORKSPACE/node_modules/.bin:$PATH"',
	);
	if (
		pathExport < 0 ||
		pathExport > driverRun.indexOf("node scripts/stryker-diff.mjs")
	)
		findings.push(
			"the mutate job does not put node_modules/.bin on PATH before the driver",
		);
	// Recurrence (#4038 r4, the re-run cell): a shard artifact an earlier
	// attempt left must not stand in for this night's shard, and a re-run
	// attempt must be able to replace it.
	const stamp = "${{ needs.prepare.outputs.window }}";
	const combine = (publish.steps ?? []).find((step) =>
		run(step).includes("stryker-nightly.mjs combine"),
	);
	if (
		driver?.env?.WINDOW !== stamp ||
		!/"window":"%s"\}\\n' "\$\{\{ matrix\.shard \}\}" "\$rc" "\$WINDOW" > "\$RUNNER_TEMP\/shard\/shard\.json"/.test(
			run(driver ?? {}),
		) ||
		combine?.env?.WINDOW !== stamp ||
		!run(combine ?? {}).includes('--window "$WINDOW"')
	)
		findings.push("shard artifacts are not bound to the night's window");
	if (
		steps.some(
			(step) =>
				step.uses?.startsWith("actions/upload-artifact@") &&
				step.with?.overwrite !== true,
		)
	)
		findings.push(
			"an artifact upload cannot be replaced by a re-run (overwrite)",
		);
	return findings;
}

describe("stryker-nightly.yml (#4005)", () => {
	it("has exactly the nightly report shape", () => {
		expect(nightlyFindings(nightlySource)).toEqual([]);
	});

	// Recurrence: #3995's census, 11-18% of CI job-minutes per push for no
	// product defect. Nothing but the nightly workflow may run the driver, and
	// no workflow that can start on a pull request may mention it.
	it("is the only workflow that runs the Stryker driver, and none reachable from a pull request does", () => {
		const offenders: string[] = [];
		const entries = readdirSync(WORKFLOWS).filter((entry) =>
			/\.ya?ml$/.test(entry),
		);
		// 21 workflow files on 2026-10-07; half, rounded down.
		assertNonEmptyScan(
			"workflow files walked for the Stryker driver",
			entries.length,
			10,
		);
		for (const entry of entries) {
			const text = readFileSync(resolve(WORKFLOWS, entry), "utf8");
			const triggers = Object.keys(load(text).on ?? {});
			const touchesPullRequest = triggers.some((trigger) =>
				["pull_request", "pull_request_target", "merge_group"].includes(
					trigger,
				),
			);
			const runsDriver =
				/stryker-diff\.mjs|stryker-mutator|mutation-report/.test(text);
			if (runsDriver && entry !== "stryker-nightly.yml")
				offenders.push(`${entry} runs the driver`);
			if (runsDriver && touchesPullRequest)
				offenders.push(`${entry} is reachable from a pull request`);
		}
		expect(offenders).toEqual([]);
	});

	// Recurrence (#3801 -> #4005): the lane returned as a `mutation` job in
	// ci.yml, where it queued behind the (since retired) heavy gate on every code PR.
	it("leaves no mutation job and no sticky-comment script in ci.yml", () => {
		const ci = load(readFileSync(resolve(WORKFLOWS, "ci.yml"), "utf8"));
		expect(
			Object.keys(ci.jobs ?? {}).filter((id) => /mutation/i.test(id)),
		).toEqual([]);
		expect(readFileSync(resolve(WORKFLOWS, "ci.yml"), "utf8")).not.toMatch(
			/mutation-pr-comment|stryker/i,
		);
	});

	// The per-case mutations: each takes the REAL workflow text, plants one
	// regression, and demands the shape function names it.
	const mutations: Array<[string, (text: string) => string, RegExp]> = [
		[
			"re-adding the pull_request trigger",
			(text) =>
				text.replace("on:\n", "on:\n  pull_request:\n    branches: [master]\n"),
			/trigger: pull_request/,
		],
		[
			"re-adding a push trigger",
			(text) => text.replace("on:\n", "on:\n  push:\n    branches: [master]\n"),
			/trigger: push/,
		],
		[
			"dropping the schedule",
			(text) => text.replace(/  schedule:\n    - cron: [^\n]*\n/, ""),
			/no schedule trigger/,
		],
		[
			"widening the writer job's permissions",
			(text) =>
				text.replace(
					"    permissions:\n      contents: read\n      issues: write\n",
					"    permissions:\n      contents: write\n      issues: write\n",
				),
			/job permissions publish-issue/,
		],
		[
			"dropping the writer job's issues: write",
			(text) => text.replace("      issues: write\n", ""),
			/job permissions publish-issue/,
		],
		[
			"giving the read-only publish job issues: write (#4077)",
			(text) => {
				const [head, tail] = text.split("\n  publish:\n");
				return `${head}\n  publish:\n${tail.replace("      contents: read\n", "      contents: read\n      issues: write\n")}`;
			},
			/job permissions publish /,
		],
		[
			"giving the prepare job issues: write back (#4077)",
			(text) => text.replace("      issues: read\n", "      issues: write\n"),
			/job permissions prepare/,
		],
		[
			"re-guarding the read-only prepare job away from branch dispatch (#4077)",
			(text) =>
				text.replace(
					"  prepare:\n    name: Prepare nightly window\n",
					"  prepare:\n    name: Prepare nightly window\n    if: github.event_name == 'schedule' || github.ref == 'refs/heads/master'\n",
				),
			/read-only job prepare is scoped away/,
		],
		[
			"the writer posting a different artifact than publish built (#4077)",
			(text) =>
				text.replace(
					"name: nightly-body\n          path: ${{ runner.temp }}\n",
					"name: nightly-bodies\n          path: ${{ runner.temp }}\n",
				),
			/does not take the publish job's body/,
		],
		[
			"widening the workflow-level permissions",
			(text) => text.replace("permissions: {}", "permissions: write-all"),
			/workflow-level permissions/,
		],
		[
			"dropping the writer job's schedule/master scope",
			(text) =>
				text.replace(
					"if: always() && (github.event_name == 'schedule' || github.ref == 'refs/heads/master') && needs.publish.result == 'success'",
					"if: always() && needs.publish.result == 'success'",
				),
			/not scoped to schedule or master/,
		],
		[
			"replacing the shared upsert with a raw gh issue write",
			(text) =>
				text.replace(
					'node scripts/upsert-tracking-issue.mjs --title "$TRACKING_TITLE"',
					'gh issue create --title "$TRACKING_TITLE"',
				),
			/no title-keyed upsert step|raw gh issue write/,
		],
		[
			"letting a driver failure skip the tracking issue",
			(text) =>
				text.replace(
					"        continue-on-error: true\n        env:\n          BASE",
					"        env:\n          BASE",
				),
			/driver failure would skip/,
		],
		[
			"the combined outcome is hard-coded ok",
			(text) =>
				text.replace(
					"process.stdout.write(x.status)",
					'process.stdout.write("ok")',
				),
			/combined shard outcomes/,
		],
		[
			"the concurrency block deleted (X1)",
			(text) =>
				text.replace(
					/concurrency:\n  group: stryker-nightly\n  cancel-in-progress: false\n/,
					"",
				),
			/concurrency is not/,
		],
		[
			"a cancelling concurrency group",
			(text) =>
				text.replace("cancel-in-progress: false", "cancel-in-progress: true"),
			/concurrency is not/,
		],
		[
			"dropping node_modules/.bin from the mutate PATH (#4171)",
			(text) =>
				text.replace(
					'          export PATH="$GITHUB_WORKSPACE/node_modules/.bin:$PATH"\n',
					"",
				),
			/does not put node_modules\/\.bin on PATH/,
		],
		[
			"exporting node_modules/.bin only after the driver ran (#4171)",
			(text) => {
				const exportLine = /^ +export PATH="[^"]*"\n/m.exec(text)?.[0] ?? "";
				return text
					.replace(exportLine, "")
					.replace(
						/(node scripts\/stryker-diff\.mjs [^\n]*\n)/,
						(line) => `${line}${exportLine}`,
					);
			},
			/does not put node_modules\/\.bin on PATH/,
		],
		[
			"the driver loses --runtime-only",
			(text) => text.replace(" --runtime-only", ""),
			/not restricted to the runtime paths/,
		],
		[
			"the nightly shard cap rises above 12 files",
			(text) => text.replace("--max-files 12", "--max-files 13"),
			/does not use the 12-file shard cap/,
		],
		[
			"the queue file not written for the driver",
			(text) =>
				text.replace(
					' --pending-out "$RUNNER_TEMP/stryker-nightly-pending.txt"',
					"",
				),
			/does not write the carry-over queue/,
		],
		[
			"an empty window skipping a run while files are queued",
			(text) =>
				text.replace(
					' && [ ! -s "$RUNNER_TEMP/stryker-nightly-pending.txt" ]',
					"",
				),
			/would skip a run while files are queued/,
		],
		[
			"the driver not given the queue",
			(text) =>
				text.replace(
					'ARGS+=(--pending-file "$RUNNER_TEMP/stryker-nightly-pending.txt")',
					"true",
				),
			/does not take the queue/,
		],
		[
			"the body step not reading the previous queue",
			(text) =>
				text.replace(
					' --issues "$RUNNER_TEMP/stryker-nightly-issues.json" --title "$TRACKING_TITLE" --base',
					" --base",
				),
			/does not read the previous queue/,
		],
		[
			"a shallow checkout",
			(text) => text.replace("          fetch-depth: 0\n", ""),
			/checkout is shallow/,
		],
		[
			"a download path written as a shell variable (run 37599048379)",
			(text) =>
				text.replace(
					"path: ${{ runner.temp }}/mutation-shards",
					'path: "$RUNNER_TEMP/mutation-shards"',
				),
			/action input path names a shell variable/,
		],
		[
			"the mutate job's grammar download dropped",
			(text) =>
				text.replace(
					"        run: node scripts/download-grammars.js --core --dest grammars\n",
					"        run: echo skipped\n",
				),
			/does not download the core grammars/,
		],
		[
			"the mutate job's dist build dropped (run 37601788256)",
			(text) => text.replace("      - run: npm run build:dist\n", ""),
			/does not build dist\//,
		],
		[
			"the writer job's download path written as a shell variable",
			(text) =>
				text.replace(
					"name: nightly-body\n          path: ${{ runner.temp }}\n",
					'name: nightly-body\n          path: "$RUNNER_TEMP"\n',
				),
			/action input path names a shell variable/,
		],
		[
			"combine not given the night's window",
			(text) => text.replace(' --window "$WINDOW"', ""),
			/not bound to the night's window/,
		],
		[
			"the shard record written without its window stamp",
			(text) => text.replace('"$rc" "$WINDOW"', '"$rc" ""'),
			/not bound to the night's window/,
		],
		[
			"an artifact upload without overwrite",
			(text) => text.replace("          overwrite: true\n", ""),
			/cannot be replaced by a re-run/,
		],
		[
			"widening the diff scope away from the runtime paths",
			(text) => text.replace("-- clients tools mcp index.ts", "-- ."),
			/runtime paths/,
		],
	];

	it.each(mutations)(
		"MUTATION: %s reds the shape",
		(_label, mutate, expected) => {
			const mutated = mutate(nightlySource);
			expect(mutated, "the mutation must change the workflow").not.toBe(
				nightlySource,
			);
			expect(nightlyFindings(mutated).join("\n")).toMatch(expected);
		},
	);
});
