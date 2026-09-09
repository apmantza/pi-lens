export const CHANGELOG_SECTIONS: readonly string[];
export function isEntryBullet(line: string): boolean;
export function parseEntry(
	text: string,
	file?: string,
): { section: string; entry: string };
export function rollupChangelog(
	version: string,
	options?: { rootDir?: string; date?: string },
): { version: string; files: string[]; changelogPath: string };

/** Reads and validates every entry file under `<rootDir>/.changelog` (the `changelog:check` script entry). */
export function validateChangelogEntries(options?: {
	rootDir?: string;
}): Array<{ file: string; section: string; entry: string }>;
