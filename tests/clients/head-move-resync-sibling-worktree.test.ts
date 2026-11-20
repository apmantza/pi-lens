// flake-shape: real-process-spawn — the subject is what a REAL `git checkout` in a REAL linked worktree does to the documents a REAL language server holds there; a stubbed git or server could not answer which bytes the server ends up with.
/**
 * A HEAD move in a sibling linked worktree resyncs the documents held there.
 *
 * Opaque recovery (#2050) recovers a bash command's writes from every
 * checkout the command names, but the HEAD look (#4493) and the same-HEAD
 * discard (#4502) read only the session root's HEAD. A command that moved
 * HEAD in a sibling worktree (`cd ../wt && git checkout`, a rebase, a reset)
 * changed files that were never dirty, so `git status` names none of them,
 * and nobody read the sibling's HEAD: the server kept the pre-move bytes, and
 * no record said why. A session rebased a sibling worktree onto a commit that
 * regenerated a protobuf module, and the language server reported the new
 * fields missing until the session ended.
 *
 * The cases drive the real hooks (`handleToolCall` / `handleToolResult`), real
 * git, and the fake language server, through the shared HEAD-move harness.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	env,
	hold,
	lspService,
	makeRepo,
	MAIN,
	phaseRows,
	primaryOrdering,
	type Repo,
	runGit,
	sentDiskBytes,
	session,
	settledHeadMovedRows,
	TYPES_A,
	TYPES_B,
	useHeadMoveHarness,
} from "../support/head-move-resync-kit.js";

useHeadMoveHarness();

let worktreeCount = 0;

/**
 * A linked worktree of `repo`, outside the session root, detached at branch
 * A, with the same fake-server config (`.pi-lens/` is ignored, so a worktree
 * starts without it).
 */
async function siblingWorktree(repo: Repo): Promise<Repo> {
	const dir = path.join(env.tmpDir, `sibling-${++worktreeCount}`);
	repo.git("worktree", "add", "-q", "--detach", dir, "A");
	fs.cpSync(path.join(repo.dir, ".pi-lens"), path.join(dir, ".pi-lens"), {
		recursive: true,
	});
	primaryOrdering.set(dir, "single-task-ordered");
	const config = await import("../../clients/lsp/config.js");
	await config.initLSPConfig(dir);
	return {
		dir,
		trace: repo.trace,
		git: (...args: string[]) => runGit(dir, args),
		file: (name) => path.join(dir, name),
	};
}

describe("HEAD moves in a sibling linked worktree", () => {
	it("sends a held document's new bytes before the tool_result of a checkout run in the sibling", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		const sibling = await siblingWorktree(repo);
		await hold(sibling, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-sibling-checkout");
		const service = await lspService();
		// Premise: the session root and the sibling are different checkouts,
		// and the sibling's held document still has branch A's bytes.
		expect(sibling.dir.startsWith(`${repo.dir}${path.sep}`)).toBe(false);
		expect(sentDiskBytes(service, sibling, "lib/types.ts")).toBe(true);

		await s.bash(`cd ${sibling.dir} && git checkout -q --detach B`, () =>
			sibling.git("checkout", "-q", "--detach", "B"),
		);

		// The checkout rewrote lib/types.ts, which was never dirty.
		expect(fs.readFileSync(sibling.file("lib/types.ts"), "utf8")).toBe(TYPES_B);
		expect(sibling.git("status", "--porcelain")).toBe("");
		expect(sentDiskBytes(service, sibling, "lib/types.ts")).toBe(true);
		const rows = await settledHeadMovedRows(sibling, 1);
		expect(rows[0]).toMatchObject({
			metadata: { root: sibling.dir, trigger: "tool_result", resynced: 1 },
		});
	}, 30_000);

	it("sends a held document's restored bytes when a command discards its edit in the sibling (#4502)", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		const sibling = await siblingWorktree(repo);
		// An edit the server holds, then discarded by a command run in the
		// sibling: HEAD does not move, and the file is clean afterwards.
		fs.writeFileSync(sibling.file("lib/types.ts"), TYPES_B);
		await hold(sibling, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-sibling-discard");
		const service = await lspService();

		await s.bash(`cd ${sibling.dir} && git restore lib/types.ts`, () =>
			sibling.git("restore", "lib/types.ts"),
		);

		expect(fs.readFileSync(sibling.file("lib/types.ts"), "utf8")).toBe(TYPES_A);
		expect(sentDiskBytes(service, sibling, "lib/types.ts")).toBe(true);
		const rows = await settledHeadMovedRows(sibling, 1, "HEAD");
		expect(rows[0]).toMatchObject({
			result: "discarded:1",
			metadata: { root: sibling.dir, discarded: 1, changed: 0 },
		});
	}, 30_000);

	it("records no move for a sibling the command names but leaves where it was", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		const sibling = await siblingWorktree(repo);
		await hold(sibling, ["lib/types.ts"]);
		const s = session(repo, "s-sibling-still");

		await s.bash(`cd ${sibling.dir} && git status --short`, () => {
			sibling.git("status", "--short");
		});
		// A later call that does move the sibling still reads a move, so the
		// silence above is a look that found nothing, not a look that never ran.
		await s.bash(`cd ${sibling.dir} && git checkout -q --detach B`, () =>
			sibling.git("checkout", "-q", "--detach", "B"),
		);

		// The move's row is written when the resync's detached phase ends.
		await settledHeadMovedRows(sibling, 1);
		const rows = (await phaseRows("opaque_mutation_head_moved")).filter(
			(row) => row.metadata.root === sibling.dir,
		);
		expect(rows.map((row) => row.metadata.to)).toEqual([
			sibling.git("rev-parse", "HEAD").slice(0, 12),
		]);
	}, 30_000);

	// Review r1 on #5719 (CodeRabbit): the tool_call look is bounded at 500 ms,
	// and it reads HEAD only after its out-of-band look. When the bound fires
	// first, the hook releases the command before the sibling's HEAD is
	// recorded, the command moves HEAD, the look then records the moved HEAD as
	// a first sight, and the tool_result sees no move. A reftable ref store makes
	// `readGitHead` spawn `git rev-parse --verify`, which a PATH shim stalls.
	const reftable = (() => {
		try {
			const probe = path.join(env.tmpDir, "reftable-probe-sibling");
			fs.mkdirSync(probe, { recursive: true });
			runGit(probe, ["init", "-q", "--ref-format=reftable"]);
			return true;
		} catch {
			return false;
		}
	})();

	it("records the sibling's HEAD before the tool_call returns, however slow its look", async (ctx) => {
		ctx.skip(
			process.platform === "win32",
			"the git shim that stalls the look is a POSIX shell script",
		);
		ctx.skip(!reftable, "this git cannot create a reftable repository");
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
			["--ref-format=reftable"],
		);
		const sibling = await siblingWorktree(repo);
		await hold(sibling, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-sibling-slow-look");
		const service = await lspService();
		// Host boundary: a `git` on PATH that stalls `rev-parse --verify` past the
		// tool_call bound while a marker exists, then runs the real git.
		const realGit = (process.env.PATH ?? "")
			.split(path.delimiter)
			.map((dir) => path.join(dir, "git"))
			.find((candidate) => fs.existsSync(candidate));
		if (!realGit) throw new Error("git is not on PATH");
		const shimDir = path.join(env.tmpDir, `git-shim-sibling-${worktreeCount}`);
		const slow = path.join(shimDir, "slow");
		fs.mkdirSync(shimDir, { recursive: true });
		fs.writeFileSync(
			path.join(shimDir, "git"),
			[
				"#!/bin/sh",
				`if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ -e ${JSON.stringify(slow)} ]; then sleep 0.7; fi`,
				`exec ${JSON.stringify(realGit)} "$@"`,
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		process.env.PATH = `${shimDir}${path.delimiter}${previousPath ?? ""}`;
		try {
			fs.writeFileSync(slow, "");
			const command = `cd ${sibling.dir} && git checkout -q --detach B`;
			const result = await s.bashCall(command);
			// The host runs the command as soon as the hook returns.
			sibling.git("checkout", "-q", "--detach", "B");
			fs.rmSync(slow);
			await result();

			expect(sentDiskBytes(service, sibling, "lib/types.ts")).toBe(true);
		} finally {
			process.env.PATH = previousPath;
		}
	}, 30_000);

	it("resyncs a move made outside pi between two calls that name the sibling", async () => {
		const repo = await makeRepo(
			{ "lib/types.ts": TYPES_A, "main.ts": MAIN },
			{ "lib/types.ts": TYPES_B },
		);
		const sibling = await siblingWorktree(repo);
		await hold(sibling, ["lib/types.ts", "main.ts"]);
		const s = session(repo, "s-sibling-outside");
		const service = await lspService();
		// The first call records the sibling's HEAD.
		await s.bash(`cd ${sibling.dir} && git status --short`, () => {
			sibling.git("status", "--short");
		});
		// A move made outside pi: no call is running.
		sibling.git("checkout", "-q", "--detach", "B");

		await s.bash(`cd ${sibling.dir} && git status --short`, () => {
			sibling.git("status", "--short");
		});

		expect(sentDiskBytes(service, sibling, "lib/types.ts")).toBe(true);
	}, 30_000);
});
