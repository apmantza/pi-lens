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

import {
	detectPythonEnvironment,
	type PythonEnvironmentSource,
} from "../../clients/python-environment.js";
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

function createTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Materialize a venv-shaped directory (the layout `detectPythonEnvironment` probes). */
function createEnvironment(root: string): {
	root: string;
	binDir: string;
	pythonPath: string;
} {
	const binDir = path.join(
		root,
		process.platform === "win32" ? "Scripts" : "bin",
	);
	const pythonPath = path.join(
		binDir,
		process.platform === "win32" ? "python.exe" : "python",
	);
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(pythonPath, "");
	return { root, binDir, pythonPath };
}

/** Materialize a `<dir>/tests/test_example.py` and return its path. */
function createTestFile(dir: string): string {
	const testFile = path.join(dir, "tests", "test_example.py");
	fs.mkdirSync(path.dirname(testFile), { recursive: true });
	fs.writeFileSync(testFile, "def test_example():\n    assert True\n");
	return testFile;
}

function createProject(withVenv: boolean): {
	root: string;
	testFile: string;
	pythonPath: string;
	binDir: string;
} {
	const root = createTempDir("pi-lens-pytest-environment-");
	const testFile = createTestFile(root);
	const dotVenv = path.join(root, ".venv");
	const binDir = path.join(
		dotVenv,
		process.platform === "win32" ? "Scripts" : "bin",
	);
	const pythonPath = path.join(
		binDir,
		process.platform === "win32" ? "python.exe" : "python",
	);
	if (withVenv) createEnvironment(dotVenv);
	return { root, testFile, pythonPath, binDir };
}

async function runPytest(
	testFile: string,
	projectRoot: string,
): Promise<{ command: string; options: SafeSpawnOptions }> {
	await new TestRunnerClient(false).runTestFileAsync(
		testFile,
		projectRoot,
		"pytest",
		RUNNERS.pytest,
	);
	const [command, , options] = safeSpawnAsync.mock.calls[0];
	if (!options) throw new Error("pytest spawn options were not supplied");
	return { command, options };
}

// File-level so BOTH describes below get the isolation: the state-space grid
// sets these same variables, and hooks scoped to one describe left the other
// reading a leaked VIRTUAL_ENV (AGENTS.md test screen: env leakage).
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

describe("pytest project environment", () => {
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

	it("uses an absolute UV_PROJECT_ENVIRONMENT path for a uv project", async () => {
		const { root, testFile } = createProject(false);
		fs.writeFileSync(
			path.join(root, "pyproject.toml"),
			"[project]\nname='app'\n",
		);
		const uvEnvironment = createEnvironment(
			createTempDir("pi-lens-uv-project-env-"),
		);
		process.env.UV_PROJECT_ENVIRONMENT = uvEnvironment.root;

		const { command, options } = await runPytest(testFile, root);

		expect(command).toBe(uvEnvironment.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(uvEnvironment.root);
		expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(
			uvEnvironment.binDir,
		);
	});

	// uv's documented CI/Docker recipe exports UV_PROJECT_ENVIRONMENT process-
	// wide (docs/concepts/projects/config.md). It is a uv *project* setting:
	// `uv` only honors it after discovering a pyproject.toml, so an exported
	// value must not hijack a directory that is not a uv project at all —
	// AGENTS.md defect shape 13 (an ambient signal outranking the specific
	// one). Guard for: an exported UV_PROJECT_ENVIRONMENT outranking a
	// non-uv project's own `.venv` / activated VIRTUAL_ENV (review round 2, F1).
	it("ignores an exported UV_PROJECT_ENVIRONMENT outside a uv project", async () => {
		const { root, testFile, pythonPath } = createProject(true);
		const exported = createEnvironment(createTempDir("pi-lens-uv-ci-env-"));
		process.env.UV_PROJECT_ENVIRONMENT = exported.root;

		const { command, options } = await runPytest(testFile, root);

		expect(command).toBe(pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(path.join(root, ".venv"));
	});

	it("keeps an activated VIRTUAL_ENV over an exported UV_PROJECT_ENVIRONMENT outside a uv project", async () => {
		const { root, testFile } = createProject(false);
		const activated = createEnvironment(
			createTempDir("pi-lens-activated-env-"),
		);
		const exported = createEnvironment(createTempDir("pi-lens-uv-ci-env-"));
		process.env.VIRTUAL_ENV = activated.root;
		process.env.UV_PROJECT_ENVIRONMENT = exported.root;

		const { command, options } = await runPytest(testFile, root);

		expect(command).toBe(activated.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(activated.root);
	});

	// uv resolves a relative UV_PROJECT_ENVIRONMENT against the workspace root
	// of the project it discovered (uv 3c979abda4530fe9bf3d92e9bcf5c5575e3b3126,
	// crates/uv-workspace/src/workspace.rs), never against the cwd. Round 2 of
	// this PR pinned that with a fixture whose passed root sat BELOW the
	// pyproject.toml — the rejected premise: a directory below a project root
	// gets nothing (I1/I2). Here the passed root IS the project.
	it("resolves a relative UV_PROJECT_ENVIRONMENT from the project root itself", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\n",
		);
		// Not a member of the workspace above it, so it is its own single-project
		// workspace and `.uv-env` resolves against ITS OWN root.
		const standalone = path.join(workspace.root, "tools", "standalone");
		const testFile = createTestFile(standalone);
		fs.writeFileSync(
			path.join(standalone, "pyproject.toml"),
			"[project]\nname='standalone'\n",
		);
		const expected = createEnvironment(path.join(standalone, ".uv-env"));
		process.env.UV_PROJECT_ENVIRONMENT = ".uv-env";

		const { command, options } = await runPytest(testFile, standalone);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	// The sibling of the case above, and the S1 defect: pi-lens hands this
	// resolver a dispatch cwd / LSP root that can sit BELOW the pyproject.toml
	// (PythonServer's NearestRoot detector returns `<mono>/frontend` off a
	// requirements.txt while the pyproject.toml sits at `<mono>`). Such a
	// directory is not the project, so it inherits nothing from it — not the
	// project's UV_PROJECT_ENVIRONMENT, not an ancestor `.venv`. Guard for:
	// the uv candidates gated on "a pyproject at or ABOVE root" rather than
	// "root IS the project" (review round 3, S1).
	it("gives a directory below a project root none of that project's uv environment", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[project]\nname='app'\n",
		);
		createEnvironment(path.join(workspace.root, ".uv-env"));
		const below = path.join(workspace.root, "frontend");
		const testFile = createTestFile(below);
		const own = createEnvironment(path.join(below, ".venv"));
		process.env.UV_PROJECT_ENVIRONMENT = ".uv-env";

		const { command, options } = await runPytest(testFile, below);

		expect(command).toBe(own.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(own.root);
	});

	// Probe R2: the same shape with an activated VIRTUAL_ENV, which must win
	// over a project the directory does not belong to (review round 3, S1).
	it("keeps an activated VIRTUAL_ENV for a directory below a project root", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.poetry]\nname='mono'\n",
		);
		const exported = createEnvironment(createTempDir("pi-lens-uv-ci-env-"));
		const activated = createEnvironment(
			createTempDir("pi-lens-activated-env-"),
		);
		const below = path.join(workspace.root, "frontend");
		const testFile = createTestFile(below);
		process.env.UV_PROJECT_ENVIRONMENT = exported.root;
		process.env.VIRTUAL_ENV = activated.root;

		const { command, options } = await runPytest(testFile, below);

		expect(command).toBe(activated.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(activated.root);
	});

	// uv treats the workspace root as a member of its own workspace, but only
	// as a PROJECT: `<ws>/docs` is not a project and must not inherit the
	// workspace `.venv` just because `path.relative(ws, ws)` was compared
	// before the walk result was consulted. Guard for: the
	// `projectRoot === workspace.root` shortcut in `isUvWorkspaceMember`
	// promoting any non-project subdirectory of the workspace root to a member
	// — bypassing `exclude` entirely (review round 3, S2).
	it("does not give a non-project subdirectory of a workspace root the workspace .venv", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\n",
		);
		createEnvironment(path.join(workspace.root, ".venv"));
		const docs = path.join(workspace.root, "docs");
		const testFile = createTestFile(docs);

		const { command, options } = await runPytest(testFile, docs);

		expect(command).toBe("python");
		expect(options.env).toBeUndefined();
	});

	it("does not give an EXCLUDED non-project subdirectory the workspace .venv", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\nexclude = ['docs']\n",
		);
		createEnvironment(path.join(workspace.root, ".venv"));
		const docs = path.join(workspace.root, "docs");
		const testFile = createTestFile(docs);

		const { command, options } = await runPytest(testFile, docs);

		expect(command).toBe("python");
		expect(options.env).toBeUndefined();
	});

	// Probe G: the workspace root IS a project, so it keeps its own `.venv` —
	// the same directory the deleted shortcut used to report as `uv-workspace`.
	it("keeps the workspace root itself on its own .venv", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\n",
		);
		const own = createEnvironment(path.join(workspace.root, ".venv"));

		const environment = await detectPythonEnvironment(
			workspace.root,
			os.tmpdir(),
		);

		expect(environment?.source).toBe("project-dot-venv");
		expect(environment?.root).toBe(own.root);
	});

	// uv matches member globs with `require_literal_leading_dot: false`
	// (MatchOptions::new()'s default, uv 3c979abda4530fe9bf3d92e9bcf5c5575e3b3126
	// `is_included_in_workspace`), so `*` matches a dot-directory. minimatch
	// needs `dot: true` to say the same thing. Guard for: dropping that option
	// (review round 3, T2).
	it("matches a dot-directory member the way uv's MatchOptions do", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['*']\n",
		);
		const expected = createEnvironment(path.join(workspace.root, ".venv"));
		const member = path.join(workspace.root, ".hidden-pkg");
		fs.mkdirSync(member, { recursive: true });
		fs.writeFileSync(
			path.join(member, "pyproject.toml"),
			"[project]\nname='hidden'\n",
		);

		const environment = await detectPythonEnvironment(member, os.tmpdir());

		expect(environment?.source).toBe("uv-workspace");
		expect(environment?.root).toBe(expected.root);
	});

	// `detectPythonEnvironment` resolves its root once at the seam entry, so
	// every path it hands back is absolute and every path comparison it makes
	// is against an absolute path. `path.join`/`path.relative` normalize an
	// unnormalized ABSOLUTE argument on their own, so only a relative argument
	// exercises this: without it, the probe still finds `proj/.venv` (relative
	// `access` resolves against the cwd) and hands the caller a relative
	// interpreter path to spawn. Guard for: dropping that normalization
	// (review round 3, T2). `process.chdir` is a deliberate boundary here —
	// a relative root is only meaningful against a cwd — and is restored in
	// `finally`.
	it("resolves a relative root to an absolute interpreter path", async () => {
		const workspace = createProject(true);
		const expected = path.join(workspace.root, ".venv");
		const originalCwd = process.cwd();

		try {
			process.chdir(path.dirname(workspace.root));
			const environment = await detectPythonEnvironment(
				path.basename(workspace.root),
				os.tmpdir(),
			);

			expect(environment?.source).toBe("project-dot-venv");
			expect(environment?.root).toBe(expected);
		} finally {
			process.chdir(originalCwd);
		}
	});

	// The resolver walks up for a pyproject.toml, so an ancestor project's
	// `.venv` is reachable from any descendant directory. Inheriting it is
	// wrong for every non-uv-workspace layout: a poetry (or plain PEP 621)
	// root does not lend its environment to a sibling subtree that is not a
	// Python project at all. Guard for: ancestor-`.venv` inheritance outside
	// an explicit uv workspace (review round 2, F3).
	it("does not inherit an ancestor project's .venv from a subdirectory", async () => {
		const { root } = createProject(false);
		fs.writeFileSync(
			path.join(root, "pyproject.toml"),
			"[tool.poetry]\nname='mono'\n",
		);
		createEnvironment(path.join(root, ".venv"));
		const frontend = path.join(root, "frontend");
		const testFile = createTestFile(frontend);

		const { command, options } = await runPytest(testFile, frontend);

		expect(command).toBe("python");
		expect(options.env).toBeUndefined();
	});

	// `walkUpDirs` is unbounded, so without the HOME ceiling an unrelated
	// `[tool.uv.workspace]` sitting in `/tmp`, `/home`, or `$HOME` itself claims
	// every project beneath it as a member and lends them its `.venv`.
	// `isAtOrAboveHomeDir` is the shared ceiling primitive (#625), and `homeDir`
	// is injected the way every sibling walker takes it (#2536/#2544 F2).
	// Guard for: the walk reading a pyproject.toml at or above $HOME (review
	// round 2, F6). The fixture claims the project as a MEMBER because the
	// round-3 `isStartDir` gate already discards a bare ancestor project — only
	// an explicit workspace above $HOME can still change the answer.
	it("stops the uv workspace walk at the home directory", async () => {
		const base = createTempDir("pi-lens-uv-home-ceiling-");
		const homeDir = path.join(base, "home");
		const project = path.join(homeDir, "project");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(
			path.join(project, "pyproject.toml"),
			"[project]\nname='mine'\n",
		);
		fs.writeFileSync(
			path.join(base, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['home/*']\n",
		);
		createEnvironment(path.join(base, ".venv"));

		expect(await detectPythonEnvironment(project, homeDir)).toBeUndefined();
	});

	// uv normalizes a member glob before matching it, so a leading `./` is not
	// part of the pattern (uv 3c979abda4530fe9bf3d92e9bcf5c5575e3b3126,
	// `is_included_in_workspace` -> `normalize_path`, and the upstream fixture
	// `exclude_package_with_normalized_glob_and_escaped_root`).
	it("matches a uv member glob written with a leading ./", async () => {
		const workspace = createProject(false);
		const member = path.join(workspace.root, "packages", "member");
		const memberTestFile = createTestFile(member);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['./packages/*']\n",
		);
		fs.writeFileSync(
			path.join(member, "pyproject.toml"),
			"[project]\nname='member'\n",
		);
		const expected = createEnvironment(path.join(workspace.root, ".venv"));

		const { command, options } = await runPytest(memberTestFile, member);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	it("resolves a relative UV_PROJECT_ENVIRONMENT from the workspace root", async () => {
		const workspace = createProject(false);
		const member = path.join(workspace.root, "packages", "member");
		const memberTestFile = createTestFile(member);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\n",
		);
		fs.writeFileSync(
			path.join(member, "pyproject.toml"),
			"[project]\nname='member'\n",
		);
		const expected = createEnvironment(path.join(workspace.root, ".uv-env"));
		process.env.UV_PROJECT_ENVIRONMENT = ".uv-env";

		const { command, options } = await runPytest(memberTestFile, member);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	it("uses the uv workspace .venv for a member package", async () => {
		const workspace = createProject(false);
		const member = path.join(workspace.root, "packages", "member");
		const memberTestFile = createTestFile(member);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\n",
		);
		fs.writeFileSync(
			path.join(member, "pyproject.toml"),
			"[project]\nname='member'\n",
		);
		const expected = createEnvironment(path.join(workspace.root, ".venv"));

		const { command, options } = await runPytest(memberTestFile, member);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	it("keeps an independent nested project on its own .venv", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\n",
		);
		createEnvironment(path.join(workspace.root, ".venv"));

		const nested = path.join(workspace.root, "tools", "standalone");
		const nestedTestFile = createTestFile(nested);
		fs.writeFileSync(
			path.join(nested, "pyproject.toml"),
			"[project]\nname='standalone'\n",
		);
		const expected = createEnvironment(path.join(nested, ".venv"));

		const { command, options } = await runPytest(nestedTestFile, nested);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	it("honors uv workspace exclusions over member globs", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/*']\nexclude = ['packages/excluded']\n",
		);
		createEnvironment(path.join(workspace.root, ".venv"));

		const excluded = path.join(workspace.root, "packages", "excluded");
		const excludedTestFile = createTestFile(excluded);
		fs.writeFileSync(
			path.join(excluded, "pyproject.toml"),
			"[project]\nname='excluded'\n",
		);
		const expected = createEnvironment(path.join(excluded, ".venv"));

		const { command, options } = await runPytest(excludedTestFile, excluded);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	// uv matches `exclude` with `Pattern::matches_path` — `MatchOptions::new()`
	// defaults, `require_literal_separator: false` — so a `*` in an EXCLUSION
	// crosses `/`, unlike one in `members`
	// (astral-sh/uv@3c979abda4530fe9bf3d92e9bcf5c5575e3b3126,
	// `crates/uv-workspace/src/workspace.rs`, `WorkspaceExclusions::matches` vs
	// `is_included_in_workspace`). minimatch could not express that, so pi-lens
	// documented it as a limitation and UNDER-excluded; #2591's dialect object
	// implements it. Driven through the real runner → detectPythonEnvironment
	// path, not through the matcher, so the resolver's own answer is asserted.
	it("excludes a nested member through a separator-crossing exclusion `*` (#2591)", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/**']\nexclude = ['packages/a*c']\n",
		);
		createEnvironment(path.join(workspace.root, ".venv"));

		const nested = path.join(workspace.root, "packages", "a", "b", "c");
		const nestedTestFile = createTestFile(nested);
		fs.writeFileSync(
			path.join(nested, "pyproject.toml"),
			"[project]\nname='nested'\n",
		);
		const expected = createEnvironment(path.join(nested, ".venv"));

		const { command, options } = await runPytest(nestedTestFile, nested);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	// The companion to the vector above: the SAME glob shape in `members` must
	// NOT cross `/`, because `is_included_in_workspace` passes
	// `require_literal_separator: true`. One tool, two option sets — the reason
	// the fold takes a dialect object rather than a flag. Without the workspace
	// `.venv` this would pass vacuously, so the workspace environment IS
	// materialized: the assertion is that the resolver declines to use it.
	it("does not admit a nested project through a members `*` that would have to cross `/` (#2591)", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/a*c']\n",
		);
		createEnvironment(path.join(workspace.root, ".venv"));

		const nested = path.join(workspace.root, "packages", "a", "b", "c");
		const nestedTestFile = createTestFile(nested);
		fs.writeFileSync(
			path.join(nested, "pyproject.toml"),
			"[project]\nname='nested'\n",
		);
		const expected = createEnvironment(path.join(nested, ".venv"));

		const { command, options } = await runPytest(nestedTestFile, nested);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
	});

	// A `**` in `members` DOES cross components — the axis on which uv and cargo
	// genuinely disagree, and the reason folding cargo onto uv's dialect (or the
	// reverse) was rejected in #2583. Same fixture as the exclusion vector above
	// with the exclusion removed, so the two differ only on the axis under test.
	it("admits a deeply nested project through a members `**` (#2591)", async () => {
		const workspace = createProject(false);
		fs.writeFileSync(
			path.join(workspace.root, "pyproject.toml"),
			"[tool.uv.workspace]\nmembers = ['packages/**']\n",
		);
		const expected = createEnvironment(path.join(workspace.root, ".venv"));

		const nested = path.join(workspace.root, "packages", "a", "b", "c");
		const nestedTestFile = createTestFile(nested);
		fs.writeFileSync(
			path.join(nested, "pyproject.toml"),
			"[project]\nname='nested'\n",
		);
		createEnvironment(path.join(nested, ".venv"));

		const { command, options } = await runPytest(nestedTestFile, nested);

		expect(command).toBe(expected.pythonPath);
		expect(options.env?.VIRTUAL_ENV).toBe(expected.root);
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

/**
 * The resolver's full state space (review round 3). AGENTS.md's state-space
 * step applies once a seam reaches this round count: the grid below is
 * derived from the DOCUMENTED contract, not read off the implementation —
 *
 *   I1 the two uv candidates exist only when the passed root IS a uv project
 *      root; the `uv-workspace` candidate additionally requires root to be a
 *      declared, non-excluded member of an explicit workspace.
 *   I2 nothing below a project root inherits anything from above it.
 *   I3 a relative UV_PROJECT_ENVIRONMENT anchors at the member's workspace
 *      root, else at the project root (which, per I1, is the passed root).
 *   I4 precedence: uv-project-environment > uv-workspace > VIRTUAL_ENV >
 *      CONDA_PREFIX > <root>/.venv > <root>/venv; a candidate whose
 *      interpreter is missing falls through, and exhausting them is
 *      `undefined`.
 *
 * The expected source per cell is computed from those four rules alone
 * (`expectedSource` below), so a change in the implementation that is not
 * also a change in the contract reds here rather than silently re-baselining
 * — the "implementation mirror" screen. Each uv-project-environment cell also
 * asserts the resolved ROOT, which is what pins I3's anchor: the fixture
 * materializes the environment only at the contract's anchor, so a resolver
 * anchoring anywhere else falls through to a different source.
 *
 * CONDA_PREFIX is held unset (an unconditional pass-through already pinned by
 * tests/clients/lsp/server-policy.test.ts) and <root>/venv held absent; both
 * sit below `.venv` in I4 and add no interaction.
 */
describe("python environment state space (review round 3)", () => {
	type Position = "A1" | "A2" | "A3" | "A4" | "A5" | "A6";
	const POSITIONS: Array<[Position, string]> = [
		["A1", "root-is-project (implicit single project)"],
		["A2", "root-below-project"],
		["A3", "root-is-declared-member of an explicit workspace"],
		["A4", "root-excluded (a project the workspace excludes)"],
		["A5", "no-pyproject anywhere at or above root"],
		["A6", "root-is-explicit-workspace-root"],
	];
	const UV_VALUES = ["U-abs", "U-rel", "U-unset"] as const;
	const VIRTUAL_VALUES = ["V-set", "V-unset"] as const;
	const DOT_VENV_VALUES = ["D-present", "D-absent"] as const;

	/** I1: does the passed root get uv's project settings at all? */
	const isProjectRoot = (position: Position): boolean =>
		position === "A1" ||
		position === "A3" ||
		position === "A4" ||
		position === "A6";
	/** I1: does it additionally inherit the workspace `.venv`? */
	const isWorkspaceMember = (position: Position): boolean => position === "A3";

	function expectedSource(
		position: Position,
		uv: (typeof UV_VALUES)[number],
		virtualEnv: (typeof VIRTUAL_VALUES)[number],
		dotVenv: (typeof DOT_VENV_VALUES)[number],
	): PythonEnvironmentSource | undefined {
		if (isProjectRoot(position) && uv !== "U-unset")
			return "uv-project-environment";
		if (isWorkspaceMember(position)) return "uv-workspace";
		if (virtualEnv === "V-set") return "virtual-env";
		if (dotVenv === "D-present") return "project-dot-venv";
		return undefined;
	}

	interface Cell {
		root: string;
		workspaceRoot: string | undefined;
		/** Where I3 says a relative UV_PROJECT_ENVIRONMENT resolves, if at all. */
		uvAnchor: string | undefined;
		/**
		 * Where a resolver that violated I1/I2 would anchor instead. Populated
		 * for A2 so the U-rel cells are discriminating: without a decoy at the
		 * ancestor project root, "no environment there" masks "should not have
		 * looked there" (review round 3, S1).
		 */
		decoyAnchor?: string;
	}

	/**
	 * Materialize one cell on disk. The workspace `.venv` exists for every
	 * explicit-workspace shape (A3/A4) so that "did the resolver offer the
	 * uv-workspace candidate" is observable rather than masked by a missing
	 * directory; for A6 the workspace root's `.venv` IS `<root>/.venv` and so
	 * follows the D axis.
	 */
	function buildCell(base: string, position: Position): Cell {
		const write = (file: string, body: string): void => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body);
		};
		const workspaceToml = (exclude: boolean): string =>
			`[tool.uv.workspace]\nmembers = ['packages/*']\n${
				exclude ? "exclude = ['packages/member']\n" : ""
			}`;
		switch (position) {
			case "A1": {
				const root = path.join(base, "proj");
				write(path.join(root, "pyproject.toml"), "[project]\nname='p'\n");
				return { root, workspaceRoot: undefined, uvAnchor: root };
			}
			case "A2": {
				const project = path.join(base, "proj");
				write(path.join(project, "pyproject.toml"), "[project]\nname='p'\n");
				createEnvironment(path.join(project, ".venv"));
				const root = path.join(project, "frontend");
				fs.mkdirSync(root, { recursive: true });
				return {
					root,
					workspaceRoot: undefined,
					uvAnchor: undefined,
					decoyAnchor: project,
				};
			}
			case "A3":
			case "A4": {
				const workspaceRoot = path.join(base, "ws");
				write(
					path.join(workspaceRoot, "pyproject.toml"),
					workspaceToml(position === "A4"),
				);
				createEnvironment(path.join(workspaceRoot, ".venv"));
				const root = path.join(workspaceRoot, "packages", "member");
				write(path.join(root, "pyproject.toml"), "[project]\nname='m'\n");
				return {
					root,
					workspaceRoot,
					uvAnchor: position === "A3" ? workspaceRoot : root,
				};
			}
			case "A5": {
				const root = path.join(base, "plain");
				fs.mkdirSync(root, { recursive: true });
				return { root, workspaceRoot: undefined, uvAnchor: undefined };
			}
			case "A6": {
				const root = path.join(base, "ws");
				write(path.join(root, "pyproject.toml"), workspaceToml(false));
				return { root, workspaceRoot: root, uvAnchor: root };
			}
		}
	}

	for (const [position, label] of POSITIONS)
		for (const uv of UV_VALUES)
			for (const virtualEnv of VIRTUAL_VALUES)
				for (const dotVenv of DOT_VENV_VALUES) {
					const cell = `${position} ${uv} ${virtualEnv} ${dotVenv}`;
					const expected = expectedSource(position, uv, virtualEnv, dotVenv);
					it(`${cell} -> ${expected ?? "undefined"} (${label})`, async () => {
						const base = createTempDir("pi-lens-uv-cell-");
						const { root, uvAnchor, decoyAnchor } = buildCell(base, position);
						if (dotVenv === "D-present")
							createEnvironment(path.join(root, ".venv"));

						let uvRoot: string | undefined;
						if (uv === "U-abs") {
							uvRoot = createEnvironment(
								path.join(base, "absolute-uv-env"),
							).root;
							process.env.UV_PROJECT_ENVIRONMENT = uvRoot;
						} else if (uv === "U-rel") {
							// Materialized ONLY at the contract's anchor (I3).
							uvRoot = uvAnchor
								? createEnvironment(path.join(uvAnchor, ".uv-env")).root
								: undefined;
							if (decoyAnchor)
								createEnvironment(path.join(decoyAnchor, ".uv-env"));
							process.env.UV_PROJECT_ENVIRONMENT = ".uv-env";
						}
						let activated: string | undefined;
						if (virtualEnv === "V-set") {
							activated = createEnvironment(path.join(base, "activated")).root;
							process.env.VIRTUAL_ENV = activated;
						}

						const environment = await detectPythonEnvironment(
							root,
							os.tmpdir(),
						);

						expect(environment?.source).toBe(expected);
						if (expected === "uv-project-environment")
							expect(environment?.root).toBe(uvRoot);
						if (expected === "virtual-env")
							expect(environment?.root).toBe(activated);
						if (expected === "project-dot-venv")
							expect(environment?.root).toBe(path.join(root, ".venv"));
					});
				}
});
