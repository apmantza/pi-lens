import { LEDGER_FIELD_MAX } from "../../../ledger-bounds.js";
import type { SpawnResult } from "../../../safe-spawn.js";
import { truncatedByOutputCap } from "../../../spawn-output-cap.js";

/**
 * The first non-empty line of a tool's output, bounded.
 *
 * Replaces six hand-rolled copies that spelled the same idea two ways —
 * `text.trim().split("\n")[0]` and `(text ?? "").trim().split("\n")[0] ||
 * fallback` — with differing (or absent) length caps. Two behaviours the
 * copies got wrong and this does not: a leading blank line no longer yields an
 * empty "first line", and `\r\n` output no longer keeps its carriage return.
 *
 * Returns `""` when the text is empty or all-whitespace, so callers keep using
 * `firstOutputLine(x) || fallback`.
 */
export function firstOutputLine(
	text: string | undefined | null,
	max: number = LEDGER_FIELD_MAX,
): string {
	for (const line of String(text ?? "").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
	}
	return "";
}

/** What a spawned analysis tool actually did (#1816). */
type RunOutcomeKind =
	/** The tool analysed the file. Its output is safe to parse. */
	| "ran"
	/** The process never completed an analysis: spawn failure, timeout, signal. */
	| "did-not-run"
	/** The tool refused the invocation: bad flag, bad config, unknown subcommand. */
	| "rejected-invocation"
	/** The tool completed abnormally and its report artifact is absent. */
	| "report-missing";

export interface RunOutcome {
	kind: RunOutcomeKind;
	/** Process exit status, or `null` when the process never reported one. */
	status: number | null;
	/** Signal that killed the process, or `null`. Never silently dropped. */
	signal: NodeJS.Signals | null;
	/** First non-empty line of stderr, else stdout, else the spawn error. */
	firstOutputLine: string;
	/**
	 * OUR output cap ended this run (#2100). Evidence only — it never changes
	 * `kind`, because a cap kill is still a run that produced no usable result.
	 * What it changes is the WORDING: without it the ledger row reads "killed by
	 * SIGTERM", blaming the tool for a signal we sent because we stopped reading.
	 */
	outputCapped: boolean;
}

/**
 * A tool's exit-code contract, declared by the caller.
 *
 * `ran` lists every status that means "the tool completed an analysis",
 * findings-present codes included. `0` is always treated as a run, so a table
 * only needs the nonzero ones. ANY other nonzero status is a
 * `rejected-invocation`.
 *
 * Declare a table only when the tool's codes are actually known. An omitted
 * table is not a defect: classification then falls back to the
 * output-based rule below, which is the conservative reading.
 */
export interface ToolExitCodes {
	readonly ran: readonly number[];
}

export interface ClassifyRunOutcomeInput {
	result: SpawnResult;
	/**
	 * Exactly the string the caller is about to hand its parser. Defaults to
	 * stdout. Runners that parse stderr too pass both concatenated, so
	 * "nothing to parse" means both streams rather than just one.
	 */
	output?: string;
	/** The tool's exit-code contract, when known. */
	exitCodes?: ToolExitCodes;
	/** Artifact-file tools only: the expected report file is absent. */
	reportMissing?: boolean;
}

/**
 * Decide whether a tool ran, and if not, why (#1816).
 *
 * The defect this closes (the #1736 class): a runner that reads only its
 * parsed diagnostics reports a CLEAN file whenever the parse yields nothing —
 * including when the tool exited non-zero on an unknown flag, was killed by a
 * signal, or never spawned at all. An empty result must distinguish clean from
 * errored.
 *
 * Classification order, most specific first:
 *   1. `result.error` or a signal — the process never completed. `did-not-run`.
 *   2. `status === null` with no error — no exit status ever arrived, so no
 *      analysis can be claimed. `did-not-run`.
 *   3. `reportMissing` — an artifact tool wrote no report. Nonzero exit means
 *      `report-missing`; exit 0 means a genuinely clean run that had nothing
 *      to write.
 *   4. A nonzero status outside the caller's declared `ran` table.
 *      `rejected-invocation`.
 *   5. A nonzero status with nothing to parse. `did-not-run` — a tool that
 *      analysed the file says SOMETHING, so silence plus failure is evidence
 *      it never got that far.
 * Everything else ran.
 *
 * Note what is deliberately NOT a non-ran path: a nonzero status WITH output
 * and no contradicting table. Most linters exit non-zero precisely because
 * they found something, and their findings are on stdout.
 */
export function classifyRunOutcome(input: ClassifyRunOutcomeInput): RunOutcome {
	const { result, exitCodes, reportMissing } = input;
	const status = result.status ?? null;
	const signal = result.signal ?? null;
	const output = input.output ?? result.stdout;
	const base = {
		status,
		signal,
		firstOutputLine:
			firstOutputLine(result.stderr) ||
			firstOutputLine(result.stdout) ||
			firstOutputLine(result.error?.message),
		// Evidence carried alongside the verdict, never part of deciding it — the
		// branches below are byte-for-byte the pre-#2100 rules.
		outputCapped: truncatedByOutputCap(result),
	};

	if (result.error || signal) return { kind: "did-not-run", ...base };
	if (status === null) return { kind: "did-not-run", ...base };
	if (reportMissing) {
		return status === 0
			? { kind: "ran", ...base }
			: { kind: "report-missing", ...base };
	}
	if (status !== 0 && exitCodes && !exitCodes.ran.includes(status)) {
		return { kind: "rejected-invocation", ...base };
	}
	if (status !== 0 && !output?.trim()) {
		return { kind: "did-not-run", ...base };
	}
	return { kind: "ran", ...base };
}

/**
 * True when a tool both failed and produced nothing to parse — it never got as
 * far as linting the file. Callers map this to `skipped`, never `succeeded`.
 *
 * Kept as its own export because callers outside the dispatch runners use it
 * (`dead-code-client.ts`, `knip-client.ts`). It now DELEGATES to
 * `classifyRunOutcome` rather than restating the rule, but keeps its exact
 * historical semantics: the `!output.trim()` conjunct stays here so a spawn
 * error that still produced partial output keeps reaching the parser, which is
 * what today's callers depend on. `classifyRunOutcome` is the stricter,
 * outcome-typed reading; migrate callers to it deliberately, not by accident.
 *
 * `output` defaults to stdout. Runners that parse stderr too pass the exact
 * string they are about to hand the parser, so "nothing to parse" means both
 * streams rather than just one.
 */
export function spawnFailedWithNoOutput(
	result: SpawnResult,
	output: string = result.stdout,
): boolean {
	return (
		classifyRunOutcome({ result, output }).kind !== "ran" && !output?.trim()
	);
}
