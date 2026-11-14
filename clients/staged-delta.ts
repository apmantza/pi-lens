/**
 * #5553 (G2, 2026-11-13): the `--lens-guard` commit gate judges the staged
 * delta at `git commit`, whoever wrote the bytes.
 *
 * The gate's record is filled by a write that pi-lens saw: a host `edit`, a
 * recognised bash write, a tool that names its path. Bytes nobody authored (a
 * script no recogniser reads, a foreign tool that names no path, an external
 * editor) reach `git commit` with no record, so a `debugger;` in them
 * committed. This module is the gate's own read of what the commit carries.
 *
 * git resolves the commit (the maintainer, 2026-11-14). The command's commit
 * is replayed as `git commit --dry-run --porcelain -z` with its own arguments,
 * git options, assignments and directory (`planStagedCommit`), on a private
 * copy of the index it would use; a `git add` that runs before it in the same
 * command is replayed on that copy first. Each path the dry run says the
 * commit carries with content is judged on its committed bytes: the working
 * file when git reports the commit's entry equal to it, otherwise the index
 * blob. A line of those bytes is added when no base holds it, the bases being
 * the path's blob (or its rename source's) in `HEAD` and, during a merge, in
 * each `MERGE_HEAD`. A file whose committed blob is a base's adds nothing and
 * runs no lane. A blocking finding of the seeded lanes
 * (`collectStagedLaneBlockers`) on an added line refuses.
 *
 * Fail closed. A command pi-lens cannot replay, a git read that fails or is
 * cut, a file it cannot read, a lane that gives no answer, a throw, and the
 * bound each refuse as degraded, never allow.
 */
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bounded } from "./deadline-utils.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { loadDispatchIntegration } from "./dispatch/lazy.js";
import type { Diagnostic } from "./dispatch/types.js";
import { isPathIgnoredByProject } from "./file-utils.js";
import {
	type GuardDecision,
	logDecision,
	mayRunGitCommit,
	planStagedCommit,
	type ReplayedGit,
	unknown,
} from "./git-guard.js";
import { applyInlineBlockerPolicy } from "./inline-blocker-dispositions.js";
import { alignLines, lineHashesOf } from "./line-alignment.js";
import {
	isExternalOrVendorFile,
	realpathOrResolve,
	toProjectRelativePath,
} from "./path-utils.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { truncatedByOutputCap } from "./spawn-output-cap.js";

const GIT_TIMEOUT_MS = 5000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Files whose findings the refusal names. */
const MAX_NAMED_FILES = 5;
/** Files judged at once: each runs git reads and the lanes. */
const LANE_CONCURRENCY = 4;

/** Why the read could not answer: a refusal, never a pass. */
export type StagedDeltaDegraded =
	| "unresolved_command"
	| "git_failed"
	| "git_output_cut"
	| "file_unreadable"
	| "lane_incomplete";

export type StagedDeltaVerdict =
	| { kind: "clean"; files: number }
	| {
			kind: "added";
			/** The finding policy's survivors, rendered, per file. */
			detail: string;
			files: string[];
	  }
	| { kind: "degraded"; reason: StagedDeltaDegraded; detail: string };

const degraded = (
	reason: StagedDeltaDegraded,
	detail: string,
): StagedDeltaVerdict => ({ kind: "degraded", reason, detail });

interface StagedDeltaDeps {
	cwd: string;
	projectRoot: string;
	getFlag: (flag: string) => boolean | string | undefined;
	signal?: AbortSignal;
}

interface GitRead {
	status: number | null;
	stdout: string;
	stderr: string;
	cut: boolean;
}

/** One git read under the replayed command's options, on our index copy. */
async function runGit(
	replay: ReplayedGit,
	extra: { index?: string; config?: string; input?: string },
	args: readonly string[],
	signal: AbortSignal | undefined,
): Promise<GitRead> {
	const result = await safeSpawnAsync(
		"git",
		[
			...replay.globals,
			...(extra.config === undefined ? [] : ["-c", extra.config]),
			...args,
		],
		{
			cwd: replay.cwd,
			env: {
				...replay.env,
				...(extra.index === undefined ? {} : { GIT_INDEX_FILE: extra.index }),
				GIT_TERMINAL_PROMPT: "0",
				GIT_EDITOR: "false",
			},
			timeout: GIT_TIMEOUT_MS,
			maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
			input: extra.input ?? "",
			...(signal === undefined ? {} : { signal }),
		},
	);
	return {
		status: result.error ? null : result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		cut: truncatedByOutputCap(result),
	};
}

/** A git read's failure as the refusal names it. */
function gitFailure(out: GitRead, what: string): StagedDeltaVerdict {
	if (out.cut) return degraded("git_output_cut", what);
	const first = out.stderr.trim().split("\n")[0] ?? "";
	return degraded("git_failed", first ? `${what}: ${first}` : what);
}

/** One path a dry run lists. */
interface Carried {
	/** git's X (the commit's index against the base) and Y (against the working file). */
	x: string;
	y: string;
	/** The file, from the top of the checkout. */
	file: string;
	/** The rename or copy source. */
	from?: string;
}

/** `git commit --dry-run --porcelain -z` output, or `undefined` for anything else. */
function parseDryRun(stdout: string): Carried[] | undefined {
	const entries: Carried[] = [];
	const tokens = stdout.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] ?? "";
		if (token === "" && i === tokens.length - 1) break;
		if (!/^[ MADRCTU?!]{2} ./s.test(token)) return undefined;
		const x = token[0] ?? " ";
		const y = token[1] ?? " ";
		const moved = "RC".includes(x) || "RC".includes(y);
		const from = moved ? tokens[++i] : undefined;
		if (moved && !from) return undefined;
		entries.push({ x, y, file: token.slice(3), ...(from && { from }) });
	}
	return entries;
}

/** Lines of `committed` that no base holds (1-based), or `"all"`. */
function addedLines(
	committed: string,
	bases: readonly string[],
	wholeFile: boolean,
): Set<number> | "all" {
	const after = lineHashesOf(committed);
	if (wholeFile || !after) return "all";
	const inherited = new Set<number>();
	for (const base of bases) {
		const before = lineHashesOf(base);
		const map = before && alignLines(before, after);
		if (!before || !map) continue;
		for (let line = 1; line <= before.length; line++) {
			const target = map(line);
			if (target !== undefined) inherited.add(target);
		}
	}
	const added = new Set<number>();
	for (let line = 1; line <= after.length; line++)
		if (!inherited.has(line)) added.add(line);
	return added;
}

/** What the read knows of one carried file before its lanes run. */
interface Candidate {
	abs: string;
	committedId: string;
	/** The committed bytes are the working file's (git's Y is blank). */
	fromWork: boolean;
	baseIds: string[];
}

interface Repo {
	top: string;
	copy: string;
	mergeHead: string;
	replay: ReplayedGit;
}

/**
 * The staged-delta verdict for one command that may commit: a verdict per the
 * added lines of each file the commit carries.
 */
async function judgeStagedDelta(
	toolName: string,
	input: unknown,
	deps: StagedDeltaDeps,
): Promise<StagedDeltaVerdict> {
	const plan = planStagedCommit(toolName, input, deps.cwd);
	if ("unresolved" in plan)
		return degraded("unresolved_command", plan.unresolved);
	const scratch = nodeFs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-staged-"));
	try {
		// A dry run that an argument turns into a real commit
		// (`--no-porcelain --no-null --no-dry-run`) stops at this hook, which
		// `--no-verify` does not skip. Its stderr line keeps the exit from
		// reading as "nothing to commit".
		const hooks = path.join(scratch, "hooks");
		nodeFs.mkdirSync(hooks);
		nodeFs.writeFileSync(
			path.join(hooks, "prepare-commit-msg"),
			"#!/bin/sh\necho 'the command turns the dry run into a real commit' >&2\nexit 1\n",
			{ mode: 0o755 },
		);
		const copies = new Map<string, string>();
		const repoOf = async (
			replay: ReplayedGit,
		): Promise<Repo | StagedDeltaVerdict | "none"> => {
			const out = await runGit(
				replay,
				{},
				[
					"rev-parse",
					"--path-format=absolute",
					"--show-toplevel",
					"--git-path",
					"index",
					"--git-path",
					"MERGE_HEAD",
				],
				deps.signal,
			);
			// The replay runs where the git command runs, with its options and
			// env, so no repository there is that command's own failure: a
			// commit that cannot land has nothing to judge.
			if (
				out.status === 128 &&
				out.stderr.startsWith("fatal: not a git repository")
			)
				return "none";
			const [top, index, mergeHead] = out.stdout.split("\n");
			if (out.status !== 0 || !top || !index || !mergeHead)
				return gitFailure(out, "finding the repository the commit runs in");
			let copy = copies.get(index);
			if (copy === undefined) {
				copy = path.join(scratch, `index-${copies.size}`);
				copies.set(index, copy);
				// No index yet is an empty one, for git and for the copy alike.
				if (nodeFs.existsSync(index)) nodeFs.copyFileSync(index, copy);
			}
			return { top, copy, mergeHead, replay };
		};
		for (const add of plan.adds) {
			const repo = await repoOf(add);
			if (repo === "none")
				return degraded(
					"git_failed",
					"replaying git add: not a git repository",
				);
			if ("kind" in repo) return repo;
			const out = await runGit(
				add,
				{ index: repo.copy },
				["add", ...add.args],
				deps.signal,
			);
			if (out.status !== 0) return gitFailure(out, "replaying git add");
		}
		const repo = await repoOf(plan.commit);
		if (repo === "none") return { kind: "clean", files: 0 };
		if ("kind" in repo) return repo;
		const dry = await runGit(
			plan.commit,
			{
				index: repo.copy,
				config: `core.hooksPath=${hooks}`,
				// `--pathspec-from-file=-` then reads every path: a superset of
				// any list the command feeds it.
				input: ":/\n",
			},
			[
				"commit",
				"--dry-run",
				"--porcelain",
				"-z",
				"--untracked-files=no",
				...plan.commit.args,
			],
			deps.signal,
		);
		// Exit 1 with nothing on stderr is "nothing to commit": git refuses the
		// commit itself, and the output lists nothing carried.
		if (dry.status !== 0 && (dry.status !== 1 || dry.stderr.trim() !== ""))
			return gitFailure(dry, "the commit's dry run");
		const entries = parseDryRun(dry.stdout);
		if (!entries) return gitFailure(dry, "reading the commit's dry run");
		return await judgeCarried(
			entries.filter((entry) => "AMRCT".includes(entry.x)),
			repo,
			deps,
		);
	} finally {
		nodeFs.rmSync(scratch, { recursive: true, force: true });
	}
}

async function judgeCarried(
	carried: readonly Carried[],
	repo: Repo,
	deps: StagedDeltaDeps,
): Promise<StagedDeltaVerdict> {
	if (
		carried.some((entry) => `${entry.file}${entry.from ?? ""}`.includes("\n"))
	)
		return degraded("git_failed", "a carried path holds a newline");
	// git spells the top with symlinks resolved; the session root may not.
	const top = path.resolve(
		deps.projectRoot,
		path.relative(realpathOrResolve(deps.projectRoot), repo.top),
	);
	let mergeHeads: string[] = [];
	try {
		mergeHeads = nodeFs
			.readFileSync(repo.mergeHead, "utf8")
			.split("\n")
			.filter((line) => /^[0-9a-f]{40,64}$/.test(line));
	} catch {
		// none: no MERGE_HEAD file is no merge in progress.
	}
	// A symlink or a submodule the working tree holds is no file to lint.
	const judged = carried.filter((entry) => {
		if (entry.y !== " ") return true;
		try {
			return nodeFs.lstatSync(path.resolve(top, entry.file)).isFile();
		} catch {
			// none: git reads the working file for this entry, so one gone
			// since is no file the commit can carry either; git refuses it.
			return false;
		}
	});
	const fromWork = judged.filter((entry) => entry.y === " ");
	const git = { index: repo.copy };
	let workIds: string[] = [];
	if (fromWork.length > 0) {
		const hashed = await runGit(
			repo.replay,
			{
				...git,
				input: `${fromWork.map((entry) => path.resolve(top, entry.file)).join("\n")}\n`,
			},
			["hash-object", "--stdin-paths"],
			deps.signal,
		);
		workIds = hashed.stdout.split("\n").filter(Boolean);
		if (hashed.status !== 0 || workIds.length !== fromWork.length)
			return gitFailure(hashed, "hashing the working files the commit carries");
	}
	const revs = ["HEAD", ...mergeHeads];
	const names = judged.flatMap((entry) => [
		...(entry.y === " " ? [] : [`:0:${entry.file}`]),
		...revs.map((rev) => `${rev}:${entry.from ?? entry.file}`),
	]);
	const blobs = new Map<string, string>();
	if (names.length > 0) {
		const checked = await runGit(
			repo.replay,
			{ ...git, input: `${names.join("\n")}\n` },
			["cat-file", "--batch-check"],
			deps.signal,
		);
		const lines = checked.stdout.split("\n");
		if (checked.status !== 0 || lines.length < names.length)
			return gitFailure(checked, "reading the blobs the commit carries");
		names.forEach((name, at) => {
			const match = /^([0-9a-f]{40,64}) blob \d+$/.exec(lines[at] ?? "");
			if (match?.[1]) blobs.set(name, match[1]);
		});
	}
	const candidates: Candidate[] = [];
	for (const entry of judged) {
		const work = fromWork.indexOf(entry);
		const committedId =
			work >= 0 ? workIds[work] : blobs.get(`:0:${entry.file}`);
		if (committedId === undefined)
			return degraded("git_failed", `the index has no blob for ${entry.file}`);
		const baseIds = revs.flatMap((rev) => {
			const id = blobs.get(`${rev}:${entry.from ?? entry.file}`);
			return id === undefined ? [] : [id];
		});
		// Equal to a base: the commit adds nothing to this file (a file a merge
		// brings in, a file `--amend` keeps as HEAD has it).
		if (baseIds.includes(committedId)) continue;
		candidates.push({
			abs: path.resolve(top, entry.file),
			committedId,
			fromWork: work >= 0,
			baseIds,
		});
	}
	const findings: Array<{ file: string; body: string }> = [];
	let files = 0;
	for (let at = 0; at < candidates.length; at += LANE_CONCURRENCY) {
		const results = await Promise.all(
			candidates
				.slice(at, at + LANE_CONCURRENCY)
				.map((candidate) => judgeFile(candidate, repo, deps)),
		);
		for (const result of results) {
			if ("kind" in result) return result;
			if (result.judged) files += 1;
			if (result.body) findings.push({ file: result.file, body: result.body });
		}
	}
	if (findings.length === 0) return { kind: "clean", files };
	return {
		kind: "added",
		files: findings.map((f) => f.file),
		detail: findings
			.slice(0, MAX_NAMED_FILES)
			.map((f) => `${f.file}:\n${f.body}`)
			.join("\n"),
	};
}

async function judgeFile(
	candidate: Candidate,
	repo: Repo,
	deps: StagedDeltaDeps,
): Promise<
	{ judged: boolean; file: string; body?: string } | StagedDeltaVerdict
> {
	const { abs } = candidate;
	const file = toProjectRelativePath(abs, deps.projectRoot);
	if (
		isExternalOrVendorFile(abs, deps.projectRoot) ||
		isPathIgnoredByProject(abs, deps.projectRoot, false)
	)
		return { judged: false, file };
	const blob = async (id: string): Promise<string | StagedDeltaVerdict> => {
		const out = await runGit(
			repo.replay,
			{ index: repo.copy },
			["cat-file", "blob", id],
			deps.signal,
		);
		return out.status === 0 ? out.stdout : gitFailure(out, `reading ${file}`);
	};
	let committed: string | StagedDeltaVerdict;
	if (candidate.fromWork) {
		try {
			committed = nodeFs.readFileSync(abs, "utf8");
		} catch {
			// none: the degraded verdict refuses, and gateStagedDelta records it once.
			return degraded("file_unreadable", file);
		}
	} else committed = await blob(candidate.committedId);
	if (typeof committed !== "string") return committed;
	const bases: string[] = [];
	for (const id of candidate.baseIds) {
		const base = await blob(id);
		if (typeof base !== "string") return base;
		bases.push(base);
	}
	const added = addedLines(committed, bases, deps.getFlag("no-delta") === true);
	if (added !== "all" && added.size === 0) return { judged: false, file };
	// The lanes read a file: an index blob the working file does not hold is
	// written beside it for one read, so the project's config applies to it.
	const copy = candidate.fromWork
		? undefined
		: path.join(
				path.dirname(abs),
				`pi-lens-staged-${randomBytes(4).toString("hex")}.${path.basename(abs)}`,
			);
	try {
		if (copy) nodeFs.writeFileSync(copy, committed, { flag: "wx" });
		const integration = await loadDispatchIntegration();
		const run = await integration.collectStagedLaneBlockers(
			abs,
			deps.projectRoot,
			{ getFlag: deps.getFlag },
			copy,
		);
		if (run.outcome === "skipped")
			return run.reason === "unreadable"
				? degraded("file_unreadable", file)
				: { judged: false, file };
		if (run.unanswered.length > 0)
			return degraded(
				"lane_incomplete",
				`${file}: ${run.unanswered.join(", ")} gave no answer`,
			);
		const blockers = run.blockers.filter(
			(blocker) =>
				added === "all" ||
				(blocker.line !== undefined && added.has(blocker.line)),
		);
		if (blockers.length === 0) return { judged: true, file };
		const policy = applyInlineBlockerPolicy(
			{ filePath: abs, summary: "", diagnostics: blockers as Diagnostic[] },
			deps.projectRoot,
		);
		if (policy.kept === 0) return { judged: true, file };
		return { judged: true, file, body: policy.body ?? "" };
	} finally {
		if (copy) nodeFs.rmSync(copy, { force: true });
	}
}

/** What clears each degraded read: each names an action the next attempt reads afresh. */
const DEGRADED_REMEDY: Readonly<Record<StagedDeltaDegraded, string>> = {
	unresolved_command:
		"pi-lens judges a commit by replaying it with git before it runs, and cannot replay this command. Run the other commands first, then run git commit on its own (git add, cd and a -m \"$(cat <<'EOF' ... EOF)\" message may stay in it).",
	lane_incomplete:
		"pi-lens could not finish checking the staged files: a linter gave no answer, or the check ran out of time. Fix the linter or its config if one is named, then commit again.",
	file_unreadable:
		"pi-lens could not read a staged file. Make it readable, then commit again.",
	git_failed:
		"git refused the commit's dry run or a read of the staged files, for the reason above. Fix what it names, then commit again.",
	git_output_cut:
		"The staged set is too large for pi-lens to read in one commit. Commit fewer files at once.",
};

/** The gate's answer to the staged-delta read of one commit command. */
export function stagedDeltaDecision(
	cwd: string,
	verdict: StagedDeltaVerdict,
): GuardDecision {
	if (verdict.kind === "clean") {
		logDecision(cwd, "allowed", "staged_delta_clean", { files: verdict.files });
		return { block: false };
	}
	if (verdict.kind === "degraded")
		return unknown(
			cwd,
			`staged_delta_${verdict.reason}`,
			{},
			`${verdict.detail}. ${DEGRADED_REMEDY[verdict.reason]}`,
		);
	logDecision(cwd, "blocked", "staged_delta_blockers", {
		files: verdict.files.length,
	});
	return {
		block: true,
		reason: `🔴 COMMIT BLOCKED (--lens-guard): the staged change adds blocking findings that HEAD does not have. Fix them, then commit again.\n${verdict.detail}`,
	};
}

/**
 * #5553: how long the commit gate waits for its staged-delta read (the git
 * replay and the lanes over each file the commit carries). `tool_call` has no
 * budget of its own (clients/hook-budgets.ts), so the read carries its own.
 */
export const STAGED_DELTA_BUDGET_MS = 20_000;

/**
 * The gate's one entry for the staged-delta read: the decision `tool_call`
 * returns for `input`. It never throws: a read that throws, gives no answer
 * inside `budgetMs` or is aborted refuses as degraded, recorded once per
 * reason and session (`staged-delta-degraded`). Work the bound abandoned
 * records nothing.
 */
export async function gateStagedDelta(
	toolName: string,
	input: unknown,
	deps: Omit<StagedDeltaDeps, "signal">,
	signal: AbortSignal | undefined,
	budgetMs: number = STAGED_DELTA_BUDGET_MS,
): Promise<GuardDecision> {
	if (!mayRunGitCommit(toolName, input)) return { block: false };
	let verdict: StagedDeltaVerdict | undefined;
	try {
		verdict = await bounded(
			(workSignal) =>
				judgeStagedDelta(toolName, input, { ...deps, signal: workSignal }),
			{ ms: budgetMs, signal, hook: "tool_call", label: "staged-delta-gate" },
		);
	} catch (cause) {
		// none: the refusal below is recorded once, after this handler.
		const failure = cause instanceof Error ? cause.message : String(cause);
		verdict = degraded(
			"lane_incomplete",
			`the staged-delta read threw: ${failure}`,
		);
	}
	verdict ??= degraded(
		"lane_incomplete",
		"the staged-delta read gave no answer inside its bound",
	);
	if (verdict.kind === "degraded")
		recordDegradationOnce({
			kind: "staged-delta-degraded",
			subject: verdict.reason,
			reason: verdict.detail,
		});
	return stagedDeltaDecision(deps.cwd, verdict);
}
