/**
 * No test worker inherits the developer shell's active Python environment.
 *
 * `detectPythonEnvironment` resolves the interpreter and tool directory from
 * an exported VIRTUAL_ENV, CONDA_PREFIX or UV_PROJECT_ENVIRONMENT. A shell with
 * a global venv active (VIRTUAL_ENV=~/.venv) handed every worker that venv's
 * pyright, and `adopted-root-runners.test.ts` read a pyright finding on a file
 * whose premise is that nothing checks it. `tests/support/vitest-setup.ts`
 * scrubs the owner's own list (`AMBIENT_PYTHON_ENVIRONMENT_VARIABLES`) once per
 * worker.
 *
 * On a host whose shell exports none of them (CI) the worker witness holds
 * either way; it reds on a developer box with a venv active when the scrub is
 * removed. The owner case below keeps the scrubbed list tied to the channels
 * the owner actually reads.
 */

import { describe, expect, it } from "vitest";
import {
	AMBIENT_PYTHON_ENVIRONMENT_VARIABLES,
	hasAmbientPythonEnvironment,
} from "../../clients/python-ambient-environment.js";
import { pathWithoutActivePythonEnvironments } from "../support/ambient-python-scrub.js";

describe("ambient Python environment scrub", () => {
	it("leaves no ambient Python environment channel in the worker", () => {
		const leaked = AMBIENT_PYTHON_ENVIRONMENT_VARIABLES.filter(
			(name) => process.env[name] !== undefined,
		);
		expect(leaked).toEqual([]);
		expect(hasAmbientPythonEnvironment()).toBe(false);
	});

	it("scrubs every channel the owner reads, VIRTUAL_ENV included", () => {
		expect(hasAmbientPythonEnvironment({ VIRTUAL_ENV: "/venv" })).toBe(true);
		for (const name of AMBIENT_PYTHON_ENVIRONMENT_VARIABLES) {
			expect(hasAmbientPythonEnvironment({ [name]: "/env" }), name).toBe(true);
		}
		expect(AMBIENT_PYTHON_ENVIRONMENT_VARIABLES).toContain("VIRTUAL_ENV");
	});
});

describe("PATH without the active Python environments (#5713 review r1)", () => {
	it("drops a POSIX venv's bin and keeps every other entry in order", () => {
		expect(
			pathWithoutActivePythonEnvironments(
				{
					VIRTUAL_ENV: "/home/u/.venv",
					PATH: "/home/u/.venv/bin::/usr/bin:/bin",
				},
				"linux",
			),
		).toBe(":/usr/bin:/bin");
	});

	it("leaves PATH alone when no channel is set", () => {
		expect(
			pathWithoutActivePythonEnvironments({ PATH: "/usr/bin" }, "linux"),
		).toBeUndefined();
	});

	it("matches a Windows venv's Scripts whatever its case", () => {
		expect(
			pathWithoutActivePythonEnvironments(
				{
					VIRTUAL_ENV: "C:\\Envs\\dev",
					PATH: "c:\\envs\\dev\\Scripts;C:\\Windows\\system32",
				},
				"win32",
			),
		).toBe("C:\\Windows\\system32");
	});

	it("drops every directory Windows conda activation adds", () => {
		// conda/activate.py `_Activator._get_path_dirs` (conda 25.7.0) on Windows:
		// the prefix, one Library\\<msys2 variant>\\bin, Library\\mingw-w64\\bin,
		// Library\\usr\\bin, Library\\bin, Scripts and bin.
		const prefix = "C:\\envs\\dev";
		const activated = [
			prefix,
			`${prefix}\\Library\\ucrt64\\bin`,
			`${prefix}\\Library\\mingw-w64\\bin`,
			`${prefix}\\Library\\usr\\bin`,
			`${prefix}\\Library\\bin`,
			`${prefix}\\Scripts`,
			`${prefix}\\bin`,
		];
		const kept = ["C:\\Windows\\system32", "C:\\envs\\other\\Scripts"];
		expect(
			pathWithoutActivePythonEnvironments(
				{ CONDA_PREFIX: prefix, PATH: [...activated, ...kept].join(";") },
				"win32",
			),
		).toBe(kept.join(";"));
	});
});
