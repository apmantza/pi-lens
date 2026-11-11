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
 * `not config:` rows read the edited file, a tool binary, a build output, a
 * temp file or locate the target the tool is pointed at (a chart directory, a
 * solution file, a classes directory) and never decide "is this tool
 * configured". A `remainder:` row would decide a config and owe a move onto the
 * seam; none is left (#5408 slice 2), and the pattern below still admits one
 * for a future runner that cannot move at once.
 */
const MEMBERS: Readonly<Record<string, string>> = {
	"lsp.ts":
		"not config: readFileContent of the edited file; detectPythonTargetVersion reads the target version, not a tool's config",
	"ast-grep-napi.ts": "not config: reads the edited file's content and stat",
	"cpp-check.ts": "not config: reads the edited file's content",
	"cue-vet.ts": "not config: reads the edited file's content",
	"dotnet-build.ts":
		"not config: readdirSync(cwd) finds the .sln/.csproj the build is pointed at (a target locator, nothing to run without one)",
	"elixir-check.ts": "not config: mkdirSync of the compile output directory",
	"helm-lint.ts":
		"not config: Chart.yaml via findNearestDirWithMarker locates the chart directory the tool is run in (a target locator)",
	"helm-render.ts":
		"not config: Chart.yaml via findNearestDirWithMarker locates the chart directory, plus the chart-tree readdir (a target locator)",
	"psscriptanalyzer.ts": "not config: writes and removes a temp script",
	"spotbugs.ts":
		"not config: compiled-classes dir discovery by readdirSync (a build artifact the scan is pointed at)",
	"trivy-config.ts": "not config: reads the edited file's content",
	"utils.ts": "not config: reads the edited file's content",
	"utils/candidate-probe.ts": "not config: tool binary candidate probe",
	"utils/markdownlint-api.ts":
		"not config: resolves the markdownlint package from node_modules",
	"utils/runner-helpers.ts": "not config: tool binary availability probe",
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
		for (const file of [
			"detekt.ts",
			"tflint.ts",
			"credo.ts",
			"shfmt.ts",
			"biome-check.ts",
			"eslint.ts",
			"golangci-lint.ts",
			"javac.ts",
			"markdownlint.ts",
			"mypy.ts",
			"oxlint.ts",
			"phpstan.ts",
			"ruff.ts",
			"shellcheck.ts",
			"sqlfluff.ts",
			"stylelint.ts",
			"vale.ts",
			"yamllint.ts",
		]) {
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
		// A property of process that is not on the short list reaches fs too.
		expect(flagged('const b = process.binding("fs");')).toBe(true);
		expect(flagged("const r = process.mainModule?.require;")).toBe(true);
	});

	it("admits the three config-args builders and refuses the retired finders", () => {
		// Recurrence: #5408 slice 2 moved every policy-owned finder onto the seam.
		// The builders stay in tool-policy and only build argv; a finder name
		// that no longer exists, or a namespace/default reach to the module, is
		// still a member, so a runner cannot read config through them again.
		for (const name of [
			"ruffConfigArgs",
			"biomeConfigArgs",
			"markdownlintConfigArgs",
		]) {
			expect(
				flagged(`import { ${name} } from "../../tool-policy.js";`),
				name,
			).toBe(false);
			expect(
				flagged(`import { ${name} as args } from "../../tool-policy.js";`),
				`${name} aliased`,
			).toBe(false);
		}
		for (const name of [
			"hasEslintConfig",
			"hasStylelintConfig",
			"hasMypyConfig",
		]) {
			expect(
				flagged(`import { ${name} } from "../../tool-policy.js";`),
				name,
			).toBe(true);
		}
		expect(flagged('import * as policy from "../../tool-policy.js";')).toBe(
			true,
		);
		expect(flagged('export * from "../../tool-policy.js";')).toBe(true);
		// Indirect reach to the same module: require and dynamic import.
		expect(flagged('const tp = require("../../tool-policy.js");')).toBe(true);
		expect(flagged('const tp = await import("../../tool-policy.js");')).toBe(
			true,
		);
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
