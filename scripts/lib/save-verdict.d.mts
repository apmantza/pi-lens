// Type declarations for save-verdict.mjs (untyped .mjs imported from .ts tests).

export const SAVE_VERDICT_MARKER: string;
export const SAVE_VERDICT_COLUMN: string;
export const SAVE_VERDICT_VALUES: Set<string>;
export const SAVE_VERDICT_COMMAND: string;

export interface SaveArm {
	nonEmpty?: number;
	ms?: number | null;
}

export interface SaveVerdictArms {
	mode?: string;
	noSave?: SaveArm;
	silence?: SaveArm;
	saveAlone?: SaveArm;
	savedWrite?: SaveArm;
}

export interface SaveVerdict {
	verdict: string;
	reason: string;
}

export function classifySaveVerdict(input: SaveVerdictArms): SaveVerdict;

export function describeArm(
	arm: SaveArm | undefined,
	waitMs: number,
	unit?: string,
): string;

export function fixturePolicy(fixture: {
	auxiliaryServerIds?: string[];
	lspGate?: boolean;
	lspGateExempt?: string;
}): string;

export function saveVerdictCells(row: {
	server: string;
	save: string;
	mode: string;
	fixture: {
		lang: string;
		auxiliaryServerIds?: string[];
		lspGate?: boolean;
		lspGateExempt?: string;
	};
	arms: SaveVerdictArms;
	waitMs: number;
	failures?: string[];
}): Record<string, string> | undefined;

export function refreshSaveVerdictTable(
	text: string,
	measured: Array<Record<string, string>>,
	opts?: { marker?: string },
): {
	text: string;
	changed: boolean;
	measured: string[];
	kept: string[];
	heldBack: SaveVerdictHeldBack[];
	notInTable: string[];
	reason?: string;
};

export interface SaveVerdictHeldBack {
	server: string;
	prior: string;
	measured: string;
	verdict: string;
}

export function describeHeldBack(held: SaveVerdictHeldBack): string;

export function reportHeldBack(
	heldBack: SaveVerdictHeldBack[],
	sink: {
		env: Record<string, string | undefined>;
		log: (line: string) => void;
	},
): void;

export function rowsReached(refreshed: {
	measured: string[];
	heldBack: unknown[];
}): number;

export function saveVerdictSummary(run: {
	command: string;
	src: string;
	waitMs: number;
	rows: Array<{ cells: Record<string, string> | undefined }>;
	refreshed: ReturnType<typeof refreshSaveVerdictTable>;
	notMeasured: unknown[];
	budgetExhausted: boolean;
}): {
	command: string;
	src: string;
	waitMs: number;
	measured: Array<Record<string, string> | undefined>;
	wrote: string[];
	notInTable: string[];
	kept: string[];
	heldBack: SaveVerdictHeldBack[];
	notMeasured: unknown[];
	budgetExhausted: boolean;
};

export interface SaveVerdictRow {
	server: string;
	save: string;
	verdict: string;
	evidence: string;
}

export function parseSaveVerdictRows(
	text: string,
	opts?: { marker?: string },
): SaveVerdictRow[];

export function orderByNeed<F extends { lang: string }>(
	fixtures: F[],
	rows: Array<{ server: string; verdict: string; evidence?: string }>,
	serverOf: (fixture: F) => string,
): F[];

export interface InstallAttemptRecord {
	outcome: string;
	reason?: string;
}

export function installCauses(
	fixture: { lang?: string; tools?: string[] },
	deps: {
		ensureTool: (toolId: string) => Promise<string | undefined>;
		getInstallAttempt?: (toolId: string) => InstallAttemptRecord | undefined;
	},
): Promise<string[]>;

export function detailWithInstallCauses(row: {
	cells?: unknown;
	install?: string[];
	detail?: string;
}): string;
