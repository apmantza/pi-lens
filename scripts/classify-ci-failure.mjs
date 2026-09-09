#!/usr/bin/env node
// CI failure classifier CLI (#2103). Reads one failed workflow run's Unit
// tests job log, decides infra-kill / infra-net / real, posts (or updates) one
// sticky PR comment, and reruns the failed jobs ONCE per head SHA when the
// classification is infra. See scripts/lib/ci-failure-classifier.mjs for the
// decision logic.
//
// A human can run this on a known red run id:
//
//   GITHUB_TOKEN=... node scripts/classify-ci-failure.mjs --run 32908647308
//
// `.github/workflows/ci-infra-kill-rerun.yml` also invokes this CLI after a
// completed first-attempt CI failure. That path limits eligibility to
// infra-kill and skips runs whose Unit-tests job did not fail.

import { runClassifier } from "./lib/ci-failure-classifier.mjs";

// #2668 review F2: an unrecognized flag (a typo, or a workflow/CLI rename
// drifting out of sync -- exactly what happened when this file's own flag
// was almost shipped as `--allow-missing-prs`) must not be silently
// swallowed. Before this table existed, an unknown token was simply never
// matched by the if/else chain below and args kept its default, so the
// workflow's real argv failing to parse looked identical to a legitimate
// run with that option unset. `UnknownArgError` lets main() tell "bad argv"
// (exit 4) apart from every other failure mode.
export class UnknownArgError extends Error {
	constructor(arg) {
		super(`unknown argument: ${arg}`);
		this.name = "UnknownArgError";
	}
}

export function parseArgs(argv) {
	const args = {
		runId: null,
		jobName: "Unit tests",
		prNumber: null,
		sha: null,
		infraKillOnly: false,
		skipMissingJob: false,
		allowMissingPr: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--run") args.runId = argv[++i];
		else if (arg === "--job-name") args.jobName = argv[++i];
		else if (arg === "--pr") args.prNumber = Number(argv[++i]);
		else if (arg === "--sha") args.sha = argv[++i];
		else if (arg === "--infra-kill-only") args.infraKillOnly = true;
		else if (arg === "--skip-missing-job") args.skipMissingJob = true;
		else if (arg === "--allow-missing-pr") args.allowMissingPr = true;
		else throw new UnknownArgError(arg);
	}
	return args;
}

async function main() {
	let parsed;
	try {
		parsed = parseArgs(process.argv.slice(2));
	} catch (error) {
		if (error instanceof UnknownArgError) {
			console.error(error.message);
			process.exitCode = 4;
			return;
		}
		throw error;
	}
	const {
		runId,
		jobName,
		prNumber,
		sha,
		infraKillOnly,
		skipMissingJob,
		allowMissingPr,
	} = parsed;
	if (!runId) {
		console.error(
			"usage: node scripts/classify-ci-failure.mjs --run <runId> [--job-name <name>] [--pr <number>] [--sha <headSha>] [--infra-kill-only] [--skip-missing-job] [--allow-missing-pr]",
		);
		process.exitCode = 2;
		return;
	}

	const repository = process.env.GITHUB_REPOSITORY;
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (!repository || !token) {
		throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN/GH_TOKEN are required");
	}
	const [owner, repo] = repository.split("/");

	const fetcher = (url, init) =>
		fetch(url, {
			...init,
			headers: { ...init?.headers, authorization: `Bearer ${token}` },
		});

	const result = await runClassifier({
		fetcher,
		owner,
		repo,
		runId,
		jobName,
		prNumber: prNumber || undefined,
		sha: sha || undefined,
		rerunKinds: infraKillOnly ? ["infra-kill"] : undefined,
		skipMissingJob,
		allowMissingPr,
	});
	if ("skipped" in result) {
		console.log(`CI failure classifier skipped: ${result.reason}`);
		return;
	}

	const prLabel = result.prNumber
		? `PR #${result.prNumber}`
		: "no PR (push/dispatch)";
	console.log(
		`${prLabel} sha=${result.sha} job=${result.jobName} -> ` +
			`${result.classification.kind}${result.rerunTriggeredThisPass ? " (rerun triggered)" : ""}`,
	);
	console.log(result.commentBody);
}

main().catch((error) => {
	console.error(
		`ci failure classifier failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
});
