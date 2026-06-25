// Type declarations for changelog.mjs (untyped .mjs imported from .ts tests).

export interface ChangelogSection {
  label: string;
  heading: string;
  body: string;
}

export function parseSections(text: string): ChangelogSection[];
export function summarizeSection(
  body: string,
  opts?: { maxGist?: number; gist?: boolean },
): string;
export function normalizeVersion(version: string): string;
export function extractSection(text: string, version: string): string | null;
export function hasSection(text: string, version: string): boolean;
export function unreleasedHasEntries(text: string): boolean;
export function promoteUnreleased(
  text: string,
  version: string,
  date: string,
): string;
