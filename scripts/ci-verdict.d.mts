export declare const REQUIRED_CHECKS: string[];
export declare const EXIT_SUCCESS: number;
export declare const EXIT_FAILURE: number;
export declare const EXIT_DIRTY: number;
export declare const EXIT_PENDING: number;
export declare const EXIT_USAGE: number;
export declare const EXIT_TRANSPORT: number;
export declare const POLL_INTERVAL_SECONDS: number;
export declare const HARD_CAP_SECONDS: number;
export declare const DEFAULT_GH_TIMEOUT_MS: number;
export declare const MIN_GH_TIMEOUT_MS: number;

export declare function isPrNumber(arg: unknown): boolean;

export interface VerdictRow {
	name: string;
	present: boolean;
	status: string | null;
	conclusion: string | null;
	url: string | null;
	gating: boolean;
}

export interface Verdict {
	exitCode: number;
	rows: VerdictRow[];
	reason: string;
	mergeState: string;
	truncated: boolean;
}

export declare function computeVerdict(
	checkRunsPayload:
		| { total_count?: number; check_runs?: unknown[] }
		| null
		| undefined,
	requiredChecks?: string[],
	mergeable?: string | null,
	classification?: string | null,
): Verdict;

export declare function formatVerdictTable(rows: VerdictRow[]): string;

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
	sleepImpl?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<{ verdict: Verdict; polls: number }>;

export type GhExec = (
	args: string[],
	options?: { timeoutMs?: number },
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

export declare const PROTECTED_BRANCH: string;

export declare function resolveRequiredCheckNames(
	repository: string,
	ghExec?: GhExec,
	timeoutMs?: number,
): string[] | null;

export declare function parseArgs(argv: string[]): {
	target: string | null;
	waitSeconds: number | null;
};

export declare function run(args?: {
	argv?: string[];
	ghExec?: GhExec;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
}): Promise<number>;
