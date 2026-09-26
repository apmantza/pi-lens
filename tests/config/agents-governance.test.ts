import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stripSource } from "../support/sweep-kit.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

function agentsText(): string {
	return fs.readFileSync(
		process.env.PI_LENS_AGENTS_PATH ?? path.join(REPO_ROOT, "AGENTS.md"),
		"utf8",
	);
}

function blankMarkdown(text: string): string {
	const blank = (value: string): string => value.replace(/[^\n]/g, " ");
	return text
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, blank);
}

function shapeNumbers(text: string): number[] {
	const source = stripSource(blankMarkdown(text), { strings: "blank" });
	return [...source.matchAll(/^(\d+)\. \*\*/gm)].map((match) =>
		Number(match[1]),
	);
}

describe("AGENTS.md trigger-block governance (#3259)", () => {
	it("keeps every trigger marker standalone and paired (#3265)", () => {
		const text = agentsText();
		const literalOpenings = [...text.matchAll(/<important if=/g)].length;
		const anchoredOpenings = [...text.matchAll(/^<important if="[^"]*">$/gm)]
			.length;
		const anchoredClosings = [...text.matchAll(/^<\/important>$/gm)].length;
		expect(literalOpenings).toBe(anchoredOpenings);
		expect(anchoredOpenings).toBe(anchoredClosings);
	});

	it("gives every important block one unique non-empty trigger", () => {
		const triggers = [
			...agentsText().matchAll(/^<important if="([^"]*)">$/gm),
		].map((match) => match[1].trim());
		expect(triggers.length).toBeGreaterThan(0);
		expect(triggers.every(Boolean)).toBe(true);
		expect(new Set(triggers).size).toBe(triggers.length);
	});

	it("keeps every numbered defect shape exactly once", () => {
		const numbers = shapeNumbers(agentsText());
		expect(numbers).toHaveLength(55);
		expect(new Set(numbers).size).toBe(55);
		expect(numbers.sort((a, b) => a - b)).toEqual(
			Array.from({ length: 55 }, (_, index) => index + 1),
		);
	});

	it("does not count a counterfeit shape hidden in an HTML comment (#3265)", () => {
		// Prevents a comment counterfeit from replacing a real catalog member.
		const counterfeit = agentsText()
			.replace(/^1\. \*\*.*$/m, "")
			.concat("\n<!--\n1. **Counterfeit shape:** hidden comment\n-->\n");
		expect(shapeNumbers(counterfeit)).toHaveLength(54);
		expect(shapeNumbers(counterfeit)).not.toContain(1);
	});
});
