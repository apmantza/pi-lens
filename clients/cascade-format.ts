import type {
	CascadeNeighborResult,
	CascadeResult,
	CascadeRun,
	CascadeSectionLayout,
	CascadeUnansweredPrimaryNote,
} from "./cascade-types.js";
import { retagAuxiliaryDiagnostics } from "./dispatch/auxiliary-lsp.js";
import {
	applyFindingPolicy,
	loadProjectRulePolicy,
	renderedRuleIdentities,
} from "./dispatch/finding-policy.js";
import { detectFileRole } from "./file-role.js";
import { BoundedFifoMap } from "./bounded-cache.js";
import { logLatency } from "./latency-logger.js";
import { formatCacheAgeLabel } from "./finding-delivery-gate.js";
import { recordDegradationOnce } from "./degradation-ledger.js";
import { normalizeMapKey } from "./path-utils.js";
import type { LSPDiagnostic } from "./lsp/client.js";
import { demoteEnvironmentGapDiagnostics } from "./lsp/environment-gap.js";
import {
	PRIMARY_UNAVAILABLE_CAUSE,
	type PrimaryUnavailableCause,
} from "./lsp/diagnostic-binding.js";
import type { Diagnostic } from "./dispatch/types.js";
import { convertLspDiagnostics } from "./dispatch/utils/lsp-diagnostics.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";
import { readFileContent } from "./dispatch/runners/utils.js";

export function formatCascadeNeighborDiagnostics(
	cwd: string,
	neighbors: CascadeNeighborResult[],
	options: {
		noun?: string;
		includeReason?: boolean;
		/**
		 * #4487: the turn a diagnostic was first delivered, when that was an
		 * earlier turn. turn_end passes it (`cascadeStillPresentSince`); the
		 * line then reads "(still present since turn N)".
		 */
		stillPresentSince?: (
			neighbor: CascadeNeighborResult,
			diagnostic: Diagnostic,
		) => number | undefined;
	} = {},
): string {
	const withErrors = neighbors.filter((n) => n.diagnostics.length > 0);
	const inconclusive = neighbors.filter(
		(n) => n.inconclusive === true && n.diagnostics.length === 0,
	);
	// #1459: a neighbour whose scanner never looked at it is not a clean leaf. It
	// is also not `inconclusive` — the language server answered — so it gets its
	// own honest line instead of being folded into either bucket. Only the
	// zero-diagnostic case needs saying: a neighbour with findings already renders.
	const uncovered = neighbors.filter(
		(n) =>
			n.diagnostics.length === 0 &&
			n.inconclusive !== true &&
			(n.unconfirmedServerIds?.length ?? 0) > 0,
	);
	if (
		withErrors.length === 0 &&
		inconclusive.length === 0 &&
		uncovered.length === 0
	) {
		return "";
	}

	const noun = options.noun ?? "neighbor";
	let out =
		withErrors.length > 0
			? `📐 Cascade errors in ${withErrors.length} ${noun} file(s) — fix before finishing turn:`
			: "";
	for (const neighbor of withErrors) {
		const display = toRunnerDisplayPath(cwd, neighbor.filePath);
		const reason = options.includeReason ? ` reason="${neighbor.reason}"` : "";
		out += `\n<diagnostics file="${display}"${reason}>`;
		for (const d of neighbor.diagnostics) {
			const line = d.line ?? 1;
			const col = d.column ?? 1;
			const rule = d.rule ? ` rule=${d.rule}` : "";
			const since = options.stillPresentSince?.(neighbor, d);
			const label =
				since === undefined ? "" : ` (still present since turn ${since})`;
			out += `\n  line ${line}, col ${col}${rule}: ${d.message.split("\n")[0].slice(0, 100)}${label}`;
		}
		out += "\n</diagnostics>";
	}
	if (inconclusive.length > 0) {
		if (out) out += "\n";
		out += `⚠️ Cascade diagnostics inconclusive for ${inconclusive.length} ${noun} file(s) — no clean result was confirmed:`;
		for (const neighbor of inconclusive) {
			out += `\n  ${toRunnerDisplayPath(cwd, neighbor.filePath)}`;
		}
	}
	if (uncovered.length > 0) {
		if (out) out += "\n";
		out += `⚠️ Cascade scanners did not cover ${uncovered.length} ${noun} file(s) — no findings does NOT mean clean here:`;
		for (const neighbor of uncovered) {
			const servers = (neighbor.unconfirmedServerIds ?? []).join(", ");
			out += `\n  ${toRunnerDisplayPath(cwd, neighbor.filePath)} (not scanned by ${servers})`;
		}
	}
	return out;
}

/**
 * One cascade section from its neighbour block (the
 * `formatCascadeNeighborDiagnostics` text, which each caller renders at its
 * own registered delivery seam) and its layout. Returns "" when there is
 * nothing to say: an empty block is silence, and silence is honest only when
 * everything was looked at, so the coverage line alone still speaks.
 */
export function composeCascadeSection(
	block: string,
	layout: CascadeSectionLayout,
	/** #4403 round 4 (N2): the lines naming primaries that did not answer. */
	unansweredPrimaryNote = "",
): string {
	const diagnosticsBlock =
		block && unansweredPrimaryNote
			? `${block}\n${unansweredPrimaryNote}`
			: block || unansweredPrimaryNote;
	// #3157 round 3, N1: `policySuppressed` does NOT speak on its own on
	// purpose: those findings WERE evaluated and every drop is the agent's own
	// mark or its project's own rule policy, and the quiet-window lane says
	// nothing at all for that case (`buildResolvedFoundCascadeRun` returns
	// `undefined`).
	if (!diagnosticsBlock && !layout.coverageLine) return "";
	let out = !diagnosticsBlock
		? ""
		: layout.header
			? `${layout.header}\n${diagnosticsBlock}`
			: diagnosticsBlock;
	// A10: include truncated filenames so agent knows which files were cut
	if (layout.truncationLine) out += `\n${layout.truncationLine}`;
	if (layout.coverageLine) {
		if (out) out += "\n";
		out += layout.coverageLine;
	}
	// #1616 / #3157: a delivery that still has something to say states what it
	// dropped, once per delivery. Policy drops only: an aux drop is the file's
	// own suppression comment, which the per-edit dispatch path honours
	// silently too, and it stays in the `cascade_finding_policy` record.
	if (layout.policySuppressed > 0) {
		out += `\nsuppressed by disposition: ${layout.policySuppressed} finding(s) (marked false-positive or won't-fix).`;
	}
	return out;
}

/**
 * Build the turn-end `CascadeRun` for a neighbour whose diagnostics landed only
 * AFTER its cascade touch skipped the in-lane wait (#1023's `resolved-found`
 * quiet-window outcome; #1444 made native TS7 take that same path). Returns
 * `undefined` when there is nothing agent-facing to say — no ERROR-severity
 * diagnostics, or nothing the formatter renders.
 *
 * Lives here rather than inline in the quiet-window callback so the delivery
 * path (reconcile → run → turn_end) is testable end to end; index.ts only wires
 * it to `runtime.appendCascadeRun`.
 *
 * #3102: the survivors are what the agent READS, so they go through the same
 * `clients/dispatch/finding-policy.ts` stack — inline `pi-lens-ignore` → stored
 * dispositions → the project's `.pi-lens.json` rule policy — that the per-edit
 * dispatcher, `mode=full` and the `source=lsp` probe lane apply. Without it a
 * cold-neighbour ERROR the agent already marked `false-positive` came back on
 * every quiet-window reconcile.
 */
export function buildResolvedFoundCascadeRun(
	cwd: string,
	neighbor: {
		filePath: string;
		diagnostics: LSPDiagnostic[];
		/** #3168 F3: the #1444 publish stamp, threaded to the run so the carried
		 * age label renders the real observation age. */
		publishedAt?: number;
		/** #4495 round 3: the touch's pre-notify stamp, the run's read bound. */
		touchedAt?: number;
	},
): CascadeRun | undefined {
	const { filePath } = neighbor;
	const errors = neighbor.diagnostics.filter((d) => d.severity === 1);
	if (errors.length === 0) return undefined;
	const policyStart = Date.now();
	// This lane's roots are one and the same: index.ts hands `runtime.projectRoot`
	// in as `cwd`, so the retag's config lookup and the disposition/rule-policy
	// store read the same directory. The in-lane cascade's do NOT — see
	// `applyCascadeDisplayPolicy`.
	const { diagnostics, suppressed, auxSuppressed, total } =
		applyCascadeDisplayPolicy(errors, {
			cwd,
			policyRoot: cwd,
			filePath,
		});
	// One bounded record per RUN, never one per finding (docs/engineering-principles.md "Every new failure path gets bounded
	// observability"). This is a PUSH surface: silence after a mark is the mark
	// working, not a clean verdict, so the count is recorded here rather than
	// re-announced to the agent on every reconcile. `durationMs` covers the
	// content read too — the latency this fold added to the quiet-window
	// callback, measurable in the same per-phase record as every other cost.
	recordCascadeFindingPolicy({
		filePath,
		durationMs: Date.now() - policyStart,
		suppressed,
		total,
		auxSuppressed,
	});
	// No zero-length early return here: `formatCascadeNeighborDiagnostics`
	// renders "" for a neighbour with no diagnostics and the `!formatted` guard
	// below already returns `undefined` for it — a second check was mutation-
	// inert (M7: deleting it left all 7 cascade cases green).
	const neighbors: CascadeNeighborResult[] = [
		{ filePath, reason: "references", diagnostics, lspTouched: true },
	];
	const layout: CascadeSectionLayout = {
		cwd,
		noun: "cold neighbor",
		includeReason: false,
		header: "",
		truncationLine: "",
		coverageLine: "",
		policySuppressed: suppressed,
	};
	// @delivery-surface: cascade-format:resolved-found-run
	const rendered = formatCascadeNeighborDiagnostics(cwd, neighbors, {
		noun: layout.noun,
	});
	if (!rendered) return undefined;
	// #1616 / #3102 AC 4, round 2 F2: a delivery that still has something to say
	// states what it dropped, once per delivery — the same sentence the
	// late-auxiliary advisory renders (`clients/runtime-turn.ts`). A delivery
	// with NOTHING left says nothing at all — silence on a push surface is not
	// a claim that the neighbour is clean.
	const formatted = composeCascadeSection(rendered, layout);
	return {
		filePath,
		result: {
			filePath,
			impact: {
				filePath,
				changedSymbols: [],
				directImporters: [],
				directCallers: [],
				neighborFiles: [filePath],
				riskFlags: [],
			},
			neighbors,
			formatted,
			layout,
		},
		neighborCount: 1,
		diagnosticCount: diagnostics.length,
		// #3168 F3: the #1444 publish stamp — the run's own observation time, so
		// the carried-render age label states the real age instead of claiming
		// no stamp exists.
		...(neighbor.publishedAt !== undefined
			? { observedAt: neighbor.publishedAt }
			: {}),
		...(neighbor.touchedAt !== undefined
			? { checkedAt: neighbor.touchedAt }
			: {}),
	};
}

/** What one cascade neighbour's display list looks like after the stack. */
export interface CascadeDisplayPolicyResult {
	/** Survivors — what the cascade block renders, after `displayCap`. */
	diagnostics: Diagnostic[];
	/** Dropped by the policy stack (inline ignore / disposition / rule policy). */
	suppressed: number;
	/** Dropped by the auxiliary profile's OWN native suppression, disjoint from
	 * `suppressed`. */
	auxSuppressed: number;
	/** Converted entries before either drop — the record's denominator. */
	total: number;
}

/**
 * The ONE convert → retag → `applyFindingPolicy` derivation every cascade
 * DISPLAY lane runs before its diagnostics reach the agent (#3102/#3157).
 *
 * Five lanes render `CascadeNeighborResult.diagnostics` through
 * `formatCascadeNeighborDiagnostics`: the quiet-window builder above, and the
 * four in-lane sites in `clients/dispatch/integration.ts` (passive cold
 * snapshot, fresh touch, touch-error fallback, degraded fallback). Each one
 * used to open-code `convertLspDiagnostics(...)` and render the result raw, so
 * a neighbour ERROR the agent had marked `false-positive` was hidden by
 * `mode=delta`/`mode=full`/the per-edit dispatcher/the probe lane and STILL
 * re-reported by the cascade block on every edit that cascaded to it (#3157).
 *
 * TWO ROOTS, deliberately separate (the #1030 rule):
 *  - `cwd` is the LANGUAGE root, and only `retagAuxiliaryDiagnostics` sees it
 *    — `profile.allowBlocking(cwd)` looks for a local opengrep/zizmor/typos
 *    config, exactly as the per-edit runner (`runners/lsp.ts`) passes
 *    `ctx.cwd`.
 *  - `policyRoot` is the PROJECT root, and the disposition store and the
 *    `.pi-lens.json` rule map are read from it — `lens_diagnostic_mark` writes
 *    under `runtime.projectRoot` (`index.ts`), so reading from a nested
 *    language root in a monorepo opens a different
 *    `diagnostic-dispositions.json` and silently no-ops every mark. This is
 *    what `dispatcher.ts` already does with `ctx.projectRoot ?? ctx.cwd`.
 *
 * The auxiliary drop set (native `# nosemgrep`-style comments, `skipTestFiles`)
 * is KEPT: every caller's diagnostics come straight off a client cache or a
 * `touchFile` result, so nothing upstream ran `applyAuxiliarySuppressions`
 * (only the `mode=full` workspace sweep does, `clients/lsp/index.ts`) and this
 * is the FIRST application, not a double-apply — which is why the probe lane
 * ignores it and these lanes do not.
 *
 * No `range.start.line` pre-partition here, unlike the late-auxiliary drain,
 * whose own comment gives the alignment reason (`clients/runtime-turn.ts`,
 * above its `anchored` filter): `convertLspDiagnostics` drops line-less
 * entries, which would break the 1:1 index pairing `retagAuxiliaryDiagnostics`
 * needs. That reason holds here too — it is simply already satisfied. Every
 * caller reads the same `client.getAllDiagnostics()` / `touchFile` map, whose
 * `mergeDiagnosticLists` (`clients/lsp/client.ts`) dereferences
 * `diagnostic.range.start.line` unguarded, so a line-less entry throws long
 * before any builder sees it and `converted` is always 1:1 with `errors`.
 *
 * Reads nothing when there is nothing to render, and never logs: the RECORD is
 * the caller's decision, because the in-lane lane walks up to
 * `CASCADE_NEIGHBOUR_BUDGET` neighbours per edit and must aggregate one row per
 * run rather than one per neighbour.
 */
export function applyCascadeDisplayPolicy(
	/** ERROR-severity raw diagnostics, already capped by the caller's own
	 * display cap (`MAX_PER_FILE` in-lane; uncapped for the single-neighbour
	 * quiet-window run). */
	errors: LSPDiagnostic[],
	options: {
		/** Language root — `retagAuxiliaryDiagnostics` only. */
		cwd: string;
		/** Project root — disposition store and `.pi-lens.json` rule policy. */
		policyRoot: string;
		filePath: string;
		/**
		 * The cited file's current bytes when the caller ALREADY has them (the
		 * in-lane active touch reads the neighbour to feed `touchFile`). Omitted,
		 * this reads the file once — only now that there is something to render.
		 */
		content?: string;
		/**
		 * How many SURVIVORS one neighbour may render. Applied last, after the
		 * policy, so a policy drop can never consume a display slot (#3157 round
		 * 2, F1: with the cap applied first, a neighbour whose first 20 ERRORs
		 * were all marked `false-positive` rendered NOTHING while genuine
		 * unmarked errors sat below the cap — a false clean, and worse than the
		 * unfiltered behaviour for that input). It also has to stay after
		 * `retagAuxiliaryDiagnostics`, which needs `converted` index-aligned 1:1
		 * with its input. Omitted → no display cap, which is the quiet-window
		 * lane's single-neighbour case.
		 */
		displayCap?: number;
	},
): CascadeDisplayPolicyResult {
	const { cwd, policyRoot, filePath } = options;
	// #4532 round 5 (review F3; AGENTS.md shape 71): the environment-gap rule of
	// `demoteLanguageServerRows`, run here because both cascade lanes reach this
	// seam and it is synchronous (#3157), so the pipeline's async membership
	// probe stays out. A demoted row is a warning, and a cascade renders ERRORs
	// only, so it leaves the neighbour's list as any warning row does.
	const live = demoteEnvironmentGapDiagnostics(errors, { filePath }).filter(
		(d) => d.severity === 1,
	);
	if (live.length === 0) {
		return { diagnostics: [], suppressed: 0, auxSuppressed: 0, total: 0 };
	}
	// `undefined` → the fail-open empty string: inline suppression becomes a
	// no-op and a STRICT `false-positive` anchor hashes an empty line, so a
	// finding is never hidden by an I/O error (AGENTS.md shape 48).
	//
	// The neighbour's current bytes, for the two content-bound halves of the
	// policy stack (inline `pi-lens-ignore` and the STRICT `false-positive`
	// anchor). One synchronous read, paid only once a neighbour actually has ERROR
	// diagnostics to render — the same read `mode=full` pays per flagged file and
	// the probe lane pays per cache replay.
	//
	// SYNC here, while the in-lane cascade's own neighbour read at
	// `clients/dispatch/integration.ts` (the active touch, under its "A6: async
	// read to avoid blocking event loop on network-mounted drives" comment) is
	// ASYNC. The asymmetry is deliberate and measured, not an oversight: that read
	// happens for EVERY actively-touched neighbour in a parallel fan-out, while
	// this one is paid at most once per DELIVERING neighbour — 0.0125 ms per
	// neighbour measured on 40 real 15.6 KiB sources (#3157 AC 3), on loops that
	// already do synchronous fs work (`nodeFs.existsSync` in the degraded
	// fallback, and the `boundToCurrentDisk` verify whenever the producer attached
	// a content hash and its (path, mtime, size) memo misses —
	// `clients/lsp/diagnostic-binding.ts`). An async read here would force the
	// quiet-window builder's synchronous callback to become async for no
	// measurable gain.
	const content = options.content ?? readFileContent(filePath);
	const converted = convertLspDiagnostics(live, filePath);
	// #692/#3046: identity comes from the ONE shared derivation every other
	// surface anchors a mark against — never a hardcoded `tool: "lsp"`.
	const retained = retagAuxiliaryDiagnostics(converted, live, content ?? "", {
		cwd,
		fileRole: detectFileRole(filePath, content),
	});
	const { kept } = applyFindingPolicy(retained, {
		cwd: policyRoot,
		filePath,
		content: content ?? "",
		policyMap: loadProjectRulePolicy(policyRoot),
		identities: renderedRuleIdentities,
	});
	return {
		diagnostics:
			options.displayCap === undefined
				? kept
				: kept.slice(0, options.displayCap),
		// Policy drops only, DISJOINT from `auxSuppressed` — the same split the
		// `late_auxiliary_findings` record uses, so one operator reading both
		// records does not have to know that one nests and the other does not.
		suppressed: retained.length - kept.length,
		auxSuppressed: converted.length - retained.length,
		total: converted.length,
	};
}

/**
 * The ONE `cascade_finding_policy` row both cascade display lanes write.
 *
 * Gated on EITHER counter (#3102 round 2, F1): gating on the policy count alone
 * made an aux-only drop — an ERROR master rendered, removed by the profile's own
 * `# nosemgrep` / `skipTestFiles` rule — vanish with no row at all, the
 * silent-drop shape this record exists to prevent (AGENTS.md shape 10). The
 * `late_auxiliary_findings` twin reports both counters every drain.
 */
export function recordCascadeFindingPolicy(entry: {
	/** The file the RUN is about: the cold neighbour for the quiet-window
	 * builder, the edited primary for an in-lane cascade that aggregates every
	 * neighbour it walked. */
	filePath: string;
	durationMs: number;
	suppressed: number;
	total: number;
	auxSuppressed: number;
	/**
	 * ERRORs the policy never LOOKED at, because the caller's pre-policy input
	 * bound cut them (#3157 round 2). Reported whenever it is non-zero even if
	 * nothing else was dropped: an input bound whose loss is invisible is the
	 * exact shape F1 found in the display cap, and this is the one counter that
	 * keeps `total` from reading as the neighbour's whole error set.
	 */
	inputTruncated?: number;
}): void {
	const inputTruncated = entry.inputTruncated ?? 0;
	if (
		entry.suppressed === 0 &&
		entry.auxSuppressed === 0 &&
		inputTruncated === 0
	)
		return;
	logLatency({
		type: "phase",
		toolName: "cascade",
		filePath: entry.filePath,
		phase: "cascade_finding_policy",
		durationMs: entry.durationMs,
		metadata: {
			suppressed: entry.suppressed,
			total: entry.total,
			auxSuppressed: entry.auxSuppressed,
			...(inputTruncated > 0 && { inputTruncated }),
		},
	});
}

/**
 * Fix B (#3167/#3168): the carry label for a cascade run re-rendered at a
 * later turn_end. The carry is bounded to ONE turn (`RuntimeCoordinator.beginTurn`
 * drops anything that would reach 2), so the honest label names the carry
 * count. #3168 F3 corrected this docstring's earlier claim that no stamp
 * exists: the run DOES carry one (`observedAt`, threaded from #1444's
 * `publishedAt` through the resolved-found plumb), so the age half renders
 * from it via `formatCacheAgeLabel`. The deferred-compute re-park arm has no
 * stamp and correctly falls to the neutral wording. Returns `undefined` for
 * non-carried runs: no label noise on fresh observations.
 */
export function cascadeCarrySuffix(
	carriedTurns?: number,
	observedAt?: number | undefined,
): string | undefined {
	if (carriedTurns === undefined || carriedTurns < 1) return undefined;
	const noun = carriedTurns === 1 ? "turn" : "turns";
	return `(carried ${carriedTurns} ${noun} · ${formatCacheAgeLabel(observedAt)})`;
}

/**
 * #4403 round 5 (V1): the primary language servers whose cascade line reached
 * the agent this session. The cause holds for every neighbour the server
 * would serve, so it is said once per server; later runs drop those
 * neighbours silently, as every run did before #4403. A server is marked
 * when turn_end delivers its line, not when a run computes it: turn_end drops
 * a run a later write superseded (clients/runtime-turn.ts), and the line must
 * not go with it.
 */
const cascadeUnansweredPrimariesDelivered = new Set<string>();

/** Session reset (`resetDispatchBaselines` in clients/dispatch/integration.ts). */
export function resetCascadeUnansweredPrimariesDelivered(): void {
	cascadeUnansweredPrimariesDelivered.clear();
}

/** The cascade section that rendered these servers' lines reached the agent. */
export function markCascadeUnansweredPrimariesDelivered(
	serverIds: readonly string[],
): void {
	for (const id of serverIds) cascadeUnansweredPrimariesDelivered.add(id);
}

/**
 * Splits out the neighbours whose primary did not answer and returns a line
 * per server set and cause, in the order the touch named the servers. A set
 * whose servers were all delivered gets no line again; its neighbours come
 * back as `dropped`, so the run can still refuse to read clean (#4485).
 */
export function splitCascadeUnansweredPrimaries(
	neighbors: CascadeNeighborResult[],
): {
	answered: CascadeNeighborResult[];
	unanswered: CascadeNeighborResult[];
	/** #4485: neighbours of a set whose line was already delivered: not
	 * shown again, and not checked, so the run is not clean. */
	dropped: CascadeNeighborResult[];
	notes: CascadeUnansweredPrimaryNote[];
} {
	const answered: CascadeNeighborResult[] = [];
	const groups = new Map<
		string,
		{
			serverIds: readonly string[];
			cause: PrimaryUnavailableCause;
			neighbors: CascadeNeighborResult[];
		}
	>();
	for (const neighbor of neighbors) {
		const unavailable = neighbor.primaryUnavailable;
		if (!unavailable) {
			answered.push(neighbor);
			continue;
		}
		const key = `${unavailable.serverIds.join(",")}|${unavailable.cause}`;
		const group = groups.get(key) ?? { ...unavailable, neighbors: [] };
		group.neighbors.push(neighbor);
		groups.set(key, group);
	}
	const unanswered: CascadeNeighborResult[] = [];
	const dropped: CascadeNeighborResult[] = [];
	const notes: CascadeUnansweredPrimaryNote[] = [];
	for (const group of groups.values()) {
		if (
			group.serverIds.every((id) => cascadeUnansweredPrimariesDelivered.has(id))
		) {
			// #5014 r2 (F2): the line is said once, the findings every run. A
			// fallback's findings stay visible; only an empty neighbour drops.
			for (const neighbor of group.neighbors)
				(neighbor.diagnostics.length > 0 ? unanswered : dropped).push(neighbor);
			continue;
		}
		unanswered.push(...group.neighbors);
		notes.push({
			serverIds: group.serverIds,
			line: `⚠️ Cascade: no primary language server answered for neighbor files of ${group.serverIds.join(", ")} (${PRIMARY_UNAVAILABLE_CAUSE[group.cause]}), so their cross-file errors were not confirmed (not a clean result).`,
		});
	}
	return { answered, unanswered, dropped, notes };
}

/**
 * What turn_end shows for a cascade result: its text without the lines naming
 * primaries, and the lines it keeps. A line stays only while one of its
 * servers is neither delivered nor already shown in this turn's section
 * (`shownServerIds`, which this adds the kept servers to), so two runs of one
 * turn show it once and a run carried past the delivery shows it no more.
 * turn_end puts the kept lines at the head of the section (round 6, W2): a
 * leading section the cap cuts still counts as delivered, so a line after the
 * cut point would be marked without being read.
 */
export function renderCascadeResult(
	result: CascadeResult,
	shownServerIds: Set<string>,
): { text: string; lines: string[]; serverIds: string[] } {
	const unanswered = result.unansweredPrimaries;
	if (!unanswered) return { text: result.formatted, lines: [], serverIds: [] };
	const kept = unanswered.notes.filter((note) =>
		note.serverIds.some(
			(id) =>
				!cascadeUnansweredPrimariesDelivered.has(id) && !shownServerIds.has(id),
		),
	);
	const serverIds = kept.flatMap((note) => [...note.serverIds]);
	for (const id of serverIds) shownServerIds.add(id);
	return {
		text: unanswered.formattedWithoutNotes,
		lines: kept.map((note) => note.line),
		serverIds,
	};
}

// --- #4487: pending neighbour errors ---------------------------------------

/**
 * A neighbour's cascade errors the agent was shown and no fresh observation
 * has cleared yet, each with the turn it was first delivered. turn_end is the
 * only writer of errors (it writes what it delivered) and clears an entry on
 * a fresh clean observation; it reads the record to label a re-observed error
 * "still present since turn N" and to name, in one line each, the neighbours
 * no cascade covered this turn.
 *
 * Its own store, not the footer widget's: a widget entry carries an error
 * but not whether it was a cascade neighbour's (the per-edit writes share the
 * `lsp` tool), so the turn_end re-serve could not select from it. It replaces
 * two stores this lane deleted, the recently-clean neighbour cache and the
 * rolling `session.baseline.cascade.*` delta facts.
 */
interface PendingNeighbor {
	filePath: string;
	/** `cascadeErrorKey` → the error's first-delivered turn and its
	 * disposition identity (#5344). */
	errors: Map<string, PendingNeighborError>;
	/** When the observation behind the record was made. */
	checkedAt: number;
}

/** One recorded error: when the agent first saw it, and what a later mark
 * has to match to retire it. */
interface PendingNeighborError {
	/** The turn the error was first delivered. */
	turn: number;
	identity: CascadePendingError;
}

/**
 * The identity that retires a pending error: what a disposition anchor binds
 * (#5344), not the whole diagnostic. A mark is anchored on the path, the
 * `(tool, rule)` identity, the message and the flagged line's content, and a
 * `"blocking"` finding can only be dropped by the strict anchor, so those are
 * exactly the fields a later turn needs to re-judge the stored error through
 * `filterFindingsByDisposition`. Every one is a reference to a string the
 * record already kept inside `cascadeErrorKey`, so the record grows by one
 * small object per error, bounded with the record itself
 * (`MAX_PENDING_NEIGHBORS` × the per-file display cap).
 */
export interface CascadePendingError {
	filePath: string;
	message: string;
	line?: number;
	tool: string;
	rule?: string;
	semantic?: string;
}

/** Bound on the record; the oldest-written entry goes first. */
const MAX_PENDING_NEIGHBORS = 256;
// Insertion-ordered, bounded by `set` itself (#4570: was a hand-rolled
// `while (pendingNeighbors.size > cap)` evict-oldest block).
const pendingNeighbors = new BoundedFifoMap<string, PendingNeighbor>(
	MAX_PENDING_NEIGHBORS,
);

/** One diagnostic's identity across observations: the rule, place and text
 * the agent reads. */
export function cascadeErrorKey(diagnostic: Diagnostic): string {
	return [
		diagnostic.id,
		diagnostic.rule ?? "",
		diagnostic.line ?? 0,
		diagnostic.column ?? 0,
		diagnostic.message,
	].join(":");
}

/**
 * The turn `diagnostic` of `filePath` was first delivered, when that was
 * before `turn`; `undefined` for an error new this turn.
 */
export function cascadeStillPresentSince(
	filePath: string,
	diagnostic: Diagnostic,
	turn: number,
): number | undefined {
	const first = pendingNeighbors
		.get(normalizeMapKey(filePath))
		?.errors.get(cascadeErrorKey(diagnostic));
	return first !== undefined && first.turn < turn ? first.turn : undefined;
}

/**
 * Record what turn_end delivered for one neighbour: exactly the observed set
 * (an error the observation lacks is dropped, the #4484 rule), keeping each
 * error's first-delivered turn. An empty set clears the neighbour.
 */
export function recordDeliveredCascadeNeighbor(
	filePath: string,
	diagnostics: readonly Diagnostic[],
	turn: number,
	checkedAt: number,
): void {
	const key = normalizeMapKey(filePath);
	const previous = pendingNeighbors.get(key);
	const errors = new Map<string, PendingNeighborError>();
	for (const d of diagnostics) {
		const k = cascadeErrorKey(d);
		errors.set(k, {
			turn: previous?.errors.get(k)?.turn ?? turn,
			identity: {
				filePath: d.filePath,
				message: d.message,
				...(d.line !== undefined && { line: d.line }),
				tool: d.tool,
				...(d.rule !== undefined && { rule: d.rule }),
				...(d.semantic !== undefined && { semantic: d.semantic }),
			},
		});
	}
	pendingNeighbors.delete(key);
	if (errors.size === 0) return;
	// The cap lives in the map (#4570): `set` evicts the oldest entries and
	// reports them, so the degradation is recorded once for the batch rather
	// than inside a hand-rolled evict-oldest loop.
	if (pendingNeighbors.set(key, { filePath, errors, checkedAt }).length > 0) {
		recordDegradationOnce({
			kind: "cascade-pending-neighbors-evicted",
			subject: `cap=${MAX_PENDING_NEIGHBORS}`,
			reason:
				"the pending cascade neighbour-error record hit its cap; the oldest neighbour's errors are no longer re-served",
		});
	}
}

/**
 * A fresh observation says `filePath` holds no cascade error: a confirmed
 * clean, a late clean publish, or the file's own dispatch after an edit.
 * `observedAt`, when given, must be newer than the record's own observation.
 */
export function forgetCascadePendingNeighbor(
	filePath: string,
	observedAt?: number,
): void {
	const key = normalizeMapKey(filePath);
	const entry = pendingNeighbors.get(key);
	if (!entry) return;
	if (observedAt !== undefined && observedAt <= entry.checkedAt) return;
	pendingNeighbors.delete(key);
}

/** The record, oldest-written first. */
export function listCascadePendingNeighbors(): ReadonlyArray<{
	filePath: string;
	errorCount: number;
	checkedAt: number;
	/**
	 * Each recorded error's disposition identity (#5344), so a mark made after
	 * the delivery that wrote the record is honoured the next time the record
	 * renders instead of waiting for a fresh observation of the neighbour.
	 */
	errors: readonly CascadePendingError[];
}> {
	return [...pendingNeighbors.values()].map((entry) => ({
		filePath: entry.filePath,
		errorCount: entry.errors.size,
		checkedAt: entry.checkedAt,
		errors: [...entry.errors.values()].map((stored) => stored.identity),
	}));
}

/** O(1) entry count, for the memory sample. */
export function getCascadePendingNeighborCount(): number {
	return pendingNeighbors.size;
}

/** Session reset (`resetDispatchBaselines` in clients/dispatch/integration.ts). */
export function resetCascadePendingNeighbors(): void {
	pendingNeighbors.clear();
}
