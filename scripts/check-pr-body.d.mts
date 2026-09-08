export declare function detectFlattenedBody(body?: string): boolean;
export declare function repairFlattenedBody(body?: string): string;
export declare function detectEscapedNewlineBody(body?: string): boolean;
export declare function repairEscapedNewlineBody(body?: string): string;
export declare function normalizePrBodyForChecking(
	body?: string,
	pullRequestNumber?: number,
): { body: string; normalized: boolean };
export declare function lintPrBody(
	body?: string,
	options?: { requireTestAssessment?: boolean },
): {
	valid: boolean;
	errors: string[];
};
export declare function fetchLivePrBody(
	payloadPr: { number: number; body?: string | null },
	fetchImpl: typeof fetch,
): Promise<{ body: string; normalized: boolean; title: string | undefined }>;
export declare function resolveLivePrBody(
	payloadPr: { number: number; body?: string | null },
	fetchImpl?: typeof fetch,
): Promise<{ body: string; normalized: boolean }>;
export declare function resolveTouchesTests(
	payloadPr: { number: number },
	fetchImpl?: typeof fetch,
): Promise<boolean | null>;
export declare function lintPullRequestEvent(
	fetchImpl?: typeof fetch,
	event?: { pull_request?: { number: number; body?: string | null } },
): Promise<{ valid: boolean; repaired: boolean }>;
