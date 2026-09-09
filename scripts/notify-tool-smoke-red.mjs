#!/usr/bin/env node
/**
 * #2723: `Tool smoke (nightly)` went red 13 consecutive nights without any
 * automated notice — the only tracking-issue writer tool-smoke.yml had
 * (`notify-clean-signal-drift.mjs`, #529/#594) sits AFTER the LSP handshake
 * layer step with `continue-on-error: true` but no `if: always()`, so a
 * failing run skips it, along with every step behind it. That script is
 * also scoped to something unrelated (silentOnClean marker drift, telemetry
 * only, never the job verdict) — see scripts/lib/drift-issue.mjs's module
 * doc. This script is a SECOND, independent notifier: it watches the job's
 * actual pass/fail verdict and is wired to a FINAL `if: always()` step in
 * tool-smoke.yml, so it runs on every outcome.
 *
 * Reads the run's FOUR gating layer outcomes from env (set by the
 * workflow step that invokes this script), plus each layer's captured log
 * text from the file paths the workflow's own `tee` steps wrote — never
 * re-derives success/failure or re-parses anything itself beyond those
 * inputs. The four layers are the only steps in tool-smoke.yml WITHOUT
 * `continue-on-error: true` (Tool layer, LSP handshake layer, LSP gate, Format
 * layer) — the only ones whose outcome can actually turn the job red;
 * see scripts/lib/tool-smoke-drift.mjs's module doc for the shared
 * four-outcome classification this reuses from install-smoke-drift.mjs.
 *
 * Required env (each *_OUTCOME: success | failure | cancelled | skipped;
 * each *_LOG: a file path, which may not exist if that step never ran):
 *   TOOL_LAYER_OUTCOME / TOOL_LAYER_LOG
 *   LSP_HANDSHAKE_OUTCOME / LSP_HANDSHAKE_LOG
 *   LSP_GATE_OUTCOME / LSP_GATE_LOG
 *   FORMAT_LAYER_OUTCOME / FORMAT_LAYER_LOG
 *   JOB_STATUS (GitHub's `job.status` context — #2723 review F3: the three
 *     tracked layers all read "skipped" both when a step BEFORE them failed
 *     — checkout, a setup action, npm install, build:dist — and when the
 *     job was genuinely cancelled; JOB_STATUS disambiguates the two so the
 *     former still files instead of silently taking no action)
 * Optional: GITHUB_TOKEN (gh auth — the job already sets this at job
 *   level for the docs-refresh PR step), GITHUB_SERVER_URL/
 *   GITHUB_REPOSITORY/GITHUB_RUN_ID (workflow-run link in the issue body).
 *
 *   node scripts/notify-tool-smoke-red.mjs                    # real gh calls
 *   node scripts/notify-tool-smoke-red.mjs --dry-run          # compute + print the plan, no gh calls
 *
 * Never lets an internal error escape as a nonzero exit, and the workflow
 * step wraps this in `continue-on-error: true` too (belt + suspenders,
 * mirroring both existing notifiers) — filing/updating/closing an issue is
 * a side effect, never a build gate; it must not change the nightly's own
 * conclusion (acceptance #5).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildLayer,
	buildToolSmokeDriftBody,
	buildToolSmokeDriftComment,
	decideToolSmokeAction,
	DRIFT_ISSUE_LABEL,
	findDriftTrackingIssue,
	nextConsecutiveRedCount,
	TOOL_SMOKE_DRIFT_TITLE,
} from "./lib/tool-smoke-drift.mjs";

const LAYERS = /** @type {const} */ ([
	["TOOL_LAYER_OUTCOME", "TOOL_LAYER_LOG", "Tool layer"],
	["LSP_HANDSHAKE_OUTCOME", "LSP_HANDSHAKE_LOG", "LSP handshake layer"],
	["LSP_GATE_OUTCOME", "LSP_GATE_LOG", "LSP diagnostics clean-gate"],
	["FORMAT_LAYER_OUTCOME", "FORMAT_LAYER_LOG", "Format layer"],
]);

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");

function gh(args) {
	return execFileSync("gh", args, { encoding: "utf8" });
}

function readLogFile(logPath) {
	if (!logPath) return null;
	try {
		return fs.readFileSync(logPath, "utf8");
	} catch {
		return null;
	}
}

/**
 * Reads each layer's RAW env outcome with no fallback/guess (mirrors
 * install-smoke-drift.mjs's F1 fix): an env var the workflow step forgot to
 * wire up must read as "not a real outcome" (isValidReport catches it via
 * decideAction), never silently become "skipped".
 */
function readReport(env) {
	const layers = LAYERS.map(([outcomeVar, logVar, name]) =>
		buildLayer(name, env[outcomeVar] ?? "", readLogFile(env[logVar])),
	);
	return { layers };
}

function workflowRunUrl(env) {
	const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
	if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
	return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

function findTrackingIssue() {
	try {
		const out = gh([
			"issue",
			"list",
			"--search",
			`in:title "${TOOL_SMOKE_DRIFT_TITLE}"`,
			"--state",
			"open",
			"--json",
			"number,title",
			"--limit",
			"20",
		]);
		return findDriftTrackingIssue(JSON.parse(out), TOOL_SMOKE_DRIFT_TITLE);
	} catch (e) {
		console.error(
			`[notify-tool-smoke-red] gh issue list failed, treating as "no existing issue": ${e?.message ?? e}`,
		);
		return null;
	}
}

function readExistingBody(number) {
	try {
		const out = gh(["issue", "view", String(number), "--json", "body"]);
		return JSON.parse(out).body ?? "";
	} catch (e) {
		console.error(
			`[notify-tool-smoke-red] gh issue view failed, treating prior count as 0: ${e?.message ?? e}`,
		);
		return "";
	}
}

/**
 * #2723 review F1: `gh issue create --label a,b` validates every label
 * up front and refuses to create the issue at all if ANY of them doesn't
 * exist on the repo (confirmed against `nightly-drift` itself, which was
 * missing from `.github/labels.yml` — `gh api repos/.../labels/nightly-drift`
 * 404'd, and the real create call errored "could not add label"). The label
 * is now registered there (the manifest is the single place a label may be
 * added — its own module doc), but a create call is still a live network
 * request: if the label registry and this script's constant ever drift
 * again (a rename, a manifest sync race, `.github/labels.yml` edited
 * without touching `DRIFT_ISSUE_LABEL`), the ORIGINAL failure mode was
 * total — the tracking issue was silently never filed on the one night it
 * mattered most. Retrying once WITHOUT labels turns that into "filed, just
 * missing a label" instead of "never filed".
 */
function createTrackingIssue(title, label, bodyFile) {
	try {
		gh([
			"issue",
			"create",
			"--title",
			title,
			"--label",
			label,
			"--body-file",
			bodyFile,
		]);
		return true;
	} catch (e) {
		console.error(
			`[notify-tool-smoke-red] gh issue create with label "${label}" failed, retrying without labels: ${e?.message ?? e}`,
		);
	}
	try {
		gh(["issue", "create", "--title", title, "--body-file", bodyFile]);
		return true;
	} catch (e) {
		console.error(
			`[notify-tool-smoke-red] gh issue create failed even without labels: ${e?.message ?? e}`,
		);
		return false;
	}
}

function writeBodyToTempFile(body) {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pilens-tool-smoke-drift-"),
	);
	const file = path.join(dir, "body.md");
	fs.writeFileSync(file, body);
	return file;
}

function main(env) {
	const report = readReport(env);
	const { action, outsideTrackedLayers } = decideToolSmokeAction(
		report,
		env.JOB_STATUS ?? "",
	);
	const flaggedReport = { ...report, outsideTrackedLayers };

	if (action === "unknown") {
		const msg =
			`[notify-tool-smoke-red] one or more layer outcomes are missing or not a real ` +
			`GitHub Actions outcome (success/failure/cancelled/skipped) — this is a wiring bug, ` +
			`not a normal run state; taking NO action. Layers: ${JSON.stringify(
				report.layers.map((l) => ({ name: l.name, outcome: l.outcome })),
			)}`;
		console.error(dryRun ? msg : `::warning::${msg}`);
		return;
	}

	if (action === "no-action") {
		console.log(
			"[notify-tool-smoke-red] run was cancelled/skipped (no failure, not fully clean) — taking no action.",
		);
		return;
	}

	if (dryRun) {
		const body = buildToolSmokeDriftBody(
			{
				...flaggedReport,
				consecutiveRed: action === "file-or-refresh" ? 1 : undefined,
			},
			{ runUrl: workflowRunUrl(env) },
		);
		console.log(
			`[notify-tool-smoke-red] DRY RUN — action=${action}. Plan body:\n`,
		);
		console.log(body);
		return;
	}

	const existing = findTrackingIssue();

	if (action === "file-or-refresh") {
		const existingBody = existing ? readExistingBody(existing.number) : null;
		const consecutiveRed = nextConsecutiveRedCount(existingBody);
		const body = buildToolSmokeDriftBody(
			{ ...flaggedReport, consecutiveRed },
			{ runUrl: workflowRunUrl(env) },
		);
		const bodyFile = writeBodyToTempFile(body);
		try {
			if (existing) {
				gh(["issue", "edit", String(existing.number), "--body-file", bodyFile]);
				gh([
					"issue",
					"comment",
					String(existing.number),
					"--body",
					buildToolSmokeDriftComment(flaggedReport),
				]);
				console.log(
					`[notify-tool-smoke-red] updated tracking issue #${existing.number} (consecutive red: ${consecutiveRed}).`,
				);
			} else {
				const created = createTrackingIssue(
					TOOL_SMOKE_DRIFT_TITLE,
					`${DRIFT_ISSUE_LABEL},area:tests`,
					bodyFile,
				);
				if (created) {
					console.log(
						`[notify-tool-smoke-red] filed a new tracking issue (consecutive red: ${consecutiveRed}).`,
					);
				}
			}
		} catch (e) {
			console.error(
				`[notify-tool-smoke-red] gh issue create/edit failed: ${e?.message ?? e}`,
			);
		}
		return;
	}

	// action === "close-if-open"
	if (existing) {
		try {
			gh([
				"issue",
				"close",
				String(existing.number),
				"--comment",
				"Nightly `tool-smoke` ran fully green — self-resolved, closing (#2723).",
			]);
			console.log(
				`[notify-tool-smoke-red] closed tracking issue #${existing.number} (drift resolved).`,
			);
		} catch (e) {
			console.error(
				`[notify-tool-smoke-red] gh issue close failed: ${e?.message ?? e}`,
			);
		}
		return;
	}

	console.log(
		"[notify-tool-smoke-red] no drift, no open tracking issue — nothing to do.",
	);
}

try {
	main(process.env);
} catch (e) {
	console.error(
		`[notify-tool-smoke-red] unexpected error (never fails the job): ${e?.message ?? e}`,
	);
}
process.exit(0);
