import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan } from "../support/sweep-kit.js";
import {
	KNOWN_FIXTURE_EMAILS,
	KNOWN_FIXTURE_NAMES,
} from "../support/git-config-guard.js";

const directGitSpawn =
	/\b(execSync|execFileSync|spawnSync|spawn|execFile|safeSpawnAsync)\s*\(\s*["'`]git\b/g;
const helperImport =
	/import\s*{([^}]+)}\s*from\s*["'`][^"'`]*git-fixture-env/gs;

const OWN_IMPLEMENTATION_FILES = [
	"tests/config/git-fixture-governance.test.ts",
	"tests/support/git-fixture-env.ts",
	"scripts/lib/git-fixture-env.mjs",
] as const;
// Scripts that drive the developer's REAL repository rather than a throwaway
// fixture repo. git-fixture-env exists to scrub GIT_* and pin
// GIT_CONFIG_GLOBAL at `<cwd>/gitconfig` so a fixture never reads the
// developer's config — exactly the wrong environment for a script whose whole
// job is to operate on this checkout (#2435: safe.directory, credential and
// alias config all have to apply).
const NOT_A_FIXTURE = [
	"scripts/pre-push-targeted-tests.mjs",
	"scripts/prune-agent-worktrees.mjs",
	// #2698: reads THIS checkout's own `git ls-files` state (untracked+
	// ignored .js siblings, tracked .ts sources) before `knip` runs — same
	// "drives the real repo" shape as the two scripts above, not a fixture.
	"scripts/lib/knip-sibling-purge.mjs",
] as const;

const REPO_ROOT = path.resolve(__dirname, "../..");

function repoRelative(file: string): string {
	if (!path.isAbsolute(file)) return file.replaceAll("\\", "/");
	return path.relative(REPO_ROOT, file).replaceAll("\\", "/");
}

export function isExpectedScriptExemption(file: string): boolean {
	return NOT_A_FIXTURE.includes(
		repoRelative(file) as (typeof NOT_A_FIXTURE)[number],
	);
}

export function findGitSpawnOffenders(
	files: ReadonlyArray<{ file: string; source: string }>,
): string[] {
	return files
		.filter(({ file, source }) => {
			directGitSpawn.lastIndex = 0;
			const relativeFile = repoRelative(file);
			if (
				OWN_IMPLEMENTATION_FILES.includes(
					relativeFile as (typeof OWN_IMPLEMENTATION_FILES)[number],
				)
			)
				return false;
			const imported = new Set<string>();
			for (const match of source.matchAll(helperImport)) {
				for (const item of match[1].split(","))
					imported.add(item.trim().split(/\s+as\s+/)[0] ?? "");
			}
			for (const match of source.matchAll(directGitSpawn)) {
				if (!imported.has(match[1])) return true;
			}
			return false;
		})
		.map(({ file }) => file);
}

function fixtureIdentityWrites(
	files: ReadonlyArray<{ file: string; source: string }>,
): Array<{ file: string; kind: "name" | "email"; value: string }> {
	const writes: Array<{
		file: string;
		kind: "name" | "email";
		value: string;
	}> = [];
	const literal =
		/\buser\.(name|email)(?:["']\s*,\s*["']([^"']+)["']|\s+["']([^"']+)["']|\s+([^\s"'`,}\]]+))/g;
	for (const { file, source } of files) {
		for (const line of source.split(/\r?\n/)) {
			if (!/\bconfig\b/.test(line)) continue;
			literal.lastIndex = 0;
			for (const match of line.matchAll(literal)) {
				const value = match[2] ?? match[3] ?? match[4];
				if (value)
					writes.push({ file, kind: match[1] as "name" | "email", value });
			}
		}
	}
	return writes;
}

function walkFiles(
	root: string,
	matches: (name: string) => boolean,
): Array<{ file: string; source: string }> {
	const files: Array<{ file: string; source: string }> = [];
	function walk(dir: string): void {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (matches(entry.name))
				files.push({ file, source: fs.readFileSync(file, "utf8") });
		}
	}
	walk(root);
	return files;
}

function testFiles(root: string): Array<{ file: string; source: string }> {
	return walkFiles(root, (name) => name.endsWith(".test.ts"));
}

/**
 * scripts/**\/*.mjs is a second population that can spawn a bare `git`
 * process (#2163 F7): standalone smoke/compat scripts, not vitest tests.
 * Walked separately because it lives outside tests/ and uses the .mjs
 * fixture helper (scripts/lib/git-fixture-env.mjs) rather than the .ts one.
 */
function scriptFiles(root: string): Array<{ file: string; source: string }> {
	return walkFiles(root, (name) => name.endsWith(".mjs"));
}

describe("real Git fixture governance", () => {
	it("routes every direct Git spawn through git-fixture-env", () => {
		const offenders = findGitSpawnOffenders(
			testFiles(path.resolve(__dirname, "..")),
		);
		expect(
			offenders,
			`Bare Git spawns found:\n${offenders.join("\n")}`,
		).toEqual([]);
	});

	it("routes every direct Git spawn in scripts/**/*.mjs through git-fixture-env", () => {
		const offenders = findGitSpawnOffenders(
			scriptFiles(path.resolve(__dirname, "../../scripts")),
		);
		const REMAINING_OFFENDERS: string[] = [];
		const unexpected = offenders.filter(
			(file) =>
				!REMAINING_OFFENDERS.includes(repoRelative(file)) &&
				!isExpectedScriptExemption(file),
		);
		expect(
			unexpected,
			`Unexpected bare Git spawns found:\n${unexpected.join("\n")}`,
		).toEqual([]);
	});

	it("anchors script exemptions to the repository-relative path", () => {
		expect(
			isExpectedScriptExemption("scripts/pre-push-targeted-tests.mjs"),
		).toBe(true);
		expect(
			isExpectedScriptExemption("scripts/zzdir/pre-push-targeted-tests.mjs"),
		).toBe(false);
	});

	it("keeps every literal fixture Git identity in the guard sets", () => {
		const files = [
			...walkFiles(
				path.resolve(__dirname, ".."),
				(name) => name.endsWith(".ts") || name.endsWith(".mts"),
			),
			...walkFiles(path.resolve(__dirname, "../../scripts"), (name) =>
				name.endsWith(".mjs"),
			),
		];
		const unknown = fixtureIdentityWrites(files).filter(
			({ kind, value }) =>
				(kind === "name" ? KNOWN_FIXTURE_NAMES : KNOWN_FIXTURE_EMAILS).has(
					value,
				) === false,
		);
		expect(unknown).toEqual([]);
	});

	it("detects a synthetic bare Git offender", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source: 'execFileSync("git", ["status"])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("rejects a helper mention that does not import or call the helper", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source: '// git-fixture-env\nexecFileSync("git", ["status"])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("rejects a direct call when a different helper symbol is imported", () => {
		expect(
			findGitSpawnOffenders([
				{
					file: "synthetic.test.ts",
					source:
						'import { gitExecSync } from "./git-fixture-env.js";\nexecFileSync("git", [])',
				},
			]),
		).toEqual(["synthetic.test.ts"]);
	});

	it("scans a non-empty source population", () => {
		const files = testFiles(path.resolve(__dirname, ".."));
		// Calibration: 807 *.test.ts files under tests/ on 2026-08-26 (fix round
		// 2). Half is 403.5; 400 is the documented floor so the walk still fails
		// loud if the tests/ tree collapses, without pinning to the exact count.
		assertNonEmptyScan("git fixture governance sweep", files.length, 400);
	});

	it("scans a non-empty scripts/**/*.mjs population", () => {
		const files = scriptFiles(path.resolve(__dirname, "../../scripts"));
		// Calibration: 60+ *.mjs files under scripts/ on 2026-08-26 (fix round
		// 2); 30 is a floor well below that, well above zero.
		assertNonEmptyScan(
			"git fixture governance scripts sweep",
			files.length,
			30,
		);
	});
});
