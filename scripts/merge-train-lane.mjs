#!/usr/bin/env node
// CI entry point for the label-gated merge lane (#2185). See
// scripts/lib/merge-train-lane.mjs for the gate and
// .github/workflows/merge-train-lane.yml for the triggers and permissions.

import { appendFileSync } from "node:fs";
import {
	reconcilePostMergeValidations,
	runMergeLane,
} from "./lib/merge-train-lane.mjs";

async function main() {
	const repository = process.env.GITHUB_REPOSITORY;
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (!repository || !token)
		throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN/GH_TOKEN are required");
	const [owner, repo] = repository.split("/");

	const fetcher = (url, init) =>
		fetch(url, {
			...init,
			headers: { ...init?.headers, authorization: `Bearer ${token}` },
		});

	// Who may apply train:approved (review round 1, F5). Defaults to the
	// repository owner, which is the only collaborator on this repo today;
	// TRAIN_APPROVERS widens it without a code change when that stops being
	// true. Derived, never a second hand-maintained list.
	// An UNSET repository variable arrives as an empty string, not undefined,
	// so `?? owner` alone would yield an empty approver list and silently
	// freeze the whole lane. Fall back on emptiness, not on nullishness.
	const configuredApprovers = (process.env.TRAIN_APPROVERS ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	const approvers =
		configuredApprovers.length > 0 ? configuredApprovers : [owner];

	const reconciliations = await reconcilePostMergeValidations({
		fetcher,
		owner,
		repo,
	});
	const results = await runMergeLane({ fetcher, owner, repo, approvers });

	const lines = [
		`Merge train: reconciled ${reconciliations.length} merged PR record(s); evaluated ${results.length} approved PR record(s).`,
	];
	for (const reconciliation of reconciliations) {
		if (!reconciliation.sha && reconciliation.number === null) {
			lines.push(
				`- post-merge reconciliation: ERROR: ${reconciliation.errors.join("; ")}`,
			);
			continue;
		}
		if (!reconciliation.dispatched && reconciliation.errors.length === 0)
			continue;
		lines.push(
			`- post-merge #${reconciliation.number} ${reconciliation.sha ?? "unknown SHA"}: ${reconciliation.dispatched ? "DISPATCHED" : "ERROR"}${reconciliation.errors.length > 0 ? `: ${reconciliation.errors.join("; ")}` : ""}`,
		);
	}
	for (const r of results) {
		let verdict = `holding — ${r.reason}`;
		if (r.merged) verdict = `MERGED (${r.method})`;
		else if (r.updated)
			verdict = "UPDATED BRANCH (behind base, re-gates next cycle)";
		lines.push(
			`- ${r.number === null ? "(list fetch)" : `#${r.number} ${r.url}`}: ${verdict}`,
		);
		if (r.approvedBy) lines.push(`  approved by: ${r.approvedBy}`);
		if (r.detail) lines.push(`  ${r.detail}`);
		if (r.runHealth) lines.push(`  runs: ${r.runHealth}`);
		if (r.errors.length > 0)
			lines.push(
				`  ${r.errors.map((e) => `${e.benign ? "note" : "ERROR"}: ${e.message}`).join("; ")}`,
			);
	}
	if (lines.length === 1)
		lines.push("No PR carries the train:approved label this run.");
	const summary = lines.join("\n");
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

	// Same benign/fatal split as the warden: a 409 from a head that moved
	// mid-cycle is the guard working, not a lane failure.
	if (
		reconciliations.some((r) => r.errors.length > 0) ||
		results.some((r) => r.errors.some((e) => !e.benign))
	)
		process.exitCode = 1;
}

main().catch((error) => {
	console.error(
		`Merge train failed to run: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
});
