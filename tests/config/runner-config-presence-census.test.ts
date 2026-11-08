/**
 * #5408 census: a dispatch runner may not read the filesystem, or climb a
 * directory tree, to decide whether a tool is configured. That question is
 * `clients/tool-config-presence.ts`'s. A runner module that imports `fs`, a
 * walker, a tool-policy finder, `readFileContent`, or any module the detector
 * has not been told about must have a row below with the reason; a new one reds, and so does a row whose module stopped being a
 * member (the table only shrinks).
 *
 * Recurrence this guards: detekt's runner checked only its cwd while the
 * policy walked up, and tflint's runner stopped before `$HOME` while the
 * policy did not (#5408 divergences 1 and 3); five runners hand-rolled a check
 * the shared helpers already expressed (credo, elixir-check, shfmt, detekt,
 * tflint). Each was a runner reading config on its own.
 *
 * The detector is `tests/support/runner-config-read-scan.ts` (STATE TABLE in
 * its header). Plants below cover an alias, an indirect call, a value
 * reached through another binding, and the forms #5414 review planted past r1
 * (`readFileContent`, an aliased tool-policy finder, `import = require`,
 * `process` and `require` aliases).
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
	"biome-check.ts":
		"remainder: biomeConfigArgs from tool-policy picks the config args (policy-owned finder)",
	"eslint.ts":
		"remainder: hasEslintConfig from tool-policy; the gate is the declared requiresConfig (policy-owned finder)",
	"golangci-lint.ts":
		"remainder: hasGolangciConfig from tool-policy; the gate is the declared requiresConfig (policy-owned finder)",
	"javac.ts":
		"remainder: hasJavaBuildDescriptor from tool-policy decides the build descriptor (policy-owned finder)",
	"lsp.ts":
		"not config: readFileContent of the edited file; detectPythonTargetVersion reads the target version, not a tool's config",
	"markdownlint.ts":
		"remainder: markdownlintConfigArgs from tool-policy picks the config args (policy-owned finder)",
	"mypy.ts":
		"remainder: hasMypyConfig from tool-policy; the gate is the declared requiresConfig (policy-owned finder)",
	"oxlint.ts":
		"remainder: hasVitePlusConfig from tool-policy decides the binary (policy-owned finder)",
	"phpstan.ts":
		"remainder: hasPhpstanConfig from tool-policy; the gate is the declared requiresConfig (policy-owned finder)",
	"ruff.ts":
		"remainder: ruffConfigArgs from tool-policy picks the config args (policy-owned finder)",
	"sqlfluff.ts":
		"remainder: hasSqlfluffConfig from tool-policy; the seam answers it, the import stays a policy helper",
	"stylelint.ts":
		"remainder: hasStylelintConfig from tool-policy (policy-owned finder)",
	"yamllint.ts":
		"remainder: hasYamllintConfig from tool-policy gates the advisory only; the seam answers it",
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

async function liveMembers(): Promise<string[]> {
	const files = listSourceFiles(
		path.join(REPO_ROOT, "clients/dispatch/runners"),
		{
			extensions: [".ts"],
			skipTests: true,
		},
	);
	assertNonEmptyScan("runner modules", files.length, 40);
	const members: string[] = [];
	for (const file of files) {
		// One parse per turn (AGENTS.md shape 81): 60+ synchronous parses starve the loop.
		await new Promise<void>((resolve) => setImmediate(resolve));
		const relative = path
			.relative(RUNNERS_ROOT, file)
			.split(path.sep)
			.join("/");
		if (configReadReasons(fs.readFileSync(file, "utf8"), relative).length > 0) {
			members.push(relative);
		}
	}
	return members.sort();
}

describe("runner config-read census (#5408)", () => {
	it(
		"every runner module that reads the filesystem or climbs has a row, and every row is live",
		async () => {
			expect(await liveMembers()).toEqual(Object.keys(MEMBERS).sort());
		},
		TREE_WALK_TIMEOUT_MS,
	);

	it("every row states whether it decides config", () => {
		for (const [file, reason] of Object.entries(MEMBERS)) {
			expect(reason, file).toMatch(/^(not config|remainder): .{12,}/);
		}
	});

	it("the runners moved onto the seam are off the table", () => {
		for (const file of ["detekt.ts", "tflint.ts", "credo.ts", "shfmt.ts"]) {
			expect(Object.keys(MEMBERS), file).not.toContain(file);
		}
	});
});

describe("runner config-read detector: plants it was not designed around", () => {
	const flagged = (source: string, file?: string) =>
		configReadReasons(source, file).length > 0;

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

	it("flags what #5414 review planted: readFileContent, an aliased tool-policy finder, import-equals, builtin aliases", () => {
		// Recurrence: r1 admitted any module it did not list, so a runner that
		// read config through `./utils.js` or `hasPrettierConfig as cfg` stayed
		// green (Tests 9 passed) beside the `process.getBuiltinModule` alias.
		expect(flagged('import { readFileContent } from "./utils.js";')).toBe(true);
		expect(
			flagged(
				'import { hasPrettierConfig as cfg } from "../../tool-policy.js";',
			),
		).toBe(true);
		expect(flagged('import * as tp from "../../tool-policy.js";')).toBe(true);
		expect(flagged('import fs = require("node:fs");')).toBe(true);
		expect(
			flagged('const load = process.getBuiltinModule; const fs = load("fs");'),
		).toBe(true);
		expect(flagged('const r = require; const fs = r("node:fs");')).toBe(true);
		expect(flagged('const g = process["getBuiltinModule"];')).toBe(true);
		expect(flagged("const p = process; p.getBuiltinModule('fs');")).toBe(true);
		expect(flagged("const { getBuiltinModule } = process;")).toBe(true);
		expect(flagged("const fs = globalThis.process;")).toBe(true);
	});

	it("flags a module it was never told about, and admits one it was", () => {
		expect(
			flagged('import { findConfig } from "../../brand-new-finder.js";'),
		).toBe(true);
		expect(flagged('import { Thing } from "some-npm-package";')).toBe(true);
		expect(flagged('import { x } from "../../../tools/other.js";')).toBe(true);
		expect(
			flagged('import { getLinterPolicyForCwd } from "../../tool-policy.js";'),
		).toBe(false);
		expect(
			flagged('import { safeSpawnAsync } from "../../safe-spawn.js";'),
		).toBe(false);
		expect(flagged('import { x } from "../types.js";', "utils/y.ts")).toBe(
			false,
		);
		expect(
			flagged("const cwd = process.cwd(); const e = process.env.HOME;"),
		).toBe(false);
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
