// Type declarations for probe-fixture.mjs (untyped .mjs imported from .ts tests).

export interface ProbeRow {
	lang: string;
	server?: string;
	serverId?: string;
	behavior: string;
	tier: number;
	tierLabel: string;
	mode: string;
	detail: string;
	firstPublish: string;
	cleanFixture: boolean;
	/** #5348: the measured server is an auxiliary, set by the probe. */
	auxiliary?: boolean;
}

export function createProbeFixture(deps: {
	lsp: {
		supportsLSP(file: string): boolean;
		touchFile(file: string, content: string, options: object): Promise<unknown>;
		getWorkspaceDiagnosticsSupport(file: string): Promise<{ mode?: string }>;
		/** Read only for a fixture that sets `expectLaunchVariant` (#5348). */
		getCapabilitySnapshots?(
			file: string,
		): Promise<ReadonlyArray<{ launchVariant?: string }>>;
	};
	repoRoot: string;
	install: boolean;
	ensureTool?: (tool: string) => Promise<unknown>;
	initLSPConfig: unknown;
	getServersForFileWithConfig(
		file: string,
	): ReadonlyArray<{ id: string; role?: string }>;
	bootstrapFixtureWorkspace(
		fx: unknown,
		options: { initLSPConfig: unknown; repoRoot: string; workspace: string },
	): Promise<{ absFile: string }>;
	/** #4514: `refused: <reason>` when trust kept the server from launching. */
	trustRefusal?: () => Promise<string | undefined>;
	drainPublishTrace: {
		(
			sink: Array<{ server?: string; path?: string }>,
			serverId: string,
			fixturePath: string,
		): void;
		reset(offset: number): void;
	};
	pubLogSize(): number;
	sleep(ms: number): Promise<void>;
}): (
	fx: {
		lang: string;
		file: string;
		serverHint?: string;
		clean?: boolean;
		tools?: string[];
		auxiliaryServerIds?: readonly string[];
		/** #5348: the launch the fixture's `setup` produces; a row from another launch reads `unknown`. */
		expectLaunchVariant?: string;
	},
	dst: string,
	row: ProbeRow,
) => Promise<void>;

/**
 * The trailing-comment prefix for a file's syntax (`#`, `//`, `--`, `;;`), used
 * by the clean-signal probe's diagnostic-neutral edit and by the save-verdict
 * probe's `savedWrite` arm. Both need bytes that differ while the finding set
 * does not, so it is one comment-syntax table, not a sibling per probe.
 */
export function commentFor(file: string): string;
