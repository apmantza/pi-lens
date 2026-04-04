import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArchitectClient } from "../clients/architect-client.js";
import { TreeSitterQueryLoader } from "../clients/tree-sitter-query-loader.js";

const originalCwd = process.cwd();

afterEach(() => {
	process.chdir(originalCwd);
});

async function withTempDir<T>(run: (dir: string) => Promise<T> | T): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-assets-"));
	try {
		return await run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("packaged built-in assets", () => {
	it("loads bundled architect defaults outside the extension repo", async () => {
		await withTempDir(async (dir) => {
			process.chdir(dir);
			const client = new ArchitectClient();

			expect(client.loadConfig(dir)).toBe(true);
			expect(client.hasConfig()).toBe(true);
			expect(client.isUserDefined()).toBe(false);
		});
	});

	it("loads bundled tree-sitter queries outside the extension repo", async () => {
		await withTempDir(async (dir) => {
			process.chdir(dir);
			const loader = new TreeSitterQueryLoader();
			const queries = await loader.loadQueries();
			const totalQueries = [...queries.values()].reduce(
				(total, entries) => total + entries.length,
				0,
			);

			expect(totalQueries).toBeGreaterThan(0);
		});
	});

	it("deduplicates packaged tree-sitter queries when cwd already points at the package", async () => {
		process.chdir(path.resolve(import.meta.dirname, ".."));
		const loader = new TreeSitterQueryLoader();
		const queries = await loader.loadQueries();
		const ids = [...queries.values()].flatMap((entries) =>
			entries.map((entry) => entry.id),
		);

		expect(new Set(ids).size).toBe(ids.length);
	});
});
