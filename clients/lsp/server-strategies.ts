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
		// also pay rule-load (~3.5s cold). aggregateWaitMs is 3500: it's this
		// server's OWN deadline, bounded by the per-edit caller cap as a ceiling
		// (#242), so on a 2500ms-capped edit opengrep waits min(2500, 3500)=2500
		// and on uncapped paths it gets its full 3500. 3500 covers warm and most
		// cold; a cold scan that overruns isn't lost — late diagnostics are cached
		// and surface on the next edit.
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
		// aggregateWaitMs is 1800: its warm scan is ~1.3s, so 1000 was under-budgeted
		// (only masked before because the old with-auxiliary deadline was a global
		// max() floor; now each server has its own caller-cap-bounded deadline, #242,
		// so the budget must actually cover the scan).
		"ast-grep": {
			seedFirstPush: false,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 1800,
			expectSemanticSecondPush: false,
			reopenOnResync: false,
		},
		// zizmor (GitHub Actions security scanner, auxiliary LSP #272). Push-only
		// (no pull diagnostics). Its audit set is compiled-in — there's no rule-load
		// window like Opengrep — so the FIRST publishDiagnostics after didOpen IS the
		// complete result: seedFirstPush. It re-scans on didChange (FULL sync), so no
		// reopen-on-resync. A native single-workflow audit is sub-second offline;
		// online mode may add a GitHub-API round-trip, so 2000ms gives headroom
		// (bounded by the per-edit caller cap as a ceiling, #242), and any late online
		// finding is cached and surfaces on the next edit.
		zizmor: {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 2000,
			expectSemanticSecondPush: false,
			reopenOnResync: false,
		},
		// typos (source-code spell checker, auxiliary LSP #283). Push-only (no pull
		// diagnostics). Its dictionary is compiled in — there's NO rule-load window
		// like Opengrep — so the FIRST publishDiagnostics after didOpen IS the
		// complete result: seedFirstPush. It re-scans on didChange (FULL sync), so no
		// reopen-on-resync. A native single-file spell scan is sub-100ms, so the seed
		// arrives near-instantly; aggregateWaitMs is a generous ceiling (bounded by
		// the per-edit caller cap, #242) that the early seed resolves well under.
		typos: {
			seedFirstPush: true,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 1500,
			expectSemanticSecondPush: false,
			reopenOnResync: false,
		},
		// marksman (Markdown LSP, #274). Push-based; native binary so the per-file
		// parse is fast, but its value is CROSS-file (broken intra-repo links,
		// missing anchors/heading refs) which needs the workspace index — so the
		// first push after didOpen can be empty before indexing completes. Don't
		// seed it (like opengrep/rust-analyzer); a modest 1500ms aggregate covers
		// warm edits, and any late cross-file finding surfaces on the next touch.
		marksman: {
			seedFirstPush: false,
			pullRetryBudgetMs: 0,
			debounceMs: 150,
			aggregateWaitMs: 1500,
			expectSemanticSecondPush: false,
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
