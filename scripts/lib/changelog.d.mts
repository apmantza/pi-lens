// Type declarations for changelog.mjs (untyped .mjs imported from .ts tests).

/** Per-release heading for `audience: internal` fragments (#3852). */
export const INTERNAL_HEADING: string;

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
export interface SectionEntries {
	order: string[];
	buckets: Map<string, string[]>;
	internalCount: number;
}
export function parseSectionEntries(
	body: string,
	opts?: { maxGist?: number; gist?: boolean },
): SectionEntries;
export function normalizeVersion(version: string): string;
export function extractSection(text: string, version: string): string | null;
export function hasSection(text: string, version: string): boolean;

export interface ChangelogLintProblem {
	kind: "orphan" | "wrapped-title";
	line: number;
	text: string;
}

export function lintSectionBody(body: string | null): ChangelogLintProblem[];
export function lintUnreleased(text: string): ChangelogLintProblem[];
export const EMPTY_UNRELEASED: string;
