import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CacheManager, ModifiedRange } from "./cache-manager.js";
import type { Diagnostic } from "./dispatch/types.js";
import {
	hashText,
	normalizeMessage,
	stableFindingId,
} from "./finding-identity.js";
import type { LSPCodeAction, LSPDiagnostic } from "./lsp/client.js";
import { applyWorkspaceEdit } from "./lsp/edits.js";
import { getLSPService } from "./lsp/index.js";
import { isUnderDir, normalizeMapKey } from "./path-utils.js";
import {
	bounded,
	combineAbortSignals,
	withDeadline,
} from "./deadline-utils.js";
import type { LedgerHookKey } from "./hook-budgets.js";
import {
	armDeferredLspWork,
	awaitDeferredLspWork,
	registerDeferredLspWork,
} from "./deferred-lsp-work.js";
import {
	incrementDegradationCount,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import {
	recordLspMutationBatch,
	type LspMutationContext,
} from "./lsp-mutation.js";
import { toRunnerDisplayPath } from "./dispatch/runner-context.js";
import { logActionableWarningsEvent } from "./actionable-warnings-logger.js";
import { displayProjectDataPath, getProjectDataDir } from "./file-utils.js";
import { commitDurableStore } from "./durable-store.js";
import { resolveLensToolName, type LensToolHost } from "./tool-config.js";

export interface ActionableWarningAction {
	title: string;
	kind?: string;
	isPreferred?: boolean;
	hasEdit: boolean;
	hasCommand: boolean;
	autoFixEligible: boolean;
	skipReason?: string;
}

export interface ActionableWarningRecord {
	id: string;
	filePath: string;
	displayPath: string;
	line?: number;
	column?: number;
	severity: "warning" | "error" | "info" | "hint";
	tool: string;
	source?: string;
	code?: string;
	rule?: string;
	message: string;
	fixSuggestion?: string;
	fixKind?: string;
	autoFixAvailable?: boolean;
	actions: ActionableWarningAction[];
	suppressed: boolean;
	suppressionReason?: string;
	/** #1816 migration-only, internal to `actionable-warnings.ts`'s own
	 * suppression-store bookkeeping — not for display. The id this warning
	 * would have hashed to under the pre-#1816 formula (raw `relativeFile`,
	 * 10-char hash), computed ONCE by `suppressionFor` at record-construction
	 * time and carried here (AGENTS.md shape 5: an enumerable field survives
	 * `mergeWarnings`' spread copies; a WeakMap keyed on object identity would
	 * not, since merging allocates new record objects). `updateWarningState`
	 * reads this field directly and never re-derives a legacy id from
	 * `rule`/`tool`/`source`/`code` — those diverge from the id-construction
	 * args for LSP-origin records (`recordFromLspDiagnostic` passes no `rule`
	 * into `createActionableWarningId`, then sets `rule` afterward to
	 * `${source}:${code}` for display), so re-deriving would silently compute
	 * the wrong legacy id and bifurcate the store. Optional only because a
	 * handful of test/consumer sites construct a synthetic
	 * `ActionableWarningRecord` outside this module's own constructors and
	 * have no real pre-#1816 id to carry; `writeActionableWarningsReport`'s
	 * caller strips this field before persisting the report. */
	legacyId?: string;
	origin: "dispatch" | "lsp" | "merged";
}

/**
 * One file's entry in an actionable-warnings report.
 *
 * Lifted out of {@link ActionableWarningsReport} in #2504 review round 4 (F1),
 * where a report stopped being the product of exactly one pass: a deferred
 * off-hook LSP pull now UPSERTS its per-file entries into whatever report is
 * persisted when it lands, so one report can carry entries assembled minutes
 * apart. Everything that orders or ages an entry therefore has to live HERE,
 * on the entry, not only on the report.
 */
export interface ActionableWarningsReportFile {
	filePath: string;
	displayPath: string;
	/**
	 * The runtime's per-file mutation sequence when this entry was built. The
	 * merge in {@link mergeDeferredActionableWarningsReport} drops a deferred
	 * entry whose file has moved past this, and
	 * {@link checkActionableWarningsReportFresh} re-checks it per file before
	 * the autofix pass touches anything.
	 */
	fileSeq?: number;
	/**
	 * When THIS entry was assembled (#2504 review round 4, F1). The
	 * lens_diagnostics mtime freshness gate reads it in preference to the
	 * report-level generatedAt, so a merged report never judges its older half
	 * against the newer stamp and passes an out-of-band edit off as live.
	 * Optional: a cache file written by a build that predates the field carries
	 * only the report-level stamp, and every reader must tolerate that.
	 */
	generatedAt?: string;
	/**
	 * Set only on an entry a DEFERRED publish contributed to (#2504 review
	 * round 5, F1). Distinct from {@link ActionableWarningRecord.origin}, which
	 * says which analyzer found a warning; this says which PUBLISH produced the
	 * entry, and it exists for exactly one reason: it is the scope guard on
	 * carry-forward.
	 *
	 * The in-band publisher merges into what is persisted so that a deferred
	 * report landing mid-turn is not erased. Without a marker that merge would
	 * carry EVERY prior turn's entries into every later turn's `turn_delta`
	 * report, which accumulates without bound and re-serves findings the agent
	 * has already seen. So the in-band publisher carries forward only entries a
	 * deferral produced, and CLEARS the marker as it does: a deferred finding
	 * survives exactly one subsequent in-band publish -- the one that would
	 * otherwise have erased it -- and is then the report's own business.
	 */
	origin?: "deferred";
	warnings: ActionableWarningRecord[];
}

export interface ActionableWarningsReport {
	generatedAt: string;
	scope: "turn_delta";
	sessionId: string;
	turnIndex: number;
	projectSeqStart?: number;
	projectSeqEnd?: number;
	deltaOnly: boolean;
	includeLspCodeActions: boolean;
	files: ActionableWarningsReportFile[];
	summary: {
		warnings: number;
		unsuppressed: number;
		suppressed: number;
		files: number;
		actions: number;
		autoFixEligible: number;
		/**
		 * Unsuppressed warnings split by tier (#1777). The dispatch path now
		 * preserves a rule's declared severity, so a hint-tier style opinion is
		 * countable instead of arriving indistinguishable from a real warning.
		 *
		 * OPTIONAL on purpose: this report is persisted to
		 * `<project-data-dir>/cache/actionable-warnings.json` and read back by
		 * `clients/runtime-agent-end.ts` and `tools/lens-diagnostics.ts`, which
		 * can find a file written by a pi-lens build that predates the field.
		 * Every reader must tolerate its absence.
		 *
		 * No `error` tier here (#1799): `recordFromDispatchDiagnostic` (above)
		 * routes `severity === "error"` to the blocking path and never admits it
		 * into `warnings`, so an error-tier count is always 0 and never rendered.
		 * A reader built against an old cache file that still carries `error` is
		 * unaffected — the field is simply absent from the parsed object now,
		 * and nothing here reads it.
		 */
		byTier?: { warning: number; info: number; hint: number };
	};
}

interface WarningSuppressionEntry {
	status?: "suppressed" | "active" | "resolved";
	reason?: string;
	firstSeenAt?: string;
	lastSeenAt?: string;
	resolvedAt?: string;
	seenCount?: number;
}

interface WarningStateFile {
	warnings?: Record<string, WarningSuppressionEntry>;
}

let beforeWarningStateLockForTests: (() => void) | null = null;

/** Test seam for a sibling process commit immediately before lock acquisition. */
export function _setBeforeWarningStateLockForTests(
	hook: (() => void) | null,
): void {
	beforeWarningStateLockForTests = hook;
}

/** #1816: was a local `relativeFile|tool|source|code|rule|normalizedMessage|
 * line` hash, hand-rolled independently of `diagnostic-dispositions.ts`'s
 * canonicalizing version — this is now the shared `finding-identity.js`
 * builder (which DOES canonicalize both `cwd` and `filePath` through
 * `normalizeMapKey` before relativizing, and hashes to 12 chars, matching
 * dispositions). See `legacyActionableWarningId` below for the pre-#1816
 * formula, kept only for on-disk suppression-store migration. */
export function createActionableWarningId(args: {
	cwd: string;
	filePath: string;
	tool?: string;
	source?: string;
	code?: string | number;
	rule?: string;
	message: string;
	line?: number;
}): string {
	return stableFindingId("aw:", {
		cwd: args.cwd,
		filePath: args.filePath,
		parts: [
			args.tool,
			args.source,
			args.code,
			args.rule,
			normalizeMessage(args.message),
			args.line,
		],
	});
}

/** PRE-#1816 id formula (raw, non-canonicalized `relativeFile`; 10-char
 * hash). `actionable-warning-state.json` is a keyed, persisted store — a
 * warning suppressed under the old formula must not silently reappear as
 * unsuppressed just because this module unified onto the canonical,
 * 12-char id. `suppressionFor`/`updateWarningState` use this ONLY to look up
 * and migrate a still-pending old entry forward; nothing ever WRITES under
 * this id. Do not canonicalize this function — that would make it identical
 * to `createActionableWarningId` and silently defeat the migration lookup
 * for every path that actually needed canonicalizing (the #533 class this
 * whole item exists to fix). Review-round F3 (#1816): this guard is only
 * provable under a MIS-CASED path fixture — a fixture whose raw and
 * canonical forms coincide (a bare mkdtempSync path) makes canonicalizing
 * this function a no-op, so the regression test must seed under a mis-cased
 * segment (see `actionable-warnings.test.ts`'s migration describe block) or
 * the guard passes vacuously either way. */
function legacyActionableWarningId(args: {
	cwd: string;
	filePath: string;
	tool?: string;
	source?: string;
	code?: string | number;
	rule?: string;
	message: string;
	line?: number;
}): string {
	const rel = path.relative(args.cwd, args.filePath).replace(/\\/g, "/");
	const legacyRelativeFile =
		rel && !rel.startsWith("..") ? rel : normalizeMapKey(args.filePath);
	const parts = [
		legacyRelativeFile,
		args.tool ?? "",
		args.source ?? "",
		String(args.code ?? ""),
		args.rule ?? "",
		normalizeMessage(args.message),
		String(args.line ?? ""),
	];
	return `aw:${hashText(parts.join("|"), 10)}`;
}

function actionSafety(action: LSPCodeAction): {
	eligible: boolean;
	reason?: string;
} {
	const kind = action.kind ?? "";
	if (!kind.startsWith("quickfix"))
		return { eligible: false, reason: "not_quickfix" };
	if (!action.isPreferred) return { eligible: false, reason: "not_preferred" };
	if (!action.edit) return { eligible: false, reason: "no_edit" };
	if (action.command) return { eligible: false, reason: "has_command" };
	return { eligible: true };
}

function serializeAction(action: LSPCodeAction): ActionableWarningAction {
	const safety = actionSafety(action);
	return {
		title: action.title,
		kind: action.kind,
		isPreferred: action.isPreferred,
		hasEdit: Boolean(action.edit),
		hasCommand: Boolean(action.command),
		autoFixEligible: safety.eligible,
		skipReason: safety.reason,
	};
}

function deserializeSuppressionState(
	contents: string | undefined,
): WarningStateFile {
	try {
		const parsed = JSON.parse(contents ?? "") as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as WarningStateFile)
			: {};
	} catch {
		return {};
	}
}

function readSuppressionState(cwd: string): WarningStateFile {
	const statePath = path.join(
		getProjectDataDir(cwd),
		"cache",
		"actionable-warning-state.json",
	);
	try {
		return deserializeSuppressionState(fs.readFileSync(statePath, "utf8"));
	} catch {
		return {};
	}
}

function updateWarningState(
	cwd: string,
	warnings: ActionableWarningRecord[],
): void {
	const statePath = path.join(
		getProjectDataDir(cwd),
		"cache",
		"actionable-warning-state.json",
	);
	fs.mkdirSync(path.dirname(statePath), { recursive: true });
	const hook = beforeWarningStateLockForTests;
	beforeWarningStateLockForTests = null;
	hook?.();
	commitDurableStore({
		path: statePath,
		deserialize: deserializeSuppressionState,
		merge: (state) => {
			const now = new Date().toISOString();
			state.warnings ??= {};
			for (const warning of warnings) {
				// #1816 migration: this warning may still be recorded under the
				// pre-#1816 id (raw relativeFile, 10-char hash) from before this
				// store unified onto the canonical id. Fold that entry forward
				// onto the current id and drop the stale key, so a warning
				// suppressed before the migration stays suppressed, and repeated
				// re-encounters converge the store onto one id per warning
				// instead of accumulating both forever.
				//
				// Review-round F1: this MUST read `warning.legacyId` — the value
				// `suppressionFor` already computed from the exact identity args
				// used at lookup time — and must NEVER re-derive a legacy id from
				// `warning.rule`/`tool`/`source`/`code`. Those fields hold
				// DISPLAY values that diverge from the id-construction args for
				// LSP-origin records (see `ActionableWarningRecord.legacyId`'s
				// doc comment), so a re-derivation here would compute a
				// different legacy id than the one `suppressionFor` checked,
				// permanently bifurcating the store.
				const legacyId = warning.legacyId;
				const legacyEntry =
					legacyId && legacyId !== warning.id
						? state.warnings[legacyId]
						: undefined;
				const existing = state.warnings[warning.id] ?? legacyEntry ?? {};
				state.warnings[warning.id] = {
					...existing,
					status: existing.status ?? "active",
					firstSeenAt: existing.firstSeenAt ?? now,
					lastSeenAt: now,
					seenCount: (existing.seenCount ?? 0) + 1,
				};
				if (legacyEntry && legacyId) delete state.warnings[legacyId];
			}
			return state;
		},
		serialize: (state) => JSON.stringify(state, null, 2),
		waitMs: 2_000,
		retryMs: 10,
		timeoutMessage: "timed out acquiring actionable warning store lock",
		onContention: "skip-log",
		logContention: () =>
			logActionableWarningsEvent({
				event: "warning_state_write_dropped",
				metadata: { reason: "lock_contention" },
			}),
	});
}

/** Looks up suppression under the current id, falling back to the pre-#1816
 * id (see `legacyActionableWarningId`) so a warning suppressed before this
 * migration doesn't silently reappear as unsuppressed. `args` is the exact
 * identity shape both id builders take.
 *
 * Also RETURNS the `legacyId` it computed (review-round F1, #1816): the
 * caller carries it onto the record's `legacyId` field so
 * `updateWarningState` can migrate the SAME legacy id this lookup used,
 * instead of re-deriving one from the record's own `rule`/`tool`/`source`/
 * `code` fields later. Re-deriving is unsound for LSP-origin records —
 * `recordFromLspDiagnostic` passes no `rule` into this function (LSP
 * diagnostics don't have one), then sets `record.rule` afterward to
 * `${source}:${code}` purely for display. Recomputing from that display
 * value would silently compute a DIFFERENT legacy id than the one actually
 * checked here, permanently bifurcating the store: a suppression written
 * this turn under the current id would never be found again next turn. */
function suppressionFor(
	cwd: string,
	id: string,
	args: {
		filePath: string;
		tool?: string;
		source?: string;
		code?: string | number;
		rule?: string;
		message: string;
		line?: number;
	},
): { suppressed: boolean; reason?: string; legacyId: string } {
	const state = readSuppressionState(cwd);
	const legacyId = legacyActionableWarningId({ cwd, ...args });
	const entry =
		state.warnings?.[id] ??
		(legacyId !== id ? state.warnings?.[legacyId] : undefined);
	return {
		suppressed: entry?.status === "suppressed",
		reason: entry?.reason,
		legacyId,
	};
}

export function recordFromDispatchDiagnostic(
	diagnostic: Diagnostic,
	cwd: string,
): ActionableWarningRecord | undefined {
	if (diagnostic.semantic !== "warning") return undefined;
	// #1777: the old gate demanded `severity === "warning"` exactly, which was
	// invisible while the ast-grep runner collapsed every non-error tier to
	// "warning". Now that hint and info survive the dispatch path, admit them:
	// a fix is a fix, and the tier governs how loudly a finding renders, not
	// whether its fix is worth offering. `error` still routes to the blocking
	// path, so it stays out even when a runner leaves `semantic` at "warning".
	if (diagnostic.severity === "error") return undefined;
	if (!diagnostic.fixable && !diagnostic.fixSuggestion) return undefined;
	const filePath = path.resolve(cwd, diagnostic.filePath);
	const identityArgs = {
		filePath,
		tool: diagnostic.tool,
		code: diagnostic.code,
		rule: diagnostic.rule,
		message: diagnostic.message,
		line: diagnostic.line,
	};
	const id = createActionableWarningId({ cwd, ...identityArgs });
	const suppression = suppressionFor(cwd, id, identityArgs);
	return {
		id,
		filePath,
		displayPath: toRunnerDisplayPath(cwd, filePath),
		line: diagnostic.line,
		column: diagnostic.column,
		severity: diagnostic.severity,
		tool: diagnostic.tool,
		code: diagnostic.code,
		rule: diagnostic.rule,
		message: diagnostic.message,
		fixSuggestion: diagnostic.fixSuggestion,
		fixKind: diagnostic.fixKind,
		autoFixAvailable: diagnostic.autoFixAvailable,
		actions: [],
		suppressed: suppression.suppressed,
		suppressionReason: suppression.reason,
		legacyId: suppression.legacyId,
		origin: "dispatch",
	};
}

function lineInModifiedRanges(
	line: number | undefined,
	ranges: ModifiedRange[],
): boolean {
	if (line === undefined) return true;
	if (ranges.length === 0) return true;
	return ranges.some(
		(range) => line >= range.start - 2 && line <= range.end + 2,
	);
}

function recordFromLspDiagnostic(
	diag: LSPDiagnostic,
	filePath: string,
	cwd: string,
): ActionableWarningRecord {
	const line = diag.range.start.line + 1;
	const column = diag.range.start.character + 1;
	const source = diag.source ?? "lsp";
	const code = diag.code === undefined ? undefined : String(diag.code);
	const identityArgs = {
		filePath,
		tool: "lsp",
		source,
		code,
		message: diag.message,
		line,
	};
	const id = createActionableWarningId({ cwd, ...identityArgs });
	const suppression = suppressionFor(cwd, id, identityArgs);
	return {
		id,
		filePath,
		displayPath: toRunnerDisplayPath(cwd, filePath),
		line,
		column,
		severity: "warning",
		tool: "lsp",
		source,
		code,
		rule: code ? `${source}:${code}` : source,
		message: diag.message,
		actions: [],
		suppressed: suppression.suppressed,
		suppressionReason: suppression.reason,
		legacyId: suppression.legacyId,
		origin: "lsp",
	};
}

function mergeWarnings(
	records: ActionableWarningRecord[],
): ActionableWarningRecord[] {
	const byId = new Map<string, ActionableWarningRecord>();
	for (const record of records) {
		const existing = byId.get(record.id);
		if (!existing) {
			byId.set(record.id, { ...record, actions: [...record.actions] });
			continue;
		}
		existing.origin =
			existing.origin === record.origin ? existing.origin : "merged";
		existing.fixSuggestion ??= record.fixSuggestion;
		existing.fixKind ??= record.fixKind;
		existing.autoFixAvailable ||= record.autoFixAvailable;
		const seenActions = new Set(
			existing.actions.map((a) => `${a.kind ?? ""}|${a.title}`),
		);
		for (const action of record.actions) {
			const key = `${action.kind ?? ""}|${action.title}`;
			if (!seenActions.has(key)) {
				existing.actions.push(action);
				seenActions.add(key);
			}
		}
	}
	return [...byId.values()].sort(
		(a, b) =>
			a.displayPath.localeCompare(b.displayPath) ||
			(a.line ?? 0) - (b.line ?? 0),
	);
}

/**
 * #2504 — bounds on the LSP enrichment loop.
 *
 * This function runs on the AWAITED turn_end hook. With `includeLspCodeActions`
 * on and a cold LSP cache it opened every file it was handed and pulled fresh
 * per-file diagnostics serially at ~880 ms each: 147 files, 187 891 ms, for
 * `warnings: 0`. Three bounds, plus a project-root filter (it had opened
 * `~/.claude/plans/*.md` in an LSP client), plus a deferral: when the turn
 * primed NO cache, every file would be a fresh pull, so the whole loop moves
 * off the hook and delivers through the cached channel instead.
 */
export const ACTIONABLE_WARNINGS_LSP_FILE_CAP = 25;
export const ACTIONABLE_WARNINGS_LSP_BUDGET_MS = 2_500;
export const ACTIONABLE_WARNINGS_DEFERRED_BUDGET_MS = 60_000;
/**
 * #2504 review round 2 (F3): the per-round-trip bound. The batch deadlines
 * above are checked only BETWEEN files, so a single wedged `getDiagnostics`
 * (or `openFile`, or `codeAction`) was unbounded no matter how small the
 * batch budget was. Generous relative to the ~880 ms a real cold pull costs —
 * this is a wedge detector, not a latency target.
 */
export const ACTIONABLE_WARNINGS_LSP_PULL_TIMEOUT_MS = 10_000;

/**
 * #2504 review round 3 (S-2): the third bound, per FILE.
 *
 * The wall budgets above are re-checked BETWEEN files only — deliberately, so
 * that a file already opened is finished rather than half-enriched — and the
 * per-round-trip timeout bounds one call. Neither bounds the COUNT of calls
 * one file can demand: a generated or vendored file with hundreds of warnings
 * on modified lines costs one `codeAction` round trip each, all inside a
 * single between-files interval. This caps that fan-out. The abort signal
 * still escapes promptly — `boundedLspCall` checks it on every trip.
 */
export const ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE = 25;

export interface BuildActionableWarningsArgs {
	cwd: string;
	sessionId: string;
	turnIndex: number;
	files: string[];
	modifiedRangesByFile: Map<string, ModifiedRange[]>;
	dispatchWarnings: ActionableWarningRecord[];
	includeLspCodeActions: boolean;
	projectSeqStart?: number;
	projectSeqEnd?: number;
	fileSeqByPath?: Map<string, number>;
	deltaOnly?: boolean;
	dbg?: (msg: string) => void;
	/** #2504: max files the LSP enrichment loop may touch in one turn. */
	lspFileCap?: number;
	/** #2504: total wall budget for the in-band LSP enrichment loop. */
	lspBudgetMs?: number;
	/** #2504: turn abort signal, raced against the wall budgets. */
	signal?: AbortSignal;
	/** #2504 review round 2 (F3): per-LSP-round-trip timeout. */
	lspPullTimeoutMs?: number;
	/**
	 * #2504: receives the completed report when the cold fresh-pull loop was
	 * moved off the awaited hook. The caller writes it to the same
	 * `actionable-warnings` cache the in-band report goes to.
	 */
	onDeferredReport?: (report: ActionableWarningsReport) => void;
}

/** One file's LSP enrichment plan, resolved before any fresh pull happens. */
interface LspEnrichmentTarget {
	filePath: string;
	content?: string;
	cached?: LSPDiagnostic[];
}

/**
 * The in-flight deferred fresh-pull, if any. Exposed for tests only: the
 * deferral is fire-and-forget by design, and a test asserting that the work
 * still happens off-hook needs a handle to await.
 *
 * #2504 review round 2 (F3): the handle no longer lives here as a bare
 * module-level `let` that a second deferral silently overwrote (leaving the
 * first loop running, untracked and unstoppable) and that nothing ever reset.
 * `clients/deferred-lsp-work.ts` owns the single slot and its abort signal.
 */
export function _awaitDeferredLspPullForTest(): Promise<void> {
	return awaitDeferredLspWork();
}

/** Everything one enrichment round trip needs to stay bounded (#2504 r2 F3). */
interface LspEnrichmentDeps {
	/**
	 * Resolved ONCE per loop, not per file. Re-resolving through
	 * `getLSPService()` inside the deferred loop let it hand itself a brand
	 * new service — and therefore re-spawn servers — after the idle reset or a
	 * session boundary had deliberately retired the one it started with.
	 */
	lspService: ReturnType<typeof getLSPService>;
	/** Per-round-trip timeout; the bound a between-files deadline cannot give. */
	pullTimeoutMs: number;
	/**
	 * The LOOP's wall deadline, as an absolute epoch ms (#2504 review round 4,
	 * F2). Round 3 re-checked the wall budget BETWEEN files only, so ONE file
	 * could still spend an openFile, a getDiagnostics and up to
	 * ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE codeAction round trips --
	 * 27 x the 10 s per-round-trip timeout -- on the AWAITED turn_end hook
	 * after the batch budget was already gone (measured: a 1 ms budget still
	 * cost 1012 ms). Threading the deadline here lets boundedLspCall cap every
	 * trip at whatever is LEFT of the budget, and lets the per-diagnostic loop
	 * stop between trips. Mutable: the deferred loop's deadline starts when the
	 * loop does, one macrotask after these deps are built.
	 */
	deadlineAt?: number;
	/**
	 * The loop's live abort signal — the SECOND bound every round trip races.
	 *
	 * Optional only because the in-band caller may have none; `bounded()` reads
	 * a missing signal as one that never aborts, so the deadline is still live.
	 * There is no longer a separate pre-built abort leg to forget to supply.
	 */
	signal?: AbortSignal;
	/**
	 * WHICH loop these deps belong to, on the degradation ledger's two axes
	 * (#2557 review F3).
	 *
	 * `boundedLspCall` used to hard-code `hook: "turn_end"` / `label:
	 * "lspEnrichmentRoundTrip"`, and it is reached from BOTH the in-band loop
	 * (genuinely awaited on `turn_end`) and the deferred loop (deliberately
	 * moved off the hook, running a macrotask later with its own budget and its
	 * own signal). One subject for two loops was wrong in both directions:
	 * `recordDegradationOnce` is rising-edge, so whichever loop blew its budget
	 * first SILENCED the other for the rest of the session, and any deferred
	 * exceedance that did land was charged to `turn_end` — making the hook look
	 * over budget precisely because it had correctly deferred the work.
	 *
	 * Carried on the deps object, like `deadlineAt` / `pullTimeoutMs` /
	 * `signal`, because that object is already the one thing that differs
	 * between the two loops.
	 */
	site: { hook: LedgerHookKey; label: string };
}

/**
 * Both bounds on ONE LSP round trip (#2504 review round 2, F3), as AGENTS.md
 * requires of any async step in a sweep loop: a per-call timeout AND the abort
 * signal. Resolves `undefined` when either bound wins; the caller reads that
 * as "this file was not checked", never as "this file is clean".
 *
 * #2523 slice 2 folded this onto `bounded()`. It used to be `withDeadline`
 * (deadline only) raced against a hand-built `abortRace` leg carried on the
 * deps — the fifth private spelling of "deadline AND signal".
 *
 * What the fold did NOT fix, stated because the first draft of this PR claimed
 * it did (#2557 review F5): the old shape did not silently degrade any wait.
 * Both construction sites derived the leg from the signal in the same
 * expression (`args.signal ? makeAbortRace(args.signal) : undefined`), so
 * `abortRace` was absent exactly when `signal` was, and the behaviour before
 * and after this fold is identical on that axis. What the fold actually buys
 * is that the two fields which had to AGREE are now one — a pairing invariant
 * that lived in prose is gone rather than enforced — plus the abandonment now
 * reaching the ledger, and the leg's listener now being released per call
 * instead of living as long as the loop's signal does.
 *
 * ## The loop's residual budget is a THIRD bound, and it must not reach the
 * ledger (#2557 review F-A)
 *
 * Round 1 clamped `bounded()`'s own timer to
 * `Math.min(pullTimeoutMs, remainingMs)`, so whenever the LOOP's own wall
 * budget was already low, `bounded()` armed at the shrunken value and — on
 * firing — recorded `hook-await-exceeded` naming THAT value as "the budget".
 * A healthy pull that simply started late in a big batch was reported as
 * exceeding a budget that exists in no configuration (measured: 400 ms
 * pulls, 12 files, "exceeded 65ms budget after 77ms"), and because
 * `recordDegradationOnce` is rising-edge, that benign row could silence a
 * genuinely wedged server later in the same session.
 *
 * `bounded()`'s OWN timer is now always armed at the full `pullTimeoutMs`, so
 * it only ever fires — and only ever records — when a call outlives its own
 * configured per-trip budget (`metadata.budgetMs === pullTimeoutMs`, always).
 * The loop's shrinking residual is enforced SEPARATELY, by racing `bounded()`
 * against `withDeadline(…, { onTimeout: "undefined" })` keyed to the loop's
 * own `deadlineAt` — a deadline-only wait with no ledger connection of its
 * own, the same primitive `bounded()` itself is built to replace when a
 * caller needs BOTH bounds. The still-running `bounded()` call is not
 * cancelled (nothing here can cancel already-started work); if it later
 * genuinely outlives `pullTimeoutMs`, it still records, correctly, on its own
 * clock.
 */
async function boundedLspCall<T>(
	call: () => Promise<T>,
	deps: LspEnrichmentDeps,
): Promise<T | undefined> {
	if (deps.signal?.aborted) return undefined;
	// #2504 review round 4 (F2): the loop's wall budget bounds THIS trip too. A
	// round trip that starts with 5 ms of budget left may not run for 10 s just
	// because the per-call timeout says so -- that is how one file held the
	// awaited hook for minutes past a spent batch budget.
	const remainingMs =
		deps.deadlineAt !== undefined ? deps.deadlineAt - Date.now() : undefined;
	// Returned BEFORE `bounded()` rather than handed to it as a zero budget: a
	// trip that never started did not exceed anything, and recording it as an
	// exceedance would attribute the loop's spent budget to whichever call
	// happened to be next.
	if (remainingMs !== undefined && remainingMs <= 0) return undefined;
	const inner = bounded(
		call().then((value) => ({ value })),
		{
			// Always the FULL per-trip budget -- never clamped to the loop's own
			// residual. The residual is enforced below, off the ledger.
			ms: deps.pullTimeoutMs,
			// Optional for the in-band caller; `bounded()` reads a missing signal
			// as one that never aborts, so the deadline half stays live.
			signal: deps.signal,
			// From the deps, never a literal: the in-band and deferred loops must
			// key separately (#2557 review F3).
			hook: deps.site.hook,
			label: deps.site.label,
		},
	);
	const boxed =
		deps.deadlineAt !== undefined
			? await withDeadline(inner, {
					deadlineAt: deps.deadlineAt,
					onTimeout: "undefined",
				})
			: await inner;
	// Boxed because an LSP pull legitimately resolves `undefined` (no
	// diagnostics for this file), which must stay distinguishable from a bound
	// firing even though both currently mean "not checked" to the caller.
	return boxed?.value;
}

/** Positive finite bound, else the default. Guards NaN from env/config. */
function boundedNumber(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

export async function buildActionableWarningsReport(
	args: BuildActionableWarningsArgs,
): Promise<ActionableWarningsReport> {
	const cwd = path.resolve(args.cwd);
	const records: ActionableWarningRecord[] = [...args.dispatchWarnings];
	const lspService = getLSPService();
	// #2504 review round 5 (F2): when each file's LSP observation FINISHED,
	// keyed by normalized path. assembleReport used to stamp every entry with
	// one `new Date()` taken at ASSEMBLY -- which for the deferred loop is the
	// loop's END, so a file read 60 s and 24 files ago claimed to be
	// milliseconds old. applyDeltaFreshnessGate compares that stamp against the
	// file's mtime to catch an out-of-band edit made after the observation, and
	// a stamp that late hands it a window which has already closed. Shared with
	// the deferred closure below, so the in-band entries it carries over keep
	// the stamps their own pass gave them.
	const observedAtByPath = new Map<string, string>();
	// The conservative stand-in for an entry no LSP pull ever touched (a
	// dispatch-origin warning): the moment this build began. Never LATER than
	// the observation it stands in for, which is the direction that matters --
	// an over-old stamp costs a line number, an over-new one leaks a stale one.
	const buildStartedAt = new Date().toISOString();

	logActionableWarningsEvent({
		event: "report_started",
		sessionId: args.sessionId,
		metadata: {
			turnIndex: args.turnIndex,
			filesCount: args.files.length,
			dispatchWarningsCount: args.dispatchWarnings.length,
			deltaOnly: args.deltaOnly !== false,
			includeLspCodeActions: args.includeLspCodeActions,
		},
	});

	if (args.includeLspCodeActions) {
		const fileCap = Math.floor(
			boundedNumber(args.lspFileCap, ACTIONABLE_WARNINGS_LSP_FILE_CAP),
		);
		const budgetMs = boundedNumber(
			args.lspBudgetMs,
			ACTIONABLE_WARNINGS_LSP_BUDGET_MS,
		);

		// #2504 (1) project-root filter. The worklist this loop is handed had
		// accumulated paths from two other agents' scratchpads, `~/.claude/plans`
		// and `~/.plegma/work` — none of which belong to an LSP client rooted at
		// this project. Rejected before any file read.
		const eligible: string[] = [];
		let outsideRoot = 0;
		for (const file of args.files) {
			const filePath = path.resolve(cwd, file);
			if (
				normalizeMapKey(filePath) === normalizeMapKey(cwd) ||
				!isUnderDir(filePath, cwd)
			) {
				outsideRoot++;
				logActionableWarningsEvent({
					event: "lsp_file_skipped",
					sessionId: args.sessionId,
					filePath,
					metadata: { reason: "outside_project_root" },
				});
				continue;
			}
			if (!lspService.supportsLSP(filePath)) {
				logActionableWarningsEvent({
					event: "lsp_file_skipped",
					sessionId: args.sessionId,
					filePath,
					metadata: { reason: "no_lsp_support" },
				});
				continue;
			}
			eligible.push(filePath);
		}
		if (outsideRoot > 0) {
			args.dbg?.(
				`actionable_warnings: skipped ${outsideRoot} file(s) outside the project root`,
			);
		}

		// #2504 (2) file cap.
		const capped = eligible.slice(0, fileCap);
		if (capped.length < eligible.length) {
			recordDegradationOnce({
				kind: "actionable-warnings-cap",
				subject: `${cwd}:file-cap`,
				reason: `LSP enrichment capped at ${fileCap} file(s); ${eligible.length - capped.length} modified file(s) were not checked for code actions this turn`,
			});
		}

		// Resolve every file's cache state BEFORE doing any LSP work. This is a
		// read + a sha256 per file (sub-millisecond) and it is what tells us
		// whether the turn primed the cache at all — the difference between a
		// loop that costs nothing and one that costs ~880 ms per file.
		const primed: LspEnrichmentTarget[] = [];
		const cold: LspEnrichmentTarget[] = [];
		for (const filePath of capped) {
			// Reuse the cache primed by the dispatch pipeline's touchFile earlier
			// in this turn — but only when it is verified current. A second
			// open+wait here costs ~1 s/file with the LSP cold, so we pass the
			// hash of the current file bytes: getLastKnownDiagnostics returns the
			// entry only if it was primed for the SAME content, so a previous
			// turn's diagnostics are never served as current. On any miss (no
			// entry, content drift, or an entry written without content) the file
			// needs a fresh read.
			const content = fs.existsSync(filePath)
				? fs.readFileSync(filePath, "utf-8")
				: undefined;
			const contentHash =
				content !== undefined
					? createHash("sha256").update(content).digest("hex")
					: undefined;
			const cached =
				contentHash !== undefined
					? lspService.getLastKnownDiagnostics(filePath, contentHash)
					: undefined;
			(cached !== undefined ? primed : cold).push({
				filePath,
				content,
				cached,
			});
		}

		// #2504 (3) wall budget, raced against the turn's abort signal. Both
		// bounds, per AGENTS.md: neither a cap nor a deadline alone stops a
		// cancelled turn from paying for work nobody is waiting for.
		const deadline = Date.now() + budgetMs;
		const exhausted = (): boolean =>
			args.signal?.aborted === true || Date.now() >= deadline;

		const pullTimeoutMs = boundedNumber(
			args.lspPullTimeoutMs,
			ACTIONABLE_WARNINGS_LSP_PULL_TIMEOUT_MS,
		);
		// #2504 review round 2 (F3): the in-band loop gets the same per-call
		// bound and the same once-resolved service as the deferred one — the
		// deferral must not be the only path that is bounded.
		const inBandDeps: LspEnrichmentDeps = {
			lspService,
			pullTimeoutMs,
			// #2504 review round 4 (F2). This is the AWAITED hook: the batch
			// budget has to bound what happens INSIDE a file, not only how many
			// files get started.
			deadlineAt: deadline,
			signal: args.signal,
			// This loop IS on the awaited hook, so its exceedances are turn_end's.
			site: { hook: "turn_end", label: "lspEnrichmentRoundTrip" },
		};

		let unchecked = 0;
		const runInBand = async (targets: LspEnrichmentTarget[]): Promise<void> => {
			for (const target of targets) {
				if (exhausted()) {
					unchecked += targets.length - targets.indexOf(target);
					break;
				}
				records.push(
					...(await enrichFileFromLsp(cwd, args, target, inBandDeps)),
				);
				// #2504 review round 5 (F2): stamped when THIS file's pull
				// returned, not when the report is assembled.
				observedAtByPath.set(
					normalizeMapKey(target.filePath),
					new Date().toISOString(),
				);
			}
		};

		// Cached files first: they are free, and whether ANY of them exist is
		// what decides the cold set's fate below.
		await runInBand(primed);

		// #2504 (4) cold-cache deferral. When the turn primed nothing, every
		// remaining file is a full open + diagnostic wait; that whole loop is
		// what held the terminal for 187 s. It still runs — off the awaited
		// hook — and lands in the same `actionable-warnings` cache the in-band
		// report goes to, so the findings reach the agent by the same channel,
		// one turn later at worst.
		if (cold.length > 0 && primed.length === 0) {
			// #2504 review round 2 (F3). The pre-fix loop captured
			// `args.signal` — the COMPLETED turn's `ctx.signal`, which
			// `index.ts` clears from the ambient slot in its `finally`, so it
			// could never fire. `armDeferredLspWork` returns the module slot's
			// live signal; `resetLSPService` fires it, which is how
			// session_shutdown, session_start and the idle reset all reach this
			// loop. The turn's own signal is still folded in so a genuine
			// mid-turn abort counts.
			//
			// #2504 review round 3 (F-A(d)): it returns `undefined` when an
			// EARLIER deferral still holds the slot. The incumbent wins — see
			// `armDeferredLspWork` — and this turn states its loss instead of
			// cancelling a loop that is about to publish.
			const deferredSignal = armDeferredLspWork();
			if (deferredSignal === undefined) {
				incrementDegradationCount({
					kind: "actionable-warnings-cap",
					subject: `${cwd}:deferral-declined`,
					// #2504 review round 4 (F1): the old wording ended "rather than
					// cancel it", which asserted a preservation that did not
					// happen -- the incumbent's report was then discarded whole by
					// the persisted-newer guard. With the per-file merge below it
					// is true, so it now says exactly WHAT survives and what does
					// not.
					reason: `an earlier deferred LSP pull is still running; ${cold.length} file(s) went unchecked for code actions this turn. What IS preserved is the incumbent loop's work: when it lands, its per-file entries are merged into whatever report is persisted then, for every file whose fileSeq has not advanced. This turn's own cold files are the loss, and nothing re-derives them -- the next report is a delta over a different file set`,
				});
				logActionableWarningsEvent({
					event: "lsp_pull_deferral_declined",
					sessionId: args.sessionId,
					metadata: { turnIndex: args.turnIndex, files: cold.length },
				});
				args.dbg?.(
					`actionable_warnings: an earlier deferred LSP pull still holds the slot — skipping ${cold.length} fresh pull(s) this turn`,
				);
			} else {
				const carried = [...records];
				const deferredArgs = args;
				const loopSignal =
					combineAbortSignals(args.signal, deferredSignal) ?? deferredSignal;
				const deferredDeps: LspEnrichmentDeps = {
					lspService,
					pullTimeoutMs,
					signal: loopSignal,
					// OFF the hook by construction: this loop is the answer to
					// turn_end's budget, not a spender of it, and it runs on its
					// own ACTIONABLE_WARNINGS_DEFERRED_BUDGET_MS deadline. Charging
					// its exceedances to `turn_end` would make the hook look over
					// budget for having correctly deferred the work (#2557 F3).
					site: {
						hook: "off_hook",
						label: "deferredLspEnrichmentRoundTrip",
					},
				};
				const deferredWork = (async () => {
					// Yield a full macrotask first. Without this the loop would run
					// its first open+pull inside the awaited call's own microtask
					// drain — "deferred" only on paper, and still on the hook.
					await new Promise((resolve) => setTimeout(resolve, 0));
					const deferredRecords = [...carried];
					const deferredDeadline =
						Date.now() + ACTIONABLE_WARNINGS_DEFERRED_BUDGET_MS;
					// #2504 review round 4 (F2): set here, not at construction --
					// the deferred loop's budget starts when the loop does, one
					// macrotask after these deps were built.
					deferredDeps.deadlineAt = deferredDeadline;
					let deferredUnchecked = 0;
					let abortedMidLoop = false;
					for (const target of cold) {
						if (loopSignal.aborted || Date.now() >= deferredDeadline) {
							abortedMidLoop = loopSignal.aborted;
							deferredUnchecked += cold.length - cold.indexOf(target);
							break;
						}
						deferredRecords.push(
							...(await enrichFileFromLsp(
								cwd,
								deferredArgs,
								target,
								deferredDeps,
							)),
						);
						// #2504 review round 5 (F2). This is the loop the defect
						// was about: it can run for a minute, and one stamp taken
						// at its end described all of it.
						observedAtByPath.set(
							normalizeMapKey(target.filePath),
							new Date().toISOString(),
						);
					}
					if (deferredUnchecked > 0) {
						recordDegradationOnce({
							kind: "actionable-warnings-cap",
							subject: `${cwd}:deferred-budget`,
							reason: `deferred LSP enrichment stopped early; ${deferredUnchecked} file(s) were not checked for code actions`,
						});
					}
					// An ABORTED loop delivers nothing (#2504 review round 2, F3).
					// The service it was reading is gone — session_shutdown,
					// session_start, or the idle reset retired it — so its partial
					// record set describes nothing current, and publishing it would
					// be exactly the stale-clobber F2 guards against on the other
					// side.
					if (abortedMidLoop || loopSignal.aborted) {
						logActionableWarningsEvent({
							event: "lsp_pull_aborted",
							sessionId: deferredArgs.sessionId,
							metadata: {
								turnIndex: deferredArgs.turnIndex,
								unchecked: deferredUnchecked,
							},
						});
						return;
					}
					deferredArgs.onDeferredReport?.(
						assembleReport(cwd, deferredArgs, deferredRecords, {
							observedAtByPath,
							fallbackObservedAt: buildStartedAt,
						}),
					);
				})().catch((err) => {
					args.dbg?.(`actionable_warnings: deferred LSP pull failed: ${err}`);
				});
				registerDeferredLspWork(deferredSignal, deferredWork);
				logActionableWarningsEvent({
					event: "lsp_pull_deferred",
					sessionId: args.sessionId,
					metadata: { turnIndex: args.turnIndex, files: cold.length },
				});
				args.dbg?.(
					`actionable_warnings: no LSP cache primed this turn — deferring ${cold.length} fresh pull(s) off the turn_end hook`,
				);
			}
		} else {
			await runInBand(cold);
		}

		if (unchecked > 0) {
			recordDegradationOnce({
				kind: "actionable-warnings-cap",
				subject: `${cwd}:wall-budget`,
				reason: `LSP enrichment hit its ${Math.round(budgetMs)}ms turn budget; ${unchecked} file(s) were not checked for code actions this turn`,
			});
		}
	}

	return assembleReport(cwd, args, records, {
		observedAtByPath,
		fallbackObservedAt: buildStartedAt,
	});
}

/**
 * Enrich one file's LSP warnings into records. Split out of
 * `buildActionableWarningsReport` (#2504) so the in-band loop and the deferred
 * off-hook loop run byte-identical logic — the deferral must not become a
 * second, drifting copy of the enrichment.
 */
async function enrichFileFromLsp(
	cwd: string,
	args: BuildActionableWarningsArgs,
	target: LspEnrichmentTarget,
	deps: LspEnrichmentDeps,
): Promise<ActionableWarningRecord[]> {
	const { lspService } = deps;
	const { filePath } = target;
	const out: ActionableWarningRecord[] = [];
	let diags: LSPDiagnostic[];
	let lspSource: "cache" | "fresh" = "cache";
	if (target.cached !== undefined) {
		diags = target.cached;
	} else {
		// #2504 review round 2 (F3): never OPEN a file once the loop has been
		// signalled. The checks inside `boundedLspCall` cover the round trips;
		// this one covers the decision to touch the file at all, which is what
		// makes a session_shutdown landing mid-loop a no-op rather than one
		// more document handed to a service that is being torn down.
		if (deps.signal?.aborted) {
			logActionableWarningsEvent({
				event: "lsp_file_skipped",
				sessionId: args.sessionId,
				filePath,
				metadata: { reason: "aborted" },
			});
			return out;
		}
		try {
			if (target.content) {
				// #2504 review round 3 (F-B), the #240 shape. `openFile` resolves
				// `void`, so the bounded call cannot distinguish success from
				// either bound winning unless the success path returns a value of
				// its own. Round 2 discarded the result entirely: a 10 s timeout
				// or an abort "succeeded" silently, and the pull below then asked
				// the server about a document it had never received. The `[]` that
				// answers means UNKNOWN, but it was recorded
				// `lsp_file_checked lspSource:"fresh"` — a failed pull read as
				// clean, which is precisely what the comment on the pull forbids.
				const opened = await boundedLspCall(async () => {
					await lspService.openFile(filePath, target.content as string);
					return true as const;
				}, deps);
				if (opened === undefined) {
					logActionableWarningsEvent({
						event: "lsp_file_skipped",
						sessionId: args.sessionId,
						filePath,
						metadata: {
							reason: deps.signal?.aborted ? "aborted" : "open_timeout",
							pullTimeoutMs: deps.pullTimeoutMs,
						},
					});
					return out;
				}
			}
			const pulled = await boundedLspCall(
				() => lspService.getDiagnostics(filePath),
				deps,
			);
			if (pulled === undefined) {
				// Either bound won. A failed pull is NEVER read as clean (#240):
				// the file is reported unchecked and contributes no records.
				logActionableWarningsEvent({
					event: "lsp_file_skipped",
					sessionId: args.sessionId,
					filePath,
					metadata: {
						reason: deps.signal?.aborted ? "aborted" : "pull_timeout",
						pullTimeoutMs: deps.pullTimeoutMs,
					},
				});
				return out;
			}
			diags = pulled;
			lspSource = "fresh";
		} catch (err) {
			args.dbg?.(
				`actionable_warnings: LSP diagnostics failed for ${filePath}: ${err}`,
			);
			logActionableWarningsEvent({
				event: "lsp_file_skipped",
				sessionId: args.sessionId,
				filePath,
				metadata: { reason: "lsp_error", error: String(err) },
			});
			return out;
		}
	}
	const ranges = args.modifiedRangesByFile.get(normalizeMapKey(filePath)) ?? [];
	const diagsWarning = diags.filter((d) => d.severity === 2);
	let deltaFiltered = 0;
	let enriched = 0;
	let actionPulls = 0;
	let actionCapped = 0;
	let budgetStopped = 0;
	for (const diag of diagsWarning) {
		// #2504 review round 4 (F2). The wall budget used to be re-checked
		// BETWEEN files only, so a single file could keep the AWAITED hook for
		// openFile + getDiagnostics + up to 25 codeAction round trips long after
		// the batch budget expired. The loop deadline is threaded through deps
		// and re-read HERE, between round trips: a file already opened still
		// finishes its cheap work, but it cannot buy more LSP time.
		if (deps.deadlineAt !== undefined && Date.now() >= deps.deadlineAt) {
			budgetStopped = diagsWarning.length - diagsWarning.indexOf(diag);
			break;
		}
		const line = diag.range.start.line + 1;
		if (args.deltaOnly !== false && !lineInModifiedRanges(line, ranges)) {
			deltaFiltered++;
			continue;
		}
		// #2504 review round 3 (S-2): bound the per-file codeAction fan-out.
		if (actionPulls >= ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE) {
			actionCapped++;
			continue;
		}
		actionPulls++;
		const record = recordFromLspDiagnostic(diag, filePath, cwd);
		try {
			const actions = await boundedLspCall(
				() =>
					lspService.codeAction(
						filePath,
						diag.range.start.line,
						diag.range.start.character,
						diag.range.end.line,
						diag.range.end.character,
					),
				deps,
			);
			record.actions = (actions ?? []).map(serializeAction).slice(0, 5);
		} catch (err) {
			args.dbg?.(
				`actionable_warnings: LSP codeAction failed for ${filePath}: ${err}`,
			);
		}
		if (record.actions.length > 0) {
			out.push(record);
			enriched++;
		}
	}
	if (actionCapped > 0) {
		incrementDegradationCount({
			kind: "actionable-warnings-cap",
			subject: `${cwd}:code-action-fanout`,
			// #2504 review round 4 (S-2): "reported without fix actions" was
			// wrong in both halves. A capped warning is skipped BEFORE its record
			// is built, and a record with no action is dropped below anyway, so
			// it is not reported at all -- it never reaches the agent on this
			// channel.
			reason: `a file exceeded the ${ACTIONABLE_WARNINGS_MAX_CODE_ACTIONS_PER_FILE}-warning code-action cap; ${actionCapped} warning(s) in ${toRunnerDisplayPath(cwd, filePath)} were NOT reported this turn`,
		});
	}
	if (budgetStopped > 0) {
		incrementDegradationCount({
			kind: "actionable-warnings-cap",
			subject: `${cwd}:in-file-budget`,
			reason: `the LSP enrichment wall budget expired part-way through a file; ${budgetStopped} warning(s) in ${toRunnerDisplayPath(cwd, filePath)} were NOT checked for fix actions`,
		});
	}
	logActionableWarningsEvent({
		event: "lsp_file_checked",
		sessionId: args.sessionId,
		filePath,
		metadata: {
			diagsTotal: diags.length,
			diagsWarning: diagsWarning.length,
			deltaFiltered,
			enriched,
			actionCapped,
			budgetStopped,
			modifiedRangesCount: ranges.length,
			lspSource,
		},
	});
	return out;
}

/**
 * Assemble the report from a record set. Called once for the in-band report
 * and again, off-hook, when the deferred fresh pull completes (#2504).
 */
function assembleReport(
	cwd: string,
	args: BuildActionableWarningsArgs,
	records: ActionableWarningRecord[],
	stamps?: {
		/** When each file's LSP pull returned, by normalized path (#2504 r5 F2). */
		observedAtByPath: Map<string, string>;
		/** Stand-in for a file no LSP pull touched; never later than the truth. */
		fallbackObservedAt: string;
	},
): ActionableWarningsReport {
	const merged = mergeWarnings(records);
	updateWarningState(cwd, merged);
	// legacyId is #1816 migration bookkeeping for updateWarningState above —
	// strip it before the report leaves this function, so it never lands in
	// the `<project-data-dir>/cache/actionable-warnings.json` cache file or any
	// agent-facing rendering of a warning record.
	const reportWarnings = merged.map(({ legacyId: _legacyId, ...rest }) => rest);
	const byFile = new Map<string, ActionableWarningRecord[]>();
	for (const warning of reportWarnings) {
		const arr = byFile.get(warning.filePath) ?? [];
		arr.push(warning);
		byFile.set(warning.filePath, arr);
	}
	// #2504 review round 4 (F1): every entry carries the moment it was
	// assembled, so a report that later absorbs a deferred pull's entries can
	// still age each half honestly. For a report built in one pass they are all
	// the report stamp.
	const generatedAt = new Date().toISOString();
	const files: ActionableWarningsReportFile[] = [...byFile.entries()].map(
		([filePath, warnings]) => ({
			filePath,
			displayPath: toRunnerDisplayPath(cwd, filePath),
			fileSeq: args.fileSeqByPath?.get(normalizeMapKey(filePath)),
			// #2504 review round 5 (F2): the moment THIS file was observed. The
			// report-level stamp remains the assembly moment and is only the
			// last-resort fallback, for a caller that supplied no observations
			// at all.
			generatedAt:
				stamps?.observedAtByPath.get(normalizeMapKey(filePath)) ??
				stamps?.fallbackObservedAt ??
				generatedAt,
			warnings,
		}),
	);
	const summary = summarizeReportFiles(files);

	logActionableWarningsEvent({
		event: "report_complete",
		sessionId: args.sessionId,
		metadata: { turnIndex: args.turnIndex, summary },
	});

	return {
		generatedAt,
		scope: "turn_delta",
		sessionId: args.sessionId,
		turnIndex: args.turnIndex,
		projectSeqStart: args.projectSeqStart,
		projectSeqEnd: args.projectSeqEnd,
		deltaOnly: args.deltaOnly !== false,
		includeLspCodeActions: args.includeLspCodeActions,
		files,
		summary,
	};
}

/**
 * The report summary, derived from the per-file entries.
 *
 * ONE derivation (#2504 review round 4, F1): a merged report's summary has to
 * describe the merged file set, and a second hand-rolled tally beside
 * assembleReport's would be the mirrored-registry defect AGENTS.md names.
 * Every warning belongs to exactly one file entry, so summing over entries and
 * summing over the flat record list give the same numbers.
 */
function summarizeReportFiles(
	files: ActionableWarningsReportFile[],
): ActionableWarningsReport["summary"] {
	const warnings = files.flatMap((file) => file.warnings);
	const unsuppressed = warnings.filter((warning) => !warning.suppressed);
	const allActions = warnings.flatMap((warning) => warning.actions);
	const countTier = (tier: ActionableWarningRecord["severity"]): number =>
		unsuppressed.filter((warning) => warning.severity === tier).length;
	return {
		warnings: warnings.length,
		unsuppressed: unsuppressed.length,
		byTier: {
			warning: countTier("warning"),
			info: countTier("info"),
			hint: countTier("hint"),
		},
		suppressed: warnings.filter((warning) => warning.suppressed).length,
		files: files.length,
		actions: allActions.length,
		autoFixEligible: allActions.filter((action) => action.autoFixEligible)
			.length,
	};
}

/**
 * The ONE place an actionable-warnings report reaches disk.
 *
 * Deliberately NOT exported (#2504 review round 5, F1). Two writers used to
 * publish to this key: the in-band turn_end report, which OVERWROTE blindly,
 * and the deferred off-hook report, which read-modify-wrote. A deferred merge
 * that landed anywhere inside turn N+1's handleTurnEnd -- the cascade settle,
 * knip, madge, the test batch, the in-band LSP enrichment; a window seconds
 * wide, measured at 607 ms in the reviewer's trace -- was erased by that
 * turn's blind write, and the findings the whole deferral exists to deliver
 * were gone with it. A blind writer and a merging writer on one key can only
 * ever be a race. There is now one publisher and it always merges; the private
 * scope is what keeps it that way.
 */
function writeActionableWarningsReport(
	cacheManager: CacheManager,
	cwd: string,
	report: ActionableWarningsReport,
): void {
	cacheManager.writeCache("actionable-warnings", report, cwd);
}

/** Which publish an entry came from; the merge is asymmetric between them. */
export type ActionableWarningsPublishOrigin = "in-band" | "deferred";

/**
 * Merge a report about to be published into whatever is already persisted,
 * PER FILE.
 *
 * #2504 review round 4 (F1) established the shape: a report is a MAP of
 * per-file entries, each stamped with that file's fileSeq and its own
 * observation time, so ordering belongs PER FILE and not to the report as a
 * whole. Rounds 2 and 3 ordered whole reports -- publish, or discard on a
 * newer turnIndex/projectSeqEnd -- and that composed with incumbent-wins into
 * "publish nothing".
 *
 * #2504 review round 5 (F1) generalized it to BOTH publishers, because the
 * in-band write was still blind and erased a deferred merge that landed
 * mid-turn. The two directions are asymmetric and the asymmetry is the whole
 * design:
 *
 *  - A DEFERRED publish carries the OLDER observation. Everything persisted is
 *    newer and is kept unconditionally; the deferred entries upsert into it
 *    wherever their file has not moved.
 *  - An IN-BAND publish carries the NEWER observation. It is this turn's own
 *    report, and its identity (turnIndex, projectSeq window, deltaOnly) is
 *    published untouched. From the persisted report it carries forward ONLY
 *    entries a deferral produced -- the scope guard, see
 *    {@link ActionableWarningsReportFile.origin}. Carrying everything would
 *    accumulate every prior turn's findings into a report whose scope field
 *    says "turn_delta"; carrying nothing is the F1 defect.
 *
 * Where both halves hold a file the warnings are UNIONED through mergeWarnings
 * (the same de-duplicating merge the dispatch/LSP union already uses), so a
 * newer entry is never REPLACED by an older one -- it only gains what the
 * older one found -- and the merged entry is aged by the OLDER of the two
 * stamps, because it now holds both observations.
 *
 * Exported because the merge, not the write, is what has to be pinned: a test
 * can hand it two reports and read the ordering decision directly.
 */
export function mergeActionableWarningsReports(args: {
	persisted?: ActionableWarningsReport;
	incoming: ActionableWarningsReport;
	origin: ActionableWarningsPublishOrigin;
	/**
	 * The runtime's LIVE per-file sequence, and the authoritative baseline: the
	 * persisted report lists only files that have warnings, so a file the next
	 * turn edited into cleanliness is absent from it and would otherwise read
	 * as unchanged. Falls back to the surviving entry's own fileSeq when the
	 * caller has no runtime to ask.
	 */
	getFileSeq?: (filePath: string) => number;
	/** #2504 review round 6 (F1/b): traces the scope-guard drop -- informational, not a degradation. */
	dbg?: (msg: string) => void;
}): {
	report: ActionableWarningsReport;
	mergedFiles: number;
	droppedFiles: string[];
	/**
	 * #2504 review round 8 (S2): whether the drop was caused by a session
	 * boundary (a foreign sessionId, files not necessarily changed) rather
	 * than the file having changed on disk -- the two causes need different
	 * ledger wording, since "changed" is false on the session-boundary path.
	 */
	droppedForSessionMismatch: boolean;
} {
	const { persisted, incoming, origin } = args;
	const deferredPublish = origin === "deferred";

	// The newer half wins identity and fileSeq; the older half is folded in.
	// #2504 review round 6 (F1) removed a same-sessionId gate here, reasoning
	// that the fileSeq equality check below subsumed it: pi's telemetry
	// sessionId is STABLE across a quit->resume (setSessionLifecycle pins it,
	// runtime-coordinator.ts:677-682), but resetForSession clears the live
	// _fileSeq map for the new process, so a resumed process's getFileSeq
	// answers 0 for a file a PRE-restart deferral had recorded at a nonzero
	// seq -- the sessionId gate could not see that (same id, stale data), the
	// equality check could.
	// #2504 review round 7 (F4): that reasoning breaks at fileSeq 0. A file
	// THIS process has never touched also answers getFileSeq 0 (a fresh
	// RuntimeCoordinator's map starts empty), and an entry a DIFFERENT
	// process stamped at fileSeq 0 can reach the persisted report entirely
	// unrelated to a resume: `mcp/analyze.ts` and `mcp/session.ts` register
	// modified ranges through their OWN CacheManager, which never bumps the
	// extension runtime's `_fileSeq` map, so an MCP-touched file can persist
	// at seq 0 under a foreign sessionId. `0 !== 0` then reads FALSE and the
	// entry is carried as if it were this session's own unmoved file. The
	// sessionId gate is restored ALONGSIDE the equality check, not instead of
	// it: equality alone catches the resume-reset case (same session, seq
	// forcibly reset to 0), the sessionId gate alone catches the
	// foreign-session case (different session, seq coincidentally equal,
	// often both 0) -- neither subsumes the other.
	const sessionMismatch =
		!deferredPublish &&
		persisted?.sessionId !== undefined &&
		persisted.sessionId !== incoming.sessionId;
	const newerHalf = deferredPublish ? (persisted?.files ?? []) : incoming.files;
	const olderHalf = deferredPublish ? incoming.files : (persisted?.files ?? []);
	const newerReport = deferredPublish ? persisted : incoming;
	const olderReport = deferredPublish ? incoming : persisted;

	const byPath = new Map<string, ActionableWarningsReportFile>();
	for (const entry of newerHalf) {
		byPath.set(normalizeMapKey(entry.filePath), entry);
	}

	const droppedFiles: string[] = [];
	let mergedFiles = 0;
	for (const entry of olderHalf) {
		// The scope guard. An in-band publish exists to add THIS turn's
		// findings; the only thing it owes the persisted report is the deferred
		// work that would otherwise be erased between the read and the write.
		// #2504 review round 6 (b): the marker spend (below) means an entry
		// carried once and then dropped here on the NEXT in-band publish is
		// expected, not a fault -- traced to dbg (informational) rather than
		// the degradation ledger (which is for loss the agent didn't cause).
		if (!deferredPublish && entry.origin !== "deferred") {
			args.dbg?.(
				`actionable_warnings: in-band publish dropped ${entry.displayPath || entry.filePath} -- its carry-forward window (from an earlier deferred publish) already closed`,
			);
			continue;
		}
		const key = normalizeMapKey(entry.filePath);
		const incumbent = byPath.get(key);
		const liveBaseline = args.getFileSeq !== undefined;
		const baselineSeq = args.getFileSeq?.(entry.filePath) ?? incumbent?.fileSeq;
		// #2504 review round 6 (F1): the in-band carry-forward path, when a
		// LIVE baseline is available, requires EXACT equality rather than
		// "baseline advanced past it". An unmoved file's live fileSeq always
		// equals its persisted entry's recorded fileSeq; any mismatch --
		// higher (edited since) OR lower (a resumed process whose fileSeq map
		// was cleared, #2504 r6 F1) -- means the entry no longer describes
		// what is on disk now. The deferred-publish path keeps the coarser
		// ">" check: a live process's own fileSeq only ever advances, so
		// "advanced past it" and "mismatched" agree there, and the deferred
		// loop's entries can legitimately equal a JUST-bumped incumbent seq
		// it upserts into.
		const stale =
			!deferredPublish && liveBaseline
				? sessionMismatch ||
					(typeof entry.fileSeq === "number" && baselineSeq !== entry.fileSeq)
				: typeof baselineSeq === "number" &&
					typeof entry.fileSeq === "number" &&
					baselineSeq > entry.fileSeq;
		if (stale) {
			droppedFiles.push(entry.displayPath || entry.filePath);
			continue;
		}
		mergedFiles++;
		const merged: ActionableWarningsReportFile = incumbent
			? {
					...incumbent,
					fileSeq: incumbent.fileSeq ?? entry.fileSeq,
					generatedAt: olderStamp(
						incumbent.generatedAt ?? newerReport?.generatedAt,
						entry.generatedAt ?? olderReport?.generatedAt,
					),
					warnings: mergeWarnings([...incumbent.warnings, ...entry.warnings]),
				}
			: { ...entry };
		if (deferredPublish) {
			// Mark it, so the next in-band publish carries it forward across the
			// window in which it would otherwise be overwritten.
			merged.origin = "deferred";
		} else {
			// Carried forward exactly once: the marker is spent here.
			merged.origin = undefined;
		}
		byPath.set(key, merged);
	}

	const files = [...byPath.values()];
	if (!deferredPublish) {
		// This turn's report, with the rescued entries folded in. Its identity
		// is published untouched: a carried entry's provenance lives ON the
		// entry (its own fileSeq and generatedAt), which is exactly why round 4
		// moved those fields there, and widening turnIndex/projectSeqStart to
		// span the older half would make the report claim a window it never
		// observed.
		return {
			report: { ...incoming, files, summary: summarizeReportFiles(files) },
			mergedFiles,
			droppedFiles,
			// sessionMismatch is a single flag for the whole call, not per-entry:
			// once true, every stale check above is forced true by the `||`, so
			// EITHER every drop in this batch is a session-boundary drop, OR none
			// are (droppedFiles is then purely fileSeq-mismatch drops).
			droppedForSessionMismatch: sessionMismatch && droppedFiles.length > 0,
		};
	}
	const base = persisted ?? incoming;
	return {
		report: {
			...base,
			// The report-level stamp is only the fallback for entries with none
			// of their own (a cache file from an older build), so it takes the
			// NEWER of the two; per-entry stamps carry the real ages.
			generatedAt:
				newerStamp(persisted?.generatedAt, incoming.generatedAt) ??
				base.generatedAt,
			turnIndex: Math.max(base.turnIndex, incoming.turnIndex),
			projectSeqStart: minDefined(
				persisted?.projectSeqStart,
				incoming.projectSeqStart,
			),
			// max, so a merged report never claims to be fresher OR staler than
			// the newest part it holds. checkActionableWarningsReportFresh still
			// demands exact equality with the live projectSeq and re-checks every
			// entry's fileSeq, so this widens nothing.
			projectSeqEnd: maxDefined(
				persisted?.projectSeqEnd,
				incoming.projectSeqEnd,
			),
			includeLspCodeActions:
				base.includeLspCodeActions || incoming.includeLspCodeActions,
			files,
			summary: summarizeReportFiles(files),
		},
		mergedFiles,
		droppedFiles,
		// The deferred-publish path never sets sessionMismatch (gated by
		// `!deferredPublish` above), so its drops are always fileSeq-mismatch.
		droppedForSessionMismatch: false,
	};
}

/**
 * Publish an actionable-warnings report: read what is persisted, merge per
 * file, write. THE choke point (#2504 review round 5, F1) -- every publisher
 * goes through it, so no writer can clobber another's entries.
 *
 * The read and the merge and the write are one synchronous block, which is
 * what makes this safe against the deferred callback: node runs no other
 * continuation between them, so the only interleaving left is publish-vs-
 * publish, and that is exactly what the merge resolves.
 */
export function publishActionableWarningsReport(
	cacheManager: CacheManager,
	cwd: string,
	report: ActionableWarningsReport,
	opts: {
		origin?: ActionableWarningsPublishOrigin;
		getFileSeq?: (filePath: string) => number;
		dbg?: (msg: string) => void;
	} = {},
): {
	report: ActionableWarningsReport;
	mergedFiles: number;
	droppedFiles: string[];
} {
	const origin = opts.origin ?? "in-band";
	// No TTL: "what is already on disk" is a question about ORDERING, not
	// freshness, so an entry old enough to have expired for a CONSUMER still
	// has to be merged into rather than clobbered.
	const persisted = cacheManager.readCache<ActionableWarningsReport>(
		"actionable-warnings",
		cwd,
		Number.MAX_SAFE_INTEGER,
	)?.data;
	const merged = mergeActionableWarningsReports({
		persisted,
		incoming: report,
		origin,
		getFileSeq: opts.getFileSeq,
		dbg: opts.dbg,
	});
	writeActionableWarningsReport(cacheManager, cwd, merged.report);
	// The history records what THIS publish OBSERVED, not what it carried: a
	// merged-in entry is already on the NDJSON from the publish that produced
	// it, and appending the merged report would duplicate every carried row on
	// every subsequent turn.
	appendActionableWarningsHistory(cwd, report);
	if (merged.mergedFiles > 0) {
		opts.dbg?.(
			`actionable_warnings: ${origin} publish merged ${merged.mergedFiles} persisted file entry/entries`,
		);
	}
	// #2504 review round 7 (F5): the deferred origin's own loss is already
	// recorded by {@link writeDeferredActionableWarningsReport}, which calls
	// through here first. The IN-BAND origin has the same shape of loss --
	// this turn's own publish carries a carried-forward deferred entry
	// forward only while its file has not moved, and a file that moved
	// between the deferral and this publish is dropped -- but nothing counted
	// or traced it: only the benign, expected scope-guard spend (an entry
	// whose carry-forward window already closed) got a dbg line. Same
	// accounting, mirrored for the origin that was silent.
	if (origin === "in-band" && merged.droppedFiles.length > 0) {
		// #2504 review round 8 (S2): "changed" is only true on the fileSeq-
		// mismatch path. A foreign sessionId (a resumed process, or a
		// different session's write) drops the same carried-forward entries
		// without any file having moved -- name the actual cause instead of
		// asserting a change that may not have happened.
		const cause = merged.droppedForSessionMismatch
			? "the publish crossed a session boundary (a different session's write, or a resumed process) before this turn's in-band publish could keep them"
			: "changed before this turn's in-band publish could keep them";
		incrementDegradationCount({
			kind: "actionable-warnings-inband-superseded",
			subject: `${path.resolve(cwd)}:inband-carry-superseded`,
			reason: `${merged.droppedFiles.length} carried-forward deferred file entry/entries ${cause} (${merged.droppedFiles.slice(0, 3).join(", ")}${merged.droppedFiles.length > 3 ? ", ..." : ""}); their earlier findings are LOST on this channel rather than published against content that has since moved`,
		});
		opts.dbg?.(
			`actionable_warnings: in-band publish dropped ${merged.droppedFiles.length} superseded carried-forward file entry/entries (${merged.droppedFiles.slice(0, 3).join(", ")}${merged.droppedFiles.length > 3 ? ", ..." : ""})`,
		);
	}
	return merged;
}
/** The earlier of two ISO stamps; either may be missing or unparseable. */
function olderStamp(a?: string, b?: string): string | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	const at = Date.parse(a);
	const bt = Date.parse(b);
	if (!Number.isFinite(at)) return b;
	if (!Number.isFinite(bt)) return a;
	return at <= bt ? a : b;
}

/** The later of two ISO stamps; either may be missing or unparseable. */
function newerStamp(a?: string, b?: string): string | undefined {
	const older = olderStamp(a, b);
	if (a === undefined) return b;
	if (b === undefined) return a;
	return older === a ? b : a;
}

function minDefined(a?: number, b?: number): number | undefined {
	if (typeof a !== "number") return b;
	if (typeof b !== "number") return a;
	return Math.min(a, b);
}

function maxDefined(a?: number, b?: number): number | undefined {
	if (typeof a !== "number") return b;
	if (typeof b !== "number") return a;
	return Math.max(a, b);
}

/**
 * Publish a DEFERRED off-hook report.
 *
 * The deferred fresh-pull loop is stamped with the ORIGINATING turn's
 * turnIndex/projectSeq and may run for up to
 * ACTIONABLE_WARNINGS_DEFERRED_BUDGET_MS -- many turns in a busy session. It
 * must therefore neither overwrite a newer report nor be thrown away because
 * one exists; see mergeActionableWarningsReports for why replace-or-discard
 * could only ever discard. Per-file loss is the only loss left, and it is
 * recorded rather than silent.
 *
 * A thin wrapper over the choke point since #2504 review round 5 (F1). It
 * exists only to own the degradation record for the per-file loss -- the
 * "declined the write" branches it used to carry are gone, because a publish
 * that merges has nothing to decline.
 */
export function writeDeferredActionableWarningsReport(args: {
	cacheManager: CacheManager;
	cwd: string;
	report: ActionableWarningsReport;
	getFileSeq?: (filePath: string) => number;
	dbg?: (msg: string) => void;
}): {
	mergedFiles: number;
	droppedFiles: number;
} {
	const { mergedFiles, droppedFiles } = publishActionableWarningsReport(
		args.cacheManager,
		args.cwd,
		args.report,
		{ origin: "deferred", getFileSeq: args.getFileSeq, dbg: args.dbg },
	);

	if (droppedFiles.length > 0) {
		// Bounded and counted: one subject per project, a tally per occurrence.
		incrementDegradationCount({
			kind: "actionable-warnings-deferred-superseded",
			subject: `${path.resolve(args.cwd)}:deferred-file-superseded`,
			reason: `${droppedFiles.length} file(s) changed while the deferred LSP pull was reading them (${droppedFiles.slice(0, 3).join(", ")}${droppedFiles.length > 3 ? ", ..." : ""}); their warnings are LOST on this channel rather than published against content that has since moved. Every file that did NOT change was merged into the persisted report`,
		});
		args.dbg?.(
			`turn_end: deferred actionable-warnings dropped ${droppedFiles.length} superseded file entry/entries`,
		);
	}

	args.dbg?.(
		`turn_end: deferred actionable-warnings merged ${mergedFiles} file entry/entries into the persisted report`,
	);
	return { mergedFiles, droppedFiles: droppedFiles.length };
}
export interface ActionableWarningsHistoryEntry {
	timestamp: string;
	sessionId: string;
	turnIndex: number;
	projectSeq?: number;
	filePath: string;
	displayPath: string;
	fileSeq?: number;
	line?: number;
	column?: number;
	severity: ActionableWarningRecord["severity"];
	tool: string;
	source?: string;
	rule?: string;
	code?: string;
	message: string;
	fixKind?: string;
	autoFixAvailable?: boolean;
	actionCount: number;
	autoFixEligibleActionCount: number;
	suppressed: boolean;
	suppressionReason?: string;
	origin: ActionableWarningRecord["origin"];
	warningId: string;
}

export function getActionableWarningsHistoryPath(cwd: string): string {
	return path.join(getProjectDataDir(cwd), "actionable-warnings.jsonl");
}

/**
 * Append every actionable warning from this turn to the project's rolling
 * NDJSON history. Mirrors `appendCodeQualityWarningsHistory` so the two
 * advisory families have the same shape of cross-turn persistence:
 *
 *   - One line per warning (not per turn).
 *   - Carries the stable `aw:<hash>` id so callers can correlate the same
 *     warning across turns / sessions.
 *   - Captures suppression state at write time so historical analyses can
 *     reconstruct what the agent actually saw.
 *   - Captures action counts (and autoFixEligible counts) — the LSP code-
 *     action enrichment is the actionable-warnings-only signal; preserving
 *     it lets later analyses ask "which warnings ship with an autofix?".
 *
 * Skips the write entirely when no warnings exist — matching the code-
 * quality history's no-op-on-empty behaviour and keeping the file from
 * accumulating 0-warning noise.
 */
export function appendActionableWarningsHistory(
	cwd: string,
	report: ActionableWarningsReport,
): void {
	const entries: ActionableWarningsHistoryEntry[] = [];
	for (const file of report.files) {
		for (const warning of file.warnings) {
			entries.push({
				timestamp: report.generatedAt,
				sessionId: report.sessionId,
				turnIndex: report.turnIndex,
				projectSeq: report.projectSeqEnd,
				filePath: warning.filePath,
				displayPath: warning.displayPath,
				fileSeq: file.fileSeq,
				line: warning.line,
				column: warning.column,
				severity: warning.severity,
				tool: warning.tool,
				source: warning.source,
				rule: warning.rule,
				code: warning.code,
				message: warning.message,
				fixKind: warning.fixKind,
				autoFixAvailable: warning.autoFixAvailable,
				actionCount: warning.actions.length,
				autoFixEligibleActionCount: warning.actions.filter(
					(action) => action.autoFixEligible,
				).length,
				suppressed: warning.suppressed,
				suppressionReason: warning.suppressionReason,
				origin: warning.origin,
				warningId: warning.id,
			});
		}
	}
	if (entries.length === 0) return;
	const historyPath = getActionableWarningsHistoryPath(cwd);
	try {
		fs.mkdirSync(path.dirname(historyPath), { recursive: true });
		fs.appendFileSync(
			historyPath,
			`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			"utf8",
		);
	} catch {
		// Non-fatal — history write failure must never surface to the agent.
	}
}

export interface ActionableWarningsAutofixSummary {
	considered: number;
	applied: number;
	changedFiles: string[];
	skipped: Array<{ id: string; reason: string }>;
}

export interface ActionableWarningsFreshnessResult {
	fresh: boolean;
	reason?: string;
	reportProjectSeqEnd?: number;
	currentProjectSeq: number;
	filePath?: string;
	reportFileSeq?: number;
	currentFileSeq?: number;
}

export function checkActionableWarningsReportFresh(args: {
	report: ActionableWarningsReport;
	currentProjectSeq: number;
	getFileSeq?: (filePath: string) => number;
}): ActionableWarningsFreshnessResult {
	const reportProjectSeqEnd = args.report.projectSeqEnd;
	if (typeof reportProjectSeqEnd !== "number") {
		return {
			fresh: false,
			reason: "missing_project_seq",
			currentProjectSeq: args.currentProjectSeq,
		};
	}
	if (reportProjectSeqEnd !== args.currentProjectSeq) {
		return {
			fresh: false,
			reason: "project_seq_mismatch",
			reportProjectSeqEnd,
			currentProjectSeq: args.currentProjectSeq,
		};
	}
	if (args.getFileSeq) {
		for (const file of args.report.files) {
			if (typeof file.fileSeq !== "number") continue;
			const currentFileSeq = args.getFileSeq(file.filePath);
			if (currentFileSeq !== file.fileSeq) {
				return {
					fresh: false,
					reason: "file_seq_mismatch",
					reportProjectSeqEnd,
					currentProjectSeq: args.currentProjectSeq,
					filePath: file.filePath,
					reportFileSeq: file.fileSeq,
					currentFileSeq,
				};
			}
		}
	}
	return {
		fresh: true,
		reportProjectSeqEnd,
		currentProjectSeq: args.currentProjectSeq,
	};
}

export async function applyConservativeActionableWarningFixes(args: {
	cwd: string;
	report: ActionableWarningsReport;
	maxFixes?: number;
	dbg?: (msg: string) => void;
	mutationContext?: LspMutationContext;
}): Promise<ActionableWarningsAutofixSummary> {
	const summary: ActionableWarningsAutofixSummary = {
		considered: 0,
		applied: 0,
		changedFiles: [],
		skipped: [],
	};
	const changedFiles = new Set<string>();
	const appliedResults: Array<Awaited<ReturnType<typeof applyWorkspaceEdit>>> =
		[];
	let failedCount = 0;
	const lspService = getLSPService();
	const maxFixes = Math.max(0, args.maxFixes ?? 5);
	for (const file of args.report.files) {
		if (summary.applied >= maxFixes) break;
		for (const warning of file.warnings) {
			if (summary.applied >= maxFixes) break;
			if (warning.suppressed) continue;
			const eligibleActions = warning.actions.filter(
				(action) => action.autoFixEligible,
			);
			if (eligibleActions.length !== 1) {
				if (eligibleActions.length > 1)
					summary.skipped.push({
						id: warning.id,
						reason: "multiple_eligible_actions",
					});
				continue;
			}
			summary.considered++;
			if (!warning.line || !warning.column) {
				summary.skipped.push({ id: warning.id, reason: "missing_position" });
				continue;
			}
			if (!lspService.supportsLSP(warning.filePath)) {
				summary.skipped.push({ id: warning.id, reason: "no_lsp" });
				continue;
			}
			try {
				const content = fs.existsSync(warning.filePath)
					? fs.readFileSync(warning.filePath, "utf-8")
					: undefined;
				if (content) await lspService.openFile(warning.filePath, content);
				const line = warning.line - 1;
				const character = warning.column - 1;
				const actions = await lspService.codeAction(
					warning.filePath,
					line,
					character,
					line,
					character,
				);
				const title = eligibleActions[0]?.title;
				const selected = actions.find((action) => action.title === title);
				if (!selected) {
					summary.skipped.push({ id: warning.id, reason: "action_not_found" });
					continue;
				}
				const safety = actionSafety(selected);
				if (!safety.eligible) {
					summary.skipped.push({
						id: warning.id,
						reason: safety.reason ?? "not_safe",
					});
					continue;
				}
				const edit = selected.edit as Parameters<typeof applyWorkspaceEdit>[0];
				const applied = await applyWorkspaceEdit(
					edit,
					args.cwd,
					args.mutationContext
						? {
								mutationContext: {
									...args.mutationContext,
									emitSummary: false,
								},
							}
						: undefined,
				);
				appliedResults.push(applied);
				for (const changedFile of applied.files) changedFiles.add(changedFile);
				summary.applied++;
			} catch (err) {
				failedCount++;
				const partial = (
					err as {
						appliedWorkspaceEdit?: Awaited<
							ReturnType<typeof applyWorkspaceEdit>
						>;
					}
				).appliedWorkspaceEdit;
				if (partial) {
					appliedResults.push(partial);
					for (const changedFile of partial.files)
						changedFiles.add(changedFile);
				}
				const message = err instanceof Error ? err.message : String(err);
				args.dbg?.(
					`actionable_warnings_autofix failed for ${warning.id}: ${message}`,
				);
				summary.skipped.push({ id: warning.id, reason: "apply_failed" });
			}
		}
	}
	summary.changedFiles = [...changedFiles];
	if (
		args.mutationContext &&
		(summary.considered > 0 || appliedResults.length > 0)
	) {
		recordLspMutationBatch(args.mutationContext, {
			results: appliedResults,
			considered: summary.considered,
			completed: summary.applied,
			failedCount,
			status:
				failedCount > 0
					? "failed"
					: appliedResults.length > 0
						? "success"
						: "skipped",
			bookkeep: false,
		});
	}
	return summary;
}

/**
 * The turn-end advisory for this report.
 *
 * `cwd` is REQUIRED (#2521): the advisory names where the report lives, and
 * that location is `getProjectDataDir(cwd)`-resolved, not a constant. It was a
 * hardcoded `.pi-lens/cache/actionable-warnings.json` — correct only for a
 * project that already had a legacy `.pi-lens/` directory — so in every other
 * project the agent's `cat` of the advised path failed while the report sat
 * unread under `~/.pi-lens/projects/<slug>/cache/`. An OPTIONAL `cwd` would
 * have kept that bug alive behind a default, so callers must pass it.
 */
export function formatActionableWarningsAdvisory(
	report: ActionableWarningsReport,
	cwd: string,
	host: LensToolHost = "pi",
): string | undefined {
	if (report.summary.unsuppressed === 0) return undefined;
	const files = report.files.filter((file) =>
		file.warnings.some((warning) => !warning.suppressed),
	);
	const fileList = files
		.slice(0, 5)
		.map(
			(file) =>
				`  ${file.displayPath}: ${file.warnings.filter((warning) => !warning.suppressed).length}`,
		)
		.join("\n");
	const more =
		files.length > 5 ? `\n  ... and ${files.length - 5} more file(s)` : "";
	const safe =
		report.summary.autoFixEligible > 0
			? ` ${report.summary.autoFixEligible} appear to have conservative preferred quickfixes.`
			: "";
	// #1777: hint and info are style opinions, so say how much of the count is
	// opinion. The line appears only when a quiet tier is actually present —
	// an all-warning turn already says everything in the count above.
	const byTier = report.summary.byTier;
	const quiet = byTier ? byTier.hint + byTier.info : 0;
	const tierLine =
		quiet > 0
			? `${quiet} of those are hint/info tier — style opinions, worth fixing only while you are already in that code.`
			: undefined;
	// #2521: lead with the TOOL route. `lens_diagnostics mode=delta` reads the
	// same cache this advisory describes, so an agent never needs to know the
	// store's layout — which is exactly the knowledge the old hardcoded path
	// got wrong. The resolved file stays as a named fallback for a human
	// reading the transcript, rendered through the one helper that cannot
	// disagree with the writer.
	const reportPath = displayProjectDataPath(
		cwd,
		"cache",
		"actionable-warnings.json",
	);
	return [
		`🟡 Fixable warnings introduced this turn: ${report.summary.unsuppressed}.${safe}`,
		tierLine,
		`Use ${resolveLensToolName("lens_diagnostics", host)} with mode=delta to inspect these warnings.`,
		fileList ? `Files:\n${fileList}${more}` : undefined,
		"If continuing in these files, resolve warnings that are safe and relevant. Do not apply broad refactors unless requested.",
		`Raw report (only if you need the JSON): ${reportPath}`,
	]
		.filter(Boolean)
		.join("\n");
}
