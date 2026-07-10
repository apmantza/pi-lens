// Pure process-table matching for scripts/compat-smoke-behavioral.mjs (#476,
// Layer B assertion 3: zero surviving LSP-server child processes after pi
// exits — the #472 orphan class). Split from the actual process listing
// (which differs Windows `Get-CimInstance`/`tasklist` vs POSIX `ps`, and is
// exercised end-to-end by the orchestration script, not here) so the pure
// "does this command line look like a leaked LSP server, and is it NEW since
// the baseline snapshot" logic is unit-testable with fake process tables.

/**
 * Command-line substrings that identify an LSP server process we launch.
 * Deliberately narrow — matching on the distinctive binary/module name, not
 * a generic "node" or "language-server" fragment, so the scan doesn't flag
 * unrelated node processes on a shared CI runner.
 */
export const LSP_PROCESS_MARKERS = [
  "typescript-language-server",
  "ast-grep lsp",
  "ast-grep-lsp",
  "pyright-langserver",
  "vscode-json-languageserver",
];

/**
 * @typedef {{ pid: number, command: string }} ProcessRow
 */

/**
 * True iff `command` looks like one of the LSP servers pi-lens spawns.
 *
 * @param {string} command
 */
export function isLspServerCommand(command) {
  const lower = command.toLowerCase();
  return LSP_PROCESS_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

/**
 * Diff a `before` and `after` process snapshot and return the LSP-server
 * rows that are NEW in `after` (i.e. survived/spawned during the run and are
 * still alive after pi exited — the orphan class #472 fixed). Matches by pid
 * — a row present in both snapshots with the same pid is presumed to be an
 * unrelated pre-existing process, not something this run leaked.
 *
 * @param {ProcessRow[]} before
 * @param {ProcessRow[]} after
 * @returns {ProcessRow[]}
 */
export function diffSurvivingLspProcesses(before, after) {
  const beforePids = new Set(before.map((r) => r.pid));
  return after.filter((row) => !beforePids.has(row.pid) && isLspServerCommand(row.command));
}
