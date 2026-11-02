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

import {
	type ConfigDiagnosticCode,
	DEPRECATED_CONFIG_SURFACES,
} from "./config-diagnostic-codes.js";

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
	 * Escape hatch for a flag whose config key is not a plain boolean
	 * (`format.mode`, and `tools.lazy`'s `"auto"`). Returns undefined when the
	 * key is absent. The global loader parses such a key itself.
	 */
	readGlobal?: (config: Record<string, unknown>) => boolean | undefined;
}

/**
 * The `ui.*` opt-in family shares these three invariants — `negated: false`,
 * `default: false`, `scope: "global"` — so declare them once here instead of
 * restating a six-field object literal per entry (Sonar CPD's duplicate-block
 * source: it normalizes string literals, so per-entry rewording cannot help).
 */
function globalOptInFlag(
	name: string,
	description: string,
	configKey: string,
): LensFlagSpec {
	return {
		name,
		description,
		configKey,
		negated: false,
		default: false,
		scope: "global",
	};
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
			"Disable the Opengrep security scanner (a default-on auxiliary LSP; auto-installs, uses repo rules if present, else the registry pack pi-lens refreshes into its cache, else the login-free 'auto' ruleset). Also via opengrep.enabled=false in ~/.pi-lens/config.json.",
		configKey: "opengrep.enabled",
		negated: true,
		default: false,
		scope: "global",
	},
	{
		name: "no-ast-grep",
		description:
			"Disable the ast-grep auxiliary LSP server (default-on; serves the bundled and repo ast-grep rules). Also via astGrep.enabled=false in ~/.pi-lens/config.json.",
		configKey: "astGrep.enabled",
		negated: true,
		default: false,
		scope: "global",
	},
	{
		name: "no-zizmor",
		description:
			"Disable the zizmor auxiliary LSP server (default-on; audits GitHub Actions workflows). Also via zizmor.enabled=false in ~/.pi-lens/config.json.",
		configKey: "zizmor.enabled",
		negated: true,
		default: false,
		scope: "global",
	},
	{
		name: "no-typos",
		description:
			"Disable the typos auxiliary LSP server (default-on; flags known misspellings in source and Markdown). Also via typos.enabled=false in ~/.pi-lens/config.json.",
		configKey: "typos.enabled",
		negated: true,
		default: false,
		scope: "global",
	},
	globalOptInFlag(
		"lens-spotbugs",
		"Opt-in: run SpotBugs on Java and Kotlin files when a Java build descriptor and a compiled .class directory exist (heavyweight: JVM cold start plus whole-tree analysis). Default off. Also via spotbugs.enabled=true in ~/.pi-lens/config.json.",
		"spotbugs.enabled",
	),
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
		name: "lens-retain-injections",
		description:
			"Opt-in (#4743): re-send each request's injected findings unchanged, at the same place, in every later request of the session, so an exact-prefix prompt cache (a local llama.cpp or Qwen server) keeps the whole conversation. Each retained block is labelled a snapshot; findings are still delivered once. Default off. Also via contextInjection.retain=true in ~/.pi-lens/config.json.",
		configKey: "contextInjection.retain",
		negated: false,
		default: false,
		scope: "global",
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
	globalOptInFlag(
		"lens-compact-tool-line",
		"Opt-in (#1327): collapse a pi-lens tool's call+result rows into ONE theme-aware line (status glyph + name + summary) instead of two. Preserves expand-to-view-full-output. Default off. Also via ui.compactToolLine=true in ~/.pi-lens/config.json.",
		"ui.compactToolLine",
	),
	globalOptInFlag(
		"lens-compact-lsp-status",
		"Opt-in (#3099): collapse the footer LSP status to one state glyph per group (LSP ✓ green, LSP ✗ red, dim LSP ✗ when nothing is warm) instead of listing the active server names. Default off. Also via ui.compactLspStatus=true in ~/.pi-lens/config.json.",
		"ui.compactLspStatus",
	),
	globalOptInFlag(
		"lens-hide-lsp-status",
		"Opt-in (#3099): publish no pi-lens-lsp footer status at all, so a host that renders extension statuses stops showing the key. Outranks lens-compact-lsp-status when both are set. Default off. Also via ui.hideLspStatus=true in ~/.pi-lens/config.json.",
		"ui.hideLspStatus",
	),
	globalOptInFlag(
		"lens-compact-widget",
		"Opt-in (#3959): render the pi-lens widget as ONE summary line (languages + error/warning totals) instead of also stacking file rows, the suppressed count and blocker details below it. Default off. Also via ui.compactWidget=true in ~/.pi-lens/config.json.",
		"ui.compactWidget",
	),
	{
		name: "no-lazy-tools",
		description:
			'Keep every pi-lens tool active for the whole session. Same as tools.lazy=false in ~/.pi-lens/config.json; the default tools.lazy=true starts the situational tools inactive on every model, and tools.lazy="auto" only on models that support mid-conversation system messages.',
		configKey: "tools.lazy",
		negated: true,
		default: false,
		scope: "global",
		// #4687: `tools.lazy` takes a third value, "auto", which leaves this flag
		// at its default (off); only the two booleans decide it.
		readGlobal: (config) => {
			const setting = readLazyToolsSetting(config);
			return typeof setting === "boolean" ? setting : undefined;
		},
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
	{
		name: "lens-fallow",
		description:
			"Opt-in (#4929): run fallow-lsp beside the TypeScript server on JS/TS files, an advisory auxiliary LSP for unused code, duplication and cycles (auto-installs the pinned release; never blocks; knip, jscpd and madge keep running). Default off. Also via fallow.enabled=true in ~/.pi-lens/config.json.",
		configKey: "fallow.enabled",
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
 * Dotted GLOBAL-only config keys that are NOT `LENS_FLAGS` entries — no CLI
 * flag, not a boolean — but still sit inside a section a project
 * `.pi-lens.json` is otherwise recognized to touch (#3131). The project
 * loader's mixed-scope sub-key scan (`project-lens-config.ts`) already derives
 * its FLAG population from `LENS_FLAGS`; that derivation structurally cannot
 * see a key like `actionableWarnings.autoFix.maxFixes` — a numeric cap with no
 * `--flag` counterpart, documented global-only (`docs/settings.md`), read only
 * through `getGlobalActionableWarningMaxFixes()` (`clients/lens-config.ts`) —
 * because it was never a `LensFlagSpec` to begin with. `actionableWarnings` is
 * itself recognized at project scope only because its SIBLING
 * `actionableWarnings.autoFix.enabled` is a `scope: "project"` flag, so before
 * this registry existed the loader parsed `maxFixes` away with no signal at
 * all — the same silent-drop shape #2426 review round 2 (F3) fixed for
 * `lsp.enabled` and #3112 fixed for `tools.lazy`.
 *
 * This is the single source that population is derived from: the mixed-scope
 * scan reads `LENS_FLAGS` for flag keys and this list for everything else, so
 * a future non-flag global-only key needs one line HERE, never a second
 * hand-typed list inside the loader.
 *
 * A key belongs here ONLY when all three hold: (a) it is global-only — read
 * solely off `~/.pi-lens/config.json`, never honored from a project document;
 * (b) it is not a `LENS_FLAGS` entry; (c) its SECTION is recognized at project
 * scope for some OTHER reason. A key whose whole section is unrecognized at
 * project scope needs no entry — the top-level unknown-key scan already
 * reports the section. Swept at #3131: every other non-flag dotted key either
 * loader parses (`dispatch.runnerTimeoutFloorMs`, `widget.visible`,
 * `startup.mode`, `startup.scans.enabled`) fails (a) or (c) — see that PR's
 * body for the per-member table. `dispatch.runnerTimeoutFloorMs` joined when
 * `dispatch` became recognized at project scope for `dispatch.disabledRunners`
 * (it now satisfies (c)), so a project file carrying the floor is told it does
 * nothing there instead of being silently dropped.
 */
export const GLOBAL_ONLY_NON_FLAG_KEYS: readonly string[] = [
	"actionableWarnings.autoFix.maxFixes",
	"dispatch.runnerTimeoutFloorMs",
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
	// `tools` is MIXED-SCOPE, and belongs here for the project-scoped half
	// (#3112). `tools.<name>.enabled` is not a registry flag at all: it is
	// hand-parsed by `readToolConfig` against `TOOL_REGISTRY` in BOTH loaders,
	// and `resolveLensToolEnabled` reads the project document's value ahead of
	// the global one — which is what `docs/settings.md` and
	// `docs/globalconfig.md` document. Deriving the project-accepted sections
	// from the flag registry alone therefore put the whole section in
	// `globalScopeOnlyKeys` (its only registry flag, `tools.lazy`, IS global)
	// and told every user of a documented per-tool override that it was being
	// ignored. The global-only half is not lost: `tools.lazy` is still reported
	// at project scope by the project loader's mixed-scope sub-key scan, which
	// derives WHICH sub-keys those are from this same registry.
	"tools",
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
 *
 * `dispatch` joined for `dispatch.disabledRunners`, the dispatch loader's
 * denial list (`clients/dispatch/disabled-runners.ts`). It is mixed-scope the
 * same way: `dispatch.runnerTimeoutFloorMs` stays global-only.
 */
export const PROJECT_FOREIGN_CONFIG_NAMESPACES: readonly string[] = [
	"lsp",
	"dispatch",
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
> = new Map([
	["lsp", LSP_PROJECT_HONORED_KEYS],
	["dispatch", ["disabledRunners"]],
]);

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

/** `tools.lazy` (#4687 item 7): the one registry key with a third value. */
export type LazyToolsSetting = boolean | "auto";

/**
 * The `tools.lazy` value a config document sets, or undefined when it sets
 * none or an invalid one. The global loader reports the invalid case.
 */
export function readLazyToolsSetting(
	config: unknown,
): LazyToolsSetting | undefined {
	const lazy = asConfigObject(asConfigObject(config)?.tools)?.lazy;
	return lazy === true || lazy === false || lazy === "auto" ? lazy : undefined;
}

interface FlagConfigPath {
	source: Record<string, unknown>;
	segments: string[];
}

function resolveFlagConfigPath(
	raw: Record<string, unknown>,
	configKey: string,
	warnInvalid?: (reason: string, code: ConfigDiagnosticCode) => void,
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
				warnInvalid(
					`${segments.slice(0, i + 1).join(".")} must be an object`,
					"PILENS_CFG_0005",
				);
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
 * Whether a parsed config document actually SETS the dotted `configKey` —
 * presence, not validity (#3112). The project loader's mixed-scope scan must
 * report `tools: { lazy: "yes" }` exactly as it reports `tools: { lazy: false }`:
 * the user wrote a global-only setting in a project file either way, and
 * {@link readFlagConfigValue} would return `undefined` for the malformed one and
 * silently skip it. Shares {@link resolveFlagConfigPath} with every other reader
 * so "which segments does this key name" is answered in exactly one place.
 */
export function hasFlagConfigPath(
	raw: Record<string, unknown>,
	configKey: string,
): boolean {
	const resolved = resolveFlagConfigPath(raw, configKey);
	if (!resolved) return false;
	const leaf = resolved.segments.at(-1);
	return leaf !== undefined && leaf in resolved.source;
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
	warnInvalid: (reason: string, code: ConfigDiagnosticCode) => void,
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
		warnInvalid(`${configKey} must be a boolean`, "PILENS_CFG_0005");
		target[leaf] = undefined;
		return;
	}
	target[leaf] = path.source[leaf];
}
