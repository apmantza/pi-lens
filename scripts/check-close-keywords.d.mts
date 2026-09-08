export declare const INVALID_CLOSE_KEYWORD_MESSAGE: string;
export declare function stripNonSemanticMarkdown(body?: string): string;
export declare function parseCloseKeywords(body?: string): {
	issues: number[];
	commaLists: number[];
	offendingLines: string[];
};
export declare function lintCloseKeywords(body?: string): {
	issues: number[];
	commaLists: number[];
	offendingLines: string[];
	valid: boolean;
};
export declare function lintCloseKeywordPlacement(
	title?: string,
	body?: string,
): {
	valid: boolean;
	titleIssues: number[];
	missingBodyIssues: number[];
};
export declare function closeKeywordPlacementMessage(missing: number[]): string;
export declare function lintPullRequest(
	fetchImpl?: typeof fetch,
	event?: {
		pull_request?: { number: number; body?: string | null };
	},
): Promise<void>;
export declare function verifyMergedPullRequest(
	fetchImpl?: typeof fetch,
	event?: { pull_request?: { number: number; body?: string | null } },
	getIssueState?: (repository: string, number: number) => string,
): Promise<void>;
