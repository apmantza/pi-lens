export declare const DEFAULT_DEADLINE_SECONDS: number;
export declare const DEFAULT_INTERVAL_SECONDS: number;
export declare function decideGate(
	checkRuns: Array<{
		name: string;
		status?: string | null;
		conclusion?: string | null;
	}>,
	required: string[],
): { state: "ready" | "wait" | "blocked"; detail: string };
export declare function waitForRequired(options: {
	fetchRuns: () => object[];
	required: string[];
	deadlineMs: number;
	intervalMs: number;
	now?: () => number;
	sleep?: (ms: number) => void;
}): { ready: boolean; reason: string };
export declare function parseArgs(argv: string[]): {
	repo: string;
	sha: string;
	required: string[];
	deadlineSeconds: number;
	intervalSeconds: number;
};
export declare function run(
	argv: string[],
	io?: {
		env?: NodeJS.ProcessEnv;
		fetchRuns?: (repo: string, sha: string) => object[];
		sleep?: (ms: number) => void;
		now?: () => number;
		log?: (line: string) => void;
	},
): number;
