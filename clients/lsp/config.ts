/**
 * LSP Configuration for pi-lens
 *
 * Allows users to define custom LSP servers and override initialization options
 * for built-in servers via configuration.
 *
 * CANONICAL LOCATION (#2426): the `lsp` namespace of `.pi-lens.json` (project)
 * and `~/.pi-lens/config.json` (machine-global). `.pi-lens/lsp.json`,
 * `pi-lsp.json` and `~/.pi-lens/lsp.json` — and the four LSP keys at the ROOT
 * of a canonical file — are still read for their deprecation window
 * (`DEPRECATED_CONFIG_SURFACES`) and emit one migration warning per
 * `(file, key)` naming where the setting moves. The canonical spelling wins
 * every collision. `docs/configuration.md` documents the full lookup order;
 * discovery itself lives in `clients/config-resolve.ts`, which this module and
 * the other two loaders now share.
 *
 * Example — custom server (canonical spelling, inside `.pi-lens.json`):
 * {
 *   "lsp": {
 *     "servers": {
 *       "my-server": {
 *         "name": "My Custom LSP",
 *         "extensions": [".myext"],
 *         "command": "my-lsp-server",
 *         "args": ["--stdio"],
 *         "rootMarkers": ["package.json"]
 *       }
 *     }
 *   }
 * }
 *
 * Example — override initializationOptions for a built-in server:
 * {
 *   "lsp": {
 *     "serverOverrides": {
 *       "rust": {
 *         "initializationOptions": {
 *           "check": { "command": "clippy", "allTargets": true },
 *           "cargo": { "features": "all", "targetDir": true }
 *         }
 *       },
 *       "nix": {
 *         "initializationOptions": {
 *           "nixpkgs": { "expr": "import <nixpkgs> {}" }
 *         }
 *       }
 *     }
 *   }
 * }
 *
 * The `initializationOptions` object is deep-merged onto the server's built-in
 * defaults, so you only need to specify the keys you want to change or add.
 * User-supplied values win on conflicts at every level of nesting.
 *
 * Server IDs match the `id` field of each built-in server definition in
 * clients/lsp/server.ts (e.g. "rust", "nix", "bash", "python", "go", "ts").
 */

import { resetIgnoredConfigWarnCache } from "../config-warn.js";
import * as os from "node:os";
import path from "node:path";
import { LSP_NAMESPACE_KEY } from "../config-locations.js";
import {
	type MigrationRecord,
	migrationSubject,
} from "../config-core/records.js";
import type { SourceTier } from "../config-core/provenance.js";
import {
	lspSectionOf,
	type PiLensConfigResolution,
	reportConfigReadFailure,
	reportPiLensConfigRecords,
	resolvePiLensConfig,
	summarizeConfigResolution,
} from "../config-resolve.js";
import {
	getDegradationLedgerGeneration,
	recordDegradationOnce,
} from "../degradation-ledger.js";
import {
	isKnownRunnerId,
	runnerIdentityPopulated,
} from "../dispatch/known-runner-ids.js";
import { getGlobalPiLensDir } from "../file-utils.js";
import {
	claimPhaseOncePerSession,
	currentSessionRecordId,
	logLatency,
	releaseOncePerSessionPhase,
	releasePhaseClaim,
} from "../latency-logger.js";
import { getPiLensGlobalConfigPath } from "../lens-config.js";
import { normalizeFilePath } from "../path-utils.js";
import { logExtension } from "../extension-log.js";
import {
	getProjectTrustState,
	type ProjectTrustState,
} from "../project-trust.js";
import {
	isRepoTier,
	provenanceFor,
	type Provenance,
} from "../config-core/provenance.js";
import { resolveToolCwd } from "../tool-cwd.js";
import { logSessionStart } from "../sessionstart-logger.js";
import { launchLSP } from "./launch.js";
import {
	registerSessionRoot,
	resetSessionRootsForTests,
	sessionRootConfigEntries,
	setSessionRootConfig,
} from "./session-roots.js";
import {
	LSP_SERVERS,
	resetLSPCaseSensitivityState,
	resolveLspServerCwd,
	type LSPServerInfo,
	type LspRootFallback,
} from "./server.js";
import { DEFAULT_LSP_SERVER_ROLE, isAuxiliary } from "./server-traits.js";

// --- Types ---

export interface CustomServerConfig {
	name: string;
	extensions: string[];
	command: string;
	args?: string[];
	rootMarkers?: string[];
	env?: Record<string, string>;
	initializationOptions?: Record<string, unknown>;
	/**
	 * Dispatch runner ids this server subsumes (#3968): while this server is
	 * a file's selected primary LSP, the runners it names defer to the warm
	 * lane (`lspPrimaryCoversFile`,
	 * `clients/dispatch/runners/utils/runner-helpers.ts` — the builtin facts
	 * table `clients/lsp/server-covers.ts` is the builtin rows' spelling of
	 * the same fact). Values are runner ids projected from the dispatch
	 * registry's own registrations — a member the registry does not know is
	 * dropped at load with a visible `PILENS_CFG_0005` record and the server
	 * still registers, its LSP lane being independent of the claim. The
	 * ARRAY shape (`array` of `string`) is enforced by the published schema
	 * (`clients/config-schema.ts`), so a value reaching here is `string[]`;
	 * an empty array carries no claim. Across tiers the nearest tier that
	 * sets the field supplies the whole array (the core's default `replace`
	 * strategy) — the field belongs to the server entry's definition, never
	 * a union of two tiers' claims.
	 */
	covers?: string[];
}

/**
 * Per-server initializationOptions overrides for built-in servers.
 * Keys are built-in server IDs (e.g. "rust", "nix", "bash", "python", "go").
 */
export interface ServerInitOverride {
	command?: string | string[];
	env?: Record<string, string>;
	/**
	 * Deep-merged onto the server's built-in initializationOptions defaults.
	 * User values win on key conflicts at every nesting level.
	 */
	initializationOptions?: Record<string, unknown>;
}

export interface LSPConfig {
	servers?: Record<string, CustomServerConfig>;
	/**
	 * Override initializationOptions for built-in servers.
	 * Keys are built-in server IDs (e.g. "rust", "nix", "bash", "python").
	 * Each entry's `initializationOptions` is deep-merged onto the server's
	 * built-in defaults so you only need to specify the keys you want to change.
	 */
	serverOverrides?: Record<string, ServerInitOverride>;
	disabledServers?: string[];
	/** Files to open at session start to seed lazy LSP indexing (e.g., clangd). */
	warmFiles?: string[];
	/** Non-enumerable source map attached by loadLSPConfig. */
	readonly __provenance?: ProvenanceMap;
}

/**
 * A workspace's LSP config in the shape the gates consume: custom servers
 * already constructed, the deny set already a `Set`, overrides already a `Map`.
 *
 * Exported since #2427 review round 3 because `effectiveConfig` derives one
 * rather than reading the session registry — see `registerLSPConfig`.
 */
export interface RegisteredLSPConfig {
	customServers: LSPServerInfo[];
	registeredServers: LSPServerInfo[];
	disabledServerIds: Set<string>;
	serverOverrides: Map<string, ServerInitOverride>;
}

// --- Config Loading ---

/**
 * For tests that need to force the warn-once cache to reset between cases —
 * the LSP loader's counterpart to `resetGlobalConfigWarnCache` in
 * lens-config.ts and to the clear folded into `resetProjectLensConfigCache`
 * (#2418 review round 3, S3). Without it, this loader's cases had to lean on
 * every fixture landing in a fresh temp path to stay unlatched, which is a
 * property of the fixture rather than of the test.
 */
export function resetLSPConfigWarnCache(): void {
	resetIgnoredConfigWarnCache("lsp-config");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Load LSP configuration — a PROJECTION of the one resolved pi-lens config.
 *
 * Everything that used to be here (the candidate list, the unbounded upward
 * walk, the two-object merge with its four hand-patched keys) now lives in
 * `config-resolve.ts` and applies identically to the other two loaders. What is
 * left is the projection: pick the `lsp` section out of the resolved value and
 * shape it into `LSPConfig`.
 *
 * Three behaviors changed with the move, all of them deliberate and all of them
 * pinned by `tests/clients/config-golden-layouts.test.ts`:
 *
 * 1. THE WALK IS CEILING-BOUNDED. It used to run to the filesystem root with no
 *    `$HOME` stop, so a `pi-lsp.json` in the user's home directory was adopted
 *    by every project on the machine (#622/#625's class, and #2426's one
 *    outright bug fix rather than deprecation).
 * 2. THE CANONICAL FILE WINS. `.pi-lens.json` used to LOSE to a leftover
 *    `.pi-lens/lsp.json` in the same directory, which made the migration users
 *    are now being asked to perform impossible to complete.
 * 3. NESTED CONFIGS LAYER instead of the nearest one winning wholesale, which
 *    is the same nearest-wins-per-field rule `.pi-lens.json`'s `ignore` has had
 *    since #783.
 *
 * `homeDir` is a test seam only, matching `findNestedProjectMutationValue`'s.
 *
 * `report: false` performs the same resolution and returns the same config
 * WITHOUT firing a user-facing notice (#2427 review round 2, F6). It exists for
 * `effectiveConfig`, whose whole contract is that asking what your
 * configuration is must not warn you about it or consume the warn-once latch
 * that the session-start load needs. Suppressing means suppressing BOTH sinks —
 * the record report and the per-document read-failure report — because a
 * question that answers "your global config is unreadable" by emitting the
 * loader's own degradation notice has reported all the same.
 *
 * It lives HERE and only here. `initLSPConfig` used to take the same option so
 * that `effectiveConfig` could initialize a workspace quietly; round 3 removed
 * that call outright, which removed the option, the parallel "which run is
 * silent" set beside `configInFlight`, and the reporting-caller-never-joins-a-
 * silent-run rule the two of them needed.
 */
export interface LoadLSPConfigOptions {
	/** Fire the user-facing config notices. Defaults to true. */
	readonly report?: boolean;
}

/** The session-scoped phase this loader claims (#2526). */
const CONFIG_RESOLVED_PHASE = "config_resolved";

/**
 * Write the session's ONE `config_resolved` record (#2526).
 *
 * Positive observability for the Phase 0 config stack: before this, a correct
 * canonical-only resolution proved itself only by the ABSENCE of
 * `PILENS_CFG_*` rows — the silent-success gap AGENTS.md warns about.
 *
 * REDACTED by construction, not by mode. Everything it can say comes from
 * `summarizeConfigResolution`, the same projection `pilens_effective_config`
 * embeds: document PATHS (home-relative), tiers, the legacy flag, per-tier
 * leaf counts, and a record COUNT. No config value, and no absolute `$HOME`,
 * can reach the log through it.
 *
 * NO SECOND RESOLUTION (#2513's facade rule): it reads the resolution its
 * caller already performed. And it adds no `await` — `logLatency` and
 * `logSessionStart` are synchronous buffered writers — so the session-start
 * hook path gains nothing to wait on (#2523).
 *
 * ONE row per session AND SERVED ROOT, claimed through the logger's own
 * session-scoped bookkeeping rather than a latch kept here. `loadLSPConfig` is
 * the funnel every config resolution goes through (`initLSPConfig` at session
 * start and at each served root, the MCP `ensureReady` boot,
 * `ensureLSPConfigInitialized` on the first edit), so an unconditional write
 * would emit one row per resolution and the per-session count the smell
 * analyzer joins on would be unrecoverable from the log.
 *
 * The ROOT is part of the claim (#2526 review round 2, F3). A warm MCP server
 * calls `ensureReady` per served root (`mcp/server.ts`), and a phase-only
 * claim recorded the FIRST root's documents and nothing else — project B's
 * legacy config document never reached a row, so the
 * "legacy-document-with-no-records" smell structurally could not fire for it.
 * `configResolutionKey` keys it (fold, canonicalize, fold — see below), the
 * repo-wide rule for every path-keyed map (#210): a `/`-vs-`\` spelling of
 * one root must not buy a second row.
 */
/**
 * THE (session, root) key of every config-resolution record: the
 * `config_resolution_pending` mark, the `config_resolved` row and claim, and
 * the release of that claim when the root is evicted.
 *
 * Fold separators, THEN canonicalize, then fold again — in that order, and
 * neither step alone is enough (#2518 review F6). `normalizeFilePath` folds
 * separators and Windows casing but is the IDENTITY on a POSIX path that
 * merely needs canonicalizing, so `"/proj/"` and `"/proj"` produced two
 * different claim keys. `path.resolve` fixes that and nothing else — and it
 * cannot run first: on POSIX a backslash is an ordinary filename character,
 * so resolving `"/proj\\sub"` before folding yields
 * `<process.cwd()>/proj\sub`, a different root entirely. That is the #2526 R2
 * spelling case (`tests/clients/config-resolved-phase.test.ts`, "a /-vs-\
 * spelling of one root does not buy a second row"), which caught exactly this
 * ordering while it was wrong. Resolving here rather than at
 * each caller is what makes the keys identical BY CONSTRUCTION: the callers
 * do not agree today (`initLSPConfig` passes its registry-resolved cwd,
 * `clients/runtime-session.ts`'s two warm-path `loadLSPConfig` calls pass the
 * session cwd verbatim, and `analysisRoot` from `.pi-lens.json` can carry a
 * trailing slash), and a per-caller normalization is exactly the shape 1
 * defect this key keeps being bitten by — the write form and the read form
 * diverging because two sites each folded the path their own way.
 *
 * It is also the key `clients/lsp/session-roots.ts` stores its roots under,
 * once composed: the registry key is `path.resolve(cwd)`, and this function
 * applied to it is idempotent, so `forgetConfigResolvedClaims` releases
 * exactly the claim `recordConfigResolved` took.
 */
function configResolutionKey(cwd: string): string {
	// Fold first (separators, Windows casing), canonicalize second (trailing
	// separators, relative segments), fold again so the result keeps the
	// forward-slash shape every producer and the analyzer already compare on.
	return normalizeFilePath(path.resolve(normalizeFilePath(cwd)));
}

/**
 * Announce, at the instant a resolution is actually about to be attempted,
 * that THIS session expects a `config_resolved` row (#2526 review round 3,
 * S1).
 *
 * Round 2 PREDICTED this from three flags in `runtime-session.ts`
 * (`no-lsp`/`subagent`/`warm-attach`), each mirroring one gate the resolution
 * paths themselves check — and the mirror drifted: quick and minimal mode's
 * SECOND session in one process schedule no resolution at all
 * (`ensureLSPConfigInitialized`'s `_lspConfigInitializedCwds` memo skips the
 * synchronous resolve past the first session, and only FULL mode's deferred
 * `setImmediate` reschedules one), so the predicate kept saying
 * `expected=true` for a session that was never going to resolve, and the
 * analyzer flagged a real session every time under `PI_LENS_STARTUP_MODE=quick`
 * or `=minimal`. STOP PREDICTING: this function is called from `loadLSPConfig`
 * itself rather than from any of its callers' decision points, because
 * `loadLSPConfig` is the ONE funnel every production caller reaches —
 * `initLSPConfig` (`ensureLSPConfigInitialized`'s first-session-per-cwd path
 * in index.ts, the MCP `ensureReady` boot via `ensureLspConfig`,
 * `igniteWarmFiles`/`igniteDominantLanguageWarm`) and the two direct calls in
 * `runtime-session.ts` (the full-mode deferred `setImmediate` load and the
 * quick-mode warm-up's LSP pre-warm). Placing the mark here rather than at
 * each of those four sites buys three things: (a) it fires exactly when a
 * resolution is genuinely attempted, never merely decided likely; (b) a
 * session that never reaches ANY of those sites — quick or minimal mode's
 * second-and-later session in a process, for the same root — never gets a
 * mark, so the analyzer silently excludes it instead of counting it against;
 * (c) this mark and {@link recordConfigResolved}'s row are stamped from the
 * SAME `currentSessionRecordId()` read, a few lines apart in one function
 * call, so they can never disagree about which session they belong to —
 * writing the mark at each scheduling site instead (e.g. before a
 * `setImmediate`) would let a session boundary between scheduling and
 * execution attribute the two halves to different sessions.
 *
 * Written unconditionally — before {@link resolvePiLensConfig} can throw —
 * so a resolution that is entered but fails mid-flight leaves a mark with no
 * row, which the analyzer's join reads as "expected and never happened"
 * rather than silently matching "never expected at all".
 *
 * Carries `root=<configResolutionKey(cwd)>` (#2552 review round 4, MEDIUM): the
 * warm MCP server keeps ONE session id for the life of the process but calls
 * this once per SERVED ROOT (`ensureReady` per root, `mcp/server.ts`) — a
 * session-id-only mark let one root's `config_resolved` row silently clear
 * every OTHER root's deficit under the same id, reintroducing review round
 * 2's F3 defect one layer up, at the analyzer's join instead of the claim.
 * The value is the SAME {@link configResolutionKey} string
 * {@link recordConfigResolved} uses for its claim scope and its row's
 * `filePath`, so the mark and the row compare equal without the analyzer
 * re-deriving any path normalization of its own.
 */
function publishConfigResolutionPending(cwd: string): void {
	logSessionStart(
		`session_start config_resolution_pending session=${currentSessionRecordId()} ` +
			`root=${configResolutionKey(cwd)}`,
	);
}

function recordConfigResolved(
	cwd: string,
	resolution: PiLensConfigResolution,
	lspConfig: LSPConfig,
	homeDir: string,
	resolveMs: number,
): void {
	// #2552 review round 4: computed ONCE and reused for the claim scope, the
	// row's `filePath`, and the sessionstart line's `root=` — one normalization
	// of `cwd`, so the pending mark, the row, and the claim can never disagree
	// about which root they name. #2518 review F6 moved that one normalization
	// into `configResolutionKey`, so callers passing the same root spelled
	// differently cannot disagree either.
	const root = configResolutionKey(cwd);
	if (!claimPhaseOncePerSession(CONFIG_RESOLVED_PHASE, root)) {
		return;
	}
	const summary = summarizeConfigResolution(resolution, homeDir);
	// #2526 R2 F2: the session identity the analyzer joins on. Written on both
	// sinks from this ONE call, so the latency row and the sessionstart line
	// carry the same id by construction rather than by agreement.
	const sessionId = currentSessionRecordId();
	// The deny UNION's size, read off the same projection the gates consume
	// (`lspConfigOf`) rather than re-read from the raw value — one definition of
	// "which servers are denied", so the record cannot describe a different
	// deny set than the one that actually suppresses a server.
	const deniedServers = lspConfig.disabledServers?.length ?? 0;
	const legacyDocuments = summary.documents.filter(
		(document) => document.legacy,
	).length;
	logLatency({
		type: "phase",
		phase: CONFIG_RESOLVED_PHASE,
		filePath: root,
		durationMs: resolveMs,
		metadata: {
			sessionId,
			documents: summary.documents,
			countsByTier: summary.countsByTier,
			recordCount: summary.recordCount,
			deniedServers,
			resolveMs,
		},
	});
	logSessionStart(
		`config resolved documents=${summary.documents.length} legacy=${legacyDocuments} ` +
			`records=${summary.recordCount} deniedServers=${deniedServers} resolveMs=${resolveMs} ` +
			`session=${sessionId} root=${root}`,
	);
}

export async function loadLSPConfig(
	cwd: string,
	homeDir: string = os.homedir(),
	options: LoadLSPConfigOptions = {},
): Promise<LSPConfig> {
	const reporting = options.report !== false;
	// #2526 review round 3, S1: announce the attempt before anything that
	// resolves it can throw — see `publishConfigResolutionPending`'s doc
	// comment for why this lives here rather than at each caller.
	publishConfigResolutionPending(cwd);
	const resolveStartedAt = Date.now();
	const resolution = resolvePiLensConfig({
		cwd,
		globalDir: getGlobalPiLensDir(),
		// The global tier reads the PRODUCTION resolution (global-config-location
		// PR, refs #2457): which file supplies it is an env fact (PI_LENS_CONFIG_PATH,
		// then a legacy default, then PI_CODING_AGENT_DIR, then the
		// PI_LENS_HOME-relocated canonical default), not a property of the
		// `$HOME` this call's project walk is ceiling-bounded by. `homeDir`
		// stays threaded below for the walk and `globalDir`; a test redirecting
		// the global tier does it through the env, the same way production is
		// controlled.
		globalConfigPath: getPiLensGlobalConfigPath(),
		homeDir,
		// The subsystem comes from the failing DOCUMENT, not from this loader
		// (#2445). This resolution opens `~/.pi-lens/config.json` and
		// `.pi-lens.json` as well as the LSP-scoped files, and reporting all of
		// them as `lsp-config` announced an "invalid LSP config" for a file whose
		// contents are pi-lens settings. An LSP-scoped file still reports here.
		...(reporting ? { onReadError: reportConfigReadFailure } : {}),
	});
	// EVERY record this resolution produced (#2426 review round 3, F1) — not
	// filtered to what this loader "owns". `reportPiLensConfigRecords` derives
	// the reporting subsystem per record; the warn-once latch collapses this
	// loader's report with the pi-lens loaders' report of the SAME record into
	// one notice. Filtering here (as round 2 did) silently dropped a pi-lens-
	// owned record from a document only this multi-file resolution discovered.
	//
	// The projection VALIDATES the resolved value's covers claims (#3968), and
	// the funnel owns the NEW records because it owns the resolution's
	// provenance (`coversClaimRecords`'s file/tier lookups) and the reporting
	// gate (`report: false` exists so a QUERY cannot warn or consume the
	// warn-once latch; the ledger row below is durable telemetry and follows
	// `recordConfigResolved`'s "report: false is not a gate" rule). The
	// resolution's records and the covers records report here, once, together.
	const coversProblems = newCoversClaimProblems();
	const config = lspConfigOf(resolution.value, coversProblems);
	// Preserve the source map for the registry compiler without changing the
	// enumerable loader projection consumed by existing callers.
	Object.defineProperty(config, "__provenance", {
		value: resolution.provenance,
		enumerable: false,
	});
	if (reporting) {
		reportPiLensConfigRecords([
			...resolution.records,
			...coversClaimRecords(resolution, coversProblems),
		]);
	}
	recordCoversUnvalidated(resolution, coversProblems);
	// #2526: the session's one positive record that config resolution HAPPENED,
	// written where the resolution actually exists. `report: false` is not a
	// gate here — the option suppresses USER-FACING notices, and a record in
	// the latency log is not a notice; gating on it would let a session whose
	// only resolution was a quiet one look, in the log, like a session that
	// never resolved config at all.
	recordConfigResolved(
		cwd,
		resolution,
		config,
		homeDir,
		Date.now() - resolveStartedAt,
	);
	return config;
}

/**
 * THE resolved-value → {@link LSPConfig} projection: read the `lsp` namespace
 * and keep the four keys the gates consume, each only when the resolution
 * actually produced it in the right shape.
 *
 * Exported and named in #2427 review round 5 (F-R4-1). `effectiveConfig`
 * needs the LSP config AND the provenance of the same resolution, and
 * `loadLSPConfig` returns only the former — it discards the resolution it
 * just performed. Round 4 therefore had the query call `loadLSPConfig` for
 * the gates and run a SECOND `resolvePiLensConfig` for the provenance, at a
 * different root, and the two disagreed: the gates answered from the file's
 * own directory while the reported spec, provenance and document list came
 * from the workspace root. With the projection spelled here the query performs
 * ONE resolution and derives both halves from it, and the projection is still
 * a single definition, so a derived config and a session-registered one cannot
 * disagree about what a document means.
 */
/**
 * One custom server's `covers` claim refused in whole or part at load.
 *
 * A refusal is per SERVER ENTRY (not per member): the record names the
 * claim's pointer and carries the counts, so a misspelled runner id is
 * visible (`PILENS_CFG_0005`) while the server itself still registers.
 */
export interface CoversClaimRefusal {
	/** The server id whose covers claim was refused in whole or part. */
	readonly serverId: string;
	/** How many members the resolved claim carried. */
	readonly declaredCount: number;
	/** How many members survived (runner ids the registry knows). */
	readonly keptCount: number;
}

/** A covers claim accepted WITHOUT validation — no runner registry yet. */
export interface CoversClaimUnvalidated {
	readonly serverId: string;
}

/**
 * The covers-validation side channel of {@link lspConfigOf}.
 *
 * The projection must stay the ONE place a resolved value becomes an
 * `LSPConfig` (#2427), and the records it generates need the resolution's
 * provenance (which file, which tier), which the projection itself does not
 * carry. So the projection VALIDATES (drops what must not reach the gates)
 * and reports INTO this collector; `loadLSPConfig` — the one funnel, which
 * has the resolution — turns the entries into records (`coversClaimRecords`)
 * and the bounded ledger row (`recordCoversUnvalidated`). A caller that
 * passes no collector gets the same validated projection silently.
 */
export interface CoversClaimProblems {
	readonly refusals: CoversClaimRefusal[];
	readonly unvalidated: CoversClaimUnvalidated[];
}

function newCoversClaimProblems(): CoversClaimProblems {
	return { refusals: [], unvalidated: [] };
}

/**
 * The pointer of a server entry's covers claim, spelled the way `merge()`
 * spells its provenance keys (JSON pointer into the RESOLVED value).
 */
function coversPointer(serverId: string): string {
	return `/${LSP_NAMESPACE_KEY}/servers/${serverId}/covers`;
}

/**
 * Which file and tier supplied the claim at `pointer`, walked up the
 * provenance chain (leaf first, then ancestors); the nearest contributing
 * document is the last-resort file, so a record never names an empty path.
 */
function coversClaimSource(
	resolution: PiLensConfigResolution,
	pointer: string,
): { file: string; tier?: SourceTier } {
	let candidate: string | undefined = pointer;
	while (candidate !== undefined) {
		const entry = resolution.provenance.get(candidate);
		if (entry) {
			return {
				file: entry.file ?? "",
				...(entry.tier ? { tier: entry.tier } : {}),
			};
		}
		const cut = candidate.lastIndexOf("/");
		candidate = cut > 0 ? candidate.slice(0, cut) : undefined;
	}
	return { file: resolution.documents.at(-1)?.file ?? "" };
}

/**
 * THE `PILENS_CFG_0005` records for refused covers claims (#3968).
 *
 * One record per refused SERVER ENTRY, carrying the claim's pointer in `key`
 * (the ledger subject, so per-claim counting stays possible) and the refusal
 * in `reason` — the counts are structural, and the reason never quotes the
 * offending member value (the `MigrationRecord` contract; the user value is
 * also not safe to embed unredacted). The server still registers, so the
 * reason says so: a user reading "your covers claim was dropped" must not
 * conclude their LSP lane disappeared.
 */
function coversClaimRecords(
	resolution: PiLensConfigResolution,
	problems: CoversClaimProblems,
): MigrationRecord[] {
	return problems.refusals.map((refusal) => {
		const pointer = coversPointer(refusal.serverId);
		const { file, tier } = coversClaimSource(resolution, pointer);
		const dropped = refusal.declaredCount - refusal.keptCount;
		return {
			code: "PILENS_CFG_0005",
			file,
			key: pointer,
			subject: migrationSubject(file, pointer),
			reason:
				`lsp.servers.${refusal.serverId}.covers declares member(s) that ` +
				`are not recognized dispatch runner ids; ${dropped} of ` +
				`${refusal.declaredCount} member(s) dropped, the server still ` +
				keptTail(refusal.keptCount),
			...(tier ? { tier } : {}),
		};
	});
}

/** The refusal tail: what remains of the claim after the drop. */
function keptTail(keptCount: number): string {
	return keptCount > 0
		? "registers with the remaining covers claim"
		: "registers with no covers claim";
}

/**
 * The bounded ledger row for covers claims accepted UNVALIDATED (#3968).
 *
 * Fires regardless of the reporting gate: `report: false` exists so a QUERY
 * cannot fire user-facing notices or consume the warn-once latch, and this
 * row is neither — the skip-itself observation (`catalog shape 10`), bounded
 * once per session per claim. Subject `<file>\0<pointer>` so a covers entry
 * in two documents yields two records, each naming the file.
 */
function recordCoversUnvalidated(
	resolution: PiLensConfigResolution,
	problems: CoversClaimProblems,
): void {
	for (const unvalidated of problems.unvalidated) {
		const pointer = coversPointer(unvalidated.serverId);
		const { file } = coversClaimSource(resolution, pointer);
		recordDegradationOnce({
			kind: "lsp-covers-unvalidated",
			subject: `${file}\0${pointer}`,
			reason:
				"no runner registry has populated this process yet; the covers " +
				"claim was accepted without runner-id validation and the next " +
				"config load validates it",
			metadata: { pointer },
		});
	}
}

/**
 * THE resolved value's `lsp.servers` object, each entry's covers claim
 * validated against the dispatch registry's runner ids (#3968).
 *
 * Fail-closed on IDENTITY, never on registration: an unknown runner member
 * is dropped from the claim (wholly when nothing survives, so the field is
 * gone rather than an empty claim) and the server keeps every other field —
 * its LSP lane is independent of what it claims to subsume. When no runner
 * registry has populated the process yet (the first session's load races
 * the fire-and-forget dispatch warm-up), the claim is accepted UNVALIDATED
 * and the skip is reported into the collector — dropped there, it would be
 * silent nondeterminism; `known-runner-ids.ts` names why that arm fails
 * open rather than closed.
 */
function coversValidatedServers(
	servers: Record<string, unknown>,
	problems: CoversClaimProblems | undefined = undefined,
): Record<string, CustomServerConfig> {
	const out: Record<string, CustomServerConfig> = {};
	for (const [id, raw] of Object.entries(servers)) {
		const entry = raw as CustomServerConfig;
		// An empty (or absent) array carries no claim — nothing to validate,
		// nothing to record; the configured no-claim entry rides through so
		// `effective_config` still shows the server as configured.
		if (!entry.covers?.length) {
			out[id] = entry;
			continue;
		}
		if (!runnerIdentityPopulated()) {
			problems?.unvalidated.push({ serverId: id });
			out[id] = entry;
			continue;
		}
		const kept: string[] = [];
		for (const member of entry.covers) {
			if (isKnownRunnerId(member)) kept.push(member);
		}
		if (kept.length === entry.covers.length) {
			out[id] = entry;
			continue;
		}
		problems?.refusals.push({
			serverId: id,
			declaredCount: entry.covers.length,
			keptCount: kept.length,
		});
		const { covers: _dropped, ...rest } = entry;
		out[id] = kept.length > 0 ? { ...rest, covers: kept } : rest;
	}
	return out;
}

/**
 * The resolved value's custom-server entries in the shape the runtime
 * registers them — each entry's covers claim validated exactly like
 * `lspConfigOf`'s (one definition of a valid claim). `effective_config`'s
 * redacted projection reads through this instead of the raw section, so the
 * covers values it renders are the claim the runtime actually holds — a
 * member the loader dropped cannot render as if the runtime would honor it.
 */
export function customServerSpecsOf(
	value: Record<string, unknown>,
): Record<string, CustomServerConfig> {
	const servers = asRecord(lspSectionOf(value).servers);
	return servers ? coversValidatedServers(servers) : {};
}

export function lspConfigOf(
	value: Record<string, unknown>,
	problems?: CoversClaimProblems,
	provenance?: ProvenanceMap,
): LSPConfig {
	const section = lspSectionOf(value);
	const config: LSPConfig = {};
	const servers = asRecord(section.servers);
	if (servers) config.servers = coversValidatedServers(servers, problems);
	const serverOverrides = asRecord(section.serverOverrides);
	if (serverOverrides) {
		config.serverOverrides = serverOverrides as Record<
			string,
			ServerInitOverride
		>;
	}
	if (Array.isArray(section.disabledServers)) {
		config.disabledServers = section.disabledServers as string[];
	}
	if (Array.isArray(section.warmFiles)) {
		config.warmFiles = section.warmFiles as string[];
	}
	if (provenance) {
		Object.defineProperty(config, "__provenance", {
			value: provenance,
			enumerable: false,
		});
	}
	return config;
}

// --- Custom Server Factory ---

/**
 * Create LSPServerInfo from user configuration
 */
export function createCustomServer(
	config: CustomServerConfig,
	id: string,
): LSPServerInfo {
	return {
		id,
		name: config.name,
		custom: true,
		// The own-command token the runner-coverage seam gates this row's
		// covers claim on (#3968 F2): the declared covering lane's binary must
		// be probeable before the claim can defer a CLI runner.
		command: config.command,
		extensions: config.extensions,
		// A config-declared server is a language server. The public
		// `lsp.servers.<id>.role` field is validated and projected by
		// `ResolvedLspConfig` (clients/lsp/resolved-config.ts) but stays
		// RESERVED and inert here: honouring it would change which servers a
		// file selects as primary, and that is the catalog slice's call, not
		// this loader's (#2416 slice 1). The stated default is applied rather
		// than left absent (#1488).
		role: DEFAULT_LSP_SERVER_ROLE,
		idleEviction: "unmeasured",
		// The config-declared covers channel (#3968): the claim the loader
		// validated (`lspConfigOf`'s projection drops unknown runner ids) rides
		// the server entry into the runner-coverage seam.
		...(config.covers ? { covers: config.covers } : {}),
		...(config.rootMarkers ? { rootMarkers: config.rootMarkers } : {}),
		root: config.rootMarkers
			? async (file) =>
					resolveToolCwd("lsp", id, file, {
						cwd: process.cwd(),
						...(config.rootMarkers ? { rootMarkers: config.rootMarkers } : {}),
					}).cwd
			: async (file) =>
					resolveToolCwd("lsp", id, file, { cwd: process.cwd() }).cwd,
		async spawn(root) {
			const proc = await launchLSP(config.command, config.args ?? ["--stdio"], {
				cwd: root,
				env: config.env ? { ...process.env, ...config.env } : process.env,
			});
			return {
				process: proc,
				...(config.initializationOptions
					? { initialization: config.initializationOptions }
					: {}),
			};
		},
	};
}

// --- Registry Management ---

const EMPTY_CONFIG: RegisteredLSPConfig = {
	customServers: [],
	// Avoid reading LSP_SERVERS during the config/server module cycle. The
	// selection helper falls back to the live builtin table after evaluation.
	registeredServers: [],
	disabledServerIds: new Set(),
	serverOverrides: new Map(),
};

/** In-flight config initialization promises to prevent duplicate concurrent loads */
const configInFlight = new Map<string, Promise<void>>();

function normalizeWorkspacePath(cwd: string): string {
	return path.resolve(cwd);
}

type ProvenanceMap = ReadonlyMap<string, Provenance>;
let unknownTrustNoticeGeneration = -1;

function sourceFor(
	provenance: ProvenanceMap,
	key: string,
): Provenance | undefined {
	const direct = provenanceFor({ value: undefined, provenance }, key);
	if (direct) return direct;
	// Object leaves carry provenance below the object pointer. The registry
	// still needs the source tier for the whole executable object.
	let fallback: Provenance | undefined;
	for (const [candidate, entry] of provenance) {
		if (!candidate.startsWith(`${key}/`)) continue;
		if (isRepoTier(entry.tier)) return entry;
		fallback ??= entry;
	}
	return fallback;
}

function executableAllowed(
	provenance: Provenance | undefined,
	trust: ProjectTrustState,
): boolean {
	return !provenance || !isRepoTier(provenance.tier) || trust === "trusted";
}

function registryDecision(
	id: string,
	field: string,
	provenance: Provenance | undefined,
	trust: ProjectTrustState,
	allowed: boolean,
): void {
	if (allowed || !provenance || !isRepoTier(provenance.tier)) return;
	const subject = `${id}:${field}:${provenance.tier}`;
	const reason = `project LSP ${field} refused for ${id}: pi project trust is ${trust}`;
	recordDegradationOnce({
		kind: "lsp-registry-decision",
		subject,
		reason,
		metadata: { serverId: id, field, tier: provenance.tier, trust },
	});
	if (trust === "unknown") {
		const generation = getDegradationLedgerGeneration();
		if (unknownTrustNoticeGeneration !== generation) {
			unknownTrustNoticeGeneration = generation;
			logExtension({
				subsystem: "lsp-registry",
				level: "warn",
				message:
					"project LSP executables refused: mark the project trusted in pi or upgrade pi",
				metadata: { serverId: id, field },
			});
		}
	}
}

function isSameOrChildPath(filePath: string, candidateRoot: string): boolean {
	if (filePath === candidateRoot) return true;
	return filePath.startsWith(`${candidateRoot}${path.sep}`);
}

function getConfigForFile(filePath: string): RegisteredLSPConfig {
	const resolvedFilePath = path.resolve(filePath);
	let bestMatch: { root: string; config: RegisteredLSPConfig } | undefined;

	// #2518: the per-root configs ARE the session-root registry's values, so
	// this walk sees a config for exactly the roots that registry still serves.
	// `undefined` is a root whose first load is still in flight — the same
	// "no entry yet" state this walk skipped before the two stores merged.
	for (const [root, config] of sessionRootConfigEntries()) {
		if (config === undefined) continue;
		if (!isSameOrChildPath(resolvedFilePath, root)) continue;
		if (!bestMatch || root.length > bestMatch.root.length) {
			bestMatch = { root, config };
		}
	}

	return bestMatch?.config ?? EMPTY_CONFIG;
}

/**
 * THE `LSPConfig` → `RegisteredLSPConfig` conversion: construct the custom
 * servers, index the deny list, index the overrides. Pure — it reads no
 * module state and writes none.
 *
 * Extracted from `initLSPConfig`'s body in #2427 review round 3 so that
 * `effectiveConfig` can build the config its question needs WITHOUT calling
 * `initLSPConfig`. That call was the finding: a read-only query ran a full
 * session initialization, which (a) registered the caller's cwd as a served
 * session root, widening the #2052 access gate for a tree the session never
 * opened, and (b) wrote the per-root config store, which was then a separate
 * 32-entry LRU, so ~40 queries against other directories evicted a live root's
 * config and silently lifted the operator's `disabledServers` denial — the
 * exact inversion the surface promises cannot happen. With the conversion
 * spelled here, both writes stop being something the query has to opt out of:
 * it never reaches them. (#2518 later removed the second cap by making the
 * config the registry's own value; a query that skips the registry still skips
 * both.)
 *
 * Still ONE definition, so the derived config and the session-registered one
 * cannot disagree about what a document means.
 */
export function registerLSPConfig(config: LSPConfig): RegisteredLSPConfig {
	return compileLspRegistry(config, config.__provenance);
}

/**
 * The one LSP config-to-runtime boundary. Every executable field is checked
 * here, before a server or override reaches selection, initialization, or a
 * spawn callback. Global values are operator-authorized; project values need
 * pi's current trust answer. Denials never get lifted by a weaker source.
 */
export function compileLspRegistry(
	config: LSPConfig,
	provenance: ProvenanceMap = new Map(),
): RegisteredLSPConfig {
	const trust = getProjectTrustState();
	const customServers: LSPServerInfo[] = [];
	const disabledServerIds = new Set(config.disabledServers ?? []);

	if (config.servers) {
		for (const [id, serverConfig] of Object.entries(config.servers)) {
			const commandSource = sourceFor(provenance, `/lsp/servers/${id}/command`);
			const commandAllowed = executableAllowed(commandSource, trust);
			registryDecision(id, "command", commandSource, trust, commandAllowed);
			if (!commandAllowed) continue;
			const envSource = sourceFor(provenance, `/lsp/servers/${id}/env`);
			const initSource = sourceFor(
				provenance,
				`/lsp/servers/${id}/initializationOptions`,
			);
			const envAllowed = executableAllowed(envSource, trust);
			const initAllowed = executableAllowed(initSource, trust);
			registryDecision(id, "env", envSource, trust, envAllowed);
			registryDecision(
				id,
				"initializationOptions",
				initSource,
				trust,
				initAllowed,
			);
			const admitted: CustomServerConfig = { ...serverConfig };
			if (!envAllowed) delete admitted.env;
			if (!initAllowed) delete admitted.initializationOptions;
			try {
				const server = createCustomServer(admitted, id);
				customServers.push({ ...server, trustAllowed: true });
			} catch {
				// pi-lens-ignore: missing-error-propagation — per-server registration, skip bad entries
			}
		}
	}

	const serverOverrides = new Map<string, ServerInitOverride>();
	if (config.serverOverrides) {
		for (const [id, entry] of Object.entries(config.serverOverrides)) {
			if (entry && typeof entry === "object" && !Array.isArray(entry)) {
				const initOpts = (entry as Record<string, unknown>)
					.initializationOptions;
				const command = (entry as ServerInitOverride).command;
				const commandSource = sourceFor(
					provenance,
					`/lsp/serverOverrides/${id}/command`,
				);
				const envSource = sourceFor(
					provenance,
					`/lsp/serverOverrides/${id}/env`,
				);
				const initSource = sourceFor(
					provenance,
					`/lsp/serverOverrides/${id}/initializationOptions`,
				);
				const commandAllowed = executableAllowed(commandSource, trust);
				const envAllowed = executableAllowed(envSource, trust);
				const overrideInitAllowed = executableAllowed(initSource, trust);
				registryDecision(
					id,
					"command override",
					commandSource,
					trust,
					commandAllowed,
				);
				registryDecision(id, "env override", envSource, trust, envAllowed);
				registryDecision(
					id,
					"initializationOptions",
					initSource,
					trust,
					overrideInitAllowed,
				);
				if (
					command !== undefined ||
					(entry as ServerInitOverride).env !== undefined ||
					(initOpts !== undefined &&
						typeof initOpts === "object" &&
						initOpts !== null &&
						!Array.isArray(initOpts))
				) {
					serverOverrides.set(id, {
						...(overrideInitAllowed && initOpts !== undefined
							? { initializationOptions: initOpts as Record<string, unknown> }
							: {}),
						...(commandAllowed && command !== undefined ? { command } : {}),
						...(envAllowed && (entry as ServerInitOverride).env
							? { env: (entry as ServerInitOverride).env }
							: {}),
					});
				}
			}
		}
	}

	const overriddenBuiltins = LSP_SERVERS.map((server) => {
		const override = serverOverrides.get(server.id);
		if (!override?.command) return { ...server };
		const argv = Array.isArray(override.command)
			? override.command
			: [override.command, "--stdio"];
		return {
			...server,
			trustAllowed: true,
			async spawn(
				root: string,
				options?: import("./server.js").LSPSpawnOptions,
			) {
				void options;
				const program = argv[0];
				if (!program)
					throw new Error(`empty command override for ${server.id}`);
				const proc = await launchLSP(program, argv.slice(1), {
					cwd: root,
					env: override.env ? { ...process.env, ...override.env } : process.env,
				});
				return { process: proc };
			},
		};
	});
	return {
		customServers,
		registeredServers: overriddenBuiltins,
		disabledServerIds,
		serverOverrides,
	};
}

/**
 * Drop the `config_resolved` claim of every root the registry just evicted
 * (#2518 review F1).
 *
 * `recordConfigResolved` claims that row once per (session, root), which is
 * right while the resolved config is still in the store: a second
 * `loadLSPConfig` for a root already resolved this session re-derives the same
 * answer and needs no second row. An EVICTED root is the other case — its
 * resolved config is gone, the reload is a genuine second resolution, and its
 * row is the only record of what the reloaded config was. Without this release
 * the reload publishes a `config_resolution_pending` mark that no row ever
 * answers, which reads in the analyzer exactly like a resolution that never
 * finished.
 *
 * Rows stay bounded because evictions do, and evictions are counted:
 * `lsp-session-root-evicted` in the degradation ledger.
 *
 * The release derives its key with {@link configResolutionKey}, the ONE
 * expression the claim itself is taken with — not a second normalization that
 * happens to match. Round 2 shipped `normalizeFilePath(root)` here against a
 * claim keyed on the caller's own `normalizeFilePath(cwd)`, which is the same
 * string only when `path.resolve` is the identity on that cwd: a trailing
 * slash (what `analysisRoot` from `.pi-lens.json` and the warm paths can pass)
 * made the release miss and the reload silent again (review F6).
 */
function forgetConfigResolvedClaims(evictedRoots: readonly string[]): void {
	for (const root of evictedRoots) {
		releasePhaseClaim(CONFIG_RESOLVED_PHASE, configResolutionKey(root));
	}
}

/**
 * Initialize LSP configuration (call at session start).
 * Deduplicates concurrent calls for the same workspace.
 *
 * It takes no options on purpose. Every one of its callers is a session
 * DECLARING a root it will serve — `ensureLSPConfigInitialized`, `ensureReady`,
 * `runtime-session.ts`, `lens-engine.ts` — and a session-start load is exactly
 * the caller that must report its config notices. There is no mode in which
 * this function runs silently, because there is no caller that is not a
 * session (#2427 review round 3).
 */
export async function initLSPConfig(cwd: string): Promise<void> {
	const normalizedCwd = normalizeWorkspacePath(cwd);
	// #2052: this cwd is now a served session root. Registered BEFORE the
	// in-flight dedup return below, so a concurrent duplicate init still
	// registers it rather than returning early with the root unrecorded.
	forgetConfigResolvedClaims(registerSessionRoot(normalizedCwd));

	const existing = configInFlight.get(normalizedCwd);
	if (existing) return existing;

	const promise = (async () => {
		const config = registerLSPConfig(await loadLSPConfig(cwd, os.homedir()));
		forgetConfigResolvedClaims(setSessionRootConfig(normalizedCwd, config));
	})();

	configInFlight.set(normalizedCwd, promise);
	try {
		await promise;
	} finally {
		// Identity-guarded release (#1968's pattern): delete only if THIS run is
		// still the registered one. A bare delete-by-key lets a late-settling run
		// evict a live successor a second writer registered under the same cwd
		// mid-flight, after which the next caller starts a duplicate config load.
		if (configInFlight.get(normalizedCwd) === promise) {
			configInFlight.delete(normalizedCwd);
		}
	}
}

/**
 * Every server a workspace knows about, in registry-then-custom order and
 * BEFORE any gate is applied.
 *
 * Spelled once because two callers need the same list for opposite purposes:
 * `getAllServers` DROPS the disabled ones, `explainServersForFile` REPORTS
 * them. A custom server that only one of the two composed would be a server
 * the runtime runs and the introspection cannot see, or the reverse.
 */
function registeredServers(config: RegisteredLSPConfig): LSPServerInfo[] {
	const builtins = config.registeredServers.length
		? config.registeredServers
		: LSP_SERVERS;
	return [...builtins, ...config.customServers];
}

/**
 * Get all available servers (built-in + custom, minus disabled)
 */
export function getAllServers(filePath?: string): LSPServerInfo[] {
	const config = filePath ? getConfigForFile(filePath) : EMPTY_CONFIG;
	return registeredServers(config).filter(
		(s) => !config.disabledServerIds.has(s.id),
	);
}

/**
 * Check if a server is disabled
 */
export function isServerDisabled(serverId: string, filePath?: string): boolean {
	const config = filePath ? getConfigForFile(filePath) : EMPTY_CONFIG;
	return config.disabledServerIds.has(serverId);
}

// --- Override getServersForFile to include custom servers

/**
 * Why a server did or did not attach to a file. A closed union: it is public
 * API the moment `pilens_effective_config` renders it, so a new member arrives
 * through `docs/public-api-stability.md`.
 */
export type ServerSelectionReason =
	| "selected"
	| "disabled-by-config"
	| "extension-mismatch"
	| "path-filter";

/** One server's selection decision for a file. */
export interface ServerSelection {
	readonly server: LSPServerInfo;
	readonly selected: boolean;
	readonly reason: ServerSelectionReason;
}

/**
 * THE server-selection gate: why this server does or does not attach to this
 * file (#2427).
 *
 * One evaluation, two projections. `getServersForFileWithConfig` asks it for a
 * verdict and `explainServersForFile` asks it for a reason; before #2427 the
 * verdict lived here and the reason did not exist, so answering "why is server
 * X not running" meant re-implementing these three gates at the asking site —
 * a second copy of a filter is a copy that drifts, which is what AGENTS.md's
 * single-source-of-truth rule forbids.
 *
 * Returning a REASON rather than a boolean is also what keeps the verdict path
 * allocation-free: `getServersForFileWithConfig` runs per file on the dispatch
 * and cascade paths, and materializing one decision object per registered
 * server per call would put ~46 short-lived objects on a hot path to serve a
 * question only the introspection surface asks.
 *
 * Gate order is the ANSWER order, not just an implementation detail: a server
 * the operator disabled reports `disabled-by-config` even when the file's
 * extension would not have matched it anyway, because "you turned it off" is
 * the fact the asker can act on.
 */
function selectionReason(
	server: LSPServerInfo,
	config: RegisteredLSPConfig,
	filePath: string,
	ext: string,
	base: string,
): ServerSelectionReason {
	if (config.disabledServerIds.has(server.id)) return "disabled-by-config";
	let matched = false;
	for (const value of server.extensions) {
		const lower = value.toLowerCase();
		if (lower === ext || lower === base) {
			matched = true;
			break;
		}
	}
	if (!matched) return "extension-mismatch";
	// #636: a server's extension match can be intentionally broader than what
	// it can usefully act on (zizmor attaches to "yaml" but only ever reports
	// on GitHub Actions workflow/action/dependabot paths). `pathFilter`, when
	// present, is an ADDITIONAL narrowing gate — never a widening one.
	if (server.pathFilter && !server.pathFilter(filePath)) return "path-filter";
	return "selected";
}

/**
 * Every registered server's decision for a file, with the reason for each.
 *
 * `config` defaults to the SESSION's registered config for the file's tree —
 * what the runtime would actually use. An explicit one is for a caller that
 * must not touch session state to ask: `effectiveConfig` derives its own from
 * `loadLSPConfig(..., { report: false })` rather than initializing the
 * workspace (#2427 review round 3). Both spellings run the identical gate, and
 * `tests/clients/effective-config.test.ts` pins them equal for the same cwd.
 */
export function explainServersForFile(
	filePath: string,
	config: RegisteredLSPConfig = getConfigForFile(filePath),
): ServerSelection[] {
	const ext = path.extname(filePath).toLowerCase();
	const base = path.basename(filePath).toLowerCase();
	return registeredServers(config).map((server) => {
		const reason = selectionReason(server, config, filePath, ext, base);
		return { server, selected: reason === "selected", reason };
	});
}

export function getServersForFileWithConfig(filePath: string): LSPServerInfo[] {
	const config = getConfigForFile(filePath);
	const ext = path.extname(filePath).toLowerCase();
	const base = path.basename(filePath).toLowerCase();
	return registeredServers(config).filter(
		(server) =>
			selectionReason(server, config, filePath, ext, base) === "selected",
	);
}

/**
 * The primary language server ENTRY for a file — the one "first non-auxiliary
 * server" predicate, shared by {@link primaryServerId} and
 * {@link resolveLspCwdForFile} so the id-level and entry-level consumers
 * cannot drift. Auxiliary-ness is {@link isAuxiliary}'s answer, never a
 * comparison against the role literal (#1488).
 */
function primaryServerEntry(filePath: string): LSPServerInfo | undefined {
	return getServersForFileWithConfig(filePath).find((s) => !isAuxiliary(s));
}

/**
 * The primary language server for a file (e.g. "typescript"), as opposed to a
 * cross-cutting auxiliary scanner attached via clientScope "all"/
 * "with-auxiliary". Used to split a file's diagnostics into "primary
 * confirmation" vs "auxiliary findings" so a page of scanner noise never
 * buries whether the actual type checker/compiler confirmed the file clean.
 *
 * The auxiliary population is NOT listed here: it is whatever declares
 * `role: "auxiliary"` in clients/lsp/server.ts, derived by
 * `tests/config/lsp-server-trait-table.test.ts` and matched there against the
 * diagnostic profiles in clients/dispatch/auxiliary-lsp.ts. This comment used
 * to hand-list it and named marksman, which declares `role: "language"` —
 * the drift #1488's registry-derived coverage test exists to stop.
 *
 * #646: extracted from `tools/lsp-diagnostics.ts` (where it originated) so
 * `tools/lens-diagnostics.ts`'s `mode=full` sweep can share the exact same
 * primary/auxiliary classification instead of hand-copying it — both tools
 * now report the same primary-vs-auxiliary split for the same file.
 */
export function primaryServerId(filePath: string): string | undefined {
	return primaryServerEntry(filePath)?.id;
}

/**
 * #2777 O1: the one seam a tool uses to answer "which cwd did this file's
 * primary LSP server resolve to". Folds the three-step lookup callers used to
 * hand-roll (`primaryServerId` + `getServersForFileWithConfig` +
 * `resolveLspServerCwd`) into one call that returns `undefined` for a file
 * with no primary LSP server, so the caller must handle the absent case
 * instead of rendering it (the N1 `cwd=undefined` row becomes structurally
 * impossible).
 *
 * #3750: `onRootFallback` fires when the primary's root resolution fell back
 * (the `lsp:server-root-*` degradation), so a verdict can name it.
 */
export async function resolveLspCwdForFile(
	filePath: string,
	sessionCwd: string,
	onRootFallback?: (fallback: LspRootFallback) => void,
): Promise<string | undefined> {
	const primary = primaryServerEntry(filePath);
	if (!primary) return undefined;
	return resolveLspServerCwd(
		primary,
		filePath,
		sessionCwd,
		undefined,
		onRootFallback,
	);
}

/**
 * Look up an initializationOptions override for a built-in server.
 * Returns undefined when no config was loaded or no override was specified
 * for this server ID.
 *
 * @param serverId  Built-in server id (e.g. "rust", "nix", "bash")
 * @param filePath  Any file path within the project (used to locate the
 *                  workspace config that was loaded for this directory tree)
 */
export function getServerInitOverride(
	serverId: string,
	filePath: string,
): ServerInitOverride | undefined {
	return getConfigForFile(filePath).serverOverrides.get(serverId);
}

export function resetLSPConfigStateForTests(): void {
	resetLSPCaseSensitivityState();
	// One call clears both the served roots and their configs: since #2518 they
	// are one store, so a reset cannot leave a cleared config store beside a
	// live session-root registry declining files for roots nothing can serve.
	resetSessionRootsForTests();
	// The warn latch is loader state too: a test that re-reads the same broken
	// path after this reset must see the warning again, not a latched silence.
	resetLSPConfigWarnCache();
	// #2526: same reasoning for the per-session `config_resolved` claim — a
	// test that resolves again after this reset must produce its record, not
	// inherit a previous test's "already recorded" claim. Narrowed to THIS
	// loader's own phase (review round 2, S1): the blanket
	// `resetOncePerSessionPhases()` this used to call is the SESSION boundary's
	// call to make — it also re-mints the session identity — and reaching for
	// it from one producer's test reset cleared claims this module does not own.
	releaseOncePerSessionPhase(CONFIG_RESOLVED_PHASE);
}

/**
 * Test hook — read the `initLSPConfig` in-flight map directly (#1968's ABA
 * regression: a second writer replacing an entry mid-flight, then a
 * late-settling first run evicting it with a bare delete-by-key).
 */
export function _peekConfigInFlightForTests(): Map<string, Promise<void>> {
	return configInFlight;
}

// Re-export with config support
export { getAllServers as getServersForFile };
