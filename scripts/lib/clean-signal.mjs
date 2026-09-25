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

import * as os from "node:os";
import * as path from "node:path";

// #594: the fixed path probe-clean-signal.mjs (writer) and
// notify-clean-signal-drift.mjs (reader) agree on for the machine-readable
// driftWarnings summary — same-job runner tmpdir, never committed to the repo,
// never expected to survive across job boundaries (each nightly run is a fresh
// runner). Living here (not a literal in each script) keeps the two scripts
// from silently drifting onto different paths.
export const DRIFT_SUMMARY_PATH = path.join(
	os.tmpdir(),
	"pilens-clean-signal-drift-summary.json",
);

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

/**
 * Keep a phase trace scoped to the server whose row is being measured. The
 * extension log is shared by every live LSP client in the process.
 */
function filterPublishTrace(publishes, serverId) {
	return (publishes ?? []).filter((publish) => publish?.server === serverId);
}

const PUB_MESSAGE_RE =
	/^server=(\S+) pubVersion=(\S+) docVersion=(\S+) diags=(\d+)/;

/**
 * Build the append-only sink drainer used by probe-clean-signal. The readLog
 * seam keeps the production offset/parser/filter path testable with a bounded
 * fixture while the probe still supplies the real extension.log reader.
 */
export function createPublishTraceDrainer({ readLog, echoTrace = false }) {
	let offset = 0;
	function drainPublishTrace(sink, serverId) {
		const { size, read } = readLog(offset);
		if (size < offset) offset = 0;
		if (size === offset) return;
		const result = read(offset);
		if (!result) return;
		const { chunk, bytesRead } = result;
		offset += bytesRead;
		const lastNewline = chunk.lastIndexOf("\n");
		if (lastNewline < 0) {
			offset -= Buffer.byteLength(chunk, "utf8");
			return;
		}
		const consumed = chunk.slice(0, lastNewline + 1);
		offset -= Buffer.byteLength(chunk.slice(lastNewline + 1), "utf8");
		const publishes = [];
		for (const line of consumed.split("\n")) {
			if (!line.trim()) continue;
			let row;
			try {
				row = JSON.parse(line);
			} catch {
				continue;
			}
			if (row?.subsystem !== "lsp-pub") continue;
			const match = PUB_MESSAGE_RE.exec(String(row.message ?? ""));
			if (!match) continue;
			if (echoTrace) console.error(`[lsp-pub] ${row.message}`);
			publishes.push({
				server: match[1],
				pubVersion: match[2],
				diags: Number(match[4]),
				versioned: match[2] !== "undefined",
			});
		}
		sink.push(...filterPublishTrace(publishes, serverId));
	}
	drainPublishTrace.reset = (nextOffset) => {
		offset = nextOffset;
	};
	return drainPublishTrace;
}

// ---------------------------------------------------------------------------
// Drift check (#529): compare an OBSERVED clean-behavior classification against
// the hand-set `silentOnClean` marker in clients/lsp/wait-policy/strategies.ts. The
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
// compiled wait-policy/strategies module.

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
	if (isDegenerateSilent(row)) {
		return {
			lang,
			kind: "not-comparable",
			detail: `observed=silent on a dirty fixture whose server never published a diagnostic (first-publish=${row.firstPublish ?? "unknown"}) — silence on an undiagnosed file is not evidence the server skips clean publishes (#3444)`,
		};
	}
	const observedSilent = behavior === "silent";
	const marked = Boolean(silentOnClean);
	if (observedSilent && !marked) {
		return {
			lang,
			kind: "silent-not-marked",
			detail: `observed silent on clean transitions but wait-policy/strategies.ts has no silentOnClean marker for "${lang}" — cascade is burning the full in-lane wait it could skip (the pre-#458 situation)`,
		};
	}
	if (!observedSilent && marked) {
		return {
			lang,
			kind: "marked-not-silent",
			detail: `wait-policy/strategies.ts marks "${lang}" silentOnClean:true but this run observed ${behavior} — the marker may be stale (too pessimistic; cascade is skipping a wait the server would have resolved with a real publish)`,
		};
	}
	return {
		lang,
		kind: "consistent",
		detail: `observed=${behavior}, silentOnClean=${marked} — consistent`,
	};
}

/**
 * #3444: a `silent` row is evidence only when the dirty phase proved the server
 * diagnoses this fixture. A dirty fixture whose server never published a
 * non-empty set (`empty-only`/`unknown` on the first-publish axis) made a
 * "clean transition" from nothing to nothing, which proves nothing either way
 * (Sep 25, `ast-grep-baseline`: 1 empty dirty publish, 0 clean). A `clean: true`
 * fixture is exempt: its dirty phase is empty by design and its silence IS the
 * clean→clean measurement.
 *
 * @param {{ behavior: string, firstPublish?: string, cleanFixture?: boolean }} row
 */
export function isDegenerateSilent(row) {
	return (
		row.behavior === "silent" &&
		!row.cleanFixture &&
		DEGENERATE_FIRST_PUBLISH.has(row.firstPublish)
	);
}

// The first-publish classes that say the dirty phase never carried a diagnostic.
// A row with no first-publish field at all (a caller measuring only the clean
// axis) is not judged degenerate: absence of the axis is not evidence.
const DEGENERATE_FIRST_PUBLISH = new Set(["empty-only", "unknown"]);

const DRIFT_BEHAVIOR_RANK = {
	"publishes-versioned": 3,
	"publishes-unversioned": 2,
	silent: 1,
};

/**
 * #3444: `silentOnClean` belongs to a SERVER (the strategy key), and two
 * fixtures can drive the same server (`ast-grep` and `ast-grep-baseline` both
 * run `id: "ast-grep"`). Comparing each fixture against the one marker lets
 * them disagree in the same run, and no marker can satisfy both. So the drift
 * check sees one row per strategy key:
 *
 * - degenerate silent rows ({@link isDegenerateSilent}) are dropped first;
 * - one clean-transition publish from any fixture disproves `silentOnClean`,
 *   so a publishing row outranks a silent one (versioned over version-less);
 * - `silent` survives only when no fixture of that server published on clean.
 *
 * The chosen row carries `lang` = the strategy key and `fixtures` = every
 * fixture lang that fed it. Rows with no comparable behavior pass through
 * untouched (checkCleanSignalDrift reports them not-comparable).
 *
 * @template {{ lang: string, behavior: string, firstPublish?: string, cleanFixture?: boolean }} R
 * @param {R[]} rows
 * @param {(lang: string) => string} [keyOf]
 * @returns {Array<R & { fixtures: string[] }>}
 */
export function aggregateDriftRows(rows, keyOf = strategyKeyForLang) {
	const byKey = new Map();
	for (const row of rows) {
		if (!(row.behavior in DRIFT_BEHAVIOR_RANK) || isDegenerateSilent(row))
			continue;
		const key = keyOf(row.lang);
		const prev = byKey.get(key);
		const fixtures = [...(prev?.fixtures ?? []), row.lang];
		const best =
			!prev ||
			DRIFT_BEHAVIOR_RANK[row.behavior] > DRIFT_BEHAVIOR_RANK[prev.behavior]
				? row
				: prev;
		byKey.set(key, { ...best, lang: key, fixtures });
	}
	return [...byKey.values()];
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
	// #3444: one row per strategy key, degenerate silent rows dropped.
	for (const row of aggregateDriftRows(rows)) {
		const result = checkCleanSignalDrift(row, lookupSilentOnClean(row.lang));
		if (
			result.kind === "silent-not-marked" ||
			result.kind === "marked-not-silent"
		) {
			warnings.push(result);
		}
	}
	return warnings;
}

// ---------------------------------------------------------------------------
// #3310 first-publish class. A SECOND axis of the same dirty-phase trace the
// clean-behavior classifier already collects, and the measurement behind
// `emptyFirstPublish` in clients/lsp/wait-policy/strategies.ts.
//
// The question it answers: for a DIRTY file, is the server's FIRST publish the
// answer, or an empty placeholder it sends while a one-time index builds? Only
// the second shape can turn a file with an error into a "confirmed clean"
// (#3310), and only for that shape may the client hold the publish — a server
// that legitimately publishes `[]` once for a clean file must keep resolving
// the wait on it (the Tier 2/2* rows).
//
// Conservative in the same way as `classifyCleanBehavior`: a server observed
// publishing only empty sets on a dirty fixture is `empty-only`, never guessed
// into either class, because a dirty fixture the server does not diagnose looks
// exactly like an index that never finished.

/**
 * Classify the first-publish shape from the dirty-phase publish trace.
 *
 * @param {Array<{ diags: number }>} dirtyPublishes  publishes observed during the
 *   dirty touch, in arrival order
 * @returns {{ firstPublish: "empty-first" | "direct" | "empty-only" | "unknown", reason: string }}
 */
export function classifyFirstPublish(dirtyPublishes) {
	const publishes = Array.isArray(dirtyPublishes) ? dirtyPublishes : [];
	if (publishes.length === 0) {
		return {
			firstPublish: "unknown",
			reason: "no publish observed on the dirty touch (server slow/absent)",
		};
	}
	const first = Number(publishes[0]?.diags ?? 0);
	if (first > 0) {
		return {
			firstPublish: "direct",
			reason: `first publish carried ${first} diagnostic(s) — the first publish IS the answer`,
		};
	}
	const laterNonEmpty = publishes
		.slice(1)
		.find((publish) => Number(publish?.diags ?? 0) > 0);
	if (laterNonEmpty) {
		return {
			firstPublish: "empty-first",
			reason: `first publish was EMPTY, a later one carried ${Number(laterNonEmpty.diags)} diagnostic(s) — provisional pre-index publish (#3310 class)`,
		};
	}
	return {
		firstPublish: "empty-only",
		reason: `${publishes.length} publish(es), all empty — not classifiable on this axis (an undiagnosed dirty fixture looks the same as an unfinished index)`,
	};
}

/**
 * The matrix `first-publish` values that may be compared against the registry
 * marker at all. `empty-only`/`unknown` are evidence of nothing, in either
 * direction — the #240 doctrine applied to this axis.
 */
export const COMPARABLE_FIRST_PUBLISH = new Set(["empty-first", "direct"]);

/**
 * Fixture `lang` → `SERVER_DIAGNOSTIC_STRATEGIES` key, for the few fixtures
 * whose lang is not the server id (a language-alias fixture). Anything absent
 * falls back to identity, which covers the core set. Shared by
 * scripts/probe-clean-signal.mjs and tests/config/lsp-first-publish-census.test.ts
 * so the probe's drift check and the census can never key differently.
 */
export const LANG_TO_STRATEGY_KEY = {
	jedi: "python-jedi",
	// #3347: the markdown fixture's server id is `marksman` (its `serverHint` in
	// scripts/smoke-tools.mjs, `id: "marksman"` in clients/lsp/server.ts), and that
	// is the key its `silentOnClean: true` marker lives under. Without this entry
	// the lookup misses under `markdown`, so the drift check below reported the
	// MARKED marksman as `silent-not-marked` on every run that reached it, and a
	// census keyed the same way cannot cover that marker in either direction.
	markdown: "marksman",
	// #3444: the no-sgconfig baseline fixture runs the same `id: "ast-grep"`
	// server (`auxiliaryServerIds: ["ast-grep"]` in scripts/smoke-tools.mjs), so
	// its observations belong to the `ast-grep` marker — a marker keyed
	// "ast-grep-baseline" could never reach the runtime's `getStrategy("ast-grep")`.
	"ast-grep-baseline": "ast-grep",
};

/** Resolve a matrix/fixture lang to its strategy-table key. */
export function strategyKeyForLang(lang) {
	return LANG_TO_STRATEGY_KEY[lang] ?? lang;
}
