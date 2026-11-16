// flake-shape: real-process-spawn — the subject is the seed script's DEFAULT
// git path (the `gitExecFileSync` argv: a depth-2 fetch of one branch into a
// `+refs/heads/...` refspec, then `rev-parse`/`show` by spec). The fetch depth,
// the refspec and the blob specs only mean something against a real git repo
// with a depth-1 clone, which an in-memory fake restates rather than proves.
/**
 * #3401 round 3 (N1) -- the seed script on REAL git, in throwaway repos.
 *
 * ## The recurrence this guards
 *
 * The in-memory git seam in `seed-matrix-from-bot-branch.test.ts` decides the
 * rows, but it never runs the script's default git path: a wrong refspec, a
 * dropped `--depth`, a `rev-parse` spec that real git rejects, or the fixture
 * env hiding a repo-local remote would all stay green there. Only a real
 * depth-1 clone, as `actions/checkout` makes, exercises them.
 *
 * Rows: bot branch ahead and built on master's doc (seeds), bot built on an
 * older master whose doc a maintainer hand-edited since (master wins), and the
 * branch missing (master wins, no throw).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BOT_BRANCH,
	IDLE_DOC,
	MATRIX_DOC,
	seedMatrixFromBotBranch,
} from "../../scripts/seed-matrix-from-bot-branch.mjs";
import { gitExecFileSync } from "../support/git-fixture-env.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return gitExecFileSync(
		"git",
		[
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd, encoding: "utf8", stdio: "pipe" },
	);
}

function commitDoc(repo: string, text: string, message: string): void {
	fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
	fs.writeFileSync(path.join(repo, MATRIX_DOC), text);
	git(repo, "add", MATRIX_DOC);
	git(repo, "commit", "-q", "-m", message);
}

function commitIdleDoc(repo: string, text: string, message: string): void {
	fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
	fs.writeFileSync(path.join(repo, IDLE_DOC), text);
	git(repo, "add", IDLE_DOC);
	git(repo, "commit", "-q", "-m", message);
}

/** The bot's night is ONE commit over both docs, as the refresh PR writes it. */
function commitBotNight(repo: string, idleText: string): void {
	fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
	fs.writeFileSync(path.join(repo, MATRIX_DOC), "BOT DOC (pending flip)\n");
	fs.writeFileSync(path.join(repo, IDLE_DOC), idleText);
	git(repo, "add", MATRIX_DOC, IDLE_DOC);
	git(repo, "commit", "-q", "-m", "bot refresh");
}

/** A throwaway "origin" with master at `docs` and an unrelated later commit. */
function makeOrigin(): { root: string; origin: string } {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-seed-matrix-git-"),
	);
	roots.push(root);
	const origin = path.join(root, "origin");
	fs.mkdirSync(origin);
	git(origin, "init", "-q", "-b", "master");
	commitDoc(origin, "MASTER DOC v1\n", "master doc v1");
	fs.writeFileSync(path.join(origin, "other.txt"), "x\n");
	git(origin, "add", "other.txt");
	git(origin, "commit", "-q", "-m", "unrelated master commit");
	return { root, origin };
}

/** A depth-1 clone of master, the way `actions/checkout` leaves the runner. */
function ciCheckout(root: string, origin: string, name: string): string {
	const work = path.join(root, name);
	git(root, "clone", "-q", "--depth", "1", `file://${origin}`, work);
	return work;
}

function seed(work: string) {
	const logs: string[] = [];
	const decision = seedMatrixFromBotBranch({
		cwd: work,
		log: (line) => logs.push(line),
	});
	return {
		decision,
		logs,
		doc: fs.readFileSync(path.join(work, MATRIX_DOC), "utf8"),
	};
}

describe("#3401 seedMatrixFromBotBranch on real git (depth-1 CI checkout)", () => {
	it("seeds from a bot branch that is ahead and built on master's current doc", () => {
		const { root, origin } = makeOrigin();
		git(origin, "checkout", "-q", "-b", BOT_BRANCH);
		commitDoc(origin, "BOT DOC (master + nightly state)\n", "bot refresh");
		git(origin, "checkout", "-q", "master");
		const result = seed(ciCheckout(root, origin, "work-fresh"));
		expect(result.decision.source).toBe("bot");
		expect(result.doc).toBe("BOT DOC (master + nightly state)\n");
	});

	it("keeps master's doc when the bot branch was built on an older master a maintainer edited since", () => {
		const { root, origin } = makeOrigin();
		git(origin, "checkout", "-q", "-b", BOT_BRANCH);
		commitDoc(origin, "BOT DOC built on v1\n", "bot refresh");
		git(origin, "checkout", "-q", "master");
		commitDoc(origin, "MASTER DOC v2 (hand edit)\n", "hand edit of the doc");
		const result = seed(ciCheckout(root, origin, "work-stale"));
		expect(result.decision.source).toBe("master");
		expect(result.decision.reason).toMatch(/stale/);
		expect(result.doc).toBe("MASTER DOC v2 (hand edit)\n");
	});

	it("keeps master's doc, without throwing, when the bot branch does not exist", () => {
		const { root, origin } = makeOrigin();
		const result = seed(ciCheckout(root, origin, "work-missing"));
		expect(result.decision.source).toBe("master");
		expect(result.logs[0]).toMatch(/absent or unreachable/);
		expect(result.doc).toBe("MASTER DOC v1\n");
	});
});

/**
 * #5667: the idle-eviction doc's pending flips live in the matrix, and its
 * published row is `docs/lsp-idle-eviction.md`. Seeding the matrix alone put a
 * restored pending night over master's older row, so while the refresh PR sat
 * unmerged the held row flipped every other night.
 */
describe("#5667 the seed restores the idle-eviction doc with the matrix (real git)", () => {
	const idleOf = (work: string) =>
		fs.readFileSync(path.join(work, IDLE_DOC), "utf8");

	it("restores the idle doc from the bot branch when the matrix is seeded", () => {
		const { root, origin } = makeOrigin();
		commitIdleDoc(origin, "IDLE DOC v1\n", "master idle doc");
		git(origin, "checkout", "-q", "-b", BOT_BRANCH);
		commitBotNight(origin, "IDLE DOC (published by the bot night)\n");
		git(origin, "checkout", "-q", "master");
		const work = ciCheckout(root, origin, "work-idle");
		const result = seed(work);
		expect(result.decision.source).toBe("bot");
		expect(idleOf(work)).toBe("IDLE DOC (published by the bot night)\n");
		expect(
			result.logs.some((l) =>
				l.startsWith("idle-eviction doc seed: using bot"),
			),
		).toBe(true);
	});

	it("keeps master's idle doc when a maintainer edited it since the bot branch was built", () => {
		const { root, origin } = makeOrigin();
		commitIdleDoc(origin, "IDLE DOC v1\n", "master idle doc");
		git(origin, "checkout", "-q", "-b", BOT_BRANCH);
		commitBotNight(origin, "IDLE DOC (bot)\n");
		git(origin, "checkout", "-q", "master");
		commitIdleDoc(
			origin,
			"IDLE DOC v2 (hand edit)\n",
			"hand edit of the idle doc",
		);
		const work = ciCheckout(root, origin, "work-idle-stale");
		const result = seed(work);
		expect(result.decision.source).toBe("bot");
		expect(idleOf(work)).toBe("IDLE DOC v2 (hand edit)\n");
	});

	it("leaves master's idle doc alone when the matrix is not seeded", () => {
		const { root, origin } = makeOrigin();
		commitIdleDoc(origin, "IDLE DOC v1\n", "master idle doc");
		const work = ciCheckout(root, origin, "work-idle-nobot");
		seed(work);
		expect(idleOf(work)).toBe("IDLE DOC v1\n");
	});
});
