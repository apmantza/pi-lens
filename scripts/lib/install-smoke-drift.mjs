// Pure helpers behind scripts/notify-install-smoke-drift.mjs (#2613 review
// S2/T3, then round-2 review F1) — kept side-effect-free (no fs/child_process/
// gh) so the body/lookup logic is unit-testable without a live `gh` CLI,
// mirroring scripts/lib/drift-issue.mjs's own testing pattern for the SAME
// reason (that file: nightly `tool-smoke` silentOnClean drift; this file:
// nightly `install-smoke` host-latest install drift). `findDriftTrackingIssue`
// from drift-issue.mjs is reused directly (its title parameter was
// generalized for this second consumer) rather than a second title-matching
// copy. drift-issue.mjs's OWN close condition is a computed finding COUNT
// (`warnings.length === 0`), not this file's shape — it does not share F1.
//
// F1 (round 2): a real GitHub Actions `steps.<id>.outcome` has FOUR values —
// "success" | "failure" | "cancelled" | "skipped" — not two. The original
// `hasDrift` (some step "failure") was correct for FILING, but the caller
// used "not hasDrift" as the CLOSE condition, so a run with every step
// "cancelled" (concurrency's `cancel-in-progress` interrupting a nightly
// mid-run when a dispatch lands on the same ref) or "skipped" (a step's own
// `if:` never became true) had no "failure" anywhere and closed a live
// tracker as "self-resolved" — it never actually installed anything.
// `isCleanRun` (EVERY step "success") is the only correct close condition; a
// run that is neither drifting nor clean (some cancelled/skipped, nothing
// failed) takes NO action at all.

export const INSTALL_SMOKE_DRIFT_TITLE =
	"install-smoke: pi-coding-agent@latest install drift detected";

/** @typedef {"success" | "failure" | "cancelled" | "skipped"} StepOutcome */

/** The complete, real GitHub Actions `steps.<id>.outcome` enum (#2613 F1). */
const VALID_STEP_OUTCOMES = /** @type {const} */ ([
	"success",
	"failure",
	"cancelled",
	"skipped",
]);

/**
 * @typedef {Object} InstallSmokeDriftReport
 * @property {string} version
 * @property {{ name: string, outcome: string }[]} steps
 */

/**
 * A report is only actionable when every step outcome is one of the four
 * real values above. An env var that was never wired up (a workflow edit
 * that dropped it, or this script invoked outside the step that sets it)
 * reads as `undefined`/`""` here, not as a guessed "skipped" — guessing
 * would let a wiring bug quietly masquerade as an ordinary cancelled/skipped
 * run instead of surfacing as the distinct "unknown, took no action"
 * warning it should be (#2613 F1, attack C).
 *
 * @param {InstallSmokeDriftReport} report
 * @returns {boolean}
 */
export function isValidReport(report) {
	return (
		report.steps.length > 0 &&
		report.steps.every(
			(s) =>
				/** @type {readonly string[]} */ (VALID_STEP_OUTCOMES).includes(
					s.outcome,
				),
		)
	);
}

/**
 * The name of the first step whose outcome is "failure", in step order —
 * what the tracking issue names as "the failing step" (#2613 acceptance).
 * Only meaningful on a valid report; callers check `isValidReport` first.
 *
 * @param {InstallSmokeDriftReport} report
 * @returns {string | null}
 */
export function firstFailingStep(report) {
	return report.steps.find((s) => s.outcome === "failure")?.name ?? null;
}

/**
 * FILE/REFRESH condition: at least one step genuinely failed. A cancelled or
 * skipped step is not a failure — see the module doc.
 *
 * @param {InstallSmokeDriftReport} report
 * @returns {boolean}
 */
export function hasDrift(report) {
	return firstFailingStep(report) !== null;
}

/**
 * CLOSE condition (#2613 F1): every step succeeded. This is the ONLY
 * condition that may close an existing tracker — "not hasDrift" is NOT
 * equivalent (a cancelled or all-skipped run is neither a failure nor a
 * clean success, and must take no action either way).
 *
 * @param {InstallSmokeDriftReport} report
 * @returns {boolean}
 */
export function isCleanRun(report) {
	return report.steps.every((s) => s.outcome === "success");
}

/**
 * Decide the ONE action a report calls for — pure, no I/O, no `gh` needed —
 * so this decision is directly unit-testable (#2613 F1). `"close-if-open"`
 * still needs a caller-side check for an existing tracker; that ambiguity
 * is resolved by the caller, not here.
 *
 * @param {InstallSmokeDriftReport} report
 * @returns {"file-or-refresh" | "close-if-open" | "no-action" | "unknown"}
 */
export function decideAction(report) {
	if (!isValidReport(report)) return "unknown";
	if (hasDrift(report)) return "file-or-refresh";
	if (isCleanRun(report)) return "close-if-open";
	return "no-action";
}

/**
 * Build the tracking issue's Markdown body for a FAILING nightly run. Pure
 * string building — no I/O.
 *
 * @param {InstallSmokeDriftReport} report
 * @param {{ runUrl?: string | null }} [opts]
 * @returns {string}
 */
export function buildInstallSmokeDriftBody(report, opts = {}) {
	const failingStep = firstFailingStep(report);
	const lines = [
		"The nightly `install-smoke` workflow's advisory lane installed" +
			` \`@earendil-works/pi-coding-agent@${report.version}\`` +
			" (the `latest` dist-tag, resolved at run time) and hit a failure —" +
			" a pi release outside this repo's declared peerDependencies range" +
			" broke the install path (#2613).",
		"",
		`- Installed version: **${report.version}**`,
		`- Failing step: **${failingStep ?? "unknown"}**`,
		"",
		"| step | outcome |",
		"| --- | --- |",
		...report.steps.map((s) => `| ${s.name} | ${s.outcome} |`),
	];
	if (opts.runUrl) {
		lines.push("", `Workflow run: ${opts.runUrl}`);
	}
	lines.push(
		"",
		"_This issue is auto-refreshed by the nightly `install-smoke` workflow's" +
			" advisory lane — do not close it while the check is failing. It is" +
			" closed automatically once a nightly run installs `@latest` cleanly._",
	);
	return lines.join("\n");
}

/**
 * The comment posted when an EXISTING tracking issue is refreshed by
 * another failing run (never a new issue every night).
 *
 * @param {InstallSmokeDriftReport} report
 * @returns {string}
 */
export function buildInstallSmokeDriftComment(report) {
	return `Still failing: installed ${report.version}, failing step: ${firstFailingStep(report) ?? "unknown"}.`;
}
