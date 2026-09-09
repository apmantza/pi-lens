/**
 * Tests for the CLI seams of scripts/prune-agent-worktrees.mjs (#2435).
 *
 * The destructive logic lives in scripts/lib/worktree-hygiene.mjs and is
 * covered by worktree-hygiene.test.ts. What is left here is the surface that
 * decides HOW that logic is invoked — argument parsing, the SubagentStop
 * payload mapping, the worktree-activity rail that decides age, and the
 * ledger location. The platform process-table parsers moved to
 * tests/scripts/process-scan.test.ts with the listing itself (review round
 * 3, F2). Importing the module runs no sweep: its `isEntryPoint()` guard
 * is false under vitest.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_GIT_TIMEOUT_MS,
	DEFAULT_HOOK_BUDGET_MS,
	DEFAULT_MANUAL_BUDGET_MS,
	DEFAULT_SCAN_TIMEOUT_MS,
	HOOK_POLICIES,
	HOOK_REMOVE_RESERVE_MS,
	HOOK_TIMEOUT_MARGIN_MS,
	HOOK_TIMEOUT_MS,
	MIN_SCAN_BUDGET_MS,
	RECHECK_TIMEOUT_MS,
	REMOVE_TIMEOUT_MS,
	getHygieneLogPath,
	hookBudgetMs,
	isDirty,
	keptReasonFor,
	parseArgs,
	recheckBoundMs,
	removeBoundMs,
	resolveHookPolicy,
	scanReserveMs,
	worktreeActivityMs,
	worktreePathFromHookPayload,
} from "../../scripts/prune-agent-worktrees.mjs";
import {
	DEFAULT_MIN_AGE_MS,
	planWorktreePrune,
} from "../../scripts/lib/worktree-hygiene.mjs";
import { gitExecFileSync, gitFixtureEnv } from "../support/git-fixture-env.js";

describe("parseArgs", () => {
	it("defaults to a non-destructive-by-omission configuration", () => {
		const options = parseArgs([]);
		expect(options).toMatchObject({
			dryRun: false,
			minAgeMs: DEFAULT_MIN_AGE_MS,
			budgetMs: null,
			scanTimeoutMs: null,
			only: null,
			hook: null,
			keepAgentTree: false,
			orphanSweep: true,
			errors: [],
		});
	});

	it("parses --keep-agent-tree, the SubagentStop reap opt-out", () => {
		// The registered hook reaps the stopped agent's tree; an operator who
		// resumes agents by SendMessage turns that off with this flag (or the
		// PILENS_HYGIENE_KEEP_AGENT_TREES env spelling, folded in by main()).
		expect(parseArgs(["--keep-agent-tree"])).toMatchObject({
			keepAgentTree: true,
			errors: [],
		});
	});

	it("parses --scan-timeout-ms and rejects an unusable one", () => {
		// The listing ceiling is the knob #2486 is about; it is separate from
		// the sweep budget precisely so a short listing cannot squeeze the
		// `git` calls that decide whether a tree is removable.
		expect(parseArgs(["--scan-timeout-ms", "8s"])).toMatchObject({
			scanTimeoutMs: 8_000,
			errors: [],
		});
		expect(parseArgs(["--scan-timeout-ms", "0"]).errors).toEqual([
			"invalid --scan-timeout-ms value: 0",
		]);
		expect(parseArgs(["--scan-timeout-ms", "soon"]).errors).toHaveLength(1);
	});

	it("parses the flags the hooks and a human actually pass", () => {
		const options = parseArgs([
			"--dry-run",
			"--min-age",
			"90s",
			"--only",
			"/a",
			"--only",
			"/b",
			"--hook",
			"subagent-stop",
			"--budget-ms",
			"5s",
			"--no-orphan-sweep",
			"--json",
			"--quiet",
		]);
		expect(options).toMatchObject({
			dryRun: true,
			minAgeMs: 90_000,
			budgetMs: 5_000,
			only: ["/a", "/b"],
			hook: "subagent-stop",
			orphanSweep: false,
			json: true,
			quiet: true,
			errors: [],
		});
	});

	it("rejects a mis-typed --min-age instead of silently disabling the age rail", () => {
		const options = parseArgs(["--min-age", "thirty-minutes"]);
		expect(options.errors).toEqual(["invalid --min-age value: thirty-minutes"]);
		expect(options.minAgeMs).toBe(DEFAULT_MIN_AGE_MS);
	});

	it("rejects a zero or unparseable --budget-ms", () => {
		expect(parseArgs(["--budget-ms", "0"]).errors).toHaveLength(1);
		expect(parseArgs(["--budget-ms", "soon"]).errors).toHaveLength(1);
	});

	it("rejects an unknown hook event and an unknown flag", () => {
		expect(parseArgs(["--hook", "PreToolUse"]).errors).toEqual([
			"unknown --hook event: PreToolUse",
		]);
		expect(parseArgs(["--delete-everything"]).errors).toEqual([
			"unknown argument: --delete-everything",
		]);
	});

	it("keeps a 2s floor for a hook whose timeout is unknown", () => {
		// #2435 sized every hook run at 2s; #2486 made that the FLOOR and the
		// answer for an unregistered event, with the real budget derived from
		// the hook timeout (see hookBudgetMs below).
		expect(DEFAULT_HOOK_BUDGET_MS).toBeLessThanOrEqual(2_000);
		expect(DEFAULT_MANUAL_BUDGET_MS).toBeGreaterThan(DEFAULT_HOOK_BUDGET_MS);
		expect(hookBudgetMs("who-knows", resolveHookPolicy("subagent-stop"))).toBe(
			DEFAULT_HOOK_BUDGET_MS,
		);
	});
});

describe("worktreePathFromHookPayload", () => {
	const repoRoot = path.resolve("/repo");

	it("maps a SubagentStop payload's agent_id to that agent's worktree", () => {
		expect(
			worktreePathFromHookPayload(
				{ hook_event_name: "SubagentStop", agent_id: "a185ed4e565ad3d4d" },
				repoRoot,
			),
		).toBe(
			path.join(repoRoot, ".claude", "worktrees", "agent-a185ed4e565ad3d4d"),
		);
	});

	it("returns null when the payload carries no usable agent id", () => {
		// Then the caller falls back to the default sweep rather than guessing
		// which tree the finished agent owned.
		expect(worktreePathFromHookPayload(null, repoRoot)).toBeNull();
		expect(worktreePathFromHookPayload({}, repoRoot)).toBeNull();
		expect(worktreePathFromHookPayload({ agent_id: 42 }, repoRoot)).toBeNull();
		expect(worktreePathFromHookPayload("nonsense", repoRoot)).toBeNull();
	});

	it("refuses an agent id that could escape the worktrees directory", () => {
		for (const agentId of ["../../..", "a/../../b", "a\\b", "with space", ""]) {
			expect(worktreePathFromHookPayload({ agent_id: agentId }, repoRoot)).toBe(
				null,
			);
		}
	});
});

describe("getHygieneLogPath", () => {
	const saved = {
		data: process.env.PILENS_DATA_DIR,
		home: process.env.PI_LENS_HOME,
	};

	beforeEach(() => {
		delete process.env.PILENS_DATA_DIR;
		delete process.env.PI_LENS_HOME;
	});

	afterEach(() => {
		if (saved.data === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = saved.data;
		if (saved.home === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = saved.home;
	});

	it("falls back to ~/.pi-lens/hygiene.log", () => {
		expect(getHygieneLogPath()).toBe(
			path.join(os.homedir(), ".pi-lens", "hygiene.log"),
		);
	});

	it("honors PI_LENS_HOME", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-hyg-home-"));
		try {
			process.env.PI_LENS_HOME = dir;
			expect(getHygieneLogPath()).toBe(path.join(dir, "hygiene.log"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prefers PILENS_DATA_DIR over PI_LENS_HOME", () => {
		process.env.PI_LENS_HOME = path.join(os.tmpdir(), "home-should-lose");
		process.env.PILENS_DATA_DIR = path.join(os.tmpdir(), "data-should-win");
		expect(getHygieneLogPath()).toBe(
			path.join(os.tmpdir(), "data-should-win", "hygiene.log"),
		);
	});
});

// ---------------------------------------------------------------------------
// PR #2438 review round 1 (S1, S8, S9)
// ---------------------------------------------------------------------------

describe("resolveHookPolicy (review S1/S8)", () => {
	it("reaps the stopped agent's own tree on SubagentStop (#2486)", () => {
		// Maintainer decision, 2026-09-02, reversing PR #2438's review S1. S1
		// forbade removal here because resume-by-SendMessage lands after the
		// hook fires; the cost was #2486 — the REGISTERED line passes no
		// --only, so it removed nothing, only SessionStart's one-tree cap
		// drained anything, and ten trees accumulated in an afternoon.
		expect(resolveHookPolicy("subagent-stop")).toMatchObject({
			removeWorktrees: true,
			deleteBranches: true,
			orphanSweep: true,
			// Still scoped: the tree comes from the payload's agent_id, and
			// the orphan sweep never reaches a sibling agent's helpers.
			scopedToAgentTree: true,
			// One payload names one tree.
			maxRemovals: 1,
			budgetSource: "hook",
		});
	});

	it("honors the --keep-agent-tree opt-out without widening anything else", () => {
		// The trade-off the opt-out exists for: an agent resumed by
		// SendMessage after its tree was reaped must recreate the checkout.
		const kept = resolveHookPolicy("subagent-stop", { keepAgentTree: true });
		expect(kept).toMatchObject({
			removeWorktrees: false,
			deleteBranches: false,
			// The orphan-fixture sweep under that agent's tree still runs.
			orphanSweep: true,
			scopedToAgentTree: true,
			maxRemovals: 0,
		});
		// ...and it is only ever consulted for this event.
		expect(resolveHookPolicy("session-start", { keepAgentTree: true })).toBe(
			resolveHookPolicy("session-start"),
		);
		expect(resolveHookPolicy(null, { keepAgentTree: true })).toBe(
			HOOK_POLICIES.manual,
		);
	});

	it("treats `--hook subagent-stop --only` as exactly the manual policy", () => {
		// PR #2493 review round 2, T1. This form used to be its own
		// `subagent-stop-only` table entry whose six fields were identical to
		// `manual` — a hand-maintained mirror of another value, which is the
		// duplication this repo's single-source-of-truth rule exists to stop.
		// It is a caller at a terminal naming trees by hand: it IS a manual
		// run, and now returns the very same frozen object.
		expect(resolveHookPolicy("subagent-stop", { only: ["/a", "/b"] })).toBe(
			HOOK_POLICIES.manual,
		);
		expect(HOOK_POLICIES["subagent-stop-only"]).toBeUndefined();
		// An empty or absent --only is NOT "named a tree", so it stays the
		// reaping hook policy.
		expect(resolveHookPolicy("subagent-stop", { only: [] })).toBe(
			resolveHookPolicy("subagent-stop"),
		);
		expect(resolveHookPolicy("subagent-stop", { only: null })).toBe(
			resolveHookPolicy("subagent-stop"),
		);
	});

	it("never lets --only widen what SessionStart may do", () => {
		// session-start drops --only with a warning, so its policy must not
		// change shape when one is passed.
		expect(resolveHookPolicy("session-start", { only: ["/a"] })).toBe(
			resolveHookPolicy("session-start"),
		);
	});

	it("removes at most one tree per SessionStart run", () => {
		// The hook has a hard wall-clock timeout and `git worktree remove` is
		// bounded at REMOVE_TIMEOUT_MS; more than one removal per run cannot fit
		// inside any sane hook timeout, and a SIGKILLed removal leaves a
		// half-removed tree.
		expect(resolveHookPolicy("session-start")).toMatchObject({
			removeWorktrees: true,
			deleteBranches: true,
			scopedToAgentTree: false,
			maxRemovals: 1,
		});
	});

	it("leaves a manual run uncapped", () => {
		// Uncapped is Infinity, not a falsy number (review round 3, F4):
		// capRemovals now reads 0 as ZERO, so uncapped had to stop being
		// spelled by anything that could be confused with it.
		expect(resolveHookPolicy(null)).toMatchObject({
			removeWorktrees: true,
			deleteBranches: true,
			scopedToAgentTree: false,
			maxRemovals: Number.POSITIVE_INFINITY,
		});
	});

	it("treats an unknown event as a manual run rather than a destructive one", () => {
		expect(resolveHookPolicy("who-knows")).toEqual(resolveHookPolicy(null));
	});
});

describe(".claude/settings.json hook registration (review S8/S9)", () => {
	const settingsPath = path.resolve(__dirname, "../../.claude/settings.json");
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

	it("tracks hooks only — permissions stay in the ignored settings.local.json", () => {
		// The maintainer's own .claude/settings.json holds a permissions.allow
		// list. Tracking anything but hooks here would collide with it on merge.
		expect(Object.keys(settings).sort()).toEqual(["$schema", "hooks"]);
	});

	it("gives SessionStart room to finish one bounded worktree removal", () => {
		const timeoutS = settings.hooks.SessionStart[0].hooks[0].timeout;
		expect(timeoutS * 1000).toBeGreaterThanOrEqual(REMOVE_TIMEOUT_MS + 10_000);
	});

	it("runs the sweep on startup and resume only (review round 3, F1c)", () => {
		// Without a matcher, SessionStart fires for `clear`, `compact` and
		// `fork` too — so a long session re-ran the whole sweep every time it
		// auto-compacted, roughly every 20 minutes, for no hygiene gain.
		// Matcher semantics, from the settings schema at
		// json.schemastore.org/claude-code-settings.json and
		// code.claude.com/docs/en/hooks#matcher-patterns: a value of only
		// letters, digits, `_`, `-`, spaces, `,` and `|` is an exact-string
		// list separated by `|` or `,`; the SessionStart matcher filters on
		// `source`, whose values are startup | resume | clear | compact | fork.
		const group = settings.hooks.SessionStart[0];
		expect(group.matcher).toBe("startup|resume");
		expect(group.matcher).toMatch(/^[A-Za-z0-9_\-, |]+$/);
		const sources = String(group.matcher).split("|");
		expect(sources).toEqual(["startup", "resume"]);
		for (const noisy of ["clear", "compact", "fork"]) {
			expect(sources).not.toContain(noisy);
		}
	});

	it("registers the SubagentStop line that actually reaps (#2486)", () => {
		// The whole of #2486 is that the REGISTERED line removed nothing: the
		// only removing form was `--only`, which no caller passed. So this
		// asserts the argv itself — what it must carry, and what it must NOT.
		const entry = settings.hooks.SubagentStop[0].hooks[0];
		const command = String(entry.command);
		expect(command).toContain("scripts/prune-agent-worktrees.mjs");
		expect(command).toContain("--hook subagent-stop");
		expect(command).toContain("--quiet");
		// If the registered line ever needs `--only` to remove anything, the
		// reap is back to being unreachable from the hook — which is the bug.
		expect(command).not.toContain("--only");
		// ...and it must not ship with the operator opt-out baked in.
		expect(command).not.toContain("--keep-agent-tree");
		// The reap has to FIT: budget + BOTH bounded `git()` calls the removal
		// phase can make (the pre-remove `isDirty()` recheck, then `git
		// worktree remove` itself) + margin. PR #2493 round 4, N3: this used
		// to count only the removal call, leaving the recheck's identical
		// `removeBound` reserve entirely unaccounted for -- an assertion, not
		// a bound, since nothing enforced it against what the code actually
		// ran (subagent-stop's real worst case reached 20s against this same
		// 15s timeout).
		const policy = resolveHookPolicy("subagent-stop");
		expect(policy.removeWorktrees).toBe(true);
		expect(
			hookBudgetMs("subagent-stop", policy) +
				recheckBoundMs("subagent-stop", policy) +
				removeBoundMs("subagent-stop", policy) +
				HOOK_TIMEOUT_MARGIN_MS,
		).toBeLessThanOrEqual(entry.timeout * 1000);
	});
});

// ---------------------------------------------------------------------------
// PR #2438 review round 3 (F1) — the sweep must survive its own inspection
// ---------------------------------------------------------------------------

describe("worktreeActivityMs across a real `git status` (review round 3, F1)", () => {
	// The pure half of this rail is covered by worktree-hygiene.test.ts. What
	// only a REAL worktree can prove is the premise it rests on: that
	// `git status --porcelain` — the command the dirty rail runs inside the
	// tree — bumps `<admin>` and `<admin>/index` while leaving the checkout
	// directory, `<admin>/HEAD` and `<admin>/logs/HEAD` alone. Reading the
	// bumped signals collapsed every candidate to `age 0ms`, so `too-young`
	// rejected all of them and the sweep removed nothing, ever.

	let fixtureRoot = "";
	let repo = "";
	let worktree = "";
	const BACKDATE_MS = 3 * 60 * 60_000;

	const git = (args: string[], cwd: string) =>
		gitExecFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: "pipe",
		}) as string;

	function adminDirOf(worktreePath: string): string {
		const dotGit = path.join(worktreePath, ".git");
		if (fs.statSync(dotGit).isDirectory()) return dotGit;
		const match = /^gitdir:\s*(.+)$/m.exec(
			fs.readFileSync(dotGit, "utf8").trim(),
		);
		expect(match, "worktree .git file must name its admin dir").toBeTruthy();
		return path.resolve(worktreePath, (match as RegExpExecArray)[1].trim());
	}

	beforeEach(() => {
		fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-f1-"));
		repo = path.join(fixtureRoot, "repo");
		fs.mkdirSync(repo);
		git(["init", "-q", "-b", "master"], repo);
		// Identities from tests/support/git-config-guard.ts KNOWN_FIXTURE_*; a
		// literal this repo does not already register reds git-fixture-governance.
		git(["config", "user.email", "test@example.com"], repo);
		git(["config", "user.name", "pi-lens test"], repo);
		fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
		git(["add", "a.txt"], repo);
		git(["commit", "-qm", "init"], repo);
		// Shaped like a real agent worktree, so isAgentWorktreePath holds and
		// the plan below is the production one rather than a synthetic path.
		worktree = path.join(repo, ".claude", "worktrees", "agent-deadbeef");
		git(
			["worktree", "add", "-q", "-b", "worktree-agent-deadbeef", worktree],
			repo,
		);
	});

	afterEach(() => {
		try {
			git(["worktree", "remove", "--force", worktree], repo);
		} catch {
			/* an assertion already failed; cleanup is best-effort */
		}
		fs.rmSync(fixtureRoot, { recursive: true, force: true });
	});

	/**
	 * Age the worktree by BACKDATE_MS the way three hours of wall clock would:
	 * every mtime moves back, AND the reflog's recorded entry timestamps move
	 * back with them. Rewriting only mtimes would leave a reflog that still
	 * says "HEAD moved just now", which is a genuinely young tree — the rail
	 * would be right to keep it, and the test would prove nothing.
	 */
	function backdateEverySignal(nowMs: number): void {
		const admin = adminDirOf(worktree);
		const reflog = path.join(admin, "logs", "HEAD");
		if (fs.existsSync(reflog)) {
			const shifted = fs
				.readFileSync(reflog, "utf8")
				.replace(
					/(\s)(\d{9,12})(\s[+-]\d{4})/g,
					(_all, before, seconds, after) =>
						`${before}${Number(seconds) - Math.round(BACKDATE_MS / 1000)}${after}`,
				);
			fs.writeFileSync(reflog, shifted);
		}
		const past = new Date(nowMs - BACKDATE_MS);
		for (const target of [
			worktree,
			admin,
			path.join(admin, "HEAD"),
			path.join(admin, "index"),
			reflog,
		]) {
			if (fs.existsSync(target)) fs.utimesSync(target, past, past);
		}
	}

	it("still reports the tree as hours old after the dirty rail has run", () => {
		const nowMs = Date.now();
		backdateEverySignal(nowMs);

		// Exactly the call isDirty() makes, and the reason the tree looked new.
		expect(git(["status", "--porcelain"], worktree).trim()).toBe("");

		const ageMs = nowMs - worktreeActivityMs(worktree, nowMs);
		expect(
			ageMs,
			`activity read ${ageMs}ms old; the sweep's own git status reset it`,
		).toBeGreaterThan(BACKDATE_MS - 60_000);
	});

	it("plans a backdated clean, pushed tree for REMOVAL after isDirty ran", () => {
		// The acceptance shape: age measured, dirtiness measured, verdict
		// `remove`. On the pre-fix reading this tree came back `too-young`
		// with `age 0ms`.
		const nowMs = Date.now();
		backdateEverySignal(nowMs);
		const dirty = git(["status", "--porcelain"], worktree).trim() !== "";
		const mtimeMs = worktreeActivityMs(worktree, nowMs);

		const plan = planWorktreePrune({
			worktrees: [
				{
					path: worktree,
					head: "deadbeef",
					branch: "refs/heads/worktree-agent-deadbeef",
					dirty,
					pushed: true,
					mtimeMs,
					locked: false,
					lockPid: null,
				},
			] as never,
			nowMs,
			minAgeMs: DEFAULT_MIN_AGE_MS,
		});

		expect(
			plan.keep.map((k: { reason: string; detail: string | null }) => [
				k.reason,
				k.detail,
			]),
		).toEqual([]);
		expect(plan.remove.map((r: { path: string }) => r.path)).toEqual([
			worktree,
		]);
	});

	it("keeps reading a tree whose HEAD genuinely moved as recent", () => {
		// The rail must still SEE real activity, or it would reap live trees.
		const nowMs = Date.now();
		backdateEverySignal(nowMs);
		git(["checkout", "-q", "--detach"], worktree);
		expect(nowMs - worktreeActivityMs(worktree, nowMs)).toBeLessThan(60_000);
	});
});

describe("candidate enrichment order (review round 3, F1b)", () => {
	// Defense in depth for the rail above: object-literal properties evaluate
	// in source order, and the shipped version read activity AFTER running
	// `git status` inside the tree. The admissible signals now refuse that
	// write, so the order is no longer load-bearing — but a signal added to
	// the gatherer later would make it load-bearing again, silently.
	const source = fs.readFileSync(
		path.resolve(__dirname, "../../scripts/prune-agent-worktrees.mjs"),
		"utf8",
	);

	it("reads worktree activity before anything that runs git in the tree", () => {
		const activityAt = source.indexOf("worktreeActivityMs(row.path, nowMs)");
		// #2631 renamed the enrichment-time status read: `isDirty(row.path, …)`
		// became `statusSnapshot(row.path, …)` so the keep record can name the
		// first porcelain entry it protected. `statusSnapshot` IS the call that
		// runs `git status` inside the tree, so the invariant this pins is
		// unchanged: activity is read BEFORE it.
		const dirtyAt = source.indexOf("statusSnapshot(row.path,");
		expect(
			activityAt,
			"worktreeActivityMs(row.path, …) call site",
		).toBeGreaterThan(-1);
		expect(dirtyAt, "statusSnapshot(row.path, …) call site").toBeGreaterThan(
			-1,
		);
		expect(activityAt).toBeLessThan(dirtyAt);
	});
});

describe("isDirty (review round 3, F2)", () => {
	// A real repo, not a hand-fed input: the tri-state distinguishes a
	// genuinely dirty porcelain output from a `git status` that could not be
	// answered at all -- both must refuse removal, but only the first one is
	// evidence of protected work.
	let root = "";
	let repo = "";

	const git = (args: string[], cwd: string) =>
		gitExecFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: "pipe",
		}) as string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-f2-"));
		repo = path.join(root, "repo");
		fs.mkdirSync(repo);
		git(["init", "-q", "-b", "master"], repo);
		git(["config", "user.email", "test@example.com"], repo);
		git(["config", "user.name", "pi-lens test"], repo);
		fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
		git(["add", "a.txt"], repo);
		git(["commit", "-qm", "init"], repo);
	});

	afterEach(() => {
		// `maxRetries`/`retryDelay` (not just `force`): on Windows a directory
		// that was very recently a live process's cwd (the F1 case's held
		// helper, any spawned CLI still tearing down) can stay briefly locked
		// after the process exits -- an EPERM/EBUSY race independent of
		// whether this test itself killed anything, so it is handled here
		// once for every case in this describe block rather than per-test.
		fs.rmSync(root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 200,
		});
	});

	it('reads a clean porcelain output as "clean"', () => {
		expect(isDirty(repo)).toBe("clean");
	});

	it('reads a non-empty porcelain output as "dirty"', () => {
		fs.writeFileSync(path.join(repo, "b.txt"), "uncommitted\n");
		expect(isDirty(repo)).toBe("dirty");
	});

	it('reads a `git status` that cannot be answered as "unreadable", never "clean"', () => {
		// Not a hand-fed string: a real `git status --porcelain` run with a cwd
		// git cannot resolve a repository from -- the same execFileSync/catch
		// path a wedged or timed-out call takes (`git()` returns null either
		// way), covered here for the outcome that matters: never "clean".
		const notARepo = path.join(root, "not-a-repo");
		fs.mkdirSync(notARepo);
		expect(isDirty(notARepo)).toBe("unreadable");
	});
});

// ---------------------------------------------------------------------------
// #2486 — the SubagentStop hook that silently reaped nothing
// ---------------------------------------------------------------------------

describe("hookBudgetMs (#2486)", () => {
	it("mirrors the timeouts actually registered in .claude/settings.json", () => {
		// Single source of truth: HOOK_TIMEOUT_MS is a mirror of the settings
		// file, and a mirror that can drift is the defect this repo keeps
		// finding. Reading the real file here is what pins it.
		const settings = JSON.parse(
			fs.readFileSync(
				path.resolve(__dirname, "../../.claude/settings.json"),
				"utf8",
			),
		);
		expect(HOOK_TIMEOUT_MS["session-start"]).toBe(
			settings.hooks.SessionStart[0].hooks[0].timeout * 1000,
		);
		expect(HOOK_TIMEOUT_MS["subagent-stop"]).toBe(
			settings.hooks.SubagentStop[0].hooks[0].timeout * 1000,
		);
	});

	it("sizes each hook's sweep budget to the timeout that will kill it", () => {
		// #2486: both hooks shared a flat 2s budget. SessionStart then spent
		// 800ms of enrichment on 12 trees and reported 6 `not-evaluated`, and
		// SubagentStop could not fit a process listing that costs ~650ms
		// median on Windows inside its share of the same 2s.
		const sessionStart = resolveHookPolicy("session-start");
		expect(hookBudgetMs("session-start", sessionStart)).toBe(
			HOOK_TIMEOUT_MS["session-start"] -
				REMOVE_TIMEOUT_MS -
				RECHECK_TIMEOUT_MS -
				HOOK_TIMEOUT_MARGIN_MS,
		);
		const subagentStop = resolveHookPolicy("subagent-stop");
		expect(hookBudgetMs("subagent-stop", subagentStop)).toBe(
			HOOK_TIMEOUT_MS["subagent-stop"] -
				HOOK_REMOVE_RESERVE_MS["subagent-stop"] -
				RECHECK_TIMEOUT_MS -
				HOOK_TIMEOUT_MARGIN_MS,
		);

		// THE invariant, for every hook that can remove: the sweep budget, BOTH
		// bounded `git()` calls the removal phase can make (the pre-remove
		// `isDirty()` recheck, then `git worktree remove` itself), and the
		// margin together fit inside the timeout Claude Code will kill it at.
		// It is only an invariant because `recheckBoundMs`/`removeBoundMs` are
		// the SAME numbers the removal phase is actually given — a reserve
		// that no `git()` call honors is a claim, not a bound (PR #2493 round
		// 4, N3: this used to count only ONE of the two calls).
		for (const hook of ["subagent-stop", "session-start"] as const) {
			const policy = resolveHookPolicy(hook);
			expect(policy.removeWorktrees).toBe(true);
			expect(
				hookBudgetMs(hook, policy) +
					recheckBoundMs(hook, policy) +
					removeBoundMs(hook, policy) +
					HOOK_TIMEOUT_MARGIN_MS,
			).toBeLessThanOrEqual(HOOK_TIMEOUT_MS[hook]);
			// ...and the budget must not be the 2s FLOOR, which is what a 60s
			// removal reserve against a 15s timeout collapses to.
			expect(hookBudgetMs(hook, policy)).toBeGreaterThan(
				DEFAULT_HOOK_BUDGET_MS,
			);
		}
	});

	it("bounds a removal by the reserve its own hook budget subtracted", () => {
		// Measured on this box 2026-09-02: `git worktree remove --force
		// --force` over a 4000-file worktree cost min 956ms / median 1049ms /
		// max 1171ms across 5 runs (300-file tree: 146/181/755ms). Reserving
		// the comfortable 60s inside a 15s hook timeout is arithmetically
		// impossible; reserving 5s is ~4.8x the measured median.
		expect(HOOK_REMOVE_RESERVE_MS["subagent-stop"]).toBeGreaterThanOrEqual(
			4_000,
		);
		expect(HOOK_REMOVE_RESERVE_MS["session-start"]).toBe(REMOVE_TIMEOUT_MS);
		expect(
			removeBoundMs("subagent-stop", resolveHookPolicy("subagent-stop")),
		).toBe(HOOK_REMOVE_RESERVE_MS["subagent-stop"]);
		// A mode that cannot remove reserves nothing...
		expect(
			removeBoundMs(
				"subagent-stop",
				resolveHookPolicy("subagent-stop", { keepAgentTree: true }),
			),
		).toBe(0);
		// ...and a manual run, which no hook timeout kills, keeps the generous
		// bound: SIGKILLing git mid-delete leaves a half-removed tree.
		expect(removeBoundMs("subagent-stop", resolveHookPolicy(null))).toBe(
			REMOVE_TIMEOUT_MS,
		);
	});

	it("bounds the pre-remove recheck by its OWN small reserve, not removeBoundMs's (PR #2493 round 4, N3)", () => {
		// The recheck used to silently reuse `removeBoundMs` -- a SECOND
		// removeBound-sized `git()` call `hookBudgetMs` never subtracted room
		// for, which is what let subagent-stop's real worst case reach 20s
		// against its 15s timeout. It gets its own, much smaller reserve.
		expect(RECHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
		expect(RECHECK_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
		expect(RECHECK_TIMEOUT_MS).toBeLessThan(
			HOOK_REMOVE_RESERVE_MS["subagent-stop"],
		);
		for (const hook of ["subagent-stop", "session-start"] as const) {
			expect(recheckBoundMs(hook, resolveHookPolicy(hook))).toBe(
				RECHECK_TIMEOUT_MS,
			);
		}
		// A mode that cannot remove never runs the recheck either, and
		// reserves nothing for it -- mirroring `removeBoundMs`.
		expect(
			recheckBoundMs(
				"subagent-stop",
				resolveHookPolicy("subagent-stop", { keepAgentTree: true }),
			),
		).toBe(0);
		// A manual run gets the ordinary per-`git`-call default: no hook
		// timeout is pressuring it down to a 1s bound.
		expect(recheckBoundMs("subagent-stop", resolveHookPolicy(null))).toBe(
			DEFAULT_GIT_TIMEOUT_MS,
		);
	});

	it("never lets the listing reserve starve the enrichment (#2486)", () => {
		// The enrichment runs FIRST and decides whether a tree is removable at
		// all; the listing only decides what gets killed. Reserving the whole
		// 4s ceiling out of SubagentStop's 5s budget left enrichment 1s, and
		// every `git` call then drops to its 250ms floor — which `isDirty`
		// reads as "unreadable => dirty" and keeps the very tree the hook
		// fired to reap.
		expect(scanReserveMs(5_000, 4_000)).toBe(2_500);
		// Where there is room, the ceiling is the reserve unchanged.
		expect(scanReserveMs(25_000, 4_000)).toBe(4_000);
		expect(scanReserveMs(60_000, 4_000)).toBe(4_000);
		// Degenerate inputs stay non-negative rather than producing a deadline
		// in the future of the budget.
		expect(scanReserveMs(0, 4_000)).toBe(0);
		expect(scanReserveMs(5_000, -1)).toBe(0);
		// On every registered hook the reserve is still enough for a listing
		// to be attempted at all rather than skipped outright.
		for (const hook of ["subagent-stop", "session-start"] as const) {
			const budget = hookBudgetMs(hook, resolveHookPolicy(hook));
			const reserve = scanReserveMs(budget, DEFAULT_SCAN_TIMEOUT_MS);
			expect(reserve).toBeGreaterThanOrEqual(MIN_SCAN_BUDGET_MS);
			expect(reserve).toBeLessThanOrEqual(budget / 2);
		}
	});

	it("gives an --only run the manual budget, not a floored hook budget", () => {
		// The registered hook line never passes --only, so this form is always
		// a caller at a terminal. Reserving 60s of removal out of a 15s
		// timeout would floor the budget at 2s and leave every enrichment
		// `git` call on its 250ms minimum — the dirty rail would then read
		// "unreadable => dirty" and keep the very tree it was told to remove.
		const policy = resolveHookPolicy("subagent-stop", { only: ["/a"] });
		expect(policy.budgetSource).toBe("manual");
		expect(hookBudgetMs("subagent-stop", policy)).toBe(
			DEFAULT_MANUAL_BUDGET_MS,
		);
	});

	it("keeps a bounded scan ceiling that fits inside every budget it is used in", () => {
		// Measured 2026-09-02 on the #2486 box, 12 concurrent agent worktrees:
		// min 584ms / median 651ms / max 707ms for one 467-row listing. The
		// shipped 1200ms was ~1.8x the median and failed three times in one
		// afternoon under build load.
		expect(DEFAULT_SCAN_TIMEOUT_MS).toBeGreaterThanOrEqual(4_000);
		for (const hook of ["subagent-stop", "session-start"] as const) {
			expect(
				hookBudgetMs(hook, resolveHookPolicy(hook)),
			).toBeGreaterThanOrEqual(DEFAULT_SCAN_TIMEOUT_MS);
		}
	});
});

describe("keptReasonFor (#2486 / PR #2493 review round 2, S2)", () => {
	const policy = resolveHookPolicy("subagent-stop");
	const target = path.resolve("/repo/.claude/worktrees/agent-a1");

	it("names the rail that refused the run's one tree", () => {
		// `fired, removed: 0` alone cannot tell "the tree was dirty, so work
		// was protected" from "the hook reaped nothing and nobody knows why".
		for (const reason of ["dirty", "unpushed", "self", "locked-live"]) {
			expect(
				keptReasonFor({
					targetPath: target,
					plan: { keep: [{ path: target, reason }] },
					deferred: [],
					policy,
				}),
			).toBe(reason);
		}
		// Path form must not matter: the hook derives a native path, git
		// reports forward slashes.
		expect(
			keptReasonFor({
				targetPath: target,
				plan: {
					keep: [{ path: target.replace(/\\/g, "/"), reason: "dirty" }],
				},
				deferred: [],
				policy,
			}),
		).toBe("dirty");
	});

	it("is null when the tree was removed, or when no single tree was in scope", () => {
		expect(
			keptReasonFor({
				targetPath: target,
				plan: { keep: [] },
				deferred: [],
				policy,
			}),
		).toBeNull();
		expect(
			keptReasonFor({
				targetPath: null,
				plan: { keep: [{ path: target, reason: "dirty" }] },
				deferred: [],
				policy,
			}),
		).toBeNull();
	});

	it("distinguishes the opt-out from a per-run removal cap", () => {
		const deferred = [{ path: target }];
		expect(
			keptReasonFor({
				targetPath: target,
				plan: { keep: [] },
				deferred,
				policy,
			}),
		).toBe("deferred");
		expect(
			keptReasonFor({
				targetPath: target,
				plan: { keep: [] },
				deferred,
				policy: resolveHookPolicy("subagent-stop", { keepAgentTree: true }),
			}),
		).toBe("removal-not-permitted");
	});
});

/**
 * #2486 end to end: the hook, its payload, the rails and the ledger, driven
 * through the REAL CLI against a throwaway repo.
 *
 * These have to be end-to-end, and they have to drive the REGISTERED argv. The
 * bug was not in any pure seam — every one of them was already right
 * (`planWorktreePrune` has always honoured a named tree over the age and lock
 * rails). It was in the wiring: `main()` short-circuited to a scoped orphan
 * sweep that had no removal step in it, and returned without writing a ledger
 * line at all when it could not derive a tree. A policy test proves the table
 * says "remove"; only a run of the whole program with the argv Claude Code
 * actually issues proves the wiring reaches it.
 *
 * The sandbox carries its own copy of the sweep under `<repo>/scripts/`,
 * because the script derives REPO_ROOT from its own location: run from the
 * real checkout it would plan over the real worktrees.
 */

/**
 * PR #2493 round 4 review comment (folded into #2501): this describe block
 * used to build repo/origin/worktree and a copy of three scripts by hand in
 * `beforeEach`, and individual cases hand-patched that copy afterward (the
 * process-scan wrapper, the `node_modules` junction, the renamed module) —
 * a platform assumption hiding in one of those hand-patches (no
 * `.gitignore` for `node_modules`, so Linux git sees the junction as
 * untracked) shipped CI red once already (review round 4). This builder
 * makes every one of those assumptions explicit in ONE place instead of
 * re-deriving them per case.
 */
function createSubagentStopFixture(agentId: string) {
	const git = (args: string[], cwd: string) =>
		gitExecFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: "pipe",
		}) as string;

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2486-"));
	const repo = path.join(root, "main");
	const ledgerDir = path.join(root, "ledger");
	fs.mkdirSync(repo, { recursive: true });
	fs.mkdirSync(ledgerDir, { recursive: true });

	// A real `origin/*` ref, because the "pushed" rail is a containment
	// query against one — a fixture without an origin would make every
	// tree unpushed and every removal assertion vacuous.
	const origin = path.join(root, "origin.git");
	git(["init", "-q", "--bare", "-b", "master", origin], root);
	git(["init", "-q", "-b", "master"], repo);
	// Identities from tests/support/git-config-guard.ts KNOWN_FIXTURE_*.
	git(["config", "user.email", "test@example.com"], repo);
	git(["config", "user.name", "pi-lens test"], repo);
	fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
	git(["add", "a.txt"], repo);
	git(["commit", "-qm", "init"], repo);
	git(["remote", "add", "origin", origin], repo);
	// PR #2493 round 5, R1: committed BEFORE `git worktree add` below, so
	// every worktree this fixture creates -- not just addNodeModulesJunction's
	// caller -- inherits it the same way a real agent worktree's checkout
	// does (`node_modules` is gitignored in this repo too). Without it an
	// untracked junction makes `git status --porcelain` report `??
	// node_modules` on Linux the moment it is created (git-for-Windows
	// silently treats the empty-target junction as absent and never reports
	// it, which is why round 4 read that as win32-only -- it was never
	// gated on the platform, only on this gap in the fixture).
	fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
	git(["add", ".gitignore"], repo);
	git(["commit", "-qm", "gitignore node_modules"], repo);
	git(["push", "-q", "-u", "origin", "master"], repo);

	const scriptsDir = path.resolve(__dirname, "../../scripts");
	fs.mkdirSync(path.join(repo, "scripts", "lib"), { recursive: true });
	const cli = path.join(repo, "scripts", "prune-agent-worktrees.mjs");
	fs.copyFileSync(path.join(scriptsDir, "prune-agent-worktrees.mjs"), cli);
	for (const file of ["worktree-hygiene.mjs", "process-scan.mjs"]) {
		fs.copyFileSync(
			path.join(scriptsDir, "lib", file),
			path.join(repo, "scripts", "lib", file),
		);
	}

	const worktree = path.join(repo, ".claude", "worktrees", `agent-${agentId}`);
	git(["worktree", "add", "-q", "-b", "pr-9001", worktree], repo);

	const processScanPath = path.join(repo, "scripts", "lib", "process-scan.mjs");
	const realProcessScanPath = path.join(
		repo,
		"scripts",
		"lib",
		"process-scan-real.mjs",
	);

	/**
	 * Review round 3, F1's technique: wrap the fixture's OWN copy of
	 * `process-scan.mjs` so `snapshotProcesses` — the one async step between
	 * enrichment's `isDirty()` call and the removal loop's own pre-remove
	 * recheck — resolves only after `delayMs`. Widens the enrichment-to-
	 * removal gap to a controlled, machine-speed-independent window instead
	 * of trusting absolute wall-clock timing.
	 */
	function patchProcessScan(delayMs: number) {
		fs.renameSync(processScanPath, realProcessScanPath);
		fs.writeFileSync(
			processScanPath,
			[
				'import * as real from "./process-scan-real.mjs";',
				'export * from "./process-scan-real.mjs";',
				"export async function snapshotProcesses(...args) {",
				`\tawait new Promise((resolve) => setTimeout(resolve, ${delayMs}));`,
				"\treturn real.snapshotProcesses(...args);",
				"}",
				"",
			].join("\n"),
		);
	}

	/**
	 * #2519: the same module-substitution hook as `patchProcessScan`, but
	 * DETERMINISTIC rather than wall-clock-timed. `snapshotProcesses` is
	 * only ever called from `readProcessTable`, itself only reached AFTER
	 * the enrichment pass's own synchronous `isDirty()` call has already
	 * returned for every candidate — both run in the same synchronous
	 * stretch of the event loop, an ordering the JS run-to-completion
	 * guarantee enforces regardless of machine speed, not a race a delay has
	 * to out-run. Corrupting the gitlink synchronously at
	 * `snapshotProcesses`'s own entry — before its `await`, so the
	 * corruption is on disk before `readProcessTable` (and therefore the
	 * recheck) can possibly resolve — therefore always lands strictly after
	 * enrichment and strictly before the pre-remove recheck, with no race
	 * window to lose under load. The earlier version of this hook raced a
	 * wall-clock 150ms `setTimeout` against enrichment's own completion:
	 * under load on Windows the 150ms could elapse before enrichment (a
	 * handful of synchronous `git` spawns) had actually returned, corrupting
	 * the gitlink DURING enrichment instead of the recheck — the candidate
	 * then took the review round 3, F2 `dirtyUnreadable` rail straight to
	 * `plan.keep` and never reached the removal loop at all, so
	 * `hygiene.worktree-removed` was never written.
	 *
	 * Same unlink-then-write trick review round 3, F2 uses: Windows denies
	 * the O_TRUNC open `writeFileSync` performs on a `.git` gitlink file
	 * `git worktree add` just created (EPERM, reproducible outside vitest
	 * too) even though a fresh create at the same path succeeds immediately
	 * after.
	 */
	function patchRecheck(gitLinkPath: string) {
		fs.renameSync(processScanPath, realProcessScanPath);
		fs.writeFileSync(
			processScanPath,
			[
				'import fs from "node:fs";',
				'import * as real from "./process-scan-real.mjs";',
				'export * from "./process-scan-real.mjs";',
				"export async function snapshotProcesses(...args) {",
				`\tconst gitLinkPath = ${JSON.stringify(gitLinkPath)};`,
				"\tfs.unlinkSync(gitLinkPath);",
				'\tfs.writeFileSync(gitLinkPath, "gitdir: /nonexistent\\n");',
				"\treturn real.snapshotProcesses(...args);",
				"}",
				"",
			].join("\n"),
		);
	}

	/**
	 * PR #2493 round 4, N1: a top-level reparse point (a junction into a
	 * directory outside the worktree) stands in for the real shared-
	 * `node_modules` link `unlinkTopLevelLinks` unlinks before `git worktree
	 * remove`. Untracked and gitignore-shaped — exactly what a real agent
	 * worktree carries — so it never makes `git status` dirty on its own.
	 */
	function addNodeModulesJunction(): string {
		const junctionTarget = path.join(root, "shared-node_modules");
		fs.mkdirSync(junctionTarget, { recursive: true });
		const junctionPath = path.join(worktree, "node_modules");
		fs.symlinkSync(
			junctionTarget,
			junctionPath,
			process.platform === "win32" ? "junction" : "dir",
		);
		return junctionPath;
	}

	/**
	 * #2519 round 2, S4: a second agent's worktree, coexisting with the
	 * fixture's own. Used by every test that has to prove a SubagentStop run
	 * never reaches beyond the stopped agent's own tree -- the #2501
	 * sibling-scoping case and its cross-platform F1 sibling below -- so it
	 * inherits the fixture's own assumptions (the pushed `origin`, the
	 * tracked `.gitignore`) the same way `worktree` above does, instead of a
	 * per-case `git worktree add` re-deriving them (the exact per-case
	 * patching this builder exists to remove).
	 */
	function addSiblingWorktree(agentId: string, branch?: string): string {
		const siblingPath = path.join(
			repo,
			".claude",
			"worktrees",
			`agent-${agentId}`,
		);
		git(
			["worktree", "add", "-q", "-b", branch ?? `pr-${agentId}`, siblingPath],
			repo,
		);
		return siblingPath;
	}

	/**
	 * #2519 round 2, F1: a THIRD module-substitution hook alongside
	 * `patchProcessScan`/`patchRecheck` -- this one appends synthetic rows to
	 * whatever the real listing returns, rather than delaying or corrupting
	 * it. It lets a test prove `restrictToPath` scoping (main()'s own
	 * `agentTree` wiring, not just `planOrphanSweep`'s pure intersection)
	 * without depending on either platform's real orphan-reparenting
	 * behavior -- the win32-only sibling test above spawns real detached
	 * processes and reads the kernel's own ppid bookkeeping, which POSIX
	 * answers differently (see its comment), so it cannot run on ubuntu CI.
	 * The appended rows are still genuine orphan-fixture rows as far as
	 * `isFixtureHelperCommand`/`selectOrphanFixtureProcesses` can tell: a
	 * `node .../tests/fixtures/...` command line whose `ppid` names a REAL
	 * pid a launcher already waited to exit (see the caller), so it is
	 * legitimately absent from the real snapshot this wrapper appends them
	 * onto -- no synthetic liveness bookkeeping, and no `/proc` cwd, needed.
	 */
	function patchProcessScanAppendRows(
		extraRows: { pid: number; ppid: number; command: string }[],
	) {
		fs.renameSync(processScanPath, realProcessScanPath);
		fs.writeFileSync(
			processScanPath,
			[
				'import * as real from "./process-scan-real.mjs";',
				'export * from "./process-scan-real.mjs";',
				`const EXTRA_ROWS = ${JSON.stringify(extraRows)};`,
				"export async function snapshotProcesses(...args) {",
				"\tconst result = await real.snapshotProcesses(...args);",
				"\tif (!result.ok) return result;",
				"\treturn { rows: [...result.rows, ...EXTRA_ROWS], ok: true };",
				"}",
				"",
			].join("\n"),
		);
	}

	function cleanup() {
		// `maxRetries`/`retryDelay` (not just `force`): on Windows a
		// directory that was very recently a live process's cwd (the F1
		// case's held helper, any spawned CLI still tearing down) can stay
		// briefly locked after the process exits -- an EPERM/EBUSY race
		// independent of whether this test itself killed anything.
		fs.rmSync(root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 200,
		});
	}

	return {
		root,
		repo,
		ledgerDir,
		worktree,
		cli,
		git,
		patchProcessScan,
		patchRecheck,
		patchProcessScanAppendRows,
		addNodeModulesJunction,
		addSiblingWorktree,
		cleanup,
	};
}

describe("SubagentStop hook, end to end (#2486)", () => {
	const AGENT_ID = "a0000000000000001";
	let fixture: ReturnType<typeof createSubagentStopFixture>;
	let root = "";
	let repo = "";
	let ledgerDir = "";
	let worktree = "";
	let cli = "";
	// #2519 round 2, S4: exposed by the builder rather than redeclared here
	// -- the exact describe-private duplicate of the builder's own `git`
	// this finding flagged.
	let git: (args: string[], cwd: string) => string;

	beforeEach(() => {
		fixture = createSubagentStopFixture(AGENT_ID);
		({ root, repo, ledgerDir, worktree, cli, git } = fixture);
	});

	afterEach(() => {
		fixture.cleanup();
	});

	/**
	 * The argv the SubagentStop hook is REGISTERED with, read out of the
	 * tracked `.claude/settings.json` rather than retyped here. #2486 was
	 * entirely a gap between "a form of this CLI removes trees" and "the form
	 * Claude Code actually runs removes trees", so every reap assertion below
	 * drives this exact list.
	 */
	function registeredArgv(): string[] {
		const settings = JSON.parse(
			fs.readFileSync(
				path.resolve(__dirname, "../../.claude/settings.json"),
				"utf8",
			),
		);
		const tokens = String(settings.hooks.SubagentStop[0].hooks[0].command)
			.trim()
			.split(/\s+/);
		const scriptAt = tokens.findIndex((token) =>
			token.endsWith("prune-agent-worktrees.mjs"),
		);
		expect(scriptAt).toBeGreaterThanOrEqual(0);
		return tokens.slice(scriptAt + 1);
	}

	/** The payload Claude Code actually sends (schema read from the shipped binary). */
	function subagentStopPayload(agentId: string | null): string {
		return JSON.stringify({
			hook_event_name: "SubagentStop",
			session_id: "s",
			transcript_path: path.join(root, "transcript.jsonl"),
			cwd: repo,
			stop_hook_active: false,
			...(agentId === null
				? {}
				: {
						agent_id: agentId,
						agent_type: "pi-lens-fixer",
						agent_transcript_path: path.join(root, "agent.jsonl"),
					}),
		});
	}

	function runCli(
		args: string[],
		payload: string,
		extraEnv: Record<string, string> = {},
	): string {
		return execFileSync(process.execPath, [cli, ...args], {
			cwd: repo,
			encoding: "utf8",
			input: payload,
			timeout: 90_000,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...gitFixtureEnv(root),
				PILENS_DATA_DIR: ledgerDir,
				...extraEnv,
			},
		});
	}

	function ledgerRecords(): Record<string, unknown>[] {
		const file = path.join(ledgerDir, "hygiene.log");
		if (!fs.existsSync(file)) return [];
		return fs
			.readFileSync(file, "utf8")
			.split(/\r?\n/)
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	const eventsOf = (records: Record<string, unknown>[]) =>
		records.map((record) => record.event);

	it(
		"still removes the trees --only names, on the manual policy",
		{ timeout: 90_000 },
		() => {
			// The manual form kept for a caller at a terminal. It is now
			// field-for-field the `manual` policy (review round 2, T1), so this
			// is the e2e half of that: `--only` still reaches removal, with a
			// working listing and no degradation on the record.
			runCli(
				["--hook", "subagent-stop", "--only", worktree],
				subagentStopPayload(AGENT_ID),
			);

			expect(fs.existsSync(worktree)).toBe(false);
			const records = ledgerRecords();
			expect(eventsOf(records)).not.toContain("hygiene.scan-degraded");
			const run = records.find((record) => record.event === "hygiene.run");
			expect(run).toMatchObject({ outcome: "fired", removed: 1 });
			// ...and the listing really ran, so "no degradation" is evidence
			// rather than the absence of a scan.
			expect(Number(run?.rows ?? 0)).toBeGreaterThan(0);
		},
	);

	it.skipIf(process.platform !== "win32")(
		"reaps under the registered argv when the listing itself fails (#2486's own reason)",
		{ timeout: 90_000 },
		() => {
			// The exact reason string from the reported hygiene.log, driven by
			// a ceiling the REAL listing cannot meet: measured on this box the
			// Windows listing costs ~524ms at its floor (~208ms powershell
			// startup + ~316ms projected WQL query) and 584-707ms in practice,
			// so a 400ms ceiling times the spawn out and `ok` comes back
			// false. Windows-only because POSIX `ps` answers in ~15ms — the
			// portable case above drives the same degraded state through the
			// `skipped` branch instead (both yield listingOk=false and an
			// empty table; only the reason string differs).
			runCli(
				[...registeredArgv(), "--scan-timeout-ms", "400"],
				subagentStopPayload(AGENT_ID),
			);

			expect(fs.existsSync(worktree)).toBe(false);
			const records = ledgerRecords();
			expect(
				records.find((record) => record.event === "hygiene.scan-degraded"),
			).toMatchObject({ reason: "listing-failed", ceilingMs: 400 });
			expect(
				records.find((record) => record.event === "hygiene.worktree-removed"),
			).toMatchObject({ removed: true });
		},
	);

	it(
		"still refuses a dirty tree, and the ledger says which rail refused it",
		{ timeout: 90_000 },
		() => {
			// The rail nothing overrides. #2435's contract, unchanged — and
			// now VISIBLE (review round 2, S2): a hook that fired, found its
			// tree and protected uncommitted work used to be indistinguishable
			// in the ledger from one that fired and reaped nothing.
			fs.writeFileSync(path.join(worktree, "wip.txt"), "uncommitted\n");
			runCli(
				[...registeredArgv(), "--scan-timeout-ms", "1"],
				subagentStopPayload(AGENT_ID),
			);

			expect(fs.existsSync(worktree)).toBe(true);
			expect(
				ledgerRecords().find((record) => record.event === "hygiene.run"),
			).toMatchObject({
				hook: "subagent-stop",
				outcome: "fired",
				removed: 0,
				worktree,
				keptReason: "dirty",
			});
			// The branch survives too, so the resumed agent loses nothing.
			expect(git(["branch", "--list", "pr-9001"], repo)).toContain("pr-9001");
		},
	);

	it(
		"still refuses an unpushed tree, and the ledger says so",
		{ timeout: 90_000 },
		() => {
			fs.writeFileSync(path.join(worktree, "b.txt"), "local only\n");
			git(["add", "b.txt"], worktree);
			git(["commit", "-qm", "local"], worktree);
			runCli(
				[...registeredArgv(), "--scan-timeout-ms", "1"],
				subagentStopPayload(AGENT_ID),
			);

			expect(fs.existsSync(worktree)).toBe(true);
			expect(
				ledgerRecords().find((record) => record.event === "hygiene.run"),
			).toMatchObject({ removed: 0, keptReason: "unpushed" });
		},
	);

	it(
		"tells an unreadable git status apart from a genuinely dirty tree (review round 3, F2)",
		{ timeout: 90_000 },
		() => {
			// Drives the REAL production `isDirty()` call: a `.git` gitlink file
			// git itself cannot resolve, so `git status --porcelain` run with cwd
			// inside the worktree fails outright -- the same execFileSync/catch
			// path a timed-out call takes, without depending on real-clock
			// timing to force one. `git worktree list --porcelain` (run from the
			// MAIN checkout) still lists the tree fine; only the per-tree
			// enrichment call inside it fails.
			//
			// unlink-then-write, not an in-place `writeFileSync` overwrite:
			// Windows denies the O_TRUNC open `writeFileSync` performs on a
			// `.git` gitlink file `git worktree add` just created (EPERM,
			// reproducible outside vitest too) even though a fresh create at
			// the same path succeeds immediately after -- an environment
			// quirk of the just-created file, not something under test here.
			const gitLinkPath = path.join(worktree, ".git");
			fs.unlinkSync(gitLinkPath);
			fs.writeFileSync(gitLinkPath, "gitdir: /nonexistent\n");
			runCli(registeredArgv(), subagentStopPayload(AGENT_ID));

			expect(fs.existsSync(worktree)).toBe(true);
			expect(
				ledgerRecords().find((record) => record.event === "hygiene.run"),
			).toMatchObject({
				hook: "subagent-stop",
				outcome: "fired",
				removed: 0,
				worktree,
				keptReason: "status-unreadable",
			});
		},
	);

	it(
		"records not-a-worktree for an existing directory git no longer registers (review round 3, F3)",
		{ timeout: 90_000 },
		() => {
			// The shape left behind by a half-failed removal: `git worktree
			// remove` unregisters the tree (or fails after the admin dir is
			// pruned) but the working directory itself survives on disk. The
			// derived path exists (passes the scopedToAgentTree fs.existsSync
			// check) yet `git worktree list --porcelain` says nothing about it.
			const STALE_ID = "a0000000000000099";
			const stale = path.join(
				repo,
				".claude",
				"worktrees",
				`agent-${STALE_ID}`,
			);
			fs.mkdirSync(stale, { recursive: true });
			fs.writeFileSync(path.join(stale, "leftover.txt"), "orphaned\n");

			runCli(registeredArgv(), subagentStopPayload(STALE_ID));

			expect(fs.existsSync(stale)).toBe(true);
			expect(
				ledgerRecords().find((record) => record.event === "hygiene.run"),
			).toMatchObject({
				hook: "subagent-stop",
				outcome: "fired",
				removed: 0,
				worktree: stale,
				keptReason: "not-a-worktree",
			});
		},
	);

	it(
		"never destroys a write that lands after enrichment but before the removal call (review round 3, F1)",
		{ timeout: 90_000 },
		async () => {
			// The gap the finding names: `isDirty()` runs during enrichment, and
			// the actual `git worktree remove` is separated from it by
			// `await readProcessTable` (which calls `snapshotProcesses`) plus one
			// `await terminatePid()` per process the tree holds -- a
			// check-then-act split by awaits with a kill in the gap.
			//
			// This does NOT race a fixed wall-clock delay against the CLI's
			// otherwise-opaque pipeline. An earlier version of this test did
			// (200ms) and passed vacuously on the pre-fix code, for two
			// independent reasons caught during verification: (1) it wrote
			// keepalive.mjs UNTRACKED straight into the worktree root, so
			// `git status` was already dirty at t=0 -- the ORIGINAL round-1
			// enrichment-time `isDirty` caught that on its own, never
			// exercising this gap at all; and (2) once that was fixed, this
			// box's absolute timing put the final removal anywhere from ~700ms
			// to ~1400ms out, too wide and too machine-dependent a spread for
			// one fixed delay to land in reliably. Instead this hooks the
			// process-table step itself (the finding's own suggested
			// alternative): the fixture's copy of `process-scan.mjs` wraps
			// `snapshotProcesses` with a fixed, generous artificial delay, so
			// the enrichment-to-removal gap is a controlled window regardless
			// of machine speed.
			//
			// keepalive.mjs is committed and pushed on the worktree's OWN
			// branch before the race starts, not written straight into the
			// tree afterward -- see (1) above.
			fs.writeFileSync(
				path.join(worktree, "keepalive.mjs"),
				"setTimeout(() => {}, 30_000);\n",
			);
			git(["add", "keepalive.mjs"], worktree);
			git(["commit", "-qm", "keepalive helper"], worktree);
			git(["push", "-q", "-u", "origin", "pr-9001"], worktree);

			// PR #2493 round 4, N1: a top-level reparse point (agents junction
			// `node_modules` into the main checkout) stands in for the real
			// shared-`node_modules` link `unlinkTopLevelLinks` unlinks before
			// `git worktree remove`. Untracked and gitignore-shaped -- exactly
			// what a real agent worktree carries -- so it never makes `git
			// status` dirty on its own; only the late write below does that.
			const junctionPath = fixture.addNodeModulesJunction();

			// Deliberately delayed for review round 3, F1: widens the gap
			// between enrichment's isDirty() and the final removal call to a
			// fixed, machine-speed-independent window.
			fixture.patchProcessScan(800);

			const helperScript = path.join(worktree, "keepalive.mjs");
			const helper = spawn(process.execPath, [helperScript], {
				cwd: worktree,
				stdio: "ignore",
			});
			try {
				const lateFile = path.join(worktree, "late-write.txt");
				let wrote = false;
				// Deliberately `--only`, not the registered `--hook subagent-stop
				// --quiet` form the sibling tests in this block drive (PR #2493
				// round 4, S1 vs S2 in tension): the hook-derived path is built by
				// `path.join`, which on POSIX only ever emits forward slashes -- the
				// SAME separator `git worktree list` already reports, so on Linux CI
				// the two strings are byte-identical before `toComparablePath` ever
				// runs and a mutation that deleted the fold entirely would still
				// pass. `--only` is the one form this test can put in a DELIBERATELY
				// mismatched separator, so the fold is what actually closes the gap
				// rather than a same-OS coincidence -- proven on the #2486 box
				// (win32) already; forced here so it is proven on ubuntu CI too.
				// Always backslash-form, on every host: git's own listing is always
				// forward-slash, so backslash is the one form guaranteed to differ
				// from it everywhere, not just on win32.
				const mismatchedOnly = worktree.split(path.sep).join("\\");
				const cliRun = new Promise<void>((resolve, reject) => {
					const child = spawn(
						process.execPath,
						[
							cli,
							"--hook",
							"subagent-stop",
							"--quiet",
							"--only",
							mismatchedOnly,
						],
						{
							cwd: repo,
							env: {
								...gitFixtureEnv(root),
								PILENS_DATA_DIR: ledgerDir,
							},
							stdio: ["pipe", "pipe", "pipe"],
						},
					);
					child.on("error", reject);
					child.on("close", () => resolve());
					child.stdin.write(subagentStopPayload(AGENT_ID));
					child.stdin.end();
				});
				// Starts well after enrichment (a handful of git spawns against
				// ONE candidate, observed under 100ms even on a loaded box) and
				// keeps hammering every 20ms until the CLI exits -- comfortably
				// inside the artificial 800ms process-table delay above, so some
				// attempt is certain to land in the gap regardless of exactly
				// when enrichment finishes.
				const hammer = new Promise<void>((resolve) => {
					setTimeout(() => {
						const timer = setInterval(() => {
							try {
								fs.writeFileSync(lateFile, "written after enrichment\n");
								wrote = true;
							} catch {
								/* the tree may already be gone */
							}
						}, 20);
						cliRun.finally(() => {
							clearInterval(timer);
							resolve();
						});
					}, 150);
				});
				await Promise.all([cliRun, hammer]);

				// If the write never landed at all, the race window closed
				// before it could be exercised -- that is a broken TEST, not a
				// passing one, so it fails loudly rather than passing vacuously.
				expect(
					wrote,
					"the late write never landed; the race window closed before the test could exercise it",
				).toBe(true);
				// The late write must never be silently destroyed: the removal
				// is refused and BOTH the tree and the file survive.
				expect(fs.existsSync(worktree)).toBe(true);
				expect(fs.existsSync(lateFile)).toBe(true);
				expect(
					ledgerRecords().find((record) => record.event === "hygiene.run"),
				).toMatchObject({ removed: 0, keptReason: "dirty" });
				// PR #2493 round 4, N2: `keptReason: "dirty"` on the run record alone
				// does not discriminate this fix from round 1's ENRICHMENT-time
				// `isDirty` catch -- an accidental hammer start early enough to land
				// before enrichment finishes would satisfy the same assertions
				// without ever exercising the late re-check this test targets. The
				// `hygiene.worktree-removed` record's `error` string is written ONLY
				// by the round-3 re-check branch (round 1's enrichment-time catch
				// never reaches the removal loop at all -- the candidate goes
				// straight to `plan.keep`), so asserting it pins the catch to the
				// gap this test actually races.
				expect(
					ledgerRecords().find(
						(record) => record.event === "hygiene.worktree-removed",
					),
				).toMatchObject({
					removed: false,
					error: "became dirty between enrichment and removal",
				});
				// PR #2493 round 4, N1: the recheck used to run AFTER
				// `unlinkTopLevelLinks`, so a tree KEPT for "became dirty" had
				// already silently lost its shared `node_modules` junction --
				// visible only in a `--quiet` hook run's suppressed `say()` line.
				// A kept tree must be untouched, not merely undeleted.
				expect(fs.existsSync(junctionPath)).toBe(true);
				expect(fs.lstatSync(junctionPath).isSymbolicLink()).toBe(true);
			} finally {
				// Await the actual exit, not just the kill signal: `afterEach`
				// removes the whole fixture root right after this test returns,
				// and on Windows a directory that was a live process's cwd stays
				// briefly locked (EPERM on `fs.rmSync`) until the OS has fully
				// released the handle -- a real flake this test hit under
				// parallel load once the fire-and-forget `kill()` outran that
				// release.
				await new Promise<void>((resolve) => {
					if (helper.exitCode !== null || helper.signalCode !== null) {
						resolve();
						return;
					}
					helper.once("exit", () => resolve());
					helper.kill();
				});
			}
		},
	);

	it(
		"tells an unreadable recheck apart from a genuinely dirty one (PR #2493 round 5, R2)",
		{ timeout: 90_000 },
		() => {
			// The gap R2 names: `isDirty(removal.path, recheckBound) !== "clean"`
			// collapsed the recheck's tri-state, so a recheck that could not
			// read `git status` at all (a wedged git, a bound too tight) was
			// folded into the same "became dirty" verdict as a genuine late
			// write -- reading a scan that never got to look as protected work,
			// the exact confusion review round 3, F2 already closed for the
			// ENRICHMENT-time call.
			//
			// Enrichment must see the tree CLEAN, or the candidate never reaches
			// the removal loop's recheck at all -- it goes straight to
			// `plan.keep` with `dirtyUnreadable` via planWorktreePrune's own
			// dirty rail, which is the enrichment-time path F2 already covers,
			// not this one. #2519: the ORIGINAL version of this test raced a
			// wall-clock 150ms `setTimeout` against enrichment's own completion
			// to land the gitlink corruption after it -- under load on Windows
			// the 150ms could elapse before enrichment (a handful of
			// synchronous `git` spawns) had actually returned, corrupting the
			// gitlink DURING enrichment instead of the recheck: the candidate
			// then took F2's `dirtyUnreadable` rail straight to `plan.keep` and
			// never reached the removal loop at all, so
			// `hygiene.worktree-removed` was never written and the second
			// assertion below failed against `undefined`.
			//
			// `fixture.patchRecheck` closes that gap deterministically instead
			// of with a bigger delay: it corrupts the gitlink synchronously at
			// `snapshotProcesses`'s own entry, which is only ever called from
			// `readProcessTable`, itself only reached AFTER the enrichment
			// pass's synchronous `isDirty()` call has already returned. The
			// corruption is therefore on disk before `readProcessTable` (and
			// so the recheck) can possibly resolve, every time, regardless of
			// machine speed -- see the fixture builder's own comment. Corrupting
			// the gitlink (not a tiny forced recheck bound) makes the recheck's
			// `git status --porcelain` fail OUTRIGHT rather than merely risk
			// timing out against `RECHECK_TIMEOUT_MS`'s floor
			// (`MIN_GIT_TIMEOUT_MS`, 250ms) -- comfortably long enough for a
			// real `git status` on this tiny fixture to answer, which would
			// make a bound-forcing version of this test flaky rather than red
			// for the right reason.
			fixture.patchRecheck(path.join(worktree, ".git"));

			runCli(registeredArgv(), subagentStopPayload(AGENT_ID));

			const records = ledgerRecords();
			// #2519 round 2, S2: this test's whole premise is that
			// `readProcessTable` actually reaches `snapshotProcesses`, which is
			// the only place `patchRecheck`'s corruption is applied. If the scan
			// were instead skipped for budget (`hygiene.scan-degraded reason:
			// "skipped"`), `snapshotProcesses` would never run, the gitlink
			// would stay unpatched, `git status` would answer cleanly, and the
			// tree would be REMOVED instead of kept -- silently turning this
			// test's own failure into "worktree got removed?!" rather than a
			// visible assertion about why.
			expect(
				records.find((record) => record.event === "hygiene.scan-degraded"),
				"the scan must not be skipped, or patchRecheck's corruption never applies",
			).toBeUndefined();
			expect(fs.existsSync(worktree)).toBe(true);
			expect(
				records.find((record) => record.event === "hygiene.run"),
			).toMatchObject({ removed: 0, keptReason: "status-unreadable" });
			expect(
				records.find((record) => record.event === "hygiene.worktree-removed"),
			).toMatchObject({
				removed: false,
				error: "recheck could not read git status before removal",
			});
		},
	);

	it(
		"reaps the stopped agent's tree through the REGISTERED argv (#2486)",
		{ timeout: 90_000 },
		() => {
			// THE headline. `node scripts/prune-agent-worktrees.mjs --hook
			// subagent-stop --quiet` — the literal registered line, no --only —
			// derives the tree from agent_id and removes it. Before this the
			// same argv printed "worktrees are never removed here" and exited 0,
			// so only SessionStart's one-tree-per-run cap drained anything and
			// N stale trees needed N sessions.
			expect(registeredArgv()).not.toContain("--only");
			runCli(registeredArgv(), subagentStopPayload(AGENT_ID));

			expect(fs.existsSync(worktree)).toBe(false);
			const records = ledgerRecords();
			expect(
				records.find((record) => record.event === "hygiene.worktree-removed"),
			).toMatchObject({ removed: true });
			const runs = records.filter((record) => record.event === "hygiene.run");
			// Exactly one hygiene.run line per invocation, still.
			expect(runs).toHaveLength(1);
			expect(runs[0]).toMatchObject({
				hook: "subagent-stop",
				outcome: "fired",
				removed: 1,
				worktree,
				keptReason: null,
			});
			// The listing really ran, so the reap is not riding on a scan that
			// never happened.
			expect(Number(runs[0]?.rows ?? 0)).toBeGreaterThan(0);
			// The branch the removal orphaned is gone too; nothing committed is
			// lost, because it was contained in origin/* before the rails let
			// the tree go at all.
			expect(git(["branch", "--list", "pr-9001"], repo).trim()).toBe("");
		},
	);

	it(
		"leaves the tree alone under --keep-agent-tree, and says so",
		{ timeout: 90_000 },
		() => {
			// The documented opt-out for operators who resume agents by
			// SendMessage. The scoped orphan sweep still runs; only the removal
			// is off, and the ledger says which of the two it was.
			runCli(
				[...registeredArgv(), "--keep-agent-tree"],
				subagentStopPayload(AGENT_ID),
			);

			expect(fs.existsSync(worktree)).toBe(true);
			expect(
				ledgerRecords().find((record) => record.event === "hygiene.run"),
			).toMatchObject({
				hook: "subagent-stop",
				outcome: "fired",
				removed: 0,
				worktree,
				keptReason: "removal-not-permitted",
			});
		},
	);

	it(
		"honors PILENS_HYGIENE_KEEP_AGENT_TREES on the unchanged registered argv",
		{ timeout: 90_000 },
		() => {
			// An operator cannot always edit the registered hook line, so the
			// opt-out has an environment spelling that reaches the same policy.
			runCli(registeredArgv(), subagentStopPayload(AGENT_ID), {
				PILENS_HYGIENE_KEEP_AGENT_TREES: "1",
			});

			expect(fs.existsSync(worktree)).toBe(true);
			expect(
				ledgerRecords().find((record) => record.event === "hygiene.run"),
			).toMatchObject({ removed: 0, keptReason: "removal-not-permitted" });
		},
	);

	it(
		"reaps under the registered argv even when the process scan is degraded",
		{ timeout: 90_000 },
		() => {
			// #2486's own shape, now on the path that actually fires: a
			// scan-degraded line and a removal line in the SAME run. The
			// reported log had the first three times and never the second.
			runCli(
				[...registeredArgv(), "--scan-timeout-ms", "1"],
				subagentStopPayload(AGENT_ID),
			);

			expect(fs.existsSync(worktree)).toBe(false);
			const records = ledgerRecords();
			const degraded = records.find(
				(record) => record.event === "hygiene.scan-degraded",
			);
			expect(degraded).toMatchObject({ reason: "skipped", rows: 0 });
			// review round 2, T3: the ceiling the listing was given and what was
			// left of the sweep budget are different facts and different fields.
			// `remainingMs` used to hold the ceiling, which made a skipped scan
			// report a budget it never had.
			expect(degraded?.ceilingMs).toBe(1);
			expect(Number(degraded?.remainingMs)).toBeGreaterThan(1);
			expect(
				records.find((record) => record.event === "hygiene.worktree-removed"),
			).toMatchObject({ removed: true });
			expect(
				records.find((record) => record.event === "hygiene.run"),
			).toMatchObject({ outcome: "fired", removed: 1 });
		},
	);

	it(
		"evaluates every --only tree even past the enrich deadline",
		{ timeout: 90_000 },
		() => {
			// PR #2493 review round 2, S3: the `!selectedKeys.has(...)` clause in
			// the enrich-deadline skip was untested. A caller that ENUMERATED
			// its trees must have every one of them read; dropping the second
			// for budget is a silent refusal to do the one job it asked for.
			// `--budget-ms 1` puts the deadline in the past before the first
			// tree is even reached, so only that clause keeps the second tree
			// out of `not-evaluated`.
			const second = fixture.addSiblingWorktree("a0000000000000002", "pr-9002");
			const out = runCli(
				[
					"--only",
					worktree,
					"--only",
					second,
					"--budget-ms",
					"1",
					"--scan-timeout-ms",
					"1",
					"--dry-run",
					"--json",
				],
				"",
			);
			const plan = JSON.parse(out) as {
				keep: { path: string; reason: string }[];
			};
			expect(plan.keep.map((entry) => entry.reason)).not.toContain(
				"not-evaluated",
			);
		},
	);

	it(
		"records a skipped run when the payload carries no agent_id",
		{ timeout: 90_000 },
		() => {
			// #2486: "agents finishing after 14:41 produced NO log line at
			// all". The hooks run --quiet and Claude Code discards their
			// stderr, so an early return left nothing to read.
			runCli(registeredArgv(), subagentStopPayload(null));

			expect(ledgerRecords()).toMatchObject([
				{
					event: "hygiene.run",
					hook: "subagent-stop",
					outcome: "skipped",
					reason: "no-agent-id",
				},
			]);
		},
	);

	it(
		"distinguishes an agent that never had a worktree from a missing agent_id",
		{ timeout: 90_000 },
		() => {
			// The ORDINARY case: most subagents are not worktree-isolated, so
			// `.claude/worktrees/agent-<id>` simply does not exist. Reporting
			// that as "no usable agent_id" is what made the empty ledger
			// unreadable during the #2486 investigation.
			runCli(registeredArgv(), subagentStopPayload("affffffffffffffff"));

			expect(ledgerRecords()).toMatchObject([
				{
					event: "hygiene.run",
					outcome: "skipped",
					reason: "agent-worktree-missing",
					worktree: path.join(
						repo,
						".claude",
						"worktrees",
						"agent-affffffffffffffff",
					),
				},
			]);
		},
	);

	it.skipIf(process.platform !== "win32")(
		"scopes the orphan sweep to the stopped agent's own tree, never a sibling's (#2501)",
		{ timeout: 90_000 },
		() => {
			// #2435's contract: a SubagentStop run reaps ONLY orphaned helpers
			// under the tree of the agent that stopped, never a sibling agent's
			// -- `restrictToPath: agentTree` in main() (prune-agent-worktrees.mjs)
			// is what enforces it. #2501 found this end-to-end path untested:
			// deleting that one argument leaves this file's whole suite green
			// (49 passed, verified on PR #2493 head 3ac2bcdb). `planOrphanSweep`'s
			// OWN `restrictToPath` intersection IS unit-tested in
			// worktree-hygiene.test.ts -- what was untested is `main()` actually
			// PASSING it, so this drives the real CLI end to end, not the pure
			// function.
			//
			// Windows-only, not a flake gate: `selectOrphanFixtureProcesses`
			// infers "the parent exited" from the parent's pid being ABSENT
			// from a process-table snapshot (worktree-hygiene.mjs's own note:
			// "Windows keeps the recorded parent pid after the parent dies").
			// On POSIX the kernel reparents an orphan to pid 1 (or the nearest
			// subreaper) the instant its parent exits, so by the time any
			// snapshot runs the orphan's ppid is already a LIVE pid -- neither
			// tree's helper would ever be classified as an orphan there, so
			// the "must appear in orphans" half of this assertion would fail
			// for a reason that has nothing to do with `restrictToPath`, on
			// every Linux/macOS box, deterministically (not flaky -- the
			// mutation this test targets would ALSO stay invisible, the exact
			// vacuous-test shape #2501 itself warns against). Verified live on
			// this box: a detached grandchild's ppid stays the dead launcher's
			// pid, absent from the table, after the launcher has fully exited.
			// Windows is also #2435's own evidence platform.
			const sibling = fixture.addSiblingWorktree(
				"a0000000000000002",
				"pr-9002",
			);

			const sleeperSource = "setInterval(() => {}, 1000);\n";
			const agentSleeper = path.join(
				worktree,
				"tests",
				"fixtures",
				"sleeper.mjs",
			);
			const siblingSleeper = path.join(
				sibling,
				"tests",
				"fixtures",
				"sleeper.mjs",
			);
			fs.mkdirSync(path.dirname(agentSleeper), { recursive: true });
			fs.mkdirSync(path.dirname(siblingSleeper), { recursive: true });
			fs.writeFileSync(agentSleeper, sleeperSource);
			fs.writeFileSync(siblingSleeper, sleeperSource);

			// A short-lived `-e` launcher spawns the sleeper `detached` and
			// exits; `execFileSync` blocks until the LAUNCHER itself has fully
			// exited, so by the time this returns the sleeper's own parent pid
			// is genuinely gone -- deterministic, no race, no wait-then-hope.
			const spawnOrphan = (scriptPath: string): number => {
				const launcherCode = [
					'const { spawn } = require("node:child_process");',
					`const child = spawn(process.execPath, [${JSON.stringify(
						scriptPath,
					)}], { detached: true, stdio: "ignore" });`,
					"child.unref();",
					"process.stdout.write(String(child.pid));",
				].join("\n");
				const out = execFileSync(process.execPath, ["-e", launcherCode], {
					encoding: "utf8",
				});
				return Number(out.trim());
			};

			const agentPid = spawnOrphan(agentSleeper);
			const siblingPid = spawnOrphan(siblingSleeper);
			try {
				// `--dry-run --json`, per #2501's proposed shape: nothing is
				// ever killed, and the plan's `orphans` array is inspectable.
				const out = runCli(
					[...registeredArgv(), "--dry-run", "--json"],
					subagentStopPayload(AGENT_ID),
				);
				const plan = JSON.parse(out) as {
					orphans: { pid: number; command: string }[];
				};
				const orphanPids = plan.orphans.map((entry) => entry.pid);
				expect(
					orphanPids,
					"the agent-tree helper never appeared in the orphan snapshot",
				).toContain(agentPid);
				expect(orphanPids).not.toContain(siblingPid);
			} finally {
				for (const pid of [agentPid, siblingPid]) {
					try {
						process.kill(pid);
					} catch {
						/* already gone, or never came up */
					}
				}
			}
		},
	);

	it(
		"scopes the orphan sweep to the stopped agent's own tree, never a sibling's, on every platform (#2519 round 2, F1)",
		{ timeout: 90_000 },
		() => {
			// The premise the reviewer named for round 1's `skipIf(!win32)`
			// case above: no CI lane runs vitest on Windows, so it never
			// exercises `restrictToPath` on the gate that actually decides
			// this PR. Nulling `restrictToPath` in `main()` stayed green on
			// ubuntu Unit tests the whole time.
			//
			// This variant proves the SAME wiring -- `main()` actually passing
			// `restrictToPath: agentTree` into `planOrphanSweep`, not just
			// `planOrphanSweep`'s own pure intersection (already covered in
			// worktree-hygiene.test.ts) -- without depending on either
			// platform's real orphan-reparenting behavior. Instead of
			// spawning and killing real detached processes and reading the
			// kernel's own ppid bookkeeping (POSIX and Windows disagree on
			// when an orphan's ppid updates, which is exactly why the case
			// above is win32-only), it uses the builder's module-substitution
			// seam to append two SYNTHETIC fixture-helper rows directly onto
			// the REAL snapshot `readProcessTable` produces: one for this
			// agent's own tree, one for a sibling's. Each row's `ppid` names
			// a real pid a short-lived launcher already waited to exit, so it
			// is genuinely, deterministically absent from the snapshot by the
			// time this test's own CLI invocation takes one -- no synthetic
			// liveness bookkeeping, and no `/proc` cwd, required.
			// `verifySnapshotIntegrity` still passes because the REAL rows
			// (this process's own ancestor chain) are untouched; only two
			// rows are appended on top.
			const sibling = fixture.addSiblingWorktree(
				"a0000000000000003",
				"pr-9003",
			);

			// `execFileSync` blocks until the launcher itself has exited, so
			// by the time this returns the reported pid is already gone from
			// any process snapshot taken afterward -- deterministic, no
			// signal-0 polling, no race window.
			const deadPid = (): number => {
				const out = execFileSync(
					process.execPath,
					["-e", "process.stdout.write(String(process.pid))"],
					{ encoding: "utf8" },
				);
				return Number(out.trim());
			};

			const agentSyntheticPid = 900_000_001;
			const siblingSyntheticPid = 900_000_002;
			fixture.patchProcessScanAppendRows([
				{
					pid: agentSyntheticPid,
					ppid: deadPid(),
					command: `node ${worktree}/tests/fixtures/sleeper.mjs`,
				},
				{
					pid: siblingSyntheticPid,
					ppid: deadPid(),
					command: `node ${sibling}/tests/fixtures/sleeper.mjs`,
				},
			]);

			// `--dry-run --json`, same shape as the win32 case: nothing is
			// ever killed, and the plan's `orphans` array is inspectable.
			const out = runCli(
				[...registeredArgv(), "--dry-run", "--json"],
				subagentStopPayload(AGENT_ID),
			);
			const plan = JSON.parse(out) as {
				orphans: { pid: number; command: string }[];
			};
			const orphanPids = plan.orphans.map((entry) => entry.pid);
			expect(
				orphanPids,
				"the agent-tree synthetic helper never appeared in the orphan snapshot",
			).toContain(agentSyntheticPid);
			expect(orphanPids).not.toContain(siblingSyntheticPid);
		},
	);
});
// flake-shape: real-process-spawn — real git worktree commands own pruning locks and exit status beyond in-process filesystem state
