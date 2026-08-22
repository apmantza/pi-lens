/**
 * One wording for a tool that produced no usable result, and the runner gate
 * that emits it to the degradation ledger (#1816).
 */
import { incrementDegradationCount } from "../../../degradation-ledger.js";
import { truncateForLedger } from "../../../ledger-bounds.js";
import type { Diagnostic, DispatchContext, RunnerResult } from "../../types.js";
import {
	type ClassifyRunOutcomeInput,
	classifyRunOutcome,
	firstOutputLine,
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
	 * Extra discriminating identity to keep in the record — knip's binary
	 * source, the resolved command. Rendered as `key=value` inside the
	 * parenthesis after the tool name. Undefined values are dropped.
	 */
	fields?: Record<string, string | number | undefined>;
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

	// A signal is the strongest available explanation, so it displaces the exit
	// status rather than sitting beside a `null` one.
	const what = input.signal
		? `was killed by ${input.signal}`
		: input.status === null
			? "did not run (spawn failure)"
			: `exited ${input.status}`;

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
	if (outcome.kind === "ran") return null;
	incrementDegradationCount({
		kind: "runner-empty-result",
		subject: tool,
		reason: formatRunOutcomeFailure(tool, outcome, fields),
	});
	return { status: "skipped", diagnostics: [], semantic: "none" };
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
	 * Return `skipped` — rather than letting the caller report a clean file —
	 * when the run failed and the parser read nothing. Opt-in per tool: it is
	 * correct only where a nonzero exit means "this file is bad", so claiming
	 * clean would be an outright lie (taplo). Elsewhere the record alone is the
	 * fix, and the status stays whatever the runner decided.
	 */
	skipWhenParsedNothing?: boolean;
}

export interface ParsedToolRun<D> {
	/** Non-null when the runner must return it verbatim and stop. */
	skipped: RunnerResult | null;
	diagnostics: D[];
	/** True when this run tripped the #1948 rule above. */
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
 */
export function parseToolRun<D>(
	tool: string,
	input: ClassifyRunOutcomeInput,
	parse: (output: string) => readonly D[],
	options: ParseToolRunOptions = {},
): ParsedToolRun<D> {
	const skipped = skipUnlessToolRan(tool, input, options.fields);
	if (skipped) return { skipped, diagnostics: [], parsedNothing: false };

	const output =
		options.parseOutput ?? input.output ?? input.result.stdout ?? "";
	const diagnostics = [...parse(output)];
	const parsedNothing = recordParsedNothing({
		tool,
		status: input.result.status ?? null,
		output,
		parsedCount: diagnostics.length,
		fields: options.fields,
	});

	if (parsedNothing && options.skipWhenParsedNothing) {
		return {
			skipped: { status: "skipped", diagnostics: [], semantic: "none" },
			diagnostics: [],
			parsedNothing,
		};
	}
	return { skipped: null, diagnostics, parsedNothing };
}

/**
 * The shared tail for CLI lint runners that spawn a tool, parse structured
 * findings, and map them to a result (#1839 consolidation).
 *
 * Twelve runners hand-rolled this branch and all twelve copies had the same
 * defect: on a NONZERO exit whose output failed to parse (or parsed to
 * nothing), they reported `succeeded` with zero diagnostics — "we checked,
 * it's clean" — while the tool was saying it found problems or errored. The
 * garbage battery turned the shape up 79 times in one pass; this seam is the
 * single fix.
 *
 * Semantics:
 * - findings present        → `classify` decides (default: any blocking
 *                             diagnostic → `failed`/`blocking`, else
 *                             `succeeded`/`warning`).
 * - no findings, exit 0     → clean: `succeeded`/`none`.
 * - no findings, nonzero exit,
 *   bytes emitted           → `failed` + one parse-error warning diagnostic.
 *                             Never clean (#1781 shape). A runner whose tool
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
			return {
				status: "failed",
				diagnostics: [
					{
						id: `${input.tool}:parse-error:1`,
						message: `${input.tool} exited ${status} but its output could not be parsed`,
						filePath: input.ctx.filePath,
						line: 1,
						column: 1,
						severity: "warning",
						semantic: "warning",
						tool: input.tool,
					},
				],
				semantic: "warning",
			};
		}
		return { status: "succeeded", diagnostics: [], semantic: "none" };
	}

	const mapped = input.classify?.(input.diagnostics);
	if (mapped) {
		return { ...mapped, diagnostics: input.diagnostics };
	}
	const hasBlocking = input.diagnostics.some((d) => d.semantic === "blocking");
	return {
		status: hasBlocking ? "failed" : "succeeded",
		diagnostics: input.diagnostics,
		semantic: hasBlocking ? "blocking" : "warning",
	};
}
