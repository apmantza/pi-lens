export declare const FILLER_PATTERNS: readonly string[];
export declare function checkProse(
	text?: string,
	options?: { mode?: "block" | "warn" },
): { valid: boolean; errors: string[]; warnings: string[] };
export declare function proseSections(body?: string): string;
