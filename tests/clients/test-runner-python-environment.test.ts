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

vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/package-manager.js")
	>()),
	findGlobalBinary,
}));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

import { RUNNERS, TestRunnerClient } from "../../clients/test-runner-client.js";

const tempDirs: string[] = [];
let originalVirtualEnv: string | undefined;
let originalCondaPrefix: string | undefined;
let originalUvProjectEnvironment: string | undefined;

function restoreEnvironmentVariable(
	name: "VIRTUAL_ENV" | "CONDA_PREFIX" | "UV_PROJECT_ENVIRONMENT",
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
		originalUvProjectEnvironment = process.env.UV_PROJECT_ENVIRONMENT;
		delete process.env.VIRTUAL_ENV;
		delete process.env.CONDA_PREFIX;
		delete process.env.UV_PROJECT_ENVIRONMENT;
		safeSpawnAsync.mockClear();
		findGlobalBinary.mockClear();
	});

	afterEach(() => {
		restoreEnvironmentVariable("VIRTUAL_ENV", originalVirtualEnv);
		restoreEnvironmentVariable("CONDA_PREFIX", originalCondaPrefix);
		restoreEnvironmentVariable(
			"UV_PROJECT_ENVIRONMENT",
			originalUvProjectEnvironment,
		);
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

	it("uses an absolute UV_PROJECT_ENVIRONMENT path", async () => {
		const { root, testFile } = createProject(false);
		const uvEnvironmentRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-uv-project-env-"),
		);
		const binDir = path.join(
			uvEnvironmentRoot,
			process.platform === "win32" ? "Scripts" : "bin",
		);
		const pythonPath = path.join(
			binDir,
			process.platform === "win32" ? "python.exe" : "python",
		);
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(pythonPath, "");
		process.env.UV_PROJECT_ENVIRONMENT = uvEnvironmentRoot;

		try {
			await new TestRunnerClient(false).runTestFileAsync(
				testFile,
				root,
				"pytest",
				RUNNERS.pytest,
			);

			const [command, , options] = safeSpawnAsync.mock.calls[0];
			if (!options) throw new Error("pytest spawn options were not supplied");
			expect(command).toBe(pythonPath);
			expect(options.env?.VIRTUAL_ENV).toBe(uvEnvironmentRoot);
			expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(binDir);
		} finally {
			fs.rmSync(uvEnvironmentRoot, { recursive: true, force: true });
		}
	});

	it("resolves a relative UV_PROJECT_ENVIRONMENT from the workspace root", async () => {
		const workspace = createProject(false);
		const member = path.join(workspace.root, "packages", "member");
		const memberTestFile = path.join(member, "tests", "test_example.py");
		fs.mkdirSync(path.dirname(memberTestFile), { recursive: true });
		fs.writeFileSync(memberTestFile, "def test_example():\n    assert True\n");
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\n",
		);
		fs.writeFileSync(
			path.join(member, "pyproject.toml"),
			"[project]\nname='member'\n",
		);

		const uvEnvironmentRoot = path.join(workspace.root, ".uv-env");
		const binDir = path.join(
			uvEnvironmentRoot,
			process.platform === "win32" ? "Scripts" : "bin",
		);
		const pythonPath = path.join(
			binDir,
			process.platform === "win32" ? "python.exe" : "python",
		);
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(pythonPath, "");
		process.env.UV_PROJECT_ENVIRONMENT = ".uv-env";

		await new TestRunnerClient(false).runTestFileAsync(
			memberTestFile,
			member,
			"pytest",
			RUNNERS.pytest,
		);

		const [command, , options] = safeSpawnAsync.mock.calls[0];
		if (!options) throw new Error("pytest spawn options were not supplied");
		expect(command).toBe(pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(uvEnvironmentRoot);
	});

	it("uses the uv workspace .venv for a member package", async () => {
		const workspace = createProject(false);
		const member = path.join(workspace.root, "packages", "member");
		const memberTestFile = path.join(member, "tests", "test_example.py");
		fs.mkdirSync(path.dirname(memberTestFile), { recursive: true });
		fs.writeFileSync(memberTestFile, "def test_example():\n    assert True\n");
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\n",
		);
		fs.writeFileSync(
			path.join(member, "pyproject.toml"),
			"[project]\nname='member'\n",
		);

		const binDir = path.join(
			workspace.root,
			".venv",
			process.platform === "win32" ? "Scripts" : "bin",
		);
		const pythonPath = path.join(
			binDir,
			process.platform === "win32" ? "python.exe" : "python",
		);
		fs.mkdirSync(binDir, { recursive: true });
		fs.writeFileSync(pythonPath, "");

		await new TestRunnerClient(false).runTestFileAsync(
			memberTestFile,
			member,
			"pytest",
			RUNNERS.pytest,
		);

		const [command, , options] = safeSpawnAsync.mock.calls[0];
		if (!options) throw new Error("pytest spawn options were not supplied");
		expect(command).toBe(pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(path.join(workspace.root, ".venv"));
	});

	it("keeps an independent nested project on its own .venv", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\n",
		);
		const workspaceBinDir = path.join(
			workspace.root,
			".venv",
			process.platform === "win32" ? "Scripts" : "bin",
		);
		const workspacePythonPath = path.join(
			workspaceBinDir,
			process.platform === "win32" ? "python.exe" : "python",
		);
		fs.mkdirSync(workspaceBinDir, { recursive: true });
		fs.writeFileSync(workspacePythonPath, "");

		const nested = path.join(workspace.root, "tools", "standalone");
		const nestedTestFile = path.join(nested, "tests", "test_example.py");
		fs.mkdirSync(path.dirname(nestedTestFile), { recursive: true });
		fs.writeFileSync(nestedTestFile, "def test_example():\n    assert True\n");
		fs.writeFileSync(
			path.join(nested, "pyproject.toml"),
			"[project]\nname='standalone'\n",
		);
		const nestedBinDir = path.join(
			nested,
			".venv",
			process.platform === "win32" ? "Scripts" : "bin",
		);
		const nestedPythonPath = path.join(
			nestedBinDir,
			process.platform === "win32" ? "python.exe" : "python",
		);
		fs.mkdirSync(nestedBinDir, { recursive: true });
		fs.writeFileSync(nestedPythonPath, "");

		await new TestRunnerClient(false).runTestFileAsync(
			nestedTestFile,
			nested,
			"pytest",
			RUNNERS.pytest,
		);

		const [command, , options] = safeSpawnAsync.mock.calls[0];
		if (!options) throw new Error("pytest spawn options were not supplied");
		expect(command).toBe(nestedPythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(path.join(nested, ".venv"));
	});

	it("honors uv workspace exclusions over member globs", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\nexclude = ['packages/excluded']\n",
		);
		const workspaceBinDir = path.join(
			workspace.root,
			".venv",
			process.platform === "win32" ? "Scripts" : "bin",
		);
		const workspacePythonPath = path.join(
			workspaceBinDir,
			process.platform === "win32" ? "python.exe" : "python",
		);
		fs.mkdirSync(workspaceBinDir, { recursive: true });
		fs.writeFileSync(workspacePythonPath, "");

		const excluded = path.join(workspace.root, "packages", "excluded");
		const excludedTestFile = path.join(excluded, "tests", "test_example.py");
		fs.mkdirSync(path.dirname(excludedTestFile), { recursive: true });
		fs.writeFileSync(
			excludedTestFile,
			"def test_example():\n    assert True\n",
		);
		fs.writeFileSync(
			path.join(excluded, "pyproject.toml"),
			"[project]\nname='excluded'\n",
		);
		const excludedBinDir = path.join(
			excluded,
			".venv",
			process.platform === "win32" ? "Scripts" : "bin",
		);
		const excludedPythonPath = path.join(
			excludedBinDir,
			process.platform === "win32" ? "python.exe" : "python",
		);
		fs.mkdirSync(excludedBinDir, { recursive: true });
		fs.writeFileSync(excludedPythonPath, "");

		await new TestRunnerClient(false).runTestFileAsync(
			excludedTestFile,
			excluded,
			"pytest",
			RUNNERS.pytest,
		);

		const [command, , options] = safeSpawnAsync.mock.calls[0];
		if (!options) throw new Error("pytest spawn options were not supplied");
		expect(command).toBe(excludedPythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(path.join(excluded, ".venv"));
	});

	it("labels pytest usage errors and interruptions by their real exit codes", () => {
		const client = new TestRunnerClient(false) as any;
		// The label is derived from pytest's status enum, so keep output empty and
		// avoid pinning a hand-written tool transcript in this parser contract test.
		const usageError = client.parsePytestOutput(
			"",
			"",
			4,
			"/tmp/test_example.py",
			"/tmp",
			"pytest",
		);
		const interrupted = client.parsePytestOutput(
			"",
			"",
			2,
			"/tmp/test_example.py",
			"/tmp",
			"pytest",
		);

		expect(usageError.error).toBe("Pytest configuration error");
		expect(interrupted.error).toBe("Pytest interrupted");
	});
});
