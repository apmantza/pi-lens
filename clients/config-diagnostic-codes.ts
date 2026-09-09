/**
 * The stability registry for pi-lens's PUBLIC config surfaces (#2418).
 *
 * At ~28k downloads/month a config field or a warning string becomes a
 * compatibility obligation the moment it ships. This module is the one place
 * that obligation is written down as DATA, so the policy in
 * `docs/public-api-stability.md` is enforceable by test rather than by
 * convention:
 *
 * - `STABILITY_TIERS` / `STABILITY_TIER_KEY` — the `x-stability` annotation
 *   every published schema property must carry. New fields default to
 *   `experimental`; only `stable` fields are covered by the compatibility
 *   guarantee. Promotion is a deliberate, changelogged act.
 * - `CONFIG_SCHEMA_ID` / `CONFIG_SCHEMA_ANCHOR_KEY` — the reserved schema
 *   identity anchor the unified config envelope carries from its first
 *   published version (#2416 populates it; nothing here emits config).
 * - `CONFIG_DIAGNOSTIC_CODES` — a closed, APPEND-ONLY namespace of stable
 *   codes for user-facing config validation and migration warnings, so a user
 *   can match or suppress on `PILENS_CFG_0001` instead of on prose. Message
 *   text may change freely; codes may never be renumbered or removed.
 * - `DEPRECATED_CONFIG_SURFACES` — the deprecation window (`deprecatedSince` /
 *   `removeNotBefore`) for every legacy config key and file location that is
 *   still read. Removal happens only in a major, through the documented
 *   breaking-change checklist.
 *
 * Deliberately DEPENDENCY-FREE: this is a data leaf imported by the config
 * loaders, the degradation ledger seam, and the governance tests. It must
 * never grow an import on a module that itself reports config diagnostics.
 */

// --- Field stability tiers (policy point 1) ---

/** The JSON Schema annotation key carrying a field's stability tier. */
export const STABILITY_TIER_KEY = "x-stability";

/**
 * The closed tier vocabulary. `experimental` fields may change or be removed
 * in a minor; `stable` fields are covered by the compatibility guarantee.
 */
const STABILITY_TIERS = ["experimental", "stable"] as const;

export type StabilityTier = (typeof STABILITY_TIERS)[number];

export function isStabilityTier(value: unknown): value is StabilityTier {
	return (
		typeof value === "string" &&
		(STABILITY_TIERS as readonly string[]).includes(value)
	);
}

// --- Config envelope identity (policy point 3) ---

/**
 * The reserved `$schema` URL for the unified pi-lens config envelope. Pinned
 * here from the first published version so the identity anchor cannot drift
 * between the schema, the validator, and the docs. #2416 is the first consumer.
 */
export const CONFIG_SCHEMA_ID =
	"https://raw.githubusercontent.com/apmantza/pi-lens/master/docs/schema/pi-lens-config-v1.json";

/** The envelope key carrying `CONFIG_SCHEMA_ID` in a user's config file. */
export const CONFIG_SCHEMA_ANCHOR_KEY = "$schema";

// --- Stable config diagnostic codes (policy point 2) ---

/**
 * APPEND-ONLY. Add new codes at the end with the next number; never renumber,
 * never delete, never reuse a retired number. A retired code keeps its entry
 * with its description amended — `tests/clients/config-diagnostic-codes.test.ts`
 * pins the full list and goes red on any renumber or removal.
 */
export const CONFIG_DIAGNOSTIC_CODES = {
	/**
	 * A config file exists but could not be read or parsed, so it is ignored.
	 *
	 * EMITTED, by `warnIgnoredConfigOnce` (`clients/config-warn.ts`) — the one
	 * seam behind all three config loaders. It rides the user-facing message as
	 * a ` [PILENS_CFG_0001]` suffix AND the durable `config-ignored`
	 * degradation row, so the code a user greps for in the terminal is the same
	 * one in `latency.log`.
	 */
	PILENS_CFG_0001: "config file unreadable or unparsable; ignored",
	/**
	 * A deprecated config KEY was accepted inside its deprecation window.
	 *
	 * EMITTED since #2426, by `deprecationRecords` (`clients/config-resolve.ts`)
	 * for every `kind: "key"` row below that appears at the ROOT of a canonical
	 * file — one record per `(file, key)` — and delivered through
	 * `reportPiLensConfigRecords` -> `warnIgnoredConfigOnce`, which renders it as
	 * `deprecated <label> key in <file>: …` and records a `config-deprecated`
	 * ledger row rather than a `config-ignored` one. The setting still APPLIES;
	 * the code says only that the spelling is on a removal schedule.
	 *
	 * The record carries `canonicalKey`, so the auto-migrator #2426 defers can
	 * be a pure function over these records rather than a prose parser.
	 */
	PILENS_CFG_0002: "deprecated config key accepted",
	/**
	 * A deprecated config FILE LOCATION was read inside its window.
	 *
	 * EMITTED since #2426 — same producer, same delivery path, and the same
	 * one-record-per-`(file, key)` granularity as `PILENS_CFG_0002`; this is the
	 * code for the `kind: "file"` rows below. Per-key rather than per-file so the
	 * warning can name the destination of each setting the user has to move.
	 */
	PILENS_CFG_0003: "deprecated config file location accepted",
	/**
	 * A config field no schema property claims was dropped.
	 *
	 * PRODUCED by `validate()` (`clients/config-core/normalize.ts`), which is
	 * the one place the unknown-field policy in `docs/public-api-stability.md`
	 * is implemented: warn and drop, never throw. It reaches a user through
	 * `reportPiLensConfigRecords` -> `warnIgnoredConfigOnce`, which #2426 wires
	 * when the loaders adopt the core. Registered now because the resolution
	 * pipeline already stamps records with it, and a record carrying an
	 * unregistered code is exactly what the #2418 drift test forbids.
	 */
	PILENS_CFG_0004: "unknown config field ignored",
	/**
	 * A config field's value did not match its schema and was dropped.
	 *
	 * Wrong type, a value outside a declared `enum`, or a nesting depth past the
	 * validator's bound. Same producer and same delivery path as
	 * `PILENS_CFG_0004`. Kept distinct from it because the two need different
	 * user actions: an unknown field is usually a typo or a removed key, while a
	 * rejected value is a field the user meant and spelled wrongly.
	 */
	PILENS_CFG_0005: "config field value rejected by schema; ignored",
	/**
	 * A config KEY that would have modified an object's prototype was refused.
	 *
	 * `__proto__`, `constructor`, `prototype`. PRODUCED by both halves of the
	 * config core (`normalize.ts` when validating, `merge.ts` when combining
	 * tiers), through the shared policy in `config-core/safe-object.ts`.
	 *
	 * Kept distinct from `PILENS_CFG_0004` even though both describe a dropped
	 * key, because the two mean different things to whoever reads the warning: an
	 * unknown field is a typo the user should fix, while this one is a key no
	 * pi-lens config can ever legitimately carry. A user who sees it in their own
	 * hand-written file has a mistake; a user who sees it naming a file they did
	 * not write has something worth looking at.
	 */
	PILENS_CFG_0006: "config key would modify the object prototype; ignored",
	/**
	 * Further config notices were suppressed by a per-resolution bound.
	 *
	 * The record count a config file can produce is USER INPUT — one key, one
	 * record — so every producer collects into a bounded
	 * `MigrationRecordCollector` through `finalizeRecords`, which holds one slot
	 * back for this code. It is the difference between a bound that is honest
	 * and one that drops notices silently: a user who sees it knows the list
	 * they were shown is partial, and how much of it is missing. The count is
	 * the WHOLE truncation, including anything an earlier bound in the same
	 * pipeline already discarded (#2426 review round 6, F1).
	 *
	 * Registered as its own code rather than folded into `PILENS_CFG_0001`
	 * because the user action differs — nothing about the config is wrong, the
	 * OUTPUT was truncated, and the fix is to read the file rather than to
	 * change it. For the same reason it is the ONE code `warnIgnoredConfigOnce`
	 * renders with neither the `ignoring invalid …` prose nor the
	 * `config-ignored` ledger kind: it records under `config-notice-suppressed`,
	 * because a file whose every setting applied can still overflow the bound.
	 */
	PILENS_CFG_0007:
		"further config notices suppressed by the per-resolution bound",
	/**
	 * A WHOLE configuration was dropped because resolving it failed internally.
	 *
	 * PRODUCED by the two guards that stand under the config pipeline —
	 * `resolveConfig` (`clients/config-core/resolve.ts`) and the global loader's
	 * post-parse catch (`clients/lens-config.ts`) — each of which degrades a
	 * failed resolution to "no config" rather than taking the session with it.
	 * The record carries the error CLASS only, never its message.
	 *
	 * Distinct from `PILENS_CFG_0005`, which both guards borrowed until #2426
	 * review round 6 (S1). 0005 is registered as a per-FIELD rejection: a user
	 * who matches on it expects one setting to have been dropped and the rest to
	 * be in effect. Here NOTHING in the file is in effect, so the two need
	 * different codes to be worth matching on at all.
	 *
	 * The ONE code the per-resolution bound never suppresses (#2426 review round
	 * 7, F1). Every other record is one more per-key notice, and past 20 of
	 * those a count is worth more than the list; this record is the statement
	 * that those notices are no longer the whole story, so letting a
	 * `PILENS_CFG_0007` stand in for it told the user "19 keys rejected, N more
	 * suppressed" about a configuration that applied nothing at all.
	 */
	PILENS_CFG_0008: "config resolution failed; whole configuration ignored",
	/** A tool key is unknown or names a required, non-disableable tool. */
	PILENS_CFG_0009: "unknown or non-disableable tool config key ignored",
} as const satisfies Record<`PILENS_CFG_${string}`, string>;

export type ConfigDiagnosticCode = keyof typeof CONFIG_DIAGNOSTIC_CODES;

/** The shape every code in the namespace must match. */
export const CONFIG_DIAGNOSTIC_CODE_PATTERN = /^PILENS_CFG_\d{4}$/;

export function isConfigDiagnosticCode(
	value: unknown,
): value is ConfigDiagnosticCode {
	return (
		typeof value === "string" && Object.hasOwn(CONFIG_DIAGNOSTIC_CODES, value)
	);
}

/** The registered description for a code, or `undefined` when unregistered. */
export function getConfigDiagnosticCode(code: string): string | undefined {
	return isConfigDiagnosticCode(code)
		? CONFIG_DIAGNOSTIC_CODES[code]
		: undefined;
}

/**
 * The user-visible marker appended to a coded message: ` [PILENS_CFG_0001]`.
 * Kept as a bracketed suffix so it is greppable and suppressible without
 * depending on any prose before it.
 */
export function configDiagnosticMarker(code: ConfigDiagnosticCode): string {
	return `[${code}]`;
}

/** Append a code marker to a message, unless the message already carries it. */
export function withConfigDiagnosticCode(
	message: string,
	code: ConfigDiagnosticCode,
): string {
	const marker = configDiagnosticMarker(code);
	return message.includes(marker) ? message : `${message} ${marker}`;
}

/** Matches the marker suffix in rendered messages (capture group 1 = code). */
export const CONFIG_DIAGNOSTIC_MARKER_PATTERN = /\[(PILENS_CFG_\d{4})\]/;

// --- Deprecation windows (policy point 4) ---

type DeprecatedConfigSurfaceKind = "key" | "file";

export interface DeprecatedConfigSurface {
	/** A config KEY name, or a config FILE path/basename. */
	readonly surface: string;
	readonly kind: DeprecatedConfigSurfaceKind;
	/** The stable code the migration warning for this surface carries. */
	readonly code: ConfigDiagnosticCode;
	/**
	 * Version in which the surface is ANNOUNCED deprecated. For a row whose
	 * announcement is still an unreleased `.changelog/` fragment this is the
	 * NEXT release, never the version already on npm: back-dating a deprecation
	 * into a shipped release claims a warning that release never emitted.
	 * `tests/clients/config-deprecation-registry.test.ts` checks it against the
	 * newest release in `CHANGELOG.md`, not against `package.json`.
	 */
	readonly deprecatedSince: string;
	/** Earliest version in which removal is permitted (always a major). */
	readonly removeNotBefore: string;
	readonly reason: string;
}

/**
 * The legacy config surfaces pi-lens still reads. Each row commits to being
 * read for one deprecation window and then ACTUALLY removed at
 * `removeNotBefore` — legacy sources are not carried forever. Removal routes
 * through the #2372 slice-5 breaking-change plan, which instantiates the
 * checklist in `docs/public-api-stability.md`.
 *
 * The consolidation slice (#2426) blesses exactly two canonical locations:
 * `.pi-lens.json` (project) and `~/.pi-lens/config.json` (global). Neither
 * appears here, and that is the point: a CANONICAL FILE IS NOT DEPRECATED
 * BECAUSE SOME OF ITS KEYS ARE. `.pi-lens.json` keeps being read forever; what
 * is deprecated is the legacy top-level LSP keys inside it (`servers`,
 * `serverOverrides`, `disabledServers`, `warmFiles`), which are the
 * `kind: "key"` rows below. Listing the file itself would have promised users
 * that the file they were just told to migrate TO is going away.
 */
/**
 * The window every surface below shares. One window, not eight copies: the
 * whole point of policy point 4 is that a deprecation is announced ONCE and
 * removed at ONE major, so a per-row date is an invitation to drift. Spelling
 * it once also means the S3 rule — `deprecatedSince` is the release that
 * announces, never one that already shipped — has a single place to be wrong.
 */
const LSP_DEPRECATION_WINDOW = {
	deprecatedSince: "4.1.4",
	removeNotBefore: "5.0.0",
} as const;

/** A legacy top-level LSP KEY inside a config file that is itself canonical. */
const LEGACY_KEY = {
	kind: "key",
	code: "PILENS_CFG_0002",
	...LSP_DEPRECATION_WINDOW,
} as const;

/** A legacy config FILE LOCATION that a loader still reads. */
const LEGACY_FILE = {
	kind: "file",
	code: "PILENS_CFG_0003",
	...LSP_DEPRECATION_WINDOW,
} as const;

export const DEPRECATED_CONFIG_SURFACES = [
	{
		...LEGACY_KEY,
		surface: "servers",
		reason:
			"custom-server definitions move to the unified catalog schema; the bare string command + args form is replaced by the trust-gated ProcessSpec (#2416).",
	},
	{
		...LEGACY_KEY,
		surface: "serverOverrides",
		reason:
			"per-server initializationOptions overrides fold into the catalog's field-wise merge, keyed by the same public server IDs (#2416).",
	},
	{
		...LEGACY_KEY,
		surface: "disabledServers",
		reason:
			"replaced by the catalog's per-entry `enabled: false`, which carries monotonic deny precedence (#1416/#2415).",
	},
	{
		...LEGACY_KEY,
		surface: "warmFiles",
		reason:
			"session warm-up seeds become a per-server catalog field rather than a config-root list (#2416).",
	},
	{
		...LEGACY_FILE,
		surface: ".pi-lens/lsp.json",
		reason:
			"project LSP settings consolidate into `.pi-lens.json` under the unified envelope (#2426).",
	},
	{
		...LEGACY_FILE,
		surface: "pi-lsp.json",
		reason:
			"pre-rename project location; superseded by `.pi-lens.json` (#2426).",
	},
	{
		...LEGACY_FILE,
		surface: "pi-lens.json",
		reason:
			"undotted project-config basename; superseded by `.pi-lens.json` (#2426).",
	},
	{
		...LEGACY_FILE,
		surface: "~/.pi-lens/lsp.json",
		reason:
			"global LSP settings consolidate into `~/.pi-lens/config.json` (#2426).",
	},
] as const satisfies readonly DeprecatedConfigSurface[];
