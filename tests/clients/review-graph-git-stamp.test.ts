import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
	getCachedReviewGraph,
	getLastGraphBuildInfo,
	getReviewGraphRevisionDrift,
	waitForReviewGraphPersistsForTests,
	_resetCwdWorktreeMismatchLogForTests,
} from "../../clients/review-graph/builder.js";
import {
	_resetGitIdentityCacheForTests,
	resolveGitIdentity,
} from "../../clients/review-graph/git-identity.js";
import * as latencyLogger from "../../clients/latency-logger.js";
import * as reviewGraphLogger from "../../clients/review-graph-logger.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "./test-utils.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, statSync: vi.fn(actual.statSync) };
});

// Mock out the expensive file system scanning — we only care about persist/
// stamp behaviour, not real symbol extraction.
vi.mock("../../clients/scan-utils.js", () => ({
	getSourceFiles: vi.fn().mockReturnValue([]),
}));

function tmpDir(): string {
	return setupTestEnvironment("pi-lens-graph-stamp-").tmpDir;
}

/** Minimal hand-built `.git` (normal, non-worktree) repo — no git binary needed. */
function makeFakeRepo(root: string, headSha: string, branch = "main"): void {
	const gitDir = path.join(root, ".git");
	fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
	fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
	fs.writeFileSync(path.join(gitDir, "refs", "heads", branch), `${headSha}\n`);
}

function setHead(root: string, headSha: string, branch = "main"): void {
	fs.writeFileSync(
		path.join(root, ".git", "refs", "heads", branch),
		`${headSha}\n`,
	);
}

// writePending's actual disk write is async (fs.mkdir/fs.writeFile callbacks)
// even after flushReviewGraphPersistsForTests() fires it — poll briefly for
// the file to land instead of assuming synchronous completion. The write is
// tmp+rename, so once the file exists its content is complete.
async function waitForFile(filePath: string, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!fs.existsSync(filePath)) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`Timed out waiting for ${filePath}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

let previousDataDir: string | undefined;

beforeEach(() => {
	clearReviewGraphWorkspaceCache();
	_resetGitIdentityCacheForTests();
	_resetCwdWorktreeMismatchLogForTests();
	// The #1961 read-verdict record is bounded on the degradation ledger's own
	// rising edge, so each test needs a clean tally.
	resetDegradationLedger();
	previousDataDir = process.env.PILENS_DATA_DIR;
});

afterEach(async () => {
	// A build queues a persist into the project's data dir; let it land
	// before the root is removed, or it recreates the root afterwards.
	flushReviewGraphPersistsForTests();
	await waitForReviewGraphPersistsForTests();
	await cleanupTestEnvironmentsDrained("pi-lens-graph-stamp-");
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	vi.restoreAllMocks();
});

describe("review-graph snapshot git stamp (#300)", () => {
	it("resolves git identity once per cwd within one build (#3417)", async () => {
		const cwd = tmpDir();
		process.env.PILENS_DATA_DIR = path.join(cwd, "data");
		makeFakeRepo(cwd, "a".repeat(40));
		const stat = vi.spyOn(fs, "statSync");

		// #3417 recurrence: persistence/checkpoint/revision checks must not turn
		// one build into repeated upward `.git` walks.
		await buildOrUpdateGraph(cwd, [], new FactStore());

		const gitEntryChecks = stat.mock.calls.filter(([file]) =>
			String(file).endsWith(`${path.sep}.git`),
		);
		expect(gitEntryChecks).toHaveLength(1);
	});

	it("persists a stamp in a git repo and reloads warm when HEAD is unchanged", async () => {
		const cwd = tmpDir();
		const dataDir = path.join(cwd, "data");
		process.env.PILENS_DATA_DIR = dataDir;
		makeFakeRepo(cwd, "a".repeat(40));

		const facts = new FactStore();
		await buildOrUpdateGraph(cwd, [], facts);
		flushReviewGraphPersistsForTests();

		const identity = resolveGitIdentity(cwd);
		expect(identity?.headCommit).toBe("a".repeat(40));

		const cachePath = path.join(
			getProjectDataDir(cwd),
			"cache",
			"review-graph.json.gz",
		);
		await waitForFile(cachePath);
		const raw = JSON.parse(
			gunzipSync(fs.readFileSync(cachePath)).toString("utf-8"),
		);
		expect(raw.gitStamp).toBeDefined();
		expect(raw.gitStamp.headCommit).toBe("a".repeat(40));
		expect(raw.gitStamp.worktreeRoot).toBe(identity?.worktreeRoot);

		// Cold reload with the SAME HEAD: warm behavior — snapshot loads (mode
		// "cached" for an unchanged empty file set), not dropped.
		clearReviewGraphWorkspaceCache();
		await buildOrUpdateGraph(cwd, [], facts);
		const raw2 = JSON.parse(
			gunzipSync(fs.readFileSync(cachePath)).toString("utf-8"),
		);
		expect(raw2.gitStamp.headCommit).toBe("a".repeat(40));
	});

	it("read path SERVES the snapshot after a HEAD-only move, marked drifted (#1961)", async () => {
		const cwd = tmpDir();
		const dataDir = path.join(cwd, "data");
		process.env.PILENS_DATA_DIR = dataDir;
		makeFakeRepo(cwd, "a".repeat(40));

		const facts = new FactStore();
		await buildOrUpdateGraph(cwd, [], facts);
		flushReviewGraphPersistsForTests();

		const cachePath = path.join(
			getProjectDataDir(cwd),
			"cache",
			"review-graph.json.gz",
		);
		await waitForFile(cachePath);
		const before = JSON.parse(
			gunzipSync(fs.readFileSync(cachePath)).toString("utf-8"),
		);
		expect(before.gitStamp.headCommit).toBe("a".repeat(40));

		// A plain `git commit`: HEAD moves, files are untouched. No git binary
		// involved — just rewrite the ref file by hand.
		_resetGitIdentityCacheForTests();
		setHead(cwd, "b".repeat(40));

		// #1961: the blind read used to drop here, which cost every reader its
		// snapshot after each commit (measured stamp lifetime: 737s-1562s median
		// across four workspaces). It now serves the snapshot and records the
		// revision difference, which `computeTrust` turns into a note.
		clearReviewGraphWorkspaceCache();
		const served = getCachedReviewGraph(cwd);
		expect(served).toBeDefined();
		expect(getReviewGraphRevisionDrift(cwd)).toEqual({
			stampedHead: "a".repeat(40),
			currentHead: "b".repeat(40),
		});
	});

	it("recomputes drift per call as HEAD keeps moving (#1961 review F3)", async () => {
		const cwd = tmpDir();
		process.env.PILENS_DATA_DIR = path.join(cwd, "data");
		makeFakeRepo(cwd, "a".repeat(40));

		await buildOrUpdateGraph(cwd, [], new FactStore());
		flushReviewGraphPersistsForTests();
		await waitForFile(
			path.join(getProjectDataDir(cwd), "cache", "review-graph.json.gz"),
		);

		_resetGitIdentityCacheForTests();
		setHead(cwd, "b".repeat(40));
		clearReviewGraphWorkspaceCache();
		expect(getCachedReviewGraph(cwd)).toBeDefined();
		expect(getReviewGraphRevisionDrift(cwd)?.currentHead).toBe("b".repeat(40));

		// HEAD moves AGAIN while the same snapshot stays warm in the workspace
		// cache. A pair cached beside the graph would still name bbb — a commit
		// that stopped being HEAD.
		_resetGitIdentityCacheForTests();
		setHead(cwd, "c".repeat(40));
		expect(getCachedReviewGraph(cwd)).toBeDefined();
		expect(getReviewGraphRevisionDrift(cwd)).toEqual({
			stampedHead: "a".repeat(40),
			currentHead: "c".repeat(40),
		});
	});

	it("clears the drift once HEAD returns to the stamped commit (#1961 review F3)", async () => {
		const cwd = tmpDir();
		process.env.PILENS_DATA_DIR = path.join(cwd, "data");
		makeFakeRepo(cwd, "a".repeat(40));

		await buildOrUpdateGraph(cwd, [], new FactStore());
		flushReviewGraphPersistsForTests();
		await waitForFile(
			path.join(getProjectDataDir(cwd), "cache", "review-graph.json.gz"),
		);

		_resetGitIdentityCacheForTests();
		setHead(cwd, "b".repeat(40));
		clearReviewGraphWorkspaceCache();
		expect(getCachedReviewGraph(cwd)).toBeDefined();
		expect(getReviewGraphRevisionDrift(cwd)).toBeDefined();

		// `git checkout -` back to the stamped commit resolves the drift. A stored
		// pair would keep claiming it for the life of the cache entry.
		_resetGitIdentityCacheForTests();
		setHead(cwd, "a".repeat(40));
		expect(getCachedReviewGraph(cwd)).toBeDefined();
		expect(getReviewGraphRevisionDrift(cwd)).toBeUndefined();
	});

	it("reports no drift for a graph built in-process (#1961)", async () => {
		const cwd = tmpDir();
		process.env.PILENS_DATA_DIR = path.join(cwd, "data");
		makeFakeRepo(cwd, "a".repeat(40));

		await buildOrUpdateGraph(cwd, [], new FactStore());
		// A warm in-process entry has no stamped snapshot behind it, so a HEAD
		// move says nothing and must not manufacture a caveat.
		_resetGitIdentityCacheForTests();
		setHead(cwd, "b".repeat(40));
		expect(getReviewGraphRevisionDrift(cwd)).toBeUndefined();
	});

	it("read path DROPS a snapshot stamped for a different worktree (#300)", async () => {
		const cwd = tmpDir();
		process.env.PILENS_DATA_DIR = path.join(cwd, "data");
		makeFakeRepo(cwd, "a".repeat(40));

		await buildOrUpdateGraph(cwd, [], new FactStore());
		flushReviewGraphPersistsForTests();
		const cachePath = path.join(
			getProjectDataDir(cwd),
			"cache",
			"review-graph.json.gz",
		);
		await waitForFile(cachePath);

		// Rewrite the persisted stamp so it names ANOTHER tree, the way a reused
		// data-dir slug would. Nothing downstream of this read content-verifies,
		// so serving it would hand back a different project's graph.
		const data = JSON.parse(
			gunzipSync(fs.readFileSync(cachePath)).toString("utf-8"),
		);
		data.gitStamp.worktreeRoot = `${data.gitStamp.worktreeRoot}-other`;
		fs.writeFileSync(
			cachePath,
			gzipSync(Buffer.from(JSON.stringify(data), "utf-8")),
		);

		const spy = vi.spyOn(reviewGraphLogger, "logReviewGraph");
		clearReviewGraphWorkspaceCache();
		_resetGitIdentityCacheForTests();
		expect(getCachedReviewGraph(cwd)).toBeUndefined();

		// #1961: the drop used to be silent, which is why it hid for weeks.
		const dropped = spy.mock.calls.filter(
			([entry]) => entry.phase === "snapshot_read_dropped",
		);
		expect(dropped.length).toBe(1);
		expect(dropped[0][0].reason).toBe("worktree_mismatch");
		// The ledger keeps the exact tally and the discriminating identity.
		const group = getDegradationSummary().find(
			(g) => g.kind === "review-graph-snapshot-read",
		);
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toContain("dropped:");
	});

	it("records each read verdict once per workspace, not per read (#1961)", async () => {
		const cwd = tmpDir();
		process.env.PILENS_DATA_DIR = path.join(cwd, "data");
		makeFakeRepo(cwd, "a".repeat(40));

		await buildOrUpdateGraph(cwd, [], new FactStore());
		flushReviewGraphPersistsForTests();
		await waitForFile(
			path.join(getProjectDataDir(cwd), "cache", "review-graph.json.gz"),
		);

		_resetGitIdentityCacheForTests();
		setHead(cwd, "b".repeat(40));
		const spy = vi.spyOn(reviewGraphLogger, "logReviewGraph");

		// Two cold reads over the same drifted snapshot. The accessor runs on
		// every module_report / lens-engine / project_report call, so the record
		// is bounded on the ledger's rising edge per (verdict, cwd).
		clearReviewGraphWorkspaceCache();
		expect(getCachedReviewGraph(cwd)).toBeDefined();
		clearReviewGraphWorkspaceCache();
		expect(getCachedReviewGraph(cwd)).toBeDefined();

		const drifted = spy.mock.calls.filter(
			([entry]) => entry.phase === "snapshot_read_drifted",
		);
		expect(drifted.length).toBe(1);
		expect(drifted[0][0].reason).toBe("head_moved");
	});

	it("read path serves the snapshot from disk when HEAD is unchanged", async () => {
		const cwd = tmpDir();
		process.env.PILENS_DATA_DIR = path.join(cwd, "data");
		makeFakeRepo(cwd, "a".repeat(40));

		const facts = new FactStore();
		await buildOrUpdateGraph(cwd, [], facts);
		flushReviewGraphPersistsForTests();
		await waitForFile(
			path.join(getProjectDataDir(cwd), "cache", "review-graph.json.gz"),
		);

		// Same HEAD → the stamp verifies and the cold read loads from disk.
		clearReviewGraphWorkspaceCache();
		_resetGitIdentityCacheForTests();
		expect(getCachedReviewGraph(cwd)).toBeDefined();
	});

	it("build path survives a HEAD-only change (signature match wins after a commit)", async () => {
		const cwd = tmpDir();
		process.env.PILENS_DATA_DIR = path.join(cwd, "data");
		makeFakeRepo(cwd, "a".repeat(40));
		const a = path.join(cwd, "a.ts");
		fs.writeFileSync(a, "export function alphaSymbol() {\n\treturn 1;\n}\n");

		const facts = new FactStore();
		await buildOrUpdateGraph(cwd, [a], facts);
		flushReviewGraphPersistsForTests();
		await waitForFile(
			path.join(getProjectDataDir(cwd), "cache", "review-graph.json.gz"),
		);

		// HEAD moves (a plain `git commit`) but no file content changes. The
		// build path's tier-2 disk load deliberately skips the stamp check —
		// the signature/content-hash confirm proves freshness, so this must be
		// a "cached" reuse, NOT a full whole-repo rebuild after every commit.
		_resetGitIdentityCacheForTests();
		setHead(cwd, "b".repeat(40));
		clearReviewGraphWorkspaceCache();
		await buildOrUpdateGraph(cwd, [], new FactStore());
		expect(getLastGraphBuildInfo().mode).toBe("cached");
	});

	it("persist lands atomically: parseable on first existence, no tmp residue", async () => {
		const cwd = tmpDir();
		process.env.PILENS_DATA_DIR = path.join(cwd, "data");
		makeFakeRepo(cwd, "a".repeat(40));

		await buildOrUpdateGraph(cwd, [], new FactStore());
		flushReviewGraphPersistsForTests();

		const cachePath = path.join(
			getProjectDataDir(cwd),
			"cache",
			"review-graph.json.gz",
		);
		// The write is tmp+rename, so existence implies complete content — the
		// pre-fix direct fs.writeFile could be observed created-but-partial by a
		// concurrent reader (the CI flake behind the "expected 'cached' to be
		// 'full'" failure: tier-2 load read truncated JSON and fell open to a
		// full rebuild).
		await waitForFile(cachePath);
		expect(() =>
			JSON.parse(gunzipSync(fs.readFileSync(cachePath)).toString("utf-8")),
		).not.toThrow();
		const residue = fs
			.readdirSync(path.dirname(cachePath))
			.filter((name) => name.includes(".tmp-"));
		expect(residue).toEqual([]);
	});

	it("non-git temp dir: persists and reloads with no stamp, no errors", async () => {
		const cwd = tmpDir(); // no .git anywhere above this in the temp tree
		const dataDir = path.join(cwd, "data");
		process.env.PILENS_DATA_DIR = dataDir;

		const facts = new FactStore();
		await expect(buildOrUpdateGraph(cwd, [], facts)).resolves.toBeDefined();
		flushReviewGraphPersistsForTests();

		const cachePath = path.join(
			getProjectDataDir(cwd),
			"cache",
			"review-graph.json.gz",
		);
		await waitForFile(cachePath);
		const raw = JSON.parse(
			gunzipSync(fs.readFileSync(cachePath)).toString("utf-8"),
		);
		expect(raw.gitStamp).toBeUndefined();

		clearReviewGraphWorkspaceCache();
		await expect(buildOrUpdateGraph(cwd, [], facts)).resolves.toBeDefined();
	});

	it("revalidates git repository lifecycle changes within one process (#3417)", () => {
		const cwd = tmpDir();

		// Regression for #3417: a negative lookup must not hide a repository
		// initialized later in the same process.
		expect(resolveGitIdentity(cwd)).toBeUndefined();
		makeFakeRepo(cwd, "a".repeat(40));
		expect(resolveGitIdentity(cwd)).toEqual({
			headCommit: "a".repeat(40),
			worktreeRoot: path.resolve(cwd).replace(/\\/g, "/"),
		});

		// The inverse lifecycle direction is equally important: a positive
		// lookup must not survive removal of the repository metadata.
		fs.rmSync(path.join(cwd, ".git"), { recursive: true });
		expect(resolveGitIdentity(cwd)).toBeUndefined();
	});

	it("malformed .git file / unreadable HEAD is treated as non-git (no throw)", () => {
		const cwd = tmpDir();
		// A `.git` FILE (as in a linked worktree) but with garbage content —
		// no "gitdir: " prefix at all.
		fs.writeFileSync(path.join(cwd, ".git"), "not a real gitfile\n");
		expect(() => resolveGitIdentity(cwd)).not.toThrow();
		expect(resolveGitIdentity(cwd)).toBeUndefined();
	});

	it("malformed HEAD content resolves to undefined without throwing", () => {
		const cwd = tmpDir();
		const gitDir = path.join(cwd, ".git");
		fs.mkdirSync(gitDir, { recursive: true });
		fs.writeFileSync(path.join(gitDir, "HEAD"), "garbage, not a ref or sha\n");
		expect(() => resolveGitIdentity(cwd)).not.toThrow();
		expect(resolveGitIdentity(cwd)).toBeUndefined();
	});

	it("resolves identity through a linked-worktree .git file + commondir", () => {
		const mainRoot = tmpDir();
		const worktreeRoot = tmpDir();
		const mainGitDir = path.join(mainRoot, ".git");
		fs.mkdirSync(path.join(mainGitDir, "refs", "heads"), { recursive: true });
		fs.writeFileSync(path.join(mainGitDir, "HEAD"), "ref: refs/heads/main\n");
		fs.writeFileSync(
			path.join(mainGitDir, "refs", "heads", "main"),
			`${"c".repeat(40)}\n`,
		);

		// Linked worktree: its own gitdir under <main>/.git/worktrees/<name>,
		// with a "commondir" pointing back at the main gitdir, and its own
		// worktree-private HEAD (can point at a different branch).
		const worktreeGitDir = path.join(mainGitDir, "worktrees", "feature");
		fs.mkdirSync(worktreeGitDir, { recursive: true });
		fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
		fs.writeFileSync(
			path.join(worktreeGitDir, "HEAD"),
			"ref: refs/heads/feature\n",
		);
		fs.writeFileSync(
			path.join(mainGitDir, "refs", "heads", "feature"),
			`${"d".repeat(40)}\n`,
		);
		fs.writeFileSync(
			path.join(worktreeRoot, ".git"),
			`gitdir: ${worktreeGitDir}\n`,
		);

		const identity = resolveGitIdentity(worktreeRoot);
		expect(identity?.headCommit).toBe("d".repeat(40));
		expect(identity?.worktreeRoot).toBe(
			path.resolve(worktreeRoot).replace(/\\/g, "/"),
		);
	});

	it("logs once when cwd is a subdirectory of the worktree root, not per build", async () => {
		const cwd = tmpDir();
		makeFakeRepo(cwd, "a".repeat(40));
		const subdir = path.join(cwd, "sub", "dir");
		fs.mkdirSync(subdir, { recursive: true });
		process.env.PILENS_DATA_DIR = path.join(cwd, "data");

		const spy = vi.spyOn(latencyLogger, "logLatency");
		const facts = new FactStore();

		await buildOrUpdateGraph(subdir, [], facts);
		clearReviewGraphWorkspaceCache();
		await buildOrUpdateGraph(subdir, [], facts);

		const mismatchCalls = spy.mock.calls.filter(
			([entry]) => entry.phase === "review_graph_cwd_worktree_mismatch",
		);
		expect(mismatchCalls.length).toBe(1);
		expect(mismatchCalls[0][0].metadata).toMatchObject({
			worktreeRoot: expect.stringContaining(path.basename(cwd)),
		});
	});

	it("does not log a mismatch when cwd IS the worktree root", async () => {
		const cwd = tmpDir();
		makeFakeRepo(cwd, "a".repeat(40));
		process.env.PILENS_DATA_DIR = path.join(cwd, "data");

		const spy = vi.spyOn(latencyLogger, "logLatency");
		const facts = new FactStore();
		await buildOrUpdateGraph(cwd, [], facts);

		const mismatchCalls = spy.mock.calls.filter(
			([entry]) => entry.phase === "review_graph_cwd_worktree_mismatch",
		);
		expect(mismatchCalls.length).toBe(0);
	});
});
