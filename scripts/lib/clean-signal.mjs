// Pure classifier for the clean-signal probe (scripts/probe-clean-signal.mjs).
//
// Splits a PUSH-mode LSP server's clean-scan behavior along TWO axes that must
// not be collapsed (#460 review):
//   - LATENCY axis (does the wait early-return?): pi-lens's publishDiagnostics
//     handler (clients/lsp/client.ts) bumps its INTERNAL diagnosticsVersion and
//     emits on EVERY publish — versioned or not — and waitForDiagnostics
//     early-returns on that emit. So ANY publish on a clean transition resolves
//     the wait; only true SILENCE is budget-bound (the #458 learned-deadline
//     target set).
//   - CURRENCY-PROOF axis (can the publish be tied to the live edit?): the
//     LSP-reported doc version (diagnosticDocVersions) is used only to REJECT
//     provably-lagging results; a version-less publish cannot be proven stale,
//     so it is ACCEPTED as fresh. Version-less publishes therefore early-return
//     fine but carry a weaker staleness guarantee (temporal correlation, not
//     proof) — a staleness-RISK note, not a latency cost.
//
// Hence the 4-way, PHASE-AWARE classification (the dirty touch proves liveness;
// the clean-transition touches are the discriminator):
//   - publishes-versioned   (tier 2 ): publishes WITH version on clean
//     transitions — affirmative + currency-proven (ast-grep).
//   - publishes-unversioned (tier 2*): publishes version-lessly on clean
//     transitions — early-returns the wait at runtime, currency only temporally
//     correlated (opengrep).
//   - silent                (tier 3 ): demonstrably alive (published on dirty)
//     but demonstrably silent on clean transitions — the budget-wait case and
//     the #458 target.
//   - unknown               (tier — ): no publish at all (slow/absent —
//     conservatively not classified).
//
// Kept as a side-effect-free function so it can be unit-tested without spawning
// a server (see tests/scripts/clean-signal.test.ts). #240/#460.

/**
 * @typedef {Object} CleanSignalObservations
 * @property {number} [dirtyPublishes]           publishes during the dirty touch
 *   (cold spawn + first analysis) — proves the server is live
 * @property {number} [dirtyVersioned]           of those, how many carried a version
 * @property {number} [cleanTransitionPublishes] publishes during the clean
 *   transitions (dirty→clean and/or clean→clean touches) — the discriminator
 * @property {number} [cleanTransitionVersioned] of those, how many carried a version
 */

/**
 * Classify a push-mode server's clean-signal behavior from phase-aware publish
 * observations.
 *
 * Conservative by design: `unknown` beats a guess. A server that never published
 * at all is `unknown`, NOT silently downgraded to Tier 3 — a slow/absent server
 * must not be mislabeled as a measured-silent one.
 *
 * @param {CleanSignalObservations} obs
 * @returns {{ behavior: "publishes-versioned" | "publishes-unversioned" | "silent" | "unknown", tier: 2 | 3 | 0, tierLabel: "2" | "2*" | "3" | "", reason: string }}
 */
export function classifyCleanBehavior(obs) {
  const dirtyPublishes = Number(obs?.dirtyPublishes ?? 0);
  const cleanPublishes = Number(obs?.cleanTransitionPublishes ?? 0);
  const cleanVersioned = Number(obs?.cleanTransitionVersioned ?? 0);

  // Published on a clean transition WITH a version → affirmative clean signal,
  // currency-proven (correlatable to the live document version).
  if (cleanPublishes > 0 && cleanVersioned > 0) {
    return {
      behavior: "publishes-versioned",
      tier: 2,
      tierLabel: "2",
      reason: `published ${cleanVersioned}/${cleanPublishes} versioned set(s) on clean transitions — affirmative + currency-proven`,
    };
  }

  // Published on a clean transition but version-lessly → the wait still
  // early-returns at runtime (the client accepts a version-less publish as
  // fresh because it cannot be proven stale), but currency is only temporally
  // correlated — a staleness-risk caveat, NOT a latency cost.
  if (cleanPublishes > 0) {
    return {
      behavior: "publishes-unversioned",
      tier: 2,
      tierLabel: "2*",
      reason: `published ${cleanPublishes} version-less set(s) on clean transitions — early-returns the wait; currency only temporally correlated`,
    };
  }

  // Demonstrably alive (published on the dirty touch) but demonstrably silent
  // on clean transitions → the budget-wait case (#458's learned-deadline target).
  if (dirtyPublishes > 0) {
    return {
      behavior: "silent",
      tier: 3,
      tierLabel: "3",
      reason: `alive (${dirtyPublishes} dirty publish(es)) but silent on clean transitions — budget-wait bound`,
    };
  }

  // Never saw the server publish anything → can't tell silent from slow/absent.
  return {
    behavior: "unknown",
    tier: 0,
    tierLabel: "",
    reason: "no publish observed (server slow/absent — not classifiable)",
  };
}

// ---------------------------------------------------------------------------
// Drift check (#529): compare an OBSERVED clean-behavior classification against
// the hand-set `silentOnClean` marker in clients/lsp/server-strategies.ts. The
// marker is a manually-measured fact frozen in source; the probe re-measures it
// nightly. A mismatch means either the marker is stale (a server update changed
// its clean-scan behavior) or the marker was never set for a server that turns
// out to be silent (the pre-#458 tsserver situation — cascade burns timeouts on
// it unnecessarily). This is a REPORTING function only — the nightly wiring
// (#529) is explicit that this is never a CI gate: a probe's `unknown` result
// must never be treated as evidence of anything, so it never drifts (only
// `silent` vs a `publishes-*` result is comparable to the boolean marker).
//
// Pure (no fs/process access) so it's unit-testable without importing dist's
// compiled server-strategies module.

/**
 * @typedef {Object} DriftInput
 * @property {string} lang            fixture/matrix key, e.g. "typescript"
 * @property {string} behavior        classifyCleanBehavior(...).behavior for this row
 */

/**
 * @typedef {Object} DriftResult
 * @property {string} lang
 * @property {"silent-not-marked" | "marked-not-silent" | "consistent" | "not-comparable"} kind
 * @property {string} detail
 */

/**
 * Compare one observed row against its strategy's `silentOnClean` marker.
 *
 * Only `silent` and the two `publishes-*` behaviors are comparable — `unknown`
 * (never observed to publish at all — could be slow, not silent) is NEVER
 * treated as drift evidence in either direction (the #240 doctrine applied to
 * this check itself, per #529).
 *
 * @param {DriftInput} row
 * @param {boolean | undefined} silentOnClean  the strategy table's marker for this server (undefined = not set)
 * @returns {DriftResult}
 */
export function checkCleanSignalDrift(row, silentOnClean) {
  const { lang, behavior } = row;
  if (
    behavior !== "silent" &&
    behavior !== "publishes-versioned" &&
    behavior !== "publishes-unversioned"
  ) {
    return {
      lang,
      kind: "not-comparable",
      detail: `observed=${behavior} — not a comparable classification (never collapsed into silent/not-silent)`,
    };
  }
  const observedSilent = behavior === "silent";
  const marked = Boolean(silentOnClean);
  if (observedSilent && !marked) {
    return {
      lang,
      kind: "silent-not-marked",
      detail: `observed silent on clean transitions but server-strategies.ts has no silentOnClean marker for "${lang}" — cascade is burning the full in-lane wait it could skip (the pre-#458 situation)`,
    };
  }
  if (!observedSilent && marked) {
    return {
      lang,
      kind: "marked-not-silent",
      detail: `server-strategies.ts marks "${lang}" silentOnClean:true but this run observed ${behavior} — the marker may be stale (too pessimistic; cascade is skipping a wait the server would have resolved with a real publish)`,
    };
  }
  return {
    lang,
    kind: "consistent",
    detail: `observed=${behavior}, silentOnClean=${marked} — consistent`,
  };
}

/**
 * Run the drift check over every measured row (already resolved to matrix
 * `targetLang` — the clean-fixture-wins step done upstream) against a
 * lang→silentOnClean lookup. Returns only the two drift kinds (never
 * "consistent"/"not-comparable" — callers want the warnings list).
 *
 * @param {DriftInput[]} rows
 * @param {(lang: string) => boolean | undefined} lookupSilentOnClean
 * @returns {DriftResult[]}
 */
export function findCleanSignalDrift(rows, lookupSilentOnClean) {
  const warnings = [];
  for (const row of rows) {
    const result = checkCleanSignalDrift(row, lookupSilentOnClean(row.lang));
    if (result.kind === "silent-not-marked" || result.kind === "marked-not-silent") {
      warnings.push(result);
    }
  }
  return warnings;
}
