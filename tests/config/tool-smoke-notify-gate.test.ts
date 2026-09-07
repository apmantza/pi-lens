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
