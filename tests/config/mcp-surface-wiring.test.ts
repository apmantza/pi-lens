import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

function constructionNames(source: string): Set<string> {
	const start = source.indexOf("const toolsToRegister = [");
	const end = source.indexOf("for (const tool", start);
	const block = source.slice(start, end);
	return new Set(
		[...block.matchAll(/create([A-Za-z0-9]+)Tool\s*\(/g)].map(
			(match) => match[1],
		),
	);
}

describe("MCP and pi tool construction stay wired to sibling surfaces (#2864)", () => {
	it("keeps the MCP construction block aligned with the pi sibling", () => {
		const pi = fs.readFileSync(path.join(ROOT, "index.ts"), "utf8");
		const mcp = fs.readFileSync(path.join(ROOT, "mcp/server.ts"), "utf8");
		// Ignore comments and strings so the scan checks executable construction,
		// not documentation examples or a commented-out registration.
		const blank = (source: string) =>
			source
				.replace(/\/\/[^\n]*/g, "")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/(['\"])(?:\\.|(?!\1)[^\\])*\1/g, "\"\"");
			expect(constructionNames(blank(pi))).toEqual(
			constructionNames(blank(mcp)),
		);
	});
});
