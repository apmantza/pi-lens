// Pure helpers behind scripts/notify-tool-smoke-red.mjs (#2723) — kept
// side-effect-free (no fs/child_process/gh) so the parsing/body/decision
// logic is unit-testable without a live `gh` CLI, mirroring
// scripts/lib/install-smoke-drift.mjs's own testing pattern for the SAME
// reason (that file: nightly `install-smoke` host-latest install drift;
// this file: nightly `tool-smoke` job-verdict drift — i.e. "did the Live
// tool + LSP smoke job go red", not #529/#594's unrelated silentOnClean
// telemetry, which stays in scripts/lib/drift-issue.mjs/
// notify-clean-signal-drift.mjs untouched).
//
// #2723: the ONLY tracking-issue step tool-smoke.yml had (the #529/#594
// silentOnClean notifier) sat behind the LSP handshake layer step with
// `continue-on-error: true` but no `if: always()`, so a failing job SKIPPED
// it — the one case it most needed to run in. This file backs a SECOND,
// independent notifier scoped to the job's actual pass/fail verdict, wired
// to a final `if: always()` step so it runs on every outcome.
//
// The four-valued GitHub Actions `steps.<id>.outcome` classification
// (isValidReport/hasDrift/isCleanRun/decideAction/firstFailingStep) is
// reused directly from install-smoke-drift.mjs rather than re-derived here
// a second time — it is a generic property of the platform (not an
// install-smoke domain rule), and duplicating it would be exactly the
// "hand-maintained list that mirrors a registry" AGENTS.md flags as a
// defect. tool-smoke's four gating layer steps (Tool layer, LSP handshake
// layer, LSP gate, Format layer — the only four WITHOUT `continue-on-error` in
// tool-smoke.yml, so the only four whose `outcome` can actually turn the
// job red) duck-type the exact same `{name, outcome}` shape those functions
// already consume.
// #2723 review F7: only decideAction (re-exported -- consumed directly by
// notify-tool-smoke-red.mjs's dry-run/tests) and firstFailingStep (used
// internally by this file's own body/comment builders, never re-exported)
// are actually consumed anywhere. hasDrift/isCleanRun/isValidReport/
// VALID_STEP_OUTCOMES were imported+re-exported "for completeness" but knip
// names all five as unused on this file -- a re-export nothing imports is
// dead weight the same as an unused local, so they're gone rather than kept
// as a hedge against a future need.
import { decideAction, firstFailingStep } from "./install-smoke-drift.mjs";
import { DRIFT_ISSUE_LABEL, findDriftTrackingIssue } from "./drift-issue.mjs";

export { decideAction, findDriftTrackingIssue, DRIFT_ISSUE_LABEL };

export const TOOL_SMOKE_DRIFT_TITLE =
	"tool-smoke: nightly Live tool + LSP smoke job is red";

/** @typedef {"success" | "failure" | "cancelled" | "skipped"} StepOutcome */

/**
 * @typedef {Object} FailingRow
 * @property {string} lang
 * @property {string} runner
 * @property {string} detail
 */

/**
 * @typedef {Object} ToolSmokeLayer
 * @property {string} name
 * @property {string} outcome
 * @property {{passed: number, failed: number, setupFailed: number, skipped: number} | null} summary
 * @property {FailingRow[]} failingRows
 */

/**
 * @typedef {Object} ToolSmokeReport
 * @property {ToolSmokeLayer[]} layers
 * @property {number} [consecutiveRed]
 * @property {boolean} [outsideTrackedLayers]
 */

// scripts/smoke-tools.mjs's own `report()` prints this exact line for each
// of the four layers this file tracks:
//   `${pass} passed · ${fail} failed · ${setupFailed} setup-failed · ${skip} skipped (tool/config unavailable)`
const SUMMARY_LINE_RE =
	/(\d+) passed · (\d+) failed · (\d+) setup-failed · (\d+) skipped/;

/**
 * Parse the "N passed · M failed · K setup-failed · S skipped" line
 * `smoke-tools.mjs`'s `report()` prints at the end of a layer's run, from
 * that layer's raw captured log text. Returns null when the line is absent
 * (the step never produced a report — e.g. it was skipped, or crashed
 * before `report()` ran).
 *
 * @param {string | null | undefined} text
 * @returns {{passed: number, failed: number, setupFailed: number, skipped: number} | null}
 */
export function parseLayerSummary(text) {
	if (!text) return null;
	const m = SUMMARY_LINE_RE.exec(text);
	if (!m) return null;
	return {
		passed: Number(m[1]),
		failed: Number(m[2]),
		setupFailed: Number(m[3]),
		skipped: Number(m[4]),
	};
}

// `report()`'s row format is a table PADDED to fixed widths, but never
// TRUNCATED (`pad = String.padEnd`, scripts/smoke-tools.mjs's `report()`):
//   `${ICON}  ${pad(lang,12)} ${pad(runner,28)} ${pad(diags,5)} ${detail}`
// A lang/runner longer than its column (#2723 review F2: 8 of the 76 rows
// in run 34116176046 alone -- typescript-clean, typescript7, typescript7-
// clean, cue, powershell, ast-grep-baseline, deno, and the TS7-alternate
// row -- exceed 12/28 chars) simply runs the column wider than usual; the
// PREVIOUS fixed-width regex (`(.{12}) (.{28}) (?:.{5})`) required exact
// column boundaries and silently failed to match any such row at all, so a
// genuinely failing tool with a long name would never appear in a filed
// issue. Matched by STRUCTURE instead: lang is the first whitespace-free
// token; runner is everything up to the LAST run of 2+ spaces before the
// diag count and detail (non-greedy, so a runner name that itself contains
// a single space, e.g. "ast-grep (no-sgconfig baseline)", stays intact --
// only the padding gaps are 2+ spaces); diags is digits; detail is
// everything after the final gap. ICON is "✗" for both `fail` and
// `setup-failed` states (`⚠`/`✓` rows are never failures and are skipped
// here).
const FAILING_ROW_RE = /^✗ {2}(\S+) +(.+?) +(\d+) {2,}(\S.*)$/;

/**
 * Parse every ✗ row out of a layer's raw captured log text (order
 * preserved). Pure string parsing — no I/O.
 *
 * @param {string | null | undefined} text
 * @returns {FailingRow[]}
 */
export function parseFailingRows(text) {
	if (!text) return [];
	const rows = [];
	for (const line of text.split("\n")) {
		const m = FAILING_ROW_RE.exec(line.replace(/\r$/, ""));
		if (!m) continue;
		rows.push({
			lang: m[1].trim(),
			runner: m[2].trim(),
			detail: m[4],
		});
	}
	return rows;
}

/**
 * Build one layer's report record from its raw GitHub Actions step outcome
 * plus its captured log text (or null when the step didn't run / no log was
 * captured). Pure — no fs reads happen here, the caller supplies the text.
 *
 * @param {string} name
 * @param {string} outcome
 * @param {string | null | undefined} logText
 * @returns {ToolSmokeLayer}
 */
export function buildLayer(name, outcome, logText) {
	return {
		name,
		outcome,
		summary: parseLayerSummary(logText),
		failingRows: parseFailingRows(logText),
	};
}

const CONSECUTIVE_RED_RE = /Consecutive red nights:\s*\*\*(\d+)\*\*/;

/**
 * Read back the "Consecutive red nights: **N**" line this module's own
 * `buildToolSmokeDriftBody` writes, from a PRIOR run's issue body — so a
 * refresh can increment it rather than the tracker forever reading "1"
 * (acceptance #1: "a second consecutive red updates it — assert count, not
 * presence"). Absent/unparseable reads as 0, so the next call's `+ 1` still
 * produces a sane first count instead of throwing.
 *
 * @param {string | null | undefined} existingBody
 * @returns {number}
 */
export function parseConsecutiveRedCount(existingBody) {
	const m = CONSECUTIVE_RED_RE.exec(existingBody ?? "");
	return m ? Number(m[1]) : 0;
}

/**
 * @param {string | null | undefined} existingBody
 * @returns {number}
 */
export function nextConsecutiveRedCount(existingBody) {
	return parseConsecutiveRedCount(existingBody) + 1;
}

/**
 * #2723 review F3: `decideAction`'s three-layer-outcome view cannot
 * distinguish "the job failed somewhere BEFORE the three tracked layers
 * even started" (checkout, seven best-effort setup actions — already
 * `continue-on-error` and so cannot flip this, `npm install`, or
 * `build:dist`) from a genuine GitHub Actions cancellation: both leave
 * Tool/LSP handshake/LSP gate/Format layer all "skipped", which `decideAction` reads
 * as "no-action" either way (see install-smoke-drift.mjs's own
 * cancelled-mid-run/before-start attacks — the identical shape). GitHub's
 * `job.status` context (passed through as JOB_STATUS) disambiguates: it
 * reads "failure" only when a non-`continue-on-error` step genuinely failed
 * somewhere in the job; a plain cancellation reports "cancelled", never
 * "failure". This promotes "no-action" to "file-or-refresh" ONLY when the
 * job is genuinely red for a reason outside the three tracked layers, and
 * leaves an actual cancellation exactly as untouched as before.
 *
 * #2723 review F4: `set -o pipefail` on each layer step is load-bearing —
 * without it, `node scripts/smoke-tools.mjs ... | tee logfile` reports the
 * PIPE's exit code (`tee`'s, almost always 0) as the step's own `outcome`,
 * so a genuinely red layer could read "success" while its own captured log
 * still shows a nonzero failed/setup-failed count. This is the cheap
 * backstop for exactly that discrepancy: even when every tracked layer's
 * raw `outcome` says "success" (`decideAction`'s "close-if-open"
 * condition), refuse to close if ANY layer's own PARSED summary disagrees —
 * see `layersGenuinelyClean` below.
 *
 * @param {ToolSmokeReport} report
 * @param {string} jobStatus
 * @returns {{action: "file-or-refresh" | "close-if-open" | "no-action" | "unknown", outsideTrackedLayers: boolean}}
 */
export function decideToolSmokeAction(report, jobStatus) {
	const layerAction = decideAction({ steps: report.layers });

	if (layerAction === "no-action" && jobStatus === "failure") {
		return { action: "file-or-refresh", outsideTrackedLayers: true };
	}

	if (layerAction === "close-if-open" && !layersGenuinelyClean(report.layers)) {
		return { action: "no-action", outsideTrackedLayers: false };
	}

	return { action: layerAction, outsideTrackedLayers: false };
}

/**
 * True only when every layer's PARSED summary (where one was captured)
 * shows zero failed AND zero setup-failed. A layer with no summary at all
 * (never ran / crashed before `report()`) is not itself evidence of
 * dirtiness here — `decideAction`'s outcome-based check already covers a
 * step that didn't run cleanly; this function exists solely to catch the
 * PIPEFAIL-loss scenario where the outcome lies (see F4 above).
 *
 * @param {ToolSmokeLayer[]} layers
 * @returns {boolean}
 */
export function layersGenuinelyClean(layers) {
	return layers.every(
		(l) =>
			!l.summary || (l.summary.failed === 0 && l.summary.setupFailed === 0),
	);
}

/**
 * Build the tracking issue's Markdown body for a RED nightly run. Pure
 * string building — no I/O.
 *
 * @param {ToolSmokeReport} report
 * @param {{ runUrl?: string | null }} [opts]
 * @returns {string}
 */
export function buildToolSmokeDriftBody(report, opts = {}) {
	const { layers, consecutiveRed, outsideTrackedLayers } = report;
	const failingLayer = firstFailingStep({ steps: layers });
	const failingLayerLabel =
		failingLayer ??
		(outsideTrackedLayers ? "(outside the tracked layers)" : "unknown");
	const lines = [
		"The nightly `Tool smoke (nightly)` workflow's `tool-smoke` job — which" +
			" installs and spawns real tools/LSP servers and drives pi-lens's" +
			" real dispatch path against per-language fixtures — hit a failure" +
			" (#2723).",
		"",
		`- Failing layer: **${failingLayerLabel}**`,
	];
	if (typeof consecutiveRed === "number" && consecutiveRed > 0) {
		lines.push(`- Consecutive red nights: **${consecutiveRed}**`);
	}
	lines.push(
		"",
		"| layer | outcome | summary |",
		"| --- | --- | --- |",
		...layers.map((l) => {
			const s = l.summary;
			const summaryText = s
				? `${s.passed} passed · ${s.failed} failed · ${s.setupFailed} setup-failed · ${s.skipped} skipped`
				: "(no report — step did not run)";
			return `| ${l.name} | ${l.outcome} | ${summaryText} |`;
		}),
	);
	const failingRows = layers.flatMap((l) =>
		l.failingRows.map((r) => ({ ...r, layer: l.name })),
	);
	if (failingRows.length > 0) {
		lines.push("", "Failing rows:", "");
		for (const r of failingRows) {
			lines.push(
				`- **[${r.layer}]** \`${r.lang}\` / \`${r.runner}\` — ${r.detail}`,
			);
		}
	}
	if (opts.runUrl) {
		lines.push("", `Workflow run: ${opts.runUrl}`);
	}
	lines.push(
		"",
		"_This issue is auto-refreshed by the nightly `Tool smoke` workflow's" +
			" final step — do not close it while the check is failing. It is" +
			" closed automatically once a nightly run is fully green (#2723)._",
	);
	return lines.join("\n");
}

/**
 * The comment posted when an EXISTING tracking issue is refreshed by
 * another red run (never a new issue every night).
 *
 * @param {ToolSmokeReport} report
 * @returns {string}
 */
export function buildToolSmokeDriftComment(report) {
	const failingLayer = firstFailingStep({ steps: report.layers });
	const failingLayerLabel =
		failingLayer ??
		(report.outsideTrackedLayers ? "(outside the tracked layers)" : "unknown");
	return `Still red: failing layer **${failingLayerLabel}**.`;
}
