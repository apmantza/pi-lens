import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestEnvironment } from "./test-utils.js";

// Mock only the spawn surface — runAutofix's eslint path is pure spawn + JSON
// parsing on top of the real autofix policy (which reads .eslintrc from disk).
const { safeSpawnAsync } = vi.hoisted(() => ({ safeSpawnAsync: vi.fn() }));
vi.mock("../../clients/safe-spawn.js", () => ({ safeSpawnAsync }));

import { runAutofix } from "../../clients/pipeline.js";

// Regression guard for #220: ESLint's `--fix-dry-run` reports the POST-fix state,
// so a fully-autofixable file comes back with fixableErrorCount: 0 and the fixed
// source in the `output` field. Keying on fixableErrorCount alone made
// tryEslintFix never apply fixes. The fix also treats a dry-run `output` field as
// a fix signal.
describe("runAutofix — eslint --fix-dry-run output-field detection (#220)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let filePath: string;

	beforeEach(() => {
		safeSpawnAsync.mockReset();
		env = setupTestEnvironment("pi-lens-eslint-autofix-");
		// eslint is config-first: only selected when a config is present.
		fs.writeFileSync(path.join(env.tmpDir, ".eslintrc.json"), "{}\n");
		filePath = path.join(env.tmpDir, "messy.js");
		fs.writeFileSync(filePath, "const x = 1\nconsole.log(x)\n");
	});

	afterEach(() => env.cleanup());

	function deps() {
		return {
			biomeClient: { isSupportedFile: () => false, ensureAvailable: async () => false },
			ruffClient: { isPythonFile: () => false, ensureAvailable: async () => false },
			fixedThisTurn: new Set<string>(),
		};
	}

	it("applies eslint --fix when the dry-run reports output but fixableErrorCount 0", async () => {
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args.includes("--version")) {
				return { error: null, status: 0, stdout: "v10.5.0", stderr: "" };
			}
			if (args.includes("--fix-dry-run")) {
				// Post-fix state: no remaining problems, fixed source in `output`.
				return {
					error: null,
					status: 0,
					stdout: JSON.stringify([
						{
							messages: [],
							fixableErrorCount: 0,
							fixableWarningCount: 0,
							output: "const x = 1;\nconsole.log(x);\n",
						},
					]),
					stderr: "",
				};
			}
			// the actual --fix apply
			return { error: null, status: 0, stdout: "", stderr: "" };
		});

		const result = await runAutofix(
			filePath,
			env.tmpDir,
			() => undefined,
			() => {},
			deps() as never,
		);

		expect(result.attemptedTools).toContain("eslint");
		expect(result.fixedCount).toBeGreaterThan(0);
		expect(result.autofixTools.some((t) => t.startsWith("eslint"))).toBe(true);
		// The apply pass (--fix, not --fix-dry-run) must actually run.
		const appliedFix = safeSpawnAsync.mock.calls.some(
			(c) => Array.isArray(c[1]) && c[1].includes("--fix") && !c[1].includes("--fix-dry-run"),
		);
		expect(appliedFix).toBe(true);
	});

	it("does not apply eslint --fix when the dry-run reports no fixes and no output", async () => {
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args.includes("--version")) {
				return { error: null, status: 0, stdout: "v10.5.0", stderr: "" };
			}
			if (args.includes("--fix-dry-run")) {
				return {
					error: null,
					status: 0,
					stdout: JSON.stringify([
						{ messages: [], fixableErrorCount: 0, fixableWarningCount: 0 },
					]),
					stderr: "",
				};
			}
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
		const appliedFix = safeSpawnAsync.mock.calls.some(
			(c) => Array.isArray(c[1]) && c[1].includes("--fix") && !c[1].includes("--fix-dry-run"),
		);
		expect(appliedFix).toBe(false);
	});
});
