export declare const STICKY_MARKER: string;
export declare function renderMutationMarkdown(report: unknown): string;
export declare function renderStaleMarkdown(context?: {
	headSha?: string;
	runUrl?: string;
	upstreamResult?: string;
}): string;
export declare function formatTestSelection(selection: {
	pool: number;
	covering: number | null;
	kept: number;
	own?: number;
	unknown?: number;
}): string;
