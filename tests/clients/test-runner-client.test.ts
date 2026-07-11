import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestRunnerClient } from "../../clients/test-runner-client.js";
import { setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

describe("test-runner-client", () => {
	it("does not infer vitest from vite config alone", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "vite.config.ts"), "export default {}\n");
		fs.writeFileSync(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ name: "tmp", version: "1.0.0" }),
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).not.toBe("vitest");
	});

	it("parses cargo summary in generic runner output", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseGenericRunnerOutput(
			"test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out",
			"",
			0,
			"/tmp/test.rs",
			"cargo",
		);

		expect(result.passed).toBe(3);
		expect(result.failed).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it("parses rspec summary in generic runner output", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseGenericRunnerOutput(
			"3 examples, 1 failure",
			"",
			1,
			"/tmp/spec/foo_spec.rb",
			"rspec",
		);

		expect(result.passed).toBe(2);
		expect(result.failed).toBe(1);
	});

	it("prefers failed-first target when failure cache exists", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "go.mod"), "module example.com/tmp\n");
		const src = path.join(tmpDir, "sum.go");
		const testFile = path.join(tmpDir, "sum_test.go");
		fs.writeFileSync(src, "package main\n");
		fs.writeFileSync(testFile, "package main\n");

		const client = new TestRunnerClient(false) as any;
		client.failedTestsByRunner.set(`${path.resolve(tmpDir)}:go`, new Set([testFile]));

		const target = client.getTestRunTarget(src, tmpDir);
		expect(target?.strategy).toBe("failed-first");
		expect(target?.testFile).toBe(path.resolve(testFile));
	});

	it("does not infer pytest from pyproject without pytest section", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "pyproject.toml"),
			"[project]\nname='demo'\nversion='0.1.0'\n",
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir, path.join(tmpDir, "index.ts"));
		expect(detected?.runner).not.toBe("pytest");
	});

	it("infers pytest when pyproject has pytest.ini_options", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "pyproject.toml"),
			"[tool.pytest.ini_options]\naddopts='-q'\n",
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir, path.join(tmpDir, "main.py"));
		expect(detected?.runner).toBe("pytest");
	});

	it("does not use global pytest fallback for non-Python files", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir, path.join(tmpDir, "index.ts"));
		expect(detected).toBeNull();
	});

	describe("findTestFile — mirrored test-tree layout (#547)", () => {
		it("finds a TS test mirrored under tests/<subdir>/, matching this repo's own layout", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const srcDir = path.join(tmpDir, "clients");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "knip-client.ts");
			fs.writeFileSync(src, "export const x = 1;\n");

			const testDir = path.join(tmpDir, "tests", "clients");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "knip-client.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("finds a mirrored test under __tests__/<subdir>/", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const srcDir = path.join(tmpDir, "lib", "utils");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "format.ts");
			fs.writeFileSync(src, "export const x = 1;\n");

			const testDir = path.join(tmpDir, "__tests__", "lib", "utils");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "format.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("finds a Python test mirrored under tests/<subdir>/ (test_*.py)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const srcDir = path.join(tmpDir, "pkg", "sub");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "foo.py");
			fs.writeFileSync(src, "x = 1\n");

			const testDir = path.join(tmpDir, "tests", "pkg", "sub");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "test_foo.py");
			fs.writeFileSync(testFile, "def test_x(): pass\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("still finds a colocated test file (no regression)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const srcDir = path.join(tmpDir, "clients");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "widget.ts");
			fs.writeFileSync(src, "export const x = 1;\n");
			const testFile = path.join(srcDir, "widget.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("still finds a flat top-level tests/ test file (no regression)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const srcDir = path.join(tmpDir, "clients");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "gadget.ts");
			fs.writeFileSync(src, "export const x = 1;\n");

			const testDir = path.join(tmpDir, "tests");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "gadget.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("prefers same-directory test over mirrored tests/ when both exist", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const srcDir = path.join(tmpDir, "clients");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "dual.ts");
			fs.writeFileSync(src, "export const x = 1;\n");
			const colocated = path.join(srcDir, "dual.test.ts");
			fs.writeFileSync(colocated, "// colocated\n");

			const mirroredDir = path.join(tmpDir, "tests", "clients");
			fs.mkdirSync(mirroredDir, { recursive: true });
			fs.writeFileSync(path.join(mirroredDir, "dual.test.ts"), "// mirrored\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(colocated);
		});
	});
});
