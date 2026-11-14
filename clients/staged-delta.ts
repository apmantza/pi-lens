/**
 * #5553 (G2, 2026-11-13): the `--lens-guard` commit gate judges the staged
 * delta at `git commit`, whoever wrote the bytes.
 *
 * The gate's record is filled by a write that pi-lens saw: a host `edit`, a
 * recognised bash write, a tool that names its path. Bytes nobody authored (a
 * script no recogniser reads, a foreign tool that names no path, an external
 * editor) reach `git commit` with no record, so a `debugger;` in them
 * committed. This module is the gate's own read: it lists the files the
 * commit can carry from the commit's argv and git, takes the lines each adds
 * against `HEAD`, runs the staged-delta lanes over the file's bytes
 * (`collectStagedLaneBlockers`) and reports a blocker on an added line.
 *
 * The line read stands in for linting the HEAD blob: a blocker on a line the
 * commit leaves untouched is inherited debt (acceptance 5), one on a line it
 * adds is new, and no sibling copy of the old bytes is written to the user's
 * tree to be linted. A finding an edit moves onto an untouched line (an import
 * that loses its last use) is not read as added: the writer baseline's identity
 * match (`clients/dispatch/pre-edit-seed.ts`) is the finer rule for the writers
 * that have one; this is the floor for the rest.
 *
 * Fail closed (the gate admits known-good forms and refuses the rest). A commit argv this does not
 * recognise is not a pass: the files are every one that differs from `HEAD` or
 * is untracked, each judged on its added lines. A git read that fails or is
 * cut, a file that cannot be read, a lane that times out, and a staged file
 * whose working bytes are not the index's (the lanes read the working file)
 * each refuse as degraded, never allow.
 */
import * as nodeFs from "node:fs";
import * as path from "node:path";
import type { DecodedShellWord } from "./bash-file-access.js";
import { bounded } from "./deadline-utils.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { applyInlineBlockerPolicy } from "./inline-blocker-dispositions.js";
import { isPathIgnoredByProject } from "./file-utils.js";
import { isExternalOrVendorFile, toProjectRelativePath } from "./path-utils.js";
import {
	logDecision,
	mayRunGitCommit,
	readGuardedSegments,
	unknown,
	type GuardDecision,
} from "./git-guard.js";
import { resolveGitCheckout } from "./review-graph/git-identity.js";
import { safeSpawnAsync } from "./safe-spawn.js";
import { truncatedByOutputCap } from "./spawn-output-cap.js";
import { loadDispatchIntegration } from "./dispatch/lazy.js";
import type { Diagnostic } from "./dispatch/types.js";

/** Where a commit takes its files from (git's own `--only`, `--include`, `-a`). */
type StageSource = "index" | "all" | "paths" | "index+paths";

export interface CommitStageForm {
	source: StageSource;
	pathspecs: readonly string[];
}

/** `git commit` options that take a value, as `--opt value` or `--opt=value`. */
const VALUE_LONG_OPTIONS: ReadonlySet<string> = new Set([
	"message",
	"file",
	"reuse-message",
	"reedit-message",
	"template",
	"author",
	"date",
	"cleanup",
	"fixup",
	"squash",
	"trailer",
]);
/** `git commit` options with no effect on which files the commit carries. */
const NEUTRAL_LONG_OPTIONS: ReadonlySet<string> = new Set([
	"amend",
	"no-verify",
	"verify",
	"allow-empty",
	"allow-empty-message",
	"no-edit",
	"edit",
	"signoff",
	"no-signoff",
	"quiet",
	"verbose",
	"reset-author",
	"no-post-rewrite",
	"status",
	"no-status",
	"no-gpg-sign",
	"gpg-sign",
	"untracked-files",
]);
const VALUE_SHORT_OPTIONS = "mFCct";
const NEUTRAL_SHORT_OPTIONS = "qvsenSu";

/**
 * Which files the words after `git commit` make it carry, or `undefined` for a
 * form this does not read (an unknown option, `-p`, `--pathspec-from-file`, a
 * word the shell expands): only a listed form is resolved, everything else is
 * unrecognized and judged by the superset.
 */
export function parseCommitStageForm(
	args: readonly DecodedShellWord[],
): CommitStageForm | undefined {
	let all = false;
	let include = false;
	const pathspecs: string[] = [];
	let onlyPaths = false;
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (word === undefined) return undefined;
		const text = word.text;
		const isOption = !onlyPaths && text.startsWith("-") && text !== "-";
		if (!isOption) {
			if (word.hidden || word.tildeExpands) return undefined;
			pathspecs.push(text);
			continue;
		}
		if (text === "--") {
			onlyPaths = true;
			continue;
		}
		if (word.hidden) return undefined;
		if (text.startsWith("--")) {
			const [name = "", inline] = text.slice(2).split(/=(.*)/s, 2);
			if (name === "all") all = true;
			else if (name === "include") include = true;
			else if (name === "only") include = false;
			else if (VALUE_LONG_OPTIONS.has(name)) {
				if (inline === undefined) i += 1;
			} else if (!NEUTRAL_LONG_OPTIONS.has(name)) return undefined;
			continue;
		}
		// A cluster of short options: the first value-taking one ends it.
		for (let c = 1; c < text.length; c++) {
			const letter = text[c] ?? "";
			if (letter === "a") all = true;
			else if (letter === "i") include = true;
			else if (letter === "o") include = false;
			else if (VALUE_SHORT_OPTIONS.includes(letter)) {
				if (c === text.length - 1) i += 1;
				break;
			} else if (letter === "S" || letter === "u") break;
			else if (!NEUTRAL_SHORT_OPTIONS.includes(letter)) return undefined;
		}
	}
	const hasPaths = pathspecs.length > 0;
	return {
		source: all
			? "all"
			: hasPaths
				? include
					? "index+paths"
					: "paths"
				: "index",
		pathspecs,
	};
}

/** The tree git diffs against when `HEAD` does not exist yet (a first commit). */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_TIMEOUT_MS = 5000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Files whose findings the refusal names. */
const MAX_NAMED_FILES = 5;
/** Lane runs in flight at once: the lanes are in-process or one spawn each. */
const LANE_CONCURRENCY = 4;

interface StagedEntry {
	/** Path relative to the top of the checkout. */
	path: string;
	/** The path in `HEAD` of a renamed or copied file. */
	from?: string;
	/** git's status letter, `?` for an untracked file. */
	status: string;
	/** Whether the entry came from the index listing. */
	fromIndex: boolean;
}

/** Why the staged set or a file's delta could not be read: a refusal, never a pass. */
export type StagedDeltaDegraded =
	| "git_failed"
	| "git_output_cut"
	| "no_checkout"
	| "bytes_not_staged"
	| "file_unreadable"
	| "lane_incomplete";

export type StagedDeltaVerdict =
	/** The command cannot commit (a push alone): nothing is staged by it. */
	| { kind: "not_a_commit" }
	| { kind: "clean"; files: number }
	| {
			kind: "added";
			/** The finding policy's survivors, rendered, per file. */
			detail: string;
			files: string[];
	  }
	| { kind: "degraded"; reason: StagedDeltaDegraded; detail: string };

async function runGit(
	dir: string,
	args: readonly string[],
	signal: AbortSignal | undefined,
): Promise<
	| { ok: true; stdout: string }
	| {
			ok: false;
			reason: "git_failed" | "git_output_cut";
			status: number | null;
	  }
> {
	const result = await safeSpawnAsync("git", ["--literal-pathspecs", ...args], {
		cwd: dir,
		timeout: GIT_TIMEOUT_MS,
		maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
		...(signal === undefined ? {} : { signal }),
	});
	if (truncatedByOutputCap(result))
		return { ok: false, reason: "git_output_cut", status: result.status };
	if (result.error || result.status !== 0)
		return { ok: false, reason: "git_failed", status: result.status };
	return { ok: true, stdout: result.stdout ?? "" };
}

/** `git diff --raw -z` entries, or `undefined` for output that is not that. */
function parseRawDiff(
	stdout: string,
	fromIndex: boolean,
): StagedEntry[] | undefined {
	const entries: StagedEntry[] = [];
	const tokens = stdout.split("\0");
	for (let i = 0; i < tokens.length;) {
		const header = tokens[i] ?? "";
		if (header === "") {
			i += 1;
			continue;
		}
		if (!header.startsWith(":")) return undefined;
		const status = header.slice(header.lastIndexOf(" ") + 1);
		const moved = status.startsWith("R") || status.startsWith("C");
		const first = tokens[i + 1];
		const second = tokens[i + 2];
		if (first === undefined || (moved && second === undefined))
			return undefined;
		entries.push(
			moved
				? {
						path: second ?? "",
						from: first,
						status: status[0] ?? "R",
						fromIndex,
					}
				: { path: first, status: status[0] ?? "M", fromIndex },
		);
		i += moved ? 3 : 2;
	}
	return entries;
}

const RAW_DIFF = [
	"diff",
	"--raw",
	"-z",
	"-M",
	"--no-ext-diff",
	"--no-textconv",
] as const;

/** The line ranges a `git diff -U0` adds, from its hunk headers. */
function parseAddedRanges(stdout: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const line of stdout.split("\n")) {
		const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (!match) continue;
		const start = Number(match[1]);
		const count = match[2] === undefined ? 1 : Number(match[2]);
		if (count > 0) ranges.push([start, start + count - 1]);
	}
	return ranges;
}

interface Listing {
	base: string;
	entries: StagedEntry[];
	/** Whether the set is the superset an unrecognized form reads. */
	superset: boolean;
}

/** Files a commit of `form` carries, in the checkout `dir` belongs to. */
async function listCommitFiles(
	dir: string,
	form: CommitStageForm | undefined,
	signal: AbortSignal | undefined,
): Promise<Listing | { degraded: StagedDeltaDegraded; detail: string }> {
	const head = await runGit(
		dir,
		["rev-parse", "--verify", "-q", "HEAD"],
		signal,
	);
	// `-q` exits 1 for a HEAD that does not exist yet; any other failure is a
	// read that did not answer.
	if (!head.ok && head.status !== 1)
		return { degraded: head.reason, detail: "reading HEAD" };
	const base = head.ok ? "HEAD" : EMPTY_TREE;
	const reads: Array<{ args: string[]; fromIndex: boolean }> = [];
	const source = form?.source;
	if (source === undefined) {
		reads.push({ args: [...RAW_DIFF, base], fromIndex: false });
		reads.push({ args: [...RAW_DIFF, "--cached", base], fromIndex: true });
	} else {
		if (source === "index" || source === "index+paths")
			reads.push({ args: [...RAW_DIFF, "--cached", base], fromIndex: true });
		if (source === "all")
			reads.push({ args: [...RAW_DIFF, base], fromIndex: false });
		if (source === "paths" || source === "index+paths")
			reads.push({
				args: [...RAW_DIFF, base, "--", ...(form?.pathspecs ?? [])],
				fromIndex: false,
			});
	}
	const merged = new Map<string, StagedEntry>();
	for (const read of reads) {
		const out = await runGit(dir, read.args, signal);
		if (!out.ok) return { degraded: out.reason, detail: "listing the files" };
		const parsed = parseRawDiff(out.stdout, read.fromIndex);
		if (!parsed)
			return { degraded: "git_failed", detail: "reading the listing" };
		for (const entry of parsed) {
			const known = merged.get(entry.path);
			// A file a working-tree read also lists commits its working bytes.
			merged.set(entry.path, {
				...entry,
				fromIndex: entry.fromIndex && (known?.fromIndex ?? true),
			});
		}
	}
	if (source === undefined) {
		const untracked = await runGit(
			dir,
			["ls-files", "-o", "--exclude-standard", "-z"],
			signal,
		);
		if (!untracked.ok)
			return { degraded: untracked.reason, detail: "listing untracked files" };
		for (const file of untracked.stdout.split("\0").filter(Boolean))
			if (!merged.has(file))
				merged.set(file, { path: file, status: "?", fromIndex: false });
	}
	return {
		base,
		entries: [...merged.values()],
		superset: source === undefined,
	};
}

export interface StagedDeltaDeps {
	cwd: string;
	projectRoot: string;
	getFlag: (flag: string) => boolean | string | undefined;
	signal?: AbortSignal;
}

/**
 * The staged-delta verdict for one `git commit` command: a verdict per the
 * added lines of each file it carries. A degraded read is recorded once per reason and session
 * (`staged-delta-degraded`).
 */
async function judgeStagedDelta(
	toolName: string,
	input: unknown,
	deps: StagedDeltaDeps,
): Promise<StagedDeltaVerdict> {
	if (!mayRunGitCommit(toolName, input)) return { kind: "not_a_commit" };
	const segments = readGuardedSegments(toolName, input, deps.cwd);
	// The forms this reads: every git segment a plain commit or a read-only
	// verb, each commit option listed. Anything else judges the superset, in
	// the directory the command starts in (the best this can name).
	const commits = segments?.guarded.filter((segment) => segment.commit) ?? [];
	const requests: Array<{
		dir: string;
		form: CommitStageForm | undefined;
		/** The directory is the commit's own, not the one the shell starts in. */
		placed: boolean;
	}> =
		segments && !segments.indexMayChange && commits.length > 0
			? commits.map((commit) => ({
					dir: commit.directory,
					form: parseCommitStageForm(commit.args),
					placed: true,
				}))
			: [{ dir: deps.cwd, form: undefined, placed: false }];
	let judged = 0;
	for (const request of requests) {
		const outcome = await judgeOne(request, deps);
		if (outcome.kind === "degraded")
			recordDegradationOnce({
				kind: "staged-delta-degraded",
				subject: outcome.reason,
				reason: outcome.detail,
			});
		if (outcome.kind !== "clean") return outcome;
		judged += outcome.files;
	}
	return { kind: "clean", files: judged };
}

async function judgeOne(
	{
		dir,
		form,
		placed,
	}: { dir: string; form: CommitStageForm | undefined; placed: boolean },
	deps: StagedDeltaDeps,
): Promise<StagedDeltaVerdict> {
	const toplevel = await runGit(
		dir,
		["rev-parse", "--show-toplevel"],
		deps.signal,
	);
	if (!toplevel.ok) {
		// git itself says the directory is no repository (exit 128): a commit
		// there fails on its own, so it carries nothing. A command that may
		// start elsewhere (a `cd`) is no such answer: it cannot be placed.
		if (toplevel.status === 128 && placed) return { kind: "clean", files: 0 };
		return {
			kind: "degraded",
			reason: toplevel.status === 128 ? "no_checkout" : toplevel.reason,
			detail: "finding the repository the commit runs in",
		};
	}
	const top = resolveGitCheckout(dir)?.spelledRoot ?? toplevel.stdout.trim();
	const listing = await listCommitFiles(dir, form, deps.signal);
	if ("degraded" in listing)
		return {
			kind: "degraded",
			reason: listing.degraded,
			detail: listing.detail,
		};
	const candidates = listing.entries.filter((entry) => entry.status !== "D");
	// The lanes read the working file; a staged file whose working bytes are not
	// the index's would be linted for bytes the commit does not carry.
	const indexed = candidates.filter((entry) => entry.fromIndex);
	if (indexed.length > 0 && !listing.superset) {
		const dirty = await runGit(dir, ["diff", "--name-only", "-z"], deps.signal);
		if (!dirty.ok)
			return {
				kind: "degraded",
				reason: dirty.reason,
				detail: "comparing the index with the working files",
			};
		const unstaged = new Set(dirty.stdout.split("\0").filter(Boolean));
		const differing = indexed.filter((entry) => unstaged.has(entry.path));
		if (differing.length > 0)
			return {
				kind: "degraded",
				reason: "bytes_not_staged",
				detail: `${differing[0]?.path ?? "a file"} differs from the index`,
			};
	}
	const wholeFile = deps.getFlag("no-delta") === true;
	const findings: Array<{ file: string; body: string }> = [];
	let judged = 0;
	for (let at = 0; at < candidates.length; at += LANE_CONCURRENCY) {
		const chunk = candidates.slice(at, at + LANE_CONCURRENCY);
		const results = await Promise.all(
			chunk.map((entry) =>
				judgeFile(entry, top, listing.base, wholeFile, deps),
			),
		);
		for (const result of results) {
			if ("degraded" in result)
				return {
					kind: "degraded",
					reason: result.degraded,
					detail: result.detail,
				};
			if (result.judged) judged += 1;
			if (result.body) findings.push({ file: result.file, body: result.body });
		}
	}
	if (findings.length === 0) return { kind: "clean", files: judged };
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
	entry: StagedEntry,
	top: string,
	base: string,
	wholeFile: boolean,
	deps: StagedDeltaDeps,
): Promise<
	| { judged: boolean; file: string; body?: string }
	| { degraded: StagedDeltaDegraded; detail: string }
> {
	const abs = path.resolve(top, entry.path);
	const file = toProjectRelativePath(abs, deps.projectRoot);
	try {
		if (!nodeFs.lstatSync(abs).isFile()) return { judged: false, file };
	} catch {
		// none: a path that is gone has no bytes to judge (a file the commit
		// deletes is listed `D` and never reaches here).
		return { judged: false, file };
	}
	if (
		isExternalOrVendorFile(abs, deps.projectRoot) ||
		isPathIgnoredByProject(abs, deps.projectRoot, false)
	)
		return { judged: false, file };
	let ranges: Array<[number, number]> | undefined;
	if (!wholeFile && (entry.status === "M" || entry.status === "R")) {
		const diff = await runGit(
			path.dirname(abs),
			[
				"diff",
				"-U0",
				"--no-color",
				"--no-ext-diff",
				"--no-textconv",
				"-M",
				base,
				"--",
				...(entry.from === undefined ? [] : [path.resolve(top, entry.from)]),
				abs,
			],
			deps.signal,
		);
		if (!diff.ok)
			return { degraded: diff.reason, detail: `reading the diff of ${file}` };
		ranges = parseAddedRanges(diff.stdout);
		if (ranges.length === 0) return { judged: false, file };
	}
	const integration = await loadDispatchIntegration();
	const run = await integration
		.collectStagedLaneBlockers(abs, deps.projectRoot, {
			getFlag: deps.getFlag,
		})
		.catch((cause: unknown) => {
			const failure = cause instanceof Error ? cause.message : String(cause);
			recordDegradationOnce({
				kind: "staged-delta-degraded",
				subject: "lane_incomplete",
				reason: `a lane run threw: ${failure}`,
			});
			return { status: "failed", failure } as const;
		});
	if (run.status === "failed")
		return { degraded: "lane_incomplete", detail: `${file}: ${run.failure}` };
	if (run.status === "skipped") {
		if (run.reason === "unreadable")
			return { degraded: "file_unreadable", detail: file };
		return { judged: false, file };
	}
	const added = run.blockers.filter(
		(blocker) =>
			ranges === undefined ||
			blocker.line === undefined ||
			ranges.some(
				([start, end]) => blocker.line! >= start && blocker.line! <= end,
			),
	);
	if (added.length === 0) return { judged: true, file };
	const policy = applyInlineBlockerPolicy(
		{ filePath: abs, summary: "", diagnostics: added as Diagnostic[] },
		deps.projectRoot,
	);
	if (policy.kept === 0) return { judged: true, file };
	return { judged: true, file, body: policy.body ?? "" };
}

/** What clears each degraded read: each names an action the next attempt reads afresh. */
const DEGRADED_REMEDY: Readonly<Record<StagedDeltaDegraded, string>> = {
	bytes_not_staged:
		"Stage the file's current bytes (git add <file>) so the commit carries what pi-lens checked, then commit again.",
	lane_incomplete:
		"pi-lens could not finish checking the staged files in time. Commit again; commit fewer files at once if it repeats.",
	file_unreadable:
		"pi-lens could not read a staged file. Make it readable, then commit again.",
	git_failed:
		"pi-lens could not read the staged files from git. Commit from inside the repository (git -C <dir> commit for another one), then commit again.",
	git_output_cut:
		"The staged set is too large for pi-lens to read in one commit. Commit fewer files at once.",
	no_checkout:
		"The commit's directory is in no git checkout pi-lens can read. Commit from inside the repository (git -C <dir> commit for another one).",
};

/** The gate's answer to the staged-delta read of one commit command. */
export function stagedDeltaDecision(
	cwd: string,
	verdict: StagedDeltaVerdict,
): GuardDecision {
	if (verdict.kind === "not_a_commit") return { block: false };
	if (verdict.kind === "clean") {
		logDecision(cwd, "allowed", "staged_delta_clean", { files: verdict.files });
		return { block: false };
	}
	if (verdict.kind === "degraded")
		return unknown(
			cwd,
			`staged_delta_${verdict.reason}`,
			{},
			DEGRADED_REMEDY[verdict.reason],
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
 * listing and the lanes over each file the commit carries). `tool_call` has no
 * budget of its own (clients/hook-budgets.ts), so the read carries its own.
 */
export const STAGED_DELTA_BUDGET_MS = 20_000;

/**
 * The gate's one entry for the staged-delta read: the verdict for the commit
 * command `input`, as the decision `tool_call` returns. A read that gives no
 * answer inside `budgetMs` refuses as degraded, never allows.
 */
export async function gateStagedDelta(
	toolName: string,
	input: unknown,
	deps: Omit<StagedDeltaDeps, "signal">,
	signal: AbortSignal | undefined,
	budgetMs: number = STAGED_DELTA_BUDGET_MS,
): Promise<GuardDecision> {
	const verdict = await bounded(
		(workSignal) =>
			judgeStagedDelta(toolName, input, { ...deps, signal: workSignal }),
		{
			ms: budgetMs,
			signal,
			hook: "tool_call",
			label: "staged-delta-gate",
		},
	);
	if (verdict === undefined)
		recordDegradationOnce({
			kind: "staged-delta-degraded",
			subject: "lane_incomplete",
			reason: "the staged-delta read gave no answer inside its bound",
		});
	return stagedDeltaDecision(
		deps.cwd,
		verdict ?? {
			kind: "degraded",
			reason: "lane_incomplete",
			detail: "the staged-delta read gave no answer inside its bound",
		},
	);
}
