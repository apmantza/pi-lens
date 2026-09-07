export type ProjectDiagnosticSeverity = "error" | "warning" | "info" | "hint";
type ProjectDiagnosticSemantic = "blocking" | "warning" | "none";
type ProjectDiagnosticSource = "lsp" | "dispatch" | "project-scan";
type ProjectDiagnosticsTier = "cheap" | "all";

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
	/** Visible degraded state after the process-wide WASM runtime aborts. */
	treeSitterStatus?: "wasm_aborted_restart_required";
	/**
	 * True when the scan refused to walk because `cwd` resolved at or above the
	 * home directory (#747/#250 escape class) — `diagnostics` is empty and
	 * `filesScanned` is 0 because NOTHING was walked, not because the project is
	 * clean. Kept as a machine-readable flag so a caller renders "unsafe root,
	 * scanned nothing" rather than reading the empty result as a clean verdict.
	 */
	unsafeRoot?: boolean;
	/**
	 * True when the source-file walk stopped at its visited-entry budget (#760)
	 * — the file list (and therefore `diagnostics` / `filesScanned`) covers a
	 * truncated best-effort subset of the tree, not the whole project. Unlike
	 * `unsafeRoot` this is NOT a refusal: a truncated analysis is still useful;
	 * the flag only keeps a caller from reading the partial result as a
	 * complete, clean sweep.
	 *
	 * Also true when tree-sitter's process-wide WASM runtime aborts during the
	 * file-major pass. That partial result is returned for observability but is
	 * never persisted over the last authoritative snapshot (#891).
	 */
	scanTruncated?: boolean;
	/**
	 * #1107 phase 2: source files this scan's walk KEPT OUT because they
	 * matched a generated/artifact NAME or content-header heuristic
	 * (`source-filter.ts`'s `generatedOrArtifactSkips` counter) — the RAW
	 * total across every evidence tier (lockfiles, declaration files,
	 * minified/bundle/chunk output, content/header-confirmed matches, AND the
	 * unconfirmed name-only bucket). Full-observability field; NOT what the
	 * user-facing notice keys off — see `generatedNameOnlySkips` below and
	 * `generatedSkipNotice`'s doc for why the raw total fires on virtually
	 * every real repo (any lockfile alone trips it). Only present (and only
	 * nonzero) when this scan actually walked (`options.files` scans never
	 * populate it, matching `scanTruncated`/`entryBudgetExceeded`'s existing
	 * convention).
	 */
	generatedFileSkips?: number;
	/**
	 * #1107 phase 2 review round 2: the SUBSET of `generatedFileSkips` whose
	 * `"generated"` verdict came from `GeneratedArtifactEvidence: "name-only"`
	 * (`source-filter.ts`'s `generatedNameOnlySkips` counter) — a WEAK
	 * generated-artifact NAME match trusted with NO corroborating evidence
	 * check at all. This is the genuinely at-risk, false-positive-prone
	 * bucket the content-probe escape hatch could not evaluate; the
	 * tool-facing notice (`generatedSkipNotice`) keys off THIS, not the raw
	 * `generatedFileSkips` total. Same presence convention as
	 * `generatedFileSkips`.
	 */
	generatedNameOnlySkips?: number;
	/**
	 * #1107 phase 2: whole DIRECTORIES this scan's walk pruned because their
	 * NAME looked generated (`shouldRecurseIntoDir`'s
	 * `isGeneratedArtifactDirectoryName` branch; `generatedDirSkips` on
	 * `SourceCollectionResult`) — one count per directory pruned, not per file
	 * inside it (the directory's contents are never enumerated). Same
	 * presence convention as `generatedFileSkips`.
	 */
	generatedDirSkips?: number;
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
	 * Budget on directory entries the source-file walk may VISIT (#760),
	 * independent of `maxFiles` (results kept). Defaults to source-filter's
	 * DEFAULT_MAX_SCAN_ENTRIES; when it trips, the scan proceeds on the
	 * truncated list and the snapshot carries `scanTruncated: true`.
	 */
	maxScanEntries?: number;
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
	/**
	 * #1107 phase 2 review (P2): scan WITHOUT the generated/artifact NAME
	 * heuristic filter — the actionable opt-out `generatedSkipNotice`
	 * (`lens-engine.ts`) points a user at when a scan's excluded-by-heuristic
	 * count looks suspicious. Threaded straight through to
	 * `collectSourceFilesWithBudgetAsync`'s `includeGenerated` (source-filter.ts);
	 * default `false` (existing filtering behavior unchanged). Only meaningful
	 * on a walk (`options.files` scans never filter by this heuristic in the
	 * first place).
	 */
	includeGenerated?: boolean;
}
