// Type declarations for check-test-timeout-headroom.mjs (untyped .mjs imported
// from .ts tests). `runCli` is the entry the `if (isMainModule)` wrapper calls,
// so the test drives the same function CI's step runs.

/** 0 when the check measured, 1 with `--fail-on-new` on a new offender, 2 when it could not measure. */
export function runCli(
	argv: string[],
	options?: { log?: (line: string) => void },
): number;
