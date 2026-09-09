import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #2626 review round 2, F4: `vi.spyOn(fs, "readdirSync")` cannot redefine a
// node: built-in's ESM namespace export directly (same constraint
// `tests/clients/workspace-topology.test.ts` documents) — wrap via vi.mock,
// default to the REAL implementation via `vi.fn(actual.readdirSync)`, and
// only the one EACCES test below overrides it for a single call.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

// #2626 review round 2, F5: capture `logLatency` calls to prove the
// success-path observability record fires and names the path + entry count.
const latencyEntries: Array<{
	phase?: string;
	filePath?: string;
	metadata?: Record<string, unknown>;
}> = [];
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: {
			phase?: string;
			filePath?: string;
			metadata?: Record<string, unknown>;
		}) => latencyEntries.push(entry),
	};
});

import * as fs from "node:fs";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { resolveSkillPaths } from "../../clients/skills-resolver.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";

/**
 * #2626: `resources_discover` (#205) resolves `<packageRoot>/skills` and
 * registers whatever it finds. When that directory is absent, unreadable, or
 * holds no skill pi's real loader would find, pi previously registered zero
 * skills with NO extension error and empty stderr — completely silent
 * (investigated on #2587).
 *
 * `resolveSkillPaths` IS the function the real `resources_discover` handler
 * calls (`index.ts` now does `skillPaths: resolveSkillPaths(import.meta.url)`
 * verbatim) — these tests drive it directly with synthetic `file://` URLs
 * built over real temp directories (real `fs` calls, no mocked filesystem
 * except the one EACCES injection below), rather than a hand-fed
 * reimplementation of the check.
 *
 * Review round 2, F1: the layout table (A–H) below is checked against pi's
 * REAL loader (`loadSkillsFromDirInternal` / `collectSkillEntries`, verified
 * byte-identical against the extracted `@earendil-works/pi-coding-agent@0.85.1`
 * tarball). `resolveSkillPaths` now ALWAYS returns `[skillsDir]` regardless
 * of health — the health check is purely observational (a degradation
 * record), never a changed return value; the first version of this fix
 * inverted that and silently DROPPED skills pi would have loaded on layouts
 * A/C/D/E/H, which is what this table now pins against regressing.
 *
 * Shape 38 / #2626 review note: `getPackageRoot` (`clients/package-root.ts`)
 * memoizes its walk in a module-level `Map` keyed by the exact
 * `importMetaUrl` string. Reusing the same synthetic URL across scenarios
 * with different on-disk layouts would silently read back an earlier
 * scenario's cached root instead of re-walking — the fixture would never
 * reach the code under test a second time. Every scenario below therefore
 * gets its OWN freshly created temp directory (and so its own unique
 * `importMetaUrl`), guaranteeing a real cache miss each time.
 */

const notified: Array<{ message: string; level: string | undefined }> = [];
let tmpDirs: string[] = [];

beforeEach(() => {
	notified.length = 0;
	latencyEntries.length = 0;
	tmpDirs = [];
	resetDegradationLedger();
	vi.mocked(fs.readdirSync).mockClear();
	wireUserNotifier(() => (message, level) => {
		notified.push({ message, level });
	});
});

afterEach(() => {
	resetUserNotifier();
	resetDegradationLedger();
	vi.restoreAllMocks();
	for (const dir of tmpDirs) {
		fsSync.rmSync(dir, { recursive: true, force: true });
	}
});

/** A fresh, unique package root under a real temp dir — see the shape-38 note above. */
function freshPackageRoot(): string {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "pilens-skills-test-"));
	tmpDirs.push(dir);
	fsSync.writeFileSync(path.join(dir, "package.json"), "{}");
	return dir;
}

function entryUrl(entryFile: string): string {
	return pathToFileURL(entryFile).href;
}

function skillsDegradationGroup() {
	return getDegradationSummary().find(
		(group) => group.kind === "skills-dir-missing",
	);
}

function skillsPhaseEntries() {
	return latencyEntries.filter((entry) => entry.phase === "skills_resolved");
}

describe("resolveSkillPaths (#2626) — layout table against pi's real loader", () => {
	it("A: skills/SKILL.md (root SKILL.md) is healthy and registers skillsDir", () => {
		const packageRoot = freshPackageRoot();
		const skillsDir = path.join(packageRoot, "skills");
		fsSync.mkdirSync(skillsDir, { recursive: true });
		fsSync.writeFileSync(path.join(skillsDir, "SKILL.md"), "# root skill\n");
		const entryFile = path.join(packageRoot, "index.js");

		const result = resolveSkillPaths(entryUrl(entryFile));

		expect(result).toEqual([skillsDir]);
		expect(skillsDegradationGroup()).toBeUndefined();
		expect(notified).toHaveLength(0);
		expect(skillsPhaseEntries()).toEqual([
			expect.objectContaining({
				phase: "skills_resolved",
				filePath: skillsDir,
				metadata: { status: "healthy", entryCount: 1 },
			}),
		]);
	});

	it("B: skills/<name>/SKILL.md (one level) is healthy", () => {
		const packageRoot = freshPackageRoot();
		const skillsDir = path.join(packageRoot, "skills", "pi-lens-example");
		fsSync.mkdirSync(skillsDir, { recursive: true });
		fsSync.writeFileSync(path.join(skillsDir, "SKILL.md"), "# example skill\n");
		const entryFile = path.join(packageRoot, "dist", "index.js");

		const result = resolveSkillPaths(entryUrl(entryFile));

		expect(result).toEqual([path.join(packageRoot, "skills")]);
		expect(skillsDegradationGroup()).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	it("C: skills/<group>/<name>/SKILL.md (nested two levels) is healthy", () => {
		const packageRoot = freshPackageRoot();
		const nested = path.join(packageRoot, "skills", "group", "name");
		fsSync.mkdirSync(nested, { recursive: true });
		fsSync.writeFileSync(path.join(nested, "SKILL.md"), "# nested skill\n");
		const entryFile = path.join(packageRoot, "index.js");

		const result = resolveSkillPaths(entryUrl(entryFile));

		expect(result).toEqual([path.join(packageRoot, "skills")]);
		expect(skillsDegradationGroup()).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	it("D: skills/name.md (loose root .md file) is healthy", () => {
		const packageRoot = freshPackageRoot();
		const skillsDir = path.join(packageRoot, "skills");
		fsSync.mkdirSync(skillsDir, { recursive: true });
		fsSync.writeFileSync(path.join(skillsDir, "name.md"), "# loose skill\n");
		const entryFile = path.join(packageRoot, "index.js");

		const result = resolveSkillPaths(entryUrl(entryFile));

		expect(result).toEqual([skillsDir]);
		expect(skillsDegradationGroup()).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	it("a BROKEN symlink named SKILL.md at the root is skipped, matching pi's statSync-and-continue on a dangling link", () => {
		const packageRoot = freshPackageRoot();
		const skillsDir = path.join(packageRoot, "skills");
		fsSync.mkdirSync(skillsDir, { recursive: true });
		fsSync.symlinkSync(
			path.join(skillsDir, "does-not-exist"),
			path.join(skillsDir, "SKILL.md"),
		);
		const entryFile = path.join(packageRoot, "index.js");

		const result = resolveSkillPaths(entryUrl(entryFile));

		expect(result).toEqual([skillsDir]);
		expect(skillsDegradationGroup()?.count).toBe(1);
	});

	it("a loose .md file NESTED under a subdirectory (not the outermost skills/) is NOT counted, matching pi's includeRootFiles=false at that depth", () => {
		// pi's `includeRootFiles` is true ONLY for the outermost call
		// (`loadSkillsFromDir`'s entry point); a subdirectory with no SKILL.md
		// of its own does not fall back to treating ITS loose .md children as
		// skills — only the top-level skills/ does that (layout D).
		const packageRoot = freshPackageRoot();
		const subdir = path.join(packageRoot, "skills", "notes");
		fsSync.mkdirSync(subdir, { recursive: true });
		fsSync.writeFileSync(path.join(subdir, "readme.md"), "# not a skill\n");
		const entryFile = path.join(packageRoot, "index.js");

		const result = resolveSkillPaths(entryUrl(entryFile));

		expect(result).toEqual([path.join(packageRoot, "skills")]);
		expect(skillsDegradationGroup()?.count).toBe(1);
	});

	it("E: a symlinked directory under skills/ holding SKILL.md is healthy", () => {
		const packageRoot = freshPackageRoot();
		const skillsDir = path.join(packageRoot, "skills");
		const realTarget = path.join(packageRoot, "real-skill-target");
		fsSync.mkdirSync(realTarget, { recursive: true });
		fsSync.writeFileSync(
			path.join(realTarget, "SKILL.md"),
			"# symlinked skill\n",
		);
		fsSync.mkdirSync(skillsDir, { recursive: true });
		fsSync.symlinkSync(realTarget, path.join(skillsDir, "linked"), "dir");
		const entryFile = path.join(packageRoot, "index.js");

		const result = resolveSkillPaths(entryUrl(entryFile));

		expect(result).toEqual([skillsDir]);
		expect(skillsDegradationGroup()).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	it("F: entry copied out of the package (nearest package.json has no skills/) is absent — records the degradation but STILL returns skillsDir", () => {
		// Mirrors the issue's managed-cache layout: <cache>/npm/package.json is
		// the nearest package.json to the relocated entry, and <cache>/npm/skills
		// does not exist.
		const cacheRoot = freshPackageRoot();
		const entryFile = path.join(cacheRoot, "ext", "pi-lens.js");
		const expectedSkillsDir = path.join(cacheRoot, "skills");

		const result = resolveSkillPaths(entryUrl(entryFile));

		// F1: the return value is UNCONDITIONAL — pi's own loader already
		// treats a nonexistent path as zero skills gracefully, so dropping it
		// here would only ever make things worse, never better.
		expect(result).toEqual([expectedSkillsDir]);
		const group = skillsDegradationGroup();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons.at(-1)?.subject).toBe(expectedSkillsDir);
		expect(group?.latestReasons.at(-1)?.reason).toContain(expectedSkillsDir);
		expect(group?.latestReasons.at(-1)?.reason).toContain(
			path.join(cacheRoot, "ext"),
		);
		expect(group?.latestReasons.at(-1)?.reason).toContain("no such directory");
		expect(notified).toHaveLength(1);
		expect(notified[0]?.level).toBe("warning");
		expect(notified[0]?.message).toContain("pi-lens:");
		expect(notified[0]?.message).toContain(expectedSkillsDir);
		// #2636 review round 2, F1: the shipped notify sentence is user-visible
		// product text #2626 chose deliberately — it names the exact SYMPTOM
		// this issue exists to surface. Folding onto the shared
		// reportBundledResourceDirHealth helper must never silently reword it
		// to the helper's generic "<label> unavailable" template.
		expect(notified[0]?.message).toContain("registers zero skills");
		expect(skillsPhaseEntries()).toEqual([
			expect.objectContaining({
				phase: "skills_resolved",
				filePath: expectedSkillsDir,
				metadata: { status: "absent", entryCount: 0 },
			}),
		]);
	});

	it("G: skills/ exists but is completely empty — records the degradation", () => {
		const packageRoot = freshPackageRoot();
		const skillsDir = path.join(packageRoot, "skills");
		fsSync.mkdirSync(skillsDir, { recursive: true });
		const entryFile = path.join(packageRoot, "index.js");

		const result = resolveSkillPaths(entryUrl(entryFile));

		expect(result).toEqual([skillsDir]);
		const group = skillsDegradationGroup();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons.at(-1)?.subject).toBe(skillsDir);
		// #2636 review round 2, F1/M7: the EMPTY-status reason names the
		// skill-specific predicate ("no SKILL.md"), not the shared helper's
		// generic "exists but holds nothing" — pins that
		// `checkSkillsHealth`'s `emptyDescription` override is actually wired,
		// not silently dropped in favor of the generic default (which would
		// leave this whole file green otherwise).
		expect(group?.latestReasons.at(-1)?.reason).toContain("no SKILL.md");
		expect(notified).toHaveLength(1);
		expect(notified[0]?.message).toContain("registers zero skills");
	});

	it("H: skills/.hidden/SKILL.md is skipped (dot-dir), same as pi's own loader — records the degradation", () => {
		// The critical fidelity row (#2626 review F1): a naive recursive SKILL.md
		// search that does not skip dot-prefixed directories would call this
		// "healthy" while pi's real loader (which DOES skip dot-dirs) loads
		// zero skills. The predicate must agree with pi, not with "a SKILL.md
		// file exists somewhere under this tree".
		const packageRoot = freshPackageRoot();
		const hidden = path.join(packageRoot, "skills", ".hidden");
		fsSync.mkdirSync(hidden, { recursive: true });
		fsSync.writeFileSync(path.join(hidden, "SKILL.md"), "# hidden skill\n");
		const entryFile = path.join(packageRoot, "index.js");

		const result = resolveSkillPaths(entryUrl(entryFile));

		expect(result).toEqual([path.join(packageRoot, "skills")]);
		const group = skillsDegradationGroup();
		expect(group?.count).toBe(1);
		expect(notified).toHaveLength(1);
	});

	it("a SKILL.md sitting inside node_modules/ is skipped, same as pi's own loader", () => {
		const packageRoot = freshPackageRoot();
		const nm = path.join(packageRoot, "skills", "node_modules", "some-dep");
		fsSync.mkdirSync(nm, { recursive: true });
		fsSync.writeFileSync(path.join(nm, "SKILL.md"), "# dependency skill\n");
		const entryFile = path.join(packageRoot, "index.js");

		const result = resolveSkillPaths(entryUrl(entryFile));

		expect(result).toEqual([path.join(packageRoot, "skills")]);
		expect(skillsDegradationGroup()?.count).toBe(1);
	});
});

describe("resolveSkillPaths (#2626) — F3: notify-once gate", () => {
	it("tallies every call in the ledger but notifies only once per subject", () => {
		// `incrementDegradationCount` (not `recordDegradationOnce` — F3) tallies
		// every occurrence, so the ledger's own count is the true call count;
		// only the human-facing notify must collapse to the rising edge.
		const cacheRoot = freshPackageRoot();
		const entryFile = path.join(cacheRoot, "ext", "pi-lens.js");

		resolveSkillPaths(entryUrl(entryFile));
		resolveSkillPaths(entryUrl(entryFile));
		resolveSkillPaths(entryUrl(entryFile));

		expect(skillsDegradationGroup()?.count).toBe(3);
		expect(notified).toHaveLength(1);
	});

	it("still notifies exactly once when the resolved path is long enough to be truncated by the ledger (>200 chars)", () => {
		// #2626 review round 2, F3 red-first case: the pre-fix notify gate
		// compared the RAW skillsDir against ledger subjects that are stored
		// `truncateForLedger`-ed (LEDGER_FIELD_MAX = 200 chars). A managed-cache
		// path this long is not exotic — nested node_modules hoisting and long
		// scoped-package segments get there quickly.
		// `freshPackageRoot()` puts `package.json` at the temp dir's own root, so
		// the LONG segment must sit BETWEEN the temp root and package.json for
		// the resolved `skillsDir` itself (not just the entry path) to exceed
		// 200 chars — `getPackageRoot` stops at the FIRST `package.json` it
		// finds walking up from the entry, so a long segment past that point
		// would never appear in `skillsDir` at all.
		const base = fsSync.mkdtempSync(
			path.join(os.tmpdir(), "pilens-skills-test-"),
		);
		tmpDirs.push(base);
		// One filesystem NAME component is capped well under 200 chars (NAME_MAX
		// is 255 bytes on ext4), so the length comes from several nested
		// segments, not one giant one.
		const nestedSegments = Array.from(
			{ length: 10 },
			(_, i) => `very-long-managed-cache-segment-${i}`,
		);
		const cacheRoot = path.join(base, ...nestedSegments);
		fsSync.mkdirSync(cacheRoot, { recursive: true });
		fsSync.writeFileSync(path.join(cacheRoot, "package.json"), "{}");
		expect(path.join(cacheRoot, "skills").length).toBeGreaterThan(200);
		const entryFile = path.join(cacheRoot, "ext", "pi-lens.js");

		resolveSkillPaths(entryUrl(entryFile));
		resolveSkillPaths(entryUrl(entryFile));
		resolveSkillPaths(entryUrl(entryFile));

		expect(skillsDegradationGroup()?.count).toBe(3);
		expect(notified).toHaveLength(1);
	});
});

describe("resolveSkillPaths (#2626) — F4: EACCES vs ENOENT", () => {
	it("EACCES on the top-level skills dir reports 'cannot read', never 'no SKILL.md', and never throws", () => {
		const packageRoot = freshPackageRoot();
		const skillsDir = path.join(packageRoot, "skills");
		// A REAL skill sits here — the point is that EACCES must not be
		// misreported as "empty"/"no SKILL.md", which would be a false claim
		// about content that exists but could not be read.
		fsSync.mkdirSync(skillsDir, { recursive: true });
		fsSync.writeFileSync(
			path.join(skillsDir, "SKILL.md"),
			"# unreadable skill\n",
		);
		const entryFile = path.join(packageRoot, "index.js");
		const realReaddirSync = vi.mocked(fs.readdirSync).getMockImplementation();

		vi.mocked(fs.readdirSync).mockImplementationOnce(((
			dir: unknown,
			options: unknown,
		) => {
			if (path.resolve(String(dir)) === path.resolve(skillsDir)) {
				const err = new Error(
					"EACCES: permission denied, scandir",
				) as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			}
			return realReaddirSync?.(dir as never, options as never);
		}) as unknown as typeof fs.readdirSync);

		let result: string[] | undefined;
		expect(() => {
			result = resolveSkillPaths(entryUrl(entryFile));
		}).not.toThrow();

		expect(result).toEqual([skillsDir]);
		const group = skillsDegradationGroup();
		const reason = group?.latestReasons.at(-1)?.reason ?? "";
		expect(reason).toContain("cannot read");
		expect(reason).toContain("EACCES");
		expect(reason).not.toContain("no SKILL.md");
		expect(reason).not.toContain("no such directory");
	});

	it("ENOENT reports 'no such directory', distinct from the EACCES prose", () => {
		const cacheRoot = freshPackageRoot();
		const entryFile = path.join(cacheRoot, "ext", "pi-lens.js");

		resolveSkillPaths(entryUrl(entryFile));

		const reason = skillsDegradationGroup()?.latestReasons.at(-1)?.reason ?? "";
		expect(reason).toContain("no such directory");
		expect(reason).not.toContain("cannot read");
		expect(reason).not.toContain("EACCES");
	});
});
