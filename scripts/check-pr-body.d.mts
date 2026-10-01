export declare function detectFlattenedBody(body?: string): boolean;
export declare function blankCommentsAndStrings(source: string): {
	text: string;
	strings: Array<{
		start: number;
		end: number;
		quote: "'" | '"' | "`";
		text: string;
		prefix: string;
	}>;
};
export declare function repairFlattenedBody(body?: string): string;
export declare function detectEscapedNewlineBody(body?: string): boolean;
export declare function repairEscapedNewlineBody(body?: string): string;
export declare function splitMarkdownUnits(
	body?: string,
): Array<{ kind: string; text: string }>;
export declare function normalizePrBodyForChecking(
	body?: string,
	pullRequestNumber?: number,
): { body: string; normalized: boolean };
export declare function lintPrBody(
	body?: string,
	options?: {
		requireTestAssessment?: boolean;
		workingTree?: boolean;
		diff?: string;
		cwd?: string;
		git?: (args: string[], options?: Record<string, unknown>) => string;
		ref?: string;
		headFiles?: Map<string, string>;
		testCorpus?: { paths: Set<string>; titles: Set<string> };
	},
): {
	valid: boolean;
	errors: string[];
};
export declare function testCorpus(options?: {
	cwd?: string;
	workingTree?: boolean;
	git?: (args: string[], options?: Record<string, unknown>) => string;
}): { paths: Set<string>; titles: Set<string> };
export declare function localTouchesTests(
	cwd?: string,
	git?: (args: string[], options?: Record<string, unknown>) => string,
): boolean;
export declare function lintLocalPrBody(
	body: string,
	cwd?: string,
	git?: (args: string[], options?: Record<string, unknown>) => string,
	options?: { title?: string; ref?: string },
): { valid: boolean; errors: string[] };
export declare function lintTlaCoverage(
	body?: string,
	options?: { diff?: string; cwd?: string },
): { errors: string[]; advisories: string[] };
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
export declare function localDiff(
	cwd?: string,
	git?: (
		args: readonly string[],
		options: { cwd: string; encoding: "utf8" },
	) => string,
): string;
