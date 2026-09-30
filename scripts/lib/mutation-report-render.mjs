/**
 * Renders the driver's `reports/mutation/mutation.json` (Stryker's own
 * report augmented with a `piLensMutationDiff` key -- see
 * scripts/stryker-diff.mjs's writeReport) as the markdown used for the job
 * summary and the sticky PR comment, and by `scripts/mutation-report.mjs`
 * for a fixer or reviewer citing PR evidence directly (#3531).
 *
 * Pure and file-I/O-free so it is unit-testable against literal report
 * fixtures; scripts/mutation-report.mjs and the workflow step are the only
 * callers that touch the filesystem.
 */

const STICKY_MARKER = "<!-- pi-lens-mutation-diff -->";

function shortSha(sha) {
	return typeof sha === "string" ? sha.slice(0, 12) : "unknown";
}

function metaTable(meta) {
	const rows = [
		["Base", meta.base ?? "?"],
		["Head", `\`${shortSha(meta.headSha)}\``],
	];
	if ((meta.filesSkippedOverCap?.length ?? 0) > 0) {
		rows.push([
			"Skipped (over --max-files)",
			meta.filesSkippedOverCap.join(", "),
		]);
	}
	if ((meta.filesUncovered?.length ?? 0) > 0) {
		rows.push(["No covering test", meta.filesUncovered.join(", ")]);
	}
	const selectionRow = testSelectionRow(meta);
	if (selectionRow) rows.push(selectionRow);
	const incrementalRow = incrementalRowOf(meta);
	if (incrementalRow) rows.push(incrementalRow);
	const rendered = rows.map(([k, v]) => `- **${k}:** ${v}`);
	if ((meta.testsExcluded?.length ?? 0) > 0) {
		rendered.push(
			"- **Excluded tests:**",
			...meta.testsExcluded.map(
				({ file, reason }) => `  - \`${file}\` — ${reason}`,
			),
		);
	}
	return rendered.join("\n");
}

/**
 * The `related N → covering M → kept K` line the driver logs and the report's
 * metadata table shows (#3810). `covering` is null when no coverage probe was
 * usable and the kept set came from the import graph alone.
 *
 * @param {{pool: number, covering: number | null, kept: number, own?: number, unknown?: number}} selection
 */
export function formatTestSelection(selection) {
	const covering =
		selection.covering === null
			? "coverage unavailable (import-graph ranking)"
			: String(selection.covering);
	const extras = [
		selection.own > 0 ? `${selection.own} own` : null,
		selection.unknown > 0 ? `${selection.unknown} probe failed` : null,
	].filter(Boolean);
	return `related ${selection.pool} → covering ${covering} → kept ${selection.kept}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
}

function validTestSelection(meta) {
	const selection = meta.testSelection;
	return selection &&
		typeof selection.pool === "number" &&
		typeof selection.kept === "number" &&
		typeof selection.dropped === "number" &&
		(selection.covering === null || typeof selection.covering === "number")
		? selection
		: null;
}

function testSelectionRow(meta) {
	const selection = validTestSelection(meta);
	return selection ? ["Test selection", formatTestSelection(selection)] : null;
}

const INCREMENTAL_STATES = {
	"cold-no-cache": "cold (no restored cache)",
	"cold-inputs-changed":
		"cold (a kept test or another changed file differs from the cached run)",
};

function incrementalRowOf(meta) {
	const incremental = meta.incremental;
	if (!incremental) return null;
	if (incremental.state === "warm") {
		return [
			"Incremental",
			typeof incremental.reused === "number" &&
			typeof incremental.total === "number"
				? `${incremental.reused} of ${incremental.total} mutant result(s) reused from the previous push`
				: "restored cache accepted (reuse count unavailable)",
		];
	}
	const text = INCREMENTAL_STATES[incremental.state];
	return text ? ["Incremental", text] : null;
}

// Only a DROPPED test makes the population truncated: kept < covering is not
// the test, since a PR's own tests are kept whether or not they cover a line.
function testCapNotice(meta) {
	const selection = validTestSelection(meta);
	if (!selection || selection.dropped <= 0) return null;
	return `**Bounded evidence:** ${selection.dropped} ${selection.covering === null ? "related" : "covering"} test(s) dropped by the test cap (${selection.kept} kept). The score is from a truncated test population.`;
}

/**
 * @param {object} report a parsed reports/mutation/mutation.json
 * @returns {string} markdown
 */
export function renderMutationMarkdown(report) {
	const meta = report?.piLensMutationDiff ?? {};
	const lines = [STICKY_MARKER, "### Mutation diff (advisory)", ""];

	// round 2 R2-1: shared by the zero-mutant and the scored path below, so a
	// run that sampled ranges down and then found nothing still SAYS it
	// sampled -- previously the zero-mutant branch returned before this note
	// was ever built, so a false-looking "no mutable code in M ranges" verdict
	// carried no hint that only a subset of M was actually tried.
	const samplingNote = meta.rangesSampled
		? `_Sampled ${meta.rangesEvaluated ?? "?"} of ${meta.rangesTotal ?? "?"} changed-line ranges deterministically (seed \`${shortSha(meta.headSha)}\`)._`
		: null;

	// round 5 R4-1: `meta.counts` is only ever set by THIS driver's own
	// completed/partial write paths. A raw Stryker `mutation.json` -- read
	// directly, never through `scripts/stryker-diff.mjs`'s `writeReport` --
	// carries no `piLensMutationDiff` at all, so `meta.counts` is absent even
	// though `report.files` holds real mutants. Deriving the counts (and so
	// the total the backstop below reads) from those mutants when `counts`
	// itself is missing keeps the backstop from misreading a genuine result
	// as 0 evaluated (verified: at `fbb080105`, a raw report with 1 Survived +
	// 1 Killed and no meta rendered "0 mutants evaluated" instead of "####
	// Survivors (1)") -- and keeps the score line's own killed/survived/…
	// breakdown consistent with that total, rather than showing "(2 total)"
	// against "0 killed, 0 survived".
	const counts =
		meta.counts ??
		Object.values(report?.files ?? {}).reduce((out, file) => {
			for (const mutant of file.mutants ?? []) {
				out[mutant.status] = (out[mutant.status] ?? 0) + 1;
			}
			return out;
		}, {});
	const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

	// round 4 R3-1: a backstop at the render seam, independent of which
	// driver branch wrote the report. Every driver path that evaluates zero
	// mutants is SUPPOSED to set `meta.zeroMutants`, and every interrupted
	// path with a usable result is SUPPOSED to set `meta.partial` -- but the
	// review found the driver's own success-vs-zero and partial-vs-zero `if`s
	// still readable as removable duplicates: mutating either one (`if
	// (mutants.length > 0)` to `>= 0`, or `if (outcome.partial)` to `false`)
	// produced a report with NEITHER `zeroMutants` NOR `partial` set and 0
	// total mutants -- the exact S1 clean-pass signature -- with all four
	// mutation test files still 100/100 green, since nothing exercises the
	// DRIVER's own branch, only the library functions it calls. This renders
	// that same signature as "not a clean pass" regardless of which driver
	// path (existing or one written later) produced it.
	const zeroMutants =
		meta.zeroMutants ??
		(!meta.partial && total === 0
			? {
					reason:
						"the report has no zeroMutants explanation and no partial result, but scored 0 total mutants -- rendered as unresolved rather than a clean pass",
				}
			: null);

	if (zeroMutants) {
		lines.push(
			"**0 mutants evaluated.** This is not a clean pass -- it means the lane found nothing to mutate or could not finish.",
			"",
			`> ${zeroMutants.reason}`,
			"",
		);
		if (samplingNote) lines.push(samplingNote, "");
		const capNote = testCapNotice(meta);
		if (capNote) lines.push(capNote, "");
		lines.push(metaTable(meta));
		return lines.join("\n");
	}

	// #3592 item 2: a second, independent backstop from round 4's R3-1 one
	// above. That one catches a report with 0 total mutants and neither
	// `zeroMutants` nor `partial` set. This one catches the OTHER shape a
	// dropped `partial` flag can produce: a run that was cut short AFTER
	// evaluating SOME mutants (so `total > 0`, the R3-1 backstop does not
	// fire) but fewer than the dry run measured for this same, unsampled
	// candidate set -- if a future driver change stopped setting
	// `meta.partial` on that path, the report would otherwise render as a
	// normal, complete scored pass with a silently short survivor table.
	// Only meaningful when NOT sampled: a sampled run legitimately evaluates
	// fewer mutants than `measuredTotalMutants` (which counts the WHOLE
	// candidate range set, not just the sampled subset) by design, and no
	// per-range count exists to compute an expected sampled total (#3592
	// item 1).
	// F3 (#3592 round 2): `!zeroMutants` and `total > 0` were dead conjuncts
	// -- control flow can only reach this line when the `if (zeroMutants)`
	// branch above did NOT return, i.e. `zeroMutants` is already falsy here,
	// and (given `!meta.partial` below) `total !== 0` follows from
	// `zeroMutants`'s own definition (`!meta.partial && total === 0`), so
	// `total > 0` was equally guaranteed rather than checked. Removed; the
	// remaining four conjuncts are the only ones a mutation can affect.
	const evaluatedMismatch =
		!meta.partial &&
		!meta.rangesSampled &&
		typeof meta.measuredTotalMutants === "number" &&
		meta.measuredTotalMutants !== total;

	if (evaluatedMismatch) {
		lines.push(
			`**Incomplete run.** This is not a clean pass -- ${total} mutant(s) were evaluated but the dry run measured ${meta.measuredTotalMutants}, and the report carries no partial explanation.`,
			"",
		);
		lines.push(metaTable(meta));
		return lines.join("\n");
	}

	const survivors = Object.entries(report.files ?? {}).flatMap(
		([fileName, file]) =>
			(file.mutants ?? [])
				.filter((m) => m.status === "Survived")
				.map((mutant) => ({ ...mutant, fileName })),
	);

	// round 2 S2: a budget kill can still leave a real, partial result --
	// labelled here so it is never confused with a run that evaluated every
	// range it set out to.
	if (meta.partial) {
		lines.push(
			`**Partial run** -- ${meta.partial.evaluated} of ${meta.partial.total ?? "an unknown total of"} mutant(s) evaluated before the interrupt.`,
			"",
			`> ${meta.partial.reason}`,
			"",
		);
	}

	const capNote = testCapNotice(meta);
	lines.push(
		`**Score: ${meta.score ?? "n/a"}%** -- ${counts.Killed ?? 0} killed, ${counts.Survived ?? 0} survived, ${counts.Timeout ?? 0} timeout, ${counts.NoCoverage ?? 0} no coverage (${total} total)${capNote ? ` — ${capNote.replaceAll("**", "")}` : ""}`,
		"",
	);

	if (samplingNote) lines.push(samplingNote, "");

	if (survivors.length > 0) {
		lines.push(`#### Survivors (${survivors.length})`, "");
		lines.push("| Location | Mutator | Original → Replacement |");
		lines.push("|---|---|---|");
		for (const mutant of survivors) {
			const location = mutant.tsLocation
				? `${mutant.tsLocation.fileName}:${mutant.tsLocation.line}`
				: `${mutant.fileName}:${mutant.location?.start?.line ?? "?"}`;
			const original = (mutant.original ?? "").replaceAll("|", "\\|");
			const replacement = (mutant.replacement ?? "").replaceAll("|", "\\|");
			lines.push(
				`| \`${location}\` | ${mutant.mutatorName} | \`${original}\` → \`${replacement}\` |`,
			);
		}
		lines.push("");
	} else {
		lines.push("No survivors.", "");
	}

	lines.push(metaTable(meta));
	if ((meta.testsRun?.length ?? 0) > 0) {
		lines.push(
			"",
			`<details><summary>Tests run (${meta.testsRun.length})</summary>\n\n${meta.testsRun.map((t) => `- \`${t}\``).join("\n")}\n\n</details>`,
		);
	}

	return lines.join("\n");
}

/**
 * Renders the sticky comment's body when THIS head produced no artifact to
 * download at all (round 2 T6): the driver crashed before `writeReport`, or
 * the job hit its 90-minute `timeout-minutes` cap outright. Without this,
 * the comment job's download step simply has nothing to post, and an
 * earlier head's report -- now stale, about a commit this PR no longer is
 * -- stays up with no indication it no longer applies to the current head.
 * Carries the same `STICKY_MARKER` so a later successful run still finds
 * and updates this same comment rather than posting a second one.
 *
 * `upstreamResult` (round 2 R2-4), when the caller can supply it (the
 * `mutation-comment` workflow job passes `needs.mutation.result`),
 * distinguishes a run GitHub reports as `cancelled` from one that failed
 * outright. Round 4: `cancelled` itself is ambiguous -- GitHub reports a job
 * that ran past its own `timeout-minutes` as `cancelled` too, the same
 * result the new per-PR concurrency group produces when a newer push
 * supersedes it, and this job has no way to tell those two apart -- so the
 * `cancelled` wording names both possibilities rather than picking one. With
 * no `cancelled` result at all, the wording stays neutral instead of
 * guessing "crashed" for what may equally be either of those.
 *
 * @param {{headSha?: string, runUrl?: string, upstreamResult?: string}} [context]
 * @returns {string} markdown
 */
export function renderStaleMarkdown({ headSha, runUrl, upstreamResult } = {}) {
	const cause =
		upstreamResult === "cancelled"
			? "cancelled: a newer push superseded it, or the job hit its time limit"
			: "a crash or hitting its overall time cap are both possible";
	const lines = [
		STICKY_MARKER,
		"### Mutation diff (advisory)",
		"",
		`**Stale.** This head (\`${shortSha(headSha)}\`) produced no mutation report -- ${cause} (distinct from the driver's own, narrower Stryker budget, which always writes a report even when Stryker itself times out).`,
		"",
		"This comment has just been updated to say so; any result it previously showed was for a different, earlier commit and no longer reflects this PR's current head.",
	];
	if (runUrl) lines.push("", `[Job run](${runUrl})`);
	return lines.join("\n");
}

export { STICKY_MARKER };
