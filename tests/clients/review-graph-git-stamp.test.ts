import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { getProjectDataDir } from "../../clients/file-utils.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	flushReviewGraphPersistsForTests,
	getCachedReviewGraph,
	getLastGraphBuildInfo,
	_resetCwdWorktreeMismatchLogForTests,
} from "../../clients/review-graph/builder.js";
import {
	_resetGitIdentityCacheForTests,
	resolveGitIdentity,
} from "../../clients/review-graph/git-identity.js";
import * as latencyLogger from "../../clients/latency-logger.js";

// Mock out the expensive file system scanning — we only care about persist/
// stamp behaviour, not real symbol extraction.
vi.mock("../../clients/scan-utils.js", () => ({
	getSourceFiles: vi.fn().mockReturnValue([]),
}));

const dirs: string[] = [];

function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-graph-stamp-"));
	dirs.push(dir);
	return dir;
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
	previousDataDir = process.env.PILENS_DATA_DIR;
});

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	vi.restoreAllMocks();
});

describe("review-graph snapshot git stamp (#300)", () => {
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

		const cachePath = path.join(getProjectDataDir(cwd), "cache", "review-graph.json");
		await waitForFile(cachePath);
		const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
		expect(raw.gitStamp).toBeDefined();
		expect(raw.gitStamp.headCommit).toBe("a".repeat(40));
		expect(raw.gitStamp.worktreeRoot).toBe(identity?.worktreeRoot);

		// Cold reload with the SAME HEAD: warm behavior — snapshot loads (mode
		// "cached" for an unchanged empty file set), not dropped.
		clearReviewGraphWorkspaceCache();
		await buildOrUpdateGraph(cwd, [], facts);
		const raw2 = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
		expect(raw2.gitStamp.headCommit).toBe("a".repeat(40));
	});

	it("read path drops the snapshot when HEAD changed (reused-worktree-path simulation)", async () => {
		const cwd = tmpDir();
		const dataDir = path.join(cwd, "data");
		process.env.PILENS_DATA_DIR = dataDir;
		makeFakeRepo(cwd, "a".repeat(40));

		const facts = new FactStore();
		await buildOrUpdateGraph(cwd, [], facts);
		flushReviewGraphPersistsForTests();

		const cachePath = path.join(getProjectDataDir(cwd), "cache", "review-graph.json");
		await waitForFile(cachePath);
		const before = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
		expect(before.gitStamp.headCommit).toBe("a".repeat(40));

		// Simulate `git worktree remove` + `add` at the SAME path for a different
		// branch: same data-dir slug, but HEAD is now a different commit. No git
		// binary involved — just rewrite the ref file by hand.
		_resetGitIdentityCacheForTests();
		setHead(cwd, "b".repeat(40));

		// The BLIND read path (getCachedReviewGraph → loadPersistedGraph with
		// verifyGitStamp) must drop the stamped-mismatched snapshot instead of
		// serving the previous branch's graph — the caller degrades to
		// outline-only / triggers a rebuild.
		clearReviewGraphWorkspaceCache();
		expect(getCachedReviewGraph(cwd)).toBeUndefined();
	});

	it("read path serves the snapshot from disk when HEAD is unchanged", async () => {
		const cwd = tmpDir();
		process.env.PILENS_DATA_DIR = path.join(cwd, "data");
		makeFakeRepo(cwd, "a".repeat(40));

		const facts = new FactStore();
		await buildOrUpdateGraph(cwd, [], facts);
		flushReviewGraphPersistsForTests();
		await waitForFile(
			path.join(getProjectDataDir(cwd), "cache", "review-graph.json"),
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
			path.join(getProjectDataDir(cwd), "cache", "review-graph.json"),
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
			"review-graph.json",
		);
		// The write is tmp+rename, so existence implies complete content — the
		// pre-fix direct fs.writeFile could be observed created-but-partial by a
		// concurrent reader (the CI flake behind the "expected 'cached' to be
		// 'full'" failure: tier-2 load read truncated JSON and fell open to a
		// full rebuild).
		await waitForFile(cachePath);
		expect(() => JSON.parse(fs.readFileSync(cachePath, "utf-8"))).not.toThrow();
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

		const cachePath = path.join(getProjectDataDir(cwd), "cache", "review-graph.json");
		await waitForFile(cachePath);
		const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
		expect(raw.gitStamp).toBeUndefined();

		clearReviewGraphWorkspaceCache();
		await expect(buildOrUpdateGraph(cwd, [], facts)).resolves.toBeDefined();
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
