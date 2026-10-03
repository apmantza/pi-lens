/**
 * Restore agent edits that a whole-package fixer run overwrote (#3598).
 *
 * `cargo clippy --fix` and `dart fix --apply` rewrite every fixable file of the
 * crate or package, but the pipeline's hold on pi's file-mutation queue covers
 * only the edit's own target (#3541, #3506). An agent edit to a SIBLING file
 * that lands while the tool runs is then erased by the tool's write, because
 * the tool read that file before the edit.
 *
 * Maintainer decision on #3598 (option 3, detect and restore; options 1 and 2
 * were rejected because queueing every crate file breaks the single lock
 * order and running on a copy needs a per-file apply):
 *
 * 1. Before the run, hash the files the tool can rewrite ({@link beginFixRun}).
 * 2. During the run, capture the bytes of any of those files pi-lens observes
 *    an agent mutate ({@link noteAgentMutation}, called from the tool_result
 *    seam and from the mutation bridge that observed-mutation replays through),
 *    and note the agent's mutating tool calls that are still in flight
 *    ({@link noteAgentCallStart} / {@link noteAgentCallEnd}).
 * 3. After the run, write the captured bytes back over the tool's write and
 *    record ONE degradation for the run ({@link FixRun.finish}).
 * 4. A file the tool created is not in the pre-run set and is left alone.
 * 5. An edit pi-lens cannot show survived is reported by file name, so the
 *    agent can re-apply it.
 *
 * ## The restore invariant (#3741 round 2)
 *
 * The restore never writes over content NEWER than the capture, and never
 * recreates a file that is absent at restore time. It writes only a file the
 * tool demonstrably rewrote after the capture. For each captured file, at
 * settle:
 *
 * | at settle                                   | outcome                     |
 * | ------------------------------------------- | --------------------------- |
 * | absent (agent deleted or renamed it)        | nothing; never recreated    |
 * | an agent call on it is still in flight      | not written; possibly lost  |
 * | bytes equal the capture                     | nothing                     |
 * | changed again while the restore was reading | not written; possibly lost  |
 * | otherwise (the tool rewrote it after)       | capture written back        |
 *
 * ## What the capture can prove
 *
 * A native `write` or `edit` says what it wrote, so the capture is checked
 * against it, with line endings normalised (pi's edit tool matches in LF and
 * writes the file back in its own): a `write`'s whole content, or per edit the
 * `newText` that must be present and the `oldText` that must be gone. A
 * mismatch means the tool overwrote the edit before it was read: LOST. A
 * capture that nothing can check (a bridged, observed or bash producer, or an
 * edit with neither a `newText` nor a removable `oldText`) is reported as
 * POSSIBLY lost, never silently accepted: pi-lens cannot tell whether the tool
 * wrote between the agent's write and its read.
 *
 * ## The set is bounded to what the tool can rewrite
 *
 * The caller passes the project walk it already took for its changed-file diff
 * (ignored and vendor directories excluded, capped at its scan limit). This
 * module keeps only the files with the tool's source extension (`.rs`,
 * `.dart`), skips any file over {@link FIX_RUN_MAX_FILE_BYTES}, and stops
 * hashing at {@link FIX_RUN_HASH_BYTE_BUDGET}; a cut set is recorded, never
 * silent, and every run records its files, bytes and milliseconds.
 *
 * ## Residual, stated
 *
 * - The restore is a compare-then-write outside pi's queue for that file.
 *   Taking a second queue while the pipeline holds the target's is the lock
 *   order break option 1 was rejected for. The re-stat just before the write
 *   narrows the window to one syscall gap; it does not close it.
 * - "In flight" is known only for calls that pass pi-lens's tool_call seam with
 *   a correlation id. A bash or bridged producer whose write lands during the
 *   run and whose bytes were never captured, on a file the tool did not touch,
 *   is neither seen nor restored over when no capture exists for the file;
 *   on a file the tool DID touch it is the unverifiable case above.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { writeFileAtomicAsync } from "./atomic-write.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { logLatency } from "./latency-logger.js";
import { normalizeMapKey } from "./path-utils.js";
import { getProcessSingleton } from "./process-singletons.js";
import { compareOrdinal } from "./string-utils.js";

/** A file over this size is not a hand-written source file; it is not covered. */
export const FIX_RUN_MAX_FILE_BYTES = 1024 * 1024;

/** Total bytes hashed before a run. Files past it are not covered. */
export const FIX_RUN_HASH_BYTE_BUDGET = 64 * 1024 * 1024;

const HASH_CONCURRENCY = 32;

/** What the agent's own tool result says it wrote, when it says. */
export interface AgentWriteExpectation {
	/** A `write`: the whole file. */
	content?: string;
	/** An `edit`: each applied edit, as the executed input states it. */
	edits?: ReadonlyArray<{ oldText?: string; newText: string }>;
}

/** `verified`: bytes match the agent's stated write. `overwritten`: they do not. */
type CaptureVerdict = "verified" | "overwritten" | "unverifiable";

interface StatIdentity {
	mtimeMs: number;
	size: number;
	ino: number;
}

interface Capture {
	bytes: Buffer;
	verdict: CaptureVerdict;
}

interface CoveredFile {
	filePath: string;
	hash: string;
	capture?: Capture;
}

interface ActiveRun {
	files: Map<string, CoveredFile>;
	/** Agent mutating tool calls started and not yet delivered: id -> file key. */
	calls: Map<string, string>;
}

export interface FixRunReport {
	/** Files whose captured agent bytes were written back over the tool's. */
	restored: string[];
	/** Files whose agent edit is known gone: the capture shows the tool's bytes. */
	lost: string[];
	/** Files whose agent edit may be gone: unverifiable, in flight, or moved again. */
	possiblyLost: string[];
	/** Files the agent mutated during the run, restored or not. */
	agentEdited: string[];
}

export interface FixRun {
	finish(): Promise<FixRunReport>;
}

/**
 * Run `run` (the fixer's spawn) with the pre-run hash set and the capture in
 * place, and settle the run whether `run` returns or throws: a tool that exits
 * nonzero or times out has usually already rewritten files.
 */
export async function runWithFixRestore<T>(
	args: Parameters<typeof beginFixRun>[0],
	run: () => Promise<T>,
): Promise<{ value: T; report: FixRunReport }> {
	const fixRun = await beginFixRun(args);
	let value: T;
	try {
		value = await run();
	} catch (failure) {
		await fixRun.finish();
		throw failure;
	}
	return { value, report: await fixRun.finish() };
}

interface Registry {
	active: Set<ActiveRun>;
}

const REGISTRY_FAMILY = "fix-run-restore";
const REGISTRY_VERSION = 1;

function registry(): Registry {
	return getProcessSingleton<Registry>(
		REGISTRY_FAMILY,
		REGISTRY_VERSION,
		() => ({
			active: new Set(),
		}),
	);
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function identityOf(stat: fs.Stats): StatIdentity {
	return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
}

function sameIdentity(a: StatIdentity, b: StatIdentity): boolean {
	return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

/**
 * Hash the tool's rewritable files and start capturing agent mutations of
 * them. Never throws: a file that cannot be read is simply not covered.
 * Always pair with `finish()` in a `finally`, or the run stays registered.
 */
export async function beginFixRun(args: {
	tool: string;
	/** The tool's source extension, with the dot. */
	extension: string;
	/** Absolute paths the caller's project walk found under the root. */
	candidates: Iterable<string>;
	byteBudget?: number;
}): Promise<FixRun> {
	const startedAt = Date.now();
	const files = new Map<string, CoveredFile>();
	const run: ActiveRun = { files, calls: new Map() };
	const wanted: string[] = [];
	for (const candidate of args.candidates)
		if (candidate.endsWith(args.extension)) wanted.push(candidate);
	wanted.sort(compareOrdinal);
	const budget = args.byteBudget ?? FIX_RUN_HASH_BYTE_BUDGET;
	let remaining = budget;
	let hashedBytes = 0;
	let cut = 0;
	for (let i = 0; i < wanted.length; i += HASH_CONCURRENCY) {
		const batch = wanted.slice(i, i + HASH_CONCURRENCY);
		const read = await Promise.all(
			batch.map(async (candidate) => {
				try {
					const stat = await fs.promises.stat(candidate);
					if (stat.size > FIX_RUN_MAX_FILE_BYTES || stat.size > remaining)
						return undefined;
					remaining -= stat.size;
					return { candidate, bytes: await fs.promises.readFile(candidate) };
				} catch {
					return undefined;
				}
			}),
		);
		for (const entry of read) {
			if (!entry) {
				cut += 1;
				continue;
			}
			hashedBytes += entry.bytes.length;
			files.set(normalizeMapKey(entry.candidate), {
				filePath: entry.candidate,
				hash: sha256(entry.bytes),
			});
		}
	}
	// One row per run, so the 5000-file / 64 MiB bound is watchable in production.
	logLatency({
		type: "phase",
		filePath: "<pi-lens>",
		phase: "fix_run_hash",
		durationMs: Date.now() - startedAt,
		metadata: {
			tool: args.tool,
			files: files.size,
			bytes: hashedBytes,
			cut,
			byteBudget: budget,
		},
	});
	if (cut > 0) {
		recordDegradationOnce({
			kind: "fix-run-scope-truncated",
			subject: args.tool,
			reason: `${cut} of ${wanted.length} ${args.extension} file(s) were not hashed (unreadable, over ${FIX_RUN_MAX_FILE_BYTES} bytes, or past the ${budget}-byte budget); an agent edit to one of them during the run is not protected`,
		});
	}
	const { active } = registry();
	active.add(run);
	return {
		async finish(): Promise<FixRunReport> {
			active.delete(run);
			return settle(args.tool, run);
		},
	};
}

async function settle(tool: string, run: ActiveRun): Promise<FixRunReport> {
	const report: FixRunReport = {
		restored: [],
		lost: [],
		possiblyLost: [],
		agentEdited: [],
	};
	const inFlight = new Set(run.calls.values());
	for (const [key, file] of run.files) {
		const capture = file.capture;
		if (!capture) continue;
		report.agentEdited.push(file.filePath);
		let before: fs.Stats;
		let current: Buffer;
		try {
			before = await fs.promises.stat(file.filePath);
			current = await fs.promises.readFile(file.filePath);
		} catch {
			// Deleted or renamed by the agent (the tool never deletes): the path is
			// not this run's to recreate.
			continue;
		}
		if (capture.verdict === "overwritten") {
			report.lost.push(file.filePath);
			continue;
		}
		const unchanged = current.equals(capture.bytes);
		if (inFlight.has(key)) {
			// A newer agent write may already be on disk with its tool_result still
			// to come: the capture is older than the file, so it must not be written.
			if (!unchanged || capture.verdict === "unverifiable")
				report.possiblyLost.push(file.filePath);
			continue;
		}
		if (capture.verdict === "unverifiable")
			report.possiblyLost.push(file.filePath);
		if (unchanged) continue;
		try {
			// Something newer than the bytes read above (a second edit, or a
			// deletion) is not the tool's write and is not ours to overwrite.
			const after = await fs.promises.stat(file.filePath);
			if (!sameIdentity(identityOf(after), identityOf(before))) {
				if (!report.possiblyLost.includes(file.filePath))
					report.possiblyLost.push(file.filePath);
				continue;
			}
			await writeFileAtomicAsync(file.filePath, capture.bytes, {
				bestEffort: false,
			});
			report.restored.push(file.filePath);
		} catch {
			report.lost.push(file.filePath);
		}
	}
	if (
		report.restored.length > 0 ||
		report.lost.length > 0 ||
		report.possiblyLost.length > 0
	) {
		// One record per run, however many files: `incrementDegradationCount`
		// keeps the subject's count equal to the number of runs affected.
		const named = [...report.restored, ...report.lost, ...report.possiblyLost];
		incrementDegradationCount({
			kind: "fix-run-agent-edit-overwritten",
			subject: tool,
			reason: `${tool} rewrote files an agent edited during the run: ${report.restored.length} restored, ${report.lost.length} lost, ${report.possiblyLost.length} possibly lost (${named.slice(0, 5).join(", ")})`,
		});
	}
	return report;
}

/**
 * Called when pi-lens observes an agent mutation of `filePath`. Reads the
 * file's bytes right now for every active run that covers it. Synchronous on
 * purpose: the read has to land before the tool's next write, and it is only
 * paid for a path that is inside a live run's set.
 */
export function noteAgentMutation(
	filePath: string,
	expected?: AgentWriteExpectation,
): void {
	const { active } = registry();
	if (active.size === 0) return;
	let key: string | undefined;
	for (const run of active) {
		key ??= normalizeMapKey(filePath);
		const file = run.files.get(key);
		if (!file) continue;
		try {
			const bytes = fs.readFileSync(file.filePath);
			// Bytes equal to the pre-run bytes are not an agent change to protect.
			if (sha256(bytes) === file.hash) {
				delete file.capture;
				continue;
			}
			file.capture = { bytes, verdict: verdictFor(bytes, expected) };
		} catch {
			// Unreadable or gone: the agent deleted or renamed it, so an older
			// capture must not bring it back.
			delete file.capture;
		}
	}
}

/**
 * pi's tool_call for an agent mutation of `filePath` has passed: the host tool
 * is about to run, and its tool_result has not been delivered. Until
 * {@link noteAgentCallEnd}, the file may hold bytes newer than any capture.
 */
export function noteAgentCallStart(
	toolCallId: string | undefined,
	filePath: string,
): void {
	if (toolCallId === undefined) return;
	const { active } = registry();
	if (active.size === 0) return;
	let key: string | undefined;
	for (const run of active) {
		key ??= normalizeMapKey(filePath);
		if (run.files.has(key)) run.calls.set(toolCallId, key);
	}
}

/** The tool_result (or a block) for `toolCallId` arrived: no longer in flight. */
export function noteAgentCallEnd(toolCallId: string | undefined): void {
	if (toolCallId === undefined) return;
	const { active } = registry();
	for (const run of active) run.calls.delete(toolCallId);
}

/** Line endings are the host's to preserve, not the agent's to state. */
function normalized(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

function verdictFor(
	bytes: Buffer,
	expected?: AgentWriteExpectation,
): CaptureVerdict {
	if (!expected) return "unverifiable";
	const text = normalized(bytes.toString("utf8"));
	if (expected.content !== undefined)
		return text === normalized(expected.content) ? "verified" : "overwritten";
	const edits = expected.edits ?? [];
	let checkable = 0;
	for (const edit of edits) {
		const added = normalized(edit.newText);
		const removed = normalized(edit.oldText ?? "");
		let checked = false;
		if (added.length > 0) {
			checked = true;
			if (!text.includes(added)) return "overwritten";
		}
		// A stale-based rewrite still holds the text the edit removed. Only
		// meaningful when the new text does not itself contain it.
		if (removed.length > 0 && !added.includes(removed)) {
			checked = true;
			if (text.includes(removed)) return "overwritten";
		}
		if (checked) checkable += 1;
	}
	return edits.length > 0 && checkable === edits.length
		? "verified"
		: "unverifiable";
}

/**
 * What a native write or edit says it put in the file, read from the EXECUTED
 * tool input: a `write`'s whole `content`, an `edit`'s `oldText`/`newText`
 * pairs (the `edits` array, or the legacy single top-level pair). Anything
 * else states nothing, and the capture is taken unverified.
 */
export function expectationFromToolInput(
	input: unknown,
	kind: "write" | "edit",
): AgentWriteExpectation | undefined {
	const args = input as
		| { content?: unknown; newText?: unknown; edits?: unknown }
		| undefined;
	if (kind === "write")
		return typeof args?.content === "string"
			? { content: args.content }
			: undefined;
	const raw = Array.isArray(args?.edits) ? args.edits : [args];
	const edits = raw.flatMap((edit) => {
		const pair = edit as { oldText?: unknown; newText?: unknown } | undefined;
		if (typeof pair?.newText !== "string") return [];
		return [
			{
				newText: pair.newText,
				...(typeof pair.oldText === "string" && { oldText: pair.oldText }),
			},
		];
	});
	return edits.length > 0 ? { edits } : undefined;
}

/** The loud report for files whose agent edit did not provably survive. */
export function renderFixRunLoss(loss: {
	lost: readonly string[];
	possiblyLost: readonly string[];
}): string {
	const list = (files: readonly string[]): string =>
		files
			.slice(0, 8)
			.map((file) => `  - ${file}`)
			.join("\n") +
		(files.length > 8 ? `\n  - ... and ${files.length - 8} more` : "");
	const parts: string[] = [];
	if (loss.lost.length > 0)
		parts.push(
			`⚠️ **An auto-fix run overwrote your edit to ${loss.lost.length === 1 ? "this file" : "these files"} while it ran, and pi-lens could not restore it. Re-read ${loss.lost.length === 1 ? "it" : "each"} and re-apply your change:**\n${list(loss.lost)}`,
		);
	if (loss.possiblyLost.length > 0)
		parts.push(
			`⚠️ **An auto-fix run rewrote ${loss.possiblyLost.length === 1 ? "this file" : "these files"} while you were editing, and pi-lens cannot confirm your edit survived. Re-read ${loss.possiblyLost.length === 1 ? "it" : "each"} and re-apply your change if it is missing:**\n${list(loss.possiblyLost)}`,
		);
	return parts.join("\n\n");
}
