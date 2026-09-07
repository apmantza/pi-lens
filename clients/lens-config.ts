import type { ConfigDiagnosticCode } from "./config-diagnostic-codes.js";
import {
	resetIgnoredConfigWarnCache,
	warnIgnoredConfigOnce,
} from "./config-warn.js";
import { errorClassName } from "./error-class.js";
import * as path from "node:path";
import {
	assignFlagConfigSection,
	flagConfigSectionKeys,
	flagValueFromConfig,
	getLensFlagSpec,
	GLOBAL_NON_FLAG_CONFIG_SECTIONS,
	LENS_FLAGS,
	readFlagConfigValue,
} from "./lens-flag-registry.js";
import {
	type ConfigLocation,
	CANONICAL_GLOBAL_CONFIG_FILE,
	getPiLensGlobalConfigPath,
	GLOBAL_CONFIG_LOCATIONS,
	LEGACY_ROOT_LSP_KEYS,
} from "./config-locations.js";
// Re-exported so this module's own, pre-existing import sites (`./lens-config.js`
// / `../lens-config.js`) keep working. The function itself now lives in
// `config-locations.ts` (#2426 review round 3, S1) — see the doc comment there.
export { getPiLensGlobalConfigPath } from "./config-locations.js";
import {
	ignoredRecordCollector,
	readConfigDocument,
	reportConfigReadFailure,
	reportPiLensConfigRecords,
	resolveOnePiLensConfigDocument,
} from "./config-resolve.js";
import {
	findNestedProjectMutationValue,
	type PiLensProjectConfig,
} from "./project-lens-config.js";

/**
 * The canonical global location, looked up rather than constructed, so a change
 * to the shared table cannot leave this loader describing a file that is no
 * longer canonical.
 */
function globalCanonicalLocation(): ConfigLocation {
	const location = GLOBAL_CONFIG_LOCATIONS.find(
		(candidate) => candidate.relativePath === CANONICAL_GLOBAL_CONFIG_FILE,
	);
	if (!location) {
		throw new Error(
			`no canonical global config location named ${CANONICAL_GLOBAL_CONFIG_FILE}`,
		);
	}
	return location;
}

type PiLensFormatMode = "deferred" | "immediate";

/** The `{ enabled?: boolean }` section every registry flag key lives under. */
interface PiLensToggleConfig {
	enabled?: boolean;
}

export interface PiLensGlobalConfig {
	startup?: {
		mode?: "quick" | "full" | "minimal";
		scans?: { enabled?: boolean };
	};
	/**
	 * Gitignore-style patterns excluded from pi-lens scans across ALL projects.
	 * Merged at LOWEST precedence: a project `.gitignore` or `.pi-lens.json`
	 * `ignore` (including `!negation`) overrides these. See #252.
	 */
	ignore?: string[];
	dispatch?: {
		/**
		 * Minimum wall-clock budget (ms) for every dispatch runner.
		 * Acts as a floor: effective timeout = max(runner.timeoutMs ?? 30_000, runnerTimeoutFloorMs).
		 * Useful for large monorepos where slow toolchains (e.g. cargo clippy) exceed
		 * any runner's declared budget. Also overridable via PI_LENS_RUNNER_TIMEOUT_FLOOR_MS.
		 */
		runnerTimeoutFloorMs?: number;
	};
	widget?: {
		/** Whether the diagnostics widget is visible when a session starts. */
		visible?: boolean;
	};
	/** Whether pi-lens runs at all this session (`--no-lens`). */
	lens?: PiLensToggleConfig;
	/** Whether unified LSP diagnostics run (`--no-lsp`). */
	lsp?: PiLensToggleConfig;
	/** Whether the test runner fires on write (`--no-tests`). */
	tests?: PiLensToggleConfig;
	/** Whether delta mode limits diagnostics to new ones (`--no-delta`). */
	delta?: PiLensToggleConfig;
	/** Whether the experimental commit/push blocker runs (`--lens-guard`). */
	guard?: PiLensToggleConfig;
	/** Whether the Opengrep auxiliary LSP attaches (`--no-opengrep`). */
	opengrep?: PiLensToggleConfig;
	/** Whether the read-before-edit behavior monitor runs (`--no-read-guard`). */
	readGuard?: PiLensToggleConfig;
	format?: {
		/** Whether auto-formatting is enabled. */
		enabled?: boolean;
		/** When to run auto-formatting after write/edit tool results. */
		mode?: PiLensFormatMode;
	};
	autofix?: {
		/**
		 * Whether the pipeline may apply deterministic linter fixes (Biome,
		 * Ruff, ESLint, ...). Defaults true. A project `.pi-lens.json`
		 * `autofix.enabled` overrides this in either direction (#792).
		 */
		enabled?: boolean;
	};
	actionableWarnings?: {
		/** Write turn-delta fixable warning reports and inject a short advisory. */
		enabled?: boolean;
		/** Enrich warning reports with LSP code-action titles. */
		includeLspCodeActions?: boolean;
		/** Restrict reporting to warnings introduced by this turn. */
		deltaOnly?: boolean;
		autoFix?: {
			/** Experimental conservative agent_end warning autofix. Defaults false. */
			enabled?: boolean;
			/**
			 * Cap on quickfixes applied per turn. Defaults 5. `0` keeps the report
			 * but applies nothing. Documented since #792 but only wired up in #166.
			 */
			maxFixes?: number;
		};
	};
	contextInjection?: {
		/**
		 * Whether pi-lens prepends automatic findings (session-start guidance,
		 * turn-end findings, test findings) into the next model turn via the
		 * `context` hook. Defaults true. Set false to keep tools/LSP/read-guard/
		 * formatting running while avoiding prompt-cache invalidation from injected
		 * messages. Findings are still cached for `lens_diagnostics` / `/lens-health`.
		 */
		enabled?: boolean;
	};
	turnSummary?: {
		/**
		 * Opt-in, transcript-persistent per-turn summary of diagnostics found,
		 * autofixes applied, and autoformats applied (#484). Defaults false —
		 * absence of this key means off. One collapsed/expandable entry per turn,
		 * only emitted when the turn's collection is non-empty.
		 */
		enabled?: boolean;
	};
}

/**
 * Same warn-once-per-(path, reason) contract as project-lens-config.ts's
 * `warnInvalidConfigOnce` — a malformed global config value is logged once
 * and then treated as absent, rather than silently dropped (#792). Since #2418
 * the latch, the log line, the durable ledger row, and the stable-coded
 * notification all live in the one shared seam.
 */
function warnInvalidGlobalConfigOnce(
	configPath: string,
	reason: string,
	code?: ConfigDiagnosticCode,
): void {
	warnIgnoredConfigOnce({
		subsystem: "lens-config",
		file: configPath,
		reason,
		...(code === undefined ? {} : { code }),
	});
}

/** For tests that need to force the warn-once cache to reset between cases. */
export function resetGlobalConfigWarnCache(): void {
	resetIgnoredConfigWarnCache("lens-config");
}

function asConfigObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function loadPiLensGlobalConfig(
	configPath = getPiLensGlobalConfigPath(),
): PiLensGlobalConfig | undefined {
	const location = globalCanonicalLocation();
	// #2445: this used to be `JSON.parse(fs.readFileSync(...))` inside a bare
	// `catch { return undefined; }`, so a malformed `~/.pi-lens/config.json`
	// produced ZERO signal of its own — no log line, no ledger row, no
	// notification. The only thing a user saw was the LSP loader's report of the
	// SAME file, mislabelled "ignoring invalid LSP config", because that loader
	// resolves the canonical global too. Both halves are fixed together: the
	// read/parse failure is reported here, under `lens-config`, and
	// `reportConfigReadFailure` derives the subsystem from the DOCUMENT so the
	// LSP loader's report of this file lands under `lens-config` as well and the
	// warn-once latch collapses the two into one honest notice.
	const outcome = readConfigDocument(configPath);
	if (outcome.status === "missing") return undefined;
	if (outcome.status === "error") {
		reportConfigReadFailure({
			file: configPath,
			location,
			tier: "global",
			error: outcome.error,
			sourceText: outcome.sourceText,
		});
		return undefined;
	}
	// Every notice this projection composes is BUFFERED and bounded once, at the
	// end, through the SAME `ignoredRecordCollector` the project loader uses
	// (#2426 review round 6, F3; round 7, F2). It used to report each one the
	// moment it was composed, with no collector anywhere in this function, so
	// the unknown-top-level-key scan below — whose count is the number of keys
	// the user typed — put 100 notifications on screen for a 100-key
	// `~/.pi-lens/config.json` while the project loader's identical scan of an
	// identical file produced 19 and a count. Two changelog fragments already
	// claimed one bound for every producer; this is the producer that did not
	// have one.
	//
	// Round 6 gave it that bound by COPYING the project loader's, which left two
	// spellings of one record literal differing only in a tier. Round 7 moved
	// the seam into `config-resolve.ts`, which both loaders already import, and
	// made the tier an argument. This loader never passes a `{ parseError }`:
	// its read/parse failure is reported above by `reportConfigReadFailure`,
	// before the projection starts.
	//
	// The flush is in a `finally` so a throw in the projection still delivers
	// what was composed before it, on top of the whole-config record the catch
	// adds.
	const { note, records: notedRecords } = ignoredRecordCollector(
		configPath,
		"global",
	);
	try {
		const parsed = outcome.value;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			// The other half of the same silence: a file that PARSES but is a list
			// or a scalar is not a config either, and was dropped without a word.
			note("top-level value must be an object");
			return undefined;
		}

		// Through the #2425 core (#2426). The canonical global file is resolved as
		// a single `global`-tier source against the canonical schema, so the depth
		// bound, the prototype-key policy and the declared `lsp.*` types apply to
		// `~/.pi-lens/config.json` exactly as they do to `.pi-lens.json`. The
		// field-by-field projection below is unchanged and keeps owning the
		// per-key prose its tests assert on — the core validates the SHAPE, this
		// function still decides what a bad value is called.
		const document = {
			tier: "global" as const,
			file: configPath,
			location,
			value: parsed,
		};
		const resolved = resolveOnePiLensConfigDocument(document);
		// EVERY record this document produced (#2426 review round 3, F1) — not
		// filtered to what this loader "owns". `reportPiLensConfigRecords` derives
		// the reporting subsystem per record; the warn-once latch collapses a
		// duplicate report of the SAME record from the LSP loader's resolution of
		// this same file (it resolves the canonical global too) into one notice.
		reportPiLensConfigRecords(resolved.records);
		const raw = resolved.value;
		const warnInvalid = note;
		const config: Record<string, unknown> = {};

		for (const spec of LENS_FLAGS) {
			if (spec.readGlobal) continue;
			assignFlagConfigSection(raw, config, spec.configKey, warnInvalid);
		}

		const ignore = Array.isArray(raw.ignore)
			? raw.ignore.filter((p): p is string => typeof p === "string")
			: undefined;
		if (ignore && ignore.length > 0) config.ignore = ignore;

		const startup = asConfigObject(raw.startup);
		if (startup) {
			const startupConfig: PiLensGlobalConfig["startup"] = {};
			const mode = startup.mode;
			const scans = asConfigObject(startup.scans);
			if (mode === "quick" || mode === "full" || mode === "minimal")
				startupConfig.mode = mode;
			else if ("mode" in startup)
				warnInvalid('startup.mode must be "quick", "full", or "minimal"');
			if (scans) {
				if (typeof scans.enabled === "boolean") {
					startupConfig.scans = { enabled: scans.enabled };
				} else if ("enabled" in scans)
					warnInvalid("startup.scans.enabled must be a boolean");
			}
			if (startupConfig.mode !== undefined || startupConfig.scans !== undefined)
				config.startup = startupConfig;
		}

		const dispatch = asConfigObject(raw.dispatch);
		if (dispatch) {
			const floor = dispatch.runnerTimeoutFloorMs;
			if (typeof floor === "number" && Number.isFinite(floor) && floor > 0) {
				config.dispatch = { runnerTimeoutFloorMs: floor };
			} else {
				// #533: warn only when the key is PRESENT but malformed — an absent
				// key stays silent so a config that never mentions it is not falsely
				// flagged. Same warn-once path as the maxFixes case below.
				if ("runnerTimeoutFloorMs" in dispatch) {
					warnInvalid(
						"dispatch.runnerTimeoutFloorMs must be a positive finite number",
					);
				}
				config.dispatch = { runnerTimeoutFloorMs: undefined };
			}
		}

		const autoFix = asConfigObject(
			asConfigObject(raw.actionableWarnings)?.autoFix,
		);
		if (autoFix && "maxFixes" in autoFix) {
			if (
				typeof autoFix.maxFixes === "number" &&
				Number.isFinite(autoFix.maxFixes) &&
				autoFix.maxFixes >= 0
			) {
				config.actionableWarnings ??= {};
				const warnings = config.actionableWarnings as Record<string, unknown>;
				warnings.autoFix ??= {};
				(warnings.autoFix as Record<string, unknown>).maxFixes = Math.floor(
					autoFix.maxFixes,
				);
			} else {
				warnInvalid(
					"actionableWarnings.autoFix.maxFixes must be a non-negative finite number",
				);
			}
		}

		const widget = asConfigObject(raw.widget);
		if (widget) {
			if (typeof widget.visible === "boolean") {
				config.widget = { visible: widget.visible };
			} else {
				// #533: present-but-wrong-type warns; absent stays silent.
				if ("visible" in widget) {
					warnInvalid("widget.visible must be a boolean");
				}
				config.widget = { visible: undefined };
			}
		}

		const format = asConfigObject(raw.format);
		if (format) {
			config.format ??= {};
			const formatSection = config.format as Record<string, unknown>;
			if (format.mode === "immediate" || format.mode === "deferred") {
				formatSection.mode = format.mode;
			} else {
				// #533: a present-but-invalid mode (e.g. "immedaite") warns and // spellchecker:disable-line
				// falls back; an absent mode stays silent.
				if ("mode" in format) {
					warnInvalid('format.mode must be "immediate" or "deferred"');
				}
				formatSection.mode = undefined;
			}
		}

		// #533 hygiene: a completely unknown top-level key (e.g. a typo like
		// `lps` for `lsp`) is otherwise dropped silently, so a setting the user
		// thought they made does nothing with no signal. Warn once per key. The
		// recognized set is single-sourced (#883): the flag sections derived
		// from the registry plus the declared non-flag global sections
		// (`GLOBAL_NON_FLAG_CONFIG_SECTIONS`, which co-locates `$schema` and the
		// hand-parsed namespaces beside the registry). Adding a flag needs no
		// edit here; adding a namespace is a one-line edit in that one constant.
		//
		// `LEGACY_ROOT_LSP_KEYS` joins them for #2426 review round 4, F1. The four
		// legacy root LSP keys are read out of THIS file by the LSP loader and
		// their values are applied, exactly as they are in a project
		// `.pi-lens.json` — where `PROJECT_FOREIGN_CONFIG_NAMESPACES` has
		// tolerated them since #2426. The global scan never got the same
		// treatment, so `~/.pi-lens/config.json` with a root `warmFiles` both
		// honored the setting and called it a typo in the same session. Spread
		// from the registry-derived list rather than restated: `lens-config.ts`
		// already imports `config-locations.ts`, which derives it from
		// `DEPRECATED_CONFIG_SURFACES`, so the accepted set and the removal
		// schedule cannot drift apart and there is no second copy of the names.
		const knownGlobalConfigKeys = new Set<string>([
			...flagConfigSectionKeys(LENS_FLAGS),
			...GLOBAL_NON_FLAG_CONFIG_SECTIONS,
			...LEGACY_ROOT_LSP_KEYS,
		]);
		for (const key of Object.keys(raw)) {
			if (!knownGlobalConfigKeys.has(key)) {
				warnInvalid(
					`unknown key "${key}" is not a recognized pi-lens setting (check for a typo); ignored`,
				);
			}
		}

		return config as PiLensGlobalConfig;
	} catch (error) {
		// #2426 review round 5, S-C. The other half of #2445's silence. The
		// read/parse failure above now reports, but everything AFTER the parse —
		// the resolution through the core and the field-by-field projection —
		// still sat under a bare `catch { return undefined }`, so a throw in any
		// of it dropped the WHOLE global config with no log line, no ledger row
		// and no notification: pi-lens ran on defaults and said nothing, which is
		// the exact defect #2445 was filed for.
		//
		// `PILENS_CFG_0008` ("config resolution failed; whole configuration
		// ignored") rather than `0001`, and the ERROR CLASS only, never its
		// message, which could quote the file — the same rule `resolveConfig`'s
		// own guard follows for the same reason. Round 5 used `0005` here, which
		// is registered as a per-FIELD rejection: a user matching on it would
		// have expected one setting to be missing rather than the whole file
		// (#2426 review round 6, S1). `errorClassName` (#2451) is the ONE
		// implementation of "class name, never the message" — this loader
		// already imports `config-warn.js` for the rest of the seam, so it could
		// call `normalizeParseErrorReason({ classOnly: true })` directly, but
		// calling the same leaf `config-warn.ts` itself delegates to keeps every
		// caller of this guarantee, `config-core/` included, on ONE
		// implementation rather than two that happen to agree today.
		warnInvalidGlobalConfigOnce(
			configPath,
			`global config could not be interpreted (${errorClassName(error)}); configuration ignored`,
			"PILENS_CFG_0008",
		);
		return undefined;
	} finally {
		reportPiLensConfigRecords(notedRecords());
	}
}

export function getGlobalIgnorePatterns(configPath?: string): string[] {
	return loadPiLensGlobalConfig(configPath)?.ignore ?? [];
}

export function getGlobalWidgetDefaultVisible(configPath?: string): boolean {
	return loadPiLensGlobalConfig(configPath)?.widget?.visible !== false;
}

/** Per-turn quickfix cap; undefined means "use the built-in default of 5". */
export function getGlobalActionableWarningMaxFixes(
	configPath?: string,
): number | undefined {
	return loadPiLensGlobalConfig(configPath)?.actionableWarnings?.autoFix
		?.maxFixes;
}

/** Which tier decided a resolved flag's value — for provenance in debug/skip logs (#792). */
export type PiLensFlagSource =
	| "env"
	| "cli"
	| "project"
	| `nested-project:${string}`
	| "global"
	| "default";

export interface ResolvedPiLensFlag {
	value: boolean | string | undefined;
	source: PiLensFlagSource;
}

/**
 * Resolve a flag AND report which config tier decided it — same precedence
 * as {@link resolvePiLensFlag} (which now delegates here), just also
 * returning the `source` so callers can log e.g.
 * "(--no-autofix, source=project)" instead of a bare boolean (#792).
 *
 * Every tier is driven by `clients/lens-flag-registry.ts` (#166): the spec's
 * `configKey` is read out of each config object rather than matched by a
 * per-flag branch, so a new toggle needs no change here at all.
 *
 * Precedence: env → cli → nested-project → project → global → default.
 * Project tiers apply to `scope: "project"` flags only (maintainer decision —
 * project wins over global, including re-enabling; only an explicit CLI
 * disabling flag outranks project config). A name with no registry entry
 * passes its CLI value straight through, which is how untyped string flags
 * like `--lens-opengrep-config` keep working.
 */
export function resolvePiLensFlagWithSource(
	name: string,
	value: boolean | string | undefined,
	config: PiLensGlobalConfig | undefined,
	projectConfig?: PiLensProjectConfig,
	editedFilePath?: string,
	projectRoot?: string,
): ResolvedPiLensFlag {
	const spec = getLensFlagSpec(name);
	if (spec?.env && process.env[spec.env] === "1") {
		return { value: true, source: "env" };
	}
	if (value) return { value, source: "cli" };
	if (!spec) return { value, source: "default" };

	if (spec.scope === "project") {
		const nested =
			editedFilePath && projectRoot
				? findNestedProjectMutationValue(spec, editedFilePath, projectRoot)
				: undefined;
		if (nested) {
			return {
				value: flagValueFromConfig(spec, nested.value),
				source:
					path.resolve(nested.dir) === path.resolve(projectRoot as string)
						? "project"
						: (`nested-project:${nested.dir}` as const),
			};
		}
		const projectValue = readFlagConfigValue(projectConfig, spec.configKey);
		if (projectValue !== undefined) {
			return {
				value: flagValueFromConfig(spec, projectValue),
				source: "project",
			};
		}
	}

	const globalValue = spec.readGlobal
		? spec.readGlobal((config ?? {}) as Record<string, unknown>)
		: readFlagConfigValue(config, spec.configKey);
	if (globalValue !== undefined) {
		return { value: flagValueFromConfig(spec, globalValue), source: "global" };
	}

	return { value: spec.default, source: "default" };
}

export function resolvePiLensFlag(
	name: string,
	value: boolean | string | undefined,
	config: PiLensGlobalConfig | undefined,
	projectConfig?: PiLensProjectConfig,
	editedFilePath?: string,
	projectRoot?: string,
): boolean | string | undefined {
	return resolvePiLensFlagWithSource(
		name,
		value,
		config,
		projectConfig,
		editedFilePath,
		projectRoot,
	).value;
}
