// Type declarations for md-matrix.mjs (untyped .mjs imported from .ts tests).

export const GENERATED_LSP_DOCS: readonly string[];

export interface ParsedTable {
	start: number;
	end: number;
	header: string[];
	sep: string;
	rows: string[][];
}

export function parseTable(
	text: string,
	headerMarker: string,
): ParsedTable | null;

export function mergeRows(
	existing: string[][],
	header: string[],
	measured: Record<string, string | number | undefined>[],
	keyCol: string,
	ownedCols: string[],
): string[][];

export function mergeSrc(existing: string, measured: string): string;

export function compareStableStrings(a: string, b: string): number;

export function compareGeneratedDocs(a: string, b: string): boolean;

export function sortedStrings(values: readonly unknown[] | undefined): string[];

export interface ServerCapabilityRow {
	serverId: string;
	workspaceDiagnosticsSupport?: {
		mode?: string;
		workspaceDiagnostics?: boolean;
	};
	operationSupport?: Record<string, boolean | undefined>;
	advertisedCommands?: readonly string[];
	rawCapabilityKeys?: readonly string[];
	/** #3407: `textDocumentSync.save` as the snapshot reports it. */
	textDocumentSave?: "none" | "save" | "save+text";
}

export function renderServerCapabilitiesDoc(options: {
	rows: readonly ServerCapabilityRow[];
	unavailable: Iterable<string>;
	date: string;
	platform: string;
	ops: readonly (readonly [string, string])[];
}): string;

export function replaceTable(
	text: string,
	headerMarker: string,
	header: string[],
	sep: string,
	rows: string[][],
): string | null;

export function reshapeRowsByName(
	priorRows: string[][],
	priorHeader: string[],
	newHeader: string[],
	keyCol: string,
	placeholder?: string | ((column: string) => string),
): string[][];

export function parseBulletSection(
	text: string,
	heading: string,
): Map<string, string>;

export function mergeBulletSection(
	newText: string,
	heading: string,
	priorBullets: Map<string, string>,
	keysToCarry: string[],
): string;

export function mergeServerCapabilitiesDoc(
	priorText: string,
	freshText: string,
): { text: string; preservedCount: number };

/** #4615: days after which a marker-backed `empty-first` cell's first-miss stamp reds the census. */
export const FIRST_PUBLISH_EXPIRY_DAYS: number;

/** #4512: consecutive nightly misses after which a stale cell is raised. */
export const MISSED_PROBE_RAISE_RUNS: number;

/** #4512: the `first-publish` values that are a measurement. */
export const MEASURED_FIRST_PUBLISHES: Set<string>;

/** #4512: the columns an older matrix doc gains (`version`, `install`, `stale`). */
export const MATRIX_ADDED_COLUMNS: string[];

/** #4512: give an older matrix doc the version/install/stale columns; idempotent. */
export function ensureMatrixColumns(text: string, marker?: string): string;

/** #4512: the refresh-state key holding the missed-probe streaks. */
export const MISSED_PROBE_KEY: "missed-probe";

/** #4512: replace (or append) the refresh-state section; `[]` removes it. */
export function replaceRefreshStateSection(
	text: string,
	section: string[],
): string;

export interface RaisedCell {
	lang: string;
	server: string;
	cleanBehavior: string;
	firstPublish: string;
	since: string;
	misses: number;
}

/** #4512: the raised stale cells of a refreshed doc, for the tracking issue. */
export function describeRaisedCells(
	text: string,
	raisedLangs: Iterable<string>,
	marker?: string,
): RaisedCell[];

/** #5323: the generated held table, outside the clean-behavior census. */
export const HELD_ROWS_HEADING: string;
export const HELD_ROWS_MARKER: string;

/** #4512: merge one characterize-lsp run (mode + provenance) into the matrix. */
export function mergeCharacterization(
	text: string,
	rows: ReadonlyArray<{ lang: string; server?: string; mode: string }>,
	provenance: ReadonlyMap<string, { install: string; version?: string }>,
	src: string,
	marker?: string,
	opts?: {
		serverLangs?: Iterable<string>;
		probedLangs?: Iterable<string>;
		now?: Date | number | string;
	},
): { text: string; measured: number; rows: number; held: number } | null;

/** #3401: consecutive agreeing runs before a `clean-behavior`/`tier` change is written. */
export const TIER_CHANGE_AGREE_RUNS: number;

export function advancePendingClass(
	confirmed: string,
	pending: { value: string; runs: number } | undefined,
	observed: string,
	agreeRuns: number,
): {
	confirmed: string;
	pending?: { value: string; runs: number };
	committed: boolean;
};

export interface MatrixObservation {
	lang: string;
	firstPublish?: string | null;
	cleanBehavior?: string | null;
	tier?: string | null;
}

export interface RefreshState {
	"first-publish"?: Record<
		string,
		{
			firstMissed?: string;
			pendingFirstPublish?: "direct" | "empty-first";
			runs?: number;
		}
	>;
	"clean-behavior"?: Record<
		string,
		{ pendingBehavior: string; pendingTier: string; runs: number }
	>;
	"idle-eviction"?: Record<string, { nights: IdleEvictionNight[] }>;
	/** #4512: consecutive-night misses per lang and axis behind the `stale` column. */
	"missed-probe"?: Record<
		string,
		Partial<
			Record<
				"clean-behavior" | "first-publish",
				{ since: string; last: string; misses: number }
			>
		>
	>;
}

export function parseRefreshState(text: string): RefreshState;

/** #3989: the refresh-state key holding the idle-eviction promotion bookkeeping. */
export const IDLE_EVICTION_KEY: "idle-eviction";

export interface IdleEvictionNight {
	day: string;
	rssMb: number | null;
	coldMs: number;
}

/** #3989: replace the `idle-eviction` key of the refresh-state block. */
export function setIdleEvictionState(
	text: string,
	idleEviction: Record<string, { nights: IdleEvictionNight[] }>,
): string;

export function refreshCapabilityMatrix(
	text: string,
	observations: readonly MatrixObservation[],
	opts?: {
		src?: string;
		marker?: string;
		agreeRuns?: number;
		raiseRuns?: number;
		/** The injected clock; default is the real one. */
		now?: Date | number | string;
		/** A subset probe's langs; a lang outside it keeps its bookkeeping. */
		probedLangs?: Iterable<string>;
	},
): {
	text: string;
	changed: boolean;
	reason?: string;
	pending: number;
	committed: number;
	/** The langs behind each count, in table order (named in the step log). */
	pendingLangs: string[];
	committedLangs: string[];
	/** #4512: langs whose measured cell was not re-observed tonight (kept, marked stale). */
	staleLangs: string[];
	/** #4512: the stale langs that have missed `MISSED_PROBE_RAISE_RUNS` consecutive nights. */
	raisedLangs: string[];
};

/** Whole UTC days since a real YYYY-MM-DD stamp; null for an invalid stamp. */
export function elapsedDays(from: unknown, to: string): number | null;

/** The `clean-behavior` values that are a measurement of anything (#3401). */
export const MEASURED_CLEAN_BEHAVIORS: Set<string>;
