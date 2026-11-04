/**
 * Test-runner canary rows for the nightly tool smoke (#5257).
 *
 * Every other smoke layer proves a LINTER finds a planted defect. None proved
 * that `TestRunnerClient` reports a planted FAILING TEST as failing, so vitest
 * 5's move of `--reporter=json` output into a file (every per-edit test run
 * read as passing and cleared the `--lens-guard` blocker) escaped nightly. A
 * row plants one failing test in a scratch project, installs the runner at its
 * LATEST version (not the repo pin: the point is to see the next major before
 * a user does), and requires the real `TestRunnerClient` to report
 * `failed > 0` with no runner error.
 *
 * A row's three outcomes mirror the other layers (`report()` in
 * `smoke-tools.mjs`): `pass`, `fail` (the runner mis-read the failing test) and
 * `skip` with a written reason when the job lacks the toolchain. An install
 * that fails with the toolchain present is `setup-failed`, which still counts
 * toward the exit code, so a registry outage cannot read as green.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Whether `bin` resolves on PATH (`--version` exits 0). */
export function hasBinary(bin, args = ["--version"]) {
	const r = spawnSync(bin, args, { encoding: "utf8", timeout: 20_000 });
	return !r.error && r.status === 0;
}

function write(root, rel, content) {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

/** `npm install <pkg>@latest` into `root`; returns an error string or null. */
function npmInstall(root, pkg) {
	const r = spawnSync(
		"npm",
		["install", "--no-audit", "--no-fund", "--no-save", `${pkg}@latest`],
		{ cwd: root, encoding: "utf8", timeout: 240_000 },
	);
	if (r.error || r.status !== 0) {
		return `npm install ${pkg}@latest failed: ${(r.error?.message ?? r.stderr ?? "").trim().slice(0, 300)}`;
	}
	return null;
}

/**
 * @typedef {{state: "skip", reason: string} | {state: "setup-failed", reason: string} | {state: "ready", testFile: string, version?: string}} Provisioned
 * @type {ReadonlyArray<{id: string, runner: string, provision: (root: string) => Provisioned}>}
 */
export const TEST_RUNNER_ROWS = [
	{
		id: "vitest-latest",
		runner: "vitest",
		provision(root) {
			write(
				root,
				"package.json",
				'{"name":"canary-vitest","private":true,"type":"module"}\n',
			);
			write(root, "vitest.config.mjs", "export default {};\n");
			const testFile = write(
				root,
				"src/a.test.js",
				"import { it, expect } from 'vitest';\nit('planted failure', () => { expect(1).toBe(2); });\n",
			);
			const err = npmInstall(root, "vitest");
			return err
				? { state: "setup-failed", reason: err }
				: {
						state: "ready",
						testFile,
						version: installedVersion(root, "vitest"),
					};
		},
	},
	{
		id: "jest-latest",
		runner: "jest",
		provision(root) {
			write(root, "package.json", '{"name":"canary-jest","private":true}\n');
			write(root, "jest.config.js", "module.exports = {};\n");
			const testFile = write(
				root,
				"src/a.test.js",
				"test('planted failure', () => { expect(1).toBe(2); });\n",
			);
			const err = npmInstall(root, "jest");
			return err
				? { state: "setup-failed", reason: err }
				: { state: "ready", testFile, version: installedVersion(root, "jest") };
		},
	},
	{
		id: "pytest-latest",
		runner: "pytest",
		provision(root) {
			if (!hasBinary("python3")) {
				return { state: "skip", reason: "python3 is not on the job's PATH" };
			}
			write(root, "pytest.ini", "[pytest]\n");
			const testFile = write(
				root,
				"test_a.py",
				"def test_planted_failure():\n    assert 1 == 2\n",
			);
			const venv = spawnSync("python3", ["-m", "venv", ".venv"], {
				cwd: root,
				encoding: "utf8",
				timeout: 120_000,
			});
			if (venv.error || venv.status !== 0) {
				return {
					state: "skip",
					reason: `python3 -m venv is unavailable (${`${venv.stdout ?? ""}${venv.stderr ?? ""}${venv.error?.message ?? ""}`.trim().replace(/\s+/g, " ").slice(0, 160)})`,
				};
			}
			const pip = spawnSync(
				path.join(root, ".venv", "bin", "python"),
				[
					"-m",
					"pip",
					"install",
					"--quiet",
					"--disable-pip-version-check",
					"pytest",
				],
				{ cwd: root, encoding: "utf8", timeout: 240_000 },
			);
			return pip.error || pip.status !== 0
				? {
						state: "setup-failed",
						reason: `pip install pytest failed: ${(pip.stderr ?? pip.error?.message ?? "").trim().slice(0, 300)}`,
					}
				: { state: "ready", testFile };
		},
	},
	{
		id: "go-test",
		runner: "go",
		provision(root) {
			if (!hasBinary("go", ["version"])) {
				return {
					state: "skip",
					reason: "the go toolchain is not on the job's PATH",
				};
			}
			write(root, "go.mod", "module canary\n\ngo 1.21\n");
			const testFile = write(
				root,
				"a_test.go",
				'package canary\n\nimport "testing"\n\nfunc TestPlantedFailure(t *testing.T) {\n\tt.Fatal("planted")\n}\n',
			);
			return { state: "ready", testFile };
		},
	},
];

function installedVersion(root, pkg) {
	try {
		return JSON.parse(
			fs.readFileSync(
				path.join(root, "node_modules", pkg, "package.json"),
				"utf8",
			),
		).version;
	} catch {
		return undefined;
	}
}

/**
 * The verdict for one TestRunnerClient result over the planted failing test:
 * the run must COUNT a failure and report no runner error. Anything else is
 * the #5257 shape (the failing test read as clean or as an unreadable run).
 */
export function classifyPlantedFailure(result) {
	if (result.failed > 0 && !result.error) {
		return {
			state: "pass",
			diags: result.failed,
			detail: `reported ${result.failed} failing test(s) (passed=${result.passed})`,
		};
	}
	return {
		state: "fail",
		diags: result.failed ?? 0,
		detail: `planted failing test NOT reported as failing: passed=${result.passed} failed=${result.failed} skipped=${result.skipped}${result.error ? ` error="${result.error}"` : ""}`,
	};
}

/**
 * Drive one row through the real client.
 * @param {typeof TEST_RUNNER_ROWS[number]} rowDef
 * @param {{ root: string, client: any }} deps  `root` is a fresh scratch dir for this row
 */
export async function evaluateTestRunnerRow(rowDef, { root, client }) {
	const lang = "test-runner";
	const prov = rowDef.provision(root);
	if (prov.state === "skip") {
		return {
			state: "skip",
			lang,
			runner: rowDef.id,
			diags: 0,
			detail: prov.reason,
		};
	}
	if (prov.state === "setup-failed") {
		return {
			state: "setup-failed",
			lang,
			runner: rowDef.id,
			diags: 0,
			detail: prov.reason,
		};
	}
	const detected = client.detectRunner(root, prov.testFile);
	if (detected?.runner !== rowDef.runner) {
		return {
			state: "fail",
			lang,
			runner: rowDef.id,
			diags: 0,
			detail: `detectRunner picked ${detected?.runner ?? "nothing"}, expected ${rowDef.runner}`,
		};
	}
	const result = await client.runTestFileAsync(prov.testFile, root, {
		runner: detected.runner,
		config: detected.config,
	});
	const verdict = classifyPlantedFailure(result);
	return {
		...verdict,
		lang,
		runner: rowDef.id,
		detail: `${verdict.detail}${prov.version ? ` [${rowDef.runner} ${prov.version}]` : ""}`,
	};
}
