/**
 * One wording for a tool that produced no usable result, and the runner gate
 * that emits it to the degradation ledger (#1816).
 */
import { incrementDegradationCount } from "../../../degradation-ledger.js";
import { truncateForLedger } from "../../../ledger-bounds.js";
import type { SpawnResult } from "../../../safe-spawn.js";
import {
	type Diagnostic,
	type DispatchContext,
	faultResult,
	faultSkip,
	findingsResult,
	type RunnerResult,
} from "../../types.js";
import {
	type ClassifyRunOutcomeInput,
	classifyRunOutcome,
	firstOutputLine,
	processCutShort,
	type RunOutcome,
} from "./spawn-outcome.js";

export interface ToolFailureInput {
	/** The tool as a reader would name it: "vulture", "knip", "markdownlint". */
	tool: string;
	/** Process exit status, or `null` when none ever arrived. */
	status: number | null;
	/** Signal that killed the process. NAMED in the reason when present. */
	signal?: NodeJS.Signals | null;
	stderr?: string;
	stdout?: string;
	/** The tool's report artifact is absent, rather than its stdout empty. */
	reportMissing?: boolean;
	/**
	 * OUR output cap ended the run (#2100). Displaces the signal in the wording
	 * for the same reason the signal displaces a null exit status: it is the
	 * strongest available explanation, and it is the only one that names US as
	 * the cause rather than leaving the tool blamed for a SIGTERM we sent.
	 */
	outputCapped?: boolean;
	/**
	 * Extra discriminating identity to keep in the record — knip's binary
	 * source, the resolved command. Rendered as `key=value` inside the
	 * parenthesis after the tool name. Undefined values are dropped.
	 */
	fields?: Record<string, string | number | undefined>;
}

/**
 * What ended this run, as one clause, most specific cause first.
 *
 * A signal is a stronger explanation than the exit status, so it displaces a
 * `null` one rather than sitting beside it. Our own output cap is stronger
 * still: the signal it killed with is a detail of OUR decision, and naming that
 * signal alone reads as the tool misbehaving (#2100).
 */
function describeEnding(input: ToolFailureInput): string {
	if (input.outputCapped) return "was stopped at its output cap";
	if (input.signal) return `was killed by ${input.signal}`;
	if (input.status === null) return "did not run (spawn failure)";
	return `exited ${input.status}`;
}

/**
 * One wording for "this tool did not produce a usable result" (#1816).
 *
 * Before this, five reason builders spelled the same sentence five ways and
 * twelve sites truncated with their own literal, and NONE of them named the
 * signal — so a SIGKILLed tool read exactly like a clean exit 0. The wording
 * here is fixed, the truncation is the ledger's own `LEDGER_FIELD_MAX` policy
 * applied once at the end, and the signal is always named when present.
 *
 * Shape: `tool (k=v, k=v) <what happened> with <what was missing>: <detail>`
 */
export function formatToolFailure(input: ToolFailureInput): string {
	const entries = Object.entries(input.fields ?? {}).filter(
		([, value]) => value !== undefined && value !== "",
	);
	const identity = entries.length
		? `${input.tool} (${entries.map(([key, value]) => `${key}=${value}`).join(", ")})`
		: input.tool;

	const what = describeEnding(input);
	const missing = input.reportMissing ? "no report file" : "no output";
	const detail =
		firstOutputLine(input.stderr) ||
		firstOutputLine(input.stdout) ||
		"no stderr";

	return truncateForLedger(`${identity} ${what} with ${missing}: ${detail}`);
}

/**
 * `formatToolFailure` fed straight from a `classifyRunOutcome` verdict — the
 * path every migrated runner takes, so the outcome and the wording can never
 * disagree about the status or the signal.
 */
export function formatRunOutcomeFailure(
	tool: string,
	outcome: RunOutcome,
	fields?: ToolFailureInput["fields"],
): string {
	return formatToolFailure({
		tool,
		status: outcome.status,
		signal: outcome.signal,
		outputCapped: outcome.outputCapped,
		stderr: outcome.firstOutputLine,
		reportMissing: outcome.kind === "report-missing",
		fields: { outcome: outcome.kind, ...fields },
	});
}

/**
 * The migrated runners' one call: classify the spawn, and when the tool did
 * NOT run, record a bounded `runner-empty-result` row and hand back the
 * `skipped` verdict. Returns `null` when the tool ran, meaning "carry on and
 * parse".
 *
 * `incrementDegradationCount` keeps the record bounded — one latest-reason
 * entry per (kind, subject) with an exact event tally — so a permanently
 * broken tool costs one ledger row, not one per dispatched file. `subject` is
 * the tool id, which is the discriminating identity a reader needs: WHICH tool
 * is silently contributing nothing.
 */
export function skipUnlessToolRan(
	tool: string,
	input: ClassifyRunOutcomeInput,
	fields?: ToolFailureInput["fields"],
): RunnerResult | null {
	const outcome = classifyRunOutcome(input);
	const kind = outcome.kind;
	if (kind === "ran") return null;
	incrementDegradationCount({
		kind: "runner-empty-result",
		subject: tool,
		reason: formatRunOutcomeFailure(tool, outcome, fields),
	});
	return faultSkip(kind);
}

/**
 * The one rule for a run the process did not complete (killed, timed out,
 * spawn error, no exit status) whose output reached the parser anyway (#4130).
 * Call it right after the parse, before anything reads the diagnostics as a
 * verdict. A cut-short run is never `succeeded`, never `blocking_diagnostics`
 * and never a skip with no fault, whatever it printed before it was cut:
 *
 * - nothing parsed: `faultSkip("did-not-run")`.
 * - findings parsed: `failed` with the findings kept and `failureKind:
 *   "did-not-run"` (the rust-clippy shape). The kind is not
 *   `blocking_diagnostics`, so `hasUsableResult` is false and smoke fails the
 *   row, while the user still sees what the tool reported before it died.
 *
 * Returns `null` when the process completed: the caller carries on with its
 * own reading of the output. A runner that bails before it parses
 * (`skipUnlessToolRan`, a `result.error` guard) drops partial output and
 * returns `faultSkip` directly; that is the same rule with no findings kept.
 */
export function faultIfCutShort(
	result: SpawnResult,
	diagnostics: readonly Diagnostic[],
): RunnerResult | null {
	if (!processCutShort(result)) return null;
	if (diagnostics.length === 0) return faultSkip("did-not-run");
	const hasBlocking = diagnostics.some((d) => d.semantic === "blocking");
	return {
		status: "failed",
		diagnostics: [...diagnostics],
		semantic: hasBlocking ? "blocking" : "warning",
		failureKind: "did-not-run",
	};
}

/**
 * The record a runner leaves when its parser read NOTHING out of output the
 * tool did produce (#1948).
 *
 * `skipUnlessToolRan` covers the adjacent case: the tool produced no output at
 * all. The hole it leaves is the one that hid five parser bugs for months —
 * vale (#1933), taplo, stylelint, phpstan (#1946), sqlfluff. Each received a
 * real report, extracted zero diagnostics from it, and reported "succeeded, 0
 * diagnostics", which is byte-for-byte what a genuinely clean file records.
 * A reader could not answer "is this file clean, or did the parser fail?".
 *
 * THE RULE: record only when the exit status is NONZERO, the output handed to
 * the parser is non-empty, and the parse yielded zero diagnostics. A nonzero
 * exit is the tool asserting something is wrong; extracting nothing from that
 * assertion means our reader disagrees with the tool, and one of the two is
 * broken.
 *
 * Exit 0 with zero parsed is deliberately NOT recorded, even with non-empty
 * output: that is the overwhelmingly common clean save. Linters print summary
 * banners, empty JSON arrays, and progress noise on a clean run, so a row per
 * clean save would drown the ledger and bury the real signal.
 *
 * FALSE NEGATIVES this rule accepts, stated plainly:
 *   - A tool that reports findings under exit 0. `swiftlint` is the live
 *     example among the adopters: a warning-only run exits 0 and still writes
 *     a full JSON array, so a swiftlint parser break that never trips a
 *     nonzero exit stays invisible here. (`vale` also exits 0 on findings by
 *     default, but its actual #1933 break exited 1, so it is not the example.)
 *     This gap is deliberate and is NOT closed by adding an output-length
 *     threshold for exit 0. That class belongs to the captured-fixture lane —
 *     `tests/clients/dispatch/runners/captured-real-output.test.ts` pins each
 *     parser against real recorded binary output, which catches a broken
 *     parser directly instead of guessing from output size. A length
 *     threshold here would fire on every clean run of every tool that prints
 *     a summary banner.
 *   - A tool whose parser breaks only for a SUBSET of findings still reports
 *     the ones it can read, so `parsedCount` is nonzero and nothing records.
 *
 * FALSE POSITIVES it accepts: a runner that legitimately parses zero
 * diagnostics out of a failing run — `go-vet` exits nonzero for a SIBLING
 * file's problem and then filters to the edited file, and `terragrunt` does
 * the same across a unit directory. Such runners stay off this helper rather
 * than being special-cased inside it; see the runner-family registries in
 * `tests/clients/dispatch/runners/parsed-nothing-sweep.test.ts`.
 *
 * Bounded by `incrementDegradationCount`: one latest-reason entry per
 * (kind, subject) with an exact tally, so a permanently broken parser costs
 * ONE ledger row and not one per dispatched file. `subject` is the tool id
 * because a parser break is a property of the tool and our reader of it, not
 * of the project it ran in; aggregating on the tool keeps exactly the identity
 * a reader needs ("which tool is stuck") while staying bounded across every
 * workspace in the session.
 *
 * @returns true when a row was recorded.
 */
export function recordParsedNothing(input: {
	tool: string;
	/** Process exit status, or null when none arrived. */
	status: number | null;
	/** EXACTLY the string handed to the parser. */
	output: string;
	/** How many diagnostics the parser extracted from `output`. */
	parsedCount: number;
	fields?: ToolFailureInput["fields"];
}): boolean {
	const { tool, status, output, parsedCount } = input;
	// Three conjuncts, one per clause of the rule above. Each is separately
	// load-bearing and separately tested: `parsedCount` keeps a run that DID
	// yield findings silent, `status` keeps the clean-save case silent (0 and a
	// never-arrived null alike — neither is a tool asserting a problem), and
	// `output` keeps "the tool said nothing at all" with `runner-empty-result`
	// rather than double-recording it here.
	if (parsedCount > 0) return false;
	if (!status) return false;
	const text = output ?? "";
	if (!text.trim()) return false;

	const entries = Object.entries(input.fields ?? {}).filter(
		([, value]) => value !== undefined && value !== "",
	);
	const identity = entries.length
		? `${tool} (${entries.map(([key, value]) => `${key}=${value}`).join(", ")})`
		: tool;

	incrementDegradationCount({
		kind: "runner-parsed-nothing",
		subject: tool,
		reason: truncateForLedger(
			`${identity} exited ${status} with ${text.length} chars of output but the parser read 0 diagnostics: ${
				firstOutputLine(text) || "no first line"
			}`,
		),
	});
	return true;
}

export interface ParseToolRunOptions {
	fields?: ToolFailureInput["fields"];
	/**
	 * The exact string to hand the parser, when it differs from the string the
	 * outcome classifier judged (`input.output`, else stdout). `spellcheck`
	 * parses stdout+stderr but classifies on stdout alone, and changing what it
	 * classifies would widen its "did it run" verdict.
	 */
	parseOutput?: string;
	/**
	 * Which stream a tool's report arrives on (#5411). `"stdout-else-stderr"`:
	 * the report is stdout; stderr stands in only when stdout is empty and the
	 * run did not exit 0, so a failing tool's own error text still reaches the
	 * parser while a warning printed beside a valid report cannot corrupt it
	 * (real ruff prints its deprecation notice on stderr next to the JSON).
	 * The classifier and the parser judge the same string. Overrides
	 * `input.output` and `parseOutput`.
	 */
	parseStreams?: "stdout-else-stderr";
}

export interface ParsedToolRun<D> {
	/** Non-null when the runner must return it verbatim and stop. */
	skipped: RunnerResult | null;
	diagnostics: D[];
	/** True when this run tripped the #1948 rule above (record only, not a verdict). */
	parsedNothing: boolean;
}

/**
 * The one seam a runner uses to go from a spawn result to diagnostics (#1948).
 *
 * It composes the two gates that must BOTH hold before a runner may claim a
 * clean file: `skipUnlessToolRan` (the tool produced nothing — #1816) and
 * `recordParsedNothing` (the tool produced something the parser could not
 * read). Runners call this instead of calling `skipUnlessToolRan` and then
 * parsing on their own, so the second gate cannot be forgotten by whoever
 * writes runner 53. `tests/clients/dispatch/runners/parsed-nothing-sweep.test.ts`
 * enforces that.
 *
 * This seam records and hands back the diagnostics; the VERDICT for a nonzero
 * exit whose output yielded nothing is `finishParsedRun`'s (failed/parser_error)
 * and no runner picks its own (#5411: vale, swiftlint and spellcheck returned
 * `succeeded`, taplo and detekt `skipped`). The sweep enforces that too.
 */
export function parseToolRun<D>(
	tool: string,
	input: ClassifyRunOutcomeInput,
	parse: (output: string) => readonly D[],
	options: ParseToolRunOptions = {},
): ParsedToolRun<D> {
	const streamed =
		options.parseStreams === undefined
			? undefined
			: stdoutElseStderr(input.result);
	const classified =
		streamed === undefined ? input : { ...input, output: streamed };
	const skipped = skipUnlessToolRan(tool, classified, options.fields);
	if (skipped) return { skipped, diagnostics: [], parsedNothing: false };

	const output =
		streamed ??
		options.parseOutput ??
		input.output ??
		input.result.stdout ??
		"";
	const diagnostics = [...parse(output)];
	const parsedNothing = recordParsedNothing({
		tool,
		status: input.result.status ?? null,
		output,
		parsedCount: diagnostics.length,
		fields: options.fields,
	});
	return { skipped: null, diagnostics, parsedNothing };
}

/** `parseStreams: "stdout-else-stderr"` (#5411): see {@link ParseToolRunOptions}. */
function stdoutElseStderr(result: SpawnResult): string {
	const stdout = result.stdout ?? "";
	if (stdout.length > 0 || result.status === 0) return stdout;
	return result.stderr ?? "";
}

/**
 * The shared tail for CLI lint runners that spawn a tool, parse structured
 * findings, and map them to a result (#1839 consolidation).
 *
 * Thirteen runner files hand-rolled this branch and every copy had the same
 * defect: on a NONZERO exit whose output failed to parse (or parsed to
 * nothing), they reported `succeeded` with zero diagnostics — "we checked,
 * it's clean" — while the tool was saying it found problems or errored. The
 * garbage battery turned the shape up 79 times in one pass; this seam is the
 * single fix.
 *
 * Semantics:
 * - findings present        → `classify` decides (default: any blocking
 *                             diagnostic → `failed`/`blocking`, else
 *                             `succeeded`/`warning`). A `failed` verdict
 *                             carries `failureKind: "blocking_diagnostics"`
 *                             (`findingsResult` in types.ts, #3781).
 * - no findings, exit 0     → clean: `succeeded`/`none`.
 * - no findings, nonzero exit,
 *   bytes emitted           → `failed` + one parse-error warning diagnostic,
 *                             `failureKind: "parser_error"` (not findings,
 *                             #3796). Never clean (#1781 shape). A runner whose tool
 *                             legitimately exits nonzero on a clean file must
 *                             normalize the status BEFORE calling this.
 */
export interface FinishParsedRunInput {
	/** The tool as a reader would name it — used in the parse-error finding. */
	tool: string;
	/** Only `filePath` is read from the context. */
	ctx: Pick<DispatchContext, "filePath">;
	/** The spawn result whose exit/output the findings came from. */
	result: {
		status?: number | null;
		stdout?: string | undefined;
		stderr?: string | undefined;
	};
	diagnostics: Diagnostic[];
	/**
	 * Override the default findings mapping when the runner's convention
	 * differs (e.g. phpstan always reports `failed`/`blocking`). Receives the
	 * non-empty diagnostics array.
	 */
	classify?: (
		diagnostics: Diagnostic[],
	) => Pick<RunnerResult, "status" | "semantic">;
}

export function finishParsedRun(input: FinishParsedRunInput): RunnerResult {
	const raw = `${input.result.stdout ?? ""}${input.result.stderr ?? ""}`;
	const status = input.result.status ?? null;

	if (input.diagnostics.length === 0) {
		if (status !== 0 && raw.trim().length > 0) {
			const message = `${input.tool} exited ${status} but its output could not be parsed`;
			return faultResult(
				{ kind: "parser_error", failureMessage: message },
				{
					id: `${input.tool}:parse-error:1`,
					message,
					filePath: input.ctx.filePath,
					line: 1,
					column: 1,
					tool: input.tool,
				},
			);
		}
		return { status: "succeeded", diagnostics: [], semantic: "none" };
	}

	const mapped = input.classify?.(input.diagnostics);
	if (mapped) {
		return findingsResult(input.diagnostics, mapped);
	}
	const hasBlocking = input.diagnostics.some((d) => d.semantic === "blocking");
	return findingsResult(input.diagnostics, {
		status: hasBlocking ? "failed" : "succeeded",
		semantic: hasBlocking ? "blocking" : "warning",
	});
}
