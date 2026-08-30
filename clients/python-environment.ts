import { access } from "node:fs/promises";
import path from "node:path";

export type PythonEnvironmentSource =
	| "virtual-env"
	| "conda"
	| "project-dot-venv"
	| "project-venv";

export interface PythonEnvironment {
	root: string;
	binDir: string;
	pythonPath: string;
	source: PythonEnvironmentSource;
}

/**
 * Resolve the interpreter and executable directory for the project's Python
 * environment without activating it or invoking a package manager.
 */
export async function detectPythonEnvironment(
	projectRoot: string,
): Promise<PythonEnvironment | undefined> {
	const candidates: Array<{
		root: string | undefined;
		source: PythonEnvironmentSource;
	}> = [
		{ root: process.env.VIRTUAL_ENV, source: "virtual-env" },
		{ root: process.env.CONDA_PREFIX, source: "conda" },
		{ root: path.join(projectRoot, ".venv"), source: "project-dot-venv" },
		{ root: path.join(projectRoot, "venv"), source: "project-venv" },
	];

	for (const candidate of candidates) {
		if (!candidate.root) continue;
		const binDir = path.join(
			candidate.root,
			process.platform === "win32" ? "Scripts" : "bin",
		);
		const pythonPath = path.join(
			binDir,
			process.platform === "win32" ? "python.exe" : "python",
		);
		try {
			await access(pythonPath);
			return {
				root: candidate.root,
				binDir,
				pythonPath,
				source: candidate.source,
			};
		} catch {
			// The marker can outlive its environment. Continue to the next candidate.
		}
	}

	return undefined;
}

/** Preserve the existing interpreter-only API used by LSP initialization. */
export async function detectPythonVenv(
	projectRoot: string,
): Promise<string | undefined> {
	return (await detectPythonEnvironment(projectRoot))?.pythonPath;
}

/**
 * Build a child-only environment for Python tools. The host process remains
 * unchanged, so another project can resolve a different environment.
 */
export function augmentPythonEnvironment(
	baseEnvironment: NodeJS.ProcessEnv,
	environment: PythonEnvironment | undefined,
): NodeJS.ProcessEnv {
	if (!environment) return baseEnvironment;

	const inheritedPath =
		baseEnvironment.PATH ?? baseEnvironment.Path ?? baseEnvironment.path ?? "";
	const augmentedPath = inheritedPath
		? `${environment.binDir}${path.delimiter}${inheritedPath}`
		: environment.binDir;
	const childEnvironment: NodeJS.ProcessEnv = {
		...baseEnvironment,
		PATH: augmentedPath,
		VIRTUAL_ENV: environment.root,
	};
	if (process.platform === "win32") childEnvironment.Path = augmentedPath;
	return childEnvironment;
}

/** Return explicit project-environment candidates before a bare PATH fallback. */
export function pythonEnvironmentToolCandidates(
	environment: PythonEnvironment | undefined,
	command: string,
): string[] {
	if (!environment) return [];
	if (process.platform !== "win32") {
		return [path.join(environment.binDir, command)];
	}
	return [
		path.join(environment.binDir, `${command}.exe`),
		path.join(environment.binDir, `${command}.cmd`),
		path.join(environment.binDir, command),
	];
}
