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

import { join, win32 } from "node:path";

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

/** An ambient source: the key of {@link AMBIENT_ENVIRONMENT_VARIABLES}. */
export type AmbientPythonSource = keyof typeof AMBIENT_ENVIRONMENT_VARIABLES;

/** The MSYS2 toolchain variants conda's Windows activation probes for. */
const CONDA_MSYS2_VARIANTS = ["ucrt64", "clang64", "mingw64", "clangarm64"];

/**
 * Every directory activating the environment rooted at `root` puts on PATH:
 * what a shell that has it active carries beyond its own PATH. A venv or uv
 * environment adds its {@link pythonEnvironmentBinDir}. conda on Windows adds
 * the prefix itself and its `Library` tool directories too, as conda's own
 * activator does (`_Activator._get_path_dirs`, conda/activate.py): it adds
 * the one MSYS2 variant directory that exists, so every variant is listed
 * here and an absent one matches nothing.
 */
export function pythonEnvironmentActivationDirs(
	root: string,
	source: AmbientPythonSource,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (platform !== "win32") return [pythonEnvironmentBinDir(root, platform)];
	// A Windows root is joined with Windows separators whatever the host, so
	// the activation set matches a Windows PATH entry on a POSIX test host;
	// `pythonEnvironmentBinDir` keeps its host join, the detector's contract.
	if (source !== "conda") return [win32.join(root, "Scripts")];
	const library = (...parts: string[]) => win32.join(root, "Library", ...parts);
	return [
		root,
		...CONDA_MSYS2_VARIANTS.map((variant) => library(variant, "bin")),
		library("mingw-w64", "bin"),
		library("usr", "bin"),
		library("bin"),
		win32.join(root, "Scripts"),
		win32.join(root, "bin"),
	];
}
