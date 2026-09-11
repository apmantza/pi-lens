/**
 * Effective-config introspection (#2427; the introspection addition to #2415).
 *
 * ONE query answers "why is X running / selected", which today costs log
 * forensics across `lsp/config.ts`, `language-policy.ts` and the trust state.
 * `LSPService.getCapabilitySnapshots` is the proven template: compute the
 * answer once in the engine, project it through every adapter unchanged.
 *
 * Three rules this module is built on, and none of them is negotiable at a
 * call site:
 *
 * 1. IT DECIDES NOTHING. Every answer is read back from the same production
 *    machinery the runtime uses — `resolvePiLensConfig` for the resolution,
 *    `explainServersForFile` for the LSP gates, `detectFileKind` +
 *    `getToolPlan` + `getAvailableRunners` for dispatch. A second evaluation
 *    that agreed with production today would disagree with it eventually, and
 *    an introspection surface that lies is worse than none.
 * 2. IT REPORTS NOTHING. `resolveConfig` is pure and `reportPiLensConfigRecords`
 *    is a separate, explicit step (`config-core/index.ts`) precisely so a
 *    caller decides when a user gets warned. Asking "what is my config" must
 *    not emit a deprecation notice, and must not consume the warn-once latch
 *    that the loader needs — so this module carries record CODES and counts,
 *    and never calls the reporter.
 * 3. THE REDACTED VIEW IS THE ONLY VIEW. There is no `redact: false`. Config
 *    file paths are rewritten home-relative, a custom server's argv is cut to
 *    `argv[0]`, and its environment is reduced to NAMES — the two places a
 *    secret actually lives (#2415 AC 4). The `redact` option exists only
 *    because the issue named it; it is `true` or absent, and both mean the
 *    same thing, so no future caller can spell an unredacted request.
 */

import * as os from "node:os";
import * as path from "node:path";
import {
	compareKeys,
	type Provenance,
	provenanceFor,
	type ProvenanceViewEntry,
	provenanceView,
	type Resolved,
	type SourceTier,
} from "./config-core/provenance.js";
import { LSP_NAMESPACE_KEY } from "./config-locations.js";
import {
	type ConfigDocumentSummary,
	lspSectionOf,
	type PiLensConfigResolution,
	resolvePiLensConfig,
	summarizeConfigResolution,
} from "./config-resolve.js";
import { getToolPlan } from "./dispatch/plan.js";
import { getAvailableRunners } from "./dispatch/integration.js";
import { detectFileKind } from "./file-kinds.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { type LanguageEntry, resolveLanguage } from "./language-registry.js";
import { getPiLensGlobalConfigPath } from "./lens-config.js";
import {
	explainServersForFile,
	lspConfigOf,
	registerLSPConfig,
	type RegisteredLSPConfig,
	type ServerSelectionReason,
} from "./lsp/config.js";
// The shared path-shape-aware containment comparator (#1150/#1152 defect
// shape) — the SAME one the session-root registry
// (`clients/lsp/session-roots.ts`) gates enrollment with. A second
// hand-rolled `path.relative`/prefix check here is how the two would drift
// apart on a Windows-shaped path (AGENTS.md defect shape 2).
import { isSameOrWithin } from "./lsp/server.js";
import { homeRelativePath } from "./path-utils.js";
import { resolveToolCwd } from "./tool-cwd.js";
import { compareOrdinal } from "./string-utils.js";
import { LENS_TOOL_NAMES, resolveLensToolEnabled } from "./tool-config.js";

export interface EffectiveConfigOptions {
	/** Workspace the resolution is performed for. Defaults to `process.cwd()`. */
	readonly cwd?: string;
	/** Add the per-file selection view for this path. */
	readonly file?: string;
	/**
	 * Accepted and ignored. Redaction is unconditional; see rule 3 in the module
	 * doc. The option exists so a caller that spells it is not an error, not so
	 * that omitting it means anything.
	 */
	readonly redact?: true;
	/** `$HOME` used for home-relative rewriting. Test seam only. */
	readonly homeDir?: string;
	readonly noTools?: string | readonly string[];
}

/**
 * One config document that contributed to the resolution.
 *
 * When a `file` is asked about AND it resolves inside `cwd`, the resolution —
 * and therefore this list — is taken at that file's own directory, so it
 * names the nested documents that decided the file half too (#2427 review
 * round 5, F-R4-1); the walk is upward and CONFINED to `cwd`, so the
 * workspace's own documents are always included too. A `file` outside `cwd`
 * is CONFINED, not answered from its own unrelated tree (#2520): it is
 * rejected (`file: { error: ... }`, see {@link effectiveConfig}) and this
 * list is taken at `cwd` itself, exactly as if no `file` had been asked
 * about at all.
 */
type EffectiveConfigDocument = ConfigDocumentSummary;

/** A custom server's definition, reduced to what cannot carry a secret. */
interface RedactedServerSpec {
	/** `argv[0]` only. */
	readonly command?: string;
	/** How many argv entries the definition carries, including `argv[0]`. */
	readonly argvCount: number;
	/** Env NAMES, sorted. Values never appear on this surface. */
	readonly envNames: readonly string[];
}

/** One server's answer for a file, with the reason and the tier that decided. */
export interface EffectiveServerDecision {
	readonly id: string;
	readonly selected: boolean;
	readonly reason: ServerSelectionReason;
	/** `"auxiliary"` for cross-cutting scanners; absent for language servers. */
	readonly role?: string;
	/** The provenance of the config leaf that produced a config-made decision. */
	readonly decidedBy?: ProvenanceViewEntry;
	/** Present only for a server defined by configuration. */
	readonly spec?: RedactedServerSpec;
}

/** Why a runner did or did not make a file's dispatch plan. */
type ToolSelectionReason =
	| "selected"
	| "not-registered-for-kind"
	| "no-dispatch-plan";

interface EffectiveToolDecision {
	readonly id: string;
	readonly selected: boolean;
	readonly reason: ToolSelectionReason;
	readonly resolvedCwd: string;
}

/** The per-file half: language, servers, tools. */
export interface EffectiveFileView {
	/** Home-relative when the file is under `$HOME`. */
	readonly path: string;
	/** The canonical language id from `clients/language-registry.ts`. */
	readonly language?: string;
	/** The coarse dispatch kind, when `file-kinds.ts` classifies the file. */
	readonly kind?: string;
	readonly servers: readonly EffectiveServerDecision[];
	readonly tools: readonly EffectiveToolDecision[];
}

/**
 * The per-file half's answer when `file` was named but does not resolve
 * inside `cwd`. `effectiveConfig` rejects rather than answers for a foreign
 * tree (#2520) — see the CONFINED note on {@link effectiveConfig}.
 */
export interface EffectiveFileViewError {
	readonly error: string;
}

/** True when a `file` half is the rejection shape, not a resolved view. */
export function isEffectiveFileViewError(
	file: EffectiveFileView | EffectiveFileViewError,
): file is EffectiveFileViewError {
	return "error" in file;
}

export interface EffectiveConfigView {
	/** Home-relative when the workspace is under `$HOME`. */
	readonly cwd: string;
	readonly documents: readonly EffectiveConfigDocument[];
	/** Every resolved leaf's source. Sources only, never values. */
	readonly provenance: readonly ProvenanceViewEntry[];
	/** How many leaves each tier decided. The shape `pilens_health` embeds. */
	readonly provenanceCounts: Readonly<Record<SourceTier, number>>;
	/** The stable `PILENS_CFG_*` codes this resolution produced, with counts. */
	readonly recordCounts: Readonly<Record<string, number>>;
	readonly tools: readonly { name: string; enabled: boolean }[];
	/**
	 * Absent when no `file` was asked about. `{ error }` when one was named but
	 * lies outside `cwd` — never a view resolved against a tree unrelated to the
	 * workspace this answer is `cwd`-labelled as (#2520).
	 */
	readonly file?: EffectiveFileView | EffectiveFileViewError;
}

function countBy<T>(items: readonly T[], key: (item: T) => string) {
	const counts: Record<string, number> = {};
	for (const item of items) {
		const name = key(item);
		counts[name] = (counts[name] ?? 0) + 1;
	}
	return counts;
}

/**
 * Redact a `lsp.servers.<id>` entry.
 *
 * Deliberately NOT `redactProcessSpec`: that takes a built `ProcessSpec`, and
 * a custom server is still the pre-#2416 bare `{ command, args, env }` shape.
 * The INVARIANT is the same one and is spelled the same way — `argv[0]` and
 * env NAMES survive, everything else does not — so when #2416 replaces the
 * shape this projection is deleted rather than adapted.
 */
function redactServerSpec(entry: unknown): RedactedServerSpec | undefined {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return undefined;
	}
	const record = entry as Record<string, unknown>;
	const command =
		typeof record.command === "string" ? record.command : undefined;
	const args = Array.isArray(record.args) ? record.args : [];
	const env =
		typeof record.env === "object" && record.env !== null
			? Object.keys(record.env as Record<string, unknown>).sort(compareOrdinal)
			: [];
	return {
		...(command === undefined ? {} : { command }),
		argvCount: (command === undefined ? 0 : 1) + args.length,
		envNames: env,
	};
}

/**
 * The provenance of a SUBTREE — the entry at the pointer, else the nearest
 * ancestor's, else the lowest-sorting leaf beneath it.
 *
 * `provenanceFor` walks UP only, and that is correct for its question: a leaf
 * asks who decided it. An object node asks the opposite question. `merge()`
 * records provenance at the leaves, so `lsp.servers.<id>` — an object — has no
 * entry of its own and no ancestor with one either, and asking `provenanceFor`
 * about it answers `undefined` for a section a file demonstrably contributed.
 * Descending settles it: the entry sorts deterministically (`compareKeys`), so
 * the same config produces the same attribution on every machine.
 */
function provenanceOfSubtree(
	resolved: Resolved<Record<string, unknown>>,
	pointer: string,
): Provenance | undefined {
	const own = provenanceFor(resolved, pointer);
	if (own) return own;
	const prefix = `${pointer}/`;
	let best: Provenance | undefined;
	for (const entry of resolved.provenance.values()) {
		if (!entry.key.startsWith(prefix)) continue;
		if (!best || compareKeys(entry.key, best.key) < 0) best = entry;
	}
	return best;
}

/**
 * The provenance entry governing a pointer, projected and home-relative.
 *
 * Goes through `provenanceFor`, which walks to the nearest ancestor — and for
 * a deny union that ancestry now MATTERS (#2427 review round 2, F2).
 * `merge()` records an entry at the array's own pointer AND one per surviving
 * member, so `/lsp/disabledServers/0` and `/lsp/disabledServers`
 * deliberately give DIFFERENT answers: the array names the tier that denied
 * first, the member names the tier that contributed that member. Round 1 of
 * this PR asserted they were the same, read the array entry for every server,
 * and reported a project-tier denial as a global one. Asking about a member
 * that has no entry of its own still falls back to the array, which is the
 * walk doing its job rather than an accident.
 */
function viewOf(
	entry: Provenance | undefined,
	homeDir: string | undefined,
): ProvenanceViewEntry | undefined {
	if (!entry) return undefined;
	return {
		key: entry.key,
		tier: entry.tier,
		...(entry.file === undefined
			? {}
			: { file: homeRelativePath(entry.file, homeDir) }),
		...(entry.trust === undefined ? {} : { trust: entry.trust }),
	};
}

/**
 * `{ decidedBy }`, or nothing when there is no provenance to report.
 *
 * A named helper because the alternative at the call site is a ternary inside a
 * spread inside a ternary, which is the nesting SonarCloud flags and a reader
 * has to unpick to learn one fact.
 */
function decidedByOrNothing(entry: ProvenanceViewEntry | undefined): {
	decidedBy?: ProvenanceViewEntry;
} {
	return entry === undefined ? {} : { decidedBy: entry };
}

/**
 * The resolved model of pi-lens's configuration, with the provenance of every
 * decision — and, for one file, which servers and tools that configuration
 * selects or denies and why.
 *
 * ASKING CHANGES NOTHING (#2427 review round 3). The per-file half needs a
 * workspace's registered LSP config — `getConfigForFile` answers EMPTY for a
 * tree nothing initialized, which would report every server as selected — and
 * round 2 got it by calling `initLSPConfig(cwd, { report: false })`. That
 * inverted this surface's own guarantee: `initLSPConfig` is the session-root
 * registry's single writer and the per-root config store's only producer, so
 * a question about a foreign directory enrolled it as a served LSP root
 * (widening the #2052 access gate) and, after ~40 such questions, evicted a
 * live root's config from what was then a separate 32-entry LRU — silently
 * lifting the operator's `disabledServers` denial, which is precisely what
 * this surface promises cannot happen, and `shouldInitializeSessionRoot` never
 * repaired it because the 128-entry registry still reported the root served.
 * #2518 collapsed those two containers into one entry per root, so the second
 * half of that failure is gone; the first half — a read-only query enrolling a
 * foreign root at all — is still this surface's own to avoid
 *
 * So the query DERIVES the config instead: `lspConfigOf` (the projection
 * `loadLSPConfig` returns, minus the notices — rule 2) through the same
 * `registerLSPConfig` conversion, handed to `explainServersForFile` as an
 * explicit argument. Same gate, same answer, no write.
 *
 * ONE RESOLUTION ANSWERS THE WHOLE QUERY (#2427 review round 5, F-R4-1), taken
 * at the FILE's own directory whenever a file is asked about — matching what
 * the runtime registers via `ensureLSPConfigInitialized(path.dirname(filePath))`,
 * because a nested `repo/sub/.pi-lens.json` layer (config.ts header point 3)
 * reaches the runtime's decision no other way (round 4, F1).
 *
 * Round 4 moved the GATES to that root and left the rest — the redacted spec,
 * every `decidedBy`, the `documents` list — reading a SECOND resolution taken
 * at the workspace root. Two roots, and they disagreed: the view named the
 * root's definition of a server the runtime spawns from the nested one,
 * attributed a nested denial to whichever tier denied first at the root, and
 * omitted the nested document. Deriving both halves from a single resolution
 * makes that class of disagreement unrepresentable rather than fixed.
 *
 * The file-directory root is a SUPERSET of the workspace's ONLY when `file`
 * resolves inside `cwd` — the project walk runs upward and is
 * ceiling-bounded, so a nested `file` naturally passes back through the
 * workspace's own document on its way up. A `file` outside `cwd` has no such
 * relationship: its own ancestry can omit the workspace's document entirely
 * while `cwd` above still names the workspace, mislabelling a foreign tree's
 * config as this workspace's own (#2520). So the containment is CONFINED, not
 * assumed: a `file` that does not resolve inside `cwd` is rejected — with
 * `file: { error }` naming the `cwd` it was measured against and the remedy
 * (re-query with `cwd` set to the file's own workspace) — rather than
 * answered from an unrelated root. This confinement is a trade the query
 * makes deliberately, not a limitation to route around: it also rejects a
 * SIBLING package in the SAME monorepo (`cwd` at `repo/packages/a`, `file`
 * under `repo/packages/b`) even though both share a repo root, because the
 * per-file half is only ever correct when it is a superset of the workspace
 * half — a caller who wants package `b`'s answer queries with `cwd` set to
 * `repo/packages/b`. When no `file` is asked about, or the confined one is
 * used, the root IS (or nests under) the workspace `cwd`, and the fileless
 * case is the view `pilens_health` takes on every call.
 *
 * The differentials are pinned in `tests/clients/effective-config.test.ts`.
 */
export async function effectiveConfig(
	options: EffectiveConfigOptions = {},
): Promise<EffectiveConfigView> {
	const cwd = options.cwd ?? process.cwd();
	const homeDir = options.homeDir ?? os.homedir();
	// The resolution, at whichever directory this query is answered FROM.
	//
	// `homeDir` is threaded, unlike `initLSPConfig`'s hard-wired `os.homedir()`:
	// this call answers for the workspace the CALLER named, so the project walk
	// must stop at the `$HOME` the rest of the view is resolved against.
	//
	// No `onReadError`: rule 2. An unreadable file still shows up as a
	// `PILENS_CFG_0001` record count below, so the answer is not silent — it
	// just is not a second user-facing warning fired by a question. Nothing
	// here reports at all, which is why the query no longer routes through
	// `loadLSPConfig`: that loader's whole difference from this call is the
	// notices, and the query wants the resolution, not the notices.
	const resolveAt = (dir: string): PiLensConfigResolution =>
		resolvePiLensConfig({
			cwd: dir,
			globalDir: getGlobalPiLensDir(),
			globalConfigPath: getPiLensGlobalConfigPath(homeDir),
			homeDir,
		});

	// The queried path resolves HERE, beside the resolution root it selects, so
	// "is there a file half" is one condition rather than two a later edit could
	// disagree on. It is relative to the WORKSPACE, not to `process.cwd()`: a
	// caller that names a workspace and then a file inside it means that file,
	// and a bare `path.resolve` would silently answer for a same-named path
	// under the host process's own directory — a wrong answer wearing a
	// confident shape.
	const requestedFile =
		options.file === undefined ? undefined : path.resolve(cwd, options.file);

	// CONFINED, not assumed (#2520). A `file` that resolves outside `cwd` has
	// no containment relationship to the workspace this view is `cwd`-labelled
	// as: its own ancestor walk can reach a `.pi-lens.json` the workspace never
	// saw while omitting the workspace's own, and `resolveAt` below would
	// silently answer for that unrelated tree. `isSameOrWithin` is the shared
	// path-shape-aware comparator, not a hand-rolled prefix check, so a
	// Windows-shaped `cwd`/`file` pair is judged the same way on every host OS.
	const fileOutsideCwd =
		requestedFile !== undefined && !isSameOrWithin(cwd, requestedFile);
	const absolute = fileOutsideCwd ? undefined : requestedFile;

	// ONE RESOLUTION ANSWERS THE WHOLE QUERY (#2427 review round 5, F-R4-1),
	// and its root is the FILE's own directory whenever a CONFINED file is
	// asked about.
	//
	// The runtime registers LSP config at that directory —
	// `ensureLSPConfigInitialized(path.dirname(filePath))` in
	// `runtime-tool-call.ts` — and `getConfigForFile` answers with the deepest
	// registered ancestor, so a nested `repo/sub/.pi-lens.json` (config.ts
	// header point 3) only reaches the runtime's decision through the file's
	// own directory. Round 4 fixed the GATES that way but left every other fact
	// — the redacted spec, every `decidedBy`, the `documents` list — read off a
	// second resolution taken at the workspace root, so the query had two
	// resolution roots and they disagreed: it reported the root's definition of
	// a server the runtime spawns from the nested one, attributed a nested deny
	// to whichever tier denied FIRST at the root (the round-2 F2
	// misattribution, reopened), and omitted the nested document entirely. One
	// resolution makes the two halves unable to disagree by construction.
	//
	// A rejected (outside-`cwd`) file falls back to `cwd` itself here, same as
	// no file at all — the walk never touches the foreign tree.
	const resolution = resolveAt(
		absolute === undefined ? cwd : path.dirname(absolute),
	);

	const resolved = {
		value: resolution.value,
		provenance: resolution.provenance,
	};

	// The redacted document list and the per-tier counts come from the SHARED
	// projection (#2526), not from a second copy of the mapping here: the
	// `config_resolved` latency phase writes the same summary at session start,
	// and a surface that answers "what is my config" must not be able to
	// disagree with the record that says what was resolved.
	const summary = summarizeConfigResolution(resolution, homeDir);

	// Home-relative, like every path this module reports (rule 3) — including
	// the one named back in the rejection message below, so an agent reading
	// `file: { error }` sees the SAME `cwd` spelling the rest of the view
	// uses, not a second, raw-path rendering of it.
	const homeRelativeCwd = homeRelativePath(cwd, homeDir);

	const view: EffectiveConfigView = {
		cwd: homeRelativeCwd,
		documents: summary.documents,
		provenance: provenanceView(resolved, homeDir).entries,
		provenanceCounts: summary.countsByTier,
		recordCounts: countBy(resolution.records, (record) => record.code),
		tools: LENS_TOOL_NAMES.map((name) => ({
			name,
			enabled: resolveLensToolEnabled(
				name,
				resolved.value,
				undefined,
				options.noTools,
			),
		})),
		...(fileOutsideCwd
			? {
					file: {
						error:
							`file is outside cwd (${homeRelativeCwd}); query with cwd set ` +
							"to the file's own workspace instead",
					},
				}
			: absolute === undefined
				? {}
				: {
						file: await fileView(
							absolute,
							resolved,
							homeDir,
							cwd,
							// The gates read the LSP slice of that SAME resolution, through
							// the same `registerLSPConfig` conversion `initLSPConfig` uses —
							// no session-root registration, no per-root config-store write
							// (P11/P12). Computed here rather than hoisted into a
							// `{ absolute, lspConfig }` struct (#2520): `absolute` is already
							// this branch's narrowed local, so the struct's own field was
							// carrying the same fact twice.
							registerLSPConfig(lspConfigOf(resolution.value)),
						),
					}),
	};
	return view;
}

/**
 * Why a runner is or is not in the plan for a file.
 *
 * A named function rather than a nested ternary at the call site (#2427
 * review round 2, F3): the two-level conditional was one of the nesting
 * hits SonarCloud raises on this file, and the three answers read as a table
 * here.
 */
function toolReason(
	selected: boolean,
	kind: ReturnType<typeof detectFileKind>,
): ToolSelectionReason {
	if (selected) return "selected";
	return kind === undefined ? "no-dispatch-plan" : "not-registered-for-kind";
}

async function fileView(
	absolute: string,
	resolved: Resolved<Record<string, unknown>>,
	homeDir: string,
	workspaceCwd: string,
	lspConfig: RegisteredLSPConfig,
): Promise<EffectiveFileView> {
	const language: LanguageEntry | undefined = resolveLanguage(absolute);
	const kind = detectFileKind(absolute);
	const section = lspSectionOf(resolved.value);
	const customServers =
		typeof section.servers === "object" &&
		section.servers !== null &&
		!Array.isArray(section.servers)
			? (section.servers as Record<string, unknown>)
			: {};

	// The provenance that answers "why can I not turn THIS one back on".
	//
	// Per MEMBER, not per array (#2427 review round 2, F2). The union is
	// assembled from several tiers, so the array's own entry names only the tier
	// that denied FIRST; stamping it on every disabled server reported a
	// project-tier denial as a global one. `merge()` records an entry at each
	// member's pointer, so the answer is a lookup at the member's index in the
	// resolved list.
	//
	// The legacy root spelling is no longer a fallback: `resolvePiLensConfig`
	// normalizes it into the namespace at source injection, so `/disabledServers`
	// is not a pointer any resolution produces any more (F1).
	const denied = Array.isArray(section.disabledServers)
		? (section.disabledServers as unknown[])
		: [];
	const denyPointer = `/${LSP_NAMESPACE_KEY}/disabledServers`;
	const decidedByDeny = (id: string): ProvenanceViewEntry | undefined => {
		const index = denied.indexOf(id);
		// `provenanceFor` walks UP, so a member with no entry of its own still
		// answers with the array's — the right degradation, not a silent gap.
		return viewOf(
			provenanceFor(
				resolved,
				index >= 0 ? `${denyPointer}/${index}` : denyPointer,
			),
			homeDir,
		);
	};

	const servers: EffectiveServerDecision[] = explainServersForFile(
		absolute,
		lspConfig,
	).map((entry) => {
		const spec = redactServerSpec(customServers[entry.server.id]);
		return {
			id: entry.server.id,
			selected: entry.selected,
			reason: entry.reason,
			...(entry.server.role === undefined ? {} : { role: entry.server.role }),
			...(entry.reason === "disabled-by-config"
				? decidedByOrNothing(decidedByDeny(entry.server.id))
				: {}),
			...(spec === undefined
				? {}
				: {
						spec,
						...(entry.reason === "disabled-by-config"
							? {}
							: {
									decidedBy: viewOf(
										provenanceOfSubtree(
											resolved,
											`/${LSP_NAMESPACE_KEY}/servers/${entry.server.id}`,
										) ??
											provenanceOfSubtree(
												resolved,
												`/servers/${entry.server.id}`,
											),
										homeDir,
									),
								}),
					}),
		};
	});

	const available = new Set(await getAvailableRunners(absolute));
	const planned = kind
		? (getToolPlan(kind)?.groups.flatMap((group) => group.runnerIds) ?? [])
		: [];
	// Ordinal, not the default locale sort: this list is the ORDER of a payload
	// callers compare across machines, and a locale-sensitive comparator can
	// order the same ids differently under a different ICU build (#2427 review
	// round 2, F3; SonarCloud S2871).
	const ids = [...new Set([...planned, ...available])].sort(compareOrdinal);
	const tools: EffectiveToolDecision[] = ids.map((id) => ({
		id,
		selected: available.has(id),
		reason: toolReason(available.has(id), kind),
		resolvedCwd: homeRelativePath(
			resolveToolCwd("runner", id, absolute, {
				cwd: workspaceCwd,
				suppressTelemetry: true,
			}).cwd,
			homeDir,
		),
	}));

	return {
		path: homeRelativePath(absolute, homeDir),
		...(language === undefined ? {} : { language: language.id }),
		...(kind === undefined ? {} : { kind }),
		servers,
		tools,
	};
}
