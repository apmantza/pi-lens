// Type declarations for promote-lsp-idle-eviction.mjs (#3989).

export function promoteFromSummary(opts: {
	summaryPath?: string;
	bodyPath?: string;
	changelogPath?: string;
	matrixPath: string;
	serverPath: string;
	reasonsPath: string;
	registryPath: string;
	rejectedPath?: string;
	today: string;
	runUrl?: string | null;
	log?: (line: string) => void;
}): string[];
