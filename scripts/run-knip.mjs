#!/usr/bin/env node
/**
 * scripts/run-knip.mjs (#2698, refs #2697 item 6).
 *
 * Wraps the `knip` binary with one mutation: delete gitignored compiled
 * `.js` files that sit beside a tracked `.ts` file of the same name, before
 * knip runs (scripts/lib/knip-sibling-purge.mjs).
 *
 * Why this is required, not cosmetic: `npm run build` (tsc, no `outDir`)
 * writes `clients/x.js` beside every `clients/x.ts` — gitignored, but
 * present on disk after any build. Every source file imports its siblings
 * with an explicit `.js` specifier (nodenext `moduleResolution`). knip's
 * own resolver (packages/knip/src/util/resolve.ts's `extensionAlias`, at
 * the pinned 6.34.0 tag) tries the literal `.js` candidate BEFORE the `.ts`
 * source for a `.js` specifier, and its graph walker does not gitignore-
 * filter a resolved import target — so whenever a build artifact sits on
 * disk, knip's reachability graph walks into the compiled `.js` copy and
 * never returns to the `.ts` source. Measured on this repo: 491 files
 * reported "unused" with the siblings present, 0 with them removed (see
 * knip.jsonc's header comment and the PR body for the full before/after).
 * No knip config option overrides `extensionAlias`'s resolution order, so
 * the fix has to happen before knip's process starts.
 *
 * This script never rebuilds what it deletes — every deleted file is a
 * `tsc` build artifact `npm run build` recreates on the next build, so a
 * subsequent `npm test` in the same working tree needs a fresh
 * `npm run build` (the CLAUDE.md non-negotiable already requires that
 * before any test run).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { purgeCompiledSiblings } from "./lib/knip-sibling-purge.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let purged;
try {
	purged = purgeCompiledSiblings(repoRoot);
} catch (err) {
	console.warn(
		`[run-knip] could not query git (${err.message}); skipping compiled-sibling cleanup — a built tree will likely report false "unused files".`,
	);
	purged = [];
}
console.log(
	`[run-knip] purged ${purged.length} compiled .js sibling(s) before analysis.`,
);

const knipBin = path.join(
	repoRoot,
	"node_modules",
	".bin",
	process.platform === "win32" ? "knip.cmd" : "knip",
);
const result = spawnSync(knipBin, process.argv.slice(2), {
	cwd: repoRoot,
	stdio: "inherit",
});

if (result.error) {
	console.error(`[run-knip] failed to start knip: ${result.error.message}`);
	process.exitCode = 1;
} else if (typeof result.status === "number") {
	process.exitCode = result.status;
} else {
	// Killed by a signal (e.g. SIGTERM from a CI timeout) — mirror the
	// non-zero-but-not-a-status-code shape other wrappers in this repo use.
	process.exitCode = 1;
}
