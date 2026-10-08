import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ephemeralStagingRoot,
	isEphemeralCheckoutRoot,
} from "../../clients/ephemeral-root.js";
import * as fileUtils from "../../clients/file-utils.js";
import { appendToWorklog, readWorklog } from "../../clients/fix-worklog.js";
import {
	getProjectSnapshotPath,
	loadProjectSnapshot,
	saveProjectSnapshot,
	waitForProjectSnapshotPersistsForTests,
} from "../../clients/project-snapshot.js";
import { getLspIdleEvictMsForRoot } from "../../clients/lsp/index.js";
import { setupTestEnvironment, useTrackedTempDirs } from "./test-utils.js";

// #1129 F6: the classifier's `.git` probes are counted through the real
// module, so `statSync` is a pass-through spy, never a fake.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

const { getProjectDataDir } = fileUtils;
const PREFIX = "pi-lens-1129-";
const previousEnv = {
	dataDir: process.env.PILENS_DATA_DIR,
	tmpdir: process.env.TMPDIR,
	generic: process.env.PI_LENS_LSP_IDLE_EVICT_MS,
	ephemeral: process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS,
};

function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function fixtureRoot(label: string): string {
	return setupTestEnvironment(`${PREFIX}${label}-`).tmpDir;
}

/** A real git marker: a `.git` directory holding `HEAD` (what `git init` writes). */
function makeCheckout(root: string): string {
	fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
	fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	return root;
}

let dataRoot: string;

beforeEach(() => {
	// A plain (non-checkout) fixture holds the configured data base, so the
	// per-process directory lands where this file can see and remove it.
	dataRoot = path.join(fixtureRoot("data"), "data");
	process.env.PILENS_DATA_DIR = dataRoot;
});

useTrackedTempDirs(PREFIX);

afterEach(() => {
	restore("PILENS_DATA_DIR", previousEnv.dataDir);
	restore("TMPDIR", previousEnv.tmpdir);
	restore("PI_LENS_LSP_IDLE_EVICT_MS", previousEnv.generic);
	restore("PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS", previousEnv.ephemeral);
	vi.mocked(fs.statSync).mockClear();
});

describe("temporary checkout policy (#1129)", () => {
	// Recurrence (F7, review of d873c8d74): only `<root>/.git` was probed, so a
	// session whose cwd is a package inside a tmp checkout kept a durable dir.
	it("marks a real tmp checkout and its subdirectories without marking an ordinary tmp fixture", () => {
		const checkout = makeCheckout(fixtureRoot("repo"));
		const subdir = path.join(checkout, "packages", "x");
		fs.mkdirSync(subdir, { recursive: true });
		const fixture = fixtureRoot("fixture");
		const emptyGit = fixtureRoot("empty-git");
		fs.mkdirSync(path.join(emptyGit, ".git"));

		expect(isEphemeralCheckoutRoot(checkout)).toBe(true);
		expect(isEphemeralCheckoutRoot(subdir)).toBe(true);
		expect(isEphemeralCheckoutRoot(fixture)).toBe(false);
		expect(isEphemeralCheckoutRoot(emptyGit)).toBe(false);
	});

	// Recurrence (F1/F3, review of d873c8d74): every tmp checkout in a process
	// shared `os.tmpdir()/pi-lens-ephemeral/<pid>`, a top-level tmp entry.
	it("gives each tmp checkout its own data dir under a per-process token in the configured base", () => {
		const a = makeCheckout(fixtureRoot("repo-a"));
		const b = makeCheckout(fixtureRoot("repo-b"));
		const subdir = path.join(a, "packages", "x");
		fs.mkdirSync(subdir, { recursive: true });
		const plain = fixtureRoot("plain");

		const dirA = getProjectDataDir(a);
		const dirB = getProjectDataDir(b);
		const dirSub = getProjectDataDir(subdir);
		const ephemeralBase = path.join(dataRoot, ".ephemeral");
		for (const dir of [dirA, dirB, dirSub]) {
			const [token, slug, ...rest] = path
				.relative(ephemeralBase, dir)
				.split(path.sep);
			expect(token).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{8}$`));
			expect(slug).toMatch(/-[0-9a-f]{8}$/);
			expect(rest).toEqual([]);
		}
		expect(new Set([dirA, dirB, dirSub]).size).toBe(3);
		expect(getProjectDataDir(a)).toBe(dirA);
		expect(path.dirname(getProjectDataDir(plain))).toBe(dataRoot);
	});

	// Recurrence (F1, review probe p2): a worklog row written for checkout A
	// was read back for checkout B.
	it("keeps one checkout's worklog out of another checkout in the same process", () => {
		const a = makeCheckout(fixtureRoot("worklog-a"));
		const b = makeCheckout(fixtureRoot("worklog-b"));
		appendToWorklog(
			a,
			[
				{
					filePath: path.join(a, "x.ts"),
					rule: "no-a",
					tool: "test",
					message: "only A",
					line: 1,
				} as never,
			],
			false,
		);

		expect(readWorklog(a).map((entry) => entry.message)).toEqual(["only A"]);
		expect(readWorklog(b)).toEqual([]);
	});

	// Recurrence (F2, review of d873c8d74): snapshots of a tmp checkout were
	// suppressed outright, then re-enabled for session start only through an
	// `allowEphemeral` option. Decision B: normal in process.
	it("round-trips a tmp checkout's snapshot in process without writing into the checkout", async () => {
		const checkout = makeCheckout(fixtureRoot("snapshot"));
		const snapshot = {
			version: 2,
			projectRoot: checkout,
			generatedAt: new Date().toISOString(),
			seq: 7,
			files: {},
			symbols: {},
			reverseDeps: {},
			cachedExports: [],
		} as never;

		saveProjectSnapshot(checkout, snapshot);
		await waitForProjectSnapshotPersistsForTests();

		expect(loadProjectSnapshot(checkout)?.seq).toBe(7);
		expect(fs.readdirSync(checkout)).toEqual([".git"]);
		expect(
			getProjectSnapshotPath(checkout).startsWith(
				path.join(dataRoot, ".ephemeral") + path.sep,
			),
		).toBe(true);
	});

	// Recurrence (F3, review of d873c8d74): nothing removed the per-process dir.
	it("removes the per-process data dirs through one exit listener", () => {
		const a = makeCheckout(fixtureRoot("exit-a"));
		const b = makeCheckout(fixtureRoot("exit-b"));
		const dirs = [getProjectDataDir(a), getProjectDataDir(b)];
		for (const dir of dirs) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "worklog.jsonl"), "{}\n");
		}
		const listeners = process
			.listeners("exit")
			.filter((listener) => listener.name === "removeEphemeralDataDirs");
		expect(listeners).toHaveLength(1);

		fileUtils.removeEphemeralDataDirs();

		for (const dir of dirs) {
			expect(fs.existsSync(path.dirname(dir))).toBe(false);
		}
	});

	// Recurrence (#1129 F10, verify mutation V8): with the random half of the
	// token fixed, a process reusing a dead predecessor's pid adopted that
	// predecessor's ephemeral data (its worklog) before the sweep reaped it.
	it("never reads a dead predecessor's data that carries the same pid", () => {
		const checkout = makeCheckout(fixtureRoot("reused-pid"));
		const dataDir = getProjectDataDir(checkout);
		const predecessor = path.join(
			dataRoot,
			".ephemeral",
			`${process.pid}-00000000`,
			path.basename(dataDir),
		);
		fs.mkdirSync(predecessor, { recursive: true });
		fs.writeFileSync(
			path.join(predecessor, "worklog.jsonl"),
			`${JSON.stringify({ message: "from a dead process", rule: "r", line: 1 })}\n`,
		);

		expect(readWorklog(checkout)).toEqual([]);
	});

	// Recurrence (F3): a process killed before its exit hook ran left its dir
	// behind forever; a reused pid must not hand it to a new process either.
	it("sweeps a dead process's data dir and keeps live and unrelated entries", async () => {
		const base = path.join(dataRoot, ".ephemeral");
		const dead = path.join(base, "424242-deadbeef");
		const live = path.join(base, "434343-0badf00d");
		const unrelated = path.join(base, "keep-me");
		for (const dir of [dead, live, unrelated]) {
			fs.mkdirSync(path.join(dir, "slug-0123abcd"), { recursive: true });
		}
		fs.writeFileSync(path.join(base, "515151-cafef00d"), "a file, not a dir");

		const removed = await fileUtils.sweepDeadEphemeralDataDirs({
			isPidAlive: (pid) => pid === 434343,
		});

		expect(removed).toBe(1);
		expect(fs.existsSync(dead)).toBe(false);
		expect(fs.existsSync(live)).toBe(true);
		expect(fs.existsSync(unrelated)).toBe(true);
		expect(fs.existsSync(path.join(base, "515151-cafef00d"))).toBe(true);
	});

	it("reads at most maxEntries entries in one sweep", async () => {
		const base = path.join(dataRoot, ".ephemeral");
		for (const name of ["424242-deadbeef", "424243-deadbeef"]) {
			fs.mkdirSync(path.join(base, name), { recursive: true });
		}

		const removed = await fileUtils.sweepDeadEphemeralDataDirs({
			isPidAlive: () => false,
			maxEntries: 1,
		});

		expect(removed).toBe(1);
		expect(fs.readdirSync(base)).toHaveLength(1);
	});

	// Recurrence (F4, review probe p3): classification compared spellings, so
	// a symlinked tmpdir hid real-spelled checkouts and staging files.
	// lane: Linux and macOS unit shards; Windows symlinks need privileges.
	describe.skipIf(process.platform === "win32")("symlinked spellings", () => {
		it("classifies on real paths when the tmpdir or the candidate is a symlink", () => {
			const holder = fixtureRoot("link");
			const real = path.join(holder, "real");
			const link = path.join(holder, "link");
			fs.mkdirSync(real);
			fs.symlinkSync(real, link, "dir");
			makeCheckout(path.join(real, "repo"));
			const staged = path.join(real, "pi-agent-x", "a.ts");
			fs.mkdirSync(path.dirname(staged), { recursive: true });
			fs.writeFileSync(staged, "export {};\n");

			process.env.TMPDIR = link;
			expect(isEphemeralCheckoutRoot(path.join(real, "repo"))).toBe(true);
			expect(ephemeralStagingRoot(staged)).toBe(
				path.join(fs.realpathSync(real), "pi-agent-x"),
			);

			process.env.TMPDIR = real;
			expect(isEphemeralCheckoutRoot(path.join(link, "repo"))).toBe(true);
			expect(ephemeralStagingRoot(path.join(link, "pi-agent-x", "a.ts"))).toBe(
				path.join(fs.realpathSync(real), "pi-agent-x"),
			);
		});
	});

	// Recurrence (#1129 F11, verify probe q3): a directory that did not exist
	// yet, spelled through a symlinked tmpdir, fell back to its link spelling
	// and was not classified at all.
	// lane: Linux and macOS unit shards; Windows symlinks need privileges.
	describe.skipIf(process.platform === "win32")("symlinked new paths", () => {
		it("classifies a not-yet-created directory through a symlinked tmpdir by its nearest existing ancestor", () => {
			const holder = fixtureRoot("link-new");
			const real = path.join(holder, "real");
			const link = path.join(holder, "link");
			fs.mkdirSync(real);
			fs.symlinkSync(real, link, "dir");
			makeCheckout(path.join(real, "repo"));
			fs.mkdirSync(path.join(real, "pi-agent-y"));

			process.env.TMPDIR = real;
			expect(
				isEphemeralCheckoutRoot(path.join(link, "repo", "new", "sub")),
			).toBe(true);
			expect(
				ephemeralStagingRoot(path.join(link, "pi-agent-y", "new", "a.ts")),
			).toBe(path.join(fs.realpathSync(real), "pi-agent-y"));
		});
	});

	// Recurrence (#1129 F12, verify probes q2 and q5): the walk also probed the
	// tmpdir itself, so a repository AT the tmpdir (TMPDIR=$HOME with a dotfiles
	// repo) marked every fixture below it ephemeral and hid staging dirs.
	it("ignores a git repository at the tmpdir itself", () => {
		const tmpRoot = makeCheckout(fixtureRoot("tmp-is-repo"));
		const plain = path.join(tmpRoot, "plain");
		fs.mkdirSync(plain);
		fs.mkdirSync(path.join(tmpRoot, "pi-agent-z"));

		process.env.TMPDIR = tmpRoot;
		expect(isEphemeralCheckoutRoot(plain)).toBe(false);
		expect(isEphemeralCheckoutRoot(tmpRoot)).toBe(false);
		expect(ephemeralStagingRoot(path.join(tmpRoot, "pi-agent-z", "a.ts"))).toBe(
			path.join(fs.realpathSync(tmpRoot), "pi-agent-z"),
		);
	});

	// Recurrence (F5, review probe p4): a real checkout named pi-agent-sdk was
	// declined as staging.
	it("lets a real checkout at or around a pi-agent directory win over staging", () => {
		const holder = fixtureRoot("agent");
		const sdk = makeCheckout(path.join(holder, "pi-agent-sdk"));
		fs.mkdirSync(path.join(sdk, "src"));
		const inner = makeCheckout(path.join(holder, "repo"));
		fs.mkdirSync(path.join(inner, "pi-agent-tool"));
		const staging = path.join(holder, "pi-agent-1129");
		fs.mkdirSync(staging);

		expect(ephemeralStagingRoot(path.join(sdk, "src", "a.ts"))).toBeUndefined();
		expect(
			ephemeralStagingRoot(path.join(inner, "pi-agent-tool", "a.ts")),
		).toBeUndefined();
		expect(ephemeralStagingRoot(path.join(staging, "a.ts"))).toBe(
			path.join(fs.realpathSync(holder), "pi-agent-1129"),
		);
	});

	// Recurrence (F6, review of d873c8d74): the uncached classifier statted
	// `.git` on every data-dir, snapshot and idle call (5 stats in #3417's build).
	it("probes a root's git marker once however often it is classified", () => {
		const checkout = makeCheckout(fixtureRoot("memo"));
		vi.mocked(fs.statSync).mockClear();

		for (let i = 0; i < 3; i++) {
			isEphemeralCheckoutRoot(checkout);
			getProjectDataDir(checkout);
			getLspIdleEvictMsForRoot(checkout);
		}

		const gitProbes = vi
			.mocked(fs.statSync)
			.mock.calls.filter(([file]) => String(file).endsWith(`${path.sep}.git`));
		expect(gitProbes).toHaveLength(1);
	});

	it("uses the aggressive idle window only for tmp checkouts and their subdirectories", () => {
		const checkout = makeCheckout(fixtureRoot("idle"));
		const subdir = path.join(checkout, "packages", "x");
		fs.mkdirSync(subdir, { recursive: true });
		const fixture = fixtureRoot("idle-fixture");
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = "120000";
		process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS = "1000";

		expect(getLspIdleEvictMsForRoot(checkout)).toBe(1000);
		expect(getLspIdleEvictMsForRoot(subdir)).toBe(1000);
		expect(getLspIdleEvictMsForRoot(fixture)).toBe(120000);
	});
});
