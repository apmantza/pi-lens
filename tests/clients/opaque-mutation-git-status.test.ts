import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const safeSpawnAsync = vi.hoisted(() => vi.fn());
// `importOriginal`, not a bare stub: the truncation tests below build the REAL
// cap-kill result, and that needs safe-spawn's own `SpawnFailureError`.
vi.mock("../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/safe-spawn.js")>()),
	safeSpawnAsync,
}));

import { recoverOpaqueChangesViaGit } from "../../clients/opaque-mutation-scan.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import {
	capFastExitSpawnResult,
	capKilledSpawnResult,
} from "../support/spawn-shapes.js";

// Mirrors Git's documented Porcelain v1 ordinary matrix. Keep this explicit:
// a Cartesian product accepts impossible staged-deletion pairs such as DM/DT.
const ORDINARY_STATUSES = [
	" M",
	" T",
	" D",
	" A", // intent-to-add from `git add -N`
	" R", // #2060: worktree rename with a clean index (real git 2.55)
	" C", // #2060: worktree copy with a clean index
	"DR", // #2060: git's short-format table pairs index D with worktree R
	"DC", // #2060: ...and with worktree C
	"M ",
	"MM",
	"MT",
	"MD",
	"T ",
	"TM",
	"TT",
	"TD",
	"A ",
	"AM",
	"AT",
	"AD",
	"D ",
	"R ",
	"RM",
	"RT",
	"RD",
	"C ",
	"CM",
	"CT",
	"CD",
];

function porcelainOutput(statuses: string[]): string {
	return statuses
		.map((status, index) => {
			const path = `path-${index}.ts`;
			const oldPath =
				status.includes("R") || status.includes("C") ? `old-${path}\0` : "";
			return `${status} ${path}\0${oldPath}`;
		})
		.join("");
}

describe("opaque Git status parsing", () => {
	beforeEach(() => safeSpawnAsync.mockReset());

	it.each([
		["ordinary tracked states", ORDINARY_STATUSES],
		["untracked and ignored states", ["??", "!!"]],
		["documented unmerged states", ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]],
	])("accepts %s", async (_label, statuses) => {
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: porcelainOutput(statuses),
		});

		await expect(
			recoverOpaqueChangesViaGit("/repo", Date.now()),
		).resolves.toEqual({
			verdict: "recovered",
			paths: [],
			scannedCount: 0,
		});
	});

	// #2060 F2b: an XY pair outside the documented matrix is a gap in OUR
	// table, not proof the output is corrupt. Voiding the whole command's
	// recovery for one such entry silently re-opened the read-guard hole the
	// subsystem exists to close, so a well-formed entry keeps its path and is
	// counted instead.
	it.each([
		["mixed untracked", "?M"],
		["mixed ignored", "!A"],
		["undocumented unmerged index state", "U "],
		["undocumented unmerged worktree state", " U"],
		["staged deletion paired with worktree modification", "DM"],
		["staged deletion paired with worktree type change", "DT"],
		["undocumented ordinary state", "MR"],
	])(
		"retains %s status %j and counts it rather than voiding recovery",
		async (_label, status) => {
			// porcelainOutput, not a hand-built token: an R/C pair still owes a
			// second path token, and omitting it IS unparseable output.
			safeSpawnAsync.mockResolvedValue({
				status: 0,
				stdout: porcelainOutput([status]),
			});

			await expect(
				recoverOpaqueChangesViaGit("/repo", Date.now()),
			).resolves.toEqual({
				verdict: "recovered",
				paths: [],
				scannedCount: 0,
				unknownStatusCount: 1,
			});
		},
	);

	it.each([
		["blank status carrying no change at all", "  "],
		["status characters outside git's alphabet", "%%"],
		["a single non-status character", "1 "],
		// Softening the XY table must not soften the TOKEN grammar: an R/C pair
		// owes a second path token whether or not the pair is documented.
		["an undocumented rename pair missing its old-path token", "MR"],
	])("rejects %s (%j) as unparseable", async (_label, status) => {
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: `${status} malformed.ts\0`,
		});

		await expect(
			recoverOpaqueChangesViaGit("/repo", Date.now()),
		).resolves.toEqual({
			verdict: "unknown",
			paths: [],
			unknownReason: "git-status-parse-failed",
			scannedCount: 0,
		});
	});

	// #2060 F4: safe-spawn caps stdout before the child finishes. A capped
	// status listing is a PREFIX of the truth, so treating it as complete would
	// report "clean" for every path the cap removed.
	//
	// #2100: both real cap shapes, not the status-0 pairing the first version of
	// this test invented. The cap kill is a SIGTERM, so it also carries an error
	// and a null status — the reason the guard has to precede the git-failed one.
	it.each([
		["the cap killed the child", capKilledSpawnResult],
		["the child exited before the SIGTERM landed", capFastExitSpawnResult],
	])("fails closed as a parse failure when %s", async (_label, shape) => {
		safeSpawnAsync.mockResolvedValue(shape({ stdout: " M kept.ts\0" }));

		await expect(
			recoverOpaqueChangesViaGit("/repo", Date.now()),
		).resolves.toEqual({
			verdict: "unknown",
			paths: [],
			unknownReason: "git-status-parse-failed",
			scannedCount: 0,
		});
	});

	it("caps git status stdout so the truncation guard can fire at all", async () => {
		safeSpawnAsync.mockResolvedValue({ status: 0, stdout: "" });

		await recoverOpaqueChangesViaGit("/repo", Date.now());

		expect(safeSpawnAsync).toHaveBeenCalledWith(
			"git",
			expect.any(Array),
			expect.objectContaining({ maxOutputBytes: 16 * 1024 * 1024 }),
		);
	});

	// #2060: an undocumented pair is never classified as incoming, so widening
	// the table can only ever ADD exclusions, never remove capture by surprise.
	//
	// #2081: excludedIncomingCount only counts entries that pass the
	// mtime-freshness window (would otherwise have been dispatched), so this
	// case needs REAL, freshly-written files on disk for every entry the
	// assertion depends on - not just the excluded one. A path that never
	// exists fails the window check for the wrong reason (ENOENT, not the
	// classification under test) and would pass this test even if `U ` were
	// misclassified as clean incoming, since its absence keeps it out of
	// `paths` either way.
	it("never treats an undocumented pair as clean incoming content", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-opaque-status-"),
		);
		try {
			const startedAt = Date.now();
			fs.writeFileSync(path.join(root, "path-1.ts"), "unknown\n", "utf8");
			fs.writeFileSync(path.join(root, "path-2.ts"), "staged\n", "utf8");
			safeSpawnAsync.mockResolvedValue({
				status: 0,
				stdout: porcelainOutput(["UU", "U ", "A "]),
			});

			await expect(
				recoverOpaqueChangesViaGit(root, startedAt, {
					excludeIndexOnlyWhenUnmerged: true,
				}),
			).resolves.toEqual({
				verdict: "recovered",
				// `U ` is undocumented, so it keeps its path and is dispatched.
				paths: [normalizeMapKey(path.join(root, "path-1.ts"))],
				scannedCount: 1,
				// Only `A ` is dropped. `U ` is undocumented, so it keeps its path.
				excludedIncomingCount: 1,
				unknownStatusCount: 1,
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	// Recurrence: #4493 review r1 residual 3 resolves porcelain paths against
	// the checkout top found by a file walk. An empty `.git` directory above
	// the cwd (a stray one existed at `/tmp/.git` on a maintainer host) stopped
	// that walk, so every path resolved against the wrong directory and the
	// pre-push run lost this file's dirty paths. Git skips a `.git` directory
	// with no HEAD; the walk must not answer there either.
	it("resolves porcelain paths against the cwd when the nearest .git above it is not a repository", async () => {
		const ghost = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-opaque-status-"),
		);
		try {
			fs.mkdirSync(path.join(ghost, ".git"));
			const root = path.join(ghost, "proj");
			fs.mkdirSync(root);
			const startedAt = Date.now();
			fs.writeFileSync(path.join(root, "path-0.ts"), "dirty\n", "utf8");
			safeSpawnAsync.mockResolvedValue({
				status: 0,
				stdout: porcelainOutput([" M"]),
			});

			const outcome = await recoverOpaqueChangesViaGit(root, startedAt);

			expect(outcome.paths).toEqual([
				normalizeMapKey(path.join(root, "path-0.ts")),
			]);
		} finally {
			fs.rmSync(ghost, { recursive: true, force: true });
		}
	});

	// #4508: the walk the porcelain base uses is `resolveGitCheckout`'s, so a
	// stray `.git` between the cwd and the real checkout no longer pins the
	// base to the cwd; git prints paths relative to the real top.
	it("resolves porcelain paths against the real checkout top past a stray .git below it", async () => {
		const repo = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-opaque-status-"),
		);
		try {
			fs.mkdirSync(path.join(repo, ".git"));
			fs.writeFileSync(
				path.join(repo, ".git", "HEAD"),
				"ref: refs/heads/main\n",
			);
			const sub = path.join(repo, "pkg");
			fs.mkdirSync(path.join(sub, ".git"), { recursive: true });
			const root = path.join(sub, "proj");
			fs.mkdirSync(root);
			const startedAt = Date.now();
			fs.writeFileSync(path.join(repo, "path-0.ts"), "dirty\n", "utf8");
			safeSpawnAsync.mockResolvedValue({
				status: 0,
				stdout: porcelainOutput([" M"]),
			});

			const outcome = await recoverOpaqueChangesViaGit(root, startedAt);

			expect(outcome.paths).toEqual([
				normalizeMapKey(path.join(repo, "path-0.ts")),
			]);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	it("returns an explicit unknown verdict for unterminated porcelain output", async () => {
		safeSpawnAsync.mockResolvedValue({
			status: 0,
			stdout: " M incomplete.ts",
		});

		await expect(
			recoverOpaqueChangesViaGit("/repo", Date.now()),
		).resolves.toEqual({
			verdict: "unknown",
			paths: [],
			unknownReason: "git-status-parse-failed",
			scannedCount: 0,
		});
	});
});
