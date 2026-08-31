import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	SafeSpawnOptions,
	SpawnResult,
} from "../../clients/safe-spawn.js";

type SafeSpawnAsync = (
	command: string,
	args: string[],
	options?: SafeSpawnOptions,
) => Promise<SpawnResult>;

const { findGlobalBinary, safeSpawnAsync } = vi.hoisted(() => ({
	findGlobalBinary: vi.fn(async () => undefined),
	safeSpawnAsync: vi.fn<SafeSpawnAsync>(async () => ({
		stdout: [
			"E connection to server at 127.0.0.1, port 55432 failed",
			"================ short test summary info ================",
			"FAILED tests/test_example.py::test_one - RuntimeError",
			"FAILED tests/test_example.py::test_two - RuntimeError",
			"2 failed, 1 passed, 50 errors in 2.19s",
		].join("\n"),
		stderr: "",
		status: 1,
	})),
}));

vi.mock("../../clients/package-manager.js", () => ({ findGlobalBinary }));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

import { RUNNERS, TestRunnerClient } from "../../clients/test-runner-client.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("pytest summary parsing", () => {
	it("does not read service-error numbers as failed-test counts", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-pytest-summary-"),
		);
		tempDirs.push(root);
		const testFile = path.join(root, "tests", "test_example.py");
		fs.mkdirSync(path.dirname(testFile), { recursive: true });
		fs.writeFileSync(testFile, "def test_example():\n    assert True\n");

		const result = await new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"pytest",
			RUNNERS.pytest,
		);

		expect(result.passed).toBe(1);
		expect(result.failed).toBe(2);
		expect(result.duration).toBe(2190);
	});
});
