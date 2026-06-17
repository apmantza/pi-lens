/**
 * Per-Server Diagnostic Strategies for pi-lens LSP
 *
 * Codifies known server behavior so timing decisions (debounce, retry budget,
 * first-push seeding) are automatic rather than one-size-fits-all.
 *
 * Env var overrides (PI_LENS_LSP_*) always take precedence over strategy values.
 */

export interface DiagnosticStrategy {
	/** Seed the push cache on the very first publishDiagnostics notification.
	 *  True for servers whose first push is known to be complete. */
	seedFirstPush: boolean;
	/** Maximum ms to spend retrying pull diagnostics when the first pull returns
	 *  empty. 0 = skip pull retry entirely, rely on push. */
	pullRetryBudgetMs: number;
	/** Debounce window for push diagnostics (ms). Applied in both the notification
	 *  handler and the waitForDiagnostics listener. */
	debounceMs: number;
	/** The aggregate timeout for waitForDiagnostics per this server (ms).
	 *  Overrides the global DIAGNOSTICS_AGGREGATE_WAIT_MS in the service layer. */
	aggregateWaitMs: number;
	/** Whether this server benefits from a second pull after an empty fast first
	 *  pull. TypeScript: no (rely on push). rust-analyzer: yes (incremental). */
	expectSemanticSecondPush: boolean;
	/** Re-sync a re-edited document with didClose+didOpen instead of didChange.
	 *  Default false (language servers re-analyze on didChange). True for scanners
	 *  that only re-scan on a fresh open — e.g. opengrep ignores didChange, so an
	 *  incremental sync silently yields zero findings on every edit-after-first. */
	reopenOnResync?: boolean;
}

export const SERVER_DIAGNOSTIC_STRATEGIES: Record<string, DiagnosticStrategy> =
	{
		typescript: {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 50,
			aggregateWaitMs: 1000,
			expectSemanticSecondPush: false,
		},
		"rust-analyzer": {
			seedFirstPush: false,
			pullRetryBudgetMs: 500,
			debounceMs: 150,
			aggregateWaitMs: 3000,
			expectSemanticSecondPush: true,
		},
		// PythonServer (pyright / basedpyright) — openFilesOnly mode: lazy per-file
		// analysis, startup similar to jedi. seedFirstPush: true because pyright's
		// first publishDiagnostics after didOpen is the complete result for that file.
		python: {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 100,
			aggregateWaitMs: 1500,
			expectSemanticSecondPush: false,
		},
		// jedi-language-server is push-only (no pull diagnostics) and its FIRST
		// publishDiagnostics is the complete result (seedFirstPush). But that first
		// push lands just after didOpen+~1s on cold start (Python/parso import) —
		// measured ~1011ms — so a 1000ms aggregate budget misses it by a hair and
		// returns zero. 3000ms gives cold-start headroom without stalling the warm path.
		"python-jedi": {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 100,
			aggregateWaitMs: 3000,
			expectSemanticSecondPush: false,
		},
		eslint: {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 200,
			aggregateWaitMs: 2000,
			expectSemanticSecondPush: false,
		},
		// Opengrep security scanner (cross-language LSP). It pushes an EMPTY result
		// during the one-time rule-load window at startup, then the real scan after
		// `semgrep/rulesRefreshed` — so never seed the first push. Push-only (no pull
		// diagnostics). Warm per-file scan ~1.3s; the first touch in a session may
		// also pay rule-load (~3.5s cold). aggregateWaitMs is 3500, not 6000:
		// on the with-auxiliary path the deadline is max(callerCap, maxStrategyWait),
		// so a 6000 budget OVERRODE the 2500ms per-edit caller cap and let a
		// clean-primary touch block up to 6s. 3500 covers warm and most cold; a cold
		// scan that overruns isn't lost — late diagnostics are cached and surface on
		// the next edit. (A per-server deadline that respects the caller ceiling is
		// the proper fix — tracked as an enhancement.)
		opengrep: {
			seedFirstPush: false,
			pullRetryBudgetMs: 0,
			debounceMs: 250,
			aggregateWaitMs: 3500,
			expectSemanticSecondPush: false,
			// Opengrep re-scans only on a fresh didOpen — didChange is a no-op for it.
			reopenOnResync: true,
		},
		// ast-grep structural linter (sgconfig-gated auxiliary LSP). Push-only,
		// compiles the project rules on the first scan of a session, and — like
		// Opengrep — is re-synced via didClose+didOpen so edits trigger a re-scan.
		// Conservative budget until measured against real projects (#239).
		// ast-grep re-scans on didChange (verified: toggling the violation count
		// 3→1→4→2 returns the correct fresh count each touch, with matching doc
		// versions), so reopen isn't needed and didChange is the lighter path.
		// aggregateWaitMs is deliberately low (1000, not Opengrep's 6000): on the
		// with-auxiliary path the per-touch deadline is max(callerCap, maxStrategyWait),
		// so a high value inflates the floor when the PRIMARY emits no diagnostics and
		// the wait can't early-return (#239 benchmark finding).
		"ast-grep": {
			seedFirstPush: false,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 1000,
			expectSemanticSecondPush: false,
			reopenOnResync: false,
		},
	};

/** Fallback for unknown servers. Conservative defaults. */
export const DEFAULT_STRATEGY: DiagnosticStrategy = {
	seedFirstPush: false,
	pullRetryBudgetMs: 250,
	debounceMs: 150,
	aggregateWaitMs: 1500,
	expectSemanticSecondPush: false,
};

export function getStrategy(serverId: string): DiagnosticStrategy {
	return SERVER_DIAGNOSTIC_STRATEGIES[serverId] ?? DEFAULT_STRATEGY;
}
