/**
 * Per-function complexity baselines and the per-edit delta (#5087).
 *
 * A file's baseline is taken once per session, at its first touch
 * (`tool_call`), and holds two tables of {@link FunctionValues} keyed by the
 * seam's function key (`measureFile`, #5087 S2-2):
 *
 * - `main`: the file as it is on the repository's default branch (the
 *   target of `origin/HEAD`, else `main`, else `master`). An edit is judged
 *   against this, so the advice is "worse than main", not "worse than the
 *   first time this session looked".
 * - `last`: the bytes the session last measured: the pre-edit file at first
 *   touch, then each edit's result. A function this edit did not change is
 *   never reported, however far it sits from main.
 *
 * Where the default branch cannot be read (no repository, no default
 * branch, a spawn failure), the session's first-touch table stands in for
 * it, and the advice names that baseline instead.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { BoundedLruCache } from "../bounded-cache.js";
import type { GenerationHandle } from "../generation-guard.js";
import { logLatency } from "../latency-logger.js";
import { recordDegradationOnce } from "../degradation-ledger.js";
import {
	ANONYMOUS_KEY,
	measureFile,
	type NamedFunctionMetrics,
} from "./function-metrics.js";
import {
	normalizeMapKey,
	realpathOrResolve,
	walkUpDirs,
} from "../path-utils.js";
import { safeSpawnAsync, type SpawnResult } from "../safe-spawn.js";
import {
	getSharedTreeSitterClient,
	isComplexityLanguageId,
	resolveTreeSitterLanguage,
	type TsNode,
} from "../tree-sitter-shared.js";

export interface FunctionValues {
	name: string;
	cyclomatic: number;
	nesting: number;
}

/** Function key → values, in source order. */
export type FunctionTable = ReadonlyMap<string, FunctionValues>;

export type MainBaseline =
	/** The default branch holds the file: these are its functions. */
	| { kind: "file"; ref: string; functions: FunctionTable }
	/** The default branch has no such file: every function is new. */
	| { kind: "absent"; ref: string }
	/** The default branch could not be read; `reason` says why. */
	| { kind: "unavailable"; reason: string };

export interface ComplexityBaseline {
	/**
	 * The default branch's table, read at the file's first edit (most first
	 * touches are reads that never edit, and the read costs two `git`
	 * spawns); undefined until then.
	 */
	main: MainBaseline | undefined;
	/** Undefined when the file could not be measured (unparsable, missing). */
	last: FunctionTable | undefined;
}

/** Files one session keeps a baseline for (LRU). */
export const MAX_BASELINE_FILES = 256;
/** Functions one table keeps, in source order; the rest are not judged. */
export const MAX_TABLE_FUNCTIONS = 512;
/** The advisory's byte budget on the tool result (#5087 acceptance). */
export const MAX_ADVISORY_BYTES = 240;
/** A default-branch blob larger than this is not read. */
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
/**
 * Input over this many bytes is not measured. Keying a file's functions is
 * superlinear in their count, and a parse cannot be interrupted. Measured
 * with `measureFunctionTable` on the built twin, dense one-line functions
 * (`function aN(){}`), after a warm-up call: 128 KiB 267 ms, 256 KiB 430 ms,
 * 512 KiB 1401 ms, 1 MiB 5006 ms. 256 KiB keeps the worst case near the
 * first touch's 500 ms budget and is far above a hand-written source file.
 */
export const MAX_MEASURED_BYTES = 256 * 1024;
/** The advisory names a baseline and a function at most this many bytes long. */
const MAX_LABEL_BYTES = 40;
const MAX_NAME_BYTES = 80;
const GIT_TIMEOUT_MS = 2_000;

/** The key a session's baseline store uses for `filePath`. */
export function complexityBaselineKey(filePath: string): string {
	return normalizeMapKey(nodePath.resolve(filePath));
}

/** Whether `content` is too large to measure ({@link MAX_MEASURED_BYTES}). */
function overMeasureCap(content: string): boolean {
	return Buffer.byteLength(content, "utf-8") > MAX_MEASURED_BYTES;
}

/**
 * The baseline table of functions `measureFile` measured: named functions
 * only, at most {@link MAX_TABLE_FUNCTIONS}, in source order.
 */
function functionTableOf(
	functions: readonly NamedFunctionMetrics[],
): FunctionTable {
	const table = new Map<string, FunctionValues>();
	for (const fn of functions) {
		// An anonymous function's key is its position among its siblings: an edit
		// that adds a callback above shifts it, and the agent cannot act on
		// `<anonymous>#2`. Test-suite organizers (#577) are anonymous too.
		if (fn.key.includes(ANONYMOUS_KEY)) continue;
		if (table.size >= MAX_TABLE_FUNCTIONS) break;
		table.set(fn.key, {
			name: fn.name,
			cyclomatic: fn.cyclomatic,
			nesting: fn.nesting,
		});
	}
	return table;
}

/**
 * Measure `content` as `filePath`'s language. `treeKey` keys the shared
 * parser's tree cache: a default-branch blob passes its own, so measuring it
 * never evicts the hot tree of the file on disk.
 */
export async function measureFunctionTable(
	filePath: string,
	content: string,
	treeKey: string = filePath,
): Promise<FunctionTable | undefined> {
	const languageId = resolveTreeSitterLanguage(filePath);
	if (!languageId || !isComplexityLanguageId(languageId)) return undefined;
	if (overMeasureCap(content)) return undefined;
	const client = getSharedTreeSitterClient();
	if (!client || !(await client.init())) return undefined;
	const parsed = await client.withParsedTree(
		treeKey,
		languageId,
		content,
		(tree) => measureFile(tree.rootNode as TsNode, languageId).functions,
		"complexity-baseline",
	);
	return parsed.parsed ? functionTableOf(parsed.value) : undefined;
}

/** Why a git spawn gave no answer: its failure kind, else `fallback`. */
function gitFailureReason(result: SpawnResult, fallback: string): string {
	return result.failure ? `git-${result.failure}` : fallback;
}

/**
 * The nearest existing directory at or above `start`: a file a write is about
 * to create may sit in a directory that does not exist yet.
 */
function existingDir(start: string): string | undefined {
	for (const dir of walkUpDirs(start)) {
		if (fs.existsSync(dir)) return dir;
	}
	return undefined;
}

/** Preference order for the default branch when `origin/HEAD` is unset. */
const DEFAULT_BRANCH_REFS = [
	"refs/heads/main",
	"refs/heads/master",
	"refs/remotes/origin/main",
	"refs/remotes/origin/master",
];

function shortRef(ref: string): string {
	return ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
}

/**
 * The default branch of the repository `cwd` is in: `origin/HEAD`'s target,
 * else the first of {@link DEFAULT_BRANCH_REFS} that exists.
 */
async function resolveDefaultBranch(
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<{ ref: string } | { unavailable: string }> {
	const result = await safeSpawnAsync(
		"git",
		[
			"for-each-ref",
			"--format=%(refname)%09%(symref)",
			"refs/remotes/origin/HEAD",
			...DEFAULT_BRANCH_REFS,
		],
		{
			cwd,
			timeout: GIT_TIMEOUT_MS,
			...(signal && { signal }),
			resourceLabel: "complexity-main",
		},
	);
	if (result.status !== 0)
		return { unavailable: gitFailureReason(result, "not-a-git-repository") };
	const rows = new Map<string, string>();
	for (const line of result.stdout.split("\n")) {
		const [ref, symref] = line.split("\t");
		if (ref) rows.set(ref, symref ?? "");
	}
	const originHead = rows.get("refs/remotes/origin/HEAD");
	if (originHead) return { ref: originHead };
	const found = DEFAULT_BRANCH_REFS.find((ref) => rows.has(ref));
	return found ? { ref: found } : { unavailable: "no-default-branch" };
}

/**
 * `filePath` as the default branch holds it. One `for-each-ref` and one
 * `git show`, from the file's own directory, so a file link answers its
 * target's repository (#4966).
 */
export async function readAtDefaultBranch(
	filePath: string,
	signal?: AbortSignal,
): Promise<
	| { kind: "file"; ref: string; content: string }
	| { kind: "absent"; ref: string }
	| { kind: "unavailable"; reason: string }
> {
	const target = realpathOrResolve(filePath);
	const cwd = existingDir(nodePath.dirname(target));
	if (!cwd) return { kind: "unavailable", reason: "no-directory" };
	const branch = await resolveDefaultBranch(cwd, signal);
	if ("unavailable" in branch)
		return { kind: "unavailable", reason: branch.unavailable };
	const relative = nodePath.relative(cwd, target).split(nodePath.sep).join("/");
	const shown = await safeSpawnAsync(
		"git",
		["show", `${branch.ref}:./${relative}`],
		{
			cwd,
			timeout: GIT_TIMEOUT_MS,
			...(signal && { signal }),
			maxOutputBytes: MAX_BLOB_BYTES,
			resourceLabel: "complexity-main",
		},
	);
	const ref = shortRef(branch.ref);
	if (shown.status === 0) {
		if (shown.outputTruncated)
			return { kind: "unavailable", reason: "blob-too-large" };
		return { kind: "file", ref, content: shown.stdout };
	}
	if (shown.failure)
		return { kind: "unavailable", reason: `git-${shown.failure}` };
	// git names a missing path two ways: absent from the tree, or present on
	// disk but not in the ref.
	if (/does not exist|exists on disk, but not in/.test(shown.stderr))
		return { kind: "absent", ref };
	return { kind: "unavailable", reason: "git-show-failed" };
}

/**
 * The first-touch baseline of a file: the functions the `tool_call` measured
 * on disk, before the tool runs (`ComplexityClient.analyzeFile`'s
 * `measuredFunctions`, so the first touch measures the file once, #5443
 * review F6). The default branch's copy waits for the first edit
 * ({@link adviseOnEdit}). A file that could not be measured (`undefined`: no
 * bytes yet, unreadable or unparsable) still gets an entry, so the session
 * asks once.
 */
export function captureComplexityBaseline(
	measured: readonly NamedFunctionMetrics[] | undefined,
): ComplexityBaseline {
	return {
		main: undefined,
		last: measured ? functionTableOf(measured) : undefined,
	};
}

async function mainBaselineOf(
	filePath: string,
	signal: AbortSignal | undefined,
): Promise<MainBaseline> {
	const blob = await readAtDefaultBranch(filePath, signal);
	if (blob.kind !== "file") return blob;
	const functions = await measureFunctionTable(
		filePath,
		blob.content,
		`${filePath}\0${blob.ref}`,
	);
	return functions
		? { kind: "file", ref: blob.ref, functions }
		: { kind: "unavailable", reason: "default-branch-unparsable" };
}

export interface Thresholds {
	cyclomatic: number;
	nesting: number;
}

type Metric = keyof Thresholds;
const METRICS: readonly Metric[] = ["cyclomatic", "nesting"];
const METRIC_LABEL: Record<Metric, string> = {
	cyclomatic: "cc",
	nesting: "nest",
};

export interface MetricChange {
	metric: Metric;
	/** The baseline value; undefined for a function the baseline lacks. */
	before: number | undefined;
	after: number;
	threshold: number;
}

export interface WorsenedFunction {
	key: string;
	name: string;
	changes: MetricChange[];
}

/**
 * The functions an edit made worse: for each metric, the edit raised it
 * (against `last`), it is worse than the baseline (main, or `last` where main
 * is unavailable), and it is at or past the threshold. An unchanged or
 * improved function is never returned.
 */
export function worsenedFunctions(
	entry: ComplexityBaseline | undefined,
	after: FunctionTable,
	thresholds: Thresholds,
): WorsenedFunction[] {
	const last = entry?.last;
	const main = entry?.main;
	const out: WorsenedFunction[] = [];
	for (const [key, now] of after) {
		const prior = last?.get(key);
		const reference =
			main?.kind === "file"
				? main.functions.get(key)
				: main?.kind === "absent"
					? undefined
					: prior;
		const changes: MetricChange[] = [];
		for (const metric of METRICS) {
			const threshold = thresholds[metric];
			const value = now[metric];
			if (value < threshold) continue;
			if (prior !== undefined && value <= prior[metric]) continue;
			if (reference !== undefined && value <= reference[metric]) continue;
			changes.push({
				metric,
				before: reference?.[metric],
				after: value,
				threshold,
			});
		}
		if (changes.length > 0) out.push({ key, name: now.name, changes });
	}
	const excess = (fn: WorsenedFunction) =>
		Math.max(...fn.changes.map((c) => c.after - c.threshold));
	return out.sort((a, b) => excess(b) - excess(a));
}

/** The label the advisory names its baseline by. */
export function baselineLabel(entry: ComplexityBaseline | undefined): string {
	const main = entry?.main;
	if (main?.kind === "file" || main?.kind === "absent") return main.ref;
	return "session start";
}

/**
 * `text` on one line and at most `maxBytes` UTF-8 bytes, ending in `…` where
 * it was cut. A name is source text: it can hold a newline or run long.
 */
function oneLine(text: string, maxBytes: number): string {
	const flat = text.replace(/\s+/g, " ");
	if (Buffer.byteLength(flat, "utf-8") <= maxBytes) return flat;
	let out = "";
	let bytes = Buffer.byteLength("…", "utf-8");
	for (const char of flat) {
		bytes += Buffer.byteLength(char, "utf-8");
		if (bytes > maxBytes) break;
		out += char;
	}
	return `${out}…`;
}

function renderFunction(fn: WorsenedFunction): string {
	const parts = fn.changes.map(
		(c) =>
			`${METRIC_LABEL[c.metric]} ${c.before === undefined ? "new" : c.before}→${c.after} (≥${c.threshold})`,
	);
	return `${oneLine(fn.key, MAX_NAME_BYTES)} ${parts.join(", ")}`;
}

/**
 * One line of at most {@link MAX_ADVISORY_BYTES} bytes, or `undefined` when
 * nothing worsened. Functions that do not fit are counted as `+N more`.
 */
export function formatComplexityAdvisory(
	worsened: readonly WorsenedFunction[],
	label: string,
	maxBytes: number = MAX_ADVISORY_BYTES,
): string | undefined {
	if (worsened.length === 0) return undefined;
	const head = `⚠ complexity vs ${oneLine(label, MAX_LABEL_BYTES)}: `;
	const bytes = (s: string) => Buffer.byteLength(s, "utf-8");
	const shown: string[] = [];
	for (let i = 0; i < worsened.length; i++) {
		const next = [...shown, renderFunction(worsened[i]!)];
		const rest = worsened.length - next.length;
		const line = `${head}${next.join("; ")}${rest > 0 ? `; +${rest} more` : ""}`;
		if (bytes(line) > maxBytes) break;
		shown.push(next[next.length - 1]!);
	}
	const rest = worsened.length - shown.length;
	if (shown.length === 0) {
		const only = `${head}${worsened.length} function${worsened.length === 1 ? "" : "s"} worse`;
		return bytes(only) <= maxBytes ? only : undefined;
	}
	return `${head}${shown.join("; ")}${rest > 0 ? `; +${rest} more` : ""}`;
}

/** What {@link adviseOnEdit} decided, for its caller and its log row. */
export interface EditComplexityVerdict {
	/** The tool-result line, when a function got worse. */
	advisory: string | undefined;
	/** Functions the edit made worse, shown or not. */
	worsened: number;
	/** What the edit was judged against: a ref or `session start`. */
	against: string;
}

/**
 * Judge an edit that has landed on disk: measure `filePath` now, compare it
 * with its baseline (taken at first touch), and store the new table as the
 * file's `last` through `session`, so the next edit is judged on its own
 * change. A file with no stored baseline only stores its table. `undefined`
 * when the file cannot be measured, the edit is aborted (nothing stored), or
 * there are no thresholds (nothing judged or stored).
 */
export async function adviseOnEdit(args: {
	filePath: string;
	store: BoundedLruCache<string, ComplexityBaseline>;
	session: Pick<GenerationHandle, "guardedWrite">;
	/** Undefined when the file's rule policy switches the line off. */
	thresholds: Thresholds | undefined;
	signal?: AbortSignal | undefined;
}): Promise<EditComplexityVerdict | undefined> {
	const { filePath, store, session, thresholds, signal } = args;
	if (!thresholds) return undefined;
	const startedAt = Date.now();
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		// none: the edit removed or moved the file before this read; there is
		// no function left to judge, and the next edit of it measures afresh.
		return undefined;
	}
	if (overMeasureCap(content)) {
		recordDegradationOnce({
			kind: "complexity-delta-failed",
			subject: filePath,
			reason: `the file is over ${MAX_MEASURED_BYTES} bytes; its functions are not judged`,
		});
		return undefined;
	}
	const after = await measureFunctionTable(filePath, content);
	if (!after || signal?.aborted) return undefined;
	const key = complexityBaselineKey(filePath);
	const held = store.get(key);
	// No stored entry (evicted, or the file's first touch was not a tool_call
	// the session saw): there is no `last` to tell what this edit changed, so
	// it stores the table, runs no git and advises nothing.
	const main = held
		? (held.main ?? (await mainBaselineOf(filePath, signal)))
		: undefined;
	// An abort mid-read says nothing about the repository: store nothing, so
	// the next edit reads main afresh.
	if (signal?.aborted) return undefined;
	const entry: ComplexityBaseline = { main, last: held?.last };
	const worsened = held ? worsenedFunctions(entry, after, thresholds) : [];
	const label = baselineLabel(entry);
	const advisory = formatComplexityAdvisory(worsened, label);
	session.guardedWrite(filePath, () =>
		store.set(key, { main: entry.main, last: after }),
	);
	logLatency({
		type: "phase",
		phase: "complexity_delta",
		filePath,
		durationMs: Date.now() - startedAt,
		metadata: {
			against: label,
			main:
				entry.main?.kind === "unavailable"
					? `unavailable:${entry.main.reason}`
					: entry.main?.kind,
			functions: after.size,
			worsened: worsened.length,
			advised: advisory !== undefined,
		},
	});
	return { advisory, worsened: worsened.length, against: label };
}
