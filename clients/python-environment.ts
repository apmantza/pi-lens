import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	extractTomlTableSection,
	hasTomlTable,
	parseTomlStringArray,
} from "./cargo-manifest.js";
import {
	isAtOrAboveHomeDir,
	matchesWorkspaceMemberPattern,
	toPosix,
	UV_WORKSPACE_EXCLUDE_DIALECT,
	UV_WORKSPACE_MEMBERS_DIALECT,
	walkUpDirs,
	type WorkspaceMemberGlobDialect,
} from "./path-utils.js";

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
	/** The workspace root — the project itself unless an ancestor declares one. */
	root: string;
	/** True when {@link root} declares `[tool.uv.workspace]`. */
	explicit: boolean;
	/** The nearest ancestor (inclusive) holding a `pyproject.toml`. */
	projectRoot: string;
	/**
	 * True when {@link projectRoot} IS the directory the walk started from —
	 * i.e. the caller's root is itself a uv project, not merely a directory
	 * somewhere beneath one. This is the whole gate for "does this directory
	 * get uv's project settings": the walk answers "which project OWNS this
	 * directory", which is a different question and only decides membership
	 * (review round 3, S1).
	 */
	isStartDir: boolean;
	members: string[];
	exclude: string[];
}

const UV_WORKSPACE_TABLE = "tool\\.uv\\.workspace";

/**
 * Resolve the uv workspace root using the same discovery shape as uv:
 * start at the nearest pyproject, then continue upward for an explicit
 * `[tool.uv.workspace]` declaration. A nearest pyproject without that table
 * is an implicit single-project workspace.
 *
 * The walk stops AT `homeDir` (`isAtOrAboveHomeDir`, the shared ceiling
 * primitive from #625) so a `pyproject.toml` sitting in `/tmp`, `/home`, or
 * `$HOME` itself cannot supply the environment for every project beneath it.
 * `homeDir` is injected rather than read from `os.homedir()` inside the walk
 * for the same reason every sibling walker takes it (#2536, #2544 F2): the
 * ceiling is otherwise untestable.
 */
async function findUvWorkspace(
	startDir: string,
	homeDir: string,
): Promise<UvWorkspace | undefined> {
	const resolvedStart = path.resolve(startDir);
	let nearestProject: string | undefined;
	for (const dir of walkUpDirs(startDir)) {
		if (isAtOrAboveHomeDir(dir, homeDir)) break;

		let content: string;
		try {
			content = await readFile(path.join(dir, "pyproject.toml"), "utf8");
		} catch {
			continue;
		}

		if (!nearestProject) nearestProject = dir;
		if (hasTomlTable(content, UV_WORKSPACE_TABLE)) {
			const workspaceTable = extractTomlTableSection(
				content,
				UV_WORKSPACE_TABLE,
			);
			return {
				root: dir,
				explicit: true,
				projectRoot: nearestProject,
				isStartDir: nearestProject === resolvedStart,
				members: parseTomlStringArray(workspaceTable, "members"),
				exclude: parseTomlStringArray(workspaceTable, "exclude"),
			};
		}
	}

	return nearestProject
		? {
				root: nearestProject,
				explicit: false,
				projectRoot: nearestProject,
				isStartDir: nearestProject === resolvedStart,
				members: [],
				exclude: [],
			}
		: undefined;
}

/**
 * Apply uv's explicit-workspace membership rules before inheriting its root
 * environment. The workspace root is always a member; descendants must match
 * a declared member glob and must not match an exclusion glob.
 *
 * The glob dialects are pinned to uv 3c979abda4530fe9bf3d92e9bcf5c5575e3b3126,
 * `crates/uv-workspace/src/workspace.rs`, and live beside the ONE shared
 * workspace-member matcher (#2591) instead of as a minimatch options block
 * here: `UV_WORKSPACE_MEMBERS_DIALECT` for `members`
 * (`is_included_in_workspace` — `MatchOptions { require_literal_separator:
 * true, ..MatchOptions::new() }`) and `UV_WORKSPACE_EXCLUDE_DIALECT` for
 * `exclude` (`WorkspaceExclusions::matches` — `Pattern::matches_path`, i.e.
 * `MatchOptions::new()` defaults, where `require_literal_separator` is FALSE
 * and a `*` therefore crosses `/`). Both normalize the pattern first
 * (`normalize_path`, so a leading `./` is not part of the pattern) and are
 * case-SENSITIVE on every platform with no literal-leading-dot requirement.
 *
 * That `exclude` option set used to be a documented limitation rather than
 * behavior: minimatch cannot express a separator-crossing `*`, so
 * `exclude = ['packages/a*c']` did not exclude `packages/a/b/c`. A dialect
 * object can, so #2591 implements it — the one intentional answer change in
 * that fold.
 */
function isUvWorkspaceMember(
	workspace: UvWorkspace,
	projectRoot: string,
): boolean {
	// No `projectRoot === workspace.root` shortcut. uv treats the workspace
	// root as a member of its own workspace, but only in its capacity as a
	// PROJECT — and a project already gets uv's settings through `isStartDir`,
	// with its own `<root>/.venv` reached by the ordinary project candidate at
	// the very same path. Answering "member" on directory equality made every
	// non-project subdirectory of the workspace root inherit the workspace
	// `.venv`, `exclude` included, because equality was tested before the
	// walk result was consulted (review round 3, S2). The relative-path guard
	// below returns false for the root itself, which is the intended answer.
	const relative = toPosix(path.relative(workspace.root, projectRoot));
	if (
		relative.length === 0 ||
		relative === ".." ||
		relative.startsWith("../") ||
		path.isAbsolute(relative)
	) {
		return false;
	}

	const matches =
		(dialect: WorkspaceMemberGlobDialect) =>
		(pattern: string): boolean =>
			matchesWorkspaceMemberPattern(pattern, relative, dialect);
	return (
		!workspace.exclude.some(matches(UV_WORKSPACE_EXCLUDE_DIALECT)) &&
		workspace.members.some(matches(UV_WORKSPACE_MEMBERS_DIALECT))
	);
}

/**
 * Resolve the interpreter and executable directory for the project's Python
 * environment without activating it or invoking a package manager.
 */
export async function detectPythonEnvironment(
	projectRoot: string,
	homeDir: string = os.homedir(),
): Promise<PythonEnvironment | undefined> {
	// `path.resolve` once at the seam entry so `isStartDir` below compares like
	// with like: `walkUpDirs` resolves its input, a caller's argument need not
	// be normalized.
	const root = path.resolve(projectRoot);
	const uvWorkspace = await findUvWorkspace(root, homeDir);
	// `UV_PROJECT_ENVIRONMENT` and the workspace `.venv` are uv PROJECT
	// settings. uv applies them to a directory only when that directory IS the
	// project — a `pyproject.toml` merely sitting somewhere ABOVE it makes it a
	// subdirectory of a project, not a project, and nothing below a project
	// root inherits from it (the F3 decision, applied consistently). Exporting
	// `UV_PROJECT_ENVIRONMENT` process-wide is uv's own documented CI/Docker
	// recipe, so a gate on "a pyproject exists at or above root" lets one
	// image-level variable capture every subdirectory on the box that happens
	// to sit under some Python project.
	const isProjectRoot = uvWorkspace?.isStartDir === true;
	// A declared, non-excluded member of an EXPLICIT workspace is itself a
	// project root, so this is a strict refinement of `isProjectRoot`: it adds
	// the workspace `.venv` candidate and re-anchors a relative
	// `UV_PROJECT_ENVIRONMENT` at the workspace root.
	const memberWorkspaceRoot =
		isProjectRoot &&
		uvWorkspace.explicit &&
		isUvWorkspaceMember(uvWorkspace, root)
			? uvWorkspace.root
			: undefined;
	const uvEnvironmentRoot = isProjectRoot
		? (memberWorkspaceRoot ?? uvWorkspace.projectRoot)
		: undefined;
	const uvProjectEnvironment = process.env.UV_PROJECT_ENVIRONMENT;
	// PEP 723 `uv run --script` environments are cache-keyed by script content;
	// without a stable project marker or explicit path, they remain undiscoverable.
	const candidates: Array<{
		root: string | undefined;
		source: PythonEnvironmentSource;
	}> = [
		...(uvEnvironmentRoot !== undefined && uvProjectEnvironment
			? [
					{
						// `path.resolve` leaves an absolute value untouched and
						// anchors a relative one at the project's workspace root.
						root: path.resolve(uvEnvironmentRoot, uvProjectEnvironment),
						source: "uv-project-environment" as const,
					},
				]
			: []),
		...(memberWorkspaceRoot !== undefined
			? [
					{
						root: path.join(memberWorkspaceRoot, ".venv"),
						source: "uv-workspace" as const,
					},
				]
			: []),
		{ root: process.env.VIRTUAL_ENV, source: "virtual-env" },
		{ root: process.env.CONDA_PREFIX, source: "conda" },
		{ root: path.join(root, ".venv"), source: "project-dot-venv" },
		{ root: path.join(root, "venv"), source: "project-venv" },
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
