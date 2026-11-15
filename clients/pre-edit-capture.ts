/**
 * #4483, #5553: the pre-edit seed capture a writer's hook runs before the
 * write's first dispatch: one bounded capture per file
 * (`capturePreEditLinterFindings`), its degradation record and its
 * `pre_edit_capture` row. Moved out of `runtime-tool-call.ts` unchanged, so the
 * `tool_result` hook can reach it without importing the `tool_call` module
 * (which imports `runtime-tool-result.ts`).
 */
import { bounded } from "./deadline-utils.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { loadDispatchIntegration } from "./dispatch/lazy.js";
import { logLatency } from "./latency-logger.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";

/** What a seed capture reads from the hook that runs it. */
interface SeedCaptureDeps {
	runtime: Pick<RuntimeCoordinator, "captureSessionGeneration" | "projectRoot">;
	getFlag: (name: string) => boolean | string | undefined;
	ctx: { signal?: AbortSignal | undefined };
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
 * #4483, #5553: the one entry for a writer that names the files it will
 * change: the capture's bound, abort, degradation record and latency row, one
 * file after another, each under its own bound (`captureBudgetMs`).
 * `spanless` is a writer whose dispatch gets no edit span, so the edit-gated
 * lanes read the whole file and are seeded too
 * (`PRE_EDIT_SEED_SPANLESS_RUNNER_IDS`). Never rejects.
 */
export async function captureWriterSeeds(
	filePaths: readonly string[],
	deps: SeedCaptureDeps,
	spanless: boolean,
): Promise<void> {
	for (const filePath of filePaths) {
		const started = Date.now();
		// The thunk's signal is the capture's cancel: it aborts when the budget
		// lapses or `ctx.signal` fires (#5550; this site hand-built the same
		// controller, then aborted it after the await).
		const outcome = await bounded(
			(signal) => capturePreEditSeed(filePath, deps, signal, spanless),
			{
				ms: captureBudgetMs(spanless),
				signal: deps.ctx.signal,
				hook: "tool_call",
				label: "pre-edit-linter-capture",
			},
		);
		if (!outcome || outcome.outcome === "failed")
			recordDegradationOnce({
				kind: "pre-edit-capture-incomplete",
				subject: "pre-edit",
				reason: outcome?.outcome ?? "abandoned",
			});
		recordPreEditCapture(filePath, outcome, Date.now() - started, spanless);
	}
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
	deps: SeedCaptureDeps,
	signal: AbortSignal,
	spanless: boolean,
): Promise<PreEditCaptureResult> {
	const session = deps.runtime.captureSessionGeneration();
	const workspaceRoot = deps.runtime.projectRoot || process.cwd();
	const pi = { getFlag: (flag: string) => deps.getFlag(flag) };
	return loadDispatchIntegration()
		.then(({ capturePreEditLinterFindings }) =>
			capturePreEditLinterFindings(
				filePath,
				workspaceRoot,
				pi,
				session,
				signal,
				spanless,
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
			outcome.reason === "in-flight")
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
