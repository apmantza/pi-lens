// flake-shape: real-process-spawn — the defect is how the real `ast-grep` CLI relativizes candidates, so only a real spawn answers it; a stubbed runner cannot over-exclude anything (#5545).
/**
 * #5545 — an ast-grep scan of a tree that sits under an ancestor directory the
 * tree's own `.gitignore` names returned an empty match list.
 *
 * A pi-lens scan started the `ast-grep` child in the pi-lens host's working
 * directory and handed it the scan path plus `--globs !<pattern>` excludes built
 * from the scanned tree's own `.gitignore`. `--globs` matches the candidate path
 * as the CLI relativizes it, and the CLI relativizes against the child's
 * directory — so the tree's own ignore patterns were tested against the path
 * from ABOVE the tree: a worktree lane at `/work/.claude/worktrees/<lane>` with
 * `.claude/` in its own `.gitignore` had every file of the lane excluded by the
 * recursive `.claude` pattern it declared for itself. `ast_grep_search` returned
 * an empty match list for a tree full of matches, and `ast_grep_replace`
 * reported every preview file as changed.
 *
 * The fix starts the scan child in the scanned tree, so a candidate's relative
 * path starts there and an ignore pattern can never match above the scan root —
 * the same anchor jscpd got in #4117. The cache-only npx tier cannot move: it
 * runs from the pi-lens npm-isolation directory so a hostile project `.npmrc`
 * never reaches it (#4233). That tier therefore carries no exclude globs and
 * relies on `ast-grep`'s own ignore-file handling of the scanned tree, which
 * `setupTestEnvironment`'s `.git` root marker activates for both tiers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AstGrepClient } from "../../clients/ast-grep-client.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "./test-utils.js";

const RULE_ID = "fix-5545-numeric-literal";
const RULE_YAML = [
	`id: ${RULE_ID}`,
	"language: javascript",
	"severity: warning",
	"message: Replace the 42 literal",
	'fix: "const $NAME = 43"',
	"rule:",
	"  pattern: const $NAME = 42",
	"",
].join("\n");

/** Directories the planted project ignores, each holding a planted match. */
const IGNORED_DIRS = ["node_modules", "dist"];

/**
 * `.claude/` is the pattern that bites: it names the ancestor every Claude Code
 * worktree lane lives under, and nothing inside the lane itself.
 */
const GITIGNORE = [
	".claude/",
	...IGNORED_DIRS.map((dir) => `${dir}/`),
	"",
].join("\n");

function plantProject(root: string): void {
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "src", "a.js"),
		"const answer = 42;\nexport default answer;\n",
	);
	for (const dir of IGNORED_DIRS) {
		fs.mkdirSync(path.join(root, dir), { recursive: true });
		fs.writeFileSync(path.join(root, dir, "a.js"), "const answer = 42;\n");
	}
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(root, ".gitignore"), GITIGNORE);
	fs.writeFileSync(path.join(root, "src", "keep.txt"), "not a source file\n");
}

describe("#5545 ast-grep scan root under an ancestor its .gitignore names", () => {
	async function newClient(): Promise<AstGrepClient> {
		const client = new AstGrepClient();
		// The scan seam resolves the command tier itself; the cells below assert the
		// user-visible contract, so they hold on the anchored tier and on the
		// npx tier alike.
		expect(await client.ensureAvailable()).toBe(true);
		return client;
	}
	let lane: string;
	let control: string;
	let sessionRoot: string;

	beforeEach(() => {
		const env = setupTestEnvironment("pi-lens-astgrep-ancestor-");
		sessionRoot = env.tmpDir;
		// The lane is the #4689 shape: the project itself sits inside `.claude/`,
		// so the `.claude/` pattern it declares names one of its own ancestors.
		// `ctrl/` holds the identical tree under a directory no pattern names.
		lane = path.join(env.tmpDir, ".claude", "worktrees", "lane1");
		control = path.join(env.tmpDir, "ctrl", "lane1");
		plantProject(lane);
		plantProject(control);
	});

	afterEach(async () => {
		await cleanupTestEnvironmentsDrained("pi-lens-astgrep-ancestor-");
	});

	describe("scan root under an ancestor the project's own .gitignore names", () => {
		it("finds the match and reports it at an absolute path", async () => {
			const client = await newClient();
			const result = await client.searchWithRule(RULE_YAML, [lane]);

			expect(result.error).toBeUndefined();
			expect(result.matches.map((match) => match.file)).toEqual([
				path.join(lane, "src", "a.js"),
			]);
			// Absolute, because the replace root guard and the mutation bridge key
			// the written set off these paths.
			expect(path.isAbsolute(result.matches[0]!.file)).toBe(true);
		});

		it("still excludes the directories the project's .gitignore names", async () => {
			const result = await (
				await newClient()
			).searchWithRule(RULE_YAML, [lane]);

			expect(result.matches.map((match) => match.file)).toEqual([
				path.join(lane, "src", "a.js"),
			]);
			for (const dir of IGNORED_DIRS) {
				expect(
					result.matches.some((match) =>
						match.file.includes(`${path.sep}${dir}${path.sep}`),
					),
					`${dir} must stay out of the result`,
				).toBe(false);
			}
		});

		it("previews the rewrite instead of reporting an empty match list", async () => {
			const client = await newClient();
			const preview = await client.replaceWithRule(RULE_YAML, [lane], false, {
				sessionRoot,
			});

			expect(preview.error).toBeUndefined();
			expect(preview.applied).toBe(false);
			expect(preview.totalMatches).toBe(1);
			expect(preview.matches.map((match) => match.file)).toEqual([
				path.join(lane, "src", "a.js"),
			]);
		});

		it("applies the rewrite to the file the preview named", async () => {
			const client = await newClient();
			const target = path.join(lane, "src", "a.js");
			const preview = await client.replaceWithRule(RULE_YAML, [lane], false, {
				sessionRoot,
			});
			expect(preview.matches).toHaveLength(1);

			const applied = await client.replaceWithRule(RULE_YAML, [lane], true, {
				sessionRoot,
			});

			expect(applied.error).toBeUndefined();
			expect(applied.applied).toBe(true);
			// `appliedFiles` lists the files the mutation bridge ACCEPTED, and this
			// cell mounts none — the accepted-set contract is #5239's own test. What
			// a user sees is the rewritten file at the path the preview named.
			expect(fs.readFileSync(target, "utf8")).toContain("const answer = 43");
		});
	});

	describe("control: the same tree under an ancestor no ignore pattern names", () => {
		it("finds the same match, and excludes the same directories", async () => {
			const result = await (
				await newClient()
			).searchWithRule(RULE_YAML, [control]);

			expect(result.error).toBeUndefined();
			expect(result.matches.map((match) => match.file)).toEqual([
				path.join(control, "src", "a.js"),
			]);
		});
	});
});
