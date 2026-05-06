import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";

const tmpDirs: string[] = [];

function writeTempFile(ext: string, contents: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-concurrency-"));
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

describe("tree-sitter concurrency rules", () => {
	it("matches detached async call in TypeScript", async () => {
		const client = await TreeSitterClient.create();
		const query = await getQuery("ts-detached-async-call");
		const filePath = writeTempFile(
			"ts",
			`async function run(url: string) { fetch(url); saveAsync(url); }\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches threaded global state write in Python", async () => {
		const client = await TreeSitterClient.create();
		const query = await getQuery("python-thread-global-write");
		const filePath = writeTempFile(
			"py",
			`import threading\ncount = 0\ndef worker():\n    global count\n    count += 1\nthreading.Thread(target=worker).start()\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("loads Go concurrency rule metadata", async () => {
		const query = await getQuery("go-goroutine-loop-capture");
		expect(query.language).toBe("go");
		expect(query.cwe).toContain("CWE-362");
	});

	it("loads rust lock-across-await rule metadata", async () => {
		const query = await getQuery("rust-lock-held-across-await");
		expect(query.language).toBe("rust");
		expect(query.cwe).toContain("CWE-833");
		expect(query.confidence).toBe("low");
	});
});
