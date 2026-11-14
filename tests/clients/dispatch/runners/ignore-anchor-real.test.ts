// flake-shape: real-process-spawn — the defect is detekt's, phpstan's and
// credo's OWN matching of the project's ignore globs against the absolute path of
// the file, so a double has no matcher to model and a shim would not reproduce
// the tool's ignore either.
// lane: a case runs where its binary is on the PATH the runner's lookup walks
// (`detekt` and `phpstan` as commands; `mix` plus a prepared credo project, see
// `PI_LENS_TEST_CREDO_BASE` below). A lane without one skips that tool visibly.
// CI's tool-smoke lane installs neither detekt nor phpstan nor credo's deps, so
// these cases run on a host that has them; the hermetic file
// `ignore-anchor.test.ts` is what CI runs for the rewrite itself.

/**
 * #5594: detekt (`excludes`), phpstan (`excludePaths`) and credo
 * (`files.excluded` regexes) turn the project config's ignore globs into
 * absolute patterns themselves and match them against the file's absolute path.
 * A project checked out under `<scratch>/.claude/worktrees/lane1` whose config
 * ignores `**\/.claude/**` was therefore excluded from its own analysis, and no
 * argv spelling avoids that (the argv fix for the other runners is
 * `ignore-glob-relative-argv-real.test.ts`).
 *
 * Each case plants one byte-identical project twice, once under a `.claude`
 * ancestor and once under a neutral `ctrl` ancestor, and requires the SAME
 * outcome from both. The control run pins a non-empty expected rule set of its
 * own, so two silent runs cannot satisfy the equality. A file inside the
 * project's own ignored `.claude/` directory stays ignored in both layouts.
 *
 * Credo needs a project with its deps compiled, which needs the network. Point
 * `PI_LENS_TEST_CREDO_BASE` at a directory holding a `mix.exs` that depends on
 * credo, with `mix.lock`, `deps/` and `_build/` already fetched and compiled
 * (`mix deps.get && mix deps.compile`), and put `mix` on PATH.
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

import credoRunner from "../../../../clients/dispatch/runners/credo.js";
import detektRunner from "../../../../clients/dispatch/runners/detekt.js";
import phpstanRunner from "../../../../clients/dispatch/runners/phpstan.js";
import type { FileKind } from "../../../../clients/file-kinds.js";
import type { RunnerResult } from "../../../../clients/dispatch/types.js";
import { setProjectTrustState } from "../../../../clients/project-trust.js";
import * as safeSpawnModule from "../../../../clients/safe-spawn.js";
import { scaledTestTimeout } from "../../../support/test-timeout-scale.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { removeTempDirSync, setupTestEnvironment } from "../../test-utils.js";

const env = setupTestEnvironment("pi-lens-5594-anchor-");
const ROOT = env.tmpDir;

const CREDO_BASE = process.env.PI_LENS_TEST_CREDO_BASE;

/** A case runs the real tool in two layouts; a JVM or mix start is seconds. */
const REAL_RUN_TIMEOUT_MS = scaledTestTimeout(120_000);

/** The layout pair: one project under an ignored ancestor, one under a neutral. */
const LAYOUTS = {
	ignoredAncestor: path.join(ROOT, ".claude/worktrees/lane1"),
	control: path.join(ROOT, "ctrl/lane1"),
};

/** `fn f(x) { return x * 42 }` in Kotlin: detekt's MagicNumber fires on the 42. */
const KOTLIN = "fun f(x: Int): Int {\n    return x * 42\n}\n";

function plantDetekt(project: string, config?: string): void {
	fs.mkdirSync(path.join(project, "src"), { recursive: true });
	fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(project, "detekt.yml"),
		config ??
			"style:\n  active: true\n  MagicNumber:\n    active: true\n    excludes: ['**/.claude/**']\n",
	);
	fs.writeFileSync(path.join(project, "src/A.kt"), KOTLIN);
	fs.writeFileSync(path.join(project, ".claude/B.kt"), KOTLIN);
}

function plantPhpstan(project: string): void {
	fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(project, "phpstan.neon"),
		"parameters:\n  level: 5\n  excludePaths:\n    - '**/.claude/**'\n",
	);
	fs.writeFileSync(path.join(project, "a.php"), "<?php\necho $undefinedVar;\n");
	fs.writeFileSync(
		path.join(project, ".claude/b.php"),
		"<?php\necho $undefinedVar;\n",
	);
}

function plantCredo(project: string): void {
	fs.mkdirSync(path.join(project, "lib"), { recursive: true });
	fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
	for (const name of ["mix.exs", "mix.lock"]) {
		fs.copyFileSync(
			path.join(CREDO_BASE ?? "", name),
			path.join(project, name),
		);
	}
	for (const name of ["deps", "_build"]) {
		fs.cpSync(path.join(CREDO_BASE ?? "", name), path.join(project, name), {
			recursive: true,
			verbatimSymlinks: true,
		});
	}
	// A Design finding: credo's exit status is a per-category bitmask, and the
	// runner's exit table admits 0, 1 and 2 only, so a Readability finding (4)
	// would be read as a rejected invocation and hide what this file proves.
	const module = (name: string) =>
		`defmodule ${name} do\n  @moduledoc "m"\n  # TODO: later\n  def f(x), do: x\nend\n`;
	fs.writeFileSync(path.join(project, "lib/a.ex"), module("A"));
	fs.writeFileSync(path.join(project, ".claude/b.ex"), module("B"));
	// The regex tests the absolute path: it names the project's own `.claude/`
	// directory, and also the ancestor of a project under `.claude/worktrees`.
	fs.writeFileSync(
		path.join(project, ".credo.exs"),
		'%{configs: [%{name: "default", files: %{included: ["lib/", ".claude/"], excluded: [~r"/\\.claude/"]}, strict: true}]}\n',
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

const credoAvailable = (): boolean =>
	toolAvailable("mix") &&
	CREDO_BASE !== undefined &&
	fs.existsSync(path.join(CREDO_BASE, "deps/credo"));

function summary(result: RunnerResult): {
	status: string;
	rules: string[];
	reportedPaths: string[];
	inconclusive: boolean;
} {
	return {
		status: result.status,
		rules: result.diagnostics.map((diagnostic) => diagnostic.rule ?? ""),
		reportedPaths: [...new Set(result.diagnostics.map((d) => d.filePath))],
		inconclusive: result.inconclusive === true,
	};
}

beforeAll(() => {
	for (const project of Object.values(LAYOUTS)) {
		plantDetekt(project);
		plantPhpstan(project);
		if (credoAvailable()) plantCredo(project);
	}
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

const TOOLS: ReadonlyArray<{
	runnerId: string;
	available: () => boolean;
	kind: FileKind;
	runner: { run: (ctx: never) => Promise<RunnerResult> };
	file: string;
	controlRules: string[];
	ignoredFile: string;
}> = [
	{
		runnerId: "detekt",
		available: () => toolAvailable("detekt"),
		kind: "kotlin",
		runner: detektRunner,
		/** The file whose finding proves the run read the project. */
		file: "src/A.kt",
		controlRules: ["MagicNumber"],
		/** A file inside the project's own ignored dir. */
		ignoredFile: ".claude/B.kt",
	},
	{
		runnerId: "phpstan",
		available: () => toolAvailable("phpstan"),
		kind: "php",
		runner: phpstanRunner,
		file: "a.php",
		controlRules: ["variable.undefined"],
		ignoredFile: ".claude/b.php",
	},
	{
		runnerId: "credo",
		available: credoAvailable,
		kind: "elixir",
		runner: credoRunner,
		file: "lib/a.ex",
		controlRules: ["Credo.Check.Design.TagTODO"],
		ignoredFile: ".claude/b.ex",
	},
];

describe.each(TOOLS)(
	"$runnerId analyses a project whose ignore glob names its own ancestor",
	({ available, kind, runner, file, controlRules, ignoredFile }) => {
		const run = (project: string, name: string) =>
			runner.run(
				makeRunnerCtx(path.join(project, name), project, { kind }) as never,
			);

		describe.skipIf(!available())("tool available", () => {
			it(
				"reports the findings the control layout reports",
				async () => {
					const control = summary(await run(LAYOUTS.control, file));
					const scratch = summary(await run(LAYOUTS.ignoredAncestor, file));

					expect(control.rules).toEqual(controlRules);
					expect(scratch.rules).toEqual(control.rules);
					expect(scratch.status).toEqual(control.status);
					expect(scratch.inconclusive).toBe(false);
				},
				REAL_RUN_TIMEOUT_MS,
			);

			it(
				"names the findings with the absolute dispatched path",
				async () => {
					const filePath = path.join(LAYOUTS.ignoredAncestor, file);
					const result = await run(LAYOUTS.ignoredAncestor, file);

					expect(result.diagnostics.length).toBeGreaterThan(0);
					expect(summary(result).reportedPaths).toEqual([filePath]);
				},
				REAL_RUN_TIMEOUT_MS,
			);

			// The project's own `.claude/` ignore must still fire: anchoring the glob
			// must not turn it off. The control run proves the glob matches in a
			// neutral layout; the ancestor run must agree.
			it(
				"keeps a file inside the project's own ignored .claude/ directory ignored",
				async () => {
					const control = summary(await run(LAYOUTS.control, ignoredFile));
					const scratch = summary(
						await run(LAYOUTS.ignoredAncestor, ignoredFile),
					);

					expect(control.rules).toEqual([]);
					expect(scratch.rules).toEqual([]);
					expect(scratch.status).toEqual(control.status);
				},
				REAL_RUN_TIMEOUT_MS,
			);
		});
	},
);

// The fail-closed cell, with the real binary: a glob form the rewrite does not
// recognise (a leading brace group, valid Java glob) is run as it stands. In the neutral layout
// that still reports the project's finding; under the ancestor it reads nothing,
// and that nothing must not be called a clean file.
describe.skipIf(!toolAvailable("detekt"))(
	"detekt with an ignore it cannot anchor",
	() => {
		const BRACE_CONFIG =
			"style:\n  active: true\n  MagicNumber:\n    active: true\n    excludes: ['{**/.claude/**,**/nomatch/**}']\n";

		it(
			"never reports the file clean under an ignored ancestor",
			async () => {
				const control = path.join(ROOT, "brace-ctrl/lane1");
				const scratch = path.join(ROOT, ".claude/worktrees/brace-lane");
				plantDetekt(control, BRACE_CONFIG);
				plantDetekt(scratch, BRACE_CONFIG);
				const run = (project: string) =>
					detektRunner.run(
						makeRunnerCtx(path.join(project, "src/A.kt"), project, {
							kind: "kotlin",
						}) as never,
					);

				const neutral = summary(await run(control));
				const ancestor = summary(await run(scratch));

				expect(neutral.rules).toEqual(["MagicNumber"]);
				expect(neutral.inconclusive).toBe(false);
				expect(ancestor.rules).toEqual([]);
				expect(ancestor.inconclusive).toBe(true);
			},
			REAL_RUN_TIMEOUT_MS,
		);
	},
);
