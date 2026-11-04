export interface TestRunnerRowResult {
	state: "pass" | "fail" | "skip" | "setup-failed";
	lang: string;
	runner: string;
	diags: number;
	detail: string;
}

export type Provisioned =
	| { state: "skip"; reason: string }
	| { state: "setup-failed"; reason: string }
	| { state: "ready"; testFile: string; version?: string };

export interface TestRunnerRow {
	id: string;
	runner: string;
	provision: (root: string) => Provisioned;
}

export const TEST_RUNNER_ROWS: ReadonlyArray<TestRunnerRow>;

export function hasBinary(bin: string, args?: string[]): boolean;

export function classifyPlantedFailure(result: {
	passed: number;
	failed: number;
	skipped: number;
	error?: string;
}): { state: "pass" | "fail"; diags: number; detail: string };

export function evaluateTestRunnerRow(
	rowDef: TestRunnerRow,
	deps: { root: string; client: unknown },
): Promise<TestRunnerRowResult>;
