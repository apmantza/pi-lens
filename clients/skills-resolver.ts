/**
 * Resolves the skills directory the `resources_discover` handler (#205)
 * registers, and reports the one condition that pi previously loaded with NO
 * visible signal: `<packageRoot>/skills` is absent, unreadable, or holds no
 * skill pi's own loader would find (#2626).
 *
 * `resolvePackagePath(import.meta.url, "skills")`-equivalent resolution
 * (`clients/package-root.ts`'s `getPackageRoot`) is correct for both the
 * source and compiled `dist/` layouts — it walks up from the loaded entry
 * file to the nearest `package.json`. It goes wrong silently, not loudly,
 * when that walk lands somewhere with no `skills/` beside it: `skills/`
 * missing from an installed package, or the entry file copied out of the
 * package tree by a managed extension cache so the nearest `package.json`
 * is the cache's own. Either way `resources_discover` used to hand pi a
 * path that does not exist, `pi` registered zero skills, and nothing — no
 * extension error, no stderr line — said so (investigated on #2587).
 *
 * #2626 review round 2, F1: the FIRST version of this fix inverted the
 * acceptance criterion — it returned `[]` (no skills registered) whenever
 * its own predicate disagreed with pi's real loader, which is worse than
 * the bug it fixed on every layout the predicate got wrong (dropping skills
 * pi WOULD have loaded, a regression vs. pre-fix `master`). The acceptance
 * criteria ask for a RECORD, never a changed return value: this module
 * returns `[skillsDir]` UNCONDITIONALLY, exactly like the pre-fix handler —
 * pi's own `loadSkills`/`collectSkillEntries` already treat a nonexistent
 * path as zero skills from that entry, gracefully, so handing it a path
 * that turns out to be empty is exactly as safe as `master`'s behavior
 * always was. The health check below is PURELY observational.
 *
 * #2636 review F4: the ENOENT/EACCES classification shell below used to be
 * hand-rolled here, character-identical to the ast-grep/tree-sitter sites
 * #2636 fixed for the same silent-zero shape — now shared via
 * `bundled-resource-health.ts`, with `scanEntriesForSkills` supplied as this
 * module's own "what counts as found" predicate.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import { scanEntriesForSkills } from "../scripts/lib/skills-predicate.mjs";
import {
	classifyBundledResourceDir,
	describeBundledResourceHealth,
	reportBundledResourceDirHealth,
	type BundledResourceHealth,
} from "./bundled-resource-health.js";
import { logLatency } from "./latency-logger.js";
import { getPackageRoot } from "./package-root.js";

/** The ledger kind this module records under (`clients/degradation-ledger.ts`). */
const SKILLS_DIR_MISSING_KIND = "skills-dir-missing";

/**
 * Read `skillsDir` and classify it, sharing `classifyBundledResourceDir`'s
 * ENOENT/EACCES/empty shell but counting pi-LOADABLE skill entry points
 * (`scanEntriesForSkills`), not a bare directory listing — a `skills/`
 * holding only a stray `.gitkeep` must read "empty", not "healthy".
 */
function checkSkillsHealth(skillsDir: string): BundledResourceHealth {
	return classifyBundledResourceDir(skillsDir, (dir) => {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		return scanEntriesForSkills(dir, entries, true).length;
	});
}

/**
 * Resolve the skill path for `resources_discover`. ALWAYS returns
 * `[skillsDir]` (see the module doc for why — F1). When `skillsDir` is
 * absent, unreadable, or holds no skill pi's loader would find, records ONE
 * bounded `skills-dir-missing` degradation and a single `notifyUserDegradation`
 * warning, both naming the resolved path and the entry file's directory.
 *
 * Either way, one `skills_resolved` phase/latency record is written so an
 * empty ledger (no `skills-dir-missing` row) is distinguishable from
 * "`resources_discover` never ran at all" (#2626 review F5) — the SAME
 * silent-zero shape one level up the call stack.
 */
export function resolveSkillPaths(importMetaUrl: string): string[] {
	const packageRoot = getPackageRoot(importMetaUrl);
	const skillsDir = path.join(packageRoot, "skills");
	const health = checkSkillsHealth(skillsDir);

	logLatency({
		type: "phase",
		phase: "skills_resolved",
		filePath: skillsDir,
		durationMs: 0,
		metadata: {
			status: health.status,
			entryCount: health.status === "healthy" ? health.entryCount : 0,
		},
	});

	if (health.status !== "healthy") {
		const entryDir = path.dirname(fileURLToPath(importMetaUrl));
		const reason = `${describeBundledResourceHealth(
			health,
			skillsDir,
			`no SKILL.md (or loadable .md) found under ${skillsDir}`,
		)} (entry loaded from ${entryDir})`;
		// #2626 review F3: the notify-once gate previously re-derived "have we
		// already recorded this" by scanning `getDegradationSummary()` and
		// comparing the RAW `skillsDir` against subjects the ledger stores
		// `truncateForLedger`-ed — a mismatch on any subject over
		// `LEDGER_FIELD_MAX` (200 chars, an ordinary length for a managed-cache
		// path) renotified on every call. `reportBundledResourceDirHealth`
		// reads `incrementDegradationCount`'s own return value for the rising
		// edge, computed after the SAME truncation the ledger stores by, so
		// there is no separate key to keep in sync.
		// #2636 review round 2, F1: the shipped notify sentence ("registers
		// zero skills") is user-visible product text #2626 chose deliberately
		// — it names the exact SYMPTOM this whole issue exists to surface, so
		// the shared helper's generic "<label> unavailable" template must
		// never silently replace it. Passed explicitly rather than inferred
		// from `label` so this stays a per-caller decision, not a convention
		// the next caller has to remember.
		reportBundledResourceDirHealth(
			SKILLS_DIR_MISSING_KIND,
			skillsDir,
			health,
			"skills",
			reason,
			`pi-lens: registers zero skills — ${reason}.`,
		);
	}

	return [skillsDir];
}
