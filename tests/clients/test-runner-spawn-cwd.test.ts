/**
 * #2871 — the test-runner child takes its cwd from `resolveToolCwd`.
 *
 * Recurrence this file prevents (AGENTS.md defect shape 40, "a tool root
 * resolved at a different seam than its child spawn"): `runTestFileAsync`
 * handed `safeSpawnAsync` the DISPATCH root and built `RUNNERS.go.args`
 * against it, so a `.go` file in a nested module ran
 * `go test -run . ./tools/tapctl/internal/lightning` from a root module that
 * does not own that package. Measured on master with a fake `go` recording
 * its cwd and argv:
 *
 *   go	cwd=<repo root>	argv=test -run . ./tools/tapctl/internal/lightning
 *
 * Everything below drives the REAL `runTestFileAsync` — the real selection of
 * markers, the real seam, the real arg builders — and fakes only the process
 * boundary (`safeSpawnAsync`), which is where the child's cwd and argv are
 * observed. A real spawn would add nothing this cannot see and would need
 * `flake-shape-ratchet` admission for a shape the fix does not require.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	SafeSpawnOptions,
	SpawnResult,
} from "../../clients/safe-spawn.js";

type SafeSpawnAsync = (
	command: string,
	args: string[],
	options?: SafeSpawnOptions,
) => Promise<SpawnResult>;

const spawned: Array<{ command: string; args: string[]; cwd?: string }> = [];
let spawnResult: SpawnResult = { stdout: "", stderr: "", status: 0 };

const { findGlobalBinary, safeSpawnAsync, logExtension } = vi.hoisted(() => ({
	findGlobalBinary: vi.fn(async () => undefined),
	safeSpawnAsync: vi.fn<SafeSpawnAsync>(),
	logExtension: vi.fn(),
}));

// The no-argument `importOriginal()` pass-through is the idiom
// `tests/config/vi-mock-export-sweep.test.ts` recognises as complete (#2784):
// a type-argument spelling reads to that scan as a factory that drops every
// other export.
vi.mock("../../clients/package-manager.js", async (importOriginal) => ({
	...(await importOriginal()),
	findGlobalBinary,
}));
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal()),
	safeSpawnAsync,
}));
vi.mock("../../clients/extension-log.js", async (importOriginal) => ({
	...(await importOriginal()),
	logExtension,
}));

import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import { RUNNERS, TestRunnerClient } from "../../clients/test-runner-client.js";
import { removeTempDirSync } from "./test-utils.js";

const dirs: string[] = [];

beforeEach(() => {
	spawned.length = 0;
	spawnResult = { stdout: "", stderr: "", status: 0 };
	safeSpawnAsync.mockImplementation(async (command, args, options) => {
		spawned.push({ command, args, cwd: options?.cwd });
		return spawnResult;
	});
	logExtension.mockClear();
	// The seam's once-per-resolution-key log throttle rides the degradation
	// ledger's generation, so every case starts with a fresh latch — which is
	// what makes the once-per-key assertion below mean anything.
	resetDegradationLedger();
});

afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

function makeRoot(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	// The seam's fallbacks are `$HOME`-capped; a fixture under the OS temp
	// root is outside `$HOME`, which is what makes the out-of-tree case below
	// reach the home-cap branch.
	return fs.realpathSync.native(dir);
}

function write(root: string, relative: string, content = "\n"): string {
	const target = path.join(root, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	return target;
}

function toolCwdLines(): string[] {
	return logExtension.mock.calls
		.map(([entry]) => entry as { subsystem?: string; message?: string })
		.filter((entry) => entry.subsystem === "tool-cwd")
		.map((entry) => entry.message ?? "");
}

describe("#2871 the test-runner child's cwd comes from resolveToolCwd", () => {
	it("runs a nested Go module's test from that module, with a module-relative package", async () => {
		const root = makeRoot("pi-lens-2871-go-");
		write(root, "go.mod", "module example.com/x\n");
		const module = path.join(root, "tools", "tapctl");
		write(root, "tools/tapctl/go.mod", "module example.com/tapctl\n");
		const testFile = write(
			root,
			"tools/tapctl/internal/lightning/bolt_test.go",
			"package lightning\n",
		);

		await new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"go",
			RUNNERS.go,
		);

		expect(spawned).toHaveLength(1);
		expect(spawned[0].cwd).toBe(module);
		expect(spawned[0].args).toEqual([
			"test",
			"-run",
			".",
			"./internal/lightning",
		]);
		// Observability: one `tool-cwd` line per resolution key per session,
		// naming the marker that decided it.
		expect(toolCwdLines()).toEqual([
			`cwd runner go cwd=${module} reason=marker:go.mod`,
		]);
	});

	it("logs the resolution once per key, not once per run", async () => {
		const root = makeRoot("pi-lens-2871-once-");
		write(root, "go.mod", "module example.com/x\n");
		write(root, "tools/tapctl/go.mod", "module example.com/tapctl\n");
		const testFile = write(
			root,
			"tools/tapctl/internal/lightning/bolt_test.go",
			"package lightning\n",
		);

		const client = new TestRunnerClient(false);
		await client.runTestFileAsync(testFile, root, "go", RUNNERS.go);
		await client.runTestFileAsync(testFile, root, "go", RUNNERS.go);

		expect(spawned).toHaveLength(2);
		expect(toolCwdLines()).toHaveLength(1);
	});

	it("keeps a wrapper-launched Gradle build at the directory that owns the wrapper", async () => {
		// The refusal #2870 relies on: `RUNNERS.gradle.command` is the literal
		// `./gradlew`, so a cwd moved to a module carrying only
		// `build.gradle.kts` would be `spawn ./gradlew ENOENT`.
		const root = makeRoot("pi-lens-2871-gradle-");
		write(root, "build.gradle.kts");
		write(root, "gradlew", "#!/bin/sh\n");
		write(root, "app/gw/build.gradle.kts");
		const testFile = write(
			root,
			"app/gw/src/test/java/com/x/FooTest.java",
			"class FooTest {}\n",
		);

		await new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"gradle",
			RUNNERS.gradle,
		);

		expect(spawned[0].cwd).toBe(root);
		// The command is resolved against the child's cwd, so the invariant is
		// "the launcher exists where the child runs" — what an ENOENT would
		// have proven.
		expect(fs.existsSync(path.join(spawned[0].cwd!, "gradlew"))).toBe(true);
	});

	it("runs a self-contained Gradle module that carries its own wrapper from that module", async () => {
		const root = makeRoot("pi-lens-2871-gradle-nested-");
		write(root, "build.gradle.kts");
		write(root, "gradlew", "#!/bin/sh\n");
		const module = path.join(root, "app", "gw");
		write(root, "app/gw/build.gradle.kts");
		write(root, "app/gw/gradlew", "#!/bin/sh\n");
		const testFile = write(
			root,
			"app/gw/src/test/java/com/x/FooTest.java",
			"class FooTest {}\n",
		);

		await new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"gradle",
			RUNNERS.gradle,
		);

		expect(spawned[0].cwd).toBe(module);
		expect(fs.existsSync(path.join(spawned[0].cwd!, "gradlew"))).toBe(true);
	});

	// Review round 2, F6: the two cases that used to sit here — an
	// out-of-tree file clamped back to the dispatch root, and the bounded
	// `tool-cwd-resolution` row that recorded the refusal — are gone with the
	// clamp itself. Neither could fire in a live session: the one production
	// caller filters every target through `isExcludedTestTarget`, which fails
	// closed out of tree (#2522), and the seam only answers outside the
	// dispatch root for a file that is already outside it. They were a guard
	// against a caller that does not exist and a record nothing could observe.

	// Review round 3, F7. Two `configFiles` members are CONTENT-conditional in
	// detection — `pytest` accepts `pyproject.toml` only with
	// `[tool.pytest.ini_options]`, `phpunit` accepts `composer.json` only with
	// a `phpunit/phpunit` dependency — but the cwd seam walks basenames, so
	// handing the table over verbatim anchored the child on the very file the
	// detector had REFUSED as evidence. Round 2's dispatch-root re-probe is
	// what made it reachable end to end: detection succeeds at the root, and
	// the spawn walk then stops below it on the rejected marker. Measured with
	// a fake phpunit recording its own cwd: `<root>/app`, `NO phpunit.xml IN
	// CWD`, where master ran in `<root>` with the config found. phpunit reads
	// `phpunit.xml` from its cwd only, so that child has no bootstrap and no
	// autoloader, and its fatal error reaches the agent as a test failure.
	it("does not anchor the phpunit child on a composer.json the detector rejected", async () => {
		const root = makeRoot("pi-lens-2879-f7-phpunit-");
		write(root, "phpunit.xml", "<phpunit bootstrap='vendor/autoload.php'/>\n");
		write(root, "app/composer.json", '{"require":{"monolog/monolog":"^3"}}\n');
		const testFile = write(root, "app/tests/ThingTest.php", "<?php\n");

		await new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"phpunit",
			RUNNERS.phpunit,
		);

		expect(spawned[0].cwd).toBe(root);
		// The invariant, not just the path: the child runs where its config is.
		expect(fs.existsSync(path.join(spawned[0].cwd!, "phpunit.xml"))).toBe(true);
	});

	it("still anchors the phpunit child on a module that carries its own phpunit.xml", async () => {
		// The markers are narrowed, not removed: real phpunit evidence in a
		// module still moves the child there.
		const root = makeRoot("pi-lens-2879-f7-phpunit-nested-");
		write(root, "phpunit.xml", "<phpunit/>\n");
		const module = path.join(root, "app");
		write(root, "app/phpunit.xml", "<phpunit/>\n");
		const testFile = write(root, "app/tests/ThingTest.php", "<?php\n");

		await new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"phpunit",
			RUNNERS.phpunit,
		);

		expect(spawned[0].cwd).toBe(module);
	});

	it("does not anchor the pytest child on a pyproject.toml the detector rejected", async () => {
		const root = makeRoot("pi-lens-2879-f7-pytest-");
		write(root, "pytest.ini", "[pytest]\n");
		// No `[tool.pytest.ini_options]`: an anchor for the language, never
		// pytest configuration.
		write(root, "svc/pyproject.toml", "[project]\nname='svc'\n");
		const testFile = write(
			root,
			"svc/tests/test_thing.py",
			"def test_x():\n    pass\n",
		);

		await new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"pytest",
			RUNNERS.pytest,
		);

		expect(spawned[0].cwd).toBe(root);
		expect(fs.existsSync(path.join(spawned[0].cwd!, "pytest.ini"))).toBe(true);
	});

	it("keeps the failed-target ledger keyed on the dispatch root", async () => {
		// One `cwd` used to do six jobs here. The ledger `getTestRunTarget`
		// reads is keyed by the dispatch root; keying it by the resolved module
		// instead would make a recorded failure unfindable from the turn that
		// selects targets.
		const root = makeRoot("pi-lens-2871-ledger-");
		write(root, "go.mod", "module example.com/x\n");
		write(root, "tools/tapctl/go.mod", "module example.com/tapctl\n");
		const testFile = write(
			root,
			"tools/tapctl/internal/lightning/bolt_test.go",
			"package lightning\n",
		);
		const source = write(
			root,
			"tools/tapctl/internal/lightning/bolt.go",
			"package lightning\n",
		);
		spawnResult = {
			stdout: "",
			stderr:
				"--- FAIL: TestBolt\n    bolt_test.go:5: boom\nFAIL\texample.com/tapctl/internal/lightning\t0.01s\n",
			status: 1,
		};

		const client = new TestRunnerClient(false);
		const result = await client.runTestFileAsync(
			testFile,
			root,
			"go",
			RUNNERS.go,
		);
		expect(result.failed).toBe(1);

		// The failed-first strategy only finds this target if the record went
		// in under the dispatch root.
		const target = client.getTestRunTarget(source, root);
		expect(target?.strategy).toBe("failed-first");
		expect(target?.testFile).toBe(testFile);
	});

	it("reports go's [setup failed] verdict as a runner error through the real run path", async () => {
		// #2870's parser half, end to end: the whole point of the selection fix
		// is that this line stops appearing, but when it does appear it is
		// advisory, never `✗ 1/1 failed`.
		const root = makeRoot("pi-lens-2871-setup-failed-");
		write(root, "go.mod", "module example.com/x\n");
		const testFile = write(root, "pkg/thing_test.go", "package thing\n");
		spawnResult = {
			stdout: "",
			stderr: "FAIL\texample.com/x/pkg [setup failed]\n",
			status: 1,
		};

		const result = await new TestRunnerClient(false).runTestFileAsync(
			testFile,
			root,
			"go",
			RUNNERS.go,
		);

		expect(result.failed).toBe(0);
		expect(result.error).toBe("Runner go exited with 1");
		expect(result.failures).toEqual([]);
	});
});
