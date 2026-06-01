import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuleCache } from "../../clients/cache/rule-cache.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import { appendToWorklog } from "../../clients/fix-worklog.js";

const originalDataDir = process.env.PILENS_DATA_DIR;

afterEach(() => {
	if (originalDataDir === undefined) {
		delete process.env.PILENS_DATA_DIR;
	} else {
		process.env.PILENS_DATA_DIR = originalDataDir;
	}
});

describe("getProjectDataDir", () => {
	it("defaults to a global pi-lens projects directory instead of the project folder", () => {
		delete process.env.PILENS_DATA_DIR;
		const cwd = path.resolve("/tmp/demo-project");

		const result = getProjectDataDir(cwd);

		expect(
			result.startsWith(path.join(os.homedir(), ".pi-lens", "projects")),
		).toBe(true);
		expect(result.includes(`${path.sep}.pi-lens${path.sep}`)).toBe(true);
		expect(result.startsWith(path.join(cwd, ".pi-lens"))).toBe(false);
	});

	it("reuses an existing legacy project .pi-lens directory when no env override is set", () => {
		delete process.env.PILENS_DATA_DIR;
		const cwd = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-legacy-project-"),
		);
		const legacyDir = path.join(cwd, ".pi-lens");
		fs.mkdirSync(legacyDir, { recursive: true });

		const result = getProjectDataDir(cwd);

		expect(result).toBe(legacyDir);
	});

	it("uses PILENS_DATA_DIR when provided", () => {
		process.env.PILENS_DATA_DIR = path.join(os.tmpdir(), "pi-lens-data-root");
		const cwd = path.resolve("/tmp/another-project");

		const result = getProjectDataDir(cwd);

		expect(result.startsWith(process.env.PILENS_DATA_DIR)).toBe(true);
		expect(result.startsWith(path.join(cwd, ".pi-lens"))).toBe(false);
	});

	it("project-data writers do not create a .pi-lens folder inside the project", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-project-data-"));
		process.env.PILENS_DATA_DIR = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-global-data-"),
		);

		appendToWorklog(
			cwd,
			[
				{
					id: "demo-id",
					tool: "eslint",
					severity: "warning",
					semantic: "warning",
					filePath: path.join(cwd, "src", "index.ts"),
					message: "demo",
					rule: "demo-rule",
					line: 1,
					column: 1,
					fixable: true,
				},
			],
			false,
		);

		expect(fs.existsSync(path.join(cwd, ".pi-lens"))).toBe(false);
		expect(
			fs.existsSync(path.join(getProjectDataDir(cwd), "worklog.jsonl")),
		).toBe(true);
	});

	it("stores rule cache under the configured data directory", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-rule-cache-"));
		const prev = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-global-data-"),
		);
		try {
			const cache = new RuleCache("typescript", cwd);

			cache.set([], []);

			expect(fs.existsSync(path.join(cwd, ".pi-lens"))).toBe(false);
			expect(
				fs.existsSync(
					path.join(
						getProjectDataDir(cwd),
						"cache",
						"typescript-rules-v3.json",
					),
				),
			).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = prev;
		}
	});
});
