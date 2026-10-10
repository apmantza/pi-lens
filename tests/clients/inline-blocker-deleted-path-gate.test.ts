/**
 * #3190 — the turn-end inline-blocker record is built from the SAME deliverable
 * set the per-edit surface renders.
 *
 * #2028 routes the per-edit 🔴 STOP block through the shared deleted-path gate
 * (`dropFindingsForMissingPaths`, `clients/pipeline.ts`'s `deliverableBlockers`)
 * and #3189 stopped the empty banner it could produce, but the DURABLE record
 * the pipeline hands the turn-end surface was still built from the UNGATED
 * `dispatchResult.blockerOutput` / `dispatchResult.blockers`. So a blocker whose
 * cited file no longer exists was retracted from the tool result and then
 * re-delivered — and it latched the commit gate through
 * `PipelineResult.hasBlockers` (`clients/runtime-tool-result.ts`'s
 * `runtime.updateGitGuardStatus(result.hasBlockers, result.output)`), whose
 * summary then fell back to the pipeline's own all-clear line.
 *
 * The recurrence these cases prevent is precisely that re-delivery: one gate,
 * applied once at the producer, so every surface sees the same set.
 *
 * #1245's existence reconcile (`RuntimeCoordinator.reconcileInlineBlockers`,
 * pinned by `tests/clients/runtime-coordinator.test.ts`'s "inline blockers
 * reconcile against disk (#1245)") already drops a record whose OWN path is
 * gone, which is why every case here uses the shape it cannot see: a record on
 * a file that still exists, carrying a blocker cited against a deleted sibling
 * — the cross-file population `pipeline.ts` documents for helm-lint /
 * helm-render / javac / dotnet-build.
 *
 * Layer: the REAL chain. `handleToolResult` → the REAL `runPipeline` → the REAL
 * `RuntimeCoordinator` record → the REAL `handleTurnEnd` re-serve. Only the
 * dispatch and LSP seams are doubled, exactly as
 * `tests/clients/write-autofix-attachment-message.test.ts` and
 * `tests/clients/pipeline.test.ts` double them, so the producer under change is
 * shipping code rather than a fixture. The blocker text the double returns is
 * rendered with `formatDiagnostics(blockers, "blocking")` — `dispatcher.ts`'s
 * own expression for `blockerOutput` — so the double cannot make the gate look
 * green by disagreeing with itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { formatDiagnostics } from "../../clients/dispatch/utils/format-utils.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";

vi.mock("../../clients/dispatch/integration.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/dispatch/integration.js")
	>()),
	dispatchLintWithResult: vi.fn(),
	computeCascadeForFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../clients/lsp/capabilities.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/lsp/capabilities.js")
	>()),
	getLSPService: vi.fn(),
	resyncGitChangedFiles: vi.fn().mockResolvedValue(undefined),
}));

import { dispatchLintWithResult } from "../../clients/dispatch/integration.js";
import { getLSPService } from "../../clients/lsp/capabilities.js";

const DEAD_MARKER = "DEAD-PATH-BLOCKER-MARKER nil pointer evaluating .replicas";
const LIVE_MARKER = "LIVE-BLOCKER-MARKER unused variable";

let tmpDir: string;
let cleanup: () => void;

beforeEach(() => {
	const env = setupTestEnvironment("pi-lens-3190-inline-gate-");
	tmpDir = env.tmpDir;
	cleanup = env.cleanup;
	vi.mocked(dispatchLintWithResult).mockReset();
	vi.mocked(getLSPService).mockReturnValue(
		makeLspServiceDouble({
			supportsLSP: () => false,
			hasLSP: async () => false,
		}) as never,
	);
});

afterEach(() => {
	cancelLSPIdleReset();
	cleanup();
});

function blockingDiagnostic(
	filePath: string,
	line: number,
	message: string,
	tool: string,
): Diagnostic {
	return {
		id: `${tool}:${path.basename(filePath)}:${line}`,
		message,
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool,
	} as Diagnostic;
}

/**
 * A `DispatchResult` shaped the way `dispatcher.ts` shapes one: `blockerOutput`
 * is `formatDiagnostics(blockers, "blocking")` (its own line), and `output`
 * starts with that same text.
 */
function dispatchWith(blockers: Diagnostic[]) {
	const blockerOutput = formatDiagnostics(blockers, "blocking");
	return {
		diagnostics: [...blockers],
		blockers,
		warnings: [],
		baselineWarningCount: 0,
		fixed: [],
		resolvedCount: 0,
		output: blockerOutput,
		blockerOutput,
		hasBlockers: blockers.length > 0,
	};
}

function toolResultDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
) {
	return {
		getFlag: (name: string) => name === "no-lsp",
		dbg: () => {},
		runtime,
		cacheManager,
		biomeClient: {
			isSupportedFile: () => false,
			ensureAvailable: async () => false,
		},
		ruffClient: {
			isPythonFile: () => false,
			ensureAvailable: async () => false,
		},
		metricsClient: {},
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as unknown as Parameters<typeof handleToolResult>[0];
}

function turnEndDeps(runtime: RuntimeCoordinator, cacheManager: CacheManager) {
	return {
		ctxCwd: tmpDir,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => ({
				success: true,
				issues: [],
				unusedExports: [],
				unusedFiles: [],
				unusedDeps: [],
				unlistedDeps: [],
				summary: "skipped",
			}),
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
	} as unknown as Parameters<typeof handleTurnEnd>[0];
}

/** Drive one edit through the real tool-result chain. */
async function edit(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	filePath: string,
): Promise<string> {
	const returned = await handleToolResult({
		...toolResultDeps(runtime, cacheManager),
		event: {
			toolName: "edit",
			input: { path: filePath },
			details: { diff: "+  1 replicas: 2" },
			content: [{ type: "text", text: "base" }],
		},
	} as never);
	return ((returned?.content ?? []) as Array<{ text?: string }>)
		.map((part) => part.text ?? "")
		.join("\n");
}

/** What the agent is served at turn end. */
async function turnEndText(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
): Promise<string> {
	await handleTurnEnd(turnEndDeps(runtime, cacheManager));
	return (
		cacheManager.readCache<{ content: string }>("turn-end-findings", tmpDir)
			?.data?.content ?? ""
	);
}

function newSession(): {
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
} {
	const runtime = new RuntimeCoordinator();
	runtime.projectRoot = tmpDir;
	runtime.setTelemetryIdentity({ sessionId: "pi-lens-3190" });
	runtime.beginTurn();
	return { runtime, cacheManager: new CacheManager(false) };
}

/**
 * The F1 shape: the edited file exists — #1245's reconcile cannot see this —
 * and the only blocker is cited against a chart sibling the turn deleted.
 */
function totalRetractionFixture(name: string): string {
	const edited = path.join(tmpDir, "templates", name);
	fs.mkdirSync(path.dirname(edited), { recursive: true });
	fs.writeFileSync(edited, "replicas: 2\n");
	const deletedSibling = path.join(tmpDir, `deleted-${name}`);
	vi.mocked(dispatchLintWithResult).mockResolvedValue(
		dispatchWith([
			blockingDiagnostic(deletedSibling, 150, DEAD_MARKER, "helm-lint"),
		]) as never,
	);
	return edited;
}

/** The F2 shape: one retracted blocker, one survivor on the edited file. */
function partialRetractionFixture(name: string): string {
	const edited = path.join(tmpDir, "templates", name);
	fs.mkdirSync(path.dirname(edited), { recursive: true });
	fs.writeFileSync(edited, "replicas: 2\n");
	const deletedSibling = path.join(tmpDir, `deleted-${name}`);
	vi.mocked(dispatchLintWithResult).mockResolvedValue(
		dispatchWith([
			blockingDiagnostic(deletedSibling, 150, DEAD_MARKER, "helm-lint"),
			blockingDiagnostic(edited, 1, LIVE_MARKER, "yamllint"),
		]) as never,
	);
	return edited;
}

describe("#3190 the inline-blocker record carries only deliverable blockers", () => {
	it("stores no inline-blocker record when every blocker cites a deleted sibling", async () => {
		// F1 + F4, at the producer: nothing stored, and the commit gate must not
		// be latched by a finding the agent was never shown.
		const edited = totalRetractionFixture("deploy.yaml");

		const { runtime, cacheManager } = newSession();
		const delivered = await edit(runtime, cacheManager, edited);

		// The per-edit surface is already silent (#2028 + #3189)…
		expect(delivered).not.toContain(DEAD_MARKER);
		// …so nothing may be stored for the turn-end surface either.
		expect(runtime.getInlineBlockersSnapshot()).toHaveLength(0);
		expect(runtime.gitGuardHasBlockers).toBe(false);
		expect(runtime.gitGuardSummary).toBe("");
	});

	it("serves no Unresolved section at turn end when every blocker cites a deleted sibling", async () => {
		// F1 at the delivery surface — the issue's acceptance criterion 1,
		// through the real turn-end path rather than a hand-built snapshot.
		const edited = totalRetractionFixture("turnend.yaml");

		const { runtime, cacheManager } = newSession();
		await edit(runtime, cacheManager, edited);
		const text = await turnEndText(runtime, cacheManager);

		expect(text).not.toContain("Unresolved from this turn");
		expect(text).not.toContain(DEAD_MARKER);
	});

	it("keeps only the surviving blocker in the record when one of two cites a deleted sibling", async () => {
		// F2: partial retraction. The record must agree with itself — summary,
		// sources and diagnostics all describe the survivor only (the three are
		// read together by #1561's retirement check).
		const edited = partialRetractionFixture("partial.yaml");

		const { runtime, cacheManager } = newSession();
		await edit(runtime, cacheManager, edited);

		const [record] = runtime.getInlineBlockersSnapshot();
		expect(record?.summary).toContain(LIVE_MARKER);
		expect(record?.summary).not.toContain(DEAD_MARKER);
		expect(record?.summary).toContain("1 issue(s)");
		expect(record?.sources).toEqual(["yamllint"]);
		expect(record?.diagnostics).toHaveLength(1);
		expect(runtime.gitGuardHasBlockers).toBe(true);
	});

	it("re-serves only the surviving blocker at turn end when one of two cites a deleted sibling", async () => {
		// F2 at the delivery surface — the issue's acceptance criterion 4.
		const edited = partialRetractionFixture("partial-turnend.yaml");

		const { runtime, cacheManager } = newSession();
		await edit(runtime, cacheManager, edited);
		const text = await turnEndText(runtime, cacheManager);

		expect(text).toContain("Unresolved from this turn");
		expect(text).toContain(LIVE_MARKER);
		expect(text).not.toContain(DEAD_MARKER);
	});

	it("re-serves the blocker unchanged when nothing is retracted", async () => {
		// F3: the gate must not over-reach. Nothing cited is missing, so the
		// stored summary is byte-identical to the dispatcher's own blockerOutput
		// and the turn-end surface behaves exactly as it does today.
		const edited = path.join(tmpDir, "src", "app.ts");
		fs.mkdirSync(path.dirname(edited), { recursive: true });
		fs.writeFileSync(edited, "const x = 1;\n");
		const blockers = [blockingDiagnostic(edited, 1, LIVE_MARKER, "lsp")];
		const dispatch = dispatchWith(blockers);
		vi.mocked(dispatchLintWithResult).mockResolvedValue(dispatch as never);

		const { runtime, cacheManager } = newSession();
		await edit(runtime, cacheManager, edited);

		const [record] = runtime.getInlineBlockersSnapshot();
		expect(record?.summary).toBe(dispatch.blockerOutput.trim());
		expect(record?.sources).toEqual(["lsp"]);
		expect(record?.lines).toEqual([1]);
		expect(runtime.gitGuardHasBlockers).toBe(true);

		const text = await turnEndText(runtime, cacheManager);
		expect(text).toContain("Unresolved from this turn");
		expect(text).toContain(LIVE_MARKER);
	});
});
