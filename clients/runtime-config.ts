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
	},
	dispatch: {
		runnerTimeoutMs: 30_000,
	},
	crashNotice: {
		alwaysShowFirstN: 2,
		showEveryNth: 5,
	},
	turnEnd: {
		maxLines: 20,
		maxChars: 1000,
	},
} as const;
