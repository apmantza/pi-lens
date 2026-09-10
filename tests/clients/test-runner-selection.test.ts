/**
 * #2870 — runner selection is per file KIND and per resolved module root.
 *
 * Recurrence this file prevents (AGENTS.md defect shape 42, "a rule keyed on
 * one language", and shape 39, "a walk-up result used as an eligibility
 * gate"): `detectRunner` read the config files of the DISPATCH ROOT only, so
 * in a repo carrying both a `go.mod` and a Gradle build the declaration order
 * of `RUNNERS` decided every file's runner. Measured on 4.1.5 (#2870), and
 * reproduced against this tree's built `getTestRunTarget` before the fix:
 *
 *   nested gradle module .java test -> runner=go strategy=self
 *     cmd: go test -run . ./app/gw/src/test/java/com/x/pkg
 *   docs/tests/README.md            -> runner=go strategy=self
 *     cmd: go test -run . ./docs/tests
 *   go-only repo, .java test        -> runner=go strategy=self
 *
 * Every case below drives the REAL `getTestRunTarget` over a real fixture
 * tree — the production selection path, `detectFileKind` +
 * `resolveLanguageRootForFile` + the availability probe included — never a
 * hand-fed runner name.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isExcludedTestTarget,
	RUNNERS,
	TestRunnerClient,
} from "../../clients/test-runner-client.js";
import { KIND_EXTENSIONS } from "../../clients/file-kinds.js";
import { removeTempDirSync } from "./test-utils.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

function makeRoot(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function write(root: string, relative: string, content = "\n"): string {
	const target = path.join(root, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	return target;
}

/**
 * Polyglot root: a `go.mod` AND a Kotlin-DSL Gradle build at the top, one
 * nested Gradle module, one nested Go module — the reporter's repo shape.
 */
function makePolyglotRepo(): {
	root: string;
	javaTest: string;
	goSource: string;
	goCompanionTest: string;
	readme: string;
	yaml: string;
	unknownExt: string;
} {
	const root = makeRoot("pi-lens-2870-polyglot-");
	write(root, "go.mod", "module example.com/x\n");
	write(root, "build.gradle.kts");
	write(root, "settings.gradle.kts");
	write(root, "gradlew", "#!/bin/sh\n");
	write(root, "app/gw/build.gradle.kts");
	const javaTest = write(
		root,
		"app/gw/src/test/java/com/x/pkg/FooTest.java",
		"class FooTest {}\n",
	);
	write(root, "tools/tapctl/go.mod", "module example.com/tapctl\n");
	const goSource = write(
		root,
		"tools/tapctl/internal/lightning/bolt.go",
		"package lightning\n",
	);
	const goCompanionTest = write(
		root,
		"tools/tapctl/internal/lightning/bolt_test.go",
		"package lightning\n",
	);
	const readme = write(root, "docs/tests/README.md", "# notes\n");
	const yaml = write(root, "conf/test/fixture.yaml", "a: 1\n");
	const unknownExt = write(root, "conf/test/fixture.qqq", "x\n");
	return {
		root,
		javaTest,
		goSource,
		goCompanionTest,
		readme,
		yaml,
		unknownExt,
	};
}

describe("#2870 runner selection is per file kind", () => {
	it("hands a nested Gradle module's .java test to gradle, never to go", () => {
		const repo = makePolyglotRepo();
		const target = new TestRunnerClient(false).getTestRunTarget(
			repo.javaTest,
			repo.root,
		);
		expect(target?.runner).toBe("gradle");
		expect(target?.strategy).toBe("self");
		expect(target?.testFile).toBe(repo.javaTest);
	});

	it("gives a .java file in a go-only repo no target at all", () => {
		// Shape 39: the java root walk finds no java marker, so it resolves to
		// the workspace root — where `go.mod` lives. The KIND check, not the
		// resolved root, is what refuses go here.
		const root = makeRoot("pi-lens-2870-goonly-");
		write(root, "go.mod", "module example.com/y\n");
		const javaTest = write(
			root,
			"src/test/java/BarTest.java",
			"class BarTest {}\n",
		);
		expect(
			new TestRunnerClient(false).getTestRunTarget(javaTest, root),
		).toBeNull();
	});

	it("gives no non-code file under a test directory a target", () => {
		const repo = makePolyglotRepo();
		const client = new TestRunnerClient(false);
		expect(client.getTestRunTarget(repo.readme, repo.root)).toBeNull();
		expect(client.getTestRunTarget(repo.yaml, repo.root)).toBeNull();
		expect(client.getTestRunTarget(repo.unknownExt, repo.root)).toBeNull();
	});

	it("still runs the whole Gradle build for a .java test in a single-module Gradle repo", () => {
		// Amended criterion 4: a single-language repo keeps the runner it
		// selects today for files of that runner's kind.
		const root = makeRoot("pi-lens-2870-gradle-");
		write(root, "build.gradle.kts");
		write(root, "gradlew", "#!/bin/sh\n");
		const javaTest = write(
			root,
			"src/test/java/com/x/FooTest.java",
			"class FooTest {}\n",
		);
		const target = new TestRunnerClient(false).getTestRunTarget(javaTest, root);
		expect(target?.runner).toBe("gradle");
	});

	it("detects a Gradle repo whose root carries only the Kotlin-DSL settings script", () => {
		// `settings.gradle` was in the runner's config files; its Kotlin-DSL
		// spelling was not, so a modern multi-project build whose root holds
		// only `settings.gradle.kts` had no runner at all.
		const root = makeRoot("pi-lens-2870-settings-kts-");
		write(root, "settings.gradle.kts");
		write(root, "gradlew", "#!/bin/sh\n");
		const javaTest = write(
			root,
			"src/test/java/com/x/FooTest.java",
			"class FooTest {}\n",
		);
		expect(
			new TestRunnerClient(false).getTestRunTarget(javaTest, root)?.runner,
		).toBe("gradle");
	});

	it("still hands a .ts test in a vitest repo to vitest", () => {
		const root = makeRoot("pi-lens-2870-vitest-");
		write(root, "vitest.config.ts", "export default {}\n");
		const test = write(root, "tests/widget.test.ts", "export {};\n");
		const target = new TestRunnerClient(false).getTestRunTarget(test, root);
		expect(target?.runner).toBe("vitest");
		expect(target?.strategy).toBe("self");
	});

	it("anchors a nested Go module's source file at its own module", () => {
		const repo = makePolyglotRepo();
		const target = new TestRunnerClient(false).getTestRunTarget(
			repo.goSource,
			repo.root,
		);
		expect(target?.runner).toBe("go");
		expect(target?.strategy).toBe("related");
		expect(target?.testFile).toBe(repo.goCompanionTest);
	});

	it("does not serve one module's runner verdict to a file in another module", () => {
		// The availability memo is keyed on the RESOLVED root. Keyed on the
		// dispatch root instead, the first call's positive `gradle` verdict —
		// whose evidence file lives in `app/gw` — answered for every other
		// java file in the repo, including one with no Gradle build anywhere
		// above it.
		const root = makeRoot("pi-lens-2870-memo-");
		write(root, "go.mod", "module example.com/z\n");
		write(root, "app/gw/build.gradle.kts");
		const inModule = write(
			root,
			"app/gw/src/test/java/FooTest.java",
			"class FooTest {}\n",
		);
		const outsideAnyModule = write(
			root,
			"other/src/test/java/BarTest.java",
			"class BarTest {}\n",
		);

		const client = new TestRunnerClient(false);
		expect(client.getTestRunTarget(inModule, root)?.runner).toBe("gradle");
		expect(client.getTestRunTarget(outsideAnyModule, root)).toBeNull();
	});

	it("keeps the pre-#2870 resolution for a file outside the project root", () => {
		// #2522's fail-closed contract: an out-of-tree target must still be
		// PRODUCED so the exclusion layer refuses it, rather than disappearing
		// into "no runner". The legacy branch skips the kind gate for exactly
		// this case, so a foreign-kind file out of tree is refused loudly too.
		const parent = makeRoot("pi-lens-2870-outoftree-");
		const project = path.join(parent, "project");
		fs.mkdirSync(project, { recursive: true });
		write(project, "vitest.config.ts", "export default {}\n");
		const strayTs = write(parent, "outside/stray.test.ts", "export {};\n");
		const strayJava = write(
			parent,
			"outside/src/test/java/StrayTest.java",
			"class StrayTest {}\n",
		);

		const client = new TestRunnerClient(false);
		const tsTarget = client.getTestRunTarget(strayTs, project);
		expect(tsTarget?.runner).toBe("vitest");
		expect(isExcludedTestTarget(tsTarget!.testFile, project)).toBe(true);

		const javaTarget = client.getTestRunTarget(strayJava, project);
		expect(javaTarget?.runner).toBe("vitest");
		expect(isExcludedTestTarget(javaTarget!.testFile, project)).toBe(true);
	});

	it("keeps every RUNNERS entry's kinds declared and known", () => {
		// The kind gate is only as complete as the table: an entry with no
		// `kinds` would be unreachable for every file, and one naming a kind
		// `file-kinds.ts` does not know would be unreachable in silence.
		for (const [name, config] of Object.entries(RUNNERS)) {
			expect(config.kinds.length, `${name} declares no kinds`).toBeGreaterThan(
				0,
			);
			for (const kind of config.kinds) {
				expect(
					Object.hasOwn(KIND_EXTENSIONS, kind),
					`${name} declares unknown kind ${kind}`,
				).toBe(true);
			}
		}
	});
});
