import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestRunnerClient, RUNNERS } from "../../clients/test-runner-client.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** Write a tree of files under a fresh temp root. */
function makeProject(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-polyglot-"));
	tempDirs.push(root);
	for (const [rel, body] of Object.entries(files)) {
		const target = path.join(root, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, body);
	}
	return root;
}

/** One repo root that is BOTH a Go module and a Gradle build, plus a nested
 *  Gradle module and two nested Go modules — the shape that produced the bug. */
function makePolyglotRepo(): string {
	return makeProject({
		"go.mod": "module example.com/root\n",
		"build.gradle.kts": "// composite root\n",
		"settings.gradle.kts": 'rootProject.name = "root"\n',
		"app/svc/build.gradle.kts": "plugins { java }\n",
		"app/svc/src/test/java/com/x/SvcTest.java":
			"package com.x;\nclass SvcTest {}\n",
		"tools/tapctl/go.mod": "module example.com/tapctl\n",
		"tools/tapctl/main.go": "package main\n",
		"pkg/gotap/go.mod": "module example.com/gotap\n",
		"pkg/gotap/x.go": "package gotap\n",
		"root_pkg/main.go": "package main\n",
		"docs/readme.md": "# hi\n",
	});
}

interface Anchor {
	runner: string;
	anchorDir: string;
}

function anchor(
	client: TestRunnerClient,
	rel: string,
	root: string,
): Anchor | null {
	return (
		(client as any).resolveProjectAnchor(path.resolve(root, rel), root) ?? null
	);
}

describe("test-runner project anchoring (polyglot repos)", () => {
	it("never hands a .java file to the go runner in a polyglot repo", () => {
		const root = makePolyglotRepo();
		const client = new TestRunnerClient(false);

		// The root declares BOTH go.mod and build.gradle.kts, and `go` comes
		// before `gradle` in RUNNERS — so resolving against the repo root alone
		// picked `go` for this file, and `go test` answered
		// "FAIL <pkg> [setup failed]" (a runner error, not a test failure).
		expect(
			client.getTestRunTarget(
				path.resolve(root, "app/svc/src/test/java/com/x/SvcTest.java"),
				root,
			),
		).toBeNull();
	});

	it("anchors a .java file at its own Gradle module, not the repo root", () => {
		const root = makePolyglotRepo();
		const client = new TestRunnerClient(false);

		const resolved = anchor(
			client,
			"app/svc/src/test/java/com/x/SvcTest.java",
			root,
		);
		expect(resolved?.runner).toBe("gradle");
		expect(resolved?.anchorDir).toBe(path.join(root, "app", "svc"));
	});

	it("anchors each .go file at ITS own module", () => {
		const root = makePolyglotRepo();
		const client = new TestRunnerClient(false);

		expect(anchor(client, "tools/tapctl/main.go", root)?.anchorDir).toBe(
			path.join(root, "tools", "tapctl"),
		);
		expect(anchor(client, "pkg/gotap/x.go", root)?.anchorDir).toBe(
			path.join(root, "pkg", "gotap"),
		);
		// No nearer go.mod: the repo root itself is the owning module.
		expect(anchor(client, "root_pkg/main.go", root)?.anchorDir).toBe(
			path.resolve(root),
		);
	});

	it("returns null rather than guessing when the nearest runner speaks another language", () => {
		const root = makePolyglotRepo();
		const client = new TestRunnerClient(false);

		// At the root `go` wins the declaration order; a .java file there has no
		// runner that serves it, and "no target" is the correct answer — handing
		// it to `go test` is what produced the noise.
		expect(anchor(client, "Svc.java", root)).toBeNull();
	});

	it("falls back to root resolution for a file outside the project root", () => {
		const root = makePolyglotRepo();
		const client = new TestRunnerClient(false);

		// #2522: getTestRunTarget must still resolve an out-of-tree file so the
		// built-in exclusion layer can fail it closed one layer later. The anchor
		// falls back to the project root (not the file's own outside directory).
		expect(anchor(client, "../outside.go", root)?.anchorDir).toBe(
			path.resolve(root),
		);
		// ...while the language gate still applies.
		expect(anchor(client, "../Outside.java", root)).toBeNull();
	});

	it("still returns a target for an out-of-tree test file (exclusion layer owns the verdict)", () => {
		// Mirrors tests/clients/test-runner-client.test.ts #2522 R2: resolving the
		// file is not the layer that refuses it.
		const root = makeProject({
			"project/vitest.config.ts": "export default {}\n",
			"outside/stray.test.ts": "export {};\n",
		});
		const client = new TestRunnerClient(false);

		const target = client.getTestRunTarget(
			path.join(root, "outside", "stray.test.ts"),
			path.join(root, "project"),
		);
		expect(target?.strategy).toBe("self");
	});

	it("returns null for an undeclared extension without probing any directory", () => {
		// The extension gate is a FAST PATH: the walk below would reach the same
		// verdict, but only after calling detectRunner (and so stat-ing) every
		// ancestor directory. Pin the short-circuit itself — an outcome-equivalent
		// gate with no test that reds when it is deleted is a vacuous guard, and
		// the per-file turn-end path pays this cost on every edit.
		const root = makePolyglotRepo();
		const client = new TestRunnerClient(false);
		const probe = vi.spyOn(client as any, "detectRunner");

		expect(
			client.getTestRunTarget(path.resolve(root, "docs/readme.md"), root),
		).toBeNull();
		expect(probe).not.toHaveBeenCalled();
	});

	it("still runs a whole-project gradle build when the file belongs to the project at cwd", () => {
		// Single-module Gradle project: no nested module to anchor at, so the
		// whole-build invocation stays allowed exactly as before.
		const root = makeProject({
			"build.gradle.kts": "plugins { java }\n",
			"src/test/java/com/x/FooTest.java": "package com.x;\nclass FooTest {}\n",
		});
		const client = new TestRunnerClient(false);

		expect(
			client.getTestRunTarget(
				path.resolve(root, "src/test/java/com/x/FooTest.java"),
				root,
			)?.runner,
		).toBe("gradle");
	});

	it("keeps vitest working for a .ts test file", () => {
		const root = makeProject({
			"vitest.config.ts": "export default {}\n",
			"src/foo.test.ts": "export {};\n",
		});
		const client = new TestRunnerClient(false);

		expect(
			client.getTestRunTarget(path.resolve(root, "src/foo.test.ts"), root)
				?.runner,
		).toBe("vitest");
	});

	it("keeps go companion-test discovery working", () => {
		const root = makeProject({
			"go.mod": "module example.com/x\n",
			"foo.go": "package x\n",
			"foo_test.go": "package x\n",
		});
		const client = new TestRunnerClient(false);

		const target = client.getTestRunTarget(path.resolve(root, "foo.go"), root);
		expect(target?.runner).toBe("go");
		expect(target && path.basename(target.testFile)).toBe("foo_test.go");
	});

	it("declares the languages of every runner so the gate cannot drift", () => {
		// The gate and the runner table must share ONE source of truth: a runner
		// with no `exts` would be silently un-gated, and a language missing from
		// every `exts` can never be a test target.
		for (const [name, config] of Object.entries(RUNNERS)) {
			expect(
				config.exts.length,
				`${name} declares no extensions`,
			).toBeGreaterThan(0);
			for (const ext of config.exts) {
				expect(ext.startsWith("."), `${name} ext ${ext} is not dotted`).toBe(
					true,
				);
			}
		}
	});
});
