// #2723: `Tool smoke (nightly)`'s only tracking-issue writer
// (`Notify on silentOnClean drift`, #529/#594) sat behind the LSP handshake
// layer step with `continue-on-error: true` but no `if: always()`, so
// GitHub SKIPPED it -- and everything after it -- exactly when an earlier
// step failed, i.e. exactly when a human most needed to hear about it (13
// consecutive red nights with no automated notice). This file pins the
// FIX's own shape so the same defect can't recur silently on the new step:
// the new notify step must carry `if: always()` and must actually read all
// three gating layers' `outcome`s (not just exist with the right `if:`).
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
const NOTIFY_STEP_NAME = "Notify on tool-smoke red";

type Step = {
	name?: unknown;
	id?: unknown;
	if?: unknown;
	run?: unknown;
	env?: Record<string, unknown>;
};
type Job = { steps?: unknown; permissions?: Record<string, unknown> };
type Workflow = { jobs?: Record<string, Job> };

function loadWorkflow(source?: string): Workflow {
	const text =
		source ?? readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
	return yaml.load(text) as Workflow;
}

function findStep(workflow: Workflow, nameSubstring: string): Step {
	const steps = workflow.jobs?.[JOB_NAME]?.steps;
	const step = Array.isArray(steps)
		? (steps as Step[]).find(
				(s) => typeof s.name === "string" && s.name.includes(nameSubstring),
			)
		: undefined;
	if (!step) {
		throw new Error(
			`${WORKFLOW_PATH}: jobs.${JOB_NAME} has no step named like "${nameSubstring}"`,
		);
	}
	return step;
}

describe("tool-smoke.yml's red-notify step runs on failure too (#2723)", () => {
	const workflow = loadWorkflow();
	const notifyStep = findStep(workflow, NOTIFY_STEP_NAME);

	it("carries if: always() -- the exact gate #2723's bug lacked", () => {
		expect(notifyStep.if).toBe("always()");
	});

	it("is the LAST step in the job (must observe every gating layer, including Format layer)", () => {
		const steps = workflow.jobs?.[JOB_NAME]?.steps as Step[];
		expect(steps[steps.length - 1].name).toContain(NOTIFY_STEP_NAME);
	});

	it("carries continue-on-error: true (a notifier failure must never redden the nightly)", () => {
		const step = notifyStep as Step & { "continue-on-error"?: unknown };
		expect(step["continue-on-error"]).toBe(true);
	});

	it("reads all three gating layers' step outcomes via env, by expression (not hardcoded literals)", () => {
		const env = notifyStep.env ?? {};
		expect(env.TOOL_LAYER_OUTCOME).toBe("${{ steps.tool_layer.outcome }}");
		expect(env.LSP_HANDSHAKE_OUTCOME).toBe(
			"${{ steps.lsp_handshake.outcome }}",
		);
		expect(env.FORMAT_LAYER_OUTCOME).toBe("${{ steps.format_layer.outcome }}");
	});

	it("each referenced layer step actually declares the id the notify step reads", () => {
		expect(findStep(workflow, "Tool layer").id).toBe("tool_layer");
		expect(findStep(workflow, "LSP handshake layer").id).toBe("lsp_handshake");
		expect(findStep(workflow, "Format layer").id).toBe("format_layer");
	});

	// #2723 review F3: disambiguates "the job failed before the three
	// tracked layers even started" from a genuine cancellation -- both
	// leave all three layers "skipped", which decideAction alone cannot
	// tell apart (see scripts/lib/tool-smoke-drift.mjs's decideToolSmokeAction).
	it("reads GitHub's job.status context so the notifier can tell a genuine failure outside the tracked layers from a cancellation", () => {
		const env = notifyStep.env ?? {};
		expect(env.JOB_STATUS).toBe("${{ job.status }}");
	});

	it("invokes the notifier script", () => {
		expect(notifyStep.run).toContain("scripts/notify-tool-smoke-red.mjs");
	});

	it("issues: write is already granted at job level (#529/#594) -- confirms, does not require re-adding", () => {
		const permissions = workflow.jobs?.[JOB_NAME]?.permissions;
		expect(permissions?.issues).toBe("write");
	});

	// Mutation-proof: this is #2723's ACTUAL bug, reproduced against the fix.
	// Before this file existed, deleting `if: always()` from a notify step
	// left every other test in the repo green -- no test evaluated this
	// workflow's `if:` strings at all.
	it("mutation-proof: deleting if: always() from the notify step reds this file's own gate assertion", () => {
		const source = readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
		const lines = source.split("\n");
		const stepNameIdx = lines.findIndex((l) => l.includes(NOTIFY_STEP_NAME));
		expect(stepNameIdx).toBeGreaterThanOrEqual(0);
		const ifLineIdx = lines.findIndex(
			(l, i) => i > stepNameIdx && /^\s*if:\s*always\(\)\s*$/.test(l),
		);
		expect(ifLineIdx).toBeGreaterThanOrEqual(0);

		const mutatedLines = [...lines];
		mutatedLines.splice(ifLineIdx, 1);
		const mutatedSource = mutatedLines.join("\n");
		expect(mutatedSource).not.toBe(source);

		const mutatedWorkflow = loadWorkflow(mutatedSource);
		const mutatedStep = findStep(mutatedWorkflow, NOTIFY_STEP_NAME);
		// With the gate gone, the step has no `if:` at all -- this is the
		// exact regression: GitHub then skips the step whenever an earlier
		// step in the job fails, reproducing #2723 on the new step.
		expect(mutatedStep.if).toBeUndefined();
	});

	// Mutation-proof, the OTHER direction (AGENTS.md "mutate both ways"):
	// swapping `always()` for `success()` (GitHub's own implicit default when
	// no `if:` is given -- functionally identical to #2723's actual bug)
	// must fail this file's own gate assertion just as surely as deleting
	// the line outright. Proves the test discriminates "always()"
	// specifically, not merely "some if: line is present after this step".
	it("mutation-proof (other direction): swapping always() for success() reds this file's own gate assertion", () => {
		const source = readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
		const lines = source.split("\n");
		const stepNameIdx = lines.findIndex((l) => l.includes(NOTIFY_STEP_NAME));
		expect(stepNameIdx).toBeGreaterThanOrEqual(0);
		// The actual YAML `if:` key line for this step (not the comment text
		// above it, which also contains the literal string "if: always()").
		const ifLineIdx = lines.findIndex(
			(l, i) => i > stepNameIdx && /^\s*if:\s*always\(\)\s*$/.test(l),
		);
		expect(ifLineIdx).toBeGreaterThanOrEqual(0);
		const mutatedLines = [...lines];
		mutatedLines[ifLineIdx] = mutatedLines[ifLineIdx].replace(
			"always()",
			"success()",
		);
		const mutatedSource = mutatedLines.join("\n");
		expect(mutatedSource).not.toBe(source);
		const mutatedWorkflow = loadWorkflow(mutatedSource);
		const mutatedStep = findStep(mutatedWorkflow, NOTIFY_STEP_NAME);
		expect(mutatedStep.if).not.toBe("always()");
	});
});

// #2723 review F4: `set -o pipefail` is LOAD-BEARING on each of the three
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
		"Format layer",
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
	const notifyStep = findStep(workflow, NOTIFY_STEP_NAME);

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
		["Format layer", "FORMAT_LAYER_LOG"],
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
