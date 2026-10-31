/**
 * #4403: every diagnostics entry route, under every switch that selects
 * servers, starts the same servers and gives the same confirmation verdict.
 *
 * Recurrence: #4322 (a missing primary reported clean from an auxiliary alone)
 * and #4323 (explicit checks started a switched-off Opengrep). Both were fixed
 * route by route (#4390, #4391), and #4391's review found a seventh route still
 * drifting. Nothing stopped the next route from drifting the same way.
 *
 * Two halves:
 *
 * 1. The route list is derived from code. Every production access to an
 *    `LSPService` member that starts a server or returns diagnostics
 *    (`DIAGNOSTICS_ENTRY_MEMBERS`) is a site, and the scan fails closed: an
 *    access it cannot classify as a site, a definition or a local alias reds
 *    under a quoted key until it is exempted (see `deriveSites`). The AST scan
 *    never sees a comment, so prose cannot add or satisfy a site. Each site
 *    maps to a matrix route or carries an exemption whose key holds the site's
 *    `clientScope` and `diagnostics` options, so a site that widens its scope
 *    gets a new key and has to be placed again. A new site reds; so does a
 *    registry entry whose site is gone, and a route the registry names that the
 *    matrix does not drive. Out of reach: a member name built at run time, and
 *    a new caller of a route's existing helper.
 *
 * 2. The matrix drives each route through its real entry: pi's `tool_result`
 *    and `turn_end` hooks and the `lens_diagnostics` and `lsp_navigation`
 *    tools that the real extension activation registers, and the real MCP
 *    server over stdio. Language servers are the host boundary: each one's
 *    command is a project override pointing at a shim that appends the server
 *    id to a marker file and then runs the shared fake server, which answers
 *    every pull with no findings. A missing primary's command points at a path
 *    that does not exist. Each cell gets a fresh LSP service, so the marker
 *    lines a cell adds are the servers that route started. Each cell asserts
 *    its row of the state table (PR #4411): the servers started, the verdict
 *    read from what the route shows, and the exact lines it shows. A disabled
 *    primary and a missing one are both unconfirmed, and each line that gives
 *    a reason names which (#4403, the #4322 rule extended to
 *    `lsp.disabledServers`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import { afterAll, describe, expect, it } from "vitest";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import { getLensFlagSpec } from "../../clients/lens-flag-registry.js";
import { getLSPService, resetLSPService } from "../../clients/lsp/index.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";
import { makeSessionStartEvent } from "../support/host-event-factory.js";
import { createPiMock, makeCtx } from "../support/pi-mock.js";
import {
	auditRegistry,
	findEnclosingSymbol,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";
import {
	COLUMN_FILE_COUNT,
	COLUMNS,
	COLUMNS_PER_FILE,
	type ColumnId,
	NO_VERDICT_SURFACE,
	NOT_APPLICABLE,
	PREFIX,
	ROUTES,
	type RouteId,
	type ToolLike,
	columnsOfFile,
	makeFixture,
	navigationEnvelope,
	navigationVerdict,
	repoRoot,
} from "../support/diagnostics-route-matrix-kit.js";
import { useConfigPath } from "../support/global-config.js";
const setConfigPath = useConfigPath();

// ── Route derivation ────────────────────────────────────────────────────────

/**
 * The `LSPService` members a route enters the diagnostics pipeline through:
 * each one starts a server or returns diagnostics rows. A case below checks
 * every name is still a method of the service, so a rename cannot leave the
 * scan looking for a name nothing calls.
 */
const DIAGNOSTICS_ENTRY_MEMBERS = [
	"getAllDiagnostics",
	"getAuxiliaryClientsForFile",
	"getClientsForFile",
	"getDiagnostics",
	"getLastKnownDiagnostics",
	"readCachedDiagnosticsForServers",
	"runWorkspaceDiagnostics",
	"touchFile",
] as const;

/**
 * #4403 round 4 (N5): every other public `LSPService` method, by why it is
 * not a diagnostics entry. The scan above reads only the entry members, so a
 * new public method that returns diagnostics would be invisible to it; the
 * pin below reds on any method not placed here or there.
 */
const NAVIGATION =
	"a navigation or edit request: it returns locations, symbols, text or edits, never diagnostics or a verdict";
const SYNC =
	"document sync: it sends text or file events to servers and returns no diagnostics";
const STATUS =
	"a status read: it returns readiness, capability or health facts, never diagnostics rows";
const NON_ENTRY_MEMBERS: Record<string, string> = {
	constructor: "builds the service",
	shutdown: "stops every server",
	restartPrimaryClientsUnder:
		"stops the primary servers under a root after a dependency install; the next touch spawns fresh ones, and it returns a count, never diagnostics",
	checkDestroyed: STATUS,
	getOpenDocumentPaths: STATUS,
	getTrackedContent: STATUS,
	getClientForFile:
		"returns one primary client; a diagnostics read on it is a member access the scan reads as its own site",
	getWarmClientForFile:
		"returns an already-running client without starting one; a diagnostics read on it is its own site",
	hasServerPublishedForFileRoot: STATUS,
	observeLateAuxiliaryAnswer:
		"records how late an auxiliary answered; it returns nothing",
	notifyExternalFileChange: SYNC,
	notifyOutOfBandFileChanges: SYNC,
	announceCreatedFiles: SYNC,
	resyncGitChangedFiles: SYNC,
	resyncHeldPrimaries: SYNC,
	sweepDocumentDrift: SYNC,
	_driftTrackedCountForTests: STATUS,
	openFile: SYNC,
	updateFile: SYNC,
	getDiagnosticsHealth:
		"returns the health record a diagnostics read left, not rows; the routes that read it are pinned by the matrix",
	definition: NAVIGATION,
	typeDefinition: NAVIGATION,
	declaration: NAVIGATION,
	references: NAVIGATION,
	hover: NAVIGATION,
	signatureHelp: NAVIGATION,
	documentSymbol: NAVIGATION,
	workspaceSymbol: NAVIGATION,
	getAdvertisedCommands: STATUS,
	executeCommand: NAVIGATION,
	executeReadOnlyCommandOnLiveClient: NAVIGATION,
	getOperationSupport: STATUS,
	getCapabilitySnapshots: STATUS,
	getWorkspaceDiagnosticsSupport: STATUS,
	codeAction: NAVIGATION,
	rename: NAVIGATION,
	renameFile: NAVIGATION,
	implementation: NAVIGATION,
	prepareCallHierarchy: NAVIGATION,
	incomingCalls: NAVIGATION,
	outgoingCalls: NAVIGATION,
	ensureWarmForSweep:
		"warms the server a `runWorkspaceDiagnostics` group gates on; only that entry member calls it",
	supportsLSP: STATUS,
	describeTouchCandidates: STATUS,
	hasWarmLSP: STATUS,
	hasLSP: STATUS,
	isSpawnInFlight: STATUS,
	// #4532: a read-only accessor the bash `tool_result` install look asks for
	// the live primary client roots. It reads no diagnostics and spawns nothing,
	// so it is not a diagnostics entry; the routes that emit rows are the
	// matrix's subject.
	livePrimaryClientRoots: STATUS,
	getStatus: STATUS,
	getBrokenStatus: STATUS,
	getAliveClientCount: STATUS,
	getAliveServerIds: STATUS,
};

/**
 * The public methods of `LSPService`, read from its class body with comments
 * and strings blanked: a one-tab-indented method head or function-valued
 * field that is not `private` or `protected` (neither word can be the name
 * the head pattern captures). Round 5 (V4): `public m()`, `async *m()`,
 * `m = async () => …` and `m = (x) => …` are methods the pin must see. The
 * napi TypeScript grammar is no help here: it fails on this file's
 * `import("…")` types and folds later members into error nodes.
 */
function lspServicePublicMethods(): string[] {
	const source = stripSource(
		fs.readFileSync(path.join(repoRoot, "clients", "lsp", "index.ts"), "utf8"),
	);
	const start = source.search(/^export class LSPService\b/m);
	const end = source.indexOf("\n}", start);
	const head =
		/^\t(?:public\s+)?(?:static\s+)?(?:readonly\s+)?(?:async\s+)?(?:\*\s*)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:[<(]|=\s*(?:async\s+)?(?:[<(]|function\b|[A-Za-z_$][\w$]*\s*=>))/gm;
	return [
		...new Set(
			[...source.slice(start, end).matchAll(head)].map(
				(match) => match[1] as string,
			),
		),
	].sort();
}

type SiteEntry = { routes: readonly RouteId[] } | { exempt: string };

/**
 * `getLSPService()` hands out a proxy that binds each service method by name
 * (`bindGroup` in clients/lsp/capabilities.ts). The names in its lists are
 * not reads: every caller goes through the facade with a member expression,
 * and each of those is a site the scan reads.
 */
const CAPABILITY_FACADE_BINDING =
	"the capability facade binds the method by name; each call through the facade is a member access the scan reads as its own site";

const LSP_DIAGNOSTICS_TOOL_ROUTES: readonly RouteId[] = [
	"lsp_diagnostics file",
	"lsp_diagnostics batch",
	"lsp_diagnostics directory",
	"lsp_diagnostics primary-only",
	"MCP pilens_diagnostics",
];

/**
 * Every derived site: the matrix routes that reach it, or why none does. The
 * key is `<file>#<enclosing declaration>:<member>` plus the site's
 * `clientScope` and `diagnostics` options as written.
 */
const SITE_REGISTRY: Record<string, SiteEntry> = {
	"clients/actionable-warnings.ts#buildActionableWarningsReport:getLastKnownDiagnostics":
		{
			exempt:
				"the in-band read of a file the turn already primed: it starts no server and returns the store an earlier touch filled; pinned by tests/tools/lsp-diagnostics-opengrep-disabled-4323.test.ts 'does not start Opengrep for a cold file read after a primed one'",
		},
	"clients/actionable-warnings.ts#enrichFileFromLsp:getDiagnostics": {
		routes: ["turn-end actionable warnings"],
	},
	"clients/dispatch/integration.ts#computeCascadeForFile:getAllDiagnostics": {
		exempt:
			"the cascade's snapshot of running clients' rows for import neighbours of a written file; it starts no server",
	},
	// #4485: the silent-push wait's read of what the touched client published
	// for the neighbour after the touch.
	"clients/dispatch/integration.ts#computeCascadeForFile:getDiagnostics": {
		exempt:
			"an LSPClient's own per-file read on the client the cascade just touched (spawned.client), not the service: it starts nothing",
	},
	'clients/dispatch/integration.ts#computeCascadeForFile:touchFile{clientScope: "primary", diagnostics: "document"}':
		{
			exempt:
				"a cascade neighbour's primary-only re-check: its scope cannot select an auxiliary",
		},
	'clients/dispatch/integration.ts#computeCascadeForFile:touchFile{clientScope: "primary", diagnostics: "none"}':
		{
			exempt:
				"a cascade neighbour's primary-only sync with no diagnostics: no auxiliary, no verdict",
		},
	'clients/dispatch/runners/lsp.ts#lspRunner:touchFile{clientScope: auxiliaryServerIds.length > 0 ? "with-auxiliary" : "primary", diagnostics: "document"}':
		{ routes: ["write-time dispatch"] },
	'clients/lsp/capabilities.ts#adaptLspService:"touchFile"': {
		exempt: CAPABILITY_FACADE_BINDING,
	},
	'clients/lsp/capabilities.ts#adaptLspService:"getAllDiagnostics"': {
		exempt: CAPABILITY_FACADE_BINDING,
	},
	'clients/lsp/capabilities.ts#adaptLspService:"getDiagnostics"': {
		exempt: CAPABILITY_FACADE_BINDING,
	},
	'clients/lsp/capabilities.ts#adaptLspService:"getLastKnownDiagnostics"': {
		exempt: CAPABILITY_FACADE_BINDING,
	},
	'clients/lsp/capabilities.ts#adaptLspService:"readCachedDiagnosticsForServers"':
		{
			exempt: CAPABILITY_FACADE_BINDING,
		},
	'clients/lsp/capabilities.ts#adaptLspService:"runWorkspaceDiagnostics"': {
		exempt: CAPABILITY_FACADE_BINDING,
	},
	// #4485: the expiry read of an outstanding touch's own client, held by a
	// WeakRef, so a dead client is never revived.
	"clients/lsp/cascade-tier.ts#readTouchedClient:getAllDiagnostics": {
		exempt:
			"an LSPClient's own getAllDiagnostics on the client the touch was sent to, read through a WeakRef at expiry: it starts nothing",
	},
	"clients/lsp/cascade-tier.ts#reconcileOutstandingCascadeTouches:getAllDiagnostics":
		{
			exempt:
				"an LSPClient's own getAllDiagnostics on a warm client (spawned.client), not the service: it starts nothing",
		},
	'clients/mcp/analyze.ts#warmLspForFile:touchFile{clientScope: "primary", diagnostics: "document"}':
		{
			exempt:
				"pilens_analyze's primary-only warm-up; its result is discarded and the dispatch runner (the write-time route's site) gives the verdict",
		},
	'clients/persistent-reverify.ts#runPersistentReverify:touchFile{clientScope: "primary", diagnostics: "document"}':
		{
			exempt:
				"the turn-end re-check of persistent warnings is primary-only: its scope cannot select an auxiliary",
		},
	"clients/pipeline.ts#resyncLspFile:getAuxiliaryClientsForFile": {
		routes: ["write-time dispatch"],
	},
	'clients/pipeline.ts#resyncLspFile:touchFile{clientScope: "primary", diagnostics: "none"}':
		{ routes: ["write-time dispatch"] },
	"clients/runtime-turn.ts#handleTurnEnd:readCachedDiagnosticsForServers": {
		exempt:
			"turn-end late coverage reads cached rows of the server ids the dispatch already named; it starts no server",
	},
	'clients/runtime-session.ts#igniteDominantLanguageWarm:touchFile{clientScope: "primary", diagnostics: "none"}':
		{
			exempt:
				"session_start's primary-only warm-up with no diagnostics: no auxiliary, no verdict",
		},
	'clients/runtime-session.ts#igniteWarmFiles:touchFile{clientScope: "primary", diagnostics: "none"}':
		{
			exempt:
				"session_start's configured warm files, primary-only with no diagnostics: no auxiliary, no verdict",
		},
	'clients/runtime-tool-call.ts#handleToolCallImpl:touchFile{clientScope: "primary", diagnostics: "none"}':
		{
			exempt:
				"the pre-tool warm touch, primary-only with no diagnostics: no auxiliary, no verdict",
		},
	'clients/warm-attach.ts#serveRequest:touchFile{clientScope: "with-auxiliary", diagnostics: "document"}':
		{
			exempt:
				"the warm-attach incumbent serves another process's dispatch runner; with-auxiliary with no auxiliaryServerIds acquires no auxiliary (touchFile reads `auxiliaryServerIds ?? []`)",
		},
	"tools/lens-diagnostics.ts#formatFullMode:runWorkspaceDiagnostics": {
		routes: ["lens_diagnostics mode=full"],
	},
	"tools/lsp-diagnostics.ts#collectDiagnosticsForFile:getDiagnostics": {
		routes: LSP_DIAGNOSTICS_TOOL_ROUTES,
	},
	'tools/lsp-diagnostics.ts#collectDiagnosticsForFile:touchFile{clientScope: serverScope, diagnostics: "document"}':
		{ routes: LSP_DIAGNOSTICS_TOOL_ROUTES },
	"tools/lsp-navigation.ts#createLspNavigationTool:getAllDiagnostics": {
		exempt:
			"the path-less workspaceDiagnostics snapshot starts no server and claims no verdict; a switched-off server's rows are pinned out by tests/tools/lsp-diagnostics-opengrep-disabled-4323.test.ts 'leaves a running Opengrep's rows out of the path-less lsp_navigation snapshot'",
	},
	"tools/lsp-navigation.ts#createLspNavigationTool:getDiagnostics": {
		routes: ["lsp_navigation workspaceDiagnostics"],
	},
	'tools/lsp-navigation.ts#openFileBestEffort:touchFile{clientScope: waitForDiagnostics ? "all" : "primary", diagnostics: waitForDiagnostics ? "document" : "none"}':
		{ routes: ["lsp_navigation workspaceDiagnostics"] },
};

interface SourceFile {
	rel: string;
	source: string;
}

/** The production trees a route can live in; the service itself is excluded. */
function productionSources(): SourceFile[] {
	const files = [
		...["clients", "tools", "mcp"].flatMap((dir) =>
			listSourceFiles(path.join(repoRoot, dir)),
		),
		path.join(repoRoot, "index.ts"),
	];
	return files
		.map((file) => ({
			rel: relativePosix(repoRoot, file),
			source: fs.readFileSync(file, "utf8"),
		}))
		.filter((file) => file.rel !== "clients/lsp/index.ts");
}

/** `clientScope` and `diagnostics` as written in a call's last object argument. */
function selectorSuffix(call: SgNode | undefined): string {
	const options = call
		?.field("arguments")
		?.namedChildren()
		.filter((arg) => arg.kind() === "object")
		.at(-1);
	if (!options) return "";
	const parts: string[] = [];
	for (const pair of options.namedChildren()) {
		if (pair.kind() !== "pair") continue;
		const key = pair.field("key")?.text();
		if (key !== "clientScope" && key !== "diagnostics") continue;
		parts.push(`${key}: ${pair.field("value")?.text().replace(/\s+/g, " ")}`);
	}
	return parts.length > 0 ? `{${parts.sort().join(", ")}}` : "";
}

/**
 * Node kinds whose member-named leaf DEFINES a member (an interface's method
 * or property, a class's or object's method), never a read of the service's.
 * Only kinds production uses: any other, such as an object literal key, reds
 * as unclassified until it is exempted.
 */
const DEFINITION_PARENTS = new Set([
	"method_signature",
	"method_definition",
	"property_signature",
]);

/**
 * Every access to a diagnostics entry member in `files`, failing closed.
 *
 * A leaf whose text is exactly a member name is one of:
 *  - a site: a member expression (`svc.touchFile(...)`, `svc?.getDiagnostics`,
 *    `const run = svc.runWorkspaceDiagnostics`), a destructured name, renamed
 *    (`{ touchFile: t } = svc`, also in a parameter) or not, or a literal
 *    subscript (`svc["touchFile"]`);
 *  - ignored: a definition (see {@link DEFINITION_PARENTS}), a class's own
 *    `this.<name>` (its own method; the service's file is excluded), a string
 *    in a type (`Pick<S, "touchFile">`), or a local alias of a site in the same
 *    declaration (`run(...)` after `const run = svc.run...`);
 *  - unclassified: anything else, such as `Reflect.get(svc, "touchFile")`, a
 *    name kept in a variable for a computed key, or a string list. It is
 *    recorded as `<file>#<declaration>:"<member>"`, so it reds until it is
 *    exempted with a reason (#4403 F3).
 *
 * Parsed from the AST, so a comment, or a string that is not exactly a
 * member name, is never an access. Out of reach: a name built at run time
 * (`"touch" + "File"`) and a new caller of an existing route's helper; the
 * matrix drives the helpers, not their callers.
 */
function deriveSites(
	files: readonly SourceFile[],
): Array<{ key: string; detail: string }> {
	const members = new Set<string>(DIAGNOSTICS_ENTRY_MEMBERS);
	const sites: Array<{ key: string; detail: string }> = [];
	for (const file of files) {
		if (!DIAGNOSTICS_ENTRY_MEMBERS.some((name) => file.source.includes(name)))
			continue;
		const lines = file.source.split("\n");
		const ownerOf = (node: SgNode) =>
			findEnclosingSymbol(lines, node.range().start.line) ?? "(top level)";
		const record = (node: SgNode, member: string, suffix = "") => {
			sites.push({
				key: `${file.rel}#${ownerOf(node)}:${member}${suffix}`,
				detail: `${file.rel}:${node.range().start.line + 1}`,
			});
		};
		const unclassified = (node: SgNode, member: string) =>
			record(node, `"${member}"`);
		// `<declaration>:<name>` for each local bound to a site's member.
		const aliases = new Set<string>();
		const leaves: SgNode[] = [];
		const collect = (node: SgNode): void => {
			const children = node.children();
			if (children.length === 0) {
				if (members.has(node.text())) leaves.push(node);
				return;
			}
			if (node.kind() === "variable_declarator") {
				const name = node.field("name");
				const value = node.field("value");
				if (
					name?.kind() === "identifier" &&
					value?.kind() === "member_expression" &&
					value.field("object")?.kind() !== "this" &&
					value.field("property")?.text() === name.text()
				)
					aliases.add(`${ownerOf(node)}:${name.text()}`);
			}
			if (node.kind() === "shorthand_property_identifier_pattern")
				aliases.add(`${ownerOf(node)}:${node.text()}`);
			for (const child of children) collect(child);
		};
		collect(parse(Lang.TypeScript, file.source).root());
		for (const leaf of leaves) {
			const member = leaf.text();
			const parent = leaf.parent();
			const parentKind = String(parent?.kind() ?? "");
			switch (leaf.kind()) {
				case "property_identifier": {
					if (parentKind === "member_expression") {
						if (parent?.field("object")?.kind() === "this") break;
						const call = parent?.parent();
						const isCallee =
							call?.kind() === "call_expression" &&
							call.field("function")?.range().start.index ===
								parent?.range().start.index;
						record(leaf, member, isCallee ? selectorSuffix(call) : "");
					} else if (
						parentKind === "pair_pattern" &&
						parent?.field("key")?.range().start.index ===
							leaf.range().start.index
					) {
						record(leaf, member);
					} else if (!DEFINITION_PARENTS.has(parentKind)) {
						unclassified(leaf, member);
					}
					break;
				}
				case "shorthand_property_identifier_pattern":
					record(leaf, member);
					break;
				case "identifier":
				case "shorthand_property_identifier":
					if (!aliases.has(`${ownerOf(leaf)}:${member}`))
						unclassified(leaf, member);
					break;
				case "string_fragment": {
					const literal = parent;
					const holder = literal?.parent();
					if (literal?.kind() === "string" && holder?.kind() === "literal_type")
						break;
					if (
						literal?.kind() === "string" &&
						holder?.kind() === "subscript_expression" &&
						holder.field("index")?.range().start.index ===
							literal.range().start.index &&
						holder.field("object")?.kind() !== "this"
					) {
						record(leaf, member);
						break;
					}
					unclassified(leaf, member);
					break;
				}
				default:
					unclassified(leaf, member);
			}
		}
	}
	return sites;
}

/** Every problem with the derived sites against the registry and the matrix. */
function auditRoutes(
	scannedCount: number,
	sites: ReadonlyArray<{ key: string; detail: string }>,
	registry: Record<string, SiteEntry>,
	routes: readonly string[],
): string[] {
	const registered: string[] = [];
	const exemptions: Record<string, string> = {};
	for (const [key, entry] of Object.entries(registry)) {
		if ("routes" in entry) registered.push(key);
		else exemptions[key] = entry.exempt;
	}
	const problems = [
		...auditRegistry({
			sweepName: "diagnostics route derivation (#4403)",
			flagged: sites,
			registered,
			exemptions,
			minFlagged: 10,
			// 518 production files on 2026-10-14; a walk under half is blind.
			scannedCount,
			minScanned: 250,
			remediation:
				"A new read of an LSPService diagnostics member is a diagnostics route. Add it to ROUTES and drive it through the matrix, or exempt its key with the reason it cannot start a switched-off server or give a verdict.",
		}).problems,
	];
	// auditRegistry tolerates a registered key the scan no longer finds; a
	// route mapping is a claim about a live site, so a gone site is stale.
	const flagged = new Set(sites.map((site) => site.key));
	const stale = registered.filter((key) => !flagged.has(key));
	if (stale.length > 0) {
		problems.push(
			`registry routes name a site the scan no longer finds:\n${stale.map((key) => `  ${key}`).join("\n")}`,
		);
	}
	const named = new Set<string>();
	for (const [key, entry] of Object.entries(registry)) {
		if (!("routes" in entry)) continue;
		if (entry.routes.length === 0) problems.push(`${key}: names no route`);
		for (const route of entry.routes) {
			named.add(route);
			if (!routes.includes(route))
				problems.push(
					`${key}: names "${route}", which the matrix does not drive`,
				);
		}
	}
	for (const route of routes) {
		if (!named.has(route))
			problems.push(`matrix route "${route}" has no derived site`);
	}
	return problems;
}

describe("diagnostics routes are derived from code (#4403)", () => {
	it(
		"maps every LSPService diagnostics read to a matrix route or a reasoned exemption",
		() => {
			const sources = productionSources();
			const problems = auditRoutes(
				sources.length,
				deriveSites(sources),
				SITE_REGISTRY,
				ROUTES,
			);

			expect(problems).toEqual([]);
		},
		scaledTestTimeout(60_000),
	);

	it(
		"reds a new route the matrix does not drive, and never reads one from a comment or a string",
		() => {
			// The fixture route: one real read, and two members named only in a
			// comment and a string (#4403: prose must not add or satisfy a site).
			const fixture: SourceFile = {
				rel: "tools/fixture-new-route.ts",
				source: [
					"export async function newRoute(svc: any, file: string) {",
					"\t// svc.touchFile(file, '', {}) is only prose here",
					"\tconst note = 'svc.getAllDiagnostics()';",
					"\treturn [note, await svc.getDiagnostics(file)];",
					"}",
					"",
				].join("\n"),
			};

			const sites = deriveSites([fixture]);
			const sources = productionSources();
			const problems = auditRoutes(
				sources.length,
				[...deriveSites(sources), ...sites],
				SITE_REGISTRY,
				ROUTES,
			);

			expect(sites.map((site) => site.key)).toEqual([
				"tools/fixture-new-route.ts#newRoute:getDiagnostics",
			]);
			expect(problems.join("\n")).toContain(
				"tools/fixture-new-route.ts#newRoute:getDiagnostics (tools/fixture-new-route.ts:4)",
			);
		},
		scaledTestTimeout(60_000),
	);

	it(
		"fails closed on a spelling it cannot read as a site (#4403 F3)",
		() => {
			// The review's five spellings that each derived no site in round 2,
			// and a local of the same name that is not bound to a member access. A
			// renamed destructure and a literal subscript are sites; a name kept in
			// a variable, passed to Reflect, or bound to something else is
			// unclassified, as is any other node kind that carries the name (an
			// enum member, a type name). Either reds until it is mapped or exempted. A
			// definition and a type-level name do not.
			const spellings: Record<string, string> = {
				renamedDestructure:
					"export function r(svc: any, f: string) {\n\tconst { touchFile: t } = svc;\n\treturn t(f, '', {});\n}\n",
				paramDestructureRenamed:
					"export function r(\n\t{ getDiagnostics: g }: any,\n\tf: string,\n) {\n\treturn g(f);\n}\n",
				bracket:
					"export function r(svc: any, f: string) {\n\treturn svc['touchFile'](f, '', {});\n}\n",
				computedKey:
					"export function r(svc: any, f: string) {\n\tconst M = 'getDiagnostics';\n\treturn svc[M](f);\n}\n",
				reflect:
					"export function r(svc: any, f: string) {\n\treturn Reflect.get(svc, 'getDiagnostics').call(svc, f);\n}\n",
				enumMember: "export enum E {\n\ttouchFile = 1,\n}\n",
				typeNamed: "export type getDiagnostics = (f: string) => void;\n",
				aliasFromCall:
					"export function r(svc: any, f: string) {\n\tconst getDiagnostics = pick(svc);\n\treturn getDiagnostics(f);\n}\n",
				definitionsOnly:
					"interface S { touchFile(f: string): void }\nexport function r(): Pick<S, 'touchFile'> {\n\treturn { touchFile() {} };\n}\n",
			};
			const derived = Object.fromEntries(
				Object.entries(spellings).map(([name, source]) => [
					name,
					deriveSites([{ rel: `tools/${name}.ts`, source }]).map(
						(site) => site.key,
					),
				]),
			);

			expect(derived).toEqual({
				renamedDestructure: ["tools/renamedDestructure.ts#r:touchFile"],
				paramDestructureRenamed: [
					"tools/paramDestructureRenamed.ts#r:getDiagnostics",
				],
				bracket: ["tools/bracket.ts#r:touchFile"],
				computedKey: ['tools/computedKey.ts#r:"getDiagnostics"'],
				reflect: ['tools/reflect.ts#r:"getDiagnostics"'],
				enumMember: ['tools/enumMember.ts#(top level):"touchFile"'],
				typeNamed: ['tools/typeNamed.ts#(top level):"getDiagnostics"'],
				aliasFromCall: [
					'tools/aliasFromCall.ts#r:"getDiagnostics"',
					'tools/aliasFromCall.ts#r:"getDiagnostics"',
				],
				definitionsOnly: [],
			});
		},
		scaledTestTimeout(60_000),
	);

	// Also the rename guard: an entry member that is no longer a method fails
	// the equality, so the scan cannot keep looking for a name nothing calls.
	it(
		"places every public LSPService method as a diagnostics entry or not (#4403 N5)",
		() => {
			expect(lspServicePublicMethods()).toEqual(
				[
					...DIAGNOSTICS_ENTRY_MEMBERS,
					...Object.keys(NON_ENTRY_MEMBERS),
				].sort(),
			);
		},
		scaledTestTimeout(60_000),
	);

	it(
		"keeps the MCP --no-opengrep, --no-ast-grep, --no-typos and --no-zizmor cells inapplicable only while the flags have no environment spelling",
		() => {
			// createMcpHost resolves env, then config; a CLI-only flag cannot reach it.
			expect(getLensFlagSpec("no-opengrep")?.env).toBeUndefined();
			expect(getLensFlagSpec("no-ast-grep")?.env).toBeUndefined();
			expect(getLensFlagSpec("no-typos")?.env).toBeUndefined();
			expect(getLensFlagSpec("no-zizmor")?.env).toBeUndefined();
		},
		scaledTestTimeout(10_000),
	);
});

// #4403: the matrix's disabled and missing columns each have one cause. A file
// whose primaries mix the two must not be told only one of them, and the cause
// comes from the read's own record, never from a second look at config.
describe("the primary-unavailable note's cause (#4403)", () => {
	it(
		"names a disabled primary, an unstarted one, and both when they mix",
		async () => {
			const { describePrimaryUnavailable } =
				await import("../../tools/lsp-diagnostics.js");
			const note = (ids: string[], disabled: string[]) =>
				describePrimaryUnavailable(undefined, {
					unavailablePrimaryServerIds: ids,
					disabledPrimaryServerIds: disabled,
				})?.text ?? "";

			expect(note(["json"], ["json"])).toContain(
				"(it is disabled in config by lsp.disabledServers)",
			);
			expect(note(["yaml"], [])).toContain(
				"(it could not be started, or was still starting)",
			);
			expect(note(["json", "yaml"], ["json"])).toContain(
				"(it could not be started, was still starting, or is disabled in config by lsp.disabledServers)",
			);
		},
		scaledTestTimeout(10_000),
	);

	// #4403 F7: review r1 read the raw `server.root` detectors, found rust
	// rootless outside a crate, and asked that a disabled primary be named only
	// where it would root. The service's own root rule has a marker fallback
	// (#3750), so an enabled rust IS tried for a `.rs` file outside any crate,
	// and named when it does not answer. A disabled one is named exactly there.
	it(
		"names a disabled primary exactly where an enabled one that cannot start is named",
		async () => {
			const trust = await import("../../clients/project-trust.js");
			const config = await import("../../clients/lsp/config.js");
			const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;
			process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
			trust.setProjectTrustState("trusted");
			const unanswered = async (rust: "missing" | "disabled") => {
				const env = setupTestEnvironment(PREFIX);
				const workspace = fs.realpathSync(env.tmpDir);
				fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
				fs.mkdirSync(path.join(workspace, ".pi-lens"));
				fs.writeFileSync(
					path.join(workspace, ".pi-lens", "lsp.json"),
					JSON.stringify(
						rust === "disabled"
							? { disabledServers: ["rust"] }
							: {
									serverOverrides: {
										rust: {
											command: [
												path.join(workspace, "missing", "rust-analyzer"),
											],
										},
									},
								},
					),
				);
				// Outside any crate: no Cargo.toml anywhere above it.
				const loose = path.join(workspace, "loose", "main.rs");
				fs.mkdirSync(path.dirname(loose), { recursive: true });
				fs.writeFileSync(loose, "fn main() {}\n");
				config.resetLSPConfigStateForTests();
				await config.initLSPConfig(workspace);
				resetLSPService();
				const service = getLSPService();
				await service.getDiagnostics(loose);
				const health = service.getDiagnosticsHealth(loose);
				await service.shutdown();
				return {
					named: health?.unavailablePrimaryServerIds ?? [],
					disabled: health?.disabledPrimaryServerIds ?? [],
				};
			};
			try {
				expect(await unanswered("missing")).toEqual({
					named: ["rust"],
					disabled: [],
				});
				expect(await unanswered("disabled")).toEqual({
					named: ["rust"],
					disabled: ["rust"],
				});
			} finally {
				resetLSPService();
				trust.resetProjectTrust();
				config.resetLSPConfigStateForTests();
				if (savedInstall === undefined)
					delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
				else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
			}
		},
		scaledTestTimeout(120_000),
	);
});

// #4403 F5: the reader scored `ok:false, status:no_server` clean, so the
// navigation cell of a primary disabled with no auxiliary read as agreeing.
describe("the navigation reader (#4403)", () => {
	it(
		"never scores an envelope that did not answer as clean",
		() => {
			const noServer = JSON.stringify({
				tool: "lsp_navigation",
				operation: "workspaceDiagnostics",
				ok: false,
				status: "no_server",
				resultCount: 0,
			});

			expect(navigationVerdict(`${noServer}\n\nresult error`)).toBe(
				"unconfirmed",
			);
		},
		scaledTestTimeout(10_000),
	);
});

// #4403 round 4 (N4): hover and documentSymbol gate on `supportsLSP` alone,
// which a disabled primary fails, so they told the reader to install a server
// the operator had turned off. They now give the cause the workspaceDiagnostics
// gate gives.
// Round 5 (V5): where `supportsLSP` holds but no client answers (a missing
// binary, an auxiliary serving the file, a disabled owner whose fallback is
// missing), they answered "No results", ok, as if the file had been read.
describe("navigation operations on a file no primary answers for (#4403 N4, V5)", () => {
	const NAV_DISABLED =
		"No LSP server available for a.json: Primary LSP (json) did not answer (it is disabled in config by lsp.disabledServers).";
	const NAV_UNSTARTED =
		"No LSP server available for a.json: no language server answered (it could not be started, or was still starting).";
	const NAV_FALLBACK =
		"No LSP server available for a.ts: Primary LSP (typescript) did not answer (it is disabled in config by lsp.disabledServers, and its fallback could not be started, or was still starting).";
	const noServer = (text: string): string[] =>
		["hover", "documentSymbol"].map(
			(operation) => `${operation} ok=false status=no_server: ${text}`,
		);

	const navOps = async (
		columnId: ColumnId,
		extra: "unserved" | "findSymbol" | undefined = undefined,
	): Promise<string[]> => {
		const column = COLUMNS.find((entry) => entry.id === columnId);
		if (!column) throw new Error(`no ${columnId} column`);
		const fx = makeFixture(column);
		const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;
		setConfigPath(fx.configPath);
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		const config = await import("../../clients/lsp/config.js");
		const { default: extension } = await import("../../index.js");
		const pi = createPiMock({});
		const ctx = makeCtx({
			cwd: fx.workspace,
			sessionId: `matrix-4403-nav-ops-${columnId}`,
			isProjectTrusted: true,
		});
		let started = false;
		try {
			await config.initLSPConfig(fx.workspace);
			extension(pi.asExtensionAPI());
			resetLSPService();
			getLSPService();
			await pi.emit("session_start", makeSessionStartEvent(), ctx);
			started = true;
			const nav = pi.tools.get("lsp_navigation") as ToolLike;
			const targets: Array<[string, string, Record<string, string>?]> = [
				["hover", fx.file("a")],
				["documentSymbol", fx.file("a")],
			];
			if (extra === "unserved") {
				const unserved = path.join(fx.workspace, "notes.unserved");
				fs.writeFileSync(unserved, "plain text\n");
				targets.push(["hover", unserved]);
			}
			// The fake answers every request it advertises; a name it has no
			// symbol for is an empty answer from a running server.
			if (extra === "findSymbol")
				targets.push(["findSymbol", fx.file("a"), { query: "noSuchName" }]);
			const lines: string[] = [];
			for (const [operation, target, params] of targets) {
				const result = await nav.execute(
					"matrix-4403-nav-op",
					{ operation, path: target, line: 1, character: 2, ...params },
					new AbortController().signal,
					null,
					ctx,
				);
				const envelope = navigationEnvelope(String(result.content[0]?.text));
				lines.push(
					`${operation} ok=${envelope.ok} status=${envelope.status}: ${envelope.notes?.join(" | ")}`,
				);
			}
			return lines;
		} finally {
			if (started) await pi.emit("session_shutdown", { reason: "quit" }, ctx);
			await getLSPService().shutdown();
			resetLSPService();
			if (savedInstall === undefined)
				delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
			else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
		}
	};

	it(
		"names a disabled primary, and keeps the install hint for a file no server serves",
		async () => {
			expect(await navOps("disabled, no aux", "unserved")).toEqual([
				...noServer(NAV_DISABLED),
				"hover ok=false status=no_server: No LSP server available for notes.unserved. Check that the language server is installed.",
			]);
		},
		scaledTestTimeout(120_000),
	);

	const CASES: ReadonlyArray<[ColumnId, string[]]> = [
		["disabled", noServer(NAV_DISABLED)],
		["disabled, fallback", noServer(NAV_FALLBACK)],
		["missing", noServer(NAV_UNSTARTED)],
		["missing, no aux", noServer(NAV_UNSTARTED)],
	];
	for (const [columnId, expected] of CASES) {
		it(
			`answers no_server with the cause, not "No results": ${columnId}`,
			async () => {
				expect(await navOps(columnId)).toEqual(expected);
			},
			scaledTestTimeout(120_000),
		);
	}

	// A running primary's answer, empty or not, is an answer.
	it(
		"keeps a running primary's answers, and its empty answer as No results",
		async () => {
			expect(await navOps("present", "findSymbol")).toEqual([
				"hover ok=true status=success: undefined",
				"documentSymbol ok=true status=success: undefined",
				"findSymbol ok=true status=empty: No results for findSymbol at a.json:1:2",
			]);
		},
		scaledTestTimeout(120_000),
	);
});

describe("every diagnostics route under every server-selecting switch (#4403)", () => {
	afterAll(async () => {
		await cleanupTestEnvironmentsDrained(PREFIX, {
			beforeDrain: async () => {
				await getLSPService().shutdown();
			},
		});
	});

	// Recurrence this guards (#3801): the 15 columns were split over five files
	// (`COLUMNS_PER_FILE` each) so the sequencer can balance them. A sixth
	// file's worth of columns, or a file that goes missing, would drop columns
	// silently, because each file only runs its own slice.
	it(
		"runs every column in exactly one columns file",
		() => {
			const dir = path.dirname(fileURLToPath(import.meta.url));
			const files = fs
				.readdirSync(dir)
				.filter((name) =>
					/^diagnostics-route-switch-matrix-cols-\d+\.test\.ts$/.test(name),
				)
				.sort();
			expect(files).toEqual(
				Array.from(
					{ length: COLUMN_FILE_COUNT },
					(_, index) =>
						`diagnostics-route-switch-matrix-cols-${index + 1}.test.ts`,
				),
			);
			expect(COLUMNS.length).toBeLessThanOrEqual(
				COLUMN_FILE_COUNT * COLUMNS_PER_FILE,
			);
			const ran = Array.from({ length: COLUMN_FILE_COUNT }, (_, index) =>
				columnsOfFile(index + 1),
			).flat();
			expect(ran.map((column) => column.id)).toEqual(
				COLUMNS.map((column) => column.id),
			);
		},
		scaledTestTimeout(10_000),
	);

	it(
		"declares inapplicable cells only for a real route and column",
		() => {
			const columns = new Set<string>(COLUMNS.map((column) => column.id));
			for (const row of NOT_APPLICABLE) {
				expect(ROUTES).toContain(row.route);
				expect(columns.has(row.column)).toBe(true);
			}
			for (const route of Object.keys(NO_VERDICT_SURFACE))
				expect(ROUTES).toContain(route);
		},
		scaledTestTimeout(10_000),
	);
});
