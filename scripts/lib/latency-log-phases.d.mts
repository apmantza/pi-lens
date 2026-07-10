// Type declarations for latency-log-phases.mjs (untyped .mjs imported from .ts tests).

export function parseNdjsonEntries(text: string): Array<Record<string, unknown>>;

export function findPhaseEntries(
  entries: Array<Record<string, unknown>>,
  phase: string,
  sinceIso?: string,
): Array<Record<string, unknown>>;

export function phaseWasLogged(
  entries: Array<Record<string, unknown>>,
  phase: string,
  sinceIso?: string,
): boolean;

export function noPhasesLogged(
  entries: Array<Record<string, unknown>>,
  phases: string[],
  sinceIso?: string,
): boolean;
