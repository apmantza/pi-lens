import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";
import { removeTempDirSync } from "./test-utils.js";

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
		removeTempDirSync(dir);
	}
});

describe("slop detection rules", () => {
	describe("python-hallucinated-import", () => {
		it("flags JSONResponse imported from requests", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile(
				"py",
				`from requests import JSONResponse\n`,
			);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags Depends imported from flask", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from flask import Depends\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags json.parse (JavaScript idiom)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from json import parse\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags dataclass imported from typing", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from typing import dataclass\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag correct dataclass import", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile(
				"py",
				`from dataclasses import dataclass\n`,
			);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBe(0);
		});

		it("does not flag correct fastapi import", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile("py", `from fastapi import Depends\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBe(0);
		});

		it("does not flag valid SQLAlchemy imports", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-hallucinated-import");
			const filePath = writeTempFile(
				"py",
				`from sqlalchemy import Integer\nfrom sqlalchemy import String\nfrom sqlalchemy import Uuid\nfrom sqlalchemy.dialects.postgresql import JSONB\nfrom sqlalchemy.dialects.postgresql import UUID\n`,
			);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches).toHaveLength(0);
		});
	});

	describe("python-cross-language-method", () => {
		it("flags .push() on a list", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `items.push(x)\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags .equals() (Java idiom)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `name.equals("foo")\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags .forEach() (JavaScript idiom)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile(
				"py",
				`items.forEach(lambda x: print(x))\n`,
			);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags .isEmpty() (Java idiom)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `if s.isEmpty(): pass\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag .append() (correct Python)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `items.append(x)\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches.length).toBe(0);
		});

		it("does not flag Python-valid SQLAlchemy Select.select()", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("python-cross-language-method");
			const filePath = writeTempFile("py", `statement.select()\n`);
			const matches = await client.runQueryOnFile(query, filePath, "python");
			expect(matches).toHaveLength(0);
		});
	});

	describe("ts-hallucinated-react-import", () => {
		it("flags useRouter imported from react", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile(
				"ts",
				`import { useRouter } from 'react';\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags Link imported from react", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile(
				"ts",
				`import { Link, Image } from 'react';\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags getServerSideProps imported from react", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile(
				"ts",
				`import { getServerSideProps } from 'react';\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag useState imported from react", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile(
				"ts",
				`import { useState, useEffect } from 'react';\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});

		it("does not flag useRouter from next/navigation", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-hallucinated-react-import");
			const filePath = writeTempFile(
				"ts",
				`import { useRouter } from 'next/navigation';\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});
	});

	describe("ts-react-antipatterns", () => {
		// #5466: the rule fires only in React context — a module importing a
		// React/React-like hook source, or containing JSX. A plain module's
		// `setFoo` loop stays silent, and prose mentioning react is not
		// context (the gate is structural).
		it("flags setState inside a for-of loop in a module that imports React", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile(
				"ts",
				`import { useState } from "react";\nfor (const item of items) {\n  setCount(count + 1);\n}\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags setState inside a while loop in a module that imports a React-like hook source", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile(
				"ts",
				`import { useState } from "preact/hooks";\nwhile (i < items.length) {\n  setItems([...items, i]);\n  i++;\n}\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		// #5466 review: the gate is SOURCE-keyed. A `use*` name from a
		// non-React module is not React context — an unrelated use* API must
		// not open the gate.
		it("does not flag a use* hook import from a non-React source", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile(
				"ts",
				`import { useStore } from "zustand";\nwhile (i < items.length) {\n  setItems([...items, i]);\n  i++;\n}\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});

		it("flags setState inside a loop in a JSX module", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile(
				"tsx",
				`const view = <div className="c">{items.length}</div>;\nfor (const item of items) {\n  setCount(count + 1);\n}\n`,
			);
			const matches = await client.runQueryOnFile(query, filePath, "tsx");
			expect(matches.length).toBeGreaterThan(0);
		});

		// #5466 red-first cell (red pre-fix): a plain module's setFoo loop.
		it("does not flag a setFoo loop in a plain TypeScript module", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile(
				"ts",
				`for (const item of items) {\n  setRows(rows + 1);\n}\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});

		// #5466 mutation guard: react as prose (comment, string, identifier)
		// is not import/JSX context — a text-based gate reds this.
		it("does not flag a setFoo loop when react appears only as prose", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile(
				"ts",
				`// react setState helper\nconst reactSetState = 1;\nwhile (i < items.length) {\n  setItems([...items, i]);\n  i++;\n}\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});

		// #5466 leak regression (parent scan: 18→6): a large plain module must
		// be judged like any other file. The gate has no size cap. A size-capped
		// fail-open keeps findings on modules past its cap, so a cap under the
		// 4000-statement filler below reds this case.
		it("does not flag a setFoo loop in a large plain module", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-react-antipatterns");
			const filler = Array.from(
				{ length: 4000 },
				(_, i) => `const v${i} = ${i};`,
			).join("\n");
			const filePath = writeTempFile(
				"ts",
				`${filler}\nfor (const item of items) {\n  setRows(rows + 1);\n}\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});

		it("does not flag setState outside a loop", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile(
				"ts",
				`import { useState } from "react";\nsetCount(items.length);\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});

		it("does not flag setTimeout inside a loop", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile(
				"ts",
				`import { useState } from "react";\nwhile (writing) { await new Promise(r => setTimeout(r, 10)); }`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});

		it("does not flag setInterval inside a for loop", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-react-antipatterns");
			const filePath = writeTempFile(
				"ts",
				`import { useState } from "react";\nfor (const x of items) { setInterval(() => {}, 100); }`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});
	});

	describe("unsafe-regex", () => {
		it("is advisory rather than blocking", async () => {
			const query = await getQuery("unsafe-regex");
			expect(query.severity).toBe("warning");
			expect(query.inline_tier).toBe("warning");
		});

		it("does not flag an escaped identifier initialized through map", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("unsafe-regex");
			const filePath = writeTempFile(
				"ts",
				`const alternation = markers.map((m) => escapeRegExp(m).replace(/\\\\s+/g, "\\\\s+")).join("|");
				const r = new RegExp(\`\\\\b(\${alternation})\\\\b\`, "gi");`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches).toHaveLength(0);
		});

		it("suppresses when the declarator has a type annotation (value field, not positional)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("unsafe-regex");
			const filePath = writeTempFile(
				"ts",
				`const alternation: string = markers.map((m) => escapeRegExp(m)).join("|");
				const r = new RegExp(\`\b(\${alternation})\b\`, "gi");`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches).toHaveLength(0);
		});

		it("still flags when the identifier is reassigned to user input after escaping", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("unsafe-regex");
			const filePath = writeTempFile(
				"ts",
				`let alternation = escapeRegExp(seed);
				alternation = req.query.q;
				const r = new RegExp(\`\${alternation}\`, "gi");`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("still flags when the only same-named safe declaration comes after the use", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("unsafe-regex");
			const filePath = writeTempFile(
				"ts",
				`function build(pat: string) { return new RegExp(\`\${pat}\`); }
				const pat = escapeRegExp(seed);`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not treat a plain string replace as escaping", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("unsafe-regex");
			const filePath = writeTempFile(
				"ts",
				`const pat = userInput.replace("a", "b");
				const r = new RegExp(\`\${pat}\`);`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags new RegExp with plain user-input interpolation", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("unsafe-regex");
			const filePath = writeTempFile(
				"ts",
				"const r = new RegExp(`\\\\b${userInput}\\\\b`, 'gi');",
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag new RegExp when interpolation uses escapeRegExp", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("unsafe-regex");
			const filePath = writeTempFile(
				"ts",
				"const r = new RegExp(`^${escapeRegExp(sep)}$`);",
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});

		it("does not flag new RegExp when variable is named 'escaped'", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("unsafe-regex");
			const filePath = writeTempFile(
				"ts",
				"const r = new RegExp(`^${escaped}$`, 'i');",
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});

		it("does not flag new RegExp when interpolation uses .replace() chain (glob-to-regex pattern)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("unsafe-regex");
			const filePath = writeTempFile(
				"ts",
				"const r = new RegExp(`^${pat.replace(/\\./g, '\\\\.').replace(/\\*/g, '.*')}$`);",
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});
	});

	describe("long-parameter-list", () => {
		it("flags a function with 6 required parameters", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("long-parameter-list");
			const filePath = writeTempFile(
				"ts",
				`function makeD(id: string, rule: string, filePath: string, line: number, col: number, message: string) {}`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag a function with 4 required + 2 optional parameters", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("long-parameter-list");
			const filePath = writeTempFile(
				"ts",
				`function open(state: S, file: string, content: string, lang: string, preserveDiags?: boolean, silent?: boolean): void {}`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});

		it("does not flag a function with 4 required + 2 defaulted parameters", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("long-parameter-list");
			const filePath = writeTempFile(
				"ts",
				`function create(path: string, cwd: string, api: API, facts: F, blocking = false, ranges = []) {}`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});
	});

	describe("ts-xss-dom-sink", () => {
		it("flags innerHTML = variable", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-xss-dom-sink");
			const filePath = writeTempFile("ts", `el.innerHTML = userInput;\n`);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags outerHTML = call expression", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-xss-dom-sink");
			const filePath = writeTempFile("ts", `el.outerHTML = getData();\n`);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags document.write(variable)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-xss-dom-sink");
			const filePath = writeTempFile("ts", `document.write(content);\n`);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag innerHTML = string literal", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-xss-dom-sink");
			const filePath = writeTempFile("ts", `el.innerHTML = "<b>safe</b>";\n`);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});

		it("does not flag textContent = variable (safe API)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-xss-dom-sink");
			const filePath = writeTempFile("ts", `el.textContent = userInput;\n`);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});
	});

	describe("ts-dynamic-require", () => {
		it("flags require(identifier)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-dynamic-require");
			const filePath = writeTempFile(
				"ts",
				`const mod = require(pluginName);\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags require(member expression)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-dynamic-require");
			const filePath = writeTempFile(
				"ts",
				`const lib = require(config.libPath);\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag require(string literal)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-dynamic-require");
			const filePath = writeTempFile("ts", `const mod = require("./utils");\n`);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});
	});

	describe("ts-open-redirect", () => {
		it("flags res.redirect(variable)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-open-redirect");
			const filePath = writeTempFile(
				"ts",
				`res.redirect(req.query.returnUrl);\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags response.redirect(call expression)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-open-redirect");
			const filePath = writeTempFile(
				"ts",
				`response.redirect(getRedirectUrl());\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags window.location.href = variable", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-open-redirect");
			const filePath = writeTempFile(
				"ts",
				`window.location.href = userInput;\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag res.redirect(string literal)", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-open-redirect");
			const filePath = writeTempFile("ts", `res.redirect("/home");\n`);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});
	});

	describe("ts-nosql-injection", () => {
		it("flags $where with unquoted key", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-nosql-injection");
			const filePath = writeTempFile(
				"ts",
				`db.users.find({ $where: "this.name == '" + name + "'" });\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("flags $where with quoted key", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-nosql-injection");
			const filePath = writeTempFile(
				"ts",
				`collection.find({ "$where": \`this.credits > 0\` });\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBeGreaterThan(0);
		});

		it("does not flag safe MongoDB equality query", async () => {
			const client = getSharedTreeSitterClient()!;
			const query = await getQuery("ts-nosql-injection");
			const filePath = writeTempFile(
				"ts",
				`db.users.find({ name: userName, active: true });\n`,
			);
			const matches = await client.runQueryOnFile(
				query,
				filePath,
				"typescript",
			);
			expect(matches.length).toBe(0);
		});
	});
});
