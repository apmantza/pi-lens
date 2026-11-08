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
import * as path from "node:path";
import { measureFile } from "./function-metrics.js";
import { normalizeMapKey, realpathOrResolve } from "../path-utils.js";
import { safeSpawnAsync } from "../safe-spawn.js";
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
	main: MainBaseline;
	/** Undefined when the file could not be measured (unparsable, missing). */
	last: FunctionTable | undefined;
}

/** Files one session keeps a baseline for (LRU). */
export const MAX_BASELINE_FILES = 256;
/** Functions one table keeps, in source order; the rest are not judged. */
export const MAX_TABLE_FUNCTIONS = 512;
/** The advisory's byte budget on the tool result (#5087 acceptance). */
export const MAX_ADVISORY_BYTES = 240;
/** A default-branch blob larger than this is not measured. */
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 2_000;

/** The key a session's baseline store uses for `filePath`. */
export function complexityBaselineKey(filePath: string): string {
	return normalizeMapKey(path.resolve(filePath));
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
	const client = getSharedTreeSitterClient();
	if (!client || !(await client.init())) return undefined;
	const parsed = await client.withParsedTree(
		treeKey,
		languageId,
		content,
		(tree) => measureFile(tree.rootNode as TsNode, languageId).functions,
		"complexity-baseline",
	);
	if (!parsed.parsed) return undefined;
	const table = new Map<string, FunctionValues>();
	for (const fn of parsed.value) {
		if (table.size >= MAX_TABLE_FUNCTIONS) break;
		table.set(fn.key, {
			name: fn.name,
			cyclomatic: fn.cyclomatic,
			nesting: fn.nesting,
		});
	}
	return table;
}

/** The nearest existing directory at or above `start`. */
function existingDir(start: string): string | undefined {
	let dir = start;
	for (;;) {
		try {
			if (fs.statSync(dir).isDirectory()) return dir;
		} catch {
			// Not there yet (a file a write is about to create): climb.
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
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
		{ cwd, timeout: GIT_TIMEOUT_MS, signal, resourceLabel: "complexity-main" },
	);
	if (result.status !== 0) return { unavailable: "not-a-git-repository" };
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
	const cwd = existingDir(path.dirname(target));
	if (!cwd) return { kind: "unavailable", reason: "no-directory" };
	const branch = await resolveDefaultBranch(cwd, signal);
	if ("unavailable" in branch)
		return { kind: "unavailable", reason: branch.unavailable };
	const relative = path.relative(cwd, target).split(path.sep).join("/");
	const shown = await safeSpawnAsync(
		"git",
		["show", `${branch.ref}:./${relative}`],
		{
			cwd,
			timeout: GIT_TIMEOUT_MS,
			signal,
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
	// git names a missing path two ways: absent from the tree, or present on
	// disk but not in the ref.
	if (/does not exist|exists on disk, but not in/.test(shown.stderr))
		return { kind: "absent", ref };
	return { kind: "unavailable", reason: "git-show-failed" };
}

/**
 * The first-touch baseline of `filePath`: the file on disk now (before the
 * tool runs) and the file on the default branch. Never rejects; a file
 * neither side can measure still gets an entry, so the session asks once.
 */
export async function captureComplexityBaseline(
	filePath: string,
	signal?: AbortSignal,
): Promise<ComplexityBaseline | undefined> {
	if (signal?.aborted) return undefined;
	try {
		let onDisk: string | undefined;
		try {
			onDisk = fs.readFileSync(filePath, "utf-8");
		} catch {
			onDisk = undefined;
		}
		const last =
			onDisk === undefined
				? undefined
				: await measureFunctionTable(filePath, onDisk);
		const main = await mainBaselineOf(filePath, signal);
		if (signal?.aborted) return undefined;
		return { main, last };
	} catch {
		return undefined;
	}
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
	baseline: ComplexityBaseline | undefined,
	after: FunctionTable,
	thresholds: Thresholds,
): WorsenedFunction[] {
	const last = baseline?.last;
	const main = baseline?.main;
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
export function baselineLabel(
	baseline: ComplexityBaseline | undefined,
): string {
	const main = baseline?.main;
	if (main?.kind === "file" || main?.kind === "absent") return main.ref;
	return "session start";
}

function renderFunction(fn: WorsenedFunction): string {
	const parts = fn.changes.map(
		(c) =>
			`${METRIC_LABEL[c.metric]} ${c.before === undefined ? "new" : c.before}→${c.after} (≥${c.threshold})`,
	);
	return `${fn.key} ${parts.join(", ")}`;
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
	const head = `⚠ complexity vs ${label}: `;
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
