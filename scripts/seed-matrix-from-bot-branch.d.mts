// Type declarations for seed-matrix-from-bot-branch.mjs (#3401).

export const BOT_BRANCH: string;
export const MATRIX_DOC: string;

export function decideMatrixSeed(facts: {
	masterBlob: string | null;
	botBlob: string | null;
	botBaseBlob: string | null;
}): { source: "bot" | "master"; reason: string };

export function seedMatrixFromBotBranch(deps?: {
	cwd?: string;
	git?: (args: string[], options: { cwd: string }) => string;
	writeFile?: (file: string, text: string) => void;
	log?: (line: string) => void;
}): { source: "bot" | "master"; reason: string };
