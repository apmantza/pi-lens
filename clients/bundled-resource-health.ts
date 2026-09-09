/**
 * Shared health classification + degradation reporting for a bundled
 * resource directory read DIRECTLY by pi-lens (never handed to an external
 * spawned tool as a `--config`/`--rule-dir` argument — that class already
 * fails loudly through the tool's own spawn-failure path).
 *
 * #2626 fixed this shape for `clients/skills-resolver.ts`'s `skills/`
 * directory: `resolvePackagePath(import.meta.url, …)` walks up from the
 * loaded entry file to the nearest `package.json`, which is correct for both
 * the source and compiled `dist/` layouts, but goes wrong SILENTLY, not
 * loudly, when that walk lands somewhere with no resource dir beside it —
 * the bundled dir missing from an installed package, or the entry file
 * copied out of the package tree by a managed extension cache so the
 * nearest `package.json` is the cache's own. #2636 is the class sweep:
 * `clients/ast-grep-client.ts`'s `rules` fallback and the bundled
 * tree-sitter-queries root (read identically by `clients/cache/rule-cache.ts`
 * and `clients/tree-sitter-query-loader.ts`) have the exact same gap.
 *
 * Both callers reuse this ONE classify+report pair rather than each
 * hand-rolling the ENOENT/EACCES distinction (#2626 review F4) a second and
 * third time.
 */

import * as fs from "node:fs";
import {
	incrementDegradationCount,
	type DegradationKind,
} from "./degradation-ledger.js";
import { notifyUserDegradation } from "./user-notify.js";

export type BundledResourceHealth =
	| { status: "healthy"; entryCount: number }
	| { status: "absent" }
	| { status: "unreadable"; fsErrorCode: string }
	| { status: "empty" };

/**
 * Classify `dir`: does it exist, is it readable, and does it hold anything?
 * Fail-closed and never throws. Distinguishes `ENOENT` (the common
 * managed-cache-relocation case) from any OTHER `readdirSync` error
 * (`EACCES` and friends) — an unreadable directory might genuinely hold a
 * real resource pi-lens simply cannot read, so the honest report is "cannot
 * read it", never "nothing is there" (#2626 review F4).
 *
 * `countEntries` lets a caller supply its OWN notion of "found" — e.g.
 * `skills-resolver.ts` counts pi-loadable skill entry points via
 * `scanEntriesForSkills`, not a bare directory listing — while still sharing
 * this function's ENOENT/EACCES/empty classification shell (#2636 review F4:
 * that shell was duplicated character-for-character between the two modules
 * before this parameter existed). The default counts plain directory
 * entries, which is what every OTHER caller (ast-grep's rules dir, the
 * bundled tree-sitter-queries root) actually wants.
 */
export function classifyBundledResourceDir(
	dir: string,
	countEntries: (dir: string) => number = (d) => fs.readdirSync(d).length,
): BundledResourceHealth {
	let entryCount: number;
	try {
		entryCount = countEntries(dir);
	} catch (error) {
		const fsErrorCode = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
		if (fsErrorCode === "ENOENT") return { status: "absent" };
		return { status: "unreadable", fsErrorCode };
	}
	return entryCount > 0
		? { status: "healthy", entryCount }
		: { status: "empty" };
}

/**
 * Render `health` as a reason string. `emptyDescription` lets a caller name
 * what "nothing found" actually means for its own resource (skills' loader
 * cares about `SKILL.md`, not bare directory entries); every other status's
 * prose is shared verbatim, since ENOENT/EACCES mean the exact same thing
 * regardless of which resource directory hit them.
 */
export function describeBundledResourceHealth(
	health: BundledResourceHealth,
	dir: string,
	emptyDescription = `${dir} exists but holds nothing`,
): string {
	switch (health.status) {
		case "absent":
			return `no such directory: ${dir}`;
		case "unreadable":
			return `cannot read ${dir} (${health.fsErrorCode})`;
		case "empty":
			return emptyDescription;
		default:
			// unreachable for the "healthy" case — callers only report unhealthy ones.
			return `${dir}: unexpected health status`;
	}
}

/**
 * Record ONE bounded `kind` degradation plus one `notifyUserDegradation`
 * warning per (kind, dir) per session, when `health` is not healthy.
 * Pure no-op when healthy. `incrementDegradationCount`'s own return value
 * (not a hand-rolled Set) gates the notify to the rising edge, so a caller
 * invoked on every dispatch (e.g. `RuleCache`'s constructor) can call this
 * unconditionally without spamming the notify surface.
 *
 * `reasonOverride` lets a caller build a richer reason (skills-resolver.ts
 * appends the entry file's directory) while still sharing the
 * increment/notify mechanics below; the default is this module's own
 * `describeBundledResourceHealth`.
 *
 * `notifyMessage` lets a caller replace the DEFAULT `pi-lens: <label>
 * unavailable — <reason>.` sentence with its own finished wording (#2636
 * review round 2, F1): `skills-resolver.ts`'s shipped notify text ("registers
 * zero skills") is user-visible product text #2626 chose deliberately — the
 * SYMPTOM the notification exists to surface — and folding onto this shared
 * helper must never silently reword a string a maintainer already tuned.
 */
export function reportBundledResourceDirHealth(
	kind: DegradationKind,
	dir: string,
	health: BundledResourceHealth,
	label: string,
	reasonOverride?: string,
	notifyMessage?: string,
): void {
	if (health.status === "healthy") return;
	const reason = reasonOverride ?? describeBundledResourceHealth(health, dir);
	const isFirstOccurrence = incrementDegradationCount({
		kind,
		subject: dir,
		reason,
		metadata:
			health.status === "unreadable"
				? { fsErrorCode: health.fsErrorCode }
				: undefined,
	});
	if (isFirstOccurrence) {
		notifyUserDegradation(
			notifyMessage ?? `pi-lens: ${label} unavailable — ${reason}.`,
			"warning",
		);
	}
}
