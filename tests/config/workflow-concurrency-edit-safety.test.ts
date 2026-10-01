import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import {
	evaluateCancelInProgress,
	evaluateGroup,
} from "../support/workflow-expression.js";
import { minimatch } from "minimatch";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = resolve(ROOT, ".github/workflows");

type PullRequestTrigger = { types?: string[] };
type PushTrigger = { branches?: string[]; paths?: string[] } | null;
type Workflow = {
	on?:
		| string
		| string[]
		| null
		| { pull_request?: PullRequestTrigger; push?: PushTrigger };
	concurrency?: { group?: unknown; "cancel-in-progress"?: unknown };
	jobs?: Record<string, { concurrency?: Workflow["concurrency"] }>;
};

function loadWorkflow(file: string): Workflow {
	return yaml.load(readFileSync(resolve(WORKFLOWS, file), "utf8")) as Workflow;
}

function pushTrigger(on: Workflow["on"]): PushTrigger | undefined {
	if (on === "push") return null;
	if (Array.isArray(on)) return on.includes("push") ? null : undefined;
	if (on && typeof on === "object") return on.push;
	return undefined;
}

function cancelInProgressOn(eventName: string, value: unknown): boolean {
	return evaluateCancelInProgress(value, eventName);
}

function pushRunsOnMaster(push: PushTrigger | undefined): boolean {
	if (push === undefined) return false;
	if (push === null || push.branches === undefined) return true;
	return push.branches.some((pattern) => minimatch("master", pattern));
}

function cancelsMasterPush(workflow: Workflow): boolean {
	if (!pushRunsOnMaster(pushTrigger(workflow.on))) return false;
	if (cancelInProgressOn("push", workflow.concurrency?.["cancel-in-progress"]))
		return true;
	return Object.values(workflow.jobs ?? {}).some((job) =>
		cancelInProgressOn("push", job.concurrency?.["cancel-in-progress"]),
	);
}

describe("workflow concurrency edit safety", () => {
	it("never cancels a push to master", () => {
		// Recurrence #3798: every merge cancelled the master CI run before it
		// could finish, hiding the post-merge result behind the next merge.
		const findings: string[] = [];
		let scanned = 0;
		for (const file of readdirSync(WORKFLOWS)) {
			if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
			const workflow = loadWorkflow(file);
			if (!pushRunsOnMaster(pushTrigger(workflow.on))) continue;
			scanned++;
			if (cancelsMasterPush(workflow)) {
				findings.push(file);
			}
		}
		assertNonEmptyScan("master-push concurrency workflows", scanned, 4);
		expect(
			findings,
			"master-push workflows must let their runs finish",
		).toEqual([]);
	});

	it("keeps edited PR groups distinct without splitting pushed groups", () => {
		// Recurrence #3716: an edit must not cancel the pushed head, while
		// opened, synchronize, and reopened must retain their existing latch.
		const eligible: Array<{ file: string; group: string }> = [];
		for (const file of readdirSync(WORKFLOWS)) {
			if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
			const workflow = loadWorkflow(file);
			const trigger =
				workflow.on &&
				typeof workflow.on === "object" &&
				!Array.isArray(workflow.on)
					? workflow.on.pull_request
					: undefined;
			if (
				!trigger?.types?.includes("edited") ||
				!cancelInProgressOn(
					"pull_request",
					workflow.concurrency?.["cancel-in-progress"],
				)
			) {
				continue;
			}
			const group = workflow.concurrency?.group;
			if (typeof group === "string") eligible.push({ file, group });
		}

		// Floor 1, was 2: #3838 moved the only other `edited` workflow
		// (close-keywords.yml) into pr-metadata.yml and dropped `edited` from
		// lint.yml, so pr-metadata.yml is the one workflow this sweep reads.
		assertNonEmptyScan(
			"edited pull-request concurrency workflows",
			eligible.length,
			1,
		);
		const findings = eligible.flatMap(({ file, group }) => {
			const opened = evaluateGroup(group, "opened", "run-opened");
			const synchronize = evaluateGroup(group, "synchronize", "run-sync-a");
			const edited = evaluateGroup(group, "edited", "run-edited");
			return [
				...(synchronize !== evaluateGroup(group, "synchronize", "run-sync-b")
					? [`${file}: synchronize vs synchronize differs`]
					: []),
				...(synchronize === edited
					? [`${file}: synchronize and edited share ${synchronize}`]
					: []),
				...(opened !== synchronize
					? [`${file}: opened and synchronize differ`]
					: []),
			];
		});
		expect(findings, "edited groups must preserve push cancellation").toEqual(
			[],
		);
	});

	it("keeps PR cancellation for every master-push workflow", () => {
		for (const file of [
			"ci.yml",
			"lint.yml",
			"install-smoke.yml",
			"labels.yml",
		]) {
			const value = loadWorkflow(file).concurrency?.["cancel-in-progress"];
			expect(cancelInProgressOn("pull_request", value)).toBe(true);
		}
	});

	it("fails closed on unsupported cancellation expression terms", () => {
		expect(
			cancelInProgressOn("push", "${{ github.event_name != 'pull_request' }}"),
		).toBe(true);
		expect(() =>
			cancelInProgressOn("push", "${{ github.ref == 'refs/heads/master' }}"),
		).toThrow(/unsupported workflow expression term/);
		expect(() =>
			cancelInProgressOn("push", "${{ startsWith(github.ref, 'refs/heads') }}"),
		).toThrow(/unsupported workflow expression term/);
		expect(pushTrigger("push")).toBeNull();
		expect(pushTrigger(["push", "pull_request"])).toBeNull();
		expect(pushTrigger({ push: null })).toBeNull();
	});

	it("treats absent concurrency controls as GitHub's non-cancelling default", () => {
		// Probe A/A2: adding a master-push workflow without a concurrency block or
		// cancel-in-progress key must not create a false review finding.
		expect(cancelsMasterPush({ on: "push" })).toBe(false);
		expect(cancelsMasterPush({ on: "push", concurrency: {} })).toBe(false);
	});

	it("checks path-only and globbed master push triggers", () => {
		// Probe B/B2: a paths-only push and a glob matching master both run there.
		expect(
			cancelsMasterPush({
				on: { push: { paths: ["src/**"] } },
				concurrency: { "cancel-in-progress": true },
			}),
		).toBe(true);
		expect(
			cancelsMasterPush({
				on: { push: { branches: ["**"] } },
				concurrency: { "cancel-in-progress": true },
			}),
		).toBe(true);
	});

	it("checks job-level concurrency for master push workflows", () => {
		expect(
			cancelsMasterPush({
				on: "push",
				jobs: { build: { concurrency: { "cancel-in-progress": true } } },
			}),
		).toBe(true);
	});
});
