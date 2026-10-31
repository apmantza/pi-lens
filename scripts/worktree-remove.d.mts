// Type declarations for scripts/worktree-remove.mjs (untyped .mjs imported from
// .ts tests). Only the exported seams are declared; the CLI body is not
// importable surface.

export function run(options?: {
	argv?: string[];
	cwd?: string;
	gitExec?: (args: string[], options?: { cwd?: string }) => string;
	stdout?: (message: string) => void;
	stderr?: (message: string) => void;
}): number;

export function main(): void;
