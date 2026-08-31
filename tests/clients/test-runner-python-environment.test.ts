import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
		stdout: "1 passed in 0.01s\n",
		stderr: "",
		status: 0,
	})),
}));

vi.mock("../../clients/package-manager.js", () => ({ findGlobalBinary }));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

import { RUNNERS, TestRunnerClient } from "../../clients/test-runner-client.js";

const tempDirs: string[] = [];
let originalVirtualEnv: string | undefined;
let originalCondaPrefix: string | undefined;

function restoreEnvironmentVariable(
	name: "VIRTUAL_ENV" | "CONDA_PREFIX",
	value: string | undefined,
): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function createProject(withVenv: boolean): {
	root: string;
	testFile: string;
	pythonPath: string;
	binDir: string;
} {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-pytest-environment-"),
	);
	tempDirs.push(root);
	const testFile = path.join(root, "tests", "test_example.py");
	fs.mkdirSync(path.dirname(testFile), { recursive: true });
	fs.writeFileSync(testFile, "def test_example():\n    assert True\n");

	const binDir = path.join(
		root,
		".venv",
		process.platform === "win32" ? "Scripts" : "bin",
	);
	const pythonPath = path.join(
		binDir,
		process.platform === "win32" ? "python.exe" : "python",
	);
	if (withVenv) {
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(pythonPath, "");
	}
	return { root, testFile, pythonPath, binDir };
}

describe("pytest project environment", () => {
	beforeEach(() => {
		originalVirtualEnv = process.env.VIRTUAL_ENV;
		originalCondaPrefix = process.env.CONDA_PREFIX;
		delete process.env.VIRTUAL_ENV;
		delete process.env.CONDA_PREFIX;
		safeSpawnAsync.mockClear();
		findGlobalBinary.mockClear();
	});

	afterEach(() => {
		restoreEnvironmentVariable("VIRTUAL_ENV", originalVirtualEnv);
		restoreEnvironmentVariable("CONDA_PREFIX", originalCondaPrefix);
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs pytest with an unactivated project .venv", async () => {
		const { root, testFile, pythonPath, binDir } = createProject(true);
		const inheritedPath = process.env.PATH;
		const result = await new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"pytest",
			RUNNERS.pytest,
		);

		expect(result.passed).toBe(1);
		expect(safeSpawnAsync).toHaveBeenCalledOnce();
		const [command, args, options] = safeSpawnAsync.mock.calls[0];
		if (!options) throw new Error("pytest spawn options were not supplied");
		expect(command).toBe(pythonPath);
		expect(args).toEqual(["-m", "pytest", testFile, "--tb=short", "-q"]);
		expect(options.cwd).toBe(root);
		expect(options.env?.VIRTUAL_ENV).toBe(path.join(root, ".venv"));
		expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(binDir);
		expect(process.env.VIRTUAL_ENV).toBeUndefined();
		expect(process.env.PATH).toBe(inheritedPath);
		expect(findGlobalBinary).not.toHaveBeenCalled();
	});

	it("keeps the generic Python fallback when no project environment exists", async () => {
		const { root, testFile } = createProject(false);
		await new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"pytest",
			RUNNERS.pytest,
		);

		expect(safeSpawnAsync).toHaveBeenCalledOnce();
		const [command, args, options] = safeSpawnAsync.mock.calls[0];
		if (!options) throw new Error("pytest spawn options were not supplied");
		expect(command).toBe("python");
		expect(args).toEqual(["-m", "pytest", testFile, "--tb=short", "-q"]);
		expect(options.env).toBeUndefined();
	});
});
