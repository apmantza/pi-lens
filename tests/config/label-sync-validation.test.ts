import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

/**
 * `.github/workflows/labels.yml` runs `micnncim/action-label-syncer` with
 * `prune: true`, which DELETES any live label absent from the manifest
 * (#2553). The deletion is otherwise silent: run 34042925533 logged
 * "label: priority:p3 deleted from: apmantza/pi-lens" (then p1, p2) while
 * the post-merge validation recorded success — twice for the priority
 * labels (#2614).
 *
 * This pin holds the post-merge validation in place. Three shapes would
 * silently re-open the recurrence:
 *
 * - A missing validation step: the syncer's deletions go unexamined again.
 * - A validation step that never runs (a later `continue-on-error`): the
 *   failure is recorded but the job still reports green, and the merge
 *   train's post-merge validation records "succeeded" over a deletion.
 * - The pre-sync snapshot step missing or demoted: deletion is only
 *   observable as before-vs-after drift, because the deleted labels are
 *   absent from the manifest by definition (#2553's priority labels were
 *   not in the manifest), so a manifest-only diff cannot see them.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = ".github/workflows/labels.yml";

const SYNCER_USES = "action-label-syncer";
/** The validation step's one failure needle; the sync job must exit non-zero through it. */
const FAILURE_NEEDLE = "::error::label sync deleted or missing labels:";
const SNAPSHOT_NEEDLE = "labels-before.txt";

type WorkflowStep = {
	name?: string;
	uses?: string;
	run?: string;
	"continue-on-error"?: boolean;
};

type Workflow = {
	jobs?: Record<string, { steps?: WorkflowStep[] }>;
};

describe("label sync post-merge validation (#2614)", () => {
	it("fails the sync job when the syncer deletes or loses any label", () => {
		const workflow = yaml.load(
			readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8"),
		) as Workflow;
		const steps = workflow.jobs?.sync?.steps ?? [];

		const syncerIndex = steps.findIndex((step) =>
			(step.uses ?? "").includes(SYNCER_USES),
		);
		const snapshotIndex = steps.findIndex((step) =>
			(step.run ?? "").includes(SNAPSHOT_NEEDLE),
		);
		const validationIndex = steps.findIndex((step) =>
			(step.run ?? "").includes(FAILURE_NEEDLE),
		);

		expect(syncerIndex).toBeGreaterThan(-1);
		expect(snapshotIndex).toBeGreaterThan(-1);
		// Deletion is only visible as before-vs-after drift, so the snapshot
		// must be taken before the syncer runs.
		expect(snapshotIndex).toBeLessThan(syncerIndex);
		expect(validationIndex).toBeGreaterThan(syncerIndex);

		// A `continue-on-error` step records its failure without failing the
		// job — the exact "silent deletion recorded as success" defect.
		expect(steps[snapshotIndex]?.["continue-on-error"]).toBeUndefined();
		expect(steps[validationIndex]?.["continue-on-error"]).toBeUndefined();

		// Two one-token neuterings survive the pins above (review r1 on
		// #2788): `exit 1` -> `true` defangs the step's only failure path —
		// the #2553 silent shape again — and comparing labels-after.txt
		// against itself turns the before-vs-after diff into a decorative
		// no-op. Pin the needles the validation depends on.
		expect(steps[validationIndex]?.run).toContain("labels-before.txt");
		expect(steps[validationIndex]?.run).toContain("exit 1");
		expect(steps[snapshotIndex]?.run).toContain("set -euo pipefail");
		expect(steps[validationIndex]?.run).toContain("set -euo pipefail");
	});
});
