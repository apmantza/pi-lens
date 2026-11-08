/**
 * #5408 census: a dispatch runner may not read the filesystem, or climb a
 * directory tree, to decide whether a tool is configured. That question is
 * `clients/tool-config-presence.ts`'s. A runner module that imports `fs` or a
 * walker from `path-utils` / `workspace-topology` must have a row below with
 * the reason; a new one reds, and so does a row whose module stopped being a
 * member (the table only shrinks).
 *
 * Recurrence this guards: detekt's runner checked only its cwd while the
 * policy walked up, and tflint's runner stopped before `$HOME` while the
 * policy did not (#5408 divergences 1 and 3); five runners hand-rolled a check
 * the shared helpers already expressed (credo, elixir-check, shfmt, detekt,
 * tflint). Each was a runner reading config on its own.
 *
 * The detector is `tests/support/runner-config-read-scan.ts` (STATE TABLE in
 * its header). Plants below cover an alias, an indirect call and a value
 * reached through another binding.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNonEmptyScan, listSourceFiles } from "../support/sweep-kit.js";
import { TREE_WALK_TIMEOUT_MS } from "../support/test-timeout-scale.js";
import { configReadReasons } from "../support/runner-config-read-scan.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const RUNNERS_ROOT = path.join(REPO_ROOT, "clients/dispatch/runners");

/**
 * Runner modules that touch the filesystem or a walker, with the reason.
 * `not config:` rows read the edited file, a tool binary, a build output or a
 * temp file and never decide "is this tool configured". `remainder:` rows do
 * decide a project descriptor or config and are the named remainder of #5408
 * (Refs): each still owes a move onto the seam.
 */
const MEMBERS: Readonly<Record<string, string>> = {
	"ast-grep-napi.ts": "not config: reads the edited file's content and stat",
	"cpp-check.ts": "not config: reads the edited file's content",
	"cue-vet.ts": "not config: reads the edited file's content",
	"dotnet-build.ts":
		"remainder: readdirSync(cwd) for .sln/.csproj marker globs (project descriptor)",
	"elixir-check.ts": "not config: mkdirSync of the compile output directory",
	"helm-lint.ts":
		"remainder: Chart.yaml via findNearestDirWithMarker (marker walker, home-bounded)",
	"helm-render.ts":
		"remainder: Chart.yaml via findNearestDirWithMarker, chart-tree readdir",
	"psscriptanalyzer.ts": "not config: writes and removes a temp script",
	"shellcheck.ts":
		"remainder: findLocalToolConfig(.shellcheckrc) selects args only, starts at ctx.cwd",
	"spotbugs.ts": "remainder: compiled-classes dir discovery by readdirSync",
	"trivy-config.ts": "not config: reads the edited file's content",
	"utils.ts": "not config: reads the edited file's content",
	"utils/candidate-probe.ts": "not config: tool binary candidate probe",
	"utils/markdownlint-api.ts":
		"not config: resolves the markdownlint package from node_modules",
	"utils/runner-helpers.ts": "not config: tool binary availability probe",
	"vale.ts":
		"remainder: findLocalToolConfig(.vale.ini), unbounded walk (local wrapper)",
	"yaml-rule-parser.ts": "not config: reads ast-grep rule files",
};

function liveMembers(): string[] {
	const files = listSourceFiles(
		path.join(REPO_ROOT, "clients/dispatch/runners"),
		{
			extensions: [".ts"],
			skipTests: true,
		},
	);
	assertNonEmptyScan("runner modules", files.length, 40);
	return files
		.filter(
			(file) => configReadReasons(fs.readFileSync(file, "utf8")).length > 0,
		)
		.map((file) => path.relative(RUNNERS_ROOT, file).split(path.sep).join("/"))
		.sort();
}

describe("runner config-read census (#5408)", () => {
	it(
		"every runner module that reads the filesystem or climbs has a row, and every row is live",
		() => {
			expect(liveMembers()).toEqual(Object.keys(MEMBERS).sort());
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("every row states whether it decides config", () => {
		for (const [file, reason] of Object.entries(MEMBERS)) {
			expect(reason, file).toMatch(/^(not config|remainder): .{12,}/);
		}
	});

	it("the runners moved onto the seam are off the table", () => {
		for (const file of [
			"detekt.ts",
			"tflint.ts",
			"credo.ts",
			"shfmt.ts",
			"mypy.ts",
			"eslint.ts",
		]) {
			expect(Object.keys(MEMBERS), file).not.toContain(file);
		}
	});
});

describe("runner config-read detector: plants it was not designed around", () => {
	const flagged = (source: string) => configReadReasons(source).length > 0;

	it("flags a direct fs import and a named walker import", () => {
		expect(flagged('import * as fs from "node:fs";')).toBe(true);
		expect(flagged('import { existsSync } from "fs";')).toBe(true);
		expect(
			flagged('import { findNearestContaining } from "../../path-utils.js";'),
		).toBe(true);
	});

	it("flags an ALIASED walker import by the imported name", () => {
		expect(
			flagged('import { walkUpDirs as climb } from "../../path-utils.js";'),
		).toBe(true);
		expect(
			flagged(
				'import { findNearestDirWithAnyBasename as f } from "../../workspace-topology.js";',
			),
		).toBe(true);
	});

	it("flags an INDIRECT call: require, dynamic import, builtin module, createRequire", () => {
		expect(flagged('const fs = require("node:fs");')).toBe(true);
		expect(flagged('const fs = await import("node:fs/promises");')).toBe(true);
		expect(flagged('const fs = process.getBuiltinModule("fs");')).toBe(true);
		expect(flagged('import { createRequire } from "node:module";')).toBe(true);
	});

	it("flags a value reached through ANOTHER BINDING: namespace, default, re-export, variable specifier", () => {
		expect(flagged('import * as pu from "../../path-utils.js";')).toBe(true);
		expect(flagged('import pu from "../../path-utils.js";')).toBe(true);
		expect(flagged('export * from "../../path-utils.js";')).toBe(true);
		expect(
			flagged('const name = "node:fs"; const fs = await import(name);'),
		).toBe(true);
		expect(flagged("const fs = await import(`node:${'fs'}`);")).toBe(true);
	});

	it("admits pure path helpers, type imports and unrelated modules", () => {
		expect(
			flagged('import { pathsEqual, toPosix } from "../../path-utils.js";'),
		).toBe(false);
		expect(
			flagged('import type { WalkUpDirsOptions } from "../../path-utils.js";'),
		).toBe(false);
		expect(
			flagged(
				'import { type WalkUpDirsOptions, pathsEqual } from "../../path-utils.js";',
			),
		).toBe(false);
		expect(flagged('import * as path from "node:path";')).toBe(false);
		expect(
			flagged(
				'import { findToolConfig } from "../../tool-config-presence.js";',
			),
		).toBe(false);
	});

	it("reads code, not prose: a comment or string naming node:fs is not a hit", () => {
		expect(flagged('// import * as fs from "node:fs";\nconst a = 1;')).toBe(
			false,
		);
		expect(flagged("const msg = \"import fs from 'node:fs'\";")).toBe(false);
	});
});
