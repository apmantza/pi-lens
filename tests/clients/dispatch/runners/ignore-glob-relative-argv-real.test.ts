// flake-shape: real-process-spawn — the defect is yamllint's and
// markdownlint-cli2's OWN ignore-glob matching against the path string they are
// handed, so a double has no matcher to model and a shim would not reproduce the
// tool's ignore either.
// lane: a case runs where its binary is on the PATH the runner's lookup walks —
// pip puts yamllint there (`parser-smoke` / `tool-smoke`), and markdownlint-cli2
// is on PATH in a tree that installed it (`npm install --no-save` puts it in
// `node_modules/.bin`; the managed tool tree's `tools/node_modules/.bin` works
// the same way). A lane without one skips that runner visibly below.

/**
 * #5544: `yamllint` and `markdownlint` handed their CLI the ABSOLUTE dispatched
 * path, and both tools match their config's ignore globs against that string. A
 * project whose own ignore names an ancestor of the file it lives in — a lane
 * under `<scratch>/.claude/worktrees/lane1` with `.yamllint` `ignore: .claude/`,
 * Claude Code's own worktree layout — was therefore excluded from its own lint:
 * the tool answered "no files selected", exit 0, and the runner reported
 * `succeeded` with zero findings, a silent clean.
 *
 * Each case plants one byte-identical project twice, once under a `.claude`
 * ancestor and once under a neutral `ctrl` ancestor, and requires the SAME
 * findings from both. That equality cannot be met by two silent runs, because
 * the control run pins a non-empty expected rule set of its own.
 *
 * The spawn cwd is the project root (`resolveRunnerCwd` owns it, unchanged
 * here), so the path the tool must receive is the project-relative one —
 * `actionlint`'s form (`clients/dispatch/runners/actionlint.ts`), the only other
 * runner that already sends it that way.
 */

// order-dependent: false — every case builds its own project pair under this
// file's fixture root, and pins trust before the first run.
import * as fs from "node:fs";
import * as path from "node:path";

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import markdownlintRunner from "../../../../clients/dispatch/runners/markdownlint.js";
import yamllintRunner from "../../../../clients/dispatch/runners/yamllint.js";
import type { RunnerResult } from "../../../../clients/dispatch/types.js";
import { setProjectTrustState } from "../../../../clients/project-trust.js";
import * as safeSpawnModule from "../../../../clients/safe-spawn.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { removeTempDirSync, setupTestEnvironment } from "../../test-utils.js";

const env = setupTestEnvironment("pi-lens-5544-ignore-argv-");
const ROOT = env.tmpDir;

/** The layout pair: one project under an ignored ancestor, one under a neutral. */
const LAYOUTS = {
	ignoredAncestor: path.join(ROOT, ".claude/worktrees/lane1"),
	control: path.join(ROOT, "ctrl/lane1"),
};

/**
 * Plant one project. The YAML fixture violates `document-start` and
 * `trailing-spaces`; the Markdown fixture violates `MD012` twice. So a run that
 * selects the file names findings, and a run that selects nothing has nothing to
 * report for it.
 */
function plant(project: string): void {
	fs.mkdirSync(path.join(project, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(project, ".yamllint"),
		"ignore: |\n  .claude/\n  node_modules/\nrules:\n  document-start: enable\n  trailing-spaces: enable\n",
	);
	fs.writeFileSync(
		path.join(project, ".markdownlint-cli2.jsonc"),
		`${JSON.stringify({ ignores: ["**/.claude/**"] })}\n`,
	);
	fs.writeFileSync(
		path.join(project, "src/bad.yml"),
		"key: value   \nother: 2\n",
	);
	fs.writeFileSync(
		path.join(project, "src/a.md"),
		"# Title\n\n\ntext\n\n\nmore\n",
	);
}

/** Is the binary on the PATH the runner's lookup walks? */
function toolAvailable(binary: string): boolean {
	return (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.some((dir) =>
			[path.join(dir, binary), `${path.join(dir, binary)}.cmd`].some(
				(candidate) => fs.existsSync(candidate),
			),
		);
}

function summary(result: RunnerResult): {
	status: string;
	rules: string[];
	reportedPaths: string[];
} {
	return {
		status: result.status,
		rules: result.diagnostics.map((diagnostic) => diagnostic.rule ?? ""),
		reportedPaths: [...new Set(result.diagnostics.map((d) => d.filePath))],
	};
}

/** The path the tool must receive: the file relative to the spawn cwd. */
function relativeToProject(project: string, file: string): string {
	return path.relative(project, file).split(path.sep).join("/");
}

/** The argv of the one `safeSpawnAsync` call the runner made. */
function spawnArgv(): string[] {
	const calls = vi.mocked(safeSpawnModule.safeSpawnAsync).mock.calls;
	expect(calls).toHaveLength(1);
	return calls[0][1] as string[];
}

beforeAll(() => {
	for (const project of Object.values(LAYOUTS)) plant(project);
	// The spawn seam drops a PATH entry inside the checkout while the project is
	// untrusted; these cases run the developer- or lane-installed tool.
	setProjectTrustState("trusted");
});

afterAll(() => {
	removeTempDirSync(ROOT);
});

beforeEach(() => {
	vi.spyOn(safeSpawnModule, "safeSpawnAsync");
});

describe.each([
	{
		runnerId: "yamllint",
		binary: "yamllint",
		file: "src/bad.yml",
		// The ignore key the fixture's `.yamllint` carries is `ignore`; the Markdown
		// one is `ignores`. Either way the glob names the layout's own ancestor.
		// Both enabled rules fire on the fixture, so the control cannot be silent.
		controlRules: ["document-start", "trailing-spaces"],
		run: (project: string) =>
			yamllintRunner.run(
				makeRunnerCtx(path.join(project, "src/bad.yml"), project, {
					kind: "yaml",
				}) as never,
			),
	},
	{
		runnerId: "markdownlint",
		binary: "markdownlint-cli2",
		file: "src/a.md",
		controlRules: ["MD012", "MD012"],
		run: (project: string) =>
			markdownlintRunner.run(
				makeRunnerCtx(path.join(project, "src/a.md"), project, {
					kind: "markdown",
				}) as never,
			),
	},
])(
	"$runnerId lints a project whose ignore glob names its own ancestor",
	({ binary, file, controlRules, run }) => {
		describe.skipIf(!toolAvailable(binary))(`${binary} available`, () => {
			it("reports the findings the control layout reports", async () => {
				const control = summary(await run(LAYOUTS.control));
				const scratch = summary(await run(LAYOUTS.ignoredAncestor));

				expect(control.rules).toEqual(controlRules);
				expect(scratch.rules).toEqual(control.rules);
				expect(scratch.status).toEqual(control.status);
			});

			it("names the findings with the absolute dispatched path", async () => {
				const result = await run(LAYOUTS.ignoredAncestor);

				expect(result.diagnostics.length).toBeGreaterThan(0);
				expect(summary(result).reportedPaths).toEqual([
					path.join(LAYOUTS.ignoredAncestor, file),
				]);
			});

			it(`hands the CLI the \`${file}\` relative to the spawn cwd, never the absolute path`, async () => {
				const filePath = path.join(LAYOUTS.ignoredAncestor, file);

				await run(LAYOUTS.ignoredAncestor);

				const argv = spawnArgv();
				expect(argv).toContain(
					relativeToProject(LAYOUTS.ignoredAncestor, filePath),
				);
				expect(argv).not.toContain(filePath);
			});
		});
	},
);
