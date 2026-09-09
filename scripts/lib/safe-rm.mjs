import * as fs from "node:fs";

/**
 * Best-effort recursive directory removal. On Windows a spawned LSP server
 * (or an installed tool's own child process) can still hold a handle inside
 * `dir` until ITS process exits, so an in-run `rmSync` can EPERM — never let
 * that abort the caller. A leftover dir is swept on the next run instead (see
 * each caller's own startup sweep — `sweepLeftovers` in `smoke-tools.mjs`,
 * `withScratchHome`'s scratch-home sweep in `lsp-fixture-workspace.mjs`).
 *
 * Extracted from `smoke-tools.mjs` (#2670 review F4): `bootstrapFixtureWorkspace`'s
 * `cleanup()` needs the identical retry-and-swallow shape, and `smoke-tools.mjs`
 * already imports FROM `lsp-fixture-workspace.mjs` (for `bootstrapFixtureWorkspace`/
 * `withScratchHome`), so the import direction is forced: this has to live in its
 * own leaf module rather than in either of theirs, or importing it back would
 * close a cycle.
 */
export function safeRm(dir) {
	try {
		fs.rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 200,
		});
	} catch {
		// leftover temp dir — swept at the next run's startup sweep
	}
}
