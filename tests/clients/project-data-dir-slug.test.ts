// flake-shape: real-process-spawn — two real Node children must contend on the
// production rename; an in-process mock cannot expose the cross-process ENOENT.
/**
 * #2874: `getProjectDataDir`'s slug folded separators to `-`, so two roots
 * differing only in separator-vs-hyphen placement (`src/pi-lens` vs
 * `src/pi/lens`) shared one data directory. The slug now appends an 8-hex
 * SHA-256 of the canonical absolute root, and a pre-hash directory is
 * renamed once on first use.
 *
 * Probe hygiene: scratch roots live under `os.tmpdir()` (outside the
 * worktree); `PILENS_DATA_DIR`/`PI_LENS_HOME` are pointed at per-test temp
 * dirs and restored afterwards. The real HOME is never touched.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// A plain copy of the real module: the namespace itself is not writable, and
// the rename cells below `vi.spyOn(fs, "renameSync")` it. No function is
// replaced here (the slug's old `realpathSync` boundary probe is gone, #4689
// batch 8), so every cell below runs the real filesystem.
vi.mock("node:fs", async () => ({
	...(await vi.importActual<typeof import("node:fs")>("node:fs")),
}));
import { resetDegradationLedger } from "../../clients/degradation-ledger.js";
import { getDisposition } from "../../clients/diagnostic-dispositions.js";
import { CacheManager } from "../../clients/cache-manager.js";
import {
	createProjectDataDirRootProbe,
	dataDirCanonicalRoot,
	drainProjectDataDirMigrations,
	getProjectDataDir,
	type ProjectDataDirRootFs,
	_resetProjectDataDirMemoForTests,
} from "../../clients/file-utils.js";
import { evaluateGitGuard } from "../../clients/git-guard.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { dataDir416, dataDir444 } from "../support/data-dir-4-4-4.js";

const FIXTURES = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"fixtures",
);
const savedDataDir = process.env.PILENS_DATA_DIR;
const savedHome = process.env.PI_LENS_HOME;

// Every temp dir this file creates, removed in afterEach (#2929 round 4, F5:
// the 80-iteration race loop left 464 /tmp/pi-lens-datadir-base-* behind).
const tempDirs: string[] = [];

function isolateDataDir(): string {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-datadir-base-"));
	tempDirs.push(base);
	process.env.PILENS_DATA_DIR = base;
	process.env.PI_LENS_HOME = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-datadir-home-"),
	);
	tempDirs.push(process.env.PI_LENS_HOME);
	return base;
}

function makeScratch(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function runRealProcess(
	env: NodeJS.ProcessEnv,
	script: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", script], {
			cwd: process.cwd(),
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let error = "";
		// The child is always reaped: kill-on-settle is a no-op after a clean
		// exit and bounds the orphan window when the child hangs (#2929 F5).
		const kill = () => {
			try {
				child.kill();
			} catch {
				// Already exited; nothing to reap.
			}
		};
		child.stdout.on("data", (chunk: Buffer) => (output += chunk));
		child.stderr.on("data", (chunk: Buffer) => (error += chunk));
		child.on("error", (err) => {
			kill();
			reject(err);
		});
		child.on("exit", (code) => {
			kill();
			if (code === 0) resolve(output.trim());
			else reject(new Error(`child exited ${code}: ${error}`));
		});
	});
}

afterEach(() => {
	if (savedDataDir === undefined) {
		delete process.env.PILENS_DATA_DIR;
	} else {
		process.env.PILENS_DATA_DIR = savedDataDir;
	}
	if (savedHome === undefined) {
		delete process.env.PI_LENS_HOME;
	} else {
		process.env.PI_LENS_HOME = savedHome;
	}
	drainProjectDataDirMigrations();
	resetDegradationLedger();
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("project data-dir slug (#2874)", () => {
	it("gives separator/hyphen twins distinct directories", () => {
		const base = isolateDataDir();
		const scratch = makeScratch("pi-lens-twins-");
		const rootA = path.join(scratch, "src", "pi-lens");
		const rootB = path.join(scratch, "src", "pi", "lens");
		fs.mkdirSync(rootA, { recursive: true });
		fs.mkdirSync(rootB, { recursive: true });

		const dirA = getProjectDataDir(rootA);
		const dirB = getProjectDataDir(rootB);

		expect(dirA.startsWith(base)).toBe(true);
		expect(dirB.startsWith(base)).toBe(true);
		expect(dirB).not.toBe(dirA);
		// No state leak across the twins: a file in A's directory is
		// invisible from B's.
		fs.mkdirSync(dirA, { recursive: true });
		fs.writeFileSync(path.join(dirA, "marker.json"), "{}");
		expect(fs.existsSync(path.join(dirB, "marker.json"))).toBe(false);
	});

	it("returns the same directory for the same root across calls", () => {
		isolateDataDir();
		const scratch = makeScratch("pi-lens-stable-");
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });

		const first = getProjectDataDir(root);
		const second = getProjectDataDir(root);
		const trailingSlash = getProjectDataDir(`${root}${path.sep}`);

		expect(second).toBe(first);
		expect(trailingSlash).toBe(first);
	});

	it("a root spelled through a link names its real path's directory (#4689)", () => {
		// RECURRENCE GUARDED: #4689 round 4. The name came from the caller's
		// spelling while dispatch and the runtime hold the realpath, so one
		// link-rooted session wrote two data dirs: the turn state, the change
		// log and the mark store each split between them (r3 probe: getLensDir
		// opened 38 times by identity and 222 by spelling).
		isolateDataDir();
		const scratch = makeScratch("pi-lens-symlink-");
		const target = path.join(scratch, "target", "proj");
		const linkParent = path.join(scratch, "linked");
		fs.mkdirSync(target, { recursive: true });
		fs.mkdirSync(linkParent);
		fs.symlinkSync(path.join(scratch, "target"), path.join(linkParent, "root"));

		const linked = getProjectDataDir(path.join(linkParent, "root", "proj"));
		// win32 names have never followed the realpath (dataDirCanonicalRoot).
		if (process.platform === "win32")
			expect(linked).not.toBe(getProjectDataDir(target));
		else expect(linked).toBe(getProjectDataDir(target));
	});

	it("a win32 root keeps the resolved spelling's name, a POSIX root takes its real path's (#4689 r5 N3)", (ctx) => {
		// RECURRENCE GUARDED: verify r5 N3. Every win32 data-dir name is the
		// resolved spelling in every version; no Windows lane runs this file,
		// so the platform is injected to keep that durable name pinned.
		if (process.platform === "win32")
			return ctx.skip("creating a directory link needs privileges on win32");
		const scratch = makeScratch("pi-lens-platform-");
		fs.mkdirSync(path.join(scratch, "realproj"));
		const alias = path.join(scratch, "aliasproj");
		fs.symlinkSync("realproj", alias, "dir");

		expect(dataDirCanonicalRoot(alias, "win32").root).toBe(path.resolve(alias));
		expect(dataDirCanonicalRoot(alias, "linux").root).toBe(
			fs.realpathSync.native(alias),
		);
	});

	it("a root spelled through a link still reads the marks 4.4.4 wrote under that spelling (#4689)", (ctx) => {
		// RECURRENCE GUARDED: review r1 F2. A session rooted at a link (an
		// alias root, macOS `/var`, a symlinked home) must not lose its marks,
		// review graph and snapshot on upgrade. The store below is the one
		// 4.4.4 wrote (tests/fixtures/data-dir-4.4.4), placed where 4.4.4 put
		// it, and the directory the real path names adopts it.
		if (process.platform === "win32")
			return ctx.skip("the win32 name never moved");
		const base = isolateDataDir();
		const scratch = makeScratch("pi-lens-alias-slug-");
		const real = path.join(scratch, "realproj");
		const alias = path.join(scratch, "aliasproj");
		fs.mkdirSync(path.join(real, ".git"), { recursive: true });
		fs.symlinkSync("realproj", alias, "dir");

		const written = dataDir444(base, alias);
		fs.mkdirSync(path.join(written, "cache"), { recursive: true });
		fs.copyFileSync(
			path.join(
				FIXTURES,
				"data-dir-4.4.4",
				"cache",
				"diagnostic-dispositions.json",
			),
			path.join(written, "cache", "diagnostic-dispositions.json"),
		);

		expect(getProjectDataDir(alias)).toBe(getProjectDataDir(real));
		expect(getProjectDataDir(alias)).not.toBe(written);
		expect(getDisposition(alias, "ddw:ec76942a8ce3")?.disposition).toBe(
			"suppress",
		);
		expect(getDisposition(real, "ddw:ec76942a8ce3")?.disposition).toBe(
			"suppress",
		);
		expect(
			fs.existsSync(
				path.join(written, "cache", "diagnostic-dispositions.json"),
			),
		).toBe(true);
	});

	it("a root not on disk yet records identity-fallback and keeps its name once created", () => {
		// RECURRENCE GUARDED: #4689 batch 8. `fallback` used to come from a second
		// `realpathSync` of the root whose result was thrown away; the existence
		// check that replaced it must keep the same answer, or the notice
		// (and the "root may not exist yet" name stability) moves with it.
		isolateDataDir();
		const scratch = makeScratch("pi-lens-realpath-");
		const root = path.join(scratch, "proj");
		const first = getProjectDataDir(root);
		const notices = drainProjectDataDirMigrations();
		expect(notices).toHaveLength(1);
		expect(notices[0]?.outcome).toBe("identity-fallback");
		expect(notices[0]?.to).toBe(first);

		fs.mkdirSync(root, { recursive: true });
		_resetProjectDataDirMemoForTests();
		expect(getProjectDataDir(root)).toBe(first);
		expect(drainProjectDataDirMigrations()).toEqual([]);
	});

	it("fallback is true exactly when the root is not reachable on disk, for every way a path can fail to resolve (#4689 batch 8)", (ctx) => {
		// RECURRENCE GUARDED: #4689 batch 8 replaced the discarded
		// `realpathSync(resolved)` with `existsSync(resolved)`. The two agree on
		// each row below; the column is what `realpathSync` threw, so a row that
		// moves is a durable-data-dir selection change.
		if (process.platform === "win32")
			return ctx.skip("creating a directory link needs privileges on win32");
		const scratch = makeScratch("pi-lens-fallback-rows-");
		const dir = path.join(scratch, "dir");
		fs.mkdirSync(path.join(dir, "child"), { recursive: true });
		const file = path.join(scratch, "file.txt");
		fs.writeFileSync(file, "x");
		fs.symlinkSync("dir", path.join(scratch, "dirlink"), "dir");
		fs.symlinkSync("file.txt", path.join(scratch, "filelink"), "file");
		fs.symlinkSync("nowhere", path.join(scratch, "dangling"));
		fs.symlinkSync("loop-b", path.join(scratch, "loop-a"));
		fs.symlinkSync("loop-a", path.join(scratch, "loop-b"));
		const rows: Array<[string, string, boolean]> = [
			["a directory", dir, false],
			["a file", file, false],
			["a directory link", path.join(scratch, "dirlink"), false],
			["a file link", path.join(scratch, "filelink"), false],
			["below a directory link", path.join(scratch, "dirlink", "child"), false],
			["missing (ENOENT)", path.join(scratch, "missing"), true],
			[
				"missing below a link (ENOENT)",
				path.join(scratch, "dirlink", "m"),
				true,
			],
			["a dangling link (ENOENT)", path.join(scratch, "dangling"), true],
			["below a file (ENOTDIR)", path.join(file, "below"), true],
			["a link loop (ELOOP)", path.join(scratch, "loop-a"), true],
		];
		for (const [name, root, fallback] of rows)
			expect([name, dataDirCanonicalRoot(root, "linux").fallback]).toEqual([
				name,
				fallback,
			]);
		// EACCES: a root below a directory the process may not search. Root (uid 0)
		// searches it anyway, so that row cannot run there.
		if (typeof process.getuid === "function" && process.getuid() !== 0) {
			const sealed = path.join(scratch, "sealed");
			fs.mkdirSync(path.join(sealed, "proj"), { recursive: true });
			fs.chmodSync(sealed, 0o000);
			try {
				expect(dataDirCanonicalRoot(path.join(sealed, "proj")).fallback).toBe(
					true,
				);
			} finally {
				fs.chmodSync(sealed, 0o755);
			}
		}
		// win32 never changed: its name is the resolved spelling, and `fallback` is
		// still existence.
		expect(dataDirCanonicalRoot(dir, "win32").fallback).toBe(false);
		expect(
			dataDirCanonicalRoot(path.join(scratch, "missing"), "win32").fallback,
		).toBe(true);
	});

	it("two processes converge on one migrated directory", async () => {
		const base = isolateDataDir();
		const scratch = makeScratch("pi-lens-race-");
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });
		const hashedDir = getProjectDataDir(root);
		const oldDir = path.join(
			base,
			path.basename(hashedDir).replace(/-[0-9a-f]{8}$/, ""),
		);
		fs.mkdirSync(oldDir, { recursive: true });
		fs.writeFileSync(path.join(oldDir, "sessions.json"), "{}\n");
		_resetProjectDataDirMemoForTests();
		const barrier = path.join(scratch, "release");
		const readyA = path.join(scratch, "ready-a");
		const readyB = path.join(scratch, "ready-b");
		const script = [
			"const fs = require('node:fs');",
			"const { getProjectDataDir } = require('./clients/file-utils.js');",
			"const ready = process.env.READY_FILE;",
			"fs.writeFileSync(ready, 'ready');",
			"(async () => {",
			"  const t0 = Date.now();",
			"  while (!fs.existsSync(process.env.BARRIER_FILE)) {",
			"    if (Date.now() - t0 > 30000) { console.error('barrier timeout'); process.exit(1); }",
			"    await new Promise((r) => setTimeout(r, 1));",
			"  }",
			`  process.stdout.write(getProjectDataDir(${JSON.stringify(root)}));`,
			"})().catch((e) => { console.error(e); process.exit(1); });",
		].join("\n");
		const childEnv = {
			...process.env,
			PILENS_DATA_DIR: base,
			PI_LENS_HOME: path.join(scratch, "home"),
			BARRIER_FILE: barrier,
		};
		const first = runRealProcess({ ...childEnv, READY_FILE: readyA }, script);
		const second = runRealProcess({ ...childEnv, READY_FILE: readyB }, script);
		// Observe early child failures now: without these the ready loop below
		// would spin to its deadline while the rejection waits for Promise.all.
		void first.catch(() => {});
		void second.catch(() => {});
		const waitStart = Date.now();
		while (!fs.existsSync(readyA) || !fs.existsSync(readyB)) {
			if (Date.now() - waitStart > 30_000) {
				throw new Error("race children never became ready");
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		fs.writeFileSync(barrier, "go");
		const dirs = await Promise.all([first, second]);
		expect(dirs[0]).toBe(dirs[1]);
		expect(dirs[0]).toBe(hashedDir);
		expect(fs.existsSync(path.join(hashedDir, "sessions.json"))).toBe(true);
		expect(fs.existsSync(oldDir)).toBe(false);
	});

	it("migrates an old-slug directory by rename and preserves its contents", () => {
		const base = isolateDataDir();
		const scratch = makeScratch("pi-lens-migrate-");
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });

		const dir = getProjectDataDir(root);
		// The pre-#2874 name is the new basename without its trailing hash.
		const oldDir = path.join(
			base,
			path.basename(dir).replace(/-[0-9a-f]{8}$/, ""),
		);
		expect(oldDir).not.toBe(dir);
		fs.mkdirSync(oldDir, { recursive: true });
		fs.writeFileSync(path.join(oldDir, "marker.json"), '{"kept":true}');
		_resetProjectDataDirMemoForTests();

		const settled = getProjectDataDir(root);

		expect(settled).toBe(dir);
		expect(fs.existsSync(oldDir)).toBe(false);
		expect(fs.readFileSync(path.join(settled, "marker.json"), "utf8")).toBe(
			'{"kept":true}',
		);
	});

	it("prefers the new directory when both old and new exist", () => {
		const base = isolateDataDir();
		const scratch = makeScratch("pi-lens-both-");
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });

		const dir = getProjectDataDir(root);
		const oldDir = path.join(
			base,
			path.basename(dir).replace(/-[0-9a-f]{8}$/, ""),
		);
		fs.mkdirSync(oldDir, { recursive: true });
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(oldDir, "old.txt"), "old");
		fs.writeFileSync(path.join(dir, "new.txt"), "new");
		_resetProjectDataDirMemoForTests();

		const settled = getProjectDataDir(root);

		expect(settled).toBe(dir);
		expect(fs.existsSync(path.join(settled, "new.txt"))).toBe(true);
		expect(fs.existsSync(oldDir)).toBe(true);
		// RECURRENCE GUARDED: #4689 r6 G1. The unhashed source adoption reads
		// is the link spelling's; a root whose spelling folds to the slug
		// settle already tried keeps settle's verdict, so a directory it left
		// beside a newer one is not copied in.
		expect(fs.existsSync(path.join(settled, "old.txt"))).toBe(false);
		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "coexisting" },
		]);
	});

	it("rename failure keeps the legacy directory and records rename-failed", () => {
		const base = isolateDataDir();
		const scratch = makeScratch("pi-lens-rename-failure-");
		const root = path.join(scratch, "proj");
		fs.mkdirSync(root, { recursive: true });
		const hashedDir = getProjectDataDir(root);
		const oldDir = path.join(
			base,
			path.basename(hashedDir).replace(/-[0-9a-f]{8}$/, ""),
		);
		fs.mkdirSync(oldDir, { recursive: true });
		_resetProjectDataDirMemoForTests();
		const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		});
		try {
			const settled = getProjectDataDir(root);
			expect(settled).toBe(oldDir);
			const notices = drainProjectDataDirMigrations();
			expect(notices).toHaveLength(1);
			expect(notices[0]?.outcome).toBe("rename-failed");
			expect(notices[0]?.to).toBe(hashedDir);
			expect(notices[0]?.to).not.toBe(settled);
		} finally {
			rename.mockRestore();
		}
	});
});

/** Every file of a 4.4.4 alias-rooted session's data dir that names no absolute path. */
const ALIAS_SESSION_444 = path.join(
	FIXTURES,
	"data-dir-4.4.4",
	"alias-session",
);

/** The done-marker an adoption leaves in the adopting directory (#4689 r5). */
const MARKER = /^\.adopted-/;

function filesUnder(dir: string, rel = ""): string[] {
	return fs
		.readdirSync(path.join(dir, rel), { withFileTypes: true })
		.flatMap((entry) => {
			const child = path.join(rel, entry.name);
			if (MARKER.test(entry.name)) return [];
			return entry.isDirectory() ? filesUnder(dir, child) : [child];
		});
}

describe("adopting the data dir a link spelling named (#4689 round 4)", () => {
	// RECURRENCE GUARDED: #4689 round 4, maintainer decision 2026-10-21. The
	// data dir moved from the link spelling's name to the real path's, so
	// everything 4.4.4 stored for a link-rooted project must be carried over
	// once, never overwrite newer data, and leave the old directory intact.
	function aliasRoot(
		prefix: string,
	): { base: string; alias: string; spelled: string } | undefined {
		if (process.platform === "win32") return undefined;
		const base = isolateDataDir();
		const scratch = makeScratch(prefix);
		fs.mkdirSync(path.join(scratch, "realproj"));
		const alias = path.join(scratch, "aliasproj");
		fs.symlinkSync("realproj", alias, "dir");
		const spelled = dataDir444(base, alias);
		fs.cpSync(ALIAS_SESSION_444, spelled, { recursive: true });
		return { base, alias, spelled };
	}

	it("copies every file byte for byte, keeps the old dir and records adopted", (ctx) => {
		const fx = aliasRoot("pi-lens-adopt-");
		if (!fx) return ctx.skip("the win32 name never moved");
		// Not data: a lock directory, a lock file and an atomic-write stage.
		fs.mkdirSync(path.join(fx.spelled, "cache", "x.json.locks"));
		fs.writeFileSync(
			path.join(fx.spelled, "cache", "x.json.locks", "lock.1"),
			"1",
		);
		fs.writeFileSync(path.join(fx.spelled, "cache", "y.lock"), "1");
		fs.writeFileSync(path.join(fx.spelled, "cache", "z.json.tmp-1-0-0"), "{");

		const dir = getProjectDataDir(fx.alias);

		const expected = filesUnder(ALIAS_SESSION_444).sort();
		expect(expected.length).toBeGreaterThan(0);
		expect(filesUnder(dir).sort()).toEqual(expected);
		for (const file of expected) {
			expect(fs.readFileSync(path.join(dir, file))).toEqual(
				fs.readFileSync(path.join(ALIAS_SESSION_444, file)),
			);
			expect(fs.existsSync(path.join(fx.spelled, file))).toBe(true);
		}
		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopted" },
		]);
		expect(fs.readdirSync(dir).filter((name) => MARKER.test(name))).toEqual([
			`.adopted-${path.basename(fx.spelled)}`,
		]);
	});

	it("never overwrites a file the real path's directory already holds", (ctx) => {
		const fx = aliasRoot("pi-lens-adopt-keep-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const real = fs.realpathSync.native(fx.alias);
		const dir = getProjectDataDir(real);
		const newer = path.join(dir, "cache", "diagnostic-dispositions.json");
		fs.mkdirSync(path.dirname(newer), { recursive: true });
		fs.writeFileSync(newer, '{"dispositions":{}}');
		_resetProjectDataDirMemoForTests();

		expect(getProjectDataDir(fx.alias)).toBe(dir);

		expect(fs.readFileSync(newer, "utf8")).toBe('{"dispositions":{}}');
		// A file already present is not a failure to adopt.
		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopted" },
		]);
		expect(fs.existsSync(path.join(dir, "cache", "todo-baseline.json"))).toBe(
			true,
		);
	});

	it("records adopt-failed when a file cannot be copied, and leaves it where it was", (ctx) => {
		const fx = aliasRoot("pi-lens-adopt-fail-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const real = fs.realpathSync.native(fx.alias);
		const dir = getProjectDataDir(real);
		// A file where the copy needs a directory.
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "cache"), "");
		_resetProjectDataDirMemoForTests();
		drainProjectDataDirMigrations();

		getProjectDataDir(fx.alias);

		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopt-failed" },
		]);
		expect(
			fs.existsSync(path.join(fx.spelled, "cache", "todo-baseline.json")),
		).toBe(true);
	});

	it("adopts nothing while an old-slug directory it could not rename is in use", (ctx) => {
		// Adopting into the hashed directory would create it, and the next
		// session would settle on it ("coexisting") and leave the old slug's
		// data behind.
		const fx = aliasRoot("pi-lens-adopt-oldslug-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const real = fs.realpathSync.native(fx.alias);
		const hashedDir = getProjectDataDir(real);
		const oldDir = path.join(
			fx.base,
			path.basename(hashedDir).replace(/-[0-9a-f]{8}$/, ""),
		);
		fs.mkdirSync(oldDir, { recursive: true });
		_resetProjectDataDirMemoForTests();
		drainProjectDataDirMigrations();
		const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
			throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		});
		try {
			expect(getProjectDataDir(fx.alias)).toBe(oldDir);
		} finally {
			rename.mockRestore();
		}
		expect(fs.existsSync(hashedDir)).toBe(false);
		expect(
			drainProjectDataDirMigrations().map((notice) => notice.outcome),
		).toEqual(["rename-failed"]);
	});

	it("copies at most 4096 entries and records the rest as not adopted", (ctx) => {
		const fx = aliasRoot("pi-lens-adopt-cap-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const bulk = path.join(fx.spelled, "bulk");
		fs.mkdirSync(bulk);
		for (let i = 0; i < 4100; i++)
			fs.writeFileSync(path.join(bulk, `${i}.json`), "");

		const dir = getProjectDataDir(fx.alias);

		// Two of the 4096 entries are the directories `cache` and `bulk`.
		expect(filesUnder(dir)).toHaveLength(4094);
		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopt-failed" },
		]);
		// A capped walk is done too: the next process neither walks nor records.
		_resetProjectDataDirMemoForTests();
		getProjectDataDir(fx.alias);
		expect(drainProjectDataDirMigrations()).toEqual([]);
	});

	it("counts directories toward the cap, so a tree of empty ones ends the walk", (ctx) => {
		// RECURRENCE GUARDED: review r5 LOW (Greptile PRRT_kwDORt8rec6u2wFy).
		// r5 counted files only, so a source of 50k empty directories walked
		// every one of them at startup.
		const fx = aliasRoot("pi-lens-adopt-dircap-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const many = path.join(fx.spelled, "many");
		fs.mkdirSync(many);
		for (let i = 0; i < 4100; i++) fs.mkdirSync(path.join(many, `${i}`));

		const dir = getProjectDataDir(fx.alias);

		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopt-failed" },
		]);
	});

	it("counts a name already taken at the target as present, a dangling link included", (ctx) => {
		// RECURRENCE GUARDED: verify r5 N1. `linkSync` raises EEXIST when a
		// concurrent adopter (or anything else) took the name first; r4 counted
		// it as a failure, so every racing session recorded "adopt-failed".
		const fx = aliasRoot("pi-lens-adopt-eexist-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const dir = getProjectDataDir(fs.realpathSync.native(fx.alias));
		const taken = path.join(dir, "cache", "todo-baseline.json");
		fs.mkdirSync(path.dirname(taken), { recursive: true });
		fs.symlinkSync(path.join(fx.base, "gone"), taken);
		_resetProjectDataDirMemoForTests();

		getProjectDataDir(fx.alias);

		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopted" },
		]);
		expect(fs.lstatSync(taken).isSymbolicLink()).toBe(true);
	});

	it("records nothing for a link root with no directory under its spelling", (ctx) => {
		// RECURRENCE GUARDED: verify r5 N2. Every link-rooted project with no
		// 4.4.4 data would otherwise walk a missing directory and record
		// "adopt-failed" at every start.
		const fx = aliasRoot("pi-lens-adopt-none-");
		if (!fx) return ctx.skip("the win32 name never moved");
		fs.rmSync(fx.spelled, { recursive: true });

		const dir = getProjectDataDir(fx.alias);

		expect(drainProjectDataDirMigrations()).toEqual([]);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("records nothing when the real path's directory already holds every file", (ctx) => {
		// RECURRENCE GUARDED: verify r5 N2. A walk that copies nothing and fails
		// nothing (a directory an unmarked earlier walk already filled) changes
		// nothing, so it says nothing.
		const fx = aliasRoot("pi-lens-adopt-full-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const dir = getProjectDataDir(fs.realpathSync.native(fx.alias));
		fs.cpSync(ALIAS_SESSION_444, dir, { recursive: true });
		_resetProjectDataDirMemoForTests();

		getProjectDataDir(fx.alias);

		expect(drainProjectDataDirMigrations()).toEqual([]);
		expect(
			fs.existsSync(path.join(dir, `.adopted-${path.basename(fx.spelled)}`)),
		).toBe(true);
	});

	it("copies neither a symlink nor an earlier done-marker", (ctx) => {
		// RECURRENCE GUARDED: verify r5 N2 and the r5 marker. A link in the old
		// directory would be copied as its target's bytes (or fail when it
		// dangles); a marker copied from a directory that was once adopting
		// would tell this one a source it never walked was done.
		const fx = aliasRoot("pi-lens-adopt-skip-");
		if (!fx) return ctx.skip("the win32 name never moved");
		fs.symlinkSync(
			path.join(fx.spelled, "cache", "todo-baseline.json"),
			path.join(fx.spelled, "cache", "linked.json"),
		);
		fs.writeFileSync(path.join(fx.spelled, ".adopted-elsewhere-01234567"), "");

		const dir = getProjectDataDir(fx.alias);

		expect(fs.existsSync(path.join(dir, "cache", "linked.json"))).toBe(false);
		expect(fs.existsSync(path.join(dir, ".adopted-elsewhere-01234567"))).toBe(
			false,
		);
		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopted" },
		]);
	});

	it("resumes a walk that died before its marker, then never walks again", (ctx) => {
		// RECURRENCE GUARDED: verify r5 N4. The marker is written only after
		// the walk, so a process killed mid-walk (half the files linked, a
		// stage left behind) leaves no marker and the next start completes it.
		const fx = aliasRoot("pi-lens-adopt-resume-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const dir = getProjectDataDir(fs.realpathSync.native(fx.alias));
		const files = filesUnder(ALIAS_SESSION_444).sort();
		for (const file of files.slice(0, 2)) {
			fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
			fs.copyFileSync(path.join(ALIAS_SESSION_444, file), path.join(dir, file));
		}
		fs.writeFileSync(path.join(dir, `${files[2]}.tmp-999999-0-0`), "{");
		_resetProjectDataDirMemoForTests();

		getProjectDataDir(fx.alias);

		expect(
			filesUnder(dir)
				.filter((file) => !/\.tmp-/.test(file))
				.sort(),
		).toEqual(files);
		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopted" },
		]);
		_resetProjectDataDirMemoForTests();
		getProjectDataDir(fx.alias);
		expect(drainProjectDataDirMigrations()).toEqual([]);
	});

	it("records adopt-failed when the done-marker cannot be written, so the next start walks again", (ctx) => {
		// RECURRENCE GUARDED: the r5 marker. Without a marker every start walks
		// again and can undo a deletion, so a marker that cannot be written is
		// reported instead of passing as "adopted".
		if (process.getuid?.() === 0)
			return ctx.skip("root writes through a read-only directory");
		const fx = aliasRoot("pi-lens-adopt-unmarked-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const dir = getProjectDataDir(fs.realpathSync.native(fx.alias));
		// Every file is already there, so only the marker is left to fail.
		fs.cpSync(ALIAS_SESSION_444, dir, { recursive: true });
		// A directory nobody may write: no marker, and none can be staged there.
		// The files live in `cache/`, which stays writable.
		fs.chmodSync(dir, 0o555);
		try {
			_resetProjectDataDirMemoForTests();

			getProjectDataDir(fx.alias);

			expect(drainProjectDataDirMigrations()).toEqual([
				{ to: dir, outcome: "adopt-failed" },
			]);
			// No marker, so the next process walks again and says so again.
			_resetProjectDataDirMemoForTests();
			getProjectDataDir(fx.alias);
			expect(drainProjectDataDirMigrations()).toEqual([
				{ to: dir, outcome: "adopt-failed" },
			]);
		} finally {
			fs.chmodSync(dir, 0o755);
		}
	});

	it("keeps a record a store deleted after adoption deleted in the next process, and the commit gate allows the commit", (ctx) => {
		// RECURRENCE GUARDED: verify r5 N4 HIGH (probe resurrect.mjs). r4 walked
		// the kept old directory at every process start, so a record a store
		// deleted under the real path came back: a cleared turn-end record
		// returned stale and `--lens-guard` refused every commit as
		// "blocker state is unknown (cache_stale)", and a fresh session brought
		// it back again. On master the same steps allow the commit.
		const fx = aliasRoot("pi-lens-adopt-prune-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const cache = new CacheManager(false);
		// The record as 4.4.4 wrote it: CacheManager's writer is unchanged since
		// 4.4.4 (`git diff 755c1c7a3 -- clients/cache-manager.ts` is empty), so
		// it writes under a plain root and the files move to the old directory.
		const writer = makeScratch("pi-lens-adopt-prune-writer-");
		cache.writeCache(
			"turn-end-findings",
			{ content: "old", hasBlockers: false },
			writer,
		);
		const written = path.join(getProjectDataDir(writer), "cache");
		for (const name of [
			"turn-end-findings.json",
			"turn-end-findings.meta.json",
		])
			fs.copyFileSync(
				path.join(written, name),
				path.join(fx.spelled, "cache", name),
			);
		const metaPath = path.join(
			fx.spelled,
			"cache",
			"turn-end-findings.meta.json",
		);
		fs.writeFileSync(
			metaPath,
			JSON.stringify({
				timestamp: new Date(Date.now() - 86_400_000).toISOString(),
			}),
		);
		drainProjectDataDirMigrations();

		// Session 1 adopts the record, and the turn-end path clears it.
		expect(cache.inspectCache("turn-end-findings", fx.alias)).toBe("stale");
		cache.clearCache("turn-end-findings", fx.alias);
		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: getProjectDataDir(fx.alias), outcome: "adopted" },
		]);

		// A new process: the settle memo is per process.
		_resetProjectDataDirMemoForTests();
		expect(cache.inspectCache("turn-end-findings", fx.alias)).toBe("missing");
		expect(drainProjectDataDirMigrations()).toEqual([]);
		const gate = evaluateGitGuard(new RuntimeCoordinator(), cache, fx.alias);
		expect(gate.block).toBe(false);
		// The old directory is kept for a downgrade.
		expect(fs.existsSync(metaPath)).toBe(true);
	});
});

/** What pi-lens 4.1.6 wrote for a project rooted at a link (no slug hash). */
const ALIAS_MARK_416 = path.join(FIXTURES, "data-dir-4.1.6", "alias-mark");

describe("adopting the unhashed data dir a link spelling named before v4.2.0 (#4689 round 6)", () => {
	// RECURRENCE GUARDED: review r5 G1 (probe unhashed.mjs: "reads pre-2874
	// data: false"). Settle renames the unhashed name of the root it is given.
	// Since round 4 that is the real path, so a 4.1.6 directory named from the
	// link spelling was neither renamed nor read: its marks and caches were
	// lost on upgrade.
	function aliasRoot416(
		prefix: string,
	): { base: string; alias: string; unhashed: string } | undefined {
		if (process.platform === "win32") return undefined;
		const base = isolateDataDir();
		const scratch = makeScratch(prefix);
		fs.mkdirSync(path.join(scratch, "realproj"));
		const alias = path.join(scratch, "aliasproj");
		fs.symlinkSync("realproj", alias, "dir");
		const unhashed = dataDir416(base, alias);
		fs.cpSync(ALIAS_MARK_416, unhashed, { recursive: true });
		return { base, alias, unhashed };
	}

	it("reads a 4.1.6 mark back through the real store and copies every file byte for byte", (ctx) => {
		const fx = aliasRoot416("pi-lens-adopt416-");
		if (!fx) return ctx.skip("the win32 name never moved");

		expect(getDisposition(fx.alias, "dd:164197458e2b")).toMatchObject({
			disposition: "false-positive",
			reason: "4.1.6 fixture",
		});

		const dir = getProjectDataDir(fx.alias);
		expect(dir).toBe(getProjectDataDir(fs.realpathSync.native(fx.alias)));
		const expected = filesUnder(ALIAS_MARK_416).sort();
		expect(filesUnder(dir).sort()).toEqual(expected);
		for (const file of expected) {
			expect(fs.readFileSync(path.join(dir, file))).toEqual(
				fs.readFileSync(path.join(ALIAS_MARK_416, file)),
			);
			expect(fs.existsSync(path.join(fx.unhashed, file))).toBe(true);
		}
		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopted" },
		]);
		expect(fs.readdirSync(dir).filter((name) => MARKER.test(name))).toEqual([
			`.adopted-${path.basename(fx.unhashed)}`,
		]);

		// A new process neither walks again nor records.
		_resetProjectDataDirMemoForTests();
		getProjectDataDir(fx.alias);
		expect(drainProjectDataDirMigrations()).toEqual([]);
	});

	it("walks the hashed source first, so its file wins, and marks each source", (ctx) => {
		const fx = aliasRoot416("pi-lens-adopt416-both-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const hashed = dataDir444(fx.base, fx.alias);
		fs.cpSync(ALIAS_SESSION_444, hashed, { recursive: true });

		const dir = getProjectDataDir(fx.alias);

		const store = path.join("cache", "diagnostic-dispositions.json");
		expect(fs.readFileSync(path.join(dir, store))).toEqual(
			fs.readFileSync(path.join(ALIAS_SESSION_444, store)),
		);
		expect(fs.existsSync(path.join(dir, "cache", "knip.json"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "cache", "todo-baseline.json"))).toBe(
			true,
		);
		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopted" },
		]);
		expect(
			fs
				.readdirSync(dir)
				.filter((name) => MARKER.test(name))
				.sort(),
		).toEqual(
			[
				`.adopted-${path.basename(fx.unhashed)}`,
				`.adopted-${path.basename(hashed)}`,
			].sort(),
		);
	});

	it("walks the unhashed source when the hashed one is already marked", (ctx) => {
		// Each source has its own marker: a directory a round 4/5 build adopted
		// from the hashed source still adopts the unhashed one.
		const fx = aliasRoot416("pi-lens-adopt416-marked-");
		if (!fx) return ctx.skip("the win32 name never moved");
		const hashed = dataDir444(fx.base, fx.alias);
		fs.cpSync(ALIAS_SESSION_444, hashed, { recursive: true });
		const dir = getProjectDataDir(fs.realpathSync.native(fx.alias));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `.adopted-${path.basename(hashed)}`), "");
		_resetProjectDataDirMemoForTests();

		getProjectDataDir(fx.alias);

		expect(fs.existsSync(path.join(dir, "cache", "knip.json"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "cache", "todo-baseline.json"))).toBe(
			false,
		);
		expect(drainProjectDataDirMigrations()).toEqual([
			{ to: dir, outcome: "adopted" },
		]);
	});
});

/**
 * #5702: the retention sweep may delete a project data directory only when
 * its slug decodes to a root that no longer exists. The decode lives beside
 * the naming rules that produce the slug; a name it cannot judge answers
 * "unrecognized", which the sweep keeps.
 */
describe("project data-dir root decode for the retention sweep (#5702)", () => {
	/**
	 * An injected directory tree: `tree[dir]` lists the names a path can
	 * descend through (directories and links to directories); a dir absent
	 * from `tree` is unreadable.
	 */
	function fsLikeOf(tree: Record<string, string[]>): ProjectDataDirRootFs {
		return {
			listDirs: (dir) => tree[dir],
		};
	}

	it("answers exists for a root whose full reading is on disk, through dashes and stripped characters", () => {
		// A root spelled /repos/my-app.v2 folds to repos-my-appv2; the decode
		// recomputes the writer's fold on each candidate path, so the stripped
		// dot never breaks the match.
		const probe = createProjectDataDirRootProbe(
			"linux",
			fsLikeOf({ "/": ["repos"], "/repos": ["my-app.v2"] }),
		);
		expect(probe.statusFor("repos-my-appv2-01234567")).toBe("exists");
	});

	it("answers gone when no full reading exists", () => {
		const probe = createProjectDataDirRootProbe(
			"linux",
			fsLikeOf({ "/": ["repos"], "/repos": ["other"], "/repos/other": [] }),
		);
		expect(probe.statusFor("repos-my-appv2-01234567")).toBe("gone");
	});

	it("answers unrecognized for names it cannot judge and keeps them out of the sweep", () => {
		const probe = createProjectDataDirRootProbe(
			"linux",
			fsLikeOf({ "/": ["repos"], "/repos": [] }),
		);
		expect(probe.statusFor(".ephemeral")).toBe("unrecognized");
		expect(probe.statusFor("default-01234567")).toBe("unrecognized");
		// Pre-hash legacy directories (<v4.2.0 spelled the readable half alone).
		expect(probe.statusFor("repos-my-appv2")).toBe("unrecognized");
		expect(probe.statusFor("repos-my-appv2-0123456")).toBe("unrecognized");
		expect(probe.statusFor("")).toBe("unrecognized");
		// A readable half the writer can never produce (#5707 r2: a user dir
		// in a shared PILENS_DATA_DIR): characters the fold strips, or a dash
		// the fold trims.
		expect(probe.statusFor("my notes-01234567")).toBe("unrecognized");
		expect(probe.statusFor("my_notes-01234567")).toBe("unrecognized");
		expect(probe.statusFor("-repos-01234567")).toBe("unrecognized");
		expect(probe.statusFor("repos--01234567")).toBe("unrecognized");
	});

	it("answers unrecognized when the walk exhausts its readdir budget, never gone", () => {
		// A chain of 300 directories whose names fold to nothing: every level
		// is a viable prefix, none completes, and the walk runs out of readdir
		// budget. It must refuse to judge rather than answer gone for a root
		// it never finished looking for.
		const tree: Record<string, string[]> = {};
		let dir = "/";
		for (let i = 0; i < 300; i++) {
			tree[dir] = ["_"];
			dir = dir === "/" ? "/_" : `${dir}/_`;
		}
		tree[dir] = [];
		const probe = createProjectDataDirRootProbe("linux", fsLikeOf(tree));
		expect(probe.statusFor("a-b-01234567")).toBe("unrecognized");
	});

	it("answers unrecognized when a directory on the walk cannot be listed, never gone", () => {
		// Recurrence: #5707 r1 F1. An unreadable directory read as "no
		// reading here", so a live root below it was judged gone.
		const probe = createProjectDataDirRootProbe(
			"linux",
			fsLikeOf({ "/": ["work"] }),
		);
		expect(probe.statusFor("work-proj-01234567")).toBe("unrecognized");
	});

	it("answers exists for a last component whose fold ends in a dash or strips to nothing", () => {
		// Recurrence: #5707 r1 F1. The writer trims the whole slug's trailing
		// dashes, so `/w/proj-` and `/w/proj-é` both name `w-proj`; a
		// per-component match never found them and the sweep deleted live data.
		for (const last of ["proj-", "proj-é", "proj-🚀"]) {
			const probe = createProjectDataDirRootProbe(
				"linux",
				fsLikeOf({ "/": ["w"], "/w": [last], [`/w/${last}`]: [] }),
			);
			expect(probe.statusFor("w-proj-01234567"), last).toBe("exists");
		}
	});

	it("answers exists when the name's casing differs from the disk's", () => {
		// v4.2.0 to v4.4.4 named the dir from the caller's spelling; on a
		// case-insensitive volume that spelling need not match the disk's.
		const probe = createProjectDataDirRootProbe(
			"linux",
			fsLikeOf({ "/": ["Work"], "/Work": ["Proj"] }),
		);
		expect(probe.statusFor("work-proj-01234567")).toBe("exists");
	});

	it("never answers gone on win32, whose slug never followed the realpath", () => {
		// Recurrence: #5707 r1 F1 (maintainer decision 2). A junction or 8.3
		// spelling of a live root can never be re-derived from the listing.
		const probe = createProjectDataDirRootProbe(
			"win32",
			fsLikeOf({ "/": ["work"], "/work": ["proj"] }),
		);
		expect(probe.statusFor("dev-proj-0123abcd")).toBe("unrecognized");
		expect(probe.statusFor("Users-RUNNER1-proj-0123abcd")).toBe("unrecognized");
	});

	it("decodes a real on-disk root and notices its removal (linux)", () => {
		isolateDataDir();
		const root = makeScratch("pi-lens-decode-root-");
		// The writer names the dir; the probe agrees in both directions.
		const name = path.basename(getProjectDataDir(root));
		expect(createProjectDataDirRootProbe().statusFor(name)).toBe("exists");
		fs.rmSync(root, { recursive: true, force: true });
		expect(createProjectDataDirRootProbe().statusFor(name)).toBe("gone");
	});

	it("answers exists for live roots the writer names with a trailing dash or stripped tail (linux)", () => {
		// Recurrence: #5707 r1 F1 probe 1, through the real writer and disk.
		isolateDataDir();
		const parent = makeScratch("pi-lens-decode-tail-");
		for (const last of ["proj-", "proj-é", "tail/é"]) {
			const root = path.join(parent, last);
			fs.mkdirSync(root, { recursive: true });
			const name = path.basename(getProjectDataDir(root));
			expect(createProjectDataDirRootProbe().statusFor(name), last).toBe(
				"exists",
			);
		}
	});

	it("answers exists for a 4.4.4 dir named through a directory link to a live root (linux)", () => {
		// Recurrence: #5707 r2 (CodeRabbit 7g). v4.2.0 to v4.4.4 named the dir
		// from the caller's link spelling; the walk skipped links, so the live
		// root read as gone and its not-yet-adopted data was deleted.
		const base = isolateDataDir();
		const parent = makeScratch("pi-lens-decode-link-");
		fs.mkdirSync(path.join(parent, "real", "proj"), { recursive: true });
		fs.symlinkSync(path.join(parent, "real"), path.join(parent, "link"));
		const name = path.basename(
			dataDir444(base, path.join(parent, "link", "proj")),
		);
		expect(createProjectDataDirRootProbe().statusFor(name)).toBe("exists");
	});

	it("answers exists for a pre-hash legacy dir whose root name ends in eight hex digits (linux)", () => {
		// Recurrence: #5707 r1 F3. `release-deadbeef` parsed as readable
		// `…-release` plus hash, the decode looked for a missing root and the
		// sweep deleted the legacy dir before getProjectDataDir migrated it.
		const base = isolateDataDir();
		const root = path.join(
			makeScratch("pi-lens-decode-legacy-"),
			"release-deadbeef",
		);
		fs.mkdirSync(root);
		const name = path.basename(dataDir416(base, root));
		expect(createProjectDataDirRootProbe().statusFor(name)).toBe("exists");
	});

	// lane: Unit tests. Root skips: root lists a mode-0311 directory anyway,
	// so the unreadable-parent cell cannot arise.
	it.skipIf(process.getuid?.() === 0)(
		"answers unrecognized for a live root below a directory it cannot list (linux)",
		() => {
			// Recurrence: #5707 r1 F1 probe 1 (`--x` parent), real disk.
			isolateDataDir();
			const parent = makeScratch("pi-lens-decode-noread-");
			const root = path.join(parent, "noread", "child");
			fs.mkdirSync(root, { recursive: true });
			const name = path.basename(getProjectDataDir(root));
			fs.chmodSync(path.join(parent, "noread"), 0o311);
			try {
				expect(createProjectDataDirRootProbe().statusFor(name)).toBe(
					"unrecognized",
				);
			} finally {
				fs.chmodSync(path.join(parent, "noread"), 0o755);
			}
		},
	);
});
