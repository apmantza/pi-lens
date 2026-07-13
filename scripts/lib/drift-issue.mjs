// Pure helpers behind scripts/notify-clean-signal-drift.mjs (#594) — kept
// side-effect-free (no fs/child_process/gh) so they're unit-testable without a
// live `gh` CLI, mirroring scripts/lib/clean-signal.mjs's own testing pattern
// (tests/scripts/clean-signal.test.ts tests the classifier, not the script
// that spawns servers; this tests the issue-body/lookup logic, not the script
// that shells out to `gh`).
//
// The tracking issue is intentionally SINGLE and persistent: a fixed label +
// a fixed title, found by title match among open issues carrying the label —
// never a new issue every night (that would spam), closed automatically once
// a nightly run finds no drift.

export const DRIFT_ISSUE_LABEL = "nightly-drift";
export const DRIFT_ISSUE_TITLE = "nightly: silentOnClean drift detected";

/**
 * @typedef {Object} DriftSummary
 * @property {string} [generatedAt]
 * @property {number} [count]
 * @property {{lang: string, kind: string, detail: string}[]} [warnings]
 */

/**
 * Build the tracking issue's Markdown body from the probe's JSON summary.
 * Pure string building — no I/O.
 *
 * @param {DriftSummary} summary
 * @param {{ runUrl?: string | null }} [opts]
 * @returns {string}
 */
export function buildDriftIssueBody(summary, opts = {}) {
  const warnings = Array.isArray(summary?.warnings) ? summary.warnings : [];
  const count = warnings.length;
  const lines = [
    "Auto-filed/updated by the nightly `tool-smoke` workflow's `probe-clean-signal.mjs` step (#529/#594).",
    "",
    "This is **telemetry only** — the probe never gates CI. It compares each measured LSP server's observed clean-scan behavior against the hand-set `silentOnClean` marker in `clients/lsp/server-strategies.ts`; a mismatch here means a human should consider updating that marker (or investigating why the server's observed behavior changed).",
    "",
    `Last observed: ${summary?.generatedAt ?? "unknown"} (${count} finding${count === 1 ? "" : "s"})`,
    "",
    ...warnings.map((w) => `- **[${w.kind}]** \`${w.lang}\` — ${w.detail}`),
  ];
  if (opts.runUrl) {
    lines.push("", `Workflow run: ${opts.runUrl}`);
  }
  lines.push("", "This issue is closed automatically once a nightly run finds no drift.");
  return lines.join("\n");
}

/**
 * Find the single persistent tracking issue among a list of open,
 * label-filtered issues (as returned by `gh issue list --json number,title`).
 * Title-matched (not just label-matched) so an unrelated issue that happens to
 * carry the label for some other reason is never mistaken for the tracker.
 *
 * @param {{number: number, title: string}[]} issues
 * @returns {{number: number, title: string} | null}
 */
export function findDriftTrackingIssue(issues) {
  return (issues ?? []).find((i) => i.title === DRIFT_ISSUE_TITLE) ?? null;
}
