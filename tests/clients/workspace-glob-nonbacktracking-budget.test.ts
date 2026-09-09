// flake-shape: elapsed-time-assertion — the defect under test IS wall-clock.
// The compiled whole-path regex gave the right ANSWER for an interleaved
// `**/*` chain; only the time was wrong (124900 ms for a 12-link chain against
// a 40-component path), so no non-clock assertion separates fixed from broken.
// A mocked clock is by construction unfaithful here — it would measure nothing.

/**
 * #2603 — bounded-time pin for the non-backtracking workspace-member matcher.
 *
 * #2591 compiled a workspace-member glob to one anchored regex in which every
 * `**` emitted its own nullable `.+`; its review round 2 collapsed CONSECUTIVE
 * `**` components, which is what upstream `glob` does and what killed the
 * `**\/**\/**` blowup. That collapse cannot fire across a SEPARATING component,
 * so an INTERLEAVED chain kept the full 2^N cost — measured through
 * `detectPythonEnvironment` on this box, pattern `("**\/*" xN)/zzz` against a
 * 40-component non-matching path:
 *
 *   N  | before (regex)  | after (step table)
 *   ---+-----------------+-------------------
 *    4 |        11.9 ms  |  6.9 ms
 *    6 |       195.1 ms  |  2.5 ms
 *    8 |      2999.2 ms  |  2.0 ms
 *   10 |     35096.3 ms  |  2.2 ms
 *   12 |    (>400 s)     |  1.9 ms
 *
 * (uv `exclude`, whose `*` also crosses `/`, did not finish N=4 in five
 * minutes before the fix and answers in 2.0 ms after it.) minimatch, an
 * independent implementation, stayed at 0.1–0.5 ms across the whole range.
 *
 * The budget is asserted through the PRODUCTION path, not the matcher, because
 * that is where the cost is unbounded: `detectPythonEnvironment` is awaited
 * with no timeout by `clients/test-runner-client.ts`,
 * `clients/dispatch/runners/pyright.ts` and `clients/lsp/server.ts`, so a
 * multi-minute match is a wedged turn rather than a slow answer.
 *
 * Budget choice (AGENTS.md "loose bound" screen, applied in both directions):
 * 50 ms is the number the issue's acceptance criterion names. It sits four
 * orders of magnitude below the pre-fix cost — decisive as a red, which the
 * vitest timeout reaches first — and ~20x above the post-fix cost, which is
 * the margin this file buys with its seat in the fully serialized
 * `wall-clock-budget` lane.
 *
 * Both uv dialects are pinned because they are separate matcher
 * configurations: `members` confines `*` to one component
 * (`require_literal_separator: true`), `exclude` does not, and the second was
 * the slower of the two before the fix.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { detectPythonEnvironment } from "../../clients/python-environment.js";

/** Deep enough that a per-`**` blowup is astronomical, shallow enough to build fast. */
const PATH_COMPONENTS = 40;
/** The chain length the issue's acceptance criterion names. */
const INTERLEAVED_LINKS = 12;
const BUDGET_MS = 50;

/** `**\/*\/**\/*\/…/zzz` — a `**` per link, each separated by a `*` component. */
const INTERLEAVED_PATTERN = `${Array(INTERLEAVED_LINKS)
	.fill("**/*")
	.join("/")}/zzz`;

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A workspace root whose `pyproject.toml` is `manifest`, with a project
 * {@link PATH_COMPONENTS} levels below it. Returns the deep project directory
 * and a `homeDir` that is a SIBLING of the tree, never a parent: `findUvWorkspace`
 * stops its walk at or above `homeDir`, so a `homeDir` inside the tree would
 * halt the climb before the workspace manifest is ever read and the matcher
 * would never run — the budget would then pass on broken code. Proven, not
 * assumed: the first version of #2591's budget test did exactly that and stayed
 * GREEN against the pre-fix compiler (AGENTS.md shape 38).
 */
function createDeepWorkspace(manifest: string): {
	root: string;
	nested: string;
	homeDir: string;
} {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-glob-budget-"));
	tempDirs.push(root);
	const nested = path.join(
		root,
		...Array.from({ length: PATH_COMPONENTS }, (_, i) => `d${i}`),
	);
	fs.mkdirSync(nested, { recursive: true });
	fs.writeFileSync(
		path.join(nested, "pyproject.toml"),
		"[project]\nname='nested'\n",
	);
	fs.writeFileSync(path.join(root, "pyproject.toml"), manifest);
	return {
		root,
		nested,
		homeDir: path.join(os.tmpdir(), "pi-lens-glob-budget-absent-home"),
	};
}

describe("non-backtracking workspace-member matcher (#2603)", () => {
	it(`answers a ${INTERLEAVED_LINKS}-link interleaved members glob within ${BUDGET_MS}ms through detectPythonEnvironment`, async () => {
		// The glob cannot match (no component is `zzz`), so the matcher must
		// consider every split before answering — the worst case, and the one a
		// workspace with a deep tree and a typo'd member entry hits.
		const { nested, homeDir } = createDeepWorkspace(
			`[tool.uv.workspace]\nmembers = ['${INTERLEAVED_PATTERN}']\n`,
		);

		const started = performance.now();
		const environment = await detectPythonEnvironment(nested, homeDir);
		const elapsed = performance.now() - started;

		// The ANSWER was never wrong — assert it too, so a "fix" that made the
		// match cheap by making it incorrect cannot pass this file.
		expect(environment).toBeUndefined();
		expect(elapsed).toBeLessThan(BUDGET_MS);
	});

	it(`answers a ${INTERLEAVED_LINKS}-link interleaved exclude glob within ${BUDGET_MS}ms through detectPythonEnvironment`, async () => {
		// `exclude` is the OTHER dialect: its `*` crosses `/`
		// (`require_literal_separator: false`), a separate matcher configuration
		// and the slower of the two before the fix. `!exclude.some(...)` is
		// evaluated before the member globs, so a non-matching exclusion is
		// evaluated in full; the workspace `.venv` in the answer is what proves
		// it did not match.
		const { root, nested, homeDir } = createDeepWorkspace(
			`[tool.uv.workspace]\nmembers = ['**']\nexclude = ['${INTERLEAVED_PATTERN}']\n`,
		);
		const workspaceVenv = path.join(root, ".venv");
		const isWindows = process.platform === "win32";
		const binDir = path.join(workspaceVenv, isWindows ? "Scripts" : "bin");
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(
			path.join(binDir, isWindows ? "python.exe" : "python"),
			"",
		);

		const started = performance.now();
		const environment = await detectPythonEnvironment(nested, homeDir);
		const elapsed = performance.now() - started;

		expect(environment?.source).toBe("uv-workspace");
		expect(environment?.root).toBe(workspaceVenv);
		expect(elapsed).toBeLessThan(BUDGET_MS);
	});
});
