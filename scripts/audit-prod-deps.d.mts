export const ATTEMPTS: number;
export const ATTEMPT_TIMEOUT_MS: number;
export const BACKOFF_MS: number[];
export function decideAudit(run: {
	code: number | null;
	stdout: string;
	timedOut: boolean;
}):
	| { kind: "clean" }
	| { kind: "vulnerable"; summary: string }
	| { kind: "transport"; reason: string };
export function main(): Promise<number>;
