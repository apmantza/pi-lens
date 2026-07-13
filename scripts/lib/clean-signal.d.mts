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

export interface DriftInput {
  lang: string;
  behavior: string;
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

export function findCleanSignalDrift(
  rows: DriftInput[],
  lookupSilentOnClean: (lang: string) => boolean | undefined,
): DriftResult[];
