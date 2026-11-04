/**
 * #3246 — the turn-end "Unresolved from this turn" blocker honors a
 * `lens_diagnostic_mark` made AFTER the record was written.
 *
 * The reported defect: `runtime-tool-result.ts` stored the pipeline's
 * already-RENDERED blocker string, and `runtime-turn.ts` pushed it verbatim at
 * every later turn end. A `false-positive` mark reached the durable store, the
 * widget, `lens_diagnostics`, the cached scanner lanes, late auxiliary and
 * cascade — and never this surface, so the marked blocker came back on every
 * turn, including turns that edited only an unrelated file.
 *
 * Every case below drives the REAL seams: the in-process `RuntimeCoordinator`
 * and `CacheManager`, the durable `markDisposition` store on disk, the real
 * `handleTurnEnd`, and `consumeTurnEndFindings` — the same two calls
 * `index.ts`'s `turn_end` and `clients/mcp/session.ts` make. Nothing about the
 * store, the coordinator or the composer is faked.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logLatency = vi.hoisted(() => vi.fn());
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return { ...actual, logLatency };
});

import { CacheManager } from "../../clients/cache-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	_resetStateCacheForTests,
	markDisposition,
} from "../../clients/diagnostic-dispositions.js";
import type { Diagnostic } from "../../clients/dispatch/types.js";
import { formatDiagnostics } from "../../clients/dispatch/utils/format-utils.js";
import { consumeTurnEndFindings } from "../../clients/runtime-context.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import {
	cancelLSPIdleReset,
	handleTurnEnd,
} from "../../clients/runtime-turn.js";
import { setupTestEnvironment } from "./test-utils.js";

const SESSION_ID = "inline-blocker-disposition-session";

const EMPTY_KNIP_RESULT = {
	success: true,
	issues: [],
	unusedExports: [],
	unusedFiles: [],
	unusedDeps: [],
	unlistedDeps: [],
	summary: "skipped",
};

function makeTurnEndDeps(
	runtime: RuntimeCoordinator,
	cacheManager: CacheManager,
	cwd: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		ctxCwd: cwd,
		getFlag: () => false,
		dbg: () => {},
		runtime,
		cacheManager,
		knipClient: {
			ensureAvailable: async () => false,
			analyze: async () => EMPTY_KNIP_RESULT,
		},
		deadCodeClients: [],
		depChecker: { ensureAvailable: async () => false },
		testRunnerClient: { getTestRunTarget: () => null },
		resetLSPService: () => {},
		resetFormatService: () => {},
		...overrides,
		// biome-ignore lint/suspicious/noExplicitAny: the dep surface is a dozen
		// client interfaces; these tests state only what they exercise.
	} as any;
}

/**
 * A blocking dispatch diagnostic, shaped as the runners emit it.
 *
 * `tool: "ast-grep"` rather than `"lsp"` on purpose: the freshness sweep's
 * dependency-drift axis only walks forward imports for an ALL-`lsp` record
 * (`blocker-freshness.ts` `isAllLspSourced`), so an `ast-grep` security-rule
 * blocker isolates the disposition axis these cases are about from the import
 * axis they are not.
 */
function blockingDiagnostic(
	filePath: string,
	line: number,
	message: string,
	over: Partial<Diagnostic> = {},
): Diagnostic {
	return {
		id: `ast-grep:${path.basename(filePath)}:${line}`,
		message,
		filePath,
		line,
		severity: "error",
		semantic: "blocking",
		tool: "ast-grep",
		rule: "no-eval",
		...over,
	};
}

/**
 * The EXACT expression `clients/dispatch/dispatcher.ts` renders
 * `DispatchResult.blockerOutput` with (`formatDiagnostics(inlineBlockers,
 * "blocking")`), plus the `.trim()` `pipeline.ts` applies before it becomes
 * `PipelineResult.inlineBlockerSummary`. Using the production renderer here is
 * what makes the record's `summary` and its `diagnostics` agree the way they
 * agree in production — a hand-typed summary would leave the axis under test
 * (summary re-derived from structure) untested.
 */
function renderBlockers(diagnostics: Diagnostic[]): string {
	return formatDiagnostics(diagnostics, "blocking").trim();
}

/**
 * Record an inline blocker the way `runtime-tool-result.ts` records one from a
 * `PipelineResult`: every field derived from the same `dispatchResult.blockers`
 * array the summary was rendered from, exactly as `pipeline.ts` derives them.
 */
function recordBlockers(
	runtime: RuntimeCoordinator,
	filePath: string,
	diagnostics: Diagnostic[],
	options: { structured?: boolean } = {},
): void {
	const bytes = fs.readFileSync(filePath);
	runtime.recordInlineBlockers(
		filePath,
		renderBlockers(diagnostics),
		runtime.nextWriteIndex(),
		[...new Set(diagnostics.map((d) => d.tool))],
		diagnostics
			.filter((d) => path.resolve(d.filePath) === path.resolve(filePath))
			.map((d) => d.line)
			.filter((line): line is number => typeof line === "number"),
		{
			size: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		},
		options.structured === false ? undefined : diagnostics,
	);
}

/**
 * Mark a blocker `false-positive` through the real durable store, with the
 * identity `lens_diagnostic_mark` would derive.
 *
 * `spelling: "bare"` is the mark an agent makes from THIS surface's own
 * rendering: the unresolved-blocker body prints `  L<n>: <message>` and names
 * neither the tool nor the rule, and both `lens_diagnostic_mark` parameters are
 * optional. `"canonical"` is the same finding marked from the widget or
 * `lens_diagnostics mode=full`, which do print the pair.
 */
function markFalsePositive(
	cwd: string,
	diagnostic: Diagnostic,
	spelling: "canonical" | "bare" = "canonical",
): void {
	markDisposition(
		cwd,
		{
			cwd,
			filePath: diagnostic.filePath,
			...(spelling === "canonical"
				? { tool: diagnostic.tool, rule: diagnostic.rule }
				: {}),
			message: diagnostic.message,
			line: diagnostic.line,
			content: fs.readFileSync(diagnostic.filePath, "utf8"),
		},
		"false-positive",
	);
}

function registerEdit(
	cacheManager: CacheManager,
	cwd: string,
	filePath: string,
	owner = SESSION_ID,
	source?: "mcp",
): void {
	// handleTurnEnd short-circuits when no file was touched this turn; an
	// OWNERLESS worklist is a shape production never writes (#2504).
	cacheManager.addModifiedRange(
		filePath,
		{ start: 1, end: 1 },
		false,
		cwd,
		owner,
		source,
	);
}

/**
 * What a request inside one prompt reads at this turn end — "" when it says
 * nothing. #5240: an unchanged set stays staged as a repeat for the next
 * prompt's first request, so "not handed again" is read mid-prompt.
 */
function turnEndText(
	cacheManager: CacheManager,
	cwd: string,
	runtime: RuntimeCoordinator,
): string {
	return (
		consumeTurnEndFindings(cacheManager, cwd, runtime, undefined, undefined, {
			atPromptTail: false,
			blockersLive: true,
		})?.messages?.[0]?.content ?? ""
	);
}

function inlinePolicyRows(): Array<Record<string, unknown>> {
	return logLatency.mock.calls
		.map(([entry]) => entry)
		.filter((entry) => entry?.phase === "inline_blocker_policy");
}

afterEach(() => {
	cancelLSPIdleReset();
	resetDegradationLedger();
	_resetStateCacheForTests();
	logLatency.mockClear();
	vi.useRealTimers();
});

describe("turn-end unresolved inline blockers honor dispositions (#3246)", () => {
	it("drops a blocker marked false-positive with no further edit of the file", async () => {
		const env = setupTestEnvironment("pi-lens-3246-mark-all-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "lib", "portfolio.py");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "eval(user_input)\nreturn 1\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(
				filePath,
				1,
				"Call without try/except",
			);
			recordBlockers(runtime, filePath, [diagnostic]);
			markFalsePositive(cwd, diagnostic);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			const text = turnEndText(cacheManager, cwd, runtime);

			expect(text).not.toContain("Unresolved from this turn");
			expect(text).not.toContain("🔴 STOP");
			expect(text).not.toContain("Call without try/except");
		} finally {
			env.cleanup();
		}
	});

	it("honors a mark made from the inline surface's own rendering, which names no tool or rule", async () => {
		// #3088's non-convergence shape: the unresolved-blocker body renders
		// `  L1: <message>` only, so a mark made from it carries neither `tool`
		// nor `rule`. Honoring only the canonical spelling would leave the very
		// surface #3246 reports unfixable from its own output.
		const env = setupTestEnvironment("pi-lens-3246-bare-identity-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "app.ts");
			fs.writeFileSync(filePath, "eval(input);\nexport const x = 1;\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(filePath, 1, "eval() is banned");
			recordBlockers(runtime, filePath, [diagnostic]);
			markFalsePositive(cwd, diagnostic, "bare");

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(turnEndText(cacheManager, cwd, runtime)).toBe("");
		} finally {
			env.cleanup();
		}
	});

	it("keeps the unmarked two of four across a later turn that edits only an unrelated file", async () => {
		const env = setupTestEnvironment("pi-lens-3246-two-of-four-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "src", "pay.ts");
			const unrelated = path.join(cwd, "README.md");
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(
				filePath,
				["one();", "two();", "three();", "four();", ""].join("\n"),
			);
			fs.writeFileSync(unrelated, "# readme\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			const diagnostics = [1, 2, 3, 4].map((line) =>
				blockingDiagnostic(filePath, line, `finding ${line}`),
			);
			recordBlockers(runtime, filePath, diagnostics);
			markFalsePositive(cwd, diagnostics[0]);
			markFalsePositive(cwd, diagnostics[2]);

			runtime.beginTurn();
			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			const first = turnEndText(cacheManager, cwd, runtime);
			expect(first).toContain("L2: finding 2");
			expect(first).toContain("L4: finding 4");
			expect(first).not.toContain("finding 1");
			expect(first).not.toContain("finding 3");
			expect(first).toContain("🔴 STOP — 2 issue(s) must be fixed");
			expect(first).toContain("suppressed by disposition: 2 finding(s)");

			// The next turn touches only the unrelated file — the exact shape the
			// report describes ("it came back on a turn I never touched it").
			// #4921: the unmarked two are the same two, already delivered, so the
			// turn does not hand them to the agent again (it used to, because the
			// duplicate key held the touched-file set).
			runtime.beginTurn();
			registerEdit(cacheManager, cwd, unrelated);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			expect(turnEndText(cacheManager, cwd, runtime)).toBe("");

			// They are still held, not dropped: marking one more changes the set,
			// and the next unrelated-file turn delivers the remaining one alone.
			markFalsePositive(cwd, diagnostics[1]);
			runtime.beginTurn();
			registerEdit(cacheManager, cwd, unrelated);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			const third = turnEndText(cacheManager, cwd, runtime);
			expect(third).toContain("L4: finding 4");
			expect(third).not.toContain("finding 1");
			expect(third).not.toContain("finding 2");
			expect(third).not.toContain("finding 3");
		} finally {
			env.cleanup();
		}
	});

	it("emits neither Unresolved nor 🔴 STOP when every blocker is marked, and still counts the suppression once per turn", async () => {
		const env = setupTestEnvironment("pi-lens-3246-empty-survivors-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "a.ts");
			fs.writeFileSync(filePath, "alpha();\nbeta();\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			const diagnostics = [
				blockingDiagnostic(filePath, 1, "alpha is unsafe"),
				blockingDiagnostic(filePath, 2, "beta is unsafe"),
			];
			recordBlockers(runtime, filePath, diagnostics);
			for (const diagnostic of diagnostics) markFalsePositive(cwd, diagnostic);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).not.toContain("Unresolved from this turn");
			expect(text).not.toContain("🔴 STOP");
			// Silent to the agent, countable to a reader: ONE bounded row for the
			// whole turn, never one per finding.
			const rows = inlinePolicyRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.metadata).toMatchObject({
				records: 1,
				// A live record, not one the freshness gates demoted — the policy
				// ran on it, so it is counted as a candidate set, not as stale.
				stale: 0,
				candidates: 2,
				kept: 0,
				dispositionSuppressed: 2,
				unstructured: 0,
			});
			const metadata = rows[0]?.metadata as {
				files: string[];
				tools: string[];
			};
			expect(metadata.files).toEqual(["a.ts"]);
			expect(metadata.tools).toEqual(["ast-grep"]);
		} finally {
			env.cleanup();
		}
	});

	it("applies the policy before the display cap, so a marked finding never occupies a display slot", async () => {
		// Filtering AFTER `formatDiagnostics`' 10-row cap would spend a slot on
		// the marked finding and hide an unmarked one behind "... and N more".
		const env = setupTestEnvironment("pi-lens-3246-cap-order-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "wide.ts");
			fs.writeFileSync(
				filePath,
				Array.from({ length: 12 }, (_, i) => `line${i + 1}();`).join("\n") +
					"\n",
			);

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			const diagnostics = Array.from({ length: 12 }, (_, i) =>
				blockingDiagnostic(filePath, i + 1, `issue ${i + 1}`),
			);
			recordBlockers(runtime, filePath, diagnostics);
			// The LAST finding — beyond the cap's window — is the marked one.
			markFalsePositive(cwd, diagnostics[11]);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("🔴 STOP — 11 issue(s) must be fixed");
			expect(text).toContain("... and 1 more");
			expect(text).not.toContain("issue 12");
		} finally {
			env.cleanup();
		}
	});

	it("re-renders an unmarked record byte-identically to the dispatcher's own blocker output", async () => {
		// The fix re-derives the body instead of replaying the stored string, so
		// the renderer it uses must be the dispatcher's, not a second one that
		// can drift from it.
		const env = setupTestEnvironment("pi-lens-3246-identical-render-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "same.ts");
			fs.writeFileSync(filePath, "one();\ntwo();\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			const diagnostics = [
				blockingDiagnostic(filePath, 1, "first", {
					fixSuggestion: "delete the call",
				}),
				blockingDiagnostic(filePath, 2, "second"),
			];
			recordBlockers(runtime, filePath, diagnostics);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(turnEndText(cacheManager, cwd, runtime)).toContain(
				`Unresolved from this turn — same.ts:\n${renderBlockers(diagnostics)}`,
			);
		} finally {
			env.cleanup();
		}
	});

	it("does not follow changed bytes: a mark made against the old line never suppresses the rewritten one", async () => {
		// Preservation guard. The strict anchor binds the flagged line's CONTENT,
		// so it must be re-derived from the file's CURRENT bytes; re-deriving it
		// from the bytes recorded at verdict time would let a stale mark hide a
		// finding about code the agent has since changed. The record itself is
		// demoted by the #2982 self-drift gate, so no original authoritative line
		// is replayed either.
		const env = setupTestEnvironment("pi-lens-3246-changed-bytes-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "drift.ts");
			fs.writeFileSync(filePath, "alpha();\nbeta();\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
			recordBlockers(runtime, filePath, [diagnostic]);
			markFalsePositive(cwd, diagnostic);

			// Same line COUNT and same byte length, different bytes — the shape the
			// size tier cannot see and the hash tier can.
			fs.writeFileSync(filePath, "gamma();\nbeta();\n");
			const later = new Date(Date.now() + 60_000);
			fs.utimesSync(filePath, later, later);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).not.toContain("Unresolved from this turn");
			expect(text).toContain("alpha is unsafe");
			expect(text).toContain("stale");
			// #4990: the demoted arm runs the same policy pass as the live one, so the
			// stale record now contributes its candidate (which the stale mark did
			// NOT suppress, because it was anchored to the old line's bytes).
			expect(inlinePolicyRows()[0]?.metadata).toMatchObject({
				records: 1,
				stale: 1,
				candidates: 1,
				kept: 1,
				dispositionSuppressed: 0,
			});
		} finally {
			env.cleanup();
		}
	});

	it("a dependency-drift demotion honours a mark whose bytes still match (#4990)", async () => {
		// #4990 reverses the review-round-2 rule this case used to pin. That rule
		// left the demoted arm outside the policy, reasoning that suppressing an
		// advisory turns "unconfirmed" into silence. The report shows the cost:
		// the agent had already judged the finding, and the one surface that kept
		// re-serving it ignored that decision on every turn end. A stored mark is
		// the agent's decision about the FINDING, not a claim that the bytes are
		// clean; the same stack the live arm runs now decides the demoted arm's
		// body too, and the delivery cap still bounds a record that is never
		// marked.
		//
		// The demotion here is the REAL sweep's: a forward import drifts on disk
		// after the verdict, with the target's own bytes untouched — so the
		// strict anchor still matches and the mark is genuinely applicable.
		const env = setupTestEnvironment("pi-lens-3246-dependency-drift-");
		try {
			const cwd = env.tmpDir;
			const dep = path.join(cwd, "dep.js");
			const consumer = path.join(cwd, "consumer.js");
			fs.writeFileSync(dep, "export const other = 1;\n");
			fs.writeFileSync(
				consumer,
				'import { other } from "./dep.js";\nexport const t = other;\n',
			);

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(consumer, 1, "unresolved import", {
				tool: "lsp",
				rule: "ts:2307",
			});
			recordBlockers(runtime, consumer, [diagnostic]);
			markFalsePositive(cwd, diagnostic);

			// The dependency drifts out-of-band after the verdict; the target's
			// own bytes are untouched.
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(dep, future, future);

			registerEdit(cacheManager, cwd, consumer);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).not.toContain("[stale — re-run to confirm]");
			expect(text).not.toContain("unresolved import");
			expect(text).not.toContain("Unresolved from this turn");
			// Countable, not silent: the stale record offers its candidate and the
			// mark removes it. A fully suppressed record leaves the commit gate, as
			// every other fully suppressed record does (#3248).
			expect(inlinePolicyRows()[0]?.metadata).toMatchObject({
				records: 1,
				stale: 1,
				candidates: 1,
				kept: 0,
				dispositionSuppressed: 1,
			});
			const snapshot = runtime.getInlineBlockersSnapshot();
			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]?.staleReason).toBe("dependency-drift");
			expect(snapshot[0]?.policySuppressed).toBe(true);
			expect(runtime.gitGuardHasBlockers).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("fails open when the file's current bytes cannot be read", async () => {
		// AGENTS.md shape 48: a blocking finding is never hidden over an I/O
		// error. The record survives the existence reconcile (the path exists),
		// but reading it throws — the strict anchor then hashes an empty line and
		// cannot match the mark.
		const env = setupTestEnvironment("pi-lens-3246-unreadable-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "unreadable.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
			recordBlockers(runtime, filePath, [diagnostic]);
			markFalsePositive(cwd, diagnostic);

			// Replace the file with a directory at the same path: it still exists,
			// so the record is live, but every read of it fails (EISDIR).
			fs.rmSync(filePath);
			fs.mkdirSync(filePath);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(turnEndText(cacheManager, cwd, runtime)).toContain(
				"alpha is unsafe",
			);
		} finally {
			env.cleanup();
		}
	});

	it("re-serves a legacy string-only record verbatim and records one bounded degradation", async () => {
		// Every production writer pairs the summary with its diagnostics; a
		// record without them can only fail open, and that gap has to be
		// countable rather than silent (AGENTS.md shapes 13/17).
		const env = setupTestEnvironment("pi-lens-3246-legacy-record-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "legacy.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(filePath, 1, "alpha is unsafe");
			recordBlockers(runtime, filePath, [diagnostic], { structured: false });
			markFalsePositive(cwd, diagnostic);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(turnEndText(cacheManager, cwd, runtime)).toContain(
				"alpha is unsafe",
			);
			const group = getDegradationSummary().find(
				(g) => g.kind === "inline-blocker-unstructured",
			);
			expect(group?.count).toBe(1);
			expect(group?.latestReasons[0]?.subject).toBe("inline-blocker:legacy.ts");
			expect(inlinePolicyRows()[0]?.metadata).toMatchObject({
				candidates: 0,
				unstructured: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("records no degradation for a legacy record while the project holds no marks", async () => {
		// The row names a producer that failed to pair summary and diagnostics.
		// With an empty store there is nothing the record failed to honor, so a
		// row here would be noise on every session that ever recorded one.
		const env = setupTestEnvironment("pi-lens-3246-legacy-no-marks-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "legacy.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			recordBlockers(
				runtime,
				filePath,
				[blockingDiagnostic(filePath, 1, "alpha is unsafe")],
				{ structured: false },
			);

			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(turnEndText(cacheManager, cwd, runtime)).toContain(
				"alpha is unsafe",
			);
			expect(
				getDegradationSummary().some(
					(g) => g.kind === "inline-blocker-unstructured",
				),
			).toBe(false);
		} finally {
			env.cleanup();
		}
	});

	it("writes no policy record at all on a turn that carries no inline blockers", async () => {
		// One row per turn that HAS candidates — not an all-zero row on every
		// turn end of every session.
		const env = setupTestEnvironment("pi-lens-3246-no-records-");
		try {
			const cwd = env.tmpDir;
			const filePath = path.join(cwd, "clean.ts");
			fs.writeFileSync(filePath, "alpha();\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			registerEdit(cacheManager, cwd, filePath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			expect(inlinePolicyRows()).toHaveLength(0);
		} finally {
			env.cleanup();
		}
	});

	it("bounds the identity lists in the per-turn record while keeping the counts exact", async () => {
		// AGENTS.md shape 17: the counts are always exact; only the file/tool
		// LISTS are capped, so a turn that touched many files writes a bounded
		// row rather than a file listing.
		const env = setupTestEnvironment("pi-lens-3246-identity-cap-");
		try {
			const cwd = env.tmpDir;
			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			for (let i = 0; i < 12; i++) {
				const filePath = path.join(cwd, `f${i}.ts`);
				fs.writeFileSync(filePath, "alpha();\nbeta();\n");
				const diagnostics = [
					blockingDiagnostic(filePath, 1, `marked ${i}`, { tool: `tool${i}` }),
					blockingDiagnostic(filePath, 2, `kept ${i}`, { tool: `tool${i}` }),
				];
				recordBlockers(runtime, filePath, diagnostics);
				markFalsePositive(cwd, diagnostics[0]);
				registerEdit(cacheManager, cwd, filePath);
			}

			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const metadata = inlinePolicyRows()[0]?.metadata as {
				records: number;
				candidates: number;
				kept: number;
				dispositionSuppressed: number;
				files: string[];
				tools: string[];
			};
			expect(metadata.records).toBe(12);
			expect(metadata.candidates).toBe(24);
			expect(metadata.kept).toBe(12);
			expect(metadata.dispositionSuppressed).toBe(12);
			expect(metadata.files).toHaveLength(10);
			expect(metadata.tools).toHaveLength(10);
		} finally {
			env.cleanup();
		}
	});

	it("anchors a cross-file blocker against its OWN file, not the record's", async () => {
		// `dispatchResult.blockers` is pooled across every runner dispatched for
		// the edited file, and a chart-wide runner (helm-lint, helm-render)
		// reports blocking diagnostics against sibling files — the cross-file
		// population `pipeline.ts` already filters out of `inlineBlockerLines`.
		const env = setupTestEnvironment("pi-lens-3246-cross-file-");
		try {
			const cwd = env.tmpDir;
			const chartPath = path.join(cwd, "Chart.yaml");
			const valuesPath = path.join(cwd, "values.yaml");
			fs.writeFileSync(chartPath, "name: demo\n");
			fs.writeFileSync(valuesPath, "image: latest\n");

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			const own = blockingDiagnostic(chartPath, 1, "chart name is reserved", {
				tool: "helm-lint",
			});
			const sibling = blockingDiagnostic(valuesPath, 1, "image tag is latest", {
				tool: "helm-lint",
			});
			recordBlockers(runtime, chartPath, [own, sibling]);
			// Marked against values.yaml's own path and bytes — the only way the
			// strict anchor can match is if the policy groups it under that file.
			markFalsePositive(cwd, sibling);

			registerEdit(cacheManager, cwd, chartPath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).toContain("chart name is reserved");
			expect(text).not.toContain("image tag is latest");
		} finally {
			env.cleanup();
		}
	});

	it("lets the inline record and a cached scanner lane each apply their policy once", async () => {
		// Mixed population: one inline blocker plus one cached gitleaks finding,
		// both marked. Each lane suppresses its own finding, and the inline
		// lane's bounded record counts only what it filtered.
		const env = setupTestEnvironment("pi-lens-3246-mixed-lanes-");
		try {
			const cwd = env.tmpDir;
			const inlinePath = path.join(cwd, "inline.ts");
			const secretPath = path.join(cwd, "config.ts");
			fs.writeFileSync(inlinePath, "eval(input);\n");
			const secretContent = "const clientId = 'not-a-real-secret';\n";
			fs.writeFileSync(secretPath, secretContent);

			const runtime = new RuntimeCoordinator();
			runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
			const cacheManager = new CacheManager(false);
			const diagnostic = blockingDiagnostic(inlinePath, 1, "eval() is banned");
			recordBlockers(runtime, inlinePath, [diagnostic]);
			markFalsePositive(cwd, diagnostic);

			cacheManager.writeCache(
				"gitleaks",
				{
					success: true,
					findings: [
						{ ruleId: "generic-api-key", file: secretPath, startLine: 1 },
					],
					scannedAt: new Date().toISOString(),
				},
				cwd,
			);
			// The identity `gitleaksFindingToProjectDiagnostic` derives — the
			// spelling an agent gets from `lens_diagnostics` for that lane.
			markDisposition(
				cwd,
				{
					cwd,
					filePath: secretPath,
					tool: "gitleaks",
					rule: "gitleaks:generic-api-key",
					message: "Potential secret: generic-api-key",
					line: 1,
					content: secretContent,
				},
				"false-positive",
			);

			registerEdit(cacheManager, cwd, inlinePath);
			registerEdit(cacheManager, cwd, secretPath);
			await handleTurnEnd(makeTurnEndDeps(runtime, cacheManager, cwd));

			const text = turnEndText(cacheManager, cwd, runtime);
			expect(text).not.toContain("eval() is banned");
			expect(text).not.toContain("hardcoded secrets detected");
			const rows = inlinePolicyRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.metadata).toMatchObject({
				records: 1,
				candidates: 1,
				kept: 0,
				dispositionSuppressed: 1,
			});
		} finally {
			env.cleanup();
		}
	});

	it("produces the same result whether the shared engine is called with the pi or the MCP host argument", async () => {
		// SCOPE, corrected in review round 2 (R3247-1): this is the shared ENGINE
		// seam, not an adapter test. It calls `handleTurnEnd` directly with each
		// host's own `host`/`owner` arguments and the owner id each registers turn
		// state under, and proves the engine's answer does not depend on them.
		// The ADAPTERS themselves — `index.ts`'s `turn_end`/`context` hook chain
		// and `clients/mcp/session.ts`'s `runTurnEnd` — are driven end to end by
		// `tests/index-3246-turn-end-delivery.test.ts` and
		// `tests/clients/mcp/session-inline-blocker-dispositions.test.ts`; round 1
		// claimed adapter coverage from this case alone, which it never had.
		// Separate project roots, because the durable disposition store and the
		// turn-end signature memo are both per-cwd.
		async function run(host: "pi" | "mcp"): Promise<string> {
			const env = setupTestEnvironment(`pi-lens-3246-${host}-delivery-`);
			try {
				const cwd = env.tmpDir;
				const filePath = path.join(cwd, "shared.ts");
				fs.writeFileSync(filePath, "alpha();\nbeta();\n");

				const runtime = new RuntimeCoordinator();
				runtime.setTelemetryIdentity({ sessionId: SESSION_ID });
				const cacheManager = new CacheManager(false);
				const diagnostics = [
					blockingDiagnostic(filePath, 1, "alpha is unsafe"),
					blockingDiagnostic(filePath, 2, "beta is unsafe"),
				];
				recordBlockers(runtime, filePath, diagnostics);
				markFalsePositive(cwd, diagnostics[0]);

				const mcpOwnerId = `mcp-${process.pid}`;
				registerEdit(
					cacheManager,
					cwd,
					filePath,
					host === "mcp" ? mcpOwnerId : SESSION_ID,
					host === "mcp" ? "mcp" : undefined,
				);
				await handleTurnEnd(
					makeTurnEndDeps(
						runtime,
						cacheManager,
						cwd,
						host === "mcp"
							? {
									host: "mcp",
									owner: {
										kind: "mcp",
										id: mcpOwnerId,
										pid: process.pid,
										lastSeen: new Date().toISOString(),
									},
								}
							: {},
					),
				);
				return turnEndText(cacheManager, cwd, runtime).replaceAll(cwd, "<cwd>");
			} finally {
				env.cleanup();
			}
		}

		const viaPi = await run("pi");
		const viaMcp = await run("mcp");
		expect(viaPi).toContain("L2: beta is unsafe");
		expect(viaPi).not.toContain("alpha is unsafe");
		expect(viaMcp).toBe(viaPi);
	});
});
