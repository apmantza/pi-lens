import { describe, expect, it } from "vitest";
import {
	closeKeywordPlacementMessage,
	lintCloseKeywordPlacement,
} from "../../scripts/check-close-keywords.mjs";

describe("close-keyword placement (#2640)", () => {
	it("rejects the #2610 incident pair", () => {
		const result = lintCloseKeywordPlacement(
			'test: rename legacy "should" test names to behavior statements (closes #2602)',
			"Summary: rename legacy should test names to behavior statements.",
		);
		expect(result).toMatchObject({ valid: false, missingBodyIssues: [2602] });
	});

	it("accepts the incident after adding the body keyword", () => {
		expect(
			lintCloseKeywordPlacement(
				'test: rename legacy "should" test names to behavior statements (closes #2602)',
				"Summary: rename legacy should test names to behavior statements.\n\nCloses #2602.",
			).valid,
		).toBe(true);
	});

	it("does not require a body keyword for a title without a close keyword", () => {
		expect(
			lintCloseKeywordPlacement(
				"fix(build): isolate build:dist's tsc npx spawn like esbuild's (#2593)",
				"Use `closes #2593` only as an example.",
			),
		).toMatchObject({ valid: true, titleIssues: [] });
		expect(
			lintCloseKeywordPlacement(
				"refactor: preserve merge-train behavior (refs #2591)",
				"",
			),
		).toMatchObject({ valid: true, titleIssues: [] });
	});

	it("accepts a body keyword matching a title reference", () => {
		expect(
			lintCloseKeywordPlacement(
				"fix: address build issue (refs #2604)",
				"Closes #2604.",
			),
		).toMatchObject({ valid: true, titleIssues: [] });
	});

	it("reports each title issue missing from the body", () => {
		expect(
			lintCloseKeywordPlacement("fixes #1 and resolves #2", "Closes #1."),
		).toMatchObject({ valid: false, missingBodyIssues: [2] });
	});

	it("handles supported syntax and word boundaries", () => {
		expect(lintCloseKeywordPlacement("FIXES: #7", "").valid).toBe(false);
		expect(lintCloseKeywordPlacement("resolved #7", "").valid).toBe(false);
		expect(lintCloseKeywordPlacement("discloses #1", "").valid).toBe(true);
	});

	it("scans title code formatting as GitHub does", () => {
		expect(
			lintCloseKeywordPlacement("docs: how `closes #1` works", ""),
		).toMatchObject({
			valid: false,
			missingBodyIssues: [1],
		});
	});

	it("explains the platform rule and every repair", () => {
		const message = closeKeywordPlacementMessage([2602, 2604]);
		expect(message).toContain(
			"GitHub only honours closing keywords in the PR body, never in the title",
		);
		expect(message).toContain("#2602");
		expect(message).toContain("Closes #2602.");
		expect(message).toContain("refs #2602");
		expect(message).toContain("#2604");
	});
});
