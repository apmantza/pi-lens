import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { removeTempDirSync } from "./test-utils.js";

const tmpDirs: string[] = [];

async function count(
	id: string,
	extension: string,
	language: string,
	source: string,
): Promise<number> {
	const loader = new TreeSitterQueryLoader();
	const queries = await loader.loadQueries(process.cwd());
	const query = [...queries.values()]
		.flat()
		.find((candidate) => candidate.id === id);
	if (!query) throw new Error(`missing query ${id}`);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-879-"));
	tmpDirs.push(dir);
	const file = path.join(dir, `sample.${extension}`);
	fs.writeFileSync(file, source);
	const client = getSharedTreeSitterClient();
	if (!client) throw new Error("shared TreeSitterClient unavailable");
	return (await client.runQueryOnFile(query, file, language)).length;
}

afterAll(() => {
	for (const dir of tmpDirs) removeTempDirSync(dir);
});

describe("post-filter repairs (#879)", () => {
	it("has an implementation for every shipped post_filter reference", () => {
		const source = fs.readFileSync(
			path.join(process.cwd(), "clients", "tree-sitter-client.ts"),
			"utf8",
		);
		const implemented = new Set(
			[...source.matchAll(/case\s+"([^"]+)"\s*:/g)].map((match) => match[1]),
		);
		const ruleRoot = path.join(process.cwd(), "rules", "tree-sitter-queries");
		const pending = [ruleRoot];
		const unknown: string[] = [];
		while (pending.length > 0) {
			const directory = pending.pop();
			if (!directory) break;
			for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
				const file = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					pending.push(file);
					continue;
				}
				if (!entry.name.endsWith(".yml")) continue;
				const match = fs
					.readFileSync(file, "utf8")
					.match(/^post_filter:\s*["']?([^\s"'#]+)/m);
				if (match && !implemented.has(match[1])) {
					unknown.push(`${path.relative(ruleRoot, file)}: ${match[1]}`);
				}
			}
		}
		expect(unknown.sort()).toEqual([]);
	});

	it("keeps only Java field/method names that differ by case", async () => {
		expect(
			await count(
				"name-capitalization-conflict",
				"java",
				"java",
				"class C { int value; int Value() { return value; } }",
			),
		).toBeGreaterThan(0);
		expect(
			await count(
				"name-capitalization-conflict",
				"java",
				"java",
				"class C { int value; int getValue() { return value; } }",
			),
		).toBe(0);
	});

	it("keeps Spring scan annotations only in the default package", async () => {
		const body = "@SpringBootApplication class App {}";
		expect(
			await count("springboot-default-package", "java", "java", body),
		).toBe(1);
		expect(
			await count(
				"springboot-default-package",
				"java",
				"java",
				`package com.example; ${body}`,
			),
		).toBe(0);
	});

	it("keeps file-like send_file calls missing both identifying keywords", async () => {
		expect(
			await count("send-file-mimetype", "py", "python", "send_file(file_obj)"),
		).toBe(1);
		expect(
			await count(
				"send-file-mimetype",
				"py",
				"python",
				"send_file(file_obj, mimetype='text/plain')\nsend_file('report.pdf')",
			),
		).toBe(0);
	});

	it("keeps overridden JUnit lifecycle methods missing the matching super call", async () => {
		expect(
			await count(
				"junit-call-super",
				"java",
				"java",
				"class T { @Override protected void setUp() { prepare(); } }",
			),
		).toBe(1);
		expect(
			await count(
				"junit-call-super",
				"java",
				"java",
				"class T { @Override protected void setUp() { super.setUp(); } }",
			),
		).toBe(0);
	});

	it("recognizes assertion and verification calls in Java tests", async () => {
		expect(
			await count(
				"tests-include-assertions",
				"java",
				"java",
				"class T { @Test void emptyTest() { run(); } }",
			),
		).toBe(1);
		expect(
			await count(
				"tests-include-assertions",
				"java",
				"java",
				"class T { @Test void checked() { verify(service).run(); } }",
			),
		).toBe(0);
	});

	it("recognizes explicit resource closure", async () => {
		expect(
			await count(
				"resources-closed",
				"java",
				"java",
				"class T { void f() { InputStream in = open(); use(in); } }",
			),
		).toBe(1);
		expect(
			await count(
				"resources-closed",
				"java",
				"java",
				"class T { void f() { InputStream in = open(); in.close(); } }",
			),
		).toBe(0);
	});

	// refs #1089 P2: `\b` inside a template literal is the BACKSPACE control
	// char, not a regex word-boundary escape, so the `resource` node text
	// probe below could never match — every Java 9 `try (x)` short-form
	// try-with-resources was flagged "not closed" even though it IS closed
	// (auto-closed at the end of the try block). Only an explicit `.close()`
	// call (covered by the test above) suppressed the finding.
	it("recognizes Java 9 short-form try-with-resources as closing the resource", async () => {
		expect(
			await count(
				"resources-closed",
				"java",
				"java",
				"class T { void f() { InputStream in = open(); try (in) { use(in); } } }",
			),
		).toBe(0);
	});

	it("keeps direct self-recursion only when no conditional base case exists", async () => {
		expect(
			await count(
				"infinite-recursion",
				"java",
				"java",
				"class T { int f() { return f(); } }",
			),
		).toBe(1);
		expect(
			await count(
				"infinite-recursion",
				"java",
				"java",
				"class T { int f(int n) { if (n == 0) return 0; return f(n - 1); } }",
			),
		).toBe(0);
	});

	it("keeps zeroing memset calls only for sensitive-looking destinations", async () => {
		expect(
			await count(
				"no-memset-sensitive-data",
				"cpp",
				"cpp",
				"void f() { char password[32]; memset(password, 0, sizeof(password)); }",
			),
		).toBe(1);
		expect(
			await count(
				"no-memset-sensitive-data",
				"cpp",
				"cpp",
				"void f() { char buffer[32]; memset(buffer, 0, sizeof(buffer)); }",
			),
		).toBe(0);
	});

	it("uses query predicates for __init__ values and JDBC index zero", async () => {
		expect(
			await count(
				"return-in-init",
				"py",
				"python",
				"class C:\n def __init__(self):\n  return self",
			),
		).toBe(1);
		expect(
			await count(
				"return-in-init",
				"py",
				"python",
				"class C:\n def other(self):\n  return self",
			),
		).toBe(0);
		expect(
			await count(
				"prepared-statement-valid-indices",
				"java",
				"java",
				"class T { void f() { stmt.setInt(0, value); stmt.setInt(1, value); } }",
			),
		).toBe(1);
	});

	it("keeps hallucinated-import pairs exact", async () => {
		const cases: Array<[string, number]> = [
			["from requests import JSONResponse", 1],
			["from requests import Session", 1],
			["from sqlalchemy import JSONResponse", 1],
			["from sqlalchemy import Session", 0],
		];
		for (const [source, expected] of cases) {
			expect(
				await count("python-hallucinated-import", "py", "python", source),
			).toBe(expected);
		}
	});

	it("flags only true bare except, not dotted/qualified exception types", async () => {
		// Qualified/dotted exception types (e.g. `asyncio.TimeoutError`) parse as
		// an `attribute` node in tree-sitter-python, not `identifier`. The
		// bare-except post-filter must recognize this as a typed except.
		const fixture = [
			"try:",
			"    pass",
			"except ValueError:",
			"    pass",
			"except asyncio.TimeoutError:",
			"    pass",
			"except json.JSONDecodeError:",
			"    pass",
			"except (KeyError, TypeError):",
			"    pass",
			"except Exception as e:",
			"    pass",
			"except:",
			"    pass",
		].join("\n");
		// Only the final bare `except:` should match.
		expect(await count("bare-except", "py", "python", fixture)).toBe(1);
		// A single qualified except must NOT match.
		expect(
			await count(
				"bare-except",
				"py",
				"python",
				"try:\n    pass\nexcept module.Error:\n    pass",
			),
		).toBe(0);
		// A single bare `except:` MUST match.
		expect(
			await count(
				"bare-except",
				"py",
				"python",
				"try:\n    pass\nexcept:\n    pass",
			),
		).toBe(1);
	});
});
