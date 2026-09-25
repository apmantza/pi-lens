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
import { afterEach, describe, expect, it } from "vitest";
import {
	CI_ONLY_PRE_PUSH_TESTS,
	collectTestFiles,
	MAX_SELECTED_TESTS,
	TREE_SCANNING_GOVERNANCE_TESTS,
	changesProductionFile,
	selectTargetedTests,
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
