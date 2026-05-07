import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";

const tmpDirs: string[] = [];

function writeTempFile(ext: string, contents: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-slop-"));
	tmpDirs.push(dir);
	const filePath = path.join(dir, `sample.${ext}`);
	fs.writeFileSync(filePath, contents, "utf-8");
	return filePath;
}

async function getQuery(id: string) {
	const loader = new TreeSitterQueryLoader();
	const queries = await loader.loadQueries(process.cwd());
	for (const langQueries of queries.values()) {
		const found = langQueries.find((q) => q.id === id);
		if (found) return found;
	}
	throw new Error(`missing query ${id}`);
}

afterAll(() => {
	for (const dir of tmpDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("slop detection rules", () => {
	describe("python-hallucinated-import", () => {
		it("flags JSONResponse imported from requests", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from requests import JSONResponse\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags Depends imported from flask", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from flask import Depends\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags json.parse (JavaScript idiom)", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from json import parse\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags dataclass imported from typing", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from typing import dataclass\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag correct dataclass import", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from dataclasses import dataclass\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBe(0);
		});

		it("does not flag correct fastapi import", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from fastapi import Depends\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBe(0);
		});
	});

	describe("python-cross-language-method", () => {
		it("flags .push() on a list", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `items.push(x)\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags .equals() (Java idiom)", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `name.equals("foo")\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags .forEach() (JavaScript idiom)", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `items.forEach(lambda x: print(x))\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags .isEmpty() (Java idiom)", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `if s.isEmpty(): pass\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag .append() (correct Python)", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `items.append(x)\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBe(0);
		});
	});

	describe("ts-hallucinated-react-import", () => {
		it("flags useRouter imported from react", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile("ts", `import { useRouter } from 'react';\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags Link imported from react", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile("ts", `import { Link, Image } from 'react';\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags getServerSideProps imported from react", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile("ts", `import { getServerSideProps } from 'react';\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag useState imported from react", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile("ts", `import { useState, useEffect } from 'react';\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBe(0);
		});

		it("does not flag useRouter from next/navigation", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile("ts", `import { useRouter } from 'next/navigation';\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBe(0);
		});
	});

	describe("ts-react-antipatterns", () => {
		it("flags setState inside a for-of loop", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile("ts", `for (const item of items) {\n  setCount(count + 1);\n}\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags setState inside a while loop", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile("ts", `while (i < items.length) {\n  setItems([...items, i]);\n  i++;\n}\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag setState outside a loop", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile("ts", `setCount(items.length);\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBe(0);
		});

		it("does not flag setTimeout inside a loop", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile(
				"ts",
				`while (writing) { await new Promise(r => setTimeout(r, 10)); }`,
			);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBe(0);
		});

		it("does not flag setInterval inside a for loop", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile(
				"ts",
				`for (const x of items) { setInterval(() => {}, 100); }`,
			);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBe(0);
		});
	});

	describe("unsafe-regex", () => {
		it("flags new RegExp with plain user-input interpolation", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("unsafe-regex");
			const filePath = writeTempFile(
				"ts",
				"const r = new RegExp(`\\\\b${userInput}\\\\b`, 'gi');",
			);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag new RegExp when interpolation uses escapeRegExp", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("unsafe-regex");
			const filePath = writeTempFile(
				"ts",
				"const r = new RegExp(`^${escapeRegExp(sep)}$`);",
			);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBe(0);
		});

		it("does not flag new RegExp when variable is named 'escaped'", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("unsafe-regex");
			const filePath = writeTempFile(
				"ts",
				"const r = new RegExp(`^${escaped}$`, 'i');",
			);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBe(0);
		});

		it("does not flag new RegExp when interpolation uses .replace() chain (glob-to-regex pattern)", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("unsafe-regex");
			const filePath = writeTempFile(
				"ts",
				"const r = new RegExp(`^${pat.replace(/\\./g, '\\\\.').replace(/\\*/g, '.*')}$`);",
			);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBe(0);
		});
	});

	describe("long-parameter-list", () => {
		it("flags a function with 6 required parameters", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("long-parameter-list");
			const filePath = writeTempFile(
				"ts",
				`function makeD(id: string, rule: string, filePath: string, line: number, col: number, message: string) {}`,
			);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag a function with 4 required + 2 optional parameters", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("long-parameter-list");
			const filePath = writeTempFile(
				"ts",
				`function open(state: S, file: string, content: string, lang: string, preserveDiags?: boolean, silent?: boolean): void {}`,
			);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBe(0);
		});

		it("does not flag a function with 4 required + 2 defaulted parameters", async () => {
			const client = new TreeSitterClient();
			const query = await getQuery("long-parameter-list");
			const filePath = writeTempFile(
				"ts",
				`function create(path: string, cwd: string, api: API, facts: F, blocking = false, ranges = []) {}`,
			);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBe(0);
		});
	});
});
