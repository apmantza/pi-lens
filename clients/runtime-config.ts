/**
 * Central runtime tuning knobs for pipeline/dispatch behavior.
 * Keep these values in one place so behavior is consistent and easy to tune.
 */

export const RUNTIME_CONFIG = {
	pipeline: {
		lspMaxFileBytes: 2 * 1024 * 1024,
		lspMaxFileLines: 5000,
		cascadeMaxFiles: 5,
		cascadeMaxDiagnosticsPerFile: 20,
		// Hard cap on how long the pipeline will wait for an LSP client to spawn.
		// Keeps tool_result from blocking the TUI during cold LSP start (e.g.
		// pyright workspace indexing). The LSP server continues spawning in the
		// background; subsequent edits get full diagnostics once it is ready.
		lspSpawnBudgetMs: 5_000,
	},
	dispatch: {
		runnerTimeoutMs: 30_000,
	},
	crashNotice: {
		alwaysShowFirstN: 2,
		showEveryNth: 5,
	},
	reviewGraph: {
		maxFiles: 1_000,
		maxFileBytes: 1 * 1024 * 1024,
	},
	turnEnd: {
		maxLines: 20,
		maxChars: 1000,
	},
} as const;
