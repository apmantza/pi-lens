#!/usr/bin/env node
/**
 * #2613 (review S2/T3): makes a genuine install-smoke `host-latest-smoke`
 * nightly failure ACTIONABLE, and closes the tracker once it resolves — the
 * acceptance criterion this PR's first round missed ("closed when green
 * again"). File-or-update a SINGLE persistent tracking issue on failure,
 * found by exact title match (scripts/lib/drift-issue.mjs's
 * `findDriftTrackingIssue`, generalized in this PR to take an explicit
 * title so this is its SECOND consumer, not a third hand-rolled gh-issue-
 * upsert copy — install-smoke.yml previously embedded this logic a third
 * time directly in workflow YAML bash).
 *
 * Reads the run's step outcomes from env (set by the workflow step that
 * invokes this script) rather than argv, so the workflow's own `steps.*.outcome`
 * expressions are the single source of truth for what happened — this
 * script never re-derives success/failure itself.
 *
 * F1 (round 2 review): a real GitHub Actions step outcome is one of FOUR
 * values (success/failure/cancelled/skipped), not two. This script takes
 * FOUR actions depending on which of those the run's steps produced —
 * see scripts/lib/install-smoke-drift.mjs's module doc and
 * isValidReport/hasDrift/isCleanRun for the exact conditions:
 *   - some step "failure"                -> file or refresh the tracker
 *   - EVERY step "success"               -> close an existing tracker
 *   - a mix with no failure, not all success (cancelled/skipped in the mix,
 *     e.g. concurrency's cancel-in-progress interrupting a nightly run)
 *                                         -> NO action (logged, not an error)
 *   - any step outcome missing/not one of the four real values (a wiring
 *     bug: an env var the workflow step forgot to set)
 *                                         -> NO action, but a WARNING (this
 *                                            is a defect in the CALLER, not
 *                                            a normal run state)
 *
 * Required env (each: success | failure | cancelled | skipped, except
 * RESOLVED_VERSION):
 *   RESOLVED_VERSION           the @latest version this run installed
 *   RESOLVE_OUTCOME            resolving that version itself (a registry
 *                              failure here leaves every step below
 *                              "skipped", never "failure" -- this one must
 *                              be in the table or a total resolve failure
 *                              reads as a clean run)
 *   INSTALL_CI_OUTCOME
 *   INSTALL_DEPS_OUTCOME
 *   GRAMMARS_OUTCOME
 *   BUILD_DIST_OUTCOME
 *   PACK_OUTCOME
 *   INSTALL_TARBALL_OUTCOME
 *   SELFTEST_OUTCOME
 * Optional: GITHUB_TOKEN (gh auth), GITHUB_SERVER_URL/GITHUB_REPOSITORY/
 *   GITHUB_RUN_ID (workflow-run link in the issue body).
 *
 *   node scripts/notify-install-smoke-drift.mjs                    # real gh calls
 *   node scripts/notify-install-smoke-drift.mjs --dry-run          # compute + print the plan, no gh calls
 *
 * Never lets an internal error escape as a nonzero exit — this step's own
 * `continue-on-error`/advisory framing means filing/closing an issue is a
 * side effect, not a build gate, mirroring notify-clean-signal-drift.mjs
 * (whose own close condition is a computed finding COUNT, not this file's
 * step-outcome shape — it does not share this defect).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { upsertTrackingIssue } from "./lib/drift-issue.mjs";
import {
	buildInstallSmokeDriftBody,
	buildInstallSmokeDriftComment,
	decideAction,
	INSTALL_SMOKE_DRIFT_TITLE,
} from "./lib/install-smoke-drift.mjs";

const STEP_NAMES = /** @type {const} */ ([
	["RESOLVE_OUTCOME", "resolve @latest"],
	["INSTALL_CI_OUTCOME", "install deps (ci)"],
	["INSTALL_DEPS_OUTCOME", "pin devDependency (no-save)"],
	["GRAMMARS_OUTCOME", "download grammars"],
	["BUILD_DIST_OUTCOME", "build:dist"],
	["PACK_OUTCOME", "npm pack"],
	["INSTALL_TARBALL_OUTCOME", "install tarball"],
	["SELFTEST_OUTCOME", "install-selftest"],
]);

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");

function gh(args) {
	return execFileSync("gh", args, { encoding: "utf8" });
}

/**
 * Reads each step's RAW env value with no fallback/guess (#2613 F1): an env
 * var the workflow step forgot to wire up must read as "not a real outcome"
 * (isValidReport catches it), never silently become "skipped" — that
 * guess is exactly what let a wiring bug masquerade as an ordinary run.
 */
function readReport(env) {
	const version = env.RESOLVED_VERSION || "unknown";
	const steps = STEP_NAMES.map(([envVar, name]) => ({
		name,
		outcome: env[envVar] ?? "",
	}));
	return { version, steps };
}

function workflowRunUrl(env) {
	const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
	if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
	return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

function main(env) {
	const report = readReport(env);
	const action = decideAction(report);

	if (action === "unknown") {
		const msg =
			`[notify-install-smoke-drift] one or more step outcomes are missing or not a real ` +
			`GitHub Actions outcome (success/failure/cancelled/skipped) — this is a wiring bug, ` +
			`not a normal run state; taking NO action. Steps: ${JSON.stringify(report.steps)}`;
		console.error(dryRun ? msg : `::warning::${msg}`);
		return;
	}

	if (dryRun) {
		const body = buildInstallSmokeDriftBody(report, {
			runUrl: workflowRunUrl(env),
		});
		console.log(
			`[notify-install-smoke-drift] DRY RUN — action=${action}. Plan body:\n`,
		);
		console.log(body);
		return;
	}

	if (action === "no-action") {
		console.log(
			"[notify-install-smoke-drift] run was cancelled/skipped (no failure, not fully clean) — taking no action.",
		);
		return;
	}

	if (action === "file-or-refresh") {
		const body = buildInstallSmokeDriftBody(report, {
			runUrl: workflowRunUrl(env),
		});
		const dir = fs.mkdtempSync(
			`${process.env.TMPDIR ?? "/tmp"}/pilens-install-drift-`,
		);
		const bodyFile = `${dir}/body.md`;
		fs.writeFileSync(bodyFile, body);
		try {
			const result = upsertTrackingIssue({
				title: INSTALL_SMOKE_DRIFT_TITLE,
				label: "area:installer,area:tests",
				body,
				bodyFile,
				comment: buildInstallSmokeDriftComment(report),
				gh,
			});
			const issue = result.issueNumber ? ` #${result.issueNumber}` : "";
			const message =
				result.action === "created"
					? "filed a new tracking issue"
					: `updated tracking issue${issue}`;
			console.log(`[notify-install-smoke-drift] ${message}.`);
		} catch (e) {
			console.error(
				`[notify-install-smoke-drift] gh issue create/edit failed: ${e?.message ?? e}`,
			);
		}
		return;
	}

	// action === "close-if-open"
	try {
		const result = upsertTrackingIssue({
			title: INSTALL_SMOKE_DRIFT_TITLE,
			label: "area:installer,area:tests",
			clean: true,
			closeWhenClean: true,
			closeComment: `Nightly install-smoke ran \`@latest\` (${report.version}) cleanly — self-resolved, closing (#2613).`,
			gh,
		});
		if (result.action === "closed") {
			console.log(
				`[notify-install-smoke-drift] closed tracking issue #${result.issueNumber} (drift resolved).`,
			);
		} else {
			console.log(
				"[notify-install-smoke-drift] no drift, no open tracking issue — nothing to do.",
			);
		}
	} catch (e) {
		console.error(
			`[notify-install-smoke-drift] gh issue close failed: ${e?.message ?? e}`,
		);
	}
}

try {
	main(process.env);
} catch (e) {
	console.error(
		`[notify-install-smoke-drift] unexpected error (never fails the job): ${e?.message ?? e}`,
	);
}
process.exit(0);
