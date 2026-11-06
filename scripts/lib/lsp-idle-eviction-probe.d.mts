// Type declarations for lsp-idle-eviction-probe.mjs (untyped .mjs imported from .ts tests).

import type { IdleEvictionRow } from "./lsp-idle-eviction-doc.mjs";

export interface ProbeFinding {
	serverId?: string;
	source?: string;
	code?: string | number;
	severity?: number;
	message?: string;
	range?: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
}

export interface IdleEvictionDriver {
	now(): number;
	sleep(ms: number): Promise<void>;
	/** An unavailable reason code, or undefined when the fixture is ready. */
	prepare(): Promise<string | undefined>;
	/** Findings of one diagnostics touch; undefined when no client became ready. */
	touch(): Promise<ProbeFinding[] | undefined>;
	isTargetAlive(): boolean;
	/** Idle-eviction records the service has written so far. */
	evictionsRecorded(): number;
	rssBytes(): Promise<number | null>;
	/** Makes the target evictable; resolves to the restore. */
	armEviction(): Promise<() => void>;
	dispose(): Promise<void>;
}

export interface ProbeServer {
	id: string;
	idleEviction: string;
	role?: string;
}

export interface ProbeFixture {
	lang: string;
	file?: string;
	auxiliarySourceMatch?: string;
	[key: string]: unknown;
}

export interface ProbeBudgets {
	baselineAttempts: number;
	baselineSettleMs: number;
	evictionWaitMs: number;
	recordWaitMs: number;
	pollMs: number;
	coldStartWaitMs: number;
}

export function selectFixtureForServer<F extends Record<string, any>>(
	server: { id: string; extensions: readonly string[] },
	fixtures: readonly F[],
): F | null;

export function probePopulation<
	S extends { id: string; extensions: readonly string[] },
	F extends Record<string, any>,
>(
	servers: readonly S[],
	fixtures: readonly F[],
): { server: S; fixture: F | null }[];

export function measureRegistry<
	S extends {
		id: string;
		extensions: readonly string[];
		idleEviction: string;
		role?: string;
	},
	F extends Record<string, any>,
>(args: {
	registry: { LSP_SERVERS: readonly S[] };
	fixtures: readonly F[];
	filter?: readonly string[];
	budgetMs: number;
	now: () => number;
	probe: (entry: { server: S; fixture: F | null }) => Promise<IdleEvictionRow>;
	beforeEach?: () => void | Promise<void>;
}): Promise<IdleEvictionRow[]>;

export function findingKey(d: ProbeFinding): string;

export function residentTreeBytes(
	pid: number,
	deps: {
		readProcessPairs(): Promise<[number, number][] | null>;
		sampleRss(pids: number[]): Promise<Map<number, number> | null>;
		walkDescendantPids(root: number, pairs: [number, number][]): number[];
	},
): Promise<number | null>;

export function probeServer(args: {
	server: ProbeServer;
	fixture: ProbeFixture | null;
	createDriver: (fixture: ProbeFixture) => IdleEvictionDriver;
	budgets: ProbeBudgets;
}): Promise<IdleEvictionRow & { declared: string }>;

export function createServiceDriver(args: {
	lsp: any;
	server: ProbeServer;
	target: { absFile: string; content: string };
	windowMs: number;
	touchBudgets: { maxClientWaitMs: number; maxDiagnosticsWaitMs: number };
	residentBytesOf: (pid: number) => Promise<number | null>;
	prepare: () => Promise<string | undefined>;
	dispose: () => Promise<void>;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	env?: Record<string, string | undefined>;
}): IdleEvictionDriver;

/** #5323: the fixture half of a nightly driver; never consults the installer. */
export function fixtureWorkspaceLifecycle(
	fx: Record<string, any>,
	target: { absFile: string; content: string },
	deps: {
		lsp: { supportsLSP(file: string): boolean };
		bootstrapFixtureWorkspace: (
			fx: any,
			opts: any,
		) => Promise<{ absFile: string; workspace: string; cleanup: () => void }>;
		initLSPConfig: (workspace: string) => Promise<unknown>;
		repoRoot: string;
		runFixtureSetup: (
			setup: unknown,
			workspace: string,
			verbose: boolean,
		) => { ok: boolean };
		ensureSmokeLombokJar: (
			workspace: string,
			verbose: boolean,
		) => Promise<unknown>;
	},
): {
	prepare: () => Promise<string | undefined>;
	dispose: () => Promise<void>;
};
