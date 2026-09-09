/**
 * The ONE config resolution path (#2426).
 *
 * Every pi-lens config file — canonical or legacy, project or global — is read,
 * validated and layered here, through `config-core`'s `resolveConfig` over the
 * canonical schema in `config-schema.ts`. The three exported loaders
 * (`loadLSPConfig`, `loadPiLensGlobalConfig`, `loadPiLensProjectConfig`) keep
 * their names and return types and become PROJECTIONS of what this module
 * resolves, so their ~20 call sites are untouched.
 *
 * THE DOCUMENTED LOOKUP ORDER, lowest precedence first:
 *
 *   builtin -> global -> project root -> nested-project -> env -> cli -> host
 *
 * It is `config-core`'s own `SOURCE_TIERS`, not a second ordering: this
 * module places files into tiers and the core sorts them. `docs/configuration.md`
 * documents the same order once, and `tests/clients/config-resolve.test.ts`
 * walks it.
 *
 * Only THREE of those tiers are populated here — `global`, `project` and
 * `nested-project` — because those are the tiers config FILES live in.
 * `builtin`, `env`, `cli` and `host` are reserved (#2427 wires env/CLI, #2416
 * the host tier); today's env vars and CLI flags reach a setting through their
 * own accessors, and `docs/configuration.md` states that precedence rather than
 * implying this resolution already carries it.
 *
 * WITHIN a tier, the canonical file is added LAST and therefore wins, because
 * `merge` keeps caller order on a precedence tie. That is the whole deprecation
 * story in one line: a legacy file is still read, and it loses to the file the
 * user is being told to move to.
 *
 * LEGACY ROOT LSP KEYS ARE NORMALIZED INTO THE `lsp` NAMESPACE HERE, at source
 * injection, and nowhere else (#2427 review round 2, F1). Every LSP setting has
 * two spellings during the deprecation window — `disabledServers` at a
 * document's root and `lsp.disabledServers` inside it — and leaving both in
 * place gave the schema TWO nodes for one setting. `merge()` then resolved each
 * node independently: two deny unions that never saw each other's tiers, and
 * two object merges that never saw each other's entries. A projection could
 * only pick one, and picking the canonical one meant a global denial written in
 * the legacy spelling disappeared the moment any project file mentioned the
 * canonical one — the operator-denial-lifted-by-repository-content defect
 * #2415 AC 3 forbids, arriving through the migration instead of through the
 * merge strategy.
 *
 * An earlier draft rejected this rewrite because it would inject an `lsp` key
 * into `PiLensProjectConfig.raw` that was never in the user's file. That
 * objection is why the normalization lives HERE and not in
 * `resolveOnePiLensConfigDocument`: `.raw` comes from the single-document path,
 * which still merges a document exactly as written. Only this multi-document
 * resolution — whose two consumers are `loadLSPConfig` and `effectiveConfig`,
 * both of which read the `lsp` section and nothing else — normalizes.
 *
 * The mapping is `canonicalKeyFor`'s, the one the deprecation records already
 * publish, so "where does this key move to" is answered once. Within a single
 * document the canonical spelling still wins a collision, which is the rule
 * `lspSectionOf` used to apply at projection time; across documents `merge()`
 * now applies the ordinary tier precedence and the deny union to ONE node.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ConfigDiagnosticCode,
	type DeprecatedConfigSurface,
	DEPRECATED_CONFIG_SURFACES,
} from "./config-diagnostic-codes.js";
import {
	type ConfigLocation,
	CANONICAL_GLOBAL_CONFIG_FILE,
	CANONICAL_PROJECT_CONFIG_FILE,
	GLOBAL_CONFIG_LOCATIONS,
	LEGACY_ROOT_LSP_KEYS,
	LSP_NAMESPACE_KEY,
	PROJECT_CONFIG_LOCATIONS,
	configSearchDirs,
} from "./config-locations.js";
// The core's halves are imported directly rather than through
// `config-core/index.js` (#2426). The barrel re-exports the whole vocabulary
// including `process-spec.js`, which reaches `project-trust.js` and the
// degradation ledger; a module that only resolves a config has no use for that
// and, sitting downstream of `file-utils.ts` as every config loader does, would
// close three import cycles by importing it. `resolveConfig` is still the one
// supported way into the pipeline — `merge()` is deliberately not imported here.
import { type RawConfigSource, resolveConfig } from "./config-core/resolve.js";
import {
	finalizeRecords,
	type MigrationRecord,
	migrationSubject,
	type RecordAnchor,
} from "./config-core/records.js";
import {
	type Provenance,
	SOURCE_TIERS,
	type SourceTier,
} from "./config-core/provenance.js";
import { PI_LENS_CONFIG_SCHEMA } from "./config-schema.js";
import {
	type IgnoredConfigSubsystem,
	normalizeParseErrorReason,
	warnIgnoredConfigOnce,
} from "./config-warn.js";
import { homeRelativePath } from "./path-utils.js";

/** What reading one candidate path produced. */
export type ConfigReadOutcome =
	| { readonly status: "missing" }
	| {
			readonly status: "error";
			readonly error: unknown;
			/**
			 * The text that was actually read, when a `JSON.parse` failure is what
			 * produced this outcome (#2451) — never set for an `fs.readFileSync`
			 * failure, since nothing was ever read then. Lets `normalizeParseErrorReason`
			 * locate a position-free `SyntaxError` in the source it came from,
			 * instead of losing all locality the way #2431's own fix did.
			 */
			readonly sourceText?: string;
	  }
	| { readonly status: "ok"; readonly value: unknown };

/**
 * Read and JSON-parse one config file.
 *
 * Deliberately does NOT warn: the three loaders each render their own prose
 * (`ignoring invalid LSP config …` / `… global config …` / `… project config …`)
 * and their tests assert on it, so the decision of what to say about a bad file
 * stays with the loader while the reading itself is shared.
 */
export function readConfigDocument(file: string): ConfigReadOutcome {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return { status: "missing" };
		}
		return { status: "error", error };
	}
	try {
		return { status: "ok", value: JSON.parse(text) as unknown };
	} catch (error) {
		return { status: "error", error, sourceText: text };
	}
}

/** One config file that exists on disk and parsed. */
export interface ConfigDocument {
	readonly tier: SourceTier;
	readonly file: string;
	readonly location: ConfigLocation;
	readonly value: unknown;
}

/**
 * A config document that exists on disk but could not be read or parsed.
 *
 * Carries the LOCATION and the TIER, not just the path (#2445): which
 * subsystem owns the failure is a property of the FILE, not of whichever
 * loader happened to open it. `loadLSPConfig` resolves `~/.pi-lens/config.json`
 * and `.pi-lens.json` too, and reporting those under `lsp-config` told a user
 * their "LSP config" was invalid when the file they had broken was the pi-lens
 * global or project config.
 */
export interface ConfigReadFailure {
	readonly file: string;
	readonly location: ConfigLocation;
	readonly tier: SourceTier;
	readonly error: unknown;
	/** See `ConfigReadOutcome`'s `sourceText` (#2451): unset for an `fs` failure. */
	readonly sourceText?: string;
}

export interface ResolvePiLensConfigOptions {
	/** Directory the project/nested tiers are discovered from. */
	readonly cwd?: string;
	/** Absolute path of the canonical machine-global config. */
	readonly globalConfigPath?: string;
	/** Absolute path of the machine-global pi-lens directory (`~/.pi-lens`). */
	readonly globalDir?: string;
	/** The `$HOME` ceiling for the project walk. Test seam. */
	readonly homeDir?: string;
	/**
	 * Called for a file that exists but could not be read or parsed. Production
	 * callers pass {@link reportConfigReadFailure}, which derives the reporting
	 * subsystem from the failing DOCUMENT.
	 */
	readonly onReadError?: (failure: ConfigReadFailure) => void;
}

export interface PiLensConfigResolution {
	/** The merged configuration. */
	readonly value: Record<string, unknown>;
	readonly provenance: ReadonlyMap<string, Provenance>;
	/** Validation drops AND deprecation notices, in discovery order. */
	readonly records: readonly MigrationRecord[];
	/** The files that actually contributed, lowest precedence first. */
	readonly documents: readonly ConfigDocument[];
}

/**
 * The canonical GLOBAL config path this resolution uses — for READING it and
 * for naming it in a migration notice, from one expression (#2426 review round
 * 2, F1).
 *
 * The two used to be computed separately: the read came from
 * `options.globalConfigPath` (`getPiLensGlobalConfigPath()`, `$HOME`-derived
 * unless `PI_LENS_CONFIG_PATH` overrides it) while the notice was recomputed as
 * `dirname(<legacy file>) + config.json` — and the legacy file lives under
 * `getGlobalPiLensDir()`, which `PI_LENS_HOME` relocates. Set `PI_LENS_HOME`
 * without `PI_LENS_CONFIG_PATH` and the two diverge, so the notice named a file
 * the resolver never reads: a user who followed it moved their settings into a
 * file that does nothing. Deriving both from here makes "the path we name" and
 * "the path we read" the same value by construction rather than by agreement.
 */
function canonicalGlobalFile(
	options: ResolvePiLensConfigOptions,
): string | undefined {
	if (options.globalConfigPath !== undefined) return options.globalConfigPath;
	return options.globalDir === undefined
		? undefined
		: path.join(options.globalDir, CANONICAL_GLOBAL_CONFIG_FILE);
}

function collectDocuments(
	dir: string,
	locations: readonly ConfigLocation[],
	tier: SourceTier,
	onReadError: ((failure: ConfigReadFailure) => void) | undefined,
): ConfigDocument[] {
	const documents: ConfigDocument[] = [];
	for (const location of locations) {
		const file = path.join(dir, location.relativePath);
		const outcome = readConfigDocument(file);
		if (outcome.status === "missing") continue;
		if (outcome.status === "error") {
			onReadError?.({
				file,
				location,
				tier,
				error: outcome.error,
				sourceText: outcome.sourceText,
			});
			continue;
		}
		documents.push({ tier, file, location, value: outcome.value });
	}
	return documents;
}

/**
 * Assemble every config document for a resolution, lowest precedence first.
 *
 * The project walk is ceiling-bounded by `configSearchDirs`. The OUTERMOST
 * config-bearing directory is the `project` tier and everything nearer the cwd
 * is `nested-project`, which is what makes "nearest wins, per field" fall out
 * of the core's tier precedence instead of being re-implemented here.
 */
function collectPiLensConfigDocuments(
	options: ResolvePiLensConfigOptions,
): ConfigDocument[] {
	const documents: ConfigDocument[] = [];
	const { globalDir, onReadError } = options;
	const globalConfigPath = canonicalGlobalFile(options);

	if (globalDir !== undefined || globalConfigPath !== undefined) {
		for (const location of GLOBAL_CONFIG_LOCATIONS) {
			const file =
				location.relativePath === CANONICAL_GLOBAL_CONFIG_FILE
					? globalConfigPath
					: globalDir === undefined
						? undefined
						: path.join(globalDir, location.relativePath);
			if (file === undefined) continue;
			const outcome = readConfigDocument(file);
			if (outcome.status === "missing") continue;
			if (outcome.status === "error") {
				onReadError?.({
					file,
					location,
					tier: "global",
					error: outcome.error,
					sourceText: outcome.sourceText,
				});
				continue;
			}
			documents.push({ tier: "global", file, location, value: outcome.value });
		}
	}

	if (options.cwd !== undefined) {
		// Innermost first from the walk; reversed so the OUTERMOST directory is
		// emitted first and lands in the lower-precedence `project` tier.
		const dirs = configSearchDirs(
			options.cwd,
			options.homeDir ?? os.homedir(),
		).reverse();
		const bearing = dirs
			.map((dir) => ({
				dir,
				found: collectDocuments(
					dir,
					PROJECT_CONFIG_LOCATIONS,
					"project",
					onReadError,
				),
			}))
			.filter((entry) => entry.found.length > 0);
		bearing.forEach((entry, index) => {
			const tier: SourceTier = index === 0 ? "project" : "nested-project";
			for (const document of entry.found) documents.push({ ...document, tier });
		});
	}

	return documents;
}

/**
 * One contributing config document, reduced to what a telemetry or
 * introspection surface may carry: WHICH file, at which tier, and whether the
 * location is on a removal schedule. Never the document's value.
 */
export interface ConfigDocumentSummary {
	readonly tier: SourceTier;
	/** Home-relative when the file is under `$HOME`. */
	readonly file: string;
	/** True for a location on a removal schedule (`DEPRECATED_CONFIG_SURFACES`). */
	readonly legacy: boolean;
}

/**
 * The redacted shape of a resolution: what contributed, how much each tier
 * decided, and how many records the resolution produced.
 *
 * ONE definition, two consumers (#2526). `effectiveConfig` embeds it in the
 * `pilens_effective_config` view and `loadLSPConfig` writes it to the
 * `config_resolved` latency phase, so the answer a user reads on demand and
 * the one the session-start record carries cannot drift apart — the
 * single-source-of-truth rule applied to an observability surface rather than
 * to a registry.
 */
export interface ConfigResolutionSummary {
	readonly documents: readonly ConfigDocumentSummary[];
	/** How many resolved leaves each tier decided. Zero-filled for every tier. */
	readonly countsByTier: Readonly<Record<SourceTier, number>>;
	/** Migration/notice records the resolution produced (`PILENS_CFG_*`). */
	readonly recordCount: number;
}

/** A zero for every tier, so a consumer never has to test for an absent key. */
function emptyTierCounts(): Record<SourceTier, number> {
	return Object.fromEntries(SOURCE_TIERS.map((tier) => [tier, 0])) as Record<
		SourceTier,
		number
	>;
}

/**
 * Project a resolution onto its redacted summary.
 *
 * Values never appear: a document contributes its PATH (home-relative), its
 * tier and its legacy flag, and nothing else — the same structural redaction
 * `pilens_effective_config` applies, spelled once rather than twice (rule 3 of
 * `clients/effective-config.ts`: the redacted view is the only view).
 *
 * Pure and synchronous: it reads a resolution the caller already performed and
 * resolves nothing itself, so no caller can turn "report what we resolved"
 * into a second walk of the config tree (#2513's facade rule).
 */
export function summarizeConfigResolution(
	resolution: PiLensConfigResolution,
	homeDir?: string,
): ConfigResolutionSummary {
	const countsByTier = emptyTierCounts();
	for (const entry of resolution.provenance.values()) {
		countsByTier[entry.tier] += 1;
	}
	return {
		documents: resolution.documents.map((document) => ({
			tier: document.tier,
			file: homeRelativePath(document.file, homeDir),
			legacy: document.location.legacy,
		})),
		countsByTier,
		recordCount: resolution.records.length,
	};
}

/** Resolve every discovered document into one configuration. */
export function resolvePiLensConfig(
	options: ResolvePiLensConfigOptions,
): PiLensConfigResolution {
	const documents = collectPiLensConfigDocuments(options);
	const sources = configSources(documents);
	const resolution = resolveConfig<Record<string, unknown>>({
		sources,
		schema: PI_LENS_CONFIG_SCHEMA,
	});
	return {
		value: resolution.resolved.value ?? {},
		provenance: resolution.resolved.provenance,
		records: finalizeRecords(
			[
				...resolution.records,
				...deprecationRecords(
					documents,
					options.homeDir ?? os.homedir(),
					canonicalGlobalFile(options),
				),
			],
			documentAnchor(documents),
			// The core ALREADY truncated (#2426 review round 6, F1). Its drop count
			// is seeded here so the one `PILENS_CFG_0007` a user reads names the
			// whole truncation rather than the part this bound performed.
			resolution.droppedRecordCount,
		),
		documents,
	};
}

/**
 * Resolve ONE document — the shape both single-file loaders need.
 *
 * Still the core's pipeline, not a shortcut around it: the value is validated
 * against the canonical schema (depth bound, prototype-key policy, the declared
 * `lsp.*` types) and merged from one source, so a single-file loader and the
 * multi-file one cannot disagree about what a value means.
 *
 * It deliberately does NOT normalize legacy root LSP keys into the `lsp`
 * namespace the way `resolvePiLensConfig` does (#2427 review round 2, F1).
 * This path's two callers project the pi-lens sections of ONE file and hand
 * the resolved value out as `PiLensProjectConfig.raw`, which is documented and
 * tested as the parsed document; relocating a key inside it would put an `lsp`
 * section in `raw` that the user's file never contained. The relocation exists
 * so that ONE key seen at SEVERAL tiers reaches one schema node, and a
 * single-document resolution has no tiers to reconcile.
 *
 * The visible consequence is small and worth naming: a wrong-TYPED legacy root
 * LSP key (`warmFiles: true`) is validated against the typed `lsp.*` node only
 * in the multi-document path, so the LSP loader reports it and the two
 * single-file loaders do not. A session runs both, and the warn-once latch
 * unions their notices, so a user loses nothing — they gain one accurate
 * notice.
 */
export function resolveOnePiLensConfigDocument(
	document: ConfigDocument,
	homeDir: string = os.homedir(),
): {
	readonly value: Record<string, unknown>;
	readonly records: readonly MigrationRecord[];
} {
	const resolution = resolveConfig<Record<string, unknown>>({
		sources: [
			{ tier: document.tier, file: document.file, value: document.value },
		],
		schema: PI_LENS_CONFIG_SCHEMA,
	});
	return {
		value: resolution.resolved.value ?? {},
		records: finalizeRecords(
			[...resolution.records, ...deprecationRecords([document], homeDir)],
			documentAnchor([document]),
			// Same double bound as the multi-document path above (round 6, F1).
			resolution.droppedRecordCount,
		),
	};
}

/**
 * The anchor for a record list produced from these documents: the
 * highest-precedence one — the file whose values would have won, and the one a
 * user reading a config notice is looking at.
 *
 * The list's BOUND, its overflow record, and the reserved slot that record
 * occupies all live in `config-core/records.ts` (#2426 review round 5,
 * F-A/F-B/S-A). This module used to carry its own copy of them, the project
 * loader carried a second, and the project loader's legacy path carried none
 * at all — the shape the single-source rule exists to catch. What is left here
 * is the one thing `config-core` cannot know: which of the caller's documents
 * is the anchor.
 */
function documentAnchor(
	documents: readonly ConfigDocument[],
): RecordAnchor | undefined {
	const last = documents[documents.length - 1];
	return last === undefined ? undefined : { file: last.file, tier: last.tier };
}

/**
 * The `ConfigLocation` for a project-relative basename, for a caller that
 * discovered the file through its own (cached) walk rather than through
 * `collectPiLensConfigDocuments`. Falls back to the canonical location so an
 * unrecognized basename is never reported as deprecated.
 */
export function projectLocationFor(file: string): ConfigLocation {
	const base = path.basename(file);
	return (
		PROJECT_CONFIG_LOCATIONS.find(
			(candidate) => path.posix.basename(candidate.relativePath) === base,
		) ?? PROJECT_CONFIG_LOCATIONS[PROJECT_CONFIG_LOCATIONS.length - 1]
	);
}

// --- deprecation records (#2418 codes 0002 / 0003, #2426 is their producer) ---

const WINDOW_BY_SURFACE: ReadonlyMap<string, DeprecatedConfigSurface> = new Map(
	DEPRECATED_CONFIG_SURFACES.map(
		(row) => [row.surface as string, row as DeprecatedConfigSurface] as const,
	),
);

function windowSuffix(surface: string | undefined): string {
	const row =
		surface === undefined ? undefined : WINDOW_BY_SURFACE.get(surface);
	return row
		? ` (deprecated since ${row.deprecatedSince}; read for the last time before ${row.removeNotBefore})`
		: "";
}

/**
 * The canonical file a legacy document's keys belong in.
 *
 * `globalFile` is THREADED from the resolution that read the legacy document,
 * never recomputed from that document's own directory (#2426 review round 2,
 * F1) — see `canonicalGlobalFile`. The sibling fallback survives only for a
 * caller that resolves ONE document in isolation and names no canonical global
 * (no production caller does; `resolveOnePiLensConfigDocument`'s two callers
 * pass a project document and a canonical global one respectively), and it is
 * the only path this module can name at all in that case.
 */
function canonicalDestination(
	document: ConfigDocument,
	homeDir: string,
	globalFile: string | undefined,
): string {
	if (document.tier === "global") {
		return homeRelativePath(
			globalFile ??
				path.join(path.dirname(document.file), CANONICAL_GLOBAL_CONFIG_FILE),
			homeDir,
		);
	}
	return CANONICAL_PROJECT_CONFIG_FILE;
}

/**
 * The `lsp`-namespace key a document ROOT key normalizes to, or `undefined`
 * when the key stays where it is.
 *
 * THE mapping, shared with `canonicalKeyFor` below so the key a deprecation
 * record tells the user to move to and the key the resolution actually merges
 * under are the same key by construction. An LSP-SCOPED legacy file
 * (`pi-lsp.json`, `.pi-lens/lsp.json`) is wholly what a canonical file now
 * carries under `lsp`, so every RECOGNIZED root key of one moves; a canonical
 * or non-LSP legacy file moves only the four registry-derived legacy root keys.
 * An unrecognized key is left alone in both cases — it is not a pi-lens
 * setting, and relocating it would invent a meaning for it.
 */
function lspNamespaceKeyFor(
	document: ConfigDocument,
	key: string,
): string | undefined {
	if (key === LSP_NAMESPACE_KEY) return undefined;
	if (document.location.lspScoped) {
		return recognizedKeysFor(document.location).has(key) ? key : undefined;
	}
	return LEGACY_ROOT_LSP_KEYS.includes(key) ? key : undefined;
}

/**
 * Assign one raw, not-yet-validated value under a user-chosen key.
 *
 * `defineProperty` rather than `=` for the reason `config-core/safe-object.ts`
 * spells out: `out["__proto__"] = x` runs an inherited SETTER instead of
 * creating a property. This split runs BEFORE `validate()`, so it is the one
 * place in this module that touches user-chosen key names, and it hands every
 * such key through untouched for the core to reject and record.
 */
function assignRaw(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	Object.defineProperty(target, key, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

/**
 * The sources a resolution merges, with every document's legacy root LSP keys
 * moved into the `lsp` namespace (#2427 review round 2, F1).
 *
 * A document that carries none is passed through UNCHANGED — the overwhelming
 * majority, and the case that must cost nothing. One that does becomes TWO
 * sources at the same tier and file: the relocated keys first, the rest of the
 * document (its own `lsp` namespace included) second. Two sources rather than
 * one merged object because the second still carries whatever the document
 * spelled at `lsp`, so a malformed `lsp` keeps producing its `PILENS_CFG_0004`
 * while the relocated keys survive beside it; and because caller order at an
 * equal tier is what `merge()` uses to break a tie, putting the canonical
 * spelling second is exactly the canonical-wins-per-key rule `lspSectionOf`
 * used to apply at projection time.
 *
 * The relocated keys are STRIPPED from the second source rather than left in
 * place. Leaving them would keep the legacy schema node populated, and a
 * malformed legacy key would then record the same `PILENS_CFG_0004` twice —
 * once per spelling — for one mistake in one file.
 *
 * A deny key is the one place the intra-document tie is not "canonical wins":
 * `merge()` sends `lsp.disabledServers` to `config-core/deny.ts`, which unions
 * every contribution. A file spelling BOTH `disabledServers` and
 * `lsp.disabledServers` therefore denies both lists. That is the monotonic
 * answer and the only safe one — a denial silently dropped because the user
 * half-migrated the file it was written in is the defect this whole change
 * exists to remove.
 */
function configSources(
	documents: readonly ConfigDocument[],
): RawConfigSource[] {
	const sources: RawConfigSource[] = [];
	for (const document of documents) {
		const value = document.value;
		const namespaced: Record<string, unknown> = {};
		const rest: Record<string, unknown> = {};
		for (const key of topLevelKeys(value)) {
			const entry = (value as Record<string, unknown>)[key];
			const target = lspNamespaceKeyFor(document, key);
			if (target === undefined) assignRaw(rest, key, entry);
			else assignRaw(namespaced, target, entry);
		}
		const base = { tier: document.tier, file: document.file };
		if (Object.keys(namespaced).length === 0) {
			sources.push({ ...base, value });
			continue;
		}
		sources.push({ ...base, value: { [LSP_NAMESPACE_KEY]: namespaced } });
		sources.push({ ...base, value: rest });
	}
	return sources;
}

/**
 * The canonical KEY a legacy key moves to.
 *
 * Carried on the record (`canonicalKey`) rather than only rendered into the
 * message, so the auto-migrator #2426 explicitly defers can be a pure function
 * over these records instead of re-parsing prose.
 */
function canonicalKeyFor(document: ConfigDocument, key: string): string {
	const namespaced = lspNamespaceKeyFor(document, key);
	return namespaced === undefined ? key : `${LSP_NAMESPACE_KEY}.${namespaced}`;
}

function topLevelKeys(value: unknown): string[] {
	return value && typeof value === "object" && !Array.isArray(value)
		? Object.keys(value as Record<string, unknown>)
		: [];
}

/** The `properties` key names of a JSON-Schema-shaped node. */
function schemaPropertyKeys(node: unknown): string[] {
	const properties = (node as { properties?: unknown } | undefined)?.properties;
	return properties !== null &&
		typeof properties === "object" &&
		!Array.isArray(properties)
		? Object.keys(properties as Record<string, unknown>)
		: [];
}

/**
 * The top-level keys a pi-lens config document may legitimately carry — READ
 * OFF the canonical schema rather than restated, so a section added to a
 * registry is recognized here for free (`config-schema.ts` derives its property
 * list from those registries).
 */
const CANONICAL_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(
	schemaPropertyKeys(PI_LENS_CONFIG_SCHEMA),
);

/**
 * The same, for an LSP-SCOPED legacy file (`pi-lsp.json`, `.pi-lens/lsp.json`,
 * `~/.pi-lens/lsp.json`): that whole file is what a canonical file now holds
 * under `lsp`, so its recognized ROOT keys are the `lsp` namespace's own.
 */
const LSP_DOCUMENT_KEYS: ReadonlySet<string> = new Set(
	schemaPropertyKeys(
		(PI_LENS_CONFIG_SCHEMA as { properties?: Record<string, unknown> })
			.properties?.[LSP_NAMESPACE_KEY],
	),
);

function recognizedKeysFor(location: ConfigLocation): ReadonlySet<string> {
	return location.lspScoped ? LSP_DOCUMENT_KEYS : CANONICAL_TOP_LEVEL_KEYS;
}

/**
 * One record per `(file, key)` — never one per nested leaf, and only for a key
 * pi-lens actually RECOGNIZES (#2426 review round 4, F2/F5).
 *
 * A per-leaf record would re-nag once per custom server. A record for every
 * top-level key, which is what this emitted before, was worse in both
 * directions: the count was user input, so a 100-key legacy file produced 100
 * "move it" notices on top of the 98 typo notices the project loader already
 * emits for the same keys; and each one told the user to MOVE a key that is
 * not a pi-lens setting at all, which is advice that cannot be followed. A key
 * no schema property claims gets the loaders' typo diagnostic and nothing
 * else.
 *
 * The unrecognized keys are still accounted for, in ONE whole-file record
 * naming their count — the file is at a deprecated location whatever its keys
 * spell, and a user who moves only the keys named here has to know the rest
 * were left behind deliberately.
 */
export function deprecationRecords(
	documents: readonly ConfigDocument[],
	homeDir: string,
	globalFile?: string,
): MigrationRecord[] {
	const records: MigrationRecord[] = [];
	for (const document of documents) {
		if (document.location.legacy) {
			const destination = canonicalDestination(document, homeDir, globalFile);
			const recognized = recognizedKeysFor(document.location);
			let unrecognized = 0;
			for (const key of topLevelKeys(document.value)) {
				if (!recognized.has(key)) {
					unrecognized += 1;
					continue;
				}
				const canonicalKey = canonicalKeyFor(document, key);
				records.push(
					record({
						code: "PILENS_CFG_0003",
						file: document.file,
						key,
						canonicalKey,
						tier: document.tier,
						reason:
							`move "${key}" to ${destination}` +
							(canonicalKey === key ? "" : ` under "${canonicalKey}"`) +
							windowSuffix(document.location.surface),
					}),
				);
			}
			if (unrecognized > 0) {
				const plural = unrecognized === 1 ? "it was" : "they were";
				records.push({
					code: "PILENS_CFG_0003",
					file: document.file,
					key: "",
					// An LSP-scoped legacy file moves WHOLESALE into the `lsp`
					// namespace, so naming that namespace is literally true here — and
					// it is what routes this record to the LSP loader's subsystem, the
					// same key-derived ownership every other record uses.
					...(document.location.lspScoped
						? { canonicalKey: LSP_NAMESPACE_KEY }
						: {}),
					subject: migrationSubject(document.file, ""),
					tier: document.tier,
					reason:
						`this file is at a deprecated location; move it to ${destination}. ` +
						(unrecognized === 1
							? "1 of its top-level keys is not a recognized pi-lens setting"
							: `${unrecognized} of its top-level keys are not recognized pi-lens settings`) +
						`, and ${plural} not migrated${windowSuffix(document.location.surface)}`,
				});
			}
			continue;
		}
		// A CANONICAL file carrying legacy ROOT LSP keys: the file stays, the keys
		// move into the `lsp` namespace inside it.
		for (const key of topLevelKeys(document.value)) {
			if (!LEGACY_ROOT_LSP_KEYS.includes(key)) continue;
			const canonicalKey = `${LSP_NAMESPACE_KEY}.${key}`;
			records.push(
				record({
					code: "PILENS_CFG_0002",
					file: document.file,
					key,
					canonicalKey,
					tier: document.tier,
					reason: `move "${key}" to "${canonicalKey}" in the same file${windowSuffix(
						key,
					)}`,
				}),
			);
		}
	}
	return records;
}

function record(input: {
	code: ConfigDiagnosticCode;
	file: string;
	key: string;
	canonicalKey: string;
	tier: SourceTier;
	reason: string;
}): MigrationRecord {
	return {
		code: input.code,
		file: input.file,
		key: input.key,
		canonicalKey: input.canonicalKey,
		subject: migrationSubject(input.file, input.key),
		reason: input.reason,
		tier: input.tier,
	};
}

/**
 * Which SUBSYSTEM a record belongs to — the LSP loader, or the two pi-lens
 * config loaders (#2426 review round 2, F2).
 *
 * Ownership is DERIVED from the key rather than from which loader is asking: an
 * `lsp.*` canonical key, or one of the legacy LSP root keys, is the LSP loader's
 * regardless of which file it was found in. Both key spellings the pipeline
 * produces are handled — a deprecation record carries a DOTTED `canonicalKey`
 * (`lsp.servers`), a validation record from the core carries a JSON POINTER
 * (`/lsp/servers`) — because the two producers are different modules and neither
 * exists to serve this classification.
 */
type ConfigRecordOwner = "lsp" | "pi-lens";

/**
 * `undefined` for a record no key can attribute — the whole-file/whole-document
 * failure records (`key: ""`) that both halves of the core emit when a resolution
 * fails internally. Those are reported by EVERY loader rather than by none: a
 * duplicate notice about a config that failed to load is noise, while silence
 * about it is the failure mode this module exists to prevent.
 */
function configRecordOwner(
	record: MigrationRecord,
): ConfigRecordOwner | undefined {
	const key = record.canonicalKey ?? record.key;
	if (key.length === 0) return undefined;
	const head =
		(key.startsWith("/") ? key.slice(1) : key).split(/[./]/)[0] ?? "";
	if (head.length === 0) return undefined;
	return head === LSP_NAMESPACE_KEY || LEGACY_ROOT_LSP_KEYS.includes(head)
		? "lsp"
		: "pi-lens";
}

/** The pi-lens-config subsystem a GLOBAL vs. PROJECT tier reports under. */
function piLensSubsystemFor(
	tier: SourceTier | undefined,
): IgnoredConfigSubsystem | undefined {
	if (tier === "global") return "lens-config";
	if (tier === "project" || tier === "nested-project") {
		return "project-lens-config";
	}
	// `builtin` / `env` / `cli` / `host` never produce a document today, and a
	// merge-level bound refusal (see `MigrationRecord.tier`'s doc comment) names
	// no single source at all — `undefined` in either case.
	return undefined;
}

/**
 * The subsystem(s) one record must be reported under (#2426 review round 3,
 * F1).
 *
 * DERIVED from the record itself — owner (`configRecordOwner`) plus, for a
 * pi-lens-owned record, the TIER it was read at — rather than from which
 * loader is calling. Before this, a caller filtered to the records it "owned"
 * with `recordsOwnedBy` before reporting, which meant a pi-lens-owned record
 * from a document only the LSP loader's multi-file resolution actually
 * discovered (a legacy sibling file `loadPiLensProjectConfig`'s single-nearest-
 * file walk never opens) was filtered OUT by the LSP loader and never produced
 * by the project loader either: dropped by construction, never reported by
 * anyone.
 *
 * Deriving the subsystem from the record instead of the caller fixes that:
 * EVERY loader that sees the record now reports it, always to the SAME
 * subsystem set, so the warn-once latch (keyed on `subsystem\0file\0key\0
 * reason`) naturally collapses duplicate reports from different callers into
 * one notice — the F2 behavior — while a record no caller happened to "own"
 * before is reported by whichever loader actually resolved it.
 *
 * An `lsp` owner always reports under `lsp-config`, regardless of tier — the
 * LSP loader is the one home for every LSP setting. A `pi-lens` owner reports
 * under the tier-appropriate pi-lens loader.
 *
 * An unattributable record (owner `undefined` — the whole-file failures both
 * halves of the core emit with `key: ""`) reports under the ONE subsystem its
 * TIER names, when a tier is known (#2426 review round 4, S1). Round 3 sent it
 * to every subsystem that could plausibly have produced it, which turned one
 * internal failure into three notices, one of them announcing an "LSP config"
 * problem in a file with no LSP settings in it. `config-core`'s own
 * `resolveConfig` anchors that record to the resolution's highest-precedence
 * source precisely so the tier is known; the report-by-all fallback survives only for
 * a record that names no source at all.
 */
function configRecordSubsystems(
	record: MigrationRecord,
): readonly IgnoredConfigSubsystem[] {
	const owner = configRecordOwner(record);
	const piLens = piLensSubsystemFor(record.tier);
	const piLensSubsystems: readonly IgnoredConfigSubsystem[] = piLens
		? [piLens]
		: ["lens-config", "project-lens-config"];
	if (owner === "lsp") return ["lsp-config"];
	if (owner === "pi-lens") return piLensSubsystems;
	if (piLens) return [piLens];
	return ["lsp-config", ...piLensSubsystems];
}

/**
 * WHICH subsystem owns a config file that could not be read or parsed (#2445).
 *
 * Derived from the DOCUMENT — its location and its tier — for the same reason
 * `configRecordSubsystems` derives ownership from the record: `loadLSPConfig`
 * opens the pi-lens global and project configs too, and labelling their parse
 * failures "ignoring invalid LSP config" told a user to look at an LSP setting
 * when what they had broken was `~/.pi-lens/config.json`. An LSP-SCOPED file
 * (`pi-lsp.json`, `lsp.json`) is the LSP loader's whatever tier it sits at.
 */
function configFileSubsystem(
	location: ConfigLocation,
	tier: SourceTier,
): IgnoredConfigSubsystem {
	if (location.lspScoped) return "lsp-config";
	return tier === "global" ? "lens-config" : "project-lens-config";
}

/**
 * Report an unreadable/unparsable config document under its OWNING subsystem.
 *
 * `{ parseError }`, never a pre-stringified message: `warnIgnoredConfigOnce` is
 * the one seam that decides how much of a `JSON.parse` `SyntaxError#message`
 * (which embeds a snippet of the file being parsed, #2431) survives into the
 * log line, the ledger row and the notification.
 */
export function reportConfigReadFailure(failure: ConfigReadFailure): void {
	warnIgnoredConfigOnce({
		subsystem: configFileSubsystem(failure.location, failure.tier),
		file: failure.file,
		reason: { parseError: failure.error, sourceText: failure.sourceText },
	});
}

/**
 * Thread a resolution's records to the ONE config warning seam (#2418).
 *
 * Every caller passes every record its OWN resolution produced — no filtering
 * (#2426 review round 3, F1; see `subsystemsFor`). Calling this more than once
 * with overlapping records (the LSP loader and a pi-lens loader resolving the
 * same document) is by design: the warn-once latch dedupes across callers, so
 * the user still sees exactly one notice per `(subsystem, file, key, reason)`.
 *
 * It lives here rather than in `config-core/records.ts`, where #2425 first put
 * it (#2426). Putting the sink call inside the library contradicted the
 * library's own stated purity — `config-core` is documented as "no state, no
 * I/O, no ledger writes" — and the import it needed
 * (`records.ts` -> `config-warn.js` -> `degradation-ledger.js`) closed seven
 * cycles the moment a loader resolved through the core, because every config
 * loader sits downstream of `file-utils.ts`. Reporting is a loader decision;
 * this is the loaders' shared module.
 */
export function reportPiLensConfigRecords(
	records: readonly MigrationRecord[],
): void {
	for (const record of records) {
		for (const subsystem of configRecordSubsystems(record)) {
			warnIgnoredConfigOnce({
				subsystem,
				file: record.file,
				key: record.key.length > 0 ? record.key : undefined,
				reason: record.reason,
				code: record.code,
			});
		}
	}
}

/**
 * How a loader records a document it is ignoring, or a value inside one it
 * refused.
 *
 * A hand-authored string for a validated bad value or wrong type; a
 * `{ parseError }` for a caught parse/read error, so this seam — not each call
 * site — decides how much of a `JSON.parse` `SyntaxError#message` (which embeds
 * a snippet of the source file on Node >=20, #2431) survives into the sinks.
 */
export type NoteIgnored = (
	reason:
		| string
		| { readonly parseError: unknown; readonly sourceText?: string },
	code?: ConfigDiagnosticCode,
) => void;

/**
 * Buffer a loader's own ignored-config notices for one document, then bound
 * them once.
 *
 * A `NoteIgnored` COLLECTS rather than reports (#2426 review round 4, F3/F5).
 * Two things follow. The notice survives into a loader's cache entry, so a warm
 * cache HIT replays it instead of losing the whole `config-ignored` class from
 * session 2 onwards. And the count is bounded: the number of these a file can
 * produce is the number of keys the user typed — a 100-key file emitted 98
 * unknown-key notifications — so the buffered list goes through the same
 * `finalizeRecords` bound every other config record obeys, with one slot held
 * back to say how many were suppressed.
 *
 * ONE COPY, in the module both loaders already import (#2426 review round 7,
 * F2). Round 6 gave the global loader the bound the project loader already had
 * — by copying it — leaving two spellings of one record literal
 * (`PILENS_CFG_0001`, no key, `migrationSubject(configPath, "")`) and one flush,
 * differing only in a tier literal. Two copies of one policy is the shape round
 * 5 collapsed three copies of this same bound to avoid, so the tier is an
 * argument and the copy is gone. `tests/clients/config-notice-bounds.test.ts`
 * asserts on the SOURCE that no third copy grows back, because duplication is
 * invisible to a behavioral probe until one copy is edited.
 *
 * The buffer is a plain array (round 6, S2). It used to be a pre-subtracted
 * `finalizableCollector`, a second exported shape for the one policy round 5
 * had just collapsed; the notes a single parse can accumulate are bounded by
 * the document already in memory, which is a smaller cost than a second public
 * entry point onto the same arithmetic.
 */
export function ignoredRecordCollector(
	configPath: string,
	tier: SourceTier,
): {
	note: NoteIgnored;
	records: () => readonly MigrationRecord[];
} {
	const noted: MigrationRecord[] = [];
	const note: NoteIgnored = (reason, code = "PILENS_CFG_0001") => {
		noted.push({
			code,
			file: configPath,
			key: "",
			subject: migrationSubject(configPath, ""),
			reason:
				typeof reason === "string"
					? reason
					: normalizeParseErrorReason(reason.parseError, {
							sourceText: reason.sourceText,
						}),
			tier,
		});
	};
	return {
		note,
		records: () => finalizeRecords(noted, { file: configPath, tier }),
	};
}

/**
 * The effective `lsp` section of a resolved configuration.
 *
 * One lookup, because the combination it used to perform now happens at source
 * injection (`configSources`): by the time a value reaches here, every legacy
 * root LSP key a document carried is already inside the namespace and has been
 * resolved against every tier through the SAME schema node as its canonical
 * spelling. Canonical still wins a collision inside one document — that is
 * caller order in `configSources` — but the winner is now chosen by `merge()`,
 * which is the only place that can see all the tiers at once.
 *
 * "Wins" is PER LEAF, not per key. A document that spells both root `servers`
 * and `lsp.servers` no longer has one object replace the other: the two are
 * merged by server id, and canonical wins only the ids they both define. A
 * server defined only in the legacy root spelling therefore survives beside
 * the canonical ones instead of disappearing — which is the same fix, one
 * level down, as the vanishing legacy denial below (#2427 review round 3).
 *
 * The projection-time combination this used to do could only ever see two
 * independently resolved nodes, and picking one of them is how a global denial
 * written in the legacy spelling used to vanish (#2427 review round 2, F1).
 */
export function lspSectionOf(
	value: Record<string, unknown>,
): Record<string, unknown> {
	const namespace = value[LSP_NAMESPACE_KEY];
	return namespace && typeof namespace === "object" && !Array.isArray(namespace)
		? (namespace as Record<string, unknown>)
		: {};
}
