// Types for the (plain-JS) release-QA runner, so the TS unit test can hold its
// pure parts — matrix parsing, the outcome rules, the coverage arithmetic and
// the ship verdict — without spawning a real pi. Driving a real pi is the
// runner's own job and install-smoke's lane, never the unit suite's.

export interface BaselineRow {
	id: string;
	feature: string;
	modality: string;
	entryPoint: string;
	passCriterion: string;
	witness: string;
	reuse: string;
	umbrella: string;
}

export interface ParsedBaseline {
	rows: BaselineRow[];
	errors: string[];
}

export interface ProbeReport {
	status?: string;
	detail?: string;
}

export interface RowResult {
	id: string;
	outcome: string;
	detail: string;
	implemented?: boolean;
	witnessPath?: string;
	shows?: string;
}

export interface Coverage {
	discovered: number;
	rows: number;
	pass: number;
	fail: number;
	untested: number;
	skipped: number;
	balanced: boolean;
}

export interface Verdict {
	verdict:
		| "SHIP"
		| "SHIP-WITH-CAVEATS"
		| "DO-NOT-SHIP"
		| "BLOCKED"
		| "INCONCLUSIVE";
	reason: string;
	caveats: string[];
}

export interface RunnerOptions {
	pi: string;
	from: string;
	baseline: string;
	out: string;
	pollCapMs: number;
	gitRef?: string;
	keep: boolean;
}

export const BASELINE_TABLE_MARKER: string;
export const BASELINE_COLUMNS: readonly string[];
export const TOOL_SMOKE_INSTALL_ROW_ID: string;
export const PUBLISH_TOOLCHAIN_ROW_ID: string;
export const OUTCOME: {
	readonly PASS: "PASS";
	readonly FAIL: "FAIL";
	readonly UNTESTED: "UNTESTED";
	readonly SKIPPED: "SKIPPED";
};

export function parseBaselineRows(text: string): ParsedBaseline;
export function classifyRowOutcome(probe: ProbeReport | null | undefined): {
	outcome: string;
	detail: string;
};
export function classifyToolSmokeInstallReport(
	report: Record<string, unknown> | null,
	context?: Record<string, unknown>,
): {
	status: string;
	detail: string;
	shows: string;
	networkBlocked: boolean;
	witnessContent: string;
};
export function formatOutcome(result: {
	outcome: string;
	detail?: string;
}): string;
export function coverageArithmetic(
	results: ReadonlyArray<{ outcome: string; implemented?: boolean }>,
	discoveredCount?: number,
): Coverage;
export function renderCoverageLine(coverage: Coverage): string;
export function shipVerdict(
	results: ReadonlyArray<RowResult>,
	options?: {
		blocked?: boolean;
		blockedReason?: string;
		candidateFailure?: string;
		inconclusiveReason?: string;
	},
): Verdict;
export function runToolSmokeInstallProbe(ctx: {
	exportRoot: string;
	installedPkgDir: string;
	projectDir: string;
	env: NodeJS.ProcessEnv;
}): {
	status: string;
	detail: string;
	shows?: string;
	witness?: { ext: string; content: string };
};
/**
 * Whether a probe's SKIPPED row leaves its lane unmeasured (#2663) — the
 * registry-unreachable state that refuses the run's ship verdict — as opposed
 * to a plain reachability skip, which does not (#2940).
 */
export function isUnmeasured(
	probe: { status?: string; unmeasured?: boolean } | null | undefined,
): boolean;

/**
 * The publish job's toolchain → the release-QA row's verdict (#2940): the
 * pinned invocation must ANSWER as the pin, and its dry-run publish must
 * exit 0.
 */
export function classifyPublishToolchain(observed: {
	pin?: string;
	reportedVersion?: string;
	dryRunExitCode?: number;
	dryRunTail?: string;
}): { status: string; detail: string; shows: string };

/** Drive `release.yml`'s pinned npm over the exported candidate (#2940). */
export function runPublishToolchainProbe(ctx: {
	exportRoot: string;
	exportedCommit?: string;
	env: NodeJS.ProcessEnv;
}): {
	status: string;
	detail: string;
	shows?: string;
	unmeasured?: boolean;
	witness?: { ext: string; content: string };
};

/**
 * npm through the pinned `npx -y "npm@<pin>"` invocation `release.yml`
 * publishes with. `env` is optional in the TYPE and required at RUNTIME, for
 * the same reason {@link npm}'s is.
 */
export function pinnedNpm(
	pin: string,
	args: string[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
): string;

/**
 * The refusal message for a dirty checkout, or null when it is clean. A
 * `--from tree` run packs `git archive HEAD`, so an uncommitted edit would be
 * QA'd as its last commit — a usage error (exit 4), not a candidate failure.
 */
export function dirtyCheckoutRefusal(porcelain: string): string | null;

/** Which of the two non-row failures a run hit, if either. */
export function classifyRunFailure(observed: {
	bootProbeOk: boolean;
	bootProbeReason?: string;
	candidateError?: string;
	candidateRpcReason?: string;
}): { blocked: boolean; blockedReason: string; candidateFailure: string };

/** The skills row's verdict as a pure function of the get_commands response. */
export function classifySkillsRegistration(
	commands: ReadonlyArray<{
		source?: string;
		name?: string;
		sourceInfo?: { path?: string; source?: string };
	}>,
	installedPkgDir: string,
): { status: string; detail: string; shows: string };

/**
 * Hard Rule 1 as code: a PASS whose witness is absent OR empty is downgraded
 * to UNTESTED. The empty case is the reachable one — every shipped probe
 * attaches a witness object on its pass path (#2619 review N6).
 */
export function finalizeRowOutcome(
	classified: { outcome: string; detail: string },
	witnessPath: string | undefined,
	witnessContent?: string,
): { outcome: string; detail: string; downgraded?: boolean };

/** The report's witness-excerpt column: the downgrade reason, or the probe's. */
export function rowReportShows(
	classified: { detail: string; downgraded?: boolean },
	probeShows: string | undefined,
): string;

/** The install-selftest row's verdict from the packaged selftest's exit + stdout. */
export function classifySelftestOutput(
	code: number,
	stdout: string,
): { status: string; detail: string; shows: string };

/**
 * Shell-free `npm` under the pinned scratch env.
 *
 * `env` is optional in the TYPE and required at RUNTIME (it throws when
 * absent). Deliberate: the runner is plain `.mjs`, so tsc never checks its call
 * sites, and the guard that matters is the runtime one — which the unit suite
 * can only exercise by making the mistake on purpose.
 */
export function npm(
	args: string[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
): string;

/**
 * What to do with one baseline row before any probe runs: drive its probe, or
 * short-circuit it (no probe / blocked / candidate failure) without counting
 * it in the coverage triple's `rows`.
 */
export function rowProbeRequest(run: {
	hasProbe: boolean;
	blocked?: boolean;
	blockedReason?: string;
	candidateFailure?: string;
}): { attempted: boolean; probe?: { status: string; detail?: string } };

/**
 * Split `supply-host-provided-deps.mjs --install-args` output into argv
 * entries — newline-delimited, because a peer range may contain a space
 * (`^0.84.1 || ^0.85.0`, #2586).
 */
export function parseSupplyArgs(stdout: string): string[];

/**
 * The runner's exit-code contract.
 *
 * | code | verdict | meaning |
 * | --- | --- | --- |
 * | 0 | SHIP | every discovered row PASSED with a witness |
 * | 1 | DO-NOT-SHIP | a row FAILED, or the candidate would not install/activate |
 * | 2 | SHIP-WITH-CAVEATS | every witnessed row passed, some produced no witness |
 * | 3 | BLOCKED / INCONCLUSIVE | no verdict: pi did not boot, or nothing was witnessed |
 * | 4 | usage or self-check error | bad option, unparseable baseline, arithmetic mismatch |
 *
 * **2 is the EXPECTED verdict for a plain working-tree run** — `git-install`
 * is SKIPPED without `--git-ref`. A CI lane treats 2 as a warning, 1/3/4 as
 * failures.
 */
export function verdictExitCode(verdict: string): number;

/**
 * The pinned scratch environment every child process runs under. Its keys are
 * enumerated by `PINNED_ENV_KEYS`.
 */
export function scratchEnv(
	scratchRoot: string,
	extra?: Record<string, string>,
): NodeJS.ProcessEnv;

/** Every variable `scratchEnv` pins inside the scratch root. */
export const PINNED_ENV_KEYS: readonly string[];
export function renderReport(input: {
	rows: ReadonlyArray<BaselineRow>;
	results: ReadonlyArray<RowResult>;
	coverage: Coverage;
	verdict: Verdict;
	context?: Record<string, string>;
}): string;
export function pollToTerminal(
	attempt: () => Promise<{ terminal: boolean; detail: string }>,
	options: { capMs: number; intervalMs: number },
): Promise<{
	status: "terminal" | "expired";
	attempts: number;
	value: { terminal: boolean; detail: string };
	detail?: string;
}>;
export function parseArgs(argv: readonly string[]): RunnerOptions;
export function implementedRowIds(): string[];
