// #2723: `Tool smoke (nightly)`'s only tracking-issue writer
// (`Notify on silentOnClean drift`, #529/#594) sat behind the LSP handshake
// layer step with `continue-on-error: true` but no `if: always()`, so
// GitHub SKIPPED it -- and everything after it -- exactly when an earlier
// step failed, i.e. exactly when a human most needed to hear about it (13
// consecutive red nights with no automated notice). This file pins the
// FIX's own shape so the same defect can't recur silently on either step:
// each issue writer must run after failures only for scheduled/default-branch
// runs, and the job-verdict writer must actually read all gating outcomes.
//
// #4077 split the old single job: `tool-smoke` is read-only and runs on any
// ref; the notifiers moved to `tool-smoke-notify` (job-level `if:`, outcomes
// through `needs.tool-smoke.outputs`, logs through the staged artifact) and the
// refresh PRs to `tool-smoke-prs`. The #2723 recurrence (a writer skipped
// exactly when an earlier step failed) is now two places: the writer job's
// `if: always()` AND the producer's `if: always()` staging steps.
//
// Same technique as tests/config/install-smoke-gates.test.ts /
// lsp-fixture-home-workflow-pin.test.ts: yaml.load the REAL workflow, assert
// on the LOADED structure -- never a hand-copied restatement of the YAML
// text. Mutation-proof below (deleting `if: always()`) reproduces #2723's
// actual bug: before this file existed, no test in the repo evaluated any
// `if:` string in this workflow, so dropping the gate was invisible.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = ".github/workflows/tool-smoke.yml";
const JOB_NAME = "tool-smoke";
const NOTIFY_JOB = "tool-smoke-notify";
const PRS_JOB = "tool-smoke-prs";
const NOTIFY_STEP_NAME = "Notify on tool-smoke red";
const CLEAN_SIGNAL_NOTIFY_STEP_NAME = "Notify on silentOnClean drift";
const DOCS_REFRESH_STEP_NAME = "Open/update LSP-docs refresh PR";
const NOTIFY_IF =
	"always() && (github.event_name == 'schedule' || github.ref == 'refs/heads/master')";
const PRS_IF = `${NOTIFY_IF} && (needs.tool-smoke.outputs.docs_changed == 'true' || needs.tool-smoke.outputs.promoted == 'true')`;

type Step = {
	name?: unknown;
	id?: unknown;
	if?: unknown;
	uses?: unknown;
	with?: Record<string, unknown>;
	run?: unknown;
	env?: Record<string, unknown>;
};
type Job = {
	if?: unknown;
	needs?: unknown;
	"continue-on-error"?: unknown;
	outputs?: Record<string, unknown>;
	steps?: unknown;
	permissions?: Record<string, unknown>;
};
type Workflow = { jobs?: Record<string, Job> };

function loadWorkflow(source?: string): Workflow {
	const text =
		source ?? readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
	return yaml.load(text) as Workflow;
}

function findStep(
	workflow: Workflow,
	nameSubstring: string,
	jobName: string = JOB_NAME,
): Step {
	const steps = workflow.jobs?.[jobName]?.steps;
	const step = Array.isArray(steps)
		? (steps as Step[]).find(
				(s) => typeof s.name === "string" && s.name.includes(nameSubstring),
			)
		: undefined;
	if (!step) {
		throw new Error(
			`${WORKFLOW_PATH}: jobs.${jobName} has no step named like "${nameSubstring}"`,
		);
	}
	return step;
}

describe("tool-smoke.yml's issue writers are scoped to nightly/default runs (#3346, #4077)", () => {
	const workflow = loadWorkflow();
	const notifyStep = findStep(workflow, NOTIFY_STEP_NAME, NOTIFY_JOB);
	const cleanSignalNotifyStep = findStep(
		workflow,
		CLEAN_SIGNAL_NOTIFY_STEP_NAME,
		NOTIFY_JOB,
	);
	const docsRefreshStep = findStep(workflow, DOCS_REFRESH_STEP_NAME, PRS_JOB);
	const notifyJob = workflow.jobs?.[NOTIFY_JOB] as Job;
	const smokeJob = workflow.jobs?.[JOB_NAME] as Job;

	// Recurrence: #2723, a writer that GitHub skips exactly when an earlier job
	// failed; #3346, a writer that ran on a branch dispatch.
	it("pins every issue and PR writer job to schedule/default-branch runs", () => {
		expect(notifyJob.if).toBe(NOTIFY_IF);
		expect(workflow.jobs?.[PRS_JOB]?.if).toBe(PRS_IF);
		expect(notifyJob.needs).toBe(JOB_NAME);
		expect(workflow.jobs?.[PRS_JOB]?.needs).toBe(JOB_NAME);
	});

	// Recurrence: #4077, a write token on the job that runs the smoke, so a
	// branch dispatch held it while running unreviewed branch code.
	it("keeps the smoke job read-only and the notify job at issues: write only", () => {
		expect(smokeJob.permissions).toEqual({
			contents: "read",
			"pull-requests": "read",
		});
		expect(notifyJob.permissions).toEqual({
			contents: "read",
			issues: "write",
		});
		expect(workflow.jobs?.[PRS_JOB]?.permissions).toEqual({
			contents: "write",
			"pull-requests": "write",
		});
	});

	it("runs the four notifiers in order, the job-verdict writers last (must observe every gating layer)", () => {
		const names = (notifyJob.steps as Step[]).map((s) => String(s.name ?? ""));
		const at = (needle: string) => names.findIndex((n) => n.includes(needle));
		expect(at(CLEAN_SIGNAL_NOTIFY_STEP_NAME)).toBeGreaterThan(-1);
		expect(at("Notify on idle-eviction drift")).toBeGreaterThan(
			at(CLEAN_SIGNAL_NOTIFY_STEP_NAME),
		);
		expect(at("Notify on LSP capability census")).toBeGreaterThan(
			at(NOTIFY_STEP_NAME),
		);
		expect(names[names.length - 1]).toContain(
			"Notify on LSP capability census",
		);
	});

	// Recurrence: #4077 split, a notifier that stops being best-effort turns a
	// tracker failure into a red nightly.
	it("carries continue-on-error: true (a notifier failure must never redden the nightly)", () => {
		for (const step of [cleanSignalNotifyStep, notifyStep]) {
			expect(
				(step as Step & { "continue-on-error"?: unknown })["continue-on-error"],
			).toBe(true);
		}
		expect(notifyJob["continue-on-error"]).toBe(true);
	});

	it("runs the docs refresh writer only for scheduled/default-branch runs with a changed doc (#3380)", () => {
		expect(workflow.jobs?.[PRS_JOB]?.if).toBe(PRS_IF);
		expect(docsRefreshStep.if).toBe(
			"needs.tool-smoke.outputs.docs_changed == 'true' && needs.tool-smoke.outputs.census == 'success'",
		);
	});

	it("reads all six gating layers' step outcomes via the smoke job's outputs, by expression (not hardcoded literals)", () => {
		const env = notifyStep.env ?? {};
		expect(env.TOOL_LAYER_OUTCOME).toBe(
			"${{ needs.tool-smoke.outputs.tool_layer }}",
		);
		expect(env.LSP_HANDSHAKE_OUTCOME).toBe(
			"${{ needs.tool-smoke.outputs.lsp_handshake }}",
		);
		expect(env.LSP_GATE_OUTCOME).toBe(
			"${{ needs.tool-smoke.outputs.lsp_gate }}",
		);
		expect(env.LENS_FULL_OUTCOME).toBe(
			"${{ needs.tool-smoke.outputs.lens_full }}",
		);
		expect(env.FORMAT_LAYER_OUTCOME).toBe(
			"${{ needs.tool-smoke.outputs.format_layer }}",
		);
		expect(env.RESOLUTION_LAYER_OUTCOME).toBe(
			"${{ needs.tool-smoke.outputs.resolution_layer }}",
		);
	});

	// Recurrence: an output wired to the wrong step id reads "" in the notifier,
	// which decideAction treats as a wiring bug and takes no action on.
	it("each job output the notifier reads is the outcome of the layer step with that id", () => {
		for (const id of [
			"tool_layer",
			"lsp_handshake",
			"lsp_gate",
			"lens_full",
			"format_layer",
			"resolution_layer",
		]) {
			expect(smokeJob.outputs?.[id]).toBe(`\${{ steps.${id}.outcome }}`);
		}
	});

	it("each referenced layer step actually declares the id the notify step reads", () => {
		expect(findStep(workflow, "Tool layer").id).toBe("tool_layer");
		expect(findStep(workflow, "LSP handshake layer").id).toBe("lsp_handshake");
		expect(findStep(workflow, "LSP diagnostics clean-gate").id).toBe(
			"lsp_gate",
		);
		expect(findStep(workflow, "lens_diagnostics mode=full row").id).toBe(
			"lens_full",
		);
		expect(findStep(workflow, "Format layer").id).toBe("format_layer");
		expect(findStep(workflow, "Resolution layer").id).toBe("resolution_layer");
	});

	// #2723 review F3: disambiguates "the job failed before the six
	// tracked layers even started" from a genuine cancellation -- both
	// leave all six layers "skipped", which decideAction alone cannot
	// tell apart (see scripts/lib/tool-smoke-drift.mjs's decideToolSmokeAction).
	// The smoke job's own result is the old `job.status` once the notifier is
	// a separate job.
	it("reads the smoke job's result so the notifier can tell a genuine failure outside the tracked layers from a cancellation", () => {
		const env = notifyStep.env ?? {};
		expect(env.JOB_STATUS).toBe("${{ needs.tool-smoke.result }}");
	});

	it("invokes the notifier script", () => {
		expect(notifyStep.run).toContain("scripts/notify-tool-smoke-red.mjs");
	});

	// Recurrence: #4077, the staging steps skipped when a layer failed, which
	// hands the writer an empty or missing artifact exactly on a red night.
	it("stages and uploads the notifier inputs after every gating layer and the Sonar gate, on every outcome", () => {
		const steps = smokeJob.steps as Step[];
		const index = (name: string) =>
			steps.findIndex(
				(s) => typeof s.name === "string" && s.name.includes(name),
			);
		const stage = index("Stage the notifier inputs");
		for (const layer of [
			"Tool layer",
			"LSP handshake layer",
			"LSP diagnostics clean-gate",
			"lens_diagnostics mode=full row",
			"Format layer",
			"Resolution layer",
			"SonarCloud master quality gate",
		])
			expect(stage).toBeGreaterThan(index(layer));
		expect(steps[stage].if).toBe("always()");
		const upload = steps[stage + 1] as Step & {
			uses?: unknown;
			with?: Record<string, unknown>;
		};
		expect(String(upload.uses)).toContain("actions/upload-artifact@");
		expect(upload.if).toBe("always()");
		expect(upload.with?.name).toBe("tool-smoke-notify-inputs");
	});

	// Recurrence: #4077, the refresh-PR hand-off staged after the later layers
	// (Format and the rest) would carry whatever they leave in the tree, where the
	// old PR steps ran before them; staged under a skipped condition it hands the
	// writer an empty artifact.
	it("stages the refresh-PR inputs right after the docs diff, before any later layer, on every outcome", () => {
		const steps = smokeJob.steps as Step[];
		const index = (name: string) =>
			steps.findIndex(
				(s) => typeof s.name === "string" && s.name.includes(name),
			);
		const stage = index("Stage the refresh-PR inputs");
		expect(stage).toBe(index("LSP capability census") + 1);
		expect(stage).toBeLessThan(index("Format layer"));
		const condition =
			"always() && (steps.docs_diff.outputs.changed == 'true' || steps.idle_promote.outputs.promoted == 'true')";
		expect(steps[stage].if).toBe(condition);
		expect(steps[stage + 1].if).toBe(condition);
		expect((steps[stage + 1] as Step).with?.name).toBe("tool-smoke-pr-inputs");
		// What the PR job downloads is what this step uploads.
		const prSteps = (workflow.jobs?.[PRS_JOB]?.steps ?? []) as Step[];
		const download = prSteps.find((s) =>
			String(s.uses).includes("download-artifact@"),
		);
		expect(download?.with?.name).toBe("tool-smoke-pr-inputs");
	});

	it("keeps the Sonar master gate as a real end-of-layers gate before staging and notification (#3319)", () => {
		const steps = workflow.jobs?.[JOB_NAME]?.steps as Step[];
		const sonarIndex = steps.findIndex(
			(step) => step.name === "SonarCloud master quality gate",
		);
		// Only the notifier hand-off (stage + upload) follows it.
		expect(
			steps.slice(sonarIndex + 1).map((s) => String(s.name ?? s.uses)),
		).toEqual([
			"Stage the notifier inputs",
			expect.stringContaining("actions/upload-artifact@"),
		]);
		const sonarStep = steps[sonarIndex] as Step & {
			"continue-on-error"?: unknown;
		};
		expect(sonarStep.id).toBe("sonar_master_gate");
		// Reads MASTER's gate: scoped to the schedule / master ref exactly like
		// the notifier below, so a PR's exact-head branch dispatch cannot go red
		// on master's Sonar state (it did on 2026-09-24, PR #3350's nightly).
		expect(sonarStep.if).toBe(NOTIFY_IF);
		expect(sonarStep.run).toBe("node scripts/sonar-master-gate.mjs");
		expect(sonarStep["continue-on-error"]).not.toBe(true);
	});

	// Mutation-proof: this is #2723's ACTUAL bug, reproduced against the fix.
	// Before this file existed, deleting `if: always()` from a notify step
	// left every other test in the repo green -- no test evaluated this
	// workflow's `if:` strings at all. It is now the writer JOB's `if:`.
	it("mutation-proof: deleting if: always() from the notify job reds this file's own gate assertion", () => {
		const source = readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
		const lines = source.split("\n");
		const jobIdx = lines.findIndex((l) => l === `  ${NOTIFY_JOB}:`);
		expect(jobIdx).toBeGreaterThanOrEqual(0);
		const ifLineIdx = lines.findIndex(
			(l, i) => i > jobIdx && /^\s*if:\s*always\(\) &&/.test(l),
		);
		expect(ifLineIdx).toBeGreaterThanOrEqual(0);

		const mutatedLines = [...lines];
		mutatedLines.splice(ifLineIdx, 1);
		const mutatedSource = mutatedLines.join("\n");
		expect(mutatedSource).not.toBe(source);

		const mutatedJob = loadWorkflow(mutatedSource).jobs?.[NOTIFY_JOB] as Job;
		// With the gate gone, the job has no `if:` at all -- this is the exact
		// regression: GitHub then skips the job whenever the smoke job fails,
		// reproducing #2723 on the new job.
		expect(mutatedJob.if).toBeUndefined();
	});

	// Mutation-proof, the OTHER direction (AGENTS.md "mutate both ways"):
	// swapping `always()` for `success()` (GitHub's own implicit default when
	// no `if:` is given -- functionally identical to #2723's actual bug)
	// must fail this file's own gate assertion just as surely as deleting
	// the line outright. Proves the test discriminates "always()"
	// specifically, not merely "some if: line is present after this job".
	it("mutation-proof (other direction): swapping always() for success() reds this file's own gate assertion", () => {
		const source = readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
		const lines = source.split("\n");
		const jobIdx = lines.findIndex((l) => l === `  ${NOTIFY_JOB}:`);
		expect(jobIdx).toBeGreaterThanOrEqual(0);
		const ifLineIdx = lines.findIndex(
			(l, i) => i > jobIdx && /^\s*if:\s*always\(\) &&/.test(l),
		);
		expect(ifLineIdx).toBeGreaterThanOrEqual(0);
		const mutatedLines = [...lines];
		mutatedLines[ifLineIdx] = mutatedLines[ifLineIdx].replace(
			"always()",
			"success()",
		);
		const mutatedSource = mutatedLines.join("\n");
		expect(mutatedSource).not.toBe(source);
		const mutatedJob = loadWorkflow(mutatedSource).jobs?.[NOTIFY_JOB] as Job;
		expect(mutatedJob.if).not.toBe(NOTIFY_IF);
	});

	it("mutation-proof: dropping the event/ref scope reds the issue-writer contract", () => {
		expect(notifyJob.if).toBe(NOTIFY_IF);
		expect(notifyJob.if).not.toBe("always()");
	});

	it("mutation-proof: dropping the refresh-PR job's event/ref guard reds the #3380 gate", () => {
		const source = readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
		const lines = source.split("\n");
		const jobIdx = lines.findIndex((line) => line === `  ${PRS_JOB}:`);
		const ifLineIdx = lines.findIndex(
			(line, index) =>
				index > jobIdx &&
				/^\s*if:\s*always\(\) && \(github\.event_name/.test(line),
		);
		expect(ifLineIdx).toBeGreaterThan(jobIdx);
		const mutatedLines = [...lines];
		mutatedLines.splice(ifLineIdx, 1);
		const mutatedWorkflow = loadWorkflow(mutatedLines.join("\n"));
		expect(mutatedWorkflow.jobs?.[PRS_JOB]?.if).toBeUndefined();
	});
});

// #2723 review F4: `set -o pipefail` is LOAD-BEARING on each of the six
// gating layer steps, not documentation -- GitHub's default shell for a
// `run:` step with no `shell:` key is `bash -e {0}` (no pipefail); without
// this line, `node scripts/smoke-tools.mjs ... | tee logfile`'s exit code
// is `tee`'s (almost always 0), never the node process's, so a genuinely
// red layer would report `outcome: success` and the notifier would never
// hear about it at all -- worse than the original #2723 bug, because
// nothing would even flag it as suspicious.
describe("each gating layer step's pipe keeps set -o pipefail (#2723 review F4)", () => {
	const workflow = loadWorkflow();
	const LAYER_STEP_NAMES = [
		"Tool layer",
		"LSP handshake layer",
		"LSP diagnostics clean-gate",
		"lens_diagnostics mode=full row",
		"Format layer",
		"Resolution layer",
	];

	it.each(LAYER_STEP_NAMES)("%s's run script sets pipefail", (name) => {
		const step = findStep(workflow, name);
		expect(typeof step.run).toBe("string");
		expect(step.run as string).toMatch(/^\s*set -o pipefail\s*$/m);
	});

	// Mutation-proof: before this test existed, deleting `set -o pipefail`
	// from any layer step's run script left every other test in this repo
	// green -- nothing evaluated the run script's actual bash text.
	it.each(LAYER_STEP_NAMES)(
		"mutation-proof: deleting %s's set -o pipefail line reds this file's own assertion",
		(name) => {
			const step = findStep(workflow, name);
			const runScript = step.run as string;
			const mutated = runScript.replace(/^\s*set -o pipefail\s*\n/m, "");
			expect(mutated).not.toBe(runScript);
			expect(mutated).not.toMatch(/^\s*set -o pipefail\s*$/m);
		},
	);

	// #1513: the Resolution layer is the only step that runs the resolution
	// smoke; a swapped flag (--format, --lsp) would keep the step green while
	// the venv / vendor/bin / node_modules/.bin rungs go unwitnessed, and a
	// `continue-on-error` would let a lost rung pass the job.
	it("pins the Resolution layer to the resolution command, gating, with a bounded timeout", () => {
		const step = findStep(workflow, "Resolution layer") as Step & {
			"continue-on-error"?: unknown;
			"timeout-minutes"?: unknown;
		};
		expect(step.run).toContain("smoke-tools.mjs --resolution");
		expect(step["continue-on-error"]).not.toBe(true);
		expect(step["timeout-minutes"]).toBe(5);
	});

	it("pins the lens_full run to the full-mode command", () => {
		const step = findStep(workflow, "lens_diagnostics mode=full row");
		expect(step.run).toContain("smoke-tools.mjs --lens-full --install");
	});

	it("keeps the lens_full gate fail-fast", () => {
		const step = findStep(
			workflow,
			"lens_diagnostics mode=full row",
		) as Step & {
			"continue-on-error"?: unknown;
		};
		expect(step["continue-on-error"]).not.toBe(true);
	});
});

// #2723 review F6: the `tee` target each layer step writes to and the
// `*_LOG` env value the notify step reads are two hand-maintained string
// literals (a bash heredoc path, a YAML `${{ runner.temp }}/...` expression)
// with no shared source -- renaming either alone keeps every OTHER test in
// this repo green while silently degrading that layer to "(no report --
// step did not run)" in every future tracking-issue body, because
// readLogFile in notify-tool-smoke-red.mjs just returns null on ENOENT.
describe("each layer's tee log filename matches the notify step's *_LOG env (#2723 review F6)", () => {
	const workflow = loadWorkflow();
	const notifyStep = findStep(workflow, NOTIFY_STEP_NAME, NOTIFY_JOB);

	function teeLogFilename(runScript: string): string {
		const m = /tee\s+"\$RUNNER_TEMP\/([^"]+)"/.exec(runScript);
		if (!m) {
			throw new Error(
				`no \`tee "$RUNNER_TEMP/<file>"\` target found in run script:\n${runScript}`,
			);
		}
		return m[1];
	}

	function envLogFilename(envValue: unknown): string {
		if (typeof envValue !== "string") {
			throw new Error(`env value is not a string: ${JSON.stringify(envValue)}`);
		}
		const m = /\$\{\{\s*runner\.temp\s*\}\}\/([^/]+)$/.exec(envValue);
		if (!m) {
			throw new Error(
				`env value is not a bare "\${{ runner.temp }}/<file>" expression: ${envValue}`,
			);
		}
		return m[1];
	}

	it.each([
		["Tool layer", "TOOL_LAYER_LOG"],
		["LSP handshake layer", "LSP_HANDSHAKE_LOG"],
		["LSP diagnostics clean-gate", "LSP_GATE_LOG"],
		["lens_diagnostics mode=full row", "LENS_FULL_LOG"],
		["Format layer", "FORMAT_LAYER_LOG"],
		["Resolution layer", "RESOLUTION_LAYER_LOG"],
	])("%s's tee target matches env.%s", (stepName, envVar) => {
		const step = findStep(workflow, stepName);
		const fromTee = teeLogFilename(step.run as string);
		const fromEnv = envLogFilename((notifyStep.env ?? {})[envVar]);
		expect(fromEnv).toBe(fromTee);
	});

	// Mutation-proof: before this test existed, renaming either side alone
	// (a tee target OR the corresponding env value) left every other test
	// in the repo green.
	it("mutation-proof: renaming the Tool layer's tee target alone reds this file's own comparison", () => {
		const step = findStep(workflow, "Tool layer");
		const original = teeLogFilename(step.run as string);
		const mutatedRun = (step.run as string).replace(original, "renamed.log");
		expect(mutatedRun).not.toBe(step.run);
		const mutatedFilename = teeLogFilename(mutatedRun);
		const envFilename = envLogFilename((notifyStep.env ?? {}).TOOL_LAYER_LOG);
		expect(mutatedFilename).not.toBe(envFilename);
	});
});
