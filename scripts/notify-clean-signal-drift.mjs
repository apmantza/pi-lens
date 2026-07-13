#!/usr/bin/env node
/**
 * #594: makes a genuine #529 silentOnClean drift finding ACTIONABLE. The
 * probe (scripts/probe-clean-signal.mjs) already computes `driftWarnings` and
 * writes a small JSON summary (scripts/lib/clean-signal.mjs's
 * DRIFT_SUMMARY_PATH) — this script is the consumer: file-or-update a SINGLE
 * persistent tracking issue when there's a real finding, and close it once
 * the drift resolves. Never a new issue every night (that would spam) — found
 * by a fixed title among open issues carrying a fixed `nightly-drift` label
 * (scripts/lib/drift-issue.mjs).
 *
 * Telemetry only, same spirit as the probe itself: the nightly workflow
 * (.github/workflows/tool-smoke.yml) wraps this step in
 * `continue-on-error: true`, and this script never lets an internal error
 * escape as a nonzero exit either — filing/updating/closing an issue is a
 * side effect, not a build gate.
 *
 * Auth: reuses the job's existing GITHUB_TOKEN (the same token the
 * "Open/update LSP-docs refresh PR" step already receives via the job-level
 * `env:` block) — the `gh` CLI picks up GITHUB_TOKEN/GH_TOKEN from the
 * environment automatically, so no new auth plumbing is added.
 *
 *   node scripts/notify-clean-signal-drift.mjs                    # real gh calls
 *   node scripts/notify-clean-signal-drift.mjs --dry-run          # compute + print the plan, no gh calls at all
 *   node scripts/notify-clean-signal-drift.mjs --summary <path>   # override the summary file (manual testing)
 *
 * Requires the summary file scripts/probe-clean-signal.mjs writes on its own
 * run (DRIFT_SUMMARY_PATH); if absent (probe didn't run, or errored before
 * writing it), this script quietly no-ops.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DRIFT_SUMMARY_PATH } from "./lib/clean-signal.mjs";
import {
	buildDriftIssueBody,
	DRIFT_ISSUE_LABEL,
	DRIFT_ISSUE_TITLE,
	findDriftTrackingIssue,
} from "./lib/drift-issue.mjs";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const summaryFlagIdx = argv.indexOf("--summary");
const summaryPath = summaryFlagIdx >= 0 ? argv[summaryFlagIdx + 1] : DRIFT_SUMMARY_PATH;

function gh(args) {
	return execFileSync("gh", args, { encoding: "utf8" });
}

function readSummary() {
	if (!fs.existsSync(summaryPath)) {
		console.log(
			`[notify-drift] no summary at ${summaryPath} — the probe step didn't produce one (didn't run, or errored before writing it); nothing to do.`,
		);
		return null;
	}
	try {
		return JSON.parse(fs.readFileSync(summaryPath, "utf8"));
	} catch (e) {
		console.error(`[notify-drift] summary unreadable, skipping: ${e?.message ?? e}`);
		return null;
	}
}

function workflowRunUrl() {
	const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
	if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
	return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

function findTrackingIssue() {
	try {
		const out = gh([
			"issue", "list",
			"--label", DRIFT_ISSUE_LABEL,
			"--state", "open",
			"--json", "number,title",
			"--limit", "20",
		]);
		return findDriftTrackingIssue(JSON.parse(out));
	} catch (e) {
		console.error(`[notify-drift] gh issue list failed, treating as "no existing issue": ${e?.message ?? e}`);
		return null;
	}
}

// Idempotent: --force updates the existing label (color/description) instead
// of erroring if it's already there, so this is safe to run every night.
function ensureLabel() {
	try {
		gh([
			"label", "create", DRIFT_ISSUE_LABEL,
			"--color", "B60205",
			"--description", "Nightly automated silentOnClean drift finding (#529/#594)",
			"--force",
		]);
	} catch (e) {
		console.error(`[notify-drift] label ensure skipped (best-effort): ${e?.message ?? e}`);
	}
}

function writeBodyToTempFile(body) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-drift-issue-"));
	const file = path.join(dir, "body.md");
	fs.writeFileSync(file, body);
	return file;
}

function main() {
	const summary = readSummary();
	if (!summary) return;

	const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
	const count = warnings.length;
	const body = buildDriftIssueBody({ ...summary, warnings }, { runUrl: workflowRunUrl() });

	if (dryRun) {
		console.log(`[notify-drift] DRY RUN — ${count} drift warning(s). Plan body:\n`);
		console.log(body);
		return;
	}

	const existing = findTrackingIssue();

	if (count > 0) {
		ensureLabel();
		const bodyFile = writeBodyToTempFile(body);
		try {
			if (existing) {
				gh(["issue", "edit", String(existing.number), "--body-file", bodyFile]);
				console.log(`[notify-drift] updated tracking issue #${existing.number} (${count} finding(s)).`);
			} else {
				gh(["issue", "create", "--title", DRIFT_ISSUE_TITLE, "--label", DRIFT_ISSUE_LABEL, "--body-file", bodyFile]);
				console.log(`[notify-drift] filed a new tracking issue (${count} finding(s)).`);
			}
		} catch (e) {
			console.error(`[notify-drift] gh issue create/edit failed: ${e?.message ?? e}`);
		}
		return;
	}

	if (existing) {
		try {
			gh([
				"issue", "close", String(existing.number),
				"--comment", "Nightly drift check found no mismatches — self-resolved, closing (#529/#594).",
			]);
			console.log(`[notify-drift] closed tracking issue #${existing.number} (drift resolved).`);
		} catch (e) {
			console.error(`[notify-drift] gh issue close failed: ${e?.message ?? e}`);
		}
		return;
	}

	console.log("[notify-drift] no drift, no open tracking issue — nothing to do.");
}

try {
	main();
} catch (e) {
	// #594: mirrors probe-clean-signal.mjs's own "always exit 0, telemetry
	// only" contract — this step's continue-on-error already covers a nonzero
	// exit, but an internal bug here must not even look like a step failure in
	// the log if we can help it.
	console.error(`[notify-drift] unexpected error (never fails the job): ${e?.message ?? e}`);
}
process.exit(0);
