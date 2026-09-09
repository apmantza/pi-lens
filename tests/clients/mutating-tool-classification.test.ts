/**
 * #2423 — the inbound mutation-classification seam.
 *
 * The behavioral cases here deliberately import NO new module. They drive the
 * production entry points (`handleToolResult`, `handleToolCall`, `handleAgentEnd`)
 * with a third-party tool name and assert on real `CacheManager` /
 * `RuntimeCoordinator` state, so each one fails on an ASSERTION against pre-fix
 * code rather than on a missing import. The registry and mutation-proof cases
 * pull `clients/mutating-tool.js` through a dynamic import for the same reason.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { logReadGuardEvent } from "../../clients/read-guard-logger.js";
import { getTouchedLinesForGuard } from "../../clients/read-guard-tool-lines.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { hashlineFixture } from "../support/hashline-anchor-vectors.js";
import { assertNonEmptyScan, escapeRegExp } from "../support/sweep-kit.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/pipeline.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/pipeline.js")>();
	return { ...actual, runPipeline: vi.fn() };
});

vi.mock("../../clients/lsp/index.js", () => ({
	notifyExternalFileChange: vi.fn(async () => undefined),
}));

vi.mock("../../clients/read-guard-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/read-guard-logger.js")
	>()),
	logReadGuardEvent: vi.fn(),
}));

beforeEach(() => {
	vi.mocked(logReadGuardEvent).mockClear();
});

/**
 * The file the third-party tool edits, and the anchors its lines carry.
 *
 * Both come from the upstream-generated vector table, so `ANCHOR(2)` is the
 * anchor `pi-hashline-edit-pro` would actually print for line 2 of this exact
 * content — not a decimal line number (#2423 review round 1, finding F1).
 */
const FIXTURE = hashlineFixture("simple");
const SOURCE = FIXTURE.content;
const ANCHOR = FIXTURE.anchorFor;

async function stubPipeline(): Promise<void> {
	const { runPipeline } = await import("../../clients/pipeline.js");
	vi.mocked(runPipeline).mockResolvedValue({
		output: "",
		hasBlockers: false,
		isError: false,
		fileModified: false,
	} as never);
}

function toolResultDeps(args: {
	event: unknown;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
}): Parameters<typeof handleToolResult>[0] {
	return {
		event: args.event,
		getFlag: (name: string) => name === "no-lsp",
		dbg: () => {},
		runtime: args.runtime,
		cacheManager: args.cacheManager,
		biomeClient: {},
		ruffClient: {},
		metricsClient: {},
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as unknown as Parameters<typeof handleToolResult>[0];
}

/**
 * One `hashline-edit-pro` `replace` call, the exact shape the reporter's host
 * emits: no `details.diff`, two bare 3-char anchors, and a tool name pi-lens
 * has never heard of.
 */
function replaceEvent(
	filePath: string,
	toolCallId = "call-replace-1",
): Record<string, unknown> {
	return {
		toolName: "replace",
		toolCallId,
		input: {
			path: filePath,
			remove_from: ANCHOR(2),
			remove_to: ANCHOR(3),
			replacement_lines: ["const b = 20;", "const c = 30;"],
		},
		content: [{ type: "text", text: "replaced" }],
	};
}

/** One `hashline-edit-pro` `insert` call. */
function insertEvent(
	filePath: string,
	toolCallId = "call-insert-1",
): Record<string, unknown> {
	return {
		toolName: "insert",
		toolCallId,
		input: {
			path: filePath,
			anchor: ANCHOR(2),
			direction: "after",
			lines: ["const b2 = 22;"],
		},
		content: [{ type: "text", text: "inserted" }],
	};
}

/**
 * The tool_call half of one edit, exactly as `runtime-tool-call.ts` runs it
 * (`clients/runtime-tool-call.ts:1258`). This is where the anchors are resolved
 * — against the file BEFORE the edit lands — and the seam carries the ranges to
 * the tool_result by `toolCallId`.
 */
function runPreflight(event: Record<string, unknown>, filePath: string): void {
	getTouchedLinesForGuard(event, filePath, "s-2423", "corr-2423");
}

describe("#2423 acceptance 1 — a third-party edit reaches the bookkeeping chain", () => {
	it("records turn state and a change-log receipt for a `replace` tool_result", async () => {
		await stubPipeline();
		const env = setupTestEnvironment("pi-lens-2423-replace-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "replaced.ts");
			fs.writeFileSync(filePath, SOURCE);

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-2423-replace" });
			runtime.beginTurn();

			const event = replaceEvent(filePath, "call-acceptance-replace");
			runPreflight(event, filePath);
			await handleToolResult(toolResultDeps({ event, runtime, cacheManager }));

			const files = Object.keys(
				cacheManager.readTurnState(env.tmpDir).files ?? {},
			);
			expect(files.length).toBeGreaterThan(0);
			expect(files[0]).toContain("replaced.ts");

			// The adapter resolved remove_from/remove_to to lines 2-3, so the
			// recorded range is the tool's own, not a whole-file guess.
			const recorded = cacheManager.readTurnState(env.tmpDir).files[files[0]];
			expect(recorded.modifiedRanges).toEqual([{ start: 2, end: 3 }]);

			// The change log names the tool instead of collapsing onto agent-edit.
			expect(readChangesSince(env.tmpDir, 0)).toMatchObject([
				{ source: "agent-tool:replace", filePath },
			]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("queues a `replace` for the deferred pass and the agent_settled drain formats it", async () => {
		await stubPipeline();
		const env = setupTestEnvironment("pi-lens-2423-drain-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "drained.ts");
			fs.writeFileSync(filePath, SOURCE);

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-2423-drain" });
			runtime.beginTurn();

			const event = replaceEvent(filePath, "call-acceptance-drain");
			runPreflight(event, filePath);
			await handleToolResult(toolResultDeps({ event, runtime, cacheManager }));

			// Deferred, never immediate: an unknown edit-shaped tool takes the
			// safe timing.
			expect(runtime.pendingDeferredFormatCount).toBeGreaterThan(0);

			const formatted: string[] = [];
			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name: string) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager,
				getFormatService: () =>
					({
						recordRead: () => {},
						formatFile: async (fp: string) => {
							formatted.push(fp);
							return {
								filePath: fp,
								formatters: [],
								anyChanged: false,
								allSucceeded: true,
							};
						},
					}) as never,
			} as never);

			expect(formatted.map((fp) => path.resolve(fp))).toContain(
				path.resolve(filePath),
			);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("records an `insert` call at its anchor line", async () => {
		await stubPipeline();
		const env = setupTestEnvironment("pi-lens-2423-insert-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "inserted.ts");
			fs.writeFileSync(filePath, SOURCE);

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-2423-insert" });
			runtime.beginTurn();

			const event = insertEvent(filePath, "call-acceptance-insert");
			runPreflight(event, filePath);
			await handleToolResult(toolResultDeps({ event, runtime, cacheManager }));

			const state = cacheManager.readTurnState(env.tmpDir);
			const files = Object.keys(state.files ?? {});
			expect(files.length).toBeGreaterThan(0);
			expect(state.files[files[0]].modifiedRanges).toEqual([
				{ start: 2, end: 2 },
			]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("still ignores a tool that neither names nor shapes a mutation", async () => {
		await stubPipeline();
		const env = setupTestEnvironment("pi-lens-2423-negative-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "untouched.ts");
			fs.writeFileSync(filePath, SOURCE);

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-2423-negative" });
			runtime.beginTurn();

			await handleToolResult(
				toolResultDeps({
					event: {
						toolName: "some_reader",
						toolCallId: "call-reader-1",
						input: { path: filePath, query: "b" },
						content: [{ type: "text", text: "read" }],
					},
					runtime,
					cacheManager,
				}),
			);

			expect(
				Object.keys(cacheManager.readTurnState(env.tmpDir).files ?? {}),
			).toHaveLength(0);
			expect(runtime.pendingDeferredFormatCount).toBe(0);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("still records the file when no preflight resolved the anchors", async () => {
		// The read-guard preflight is where anchors get resolved, and it does not
		// run when the guard is off, when the tool_call was not observed, or when
		// the anchor has gone stale. The file still changed, so turn state must
		// still name it — an empty `files` map is the symptom #2423 reports. The
		// range degrades to the whole file rather than to nothing.
		await stubPipeline();
		const env = setupTestEnvironment("pi-lens-2423-nopreflight-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "unpreflighted.ts");
			fs.writeFileSync(filePath, SOURCE);

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-2423-nopreflight" });
			runtime.beginTurn();

			await handleToolResult(
				toolResultDeps({
					event: replaceEvent(filePath, "call-no-preflight"),
					runtime,
					cacheManager,
				}),
			);

			const state = cacheManager.readTurnState(env.tmpDir);
			const files = Object.keys(state.files ?? {});
			expect(files).toHaveLength(1);
			expect(state.files[files[0]].modifiedRanges).toEqual([
				{ start: 1, end: SOURCE.split("\n").length },
			]);
			expect(runtime.pendingDeferredFormatCount).toBeGreaterThan(0);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

// ── #2423 review round 1, finding F5 ────────────────────────────────────────
//
// The adapters ran twice per edit — once at tool_call with the file path, once
// again at tool_result with the same path — so every resolved edit logged two
// `touched_lines_detected` rows, and a shape the adapter refused logged an
// `edit_preflight_blocked` at tool_result for an edit nothing had blocked.

describe("#2423 adapter telemetry fires once, on the tool_call side", () => {
	it("logs exactly one touched_lines_detected across one edit's two halves", async () => {
		await stubPipeline();
		const env = setupTestEnvironment("pi-lens-2423-telemetry-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "logged.ts");
			fs.writeFileSync(filePath, SOURCE);

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-2423-telemetry" });
			runtime.beginTurn();

			const event = replaceEvent(filePath, "call-telemetry-1");
			runPreflight(event, filePath);
			await handleToolResult(toolResultDeps({ event, runtime, cacheManager }));

			const detected = vi
				.mocked(logReadGuardEvent)
				.mock.calls.filter(
					([entry]) =>
						entry.event === "touched_lines_detected" &&
						entry.metadata?.source === "hashline_pro_replace",
				);
			expect(detected).toHaveLength(1);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("logs no edit_preflight_blocked at tool_result when nothing blocked the edit", async () => {
		// No preflight ran (the guard is off), so nothing blocked anything. The
		// tool_result classification must not invent a blocking record.
		await stubPipeline();
		const env = setupTestEnvironment("pi-lens-2423-noblock-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "unblocked.ts");
			fs.writeFileSync(filePath, SOURCE);

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-2423-noblock" });
			runtime.beginTurn();

			await handleToolResult(
				toolResultDeps({
					event: {
						toolName: "hashline_edit",
						toolCallId: "call-noblock-1",
						input: {
							path: filePath,
							operations: [{ set_line: { anchor: "not-a-line" } }],
						},
						content: [{ type: "text", text: "edited" }],
					},
					runtime,
					cacheManager,
				}),
			);

			expect(logReadGuardEvent).not.toHaveBeenCalledWith(
				expect.objectContaining({ event: "edit_preflight_blocked" }),
			);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2423 — classification contract", () => {
	it("classifies pi's own tools from the built-in table", async () => {
		const { classifyMutatingTool } =
			await import("../../clients/mutating-tool.js");
		expect(
			classifyMutatingTool({ toolName: "write", input: { path: "/a.ts" } }),
		).toMatchObject({ kind: "write", provenance: "builtin", path: "/a.ts" });
		expect(
			classifyMutatingTool({ toolName: "edit", input: { path: "/a.ts" } }),
		).toMatchObject({ kind: "edit", provenance: "builtin" });
		expect(
			classifyMutatingTool({ toolName: "read", input: { path: "/a.ts" } }),
		).toBeUndefined();
	});

	it("marks a bash-derived synthetic write with its own provenance", async () => {
		const { classifyMutatingTool, PI_LENS_SYNTHETIC_MUTATION_FIELD } =
			await import("../../clients/mutating-tool.js");
		expect(
			classifyMutatingTool({
				toolName: "write",
				input: { path: "/a.ts" },
				[PI_LENS_SYNTHETIC_MUTATION_FIELD]: "bash",
			}),
		).toMatchObject({ kind: "write", provenance: "bash-derived" });
	});

	it("keeps the adapter order deterministic and first-match-wins", async () => {
		const { MUTATION_SHAPE_ADAPTERS } =
			await import("../../clients/mutating-tool.js");
		expect(MUTATION_SHAPE_ADAPTERS.map((a) => a.name)).toEqual([
			"hashline-readmap",
			"hashline-edit-pro",
		]);
	});

	// Mutation proof for the registry: each adapter owns a case that goes red if
	// its entry is deleted, because no other adapter recognizes that shape.
	it("resolves the hashline-readmap shape (red if that adapter is removed)", async () => {
		const { classifyMutatingTool } =
			await import("../../clients/mutating-tool.js");
		expect(
			classifyMutatingTool({
				toolName: "hashline_edit",
				input: {
					path: "/a.ts",
					replace_lines: { start_anchor: "4: x", end_anchor: "7: y" },
				},
			}),
		).toMatchObject({
			kind: "edit",
			source: "hashline-readmap",
			touchedLines: [4, 7],
			provenance: "declared",
		});
	});

	it("resolves the hashline-edit-pro shape (red if that adapter is removed)", async () => {
		const { classifyMutatingTool } =
			await import("../../clients/mutating-tool.js");
		const env = setupTestEnvironment("pi-lens-2423-registry-pro-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, SOURCE);
			expect(
				classifyMutatingTool(
					{
						toolName: "replace",
						input: {
							path: filePath,
							remove_from: ANCHOR(1),
							remove_to: ANCHOR(3),
							replacement_lines: ["x"],
						},
					},
					{ filePath },
				),
			).toMatchObject({
				kind: "edit",
				source: "hashline-edit-pro",
				touchedLines: [1, 3],
				provenance: "declared",
			});
		} finally {
			env.cleanup();
		}
	});

	it("reports — never blocks — when an edit-pro anchor does not resolve", async () => {
		const { classifyMutatingTool } =
			await import("../../clients/mutating-tool.js");
		const env = setupTestEnvironment("pi-lens-2423-registry-stale-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, SOURCE);
			const unresolved = classifyMutatingTool(
				{
					toolName: "replace",
					input: {
						path: filePath,
						remove_from: "zZ9",
						remove_to: ANCHOR(3),
						replacement_lines: ["x"],
					},
				},
				{ filePath },
			);
			// Still a classified mutation — the file changed and the bookkeeping
			// chain must still run.
			expect(unresolved).toMatchObject({
				kind: "edit",
				source: "hashline-edit-pro",
				provenance: "declared",
			});
			expect(unresolved?.touchedLines).toBeUndefined();
			expect(unresolved?.preflightError).toBeUndefined();
			expect(unresolved?.unresolvedReason).toBe("remove_from:anchor_not_found");
		} finally {
			env.cleanup();
		}
	});

	it("does not claim a shape it cannot positively identify (F2)", async () => {
		const { classifyMutatingTool } =
			await import("../../clients/mutating-tool.js");
		// An unrelated tool that happens to carry an `operations` array.
		expect(
			classifyMutatingTool({
				toolName: "run_migrations",
				input: { path: "/a.ts", operations: [{ name: "backfill" }] },
			}),
		).toBeUndefined();
		// A navigation tool that happens to carry `anchor` + `direction`.
		expect(
			classifyMutatingTool({
				toolName: "scroll_to",
				input: { path: "/a.ts", anchor: "aB3", direction: "after" },
			}),
		).toBeUndefined();
		// `remove_from` without the `replacement_lines` the schema requires.
		expect(
			classifyMutatingTool({
				toolName: "replace",
				input: { path: "/a.ts", remove_from: "aB3", remove_to: "cD4" },
			}),
		).toBeUndefined();
		// Positive control: the same shape WITH the required field is claimed.
		expect(
			classifyMutatingTool({
				toolName: "replace",
				input: {
					path: "/a.ts",
					remove_from: "aB3",
					remove_to: "cD4",
					replacement_lines: [],
				},
			}),
		).toMatchObject({ source: "hashline-edit-pro", kind: "edit" });
	});

	it("carries the tool_call ranges to the tool_result by toolCallId", async () => {
		// At tool_result the edit has landed, so the anchors no longer address
		// the lines they named. The seam reuses what the tool_call resolved
		// rather than re-resolving against rewritten content.
		const { classifyMutatingTool, _resetMutationRangeCarryForTests } =
			await import("../../clients/mutating-tool.js");
		_resetMutationRangeCarryForTests();
		const env = setupTestEnvironment("pi-lens-2423-carry-");
		try {
			const filePath = path.join(env.tmpDir, "a.ts");
			fs.writeFileSync(filePath, SOURCE);
			const event = {
				toolName: "replace",
				toolCallId: "call-carry-1",
				input: {
					path: filePath,
					remove_from: ANCHOR(2),
					remove_to: ANCHOR(3),
					replacement_lines: ["x"],
				},
			};
			expect(classifyMutatingTool(event, { filePath })?.touchedLines).toEqual([
				2, 3,
			]);

			// The edit lands: the anchored lines are gone.
			fs.writeFileSync(filePath, "const a = 1;\nconst z = 9;\n");
			expect(
				classifyMutatingTool(event, { filePath, recognizeOnly: true })
					?.touchedLines,
			).toEqual([2, 3]);

			// A different call id gets nothing — the carry is per tool call, not
			// a global "last resolved range".
			expect(
				classifyMutatingTool(
					{ ...event, toolCallId: "call-carry-other" },
					{ filePath, recognizeOnly: true },
				)?.touchedLines,
			).toBeUndefined();
		} finally {
			env.cleanup();
		}
	});

	it("has no dead `multiedit` entry left in the mutating-tool table", async () => {
		const { getBuiltinMutatingToolNames, isMutatingToolName } =
			await import("../../clients/mutating-tool.js");
		expect(getBuiltinMutatingToolNames().sort()).toEqual(["edit", "write"]);
		expect(isMutatingToolName("multiedit")).toBe(false);
	});
});

// ── Grep guard ──────────────────────────────────────────────────────────────
//
// The seam only holds if it stays the single decision point. This walks
// `clients/` and fails when a mutation decision is made by comparing a tool
// name to the `"write"` / `"edit"` literals anywhere else.

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLIENTS_DIR = path.join(REPO_ROOT, "clients");
const SEAM_FILE = path.join(CLIENTS_DIR, "mutating-tool.ts");

/**
 * What the guard walks. `index.ts` and `tools/` were added in review round 1
 * (finding F4): `index.ts:2344` compared `rtToolName` to the two literals to
 * gate the `tool_result_received` latency marker — a sixteenth site the sweep
 * missed twice over, because the walk stopped at `clients/` AND because the
 * variable was named `rtToolName`, which the old `toolName === "…"` pattern did
 * not match.
 */
const SCAN_ROOTS = [CLIENTS_DIR, path.join(REPO_ROOT, "tools")];
const SCAN_FILES = [path.join(REPO_ROOT, "index.ts")];

/**
 * The class sweep's declared exclusions: files that legitimately carry a
 * `"write"` / `"edit"` literal. They are NOT skipped by the walk — they are
 * listed so the reason is auditable, and the case below proves each one holds
 * only the declared form, so a real comparison appearing in any of them would
 * still be an offender.
 *
 * `scripts/run-harness.mjs` is the third declared exclusion: an offline
 * transcript-analysis script producing per-tool statistics (`writeCallCount`,
 * `editCallCount`, …), not a pipeline mutation decision, and as untyped `.mjs`
 * outside the tsc surface it cannot import the seam without a sibling `.d.mts`.
 * It is absent from this list because the walk is TypeScript-only.
 */
const DECLARED_EXCLUSIONS: Array<{ file: string; reason: string }> = [
	{
		file: path.join(CLIENTS_DIR, "format-events-publish.ts"),
		reason:
			'published v1 bus payload: `tool: "write" | "edit"` is the DECLARED type of pilens:format:queued, pinned by tests/config/files-touched-bus-conformance.test.ts. Widening it is #2421.',
	},
];

function walkTypeScript(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkTypeScript(full, out);
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
			out.push(full);
	}
	return out;
}

/**
 * Every way the codebase has actually spelled "is this the write or edit tool".
 *
 * `!==` is the form the ORIGINAL gate on master used
 * (`if (event.toolName !== "write" && event.toolName !== "edit") return;`), and
 * the first cut of this guard matched only `===` — so the exact shape the seam
 * replaced could have been reintroduced without a red (review round 1, finding
 * F3). The leading `\w*` catches a renamed local like `rtToolName`.
 */
const LITERAL_COMPARISONS = [
	/\w*[Tt]oolName\s*[=!]==?\s*"(?:write|edit|multiedit)"/,
	/"(?:write|edit|multiedit)"\s*[=!]==?\s*\w*[Tt]oolName\b/,
	/isToolCallEventType\(\s*"(?:write|edit|multiedit)"/,
	/isToolCallEventType\(\s*[A-Za-z_$][\w$]*\s*,\s*"(?:write|edit|multiedit)"/,
];

/**
 * Review round 3, finding F2. Three forms the line-at-a-time comparison regexes
 * above cannot see, all of them decisions the seam is supposed to own:
 *
 * 1. `switch (event.toolName) { case "write": … }` — the subject never sits
 *    next to a literal, so no comparison regex fires. Flagged on the SUBJECT:
 *    any `switch` over an expression ending in `.toolName` is branching on the
 *    tool name, and that belongs in `classifyMutatingTool`.
 * 2. `["write", "edit"].includes(name)` / `new Set(["write","edit"]).has(name)`
 *    — a membership test against a literal set of mutation tool names. The
 *    array must contain ONLY those literals, so `["edit", "command"]`
 *    (`clients/lsp/client.ts`, an LSP `resolveSupport` capability list) is not
 *    an offender.
 * 3. `const t = event.toolName; … if (t !== "write")` — an alias whose name
 *    carries no `toolName` substring. Handled as a two-pass file-scoped read:
 *    collect the alias names declared from a `.toolName` expression, then look
 *    for those names compared to the literals.
 *
 * KNOWN LIMITATION: pass 3 is file-scoped, not scope-aware. An alias assigned
 * in one function and compared in another IS caught (the passes share a file),
 * but an alias that crosses a FILE boundary — `export const t = e.toolName` in
 * one module, compared in another — is not, and neither is one laundered
 * through a helper (`nameOf(event) === "write"`). Those need a type-aware pass;
 * the guard is a tripwire for the shapes the codebase has actually written,
 * and `deps-centralization` plus review are the backstop for the rest.
 */
const SWITCH_ON_TOOL_NAME = /\bswitch\s*\(\s*[^)]*\.toolName\s*\)/;

const MUTATION_LITERAL_SET_MEMBERSHIP =
	/\[\s*"(?:write|edit|multiedit)"(?:\s*,\s*"(?:write|edit|multiedit)")*\s*,?\s*\](?:\s*as\s+const)?\s*\)?\s*\.\s*(?:includes|has)\s*\(/;

const TOOL_NAME_ALIAS_DECL =
	/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.toolName\b/g;

/** Aliases declared from a `.toolName` expression anywhere in one file. */
function collectToolNameAliases(source: string): string[] {
	const names = new Set<string>();
	for (const match of source.matchAll(TOOL_NAME_ALIAS_DECL)) {
		const name = match[1];
		// `toolName`-shaped names are already covered by LITERAL_COMPARISONS;
		// keeping them costs nothing and keeps the pass honest if that changes.
		if (name) names.add(name);
	}
	return [...names];
}

function aliasComparisonPatterns(aliases: string[]): RegExp[] {
	return aliases.flatMap((raw) => {
		const name = escapeRegExp(raw);
		return [
			new RegExp(`\\b${name}\\s*[=!]==?\\s*"(?:write|edit|multiedit)"`),
			new RegExp(`"(?:write|edit|multiedit)"\\s*[=!]==?\\s*${name}\\b`),
		];
	});
}

/** Every offending line in one file's source, as `line-number: text`. */
function findMutationLiteralOffenders(
	source: string,
): Array<{ line: number; text: string }> {
	const patterns = [
		...LITERAL_COMPARISONS,
		SWITCH_ON_TOOL_NAME,
		MUTATION_LITERAL_SET_MEMBERSHIP,
		...aliasComparisonPatterns(collectToolNameAliases(source)),
	];
	const offenders: Array<{ line: number; text: string }> = [];
	source.split("\n").forEach((text, index) => {
		if (patterns.some((re) => re.test(text)))
			offenders.push({ line: index + 1, text: text.trim() });
	});
	return offenders;
}

describe("#2423 grep guard — the seam is the only mutation decision point", () => {
	it("keeps every declared exclusion a declaration, not a comparison", () => {
		expect(DECLARED_EXCLUSIONS.length).toBeGreaterThan(0);
		for (const { file, reason } of DECLARED_EXCLUSIONS) {
			expect(fs.existsSync(file), `${file}: ${reason}`).toBe(true);
			const hits = findMutationLiteralOffenders(
				fs.readFileSync(file, "utf8"),
			).map((hit) => `${hit.line}: ${hit.text}`);
			expect(hits, `${file}: ${reason}`).toEqual([]);
		}
	});

	it("finds no tool-name literal comparison outside clients/mutating-tool.ts", () => {
		const files = [
			...SCAN_ROOTS.flatMap((root) => walkTypeScript(root)),
			...SCAN_FILES,
		];
		// Non-empty scan floor: a walker that silently found nothing would make
		// this suite pass for the wrong reason. `clients/` alone held well over
		// 200 TypeScript files when this floor was set on 2026-09-02.
		assertNonEmptyScan("#2423 mutation-literal grep guard", files.length, 150);
		// The two roots added in review round 1 must actually contribute.
		expect(files).toContain(path.join(REPO_ROOT, "index.ts"));
		expect(
			files.some((file) => file.startsWith(path.join(REPO_ROOT, "tools"))),
		).toBe(true);

		const offenders: string[] = [];
		for (const file of files) {
			if (path.resolve(file) === SEAM_FILE) continue;
			for (const hit of findMutationLiteralOffenders(
				fs.readFileSync(file, "utf8"),
			)) {
				offenders.push(
					`${path.relative(REPO_ROOT, file)}:${hit.line}: ${hit.text}`,
				);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("still detects an offender when one exists (the guard is not vacuous)", () => {
		const offenders = [
			'\tif (event.toolName === "edit") return 1;',
			// The master gate the seam replaced.
			'\tif (event.toolName !== "write" && event.toolName !== "edit") return;',
			'\tif (toolName != "edit") return;',
			'\tif (toolName == "write") return;',
			// The renamed local that hid index.ts:2344 from the first sweep.
			'\t\tif (rtToolName === "edit" || rtToolName === "write") {',
			'\tif ("write" === toolName) return;',
			'\tif (isToolCallEventType("write", event as any)) {',
			// Review round 3 (F2), the three probes the line regexes missed.
			'\tconst t = event.toolName;\n\tif (t !== "write") return;',
			'\tswitch (event.toolName) {\n\t\tcase "write":\n\t\t\treturn 1;\n\t}',
			'\tif (["write", "edit"].includes(name)) return 1;',
			// …and their near neighbours, so the new rules are not one-shape wide.
			'\tlet name = (event as ToolEvent).toolName;\n\tif ("edit" === name) return;',
			'\tswitch (deps.event.toolName) {\n\t\tcase "multiedit":\n\t\t\treturn 1;\n\t}',
			'\tif (new Set(["write", "edit", "multiedit"]).has(name)) return 1;',
		];
		for (const sample of offenders) {
			expect(findMutationLiteralOffenders(sample), sample).not.toEqual([]);
		}
		const allowed = [
			'\tif (toolName === "lsp_navigation") return 1;',
			'\tif (mutation.kind === "write") return 1;',
			'\ttool: "write" | "edit";',
			// A capability list that merely CONTAINS "edit" is not a mutation set.
			'\t\t\tresolveSupport: { properties: ["edit", "command"] },',
			// An alias off a `.toolName` expression that is never compared to a
			// mutation literal must not trip pass 3.
			"\tconst label = event.toolName;\n\tdbg(`tool=${label}`);",
			// A switch on something else entirely.
			'\tswitch (mutation.kind) {\n\t\tcase "write":\n\t\t\treturn 1;\n\t}',
		];
		for (const sample of allowed) {
			expect(findMutationLiteralOffenders(sample), sample).toEqual([]);
		}
	});
});
