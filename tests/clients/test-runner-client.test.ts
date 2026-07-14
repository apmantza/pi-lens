import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestRunnerClient } from "../../clients/test-runner-client.js";
import { createTempFile, setupTestEnvironment } from "./test-utils.js";

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

	describe("detectRunner — hoisted monorepo node_modules", () => {
		it("finds vitest hoisted to the workspace root from a nested package cwd", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			// Simulate npm/yarn/pnpm workspace hoisting: vitest only lives in
			// node_modules at the workspace root, not in the package's own
			// node_modules (which may not even exist).
			fs.mkdirSync(path.join(tmpDir, "node_modules", "vitest"), {
				recursive: true,
			});
			const pkgDir = path.join(tmpDir, "packages", "foo");
			fs.mkdirSync(pkgDir, { recursive: true });
			fs.writeFileSync(
				path.join(pkgDir, "package.json"),
				JSON.stringify({ name: "foo", version: "1.0.0" }),
			);

			const client = new TestRunnerClient(false);
			const detected = client.detectRunner(pkgDir);
			expect(detected?.runner).toBe("vitest");
		});

		it("finds jest hoisted two levels up (scoped package nesting)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.mkdirSync(path.join(tmpDir, "node_modules", "jest"), {
				recursive: true,
			});
			const pkgDir = path.join(tmpDir, "packages", "@scope", "bar");
			fs.mkdirSync(pkgDir, { recursive: true });
			fs.writeFileSync(
				path.join(pkgDir, "package.json"),
				JSON.stringify({ name: "@scope/bar", version: "1.0.0" }),
			);

			const client = new TestRunnerClient(false);
			const detected = client.detectRunner(pkgDir);
			expect(detected?.runner).toBe("jest");
		});

		it("does not walk up past the bounded depth", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.mkdirSync(path.join(tmpDir, "node_modules", "vitest"), {
				recursive: true,
			});
			// Nest the cwd deeper than MAX_NODE_MODULES_WALK_UP (5) so the
			// hoisted node_modules at tmpDir is out of range.
			const deepDir = path.join(tmpDir, "a", "b", "c", "d", "e", "f", "g");
			fs.mkdirSync(deepDir, { recursive: true });
			fs.writeFileSync(
				path.join(deepDir, "package.json"),
				JSON.stringify({ name: "deep", version: "1.0.0" }),
			);

			const client = new TestRunnerClient(false);
			const detected = client.detectRunner(deepDir);
			expect(detected).toBeNull();
		});
	});

	describe("findTestFile — bounded recursive Python test discovery", () => {
		it("finds a test file grouped by kind (tests/unit/) rather than mirrored", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const srcDir = path.join(tmpDir, "pkg");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "foo.py");
			fs.writeFileSync(src, "x = 1\n");

			// Grouped-by-kind layout: tests/unit/test_foo.py, not the mirrored
			// tests/pkg/test_foo.py the exact-match candidates would look for.
			const testDir = path.join(tmpDir, "tests", "unit");
			fs.mkdirSync(testDir, { recursive: true });
			const testFile = path.join(testDir, "test_foo.py");
			fs.writeFileSync(testFile, "def test_x(): pass\n");

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(testFile);
		});

		it("does not recurse past the bounded depth", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const srcDir = path.join(tmpDir, "pkg");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "foo.py");
			fs.writeFileSync(src, "x = 1\n");

			// Nest the test file deeper than MAX_PYTEST_RECURSE_DEPTH (3)
			// below tests/, so the bounded recursive search must not find it.
			const testDir = path.join(tmpDir, "tests", "a", "b", "c", "d");
			fs.mkdirSync(testDir, { recursive: true });
			fs.writeFileSync(
				path.join(testDir, "test_foo.py"),
				"def test_x(): pass\n",
			);

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found).toBeNull();
		});

		it("still prefers the mirrored subdir match over the recursive fallback", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const srcDir = path.join(tmpDir, "pkg");
			fs.mkdirSync(srcDir, { recursive: true });
			const src = path.join(srcDir, "foo.py");
			fs.writeFileSync(src, "x = 1\n");

			const mirroredDir = path.join(tmpDir, "tests", "pkg");
			fs.mkdirSync(mirroredDir, { recursive: true });
			const mirroredTest = path.join(mirroredDir, "test_foo.py");
			fs.writeFileSync(mirroredTest, "def test_mirrored(): pass\n");

			const groupedDir = path.join(tmpDir, "tests", "unit");
			fs.mkdirSync(groupedDir, { recursive: true });
			fs.writeFileSync(
				path.join(groupedDir, "test_foo.py"),
				"def test_grouped(): pass\n",
			);

			const client = new TestRunnerClient(false);
			const found = client.findTestFile(src, tmpDir);
			expect(found?.testFile).toBe(mirroredTest);
		});
	});

	describe("getTestRunTarget — editing a test file directly (#547 follow-up)", () => {
		it("returns a .test.ts file itself as the target, not a discovered nonsense file", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const src = path.join(tmpDir, "foo.test.ts");
			fs.writeFileSync(src, "// test\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.testFile).toBe(path.resolve(src));
			expect(target?.strategy).toBe("self");
		});

		it("returns a .spec.ts file itself as the target", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const src = path.join(tmpDir, "bar.spec.ts");
			fs.writeFileSync(src, "// test\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.testFile).toBe(path.resolve(src));
			expect(target?.strategy).toBe("self");
		});

		it("returns a Python test_foo.py file itself as the target", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "pytest.ini"), "[pytest]\n");
			const src = path.join(tmpDir, "test_foo.py");
			fs.writeFileSync(src, "def test_x(): pass\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.testFile).toBe(path.resolve(src));
			expect(target?.strategy).toBe("self");
		});

		it("still uses findTestFile discovery for a normal (non-test) source file — no regression", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const src = path.join(tmpDir, "widget.ts");
			fs.writeFileSync(src, "export const x = 1;\n");
			const testFile = path.join(tmpDir, "widget.test.ts");
			fs.writeFileSync(testFile, "// test\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.testFile).toBe(path.resolve(testFile));
			expect(target?.strategy).toBe("related");
		});

		it("prefers failed-first over self when the edited test file is itself in the failed set", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}\n");
			const src = path.join(tmpDir, "flaky.test.ts");
			fs.writeFileSync(src, "// test\n");

			const client = new TestRunnerClient(false) as any;
			client.failedTestsByRunner.set(
				`${path.resolve(tmpDir)}:vitest`,
				new Set([path.resolve(src)]),
			);

			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).toBe("failed-first");
			expect(target?.testFile).toBe(path.resolve(src));
		});
	});

	describe("parseVitestTestGlobs — best-effort vitest config scrape", () => {
		it("extracts include/exclude string-literal arrays from a simple config", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['src/**/*.check.ts', \"e2e/**/*.flow.ts\"],",
					"    exclude: ['src/legacy/**'],",
					"  },",
					"};",
				].join("\n"),
			);

			const client = new TestRunnerClient(false);
			const globs = client.parseVitestTestGlobs(tmpDir);
			expect(globs?.include).toEqual(["src/**/*.check.ts", "e2e/**/*.flow.ts"]);
			expect(globs?.exclude).toEqual(["src/legacy/**"]);
		});

		it("returns null when there is no vitest config", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			const client = new TestRunnerClient(false);
			expect(client.parseVitestTestGlobs(tmpDir)).toBeNull();
		});

		it("returns null when include/exclude is built dynamically (unparseable)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: computeIncludes(),",
					"  },",
					"};",
				].join("\n"),
			);

			const client = new TestRunnerClient(false);
			expect(client.parseVitestTestGlobs(tmpDir)).toBeNull();
		});

		it("caches the parsed result — does not re-read the config file on repeated calls", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			const configPath = path.join(tmpDir, "vitest.config.ts");
			fs.writeFileSync(
				configPath,
				"export default { test: { include: ['a.ts'] } };\n",
			);

			const client = new TestRunnerClient(false);
			const first = client.parseVitestTestGlobs(tmpDir);
			expect(first?.include).toEqual(["a.ts"]);

			// Rewrite the config with a different include array. If the result
			// were re-read/re-parsed on the next call, this would change the
			// returned globs — the cache must keep returning the first result.
			fs.writeFileSync(
				configPath,
				"export default { test: { include: ['b.ts', 'c.ts'] } };\n",
			);
			const second = client.parseVitestTestGlobs(tmpDir);
			expect(second?.include).toEqual(["a.ts"]);
			expect(second).toBe(first);
		});

		it("uses a custom include glob to correct classification of an unconventionally-named test file", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['**/*.check.ts'],",
					"  },",
					"};",
				].join("\n"),
			);
			const src = path.join(tmpDir, "widget.check.ts");
			fs.writeFileSync(src, "// unconventional test naming\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).toBe("self");
			expect(target?.testFile).toBe(path.resolve(src));
		});

		// #628 pin: a broad `include` glob (any `.ts` file under `src/`) must NOT
		// alone classify a plain source file as its own test target. This is the
		// exact shape of the real dogfooding bug — background-review.ts / index.ts
		// got treated as strategy "self" and vitest reported a vacuous
		// `PASS 0p/0f (0ms)` because the project's include glob happened to match
		// every .ts file, not just test files.
		it("does NOT classify a plain source file as self-test from a broad include glob alone (#628)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['src/**/*.ts'],",
					"  },",
					"};",
				].join("\n"),
			);
			fs.mkdirSync(path.join(tmpDir, "src"));
			const src = path.join(tmpDir, "src", "background-review.ts");
			fs.writeFileSync(src, "export function review() {}\n");
			// No companion test file exists — this file has nothing to run.

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).not.toBe("self");
			expect(target).toBeNull();
		});

		// Same shape, but the broad glob is the maximally-generic `**/*.ts` (no
		// directory restriction at all) — still must not self-classify.
		it("does NOT classify a plain source file as self-test from an unrestricted **/*.ts include (#628)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['**/*.ts'],",
					"  },",
					"};",
				].join("\n"),
			);
			const src = path.join(tmpDir, "index.ts");
			fs.writeFileSync(src, "export const x = 1;\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).not.toBe("self");
		});

		// The legitimate case the include-override exists for: a project whose
		// tests live under a conventional `tests/` directory without `.test.` in
		// the filename. This is a narrower signal (a literal test-ish directory
		// segment) than "any file with this extension", so it must still work.
		it("still classifies a file under a bare tests/ directory glob as self-test (legitimate override, #628)", () => {
			const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
			cleanups.push(cleanup);

			fs.writeFileSync(
				path.join(tmpDir, "vitest.config.ts"),
				[
					"export default {",
					"  test: {",
					"    include: ['tests/**/*.ts'],",
					"  },",
					"};",
				].join("\n"),
			);
			fs.mkdirSync(path.join(tmpDir, "tests"));
			const src = path.join(tmpDir, "tests", "widget.ts");
			fs.writeFileSync(src, "// lives in tests/, no .test. in the name\n");

			const client = new TestRunnerClient(false);
			const target = client.getTestRunTarget(src, tmpDir);
			expect(target?.strategy).toBe("self");
			expect(target?.testFile).toBe(path.resolve(src));
		});
	});

	// --- PHPUnit ---

	it("detects phpunit via phpunit.xml.dist", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "phpunit.xml.dist"), "<phpunit></phpunit>\n");

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).toBe("phpunit");
	});

	it("detects phpunit via composer.json require-dev", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "composer.json"),
			JSON.stringify({
				name: "acme/demo",
				"require-dev": { "phpunit/phpunit": "^10.0" },
			}),
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).toBe("phpunit");
	});

	it("does not infer phpunit from composer.json without a phpunit dependency", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(
			path.join(tmpDir, "composer.json"),
			JSON.stringify({ name: "acme/demo", "require-dev": {} }),
		);

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).not.toBe("phpunit");
	});

	it("finds the mirrored PHPUnit test file (src/Foo/Bar.php -> tests/Foo/BarTest.php)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "phpunit.xml"), "<phpunit></phpunit>\n");
		const src = createTempFile(tmpDir, "src/Foo/Bar.php", "<?php\nclass Bar {}\n");
		const testFile = createTempFile(
			tmpDir,
			"tests/Foo/BarTest.php",
			"<?php\nclass BarTest {}\n",
		);

		const client = new TestRunnerClient(false);
		const found = client.findTestFile(src, tmpDir);
		expect(found?.runner).toBe("phpunit");
		expect(found?.testFile).toBe(testFile);
	});

	it("parses a passing PHPUnit OK summary", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parsePhpunitOutput(
			"...\n\nOK (12 tests, 34 assertions)\n",
			"",
			0,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(result.passed).toBe(12);
		expect(result.failed).toBe(0);
		expect(result.skipped).toBe(0);
	});

	it("parses a failing PHPUnit summary with individual failures", () => {
		const client = new TestRunnerClient(false) as any;
		const output = [
			"FAILURES!",
			"",
			"1) Foo\\BarTest::testSomething",
			"Failed asserting that false is true.",
			"",
			"Tests: 12, Assertions: 34, Errors: 1, Failures: 2, Skipped: 1.",
		].join("\n");
		const result = client.parsePhpunitOutput(
			output,
			"",
			1,
			"/tmp/BarTest.php",
			"phpunit",
		);

		expect(result.passed).toBe(8);
		expect(result.failed).toBe(3);
		expect(result.skipped).toBe(1);
		expect(result.failures[0].name).toBe("Foo\\BarTest::testSomething");
	});

	// --- mix test (ExUnit) ---

	it("detects mix via mix.exs", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "mix.exs"), "defmodule Demo.MixProject do\nend\n");

		const client = new TestRunnerClient(false);
		const detected = client.detectRunner(tmpDir);
		expect(detected?.runner).toBe("mix");
	});

	it("finds the mirrored ExUnit test file (lib/accounts/user.ex -> test/accounts/user_test.exs)", () => {
		const { tmpDir, cleanup } = setupTestEnvironment("pi-lens-tests-");
		cleanups.push(cleanup);

		fs.writeFileSync(path.join(tmpDir, "mix.exs"), "defmodule Demo.MixProject do\nend\n");
		const src = createTempFile(
			tmpDir,
			"lib/accounts/user.ex",
			"defmodule Demo.Accounts.User do\nend\n",
		);
		const testFile = createTempFile(
			tmpDir,
			"test/accounts/user_test.exs",
			"defmodule Demo.Accounts.UserTest do\nend\n",
		);

		const client = new TestRunnerClient(false);
		const found = client.findTestFile(src, tmpDir);
		expect(found?.runner).toBe("mix");
		expect(found?.testFile).toBe(testFile);
	});

	it("parses a passing mix test summary", () => {
		const client = new TestRunnerClient(false) as any;
		const result = client.parseMixTestOutput(
			"..\n\nFinished in 0.05 seconds\n2 tests, 0 failures\n",
			"",
			0,
			"/tmp/user_test.exs",
			"mix",
		);

		expect(result.passed).toBe(2);
		expect(result.failed).toBe(0);
		expect(result.duration).toBeCloseTo(50, 0);
	});

	it("parses a failing mix test summary with individual failures", () => {
		const client = new TestRunnerClient(false) as any;
		const output = [
			"  1) test creates a user (Demo.Accounts.UserTest)",
			"     test/accounts/user_test.exs:5",
			"     Assertion with == failed",
			"",
			"Finished in 0.08 seconds",
			"3 tests, 1 failure",
		].join("\n");
		const result = client.parseMixTestOutput(
			output,
			"",
			1,
			"/tmp/user_test.exs",
			"mix",
		);

		expect(result.passed).toBe(2);
		expect(result.failed).toBe(1);
		expect(result.failures[0].name).toBe("test creates a user");
		expect(result.failures[0].location).toBe("Demo.Accounts.UserTest");
	});
});
