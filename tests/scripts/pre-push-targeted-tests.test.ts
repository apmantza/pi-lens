// flake-shape: real-process-spawn — the subject is the pre-push hook's own
// contract with git: the stdin ref lines git writes, and the script's
// deletion-only early exit and range union (#3661). The main-level witness
// runs the real script over a real git fixture; an in-process call cannot
// see the CLI's exit status or its build/test skip.
/**
 * Tests for scripts/pre-push-targeted-tests.mjs's selection logic (#1804
 * review round 1, findings F1/F6/F7).
 *
 * The pre-push hook's whole safety claim ("never the full suite") rests on
 * this selection staying narrow. A prior basename-substring version of the
 * content-grep pass matched any import ending in `/<basename>` regardless of
 * directory — `index.ts` alone selected 176 test files, and a real 43-file
 * commit selected 282 (~10 minutes). These tests pin the fix: full-path
 * import resolution (not a basename/substring guess) plus a hard cap that
 * degrades to build-only instead of ever approaching "the whole suite" by
 * accident.
 *
 * `selectTargetedTests` resolves paths relative to `process.cwd()` (mirrors
 * a real repo checkout: `clients/x.ts` <-> `tests/clients/x.test.ts`), so
 * each test builds an isolated fixture tree under a temp dir and chdirs into
 * it for the duration of the test, restoring the real cwd in `afterEach` —
 * never touches the real `tests/`/`clients/` trees.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envFor, gitExecFileSync } from "../../scripts/lib/git-fixture-env.mjs";
import {
	CI_ONLY_PRE_PUSH_TESTS,
	collectTestFiles,
	MAX_SELECTED_TESTS,
	TEST_TREE_GOVERNANCE_TESTS,
	TREE_SCANNING_GOVERNANCE_TESTS,
	changesProductionFile,
	changesTestTreeFile,
	selectTargetedTests,
	resolveDiffRange,
} from "../../scripts/pre-push-targeted-tests.mjs";

const repoRoot = path.resolve(__dirname, "..", "..");

let fixtureDir: string | undefined;
const originalCwd = process.cwd();

function write(relPath: string, content: string) {
	const full = path.join(fixtureDir as string, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf8");
}

function enterFixture() {
	fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-pre-push-test-"));
	process.chdir(fixtureDir);
}

afterEach(() => {
	process.chdir(originalCwd);
	if (fixtureDir) {
		fs.rmSync(fixtureDir, { recursive: true, force: true });
		fixtureDir = undefined;
	}
});

describe("resolveDiffRange — pre-push ref population (#3661)", () => {
	const zero = "0".repeat(40);

	it("returns no ranges for a deletion-only push so the hook skips before building", () => {
		// #3661 recurrence: a deletion's all-zero local sha was treated as a
		// normal update, causing a failed diff and an unnecessary build.
		expect(
			resolveDiffRange(`(delete) ${zero} refs/heads/removed abc123\n`),
		).toBeNull();
	});

	it("exits before the build on a deletion-only hook invocation", () => {
		// #3661 recurrence: the hook must make the deletion decision before its
		// build entry point, not merely avoid selecting tests afterward.
		const result = spawnSync(
			process.execPath,
			[
				path.join(repoRoot, "scripts/pre-push-targeted-tests.mjs"),
				"--skip-build",
			],
			{
				cwd: repoRoot,
				encoding: "utf8",
				input: `(delete) ${zero} refs/heads/removed abc123\n`,
			},
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"deletion-only push; skipping build and tests",
		);
	});

	it.each([
		[
			"deletion first",
			`(delete) ${zero} refs/heads/removed abc123\nrefs/heads/topic localsha refs/heads/topic remotesha\n`,
		],
		[
			"update first",
			`refs/heads/topic localsha refs/heads/topic remotesha\n(delete) ${zero} refs/heads/removed abc123\n`,
		],
	])(
		"ignores deletion lines regardless of their order (%s)",
		(_name, stdin) => {
			// #3661 recurrence: reading only the first line made mixed pushes
			// depend on ref ordering and could select a deletion range.
			expect(resolveDiffRange(stdin)).toEqual(["remotesha...localsha"]);
		},
	);

	it("keeps the origin/master fallback for a new branch", () => {
		// #3661 recurrence: a non-deletion line with an all-zero remote sha is
		// the new-branch case and must retain the existing fallback.
		expect(
			resolveDiffRange(`refs/heads/topic localsha refs/heads/topic ${zero}\n`),
		).toEqual(["origin/master...HEAD"]);
	});

	it("deduplicates repeated update and new-branch ranges", () => {
		// F3664-1 recurrence: multiple ref lines can describe the same range;
		// main must not run the same diff and target twice.
		expect(
			resolveDiffRange(
				`refs/heads/topic localsha refs/heads/topic remotesha\n` +
					`refs/heads/topic localsha refs/heads/topic remotesha\n` +
					`refs/heads/new newlocal refs/heads/new ${zero}\n` +
					`refs/heads/new newerlocal refs/heads/new ${zero}\n`,
			),
		).toEqual(["remotesha...localsha", "origin/master...HEAD"]);
	});

	it.each([
		[
			"update first",
			"refs/heads/updated localsha refs/heads/updated remotesha\n" +
				`refs/heads/new-branch newlocal refs/heads/new-branch ${zero}\n`,
			["remotesha...localsha", "origin/master...HEAD"],
		],
		[
			"new branch first",
			`refs/heads/new-branch newlocal refs/heads/new-branch ${zero}\n` +
				"refs/heads/updated localsha refs/heads/updated remotesha\n",
			["origin/master...HEAD", "remotesha...localsha"],
		],
	])(
		"unions an update with a new-branch fallback (%s)",
		(_name, stdin, expected) => {
			// F3664-1 recurrence: a mixed push must not lose the normal update when
			// the new-branch fallback appears before or after it.
			expect(resolveDiffRange(stdin)).toEqual(expected);
		},
	);

	it("passes changed files from both mixed-push ranges to selection", () => {
		// F3664-1 witness: main must call changedFiles for both ranges; a
		// ranges.slice(0, 1) mutation must leave one target out of this output.
		fixtureDir = fs.mkdtempSync(path.join(repoRoot, ".tmp-pre-push-test-"));
		process.chdir(fixtureDir);
		const scriptDir = path.join(fixtureDir as string, "scripts");
		fs.symlinkSync(path.join(repoRoot, "scripts"), scriptDir, "dir");
		fs.symlinkSync(
			path.join(repoRoot, "node_modules"),
			path.join(fixtureDir as string, "node_modules"),
			"dir",
		);
		fs.symlinkSync(
			path.join(repoRoot, "vitest.config.ts"),
			path.join(fixtureDir as string, "vitest.config.ts"),
		);
		fs.symlinkSync(
			path.join(repoRoot, "package.json"),
			path.join(fixtureDir as string, "package.json"),
		);
		write("clients/first.ts", "export const first = true;\n");
		write("tests/clients/first.test.ts", "it('first', () => {});\n");
		write("clients/second.ts", "export const second = true;\n");
		write("tests/clients/second.test.ts", "it('second', () => {});\n");
		const git = (args: string[]) =>
			String(gitExecFileSync(args, { cwd: fixtureDir, encoding: "utf8" }));
		git(["init", "--quiet", "--initial-branch=main"]);
		git(["config", "user.name", "pi-lens test"]);
		git(["config", "user.email", "test@example.com"]);
		git(["add", "."]);
		git(["commit", "--quiet", "-m", "base"]);
		const base = git(["rev-parse", "HEAD"]).trim();
		git(["update-ref", "refs/remotes/origin/master", base]);
		write("clients/first.ts", "export const first = false;\n");
		git(["add", "clients/first.ts"]);
		git(["commit", "--quiet", "-m", "first"]);
		const first = git(["rev-parse", "HEAD"]).trim();
		write("clients/second.ts", "export const second = false;\n");
		git(["add", "clients/second.ts"]);
		git(["commit", "--quiet", "-m", "second"]);
		const second = git(["rev-parse", "HEAD"]).trim();

		const result = spawnSync(
			process.execPath,
			[
				path.join(repoRoot, "scripts/pre-push-targeted-tests.mjs"),
				"--skip-build",
			],
			{
				cwd: fixtureDir,
				encoding: "utf8",
				input: `refs/heads/first ${first} refs/heads/first ${base}\nrefs/heads/new ${second} refs/heads/new ${zero}\n`,
			},
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("tests/clients/first.test.ts");
		expect(result.stdout).toContain("tests/clients/second.test.ts");
	});
});

describe("selectTargetedTests — path-mirror pass", () => {
	it("selects the registered tree scanners for production changes", () => {
		enterFixture();
		for (const test of TREE_SCANNING_GOVERNANCE_TESTS)
			write(test, "it('governance');\n");
		write("clients/review-graph/git-identity.ts", "export {}\n");

		const result = selectTargetedTests(
			["clients/review-graph/git-identity.ts"],
			collectTestFiles("tests"),
		);

		// Prevents tree scanners from disappearing from a production-file push
		// because they do not import the changed module (#3426).
		expect(changesProductionFile("clients/review-graph/git-identity.ts")).toBe(
			true,
		);
		expect(result.selected).toEqual(TREE_SCANNING_GOVERNANCE_TESTS);
	});

	it("arms the registry for tools, mcp, scripts, and the root index", () => {
		for (const file of ["tools/x.ts", "mcp/x.ts", "scripts/x.mjs", "index.ts"])
			expect(changesProductionFile(file)).toBe(true);
	});

	it("selects the exact mirrored test path for a changed source file", () => {
		enterFixture();
		write("clients/foo/bar.ts", "export const x = 1;\n");
		write(
			"tests/clients/foo/bar.test.ts",
			"import { x } from '../../../clients/foo/bar.js';\n",
		);

		const allTests = collectTestFiles("tests");
		const result = selectTargetedTests(["clients/foo/bar.ts"], allTests);

		expect(result.selected).toEqual(["tests/clients/foo/bar.test.ts"]);
		expect(result.unmatched).toEqual([]);
		expect(result.capped).toBe(false);
	});

	it("defers a CI-only real-spawn suite to CI and reports it (#3426 H3432-1)", () => {
		enterFixture();
		const ciOnlyFile = Object.keys(CI_ONLY_PRE_PUSH_TESTS)[0];
		expect(ciOnlyFile).toBeDefined();
		write(ciOnlyFile as string, "it('hook', () => {});\n");

		const allTests = collectTestFiles("tests");
		const prePush = selectTargetedTests([ciOnlyFile as string], allTests);
		// The budget-busting suite never enters the local pre-push selection…
		expect(prePush.selected).toEqual([]);
		// …and its deferral is disclosed, never silently dropped.
		expect(prePush.excludedCiOnly).toEqual([ciOnlyFile]);
		expect(prePush.capped).toBe(false);

		// The CI job admits it through the same production entry point.
		const ci = selectTargetedTests([ciOnlyFile as string], allTests, {
			includeCiOnly: true,
		});
		expect(ci.selected).toEqual([ciOnlyFile]);
		expect(ci.excludedCiOnly).toEqual([]);
	});

	// #3472 recurrence (#3492, 2026-09-26): a new test's real 60 s setTimeout
	// pushed with the flake-shape ratchet red, because the ratchet scans the
	// tests tree and neither the mirror nor the import pass selects it. The
	// changed files are 0b5cb182a's own.
	it("arms the tests-tree ratchet when a pushed change touches the tests tree", () => {
		enterFixture();
		for (const test of TEST_TREE_GOVERNANCE_TESTS)
			write(test, "it('ratchet');\n");
		write("clients/lsp/client.ts", "export {}\n");
		write("tests/clients/lsp/diagnostics-fence.test.ts", "it('x');\n");

		const changed = [
			".changelog/3484-fence-hold-record.md",
			"clients/lsp/client.ts",
			"tests/clients/lsp/diagnostics-fence.test.ts",
		];
		const result = selectTargetedTests(changed, collectTestFiles("tests"));

		expect(TEST_TREE_GOVERNANCE_TESTS).toContain(
			"tests/clients/flake-shape-ratchet.test.ts",
		);
		expect([...result.selected].sort()).toEqual(
			[
				"tests/clients/lsp/diagnostics-fence.test.ts",
				...TEST_TREE_GOVERNANCE_TESTS,
			].sort(),
		);
		// A support-module change reaches the ratchet too: it counts helpers
		// under tests/support (the #2885 never-settling-promise detector).
		expect(changesTestTreeFile("tests/support/fake-child.ts")).toBe(true);
		expect(
			selectTargetedTests(
				["tests/support/fake-child.ts"],
				collectTestFiles("tests"),
			).selected,
		).toEqual(TEST_TREE_GOVERNANCE_TESTS);
	});

	it("leaves the tests-tree ratchet out of a push that touches no test file", () => {
		enterFixture();
		for (const test of TEST_TREE_GOVERNANCE_TESTS)
			write(test, "it('ratchet');\n");
		write("clients/foo/bar.ts", "export const x = 1;\n");

		const allTests = collectTestFiles("tests");
		expect(changesTestTreeFile("clients/foo/bar.ts")).toBe(false);
		expect(changesTestTreeFile("docs/tests/x.md")).toBe(false);
		expect(
			selectTargetedTests(["clients/foo/bar.ts"], allTests).selected,
		).toEqual([]);
		expect(selectTargetedTests(["docs/tests/x.md"], allTests).selected).toEqual(
			[],
		);
	});

	it("always includes a changed test file itself", () => {
		enterFixture();
		write("tests/clients/foo/bar.test.ts", "it('x', () => {});\n");

		const allTests = collectTestFiles("tests");
		const result = selectTargetedTests(
			["tests/clients/foo/bar.test.ts"],
			allTests,
		);

		expect(result.selected).toEqual(["tests/clients/foo/bar.test.ts"]);
	});
});

describe("selectTargetedTests — import-resolution pass (full path, not basename)", () => {
	it("selects a sibling test file that imports the changed module by its real path", () => {
		enterFixture();
		write("clients/foo/bar.ts", "export const x = 1;\n");
		// No mirrored tests/clients/foo/bar.test.ts — only a differently-named
		// sibling that imports it, the shared-seam-wiring-test shape.
		write(
			"tests/wiring-suite.test.ts",
			"import { x } from '../clients/foo/bar.js';\n",
		);

		const allTests = collectTestFiles("tests");
		const result = selectTargetedTests(["clients/foo/bar.ts"], allTests);

		expect(result.selected).toEqual(["tests/wiring-suite.test.ts"]);
	});

	it("does NOT select a test file that merely shares the changed file's basename in a different directory (the #1804 review regression)", () => {
		enterFixture();
		// Two files named `bar.ts` in different directories — the exact shape
		// that broke the old basename-substring matcher: `/${base}` matched
		// both `clients/foo/bar` and `clients/other/bar` imports alike.
		write("clients/foo/bar.ts", "export const x = 1;\n");
		write("clients/other/bar.ts", "export const y = 2;\n");
		write(
			"tests/clients/foo/bar.test.ts",
			"import { x } from '../../../clients/foo/bar.js';\n",
		);

		const allTests = collectTestFiles("tests");
		// Changing clients/other/bar.ts must NOT pull in
		// tests/clients/foo/bar.test.ts — that test never imports
		// clients/other/bar at all, it only shares the basename "bar".
		const result = selectTargetedTests(["clients/other/bar.ts"], allTests);

		expect(result.selected).toEqual([]);
		expect(result.unmatched).toEqual(["clients/other/bar.ts"]);
	});

	it("resolves .js import specifiers against a .ts changed file (compiled-output convention)", () => {
		enterFixture();
		write("clients/foo/bar.ts", "export const x = 1;\n");
		write(
			"tests/clients/foo/other-name.test.ts",
			"import { x } from '../../../clients/foo/bar.js';\n",
		);

		const allTests = collectTestFiles("tests");
		const result = selectTargetedTests(["clients/foo/bar.ts"], allTests);

		expect(result.selected).toEqual(["tests/clients/foo/other-name.test.ts"]);
	});
});

describe("selectTargetedTests — the >25-file cap (F1)", () => {
	it("degrades to build-only (empty selection, capped=true) once matches exceed MAX_SELECTED_TESTS", () => {
		enterFixture();
		write("clients/shared.ts", "export const shared = 1;\n");

		const testCount = MAX_SELECTED_TESTS + 1;
		for (let i = 0; i < testCount; i++) {
			write(
				`tests/generated-${i}.test.ts`,
				`import { shared } from '../clients/shared.js';\n`,
			);
		}

		const allTests = collectTestFiles("tests");
		expect(allTests.length).toBe(testCount);

		const result = selectTargetedTests(["clients/shared.ts"], allTests);

		// Mutation-proof: if the cap check were removed or off-by-one'd the
		// wrong way, `selected` would contain all `testCount` entries and
		// `capped` would read false — this assertion goes red on either.
		expect(result.capped).toBe(true);
		expect(result.selected).toEqual([]);
		expect(result.totalBeforeCap).toBe(testCount);
	});

	// #3492 (2026-09-26): 0b5cb182a changed clients/lsp/client.ts, which 71
	// test files match, so the heuristic selection capped and the hook ran
	// NOTHING; the raw 60 s timer it added reached CI. The registries are
	// bounded by construction, so a capped push still runs them.
	it("still runs the armed governance registries when the heuristic selection caps", () => {
		enterFixture();
		for (const test of [
			...TREE_SCANNING_GOVERNANCE_TESTS,
			...TEST_TREE_GOVERNANCE_TESTS,
		])
			write(test, "it('governance');\n");
		write("clients/lsp/client.ts", "export const shared = 1;\n");
		for (let i = 0; i < MAX_SELECTED_TESTS + 1; i++) {
			write(
				`tests/clients/lsp/generated-${i}.test.ts`,
				`import { shared } from '../../../clients/lsp/client.js';\n`,
			);
		}
		write("tests/clients/lsp/diagnostics-fence.test.ts", "it('x');\n");

		const result = selectTargetedTests(
			[
				".changelog/3484-fence-hold-record.md",
				"clients/lsp/client.ts",
				"tests/clients/lsp/diagnostics-fence.test.ts",
			],
			collectTestFiles("tests"),
		);

		expect(result.capped).toBe(true);
		expect([...result.selected].sort()).toEqual(
			[...TREE_SCANNING_GOVERNANCE_TESTS, ...TEST_TREE_GOVERNANCE_TESTS].sort(),
		);
		// The registries never push the heuristic selection over the cap.
		for (let i = MAX_SELECTED_TESTS - 1; i <= MAX_SELECTED_TESTS + 1; i++)
			fs.rmSync(`tests/clients/lsp/generated-${i}.test.ts`, { force: true });
		const underCap = selectTargetedTests(
			["clients/lsp/client.ts", "tests/clients/lsp/diagnostics-fence.test.ts"],
			collectTestFiles("tests"),
		);
		expect(underCap.capped).toBe(false);
		expect(underCap.selected).toContain(
			"tests/clients/lsp/generated-0.test.ts",
		);
	});

	it("does not cap when the match count is exactly at the limit", () => {
		enterFixture();
		write("clients/shared.ts", "export const shared = 1;\n");

		for (let i = 0; i < MAX_SELECTED_TESTS; i++) {
			write(
				`tests/generated-${i}.test.ts`,
				`import { shared } from '../clients/shared.js';\n`,
			);
		}

		const allTests = collectTestFiles("tests");
		const result = selectTargetedTests(["clients/shared.ts"], allTests);

		expect(result.capped).toBe(false);
		expect(result.selected.length).toBe(MAX_SELECTED_TESTS);
	});
});

describe("selectTargetedTests — no-match fallback (F7)", () => {
	it("reports a changed file with no covering test as unmatched, selects nothing for it", () => {
		enterFixture();
		write("clients/orphan.ts", "export const o = 1;\n");
		write("tests/clients/unrelated.test.ts", "it('x', () => {});\n");

		const allTests = collectTestFiles("tests");
		const result = selectTargetedTests(["clients/orphan.ts"], allTests);

		expect(result.selected).toEqual([]);
		expect(result.unmatched).toEqual(["clients/orphan.ts"]);
		expect(result.capped).toBe(false);
	});
});

describe(".husky hooks — PI_LENS_SKIP_HOOKS accepts any non-empty value (F8)", () => {
	it("pre-commit formats only staged files through the pinned binary (#3426)", () => {
		const hook = fs.readFileSync(
			path.join(repoRoot, ".husky/pre-commit"),
			"utf8",
		);
		expect(hook).toContain(
			"git diff --cached --name-only --diff-filter=ACMR -z",
		);
		expect(hook).toContain(
			"npx --no-install oxfmt --check --no-error-on-unmatched-pattern",
		);
		expect(hook).not.toContain("npm install oxfmt --no-save");
	});

	it.each(["1", "true"])(
		"pre-commit exits 0 and skips without running checks when PI_LENS_SKIP_HOOKS=%s",
		(value) => {
			const result = spawnSync("sh", [".husky/pre-commit"], {
				cwd: repoRoot,
				env: { ...process.env, PI_LENS_SKIP_HOOKS: value },
				encoding: "utf8",
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("[pre-commit] skipped");
		},
	);

	it.each(["1", "true"])(
		"pre-push exits 0 and skips without running the targeted-test script when PI_LENS_SKIP_HOOKS=%s",
		(value) => {
			const result = spawnSync("sh", [".husky/pre-push"], {
				cwd: repoRoot,
				env: { ...process.env, PI_LENS_SKIP_HOOKS: value },
				encoding: "utf8",
				input: "",
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("[pre-push] skipped");
		},
	);
});

// #3886: the pre-push self-scan now lives INSIDE scripts/pre-push-targeted-tests.mjs,
// after its build (the scan imports compiled `clients/` modules) and after the
// deletion-only early return, and is skipped under --skip-build. These cases
// drive the real `.husky/pre-push` -> wrapper chain with the real `npm`
// executable resolving fixture package.json scripts, so a fake npm that
// ignores argv can no longer hide an ordering or resolution defect (r1 S2).
describe("pre-push ast-grep self-scan (#3886)", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0))
			fs.rmSync(root, { recursive: true, force: true });
	});

	function git(root: string, ...args: string[]): string {
		return String(
			gitExecFileSync(
				[
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@example.com",
					"-c",
					"commit.gpgsign=false",
					...args,
				],
				{ cwd: root, encoding: "utf8" },
			),
		).trim();
	}

	function put(root: string, rel: string, content: string) {
		const full = path.join(root, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf8");
	}

	/** Copies the hook + wrapper, links `node_modules`, and runs the case with a
	 * scrubbed env (no ambient PI_LENS_* / VITEST). `input` is the git ref line
	 * a real pre-push receives on stdin. */
	function runHook(root: string, input: string) {
		const home = path.join(root, "home");
		fs.mkdirSync(home, { recursive: true });
		const env = envFor(root);
		for (const key of Object.keys(env))
			if (
				/^(VITEST|PI_LENS_|PILENS_|NODE_OPTIONS$|GITHUB_STEP_SUMMARY$)/.test(
					key,
				)
			)
				delete env[key];
		Object.assign(env, {
			PI_LENS_HOME: home,
			PI_LENS_TEST_LOCK_TIMEOUT_MS: "300",
			PATH: `${path.join(repoRoot, "node_modules/.bin")}:${env.PATH ?? ""}`,
		});
		return spawnSync("sh", [".husky/pre-push"], {
			cwd: root,
			env,
			encoding: "utf8",
			input,
		});
	}

	/** Sources the hook + wrapper from this tree and a `build` stub that writes
	 * `built.marker`. `astgrep:self-scan` refuses to run before that marker
	 * exists, so the test observes the real build-before-scan ordering through
	 * real npm resolution. */
	function makeOrderingFixture() {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-prepush-scan-order-"),
		);
		roots.push(root);
		for (const rel of [
			".husky/pre-push",
			"scripts/pre-push-targeted-tests.mjs",
			"scripts/with-test-lock.mjs",
			"scripts/lib/suite-lock.mjs",
		])
			put(root, rel, fs.readFileSync(path.join(repoRoot, rel), "utf8"));
		put(
			root,
			"scan.mjs",
			[
				'import fs from "node:fs";',
				'if (!fs.existsSync("built.marker")) {',
				'  console.error("[scan] refused: build marker missing");',
				"  process.exit(1);",
				"}",
				'console.log("[scan] ran after build");',
				"",
			].join("\n"),
		);
		put(
			root,
			"package.json",
			JSON.stringify({
				scripts: {
					build:
						"node -e \"require('node:fs').writeFileSync('built.marker','1')\"",
					"astgrep:self-scan": "node scan.mjs",
				},
			}),
		);
		fs.symlinkSync(
			path.join(repoRoot, "node_modules"),
			path.join(root, "node_modules"),
			"junction",
		);
		git(root, "init", "-q");
		git(root, "add", ".husky", "scripts", "package.json", "scan.mjs");
		git(root, "commit", "-q", "-m", "base");
		const base = git(root, "rev-parse", "HEAD");
		put(root, "docs/readme.md", "# docs\n");
		git(root, "add", "docs");
		git(root, "commit", "-q", "-m", "docs");
		const head = git(root, "rev-parse", "HEAD");
		return { root, refs: `refs/heads/t ${head} refs/heads/t ${base}\n` };
	}

	it("builds before the self-scan: an unbuilt tree on a docs-only push exits 0", () => {
		const fx = makeOrderingFixture();
		const result = runHook(fx.root, fx.refs);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("[scan] ran after build");
		expect(fs.existsSync(path.join(fx.root, "built.marker"))).toBe(true);
	});

	it("a deletion-only push exits 0 before the build or the self-scan", () => {
		const fx = makeOrderingFixture();
		const zero = "0".repeat(40);
		const result = runHook(
			fx.root,
			`(delete) ${zero} refs/heads/gone abc123\n`,
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain(
			"deletion-only push; skipping build and tests",
		);
		expect(fs.existsSync(path.join(fx.root, "built.marker"))).toBe(false);
	});

	const VIOLATION = [
		'import { writeFileSync } from "node:fs";',
		"function f(file: string, data: unknown) {",
		"  writeFileSync(file, JSON.stringify(data));",
		"}",
		"",
	].join("\n");

	/** A git fixture that runs the REAL scan: copied scan scripts, the compiled
	 * `clients/` modules the lib imports, the shipped `rules/` symlinked, and a
	 * `package.json` whose `astgrep:self-scan` runs the real wrapper. */
	function makeRealScanFixture({ plantTracked }: { plantTracked: boolean }) {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-prepush-scan-real-"),
		);
		roots.push(root);
		for (const rel of [
			".husky/pre-push",
			"scripts/pre-push-targeted-tests.mjs",
			"scripts/with-test-lock.mjs",
			"scripts/lib/suite-lock.mjs",
			"scripts/run-astgrep-pi-lens.mjs",
			"scripts/lib/astgrep-self-scan.mjs",
			"scripts/lib/git-fixture-env.mjs",
		])
			put(root, rel, fs.readFileSync(path.join(repoRoot, rel), "utf8"));
		put(root, "clients/clean.ts", "export const clean = 1;\n");
		put(root, "tests/clean.test.ts", "export const t = 1;\n");
		// The scan lib imports compiled clients/; symlink the real twins so their
		// own relative imports resolve in the real tree. Only clients/clean.ts is
		// tracked, so tracked-file enumeration stays legible.
		fs.symlinkSync(
			path.join(repoRoot, "clients/safe-spawn.js"),
			path.join(root, "clients/safe-spawn.js"),
		);
		fs.symlinkSync(
			path.join(repoRoot, "clients/string-utils.js"),
			path.join(root, "clients/string-utils.js"),
		);
		fs.symlinkSync(
			path.join(repoRoot, "rules"),
			path.join(root, "rules"),
			"dir",
		);
		fs.symlinkSync(
			path.join(repoRoot, "node_modules"),
			path.join(root, "node_modules"),
			"junction",
		);
		put(
			root,
			"package.json",
			JSON.stringify({
				scripts: {
					build: 'node -e "process.exit(0)"',
					"astgrep:self-scan": "node scripts/run-astgrep-pi-lens.mjs",
				},
			}),
		);
		git(root, "init", "-q");
		git(root, "add", ".husky", "scripts", "package.json", "clients", "tests");
		git(root, "commit", "-q", "-m", "base");
		const base = git(root, "rev-parse", "HEAD");
		put(root, "clients/planted.ts", VIOLATION);
		if (plantTracked) git(root, "add", "clients/planted.ts");
		put(root, "clients/clean.ts", "export const clean = 2;\n");
		git(root, "add", "clients/clean.ts");
		git(root, "commit", "-q", "-m", "head");
		const head = git(root, "rev-parse", "HEAD");
		return { root, refs: `refs/heads/t ${head} refs/heads/t ${base}\n` };
	}

	it("blocks a push with a self-scan finding in a tracked file", () => {
		const fx = makeRealScanFixture({ plantTracked: true });
		// The guard lives in the wrapper now, so drive the wrapper directly: a
		// green pre-fix run proves the scan was not reached from the hook's old
		// position alone.
		const result = spawnSync(
			process.execPath,
			["scripts/pre-push-targeted-tests.mjs"],
			{ cwd: fx.root, encoding: "utf8", input: fx.refs, env: envFor(fx.root) },
		);
		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(
			/no-raw-json-store-write .*clients\/planted\.ts/,
		);
	});

	it("does not block on an untracked planted file", () => {
		const fx = makeRealScanFixture({ plantTracked: false });
		// Drive the hook so the current-head scan's whole-directory walk would
		// see the untracked plant; the fix must not.
		const result = runHook(fx.root, fx.refs);
		expect(result.status).toBe(0);
	});

	it("--skip-build skips the build and the self-scan", () => {
		const fx = makeOrderingFixture();
		// The scan stub refuses to run before `built.marker` exists, so a scan
		// that leaks out of the build branch reds here instead of staying a
		// vacuous "skipped under --skip-build" claim.
		const result = spawnSync(
			process.execPath,
			["scripts/pre-push-targeted-tests.mjs", "--skip-build"],
			{ cwd: fx.root, encoding: "utf8", input: fx.refs, env: envFor(fx.root) },
		);
		expect(result.status).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).not.toContain("[scan]");
		expect(fs.existsSync(path.join(fx.root, "built.marker"))).toBe(false);
	});
});

// #3717 recurrence: a busy machine-wide test lock made pre-push exit 0 without
// running the targeted tests, silently. Every case drives the REAL
// `.husky/pre-push` -> `pre-push-targeted-tests.mjs` -> `with-test-lock.mjs`
// chain inside a throwaway git fixture (copied scripts, a stub `npm run build`,
// one mirrored test), so the cases hold in CI's shape: a depth-1 checkout (no
// `HEAD^` of the live repo is read), `PI_LENS_TEST_NO_LOCK=1` in the ambient
// env (stripped from the child, or the hook would run the tests unlocked and
// recurse into this file), and no `tsc` rewrite of the shared tree.
describe("pre-push lock admission (#3717)", () => {
	const roots: string[] = [];

	beforeEach(() => {
		// CI's shape: the ambient env carries the no-lock switch.
		vi.stubEnv("PI_LENS_TEST_NO_LOCK", "1");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const root of roots.splice(0))
			fs.rmSync(root, { recursive: true, force: true });
	});

	const PASSING_TEST =
		'import { expect, it } from "vitest";\nit("ok", () => { expect(1).toBe(1); });\n';

	// Stands in for scripts/with-test-lock.mjs only where a case must observe
	// the bound the hook hands it without waiting that long: it prints the line
	// the real wrapper prints, carrying the bound it received.
	const STUB_LOCK = `import path from "node:path";
import { fileURLToPath } from "node:url";
export function quoteForWindowsCmd(arg) { return arg; }
if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.error(\`[with-test-lock] timed out after \${process.env.PI_LENS_TEST_LOCK_TIMEOUT_MS}ms waiting for test-suite lock held by PID 4242 since 2026-01-01T00:00:00.000Z\`);
	process.exitCode = 1;
}
`;

	// A wrapper killed by a signal exits with a null code.
	const KILLED_LOCK = `import path from "node:path";
import { fileURLToPath } from "node:url";
export function quoteForWindowsCmd(arg) { return arg; }
if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.kill(process.pid, "SIGKILL");
`;

	function makeFixture(
		testSource = PASSING_TEST,
		stubLock: string | false = false,
	) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-prepush-fx-"));
		roots.push(root);
		const put = (rel: string, content: string) => {
			const full = path.join(root, rel);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, content, "utf8");
		};
		for (const rel of [
			".husky/pre-push",
			"scripts/pre-push-targeted-tests.mjs",
			"scripts/with-test-lock.mjs",
			"scripts/lib/suite-lock.mjs",
		])
			put(rel, fs.readFileSync(path.join(repoRoot, rel), "utf8"));
		if (stubLock) put("scripts/with-test-lock.mjs", stubLock);
		put(
			"package.json",
			JSON.stringify({
				scripts: {
					build:
						"node -e \"require('node:fs').writeFileSync('built.marker','1')\"",
					"astgrep:self-scan": 'node -e "process.exit(0)"',
				},
			}),
		);
		fs.symlinkSync(
			path.join(repoRoot, "node_modules"),
			path.join(root, "node_modules"),
			"junction",
		);
		const git = (...args: string[]) =>
			String(
				gitExecFileSync(
					[
						"-c",
						"user.name=t",
						"-c",
						"user.email=t@example.com",
						"-c",
						"commit.gpgsign=false",
						...args,
					],
					{ cwd: root, encoding: "utf8" },
				),
			).trim();
		git("init", "-q");
		git("add", ".husky", "scripts", "package.json");
		git("commit", "-q", "-m", "base");
		const base = git("rev-parse", "HEAD");
		put("clients/x.ts", "export const x = 1;\n");
		put("tests/clients/x.test.ts", testSource);
		git("add", "clients", "tests");
		git("commit", "-q", "-m", "change");
		const head = git("rev-parse", "HEAD");
		const home = path.join(root, "home");
		fs.mkdirSync(home);
		return {
			root,
			home,
			lockPath: path.join(home, "test-suite.lock"),
			logPath: path.join(home, "pre-push.log"),
			refs: `refs/heads/t ${head} refs/heads/t ${base}\n`,
		};
	}

	function runHook(
		fx: ReturnType<typeof makeFixture>,
		extra: Record<string, string | undefined> = {},
	) {
		const env = envFor(fx.root);
		for (const key of Object.keys(env))
			if (
				/^(VITEST|PI_LENS_|PILENS_|NODE_OPTIONS$|GITHUB_STEP_SUMMARY$)/.test(
					key,
				)
			)
				delete env[key];
		Object.assign(env, {
			PI_LENS_HOME: fx.home,
			PI_LENS_TEST_LOCK_POLL_MS: "10",
			PI_LENS_TEST_LOCK_TIMEOUT_MS: "300",
			...extra,
		});
		for (const [key, value] of Object.entries(extra))
			if (value === undefined) delete env[key];
		return spawnSync("sh", [".husky/pre-push"], {
			cwd: fx.root,
			env,
			encoding: "utf8",
			input: fx.refs,
		});
	}

	// The wrapper's own mirrored stderr already carries the holder text, so the
	// message under test is the hook's `[pre-push]` line alone.
	function busyLine(result: { stderr: string }) {
		return (
			result.stderr
				.split("\n")
				.find((line) => line.startsWith("[pre-push] test lock busy")) ?? ""
		);
	}

	function holdExclusiveLock(fx: ReturnType<typeof makeFixture>) {
		// This test process is alive, so the lock is a live holder without a
		// second process or a scheduling wait.
		fs.writeFileSync(
			fx.lockPath,
			JSON.stringify({
				pid: process.pid,
				startedIso: "2026-01-01T00:00:00.000Z",
			}),
		);
	}

	it("runs the selected test and builds inside the fixture when the lock is free", () => {
		const fx = makeFixture();
		const result = runHook(fx);
		expect(result.stderr).not.toContain("test lock busy");
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("running 1 targeted test file(s)");
		expect(fs.existsSync(path.join(fx.root, "built.marker"))).toBe(true);
	}, 60_000);

	it("blocks a busy exclusive lock, names the holder, lock path, bound and opt-out, and records nothing", () => {
		const fx = makeFixture();
		holdExclusiveLock(fx);
		const result = runHook(fx);
		expect(result.status).toBe(1);
		expect(busyLine(result)).toContain("test lock busy after 0.3 s");
		expect(busyLine(result)).toContain(
			`(exclusive test-suite lock held by PID ${process.pid} since 2026-01-01T00:00:00.000Z)`,
		);
		expect(busyLine(result)).toContain(fx.lockPath);
		expect(busyLine(result)).toContain("PI_LENS_PREPUSH_LOCK_SKIP=1 git push");
		expect(busyLine(result)).toContain("PI_LENS_TEST_LOCK_TIMEOUT_MS=");
		expect(fs.existsSync(fx.logPath)).toBe(false);
	});

	it("blocks when every shared slot is busy and says how many there are", () => {
		// #3717 F4: the common contention is other lanes' shared slots, which
		// carry no exclusive-holder line to quote. #3839: the hook now takes a
		// shared slot itself, so the wait it reports is the slot ceiling (2).
		const fx = makeFixture();
		for (const index of [0, 1])
			fs.writeFileSync(
				path.join(fx.home, `test-suite.slot-${index}.lock`),
				JSON.stringify({
					pid: process.pid,
					startedIso: "2026-01-01T00:00:00.000Z",
				}),
			);
		const result = runHook(fx);
		expect(result.status).toBe(1);
		expect(busyLine(result)).toContain("(all 2 shared slot(s) busy)");
		// #3839 review B: a slot block names no PID, and the stuck file to delete
		// is a slot file, not the exclusive lock the old hint pointed at.
		expect(busyLine(result)).toContain(
			path.join(fx.home, "test-suite.slot-N.lock"),
		);
		expect(busyLine(result)).not.toContain(fx.lockPath);
		expect(busyLine(result)).toContain("PI_LENS_PREPUSH_LOCK_SKIP=1");
	});

	// #3839 recurrence: the hook took the EXCLUSIVE lock for a named-file
	// batch (history: hook 08-20, shared slots 09-02, never migrated), so one
	// other agent's `test:targeted` made a push wait or fail at the 120 s
	// bound, and a push stalled every other targeted run. The probe below runs
	// INSIDE the hook's own vitest run, so every wrapper it spawns meets the
	// lock state the hook really holds: no wall-clock wait, no sleeping holder.
	const CONCURRENCY_PROBE = `import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { it } from "vitest";
it("probes the lock the hook holds", () => {
	const wrap = (...flags) => spawnSync(process.execPath, ["scripts/with-test-lock.mjs", ...flags, "--", process.execPath, "-e", "0", "tests/x.test.ts"], { encoding: "utf8", env: process.env });
	const exclusive = wrap();
	const shared = wrap("--shared");
	fs.writeFileSync("probe.json", JSON.stringify({ exclusive: { status: exclusive.status, stderr: exclusive.stderr }, shared: { status: shared.status, stderr: shared.stderr } }));
});
`;

	it("admits the hook beside another shared holder; a full-suite run and a third shared run both wait for them (#3839)", () => {
		const fx = makeFixture(CONCURRENCY_PROBE);
		// Another lane's targeted run, already inside slot 0 (this test process
		// is alive, so the slot is a live holder).
		fs.writeFileSync(
			path.join(fx.home, "test-suite.slot-0.lock"),
			JSON.stringify({
				pid: process.pid,
				startedIso: "2026-01-01T00:00:00.000Z",
			}),
		);
		const result = runHook(fx);
		expect(result.stderr).not.toContain("test lock busy");
		expect(result.status).toBe(0);
		const probe = JSON.parse(
			fs.readFileSync(path.join(fx.root, "probe.json"), "utf8"),
		);
		// A full-suite run still excludes the hook: it drains the slots and finds
		// slot 0 (the other lane) and slot 1 (the hook) busy.
		expect(probe.exclusive.status).toBe(1);
		expect(probe.exclusive.stderr).toContain(
			"timed out after 300ms waiting for test-suite lock: 2 of 2 shared slot(s) still busy",
		);
		// The hook took a slot, not the machine, and the ceiling still holds: a
		// third shared run finds both slots taken.
		expect(probe.shared.status).toBe(1);
		expect(probe.shared.stderr).toContain(
			"timed out after 300ms waiting for test-suite lock: all 2 shared slot(s) busy",
		);
	}, 60_000);

	it("PI_LENS_PREPUSH_LOCK_SKIP=1 exits 0 with a warning and appends one durable record", () => {
		const fx = makeFixture();
		holdExclusiveLock(fx);
		const result = runHook(fx, { PI_LENS_PREPUSH_LOCK_SKIP: "1" });
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("WARNING: PI_LENS_PREPUSH_LOCK_SKIP=1");
		expect(result.stderr).toContain(fx.logPath);
		expect(result.stderr).toContain("after 0.3 s");
		const lines = fs.readFileSync(fx.logPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]);
		expect(record).toMatchObject({
			event: "lock-skip",
			waitedMs: 300,
			lockPath: fx.lockPath,
			selected: 1,
		});
		expect(record.holder).toContain(`PID ${process.pid}`);
		expect(typeof record.ts).toBe("string");
	});

	it.each(["true", "0", "yes"])(
		"PI_LENS_PREPUSH_LOCK_SKIP=%s is not the opt-out: the push stays blocked and nothing is recorded",
		(value) => {
			const fx = makeFixture();
			holdExclusiveLock(fx);
			const result = runHook(fx, { PI_LENS_PREPUSH_LOCK_SKIP: value });
			expect(result.status).toBe(1);
			expect(result.stderr).not.toContain("WARNING");
			expect(fs.existsSync(fx.logPath)).toBe(false);
		},
	);

	it.each([
		["unset", undefined, "120 s"],
		["zero", "0", "120 s"],
		["leading zeros", "00", "120 s"],
		["garbage", "abc", "120 s"],
		["negative", "-5", "120 s"],
		["fractional", "1.5", "120 s"],
		["positive override", "2500", "2.5 s"],
	])(
		"hands the wrapper a real bound: %s falls back or passes through (%s -> %s)",
		(_name, value, printed) => {
			// #3717 F2: the hook let an ambient 0/garbage through, which the
			// wrapper reads as "wait forever". The stub wrapper echoes the bound
			// it received in the real wrapper's own message shape.
			const fx = makeFixture(PASSING_TEST, STUB_LOCK);
			const result = runHook(fx, { PI_LENS_TEST_LOCK_TIMEOUT_MS: value });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`test lock busy after ${printed}`);
		},
	);

	it("a failing test that quotes the lock-timeout text is a test failure, not a lock timeout", () => {
		// #3717 F5: the classifier matched the whole stderr buffer, so vitest's
		// own failure output quoting the wrapper's text was read as contention,
		// and the opt-out then turned a failing test into exit 0.
		const fx = makeFixture(
			'import { expect, it } from "vitest";\nit("quotes", () => { expect("timed out after 100ms waiting for test-suite lock held by PID 1 since x").toBe("something else"); });\n',
		);
		const plain = runHook(fx);
		expect(plain.status).toBe(1);
		expect(plain.stderr).not.toContain("test lock busy");
		const optedOut = runHook(fx, { PI_LENS_PREPUSH_LOCK_SKIP: "1" });
		expect(optedOut.status).toBe(1);
		expect(optedOut.stderr).not.toContain("WARNING");
		expect(fs.existsSync(fx.logPath)).toBe(false);
	}, 60_000);

	it("a failing test that prints the wrapper's timeout line at a line start is a test failure, not a lock timeout", () => {
		// #3738 (residual of #3717): the classifier matched ANY stderr line
		// starting `[with-test-lock] `, so a failing test printing that exact
		// prefix was read as contention and PI_LENS_PREPUSH_LOCK_SKIP=1 then
		// pushed a red test. A real lock timeout is wrapper-only stderr.
		const fx = makeFixture(
			'import fs from "node:fs";\nimport { expect, it } from "vitest";\nit("prints then fails", () => { fs.writeSync(2, "[with-test-lock] timed out after 5ms waiting for test-suite lock held by PID 1 since x\\n"); expect(1).toBe(2); });\n',
		);
		const optedOut = runHook(fx, { PI_LENS_PREPUSH_LOCK_SKIP: "1" });
		expect(optedOut.status).toBe(1);
		expect(optedOut.stderr).not.toContain("WARNING");
		expect(busyLine(optedOut)).toBe("");
		expect(fs.existsSync(fx.logPath)).toBe(false);
	}, 60_000);

	it("a wrapper line that only quotes the prefix mid-line is not a lock timeout", () => {
		// #3738 M7: the `^` anchor. Every stderr line here starts with the
		// prefix, so the every-line rule passes and only the anchor separates
		// this quote from the wrapper's own timeout line.
		const quoting = STUB_LOCK.replace(
			"console.error(`[with-test-lock] timed out",
			"console.error(`[with-test-lock] note: [with-test-lock] timed out",
		);
		expect(quoting).not.toBe(STUB_LOCK);
		const fx = makeFixture(PASSING_TEST, quoting);
		const result = runHook(fx, { PI_LENS_PREPUSH_LOCK_SKIP: "1" });
		expect(result.status).toBe(1);
		expect(busyLine(result)).toBe("");
		expect(result.stderr).not.toContain("WARNING");
		expect(fs.existsSync(fx.logPath)).toBe(false);
	});

	it("blocks the push when the locked run is killed by a signal (null exit code)", () => {
		const fx = makeFixture(PASSING_TEST, KILLED_LOCK);
		const result = runHook(fx, { PI_LENS_PREPUSH_LOCK_SKIP: "1" });
		expect(result.status).toBe(1);
		expect(result.stderr).not.toContain("test lock busy");
	});

	it("a passing run whose output quotes the wrapper's timeout line is not a lock timeout", () => {
		// The classifier reads the timeout line only from a failed run: a green
		// run must not be blocked by text it printed itself.
		const fx = makeFixture(
			'import fs from "node:fs";\nimport { expect, it } from "vitest";\nit("prints", () => { fs.writeSync(2, "[with-test-lock] timed out after 5ms waiting for test-suite lock held by PID 1 since x\\n"); expect(1).toBe(1); });\n',
		);
		const result = runHook(fx);
		expect(result.status).toBe(0);
		expect(busyLine(result)).toBe("");
	}, 60_000);

	it("blocks the push, with the reason, when the locked test run cannot start", () => {
		// #3717 recurrence class: master returned 0 ("letting the push proceed")
		// on a spawn error. A preload turns the wrapper spawn into a real ENOENT.
		const fx = makeFixture();
		fs.writeFileSync(
			path.join(fx.root, "spawn-fails.cjs"),
			`const cp = require("node:child_process");
const original = cp.spawn;
if (process.argv[1] && process.argv[1].endsWith("pre-push-targeted-tests.mjs")) {
	cp.spawn = (command, args, options) => original(require("node:path").join(__dirname, "no-such-node"), args, options);
	require("node:module").syncBuiltinESMExports();
}
`,
		);
		const result = runHook(fx, {
			NODE_OPTIONS: `--require ${path.join(fx.root, "spawn-fails.cjs")}`,
			PI_LENS_PREPUSH_LOCK_SKIP: "1",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("could not run targeted tests");
		expect(result.stderr).toContain("push blocked");
	});
});
