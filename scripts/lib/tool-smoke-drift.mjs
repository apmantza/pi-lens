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
// defect. tool-smoke's three gating layer steps (Tool layer, LSP handshake
// layer, Format layer — the only three WITHOUT `continue-on-error` in
// tool-smoke.yml, so the only three whose `outcome` can actually turn the
// job red) duck-type the exact same `{name, outcome}` shape those functions
// already consume.
import {
	decideAction,
	firstFailingStep,
	hasDrift,
	isCleanRun,
	isValidReport,
	VALID_STEP_OUTCOMES,
} from "./install-smoke-drift.mjs";
import { DRIFT_ISSUE_LABEL, findDriftTrackingIssue } from "./drift-issue.mjs";

export {
	decideAction,
	firstFailingStep,
	hasDrift,
	isCleanRun,
	isValidReport,
	VALID_STEP_OUTCOMES,
	findDriftTrackingIssue,
	DRIFT_ISSUE_LABEL,
};

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
 */

// scripts/smoke-tools.mjs's own `report()` prints this exact line for each
// of the three layers this file tracks:
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

// `report()`'s row format is a fixed-width table:
//   `${ICON}  ${pad(lang,12)} ${pad(runner,28)} ${pad(diags,5)} ${detail}`
// ICON is "✗" for both `fail` and `setup-failed` states (`⚠`/`✓` rows are
// never failures and are skipped here). Matched positionally (not by
// splitting on whitespace) because `detail` free text legitimately contains
// spaces and colons (e.g. "ensureTool(intelephense) failed (npm toolchain
// present): install failed") that a naive split would mangle.
const FAILING_ROW_RE = /^✗ {2}(.{12}) (.{28}) (?:.{5}) (.*)$/;

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
			detail: m[3],
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
 * Build the tracking issue's Markdown body for a RED nightly run. Pure
 * string building — no I/O.
 *
 * @param {ToolSmokeReport} report
 * @param {{ runUrl?: string | null }} [opts]
 * @returns {string}
 */
export function buildToolSmokeDriftBody(report, opts = {}) {
	const { layers, consecutiveRed } = report;
	const failingLayer = firstFailingStep({ steps: layers });
	const lines = [
		"The nightly `Tool smoke (nightly)` workflow's `tool-smoke` job — which" +
			" installs and spawns real tools/LSP servers and drives pi-lens's" +
			" real dispatch path against per-language fixtures — hit a failure" +
			" (#2723).",
		"",
		`- Failing layer: **${failingLayer ?? "unknown"}**`,
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
	return `Still red: failing layer **${failingLayer ?? "unknown"}**.`;
}
