/**
 * The ambient channels through which a shell names an active Python
 * environment: an exported VIRTUAL_ENV, CONDA_PREFIX or UV_PROJECT_ENVIRONMENT.
 * `detectPythonEnvironment` (`python-environment.ts`) resolves the interpreter
 * and tool directory from them.
 *
 * A leaf module that imports only Node built-ins, on purpose: the test harness
 * (`tests/support/vitest-setup.ts`) scrubs this set from every worker before
 * any test runs, and loading `python-environment.ts` there would load the
 * latency and extension loggers, which fix their sink paths from the home the
 * worker has at that moment, before a case's own home pin.
 */

import { join } from "node:path";

/** Each ambient source and the variable that carries it. */
export const AMBIENT_ENVIRONMENT_VARIABLES = {
	"uv-project-environment": "UV_PROJECT_ENVIRONMENT",
	"virtual-env": "VIRTUAL_ENV",
	conda: "CONDA_PREFIX",
} as const;

/** The variable names {@link hasAmbientPythonEnvironment} reads. */
export const AMBIENT_PYTHON_ENVIRONMENT_VARIABLES: readonly string[] =
	Object.values(AMBIENT_ENVIRONMENT_VARIABLES);

/** True when any ambient Python environment channel is set in `env`. */
export function hasAmbientPythonEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return AMBIENT_PYTHON_ENVIRONMENT_VARIABLES.some((name) =>
		Boolean(env[name]),
	);
}

/**
 * The directory an environment rooted at `root` keeps its interpreter and
 * tools in: `Scripts` on Windows, `bin` elsewhere. Activating the environment
 * puts this directory on PATH.
 */
export function pythonEnvironmentBinDir(
	root: string,
	platform: NodeJS.Platform = process.platform,
): string {
	return join(root, platform === "win32" ? "Scripts" : "bin");
}
