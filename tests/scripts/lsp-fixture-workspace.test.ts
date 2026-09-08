/**
 * #2670 (folds #2658). `bootstrapFixtureWorkspace`/`withScratchHome`
 * (scripts/lib/lsp-fixture-workspace.mjs) are the shared "copy fixture →
 * register session root → optional disable+reload → optional git init →
 * assert registered" bootstrap for all five LSP dev-harness scripts, plus
 * the PI_LENS_HOME/PILENS_DATA_DIR scratch-home pin (#2506 shape).
 *
 * In-process against the REAL `dist/clients/lsp/config.js` and
 * `dist/clients/lsp/session-roots.js` — not a mock of either — so a real
 * signature drift in the helper's own dependencies is what this file would
 * catch. One in-process pass here covers all five call sites' shared
 * plumbing; `tests/scripts/smoke-tools-lsp-fixture-registration.test.ts`
 * keeps the one real-spawn smoke case that needs an actual CLI process
 * (fixture-ORDER is a whole-process property no in-process call can
 * reproduce).
 *
 * `repoRoot` passed to the helper in these tests is a throwaway temp dir
 * standing in for the real repo — the helper only ever does
 * `fs.cpSync(path.join(repoRoot, fx.dir), workspace, ...)`, so a tiny fake
 * fixture tree is enough and keeps this file independent of the real
 * LSP_FIXTURES set.
 *
 * PI_LENS_HOME/PILENS_DATA_DIR: `tests/support/vitest-setup.ts` already pins
 * PI_LENS_HOME to a per-worker temp dir for every test in this run (#2506).
 * The `withScratchHome` describe block below deliberately unsets it for a
 * few tests to exercise the "nothing pinned yet" branch, and restores it in
 * `afterEach` — never leaving it unset for a later test in this file or
 * worker.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCRATCH_DIR_ROOT } from "../../scripts/lib/scratch-dir.mjs";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

// #2670 review F5: was the generic "test-" (collides in spirit with every
// OTHER file's ad-hoc temp prefix, and gave no hint which suite left a dir
// behind). Distinctive enough to grep a leaked `/tmp` entry back to this file.
const WORKSPACE_TEST_PREFIX = "lsp-fixture-workspace-test-";

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

describe("bootstrapFixtureWorkspace (#2670/#2658)", () => {
	let bootstrapFixtureWorkspace: (
		fx: Record<string, unknown>,
		opts: Record<string, unknown>,
	) => Promise<{
		workspace: string;
		absFile: string;
		cleanup: () => void;
		disabledServers: string[];
	}>;
	let initLSPConfig: (cwd: string) => Promise<void>;
	let isSessionRootRegistered: (cwd: string) => boolean;
	let resetLSPConfigStateForTests: () => void;
	let fakeRepoRoot: string;

	const fx = { lang: "test-lang", dir: "fx-dir", file: "a.txt" };

	beforeEach(async () => {
		({ bootstrapFixtureWorkspace } = await import(
			pathToFileURL(
				path.join(repoRoot, "scripts", "lib", "lsp-fixture-workspace.mjs"),
			).href
		));
		({ initLSPConfig, resetLSPConfigStateForTests } = await import(
			pathToFileURL(path.join(repoRoot, "dist", "clients", "lsp", "config.js"))
				.href
		));
		({ isSessionRootRegistered } = await import(
			pathToFileURL(
				path.join(repoRoot, "dist", "clients", "lsp", "session-roots.js"),
			).href
		));
		resetLSPConfigStateForTests();
		fakeRepoRoot = freshTmpDir("lsp-fixture-workspace-repo-");
		fs.mkdirSync(path.join(fakeRepoRoot, "fx-dir"));
		fs.writeFileSync(path.join(fakeRepoRoot, "fx-dir", "a.txt"), "hello\n");
	});

	it("copies the fixture, registers the workspace as a session root, and returns workspace/absFile/cleanup", async () => {
		const { workspace, absFile, cleanup } = await bootstrapFixtureWorkspace(
			fx,
			{
				initLSPConfig,
				repoRoot: fakeRepoRoot,
				tmpPrefix: WORKSPACE_TEST_PREFIX,
			},
		);
		// Tracked BEFORE any assertion, so an assertion failure below still
		// leaves this workspace swept by afterEach (#2670 review F5) — this
		// test in particular then exercises `cleanup()` itself, so the sweep
		// below is a harmless no-op (`force: true`) on an already-removed dir.
		tmpDirs.push(workspace);
		expect(fs.existsSync(absFile)).toBe(true);
		expect(fs.readFileSync(absFile, "utf8")).toBe("hello\n");
		expect(isSessionRootRegistered(workspace)).toBe(true);
		cleanup();
		expect(fs.existsSync(workspace)).toBe(false);
	});

	// The whole point of #2369/#2655/#2658: registration must not depend on
	// anything else about the fixture. No `disableServers`, no `gitInit` — the
	// workspace must still be a registered session root.
	it("registers the workspace unconditionally even when nothing else about the fixture requires it", async () => {
		const { workspace } = await bootstrapFixtureWorkspace(fx, {
			initLSPConfig,
			repoRoot: fakeRepoRoot,
			tmpPrefix: WORKSPACE_TEST_PREFIX,
		});
		tmpDirs.push(workspace); // #2670 review F5 — this test never called cleanup()
		expect(isSessionRootRegistered(workspace)).toBe(true);
	});

	it("throws (never silently proceeds) when the caller's initLSPConfig doesn't actually register the workspace", async () => {
		const brokenInitLSPConfig = async () => {
			// simulates a caller wiring bug: doesn't call the real registrar
		};
		// A pre-made, TRACKED workspace (#2670 review F5) rather than letting
		// the helper mint its own via `tmpPrefix`: the promise below REJECTS,
		// so there is no `{ workspace }` to destructure and track afterward —
		// the only way to guarantee this dir is swept is to already own its
		// path before the call.
		const workspace = freshTmpDir(WORKSPACE_TEST_PREFIX);
		await expect(
			bootstrapFixtureWorkspace(fx, {
				initLSPConfig: brokenInitLSPConfig,
				repoRoot: fakeRepoRoot,
				workspace,
			}),
		).rejects.toThrow(/#2369\/#2655/);
	});

	it("git-inits the workspace when gitInit is true", async () => {
		const { workspace, cleanup } = await bootstrapFixtureWorkspace(fx, {
			initLSPConfig,
			repoRoot: fakeRepoRoot,
			tmpPrefix: WORKSPACE_TEST_PREFIX,
			gitInit: true,
		});
		tmpDirs.push(workspace);
		expect(fs.existsSync(path.join(workspace, ".git"))).toBe(true);
		cleanup();
	});

	it("does not git-init when gitInit is omitted and the fixture doesn't request it", async () => {
		const { workspace, cleanup } = await bootstrapFixtureWorkspace(fx, {
			initLSPConfig,
			repoRoot: fakeRepoRoot,
			tmpPrefix: WORKSPACE_TEST_PREFIX,
		});
		tmpDirs.push(workspace);
		expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);
		cleanup();
	});

	it("falls back to fx.disableServers when no override is given, writing .pi-lens/lsp.json", async () => {
		const { workspace, disabledServers, cleanup } =
			await bootstrapFixtureWorkspace(
				{ ...fx, disableServers: ["typescript"] },
				{
					initLSPConfig,
					repoRoot: fakeRepoRoot,
					tmpPrefix: WORKSPACE_TEST_PREFIX,
				},
			);
		tmpDirs.push(workspace);
		expect(disabledServers).toEqual(["typescript"]);
		const written = JSON.parse(
			fs.readFileSync(path.join(workspace, ".pi-lens", "lsp.json"), "utf8"),
		);
		expect(written).toEqual({ disabledServers: ["typescript"] });
		cleanup();
	});

	it("writes nothing under .pi-lens when there is nothing to disable", async () => {
		const { workspace, cleanup } = await bootstrapFixtureWorkspace(fx, {
			initLSPConfig,
			repoRoot: fakeRepoRoot,
			tmpPrefix: WORKSPACE_TEST_PREFIX,
		});
		tmpDirs.push(workspace);
		expect(fs.existsSync(path.join(workspace, ".pi-lens"))).toBe(false);
		cleanup();
	});

	// bench-lsp's (#2658) shape: the disable list depends on servers matching
	// the file INSIDE the just-copied workspace, so it must be computed after
	// copy+register, not passed in as a static list up front.
	it("computes disableServers from a function called AFTER the workspace is copied and registered", async () => {
		const seen: Array<{ workspace: string; absFile: string }> = [];
		const { workspace, absFile, disabledServers, cleanup } =
			await bootstrapFixtureWorkspace(fx, {
				initLSPConfig,
				repoRoot: fakeRepoRoot,
				tmpPrefix: WORKSPACE_TEST_PREFIX,
				disableServers: (ctx: { workspace: string; absFile: string }) => {
					// The workspace must already exist and be registered by the time
					// this runs — assert both, not just record the call.
					expect(fs.existsSync(ctx.absFile)).toBe(true);
					expect(isSessionRootRegistered(ctx.workspace)).toBe(true);
					seen.push(ctx);
					return ["computed-server"];
				},
			});
		tmpDirs.push(workspace);
		expect(seen).toHaveLength(1);
		expect(seen[0].workspace).toBe(workspace);
		expect(seen[0].absFile).toBe(absFile);
		expect(disabledServers).toEqual(["computed-server"]);
		cleanup();
	});

	it("uses a pre-supplied workspace instead of creating a new one (probe-clean-signal's shape)", async () => {
		const preMade = freshTmpDir(WORKSPACE_TEST_PREFIX);
		const { workspace } = await bootstrapFixtureWorkspace(fx, {
			initLSPConfig,
			repoRoot: fakeRepoRoot,
			workspace: preMade,
		});
		expect(workspace).toBe(preMade);
		expect(isSessionRootRegistered(preMade)).toBe(true);
	});
});

describe("withScratchHome (#2670/#2506-shape)", () => {
	let withScratchHome: (opts?: { realHome?: boolean; tmpPrefix?: string }) => {
		dir: string | undefined;
		pinned: boolean;
		restore: () => void;
	};
	let savedHome: string | undefined;
	let savedData: string | undefined;

	beforeEach(async () => {
		({ withScratchHome } = await import(
			pathToFileURL(
				path.join(repoRoot, "scripts", "lib", "lsp-fixture-workspace.mjs"),
			).href
		));
		savedHome = process.env.PI_LENS_HOME;
		savedData = process.env.PILENS_DATA_DIR;
	});

	afterEach(() => {
		// Always restore — `tests/support/vitest-setup.ts` pins PI_LENS_HOME for
		// every other test in this worker; leaving it unset would send a later
		// test's writes to the real home (#2506 shape).
		if (savedHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = savedHome;
		if (savedData === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = savedData;
	});

	it("pins PI_LENS_HOME and PILENS_DATA_DIR to a fresh temp dir when neither is set", () => {
		delete process.env.PI_LENS_HOME;
		delete process.env.PILENS_DATA_DIR;
		const { dir, pinned, restore } = withScratchHome();
		try {
			expect(pinned).toBe(true);
			expect(dir).toBeTruthy();
			expect(process.env.PI_LENS_HOME).toBe(dir);
			expect(process.env.PILENS_DATA_DIR).toBe(dir);
			expect(fs.existsSync(dir as string)).toBe(true);
			// #2670 review round 3 F1: the production `owner.pid` write itself was
			// untested — deleting it left the round-2 suite fully green, AND (per
			// the reviewer) silently reopens R2-F1 for any run older than the 1h
			// age gate: a directory's mtime does not advance on appends to an
			// EXISTING file inside it, so a long-lived, still-writing home reads as
			// "idle" to the age gate the moment it crosses that age, with nothing
			// but this file to say otherwise.
			expect(
				fs.readFileSync(path.join(dir as string, "owner.pid"), "utf8"),
			).toBe(String(process.pid));
		} finally {
			restore();
			fs.rmSync(dir as string, { recursive: true, force: true });
		}
		expect(process.env.PI_LENS_HOME).toBeUndefined();
		expect(process.env.PILENS_DATA_DIR).toBeUndefined();
	});

	it("respects an already-pinned PI_LENS_HOME instead of clobbering the caller's explicit choice", () => {
		process.env.PI_LENS_HOME = "/some/explicit/home";
		delete process.env.PILENS_DATA_DIR;
		const { dir, pinned } = withScratchHome();
		expect(pinned).toBe(false);
		expect(dir).toBe("/some/explicit/home");
		expect(process.env.PI_LENS_HOME).toBe("/some/explicit/home");
		// PILENS_DATA_DIR is untouched when PI_LENS_HOME was already pinned —
		// this call is a pure no-op, not a partial pin.
		expect(process.env.PILENS_DATA_DIR).toBeUndefined();
	});

	it("leaves PILENS_DATA_DIR untouched when the caller already set it explicitly", () => {
		delete process.env.PI_LENS_HOME;
		process.env.PILENS_DATA_DIR = "/some/explicit/data-dir";
		const { dir, restore } = withScratchHome();
		try {
			expect(process.env.PI_LENS_HOME).toBe(dir);
			expect(process.env.PILENS_DATA_DIR).toBe("/some/explicit/data-dir");
		} finally {
			restore();
			fs.rmSync(dir as string, { recursive: true, force: true });
		}
		expect(process.env.PILENS_DATA_DIR).toBe("/some/explicit/data-dir");
	});

	it("does nothing when { realHome: true } is passed", () => {
		delete process.env.PI_LENS_HOME;
		delete process.env.PILENS_DATA_DIR;
		const { dir, pinned } = withScratchHome({ realHome: true });
		expect(pinned).toBe(false);
		expect(dir).toBeUndefined();
		expect(process.env.PI_LENS_HOME).toBeUndefined();
		expect(process.env.PILENS_DATA_DIR).toBeUndefined();
	});

	// #2670 review F2, hardened in review round 2 F1. `lsp-fixture-workspace-test-home-`,
	// NOT anything starting with the production default `lsp-fixture-home-`:
	// the prefix filter is a plain `startsWith`, so a test dir whose name
	// merely EXTENDS the production prefix (round 1's `lsp-fixture-home-
	// sweep-test-<pid>-`) is swept by any real script's OWN default-prefixed
	// sweep running concurrently on the same machine — reviewer round 2 F1's
	// second direction, reproduced live by the prefix collision alone, no
	// mutation needed.
	const SWEEP_TEST_PREFIX = "lsp-fixture-workspace-test-home-";

	function mintScratchHomeDir(): string {
		fs.mkdirSync(SCRATCH_DIR_ROOT, { recursive: true });
		return fs.mkdtempSync(path.join(SCRATCH_DIR_ROOT, SWEEP_TEST_PREFIX));
	}

	function writeOwnerPid(dir: string, pid: number): void {
		fs.writeFileSync(path.join(dir, "owner.pid"), String(pid));
	}

	/**
	 * A pid guaranteed to name no process, without spawning one: Linux's own
	 * `pid_max` (`/proc/sys/kernel/pid_max`, default 4194304, and this repo's
	 * authoritative Unit tests lane is ubuntu — AGENTS.md platform rule) caps
	 * every real pid well under this value, and `process.kill(pid, 0)` on an
	 * out-of-range pid reports the SAME `ESRCH` a genuinely-exited pid would
	 * (verified directly: `process.kill(999_999_999, 0)` throws
	 * `{ code: "ESRCH" }`) — the two are indistinguishable to the code under
	 * test, which only branches on `ESRCH` vs. everything else.
	 */
	const IMPOSSIBLE_PID = 999_999_999;

	it("this file's own test prefix does not start with the production default (never cross-swept either direction)", () => {
		expect(SWEEP_TEST_PREFIX.startsWith("lsp-fixture-home-")).toBe(false);
	});

	it("does not sweep when a home is already pinned (a no-op call touches nothing under os.tmpdir())", () => {
		process.env.PI_LENS_HOME = "/some/explicit/home";
		const leftover = mintScratchHomeDir();
		try {
			withScratchHome({ tmpPrefix: SWEEP_TEST_PREFIX });
			expect(fs.existsSync(leftover)).toBe(true); // untouched — no-op path never sweeps
		} finally {
			fs.rmSync(leftover, { recursive: true, force: true });
		}
	});

	// #2670 review round 2 F1 (a): the defect this round fixes. Round 1's
	// sweep did an unconditional `rmSync` and relied on it THROWING to detect
	// "still in use" — but on POSIX, `rmSync` on a directory another live
	// process is actively writing into SUCCEEDS regardless (only Windows
	// EPERMs on an open handle), so that catch block caught nothing. This
	// test reproduces the hazard directly: a scratch home whose `owner.pid`
	// names a process that is DEFINITELY still alive (this very test process)
	// must survive the sweep unconditionally, never merely "usually".
	//
	// Review round 3 F1: `live` is minted end-to-end by the REAL helper (its
	// own real `withScratchHome()` call), not a hand-written `owner.pid` —
	// the production write is what's under test here, not a stand-in for it.
	// This also re-arms round 2's "M13" (the sweep-must-run-before-its-own-
	// mkdtemp guard the age gate alone had quietly retired: a dir hand-built
	// outside any call can't distinguish that ordering, since it already
	// fully exists — with a valid pid — before the call under test even
	// starts). The SECOND call below is the one actually exercised: its own
	// sweep pass must both spare `live` (a genuinely separate, still-alive
	// prior mint) AND land its own fresh `dir` on disk afterward — explicitly
	// asserted, not merely assumed because cleanup didn't throw.
	it("(a) never removes a scratch home whose owner.pid names a live process (helper-minted, end-to-end)", () => {
		delete process.env.PI_LENS_HOME;
		delete process.env.PILENS_DATA_DIR;
		const first = withScratchHome({ tmpPrefix: SWEEP_TEST_PREFIX });
		const live = first.dir as string;
		// A populated tool tree, per the reviewer's probe (bin/taplo, tools/,
		// instances.json) — not load-bearing for the assertion, but makes this
		// test's failure mode legible as "a live scratch home's tools vanished".
		fs.mkdirSync(path.join(live, "bin"), { recursive: true });
		fs.writeFileSync(path.join(live, "bin", "taplo"), "pretend binary");

		// Clear the pin `first` just set so this SECOND call's sweep actually
		// runs (rather than early-returning on "already pinned") — simulating a
		// second, concurrent run on the same machine while `live` (this very
		// process) is still alive and using it.
		delete process.env.PI_LENS_HOME;
		delete process.env.PILENS_DATA_DIR;
		const second = withScratchHome({ tmpPrefix: SWEEP_TEST_PREFIX });
		try {
			expect(fs.existsSync(live)).toBe(true); // survived — the whole point of (a)
			expect(fs.existsSync(path.join(live, "bin", "taplo"))).toBe(true);
			// The SECOND call's own fresh mint must survive its OWN sweep pass.
			expect(fs.existsSync(second.dir as string)).toBe(true);
			expect(second.dir).not.toBe(live);
		} finally {
			second.restore();
			fs.rmSync(second.dir as string, { recursive: true, force: true });
			fs.rmSync(live, { recursive: true, force: true });
		}
	});

	it("(b) removes a scratch home whose owner.pid names a dead process", () => {
		delete process.env.PI_LENS_HOME;
		delete process.env.PILENS_DATA_DIR;
		const dead = mintScratchHomeDir();
		writeOwnerPid(dead, IMPOSSIBLE_PID);

		const { dir, restore } = withScratchHome({ tmpPrefix: SWEEP_TEST_PREFIX });
		try {
			expect(fs.existsSync(dead)).toBe(false); // swept — its writer is gone
		} finally {
			restore();
			fs.rmSync(dir as string, { recursive: true, force: true });
		}
	});

	it("(c) skips a dir with no owner.pid that is still young (a mint mid-flight, not yet orphaned)", () => {
		delete process.env.PI_LENS_HOME;
		delete process.env.PILENS_DATA_DIR;
		const young = mintScratchHomeDir(); // fresh mtime, no owner.pid written

		const { dir, restore } = withScratchHome({ tmpPrefix: SWEEP_TEST_PREFIX });
		try {
			expect(fs.existsSync(young)).toBe(true); // too young to call orphaned
		} finally {
			restore();
			fs.rmSync(dir as string, { recursive: true, force: true });
			fs.rmSync(young, { recursive: true, force: true });
		}
	});

	it("(d) removes a dir with no owner.pid once it is old (the crashed-before-writing-its-pid fallback)", () => {
		delete process.env.PI_LENS_HOME;
		delete process.env.PILENS_DATA_DIR;
		const old = mintScratchHomeDir();
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		fs.utimesSync(old, twoHoursAgo, twoHoursAgo);

		const { dir, restore } = withScratchHome({ tmpPrefix: SWEEP_TEST_PREFIX });
		try {
			expect(fs.existsSync(old)).toBe(false); // orphaned — swept
		} finally {
			restore();
			fs.rmSync(dir as string, { recursive: true, force: true });
		}
	});

	// #2670 review F3: the pin runs before `getGlobalPiLensLogDir()`'s own
	// `global-dir-probe-redirect` degradation row could ever fire (PI_LENS_HOME
	// wins ahead of it and leaves no trace of its own), so without this line a
	// human reading a run's output has no way to find where its telemetry and
	// tool installs went.
	it("announces the pinned dir on stderr", () => {
		delete process.env.PI_LENS_HOME;
		delete process.env.PILENS_DATA_DIR;
		const errors: string[] = [];
		const spy = vi
			.spyOn(console, "error")
			.mockImplementation((...args: unknown[]) => {
				errors.push(args.map(String).join(" "));
			});
		const { dir, restore } = withScratchHome();
		try {
			expect(errors.some((line) => line.includes("PI_LENS_HOME pinned"))).toBe(
				true,
			);
			expect(errors.some((line) => line.includes(dir as string))).toBe(true);
		} finally {
			restore();
			spy.mockRestore();
			fs.rmSync(dir as string, { recursive: true, force: true });
		}
		expect(errors.some((line) => line.includes("scratch home complete"))).toBe(
			true,
		);
	});

	it("does not announce anything when a home is already pinned (a true no-op)", () => {
		process.env.PI_LENS_HOME = "/some/explicit/home";
		const errors: string[] = [];
		const spy = vi
			.spyOn(console, "error")
			.mockImplementation((...args: unknown[]) => {
				errors.push(args.map(String).join(" "));
			});
		try {
			withScratchHome();
			expect(errors).toHaveLength(0);
		} finally {
			spy.mockRestore();
		}
	});
});
