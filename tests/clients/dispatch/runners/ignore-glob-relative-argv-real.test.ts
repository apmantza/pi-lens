// flake-shape: real-process-spawn — the defect is yamllint's, markdownlint-cli2's,
// oxlint's and vale's OWN ignore-glob matching against the path string they are
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
import oxlintRunner from "../../../../clients/dispatch/runners/oxlint.js";
import valeRunner from "../../../../clients/dispatch/runners/vale.js";
import yamllintRunner from "../../../../clients/dispatch/runners/yamllint.js";
import type { RunnerResult } from "../../../../clients/dispatch/types.js";
import { runAutofix } from "../../../../clients/pipeline.js";
import { setProjectTrustState } from "../../../../clients/project-trust.js";
import * as safeSpawnModule from "../../../../clients/safe-spawn.js";
import { makeRunnerCtx } from "../../../support/runner-ctx.js";
import { removeTempDirSync, setupTestEnvironment } from "../../test-utils.js";

const env = setupTestEnvironment("pi-lens-5544-ignore-argv-");
const ROOT = env.tmpDir;

/** The repo's own oxlint (a devDependency), linked into each planted project. */
const OXLINT_BIN =
	process.platform !== "win32" &&
	fs.existsSync(path.join(process.cwd(), "node_modules/.bin/oxlint"))
		? path.join(process.cwd(), "node_modules/.bin/oxlint")
		: undefined;

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
	// #5556: oxlint applies `.eslintignore` to the argument spelling too. The
	// package.json and lockfile agree on oxlint so the autofix stage (which
	// checks tool/lockfile agreement) reaches it.
	fs.writeFileSync(
		path.join(project, ".oxlintrc.json"),
		`${JSON.stringify({ rules: { "no-debugger": "error", "no-var": "error" } })}\n`,
	);
	fs.writeFileSync(
		path.join(project, ".eslintignore"),
		"**/.claude/**\nnode_modules\n",
	);
	fs.writeFileSync(
		path.join(project, "package.json"),
		`${JSON.stringify({ name: "x", devDependencies: { oxlint: "^1.0.0" } })}\n`,
	);
	fs.writeFileSync(
		path.join(project, "package-lock.json"),
		`${JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/oxlint": { version: "1.0.0" } } })}\n`,
	);
	fs.writeFileSync(path.join(project, "src/bad.ts"), "debugger;\n");
	// #5556: vale has no ignore key; a `.vale.ini` section glob that matches the
	// path it is handed switches a rule off. The `[**/.claude/**]` section is
	// that ignore here: it fires only when the matched string holds the
	// project's own ancestor.
	fs.mkdirSync(path.join(project, "styles/Test"), { recursive: true });
	fs.writeFileSync(
		path.join(project, "styles/Test/Foo.yml"),
		'extends: existence\nmessage: "avoid %s"\nlevel: error\nignorecase: true\ntokens:\n  - foo\n',
	);
	fs.writeFileSync(
		path.join(project, ".vale.ini"),
		"StylesPath = styles\nMinAlertLevel = suggestion\n[*.md]\nBasedOnStyles = Test\n[**/.claude/**]\nTest.Foo = NO\n",
	);
	fs.writeFileSync(path.join(project, "src/v.md"), "This has foo in it.\n");
	if (OXLINT_BIN) {
		fs.mkdirSync(path.join(project, "node_modules/.bin"), { recursive: true });
		fs.symlinkSync(OXLINT_BIN, path.join(project, "node_modules/.bin/oxlint"));
	}
}

/** Is the binary on the PATH the runner's lookup walks? */
function toolAvailable(binary: string): boolean {
	if (binary === "oxlint") return OXLINT_BIN !== undefined;
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

/**
 * The argv of the `safeSpawnAsync` call that names the dispatched file. The
 * resolver's own availability probe (`yamllint --version`,
 * `markdownlint-cli2 --no-globs -`) names none, so it is not the call whose path
 * spelling is under test; exactly one call must name the file.
 */
function spawnArgv(fileName: string): string[] {
	const calls = vi
		.mocked(safeSpawnModule.safeSpawnAsync)
		.mock.calls.filter(([, args]) =>
			(args as string[] | undefined)?.some(
				(arg) => path.basename(arg ?? "") === fileName,
			),
		);
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

const RUNNERS = [
	{
		runnerId: "yamllint",
		binary: "yamllint",
		file: "src/bad.yml",
		// The ignore key the fixture's `.yamllint` carries is `ignore`; the Markdown
		// one is `ignores`. Either way the glob names the layout's own ancestor.
		// Both enabled rules fire on the fixture, so the control cannot be silent.
		controlRules: ["document-start", "trailing-spaces"],
		run: (filePath: string, project: string) =>
			yamllintRunner.run(
				makeRunnerCtx(filePath, project, { kind: "yaml" }) as never,
			),
	},
	{
		runnerId: "markdownlint",
		binary: "markdownlint-cli2",
		file: "src/a.md",
		controlRules: ["MD012", "MD012"],
		run: (filePath: string, project: string) =>
			markdownlintRunner.run(
				makeRunnerCtx(filePath, project, { kind: "markdown" }) as never,
			),
	},
	{
		// #5556: oxlint reads `.eslintignore` against the argument string too.
		runnerId: "oxlint",
		binary: "oxlint",
		file: "src/bad.ts",
		controlRules: ["no-debugger"],
		run: (filePath: string, project: string) =>
			oxlintRunner.run(
				makeRunnerCtx(filePath, project, { kind: "jsts" }) as never,
			),
	},
	{
		// #5556: vale matches its `.vale.ini` section globs against the argument.
		runnerId: "vale",
		binary: "vale",
		file: "src/v.md",
		controlRules: ["Test.Foo"],
		// A vale file outside every project has no `.vale.ini`, so the runner
		// never spawns for it: nothing to pin for the absolute fallback.
		outsideReachable: false,
		run: (filePath: string, project: string) =>
			valeRunner.run(
				makeRunnerCtx(filePath, project, { kind: "markdown" }) as never,
			),
	},
];

describe.each(RUNNERS)(
	"$runnerId lints a project whose ignore glob names its own ancestor",
	({ binary, file, controlRules, run }) => {
		describe.skipIf(!toolAvailable(binary))(`${binary} available`, () => {
			it("reports the findings the control layout reports", async () => {
				const target = (project: string) => path.join(project, file);
				const control = summary(
					await run(target(LAYOUTS.control), LAYOUTS.control),
				);
				const scratch = summary(
					await run(target(LAYOUTS.ignoredAncestor), LAYOUTS.ignoredAncestor),
				);

				expect(control.rules).toEqual(controlRules);
				expect(scratch.rules).toEqual(control.rules);
				expect(scratch.status).toEqual(control.status);
			});

			it("names the findings with the absolute dispatched path", async () => {
				const filePath = path.join(LAYOUTS.ignoredAncestor, file);
				const result = await run(filePath, LAYOUTS.ignoredAncestor);

				expect(result.diagnostics.length).toBeGreaterThan(0);
				expect(summary(result).reportedPaths).toEqual([filePath]);
			});

			it(`hands the CLI the \`${file}\` relative to the spawn cwd, never the absolute path`, async () => {
				const filePath = path.join(LAYOUTS.ignoredAncestor, file);

				await run(filePath, LAYOUTS.ignoredAncestor);

				const argv = spawnArgv(path.basename(filePath));
				expect(argv).toContain(
					relativeToProject(LAYOUTS.ignoredAncestor, filePath),
				);
				expect(argv).not.toContain(filePath);
			});
		});
	},
);

/**
 * A root-level file whose NAME the CLI parses as a modifier rather than a path.
 * The absolute argument never began with these characters, so both spellings are
 * ones the project-relative argv introduced:
 *
 * - markdownlint-cli2 reads a leading `#`/`!` as an ignore/negation glob, so
 *   `#a.md` selected nothing (`Linting: 0 files`), exited 0, and the runner
 *   reported a silent clean; `./#a.md` lints it.
 * - markdownlint-cli2 reads a leading `:` as a literal-file modifier, so `:a.md`
 *   opened `a.md`: a missing sibling made the run a skipped one, and a present
 *   sibling's findings were reported against `:a.md`; `./:a.md` lints the file.
 * - yamllint reads a leading `-` as an option: `yamllint -f parsable -a.yml`
 *   answers `one of the arguments FILE_OR_DIR - is required` and exits 2, while
 *   `yamllint -f parsable -- -a.yml` lints it. That one is visible (the runner
 *   reports a skipped run with a fault), not a silent clean.
 */
const LEADING_NAME_CASES = [
	{
		runnerId: "yamllint",
		binary: "yamllint",
		name: "-a.yml",
		sibling: "plain.yml",
		content: "key: value   \nother: 2\n",
		expectedRules: ["document-start", "trailing-spaces"],
		// yamllint's own option terminator, so argparse stops reading flags.
		expectedTarget: "-a.yml",
		separator: "--" as string | undefined,
		run: (filePath: string, project: string) =>
			yamllintRunner.run(
				makeRunnerCtx(filePath, project, { kind: "yaml" }) as never,
			),
	},
	{
		runnerId: "markdownlint",
		binary: "markdownlint-cli2",
		name: "#a.md",
		sibling: "plain.md",
		content: "# Title\n\n\ntext\n",
		expectedRules: ["MD012"],
		// The `./` prefix keeps cli2's glob parser off the leading `#`.
		expectedTarget: "./#a.md",
		separator: undefined,
		run: (filePath: string, project: string) =>
			markdownlintRunner.run(
				makeRunnerCtx(filePath, project, { kind: "markdown" }) as never,
			),
	},
	{
		runnerId: "markdownlint",
		binary: "markdownlint-cli2",
		name: "!a.md",
		sibling: "plain.md",
		content: "# Title\n\n\ntext\n",
		expectedRules: ["MD012"],
		expectedTarget: "./!a.md",
		separator: undefined,
		run: (filePath: string, project: string) =>
			markdownlintRunner.run(
				makeRunnerCtx(filePath, project, { kind: "markdown" }) as never,
			),
	},
	// #5556: oxlint reads `-c.ts` as `-c <config>` (`Failed to parse oxlint
	// configuration file`), so a bare project-relative name turned a lintable
	// file into a failed run; `./-c.ts` is a path.
	{
		runnerId: "oxlint",
		binary: "oxlint",
		name: "-c.ts",
		sibling: "plain.ts",
		content: "debugger;\n",
		expectedRules: ["no-debugger"],
		expectedTarget: "./-c.ts",
		separator: undefined,
		run: (filePath: string, project: string) =>
			oxlintRunner.run(
				makeRunnerCtx(filePath, project, { kind: "jsts" }) as never,
			),
	},
	// #5556: vale parses `-a.md` as the `-a` shorthand flag (`unknown shorthand
	// flag: 'a' in -a.md`), so a bare project-relative name turned a lintable
	// file into a failed run; `./-a.md` is a path.
	{
		runnerId: "vale",
		binary: "vale",
		name: "-a.md",
		sibling: "plain-v.md",
		content: "This has foo in it.\n",
		expectedRules: ["Test.Foo"],
		expectedTarget: "./-a.md",
		separator: undefined,
		run: (filePath: string, project: string) =>
			valeRunner.run(
				makeRunnerCtx(filePath, project, { kind: "markdown" }) as never,
			),
	},
	// `:` is not a legal Windows file-name character, so this cell is POSIX only.
	...(process.platform === "win32"
		? []
		: [
				{
					runnerId: "markdownlint",
					binary: "markdownlint-cli2",
					name: ":a.md",
					sibling: "plain.md",
					content: "# Title\n\n\ntext\n",
					expectedRules: ["MD012"],
					expectedTarget: "./:a.md",
					separator: undefined,
					run: (filePath: string, project: string) =>
						markdownlintRunner.run(
							makeRunnerCtx(filePath, project, { kind: "markdown" }) as never,
						),
				},
			]),
];

describe.each(LEADING_NAME_CASES)(
	"$runnerId lints a root-level file named $name",
	({
		binary,
		name,
		sibling,
		content,
		expectedRules,
		expectedTarget,
		separator,
		run,
	}) => {
		describe.skipIf(!toolAvailable(binary))(`${binary} available`, () => {
			it("reports the findings instead of reading the name as a modifier", async () => {
				// The control layout, so only the leading character can explain the run.
				const project = LAYOUTS.control;
				const filePath = path.join(project, name);
				// A plain-named sibling with the SAME content is the control: whatever a
				// linted file of this content earns (yamllint reports both rules as
				// errors, so its findings make the run `failed`), the odd-named file must
				// earn the same. Pre-fix the name itself was the obstruction: yamllint
				// skipped, cli2 answered a clean file.
				const plain = path.join(project, sibling);
				fs.writeFileSync(filePath, content);
				fs.writeFileSync(plain, content);
				try {
					const odd = summary(await run(filePath, project));
					const control = summary(await run(plain, project));
					expect(odd.rules).toEqual(expectedRules);
					expect(odd.rules).toEqual(control.rules);
					expect(odd.status).toEqual(control.status);

					// The tail pins the guard itself: cli2's target carries the `./`
					// prefix, and yamllint's carries its option terminator.
					const argv = spawnArgv(name);
					expect(argv.slice(separator ? -2 : -1)).toEqual(
						separator ? [separator, expectedTarget] : [expectedTarget],
					);
				} finally {
					fs.rmSync(filePath, { force: true });
					fs.rmSync(plain, { force: true });
				}
			});
		});
	},
);

describe.each(RUNNERS.filter((runner) => runner.outsideReachable !== false))(
	"$runnerId keeps the absolute argument for a file outside the project",
	({ binary, file, run }) => {
		describe.skipIf(!toolAvailable(binary))(`${binary} available`, () => {
			it("spawns the absolute path it has no relative spelling for", async () => {
				const project = LAYOUTS.control;
				// A sibling of both layouts, so neither project holds it.
				const outside = path.join(ROOT, "outside", path.basename(file));
				fs.mkdirSync(path.dirname(outside), { recursive: true });
				fs.writeFileSync(
					outside,
					outside.endsWith(".md")
						? "# Title\n\n\ntext\n"
						: outside.endsWith(".ts")
							? "debugger;\n"
							: "key: value   \n",
				);

				await run(outside, project);

				// The relativizing seam returns nothing for a file the project does not
				// hold, and the runner then passes the path through unchanged rather than
				// a `../` climb or an empty argument.
				expect(spawnArgv(path.basename(outside))).toContain(outside);
			});
		});
	},
);

/**
 * #5556: the autofix stage hands oxlint its own file argument
 * (`oxlint --fix <target>`), so it carries the same two defects as the lint
 * runner, and its harm is a write rather than a missed finding:
 *
 * - the ignore glob naming an ancestor selected nothing, so the fix never ran
 *   (`fixedCount 0`, the file unchanged) in a `.claude/worktrees` lane;
 * - a root-level `-D.ts` was read as `-D <rule>`: oxlint then walked the whole
 *   tree and rewrote a file the agent never touched.
 *
 * The fixture `var a = 1;` is fixable under the planted `no-var` rule.
 */
const VAR_SRC = "var a = 1;\nconsole.log(a);\n";
const FIXED_SRC = "const a = 1;\nconsole.log(a);\n";

function autofix(filePath: string, project: string) {
	return runAutofix(
		filePath,
		project,
		() => undefined,
		() => {},
		{
			biomeClient: { isSupportedFile: () => false } as never,
			ruffClient: { isPythonFile: () => false } as never,
			fixedThisTurn: new Set<string>(),
		},
	);
}

describe.skipIf(!toolAvailable("oxlint"))("oxlint --fix", () => {
	it("fixes a file under an ignored ancestor like the control layout", async () => {
		const fixed: Record<string, string> = {};
		for (const [name, project] of Object.entries(LAYOUTS)) {
			const file = path.join(project, "src/fixme.ts");
			fs.writeFileSync(file, VAR_SRC);
			try {
				const result = await autofix(file, project);
				expect(result.autofixTools, name).toEqual(["oxlint:1"]);
				fixed[name] = fs.readFileSync(file, "utf8");
			} finally {
				fs.rmSync(file, { force: true });
			}
		}
		expect(fixed.control).toBe(FIXED_SRC);
		expect(fixed.ignoredAncestor).toBe(FIXED_SRC);
	});

	it("rewrites only the dispatched file when its name starts with `-`", async () => {
		const project = LAYOUTS.control;
		const dispatched = path.join(project, "-D.ts");
		const sibling = path.join(project, "src/untouched.ts");
		fs.writeFileSync(dispatched, VAR_SRC);
		fs.writeFileSync(sibling, VAR_SRC);
		try {
			const result = await autofix(dispatched, project);
			expect(result.changedFiles.map((f) => path.basename(f))).toEqual([
				"-D.ts",
			]);
			expect(fs.readFileSync(dispatched, "utf8")).toBe(FIXED_SRC);
			// `oxlint --fix -D.ts` read `-D .ts` and fixed the whole tree.
			expect(fs.readFileSync(sibling, "utf8")).toBe(VAR_SRC);
		} finally {
			fs.rmSync(dispatched, { force: true });
			fs.rmSync(sibling, { force: true });
		}
	});

	it("fixes a file outside the project through its absolute path", async () => {
		const project = LAYOUTS.control;
		const outside = path.join(ROOT, "outside", "fixme.ts");
		fs.mkdirSync(path.dirname(outside), { recursive: true });
		fs.writeFileSync(outside, VAR_SRC);
		try {
			await autofix(outside, project);
			// No project-relative spelling exists for it, and an empty argument would
			// fix nothing (or the project's own tree), never this file.
			expect(fs.readFileSync(outside, "utf8")).toBe(FIXED_SRC);
		} finally {
			fs.rmSync(outside, { force: true });
		}
	});
});
