export declare const REQUIRED_CHECKS: string[];
export declare const EXIT_SUCCESS: number;
export declare const EXIT_FAILURE: number;
export declare const EXIT_DIRTY: number;
export declare const EXIT_PENDING: number;
export declare const EXIT_USAGE: number;
export declare const EXIT_TRANSPORT: number;
export declare function formatExitLine(result: {
	code: number;
	kind: string;
}): string;
export declare function transportExit(): { code: number; kind: string };
export declare function crashExit(): { code: number; kind: string };
export declare const ABSENT_REQUIRED_REARM_MINUTES: number;
export declare function formatAbsentRequiredReason(
	sha: string,
	minutes?: number,
): string;
export declare function formatAbsentRunReason(args: {
	state: string;
	id: number | null;
	ageMinutes: number | null;
	sha: string;
}): string;
export declare function formatAbsentRunUnknownReason(
	sha: string,
	minutes?: number,
): string;
export declare function formatForkApprovalReason(
	repository: string,
	runs: { id: number }[],
): string;
export declare const POLL_INTERVAL_SECONDS: number;
export declare const HARD_CAP_SECONDS: number;
export declare const DEFAULT_GH_TIMEOUT_MS: number;
export declare const MIN_GH_TIMEOUT_MS: number;
export declare const TRANSIENT_BACKOFF_INITIAL_SECONDS: number;
export declare const TRANSIENT_BACKOFF_MAX_SECONDS: number;

export declare function isTransientGhError(error: unknown): boolean;

export declare function isGhMissingError(error: unknown): boolean;

export declare function resolveGithubToken(
	env?: Record<string, string | undefined>,
): string | null;

export declare function resolveGithubApiBase(
	env?: Record<string, string | undefined>,
): string;

export declare function isPrNumber(arg: unknown): boolean;

export interface VerdictRow {
	name: string;
	present: boolean;
	id: number | null;
	status: string | null;
	conclusion: string | null;
	url: string | null;
	detailsUrl?: string | null;
	gating: boolean;
}

export interface FailedJobDetail {
	name: string;
	rowId: number | null;
	jobId: string | null;
	steps: string[];
	failures: string[];
	extraFailures: number;
	summary: string[];
	mergeBase: string | null;
	missingMergeRefPr: string | null;
	note: string | null;
}

export interface AbsentContext {
	repository: string;
	sha: string;
	actionRequiredRuns: { id: number }[];
	autoMerge: boolean;
	absentMinutes: number | null;
	headRun?: {
		state: string;
		id: number | null;
		ageMinutes: number | null;
	} | null;
}

export interface MergeQueueEntry {
	state: string | null;
	position: number | null;
}

export interface QueueContext {
	entry?: MergeQueueEntry;
	failedRuns?: { id: number; url: string }[];
	failedRows?: VerdictRow[];
}

export interface Verdict {
	exitCode: number;
	rows: VerdictRow[];
	reason: string;
	mergeState: string;
	kind: string;
	failingRows: VerdictRow[];
	cancelledRows: VerdictRow[];
	details?: FailedJobDetail[];
	hints?: string[];
}

export declare function computeVerdict(
	checkRunsPayload:
		| { total_count?: number; check_runs?: unknown[] }
		| null
		| undefined,
	requiredChecks?: string[],
	mergeable?: string | null,
	classification?: string | null,
	rerunState?: {
		originalFailed: boolean;
		latestAttempt: {
			status: string | null;
			conclusion: string | null;
			run_attempt: number;
		} | null;
	} | null,
	absentContext?: AbsentContext | (() => AbsentContext | null) | null,
	noiseRowIds?: Set<number | null> | null,
	queueContext?: QueueContext | (() => QueueContext | null) | null,
): Verdict;

export declare function formatVerdictTable(rows: VerdictRow[]): string;

export declare function rerunArgsFor(row: {
	detailsUrl?: string | null;
	id?: number | null;
}): string[] | null;

export declare function formatRerunHint(row: {
	name?: string;
	details_url?: string;
}): string;

export declare function resolveWaitCapSeconds(
	waitSecondsArg: number | null,
): number;

export declare function resolveGhTimeoutMs(
	remainingMs: number | null | undefined,
): number;

export declare function pollVerdict(args: {
	fetchPayload: (
		remainingMs?: number,
	) => Promise<
		{ total_count?: number; check_runs?: unknown[] } | null | undefined
	>;
	waitSeconds: number | null;
	mergeable?: string | null;
	requiredChecks?: string[];
	classification?: string | null;
	rerunState?:
		| {
				originalFailed: boolean;
				latestAttempt: {
					status: string | null;
					conclusion: string | null;
					run_attempt: number;
				} | null;
		  }
		| (() => {
				originalFailed: boolean;
				latestAttempt: {
					status: string | null;
					conclusion: string | null;
					run_attempt: number;
				} | null;
		  })
		| null;
	absentContext?: AbsentContext | (() => AbsentContext | null) | null;
	queueContext?: QueueContext | (() => QueueContext | null) | null;
	sleepImpl?: (ms: number) => Promise<void>;
	now?: () => number;
	onRetry?: (line: string) => void;
}): Promise<{ verdict: Verdict; polls: number }>;

export type GhExec = (
	args: string[],
	options?: { timeoutMs?: number; maxBuffer?: number },
) => string;

export declare function resolveRepository(
	ghExec?: GhExec,
	timeoutMs?: number,
): string;

export declare function resolveHeadSha(
	target: string,
	ghExec?: GhExec,
	timeoutMs?: number,
): { sha: string; mergeable: string | null };

export declare function resolveClassification(
	target: string,
	ghExec?: GhExec,
	timeoutMs?: number,
): string | null;

export declare function fetchCheckRunsPayload(
	repository: string,
	sha: string,
	ghExec?: GhExec,
	timeoutMs?: number,
): { total_count?: number; check_runs?: unknown[] };

export declare function fetchActionRequiredRuns(
	repository: string,
	sha: string,
	ghExec?: GhExec,
	timeoutMs?: number,
	failOpen?: boolean,
): { id: number }[];

export declare function fetchHeadRuns(
	repository: string,
	sha: string,
	ghExec?: GhExec,
	timeoutMs?: number,
	failOpen?: boolean,
): {
	actionRequiredRuns: { id: number }[];
	headRun: {
		state: string;
		id: number | null;
		startedAtMs: number | null;
	};
};

export declare function fetchAutoMergeAge(
	target: string | number,
	repository: string,
	sha: string,
	ghExec?: GhExec,
	timeoutMs?: number,
	knownPushedMs?: number | null,
): { autoMerge: boolean; pushedMs: number | null };

export declare function readMergeQueueState(
	target: string | number,
	repository: string,
	ghExec?: GhExec,
	timeoutMs?: number,
): { enabled: boolean; entry: MergeQueueEntry | null } | null;

export declare function fetchFailedQueueRuns(
	target: string | number,
	repository: string,
	pushedMs: number | null,
	ghExec?: GhExec,
	timeoutMs?: number,
): { failedRuns: { id: number; url: string }[]; failedRows: VerdictRow[] };

export declare function fetchRerunState(
	repository: string,
	sha: string,
	ghExec?: GhExec,
	timeoutMs?: number,
): {
	originalFailed: boolean;
	latestAttempt: {
		status: string | null;
		conclusion: string | null;
		run_attempt: number;
	} | null;
} | null;

export declare const PROTECTED_BRANCH: string;

export declare function extractRequiredCheckNames(
	requiredStatusChecks: unknown,
): string[] | null;

export declare function resolveRequiredCheckNames(
	repository: string,
	ghExec?: GhExec,
	timeoutMs?: number,
): string[] | null;

export declare const TRANSPORT_GH: string;
export declare const TRANSPORT_REST: string;

export declare function parseOwnerRepoFromGitRemote(
	remoteUrl: unknown,
): string | null;

export type GitExec = (
	command: string,
	args: string[],
	options?: Record<string, unknown>,
) => string;

export declare function resolveRepositoryViaGit(
	execFileSyncImpl?: GitExec,
): string;

export declare function mapRestMergeableState(
	pullRequest:
		| { mergeable?: boolean | null; mergeable_state?: string | null }
		| null
		| undefined,
): string;

// Narrower than `typeof fetch` (mirrors `scripts/lib/stale-open-issues.d.mts`'s
// own `fetcher` type) so a test double only needs to satisfy the three
// members `restGet` actually reads, not the full `Response` interface.
export type RestFetch = (
	url: string,
	init?: RequestInit,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type RestOptions = {
	token?: string | null;
	fetchImpl?: RestFetch;
	timeoutMs?: number;
	apiBase?: string;
};

export declare function restResolveHeadSha(
	repository: string,
	target: string,
	options?: RestOptions,
): Promise<{ sha: string | undefined; mergeable: string | null }>;

export declare function restFetchCheckRunsPayload(
	repository: string,
	sha: string,
	options?: RestOptions,
): Promise<{ total_count?: number; check_runs?: unknown[] }>;

export declare function restResolveRequiredCheckNames(
	repository: string,
	options?: RestOptions,
): Promise<string[] | null>;

export declare function resolveTransport(
	usesDefaultGhExec: boolean,
	token: string | null,
	probe?: () => boolean,
): string;

export declare function nodeSupportsUseEnvProxy(
	versionString?: string | null,
): boolean;

export declare const REEXEC_RUN: string;
export declare const REEXEC_REEXEC: string;
export declare const REEXEC_VERSION_TOO_OLD: string;

export declare function resolveReexecPlan(options: {
	usesRestTransport: boolean;
	proxyUrl: string | null;
	envProxyFlagAlreadySet: boolean;
	nodeVersion?: string;
}): string;

export declare function formatVersionTooOldMessage(
	nodeVersion?: string,
): string;

export declare function parseArgs(argv: string[]): {
	target: string | null;
	waitSeconds: number | null;
	all: boolean;
	watchOpen: boolean;
	stateFile: string | null;
	stream: boolean;
	rerunCancelled: boolean;
	syncMain: string | null;
	approveFork: string | null;
};

export declare function run(args?: {
	argv?: string[];
	ghExec?: GhExec;
	gitExec?: GitExec;
	fetchImpl?: RestFetch;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	sleepImpl?: (ms: number) => Promise<void>;
	now?: () => number;
	onVerdict?: (info: {
		repository: string;
		sha: string;
		verdict: Verdict;
	}) => void;
}): Promise<{ code: number; kind: string }>;

export declare function callWithTransientRetry<T>(
	call: (remainingMs: number | undefined) => T | Promise<T>,
	options?: {
		deadline?: number;
		now?: () => number;
		sleepImpl?: (ms: number) => Promise<void>;
		onRetry?: (line: string) => void;
	},
): Promise<T>;

export declare const MAX_FAILURE_LINES: number;
export declare const JOB_LOG_MAX_BUFFER: number;
export declare const WATCH_POLL_INTERVAL_SECONDS: number;
export declare const RERUN_MAX_ATTEMPTS: number;
export declare const RERUN_BACKOFF_SECONDS: number;

export declare function parseJobLog(logText: unknown): {
	failures: string[];
	extraFailures: number;
	summary: string[];
	mergeBase: string | null;
	missingMergeRefPr: string | null;
};

export declare function readFailedJob(
	repository: string,
	row: VerdictRow,
	ghExec?: GhExec,
	timeoutMs?: number,
): FailedJobDetail;

export declare function readFailureDetails(args: {
	rows: VerdictRow[];
	target: string;
	repository: string;
	ghExec?: GhExec;
	timeoutMs?: number;
}): {
	details: FailedJobDetail[];
	hints: string[];
	noiseRowIds: Set<number | null> | null;
};

export declare function formatFailureLines(
	verdict: Pick<Verdict, "details" | "hints">,
): string[];

export declare function formatGatingSplit(
	rows: VerdictRow[],
	failingRows?: VerdictRow[],
): string[];

export declare function formatMutationLine(
	comments: Array<{ id: number; body?: string; user?: { login?: string } }>,
	prHead: string,
	rows?: Array<{
		name: string;
		status: string | null;
		conclusion?: string | null;
	}>,
): string;

export declare function readMutationLine(options: {
	repository: string;
	target: string | number;
	sha: string;
	rows?: Array<{
		name: string;
		status: string | null;
		conclusion?: string | null;
	}>;
	ghExec?: (args: string[], options?: Record<string, unknown>) => string;
	timeoutMs?: number;
}): string;

export interface OpenPr {
	number: number;
	author?: { login?: string } | null;
	headRefOid?: string;
	autoMergeRequest?: unknown;
}

export declare function readOpenPrs(
	ghExec?: GhExec,
	timeoutMs?: number,
): OpenPr[];

export declare function snapshotOpenPrs(args: {
	ghExec?: GhExec;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	sleepImpl?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<number>;

export declare function syncMainCheckout(
	checkout: string,
	gitExec?: GitExec,
): string[];

export declare function approveForkRuns(args: {
	target: string;
	ghExec?: GhExec;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
}): Promise<number>;

export declare function watchOpenPrs(args: {
	ghExec?: GhExec;
	gitExec?: GitExec;
	stream?: boolean;
	rerunCancelled?: boolean;
	syncMain?: string | null;
	waitSeconds?: number | null;
	stateFile?: string | null;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	sleepImpl?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<number>;
