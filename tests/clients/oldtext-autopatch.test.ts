import { describe, expect, it } from "vitest";
import {
	computeTrailingWhitespaceOldTextPatch,
	stripTrailingWhitespaceDetailed,
} from "../../clients/oldtext-autopatch.js";

describe("oldText trailing whitespace autopatch", () => {
	it("does not patch when the original raw oldText already matches", () => {
		const fileContent = "foo\n\nbar\n";
		const patch = computeTrailingWhitespaceOldTextPatch({
			oldText: "foo\n\n",
			newText: "baz\n\n",
			fileContent,
		});
		expect(patch).toBeUndefined();
	});

	it("requires the stripped raw candidate to match exactly once", () => {
		const fileContent = "foo\nfoo\n";
		const patch = computeTrailingWhitespaceOldTextPatch({
			oldText: "foo   ",
			newText: "bar",
			fileContent,
		});
		expect(patch).toBeUndefined();
	});

	it("distinguishes line trailing whitespace from trailing empty lines", () => {
		const stripped = stripTrailingWhitespaceDetailed("foo   \nbar\n\t\t");
		expect(stripped).toEqual({
			text: "foo\nbar",
			removedLineTrailingWhitespace: true,
			removedTrailingEmptyLineCount: 1,
		});
	});

	it("patches trailing spaces when original misses and stripped form is unique", () => {
		const patch = computeTrailingWhitespaceOldTextPatch({
			oldText: "foo   ",
			newText: "bar   ",
			fileContent: "foo\n",
		});
		expect(patch).toMatchObject({
			oldText: "foo",
			newText: "bar   ",
			removedLineTrailingWhitespace: true,
			removedTrailingEmptyLineCount: 0,
		});
	});

	it("strips an equivalent trailing empty-line suffix from newText", () => {
		const patch = computeTrailingWhitespaceOldTextPatch({
			oldText: "foo\n\n",
			newText: "baz\n\n",
			fileContent: "foo\nbar\n",
		});
		expect(patch).toMatchObject({
			oldText: "foo",
			newText: "baz",
			removedTrailingEmptyLineCount: 2,
		});
	});

	it("normalizes CRLF before exact raw matching", () => {
		const patch = computeTrailingWhitespaceOldTextPatch({
			oldText: "foo\r\n\t",
			newText: "bar\r\n\t",
			fileContent: "foo\r\nnext\r\n",
		});
		expect(patch?.oldText).toBe("foo");
		expect(patch?.newText).toBe("bar");
	});
});
