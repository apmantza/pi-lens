// Type declarations for process-scan.mjs (untyped .mjs imported from .ts tests).

export const LSP_PROCESS_MARKERS: string[];

export interface ProcessRow {
  pid: number;
  command: string;
}

export function isLspServerCommand(command: string): boolean;

export function diffSurvivingLspProcesses(
  before: ProcessRow[],
  after: ProcessRow[],
): ProcessRow[];
