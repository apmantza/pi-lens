/**
 * scripts/lib/worktree-hygiene.mjs (#2435)
 *
 * PURE decision logic for scripts/prune-agent-worktrees.mjs: which agent
 * worktrees may be removed, which processes may be killed, and how the kill
 * ledger stays bounded. Split from the CLI (which owns `git worktree list`,
 * the Windows CIM / POSIX `ps` process listing, and the actual
 * `process.kill`) for the same reason scripts/lib/process-scan.mjs was split
 * from compat-smoke-behavioral.mjs: the risky part is the DECISION, and a
 * decision is only testable if it is a function of a table rather than of
 * the machine. Every test in tests/scripts/worktree-hygiene.test.ts feeds a
 * synthetic worktree/process table here; nothing in this file can kill or
 * delete anything.
 *
 * Safety posture -- the rails are the contract (#2435 acceptance criteria):
 *   - A DIRTY worktree is never removed. No flag overrides this.
 *   - A worktree whose HEAD is not contained in any `origin/*` ref is never
 *     removed (unpushed work is unrecoverable once the tree is gone). No
 *     flag overrides this.
 *   - A worktree younger than `minAgeMs` is kept, and a worktree whose git
 *     lock record names a LIVE pid is kept -- both overridable ONLY by
 *     `--only`, which is how the SubagentStop hook names the one tree whose
 *     agent just finished. `--only` never overrides dirty/unpushed.
 *   - Kills are by pid, only for processes matched to a removable worktree
 *     path or to a `tests/fixtures/*` / `tests/support/*` helper, and never
 *     for this process or any of its ancestors.
 *   - A fixture helper whose PARENT IS STILL ALIVE is never killed -- that is
 *     a running test, not a leak.
 *
 * On the git lock record: Claude Code locks each agent worktree with a
 * reason like `claude agent agent-<id> (pid <pid>)`, where the pid is the
 * TOP-LEVEL Claude Code process shared by every agent in that session -- not
 * the individual agent. So a live lock pid means "this Claude Code session
 * is still running", which is the right default keep signal for a
 * SessionStart sweep (it protects sibling agents' trees) and exactly the
 * wrong one for SubagentStop (the session is alive by definition there).
 * Hence: keep by default, `--only` overrides.
 */

import path from "node:path";

/** Default minimum worktree age before an unnamed tree is eligible (30m). */
export const DEFAULT_MIN_AGE_MS = 30 * 60_000;

/**
 * Filesystem signals admissible as "someone touched this worktree", and the
 * ones that are BANNED from that answer. Values rather than prose, so the
 * ban is something a test can read.
 *
 * PR #2438 review round 3 (F1) -- the defect that made the whole sweep inert.
 * `worktreeActivityMs` took the max over four signals, two of which the
 * sweep's OWN inspection writes: `git status --porcelain` (how `isDirty`
 * answers the dirty rail) rewrites `<admin>/index` and therefore bumps both
 * that file and the admin DIRECTORY holding it. Every candidate came back
 * `age 0ms`, `too-young` rejected all of them, and nothing was ever removed.
 * Measured on the #2435 box (git 2.55.0.windows.3) with a throwaway worktree
 * whose four signals were all backdated to now-3h:
 *
 *   signal           before git status   after git status
 *   checkout dir     age 10800s          age 10800s   unchanged
 *   adminDir         age 10800s          age     0s   BUMPED
 *   adminDir/HEAD    age 10800s          age 10800s   unchanged
 *   adminDir/index   age 10800s          age     0s   BUMPED
 *
 * So the admissible set is the two proven-unchanged signals plus the HEAD
 * reflog's last ENTRY timestamp: git appends to `<admin>/logs/HEAD` only
 * when HEAD actually moves (checkout, commit, reset), and the same probe
 * confirmed `git status --porcelain` changes neither its size nor its mtime.
 * The reflog is the one signal that survives a tool copying or re-touching
 * the checkout directory, which is why it is worth reading a file for.
 */
export const WORKTREE_ACTIVITY_SIGNALS = Object.freeze([
	"checkout",
	"head",
	"reflog",
]);

/**
 * Signals that must never contribute to worktree activity, because the sweep
 * writes them while inspecting. Re-admitting either one re-creates the
 * inert-sweep defect above, so it is pinned as a value.
 */
export const WORKTREE_ACTIVITY_BANNED_SIGNALS = Object.freeze([
	"admin",
	"index",
]);

/**
 * Newest admissible activity timestamp for one worktree, in epoch ms.
 *
 * Reads ONLY the keys named in `WORKTREE_ACTIVITY_SIGNALS`; any other key on
 * the input -- notably `admin` and `index` -- is ignored no matter how recent
 * it is. Pure, so the rail is provable without a git repo.
 *
 * An empty answer means every signal was unreadable, and 0 ("infinitely
 * old") is the WRONG default for a rail guarding a destructive step, so an
 * unreadable tree reports `nowMs`: too young, therefore kept.
 *
 * @param {Record<string, number|null|undefined>|null|undefined} signals
 * @param {number} nowMs
 * @returns {number}
 */
export function worktreeActivityFromSignals(signals, nowMs) {
	let newest = 0;
	for (const name of WORKTREE_ACTIVITY_SIGNALS) {
		const value = signals?.[name];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			newest = Math.max(newest, value);
		}
	}
	return newest === 0 ? nowMs : newest;
}

/**
 * Epoch-ms timestamp of the LAST entry in a git reflog file, or null when the
 * text holds no parseable entry.
 *
 * The line shape is pinned against real output from git 2.55.0.windows.3
 * rather than from the format's description -- the first entry of a fresh
 * worktree's `logs/HEAD` carries NO tab and NO message, which a
 * message-requiring parser silently drops:
 *
 *   "0000...0000 9de0...3bdd Probe Person <p@example.com> 1788351065 +0300\n"
 *   "9de0...3bdd 9de0...3bdd Probe Person <p@example.com> 1788351065 +0300\treset: moving to HEAD\n"
 *
 * So: split the message off at the first tab, then read the trailing
 * `<unix-seconds> <±hhmm>` pair off what remains. The committer name is free
 * text and may contain anything, which is why this anchors on the END of the
 * header rather than trying to tokenize the middle.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseReflogLastEntryMs(text) {
	const lines = String(text ?? "").split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index];
		if (!line || !line.trim()) continue;
		const header = line.split("\t", 1)[0];
		const match = /\s(\d{1,15})\s[+-]\d{4}\s*$/.exec(header);
		if (!match) continue;
		const seconds = Number(match[1]);
		if (!Number.isFinite(seconds) || seconds <= 0) continue;
		return seconds * 1000;
	}
	return null;
}

/** Max records retained in the hygiene ledger (bounded telemetry). */
export const DEFAULT_LOG_MAX_LINES = 500;

/** Max characters of a command line recorded in a kill record. */
export const MAX_RECORDED_COMMAND_CHARS = 300;

/**
 * Path segment that identifies a Claude Code agent worktree. Matched against
 * a separator-normalized path, so `\` and `/` spellings both hit.
 */
export const AGENT_WORKTREE_SEGMENT = "/.claude/worktrees/agent-";

/**
 * Command-line markers for long-running test helpers that may outlive their
 * runner. `tests/fixtures/` and `tests/support/` are the two directories the
 * repo spawns helper processes from; `fake-lsp-server.mjs` (#1660) is the
 * one observed leaker (#2435 evidence) and is listed explicitly so a grep
 * for it lands here. Matching is on the DIRECTORY path, not on "node", so an
 * unrelated node process is never a candidate.
 */
export const FIXTURE_HELPER_MARKERS = [
	"tests/fixtures/",
	"tests/support/",
	"fake-lsp-server.mjs",
];

/**
 * Normalize a filesystem path for comparison: absolute, forward slashes,
 * lowercased, no trailing separator. Case-folding is unconditional rather
 * than win32-only because these strings are also compared against command
 * lines captured from a process table, where the casing of a path fragment
 * is not under our control on any OS. Mirrors the read-guard path-key
 * invariant (one normalizer, never raw keys -- #210).
 *
 * BOTH separators are folded, on BOTH platforms, and folded BEFORE
 * `path.resolve` (PR #2438 review S6). Splitting on `path.sep` folded only
 * the host's own separator, so on POSIX a Windows-spelled path kept its
 * backslashes and compared unequal to the same path spelled with slashes --
 * five CI failures on Linux that could not reproduce on the win32 box this
 * was written on. Folding must precede `resolve` because `path.resolve` on
 * POSIX treats `\tmp\x` as a RELATIVE path and prefixes the cwd; folding
 * first makes it the absolute `/tmp/x` it means. The cost is that a POSIX
 * filename containing a literal backslash is normalized as a separator --
 * accepted deliberately: these keys are compared against process command
 * lines, where the same fold already had to happen (toComparableText).
 *
 * @param {string} p
 * @returns {string}
 */
export function toComparablePath(p) {
	if (typeof p !== "string" || p.length === 0) return "";
	return path
		.resolve(p.replace(/\\/g, "/"))
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.toLowerCase();
}

/**
 * Same normalization for a string that is NOT a path (a command line): only
 * separator + case folding, no `path.resolve`, so an embedded absolute path
 * fragment still compares equal to a normalized worktree path.
 *
 * @param {string} text
 * @returns {string}
 */
export function toComparableText(text) {
	if (typeof text !== "string") return "";
	return text.split("\\").join("/").toLowerCase();
}

/**
 * True iff `p` is (or is inside) a `.claude/worktrees/agent-*` directory.
 *
 * @param {string} p
 * @returns {boolean}
 */
export function isAgentWorktreePath(p) {
	return toComparablePath(p).includes(AGENT_WORKTREE_SEGMENT);
}

/**
 * The `.claude/worktrees/agent-<id>` directory that ENCLOSES `p`, as a
 * comparable key, or null when `p` is not inside one.
 *
 * PR #2438 review S4: the self rail used to be exact equality against
 * `[SCRIPT_DIR, process.cwd()]`. SCRIPT_DIR is `<worktree>/scripts` and cwd
 * is wherever the agent happened to invoke from -- NEITHER is ever the
 * worktree root, so the rail that stops the sweep deleting the tree it is
 * running inside never fired at all. Containment is the correct test, and it
 * is a prefix walk to the first separator AFTER the `agent-` segment so a
 * sibling (`agent-abc2`) resolves to itself rather than to `agent-abc`.
 *
 * PR #2438 review round 3 (F3): the walk starts at the LAST occurrence of the
 * segment, not the first. An agent that cuts a worktree from inside another
 * agent's tree produces a NESTED path -- `<outer agent tree>/.claude/
 * worktrees/agent-<inner>/scripts` -- and `indexOf` resolved that to the
 * OUTER tree. The self rail then protected a tree the sweep was not running
 * in and left the one it WAS running in eligible. The enclosing worktree of
 * a nested path is always the innermost one.
 *
 * @param {string} p
 * @returns {string|null}
 */
export function enclosingAgentWorktree(p) {
	const key = toComparablePath(p);
	if (!key) return null;
	const at = key.lastIndexOf(AGENT_WORKTREE_SEGMENT);
	if (at === -1) return null;
	const afterSegment = at + AGENT_WORKTREE_SEGMENT.length;
	const nextSeparator = key.indexOf("/", afterSegment);
	return nextSeparator === -1 ? key : key.slice(0, nextSeparator);
}

/**
 * Parse `git worktree list --porcelain` output into rows. Blocks are
 * blank-line separated; unknown attribute lines are ignored rather than
 * throwing, so a future git attribute cannot break the sweep.
 *
 * @param {string} porcelain
 * @returns {{ path: string, head: string|null, branch: string|null, detached: boolean, bare: boolean, locked: boolean, lockedReason: string|null, prunable: boolean }[]}
 */
export function parseWorktreeList(porcelain) {
	const rows = [];
	let current = null;
	const flush = () => {
		if (current) rows.push(current);
		current = null;
	};
	for (const rawLine of String(porcelain ?? "").split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (line === "") {
			flush();
			continue;
		}
		const space = line.indexOf(" ");
		const key = space === -1 ? line : line.slice(0, space);
		const value = space === -1 ? "" : line.slice(space + 1);
		if (key === "worktree") {
			flush();
			current = {
				path: value,
				head: null,
				branch: null,
				detached: false,
				bare: false,
				locked: false,
				lockedReason: null,
				prunable: false,
			};
			continue;
		}
		if (!current) continue;
		if (key === "HEAD") current.head = value || null;
		else if (key === "branch") current.branch = value || null;
		else if (key === "detached") current.detached = true;
		else if (key === "bare") current.bare = true;
		else if (key === "locked") {
			current.locked = true;
			current.lockedReason = value || null;
		} else if (key === "prunable") current.prunable = true;
	}
	flush();
	return rows;
}

/**
 * Extract the pid from a git worktree lock reason such as
 * `claude agent agent-abc (pid 55260)`. Returns null when the reason carries
 * no pid -- which is treated as "no live-owner evidence", NOT as "alive".
 *
 * @param {string|null|undefined} lockedReason
 * @returns {number|null}
 */
export function parseLockPid(lockedReason) {
	if (typeof lockedReason !== "string") return null;
	const match = /\bpid[\s:=]+(\d+)/i.exec(lockedReason);
	if (!match) return null;
	const pid = Number(match[1]);
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Parse a duration: bare digits are milliseconds; `ms`/`s`/`m`/`h` suffixes
 * scale. Returns null for anything unparseable so the caller can reject it
 * loudly instead of silently defaulting (a mis-typed `--min-age` that
 * quietly became 0 would disable the age rail).
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseDuration(text) {
	const trimmed = String(text ?? "")
		.trim()
		.toLowerCase();
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(trimmed);
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value < 0) return null;
	const unit = match[2] ?? "ms";
	const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
	return Math.round(value * scale);
}

/**
 * @typedef {object} WorktreeCandidate
 * @property {string} path            Absolute worktree path.
 * @property {string|null} [head]     HEAD sha.
 * @property {string|null} [branch]   Full ref (`refs/heads/...`) or null.
 * @property {boolean} dirty          `git status --porcelain` was non-empty,
 *   OR could not be read at all (see `dirtyUnreadable`).
 * @property {boolean} [dirtyUnreadable] True when `dirty` is true because the
 *   `git status` call itself failed or timed out, rather than because it
 *   returned a genuine non-empty porcelain output (review round 3, F2). Both
 *   still refuse removal; this only changes which `keptReason` the ledger
 *   records (`status-unreadable` vs `dirty`).
 * @property {boolean} pushed         HEAD is contained in some `origin/*` ref.
 * @property {number} mtimeMs         Newest observed activity timestamp.
 * @property {boolean} [locked]
 * @property {number|null} [lockPid]
 * @property {boolean} [unevaluated]  The caller ran out of time budget before
 *   it could read this tree's dirty/pushed state. Never removable: an
 *   unanswered safety question is a NO, and the next sweep tries again.
 */

/**
 * Decide, for a table of worktree candidates, which may be removed.
 *
 * Rails are evaluated in a fixed order and the FIRST one that fires wins, so
 * a keep reason is always the single most important reason -- that is what
 * the dry-run prints and what the tests assert against.
 *
 * @param {object} options
 * @param {WorktreeCandidate[]} options.worktrees
 * @param {number} options.nowMs
 * @param {number} [options.minAgeMs]
 * @param {string[]|null} [options.only]   Explicit paths; null = sweep all.
 * @param {string|string[]|null} [options.selfPath] Worktree(s) this process
 *   lives in — its own file location AND its cwd can sit in different trees,
 *   and neither may ever be removed out from under a running sweep.
 * @param {(pid: number) => boolean} [options.isPidAlive]
 * @returns {{ remove: { path: string, branch: string|null, ageMs: number, locked: boolean, selected: boolean }[], keep: { path: string, reason: string, detail: string|null }[] }}
 */
export function planWorktreePrune({
	worktrees,
	nowMs,
	minAgeMs = DEFAULT_MIN_AGE_MS,
	only = null,
	selfPath = null,
	isPidAlive = () => false,
}) {
	const selectedKeys = only ? new Set(only.map(toComparablePath)) : null;
	// By CONTAINMENT, not equality (review S4): the caller's "where am I"
	// paths are a `scripts/` directory and a cwd, never a worktree root.
	// Anything outside every agent worktree falls back to its own key, which
	// simply never matches an agent tree -- harmless, and it keeps a caller
	// that already passes a root working.
	const selfKeys = new Set(
		(Array.isArray(selfPath) ? selfPath : selfPath ? [selfPath] : [])
			.map((entry) => enclosingAgentWorktree(entry) ?? toComparablePath(entry))
			.filter(Boolean),
	);
	const remove = [];
	const keep = [];

	for (const row of worktrees ?? []) {
		const key = toComparablePath(row.path);
		// Clamped at 0: a tree another agent is actively writing can carry an
		// mtime a few ms in the future relative to the snapshot `nowMs`, and a
		// negative age in a "too-young" message reads as a bug.
		const ageMs = Math.max(0, nowMs - (Number(row.mtimeMs) || 0));
		const selected = selectedKeys ? selectedKeys.has(key) : false;
		const push = (reason, detail = null) =>
			keep.push({ path: row.path, reason, detail });

		if (!isAgentWorktreePath(row.path)) {
			push("not-agent-worktree");
			continue;
		}
		if (selfKeys.has(key)) {
			push("self", "this sweep is running inside it");
			continue;
		}
		if (selectedKeys && !selected) {
			push("not-selected", "--only named other trees");
			continue;
		}
		if (row.unevaluated) {
			push("not-evaluated", "time budget exhausted before this tree was read");
			continue;
		}
		// Hard rails: no flag, --only included, overrides these two.
		if (row.dirty) {
			// `dirtyUnreadable` (review round 3, F2) marks the sub-case where
			// `git status` itself could not be read -- a wedged git, a budget
			// too tight -- rather than a genuine non-empty porcelain output.
			// Both refuse removal identically; the ledger's reason differs so
			// an operator can tell "work was protected" from "the scan never
			// got to look".
			push(
				row.dirtyUnreadable ? "status-unreadable" : "dirty",
				row.dirtyUnreadable
					? "git status could not be read before the removal decision"
					: "uncommitted changes would be destroyed",
			);
			continue;
		}
		if (!row.pushed) {
			push("unpushed", "HEAD is not contained in any origin/* ref");
			continue;
		}
		// Soft rails: --only (SubagentStop naming the finished agent's tree)
		// overrides both.
		const lockPid = row.lockPid ?? null;
		if (!selected && row.locked && lockPid !== null && isPidAlive(lockPid)) {
			push("locked-live", `git lock names live pid ${lockPid}`);
			continue;
		}
		if (!selected && ageMs < minAgeMs) {
			push("too-young", `age ${ageMs}ms < min ${minAgeMs}ms`);
			continue;
		}
		remove.push({
			path: row.path,
			branch: row.branch ?? null,
			ageMs,
			locked: Boolean(row.locked),
			selected,
		});
	}

	return { remove, keep };
}

/**
 * Order candidates so anything `only` names is inspected FIRST. The caller
 * enriches trees under a wall-clock budget (a hook has ~2s), and a
 * SubagentStop sweep has exactly one tree it cares about — it must never
 * lose its budget to unrelated siblings that happened to sort earlier.
 * Stable, so relative order within each group is preserved.
 *
 * @template {{ path: string }} T
 * @param {T[]} rows
 * @param {string[]|null} only
 * @returns {T[]}
 */
export function orderBySelection(rows, only) {
	const list = [...(rows ?? [])];
	if (!only || only.length === 0) return list;
	const selectedKeys = new Set(only.map(toComparablePath));
	const rank = (row) => (selectedKeys.has(toComparablePath(row.path)) ? 0 : 1);
	return list.sort((a, b) => rank(a) - rank(b));
}

/**
 * Runtimes that can be launched with a fixture script as their argument.
 * Anything else (a shell, an editor, a grep) is never a fixture helper no
 * matter what its command line mentions.
 */
const SCRIPT_RUNTIMES = new Set(["node", "bun", "deno", "npx", "tsx"]);

/** `-e "code"` / `--eval` / `-p` / `--print`: a code string, not a script. */
const INLINE_CODE_FLAG_RE = /(?:^|\s)(?:-e|-p|--eval|--print)(?:\s|=|$)/;

/**
 * Split a command line into argv-ish tokens, honoring one level of double
 * quoting (`"C:\Program Files\nodejs\node.exe" -e ...`). Not a shell parser
 * -- it only has to answer "which token is the executable, and which is the
 * script it runs", which is all any caller here asks.
 *
 * @param {string} normalizedCommand Output of toComparableText.
 * @returns {string[]}
 */
function tokenizeCommand(normalizedCommand) {
	const tokens = [];
	const pattern = /"([^"]*)"|(\S+)/g;
	let match = pattern.exec(normalizedCommand);
	while (match !== null) {
		tokens.push(match[1] ?? match[2]);
		match = pattern.exec(normalizedCommand);
	}
	return tokens;
}

/**
 * The executable of a command line: the first token, lowercased, basename
 * only, `.exe`/`.cmd`/`.bat` stripped.
 *
 * @param {string} normalizedCommand Output of toComparableText.
 * @returns {string}
 */
function commandExecutable(normalizedCommand) {
	const token = tokenizeCommand(normalizedCommand)[0] ?? "";
	const base = token.split("/").pop() ?? "";
	return base.replace(/\.(exe|cmd|bat)$/, "");
}

/** An already-normalized token that names an absolute path. */
function isAbsoluteToken(token) {
	return token.startsWith("/") || /^[a-z]:\//.test(token);
}

/**
 * The paths this process is EXECUTING, as opposed to merely mentioning:
 * its own executable, plus -- when that executable is a script runtime --
 * the script it was handed. Nothing else.
 *
 * PR #2438 review S7. The previous rule was a bare `command.includes(needle)`,
 * which authorizes a kill on any process that so much as NAMES the worktree:
 * `rg --files <wt>`, an editor holding `<wt>/README.md`, a PowerShell
 * `Get-ChildItem <wt>`, and -- worst -- a live sibling worktree
 * `<wt>EXTRA/...`, whose path merely starts with the target's. Every one of
 * those is a reader, not an occupant. Same defect shape as the fixture
 * predicate two functions up (catalog: substring matching used to authorize
 * a destructive action); the fix is the same, a positive structural signal.
 *
 * @param {string} command
 * @returns {string[]} absolute, normalized path tokens
 */
export function commandExecutionPaths(command) {
	const normalized = toComparableText(command);
	if (!normalized) return [];
	const tokens = tokenizeCommand(normalized);
	if (tokens.length === 0) return [];
	const paths = [];
	if (isAbsoluteToken(tokens[0])) paths.push(tokens[0]);
	// Only a script RUNTIME executes a path taken from its argument list. For
	// anything else -- a search tool, an editor, a shell -- a path in argv is
	// DATA being read, and killing on it reaps a reader of the tree.
	if (
		SCRIPT_RUNTIMES.has(commandExecutable(normalized)) &&
		!INLINE_CODE_FLAG_RE.test(normalized)
	) {
		const script = tokens.slice(1).find((token) => !token.startsWith("-"));
		if (script && isAbsoluteToken(script)) paths.push(script);
	}
	return paths;
}

/**
 * True iff a command line names a long-running test helper we are willing to
 * reap. THREE conditions, and the last two exist because a plain substring
 * match is dangerous: it is satisfied by any process that merely MENTIONS
 * the path. Both false positives below were observed live on the #2435 box
 * while validating this sweep —
 *   - `pwsh.exe -Command "... -like \"*fake-lsp-server*\" ..."`, i.e. the
 *     process-table QUERY looking for the leak, and
 *   - `node.exe -e "const c=spawn(...,['.../tests/fixtures/...'])"`, i.e. a
 *     supervisor that merely references the fixture,
 * and either would have been killed by a bare `includes()`. So:
 *   1. the command must reference a `tests/fixtures/` or `tests/support/`
 *      path (or the known `fake-lsp-server.mjs` module);
 *   2. its executable must be a script RUNTIME (node/bun/deno/...), never a
 *      shell, an editor or a search tool;
 *   3. it must not be an inline-code invocation (`-e` / `--eval` / `-p`),
 *      which references a path inside a string rather than running it.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isFixtureHelperCommand(command) {
	const normalized = toComparableText(command);
	if (!normalized) return false;
	const mentionsFixture = FIXTURE_HELPER_MARKERS.some((marker) =>
		normalized.includes(marker.toLowerCase()),
	);
	if (!mentionsFixture) return false;
	if (!SCRIPT_RUNTIMES.has(commandExecutable(normalized))) return false;
	return !INLINE_CODE_FLAG_RE.test(normalized);
}

/**
 * @typedef {{ pid: number, ppid?: number, command: string, cwd?: string }} ProcRow
 */

/**
 * Walk the ppid chain up from `startPid` and return every ancestor pid found
 * in the snapshot (excluding `startPid` itself). Cycle-safe. Used to build
 * the never-kill set: reaping our own parent (the hook runner, the shell,
 * the Claude Code process) would take the session down with it.
 *
 * @param {ProcRow[]} rows
 * @param {number} startPid
 * @returns {Set<number>}
 */
export function collectAncestorPids(rows, startPid) {
	const byPid = new Map();
	for (const row of rows ?? []) byPid.set(row.pid, row);
	const ancestors = new Set();
	let cursor = byPid.get(startPid);
	while (cursor && typeof cursor.ppid === "number" && cursor.ppid > 0) {
		if (ancestors.has(cursor.ppid)) break;
		ancestors.add(cursor.ppid);
		cursor = byPid.get(cursor.ppid);
	}
	ancestors.delete(startPid);
	return ancestors;
}

/**
 * A concurrently running copy of the sweep itself. Never a kill candidate:
 * a sibling hygiene run names the very worktree it is removing on its own
 * command line, and killing it mid-`git worktree remove` would leave the
 * worktree admin directory half-deleted.
 */
const SELF_COMMAND_MARKER = "prune-agent-worktrees";

/**
 * True iff an already-normalized absolute path key is at or under `needle`.
 * Boundary-guarded, so `<needle>2` is never "under" `<needle>`.
 */
function isUnder(key, needle) {
	return key === needle || key.startsWith(`${needle}/`);
}

/**
 * Processes OCCUPYING `targetPath`: their cwd is inside it, or the thing
 * they are executing lives inside it. Used only for worktrees the plan has
 * ALREADY cleared for removal (clean + pushed + eligible).
 *
 * A mention of the path anywhere else on the command line is deliberately
 * NOT a signal -- see commandExecutionPaths for the four live false
 * positives that motivated it (review S7).
 *
 * @param {ProcRow[]} rows
 * @param {string} targetPath
 * @param {{ protectedPids?: Set<number> }} [options]
 * @returns {ProcRow[]}
 */
export function selectProcessesUnderPath(rows, targetPath, options = {}) {
	const needle = toComparablePath(targetPath);
	if (!needle) return [];
	const protectedPids = options.protectedPids ?? new Set();
	return (rows ?? []).filter((row) => {
		if (!Number.isInteger(row.pid) || row.pid <= 0) return false;
		if (protectedPids.has(row.pid)) return false;
		const command = toComparableText(row.command);
		if (command.includes(SELF_COMMAND_MARKER)) return false;
		const cwd = row.cwd ? toComparablePath(row.cwd) : "";
		if (cwd !== "" && isUnder(cwd, needle)) return true;
		return commandExecutionPaths(row.command).some((key) =>
			isUnder(key, needle),
		);
	});
}

/**
 * The orphan predicate (#2435 AC 2): a fixture helper whose parent is gone.
 *
 * Parent liveness is read from the SNAPSHOT: the snapshot is a full process
 * table taken at one instant, so "ppid absent from the table" is exactly
 * "the parent has exited". This fails SAFE under pid recycling -- a recycled
 * ppid reads as present, so the helper is KEPT, never wrongly killed.
 *
 * That inference is only as good as the table, though, so a caller that CAN
 * probe passes `isPidAlive` and every absence is CONFIRMED before it
 * authorizes a kill (review S5). On a truncated listing the parent is absent
 * but still running, and the probe keeps the helper alive.
 *
 * PR #2438 review round 3 (F5): a row with NO usable parent pid -- `ppid`
 * absent, 0, or negative -- is never an orphan candidate. It used to be the
 * opposite: `ppid <= 0` failed every liveness gate (there is no pid to look
 * up in the table and none to send signal 0 to), fell through both
 * `continue`s, and was reported as `no live parent recorded` -- a KILL
 * authorized by the total ABSENCE of evidence. `ppid` 0 is what
 * `parseProcessTable` writes for any row whose parent column it could not
 * read, and what Windows reports for a reparented process, so the fail-open
 * case was the unparseable one. Unanswered is KEEP.
 *
 * @param {ProcRow[]} rows
 * @param {{ selfPid?: number, protectedPids?: Set<number>, isPidAlive?: (pid: number) => boolean }} [options]
 * @returns {{ row: ProcRow, reason: string }[]}
 */
export function selectOrphanFixtureProcesses(rows, options = {}) {
	const table = rows ?? [];
	const livePids = new Set(table.map((row) => row.pid));
	const selfPid = options.selfPid ?? -1;
	const protectedPids = options.protectedPids ?? new Set();
	const isPidAlive = options.isPidAlive ?? null;
	const orphans = [];
	for (const row of table) {
		if (!Number.isInteger(row.pid) || row.pid <= 0) continue;
		if (row.pid === selfPid || protectedPids.has(row.pid)) continue;
		if (!isFixtureHelperCommand(row.command)) continue;
		const ppid = row.ppid;
		// No usable parent pid => the question "has the parent exited?" was
		// never ANSWERED, and an unanswered question is a keep (F5).
		if (!Number.isInteger(ppid) || ppid <= 0) continue;
		if (livePids.has(ppid)) continue;
		// Absent from the table AND still answering a signal 0 => the table is
		// missing rows, not the parent missing from the box.
		if (isPidAlive !== null && isPidAlive(ppid)) continue;
		orphans.push({
			row,
			reason: `orphan test fixture (parent pid ${ppid} is gone)`,
		});
	}
	return orphans;
}

/**
 * Is the process snapshot trustworthy enough to reason about ABSENCE?
 *
 * PR #2438 review S5. `selectOrphanFixtureProcesses` reads "ppid absent from
 * the table" as "the parent has exited" -- sound for a COMPLETE table, and a
 * fail-OPEN disaster for a truncated one, where every live helper's parent is
 * also missing and every live helper therefore reads as an orphan. The
 * snapshot's own consistency is the only available evidence, so: this process
 * must appear in it, and so must every ancestor its own ppid chain names. A
 * listing that cannot see the process doing the listing has not seen the box.
 *
 * A STALE ppid is not truncation. Measured on the #2435 box: the chain from
 * this sweep walks node -> bash -> bash -> bash -> claude -> powershell ->
 * WindowsTerminal and then names pid 3156, which had genuinely exited (a
 * complete 458-row listing, exit 0, `process.kill(3156, 0)` -> ESRCH).
 * Windows keeps the recorded parent pid after the parent dies, so a
 * chain-walk alone cannot tell "the listing is missing rows" from "an
 * ancestor exited" — and refusing on the latter would disable the orphan
 * sweep permanently on every Windows box, which is #2435 AC 2 itself. The
 * discriminator is liveness: a pid that is ALIVE but absent from the
 * snapshot proves the snapshot is partial; a pid that is gone and absent is
 * simply consistent. Callers that cannot probe (the pure tests) omit
 * `isPidAlive` and get the strict reading.
 *
 * @param {ProcRow[]} rows
 * @param {number} selfPid
 * @param {{ isPidAlive?: (pid: number) => boolean }} [options]
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function verifySnapshotIntegrity(rows, selfPid, options = {}) {
	const table = rows ?? [];
	if (table.length === 0) return { ok: false, reason: "empty" };
	const byPid = new Map(table.map((row) => [row.pid, row]));
	if (!byPid.has(selfPid)) return { ok: false, reason: "self-missing" };
	const isPidAlive = options.isPidAlive ?? null;
	const seen = new Set([selfPid]);
	let cursor = byPid.get(selfPid);
	while (cursor) {
		const ppid = cursor.ppid;
		// A chain that reaches pid 0 (or a row with no parent recorded) has
		// terminated normally; a cycle terminates too rather than hanging.
		if (typeof ppid !== "number" || ppid <= 0) break;
		if (seen.has(ppid)) break;
		const parent = byPid.get(ppid);
		if (!parent) {
			// Absent AND still running => rows are missing => refuse.
			if (isPidAlive === null || isPidAlive(ppid)) {
				return { ok: false, reason: "chain-incomplete" };
			}
			break;
		}
		seen.add(ppid);
		cursor = parent;
	}
	return { ok: true, reason: null };
}

/**
 * The whole orphan-sweep decision in one pure call: verify the snapshot,
 * select the orphans, optionally scope them to one agent's worktree, and
 * report a DEGRADATION instead of a silent empty result when the snapshot
 * cannot be trusted. The caller writes `degraded` to the ledger; a sweep that
 * ran blind must never look like a sweep that found nothing (defect shape 10).
 *
 * @param {object} options
 * @param {ProcRow[]} options.rows
 * @param {number} options.selfPid
 * @param {Set<number>} [options.protectedPids]
 * @param {string|null} [options.restrictToPath] Only reap helpers occupying
 *   this worktree -- the SubagentStop hook's scope.
 * @param {boolean} [options.listingOk] False when the listing subprocess
 *   itself failed (non-zero exit, timeout, spawn error).
 * @param {(pid: number) => boolean} [options.isPidAlive] Liveness probe used
 *   to tell a truncated listing from a genuinely exited ancestor/parent.
 * @returns {{ orphans: { row: ProcRow, reason: string }[], degraded: { reason: string }|null }}
 */
export function planOrphanSweep({
	rows,
	selfPid,
	protectedPids = new Set(),
	restrictToPath = null,
	listingOk = true,
	isPidAlive,
}) {
	if (!listingOk)
		return { orphans: [], degraded: { reason: "listing-failed" } };
	const integrity = verifySnapshotIntegrity(rows, selfPid, { isPidAlive });
	if (!integrity.ok) {
		return { orphans: [], degraded: { reason: integrity.reason } };
	}
	let orphans = selectOrphanFixtureProcesses(rows, {
		selfPid,
		protectedPids,
		isPidAlive,
	});
	if (restrictToPath) {
		const occupants = new Set(
			selectProcessesUnderPath(rows, restrictToPath, { protectedPids }).map(
				(row) => row.pid,
			),
		);
		orphans = orphans.filter((orphan) => occupants.has(orphan.row.pid));
	}
	return { orphans, degraded: null };
}

/**
 * Cap a removal plan at `max` trees, keeping the OLDEST (a tree untouched
 * longest is the safest one to reap, and the order is deterministic).
 *
 * PR #2438 review S8: a Claude Code hook is killed at its configured timeout,
 * and `git worktree remove` is bounded at REMOVE_TIMEOUT_MS on purpose -- a
 * SIGKILLed recursive delete leaves a half-removed tree plus a stale admin
 * directory. One removal per hook run is the only count that fits inside a
 * sane hook timeout; a manual `npm run hygiene` passes no cap and clears the
 * backlog in one go.
 *
 * PR #2438 review round 3 (F4): `0` now means ZERO. It used to be swallowed
 * by a `max <= 0 => uncapped` branch, so `HOOK_POLICIES["subagent-stop"]`'s
 * `maxRemovals: 0` -- which reads as "this hook removes nothing" -- actually
 * spelled "this hook removes as many trees as it likes". Nothing shipped
 * through that hole (`removeWorktrees: false` gates the same call site), but
 * a value whose plain reading is the OPPOSITE of its behaviour is one
 * refactor away from being the bug. Uncapped is now spelled by an absent cap
 * (`null`/`undefined`) or `Infinity`, never by a falsy number.
 *
 * @template {{ ageMs: number }} T
 * @param {T[]} removals
 * @param {number|null|undefined} max `null`/absent/`Infinity` = uncapped;
 *   `0` = remove nothing; any other unreadable value = remove nothing, since
 *   this gates a destructive step.
 * @returns {T[]}
 */
export function capRemovals(removals, max) {
	const list = [...(removals ?? [])];
	if (max === null || max === undefined || max === Number.POSITIVE_INFINITY) {
		return list;
	}
	if (typeof max !== "number" || !Number.isFinite(max) || max <= 0) return [];
	if (list.length <= max) return list;
	return list
		.slice()
		.sort((a, b) => (Number(b.ageMs) || 0) - (Number(a.ageMs) || 0))
		.slice(0, Math.floor(max));
}

/**
 * Branch-name shapes an agent session creates, and the only ones this sweep
 * will ever delete. A `fix/*` / `feat/*` branch is deliberately NOT here:
 * those are the work itself and outlive their worktree.
 */
export const AGENT_BRANCH_SHAPES = [
	/^pr-\d+$/i,
	/^review\//i,
	/^fixround-/i,
	/^worktree-agent-/i,
];

/**
 * Local branches safe to delete after their worktree is gone. THREE
 * conditions, all required:
 *   - the name matches an agent-session shape (above);
 *   - no surviving worktree has it checked out;
 *   - its head is contained in some `origin/*` ref, AND its upstream is
 *     either gone (the PR branch was deleted on merge) or was never set
 *     (a `worktree-agent-*` snapshot branch that only ever tracked master).
 *
 * `containedInOrigin` is the load-bearing one: "upstream is gone" alone
 * would happily delete a branch carrying local commits that were never
 * pushed anywhere.
 *
 * @param {{ name: string, containedInOrigin: boolean, hasUpstream: boolean, upstreamGone: boolean, checkedOut: boolean }[]} branches
 * @returns {string[]}
 */
export function selectStaleBranches(branches) {
	return (branches ?? [])
		.filter(
			(branch) => isAgentBranchCandidate(branch) && branch.containedInOrigin,
		)
		.map((branch) => branch.name);
}

/**
 * The branches this sweep may delete on THIS run: only those whose worktree
 * it just removed, and only if it removed one.
 *
 * PR #2438 review S10: `deleteStaleBranches` ran on every non-dry sweep and
 * considered every `pr-*` / `review/*` / `fixround-*` / `worktree-agent-*`
 * ref in the repository -- so a sweep that removed nothing at all could still
 * delete a branch belonging to a live agent whose worktree it had (correctly)
 * kept. Scoping the candidate set to the removals just performed makes both
 * halves of that one condition: no removals, no deletions.
 *
 * @param {object} options
 * @param {{ name: string, containedInOrigin: boolean, hasUpstream: boolean, upstreamGone: boolean, checkedOut: boolean }[]} options.branches
 * @param {(string|null|undefined)[]} options.removedBranchRefs Full refs
 *   (`refs/heads/pr-1`) of the worktrees actually removed; a detached
 *   worktree contributes null and is ignored.
 * @returns {string[]}
 */
export function planBranchDeletions({ branches, removedBranchRefs }) {
	const allowed = new Set(
		(removedBranchRefs ?? [])
			.filter((ref) => typeof ref === "string" && ref !== "")
			.map((ref) => ref.replace(/^refs\/heads\//, "")),
	);
	if (allowed.size === 0) return [];
	return selectStaleBranches(
		(branches ?? []).filter((branch) => allowed.has(branch?.name)),
	);
}

/**
 * The CHEAP half of selectStaleBranches: everything decidable from a single
 * `git for-each-ref` line, with no per-branch containment query. Split out
 * (rather than duplicated in the caller) so the shape and upstream rules have
 * exactly one definition: the CLI pre-filters with this, runs the expensive
 * containment check only on survivors, then hands the result back to
 * selectStaleBranches for the final verdict.
 *
 * @param {{ name: string, hasUpstream: boolean, upstreamGone: boolean, checkedOut: boolean }} branch
 * @returns {boolean}
 */
export function isAgentBranchCandidate(branch) {
	if (!branch || typeof branch.name !== "string") return false;
	if (branch.checkedOut) return false;
	if (branch.hasUpstream && !branch.upstreamGone) return false;
	return AGENT_BRANCH_SHAPES.some((shape) => shape.test(branch.name));
}

/**
 * Build one bounded hygiene ledger record. The command line is truncated to
 * MAX_RECORDED_COMMAND_CHARS: a full Windows command line can be kilobytes,
 * and an unbounded field in an append-only log is the classic
 * "bounded along one axis, unbounded along another" leak.
 *
 * @param {{ pid: number, command: string, reason: string, worktree?: string|null, dryRun?: boolean, killed?: boolean, error?: string|null, nowIso?: string }} input
 * @returns {string}
 */
export function formatKillRecord(input) {
	const command = String(input.command ?? "");
	const record = {
		ts: input.nowIso ?? new Date().toISOString(),
		event: "hygiene.kill",
		pid: input.pid,
		reason: input.reason,
		worktree: input.worktree ?? null,
		dryRun: Boolean(input.dryRun),
		killed: Boolean(input.killed),
		command:
			command.length > MAX_RECORDED_COMMAND_CHARS
				? `${command.slice(0, MAX_RECORDED_COMMAND_CHARS)}...`
				: command,
	};
	if (input.error) record.error = String(input.error).slice(0, 200);
	return JSON.stringify(record);
}

/**
 * Build one bounded hygiene ledger record for a worktree removal. Same
 * bounded-field discipline as formatKillRecord: this is the ONLY evidence a
 * `--quiet` hook run leaves behind, so it has to carry the verdict, not just
 * the path.
 *
 * @param {{ path: string, branch?: string|null, ageMs: number, dryRun?: boolean, removed?: boolean, error?: string|null, nowIso?: string }} input
 * @returns {string}
 */
export function formatWorktreeRecord(input) {
	const record = {
		ts: input.nowIso ?? new Date().toISOString(),
		event: "hygiene.worktree-removed",
		worktree: String(input.path ?? "").slice(0, MAX_RECORDED_COMMAND_CHARS),
		branch: input.branch ?? null,
		ageMs: Math.round(Number(input.ageMs) || 0),
		dryRun: Boolean(input.dryRun),
		removed: Boolean(input.removed),
	};
	if (input.error) record.error = String(input.error).slice(0, 200);
	return JSON.stringify(record);
}

/**
 * Build one bounded hygiene ledger record for a DEGRADED process scan.
 *
 * Without this the orphan sweep's most likely failure — a loaded box where
 * the process listing cannot finish inside the budget — leaves nothing behind
 * but a stderr line the hook runner discards, and the sweep looks like it ran
 * clean when it actually ran blind. Shape 10/13 of the defect catalog: a
 * degradation must be recorded, not merely survived.
 *
 * Reasons: `skipped` (no budget left to scan), `empty` (the listing returned
 * nothing), `listing-failed` (it exited non-zero / timed out / never
 * spawned), `self-missing` and `chain-incomplete` (the listing came back
 * TRUNCATED, so absence cannot be read as death -- review S5).
 *
 * `remainingMs` and `ceilingMs` are DIFFERENT facts and were conflated until
 * PR #2493's second review round (T3): `remainingMs` is what was left of the
 * sweep budget when the degradation was recorded, `ceilingMs` is the bound the
 * listing was actually given (`min(--scan-timeout-ms, remaining)`). Writing the
 * ceiling into `remainingMs` made a skipped scan report a budget it never had,
 * which is precisely the reading #2486's investigation needed and could not do.
 *
 * @param {{ reason: "skipped"|"empty"|"listing-failed"|"self-missing"|"chain-incomplete", budgetMs: number, remainingMs?: number, ceilingMs?: number, rows?: number, nowIso?: string }} input
 * @returns {string}
 */
export function formatScanRecord(input) {
	const optional = (value) =>
		value === undefined ? null : Math.round(Number(value) || 0);
	return JSON.stringify({
		ts: input.nowIso ?? new Date().toISOString(),
		event: "hygiene.scan-degraded",
		reason: input.reason,
		budgetMs: Math.round(Number(input.budgetMs) || 0),
		remainingMs: optional(input.remainingMs),
		ceilingMs: optional(input.ceilingMs),
		rows: Math.round(Number(input.rows) || 0),
	});
}

/**
 * Reasons a hygiene invocation can end without doing any work. Spelled as a
 * closed table so the ledger's `reason` field is a vocabulary a reader can
 * enumerate, not free text (#2486).
 */
export const RUN_SKIP_REASONS = Object.freeze({
	/** The payload on stdin carried no `agent_id` (see the SubagentStop schema). */
	NO_AGENT_ID: "no-agent-id",
	/**
	 * `agent_id` was usable but `.claude/worktrees/agent-<id>` does not exist:
	 * the agent was not worktree-isolated, or its tree is already gone. This is
	 * the ORDINARY case for most subagents, and conflating it with
	 * NO_AGENT_ID is what made #2486's "no log line at all" unreadable.
	 */
	AGENT_WORKTREE_MISSING: "agent-worktree-missing",
	/** `git worktree list` failed or timed out, so there is nothing to plan over. */
	WORKTREE_LIST_FAILED: "worktree-list-failed",
	/** The argv did not parse; nothing ran. */
	INVALID_ARGUMENTS: "invalid-arguments",
});

/**
 * Build the ONE record every invocation writes, whatever it did (#2486).
 *
 * Before this, a sweep that returned early — no `agent_id`, an agent that was
 * never worktree-isolated, a failed `git worktree list` — wrote nothing at
 * all, and a sweep that simply found nothing to do wrote nothing either. The
 * hooks run `--quiet` and Claude Code discards their stderr, so "the hook
 * never fired", "the hook fired and could not identify a tree" and "the hook
 * fired and everything was ineligible" were the same observation: an empty
 * ledger. Defect shape 10 — an absence that cannot distinguish clean from
 * unavailable.
 *
 * `keptReason` closes the other half (PR #2493 review round 2, S2). A hook that
 * FIRED, identified its tree and then refused it — because the tree is dirty,
 * or its HEAD is in no `origin/*` ref — is indistinguishable in the ledger from
 * a hook that fired and had nothing to reap: both read `fired, removed: 0`. It
 * carries the `planWorktreePrune` keep reason for the ONE tree the run was
 * scoped to, and is null for a run that removed that tree or was scoped to no
 * single tree at all.
 *
 * @param {{ hook?: string|null, outcome: "fired"|"skipped", reason?: string|null, worktree?: string|null, keptReason?: string|null, removed?: number, orphans?: number, rows?: number, dryRun?: boolean, budgetMs?: number, durationMs?: number, nowIso?: string }} input
 * @returns {string}
 */
export function formatRunRecord(input) {
	const count = (value) => Math.round(Number(value) || 0);
	return JSON.stringify({
		ts: input.nowIso ?? new Date().toISOString(),
		event: "hygiene.run",
		hook: input.hook ?? null,
		outcome: input.outcome,
		reason: input.reason ?? null,
		worktree: input.worktree
			? String(input.worktree).slice(0, MAX_RECORDED_COMMAND_CHARS)
			: null,
		keptReason: input.keptReason ?? null,
		removed: count(input.removed),
		orphans: count(input.orphans),
		rows: count(input.rows),
		dryRun: Boolean(input.dryRun),
		budgetMs: count(input.budgetMs),
		durationMs: count(input.durationMs),
	});
}

/**
 * Keep the ledger bounded: append `newLines`, then retain only the newest
 * `maxLines`. Pure so the retention arithmetic is testable without touching
 * a real log file.
 *
 * @param {string[]} existingLines
 * @param {string[]} newLines
 * @param {number} [maxLines]
 * @returns {string[]}
 */
export function pruneLogLines(
	existingLines,
	newLines,
	maxLines = DEFAULT_LOG_MAX_LINES,
) {
	const limit =
		Number.isFinite(maxLines) && maxLines > 0
			? Math.floor(maxLines)
			: DEFAULT_LOG_MAX_LINES;
	const all = [...(existingLines ?? []), ...(newLines ?? [])].filter(
		(line) => typeof line === "string" && line.trim() !== "",
	);
	return all.length <= limit ? all : all.slice(all.length - limit);
}
