/**
 * #4508: a `.git` directory with no `HEAD` is not a checkout top. Git skips
 * it and keeps walking up; the file walk behind every `resolveGitCheckout`
 * caller must do the same. A stray `/tmp/.git` on a maintainer host once
 * became the checkout root for any cwd under `/tmp`.
 *
 * The issue's own fixture (an empty `.git` ABOVE a real checkout) passes on
 * the old walk, which meets the real `.git` first. The two shapes that red are
 * a stray BETWEEN the start path and the real top, and a stray above a start
 * path that is in no repository.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canonicalDirectory,
	resolveGitCheckout,
	resolveGitIdentity,
	resolveLinkedWorktreeOwner,
} from "../../clients/review-graph/git-identity.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

let base: string;

beforeEach(() => {
	base = canonicalDirectory(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-git-head-less-")),
	);
});

afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

function makeRepo(root: string): string {
	const gitDir = path.join(root, ".git");
	fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
	fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
	fs.writeFileSync(path.join(gitDir, "refs", "heads", "main"), `${SHA}\n`);
	return gitDir;
}

function statSucceeds(file: string): boolean {
	try {
		fs.statSync(file);
		return true;
	} catch {
		return false;
	}
}

function makeStray(root: string): void {
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
}

/** A linked worktree of `repo` at `worktree`: a `.git` file naming a private gitdir. */
function makeLinkedWorktree(
	repo: string,
	worktree: string,
	name: string,
): void {
	const privateDir = path.join(repo, ".git", "worktrees", name);
	fs.mkdirSync(privateDir, { recursive: true });
	fs.writeFileSync(path.join(privateDir, "HEAD"), `${SHA}\n`);
	fs.writeFileSync(path.join(privateDir, "commondir"), "../..\n");
	fs.mkdirSync(worktree, { recursive: true });
	fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${privateDir}\n`);
}

describe("a .git directory with no HEAD is not a checkout top (#4508)", () => {
	it("walks past a HEAD-less .git between the start path and the real checkout", () => {
		const repo = path.join(base, "repo");
		const commonDir = makeRepo(repo);
		const nested = path.join(repo, "vendor", "tool");
		makeStray(nested);
		const start = path.join(nested, "src");
		fs.mkdirSync(start, { recursive: true });

		const checkout = resolveGitCheckout(start);

		expect(checkout?.root).toBe(repo);
		expect(checkout?.spelledRoot).toBe(repo);
		expect(checkout?.commonDir).toBe(commonDir);
		expect(resolveGitIdentity(start)?.headCommit).toBe(SHA);
	});

	it("resolves no checkout for a path under a HEAD-less .git in no repository", () => {
		makeStray(base);
		const start = path.join(base, "proj");
		fs.mkdirSync(start);

		expect(resolveGitCheckout(start)).toBeNull();
		expect(resolveGitIdentity(start)).toBeUndefined();
	});

	// A HEAD that cannot be read is unknown, not absent: skipping it would
	// pick the enclosing repository as the owner.
	it("resolves no checkout when the nearest .git cannot be read, never an enclosing one", (ctx) => {
		makeRepo(base);
		const inner = path.join(base, "inner");
		const innerGit = makeRepo(inner);
		fs.chmodSync(innerGit, 0o000);
		try {
			if (statSucceeds(path.join(innerGit, "HEAD")))
				ctx.skip("chmod 000 does not deny reads here (win32 or root)");
			expect(resolveGitCheckout(path.join(inner, "src"))).toBeNull();
		} finally {
			fs.chmodSync(innerGit, 0o755);
		}
	});

	it("still stops at a .git directory that has a HEAD", () => {
		const repo = path.join(base, "repo");
		makeRepo(repo);
		const inner = path.join(repo, "inner");
		makeRepo(inner);

		expect(resolveGitCheckout(path.join(inner, "src"))?.root).toBe(inner);
	});

	it("still resolves a linked worktree .git file", () => {
		const repo = path.join(base, "repo");
		const commonDir = makeRepo(repo);
		const worktree = path.join(base, "wt");
		makeLinkedWorktree(repo, worktree, "wt");

		const checkout = resolveGitCheckout(worktree);

		expect(checkout?.root).toBe(worktree);
		expect(checkout?.commonDir).toBe(commonDir);
	});

	it("tells a linked worktree from the session checkout when a stray .git sits between them", () => {
		const repo = path.join(base, "repo");
		makeRepo(repo);
		const worktree = path.join(base, "wt");
		makeLinkedWorktree(repo, worktree, "wt");
		const sessionCwd = path.join(repo, "pkg");
		makeStray(sessionCwd);
		const sub = path.join(sessionCwd, "src");
		fs.mkdirSync(sub);

		const session = resolveGitCheckout(sub);
		expect(session).not.toBeNull();
		const owner = resolveLinkedWorktreeOwner(
			session!,
			path.join(worktree, "a.ts"),
		);

		expect(owner?.root).toBe(worktree);
	});
});
