/**
 * The one definition of "this runner analysed the root" (#2154).
 *
 * `success: true` from a project runner conflates two different facts: "the
 * tool ran over this root and found nothing" and "the tool did not run".
 * Every runner client has at least one return site of the second kind —
 * knip with no project root, jscpd with no source files, madge with no
 * top-level source file, gitleaks/trivy whose scan crashed before writing a
 * report, vulture that is not installed — and each of those returns
 * `success: true` with an empty result.
 *
 * `lens_diagnostics mode=full` uses the difference to decide which retained
 * findings a fresh run may RETIRE (`FreshProjectDiagnosticsResult.analyzed`
 * -> `authoritativeRunnerIds`). Retiring on a runner that never ran deletes
 * a real finding from the agent's view, so the signal is OPT-IN: a client
 * sets `analyzed: true` only at the site where it parsed the output of a
 * scan it performed over the root during THIS call. Anywhere else — a skip,
 * a crash that still reported success, a memoised result from an earlier
 * call — the field is absent or explicitly `false`.
 *
 * PR #2868 round 3 shipped the inverse (opt-out, `analyzed === false`) and
 * only two of the nine runners ever set it; the other seven were
 * authoritative without running.
 */
export interface AnalysedRootSignal {
	/** True only when this result is the parsed output of a scan this call
	 *  performed over the analysis root. See the module doc. */
	analyzed?: boolean;
}
