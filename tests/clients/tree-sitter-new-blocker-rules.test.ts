import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";
import { removeTempDirSync } from "./test-utils.js";

const tmpDirs: string[] = [];

function writeTempFile(ext: string, contents: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-new-blocker-"));
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

describe("S1219 — switch non-case labels (TS)", () => {
	it("matches non-case label inside switch", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("switch-non-case-labels-ts");
		const filePath = writeTempFile(
			"ts",
			`function demo(x: number) {
				switch (x) {
					case 1:
						break;
					myLabel:
						doSomething();
				}
			}
			`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match normal switch", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("switch-non-case-labels-ts");
		const filePath = writeTempFile(
			"ts",
			`function demo(x: number) {
				switch (x) {
					case 1:
						break;
					default:
						break;
				}
			}
			`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});
});

describe("S2970 — incomplete assertion (TS)", () => {
	it("matches bare expect() in test block", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-incomplete-assertion");
		const filePath = writeTempFile(
			"ts",
			`it("checks foo", () => {
				expect(foo);
			});
			`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches uncalled matcher in test block", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-incomplete-assertion");
		const filePath = writeTempFile(
			"ts",
			`it("checks foo", () => {
				expect(foo).toBe;
			});
			`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches uncalled matcher with not modifier", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-incomplete-assertion");
		const filePath = writeTempFile(
			"ts",
			`it("checks foo", () => {
				expect(foo).not.toBe;
			});
			`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match complete assertion", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-incomplete-assertion");
		const filePath = writeTempFile(
			"ts",
			`it("checks foo", () => {
				expect(foo).toBe(true);
			});
			`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("does not match complete assertion with not modifier", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-incomplete-assertion");
		const filePath = writeTempFile(
			"ts",
			`it("checks foo", () => {
				expect(foo).not.toBe(1);
			});
			`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("does not match when expect is assigned (not a statement)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-incomplete-assertion");
		const filePath = writeTempFile(
			"ts",
			`it("checks foo", () => {
				const matcher = expect(foo).toBe;
			});
			`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("does not flag Chai property assertions", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-incomplete-assertion");
		const filePath = writeTempFile(
			"ts",
			`it("checks foo", () => {
				expect(foo).to.be.true;
			});
			`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});
});
