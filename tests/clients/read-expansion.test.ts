import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { tryExpandRead } from "../../clients/read-expansion.ts";
import { setupTestEnvironment } from "./test-utils.js";

function node(
	type: string,
	startRow: number,
	endRow: number,
	children: any[] = [],
	text = type,
) {
	return {
		type,
		text,
		children,
		startPosition: { row: startRow, column: 0 },
		endPosition: { row: endRow, column: 0 },
	};
}

describe("tryExpandRead", () => {
	it("expands when the requested offset is inside a symbol", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5\nline6\n");
			const tree = {
				rootNode: node("program", 0, 5, [
					node("function_declaration", 1, 4, [
						node("identifier", 1, 1, [], "demo"),
					]),
				]),
			};
			const tsClient = {
				init: async () => true,
				parseFile: async () => tree,
			};

			const result = await tryExpandRead(filePath, 3, 1, 6, tsClient as any);
			expect(result).toMatchObject({
				newOffset: 2,
				newLimit: 4,
				enclosingSymbol: {
					name: "demo",
					kind: "function_declaration",
					startLine: 2,
					endLine: 5,
				},
			});
		} finally {
			env.cleanup();
		}
	});

	it("expands overlapping reads without dropping originally requested lines", async () => {
		const env = setupTestEnvironment("pi-lens-read-expansion-overlap-");
		try {
			const filePath = path.join(env.tmpDir, "file.ts");
			fs.writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5\nline6\n");
			const tree = {
				rootNode: node("program", 0, 5, [
					node("function_declaration", 2, 4, [
						node("identifier", 2, 2, [], "demo"),
					]),
				]),
			};
			const tsClient = {
				init: async () => true,
				parseFile: async () => tree,
			};

			const result = await tryExpandRead(filePath, 2, 2, 6, tsClient as any);
			expect(result).toMatchObject({
				newOffset: 2,
				newLimit: 4,
				enclosingSymbol: {
					name: "demo",
					kind: "function_declaration",
					startLine: 3,
					endLine: 5,
				},
			});
		} finally {
			env.cleanup();
		}
	});
});
