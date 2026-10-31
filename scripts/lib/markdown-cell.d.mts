// Type declarations for markdown-cell.mjs (untyped .mjs imported from .ts tests).

/** Escape a value for one GFM table cell: backslash first, then pipe. */
export function escapeMarkdownCell(text: unknown): string;

/** Split one GFM table row into trimmed cells: `\|` escapes, a code span does not protect a pipe. */
export function splitMarkdownRow(line: string): string[];
