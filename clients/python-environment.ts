import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path, { dirname, join } from "node:path";
import {
	extractTomlTableSection,
	hasTomlTable,
	parseTomlScalarString,
	parseTomlStringArray,
} from "./cargo-manifest.js";
import { resolveLanguage } from "./language-registry.js";
import { parseJsonc } from "./review-graph/tsconfig-paths.js";
import {
	matchesWorkspaceMemberPattern,
	realpathOrResolve,
	relativeInside,
	UV_WORKSPACE_EXCLUDE_DIALECT,
	UV_WORKSPACE_MEMBERS_DIALECT,
	walkUpDirs,
	type WorkspaceMemberGlobDialect,
} from "./path-utils.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import {
	AMBIENT_ENVIRONMENT_VARIABLES,
	pythonEnvironmentBinDir,
} from "./python-ambient-environment.js";
import { logExtension } from "./extension-log.js";
import { getProjectTrustState } from "./project-trust.js";

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
	// `isStartDir` compares with the walk's own first directory, so the start
	// and the project it finds share the walk's axis whatever the caller
	// passes (#4847 review F5).
	let walkStart: string | undefined;
	let nearestProject: string | undefined;
	for (const dir of walkUpDirs(startDir, { homeDir })) {
		walkStart ??= dir;
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
				isStartDir: nearestProject === walkStart,
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
				isStartDir: nearestProject === walkStart,
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
	const relative = relativeInside(workspace.root, projectRoot);
	if (!relative) return false;

	const matches =
		(dialect: WorkspaceMemberGlobDialect) =>
		(pattern: string): boolean =>
			matchesWorkspaceMemberPattern(pattern, relative, dialect, () =>
				recordDegradationOnce({
					kind: "workspace-glob-cap",
					subject: String(pattern.length),
					reason: "workspace glob matcher exceeded its memo-table cell cap",
				}),
			);
	return (
		!workspace.exclude.some(matches(UV_WORKSPACE_EXCLUDE_DIALECT)) &&
		workspace.members.some(matches(UV_WORKSPACE_MEMBERS_DIALECT))
	);
}

/**
 * #3871: the process-wide channels a shell can point at any environment on the
 * machine. A linked-worktree run (`allowAmbient: false`) takes one only when
 * its root lies inside the requested project root.
 */
/** Project-config-sourced environments, refused unless the project is trusted. */
const PROJECT_SOURCED_PYTHON_SOURCES = new Set<PythonEnvironmentSource>([
	"project-dot-venv",
	"project-venv",
	"uv-workspace",
]);

/**
 * The root-level venv directories this module resolves, in the order it prefers
 * them. One list, so a reader that stamps what an install into one of them
 * writes (`clients/out-of-band-changes.ts`, #4532 gap 3) cannot disagree with
 * the detector about which names a project's environment can be.
 */
const PROJECT_VENV_DIRS: ReadonlyArray<{
	dir: string;
	source: PythonEnvironmentSource;
}> = [
	{ dir: ".venv", source: "project-dot-venv" },
	{ dir: "venv", source: "project-venv" },
];

/**
 * The root-level venv directory names `detectPythonEnvironment` resolves, for
 * the readers that stamp an install into one of them (#4532 gap 3).
 */
export const PROJECT_VENV_DIR_NAMES: ReadonlyArray<string> =
	PROJECT_VENV_DIRS.map((venv) => venv.dir);

/**
 * Resolve the interpreter and executable directory for the project's Python
 * environment without activating it or invoking a package manager.
 */
export async function detectPythonEnvironment(
	projectRoot: string,
	homeDir: string = os.homedir(),
	options: { allowAmbient?: boolean } = {},
): Promise<PythonEnvironment | undefined> {
	// The path identity once at the seam entry so `isStartDir` below compares
	// like with like: `walkUpDirs` climbs its input's identity (#4689 item 6),
	// and the member and containment checks below read the same axis.
	const root = realpathOrResolve(projectRoot);
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
	const allowAmbient = options.allowAmbient ?? true;
	const isWithinProjectRoot = (candidateRoot: string): boolean => {
		// Both sides are identities (#4847 review F1): an ambient root spelled
		// through a link to the project is inside it.
		// #3871 V1: another Windows drive has no relative path; the seam reads
		// the absolute `path.relative` result as outside.
		return relativeInside(root, realpathOrResolve(candidateRoot)) !== undefined;
	};
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
		...PROJECT_VENV_DIRS.map((venv) => ({
			root: path.join(root, venv.dir),
			source: venv.source,
		})),
	];

	for (const candidate of candidates) {
		if (!candidate.root) continue;
		if (
			!allowAmbient &&
			candidate.source in AMBIENT_ENVIRONMENT_VARIABLES &&
			!isWithinProjectRoot(candidate.root)
		)
			continue;
		// A project-sourced interpreter (`.venv`, a uv workspace venv) is a
		// project-local executable and carries the same trust gate as every other
		// one (#4268 acceptance 1, MED-6): unknown/untrusted falls through to a
		// global interpreter, while an explicitly exported `VIRTUAL_ENV`,
		// `CONDA_PREFIX` or `UV_PROJECT_ENVIRONMENT` remains the user's own
		// choice. Explicit untrusted always refuses.
		if (
			PROJECT_SOURCED_PYTHON_SOURCES.has(candidate.source) &&
			getProjectTrustState() !== "trusted"
		) {
			if (
				recordDegradationOnce({
					kind: "trust-refusal",
					subject: `python-environment:${candidate.root}`,
					reason: `project Python environment refused: pi project trust is ${getProjectTrustState()}`,
				})
			) {
				logExtension({
					subsystem: "project-trust",
					level: "warn",
					message:
						"project Python environment refused: mark the project trusted in pi or upgrade pi",
					metadata: { source: candidate.source },
				});
			}
			continue;
		}
		const binDir = pythonEnvironmentBinDir(candidate.root);
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

/**
 * #4638: where a project declared its Python syntax level, named by the source
 * so a degradation record can say which declaration it overrode.
 */
export type PythonTargetVersionSource =
	| "ruff-target-version"
	| "pyright-python-version"
	| "requires-python"
	| "python-version-file";

export interface PythonTargetVersion {
	major: number;
	minor: number;
	source: PythonTargetVersionSource;
	/** Absolute path of the file that declared it. */
	file: string;
}

/**
 * #4638 review (F10): how many declaration walks run at once. Each walk is a few
 * small config reads on local disk, so eight keeps a sweep's worth in flight
 * without opening a handle for every file. The snapshot and the full-mode sweep
 * both ask this owner for the bound instead of each picking one.
 */
export const PYTHON_DECLARATION_CONCURRENCY = 8;

/** The LSP server whose `compile` verdict a project declaration outranks. */
export const PYTHON_COMPILE_VERDICT_SERVER_ID = "python-jedi";

/** First declared level at which jedi's own `compile` verdict is outranked. */
const PYTHON_COMPILE_VERDICT_FLOOR = { major: 3, minor: 14 } as const;

/**
 * jedi compiles a file with the interpreter it launched. Under a declared level
 * at or above the floor its `compile` row describes a grammar the project does
 * not use (PEP 758's unparenthesized `except` is the common case), so the row is
 * not evidence about this project. Every other server, source, and level keeps
 * its verdict, and no declaration keeps every verdict.
 */
/**
 * The fields a row can carry the verdict's identity in. Dispatch diagnostics use
 * `serverId`/`source`; the widget and summary rows that `mode=full` merges keep
 * `tool`/`rule` instead. One rule, both spellings, checked in one place.
 */
export interface PythonVerdictRow {
	serverId?: string;
	source?: string;
	tool?: string;
	rule?: string;
}

/**
 * Whether this row IS jedi's own `compile` verdict — the half of the rule the
 * floor does not need, so a consumer can skip work for files that carry none
 * (the navigation snapshot's declaration walk, #4638 review F10).
 */
export function isJediCompileVerdict(diagnostic: PythonVerdictRow): boolean {
	const server = diagnostic.serverId ?? diagnostic.tool;
	const source = diagnostic.source ?? diagnostic.rule?.split(":")[0];
	return server === PYTHON_COMPILE_VERDICT_SERVER_ID && source === "compile";
}

export function isJediCompileVerdictOutranked(
	diagnostic: PythonVerdictRow,
	declared: PythonTargetVersion | undefined,
): boolean {
	if (declared === undefined) return false;
	if (!isJediCompileVerdict(diagnostic)) return false;
	return (
		declared.major > PYTHON_COMPILE_VERDICT_FLOOR.major ||
		(declared.major === PYTHON_COMPILE_VERDICT_FLOOR.major &&
			declared.minor >= PYTHON_COMPILE_VERDICT_FLOOR.minor)
	);
}

export interface PythonCompileVerdictPartition<T> {
	kept: T[];
	dropped: number;
}

/**
 * The one place a declaration's authority over a server answer is applied. The
 * probe seam and the post-write runner both call this with the declaration they
 * resolved, so the probe, its cache replay, `lsp_navigation`, and the
 * post-write delivery drop exactly the same rows and agree on the count
 * (#4638 review, one rule for every consumer).
 */
export function partitionOutrankedPythonCompileVerdicts<
	T extends PythonVerdictRow,
>(
	diagnostics: readonly T[],
	declared: PythonTargetVersion | undefined,
): PythonCompileVerdictPartition<T> {
	const kept: T[] = [];
	let dropped = 0;
	for (const diagnostic of diagnostics) {
		if (isJediCompileVerdictOutranked(diagnostic, declared)) dropped += 1;
		else kept.push(diagnostic);
	}
	return { kept, dropped };
}

/**
 * The bounded record every consumer writes when it drops rows: once per file,
 * naming the declared level, the file that declared it, and the count. `""` is
 * never passed as a subject, so a drop from `lsp_navigation` and one from the
 * probe for the same file share one record.
 */
export function recordPythonCompileVerdictDrop(
	file: string,
	declared: PythonTargetVersion,
	dropped: number,
): void {
	recordDegradationOnce({
		kind: "python-compile-target-mismatch",
		subject: file,
		reason: `${dropped} jedi compile ${dropped === 1 ? "finding" : "findings"} dropped: declared Python ${declared.major}.${declared.minor} (${declared.source}) in ${declared.file}`,
		metadata: {
			declared: `${declared.major}.${declared.minor}`,
			source: declared.source,
			declarationFile: declared.file,
			dropped,
		},
	});
}

/**
 * The one model-facing sentence for rows the declaration withheld: the post-write
 * runner, every probe render, `mode=full` and `lsp_navigation` say it the same
 * way, so a dropped row is never visible only in the ledger (AGENTS.md shape 10).
 */
export function describePythonCompileWithheld(
	count: number,
	declared: PythonTargetVersion,
): string {
	return `${count} python-jedi compile finding${count === 1 ? "" : "s"} withheld: the project declares Python ${declared.major}.${declared.minor} (${declared.source}) in ${declared.file}`;
}

interface DeclaredPythonVersion {
	major: number;
	minor: number;
}

/** `<major>.<minor>` at the start of a version-ish text, with an optional `v`. */
const BARE_VERSION_PREFIX = /^v?(\d+)\.(\d+)/i;
/**
 * Everything after that prefix: a patch, a pre-release tag, or a pyenv-style
 * suffix (`3.10-pypy`). Measured separately so the whole reduction stays linear
 * instead of backtracking over one ambiguous pattern.
 */
const VERSION_SUFFIX = /^[-+._a-z0-9]*$/i;
/** A PEP 440 clause that carries an inclusive lower bound. */
const SPECIFIER_LOWER_BOUND = /^(?:>=|==|~=)\s*v?(\d+)\.(\d+)/;
/** Ruff's spelling of a syntax level (`py312`). */
const RUFF_LEVEL = /^py(\d)(\d+)$/i;

function reducePythonVersion(
	match: RegExpExecArray | null,
): DeclaredPythonVersion | undefined {
	if (!match) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * Reduce one version-ish text to its major/minor. Anything that does not BEGIN
 * with `<major>.<minor>` names no CPython syntax level: `pypy-3.10`, a branch
 * name in `.python-version`, or a bare major `3` with no minor. A patch or
 * trailing suffix (`3.14.2`, `3.10-pypy`) is not part of the syntax level.
 */
function reduceBarePythonVersion(
	text: string,
): DeclaredPythonVersion | undefined {
	const trimmed = text.trim();
	const prefix = BARE_VERSION_PREFIX.exec(trimmed);
	if (!prefix) return undefined;
	if (!VERSION_SUFFIX.test(trimmed.slice(prefix[0].length))) return undefined;
	return reducePythonVersion(prefix);
}

/**
 * Reduce a PEP 440 specifier to its lower bound (`>=3.12`, `>=3.12,<4`,
 * `==3.14.*`, `~=3.11`). A clause with no inclusive lower bound (`<4`, `>3.12`,
 * `!=3.12`, `===3.12`) yields nothing rather than a guess, so a specifier made
 * only of those is absent.
 */
function reducePythonSpecifier(
	text: string,
): DeclaredPythonVersion | undefined {
	// Every recognised clause can carry a lower bound, and a specifier's floor is
	// its STRONGEST one: `>=3.12,>=3.14` and `>=3.14,>=3.12` both mean 3.14, so
	// the answer cannot depend on clause order (#4638 review).
	let strongest: DeclaredPythonVersion | undefined;
	for (const clause of text.split(",")) {
		const lowerBound = reducePythonVersion(
			SPECIFIER_LOWER_BOUND.exec(clause.trim()),
		);
		if (!lowerBound) continue;
		if (
			!strongest ||
			lowerBound.major > strongest.major ||
			(lowerBound.major === strongest.major &&
				lowerBound.minor > strongest.minor)
		) {
			strongest = lowerBound;
		}
	}
	return strongest ?? reduceBarePythonVersion(text);
}

/** `py312` -> 3.12. Ruff names the level this way and never as a bare version. */
function reduceRuffTargetVersion(
	text: string,
): DeclaredPythonVersion | undefined {
	return reducePythonVersion(RUFF_LEVEL.exec(text.trim()));
}

function withSource(
	level: DeclaredPythonVersion | undefined,
	source: PythonTargetVersionSource,
	file: string,
): PythonTargetVersion | undefined {
	return level ? { ...level, source, file } : undefined;
}

/**
 * Read a declaration file. A missing file declares nothing, which is what the
 * walk is for; any other read failure is recorded once and also declares
 * nothing, so a probe never throws over an unreadable manifest.
 */
async function readDeclarationFile(
	filePath: string,
): Promise<string | undefined> {
	try {
		return await readFile(filePath, "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			// none: a manifest that is not there declares nothing, and the walk exists
			// to keep looking; every other failure is recorded just below.
			return undefined;
		}
		recordDegradationOnce({
			kind: "python-target-version-unreadable",
			subject: filePath,
			reason: `Python syntax-level declaration could not be read: ${err instanceof Error ? err.message : String(err)}`,
		});
		return undefined;
	}
}

/**
 * pyright's `pythonVersion`, from its own JSON config, decoded through the
 * review graph's `parseJsonc` — the one JSONC reader in the tree (comments and
 * trailing commas, outside string literals). Text that does not parse is no
 * declaration: inventing a failure record for a commented config would
 * misreport a file pyright accepts.
 */
function parsePyrightJsonVersion(
	content: string,
): DeclaredPythonVersion | undefined {
	let parsed: unknown;
	try {
		parsed = parseJsonc<unknown>(content);
	} catch {
		// none: unparseable text is no declaration (pyright reads JSONC, so a
		// commented config is a file pyright still accepts, not a failure); the
		// read that could fail is recorded as `python-target-version-unreadable`.
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const value = (parsed as Record<string, unknown>).pythonVersion;
	return typeof value === "string" ? reduceBarePythonVersion(value) : undefined;
}

/**
 * One tier's answer for one directory: the declaration it read, and whether the
 * directory holds the tier's OWN config, which ends that tier's upward walk
 * whether or not it declared a level (#4638 r3 N1).
 */
interface TierRead {
	declaration: PythonTargetVersion | undefined;
	owned: boolean;
}

/**
 * Tier 1, ruff `target-version`. Ruff reads ONE config file per project, and in
 * one directory it prefers `.ruff.toml`, then `ruff.toml`, then
 * `pyproject.toml`; measured against ruff 0.16.8 (#4638 review). A file with no
 * usable `target-version` ends the tier rather than falling through to a
 * spelling ruff would ignore. Ruff ignores a `pyproject.toml` without
 * `[tool.ruff]`, so only a config that holds ruff's own settings owns the
 * directory (#4638 r3 N1).
 */
async function readRuffTier(
	dir: string,
	pyproject: string | undefined,
	pyprojectPath: string,
): Promise<TierRead> {
	let configPath: string | undefined;
	let config: string | undefined;
	for (const name of [".ruff.toml", "ruff.toml"]) {
		const candidatePath = join(dir, name);
		config = await readDeclarationFile(candidatePath);
		if (config !== undefined) {
			configPath = candidatePath;
			break;
		}
	}
	if (config === undefined) {
		if (
			pyproject === undefined ||
			!hasTomlTable(pyproject, String.raw`tool\.ruff`)
		) {
			return { declaration: undefined, owned: false };
		}
		configPath = pyprojectPath;
		config = extractTomlTableSection(pyproject, String.raw`tool\.ruff`);
	}
	if (configPath === undefined || config === undefined) {
		return { declaration: undefined, owned: false };
	}
	const target = parseTomlScalarString(config, "target-version");
	return {
		declaration: withSource(
			target ? reduceRuffTargetVersion(target) : undefined,
			"ruff-target-version",
			configPath,
		),
		owned: true,
	};
}

/**
 * Tier 2, pyright `pythonVersion`. pyright's own config file outranks
 * `[tool.pyright]`, and only one of the two is read. pyright skips a
 * `pyproject.toml` without `[tool.pyright]` (measured on 1.1.414), so only
 * `pyrightconfig.json` or that table owns the directory.
 */
async function readPyrightTier(
	dir: string,
	pyproject: string | undefined,
	pyprojectPath: string,
): Promise<TierRead> {
	const configPath = join(dir, "pyrightconfig.json");
	const config = await readDeclarationFile(configPath);
	if (config !== undefined) {
		return {
			declaration: withSource(
				parsePyrightJsonVersion(config),
				"pyright-python-version",
				configPath,
			),
			owned: true,
		};
	}
	if (pyproject === undefined) return { declaration: undefined, owned: false };
	const section = extractTomlTableSection(pyproject, String.raw`tool\.pyright`);
	if (section === undefined) return { declaration: undefined, owned: false };
	const raw = parseTomlScalarString(section, "pythonVersion");
	return {
		declaration: withSource(
			raw ? reduceBarePythonVersion(raw) : undefined,
			"pyright-python-version",
			pyprojectPath,
		),
		owned: true,
	};
}

/**
 * Tier 3, `requires-python` reduced to its lower bound. Ruff infers its target
 * from the nearest ancestor `pyproject.toml` that CARRIES the key and walks past
 * one that does not (measured on ruff 0.17.1), so only the key owns the directory.
 */
function readRequiresPythonTier(
	pyproject: string | undefined,
	pyprojectPath: string,
): TierRead {
	if (pyproject === undefined) return { declaration: undefined, owned: false };
	const projectSection = extractTomlTableSection(pyproject, "project");
	const raw =
		projectSection !== undefined
			? parseTomlScalarString(projectSection, "requires-python")
			: undefined;
	return {
		declaration: withSource(
			raw ? reducePythonSpecifier(raw) : undefined,
			"requires-python",
			pyprojectPath,
		),
		owned: raw !== undefined,
	};
}

/** Tier 4, the first line of `.python-version`; the file itself owns the directory. */
async function readVersionFileTier(dir: string): Promise<TierRead> {
	const levelFilePath = join(dir, ".python-version");
	const content = await readDeclarationFile(levelFilePath);
	if (content === undefined) return { declaration: undefined, owned: false };
	const firstLine = (content.split(/\r?\n/, 1)[0] ?? "").trim();
	return {
		declaration: withSource(
			reduceBarePythonVersion(firstLine),
			"python-version-file",
			levelFilePath,
		),
		owned: true,
	};
}

/** The four declaration sources, highest precedence first. */
const PYTHON_DECLARATION_SOURCES: readonly PythonTargetVersionSource[] = [
	"ruff-target-version",
	"pyright-python-version",
	"requires-python",
	"python-version-file",
];

interface DirectoryDeclarations {
	declaration: PythonTargetVersion | undefined;
	/** Sources whose own config sits here, so their walk ends in this directory. */
	closed: PythonTargetVersionSource[];
}

/**
 * The declarations one directory can hold, probed in the documented order:
 * ruff `target-version`, pyright `pythonVersion`, `requires-python`, then
 * `.python-version`. Within a tier the nearest declaration wins, so the first
 * directory that declares anything answers for the file. Each tier is only read
 * when it is still `open` and when the one before it declared nothing.
 *
 * The probe also reports which sources this directory CLOSES: each tool stops
 * at its own config, not at any `pyproject.toml` (#4638 r3 N1).
 */
async function readPythonDeclarationInDirectory(
	dir: string,
	open: ReadonlySet<PythonTargetVersionSource>,
): Promise<DirectoryDeclarations> {
	const pyprojectPath = join(dir, "pyproject.toml");
	const pyproject = await readDeclarationFile(pyprojectPath);
	const tiers: Array<[PythonTargetVersionSource, () => Promise<TierRead>]> = [
		["ruff-target-version", () => readRuffTier(dir, pyproject, pyprojectPath)],
		[
			"pyright-python-version",
			() => readPyrightTier(dir, pyproject, pyprojectPath),
		],
		[
			"requires-python",
			async () => readRequiresPythonTier(pyproject, pyprojectPath),
		],
		["python-version-file", () => readVersionFileTier(dir)],
	];
	const closed: PythonTargetVersionSource[] = [];
	for (const [source, read] of tiers) {
		if (!open.has(source)) continue;
		const { declaration, owned } = await read();
		if (declaration) return { declaration, closed: [] };
		if (owned) closed.push(source);
	}
	return { declaration: undefined, closed };
}

/**
 * #4638: the Python syntax level the project declares for `filePath`, or
 * undefined when it declares none. Walks up from the file's directory (so every
 * project root is on the way) and stops at `homeDir`, the shared ceiling for
 * walk-up discovery. Each source ends its own walk at its own config (ruff at a
 * ruff config, pyright at pyrightconfig.json or `[tool.pyright]`,
 * `requires-python` at a `pyproject.toml` that carries the key, `.python-version`
 * at itself), the rule each tool applies. Only a Python source file has an
 * answer, so a mixed sweep pays nothing for its other files.
 *
 * A declaration that names no CPython major/minor is absent, never a default:
 * guessing a level is what produced the spurious `compile` verdict in the first
 * place.
 */
export async function detectPythonTargetVersion(
	filePath: string,
	homeDir: string = os.homedir(),
): Promise<PythonTargetVersion | undefined> {
	if (resolveLanguage(filePath)?.id !== "python") return undefined;
	const open = new Set(PYTHON_DECLARATION_SOURCES);
	// #4689 item 6: from the module's identity, so a module linked in from
	// another project reads that project's declaration.
	for (const dir of walkUpDirs(dirname(realpathOrResolve(filePath)), {
		homeDir,
	})) {
		const { declaration, closed } = await readPythonDeclarationInDirectory(
			dir,
			open,
		);
		if (declaration) return declaration;
		// A source's own config here ends THAT source's walk: a nested project
		// declares only for itself under that tool's discovery rule, and no
		// ancestor's level reaches it. Other sources keep walking.
		for (const source of closed) open.delete(source);
		if (open.size === 0) return undefined;
	}
	return undefined;
}
