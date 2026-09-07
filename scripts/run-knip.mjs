#!/usr/bin/env node
/**
 * scripts/run-knip.mjs (#2698, refs #2697 item 6).
 *
 * Wraps the `knip` binary with one mutation: delete gitignored compiled
 * `.js` files that sit beside a tracked `.ts` file of the same name, before
 * knip runs (scripts/lib/knip-sibling-purge.mjs), then spawns knip's real
 * bin entry directly (scripts/lib/knip-command.mjs). Orchestration
 * (including the fail-loud-on-purge-failure and skip-purge-on---help/
 * --version behavior) lives in scripts/lib/knip-runner.mjs, which is
 * unit-tested; this file is a 3-line invocation of it.
 *
 * Why the purge is required, not cosmetic: `npm run build` (tsc, no
 * `outDir`) writes `clients/x.js` beside every `clients/x.ts` — gitignored,
 * but present on disk after any build. Every source file imports its
 * siblings with an explicit `.js` specifier (nodenext `moduleResolution`).
 * knip's own resolver (packages/knip/src/util/resolve.ts's
 * `extensionAlias`, at the pinned 6.34.0 tag) tries the literal `.js`
 * candidate BEFORE the `.ts` source for a `.js` specifier, and its graph
 * walker does not gitignore-filter a resolved import target — so whenever a
 * build artifact sits on disk, knip's reachability graph walks into the
 * compiled `.js` copy and never returns to the `.ts` source. Measured on
 * this repo: 491 files reported "unused" with the siblings present, 0 with
 * them removed (see knip.jsonc's header comment and the PR body for the
 * full before/after). No knip config option overrides `extensionAlias`'s
 * resolution order, so the fix has to happen before knip's process starts.
 *
 * This script never rebuilds what it deletes — every deleted file is a
 * `tsc` build artifact `npm run build` recreates on the next build.
 */
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { runKnip } from "./lib/knip-runner.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.exitCode = runKnip(process.argv.slice(2), repoRoot);
