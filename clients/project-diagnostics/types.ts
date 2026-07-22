export type ProjectDiagnosticSeverity = "error" | "warning" | "info" | "hint";
export type ProjectDiagnosticSemantic = "blocking" | "warning" | "none";
export type ProjectDiagnosticSource = "lsp" | "dispatch" | "project-scan";
export type ProjectDiagnosticsTier = "cheap" | "all";

export interface ProjectDiagnostic {
	filePath: string;
	line?: number;
	column?: number;
	severity: ProjectDiagnosticSeverity;
	semantic?: ProjectDiagnosticSemantic;
	tool: string;
	runner: string;
	rule?: string;
	code?: string;
	message: string;
	source: ProjectDiagnosticSource;
}

export interface ProjectDiagnosticsSnapshot {
	version: number;
	cwd: string;
	tier: ProjectDiagnosticsTier;
	scannedAt: string;
	diagnostics: ProjectDiagnostic[];
	filesScanned: number;
	runners: string[];
	/**
	 * True when the scan refused to walk because `cwd` resolved at or above the
	 * home directory (#747/#250 escape class) — `diagnostics` is empty and
	 * `filesScanned` is 0 because NOTHING was walked, not because the project is
	 * clean. Kept as a machine-readable flag so a caller renders "unsafe root,
	 * scanned nothing" rather than reading the empty result as a clean verdict.
	 */
	unsafeRoot?: boolean;
}

export interface ProjectDiagnosticsDeltaReport {
	version: number;
	cwd: string;
	generatedAt: string;
	sessionId: string;
	turnIndex: number;
	projectSeqStart?: number;
	projectSeqEnd?: number;
	diagnostics: ProjectDiagnostic[];
	sources: string[];
}

export interface ProjectDiagnosticsScanOptions {
	cwd: string;
	tier: ProjectDiagnosticsTier;
	maxFiles?: number;
	/**
	 * Cancellation for a long full-mode scan (#341). When aborted mid-scan the
	 * scanner returns a partial snapshot and does NOT persist it, so an
	 * interrupted run can't poison the cross-session cache.
	 */
	signal?: AbortSignal;
	/**
	 * Explicit file list (#461): scan exactly these files instead of walking the
	 * project. Used by lens_diagnostics' `paths` scope restrictor. Caller has
	 * already resolved/deduped/filtered these against the ignore matcher.
	 */
	files?: string[];
	/** Override for `os.homedir()`, primarily for tests (mirrors fresh-fetch). */
	homeDir?: string;
}
