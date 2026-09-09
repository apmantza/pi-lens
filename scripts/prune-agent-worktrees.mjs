#!/usr/bin/env node
/**
 * scripts/prune-agent-worktrees.mjs (#2435)
 *
 * Agent worktree + orphan-process hygiene. Three independent sweeps:
 *
 *  1. AGENT WORKTREES. Every `.claude/worktrees/agent-*` git worktree that is
 *     clean, whose HEAD is contained in an `origin/*` ref, and that is old
 *     enough (or explicitly named by `--only`) is removed, together with the
 *     agent-session branch it left behind. 15 such trees accumulated on one
 *     box in a single day (#2435), each with its own build output.
 *  2. MERGED-BRANCH TREES (#2631). Any OTHER registered worktree — any path,
 *     the 2026-09-06 recurrence stood under `~/Desktop/pi-lens-wt-*` — whose
 *     branch tip is an ancestor of `origin/master` AND whose checkout is
 *     clean (no tracked changes, no untracked files) is removed and its
 *     merged local branch deleted. An untracked file is a deliverable, never
 *     disposable: on 2026-09-09 a 22 KB report left untracked in a worktree
 *     was destroyed by a sweep that treated its checkout as removable, so an
 *     empty `git status --porcelain` is the only clean that qualifies, and
 *     the keep record names the first porcelain entry it protected.
 *  3. UNREGISTERED DIRECTORIES (#2538). `.claude/worktrees/agent-*` entries
 *     present on disk but absent from `git worktree list` are removed only
 *     when they hold nothing but git's own `.git` gitlink — with no index and
 *     no known branch, every other file is treated as an untracked deliverable.
 *  4. ORPHAN FIXTURES. Any `tests/fixtures/*` / `tests/support/*` helper
 *     process whose parent has exited is killed — the class that left
 *     `fake-lsp-server.mjs` running for an hour after its fixer finished and
 *     made one worktree unremovable. The fixture's own missing teardown is
 *     #2436; this is the machine-level net under it, not the fix.
 *
 *  2 and 3 are capped per run with `--max` (default 10); what the cap skips
 *  is printed. All the decision logic lives in scripts/lib/worktree-hygiene.mjs
 *  and is pure (tables in, verdicts out). This file owns only the I/O: `git`
 *  invocations, the platform process listing, `process.kill`, and the ledger
 *  write. Anything that could destroy work is therefore unit-testable
 *  WITHOUT this file running.
 *
 * Safety rails (see the library header for the full contract):
 *   - never a dirty tree; never an unpushed tree — no flag overrides either;
 *   - never a tree younger than --min-age, and never one whose git lock
 *     names a live pid, UNLESS --only names it;
 *   - never this process, and never any ancestor of it;
 *   - never a fixture helper whose parent is still alive, and never one whose
 *     parent pid is unreadable — unanswered is keep, not kill;
 *   - kills are always by pid after a command-line/cwd match, never
 *     `taskkill`-by-name.
 *
 * A worktree's AGE is read only from signals this sweep does not itself
 * write — see `WORKTREE_ACTIVITY_SIGNALS` in the library. Reading the git
 * index made every tree `age 0ms` the moment the dirty rail looked at it, and
 * the sweep removed nothing at all for its whole first life.
 *
 * WHO REMOVES WHAT (see resolveHookPolicy):
 *   `--hook subagent-stop` REAPS the tree of the agent that just stopped,
 *   derived from the payload's `agent_id`. This reverses PR #2438's review S1
 *   (maintainer decision, 2026-09-02). S1 forbade removal here because
 *   resume-by-SendMessage lands after the hook fires; the cost was #2486 --
 *   the registered line passes no `--only`, so it removed nothing, only
 *   SessionStart's one-tree-per-run cap drained anything, and N stale trees
 *   needed N sessions. Ten accumulated in one afternoon.
 *   THE TRADE-OFF: an agent resumed by SendMessage after its tree was reaped
 *   must recreate the checkout. Its BRANCH survives (branches are deleted only
 *   for a removal that succeeded, and only the ref that removal orphaned), so
 *   nothing committed is lost -- only the working copy. `--keep-agent-tree`,
 *   or PILENS_HYGIENE_KEEP_AGENT_TREES=1, turns the removal off and leaves the
 *   scoped orphan sweep. Merge-train worktrees are not `agent-*` trees, so
 *   `isAgentWorktreePath` never selects them either way.
 *   `--hook subagent-stop --only <tree>` is the MANUAL form: a caller at a
 *   terminal naming trees by hand, with the manual budget.
 *   Removal belongs otherwise to `--hook session-start` (default --min-age,
 *   clean + pushed rails, never --only, at most ONE tree per run) and to a
 *   manual `npm run hygiene` (same rails, --min-age overridable, uncapped).
 *
 * REMOVAL IS INDEPENDENT OF THE PROCESS SCAN (#2486). The scan feeds two
 * things -- the orphan-fixture sweep and the "kill what is holding this tree"
 * step -- and both degrade to "do nothing" when the listing fails. Neither
 * may cancel a removal: `git worktree remove --force --force` does not need
 * the table, and a hygiene.log with a scan-degraded line and no removal line
 * is exactly what #2486 reported.
 *
 * EVERY INVOCATION WRITES A LEDGER LINE (#2486). `formatRunRecord` emits one
 * `hygiene.run` record on every exit path, `fired` or `skipped` with a reason
 * from RUN_SKIP_REASONS. Both hooks run `--quiet` and Claude Code discards
 * their stderr, so before this an early return was indistinguishable from a
 * hook that never fired at all.
 *
 * THE SubagentStop PAYLOAD is Claude Code's contract, read from the shipped
 * binary (~/.local/share/claude/versions/2.1.258) rather than assumed:
 *   { session_id, transcript_path, cwd, prompt_id?, permission_mode?,
 *     agent_id?, agent_type?, ... } and, for this event,
 *   { hook_event_name: "SubagentStop", stop_hook_active, agent_id,
 *     agent_transcript_path, agent_type, last_assistant_message?, ... }
 * `agent_id` is REQUIRED on SubagentStop, and Claude Code names a managed
 * agent worktree "agent-" + agentId (the shipped bundle's
 * `function t8n(e){return "agent-"+e}`, with ids shaped /^a[0-9a-f]{16}$/ or
 * /^a[0-9a-f]{7}$/ per its own validator). There is no
 * worktree-path field on the event, so the id -> path mapping stays a
 * verified naming convention: the derived path is checked on disk before it
 * is acted on. Most subagents are NOT worktree-isolated, so a missing
 * directory is the ORDINARY case and is now reported as such rather than as
 * "no usable agent_id".
 *
 * Usage:
 *   node scripts/prune-agent-worktrees.mjs [--dry-run] [--min-age 30m]
 *        [--only <path>]... [--json] [--quiet]
 *   node scripts/prune-agent-worktrees.mjs --hook subagent-stop
 *        [--keep-agent-tree]   (reads the hook JSON payload on stdin, derives
 *        the stopped agent's worktree from `agent_id`, scopes the orphan
 *        sweep to it, and removes it unless --keep-agent-tree)
 *   node scripts/prune-agent-worktrees.mjs --hook session-start
 *
 * Exit code is ALWAYS 0. This is a hygiene sweep wired to Claude Code hooks
 * (`.claude/settings.json`); a hygiene failure must never fail a session.
 * Errors are printed and recorded in the ledger instead.
 *
 * Ledger: `<PILENS_DATA_DIR | PI_LENS_HOME | ~/.pi-lens>/hygiene.log`, JSONL,
 * bounded to the newest DEFAULT_LOG_MAX_LINES records with a truncated
 * command field (an append-only log with an unbounded field is the classic
 * "bounded on one axis, unbounded on another" leak this repo keeps finding).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_LOG_MAX_LINES,
	DEFAULT_MIN_AGE_MS,
	RUN_SKIP_REASONS,
	capRemovals,
	collectAncestorPids,
	enclosingAgentWorktree,
	formatKillRecord,
	formatRunRecord,
	formatScanRecord,
	formatUnregisteredDirRecord,
	formatWorktreeRecord,
	isAgentBranchCandidate,
	isAgentWorktreePath,
	orderBySelection,
	parseDuration,
	parseLockPid,
	parseReflogLastEntryMs,
	parseWorktreeList,
	planBranchDeletions,
	planMergedWorktreeRemovals,
	planOrphanSweep,
	planWorktreePrune,
	pruneLogLines,
	selectProcessesUnderPath,
	toComparablePath,
	unregisteredAgentDirVerdict,
	worktreeActivityFromSignals,
} from "./lib/worktree-hygiene.mjs";
import { snapshotProcesses } from "./lib/process-scan.mjs";

const isWindows = process.platform === "win32";

/**
 * FLOOR for the sweep budget in hook mode, and the budget for a hook whose
 * timeout this file does not know. #2435 sized this at 2s for a hook with
 * nothing to do; #2486 showed it is far too small for the hook it was
 * actually wired to — see `hookBudgetMs`, which derives the real budget from
 * the timeout registered in `.claude/settings.json`.
 */
export const DEFAULT_HOOK_BUDGET_MS = 2_000;
/** Wall-clock budget for a manual (non-hook) invocation. */
export const DEFAULT_MANUAL_BUDGET_MS = 60_000;
/**
 * Per-run removal cap for the merged-branch sweep (#2631) and the
 * unregistered-directory pass (#2538), overridable with `--max`. What the cap
 * skips is printed as deferred, so a bigger backlog drains one run at a time
 * instead of a single sweep destroying an unbounded number of trees. In hook
 * modes the effective cap is the smaller of this and the policy's own
 * `maxRemovals` — the hook-timeout arithmetic is sized for one removal.
 */
export const DEFAULT_MAX_REMOVALS = 10;
/**
 * The hook timeouts registered in `.claude/settings.json`, in ms. Mirrored
 * rather than read at runtime (one small file read on every sweep, plus a
 * parser, to learn two numbers), and the mirror is pinned by a conformance
 * test in tests/scripts/prune-agent-worktrees.test.ts that reads the real
 * settings file — so a timeout changed there and not here fails CI.
 */
export const HOOK_TIMEOUT_MS = Object.freeze({
	"subagent-stop": 15_000,
	"session-start": 90_000,
});
/**
 * Headroom between the sweep's own budget and the hook timeout that kills it:
 * node startup, the module graph, and the ledger write all sit outside the
 * budget clock.
 */
export const HOOK_TIMEOUT_MARGIN_MS = 5_000;
/**
 * Wall-clock budget for the process-table snapshot alone.
 *
 * Measured on the #2435/#2486 box on 2026-09-02, 12 concurrent agent
 * worktrees, 8 consecutive `snapshotProcesses(["pid","ppid","command"])`
 * calls over ~467 rows: min 584ms, median 651ms, max 707ms — of which ~208ms
 * is `powershell.exe` startup and the rest the projected WQL query (the
 * unprojected `Get-CimInstance Win32_Process` costs ~570ms alone, which is
 * why the query names its three columns).
 *
 * The shipped 1200ms was only ~1.8x that median, and #2486's hygiene.log
 * shows three `listing-failed` degradations in one afternoon while builds and
 * test suites ran: the listing simply did not finish. 4000ms is ~6x the
 * measured median and fits inside every budget `hookBudgetMs` hands out. On
 * timeout the table comes back EMPTY, which degrades every selector to "kill
 * nothing" — visibly, via `formatScanRecord`, and WITHOUT blocking removal.
 */
export const DEFAULT_SCAN_TIMEOUT_MS = 4_000;
/**
 * Below this much remaining budget the process scan is SKIPPED outright and
 * said so, rather than started with a stub timeout it cannot meet. An empty
 * process table silently disables both the orphan sweep and the
 * kill-what-holds-the-tree step, which is exactly the kind of invisible
 * degradation this repo's defect catalog names.
 */
export const MIN_SCAN_BUDGET_MS = 400;
/** Per-`git`-call wall-clock bound for a manual (non-hook) sweep. */
export const DEFAULT_GIT_TIMEOUT_MS = 5_000;
/** Floor for any per-`git`-call bound; below this even a warm call fails. */
export const MIN_GIT_TIMEOUT_MS = 250;
/**
 * Bound for `git worktree remove` / `prune` — generous, and deliberately not
 * tied to the sweep budget, but a real bound: `git()` enforces it with
 * killSignal SIGKILL. Aborting a recursive delete midway is strictly worse
 * than overrunning (it leaves a half-removed tree and a stale admin
 * directory), so 60s is set far above any real removal and only ever fires on
 * a wedged git — and it sits inside the 90s SessionStart hook timeout, which
 * is sized to cover one full removal plus the sweep around it (review S8, and
 * review round 3 F7 for the comment that used to claim no bound at all).
 */
export const REMOVE_TIMEOUT_MS = 60_000;
/**
 * Per-hook override of `REMOVE_TIMEOUT_MS`, because a hook cannot reserve more
 * removal time than its own timeout allows. See `removeBoundMs` for the
 * measurement this is sized from; the invariant
 * `hookBudgetMs + recheckBoundMs + removeBoundMs + HOOK_TIMEOUT_MARGIN_MS <=
 * HOOK_TIMEOUT_MS` is asserted for every registered hook in
 * tests/scripts/prune-agent-worktrees.test.ts — counting BOTH bounded `git()`
 * calls the removal phase can make (PR #2493 round 4, N3: the pre-remove
 * `isDirty()` recheck used to silently reuse this same reserve, which made
 * the invariant an assertion rather than a real bound).
 */
export const HOOK_REMOVE_RESERVE_MS = Object.freeze({
	"subagent-stop": 5_000,
	"session-start": REMOVE_TIMEOUT_MS,
});
/**
 * Bound for the pre-remove `isDirty()` recheck (review round 3, F1's fix;
 * PR #2493 round 4, N3). Deliberately its OWN small reserve rather than
 * `removeBoundMs`'s: a `git status --porcelain` is far cheaper than a
 * recursive `git worktree remove`, and reusing the removal-sized reserve
 * made this a second removeBound-sized call `hookBudgetMs` never subtracted
 * for, so the hook-timeout invariant no longer bounded what actually ran
 * (subagent-stop's real worst case: budget + recheck + remove could reach
 * 20s against a 15s timeout). A timeout here reads as `"unreadable"`, which
 * the dirty rail treats exactly like `"dirty"` — fails safe, never
 * destroys work — so a bound this tight costs nothing but a slightly more
 * conservative reap under real contention.
 */
export const RECHECK_TIMEOUT_MS = 1_000;
/** Grace period between SIGTERM and the hard kill (ms). */
const KILL_GRACE_MS = 300;

const USAGE = `Usage: node scripts/prune-agent-worktrees.mjs [options]

  --dry-run             Print the plan and exit without removing or killing.
  --min-age <duration>  Minimum worktree age to be eligible (default 30m).
                        Accepts 500, 500ms, 90s, 30m, 2h.
  --max <n>             Per-run removal cap for the merged-branch sweep
                        (#2631) and the unregistered-directory pass (#2538),
                        default 10. What the cap skips is printed as deferred.
                        In hook modes the effective cap is the smaller of
                        this and the policy's own cap (SessionStart: 1).
  --budget-ms <dur>     Wall-clock budget for the whole sweep (default: sized
                        to the hook timeout in --hook mode, 60s otherwise).
                        Trees not reached are reported "not-evaluated" and
                        retried next sweep.
  --scan-timeout-ms <dur>
                        Ceiling for the process-table listing alone (default
                        4s; measured cost on Windows is ~650ms median). Below
                        400ms the scan is skipped and said so; either way the
                        worktree removals still run.
  --only <path>         Restrict the sweep to this worktree; repeatable.
                        Overrides --min-age and the live-lock rail for the
                        named tree — never the dirty/unpushed rails. On
                        --hook subagent-stop it replaces the payload-derived
                        tree and takes the manual budget.
  --keep-agent-tree     --hook subagent-stop only: reap orphaned fixture
                        helpers under the stopped agent's tree but LEAVE the
                        tree itself. For operators who resume agents by
                        SendMessage; a resumed agent whose tree was reaped
                        must recreate the checkout (its branch survives).
                        Also settable with PILENS_HYGIENE_KEEP_AGENT_TREES=1.
  --hook <event>        subagent-stop | session-start. Reads the hook JSON
                        payload on stdin. subagent-stop derives the stopped
                        agent's worktree from the payload's agent_id, reaps
                        orphaned test-fixture helpers under it, and REMOVES
                        it under the unchanged dirty/unpushed rails unless
                        --keep-agent-tree says otherwise. session-start
                        removes at most ONE tree (the oldest eligible) per
                        run. Either way one hygiene.run record is written,
                        fired or skipped-with-reason.
  --no-orphan-sweep     Skip the fixture-orphan sweep.
  --json                Emit the plan as one JSON object instead of text.
  --quiet               Only print lines about work actually done.
  --help                This text.

Always exits 0.`;

// ---------------------------------------------------------------------------
// Argument parsing (pure; exported for tests)
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ dryRun: boolean, minAgeMs: number, max: number, only: string[]|null, hook: string|null, orphanSweep: boolean, json: boolean, quiet: boolean, help: boolean, errors: string[] }}
 */
export function parseArgs(argv) {
	const options = {
		dryRun: false,
		minAgeMs: DEFAULT_MIN_AGE_MS,
		max: DEFAULT_MAX_REMOVALS,
		budgetMs: null,
		scanTimeoutMs: null,
		only: null,
		hook: null,
		keepAgentTree: false,
		orphanSweep: true,
		json: false,
		quiet: false,
		help: false,
		errors: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--dry-run":
			case "-n":
				options.dryRun = true;
				break;
			case "--min-age": {
				const raw = argv[++i];
				const parsed = parseDuration(raw);
				if (parsed === null) {
					// Loud, never a silent fallback to 0 — a mis-typed --min-age
					// that quietly became 0 would disable the age rail entirely.
					options.errors.push(`invalid --min-age value: ${String(raw)}`);
				} else {
					options.minAgeMs = parsed;
				}
				break;
			}
			case "--max": {
				const raw = argv[++i];
				// Digits only: `--max 0` means ZERO removals (a plan-only run),
				// and an unreadable value is an error rather than a silent
				// fallback that would disable the cap on a destructive step.
				if (raw === undefined || !/^\d+$/.test(String(raw))) {
					options.errors.push(`invalid --max value: ${String(raw)}`);
				} else {
					options.max = Number(raw);
				}
				break;
			}
			case "--budget-ms": {
				const raw = argv[++i];
				const parsed = parseDuration(raw);
				if (parsed === null || parsed === 0) {
					options.errors.push(`invalid --budget-ms value: ${String(raw)}`);
				} else {
					options.budgetMs = parsed;
				}
				break;
			}
			case "--scan-timeout-ms": {
				const raw = argv[++i];
				const parsed = parseDuration(raw);
				if (parsed === null || parsed === 0) {
					options.errors.push(
						`invalid --scan-timeout-ms value: ${String(raw)}`,
					);
				} else {
					options.scanTimeoutMs = parsed;
				}
				break;
			}
			case "--only": {
				const raw = argv[++i];
				if (!raw) {
					options.errors.push("--only requires a path");
					break;
				}
				options.only = [...(options.only ?? []), raw];
				break;
			}
			case "--hook": {
				const raw = argv[++i];
				if (raw !== "subagent-stop" && raw !== "session-start") {
					options.errors.push(`unknown --hook event: ${String(raw)}`);
				} else {
					options.hook = raw;
				}
				break;
			}
			case "--keep-agent-tree":
				options.keepAgentTree = true;
				break;
			case "--no-orphan-sweep":
				options.orphanSweep = false;
				break;
			case "--json":
				options.json = true;
				break;
			case "--quiet":
			case "-q":
				options.quiet = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				options.errors.push(`unknown argument: ${arg}`);
		}
	}
	return options;
}

/**
 * What each invocation mode is ALLOWED to do. One table, consulted once, so
 * "SubagentStop must not remove worktrees" is a value a test can read rather
 * than a branch buried in main() (PR #2438 review S1/S8).
 *
 * `maxRemovals`: `Infinity` = uncapped (a human ran it and is watching);
 * 1 = one tree per SessionStart, because `git worktree remove` is bounded at
 * REMOVE_TIMEOUT_MS and more than one cannot fit inside the hook's own
 * timeout; 0 = never, for SubagentStop -- and since review round 3 (F4)
 * `capRemovals` reads that 0 as the zero it looks like, instead of folding it
 * into a "non-positive means uncapped" branch that said the opposite.
 */
export const HOOK_POLICIES = Object.freeze({
	/**
	 * The REGISTERED SubagentStop line: it reaps the tree of the agent that
	 * just stopped, derived from the payload's `agent_id`.
	 *
	 * This is a deliberate reversal of PR #2438's review S1 (maintainer
	 * decision, 2026-09-02). S1 said SubagentStop must never remove, because
	 * resume-by-SendMessage lands after the hook fires. The cost of that rule
	 * was #2486: the registered line — which passes no `--only` — removed
	 * NOTHING, so the only draining path left was SessionStart's one-tree cap,
	 * and N stale trees needed N sessions. Ten of them accumulated in an
	 * afternoon and were cleared by hand.
	 *
	 * THE TRADE-OFF, stated plainly: an agent resumed by SendMessage after its
	 * tree was reaped must recreate the checkout. Its BRANCH survives — the
	 * branch is only deleted when the removal succeeded, and only for the ref
	 * that removal orphaned — so nothing committed is lost; only the working
	 * copy goes. Operators who resume agents routinely turn this off with
	 * `--keep-agent-tree` / `PILENS_HYGIENE_KEEP_AGENT_TREES=1`. Merge-train
	 * worktrees are never `agent-*` trees, so `isAgentWorktreePath` excludes
	 * them and they are untouched either way.
	 *
	 * The rails that protect WORK are unchanged: `planWorktreePrune` still
	 * refuses a dirty tree and a tree whose HEAD is in no `origin/*` ref, with
	 * no flag able to override either. Naming the derived tree only overrides
	 * the two SOFT rails — minimum age (the agent stopped seconds ago) and the
	 * live git lock (that lock names the session that just ended).
	 */
	"subagent-stop": Object.freeze({
		removeWorktrees: true,
		deleteBranches: true,
		orphanSweep: true,
		scopedToAgentTree: true,
		// Exactly one tree can be derived from one payload; the cap says so
		// rather than leaving it implicit.
		maxRemovals: 1,
		budgetSource: "hook",
	}),
	/**
	 * `--hook subagent-stop --keep-agent-tree` (or
	 * `PILENS_HYGIENE_KEEP_AGENT_TREES=1`): the opt-out for an operator who
	 * resumes agents by SendMessage. Identical scoping, no removal — the
	 * orphan-fixture sweep under that agent's tree still runs, and the run is
	 * still on the record with `keptReason: "removal-not-permitted"`.
	 */
	"subagent-stop-keep": Object.freeze({
		removeWorktrees: false,
		deleteBranches: false,
		orphanSweep: true,
		scopedToAgentTree: true,
		maxRemovals: 0,
		budgetSource: "hook",
	}),
	"session-start": Object.freeze({
		removeWorktrees: true,
		deleteBranches: true,
		orphanSweep: true,
		scopedToAgentTree: false,
		maxRemovals: 1,
		budgetSource: "hook",
	}),
	manual: Object.freeze({
		removeWorktrees: true,
		deleteBranches: true,
		orphanSweep: true,
		scopedToAgentTree: false,
		maxRemovals: Number.POSITIVE_INFINITY,
		budgetSource: "manual",
	}),
});

/**
 * @param {string|null|undefined} hook
 * @param {{ only?: string[]|null, keepAgentTree?: boolean }} [invocation] The
 *   parsed argv, so the one table above can answer for the two SubagentStop
 *   variants too.
 * @returns {(typeof HOOK_POLICIES)["manual"]}
 */
export function resolveHookPolicy(hook, invocation = {}) {
	if (hook === "subagent-stop") {
		// `--only` on this event is a caller at a terminal naming trees by
		// hand. That is field-for-field a MANUAL run (PR #2493 review round 2,
		// T1) -- it was spelled as its own `subagent-stop-only` entry whose
		// six fields were identical to `manual`, which is the hand-maintained
		// mirror this repo's single-source-of-truth rule forbids.
		if ((invocation.only?.length ?? 0) > 0) return HOOK_POLICIES.manual;
		if (invocation.keepAgentTree) return HOOK_POLICIES["subagent-stop-keep"];
	}
	return HOOK_POLICIES[hook ?? "manual"] ?? HOOK_POLICIES.manual;
}

/**
 * The sweep's wall-clock budget for one invocation, derived from the hook
 * timeout that will kill it rather than guessed (#2486).
 *
 * A hook that CAN remove has to leave room for BOTH bounded `git()` calls the
 * removal phase can make: the pre-remove `isDirty()` recheck (`recheckBoundMs`,
 * round 4, N3) and `git worktree remove` itself (`removeBoundMs`), both of
 * which run OUTSIDE the sweep budget, because SIGKILLing either mid-flight is
 * worse than overrunning (a recursive delete left half-removed, or a dirty
 * check whose answer never mattered because the timeout already reads as
 * "unreadable" -> kept, same as "dirty"). So the arithmetic is
 * `timeout - (removal reserve) - (recheck reserve) - margin`, floored at
 * DEFAULT_HOOK_BUDGET_MS.
 *
 * Today that gives session-start 24s (90 - 60 - 1 - 5) instead of the 2s that
 * let 6 of 12 trees go `not-evaluated` on the #2486 box, and the reaping
 * subagent-stop 4s (15 - 5 - 1 - 5). Which arithmetic applies is the policy's
 * own `budgetSource`, so the one table stays the single place the question is
 * answered.
 *
 * @param {string|null|undefined} hook
 * @param {(typeof HOOK_POLICIES)["manual"]} policy
 * @returns {number}
 */
export function hookBudgetMs(hook, policy) {
	if (policy.budgetSource === "manual") return DEFAULT_MANUAL_BUDGET_MS;
	const timeoutMs = HOOK_TIMEOUT_MS[hook ?? ""];
	if (!timeoutMs) return DEFAULT_HOOK_BUDGET_MS;
	return Math.max(
		DEFAULT_HOOK_BUDGET_MS,
		timeoutMs -
			removeBoundMs(hook, policy) -
			recheckBoundMs(hook, policy) -
			HOOK_TIMEOUT_MARGIN_MS,
	);
}

/**
 * The wall-clock bound put on ONE `git worktree remove` for this invocation,
 * and — for a hook — the removal reserve `hookBudgetMs` subtracts from the hook
 * timeout. The two must be the same number or the invariant
 * `budget + recheck + removal + margin <= hook timeout` is a claim nothing
 * enforces.
 *
 * `REMOVE_TIMEOUT_MS` (60s) is the right bound where there is room for it: a
 * SIGKILLed recursive delete leaves a half-removed tree, so the bound should
 * only ever fire on a wedged git. SubagentStop has no room for it — 15s total —
 * so it takes a tighter one, sized from measurement rather than from the
 * comfortable number: `git worktree remove --force --force` over a 4000-file
 * worktree on the #2486 box (2026-09-02, 5 runs) cost min 956ms / median
 * 1049ms / max 1171ms, and over a 300-file tree min 146ms / median 181ms /
 * max 755ms. `HOOK_REMOVE_RESERVE_MS["subagent-stop"]` is 5s, ~4.8x the
 * measured median, and leaves the sweep 4s with a 1s recheck reserve and a
 * 5s margin.
 *
 * @param {string|null|undefined} hook
 * @param {(typeof HOOK_POLICIES)["manual"]} policy
 * @returns {number}
 */
export function removeBoundMs(hook, policy) {
	if (policy.budgetSource === "manual") return REMOVE_TIMEOUT_MS;
	if (!policy.removeWorktrees) return 0;
	return HOOK_REMOVE_RESERVE_MS[hook ?? ""] ?? REMOVE_TIMEOUT_MS;
}

/**
 * The wall-clock bound put on the pre-remove `isDirty()` recheck (review
 * round 3, F1's fix; PR #2493 round 4, N3) — deliberately its OWN small
 * reserve, not `removeBoundMs`'s. `hookBudgetMs` subtracts this too, so the
 * hook-timeout invariant counts BOTH bounded `git()` calls the removal phase
 * can make, not just the one `git worktree remove` itself makes.
 *
 * A mode that cannot remove never runs the recheck at all and reserves
 * nothing for it, mirroring `removeBoundMs`. A manual run, which no hook
 * timeout kills, gets the ordinary per-`git`-call default rather than the
 * tight hook reserve — there is no timeout pressure to justify a 1s bound
 * there.
 *
 * @param {string|null|undefined} hook
 * @param {(typeof HOOK_POLICIES)["manual"]} policy
 * @returns {number}
 */
export function recheckBoundMs(hook, policy) {
	if (policy.budgetSource === "manual") return DEFAULT_GIT_TIMEOUT_MS;
	if (!policy.removeWorktrees) return 0;
	return RECHECK_TIMEOUT_MS;
}

/**
 * How much of a sweep budget is held back for the process listing.
 *
 * The enrichment (`git worktree list`, then a `git status` and a containment
 * revwalk per tree) runs FIRST and would otherwise spend the whole budget,
 * leaving the listing under `MIN_SCAN_BUDGET_MS` and the removal without its
 * kill-what-holds-the-tree step — which on Windows is what makes a tree
 * unremovable in the first place (#2435). The reserve is therefore
 * `--scan-timeout-ms`, CAPPED AT HALF the budget: with SubagentStop's 5s
 * budget and the 4s default ceiling the uncapped form left enrichment 1s, and
 * every `git` call then drops to its 250ms floor — which `isDirty` reads as
 * `"unreadable"` and the dirty rail still keeps the very tree the hook fired
 * to reap, now with `keptReason: "status-unreadable"` rather than `"dirty"`
 * (review round 3, F2) so the ledger does not read a tight budget as
 * protected uncommitted work. At SessionStart's 25s and a manual run's 60s
 * the cap never binds.
 *
 * @param {number} budgetMs
 * @param {number} scanTimeoutMs
 * @returns {number}
 */
export function scanReserveMs(budgetMs, scanTimeoutMs) {
	const budget = Math.max(0, Number(budgetMs) || 0);
	const ceiling = Math.max(0, Number(scanTimeoutMs) || 0);
	return Math.min(ceiling, Math.floor(budget / 2));
}

/**
 * Why the ONE tree this run was scoped to is still on disk, for the
 * `hygiene.run` record (PR #2493 review round 2, S2). Null when the run
 * removed it, and null when the run had no single tree in scope.
 *
 * Three distinguishable outcomes, all previously spelled `removed: 0`:
 *   - a `planWorktreePrune` keep reason (`dirty`, `unpushed`, `self`, ...)
 *     — the rails refused it, which is the answer an operator needs;
 *   - `removal-not-permitted` — `--keep-agent-tree` / the env opt-out;
 *   - `deferred` — the policy's per-run removal cap took it next sweep.
 *
 * @param {{ targetPath: string|null, plan: { keep: {path: string, reason: string}[] }, deferred: {path: string}[], policy: (typeof HOOK_POLICIES)["manual"] }} input
 * @returns {string|null}
 */
export function keptReasonFor({ targetPath, plan, deferred, policy }) {
	if (!targetPath) return null;
	const key = toComparablePath(targetPath);
	const kept = (plan?.keep ?? []).find(
		(entry) => toComparablePath(entry.path) === key,
	);
	if (kept) return kept.reason;
	const wasDeferred = (deferred ?? []).some(
		(entry) => toComparablePath(entry.path) === key,
	);
	if (!wasDeferred) return null;
	return policy?.removeWorktrees ? "deferred" : "removal-not-permitted";
}

/**
 * The environment spelling of `--keep-agent-tree`, for operators who resume
 * agents by SendMessage and cannot edit the registered hook line. Any value
 * other than the explicit falsy spellings turns it on: an operator who set
 * this at all meant to keep their trees.
 *
 * @returns {boolean}
 */
function envKeepAgentTrees() {
	const raw = process.env.PILENS_HYGIENE_KEEP_AGENT_TREES;
	if (raw === undefined) return false;
	const value = raw.trim().toLowerCase();
	return value !== "" && value !== "0" && value !== "false" && value !== "no";
}

/**
 * Derive the worktree a SubagentStop payload refers to. Claude Code names an
 * agent worktree `.claude/worktrees/agent-<agent_id>`, so the payload's
 * `agent_id` maps to a path — but the mapping is a NAMING CONVENTION, not a
 * documented contract, so the caller must verify the derived path is a real
 * worktree before acting on it. Returns null for any payload that does not
 * carry a usable id.
 *
 * @param {unknown} payload
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function worktreePathFromHookPayload(payload, repoRoot) {
	if (!payload || typeof payload !== "object") return null;
	const agentId = /** @type {{ agent_id?: unknown }} */ (payload).agent_id;
	if (typeof agentId !== "string") return null;
	// Ids are opaque; refuse anything that could escape the worktrees dir.
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) return null;
	return path.join(repoRoot, ".claude", "worktrees", `agent-${agentId}`);
}

/**
 * Read a hook's JSON payload from stdin. Never blocks on an interactive
 * terminal, and treats any read/parse failure as "no payload" rather than an
 * error — a hook that cannot identify its agent still runs the default
 * sweep.
 *
 * @returns {unknown}
 */
function readHookPayload() {
	if (process.stdin.isTTY) return null;
	try {
		const raw = fs.readFileSync(0, "utf8");
		if (!raw.trim()) return null;
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

/**
 * `git` with shell:false, a bounded buffer, AND a wall-clock timeout.
 *
 * The timeout is not decoration. Measured on the #2435 box while five agents
 * were building and testing concurrently, a single `git status --porcelain`
 * took over 100 SECONDS; without a per-call bound the sweep's own budget is
 * unenforceable, because the budget can only be checked BETWEEN calls. A
 * timed-out (or failed) call returns null, which every caller reads in the
 * safe direction: "dirty" / "unpushed" / "keep".
 *
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} timeoutMs
 * @returns {string|null}
 */
function git(args, cwd, timeoutMs = DEFAULT_GIT_TIMEOUT_MS) {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			shell: false,
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: Math.max(MIN_GIT_TIMEOUT_MS, Math.round(timeoutMs)),
			killSignal: "SIGKILL",
		});
	} catch {
		return null;
	}
}

/**
 * The MAIN checkout's root, which is where `.claude/worktrees/` actually
 * lives. `REPO_ROOT` is derived from this script's own location, so a sweep
 * invoked from inside an agent worktree would otherwise look for
 * `<worktree>/.claude/worktrees/agent-<id>` and find nothing. Asked of git
 * rather than reconstructed by string surgery: `--git-common-dir` is the
 * shared `.git` of the whole worktree set.
 *
 * @param {number} timeoutMs
 * @returns {string|null}
 */
function mainCheckoutRoot(timeoutMs) {
	const out = git(
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		REPO_ROOT,
		timeoutMs,
	);
	const commonDir = (out ?? "").trim();
	if (!commonDir) return null;
	return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
}

/**
 * Resolve a worktree's admin directory from its `.git` file (`gitdir: ...`).
 * Authoritative, unlike guessing `<common>/worktrees/<basename>`: git does
 * not guarantee the admin directory is named after the worktree.
 *
 * @param {string} worktreePath
 * @returns {string|null}
 */
function readWorktreeAdminDir(worktreePath) {
	try {
		const dotGit = path.join(worktreePath, ".git");
		const stat = fs.statSync(dotGit);
		if (stat.isDirectory()) return dotGit;
		const content = fs.readFileSync(dotGit, "utf8").trim();
		const match = /^gitdir:\s*(.+)$/m.exec(content);
		return match ? path.resolve(worktreePath, match[1].trim()) : null;
	} catch {
		return null;
	}
}

/**
 * Newest observed activity for a worktree. `--min-age` asks "has anyone
 * touched this recently", so the only admissible answers are signals the
 * sweep's own inspection does not write -- see `WORKTREE_ACTIVITY_SIGNALS`
 * for the measured table and why `<admin>` and `<admin>/index` are banned
 * (PR #2438 review round 3, F1). Gathering happens here because it touches
 * the filesystem; the decision is the pure `worktreeActivityFromSignals`.
 *
 * Unreadable => `nowMs` => too young => kept, which is the safe direction.
 *
 * Exported for tests: the rail this feeds is the difference between a sweep
 * that removes finished trees and one that can never remove anything, and
 * proving it needs a REAL worktree that a real `git status` has run inside.
 *
 * @param {string} worktreePath
 * @param {number} nowMs
 * @returns {number}
 */
export function worktreeActivityMs(worktreePath, nowMs) {
	const mtimeOf = (file) => {
		try {
			return fs.statSync(file).mtimeMs;
		} catch {
			/* missing input just doesn't contribute */
			return null;
		}
	};
	const adminDir = readWorktreeAdminDir(worktreePath);
	/** @type {Record<string, number|null>} */
	const signals = {
		checkout: mtimeOf(worktreePath),
		head: adminDir ? mtimeOf(path.join(adminDir, "HEAD")) : null,
		reflog: adminDir
			? reflogLastEntryMs(path.join(adminDir, "logs", "HEAD"))
			: null,
	};
	return worktreeActivityFromSignals(signals, nowMs);
}

/** Ceiling on how much of a reflog file the tail read pulls in. */
const REFLOG_TAIL_MAX_BYTES = 64 * 1024;

/**
 * Read up to `maxBytes` from the END of `file`. `parseReflogLastEntryMs`
 * only ever wants the LAST complete line, and it already scans its input
 * back-to-front — a possibly-truncated first line at the start of the
 * window is simply skipped (it fails the timestamp regex, or is discarded
 * as not the newest). Never throws; an unreadable file yields "".
 *
 * @param {string} file
 * @param {number} maxBytes
 * @returns {string}
 */
function readFileTail(file, maxBytes) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
		const size = fs.fstatSync(fd).size;
		const length = Math.min(size, maxBytes);
		const start = size - length;
		const buffer = Buffer.alloc(length);
		fs.readSync(fd, buffer, 0, length, start);
		return buffer.toString("utf8");
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* already closed */
			}
		}
	}
}

/**
 * Last entry time of a reflog file, or null when it is absent or unparseable.
 * Reads only the tail: a long-lived worktree's `logs/HEAD` is small, but a
 * bounded read (see `readFileTail`) keeps the sweep's per-tree cost flat
 * regardless — a `readFileSync` here would not (PR #2438 review round 4,
 * F-B).
 *
 * @param {string} file
 * @returns {number|null}
 */
function reflogLastEntryMs(file) {
	try {
		return parseReflogLastEntryMs(readFileTail(file, REFLOG_TAIL_MAX_BYTES));
	} catch {
		return null;
	}
}

/**
 * True iff `sha` is contained in at least one `refs/remotes/origin/*` ref.
 * Unreadable git output => false => "unpushed" => kept. Fails safe.
 *
 * Two-step on purpose, because this is the sweep's dominant cost. Measured
 * on the #2435 box (5 worktrees, this repo):
 *   `for-each-ref --contains=<sha> refs/remotes/origin` : 640ms
 *   `merge-base --is-ancestor <sha> origin/master`      :  47ms
 * The cheap check answers the overwhelmingly common case (the tree's work
 * is already on master), and the expensive one only runs for a head that
 * is NOT on master yet — an open PR branch — which still has to be answered
 * correctly, so it is a fallback rather than a replacement.
 *
 * @param {string|null} sha
 * @param {string} repoRoot
 * @param {number} [timeoutMs]
 * @returns {boolean}
 */
function isContainedInOrigin(
	sha,
	repoRoot,
	timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
) {
	if (!sha) return false;
	// `--is-ancestor` communicates through its exit code; git() returns "" on
	// exit 0 and null on any non-zero exit.
	if (
		git(
			["merge-base", "--is-ancestor", sha, "origin/master"],
			repoRoot,
			timeoutMs,
		) !== null
	) {
		return true;
	}
	const out = git(
		[
			"for-each-ref",
			`--contains=${sha}`,
			"--count=1",
			"--format=%(refname)",
			"refs/remotes/origin",
		],
		repoRoot,
		timeoutMs,
	);
	return typeof out === "string" && out.trim() !== "";
}

/**
 * True iff `sha` is an ancestor of `origin/master` — the STRICT merged
 * criterion of the merged-branch sweep (#2631). A tree merged only into a
 * side branch is NOT merged for this purpose: the sweep deletes the local
 * branch after removal, and only `origin/master` containment makes that
 * unconditional. Unreadable git output or a missing `origin/master` => false
 * => "unmerged" => kept. Fails safe.
 *
 * @param {string|null} sha
 * @param {string} repoRoot
 * @param {number} [timeoutMs]
 * @returns {boolean}
 */
function isAncestorOfOriginMaster(
	sha,
	repoRoot,
	timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
) {
	if (!sha) return false;
	// `--is-ancestor` communicates through its exit code; git() returns "" on
	// exit 0 and null on any non-zero exit.
	return (
		git(
			["merge-base", "--is-ancestor", sha, "origin/master"],
			repoRoot,
			timeoutMs,
		) !== null
	);
}

/**
 * `git status --porcelain`, tri-state, plus the FIRST porcelain entry so a
 * keep record can NAME what it protected (#2631). Porcelain reports untracked
 * files too, so "clean" already excludes untracked deliverables — an empty
 * porcelain output is the only clean any removal in this script may act on
 * (on 2026-09-09 a 22 KB untracked report was destroyed by a sweep that read
 * its checkout as removable).
 *
 * @param {string} worktreePath
 * @param {number} [timeoutMs]
 * @returns {{ state: "clean"|"dirty"|"unreadable", firstEntry: string|null }}
 */
function statusSnapshot(worktreePath, timeoutMs = DEFAULT_GIT_TIMEOUT_MS) {
	const out = git(["status", "--porcelain"], worktreePath, timeoutMs);
	if (out === null) return { state: "unreadable", firstEntry: null };
	const firstLine = out.split(/\r?\n/).find((line) => line.trim() !== "");
	return {
		state: out.trim() !== "" ? "dirty" : "clean",
		firstEntry: firstLine ? firstLine.trim().slice(0, 120) : null,
	};
}

/**
 * `git status --porcelain`, tri-state. `"unreadable"` (the call timed out,
 * the process never spawned, or the worktree could not answer at all) is
 * kept APART from a genuine `"dirty"` porcelain output — both still refuse
 * removal (fails safe in the direction that never destroys work), but a
 * ledger that calls a budget too tight to ask "dirty" is not the answer an
 * operator needs (review round 3, F2): `keptReason: "dirty"` reads as
 * protected work, when the real story is a scan that never got to look.
 *
 * @param {string} worktreePath
 * @param {number} [timeoutMs]
 * @returns {"clean"|"dirty"|"unreadable"}
 */
export function isDirty(worktreePath, timeoutMs = DEFAULT_GIT_TIMEOUT_MS) {
	return statusSnapshot(worktreePath, timeoutMs).state;
}

// ---------------------------------------------------------------------------
// Process table
// ---------------------------------------------------------------------------
//
// The listing itself lives in scripts/lib/process-scan.mjs (review round 3,
// F2): this script and scripts/compat-smoke-behavioral.mjs each carried a
// windowsExe + snapshotProcesses pair differing only in the columns they
// asked for, so the exit-code hardening from review S5 landed in one and not
// the other. This file now asks for the projection it needs and nothing else.

/**
 * Best-effort cwd enrichment on procfs platforms (Linux). A process holding
 * a worktree open by cwd alone shows nothing useful in its command line, and
 * `/proc/<pid>/cwd` is the only portable-ish way to see it. Absent on
 * Windows and macOS, where command-line matching is the sole signal — stated
 * rather than silently assumed.
 *
 * @param {import("./lib/worktree-hygiene.mjs").ProcRow[]} rows
 * @returns {import("./lib/worktree-hygiene.mjs").ProcRow[]}
 */
function enrichCwd(rows) {
	if (isWindows || !fs.existsSync("/proc")) return rows;
	for (const row of rows) {
		try {
			row.cwd = fs.readlinkSync(`/proc/${row.pid}/cwd`);
		} catch {
			/* exited, or not ours to read */
		}
	}
	return rows;
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means it exists but is not ours to signal (observed on
		// Windows for protected processes) — alive.
		return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
	}
}

/**
 * Terminate one pid: SIGTERM, a short grace period, then SIGKILL if it is
 * still there. Deliberately `process.kill` by pid and never `taskkill` —
 * `taskkill /IM node.exe` would take out every unrelated node process on the
 * box, and this repo has already been burned by teardown-time spawns on
 * Windows (#234), so no child process is spawned to do the killing either.
 *
 * @param {number} pid
 * @returns {Promise<{ killed: boolean, error: string|null }>}
 */
async function terminatePid(pid) {
	try {
		process.kill(pid, "SIGTERM");
	} catch (err) {
		const code = /** @type {NodeJS.ErrnoException} */ (err).code;
		if (code === "ESRCH") return { killed: true, error: null };
		return { killed: false, error: String(code ?? err) };
	}
	await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
	if (!isPidAlive(pid)) return { killed: true, error: null };
	try {
		process.kill(pid, "SIGKILL");
	} catch (err) {
		const code = /** @type {NodeJS.ErrnoException} */ (err).code;
		if (code === "ESRCH") return { killed: true, error: null };
		return { killed: false, error: String(code ?? err) };
	}
	return { killed: !isPidAlive(pid), error: null };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Where the hygiene ledger lives. `PILENS_DATA_DIR` is honored first because
 * #2435 names it, then `PI_LENS_HOME` (the machine-scoped root the sibling
 * test-suite lock already uses — this sweep is machine-scoped, not
 * project-scoped), then `~/.pi-lens`.
 *
 * DELIBERATELY hand-rolled rather than delegating to
 * `getGlobalPiLensLogDir()` (`clients/probe-home-state.ts`) — decided and
 * documented here per #2516 review item 4. This script is a standalone `.mjs`
 * run directly by Node (`scripts/`), and it runs BEFORE the build: importing
 * a `clients/*.js` module would make it depend on compiled output that may
 * not exist yet in a bare checkout. (It would no longer inherit an import
 * cycle — #2516 round 2 moved that resolver onto a cycle-free leaf — so the
 * pre-build constraint is now the whole of the reason.) The consequence is the
 * one this file's own two-process-divergence note describes: a hygiene sweep
 * run from inside a worktree does NOT get the `.pi-lens-probe-home`
 * redirect, so its ledger always lands in the real machine-global root (or
 * `PI_LENS_HOME`/`PILENS_DATA_DIR` if set) — accepted, since this sweep
 * genuinely IS machine-scoped work, not an ad-hoc probe the redirect exists
 * to isolate. Coordinate any future change here with #2493 (the SubagentStop
 * reap path), which shares this resolver.
 *
 * @returns {string}
 */
export function getHygieneLogPath() {
	const dataDir = process.env.PILENS_DATA_DIR?.trim();
	const home = process.env.PI_LENS_HOME?.trim();
	const base = dataDir
		? path.resolve(dataDir)
		: home
			? path.resolve(home)
			: path.join(os.homedir(), ".pi-lens");
	return path.join(base, "hygiene.log");
}

/**
 * Append records to the ledger. Best effort: a ledger that cannot be written
 * must never fail the sweep it is recording.
 *
 * A plain append is one atomic write syscall per call, so two SubagentStop
 * hooks racing on the same ledger both survive — unlike the previous
 * read-modify-write, which could lose whichever process wrote last (PR #2438
 * review round 4, F-E). Trimming back to the bound is therefore split out
 * and made rare, not run on every append — see `maybeTrimLedger`.
 *
 * @param {string[]} records
 */
function appendLedger(records) {
	if (records.length === 0) return;
	const logPath = getHygieneLogPath();
	try {
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.appendFileSync(logPath, `${records.join("\n")}\n`, "utf8");
	} catch (error) {
		console.error(
			`[hygiene] could not write ${logPath}: ${error instanceof Error ? error.message : error}`,
		);
		return;
	}
	maybeTrimLedger(logPath);
}

/**
 * Trim the ledger back to `DEFAULT_LOG_MAX_LINES`, but only once it has grown
 * to more than double that. A trim is still a destructive read-modify-write
 * against a concurrent appender, so it stays reserved for the rare case
 * where the file has actually grown unbounded rather than running (and
 * racing) on every write. A lost race here just leaves the file oversized
 * until the next write's check triggers a retry — never data loss for a
 * concurrent append, since the appender's own write already landed.
 *
 * @param {string} logPath
 */
function maybeTrimLedger(logPath) {
	try {
		const lines = fs
			.readFileSync(logPath, "utf8")
			.split(/\r?\n/)
			.filter((line) => line.trim() !== "");
		if (lines.length <= DEFAULT_LOG_MAX_LINES * 2) return;
		const kept = pruneLogLines([], lines, DEFAULT_LOG_MAX_LINES);
		fs.writeFileSync(logPath, `${kept.join("\n")}\n`, "utf8");
	} catch {
		/* best effort; ledger writability failures are already reported by
		   appendLedger */
	}
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/**
 * Remove top-level directory SYMLINKS/JUNCTIONS from a worktree before git
 * deletes it. Agents junction `node_modules` into the main checkout to avoid
 * a per-worktree install; a recursive delete that followed that reparse
 * point would wipe the SHARED node_modules. `fs.rmSync` on the link itself
 * (never `{ recursive: true }`) unlinks the junction and leaves its target
 * untouched. Depth 1 only — a link nested deeper is not a shape this repo
 * creates, and walking the whole tree to find one would cost more than the
 * removal it precedes.
 *
 * @param {string} worktreePath
 * @returns {string[]} paths of unlinked reparse points
 */
function unlinkTopLevelLinks(worktreePath) {
	const unlinked = [];
	let entries;
	try {
		entries = fs.readdirSync(worktreePath, { withFileTypes: true });
	} catch {
		return unlinked;
	}
	for (const entry of entries) {
		if (!entry.isSymbolicLink()) continue;
		const full = path.join(worktreePath, entry.name);
		try {
			fs.rmSync(full, { recursive: false, force: true });
			unlinked.push(full);
		} catch {
			try {
				fs.rmdirSync(full);
				unlinked.push(full);
			} catch {
				/* leave it; git will complain and we log the failure */
			}
		}
	}
	return unlinked;
}

/**
 * Enumerate `.claude/worktrees/agent-*` directories that are present on disk
 * but absent from `git worktree list` (#2538) — the leftovers whose metadata
 * `git worktree prune` already dropped, which the registration-based sweeps
 * never see. A directory becomes a removal candidate only when
 * `unregisteredAgentDirVerdict` proves it holds nothing but git's own `.git`
 * gitlink; any other entry is treated as an untracked deliverable (see the
 * 2026-09-09 22 KB report note on that verdict) and the directory is KEPT,
 * named. Unreadable is keep, never remove.
 *
 * @param {{ base: string, registeredKeys: Set<string>, selfKeys: Set<string> }} input
 * @returns {{ remove: string[], keep: { path: string, reason: string, detail: string|null }[] }}
 */
function collectUnregisteredAgentDirs({ base, registeredKeys, selfKeys }) {
	const plan = { remove: [], keep: [] };
	let entries;
	try {
		entries = fs.readdirSync(base, { withFileTypes: true });
	} catch {
		return plan;
	}
	for (const entry of entries) {
		// Directories only, and never a symlink: a symlink named `agent-*`
		// pointing out of the tree must not be followed or removed.
		if (!entry.isDirectory()) continue;
		// The naming convention `worktreePathFromHookPayload` documents:
		// Claude Code names a managed agent worktree `agent-<agentId>`.
		if (!/^agent-/.test(entry.name)) continue;
		const full = path.join(base, entry.name);
		const key = toComparablePath(full);
		if (registeredKeys.has(key)) continue;
		if (selfKeys.has(key)) {
			plan.keep.push({
				path: full,
				reason: "self",
				detail: "this sweep is running inside it",
			});
			continue;
		}
		let names = null;
		try {
			names = fs.readdirSync(full);
		} catch {
			names = null;
		}
		const verdict = unregisteredAgentDirVerdict(names);
		if (verdict.removable) plan.remove.push(full);
		else
			plan.keep.push({
				path: full,
				reason: "has-untracked-content",
				detail: verdict.reason,
			});
	}
	return plan;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const SELF_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SELF_FILE);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

/**
 * Take the bounded process snapshot, enrich it with cwd where the platform
 * allows, and report whether the LISTING itself succeeded. Any degradation is
 * returned as a ledger record rather than only printed: the hooks run
 * `--quiet`, so an unrecorded degradation makes a sweep that ran blind look
 * exactly like a sweep that found nothing (defect shape 10).
 *
 * @param {{ budgetMs: number, budgetLeft: () => number, scanTimeoutMs?: number|null }} options
 */
async function readProcessTable({ budgetMs, budgetLeft, scanTimeoutMs }) {
	const scanBudgetMs = Math.min(
		scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
		budgetLeft(),
	);
	// Skipping loudly beats scanning with a stub timeout it cannot meet. The
	// ceiling can be short for either reason -- the sweep budget is nearly
	// spent, or --scan-timeout-ms named a small one -- so the message reports
	// the ceiling it actually computed rather than assuming the first.
	if (scanBudgetMs < MIN_SCAN_BUDGET_MS) {
		console.error(
			`[hygiene] process scan skipped: ceiling ${scanBudgetMs}ms ` +
				`(needs ${MIN_SCAN_BUDGET_MS}ms; ${budgetLeft()}ms of the ` +
				`${budgetMs}ms sweep budget left); no orphan sweep this run. ` +
				"Worktree removals are unaffected.",
		);
		return {
			table: [],
			listingOk: false,
			scanBudgetMs,
			records: [
				formatScanRecord({
					reason: "skipped",
					budgetMs,
					// The two are DIFFERENT facts and used to be the same field
					// (review round 2, T3): `remainingMs` is what is left of the
					// sweep budget, `ceilingMs` the bound the listing was given.
					remainingMs: budgetLeft(),
					ceilingMs: scanBudgetMs,
					rows: 0,
				}),
			],
		};
	}
	// The sweep needs the parent pid (the orphan predicate) and the command
	// line (both the fixture matcher and the occupant matcher).
	const { rows, ok } = await snapshotProcesses(
		["pid", "ppid", "command"],
		scanBudgetMs,
	);
	const table = enrichCwd(rows);
	const records = [];
	if (!ok) {
		console.error(
			`[hygiene] process listing failed, timed out or exited non-zero ` +
				`within ${scanBudgetMs}ms; no orphan sweep this run`,
		);
		records.push(
			formatScanRecord({
				reason: "listing-failed",
				budgetMs,
				remainingMs: budgetLeft(),
				ceilingMs: scanBudgetMs,
				rows: table.length,
			}),
		);
	} else if (table.length === 0) {
		console.error(
			`[hygiene] process scan returned no rows within ${scanBudgetMs}ms; ` +
				`no orphan sweep this run`,
		);
		records.push(
			formatScanRecord({
				reason: "empty",
				budgetMs,
				remainingMs: budgetLeft(),
				ceilingMs: scanBudgetMs,
				rows: 0,
			}),
		);
	}
	return { table, listingOk: ok, scanBudgetMs, records };
}

async function main(argv) {
	const options = parseArgs(argv);
	if (options.help) {
		console.log(USAGE);
		return;
	}
	const startedAt = Date.now();
	const nowIso = new Date().toISOString();
	for (const error of options.errors) console.error(`[hygiene] ${error}`);
	if (options.errors.length > 0) {
		appendLedger([
			formatRunRecord({
				hook: options.hook,
				outcome: "skipped",
				reason: RUN_SKIP_REASONS.INVALID_ARGUMENTS,
				durationMs: Date.now() - startedAt,
				nowIso,
			}),
		]);
		return;
	}

	const say = (message) => {
		if (!options.quiet && !options.json) console.log(`[hygiene] ${message}`);
	};
	// The environment opt-out is folded in HERE rather than inside parseArgs,
	// which stays a pure argv -> options function. Either spelling reaches the
	// policy table the same way.
	if (envKeepAgentTrees()) options.keepAgentTree = true;
	// The policy reads the whole invocation, not just the event name: the
	// registered `--hook subagent-stop` reaps the stopped agent's own tree,
	// `--keep-agent-tree` turns that off, and `--only` makes it a manual run
	// over the trees the caller named (#2486).
	const policy = resolveHookPolicy(options.hook, options);
	const budgetMs = options.budgetMs ?? hookBudgetMs(options.hook, policy);
	const scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
	const removeBound = removeBoundMs(options.hook, policy);
	// A SMALL, dedicated bound for the pre-remove `isDirty()` recheck (PR
	// #2493 round 4, N3) -- it used to reuse `removeBound`, which made it a
	// SECOND removeBound-sized `git()` call the hook-timeout invariant never
	// counted (`hookBudgetMs` only ever reserved room for one). A timeout
	// here reads as "unreadable", which the dirty rail treats exactly like
	// "dirty" -- keeps the tree, never destroys it -- so a tight bound fails
	// safe in the same direction a generous one does.
	const recheckBound = recheckBoundMs(options.hook, policy);
	const budgetLeft = () => Math.max(0, budgetMs - (Date.now() - startedAt));
	// Read once, whichever path runs: stdin is a one-shot stream, and the
	// ordinary path now serves `--hook subagent-stop --only` too.
	const payload = options.hook ? readHookPayload() : null;

	/**
	 * The stopped agent's own worktree, when this invocation is scoped to one.
	 * It becomes both the removal SELECTION (so the age and live-lock rails
	 * give way for it, exactly as `--only` does) and the orphan sweep's
	 * `restrictToPath` (so a SubagentStop never kills a sibling agent's
	 * helpers). Null for every other mode.
	 * @type {string|null}
	 */
	let agentTree = null;

	// Where `.claude/worktrees/` actually lives: the MAIN checkout's root. The
	// SubagentStop payload derivation needs it, and so does the unregistered-
	// directory pass (#2538), which every non-scoped mode runs.
	const worktreesBase =
		mainCheckoutRoot(
			Math.min(
				DEFAULT_GIT_TIMEOUT_MS,
				Math.max(MIN_GIT_TIMEOUT_MS, budgetLeft()),
			),
		) ?? REPO_ROOT;

	if (policy.scopedToAgentTree) {
		const derived = worktreePathFromHookPayload(payload, worktreesBase);
		// Deliberately does NOT fall back to the ordinary sweep: this hook has
		// a mandate over exactly one agent's tree, and with no usable agent_id
		// it has no mandate at all. The two ways that can happen are DIFFERENT
		// facts and are now reported as such (#2486) -- "no worktree for a
		// perfectly good agent_id" is the ordinary case for every subagent
		// that is not worktree-isolated, and reporting it as a missing
		// agent_id is what made the empty ledger unreadable.
		const skip = !derived
			? { reason: RUN_SKIP_REASONS.NO_AGENT_ID, worktree: null }
			: !fs.existsSync(derived)
				? { reason: RUN_SKIP_REASONS.AGENT_WORKTREE_MISSING, worktree: derived }
				: null;
		if (skip) {
			console.error(
				skip.worktree
					? `[hygiene] subagent-stop: no worktree at ${skip.worktree}; the ` +
							"agent was not worktree-isolated, or its tree is already gone"
					: "[hygiene] subagent-stop: no usable agent_id on stdin; nothing to do",
			);
			appendLedger([
				formatRunRecord({
					hook: "subagent-stop",
					outcome: "skipped",
					reason: skip.reason,
					worktree: skip.worktree,
					dryRun: options.dryRun,
					budgetMs,
					durationMs: Date.now() - startedAt,
					nowIso,
				}),
			]);
			return;
		}
		agentTree = derived;
	}

	if (options.hook === "session-start" && options.only) {
		console.error(
			"[hygiene] session-start: ignoring --only; the session sweep never " +
				"narrows to a single tree",
		);
	}
	// What this run is allowed to touch. `--only` belongs to a human at a
	// terminal; the SubagentStop hook selects the one tree it derived from its
	// payload; the session sweep runs the ordinary rails over every tree
	// (review S1). Selection is the SAME mechanism in all three cases, so
	// there is one removal path, not a scoped copy of it that quietly lost the
	// removal step — which is how #2486 shipped.
	let only = options.only;
	if (options.hook === "session-start") only = null;
	else if (agentTree) only = [agentTree];
	const minAgeMs = options.minAgeMs;

	// Every git call is bounded by whatever is LEFT of the sweep's budget, not
	// by a fixed constant: the budget is only enforceable if no single call can
	// outlast it (a `git status` on this box hit 100s+ under five-agent load).
	const boundedTo = (remainingMs) =>
		Math.min(DEFAULT_GIT_TIMEOUT_MS, Math.max(MIN_GIT_TIMEOUT_MS, remainingMs));
	const gitBudget = () => boundedTo(budgetLeft());
	// Reserve room for the process snapshot so a long enrichment pass cannot
	// starve the orphan sweep entirely: reading the worktree table and every
	// per-tree query is bounded by the ENRICH deadline, not the total budget.
	// The reserve is capped at half the budget — see `scanReserveMs`.
	const enrichDeadline =
		startedAt + Math.max(0, budgetMs - scanReserveMs(budgetMs, scanTimeoutMs));
	const enrichBudget = () => boundedTo(enrichDeadline - Date.now());

	const porcelain = git(
		["worktree", "list", "--porcelain"],
		REPO_ROOT,
		enrichBudget(),
	);
	if (porcelain === null) {
		console.error("[hygiene] `git worktree list` failed; nothing to do");
		appendLedger([
			formatRunRecord({
				hook: options.hook,
				outcome: "skipped",
				reason: RUN_SKIP_REASONS.WORKTREE_LIST_FAILED,
				dryRun: options.dryRun,
				budgetMs,
				durationMs: Date.now() - startedAt,
				nowIso,
			}),
		]);
		return;
	}
	const listed = parseWorktreeList(porcelain);
	const nowMs = Date.now();

	// The MAIN checkout (always `git worktree list`'s first row) is never a
	// candidate of either sweep; neither is the checkout this script runs from.
	const primaryKeys = new Set(
		[listed[0]?.path, REPO_ROOT].filter(Boolean).map(toComparablePath),
	);
	// #2631: the merged-branch sweep runs wherever removals run, EXCEPT the
	// SubagentStop hooks, whose mandate is exactly the one tree their payload
	// derived — touching sibling trees there would break the scoping contract.
	const mergedPassRuns = policy.removeWorktrees && !policy.scopedToAgentTree;

	// Trees named by --only are inspected FIRST, so a narrowed manual run never
	// loses its budget to unrelated siblings (orderBySelection, tested).
	const ordered = orderBySelection(listed, only);
	// ...and they are never dropped for budget either. Ordering alone left a
	// second `--only` tree `not-evaluated` whenever the first one's `git
	// status` outlasted the enrich deadline, which for a caller that
	// ENUMERATED its trees is a silent refusal to do the one job it asked for
	// (#2486). The bound that matters is still enforced: every git call the
	// enrichment makes is capped by `enrichBudget()`. Pinned by the e2e case
	// "evaluates every --only tree even past the enrich deadline" -- review
	// round 2 (S3) flagged this branch as untested, and deleting it is exactly
	// the mutation that case reds on.
	const selectedKeys = only ? new Set(only.map(toComparablePath)) : null;

	let evaluated = 0;
	let skippedForBudget = 0;
	const candidates = ordered.map((row) => {
		const isPrimary = primaryKeys.has(toComparablePath(row.path));
		const isAgentTree = isAgentWorktreePath(row.path);
		// The age rail evaluates agent trees; the merged pass (#2631) evaluates
		// every OTHER non-primary tree. An unevaluated tree is never removable
		// by either sweep, so skipping one for budget is safe for both.
		if (isPrimary || (!isAgentTree && !mergedPassRuns)) {
			return { ...row, dirty: false, pushed: false, mtimeMs: nowMs };
		}
		// `evaluated === 0` guarantees at least one tree is always inspected,
		// so a pathologically tight budget degrades to slow progress rather
		// than to a sweep that can never remove anything.
		if (
			evaluated > 0 &&
			!selectedKeys?.has(toComparablePath(row.path)) &&
			Date.now() > enrichDeadline
		) {
			skippedForBudget++;
			return {
				path: row.path,
				head: row.head,
				branch: row.branch,
				locked: row.locked,
				lockPid: parseLockPid(row.lockedReason),
				unevaluated: true,
				dirty: true,
				pushed: false,
				mtimeMs: nowMs,
			};
		}
		evaluated++;
		// Activity is READ BEFORE anything that runs git inside the tree
		// (F1b). `worktreeActivityFromSignals` already refuses the signals
		// `git status` writes, so this ordering is belt-and-braces rather than
		// the fix -- but object-literal properties evaluate in source order,
		// and the version that read activity LAST is precisely how a sweep
		// that removes nothing shipped. Reading first means no future signal
		// added to the gatherer can quietly re-open the hole.
		const mtimeMs = worktreeActivityMs(row.path, nowMs);
		const status = statusSnapshot(row.path, enrichBudget());
		// #2631: STRICT origin/master ancestry for the merged pass — a tree
		// merged only into a side branch is not merged for a sweep that
		// deletes the local branch after removal.
		const mergedIntoMaster = mergedPassRuns
			? isAncestorOfOriginMaster(row.head, REPO_ROOT, enrichBudget())
			: false;
		let pushed = mergedIntoMaster;
		if (isAgentTree && !pushed) {
			pushed = isContainedInOrigin(row.head, REPO_ROOT, enrichBudget());
		}
		return {
			path: row.path,
			head: row.head,
			branch: row.branch,
			locked: row.locked,
			lockPid: parseLockPid(row.lockedReason),
			mtimeMs,
			dirty: status.state !== "clean",
			// Threaded through to `planWorktreePrune`'s dirty rail so the
			// ledger's `keptReason` can say `status-unreadable` instead of
			// `dirty` when the real story is a budget too tight to ask
			// (review round 3, F2) -- both still refuse removal.
			dirtyUnreadable: status.state === "unreadable",
			pushed,
			// Merged-pass facts (#2631). Porcelain reports untracked files, so
			// `clean` covers BOTH halves of "no tracked changes, no untracked
			// files", and `statusDetail` names what a keep protects.
			clean: status.state === "clean",
			statusUnreadable: status.state === "unreadable",
			mergedIntoMaster,
			statusDetail: status.firstEntry,
		};
	});

	const plan = planWorktreePrune({
		worktrees: candidates,
		nowMs,
		minAgeMs,
		only,
		// Both spellings of "where this sweep lives": its own file, and the
		// directory it was invoked from. planWorktreePrune maps each to the
		// agent worktree that CONTAINS it (review S4) — neither is ever a
		// worktree root, so equality never fired.
		selfPath: [SCRIPT_DIR, process.cwd()],
		isPidAlive,
	});

	// #2631: the merged-branch sweep plans over every non-primary tree the
	// enrichment evaluated — agent-shaped and not. The age rail below and the
	// merged rail overlap on agent trees; the combined removal list is deduped
	// by path right after the capping.
	const mergedPlan = mergedPassRuns
		? planMergedWorktreeRemovals({
				candidates: candidates.filter(
					(candidate) =>
						!primaryKeys.has(toComparablePath(candidate.path)) &&
						!candidate.bare,
				),
				nowMs,
				selfPath: [SCRIPT_DIR, process.cwd()],
				isPidAlive,
				selectedKeys,
			})
		: { remove: [], keep: [] };

	// At most one removal per SessionStart run: `git worktree remove` is
	// bounded at REMOVE_TIMEOUT_MS and a SIGKILLed removal leaves a
	// half-removed tree, so the hook's timeout has to cover the removal it
	// starts (review S8). A manual run takes the `--max` cap instead.
	//
	// The RAW age-plan removals are the `deferred` source AND the merged
	// pass's dedupe base. Capping happens ONCE, on `removals` below: deriving
	// `deferred` from an already-capped list would drop everything past the
	// cap, and for a non-removing policy (--keep-agent-tree) drop plan.remove
	// entirely, which reads keptReason as null ("removed") instead of
	// "removal-not-permitted".
	const ageRemovals = plan.remove;
	const ageRemovalKeys = new Set(
		ageRemovals.map((removal) => toComparablePath(removal.path)),
	);
	// #2631: the merged pass's own removals, deduped against the age rail's —
	// a tree both plans selected is removed once.
	const mergedRemovals =
		mergedPassRuns && policy.removeWorktrees
			? mergedPlan.remove
					.filter(
						(removal) => !ageRemovalKeys.has(toComparablePath(removal.path)),
					)
					.map((removal) => ({ ...removal, fromMerged: true }))
			: [];
	// #2538/#2631: `--max` (default 10) bounds every removal ONE run performs,
	// age rail and merged pass combined, and what it skips is printed. Hook
	// modes keep their policy cap — the hook-timeout arithmetic (budget +
	// recheck + removal + margin <= timeout) is sized for ONE removal — so the
	// effective cap is the smaller of the two.
	const runCap = Math.min(policy.maxRemovals, options.max);
	const removals = policy.removeWorktrees
		? capRemovals([...ageRemovals, ...mergedRemovals], runCap)
		: [];
	const removalKeys = new Set(
		removals.map((removal) => toComparablePath(removal.path)),
	);
	const deferred = [...ageRemovals, ...mergedRemovals].filter(
		(removal) => !removalKeys.has(toComparablePath(removal.path)),
	);

	// --- unregistered `.claude/worktrees/agent-*` directories (#2538) ---
	// Every non-scoped mode runs this pass: the SubagentStop hooks have a
	// mandate over exactly one agent's tree, never over its siblings' leftovers.
	const unregisteredPlan = policy.scopedToAgentTree
		? { remove: [], keep: [] }
		: collectUnregisteredAgentDirs({
				base: path.join(worktreesBase, ".claude", "worktrees"),
				registeredKeys: new Set(
					listed.map((row) => toComparablePath(row.path)),
				),
				selfKeys: new Set(
					[SCRIPT_DIR, process.cwd()]
						.map(
							(entry) =>
								enclosingAgentWorktree(entry) ?? toComparablePath(entry),
						)
						.filter(Boolean),
				),
			});
	const unregisteredRemovals = unregisteredPlan.remove.slice(0, options.max);
	const unregisteredDeferred = unregisteredPlan.remove.slice(options.max);

	const wantProcessScan =
		removals.length > 0 || (options.orphanSweep && policy.orphanSweep);
	const scan = wantProcessScan
		? await readProcessTable({ budgetMs, budgetLeft, scanTimeoutMs })
		: { table: [], listingOk: false, scanBudgetMs: 0, records: [] };
	const degradations = [...scan.records];
	const table = scan.table;
	// A degraded listing costs the two things the TABLE feeds -- the orphan
	// sweep and the "kill whatever is holding this tree" step -- and nothing
	// else. The removals below run regardless: `git worktree remove --force
	// --force` needs no process table, and #2486's ledger (three
	// scan-degraded lines, zero removal lines) is what the opposite looks
	// like. The degradation is on the record as a `hygiene.scan-degraded`
	// line in the SAME run as the removal, which is the readable form of the
	// pair; an extra stderr notice here said the same thing down a channel
	// both hooks discard, and nothing tested it (PR #2493 review round 2, S3).

	const protectedPids = collectAncestorPids(table, process.pid);
	protectedPids.add(process.pid);

	const orphanPlan =
		options.orphanSweep && policy.orphanSweep
			? planOrphanSweep({
					rows: table,
					selfPid: process.pid,
					protectedPids,
					// A SubagentStop run reaps ONLY under the tree of the agent
					// that stopped; it never touches a sibling agent's helpers.
					restrictToPath: agentTree,
					listingOk: scan.listingOk,
					isPidAlive,
				})
			: { orphans: [], degraded: null };
	const orphans = orphanPlan.orphans;
	if (orphanPlan.degraded && orphanPlan.degraded.reason !== "listing-failed") {
		console.error(
			`[hygiene] process snapshot could not be verified ` +
				`(${orphanPlan.degraded.reason}); no orphan sweep this run`,
		);
		degradations.push(
			formatScanRecord({
				reason: orphanPlan.degraded.reason,
				budgetMs,
				remainingMs: budgetLeft(),
				ceilingMs: scan.scanBudgetMs,
				rows: table.length,
			}),
		);
	}

	const perTreeProcesses = new Map();
	for (const removal of removals) {
		perTreeProcesses.set(
			removal.path,
			selectProcessesUnderPath(table, removal.path, { protectedPids }),
		);
	}

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					dryRun: options.dryRun,
					minAgeMs,
					only,
					remove: removals.map((removal) => ({
						...removal,
						processes: (perTreeProcesses.get(removal.path) ?? []).map(
							(row) => ({ pid: row.pid, command: row.command }),
						),
					})),
					deferred: deferred.map((removal) => removal.path),
					keep: plan.keep,
					mergedKeep: mergedPlan.keep,
					unregistered: {
						remove: unregisteredRemovals,
						deferred: unregisteredDeferred,
						keep: unregisteredPlan.keep,
					},
					orphans: orphans.map(({ row, reason }) => ({
						pid: row.pid,
						ppid: row.ppid,
						reason,
						command: row.command,
					})),
					processTableRows: table.length,
				},
				null,
				2,
			),
		);
	} else {
		for (const entry of plan.keep) {
			if (entry.reason === "not-agent-worktree") continue;
			say(
				`keep    ${entry.path}  (${entry.reason}${entry.detail ? `: ${entry.detail}` : ""})`,
			);
		}
		for (const removal of deferred) {
			say(
				policy.removeWorktrees
					? `defer   ${removal.path}  (removal cap ${policy.maxRemovals} per ` +
							`run; the next sweep takes it)`
					: `keep    ${removal.path}  (removal is not permitted in this mode)`,
			);
		}
		for (const removal of removals) {
			const procs = perTreeProcesses.get(removal.path) ?? [];
			say(
				`${options.dryRun ? "WOULD REMOVE" : "remove "} ${removal.path}` +
					`  (age ${Math.round(removal.ageMs / 60_000)}m, branch ${removal.branch ?? "-"}` +
					`${procs.length > 0 ? `, ${procs.length} process(es) to kill` : ""})`,
			);
			for (const row of procs) say(`    pid ${row.pid}  ${row.command}`);
		}
		for (const { row, reason } of orphans) {
			say(
				`${options.dryRun ? "WOULD KILL  " : "kill    "} pid ${row.pid}  ${reason}  ${row.command}`,
			);
		}
	}

	const records = [...degradations];
	/** Full refs of the worktrees this run actually removed (review S10). */
	const removedBranchRefs = [];
	/** Trees actually removed — 0 on a dry run, which the record also says. */
	let removedCount = 0;
	/**
	 * Paths the enrichment pass certified clean but that turned up dirty (or
	 * unreadable) on the immediate pre-remove recheck (review round 3, F1) --
	 * fed into the run-level `keptReason` below so a late write reads exactly
	 * like an enrichment-time one, not `removed: 0` with no stated reason.
	 * Maps to the recheck's OWN `keptReason` spelling (PR #2493 round 5, R2):
	 * `isDirty()`'s tri-state used to be collapsed by `!== "clean"` here, so a
	 * recheck that could not read `git status` at all (a wedged git, the
	 * recheck's own bound) was folded into the same `"dirty"` verdict as one
	 * that genuinely found uncommitted work -- reading a scan that never got
	 * to look as protected work, the exact confusion review round 3, F2
	 * already closed for the ENRICHMENT-time call.
	 * @type {Map<string, "dirty"|"status-unreadable">}
	 */
	const lateDirty = new Map();

	if (!options.dryRun) {
		for (const removal of removals) {
			for (const row of perTreeProcesses.get(removal.path) ?? []) {
				const { killed, error } = await terminatePid(row.pid);
				records.push(
					formatKillRecord({
						pid: row.pid,
						command: row.command,
						reason: "process holding a removable agent worktree",
						worktree: removal.path,
						killed,
						error,
						nowIso,
					}),
				);
			}
			// The enrichment `isDirty()` call and this removal are separated by
			// two awaits above -- `readProcessTable` and one `terminatePid` per
			// process the tree held, each with its own fixed grace period -- and
			// either one gives a live process room to write into a tree
			// enrichment already certified clean. A check-then-act split by
			// awaits with a kill in the gap (review round 3, F1): re-running the
			// SAME check immediately before the one operation that actually
			// destroys anything closes it, rather than trusting a verdict that
			// can be a second or more stale by the time it is acted on.
			//
			// Deliberately BEFORE `unlinkTopLevelLinks` (PR #2493 round 4, N1):
			// the unlink is a one-way, silent (goes through `say()`, suppressed
			// under `--quiet`) mutation of a tree this branch might still decide
			// to KEEP. Unlinking first meant a tree kept for "became dirty" had
			// already lost its shared `node_modules` junction with no record of
			// it anywhere a `--quiet` hook run would surface -- kept in the
			// ledger, broken on disk. Re-checking first means nothing touches the
			// tree until this branch has committed to removing it. The recheck
			// also uses its OWN small bound (`recheckBound`), not `removeBound`:
			// see `recheckBoundMs` for why a second removeBound-sized call here
			// blew the hook-timeout invariant (round 4, N3).
			const recheckState = isDirty(removal.path, recheckBound);
			if (recheckState !== "clean") {
				// PR #2493 round 5, R2: the recheck's tri-state used to be
				// collapsed by `!== "clean"` straight into a single "became dirty"
				// verdict, so a recheck bound too tight to even ask (or a wedged
				// git) read on the ledger exactly like a genuine late write --
				// the same "a scan that never got to look" confusion review
				// round 3, F2 already closed for the ENRICHMENT-time call, now
				// closed here too.
				const unreadable = recheckState === "unreadable";
				console.error(
					`[hygiene] ${removal.path} ${
						unreadable
							? "could not be re-checked before removal"
							: "became dirty after enrichment"
					}; skipping removal`,
				);
				// Keyed by `toComparablePath`, not the raw string: `removal.path`
				// comes from `git worktree list` (forward slashes) while the run's
				// `targetPath` is `--only`'s argv verbatim (backslashes on
				// Windows) -- a raw-string `Map.has` below would silently miss
				// every match and report `keptReason: null` for a run that DID
				// catch a late write (the same path-key invariant this repo
				// already learned the hard way for the read-guard's maps).
				lateDirty.set(
					toComparablePath(removal.path),
					unreadable ? "status-unreadable" : "dirty",
				);
				records.push(
					formatWorktreeRecord({
						path: removal.path,
						branch: removal.branch,
						ageMs: removal.ageMs,
						removed: false,
						error: unreadable
							? "recheck could not read git status before removal"
							: "became dirty between enrichment and removal",
						nowIso,
					}),
				);
				continue;
			}
			// Only reached once removal has been committed to: unlink the
			// shared node_modules junction before `git worktree remove` walks the
			// tree recursively (a recursive delete that followed the reparse
			// point would wipe the SHARED node_modules).
			const unlinked = unlinkTopLevelLinks(removal.path);
			for (const link of unlinked) say(`    unlinked reparse point ${link}`);
			// A locked worktree needs --force twice; passing it unconditionally
			// is harmless for the unlocked case.
			// Outside the SWEEP budget, but not unbounded: `git()` applies
			// `removeBound` with killSignal SIGKILL, so a wedged removal is
			// eventually killed rather than hanging the hook forever (review
			// round 3, F7 — the comment here used to claim otherwise). The
			// bound is the SAME number `hookBudgetMs` reserved out of the hook
			// timeout (`removeBoundMs`), so the invariant
			// `budget + recheck + removal + margin <= timeout` is enforced
			// rather than merely asserted: 60s inside SessionStart's 90s, 5s
			// inside SubagentStop's 15s against a measured 1049ms median.
			// SIGKILLing
			// git partway through a recursive delete leaves a half-removed
			// worktree plus a stale admin directory, so each bound is set well
			// above its measured cost and only ever fires on a wedged git. The
			// sweep's own enrichment budget gates whether a removal STARTS,
			// never how long it may take once it has.
			const removed = git(
				["worktree", "remove", "--force", "--force", removal.path],
				REPO_ROOT,
				removeBound,
			);
			if (removed === null) {
				console.error(`[hygiene] could not remove ${removal.path}`);
			} else {
				removedCount++;
				if (removal.branch) removedBranchRefs.push(removal.branch);
			}
			records.push(
				formatWorktreeRecord({
					path: removal.path,
					branch: removal.branch,
					ageMs: removal.ageMs,
					removed: removed !== null,
					error: removed === null ? "git worktree remove failed" : null,
					nowIso,
				}),
			);
		}
		if (removals.length > 0) git(["worktree", "prune"], REPO_ROOT, removeBound);

		for (const { row, reason } of orphans) {
			const { killed, error } = await terminatePid(row.pid);
			records.push(
				formatKillRecord({
					pid: row.pid,
					command: row.command,
					reason,
					worktree: null,
					killed,
					error,
					nowIso,
				}),
			);
		}

		// Only after a removal, and only for the branch that removal orphaned
		// (review S10). A sweep that removed nothing deletes nothing.
		if (policy.deleteBranches && removedBranchRefs.length > 0) {
			for (const branch of deleteStaleBranches(gitBudget, removedBranchRefs)) {
				say(`deleted branch ${branch}`);
			}
		}
	} else {
		for (const removal of removals) {
			for (const row of perTreeProcesses.get(removal.path) ?? []) {
				records.push(
					formatKillRecord({
						pid: row.pid,
						command: row.command,
						reason: "process holding a removable agent worktree",
						worktree: removal.path,
						dryRun: true,
						nowIso,
					}),
				);
			}
			records.push(
				formatWorktreeRecord({
					path: removal.path,
					branch: removal.branch,
					ageMs: removal.ageMs,
					dryRun: true,
					nowIso,
				}),
			);
		}
		for (const { row, reason } of orphans) {
			records.push(
				formatKillRecord({
					pid: row.pid,
					command: row.command,
					reason,
					dryRun: true,
					nowIso,
				}),
			);
		}
	}

	// One record per invocation, whatever happened (#2486): the hooks run
	// --quiet and their stderr is discarded, so an unrecorded run and a hook
	// that never fired are the same observation.
	//
	// And when the run had exactly ONE tree in scope and did not remove it,
	// the record says WHY (PR #2493 review round 2, S2). `fired, removed: 0`
	// alone cannot tell "the tree was dirty, so work was protected" from "the
	// hook reaped nothing and nobody knows why", which is the same
	// indistinguishable-absence shape #2486 was about one level up.
	const targetPath = only?.length === 1 ? only[0] : null;
	const targetKey = targetPath ? toComparablePath(targetPath) : null;
	// The run's one tree can be on disk (fs.existsSync passed the
	// scopedToAgentTree check) and still be nothing `git worktree list`
	// knows about -- a half-removed tree from an earlier interrupted removal
	// plus `git worktree prune`, which drops the ADMIN registration but can
	// leave the working directory behind (review round 3, F3). That tree
	// never appears in `candidates`, so it is in neither `plan.keep` nor
	// `deferred`, and `keptReasonFor` reads that absence as "removed" rather
	// than "not ours to remove".
	const targetRegistered =
		!targetKey ||
		candidates.some((c) => toComparablePath(c.path) === targetKey);
	const keptReason =
		targetKey && lateDirty.has(targetKey)
			? lateDirty.get(targetKey)
			: targetPath && !targetRegistered && removedCount === 0
				? "not-a-worktree"
				: keptReasonFor({ targetPath, plan, deferred, policy });
	records.push(
		formatRunRecord({
			hook: options.hook,
			outcome: "fired",
			worktree: targetPath,
			keptReason,
			removed: removedCount,
			orphans: orphans.length,
			rows: table.length,
			dryRun: options.dryRun,
			budgetMs,
			durationMs: Date.now() - startedAt,
			nowIso,
		}),
	);
	appendLedger(records);

	if (!options.json) {
		say(
			`${options.dryRun ? "dry-run: " : ""}${removals.length} worktree(s), ` +
				`${orphans.length} orphan process(es)` +
				`${deferred.length > 0 ? `, ${deferred.length} deferred to the next sweep` : ""}` +
				`${skippedForBudget > 0 ? `, ${skippedForBudget} not evaluated (budget ${budgetMs}ms)` : ""}` +
				`, ${table.length} process rows, ${Date.now() - startedAt}ms`,
		);
	}
}

/**
 * Delete the agent-session branches left behind by the worktrees this run
 * just removed. Runs after removal so `checkedOut` reflects the post-removal
 * reality, and is never called with an empty `removedBranchRefs` — the whole
 * candidate set is scoped to those refs (review S10), so a sweep can no
 * longer reach a live agent's branch just because its shape matches.
 *
 * @param {() => number} gitBudget
 * @param {string[]} removedBranchRefs
 * @returns {string[]}
 */
function deleteStaleBranches(gitBudget, removedBranchRefs) {
	const out = git(
		[
			"for-each-ref",
			"--format=%(refname:short)\t%(upstream)\t%(upstream:track)",
			"refs/heads",
		],
		REPO_ROOT,
		gitBudget(),
	);
	if (out === null) return [];
	const checkedOut = new Set(
		parseWorktreeList(
			git(["worktree", "list", "--porcelain"], REPO_ROOT, gitBudget()) ?? "",
		)
			.map((row) => row.branch)
			.filter(Boolean)
			.map((ref) => String(ref).replace(/^refs\/heads\//, "")),
	);
	const wanted = new Set(
		removedBranchRefs
			.filter((ref) => typeof ref === "string" && ref !== "")
			.map((ref) => ref.replace(/^refs\/heads\//, "")),
	);
	// Three passes on purpose: scope to the branches this run orphaned, then
	// the cheap shape/upstream/checked-out filter (one for-each-ref line each,
	// no subprocess), then the containment revwalk ONLY for survivors.
	const candidates = [];
	for (const line of out.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [name, upstream, track] = line.split("\t");
		if (!name || !wanted.has(name)) continue;
		const branch = {
			name,
			hasUpstream: Boolean(upstream),
			upstreamGone: (track ?? "").includes("gone"),
			checkedOut: checkedOut.has(name),
		};
		if (isAgentBranchCandidate(branch)) candidates.push(branch);
	}
	const branches = candidates.map((branch) => ({
		...branch,
		containedInOrigin: isContainedInOrigin(branch.name, REPO_ROOT, gitBudget()),
	}));
	const deleted = [];
	for (const name of planBranchDeletions({ branches, removedBranchRefs })) {
		if (git(["branch", "-D", name], REPO_ROOT, gitBudget()) !== null) {
			deleted.push(name);
		}
	}
	return deleted;
}

// Only run the CLI when this file is the entry point — not when a test
// imports parseArgs/worktreeActivityMs. Mirrors with-test-lock.mjs's own
// isEntryPoint, win32 case-insensitive fallback included (a differently-cased
// invocation path still resolves to this file on NTFS).
function isEntryPoint() {
	if (!process.argv[1]) return false;
	const invoked = path.resolve(process.argv[1]);
	if (invoked === SELF_FILE) return true;
	if (!isWindows) return false;
	return invoked.toLowerCase() === SELF_FILE.toLowerCase();
}

if (isEntryPoint()) {
	main(process.argv.slice(2))
		.catch((error) => {
			// Exit code stays 0 on purpose: this runs from Claude Code hooks,
			// and a hygiene failure must never fail a session.
			console.error(
				`[hygiene] ${error instanceof Error ? (error.stack ?? error.message) : error}`,
			);
		})
		.finally(() => {
			process.exitCode = 0;
		});
}
