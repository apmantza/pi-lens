/**
 * #440 — per-rule `skip_test_files` carve-out. `python-assert-production` flags
 * `assert` (stripped by python -O), but `assert` is the idiomatic test assertion,
 * so firing in test files is pure noise. The tree-sitter runner otherwise runs on
 * test files, so the rule opts out via `skip_test_files`. Exercised through the
 * REAL runner (real client + real query loader) so the isTestFile filter is under
 * test, not mocked away.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FactStore } from "../../../../clients/dispatch/fact-store.js";
import treeSitterRunner from "../../../../clients/dispatch/runners/tree-sitter.js";
import { setupTestEnvironment } from "../../test-utils.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
	for (const c of cleanups) c();
});

function ctxFor(filePath: string) {
	return {
		filePath,
		cwd: path.dirname(filePath),
		kind: "python",
		fileRole: "source",
		pi: { getFlag: () => undefined },
		autofix: false,
		deltaMode: true,
		blockingOnly: false,
		modifiedRanges: undefined,
		facts: new FactStore(),
		hasTool: async () => true,
		log: () => {},
	};
}

async function rulesFor(filePath: string): Promise<string[]> {
	const result = await treeSitterRunner.run(ctxFor(filePath) as never);
	return (result.diagnostics ?? []).map((d) => d.rule ?? d.id ?? "");
}

const ASSERT_SRC = "def f(x):\n    assert x > 0, 'x required'\n    return x\n";

describe("tree-sitter runner — skip_test_files (#440)", () => {
	it("flags python-assert-production in a production file", async () => {
		const env = setupTestEnvironment("pi-lens-440-prod-");
		cleanups.push(env.cleanup);
		const fp = path.join(env.tmpDir, "app.py");
		fs.writeFileSync(fp, ASSERT_SRC);
		expect(await rulesFor(fp)).toContain("python-assert-production");
	});

	it("does NOT flag python-assert-production in a tests/ file", async () => {
		const env = setupTestEnvironment("pi-lens-440-test-");
		cleanups.push(env.cleanup);
		const testsDir = path.join(env.tmpDir, "tests");
		fs.mkdirSync(testsDir, { recursive: true });
		const fp = path.join(testsDir, "test_app.py");
		fs.writeFileSync(fp, "def test_ok():\n    assert 1 + 1 == 2\n");
		expect(await rulesFor(fp)).not.toContain("python-assert-production");
	});
});
