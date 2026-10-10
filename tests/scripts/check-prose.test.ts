import { describe, expect, it } from "vitest";
import { checkProse } from "../../scripts/check-prose.mjs";
import { lintPrBody } from "../../scripts/check-pr-body.mjs";

describe("checkProse", () => {
	it("blocks the long sentence from the #4274 comment", () => {
		const result = checkProse(
			"The harness derives repoRoot from import.meta.url, and its sibling worktree case uses two scratch projects, not git worktree add, while the surrounding selection runs many files concurrently and makes the timing-sensitive case fail only under contention.",
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("sentence-length");
	});

	it("accepts clean prose and reports passive voice as a warning", () => {
		const result = checkProse("Run the focused test. Read the result.");
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
		const passive = checkProse("The result was recorded.");
		expect(passive.valid).toBe(true);
		expect(passive.warnings.join(" ")).toContain("passive-voice");
	});

	it("does not count code, URLs, tables, blockquotes, or log lines", () => {
		const text = [
			"```text",
			"This line contains far more than thirty ordinary words and must remain ignored because it is a transcript or code block that users paste for evidence while reviewing a change in CI.",
			"```",
			"https://example.com/a/very-long-url-that-is-not-prose",
			"> This quoted line contains far more than thirty words and must remain ignored.",
			"FAIL This log line contains far more than thirty words and must remain ignored.",
			"| A | This table cell contains far more than thirty words and must remain ignored. |",
		].join("\n");
		expect(checkProse(text)).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("blocks please and downgrades it in warn mode", () => {
		const result = checkProse("Please do the requested check.");
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain('remove "please"');
		const warning = checkProse("Please do the requested check.", {
			mode: "warn",
		});
		expect(warning).toMatchObject({ valid: true, errors: [] });
		expect(warning.warnings.join(" ")).toContain('remove "please"');
	});

	it("ignores comments, generated footers, and trailing metadata", () => {
		const long =
			"This generated metadata contains enough ordinary words to exceed the prose limit and must remain ignored when the checker reads a body supplied by a hosting service.";
		const text = [
			"<!--",
			long,
			"-->",
			long.replace("generated metadata", "footer metadata"),
			"🤖 Generated with [Claude Code](https://claude.com/claude-code)",
			"Co-Authored-By: Example <example@example.com>",
			"Signed-off-by: Example <example@example.com>",
			"Refs: #4280",
			"Closes: #4280",
		].join("\n");
		expect(checkProse(text)).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("keeps abbreviations, paths, versions, and list items stable", () => {
		const result = checkProse(
			"- Handle e.g. scripts/check-prose.mjs and version 1.2.3.\n- Run the clean test.",
		);
		expect(result.valid).toBe(true);
	});

	it("splits ordered and unordered list items into sentences", () => {
		const item =
			"3. **Warn:** a retired glossary term in prose. Read the retired terms from the AGENTS.md glossary at run time, so the list never drifts. The glossary sweep test already parses that source. Warn only, because several retirements depend on context.";
		expect(checkProse(item)).toEqual({ valid: true, errors: [], warnings: [] });
		expect(
			checkProse(
				"- This deliberately has enough ordinary words to exceed the prose limit because it never reaches a terminal sentence boundary and must remain one sentence while the checker preserves this unbroken paragraph for its length guard.",
			).errors.join(" "),
		).toContain("sentence-length");
	});

	it("can downgrade blocking findings in warn mode", () => {
		const result = checkProse("Please simply do this.", { mode: "warn" });
		expect(result).toMatchObject({ valid: true, errors: [] });
		expect(result.warnings.join(" ")).toContain("filler");
	});

	it("applies the checker to PR prose sections only", () => {
		const long =
			"This sentence has enough ordinary words to exceed the prose limit and should fail when it appears in a Summary section because the PR body gate checks that section during every local and CI validation run.";
		const body = `## Why\nShort reason.\n\n## Notes for the reviewer\nShort note.\n\n## Summary\n${long}\n\n## Tests\n\`\`\`text\n${long}\n\`\`\`\n\n## Blast radius\nNone.\n\n## Class sweep\nDone.\n\n## Observability\nRecorded.`;
		expect(lintPrBody(body, { workingTree: true }).errors.join(" ")).toContain(
			"sentence-length",
		);
		expect(
			lintPrBody(body, { proseMode: "warn" }).errors.join(" "),
		).not.toContain("sentence-length");
	});
});
