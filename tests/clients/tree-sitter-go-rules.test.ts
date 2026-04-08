import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TreeSitterClient } from "../../clients/tree-sitter-client.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";

const tmpDirs: string[] = [];

function writeTempGoFile(contents: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-go-rules-"));
	tmpDirs.push(dir);
	const filePath = path.join(dir, "sample.go");
	fs.writeFileSync(filePath, contents, "utf-8");
	return filePath;
}

async function getGoQuery(id: string) {
	const loader = new TreeSitterQueryLoader();
	const queries = await loader.loadQueries(process.cwd());
	const goQueries = queries.get("go") ?? [];
	const query = goQueries.find((q) => q.id === id);
	expect(query, `missing query ${id}`).toBeTruthy();
	return query!;
}

afterAll(() => {
	for (const dir of tmpDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("tree-sitter go rules", () => {
	it("matches go-bare-error only when function returns error", async () => {
		const client = new TreeSitterClient();
		const query = await getGoQuery("go-bare-error");

		const positivePath = writeTempGoFile(`package main

func run() error {
	return doWork()
}
`);
		const positive = await client.runQueryOnFile(query, positivePath, "go");
		expect(positive.length).toBeGreaterThan(0);

		const negativePath = writeTempGoFile(`package main

func run() int {
	return compute()
}
`);
		const negative = await client.runQueryOnFile(query, negativePath, "go");
		expect(negative.length).toBe(0);
	});

	it("matches go-empty-if-err on empty err handler", async () => {
		const client = new TreeSitterClient();
		const query = await getGoQuery("go-empty-if-err");
		const filePath = writeTempGoFile(`package main

func run() error {
	err := doWork()
	if err != nil {
	}
	return nil
}
`);

		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches go-ignored-call-result on discarded result", async () => {
		const client = new TreeSitterClient();
		const query = await getGoQuery("go-ignored-call-result");
		const filePath = writeTempGoFile(`package main

func run() {
	_ = doWork()
}
`);

		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches go-direct-panic on panic call", async () => {
		const client = new TreeSitterClient();
		const query = await getGoQuery("go-direct-panic");
		const filePath = writeTempGoFile(`package main

func run(err error) {
	if err != nil {
		panic(err)
	}
}
`);

		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches go-log-fatal on terminating log call", async () => {
		const client = new TreeSitterClient();
		const query = await getGoQuery("go-log-fatal");
		const filePath = writeTempGoFile(`package main

import "log"

func run(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
`);

		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});
});
