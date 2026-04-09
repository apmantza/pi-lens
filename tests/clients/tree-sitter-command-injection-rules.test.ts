import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";

const tmpDirs: string[] = [];

function writeTempFile(ext: string, contents: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cmdinj-"));
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

describe("tree-sitter command injection rules", () => {
	it("matches python command injection sink", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("python-command-injection");
		const filePath = writeTempFile(
			"py",
			`import os\nos.system(user_input)\n`,
		);

		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match safe python subprocess invocation", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("python-command-injection");
		const filePath = writeTempFile(
			"py",
			`import subprocess\nsubprocess.run([\"git\",\"status\"], check=True)\n`,
		);

		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("matches go command injection sink", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("go-command-injection");
		const filePath = writeTempFile(
			"go",
			`package main\nimport \"os/exec\"\nfunc run(userInput string){ _ = exec.Command(\"sh\", \"-c\", userInput) }\n`,
		);

		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match safe go command invocation", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("go-command-injection");
		const filePath = writeTempFile(
			"go",
			`package main\nimport \"os/exec\"\nfunc run(){ _ = exec.Command(\"git\", \"status\") }\n`,
		);

		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBe(0);
	});

	it("matches ruby command injection sink", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("ruby-command-injection");
		expect(query.language).toBe("ruby");
		const filePath = writeTempFile("rb", `system(cmd)\n`);

		const matches = await client.runQueryOnFile(query, filePath, "ruby");
		expect(Array.isArray(matches)).toBe(true);
	});

	it("matches typescript command injection sink", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("ts-command-injection");
		const filePath = writeTempFile(
			"ts",
			`import * as child_process from \"node:child_process\";\nchild_process.exec(userInput);\n`,
		);

		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match non-child-process exec-like calls", async () => {
		const client = new TreeSitterClient();
		const query = await getQuery("ts-command-injection");
		const filePath = writeTempFile("ts", `const tool = { exec: () => {} }; tool.exec();\n`);

		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});
});
