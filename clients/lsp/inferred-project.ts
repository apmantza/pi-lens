/**
 * #1640: honest rendering for TypeScript diagnostics on files that belong to no
 * tsconfig project.
 *
 * When a file matches no project's `include`/`files`, tsserver still checks it —
 * in a synthetic INFERRED project with default compiler options, no `types`
 * from the project's `tsconfig`, and different module resolution. The project's
 * own `tsc --noEmit` never looks at those files, so the two answers legitimately
 * disagree. Presenting the inferred answer at full blocking authority tells the
 * agent that a gate failed when no gate ever ran.
 *
 * The fix is DEMOTE-WITH-LABEL, never suppress. The live #1640 triage found the
 * inferred-project batch was a MIX: some diagnostics were provably phantom
 * (missing test-runner globals, module resolution), and others were genuine type
 * errors the project's `tsc` gate cannot see precisely BECAUSE the files sit
 * outside every project. Suppression would hide the real ones. Blocking would
 * overstate confidence in the phantom ones. Demoting to warning and naming the
 * config gap preserves the signal and hands the verification burden to the
 * person who can close it.
 *
 * Every "we do not know" path leaves the diagnostics untouched. An unanswered
 * `projectInfo` probe is not a verdict (AGENTS.md shape 10).
 */

import * as path from "node:path";
import type { LSPDiagnostic } from "./client.js";
import {
	fetchTsserverProjectIdentity,
	type TsserverProjectIdentity,
	type TsserverSyncCapableService,
} from "./tsserver-sync.js";
import { isJstsFactFile } from "../file-kinds.js";
import { toProjectRelativePath } from "../path-utils.js";
import {
	demoteEnvironmentGapDiagnostics,
	isTypeScriptSourcedDiagnostic,
} from "./environment-gap.js";
import { logLatency } from "../latency-logger.js";

/**
 * The stable, greppable half of the label. Tests and renderers match on this;
 * the actionable `add <glob>` half varies per file.
 *
 * Sibling of `STALE_LINE_MARKER` (`clients/runtime-turn.ts`) — same idea: a
 * finding that survives at reduced authority says so in its own text, so no
 * downstream renderer has to be taught about the demotion separately.
 */
export const INFERRED_PROJECT_MARKER =
	"not in any tsconfig project — checked with inferred settings";

/** Extensions tsserver owns: the JS/TS source family (`isJstsFactFile`). A file outside it never reaches the probe. */
export function isTsProjectFile(filePath: string): boolean {
	return isJstsFactFile(filePath);
}

/**
 * The glob the user should add to a tsconfig `include`. A file at
 * `tests/unit/a.test.ts` yields `tests/**` — the top-level directory is what a
 * person actually adds, and it is what the #1640 report itself asked for. A
 * file sitting directly in the project root yields its own relative path, since
 * there is no containing directory to name.
 */
export function suggestTsconfigInclude(filePath: string, cwd: string): string {
	const relative = toProjectRelativePath(filePath, cwd);
	if (path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
		// Outside the project root: name the file's own directory instead of
		// inventing a root-relative glob that would not match anything.
		const dir = relative.slice(0, relative.lastIndexOf("/"));
		return dir ? `${dir}/**` : relative;
	}
	const segments = relative.split("/").filter(Boolean);
	return segments.length > 1 ? `${segments[0]}/**` : relative;
}

/** The full label appended to a demoted diagnostic's message. */
export function inferredProjectNotice(filePath: string, cwd: string): string {
	return `[${INFERRED_PROJECT_MARKER}; add ${suggestTsconfigInclude(filePath, cwd)} to a tsconfig for authoritative checking]`;
}

/**
 * Pure transform: demote every TypeScript-sourced ERROR to a warning and append
 * the label. Warnings, hints, and auxiliary-sourced findings are returned
 * untouched — they were never blockers, so relabelling them would be noise.
 *
 * Returns the SAME array reference when nothing changed, so callers can cheaply
 * skip rebuilding their result objects.
 */
export function applyInferredProjectDemotion(
	diagnostics: LSPDiagnostic[],
	filePath: string,
	cwd: string,
): LSPDiagnostic[] {
	if (!diagnostics.some(isDemotableDiagnostic)) return diagnostics;
	const notice = inferredProjectNotice(filePath, cwd);
	return diagnostics.map((d) =>
		isDemotableDiagnostic(d)
			? { ...d, severity: 2 as const, message: `${d.message} ${notice}` }
			: d,
	);
}

function isDemotableDiagnostic(d: LSPDiagnostic): boolean {
	return d.severity === 1 && isTypeScriptSourcedDiagnostic(d);
}

/**
 * Whether the membership verdict could change any of these rows: a file
 * tsserver owns, carrying a TypeScript-sourced error. The probe's own
 * precondition, so a caller that sends the probe itself (the warm incumbent,
 * #4645) asks exactly when this module would.
 */
export function hasInferredProjectCandidates(
	diagnostics: LSPDiagnostic[],
	filePath: string,
): boolean {
	return isTsProjectFile(filePath) && diagnostics.some(isDemotableDiagnostic);
}

export interface InferredProjectDemotionOptions {
	filePath: string;
	cwd: string;
	/**
	 * The service the probe asks. Omitted: no probe is sent, and only an answer
	 * already in `identityCache` applies (#4645: a warm-attached reader seeds it
	 * with the incumbent's own answer, since asking here would spawn).
	 */
	service?: TsserverSyncCapableService;
	/**
	 * Per-call-batch memo so one sweep probes each file once. Deliberately
	 * caller-owned and short-lived: a module-level cache would pin turn one's
	 * verdict for the life of the process, and a tsconfig edit is exactly the
	 * thing that changes the answer (AGENTS.md process-lifetime-latch screen).
	 */
	identityCache?: Map<string, TsserverProjectIdentity | undefined>;
	/**
	 * The caller's own abort signal. An already-aborted caller gets no probe:
	 * the sweep that produced these diagnostics is signal-bounded, so a
	 * post-abort probe would spend budget nobody is waiting for.
	 */
	signal?: AbortSignal;
	/** Test seam: override the probe. */
	fetchIdentity?: typeof fetchTsserverProjectIdentity;
}

/**
 * Probe project membership for `filePath` and demote its diagnostics when
 * tsserver answers "inferred project".
 *
 * Short-circuits BEFORE any probe when there is nothing a demotion could change:
 * a non-TypeScript file, or a diagnostic list with no TypeScript-sourced error
 * in it. So a clean sweep pays nothing, and a sweep over 500 clean files issues
 * zero extra requests.
 */
export async function demoteInferredProjectDiagnostics(
	diagnostics: LSPDiagnostic[],
	options: InferredProjectDemotionOptions,
): Promise<LSPDiagnostic[]> {
	const { filePath, cwd, service } = options;
	if (!hasInferredProjectCandidates(diagnostics, filePath)) return diagnostics;
	if (options.signal?.aborted) return diagnostics;

	const fetchIdentity = options.fetchIdentity ?? fetchTsserverProjectIdentity;
	const cache = options.identityCache;
	let identity: TsserverProjectIdentity | undefined;
	if (cache?.has(filePath)) {
		identity = cache.get(filePath);
	} else if (service === undefined) {
		return diagnostics;
	} else {
		identity = await fetchIdentity(service, filePath);
		cache?.set(filePath, identity);
	}

	// `undefined` (probe unavailable/failed) and "unassociated" (tsserver named
	// no project at all) are both UNKNOWN, not "inferred". Demoting on either
	// would downgrade real blockers on any server that does not speak the
	// tsserverRequest escape hatch.
	if (identity?.projectKind !== "inferred") return diagnostics;
	return applyInferredProjectDemotion(diagnostics, filePath, cwd);
}

/**
 * The ONE demotion pipeline for a TypeScript server's raw rows (#4532 round 5,
 * review F3; AGENTS.md shape 71, one signal wired consumer by consumer). The
 * environment-gap rule (`environment-gap.ts`, a bounded walk of `stat` calls,
 * no server request) runs first, so the membership probe, which only looks at
 * severity-1 rows, pays nothing for a row it already demoted. The per-edit
 * runner and every `lsp_diagnostics` route call this; the `mode=full` sweep
 * runs the same two rules in `demoteInferredProjectSweepResults`, and the
 * cascade's synchronous seams run the environment rule alone (they have no
 * membership probe; see `applyCascadeDisplayPolicy` and
 * `cascadeReconcilableLspErrors`). Every writer of the widget store routes its
 * rows through it, so an orphan file never blocks or not depending on which
 * tool ran last (#1645 review F3, the #1633-V1 lesson).
 *
 * `service` omitted skips the membership probe and keeps the environment rule:
 * a warm-attached session's rows came from a remote fleet this process does
 * not own, so the probe would have to spawn one to answer (#1645 review F2).
 * The incumbent that owns that fleet asks instead and sends its answer beside
 * the raw rows; the reader seeds `identityCache` with it, so both outputs below
 * are what a local read of the same rows gives (#4645).
 *
 * `rows` is what a consumer renders. `replayable()` is what a cache entry
 * stores, and the two rules differ in what a replay can re-derive (#4532
 * round 6, r5 verify NEW-1, shape 6). The environment verdict depends on the
 * install state, which no entry key carries, so it is never baked in: the
 * replay re-runs it (review F5). The membership verdict needs a live tsserver,
 * which a replay often lacks (a new session reading the on-disk cache, an
 * evicted server), so it IS baked in: an unknown answer on the replay must not
 * undo a known one from the serve. `replayable()` is therefore the membership
 * rule over the RAW rows. When the environment rule changed nothing that is
 * `rows` itself; otherwise it is one more membership pass sharing the identity
 * memo, which sends a probe only when every severity-1 row was an environment
 * gap. It is lazy, so a consumer that caches nothing pays nothing.
 *
 * Both outputs are index-aligned with the input, one entry per row, in order,
 * and `rows` is the SAME array when nothing changed.
 */
export interface LanguageServerRowDemotion {
	rows: LSPDiagnostic[];
	replayable(): Promise<LSPDiagnostic[]>;
}

export async function demoteLanguageServerRows(
	diagnostics: LSPDiagnostic[],
	options: InferredProjectDemotionOptions,
): Promise<LanguageServerRowDemotion> {
	const environmentChecked = demoteEnvironmentGapDiagnostics(diagnostics, {
		filePath: options.filePath,
	});
	const membership = {
		...options,
		identityCache: options.identityCache ?? new Map(),
	};
	const rows = await demoteInferredProjectDiagnostics(
		environmentChecked,
		membership,
	);
	return {
		rows,
		replayable: async () =>
			environmentChecked === diagnostics
				? rows
				: demoteInferredProjectDiagnostics(diagnostics, membership),
	};
}

/**
 * Cap on how many `projectInfo` probes one sweep may issue. Only files that
 * actually carry a TypeScript error probe at all, so on a healthy project this
 * is never approached. Past the cap, membership stays UNKNOWN and nothing is
 * demoted — the fail-safe direction is the pre-#1640 behavior, not a silent
 * mass demotion.
 */
export const INFERRED_PROJECT_PROBE_BUDGET = 300;

/**
 * Sweep-wide entry point: the two rules of `demoteLanguageServerRows` over a
 * sweep's results. The environment-gap rule runs on every result; the
 * membership probe demotes every result whose file tsserver owns only through
 * an inferred project. Sequential on purpose — the probes run against a
 * single-threaded tsserver, so fanning out would only queue behind itself.
 *
 * The identity memo is local to this call. A module-level cache would pin the
 * first sweep's verdict for the life of the process, and editing a tsconfig is
 * precisely what changes the answer.
 *
 * The loop honors the caller's abort signal between files. The sweep that
 * produced these results is itself signal-bounded, so continuing to probe after
 * an abort would spend budget on an answer nobody will read (#1645 review F1).
 */
export async function demoteInferredProjectSweepResults<
	T extends { filePath: string; diagnostics?: LSPDiagnostic[] },
>(
	results: T[],
	cwd: string,
	service: TsserverSyncCapableService,
	signal?: AbortSignal,
): Promise<T[]> {
	const startedAt = Date.now();
	const identityCache = new Map<string, TsserverProjectIdentity | undefined>();
	const out: T[] = [];
	let changed = false;
	let demotedFiles = 0;
	let demotedDiagnostics = 0;
	let budgetExhausted = false;
	let aborted = false;
	for (const result of results) {
		// #4532 round 5 (review F3): the environment rule of
		// `demoteLanguageServerRows` asks no server, so it runs on EVERY result,
		// the aborted and over-budget ones included; only the probe is skipped.
		const raw = result.diagnostics ?? [];
		const diagnostics = demoteEnvironmentGapDiagnostics(raw, {
			filePath: result.filePath,
		});
		const checked = diagnostics === raw ? result : { ...result, diagnostics };
		if (checked !== result) changed = true;
		if (signal?.aborted) {
			// Carry the remaining results through UNCHANGED rather than dropping
			// them — an abort must cost the demotion, never a finding.
			aborted = true;
			out.push(checked);
			continue;
		}
		if (
			identityCache.size >= INFERRED_PROJECT_PROBE_BUDGET &&
			!identityCache.has(result.filePath)
		) {
			budgetExhausted = true;
			out.push(checked);
			continue;
		}
		const demoted = await demoteInferredProjectDiagnostics(diagnostics, {
			filePath: result.filePath,
			cwd,
			service,
			identityCache,
			signal,
		});
		if (demoted === diagnostics) {
			out.push(checked);
			continue;
		}
		changed = true;
		demotedFiles += 1;
		demotedDiagnostics += demoted.filter((d, i) => d !== diagnostics[i]).length;
		out.push({ ...result, diagnostics: demoted });
	}
	if (demotedFiles > 0 || budgetExhausted || aborted) {
		logLatency({
			type: "phase",
			phase: "lsp_inferred_project_demote",
			filePath: cwd,
			durationMs: Date.now() - startedAt,
			metadata: {
				filesConsidered: results.length,
				filesProbed: identityCache.size,
				demotedFiles,
				demotedDiagnostics,
				budgetExhausted,
				aborted,
			},
		});
	}
	// The SAME array when no result changed, as the per-file transforms return.
	return changed ? out : results;
}
