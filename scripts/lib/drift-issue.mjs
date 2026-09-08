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
		"This is **telemetry only** — the probe never gates CI. It compares each measured LSP server's observed clean-scan behavior against the hand-set `silentOnClean` marker in `clients/lsp/wait-policy/strategies.ts`; a mismatch here means a human should consider updating that marker (or investigating why the server's observed behavior changed).",
		"",
		`Last observed: ${summary?.generatedAt ?? "unknown"} (${count} finding${count === 1 ? "" : "s"})`,
		"",
		...warnings.map((w) => `- **[${w.kind}]** \`${w.lang}\` — ${w.detail}`),
	];
	if (opts.runUrl) {
		lines.push("", `Workflow run: ${opts.runUrl}`);
	}
	lines.push(
		"",
		"This issue is closed automatically once a nightly run finds no drift.",
	);
	return lines.join("\n");
}

/**
 * Find the single persistent tracking issue among a list of open issues (as
 * returned by `gh issue list --json number,title`) by exact title match — so
 * an unrelated issue that happens to carry the same label (or none at all)
 * for some other reason is never mistaken for the tracker. `title` defaults
 * to this module's own `DRIFT_ISSUE_TITLE` for this file's original
 * `tool-smoke` consumer; a second consumer (scripts/lib/install-smoke-drift.mjs,
 * #2613) passes its OWN title explicitly rather than this module growing a
 * second title constant it has no other use for.
 *
 * @param {{number: number, title: string}[]} issues
 * @param {string} [title]
 * @returns {{number: number, title: string} | null}
 */
export function findDriftTrackingIssue(issues, title = DRIFT_ISSUE_TITLE) {
	return (issues ?? []).find((i) => i.title === title) ?? null;
}

/**
 * File or refresh one title-keyed tracking issue, or close it after a clean
 * run. `gh` is injected so the GitHub API boundary remains the only mock
 * point in callers and tests.
 *
 * @param {{title: string, label: string, body?: string, clean?: boolean, closeWhenClean?: boolean, comment?: string, closeComment?: string, gh: (args: string[]) => string}} options
 * @returns {{action: "created" | "updated" | "closed" | "no-action", issueNumber?: number}}
 */
export function upsertTrackingIssue(options) {
	const {
		title,
		label,
		body = "",
		clean = false,
		closeWhenClean = false,
		comment,
		closeComment = "Tracking check is clean again — self-resolved, closing.",
		gh,
	} = options;
	const existing = findDriftTrackingIssue(
		JSON.parse(
			gh([
				"issue",
				"list",
				"--label",
				label,
				"--state",
				"open",
				"--json",
				"number,title",
				"--limit",
				"20",
			]),
		),
		title,
	);

	if (clean) {
		if (!closeWhenClean || !existing) return { action: "no-action" };
		gh(["issue", "close", String(existing.number), "--comment", closeComment]);
		return { action: "closed", issueNumber: existing.number };
	}

	if (!body)
		throw new Error("tracking issue body is required for a non-clean run");
	const bodyFile =
		options.bodyFile ??
		(() => {
			throw new Error(
				"tracking issue bodyFile is required for a non-clean run",
			);
		})();
	if (existing) {
		gh(["issue", "edit", String(existing.number), "--body-file", bodyFile]);
		if (comment) {
			gh(["issue", "comment", String(existing.number), "--body", comment]);
		}
		return { action: "updated", issueNumber: existing.number };
	}
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
	return { action: "created" };
}
