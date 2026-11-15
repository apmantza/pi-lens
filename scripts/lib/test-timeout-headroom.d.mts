// Type declarations for test-timeout-headroom.mjs (untyped .mjs imported from
// .ts tests). The rule lives in the .mjs; these types describe what the CLI and
// `tests/scripts/test-timeout-headroom.test.ts` read.

/** How a test's effective timeout was (or was not) resolved from its source. */
export type CapResolution =
	| { status: "resolved"; capMs: number; reason?: undefined }
	| { status: "unresolved"; capMs?: undefined; reason: string };

/** One judged assertion read out of a Vitest JSON report. */
export interface ReportRow {
	file: string;
	chain: string[];
	title: string;
	status: string;
	durationMs: number;
}

/** A row that passed the ratio, with the cap it was judged against. */
export interface HeadroomRow extends ReportRow {
	capStatus: "resolved" | "unresolved";
	capMs?: number;
	reason?: string;
	floorMs?: number;
	capLabel: string;
	ratio: number;
	id: string;
}

export interface AssessCounts {
	tests: number;
	undated: number;
	emitted: number;
	/** Emitted rows whose cap did not resolve; judged against the file floor. */
	floored: number;
	/** Every judged test with no resolved cap, emitted or not (#5311 r1 F4). */
	unresolved: number;
	byReason: Record<string, number>;
	maxRatio: number;
}

export interface BaselineEntry {
	file: string;
	test: string;
	capStatus: "resolved" | "unresolved";
	capMs?: number;
	reason?: string;
	durationMs: number;
}

export interface BaselineDocument {
	schema: number;
	generatedAt?: string;
	generatedFrom?: string;
	ratio?: number;
	scale?: number;
	entries: BaselineEntry[];
}

export interface Baseline {
	entries: Map<string, BaselineEntry>;
	missing: boolean;
	file?: string;
}

/**
 * One indexed source file. Its declarations, constants, imports and
 * `vi.setConfig` budgets are AST nodes, so the handle stays opaque here: pass
 * it to `resolveCap`, `fileDefaultMs`, or `fileFloorMs`.
 */
export interface FileTable {
	file: string;
	scale: number;
	[key: string]: unknown;
}

export const DEFAULT_TEST_TIMEOUT_MS: number;
export const HEADROOM_RATIO: number;
export const BASELINE_SCHEMA: number;
export const DEFAULT_BASELINE_RELATIVE: string;

export class TimeoutHeadroomError extends Error {}

export function indexTestFile(
	file: string,
	options?: {
		scale?: number;
		readFile?: (path: string) => string | null;
		tables?: Map<string, FileTable>;
	},
): FileTable;

export function resolveCap(
	table: FileTable,
	row: { chain: string[]; title: string },
): CapResolution;

export function fileDefaultMs(table: FileTable): {
	ms: number | undefined;
	reason: string;
};

export function fileFloorMs(table: FileTable): {
	ms: number | undefined;
	reason: string;
};

export interface ParsedReport {
	rows: ReportRow[];
	undated: number;
	/** Every identity the report carried per file, including the never-run ones. */
	reported: Map<string, Set<string>>;
}

export function parseTestReport(
	value: unknown,
	options?: { source?: string },
): ParsedReport;

export function rowId(row: {
	file: string;
	chain: string[];
	title: string;
	capLabel: string;
}): string;

export function capLabelOf(resolution: CapResolution): string;

export function assessReports(options: {
	reportValues: Array<{ value: unknown; source: string }>;
	root: string;
	ratio?: number;
	scale?: number;
	readFile?: (path: string) => string | null;
}): {
	rows: HeadroomRow[];
	counts: AssessCounts;
	reported: Map<string, Set<string>>;
};

export function loadBaseline(file: string): Baseline;

/** Baseline rows whose test is absent from a file the reports did carry. */
export function staleBaselineEntries(
	baseline: Baseline,
	reported: Map<string, Set<string>>,
): BaselineEntry[];

export function baselineEntries(
	value: unknown,
	source?: string,
): Map<string, BaselineEntry>;

export function buildBaselineDocument(options: {
	rows: HeadroomRow[];
	generatedFrom: string;
	ratio: number;
	scale: number;
}): BaselineDocument;

export function formatRow(row: HeadroomRow): string;

export function formatSummary(
	counts: AssessCounts,
	options: { known: number; added: number; ratio: number; scale: number },
): string;
