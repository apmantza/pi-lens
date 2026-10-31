/**
 * Disposition/rule/inline-suppression policy for the turn-end
 * "Unresolved from this turn" blocker replay (#3246).
 *
 * `runtime-turn.ts` re-serves every live `InlineBlockerRecord` the turn's
 * dispatches left behind. Until this module, it pushed the record's
 * ALREADY-RENDERED `summary` string verbatim, so a `lens_diagnostic_mark`
 * made after the record was written had nothing to act on: the durable
 * disposition store was honored by `lens_diagnostics`, the widget, the cached
 * scanner lanes, late auxiliary and cascade, while this one surface replayed
 * the pre-mark text on every later turn — including turns that edited only an
 * unrelated file. That is #3246's report.
 *
 * The fix is the same shape `blocker-past-eof.ts` already argued for the
 * `lines` field: carry the STRUCTURED diagnostics the summary was rendered
 * from (`dispatchResult.blockers`, via `PipelineResult.inlineBlockerDiagnostics`
 * and `InlineBlockerRecord.diagnostics`) and re-derive at read time, rather
 * than regex-parsing a string built for human display. With the diagnostics in
 * hand this module runs the ONE filter stack every other findings surface runs
 * — `clients/dispatch/finding-policy.ts`'s inline `pi-lens-ignore` → stored
 * dispositions → `.pi-lens.json` rule policy — against the file's CURRENT
 * bytes, and re-renders the survivors with `formatDiagnostics(..., "blocking")`,
 * the SAME renderer `dispatcher.ts` used to build the stored summary. No second
 * anchor implementation and no second renderer: an unmarked record therefore
 * re-renders byte-identically to what dispatch produced.
 *
 * Ordering (#3246 mutation (c)): the policy runs over the WHOLE candidate set
 * and `formatDiagnostics` applies its 10-row display cap to the survivors.
 * Filtering after the cap would leave a marked finding occupying a display slot
 * and hide an unmarked one behind "... and N more" — the cap-before-policy
 * shape `cascade-format.ts` already avoids.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { hasAnyDispositionMarks } from "./diagnostic-dispositions.js";
import {
	applyFindingPolicyByOwner,
	inlineBlockerIdentities,
	loadProjectRulePolicy,
} from "./dispatch/finding-policy.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";
import type { Diagnostic } from "./dispatch/types.js";
import { formatDiagnostics } from "./dispatch/utils/format-utils.js";

/**
 * The record fields this gate reads — structural, like `blocker-freshness.ts`
 * and `blocker-past-eof.ts`, so `runtime-coordinator.ts` stays the only owner
 * of `InlineBlockerRecord`.
 */
export interface InlineBlockerPolicyInput {
	filePath: string;
	summary: string;
	/** Absent on a legacy/hand-authored record — see `unstructured` below. */
	diagnostics?: readonly Diagnostic[];
}

export interface InlineBlockerPolicyOutcome {
	/**
	 * The blocker body to render, or `undefined` when the policy suppressed
	 * EVERY candidate — the caller then emits no `Unresolved from this turn`
	 * section and no `🔴 STOP` text for this file at all.
	 */
	body: string | undefined;
	/** Structured blockers this record offered the policy. */
	candidates: number;
	/** Survivors — what `body` renders. */
	kept: number;
	/** `candidates - kept`. */
	suppressed: number;
	/**
	 * True when the record carried no structured diagnostics, so its summary
	 * was re-served verbatim and no mark could be applied to it. Fail-open by
	 * construction: a finding is never hidden because its identity was
	 * unavailable.
	 */
	unstructured: boolean;
}

/**
 * The file's CURRENT bytes, or `""` when they cannot be read.
 *
 * `""` is `FindingPolicyOptions.content`'s documented fail-open input: inline
 * suppression becomes a no-op and the STRICT anchor hashes an empty line, so it
 * cannot match a mark made against real content and the finding stays VISIBLE.
 * Never hide a blocking finding over an I/O error (AGENTS.md shape 48).
 */
function readCurrentContent(filePath: string): string {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return "";
	}
}

/**
 * Apply the shared finding policy to one live inline-blocker record.
 *
 * Diagnostics are grouped by the file they were raised AGAINST, not by the
 * record's own path: `dispatchResult.blockers` is pooled across every runner
 * dispatched for the edited file, and a chart-wide runner (helm-lint,
 * helm-render) reports blocking diagnostics against sibling files — the same
 * cross-file population `pipeline.ts` filters out of `inlineBlockerLines`.
 * Anchoring those against the record's path would derive the wrong strict
 * anchor and read the wrong file's `pi-lens-ignore` comments. A file that
 * cannot be read, or lies outside `cwd`, suppresses nothing (the same
 * fail-closed rule `applyFindingPolicyByOwner` gives the dispatcher).
 */
export function applyInlineBlockerPolicy(
	record: InlineBlockerPolicyInput,
	cwd: string,
): InlineBlockerPolicyOutcome {
	const { diagnostics, filePath } = record;
	if (!diagnostics || diagnostics.length === 0) {
		// Bounded per (kind, subject) by the ledger itself — this condition
		// recurs every turn end for the same record, so a counted row would
		// grow without adding information (AGENTS.md shapes 13/17). Recorded
		// ONLY when the project actually holds marks: with an empty store there
		// is nothing this record failed to honor, and a row every session for
		// every unstructured record would be noise, not a degradation.
		if (hasAnyDispositionMarks(cwd)) {
			recordDegradationOnce({
				kind: "inline-blocker-unstructured",
				subject: `inline-blocker:${toRunnerDisplayPath(cwd, filePath)}`,
				reason:
					"record carries no structured diagnostics; disposition marks cannot be applied to its rendered summary",
			});
		}
		return {
			body: record.summary,
			candidates: 0,
			kept: 0,
			suppressed: 0,
			unstructured: true,
		};
	}

	// Each finding is judged by the file it names (#5044), through the one
	// per-owner seam the dispatcher shares. Resolved against the PROJECT root,
	// never `process.cwd()`: a runner that reports a project-relative path would
	// otherwise be read from the agent host's working directory. The resolved
	// copies pair with `diagnostics` by index, so the record keeps its objects.
	const inProject = (file: string): string => path.resolve(cwd, file);
	const resolved = diagnostics.map((diagnostic) => ({
		...diagnostic,
		filePath: inProject(diagnostic.filePath),
	}));
	const recordPath = inProject(filePath);
	const survivors = new Set(
		applyFindingPolicyByOwner(resolved, {
			cwd,
			filePath: recordPath,
			content: readCurrentContent(recordPath),
			// One policy for every file: each config owner resolves once.
			policyMap: loadProjectRulePolicy(cwd),
			identities: inlineBlockerIdentities,
		}).kept,
	);
	const kept = diagnostics.filter((_, index) => {
		const twin = resolved[index];
		return twin !== undefined && survivors.has(twin);
	});
	const dropped = diagnostics.length - kept.length;
	return {
		body:
			kept.length === 0
				? undefined
				: formatDiagnostics(kept, "blocking").trim(),
		candidates: diagnostics.length,
		kept: kept.length,
		suppressed: dropped,
		unstructured: false,
	};
}

/**
 * How many file/tool identities {@link summarizeInlineBlockerPolicy}'s one
 * per-turn record names. The COUNTS are always exact; only the identity lists
 * are capped, so a turn that touched a hundred files writes a bounded row
 * rather than a file listing (AGENTS.md shape 17).
 */
const IDENTITY_CAP = 10;

/** One inline-blocker record's contribution to the per-turn policy record. */
export interface InlineBlockerPolicyTallyEntry {
	displayPath: string;
	sources: readonly string[] | undefined;
	/**
	 * True for a record the freshness/past-EOF gates demoted. Those render
	 * through the advisory channel; since #4990 they run the SAME policy pass as
	 * the live branch, so their `outcome` is the one that decides whether the
	 * demoted body survives, and their candidates/suppression counts belong to
	 * the same per-turn record.
	 */
	stale: boolean;
	outcome?: InlineBlockerPolicyOutcome;
}

/**
 * The ONE bounded record the turn writes for this pass — never one per
 * finding. Derived here rather than accumulated at the call site so the shape
 * and its bound live with the policy they describe.
 */
export function summarizeInlineBlockerPolicy(
	entries: readonly InlineBlockerPolicyTallyEntry[],
): Record<string, unknown> {
	const files: string[] = [];
	const tools = new Set<string>();
	let stale = 0;
	let candidates = 0;
	let kept = 0;
	let suppressed = 0;
	let unstructured = 0;
	for (const entry of entries) {
		for (const tool of entry.sources ?? []) tools.add(tool);
		if (entry.stale) stale += 1;
		const outcome = entry.outcome;
		if (outcome === undefined) continue;
		candidates += outcome.candidates;
		kept += outcome.kept;
		suppressed += outcome.suppressed;
		if (outcome.unstructured) unstructured += 1;
		// The files a mark actually acted on — the identity a reader needs to
		// reconstruct a replay report.
		if (outcome.suppressed > 0 && files.length < IDENTITY_CAP) {
			files.push(entry.displayPath);
		}
	}
	return {
		records: entries.length,
		stale,
		candidates,
		kept,
		dispositionSuppressed: suppressed,
		unstructured,
		files,
		tools: [...tools].slice(0, IDENTITY_CAP),
	};
}
