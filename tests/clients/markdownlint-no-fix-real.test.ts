// flake-shape: real-process-spawn — the defect is markdownlint-cli2's own
// config handling (`"fix": true` in a directory config makes a lint run write
// the file); a double cannot model its option merge or its fix pass.
/**
 * #5119. markdownlint-cli2 has no CLI switch that turns a project's
 * `"fix": true` off, so the diagnostics-only dispatch run rewrote the user's
 * file. Recurrence this guards: `markdownlint.ts` spawned
 * `<cli2> [--config core.json] <file>` with nothing between a project
 * `.markdownlint-cli2.jsonc` and the fix pass. Driven through the production
 * entry points with the real module: the runner via `runner.run`, and the
 * autofix stage via `runAutofix`, which must keep fixing.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProjectTrustState } from "../../clients/project-trust.js";
import markdownlintRunner from "../../clients/dispatch/runners/markdownlint.js";
import { runMarkdownlintApi } from "../../clients/dispatch/runners/utils/markdownlint-api.js";
import { runAutofix } from "../../clients/pipeline.js";
import { makeRunnerCtx } from "../support/runner-ctx.js";
import { removeTempDirSync } from "./test-utils.js";

// lane: the real-bytes tool tree puts markdownlint-cli2 on PATH (the same
// lane that supplies ruff); a runner without it skips the case visibly instead
// of mocking the module.
const CLI2_PACKAGE = (() => {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		try {
			const bin = fs.realpathSync(path.join(dir, "markdownlint-cli2"));
			return path.dirname(bin);
		} catch {
			// not in this PATH entry
		}
	}
	return null;
})();
const hasCli2 = CLI2_PACKAGE !== null;

/** Install the real package into the project the way npm lays it out. */
function linkCli2(into: string): void {
	const modules = path.join(into, "node_modules");
	fs.mkdirSync(path.join(modules, ".bin"), { recursive: true });
	fs.symlinkSync(
		CLI2_PACKAGE as string,
		path.join(modules, "markdownlint-cli2"),
		"dir",
	);
	fs.symlinkSync(
		"../markdownlint-cli2/markdownlint-cli2-bin.mjs",
		path.join(modules, ".bin", "markdownlint-cli2"),
	);
}

// MD009 (trailing spaces) is deterministic-fixable; MD041 is off so the
// fixture needs no heading.
const SOURCE = "# Title\n\ntext   \n";
const FIXED = "# Title\n\ntext\n";

let cwd: string;
let filePath: string;

beforeEach(() => {
	setProjectTrustState("trusted");
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-5119-md-"));
	fs.writeFileSync(
		path.join(cwd, ".markdownlint-cli2.jsonc"),
		'{ "fix": true }\n',
	);
	// The autofix gate wants the project to declare the tool (package + lockfile).
	fs.writeFileSync(
		path.join(cwd, "package.json"),
		JSON.stringify({ devDependencies: { "markdownlint-cli2": "^0.23.2" } }),
	);
	fs.writeFileSync(
		path.join(cwd, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"": {},
				"node_modules/markdownlint-cli2": { version: "0.23.2" },
			},
		}),
	);
	if (hasCli2) {
		linkCli2(cwd);
		// The runner's PATH rung resolves the bare command name; leading with the
		// project's own bin pins WHICH cli2 the runner and the autofix stage use.
		vi.stubEnv(
			"PATH",
			`${path.join(cwd, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`,
		);
	}
	filePath = path.join(cwd, "doc.md");
	fs.writeFileSync(filePath, SOURCE);
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirSync(cwd);
});

describe.skipIf(!hasCli2)(
	"a diagnostics-only markdownlint pass never writes the file (#5119)",
	() => {
		it("runner keeps the bytes and still reports MD009 under a project fix: true", async () => {
			const result = await markdownlintRunner.run(
				makeRunnerCtx(filePath, cwd, { kind: "markdown" }) as never,
			);

			expect(fs.readFileSync(filePath, "utf-8")).toBe(SOURCE);
			expect(result.diagnostics.map((d) => d.rule)).toContain("MD009");
		});

		it("autofix stage still fixes the same file", async () => {
			const result = await runAutofix(
				filePath,
				cwd,
				() => false,
				() => {},
				{
					biomeClient: {} as never,
					ruffClient: {} as never,
					fixedThisTurn: new Set<string>(),
				},
			);

			expect(
				result.autofixTools.some((t) => t.startsWith("markdownlint:")),
			).toBe(true);
			expect(fs.readFileSync(filePath, "utf-8")).toBe(FIXED);
		});

		// Recurrence: a lint path that re-implemented config resolution (stdin,
		// a temp copy) lost a parent directory's config and a nested one. The
		// API must report exactly the lines the CLI reports for the same tree.
		it("reports the same findings, lines and paths as the CLI over parent and nested configs", async () => {
			const nested = path.join(cwd, "docs", "sub");
			fs.mkdirSync(nested, { recursive: true });
			// Parent turns MD041 and MD013 off; the nested config turns MD012 off.
			fs.writeFileSync(
				path.join(cwd, ".markdownlint-cli2.jsonc"),
				'{ "config": { "MD041": false, "MD013": false } }\n',
			);
			fs.writeFileSync(
				path.join(nested, ".markdownlint.jsonc"),
				'{ "MD012": false }\n',
			);
			const doc = path.join(nested, "a.md");
			fs.writeFileSync(
				doc,
				"# Title\n\ntext   \n\n\n\n## Sub\n* item\n- item\nno newline at end",
			);

			const api = await runMarkdownlintApi({
				command: path.join(cwd, "node_modules", ".bin", "markdownlint-cli2"),
				cwd,
				args: [doc],
				timeoutMs: 15000,
			});
			const cli = spawnSync(
				process.execPath,
				[path.join(CLI2_PACKAGE as string, "markdownlint-cli2-bin.mjs"), doc],
				{ cwd, encoding: "utf-8" },
			);

			const findings = (text: string) =>
				text
					.split(/\r?\n/)
					.filter((line) => /:\d+(:\d+)? /.test(line))
					.sort();
			const fromApi = findings(`${api?.stdout}${api?.stderr}`);
			expect(fromApi.length).toBeGreaterThan(2);
			expect(fromApi.join("\n")).toContain("MD009");
			expect(fromApi.join("\n")).not.toContain("MD012");
			expect(fromApi.join("\n")).not.toContain("MD041");
			expect(fromApi).toEqual(findings(`${cli.stdout}${cli.stderr}`));
			expect(api?.status).toBe(cli.status);
		});

		// Recurrence: the package-owned fallback config (`--config core.json`,
		// MD013 off) must still reach `main` when the project has no config.
		it("applies the package-owned fallback config when the project has none", async () => {
			fs.rmSync(path.join(cwd, ".markdownlint-cli2.jsonc"));
			fs.writeFileSync(filePath, `# Title\n\n${"word ".repeat(60)}\n`);

			const result = await markdownlintRunner.run(
				makeRunnerCtx(filePath, cwd, { kind: "markdown" }) as never,
			);

			expect(result.diagnostics.map((d) => d.rule)).not.toContain("MD013");
			expect(fs.readFileSync(filePath, "utf-8")).toContain("word ");
		});
	},
);
