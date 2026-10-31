// flake-shape: real-process-spawn — the defect is markdownlint-cli2's own
// config handling (`"fix": true` in a directory config makes a lint run write
// the file); a double cannot model its option merge or its fix pass.
/**
 * #5119. markdownlint-cli2 has no switch that turns a project's `"fix": true`
 * off, so the diagnostics-only dispatch run rewrote the user's file. Recurrence
 * this guards: `markdownlint.ts` spawned `<cli2> [--config core.json] <file>`
 * with nothing between a project `.markdownlint-cli2.jsonc` and the fix pass.
 * Driven through the production entry points with the real binary: the runner
 * via `runner.run`, and the autofix stage via `runAutofix`, which must keep
 * fixing.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePackagePath } from "../../clients/package-root.js";
import markdownlintRunner from "../../clients/dispatch/runners/markdownlint.js";
import { runAutofix } from "../../clients/pipeline.js";
import { makeRunnerCtx } from "../support/runner-ctx.js";
import { removeTempDirSync } from "./test-utils.js";

// lane: the real-bytes tool tree supplies markdownlint-cli2; a runner without
// it skips the case visibly instead of mocking the binary.
const hasCli2 = (() => {
	try {
		return (
			spawnSync("markdownlint-cli2", ["--no-globs", "-"], {
				input: "",
				stdio: ["pipe", "ignore", "ignore"],
			}).status === 0
		);
	} catch {
		return false;
	}
})();

// MD009 (trailing spaces) is deterministic-fixable; MD041 is off so the
// fixture needs no heading.
const SOURCE = "# Title\n\ntext   \n";
const FIXED = "# Title\n\ntext\n";

let cwd: string;
let filePath: string;

beforeEach(() => {
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
	filePath = path.join(cwd, "doc.md");
	fs.writeFileSync(filePath, SOURCE);
});

afterEach(() => {
	removeTempDirSync(cwd);
});

describe("the no-write preload only touches the markdownlint-cli2 binary (#5119)", () => {
	// Recurrence: a preload that patched every node process it was injected into
	// would also neuter a shim that execs another node program (an install, a
	// cache write) under the same NODE_OPTIONS.
	it("lets another node program write", () => {
		const preload = resolvePackagePath(
			import.meta.url,
			"config",
			"markdownlint",
			"no-write.mjs",
		);
		const target = path.join(os.tmpdir(), `pi-lens-5119-inert-${process.pid}`);
		try {
			const run = spawnSync(
				process.execPath,
				[
					"--import",
					pathToFileURL(preload).href,
					"-e",
					`require("node:fs").promises.writeFile(${JSON.stringify(target)}, "x")`,
				],
				{ encoding: "utf-8" },
			);

			expect(run.status).toBe(0);
			expect(fs.readFileSync(target, "utf-8")).toBe("x");
		} finally {
			fs.rmSync(target, { force: true });
		}
	});
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
	},
);
