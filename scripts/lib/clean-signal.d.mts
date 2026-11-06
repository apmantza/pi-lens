// Type declarations for clean-signal.mjs (untyped .mjs imported from .ts tests).

// #594: fixed path shared by probe-clean-signal.mjs (writer) and
// notify-clean-signal-drift.mjs (reader).
export const DRIFT_SUMMARY_PATH: string;

/** #4512: the stale-cells tracking-issue body and verdict the probe stages. */
export const STALE_CELLS_BODY_PATH: string;
export const STALE_CELLS_STATE_PATH: string;
export const STALE_CELLS_ISSUE_TITLE: string;

export interface StaleCell {
	lang: string;
	server: string;
	cleanBehavior: string;
	firstPublish: string;
	since: string;
	misses: number;
}

export function buildStaleCellsBody(
	cells: readonly StaleCell[],
	opts?: { runUrl?: string | null },
): string;

export function staleCellsVerdict(
	cells: readonly StaleCell[],
	opts?: { runUrl?: string | null },
): { state: "drift"; body: string } | { state: "clean" };

export function writeStaleCellsVerdict(
	cells: readonly StaleCell[],
	opts: {
		fullRun: boolean;
		env?: Record<string, string | undefined>;
		bodyPath?: string;
		statePath?: string;
	},
): "drift" | "clean" | "skipped" | "unwritten";

export interface CleanSignalObservations {
	dirtyPublishes?: number;
	dirtyVersioned?: number;
	cleanTransitionPublishes?: number;
	cleanTransitionVersioned?: number;
}

export function classifyCleanBehavior(obs: CleanSignalObservations): {
	behavior:
		| "publishes-versioned"
		| "publishes-unversioned"
		| "silent"
		| "unknown";
	tier: 2 | 3 | 0;
	tierLabel: "2" | "2*" | "3" | "";
	reason: string;
};

export function resolveProbeServerId(
	fx: { lang?: string; auxiliaryServerIds?: readonly string[] },
	servers: ReadonlyArray<{ id: string; role?: string }>,
): string | undefined;

export function createPublishTraceDrainer(options: {
	readLog: (offset: number) => {
		size: number;
		read: (offset: number) => { chunk: string; bytesRead: number } | null;
	};
	echoTrace?: boolean;
	/** #4615: the client's own document-key normalizer, applied to both sides. */
	documentPathKey?: (documentPath: string) => string;
}): {
	(
		sink: Array<{ server?: string; path?: string }>,
		serverId: string,
		fixturePath: string,
	): void;
	reset(offset: number): void;
};

export interface DriftInput {
	lang: string;
	behavior: string;
	/** #3444: the first-publish class of the same trace, when measured. */
	firstPublish?: string;
	/** #3444: a `clean: true` fixture, whose empty dirty phase is by design. */
	cleanFixture?: boolean;
	/** #5348: the measured server is an auxiliary; `silentOnClean` is never read for one. */
	auxiliary?: boolean;
}

export interface DriftResult {
	lang: string;
	kind:
		| "silent-not-marked"
		| "marked-not-silent"
		| "consistent"
		| "not-comparable";
	detail: string;
}

export function checkCleanSignalDrift(
	row: DriftInput,
	silentOnClean: boolean | undefined,
): DriftResult;

export function isDegenerateSilent(row: DriftInput): boolean;

export function aggregateDriftRows<R extends DriftInput>(
	rows: R[],
	keyOf?: (lang: string) => string,
): Array<R & { fixtures: string[] }>;

export function findCleanSignalDrift(
	rows: DriftInput[],
	lookupSilentOnClean: (lang: string) => boolean | undefined,
): DriftResult[];

// #3310: the first-publish axis — is a push server's FIRST publish the answer,
// or an empty placeholder sent while a one-time index builds?
export type FirstPublishClass =
	| "empty-first"
	| "direct"
	| "empty-only"
	| "unknown";

export function classifyFirstPublish(
	dirtyPublishes: Array<{ diags: number }> | undefined,
): { firstPublish: FirstPublishClass; reason: string };

export const COMPARABLE_FIRST_PUBLISH: Set<string>;

/** #3401: the `clean-behavior` values that are a measurement of anything. */
export const MEASURED_CLEAN_BEHAVIORS: Set<string>;

/** #3401: the matrix lang a probe fixture writes to (`x-clean` -> `x`). */
export function targetLangForFixture(lang: string, clean?: boolean): string;

/**
 * #4615: fixture rows -> one row per matrix lang, with each axis resolved to
 * its own authoritative fixture (clean-behavior: the `clean: true` fixture;
 * first-publish: a dirty sibling).
 */
export function resolveTargetLangRows<
	T extends DriftInput & {
		cleanFixture?: boolean;
		behavior: string;
		firstPublish?: string;
		targetLang?: string;
	},
>(
	measuredRows: readonly T[],
): Array<
	T & {
		lang: string;
		targetLang: string;
		firstPublishFrom?: string;
	}
>;

/** #4615: resolved rows -> the nightly log line naming each class's fixture. */
export function describeFirstPublishAuthors(
	targetLangRows: ReadonlyArray<{
		targetLang?: string;
		firstPublishFrom?: string;
	}>,
): string;

/** #3401: resolved probe rows -> `refreshCapabilityMatrix` observations. */
export function buildMatrixObservations(
	targetLangRows: ReadonlyArray<{
		targetLang: string;
		firstPublish?: string;
		behavior?: string;
		tierLabel?: string;
		tier?: number;
	}>,
): Array<{
	lang: string;
	firstPublish: string | null;
	cleanBehavior: string | null;
	tier: string;
}>;

export const LANG_TO_STRATEGY_KEY: Record<string, string>;

export function strategyKeyForLang(lang: string): string;
