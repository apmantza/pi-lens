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
const FINITE_REASONS: Readonly<Record<string, string>> = {
	"clients/language-registry.ts#BY_EXTENSION":
		"keyed by the finite supported language extension table",
	"clients/language-registry.ts#BY_FILENAME":
		"keyed by the finite supported language filename table",
	"clients/language-registry.ts#BY_ID":
		"keyed by the finite supported language id table",
	"clients/language-registry.ts#BY_KIND":
		"keyed by the finite supported file-kind table",
	"clients/lens-flag-registry.ts#byName":
		"keyed by the finite built-in lens flag catalog",
	"clients/tool-policy.ts#FORMATTER_POLICY_BY_EXTENSION":
		"keyed by the finite formatter extension policy table",
	"clients/tool-policy.ts#FORMATTER_POLICY_BY_FILENAME":
		"keyed by the finite formatter filename policy table",
};

type Verdict = 1 | 2 | 3 | 5;
type Site = { key: string; detail: string; name: string; verdict: Verdict };

function walk(node: any, visit: (node: any) => void): void {
	visit(node);
	for (const child of node.children()) walk(child, visit);
}

function identifier(node: any): string | undefined {
	return node?.kind() === "identifier" ? node.text() : undefined;
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
		if (
			!key ||
			!["identifier", "member_expression", "subscript_expression"].includes(
				key.kind(),
			)
		)
			return;
		if (!/file|path|cwd|session|pid|project|root|id/i.test(key.text())) return;
		let parent = node.parent();
		while (parent) {
			if (
				[
					"function",
					"function_declaration",
					"function_expression",
					"arrow_function",
					"method_definition",
				].includes(parent.kind())
			) {
				written = true;
				break;
			}
			parent = parent.parent();
		}
	});
	return declared && (!builtin || written);
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
		if (![">", ">="].includes(node.field("operator")?.text() ?? "")) return;
		if (
			identifier(left?.field("object")) === name &&
			left?.field("property")?.text() === "size" &&
			node.field("right")?.kind() === "identifier"
		)
			result = true;
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

export function scan(): { sites: Site[]; scanned: number } {
	const sites: Site[] = [];
	let scanned = 0;
	for (const root of shippedContainerSourceRoots()) {
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
			const key = relative.startsWith("clients/")
				? relative.slice("clients/".length)
				: path.basename(relative);
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
				});
			}
		}
	}
	return { sites, scanned };
}

function finiteReason(site: Site): string | undefined {
	const prefix = site.detail.slice(0, site.detail.lastIndexOf(":"));
	return FINITE_REASONS[`${prefix}#${site.name}`];
}

function admissionReason(site: Site): string {
	const axis = /file|path|graph|snapshot|artifact|touch/i.test(site.name)
		? "file path"
		: /cwd|root|project|workspace|dir/i.test(site.name)
			? "cwd"
			: /pid|process/i.test(site.name)
				? "pid"
				: "session id";
	return `unbounded growth admitted as shrink-only debt; key axis is ${axis} (${site.name})`;
}

describe("#2981 long-lived containers are bounded or admitted", () => {
	const result = scan();
	const finite = Object.fromEntries(
		result.sites.flatMap((site) => {
			const reason = finiteReason(site);
			return reason ? [[site.key, reason]] : [];
		}),
	);
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
		"clients/tool-policy.ts#KOTLIN_GRADLE_FILES:2ff14979",
		"clients/tree-sitter-client.ts#TYPESCRIPT_SQL_KNOWN_PACKAGES:95dcb590",
		"clients/widget-state.ts#setRenderCallback:d8f1770a",
	];
	const admissionReasons = Object.fromEntries(
		admissions.map((site) => [site.key, admissionReason(site)]),
	);
	const audit = auditRegistry({
		sweepName: "bounded container guard",
		flagged: result.sites.filter((site) => site.verdict === 5),
		registered,
		exemptions: finite,
		scannedCount: result.scanned,
		minScanned: 100,
		minFlagged: 1,
		remediation:
			"Use a bounded helper, add a same-file named cap, delete from a timer, or add one content-keyed exemption with a concrete finite-key reason.",
	});

	it("scans a live population and accounts for every unbounded occurrence", () => {
		expect(audit.problems, audit.problems.join("\n\n")).toEqual([]);
		expect(
			Object.values(admissionReasons).every((reason) =>
				reason.includes("key axis is"),
			),
		).toBe(true);
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
});
