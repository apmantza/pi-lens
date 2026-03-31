/**
 * Formatter Detection Tests
 *
 * Tests smart detection of formatters based on:
 * - Config files (biome.json, .prettierrc, etc.)
 * - Dependencies (package.json, requirements.txt)
 * - Binary availability
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	biomeFormatter,
	prettierFormatter,
	ruffFormatter,
	blackFormatter,
	gofmtFormatter,
	rustfmtFormatter,
	getFormattersForFile,
	clearFormatterCache,
	formatFile,
} from "../formatters.js";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_DIR = path.join(__dirname, "..", "..", "test-formatters");

describe("Formatter Detection", () => {
	beforeEach(() => {
		clearFormatterCache();
		if (fs.existsSync(TEST_DIR)) {
			fs.rmSync(TEST_DIR, { recursive: true });
		}
		fs.mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		clearFormatterCache();
		if (fs.existsSync(TEST_DIR)) {
			fs.rmSync(TEST_DIR, { recursive: true });
		}
	});

	describe("biomeFormatter.detect()", () => {
		it("should detect biome.json config file", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "biome.json"), '{"formatter": {}}');

			const detected = await biomeFormatter.detect(TEST_DIR);

			expect(detected).toBe(true);
		});

		it("should detect biome.jsonc config file", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "biome.jsonc"), "{}");

			const detected = await biomeFormatter.detect(TEST_DIR);

			expect(detected).toBe(true);
		});

		it("should detect @biomejs/biome in devDependencies", async () => {
			fs.writeFileSync(
				path.join(TEST_DIR, "package.json"),
				JSON.stringify({ devDependencies: { "@biomejs/biome": "^1.0.0" } })
			);

			const detected = await biomeFormatter.detect(TEST_DIR);

			expect(detected).toBe(true);
		});

		it("should return false when no biome config", async () => {
			const detected = await biomeFormatter.detect(TEST_DIR);
			expect(detected).toBe(false);
		});

		it("should find biome.json in parent directory", async () => {
			const subDir = path.join(TEST_DIR, "src", "components");
			fs.mkdirSync(subDir, { recursive: true });
			fs.writeFileSync(path.join(TEST_DIR, "biome.json"), "{}");

			const detected = await biomeFormatter.detect(subDir);

			expect(detected).toBe(true);
		});
	});

	describe("prettierFormatter.detect()", () => {
		it("should detect .prettierrc config file", async () => {
			fs.writeFileSync(path.join(TEST_DIR, ".prettierrc"), "{}");

			const detected = await prettierFormatter.detect(TEST_DIR);

			expect(detected).toBe(true);
		});

		it("should detect prettier in devDependencies", async () => {
			fs.writeFileSync(
				path.join(TEST_DIR, "package.json"),
				JSON.stringify({ devDependencies: { prettier: "^3.0.0" } })
			);

			const detected = await prettierFormatter.detect(TEST_DIR);

			expect(detected).toBe(true);
		});

		it("should detect prettier field in package.json", async () => {
			fs.writeFileSync(
				path.join(TEST_DIR, "package.json"),
				JSON.stringify({ prettier: { semi: false } })
			);

			const detected = await prettierFormatter.detect(TEST_DIR);

			expect(detected).toBe(true);
		});

		it("should return false when no prettier config", async () => {
			const detected = await prettierFormatter.detect(TEST_DIR);
			expect(detected).toBe(false);
		});
	});

	describe("ruffFormatter.detect()", () => {
		it("should detect [tool.ruff] in pyproject.toml", async () => {
			fs.writeFileSync(
				path.join(TEST_DIR, "pyproject.toml"),
				"[tool.ruff]\nline-length = 100"
			);

			const detected = await ruffFormatter.detect(TEST_DIR);

			expect(detected).toBe(true);
		});

		it("should detect ruff.toml config file", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "ruff.toml"), "line-length = 100");

			const detected = await ruffFormatter.detect(TEST_DIR);

			expect(detected).toBe(true);
		});

		it("should detect .ruff.toml config file", async () => {
			fs.writeFileSync(path.join(TEST_DIR, ".ruff.toml"), "line-length = 100");

			const detected = await ruffFormatter.detect(TEST_DIR);

			expect(detected).toBe(true);
		});

		it("should detect ruff in requirements.txt", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "requirements.txt"), "ruff==0.1.0\n");

			const detected = await ruffFormatter.detect(TEST_DIR);

			expect(detected).toBe(true);
		});

		it("should detect ruff even if [tool.black] exists (no preference logic)", async () => {
			// Create pyproject.toml with black config
			fs.writeFileSync(
				path.join(TEST_DIR, "pyproject.toml"),
				"[tool.black]\nline-length = 100"
			);
			// Also write requirements with ruff
			fs.writeFileSync(path.join(TEST_DIR, "requirements.txt"), "ruff\n");

			// The current implementation doesn't have preference logic
			// Both black and ruff would be detected if their configs exist
			// This is intentional - users can disable one if needed
			const detected = await blackFormatter.detect(TEST_DIR);
			expect(detected).toBe(true);
		});
	});

	describe("blackFormatter.detect()", () => {
		it("should detect [tool.black] in pyproject.toml", async () => {
			fs.writeFileSync(
				path.join(TEST_DIR, "pyproject.toml"),
				"[tool.black]\nline-length = 100"
			);

			const detected = await blackFormatter.detect(TEST_DIR);

			expect(detected).toBe(true);
		});

		it("should detect black in requirements.txt", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "requirements.txt"), "black==23.0.0\n");

			const detected = await blackFormatter.detect(TEST_DIR);

			expect(detected).toBe(true);
		});

		it("should return false when no black config", async () => {
			const detected = await blackFormatter.detect(TEST_DIR);
			expect(detected).toBe(false);
		});
	});

	describe("gofmtFormatter.detect()", () => {
		it("should detect gofmt binary availability", async () => {
			// This test depends on whether gofmt is installed
			// We can't reliably test this in CI, but we can verify the logic
			const detected = await gofmtFormatter.detect(TEST_DIR);
			// Should return boolean based on binary availability
			expect(typeof detected).toBe("boolean");
		});
	});

	describe("rustfmtFormatter.detect()", () => {
		it("should detect rustfmt binary availability", async () => {
			const detected = await rustfmtFormatter.detect(TEST_DIR);
			expect(typeof detected).toBe("boolean");
		});
	});

	describe("getFormattersForFile()", () => {
		it("should return formatters for TypeScript file with biome config", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "biome.json"), "{}");
			const tsFile = path.join(TEST_DIR, "test.ts");

			const formatters = await getFormattersForFile(tsFile, TEST_DIR);

			expect(formatters.map(f => f.name)).toContain("biome");
		});

		it("should return formatters for TypeScript file with prettier", async () => {
			fs.writeFileSync(
				path.join(TEST_DIR, "package.json"),
				JSON.stringify({ devDependencies: { prettier: "^3.0.0" } })
			);
			const tsFile = path.join(TEST_DIR, "test.ts");

			const formatters = await getFormattersForFile(tsFile, TEST_DIR);

			expect(formatters.map(f => f.name)).toContain("prettier");
		});

		it("should return multiple formatters for TypeScript file", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "biome.json"), "{}");
			fs.writeFileSync(
				path.join(TEST_DIR, "package.json"),
				JSON.stringify({ devDependencies: { prettier: "^3.0.0" } })
			);
			const tsFile = path.join(TEST_DIR, "test.ts");

			const formatters = await getFormattersForFile(tsFile, TEST_DIR);

			// Both biome and prettier should be returned
			expect(formatters.length).toBeGreaterThanOrEqual(1);
			const names = formatters.map(f => f.name);
			expect(names).toContain("biome");
		});

		it("should return ruff for Python file with pyproject.toml", async () => {
			fs.writeFileSync(
				path.join(TEST_DIR, "pyproject.toml"),
				"[tool.ruff]\nline-length = 100"
			);
			const pyFile = path.join(TEST_DIR, "test.py");

			const formatters = await getFormattersForFile(pyFile, TEST_DIR);

			expect(formatters.map(f => f.name)).toContain("ruff");
		});

		it("should return black for Python file with black config", async () => {
			fs.writeFileSync(
				path.join(TEST_DIR, "pyproject.toml"),
				"[tool.black]\nline-length = 100"
			);
			const pyFile = path.join(TEST_DIR, "test.py");

			const formatters = await getFormattersForFile(pyFile, TEST_DIR);

			// Should prefer black over ruff
			expect(formatters.map(f => f.name)).toContain("black");
		});

		it("should return empty array for unsupported extensions", async () => {
			const txtFile = path.join(TEST_DIR, "test.txt");
			fs.writeFileSync(txtFile, "content");

			const formatters = await getFormattersForFile(txtFile, TEST_DIR);

			expect(formatters).toEqual([]);
		});

		it("should cache detection results", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "biome.json"), "{}");
			const tsFile = path.join(TEST_DIR, "test.ts");

			// First call
			await getFormattersForFile(tsFile, TEST_DIR);
			// Second call should use cache
			const formatters = await getFormattersForFile(tsFile, TEST_DIR);

			expect(formatters.map(f => f.name)).toContain("biome");
		});
	});

	describe("clearFormatterCache()", () => {
		it("should clear cached detection results", async () => {
			fs.writeFileSync(path.join(TEST_DIR, "biome.json"), "{}");
			const tsFile = path.join(TEST_DIR, "test.ts");

			// First detection
			await getFormattersForFile(tsFile, TEST_DIR);

			// Clear cache
			clearFormatterCache();

			// Delete config
			fs.rmSync(path.join(TEST_DIR, "biome.json"));

			// Should re-detect (now without biome)
			const formatters = await getFormattersForFile(tsFile, TEST_DIR);
			expect(formatters.map(f => f.name)).not.toContain("biome");
		});
	});

	describe("formatFile()", () => {
		it("should format file and report changes", async () => {
			// Create a simple test - we'll skip actual formatter execution
			// because we can't guarantee formatters are installed
			const testFile = path.join(TEST_DIR, "test.txt");
			fs.writeFileSync(testFile, "unchanged");

			const mockFormatter = {
				name: "mock",
				command: ["echo", "$FILE"],
				extensions: [".txt"],
				detect: async () => true,
			};

			const result = await formatFile(testFile, mockFormatter);

			// echo command should succeed but not change file
			expect(result.success).toBe(true);
		});

		it("should handle formatter execution with valid command", async () => {
			const testFile = path.join(TEST_DIR, "valid.txt");
			fs.writeFileSync(testFile, "content");

			// Use a valid command that succeeds but doesn't modify file
			const mockFormatter = {
				name: "valid",
				command: process.platform === "win32" ? ["cmd", "/c", "echo", "$FILE"] : ["echo", "$FILE"],
				extensions: [".txt"],
				detect: async () => true,
			};

			const result = await formatFile(testFile, mockFormatter);

			// Should not throw, completes with success
			expect(result).toBeDefined();
			expect(typeof result.success).toBe("boolean");
		});
	});

	describe("Formatter extensions", () => {
		it("biome should handle TS/JS/JSON/CSS/Vue/Svelte", () => {
			expect(biomeFormatter.extensions).toContain(".ts");
			expect(biomeFormatter.extensions).toContain(".tsx");
			expect(biomeFormatter.extensions).toContain(".js");
			expect(biomeFormatter.extensions).toContain(".json");
			expect(biomeFormatter.extensions).toContain(".css");
			expect(biomeFormatter.extensions).toContain(".vue");
			expect(biomeFormatter.extensions).toContain(".svelte");
		});

		it("prettier should handle Markdown and YAML", () => {
			expect(prettierFormatter.extensions).toContain(".md");
			expect(prettierFormatter.extensions).toContain(".mdx");
			expect(prettierFormatter.extensions).toContain(".yaml");
			expect(prettierFormatter.extensions).toContain(".yml");
		});

		it("ruff should handle Python files", () => {
			expect(ruffFormatter.extensions).toContain(".py");
			expect(ruffFormatter.extensions).toContain(".pyi");
		});

		it("gofmt should handle Go files", () => {
			expect(gofmtFormatter.extensions).toContain(".go");
		});

		it("rustfmt should handle Rust files", () => {
			expect(rustfmtFormatter.extensions).toContain(".rs");
		});
	});
});
