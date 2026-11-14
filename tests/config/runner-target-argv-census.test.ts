/**
 * #5556 census: every dispatch runner that spawns a tool states how the tool
 * receives the dispatched file, and why that spelling cannot hide a file from
 * the tool's own ignore matcher (AGENTS.md shape 94). A tool matches an
 * ignore glob against the argument string, or absolutizes a config glob, or
 * has no matcher at all; which one is a fact about the tool, so each row
 * records the probe or the doc behind it and a new spawning runner reds until
 * it gets a row. Four hits of the shape (#5544 yamllint and markdownlint, #5556
 * oxlint and vale) were each found by a manual grep; nothing mechanical asked
 * "was this runner probed" before.
 *
 * STATE TABLE (every form not named as admitted is a member):
 *
 * | form in a runner module's code (comments blanked, strings kept)        | verdict |
 * |------------------------------------------------------------------------|---------|
 * | a string literal naming `safe-spawn` (import, export-from, require,    | member  |
 * |   dynamic import, a specifier held in a const), alias or not           |         |
 * | a string literal naming `child_process`                                | member  |
 * | a comment that mentions either                                         | admitted|
 * | a module with neither                                                  | admitted|
 *
 * A member needs a row; a row needs a live member. `seam:` rows are the ones
 * that call `optionSafeTargetArg(`, and only those files may call it, so the
 * seam cannot be dropped from a runner while its row still claims it.
 *
 * Does not prove: that a `cleared`, `no-ignore` or `residual` row is still
 * true of the tool's current release. The row names the version probed; a new
 * probe replaces it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	stripSource,
} from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";

const RUNNERS_ROOT = path.resolve(
	import.meta.dirname,
	"../../clients/dispatch/runners",
);

/** Does this runner module reach a process-spawning module by ANY spelling? */
function spawnsATool(source: string): boolean {
	const code = stripSource(source, { strings: "keep" });
	return /["'`][^"'`\n]*(?:safe-spawn|child_process)[^"'`\n]*["'`]/.test(code);
}

/** Does the module call the option-safe target seam? */
function callsTargetSeam(source: string): boolean {
	return /\boptionSafeTargetArg\s*\(/.test(stripSource(source));
}

/**
 * Verdicts. `seam`: the tool gets `optionSafeTargetArg`. `own-relative`: a
 * project-relative spelling the runner derives itself. `cleared`: probed, the
 * tool does not match its ignore against the argument spelling. `no-ignore`:
 * the tool has no path-ignore mechanism. `residual`: reproduces, and no argv
 * spelling fixes it (the tool absolutizes its own config glob). `not-file-argv`:
 * the argv carries no dispatched-file path.
 */
const VERDICTS: Readonly<Record<string, string>> = {
	"actionlint.ts":
		"own-relative: argv is `path.relative(cwd, ctx.filePath)`, which predates #5544",
	"biome-check.ts": "cleared: real Biome probe, two layouts (#5578)",
	"cpp-check.ts":
		"no-ignore: gcc/clang `-fsyntax-only`; a compiler has no ignore matcher (#5556)",
	"credo.ts":
		"residual: credo 1.7.19 matches a `files.excluded` regex against the absolute path; the relative spelling and a bare `mix credo` are silent too (#5556)",
	"cue-vet.ts":
		"no-ignore: cue 0.17.1 has no ignore flag; argv is `./<basename>` run from the file's directory (#5556)",
	"dart-analyze.ts":
		"cleared: dart 3.14.0 `analyzer: exclude` applies to directory analysis; an explicit file is analyzed in both layouts (#5556)",
	"detekt.ts":
		"residual: detekt 1.23.8 absolutizes the input before it matches `excludes`; no argv spelling helps (#5556)",
	"dotnet-build.ts":
		"not-file-argv: builds the .sln/.csproj found from the cwd, not the dispatched file",
	"elixir-check.ts":
		"no-ignore: `elixirc` has no ignore option and `mix compile` takes no file argument (#5556)",
	"eslint.ts": "cleared: eslint 8.x and 9.x real probes (#5556)",
	"fish-indent.ts":
		"no-ignore: fish 4.9.3 fish_indent man page lists no ignore option (#5556)",
	"gleam-check.ts":
		"not-file-argv: `gleam check` takes no path, gleam 1.19.2 `--help` (#5556)",
	"go-vet.ts":
		"own-relative: vets the file's package as a `./`-relative path from the module root",
	"golangci-lint.ts": "cleared: golangci-lint 2.1.6 real probe (#5556)",
	"hadolint.ts":
		"no-ignore: hadolint 2.15.1 `--help` has `--ignore RULECODE` only, no path ignore (#5556)",
	"helm-lint.ts":
		"cleared: helm 3.19.0 matches `.helmignore` relative to the chart root it is handed; the ancestor pattern was inert (#5556)",
	"helm-render.ts":
		"cleared: helm 3.19.0 `template` takes the chart root; the same `.helmignore` probe as helm-lint (#5556)",
	"htmlhint.ts": "cleared: real htmlhint probe, two layouts (#5556)",
	"javac.ts":
		"no-ignore: javac has no ignore option (javac man page); not installed on the probe host (#5556)",
	"ktlint.ts": "cleared: ktlint 1.8.0 real probe (#5556)",
	"markdownlint.ts": "seam: optionSafeTargetArg (#5544, #5557)",
	"mypy.ts":
		"cleared: mypy 2.4.1 applies `exclude` only to directory discovery; an explicit file is never excluded (#5556)",
	"oxlint.ts": "seam: optionSafeTargetArg (#5556)",
	"php-lint.ts":
		"no-ignore: `php -l` (php 8.5.8 `-h`) has no ignore option (#5556)",
	"phpstan.ts":
		"residual: phpstan 2.3.5 absolutizes `excludePaths`; the relative spelling answers `No files found to analyse` too (#5556)",
	"prisma-validate.ts":
		"no-ignore: `prisma validate --schema` has no ignore option; not installed on the probe host (#5556)",
	"psscriptanalyzer.ts":
		"no-ignore: Invoke-ScriptAnalyzer excludes rules, not paths; pwsh not installed on the probe host (#5556)",
	"pyright.ts":
		"cleared: pyright 1.1.414 matches `exclude` relative to the config; the ancestor layout analyzed the file (#5556)",
	"rubocop.ts":
		"cleared: rubocop 1.92.2 never applies `Exclude` to an explicit file without `--force-exclusion` (#5556)",
	"ruff.ts": "cleared: real ruff probe, two layouts (#5578)",
	"rust-clippy.ts": "not-file-argv: `cargo clippy` runs on the crate, no path",
	"shellcheck.ts":
		"no-ignore: shellcheck 0.11.0 `--help` has `--exclude=CODE` only, no path ignore (#5556)",
	"shfmt.ts":
		"cleared: shfmt 3.14.1 applies `.editorconfig` `ignore = true` to directory walks; an explicit file is formatted (#5556)",
	"spellcheck.ts":
		"cleared: typos 1.52.2 applies `extend-exclude` to walks, and `--force-exclude` is not passed (#5556)",
	"spotbugs.ts": "not-file-argv: scans the compiled classes directory",
	"sqlfluff.ts": "cleared: sqlfluff real probe (#5556)",
	"stylelint.ts": "cleared: stylelint real probe, three configs (#5556)",
	"swiftlint.ts":
		"cleared: swiftlint 0.65.1 applies `excluded` to explicit paths only with `--force-exclude`, which is not passed (#5556)",
	"taplo.ts": "cleared: taplo 0.9.0 real probe (#5578)",
	"terragrunt.ts":
		"not-file-argv: `hcl validate` takes no file path; it runs in the file's directory",
	"tflint.ts":
		"not-file-argv: `--filter=<basename>` run from the file's directory",
	"trivy-config.ts":
		"cleared: trivy 0.76.2 applies `skip-files` to walks; an explicit file is scanned in both layouts (#5556)",
	"vale.ts": "seam: optionSafeTargetArg (#5556)",
	"yamllint.ts":
		"own-relative: `-- <relative>` terminator form, pinned by the real harness (#5544)",
	"zig-check.ts":
		"no-ignore: zig 0.17.1 `build-exe --help` lists no ignore option (#5556)",
};

function liveMembers(): string[] {
	const files = listSourceFiles(RUNNERS_ROOT, {
		extensions: [".ts"],
		skipTests: true,
		exclude: (relative) => relative.includes("/"),
	});
	assertNonEmptyScan("runner modules", files.length, 40);
	return files
		.filter((file) => spawnsATool(fs.readFileSync(file, "utf8")))
		.map((file) => path.basename(file))
		.sort();
}

describe("runner target-argv census (#5556, shape 94)", () => {
	it(
		"every runner that spawns a tool has a verdict row, and every row is live",
		() => {
			// Recurrence: oxlint (#5556) and vale (#5556) shipped with the absolute
			// dispatched path for months because nothing asked a new or untouched
			// runner how its tool spells the file.
			expect(liveMembers()).toEqual(Object.keys(VERDICTS).sort());
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("every row names its verdict kind and its evidence", () => {
		for (const [file, row] of Object.entries(VERDICTS)) {
			expect(row, file).toMatch(
				/^(seam|own-relative|cleared|no-ignore|residual|not-file-argv): .{20,}/,
			);
		}
	});

	it(
		"exactly the `seam:` rows call optionSafeTargetArg",
		() => {
			// Recurrence: #5544 round 3 and #5556 round 1 each moved a runner onto the
			// seam; a later edit that put the absolute path back would leave the row
			// claiming a spelling the argv no longer has.
			const callers = liveMembers().filter((file) =>
				callsTargetSeam(fs.readFileSync(path.join(RUNNERS_ROOT, file), "utf8")),
			);
			const claimed = Object.entries(VERDICTS)
				.filter(([, row]) => row.startsWith("seam:"))
				.map(([file]) => file)
				.sort();
			expect(callers).toEqual(claimed);
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("reads a spawn reach by any spelling, and ignores a comment", () => {
		// The three spellings the table's author did not design a row for: an
		// alias, a dynamic import, and a specifier held in a binding.
		expect(
			spawnsATool(
				'import { safeSpawnAsync as run } from "../../safe-spawn.js";',
			),
		).toBe(true);
		expect(spawnsATool('const m = await import("../../safe-spawn.js");')).toBe(
			true,
		);
		expect(
			spawnsATool('const spec = "../../safe-spawn.js"; await import(spec);'),
		).toBe(true);
		expect(spawnsATool('import cp from "node:child_process";')).toBe(true);
		expect(
			spawnsATool("// spawns through ../../safe-spawn.js\nexport const x = 1;"),
		).toBe(false);
		expect(spawnsATool('export const x = "plain";')).toBe(false);
	});
});
