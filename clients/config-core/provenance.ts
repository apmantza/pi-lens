/**
 * Source tiers, per-leaf provenance, and the redacted provenance projection
 * (#2425; scope items 2 and 3 of #2415).
 *
 * Three config loaders answer "which file won" three different ways today, and
 * none of them can answer "why". This module fixes the vocabulary once: a
 * resolved config carries, for every leaf, the tier that produced it, the file
 * it came from, and the trust decision that applied to that file. #2427's
 * introspection surface reads exactly this, so "why is server X running" stops
 * being a log-forensics question.
 *
 * Two orderings live here, and they are NOT the same ordering:
 *
 * - `SOURCE_TIERS` decides who wins a plain value. Later beats earlier, so a
 *   CLI flag beats a project file beats a global file beats a built-in default.
 * - `TIER_CLASS` decides who may LIFT a deny. `deny.ts` builds monotonic deny
 *   precedence on this split, and nothing else re-derives it.
 *
 * Deliberately free of module state: every export is a pure function over its
 * arguments, so there is no latch here to re-arm at `session_start`.
 */

import { homeRelativePath } from "../path-utils.js";
import type { ProjectTrustState } from "../project-trust.js";

/**
 * Where a configuration value came from. A closed union: a tier becomes public
 * API the moment it appears in a provenance projection, so new members arrive
 * through the stability policy in `docs/public-api-stability.md`.
 */
export const SOURCE_TIERS = [
	"builtin",
	"global",
	"project",
	"nested-project",
	"env",
	"cli",
	"host",
] as const;

export type SourceTier = (typeof SOURCE_TIERS)[number];

export type TierClass = "default" | "operator" | "repo";

/**
 * Who each tier speaks for. THREE classes, not two (#2440 review finding F3).
 *
 * - `repo` — content that arrives with a checkout, which is exactly the content
 *   a user may never have read. `project` and `nested-project`, for the same
 *   reason: both are files inside the checkout.
 * - `operator` — a deliberate act by the person running pi-lens: their global
 *   config, the environment, the command line, the host application. (`host` is
 *   operator content because the host is the thing that decided the project's
 *   trust in the first place.)
 * - `default` — pi-lens's OWN shipped defaults. Nobody chose them.
 *
 * `builtin` was `operator` until this review round, and that conflation had a
 * consequence nobody would have chosen deliberately: because `deny.ts` never
 * lifts an operator denial, a built-in `enabled: false` — or any member pi-lens
 * ships in a built-in deny list — became permanently unliftable BY ANYONE. Not
 * by a project file, which is correct, but also not by the user's own global
 * config, their environment, or an explicit command-line flag. A default the
 * operator cannot override is not a default; it is a hard-coded decision
 * wearing a config field's clothes, and the only escape would have been editing
 * pi-lens's source.
 *
 * Splitting the class fixes it without weakening anything: a `default` denial
 * is liftable by an OPERATOR tier and still unliftable by a `repo` tier, so
 * shipping a conservative default stays safe against repository content while
 * remaining a default to the person who installed the thing.
 */
export const TIER_CLASS: Readonly<Record<SourceTier, TierClass>> = {
	builtin: "default",
	global: "operator",
	project: "repo",
	"nested-project": "repo",
	env: "operator",
	cli: "operator",
	host: "operator",
};

/**
 * The host's trust decision, reused verbatim from `project-trust.ts` rather
 * than re-spelled. pi-lens CONSUMES the host decision (AGENTS.md, "Project
 * trust is CONSUMED, never answered"); a second three-valued type here would be
 * a second place for the vocabulary to drift.
 */
export type TrustDecision = ProjectTrustState;

/**
 * Where one resolved leaf came from.
 *
 * `key` is a JSON-pointer-shaped path into the RESOLVED value
 * (`/lsp/servers/0/command`), so a consumer navigates from a provenance entry
 * to the value it describes without a second lookup convention. It never
 * carries the value itself.
 */
export interface Provenance {
	readonly tier: SourceTier;
	/** The file the value came from, when the source is a file. */
	readonly file?: string;
	/** JSON-pointer-shaped path of the leaf inside the resolved value. */
	readonly key: string;
	/** The trust decision that applied to that source. */
	readonly trust?: TrustDecision;
}

/** A resolved configuration plus the provenance of every leaf inside it. */
export interface Resolved<T> {
	readonly value: T;
	/** Keyed by the same JSON-pointer path each entry's `key` carries. */
	readonly provenance: ReadonlyMap<string, Provenance>;
}

/** Numeric precedence of a tier. Higher wins. */
export function tierPrecedence(tier: SourceTier): number {
	return SOURCE_TIERS.indexOf(tier);
}

/** True for tiers whose content arrives with the checkout. */
export function isRepoTier(tier: SourceTier): boolean {
	return TIER_CLASS[tier] === "repo";
}

/**
 * True for tiers the person running pi-lens set deliberately.
 *
 * NOT the complement of `isRepoTier`: `builtin` is neither. Asking this question
 * with `!isRepoTier(tier)` is the exact bug F3 reported, so the affirmative
 * predicate exists to make the third class impossible to overlook at a call
 * site.
 */
export function isOperatorTier(tier: SourceTier): boolean {
	return TIER_CLASS[tier] === "operator";
}

/** One row of the redacted provenance projection. */
export interface ProvenanceViewEntry {
	readonly key: string;
	readonly tier: SourceTier;
	readonly file?: string;
	readonly trust?: TrustDecision;
}

/** The redacted provenance projection: sources only, never values. */
export interface ProvenanceView {
	readonly entries: readonly ProvenanceViewEntry[];
}

/**
 * Project a resolution to its provenance, sorted by key.
 *
 * Redacted BY CONSTRUCTION, and that is the whole design: the projection is
 * built from the provenance map alone and never reads `resolved.value`, so
 * there is no value here for a later edit to include by accident. An
 * un-redacted view does not exist, because the un-redacted data is the resolved
 * config the caller already holds. #2415 AC 4 asks that the DIAGNOSTIC surface
 * leak nothing, and the way to guarantee that is to make the diagnostic surface
 * structurally incapable of carrying a value.
 *
 * `file` is rewritten home-relative (#2440 review finding F5). A global config
 * path is `$HOME`-anchored by construction, so the un-rewritten projection put
 * the operator's account name into every diagnostic that named it — a value the
 * projection was never asked to carry and the one piece of environment a shared
 * log reliably leaks.
 *
 * `homeDir` is a test seam only, matching `loadLSPConfig`'s: production passes
 * nothing and gets `os.homedir()`. Without it a redaction test can only prove
 * the rewrite against the machine's REAL home, which means either writing
 * fixtures into the operator's home directory or asserting nothing at all
 * (#2427).
 */
export function provenanceView(
	resolved: Resolved<unknown>,
	homeDir?: string,
): ProvenanceView {
	const entries = [...resolved.provenance.values()]
		.map((entry) => ({
			key: entry.key,
			tier: entry.tier,
			...(entry.file === undefined
				? {}
				: { file: homeRelativePath(entry.file, homeDir) }),
			...(entry.trust === undefined ? {} : { trust: entry.trust }),
		}))
		.sort((left, right) => compareKeys(left.key, right.key));
	return { entries };
}

/**
 * The provenance governing a pointer: its own entry, else the nearest ancestor's.
 *
 * Not every leaf carries its own entry. An array merged with the `replace`
 * strategy comes from ONE source, so one entry at the array's own pointer
 * answers for every element inside it, and per-element copies would be noise
 * that all say the same thing. Consumers ask this function rather than reading
 * the map directly, so "which tier decided this" has one answer at every depth.
 */
export function provenanceFor(
	resolved: Resolved<unknown>,
	pointer: string,
): Provenance | undefined {
	let candidate = pointer;
	for (;;) {
		const entry = resolved.provenance.get(candidate);
		if (entry) return entry;
		if (candidate === "") return undefined;
		const cut = candidate.lastIndexOf("/");
		candidate = cut <= 0 ? "" : candidate.slice(0, cut);
	}
}

/**
 * Code-unit ordering for any key a diagnostic or telemetry surface sorts.
 *
 * Exported so `process-spec.ts` sorts env names with it rather than with a bare
 * `.sort()` (Sonar S2871) or with `localeCompare`. `localeCompare` would be the
 * obvious substitute and the wrong one: its answer depends on the machine's
 * locale and ICU build, so two runs of the same resolution could order the same
 * env names differently and a telemetry diff would show a change that is not
 * one. A projection meant to be compared across machines must be
 * locale-independent.
 */
export function compareKeys(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}
