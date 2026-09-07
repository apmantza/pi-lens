// Type declarations for knip-runner.mjs (untyped .mjs imported from .ts
// tests).

import type { SpawnSyncReturns } from "node:child_process";

export interface RunKnipDeps {
	purge?: (repoRoot: string, deps?: unknown) => string[];
	resolveCommand?: (
		extraArgs: string[],
		deps?: unknown,
	) => { command: string; args: string[] };
	spawn?: (
		command: string,
		args: string[],
		options: unknown,
	) => SpawnSyncReturns<string | Buffer>;
	log?: (message: string) => void;
	logError?: (message: string) => void;
	isCI?: boolean;
}

export function runKnip(
	argv: string[],
	repoRoot: string,
	deps?: RunKnipDeps,
): number;
