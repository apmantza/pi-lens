import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";

// Mock only the spawn surface — runAutofix's eslint path is pure spawn +
// before/after file diffing on top of the real autofix policy (which reads
// .eslintrc from disk).
const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

import { runAutofix } from "../../clients/pipeline.js";

// Regression guard for #453: eslint autofix used to spawn twice
// (--fix-dry-run to count fixable issues, then --fix to apply), doubling
// ESLint's 1-3s cold start. tryEslintFix now runs a single `--fix` spawn and
// detects the fix via before/after file content, same idiom as
// tryStylelintFix/tryOxlintFix/etc. Exit code 1 (unfixable problems remain)
// must still be treated as success when the file changed.
describe("runAutofix — eslint single-spawn --fix (#453)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let filePath: string;

	beforeEach(() => {
		safeSpawnAsync.mockReset();
		env = setupTestEnvironment("pi-lens-eslint-autofix-");
		// eslint is config-first: only selected when a config is present.
		fs.writeFileSync(path.join(env.tmpDir, ".eslintrc.json"), "{}\n");
		fs.writeFileSync(
			path.join(env.tmpDir, "package.json"),
			JSON.stringify({ devDependencies: { eslint: "^10.5.0" } }),
		);
		fs.writeFileSync(
			path.join(env.tmpDir, "package-lock.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: { "": {}, "node_modules/eslint": { version: "10.5.0" } },
			}),
		);
		filePath = path.join(env.tmpDir, "messy.js");
		fs.writeFileSync(filePath, "const x = 1\nconsole.log(x)\n");
	});

	afterEach(() => env.cleanup());

	function deps() {
		return {
			biomeClient: {
				isSupportedFile: () => false,
				ensureAvailable: async () => false,
			},
			ruffClient: {
				isPythonFile: () => false,
				ensureAvailable: async () => false,
			},
			fixedThisTurn: new Set<string>(),
		};
	}

	it("spawns eslint exactly once and reports a fix when --fix changes the file", async () => {
		let fixCalls = 0;
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args.includes("--version")) {
				return { error: null, status: 0, stdout: "v10.5.0", stderr: "" };
			}
			// no --fix-dry-run branch: the dry-run spawn must be gone entirely.
			expect(args).not.toContain("--fix-dry-run");
			fixCalls++;
			fs.writeFileSync(filePath, "const x = 1;\nconsole.log(x);\n");
			return { error: null, status: 0, stdout: "", stderr: "" };
		});

		const result = await runAutofix(
			filePath,
			env.tmpDir,
			() => undefined,
			() => {},
			deps() as never,
		);

		expect(fixCalls).toBe(1);
		expect(result.attemptedTools).toContain("eslint");
		expect(result.fixedCount).toBeGreaterThan(0);
		expect(result.autofixTools.some((t) => t.startsWith("eslint"))).toBe(true);
	});

	it("does not report a fix when eslint --fix leaves the file unchanged", async () => {
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args.includes("--version")) {
				return { error: null, status: 0, stdout: "v10.5.0", stderr: "" };
			}
			// file left untouched
			return { error: null, status: 0, stdout: "", stderr: "" };
		});

		const result = await runAutofix(
			filePath,
			env.tmpDir,
			() => undefined,
			() => {},
			deps() as never,
		);

		expect(result.fixedCount).toBe(0);
	});

	it("still counts as fixed when eslint exits 1 (unfixable problems remain) but the file changed", async () => {
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args.includes("--version")) {
				return { error: null, status: 0, stdout: "v10.5.0", stderr: "" };
			}
			fs.writeFileSync(filePath, "const x = 1;\nconsole.log(x);\n");
			return { error: null, status: 1, stdout: "", stderr: "" };
		});

		const result = await runAutofix(
			filePath,
			env.tmpDir,
			() => undefined,
			() => {},
			deps() as never,
		);

		expect(result.fixedCount).toBeGreaterThan(0);
	});
});
