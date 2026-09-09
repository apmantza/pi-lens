export interface StrictnessResult {
	config: string;
	exitCode: number;
	total: number;
	counts: Record<string, number>;
}

export declare const REPORT_ROOTS: readonly string[];
export declare function parseDiagnostics(
	output: string,
	repoRoot: string,
): Record<string, number>;
export declare function runCheck(config: string, repoRoot?: string): StrictnessResult;
export declare function formatReport(summary: StrictnessResult[]): string;
export declare function main(argv?: string[]): void;
