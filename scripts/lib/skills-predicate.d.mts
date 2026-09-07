// Type declarations for skills-predicate.mjs (untyped .mjs imported from
// .ts) — same pattern as scripts/lib/process-scan.d.mts.
//
// Two consumers: `scripts/install-selftest.mjs` and
// `clients/skills-resolver.ts` (the single extension-runtime point where
// #2626 reaches into scripts/ for this seam).

import type { Dirent } from "node:fs";

export function scanEntriesForSkills(
	dir: string,
	entries: Dirent[],
	isRoot: boolean,
): string[];

export function collectSkillEntryPaths(dir: string, isRoot?: boolean): string[];
