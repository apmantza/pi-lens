/**
 * #3157: the FOUR in-lane cascade display sites in
 * `clients/dispatch/integration.ts` built `CascadeNeighborResult.diagnostics`
 * with a bare `convertLspDiagnostics` and rendered the result straight to the
 * agent through `formatCascadeNeighborDiagnostics` — no inline
 * `pi-lens-ignore`, no stored disposition, no `.pi-lens.json` rule policy, and
 * no auxiliary retag. `grep applyFindingPolicy clients/dispatch/integration.ts`
 * returned nothing. So a cold-neighbour ERROR the agent had marked
 * `false-positive` was hidden by `mode=delta`/`mode=full`/the per-edit
 * dispatcher/the probe lane/the quiet-window cascade run (#3102) and STILL came
 * back on every edit that cascaded to that neighbour.
 *
 * Every case drives the production builder `computeCascadeForFile` with real
 * neighbour files on disk and real marks written by the real
 * `lens_diagnostic_mark` tool. The four sites are reached by the four real
 * routes the cascade takes:
 *
 *   site 1  passive cold snapshot   `.ts` neighbour, TTL-fresh `getAllDiagnostics` entry
 *   site 2  fresh in-lane touch     `.py` neighbour, `touchFile` answers
 *   site 3  touch-error fallback    `.py` neighbour, `touchFile` rejects, snapshot is fresh
 *   site 4  degraded fallback       no neighbour produced LSP data at all
 *
 * The review-graph service and the LSP service are the two doubles, the same
 * pair `tests/clients/cascade-compute.test.ts` uses: the language server is a
 * process boundary, and the graph is the input that SELECTS neighbours, which
 * is upstream of everything under test here.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type {
	ImpactCascadeResult,
	ReviewGraph,
} from "../../clients/review-graph/types.js";
import type { LSPDiagnostic } from "../../clients/lsp/client.js";
import { normalizeMapKey } from "../../clients/path-utils.js";
import { removeTempDirSync, setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

/**
 * The filesystem is a process boundary, and the ONE thing a display filter must
 * not do on a per-edit path is read a file it has no reason to read. These
 * counters delegate to the real `fs` and only count `readFileSync` per path —
 * which is exactly the read `applyCascadeDisplayPolicy` pays (the active
 * touch's own neighbour read is `fs.promises.readFile`, a different function).
 */
const fsReads = vi.hoisted(() => ({ byPath: new Map<string, number>() }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		default: actual,
		readFileSync: (target: unknown, ...rest: unknown[]) => {
			if (typeof target === "string") {
				fsReads.byPath.set(target, (fsReads.byPath.get(target) ?? 0) + 1);
			}
			return (actual.readFileSync as (...args: unknown[]) => unknown)(
				target,
				...rest,
			);
		},
	};
});

const mocks = vi.hoisted(() => ({
	buildOrUpdateGraph: vi.fn(),
	computeImpactCascade: vi.fn(),
	computeTransitiveImpact: vi.fn(),
	formatImpactCascade: vi.fn(),
	getLSPService: vi.fn(),
	logCascade: vi.fn(),
	logLatency: vi.fn(),
}));

// Every factory spreads the real module and overrides only what it must, so
// the mock never silently drops an export the module under test reaches for
// (`tests/config/vi-mock-export-sweep.test.ts`).
vi.mock("../../clients/review-graph/service.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/review-graph/service.js")
	>()),
	buildOrUpdateGraph: mocks.buildOrUpdateGraph,
	computeImpactCascade: mocks.computeImpactCascade,
	computeTransitiveImpact: mocks.computeTransitiveImpact,
	formatImpactCascade: mocks.formatImpactCascade,
}));

vi.mock("../../clients/lsp/capabilities.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/lsp/capabilities.js")
	>()),
	getLSPService: mocks.getLSPService,
}));

// `logCascade` no-ops under `isTestMode()`, so spying on it directly is the
// only way to read the cascade's own phase rows.
vi.mock("../../clients/cascade-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/cascade-logger.js")>()),
	logCascade: mocks.logCascade,
}));

vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../clients/latency-logger.js")>()),
	logLatency: mocks.logLatency,
}));

const MARKED = "neighbour error the agent dismissed";
const SECOND_MARKED = "second neighbour error the agent dismissed";
const OTHER = "neighbour error nobody marked";
const NEIGHBOR_BODY = "const marked = 1;\nconst other = 2;\n";

/** The identity `convertLspDiagnostics` gives a primary language-server
 * finding, and therefore the spelling of a mark made on any other surface. */
const CANONICAL_MARK = { tool: "lsp", rule: "typescript:2345" };

function errorDiag(
	line: number,
	message: string,
	code: number | string = 2345,
	source = "typescript",
): LSPDiagnostic {
	return {
		severity: 1,
		message,
		source,
		code,
		range: { start: { line, character: 0 }, end: { line, character: 5 } },
	};
}

function emptyGraph(): ReviewGraph {
	return {
		version: "test",
		builtAt: new Date().toISOString(),
		nodes: new Map(),
		edges: [],
		edgesByFrom: new Map(),
		edgesByTo: new Map(),
		fileNodes: new Map(),
		symbolNodesByFile: new Map(),
		changedSymbolsByFile: new Map(),
	};
}

function impact(filePath: string, neighbors: string[]): ImpactCascadeResult {
	return {
		filePath,
		changedSymbols: ["changed"],
		directImporters: neighbors,
		directCallers: [],
		neighborFiles: neighbors,
		riskFlags: [],
	};
}

let env: { tmpDir: string; cleanup: () => void };
let primary: string;
let neighbor: string;
let previousDataDir: string | undefined;

beforeEach(async () => {
	vi.resetModules();
	env = setupTestEnvironment("pi-lens-3157-inlane-");
	primary = path.join(env.tmpDir, "primary.ts");
	neighbor = path.join(env.tmpDir, "neighbor.ts");
	fs.writeFileSync(primary, "export const x = 1;\n");
	fs.writeFileSync(neighbor, NEIGHBOR_BODY);
	previousDataDir = process.env.PILENS_DATA_DIR;
	process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");

	mocks.buildOrUpdateGraph.mockReset().mockResolvedValue(emptyGraph());
	mocks.computeImpactCascade.mockReset();
	mocks.computeTransitiveImpact.mockReset().mockReturnValue({
		seedFile: "",
		hits: [],
		truncated: false,
		maxDepthReached: 0,
	});
	mocks.formatImpactCascade.mockReset().mockReturnValue("");
	mocks.getLSPService.mockReset();
	mocks.logCascade.mockReset();
	mocks.logLatency.mockReset();
	fsReads.byPath.clear();

	const { _resetDeferredForTests, _resetStateCacheForTests } =
		await import("../../clients/diagnostic-dispositions.js");
	_resetDeferredForTests();
	_resetStateCacheForTests();
	const { resetDispatchBaselines } =
		await import("../../clients/dispatch/integration.js");
	resetDispatchBaselines();
}, 30_000);

afterEach(async () => {
	if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
	else process.env.PILENS_DATA_DIR = previousDataDir;
	const { _resetDeferredForTests, _resetStateCacheForTests } =
		await import("../../clients/diagnostic-dispositions.js");
	_resetDeferredForTests();
	_resetStateCacheForTests();
	removeTempDirSync(env.tmpDir);
	env.cleanup();
});

async function mark(params: Record<string, unknown>, root = env.tmpDir) {
	const { createLensDiagnosticMarkTool } =
		await import("../../tools/lens-diagnostic-mark.js");
	const markTool = createLensDiagnosticMarkTool(() => root);
	const result = await markTool.execute(
		"mark-3157",
		params,
		undefined,
		() => {},
		{ cwd: root },
	);
	expect(result.isError).toBeFalsy();
	return result;
}

/** `getAllDiagnostics` entries, keyed the way the producer keys them. */
function diagMap(entries: Array<[string, LSPDiagnostic[]]>) {
	return new Map(
		entries.map(([file, diags]) => [
			normalizeMapKey(file),
			{ diags, ts: Date.now() },
		]),
	);
}

/**
 * Run the production cascade for `primary` and return what the agent reads.
 * `neighbors` selects the neighbour set the graph would have produced.
 */
async function cascadeFor(
	service: Record<string, unknown>,
	neighborPaths: string[] = [neighbor],
	options: { cwd?: string; projectRoot?: string } = {},
): Promise<string> {
	mocks.computeImpactCascade.mockReturnValue(impact(primary, neighborPaths));
	mocks.getLSPService.mockReturnValue(service);
	const { computeCascadeForFile } =
		await import("../../clients/dispatch/integration.js");
	const run = await computeCascadeForFile(primary, options.cwd ?? env.tmpDir, {
		turnSeq: 1,
		writeSeq: 1,
		...(options.projectRoot !== undefined && {
			projectRoot: options.projectRoot,
		}),
	});
	return run?.result?.formatted ?? "";
}

/** Site 1: `.ts` neighbour served from the passive cold snapshot. */
function snapshotService(diags: LSPDiagnostic[], neighborPath = neighbor) {
	return {
		...makeLspServiceDouble(),
		getAllDiagnostics: vi
			.fn()
			.mockResolvedValue(diagMap([[neighborPath, diags]])),
		touchFile: vi.fn(),
	};
}

const cascadePolicyRows = () =>
	mocks.logLatency.mock.calls
		.map(([entry]) => entry as Record<string, unknown>)
		.filter((entry) => entry?.phase === "cascade_finding_policy");

describe("in-lane cascade neighbour diagnostics take the finding policy (#3157)", () => {
	it("premise: both neighbour errors reach the agent before anything is marked", async () => {
		const formatted = await cascadeFor(
			snapshotService([errorDiag(0, MARKED), errorDiag(1, OTHER, 2304)]),
		);
		expect(formatted).toContain(MARKED);
		expect(formatted).toContain(OTHER);
		// The FALSE arm of the #1616 sentence: a run that dropped nothing must not
		// announce "suppressed by disposition: 0 finding(s)".
		expect(formatted).not.toContain("suppressed by disposition:");
	});

	it("site 1 (passive cold snapshot): drops a neighbour error marked false-positive", async () => {
		await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const formatted = await cascadeFor(
			snapshotService([errorDiag(0, MARKED), errorDiag(1, OTHER, 2304)]),
		);
		expect(formatted).not.toContain(MARKED);
		expect(formatted).toContain(OTHER);
	});

	it("site 1: drops a neighbour error marked from the cascade block's own rendering, which prints no tool", async () => {
		// The cascade line is `line N, col M rule=<rule>: <message>` — no tool for
		// the agent to pass on, and `lens_diagnostic_mark`'s `tool` is optional.
		await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED,
			rule: "typescript:2345",
			disposition: "false-positive",
		});
		const formatted = await cascadeFor(
			snapshotService([errorDiag(0, MARKED), errorDiag(1, OTHER, 2304)]),
		);
		expect(formatted).not.toContain(MARKED);
		expect(formatted).toContain(OTHER);
	});

	it("site 1: drops a rule the project disabled in .pi-lens.json", async () => {
		fs.writeFileSync(
			path.join(env.tmpDir, ".pi-lens.json"),
			JSON.stringify({ rules: { ts: { disable: ["typescript:2345"] } } }),
		);
		const formatted = await cascadeFor(
			snapshotService([errorDiag(0, MARKED), errorDiag(1, OTHER, 2304)]),
		);
		expect(formatted).not.toContain(MARKED);
		expect(formatted).toContain(OTHER);
	});

	it("site 1: drops a neighbour error an inline pi-lens-ignore comment suppresses", async () => {
		fs.writeFileSync(
			neighbor,
			"// pi-lens-ignore: typescript:2345\nconst marked = 1;\nconst other = 2;\n",
		);
		const formatted = await cascadeFor(
			snapshotService([errorDiag(1, MARKED), errorDiag(2, OTHER, 2304)]),
		);
		expect(formatted).not.toContain(MARKED);
		expect(formatted).toContain(OTHER);
	});

	it("site 1: honours the auxiliary profile's own native nosemgrep suppression (converges with #3102)", async () => {
		// The issue's aux inconsistency: the quiet-window builder drops these per
		// the profile's native suppression and records `auxSuppressed`, while the
		// in-lane sites rendered them. Both lanes read a raw client cache, so
		// nothing upstream ran `applyAuxiliarySuppressions` — this is the FIRST
		// application, not a double-apply.
		fs.writeFileSync(
			neighbor,
			"const marked = 1; // nosemgrep: aux-rule\nconst other = 2;\n",
		);
		const formatted = await cascadeFor(
			snapshotService([
				errorDiag(0, MARKED, "aux-rule", "opengrep"),
				errorDiag(1, OTHER, "other-rule", "opengrep"),
			]),
		);
		expect(formatted).not.toContain(MARKED);
		expect(formatted).toContain(OTHER);
		expect(cascadePolicyRows()[0]?.metadata).toMatchObject({
			suppressed: 0,
			total: 2,
			auxSuppressed: 1,
		});
	});

	it("site 1: drops an aux error marked under the auxiliary's REAL tool id, not a hardcoded lsp", async () => {
		// #692/#3046: `retagAuxiliaryDiagnostics` is what makes the anchor say
		// `opengrep` here instead of the generic `lsp` every other surface stopped
		// using — a mark made from the widget or mode=full carries that spelling.
		await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED,
			tool: "opengrep",
			rule: "opengrep:aux-rule",
			disposition: "false-positive",
		});
		const formatted = await cascadeFor(
			snapshotService([
				errorDiag(0, MARKED, "aux-rule", "opengrep"),
				errorDiag(1, OTHER, "other-rule", "opengrep"),
			]),
		);
		expect(formatted).not.toContain(MARKED);
		expect(formatted).toContain(OTHER);
	});

	it("site 2 (fresh in-lane touch): drops a neighbour error marked false-positive", async () => {
		const pyNeighbor = path.join(env.tmpDir, "neighbor.py");
		fs.writeFileSync(pyNeighbor, "marked = 1\nother = 2\n");
		await mark({
			filePath: pyNeighbor,
			line: 1,
			message: MARKED,
			tool: "lsp",
			rule: "pyright:reportGeneralTypeIssues",
			disposition: "false-positive",
		});
		const service = {
			...makeLspServiceDouble(),
			getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
			touchFile: vi.fn().mockResolvedValue({
				diags: [
					errorDiag(0, MARKED, "reportGeneralTypeIssues", "pyright"),
					errorDiag(1, OTHER, "reportUnusedVariable", "pyright"),
				],
			}),
		};
		const formatted = await cascadeFor(service, [pyNeighbor]);
		expect(service.touchFile).toHaveBeenCalled();
		expect(formatted).not.toContain(MARKED);
		expect(formatted).toContain(OTHER);
	});

	it("site 3 (touch-error fallback): drops a neighbour error marked false-positive", async () => {
		const pyNeighbor = path.join(env.tmpDir, "neighbor.py");
		fs.writeFileSync(pyNeighbor, "marked = 1\nother = 2\n");
		await mark({
			filePath: pyNeighbor,
			line: 1,
			message: MARKED,
			tool: "lsp",
			rule: "pyright:reportGeneralTypeIssues",
			disposition: "false-positive",
		});
		const service = {
			...makeLspServiceDouble(),
			getAllDiagnostics: vi
				.fn()
				.mockResolvedValue(
					diagMap([
						[
							pyNeighbor,
							[
								errorDiag(0, MARKED, "reportGeneralTypeIssues", "pyright"),
								errorDiag(1, OTHER, "reportUnusedVariable", "pyright"),
							],
						],
					]),
				),
			touchFile: vi.fn().mockRejectedValue(new Error("server died")),
		};
		const formatted = await cascadeFor(service, [pyNeighbor]);
		expect(formatted).not.toContain(MARKED);
		expect(formatted).toContain(OTHER);
	});

	it("site 4 (degraded fallback): drops a neighbour error marked false-positive", async () => {
		// Nothing produced LSP data this run (the neighbour has no configured
		// server), so the degraded fallback surfaces whatever the client cache
		// still holds for OTHER project files.
		const collateral = path.join(env.tmpDir, "collateral.ts");
		fs.writeFileSync(collateral, NEIGHBOR_BODY);
		const orphan = path.join(env.tmpDir, "orphan.txt");
		fs.writeFileSync(orphan, "not code\n");
		await mark({
			filePath: collateral,
			line: 1,
			message: MARKED,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const service = {
			...makeLspServiceDouble(),
			getAllDiagnostics: vi
				.fn()
				.mockResolvedValue(
					diagMap([
						[collateral, [errorDiag(0, MARKED), errorDiag(1, OTHER, 2304)]],
					]),
				),
			touchFile: vi.fn(),
		};
		const formatted = await cascadeFor(service, [orphan]);
		expect(formatted).toContain("collateral.ts");
		expect(formatted).not.toContain(MARKED);
		expect(formatted).toContain(OTHER);
	});

	it("records ONE bounded cascade_finding_policy row per RUN, not one per neighbour", async () => {
		// The per-edit cascade walks up to CASCADE_NEIGHBOUR_BUDGET neighbours, so
		// a row inside the loop would be per-occurrence logging on a per-edit path.
		const second = path.join(env.tmpDir, "second.ts");
		fs.writeFileSync(second, NEIGHBOR_BODY);
		for (const file of [neighbor, second]) {
			await mark({
				filePath: file,
				line: 1,
				message: MARKED,
				...CANONICAL_MARK,
				disposition: "false-positive",
			});
		}
		const service = {
			...makeLspServiceDouble(),
			getAllDiagnostics: vi.fn().mockResolvedValue(
				diagMap([
					[neighbor, [errorDiag(0, MARKED), errorDiag(1, OTHER, 2304)]],
					[second, [errorDiag(0, MARKED), errorDiag(1, OTHER, 2304)]],
				]),
			),
			touchFile: vi.fn(),
		};
		await cascadeFor(service, [neighbor, second]);
		const rows = cascadePolicyRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.filePath).toBe(primary);
		expect(rows[0]?.metadata).toMatchObject({
			suppressed: 2,
			total: 4,
			auxSuppressed: 0,
		});
	});

	it("emits no cascade_finding_policy row when NEITHER counter moved", async () => {
		await cascadeFor(snapshotService([errorDiag(0, OTHER, 2304)]));
		expect(cascadePolicyRows()).toHaveLength(0);
	});

	it("states the run's own drop count on the cascade block (#1616)", async () => {
		fs.writeFileSync(
			neighbor,
			"const one = 1;\nconst two = 2;\nconst three = 3;\n",
		);
		for (const [line, message, code] of [
			[1, MARKED, 2345],
			[2, SECOND_MARKED, 2339],
		] as const) {
			await mark({
				filePath: neighbor,
				line,
				message,
				tool: "lsp",
				rule: `typescript:${code}`,
				disposition: "false-positive",
			});
		}
		const formatted = await cascadeFor(
			snapshotService([
				errorDiag(0, MARKED),
				errorDiag(1, SECOND_MARKED, 2339),
				errorDiag(2, OTHER, 2304),
			]),
		);
		expect(formatted).toContain(OTHER);
		// The interpolated VALUE, not just the sentence: a hardcoded `1` reads the
		// same on a single-drop case.
		expect(formatted).toContain("suppressed by disposition: 2 finding(s)");
	});

	it("honours a mark stored under the PROJECT root when the cascade cwd is a nested language root", async () => {
		// #1030: `computeCascadeForFile` is handed `resolveLanguageRootForFile`'s
		// answer, while `lens_diagnostic_mark` writes under `runtime.projectRoot`.
		// Reading the disposition store from the language root opens a DIFFERENT
		// `diagnostic-dispositions.json` and silently no-ops every mark, which
		// would leave this whole fix inert in a monorepo.
		const languageRoot = path.join(env.tmpDir, "packages", "app");
		fs.mkdirSync(languageRoot, { recursive: true });
		const nested = path.join(languageRoot, "neighbor.ts");
		fs.writeFileSync(nested, NEIGHBOR_BODY);
		neighbor = nested;
		await mark({
			filePath: nested,
			line: 1,
			message: MARKED,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const formatted = await cascadeFor(
			snapshotService(
				[errorDiag(0, MARKED), errorDiag(1, OTHER, 2304)],
				nested,
			),
			[nested],
			{ cwd: languageRoot, projectRoot: env.tmpDir },
		);
		expect(formatted).not.toContain(MARKED);
		expect(formatted).toContain(OTHER);
	});

	it("renders the genuine errors BELOW the display cap when the first MAX_PER_FILE are all marked", async () => {
		// Round 2 F1: the `slice(0, MAX_PER_FILE)` display cap used to run BEFORE
		// the policy, so policy drops consumed cap slots. A neighbour with 25
		// ERRORs whose first 20 are marked false-positive rendered NOTHING — the
		// five genuine ones were never looked at, the record said `total: 20`, and
		// the empty block suppressed the #1616 sentence too. A false clean
		// (AGENTS.md shape 10), and strictly worse than the pre-#3157 behaviour
		// for this input.
		fs.writeFileSync(
			neighbor,
			Array.from({ length: 25 }, (_, i) => `const v${i} = ${i};`).join("\n") +
				"\n",
		);
		const diags = Array.from({ length: 25 }, (_, i) =>
			errorDiag(i, `err-${i}`, 2300 + i),
		);
		for (let i = 0; i < 20; i++) {
			await mark({
				filePath: neighbor,
				line: i + 1,
				message: `err-${i}`,
				tool: "lsp",
				rule: `typescript:${2300 + i}`,
				disposition: "false-positive",
			});
		}
		const formatted = await cascadeFor(snapshotService(diags));
		expect(formatted).toContain("err-20");
		expect(formatted).toContain("err-24");
		expect(formatted).not.toContain("err-19");
		expect(formatted).toContain("suppressed by disposition: 20 finding(s)");
		// The denominator is the neighbour's full ERROR count, not the cap.
		expect(cascadePolicyRows()[0]?.metadata).toMatchObject({
			suppressed: 20,
			total: 25,
			auxSuppressed: 0,
		});
	});

	it("caps the SURVIVORS at MAX_PER_FILE, not the input", async () => {
		// The display cap still bounds what one neighbour may print; it now cuts
		// the tail of the KEPT list instead of the head of the raw list.
		fs.writeFileSync(
			neighbor,
			Array.from({ length: 25 }, (_, i) => `const v${i} = ${i};`).join("\n") +
				"\n",
		);
		const formatted = await cascadeFor(
			snapshotService(
				Array.from({ length: 25 }, (_, i) =>
					errorDiag(i, `err-${i}`, 2300 + i),
				),
			),
		);
		expect(formatted).toContain("err-0");
		expect(formatted).toContain("err-19");
		expect(formatted).not.toContain("err-20");
	});

	it("counts the ERRORs the pre-policy input bound never showed the policy", async () => {
		// The input bound (MAX_POLICY_INPUT_PER_FILE = 4x the display cap) exists
		// for cost — the policy is linear in the finding count once the project has
		// any mark. An input bound whose loss is INVISIBLE is the same defect F1
		// found in the display cap, so the loss is counted even when the policy
		// itself dropped nothing.
		fs.writeFileSync(
			neighbor,
			Array.from({ length: 100 }, (_, i) => `const v${i} = ${i};`).join("\n") +
				"\n",
		);
		await cascadeFor(
			snapshotService(
				Array.from({ length: 100 }, (_, i) =>
					errorDiag(i, `err-${i}`, 2300 + i),
				),
			),
		);
		expect(cascadePolicyRows()[0]?.metadata).toMatchObject({
			suppressed: 0,
			auxSuppressed: 0,
			total: 80,
			inputTruncated: 20,
		});
	});

	it("tells the AGENT when the input bound left findings unevaluated (all 80 marked)", async () => {
		// Round 3 N1: the round-2 input bound reproduced F1 one threshold up. With
		// 100 ERRORs and the first 80 marked, the bound cuts at 80, the policy drops
		// all 80, `kept` is empty, and `formatCascadeResult`'s `if
		// (!diagnosticsBlock) return ""` fires BEFORE any sentence — so 20 genuine
		// unevaluated ERRORs reached the agent as silence. `inputTruncated` on the
		// latency row is an OPERATOR surface; the misled actor is the agent.
		fs.writeFileSync(
			neighbor,
			Array.from({ length: 100 }, (_, i) => `const v${i} = ${i};`).join("\n") +
				"\n",
		);
		for (let i = 0; i < 80; i++) {
			await mark({
				filePath: neighbor,
				line: i + 1,
				message: `err-${i}`,
				tool: "lsp",
				rule: `typescript:${2300 + i}`,
				disposition: "false-positive",
			});
		}
		const formatted = await cascadeFor(
			snapshotService(
				Array.from({ length: 100 }, (_, i) =>
					errorDiag(i, `err-${i}`, 2300 + i),
				),
			),
		);
		expect(formatted).toContain("did not evaluate 20 finding(s)");
		expect(formatted).toContain("no findings does NOT mean clean here");
		// The sentence rides along: it is what explains the empty block.
		expect(formatted).toContain("suppressed by disposition: 80 finding(s)");
	});

	it("tells the AGENT when a single .pi-lens.json rule disable exhausts the input bound", async () => {
		// Reachability without hand marks (round 3 N1, the reviewer's second
		// probe): one rule disable over a neighbour whose first 80 ERRORs share
		// that rule hides 20 genuine errors of a DIFFERENT rule behind an empty
		// block.
		fs.writeFileSync(
			path.join(env.tmpDir, ".pi-lens.json"),
			JSON.stringify({ rules: { ts: { disable: ["typescript:2304"] } } }),
		);
		fs.writeFileSync(
			neighbor,
			Array.from({ length: 100 }, (_, i) => `const v${i} = ${i};`).join("\n") +
				"\n",
		);
		const formatted = await cascadeFor(
			snapshotService([
				...Array.from({ length: 80 }, (_, i) =>
					errorDiag(i, `disabled-${i}`, 2304),
				),
				...Array.from({ length: 20 }, (_, i) =>
					errorDiag(80 + i, `GENUINE-${i}`, 2345),
				),
			]),
		);
		expect(formatted).toContain("did not evaluate 20 finding(s)");
		expect(formatted).not.toContain("disabled-0");
	});

	it("interpolates the run's OWN truncation count into the coverage line", async () => {
		// Both reviewer probes truncate exactly 20, so a hardcoded `20` in the
		// line reads identically under either — this case demands a different
		// number (150 ERRORs, bound 80, so 70 were never evaluated) and is the
		// only case that reds when the count is hardcoded.
		fs.writeFileSync(
			neighbor,
			Array.from({ length: 150 }, (_, i) => `const v${i} = ${i};`).join("\n") +
				"\n",
		);
		const formatted = await cascadeFor(
			snapshotService(
				Array.from({ length: 150 }, (_, i) =>
					errorDiag(i, `err-${i}`, 2300 + (i % 50)),
				),
			),
		);
		expect(formatted).toContain("did not evaluate 70 finding(s)");
		expect(cascadePolicyRows()[0]?.metadata).toMatchObject({
			total: 80,
			inputTruncated: 70,
		});
	});

	it("stays silent when every error was policy-dropped and NOTHING was truncated", async () => {
		// Round 3, the other half of the decision: row 3 of the terminal-state
		// table keeps `""`. Every finding WAS evaluated and every drop is the
		// agent's own mark, so re-announcing them on a push surface that fires on
		// every edit is nagging — and the quiet-window lane already decided this
		// (`builds no cascade run at all when every neighbour error was
		// suppressed`). Making this lane speak here would re-open the two-lane
		// divergence #3157 exists to close.
		await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		const formatted = await cascadeFor(snapshotService([errorDiag(0, MARKED)]));
		expect(formatted).toBe("");
	});

	it("times the policy stack only, not the neighbour touch fan-out", async () => {
		// Round 2 F2: `policyStart` was taken before the whole `touchFile` fan-out,
		// so the in-lane `cascade_finding_policy` row reported the WALK (hundreds
		// of ms) as the policy phase — three orders off what AC 3 measured, and
		// incompatible with the quiet-window lane writing the same phase literal.
		// The clock is faked (Date only, no real wait) so the slow touch costs
		// nothing in wall time and the assertion is deterministic.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const pyNeighbor = path.join(env.tmpDir, "neighbor.py");
			fs.writeFileSync(pyNeighbor, "marked = 1\nother = 2\n");
			await mark({
				filePath: pyNeighbor,
				line: 1,
				message: MARKED,
				tool: "lsp",
				rule: "pyright:reportGeneralTypeIssues",
				disposition: "false-positive",
			});
			const service = {
				...makeLspServiceDouble(),
				getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
				touchFile: vi.fn(async () => {
					// The neighbour walk's own cost, charged to the fan-out.
					vi.setSystemTime(Date.now() + 300);
					return {
						diags: [
							errorDiag(0, MARKED, "reportGeneralTypeIssues", "pyright"),
							errorDiag(1, OTHER, "reportUnusedVariable", "pyright"),
						],
					};
				}),
			};
			const formatted = await cascadeFor(service, [pyNeighbor]);
			expect(formatted).not.toContain(MARKED);
			const row = cascadePolicyRows()[0];
			expect(row).toBeDefined();
			expect(row?.durationMs).toBeLessThan(300);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads nothing for a neighbour with no ERROR diagnostics to render", async () => {
		// The cost guard on the per-edit path: a cascade walks up to
		// CASCADE_NEIGHBOUR_BUDGET (40) neighbours, and most of them are clean.
		// The content read is paid only once a neighbour actually has something to
		// render — the same discipline the quiet-window builder documents.
		const formatted = await cascadeFor(
			snapshotService([
				{ ...errorDiag(0, OTHER, 2304), severity: 2 } as LSPDiagnostic,
			]),
		);
		expect(formatted).toBe("");
		expect(fsReads.byPath.get(neighbor) ?? 0).toBe(0);
	});

	it("site 2: anchors against the bytes the touch was computed from, with no second read", async () => {
		// The active touch has ALREADY read the neighbour to feed `touchFile`.
		// Re-reading would pay a second read per touched neighbour AND anchor the
		// STRICT false-positive hash against bytes the diagnostics were never
		// computed from, if the file moved during the (up to 2s) touch.
		const pyNeighbor = path.join(env.tmpDir, "neighbor.py");
		fs.writeFileSync(pyNeighbor, "marked = 1\nother = 2\n");
		const service = {
			...makeLspServiceDouble(),
			getAllDiagnostics: vi.fn().mockResolvedValue(new Map()),
			touchFile: vi.fn().mockResolvedValue({
				diags: [errorDiag(0, MARKED, "reportGeneralTypeIssues", "pyright")],
			}),
		};
		const formatted = await cascadeFor(service, [pyNeighbor]);
		expect(formatted).toContain(MARKED);
		expect(fsReads.byPath.get(pyNeighbor) ?? 0).toBe(0);
	});

	/**
	 * Round 2 F3: the LANGUAGE-root half of the two-root split. `cwd` reaches
	 * exactly one consumer — `profile.allowBlocking(cwd)`
	 * (`clients/dispatch/auxiliary-lsp.ts:413`), which for opengrep is
	 * `Boolean(findLocalOpengrepConfig(cwd))`, a WALK-UP from `cwd`
	 * (`clients/path-utils.ts:556`). A config inside the language root is found
	 * from there and NOT from the project root, which flips the aux finding's
	 * `semantic` — and `applyDispositions` gates two of its three drop arms on
	 * `d.semantic === "blocking"`. So the root choice decides whether a weak
	 * `defer` mark hides this finding, on the display path, observably.
	 *
	 * The pair is deliberate: the second case is the control that proves the
	 * defer mark matches at all, so the first cannot pass vacuously.
	 */
	async function deferredAuxNeighbour(withLocalOpengrepConfig: boolean) {
		const languageRoot = path.join(env.tmpDir, "packages", "app");
		fs.mkdirSync(languageRoot, { recursive: true });
		const nested = path.join(languageRoot, "neighbor.ts");
		fs.writeFileSync(nested, NEIGHBOR_BODY);
		if (withLocalOpengrepConfig) {
			fs.writeFileSync(path.join(languageRoot, ".opengrep.yml"), "rules: []\n");
		}
		// Premise: nothing ABOVE the project root supplies a config, or the two
		// roots would not differ and this case would prove nothing.
		const { findLocalOpengrepConfig } =
			await import("../../clients/opengrep-config.js");
		expect(findLocalOpengrepConfig(env.tmpDir)).toBeUndefined();
		await mark({
			filePath: nested,
			line: 1,
			message: MARKED,
			tool: "opengrep",
			rule: "opengrep:aux-rule",
			disposition: "defer",
		});
		return cascadeFor(
			snapshotService([errorDiag(0, MARKED, "aux-rule", "opengrep")], nested),
			[nested],
			{ cwd: languageRoot, projectRoot: env.tmpDir },
		);
	}

	it("keeps an aux error BLOCKING when the local config sits at the language root, so a weak defer cannot hide it", async () => {
		expect(await deferredAuxNeighbour(true)).toContain(MARKED);
	});

	it("control: with no local config the same aux error is advisory and the defer DOES hide it", async () => {
		expect(await deferredAuxNeighbour(false)).not.toContain(MARKED);
	});

	it("keeps neighbour errors visible when the neighbour cannot be read (fail open)", async () => {
		await mark({
			filePath: neighbor,
			line: 1,
			message: MARKED,
			...CANONICAL_MARK,
			disposition: "false-positive",
		});
		// A STRICT false-positive anchor hashes the finding's own line, so with no
		// content it cannot match — the finding stays VISIBLE rather than being
		// hidden on an I/O error (AGENTS.md shape 48).
		fs.rmSync(neighbor);
		fs.mkdirSync(neighbor);
		const formatted = await cascadeFor(snapshotService([errorDiag(0, MARKED)]));
		expect(formatted).toContain(MARKED);
	});
});
