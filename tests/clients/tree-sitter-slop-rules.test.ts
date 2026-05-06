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
			const client = await TreeSitterClient.create();
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from requests import JSONResponse\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags Depends imported from flask", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from flask import Depends\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags json.parse (JavaScript idiom)", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from json import parse\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags dataclass imported from typing", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from typing import dataclass\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag correct dataclass import", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from dataclasses import dataclass\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBe(0);
		});

		it("does not flag correct fastapi import", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from fastapi import Depends\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBe(0);
		});
	});

	describe("python-cross-language-method", () => {
		it("flags .push() on a list", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `items.push(x)\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags .equals() (Java idiom)", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `name.equals("foo")\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags .forEach() (JavaScript idiom)", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `items.forEach(lambda x: print(x))\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags .isEmpty() (Java idiom)", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `if s.isEmpty(): pass\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag .append() (correct Python)", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `items.append(x)\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBe(0);
		});
	});

	describe("ts-hallucinated-react-import", () => {
		it("flags useRouter imported from react", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile("ts", `import { useRouter } from 'react';\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags Link imported from react", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile("ts", `import { Link, Image } from 'react';\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags getServerSideProps imported from react", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile("ts", `import { getServerSideProps } from 'react';\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag useState imported from react", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile("ts", `import { useState, useEffect } from 'react';\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBe(0);
		});

		it("does not flag useRouter from next/navigation", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile("ts", `import { useRouter } from 'next/navigation';\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBe(0);
		});
	});

	describe("ts-react-antipatterns", () => {
		it("flags setState inside a for-of loop", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile("ts", `for (const item of items) {\n  setCount(count + 1);\n}\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags setState inside a while loop", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile("ts", `while (i < items.length) {\n  setItems([...items, i]);\n  i++;\n}\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag setState outside a loop", async () => {
			const client = await TreeSitterClient.create();
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile("ts", `setCount(items.length);\n`);
			const matches = await client.runQueryOnFile(query, filePath, "typescript");
			expect(matches.length).toBe(0);
		});
	});
});
