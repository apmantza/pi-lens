/**
 * THE single declarative source of truth for every pi-lens toggle (#166).
 *
 * One entry per flag drives all four consumers that previously kept their own
 * hand-maintained list and drifted apart:
 *
 *   - `index.ts` — `pi.registerFlag` for the CLI surface (name, description,
 *     default), as a loop over this array.
 *   - `clients/lens-config.ts` — parsing the key out of `~/.pi-lens/config.json`
 *     AND resolving the precedence chain, both keyed by `configKey`.
 *   - `clients/project-lens-config.ts` — the closest-wins nested walk for the
 *     `scope: "project"` entries.
 *   - `tests/index-wiring.test.ts` — the registration contract, derived rather
 *     than restated.
 *
 * Every entry is settable BOTH ways: `--<name>` on the CLI and `configKey` in
 * `~/.pi-lens/config.json`. Adding a toggle means adding one entry here; there
 * is no second place to remember.
 */

import { DEPRECATED_CONFIG_SURFACES } from "./config-diagnostic-codes.js";

type LensFlagScope = "global" | "project";

export interface LensFlagSpec {
	/** CLI flag name (`--<name>`) and the key callers pass to `getFlag`. */
	name: string;
	description: string;
	/**
	 * Dotted path to this flag's boolean in `~/.pi-lens/config.json` (and, for
	 * `scope: "project"` entries, the identical path in `.pi-lens.json`).
	 */
	configKey: string;
	/**
	 * True when the flag DISABLES what the config key enables — a `no-*` flag
	 * whose value is the negation of the config boolean.
	 */
	negated: boolean;
	/** Value when neither env, CLI, project config, nor global config decides. */
	default: boolean;
	/**
	 * `"project"` flags also read `.pi-lens.json` and nested per-directory
	 * configs (closest-wins per edited file); `"global"` flags resolve
	 * CLI → global → default.
	 */
	scope: LensFlagScope;
	/** Env var that forces the flag on when set to `"1"`. Outranks the CLI. */
	env?: string;
	/**
	 * Escape hatch for the one flag whose config key is not a boolean
	 * (`format.mode`). Returns undefined when the key is absent.
	 */
	readGlobal?: (config: Record<string, unknown>) => boolean | undefined;
}

export const LENS_FLAGS: readonly LensFlagSpec[] = [
	{
		name: "no-lens",
		description:
			"Start pi-lens disabled for this session. Re-enable with /lens-toggle. Also via lens.enabled=false in ~/.pi-lens/config.json.",
		configKey: "lens.enabled",
		negated: true,
		default: false,
		scope: "global",
	},
	{
		name: "no-lsp",
		description:
			"Disable unified LSP diagnostics and use language-specific fallbacks (for example pyright). Also via lsp.enabled=false in ~/.pi-lens/config.json.",
		configKey: "lsp.enabled",
		negated: true,
		default: false,
		scope: "global",
	},
	{
		name: "no-autoformat",
		description:
			"Disable automatic formatting entirely (deferred format runs at agent_end by default). Also via format.enabled=false in config.",
		configKey: "format.enabled",
		negated: true,
		default: false,
		scope: "project",
	},
	{
		name: "immediate-format",
		description:
			'Run automatic formatting immediately after each write/edit instead of deferring to agent_end. Also via format.mode="immediate" in config.',
		configKey: "format.mode",
		negated: false,
		default: false,
		scope: "global",
		readGlobal: (config) => {
			const format = config.format;
			if (!format || typeof format !== "object") return undefined;
			const mode = (format as Record<string, unknown>).mode;
			if (mode !== "immediate" && mode !== "deferred") return undefined;
			return mode === "immediate";
		},
	},
	{
		name: "no-autofix",
		description:
			"Disable auto-fixing of lint issues (Biome, Ruff, ESLint). Also via autofix.enabled=false in config.",
		configKey: "autofix.enabled",
		negated: true,
		default: false,
		scope: "project",
	},
	{
		name: "no-tests",
		description:
			"Disable test runner on write. Also via tests.enabled=false in ~/.pi-lens/config.json.",
		configKey: "tests.enabled",
		negated: true,
		default: false,
		scope: "global",
	},
	{
		name: "no-delta",
		description:
			"Disable delta mode (show all diagnostics, not just new ones). Also via delta.enabled=false in ~/.pi-lens/config.json.",
		configKey: "delta.enabled",
		negated: true,
		default: false,
		scope: "global",
	},
	{
		name: "lens-guard",
		description:
			"Experimental: block git commit/push when unresolved pi-lens blockers exist. Also via guard.enabled=true in ~/.pi-lens/config.json.",
		configKey: "guard.enabled",
		negated: false,
		default: false,
		scope: "global",
	},
	{
		name: "lens-checkout-guard",
		description:
			"Experimental: decline git commands that rewrite the working tree when another live pi-lens session shares this dirty checkout. Also via guard.sharedCheckout=true in ~/.pi-lens/config.json.",
		configKey: "guard.sharedCheckout",
		negated: false,
		default: false,
		scope: "global",
	},
	{
		name: "no-opengrep",
		description:
			"Disable the Opengrep security scanner (a default-on auxiliary LSP; auto-installs, uses repo rules if present else the login-free 'auto' ruleset). Also via opengrep.enabled=false in ~/.pi-lens/config.json.",
		configKey: "opengrep.enabled",
		negated: true,
		default: false,
		scope: "global",
	},
	{
		name: "no-read-guard",
		description:
			"Disable read-before-edit behavior monitor. Also via readGuard.enabled=false in ~/.pi-lens/config.json.",
		configKey: "readGuard.enabled",
		negated: true,
		default: false,
		scope: "global",
	},
	{
		name: "no-lens-context",
		description:
			"Disable automatic context injection (session-start guidance, turn-end & test findings) while keeping tools, LSP, read-guard, and formatting active. Toggle with /lens-context-toggle. Also via contextInjection.enabled=false in config or PI_LENS_NO_CONTEXT_INJECTION=1.",
		configKey: "contextInjection.enabled",
		negated: true,
		default: false,
		scope: "global",
		env: "PI_LENS_NO_CONTEXT_INJECTION",
	},
	{
		name: "lens-turn-summary",
		description:
			"Opt-in: persist a per-turn transcript entry summarizing diagnostics found, autofixes applied, and autoformats applied this turn (#484). Collapsed one-line, expandable in place. Default off. Also via turnSummary.enabled=true in ~/.pi-lens/config.json.",
		configKey: "turnSummary.enabled",
		negated: false,
		default: false,
		scope: "global",
	},
	{
		name: "lens-actionable-warnings",
		description:
			"Write turn-delta fixable warning reports and inject a short advisory. Also via actionableWarnings.enabled=true in ~/.pi-lens/config.json.",
		configKey: "actionableWarnings.enabled",
		negated: false,
		default: false,
		scope: "global",
	},
	{
		name: "lens-actionable-warning-actions",
		description:
			"Enrich actionable-warning reports with LSP code-action titles (requires an active language server). Also via actionableWarnings.includeLspCodeActions=true in ~/.pi-lens/config.json.",
		configKey: "actionableWarnings.includeLspCodeActions",
		negated: false,
		default: false,
		scope: "global",
	},
	{
		name: "lens-actionable-warning-autofix",
		description:
			"Experimental: apply conservative LSP quickfixes for actionable warnings at agent_end. Also via actionableWarnings.autoFix.enabled=true in config.",
		configKey: "actionableWarnings.autoFix.enabled",
		negated: false,
		default: false,
		scope: "project",
	},
	{
		name: "lens-actionable-warning-all",
		description:
			"Report every actionable warning, not just those introduced this turn. Also via actionableWarnings.deltaOnly=false in ~/.pi-lens/config.json.",
		configKey: "actionableWarnings.deltaOnly",
		negated: true,
		default: false,
		scope: "global",
	},
	{
		name: "lens-compact-tool-line",
		description:
			"Opt-in (#1327): collapse a pi-lens tool's call+result rows into ONE theme-aware line (status glyph + name + summary) instead of two. Preserves expand-to-view-full-output. Default off. Also via ui.compactToolLine=true in ~/.pi-lens/config.json.",
		configKey: "ui.compactToolLine",
		negated: false,
		default: false,
		scope: "global",
	},
	{
		name: "no-lazy-tools",
		description:
			"Keep all pi-lens tools active to avoid tool-list cache changes. Also via tools.lazy=false in ~/.pi-lens/config.json.",
		configKey: "tools.lazy",
		negated: true,
		default: false,
		scope: "global",
	},
	{
		name: "lens-turn-end-madge",
		description:
			"Run the per-turn-end madge circular-dependency check on import-changed files. Off by default: the pass only writes debug output, and user-facing madge diagnostics come from the session-start scan cache + lens_diagnostics. Also via turnEnd.madge.enabled=true in ~/.pi-lens/config.json.",
		configKey: "turnEnd.madge.enabled",
		negated: false,
		default: false,
		scope: "global",
	},
	...(
		[
			"knip",
			"jscpd",
			"madge",
			"gitleaks",
			"govulncheck",
			"deadCode",
			"complexity",
		] as const
	).map((analyzer) => ({
		name: `no-${analyzer.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
		description: `Disable the ${analyzer} session-start analyzer. Also via ${analyzer}.enabled=false in config.`,
		configKey: `${analyzer}.enabled`,
		negated: true,
		default: false,
		scope: "project" as const,
	})),
];

const byName = new Map(LENS_FLAGS.map((spec) => [spec.name, spec]));

export function getLensFlagSpec(name: string): LensFlagSpec | undefined {
	return byName.get(name);
}

/** The `scope: "project"` subset — the flags a `.pi-lens.json` may also set. */
export const PROJECT_SCOPED_LENS_FLAGS: readonly LensFlagSpec[] =
	LENS_FLAGS.filter((spec) => spec.scope === "project");

/**
 * Recognized TOP-LEVEL sections of `~/.pi-lens/config.json` that are NOT
 * derived from the flag registry — the non-flag namespaces the global loader
 * parses by hand (`ignore`, `dispatch`, `widget`) plus `$schema` for editor
 * JSON-schema association. Declared here, beside {@link LENS_FLAGS}, so the
 * global unknown-key scan has ONE catalog to consult (#883) instead of a
 * second hand-maintained literal set inline in the loader. Adding a future
 * top-level namespace is a one-line edit HERE; adding a flag needs no edit at
 * all (its section is registry-derived via {@link flagConfigSectionKeys}).
 * Do NOT speculatively pre-add keys no loader reads yet (e.g. `languages` is
 * #195's job) — this is an extension point, not a wishlist.
 *
 * `actionableWarnings` is intentionally absent: it is already a flag section
 * (`actionableWarnings.enabled`, `.autoFix.enabled`, ...) so it is covered by
 * the registry-derived set.
 */
export const GLOBAL_NON_FLAG_CONFIG_SECTIONS: readonly string[] = [
	"ignore",
	"dispatch",
	"widget",
	"startup",
	"$schema",
];

/**
 * Recognized TOP-LEVEL sections of a project `.pi-lens.json` that are NOT
 * derived from the flag registry — the project loader's own hand-parsed
 * sections (`ignore`, `rules`, `maxProjectFiles`, `reviewGraph`) plus the two
 * namespaces another pi-lens runner reads off `PiLensProjectConfig.raw`
 * (`trivy` in `trivy-client.ts`, `helm.renderValidation.enabled` in the
 * helm-render runner, #1283).
 *
 * Moved here from `project-lens-config.ts` by #2426 so the canonical schema in
 * `config-schema.ts` derives its namespace list from ONE place instead of
 * importing the project loader (which would close an import cycle, since that
 * loader now resolves through the schema).
 */
export const PROJECT_NON_FLAG_CONFIG_SECTIONS: readonly string[] = [
	"ignore",
	"rules",
	"maxProjectFiles",
	"reviewGraph",
	"trivy",
	"helm",
	"startup",
];

/**
 * The four LSP settings a PROJECT config file may carry — at its root during
 * the deprecation window, and under `lsp` canonically. DERIVED from the
 * registry's `kind: "key"` rows so the accepted set and the removal schedule
 * cannot drift apart, and named once because two places below need it.
 */
const LSP_PROJECT_HONORED_KEYS: readonly string[] =
	DEPRECATED_CONFIG_SURFACES.filter((row) => row.kind === "key").map(
		(row) => row.surface,
	);

/**
 * Foreign top-level namespaces that legitimately appear in a SHARED
 * `.pi-lens.json` but belong to a DIFFERENT loader: the LSP config loader
 * (`clients/lsp/config.ts`) reads the `lsp` namespace — and, for its
 * deprecation window, the legacy ROOT keys `servers` / `serverOverrides` /
 * `disabledServers` / `warmFiles` — out of the very same file. The project-lens
 * loader must TOLERATE these (never warn "unknown key") — they are not typos,
 * just another subsystem's namespace. `$schema` is allowed for editor
 * JSON-schema association. Declared once, here, for the same #883 reason as
 * {@link GLOBAL_NON_FLAG_CONFIG_SECTIONS}.
 *
 * `lsp` joined this list in #2426: it is the canonical home of the four legacy
 * keys beside it, so a project config that has already been migrated must not
 * be told its `lsp` section is a global-only setting. Its tolerance is
 * SUB-KEY-SCOPED — see {@link PROJECT_FOREIGN_NAMESPACE_HONORED_KEYS}.
 */
export const PROJECT_FOREIGN_CONFIG_NAMESPACES: readonly string[] = [
	"lsp",
	// DERIVED, not restated: the four legacy root keys are exactly the
	// `kind: "key"` rows of the deprecation registry, and a hand-copied second
	// list of them would be a place for the accepted set and the removal
	// schedule to drift apart. `config-diagnostic-codes.ts` is a dependency-free
	// data leaf, so importing it keeps this module's own no-cycle property.
	...LSP_PROJECT_HONORED_KEYS,
	"$schema",
];

/**
 * For a foreign namespace whose PROJECT-honored surface is only PART of what
 * the namespace can hold: which sub-keys a `.pi-lens.json` may set.
 *
 * `lsp` is tolerated at the top level because the LSP loader reads it out of
 * this same file — but only four of its keys are project-scoped. `lsp.enabled`
 * is a `scope: "global"` flag (`--no-lsp`), so blanket namespace tolerance made
 * a project-file `lsp.enabled: false` do nothing with no signal at all, where
 * before #2426 the user got the honest "global-only setting" notice
 * (#2426 review round 2, F3). `docs/configuration.md` promises that nothing
 * about a config is ignored silently, so the namespace is tolerated KEY BY KEY
 * and anything else under it is scanned by the same global-only-vs-typo rules a
 * top-level key gets.
 */
export const PROJECT_FOREIGN_NAMESPACE_HONORED_KEYS: ReadonlyMap<
	string,
	readonly string[]
> = new Map([["lsp", LSP_PROJECT_HONORED_KEYS]]);

/**
 * The distinct TOP-LEVEL section keys a set of flags lives under (the first
 * dotted segment of each `configKey`). Both config loaders derive their
 * recognized-key catalogs from this rather than restating flag sections, so a
 * new flag never needs an unknown-key-scan edit (#166/#883).
 */
export function flagConfigSectionKeys(
	flags: readonly LensFlagSpec[],
): string[] {
	return [...new Set(flags.map((spec) => spec.configKey.split(".")[0]))];
}

function asConfigObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

interface FlagConfigPath {
	source: Record<string, unknown>;
	segments: string[];
}

function resolveFlagConfigPath(
	raw: Record<string, unknown>,
	configKey: string,
	warnInvalid?: (reason: string) => void,
): FlagConfigPath | undefined {
	const segments = configKey.split(".");
	let source = raw;
	for (let i = 0; i < segments.length - 1; i++) {
		const object = asConfigObject(source);
		if (!object) return undefined;

		const segment = segments[i];
		if (!(segment in object)) return undefined;

		const next = asConfigObject(object[segment]);
		if (!next) {
			if (warnInvalid) {
				warnInvalid(`${segments.slice(0, i + 1).join(".")} must be an object`);
			}
			return undefined;
		}

		source = next;
	}

	const finalSource = asConfigObject(source);
	if (!finalSource) return undefined;
	return { source: finalSource, segments };
}

/**
 * Read the boolean at a spec's dotted `configKey` out of an already-parsed
 * config object. Returns undefined when any segment is missing or the leaf is
 * not a boolean — callers treat that as "this tier does not decide".
 */
export function readFlagConfigValue(
	config: unknown,
	configKey: string,
): boolean | undefined {
	const path = resolveFlagConfigPath(
		config as Record<string, unknown>,
		configKey,
	);
	if (!path) return undefined;

	const leaf = path.segments[path.segments.length - 1];
	const value = path.source[leaf];
	return typeof value === "boolean" ? value : undefined;
}

/** Turn a config-tier boolean into the flag's value, honoring `negated`. */
export function flagValueFromConfig(
	spec: LensFlagSpec,
	configValue: boolean,
): boolean {
	return spec.negated ? !configValue : configValue;
}

/**
 * Copy the boolean at one flag's dotted `configKey` from a raw parsed config
 * into `out`, materializing intermediate objects only when they actually
 * exist in `raw` — an absent section stays absent, a present-but-empty one is
 * materialized with an undefined leaf. Shared by the global
 * (`lens-config.ts`) and project (`project-lens-config.ts`) loaders so both
 * parse and warn identically; it lives here rather than in either loader
 * because this module imports nothing and cannot form a cycle.
 */
export function assignFlagConfigSection(
	raw: Record<string, unknown>,
	out: Record<string, unknown>,
	configKey: string,
	warnInvalid: (reason: string) => void,
): void {
	const path = resolveFlagConfigPath(raw, configKey, warnInvalid);
	if (!path) return;

	let target = out;
	for (const segment of path.segments.slice(0, -1)) {
		target[segment] ??= {};
		target = target[segment] as Record<string, unknown>;
	}

	const leaf = path.segments[path.segments.length - 1];
	if (leaf in path.source && typeof path.source[leaf] !== "boolean") {
		warnInvalid(`${configKey} must be a boolean`);
		target[leaf] = undefined;
		return;
	}
	target[leaf] = path.source[leaf];
}
