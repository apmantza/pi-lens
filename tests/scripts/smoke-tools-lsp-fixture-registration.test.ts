// flake-shape: real-process-spawn — the fixture-ordering defect lives in the
// CLI entry point's own module-load order and its real dist/clients/lsp/*.js
// imports; an in-process call can't reproduce "which fixture registered a
// session root first" without literally being the script under test.
/**
 * #2369/#2655. The nightly `--lsp` lane's auxiliary rows (opengrep, ast-grep,
 * zizmor, typos, ast-grep-baseline) went to zero on every run from 2026-08-26
 * onward. Root cause: `scripts/smoke-tools.mjs` called `initLSPConfig(workspace)`
 * (which registers the workspace as a served session root, #2052) ONLY inside
 * the `disableServers` branch. Fixture order in `LSP_FIXTURES` is load-bearing:
 * once `expert` (a `disableServers` fixture) registered its OWN temp
 * workspace, the session-root registry flipped from empty (fail-open — see
 * `clients/lsp/session-roots.ts`) to non-empty, and every LATER fixture that
 * never registered its own fresh temp workspace was declined by
 * `isOutsideAllSessionRoots` — silently, with zero diagnostics, indistinguishable
 * from the tool genuinely finding nothing. The exact same shape independently
 * affected `characterize-lsp.mjs`, `probe-clean-signal.mjs`, and
 * `server-capabilities.mjs` (#2655), and `bench-lsp.mjs` (#2658) shared the
 * identical shape — all five scripts now route through one bootstrap,
 * `scripts/lib/lsp-fixture-workspace.mjs`'s `bootstrapFixtureWorkspace`
 * (#2670), which itself calls this guard, `scripts/lib/
 * lsp-fixture-session-guard.mjs`'s `assertFixtureWorkspaceRegistered`.
 *
 * This file has two layers:
 *
 * 1. A REAL spawn of `smoke-tools.mjs --lsp` (the exact nightly entry point,
 *    not a stand-in) against two fixtures that reproduce the ordering
 *    dependency without any network access or `--install`: `expert` (a
 *    `disableServers` fixture that registers a workspace) followed by
 *    `ast-grep` (a plain auxiliary fixture, whose tool ships in
 *    `node_modules/@ast-grep/cli-linux-x64-gnu` so it never needs
 *    installing). `expert`'s own tool binary is never installed here, so its
 *    row fails for an unrelated, pre-existing reason (no warm client) — not
 *    this guard's business. Uses `spawnSync`'s native `timeout` option
 *    rather than a raw `setTimeout`/kill-timer, so the child's own bounded
 *    wait is Node's child_process timeout handling, not a hand-rolled one.
 * 2. An in-process unit test of the shared guard module itself
 *    (`assertFixtureWorkspaceRegistered`), covering it ONCE rather than
 *    spawning a real child process per sibling script that imports it —
 *    the fixture-ordering defect is already pinned end-to-end by layer 1;
 *    layer 2 only needs to prove the EXTRACTED function's own two branches
 *    (registered → resolves, unregistered → throws naming both issues)
 *    against the REAL `dist/clients/lsp/session-roots.js` module the helper
 *    itself imports — not a mock of it, so a real signature drift in either
 *    module is what this test would catch.
 *
 * PI_LENS_HOME/PILENS_DATA_DIR are pinned to a throwaway per-test directory —
 * never the maintainer's real `~/.pi-lens` (#2506).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const SMOKE_ENTRY = path.join(repoRoot, "scripts", "smoke-tools.mjs");
const CHILD_TIMEOUT_MS = 30_000;

const tmpDirs: string[] = [];
function freshTmpDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function runSmokeLsp(args: string[]): { stdout: string; stderr: string } {
	const home = freshTmpDir("pi-lens-2369-home-");
	const dataDir = freshTmpDir("pi-lens-2369-data-");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_LENS_HOME: home,
		PILENS_DATA_DIR: dataDir,
		HOME: home,
		USERPROFILE: home,
	};
	const result = spawnSync(process.execPath, [SMOKE_ENTRY, ...args], {
		cwd: repoRoot,
		env,
		encoding: "utf8",
		timeout: CHILD_TIMEOUT_MS,
	});
	if (result.error) {
		throw new Error(
			`smoke-tools --lsp child failed to run: ${result.error.message}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
		);
	}
	if (result.signal) {
		throw new Error(
			`smoke-tools --lsp child was killed by ${result.signal} (likely the ${CHILD_TIMEOUT_MS}ms timeout)\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
		);
	}
	return { stdout: result.stdout, stderr: result.stderr };
}

describe("smoke-tools --lsp: every fixture registers its own session root (#2369)", () => {
	it("does not decline a plain auxiliary fixture after an earlier fixture registers a foreign workspace", () => {
		const { stdout, stderr } = runSmokeLsp([
			"--lsp",
			"--verbose",
			"expert",
			"ast-grep",
		]);

		// The harness-level guard (scripts/smoke-tools.mjs, right before the
		// touch) must never fire on correct code — it throws and crashes the
		// process the moment a fixture workspace is touched unregistered.
		expect(stderr).not.toMatch(/#2369/);

		const astGrepRow = stdout
			.split("\n")
			.find(
				(line) =>
					line.trimStart().startsWith("✓") &&
					line.includes("ast-grep") &&
					!line.includes("expert"),
			);
		expect(
			astGrepRow,
			`expected a passing ast-grep row in report:\n${stdout}\nstderr:\n${stderr}`,
		).toBeDefined();

		// The original defect's exact signature: zero diagnostics, "0/0" matched.
		// `--verbose` logs this to stderr as `aux=ast-grep matched=0/0 sources=[]`.
		expect(stderr).not.toMatch(/aux=ast-grep matched=0\/0/);
		expect(stderr).toMatch(/aux=ast-grep matched=1\/1/);
	});
});

describe("assertFixtureWorkspaceRegistered: the guard shared by all five LSP harness scripts via bootstrapFixtureWorkspace (#2369/#2655/#2658/#2670)", () => {
	const guardEntry = path.join(
		repoRoot,
		"scripts",
		"lib",
		"lsp-fixture-session-guard.mjs",
	);
	const sessionRootsEntry = path.join(
		repoRoot,
		"dist",
		"clients",
		"lsp",
		"session-roots.js",
	);

	let assertFixtureWorkspaceRegistered: (
		lang: string,
		workspace: string,
	) => Promise<void>;
	let registerSessionRoot: (cwd: string) => void;
	let resetSessionRootsForTests: () => void;

	beforeEach(async () => {
		// Both modules are loaded from the SAME dist/ path the real harness
		// scripts use, in the SAME process, so this exercises the actual
		// production module the guard reads from — not a mock standing in for
		// it. Fresh dynamic import each run (module cache is process-lifetime,
		// but the registry itself is reset below) matches how every one of the
		// five calling scripts loads it (via bootstrapFixtureWorkspace, #2670).
		({ assertFixtureWorkspaceRegistered } = await import(
			pathToFileURL(guardEntry).href
		));
		({ registerSessionRoot, resetSessionRootsForTests } = await import(
			pathToFileURL(sessionRootsEntry).href
		));
		resetSessionRootsForTests();
	});

	it("resolves once the workspace has been registered", async () => {
		const workspace = "/tmp/pi-lens-guard-test-registered";
		registerSessionRoot(workspace);
		await expect(
			assertFixtureWorkspaceRegistered("some-lang", workspace),
		).resolves.toBeUndefined();
	});

	it("throws naming both issues when the workspace was never registered", async () => {
		// A DIFFERENT root is registered (as a real multi-fixture run would
		// have one from an earlier fixture) — this is exactly the pre-#2369
		// failure shape: SOME root is served, but not this one.
		registerSessionRoot("/tmp/pi-lens-guard-test-foreign-root");
		const workspace = "/tmp/pi-lens-guard-test-unregistered";
		await expect(
			assertFixtureWorkspaceRegistered("some-lang", workspace),
		).rejects.toThrow(/#2369\/#2655/);
		await expect(
			assertFixtureWorkspaceRegistered("some-lang", workspace),
		).rejects.toThrow(workspace);
	});
});
