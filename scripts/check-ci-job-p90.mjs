#!/usr/bin/env node
/**
 * scripts/check-ci-job-p90.mjs (#4691, item 3 of #3920): the nightly warning
 * that a required CI job's p90 runtime over recent master runs nears its
 * `timeout-minutes` cap. Wired as a step in .github/workflows/untriaged-issues.yml.
 *
 * A thin caller. The rule (ratio, job-name matcher, cap entries, the p90 mode)
 * is scripts/lib/ci-runtime-cap.mjs, shared with ci-verdict's per-head
 * "Runtime vs cap" report. The required set is branch protection, read through
 * ci-verdict's `resolveRequiredCheckNames`; the caps are `readJobTimeCaps`.
 * This file only does the host reads: the last N completed master push runs of
 * each workflow that holds a required job, and each run's job rows.
 *
 * It warns and never gates: exit 0 whenever the data was read, one `::warning`
 * annotation per job over the ratio, and one per required context it could not
 * measure (never silent). Exit 1 only when the data could not be read, so a
 * broken nightly is visible.
 *
 * Usage: node scripts/check-ci-job-p90.mjs [--runs N]
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	extractRequiredCheckNames,
	readJobTimeCaps,
	resolveRepository,
	resolveRequiredCheckNames,
} from "./ci-verdict.mjs";
import { REQUIRED_CHECKS } from "./lib/ci-checks.mjs";
import {
	formatP90Warning,
	p90CapReport,
	RUNTIME_CAP_WARN_RATIO,
} from "./lib/ci-runtime-cap.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";

const DEFAULT_RUNS = 20;
const MAX_RUNS = 100;
/** The workflows that hold a required job and run on a push to master. */
const WORKFLOWS = ["ci.yml", "lint.yml"];
const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

function gh(args) {
	const result = spawnSync("gh", args, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			`gh ${args.join(" ")} failed (exit ${result.status}): ${result.stderr?.trim()}`,
		);
	}
	return result.stdout;
}

/** A workflow `::warning` command; %, CR and LF are escaped in its body. */
function annotation(title, text) {
	const data = text
		.replace(/%/g, "%25")
		.replace(/\r/g, "%0D")
		.replace(/\n/g, "%0A");
	return `::warning title=${title}::${data}`;
}

function parseArgs(argv) {
	let runs = DEFAULT_RUNS;
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--runs") runs = Number(argv[(i += 1)]);
		else throw new Error(`unknown argument: ${argv[i]}`);
	}
	if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
		throw new Error(`--runs must be an integer 1..${MAX_RUNS}`);
	}
	return { runs };
}

function jobRowsOf(runId) {
	const lines = gh([
		"api",
		"--paginate",
		`repos/{owner}/{repo}/actions/runs/${runId}/jobs?per_page=100`,
		"--jq",
		".jobs[]",
	]);
	return lines
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

function listMasterRuns(workflow, count) {
	const body = JSON.parse(
		gh([
			"api",
			`repos/{owner}/{repo}/actions/workflows/${workflow}/runs?branch=master&event=push&status=completed&per_page=${count}`,
		]),
	);
	return (body.workflow_runs ?? []).map((run) => ({
		id: run.id,
		created_at: run.created_at,
		jobs: jobRowsOf(run.id),
	}));
}

/**
 * The branch-protection required contexts: ci-verdict's `resolveRequiredCheckNames`
 * (the /protection endpoint), else the branch object's `protection` block. The
 * first needs administration, which the Actions token lacks (dispatch run
 * 40136156459: HTTP 403); the second lists the same contexts to any reader.
 * Null when neither answers.
 */
function readRequiredChecks(repository) {
	const viaProtection = resolveRequiredCheckNames(repository, gh);
	if (viaProtection) return viaProtection;
	try {
		const branch = JSON.parse(
			gh(["api", `repos/${repository}/branches/master`]),
		);
		return extractRequiredCheckNames(
			branch?.protection?.required_status_checks,
		);
	} catch {
		return null;
	}
}

async function main() {
	const { runs: runCount } = parseArgs(process.argv.slice(2));
	const repository = process.env.GH_REPO || resolveRepository(gh);
	const live = readRequiredChecks(repository);
	const requiredChecks = live ?? REQUIRED_CHECKS;
	if (live === null) {
		console.log(
			annotation(
				"CI job p90 population",
				`ci-job-p90: branch protection unreadable; measuring the fallback required list (${REQUIRED_CHECKS.join(", ")})`,
			),
		);
	}
	const caps = await readJobTimeCaps(ROOT);
	const measured = new Set();
	let warningCount = 0;
	for (const workflow of WORKFLOWS) {
		const report = p90CapReport({
			caps: caps.filter(
				(entry) => entry.file === `.github/workflows/${workflow}`,
			),
			runs: listMasterRuns(workflow, runCount),
			requiredChecks,
		});
		for (const context of report.measuredContexts) measured.add(context);
		for (const w of report.warnings) {
			warningCount += 1;
			console.log(annotation("CI job p90 near timeout", formatP90Warning(w)));
		}
	}
	for (const name of requiredChecks.filter((n) => !measured.has(n))) {
		console.log(
			annotation(
				"CI job p90 unmeasured",
				`ci-job-p90: unmeasured required context "${name}": no job of ${WORKFLOWS.join(" or ")} with a timeout-minutes cap had a completed run in the last ${runCount} master runs`,
			),
		);
	}
	console.log(
		`ci-job-p90: ${measured.size} of ${requiredChecks.length} required contexts measured over the last ${runCount} master runs of ${WORKFLOWS.join(", ")} ` +
			`at ratio ${RUNTIME_CAP_WARN_RATIO}; ${warningCount} warning(s)`,
	);
}

if (isMainModule(import.meta.url)) {
	main().catch((error) => {
		console.error(
			`check-ci-job-p90: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	});
}
