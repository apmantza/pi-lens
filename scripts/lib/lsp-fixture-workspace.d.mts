/** A fixture from LSP_FIXTURES, as far as this module cares. */
export interface LspFixtureLike {
	lang: string;
	dir: string;
	file: string;
	gitInit?: boolean;
	disableServers?: readonly string[];
}

export interface DisableServersContext {
	workspace: string;
	absFile: string;
	fx: LspFixtureLike;
}

export interface BootstrapFixtureWorkspaceOptions {
	/** The caller's own `initLSPConfig` (each script imports it from a slightly different `dist/` entry point). */
	initLSPConfig: (cwd: string) => Promise<void>;
	/** Repo root the fixture's `dir` is resolved against. */
	repoRoot: string;
	/** Prefix for the generated `os.tmpdir()` workspace name. Ignored when `workspace` is given. */
	tmpPrefix?: string;
	/** Use this directory as-is instead of creating a fresh one (probe-clean-signal.mjs's shape). */
	workspace?: string;
	/** Defaults to `fx.gitInit`. */
	gitInit?: boolean;
	/**
	 * Omitted → `fx.disableServers`. An array → an explicit override. A
	 * function → computed AFTER the workspace is copied and registered
	 * (bench-lsp.mjs's shape, which needs a real file path to compute it).
	 */
	disableServers?:
		| readonly string[]
		| ((ctx: DisableServersContext) => readonly string[]);
}

export interface BootstrapFixtureWorkspaceResult {
	workspace: string;
	absFile: string;
	cleanup: () => void;
	disabledServers: readonly string[];
}

export function bootstrapFixtureWorkspace(
	fx: LspFixtureLike,
	opts: BootstrapFixtureWorkspaceOptions,
): Promise<BootstrapFixtureWorkspaceResult>;

export interface WithScratchHomeOptions {
	/** Skip pinning even when PI_LENS_HOME is unset (no caller in this repo does today). */
	realHome?: boolean;
	tmpPrefix?: string;
}

export interface WithScratchHomeResult {
	/** The scratch dir now in effect (own or pre-existing), or undefined when `realHome` was passed. */
	dir: string | undefined;
	/** True only when this call actually created and pinned a fresh scratch dir. */
	pinned: boolean;
	/** Reverses this call's own env mutation (a no-op when `pinned` is false). */
	restore: () => void;
}

export function withScratchHome(
	opts?: WithScratchHomeOptions,
): WithScratchHomeResult;
