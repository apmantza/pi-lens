// Types for the (plain-JS) tool-smoke harness, so TS consumers — e.g. the
// smoke-fixture-coverage drift guard — can import its fixture arrays.
export interface SmokeFixture {
	lang: string;
	dir: string;
	file: string;
	cwd?: string;
	targets?: string[];
	tools?: string[];
	expectDiagnostic?: boolean;
	expectDiagnosticCount?: number;
	expectRule?: string;
	/**
	 * In the tier-1 parser lane (#1937): the tool installs as a pip/npm package
	 * or a single GitHub-release binary, with no language toolchain step.
	 */
	tier1?: boolean;
}
export interface LspFixture {
	lang: string;
	dir: string;
	file: string;
	serverHint: string;
	tools?: string[];
	/** Auxiliary (diagnostic-only) servers attached alongside the primary. */
	auxiliaryServerIds?: string[];
	auxiliarySourceMatch?: string;
	gitInit?: boolean;
	clean?: boolean;
	lombokJar?: boolean;
	expectNoMessageMatch?: string;
	/** A diagnostic message that MUST arrive. The lane's default verdict passes
	 * on zero diagnostics, which is backwards for a fixture whose purpose is to
	 * prove a defect is seen; setting this makes zero diagnostics a FAILURE. */
	expectMessageMatch?: string;
	disableServers?: string[];
	expectServerId?: string;
	expectSourceMatch?: string;
	/** Optional pre-touch setup step, run in the COPIED temp workspace (#530) — a
	 * string command (split on whitespace) or an argv array. Bounded by
	 * FIXTURE_SETUP_TIMEOUT_MS; failure reports a distinct `setup-failed`
	 * status, never a false pass. */
	setup?: string | string[];
	/** Optional expected `launchVariant` from the live capability snapshot
	 * (`getCapabilitySnapshots`), e.g. "native-ts7" (#526/#530). A mismatch —
	 * including a silent fallback to classic — is a FAILURE even when
	 * diagnostics arrived. */
	expectLaunchVariant?: string;
}
export interface FormatFixture {
	lang: string;
	dir: string;
	file: string;
	formatter: string;
	tools?: string[];
	/**
	 * "reformat" (default) — the formatter must rewrite the mis-formatted file.
	 * "preserve" — #1144's style-preserving refusal: the formatter is selected
	 * but must leave an unconfigured, style-less file byte-identical.
	 */
	expect?: "reformat" | "preserve";
}
export interface FormatResult {
	success: boolean;
	changed: boolean;
	error?: string;
	outcome: "formatted" | "unchanged" | "skipped" | "unavailable" | "failed";
}
export interface FormatRowVerdict {
	status: "pass" | "skip" | "fail";
	detail: string;
}
/** Classify one formatter result without running tools or touching files. */
export function classifyFormatRow(
	target: FormatResult,
	fx: FormatFixture,
): FormatRowVerdict;
export interface AutofixFixture {
	lang: string;
	dir: string;
	file: string;
	tool: string;
	tools?: string[];
}
/** One LSP diagnostic, as far as the harness's verdicts are concerned. */
export interface SmokeDiagnostic {
	message?: string;
	source?: string;
	severity?: number;
}
/**
 * Diagnostics whose `message` matches `pattern` (case-insensitive). Exported so
 * an `expectMessageMatch` fixture's pass/fail decision is testable without a
 * live language server.
 */
export function matchDiagnosticMessages(
	pattern: string,
	diags: readonly SmokeDiagnostic[] | undefined,
): SmokeDiagnostic[];
/** One reported row from a smoke lane, as far as the pass floor is concerned. */
export interface SmokeRow {
	state: "pass" | "fail" | "skip" | "setup-failed";
}
/**
 * The message for a run that passed fewer than `minPass` rows, or null when the
 * floor holds. Exported so the floor is testable without a live tool install.
 */
export function passFloorBreach(
	rows: readonly SmokeRow[],
	minPass: number | null | undefined,
): string | null;
/** Fixtures flagged `tier1` — the scheduled parser lane's selection. */
export function tier1Fixtures(): SmokeFixture[];
/** Resolve a smoke row's dispatch cwd inside its copied workspace. */
export function fixtureDispatchCwd(
	fixture: SmokeFixture,
	workspace: string,
): string;
/** Classify one real runner outcome for the tool-layer report. */
export function classify(outcome: unknown): {
	state: "pass" | "fail" | "skip";
	detail: string;
	diags: number;
};
/** Remove dead or old scratch workspaces from previous smoke runs. */
export function sweepLeftovers(): number;
/** One TOOLS registry entry, as far as this classification cares. */
export interface SmokeToolDefinition {
	installStrategy?: string;
}
/** The installer's own record of what its last install attempt for a tool did. */
export interface SmokeInstallAttempt {
	outcome: "succeeded" | "failed" | "declined" | "skipped";
	reason?: string;
}
export interface ClassifyInstallOutcomeDeps {
	getInstallAttempt: (toolId: string) => SmokeInstallAttempt | undefined;
	toolsById: ReadonlyMap<string, SmokeToolDefinition>;
	toolchainPresence: Record<string, boolean>;
	/** The pip command ladder to probe, in priority order (installer's own). */
	pipCandidates: readonly string[];
}
/**
 * Everything `classifyInstallOutcome` needs EXCEPT `getInstallAttempt`
 * (#2670): `resolveUnavailabilityRow` takes the attempt-snapshot `Map` as its
 * own positional parameter and derives `getInstallAttempt` from it
 * internally, so a caller has no `getInstallAttempt` key to (mis)assemble.
 */
export type ClassifyOutcomeRestDeps = Omit<
	ClassifyInstallOutcomeDeps,
	"getInstallAttempt"
>;
export interface InstallOutcomeRow {
	row: "fail" | "skip";
	detail: string;
}
/**
 * Classify why `toolId` never resolved via `ensureTool`, using the
 * installer's own attempt record (`getInstallAttempt`) — never the
 * `getInstallFailureReason` refusal map alone, which cannot answer whether an
 * install even ran (#2638/#2661). `{row: "fail"}` only for a genuine
 * installer defect: an attempt that actually ran and failed
 * (`outcome === "failed"`), not a transient network condition, on a strategy
 * whose toolchain this runner has (npm always; pip/gem when confirmed
 * present). Every other case is `{row: "skip"}`.
 */
export function classifyInstallOutcome(
	toolId: string,
	deps: ClassifyInstallOutcomeDeps,
): InstallOutcomeRow;
/**
 * Is this pip candidate command actually usable — `pip`/`pip3` via `--version`,
 * a python-family command via `-m pip --version` (#2661 round 2 R2-F2: a bare
 * `python3 --version` succeeds even with no `pip` module installed).
 */
export function pipCandidateUsable(command: string): boolean;
/**
 * The row a fixture's `ensureTool` step should report: the first GENUINE
 * install failure among `toolIds` (`classifyInstallOutcome`), or a "skip"
 * carrying `fallbackSkipDetail` when every unavailable tool in the list is
 * legitimately declined/skipped/toolchain-absent/transient.
 *
 * `attemptSnapshots` is the actual snapshot `Map` `ensureFixtureTools`
 * returned — not folded into `restDeps`, so a caller has no
 * `getInstallAttempt` key of its own to accidentally point at the live
 * module-global instead (#2670, the #2661 r3 verify's residual).
 */
export function resolveUnavailabilityRow(
	toolIds: readonly string[],
	unavailableTools: ReadonlySet<string>,
	attemptSnapshots: ReadonlyMap<string, SmokeInstallAttempt | undefined>,
	restDeps: ClassifyOutcomeRestDeps,
	fallbackSkipDetail: string,
): InstallOutcomeRow;
/**
 * Ensures every tool in `toolIds`, returning which never resolved and a
 * SNAPSHOT of each one's `getInstallAttempt` record taken the instant it was
 * found unavailable — never a live reference read later (#2661 round 2
 * R2-F3). `onEnsured`, when given, fires after each `ensureTool` call.
 */
export function ensureFixtureTools(
	toolIds: readonly string[],
	ensureTool: ((toolId: string) => Promise<string | undefined>) | undefined,
	getInstallAttempt:
		| ((toolId: string) => SmokeInstallAttempt | undefined)
		| undefined,
	onEnsured?: (toolId: string, resolved: string | undefined) => void,
): Promise<{
	unavailableTools: Set<string>;
	attemptSnapshots: Map<string, SmokeInstallAttempt | undefined>;
}>;
export const FIXTURES: SmokeFixture[];
export const LSP_FIXTURES: LspFixture[];
export const FORMAT_FIXTURES: FormatFixture[];
export const AUTOFIX_FIXTURES: AutofixFixture[];
