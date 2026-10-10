/**
 * #3170 — the bounded persistent-reverify pass.
 *
 * A finding whose own file is unchanged is re-delivered turn after turn from
 * the persisted actionable-warnings report without ever being re-observed
 * against the live server: the in-band publish carries forward DEFERRED-origin
 * file entries while their file has not moved
 * (`mergeActionableWarningsReports`'s scope guard), and the delta freshness
 * gate passes them because the file's mtime has not moved either. When the
 * root cause was fixed in a DIFFERENT file, the carried finding is stale in
 * fact but fresh by every on-disk axis.
 *
 * This module re-observes those files at turn_end, BEFORE the advisory
 * assembles, and the replacement entries fold into the turn's SINGLE in-band
 * publish (#3176 F1: a separate replacement publish spends the carry marker
 * and the main publish then drops the entries at the scope guard — the
 * blocker the review caught).
 *
 * Review-round contracts (#3176):
 * - **F2**: the fresh observation converts through the PRODUCER's own
 *   pipeline (`enrichFileFromLsp` — severity-2, code-action enrichment,
 *   fixable-only, the per-file caps), fed the touch's collected diagnostics
 *   as the cached arm so no second pull happens. No re-implementation.
 * - **F3**: an empty result is clean ONLY when the touch itself answers
 *   `confirmation: "confirmed"` — the silent-on-clean rule (#240/#533/#1253).
 *   A bare `{diags: []}` (the house double's silent empty, a tier-3 server
 *   still analyzing, a `skipReason`) is UNCONFIRMED: the carried warnings are
 *   kept verbatim and the render labels the gap. `touched.inconclusive` is
 *   `resolveTouchVerdict`'s output computed service-side and is honored
 *   directly.
 * - **F4**: every await is bound-wrapped (`bounded()`); `maxClientWaitMs` is
 *   only the spawn/ready budget, not a request ceiling.
 * - **F6**: no skip guard — every deferred-origin entry re-verifies each
 *   turn (re-arm), per the issue's failure table.
 *
 * Bounds: at most {@link MAX_REVERIFY_FILES} files per turn_end, a wall
 * budget of {@link REVERIFY_BUDGET_MS}, the turn-end abort signal, and no
 * new durable state — candidates come from the persisted report itself,
 * which is what was delivered last turn.
 */

import * as fs from "node:fs";
import type {
	ActionableWarningsReport,
	ActionableWarningsReportFile,
	BuildActionableWarningsArgs,
} from "./actionable-warnings.js";
import { enrichFileFromLsp } from "./actionable-warnings.js";
import { bounded } from "./deadline-utils.js";
import { logLatency } from "./latency-logger.js";
import {
	touchCompletedConfirmationPolicy,
	type TouchFileResult,
} from "./lsp/diagnostic-binding.js";
import { type getLSPService } from "./lsp/capabilities.js";
import { findAuxiliaryProfileForSource } from "./dispatch/auxiliary-lsp.js";

/** At most this many files are re-observed per turn_end (the drift backstop's
 * own 4-resyncs-per-pass precedent). */
export const MAX_REVERIFY_FILES = 4;

/** Wall-clock budget for the whole pass; a touch that cannot answer inside
 * its remaining slice is recorded unconfirmed, never waited out. */
export const REVERIFY_BUDGET_MS = 3000;

/** The touch options the `source=lsp` probe uses, with this pass's source. */
const TOUCH_SOURCE = "persistent_reverify";

/** The real service type — the runtime passes `getLSPService()`'s result. */
export type ReverifyLspService = NonNullable<ReturnType<typeof getLSPService>>;

export interface PersistentReverifyOutcome {
	filePath: string;
	displayPath: string;
	/** clean = the touch answered `confirmation: "confirmed"` with no
	 * diagnostics; reconfirmed = every carried finding still matches a fresh
	 * record; mixed = some matched; unconfirmed = no confirmed answer inside
	 * the budget (the carried entry is kept verbatim and labeled). */
	outcome: "clean" | "reconfirmed" | "mixed" | "unconfirmed";
	dropped: number;
	kept: number;
}

export interface PersistentReverifyResult {
	outcomes: PersistentReverifyOutcome[];
	/** File entries carrying the fresh observation (or the incomplete marker),
	 * folded into the turn's single in-band publish by the caller. */
	replacementFiles: ActionableWarningsReportFile[];
	candidates: number;
	touched: number;
	/** Entries skipped because their file changed since its own stamp — the
	 * edit path already re-observed those. */
	skippedChanged: number;
}

/**
 * Select the report's re-verify candidates: DEFERRED-origin file entries (the
 * only population the in-band publish carries forward, so the only population
 * that re-serves across turns — F6: with no skip guard, so every carried
 * entry re-verifies each turn) whose file stat is UNCHANGED since the entry's
 * own observation stamp. A file that changed is skipped and counted — the
 * edit path already re-observed it. Missing files are skipped too: the delta
 * freshness gate drops them outright.
 */
export function selectPersistentReverifyFiles(
	report: ActionableWarningsReport,
	nowMs: number = Date.now(),
): { candidates: ActionableWarningsReportFile[]; skippedChanged: number } {
	const candidates: ActionableWarningsReportFile[] = [];
	let skippedChanged = 0;
	for (const entry of report.files) {
		if (entry.origin !== "deferred") continue;
		// F3 (population half): the pass re-observes through a PRIMARY-scope
		// touch, so an auxiliary-lane finding can never be re-confirmed — an
		// entry carrying aux-sourced warnings is skipped (kept verbatim),
		// never scored dropped. The aux lookup is the one shared seam.
		if (
			entry.warnings.some(
				(w) => findAuxiliaryProfileForSource(w.source ?? "") !== undefined,
			)
		) {
			continue;
		}
		const stamp = entry.generatedAt ? Date.parse(entry.generatedAt) : NaN;
		if (!Number.isFinite(stamp) || stamp > nowMs) continue;
		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(entry.filePath).mtimeMs;
		} catch {
			continue;
		}
		if (mtimeMs > stamp) {
			skippedChanged += 1;
			continue;
		}
		if (candidates.length < MAX_REVERIFY_FILES) candidates.push(entry);
	}
	return { candidates, skippedChanged };
}

/**
 * Run the bounded re-verify pass over the report's candidates and build the
 * replacement entries for the caller's single in-band publish. Never throws:
 * an unexpected per-file failure degrades that file to `unconfirmed` (kept
 * verbatim, labeled), which is the shape-48 direction — the harm reaching the
 * user is a hidden real finding, worse than re-delivering a stale one.
 */
export async function runPersistentReverify(args: {
	report: ActionableWarningsReport;
	cwd: string;
	lspService: ReverifyLspService;
	/** The turn's ambient abort signal. `AbortSignal | undefined` rather than a
	 * plain optional because the caller reads `getAmbientAbortSignal()`, which
	 * is `undefined` whenever the host supplies no ctx.signal (index.ts:3068) —
	 * the pass is best-effort by contract and the wall budget is the floor. */
	signal?: AbortSignal | undefined;
	nowMs?: number;
	/** Test seam: the wall budget, injected so the budget-check mutation is
	 * observable without real-second sleeps (#3176 proof gaps). */
	budgetMs?: number;
}): Promise<PersistentReverifyResult> {
	const started = Date.now();
	const deadlineAt = started + (args.budgetMs ?? REVERIFY_BUDGET_MS);
	const nowMs = args.nowMs ?? started;
	const { candidates, skippedChanged } = selectPersistentReverifyFiles(
		args.report,
		nowMs,
	);
	const outcomes: PersistentReverifyOutcome[] = [];
	const replacementFiles: ActionableWarningsReportFile[] = [];
	let touched = 0;

	// F2: the producer's own pipeline (enrichFileFromLsp) — constructed once,
	// reused per candidate. deltaOnly: false (a re-observation is not gated on
	// this turn's modified ranges — the file was not edited).
	const buildArgs: BuildActionableWarningsArgs = {
		cwd: args.cwd,
		sessionId: args.report.sessionId,
		turnIndex: 0,
		files: [],
		modifiedRangesByFile: new Map(),
		dispatchWarnings: [],
		includeLspCodeActions: true,
		deltaOnly: false,
		...(args.signal !== undefined ? { signal: args.signal } : {}),
		lspBudgetMs: REVERIFY_BUDGET_MS,
		dbg: () => {},
	};

	// R3-4: every candidate the budget or the abort cut, so the phase row
	// distinguishes "the pass ran out of time" from "the server answered
	// nothing". Counted from what the loop actually reached, never predicted.
	let processed = 0;
	for (const entry of candidates) {
		if (args.signal?.aborted || Date.now() >= deadlineAt) break;
		processed += 1;
		let content: string;
		try {
			content = fs.readFileSync(entry.filePath, "utf-8");
		} catch {
			outcomes.push({
				filePath: entry.filePath,
				displayPath: entry.displayPath,
				outcome: "unconfirmed",
				dropped: 0,
				kept: entry.warnings.length,
			});
			replacementFiles.push({ ...entry, reVerifyIncomplete: true });
			continue;
		}
		// F4: the touch is bound-wrapped — `maxClientWaitMs` bounds the
		// spawn/ready window, `bounded()` is the request ceiling.
		let touchedResult: TouchFileResult | undefined;
		try {
			touchedResult = await bounded(
				args.lspService.touchFile(entry.filePath, content, {
					diagnostics: "document",
					collectDiagnostics: true,
					source: TOUCH_SOURCE,
					clientScope: "primary",
				}),
				{
					ms: Math.max(250, deadlineAt - Date.now()),
					signal: args.signal,
					hook: "turn_end",
					label: "persistent_reverify_touch",
				},
			);
		} catch {
			// The never-throws contract: a wedged touch degrades to unconfirmed
			// (kept verbatim, labeled), never an escaped error.
			touchedResult = undefined;
		}
		// F3 (#3176): an empty result is clean ONLY when the touch COMPLETED
		// its confirmation policy — the silent-on-clean rule (#240/#533/#1253).
		// A bare `{diags: []}` (the house double's silent empty, a tier-3
		// server still analyzing) or a `skipReason` is UNCONFIRMED: the carried
		// warnings are kept verbatim and the render labels the gap.
		// `touched.inconclusive` is resolveTouchVerdict's output, computed
		// service-side, and is honored directly.
		// R3-3: read the policy through `touchCompletedConfirmationPolicy`, the
		// #1470 seam, NOT the literal `confirmation !== "confirmed"` that
		// `diagnostic-binding.ts:274-288` exists to forbid: `partial` means
		// every server except the named cut-off auxiliaries answered, so the
		// primary's silent-clean gates ran to completion and its observation is
		// as trustworthy as a full confirmation. The literal labels a file the
		// primary fully answered and keeps a finding the touch just re-derived.
		if (
			touchedResult === undefined ||
			touchedResult.inconclusive === true ||
			touchedResult.skipReason !== undefined ||
			(touchedResult.diagnosticsUnsupportedServerIds ?? []).length > 0 ||
			!touchCompletedConfirmationPolicy(touchedResult)
		) {
			outcomes.push({
				filePath: entry.filePath,
				displayPath: entry.displayPath,
				outcome: "unconfirmed",
				dropped: 0,
				kept: entry.warnings.length,
			});
			replacementFiles.push({ ...entry, reVerifyIncomplete: true });
			continue;
		}
		touched += 1;
		// F2: the touch's collected diagnostics feed the producer's pipeline
		// as the cached arm — no second pull, the producer's filters and
		// caps are reused verbatim.
		// F4: the outer await is bound-wrapped too — the module carries ZERO
		// syntactic unbounded awaits (#2523 slice-3 worklist), and the hard
		// ceiling composes with enrichFileFromLsp's own internal deadline.
		const freshRecords =
			(await bounded(
				enrichFileFromLsp(
					args.cwd,
					buildArgs,
					{ filePath: entry.filePath, cached: touchedResult.diags },
					{
						lspService: args.lspService,
						pullTimeoutMs: 2000,
						deadlineAt,
						...(args.signal !== undefined ? { signal: args.signal } : {}),
						site: { hook: "turn_end", label: "persistent_reverify" },
					},
				),
				{
					ms: Math.max(250, deadlineAt - Date.now()),
					signal: args.signal,
					hook: "turn_end",
					label: "persistent_reverify_enrich",
				},
			)) ?? [];
		let dropped = 0;
		let kept = 0;
		for (const warning of entry.warnings) {
			const stillThere = freshRecords.some(
				(record) =>
					record.rule === warning.rule && record.message === warning.message,
			);
			if (stillThere) kept += 1;
			else dropped += 1;
		}
		const outcome: PersistentReverifyOutcome["outcome"] =
			freshRecords.length === 0
				? "clean"
				: dropped === 0
					? "reconfirmed"
					: "mixed";
		outcomes.push({
			filePath: entry.filePath,
			displayPath: entry.displayPath,
			outcome,
			dropped,
			kept,
		});
		const {
			reVerifyIncomplete: _reVerifyIncomplete,
			...entryWithoutIncomplete
		} = entry;
		replacementFiles.push({
			...entryWithoutIncomplete,
			warnings: freshRecords,
			reVerified: true,
			generatedAt: new Date(nowMs).toISOString(),
		});
	}

	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: args.cwd,
		phase: "persistent_reverify",
		durationMs: Date.now() - started,
		metadata: {
			candidates: candidates.length,
			touched,
			clean: outcomes.filter((o) => o.outcome === "clean").length,
			reconfirmed: outcomes.filter((o) => o.outcome === "reconfirmed").length,
			mixed: outcomes.filter((o) => o.outcome === "mixed").length,
			unconfirmed: outcomes.filter((o) => o.outcome === "unconfirmed").length,
			skippedChanged,
			skippedBudget: candidates.length - processed,
		},
	});

	return {
		outcomes,
		replacementFiles,
		candidates: candidates.length,
		touched,
		skippedChanged,
	};
}
