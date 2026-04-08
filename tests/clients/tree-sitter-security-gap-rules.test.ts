import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";

const tmpDirs: string[] = [];

function writeTempFile(ext: string, contents: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sec-gap-"));
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

describe("tree-sitter security gap rules", () => {
	it("matches python ssrf sink", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("python-ssrf");
		const filePath = writeTempFile(
			"py",
			`import requests\nrequests.get(user_url)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches python path traversal sink", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("python-path-traversal");
		const filePath = writeTempFile("py", `open(base + user_path)\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches python sql injection sink", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`cursor.execute("SELECT * FROM users WHERE id = " + user_id)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches python insecure deserialization sink", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("python-insecure-deserialization");
		const filePath = writeTempFile("py", `import pickle\npickle.loads(payload)\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches go sql injection sink", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("go-sql-injection");
		const filePath = writeTempFile(
			"go",
			`package main\nimport \"fmt\"\nfunc run(db DB, userID string){ db.Query(fmt.Sprintf(\"SELECT * FROM users WHERE id=%s\", userID)) }\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches typescript ssrf sink", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile("ts", `await fetch(userUrl);\n`);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches go path traversal sink", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("go-path-traversal");
		const filePath = writeTempFile("go", `package main\nimport \"os\"\nfunc run(base string, userPath string){ os.ReadFile(base + userPath) }\n`);
		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("loads ruby insecure deserialization rule", async () => {
		const query = await getQuery("ruby-insecure-deserialization");
		expect(query.language).toBe("ruby");
		expect(query.id).toBe("ruby-insecure-deserialization");
	});
});
