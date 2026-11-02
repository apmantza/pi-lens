// mutation-lane: exclude
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildCallGraph, saveCallGraph } from "../../clients/call-graph.js";
import {
	grammarBlockReason,
	LANGUAGE_TO_GRAMMAR,
} from "../../clients/grammar-source.js";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import {
	moduleReport,
	projectModuleReport,
	renderCompactModuleReport,
} from "../../clients/module-report.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
	extractSymbolsAndRefsFromGraph,
	getCachedReviewGraph,
	getReviewGraphCacheIdentity,
} from "../../clients/review-graph/builder.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { setupTestEnvironment } from "./test-utils.js";

const FIXTURE_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../fixtures/call-graph",
);

interface FixtureCase {
	language: string;
	directory: string;
	target: string;
	callerFile: string;
	caller: string;
	callee: string;
	callerKind: string;
	calleeKind: string;
	callerLine: number;
	calleeLine: number;
}

// These are committed, multi-file fixtures. The test copies them to an isolated
// project only so the production graph builder can treat them as a workspace.
const CALL_FIXTURES: FixtureCase[] = [
	{
		language: "typescript",
		directory: "typescript",
		target: "callee.ts",
		callerFile: "caller.ts",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 3,
		calleeLine: 1,
	},
	{
		language: "tsx",
		directory: "tsx",
		target: "callee.tsx",
		callerFile: "caller.tsx",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 3,
		calleeLine: 1,
	},
	{
		language: "javascript",
		directory: "javascript",
		target: "callee.js",
		callerFile: "caller.cjs",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 1,
		calleeLine: 1,
	},
	{
		language: "python",
		directory: "python",
		target: "callee.py",
		callerFile: "caller.py",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 1,
		calleeLine: 1,
	},
	{
		language: "go",
		directory: "go",
		target: "callee.go",
		callerFile: "caller.go",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 3,
		calleeLine: 3,
	},
	{
		language: "rust",
		directory: "rust",
		target: "callee.rs",
		callerFile: "caller.rs",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 1,
		calleeLine: 1,
	},
	{
		language: "ruby",
		directory: "ruby",
		target: "callee.rb",
		callerFile: "caller.rb",
		caller: "caller",
		callee: "helper",
		callerKind: "method",
		calleeKind: "method",
		callerLine: 1,
		calleeLine: 1,
	},
	{
		language: "c",
		directory: "c",
		target: "callee.c",
		callerFile: "caller.c",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 1,
		calleeLine: 1,
	},
	{
		language: "cpp",
		directory: "cpp",
		target: "callee.cpp",
		callerFile: "caller.cpp",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 1,
		calleeLine: 1,
	},
	{
		language: "csharp",
		directory: "csharp",
		target: "callee.cs",
		callerFile: "caller.cs",
		caller: "Call",
		callee: "helper",
		callerKind: "method",
		calleeKind: "method",
		callerLine: 2,
		calleeLine: 2,
	},
	{
		language: "php",
		directory: "php",
		target: "callee.php",
		callerFile: "caller.php",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 2,
		calleeLine: 2,
	},
	{
		language: "lua",
		directory: "lua",
		target: "callee.lua",
		callerFile: "caller.lua",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 1,
		calleeLine: 1,
	},
	{
		language: "ocaml",
		directory: "ocaml",
		target: "callee.ml",
		callerFile: "caller.ml",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 1,
		calleeLine: 1,
	},
	{
		language: "zig",
		directory: "zig",
		target: "callee.zig",
		callerFile: "caller.zig",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 1,
		calleeLine: 1,
	},
	{
		language: "bash",
		directory: "bash",
		target: "callee.sh",
		callerFile: "caller.sh",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 1,
		calleeLine: 1,
	},
	{
		language: "elixir",
		directory: "elixir",
		target: "callee.ex",
		callerFile: "caller.ex",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 2,
		calleeLine: 2,
	},
	{
		language: "swift",
		directory: "swift",
		target: "callee.swift",
		callerFile: "caller.swift",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 1,
		calleeLine: 1,
	},
	{
		language: "java",
		directory: "java-call",
		target: "Callee.java",
		callerFile: "Caller.java",
		caller: "caller",
		callee: "helper",
		callerKind: "method",
		calleeKind: "method",
		callerLine: 2,
		calleeLine: 2,
	},
	{
		language: "kotlin",
		directory: "kotlin-call",
		target: "Callee.kt",
		callerFile: "Caller.kt",
		caller: "caller",
		callee: "helper",
		callerKind: "function",
		calleeKind: "function",
		callerLine: 2,
		calleeLine: 2,
	},
];

const TYPE_ONLY_FIXTURES = [
	{ language: "java", directory: "java", target: "Callee.java" },
	{ language: "kotlin", directory: "kotlin", target: "Callee.kt" },
	{ language: "dart", directory: "dart", target: "callee.dart" },
] as const;

const grammarStatus = new Map<
	string,
	{ available: boolean; blockReason?: string }
>();
const testedLanguages = new Set([
	...CALL_FIXTURES.map((fixture) => fixture.language),
	...TYPE_ONLY_FIXTURES.map((fixture) => fixture.language),
]);

beforeAll(async () => {
	const client = getSharedTreeSitterClient();
	if (!client || !(await client.init())) {
		for (const language of testedLanguages)
			grammarStatus.set(language, { available: false });
		return;
	}
	for (const language of testedLanguages) {
		const blockReason = grammarBlockReason(LANGUAGE_TO_GRAMMAR[language]);
		grammarStatus.set(language, {
			available: !blockReason && (await client.isLanguageSupported(language)),
			blockReason: blockReason ?? undefined,
		});
	}
});

function skipUnavailable(
	language: string,
	skip: (note?: string) => never,
): void {
	const status = grammarStatus.get(language);
	if (!status?.available) {
		skip(status?.blockReason ?? `grammar unavailable: ${language}`);
	}
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache();
});

function makeFixtureProject(directory: string) {
	const env = setupTestEnvironment(`pi-lens-module-call-graph-${directory}-`);
	const previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
	const project = path.join(env.tmpDir, "project");
	fs.cpSync(path.join(FIXTURE_ROOT, directory), project, { recursive: true });
	cleanups.push(() => {
		if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = previousDataDir;
		env.cleanup();
	});
	const targetByDirectory: Record<string, string> = {
		typescript: "callee.ts",
		tsx: "callee.tsx",
		javascript: "callee.js",
		python: "callee.py",
		go: "callee.go",
		rust: "callee.rs",
		java: "Callee.java",
		kotlin: "Callee.kt",
		"java-call": "Callee.java",
		"kotlin-call": "Callee.kt",
		swift: "callee.swift",
		dart: "callee.dart",
	};
	return {
		project,
		target: path.join(project, targetByDirectory[directory] ?? "callee.ts"),
	};
}

/** Build the canonical graph, then the production derived projection seam. */
async function warmCallGraph(cwd: string) {
	const reviewGraph = await buildOrUpdateGraph(cwd, [], new FactStore());
	const identity = getReviewGraphCacheIdentity(cwd, reviewGraph);
	expect(identity).toBeDefined();
	const extracted = extractSymbolsAndRefsFromGraph(reviewGraph);
	const callGraph = buildCallGraph(
		extracted.allSymbols,
		extracted.allRefs,
		extracted.coverage,
	);
	saveCallGraph(cwd, callGraph, {
		reviewGraphVersion: identity!.version,
		reviewGraphSignature: identity!.signature,
	});
	return { reviewGraph, callGraph };
}

describe("module_report derived callGraph (#1073)", () => {
	for (const fixture of CALL_FIXTURES) {
		it(`exposes production callers/callees with identity and source locations for ${fixture.language}`, async ({
			skip,
		}) => {
			skipUnavailable(fixture.language, skip);
			const env = makeFixtureProject(fixture.directory);
			const { reviewGraph } = await warmCallGraph(env.project);
			const report = await moduleReport(fixture.target, env.project, {
				callGraph: true,
			});

			expect(report.callGraph).toMatchObject({
				available: true,
				truncated: false,
				coverage: { status: "complete", complete: true },
			});
			const caller =
				report.callGraph!.callers.find(
					(entry) => entry.symbol === fixture.caller,
				) ??
				report.callGraph!.callers.find(
					(entry) => entry.file === fixture.callerFile,
				);
			const callerFileId = `file:${normalizeMapKey(path.join(env.project, fixture.callerFile))}`;
			const callerSymbolId = `${normalizeMapKey(path.join(env.project, fixture.callerFile))}:${fixture.caller}:${fixture.callerKind}:${fixture.callerLine}`;
			const calleeSymbolId = `${normalizeMapKey(path.join(env.project, path.basename(fixture.target)))}:${fixture.callee}:${fixture.calleeKind}:${fixture.calleeLine}`;
			expect(caller).toMatchObject(
				fixture.language === "elixir"
					? { file: fixture.callerFile, targetSymbolId: calleeSymbolId }
					: {
							file: fixture.callerFile,
							symbol: fixture.caller,
							kind: fixture.callerKind,
							line: fixture.callerLine,
							symbolId: callerSymbolId,
							targetSymbolId: calleeSymbolId,
						},
			);
			if (fixture.language === "elixir")
				expect(caller?.symbolId).toBe(callerFileId);
			expect(caller?.targetSymbolId).toBe(calleeSymbolId);
			const calleeReport = await moduleReport(
				path.join(env.project, fixture.callerFile),
				env.project,
				{ callGraph: true },
			);
			const callee = calleeReport.callGraph!.callees.find(
				(entry) => entry.symbol === fixture.callee,
			);
			expect(callee).toMatchObject({
				file: path.basename(fixture.target),
				symbol: fixture.callee,
				kind: fixture.calleeKind,
				line: fixture.calleeLine,
			});
			expect(callee?.symbolId).toBe(
				`${normalizeMapKey(path.join(env.project, path.basename(fixture.target)))}:${fixture.callee}:${fixture.calleeKind}:${fixture.calleeLine}`,
			);
			expect(callee?.targetSymbolId).toBe(
				fixture.language === "elixir"
					? `file:${normalizeMapKey(path.join(env.project, fixture.callerFile))}`
					: `${normalizeMapKey(path.join(env.project, fixture.callerFile))}:${fixture.caller}:${fixture.callerKind}:${fixture.callerLine}`,
			);
			expect(calleeReport.graphBuiltAt).toBe(reviewGraph.builtAt);
		});
	}

	it("keeps callers/callees bounded and preserves usedBy separately", async () => {
		const env = makeFixtureProject("javascript");
		await warmCallGraph(env.project);
		const report = await moduleReport(
			path.join(env.project, "callee.js"),
			env.project,
			{
				callGraph: true,
				maxCallGraphEntries: 2,
			},
		);

		expect(report.callGraph?.callers.length).toBeLessThanOrEqual(2);
		expect(report.callGraph?.callees).toHaveLength(0);
		expect(report.callGraph?.truncated).toBe(true);
		expect(report.callGraph?.coverage.totalEvidence).toBeGreaterThanOrEqual(4);
		// usedBy remains the import/reference surface, not a replacement for
		// callers/callees. It has the reference shape and no call-graph identity.
		const helper = report.api.find((entry) => entry.name === "helper");
		expect(helper?.usedBy?.length).toBeGreaterThan(0);
		expect(helper?.usedBy?.every((entry) => !("targetSymbolId" in entry))).toBe(
			true,
		);
		expect(report.provenance?.callGraph).toBe("cached-call-graph");
	});

	it("keeps the call section in the full artifact and the summary projection", async () => {
		const env = makeFixtureProject("typescript");
		await warmCallGraph(env.project);

		const report = await moduleReport(env.target, env.project, {
			callGraph: true,
		});
		expect(report.callGraph).toMatchObject({
			available: true,
			truncated: false,
		});
		const summary = projectModuleReport(report, "summary");
		expect(summary.callGraph).toMatchObject({
			available: true,
			truncated: false,
		});
		expect(summary.api[0]?.usedBy).toBeUndefined();
		expect(summary.callbacks).toEqual(report.callbacks);

		const rendered = renderCompactModuleReport(report);
		expect(rendered).toContain("CALL GRAPH:");
		expect(rendered).toContain("callers: 1");
		expect(rendered).toContain("coverage: complete");
	});

	it("call graph renders relation names and honours truncation", async () => {
		const env = makeFixtureProject("typescript");
		fs.writeFileSync(
			path.join(env.project, "caller2.ts"),
			'import { helper } from "./callee";\nexport function caller2(): number {\n  return helper();\n}\n',
		);
		await warmCallGraph(env.project);

		const report = await moduleReport(env.target, env.project, {
			callGraph: true,
			maxCallGraphEntries: 1,
		});
		expect(report.callGraph?.truncated).toBe(true);
		const rendered = renderCompactModuleReport(report);
		expect(rendered).toContain("CALL GRAPH: (truncated)");
		expect(rendered).toContain("caller");
		expect(rendered).toContain("caller.ts");
	});

	it("reports a derived projection as partial without hiding its usable edges", async () => {
		const env = makeFixtureProject("typescript");
		const { reviewGraph, callGraph } = await warmCallGraph(env.project);
		const identity = getReviewGraphCacheIdentity(env.project, reviewGraph)!;
		saveCallGraph(
			env.project,
			{
				...callGraph,
				coverage: { ...callGraph.coverage!, complete: false },
			},
			{
				reviewGraphVersion: identity.version,
				reviewGraphSignature: identity.signature,
			},
		);

		const report = await moduleReport(env.target, env.project, {
			callGraph: true,
		});
		expect(report.callGraph).toMatchObject({
			available: true,
			coverage: { status: "partial", complete: false },
		});
		expect(report.callGraph?.callers).toHaveLength(1);
	});

	for (const fixture of TYPE_ONLY_FIXTURES) {
		it(`keeps type-only references out of concrete calls for ${fixture.language}`, async ({
			skip,
		}) => {
			skipUnavailable(fixture.language, skip);
			const env = makeFixtureProject(fixture.directory);
			await warmCallGraph(env.project);
			const report = await moduleReport(env.target, env.project, {
				callGraph: true,
			});

			expect(report.callGraph).toMatchObject({ available: true });
			expect(report.callGraph?.callers).toHaveLength(0);
			expect(report.callGraph?.callees).toHaveLength(0);
			expect(report.callGraph?.coverage.typeOnlyEvidence).toBeGreaterThan(0);
		});
	}

	it("is read-only and honest on a cold cache", async () => {
		const env = makeFixtureProject("typescript");
		const before = getCachedReviewGraph(env.project);
		const report = await moduleReport(env.target, env.project, {
			callGraph: true,
		});
		const after = getCachedReviewGraph(env.project);

		expect(before).toBeUndefined();
		expect(after).toBeUndefined();
		expect(report.callGraph).toMatchObject({
			available: false,
			reason: "review-graph-missing",
			coverage: { status: "unavailable", complete: false },
		});
		expect(renderCompactModuleReport(report)).toContain(
			"unavailable (review-graph-missing)",
		);
	});

	it("rejects a derived cache with an identity mismatch without hiding the graph", async () => {
		const env = makeFixtureProject("typescript");
		const { reviewGraph, callGraph } = await warmCallGraph(env.project);
		const identity = getReviewGraphCacheIdentity(env.project, reviewGraph)!;
		saveCallGraph(env.project, callGraph, {
			reviewGraphVersion: identity.version,
			reviewGraphSignature: `${identity.signature}-stale`,
		});

		const report = await moduleReport(env.target, env.project, {
			callGraph: true,
		});
		expect(report.graphBuiltAt).toBe(reviewGraph.builtAt);
		expect(report.callGraph).toMatchObject({
			available: false,
			reason: "stale",
			coverage: { status: "unavailable", complete: false },
		});
	});
});
