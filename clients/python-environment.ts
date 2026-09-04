import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAtOrAboveHomeDir, walkUpDirs } from "./path-utils.js";

export type PythonEnvironmentSource =
	| "virtual-env"
	| "conda"
	| "project-dot-venv"
	| "project-venv"
	| "uv-project-environment"
	| "uv-workspace";

export interface PythonEnvironment {
	root: string;
	binDir: string;
	pythonPath: string;
	source: PythonEnvironmentSource;
}

interface UvWorkspace {
	root: string;
	explicit: boolean;
	startIsProject: boolean;
}

/**
 * Resolve the uv workspace root using the same discovery shape as uv:
 * start at the nearest pyproject, then continue upward for an explicit
 * `[tool.uv.workspace]` declaration. A nearest pyproject without that table
 * is an implicit single-project workspace. The walk is bounded and stops at
 * HOME so an unrelated ancestor cannot supply the environment.
 */
async function findUvWorkspace(
	startDir: string,
): Promise<UvWorkspace | undefined> {
	const resolvedStart = path.resolve(startDir);
	let nearestProject: string | undefined;
	let depth = 0;
	for (const dir of walkUpDirs(startDir)) {
		if (depth++ >= 64 || isAtOrAboveHomeDir(dir, os.homedir())) break;

		let content: string;
		try {
			content = await readFile(path.join(dir, "pyproject.toml"), "utf8");
		} catch {
			continue;
		}

		if (!nearestProject) nearestProject = dir;
		if (hasUvWorkspaceTable(content)) {
			return {
				root: dir,
				explicit: true,
				startIsProject: dir === resolvedStart,
			};
		}
	}

	return nearestProject
		? {
				root: nearestProject,
				explicit: false,
				startIsProject: nearestProject === resolvedStart,
			}
		: undefined;
}

/** Match only the top-level uv workspace table, not a commented heading. */
function hasUvWorkspaceTable(content: string): boolean {
	return content
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.split("\n")
		.some((line) => /^\s*\[tool\.uv\.workspace\]\s*(?:#.*)?$/.test(line));
}

/**
 * Resolve the interpreter and executable directory for the project's Python
 * environment without activating it or invoking a package manager.
 */
export async function detectPythonEnvironment(
	projectRoot: string,
): Promise<PythonEnvironment | undefined> {
	const uvWorkspace = await findUvWorkspace(projectRoot);
	const workspaceRoot = uvWorkspace?.root ?? path.resolve(projectRoot);
	const uvProjectEnvironment = process.env.UV_PROJECT_ENVIRONMENT;
	// PEP 723 `uv run --script` environments are cache-keyed by script content;
	// without a stable project marker or explicit path, they remain undiscoverable.
	const candidates: Array<{
		root: string | undefined;
		source: PythonEnvironmentSource;
	}> = [
		{
			root: uvProjectEnvironment
				? path.isAbsolute(uvProjectEnvironment)
					? uvProjectEnvironment
					: path.resolve(workspaceRoot, uvProjectEnvironment)
				: undefined,
			source: "uv-project-environment",
		},
		...(uvWorkspace?.explicit
			? [
					{
						root: path.join(workspaceRoot, ".venv"),
						source: "uv-workspace" as const,
					},
				]
			: []),
		{ root: process.env.VIRTUAL_ENV, source: "virtual-env" },
		{ root: process.env.CONDA_PREFIX, source: "conda" },
		{ root: path.join(projectRoot, ".venv"), source: "project-dot-venv" },
		{ root: path.join(projectRoot, "venv"), source: "project-venv" },
		...(uvWorkspace &&
		!uvWorkspace.explicit &&
		!uvWorkspace.startIsProject &&
		workspaceRoot !== path.resolve(projectRoot)
			? [
					{
						root: path.join(workspaceRoot, ".venv"),
						source: "project-dot-venv" as const,
					},
				]
			: []),
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
