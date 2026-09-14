/** Registered-or-fail guard for long-lived container growth (#2981). */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import {
	auditRegistry,
	listSourceFiles,
	stableOccurrenceKey,
} from "../support/sweep-kit.js";
import {
	scanSessionStateCandidates,
	shippedContainerSourceRoots,
} from "../support/session-state-scan.js";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const BUILTINS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
const BOUNDED_HELPERS = new Set([
	"BoundedFifoMap",
	"BoundedLruCache",
	"BoundedSet",
	"PathKeyedMap",
]);
// No currently flagged occurrence is a finite vocabulary. Keep the channel
// content-keyed so a future exemption must be re-confirmed after an edit.
const FINITE_REASONS: Readonly<Record<string, string>> = {};

type Verdict = 1 | 2 | 3 | 5;
type KeyAxis =
	| "file path"
	| "cwd"
	| "pid"
	| "session id"
	| "language id"
	| "tool id"
	| "undetermined";
type Site = {
	key: string;
	detail: string;
	name: string;
	verdict: Verdict;
	keyExpression: string | undefined;
	keyAxis: KeyAxis;
};

function walk(node: any, visit: (node: any) => void): void {
	visit(node);
	for (const child of node.children()) walk(child, visit);
}

function identifier(node: any): string | undefined {
	return node?.kind() === "identifier" ? node.text() : undefined;
}

function isLiteralVocabularyValue(node: any): boolean {
	if (
		[
			"string",
			"number",
			"true",
			"false",
			"null",
			"regex",
			"undefined",
		].includes(node.kind())
	)
		return true;
	return (
		node.kind() === "template_string" &&
		!node
			.namedChildren()
			.some((child: any) => child.kind() === "template_substitution")
	);
}

/**
 * AST population rule. A custom class instance is a lifecycle-owned singleton,
 * not a container occurrence. A Map/Set made from a literal and never written
 * again is an import-time vocabulary. Built-in cells with writes, or with a
 * non-literal source, remain in the growth-shaped population.
 */
export function isGrowthShapedContainer(source: string, name: string): boolean {
	const root = parse(Lang.TypeScript, source).root();
	let declared = false;
	let builtin = false;
	let written = false;
	walk(root, (node) => {
		if (
			node.kind() === "variable_declarator" &&
			identifier(node.field("name")) === name
		) {
			const value = node.field("value");
			if (value?.kind() !== "new_expression") return;
			const ctor = identifier(value.field("constructor"));
			if (!BUILTINS.has(ctor ?? "") && !BOUNDED_HELPERS.has(ctor ?? "")) return;
			declared = true;
			builtin = BUILTINS.has(ctor ?? "");
		}
		if (node.kind() !== "call_expression") return;
		const fn = node.field("function");
		if (
			fn?.kind() !== "member_expression" ||
			identifier(fn.field("object")) !== name
		)
			return;
		if (!["set", "add"].includes(fn.field("property")?.text() ?? "")) return;
		const key = node.field("arguments")?.namedChildren()[0];
		// Literal keys/entries can be vocabulary initialization. Every other
		// expression is dynamic, including an opaque identifier such as `key`;
		// do not turn the AST population into a path-name heuristic (#2981).
		if (!key) return;
		if (isLiteralVocabularyValue(key)) return;
		// A non-literal write is growth-shaped regardless of where the AST puts
		// it. Module-scope writes are unusual, but filtering them by function
		// ancestry loses the same arbitrary-key evidence as filtering by a
		// filename-shaped identifier (#2981 / BCG-1-R1).
		written = true;
	});
	return declared && (!builtin || written);
}

function keyExpressionFor(source: string, name: string): string | undefined {
	const root = parse(Lang.TypeScript, source).root();
	let expression: string | undefined;
	walk(root, (node) => {
		if (expression || node.kind() === "subscript_expression") {
			if (
				node.kind() === "subscript_expression" &&
				identifier(node.field("argument")) === name
			)
				expression = node.field("index")?.text();
			return;
		}
		if (node.kind() !== "call_expression") return;
		const fn = node.field("function");
		if (
			fn?.kind() !== "member_expression" ||
			identifier(fn.field("object")) !== name ||
			!["set", "add", "get", "has", "delete"].includes(
				fn.field("property")?.text() ?? "",
			)
		)
			return;
		expression = node.field("arguments")?.namedChildren()[0]?.text();
	});
	return expression;
}

const KEY_AXIS_NAMES: Readonly<
	Record<Exclude<KeyAxis, "undetermined">, ReadonlySet<string>>
> = {
	"file path": new Set([
		"file",
		"filename",
		"filepath",
		"path",
		"artifact",
		"snapshot",
		"touch",
	]),
	cwd: new Set(["cwd", "dir", "directory", "project", "root", "workspace"]),
	pid: new Set(["pid", "process"]),
	"session id": new Set(["session", "sessionid", "turn"]),
	"language id": new Set(["language", "languageid", "lang"]),
	"tool id": new Set(["package", "runner", "tool", "toolid"]),
};

function axisName(node: any): KeyAxis {
	const text = node.text().toLowerCase();
	for (const [axis, names] of Object.entries(KEY_AXIS_NAMES) as Array<
		[Exclude<KeyAxis, "undetermined">, ReadonlySet<string>]
	>) {
		if (names.has(text)) return axis;
	}
	return "undetermined";
}

export function determineKeyAxis(expression: string | undefined): KeyAxis {
	if (!expression) return "undetermined";
	const root = parse(Lang.TypeScript, expression).root();
	const expressionNode = root.namedChildren()[0]?.namedChildren()[0];
	if (
		!["identifier", "member_expression", "subscript_expression"].includes(
			(expressionNode?.kind() as string | undefined) ?? "",
		)
	)
		return "undetermined";
	let axis: KeyAxis = "undetermined";
	walk(root, (node) => {
		if (
			axis !== "undetermined" ||
			!["identifier", "property_identifier"].includes(node.kind())
		)
			return;
		axis = axisName(node);
	});
	return axis;
}

export function hasBoundedConstructor(source: string, name: string): boolean {
	const root = parse(Lang.TypeScript, source).root();
	let result = false;
	walk(root, (node) => {
		if (
			result ||
			node.kind() !== "variable_declarator" ||
			identifier(node.field("name")) !== name
		)
			return;
		const value = node.field("value");
		if (value?.kind() !== "new_expression") return;
		const ctor = identifier(value.field("constructor"));
		if (
			["BoundedFifoMap", "BoundedLruCache", "BoundedSet"].includes(ctor ?? "")
		)
			result = true;
		if (
			ctor === "PathKeyedMap" &&
			(value.field("arguments")?.namedChildren().length ?? 0) >= 2
		)
			result = true;
	});
	return result;
}

export function hasNamedSizeComparison(source: string, name: string): boolean {
	const root = parse(Lang.TypeScript, source).root();
	let result = false;
	walk(root, (node) => {
		if (result || node.kind() !== "binary_expression") return;
		const left = node.field("left");
		if (![">", ">=", "<", "<="].includes(node.field("operator")?.text() ?? ""))
			return;
		if (
			identifier(left?.field("object")) === name &&
			left?.field("property")?.text() === "size" &&
			node.field("right")?.kind() === "identifier"
		) {
			let parent = node.parent();
			while (parent) {
				if (
					[
						"if_statement",
						"while_statement",
						"for_statement",
						"do_statement",
					].includes(parent.kind())
				) {
					walk(parent, (child) => {
						if (
							child.kind() !== "call_expression" ||
							child.field("function")?.kind() !== "member_expression" ||
							identifier(child.field("function")?.field("object")) !== name ||
							!["delete", "clear"].includes(
								child.field("function")?.field("property")?.text() ?? "",
							)
						)
							return;
						result = true;
					});
					break;
				}
				parent = parent.parent();
			}
		}
	});
	return result;
}

export function hasDeletingTimer(source: string, name: string): boolean {
	const root = parse(Lang.TypeScript, source).root();
	let result = false;
	walk(root, (node) => {
		if (result || node.kind() !== "call_expression") return;
		const fn = node.field("function");
		if (
			fn?.kind() !== "member_expression" ||
			fn.field("property")?.text() !== "delete" ||
			identifier(fn.field("object")) !== name
		)
			return;
		let parent = node.parent();
		while (parent) {
			if (
				parent.kind() === "call_expression" &&
				parent.field("function")?.text() === "setTimeout"
			)
				result = true;
			parent = parent.parent();
		}
	});
	return result;
}

export function scan(
	roots: readonly string[] = shippedContainerSourceRoots(),
): { sites: Site[]; scanned: number } {
	const sites: Site[] = [];
	let scanned = 0;
	for (const root of roots) {
		const files = fs.statSync(root).isDirectory()
			? listSourceFiles(root, { extensions: [".ts"], skipTests: true })
			: [root];
		const scanRoot = root.endsWith("index.ts") ? path.dirname(root) : root;
		const candidates = new Map(
			scanSessionStateCandidates(scanRoot, {
				includeUnresetContainers: true,
			}).map((item) => [item.file, item]),
		);
		for (const absolute of files) {
			const relative = path.relative(ROOT, absolute).split(path.sep).join("/");
			const source = fs.readFileSync(absolute, "utf8");
			const key = path.relative(scanRoot, absolute).split(path.sep).join("/");
			const candidate = candidates.get(key);
			for (const container of candidate?.containerDetails ?? []) {
				scanned++;
				if (!isGrowthShapedContainer(source, container.name)) continue;
				const verdict: Verdict = hasBoundedConstructor(source, container.name)
					? 1
					: hasNamedSizeComparison(source, container.name)
						? 2
						: hasDeletingTimer(source, container.name)
							? 3
							: 5;
				sites.push({
					key: stableOccurrenceKey(
						relative,
						source.split("\n"),
						container.line - 1,
					),
					detail: `${relative}:${container.line}`,
					name: container.name,
					verdict,
					keyExpression: keyExpressionFor(source, container.name),
					keyAxis: determineKeyAxis(keyExpressionFor(source, container.name)),
				});
			}
		}
	}
	return { sites, scanned };
}

function exemptionsForAudit(
	_sites: readonly Site[],
	reasons: Readonly<Record<string, string>> = FINITE_REASONS,
): Readonly<Record<string, string>> {
	return reasons;
}

function finiteReason(
	site: Site,
	reasons: Readonly<Record<string, string>> = FINITE_REASONS,
): string | undefined {
	return reasons[site.key];
}

function validateAdmissionRegistry(
	flagged: readonly Site[],
	registered: readonly string[],
): string[] {
	const current = new Set(flagged.map((site) => site.key));
	const stale = registered.filter((key) => !current.has(key));
	return stale.length === 0
		? []
		: [
				`registry contains ${stale.length} stale content identity(ies): ${stale.join(", ")}`,
			];
}

describe("#2981 long-lived containers are bounded or admitted", () => {
	const result = scan();
	const finite = exemptionsForAudit(result.sites);
	const admissions = result.sites.filter(
		(site) => site.verdict === 5 && !finiteReason(site),
	);
	const registered = [
		"clients/blocker-freshness.ts#MAX_DRIFT_CHECK_IMPORTS:39ccfde7",
		"clients/blocker-freshness.ts#getExtractor:0bd69b14",
		"clients/diagnostics-publish.ts#seqCounter:f6f9f5cf",
		"clients/dispatch/dispatcher.ts#coverageNoticeSeen:b0d84a0a",
		"clients/dispatch/integration.ts#FACT_RULE_IDS:8d2583ad",
		"clients/dispatch/integration.ts#cascadeTurnScope:20fbf3b2",
		"clients/dispatch/rule-id-normalize.ts#bundledCodeRabbitRules:8617a0bf",
		"clients/dispatch/runners/helm-lint.ts#helm:c1b621dc",
		"clients/dispatch/runners/helm-render.ts#trivy:c1b621dc",
		"clients/dispatch/runners/tree-sitter.ts#41fffd47",
		"clients/dispatch/runners/utils/runner-helpers.ts#discoverManagedTool:15947de8",
		"clients/dispatch/runners/utils/runner-helpers.ts#installAttemptsByCwd:bbf98ee1",
		"clients/dispatch/runners/utils/runner-helpers.ts#resolveInstallInFlightByCwd:4905867e",
		"clients/dispatch/runners/utils/runner-helpers.ts#correctedAvailabilityByCwd:14cfe5d8",
		"clients/dispatch/runners/utils/runner-helpers.ts#uncorrectedEmissionsByCwd:a46e032f",
		"clients/file-utils.ts#createProjectIgnoreMatcher:32d2341a",
		"clients/file-utils.ts#isRecordableProjectPath:f343d35d",
		"clients/file-kinds.ts#TERRAGRUNT_FILENAMES:1c874cb6",
		"clients/installer/index.ts#INSTALL_LOCK_PATH:297cc14b",
		"clients/installer/index.ts#ensureInFlight:365bfb43",
		"clients/installer/index.ts#getInstallFailureReason:d74e98d9",
		"clients/installer/index.ts#getInstallAttempt:c20998b0",
		"clients/installer/index.ts#_probeCacheChangeGeneration:1040840d",
		"clients/installer/index.ts#_probeCacheChanges:509e90ff",
		"clients/installer/index.ts#extractVersionToken:e8cefebf",
		"clients/installer/index.ts#resolvePlatformPackageBinary:0c6ca0e4",
		"clients/installer/index.ts#lastResolveTransient:9af2cc3b",
		"clients/lsp/config.ts#EMPTY_CONFIG:2b5f72b0",
		"clients/language-registry.ts#grammarExtensionsOf:b846fe4f",
		"clients/language-registry.ts#BY_EXTENSION:57f0562b",
		"clients/language-registry.ts#extensionOf:2d198141",
		"clients/lsp/workspace-diagnostics-cache.ts#MAX_REGISTERED_CWDS:22ef7f62",
		"clients/mcp/analyze.ts#DEFAULT_WORD_INDEX_MAX_WARM_ROOTS:bf4b47c4",
		"clients/mcp/session.ts#pendingTurnEndDeliveries:c1cb62ff",
		"clients/module-report.ts#tsLangForFile:39ccfde7",
		"clients/project-lens-config.ts#EMPTY_PROJECT_CONFIG:a4d79b04",
		"clients/project-snapshot.ts#_queuedSnapshotPersists:635d817c",
		"clients/python-provenance.ts#b39949e4",
		"clients/review-graph/builder.ts#CHANGED_SYMBOLS_PREFIX:860385f2",
		"clients/review-graph/builder.ts#_persistGenerations:fe391d04",
		"clients/review-graph/builder.ts#_lastWorkerFallbackReasonForTests:ae62be11",
		"clients/review-graph/builder.ts#_checkpointGenerations:7a0f0107",
		"clients/review-graph/workspace-modules.ts#getDownstreamModules:49987247",
		"clients/runtime-tool-result.ts#parseDiffRanges:eb9b9896",
		"clients/runtime-tool-result.ts#inFlightPipelines:5e20396b",
		"clients/sgconfig.ts#materializeMergedRuleDir:8f144dfd",
		"clients/tool-policy.ts#GRADLE_BUILD_LOGIC_SCAN_MAX_ENTRIES:2ff14979",
		"clients/diagnostic-dispositions.ts#06a3807d",
		"clients/review-graph/builder.ts#recordPersistFailure:59b74176",
		"clients/tree-sitter-client.ts#TYPESCRIPT_SQL_KNOWN_PACKAGES:95dcb590",
		"clients/widget-state.ts#wireWidgetDispositionSubscriber:d8f1770a",
		"clients/widget-state.ts#isBlocking:a2265554",
		"clients/agent-nudge.ts#MAX_NAMES_SHOWN:9593fa6b",
		"clients/bus-events-logger.ts#writer:f959fedf",
		"clients/config-warn.ts#DEPRECATION_NOUN_BY_CODE:6b858980",
		"clients/degradation-ledger.ts#OVERFLOW_KIND:8cf106dd",
		"clients/degradation-ledger.ts#groups:218d12e1",
		"clients/degradation-ledger.ts#onceKeys:b8a478d9",
		"clients/dispatch/auxiliary-lsp.ts#enabledAuxiliaryLspServerIds:dd3e2650",
		"clients/dispatch/collect-later-tier.ts#COLLECT_LATER_THRESHOLD_MS:6c0d1b78",
		"clients/dispatch/dispatcher.ts#latencyReports:4e5c8069",
		"clients/dispatch/integration.ts#getCascadeSessionStats:0753e302",
		"clients/dispatch/integration.ts#isConfirmedTouch:0876b7da",
		"clients/dispatch/runners/biome-check.ts#parseBiomeJson:753add48",
		"clients/dispatch/runners/eslint.ts#makeEslintProbe:a15d1054",
		"clients/dispatch/runners/psscriptanalyzer.ts#psCmdLatch:d04c7adf",
		"clients/dispatch/runners/psscriptanalyzer.ts#psAnalyzerLatchByCmd:d95a85ac",
		"clients/dispatch/runners/rust-clippy.ts#makeClippyProbe:e3811ba4",
		"clients/dispatch/runners/utils/lazy-installer.ts#LAZY_INSTALL_TIMEOUT_MS:d9d707ca",
		"clients/dispatch/runners/utils/lazy-installer.ts#suppressionFor:d1456960",
		"clients/dispatch/runners/utils/runner-helpers.ts#managedNodeToolCandidates:ee842ef8",
		"clients/dispatch/runners/utils/runner-helpers.ts#managedBinaryVerdicts:85753e76",
		"clients/extension-log.ts#consoleGuardInstalled:388c75ce",
		"clients/extension-log.ts#originalConsoleMethods:a8a25bd1",
		"clients/file-utils.ts#pendingDataDirMigrations:08bb01e0",
		"clients/formatters.ts#WHICH_BUDGET_MS:5a871b6c",
		"clients/formatters.ts#whichLatchByCommand:29c61033",
		"clients/formatters.ts#resetWhichLatches:84280896",
		"clients/generation-guard.ts#d60c9894",
		"clients/git-tracked-ignore.ts#CACHE_TTL_MS:09e66f4f",
		"clients/git-tracked-ignore.ts#fetchTrackedFiles:0fc016d7",
		"clients/git-tracked-ignore.ts#_trackedCache:644b24a0",
		"clients/installer/index.ts#getToolVerificationTimeout:98a16a39",
		"clients/installer/index.ts#_peekEnsureInFlightForTesting:79f5f4d2",
		"clients/latency-logger.ts#_setRecentPhasesForTest:b45c37e8",
		"clients/latency-logger.ts#resetCurrentPhaseForSession:9d04beac",
		"clients/lsp/client.ts#safeSendNotification:63295a96",
		"clients/lsp/server.ts#PROJECT_BOUNDARY_MARKERS:cc0fbaf1",
		"clients/lsp/server.ts#loggedRootCeilingClamps:3e9d9204",
		"clients/lsp/server.ts#DIRECT_LSP_NEGATIVE_TTL_MS:6f24c89e",
		"clients/lsp/server.ts#directLspCommandUnavailableUntil:831316db",
		"clients/opaque-mutation-scan.ts#getOpaqueBaselineStore:feff1538",
		"clients/opaque-mutation-scan.ts#isGitWorktree:97337298",
		"clients/package-manager.ts#PROBE_TIMEOUT_MS:ab1ec294",
		"clients/package-manager.ts#execArgs:b2cb6a98",
		"clients/package-root.ts#1f3e8efd",
		"clients/project-lens-config.ts#configCache:77a8d572",
		"clients/project-report.ts#computeDeadWeight:7e342b62",
		"clients/project-snapshot.ts#cacheParsedSnapshot:6ae8dc6b",
		"clients/project-snapshot.ts#loadProjectSnapshotWithoutWordIndex:6292a06c",
		"clients/project-snapshot.ts#_failedSnapshotPersists:166554d7",
		"clients/project-snapshot.ts#_activeSnapshotPersists:f32b922c",
		"clients/project-snapshot.ts#getSnapshotPersistWorker:4a24edc8",
		"clients/recent-touches.ts#_lastSeenSizeBytes:fabe49c4",
		"clients/review-graph/builder.ts#_resetReviewGraphSourcePathMemoForTests:05f52f06",
		"clients/review-graph/builder.ts#_buildCache:8c87e327",
		"clients/review-graph/builder.ts#_workspaceCacheEpoch:4b381645",
		"clients/review-graph/builder.ts#_lastGraphBuildInfo:18866223",
		"clients/review-graph/builder.ts#setSessionReviewGraphFact:72ed9bac",
		"clients/review-graph/builder.ts#getReviewGraphCacheIdentity:5e8da0ee",
		"clients/review-graph/builder.ts#_resetReviewGraphSizeSkipTtlForTests:1228f83e",
		"clients/review-graph/builder.ts#graphPersistMaxElements:3fa83153",
		"clients/review-graph/builder.ts#_pendingPersist:d3cd46a3",
		"clients/review-graph/builder.ts#_persistTimers:20f4929d",
		"clients/review-graph/builder.ts#ensurePersistExitHook:4266a6c4",
		"clients/review-graph/builder.ts#dedupeResolvedEdges:8f3325e5",
		"clients/sgconfig.ts#parseRuleDocuments:c3278646",
		"clients/smells-rollup.ts#shouldCheckSmellsThisTurn:a818f473",
		"clients/word-index.ts#updateWordIndexDocument:8b5e4c9e",
		"clients/word-index.ts#isCanonicalWordIndexToken:99249de8",
		"clients/word-index.ts#deserializeWordIndex:d6d64306",
		"clients/workspace-topology.ts#PI_LENS_CONFIG_BASENAMES:8403ed7a",
		"clients/workspace-topology.ts#registerWorkspaceTopologyReset:17d6ff8a",
		"mcp/server.ts#DEFAULT_CWD:a08d6c7d",
	];
	const audit = auditRegistry({
		sweepName: "bounded container guard",
		flagged: result.sites.filter((site) => site.verdict === 5),
		registered,
		exemptions: finite,
		scannedCount: result.scanned,
		minScanned: 100,
		minFlagged: 47,
		remediation:
			"Use a bounded helper, add a same-file named cap, delete from a timer, or add one content-keyed exemption with a concrete finite-key reason.",
	});
	const registryDrift = validateAdmissionRegistry(
		result.sites.filter((site) => site.verdict === 5),
		registered,
	);

	it("scans a live population and accounts for every unbounded occurrence", () => {
		expect(
			[...audit.problems, ...registryDrift],
			[...audit.problems, ...registryDrift].join("\n\n"),
		).toEqual([]);
		expect(
			admissions.filter((site) => site.keyAxis === "undetermined").length,
		).toBeGreaterThan(0);
	});
	it("determines axes from key expressions and keeps unknown keys honest", () => {
		expect(determineKeyAxis("filePath")).toBe("file path");
		expect(determineKeyAxis("request.filePath")).toBe("file path");
		expect(determineKeyAxis("languageId")).toBe("language id");
		expect(determineKeyAxis("notFilePath")).toBe("undetermined");
		expect(determineKeyAxis("opaqueKey")).toBe("undetermined");
		expect(determineKeyAxis("`file`")).toBe("undetermined");
	});
	it("reports a stale finite exemption independently of the live site population", () => {
		const staleReasons = {
			"fixture.ts#deleted:ef567890":
				"finite vocabulary removed from the source",
		};
		expect(
			exemptionsForAudit(
				[
					{
						key: "fixture.ts#live:abcd1234",
						detail: "fixture.ts:1",
						name: "cache",
						verdict: 5,
						keyExpression: "filePath",
						keyAxis: "file path",
					},
				],
				staleReasons,
			),
		).toBe(staleReasons);
		const audit = auditRegistry({
			sweepName: "fixture bounded container guard",
			flagged: ["fixture.ts#live:abcd1234"],
			registered: ["fixture.ts#live:abcd1234"],
			exemptions: {
				...staleReasons,
			},
		});
		expect(audit.staleExemptions).toEqual(["fixture.ts#deleted:ef567890"]);
		expect(audit.problems.join("\n")).toContain("no longer flags");
	});
	it("scans and audits a container below a nested tools source root", () => {
		const root = fs.mkdtempSync(
			path.join(process.cwd(), ".probe-bounded-root-"),
		);
		try {
			const toolsRoot = path.join(root, "tools");
			const nested = path.join(toolsRoot, "nested", "cache.ts");
			fs.mkdirSync(path.dirname(nested), { recursive: true });
			fs.writeFileSync(
				nested,
				[
					"const cache = new Map<string, string>();",
					"export function record(filePath: string): void {",
					'\tcache.set(filePath, "seen");',
					"}",
				].join("\n") + "\n",
			);
			const result = scan([toolsRoot]);
			expect(result.scanned).toBe(1);
			expect(result.sites).toHaveLength(1);
			const [site] = result.sites;
			expect(site.detail).toMatch(/tools\/nested\/cache\.ts:1$/);
			const audit = auditRegistry({
				sweepName: "nested tools fixture bounded container guard",
				flagged: result.sites,
				registered: result.sites.map(({ key }) => key),
				scannedCount: result.scanned,
				minScanned: 1,
				minFlagged: 1,
			});
			expect(audit.problems, audit.problems.join("\n\n")).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("retains arbitrary dynamic identifiers in the real AST population", () => {
		const root = fs.mkdtempSync(
			path.join(process.cwd(), ".probe-bounded-dynamic-key-"),
		);
		try {
			const toolsRoot = path.join(root, "tools");
			const fixture = path.join(toolsRoot, "dynamic-key.ts");
			fs.mkdirSync(toolsRoot, { recursive: true });
			fs.writeFileSync(
				fixture,
				[
					"const cache = new Map<string, string>();",
					"export function record(key: string, value: string): void {",
					"\tcache.set(key, value);",
					"}",
				].join("\n") + "\n",
			);
			const result = scan([toolsRoot]);
			const [site] = result.sites;
			expect(result.scanned).toBe(1);
			expect(site?.detail).toMatch(/tools\/dynamic-key\.ts:1$/);
			expect(site?.keyAxis).toBe("undetermined");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("retains a raw module-scope dynamic write and classifies its key as unknown", () => {
		const root = fs.mkdtempSync(
			path.join(process.cwd(), ".probe-bounded-raw-dynamic-key-"),
		);
		try {
			const toolsRoot = path.join(root, "tools");
			const fixture = path.join(toolsRoot, "raw-dynamic-key.ts");
			fs.mkdirSync(toolsRoot, { recursive: true });
			fs.writeFileSync(
				fixture,
				[
					"const cache = new Map<string, string>();",
					"cache.set(key, value);",
				].join("\n") + "\n",
			);
			const result = scan([toolsRoot]);
			const [site] = result.sites;
			expect(result.scanned).toBe(1);
			expect(site?.detail).toMatch(/tools\/raw-dynamic-key\.ts:1$/);
			expect(site?.keyExpression).toBe("key");
			expect(site?.keyAxis).toBe("undetermined");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("requires a content-keyed exemption to survive an unchanged occurrence", () => {
		const key = "fixture.ts#cache:abcd1234";
		const site = {
			key,
			detail: "fixture.ts:1",
			name: "cache",
			verdict: 5 as const,
			keyExpression: "filePath",
			keyAxis: "file path" as const,
		};
		expect(finiteReason(site)).toBeUndefined();
		const reasons = { [key]: "finite fixture key" };
		expect(finiteReason(site, reasons)).toBe("finite fixture key");
		expect(
			finiteReason({ ...site, key: "fixture.ts#cache:changed" }, reasons),
		).toBeUndefined();
	});
	it("keeps the five verdicts visible", () => {
		const counts = new Map<Verdict, number>();
		for (const site of result.sites)
			counts.set(site.verdict, (counts.get(site.verdict) ?? 0) + 1);
		expect(result.scanned).toBeGreaterThanOrEqual(100);
		expect(counts.get(1) ?? 0).toBeGreaterThan(0);
	});
	it("accepts semantic bounds and rejects read-only TTL prose", () => {
		expect(
			hasBoundedConstructor(
				"const cache = new BoundedFifoMap<string, string>(8);",
				"cache",
			),
		).toBe(true);
		expect(
			hasNamedSizeComparison(
				"const cache = new Map<string, string>(); if (cache.size > MAX) log(cache.size);",
				"cache",
			),
		).toBe(false);
		expect(
			hasNamedSizeComparison(
				'const cache = new Map<string, string>(); const MAX = 8; if (cache.size > MAX) cache.delete("x");',
				"cache",
			),
		).toBe(true);
		expect(
			hasDeletingTimer(
				'const cache = new Map<string, string>(); setTimeout(() => cache.delete("x"), TTL);',
				"cache",
			),
		).toBe(true);
		expect(
			hasDeletingTimer(
				'const cache = new Map<string, string>(); const TTL = 8; if (Date.now() > TTL) cache.get("x");',
				"cache",
			),
		).toBe(false);
	});
	it("keeps dynamic keys and values visible as undetermined", () => {
		expect(
			isGrowthShapedContainer(
				"const cache = new Map(); function put(key, value) { cache.set(makeKey(key), makeValue(value)); }",
				"cache",
			),
		).toBe(true);
		expect(determineKeyAxis("makeKey(filePath)")).toBe("undetermined");
	});
	it("excludes lifecycle singletons and never-written literal vocabularies", () => {
		expect(
			isGrowthShapedContainer("const client = new GoClient();", "client"),
		).toBe(false);
		expect(
			isGrowthShapedContainer('const names = new Set(["ts", "js"]);', "names"),
		).toBe(false);
		expect(
			isGrowthShapedContainer(
				'const names = new Set(["ts"]); const add = () => names.add(filePath);',
				"names",
			),
		).toBe(true);
		expect(
			isGrowthShapedContainer(
				'const names = new Set(); const add = () => names.add("ts");',
				"names",
			),
		).toBe(false);
	});
	it("does not let comments or strings manufacture a bound", () => {
		const prose = [
			"const cache = new Map<string, string>();",
			"// cache.size > MAX and setTimeout(() => cache.delete(key))",
			'const note = "cache.size > MAX; cache.delete(key)";',
		].join("\n");
		expect(hasNamedSizeComparison(prose, "cache")).toBe(false);
		expect(hasDeletingTimer(prose, "cache")).toBe(false);
	});
	it("keeps the registry and population floors mutation-sensitive", () => {
		const floor = auditRegistry({
			sweepName: "fixture bounded container guard",
			flagged: [{ key: "fixture#unbounded", detail: "fixture.ts:1" }],
			registered: [],
			scannedCount: 0,
			minScanned: 1,
			minFlagged: 1,
		});
		expect(floor.problems.join("\n")).toContain("below the declared floor");
		expect(floor.problems.join("\n")).toContain(
			"neither registered nor exempted",
		);
	});
	it("rejects admission drift and stale content identities", () => {
		const live = [
			{
				key: "fixture#live",
				detail: "fixture.ts:1",
				name: "cache",
				verdict: 5 as const,
				keyExpression: undefined,
				keyAxis: "undetermined" as const,
			},
		];
		expect(validateAdmissionRegistry(live, ["fixture#live"])).toEqual([]);
		expect(validateAdmissionRegistry(live, ["fixture#old"])).toHaveLength(1);
	});
});
