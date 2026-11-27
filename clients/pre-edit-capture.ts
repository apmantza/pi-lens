/**
 * #4483, #5553: the pre-edit seed capture a writer's hook runs before the
 * write's first dispatch: one bounded capture per file
 * (`capturePreEditLinterFindings`), its degradation record and its
 * `pre_edit_capture` row. Moved out of `runtime-tool-call.ts` unchanged, so the
 * `tool_result` hook can reach it without importing the `tool_call` module
 * (which imports `runtime-tool-result.ts`).
 */
import { bounded, type BoundedOptions } from "./deadline-utils.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { loadDispatchIntegration } from "./dispatch/lazy.js";
import type { PreEditBytes } from "./dispatch/pre-edit-seed.js";
import { logLatency } from "./latency-logger.js";
import { readFileAtRef } from "./metrics/complexity-baseline.js";

/** What a seed capture reads from the hook that runs it. */
export interface WriterSeedDeps {
	projectRoot: string;
	/** The session the seed belongs to, captured by the hook (#5616). */
	session: { isCurrent(): boolean };
	getFlag: (name: string) => boolean | string | undefined;
	signal: AbortSignal | undefined;
	/** The hook whose wait a lapsed bound names. */
	hook: BoundedOptions["hook"];
}

/**
 * #4483: how long a `tool_call` waits for the pre-edit linter capture.
 * `tool_call` has no wall budget of its own (clients/hook-budgets.ts); this
 * is the per-await bound. Measured in PR #4483's body.
 */
export const PRE_EDIT_CAPTURE_BUDGET_MS = 500;

/**
 * #5553: the bound for a writer's capture that also seeds the tree-sitter and
 * ast-grep lanes. The first one in a process loads both engines (about 550 ms
 * measured, ~100 ms once warm), which a 500 ms bound abandoned on the first
 * writer of a session, so that writer's own blocker blocked its commit.
 */
export const PRE_EDIT_SPANLESS_CAPTURE_BUDGET_MS = 1500;

function captureBudgetMs(spanless: boolean): number {
	return spanless
		? PRE_EDIT_SPANLESS_CAPTURE_BUDGET_MS
		: PRE_EDIT_CAPTURE_BUDGET_MS;
}

/**
 * #5551: where a seed's "before" bytes come from, chosen per route. `disk`:
 * the file as it is now, for a `tool_call` that runs before its write (a host
 * write or edit, and every writer that names its files). `head`: the file's
 * HEAD copy, for a write that already happened and whose file was clean
 * before it (#5616's credited script write, read at `tool_result`). Either
 * way the seed splits the write's findings into new and pre-existing the same
 * way. A source that snapshots the bytes at `tool_call` and reads them later
 * would be a third member here.
 */
export type WriterBeforeSource = "disk" | "head";

/**
 * #5616: a credited script write's file as HEAD holds it. The call is
 * credited only with a file that was clean before it, so these are the bytes
 * the file held then; `absent` for a file the call created.
 */
function readHeadCopy(
	filePath: string,
	signal?: AbortSignal,
): Promise<PreEditBytes> {
	return readFileAtRef(filePath, "HEAD", "pre-edit-head-seed", signal).then(
		(read) =>
			read.kind === "file"
				? { content: read.content }
				: read.kind === "absent"
					? "absent"
					: "unreadable",
	);
}

/**
 * #5551: the one supplier of a seed's "before" bytes. `undefined` means the
 * capture reads the file itself, before the write.
 */
function writerBefore(
	source: WriterBeforeSource,
):
	| ((filePath: string, signal?: AbortSignal) => Promise<PreEditBytes>)
	| undefined {
	return source === "head" ? readHeadCopy : undefined;
}

/**
 * #4483, #5553: the one entry for a writer that names the files it will
 * change: the capture's bound, abort, degradation record and latency row, one
 * file after another, each under its own bound (`captureBudgetMs`).
 * `spanless` is a writer whose dispatch gets no edit span, so the edit-gated
 * lanes read the whole file and are seeded too
 * (`PRE_EDIT_SEED_SPANLESS_RUNNER_IDS`). `source` picks where each file's
 * earlier bytes come from (`writerBefore`, #5551). Returns the files whose
 * copy could not be written beside them (`copy-unwritable`): they have no
 * seed, so the caller withholds their credit (#5616 F-B). Never rejects.
 */
export async function captureWriterSeeds(
	filePaths: readonly string[],
	deps: WriterSeedDeps,
	spanless: boolean,
	source: WriterBeforeSource,
): Promise<string[]> {
	const before = writerBefore(source);
	const unseeded: string[] = [];
	for (const filePath of filePaths) {
		const started = Date.now();
		// The thunk's signal is the capture's cancel: it aborts when the budget
		// lapses or `ctx.signal` fires (#5550; this site hand-built the same
		// controller, then aborted it after the await).
		const outcome = await bounded(
			(signal) =>
				capturePreEditSeed(
					filePath,
					deps,
					signal,
					spanless,
					before && ((beforeSignal) => before(filePath, beforeSignal)),
				),
			{
				ms: captureBudgetMs(spanless),
				signal: deps.signal,
				hook: deps.hook,
				label: "pre-edit-linter-capture",
			},
		);
		if (!outcome || outcome.outcome === "failed")
			recordDegradationOnce({
				kind: "pre-edit-capture-incomplete",
				subject: "pre-edit",
				reason: outcome?.outcome ?? "abandoned",
			});
		if (outcome?.outcome === "skipped" && outcome.reason === "copy-unwritable")
			unseeded.push(filePath);
		recordPreEditCapture(filePath, outcome, Date.now() - started, spanless);
	}
	return unseeded;
}

type PreEditCaptureResult =
	| Awaited<
			ReturnType<
				Awaited<
					ReturnType<typeof loadDispatchIntegration>
				>["capturePreEditLinterFindings"]
			>
	  >
	| { outcome: "failed"; failure: string };

/**
 * #4483: before the host first replaces an existing file's bytes this
 * session, run its linters over those bytes and seed the file's delta, so
 * the write's dispatch reports their old errors as pre-existing instead of
 * as blockers (`capturePreEditLinterFindings`). Never rejects.
 */
function capturePreEditSeed(
	filePath: string,
	deps: WriterSeedDeps,
	signal: AbortSignal,
	spanless: boolean,
	before: ((signal?: AbortSignal) => Promise<PreEditBytes>) | undefined,
): Promise<PreEditCaptureResult> {
	const workspaceRoot = deps.projectRoot || process.cwd();
	const pi = { getFlag: (flag: string) => deps.getFlag(flag) };
	return loadDispatchIntegration()
		.then(({ capturePreEditLinterFindings }) =>
			capturePreEditLinterFindings(
				filePath,
				workspaceRoot,
				pi,
				deps.session,
				signal,
				spanless,
				before,
			),
		)
		.catch((cause: unknown): PreEditCaptureResult => {
			const failure = cause instanceof Error ? cause.message : String(cause);
			return { outcome: "failed", failure: failure.slice(0, 200) };
		});
}

/**
 * #4483: one latency row per capture that ran (`undefined` = the bound gave
 * up first, `abandoned`). A file already dispatched this session, a file
 * whose abandoned capture is still running, or a session with `--no-delta`
 * writes none, so a long session pays one row per file, not one per write.
 */
function recordPreEditCapture(
	filePath: string,
	outcome: PreEditCaptureResult | undefined,
	durationMs: number,
	spanless: boolean,
): void {
	if (
		outcome?.outcome === "skipped" &&
		(outcome.reason === "already-dispatched" ||
			outcome.reason === "no-delta" ||
			outcome.reason === "in-flight" ||
			outcome.reason === "absent-before")
	)
		return;
	logLatency({
		type: "phase",
		phase: "pre_edit_capture",
		filePath,
		durationMs,
		result: outcome?.outcome ?? "abandoned",
		metadata: {
			...(outcome?.outcome === "seeded" && {
				seeded: outcome.seeded,
				runners: outcome.runners.join(","),
			}),
			...((outcome?.outcome === "skipped" ||
				outcome?.outcome === "discarded") && { reason: outcome.reason }),
			...(outcome?.outcome === "failed" && { failure: outcome.failure }),
			budgetMs: captureBudgetMs(spanless),
		},
	});
}
