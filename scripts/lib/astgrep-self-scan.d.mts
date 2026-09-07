export function repoRoot(): string;
export function rulesDir(root?: string): string;

export function selfScanRuleIds(root?: string): string[];

export interface SelfScanFinding {
	ruleId?: string;
	file?: string;
	range?: { start?: { line?: number } };
	[key: string]: unknown;
}

export interface SelfScanResult {
	ruleIds: string[];
	findings: SelfScanFinding[];
	scannedFileCount: number | undefined;
	effectiveRuleCount: number | undefined;
	stderr: string;
}

export function runSelfScan(options?: {
	root?: string;
	scanPaths?: string[];
	ruleIds?: string[];
	sgConfigPath?: string;
}): SelfScanResult;

export function findingSignature(finding: SelfScanFinding): string;

export function loadBaseline(root?: string): Set<string>;

export function writeBaseline(
	signatures: Iterable<string>,
	root?: string,
): string;
