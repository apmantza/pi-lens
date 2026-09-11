/**
 * Lines of one markdown `heading` section, exclusive of the next heading.
 *
 * Shared by the docs-membership guard (`tests/docs/features-counts.test.ts`)
 * and the label-manifest sweep
 * (`tests/config/label-manifest-coverage.test.ts`), which previously each
 * carried this same indexOf-then-slice shape (#2924 F6: one copy deleted
 * here). The next-heading pattern is a parameter because callers disagree:
 * docs feature sections end at any ATX heading, while AGENTS.md's triage
 * section ends at the next `## ` heading.
 */
export function docsSectionLines(
	md: string,
	heading: string,
	nextHeading = /^#{1,6} /m,
): string[] {
	const start = md.indexOf(heading);
	if (start === -1) throw new Error(`docs heading not found: ${heading}`);
	const rest = md.slice(start + heading.length);
	const end = rest.search(nextHeading);
	return (end === -1 ? rest : rest.slice(0, end)).split("\n");
}
