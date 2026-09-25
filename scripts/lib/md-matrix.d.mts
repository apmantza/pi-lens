// Type declarations for md-matrix.mjs (untyped .mjs imported from .ts tests).

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
	opts?: { updateOnly?: boolean },
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
