export interface MetricsWindow {
	label: string;
	since: string | null;
	until: string | null;
}

export interface MetricsRate {
	numerator: number;
	denominator: number;
	excluded: number;
	/** `null` when the denominator is 0: there is no rate. */
	rate: number | null;
}

export interface MetricsWindowReport {
	label: string;
	since: string | null;
	until: string | null;
	calls: {
		discovered: number;
		scanned: number;
		unscannable: number;
		unpaired: number;
		paired: number;
	};
	results: {
		listing: number;
		empty: number;
		error: number;
		unknown: number;
	};
	emptyRate: MetricsRate;
	listedReadRate: MetricsRate;
	repeatReadRate: MetricsRate;
	drilldownRate: MetricsRate;
	unscannableRate: MetricsRate;
	/** Inline file:/ext: searches that ended in an error (in `emptyRate`'s denominator). */
	scopedError: number;
	/** Searches scoped by paths or lang without file:/ext:; not a rate. */
	structuredScoped: { classified: number; empty: number; error: number };
	parseErrors: number;
}

export interface MetricsReport {
	corpus: string;
	generatedAt: string;
	parseErrors: number;
	files: { read: number; skipped: number };
	windows: MetricsWindowReport[];
}

export type StaticLiteral =
	| string
	| number
	| boolean
	| null
	| StaticLiteral[]
	| { [key: string]: StaticLiteral };

export declare const DEFAULT_CORPUS: string;
export declare function defaultWindows(now?: Date): MetricsWindow[];
export declare function parseArgs(argv: string[]): {
	corpus: string | undefined;
	since: string | undefined;
	until: string | undefined;
	json: boolean;
	help: boolean;
};
export declare function extractStaticObject(
	source: string,
): StaticLiteral | undefined;
export declare function findCodemodeSymbolSearchArgs(
	script: string,
): Array<{ unscannable: boolean; args?: StaticLiteral }>;
export declare function classifyResult(
	text: string,
	isError?: boolean,
): "listing" | "empty" | "error" | "unknown";
export declare function extractListedPaths(text: string): string[];
export declare function bashViewPaths(command: string): string[];
export declare function buildReport(
	corpusPath: string,
	windows: MetricsWindow[],
): MetricsReport;
export declare function formatSummary(report: MetricsReport): string;
export declare function main(argv?: string[]): number;
