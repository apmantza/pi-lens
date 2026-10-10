/**
 * Diagnostic Aggregation Utilities for pi-lens LSP
 *
 * Provides result-aware racing for multi-client diagnostic collection.
 * Replaces the simple Promise.race + grace window pattern with one that
 * only fires the grace window when a client actually returned diagnostics.
 */

import { isAuxiliary, type LspServerRole } from "./server-traits.js";

/**
 * Per-promise descriptor for role-aware racing.
 *
 * When every LANGUAGE-role promise has settled, auxiliaries receive a bounded
 * `auxGraceMs` before the race finalises. Aux results that arrive within the
 * grace are included; late arrivals are dropped (advisory-only — they are
 * cached by the LSP client and surface on the next edit).
 *
 * `role` is the ONE server-role vocabulary (#1488): the same
 * {@link LspServerRole} union `LSPServerInfo.role` declares, so a caller passes
 * `entry.info.role` straight through and nothing translates between two
 * spellings of one distinction. It was `"primary" | "auxiliary"` here against
 * `"language" | "auxiliary"` there before #1488, bridged by one inline ternary
 * at the `getDiagnostics` descriptor build.
 *
 * Omit `role` (or pass `"language"`) to keep the original behaviour where every
 * promise is waited as a language-role one. When NO descriptor carries
 * `role: "auxiliary"` the aux-grace path is never entered and the call is
 * byte-identical to the legacy signature.
 */
export interface PromiseDescriptor {
	role?: LspServerRole;
	/**
	 * Declared wait budget for THIS promise. Only consulted for `role:
	 * "auxiliary"` entries. When at least one still-pending auxiliary carries a
	 * `budgetMs`, the aux-grace window is `min(options.auxGraceMs ?? 500,
	 * max(budgetMs of still-pending auxiliaries))` — the same "declared budget,
	 * capped by a global ceiling" shape `touchFile`'s per-server aux wait uses
	 * (#1458 S2), so a fast auxiliary's short budget can't be stretched to the
	 * ceiling and a slow one isn't cut short of its own declared need (up to
	 * the ceiling). Omit to keep the flat `options.auxGraceMs` window for every
	 * auxiliary — the original, still-supported behavior.
	 */
	budgetMs?: number;
}

/**
 * Race a set of promises to completion, resolving as soon as the
 * `shouldComplete` predicate is satisfied by the accumulated results.
 *
 * Key difference from Promise.race: Promise.race resolves when ANY promise
 * settles (even with an empty/useless result). raceToCompletion only resolves
 * early when results meet a quality threshold, optionally with a grace window
 * to let more results accumulate.
 *
 * @param promises - Array of promises producing results
 * @param shouldComplete - Called after each settled promise with all results
 *   accumulated so far. Return true to trigger early completion.
 * @param options.timeoutMs - Hard deadline; after this, resolve with whatever is ready
 * @param options.graceMs - After shouldComplete returns true, wait this many ms
 *   for additional results before finalizing. 0 = finalize immediately.
 * @param options.descriptors - Optional per-promise role descriptors (parallel array
 *   to `promises`). When any descriptor carries `role:"auxiliary"`, an
 *   additional policy applies: once every language-role promise settles,
 *   auxiliaries receive `options.auxGraceMs` before the race finalises. Aux
 *   results within that window are included; later arrivals are dropped. When
 *   no descriptors carry `role:"auxiliary"` the aux-grace path is never
 *   entered.
 * @param options.auxGraceMs - Ceiling on the grace period given to auxiliary
 *   promises after every language-role promise has settled. Only relevant when
 *   at least one descriptor carries `role:"auxiliary"`. Defaults to 500ms. When a
 *   still-pending auxiliary's descriptor carries `budgetMs`, the actual window
 *   is `min(auxGraceMs, max(budgetMs of still-pending auxiliaries))` — see
 *   `PromiseDescriptor.budgetMs`.
 */
export async function raceToCompletion<T>(
	promises: Promise<T>[],
	shouldComplete: (results: T[]) => boolean,
	options: {
		timeoutMs: number;
		graceMs?: number;
		descriptors?: PromiseDescriptor[];
		auxGraceMs?: number;
	} = { timeoutMs: 1500 },
): Promise<T[]> {
	const results: (T | undefined)[] = [];
	results.length = promises.length;
	results.fill(undefined);
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let auxGraceTimer: ReturnType<typeof setTimeout> | undefined;
	let completed = false;
	let remaining = promises.length;

	// Determine which indices are "auxiliary" — only meaningful when at least
	// one descriptor carries role:"auxiliary". When there are no auxiliaries the
	// aux-grace code path is never entered (zero overhead on the language-only
	// hot path).
	const descriptors = options.descriptors ?? [];
	const hasAuxiliaries = descriptors.some((d) => isAuxiliary(d));
	const auxIndices = hasAuxiliaries
		? new Set(
				descriptors
					.map((d, i) => (isAuxiliary(d) ? i : -1))
					.filter((i) => i >= 0),
			)
		: new Set<number>();
	const languageCount = promises.length - auxIndices.size;

	// Track how many LANGUAGE-role promises are still pending. When this reaches
	// 0 we start the aux-grace window (if there are auxiliaries).
	let languageRemaining = languageCount;
	let auxGraceStarted = false;

	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			completed = true;
			if (graceTimer) clearTimeout(graceTimer);
			if (auxGraceTimer) clearTimeout(auxGraceTimer);
			resolve(results.filter((r): r is T => r !== undefined));
		}, options.timeoutMs);

		const finalize = () => {
			if (completed) return;
			completed = true;
			clearTimeout(timeout);
			if (graceTimer) clearTimeout(graceTimer);
			if (auxGraceTimer) clearTimeout(auxGraceTimer);
			resolve(results.filter((r): r is T => r !== undefined));
		};

		const startAuxGrace = () => {
			if (auxGraceStarted || completed) return;
			auxGraceStarted = true;
			const ceilingMs = options.auxGraceMs ?? 500;
			// #1458 S2: cap the grace window by the still-pending auxiliaries' own
			// declared budgets, not just the flat ceiling — mirrors touchFile's
			// per-server `min(declared, ceiling)`.
			//
			// This is ONE shared timer, not a deadline per promise, so it grants
			// every pending auxiliary the window of its slowest pending sibling.
			// That is safe here only because of an invariant the caller upholds,
			// not because of anything this function enforces: every promise
			// `getDiagnostics` passes in is already self-bounded by the same
			// `strategy.aggregateWaitMs` it declares as `budgetMs`, so a fast
			// auxiliary resolves on its own deadline long before a slow sibling's
			// window expires. A caller that passes a promise NOT self-bounded by
			// its descriptor's `budgetMs` — or one that outlives it, the way
			// `expectSemanticSecondPush` extends a language-role promise — would
			// get a window wider than it declared. `PromiseDescriptor` is public,
			// so treat that as a real constraint on new callers rather than a
			// theoretical one.
			const pendingAuxBudgets = [...auxIndices]
				.filter((i) => results[i] === undefined)
				.map((i) => descriptors[i]?.budgetMs)
				.filter((b): b is number => typeof b === "number" && b >= 0);
			const graceMs =
				pendingAuxBudgets.length > 0
					? Math.min(ceilingMs, Math.max(...pendingAuxBudgets))
					: ceilingMs;
			if (graceMs <= 0) {
				finalize();
				return;
			}
			auxGraceTimer = setTimeout(() => finalize(), graceMs);
		};

		const check = () => {
			if (completed) return;

			if (remaining === 0) {
				finalize();
				return;
			}

			// Aux-grace: start the aux window when every language-role promise has
			// settled. This runs regardless of the shouldComplete predicate — even
			// when shouldComplete hasn't fired, we don't want slow auxiliaries to
			// block past the language-settled moment.
			if (hasAuxiliaries && languageRemaining === 0 && !auxGraceStarted) {
				startAuxGrace();
				// Don't return — also check shouldComplete in case it triggers its
				// own grace window simultaneously (the first finalize() wins).
			}

			const collected = results.filter((r): r is T => r !== undefined);
			if (shouldComplete(collected)) {
				if (
					options.graceMs !== undefined &&
					options.graceMs > 0 &&
					!graceTimer
				) {
					// Start quality-grace window — more results may arrive.
					// (When aux-grace is also running the first finalize() wins.)
					graceTimer = setTimeout(() => finalize(), options.graceMs);
				} else if (auxGraceStarted) {
					// Aux grace is already running — let it conclude naturally.
					// The first finalize() wins.
				} else if (!hasAuxiliaries || languageRemaining === 0) {
					// No aux-grace scenario, OR every language-role promise has
					// already settled (aux-grace either fired or isn't relevant) —
					// finalize now.
					finalize();
				}
				// Otherwise: auxiliaries exist, the language-role promises have not
				// all settled yet, and no quality-grace window is running. Don't
				// finalize — wait for them to settle and let the aux-grace path take
				// over. This preserves the invariant that a language server's
				// confirmation is never reported from a state where it has not
				// answered (#617/#619).
			}
		};

		for (let i = 0; i < promises.length; i++) {
			const index = i;
			const isAux = auxIndices.has(index);
			promises[i]
				.then((result) => {
					if (!completed) {
						results[index] = result;
						remaining--;
						if (!isAux) languageRemaining--;
						check();
					}
				})
				.catch(() => {
					if (!completed) {
						remaining--;
						if (!isAux) languageRemaining--;
						check();
					}
				});
		}
	});
}
