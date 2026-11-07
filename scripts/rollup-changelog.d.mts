export const CHANGELOG_SECTIONS: readonly string[];
export function isEntryBullet(line: string): boolean;
export function parseEntry(
	text: string,
	file?: string,
): {
	section: string;
	audience: "user" | "internal";
	area: string | undefined;
	entry: string;
};
export function rollupChangelog(
	version: string,
	options?: { rootDir?: string; date?: string },
): { version: string; files: string[]; changelogPath: string };

/** Reads and validates every entry file under `<rootDir>/.changelog` (the `changelog:check` script entry). */
export function validateChangelogEntries(options?: {
	rootDir?: string;
}): Array<{
	file: string;
	section: string;
	audience: "user" | "internal";
	area: string | undefined;
	entry: string;
}>;

export const USER_RELEASE_LIMIT: number;
export function userCountLine(body: string): string;
export function renderUserChangelog(options?: { rootDir?: string }): string;
export function writeUserChangelog(options?: { rootDir?: string }): void;
export function checkUserChangelog(options?: { rootDir?: string }): void;

/** The duplicate-entry checklist for one `CHANGELOG.md` section (#5351); edits nothing. */
export function duplicateChecklist(
	version: string,
	options?: { rootDir?: string },
): string;
