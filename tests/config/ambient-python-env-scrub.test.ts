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
