import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestRunnerClient } from "./test-runner-client.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

describe("TestRunnerClient", () => {
	let client: TestRunnerClient;
	let tmpDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		client = new TestRunnerClient();
		({ tmpDir, cleanup } = setupTestEnvironment("pi-lens-test-runner-"));
	});

	afterEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	describe("detectRunner", () => {
		it("should detect vitest from config file", () => {
			createTempFile(tmpDir, "vitest.config.ts", "export default {}");
			createTempFile(tmpDir, "src/app.ts", "export const app = {};");

			const result = client.detectRunner(tmpDir);
			expect(result).not.toBeNull();
			expect(result?.runner).toBe("vitest");
		});

		it("should detect jest from config file", () => {
			createTempFile(tmpDir, "jest.config.js", "module.exports = {}");
			createTempFile(tmpDir, "src/app.ts", "export const app = {};");

			const result = client.detectRunner(tmpDir);
			expect(result).not.toBeNull();
			expect(result?.runner).toBe("jest");
		});

		it("should detect pytest from config file", () => {
			createTempFile(tmpDir, "pytest.ini", "[tool:pytest]");
			createTempFile(tmpDir, "src/app.py", "x = 1");

			const result = client.detectRunner(tmpDir);
			expect(result).not.toBeNull();
			expect(result?.runner).toBe("pytest");
		});

		it("should detect runner from node_modules", () => {
			// Create a node_modules/vitest to simulate installed package
			createTempFile(tmpDir, "node_modules/vitest/package.json", "{}");
			createTempFile(tmpDir, "src/app.ts", "export const app = {};");

			const result = client.detectRunner(tmpDir);
			// Should detect vitest from node_modules
			expect(result).not.toBeNull();
		});

		it("should prefer vitest over jest when both exist", () => {
			createTempFile(tmpDir, "vitest.config.ts", "export default {}");
			createTempFile(tmpDir, "jest.config.js", "module.exports = {}");
			createTempFile(tmpDir, "src/app.ts", "export const app = {};");

			const result = client.detectRunner(tmpDir);
			expect(result?.runner).toBe("vitest");
		});
	});

	describe("findTestFile", () => {
		it("should find test file with .test.ts suffix", () => {
			createTempFile(tmpDir, "vitest.config.ts", "export default {}");
			createTempFile(tmpDir, "src/app.ts", "export const app = {};");
			createTempFile(tmpDir, "src/app.test.ts", "describe('app', () => {});");

			const result = client.findTestFile(
				path.join(tmpDir, "src/app.ts"),
				tmpDir,
			);
			expect(result).not.toBeNull();
			expect(result?.testFile).toContain("app.test.ts");
			expect(result?.runner).toBe("vitest");
		});

		it("should find test file with .spec.ts suffix", () => {
			createTempFile(tmpDir, "vitest.config.ts", "export default {}");
			createTempFile(tmpDir, "src/app.ts", "export const app = {};");
			createTempFile(tmpDir, "src/app.spec.ts", "describe('app', () => {});");

			const result = client.findTestFile(
				path.join(tmpDir, "src/app.ts"),
				tmpDir,
			);
			expect(result).not.toBeNull();
			expect(result?.testFile).toContain("app.spec.ts");
		});

		it("should find test file in __tests__ directory", () => {
			createTempFile(tmpDir, "vitest.config.ts", "export default {}");
			createTempFile(tmpDir, "src/app.ts", "export const app = {};");
			createTempFile(
				tmpDir,
				"src/__tests__/app.test.ts",
				"describe('app', () => {});",
			);

			const result = client.findTestFile(
				path.join(tmpDir, "src/app.ts"),
				tmpDir,
			);
			expect(result).not.toBeNull();
			expect(result?.testFile).toContain("__tests__");
		});

		it("should find test file in top-level tests/ directory", () => {
			createTempFile(tmpDir, "vitest.config.ts", "export default {}");
			createTempFile(tmpDir, "src/app.ts", "export const app = {};");
			createTempFile(tmpDir, "tests/app.test.ts", "describe('app', () => {});");

			const result = client.findTestFile(
				path.join(tmpDir, "src/app.ts"),
				tmpDir,
			);
			expect(result).not.toBeNull();
			expect(result?.testFile).toContain(path.join("tests", "app.test.ts"));
		});

		it("should find pytest test file with test_ prefix", () => {
			createTempFile(tmpDir, "pytest.ini", "[tool:pytest]");
			createTempFile(tmpDir, "src/app.py", "x = 1");
			createTempFile(tmpDir, "tests/test_app.py", "def test_app(): pass");

			const result = client.findTestFile(
				path.join(tmpDir, "src/app.py"),
				tmpDir,
			);
			expect(result).not.toBeNull();
			expect(result?.testFile).toContain("test_app.py");
			expect(result?.runner).toBe("pytest");
		});

		it("should return null when no test file found", () => {
			createTempFile(tmpDir, "vitest.config.ts", "export default {}");
			createTempFile(tmpDir, "src/app.ts", "export const app = {};");

			const result = client.findTestFile(
				path.join(tmpDir, "src/app.ts"),
				tmpDir,
			);
			expect(result).toBeNull();
		});

		it("should find test file even without config (if runner installed)", () => {
			// Simulate vitest installed in node_modules
			createTempFile(tmpDir, "node_modules/vitest/package.json", "{}");
			createTempFile(tmpDir, "src/app.ts", "export const app = {};");
			createTempFile(tmpDir, "src/app.test.ts", "describe('app', () => {});");

			const result = client.findTestFile(
				path.join(tmpDir, "src/app.ts"),
				tmpDir,
			);
			// Should find the test file since vitest is "installed"
			expect(result).not.toBeNull();
		});
	});

	describe("formatResult", () => {
		it("should format passing tests", () => {
			const result = {
				file: "/test/app.test.ts",
				sourceFile: "/test/app.ts",
				runner: "vitest",
				passed: 5,
				failed: 0,
				skipped: 0,
				failures: [],
				duration: 420,
			};

			const formatted = client.formatResult(result);
			expect(formatted).toContain("✓");
			expect(formatted).toContain("5/5 passed");
			expect(formatted).toContain("0.42s");
		});

		it("should format failing tests", () => {
			const result = {
				file: "/test/app.test.ts",
				sourceFile: "/test/app.ts",
				runner: "vitest",
				passed: 3,
				failed: 2,
				skipped: 0,
				failures: [
					{
						name: "should add",
						message: "expected 4, got 3",
						location: "app.test.ts:10",
					},
					{
						name: "should subtract",
						message: "expected 1, got 2",
						location: "app.test.ts:20",
					},
				],
				duration: 420,
			};

			const formatted = client.formatResult(result);
			expect(formatted).toContain("✗");
			expect(formatted).toContain("2/5 failed");
			expect(formatted).toContain("should add");
			expect(formatted).toContain("should subtract");
		});

		it("should format runner errors", () => {
			const result = {
				file: "/test/app.test.ts",
				sourceFile: "/test/app.ts",
				runner: "vitest",
				passed: 0,
				failed: 0,
				skipped: 0,
				failures: [],
				duration: 0,
				error: "Test file not found",
			};

			const formatted = client.formatResult(result);
			expect(formatted).toContain("⚠");
			expect(formatted).toContain("Could not run tests");
		});

		it("should return empty string for no tests", () => {
			const result = {
				file: "/test/app.test.ts",
				sourceFile: "/test/app.ts",
				runner: "vitest",
				passed: 0,
				failed: 0,
				skipped: 0,
				failures: [],
				duration: 0,
			};

			const formatted = client.formatResult(result);
			expect(formatted).toBe("");
		});
	});
});
