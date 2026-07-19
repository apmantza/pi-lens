/**
 * Diagnostic Aggregation Utilities for pi-lens LSP
 *
 * Provides result-aware racing for multi-client diagnostic collection.
 * Replaces the simple Promise.race + grace window pattern with one that
 * only fires the grace window when a client actually returned diagnostics.
 */

/**
 * Per-promise descriptor for role-aware racing.
 *
 * When all promises in the "primary" role have settled, auxiliaries receive a
 * bounded `auxGraceMs` before the race finalises. Aux results that arrive
 * within the grace are included; late arrivals are dropped (advisory-only —
 * they are cached by the LSP client and surface on the next edit).
 *
 * Omit `role` (or pass `"primary"`) to keep the original behaviour where
 * every promise is treated as primary. When NO descriptor carries
 * `role:"auxiliary"` the aux-grace path is never entered and the call is
 * byte-identical to the legacy signature.
 */
export interface PromiseDescriptor {
	role?: "primary" | "auxiliary";
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
 *   additional policy applies: once all PRIMARY-role promises settle, auxiliaries
 *   receive `options.auxGraceMs` before the race finalises. Aux results within
 *   that window are included; later arrivals are dropped. When no descriptors
 *   carry `role:"auxiliary"` the aux-grace path is never entered.
 * @param options.auxGraceMs - Grace period given to auxiliary promises after all
 *   primary promises have settled. Only relevant when at least one descriptor
 *   carries `role:"auxiliary"`. Defaults to 500ms.
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
	const results: (T | undefined)[] = new Array(promises.length).fill(undefined);
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let auxGraceTimer: ReturnType<typeof setTimeout> | undefined;
	let completed = false;
	let remaining = promises.length;

	// Determine which indices are "auxiliary" — only meaningful when at least
	// one descriptor carries role:"auxiliary". When there are no auxiliaries the
	// aux-grace code path is never entered (zero overhead on the primary-only
	// hot path).
	const descriptors = options.descriptors ?? [];
	const hasAuxiliaries = descriptors.some((d) => d.role === "auxiliary");
	const auxIndices = hasAuxiliaries
		? new Set(
				descriptors
					.map((d, i) => (d.role === "auxiliary" ? i : -1))
					.filter((i) => i >= 0),
			)
		: new Set<number>();
	const primaryCount = promises.length - auxIndices.size;

	// Track how many PRIMARY promises are still pending. When this reaches 0
	// we start the aux-grace window (if there are auxiliaries).
	let primaryRemaining = primaryCount;
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
			const graceMs = options.auxGraceMs ?? 500;
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

			// Aux-grace: start the aux window when all primaries have settled.
			// This runs regardless of the shouldComplete predicate — even when
			// shouldComplete hasn't fired, we don't want slow auxiliaries to block
			// past the primary-settled moment.
			if (hasAuxiliaries && primaryRemaining === 0 && !auxGraceStarted) {
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
				} else if (!hasAuxiliaries || primaryRemaining === 0) {
					// No aux-grace scenario, OR all primaries have already settled
					// (aux-grace either fired or isn't relevant) — finalize now.
					finalize();
				}
				// Otherwise: auxiliaries exist, primaries haven't all settled yet,
				// and no quality-grace window is running. Don't finalize — wait for
				// primaries to settle and let the aux-grace path take over. This
				// preserves the invariant that primary confirmation is never reported
				// from a state where the primary hasn't answered (#617/#619).
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
						if (!isAux) primaryRemaining--;
						check();
					}
				})
				.catch(() => {
					if (!completed) {
						remaining--;
						if (!isAux) primaryRemaining--;
						check();
					}
				});
		}
	});
}
