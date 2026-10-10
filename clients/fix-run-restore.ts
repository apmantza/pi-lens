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
 *    ({@link noteAgentCallStart} / {@link noteAgentCallEnd}); calls that start
 *    while the run is registering are carried into it.
 * 3. After the run, write the captured bytes back over the tool's write and
 *    record ONE degradation for the run ({@link FixRun.finish}).
 * 4. A file the tool created is not in the pre-run set and is left alone.
 * 5. An edit pi-lens cannot show survived is reported by file name, so the
 *    agent can re-apply it.
 *
 * ## The restore invariant (#3741 round 2, #3830)
 *
 * The restore never writes over content NEWER than the capture, and never
 * recreates a file that is absent at restore time. It writes only a file the
 * tool demonstrably rewrote after the capture. For each captured file, inside
 * pi's queue entry for it, the restore reads the file and decides:
 *
 * | at the restore                              | outcome                     |
 * | ------------------------------------------- | --------------------------- |
 * | absent (agent deleted or renamed it)        | nothing; never recreated    |
 * | an agent call on it is still in flight      | not written; possibly lost  |
 * | bytes equal the capture                     | nothing                     |
 * | changed again before the write (re-read)    | not written; possibly lost  |
 * | otherwise (the tool rewrote it after)       | capture written back        |
 *
 * ## Lock order (#3830)
 *
 * The restore takes pi's queue entry for a sibling S, so an agent `edit` of S
 * cannot land between the restore's compare and its write. The pipeline holds
 * the target F's entry while the tool runs, through its own after-reads
 * (#3506), and the restore starts after the caller's scan of the tool's
 * changes, so it can wait for S's entry while F is held. That is safe because
 * nothing waits for the restore while it holds an entry:
 *
 * - A queue entry is requested by something that holds no other entry, with
 *   one exception: the multi-path LSP edit (`withHostFileMutationQueues`)
 *   requests its keys in ascending order.
 * - The restore holds one S entry at a time and does file I/O only inside it.
 * - {@link runWithFixRestore} returns the restore as a promise and awaits
 *   nothing on it. A caller awaits it only after it has released the target's
 *   hold, and the tool_result pipeline does not await it at all: F's
 *   diagnostics and blockers must not wait on whoever holds a sibling, so its
 *   loss notice goes to the agent through the advisory queue
 *   (`PipelineContext.onFixRunLoss`). A restore awaited INSIDE F's hold closes a cycle: an LSP edit of
 *   [S, F] holds S and waits for F, the pipeline holds F and waits for the
 *   restore, the restore waits for S (`formal/dispatch-pipeline`
 *   `SiblingRestoreQueuedInHold`, checked with CHECK_DEADLOCK;
 *   `tests/clients/fix-run-restore.test.ts` runs the same cycle through pi's
 *   real queue).
 *
 * The run stays registered until the restore ends, so an agent call that
 * starts after the tool exited is tracked (in flight, then captured) and the
 * restore does not write over it.
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
 * ## What the report names (#3830, windows B and C)
 *
 * Three rules, implemented one for one by
 * `formal/dispatch-pipeline/SiblingRestore.tla` (`SACall`, `SANote`, `RRead`).
 * The supersede rule's identical-bytes arm is pinned by a code test alone
 * (`reports an overwritten capture a later capture of identical bytes
 * replaces`): no TLC config needs it, because the model's loss invariants
 * exclude an edit the agent's own later write replaced (`Superseded`).
 *
 * - **Displaced** ({@link noteAgentCallStart}): a call begins on a file whose
 *   latest capture the bytes on disk no longer verify against its own stated
 *   write. The fixer erased it. Byte inequality alone is not enough: a fixer
 *   that rewrote the file AROUND the edit kept it. Neither is a contradiction
 *   the agent caused itself: an own call still in flight whose stated write is
 *   already on disk and covers the contradicted text ({@link
 *   accountedByOwnCall}) superseded that region (#4205 round 4, verify r3
 *   R3-2). The mark is load-bearing for a `verified` capture only; the
 *   supersede rule names the other verdicts whatever it says.
 * - **Supersede** ({@link noteAgentMutation}): a capture replaced by a newer one
 *   is named when it was `overwritten` (lost, even when the new bytes are
 *   identical: the edit it stated is not in them), or `unverifiable` or
 *   displaced and the bytes differ (possibly lost). A `verified`, undisplaced
 *   capture replaced by an edit that built on it is quiet, and so is an
 *   `accounted` one: an own write already in flight when its result arrived
 *   covers its contradiction ({@link captureVerdict}), or the capture in hand is
 *   the newer own write and stays ({@link keepsNewerCapture}).
 * - **In flight** (the restore): a file with a call still in flight is named
 *   possibly lost unless it has no capture, or a `verified` capture equal to
 *   disk, AND EVERY in-flight call's stated write is on disk. One verified call
 *   does not vouch for another's edit. A call with no stated write cannot be
 *   verified.
 *
 * The three rules read one another's vocabulary: `verified` and `accounted`
 * name nothing on their own, `overwritten` names the file lost, `unverifiable`
 * and the displaced mark name it possibly lost. What ties the round-4 arms
 * together is one question -- did the fixer write these bytes, or did the agent
 * -- and one answer: an own stated write that is on disk and names the region is
 * the agent's, and a report must not depend on the order the host delivers a
 * parallel batch in.
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
 * - The write is guarded by pi's queue and a content re-read; a writer outside
 *   the queue (bash, a bridged producer) that lands between the re-read and
 *   the rename is still overwritten.
 * - "In flight" is known only for calls that pass pi-lens's tool_call seam with
 *   a correlation id while a run is registered; calls started before
 *   `beginFixRun` are carried into the run (#3830, window D). A bash or bridged producer
 *   whose write lands during the run and whose bytes were never captured, on a
 *   file the tool did not touch, is neither seen nor restored over when no
 *   capture exists for the file; on a file the tool DID touch it is the
 *   unverifiable case above. A later capture replaces an earlier one (#3830,
 *   window C), and a file with no capture is named before the in-flight check
 *   (window B).
 * - The displaced rule reads the disk at the agent's `tool_call`. A fixer write
 *   that lands after it and before the host runs the edit (the queue wait)
 *   leaves edit 1 unnamed: nothing at the tool_result separates it from two
 *   sequential edits without re-deriving the edit's base bytes
 *   (`SiblingRestoreQueuedSilentLate`, expected to violate `NoSilentLoss`).
 *   ACCEPTED as a named residual (maintainer decision on #3830, 2026-10-09).
 * - An edit the agent's own later write replaced stays quiet: the disk cannot
 *   say whether that write superseded the region deliberately or from a stale
 *   base, and the sequential spelling of the same two edits was always quiet
 *   (#4205 round 4).
 * - The accounting is one write deep, so a CHAIN of them still false-alarms
 *   (#4205 round 4, row 29): edit 2 replaces edit 1's region and is captured,
 *   edit 3 replaces edit 2's, and only then does edit 1's result arrive out of
 *   order. Its text is gone and no single own write on disk names it, so the
 *   capture reads `overwritten` and the next note names the file lost, although
 *   the tool never wrote. Attribution needs the chain of own writes since the
 *   capture, and this module keeps one capture per file and no write history.
 *   `SiblingRestoreOverlapReordered` (expected to violate
 *   `NoFalseAlarmUntouched`) pins it; the report direction is the safe one, and
 *   in-order delivery -- what pi's batch produces -- is quiet
 *   (`SiblingRestoreOverlap`).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { writeFileAtomicAsync } from "./atomic-write.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { withHostFileMutationQueue } from "./file-mutation-queue.js";
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

/**
 * What the bytes on disk say about the agent's stated write:
 *
 * - `verified`: they hold it.
 * - `overwritten`: they do not, and nothing the agent itself did explains it, so
 *   a writer outside pi's queue (the fixer) is the explanation.
 * - `accounted`: they do not, and an own call still in flight states a write
 *   that covers the difference, so the agent itself replaced that region
 *   (#4205 round 4). It names nothing: the report is about the fixer's writes.
 * - `unverifiable`: nothing states what the write was, so the bytes prove
 *   nothing either way.
 */
type CaptureVerdict = "verified" | "overwritten" | "accounted" | "unverifiable";

interface Capture {
	bytes: Buffer;
	verdict: CaptureVerdict;
	/** The agent's stated write this capture was verified against. */
	expected?: AgentWriteExpectation | undefined;
	/**
	 * A call began on the file while the disk no longer verified this capture's
	 * own stated write: the fixer erased it (#3830, window C).
	 */
	displaced?: true;
}

interface CoveredFile {
	filePath: string;
	hash: string;
	capture?: Capture;
	/** A replaced capture restore must still name: `overwritten` is lost. */
	superseded?: "overwritten" | "unverifiable";
}

interface PendingCall {
	key: string;
	expected?: AgentWriteExpectation | undefined;
}

interface ActiveRun {
	files: Map<string, CoveredFile>;
	/** Agent mutating tool calls started and not yet delivered: id -> file key. */
	calls: Map<string, PendingCall>;
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
	/**
	 * The tool has exited. `agentEdited` is what the capture holds now;
	 * `restore` writes the captures back and ends the run. It takes pi's queue
	 * entry for each file, so never await it while holding one (#3830). It
	 * never rejects.
	 */
	finish(): { agentEdited: string[]; restore(): Promise<FixRunReport> };
}

/**
 * Run `run` (the fixer's spawn) with the pre-run hash set and the capture in
 * place, then `afterRun` (the caller's own scan of what the tool changed, given
 * the files an agent edit was captured for: the tool's changes to them are not
 * its own), and restore whether `run` returns or throws: a tool that exits
 * nonzero or times out has usually already rewritten files. The restore starts
 * after `afterRun`, so it never writes while the caller scans, and is NOT
 * awaited here (see "Lock order" above); the run stays registered until it ends.
 */
export async function runWithFixRestore<T, R>(
	args: Parameters<typeof beginFixRun>[0],
	run: () => Promise<T>,
	afterRun: (value: T, agentEdited: string[]) => Promise<R>,
): Promise<{ result: R; restoring: Promise<FixRunReport> }> {
	const fixRun = await beginFixRun(args);
	let finished: ReturnType<FixRun["finish"]> | undefined;
	let outcome: { result: R } | { failure: unknown };
	try {
		const value = await run();
		finished = fixRun.finish();
		outcome = { result: await afterRun(value, finished.agentEdited) };
	} catch (failure) {
		outcome = { failure };
	}
	const restoring = (finished ?? fixRun.finish()).restore();
	if ("failure" in outcome) {
		void restoring;
		throw outcome.failure;
	}
	return { result: outcome.result, restoring };
}

interface Registry {
	active: Set<ActiveRun>;
	/** Calls that started before a run registered, retained until their result. */
	pendingCalls: Map<string, PendingCall>;
}

const REGISTRY_FAMILY = "fix-run-restore";
const REGISTRY_VERSION = 2;

function registry(): Registry {
	return getProcessSingleton<Registry>(
		REGISTRY_FAMILY,
		REGISTRY_VERSION,
		() => ({
			active: new Set(),
			pendingCalls: new Map(),
		}),
	);
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Hash the tool's rewritable files and start capturing agent mutations of
 * them. Never throws: a file that cannot be read is simply not covered.
 * Always call `finish()` and then its `restore()`, or the run stays registered.
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
	// A parallel tool call can pass the tool_call seam while the fixer is still
	// hashing its scope. Carry that identity into the run (#3830, window D).
	for (const [toolCallId, call] of registry().pendingCalls) {
		if (run.files.has(call.key)) run.calls.set(toolCallId, call);
	}
	return {
		finish() {
			return {
				agentEdited: [...files.values()].flatMap((file) =>
					file.capture ? [file.filePath] : [],
				),
				restore: () => restoreRun(args.tool, run, active),
			};
		},
	};
}

/**
 * The calls in flight on `key` for this run, minus `exceptId`: the caller's own
 * call, which has not run yet and so cannot have written anything.
 */
function callsOn(
	run: ActiveRun,
	key: string,
	exceptId?: string,
): PendingCall[] {
	const calls: PendingCall[] = [];
	for (const [id, call] of run.calls)
		if (id !== exceptId && call.key === key) calls.push(call);
	return calls;
}

/**
 * The in-flight rule of the module header: some call still in flight on `key`
 * has no stated write, or its stated write is not on disk. EVERY call must
 * verify before the file is quiet: one verified call does not vouch for
 * another's edit (#3830, verify r2 R2-2). The run's insertion order decides
 * nothing here, so an erased call registered after a verifying one is still
 * seen (#4205 round 4, verify r3 R3-3 K5).
 */
function unverifiedInFlight(
	run: ActiveRun,
	key: string,
	current: Buffer,
): boolean {
	return callsOn(run, key).some(
		(call) => verdictFor(current, call.expected) !== "verified",
	);
}

/**
 * Every point where `disk` contradicts the capture's stated edits is a point the
 * agent's own later call names as its own: a capture text missing from the disk
 * appears in one of that call's `oldText`s, and a capture text the disk holds
 * again appears in one of its `newText`s. A contradiction it does not name is
 * somebody else's doing.
 */
function coversContradiction(
	captured: ReadonlyArray<{ oldText?: string; newText: string }>,
	own: ReadonlyArray<{ oldText?: string; newText: string }>,
	text: string,
): boolean {
	for (const edit of captured) {
		const added = normalized(edit.newText);
		const removed = normalized(edit.oldText ?? "");
		if (
			added.length > 0 &&
			!text.includes(added) &&
			!own.some((stated) => normalized(stated.oldText ?? "").includes(added))
		)
			return false;
		if (
			removed.length > 0 &&
			!added.includes(removed) &&
			text.includes(removed) &&
			!own.some((stated) => normalized(stated.newText).includes(removed))
		)
			return false;
	}
	return true;
}

/**
 * Does ONE own stated write cover every point where `disk` contradicts `stated`?
 * It has to be on the disk already (`verified`): a call whose own write has not
 * landed explains no byte. What it covers follows from what it states: a
 * whole-file `write` that verifies IS the disk, so it covers everything; an
 * `edit` covers only the texts its own `oldText`/`newText` name, so a stated
 * edit it never mentions is still somebody else's doing (a fixer that erased one
 * region while the agent's own edit landed in another is still reported). A
 * whole-file statement has no region to match against an `edit`, so only another
 * whole-file write covers it.
 */
function covers(
	stated: AgentWriteExpectation,
	own: AgentWriteExpectation | undefined,
	disk: Buffer,
	text: string,
): boolean {
	if (!own || verdictFor(disk, own) !== "verified") return false;
	if (own.content !== undefined) return true;
	if (stated.content !== undefined) return false;
	return coversContradiction(stated.edits ?? [], own.edits ?? [], text);
}

/**
 * Does an own write account for `disk` contradicting a stated write, so that the
 * fixer is not the explanation (#4205 round 4, verify r3 R3-2, probe Q4)? The
 * candidates are the calls still in flight on the key.
 *
 * `exceptId` is the call asking, at a `tool_call`: it has not run yet, so its own
 * stated write is no evidence about the disk (state table row 25). A delivered
 * call needs no exclusion, because a write that fails to verify cannot vouch for
 * itself.
 *
 * Without this the report depends on the order the host delivers a parallel
 * batch in: the same edits, delivered one result at a time, were always quiet.
 */
function accountedByOwnCall(
	run: ActiveRun,
	key: string,
	stated: AgentWriteExpectation | undefined,
	disk: Buffer,
	exceptId?: string,
): boolean {
	// Nothing stated: no contradiction to account for.
	if (!stated) return false;
	const text = normalized(disk.toString("utf8"));
	for (const call of callsOn(run, key, exceptId))
		if (covers(stated, call.expected, disk, text)) return true;
	return false;
}

/**
 * The verdict for a capture taken from `bytes`. `overwritten` becomes
 * `accounted` when an own call still in flight covers the contradiction: pi
 * delivers a batch's writes before their results, so a later own edit can
 * replace this one's region before this one's result arrives (state table
 * row 27). The delivered call is out of the in-flight set by then
 * (`noteAgentCallEnd` precedes `noteAgentMutation` in the tool_result handler).
 */
function captureVerdict(
	run: ActiveRun,
	key: string,
	bytes: Buffer,
	expected: AgentWriteExpectation | undefined,
): CaptureVerdict {
	const verdict = verdictFor(bytes, expected);
	return verdict === "overwritten" &&
		accountedByOwnCall(run, key, expected, bytes)
		? "accounted"
		: verdict;
}

/**
 * A late result for an OLDER write must not downgrade the evidence. All three
 * of these have to hold (state table row 28, which `SiblingRestoreOverlap.cfg`
 * found: pi delivers a batch's results in any order, so the write that replaced
 * this one's region can be captured already):
 *
 * - the bytes are still, to the byte, the previous capture's, so nothing at all
 *   wrote since it was taken;
 * - that capture is `verified`, so its own write is the newest fact about the
 *   file;
 * - its stated write names this result's missing text as one it replaced. An
 *   `edit` states the region it took over, and pi applied it, so the older text
 *   was there until that write removed it: the fixer cannot have taken it
 *   earlier. A whole-file `write` states no region, so it proves nothing here
 *   and the older capture's verdict stands.
 *
 * Keeping the newer capture is what lets a LATER fixer write still be
 * attributed: the displaced rule reads the capture's own stated write. An
 * `unverifiable` note always replaces the capture, because nothing states which
 * write is newer and the bytes in hand are the disk's.
 */
function keepsNewerCapture(
	stated: AgentWriteExpectation | undefined,
	verdict: CaptureVerdict,
	bytes: Buffer,
	old: Capture | undefined,
): boolean {
	if (verdict !== "overwritten") return false;
	if (old?.verdict !== "verified" || !old.bytes.equals(bytes)) return false;
	const own = old.expected;
	// A whole-file capture states no region, so it cannot show that it, and not
	// the fixer, removed the older text.
	if (
		!stated ||
		!own ||
		own.content !== undefined ||
		stated.content !== undefined
	)
		return false;
	return coversContradiction(
		stated.edits ?? [],
		own.edits ?? [],
		normalized(bytes.toString("utf8")),
	);
}

/** One name per file per list, however many captures account for it. */
function name(list: string[], filePath: string): void {
	if (!list.includes(filePath)) list.push(filePath);
}

/**
 * Write the captures back, one queue entry at a time, and end the run. The run
 * stays in `active` until the last file is done, so a call that starts or an
 * edit that lands while the restore works is tracked (#3830, window A).
 */
async function restoreRun(
	tool: string,
	run: ActiveRun,
	active: Set<ActiveRun>,
): Promise<FixRunReport> {
	const report: FixRunReport = {
		restored: [],
		lost: [],
		possiblyLost: [],
		agentEdited: [],
	};
	const skipped: string[] = [];
	const startedAt = Date.now();
	let queueWaitMs = 0;
	try {
		for (const [key, file] of run.files) {
			if (!file.capture) {
				if (callsOn(run, key).length > 0) {
					report.agentEdited.push(file.filePath);
					// Outside pi's queue entry: a torn read of a non-atomic agent write
					// only mismatches, which reports (the safe direction).
					const current = await fs.promises
						.readFile(file.filePath)
						.catch(() => undefined);
					if (!current || unverifiedInFlight(run, key, current))
						name(report.possiblyLost, file.filePath);
				}
				continue;
			}
			report.agentEdited.push(file.filePath);
			const requestedAt = Date.now();
			try {
				await withHostFileMutationQueue(file.filePath, () => {
					queueWaitMs += Date.now() - requestedAt;
					return restoreFile(run, key, file, report, skipped);
				});
			} catch {
				name(report.lost, file.filePath);
			}
		}
	} finally {
		active.delete(run);
	}
	if (report.agentEdited.length > 0) {
		// One row per run that had a capture: `queueWaitMs` is the time spent
		// behind other holders of the siblings' queue entries, the number to watch
		// now that the restore waits for them (#3830).
		logLatency({
			type: "phase",
			filePath: "<pi-lens>",
			phase: "fix_run_restore",
			durationMs: Date.now() - startedAt,
			metadata: {
				tool,
				files: report.agentEdited.length,
				restored: report.restored.length,
				lost: report.lost.length,
				possiblyLost: report.possiblyLost.length,
				queueWaitMs,
			},
		});
	}
	if (skipped.length > 0) {
		incrementDegradationCount({
			kind: "fix-run-restore-skipped-newer-edit",
			subject: tool,
			reason: `${tool}'s restore left ${skipped.length} file(s) alone because a newer agent edit may have won, and named them as possibly lost (${skipped.slice(0, 5).join(", ")})`,
		});
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

/** The decision table of the module header, run inside the file's queue entry. */
async function restoreFile(
	run: ActiveRun,
	key: string,
	file: CoveredFile,
	report: FixRunReport,
	skipped: string[],
): Promise<void> {
	const capture = file.capture;
	if (!capture) return;
	if (file.superseded === "overwritten") name(report.lost, file.filePath);
	else if (file.superseded === "unverifiable")
		name(report.possiblyLost, file.filePath);
	let current: Buffer;
	try {
		current = await fs.promises.readFile(file.filePath);
	} catch {
		// Deleted or renamed by the agent (the tool never deletes): the path is
		// not this run's to recreate.
		return;
	}
	if (capture.verdict === "overwritten") {
		name(report.lost, file.filePath);
		return;
	}
	const unchanged = current.equals(capture.bytes);
	if (callsOn(run, key).length > 0) {
		// A newer agent write may already be on disk with its tool_result still
		// to come: the capture is older than the file, so it must not be written.
		// A call whose stated write is not on disk may have been erased (the
		// in-flight rule of the module header).
		if (
			!unchanged ||
			capture.verdict === "unverifiable" ||
			unverifiedInFlight(run, key, current)
		)
			name(report.possiblyLost, file.filePath);
		if (!unchanged) skipped.push(file.filePath);
		return;
	}
	if (capture.verdict === "unverifiable")
		name(report.possiblyLost, file.filePath);
	if (unchanged) return;
	// pi's queue keeps the agent's `edit` out; this re-read catches a writer
	// outside it (bash, a bridged producer). It compares bytes, not mtime and
	// size: an in-place edit keeps the inode, and a same-size edit inside one
	// mtime tick is invisible to a stat.
	let again: Buffer;
	try {
		again = await fs.promises.readFile(file.filePath);
	} catch {
		return;
	}
	if (!again.equals(current)) {
		name(report.possiblyLost, file.filePath);
		skipped.push(file.filePath);
		return;
	}
	await writeFileAtomicAsync(file.filePath, capture.bytes, {
		bestEffort: false,
	});
	report.restored.push(file.filePath);
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
			const old = file.capture;
			const verdict = captureVerdict(run, key, bytes, expected);
			// The supersede rule of the module header: a replaced capture is named
			// when it is `overwritten` (even if the new bytes are identical: the
			// edit it stated is not in them), or unverifiable or displaced and
			// replaced by different bytes. An `accounted` capture names nothing:
			// the agent's own later write is what replaced its region.
			if (
				old &&
				(old.verdict === "overwritten" ||
					(!old.bytes.equals(bytes) &&
						(old.verdict === "unverifiable" || old.displaced)))
			)
				file.superseded =
					file.superseded === "overwritten" || old.verdict === "overwritten"
						? "overwritten"
						: "unverifiable";
			if (!keepsNewerCapture(expected, verdict, bytes, old))
				file.capture = { bytes, verdict, expected };
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
	expected?: AgentWriteExpectation | undefined,
): void {
	if (toolCallId === undefined) return;
	const { active } = registry();
	const key = normalizeMapKey(filePath);
	// The bounded pending set closes the registration race between the agent's
	// tool_call and beginFixRun (#3830, window D).
	if (registry().pendingCalls.size < 256)
		registry().pendingCalls.set(toolCallId, { key, expected });
	else
		recordDegradationOnce({
			kind: "fix-run-pending-call-cap",
			subject: "fix-run-restore",
			reason:
				"more than 256 agent mutation calls were in flight before a fixer run; later calls were not carried into the run",
		});
	for (const run of active) {
		const file = run.files.get(key);
		if (!file) continue;
		run.calls.set(toolCallId, { key, expected });
		// The displaced rule of the module header. A tool write between two
		// agent edits shows here: the newer call begins on bytes that no longer
		// hold the capture's edit. An unreadable file is the agent's own removal.
		// There is no verdict to guard on: the mark is load-bearing for a
		// `verified` capture only, because the supersede rule names an
		// `overwritten` or `unverifiable` one whatever this sets (verify r3 K11
		// measured the guard as an equivalent mutant, so it is gone).
		const capture = file.capture;
		if (!capture) continue;
		try {
			const disk = fs.readFileSync(file.filePath);
			if (
				verdictFor(disk, capture.expected) !== "verified" &&
				!accountedByOwnCall(run, key, capture.expected, disk, toolCallId)
			)
				capture.displaced = true;
		} catch {
			// Gone: nothing for the fixer to have erased.
		}
	}
}

/** The tool_result (or a block) for `toolCallId` arrived: no longer in flight. */
export function noteAgentCallEnd(toolCallId: string | undefined): void {
	if (toolCallId === undefined) return;
	const { active } = registry();
	registry().pendingCalls.delete(toolCallId);
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
