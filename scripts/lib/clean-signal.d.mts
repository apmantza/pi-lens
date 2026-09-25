// Type declarations for clean-signal.mjs (untyped .mjs imported from .ts tests).

// #594: fixed path shared by probe-clean-signal.mjs (writer) and
// notify-clean-signal-drift.mjs (reader).
export const DRIFT_SUMMARY_PATH: string;

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

export function createPublishTraceDrainer(options: {
	readLog: (offset: number) => {
		size: number;
		read: (offset: number) => { chunk: string; bytesRead: number } | null;
	};
	echoTrace?: boolean;
}): {
	(sink: Array<{ server?: string }>, serverId: string): void;
	reset(offset: number): void;
};

export interface DriftInput {
	lang: string;
	behavior: string;
	/** #3444: the first-publish class of the same trace, when measured. */
	firstPublish?: string;
	/** #3444: a `clean: true` fixture, whose empty dirty phase is by design. */
	cleanFixture?: boolean;
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

export const LANG_TO_STRATEGY_KEY: Record<string, string>;

export function strategyKeyForLang(lang: string): string;
