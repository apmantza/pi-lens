// The ONE structural replica of pi's own skill-loading walk (#2626 review
// round 2, F1/F2).
//
// Two independent detectors used to answer "does this directory tree hold a
// skill pi would load" with two DIFFERENT, hand-rolled heuristics that both
// diverged from pi's real resolver:
//   - `clients/skills-resolver.ts` (a `SKILL.md` one level down only, no
//     recursion, no root `.md` acceptance, no symlink-follow, no dot/
//     node_modules skip)
//   - `scripts/install-selftest.mjs`'s `countSkillFiles` (recursed
//     UNBOUNDED — would double-count a `SKILL.md` sitting inside another
//     skill's own resource subdirectory — with no dot/node_modules skip, no
//     root `.md` acceptance, no symlink handling)
// Neither matched `loadSkillsFromDirInternal` in
// `@earendil-works/pi-coding-agent` `dist/core/skills.js` (mirrored by
// `collectSkillEntries` in `dist/core/package-manager.js`, byte-identical
// walk, confirmed against the 0.85.1 tarball). This module is the fold: BOTH
// consumers now derive from `collectSkillEntryPaths` below.
//
// Discovery rules, replicated from `loadSkillsFromDirInternal` (verified
// against the extracted 0.85.1 `skills.js`):
//   1. If `dir` directly contains a (non-symlink-broken) `SKILL.md`, `dir` IS
//      one skill root — return immediately, do NOT look at `dir`'s other
//      entries or recurse into its subdirectories (a `SKILL.md` inside a
//      skill's own reference/ subfolder is the skill's OWN resource, not a
//      second skill).
//   2. Otherwise, skip dot-prefixed entries and `node_modules`; recurse into
//      every remaining subdirectory (same two rules, one level down); at the
//      OUTERMOST call only (`isRoot`), a loose `*.md` file directly in `dir`
//      also counts (pi's `includeRootFiles`, true only for the top call).
//   3. A symlink is followed via `statSync` (broken symlink = skip) for BOTH
//      the `SKILL.md` check and the directory/file classification in step 2.
//
// Deliberately NOT replicated (out of #2626's scope — packaging/path
// resolution, not skill-content validation):
//   - `.gitignore`/`.ignore`/`.fdignore` matching inside the skills tree.
//   - frontmatter parsing: pi additionally requires a non-empty `description`
//     field before a discovered file becomes a loaded skill. A `SKILL.md`
//     file that exists but fails THAT validation is a content-authoring
//     defect a maintainer would see in normal use, not a silent zero.
// Both gaps mean this predicate can be a bit more OPTIMISTIC than pi's true
// count in a pathological case (an ignored or description-less file still
// counts as "found" here); it is never more PESSIMISTIC — every real skill
// pi loads is found by this walk too — which is the direction #2626 cares
// about (never claim "no skills" when pi would load one).

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Symlink-aware entry classification, mirroring `loadSkillsFromDirInternal`'s
 * own `entry.isSymbolicLink() ? statSync(fullPath) : entry`.
 * @param {string} fullPath
 * @param {import("node:fs").Dirent} entry
 * @returns {"file" | "dir" | "other"}
 */
function resolvedEntryKind(fullPath, entry) {
	if (entry.isSymbolicLink()) {
		try {
			const stats = fs.statSync(fullPath);
			if (stats.isDirectory()) return "dir";
			if (stats.isFile()) return "file";
			return "other";
		} catch {
			return "other"; // broken symlink
		}
	}
	if (entry.isDirectory()) return "dir";
	if (entry.isFile()) return "file";
	return "other";
}

/**
 * The structural walk over an ALREADY-READ directory listing — split out
 * from `collectSkillEntryPaths` so a caller that already has `entries` (a
 * top-level ENOENT/EACCES distinction, say) is not forced into a second
 * `readdirSync`.
 * @param {string} dir
 * @param {import("node:fs").Dirent[]} entries
 * @param {boolean} isRoot
 * @returns {string[]} absolute paths of every `SKILL.md` (or, at the root,
 *   loose `.md`) file pi's own resolver would treat as a skill entry point.
 */
export function scanEntriesForSkills(dir, entries, isRoot) {
	for (const entry of entries) {
		if (
			entry.name === "SKILL.md" &&
			resolvedEntryKind(path.join(dir, entry.name), entry) === "file"
		) {
			return [path.join(dir, entry.name)];
		}
	}
	const found = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") {
			continue;
		}
		const fullPath = path.join(dir, entry.name);
		const kind = resolvedEntryKind(fullPath, entry);
		if (kind === "dir") {
			found.push(...collectSkillEntryPaths(fullPath, false));
			continue;
		}
		if (isRoot && kind === "file" && entry.name.endsWith(".md")) {
			found.push(fullPath);
		}
	}
	return found;
}

/**
 * Every skill entry point under `dir`, recursively, per pi's discovery
 * rules. Fail-closed: a `readdirSync` error at `dir` (absent, unreadable) or
 * any recursed-into subdirectory returns `[]` for that branch rather than
 * throwing — matching `loadSkillsFromDirInternal`'s own bare `try { … }
 * catch {}` per directory.
 * @param {string} dir
 * @param {boolean} [isRoot]
 * @returns {string[]}
 */
export function collectSkillEntryPaths(dir, isRoot = true) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return scanEntriesForSkills(dir, entries, isRoot);
}
