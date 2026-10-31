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
		workingTree?: boolean;
		diff?: string;
		cwd?: string;
		git?: (args: string[], options?: Record<string, unknown>) => string;
		ref?: string;
		headFiles?: Map<string, string>;
		testCorpus?: { paths: Set<string>; titles: Set<string> };
		proseMode?: "block" | "warn";
		bugClosing?: boolean;
		existsOnBase?: (path: string) => boolean | null;
		shapeCatalog?: () => Map<number, string> | null;
		/** PR title; a `refactor(...)` title requires "## Behavior equivalence". */
		title?: string;
	},
): {
	valid: boolean;
	errors: string[];
};
export declare function lintClassSweep(
	body?: string,
	options?: { diff?: string },
): string[];
export declare function lintFoldCheck(
	body?: string,
	fullBody?: string,
): string[];
export declare const DETECTION_LAYERS: readonly string[];
export declare const DETECTION_MESSAGE: string;
export declare const DETECTION_UNKNOWN_MESSAGE: string;
export declare function lintDetectionSection(
	body?: string,
	options?: {
		ignoreUnfilled?: boolean;
		requireShape?: boolean;
		existsOnBase?: (path: string) => boolean | null;
		shapeCatalog?: () => Map<number, string> | null;
	},
): string[];
export declare const detectionExistsNotOnBaseMessage: (path: string) => string;
export declare const DETECTION_EXISTS_BASE_UNRESOLVED_MESSAGE: string;
export declare const DETECTION_SHAPE_CATALOG_UNRESOLVED_MESSAGE: string;
export declare const detectionUnknownShapeMessage: (number: number) => string;
export declare const detectionEnforcerNotOnBaseMessage: (
	path: string,
) => string;
export declare const detectionEnforcerNotInCatalogMessage: (
	path: string,
	number: number,
) => string;
export declare function shapeCatalogReader(
	cwd?: string,
	git?: (args: string[], options?: Record<string, unknown>) => string,
): () => Map<number, string> | null;
export declare function resolvePrBase(
	cwd?: string,
	git?: (args: string[], options?: Record<string, unknown>) => string,
): string | null;
export declare function baseFileReader(
	cwd?: string,
	git?: (args: string[], options?: Record<string, unknown>) => string,
): (path: string) => boolean | null;
export declare function resolveBugClosing(
	body: string,
	fetchImpl?: typeof fetch,
): Promise<boolean | null>;
export declare function resolveBugClosingViaGh(
	body: string,
	cwd?: string,
	exec?: (
		file: string,
		args: string[],
		options: Record<string, unknown>,
	) => string,
): Promise<boolean | null>;
export declare function resolveBugReferenced(
	fullBody: string,
	fetchImpl?: typeof fetch,
	title?: string,
): Promise<boolean | null>;
export declare function resolveBugReferencedViaGh(
	fullBody: string,
	cwd?: string,
	exec?: (
		file: string,
		args: string[],
		options: Record<string, unknown>,
	) => string,
	title?: string,
): Promise<boolean | null>;
export declare function referencedIssues(body?: string): {
	issues: number[];
	unrecognised: string[];
};
export declare function lintReferencedBugLabels(
	fullBody: string,
	resolved: boolean | null,
	title?: string,
	options?: { skipUnreadableLabels?: boolean },
): string[];
export declare function testCorpus(options?: {
	cwd?: string;
	workingTree?: boolean;
	git?: (args: string[], options?: Record<string, unknown>) => string;
}): { paths: Set<string>; titles: Set<string> };
export declare function lintLocalPrBody(
	body: string,
	cwd?: string,
	git?: (args: string[], options?: Record<string, unknown>) => string,
	options?: {
		title?: string;
		ref?: string;
		headFiles?: Map<string, string>;
		proseMode?: "block" | "warn";
		bugClosing?: boolean | null;
		resolveBugClosing?: (body: string) => boolean | null;
		bugReferenced?: boolean | null;
		resolveBugReferenced?: (body: string, title?: string) => boolean | null;
	},
): { valid: boolean; errors: string[] };
export declare function parseRuntimeHunks(diff: string): Array<{
	pre: string;
	post: string;
	postBlob: string | null;
	postLine: number;
	added: Map<number, string>;
	deletedAfter: Set<number>;
	removed: string[];
}>;
export declare function lintTlaCoverage(
	body?: string,
	options?: {
		diff?: string;
		cwd?: string;
		sourceCwd?: string;
		headFiles?: Map<string, string>;
		git?: (args: string[], options?: Record<string, unknown>) => string;
	},
): { errors: string[]; advisories: string[] };
export declare function lintWorkflowRunEvidence(
	body?: string,
	options?: {
		diff?: string;
		cwd?: string;
		repository?: string;
		git?: (args: string[], options?: Record<string, unknown>) => string;
	},
): string[];
export declare function fetchLivePrBody(
	payloadPr: { number: number; body?: string | null },
	fetchImpl: typeof fetch,
): Promise<{ body: string; normalized: boolean; title: string | undefined }>;
export declare function resolveLivePrBody(
	payloadPr: { number: number; body?: string | null },
	fetchImpl?: typeof fetch,
): Promise<{ body: string; normalized: boolean }>;
export declare function lintPullRequestEvent(
	fetchImpl?: typeof fetch,
	event?: {
		pull_request?: { number: number; body?: string | null; title?: string };
	},
	diffImpl?: () => string,
): Promise<{ valid: boolean; repaired: boolean }>;
export declare function localDiff(
	cwd?: string,
	git?: (
		args: readonly string[],
		options: { cwd: string; encoding: "utf8" },
	) => string,
): string;
