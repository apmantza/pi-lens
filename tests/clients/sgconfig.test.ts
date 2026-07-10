import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	_resetBaselineSgconfigForTests,
	resolveBaselineSgconfig,
} from "../../clients/sgconfig.js";

/** Read the single `ruleDirs` entry out of a generated sgconfig.yml. */
function soleRuleDir(configPath: string): string {
	const text = fs.readFileSync(configPath, "utf8");
	const lines = text
		.split(/\r?\n/)
		.filter((line) => line.trim().startsWith("- "));
	expect(lines.length).toBe(1);
	return lines[0].replace(/^\s*-\s*/, "").replace(/^"|"$/g, "");
}

/** All rule ids present anywhere in the merged rule directory. */
function idsInMergedDir(mergedDir: string): string[] {
	const ids: string[] = [];
	for (const name of fs.readdirSync(mergedDir)) {
		const content = fs.readFileSync(path.join(mergedDir, name), "utf8");
		for (const doc of content.split(/^---$/m)) {
			const match = doc.match(/^id:\s*(.+)$/m);
			if (match) ids.push(match[1].trim());
		}
	}
	return ids;
}

describe("ast-grep baseline sgconfig", () => {
	afterEach(() => {
		_resetBaselineSgconfigForTests();
	});

	it("includes pi-lens rules plus vendored CodeRabbit rules", () => {
		_resetBaselineSgconfigForTests();
		const configPath = resolveBaselineSgconfig();
		expect(configPath).toBeDefined();
		if (!configPath) throw new Error("expected baseline sgconfig");
		const mergedDir = soleRuleDir(configPath);
		expect(path.isAbsolute(mergedDir)).toBe(true);
		const ids = idsInMergedDir(mergedDir);
		// A pi-lens-native rule and a vendored CodeRabbit rule should both
		// survive the merge (no-collision case, #497 point 4).
		expect(ids).toContain("no-console-except-error");
		expect(ids.length).toBeGreaterThan(50);
	});

	it("writes a single absolute ruleDirs entry (#497: raw ast-grep's ruleDirs is directory-granular, so overlapping-id source dirs must be pre-merged into one)", () => {
		_resetBaselineSgconfigForTests();
		const configPath = resolveBaselineSgconfig();
		expect(configPath).toBeDefined();
		if (!configPath) throw new Error("expected baseline sgconfig");
		const mergedDir = soleRuleDir(configPath);
		expect(fs.existsSync(mergedDir)).toBe(true);
		expect(fs.statSync(mergedDir).isDirectory()).toBe(true);
	});

	it("uses a per-PROCESS filename embedding the pid (#472: the path doubles as the reaper's unique marker)", () => {
		_resetBaselineSgconfigForTests();
		const configPath = resolveBaselineSgconfig();
		expect(configPath).toBeDefined();
		if (!configPath) throw new Error("expected baseline sgconfig");
		expect(path.basename(configPath)).toBe(
			`baseline-${process.pid}.sgconfig.yml`,
		);
	});

	it("cleans up stale baseline configs and merged rule dirs (>7 days) but never the current ones or unrelated files", () => {
		const dir = path.join(os.tmpdir(), "pi-lens-ast-grep");
		fs.mkdirSync(dir, { recursive: true });

		// Plant: a stale per-pid baseline + merged dir, a stale legacy shared
		// baseline, a FRESH per-pid baseline (another live session), and an
		// unrelated file.
		const staleOld = path.join(dir, "baseline-999991.sgconfig.yml");
		const staleOldRules = path.join(dir, "baseline-999991.rules");
		const staleLegacy = path.join(dir, "baseline.sgconfig.yml");
		const freshOther = path.join(dir, "baseline-999992.sgconfig.yml");
		const unrelated = path.join(dir, "unrelated-999993.yml");
		for (const f of [staleOld, staleLegacy, freshOther, unrelated]) {
			fs.writeFileSync(f, "ruleDirs: []\n");
		}
		fs.mkdirSync(staleOldRules, { recursive: true });
		fs.writeFileSync(path.join(staleOldRules, "x.yml"), "id: x\n");
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		fs.utimesSync(staleOld, eightDaysAgo, eightDaysAgo);
		fs.utimesSync(staleOldRules, eightDaysAgo, eightDaysAgo);
		fs.utimesSync(staleLegacy, eightDaysAgo, eightDaysAgo);
		fs.utimesSync(unrelated, eightDaysAgo, eightDaysAgo);
		// freshOther keeps its current mtime — must survive.

		try {
			_resetBaselineSgconfigForTests();
			const configPath = resolveBaselineSgconfig();
			expect(configPath).toBeDefined();
			if (!configPath) throw new Error("expected baseline sgconfig");

			expect(fs.existsSync(staleOld)).toBe(false); // old per-pid ⇒ removed
			expect(fs.existsSync(staleOldRules)).toBe(false); // old merged dir ⇒ removed
			expect(fs.existsSync(staleLegacy)).toBe(false); // old legacy shared ⇒ removed
			expect(fs.existsSync(freshOther)).toBe(true); // recent sibling ⇒ kept
			expect(fs.existsSync(unrelated)).toBe(true); // non-baseline name ⇒ kept
			expect(fs.existsSync(configPath)).toBe(true); // current file ⇒ kept
		} finally {
			for (const f of [freshOther, unrelated]) {
				fs.rmSync(f, { force: true });
			}
		}
	});

	describe("#497: project-first same-id precedence in the generated config", () => {
		let scratchCwd: string;
		let originalCwd: string;

		afterEach(() => {
			process.chdir(originalCwd);
			fs.rmSync(scratchCwd, { recursive: true, force: true });
			_resetBaselineSgconfigForTests();
		});

		function setUpProjectRulesDir(): string {
			originalCwd = process.cwd();
			scratchCwd = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-sgconfig-497-"),
			);
			const projectRulesDir = path.join(
				scratchCwd,
				"rules",
				"ast-grep-rules",
				"rules",
			);
			fs.mkdirSync(projectRulesDir, { recursive: true });
			process.chdir(scratchCwd);
			return projectRulesDir;
		}

		it("lets a project rule override a bundled rule with the same id (point 1/2)", () => {
			const projectRulesDir = setUpProjectRulesDir();
			fs.writeFileSync(
				path.join(projectRulesDir, "no-console-except-error.yml"),
				[
					"id: no-console-except-error",
					"language: TypeScript",
					"message: PROJECT OVERRIDE",
					"rule:",
					"  pattern: console.log($$$)",
					"",
				].join("\n"),
			);

			_resetBaselineSgconfigForTests();
			const configPath = resolveBaselineSgconfig();
			expect(configPath).toBeDefined();
			if (!configPath) throw new Error("expected baseline sgconfig");
			const mergedDir = soleRuleDir(configPath);

			// Exactly one file in the merged set defines this EXACT id (not the
			// unrelated `no-console-except-error-js` sibling rule), and it's the
			// project's — the bundled rule with the same id must not survive
			// alongside it (that's precisely what makes raw `sg` reject the
			// config with "Duplicate rule id").
			const matches = fs
				.readdirSync(mergedDir)
				.filter((f) =>
					/^id:\s*no-console-except-error\s*$/m.test(
						fs.readFileSync(path.join(mergedDir, f), "utf8"),
					),
				);
			expect(matches.length).toBe(1);
			const content = fs.readFileSync(
				path.join(mergedDir, matches[0]),
				"utf8",
			);
			expect(content).toContain("PROJECT OVERRIDE");
		});

		it("keeps unique bundled rules alongside a project override (no-collision case, point 4)", () => {
			const projectRulesDir = setUpProjectRulesDir();
			fs.writeFileSync(
				path.join(projectRulesDir, "no-console-except-error.yml"),
				"id: no-console-except-error\nlanguage: TypeScript\nrule:\n  pattern: console.log($$$)\n",
			);

			_resetBaselineSgconfigForTests();
			const configPath = resolveBaselineSgconfig();
			if (!configPath) throw new Error("expected baseline sgconfig");
			const mergedDir = soleRuleDir(configPath);
			const ids = idsInMergedDir(mergedDir);

			expect(ids).toContain("no-console-except-error");
			// A different, unshadowed bundled rule id must still be present.
			expect(ids).toContain("array-callback-return-js");
		});

		it("still errors loudly on a same-layer duplicate id (point 5) rather than silently dropping one", () => {
			const projectRulesDir = setUpProjectRulesDir();
			fs.writeFileSync(
				path.join(projectRulesDir, "dup-a.yml"),
				"id: project-dup\nlanguage: TypeScript\nrule:\n  pattern: foo($$$)\n",
			);
			fs.writeFileSync(
				path.join(projectRulesDir, "dup-b.yml"),
				"id: project-dup\nlanguage: TypeScript\nrule:\n  pattern: bar($$$)\n",
			);

			_resetBaselineSgconfigForTests();
			const configPath = resolveBaselineSgconfig();
			if (!configPath) throw new Error("expected baseline sgconfig");
			const mergedDir = soleRuleDir(configPath);

			// Both same-layer files must be copied through UNMODIFIED — the
			// generator must never silently dedupe within a single layer, since
			// that would hide a real authoring mistake instead of letting `sg`
			// surface it as the "Duplicate rule id" error.
			const matches = fs
				.readdirSync(mergedDir)
				.filter((f) =>
					fs
						.readFileSync(path.join(mergedDir, f), "utf8")
						.includes("id: project-dup"),
				);
			expect(matches.length).toBe(2);
		});

		it("agrees on the winner across a cache invalidation when the project rule set changes mid-session (point 7)", () => {
			const projectRulesDir = setUpProjectRulesDir();

			_resetBaselineSgconfigForTests();
			const configPath1 = resolveBaselineSgconfig();
			if (!configPath1) throw new Error("expected baseline sgconfig");
			const mergedDir1 = soleRuleDir(configPath1);
			expect(idsInMergedDir(mergedDir1)).toContain(
				"array-callback-return-js",
			);
			const beforeOverride = fs
				.readdirSync(mergedDir1)
				.find((f) =>
					fs
						.readFileSync(path.join(mergedDir1, f), "utf8")
						.includes("id: array-callback-return-js"),
				);
			expect(beforeOverride).toBeDefined();
			expect(
				fs.readFileSync(path.join(mergedDir1, beforeOverride as string), "utf8"),
			).not.toContain("PROJECT OVERRIDE");

			// Mid-session: project adds a rule shadowing a bundled id.
			fs.writeFileSync(
				path.join(projectRulesDir, "override.yml"),
				"id: array-callback-return-js\nlanguage: TypeScript\nmessage: PROJECT OVERRIDE\nrule:\n  pattern: foo($$$)\n",
			);

			const configPath2 = resolveBaselineSgconfig();
			if (!configPath2) throw new Error("expected baseline sgconfig");
			const mergedDir2 = soleRuleDir(configPath2);
			const matches2 = fs
				.readdirSync(mergedDir2)
				.filter((f) =>
					fs
						.readFileSync(path.join(mergedDir2, f), "utf8")
						.includes("id: array-callback-return-js"),
				);
			// Fresh (post-change) resolution must agree with what a NEW cold
			// resolution would produce: exactly one winner, and it's the project's.
			expect(matches2.length).toBe(1);
			expect(
				fs.readFileSync(path.join(mergedDir2, matches2[0]), "utf8"),
			).toContain("PROJECT OVERRIDE");
		});
	});
});
