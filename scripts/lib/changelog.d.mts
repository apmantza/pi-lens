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
	/** Per section, the area title of each bucket item (`null`: no area heading). */
	areas: Map<string, Array<string | null>>;
	/** Per section, the whole entry text of each bucket item. */
	texts: Map<string, string[]>;
	internalCount: number;
}
export function parseSectionEntries(
	body: string,
	opts?: { maxGist?: number; gist?: boolean },
): SectionEntries;
export const DUPLICATE_HEADLINE_OVERLAP: number;
export const DUPLICATE_SHARED_CODE_SPANS: number;
export interface DuplicateEntryPair {
	section: string;
	area: string | null;
	headlines: [string, string];
	reason: string;
}
/** Likely duplicate entry pairs of one section body (#5351); never edits. */
export function findDuplicateEntries(body: string): DuplicateEntryPair[];
export function renderDuplicateChecklist(
	version: string,
	pairs: DuplicateEntryPair[],
): string;
/** The closed list of areas a user fragment names in `area:` (#5351). */
export const CHANGELOG_AREAS: ReadonlyArray<{ id: string; title: string }>;
export const AREA_GROUP_MIN_ITEMS: number;
export const HEADLINE_MIN_WORDS: number;
export const HEADLINE_MAX_WORDS: number;
export const HEADLINE_MAX_CHARS: number;
export const BODY_MAX_WORDS: number;
export const HOUSE_STYLE_BANNED_TERMS: readonly string[];
export const IMPERATIVE_OPENERS: readonly string[];
/** Shape problems of one `audience: user` entry; `[]` when it is the one admitted form. */
export function userEntryShapeProblems(entry: string): string[];
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
