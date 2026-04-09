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

	it("does not match safe python literal URL request", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("python-ssrf");
		const filePath = writeTempFile("py", `import requests\nrequests.get("https://example.com")\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("matches python path traversal sink", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("python-path-traversal");
		const filePath = writeTempFile("py", `open(base + user_path)\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match static python file path", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("python-path-traversal");
		const filePath = writeTempFile("py", `open("/tmp/safe.txt")\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
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

	it("does not match parameterized python sql", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`cursor.execute("SELECT * FROM users WHERE id=%s", (user_id,))\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("matches python insecure deserialization sink", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("python-insecure-deserialization");
		const filePath = writeTempFile("py", `import pickle\npickle.loads(payload)\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match safe python json deserialization", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("python-insecure-deserialization");
		const filePath = writeTempFile("py", `import json\njson.loads(payload)\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("matches python weak hash usage and exposes metadata", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("python-weak-hash");
		expect(query.cwe).toContain("CWE-327");
		expect(query.owasp).toContain("A02");
		expect(query.confidence).toBe("high");

		const filePath = writeTempFile("py", `import hashlib\nhashlib.md5(data)\n`);
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

	it("does not match parameterized go sql", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("go-sql-injection");
		const filePath = writeTempFile(
			"go",
			`package main\nfunc run(db DB, id string){ db.Query("SELECT * FROM users WHERE id=$1", id) }\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBe(0);
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

	it("matches go insecure random usage", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("go-insecure-random");
		const filePath = writeTempFile(
			"go",
			`package main\nimport \"math/rand\"\nfunc run(){ _ = rand.Intn(10) }\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches typescript weak hash usage", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("ts-weak-hash");
		const filePath = writeTempFile(
			"ts",
			`import crypto from \"crypto\";\ncrypto.createHash("md5").update(data);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("loads ruby insecure deserialization rule", async () => {
		const query = await getQuery("ruby-insecure-deserialization");
		expect(query.language).toBe("ruby");
		expect(query.id).toBe("ruby-insecure-deserialization");
	});

	it("loads ruby weak hash and insecure random rules", async () => {
		const weakHash = await getQuery("ruby-weak-hash");
		expect(weakHash.cwe).toContain("CWE-327");
		const weakRandom = await getQuery("ruby-insecure-random");
		expect(weakRandom.cwe).toContain("CWE-330");
	});
});
